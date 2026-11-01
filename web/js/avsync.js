/* Audio sync: when a channel's sound and picture don't match.
   Sound comes too early → the sound is held back (a Web Audio delay on the player's sound).
   Sound comes too late  → the picture is held back: the video keeps playing underneath, and a canvas on top shows
   each frame a little later (frames are captured as they're shown, with VideoFrame where the browser has it, else
   copied into a small pool). Subtitles are drawn on top in real time, so they stay with the sound.
   Both need the browser to let this page read the stream. Streams the provider sends straight to the browser's own
   player don't allow that (the sound comes out silent and the canvas stays blank), so while an offset is set those
   play through the server's relay instead. With the offset at 0 nothing extra runs (no audio graph, no canvas).
   The offset is remembered per channel (or film/series) on this device, with a default for everything else. */
'use strict';
(function () {
  var PP = V.Player.prototype;
  var STEP = 50, MAX = 1000;

  // ---------------------------------------------------------------- the player's sound chain (shared with volume boost)
  /** element → delay → gain → (compressor, only while boosting) → speakers. Built once per video element. */
  V.audioGraph = function (p) {
    if (!p._audioSrc || p._graphFor !== p.video) {
      p._ac = p._ac || new (window.AudioContext || window.webkitAudioContext)();
      p._audioSrc = p._ac.createMediaElementSource(p.video);
      p._delay = p._ac.createDelay(MAX / 1000 + 0.05);
      p._gain = p._ac.createGain();
      p._comp = p._ac.createDynamicsCompressor();
      p._graphFor = p.video;
      p._audioSrc.connect(p._delay);
      p._delay.connect(p._gain);
      p._wired = null;
    }
    var boosted = p.boost && p.boost !== 1;
    if (p._wired !== (boosted ? 'comp' : 'plain')) {
      try { p._gain.disconnect(); } catch (e) {}
      try { p._comp.disconnect(); } catch (e) {}
      if (boosted) { p._gain.connect(p._comp); p._comp.connect(p._ac.destination); } else p._gain.connect(p._ac.destination);
      p._wired = boosted ? 'comp' : 'plain';
    }
    if (p._ac.state === 'suspended') p._ac.resume();
    return p;
  };
  // (setBoost sets the gain after calling V.audioGraph; re-wire once the new boost is known.)
  var origBoost = PP.setBoost;
  PP.setBoost = function (x, quietly) { origBoost.call(this, x, quietly); if (this._audioSrc && V.audioGraph) V.audioGraph(this); };

  // ---------------------------------------------------------------- remembering
  var keyOf = function (it) { return !it ? '' : it.t === 'catchup' ? it.catchupOf : it.sk || it.k; };
  var store = {
    get: function (key) { var m = V.ls.get('avsync', {}) || {}; if (key && typeof m[key] === 'number') return m[key]; return +V.ls.get('avsyncDefault', 0) || 0; },
    set: function (key, ms) {
      var m = V.ls.get('avsync', {}) || {};
      if (ms === (+V.ls.get('avsyncDefault', 0) || 0)) delete m[key]; else m[key] = ms;
      var keys = Object.keys(m);
      if (keys.length > 300) delete m[keys[0]];
      V.ls.set('avsync', m);
    },
    setDefault: function (ms) { V.ls.set('avsyncDefault', ms); },
  };
  V.avsyncStore = store;

  /** Can this page process the stream's sound and picture? Not when the provider's file goes to the browser's own player. */
  var readable = function (p) {
    var a = p.attempt;
    if (!a) return true;
    if (a.via !== 'direct') return true;
    if (a.kind !== 'native' && !a.native) return true; // hls.js / mpegts.js / Shaka feed the element from this page
    var u = a.url || '';
    return u.charAt(0) === '/' || u.indexOf(location.origin + '/') === 0;
  };
  var label = function (ms) { return !ms ? 'Off' : (ms > 0 ? '+' : '−') + Math.abs(ms) + ' ms'; };
  var describe = function (ms) { return !ms ? 'Audio sync off' : 'Audio sync ' + label(ms) + (ms > 0 ? ' · sound later' : ' · picture held back'); };

  /** Applies this player's offset (p.avOffset, ms). */
  PP.applyAvSync = function (announce) {
    var p = this, ms = p.avOffset || 0;
    if (!ms) { if (p._delay) p._delay.delayTime.value = 0; stopPicture(p); if (announce) p.osd(describe(0), 1400); return; }
    if (!readable(p)) return toRelay(p);
    try {
      if (ms > 0) { V.audioGraph(p); p._delay.delayTime.value = ms / 1000; stopPicture(p); }
      else { if (p._delay) p._delay.delayTime.value = 0; startPicture(p, -ms); }
    } catch (e) { console.warn('[avsync]', e); p.osd('Audio sync isn’t possible in this browser', 2500); return; }
    if (announce) p.osd(describe(ms), 1600);
  };
  /** Plays the same stream through the server's relay, which this page may read. */
  function toRelay(p) {
    stopPicture(p);
    if (S.settings.routing === 'direct-only' || !p.it || !p.url) { p.osd('Audio sync isn’t possible for this stream', 2500); return; }
    if (p._avRelayFor === p.it.k + '|' + p.alt) { p.osd('Audio sync isn’t possible for this stream', 2500); return; } // already tried
    p._avRelayFor = p.it.k + '|' + p.alt;
    p.osd('Audio sync needs this stream to come through the server — switching…', 3000);
    p.load(p.it, { only: { via: 'relay', kind: '?', url: p.url }, quiet: true, alt: p.alt, startAt: p.vod ? p.position : 0 });
  }
  PP.setAvSync = function (ms, opts) {
    opts = opts || {};
    ms = V.clamp(Math.round(ms / STEP) * STEP, -MAX, MAX);
    this.avOffset = ms;
    if (this.it) store.set(keyOf(this.it), ms);
    this.applyAvSync(!opts.quiet);
  };

  V.on('player-started', function (p) {
    var want = store.get(keyOf(p.it));
    p.avOffset = want;
    if (want || p._picture || (p._delay && p._delay.delayTime.value)) p.applyAvSync(false);
    if (want) p.osd(describe(want), 1600);
  });
  V.on('player-teardown', function (p) { stopPicture(p); });
  // Something new is played: it may try the relay again if it needs to.
  V.on('playing', function () { if (V.player) V.player._avRelayFor = null; });

  // ---------------------------------------------------------------- holding the picture back
  function startPicture(p, ms) {
    var pic = p._picture;
    if (pic && pic.video === p.video) { pic.delay = ms; return; }
    stopPicture(p);
    var v = p.video;
    var c = document.createElement('canvas');
    c.className = 'av-canvas';
    c.setAttribute('aria-hidden', 'true');
    var cues = document.createElement('div');
    cues.className = 'av-cues';
    cues.setAttribute('aria-live', 'off');
    v.parentNode.insertBefore(c, v.nextSibling);
    c.parentNode.insertBefore(cues, c.nextSibling);
    pic = p._picture = { video: v, canvas: c, ctx: c.getContext('2d'), cues: cues, delay: ms, q: [], pool: [], vf: !!window.VideoFrame, last: null, on: true, cueSig: '' };
    p.el.classList.add('av-delayed');
    var size = function () {
      var r = p.el.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = Math.max(2, Math.round(r.width * dpr)); c.height = Math.max(2, Math.round(r.height * dpr));
      cues.style.fontSize = Math.max(12, r.height * 0.045 * ((V.pref('subStyle') || {}).size || 100) / 100) + 'px';
      if (pic.last) drawFrame(p, pic, pic.last.f);
    };
    pic.size = size;
    size();
    if (window.ResizeObserver) { pic.ro = new ResizeObserver(size); pic.ro.observe(p.el); } else window.addEventListener('resize', size);
    pic.flush = function () { pic.q.forEach(function (x) { release(pic, x); }); pic.q = []; };
    v.addEventListener('seeking', pic.flush);
    capture(p, pic);
    var loop = function () { if (!pic.on) return; render(p, pic); pic.raf = requestAnimationFrame(loop); };
    pic.raf = requestAnimationFrame(loop);
    styleCues();
  }
  function stopPicture(p) {
    var pic = p && p._picture;
    if (!pic) return;
    pic.on = false;
    cancelAnimationFrame(pic.raf);
    if (pic.ro) pic.ro.disconnect();
    pic.video.removeEventListener('seeking', pic.flush);
    if (pic.vfcb && pic.video.cancelVideoFrameCallback) try { pic.video.cancelVideoFrameCallback(pic.vfcb); } catch (e) {}
    pic.flush();
    if (pic.last) { release(pic, pic.last); pic.last = null; }
    pic.canvas.remove(); pic.cues.remove();
    p.el.classList.remove('av-delayed');
    p._picture = null;
  }
  function release(pic, x) { if (x.f && x.f.close) { try { x.f.close(); } catch (e) {} } else if (x.f && x.f.tagName) pic.pool.push(x.f); }

  // Frames as the video shows them, stamped with when.
  function capture(p, pic) {
    var v = pic.video;
    var maxFrames = function () { return Math.min(pic.vf ? 90 : 36, Math.ceil(pic.delay / 1000 * 60) + 12); };
    var lastT = -1, lastAt = 0;
    var take = function () {
      if (!pic.on || v.readyState < 2 || !v.videoWidth) return;
      var now = performance.now();
      if (!pic.vf && now - lastAt < 30) return; // copies: at most ~30 a second
      lastAt = now;
      var f;
      try {
        if (pic.vf) f = new VideoFrame(v, { timestamp: Math.round((v.currentTime || 0) * 1e6) });
        else {
          f = pic.pool.pop() || document.createElement('canvas');
          var w = Math.min(960, v.videoWidth), h = Math.round(w * v.videoHeight / v.videoWidth);
          if (f.width !== w || f.height !== h) { f.width = w; f.height = h; }
          var cx = f.getContext('2d');
          cx.drawImage(v, 0, 0, w, h);
          if (!pic.checked) { pic.checked = true; cx.getImageData(0, 0, 1, 1); } // throws when the page may not read it
        }
      } catch (e) {
        if (e && e.name === 'SecurityError') { toRelay(p); return; }
        if (pic.vf) { pic.vf = false; return; } // no VideoFrame from this element here: copy instead
        return;
      }
      pic.q.push({ t: now, f: f });
      while (pic.q.length > maxFrames()) release(pic, pic.q.shift());
    };
    if (v.requestVideoFrameCallback) {
      var onFrame = function () { take(); if (pic.on) pic.vfcb = v.requestVideoFrameCallback(onFrame); };
      pic.vfcb = v.requestVideoFrameCallback(onFrame);
    } else {
      // No frame callbacks: look on every animation frame for a new picture.
      pic.poll = function () { if (v.currentTime !== lastT) { lastT = v.currentTime; take(); } };
    }
  }
  function render(p, pic) {
    if (pic.poll) pic.poll();
    var due = performance.now() - pic.delay, hit = -1;
    for (var i = 0; i < pic.q.length && pic.q[i].t <= due; i++) hit = i;
    if (hit >= 0) {
      var x = pic.q[hit];
      for (var j = 0; j < hit; j++) release(pic, pic.q[j]);
      pic.q = pic.q.slice(hit + 1);
      if (pic.last) release(pic, pic.last);
      pic.last = x;
      drawFrame(p, pic, x.f);
    }
    drawCues(p, pic);
  }
  function drawFrame(p, pic, f) {
    var c = pic.canvas, ctx = pic.ctx;
    var fw = f.displayWidth || f.width || p.video.videoWidth, fh = f.displayHeight || f.height || p.video.videoHeight;
    if (!fw || !fh) return;
    var W = c.width, H = c.height, z = p.zoom || 1;
    var sx = W / fw, sy = H / fh, w, h;
    if (p.fit === 'fill') { w = W; h = H; }
    else { var s = p.fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy); w = fw * s; h = fh * s; }
    w *= z; h *= z;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    try { ctx.filter = p._filter() || 'none'; } catch (e) {}
    try { ctx.drawImage(f, (W - w) / 2, (H - h) / 2, w, h); } catch (e) {}
    try { ctx.filter = 'none'; } catch (e) {}
  }
  // Subtitles: the browser draws them inside the (now covered) video, so show the active ones on top, right away.
  function drawCues(p, pic) {
    var tt = p.video.textTracks, lines = [];
    for (var i = 0; tt && i < tt.length; i++) {
      var t = tt[i];
      if (t.mode !== 'showing' || !t.activeCues) continue;
      for (var j = 0; j < t.activeCues.length; j++) lines.push(t.activeCues[j]);
    }
    var sig = lines.map(function (c) { return c.startTime + ':' + (c.text || ''); }).join('|');
    if (sig === pic.cueSig) return;
    pic.cueSig = sig;
    pic.cues.innerHTML = '';
    lines.forEach(function (c) {
      var span = document.createElement('span');
      if (c.getCueAsHTML) span.appendChild(c.getCueAsHTML()); else span.textContent = String(c.text || '').replace(/<[^>]+>/g, '');
      pic.cues.appendChild(span);
    });
  }
  function styleCues() {
    var st = V.pref('subStyle') || { color: '#ffffff', bg: 'rgba(0,0,0,0.6)', edge: 'shadow', font: 'sans' };
    var edge = { shadow: '0 2px 4px rgba(0,0,0,.9)', outline: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 4px #000', raised: '1px 1px 0 #000, 2px 2px 0 #000', none: 'none' }[st.edge] || 'none';
    var font = { sans: 'system-ui, sans-serif', serif: 'Georgia, serif', mono: 'ui-monospace, monospace', casual: '"Comic Sans MS", "Comic Neue", cursive', large: 'system-ui, sans-serif' }[st.font] || 'system-ui, sans-serif';
    var el = V.$('#av-cue-style') || document.head.appendChild(Object.assign(document.createElement('style'), { id: 'av-cue-style' }));
    el.textContent = '.vp .av-cues span { color: ' + st.color + '; background: ' + st.bg + '; text-shadow: ' + edge + '; font-family: ' + font + '; }';
  }
  V.on('prefs', function (k) { if (k === 'subStyle') styleCues(); });

  // ---------------------------------------------------------------- menu
  V.avsyncMenu = function (p, main, pages) {
    if (!p.it || p.it.t === 'radio') return;
    var cur = p.avOffset || 0;
    main.push({ label: 'Audio sync', value: label(cur), page: 'avsync' });
    var adj = function (d) { return function () { p.setAvSync((p.avOffset || 0) + d); }; };
    pages.avsync = [
      { label: 'Now: ' + (cur ? label(cur) + (cur > 0 ? ' (sound later)' : ' (sound earlier)') : 'in sync'), on: false, fn: function () {}, back: 'avsync' },
      { label: 'Sound earlier', value: '−' + STEP + ' ms', fn: adj(-STEP), back: 'avsync' },
      { label: 'Sound later', value: '+' + STEP + ' ms', fn: adj(STEP), back: 'avsync' },
      { label: 'Sound much earlier', value: '−250 ms', fn: adj(-250), back: 'avsync' },
      { label: 'Sound much later', value: '+250 ms', fn: adj(250), back: 'avsync' },
      { label: 'Back in sync (0)', fn: function () { p.setAvSync(0); }, back: 'avsync' },
      { label: 'Use ' + label(cur) + ' for everything', value: 'Default: ' + label(+V.ls.get('avsyncDefault', 0) || 0), fn: function () { store.setDefault(cur); p.osd('Audio sync ' + label(cur) + ' is now the default on this device', 2000); }, back: 'avsync' },
    ];
  };
})();
