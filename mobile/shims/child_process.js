// `child_process.spawn` for the iOS build. iOS can't run processes; the only thing server.js spawns
// is yt-dlp, so this emulates the yt-dlp invocations it makes on top of the in-app extractor.
const { EventEmitter } = require('events');
const fs = require('./fs');
const store = require('./store');
const ex = require('../extract');
const { segmentsToAac } = require('../ts2aac');
const { enforceCacheLimit } = require('../cache-limit');

function fakeProcess(work) {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  let killed = false;
  p.kill = () => { killed = true; };
  setTimeout(async () => {
    try {
      const out = await work();
      if (killed) return;
      if (out) p.stdout.emit('data', out);
      p.emit('close', 0);
    } catch (e) {
      if (killed) return;
      p.stderr.emit('data', `ERROR: ${e && e.message || e}`);
      p.emit('close', 1);
    }
  }, 0);
  return p;
}

const opt = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

async function searchJson(target, limit) {
  let entries;
  let m = target.match(/^(yt|sc)search(\d*):(.*)$/);
  if (m) {
    const n = Number(m[2]) || limit || 20;
    entries = m[1] === 'sc' ? await ex.soundcloudSearch(m[3], n) : await ex.youtubeSearch(m[3], n);
  } else if ((m = target.match(/music\.youtube\.com\/search\?q=([^#&]+)/))) {
    entries = await ex.ytMusicSearch(decodeURIComponent(m[1].replace(/\+/g, ' ')), limit || 20);
  } else if (/^https?:\/\//.test(target)) {
    // playlist / album / set link (link import)
    const pl = await ex.playlist(target, limit || 500);
    return JSON.stringify({ title: pl.title, entries: pl.entries });
  } else {
    throw new Error(`unsupported search target ${target}`);
  }
  return JSON.stringify({ entries });
}

// Fetches every segment of an HLS media playlist (4 at a time) and joins them into one .aac file.
async function downloadHls(playlistUrl, headers) {
  const m3u = await (await globalThis.__riffFetch(playlistUrl, { headers })).text();
  const urls = m3u.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => new URL(l, playlistUrl).href);
  const parts = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      // a flaky segment shouldn't sink the whole song: retry it a couple of times with a short backoff
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await globalThis.__riffFetch(urls[i], { headers });
          if (!r.ok) throw new Error(`segment ${i} failed: ${r.status}`);
          parts[i] = new Uint8Array(await r.arrayBuffer());
          break;
        } catch (e) {
          if (attempt >= 2) throw e;
          await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, worker));
  return segmentsToAac(parts);
}

async function download(args, target) {
  const audio = await ex.resolveAudio(target);
  if (audio.ext === 'm3u8') throw new Error('this track is only available as a stream');
  let out = opt(args, '-o');
  // yt-dlp templates: the user-facing download keeps the real container (no ffmpeg on iOS to convert)
  out = out.includes('%(ext)s') ? out.replace('%(ext)s', audio.ext) : out;
  let size;
  if (audio.kind === 'hls') {
    const bytes = await downloadHls(audio.url, audio.headers);
    await store.writeBytes(out, bytes);
    size = bytes.length;
  } else {
    size = await store.download(audio.url, out, audio.headers || { 'User-Agent': 'Mozilla/5.0' });
  }
  fs._register(out, size);
  enforceCacheLimit();
  return '';
}

function spawn(bin, args) {
  args = args || [];
  // yt-dlp takes the target anywhere: server.js puts search terms first and URLs last
  const target = [...args].reverse().find((a) => /^(yt|sc)search\d*:|^https?:\/\//.test(a)) || args[args.length - 1];
  const limit = Number(opt(args, '--playlist-end')) || undefined;

  if (args.includes('-g')) return fakeProcess(async () => `${(await ex.resolveAudio(target)).url}\n`);
  if (args.includes('--dump-single-json') || args.includes('-J')) return fakeProcess(() => searchJson(target, limit));
  if (args.includes('--print')) return fakeProcess(async () => `${(await ex.resolveAudio(target)).artist || 'NA'}\n`);
  if (args.includes('-x')) return fakeProcess(() => download(args, target));
  return fakeProcess(async () => { throw new Error(`unsupported yt-dlp call: ${args.join(' ')}`); });
}

module.exports = { spawn, execFile: () => { throw new Error('execFile is not available on iOS'); } };
