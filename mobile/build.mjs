// Builds the iOS web bundle into www/: Riff's desktop frontend + server.js running in-app.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');
const shim = (n) => join(root, 'mobile', 'shims', `${n}.js`);

// every build has its own version; file URLs carry it so a Home Screen app never mixes old and new files,
// and the web build compares it with version.json to notice a new deploy (bridge.js)
const VERSION = (process.env.GITHUB_SHA || '').slice(0, 7) || Date.now().toString(36);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// server.js requires './platform', './tools' and './logger'; on iOS those resolve to the shims.
const swapLocal = {
  name: 'riff-ios-swaps',
  setup(b) {
    b.onResolve({ filter: /^\.\/(platform|tools|logger)$/ }, (a) => (dirname(a.importer) === root ? { path: shim(a.path.slice(2)) } : undefined));
  },
};

await build({
  entryPoints: [join(root, 'mobile', 'bridge.js')],
  outfile: join(out, 'mobile-bridge.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['safari16'],
  minify: true,
  sourcemap: 'linked',
  legalComments: 'none',
  alias: {
    fs: shim('fs'), http: shim('http'), https: shim('https'), child_process: shim('child_process'),
    os: shim('os'), url: shim('url'), string_decoder: shim('string_decoder'), crypto: shim('crypto'),
    electron: shim('electron'), dns: shim('dns'), net: shim('net'), path: 'path-browserify', events: 'events', buffer: 'buffer',
  },
  inject: [join(root, 'mobile', 'globals.js')],
  define: { 'process.env.NODE_ENV': '"production"', 'require.main': 'undefined', RIFF_PROXY_URL: JSON.stringify((process.env.RIFF_PROXY_URL || '').trim().replace(/\/+$/, '')), RIFF_VERSION: JSON.stringify(VERSION) },
  plugins: [swapLocal],
  logLevel: 'warning',
});

for (const f of ['app.js', 'styles.css', 'audio-engine.js', 'm3shapes.js', 'lyrics-rtl.js', 'track-sort.js', 'search-text.js', 'library-tools.js']) cpSync(join(root, f), join(out, f));
cpSync(join(root, 'assets'), join(out, 'assets'), { recursive: true });
cpSync(join(root, 'vendor'), join(out, 'vendor'), { recursive: true });
cpSync(join(root, 'mobile', 'mobile.css'), join(out, 'mobile.css'));
cpSync(join(root, 'mobile', 'pwa'), join(out, 'pwa'), { recursive: true });
cpSync(join(root, 'mobile', 'mobile-ui.js'), join(out, 'mobile-ui.js'));

let html = readFileSync(join(root, 'index.html'), 'utf8');
html = html
  .replace('<meta name="viewport"', '<meta name="viewport-desktop"')
  .replace('<head>', '<head>\n  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">'
    // web build: "Add to Home Screen" opens it full screen like an app
    + '\n  <link rel="manifest" href="pwa/manifest.webmanifest">\n  <link rel="apple-touch-icon" href="pwa/icon-180.png">'
    + '\n  <meta name="apple-mobile-web-app-capable" content="yes">\n  <meta name="mobile-web-app-capable" content="yes">'
    + '\n  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n  <meta name="apple-mobile-web-app-title" content="Riff">'
    + '\n  <meta name="theme-color" content="#121214">')
  .replace('<link rel="stylesheet" href="styles.css">', '<link rel="stylesheet" href="styles.css">\n  <link rel="stylesheet" href="mobile.css">')
  .replace('<script src="audio-engine.js"></script>', '<script src="mobile-bridge.js"></script>\n  <script src="audio-engine.js"></script>')
  .replace('<script src="app.js"></script>', '<script src="app.js"></script>\n  <script src="mobile-ui.js"></script>')
  // Now Playing is a sheet on phones and starts closed
  .replace('<aside class="right-panel lyrics-empty" id="right-panel">', '<aside class="right-panel lyrics-empty hidden" id="right-panel">')
  .replace(/(<(?:script|link)\b[^>]*?\b(?:src|href)=")((?!https?:|\/\/|data:)[^"?#]+\.(?:js|css))"/g, `$1$2?v=${VERSION}"`);
writeFileSync(join(out, 'index.html'), html);
writeFileSync(join(out, 'version.json'), JSON.stringify({ version: VERSION }));
console.log('www/ ready');
