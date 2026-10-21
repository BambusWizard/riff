// `http.createServer` for the iOS build: there is no socket. The bridge calls dispatch() with a
// request and gets back { status, headers, body, file } where `file` is set when a route piped a file.
const { EventEmitter } = require('events');
const https = require('./https');

let handler = null;

function dispatch({ url, method = 'GET', headers = {}, body = '' }) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.url = url;
    req.method = method.toUpperCase();
    req.headers = { host: '127.0.0.1', ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
    req.pipe = (dest) => { if (body) dest.write(body); dest.end(); return dest; };

    const res = new EventEmitter();
    let chunks = '';
    let done = false;
    const finish = (extra) => {
      if (done) return;
      done = true;
      resolve({ status: res.statusCode, headers: res._headers, body: chunks, ...extra });
    };
    Object.assign(res, {
      statusCode: 200,
      _headers: {},
      headersSent: false,
      setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
      getHeader(k) { return this._headers[k.toLowerCase()]; },
      writeHead(status, h) {
        this.statusCode = status;
        if (h) for (const [k, v] of Object.entries(h)) this.setHeader(k, v);
        this.headersSent = true;
        return this;
      },
      write(c) { chunks += typeof c === 'string' ? c : new TextDecoder().decode(c); return true; },
      end(c) { if (c) this.write(c); finish(); },
      __pipeFile(vpath) { finish({ file: vpath }); },
    });

    Promise.resolve(handler(req, res)).catch((e) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e && e.message || e));
    });
    setTimeout(() => {
      if (body) req.emit('data', body);
      req.emit('end');
    }, 0);
  });
}

module.exports = {
  createServer(h) {
    handler = h;
    const server = new EventEmitter();
    server.listening = false;
    server.listen = (port, host, cb) => { server.listening = true; server._port = port; if (cb) setTimeout(cb, 0); return server; };
    server.address = () => ({ port: server._port });
    return server;
  },
  request: https.request,
  get: https.get,
  dispatch,
};
