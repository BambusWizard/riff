// iOS stand-in for ../../platform.js: same exports, paths live in the app's virtual data dir.
const path = require('path');

const DATA_DIR = '/data';
const CACHE_DIR = path.join(DATA_DIR, 'tracks');
const CUSTOM_LYRICS_DIR = path.join(DATA_DIR, 'custom-lyrics');
const LYRICS_DIR = path.join(DATA_DIR, 'lyrics');
const THUMBNAILS_DIR = path.join(DATA_DIR, 'thumbnails');
const METADATA_PATH = path.join(DATA_DIR, 'metadata.json');
const LIBRARY_DIR = path.join(DATA_DIR, 'library');
const LIBRARY_PATH = path.join(DATA_DIR, 'library.json');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'Downloads');
const STARTUP_PATH = path.join(DATA_DIR, 'startup.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const BIN_DIR = path.join(DATA_DIR, 'bin');

const noop = () => {};
module.exports = {
  clearBinaryCache: noop,
  IS_WIN: false, DATA_DIR, DEFAULT_DATA_DIR: DATA_DIR, CONFIG_PATH, BIN_DIR, CACHE_DIR, CUSTOM_LYRICS_DIR, LYRICS_DIR,
  THUMBNAILS_DIR, METADATA_PATH, LIBRARY_DIR, LIBRARY_PATH, STARTUP_PATH, DOWNLOADS_DIR,
  findInPath: () => null,
  // no ffmpeg on iOS: server.js then skips converting and the yt-dlp emulator keeps the original container
  resolveBinary: (name) => (name === 'ffmpeg' ? null : name),
  // the child_process shim recognises this and answers with the in-app YouTube/SoundCloud client
  ytDlpCommand: (args) => ({ bin: 'yt-dlp', args }),
  STREAM_VIA_CACHE: true,
  tutorialDone: () => true, markTutorialDone: noop,
  readStartupConfig: () => ({}), writeStartupConfig: () => true,
  readConfig: () => ({}), resolveDataDir: () => DATA_DIR, setDataDir: noop,
  resolveDownloadDir: () => DOWNLOADS_DIR, setDownloadDir: noop,
  copyDirContents: noop, removeDirContents: noop,
};
