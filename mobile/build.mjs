// Builds the iOS web bundle into www/: Riff's desktop frontend + server.js running in-app.
import { build, transform } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');
const shim = (n) => join(root, 'mobile', 'shims', `${n}.js`);

// every build has its own version; file URLs carry it so a Home Screen app never mixes old and new files,
// and the web build compares it with version.json to notice a new deploy (bridge.js)
const VERSION = (process.env.GITHUB_SHA || '').slice(0, 7) || Date.now().toString(36);
// web build channel: "stable" is served at the site root, "nightly" from nightly/ next to it (pages.yml).
// Both share one origin, so likes, playlists and the access key are the same in both. Empty = local build
const CHANNEL = ['stable', 'nightly'].includes(process.env.RIFF_CHANNEL) ? process.env.RIFF_CHANNEL : '';

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
  define: { 'process.env.NODE_ENV': '"production"', 'require.main': 'undefined', RIFF_PROXY_URL: JSON.stringify((process.env.RIFF_PROXY_URL || '').trim().replace(/\/+$/, '')), RIFF_VERSION: JSON.stringify(VERSION), RIFF_CHANNEL: JSON.stringify(CHANNEL) },
  plugins: [swapLocal],
  logLevel: 'warning',
});

// the page's own scripts and styles, minified (whitespace, syntax, local names; top-level names stay, the
// scripts share them): 1.2 MB less for the phone to download and parse at every start
const MINIFY = [['app.js', 'app.js'], ['styles.css', 'styles.css'], ['audio-engine.js', 'audio-engine.js'], ['m3shapes.js', 'm3shapes.js'],
  ['lyrics-rtl.js', 'lyrics-rtl.js'], ['track-sort.js', 'track-sort.js'], ['search-text.js', 'search-text.js'], ['library-tools.js', 'library-tools.js'],
  ['mobile/mobile.css', 'mobile.css'], ['mobile/mobile-ui.js', 'mobile-ui.js']];
for (const [from, to] of MINIFY) {
  const r = await transform(readFileSync(join(root, from), 'utf8'), { loader: from.endsWith('.css') ? 'css' : 'js', minify: true, target: ['safari16'], legalComments: 'none' });
  writeFileSync(join(out, to), r.code);
}
// Tone.js isn't used by the phone layout; hls.js loads on demand (RiffLoadHls in bridge.js)
cpSync(join(root, 'assets'), join(out, 'assets'), { recursive: true, filter: (p) => !/Tone\.js$/.test(p) });
cpSync(join(root, 'vendor'), join(out, 'vendor'), { recursive: true });
cpSync(join(root, 'mobile', 'pwa'), join(out, 'pwa'), { recursive: true });

