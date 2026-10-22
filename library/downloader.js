'use strict';

// Fetches a song's audio with yt-dlp, the same copy the desktop app uses (platform.js finds it, tools.js installs
// it). The audio is kept as the service sends it (m4a where there is one, which iPhones play everywhere), with no
// re-encoding: the library keeps the best copy there is.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ytDlpCommand } = require('../platform');

// where yt-dlp can get the song from; null: only a phone that has the file can add it
function sourceUrl(song) {
  for (const key of song.sources) {
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

module.exports = { sourceUrl, download };
