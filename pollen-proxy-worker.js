/**
 * salty_start — Proxy Worker
 * Deploy at: https://workers.cloudflare.com
 *
 * Routes:
 *   POST /pollen  — Fetch & normalize pollen data from supported providers
 *   POST /rss     — Fetch & normalize any RSS/Atom feed
 *
 * All routes add CORS headers so browser-side fetch() calls work.
 * Results are cached to minimise upstream API hits.
 *
 * ── POLLEN (/pollen) ─────────────────────────────────────────
 * Body: { service, apiKey, lat, lon }
 * Returns: { tree, grass, weed }  (labels: None/Very Low/Low/Moderate/High/Very High)
 * Cache: 4 hours
 *
 * ── RSS (/rss) ───────────────────────────────────────────────
 * Body: { url, label? }
 * Returns: { feedTitle, items: [{ title, link, date, summary, source }] }
 * Cache: 30 minutes
 */

// ── Shared helpers ───────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age':       '86400',
};

const json = (data, status=200) => new Response(JSON.stringify(data), {
  status,
  headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
});

// ── Pollen normalizers ───────────────────────────────────────────────────────

function normalizeWeatherAPI(data) {
  const day = data?.forecast?.forecastday?.[0]?.day;
  if(!day) throw new Error(data?.error?.message || 'WeatherAPI: no forecast data');
  return {
    tree:  day.pollen_tree  || 'None',
    grass: day.pollen_grass || 'None',
    weed:  day.pollen_weed  || 'None',
  };
}

function normalizeTomorrow(data) {
  const v = data?.data?.values;
  if(!v) throw new Error(data?.message || 'Tomorrow.io: no values in response');
  const idx2txt = i => {
    const labels = ['None','Very Low','Low','Moderate','High','Very High'];
    return labels[Math.min(Math.max(Math.round(i ?? 0), 0), 5)];
  };
  return {
    tree:  idx2txt(v.treeIndex),
    grass: idx2txt(v.grassIndex),
    weed:  idx2txt(v.weedIndex),
  };
}

function normalizeAmbee(data) {
  const risk = data?.data?.[0]?.Risk;
  if(!risk) throw new Error(data?.message || 'Ambee: no risk data in response');
  return {
    tree:  risk.tree_pollen  || 'None',
    grass: risk.grass_pollen || 'None',
    weed:  risk.weed_pollen  || 'None',
  };
}

function normalizeGoogle(data) {
  const types = data?.dailyInfo?.[0]?.pollenTypeInfo;
  if(!types) throw new Error(data?.error?.message || 'Google: no pollenTypeInfo in response');
  const norm = c => c === 'Medium' ? 'Moderate' : (c || 'None');
  const result = { tree: 'None', grass: 'None', weed: 'None' };
  types.forEach(t => {
    const label = norm(t.indexInfo?.category);
    if(t.code === 'GRASS') result.grass = label;
    if(t.code === 'TREE')  result.tree  = label;
    if(t.code === 'WEED')  result.weed  = label;
  });
  return result;
}

const POLLEN_SERVICES = {
  weatherapi: {
    buildUrl:     ({ apiKey, lat, lon }) =>
      `https://api.weatherapi.com/v1/forecast.json?key=${apiKey}&q=${lat},${lon}&days=1&aqi=no&alerts=no`,
    buildHeaders: () => ({ 'Accept': 'application/json' }),
    normalize:    normalizeWeatherAPI,
  },
  tomorrow: {
    buildUrl:     ({ apiKey, lat, lon }) =>
      `https://api.tomorrow.io/v4/weather/realtime?location=${lat},${lon}&fields=treeIndex,grassIndex,weedIndex&apikey=${apiKey}`,
    buildHeaders: () => ({ 'Accept': 'application/json' }),
    normalize:    normalizeTomorrow,
  },
  ambee: {
    buildUrl:     ({ lat, lon }) =>
      `https://api.ambeedata.com/latest/pollen/by-lat-lng?lat=${lat}&lng=${lon}`,
    buildHeaders: ({ apiKey }) => ({ 'x-api-key': apiKey, 'Accept': 'application/json' }),
    normalize:    normalizeAmbee,
  },
  google: {
    buildUrl:     ({ apiKey, lat, lon }) =>
      `https://pollen.googleapis.com/v1/forecast:lookup?key=${apiKey}&location.longitude=${lon}&location.latitude=${lat}&days=1`,
    buildHeaders: () => ({ 'Accept': 'application/json' }),
    normalize:    normalizeGoogle,
  },
};

// ── RSS normalizer ───────────────────────────────────────────────────────────

// ── NVD handler ──────────────────────────────────────────────────────────────
// Proxies NVD API requests server-side so the apiKey header can be sent
// without triggering CORS preflight failures in the browser.
// Body: { endpoint, apiKey? }
// endpoint = full NVD URL e.g. https://services.nvd.nist.gov/rest/json/cves/2.0?...

