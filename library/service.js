'use strict';

// Riff song library: a service on the PC that keeps every song the phones played to the end or liked, with our
// own metadata. Run it whenever you like (node library/service.js [--dir <folder>]); phones send what piled up
// while it was off. It downloads songs itself and takes a phone's file only when it can't.
//
//   GET    /status                 counts, free space
//   GET    /catalog                every song's metadata (what phones keep a copy of)
//   POST   /ingest                 {platform, id, url, title, artist, duration, thumbnail, reason}: a song to keep
//   GET    /songs/<id>/file        the audio (Range requests work, so playback can seek)
//   PUT    /songs/<id>/file?ext=   a phone uploads the audio for a song the PC couldn't download
//   PATCH  /songs/<id>             {title, artist, album, year, cover}: our names for it
//   DELETE /songs/<id>
//   GET    /review                 songs whose names the catalogues weren't sure about, with their guesses
//   POST   /songs/<id>/match       {index} (one of its guesses) or {title, artist, ...}: confirm its names
//   POST   /songs/<id>/search      {artist, title}: ask the catalogues again, with better words
//   POST   /songs/<id>/group       {with: <id> | null | "auto"}: versions of one song, by hand
//   GET    /songs/<id>/cover       the cover written into the file
//   GET    /ui                     the library page (only on this PC, no key needed)
// Every other request carries one of the keys from config.json (header x-riff-key); the key says whose phone it is.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Store } = require('./store');
const downloader = require('./downloader');
const { createNamer } = require('./metadata');
const lookup = require('./lookup');
const yandex = require('./yandex');
const { versionOf } = require('./names');

const DEFAULT_DIR = path.join(os.homedir(), 'Music', 'Riff Library');
const MAX_ATTEMPTS = 3;
const PHONE_WAIT = 10 * 60 * 1000; // a phone that said it has the file: the PC doesn't download it meanwhile
const MAX_UPLOAD = 60 * 1024 * 1024;
const AUDIO = { m4a: 'audio/mp4', mp3: 'audio/mpeg', opus: 'audio/ogg', ogg: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac', aac: 'audio/aac', wav: 'audio/wav' };

// config.json in the library folder; made on the first run with a key for each of the two phones
function loadConfig(dir) {
  const file = path.join(dir, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let changed = false;
  if (!cfg.users || !Object.keys(cfg.users).length) {
    cfg.users = { [crypto.randomBytes(16).toString('hex')]: 'main', [crypto.randomBytes(16).toString('hex')]: 'user2' };
    changed = true;
  }
  const defaults = { port: 38510, maxGB: 20, proxy: '', tunnel: true, worker: 'https://riff-proxy.pages.dev', workerKey: '', backupDir: '' };
  for (const [k, v] of Object.entries(defaults)) if (cfg[k] === undefined) { cfg[k] = v; changed = true; }
  if (changed) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(cfg, null, 2)); }
  return cfg;
}

