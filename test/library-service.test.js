'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createService } = require('../library/service');
const { Store } = require('../library/store');

const KEY = 'k-main';
const KEY2 = 'k-user2';
const config = { users: { [KEY]: 'main', [KEY2]: 'user2' }, port: 0, maxGB: 1, proxy: '' };
const AUDIO = Buffer.alloc(200 * 1024, 7);

// a service on a free port with a fake yt-dlp: `fails` downloads fail, then each writes AUDIO as m4a
async function start(t, { fails = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-lib-'));
  const calls = [];
  const download = async (url, songsDir, base) => {
    calls.push(url);
    if (calls.length <= fails) throw new Error('blocked');
    fs.writeFileSync(path.join(songsDir, `${base}.m4a`), AUDIO);
    return { name: `${base}.m4a`, size: AUDIO.length };
  };
  const svc = createService({ dir, config, download, log: () => {}, retryMs: 5 });
  await new Promise((r) => svc.server.listen(0, r));
  t.after(() => { svc.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${svc.server.address().port}`;
  const api = async (p, { key = KEY, method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(base + p, { method, headers: { 'x-riff-key': key, ...headers }, body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  const settle = async () => { for (let i = 0; i < 200 && !svc.idle(); i++) await new Promise((r) => setTimeout(r, 10)); };
  return { svc, dir, api, calls, settle };
}

const song = { platform: 'youtube', id: 'abc123', title: 'Lida - Song', artist: 'minecrafter', duration: 180, reason: 'finished' };

test('a request without a known key is refused', async (t) => {
  const { api } = await start(t);
  assert.strictEqual((await api('/status', { key: 'nope' })).status, 401);
});

test('a finished song is downloaded by the PC and listed in the catalog', async (t) => {
  const { api, calls, settle } = await start(t);
  const r = await api('/ingest', { method: 'POST', body: song });
  assert.strictEqual(r.status, 200);
  await settle();
  assert.deepStrictEqual(calls, ['https://www.youtube.com/watch?v=abc123']);
  const cat = (await api('/catalog')).body;
  assert.strictEqual(cat.songs.length, 1);
  assert.deepStrictEqual(cat.songs[0].sources, ['youtube:abc123']);
  assert.strictEqual(cat.songs[0].ready, true);
});

test('the same song from both phones is kept once, with both reasons and users', async (t) => {
  const { api, settle, svc } = await start(t);
  await api('/ingest', { method: 'POST', body: song });
  await api('/ingest', { key: KEY2, method: 'POST', body: { ...song, reason: 'liked' } });
  await settle();
  assert.strictEqual(svc.store.songs.length, 1);
  assert.deepStrictEqual(svc.store.songs[0].reasons, ['finished', 'liked']);
  assert.deepStrictEqual(svc.store.songs[0].users, ['main', 'user2']);
});

test('a song the PC fails to download waits for a phone, which then sends the file', async (t) => {
  const { api, settle } = await start(t, { fails: 3 });
  const { body: first } = await api('/ingest', { method: 'POST', body: song });
  await settle();
  await new Promise((r) => setTimeout(r, 100)); // retries (5 ms apart here)
  await settle();
  const again = (await api('/ingest', { method: 'POST', body: song })).body;
  assert.strictEqual(again.needFile, true);
  const up = await api(`/songs/${first.id}/file?ext=m4a`, { method: 'PUT', body: AUDIO });
  assert.strictEqual(up.status, 200);
  assert.strictEqual((await api('/catalog')).body.songs[0].ready, true);
});

test('a song with no source the PC can use asks for the file straight away', async (t) => {
  const { api, settle, calls } = await start(t);
  const { body } = await api('/ingest', { method: 'POST', body: { platform: 'local', id: 'x1', title: 'Home recording' } });
  await settle();
  assert.strictEqual(calls.length, 0);
  assert.strictEqual((await api('/ingest', { method: 'POST', body: { platform: 'local', id: 'x1' } })).body.needFile, true);
  assert.ok(body.id);
});

test('the audio is served with Range support for seeking', async (t) => {
  const { api, settle } = await start(t);
  const { body } = await api('/ingest', { method: 'POST', body: song });
  await settle();
  const full = await api(`/songs/${body.id}/file`);
  assert.strictEqual(full.status, 200);
  assert.strictEqual(full.body.length, AUDIO.length);
  const part = await api(`/songs/${body.id}/file`, { headers: { range: 'bytes=100-199' } });
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.headers.get('content-range'), `bytes 100-199/${AUDIO.length}`);
  assert.strictEqual(part.body.length, 100);
});

test('our names replace the service ones and stay locked; the original is kept', async (t) => {
  const { api, settle, svc } = await start(t);
  const { body } = await api('/ingest', { method: 'POST', body: song });
  await settle();
  const edited = (await api(`/songs/${body.id}`, { method: 'PATCH', body: { title: 'Song', artist: 'Lida' } })).body;
  assert.strictEqual(edited.locked, true);
  assert.deepStrictEqual(edited.original, { title: 'Lida - Song', artist: 'minecrafter' });
  const c = (await api('/catalog')).body.songs[0];
  assert.strictEqual(`${c.artist} - ${c.title}`, 'Lida - Song');
  assert.strictEqual(svc.store.songs[0].title, 'Song');
});

test('the catalog survives a restart', async (t) => {
  const { api, settle, dir } = await start(t);
  await api('/ingest', { method: 'POST', body: song });
  await settle();
  const reopened = new Store(dir);
  assert.strictEqual(reopened.songs.length, 1);
  assert.strictEqual(reopened.songs[0].status, 'ready');
});

test('deleting a song removes its file', async (t) => {
  const { api, settle, svc } = await start(t);
  const { body } = await api('/ingest', { method: 'POST', body: song });
  await settle();
  const file = svc.store.filePath(svc.store.get(body.id));
  assert.ok(fs.existsSync(file));
  await api(`/songs/${body.id}`, { method: 'DELETE' });
  assert.strictEqual(fs.existsSync(file), false);
  assert.strictEqual((await api('/catalog')).body.songs.length, 0);
});
