// Song library (library/service.js on the PC): this phone reports every song it played to the end (90%+) or
// liked, and the PC keeps a copy with our metadata. The PC is on only sometimes, so the reports wait in a queue
// that survives restarts; while a song waits, cache-limit.js keeps its file (the PC may need it: a song it can't
// download itself is sent from here). The phone's own cache is never cleared by this.
//
// The PC is found through the worker (/__library: its current tunnel address and this person's library key);
// for development riff_library_url / riff_library_key in localStorage point straight at a service.

const QUEUE = 'riff_library_queue'; // device only (bridge.js DEVICE_ONLY)
const NAMES = 'riff_library_names'; // device only: our names for the songs the library knows, by "platform:id"
const CATALOG = '/data/library/catalog.json';
const TRACKS = '/data/tracks';
const MAX_AGE = 60 * 24 * 3600 * 1000; // a song nobody can get to the PC is dropped from the queue after 60 days
const LISTS = ['devsize_favorites', 'devsize_history', 'devsize_playlists'];

// Songs in likes, history and playlists carry the library's names and cover instead of the upload's ("Lida - Song"
// by "minecrafter" becomes "Song" by "Lida"). bridge.js runs this at start, before app.js reads the lists; a
// renamed list is saved like any other change, so the sync takes it along
function renameTrack(t, names) {
  const n = t && names[`${t.platform}:${t.id}`];
  if (!n) return false;
  let changed = false;
  for (const [k, v] of [['title', n.title], ['artist', n.artist], ['thumbnail', n.cover]]) {
    if (v && t[k] !== v) { t[k] = v; changed = true; }
  }
  return changed;
}
function applyNames() {
  let names;
  try { names = JSON.parse(localStorage.getItem(NAMES) || '{}'); } catch (e) { return; }
  if (!Object.keys(names).length) return;
  for (const key of LISTS) {
    let list;
    try { list = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { continue; }
    if (!Array.isArray(list)) continue;
    let changed = false;
    for (const x of list) {
      if (x && Array.isArray(x.tracks)) { for (const t of x.tracks) changed = renameTrack(t, names) || changed; } // a playlist
      else changed = renameTrack(x, names) || changed;
    }
    if (changed) localStorage.setItem(key, JSON.stringify(list));
  }
}

// a search's words in a song's names (any order, no case, accents or punctuation)
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

module.exports = function librarySync({ fs, pageFetch, proxyUrl, accessKey, fileUrlFor, log }) {
  const cleanId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_'); // server.js cleanTrackId
  const keyOf = (t) => `${t.platform}:${t.id}`;
  const readQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE)) || []; } catch (e) { return []; } };
  const writeQueue = (q) => { try { localStorage.setItem(QUEUE, JSON.stringify(q)); } catch (e) {} };
  const status = { state: 'idle', songs: 0, waiting: readQueue().length, at: 0, error: '' };
  const announce = () => window.dispatchEvent(new CustomEvent('riff:library', { detail: { ...status } }));

  const add = (t, reason) => {
    if (!t || !t.id || !t.platform || t.platform === 'local') return;
    const q = readQueue();
    const k = keyOf(t);
    const have = q.find((x) => keyOf(x) === k);
    if (have) { if (reason === 'liked') have.reason = 'liked'; writeQueue(q); return; }
    q.push({
      platform: t.platform, id: String(t.id), url: t.url || '', title: t.title || '', artist: t.artist || '',
      duration: Number(t.duration) || 0, thumbnail: t.thumbnail || '', reason, at: Date.now(),
    });
    writeQueue(q);
    status.waiting = q.length;
    announce();
    soon();
  };

  // ---- what goes in: played to 90% (or to the end), or liked here ----
  const audio = document.getElementById('native-audio');
  let reported = '';
  const current = () => (window.RiffCore && window.RiffCore.state && window.RiffCore.state.currentTrack) || null;
  const check = (ended) => {
    const t = current();
    if (!t || audio.__riffHold || audio.__riffSilent) return;
    const d = audio.duration;
    if (!ended && !(d > 30 && audio.currentTime / d >= 0.9)) return;
    if (reported === keyOf(t)) return;
    reported = keyOf(t);
    add(t, 'finished');
  };
  if (audio) {
    audio.addEventListener('timeupdate', () => check(false));
    audio.addEventListener('ended', () => check(true));
    audio.addEventListener('emptied', () => { reported = ''; }); // the next song (or this one again later)
  }
  // likes made on this phone (the other phone reports its own; a library pulled from the sync isn't a new like)
  const FAV = 'devsize_favorites';
  const ids = (v) => { try { return new Set((JSON.parse(v) || []).map((t) => t && `${t.platform}:${t.id}`)); } catch (e) { return new Set(); } };
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    if (this === localStorage && k === FAV) {
      const before = ids(localStorage.getItem(FAV));
      try { for (const t of JSON.parse(v) || []) if (t && !before.has(`${t.platform}:${t.id}`)) add(t, 'liked'); } catch (e) {}
    }
    return setItem.call(this, k, v);
  };

  // ---- talking to the PC ----
  let endpoint = null;
  const findPc = async () => {
    const url = localStorage.getItem('riff_library_url');
    if (url) return { url: url.replace(/\/+$/, ''), key: localStorage.getItem('riff_library_key') || '' };
    if (endpoint && Date.now() - endpoint.checked < 5 * 60 * 1000) return endpoint.url ? endpoint : null;
    const key = accessKey();
    if (!proxyUrl || !key) return null;
    const r = await pageFetch(`${proxyUrl}/__library`, { headers: { 'x-riff-key': key }, cache: 'no-store' });
    if (!r.ok) throw new Error(`worker ${r.status}`);
    const ep = await r.json();
    endpoint = { url: (ep.url || '').replace(/\/+$/, ''), key: ep.key || '', checked: Date.now() };
    return endpoint.url ? endpoint : null;
  };
  const call = async (pc, p, init = {}, ms = 15000) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await pageFetch(pc.url + p, { ...init, signal: ctl.signal, headers: { 'x-riff-key': pc.key, ...(init.headers || {}) } });
      if (!r.ok) throw new Error(`${p.split('?')[0]}: ${r.status}`);
      return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
    } finally { clearTimeout(timer); }
  };
  const localFile = (item) => {
    const base = `${cleanId(item.id)}.`;
    try {
      const name = fs.readdirSync(TRACKS).find((n) => n.startsWith(base) && !n.includes('.temp.'));
      return name ? `${TRACKS}/${name}` : null;
    } catch (e) { return null; }
  };
  const upload = async (pc, songId, file) => {
    const blob = await (await pageFetch(await fileUrlFor(file))).blob();
    const ext = file.slice(file.lastIndexOf('.') + 1);
    await call(pc, `/songs/${songId}/file?ext=${encodeURIComponent(ext)}`, { method: 'PUT', body: blob }, 120000);
  };

  // ---- the catalog: our names, and which songs the PC can play ----
  let bySource = new Map();
  let lastPc = null; // the PC as of the last successful sync
  const useCatalog = (c) => {
    bySource = new Map();
    const names = {};
    for (const song of c.songs) {
      for (const k of song.sources) {
        bySource.set(k, song);
        if (song.named) names[k] = { title: song.title, artist: song.artist, cover: song.cover };
      }
    }
    status.songs = c.songs.length;
    const json = JSON.stringify(names);
    if (localStorage.getItem(NAMES) !== json) { localStorage.setItem(NAMES, json); applyNames(); }
  };
  const pcOnline = () => lastPc && status.state === 'online' && Date.now() - status.at < 5 * 60 * 1000;

  let running = false;
  const run = async () => {
    if (running || document.hidden) return;
    running = true;
    try {
      const pc = await findPc().catch((e) => { status.error = e.message; return null; });
      if (!pc) { status.state = endpoint ? 'offline' : 'not-set-up'; return; }
      try { await call(pc, '/status', {}, 6000); } catch (e) { status.state = 'offline'; endpoint = null; return; } // PC off: ask the worker again next time
      status.state = 'syncing';
      announce();
      for (const item of readQueue()) {
        let done = false;
        try {
          const r = await call(pc, '/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) });
          if (r.status === 'ready') done = true;
          else if (r.needFile) {
            const file = localFile(item);
            if (file) { await upload(pc, r.id, file); done = true; log(`library: sent ${item.artist} - ${item.title}`); }
          }
          // pending: the PC is downloading it itself; it stays here (and its file stays cached) until it is in
        } catch (e) { status.error = e.message; continue; }
        if (done || Date.now() - item.at > MAX_AGE) writeQueue(readQueue().filter((x) => keyOf(x) !== keyOf(item)));
      }
      const catalog = await call(pc, '/catalog', {}, 30000);
      fs.mkdirSync('/data/library', { recursive: true });
      fs.writeFileSync(CATALOG, JSON.stringify(catalog));
      useCatalog(catalog);
      lastPc = pc;
      Object.assign(status, { state: 'online', at: Date.now(), error: '' });
    } catch (e) {
      status.state = 'offline';
      status.error = e.message;
    } finally {
      status.waiting = readQueue().length;
      running = false;
      announce();
    }
  };
  let soonTimer = null;
  const soon = () => { clearTimeout(soonTimer); soonTimer = setTimeout(run, 5000); };

  setTimeout(run, 8000);
  setInterval(run, 3 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) soon(); });

  try { useCatalog(JSON.parse(fs.readFileSync(CATALOG, 'utf8'))); } catch (e) {}

  // ---- playing: the phone's own copy first, then the PC's, then the service (bridge.js asks before stream-info) ----
  const streamFor = (url) => {
    if (!url.includes('/api/stream-info') || !pcOnline()) return null;
    const q = new URL(url).searchParams;
    const song = bySource.get(`${q.get('platform') || 'youtube'}:${q.get('id')}`);
    if (!song || !song.ready || localFile({ id: q.get('id') })) return null;
    log(`library: playing ${song.artist} - ${song.title} from the PC`);
    const body = JSON.stringify({ success: true, isLocal: false, streamUrl: `${lastPc.url}/songs/${song.id}/file?k=${encodeURIComponent(lastPc.key)}` });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  // ---- searching: songs the library knows get its names, and library songs that match come first ----
  const asTrack = (song) => {
    const [platform, id] = song.sources[0].split(/:(.*)/);
    return {
      id, platform, url: song.url || (platform === 'youtube' ? `https://www.youtube.com/watch?v=${id}` : ''),
      title: song.title, artist: song.artist, duration: song.duration, thumbnail: song.cover, inLibrary: true,
    };
  };
  const searchResults = (url, body) => {
    if (!url.includes('/api/search') || !bySource.size) return body;
    let data;
    try { data = JSON.parse(body); } catch (e) { return body; }
    if (!data || !data.success || !Array.isArray(data.tracks)) return body;
    const names = {};
    for (const [k, song] of bySource) if (song.named) names[k] = { title: song.title, artist: song.artist, cover: song.cover };
    for (const t of data.tracks) { renameTrack(t, names); if (bySource.has(keyOf(t))) t.inLibrary = true; }
    const q = new URL(url).searchParams;
    if (Number(q.get('limit')) >= 20) { // the search screen, not the app's own one-song lookups
      const want = words(q.get('q'));
      const shown = new Set(data.tracks.map(keyOf));
      const seen = new Set();
      const hits = [];
      for (const song of bySource.values()) {
        if (seen.has(song.id)) continue;
        seen.add(song.id);
        const have = new Set(words(`${song.artist} ${song.title} ${song.album}`));
        if (want.length && want.every((w) => [...have].some((h) => h.startsWith(w))) && !song.sources.some((k) => shown.has(k))) hits.push(asTrack(song));
      }
      data.tracks = [...hits.slice(0, 5), ...data.tracks];
    }
    return JSON.stringify(data);
  };

  return {
    streamFor,
    searchResults,
    status: () => ({ ...status }),
    run,
    // cleanIds of songs whose files must stay until the PC has them (cache-limit.js)
    keep: () => new Set(readQueue().map((x) => cleanId(x.id))),
    catalog: () => { try { return JSON.parse(fs.readFileSync(CATALOG, 'utf8')); } catch (e) { return null; } },
  };
};
module.exports.applyNames = applyNames;
