<?php
/**
 * salty_start — Local Proxy Server (PHP / XAMPP version)
 *
 * Companion to the salty_start dashboard. Drop this file and the included
 * .htaccess into a folder inside your XAMPP htdocs directory. It provides the
 * same three endpoints as the Node.js version, allowing the URL Monitor and
 * E-ISAC widgets to reach services the browser and Cloudflare Worker cannot:
 *
 *   • Internal/LAN services (192.168.x.x, 10.x.x.x, etc.)
 *   • HTTP endpoints (blocked by browser mixed-content policy)
 *   • HTTPS endpoints with self-signed or internal CA certificates
 *   • Any external URL you prefer to route through a local path
 *
 * ── REQUIREMENTS ──────────────────────────────────────────────────────────────
 *
 *   • PHP 8.0+  (XAMPP 8.x ships this by default)
 *   • PHP curl extension enabled (it is, by default in XAMPP)
 *   • Apache mod_rewrite enabled  (see note below)
 *
 *   To enable mod_rewrite in XAMPP:
 *     1. Open XAMPP Control Panel → Apache → Config → httpd.conf
 *     2. Find and uncomment:  LoadModule rewrite_module modules/mod_rewrite.so
 *     3. Find the <Directory "C:/xampp/htdocs"> block and change
 *        AllowOverride None  →  AllowOverride All
 *     4. Restart Apache.
 *
 * ── SETUP ─────────────────────────────────────────────────────────────────────
 *
 *   1. Copy both local-proxy-server.php and .htaccess into a new folder inside
 *      your XAMPP htdocs directory, e.g.:
 *        C:\xampp\htdocs\salty-proxy\
 *
 *   2. Make sure Apache is running in XAMPP Control Panel.
 *
 *   3. Test it — open a browser and visit:
 *        http://localhost/salty-proxy/ping
 *      You should see:  {"ok":true,"via":"local"}
 *
 *   4. In your dashboard, open ⚡ Worker settings and set "Local Proxy URL" to:
 *        http://<machine-ip>/salty-proxy
 *      Example:  http://192.168.1.50/salty-proxy
 *      (Use http://localhost/salty-proxy if testing on the same machine)
 *
 * ── SECURITY NOTE ─────────────────────────────────────────────────────────────
 *
 *   This script accepts requests from any origin and will fetch any URL given
 *   to it. It is intended for LAN use only. Do NOT expose your XAMPP install
 *   to the internet. Ensure your router/firewall does not forward port 80
 *   externally while this is running.
 *
 *   TLS certificate validation is intentionally disabled (CURLOPT_SSL_VERIFYPEER
 *   = false) so that self-signed and internal CA certificates can be reached.
 *   This is safe for internal monitoring use but means this script should not
 *   be used as a general-purpose proxy.
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
 *
 *   GET /ping
 *   Returns: { "ok": true, "via": "local" }
 *
 */

declare(strict_types=1);

// ── Config ────────────────────────────────────────────────────────────────────

const PROXY_TIMEOUT_MS = 8000; // per-request fetch timeout in milliseconds

// ── Routing ───────────────────────────────────────────────────────────────────

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// Handle CORS preflight immediately
if ($method === 'OPTIONS') {
    cors_headers();
    http_response_code(204);
    exit;
}

$route = get_route();

