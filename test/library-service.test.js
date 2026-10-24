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

// a service on a free port with a fake yt-dlp: `fails` downloads fail (or those of the URLs `fails` picks), then each writes AUDIO as m4a.
// The YouTube search finds `found` ({id, url}, none by default). The catalogues answer `candidates` (none by default: no network in tests); tags written are recorded
async function start(t, { fails = 0, delayMs = 0, candidates = [], found = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-lib-'));
  const calls = [];
  const tagged = [];
  const download = async (url, songsDir, base) => {
    calls.push(url);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (typeof fails === 'function' ? fails(url) : calls.length <= fails) throw new Error('blocked');
    fs.writeFileSync(path.join(songsDir, `${base}.m4a`), AUDIO);
    return { name: `${base}.m4a`, size: AUDIO.length };
  };
  const { parseName } = require('../library/names');
  const { score } = require('../library/lookup');
  const find = async (s) => {
    const parsed = parseName(s.original.title, s.original.artist);
    const want = { ...parsed, duration: s.duration };
    return { parsed, candidates: candidates.map((c) => ({ ...c, score: score(c, want) })).sort((a, b) => b.score.total - a.score.total) };
  };
  const writeTags = async (file, meta) => { tagged.push(`${meta.artist} - ${meta.title}`); return AUDIO.length; };
  const svc = createService({ dir, config, download, search: async () => found, log: () => {}, retryMs: 5, find, writeTags, namerGapMs: 0 });
  await new Promise((r) => svc.server.listen(0, r));
  t.after(() => { svc.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${svc.server.address().port}`;
  const api = async (p, { key = KEY, method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(base + p, { method, headers: { 'x-riff-key': key, ...headers }, body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  const settle = async () => { for (let i = 0; i < 200 && !svc.idle(); i++) await new Promise((r) => setTimeout(r, 10)); };
  return { svc, dir, api, calls, settle, tagged };
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

test('a song the PC cannot get from its own service is downloaded from the same song on YouTube', async (t) => {
  const yandex = { platform: 'yandex', id: 'ym1', url: 'https://music.yandex.ru/track/1', title: 'Song', artist: 'Lida', duration: 180, reason: 'liked' };
  const { api, settle, calls } = await start(t, { fails: (u) => u.includes('yandex'), found: { id: 'yt9', url: 'https://www.youtube.com/watch?v=yt9' } });
  await api('/ingest', { method: 'POST', body: yandex });
  await settle();
  assert.deepStrictEqual(calls, ['https://music.yandex.ru/track/1', 'https://www.youtube.com/watch?v=yt9']);
  const [one] = (await api('/catalog')).body.songs;
  assert.strictEqual(one.ready, true);
  assert.deepStrictEqual(one.sources, ['yandex:ym1', 'youtube:yt9']);
});

test('a song found on YouTube that the library already has becomes one song', async (t) => {
  const { api, settle } = await start(t, { fails: (u) => u.includes('yandex'), found: { id: 'abc123', url: 'https://www.youtube.com/watch?v=abc123' } });
  await api('/ingest', { method: 'POST', body: song });
  await settle();
  await api('/ingest', { method: 'POST', body: { platform: 'yandex', id: 'ym2', url: 'https://music.yandex.ru/track/2', title: 'Song', artist: 'Lida', duration: 180, reason: 'liked' } });
  await settle();
  const { songs } = (await api('/catalog')).body;
  assert.strictEqual(songs.length, 1);
  assert.deepStrictEqual(songs[0].sources.sort(), ['youtube:abc123', 'yandex:ym2'].sort());
  assert.strictEqual((await api('/ingest', { method: 'POST', body: { platform: 'yandex', id: 'ym2' } })).body.status, 'ready');
});

test('a phone that has the file of a Yandex song sends it, and the PC does not download it', async (t) => {
  const yandex = { platform: 'yandex', id: 'ym3', url: 'https://music.yandex.ru/track/3', title: 'Song', artist: 'Lida', duration: 180, reason: 'liked', hasFile: true };
  const { api, settle, calls } = await start(t, { found: { id: 'yt9', url: 'https://www.youtube.com/watch?v=yt9' } });
  const { body } = await api('/ingest', { method: 'POST', body: yandex });
  await settle();
  assert.strictEqual(body.needFile, true);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual((await api(`/songs/${body.id}/file?ext=m4a`, { method: 'PUT', body: AUDIO })).body.status, 'ready');
  assert.strictEqual((await api('/ingest', { method: 'POST', body: yandex })).body.needFile, false);
});

test("the PC's copy found on YouTube is replaced by the phone's file of the song", async (t) => {
  const sc = { platform: 'soundcloud', id: 'sc4', url: 'https://soundcloud.com/lida/song', title: 'Song', artist: 'Lida', duration: 180, reason: 'liked' };
  const { api, settle, svc } = await start(t, { fails: (u) => u.includes('soundcloud'), found: { id: 'yt9', url: 'https://www.youtube.com/watch?v=yt9' } });
  const { body } = await api('/ingest', { method: 'POST', body: sc });
  await settle();
  assert.strictEqual(svc.store.get(body.id).status, 'ready');
  assert.strictEqual((await api('/catalog')).body.songs[0].guess, true); // phones that have it send theirs
  assert.strictEqual((await api('/ingest', { method: 'POST', body: { ...sc, hasFile: true } })).body.needFile, true);
  const mine = Buffer.alloc(300 * 1024, 9);
  await api(`/songs/${body.id}/file?ext=m4a&from=soundcloud`, { method: 'PUT', body: mine });
  assert.strictEqual(svc.store.get(body.id).file.size, mine.length);
  assert.strictEqual((await api('/catalog')).body.songs[0].guess, undefined);
  assert.strictEqual((await api('/ingest', { method: 'POST', body: { ...sc, hasFile: true } })).body.needFile, false);
});

test("a phone's Yandex file replaces the copy the PC found, unless the song keeps its copy (marked uncensored)", async (t) => {
  const yandex = { platform: 'yandex', id: 'ym4', url: 'https://music.yandex.ru/track/4', title: 'Song', artist: 'Lida', duration: 180, reason: 'liked' };
  const { api, settle, svc } = await start(t, { fails: (u) => u.includes('yandex'), found: { id: 'yt9', url: 'https://www.youtube.com/watch?v=yt9' } });
  const { body } = await api('/ingest', { method: 'POST', body: yandex });
  await settle();
  const found = svc.store.get(body.id).file.size;
  await api(`/songs/${body.id}`, { method: 'PATCH', body: { keep: true } });
  assert.strictEqual((await api('/ingest', { method: 'POST', body: { ...yandex, hasFile: true } })).body.needFile, false);
  await api(`/songs/${body.id}/file?ext=mp3&from=yandex`, { method: 'PUT', body: Buffer.alloc(300 * 1024, 9) });
  assert.strictEqual(svc.store.get(body.id).file.size, found);
  await api(`/songs/${body.id}`, { method: 'PATCH', body: { keep: false } });
  assert.strictEqual((await api('/ingest', { method: 'POST', body: { ...yandex, hasFile: true } })).body.needFile, true);
  await api(`/songs/${body.id}/file?ext=mp3&from=yandex`, { method: 'PUT', body: Buffer.alloc(300 * 1024, 9) });
  assert.strictEqual(svc.store.get(body.id).file.size, 300 * 1024);
  assert.strictEqual((await api('/catalog')).body.songs[0].yandexFile, true);
});

test('a YouTube song is downloaded by the PC even when the phone has it', async (t) => {
  const { api, settle, calls } = await start(t);
  const r = (await api('/ingest', { method: 'POST', body: { ...song, hasFile: true } })).body;
  await settle();
  assert.strictEqual(r.needFile, false);
  assert.strictEqual(calls.length, 1);
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
  const edited = (await api(`/songs/${body.id}`, { method: 'PATCH', body: { title: 'Song (Acoustic)', artist: 'Lida', album: 'Home' } })).body;
  assert.strictEqual(edited.locked, true);
  assert.deepStrictEqual(edited.original, { title: 'Lida - Song', artist: 'minecrafter' });
  const c = (await api('/catalog')).body.songs[0];
  assert.strictEqual(`${c.artist} - ${c.title} / ${c.album}`, 'Lida - Song (Acoustic) / Home');
  assert.strictEqual(svc.store.songs[0].title, 'Song (Acoustic)');
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

test('a phone asking again while the PC is still downloading does not start a second download', async (t) => {
  const { api, calls, settle } = await start(t, { delayMs: 150 });
  await api('/ingest', { method: 'POST', body: song });
  await new Promise((r) => setTimeout(r, 30));
  await api('/ingest', { method: 'POST', body: song });
  await api('/ingest', { key: KEY2, method: 'POST', body: song });
  await settle();
  assert.strictEqual(calls.length, 1);
});

// ---- names (metadata.js) ----
const sure = { source: 'itunes:1', title: 'Song', artist: 'Lida', album: 'First Album', year: '2021', cover: 'https://x/c.jpg', duration: 181 };
const other = { source: 'deezer:2', title: 'Another Song', artist: 'Somebody', album: 'B', year: '', cover: '', duration: 240 };

test('a catalogue that is sure renames the song, and the file gets the new tags', async (t) => {
  const { api, settle, svc, tagged } = await start(t, { candidates: [other, sure] });
  await api('/ingest', { method: 'POST', body: song });
  await settle();
  const s = svc.store.songs[0];
  assert.strictEqual(s.match.status, 'auto');
  assert.deepStrictEqual([s.artist, s.title, s.album, s.year], ['Lida', 'Song', 'First Album', '2021']);
  assert.deepStrictEqual(s.original, { title: 'Lida - Song', artist: 'minecrafter' });
  assert.deepStrictEqual(tagged, ['Lida - Song']);
  assert.strictEqual((await api('/catalog')).body.songs[0].named, true);
});

test('an unsure answer keeps the cleaned-up upload name and waits for review; picking a guess confirms it', async (t) => {
  const { api, settle, svc, tagged } = await start(t, { candidates: [{ ...sure, title: 'Song Two', duration: 300 }] });
  const { body } = await api('/ingest', { method: 'POST', body: song });
  await settle();
  let s = svc.store.get(body.id);
  assert.strictEqual(s.match.status, 'review');
  assert.deepStrictEqual([s.artist, s.title], ['Lida', 'Song']);
  assert.strictEqual((await api('/review')).body.songs.length, 1);
  await api(`/songs/${body.id}/match`, { method: 'POST', body: { index: 0 } });
  await settle();
  s = svc.store.get(body.id);
  assert.strictEqual(s.match.status, 'confirmed');
  assert.strictEqual(s.locked, true);
  assert.strictEqual(s.title, 'Song Two');
  assert.strictEqual((await api('/review')).body.songs.length, 0);
  assert.deepStrictEqual(tagged, ['Lida - Song', 'Lida - Song Two']); // tagged again with the confirmed names
});

test('names typed by hand are never replaced by a catalogue', async (t) => {
  const { api, settle, svc } = await start(t, { candidates: [sure] });
  const { body } = await api('/ingest', { method: 'POST', body: { ...song, id: 'other1' } });
  await settle();
  await api(`/songs/${body.id}`, { method: 'PATCH', body: { title: 'My Title' } });
  await settle();
  svc.resume(); // a restart asks again about songs that need it
  await settle();
  assert.strictEqual(svc.store.get(body.id).title, 'My Title');
});

test('searching again with better words replaces the guesses', async (t) => {
  const { api, settle } = await start(t, { candidates: [other] });
  const { body } = await api('/ingest', { method: 'POST', body: song });
  await settle();
  const r = await api(`/songs/${body.id}/search`, { method: 'POST', body: { artist: 'Somebody', title: 'Another Song' } });
  assert.strictEqual(r.body.candidates[0].source, 'deezer:2');
});

test('the library page opens only on the PC itself', async (t) => {
  const { svc } = await start(t);
  const base = `http://127.0.0.1:${svc.server.address().port}`;
  const local = await fetch(`${base}/ui`);
  assert.strictEqual(local.status, 200);
  assert.ok((await local.text()).includes(KEY));
  const viaTunnel = await fetch(`${base}/ui`, { headers: { 'cf-connecting-ip': '1.2.3.4' } });
  assert.strictEqual(viaTunnel.status, 403);
});

test('versions of a song form one group; by hand a song joins another or stands alone', async (t) => {
  const { api, settle } = await start(t);
  const add = async (id, title, artist = 'МУККА') => (await api('/ingest', { method: 'POST', body: { platform: 'youtube', id, title, artist, duration: 157, reason: 'liked' } })).body.id;
  const plain = await add('v1', 'Девочка с каре');
  const raw = await add('v2', 'Девочка с каре (без цензуры)');
  const piano = await add('v3', 'Девочка с каре (Piano)');
  const other = await add('v4', 'Другая песня');
  const cover = await add('v5', 'Девочка с каре', 'Someone Else');
  await settle();
  const groups = async () => Object.fromEntries((await api('/catalog')).body.songs.map((s) => [s.id, [s.group, s.version]]));
  let g = await groups();
  assert.deepStrictEqual(g[raw], [plain, 'без цензуры']);
  assert.strictEqual(g[piano][0], plain);
  assert.strictEqual(g[other][0], other);
  assert.strictEqual(g[cover][0], cover); // another artist's song of that name is another song
  await api(`/songs/${piano}/group`, { method: 'POST', body: { with: null } });
  await api(`/songs/${other}/group`, { method: 'POST', body: { with: raw } });
  g = await groups();
  assert.strictEqual(g[piano][0], piano);
  assert.strictEqual(g[other][0], plain);
  await api(`/songs/${piano}/group`, { method: 'POST', body: { with: 'auto' } });
  assert.strictEqual((await groups())[piano][0], plain);
});

test('the catalog says which songs the PC keeps the cover of', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-lib-'));
  const store = new Store(dir);
  const { song: a } = store.ingest({ platform: 'youtube', id: 'a', title: 'A', artist: 'X' });
  store.ingest({ platform: 'youtube', id: 'b', title: 'B', artist: 'X' });
  fs.mkdirSync(path.join(dir, 'covers'));
  fs.writeFileSync(path.join(dir, 'covers', `${a.id}.jpg`), 'jpg');
  assert.deepStrictEqual(store.catalog().songs.map((s) => !!s.coverFile), [true, false]);
  fs.rmSync(dir, { recursive: true, force: true });
});