async function handleNvd(body) {
  const { endpoint, apiKey } = body;

  if(!endpoint || !endpoint.startsWith('https://services.nvd.nist.gov/'))
    return json({ error: 'Invalid or missing endpoint' }, 400);

  const headers = { 'Accept': 'application/json' };
  if(apiKey) headers['apiKey'] = apiKey;

  let upstream;
  try {
    upstream = await fetch(endpoint, { method: 'GET', headers });
  } catch(e) { return json({ error: `NVD fetch failed: ${e.message}` }, 502); }

  let data;
  try { data = await upstream.json(); }
  catch(e) { return json({ error: `NVD returned non-JSON (status ${upstream.status})` }, 502); }

  if(!upstream.ok){
    const msg = data?.message || `HTTP ${upstream.status}`;
    return json({ error: `NVD error: ${msg}` }, upstream.status);
  }

  return json(data);
}

const POLLEN_CACHE_TTL = 4 * 60 * 60;  // 4 hours
const RSS_CACHE_TTL    = 30 * 60;       // 30 minutes

async function handlePollen(body, ctx) {
  const { service, apiKey, lat, lon } = body;

  if(!service || !apiKey || lat == null || lon == null)
    return json({ error: 'Required fields: service, apiKey, lat, lon' }, 400);

  const svc = POLLEN_SERVICES[service];
  if(!svc)
    return json({ error: `Unknown service: ${service}. Valid: ${Object.keys(POLLEN_SERVICES).join(', ')}` }, 400);

  // Cache check
  const keyHash  = [...apiKey].reduce((h,c) => (Math.imul(31,h) + c.charCodeAt(0)) | 0, 0);
  const cacheKey = `https://pollen-cache.internal/${service}/${lat.toFixed(2)},${lon.toFixed(2)}/${keyHash}`;
  const cache    = caches.default;
  const cached   = await cache.match(cacheKey);
  if(cached) return json({ ...(await cached.json()), _cached: true });

  // Upstream fetch
  let upstream;
  try {
    upstream = await fetch(svc.buildUrl({ apiKey, lat, lon }), {
      method: 'GET', headers: svc.buildHeaders({ apiKey }),
    });
  } catch(e) { return json({ error: `Upstream fetch failed: ${e.message}` }, 502); }

  let data;
  try { data = await upstream.json(); }
  catch(e) { return json({ error: 'Upstream returned non-JSON' }, 502); }

  if(!upstream.ok) {
    const msg = data?.error?.message || data?.message || data?.code || `HTTP ${upstream.status}`;
    return json({ error: `${service} API error: ${msg}` }, upstream.status);
  }

  let normalized;
  try { normalized = svc.normalize(data); }
  catch(e) { return json({ error: e.message }, 502); }

  // Cache normalized result
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(normalized), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${POLLEN_CACHE_TTL}`,
    },
  })));

  return json(normalized);
}

async function handleRss(body, ctx) {
  const { url } = body;

  if(!url || !url.startsWith('http'))
    return json({ error: 'Required field: url (must start with http)' }, 400);

  // Cache check — returns raw XML
  const cacheKey = `https://rss-cache.internal/${encodeURIComponent(url)}`;
  const cache    = caches.default;
  const cached   = await cache.match(cacheKey);
  if(cached){
    return new Response(await cached.text(), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/xml; charset=utf-8' },
    });
  }

  // Fetch feed server-side (no CORS restrictions here)
  let upstream;
  try {
    upstream = await fetch(url, {
      headers: {
        'Accept':     'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'User-Agent': 'Mozilla/5.0 (compatible; salty-start-dashboard/1.0; RSS reader)',
      },
    });
  } catch(e) { return json({ error: `Feed fetch failed: ${e.message}` }, 502); }

  if(!upstream.ok)
    return json({ error: `Feed returned HTTP ${upstream.status}` }, upstream.status);

  const xml = await upstream.text();

  // Cache raw XML
  ctx.waitUntil(cache.put(cacheKey, new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${RSS_CACHE_TTL}`,
    },
  })));

  // Return XML with CORS headers — browser parses it with DOMParser
  return new Response(xml, {
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/xml; charset=utf-8' },
  });
}

// ── Main dispatcher ──────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {

    if(request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS_HEADERS });

    if(request.method !== 'POST')
      return json({ error: 'Only POST requests are accepted' }, 405);

    let body;
    try { body = await request.json(); }
    catch(e) { return json({ error: 'Invalid JSON body' }, 400); }

    const path = new URL(request.url).pathname.replace(/\/+$/, '');

    if(path === '/pollen') return handlePollen(body, ctx);
    if(path === '/rss')    return handleRss(body, ctx);
    if(path === '/nvd')    return handleNvd(body);

    // Legacy: if no path, detect from body fields
    if(body.service)  return handlePollen(body, ctx);
    if(body.url)      return handleRss(body, ctx);
    if(body.endpoint) return handleNvd(body);

    return json({ error: 'Unknown route. Use POST /pollen or POST /rss' }, 404);
  }
};
