// `dns.promises.lookup` for the iOS/Android build. A WebView has no resolver, so names are resolved
// over DNS-over-HTTPS (Cloudflare), keeping server.js's private-address (SSRF) check meaningful.
async function query(host, type) {
  const r = await globalThis.__riffFetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' } });
  const j = await r.json();
  const want = type === 'A' ? 1 : 28;
  return (j.Answer || []).filter((a) => a.type === want).map((a) => ({ address: a.data, family: type === 'A' ? 4 : 6 }));
}

async function lookup(host, opts = {}) {
  const [v4, v6] = await Promise.all([query(host, 'A').catch(() => []), query(host, 'AAAA').catch(() => [])]);
  const all = [...v4, ...v6];
  if (!all.length) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return opts.all ? all : all[0];
}

module.exports = { promises: { lookup }, lookup: (host, opts, cb) => { const done = typeof opts === 'function' ? opts : cb; lookup(host, typeof opts === 'object' ? opts : {}).then((r) => done(null, r.address, r.family), done); } };
