/**
 * salty_start — Proxy Worker
 * Deploy at: https://workers.cloudflare.com
 *
 * Routes:
 *   POST /pollen  — Fetch & normalize pollen data from supported providers
 *   POST /rss     — Fetch & normalize any RSS/Atom feed (returns raw XML)
 *   POST /nvd     — Proxy NVD CVE API (adds apiKey header server-side)
 *   POST /sports  — Fetch & normalize sports scores from TheSportsDB
 *
 * All routes add CORS headers so browser-side fetch() calls work.
 * Results are cached to minimise upstream API hits.
 *
 * ── POLLEN (/pollen) ─────────────────────────────────────────
 * Body: { service, apiKey, lat, lon }
 * Returns: { tree, grass, weed }
 * Cache: 4 hours
 *
 * ── RSS (/rss) ───────────────────────────────────────────────
 * Body: { url, label? }
 * Returns raw XML with CORS headers
 * Cache: 30 minutes
 *
 * ── NVD (/nvd) ───────────────────────────────────────────────
 * Body: { endpoint, apiKey? }
 * Proxies NVD REST API (browsers can't send apiKey header directly)
 * Cache: 10 minutes
 *
 * ── SPORTS (/sports) ─────────────────────────────────────────
 * Body: { league, view, team?, apiKey? }
 * view: "upcoming" | "final" | "today" | "live"
 * Returns: { league, sport, view, generatedAt, games: [...] }
 * Cache: 60s (live) | 5min (today) | 10min (final/upcoming)
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

// ── Sports config ────────────────────────────────────────────────────────────

// TheSportsDB league IDs
const SPORTS_LEAGUES = {
  nfl:        { id: '4391', name: 'NFL',              sport: 'American Football' },
  nba:        { id: '4387', name: 'NBA',              sport: 'Basketball'        },
  mlb:        { id: '4424', name: 'MLB',              sport: 'Baseball'          },
  nhl:        { id: '4380', name: 'NHL',              sport: 'Ice Hockey'        },
  epl:        { id: '4328', name: 'Premier League',   sport: 'Soccer'            },
  mls:        { id: '4346', name: 'MLS',              sport: 'Soccer'            },
  laliga:     { id: '4335', name: 'La Liga',          sport: 'Soccer'            },
  seriea:     { id: '4332', name: 'Serie A',          sport: 'Soccer'            },
  bundesliga: { id: '4331', name: 'Bundesliga',       sport: 'Soccer'            },
  ligue1:     { id: '4334', name: 'Ligue 1',          sport: 'Soccer'            },
  ucl:        { id: '4480', name: 'Champions League', sport: 'Soccer'            },
};

const TSDB_BASE = 'https://www.thesportsdb.com/api/v1/json';

// Cache TTLs per view
const SPORTS_TTL = {
  live:     60,       // 1 minute
  today:    5  * 60,  // 5 minutes
  final:    10 * 60,  // 10 minutes
  upcoming: 10 * 60,  // 10 minutes
};

function normalizeSportsEvent(ev) {
  // Safely parse score — handles undefined, null, empty string, and non-numeric
  const parseScore = v => {
    if(v === undefined || v === null || v === '') return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  };
  const homeScore = parseScore(ev.intHomeScore);
  const awayScore = parseScore(ev.intAwayScore);

  let status = 'Scheduled';
  if(ev.strStatus) {
    const s = ev.strStatus.toLowerCase();
    if(['match finished','ft','aet','pen','final','post'].includes(s))
      status = 'Final';
    else if(['in progress','live','1h','2h','ht','et','p1','p2','p3','p4','ot'].includes(s))
      status = 'In Progress';
    else if(s === 'postponed')  status = 'Postponed';
    else if(s === 'cancelled' || s === 'canceled') status = 'Cancelled';
    else if(homeScore !== null && awayScore !== null) status = 'Final';
  } else if(homeScore !== null && awayScore !== null) {
    status = 'Final';
  }

  return {
    id:        ev.idEvent      || '',
    homeTeam:  ev.strHomeTeam  || 'Home',
    awayTeam:  ev.strAwayTeam  || 'Away',
    homeScore: homeScore,
    awayScore: awayScore,
    status:    status,
    startTime: ev.strTimestamp || (ev.dateEvent ? ev.dateEvent + (ev.strTime ? 'T' + ev.strTime : '') : null),
    venue:     ev.strVenue     || null,
    homeBadge: ev.strHomeTeamBadge || null,
    awayBadge: ev.strAwayTeamBadge || null,
    round:     ev.intRound     || null,
    season:    ev.strSeason    || null,
    nextMatchFallback: ev._nextMatchFallback || false,
  };
}

async function handleSports(body, ctx) {
  const { league: leagueKey, view = 'today', team, apiKey, localDate } = body;

  if(!leagueKey)
    return json({ error: 'Required field: league. Valid: ' + Object.keys(SPORTS_LEAGUES).join(', ') }, 400);

  const leagueCfg = SPORTS_LEAGUES[leagueKey.toLowerCase()];
  if(!leagueCfg)
    return json({ error: `Unknown league: ${leagueKey}. Valid: ${Object.keys(SPORTS_LEAGUES).join(', ')}` }, 400);

  const validViews  = ['live','today','final','upcoming'];
  const resolvedView = validViews.includes(view) ? view : 'today';
  const key          = (apiKey || '').trim() || '123';
  const ttl          = SPORTS_TTL[resolvedView] || 300;

  const teamSlug  = team ? '_' + encodeURIComponent(team.toLowerCase()) : '';
  const dateSlug  = (resolvedView === 'today' && localDate) ? '_' + localDate : '';
  const cacheKey  = `https://sports-cache.internal/${leagueKey}/${resolvedView}${teamSlug}${dateSlug}/${key === '123' ? 'free' : 'paid'}`;
  const cache    = caches.default;
  const cached   = await cache.match(cacheKey);
  if(cached) return json({ ...(await cached.json()), _cached: true });

  let events = [];

  try {
    if(resolvedView === 'live') {
      // Live scores — requires paid key; free key (123) returns empty gracefully
      const r = await fetch(`${TSDB_BASE}/${key}/livescore.php?l=${leagueCfg.id}`, {
        headers: { 'Accept': 'application/json' },
      });
      const j  = await r.json();
      events   = j.events || j.livescores || [];

    } else if(resolvedView === 'upcoming') {
      const r = await fetch(`${TSDB_BASE}/${key}/eventsnextleague.php?id=${leagueCfg.id}`, {
        headers: { 'Accept': 'application/json' },
      });
      const j  = await r.json();
      events   = j.events || [];

    } else if(resolvedView === 'final') {
      const r = await fetch(`${TSDB_BASE}/${key}/eventspastleague.php?id=${leagueCfg.id}`, {
        headers: { 'Accept': 'application/json' },
      });
      const j  = await r.json();
      events   = j.events || [];

    } else {
      // today — merge past + upcoming, filter to today's date
      const [pastR, nextR] = await Promise.all([
        fetch(`${TSDB_BASE}/${key}/eventspastleague.php?id=${leagueCfg.id}`, { headers: { 'Accept': 'application/json' } }),
        fetch(`${TSDB_BASE}/${key}/eventsnextleague.php?id=${leagueCfg.id}`, { headers: { 'Accept': 'application/json' } }),
      ]);
      const [pastJ, nextJ] = await Promise.all([pastR.json(), nextR.json()]);
      const all   = [...(pastJ.events || []), ...(nextJ.events || [])];
      // Use browser-provided local date if available; fall back to UTC
      const today = (localDate && /^\d{4}-\d{2}-\d{2}$/.test(localDate))
        ? localDate
        : new Date().toISOString().slice(0, 10);
      const todayEvents = all.filter(ev => (ev.dateEvent || '').slice(0, 10) === today);
      if(todayEvents.length){
        events = todayEvents;
      } else {
        // Nothing today — find the single next upcoming game
        const upcoming = all
          .filter(ev => (ev.dateEvent || '') > today)
          .sort((a,b) => (a.dateEvent||'').localeCompare(b.dateEvent||''));
        events = upcoming.length ? [{ ...upcoming[0], _nextMatchFallback: true }] : [];
      }
    }
  } catch(e) {
    return json({ error: `Sports data fetch failed: ${e.message}` }, 502);
  }

  let games = events.map(normalizeSportsEvent);

  // Optional team filter — only applied if it returns results
  if(team && team.trim()) {
    const t = team.toLowerCase();
    const filtered = games.filter(g =>
      g.homeTeam.toLowerCase().includes(t) || g.awayTeam.toLowerCase().includes(t)
    );
    if(filtered.length) games = filtered;
  }

  const result = {
    league:      leagueCfg.name,
    leagueKey:   leagueKey.toLowerCase(),
    sport:       leagueCfg.sport,
    view:        resolvedView,
    generatedAt: new Date().toISOString(),
    games,
  };

  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ttl}`,
    },
  })));

  return json(result);
}

// ── Route handlers ───────────────────────────────────────────────────────────

const POLLEN_CACHE_TTL = 4 * 60 * 60;  // 4 hours
const RSS_CACHE_TTL    = 30 * 60;       // 30 minutes
const NVD_CACHE_TTL    = 10 * 60;       // 10 minutes

async function handlePollen(body, ctx) {
  const { service, apiKey, lat, lon } = body;

  if(!service || !apiKey || lat == null || lon == null)
    return json({ error: 'Required fields: service, apiKey, lat, lon' }, 400);

  const svc = POLLEN_SERVICES[service];
  if(!svc)
    return json({ error: `Unknown service: ${service}. Valid: ${Object.keys(POLLEN_SERVICES).join(', ')}` }, 400);

  const keyHash  = [...apiKey].reduce((h,c) => (Math.imul(31,h) + c.charCodeAt(0)) | 0, 0);
  const cacheKey = `https://pollen-cache.internal/${service}/${lat.toFixed(2)},${lon.toFixed(2)}/${keyHash}`;
  const cache    = caches.default;
  const cached   = await cache.match(cacheKey);
  if(cached) return json({ ...(await cached.json()), _cached: true });

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

  const cacheKey = `https://rss-cache.internal/${encodeURIComponent(url)}`;
  const cache    = caches.default;
  const cached   = await cache.match(cacheKey);
  if(cached){
    return new Response(await cached.text(), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/xml; charset=utf-8' },
    });
  }

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

  ctx.waitUntil(cache.put(cacheKey, new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${RSS_CACHE_TTL}`,
    },
  })));

  return new Response(xml, {
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/xml; charset=utf-8' },
  });
}

async function handleNvd(body, ctx) {
  const { endpoint, apiKey } = body;

  if(!endpoint || !endpoint.startsWith('https://services.nvd.nist.gov/'))
    return json({ error: 'Required field: endpoint (must be NVD API URL)' }, 400);

  const cacheKey = `https://nvd-cache.internal/${encodeURIComponent(endpoint)}`;
  const cache    = caches.default;
  const cached   = await cache.match(cacheKey);
  if(cached) return json({ ...(await cached.json()), _cached: true });

  const headers = { 'Accept': 'application/json' };
  if(apiKey) headers['apiKey'] = apiKey;

  let upstream;
  try {
    upstream = await fetch(endpoint, { headers });
  } catch(e) { return json({ error: `NVD fetch failed: ${e.message}` }, 502); }

  let data;
  try { data = await upstream.json(); }
  catch(e) { return json({ error: 'NVD returned non-JSON' }, 502); }

  if(!upstream.ok) {
    const msg = data?.message || `HTTP ${upstream.status}`;
    return json({ error: `NVD API error: ${msg}` }, upstream.status);
  }

  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${NVD_CACHE_TTL}`,
    },
  })));

  return json(data);
}

async function handleOtx(body, ctx) {
  const { apiKey, limit = 20 } = body;

  if(!apiKey)
    return json({ error: 'Required field: apiKey' }, 400);

  const safeLimit = Math.min(Math.max(parseInt(limit)||20, 1), 50);
  const cacheKey  = `https://otx-cache.internal/${
    [...apiKey].reduce((h,c)=>(Math.imul(31,h)+c.charCodeAt(0))|0,0)
  }/${safeLimit}`;
  const cache   = caches.default;
  const cached  = await cache.match(cacheKey);
  if(cached) return json({ ...(await cached.json()), _cached: true });

  let upstream;
  try {
    upstream = await fetch(
      `https://otx.alienvault.com/api/v1/pulses/subscribed?limit=${safeLimit}`,
      { headers: { 'X-OTX-API-KEY': apiKey, 'Accept': 'application/json' } }
    );
  } catch(e) { return json({ error: `OTX fetch failed: ${e.message}` }, 502); }

  let data;
  try { data = await upstream.json(); }
  catch(e) { return json({ error: 'OTX returned non-JSON' }, 502); }

  if(!upstream.ok) {
    const msg = data?.detail || data?.error || `HTTP ${upstream.status}`;
    return json({ error: `OTX API error: ${msg}` }, upstream.status);
  }

  // Normalize to stable schema — only fields confirmed in sample data
  const normalized = {
    totalCount: data.count || 0,
    pulses: (data.results || []).map(p => ({
      id:                p.id             || '',
      name:              p.name           || '',
      description:       p.description    || '',
      adversary:         p.adversary      || '',
      author:            p.author_name    || '',
      created:           p.created        || null,
      modified:          p.modified       || null,
      tlp:               p.tlp            || 'white',
      tags:              p.tags           || [],
      targeted_countries: p.targeted_countries || [],
      malware_families:  p.malware_families   || [],
      industries:        p.industries     || [],
      attack_ids:        p.attack_ids     || [],
      references:        p.references     || [],
      indicatorCount:    (p.indicators||[]).length,
      // Include indicators so client can do IOC type breakdown
      indicators:        (p.indicators||[]).map(i=>({ type: i.type, indicator: i.indicator })),
    })),
  };

  const OTX_CACHE_TTL = 15 * 60; // 15 minutes
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(normalized), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${OTX_CACHE_TTL}`,
    },
  })));

  return json(normalized);
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
    if(path === '/nvd')    return handleNvd(body, ctx);
    if(path === '/sports') return handleSports(body, ctx);
    if(path === '/otx')    return handleOtx(body, ctx);

    // Legacy: detect from body fields (backwards compat)
    if(body.service) return handlePollen(body, ctx);
    if(body.url)     return handleRss(body, ctx);

    return json({ error: 'Unknown route. Use POST /pollen, /rss, /nvd, or /sports' }, 404);
  }
};