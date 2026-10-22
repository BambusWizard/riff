'use strict';

// Lets the phones reach the library service from anywhere, not only at home: a Cloudflare quick tunnel
// (cloudflared, no account or domain needed) gives the PC a public https address. The address is new on every
// start, so the service tells the Riff worker the current one (/__library); phones ask the worker for it.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BIN_DIR, IS_WIN, resolveBinary, clearBinaryCache } = require('../platform');
const { getText, downloadFile } = require('../tools');

function cloudflaredAsset() {
  const a = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? '386' : 'amd64';
  if (IS_WIN) return `cloudflared-windows-${a}.exe`;
  if (process.platform === 'linux') return `cloudflared-linux-${a}`;
  return null; // macOS: brew install cloudflared
}

// cloudflared next to yt-dlp, checked against the sha256 GitHub publishes for the release file
async function ensureCloudflared(log) {
  const found = resolveBinary('cloudflared');
  if (found) return found;
  const name = cloudflaredAsset();
  if (!name) throw new Error('install cloudflared yourself (macOS: brew install cloudflared)');
  log('installing cloudflared…');
  const rel = JSON.parse(await getText('https://api.github.com/repos/cloudflare/cloudflared/releases/latest'));
  const asset = (rel.assets || []).find((x) => x.name === name);
  const want = asset && /^sha256:([0-9a-f]{64})$/.exec(asset.digest || '');
  if (!asset || !want) throw new Error(`no checksummed ${name} in cloudflared ${rel.tag_name}`);
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const dest = path.join(BIN_DIR, IS_WIN ? 'cloudflared.exe' : 'cloudflared');
  const tmp = `${dest}.download`;
  const got = await downloadFile(asset.browser_download_url, tmp);
  if (got !== want[1]) { fs.rmSync(tmp, { force: true }); throw new Error('cloudflared checksum mismatch'); }
  if (!IS_WIN) fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);
  clearBinaryCache();
  return dest;
}

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// runs the tunnel for as long as the service runs; onUrl(url) on every (re)start with its new address
function startTunnel(bin, port, onUrl, log, onSpawn = () => {}) {
  let proc = null;
  let stopped = false;
  const run = () => {
    proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { windowsHide: true });
    if (proc.pid) onSpawn(proc.pid);
    let announced = false;
    const scan = (d) => {
      const m = !announced && TUNNEL_URL.exec(String(d));
      if (m) { announced = true; onUrl(m[0]); }
    };
    proc.stdout.on('data', scan);
    proc.stderr.on('data', scan); // cloudflared logs to stderr
    proc.on('error', (e) => log(`! tunnel: ${e.message}`));
    proc.on('close', (code) => {
      if (stopped) return;
      log(`! tunnel closed (${code}), restarting in 10 s`);
      setTimeout(run, 10000);
    });
  };
  run();
  const stop = () => { stopped = true; try { proc.kill(); } catch (e) {} };
  process.on('exit', stop);
  return { stop };
}

// tells the worker where the library is and which library key each person's phone should use
async function register(worker, workerKey, url, users) {
  const keys = {};
  for (const [key, user] of Object.entries(users)) keys[user] = key;
  const r = await fetch(`${worker.replace(/\/+$/, '')}/__library`, {
    method: 'POST',
    headers: { 'x-riff-key': workerKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, keys }),
  });
  if (!r.ok) throw new Error(`worker answered ${r.status}: ${(await r.text()).slice(0, 120)}`);
}

module.exports = { ensureCloudflared, startTunnel, register };
