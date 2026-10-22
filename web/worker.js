// Cloudflare Worker: the CORS proxy the web build of Riff uses instead of CapacitorHttp.
// The page calls  <worker>/__proxy?url=<target>  with the real request headers JSON-encoded in
// x-fwd-headers (browsers won't let a page set User-Agent and friends itself).
// Only hosts Riff talks to are allowed, only from the origins in ALLOWED_ORIGINS, and only with a
// personal access key (sent by the page in x-riff-key, or ?k= where a header would force a preflight).
// Keys: secret USERS = {"<key>": "<name>", ...}; the older single ACCESS_KEY still works as "main".
//
// Yandex Music answers only Russian IPs, so its hosts are fetched through a Yandex Cloud Function
// (web/ru-relay, secrets RU_RELAY_URL + RELAY_SECRET). The user's Yandex token (secret YANDEX_TOKENS =
// {"<name>": "<token>"}) is added there, so the page never sees it.
//
// /__sync keeps each person's library (likes, playlists, history, settings) in the RIFF_DATA KV
// namespace: GET returns { data, at }, POST stores { data } and returns the new { at }.

const ALLOWED_HOSTS = [
  'youtube.com', 'googlevideo.com', 'ytimg.com', 'ggpht.com', 'googleusercontent.com', 'googleapis.com',
  'soundcloud.com', 'sndcdn.com',
  'apple.com', 'mzstatic.com',
  'deezer.com', 'dzcdn.net',
  'spotify.com', 'scdn.co', 'spotifycdn.com',
  'lrclib.net', 'wikipedia.org', 'wikimedia.org', 'cloudflare-dns.com',
  'yandex.ru', 'yandex.net', // through the Russian relay
];
const hostAllowed = (h) => ALLOWED_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
// only the API and download-info need a Russian IP; the audio files themselves (*.storage.yandex.net)
// are served anywhere and are too big for the relay's response limit, so those go direct
const RELAYED = ['api.music.yandex.net', 'storage.mds.yandex.net', 'music.yandex.ru'];
const isYandex = (h) => RELAYED.includes(h);

function yandexToken(env, user) {
  try { return JSON.parse(env.YANDEX_TOKENS || '{}')[user] || ''; } catch (e) { return ''; }
}

// one hop through the relay; it follows redirects itself, and only to Yandex hosts
function viaRelay(env, user, target, method, headers, body) {
  const fwd = { ...headers };
  const token = target.hostname === 'api.music.yandex.net' && yandexToken(env, user);
  if (token) fwd.Authorization = `OAuth ${token}`;
  return fetch(`${env.RU_RELAY_URL}?url=${encodeURIComponent(target.href)}`, {
    method, body, headers: { 'x-relay-secret': env.RELAY_SECRET || '', 'x-fwd-headers': JSON.stringify(fwd) },
  });
}

// response headers the page must not see or that no longer match the (decoded) body
const DROP = /^(content-encoding|content-length|transfer-encoding|connection|set-cookie|alt-svc|strict-transport-security)$/i;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'x-fwd-headers, x-riff-key, content-type, range',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function userFor(env, key) {
  if (!key) return null;
  let users = {};
  try { users = JSON.parse(env.USERS || '{}'); } catch (e) {}
  if (Object.prototype.hasOwnProperty.call(users, key)) return String(users[key]);
  return env.ACCESS_KEY && key === env.ACCESS_KEY ? 'main' : null;
}

async function sync(req, env, user, origin) {
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors(origin), 'Content-Type': 'application/json' } });
  if (!env.RIFF_DATA) return json({ error: 'storage not configured' }, 500);
  const key = `library:${user}`;
  if (req.method === 'GET') return json((await env.RIFF_DATA.get(key, 'json')) || { data: null, at: 0 });
  if (req.method === 'POST') {
    let data;
    try { data = JSON.parse(await req.text()).data; } catch (e) { return json({ error: 'bad body' }, 400); }
    if (!data || typeof data !== 'object') return json({ error: 'bad body' }, 400);
    const at = Date.now();
    // every overwritten copy is kept for 30 days (backup:<user>:<its time>), so a phone that sends a wrong
    // library can't destroy the old one for good. Restore: copy a backup's value back to library:<user>
    const prev = await env.RIFF_DATA.get(key, 'text');
    if (prev) {
      let prevAt = 0;
      try { prevAt = JSON.parse(prev).at || 0; } catch (e) {}
      await env.RIFF_DATA.put(`backup:${user}:${prevAt || at}`, prev, { expirationTtl: 30 * 24 * 3600 });
    }
    await env.RIFF_DATA.put(key, JSON.stringify({ data, at }));
    return json({ at });
  }
  return json({ error: 'method not allowed' }, 405);
}

export default {
  async fetch(req, env) {
    const origins = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get('origin') || '';
    if (!origins.includes(origin)) return new Response('origin not allowed', { status: 403 });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    const u = new URL(req.url);
    const user = userFor(env, req.headers.get('x-riff-key') || u.searchParams.get('k') || '');
    if (!user) return new Response('access key required', { status: 401, headers: cors(origin) });

    if (u.pathname === '/__sync') return sync(req, env, user, origin);
    if (u.pathname !== '/__proxy') return new Response('not found', { status: 404, headers: cors(origin) });

    let target;
    try { target = new URL(u.searchParams.get('url')); } catch (e) { return new Response('bad url', { status: 400, headers: cors(origin) }); }

    let headers = {};
    try { headers = JSON.parse(req.headers.get('x-fwd-headers') || '{}'); } catch (e) {}
    const range = req.headers.get('range');
    if (range && !headers.range && !headers.Range) headers.range = range;
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer();

    // follow redirects by hand so every hop is checked against the allow list
    let r;
    for (let hop = 0; hop < 6; hop++) {
      if (target.protocol !== 'https:' || !hostAllowed(target.hostname)) {
        return new Response(`host not allowed: ${target.hostname}`, { status: 403, headers: cors(origin) });
      }
      r = isYandex(target.hostname) && env.RU_RELAY_URL
        ? await viaRelay(env, user, target, req.method, headers, body)
        : await fetch(target.href, { method: req.method, headers, body, redirect: 'manual' });
      const loc = r.status >= 300 && r.status < 400 && r.headers.get('location');
      if (!loc) break;
      target = new URL(loc, target);
    }

    const out = new Headers(cors(origin));
    r.headers.forEach((v, k) => { if (!DROP.test(k)) out.set(k, v); });
    return new Response(r.body, { status: r.status, headers: out });
  },
};
