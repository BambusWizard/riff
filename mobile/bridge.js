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
// The Worker wants an access key; it is asked for once and kept in this browser.
const KEY_STORE = 'riff_proxy_key';
let keyPrompt = null;
let keyDeclined = false; // Cancel stops the asking until the next launch
const storedKey = () => { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } };
function proxyKey(again) {
  if (!RIFF_PROXY_URL || keyDeclined) return Promise.resolve('');
  const key = again ? '' : storedKey();
  if (key) return Promise.resolve(key);
  // several requests can fail at once; ask only one time
  if (!keyPrompt) {
    keyPrompt = new Promise((resolve) => setTimeout(() => {
      const entered = (window.prompt(again ? 'Wrong access key. Enter the Riff access key:' : 'Enter the Riff access key:') || '').trim();
      try { if (entered) localStorage.setItem(KEY_STORE, entered); else localStorage.removeItem(KEY_STORE); } catch (e) {}
      keyDeclined = !entered;
      keyPrompt = null;
      resolve(entered);
      if (entered) setTimeout(() => { if (typeof syncPull === 'function') syncPull(); }, 0); // a new key may come with a library
    }, 0));
  }
  return keyPrompt;
}
globalThis.__riffFetch = async (input, init) => {
  const [url, opts] = await toPlain(input, init);
  if (Capacitor.isNativePlatform()) return pageFetch(url, opts);
  const { headers, ...rest } = opts;
  const send = (key) => pageFetch(`${PROXY}?url=${encodeURIComponent(url)}`, { ...rest, headers: { 'x-fwd-headers': JSON.stringify(headers || {}), ...(key ? { 'x-riff-key': key } : {}) } });
  const used = await proxyKey(false);
  let r = await send(used);
  if (r.status === 401 && RIFF_PROXY_URL) {
    // another request may already have asked for a new key in the meantime
    const current = storedKey();
    r = await send(current && current !== used ? current : await proxyKey(true));
  }
  return r;
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
      if (!v.startsWith(BASE)) { endSilence(this); this.__riffSrc = undefined; this.__riffPending = null; desc.set.call(this, v); return; }
      this.__riffSrc = v;
      this.__riffPending = resolveLocalUrl(v)
        .then((real) => { if (this.__riffSrc === v) { endSilence(this); desc.set.call(this, real); } })
        .catch((e) => { console.warn('[riff]', e.message); if (this.__riffSrc === v) this.dispatchEvent(new Event('error')); });
    },
  });
}
const realSrc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src'); // the unpatched setter
patchSrc(HTMLMediaElement.prototype);
patchSrc(HTMLImageElement.prototype);

const realPlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function () {
  return this.__riffPending ? this.__riffPending.then(() => realPlay.call(this)) : realPlay.call(this);
};

// iOS suspends a page in the background within seconds of its audio stopping, so a song switched from the
// lock screen never finished downloading. While a song loads, the player itself keeps playing a silent loop:
// iOS sees one uninterrupted playback (a second <audio> confused its lock screen), and the app sees none of
// it, since the loop's events and times are hidden until the real song's file is set.
function silentWavUrl() {
  const rate = 8000, n = rate; // one second, 8-bit mono
  const b = new Uint8Array(44 + n);
  const v = new DataView(b.buffer);
  const str = (o, t) => [...t].forEach((c, i) => { b[o + i] = c.charCodeAt(0); });
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true); b.fill(128, 44);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
const SILENT = silentWavUrl();
const MEDIA_EVENTS = ['loadstart', 'progress', 'suspend', 'abort', 'error', 'emptied', 'stalled', 'loadedmetadata', 'loadeddata',
  'canplay', 'canplaythrough', 'playing', 'waiting', 'seeking', 'seeked', 'ended', 'durationchange', 'timeupdate', 'play', 'pause', 'ratechange'];
