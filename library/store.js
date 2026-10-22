'use strict';

// The song library's catalog. A song is one recording, whichever services it was found on: our own metadata,
// the sources it is known by ("youtube:abc123", "yandex:4567") and one audio file. The catalog is a single JSON
// file, written whole through a temp file and a rename, so a crash or a power cut never leaves half of it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REASONS = ['finished', 'liked'];
const EDITABLE = ['title', 'artist', 'album', 'year', 'cover'];

const sourceKey = (platform, id) => `${String(platform || '').toLowerCase()}:${String(id || '')}`;

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'library.json');
    this.songsDir = path.join(dir, 'songs');
    fs.mkdirSync(this.songsDir, { recursive: true });
    this.songs = [];
    this.rev = 0;
    this.load();
    // pieces of downloads and uploads cut off when the service was stopped
    for (const name of fs.readdirSync(this.songsDir)) {
      if (/\.(part-|upload-)/.test(name)) fs.rmSync(path.join(this.songsDir, name), { force: true });
    }
  }

  load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    // a catalog that can't be read is not silently replaced by an empty one: that would lose the library
    const data = JSON.parse(raw);
    this.songs = Array.isArray(data.songs) ? data.songs : [];
    this.rev = Number(data.rev) || 0;
  }

  save() {
    this.rev += 1;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ rev: this.rev, songs: this.songs }, null, 1));
    fs.renameSync(tmp, this.file);
  }

  get(id) { return this.songs.find((s) => s.id === id) || null; }

  bySource(key) { return this.songs.find((s) => s.sources.includes(key)) || null; }

  // a phone finished or liked a song. Known song: remember the new reason and user; new song: added as pending
  ingest(t) {
    const key = sourceKey(t.platform, t.id);
    if (!t.platform || !t.id) throw new Error('platform and id are required');
    const reason = REASONS.includes(t.reason) ? t.reason : 'finished';
    let song = this.bySource(key);
    const created = !song;
    if (created) {
      song = {
        id: crypto.randomBytes(6).toString('hex'),
        title: String(t.title || ''),
        artist: String(t.artist || ''),
        album: String(t.album || ''),
        year: '',
        cover: String(t.thumbnail || ''),
        duration: Number(t.duration) || 0,
        sources: [key],
        urls: {},
        // what the service called it ("Lida - Song" by "minecrafter"), kept for matching after we rename it
        original: { title: String(t.title || ''), artist: String(t.artist || '') },
        reasons: [],
        users: [],
        addedAt: Date.now(),
        status: 'pending',
        attempts: 0,
        error: '',
        file: null,
        locked: false,
      };
      this.songs.push(song);
    }
    if (t.url && !song.urls[key]) song.urls[key] = String(t.url);
    if (!song.reasons.includes(reason)) song.reasons.push(reason);
    if (t.user && !song.users.includes(t.user)) song.users.push(t.user);
    this.save();
    return { song, created };
  }

  setStatus(id, status, error = '') {
    const song = this.get(id);
    if (!song) return null;
    song.status = status;
    song.error = error;
    this.save();
    return song;
  }

  // the audio file is in songs/ under the song's id; replaces an older file of another format
  setFile(id, name, size) {
    const song = this.get(id);
    if (!song) return null;
    if (song.file && song.file.name !== name) { try { fs.unlinkSync(path.join(this.songsDir, song.file.name)); } catch (e) {} }
    song.file = { name, size, format: path.extname(name).slice(1) };
    song.status = 'ready';
    song.error = '';
    this.save();
    return song;
  }

  // what the catalogues say the song is (metadata.js). A song edited or confirmed by hand is left alone
  setMatch(id, fields, match) {
    const song = this.get(id);
    if (!song || song.locked) return song;
    for (const k of EDITABLE) if (fields[k]) song[k] = String(fields[k]);
    song.match = { ...match, at: Date.now() };
    this.save();
    return song;
  }

  // a candidate the user picked: applied and locked, like a hand edit
  confirm(id, fields, source) {
    const song = this.get(id);
    if (!song) return null;
    for (const k of EDITABLE) if (fields[k] !== undefined) song[k] = String(fields[k] || '');
    song.match = { status: 'confirmed', source: source || '', at: Date.now() };
    song.locked = true;
    this.save();
    return song;
  }

  // the file's tags were written for this version of the names (metadata.js)
  setTagged(id, stamp, size) {
    const song = this.get(id);
    if (!song) return;
    song.tagged = stamp;
    if (song.file && size) song.file.size = size;
    this.save();
  }

  // edited by hand: these fields are ours now, and later automatic matching leaves them alone
  update(id, fields) {
    const song = this.get(id);
    if (!song) return null;
    let changed = false;
    for (const k of EDITABLE) {
      if (fields[k] !== undefined && String(fields[k]) !== song[k]) { song[k] = String(fields[k]); changed = true; }
    }
    if (changed) { song.locked = true; song.match = { ...(song.match || {}), status: 'confirmed', at: Date.now() }; this.save(); }
    return song;
  }

  remove(id) {
    const i = this.songs.findIndex((s) => s.id === id);
    if (i < 0) return false;
    const [song] = this.songs.splice(i, 1);
    if (song.file) { try { fs.unlinkSync(path.join(this.songsDir, song.file.name)); } catch (e) {} }
    this.save();
    return true;
  }

  filePath(song) { return song && song.file ? path.join(this.songsDir, song.file.name) : null; }

  usedBytes() { return this.songs.reduce((n, s) => n + (s.file ? s.file.size : 0), 0); }

  // what phones keep a copy of: metadata only (no download bookkeeping, no URLs)
  catalog() {
    return {
      rev: this.rev,
      songs: this.songs.map((s) => ({
        id: s.id, title: s.title, artist: s.artist, album: s.album, year: s.year, cover: s.cover, duration: s.duration,
        sources: s.sources, ready: s.status === 'ready', named: !!s.match && ['auto', 'confirmed'].includes(s.match.status),
      })),
    };
  }
}

module.exports = { Store, sourceKey, REASONS };
