/**
 * salty_start — Proxy Worker
 * Deploy at: https://workers.cloudflare.com
 *
 * Routes:
 *   POST /pollen  — Fetch & normalize pollen data from supported providers
 *   POST /rss     — Fetch & normalize any RSS/Atom feed (returns raw XML)
 *   POST /nvd     — Proxy NVD CVE API (adds apiKey header server-side)
 *   POST /sports  — Fetch & normalize sports scores from TheSportsDB
 *   POST /bible   — Proxy API.Bible (adds api-key header server-side, aggressive caching)
 *   POST /topics  — Fetch & parse OpenBible.info topical verse search (no key required)
 *   POST /unsplash — Proxy Unsplash random photo API (adds Authorization header server-side)
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
 *
 * ── BIBLE (/bible) ───────────────────────────────────────────
 * Body: { apiKey, path, params? }
 *   path:   API.Bible relative path, e.g. "/v1/bibles" or
 *           "/v1/bibles/{bibleId}/chapters/{chapterId}"
 *   params: optional object of query-string key/value pairs
 *           e.g. { "content-type": "text", "include-verse-numbers": "true" }
 * Returns: raw API.Bible JSON response
 * Cache: 7 days (metadata) | 30 days (chapter/verse content — Bible text never changes)
 * Note: API.Bible requests fair-use attribution (FUMS). For personal non-commercial
 *       use this is informational; see https://docs.api.bible for details.
 *
 * ── TOPICS (/topics) ─────────────────────────────────────────
 *
 * ── WOTD (/wotd) ──────────────────────────────────────────────
 * Body: { apiKey }
 * Returns Wordnik word-of-the-day: { word, definitions, examples, note }
 * Cache: 6 hours (WOTD changes once per day)
 * Body: { topic }
 *   topic: free-text topic string e.g. "hope", "anxiety", "forgiveness"
 * Returns: { topic, url, verses: [{ reference, votes }] }
 *   Verses are sorted by vote count descending (community-ranked relevance).
 * Cache: 24 hours (topic rankings update infrequently)
 *
 * ── UNSPLASH (/unsplash) ──────────────────────────────────────
 * Body: { apiKey, query?, orientation? }
 *   query:       optional search term (e.g. "texture", "landscape") — omit for purely random
 *   orientation: optional "landscape" | "portrait" | "squarish" (default: "landscape")
 * Returns: { id, url, thumbUrl, fullUrl, description, altDescription,
 *            photographer, photographerProfile, color, width, height,
 *            downloadLocation, unsplashLink }
 * Cache: 1 hour, keyed by query+orientation+hour bucket (rotates each hour)
 */

// ── Shared helpers ───────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Token, X-Salty-Key',
  'Access-Control-Max-Age':       '86400',
};

const json = (data, status=200) => new Response(JSON.stringify(data), {
  status,
  headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
});

// Simple non-cryptographic hash for cache key generation (keeps keys out of URLs)
const hashStr = s => [...s].reduce((h,c) => (Math.imul(31,h) + c.charCodeAt(0)) | 0, 0);

