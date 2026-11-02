/* Picture subtitles drawn by the player: PGS, VobSub and DVB tracks inside files (the server copies them out — see
   lib/picsubs.js — and this page fetches only the packets around where it's playing), and DVB / PGS subtitles on live
   MPEG-TS channels (mpegts.js hands over their packets as they arrive; see captions.js for the live tracks).
   A canvas over the video draws them where the video picture is (fit, fill, zoom, letterboxing, full screen), at the
   size chosen in Subtitle style, moved by Subtitle timing. Decoding happens only for what's on screen: seeking back
   starts again from the nearest complete picture. */
'use strict';
(function () {
  var PP = V.Player.prototype, D = V.picdec;
  if (!D) return;

  // ---------------------------------------------------------------- a track: entries (time, packet) and what's on screen
  /**
   * o: { kind: 'pgs' | 'vobsub' | 'dvb', label, lang, palette, plane: { w, h }, load(track, from, to) (fetches
   * packets for entries from..to; absent when they arrive with their data), clock(p) (the time to show, s) }.
   * Entries: { t (s), d (s, 0: until the next), f (2: decoding can start here, 4: clears), data }.
   */
  function PicTrack(o) {
    this.kind = o.kind; this.label = o.label || ''; this.lang = o.lang || '';
    this.palette = o.palette || null; this.plane = o.plane || null;
    this.ents = []; this.bytes = 0;
    this.loader = o.load || null; this.clock = o.clock || null;
    this.dec = null; this.decAt = -1; this.cacheAt = -1; this.cachePic = null;
  }
  PicTrack.prototype.find = function (t) {
    var a = 0, b = this.ents.length - 1, r = -1;
    while (a <= b) { var m = (a + b) >> 1; if (this.ents[m].t <= t) { r = m; a = m + 1; } else b = m - 1; }
    return r;
  };
  /** Adds an entry as it arrives (live): kept in time order, oldest dropped past a limit. */
  PicTrack.prototype.add = function (e) {
    var n = this.ents.length;
    if (n && e.t < this.ents[n - 1].t - 5) { this.ents = []; this.dec = null; this.decAt = -1; this.cacheAt = -1; this.bytes = 0; } // (the stream started again)
    this.ents.push(e);
    this.bytes += e.data ? e.data.length : 0;
    if (this.ents.length > 4000 || this.bytes > 12e6) this.trim(this.ents.length >> 2);
  };
  PicTrack.prototype.trim = function (n) {
    for (var i = 0; i < n; i++) this.bytes -= this.ents[i].data ? this.ents[i].data.length : 0;
    this.ents = this.ents.slice(n);
    this.dec = null; this.decAt = -1; this.cacheAt = -1;
  };
  /** The picture at time t: an object to draw, null for nothing, or 'wait' while its packets load. */
  PicTrack.prototype.at = function (t) {
    var j = this.find(t);
    if (j < 0) return null;
    var e = this.ents[j];
    if (e.f & 4) return null;
    var k = j;
    if (this.kind !== 'vobsub') while (k > 0 && !(this.ents[k].f & 2) && j - k < 300) k--;
    for (var q = k; q <= j; q++) if (!this.ents[q].data) { if (this.loader) this.loader(this, k, j); return 'wait'; }
    var pic = this.cacheAt === j ? this.cachePic : this._decode(k, j);
    if (!pic) return null;
    var end = e.d > 0 ? e.t + e.d : pic.end ? e.t + pic.end : pic.timeout ? e.t + pic.timeout : 0;
    if (end && t >= end) return null;
    if (pic.start && t < e.t + pic.start) return null;
    pic.id = j;
    return pic;
  };
  PicTrack.prototype._decode = function (k, j) {
    var pic = null;
    try {
      if (this.kind === 'vobsub') {
        var v = D.vobsub(this.ents[j].data, this.palette);
        var pl = this.plane || { w: 720, h: 576 };
        pic = v ? { w: pl.w, h: pl.h, items: [v], end: v.end, start: v.start } : null;
      } else {
        var from = k;
        if (this.dec && this.decAt >= k && this.decAt < j) from = this.decAt + 1; // carrying on from what's decoded
        else { this.dec = this.kind === 'pgs' ? new D.Pgs() : new D.Dvb(this.pages); } // (pages: a live stream's language)
        for (var q = from; q <= j; q++) this.dec.feed(this.ents[q].data);
        this.decAt = j;
        pic = this.dec.picture();
      }
    } catch (err) { console.warn('[picsubs] decode', err); this.dec = null; this.decAt = -1; }
    this.cacheAt = j; this.cachePic = pic;
    return pic;
  };
  /** Frees packets far from t (files: they can be fetched again). */
  PicTrack.prototype.forget = function (t) {
    if (!this.loader || this.bytes < 6e6) return;
    for (var i = 0; i < this.ents.length; i++) {
      var e = this.ents[i];
      if (e.data && (e.t < t - 120 || e.t > t + 300)) { this.bytes -= e.data.length; e.data = null; }
    }
    this.dec = null; this.decAt = -1;
  };
  V.PicTrack = PicTrack;

  // ---------------------------------------------------------------- tracks inside files (index + packets from the server)
  function fileTrack(p, s) {
    var it = p.it, alt = p.alt, base = '/api/picsubs/' + encodeURIComponent(it.k) + '/' + s.i;
    var tr = new PicTrack({ label: s.title || V.langName(s.lang) || 'Subtitles', lang: s.lang, kind: s.pic });
    tr.key = it.k + '|' + alt + '|' + s.i;
    tr.done = false; tr.busy = false; tr.failed = '';
    tr.gen = 0;
    var poll = function () {
      if (tr.stopped) { tr.running = false; return; }
      var gen = tr.gen;
      V.api(base + '?alt=' + alt + '&from=' + tr.ents.length).then(function (r) {
        if (gen !== tr.gen) return; // (stopped and started again meanwhile: that one carries on)
        if (r.err && !r.idx.length && r.done) { tr.failed = r.err; tr.running = false; if (V.player && V.player._pic === tr) V.player.osd('Subtitles: ' + r.err, 4000); return; }
        if (r.codec) tr.kind = r.codec;
        if (r.priv && !tr.palette) { var ix = D.parseIdx(r.priv); tr.palette = ix.palette; tr.plane = { w: ix.w, h: ix.h }; }
        (r.idx || []).forEach(function (x) { tr.ents.push({ t: x[0], d: x[1], off: x[2], len: x[3], f: x[4], data: null }); });
        tr.done = !!r.done;
        tr.cacheAt = -1;
        if (!tr.done) tr.pollT = setTimeout(poll, tr.ents.length ? 4000 : 1500); else tr.running = false;
      }, function (e) {
        if (gen !== tr.gen) return;
        tr.failed = e.message; tr.running = false;
        if (!tr.stopped && V.player && V.player._pic === tr) V.player.osd(e.message, 4000);
      });
    };
    // Packets: the ones needed now and the next minute or so, in one request.
    tr.loader = function (t, from, to) {
      if (t.busy) return;
      var last = to, size = 0, e0 = t.ents[from];
      while (last + 1 < t.ents.length && t.ents[last + 1].t < t.ents[to].t + 60 && last - to < 80 && size < 2e6) { last++; size += t.ents[last].len; }
      var o = e0.off, n = t.ents[last].off + t.ents[last].len - o;
      if (n <= 0 || n > 16e6) return;
      t.busy = true;
      var x = new XMLHttpRequest();
      x.open('GET', base + '/data?alt=' + alt + '&o=' + o + '&n=' + n);
      x.responseType = 'arraybuffer';
      x.onload = function () {
        t.busy = false;
        if (x.status !== 200 || !x.response) return;
        var buf = new Uint8Array(x.response);
        for (var q = from; q <= last; q++) { var e = t.ents[q]; if (!e.data && e.off - o + e.len <= buf.length) { e.data = buf.subarray(e.off - o, e.off - o + e.len); t.bytes += e.len; } }
      };
      x.onerror = function () { t.busy = false; };
      x.send();
    };
    tr.prefetch = function (now) {
      if (tr.busy) return;
      var a = tr.find(now) + 1;
      for (var q = a; q < tr.ents.length && tr.ents[q].t < now + 30; q++) if (!tr.ents[q].data) { tr.loader(tr, q, q); return; }
    };
    tr.stop = function () { tr.stopped = true; tr.running = false; clearTimeout(tr.pollT); };
    tr.start = function () { tr.stopped = false; if (tr.running || tr.done) return; tr.running = true; tr.gen++; poll(); };
    tr.clock = function (pl) { return pl.position; };
    return tr;
  }

  // ---------------------------------------------------------------- the canvas over the video
  function canvasOf(p) {
    var c = p._psCanvas;
    if (c && c.parentNode === p.el) return c;
    c = p._psCanvas = document.createElement('canvas');
    c.className = 'vp-picsub';
    c.setAttribute('aria-hidden', 'true');
    p.el.insertBefore(c, V.$('.vp-msg', p.el));
    return c;
  }
  /** Where the video picture is inside the player (the same sums as object-fit and the zoom). */
  function contentRect(p, W, H) {
    var v = p.video, vw = v.videoWidth, vh = v.videoHeight, z = p.zoom || 1, w, h;
    if (!vw || !vh) { w = W; h = H; }
    else if (p.fit === 'fill') { w = W; h = H; }
    else { var s = p.fit === 'cover' ? Math.max(W / vw, H / vh) : Math.min(W / vw, H / vh); w = vw * s; h = vh * s; }
    w *= z; h *= z;
    return { x: (W - w) / 2, y: (H - h) / 2, w: w, h: h };
  }
  function bitmap(it) {
    if (it._c) return it._c;
    var c = document.createElement('canvas');
    c.width = it.w; c.height = it.h;
    var x = c.getContext('2d'), img = x.createImageData(it.w, it.h);
    img.data.set(it.rgba);
    x.putImageData(img, 0, 0);
    it._c = c;
    return c;
  }
  function draw(p, pic) {
    var c = canvasOf(p), r = p.el.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    var W = Math.max(2, Math.round(r.width * dpr)), H = Math.max(2, Math.round(r.height * dpr));
    var size = ((V.pref('subStyle') || {}).size || 100) / 100;
    // While the controls show, subtitles near the bottom move up above them (as text subtitles do).
    var bar = !p.el.classList.contains('idle') && V.$('.vp-ctrl', p.el), lift = bar ? Math.round(bar.getBoundingClientRect().height * 0.8 * dpr) : 0;
    var sig = pic ? pic.id + ':' + W + 'x' + H + ':' + p.fit + ':' + p.zoom + ':' + p.video.videoWidth + 'x' + p.video.videoHeight + ':' + size + ':' + lift : '';
    if (sig === c._sig) return;
    c._sig = sig;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    var ctx = c.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!pic || !pic.items.length) return;
    var cr = contentRect(p, W, H), sx = cr.w / pic.w, sy = cr.h / pic.h;
    for (var i = 0; i < pic.items.length; i++) {
      var it = pic.items[i], w = it.w * sx * size, h = it.h * sy * size;
      var top = it.y + it.h / 2 < pic.h / 2; // (near the top: grows downwards; otherwise up from its bottom edge)
      var x0 = cr.x + (it.x + it.w / 2) * sx - w / 2, y0 = top ? cr.y + it.y * sy : cr.y + (it.y + it.h) * sy - h;
      x0 = Math.max(0, Math.min(W - w, x0)); y0 = Math.max(0, Math.min(H - h - (top ? 0 : lift), y0));
      ctx.imageSmoothingEnabled = true;
      try { ctx.drawImage(bitmap(it), x0, y0, w, h); } catch (e) {}
    }
  }

  // ---------------------------------------------------------------- showing a track
  PP.picSub = function (tr) {
    var old = this._pic;
    if (old && old !== tr && old.stop) old.stop();
    this._pic = tr || null;
    clearInterval(this._picT);
    if (this._psCanvas || this._ttxEl) { if (this._psCanvas) this._psCanvas._sig = null; V.picDraw(this, null); }
    if (!tr) return;
    if (tr.start) tr.start();
    var self = this, last = 0;
    this._picT = setInterval(function () {
      if (self._pic !== tr || !self.started) return;
      var t = (tr.clock ? tr.clock(self) : self.position) - (self.subDelay || 0);
      var pic = tr.at(t);
      if (pic === 'wait') return;
      V.picDraw(self, pic);
      var now = Date.now();
      if (now - last > 1000) { last = now; if (tr.prefetch) tr.prefetch(t); tr.forget(t); }
    }, 100);
  };

  // A file's picture track is chosen like its text tracks (the Subtitles menu, preferred language, the C key).
  var origFileSub = PP.fileSub;
  PP.fileSub = function (i) {
    var s = i >= 0 && this._fileTracks ? (this._fileTracks.subs || []).filter(function (x) { return x.i === i; })[0] : null;
    if (!s || !s.pic) { this.picSub(null); return origFileSub.call(this, i); }
    origFileSub.call(this, -1); // (any text track off)
    this._fileSub = i;
    var cache = this._picFiles || (this._picFiles = {});
    var key = this.it.k + '|' + this.alt + '|' + i;
    var tr = cache[key] || (cache[key] = fileTrack(this, s));
    this.picSub(tr);
    if (!tr.ents.length) this.osd('Loading subtitles…', 1500);
    this._menuRefresh();
  };
  // Choosing anything else in the Subtitles menu turns the picture track off.
  var origTracks = PP._tracks;
  PP._tracks = function () {
    var out = origTracks.apply(this, arguments), self = this;
    if (V.liveSubsInto) V.liveSubsInto(this, out); // (live channels: captions.js)
    if (out.subs) out.subs.items = out.subs.items.map(function (x) {
      if (x.pic) return x;
      var fn = x.fn;
      return { label: x.label, value: x.value, on: x.on, fn: function () { if (self._pic) self.picSub(null); fn(); } };
    });
    return out;
  };
  // ---------------------------------------------------------------- subtitle files next to a video (media folders)
  // "Film.en.srt", "Film.French.srt"…: listed with the file's own tracks (lib/routes-p6.js serves them as WebVTT).
  function mergeSide(p) {
    var side = p._sideSubs;
    if (!side || !side.length) return;
    var ft = p._fileTracks || (p._fileTracks = { audio: [], subs: [] });
    ft.subs = (ft.subs || []).filter(function (x) { return !x.side; }).concat(side);
  }
  var origResume = PP._resumeSubs;
  PP._resumeSubs = function () { mergeSide(this); return origResume.apply(this, arguments); };
  var origExtras = PP._loadExtras;
  PP._loadExtras = function () {
    origExtras.apply(this, arguments);
    var it = this.it, self = this, tok = this.token;
    if (!it || !this.vod || !/^local:/.test(this.url || '')) return;
    if (this._sideSubs && this._sideFor === it.k) { mergeSide(this); return this._menuRefresh(); }
    V.api('/api/sidesubs/' + encodeURIComponent(it.k)).then(function (list) {
      if (tok !== self.token || !list || !list.length) return;
      self._sideFor = it.k;
      self._sideSubs = list.map(function (x) { return { i: 1000 + x.n, lang: x.lang, title: x.label, text: true, forced: !!x.forced, side: '/api/sidesubs/' + encodeURIComponent(it.k) + '/' + x.n }; });
      mergeSide(self);
      self._menuRefresh();
      if (!(self._fileSub >= 0)) self._autoSubs();
    }).catch(function () {});
  };

  // A new title: forget the old one's tracks. A reload of the same one keeps them (fileSub starts them again).
  V.on('player-teardown', function (p) { if (p._pic) p.picSub(null); });
  var origLoad = PP.load;
  PP.load = function (it, opts) {
    if (!(opts && opts.quiet)) this._sideSubs = null;
    if (!(opts && opts.quiet) && this._picFiles) { var m = this._picFiles; Object.keys(m).forEach(function (k) { m[k].stop(); }); this._picFiles = null; }
    return origLoad.apply(this, arguments);
  };
  V.on('prefs', function (k) { var p = V.player; if (k === 'subStyle' && p && p._psCanvas) p._psCanvas._sig = null; });
  V.picDraw = draw;
})();
