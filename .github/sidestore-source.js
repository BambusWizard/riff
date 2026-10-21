// Writes sidestore.json (AltStore/SideStore source format) next to Riff.ipa in CI.
// The version must match the built app (MARKETING_VERSION = <major>.<minor>.<run number>) so
// SideStore can tell when an update is available.
const fs = require('fs');

const { RUN, REPO, SHA } = process.env;
const base = require('../package.json').version.split('.').slice(0, 2).join('.');
const version = `${base}.${RUN}`;
const ipa = `https://github.com/${REPO}/releases/download/ios-latest/Riff.ipa`;
const icon = `https://raw.githubusercontent.com/${REPO}/${SHA}/assets/icon.png`;
const now = new Date().toISOString();
const size = fs.statSync('Riff.ipa').size;

const app = {
  name: 'Riff',
  bundleIdentifier: 'io.github.bambuswizard.riff',
  developerName: 'BambusWizard',
  subtitle: 'Free music player',
  iconURL: icon,
  tintColor: '7C4DFF',
  localizedDescription: 'Free, ad-free music player. Stream from YouTube, YouTube Music and SoundCloud, synced lyrics, offline songs and playlists. Unofficial iPhone build of Riff by rootscripts (MIT).',
  screenshotURLs: [],
  versions: [{ version, buildVersion: String(RUN), date: now, size, downloadURL: ipa, minOSVersion: '15.0' }],
  version, versionDate: now, size, downloadURL: ipa,
  appPermissions: {},
};

fs.writeFileSync('sidestore.json', JSON.stringify({
  name: 'Riff',
  identifier: 'io.github.bambuswizard.riff.source',
  iconURL: icon,
  website: `https://github.com/${REPO}`,
  tintColor: '7C4DFF',
  apps: [app],
  news: [],
}, null, 2));
console.log(`sidestore.json: Riff ${version}, ${size} bytes`);