// ── Access control ───────────────────────────────────────────────────────────
// Configure in Worker Settings → Variables and Secrets:
//   SALTY_KEYS    — comma-separated list of valid secret tokens (store as encrypted secret)
//   SALTY_ORIGINS — comma-separated list of allowed origins, e.g. https://you.github.io
// Either check is skipped gracefully if its env var is not set.
// Both checks must pass when both vars are configured.
function checkAccess(request, env) {
  // Origin / Referer check
  const allowedOrigins = (env.SALTY_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowedOrigins.length > 0) {
    const origin  = (request.headers.get('Origin')  || '').trim();
    const referer = (request.headers.get('Referer') || '').trim();
    const ok = allowedOrigins.some(o => origin === o || referer.startsWith(o));
    if (!ok) return json({ error: 'Forbidden' }, 403);
  }

  // Shared secret check
  const validKeys = (env.SALTY_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (validKeys.length > 0) {
    const key = (request.headers.get('X-Salty-Key') || '').trim();
    if (!validKeys.includes(key)) return json({ error: 'Forbidden' }, 403);
  }

  return null; // access granted
}

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

  const leagueId = leagueCfg.id;
  let events = [];

  if(resolvedView === 'live') {
    const r = await fetch(`${TSDB_BASE}/${key}/livescore.php?l=${leagueId}`);
    const d = await r.json();
    events = d?.events || [];

  } else if(resolvedView === 'today') {
    const dateStr = localDate || new Date().toISOString().split('T')[0];
    const r = await fetch(`${TSDB_BASE}/${key}/eventsday.php?d=${dateStr}&l=${leagueId}`);
    const d = await r.json();
    events = d?.events || [];

  } else if(resolvedView === 'final') {
    const r = await fetch(`${TSDB_BASE}/${key}/eventspastleague.php?id=${leagueId}`);
    const d = await r.json();
    events = d?.events || [];

  } else if(resolvedView === 'upcoming') {
    const r = await fetch(`${TSDB_BASE}/${key}/eventsnextleague.php?id=${leagueId}`);
    const d = await r.json();
    events = d?.events || [];
  }

  // Filter by team if specified
  if(team && events.length) {
    const t = team.toLowerCase();
    events = events.filter(e =>
      (e.strHomeTeam||'').toLowerCase().includes(t) ||
      (e.strAwayTeam||'').toLowerCase().includes(t)
    );

    // If upcoming and filtered team has no events, try next-event endpoint
    if(!events.length && resolvedView === 'upcoming') {
      const r2 = await fetch(`${TSDB_BASE}/${key}/searchevents.php?e=${encodeURIComponent(team)}&s=${new Date().getFullYear()}-${(new Date().getFullYear()+1)}`);
      const d2 = await r2.json();
      const fallback = (d2?.event || [])
        .filter(e =>
          (e.strHomeTeam||'').toLowerCase().includes(t) ||
          (e.strAwayTeam||'').toLowerCase().includes(t)
        )
        .map(e => ({ ...e, _nextMatchFallback: true }));
      events = fallback.slice(0, 5);
    }
  }

  const result = {
    league:      leagueCfg.name,
    sport:       leagueCfg.sport,
    view:        resolvedView,
    generatedAt: new Date().toISOString(),
    games:       events.map(normalizeSportsEvent),
  };

  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ttl}`,
    },
  })));

  return json(result);
}

// ── Cache TTLs ───────────────────────────────────────────────────────────────

const POLLEN_CACHE_TTL  = 4  * 60 * 60;  // 4 hours
const RSS_CACHE_TTL     = 30 * 60;        // 30 minutes
const NVD_CACHE_TTL     = 10 * 60;        // 10 minutes

// Bible — text is immutable so we cache very aggressively
const BIBLE_CONTENT_TTL = 30 * 24 * 60 * 60;  // 30 days  (chapter/verse content)
const BIBLE_META_TTL    =  7 * 24 * 60 * 60;  // 7 days   (translation/book lists)

// Topics — OpenBible rankings update infrequently
const TOPICS_CACHE_TTL  = 24 * 60 * 60;  // 24 hours

// API.Bible base URL (as provided by API.Bible account dashboard)
const BIBLE_BASE = 'https://rest.api.bible';

// ── Bible handler (/bible) ───────────────────────────────────────────────────
//
// Generic proxy for API.Bible. The widget sends the relative path and optional
// query params; the worker injects the api-key header and caches the result.
//
// Example body:
//   { apiKey: "abc123",
//     path:   "/v1/bibles",
//     params: {} }
//
//   { apiKey: "abc123",
//     path:   "/v1/bibles/65eec8e0b60e656b-01/chapters/JHN.3",
//     params: { "content-type": "text", "include-verse-numbers": "true",
//               "include-titles": "false", "include-chapter-numbers": "false" } }

async function handleBible(body, ctx) {
  const { apiKey, path, params = {} } = body;

  if(!apiKey)
    return json({ error: 'Required field: apiKey' }, 400);
  if(!path || !path.startsWith('/v1/'))
    return json({ error: 'Required field: path (must start with /v1/)' }, 400);

  // Validate path doesn't contain anything unexpected
  if(!/^\/v1\/[a-zA-Z0-9/_\-\.]+$/.test(path))
    return json({ error: 'Invalid path format' }, 400);

  // Build upstream URL with any query params the widget wants to pass
  const qs  = Object.keys(params).length
    ? '?' + new URLSearchParams(params).toString()
    : '';
  const url = `${BIBLE_BASE}${path}${qs}`;

  // Cache key: hash the API key (don't expose it) + path + params
  const keyHash  = hashStr(apiKey);
  const cacheKey = `https://bible-cache.internal/${keyHash}${path}${qs}`;
  const cache    = caches.default;
  const cached   = await cache.match(cacheKey);
  if(cached) return json({ ...(await cached.json()), _cached: true });

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'GET',
      headers: { 'api-key': apiKey, 'Accept': 'application/json' },
    });
  } catch(e) { return json({ error: `Bible API fetch failed: ${e.message}` }, 502); }

  let data;
  try { data = await upstream.json(); }
  catch(e) { return json({ error: 'Bible API returned non-JSON' }, 502); }

  if(!upstream.ok) {
    const msg = data?.message || data?.error || `HTTP ${upstream.status}`;
    return json({ error: `Bible API error: ${msg}` }, upstream.status);
  }

  // Use longer TTL for actual Scripture content, shorter for metadata lists
  const isContent = path.includes('/chapters/') || path.includes('/verses/') || path.includes('/passages/');
  const ttl = isContent ? BIBLE_CONTENT_TTL : BIBLE_META_TTL;

  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(data), {
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': `public, max-age=${ttl}`,
    },
  })));

  return json(data);
}

