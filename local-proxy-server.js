/**
 * salty_start — Local Proxy Server
 *
 * Companion to the salty_start dashboard. Run this on any always-on machine
 * on your local network. It allows the URL Monitor widget to check services
 * that the browser and Cloudflare Worker cannot reach:
 *
 *   • Internal/LAN services (192.168.x.x, 10.x.x.x, etc.)
 *   • HTTP endpoints (blocked by browser mixed-content policy)
 *   • HTTPS endpoints with self-signed or internal CA certificates
 *   • Any external URL you prefer to route through a local path
 *
 * ── SETUP ────────────────────────────────────────────────────────────────────
 *
 *   1. Requires Node.js 18+ (uses built-in fetch — no npm install needed)
 *
 *   2. Copy this file to any machine on your network that is always on.
 *      Good candidates: Pi-hole host, NAS, a VM, Raspberry Pi, etc.
 *
 *   3. Run it:
 *        node local-proxy-server.js
 *
 *      Or to run on a custom port:
 *        PORT=8080 node local-proxy-server.js
 *
 *      Or to keep it running permanently with PM2:
 *        npm install -g pm2
 *        pm2 start local-proxy-server.js --name salty-proxy
 *        pm2 save
 *        pm2 startup   (follow the printed command to enable on boot)
 *
 *   4. In your dashboard, open ⚡ Worker settings and set "Local Proxy URL"
 *      to:  http://<machine-ip>:<PORT>
 *      Example: http://192.168.1.50:3333
 *
 * ── SECURITY NOTE ────────────────────────────────────────────────────────────
 *
 *   This server accepts requests from any origin and will fetch any URL it is
 *   asked to. It is intended for LAN use only. Do NOT expose it to the internet
 *   or bind it to a public interface. The default binding is 0.0.0.0 which
 *   means all interfaces on the machine — this is intentional so other devices
 *   on your LAN can reach it, but ensure your router/firewall does not forward
 *   the port externally.
 *
 *   TLS certificate validation is intentionally disabled (NODE_TLS_REJECT_UNAUTHORIZED=0)
 *   so that self-signed and internal CA certificates can be checked. This is
 *   safe for internal monitoring use but means this server should not be used
 *   as a general-purpose proxy.
 *
 * ── API ───────────────────────────────────────────────────────────────────────
 *
 *   POST /status
 *   Body:    { "url": "https://..." }
 *   Returns: { "ok": true, "status": 200, "via": "local" }
 *         or { "ok": false, "status": null, "via": "local", "error": "..." }
 *
 *   POST /eisac
 *   Body:    { username, password, collectionId, addedAfter?, limit? }
 *            or { username, password, action: "discover" } for diagnostics
 *   Returns: { total, objects, more } — normalized STIX 2.1 object array
 *   Used by the E-ISAC Threat Intelligence widget. The Cloudflare Worker
 *   cannot reach E-ISAC because their WAF blocks Cloudflare egress IPs.
 *   This endpoint runs from your local machine, which has an allowed IP.
 *
 *   GET /ping
 *   Returns: { "ok": true, "via": "local" }
 *   Useful for testing that the proxy is reachable from the dashboard machine.
 *
 */

'use strict';

// ── Config ────────────────────────────────────────────────────────────────────

const PORT    = parseInt(process.env.PORT  || '3333', 10);
const HOST    = process.env.HOST           || '0.0.0.0';
const TIMEOUT = parseInt(process.env.TIMEOUT_MS || '8000', 10); // per-leg fetch timeout

// Disable TLS cert validation globally — required for self-signed cert checking
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ── Helpers ───────────────────────────────────────────────────────────────────

const http = require('http');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function send(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, CORS_HEADERS);
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end',  ()    => {
      try { resolve(JSON.parse(data || '{}')); }
      catch(e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ── Status check ──────────────────────────────────────────────────────────────

async function checkUrl(url) {
  // Validate
  let parsed;
  try {
    parsed = new URL(url);
    if(!['http:', 'https:'].includes(parsed.protocol))
      return { ok: false, status: null, via: 'local', error: 'Only http/https URLs are supported' };
  } catch(e) {
    return { ok: false, status: null, via: 'local', error: 'Invalid URL' };
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; salty-start-local-proxy/1.0; status-checker)',
    'Accept': '*/*',
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  // Try HEAD first
  try {
    const res = await fetch(url, {
      method:   'HEAD',
      headers,
      redirect: 'follow',
      signal:   controller.signal,
    });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status, via: 'local' };
  } catch(e) {
    clearTimeout(timer);
    if(e.name === 'AbortError')
      return { ok: false, status: null, via: 'local', error: 'Timed out' };
    // HEAD failed — try GET
  }

  // Retry with GET
  const controller2 = new AbortController();
  const timer2 = setTimeout(() => controller2.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      method:   'GET',
      headers,
      redirect: 'follow',
      signal:   controller2.signal,
    });
    clearTimeout(timer2);
    return { ok: res.ok, status: res.status, via: 'local' };
  } catch(e) {
    clearTimeout(timer2);
    const reason = e.name === 'AbortError' ? 'Timed out' : e.message;
    return { ok: false, status: null, via: 'local', error: reason };
  }
}


