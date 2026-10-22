'use strict';

// Gives every song its real names. The catalogues (lookup.js) are asked what the upload is; a sure answer is
// applied, an unsure one is applied only as the cleaned-up upload name and the song waits for review (/ui), with
// the catalogues' best guesses kept to pick from. Then the names go into the file itself (tags.js).
// One song at a time, a second apart: MusicBrainz asks for no more than one request a second.

const path = require('path');

const pickFields = (c) => ({ title: c.title, artist: c.artist, album: c.album, year: c.year, cover: c.cover });
const stamp = (s) => [s.title, s.artist, s.album, s.year, s.cover].join('\u0001');
const brief = (c) => ({ source: c.source, title: c.title, artist: c.artist, album: c.album, year: c.year, cover: c.cover, duration: c.duration, score: Math.round(c.score.total * 100) / 100 });

function createNamer({ store, lookup = require('./lookup'), writeTags = require('./tags').writeTags, log = () => {}, gapMs = 1100 }) {
  const queue = [];
  let busy = false;
  // catalogues that failed are skipped for an hour (a blocked one would slow every song down)
  let down = new Set();
  let downSince = Date.now();

  async function identify(song) {
    if (Date.now() - downSince > 3600 * 1000) { down = new Set(); downSince = Date.now(); }
    const { parsed, candidates: all } = await lookup.find(song, { down });
    const candidates = all.filter((c) => c.score.total >= 0.35); // below that the guesses are noise, not help
    const best = candidates[0];
    const from = `${song.original.artist} - ${song.original.title}`;
    if (best && lookup.isSure(best.score)) {
      store.setMatch(song.id, pickFields(best), { status: 'auto', source: best.source, candidates: candidates.slice(0, 3).map(brief) });
      log(`= ${from}  ->  ${best.artist} - ${best.title}${best.album ? ` (${best.album})` : ''}`);
    } else {
      store.setMatch(song.id, { title: parsed.title, artist: parsed.artist }, { status: best ? 'review' : 'none', candidates: candidates.slice(0, 3).map(brief) });
      log(`? ${from}  ->  ${parsed.artist} - ${parsed.title} (${best ? 'check it in the library page' : 'no catalogue knows it'})`);
    }
  }

  async function tag(id) {
    const s = store.get(id);
    if (!s || s.status !== 'ready' || !s.match || s.tagged === stamp(s)) return;
    const size = await writeTags(store.filePath(s), s, s.cover, path.join(store.dir, 'covers'));
    if (size) store.setTagged(s.id, stamp(s), size);
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const id = queue.shift();
      const song = store.get(id);
      if (!song) continue;
      let asked = false;
      try {
        if (!song.locked && !song.match) { await identify(song); asked = true; }
        await tag(id);
      } catch (e) { log(`! names for ${song.artist} - ${song.title}: ${e.message}`); }
      if (asked && queue.length) await new Promise((r) => setTimeout(r, gapMs));
    }
    busy = false;
  }

  // a new song, a song whose file just arrived, or names edited by hand: (re)named and (re)tagged as needed
  const add = (id) => { if (!queue.includes(id)) queue.push(id); pump(); };
  const needsWork = (s) => (!s.locked && !s.match) || (s.status === 'ready' && s.match && s.tagged !== stamp(s));

  return { add, needsWork, idle: () => !busy && queue.length === 0, pickFields };
}

module.exports = { createNamer, stamp };