// ── Topics handler (/topics) ─────────────────────────────────────────────────
//
// Fetches OpenBible.info topical Bible search results server-side (bypasses
// CORS) and returns a clean JSON list of verse references with vote counts.
// No API key required — OpenBible.info is a free public resource.
//
// Example body:  { topic: "hope" }
// Returns:
//   { topic: "hope",
//     url: "https://www.openbible.info/topics/hope",
//     verses: [
//       { reference: "Romans 8:24-25", votes: 1423 },
//       { reference: "Hebrews 11:1",   votes: 1187 },
//       ...
//     ]
//   }
//
// Verses are sorted by vote count descending (highest community relevance first).
// Parsing strategy: primary regex targeting OpenBible's link+votes HTML structure;
// fallback to a broad Bible-reference regex if the layout changes.

// Full list of canonical book names for the fallback parser
const BIBLE_BOOKS = [
  'Genesis','Exodus','Leviticus','Numbers','Deuteronomy','Joshua','Judges','Ruth',
  '1 Samuel','2 Samuel','1 Kings','2 Kings','1 Chronicles','2 Chronicles',
  'Ezra','Nehemiah','Esther','Job','Psalms','Psalm','Proverbs','Ecclesiastes',
  'Song of Solomon','Song of Songs','Isaiah','Jeremiah','Lamentations','Ezekiel',
  'Daniel','Hosea','Joel','Amos','Obadiah','Jonah','Micah','Nahum','Habakkuk',
  'Zephaniah','Haggai','Zechariah','Malachi',
  'Matthew','Mark','Luke','John','Acts','Romans',
  '1 Corinthians','2 Corinthians','Galatians','Ephesians','Philippians','Colossians',
  '1 Thessalonians','2 Thessalonians','1 Timothy','2 Timothy','Titus','Philemon',
  'Hebrews','James','1 Peter','2 Peter','1 John','2 John','3 John','Jude','Revelation',
];

// Escape special regex chars in book names
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BOOK_PATTERN = BIBLE_BOOKS.map(escRe).join('|');
const BIBLE_REF_RE = new RegExp(`((?:${BOOK_PATTERN})\\s+\\d+:\\d+(?:-\\d+)?)`, 'g');

async function handleTopics(body, ctx) {
  const { topic } = body;

  if(!topic || typeof topic !== 'string' || !topic.trim())
    return json({ error: 'Required field: topic (non-empty string)' }, 400);

  // Normalise topic for URL: lowercase, spaces → underscores
  const slug     = topic.trim().toLowerCase().replace(/\s+/g, '_');
  const topicUrl = `https://www.openbible.info/topics/${encodeURIComponent(slug)}`;

  const cacheKey = `https://topics-cache.internal/${slug}`;
  const cache    = caches.default;
  const cached   = await cache.match(cacheKey);
  if(cached) return json({ ...(await cached.json()), _cached: true });

  let upstream;
  try {
    upstream = await fetch(topicUrl, {
      headers: {
        'Accept':     'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; salty-start-dashboard/1.0)',
      },
    });
  } catch(e) { return json({ error: `Topics fetch failed: ${e.message}` }, 502); }

  if(!upstream.ok)
    return json({ error: `OpenBible returned HTTP ${upstream.status}` }, upstream.status);

  const html = await upstream.text();

  // ── Primary parser ───────────────────────────────────────────────────────
  // OpenBible.info topic pages use this structure per verse:
  //
  //   <div class="verse">
  //     <h3>
  //       <a href="https://www.biblegateway.com/..." class="bibleref">Romans 15:13</a>
  //       <span class="note">
  //         ESV / 14,320 helpful votes
  //       </span>
  //     </h3>
  //     <p>verse text...</p>
  //   </div>
  //
  // Two-pass approach: extract refs and vote counts independently by position,
  // then zip together. More robust than a single combined regex across two elements.

  // Pass 1 — all references from class="bibleref" anchors
  const rawRefs = [];
  const refRe   = /<a[^>]+class="bibleref"[^>]*>([^<]+)<\/a>/g;
  let rm;
  while((rm = refRe.exec(html)) !== null) rawRefs.push(rm[1].trim());

  // Pass 2 — all vote counts from class="note" spans
  // Text inside span looks like: "ESV / 14,320 helpful votes"
  const rawVotes = [];
  const voteRe   = /<span class="note">[^/]*\/\s*([\d,]+)\s*helpful/g;
  let vm;
  while((vm = voteRe.exec(html)) !== null)
    rawVotes.push(parseInt(vm[1].replace(/,/g, ''), 10));

  // Zip by position — refs and note spans appear in matching order in the DOM
  const verses = [];
  const seen   = new Set();
  rawRefs.forEach((ref, i) => {
    if(ref.includes(':') && !seen.has(ref)) {
      seen.add(ref);
      verses.push({ reference: ref, votes: rawVotes[i] ?? 0 });
    }
  });

  // ── Fallback parser ──────────────────────────────────────────────────────
  // If the primary regex found nothing (layout change / blocked), extract any
  // canonical Bible reference patterns from the page text.
  if(verses.length === 0) {
    let fb;
    while((fb = BIBLE_REF_RE.exec(html)) !== null) {
      const ref = fb[1].trim();
      if(!seen.has(ref)) {
        seen.add(ref);
        verses.push({ reference: ref, votes: 0 });
      }
    }
  }

  // Sort by votes descending (fallback refs will all be 0 — order preserved)
  verses.sort((a, b) => b.votes - a.votes);

  const result = {
    topic:  topic.trim(),
    url:    topicUrl,
    verses,
  };

  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), {
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': `public, max-age=${TOPICS_CACHE_TTL}`,
    },
  })));

  return json(result);
}

