// Persistent storage behind the fs shim. Virtual paths under /data map to
// Capacitor Filesystem paths under Documents/Riff, visible in the Files app (IndexedDB in a browser).
const { Filesystem, Directory, Encoding } = require('@capacitor/filesystem');
const { Capacitor } = require('@capacitor/core');

const ROOT = 'Riff';
// iOS: Documents (shown in the Files app). Android: app-private storage; public Documents needs permissions.
const DIR = Capacitor.getPlatform() === 'android' ? Directory.Data : Directory.Documents;

const toReal = (vpath) => ROOT + vpath.replace(/^\/data/, '');
const toVirtual = (rpath) => '/data' + rpath.slice(ROOT.length);

function b64FromBytes(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

async function walk(rpath, out) {
  let res;
  try { res = await Filesystem.readdir({ path: rpath, directory: DIR }); } catch (e) { return; }
  for (const f of res.files) {
    const child = `${rpath}/${f.name}`;
    const isDir = f.type === 'directory';
    out.push({ vpath: toVirtual(child), isDir, size: f.size || 0, mtimeMs: Number(f.mtime) || Date.now() });
    if (isDir) await walk(child, out);
  }
}

module.exports = {
  isNative: () => Capacitor.isNativePlatform(),

  async list() {
    try { await Filesystem.mkdir({ path: ROOT, directory: DIR, recursive: true }); } catch (e) {}
    const out = [];
    await walk(ROOT, out);
    return out;
  },

  async readText(vpath) {
    const r = await Filesystem.readFile({ path: toReal(vpath), directory: DIR, encoding: Encoding.UTF8 });
    return typeof r.data === 'string' ? r.data : await r.data.text();
  },

  async writeText(vpath, text) {
    await Filesystem.writeFile({ path: toReal(vpath), directory: DIR, data: text, encoding: Encoding.UTF8, recursive: true });
  },

  async writeBytes(vpath, bytes) {
    await Filesystem.writeFile({ path: toReal(vpath), directory: DIR, data: b64FromBytes(bytes), recursive: true });
  },

  async remove(vpath, isDir) {
    if (isDir) await Filesystem.rmdir({ path: toReal(vpath), directory: DIR, recursive: true });
    else await Filesystem.deleteFile({ path: toReal(vpath), directory: DIR });
  },

  async mkdir(vpath) {
    try { await Filesystem.mkdir({ path: toReal(vpath), directory: DIR, recursive: true }); } catch (e) {}
  },

  async rename(from, to) {
    await Filesystem.rename({ from: toReal(from), to: toReal(to), directory: DIR, toDirectory: DIR });
  },

  async copy(from, to) {
    await Filesystem.copy({ from: toReal(from), to: toReal(to), directory: DIR, toDirectory: DIR });
  },

  // Streams a remote file straight to disk natively; returns the byte size.
  async download(url, vpath, headers = {}) {
    if (!Capacitor.isNativePlatform()) {
      // browser harness: downloadFile would hit CORS, so go through the dev proxy
      const r = await globalThis.__riffFetch(url, { headers });
      if (!r.ok) throw new Error(`download failed: ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      await Filesystem.writeFile({ path: toReal(vpath), directory: DIR, data: b64FromBytes(bytes), recursive: true });
      return bytes.length;
    }
    await Filesystem.downloadFile({ url, path: toReal(vpath), directory: DIR, recursive: true, headers });
    const st = await Filesystem.stat({ path: toReal(vpath), directory: DIR });
    return st.size || 0;
  },

  // A URL the WebView can load directly (same origin, so Web Audio can process it).
  async fileUrl(vpath, mime) {
    if (Capacitor.isNativePlatform()) {
      const { uri } = await Filesystem.getUri({ path: toReal(vpath), directory: DIR });
      return Capacitor.convertFileSrc(uri);
    }
    const r = await Filesystem.readFile({ path: toReal(vpath), directory: DIR });
    const blob = r.data instanceof Blob ? r.data : await (await fetch(`data:${mime || 'application/octet-stream'};base64,${r.data}`)).blob();
    return URL.createObjectURL(blob);
  },
};
