'use strict';

// Keeps the library from being lost:
// - a copy of the catalog (library.json) in backups/ once a day, the last 14 kept: names fixed by hand survive a
//   damaged catalog;
// - with "backupDir" in config.json (another disk, a OneDrive or Yandex Disk folder), a mirror of the songs, the
//   covers and the catalog there. Only copies what is new or changed, and never deletes anything in it.

const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 14;

function snapshot(dir, now = new Date()) {
  const src = path.join(dir, 'library.json');
  if (!fs.existsSync(src)) return null;
  const out = path.join(dir, 'backups');
  fs.mkdirSync(out, { recursive: true });
  const dest = path.join(out, `library-${now.toISOString().slice(0, 10)}.json`);
  if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
  const old = fs.readdirSync(out).filter((n) => /^library-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().slice(0, -KEEP_DAYS);
  for (const n of old) fs.rmSync(path.join(out, n), { force: true });
  return dest;
}

// copies dir's songs/, covers/ and library.json into target; returns how many files it copied
function mirror(dir, target) {
  let copied = 0;
  const copy = (from, to) => {
    let st;
    try { st = fs.statSync(from); } catch (e) { return; }
    let have = null;
    try { have = fs.statSync(to); } catch (e) {}
    if (have && have.size === st.size && have.mtimeMs >= st.mtimeMs) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const tmp = `${to}.part-copy`;
    fs.copyFileSync(from, tmp);
    fs.renameSync(tmp, to);
    copied++;
  };
  for (const sub of ['songs', 'covers']) {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, sub)); } catch (e) {}
    for (const n of names) if (!/\.(part-|upload-)/.test(n)) copy(path.join(dir, sub, n), path.join(target, sub, n));
  }
  copy(path.join(dir, 'library.json'), path.join(target, 'library.json'));
  return copied;
}

module.exports = { snapshot, mirror, KEEP_DAYS };
