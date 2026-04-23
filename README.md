# Salty — Personal Browser Dashboard

A self-hosted, single-file browser start page dashboard. No build tools, no npm, no external dependencies beyond the APIs you choose to use. Everything lives in one HTML file and persists via `localStorage`, with optional cross-browser sync through a Cloudflare Worker and KV storage.  Base settings/config backup is achieved through .json export file that can be imported to multiple browsers.

---

## Features

- **Tabbed layout** — organize widgets into multiple named tabs
- **Drag-and-drop** section reordering within columns
- **Widget picker** — add/remove widgets per tab
- **Animated CSS backgrounds** with an HSL color wheel theme picker
- **Bottom bar** — clock, weather tiles, lo-fi player, rotating quotes
- **Search/filter bar** across all content
- **Weather/Quotes bar** — provides a variety of weather info, and optional API pollen level data.
- **Edit mode** — configure every widget in place
- **Bookmark import**
- **KV sync** — push/pull full dashboard state across browsers via Cloudflare KV

### Available Widgets
 
Widgets are organized into seven categories matching the in-app selector tabs.
 
#### 🗂️ General
| Widget | Notes |
|---|---|
| World Clocks | Multiple timezones side by side |
| Countdown | Configurable countdown timer to any date |
| Reminders | Lightweight reminder list with KV sync |
| Quick Note | Freeform scratch pad, KV-synced |
| Search | Configurable search bar |
| To-Do | Simple checklist widget |
| Task Tracker | Full task log with deep KV sync and tombstone-based deletion propagation |
 
#### 👤 Personal
| Widget | Notes |
|---|---|
| Drink Tracker | Daily intake log with category breakdown |
| Energy and Mood Tracker | Daily energy/mood logging with insights panel; optional **menstrual cycle tracking** (toggle in edit mode) with phase-aware hormone insights across all cycle days |
| Last.fm | Recent scrobbles and now-playing via Audioscrobbler API |
| Audiobookshelf | Now-listening and library status from a self-hosted Audiobookshelf instance |
 
#### 📰 Info & Media
| Widget | Notes |
|---|---|
| RSS Feed | Any RSS/Atom feed via worker proxy |
| Sports Scores | Live, today, final, and upcoming games (TheSportsDB) |
| Bible Browser | Full modal with multiple translations (CSB, NLT, MSG + more), highlights, notes, topical search |
| Verse of the Day | Daily scripture with translation selector |
| Word of the Day | Curated list + Free Dictionary API or Wordnik |
| Poem of the Day | PoetryDB random poem |
| NASA APOD | Astronomy Picture of the Day |
| On This Day | Historical events for today's date |
| Wikipedia Featured Article | Daily featured article from Wikipedia |
| Met Museum Artwork of the Day | Random artwork from the Metropolitan Museum open collection |
| Artist Spotlight | Rotating artist feature |
| Unsplash Random Photo | Daily random photo from Unsplash |
| Lo-fi Music Player | YouTube IFrame–based player with curated playlists, radio mixes, and albums; shuffle, volume control, and watchdog auto-recovery |
 
#### 🔧 Tools
| Widget | Notes |
|---|---|
| JSON Formatter | Validate and pretty-print JSON |
| Base64 Encoder/Decoder | Encode or decode Base64 strings |
| Hash Generator | MD5 / SHA hashes client-side |
| JWT Decoder | Decode and inspect JWT payloads |
| Unit Converter | Common unit conversions |
| Subnet Calculator | CIDR subnet math |
| DNS Lookup | Forward/reverse DNS queries via worker proxy |
| Dice Roller | Configurable polyhedral dice roller |
| Decision Helper | Weighted random decision picker |
 
#### 🌐 Network & Security
| Widget | Notes |
|---|---|
| CVE Bulletin | NVD vulnerability watchlist with configurable severity filters |
| OTX Pulse Feed | AlienVault OTX threat intelligence |
| BGP / ASN Lookup | Real-time BGP routing data |
| Proofpoint TAP | Very Attacked Persons and click/block telemetry (work security) |
| URL Monitor | HTTP endpoint health checks via worker proxy |
 
#### 💻 Coding
| Widget | Notes |
|---|---|
| GitHub Activity | Commit/PR feed for any public user or org |

#### AND MORE TO COME ####
Submit ideas for widgets you'd like to see!

---

## Demo

https://badbox29.github.io/personal_dashboard/

## Setup

### 1. Get the files

Download `index.html` and `pollen-proxy-worker.js` from this repository. That's it — `index.html` is the entire app.

Open `index.html` in your browser directly, serve it from any static host, or set it as your browser's homepage/new tab page.

---

### 2. Deploy the Cloudflare Worker (optional but recommended)

