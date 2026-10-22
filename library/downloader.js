'use strict';

// Fetches a song's audio with yt-dlp, the same copy the desktop app uses (platform.js finds it, tools.js installs
// it). The audio is kept as the service sends it (m4a where there is one, which iPhones play everywhere), with no
// re-encoding: the library keeps the best copy there is.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ytDlpCommand } = require('../platform');
const { parseName, cleanTitle, cleanArtist, similarity, artistSimilarity } = require('./names');
const { UNCENSORED } = require('./lookup');

// where yt-dlp can get the song from; null: only a phone that has the file can add it
function sourceUrl(song) {
  // the copy found on YouTube when the song's own source failed, then YouTube, then the rest
  const order = [...song.sources].sort((a, b) => (b === song.found) - (a === song.found) || b.startsWith('youtube:') - a.startsWith('youtube:'));
  for (const key of order) {
    if (song.urls[key]) return song.urls[key];
    const [platform, id] = key.split(/:(.*)/);
    if (platform === 'youtube' && id) return `https://www.youtube.com/watch?v=${id}`;
  }
  return null;
}

function download(url, dir, base, { proxy = '', timeoutMs = 5 * 60 * 1000 } = {}) {
  const args = [
    '--no-config', '--no-playlist', '--no-warnings', '--no-progress', '--no-part',
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '-o', path.join(dir, `${base}.part-%(ext)s`),
    '--print', 'after_move:filepath',
  ];
  if (proxy) args.push('--proxy', proxy);
  args.push('--', url);
  const cmd = ytDlpCommand(args);
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd.bin, cmd.args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const tmp = out.trim().split(/\r?\n/).pop();
      if (code !== 0 || !tmp || !fs.existsSync(tmp)) {
        if (tmp) { try { fs.unlinkSync(tmp); } catch (e) {} }
        return reject(new Error((err.trim().split(/\r?\n/).pop() || `yt-dlp exited with code ${code}`).slice(0, 300)));
      }
      // finished files only: "<id>.part-m4a" becomes "<id>.m4a"
      const name = `${base}.${tmp.slice(tmp.lastIndexOf('.part-') + 6)}`;
      fs.renameSync(tmp, path.join(dir, name));
      resolve({ name, size: fs.statSync(path.join(dir, name)).size });
    });
  });
}

// The same song on YouTube, for one the PC can't get from where it was played (Yandex Music, DRM on SoundCloud,
// a removed video): the first of the search results with our artist and title and the same length, give or take
// a few seconds. Returns {id, url} or null
const pickResult = (song, results) => {
  let best = null;
  for (const r of results) {
    if (song.duration && r.duration && Math.abs(r.duration - song.duration) > Math.max(4, song.duration * 0.04)) continue;
    const p = parseName(r.title, r.channel);
    const title = Math.max(similarity(p.title, song.title), similarity(cleanTitle(r.title), song.title));
    const artist = Math.max(artistSimilarity(p.artist, song.artist), artistSimilarity(cleanArtist(r.channel), song.artist));
    if (title < 0.75 || artist < 0.6) continue;
    if (UNCENSORED.test(song.title) && !UNCENSORED.test(r.title)) continue; // not the censored release instead
    // the artist's own channel (or its "- Topic" one) over a re-upload
    const own = artistSimilarity(cleanArtist(r.channel), song.artist) >= 0.8;
    const s = title + artist + (own ? 0.1 : 0) + (/ - topic$/i.test(r.channel) ? 0.1 : 0);
    if (!best || s > best.s) best = { s, id: r.id };
  }
  return best && { id: best.id, url: `https://www.youtube.com/watch?v=${best.id}` };
};

function searchYouTube(song, { proxy = '', timeoutMs = 60 * 1000 } = {}) {
  const args = ['--no-config', '--no-warnings', '--flat-playlist', '--encoding', 'utf-8', '--print', '%(id)s\t%(duration)s\t%(channel)s\t%(title)s'];
  if (proxy) args.push('--proxy', proxy);
  args.push('--', `ytsearch8:${song.artist} ${song.title}`);
  const cmd = ytDlpCommand(args);
  return new Promise((resolve) => {
    const proc = spawn(cmd.bin, cmd.args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', () => {
      clearTimeout(timer);
      const results = out.split(/\r?\n/).filter(Boolean).map((l) => {
        const [id, duration, channel, ...title] = l.split('\t');
        return { id, duration: Number(duration) || 0, channel: channel === 'NA' ? '' : channel, title: title.join('\t') };
      });
      resolve(pickResult(song, results));
    });
  });
}

module.exports = { sourceUrl, download, searchYouTube, pickResult };