// ── Pollen handler (/pollen) ─────────────────────────────────────────────────

async function handlePollen(body, ctx) {
  const { service, apiKey, lat, lon } = body;

  if(!service || !apiKey || lat == null || lon == null)
    return json({ error: 'Required fields: service, apiKey, lat, lon' }, 400);

  const svc = POLLEN_SERVICES[service.toLowerCase()];
  if(!svc)
    return json({ error: `Unknown service: ${service}. Valid: ${Object.keys(POLLEN_SERVICES).join(', ')}` }, 400);

  const keyHash  = hashStr(apiKey);
  const cacheKey = `https://pollen-cache.internal/${service}/${(+lat).toFixed(2)},${(+lon).toFixed(2)}/${keyHash}`;
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
      'Content-Type':  'application/json',
      'Cache-Control': `public, max-age=${POLLEN_CACHE_TTL}`,
    },
  })));

  return json(normalized);
}

// ── RSS handler (/rss) ───────────────────────────────────────────────────────

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
      'Content-Type':  'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${RSS_CACHE_TTL}`,
    },
  })));

  return new Response(xml, {
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/xml; charset=utf-8' },
  });
}

// ── NVD handler (/nvd) ───────────────────────────────────────────────────────

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
      'Content-Type':  'application/json',
      'Cache-Control': `public, max-age=${NVD_CACHE_TTL}`,
    },
  })));

  return json(data);
}

// ── OTX handler (/otx) ───────────────────────────────────────────────────────

async function handleOtx(body, ctx) {
  const { apiKey, limit = 20 } = body;

  if(!apiKey)
    return json({ error: 'Required field: apiKey' }, 400);

  const safeLimit = Math.min(Math.max(parseInt(limit)||20, 1), 50);
  const cacheKey  = `https://otx-cache.internal/${hashStr(apiKey)}/${safeLimit}`;
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

  const normalized = {
    totalCount: data.count || 0,
    pulses: (data.results || []).map(p => ({
      id:                 p.id             || '',
      name:               p.name           || '',
      description:        p.description    || '',
      adversary:          p.adversary      || '',
      author:             p.author_name    || '',
      created:            p.created        || null,
      modified:           p.modified       || null,
      tlp:                p.tlp            || 'white',
      tags:               p.tags           || [],
      targeted_countries: p.targeted_countries || [],
      malware_families:   p.malware_families   || [],
      industries:         p.industries     || [],
      attack_ids:         p.attack_ids     || [],
      references:         p.references     || [],
      indicatorCount:     (p.indicators||[]).length,
      indicators:         (p.indicators||[]).map(i=>({ type: i.type, indicator: i.indicator })),
    })),
  };

  const OTX_CACHE_TTL = 15 * 60; // 15 minutes
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(normalized), {
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': `public, max-age=${OTX_CACHE_TTL}`,
    },
  })));

  return json(normalized);
}


// ── Last.fm handler (/lastfm) ────────────────────────────────────────────────
//
// Proxies Last.fm API requests. Accepts { apiKey, username, method, ...params }
// Returns parsed JSON from ws.audioscrobbler.com/2.0/
// Cache TTL varies by method: recenttracks=30s, top*=1hr, user.getInfo=6hr

