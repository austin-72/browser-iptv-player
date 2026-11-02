/* Picture subtitles decoded in the browser: PGS (Blu-ray), VobSub (DVD) and DVB (broadcast).
   No DOM here (unit-tested in Node): each decoder takes the subtitle packets as the file or stream carries them and
   returns pictures to draw — { w, h (the subtitle plane), items: [{ x, y, w, h, rgba }] }.
   PGS: segments PCS/WDS/PDS/ODS/END, run-length coded 8-bit pictures, YCbCr palettes; a display set may reuse
   pictures and palettes from earlier ones in the same epoch, so the decoder keeps state.
   VobSub: one SPU packet per subtitle — 2-bit run-length coded, interlaced, coloured from the 16-colour palette in the
   .idx (or Matroska codec private data).
   DVB: segments page/region/CLUT/object; 2-, 4- and 8-bit pixel strings; regions keep their pixels across display
   sets in an epoch. */
'use strict';
(function () {
  var D = V.picdec = {};
  var clamp = function (x) { return x < 0 ? 0 : x > 255 ? 255 : x | 0; };
  /** Limited-range YCbCr → [r, g, b] (BT.709 for HD pictures, BT.601 otherwise). */
  var ycc = D.ycc = function (y, cb, cr, hd) {
    var Y = 1.164 * (y - 16), u = cb - 128, v = cr - 128;
    if (hd) return [clamp(Y + 1.793 * v), clamp(Y - 0.213 * u - 0.533 * v), clamp(Y + 2.112 * u)];
    return [clamp(Y + 1.596 * v), clamp(Y - 0.392 * u - 0.813 * v), clamp(Y + 2.017 * u)];
  };
  var u16 = function (b, i) { return (b[i] << 8) | b[i + 1]; };

  // ---------------------------------------------------------------- PGS
  /** Splits a .sup file (each segment behind a 13-byte "PG" header) into display sets: [{ pts (s), data }]. */
  D.splitSup = function (b) {
    var out = [], cur = null, i = 0;
    while (i + 13 <= b.length && b[i] === 0x50 && b[i + 1] === 0x47) {
      var pts = ((b[i + 2] * 16777216) + (b[i + 3] << 16) + (b[i + 4] << 8) + b[i + 5]) / 90000;
      var type = b[i + 10], len = u16(b, i + 11);
      if (!cur) cur = { pts: pts, parts: [] };
      cur.parts.push(b.subarray(i + 10, i + 13 + len));
      i += 13 + len;
      if (type === 0x80) { out.push({ pts: cur.pts, data: join(cur.parts) }); cur = null; }
    }
    return out;
  };
  function join(parts) {
    var n = 0, k;
    for (k = 0; k < parts.length; k++) n += parts[k].length;
    var o = new Uint8Array(n), at = 0;
    for (k = 0; k < parts.length; k++) { o.set(parts[k], at); at += parts[k].length; }
    return o;
  }
  /** The first PCS of a display set: { state, objects } (for the server's index and the player's seeking). */
  D.pgsInfo = function (b) {
    for (var i = 0; i + 3 <= b.length;) {
      var t = b[i], len = u16(b, i + 1);
      if (t === 0x16 && len >= 11) return { state: b[i + 3 + 7], objects: b[i + 3 + 10], w: u16(b, i + 3), h: u16(b, i + 5) };
      i += 3 + len;
    }
    return null;
  };

  function Pgs() { this.reset(); }
  Pgs.prototype.reset = function () { this.pal = {}; this.obj = {}; this.win = {}; this.comp = null; this.w = 1920; this.h = 1080; this.cache = {}; };
  /** Feeds one display set (segments: type, 16-bit length, data). */
  Pgs.prototype.feed = function (b) {
    for (var i = 0; i + 3 <= b.length;) {
      var t = b[i], len = u16(b, i + 1), s = b.subarray(i + 3, Math.min(b.length, i + 3 + len));
      i += 3 + len;
      if (t === 0x16) this._pcs(s);
      else if (t === 0x17) this._wds(s);
      else if (t === 0x14) this._pds(s);
      else if (t === 0x15) this._ods(s);
    }
  };
  Pgs.prototype._pcs = function (s) {
    if (s.length < 11) return;
    this.w = u16(s, 0) || this.w; this.h = u16(s, 2) || this.h;
    var state = s[7];
    if (state & 0x80) { this.pal = {}; this.obj = {}; this.win = {}; this.cache = {}; } // epoch start
    var c = { palUpdate: !!(s[8] & 0x80), pal: s[9], objs: [] }, n = s[10], p = 11;
    for (var k = 0; k < n && p + 8 <= s.length; k++) {
      var o = { id: u16(s, p), win: s[p + 2], forced: !!(s[p + 3] & 0x40), x: u16(s, p + 4), y: u16(s, p + 6) };
      var cropped = s[p + 3] & 0x80;
      p += 8;
      if (cropped && p + 8 <= s.length) { o.crop = { x: u16(s, p), y: u16(s, p + 2), w: u16(s, p + 4), h: u16(s, p + 6) }; p += 8; }
      c.objs.push(o);
    }
    // "Palette update only": the same pictures, new colours (fades).
    if (c.palUpdate && this.comp) c.objs = this.comp.objs;
    this.comp = c;
  };
  Pgs.prototype._wds = function (s) {
    for (var k = 0, p = 1; k < s[0] && p + 9 <= s.length; k++, p += 9) this.win[s[p]] = { x: u16(s, p + 1), y: u16(s, p + 3), w: u16(s, p + 5), h: u16(s, p + 7) };
  };
  Pgs.prototype._pds = function (s) {
    var id = s[0], pal = this.pal[id] || (this.pal[id] = new Uint8Array(1024)); // 256 × RGBA (unset entries: transparent)
    var hd = this.h >= 600;
    for (var p = 2; p + 5 <= s.length; p += 5) {
      var e = s[p], rgb = ycc(s[p + 1], s[p + 3], s[p + 2], hd); // (entry, Y, Cr, Cb, alpha)
      pal[e * 4] = rgb[0]; pal[e * 4 + 1] = rgb[1]; pal[e * 4 + 2] = rgb[2]; pal[e * 4 + 3] = s[p + 4];
    }
    this.cache = {};
  };
  Pgs.prototype._ods = function (s) {
    if (s.length < 4) return;
    var id = u16(s, 0), seq = s[3];
    if (seq & 0x80) {
      if (s.length < 11) return;
      this.obj[id] = { w: u16(s, 7), h: u16(s, 9), parts: [s.subarray(11)], px: null };
    } else if (this.obj[id] && !this.obj[id].px) this.obj[id].parts.push(s.subarray(4));
    else return;
    if (seq & 0x40) { var o = this.obj[id]; o.px = D.pgsRle(join(o.parts), o.w, o.h); o.parts = null; }
    delete this.cache[id];
  };
  /** PGS run lengths → one palette index per pixel. */
  D.pgsRle = function (b, w, h) {
    var px = new Uint8Array(w * h), x = 0, y = 0, i = 0, n = b.length;
    while (i < n && y < h) {
      var c = b[i++], run = 1;
      if (c === 0) {
        var f = b[i++];
        if (f === 0) { x = 0; y++; continue; } // end of line
        run = f & 0x3f;
        if (f & 0x40) run = (run << 8) | b[i++];
        c = f & 0x80 ? b[i++] : 0;
      }
      var at = y * w + x, end = Math.min(run, w - x);
      for (var k = 0; k < end; k++) px[at + k] = c;
      x += run;
    }
    return px;
  };
  /** What's on screen after the last display set: { w, h, items } (items is empty when it clears the screen). */
  Pgs.prototype.picture = function () {
    var out = { w: this.w, h: this.h, items: [] }, c = this.comp;
    if (!c) return out;
    var pal = this.pal[c.pal];
    for (var k = 0; k < c.objs.length; k++) {
      var co = c.objs[k], o = this.obj[co.id];
      if (!o || !o.px || !pal) continue;
      var key = co.id + ':' + c.pal, rgba = this.cache[key];
      if (!rgba) {
        rgba = new Uint8ClampedArray(o.w * o.h * 4);
        for (var q = 0, n = o.w * o.h; q < n; q++) { var e = o.px[q] * 4; rgba[q * 4] = pal[e]; rgba[q * 4 + 1] = pal[e + 1]; rgba[q * 4 + 2] = pal[e + 2]; rgba[q * 4 + 3] = pal[e + 3]; }
        this.cache[key] = rgba;
      }
      var it = { x: co.x, y: co.y, w: o.w, h: o.h, rgba: rgba, forced: co.forced };
      if (co.crop) it = crop(it, co.crop);
      if (it) out.items.push(it);
    }
    return out;
  };
  function crop(it, cr) {
    var w = Math.min(cr.w, it.w - cr.x), h = Math.min(cr.h, it.h - cr.y);
    if (w <= 0 || h <= 0) return null;
    var o = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) o.set(it.rgba.subarray(((cr.y + y) * it.w + cr.x) * 4, ((cr.y + y) * it.w + cr.x + w) * 4), y * w * 4);
    return { x: it.x, y: it.y, w: w, h: h, rgba: o, forced: it.forced };
  }
  D.Pgs = Pgs;

  // ---------------------------------------------------------------- VobSub
  /** The .idx text (or Matroska codec private data): { w, h, palette: [16 × 0xRRGGBB] }. */
  D.parseIdx = function (text) {
    text = String(text || '');
    var out = { w: 720, h: 576, palette: null };
    var m = /size:\s*(\d+)\s*x\s*(\d+)/i.exec(text);
    if (m) { out.w = +m[1]; out.h = +m[2]; }
    var p = /palette:\s*([0-9a-f,\s]+)/i.exec(text);
    if (p) {
      var list = p[1].split(',').map(function (x) { return parseInt(x.trim(), 16); }).filter(function (x) { return !isNaN(x); });
      if (list.length >= 4) { while (list.length < 16) list.push(0); out.palette = list.slice(0, 16); }
    }
    return out;
  };
  /** A plain grey-scale palette for VobSub tracks that come without one. */
  D.defaultPalette = [0x000000, 0xf0f0f0, 0xcccccc, 0x999999, 0x3333fa, 0x1111bb, 0xfa3333, 0xbb1111, 0x33fa33, 0x11bb11, 0xfafa33, 0xbbbb11, 0xfa33fa, 0xbb11bb, 0x33fafa, 0x11bbbb];
  /**
   * One SPU packet → { start, end (seconds after the packet's time; end null when the packet doesn't say), forced,
   * x, y, w, h, rgba } or null.
   */
  D.vobsub = function (b, palette) {
    if (!b || b.length < 4) return null;
    palette = palette || D.defaultPalette;
    var size = u16(b, 0), ctrl = u16(b, 2);
    if (size > b.length || ctrl >= size) size = b.length;
    var r = { start: 0, end: null, forced: false }, col = [0, 1, 2, 3], alpha = [0, 15, 15, 15], area = null, top = 0, bot = 0, have = false;
    var pos = ctrl, guard = 0;
    while (pos + 4 <= size && guard++ < 64) {
      var date = u16(b, pos) * 1024 / 90000, next = u16(b, pos + 2), p = pos + 4, done = false;
      while (p < size && !done) {
        var cmd = b[p++];
        if (cmd === 0x00) r.forced = true;
        else if (cmd === 0x01) r.start = date;
        else if (cmd === 0x02) r.end = date;
        else if (cmd === 0x03) { col = [b[p + 1] & 15, b[p + 1] >> 4, b[p] & 15, b[p] >> 4]; p += 2; } // (for pixel values 0, 1, 2, 3)
        else if (cmd === 0x04) { alpha = [b[p + 1] & 15, b[p + 1] >> 4, b[p] & 15, b[p] >> 4]; p += 2; }
        else if (cmd === 0x05) { area = { x1: (b[p] << 4) | (b[p + 1] >> 4), x2: ((b[p + 1] & 15) << 8) | b[p + 2], y1: (b[p + 3] << 4) | (b[p + 4] >> 4), y2: ((b[p + 4] & 15) << 8) | b[p + 5] }; p += 6; }
        else if (cmd === 0x06) { top = u16(b, p); bot = u16(b, p + 2); p += 4; have = true; }
        else done = true; // 0xff: end of this sequence (or something we don't know)
      }
      if (next === pos || next < ctrl) break;
      pos = next;
    }
    if (!area || !have) return null;
    var w = area.x2 - area.x1 + 1, h = area.y2 - area.y1 + 1;
    if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return null;
    var px = new Uint8Array(w * h);
    vobField(b, top, size, px, w, h, 0);
    vobField(b, bot, size, px, w, h, 1);
    var rgba = new Uint8ClampedArray(w * h * 4), lut = [];
    for (var v = 0; v < 4; v++) { var c = palette[col[v]] || 0; lut.push([(c >> 16) & 255, (c >> 8) & 255, c & 255, alpha[v] * 17]); }
    for (var q = 0, n = w * h; q < n; q++) { var e = lut[px[q]]; rgba[q * 4] = e[0]; rgba[q * 4 + 1] = e[1]; rgba[q * 4 + 2] = e[2]; rgba[q * 4 + 3] = e[3]; }
    r.x = area.x1; r.y = area.y1; r.w = w; r.h = h; r.rgba = rgba;
    return r;
  };
  function vobField(b, start, end, px, w, h, y0) {
    var o = start * 2, lim = end * 2; // (in nibbles)
    var nib = function () { var v = o < lim ? (b[o >> 1] >> ((o & 1) ? 0 : 4)) & 15 : 0; o++; return v; };
    for (var y = y0; y < h && o < lim; y += 2) {
      var x = 0;
      while (x < w && o < lim) {
        var c = nib();
        if (c < 0x4) { c = (c << 4) | nib(); if (c < 0x10) { c = (c << 4) | nib(); if (c < 0x40) c = (c << 4) | nib(); } }
        var run = c >> 2, val = c & 3;
        if (run === 0) run = w - x; // to the end of the line
        var at = y * w + x, stop = Math.min(w, x + run);
        for (; x < stop; x++, at++) px[at] = val;
      }
      if (o & 1) o++; // each line starts on a byte
    }
  }

  // ---------------------------------------------------------------- DVB
  /** The page composition of a display set: { state, regions, timeout } (for the index and for seeking). */
  D.dvbInfo = function (b) {
    var i = b[0] === 0x20 && b[1] === 0x00 ? 2 : 0;
    while (i + 6 <= b.length && b[i] === 0x0f) {
      var t = b[i + 1], len = u16(b, i + 4);
      if (t === 0x10 && len >= 2) return { timeout: b[i + 6], state: (b[i + 7] >> 2) & 3, regions: Math.floor((len - 2) / 6) };
      i += 6 + len;
    }
    return null;
  };
  /** pages: { comp, anc } — only these page ids (a stream can carry several languages); none: every page. */
  function Dvb(pages) { this.pages = pages || null; this.reset(); }
  Dvb.prototype.reset = function () { this.w = 720; this.h = 576; this.dx = 0; this.dy = 0; this.cluts = {}; this.regions = {}; this.page = null; this.timeout = 0; };
  Dvb.prototype.feed = function (b) {
    var i = b[0] === 0x20 && b[1] === 0x00 ? 2 : 0, pg = this.pages;
    while (i + 6 <= b.length && b[i] === 0x0f) {
      var t = b[i + 1], len = u16(b, i + 4), s = b.subarray(i + 6, Math.min(b.length, i + 6 + len)), id = u16(b, i + 2);
      i += 6 + len;
      if (pg && id !== pg.comp && id !== pg.anc) continue;
      if (t === 0x10) this._page(s);
      else if (t === 0x11) this._region(s);
      else if (t === 0x12) this._clut(s);
      else if (t === 0x13) this._object(s);
      else if (t === 0x14) this._display(s);
    }
  };
  Dvb.prototype._display = function (s) {
    if (s.length < 5) return;
    this.w = u16(s, 1) + 1; this.h = u16(s, 3) + 1;
    if ((s[0] & 0x08) && s.length >= 13) { this.dx = u16(s, 5); this.dy = u16(s, 9); } // (display window: positions are inside it)
  };
  Dvb.prototype._page = function (s) {
    if (s.length < 2) return;
    var state = (s[1] >> 2) & 3;
    if (state === 2 || state === 1) { this.regions = {}; this.cluts = {}; } // mode change / acquisition point: everything is sent again
    this.timeout = s[0];
    var regs = [];
    for (var p = 2; p + 6 <= s.length; p += 6) regs.push({ id: s[p], x: u16(s, p + 2), y: u16(s, p + 4) });
    this.page = regs;
  };
  Dvb.prototype._region = function (s) {
    if (s.length < 10) return;
    var id = s[0], fill = !!(s[1] & 0x08), w = u16(s, 2), h = u16(s, 4), depth = [0, 2, 4, 8][(s[6] >> 2) & 7] || 4;
    var r = this.regions[id];
    if (!r || r.w !== w || r.h !== h || r.depth !== depth) r = this.regions[id] = { w: w, h: h, depth: depth, px: new Uint8Array(w * h), objs: [] };
    r.clut = s[7];
    var bg = depth === 8 ? s[8] : depth === 4 ? s[9] >> 4 : (s[9] >> 2) & 3;
    if (fill) for (var q = 0; q < r.px.length; q++) r.px[q] = bg;
    r.objs = [];
    for (var p = 10; p + 6 <= s.length;) {
      var type = s[p + 2] >> 6;
      r.objs.push({ id: u16(s, p), x: u16(s, p + 2) & 0x0fff, y: u16(s, p + 4) & 0x0fff });
      p += 6 + (type === 1 || type === 2 ? 2 : 0);
    }
  };
  Dvb.prototype._clut = function (s) {
    var id = s[0], c = this.cluts[id] || (this.cluts[id] = { 2: defClut(2), 4: defClut(4), 8: defClut(8) });
    for (var p = 2; p + 2 <= s.length;) {
      var e = s[p], fl = s[p + 1], y, cr, cb, t;
      if (fl & 1) { y = s[p + 2]; cr = s[p + 3]; cb = s[p + 4]; t = s[p + 5]; p += 6; }
      else { var v = u16(s, p + 2); y = (v >> 10) << 2; cr = ((v >> 6) & 15) << 4; cb = ((v >> 2) & 15) << 4; t = (v & 3) * 85; p += 4; }
      var rgb = ycc(y, cb, cr, false), a = y === 0 ? 0 : 255 - t;
      var put = function (tab) { if (e * 4 + 3 < tab.length) { tab[e * 4] = rgb[0]; tab[e * 4 + 1] = rgb[1]; tab[e * 4 + 2] = rgb[2]; tab[e * 4 + 3] = a; } };
      if (fl & 0x80) put(c[2]);
      if (fl & 0x40) put(c[4]);
      if (fl & 0x20) put(c[8]);
    }
  };
  /** The default CLUTs from the DVB subtitling standard (EN 300 743, 10). */
  function defClut(depth) {
    var n = 1 << depth, t = new Uint8Array(n * 4), i;
    var set = function (k, r, g, b, a) { t[k * 4] = r; t[k * 4 + 1] = g; t[k * 4 + 2] = b; t[k * 4 + 3] = a; };
    if (depth === 2) { set(0, 0, 0, 0, 0); set(1, 255, 255, 255, 255); set(2, 0, 0, 0, 255); set(3, 127, 127, 127, 255); return t; }
    for (i = 0; i < n; i++) {
      var r, g, b, a = 255;
      if (depth === 4) {
        if (i < 8) { r = i & 1 ? 255 : 0; g = i & 2 ? 255 : 0; b = i & 4 ? 255 : 0; if (!i) a = 0; }
        else { r = i & 1 ? 127 : 0; g = i & 2 ? 127 : 0; b = i & 4 ? 127 : 0; }
      } else {
        var hi = i & 0x88;
        if (i < 8) { r = i & 1 ? 255 : 0; g = i & 2 ? 255 : 0; b = i & 4 ? 255 : 0; a = i ? 63 : 0; }
        else if (hi === 0x00) { r = (i & 1 ? 85 : 0) + (i & 0x10 ? 170 : 0); g = (i & 2 ? 85 : 0) + (i & 0x20 ? 170 : 0); b = (i & 4 ? 85 : 0) + (i & 0x40 ? 170 : 0); }
        else if (hi === 0x08) { r = (i & 1 ? 85 : 0) + (i & 0x10 ? 170 : 0); g = (i & 2 ? 85 : 0) + (i & 0x20 ? 170 : 0); b = (i & 4 ? 85 : 0) + (i & 0x40 ? 170 : 0); a = 127; }
        else if (hi === 0x80) { r = 127 + (i & 1 ? 43 : 0) + (i & 0x10 ? 85 : 0); g = 127 + (i & 2 ? 43 : 0) + (i & 0x20 ? 85 : 0); b = 127 + (i & 4 ? 43 : 0) + (i & 0x40 ? 85 : 0); }
        else { r = (i & 1 ? 43 : 0) + (i & 0x10 ? 85 : 0); g = (i & 2 ? 43 : 0) + (i & 0x20 ? 85 : 0); b = (i & 4 ? 43 : 0) + (i & 0x40 ? 85 : 0); }
      }
      set(i, r, g, b, a);
    }
    return t;
  }
  Dvb.prototype._object = function (s) {
    if (s.length < 3) return;
    var id = u16(s, 0), method = (s[2] >> 2) & 3, nonMod = !!(s[2] & 2);
    if (method !== 0 || s.length < 7) return; // (character-coded objects aren't used for subtitles in practice)
    var tl = u16(s, 3), bl = u16(s, 5), topF = s.subarray(7, 7 + tl), botF = bl ? s.subarray(7 + tl, 7 + tl + bl) : topF;
    for (var rid in this.regions) {
      var r = this.regions[rid];
      for (var k = 0; k < r.objs.length; k++) {
        if (r.objs[k].id !== id) continue;
        dvbField(topF, r, r.objs[k].x, r.objs[k].y, nonMod);
        dvbField(botF, r, r.objs[k].x, r.objs[k].y + 1, nonMod);
      }
    }
  };
  var MAP24 = [0, 7, 8, 15], MAP28 = [0, 0x77, 0x88, 0xff], MAP48 = [0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
  function dvbField(b, r, x0, y, nonMod) {
    var i = 0, x = x0, m24 = MAP24.slice(), m28 = MAP28.slice(), m48 = MAP48.slice();
    var put = function (code, run, bits) {
      var v = code;
      if (bits === 2 && r.depth === 4) v = m24[code]; else if (bits === 2 && r.depth === 8) v = m28[code]; else if (bits === 4 && r.depth === 8) v = m48[code];
      else if (bits > r.depth) v = r.depth === 2 ? (code >> (bits - 2)) & 3 : (code >> (bits - 4)) & 15;
      if (y < r.h) {
        var at = y * r.w;
        for (var k = 0; k < run && x < r.w; k++, x++) if (!(nonMod && code === 1)) r.px[at + x] = v;
      }
    };
    while (i < b.length) {
      var t = b[i++];
      if (t === 0x10 || t === 0x11 || t === 0x12) {
        var br = bitReader(b, i), bits = t === 0x10 ? 2 : t === 0x11 ? 4 : 8;
        if (bits === 2) str2(br, put); else if (bits === 4) str4(br, put); else str8(br, put);
        i = br.bytePos();
      } else if (t === 0x20) { m24 = [b[i] >> 4, b[i] & 15, b[i + 1] >> 4, b[i + 1] & 15]; i += 2; }
      else if (t === 0x21) { m28 = [b[i], b[i + 1], b[i + 2], b[i + 3]]; i += 4; }
      else if (t === 0x22) { m48 = []; for (var q = 0; q < 8; q++) { m48.push(b[i + q] >> 4, b[i + q] & 15); } i += 8; }
      else if (t === 0xf0) { x = x0; y += 2; }
      else break;
    }
  }
  function bitReader(b, start) {
    var pos = start * 8;
    return {
      read: function (n) { var v = 0; for (var k = 0; k < n; k++, pos++) v = (v << 1) | ((b[pos >> 3] >> (7 - (pos & 7))) & 1); return v; },
      bytePos: function () { return (pos + 7) >> 3; },
      left: function () { return b.length * 8 - pos; },
    };
  }
  function str2(br, put) {
    while (br.left() >= 2) {
      var c = br.read(2);
      if (c) { put(c, 1, 2); continue; }
      if (br.read(1)) { var run = br.read(3) + 3; put(br.read(2), run, 2); continue; }
      if (br.read(1)) { put(0, 1, 2); continue; }
      var s3 = br.read(2);
      if (s3 === 0) return;
      if (s3 === 1) put(0, 2, 2);
      else if (s3 === 2) { var r2 = br.read(4) + 12; put(br.read(2), r2, 2); }
      else { var r3 = br.read(8) + 29; put(br.read(2), r3, 2); }
    }
  }
  function str4(br, put) {
    while (br.left() >= 4) {
      var c = br.read(4);
      if (c) { put(c, 1, 4); continue; }
      if (!br.read(1)) { var n = br.read(3); if (!n) return; put(0, n + 2, 4); continue; }
      if (!br.read(1)) { var run = br.read(2) + 4; put(br.read(4), run, 4); continue; }
      var s3 = br.read(2);
      if (s3 === 0) put(0, 1, 4);
      else if (s3 === 1) put(0, 2, 4);
      else if (s3 === 2) { var r2 = br.read(4) + 9; put(br.read(4), r2, 4); }
      else { var r3 = br.read(8) + 25; put(br.read(4), r3, 4); }
    }
  }
  function str8(br, put) {
    while (br.left() >= 8) {
      var c = br.read(8);
      if (c) { put(c, 1, 8); continue; }
      if (!br.read(1)) { var n = br.read(7); if (!n) return; put(0, n, 8); continue; }
      var run = br.read(7);
      put(br.read(8), run, 8);
    }
  }
  /** What's on screen: the page's regions, coloured. */
  Dvb.prototype.picture = function () {
    var out = { w: this.w, h: this.h, items: [], timeout: this.timeout };
    var page = this.page || [];
    for (var k = 0; k < page.length; k++) {
      var r = this.regions[page[k].id];
      if (!r) continue;
      var cl = this.cluts[r.clut], tab = cl ? cl[r.depth] : defClut(r.depth);
      var rgba = new Uint8ClampedArray(r.w * r.h * 4), any = false;
      for (var q = 0, n = r.w * r.h; q < n; q++) {
        var e = r.px[q] * 4;
        if (!tab[e + 3]) continue;
        any = true;
        rgba[q * 4] = tab[e]; rgba[q * 4 + 1] = tab[e + 1]; rgba[q * 4 + 2] = tab[e + 2]; rgba[q * 4 + 3] = tab[e + 3];
      }
      if (any) out.items.push({ x: this.dx + page[k].x, y: this.dy + page[k].y, w: r.w, h: r.h, rgba: rgba });
    }
    return out;
  };
  D.Dvb = Dvb;

  // ---------------------------------------------------------------- Teletext subtitles (EBU teletext in DVB, EN 300 472)
  var REV = new Uint8Array(256), HAM = new Uint8Array(256);
  for (var bi = 0; bi < 256; bi++) {
    var rv = 0;
    for (var bk = 0; bk < 8; bk++) if (bi & (1 << bk)) rv |= 1 << (7 - bk);
    REV[bi] = rv;
    HAM[bi] = ((bi >> 1) & 1) | (((bi >> 3) & 1) << 1) | (((bi >> 5) & 1) << 2) | (((bi >> 7) & 1) << 3); // (data bits of Hamming 8/4)
  }
  /** National option characters at 0x23 0x24 0x40 0x5b–0x60 0x7b–0x7e, by the header's C12–C14. */
  var NOS = [
    '£$@←½→↑#—¼‖¾÷', // English
    '#$§ÄÖÜ^_°äöüß', // German
    '#¤ÉÄÖÅÜ_éäöåü', // Swedish, Finnish, Hungarian
    '£$é°ç→↑#ùàòèì', // Italian
    'éïàëêùî#èâôûç', // French
    'ç$¡áéíóú¿üñèà', // Portuguese, Spanish
    '#ůčťžýířéáěúš', // Czech, Slovak
    '£$@←½→↑#—¼‖¾÷',
  ];
  var NOS_AT = [0x23, 0x24, 0x40, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x60, 0x7b, 0x7c, 0x7d, 0x7e];
  /** The pages a teletext descriptor (tag 0x56) lists: [{ lang, type (2, 5: subtitles), page: e.g. 0x888 }]. */
  D.ttxPages = function (d) {
    var out = [];
    for (var i = 0; i + 5 <= d.length; i += 5) out.push({ lang: String.fromCharCode(d[i], d[i + 1], d[i + 2]), type: d[i + 3] >> 3, page: ((d[i + 3] & 7) || 8) * 256 + d[i + 4] });
    return out;
  };
  /** Follows one page (e.g. 0x888) through the teletext stream; feed(PES data) → [{ text }] each time the page is complete. */
  function Ttx(page) { this.mag = page >> 8; this.num = page & 255; this.rows = null; this.last = []; this.nos = 0; }
  Ttx.prototype.feed = function (b) {
    var out = [];
    if (!b || b.length < 2 || b[0] < 0x10 || b[0] > 0x1f) return out;
    for (var i = 1; i + 2 <= b.length;) {
      var id = b[i], len = b[i + 1];
      if ((id === 2 || id === 3) && len === 0x2c && i + 2 + len <= b.length) this._packet(b.subarray(i + 4, i + 2 + len), out);
      i += 2 + len;
    }
    return out;
  };
  Ttx.prototype._packet = function (raw, out) {
    var b = new Uint8Array(42);
    for (var k = 0; k < 42; k++) b[k] = REV[raw[k]];
    var a = HAM[b[0]] | (HAM[b[1]] << 4), mag = (a & 7) || 8, row = a >> 3;
    if (row === 0) {
      var pg = (HAM[b[3]] << 4) | HAM[b[2]], erase = HAM[b[5]] & 8, serial = HAM[b[9]] & 1;
      // A header in this magazine (any magazine when they're sent one after another) ends the page being received.
      if (this.rows && (mag === this.mag || serial)) { out.push({ text: this.text(this.rows) }); this.last = this.rows; this.rows = null; }
      if (mag === this.mag && pg === this.num) {
        this.rows = erase ? [] : this.last.slice();
        this.nos = (HAM[b[9]] >> 1) & 7;
      }
    } else if (row <= 23 && this.rows && mag === this.mag) this.rows[row] = b.subarray(2, 42);
  };
  /** The boxed text of the rows (what subtitles show), one line per row. */
  Ttx.prototype.text = function (rows) {
    var lines = [], set = NOS[this.nos] || NOS[0];
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row) continue;
      var s = '', boxed = false, any = false;
      for (var k = 0; k < row.length; k++) if ((row[k] & 0x7f) === 0x0b) { any = true; break; }
      for (var q = 0; q < row.length; q++) {
        var c = row[q] & 0x7f;
        if (c === 0x0b) { boxed = true; s += ' '; continue; }
        if (c === 0x0a) { boxed = false; s += ' '; continue; }
        if (any && !boxed) continue;
        if (c < 0x20) { s += ' '; continue; }
        var n = NOS_AT.indexOf(c);
        s += n >= 0 ? set.charAt(n) : c === 0x7f ? ' ' : String.fromCharCode(c);
      }
      s = s.replace(/\s+/g, ' ').replace(/^ | $/g, '');
      if (s) lines.push(s);
    }
    return lines.join('\n');
  };
  D.Ttx = Ttx;

  /** The subtitle tracks a stream's descriptors (PMT, ES info) announce: [{ kind: 'dvb' | 'ttx', lang, page, comp, anc, hi }]. */
  D.esSubs = function (d) {
    var out = [];
    for (var i = 0; i + 2 <= d.length;) {
      var tag = d[i], len = d[i + 1], x = d.subarray(i + 2, i + 2 + len);
      if (tag === 0x59) for (var k = 0; k + 8 <= x.length; k += 8) out.push({ kind: 'dvb', lang: String.fromCharCode(x[k], x[k + 1], x[k + 2]), hi: x[k + 3] >= 0x20 && x[k + 3] <= 0x24, comp: u16(x, k + 4), anc: u16(x, k + 6) });
      if (tag === 0x56 || tag === 0x46) D.ttxPages(x).forEach(function (p) { if (p.type === 2 || p.type === 5) out.push({ kind: 'ttx', lang: p.lang, page: p.page, hi: p.type === 5 }); });
      i += 2 + len;
    }
    return out;
  };
})();