match (true) {
    $route === '/ping'   && $method === 'GET'  => handle_ping(),
    $route === '/status' && $method === 'POST' => handle_status(),
    $route === '/eisac'  && $method === 'POST' => handle_eisac(),
    default => send_json(404, ['error' => 'Unknown route. Use POST /status, POST /eisac, or GET /ping.']),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function cors_headers(): void {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
}

function send_json(int $status, array $body): never {
    cors_headers();
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function read_body(): array {
    $raw = file_get_contents('php://input');
    if (empty(trim((string) $raw))) return [];
    $data = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        send_json(400, ['error' => 'Invalid JSON body']);
    }
    return $data;
}

function get_route(): string {
    // With mod_rewrite routing everything to this file, PATH_INFO holds the
    // virtual sub-path. Fall back to stripping the script directory from the URI.
    if (!empty($_SERVER['PATH_INFO'])) {
        return rtrim($_SERVER['PATH_INFO'], '/') ?: '/';
    }
    $uri  = strtok($_SERVER['REQUEST_URI'] ?? '/', '?');
    $base = rtrim(dirname($_SERVER['SCRIPT_NAME']), '/\\');
    if ($base !== '' && str_starts_with((string) $uri, $base)) {
        $uri = substr((string) $uri, strlen($base));
    }
    return rtrim((string) $uri, '/') ?: '/';
}

// ── Handlers ─────────────────────────────────────────────────────────────────

function handle_ping(): never {
    send_json(200, ['ok' => true, 'via' => 'local']);
}

function handle_status(): never {
    $body = read_body();
    if (empty($body['url']) || !is_string($body['url'])) {
        send_json(400, ['ok' => false, 'status' => null, 'via' => 'local',
                        'error' => 'Required field: url']);
    }
    send_json(200, check_url($body['url']));
}

function handle_eisac(): never {
    $body = read_body();
    $result = eisac_proxy($body);
    $http_status = $result['_httpStatus'] ?? 200;
    unset($result['_httpStatus']);
    send_json((int) $http_status, $result);
}

// ── URL status check ──────────────────────────────────────────────────────────

function check_url(string $url): array {
    $parsed = parse_url($url);
    $scheme = $parsed['scheme'] ?? '';
    if (!in_array($scheme, ['http', 'https'], true)) {
        return ['ok' => false, 'status' => null, 'via' => 'local',
                'error' => 'Only http/https URLs are supported'];
    }

    // Try HEAD first — mirrors the Node.js version's try/catch/retry logic
    [$result, $timed_out] = do_curl_request($url, 'HEAD');
    if ($timed_out) {
        return ['ok' => false, 'status' => null, 'via' => 'local', 'error' => 'Timed out'];
    }
    if ($result !== null) {
        return $result;
    }

    // HEAD failed at connection level — retry with GET
    [$result, $timed_out] = do_curl_request($url, 'GET');
    if ($timed_out) {
        return ['ok' => false, 'status' => null, 'via' => 'local', 'error' => 'Timed out'];
    }
    if ($result !== null) {
        return $result;
    }

    return ['ok' => false, 'status' => null, 'via' => 'local', 'error' => 'Request failed'];
}

/**
 * Run a single curl request.
 * Returns [result_array|null, timed_out_bool].
 * null result with false timed_out signals a connection-level error (caller retries with GET).
 */
function do_curl_request(string $url, string $method): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 10,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => false,
        CURLOPT_TIMEOUT_MS     => PROXY_TIMEOUT_MS,
        CURLOPT_USERAGENT      => 'Mozilla/5.0 (compatible; salty-start-local-proxy/1.0; status-checker)',
        CURLOPT_NOBODY         => ($method === 'HEAD'),   // HEAD = no body
        CURLOPT_HTTPHEADER     => ['Accept: */*'],
    ]);

    curl_exec($ch);
    $errno  = curl_errno($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    // 28 = CURLE_OPERATION_TIMEDOUT
    if ($errno === 28) {
        return [null, true];
    }
    if ($errno !== CURLE_OK) {
        return [null, false]; // Connection error — signal caller to try GET
    }

    return [
        ['ok' => ($status >= 200 && $status < 400), 'status' => $status, 'via' => 'local'],
        false,
    ];
}

// ── E-ISAC TAXII 2.1 ─────────────────────────────────────────────────────────

