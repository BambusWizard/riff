'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { cleanTitle, cleanArtist, parseName, similarity, artistSimilarity } = require('../library/names');

test('junk in brackets goes, versions stay', () => {
  assert.strictEqual(cleanTitle('Song (Official Video) [HD]'), 'Song');
  assert.strictEqual(cleanTitle('Song (Official Music Video)'), 'Song');
  assert.strictEqual(cleanTitle('Песня (Премьера клипа, 2023)'), 'Песня');
  assert.strictEqual(cleanTitle('Song (Lyrics)'), 'Song');
  assert.strictEqual(cleanTitle('Song (Remix)'), 'Song (Remix)');
  assert.strictEqual(cleanTitle('Song (Live at Wembley)'), 'Song (Live at Wembley)');
  assert.strictEqual(cleanTitle('Song | Album 2020'), 'Song');
  assert.strictEqual(cleanTitle('Song #shorts #music'), 'Song');
});

test('channel names lose their decorations', () => {
  assert.strictEqual(cleanArtist('Rick Astley - Topic'), 'Rick Astley');
  assert.strictEqual(cleanArtist('RickAstleyVEVO'), 'RickAstley');
  assert.strictEqual(cleanArtist('GSPD Official'), 'GSPD');
});

test('"Artist - Song" from a channel that is not the artist', () => {
  assert.deepStrictEqual(parseName('Lida - Song (Official Video)', 'minecrafter'), { artist: 'Lida', title: 'Song' });
  assert.deepStrictEqual(parseName('Lida – Песня', 'random uploads'), { artist: 'Lida', title: 'Песня' });
});

test('"Song - Artist" when the channel says who the artist is', () => {
  assert.deepStrictEqual(parseName('Блондинка - GSPD', 'GSPD'), { artist: 'GSPD', title: 'Блондинка' });
});

test('an upload titled with the song only takes the channel as the artist', () => {
  assert.deepStrictEqual(parseName('Never Gonna Give You Up', 'Rick Astley - Topic'), { artist: 'Rick Astley', title: 'Never Gonna Give You Up' });
});

test('quoted song titles', () => {
  assert.deepStrictEqual(parseName('Кино «Группа крови»', 'some channel'), { artist: 'Кино', title: 'Группа крови' });
});

test('hyphens inside names are not separators', () => {
  assert.deepStrictEqual(parseName('Jay-Z - Empire State of Mind', 'x'), { artist: 'Jay-Z', title: 'Empire State of Mind' });
});

test('similarity ignores case, accents, ё and feat. parts', () => {
  assert.strictEqual(similarity('Beyoncé', 'beyonce'), 1);
  assert.strictEqual(similarity('Ёлка', 'елка'), 1);
  assert.strictEqual(similarity('Song (feat. Someone)', 'Song'), 1);
  assert.ok(similarity('Never Gonna Give You Up', 'Never Gonna Give You Up (2022 Remaster)') > 0.6);
  assert.ok(similarity('Song', 'Completely different') < 0.3);
});

test('one of several artists is enough', () => {
  assert.strictEqual(artistSimilarity('GSPD & DEAD BLONDE', 'GSPD'), 1);
  assert.strictEqual(artistSimilarity('Lida feat. Someone', 'Lida'), 1);
});
