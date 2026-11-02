// Builds small, real picture-subtitle data for the tests: PGS display sets (and .sup files), VobSub SPU packets,
// DVB display sets, and a minimal Matroska writer to put them in a file ffmpeg can read.
// Pictures are given as { w, h, px: palette index per pixel }.
'use strict';

// ---------------------------------------------------------------- PGS
function pgsRle(px, w, h) {
  const out = [];
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      const c = px[y * w + x];
      let n = 1;
      while (x + n < w && px[y * w + x + n] === c && n < 16383) n++;
      if (c !== 0 && n < 3) { for (let k = 0; k < n; k++) out.push(c); }
      else if (c === 0) out.push(0, ...(n < 64 ? [n] : [0x40 | (n >> 8), n & 255]));
      else out.push(0, ...(n < 64 ? [0x80 | n] : [0xC0 | (n >> 8), n & 255]), c);
      x += n;
    }
    out.push(0, 0);
  }
  return Buffer.from(out);
}
const seg = (type, data) => Buffer.concat([Buffer.from([type, data.length >> 8, data.length & 255]), data]);
const u16 = (v) => [v >> 8, v & 255];
/**
 * One PGS display set (segments only, as Matroska and MPEG-TS carry them).
 * objects: [{ id, x, y, pic }]; palette: [[index, Y, Cr, Cb, alpha]]; state: 0x80 epoch start, 0 normal.
 */
