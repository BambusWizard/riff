// Song library (library/service.js on the PC): this phone reports every song it played to the end (90%+) or
// liked, and the PC keeps a copy with our metadata. The PC is on only sometimes, so the reports wait in a queue
// that survives restarts; while a song waits, cache-limit.js keeps its file (the PC may need it: a song it can't
// download itself is sent from here). The phone's own cache is never cleared by this.
//
// The PC is found through the worker (/__library: its current tunnel address and this person's library key);
// for development riff_library_url / riff_library_key in localStorage point straight at a service.

const QUEUE = 'riff_library_queue'; // device only (bridge.js DEVICE_ONLY)
const NAMES = 'riff_library_names'; // device only: our names for the songs the library knows, by "platform:id"
const LIKES_QUEUED = 'riff_library_likes_queued'; // device only: this phone's old likes went into the queue
const CATALOG = '/data/library/catalog.json';
const COVER_CACHE = 'library-covers'; // read by sw.js
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
  renameState(names);
}
// later in the session (a new catalog): the app's own copies of the lists too, or its next save would put the
// old names back
function renameState(names) {
  const state = window.RiffCore && window.RiffCore.state;
  if (!state) return;
  for (const list of [state.favorites, state.history]) if (Array.isArray(list)) for (const t of list) renameTrack(t, names);
  if (Array.isArray(state.playlists)) for (const pl of state.playlists) if (pl && Array.isArray(pl.tracks)) for (const t of pl.tracks) renameTrack(t, names);
}

// a search's words in a song's names (any order, no case, accents or punctuation)
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const { artistSimilarity, similarity, parseName } = require('../library/names');
const { enforceCacheLimit } = require('./cache-limit');

