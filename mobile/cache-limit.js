// Keeps the downloaded-songs cache under the limit chosen in Settings (default 2 GB):
// after each download, the songs touched longest ago are deleted first. The newest few always stay.
const fs = require('./shims/fs');

const TRACKS = '/data/tracks';
const KEEP_NEWEST = 4;

function limitBytes() {
  const mb = parseInt(localStorage.getItem('riff_cache_limit_mb') || '2048', 10);
  return (Number.isFinite(mb) && mb > 0 ? mb : 2048) * 1024 * 1024;
}

function enforceCacheLimit() {
  const limit = limitBytes();
  let files;
  try {
    files = fs.readdirSync(TRACKS).filter((n) => !n.includes('.temp.')).map((n) => {
      const st = fs.statSync(`${TRACKS}/${n}`);
      return { path: `${TRACKS}/${n}`, size: st.size, mtime: st.mtimeMs };
    });
  } catch (e) { return; }
  let total = files.reduce((n, f) => n + f.size, 0);
  if (total <= limit) return;
  files.sort((a, b) => a.mtime - b.mtime); // oldest first
  const removable = files.slice(0, Math.max(0, files.length - KEEP_NEWEST));
  for (const f of removable) {
    if (total <= limit) break;
    try { fs.unlinkSync(f.path); total -= f.size; } catch (e) {}
  }
  if (window.RiffLog) window.RiffLog.add('info', `cache trimmed to ${Math.round(total / 1048576)} MB`);
}

module.exports = { enforceCacheLimit };