async function handleLastfm(body, ctx) {
  const { apiKey, username, method, period, limit = 10, artist } = body;
  if(!apiKey)   return json({ error: 'Required field: apiKey' }, 400);
  if(!username && method.toLowerCase() !== 'artist.getinfo') return json({ error: 'Required field: username' }, 400);
  if(!method)   return json({ error: 'Required field: method' }, 400);

  const ALLOWED_METHODS = [
    'user.getrecenttracks',
    'user.gettoptracks',
    'user.gettopartists',
    'user.gettopalbums',
    'user.getinfo',
    'user.getlovedtracks',
    'artist.getinfo',
  ];
  if(!ALLOWED_METHODS.includes(method.toLowerCase()))
    return json({ error: `Method not allowed: ${method}` }, 400);

  const safeLimit = Math.min(Math.max(parseInt(limit)||10, 1), 50);
  const cacheTTL = method.toLowerCase() === 'user.getrecenttracks' ? 30
                 : method.toLowerCase() === 'user.getinfo'          ? 6 * 60 * 60
                 : 60 * 60;

  const params = new URLSearchParams({
    method,
    ...(username ? { user: username } : {}),
    api_key: apiKey,
    format:  'json',
    limit:   safeLimit,
    ...(period ? { period } : {}),
    ...(artist ? { artist } : {}),
  });

  const url = `https://ws.audioscrobbler.com/2.0/?${params}`;
  const cacheKey = url.replace(apiKey, hashStr(apiKey)); // don't cache raw key
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if(cached) return json({ ...(await cached.json()), _cached: true });

  let upstream;
  try {
    upstream = await fetch(url, { headers: { 'User-Agent': 'SaltyDashboard/1.0' } });
  } catch(e) { return json({ error: `Last.fm fetch failed: ${e.message}` }, 502); }

  let data;
  try { data = await upstream.json(); }
  catch(e) { return json({ error: 'Last.fm returned non-JSON' }, 502); }

  if(data.error) return json({ error: `Last.fm API error ${data.error}: ${data.message}` }, 400);

  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${cacheTTL}`,
    },
  })));

  return json(data);
}

// ── WOTD handler (/wotd) ─────────────────────────────────────────────────────
//
// Proxies Wordnik's word-of-the-day endpoint, adding api-key server-side.
// Returns the raw Wordnik WOTD JSON: { word, definitions, examples, note, ... }
// Cache: 6 hours — WOTD changes once daily at midnight UTC.

const WOTD_CACHE_TTL = 6 * 60 * 60; // 6 hours

async function handleWotd(body, ctx) {
  const { apiKey } = body;
  if(!apiKey)
    return json({ error: 'Required field: apiKey' }, 400);

  const keyHash  = hashStr(apiKey);
  const today    = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const cacheKey = `https://wotd-cache.internal/${keyHash}/${today}`;
  const cache    = caches.default;
  const cached   = await cache.match(cacheKey);
  if(cached) return json({ ...(await cached.json()), _cached: true });

  const url = `https://api.wordnik.com/v4/words.json/wordOfTheDay?api_key=${apiKey}`;
  let upstream;
  try {
    upstream = await fetch(url, { headers: { 'Accept': 'application/json' } });
  } catch(e) { return json({ error: `Wordnik fetch failed: ${e.message}` }, 502); }

  let data;
  try { data = await upstream.json(); }
  catch(e) { return json({ error: 'Wordnik returned non-JSON' }, 502); }

  if(!upstream.ok) {
    const msg = data?.message || data?.error || `HTTP ${upstream.status}`;
    return json({ error: `Wordnik API error: ${msg}` }, upstream.status);
  }

  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(data), {
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': `public, max-age=${WOTD_CACHE_TTL}`,
    },
  })));

  return json(data);
}

// ── Unsplash handler (/unsplash) ─────────────────────────────────────────────
//
// Proxies the Unsplash random photo API, injecting the Authorization header
// server-side so the API key is never exposed to the browser.
//
// Cache strategy: 1-hour buckets keyed by query+orientation. All users with
// the same query see the same photo within a given hour — then a fresh one
// rolls in. Keeps usage well within free-tier limits for a shared dashboard.

const UNSPLASH_CACHE_TTL = 60 * 60; // 1 hour

