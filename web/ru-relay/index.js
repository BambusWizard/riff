// Yandex Cloud Function: fetches Yandex Music from a Russian IP for the Riff proxy (web/worker.js).
// Yandex Music answers only Russian IPs, and Cloudflare isn't one. The Worker checks the user's key,
// adds the user's Yandex token and calls this function with the shared RELAY_SECRET.
// Call: GET/POST <function url>?url=<target>, real request headers JSON-encoded in x-fwd-headers.

const hostAllowed = (h) => h === 'yandex.ru' || h.endsWith('.yandex.ru') || h === 'yandex.net' || h.endsWith('.yandex.net');
const DROP = /^(content-encoding|content-length|transfer-encoding|connection|set-cookie|alt-svc|strict-transport-security)$/i;

module.exports.handler = async (event) => {
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (!process.env.RELAY_SECRET || headers['x-relay-secret'] !== process.env.RELAY_SECRET) return { statusCode: 401, body: 'not allowed' };

  let target;
  try { target = new URL((event.queryStringParameters || {}).url); } catch (e) { return { statusCode: 400, body: 'bad url' }; }
  if (target.protocol !== 'https:' || !hostAllowed(target.hostname)) return { statusCode: 403, body: `host not allowed: ${target.hostname}` };

  let fwd = {};
  try { fwd = JSON.parse(headers['x-fwd-headers'] || '{}'); } catch (e) {}
  const method = (event.httpMethod || 'GET').toUpperCase();
  const body = ['GET', 'HEAD'].includes(method) || !event.body ? undefined : Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');

  const r = await fetch(target.href, { method, headers: fwd, body, redirect: 'follow' });
  const out = {};
  r.headers.forEach((v, k) => { if (!DROP.test(k)) out[k] = v; });
  return { statusCode: r.status, headers: out, body: Buffer.from(await r.arrayBuffer()).toString('base64'), isBase64Encoded: true };
};
