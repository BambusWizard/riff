// Node `fs` for the iOS build. server.js mixes sync and async calls, so every file lives in an
// in-memory index (text files keep their contents; audio/images only size + mtime) and writes go
// through to the store in the background. init() must finish before server.js is required.
const path = require('path');
const store = require('./store');

const TEXT_EXT = /\.(json|lrc|txt)$/i;
const nodes = new Map(); // vpath -> { isDir, size, mtimeMs, text? }
let chain = Promise.resolve();
const persist = (fn) => { chain = chain.then(fn).catch((e) => console.warn('[fs] persist failed', e)); return chain; };

const norm = (p) => path.resolve('/', String(p).replace(/\\/g, '/'));
const err = (code, p) => Object.assign(new Error(`${code}: ${p}`), { code, path: p });

function ensureParents(p) {
  let dir = path.dirname(p);
  while (dir && dir !== '/' && !nodes.has(dir)) {
    nodes.set(dir, { isDir: true, size: 0, mtimeMs: Date.now() });
    dir = path.dirname(dir);
  }
}

function makeStat(n) {
  return {
    size: n.size, mtimeMs: n.mtimeMs, mtime: new Date(n.mtimeMs), atimeMs: n.mtimeMs, ctimeMs: n.mtimeMs,
    isFile: () => !n.isDir, isDirectory: () => n.isDir,
  };
}

function childrenOf(dir) {
  const prefix = dir === '/' ? '/' : dir + '/';
  const out = [];
  for (const [p, n] of nodes) {
    if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/') && p !== dir) out.push([path.basename(p), n]);
  }
  return out;
}

function toText(data, enc) {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  return String(data);
}

function bytesOf(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function writeSyncImpl(p, data) {
  p = norm(p);
  ensureParents(p);
  const isText = TEXT_EXT.test(p) || typeof data === 'string';
  const bytes = bytesOf(data);
  nodes.set(p, { isDir: false, size: bytes.length, mtimeMs: Date.now(), text: isText ? toText(data) : undefined });
  return persist(() => (isText ? store.writeText(p, toText(data)) : store.writeBytes(p, bytes)));
}

function removeTree(p) {
  for (const k of [...nodes.keys()]) if (k === p || k.startsWith(p + '/')) nodes.delete(k);
}

const fs = {
  constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },

  async init() {
    const entries = await store.list();
    nodes.set('/data', { isDir: true, size: 0, mtimeMs: Date.now() });
    for (const e of entries) nodes.set(e.vpath, { isDir: e.isDir, size: e.size, mtimeMs: e.mtimeMs });
    await Promise.all(entries.filter((e) => !e.isDir && TEXT_EXT.test(e.vpath)).map(async (e) => {
      try { nodes.get(e.vpath).text = await store.readText(e.vpath); } catch (x) {}
    }));
  },

  // Called by the stream bridge after a native download lands on disk.
  _register(p, size) {
    p = norm(p);
    ensureParents(p);
    nodes.set(p, { isDir: false, size, mtimeMs: Date.now() });
  },
  _flush: () => chain,

  existsSync: (p) => nodes.has(norm(p)),
  accessSync: (p) => { if (!nodes.has(norm(p))) throw err('ENOENT', p); },
  chmodSync: () => {},

  mkdirSync(p) {
    p = norm(p);
    if (nodes.has(p)) return;
    ensureParents(p);
    nodes.set(p, { isDir: true, size: 0, mtimeMs: Date.now() });
    persist(() => store.mkdir(p));
  },
  mkdtempSync(prefix) {
    const p = norm(prefix + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(p);
    return p;
  },

  readFileSync(p, enc) {
    const n = nodes.get(norm(p));
    if (!n || n.isDir) throw err('ENOENT', p);
    if (n.text === undefined) throw err('EIO', p + ' (binary file not held in memory)');
    return n.text;
  },
  writeFileSync: (p, data) => { writeSyncImpl(p, data); },

  statSync(p) {
    const n = nodes.get(norm(p));
    if (!n) throw err('ENOENT', p);
    return makeStat(n);
  },
  readdirSync(p, opts) {
    p = norm(p);
    if (!nodes.has(p)) throw err('ENOENT', p);
    const kids = childrenOf(p);
    if (opts && opts.withFileTypes) return kids.map(([name, n]) => ({ name, isFile: () => !n.isDir, isDirectory: () => n.isDir }));
    return kids.map(([name]) => name);
  },
  unlinkSync(p) {
    p = norm(p);
    if (!nodes.has(p)) throw err('ENOENT', p);
    nodes.delete(p);
    persist(() => store.remove(p, false));
  },
  rmSync(p) {
    p = norm(p);
    const n = nodes.get(p);
    if (!n) return;
    removeTree(p);
    persist(() => store.remove(p, n.isDir));
  },
  renameSync(a, b) {
    a = norm(a); b = norm(b);
    const n = nodes.get(a);
    if (!n) throw err('ENOENT', a);
    nodes.delete(a);
    ensureParents(b);
    nodes.set(b, { ...n, mtimeMs: Date.now() });
    persist(() => store.rename(a, b));
  },
  copyFileSync(a, b) {
    a = norm(a); b = norm(b);
    const n = nodes.get(a);
    if (!n) throw err('ENOENT', a);
    ensureParents(b);
    nodes.set(b, { ...n, mtimeMs: Date.now() });
    persist(() => store.copy(a, b));
  },

  // Audio/thumbnail routes pipe a file into the response; the fake response turns that into a file URL.
  createReadStream(p, opts) {
    const vpath = norm(p);
    return { __vpath: vpath, on() { return this; }, pipe(dest) { if (dest.__pipeFile) dest.__pipeFile(vpath); return dest; } };
  },
  createWriteStream() {
    throw err('ENOTSUP', 'createWriteStream');
  },
};

fs.promises = {
  stat: async (p) => fs.statSync(p),
  readdir: async (p, opts) => fs.readdirSync(p, opts),
  readFile: async (p, enc) => fs.readFileSync(p, enc),
  writeFile: async (p, data) => { await writeSyncImpl(p, data); },
  unlink: async (p) => fs.unlinkSync(p),
  rename: async (a, b) => fs.renameSync(a, b),
  copyFile: async (a, b) => fs.copyFileSync(a, b),
  mkdir: async (p) => fs.mkdirSync(p),
  rmdir: async (p) => fs.rmSync(p),
  rm: async (p) => fs.rmSync(p),
  utimes: async (p) => { const n = nodes.get(norm(p)); if (n) n.mtimeMs = Date.now(); },
};

module.exports = fs;