// Standard STIX 2.x TLP marking definition IDs (covers TLP 1.0 and 2.0)
const EISAC_TLP_IDS = [
    'marking-definition--613f2e26-407d-48c7-9eca-b8e91ba519f5' => 'white',
    'marking-definition--34098fce-860f-479c-ad6c-bdf70b73e8ca' => 'green',
    'marking-definition--f88d31f6-1208-47ec-8cb7-c658e0cf3ef6' => 'amber',
    'marking-definition--5e57c739-391a-4eb3-b6be-7d15ca92d5ed' => 'red',
    'marking-definition--94868c89-83c2-464b-929b-a1a8aa3c8487' => 'clear',
    'marking-definition--bab4a63c-aed9-4cf5-a766-dfca5abac2bb' => 'green',
    'marking-definition--55d920b0-5207-45ab-ab64-cdc2a47fe77d' => 'amber',
    'marking-definition--939a9414-2ddd-4d32-a254-ea7b3e7bd26f' => 'amber',
    'marking-definition--e828b379-4e03-4974-9ac4-e53a884c97c5' => 'red',
];

const EISAC_SKIP_TYPES = [
    'marking-definition', 'identity', 'relationship',
    'sighting', 'bundle', 'extension-definition',
];

function eisac_proxy(array $body): array {
    $username     = $body['username']     ?? '';
    $password     = $body['password']     ?? '';
    $collection_id = $body['collectionId'] ?? '';
    $added_after  = $body['addedAfter']   ?? null;
    $limit        = $body['limit']        ?? 200;

    if (!$username || !$password) {
        return ['error' => 'Required fields: username, password', '_httpStatus' => 400];
    }

    $creds = base64_encode($username . ':' . $password);

    // ── Diagnostic / discovery mode ───────────────────────────────────────────
    if (($body['action'] ?? '') === 'discover') {
        $discovery_url  = 'https://e-isac.cyware.com/ctixapi/ctix21/taxii2/';
        $accept_variants = [
            'application/taxii+json;version=2.1',
            'application/taxii+json',
            'application/json',
            '*/*',
        ];
        $lines = [
            'Discovery URL: ' . $discovery_url,
            'Auth: Basic ' . substr($username, 0, 8) . '...',
            'Via: local proxy (PHP)',
            '',
        ];
        foreach ($accept_variants as $accept) {
            [$status, $body_text, $ct, $err] = eisac_curl($discovery_url, 'Basic ' . $creds, $accept);
            if ($err !== null) {
                $lines[] = '  ERR | Accept: ' . $accept . "\n      → " . $err;
            } else {
                $tag     = $status === 200 ? '✓ 200' : ('  ' . $status);
                $snippet = mb_substr(preg_replace('/\s+/', ' ', $body_text), 0, 180);
                $lines[] = $tag . ' | Accept: ' . $accept
                         . "\n      → " . $ct
                         . "\n      → " . $snippet;
            }
        }
        return ['results' => implode("\n\n", $lines)];
    }

    // ── Main TAXII fetch ──────────────────────────────────────────────────────
    if (!$collection_id) {
        return ['error' => 'Required field: collectionId', '_httpStatus' => 400];
    }

    $safe_limit = max(1, min(500, (int) $limit));
    $url = 'https://e-isac.cyware.com/ctixapi/ctix21/collections/'
         . rawurlencode($collection_id) . '/objects/?limit=' . $safe_limit;
    if ($added_after) {
        $url .= '&added_after=' . rawurlencode($added_after);
    }

    [$status, $body_text, , $err] = eisac_curl($url, 'Basic ' . $creds, 'application/taxii+json;version=2.1');

    if ($err !== null) {
        return ['error' => 'E-ISAC fetch failed: ' . $err, '_httpStatus' => 502];
    }

    $status_map = [401 => 'Invalid credentials (401)', 403 => 'Access denied (403)', 404 => 'Collection not found (404)'];
    if (isset($status_map[$status])) {
        return ['error' => 'E-ISAC: ' . $status_map[$status], '_httpStatus' => $status];
    }

    $data = json_decode($body_text, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        return ['error' => 'E-ISAC: non-JSON response (HTTP ' . $status . ')', '_httpStatus' => 502];
    }
    if ($status < 200 || $status >= 300) {
        $msg = $data['message'] ?? $data['description'] ?? $data['detail'] ?? $data['error'] ?? ('HTTP ' . $status);
        return ['error' => 'E-ISAC API error: ' . $msg, '_httpStatus' => $status];
    }

    $raw_objects = $data['objects'] ?? [];

    // Build local TLP lookup from any marking-definition objects in the bundle
    $local_markings = [];
    foreach ($raw_objects as $obj) {
        if (($obj['type'] ?? '') === 'marking-definition') {
            $tlp = strtolower(str_replace('tlp:', '', $obj['definition']['tlp'] ?? $obj['name'] ?? ''));
            if ($tlp) $local_markings[$obj['id']] = $tlp;
        }
    }

    $normalized = [];
    foreach ($raw_objects as $obj) {
        $type = $obj['type'] ?? '';
        if (!$type || in_array($type, EISAC_SKIP_TYPES, true)) continue;

        // Resolve TLP
        $tlp = 'white';
        foreach (($obj['object_marking_refs'] ?? []) as $ref) {
            if (isset(EISAC_TLP_IDS[$ref]))   { $tlp = EISAC_TLP_IDS[$ref];   break; }
            if (isset($local_markings[$ref]))  { $tlp = $local_markings[$ref]; break; }
        }
        if ($tlp === 'white') {
            $direct = strtolower(str_replace('tlp:', '', $obj['tlp'] ?? $obj['x_tlp'] ?? $obj['x_eiq_tlp'] ?? ''));
            if ($direct) $tlp = $direct;
        }

        // Slice external refs
        $refs = [];
        foreach (array_slice($obj['external_references'] ?? [], 0, 5) as $r) {
            $refs[] = ['name' => $r['source_name'] ?? '', 'url' => $r['url'] ?? null, 'eid' => $r['external_id'] ?? null];
        }

        $normalized[] = [
            'id'                => $obj['id']       ?? '',
            'type'              => $type,
            'name'              => $obj['name']      ?? $obj['title'] ?? ('[' . $type . ']'),
            'description'       => mb_substr($obj['description'] ?? $obj['abstract'] ?? '', 0, 600),
            'created'           => $obj['created']   ?? null,
            'modified'          => $obj['modified']  ?? null,
            'published'         => $obj['published'] ?? null,
            'tlp'               => $tlp,
            'labels'            => $obj['labels']    ?? [],
            'pattern'           => isset($obj['pattern']) ? mb_substr($obj['pattern'], 0, 400) : null,
            'patternType'       => $obj['pattern_type']        ?? null,
            'validFrom'         => $obj['valid_from']          ?? null,
            'objectRefCount'    => count($obj['object_refs']   ?? []),
            'roles'             => $obj['roles']               ?? [],
            'sophistication'    => $obj['sophistication']      ?? null,
            'resourceLevel'     => $obj['resource_level']      ?? null,
            'primaryMotivation' => $obj['primary_motivation']  ?? null,
            'malwareTypes'      => $obj['malware_types']       ?? [],
            'isFamily'          => $obj['is_family']           ?? false,
            'aliases'           => $obj['aliases']             ?? [],
            'refs'              => $refs,
        ];
    }

    return ['total' => count($normalized), 'objects' => $normalized, 'more' => $data['more'] ?? false];
}

/**
 * Shared curl helper for E-ISAC requests.
 * Returns [http_status, body_string, content_type, error_string|null].
 */
function eisac_curl(string $url, string $auth_header, string $accept): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => false,
        CURLOPT_TIMEOUT_MS     => PROXY_TIMEOUT_MS,
        CURLOPT_HTTPHEADER     => [
            'Authorization: ' . $auth_header,
            'Accept: ' . $accept,
        ],
    ]);

    $body   = curl_exec($ch);
    $errno  = curl_errno($ch);
    $err    = curl_error($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $ct     = curl_getinfo($ch, CURLINFO_CONTENT_TYPE) ?: 'unknown';
    curl_close($ch);

    if ($errno !== CURLE_OK) {
        return [0, '', '', $err ?: 'curl error ' . $errno];
    }
    return [$status, (string) $body, (string) $ct, null];
}