async function handleUnsplash(body, ctx) {
  const { apiKey, query = '', orientation = 'landscape', mode = 'photo' } = body;

  if(!apiKey)
    return json({ error: 'Required field: apiKey' }, 400);

  const cache = caches.default;

  // ── Topics mode ──────────────────────────────────────────
  if(mode === 'topics') {
    const topicsCacheKey = `https://unsplash-topics-cache.internal/${hashStr(apiKey)}`;
    const cached = await cache.match(topicsCacheKey);
    if(cached) return json({ ...(await cached.json()), _cached: true });

    let upstream;
    try {
      upstream = await fetch('https://api.unsplash.com/topics?per_page=30&order_by=featured', {
        headers: { 'Authorization': `Client-ID ${apiKey}`, 'Accept-Version': 'v1' },
      });
    } catch(e) { return json({ error: `Unsplash topics fetch failed: ${e.message}` }, 502); }

    let data;
    try { data = await upstream.json(); }
    catch(e) { return json({ error: 'Unsplash returned non-JSON' }, 502); }

    if(!upstream.ok) {
      const msg = data?.errors?.[0] || data?.error || `HTTP ${upstream.status}`;
      return json({ error: `Unsplash API error: ${msg}` }, upstream.status);
    }

    const seen = new Set();
    const result = {
      topics: data
        .filter(t => t.slug && !seen.has(t.slug) && seen.add(t.slug))
        .map(t => ({ slug: t.slug, title: t.title })),
    };

    ctx.waitUntil(cache.put(topicsCacheKey, new Response(JSON.stringify(result), {
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': `public, max-age=86400`, // 24 hours
      },
    })));

    return json(result);
  }

  // ── Photo mode (default) ─────────────────────────────────
  const validOrientations = ['landscape', 'portrait', 'squarish'];
  const safeOrientation   = validOrientations.includes(orientation) ? orientation : 'landscape';

  // Hour bucket — cache rotates every hour
  const hourBucket = Math.floor(Date.now() / (1000 * 60 * 60));
  const cacheKey   = `https://unsplash-cache.internal/${hashStr(apiKey)}/${encodeURIComponent(query.trim())}/${safeOrientation}/${hourBucket}`;
  const cached     = await cache.match(cacheKey);
  if(cached) return json({ ...(await cached.json()), _cached: true });

  const params = new URLSearchParams({ orientation: safeOrientation });
  if(query.trim()) params.set('query', query.trim());

  const url = `https://api.unsplash.com/photos/random?${params.toString()}`;

  let upstream;
  try {
    upstream = await fetch(url, {
      headers: {
        'Authorization': `Client-ID ${apiKey}`,
        'Accept-Version': 'v1',
      },
    });
  } catch(e) { return json({ error: `Unsplash fetch failed: ${e.message}` }, 502); }

  let data;
  try { data = await upstream.json(); }
  catch(e) { return json({ error: 'Unsplash returned non-JSON' }, 502); }

  if(!upstream.ok) {
    const msg = data?.errors?.[0] || data?.error || `HTTP ${upstream.status}`;
    return json({ error: `Unsplash API error: ${msg}` }, upstream.status);
  }

  const normalized = {
    id:                 data.id                           || '',
    url:                data.urls?.regular               || data.urls?.full || '',
    thumbUrl:           data.urls?.thumb                 || '',
    fullUrl:            data.urls?.full                  || '',
    description:        data.description                 || data.alt_description || '',
    altDescription:     data.alt_description             || '',
    photographer:       data.user?.name                  || '',
    photographerProfile: data.user?.links?.html          || '',
    color:              data.color                       || '#888888',
    width:              data.width                       || 0,
    height:             data.height                      || 0,
    downloadLocation:   data.links?.download_location    || '',
    unsplashLink:       data.links?.html                 || '',
  };

  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(normalized), {
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': `public, max-age=${UNSPLASH_CACHE_TTL}`,
    },
  })));

  return json(normalized);
}

// ── Status handler (/status) ─────────────────────────────────────────────────
//
// Checks reachability of any URL server-side, returning the real HTTP status
// code. Tries HEAD first, falls back to GET.
//
// Semantics: `ok: true` means the server responded with ANY status code —
// the service is reachable. `ok: false` with `status: null` means we could
// not reach the server at all (DNS failure, timeout, connection refused).
// This lets the dashboard distinguish "up but auth required (401)" from
// "completely unreachable."
//
// Cloudflare's own 52x/53x error codes (returned when CF can't reach the
// origin) are treated as "unreachable" and result in status: null so that
// the dashboard cascade falls through to the next available path (local proxy
// or direct browser check).
//
// Body: { url }
// Returns: { ok: bool, status: int|null, via: "worker" }