function createService({ dir = DEFAULT_DIR, config, download = downloader.download, search = downloader.searchYouTube, ensureTools, log = console.log, retryMs = 30000, find = lookup.find, writeTags, namerGapMs } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const cfg = config || loadConfig(dir);
  const store = new Store(dir);
  const maxBytes = cfg.maxGB * 1024 ** 3;
  yandex.configure(() => ({ worker: cfg.worker, key: cfg.workerKey }));
  const namer = createNamer({ store, lookup: { find, isSure: lookup.isSure }, ...(writeTags ? { writeTags } : {}), log, ...(namerGapMs !== undefined ? { gapMs: namerGapMs } : {}) });

  // ---- downloads: two at a time; a song the PC can't get waits for a phone to send its file ----
  const queue = [];
  const active = new Set(); // ids being downloaded right now: a phone asking again doesn't start a second download
  let toolsReady = null;
  const waitsForPhone = (song) => song.phoneHas && Date.now() - song.phoneHas < PHONE_WAIT;
  const enqueue = (song) => { if (song.status === 'pending' && !waitsForPhone(song) && !queue.includes(song.id) && !active.has(song.id)) { queue.push(song.id); pump(); } };
  const pump = () => {
    while (active.size < 2 && queue.length) {
      const song = store.get(queue.shift());
      if (!song || song.status !== 'pending') continue;
      active.add(song.id);
      fetchSong(song).finally(() => { active.delete(song.id); pump(); });
    }
  };
  async function fetchSong(song) {
    if (store.usedBytes() >= maxBytes) { store.setStatus(song.id, 'pending', 'library is full'); return; }
    try {
      if (ensureTools) { toolsReady = toolsReady || ensureTools(); await toolsReady; }
      let file = await fromYandex(song);
      if (!file) try {
        const url = downloader.sourceUrl(song);
        if (!url) throw new Error('no source the PC can download from');
        file = await download(url, store.songsDir, song.id, { proxy: cfg.proxy });
      } catch (e) {
        // once per song: the same song on YouTube, under our name
        if (song.searched) throw e;
        song.searched = true;
        store.save();
        const found = await search(song, { proxy: cfg.proxy });
        if (!found) throw e;
        const key = `youtube:${found.id}`;
        const other = store.bySource(key);
        if (other && other.id !== song.id) {
          const into = store.merge(song.id, other.id);
          log(`= ${song.artist} - ${song.title}: the same song as ${into.artist} - ${into.title}`);
          enqueue(into);
          return;
        }
        store.addSource(song.id, key, found.url);
        song.found = key;
        store.save();
        log(`? ${song.artist} - ${song.title}: found on YouTube (${found.id})`);
        file = await download(found.url, store.songsDir, song.id, { proxy: cfg.proxy });
      }
      store.setFile(song.id, file.name, file.size);
      log(`+ ${song.artist} - ${song.title} (${Math.round(file.size / 1024)} KB)`);
      namer.add(song.id);
    } catch (e) {
      song.attempts += 1;
      const giveUp = song.attempts >= MAX_ATTEMPTS || !downloader.sourceUrl(song);
      store.setStatus(song.id, giveUp ? 'needs-file' : 'pending', e.message);
      log(`! ${song.artist} - ${song.title}: ${e.message}${giveUp ? ' (waiting for a phone to send it)' : ''}`);
      if (!giveUp) setTimeout(() => enqueue(store.get(song.id) || {}), retryMs * song.attempts);
    }
  }

  // Yandex Music first, whatever site the song was played on: the release itself as a full MP3, and the uncensored
  // one when there is one. Null when it can't be reached or hasn't the song; then the song's own source, YouTube...
  async function fromYandex(song) {
    if (!yandex.enabled()) return null;
    try {
      const hit = await yandex.trackFor(song);
      if (!hit) return null;
      // another song of the library has this very track (its other version, say): this one keeps its own source,
      // so no version's file is ever another's
      const other = store.bySource(`yandex:${hit.id}`);
      if (other && other.id !== song.id) return null;
      const file = await yandex.download(hit.id, store.songsDir, song.id);
      store.addSource(song.id, `yandex:${hit.id}`, `https://music.yandex.ru/track/${hit.id}`);
      log(`y ${song.artist} - ${song.title}: from Yandex Music (${hit.title}${hit.explicit ? ', uncensored' : ''})`);
      return file;
    } catch (e) {
      log(`! ${song.artist} - ${song.title}: Yandex Music: ${e.message}`);
      return null;
    }
  }

  // at start: what was left to download, and songs given up on before the PC could look for them on YouTube
  for (const s of store.songs) {
    if (s.status === 'needs-file' && !s.searched) { s.status = 'pending'; s.attempts = 0; }
    if (s.status === 'pending') enqueue(s);
  }

  // ---- HTTP ----
  const send = (res, status, body, headers = {}) => {
    const json = typeof body !== 'string';
    res.writeHead(status, { 'Content-Type': json ? 'application/json' : 'text/plain', ...headers });
    res.end(json ? JSON.stringify(body) : body);
  };
  const readJson = (req) => new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });

  function serveFile(req, res, song) {
    const p = store.filePath(song);
    if (!p || !fs.existsSync(p)) return send(res, 404, 'no file');
    const size = fs.statSync(p).size;
    const type = AUDIO[song.file.format] || 'application/octet-stream';
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!m) {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      return fs.createReadStream(p).pipe(res);
    }
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    if (!(start >= 0 && start < size && end >= start)) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(p, { start, end }).pipe(res);
  }

  function receiveFile(req, res, song, ext) {
    if (!AUDIO[ext]) return send(res, 400, 'unsupported format');
    // the PC got it meanwhile (a copy it found on YouTube by name is replaced by the phone's)
    if (song.status === 'ready' && !(song.found && !song.fromPhone)) { req.resume(); return send(res, 200, { id: song.id, status: song.status }); }
    const tmp = path.join(store.songsDir, `${song.id}.upload-${crypto.randomBytes(4).toString('hex')}`);
    const out = fs.createWriteStream(tmp);
    let size = 0;
    let failed = false;
    const fail = (status, msg) => { if (failed) return; failed = true; out.destroy(); fs.rm(tmp, { force: true }, () => {}); send(res, status, msg); };
    req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) { req.destroy(); fail(413, 'file too big'); } });
    req.on('error', () => fail(400, 'upload broke off'));
    req.pipe(out);
    out.on('finish', () => {
      if (failed) return;
      if (size < 50 * 1024) return fail(400, 'file too small to be a song');
      const name = `${song.id}.${ext}`;
      fs.renameSync(tmp, path.join(store.songsDir, name));
      song.fromPhone = true;
      song.phoneHas = 0;
      store.setFile(song.id, name, size);
      log(`+ ${song.artist} - ${song.title} (from a phone, ${Math.round(size / 1024)} KB)`);
      namer.add(song.id);
      send(res, 200, { id: song.id, status: 'ready' });
    });
  }

  const server = http.createServer(async (req, res) => {
    // phones call from the app's page (GitHub Pages, or localhost while developing); the key is what protects it
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Headers', 'x-riff-key, content-type, range');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'content-length, content-range, accept-ranges');
    if (req.method === 'OPTIONS') return send(res, 204, '');
    const u = new URL(req.url, 'http://x');
    // the library page, for whoever sits at this PC: not through the tunnel (cloudflared adds cf-* headers)
    if (req.method === 'GET' && u.pathname === '/ui') {
      const local = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '') && !req.headers['cf-connecting-ip'];
      if (!local) return send(res, 403, 'open it on the PC itself');
      const key = Object.keys(cfg.users).find((k) => cfg.users[k] === 'main') || Object.keys(cfg.users)[0];
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8').replace('__KEY__', key), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    const user = cfg.users[req.headers['x-riff-key'] || u.searchParams.get('k') || ''];
    if (!user) return send(res, 401, 'key required');
    try {
      if (req.method === 'GET' && u.pathname === '/status') {
        const count = (st) => store.songs.filter((s) => s.status === st).length;
        return send(res, 200, { ok: true, user, songs: store.songs.length, ready: count('ready'), pending: count('pending'), needsFile: count('needs-file'), usedBytes: store.usedBytes(), maxBytes });
      }
      if (req.method === 'GET' && u.pathname === '/catalog') return send(res, 200, store.catalog());
      if (req.method === 'POST' && u.pathname === '/ingest') {
        const body = await readJson(req);
        const { song, created } = store.ingest({ ...body, user });
        if (created) { log(`> ${song.artist} - ${song.title} (${body.reason || 'finished'}, ${user})`); namer.add(song.id); }
        // A phone that has the file of a song from Yandex, SoundCloud...: its copy is the very recording that played,
        // better than the PC's guess on YouTube; the PC waits for it. YouTube songs the PC downloads itself (the same
        // video, and nothing for the phone to send)
        const better = body.hasFile && body.platform !== 'youtube' && !song.fromPhone && (song.status !== 'ready' || song.found);
        if (better) { song.phoneHas = Date.now(); store.save(); } else enqueue(song);
        return send(res, 200, { id: song.id, status: song.status, needFile: song.status === 'needs-file' || !!better });
      }
      if (req.method === 'GET' && u.pathname === '/review') {
        return send(res, 200, { songs: store.songs.filter((s) => !s.locked && s.match && ['review', 'none'].includes(s.match.status)) });
      }
      if (req.method === 'GET' && u.pathname === '/songs') {
        const groups = store.groups();
        return send(res, 200, { songs: store.songs.map((s) => ({ ...s, group: groups.get(s.id), version: versionOf(s.title).version })) });
      }
      const m = /^\/songs\/([0-9a-f]+)(?:\/(file|cover|match|search|group))?$/.exec(u.pathname);
      const song = m && store.get(m[1]);
      if (!song) return send(res, 404, 'not found');
      const part = m[2] || '';
      if (part === 'file' && req.method === 'GET') return serveFile(req, res, song);
      if (part === 'file' && req.method === 'PUT') return receiveFile(req, res, song, String(u.searchParams.get('ext') || '').toLowerCase());
      if (part === 'cover' && req.method === 'GET') {
        const p = path.join(dir, 'covers', `${song.id}.jpg`);
        if (!fs.existsSync(p)) return send(res, 404, 'no cover');
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return fs.createReadStream(p).pipe(res);
      }
      if (part === 'match' && req.method === 'POST') {
        const body = await readJson(req);
        const guesses = (song.match && song.match.candidates) || [];
        const guess = Number.isInteger(body.index) ? guesses[body.index] : null;
        if (Number.isInteger(body.index) && !guess) return send(res, 400, 'no such guess');
        const done = store.confirm(song.id, guess ? namer.pickFields(guess) : body, guess ? guess.source : '');
        namer.add(song.id); // the file's tags follow
        return send(res, 200, done);
      }
      if (part === 'search' && req.method === 'POST') {
        const body = await readJson(req);
        const { candidates } = await find({ original: { title: String(body.title || ''), artist: String(body.artist || '') }, duration: song.duration });
        song.match = { ...(song.match || { status: 'review' }), candidates: candidates.map((c) => ({ ...c, score: Math.round(c.score.total * 100) / 100 })) };
        store.save();
        return send(res, 200, { candidates: song.match.candidates });
      }
      if (!part && req.method === 'PATCH') { const done = store.update(song.id, await readJson(req)); namer.add(song.id); return send(res, 200, done); }
      // versions by hand: {with: "<id>"} makes it a version of that song, {with: null} a song of its own,
      // {with: "auto"} back to grouping by name
      if (part === 'group' && req.method === 'POST') {
        const body = await readJson(req);
        const done = store.setGroup(song.id, body.with === 'auto' ? undefined : body.with || null);
        return done ? send(res, 200, { id: song.id, group: store.groups().get(song.id) }) : send(res, 404, 'no such song');
      }
      if (!part && req.method === 'DELETE') { store.remove(song.id); return send(res, 200, { ok: true }); }
      return send(res, 405, 'method not allowed');
    } catch (e) {
      return send(res, 400, e.message);
    }
  });

  // songs left pending last time (the PC was switched off mid-download) go back in the queue
  // songs not named (or not tagged) yet are, too
  const resume = () => {
    store.songs.filter((s) => s.status === 'pending').forEach(enqueue);
    store.songs.filter(namer.needsWork).forEach((s) => namer.add(s.id));
  };

  return { server, store, config: cfg, resume, idle: () => active.size === 0 && queue.length === 0 && namer.idle() };
}