The Worker acts as a CORS proxy for features that browsers can't call directly: pollen data, NVD/CVE API authentication, RSS feeds, Bible API, and more. It also provides the KV sync backend.

A free Cloudflare account is sufficient for personal use.

#### 2a. Create the Worker

1. Log in to [dash.cloudflare.com](https://dash.cloudflare.com) and open **Workers & Pages**.
2. Click **Create** → **Create Worker**.
3. Give it a name (e.g. `salty-worker`) and click **Deploy**.
4. Click **Edit code**, paste the entire contents of `pollen-proxy-worker.js` into the editor, and click **Deploy** again.
5. Note your worker URL — it will be in the form `https://your-worker-name.your-subdomain.workers.dev`.

#### 2b. Create a KV namespace (required for cross-browser sync)

1. In the Cloudflare dashboard, go to **Workers & Pages → KV**.
2. Click **Create a namespace**, name it (e.g. `salty-kv`), and click **Add**.
3. Go back to your Worker, open its **Settings → Bindings** tab.
4. Click **Add** → **KV Namespace**.
5. Set the **Variable name** to exactly `KV` (uppercase) and select the namespace you just created.
6. Click **Deploy** to save the binding.

> **Why `KV`?** The worker code references `env.KV` by that exact name. If you use a different variable name the sync routes will fail.

#### 2c. Point the dashboard at your Worker

1. Open `index.html` in your browser.
2. Enter **Edit Mode** (pencil icon in the bottom bar).
3. Click the **⚡ Worker** button.
4. Paste your worker URL into the **Global Worker URL** field and click **Save**.

The dashboard will immediately begin routing eligible API calls through your worker.

---

### 3. Worker Routes Reference

| Route | Method | Purpose | Cache |
|---|---|---|---|
| `/pollen` | POST | Pollen data from WeatherAPI, Tomorrow.io, Ambee, or Google Pollen API | 4 hours |
| `/rss` | POST | Fetch any RSS/Atom feed (returns raw XML) | 30 minutes |
| `/nvd` | POST | NVD CVE API proxy (adds your API key server-side) | 10 minutes |
| `/bible` | POST | API.Bible proxy (adds API key server-side) | 7–30 days |
| `/topics` | POST | OpenBible.info topical verse search | 24 hours |
| `/wotd` | POST | Wordnik Word of the Day | 6 hours |
| `/sports` | POST | TheSportsDB scores and schedules | 1–10 minutes |
| `/otx` | POST | AlienVault OTX threat pulse feed | varies |
| `/tap` | POST | Proofpoint TAP API (VAP, SIEM, clicks) | 5 minutes |
| `/unsplash` | POST | Unsplash random photo | 1 hour |
| `/status` | POST | URL reachability check for URL Monitor widget | no cache |
| `/kv` | GET/POST | KV sync read/write | — |

All routes add CORS headers so browser-side `fetch()` calls work without modification.

---

## The ⚡ Worker Settings Panel

Accessed via **Edit Mode → ⚡ button** in the bottom bar. All configuration here persists in `localStorage`.

### Global Worker URL

The Worker URL used by all widgets that need a proxy. Individual widgets (Pollen inside Weather settings, RSS Feed, CVE Bulletin) have their own optional override field — if left blank they fall back to this global value.

### Local Proxy URL

Used by the **URL Monitor** widget to check internal services, hosts with self-signed certificates, and endpoints not reachable from the public internet. Run `local-proxy-server.js` on any always-on machine on your local network and paste its address here (e.g. `http://192.168.1.x:3333`). Leave blank if you don't need it.

### Worker Access Control (Optional but Recommended)

The worker supports two independent security layers to prevent unauthorized use of your deployed worker. Both are configured via **Cloudflare Worker Settings → Variables and Secrets** — no changes to the worker source code are required. Either check is skipped gracefully if its environment variable is not set, so both are fully opt-in. When both are configured, both must pass.

#### SALTY_KEYS — Shared Secret Tokens

Every request from the dashboard includes a secret token in the `X-Salty-Key` header. The worker validates the token against the `SALTY_KEYS` list and returns `403 Forbidden` if it is missing or doesn't match.

`SALTY_KEYS` is a comma-separated list, which means you can issue a **unique token per user**. This is strongly recommended if you are sharing your worker with household members or friends — it lets you revoke access for one person by removing their token without affecting anyone else.

**Example:**

```
SALTY_KEYS = mytoken-abc123,spouse-token-xyz789,friend-token-def456
```

Each person receives only their own token and enters it in the **Worker Secret Key** field in their dashboard's ⚡ Worker settings. They never need to see anyone else's token.

**To generate a strong token**, use any password manager's random generator, or run this in your browser console:

```javascript
crypto.getRandomValues(new Uint8Array(24)).reduce((s,b)=>s+b.toString(16).padStart(2,'0'),'')
```

Store `SALTY_KEYS` as an **encrypted secret** in Cloudflare (not a plain text variable) so it is never visible in the dashboard UI.

#### SALTY_ORIGINS — Allowed Origins

The worker checks the `Origin` and `Referer` headers on every request and rejects anything not on the allowlist with a `403 Forbidden`. This prevents other websites or scripts from piggy-backing on your worker even if they somehow obtain a valid key.

`SALTY_ORIGINS` is a comma-separated list of the base URLs from which your `index.html` is served. Include every location where you or your users access the dashboard.

**Example:**

```
SALTY_ORIGINS = https://yourusername.github.io,https://yourdomain.com,http://192.168.1.50
```

A few things to keep in mind:

- **`file://` URLs have no `Origin` header** and will always be blocked when `SALTY_ORIGINS` is set. If you open `index.html` directly from disk rather than serving it, either leave `SALTY_ORIGINS` unset or serve the file via a local web server.
- **Include every device's serving URL.** If household members access the dashboard from a different host or port than you do, add those origins too.
- **Trailing slashes matter.** Use `https://yourusername.github.io` not `https://yourusername.github.io/`.

**To enable both controls:**

1. In the Cloudflare dashboard, open your worker → **Settings → Variables and Secrets**.
2. Add `SALTY_KEYS` with your comma-separated tokens. Click **Encrypt** before saving.
3. Add `SALTY_ORIGINS` with your comma-separated origin URLs as a plain text variable.
4. Click **Deploy** to apply the new environment variables.
5. In each user's dashboard, open **Edit Mode → ⚡ Worker** and paste their token into the **Worker Secret Key** field.

> **Note:** Because `index.html` is a client-side file, the token is readable by anyone with DevTools access to that browser. This is abuse and scraping prevention, not user authentication — which is perfectly appropriate for a personal dashboard shared with household members. Do not reuse these tokens as passwords for anything else.

### KV Sync

Syncs your full dashboard state across multiple browsers using Cloudflare KV. Requires the Worker URL to be saved first. Setup follows four steps:

**Step 1 — Worker URL**
Save your Worker URL in the field above. KV sync routes through the same worker.

**Step 2 — Sync Token**
Your sync token is your identity in KV. Each browser generates one automatically.

- On your **primary browser**: click **Copy** to copy your token and save it somewhere safe. Your token is also included in any JSON export of your dashboard.
- On a **new browser**: click **📋 Enter Token** and paste the token from your primary browser. Both browsers will now share the same KV namespace.
- **⚠ Reset Sync Identity** generates a brand-new token, permanently disconnecting this browser from its current KV data. Use only if you want to start fresh.

**Step 3 — Manual push/pull**
- **⬆ Push to KV** — immediately uploads your current dashboard state to KV. Use this on your primary browser before setting up a second device.
- **⬇ Pull from KV** — immediately downloads the saved state from KV. Use this on a new browser after entering the token, to get your data before enabling auto-sync.

**Step 4 — Enable automatic sync**
Toggle **Enable automatic KV sync**. When active:
- Every change to your dashboard is pushed to KV within 5 seconds (debounced).
- Your full state is pulled from KV on every page load.
- Mergeable data (logs, history, seen/dismissed records) is combined additively across browsers rather than overwritten. Configuration and widget settings use a last-write-wins model.

---

## Data Storage

All dashboard data lives in a single `localStorage` key: `salty_v2`. KV sync pushes and pulls this same object. There are no cookies, no accounts, and no data ever leaves your browser except through your own Worker.

`salty_clientId` is a per-browser identifier stored separately in `localStorage` and is never synced to KV.

---

## API Keys

Most widgets work without any API key. The following widgets require keys you supply yourself — they are stored in your dashboard configuration and sent to upstream APIs only through your Worker (never exposed in browser requests):

| Widget / Feature | Provider | Free Tier |
|---|---|---|
| Pollen | Google Pollen API, Tomorrow.io, WeatherAPI, or Ambee | Yes (varies by provider) |
| CVE Bulletin | NVD (nvd.nist.gov) | Yes |
| Bible Browser | API.Bible | Yes |
| Word of the Day | Wordnik | Yes |
| Sports Scores | TheSportsDB | Yes |
| OTX Pulses | AlienVault OTX | Yes |
| NASA APOD | NASA Open APIs | Yes |
| Background Photos | Unsplash | Yes |
| TAP (Proofpoint) | Proofpoint TAP API | Requires Proofpoint subscription |

---

## License

See LICENSE file.
