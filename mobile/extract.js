// In-app replacement for the parts of yt-dlp Riff uses: YouTube/YouTube Music search,
// SoundCloud search, and resolving a track page to a direct audio URL.
// All network calls go through globalThis.__riffFetch (native HTTP in the app, dev proxy in a browser).
const { Innertube, Platform, Constants } = require('youtubei.js/web');

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// youtubei.js needs a JS evaluator for signature deciphering (only used when a client returns ciphered URLs)
Platform.shim.eval = async (data, env) => {
  const props = [];
  if (env.n) props.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
  if (env.sig) props.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
  return new Function(`${data.output}\nreturn { ${props.join(', ')} }`)();
};

let ytPromise = null;
function yt() {
  if (!ytPromise) {
    ytPromise = Innertube.create({ generate_session_locally: true, fetch: (...a) => globalThis.__riffFetch(...a) })
      .catch((e) => { ytPromise = null; throw e; });
  }
  return ytPromise;
}

const ytId = (u) => {
  const m = String(u).match(/(?:v=|youtu\.be\/|\/shorts\/|^)([\w-]{11})(?:[&?#]|$)/);
  return m ? m[1] : null;
};
const thumbs = (arr) => (arr || []).map((t) => ({ url: t.url, width: t.width, height: t.height })).sort((a, b) => (a.width || 0) - (b.width || 0));
const text = (t) => (t == null ? '' : typeof t === 'string' ? t : t.text || t.toString());

async function youtubeSearch(query, limit) {
  const r = await (await yt()).search(query, { type: 'video' });
  return (r.videos || []).filter((v) => v.id).slice(0, limit).map((v) => ({
    id: v.id,
    title: text(v.title),
    uploader: text(v.author && v.author.name),
    channel: text(v.author && v.author.name),
    duration: (v.duration && v.duration.seconds) || 0,
    thumbnails: thumbs(v.thumbnails),
    webpage_url: `https://www.youtube.com/watch?v=${v.id}`,
  }));
}

async function ytMusicSearch(query, limit) {
  const r = await (await yt()).music.search(query, { type: 'song' });
  const items = (r.contents || []).flatMap((c) => c.contents || []).filter((x) => x.id);
  return items.slice(0, limit).map((s) => ({
    id: s.id,
    title: text(s.title || s.name),
    artists: (s.artists || []).map((a) => a.name).filter(Boolean),
    duration: (s.duration && s.duration.seconds) || 0,
    thumbnails: thumbs(s.thumbnails || (s.thumbnail && s.thumbnail.contents)),
    webpage_url: `https://www.youtube.com/watch?v=${s.id}`,
  }));
}

// ---- YouTube audio ----
// Primary: the visionOS client's audio-only HLS (itag 234, ~128 kbps AAC). Its segments download
// without a proof-of-origin token, unlike direct googlevideo files, which now 403 after the first MB
// for most clients. Same approach yt-dlp uses. Needs a visitor id or YouTube asks to "sign in".
const VOS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
let visitorId = null;
async function getVisitorId(force) {
  if (visitorId && !force) return visitorId;
  const html = await (await globalThis.__riffFetch('https://www.youtube.com/', { headers: { 'User-Agent': VOS_UA, 'Accept-Language': 'en-US' } })).text();
  visitorId = (html.match(/"VISITOR_DATA":"([^"]+)"/) || [])[1] || null;
  return visitorId;
}

async function youtubeHlsAudio(id) {
  for (const force of [false, true]) {
    const visitor = await getVisitorId(force);
    const body = {
      context: { client: { clientName: 'VISIONOS', clientVersion: '1.02', deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', userAgent: VOS_UA, osName: 'visionOS', osVersion: '26.5.23O471', hl: 'en', timeZone: 'UTC', utcOffsetMinutes: 0, visitorData: visitor || undefined } },
      videoId: id, contentCheckOk: true, racyCheckOk: true,
    };
    const headers = { 'User-Agent': VOS_UA, 'Content-Type': 'application/json', 'X-Youtube-Client-Name': '101', 'X-Youtube-Client-Version': '1.02', Origin: 'https://www.youtube.com' };
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
    const j = await (await globalThis.__riffFetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', { method: 'POST', headers, body: JSON.stringify(body) })).json();
    const master = j.streamingData && j.streamingData.hlsManifestUrl;
    if (!master) {
      if (j.playabilityStatus && j.playabilityStatus.status === 'LOGIN_REQUIRED' && !force) continue; // stale visitor id
      throw new Error((j.playabilityStatus && j.playabilityStatus.reason) || 'no HLS stream');
    }
    const m3u = await (await globalThis.__riffFetch(master, { headers: { 'User-Agent': VOS_UA } })).text();
    const pick = (itag) => (m3u.match(new RegExp(`#EXT-X-MEDIA:[^\\n]*URI="([^"]+/itag/${itag}/[^"]*)"`)) || [])[1];
    const playlist = pick(234) || pick(233);
    if (!playlist) throw new Error('no audio rendition');
    const d = j.videoDetails || {};
    return { kind: 'hls', url: playlist, headers: { 'User-Agent': VOS_UA }, ext: 'aac', artist: (d.author || '').replace(/\s*-\s*Topic$/i, ''), title: d.title, duration: Number(d.lengthSeconds) || 0 };
  }
  throw new Error('YouTube refused the request');
}

// Fallback: direct m4a (itag 140). Works for videos YouTube doesn't gate yet.
async function youtubeAudio(id) {
  try { return await youtubeHlsAudio(id); } catch (e) { console.warn('[riff] HLS route failed, trying direct', e.message); }
  const y = await yt();
  let lastErr = null;
  for (const client of ['IOS', 'MWEB', 'TV']) {
    try {
      const info = await y.getBasicInfo(id, { client });
      const formats = (info.streaming_data && info.streaming_data.adaptive_formats || []).filter((f) => f.has_audio && !f.has_video);
      const pick = formats.filter((f) => /mp4/.test(f.mime_type)).sort((a, b) => b.bitrate - a.bitrate)[0] || formats.sort((a, b) => b.bitrate - a.bitrate)[0];
      if (!pick) throw new Error('no audio format');
      const url = pick.url || await pick.decipher(y.session.player);
      // googlevideo ties the URL to the client that asked for it; download with the same User-Agent
      const ua = (Constants.CLIENTS[client] && Constants.CLIENTS[client].USER_AGENT) || 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
      return { url, headers: { 'User-Agent': ua }, ext: /mp4/.test(pick.mime_type) ? 'm4a' : 'webm', artist: text(info.basic_info.author).replace(/\s*-\s*Topic$/i, ''), title: info.basic_info.title, duration: info.basic_info.duration };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('could not extract audio stream');
}

// ---- SoundCloud (public api-v2 with the web client's client_id) ----
let scClientId = null;
async function scId(force) {
  if (scClientId && !force) return scClientId;
  const html = await (await globalThis.__riffFetch('https://soundcloud.com/', { headers: { 'User-Agent': DESKTOP_UA } })).text();
  const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]).reverse();
  for (const s of scripts) {
    const m = (await (await globalThis.__riffFetch(s)).text()).match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{20,})"/);
    if (m) return (scClientId = m[1]);
  }
  throw new Error('SoundCloud client id not found');
}

async function scApi(path) {
  for (const force of [false, true]) {
    const id = await scId(force);
    const r = await globalThis.__riffFetch(`https://api-v2.soundcloud.com${path}${path.includes('?') ? '&' : '?'}client_id=${id}`, { headers: { 'User-Agent': DESKTOP_UA } });
    if (r.status === 401 || r.status === 403) continue; // client_id rotated
    if (!r.ok) throw new Error(`SoundCloud ${r.status}`);
    return r.json();
  }
  throw new Error('SoundCloud refused the request');
}

const scEntry = (t) => ({
  id: String(t.id),
  title: t.title,
  uploader: t.user && t.user.username,
  duration: Math.round((t.full_duration || t.duration || 0) / 1000),
  thumbnails: t.artwork_url ? [{ url: t.artwork_url.replace('-large.', '-t500x500.') }] : [],
  webpage_url: t.permalink_url,
});

async function soundcloudSearch(query, limit) {
  const r = await scApi(`/search/tracks?q=${encodeURIComponent(query)}&limit=${limit}`);
  return (r.collection || []).filter((t) => t.kind === 'track').map(scEntry);
}

async function soundcloudAudio(pageUrl) {
  const t = await scApi(`/resolve?url=${encodeURIComponent(pageUrl)}`);
  const list = (t.media && t.media.transcodings) || [];
  const tc = list.find((x) => x.format.protocol === 'progressive') || list[0];
  if (!tc) throw new Error('no SoundCloud stream');
  const auth = t.track_authorization ? `?track_authorization=${t.track_authorization}` : '';
  const { url } = await scApi(tc.url.replace('https://api-v2.soundcloud.com', '') + auth);
  return { url, ext: tc.format.protocol === 'progressive' ? 'mp3' : 'm3u8', artist: t.user && t.user.username, title: t.title, duration: Math.round(t.duration / 1000) };
}

// Resolve anything yt-dlp would accept as a target: a URL, ytsearch1:, scsearch1:.
async function resolveAudio(target) {
  const s = String(target);
  let m = s.match(/^(yt|sc)search\d*:(.*)$/);
  if (m) {
    const hit = (m[1] === 'sc' ? await soundcloudSearch(m[2], 1) : await youtubeSearch(m[2], 1))[0];
    if (!hit) throw new Error('no search results');
    return resolveAudio(hit.webpage_url);
  }
  if (/soundcloud\.com/.test(s)) return soundcloudAudio(s);
  const id = ytId(s);
  if (id) return youtubeAudio(id);
  throw new Error(`unsupported target ${s}`);
}

// ---- playlists (link import): yt-dlp-style { title, entries } ----
async function youtubePlaylist(listId, limit) {
  const y = await yt();
  let page = await y.getPlaylist(listId);
  const title = text(page.info && page.info.title) || 'Playlist';
  const entries = [];
  const parseDur = (s) => String(s || '').split(':').map(Number).reduce((acc, n) => acc * 60 + (n || 0), 0);
  const take = (p) => (p.videos || p.items || []).forEach((v) => {
    if (entries.length >= limit) return;
    if (v.type === 'LockupView') {
      // newer playlist layout: id in content_id, title/channel in metadata, duration as a thumbnail badge
      if (v.content_type && v.content_type !== 'VIDEO') return;
      const md = v.metadata || {};
      const rows = (md.metadata && md.metadata.metadata_rows) || [];
      const channel = rows[0] && rows[0].metadata_parts && rows[0].metadata_parts[0] ? text(rows[0].metadata_parts[0].text) : '';
      const badge = ((v.content_image && v.content_image.overlays) || []).flatMap((o) => o.badges || [])[0];
      if (!v.content_id) return;
      entries.push({
        id: v.content_id, title: text(md.title), uploader: channel, channel,
        duration: parseDur(badge && badge.text), thumbnails: thumbs(v.content_image && v.content_image.image), webpage_url: `https://www.youtube.com/watch?v=${v.content_id}`,
      });
      return;
    }
    if (!v.id) return;
    entries.push({
      id: v.id, title: text(v.title), uploader: text(v.author && v.author.name), channel: text(v.author && v.author.name),
      duration: (v.duration && v.duration.seconds) || 0, thumbnails: thumbs(v.thumbnails), webpage_url: `https://www.youtube.com/watch?v=${v.id}`,
    });
  });
  take(page);
  while (entries.length < limit && page.has_continuation) {
    page = await page.getContinuation();
    take(page);
  }
  return { title, entries };
}

async function soundcloudPlaylist(pageUrl, limit) {
  const set = await scApi(`/resolve?url=${encodeURIComponent(pageUrl)}`);
  if (set.kind === 'track') return { title: set.title, entries: [scEntry(set)] };
  const tracks = (set.tracks || []).slice(0, limit);
  // long sets only carry full data for the first few tracks; fetch the rest by id
  const missing = tracks.filter((t) => !t.title).map((t) => t.id);
  const full = new Map(tracks.filter((t) => t.title).map((t) => [t.id, t]));
  for (let i = 0; i < missing.length; i += 50) {
    const batch = await scApi(`/tracks?ids=${missing.slice(i, i + 50).join(',')}`).catch(() => []);
    (batch || []).forEach((t) => full.set(t.id, t));
  }
  return { title: set.title || 'SoundCloud playlist', entries: tracks.map((t) => full.get(t.id)).filter(Boolean).map(scEntry) };
}

async function playlist(pageUrl, limit = 500) {
  const s = String(pageUrl);
  if (/soundcloud\.com/.test(s)) return soundcloudPlaylist(s, limit);
  const list = (s.match(/[?&]list=([\w-]+)/) || [])[1];
  if (list) return youtubePlaylist(list, limit);
  const id = ytId(s);
  if (id) {
    const a = await youtubeAudio(id);
    return { title: a.title, entries: [{ id, title: a.title, uploader: a.artist, duration: a.duration, thumbnails: [], webpage_url: `https://www.youtube.com/watch?v=${id}` }] };
  }
  throw new Error(`unsupported link ${s}`);
}

module.exports = { youtubeSearch, ytMusicSearch, soundcloudSearch, resolveAudio, playlist };