// media events don't bubble but do pass the capture phase, so stopping them at window keeps them from the element's listeners
for (const t of MEDIA_EVENTS) window.addEventListener(t, (e) => { if (e.target && e.target.__riffSilent) e.stopImmediatePropagation(); }, true);
for (const prop of ['currentTime', 'duration']) {
  const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, prop);
  Object.defineProperty(HTMLMediaElement.prototype, prop, {
    configurable: true,
    get() { return this.__riffSilent ? (prop === 'duration' ? NaN : 0) : d.get.call(this); },
    set: d.set,
  });
}
function endSilence(audio) {
  if (!audio.__riffSilent) return;
  audio.loop = false;
  audio.__riffSilent = false;
}
window.__riffKeepAlive = {
  start(audio) {
    audio.__riffSilent = true;
    audio.loop = true;
    realSrc.set.call(audio, SILENT);
    realPlay.call(audio).catch(() => {});
  },
  stop(audio) {
    if (!audio.__riffSilent) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    endSilence(audio);
  },
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

const audioBusy = () => [...document.querySelectorAll('audio')].some((a) => !a.paused);

// ---- web build: library sync. Likes, playlists, history and settings follow the personal key ----
// It is everything app.js keeps under devsize_* / riff_* in localStorage, minus what belongs to one device.
const SYNC_META = 'riff_sync_meta'; // { at: server time of the copy we hold, dirty: changes not sent yet }
const DEVICE_ONLY = /^(riff_proxy_key|riff_sync_meta|riff_debug_log|riff_bg_url|riff_bg_vpath|riff_banner_media|riff_cache_limit_mb|riff_right_panel_width|riff_queue_state|riff_volume|riff_muted|riff_settings_cat|riff_home_pane|riff_search_pos|riff_font_scale|riff_perf_mode|devsize_ui_scale)$/;
const synced = (k) => /^(devsize_|riff_)/.test(k) && !DEVICE_ONLY.test(k);
let syncPull = null;
if (!Capacitor.isNativePlatform() && RIFF_PROXY_URL) {
  const SYNC_URL = `${RIFF_PROXY_URL}/__sync`;
  const rawSet = Storage.prototype.setItem;
  const rawRemove = Storage.prototype.removeItem;
  const readMeta = () => { try { return JSON.parse(localStorage.getItem(SYNC_META)) || { at: 0, dirty: false }; } catch (e) { return { at: 0, dirty: false }; } };
  const writeMeta = (m) => { try { rawSet.call(localStorage, SYNC_META, JSON.stringify(m)); } catch (e) {} };
  const snapshot = () => {
    const d = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (synced(k)) d[k] = localStorage.getItem(k); }
    return d;
  };

  let pushTimer = null;
  const push = async () => {
    clearTimeout(pushTimer);
    pushTimer = null;
    const key = storedKey();
    if (!key) return;
    const body = JSON.stringify({ data: snapshot() });
    try {
      // text/plain with the key in the URL is a "simple" request (no preflight), so it can use keepalive
      // and still go out while the app is being closed; keepalive bodies are capped at 64 KB
      const r = await pageFetch(`${SYNC_URL}?k=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, keepalive: body.length < 60000 });
      if (r.ok) writeMeta({ at: (await r.json()).at, dirty: false });
    } catch (e) { console.warn('[sync] upload failed', e.message); }
  };

  // changes made before the first download are app.js start-up defaults; they must not overwrite the
  // library stored online, so they are only sent if there is nothing online yet
  let ready = false;
  let applying = false;
  const changed = () => {
    if (!ready || applying) return;
    const m = readMeta();
    if (!m.dirty) writeMeta({ ...m, dirty: true });
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 5000);
  };
  Storage.prototype.setItem = function (k, v) { rawSet.call(this, k, v); if (this === localStorage && synced(k)) changed(); };
  Storage.prototype.removeItem = function (k) { rawRemove.call(this, k); if (this === localStorage && synced(k)) changed(); };

  let pendingRemote = null;
  const applyRemote = () => {
    if (!pendingRemote || audioBusy()) return; // never cut a song off; retried on the next pause
    const { data, at } = pendingRemote;
    pendingRemote = null;
    applying = true;
    for (const k of Object.keys(snapshot())) if (!(k in data)) rawRemove.call(localStorage, k);
    for (const [k, v] of Object.entries(data)) if (synced(k)) rawSet.call(localStorage, k, v);
    writeMeta({ at, dirty: false });
    location.reload(); // app.js holds the old library in memory
  };

  syncPull = async () => {
    const key = storedKey();
    if (!key) return;
    let remote;
    try {
      const r = await pageFetch(SYNC_URL, { headers: { 'x-riff-key': key }, cache: 'no-store' });
      if (!r.ok) return;
      remote = await r.json();
    } catch (e) { console.warn('[sync] download failed', e.message); return; }
    const m = readMeta();
    ready = true;
    const empty = !remote.data || !Object.keys(remote.data).length;
    // nothing online yet, or local changes not sent: this device's copy wins (last change wins)
    if (empty || m.dirty) { push(); return; }
    if (remote.at !== m.at) { pendingRemote = remote; applyRemote(); }
  };

  syncPull();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (pushTimer) push(); } else syncPull();
  });
  document.addEventListener('pause', applyRemote, true); // media events don't bubble
}

// ---- web build: pick up a new deploy without reinstalling the Home Screen app ----
// (removing the app from the Home Screen also wipes its likes, playlists and access key)
if (!Capacitor.isNativePlatform()) {
  // "build abc1234" next to the logo: shows at a glance whether the phone runs the latest deploy
  const logo = document.querySelector('.app-logo');
  if (logo) {
    const tag = document.createElement('span');
    tag.className = 'logo-build';
    tag.textContent = `build ${RIFF_VERSION}`;
    logo.appendChild(tag);
  }
  // sw.js keeps this build's files on the phone, so the Home Screen app also opens without internet
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[sw]', e.message));
  const TRIED = 'riff_update_tried';
  let pending = null;
  const apply = () => {
    if (!pending || audioBusy()) return; // never cut a song off; retried on the next pause
    try {
      // a CDN that still serves the old page would loop us; try each version once per session
      if (sessionStorage.getItem(TRIED) === pending) return;
      sessionStorage.setItem(TRIED, pending);
    } catch (e) {}
    location.replace(`${location.pathname}?v=${pending}`); // new URL, so the page itself isn't taken from cache
  };
  const check = async () => {
    try {
      const { version } = await (await pageFetch(`version.json?t=${Date.now()}`, { cache: 'no-store' })).json();
      if (version && version !== RIFF_VERSION) { pending = version; apply(); }
    } catch (e) {}
  };
  // the page and its scripts come from different builds (a page the browser kept + scripts it didn't):
  // load the page again right away instead of running a mixed-up UI until the next check
  const pageBuild = document.querySelector('meta[name="riff-build"]');
  if (!pageBuild || pageBuild.content !== RIFF_VERSION) { pending = RIFF_VERSION; apply(); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  document.addEventListener('pause', apply, true); // media events don't bubble
  setInterval(check, 15 * 60 * 1000);
  setTimeout(check, 5000);
}
