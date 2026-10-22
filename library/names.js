'use strict';

// Song names as the services give them, turned into an artist and a title worth searching for:
// "Lida - Song (Official Video) [HD]" by the channel "minecrafter" is the song "Song" by "Lida". Also the measure
// of how alike two names are, used to decide whether a catalogue's answer is the same song.

// bracketed parts that say nothing about the song itself (a live version or a remix stays: it is another recording)
const JUNK = /\b(official|video|videoclip|clip|audio|lyrics?|lyric video|visuali[sz]er|music video|mv|hd|hq|4k|8k|1080p|720p|remaster(ed)?( \d{4})?|explicit|premiere|full song|color coded|with lyrics)\b|клип|премьера|текст|official|аудио|видео|караоке/i;
const CHANNEL_SUFFIX = /\s*(-\s*topic|vevo|official( channel)?|music|tv|records?)\s*$/i;
const SEPARATOR = /\s+[-–—|]\s+|\s+[-–—]\s*|\s*[-–—]\s+/;

function cleanTitle(s) {
  let t = String(s || '');
  t = t.replace(/[(\[【]([^)\]】]*)[)\]】]/g, (all, inner) => (JUNK.test(inner) ? ' ' : all));
  t = t.replace(/\s*(\||\/\/)\s.*$/, ''); // "Song | Album 2020", "Song // Channel"
  t = t.replace(/#\S+/g, ' '); // hashtags
  return t.replace(/\s+/g, ' ').replace(/\s+([,.!?)])/g, '$1').trim();
}

function cleanArtist(s) {
  let a = String(s || '').trim();
  for (let i = 0; i < 2; i++) a = a.replace(CHANNEL_SUFFIX, '').trim();
  return a;
}

// what a YouTube (or any service's) upload most likely is
function parseName(title, channel) {
  const t = cleanTitle(title);
  const ch = cleanArtist(channel);
  // Artist "Song" / Artist «Song»
  const quoted = /^(.+?)\s+["«“](.+?)["»”]\s*$/.exec(t);
  if (quoted) return { artist: quoted[1].trim(), title: cleanTitle(quoted[2]) };
  const parts = t.split(SEPARATOR);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    // "Song - Artist" happens too, but "Artist - Song" is far more common; the channel decides when it matches
    const [a, b] = [parts[0].trim(), parts.slice(1).join(' - ').trim()];
    if (ch && similarity(b, ch) > similarity(a, ch) && similarity(b, ch) > 0.7) return { artist: b, title: a };
    return { artist: a, title: b };
  }
  return { artist: ch, title: t };
}

// lower case, no accents, ё = е, no punctuation and no "feat. X" part: what is compared
function normalize(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/ё/g, 'е')
    .replace(/[(\[].*?(feat|ft|prod)\b.*?[)\]]/g, ' ')
    .replace(/\b(feat|ft|featuring|prod)\.?\s.*$/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Dice coefficient over letter pairs of the normalized names: 1 is the same, 0 nothing alike
function similarity(x, y) {
  const a = normalize(x).replace(/ /g, '');
  const b = normalize(y).replace(/ /g, '');
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = new Map();
  for (let i = 0; i < a.length - 1; i++) { const p = a.slice(i, i + 2); pairs.set(p, (pairs.get(p) || 0) + 1); }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const p = b.slice(i, i + 2);
    const n = pairs.get(p);
    if (n) { hits++; pairs.set(p, n - 1); }
  }
  return (2 * hits) / (a.length + b.length - 2);
}

// several artists ("A, B & C", "A feat. B"): the best match with any of them counts
function artistSimilarity(x, y) {
  const split = (s) => String(s || '').split(/\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bи\b)\s*/i).filter(Boolean);
  let best = similarity(x, y);
  for (const a of split(x)) for (const b of split(y)) best = Math.max(best, similarity(a, b));
  return best;
}

module.exports = { cleanTitle, cleanArtist, parseName, normalize, similarity, artistSimilarity };