function pgsSet({ w = 1920, h = 1080, num = 0, state = 0x80, objects = [], palette = [], paletteOnly = false }) {
  const parts = [];
  const pcs = [...u16(w), ...u16(h), 0x10, ...u16(num), state, paletteOnly ? 0x80 : 0, 0, objects.length];
  objects.forEach((o, i) => pcs.push(...u16(o.id), 0, 0, ...u16(o.x), ...u16(o.y)));
  parts.push(seg(0x16, Buffer.from(pcs)));
  if (objects.length && !paletteOnly) {
    const wds = [objects.length];
    objects.forEach((o, i) => wds.push(i, ...u16(o.x), ...u16(o.y), ...u16(o.pic.w), ...u16(o.pic.h)));
    parts.push(seg(0x17, Buffer.from(wds)));
  }
  if (palette.length) parts.push(seg(0x14, Buffer.from([0, 0, ...palette.flat()])));
  if (!paletteOnly) {
    for (const o of objects) {
      const rle = pgsRle(o.pic.px, o.pic.w, o.pic.h);
      const len = rle.length + 4;
      // Split big pictures over several segments, like real discs do.
      const first = Buffer.concat([Buffer.from([...u16(o.id), 0, rle.length + 7 <= 65535 - 7 ? 0xC0 : 0x80, len >> 16, (len >> 8) & 255, len & 255, ...u16(o.pic.w), ...u16(o.pic.h)]), rle.subarray(0, 65000)]);
      if (rle.length <= 65000) { first[3] = 0xC0; parts.push(seg(0x15, first)); continue; }
      first[3] = 0x80;
      parts.push(seg(0x15, first));
      for (let at = 65000; at < rle.length; at += 65000) {
        const last = at + 65000 >= rle.length;
        parts.push(seg(0x15, Buffer.concat([Buffer.from([...u16(o.id), 0, last ? 0x40 : 0]), rle.subarray(at, at + 65000)])));
      }
    }
  }
  parts.push(seg(0x80, Buffer.alloc(0)));
  return Buffer.concat(parts);
}
/** Display sets [{ t (s), data }] → a .sup file. */
function sup(sets) {
  const out = [];
  for (const s of sets) {
    const pts = Math.round(s.t * 90000);
    for (let i = 0; i < s.data.length;) {
      const len = (s.data[i + 1] << 8) | s.data[i + 2];
      out.push(Buffer.from([0x50, 0x47, (pts >>> 24) & 255, (pts >> 16) & 255, (pts >> 8) & 255, pts & 255, 0, 0, 0, 0]), s.data.subarray(i, i + 3 + len));
      i += 3 + len;
    }
  }
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- VobSub
function vobRle(px, w, h, y0) {
  const nibs = [];
  for (let y = y0; y < h; y += 2) {
    let x = 0;
    while (x < w) {
      const c = px[y * w + x];
      let n = 1;
      while (x + n < w && px[y * w + x + n] === c && n < 255) n++;
      const v = (x + n === w && n > 63) ? c : (n << 2) | c; // (a run to the end of the line may use length 0)
      if (x + n === w && n > 63) nibs.push(0, 0, 0, c);
      else if (n < 4) nibs.push(v);
      else if (n < 16) nibs.push(v >> 4, v & 15);
      else if (n < 64) nibs.push(0, v >> 4, v & 15);
      else nibs.push(0, v >> 8, (v >> 4) & 15, v & 15);
      x += n;
    }
    if (nibs.length & 1) nibs.push(0);
  }
  const b = Buffer.alloc(nibs.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = (nibs[i * 2] << 4) | nibs[i * 2 + 1];
  return b;
}
/** One SPU packet. pic values 0–3; colours/alphas for values [0, 1, 2, 3]; end: seconds after it starts. */
function vobPacket({ x, y, pic, colours = [0, 1, 2, 3], alphas = [0, 15, 15, 15], end = 2, forced = false }) {
  const top = vobRle(pic.px, pic.w, pic.h, 0), bot = vobRle(pic.px, pic.w, pic.h, 1);
  const dataStart = 4, topOff = dataStart, botOff = topOff + top.length, ctrl = botOff + bot.length;
  const x2 = x + pic.w - 1, y2 = y + pic.h - 1;
  const seq1 = [0, 0, 0, 0, ...(forced ? [0x00] : []), 0x01,
    0x03, (colours[3] << 4) | colours[2], (colours[1] << 4) | colours[0],
    0x04, (alphas[3] << 4) | alphas[2], (alphas[1] << 4) | alphas[0],
    0x05, x >> 4, ((x & 15) << 4) | (x2 >> 8), x2 & 255, y >> 4, ((y & 15) << 4) | (y2 >> 8), y2 & 255,
    0x06, ...u16(topOff), ...u16(botOff), 0xff];
  const seq2At = ctrl + seq1.length;
  const date = Math.round(end * 90000 / 1024);
  const seq2 = [...u16(date), ...u16(seq2At), 0x02, 0xff];
  seq1[2] = seq2At >> 8; seq1[3] = seq2At & 255;
  const size = seq2At + seq2.length;
  return Buffer.concat([Buffer.from([...u16(size), ...u16(ctrl)]), top, bot, Buffer.from(seq1), Buffer.from(seq2)]);
}
const IDX = (w, h, pal) => `# VobSub index file, v7\nsize: ${w}x${h}\npalette: ${pal.map((c) => c.toString(16).padStart(6, '0')).join(', ')}\n`;

// ---------------------------------------------------------------- DVB (4-bit region, one object)
function dvbStr4(px, w, y0, h) {
  const bits = [];
  const put = (v, n) => { for (let k = n - 1; k >= 0; k--) bits.push((v >> k) & 1); };
  const out = [];
  for (let y = y0; y < h; y += 2) {
    out.push(0x11);
    let x = 0;
    while (x < w) {
      const c = px[y * w + x];
      let n = 1;
      while (x + n < w && px[y * w + x + n] === c && n < 280) n++;
      if (n >= 25) { put(0, 4); put(1, 1); put(1, 1); put(3, 2); put(n - 25, 8); put(c, 4); }
      else if (n >= 9) { put(0, 4); put(1, 1); put(1, 1); put(2, 2); put(n - 9, 4); put(c, 4); }
      else if (n >= 4) { put(0, 4); put(1, 1); put(0, 1); put(n - 4, 2); put(c, 4); }
      else for (let k = 0; k < n; k++) { if (c) put(c, 4); else { put(0, 4); put(1, 1); put(1, 1); put(0, 2); } }
      x += n;
    }
    put(0, 4); put(0, 1); put(0, 3); // end of string
    while (bits.length % 8) bits.push(0);
    for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    bits.length = 0;
    out.push(0xf0);
  }
  return Buffer.from(out);
}
/** A DVB display set: one region at (x, y) with one object; clut: [[entry, Y, Cr, Cb, T]]; empty: clears the page. */
function dvbSet({ x = 0, y = 0, pic = null, clut = [], state = 2, timeout = 10, page = 1 }) {
  const sg = (type, data) => Buffer.from([0x0f, type, ...u16(page), ...u16(data.length), ...data]);
  const parts = [sg(0x14, [0, ...u16(719), ...u16(575)])];
  parts.push(sg(0x10, [timeout, (0 << 4) | (state << 2), ...(pic ? [1, 0, ...u16(x), ...u16(y)] : [])]));
  if (pic) {
    parts.push(sg(0x11, [1, 0x08, ...u16(pic.w), ...u16(pic.h), (2 << 5) | (2 << 2), 1, 0, 0, ...u16(1), 0, 0, 0, 0]));
    parts.push(sg(0x12, [1, 0, ...clut.flatMap((e) => [e[0], 0x40 | 1, e[1], e[2], e[3], e[4]])]));
    const top = dvbStr4(pic.px, pic.w, 0, pic.h), bot = dvbStr4(pic.px, pic.w, 1, pic.h);
    parts.push(sg(0x13, [...u16(1), 0, ...u16(top.length), ...u16(bot.length), ...top, ...bot]));
  }
  parts.push(sg(0x80, []));
  return Buffer.concat([Buffer.from([0x20, 0x00]), ...parts, Buffer.from([0xff])]);
}

// ---------------------------------------------------------------- Matroska (just enough for ffmpeg to read it)
function ebmlId(id) { const b = []; let v = id; while (v) { b.unshift(v & 255); v = Math.floor(v / 256); } return Buffer.from(b); }
function ebmlSize(n) { const b = Buffer.alloc(8); b.writeUInt8(0x01, 0); b.writeUIntBE(Math.floor(n / 2 ** 32), 1, 3); b.writeUInt32BE(n >>> 0, 4); return b; }
const el = (id, data) => Buffer.concat([ebmlId(id), ebmlSize(data.length), data]);
const uint = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); let i = 0; while (i < 7 && b[i] === 0) i++; return b.subarray(i); };
/** tracks: [{ num, codec ('S_HDMV/PGS'…), priv, lang }]; packets: [{ track, t, d, data }] (seconds). */
function mkv({ tracks, packets }) {
  const head = el(0x1A45DFA3, Buffer.concat([el(0x4286, uint(1)), el(0x42F7, uint(1)), el(0x42F2, uint(4)), el(0x42F3, uint(8)), el(0x4282, Buffer.from('matroska')), el(0x4287, uint(4)), el(0x4285, uint(2))]));
  const info = el(0x1549A966, Buffer.concat([el(0x2AD7B1, uint(1e6)), el(0x4D80, Buffer.from('test')), el(0x5741, Buffer.from('test'))]));
  const tr = el(0x1654AE6B, Buffer.concat(tracks.map((t) => el(0xAE, Buffer.concat([
    el(0xD7, uint(t.num)), el(0x73C5, uint(t.num)), el(0x83, uint(0x11)), el(0x86, Buffer.from(t.codec)), el(0x22B59C, Buffer.from(t.lang || 'eng')),
    ...(t.priv ? [el(0x63A2, Buffer.from(t.priv))] : []),
  ])))));
  const clusters = [];
  const sorted = packets.slice().sort((a, b) => a.t - b.t);
  for (let i = 0; i < sorted.length;) {
    const base = Math.floor(sorted[i].t * 1000);
    const blocks = [];
    while (i < sorted.length && Math.floor(sorted[i].t * 1000) - base < 30000) {
      const p = sorted[i++];
      const rel = Math.floor(p.t * 1000) - base;
      const block = Buffer.concat([Buffer.from([0x80 | p.track, (rel >> 8) & 255, rel & 255, 0]), p.data]);
      blocks.push(el(0xA0, Buffer.concat([el(0xA1, block), ...(p.d ? [el(0x9B, uint(Math.round(p.d * 1000)))] : [])])));
    }
    clusters.push(el(0x1F43B675, Buffer.concat([el(0xE7, uint(base)), ...blocks])));
  }
  return Buffer.concat([head, el(0x18538067, Buffer.concat([info, tr, ...clusters]))]);
}