// another upload of a song the library already has ("Song (Official Video)" by the artist's channel): the library's
// copy stands for it, so the list doesn't show the song twice
const sameSong = (t, song) => {
  const n = parseName(t.title, t.artist);
  return similarity(n.title, song.title) >= 0.9 && artistSimilarity(n.artist, song.artist) >= 0.85;
};

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
  // A liked YouTube upload gets a real artist and title at once, even with the PC off: "МУККА - Song (Official
  // Video)" by the channel "magic boy" is "Song" by "МУККА" (the library's names, when it has the song)
  const likedName = (t) => {
    let names = {};
    try { names = JSON.parse(localStorage.getItem(NAMES) || '{}'); } catch (e) {}
    let n = names[keyOf(t)];
    if (!n && t.platform === 'youtube') {
      const p = parseName(t.title, t.artist);
      if (p.title && p.artist && (p.title !== t.title || p.artist !== t.artist)) n = { title: p.title, artist: p.artist };
    }
    if (!n) return false;
    const state = window.RiffCore && window.RiffCore.state;
    const mine = state && Array.isArray(state.favorites) && state.favorites.find((f) => f && keyOf(f) === keyOf(t));
    return [t, mine].filter(Boolean).map((x) => renameTrack(x, { [keyOf(t)]: n })).some(Boolean);
  };
  const ids = (v) => { try { return new Set((JSON.parse(v) || []).map((t) => t && `${t.platform}:${t.id}`)); } catch (e) { return new Set(); } };
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    if (this === localStorage && k === FAV) {
      const before = ids(localStorage.getItem(FAV));
      try {
        const list = JSON.parse(v) || [];
        let renamed = false;
        for (const t of list) {
          if (!t || before.has(`${t.platform}:${t.id}`)) continue;
          add(t, 'liked'); // the upload's own names go to the PC, which looks the song up from them
          if (likedName(t)) renamed = true;
        }
        if (renamed) v = JSON.stringify(list);
      } catch (e) {}
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
    if (localStorage.getItem(NAMES) !== json) { localStorage.setItem(NAMES, json); applyNames(); } else renameState(names);
    window.dispatchEvent(new CustomEvent('riff:library-versions')); // the likes list regroups
  };
  const pcOnline = () => lastPc && status.state === 'online' && Date.now() - status.at < 5 * 60 * 1000;

  // The library's covers come from the PC and are kept on the phone under the song's cover address, so sw.js shows
  // them offline and even when that site (Cover Art Archive, iTunes...) can't be reached from here
  const saveCovers = async (pc, catalog) => {
    if (!window.caches) return;
    const c = await caches.open(COVER_CACHE);
    const want = new Map();
    for (const song of catalog.songs) {
      if (!song.coverFile || !/^https:/.test(song.cover || '')) continue;
      try { want.set(new URL(song.cover).href, song); } catch (e) {}
    }
    for (const req of await c.keys()) if (!want.has(req.url)) await c.delete(req);
    for (const [url, song] of want) {
      if (await c.match(url)) continue;
      try {
        const r = await pageFetch(`${pc.url}/songs/${song.id}/cover`, { headers: { 'x-riff-key': pc.key } });
        if (!r.ok) continue;
        await c.put(url, new Response(await r.blob(), { headers: { 'Content-Type': r.headers.get('content-type') || 'image/jpeg' } }));
      } catch (e) {}
    }
  };

  let running = false;
  const uploadFailed = new Set();
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
          // a song from Yandex, SoundCloud...: the file cached here beats what the PC would find on YouTube by name
          const file = localFile(item);
          const hasFile = !!file && item.platform !== 'youtube' && !uploadFailed.has(keyOf(item));
          const r = await call(pc, '/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...item, hasFile }) });
          if (r.needFile && file) {
            // a file the PC refuses (too big, broken) isn't offered again: then the PC gets the song itself
            try { await upload(pc, r.id, file); } catch (e) { uploadFailed.add(keyOf(item)); throw e; }
            done = true;
            log(`library: sent ${item.artist} - ${item.title}`);
          }
          else if (r.status === 'ready') done = true;
          // pending: the PC is downloading it itself; it stays here (and its file stays cached) until it is in
        } catch (e) { status.error = e.message; continue; }
        if (done || Date.now() - item.at > MAX_AGE) writeQueue(readQueue().filter((x) => keyOf(x) !== keyOf(item)));
      }
      const catalog = await call(pc, '/catalog', {}, 30000);
      // songs the PC found on YouTube by name, which this phone has from where they played
      for (const song of catalog.songs) {
        if (!song.guess) continue;
        const own = song.sources.map((k) => k.split(/:(.*)/)).find(([p]) => p !== 'youtube');
        const file = own && !uploadFailed.has(`${own[0]}:${own[1]}`) && localFile({ id: own[1] });
        if (!file) continue;
        try { await upload(pc, song.id, file); song.guess = false; log(`library: sent ${song.artist} - ${song.title}`); } catch (e) { uploadFailed.add(`${own[0]}:${own[1]}`); }
      }
      fs.mkdirSync('/data/library', { recursive: true });
      fs.writeFileSync(CATALOG, JSON.stringify(catalog));
      useCatalog(catalog);
      await saveCovers(pc, catalog);
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

  // likes from before the library existed: queued once per phone (a song already in the library is just "ready")
  if (!localStorage.getItem(LIKES_QUEUED)) {
    try { for (const t of JSON.parse(localStorage.getItem(FAV)) || []) add(t, 'liked'); } catch (e) {}
    localStorage.setItem(LIKES_QUEUED, '1');
  }

  // the catalog may come before the app has read its lists: once it has, they get the names too
  window.addEventListener('riff:ready', () => { applyNames(); window.dispatchEvent(new CustomEvent('riff:library-versions')); });

  setTimeout(run, 8000);
  setInterval(run, 3 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) soon(); });

  try { useCatalog(JSON.parse(fs.readFileSync(CATALOG, 'utf8'))); } catch (e) {}

  // ---- playing: the phone's own copy first, then the PC's, then the service (bridge.js asks before stream-info) ----
  // The phone's copy is wrong when the app had to cache a stand-in (Yandex, a SoundCloud search) because the song's
  // own source failed (server.js marks those), or, for a version like "без цензуры", when it isn't the library's
  // file (cached before the stand-ins were marked): then the PC's copy plays and takes its place in the cache
  const SUBSTITUTES = '/data/cache-substitutes.json';
  const substitutes = () => { try { return JSON.parse(fs.readFileSync(SUBSTITUTES, 'utf8')) || {}; } catch (e) { return {}; } };
  const CACHE_EXT = ['opus', 'webm', 'm4a', 'mp3', 'aac']; // what server.js findCachedFile plays
  const wrongCopy = (song, file, id) => {
    if (substitutes()[cleanId(id)]) return true;
    if (!song.version || !song.size) return false;
    try { return fs.statSync(file).size !== song.size; } catch (e) { return false; }
  };
  const replacing = new Set();
  const replaceCopy = async (song, file, id) => {
    const key = cleanId(id);
    if (replacing.has(key) || !CACHE_EXT.includes(song.format)) return;
    replacing.add(key);
    try {
      const r = await pageFetch(`${lastPc.url}/songs/${song.id}/file?k=${encodeURIComponent(lastPc.key)}`);
      if (!r.ok) throw new Error(`PC ${r.status}`);
      const data = new Uint8Array(await r.arrayBuffer());
      if (data.length !== song.size) throw new Error('broke off');
      if (file) try { fs.unlinkSync(file); } catch (e) {}
      fs.writeFileSync(`${TRACKS}/${key}.${song.format}`, data);
      enforceCacheLimit();
      const subs = substitutes();
      if (subs[key]) { delete subs[key]; try { fs.writeFileSync(SUBSTITUTES, JSON.stringify(subs)); } catch (e) {} }
      log(file ? `library: the cached ${song.artist} - ${song.title} is now the library's copy` : `library: ${song.artist} - ${song.title} kept on the phone`);
    } catch (e) { log(`library: could not replace the cached ${song.title}: ${e.message}`); } finally { replacing.delete(key); }
  };
  const streamFor = (url) => {
    if (!url.includes('/api/stream-info') || !pcOnline()) return null;
    const q = new URL(url).searchParams;
    const song = bySource.get(`${q.get('platform') || 'youtube'}:${q.get('id')}`);
    if (!song || !song.ready) return null;
    const local = localFile({ id: q.get('id') });
    if (local && !wrongCopy(song, local, q.get('id'))) return null;
    // a song heard is kept on the phone like any other (it then plays from here, offline too): the PC's copy is
    // saved while it plays, or replaces a wrong one
    replaceCopy(song, local, q.get('id'));
    log(`library: playing ${song.artist} - ${song.title} from the PC`);
    const body = JSON.stringify({ success: true, isLocal: false, streamUrl: `${lastPc.url}/songs/${song.id}/file?k=${encodeURIComponent(lastPc.key)}` });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  // ---- versions: the library's songs of one group ("Song", "Song (без цензуры)", "Song (Piano)") show as one row.
  // Which one plays is each person's choice (riff_library_versions, synced between their own devices); until they
  // choose: the one they liked, else the uncensored one, else the song itself ----
  const VERSIONS = 'riff_library_versions';
  const UNCENSORED = /без\s*цензуры|без\s*мата|uncensored|нецензур|explicit/i;
  const groupSongs = (group) => {
    const seen = new Set();
    const out = [];
    for (const song of bySource.values()) if (song.group === group && !seen.has(song.id)) { seen.add(song.id); out.push(song); }
    return out;
  };
  const choices = () => { try { return JSON.parse(localStorage.getItem(VERSIONS)) || {}; } catch (e) { return {}; } };
  // the one chosen; else of the liked ones the uncensored one, then any; else the uncensored one, then the song
  // itself. `among`: only these may be picked (the likes list shows liked versions only)
  const preferred = (group, among = null) => {
    const all = groupSongs(group).filter((song) => !among || among.has(song.id));
    const mine = all.find((song) => song.id === choices()[group]);
    if (mine) return mine;
    let liked = new Set();
    try { liked = new Set((JSON.parse(localStorage.getItem(FAV)) || []).map(keyOf)); } catch (e) {}
    const best = (list) => list.find((song) => UNCENSORED.test(song.version)) || list.find((song) => !song.version) || list[0];
    const likedOnes = all.filter((song) => song.sources.some((k) => liked.has(k)));
    return (likedOnes.length && best(likedOnes)) || best(all);
  };
  // one row per group, where its first row was, playing the preferred version
  const collapse = (tracks) => {
    const placed = new Set();
    const out = [];
    for (const t of tracks) {
      const song = bySource.get(keyOf(t));
      if (!song || !song.group) { out.push(t); continue; }
      if (placed.has(song.group)) continue;
      placed.add(song.group);
      const all = groupSongs(song.group);
      const pick = all.length > 1 ? preferred(song.group) : song;
      const row = pick.id === song.id ? t : asTrack(pick);
      Object.assign(row, { inLibrary: true, libraryGroup: song.group, versionCount: all.length });
      out.push(row);
    }
    return out;
  };
  // the likes list: versions liked more than once show as one row (copies: the likes themselves stay as they are)
  const collapseLikes = (tracks) => {
    const present = new Map(); // group -> ids of its songs in the list
    for (const t of tracks) {
      const song = bySource.get(keyOf(t));
      if (song && song.group) { if (!present.has(song.group)) present.set(song.group, new Set()); present.get(song.group).add(song.id); }
    }
    const placed = new Set();
    const out = [];
    for (const t of tracks) {
      const song = bySource.get(keyOf(t));
      if (!song || !song.group) { out.push(t); continue; }
      const count = groupSongs(song.group).length;
      if (count < 2) { out.push(t); continue; }
      if (placed.has(song.group)) continue;
      const pick = preferred(song.group, present.get(song.group));
      const row = pick.id === song.id ? t : tracks.find((x) => bySource.get(keyOf(x)) === pick);
      if (!row) { out.push(t); continue; }
      placed.add(song.group);
      out.push({ ...row, libraryGroup: song.group, versionCount: count });
    }
    return out;
  };
  const refreshCatalog = async (pc) => {
    const catalog = await call(pc, '/catalog', {}, 30000);
    fs.mkdirSync('/data/library', { recursive: true });
    fs.writeFileSync(CATALOG, JSON.stringify(catalog));
    useCatalog(catalog);
  };
  const reachPc = async () => {
    const pc = pcOnline() ? lastPc : await findPc();
    if (!pc) throw new Error('the PC with the library is off');
    return pc;
  };
  // what the phone's version menu (mobile-ui.js) shows and does
  const versions = {
    of: (platform, id) => {
      const song = bySource.get(`${platform || 'youtube'}:${id}`);
      if (!song) return null;
      const pick = preferred(song.group);
      return {
        group: song.group,
        songs: groupSongs(song.group).map((s) => ({ id: s.id, title: s.title, artist: s.artist, version: s.version, duration: s.duration, chosen: s === pick, track: asTrack(s) })),
        // other songs by the artist, to add to this one as a version
        others: songsBy(song.artist).filter((s) => s.group !== song.group).map((s) => ({ id: s.id, title: s.title, version: s.version })),
      };
    },
    choose: (group, songId) => {
      const c = choices();
      c[group] = songId;
      try { localStorage.setItem(VERSIONS, JSON.stringify(c)); } catch (e) {}
      window.dispatchEvent(new CustomEvent('riff:library-versions'));
    },
    // by hand, on the PC: withId a song to join, null to stand alone
    regroup: async (songId, withId) => {
      const pc = await reachPc();
      await call(pc, `/songs/${songId}/group`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ with: withId }) });
      await refreshCatalog(pc);
    },
  };

  // ---- searching: songs the library knows get its names, and library songs that match come first ----
  const asTrack = (song) => {
    const [platform, id] = song.sources[0].split(/:(.*)/);
    return {
      id, platform, url: song.url || (platform === 'youtube' ? `https://www.youtube.com/watch?v=${id}` : ''),
      title: song.title, artist: song.artist, duration: song.duration, thumbnail: song.cover, inLibrary: true,
    };
  };
  // the album of a song as the library knows it, and its songs in the library (the album page lists them first)
  const albumName = (s) => String(s || '').replace(/\s+-\s+(single|ep)$/i, '').trim();
  const albumOf = (t) => {
    const song = t && bySource.get(keyOf(t));
    if (!song || !albumName(song.album)) return null;
    const name = albumName(song.album);
    const songs = [...new Set(bySource.values())]
      .filter((s) => similarity(albumName(s.album), name) > 0.9 && artistSimilarity(s.artist, song.artist) > 0.7)
      .map((s) => (s === song ? { ...t, title: song.title, artist: song.artist } : asTrack(s)));
    return { title: name, artist: song.artist, songs };
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
      const lead = hits.slice(0, 5);
      const libSongs = [...lead, ...data.tracks.filter((t) => t.inLibrary)].map((t) => bySource.get(keyOf(t)));
      data.tracks = collapse([...lead, ...data.tracks.filter((t) => t.inLibrary || !libSongs.some((song) => sameSong(t, song)))]);
    }
    return JSON.stringify(data);
  };

  // ---- artist pages: the artist's library songs first; an artist the services don't know (or can't be reached
  // for) still gets a page from the library ----
  const songsBy = (name) => {
    const seen = new Set();
    const out = [];
    for (const song of bySource.values()) {
      if (seen.has(song.id)) continue;
      seen.add(song.id);
      if (artistSimilarity(song.artist, name) >= 0.85) out.push(song);
    }
    return out.sort((a, b) => (a.album || '').localeCompare(b.album || '') || a.title.localeCompare(b.title));
  };
  const artistResults = (url, status, body) => {
    if (!url.includes('/api/artist?') || !bySource.size) return null;
    const name = new URL(url).searchParams.get('name') || '';
    const mine = songsBy(name);
    let data = null;
    try { data = JSON.parse(body); } catch (e) {}
    if (status === 200 && data && data.success && data.artist && Array.isArray(data.artist.tracks)) {
      const names = {};
      for (const [k, song] of bySource) if (song.named) names[k] = { title: song.title, artist: song.artist, cover: song.cover };
      for (const t of data.artist.tracks) { renameTrack(t, names); if (bySource.has(keyOf(t))) t.inLibrary = true; }
      const shown = new Set(data.artist.tracks.map(keyOf));
      const lead = mine.filter((song) => !song.sources.some((k) => shown.has(k)));
      data.artist.tracks = collapse([...lead.map(asTrack), ...data.artist.tracks.filter((t) => t.inLibrary || !mine.some((song) => sameSong(t, song)))]);
      return { status, body: JSON.stringify(data) };
    }
    if (!mine.length) return null;
    const artist = { name: mine[0].artist, bio: '', avatar: (mine.find((song) => song.cover) || {}).cover || '', isVerified: false, tracks: collapse(mine.map(asTrack)) };
    return { status: 200, body: JSON.stringify({ success: true, artist }) };
  };

  // bridge.js hands every answer of the in-app server through here
  const adjust = (url, status, body) => {
    const a = artistResults(url, status, body);
    if (a) return a;
    return { status, body: status === 200 ? searchResults(url, body) : body };
  };

  return {
    streamFor,
    adjust,
    versions,
    collapseLikes,
    // the PC has its own copy of this song (the cloud mark on rows)
    albumOf,
    // the album page: is a song the user has (its site's name) this song of the album; the artist's library songs
    sameSong,
    songsBy: (artist) => songsBy(artist).map(asTrack),
    onPc: (t) => { const song = t && bySource.get(keyOf(t)); return !!(song && song.ready); },
    status: () => ({ ...status }),
    run,
    // cleanIds of songs whose files must stay until the PC has them (cache-limit.js)
    keep: () => new Set(readQueue().map((x) => cleanId(x.id))),
    catalog: () => { try { return JSON.parse(fs.readFileSync(CATALOG, 'utf8')); } catch (e) { return null; } },
  };
};
module.exports.applyNames = applyNames;
