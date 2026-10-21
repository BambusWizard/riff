// Cloudflare Worker: the CORS proxy the web build of Riff uses instead of CapacitorHttp.
// The page calls  <worker>/__proxy?url=<target>  with the real request headers JSON-encoded in
// x-fwd-headers (browsers won't let a page set User-Agent and friends itself).
// Only hosts Riff talks to are allowed, and only from the origins in ALLOWED_ORIGINS.

const ALLOWED_HOSTS = [
  'youtube.com', 'googlevideo.com', 'ytimg.com', 'ggpht.com', 'googleusercontent.com', 'googleapis.com',
  'soundcloud.com', 'sndcdn.com',
  'apple.com', 'mzstatic.com',
  'deezer.com', 'dzcdn.net',
  'spotify.com', 'scdn.co', 'spotifycdn.com',
  'lrclib.net', 'wikipedia.org', 'wikimedia.org', 'cloudflare-dns.com',
];
const hostAllowed = (h) => ALLOWED_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));

// response headers the page must not see or that no longer match the (decoded) body
const DROP = /^(content-encoding|content-length|transfer-encoding|connection|set-cookie|alt-svc|strict-transport-security)$/i;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'x-fwd-headers, content-type, range',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(req, env) {
    const origins = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get('origin') || '';
    if (!origins.includes(origin)) return new Response('origin not allowed', { status: 403 });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    const u = new URL(req.url);
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
      r = await fetch(target.href, { method: req.method, headers, body, redirect: 'manual' });
      const loc = r.status >= 300 && r.status < 400 && r.headers.get('location');
      if (!loc) break;
      target = new URL(loc, target);
    }

    const out = new Headers(cors(origin));
    r.headers.forEach((v, k) => { if (!DROP.test(k)) out.set(k, v); });
    return new Response(r.body, { status: r.status, headers: out });
  },
};