async function handleStatus(body) {
  try {
    const { url } = body;

    if(!url || typeof url !== 'string')
      return json({ ok: false, status: null, via: 'worker', error: 'Required field: url' }, 400);

    let parsed;
    try {
      parsed = new URL(url);
      if(!['http:', 'https:'].includes(parsed.protocol))
        return json({ ok: false, status: null, via: 'worker', error: 'Only http/https URLs are supported' }, 400);
    } catch(e) {
      return json({ ok: false, status: null, via: 'worker', error: 'Invalid URL' }, 400);
    }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (compatible; salty-start-dashboard/1.0; status-checker)',
      'Accept': '*/*',
    };

    // Cloudflare uses 520-530 for "origin unreachable" — not real server responses.
    // Treat these as network failures so the dashboard cascade falls through.
    const isCfError = s => s >= 520 && s <= 530;

    // Try HEAD first — cheaper, avoids downloading body
    try {
      const res = await fetch(url, { method: 'HEAD', headers, redirect: 'follow' });
      if(isCfError(res.status))
        return json({ ok: false, status: null, via: 'worker', error: 'Origin unreachable from worker (CF ' + res.status + ')' });
      // Any real server response = reachable (ok: true), even 4xx/5xx
      return json({ ok: true, status: res.status, via: 'worker' });
    } catch(e) {
      // HEAD failed (DNS error, connection refused, TLS error, etc.) — try GET
    }

    try {
      const res = await fetch(url, { method: 'GET', headers, redirect: 'follow' });
      if(isCfError(res.status))
        return json({ ok: false, status: null, via: 'worker', error: 'Origin unreachable from worker (CF ' + res.status + ')' });
      return json({ ok: true, status: res.status, via: 'worker' });
    } catch(e) {
      return json({ ok: false, status: null, via: 'worker', error: e.message });
    }

  } catch(e) {
    // Outer catch: handles Cloudflare runtime-level throws that escape inner blocks
    return json({ ok: false, status: null, via: 'worker', error: 'Worker runtime error: ' + (e.message || 'unknown') });
  }
}

// ── TAP handler (/tap) ────────────────────────────────────────────────────────
//
// Proxies Proofpoint TAP API v2 endpoints. Credentials stay server-side.
// Body: { type: 'siem'|'clicks'|'vap', principal, secret, interval?, sinceSeconds?, vapWindow? }
//   siem/clicks support either:
//     interval: ISO8601 interval string e.g. "2024-01-01T00:00:00Z/2024-01-01T01:00:00Z"
//     sinceSeconds: integer (legacy, still supported)
//   vap requires vapWindow (days: 14, 30, or 90)
//   siem   → /v2/siem/all          (messagesBlocked + clicksBlocked + clicksPermitted)
//   clicks → /v2/siem/clicks/permitted (permitted malicious clicks only)
//   vap    → /v2/people/vap        (Very Attacked Persons list)
//
// Cache: 5 min (widget refreshes every 30 min, so short cache just collapses
//         any accidental double-loads without serving stale security data).

const TAP_CACHE_TTL_CURRENT  =  5 * 60; // 5 min  — for intervals touching now
const TAP_CACHE_TTL_HISTORIC =  2 * 60 * 60; // 2 hrs — for fully past intervals (immutable)

async function handleTap(body, ctx) {
  const {
    type,
    principal,
    secret,
    interval,          // ISO8601 interval string (preferred for catch-up calls)
    sinceSeconds = 3600, // fallback for simple 1-hour pulls
    vapWindow    = 14,
  } = body;

  if (!principal || !secret)
    return json({ error: 'Required fields: principal, secret' }, 400);
  if (!['siem', 'clicks', 'vap'].includes(type))
    return json({ error: 'Required field: type must be siem | clicks | vap' }, 400);

  // Build time query param — prefer interval over sinceSeconds
  const timeParam = interval
    ? `interval=${encodeURIComponent(interval)}`
    : `sinceSeconds=${encodeURIComponent(sinceSeconds)}`;

  // Basic auth: base64(principal:secret)
  const auth     = btoa(`${principal}:${secret}`);
  const keyHash  = hashStr(principal);

  let upstreamUrl;
  if (type === 'siem')
    upstreamUrl = `https://tap-api-v2.proofpoint.com/v2/siem/all?format=json&${timeParam}`;
  else if (type === 'clicks')
    upstreamUrl = `https://tap-api-v2.proofpoint.com/v2/siem/clicks/permitted?format=json&${timeParam}`;
  else
    upstreamUrl = `https://tap-api-v2.proofpoint.com/v2/people/vap?window=${encodeURIComponent(vapWindow)}`;

  // Cache key uses interval string or sinceSeconds value
  const timeKey  = interval ? encodeURIComponent(interval) : sinceSeconds;
  const cacheKey = `https://tap-cache.internal/${keyHash}/${type}/${type === 'vap' ? vapWindow : timeKey}`;
  const cache    = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return json({ ...(await cached.json()), _cached: true });

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept':        'application/json',
      },
    });
  } catch (e) {
    return json({ error: `TAP fetch failed: ${e.message}` }, 502);
  }

  let data;
  try { data = await upstream.json(); }
  catch (e) { return json({ error: 'TAP API returned non-JSON' }, 502); }

  if (!upstream.ok) {
    const msg = data?.message || data?.error || `HTTP ${upstream.status}`;
    return json({ error: `TAP API error: ${msg}`, status: upstream.status }, upstream.status);
  }

  // Historical intervals (end time > 5 min in the past) are immutable — cache longer.
  // Intervals touching the current hour get the short TTL so fresh data comes through.
  let cacheTtl = TAP_CACHE_TTL_CURRENT;
  if (interval) {
    try {
      const endIso = interval.split('/')[1];
      if (endIso) {
        const endMs  = new Date(endIso).getTime();
        const ageMs  = Date.now() - endMs;
        if (ageMs > 5 * 60 * 1000) cacheTtl = TAP_CACHE_TTL_HISTORIC;
      }
    } catch (_) {}
  }

  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(data), {
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': `public, max-age=${cacheTtl}`,
    },
  })));

  return json(data);
}

