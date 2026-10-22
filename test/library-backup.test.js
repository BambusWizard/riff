'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { snapshot, mirror, KEEP_DAYS } = require('../library/backup');

function library(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-bk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'songs'));
  fs.writeFileSync(path.join(dir, 'library.json'), '{"rev":1,"songs":[]}');
  fs.writeFileSync(path.join(dir, 'songs', 'a.m4a'), 'aaaa');
  return dir;
}

test('one catalog copy a day, the last two weeks kept', (t) => {
  const dir = library(t);
  for (let d = 1; d <= KEEP_DAYS + 3; d++) snapshot(dir, new Date(Date.UTC(2026, 0, d)));
  snapshot(dir, new Date(Date.UTC(2026, 0, KEEP_DAYS + 3))); // same day again: no second copy
  const kept = fs.readdirSync(path.join(dir, 'backups')).sort();
  assert.strictEqual(kept.length, KEEP_DAYS);
  assert.strictEqual(kept[kept.length - 1], `library-2026-01-${KEEP_DAYS + 3}.json`);
});

test('the mirror copies new and changed files, skips pieces of downloads, and never deletes', (t) => {
  const dir = library(t);
  const target = path.join(dir, 'mirror');
  fs.writeFileSync(path.join(dir, 'songs', 'b.part-m4a'), 'half');
  assert.strictEqual(mirror(dir, target), 2); // a.m4a + library.json
  assert.strictEqual(mirror(dir, target), 0); // nothing new
  assert.ok(!fs.existsSync(path.join(target, 'songs', 'b.part-m4a')));
  fs.writeFileSync(path.join(dir, 'songs', 'a.m4a'), 'aaaa + tags');
  fs.rmSync(path.join(dir, 'library.json'));
  assert.strictEqual(mirror(dir, target), 1);
  assert.strictEqual(fs.readFileSync(path.join(target, 'songs', 'a.m4a'), 'utf8'), 'aaaa + tags');
  assert.ok(fs.existsSync(path.join(target, 'library.json'))); // gone here, still there
});
