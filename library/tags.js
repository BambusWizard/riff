'use strict';

// Writes our names into the audio file itself (and the cover into m4a/mp3), so the library folder is a proper
// music collection for any player, not only for Riff. ffmpeg copies the audio untouched; the tagged copy replaces
// the file only once it is complete.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveBinary } = require('../platform');

async function fetchCover(url, dest) {
  if (!url) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok || !/^image\/(jpeg|png)/.test(r.headers.get('content-type') || '')) return null;
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    return dest;
  } catch (e) { return null; }
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split(/\r?\n/).pop() || `ffmpeg exited with ${code}`))));
  });
}

// returns the file's new size, or 0 when there is no ffmpeg
async function writeTags(file, meta, coverUrl, coversDir) {
  const ffmpeg = resolveBinary('ffmpeg');
  if (!ffmpeg) return 0;
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file, ext);
  fs.mkdirSync(coversDir, { recursive: true });
  const cover = ['.m4a', '.mp3'].includes(ext) ? await fetchCover(coverUrl, path.join(coversDir, `${base}.jpg`)) : null;
  const tmp = path.join(path.dirname(file), `${base}.part-tags${ext}`); // cleaned up at start if cut off (store.js)
  const args = ['-y', '-v', 'error', '-i', file];
  if (cover) args.push('-i', cover, '-map', '0:a', '-map', '1:v', '-c', 'copy', '-disposition:v:0', 'attached_pic');
  else args.push('-map', '0:a', '-c', 'copy');
  args.push('-map_metadata', '-1'); // the service's own tags (often the upload's title) go
  for (const [k, v] of [['title', meta.title], ['artist', meta.artist], ['album', meta.album], ['date', meta.year]]) {
    if (v) args.push('-metadata', `${k}=${v}`);
  }
  args.push(tmp);
  try {
    await run(ffmpeg, args);
    fs.renameSync(tmp, file); // fails while a phone is streaming it (Windows): tried again later
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return fs.statSync(file).size;
}

module.exports = { writeTags };