// ── KV Sync handler (/kv) ─────────────────────────────────────────────────────

async function handleKvGet(request, env) {
  const token = request.headers.get('X-Sync-Token');
  if(!token || token.length < 32) return json({ error: 'Missing or invalid sync token' }, 401);
  const kvKey = 'user:' + token;
  const val = await env.KV.get(kvKey);
  if(val === null) return json({ found: false }, 200);
  try {
    const parsed = JSON.parse(val);
    return json({ found: true, data: parsed }, 200);
  } catch(e) {
    return json({ error: 'Corrupt KV data' }, 500);
  }
}

async function handleKvPost(request, env) {
  const token = request.headers.get('X-Sync-Token');
  if(!token || token.length < 32) return json({ error: 'Missing or invalid sync token' }, 401);
  let body;
  try { body = await request.json(); } catch(e) { return json({ error: 'Invalid JSON body' }, 400); }
  // Basic validation — must have envelope fields
  if(!body.version || !body.updatedAt || !body.payload)
    return json({ error: 'Invalid sync envelope' }, 400);
  // Payload size guard (~4MB)
  const raw = JSON.stringify(body);
  if(raw.length > 4 * 1024 * 1024) return json({ error: 'Payload too large (max 4MB)' }, 413);
  const kvKey = 'user:' + token;
  await env.KV.put(kvKey, raw, { expirationTtl: 90 * 24 * 60 * 60 }); // 90 days, resets on every push
  return json({ ok: true, updatedAt: body.updatedAt }, 200);
}

// ── Main dispatcher ──────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {

    if(request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS_HEADERS });

    // Access control — checks SALTY_ORIGINS and SALTY_KEYS env vars if set
    const denied = checkAccess(request, env);
    if(denied) return denied;

    const path = new URL(request.url).pathname.replace(/\/+$/, '');

    // KV sync routes — handle before POST-only guard
    if(path === '/kv') {
      if(request.method === 'GET')  return handleKvGet(request, env);
      if(request.method === 'POST') return handleKvPost(request, env);
      return json({ error: 'Method not allowed for /kv' }, 405);
    }

    if(request.method !== 'POST')
      return json({ error: 'Only POST requests are accepted' }, 405);

    let body;
    try { body = await request.json(); }
    catch(e) { return json({ error: 'Invalid JSON body' }, 400); }

    if(path === '/pollen') return handlePollen(body, ctx);
    if(path === '/rss')    return handleRss(body, ctx);
    if(path === '/nvd')    return handleNvd(body, ctx);
    if(path === '/tap')    return handleTap(body, ctx);
    if(path === '/sports') return handleSports(body, ctx);
    if(path === '/otx')    return handleOtx(body, ctx);
    if(path === '/bible')  return handleBible(body, ctx);
    if(path === '/topics') return handleTopics(body, ctx);
    if(path === '/wotd')   return handleWotd(body, ctx);
    if(path === '/unsplash') return handleUnsplash(body, ctx);
    if(path === '/lastfm')   return handleLastfm(body, ctx);
    if(path === '/status') {
      try { return await handleStatus(body); }
      catch(e) { return json({ ok: false, status: null, via: 'worker', error: 'Unhandled worker error' }); }
    }

    // Legacy: detect from body fields (backwards compat)
    if(body.service) return handlePollen(body, ctx);
    if(body.url)     return handleRss(body, ctx);

    return json({ error: 'Unknown route. Use POST /pollen, /rss, /nvd, /tap, /sports, /otx, /bible, /topics, /wotd, /unsplash, /lastfm, /kv, or /status' }, 404);
  }
};
