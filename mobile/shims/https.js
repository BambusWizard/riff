// `https.get/request` over fetch. In the iOS app CapacitorHttp patches fetch to native HTTP,
// so there is no CORS; in the browser test harness the bridge routes it through a dev proxy.
const { EventEmitter } = require('events');

function normalizeArgs(a, b, c) {
  let url, opts = {}, cb;
  if (typeof a === 'string' || a instanceof URL) { url = String(a); if (typeof b === 'function') cb = b; else { opts = b || {}; cb = c; } }
  else { opts = a || {}; cb = typeof b === 'function' ? b : c; url = `${opts.protocol || 'https:'}//${opts.hostname || opts.host}${opts.path || '/'}`; }
  return { url, opts, cb };
}

function request(a, b, c) {
  const { url, opts, cb } = normalizeArgs(a, b, c);
  const req = new EventEmitter();
  const ctrl = new AbortController();
  let body = '';
  let timer = null;
  let sent = false;
  const armTimeout = (ms) => {
    clearTimeout(timer);
    if (ms) timer = setTimeout(() => req.emit('timeout'), ms);
  };
  armTimeout(opts.timeout);

  req.setTimeout = (ms, fn) => { if (fn) req.on('timeout', fn); armTimeout(ms); return req; };
  req.write = (c) => { body += typeof c === 'string' ? c : new TextDecoder().decode(c); return true; };
  req.destroy = (e) => { clearTimeout(timer); ctrl.abort(); req.emit('error', e || new Error('socket hang up')); };
  req.end = (c) => {
    if (c) req.write(c);
    if (sent) return req;
    sent = true;
    const headers = { ...(opts.headers || {}) };
    delete headers['Content-Length']; delete headers['content-length']; delete headers.host; delete headers.Host;
    const method = (opts.method || 'GET').toUpperCase();
    globalThis.__riffFetch(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body, signal: ctrl.signal })
      .then(async (r) => {
        const text = await r.text();
        clearTimeout(timer);
        const res = new EventEmitter();
        res.statusCode = r.status;
        res.headers = Object.fromEntries([...r.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
        res.setEncoding = () => res;
        res.pipe = (dest) => { dest.write(text); dest.end(); return dest; };
        if (cb) cb(res);
        req.emit('response', res);
        setTimeout(() => { res.emit('data', text); res.emit('end'); }, 0);
      })
      .catch((e) => { clearTimeout(timer); if (e.name !== 'AbortError') req.emit('error', e); });
    return req;
  };
  return req;
}

function get(a, b, c) {
  const req = request(a, b, c);
  req.end();
  return req;
}

module.exports = { request, get };