// ── E-ISAC TAXII 2.1 ──────────────────────────────────────────────────────────
//
// Standard STIX 2.x TLP marking definition IDs (covers both TLP 1.0 and 2.0)
const EISAC_TLP_IDS = {
  'marking-definition--613f2e26-407d-48c7-9eca-b8e91ba519f5': 'white',
  'marking-definition--34098fce-860f-479c-ad6c-bdf70b73e8ca': 'green',
  'marking-definition--f88d31f6-1208-47ec-8cb7-c658e0cf3ef6': 'amber',
  'marking-definition--5e57c739-391a-4eb3-b6be-7d15ca92d5ed': 'red',
  'marking-definition--94868c89-83c2-464b-929b-a1a8aa3c8487': 'clear',
  'marking-definition--bab4a63c-aed9-4cf5-a766-dfca5abac2bb': 'green',
  'marking-definition--55d920b0-5207-45ab-ab64-cdc2a47fe77d': 'amber',
  'marking-definition--939a9414-2ddd-4d32-a254-ea7b3e7bd26f': 'amber',
  'marking-definition--e828b379-4e03-4974-9ac4-e53a884c97c5': 'red',
};
const EISAC_SKIP_TYPES = new Set(['marking-definition','identity','relationship','sighting','bundle','extension-definition']);

