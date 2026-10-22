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
// Every request carries one of the keys from config.json (header x-riff-key); the key says whose phone it is.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Store } = require('./store');
const downloader = require('./downloader');

const DEFAULT_DIR = path.join(os.homedir(), 'Music', 'Riff Library');
const MAX_ATTEMPTS = 3;
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
  for (const [k, v] of Object.entries({ port: 38510, maxGB: 20, proxy: '' })) if (cfg[k] === undefined) { cfg[k] = v; changed = true; }
  if (changed) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(cfg, null, 2)); }
  return cfg;
}

function createService({ dir = DEFAULT_DIR, config, download = downloader.download, ensureTools, log = console.log, retryMs = 30000 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const cfg = config || loadConfig(dir);
  const store = new Store(dir);
  const maxBytes = cfg.maxGB * 1024 ** 3;

  // ---- downloads: two at a time; a song the PC can't get waits for a phone to send its file ----
  const queue = [];
  let active = 0;
  let toolsReady = null;
  const enqueue = (song) => { if (song.status === 'pending' && !queue.includes(song.id)) { queue.push(song.id); pump(); } };
  const pump = () => {
    while (active < 2 && queue.length) {
      const song = store.get(queue.shift());
      if (!song || song.status !== 'pending') continue;
      active += 1;
      fetchSong(song).finally(() => { active -= 1; pump(); });
    }
  };
  async function fetchSong(song) {
    const url = downloader.sourceUrl(song);
    if (!url) { store.setStatus(song.id, 'needs-file', 'no source the PC can download from'); return; }
    if (store.usedBytes() >= maxBytes) { store.setStatus(song.id, 'pending', 'library is full'); return; }
    try {
      if (ensureTools) { toolsReady = toolsReady || ensureTools(); await toolsReady; }
      const file = await download(url, store.songsDir, song.id, { proxy: cfg.proxy });
      store.setFile(song.id, file.name, file.size);
      log(`+ ${song.artist} - ${song.title} (${Math.round(file.size / 1024)} KB)`);
    } catch (e) {
      song.attempts += 1;
      const giveUp = song.attempts >= MAX_ATTEMPTS;
      store.setStatus(song.id, giveUp ? 'needs-file' : 'pending', e.message);
      log(`! ${song.artist} - ${song.title}: ${e.message}${giveUp ? ' (waiting for a phone to send it)' : ''}`);
      if (!giveUp) setTimeout(() => enqueue(store.get(song.id) || {}), retryMs * song.attempts);
    }
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
    if (song.status === 'ready') { req.resume(); return send(res, 200, { id: song.id, status: song.status }); } // the PC got it meanwhile
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
      store.setFile(song.id, name, size);
      log(`+ ${song.artist} - ${song.title} (from a phone, ${Math.round(size / 1024)} KB)`);
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
        if (created) log(`> ${song.artist} - ${song.title} (${body.reason || 'finished'}, ${user})`);
        enqueue(song);
        return send(res, 200, { id: song.id, status: song.status, needFile: song.status === 'needs-file' });
      }
      const m = /^\/songs\/([0-9a-f]+)(\/file)?$/.exec(u.pathname);
      const song = m && store.get(m[1]);
      if (!song) return send(res, 404, 'not found');
      if (m[2] && req.method === 'GET') return serveFile(req, res, song);
      if (m[2] && req.method === 'PUT') return receiveFile(req, res, song, String(u.searchParams.get('ext') || '').toLowerCase());
      if (!m[2] && req.method === 'PATCH') return send(res, 200, store.update(song.id, await readJson(req)));
      if (!m[2] && req.method === 'DELETE') { store.remove(song.id); return send(res, 200, { ok: true }); }
      return send(res, 405, 'method not allowed');
    } catch (e) {
      return send(res, 400, e.message);
    }
  });

  // songs left pending last time (the PC was switched off mid-download) go back in the queue
  const resume = () => store.songs.filter((s) => s.status === 'pending').forEach(enqueue);

  return { server, store, config: cfg, resume, idle: () => active === 0 && queue.length === 0 };
}

if (require.main === module) {
  const i = process.argv.indexOf('--dir');
  const dir = i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : (process.env.RIFF_LIBRARY_DIR || DEFAULT_DIR);
  const tools = require('../tools');
  const { resolveBinary } = require('../platform');
  // yt-dlp downloads; ffmpeg repacks YouTube's DASH audio into a plain m4a (iPhones play it reliably)
  const ensureTools = async () => {
    if (resolveBinary('yt-dlp') && resolveBinary('ffmpeg')) return;
    console.log('installing yt-dlp and ffmpeg…');
    const st = await tools.ensureTools();
    if (!st.ytDlp) throw new Error(`yt-dlp could not be installed: ${st.progress.error}`);
    if (!st.ffmpeg) console.log(`! ffmpeg could not be installed (${st.progress.error.trim()}): YouTube songs stay in DASH m4a`);
  };
  const svc = createService({ dir, ensureTools });
  svc.server.listen(svc.config.port, () => {
    const s = svc.store;
    console.log(`Riff library: ${dir}`);
    console.log(`${s.songs.length} songs, ${(s.usedBytes() / 1024 ** 3).toFixed(2)} of ${svc.config.maxGB} GB, http://localhost:${svc.config.port}`);
    console.log(`keys (config.json): ${Object.entries(svc.config.users).map(([k, v]) => `${v} = ${k}`).join(', ')}`);
    svc.resume();
  });
}

module.exports = { createService, loadConfig, DEFAULT_DIR };
