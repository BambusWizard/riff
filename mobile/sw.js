// Web build only: keeps the app's own files on the phone so the Home Screen app opens without internet.
// build.mjs fills in VERSION and SHELL (every file of this build, with the same ?v= the page asks for).
const VERSION = '__RIFF_VERSION__';
const SHELL = __RIFF_SHELL__;
const CACHE = `riff-${VERSION}`;
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
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
  const fonts = FONTS.test(url.origin);
  if (req.method !== 'GET' || (url.origin !== location.origin && !fonts)) return; // proxy, streams, covers: untouched
  if (url.pathname.endsWith('/version.json') || req.headers.has('range')) return; // the update check must always ask the server; media seeks go straight through

  // the page itself: newest from the network, the saved one when offline. ?v= only busts the browser cache
  if (req.mode === 'navigate') {
    e.respondWith(fromNetwork(req, 4000).catch(() => caches.match('index.html').then((r) => r || Response.error())));
    return;
  }

  // files of this build never change; the rest (fonts, the plugin editor) is saved the first time it is used
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
    if (r.ok || (fonts && r.type === 'opaque')) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return r;
  })));
});
