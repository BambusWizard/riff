// Runs Riff's own server.js inside the iOS app and makes app.js think it is talking to the
// desktop backend on 127.0.0.1. Loaded before app.js.
const { Capacitor } = require('@capacitor/core');
const store = require('./shims/store');
const http = require('./shims/http');
const fs = require('./shims/fs');
const electronAPI = require('./electron-api');

// ---- error log ("Fehlerlog teilen" in Settings): last 300 warnings/errors, kept across restarts ----
const LOG_KEY = 'riff_debug_log';
const logLines = (() => { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { return []; } })();
let logSaveTimer = null;
function riffLog(level, msg) {
  logLines.push(`${new Date().toISOString()} ${level.toUpperCase()} ${String(msg).slice(0, 500)}`);
  if (logLines.length > 300) logLines.splice(0, logLines.length - 300);
  clearTimeout(logSaveTimer);
  logSaveTimer = setTimeout(() => { try { localStorage.setItem(LOG_KEY, JSON.stringify(logLines)); } catch (e) {} }, 500);
}
for (const level of ['warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => { riffLog(level, args.map((a) => (a && a.stack) || (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')); orig(...args); };
}
window.addEventListener('error', (e) => riffLog('error', `${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => riffLog('error', `unhandled: ${(e.reason && (e.reason.stack || e.reason.message)) || e.reason}`));
window.RiffLog = {
  add: riffLog,
  text: () => [`Riff ${navigator.userAgent}`, `platform: ${Capacitor.getPlatform()}`, ...logLines].join('\n'),
  clear: () => { logLines.length = 0; try { localStorage.removeItem(LOG_KEY); } catch (e) {} },
};

const PORT = 38472;
const BASE = `http://127.0.0.1:${PORT}/`;
const MIME = { '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.opus': 'audio/ogg', '.webm': 'audio/webm', '.flac': 'audio/flac', '.wav': 'audio/wav', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
const mimeOf = (p) => MIME[(p.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()];

// ---- outbound HTTP without CORS ----
// In the app, CapacitorHttp has already replaced window.fetch with native networking.
// In a browser they go through a /__proxy: the dev server's, or the Cloudflare Worker in web/ for the
// GitHub Pages build (RIFF_PROXY_URL at build time).
const PROXY = `${RIFF_PROXY_URL}/__proxy`;
const pageFetch = window.fetch.bind(window);
const plainHeaders = (h) => (h instanceof Headers ? Object.fromEntries(h.entries()) : { ...(h || {}) });
async function toPlain(input, init = {}) {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    // A Request silently drops "forbidden" headers like User-Agent; youtubei.js passes the real
    // ones (its client User-Agent included) in `init`, so those win.
    const body = init.body !== undefined ? init.body : ['GET', 'HEAD'].includes(input.method) ? undefined : await input.clone().text();
    return [input.url, { method: init.method || input.method, headers: { ...plainHeaders(input.headers), ...plainHeaders(init.headers) }, body, signal: init.signal || input.signal }];
  }
  return [String(input), { ...init, headers: plainHeaders(init.headers) }];
}
globalThis.__riffFetch = async (input, init) => {
  const [url, opts] = await toPlain(input, init);
  if (Capacitor.isNativePlatform()) return pageFetch(url, opts);
  const { headers, ...rest } = opts;
  return pageFetch(`${PROXY}?url=${encodeURIComponent(url)}`, { ...rest, headers: { 'x-fwd-headers': JSON.stringify(headers || {}) } });
};

// ---- the in-app "server" ----
let ready;
let server = null;
async function start() {
  await fs.init();
  server = require('../server.js');
  server.startServer(PORT);
}

function call(url, init = {}) {
  return ready.then(() => http.dispatch({
    url: url.slice(BASE.length - 1),
    method: init.method || 'GET',
    // there's no socket to protect in-app, but server.js checks its CSRF token, so every call carries it
    headers: { ...(init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : (init.headers || {})), 'x-riff-token': server.getServerToken() },
    body: typeof init.body === 'string' ? init.body : '',
  }));
}

const fileUrls = new Map();
async function fileUrlFor(vpath) {
  if (!fileUrls.has(vpath)) {
    await fs._flush(); // a just-written file must reach disk before the WebView reads it
    fileUrls.set(vpath, store.fileUrl(vpath, mimeOf(vpath)));
  }
  return fileUrls.get(vpath);
}

// Turns an app.js URL like http://127.0.0.1:38472/api/local-track?id=x into something the WebView can load.
async function resolveLocalUrl(u) {
  const r = await call(u);
  if (r.file) return fileUrlFor(r.file);
  throw new Error(`no file behind ${u} (${r.status})`);
}

window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input && input.url;
  if (!url || !url.startsWith(BASE)) return pageFetch(input, init);
  let r = await call(url, init);
  // loading a song can fail on a passing YouTube/network hiccup; one quiet retry fixes most of them
  if (r.status >= 500 && url.includes('/api/stream-info')) {
    riffLog('warn', `stream-info failed (${r.status}), retrying: ${r.body.slice(0, 120)}`);
    await new Promise((res) => setTimeout(res, 1200));
    r = await call(url, init);
  }
  if (r.file) return pageFetch(await fileUrlFor(r.file));
  return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
};

// <audio src> and <img src> pointing at the local server get swapped for real file URLs.
function patchSrc(proto) {
  const desc = Object.getOwnPropertyDescriptor(proto, 'src');
  Object.defineProperty(proto, 'src', {
    configurable: true,
    get() { return this.__riffSrc !== undefined ? this.__riffSrc : desc.get.call(this); },
    set(v) {
      v = String(v);
      if (!v.startsWith(BASE)) { this.__riffSrc = undefined; this.__riffPending = null; desc.set.call(this, v); return; }
      this.__riffSrc = v;
      this.__riffPending = resolveLocalUrl(v)
        .then((real) => { if (this.__riffSrc === v) desc.set.call(this, real); })
        .catch((e) => { console.warn('[riff]', e.message); if (this.__riffSrc === v) this.dispatchEvent(new Event('error')); });
    },
  });
}
patchSrc(HTMLMediaElement.prototype);
patchSrc(HTMLImageElement.prototype);

const realPlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function () {
  return this.__riffPending ? this.__riffPending.then(() => realPlay.call(this)) : realPlay.call(this);
};

// <img src="..."> written as HTML strings never hit the setter above.
new MutationObserver((muts) => {
  for (const m of muts) {
    const nodes = m.type === 'attributes' ? [m.target] : [...m.addedNodes].flatMap((n) => (n.querySelectorAll ? [n, ...n.querySelectorAll('img')] : []));
    for (const n of nodes) {
      if (n.tagName === 'IMG' && n.__riffSrc === undefined) {
        const raw = n.getAttribute('src') || '';
        if (raw.startsWith(BASE)) n.src = raw;
      }
    }
  }
}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });

// Android hardware back: close whatever is on top instead of quitting the app.
// On Home it backgrounds the app (music keeps playing) rather than closing it.
if (Capacitor.getPlatform() === 'android') {
  const { App } = require('@capacitor/app');
  const visible = (el) => el && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none';
  App.addListener('backButton', () => {
    const modal = [...document.querySelectorAll('.modal-backdrop')].reverse().find((m) => visible(m) && m.classList.contains('visible'));
    if (modal) {
      const closeBtn = modal.querySelector('[id^="btn-close"], [id^="btn-cancel"], .modal-close');
      if (closeBtn) closeBtn.click(); else modal.click();
      return;
    }
    const tv = document.getElementById('tv-karaoke');
    if (visible(tv)) { document.getElementById('btn-close-tv-karaoke').click(); return; }
    const drawer = document.getElementById('rail-drawer');
    if (visible(drawer)) { document.getElementById('btn-close-rail-drawer').click(); return; }
    if (document.body.classList.contains('np-open')) { document.getElementById('btn-close-right-panel').click(); return; }
    const home = document.getElementById('nav-discover');
    if (home && !home.classList.contains('active')) { home.click(); return; }
    App.minimizeApp();
  });
}

ready = start();
window.electronAPI = electronAPI({ ready, port: PORT, fs, fileUrlFor });
document.documentElement.classList.add('is-mobile');
