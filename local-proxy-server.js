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

  // Unknown route
  send(res, 404, { error: 'Unknown route. Use POST /status or GET /ping.' });
});

server.listen(PORT, HOST, () => {
  console.log(`salty_start local proxy running on http://${HOST}:${PORT}`);
  console.log(`  POST /status  — check a URL`);
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
