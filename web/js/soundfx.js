/* Clear dialogue and night mode: two sound settings in the player's menu, remembered per profile.
   Clear dialogue lifts the speech frequencies (around 1–4 kHz) and lowers the bass and the very top a little.
   Night mode evens out the sound: loud scenes get quieter and quiet speech louder (a compressor).
   Both work on the player's own sound chain (Web Audio, shared with volume boost and audio sync in avsync.js):
     … → gain → (boost compressor) → low shelf → speech peak → high shelf ─┬→ dry ──────────────┬→ speakers
                                                                           └→ compressor → wet ─┘
   The chain is added once and then only its settings move, smoothly, so switching never clicks. With both off and
   never used, nothing extra runs. A page can only change the sound of streams it may read: not ones the browser's own
   player takes straight from another site, and not the iPhone's own HLS player — there the options say why. Browsers
   without Web Audio (old TVs) don't show them at all. */
'use strict';
(function () {
  var PP = V.Player.prototype;
  var AC = window.AudioContext || window.webkitAudioContext;
  var ua = navigator.userAgent || '';
  var apple = !!(V.device && V.device.ios) || (/Safari\//.test(ua) && /Apple/.test(navigator.vendor || '') && !/Chrome|Chromium|CriOS|Android/.test(ua));
  var supported = !!(AC && AC.prototype && AC.prototype.createBiquadFilter && AC.prototype.createDynamicsCompressor);

  // Settings (dB, Hz, seconds). Chosen by ear and checked with test tones (see test/ui/soundfx.py).
  var DIALOGUE = { low: -5, lowHz: 220, mid: 5, midHz: 2000, midQ: 0.6, high: -3, highHz: 8000, trim: 0.84 };
  var NIGHT = { threshold: -40, knee: 12, ratio: 8, attack: 0.004, release: 0.3, wet: 0.5 };
  var RAMP = 0.04; // time constant: the change is ~95% done in 0.12 s

  var sameOrigin = function (u) { u = u || ''; return u.charAt(0) === '/' || u.indexOf(location.origin + '/') === 0; };
  var hlsInPage = function () { return window.Hls ? Hls.isSupported() : !!(window.MediaSource || window.ManagedMediaSource); };

  /**
   * Can this page process the sound of this way of playing? started: it's playing now (look at what the element
   * actually plays); otherwise it's about to be tried.
   */
  V.audioReadable = function (p, a, started) {
    a = a || (p && p.attempt);
    if (!a) return true;
    if (a.via === 'direct' && (a.kind === 'native' || a.native) && !sameOrigin(a.url)) return false;
    if (apple) {
      // The iPhone's own HLS player gives a web page silence.
      if (started) { var src = (p.video && p.video.currentSrc) || ''; if (src && !/^blob:/.test(src) && (/m3u8|mpegurl/i.test(src) || a.native)) return false; }
      else if (a.native || (a.kind !== 'native' && !hlsInPage())) return false;
    }
    return true;
  };

  /** Why the options can't be used for what's playing ('' when they can). short: for the menu. */
  var why = function (p, short) {
    if (!p || !p.it) return '';
    if (!V.audioReadable(p, p.attempt, true)) {
      if (apple) return short ? 'Not with this player' : 'Not possible with this browser’s own player';
      return short ? 'Not for this stream' : 'Not for this stream: it plays straight from the provider. Reload it through the server to use it.';
    }
    return '';
  };

  var at = function (param, v, ac) {
    try { param.cancelScheduledValues(ac.currentTime); param.setTargetAtTime(v, ac.currentTime, RAMP); } catch (e) { try { param.value = v; } catch (x) {} }
  };

  /** The effects chain, neutral until switched on: input → … → dest. */
  function build(ac, dest) {
    var fx = { ac: ac };
    var bq = function (type, hz, q) { var f = ac.createBiquadFilter(); f.type = type; f.frequency.value = hz; if (q) f.Q.value = q; f.gain.value = 0; return f; };
    fx.input = ac.createGain();
    fx.low = bq('lowshelf', DIALOGUE.lowHz);
    fx.mid = bq('peaking', DIALOGUE.midHz, DIALOGUE.midQ);
    fx.high = bq('highshelf', DIALOGUE.highHz);
    fx.dry = ac.createGain();
    fx.comp = ac.createDynamicsCompressor();
    fx.comp.threshold.value = NIGHT.threshold; fx.comp.knee.value = NIGHT.knee; fx.comp.ratio.value = NIGHT.ratio;
    fx.comp.attack.value = NIGHT.attack; fx.comp.release.value = NIGHT.release;
    fx.wet = ac.createGain();
    fx.wet.gain.value = 0;
    fx.input.connect(fx.low); fx.low.connect(fx.mid); fx.mid.connect(fx.high);
    fx.high.connect(fx.dry); fx.dry.connect(dest);
    fx.high.connect(fx.comp); fx.comp.connect(fx.wet); fx.wet.connect(dest);
    return fx;
  }
  /** This player's chain (one per audio context). */
  function chain(p) {
    if (p._fx && p._fx.ac === p._ac) return p._fx;
    p._fx = build(p._ac, p._ac.destination);
    p._fxIn = p._fx.input;
    return p._fx;
  }

  /** Applies the profile's settings to this player. Returns '' or why it can't. */
  PP.applySoundFx = function () {
    var p = this;
    if (!supported) return 'none';
    var d = !!V.pref('clearDialogue'), n = !!V.pref('nightMode');
    if (!d && !n && !p._fx) return '';
    var no = why(p);
    if (no) { if (p._fx) set(p._fx, false, false); return no; }
    if (!p.it || !p.attempt) return ''; // (applied when it starts)
    try {
      p._ac = p._ac || new AC();
      var fx = chain(p);
      V.audioGraph(p); // (sends the player's sound into fx.input)
      set(fx, d, n);
    } catch (e) { console.warn('[soundfx]', e); return 'Not possible in this browser'; }
    return '';
  };
  function set(fx, d, n) {
    var ac = fx.ac;
    if (fx.state === d + '|' + n) return;
    fx.state = d + '|' + n;
    at(fx.input.gain, d ? DIALOGUE.trim : 1, ac);
    at(fx.low.gain, d ? DIALOGUE.low : 0, ac);
    at(fx.mid.gain, d ? DIALOGUE.mid : 0, ac);
    at(fx.high.gain, d ? DIALOGUE.high : 0, ac);
    // Night mode cross-fades to the compressed sound (and back), so nothing jumps.
    at(fx.dry.gain, n ? 0 : 1, ac);
    at(fx.wet.gain, n ? NIGHT.wet : 0, ac);
    if (ac.state === 'suspended' && ac.resume) ac.resume();
  }

  var NAMES = { clearDialogue: 'Clear dialogue', nightMode: 'Night mode', boost: 'Volume boost' };
  PP.setSoundFx = function (k, on) {
    var p = this;
    if (on && why(p)) return relay(p, k);
    V.setPref(k, !!on); // (the 'prefs' event below applies it)
    p.osd(NAMES[k] + (on ? ' on' : ' off'), 1200);
  };
  /**
   * A stream the page can't read: try this one through the server's relay (as audio sync does). The setting is only
   * switched on once that plays. If the relay can't play it, go back to playing it the way it was, from the same place,
   * and say the option isn't available for it.
   */
  function relay(p, k) {
    var tried = p.it && p.it.k + '|' + p.alt;
    if (apple || S.settings.routing === 'direct-only' || !p.it || !p.url || !p.attempt || p._fxRelayFor === tried) { p.osd(why(p), 4000); return; }
    p._fxRelayFor = tried;
    var it = p.it, before = p.attempt, alt = p.alt, at0 = p.vod ? p.position : 0;
    var what = it.t === 'live' || it.t === 'radio' ? 'channel' : 'title';
    p._fxPending = { k: k, it: it };
    p.osd(NAMES[k] + ' needs this stream to come through the server — switching…', 3000);
    p.load(it, { only: { via: 'relay', kind: '?', url: p.url }, quiet: true, alt: alt, startAt: at0, onFail: function (err) {
      p._fxPending = null;
      if (V.crumb) V.crumb('player', NAMES[k] + ': the relay couldn’t play it (' + (err && err.message) + '), back to ' + before.via);
      V.toast(NAMES[k] + ' isn’t available for this ' + what + ': it couldn’t be played through the server.');
      p.load(it, { only: before, quiet: true, alt: alt, startAt: p.vod ? at0 : 0 });
    } });
  }
  // The relay plays: now it's on (it stays on for everything else too, like any setting).
  V.on('player-started', function (p) {
    var w = p._fxPending;
    if (!w) return;
    p._fxPending = null;
    if (w.it === p.it && p.attempt && p.attempt.via === 'relay' && !why(p)) {
      if (w.k === 'boost') { p.setBoost(p._fxBoostX || 1.5, true); p.osd('Volume boost ' + Math.round((p._fxBoostX || 1.5) * 100) + '%', 1200); return; }
      V.setPref(w.k, true); p.osd(NAMES[w.k] + ' on', 1200);
    }
  });

  var applyNow = function () { var p = V.player; if (p && p.started) p.applySoundFx(); };
  V.on('player-started', function (p) { p.applySoundFx(); });
  V.on('prefs', function (k) { if (k === 'clearDialogue' || k === 'nightMode') applyNow(); });
  V.on('me', applyNow); // (changed on another of this profile's devices)

  /** The two items for the player's menu (after Volume boost). */
  V.soundFxMenu = function (p, main) {
    if (!supported || !p.it) return;
    var no = why(p, true);
    var at2 = 0;
    for (var i = 0; i < main.length; i++) if (main[i].page === 'boost') at2 = i + 1;
    if (!at2) at2 = main.length;
    var item = function (k, label) {
      var on = !!V.pref(k);
      return { label: label, value: no || (on ? 'On' : 'Off'), fn: function () { p.setSoundFx(k, !on); } };
    };
    main.splice(at2, 0, item('clearDialogue', 'Clear dialogue'), item('nightMode', 'Night mode'));
  };
  // (Volume boost, for a stream the page can't read: through the relay the same way — player.js setBoost.)
  V.fxRelay = function (p, k) { if (!supported || !why(p)) return false; relay(p, k); return true; };
  V.soundFx = { supported: supported, why: why, build: build, set: function (fx, d, n) { set(fx, !!d, !!n); }, DIALOGUE: DIALOGUE, NIGHT: NIGHT };

  var prevExtras = V.playerMenuExtras;
  V.playerMenuExtras = function (p, main, pages) {
    if (prevExtras) prevExtras(p, main, pages);
    V.soundFxMenu(p, main);
  };
})();
