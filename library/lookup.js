'use strict';

// Asks music catalogues what a song really is. Each one answers with candidates in the same shape:
// { source, title, artist, album, year, cover, duration }. Catalogues that can't be reached (blocked, down) are
// skipped. None needs an account. Yandex Music answers only Russian addresses, so from many PCs it is skipped.

const { parseName, similarity, artistSimilarity } = require('./names');

const UA = 'Riff-Library/1.0 (https://github.com/bambuswizard/riff)';

async function getJson(url, ms = 10000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    if (!r.ok) throw new Error(`${new URL(url).hostname}: ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

const year = (d) => (/^\d{4}/.exec(String(d || '')) || [''])[0];

const catalogues = {
  // the Russian store first: it knows Russian artists by their own names
  async itunes(artist, title) {
    const out = [];
    for (const country of ['ru', 'us']) {
      const j = await getJson(`https://itunes.apple.com/search?entity=song&limit=5&country=${country}&term=${encodeURIComponent(`${artist} ${title}`)}`);
      for (const x of j.results || []) {
        out.push({
          source: `itunes:${x.trackId}`, title: x.trackName, artist: x.artistName, album: String(x.collectionName || '').replace(/ - (Single|EP)$/, ''),
          year: year(x.releaseDate), cover: String(x.artworkUrl100 || '').replace(/100x100bb/, '600x600bb'), duration: Math.round((x.trackTimeMillis || 0) / 1000),
        });
      }
      if (out.length) break;
    }
    return out;
  },
  async deezer(artist, title) {
    const j = await getJson(`https://api.deezer.com/search?limit=5&q=${encodeURIComponent(`artist:"${artist}" track:"${title}"`)}`);
    return (j.data || []).map((x) => ({
      source: `deezer:${x.id}`, title: x.title, artist: x.artist && x.artist.name, album: x.album && x.album.title,
      year: '', cover: (x.album && (x.album.cover_xl || x.album.cover_big)) || '', duration: x.duration || 0,
    }));
  },
  async yandex(artist, title) {
    const j = await getJson(`https://api.music.yandex.net/search?type=track&page=0&text=${encodeURIComponent(`${artist} ${title}`)}`);
    return ((((j.result || {}).tracks || {}).results) || []).slice(0, 5).map((x) => {
      const album = (x.albums || [])[0] || {};
      const cover = x.coverUri || album.coverUri || '';
      return {
        source: `yandex:${x.id}`, title: x.version ? `${x.title} (${x.version})` : x.title, artist: (x.artists || []).map((a) => a.name).join(', '),
        album: album.title || '', year: String(album.year || ''), cover: cover ? `https://${cover.replace('%%', '600x600')}` : '', duration: Math.round((x.durationMs || 0) / 1000),
      };
    });
  },
  // the open encyclopedia of recordings: slowest (one request a second), so the last resort
  async musicbrainz(artist, title) {
    const q = `recording:"${title.replace(/"/g, '')}" AND artist:"${artist.replace(/"/g, '')}"`;
    const j = await getJson(`https://musicbrainz.org/ws/2/recording?fmt=json&limit=5&query=${encodeURIComponent(q)}`);
    return (j.recordings || []).map((x) => {
      const rel = (x.releases || [])[0] || {};
      return {
        source: `musicbrainz:${x.id}`, title: x.title, artist: (x['artist-credit'] || []).map((c) => c.name + (c.joinphrase || '')).join('').trim(),
        album: rel.title || '', year: year(rel.date || x['first-release-date']), cover: rel.id ? `https://coverartarchive.org/release/${rel.id}/front-500` : '',
        duration: Math.round((x.length || 0) / 1000),
      };
    });
  },
};
const ORDER = ['yandex', 'itunes', 'deezer', 'musicbrainz'];

// how sure we are that a candidate is this song (0..1), from the names and the length
// a version the catalogues' copy may not be: "без цензуры" isn't renamed to the censored release of the song
const UNCENSORED = /без\s*цензуры|без\s*мата|uncensored|нецензур/i;

function score(c, want) {
  let t = similarity(c.title, want.title);
  if (UNCENSORED.test(want.title) && !UNCENSORED.test(c.title)) t = Math.min(t, 0.6);
  const a = artistSimilarity(c.artist, want.artist);
  let d = 0.5; // unknown length: neither for nor against
  if (want.duration && c.duration) {
    const diff = Math.abs(want.duration - c.duration);
    d = diff <= 3 ? 1 : diff <= 8 ? 0.7 : diff <= 20 ? 0.3 : 0;
  }
  return { total: 0.5 * t + 0.3 * a + 0.2 * d, title: t, artist: a, duration: d };
}

// sure enough to rename the song without asking: names alike and the length (if known) close
const isSure = (s) => s.title >= 0.85 && s.artist >= 0.7 && s.duration >= 0.7;

// the song as the service named it -> the best candidates, best first. `down` collects catalogues that failed
async function find(song, { only = ORDER, down = new Set() } = {}) {
  const parsed = parseName(song.original ? song.original.title : song.title, song.original ? song.original.artist : song.artist);
  const want = { ...parsed, duration: song.duration };
  const all = [];
  for (const name of only) {
    if (down.has(name)) continue;
    let found = [];
    try { found = await catalogues[name](parsed.artist, parsed.title); } catch (e) { down.add(name); continue; }
    for (const c of found) all.push({ ...c, score: score(c, want) });
    if (all.some((c) => isSure(c.score))) break; // good enough: the slower catalogues aren't asked
  }
  all.sort((x, y) => y.score.total - x.score.total);
  return { parsed, candidates: all.slice(0, 5) };
}

module.exports = { find, score, isSure, catalogues, UNCENSORED };
