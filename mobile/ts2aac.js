// Turns HLS audio segments into one raw ADTS .aac file (plays natively in WebKit and Chromium).
// YouTube's audio-only renditions are "packed audio": ADTS frames behind an ID3 timestamp tag.
// MPEG-TS segments are demuxed as a fallback.
function ts2aac(ts) {
  const out = [];
  let audioPid = -1;
  for (let i = 0; i + 188 <= ts.length; i += 188) {
    if (ts[i] !== 0x47) { // resync after garbage
      const next = ts.indexOf(0x47, i + 1);
      if (next < 0) break;
      i = next - 188;
      continue;
    }
    const pusi = (ts[i + 1] & 0x40) !== 0;
    const pid = ((ts[i + 1] & 0x1f) << 8) | ts[i + 2];
    const afc = (ts[i + 3] >> 4) & 3;
    let p = i + 4;
    if (afc === 2) continue; // adaptation field only
    if (afc === 3) p += 1 + ts[p];
    if (p >= i + 188) continue;
    if (pusi && ts[p] === 0 && ts[p + 1] === 0 && ts[p + 2] === 1) {
      const streamId = ts[p + 3];
      if (streamId >= 0xc0 && streamId <= 0xdf) {
        audioPid = pid;
        p += 9 + ts[p + 8]; // PES header + optional fields
      } else if (pid === audioPid) {
        continue;
      }
    }
    if (pid === audioPid && audioPid >= 0) out.push(ts.subarray(p, i + 188));
  }
  const total = out.reduce((n, c) => n + c.length, 0);
  const aac = new Uint8Array(total);
  let o = 0;
  for (const c of out) { aac.set(c, o); o += c.length; }
  return aac;
}
function stripId3(seg) {
  let p = 0;
  while (seg[p] === 0x49 && seg[p + 1] === 0x44 && seg[p + 2] === 0x33) { // "ID3"
    const size = (seg[p + 6] << 21) | (seg[p + 7] << 14) | (seg[p + 8] << 7) | seg[p + 9];
    p += 10 + size + ((seg[p + 5] & 0x10) ? 10 : 0); // header + tag (+ footer)
  }
  return seg.subarray(p);
}

function segmentsToAac(segments) {
  const parts = segments.map((seg) => (seg[0] === 0x47 ? ts2aac(seg) : stripId3(seg)));
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

module.exports = { ts2aac, segmentsToAac };