let html = readFileSync(join(root, 'index.html'), 'utf8');
html = html
  .replace('<meta name="viewport"', '<meta name="viewport-desktop"')
  // the phone layout hangs off html.is-mobile; bridge.js sets it too, but it loads at the end of <body>, and iOS
  // may paint the page before that: the desktop title bar (minimize/close) flashes. Set it before the first paint
  .replace('<head>', '<head>\n  <script>document.documentElement.classList.add(\'is-mobile\')</script>'
    // the Home Screen icon always opens stable; whoever switched to nightly in Settings is sent on before
    // anything loads (and back again when they switch it off)
    + (CHANNEL ? `\n  <script>(function(){try{var w=localStorage.getItem('riff_channel')==='nightly'?'nightly':'stable';`
      + `if(w!=='${CHANNEL}')location.replace('${CHANNEL === 'stable' ? 'nightly/' : '../'}')}catch(e){}})()</script>` : '')
    + '\n  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">'
    // web build: "Add to Home Screen" opens it full screen like an app. The status bar is "black-translucent":
    // the app runs under the camera cutout (the blurred cover background shows there, --safe-top keeps the
    // header clear of it). This mode once left a black strip under the tab bar; mobile.css paints below the bar
    + '\n  <link rel="manifest" href="pwa/manifest.webmanifest">\n  <link rel="apple-touch-icon" href="pwa/icon-180.png">'
    + '\n  <meta name="apple-mobile-web-app-capable" content="yes">\n  <meta name="mobile-web-app-capable" content="yes">'
    + '\n  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n  <meta name="apple-mobile-web-app-title" content="Riff">'
    + '\n  <meta name="theme-color" content="#121214">'
    // bridge.js compares it with its own version: a stale page that got newer scripts reloads itself
    + `\n  <meta name="riff-build" content="${VERSION}">`
    + `\n  <meta name="riff-channel" content="${CHANNEL}">`)
  // loading screen until app.js is ready (and while a newer build loads); bridge.js hides it on riff:ready
  .replace('</head>', '  <style>#riff-splash{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#121214;color:#e6e1e5;font:500 15px -apple-system,system-ui,sans-serif;transition:opacity .25s ease}'
    // once gone it stops animating: the pulsing dot kept iOS drawing frames for as long as the app was open
    + '#riff-splash.gone{opacity:0;pointer-events:none;visibility:hidden;transition:opacity .25s ease,visibility 0s .25s}#riff-splash.gone i{animation:none}#riff-splash i{width:14px;height:14px;border-radius:50%;background:#d0bcff;animation:riff-pulse 1s ease-in-out infinite alternate}'
    + '#riff-splash b{font-size:22px;letter-spacing:.01em}#riff-splash span{min-height:1em;font-size:12px;color:#938f99;font-variant-numeric:tabular-nums}'
    + '#riff-splash s{display:block;width:150px;height:3px;border-radius:2px;background:rgba(255,255,255,.12);overflow:hidden;text-decoration:none}'
    + '#riff-splash em{display:block;height:100%;width:3%;border-radius:2px;background:#d0bcff;transition:width .3s ease}'
    + '@keyframes riff-pulse{from{transform:scale(.7);opacity:.5}to{transform:scale(1.15);opacity:1}}</style>\n</head>')
  // progress: the page's scripts loading (counted by the inline script below), then bridge.js starting the player
  .replace(/<body([^>]*)>/, '<body$1>\n  <div id="riff-splash"><i></i><b>Riff</b><s><em></em></s><span>Loading…</span></div>'
    + '\n  <script>(function(){var n=0,T=__RIFF_SCRIPTS__,s=document.getElementById("riff-splash");'
    + 'window.__riffSplashStep=function(p,t){if(!s)return;s.querySelector("em").style.width=Math.round(p*100)+"%";if(t!=null)s.querySelector("span").textContent=t};'
    + 'document.addEventListener("load",function(e){var x=e.target;if(x&&x.tagName==="SCRIPT"&&x.src){n++;window.__riffSplashStep(.05+.7*Math.min(1,n/T),"Loading app… "+Math.min(n,T)+"/"+T)}},true)})()</script>')
  .replace('<link rel="stylesheet" href="styles.css">', '<link rel="stylesheet" href="styles.css">\n  <link rel="stylesheet" href="mobile.css">')
  .replace(/\s*<script src="assets\/hls\.min\.js"><\/script>/, '')
  .replace('<script src="audio-engine.js"></script>', '<script src="mobile-bridge.js"></script>\n  <script src="audio-engine.js"></script>')
  .replace('<script src="app.js"></script>', '<script src="app.js"></script>\n  <script src="mobile-ui.js"></script>')
  // Now Playing is a sheet on phones and starts closed
  .replace('<aside class="right-panel lyrics-empty" id="right-panel">', '<aside class="right-panel lyrics-empty hidden" id="right-panel">')
  .replace(/(<(?:script|link)\b[^>]*?\b(?:src|href)=")((?!https?:|\/\/|data:)[^"?#]+\.(?:js|css))"/g, `$1$2?v=${VERSION}"`);
html = html.replace('__RIFF_SCRIPTS__', String((html.match(/<script\b[^>]*\bsrc=/g) || []).length));
writeFileSync(join(out, 'index.html'), html);
writeFileSync(join(out, 'version.json'), JSON.stringify({ version: VERSION }));

// service worker: everything the page loads at start, so the Home Screen app opens offline (vendor/ is cached on first use)
const shell = new Set(['index.html', ...[...html.matchAll(/\b(?:src|href)="((?!https?:|\/\/|data:)[^"#]+)"/g)].map((m) => m[1])]);
for (const dir of ['assets', 'pwa']) for (const f of readdirSync(join(out, dir))) shell.add(`${dir}/${f}`);
writeFileSync(join(out, 'sw.js'), readFileSync(join(root, 'mobile', 'sw.js'), 'utf8')
  .replace('__RIFF_VERSION__', VERSION).replace('__RIFF_CHANNEL__', CHANNEL || 'local').replace('__RIFF_SHELL__', JSON.stringify([...shell])));
console.log('www/ ready');
