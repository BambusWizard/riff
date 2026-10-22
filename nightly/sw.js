// Web build only: keeps the app's own files on the phone so the Home Screen app opens without internet.
// build.mjs fills in VERSION and SHELL (every file of this build, with the same ?v= the page asks for).
const VERSION = '7c63f83';
const SHELL = ["index.html","pwa/manifest.webmanifest","pwa/icon-180.png","styles.css?v=7c63f83","mobile.css?v=7c63f83","assets/icon.png","assets/hls.min.js?v=7c63f83","mobile-bridge.js?v=7c63f83","audio-engine.js?v=7c63f83","m3shapes.js?v=7c63f83","lyrics-rtl.js?v=7c63f83","track-sort.js?v=7c63f83","search-text.js?v=7c63f83","library-tools.js?v=7c63f83","app.js?v=7c63f83","mobile-ui.js?v=7c63f83","assets/Tone.js","assets/hls.min.js","pwa/icon-192.png","pwa/icon-512.png"];
const CHANNEL = 'nightly';
// per channel: stable's worker (scope /riff/) must not throw away nightly's files (/riff/nightly/) or back
const PREFIX = `riff-${CHANNEL}-`;
const CACHE = `${PREFIX}${VERSION}`;
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
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('riff-') && k !== CACHE
      && (k.startsWith(PREFIX) || !/^riff-(stable|nightly|local)-/.test(k))).map((k) => caches.delete(k)))) // own old builds + pre-channel caches
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
  if (url.pathname.endsWith('/version.json') || req.headers.has('range')) return;
  if (CHANNEL === 'stable' && url.pathname.includes('/nightly/')) return; // nightly's own worker (or the network) serves it // the update check must always ask the server; media seeks go straight through

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
