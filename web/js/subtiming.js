/* Subtitle timing: move every kind of subtitle the player shows earlier or later (Subtitles menu → Subtitle timing,
   G / H keys). Text subtitles (inside HLS, read from files, found online, captions) are moved by shifting their cues —
   each cue keeps its own times, so it can be moved again or back. Picture subtitles (picsubs.js) read p.subDelay.
   The offset is remembered per title (film, episode or channel) in the profile's settings. */
'use strict';
(function () {
  var PP = V.Player.prototype;
  var MAX = 600;
  var keyOf = function (it) { return !it ? '' : it.t === 'catchup' ? it.catchupOf : it.k; };
  var round = function (s) { return Math.round(s * 10) / 10; };
  /** "+1.5 s", "−0.5 s", "0 s". */
  var label = V.subDelayLabel = function (s) {
    s = round(s || 0);
    if (!s) return '0 s';
    return (s > 0 ? '+' : '−') + String(Math.abs(s)) + '\u00a0s'; // (no break between number and unit)
  };
  var describe = function (s) { s = round(s || 0); return !s ? 'Subtitles in sync' : 'Subtitles ' + label(s) + (s > 0 ? ' (later)' : ' (earlier)'); };

  var store = V.subDelayStore = {
    get: function (it) { var m = V.pref('subDelay') || {}, v = m[keyOf(it)]; return typeof v === 'number' && isFinite(v) ? v : 0; },
    set: function (it, s) {
      var k = keyOf(it);
      if (!k || !S.data) return;
      var m = Object.assign({}, V.pref('subDelay') || {});
      if ((m[k] || 0) === s) return;
      delete m[k];
      if (s) m[k] = s;
      var keys = Object.keys(m);
      while (keys.length > 300) delete m[keys.shift()];
      V.setPref('subDelay', m);
    },
  };

  /** Moves the cues of every text track by p.subDelay (only what's new since last time, unless `all`). */
  var shiftCues = PP._shiftCues = function (all) {
    var p = this, d = p.subDelay || 0, tt = p.video && p.video.textTracks;
    if (!tt || (!d && !p._cueShifted)) return;
    if (d) p._cueShifted = true;
    for (var i = 0; i < tt.length; i++) {
      var t = tt[i], cues = t.kind !== 'metadata' ? t.cues : null;
      if (!cues || !cues.length) continue;
      var n = cues.length, first = cues[0], last = cues[n - 1];
      if (!all && t._sdN === n && t._sdD === d && first._sd === d && last._sd === d) continue;
      var list = Array.prototype.slice.call(cues); // (moving cues re-sorts the live list)
      for (var j = 0; j < list.length; j++) {
        var c = list[j];
        if (c._sd === d) continue;
        if (c._t0 === undefined) { c._t0 = c.startTime; c._t1 = c.endTime; }
        try {
          var s = Math.max(0, c._t0 + d), e = Math.max(s + 0.05, c._t1 + d);
          if (e > c.endTime) { c.endTime = e; c.startTime = s; } else { c.startTime = s; c.endTime = e; }
        } catch (err) {}
        c._sd = d;
      }
      t._sdN = cues.length; t._sdD = d;
    }
  };

  PP.setSubDelay = function (s, opts) {
    opts = opts || {};
    s = V.clamp(round(s), -MAX, MAX);
    this.subDelay = s;
    if (this.it && !opts.noSave) store.set(this.it, s);
    this._shiftCues(true);
    V.emit('subdelay', this);
    if (!opts.quiet) this.osd(describe(s), 1500);
    this._menuRefresh();
  };
  PP.nudgeSubs = function (d) { this.setSubDelay((this.subDelay || 0) + d); };

  // New cues keep arriving (live subtitles, captions, a track turned on later): move them as they come.
  var origTick = PP._tick;
  PP._tick = function () {
    origTick.apply(this, arguments);
    if (!this.subDelay && !this._cueShifted) return;
    var now = Date.now();
    this._shiftCues(now - (this._sdAll || 0) > 5000);
    if (now - (this._sdAll || 0) > 5000) this._sdAll = now;
  };

  // Each title starts with its own offset.
  V.on('player-started', function (p) {
    var want = store.get(p.it);
    if (want === (p.subDelay || 0)) return p._shiftCues(true);
    p.setSubDelay(want, { noSave: true, quiet: !want });
  });

  // ---------------------------------------------------------------- the Subtitles menu
  V.subTimingMenu = function (p, main, pages) {
    if (!p.it || p.it.t === 'radio') return;
    var cur = round(p.subDelay || 0);
    main.push({ label: 'Subtitle timing', value: cur ? label(cur) : 'In sync', page: 'subdelay' });
    var adj = function (d) { return function () { p.nudgeSubs(d); }; };
    pages.subdelay = [
      { label: describe(cur), on: false, inert: true, fn: function () {}, back: 'subdelay' },
      { label: 'Earlier', value: '−0.1 s', fn: adj(-0.1), back: 'subdelay' },
      { label: 'Later', value: '+0.1 s', fn: adj(0.1), back: 'subdelay' },
      { label: 'Much earlier', value: '−0.5 s', fn: adj(-0.5), back: 'subdelay' },
      { label: 'Much later', value: '+0.5 s', fn: adj(0.5), back: 'subdelay' },
      { label: 'Reset', value: '0 s', fn: function () { p.setSubDelay(0); }, back: 'subdelay' },
    ];
  };
  V.ccMenuExtras = (function (prev) {
    return function (p, main, pages) { if (prev) prev(p, main, pages); V.subTimingMenu(p, main, pages); };
  })(V.ccMenuExtras);
})();