if (require.main === module) {
  const { DATA_DIR } = require('../platform');
  // the running service's and its tunnel's process ids: library/windows/stop.cmd (--stop) ends both (on Windows
  // ending the service leaves its child cloudflared running otherwise)
  const PID_FILE = path.join(DATA_DIR, 'library.pid');
  const readPids = () => { try { return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch (e) { return {}; } };
  const kill = (pid) => { try { if (pid) { process.kill(pid); return true; } } catch (e) {} return false; };
  if (process.argv.includes('--stop')) {
    const pids = readPids();
    kill(pids.tunnel);
    console.log(kill(pids.service) ? 'Riff library stopped.' : 'Riff library is not running.');
    fs.rmSync(PID_FILE, { force: true });
    process.exit(0);
  }
  const i = process.argv.indexOf('--dir');
  const dir = i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : (process.env.RIFF_LIBRARY_DIR || DEFAULT_DIR);
  const tools = require('../tools');
  const { resolveBinary } = require('../platform');
  const tunnel = require('./tunnel');
  // yt-dlp downloads; ffmpeg repacks YouTube's DASH audio into a plain m4a (iPhones play it reliably)
  const ensureTools = async () => {
    if (resolveBinary('yt-dlp') && resolveBinary('ffmpeg')) return;
    console.log('installing yt-dlp and ffmpeg…');
    const st = await tools.ensureTools();
    if (!st.ytDlp) throw new Error(`yt-dlp could not be installed: ${st.progress.error}`);
    if (!st.ffmpeg) console.log(`! ffmpeg could not be installed (${st.progress.error.trim()}): YouTube songs stay in DASH m4a`);
  };
  const svc = createService({ dir, ensureTools });
  const cfg = svc.config;
  const saveConfig = () => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  // the window (start.cmd) closes when the service ends; a failure stays readable for a while first
  const fatal = (msg) => { console.log(msg); setTimeout(() => process.exit(1), 30000); };
  svc.server.on('error', (e) => fatal(e.code === 'EADDRINUSE' ? `Riff library is already running (port ${cfg.port} is taken).` : `Riff library could not start: ${e.message}`));
  process.on('uncaughtException', (e) => { svc.server.close(); fatal(`Riff library stopped on an error: ${e.stack || e.message}`); });

  // the phones find the PC through the Riff worker, with the same access key as the app (asked once)
  const askWorkerKey = () => new Promise((resolve) => {
    if (cfg.workerKey || !process.stdin.isTTY) return resolve(cfg.workerKey || '');
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Access key (the one you entered in the Riff app) so phones can find this PC, or Enter to skip: ', (a) => {
      rl.close();
      cfg.workerKey = a.trim();
      if (cfg.workerKey) saveConfig();
      resolve(cfg.workerKey);
    });
  });
  const startTunnel = async (pids) => {
    if (!cfg.tunnel) return;
    const key = await askWorkerKey();
    if (!key) { console.log('no access key: phones reach the library only through a riff_library_url set by hand'); return; }
    let bin;
    try { bin = await tunnel.ensureCloudflared(console.log); } catch (e) { console.log(`! tunnel: ${e.message}`); return; }
    const announce = async (url) => {
      for (let n = 0; n < 5; n++) {
        try { await tunnel.register(cfg.worker, key, url, cfg.users); console.log(`phones can reach it at ${url}`); return; } catch (e) {
          console.log(`! could not tell the worker (${e.message})${n < 4 ? ', retrying' : ''}`);
          await new Promise((r) => setTimeout(r, 15000));
        }
      }
    };
    tunnel.startTunnel(bin, cfg.port, announce, console.log, (pid) => { pids.tunnel = pid; fs.writeFileSync(PID_FILE, JSON.stringify(pids)); });
  };

  svc.server.listen(cfg.port, () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const old = readPids();
    kill(old.tunnel); // a tunnel left behind by a service that was ended the hard way
    const pids = { service: process.pid };
    fs.writeFileSync(PID_FILE, JSON.stringify(pids));
    process.on('exit', () => { if (readPids().service === process.pid) fs.rmSync(PID_FILE, { force: true }); });
    const s = svc.store;
    console.log(`Riff library: ${dir}`);
    console.log(`${s.songs.length} songs, ${(s.usedBytes() / 1024 ** 3).toFixed(2)} of ${cfg.maxGB} GB, http://localhost:${cfg.port}`);
    console.log(`keys (config.json): ${Object.entries(cfg.users).map(([k, v]) => `${v} = ${k}`).join(', ')}`);
    console.log(`library page (names to check): http://localhost:${cfg.port}/ui`);
    svc.resume();
    // backups (backup.js): today's copy of the catalog, and the mirror in backupDir, now and every 15 minutes
    const backup = require('./backup');
    const keepSafe = () => {
      try { backup.snapshot(dir); } catch (e) { console.log(`! catalog copy: ${e.message}`); }
      if (!cfg.backupDir) return;
      try { const n = backup.mirror(dir, path.resolve(cfg.backupDir)); if (n) console.log(`backup: ${n} files copied to ${cfg.backupDir}`); } catch (e) { console.log(`! backup to ${cfg.backupDir}: ${e.message}`); }
    };
    setTimeout(keepSafe, 60 * 1000);
    setInterval(keepSafe, 15 * 60 * 1000);
    startTunnel(pids);
  });
}

module.exports = { createService, loadConfig, DEFAULT_DIR };
