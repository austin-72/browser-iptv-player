/* How much the player buffers, how much live TV this browser keeps for rewinding, and how far the skip buttons jump.
   Rewinding live TV uses only what this browser has already downloaded (nothing is stored on the server): hls.js and
   mpegts.js are told to keep the last few minutes instead of throwing them away, and a paused channel keeps loading so
   it carries on from where it was paused. How far back really goes is also capped by the browser (Chrome keeps about
   150 MB of video per stream). */
'use strict';
(function () {
  // Buffer ahead (per device: it depends on the connection). Normal / Large / Extra large.
  var BUF = {
    normal: { goal: 30, max: 600, size: 60, liveCount: 3, tsMax: 12, tsRemain: 3, rebuf: 2, mb: 60 },
    large: { goal: 60, max: 900, size: 120, liveCount: 5, tsMax: 25, tsRemain: 8, rebuf: 5, mb: 120 },
    xlarge: { goal: 120, max: 1200, size: 200, liveCount: 8, tsMax: 45, tsRemain: 15, rebuf: 10, mb: 240 },
  };
  var bufKind = function () { var b = V.ls.get('bufferSize', 'normal'); return BUF[b] ? b : 'normal'; };
  var buf = function () { return BUF[bufKind()]; };
  /** Minutes of live TV this browser keeps for rewinding (0 = off). Per device: it costs this device's memory. */
  var rewindSecs = function () { var m = V.ls.get('rewindMin', 15); m = +m; return m > 0 ? Math.min(60, m) * 60 : 0; };

  V.tune = {
    BUF: BUF,
    rewindSecs: rewindSecs,
    bufKind: bufKind,
    // A live window shorter than this isn't worth a seek bar.
    minWindow: 45,
    bufGoal: function () { return V.dataSaver && V.dataSaver() ? Math.min(15, buf().goal) : buf().goal; },
    mbAhead: function () { return buf().mb; },
    hls: function (c, p) {
      var b = buf();
      c.maxMaxBufferLength = b.max;
      c.maxBufferSize = b.size * 1000 * 1000;
      if (!p.vod) {
        c.liveSyncDurationCount = b.liveCount;
        var keep = rewindSecs();
        c.backBufferLength = keep ? keep : 30;
      }
    },
    mts: function (c, p) {
      var b = buf();
      if (p.vod) return;
      c.liveBufferLatencyMaxLatency = b.tsMax;
      c.liveBufferLatencyMinRemain = b.tsRemain;
      var keep = rewindSecs();
      c.autoCleanupMaxBackwardDuration = keep ? keep : 180;
      c.autoCleanupMinBackwardDuration = keep ? Math.max(30, keep - 60) : 120;
      // A larger stash smooths over a provider that sends in bursts.
      if (bufKind() !== 'normal') c.stashInitialSize = bufKind() === 'large' ? 1024 * 1024 : 2048 * 1024;
    },
    shaka: function (c, p) {
      var b = buf();
      c.streaming.rebufferingGoal = b.rebuf;
      if (!p.vod) c.streaming.bufferBehind = rewindSecs() || 30;
    },
  };

  // ---------------------------------------------------------------- paused or rewound live TV
  // hls.js: while a live channel is paused (or the viewer is watching behind live), keep downloading ahead so playing
  // carries on from the same spot. mpegts.js: don't jump back to live while the viewer is behind on purpose.
  // (mpegts.js reads its settings from this object while playing; there's no public way to change them.)
  var mtsConfig = function (m) { var e = m && (m._player_engine || m); return e && (e._config || (e._mse_controller && e._mse_controller._config)) || null; };
  V.tune && (V.tune.mtsConfig = mtsConfig);
  var applyLive = function (p) {
    if (!p || p.vod || !p.started) return;
    var behind = p._userBehind || p.video.paused;
    var keep = rewindSecs();
    if (p.hls && p.hls.config) {
      var b = buf();
      var want = behind && keep ? Math.max(b.goal, keep) : b.goal;
      if (p.hls.config.maxBufferLength !== want) {
        p.hls.config.maxBufferLength = want;
        p.hls.config.maxMaxBufferLength = Math.max(b.max, want);
        p.hls.config.maxBufferSize = (behind && keep ? Math.max(b.size, 250) : b.size) * 1000 * 1000;
      }
    }
    var mc = mtsConfig(p.mts);
    if (mc) mc.liveBufferLatencyChasing = !behind || !keep;
  };
  V.on('player-started', function (p) {
    if (p.vod) return;
    var v = p.video;
    if (v._tuneBound) return;
    v._tuneBound = true;
    v.addEventListener('pause', function () { if (V.player === p || p.video === v) { if (!p.vod && rewindSecs()) p._userBehind = true; applyLive(p); } });
    v.addEventListener('play', function () { applyLive(p); });
    v.addEventListener('seeking', function () { applyLive(p); });
  });
  V.on('player-teardown', function (p) { p._userBehind = false; });
  setInterval(function () {
    var p = V.player;
    if (p && p.el) p.el.classList.toggle('can-rewind', !!(p.started && !p.vod && p.liveWindow));
    if (!p || !p.started || p.vod) return;
    // Back at live by itself (caught up): no longer "behind on purpose".
    if (p._userBehind && !p.video.paused && p.behindLive < 8) p._userBehind = false;
    applyLive(p);
  }, 2000);

  // ---------------------------------------------------------------- skip lengths (per profile)
  var CHOICES = [5, 10, 15, 30, 60];
  V.SKIP_CHOICES = CHOICES;
  /** Seconds the back (dir 'back') or forward ('fwd') buttons, keys, double-taps and the phone remote jump. */
  V.skipLen = function (dir) {
    var n = +V.pref(dir === 'back' ? 'skipBack' : 'skipFwd');
    return CHOICES.indexOf(n) >= 0 ? n : 10;
  };
  var PATHS = {
    back: 'M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8M3 3v5h5',
    fwd: 'M21 12a9 9 0 11-9-9 9 9 0 016.4 2.6L21 8M21 3v5h-5',
  };
  /** The circular-arrow icon with the number of seconds in it. */
  V.skipIcon = function (dir, n) {
    n = n || V.skipLen(dir);
    return '<svg class="i" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="' + PATHS[dir] + '"/><text x="12" y="15.5" font-size="' + (n >= 10 ? 7.5 : 8.5) + '" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif" font-weight="700">' + n + '</text></svg>';
  };
  /** Shows this profile's skip lengths on the player's buttons. */
  V.drawSkipButtons = function (host) {
    var rw = V.$('[data-a=rw]', host), ff = V.$('[data-a=ff]', host);
    if (!rw || !ff) return;
    var b = V.skipLen('back'), f = V.skipLen('fwd');
    rw.innerHTML = V.skipIcon('back', b); rw.setAttribute('aria-label', 'Back ' + b + ' seconds');
    ff.innerHTML = V.skipIcon('fwd', f); ff.setAttribute('aria-label', 'Forward ' + f + ' seconds');
  };
  V.on('player-started', function (p) { V.drawSkipButtons(p.host); });
  V.on('prefs', function (k) { if ((k === 'skipBack' || k === 'skipFwd') && V.player) V.drawSkipButtons(V.player.host); });
})();