/** A test picture: a filled box with a frame (palette indices bg, frame, fill). */
function box(w, h, { bg = 0, frame = 1, fill = 2, border = 2 } = {}) {
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x < border || y < border || x >= w - border || y >= h - border) ? frame : fill;
  if (bg) px[0] = bg;
  return { w, h, px };
}

// ---------------------------------------------------------------- Teletext (EBU teletext in DVB) and MPEG-TS
const HAM84 = [0x15, 0x02, 0x49, 0x5e, 0x64, 0x73, 0x38, 0x2f, 0xd0, 0xc7, 0x8c, 0x9b, 0xa1, 0xb6, 0xfd, 0xea];
const rev8 = (b) => { let r = 0; for (let k = 0; k < 8; k++) if (b & (1 << k)) r |= 1 << (7 - k); return r; };
const odd = (c) => { let n = 0; for (let k = 0; k < 7; k++) n += (c >> k) & 1; return n % 2 ? c : c | 0x80; };
/** One 42-byte teletext packet (in teletext bit order). row 0: header for page (e.g. 0x88) with flags; rows 1–23: 40 characters. */
function ttxPacket(mag, row, { page = 0, erase = false, subtitle = false, text = '', nos = 0 } = {}) {
  const b = [HAM84[(mag & 7) | ((row & 1) << 3)], HAM84[row >> 1]];
  if (row === 0) {
    b.push(HAM84[page & 15], HAM84[page >> 4], HAM84[0], HAM84[erase ? 8 : 0], HAM84[0], HAM84[subtitle ? 8 : 0], HAM84[0], HAM84[(nos & 7) << 1]);
    for (let k = 0; k < 32; k++) b.push(odd(0x20));
  } else for (let k = 0; k < 40; k++) b.push(odd(k < text.length ? text.charCodeAt(k) & 0x7f : 0x20));
  return b;
}
/** A teletext PES payload from packets (data units 0x03, bytes reversed as DVB sends them). */
function ttxPes(packets) {
  const out = [0x10];
  for (const p of packets) out.push(0x03, 0x2c, 0xe4 ^ 0, rev8(0xe4), ...p.map(rev8));
  // (the field/line byte and framing code: the decoder doesn't look at them)
  return Buffer.from(out);
}
/** A subtitle page: header (erase, subtitle) and boxed rows; plus the next header that completes it. */
function ttxSubtitle(mag, page, lines, nos = 0) {
  const rows = [ttxPacket(mag, 0, { page, erase: true, subtitle: true, nos })];
  lines.forEach((l, i) => rows.push(ttxPacket(mag, 22 - (lines.length - 1 - i) * 2, { text: `\x0d\x0b\x0b${l}\x0a\x0a` })));
  return rows;
}
function crc32mpeg(b) { let c = 0xffffffff; for (const x of b) { c ^= x << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; } return c >>> 0; }
/** A small MPEG-TS: one private stream (pid) with descriptors, PES payloads [{ pts (s), data }]. */
function tsFile({ pid = 0x100, desc, pes }) {
  const pkts = [];
  const cc = {};
  const ts = (p, payload, pusi, pcr) => {
    for (let at = 0, first = true; at < payload.length || first; first = false) {
      const withPcr = first && pcr !== undefined, room = withPcr ? 176 : 184, chunk = payload.subarray(at, at + room);
      const b = Buffer.alloc(188, 0xff);
      b[0] = 0x47; b[1] = (first && pusi ? 0x40 : 0) | (p >> 8); b[2] = p & 255;
      cc[p] = ((cc[p] || 0) + 1) & 15;
      if (chunk.length < 184 || withPcr) {
        // adaptation field: stuffing, and the program clock (PCR) on the first packet of each PES
        const af = 183 - chunk.length; b[3] = 0x30 | cc[p]; b[4] = af;
        if (af > 0) { b[5] = withPcr ? 0x10 : 0; b.fill(0xff, 6, 5 + af); }
        if (withPcr) { const base = Math.max(0, Math.round(pcr * 90000)); b[6] = Math.floor(base / 2 ** 25) & 255; b[7] = (base >> 17) & 255; b[8] = (base >> 9) & 255; b[9] = (base >> 1) & 255; b[10] = ((base & 1) << 7) | 0x7e; b[11] = 0; }
        chunk.copy(b, 5 + af);
      } else { b[3] = 0x10 | cc[p]; chunk.copy(b, 4); }
      pkts.push(b);
      at += chunk.length;
    }
  };
  const section = (tid, body) => { const s = Buffer.from([tid, 0xb0 | ((body.length + 4) >> 8), (body.length + 4) & 255, ...body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32mpeg(s)); return Buffer.concat([Buffer.from([0]), s, c]); };
  const pat = section(0, [0, 1, 0xc1, 0, 0, 0, 1, 0xe0 | 0x10, 0x00]);
  const pmt = section(2, [0, 1, 0xc1, 0, 0, 0xe0 | (pid >> 8), pid & 255, 0xf0, 0, 0x06, 0xe0 | (pid >> 8), pid & 255, 0xf0 | (desc.length >> 8), desc.length & 255, ...desc]);
  for (const x of pes) {
    ts(0, pat, true); ts(0x1000, pmt, true);
    const pts = Math.round(x.t * 90000);
    const hdr = [0, 0, 1, 0xbd, 0, 0, 0x84, 0x80, 5, 0x21 | (((pts / 2 ** 30) & 7) << 1), (pts >> 22) & 255, ((pts >> 14) & 0xfe) | 1, (pts >> 7) & 255, ((pts << 1) & 0xfe) | 1];
    const body = Buffer.concat([Buffer.from(hdr), x.data]);
    body.writeUInt16BE(body.length - 6, 4);
    ts(pid, body, true, x.t - 0.1);
  }
  return Buffer.concat(pkts);
}
/** Teletext descriptor: [{ lang, type (2 subtitles), page (e.g. 0x888) }]. */
const ttxDesc = (list) => [0x56, list.length * 5, ...list.flatMap((x) => [...Buffer.from(x.lang), (x.type << 3) | ((x.page >> 8) & 7), x.page & 255])];
/** DVB subtitling descriptor: [{ lang, comp, anc }]. */
const dvbDesc = (list) => [0x59, list.length * 8, ...list.flatMap((x) => [...Buffer.from(x.lang), 0x10, x.comp >> 8, x.comp & 255, x.anc >> 8, x.anc & 255])];

module.exports = { pgsSet, pgsRle, sup, vobPacket, vobRle, IDX, dvbSet, mkv, box, ttxPacket, ttxPes, ttxSubtitle, tsFile, ttxDesc, dvbDesc };
