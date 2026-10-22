// The worker's /__library: the PC service registers its address (no Origin: it isn't a browser), phones read it
// back with their own library key. The rest of the worker must still refuse requests from unknown origins.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

// worker.js is an ES module for Cloudflare, but package.json makes .js CommonJS here: load its source as a module
const src = readFileSync(new URL('../web/worker.js', import.meta.url), 'utf8');
const { default: worker } = await import(`data:text/javascript,${encodeURIComponent(src)}`);

const ORIGIN = 'https://bambuswizard.github.io';
function env() {
  const kv = new Map();
  return {
    ALLOWED_ORIGINS: ORIGIN,
    USERS: JSON.stringify({ 'key-main': 'main', 'key-2': 'user2' }),
    RIFF_DATA: {
      get: async (k, type) => (kv.has(k) ? (type === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
      put: async (k, v) => { kv.set(k, v); },
    },
  };
}
const req = (path, { method = 'GET', key, origin, body } = {}) => new Request(`https://w.example${path}`, {
  method, body: body && JSON.stringify(body),
  headers: { ...(key ? { 'x-riff-key': key } : {}), ...(origin ? { origin } : {}) },
});

test('the PC registers its tunnel and each phone gets its own library key', async () => {
  const e = env();
  const reg = await worker.fetch(req('/__library', { method: 'POST', key: 'key-main', body: { url: 'https://abc.trycloudflare.com', keys: { main: 'lib-1', user2: 'lib-2' } } }), e);
  assert.strictEqual(reg.status, 200);
  const mine = await (await worker.fetch(req('/__library', { key: 'key-main', origin: ORIGIN }), e)).json();
  assert.strictEqual(mine.url, 'https://abc.trycloudflare.com');
  assert.strictEqual(mine.key, 'lib-1');
  const hers = await (await worker.fetch(req('/__library', { key: 'key-2', origin: ORIGIN }), e)).json();
  assert.strictEqual(hers.key, 'lib-2');
});

test('registering needs a valid access key, and only an https address is accepted', async () => {
  const e = env();
  assert.strictEqual((await worker.fetch(req('/__library', { method: 'POST', key: 'wrong', body: { url: 'https://x.trycloudflare.com' } }), e)).status, 401);
  assert.strictEqual((await worker.fetch(req('/__library', { method: 'POST', key: 'key-main', body: { url: 'http://evil.example/x?y' } }), e)).status, 400);
});

test('without an Origin only the registration is let through; the proxy and sync still are not', async () => {
  const e = env();
  assert.strictEqual((await worker.fetch(req('/__library', { key: 'key-main' }), e)).status, 403);
  assert.strictEqual((await worker.fetch(req('/__sync', { key: 'key-main' }), e)).status, 403);
  assert.strictEqual((await worker.fetch(req('/__proxy?url=https://www.youtube.com/', { key: 'key-main' }), e)).status, 403);
});

test('nothing registered yet: phones get an empty address', async () => {
  const r = await (await worker.fetch(req('/__library', { key: 'key-main', origin: ORIGIN }), env())).json();
  assert.deepStrictEqual(r, { url: '', key: '', at: 0 });
});
