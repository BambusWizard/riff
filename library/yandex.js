'use strict';

// Yandex Music for the library: its catalogue (names, albums, covers) and its full MP3s. Yandex answers only Russian
// addresses, so a PC elsewhere (or behind a VPN) asks through the Riff worker, as the phones do: the worker relays the
// API through Russia and adds the account's token there (Plus gives the full tracks). The audio files themselves are
// served anywhere and are fetched direct. Off until the worker and its access key are known (config.json).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseName, similarity, artistSimilarity, versionOf } = require('./names');

const UA = 'Mozilla/5.0';
const RELAYED = ['api.music.yandex.net', 'storage.mds.yandex.net'];
// Yandex's "explicit" mark is only 18+: its censored releases (words muted into a mush) carry it too. Uncensored is
// what the name says, nothing else
const UNCENSORED = /без\s*цензуры|без\s*мата|uncensored|нецензур/i;

let via = () => null; // -> { worker, key } or null
function configure(getter) { via = getter; }
const enabled = () => { const v = via(); return !!(v && v.worker && v.key); };

async function get(url, as = 'json', ms = 15000) {
  const v = via();
  const relayed = RELAYED.includes(new URL(url).hostname);
  if (relayed && !(v && v.worker && v.key)) throw new Error('Yandex Music: no worker to reach it through');
  const target = relayed ? `${v.worker.replace(/\/$/, '')}/__proxy?url=${encodeURIComponent(url)}` : url;
  const headers = relayed ? { 'x-riff-key': v.key, 'x-fwd-headers': JSON.stringify({ 'User-Agent': UA }) } : { 'User-Agent': UA };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(target, { headers, signal: ctl.signal });
    if (!r.ok) throw new Error(`Yandex Music: ${r.status}`);
    return as === 'json' ? await r.json() : as === 'text' ? await r.text() : Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(timer); }
}

const titleOf = (x) => (x.version ? `${x.title} (${x.version})` : x.title);
const isUncensored = (x) => UNCENSORED.test(titleOf(x));

async function search(artist, title) {
  const j = await get(`https://api.music.yandex.net/search?type=track&page=0&text=${encodeURIComponent(`${artist} ${title}`)}`);
  return (((j.result || {}).tracks || {}).results) || [];
}

// the catalogue's candidates, as lookup.js wants them
async function candidates(artist, title) {
  return (await search(artist, title)).slice(0, 5).map((x) => {
    const album = (x.albums || [])[0] || {};
    const cover = x.coverUri || album.coverUri || '';
    return {
      source: `yandex:${x.id}`, title: titleOf(x), artist: (x.artists || []).map((a) => a.name).join(', '),
      album: album.title || '', year: String(album.year || ''), cover: cover ? `https://${cover.replace('%%', '600x600')}` : '', duration: Math.round((x.durationMs || 0) / 1000),
    };
  });
}

// The Yandex track for a song: the same song (name, version, artist, length), the song's own track (the one a phone
// played) first, and a release named uncensored over it ("Song" and "Song (без цензуры)" are one song here)
async function trackFor(song) {
  const p = parseName(song.title, song.artist);
  const want = versionOf(p.title);
  const wantVersion = want.version.replace(UNCENSORED, '').replace(/[\s·]+/g, ' ').trim();
  const mustBeUncensored = UNCENSORED.test(want.version); // never the censored release for "Song (без цензуры)"
  let best = null;
  for (const x of await search(p.artist, want.base || p.title)) {
    if (x.available === false || (mustBeUncensored && !isUncensored(x))) continue;
    const v = versionOf(titleOf(x));
    const version = v.version.replace(UNCENSORED, '').replace(/[\s·]+/g, ' ').trim();
    const t = similarity(v.base, want.base);
    const a = artistSimilarity((x.artists || []).map((n) => n.name).join(', '), p.artist);
    const dur = Math.round((x.durationMs || 0) / 1000);
    if (t < 0.85 || a < 0.7 || similarity(version, wantVersion) < (version || wantVersion ? 0.8 : 0)) continue;
    if (song.duration && dur && Math.abs(song.duration - dur) > Math.max(10, song.duration * 0.06)) continue;
    // the song's own track (the one a phone played) over the same recording on another release
    const own = (song.sources || []).includes(`yandex:${x.id}`);
    const s = t + a + (isUncensored(x) ? 2 : 0) + (own ? 0.5 : 0);
    if (!best || s > best.s) best = { s, id: String(x.id), uncensored: isUncensored(x), title: titleOf(x) };
  }
  return best;
}

// Yandex download links are signed with this salt (the same as the phones' extract.js)
async function download(trackId, dir, base) {
  const info = await get(`https://api.music.yandex.net/tracks/${trackId}/download-info`);
  const options = (Array.isArray(info.result) ? info.result : []).filter((x) => x.codec === 'mp3' && !x.preview).sort((a, b) => b.bitrateInKbps - a.bitrateInKbps);
  if (!options.length) throw new Error(`Yandex Music has no full track for ${trackId} (${(info.result && info.result.message) || 'token or Plus missing'})`);
  const xml = await get(options[0].downloadInfoUrl, 'text');
  const tag = (t) => (xml.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1] || '';
  const p = tag('path');
  const sign = crypto.createHash('md5').update(`XGRlBW9FXlekgbPrRHuSiA${p.slice(1)}${tag('s')}`).digest('hex');
  const data = await get(`https://${tag('host')}/get-mp3/${sign}/${tag('ts')}${p}`, 'buffer', 5 * 60 * 1000);
  if (data.length < 100 * 1024) throw new Error('Yandex Music sent no song');
  const name = `${base}.mp3`;
  fs.writeFileSync(path.join(dir, `${name}.part`), data);
  fs.renameSync(path.join(dir, `${name}.part`), path.join(dir, name));
  return { name, size: data.length };
}

module.exports = { configure, enabled, candidates, trackFor, download };
