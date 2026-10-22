// Web build only: keeps the app's own files on the phone so the Home Screen app opens without internet.
// build.mjs fills in VERSION and SHELL (every file of this build, with the same ?v= the page asks for).
const VERSION = '73a31de';
const SHELL = ["index.html","pwa/manifest.webmanifest","pwa/icon-180.png","styles.css?v=73a31de","mobile.css?v=73a31de","assets/icon.png","assets/hls.min.js?v=73a31de","mobile-bridge.js?v=73a31de","audio-engine.js?v=73a31de","m3shapes.js?v=73a31de","lyrics-rtl.js?v=73a31de","track-sort.js?v=73a31de","search-text.js?v=73a31de","library-tools.js?v=73a31de","app.js?v=73a31de","mobile-ui.js?v=73a31de","assets/Tone.js","assets/hls.min.js","pwa/icon-192.png","pwa/icon-512.png"];
const CACHE = `riff-${VERSION}`;
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com$/;
// covers (YouTube, SoundCloud, Yandex...) are kept across versions, so downloaded songs show them offline.
// Colour extraction loads covers with CORS, plain <img> without; the two answers can't stand in for each other
const COVERS = 'covers';
const COVERS_CORS = 'covers-cors';
const MAX_COVERS = 1500;

self.addEventListener('install', (e) => {
  // the page is fetched as index.html?v=VERSION: without the query the CDN may still hand out the previous build's page
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map(async (u) => {
    const r = await fetch(new Request(u === 'index.html' ? `index.html?v=${VERSION}` : u, { cache: 'reload' }));
    if (!r.ok) throw new Error(`${u}: ${r.status}`);
    await c.put(u, r);
  }))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('riff-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// the network gets a few seconds; on a bad connection the saved copy opens instead of a blank screen
const fromNetwork = (req, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), ms);
  fetch(req).then((r) => { clearTimeout(t); resolve(r); }, (err) => { clearTimeout(t); reject(err); });
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'GET' && req.destination === 'image' && url.origin !== location.origin && url.protocol === 'https:') {
    e.respondWith(cover(req));
    return;
  }
  const fonts = FONTS.test(url.origin);
  if (req.method !== 'GET' || (url.origin !== location.origin && !fonts)) return; // proxy and streams: untouched
  if (url.pathname.endsWith('/version.json') || req.headers.has('range')) return; // the update check must always ask the server; media seeks go straight through

  // the page itself: newest from the network, the saved one when offline. ?v= only busts the browser cache
  if (req.mode === 'navigate') {
    // no-cache: GitHub Pages lets the browser keep the page for 10 minutes, and an old page with new scripts breaks
    e.respondWith(fromNetwork(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }), 4000).catch(() => caches.match('index.html').then((r) => r || Response.error())));
    return;
  }

  // files of this build never change; the rest (fonts, the plugin editor) is saved the first time it is used
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
    if (r.ok || (fonts && r.type === 'opaque')) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return r;
  })));
});

let trimTimer = null;
const trim = (name) => {
  clearTimeout(trimTimer);
  trimTimer = setTimeout(async () => {
    const c = await caches.open(name);
    const keys = await c.keys(); // oldest first
    await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_COVERS)).map((k) => c.delete(k)));
  }, 5000);
};

async function cover(req) {
  const name = req.mode === 'cors' ? COVERS_CORS : COVERS;
  const c = await caches.open(name);
  const hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok || r.type === 'opaque') { c.put(req, r.clone()).then(() => trim(name), () => {}); }
  return r;
}