async function handleEisac(body) {
  const { username, password, collectionId, addedAfter, limit = 200 } = body;

  if (!username || !password)
    return { error: 'Required fields: username, password', _httpStatus: 400 };

  const creds = Buffer.from(username + ':' + password).toString('base64');

  // Diagnostic / discovery mode — probes the discovery endpoint with multiple Accept headers
  if (body.action === 'discover') {
    const discoveryUrl = 'https://e-isac.cyware.com/ctixapi/ctix21/taxii2/';
    const acceptVariants = [
      'application/taxii+json;version=2.1',
      'application/taxii+json',
      'application/json',
      '*/*',
    ];
    const results = [];
    for (const accept of acceptVariants) {
      try {
        const res = await fetch(discoveryUrl, {
          headers: { 'Authorization': 'Basic ' + creds, 'Accept': accept },
        });
        const ct = res.headers.get('content-type') || 'unknown';
        let snippet = '';
        try { snippet = (await res.text()).slice(0, 250); } catch(e) {}
        const tag = res.status === 200 ? '✓ 200' : ('  ' + res.status);
        results.push(tag + ' | Accept: ' + accept + '\n      → ' + ct + '\n      → ' + snippet.replace(/\s+/g, ' ').slice(0, 180));
      } catch(e) {
        results.push('  ERR | Accept: ' + accept + '\n      → ' + e.message);
      }
    }
    return { results: 'Discovery URL: ' + discoveryUrl + '\nAuth: Basic ' + username.slice(0,8) + '...\nVia: local proxy\n\n' + results.join('\n\n') };
  }

  if (!collectionId)
    return { error: 'Required field: collectionId', _httpStatus: 400 };

  const safeLimit = Math.min(Math.max(parseInt(limit) || 200, 1), 500);

  const url = new URL('https://e-isac.cyware.com/ctixapi/ctix21/collections/' + encodeURIComponent(collectionId) + '/objects/');
  if (addedAfter) url.searchParams.set('added_after', addedAfter);
  url.searchParams.set('limit', String(safeLimit));

  let upstream;
  try {
    upstream = await fetch(url.toString(), {
      headers: { 'Authorization': 'Basic ' + creds, 'Accept': 'application/taxii+json;version=2.1' },
    });
  } catch(e) { return { error: 'E-ISAC fetch failed: ' + e.message, _httpStatus: 502 }; }

  if (upstream.status === 401) return { error: 'E-ISAC: Invalid credentials (401)', _httpStatus: 401 };
  if (upstream.status === 403) return { error: 'E-ISAC: Access denied (403)', _httpStatus: 403 };
  if (upstream.status === 404) return { error: 'E-ISAC: Collection not found (404)', _httpStatus: 404 };

  let data;
  try { data = await upstream.json(); }
  catch(e) {
    const ct = upstream.headers.get('content-type') || 'unknown';
    return { error: 'E-ISAC: non-JSON response (HTTP ' + upstream.status + ', ' + ct + ')', _httpStatus: 502 };
  }

  if (!upstream.ok) {
    const msg = (data && (data.message || data.description || data.detail || data.error)) || ('HTTP ' + upstream.status);
    return { error: 'E-ISAC API error: ' + msg, _httpStatus: upstream.status };
  }

  const rawObjects = data.objects || [];

  // Build local TLP lookup from any marking-definition objects in the bundle
  const localMarkings = {};
  rawObjects.filter(o => o.type === 'marking-definition').forEach(m => {
    const tlp = (m.definition?.tlp || m.name || '').toLowerCase().replace('tlp:', '').trim();
    if (tlp) localMarkings[m.id] = tlp;
  });

  function resolveTlp(obj) {
    for (const ref of (obj.object_marking_refs || [])) {
      if (EISAC_TLP_IDS[ref]) return EISAC_TLP_IDS[ref];
      if (localMarkings[ref]) return localMarkings[ref];
    }
    const direct = (obj.tlp || obj.x_tlp || obj.x_eiq_tlp || '').toLowerCase().replace('tlp:', '');
    return direct || 'white';
  }

  const normalized = rawObjects
    .filter(o => o.type && !EISAC_SKIP_TYPES.has(o.type))
    .map(o => ({
      id:             o.id || '',
      type:           o.type || 'unknown',
      name:           o.name || o.title || ('[' + (o.type || 'unknown') + ']'),
      description:    (o.description || o.abstract || '').slice(0, 600),
      created:        o.created  || null,
      modified:       o.modified || null,
      published:      o.published || null,
      tlp:            resolveTlp(o),
      labels:         o.labels || [],
      pattern:        o.pattern   ? o.pattern.slice(0, 400) : null,
      patternType:    o.pattern_type || null,
      validFrom:      o.valid_from || null,
      objectRefCount: (o.object_refs || []).length,
      roles:              o.roles || [],
      sophistication:     o.sophistication || null,
      resourceLevel:      o.resource_level || null,
      primaryMotivation:  o.primary_motivation || null,
      malwareTypes:  o.malware_types || [],
      isFamily:      o.is_family || false,
      aliases:       o.aliases || [],
      refs: (o.external_references || []).slice(0, 5).map(r => ({
        name: r.source_name || '',
        url:  r.url || null,
        eid:  r.external_id || null,
      })),
    }));

  return { total: normalized.length, objects: normalized, more: data.more || false };
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url  = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // CORS preflight
  if(req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Health check
  if(path === '/ping' && req.method === 'GET') {
    send(res, 200, { ok: true, via: 'local' });
    return;
  }

  // Status check
  if(path === '/status' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch(e) {
      send(res, 400, { ok: false, status: null, via: 'local', error: 'Invalid JSON body' });
      return;
    }

    if(!body.url || typeof body.url !== 'string') {
      send(res, 400, { ok: false, status: null, via: 'local', error: 'Required field: url' });
      return;
    }

    const result = await checkUrl(body.url);
    send(res, 200, result);
    return;
  }

  // E-ISAC TAXII proxy
  if(path === '/eisac' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch(e) {
      send(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const result = await handleEisac(body);
    const statusCode = result._httpStatus || 200;
    delete result._httpStatus;
    send(res, statusCode, result);
    return;
  }

  // Unknown route
  send(res, 404, { error: 'Unknown route. Use POST /status, POST /eisac, or GET /ping.' });
});

server.listen(PORT, HOST, () => {
  console.log(`salty_start local proxy running on http://${HOST}:${PORT}`);
  console.log(`  POST /status  — check a URL`);
  console.log(`  POST /eisac   — E-ISAC TAXII 2.1 proxy`);
  console.log(`  GET  /ping    — health check`);
  console.log(`  TLS cert validation: DISABLED (self-signed certs supported)`);
  console.log(`  Set "Local Proxy URL" in dashboard ⚡ settings to: http://<this-machine-ip>:${PORT}`);
});

server.on('error', err => {
  if(err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set a different port with: PORT=<number> node local-proxy-server.js`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
