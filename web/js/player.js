/* The video player. Picks the right engine (hls.js, mpegts.js, Shaka for DASH, or the browser itself) and falls back
   automatically: direct to the provider → through the server → server conversion (ffmpeg) → backup streams. */
'use strict';

var PROTO = /^(rtmpt?e?s?|rtsps?|udp|rtp|srt|mmsh?|mmst|rtmfp):\/\//i;
V.guessKind = function (url, it) {
  if (/^local:/.test(url)) return 'local';
  if (/^file:/i.test(url)) return 'file';
  if (PROTO.test(url)) return 'proto';
  if (it && it.dash) return 'dash';
  var p = String(url).split(/[?#]/)[0].toLowerCase();
  var ext = (p.match(/\.([a-z0-9]{2,5})$/) || [])[1] || '';
  if (ext === 'mpd') return 'dash';
  if (ext === 'm3u8' || ext === 'm3u') return 'hls';
  if (['ts', 'mts', 'm2ts'].indexOf(ext) >= 0) return 'ts';
  if (['mp4', 'm4v', 'webm', 'mov', 'ogv', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav'].indexOf(ext) >= 0) return 'native';
  if (['mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'divx', 'vob', '3gp', 'wma', 'asf', 'rm', 'rmvb', 'm2v', 'ogm'].indexOf(ext) >= 0) return 'ffmpeg';
  if (/\/hls\/|m3u8|\/playlist|manifest\(format=m3u8/.test(p)) return 'hls';
  if (/manifest\(format=mpd|\/dash\//.test(p)) return 'dash';
  return 'unknown';
};

/** Video codecs this browser can decode, so the server only converts what it must. */
V.codecs = (function () {
  var c = null;
  var f = function () {
    if (c) return c;
    c = ['h264'];
    // (A PlayStation's browser says "probably" to HEVC and AV1 and then shows no picture: H.264 only there.)
    if (/PlayStation/i.test(navigator.userAgent)) return c;
    var MS = window.ManagedMediaSource || window.MediaSource;
    var v = document.createElement('video');
    var ok = function (t) { try { return (MS && MS.isTypeSupported(t)) || v.canPlayType(t) === 'probably'; } catch (e) { return false; } };
    // (Some browsers say they play HEVC and then show no picture: once that happened here, it's converted instead —
    // for two weeks, then tried again: a browser or graphics driver update often fixes it.)
    var noHevc = +V.ls.get('noHevc', 0);
    if (!(noHevc > 1e12 && Date.now() - noHevc < 14 * 86400e3) && (ok('video/mp4; codecs="hvc1.1.6.L93.B0"') || ok('video/mp4; codecs="hev1.1.6.L93.B0"'))) c.push('hevc');
    if (ok('video/mp4; codecs="av01.0.05M.08"')) c.push('av1');
    if (ok('video/webm; codecs="vp9"')) c.push('vp9');
    return c;
  };
  f.forget = function () { c = null; };
  return f;
})();

/**
 * Does this device's own video player fetch the stream without the page's sign-in? A PlayStation's does (its media
 * player runs apart from the page and sends no cookies), and so may other TVs': this server's own stream addresses
 * (conversions, the relay, media folders) then answer it with "sign in first" — "can't play this format", or a
 * conversion that never starts. For them those addresses are signed, like a cast link (valid for a day).
 */
V.signMedia = function () { return /PlayStation/i.test(navigator.userAgent) || !!(V.device && V.device.tv); };
/** A stream address this device's player can open: signed (see signMedia) when it's one of this server's. */
V.mediaUrl = function (url) {
  if (!V.signMedia() || !/^\/api\/(session|proxy|local)\b/.test(url || '')) return Promise.resolve(url);
  return V.api('/api/cast/link', { body: { path: url, hours: 24 } }).then(function (r) { return location.origin + r.url; }, function () { return url; });
};

/** Can the browser's own player (no JavaScript reading the bytes, so no CORS needed) play this kind? */
V.nativePlays = (function () {
  var v = null, c = {};
  return function (kind) {
    if (kind in c) return c[kind];
    v = v || document.createElement('video');
    var t = { hls: ['application/vnd.apple.mpegurl', 'application/x-mpegURL', 'audio/mpegurl'], ts: ['video/mp2t'] }[kind] || [];
    c[kind] = t.some(function (x) { try { return !!v.canPlayType(x); } catch (e) { return false; } });
    return c[kind];
  };
})();
/** What this browser has for playing streams (for error reports: which player could have worked). */
V.mediaSupport = function () {
  var MS = window.ManagedMediaSource ? 'ManagedMediaSource' : window.MediaSource ? 'MediaSource' : window.WebKitMediaSource ? 'WebKitMediaSource' : 'none';
  var v = document.createElement('video');
  var cp = function (t) { try { return v.canPlayType(t) || 'no'; } catch (e) { return 'error'; } };
  var mseH264 = false;
  try { var M = window.ManagedMediaSource || window.MediaSource; mseH264 = !!(M && M.isTypeSupported('video/mp4; codecs="avc1.64001f,mp4a.40.2"')); } catch (e) {}
  return { mse: MS, mseH264: mseH264, hlsjs: !!(window.Hls && Hls.isSupported && Hls.isSupported()), nativeHls: cp('application/vnd.apple.mpegurl'), nativeTs: cp('video/mp2t'), nativeMp4: cp('video/mp4; codecs="avc1.64001f,mp4a.40.2"'), way: V.ls.get('hlsWay', '') || '' };
};
/** The optional "direct streams" browser helper (see Settings) marks the page when it's active. */
V.directHelper = function () { return document.documentElement.hasAttribute('data-iptv-direct'); };

var MODE_LABEL = {
  'direct:hls': 'Direct · HLS', 'direct:ts': 'Direct · MPEG-TS', 'direct:native': 'Direct', 'direct:dash': 'Direct · DASH',
  'relay:hls': 'Through the server · HLS', 'relay:ts': 'Through the server · MPEG-TS', 'relay:native': 'Through the server', 'relay:dash': 'Through the server · DASH',
  'split:hls': 'Direct video · playlist via the server', 'split:dash': 'Direct video · manifest via the server',
  'native:hls': 'Direct · built-in player', 'native:native': 'Direct · built-in player', 'helper': 'Direct · via the browser helper',
  'local:native': 'From the server', 'session:remux': 'Server conversion (remux)', 'session:transcode': 'Server conversion (transcode)',
  'browser:mb': 'Direct · converted in this browser',
};

V.Player = function (host) {
  this.host = host;
  this.token = 0;
  this.fit = V.ls.get('fit', 'contain');
  this.zoom = 1;
  this.adjust = V.ls.get('adjust', { b: 1, c: 1, s: 1 });
  this.boost = 1;
  this.markers = null;
  host.innerHTML =
    '<div class="vp" tabindex="-1">' +
    '<video playsinline webkit-playsinline preload="auto" x-webkit-airplay="allow"></video>' +
    '<div class="vp-art" hidden></div>' +
    '<div class="vp-msg" hidden></div>' +
    '<div class="vp-osd" aria-live="polite"></div>' +
    '<div class="vp-stats" hidden></div>' +
    '<div class="vp-react" aria-hidden="true"></div>' +
    '<div class="vp-top">' +
    '  <button class="pbtn" data-a="back" aria-label="Back">' + V.icon('back') + '</button>' +
    '  <div class="vp-titles"><div class="vp-title"></div><div class="vp-sub"></div></div>' +
    '  <span class="sp"></span>' +
    '  <button class="pbtn" data-a="party" aria-label="Watch together" title="Watch together">' + V.icon('party') + '</button>' +
    '  <button class="pbtn" data-a="cast" aria-label="Cast" title="Cast to a TV" hidden>' + V.icon('cast') + '</button>' +
    '  <button class="pbtn" data-a="mini" aria-label="Minimise" title="Keep watching while you browse">' + V.icon('mini') + '</button>' +
    '</div>' +
    '<div class="vp-live" hidden></div>' +
    '<button class="vp-skip" hidden></button>' +
    '<div class="vp-upnext" hidden></div>' +
    '<div class="vp-ctrl">' +
    '  <div class="vp-seekrow"><span class="vp-t1 num"></span><div class="vp-seek" role="slider" tabindex="0" aria-label="Seek"><div class="track"><div class="buf"></div><div class="fill"></div><div class="marks"></div></div><div class="knob"></div><div class="tip"><img alt="" hidden><span></span></div></div><button class="vp-t2 num" data-a="timeends" title="Time left, or when it ends" aria-label="Time left, or when it ends"></button></div>' +
    '  <div class="vp-row">' +
    '    <button class="pbtn big" data-a="play" aria-label="Play">' + V.icon('play') + '</button>' +
    '    <button class="pbtn" data-a="rw" aria-label="Back 10 seconds">' + V.icon('rw') + '</button>' +
    '    <button class="pbtn" data-a="ff" aria-label="Forward 30 seconds">' + V.icon('ff') + '</button>' +
    '    <span class="vol-wrap"><button class="pbtn" data-a="mute" aria-label="Mute">' + V.icon('vol') + '</button><input class="vol" type="range" min="0" max="1" step="0.05" aria-label="Volume"></span>' +
    '    <button class="live-badge" data-a="golive" hidden>Live</button>' +
    '    <span class="vp-ttl truncate"></span>' +
    '    <span class="sp"></span>' +
    '    <button class="pbtn" data-a="next" aria-label="Next episode" title="Next episode" hidden>' + V.icon('skipnext') + '</button>' +
    '    <button class="pbtn" data-a="episodes" aria-label="Episodes" title="Episodes" hidden>' + V.icon('stack') + '</button>' +
    '    <button class="pbtn" data-a="channels" aria-label="Channels" title="Channels" hidden>' + V.icon('list') + '</button>' +
    '    <button class="pbtn" data-a="audioonly" aria-label="Sound only" title="Sound only (picture off, less data)" hidden>' + V.icon('headphones') + '</button>' +
    '    <button class="pbtn" data-a="cc" aria-label="Subtitles and audio" title="Subtitles and audio">' + V.icon('cc') + '</button>' +
    '    <button class="pbtn" data-a="bookmark" aria-label="Bookmark this moment" title="Bookmark">' + V.icon('bookmark') + '</button>' +
    '    <button class="pbtn" data-a="gear" aria-label="Playback settings" title="Settings">' + V.icon('gear') + '</button>' +
    '    <button class="pbtn" data-a="hidectl" aria-label="Hide the controls" title="Hide the controls (U) · move the mouse to bring them back">' + V.icon('eyeoff') + '</button>' +
    '    <button class="pbtn" data-a="pip" aria-label="Picture in picture" title="Picture in picture">' + V.icon('pip') + '</button>' +
    '    <button class="pbtn" data-a="fs" aria-label="Full screen" title="Full screen">' + V.icon('fs') + '</button>' +
    '  </div>' +
    '</div>' +
    '<div class="vp-menu" role="menu" hidden></div>' +
    '<aside class="vp-side" hidden></aside>' +
    '<div class="vp-zap num" hidden></div>' +
    '</div>';
  this.el = V.$('.vp', host);
  this.video = V.$('video', host);
  this.video.volume = V.clamp(V.ls.get('volume', 1), 0, 1);
  this.video.muted = V.ls.get('muted', false);
  this._applyFit();
  if (!document.pictureInPictureEnabled && !(this.video.webkitSupportsPresentationMode)) V.$('[data-a=pip]', host).hidden = true;
  this._bind();
  this._bindVideo(this.video);
  this._volUi();
  this._applySubStyle();
  var me = this;
  V.on('prefs', function (k) { if (k === 'subStyle') me._applySubStyle(); });
  // Closing the tab or switching apps mid-video: keep progress, history and statistics.
  window.addEventListener('pagehide', function () { me._saveProgress(); me._accountWatched(true); me._statFlush(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden && me.started) { me._saveProgress(); me._accountWatched(true); me._statFlush(); } });
};

  // ------------------------------------------------------------ loading
  /** it: a catalogue item (or a catch-up stand-in). alts: backup streams still to try. */
var PP = V.Player.prototype;
PP.load = function (it, opts) {
  opts = opts || {};
  var self = this;
  var token = ++this.token;
  if (!opts.quiet) { this._extKeep = null; this.audioTrack = undefined; this._saveProgress(); this._accountWatched(); this._inHistory = false; this.reconnects = 0; this._watchStart = Date.now(); this._watched = 0; this._forced = !!opts.force; this._statFlush(); this._statSig = null; this._statId = null; this._fileTracks = null; this._fileSub = -1; }
  this._triedDirect = false;
  this._failedWith = null;
  this._loadAt = opts.startAt || 0; // (where this load starts: a backup stream tried after it fails starts there too)
  if (!opts.quiet) { this._downWaits = 0; this._attemptLog = []; this._everStarted = false; this._startedAlt = null; this._relayHoldSince = 0; this._clickAt = V._clickAt && Date.now() - V._clickAt < 120000 ? V._clickAt : Date.now(); V._clickAt = 0; this._startTimed = false; }
  if (V.crumb) V.crumb('player', (opts.quiet ? 'reload ' : 'play ') + it.t + ' “' + it.n + '”' + (opts.force ? ' (force ' + opts.force + ')' : '') + (opts.alt !== undefined ? ' (backup ' + opts.alt + ')' : '') + (opts.startAt ? ' at ' + Math.round(opts.startAt) + ' s' : ''));
  if (!opts.quiet) this._picRetried = this._picConverted = false;
  if (opts.alt === undefined && !opts.quiet) { this.alt = -1; this._altsLeft = S.settings && it.a ? it.a.map(function (x, i) { return i; }) : []; this._triedAlts = []; this._raced = null; this._fmt = {}; }
  // Smart failover: a copy that's slow to start (6 s) — the others are looked at meanwhile, so if it fails the next
  // one is a copy that works right now.
  clearTimeout(this._raceT); clearTimeout(this._stallT);
  if (!opts.quiet || opts.alt !== undefined) this._dropWarm(); // (another title, or another copy: a head start for the old one isn't wanted)
  if (!opts.quiet && !opts.only && it.t !== 'catchup' && S.settings && S.settings.smartFailover !== false && it.a && it.a.length) {
    var rtok = token;
    var loadAt = Date.now();
    this._raceT = setTimeout(function () {
      if (rtok !== self.token || self.started || !self._altsLeft || !self._altsLeft.length) return;
      self._race(true).then(function (r) {
        // This copy's provider isn't answering and another copy works: go there now, not after every way of playing
        // this one has timed out.
        if (rtok !== self.token || self.started) return;
        if (self._raceSaysSwitch(r)) {
          if (V.crumb) V.crumb('player', 'copy ' + (self.alt + 2) + ' isn’t answering: switching now');
          return self._failed(new Error('The provider isn’t answering for this copy.'));
        }
        // Still nothing 9 seconds after Play, and another copy's provider answered far quicker than this one's (or this
        // one's didn't answer when asked): that one, rather than sitting out this one's timeouts (12 s to a minute
        // each — the 30–60 second starts). (Not when this copy's provider answers quickly: then it's converting or
        // loading, and another copy would only start over.)
        clearTimeout(self._stallT);
        self._stallT = setTimeout(function () {
          if (rtok !== self.token || self.started) return;
          var fast = self._fasterCopy(r);
          if (!fast) return;
          if (V.crumb) V.crumb('player', 'copy ' + (self.alt + 2) + ' is slow to start: copy ' + (fast.alt + 2) + ' answered in ' + fast.ms + ' ms — switching');
          self._altsLeft = [fast.alt].concat(self._altsLeft.filter(function (x) { return x !== fast.alt; }));
          self._raceDone = true; // (the order's settled: straight to that copy)
          self._failed(new Error('This copy was slow to start.'));
        }, Math.max(0, 9000 - (Date.now() - loadAt)));
      });
    }, 2000);
  }
  // (A copy chosen — Source in the settings, a backup tried, a reload: that one. This was an "else" of the line above, so
  // with quick switching on — the default — choosing a backup in Source did nothing.)
  if (opts.alt !== undefined) this.alt = opts.alt;
  this._teardown();
  this.it = it;
  this.started = false;
  this.markers = null;
  this.sessionInfo = null;
  this.extraSubs = [];
  this.vod = it.t !== 'live' && it.t !== 'radio';
  if (it.t === 'radio' && it.d > 0) this.vod = true;
  this.el.classList.add('has-media');
  this.el.classList.toggle('is-live', !this.vod);
  this.el.classList.toggle('is-radio', it.t === 'radio');
  this._titles();
  V.$('.vp-skip', this.host).hidden = true;
  V.$('.vp-upnext', this.host).hidden = true;
  V.$('[data-a=golive]', this.host).hidden = true;
  var art = V.$('.vp-art', this.host);
  art.hidden = it.t !== 'radio';
  art.innerHTML = it.t === 'radio' ? V.art(it.i, it.n, 'art-radio') + '<div class="radio-name">' + V.esc(it.n) + '</div>' : '';
  if (V.audioOnly) V.audioOnly.onLoad(this, it, opts);
  if (!opts.quiet) { this._stT0 = this._clickAt || Date.now(); this._srcNames = {}; }
  if (opts.quiet && !this._everStarted && this._stT0) this._step(this._stepTitle || 'Starting…', 'Trying copy ' + (this.alt + 2) + (it.a ? ' of ' + (it.a.length + 1) : ''));
  else if (opts.quiet) this._msg({ spin: true, title: 'Reconnecting…' });
  else this._step('Starting “' + (it.t === 'episode' && it.et ? it.et : it.n) + '”', it.a && it.a.length ? 'Choosing the best of ' + (it.a.length + 1) + ' copies' : 'Asking the server for it');
  this._wake(true);
  // Which copy to play: one whose provider has a free connection and that this page can play directly.
  var pickSource = !opts.quiet && opts.alt === undefined && !opts.only && !opts.force && !opts.share && !it.offlineUrl && it.t !== 'catchup' && S.conn !== undefined;
  var plan, errs = [];
  // Each way of playing it in turn (direct → through the server → conversion), until one starts.
  var next = function (i) {
    if (token !== self.token) return;
    if (i >= plan.length) return giveUp();
    var a = plan[i];
    var t0 = Date.now();
    if (!self._everStarted || !opts.quiet) self._stepFor(a, i, plan.length);
    var later = a.via !== 'session' ? plan.slice(i + 1).filter(function (x) { return x.via === 'session'; })[0] : null;
    var warmT = later ? setTimeout(function () { if (token === self.token && !self.started) self._warmSession(later, opts.startAt || 0); }, 4000) : null;
    return self._attempt(a, token, opts.startAt || 0).then(function () {
      clearTimeout(warmT);
      if (token !== self.token) return;
      if (a.via !== 'session') self._dropWarm(); // (this way started: the head start isn't needed)
      if (a.via === 'browser') mbSlow(false);
      self.attempt = a;
      if (V.crumb) V.crumb('player', 'started via ' + a.via + (a.kind || a.mode ? ' (' + (a.kind || a.mode) + ')' : '') + ' in ' + (Date.now() - t0) + ' ms');
      self._afterStart();
    }, function (e) {
      clearTimeout(warmT);
      if (token !== self.token) return;
      // The server can't be reached (restarting after an update, or the connection dropped): wait for it and try this
      // same way again — the other ways and copies all go through it too, and would only fail the same way.
      if ((e.down || e.offline) && (self._downWaits = (self._downWaits || 0) + 1) <= 30) {
        if (V.crumb) V.crumb('player', 'server unreachable (' + e.message + '): waiting');
        self._teardownMedia();
        self._msg({ spin: true, title: 'Waiting for the server…', sub: 'It’s restarting or can’t be reached just now. This carries on by itself.' });
        return new Promise(function (ok) { setTimeout(ok, 3000); }).then(function () { if (token === self.token) return next(i); });
      }
      errs.push(e);
      // What each way of playing it said (for error reports).
      var log = self._attemptLog || (self._attemptLog = []);
      log.push({ via: a.via, kind: a.kind || a.mode || '', alt: self.alt, ms: Date.now() - t0, msg: e.message, detail: e.detail });
      if (log.length > 12) log.shift();
      if (V.crumb) V.crumb('player', 'attempt failed: ' + a.via + (a.kind || a.mode ? ' (' + (a.kind || a.mode) + ')' : '') + ' — ' + e.message);
      if (a.via === 'direct' || a.via === 'split') self._triedDirect = true;
      if (a.via === 'browser' && /didn’t start in time/.test(e.message)) mbSlow(true);
      console.warn('[player] attempt failed', a.via, a.kind || a.mode, e.message);
      self._teardownMedia();
      // The browser can't decode it: another route to the same bytes won't help — go straight to conversion.
      if (/decode|format|codec/i.test(e.message) && a.via !== 'session') { var rest = plan.slice(i + 1).filter(function (x) { return x.via === 'session' || (x.via === 'browser' && a.via !== 'browser'); }); plan = plan.slice(0, i + 1).concat(rest); }
      // The server said the provider allows this, but it didn't load: have it check again next time.
      if (a.via === 'direct' && !a.native && !a.helper && a.kind !== 'native' && !/decode|format|codec/i.test(e.message)) V.api('/api/play/reach', { body: { k: it.t === 'catchup' ? it.catchupOf : it.k, alt: self.alt, url: it.t === 'catchup' ? it.u : undefined, origin: location.origin, forget: true } }).catch(function () {});
      // (Smart failover: the server found this copy's provider not answering and another copy working — the other
      // ways of playing this one would only time out too.)
      if (i < plan.length - 1 && !/decode|format|codec/i.test(e.message) && self._raceSaysSwitch(self._raced)) { if (opts.onFail) { self._teardownMedia(); return opts.onFail(e); } return self._failed(e); }
      // The server doesn't have it (taken off the lists, or hidden for this profile): no other way or copy will either.
      if (e.status === 404 && /isn’t available/.test(e.message)) { self._altsLeft = []; plan = plan.slice(0, i + 1); }
      if (i < plan.length - 1) self._lastWhy = shortWhy(e);
      return next(i + 1);
    });
  };
  // The most useful failure: from the server's attempts (it can see the real problem), else the browser's.
  var giveUp = function () {
    var tagged = errs.map(function (e2, i2) { return { e: e2, via: plan[i2] ? plan[i2].via : '' }; });
    var pick = tagged.filter(function (x) { return x.via === 'relay' && !/decode|format/i.test(x.e.message); })[0] || tagged.filter(function (x) { return x.via !== 'direct' && !/decode|format/i.test(x.e.message); })[0] || tagged.filter(function (x) { return !/decode|format/i.test(x.e.message); })[0] || tagged[tagged.length - 1];
    var best = pick && pick.e;
    if (token !== self.token) return;
    // (The caller has its own way back, e.g. sound settings that tried the relay: soundfx.js.)
    if (opts.onFail) { self._teardownMedia(); return opts.onFail(best || new Error('This couldn’t be played.')); }
    self._failed(best || new Error('This couldn’t be played.'));
  };
  return (pickSource ? this._sources(it, token, opts) : Promise.resolve(true)).then(function (go) {
    if (!go || token !== self.token) return;
    return (opts.only ? Promise.resolve([opts.only]) : opts.plan ? Promise.resolve(opts.plan.slice()) : self._plan(it, opts.force).then(function (p0) { return opts.quiet || opts.alt !== undefined || token !== self.token ? p0 : self._directCopy(it, opts.force, p0); })).then(function (p) {
      // (Another title started while this one was being looked up: nothing more to do here.)
      if (token !== self.token) return;
      // A watch party sharing one connection: the party's stream through the server first (see lib/fanout.js).
      plan = opts.share && !opts.force && it.t !== 'catchup' ? [{ via: 'party', party: opts.share, kind: '?' }].concat(p) : p;
      if (!opts.only && !opts.plan && !opts.force) plan = self._mbLater(plan);
      return next(0);
    }, function (e) { if (token === self.token) self._failed(e); });
  });
};

/* This browser's own conversion didn't start in time (8 seconds gone, every time, with a provider that sends each piece
   of a file slowly): for six hours the server's conversion goes first on this device and the browser's after it, as on
   iPhones — until one of the browser's starts. Kept across pages (when the browser allows). */
var mbSlowAt = null;
var mbSlow = function (set) {
  if (set === undefined) {
    if (mbSlowAt === null) { mbSlowAt = 0; try { mbSlowAt = +window.localStorage.getItem('vp.mbSlowAt') || 0; } catch (e) {} }
    return Date.now() - mbSlowAt < 6 * 3600e3;
  }
  if (!set && !mbSlow()) return false;
  mbSlowAt = set ? Date.now() : 0;
  try { if (set) window.localStorage.setItem('vp.mbSlowAt', String(mbSlowAt)); else window.localStorage.removeItem('vp.mbSlowAt'); } catch (e) {}
  return set;
};
PP._mbLater = function (plan) {
  if (!mbSlow()) return plan;
  var first = -1, i;
  for (i = 0; i < plan.length; i++) if (plan[i].via === 'session') { first = i; break; }
  var mbs = plan.filter(function (x, j) { return x.via === 'browser' && (first < 0 || j < first); });
  if (first < 0 || !mbs.length) return plan;
  var out = [];
  plan.forEach(function (x, j) { if (mbs.indexOf(x) < 0) out.push(x); if (j === first) out = out.concat(mbs); });
  return out;
};

  /** Picks the copy to play (see /api/play/sources). Returns false when it asked the viewer something instead. */
PP._sources = function (it, token, opts) {
  var self = this;
  return (location.protocol === 'https:' && /^http:/i.test(it.u || '') && !V.relayOn() ? V.mixedOk(it.u) : Promise.resolve(false)).then(function (mok) {
    self._preReach = null;
    return V.api('/api/play/sources', { body: { k: it.k, origin: location.origin, caps: V._caps || (V._caps = V.playCaps()), mixedOk: mok || undefined, reach: { ua: navigator.userAgent } } }).then(function (r) {
      // (How this device can reach the copy that goes first came in the same answer: _planNow uses it instead of asking.)
      if (r && r.reach && r.reach.info) self._preReach = { k: it.k, alt: r.reach.alt, info: r.reach.info, mok: !!mok, token: token };
      return r;
    });
  }).then(function (r) { return self._useSources(r, it, token, opts); }, function () { return true; });
};
PP._useSources = function (r, it, token, opts) {
  if (token !== this.token) return false;
  var srcs = r.sources || [];
  if (!srcs.length) return true;
  var self = this;
  if (r.allBusy && !opts.busyOk) {
    var by = [];
    srcs.forEach(function (x) { (x.by || []).forEach(function (b) { if (!by.some(function (y) { return y.conn === b.conn; })) by.push(b); }); });
    if (by.length) {
      // Viewers on a priority profile keep their connection: a standard profile can't take it or squeeze in beside them.
      var locked = srcs.every(function (x) { return x.locked; });
      var free = by.filter(function (b) { return b.mine || !b.priority; });
      var who = locked ? by[0] : free[0] || by[0];
      var lim = srcs[0].limit;
      var where = (srcs[0].name || 'The provider') + ' allows ' + (lim === 1 ? 'one stream' : lim + ' streams') + ' at a time' + (srcs.length > 1 ? ', and every copy of this is on a busy provider.' : '.');
      if (locked) {
        var pri = by.filter(function (b) { return b.priority && !b.mine; }).map(function (b) { return b.name; }).filter(function (n, i, a) { return n && a.indexOf(n) === i; });
        this._msg({
          title: (pri.length ? pri.join(' and ') : who.name) + (pri.length > 1 ? ' have' : ' has') + ' priority',
          sub: (pri.length > 1 ? 'They’re' : (pri[0] || who.name || 'They') + ' is') + ' using the connections this needs, and a priority viewer’s stream can’t be taken over. ' + where + ' Try again when they’ve finished.',
          actions: [{ label: 'OK', primary: true, fn: function () { V.closePlayer(); } }],
        });
        return false;
      }
      this._msg({
        title: who.mine ? 'You’re already watching on ' + who.device : who.name + ' is using the connection',
        sub: (who.mine ? '“' + who.n + '” is playing there. ' : who.name + ' is watching “' + who.n + '” on ' + who.device + '. ') + where,
        actions: [
          { label: who.mine ? 'Move it here' : 'Take over', primary: true, fn: function () {
            free.forEach(function (b) { V.api('/api/devices/' + b.conn + '/command', { body: { cmd: 'takeover', k: b.k } }).catch(function () {}); });
            self._msg({ spin: true, title: 'Waiting for the connection…' });
            setTimeout(function () { if (token === self.token) self.load(it, Object.assign({}, opts, { busyOk: true })); }, 3500);
          } },
          // (Squeezing in anyway could cut off a priority viewer, so it's only offered when nobody watching has priority.)
          by.some(function (b) { return b.priority && !b.mine; }) ? null : { label: 'Try anyway', fn: function () { self.load(it, Object.assign({}, opts, { busyOk: true })); } },
          { label: 'Cancel', fn: function () { V.closePlayer(); } },
        ].filter(Boolean),
      });
      return false;
    }
  }
  // A priority viewer and no free connection: the server picked who to take it from (standard profiles, your own
  // other devices first). Their player stops and says who needed it; this one starts a moment later.
  if (srcs[0].bump && srcs[0].bump.length && !opts.busyOk) {
    var bump = srcs[0].bump;
    var names = bump.map(function (b) { return b.mine ? 'your ' + b.device : b.name; }).filter(function (n, i, a) { return a.indexOf(n) === i; });
    bump.forEach(function (b) { V.api('/api/devices/' + b.conn + '/command', { body: { cmd: 'takeover', k: b.k } }).catch(function () {}); });
    this._msg({ spin: true, title: 'Taking the connection from ' + names.join(' and ') + '…', sub: 'You have priority.' });
    return new Promise(function (res) { setTimeout(res, 3500); }).then(function () {
      if (token !== self.token) return false;
      self._msg(null);
      srcs[0].bump = [];
      return self._useSources(r, it, token, Object.assign({}, opts, { busyOk: true }));
    });
  }
  var names = this._srcNames = {};
  srcs.forEach(function (x) { if (x.name) names[x.alt] = x.name; });
  var first = srcs[0];
  this.alt = first.alt;
  this._connLimit = first.limit || 0;
  this._busyAlts = srcs.filter(function (x, i) { return x.busy || (i && x.bump && x.bump.length); }).map(function (x) { return x.alt; });
  this._altsLeft = srcs.slice(1).map(function (x) { return x.alt; });
  // (How well this device can play each copy straight from its provider — 3: only through the server.)
  var fmt = this._fmt = {};
  srcs.forEach(function (x) { if (typeof x.fmt === 'number') fmt[x.alt] = x.fmt; });
  // An http-only provider on an https page: browsers block it, so the stream would have to go through the server.
  // With a direct (http) address set up, this device can switch to it and play straight from the provider.
  if (first.mixed && !first.proxy && r.directAddress && location.protocol === 'https:' && S.settings.directSwitch !== 'off' && !opts.relayOk) {
    var pref = V.ls.get('directSwitch', '');
    if (S.settings.directSwitch === 'auto' || pref === 'yes') { V.handoff(it, opts.startAt); return false; }
    if (pref !== 'no') {
      this._msg(null);
      V.dialog({
        title: 'Play straight from the provider?',
        body: '<p>This provider only works over plain http, which browsers block on a secure (https) page — so it would have to play through the server.</p><p>This device can switch to <b>' + V.esc(r.directAddress) + '</b> instead and play it directly. You stay signed in.</p>' +
          '<label class="check"><input type="checkbox" data-remember checked><span>Remember on this device</span></label>',
        actions: [
          { label: 'Through the server', fn: function (d) { if (V.$('[data-remember]', d).checked) V.ls.set('directSwitch', 'no'); self.load(it, Object.assign({}, opts, { relayOk: true })); } },
          { label: 'Switch and play', primary: true, fn: function (d) { if (V.$('[data-remember]', d).checked) V.ls.set('directSwitch', 'yes'); V.handoff(it, opts.startAt); } },
        ],
      }).then(function (v) { if (v === null && token === self.token) V.closePlayer(); });
      return false;
    }
  }
  return true;
};

Object.defineProperty(PP, 'url', { configurable: true, get: function () {
  var it = this.it;
  if (!it) return '';
  if (this.alt >= 0 && it.a && it.a[this.alt]) return it.a[this.alt].u;
  return it.u;
} });
Object.defineProperty(PP, 'headers', { configurable: true, get: function () {
  var it = this.it;
  if (this.alt >= 0 && it.a && it.a[this.alt]) return it.a[this.alt].h || {};
  return it.h || {};
} });

  /**
   * This copy can only play through the server (its provider blocks web players, needs special headers…): if another
   * copy of the same title can play straight from its provider, use that one instead (checks up to three).
   */
PP._directCopy = function (it, force, plan) {
  var self = this;
  var direct = function (p) { return p.some(function (a) { return a.via === 'direct' || a.via === 'split' || a.via === 'browser' || a.via === 'local'; }); };
  if (force || direct(plan) || !this._altsLeft || !this._altsLeft.length || it.t === 'catchup') return Promise.resolve(plan);
  var orig = { alt: this.alt, info: this.reachInfo, mok: this._mixedOk, vod: this.vod };
  var busy = this._busyAlts || [];
  // (Not one someone here is already using, nor one the server already found this device can only play through it:
  // each look takes a second or two, which on a PlayStation — where most films can only play that way — added up.)
  var fmt = this._fmt || {};
  var cands = this._altsLeft.filter(function (x) { return busy.indexOf(x) < 0 && !(fmt[x] >= 3); }).slice(0, 3);
  var token = this.token;
  var at = function (i) {
    // (Another title started meanwhile: leave its alt, reach info and live/VOD state alone.)
    if (token !== self.token) return plan;
    if (i >= cands.length) { self.alt = orig.alt; self.reachInfo = orig.info; self._mixedOk = orig.mok; self.vod = orig.vod; return plan; }
    self.alt = cands[i];
    return self._plan(it, force).then(function (p) {
      if (!direct(p)) return at(i + 1);
      // Use this copy; the first one stays as a backup.
      self._altsLeft = [orig.alt].concat(self._altsLeft.filter(function (x) { return x !== cands[i]; }));
      return p;
    }, function () { return at(i + 1); });
  };
  return at(0);
};

  /** The ways to try, best first (a promise). */
PP._plan = function (it, force) {
  var self = this;
  return Promise.resolve().then(function () { return self._planNow(it, force); });
};
PP._planNow = function (it, force) {
  var self = this;
  if (it.offlineUrl) return [{ via: 'direct', kind: 'native', url: it.offlineUrl }];
  var url = this.url;
  if (!url) throw new Error('This has no stream address.');
  var ff = S.settings.ffmpeg;
  var sessions = ff ? [{ via: 'session', mode: 'remux' }, { via: 'session', mode: 'transcode' }] : [];
  // The sound didn't play (AC-3…): convert in this browser, else on the server.
  if (force === 'browser') return [{ via: 'browser', kind: 'mb', url: (this.reachInfo && this.reachInfo.url) || url }].concat(ff ? [{ via: 'session', mode: 'remux' }] : []);
  if (force === 'remux' || force === 'transcode') {
    if (!ff) throw new Error('The server can’t convert videos (ffmpeg isn’t installed).');
    return [{ via: 'session', mode: force }];
  }
  var routing = S.settings.routing || 'direct-first';
  var g = V.guessKind(url, it);
  var hasHeaders = Object.keys(this.headers).length > 0;
  if (it.dr && !navigator.requestMediaKeySystemAccess) throw new Error('This channel is copy-protected (DRM) and this browser can’t play protected streams.');
  if (it.dr && !window.isSecureContext) throw new Error('Copy-protected (DRM) channels need a secure (https) address for this server.');
  var q = this._quality();
  if (q && ff && it.t !== 'radio' && g !== 'hls' && g !== 'dash') sessions = [{ via: 'session', mode: 'transcode', height: q }];

  if (g === 'local') {
    var parts = url.split(':');
    return [{ via: 'local', kind: 'native', url: '/api/local/' + parts[1] + '/' + parts[2] }].concat(sessions);
  }
  if (g === 'file') return [{ via: 'local', kind: 'native', url: '/api/file/' + encodeURIComponent(it.t === 'catchup' ? it.catchupOf : it.k) + '?alt=' + this.alt }].concat(sessions);
  if (g === 'proto') {
    if (ff) return sessions;
    throw new Error('Browsers can’t play ' + url.split(':')[0].toUpperCase() + ' streams, and the server can’t convert them (ffmpeg isn’t installed).');
  }
  var mixed = location.protocol === 'https:' && /^http:/i.test(url);
  var plan = [];
  var key = it.t === 'catchup' ? it.catchupOf : it.k;
  // Ask the server how this browser can reach the provider itself (it checks what the browser would be told).
  var fallback = function () { return self._planGuess(it, url, g, hasHeaders, mixed, routing, sessions, plan); };
  if (!(routing !== 'server' && /^https?:/i.test(url))) return fallback();
  // (A later title started while asking: its reach info and live/VOD state aren't this one's to set.)
  var tok = this.token;
  // An http stream on this https page: fine when this browser has been told to allow it for the site.
  return (mixed && !V.relayOn() ? V.mixedOk(url) : Promise.resolve(false)).then(function (mok) {
  if (tok !== self.token) return [];
  if (mok) mixed = false;
  self._mixedOk = mok;
  var pre = self._preReach;
  self._preReach = null; // (once: a reload or another copy asks again)
  var known = pre && pre.token === tok && pre.k === key && pre.alt === self.alt && pre.mok === !!mok && it.t !== 'catchup' ? Promise.resolve(pre.info) : null;
  return (known || V.api('/api/play/reach', { body: { k: key, alt: self.alt, url: it.t === 'catchup' ? url : undefined, origin: location.origin, ua: navigator.userAgent, mixedOk: mok || undefined } })).then(null, function () { return null; }).then(function (info) {
    if (tok !== self.token) return [];
    if (!info) return fallback();
    // (A server from before it knew about this still says "blocked": go by what the browser said.)
    if (info.blocked === 'mixed' && mok) { self.reachInfo = info; return fallback(); }
    {
      self.reachInfo = info;
      if (info.finite) self.vod = it.t !== 'live';
      // A plain-http stream relay can't be used from an https page (the browser blocks it): through the server instead.
      if (info.relay && location.protocol === 'https:' && /^http:/i.test(info.url || '')) info.blocked = 'mixed';
      if (!info.blocked && info.kind !== 'ffmpeg') plan = self._directRoutes(info, it);
      // MKV films whose codecs this browser decodes (Chrome, Edge): try the browser's own player first.
      if (info.kind === 'ffmpeg' && !info.blocked && V.mkvPlays(info.codecs)) plan = [{ via: 'direct', kind: 'native', url: info.url || url, mkv: true }];
      // Files the provider lets this page read: this browser can convert them itself (MKV, AC-3 sound…) before the
      // server has to.
      // (For files the server doesn't ask whether the page may read them — a <video> doesn't need it — so the
      // conversion finds out itself, at once.)
      if (!info.blocked && !q && V.mbSupported() && (it.t === 'movie' || it.t === 'episode' || (info.finite && it.t !== 'live' && it.t !== 'radio')) && (info.kind === 'ffmpeg' || info.kind === 'native' || (info.kind === 'ts' && info.mse))) plan.push({ via: 'browser', kind: 'mb', url: info.url || url });
      // (iPhones and iPads: the server's conversion before this browser's own — there it often hung, and the server's
      // started in a few seconds.)
      if (V.device.ios && sessions.length && routing !== 'direct-only') { var mbs = plan.filter(function (x) { return x.via === 'browser'; }); if (mbs.length) { plan = plan.filter(function (x) { return x.via !== 'browser'; }); sessions = sessions.slice(0, 1).concat(mbs, sessions.slice(1)); } }
      if (info.kind === 'ffmpeg') return plan.concat(routing === 'direct-only' ? [] : sessions);
      if (routing === 'direct-only') {
        if (!plan.length) throw new Error(info.blocked === 'headers' ? 'This channel needs special headers that browsers can’t send. Ask the admin to allow playback through the server.' : info.blocked === 'mixed' ? 'This page is https but the stream is plain http, which browsers block. Ask the admin to allow playback through the server.' : 'The provider doesn’t let browsers play this directly. Ask the admin to allow playback through the server.');
        return plan;
      }
      // Through the stream relay: this server doesn't pass the stream along as well (when the relay can't get it,
      // neither could the server — its own reading goes through the relay too). What the browser can't play as it is
      // is converted: in this browser first (above), else on the server.
      if (!info.relay || info.blocked) plan.push({ via: 'relay', kind: info.kind === 'dash' ? 'dash' : '?', url: url });
      return info.kind === 'dash' && it.dr ? plan : plan.concat(sessions);
    }
  });
  });
};

/**
 * Does this browser let this https page load plain-http addresses from the stream's host? Browsers block it ("mixed
 * content") unless the viewer allows it for this site — Chrome/Edge: the icon left of the address → Site settings →
 * Insecure content → Allow. A tiny request to the host answers it; remembered for the visit.
 */
/** Some lists' streams go through the stream relay: then a device never contacts a provider by itself (no checks, no guesses). */
V.relayOn = function () { return !!(S.settings && S.settings.relayLists && S.settings.relayLists.length); };
V.mixedOk = (function () {
  var memo = {};
  return function (url) {
    if (location.protocol !== 'https:' || !/^http:/i.test(url || '')) return Promise.resolve(true);
    var m = /^http:\/\/([^/?#]+)/i.exec(url);
    if (!m || !window.fetch) return Promise.resolve(false);
    var host = m[1];
    if (memo[host]) return memo[host];
    memo[host] = new Promise(function (res) {
      var t = setTimeout(function () { res(false); }, 4000);
      fetch('http://' + host + '/favicon.ico', { mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
        .then(function () { clearTimeout(t); res(true); }, function () { clearTimeout(t); res(false); });
    }).then(function (ok) { (V._mixedHosts || (V._mixedHosts = {}))[host] = ok; return ok; });
    return memo[host];
  };
})();
/** Where this browser keeps the "Insecure content" switch for a site (null: it has none). */
V.mixedHowTo = function () {
  var ua = navigator.userAgent;
  if (/SamsungBrowser|Tizen|Web0S|webOS|SMART-TV|CrKey|Android|iPhone|iPad/i.test(ua)) return null;
  if (/Edg\//.test(ua)) return { browser: 'Edge', steps: ['Click the lock (or “Not secure”) icon to the left of the address.', 'Choose <b>Permissions for this site</b>.', 'Set <b>Insecure content</b> to <b>Allow</b>.', 'Reload this page.'] };
  if (/Chrome\//.test(ua)) return { browser: 'Chrome', steps: ['Click the icon to the left of the address (the sliders or lock).', 'Choose <b>Site settings</b>.', 'Set <b>Insecure content</b> to <b>Allow</b>.', 'Come back to this tab and reload it.'] };
  if (/Firefox\//.test(ua)) return { browser: 'Firefox', steps: ['Click the lock icon to the left of the address.', 'Click the arrow next to <b>Connection secure</b>.', 'Click <b>Disable protection for now</b> (Firefox asks again in a new visit).'] };
  return null;
};
/** Once per device: playing an http stream through the server because of https — tell the viewer how to go direct. */
V.mixedTip = function () {
  var how = V.mixedHowTo();
  if (!how || V.ls.get('mixedTipShown', 0)) return;
  V.ls.set('mixedTipShown', Date.now());
  V.toast('This plays through the server because the stream is http and this page is https. You can let ' + how.browser + ' play it directly.', { ms: 15000, action: { label: 'How', fn: V.mixedHelp } });
};
V.mixedHelp = function () {
  var how = V.mixedHowTo();
  V.dialog({
    title: 'Play http streams directly',
    body: '<p>Most providers send their streams over plain <b>http</b>. This site is <b>https</b>, and browsers refuse to load http video into an https page unless you allow it for this site — so those streams go through the server instead.</p>' +
      (how ? '<p>In ' + how.browser + ':</p><ol>' + how.steps.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ol><p class="dim small">This only affects this site. Nothing else on the page changes.</p>' : '<p>This browser has no setting for it. Opening the site at its plain http address (on your home network) plays these streams directly.</p>'),
    actions: [{ label: 'Close', value: true }, { label: 'Check now', primary: true, fn: function (d) {
      var it = V.player && V.player.it;
      var url = (it && (V.player.url || it.u)) || '';
      // (Not playing one: any provider address that's plain http — not this machine's, which is always allowed.)
      for (var mi = 0; mi < S.items.length && !/^http:/i.test(url); mi++) if (/^http:/i.test(S.items[mi].u || '') && !/^http:\/\/(localhost|127\.|\[::1\])/i.test(S.items[mi].u)) url = S.items[mi].u;
      if (!/^http:/i.test(url)) { V.toast('None of the streams here use plain http.'); return false; }
      return new Promise(function (res) { setTimeout(res, 50); }).then(function () {
        var m = /^http:\/\/([^/?#]+)/i.exec(url);
        return fetch('http://' + (m ? m[1] : '') + '/favicon.ico', { mode: 'no-cors', cache: 'no-store', credentials: 'omit' }).then(function () { return true; }, function () { return false; });
      }).then(function (ok) {
        V.toast(ok ? 'Allowed — http streams now play straight from the provider.' : 'Not allowed yet. Follow the steps, then reload the page.');
        if (ok) setTimeout(function () { location.reload(); }, 1200);
        return ok;
      });
    } }],
  });
};
  /** The server couldn't check (or routing is server-only): the old way — guess, try direct, then the server. */
PP._planGuess = function (it, url, g, hasHeaders, mixed, routing, sessions, plan) {
  var self = this;
  // (With the stream relay in use, the server couldn't be asked: don't go to the provider directly.)
  var direct = routing !== 'server' && !hasHeaders && !mixed && (g !== 'ffmpeg') && !V.relayOn();
  if (g === 'dash') {
    if (direct) plan.push({ via: 'direct', kind: 'dash', url: url });
    if (routing !== 'direct-only') plan.push({ via: 'relay', kind: 'dash', url: url });
    if (!it.dr && routing !== 'direct-only') plan = plan.concat(sessions);
    return plan;
  }
  // No file extension: ask the server what it is (it reads only the first bytes), then connect directly.
  var tok = this.token;
  var sniff = direct && g === 'unknown' ? V.api('/api/play/relay', { body: { k: it.t === 'catchup' ? it.catchupOf : it.k, alt: this.alt, url: it.t === 'catchup' ? url : undefined, sniff: true } }).then(function (sn) {
    if (sn.finite && tok === self.token) self.vod = it.t !== 'live'; // (not on a title started since)
    g = { hls: 'hls', ts: 'ts', native: 'native', dash: 'dash', ffmpeg: 'ffmpeg' }[sn.kind] || 'unknown';
    if (g === 'ffmpeg') direct = false;
  }, function () {}) : Promise.resolve();
  return sniff.then(function () {
  if (direct) {
    var order = { hls: ['hls'], ts: ['ts'], native: ['native'], dash: ['dash'], unknown: ['ts', 'hls', 'native'] }[g] || ['native'];
    order.forEach(function (k) { plan.push({ via: 'direct', kind: k, url: url }); });
  }
  if (routing !== 'server' && !hasHeaders && !mixed && !V.relayOn() && (g === 'ffmpeg' || g === 'native') && self.vod && !self._quality() && V.mbSupported()) plan.push({ via: 'browser', kind: 'mb', url: url });
  if (routing === 'direct-only') {
    if (!plan.length) throw new Error(hasHeaders ? 'This channel needs special headers that browsers can’t send. Ask the admin to allow playback through the server.' : mixed ? 'This page is https but the stream is plain http, which browsers block. Ask the admin to allow playback through the server.' : 'Browsers can’t play this format directly. Ask the admin to allow playback through the server.');
    return plan;
  }
  plan.push({ via: 'relay', kind: '?', url: url });
  return plan.concat(sessions);
  });
};

  /**
   * Every way this browser can get the stream straight from the provider, best first.
   * Browsers only demand the provider's permission (CORS) when JavaScript reads the video (hls.js, mpegts.js,
   * Shaka). The browser's own player doesn't need it, and neither do video segments the provider allows even when
   * its playlists don't.
   */
PP._directRoutes = function (info, it) {
  var out = [];
  var helper = V.directHelper();
  var k = info.kind, u = info.url;
  var add = function (r) { if (!out.some(function (x) { return x.via === r.via && x.kind === r.kind && x.url === r.url && !!x.native === !!r.native; })) out.push(r); };
  // 1. The provider allows web players (or this computer has the direct-streams helper installed).
  if (info.mse || (helper && k !== 'native')) add({ via: 'direct', kind: k, url: u, helper: !info.mse });
  // 2. The browser's own player: no permission needed.
  if (k === 'native') add({ via: 'direct', kind: 'native', url: u });
  if (k === 'hls' && V.nativePlays('hls')) add({ via: 'direct', kind: 'hls', native: true, url: u });
  if (k === 'ts' && V.nativePlays('ts')) add({ via: 'direct', kind: 'native', url: u });
  // 3. A raw MPEG-TS channel that the provider also serves as HLS.
  var alt = info.alt;
  if (alt) {
    if (alt.mse) add({ via: 'direct', kind: 'hls', url: alt.url });
    if (V.nativePlays('hls')) add({ via: 'direct', kind: 'hls', native: true, url: alt.url });
    if (alt.split) add({ via: 'split', kind: 'hls', url: alt.splitUrl });
  }
  // 3b. The same, worked out here: Xtream Codes panels serve every raw TS channel as HLS too (…/123.ts →
  // …/live/user/pass/123.m3u8), and browsers with their own HLS player (Safari, phones, TVs, Chrome 142+) need no
  // permission for it. A wrong guess fails in a moment.
  if (k === 'ts' && !info.mse && !alt && V.nativePlays('hls') && it.t === 'live') {
    var xm = /^(https?:\/\/[^/]+)(?:\/live)?\/([^/]+)\/([^/]+)\/(\d+)(?:\.ts)?(\?.*)?$/.exec(u || '');
    if (xm && xm[2] !== 'movie' && xm[2] !== 'series') add({ via: 'direct', kind: 'hls', native: true, url: xm[1] + '/live/' + xm[2] + '/' + xm[3] + '/' + xm[4] + '.m3u8' + (xm[5] || '') });
  }
  // 4. Playlists through the server (a few KB), all the video straight from the provider.
  if (k === 'hls' && info.split) add({ via: 'split', kind: 'hls', url: info.splitUrl });
  if (k === 'dash' && !info.mse) add({ via: 'split', kind: 'dash', url: u });
  return out;
};

PP._quality = function () {
  var q = V.pref('quality') || 'auto';
  if (V.pref('dataSaver')) return 480;
  var n = parseInt(q, 10);
  return n > 0 ? n : 0;
};

PP._attempt = function (a, token, startAt) {
  var self = this;
  // The sound goes through Web Audio (volume boost, audio sync, clear dialogue, night mode) but this way of playing
  // can't be read by the page, so it would be silent: start it on a fresh element (before listening to it).
  if (this._audioSrc && !(V.audioReadable ? V.audioReadable(this, a) : !(a.via === 'direct' && (a.kind === 'native' || a.native)))) this._replaceVideo();
  return new Promise(function (resolve, reject) {
    var v = self.video;
    var done = false, dead = false;
    // (Only its own: an old attempt finishing late mustn't unhook the one that's running now.)
    var cleanup = function () { clearTimeout(timer); v.removeEventListener('playing', ok); v.removeEventListener('error', onErr); v.removeEventListener('canplay', onCanPlay); if (self._failNow === fail) self._failNow = null; };
    var ok = function () {
      if (done) return;
      var vid = self.it && (self.it.t === 'movie' || self.it.t === 'episode' || self.it.t === 'live' || self.it.t === 'catchup');
      if (vid && a.via !== 'session' && !v.videoWidth && !(v.audioTracks && v.audioTracks.length === 0 && false)) {
        // Give the decoder a moment, then decide.
        setTimeout(function () { if (done) return; if (!v.videoWidth && self._hasVideoTrack(a)) fail(new Error('This browser couldn’t decode the video.')); else { done = true; cleanup(); resolve(); } }, 700);
        return;
      }
      done = true; cleanup(); resolve();
    };
    var fail = function (e) { if (!done) { done = dead = true; cleanup(); reject(e instanceof Error ? e : new Error(String(e))); } };
    var onErr = function () { fail(V.techErr(self._mediaErr(), self._mediaDetail())); };
    var onCanPlay = function () { if (self._blocked) ok(); };
    v.addEventListener('playing', ok);
    v.addEventListener('error', onErr);
    v.addEventListener('canplay', onCanPlay);
    // Direct attempts give up quickly so the server can take over.
    // (How long each way gets before the next is tried. Short, so a start that's stuck doesn't keep the viewer waiting:
    // the server's conversion — usually what comes next — has had a head start meanwhile, see _warmSession. The
    // conversion in this browser had 45 s: on iPhones it could hang that long before the server took over.)
    var timer = setTimeout(function () { fail(new Error('It didn’t start in time.')); }, a.via === 'session' ? 30000 : a.via === 'browser' ? 8000 : a.via === 'direct' || a.via === 'split' ? (V.signMedia() ? 12000 : 8000) : 12000); // (a TV's player is slower to get going)
    // A server conversion that's still showing nothing after 25 s: the conversion is usually fine and it's this
    // browser's player that's stuck (some TV and console browsers claim hls.js support that doesn't work). Swap to
    // the other HLS player once; whichever starts is remembered for this device.
    var swapT = a.via === 'session' ? setTimeout(function () {
      var h = self._hlsAttach;
      // (Only this attempt's own playlist: the server may still be starting the conversion after 25 s.)
      if (done || token !== self.token || !h || h.token !== token || h.a !== a || v.readyState > 0) return;
      var other = self._hlsWay === 'hlsjs' ? (V.nativePlays('hls') ? 'native' : '') : (window.Hls && Hls.isSupported() ? 'hlsjs' : '');
      if (!other) return;
      if (V.crumb) V.crumb('player', 'nothing after 25 s with ' + self._hlsWay + ': trying ' + other);
      if (self.hls) { try { self.hls.destroy(); } catch (e) {} self.hls = null; }
      v.removeAttribute('src'); try { v.load(); } catch (e) {}
      self._forceHls = other;
      try { self._attachHls(h.a, h.token, h.url, h.rel, h.bufGoal); } catch (e) { fail(e); }
      self._forceHls = null;
    }, 25000) : null;
    var cleanup0 = cleanup;
    cleanup = function () { clearTimeout(swapT); cleanup0(); };
    var ok0 = ok;
    ok = function () { if (!done && a.via === 'session' && self._hlsWay) V.ls.set('hlsWay', self._hlsWay); ok0(); };
    v.addEventListener('playing', ok);
    v.removeEventListener('playing', ok0);
    self._failNow = fail;
    // (Answers that arrive after this attempt gave up — a slow server, a timed-out start — must not start anything.)
    self._attach(a, token, startAt, function () { return dead || token !== self.token; }).catch(fail);
  });
};

  /** Does the stream have a video track at all? (radio-style audio streams don't) */
PP._hasVideoTrack = function (a) {
  if (this.hls) return (this.hls.levels || []).some(function (l) { return l.videoCodec || l.width; }) || !(this.hls.levels || []).length;
  if (this.mts) { var mi = this.mts.mediaInfo || {}; return mi.hasVideo !== false; }
  if (this.shaka) return this.shaka.getVariantTracks().some(function (t) { return t.videoCodec; });
  var v = this.video;
  if (v.videoTracks) return v.videoTracks.length > 0;
  if (typeof v.webkitVideoDecodedByteCount === 'number') return v.webkitVideoDecodedByteCount > 0 || this.it.t !== 'radio';
  return this.it.t === 'movie' || this.it.t === 'episode';
};

  /** Starts one way of playing (a promise). Asks the server first for relays and conversions. */
PP._attach = function (a, token, startAt, over) {
  var self = this;
  // (Stale: another title started, or this attempt already gave up and the next way is being tried.)
  var gone = function () { return token !== self.token || !!(over && over()); };
  this.offset = 0;
  this.sessionDuration = 0;
  this.attemptVia = a.via;
  var it = this.it;
  var src = it.t === 'catchup' ? it.u : null;
  var go = { kind: a.kind, url: a.url };
  var prep = Promise.resolve(go);
  if (a.via === 'relay') {
    prep = V.api('/api/play/relay', { body: { k: it.t === 'catchup' ? it.catchupOf : it.k, alt: this.alt, url: src || undefined, sniff: go.kind === '?', sign: V.signMedia() || undefined } }).then(function (r) {
      if (r.signed) { r.url = location.origin + r.signed; return r; }
      return V.mediaUrl(r.url).then(function (u) { r.url = u; return r; });
    }).then(function (r) {
      if (gone()) return null;
      go.url = r.url;
      if (go.kind === '?') {
        if (r.finite) self.vod = true;
        go.kind = { hls: 'hls', ts: 'ts', native: 'native', dash: 'dash' }[r.kind];
        if (!go.kind) throw new Error('This format needs converting.');
      }
      if (go.kind === 'dash') go.url = self.url;
      return go;
    });
  } else if (a.via === 'party') {
    prep = V.api('/api/party/' + a.party + '/stream', { body: { k: it.k, alt: this.alt } }).then(function (r) {
      if (gone()) return null;
      go.url = r.url; go.kind = r.kind;
      return go;
    });
  } else if (a.via === 'session') {
    // (Started early — while the way before this one was still trying: _warmSession — and that's this one: used.)
    var w = this._warmS, body = this._sessionBody(a, startAt);
    this._warmS = null;
    var asked = w && w.key === JSON.stringify(body) ? w.p : V.api('/api/play/session', { body: body });
    if (w && asked !== w.p) w.p.then(function (s0) { V.api('/api/session/' + s0.sessionId, { method: 'DELETE' }).catch(function () {}); }, function () {});
    prep = asked.then(function (s) {
      // (Too late: end it, or it keeps converting — and holding a provider connection — with nobody watching.)
      if (gone()) { V.api('/api/session/' + s.sessionId, { method: 'DELETE' }).catch(function () {}); return null; }
      self.sessionId = s.sessionId;
      if (self.audioTrack === undefined && s.audioTrack !== undefined) self.audioTrack = s.audioTrack;
      self.sessionInfo = s;
      self.offset = s.offset || 0;
      self.sessionDuration = s.duration || 0;
      if (s.duration) self.vod = true;
      go.kind = 'hls'; go.url = s.url;
      var sid = s.sessionId;
      if (a.airplay) {
        // (The Apple TV fetches it, without this browser's sign-in: an address signed for it.)
        var pinged = setInterval(function () { V.api('/api/session/' + sid + '/ping', { method: 'POST' }).catch(function () {}); }, 15000);
        clearInterval(self._pinger); self._pinger = pinged;
        return V.api('/api/cast/link', { body: { path: s.url } }).then(function (r) { go.url = location.origin + r.url; return go; });
      }
      clearInterval(self._pinger); // (never two keep-alives at once)
      self._pinger = setInterval(function () { V.api('/api/session/' + sid + '/ping', { method: 'POST' }).catch(function () {}); }, 15000);
      if (s.signed) { go.url = location.origin + s.signed; return go; }
      return V.mediaUrl(go.url).then(function (u) { go.url = u; return go; });
    });
  } else if (go.url && /^\/api\/local\//.test(go.url)) {
    prep = V.mediaUrl(go.url).then(function (u) { go.url = u; return go; });
  }
  return prep.then(function (g) { if (g && !gone()) return self._attachMedia(a, token, startAt, g.kind, g.url, gone); });
};
/** What /api/play/session is asked for this way of playing. */
PP._sessionBody = function (a, startAt) {
  var it = this.it;
  var body = { k: it.t === 'catchup' ? it.catchupOf : it.k, alt: this.alt, url: it.t === 'catchup' ? it.u : undefined, mode: a.mode, seek: this.vod ? startAt : 0, live: !this.vod, codecs: V.codecs(), height: a.height || this._quality() || 0, audio: this.audioTrack === undefined || this.audioTrack === null ? undefined : this.audioTrack, audioLang: V.pref('audioLang') || ((S.profile && S.profile.langs) || [])[0] || '' };
  if (a.audioOnly) body.audioOnly = true;
  if (V.signMedia()) body.sign = true; // (signed in the same answer: server.js)
  return body;
};
/**
 * A head start: the way being tried hasn't started after 4 seconds, and a server conversion comes next — the server
 * starts getting it ready now, so if this way fails it's (nearly) there, instead of only starting then. Only when the
 * provider allows a second connection, or the film comes from the stream relay's own copy (no second connection).
 * Not needed in the end (this way started): ended at once.
 */
PP._warmSession = function (a, startAt) {
  if (this._warmS || !S.settings.ffmpeg) return;
  var ri = this.reachInfo || {};
  var shared = ri.relay && this.vod;
  if (!shared && this._connLimit && this._connLimit < 2) return;
  var body = this._sessionBody(a, startAt);
  if (V.crumb) V.crumb('player', 'getting the server’s conversion ready meanwhile (' + a.mode + ')');
  this._warmS = { key: JSON.stringify(body), p: V.api('/api/play/session', { body: body }) };
  this._warmS.p.catch(function () {});
};
PP._dropWarm = function () {
  var w = this._warmS;
  this._warmS = null;
  if (w) w.p.then(function (s) { V.api('/api/session/' + s.sessionId, { method: 'DELETE' }).catch(function () {}); }, function () {});
};
PP._attachMedia = function (a, token, startAt, kind, url, gone) {
  var self = this, v = this.video, it = this.it;
  if (!gone) gone = function () { return token !== self.token; };
  var rel = Math.max(0, (startAt || 0) - this.offset - (it.startOffset || 0));
  var bufGoal = V.tune ? V.tune.bufGoal(this) : V.pref('dataSaver') ? 15 : 30;
  if (kind === 'hls' && a.native) {
    v.src = url;
    if (rel > 0) this._seekOnMeta(rel);
  } else if (kind === 'hls') {
    return (window.Hls ? Promise.resolve() : V.loadScript('/vendor/hls.min.js').catch(function () {})).then(function () { if (!gone()) return self._attachHls(a, token, url, rel, bufGoal); });
  } else if (kind === 'ts') {
    return (window.mpegts ? Promise.resolve() : V.loadScript('/vendor/mpegts.js')).then(function () {
      if (gone()) return;
      var r = self._attachTs(url);
      // (mpegts.js has no start position: a film resumed, or reconnected part-way, would start from the beginning.)
      if (rel > 0 && self.vod) self._seekOnMeta(rel);
      return r;
    });
  } else if (kind === 'dash') {
    return this._attachDash(url, rel, bufGoal, a.via === 'relay' ? 'all' : a.via === 'split' ? 'manifest' : '', token, gone).then(function () { if (!gone()) self._play(); });
  } else if (kind === 'mb') {
    var lim = this._connLimit || 0;
    return V.mbStart(v, url, this.vod ? (startAt || 0) : 0, {
      parallel: lim && lim <= 2 ? 1 : 2,
      audioTrack: this.audioTrack === undefined || this.audioTrack === null ? -1 : this.audioTrack,
      lang: V.pref('audioLang') || ((S.profile && S.profile.langs) || [])[0] || '',
      onError: function (e) { if (token === self.token) self._fatal(new Error('The conversion in this browser stopped (' + (e && e.message || e) + ').')); },
    }).then(function (ctl) {
      if (gone()) { ctl.stop(); return; }
      self.mb = ctl;
      if (ctl.audioTrack >= 0) self.audioTrack = ctl.audioTrack;
      self.offset = ctl.offset;
      self.sessionDuration = ctl.duration || 0;
      self._play();
    });
  } else {
    v.src = url;
    if (rel > 0) this._seekOnMeta(rel);
  }
  this._play();
};
  /**
   * Moves to `rel` once the video knows its length. Only one is waiting at a time, and a teardown drops it: an
   * attempt that never loaded mustn't move the next way of playing (e.g. a server conversion that already starts there).
   */
PP._seekOnMeta = function (rel) {
  var self = this, v = this.video;
  this._dropSeekOnMeta();
  var f = function () { self._metaSeek = null; v.currentTime = rel; };
  this._metaSeek = { v: v, f: f };
  v.addEventListener('loadedmetadata', f, { once: true });
};
PP._dropSeekOnMeta = function () {
  var m = this._metaSeek;
  if (m) { m.v.removeEventListener('loadedmetadata', m.f); this._metaSeek = null; }
};
PP._attachHls = function (a, token, url, rel, bufGoal) {
  var v = this.video;
  this._hlsAttach = { a: a, token: token, url: url, rel: rel, bufGoal: bufGoal };
  // This device's own HLS player worked before when hls.js didn't (some TV and console browsers): use it first.
  var preferNative = V.ls.get('hlsWay', '') === 'native' && V.nativePlays('hls');
  if (this._forceHls === 'native' || (preferNative && this._forceHls !== 'hlsjs')) {
    this._hlsWay = 'native';
    v.src = url;
    if (rel > 0) this._seekOnMeta(rel);
    this._play();
    return;
  }
  {
    if (window.Hls && Hls.isSupported()) {
      this._hlsWay = 'hlsjs';
      var q = this._quality();
      var hcfg = {
        enableWorker: true, maxBufferLength: bufGoal, backBufferLength: 60, startPosition: this.vod && rel > 0 ? rel : -1,
        manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 4, fragLoadingMaxRetry: 6, capLevelToPlayerSize: true,
        lowLatencyMode: false, abrEwmaDefaultEstimate: V.pref('dataSaver') ? 800000 : 3000000,
      };
      // (Buffer size and how much live TV to keep for rewinding: see tune.js.)
      if (V.tune) V.tune.hls(hcfg, this);
      var hls = new Hls(hcfg);
      this.hls = hls;
      var self = this;
      hls.on(Hls.Events.ERROR, function (_, d) { if (self.hls === hls) self._hlsError(d); }); // (not an old, replaced one)
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        if (q) { var cap = -1; hls.levels.forEach(function (l, i) { if (l.height && l.height <= q) cap = i; }); if (cap >= 0) hls.autoLevelCapping = cap; }
        self._menuRefresh();
      });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, function () { self._pickLangs(); self._menuRefresh(); });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, function () { self._pickLangs(); self._menuRefresh(); });
      hls.on(Hls.Events.LEVEL_SWITCHED, function () { self._menuRefresh(); });
      hls.loadSource(url);
      hls.attachMedia(v);
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      this._hlsWay = 'native';
      v.src = url;
      if (rel > 0) this._seekOnMeta(rel);
    } else throw new Error('This browser can’t play HLS streams.');
  }
  this._play();
};
PP._attachTs = function (url) {
  var v = this.video;
  {
    if (!(window.mpegts && mpegts.getFeatureList().mseLivePlayback)) throw new Error('This browser can’t play MPEG-TS streams.');
    var self2 = this;
    var mcfg = {
      enableWorker: true, lazyLoad: false, autoCleanupSourceBuffer: true,
      liveBufferLatencyChasing: !this.vod, liveBufferLatencyMaxLatency: 12, liveBufferLatencyMinRemain: 3,
    };
    if (V.tune) V.tune.mts(mcfg, this);
    var p = mpegts.createPlayer({ type: 'mpegts', isLive: !this.vod, url: new URL(url, location.href).href }, mcfg);
    p.on(mpegts.Events.ERROR, function (type, detail, info) { if (V.crumb) V.crumb('player', 'mpegts ' + type + '/' + detail); self2._fatal(V.techErr(self2._mtsErr(type, detail, info), { mpegts: type + '/' + detail, http: info && info.code, msg: info && info.msg })); });
    p.on(mpegts.Events.LOADING_COMPLETE, function () { if (!self2.vod && self2.started) self2._fatal(new Error('The stream ended.')); });
    p.on(mpegts.Events.MEDIA_INFO, function (mi) {
      self2._menuRefresh();
      var MS = window.ManagedMediaSource || window.MediaSource;
      var bad = [mi && mi.videoCodec ? 'video/mp4;codecs="' + mi.videoCodec + '"' : null, mi && mi.audioCodec ? 'audio/mp4;codecs="' + mi.audioCodec + '"' : null].filter(function (t) { try { return t && MS && !MS.isTypeSupported(t); } catch (e) { return false; } });
      if (bad.length) self2._fatal(new Error('This browser can’t decode this stream’s ' + (/video/.test(bad[0]) ? 'video' : 'audio') + ' format.'));
    });
    p.attachMediaElement(v);
    p.load();
    this.mts = p;
  }
  this._play();
};

PP._attachDash = function (url, rel, bufGoal, viaServer, token, gone) {
  var self = this;
  return (window.shaka ? Promise.resolve() : V.loadScript('/vendor/shaka-player.compiled.js')).then(function () {
    if (!self._shakaReady) { shaka.polyfill.installAll(); self._shakaReady = true; }
    if (!shaka.Player.isBrowserSupported()) throw new Error('This browser can’t play DASH streams.');
    var gone = self._shakaGone || Promise.resolve();
    self._shakaGone = null;
    return gone;
  }).then(function () {
    if (token !== self.token || (gone && gone())) return;
    var sp = new shaka.Player();
    self.shaka = sp;
    return Promise.resolve(sp.attach(self.video)).then(function () { return self._shakaLoad(sp, url, rel, bufGoal, viaServer, token); });
  });
};
PP._shakaLoad = function (sp, url, rel, bufGoal, viaServer, token) {
  var it = this.it;
  var cfg = { streaming: { bufferingGoal: bufGoal, rebufferingGoal: 2, retryParameters: { maxAttempts: 4, timeout: 20000 } }, manifest: { retryParameters: { maxAttempts: 2, timeout: 20000 } } };
  if (V.tune) V.tune.shaka(cfg, this);
  var q = this._quality();
  if (q) cfg.abr = { restrictions: { maxHeight: q } };
  if (it.dr) {
    if (it.dr.type === 'clearkey' && it.dr.keys) cfg.drm = { clearKeys: it.dr.keys };
    else if (it.dr.url) { var srv = {}; srv[{ widevine: 'com.widevine.alpha', playready: 'com.microsoft.playready', clearkey: 'org.w3.clearkey' }[it.dr.type] || it.dr.type] = it.dr.url; cfg.drm = { servers: srv }; }
  }
  sp.configure(cfg);
  var net = sp.getNetworkingEngine();
  var RT = shaka.net.NetworkingEngine.RequestType;
  var headers = this.headers;
  var original = new Map();
  var key = it.t === 'catchup' ? it.catchupOf : it.k;
  var alt = this.alt;
  net.registerRequestFilter(function (type, req) {
    if (type === RT.LICENSE) { if (it.dr && it.dr.headers) Object.assign(req.headers, it.dr.headers); return; }
    if (!viaServer || (viaServer === 'manifest' && type !== RT.MANIFEST)) return;
    req.uris = req.uris.map(function (u) {
      if (u.indexOf(location.origin + '/api/proxy') === 0) return u;
      var r = location.origin + '/api/dash?k=' + encodeURIComponent(key) + '&alt=' + alt + '&u=' + encodeURIComponent(u);
      original.set(r, u);
      return r;
    });
    req.headers['X-App'] = '1';
  });
  if (viaServer) {
    net.registerResponseFilter(function (type, res) {
      var k = original.has(res.uri) ? res.uri : res.originalUri;
      var o = original.get(k);
      if (o) { res.uri = o; original.delete(k); }
    });
  }
  var self = this;
  sp.addEventListener('error', function (ev) { var d = ev.detail || {}; self._fatal(V.techErr(self._shakaErr(ev.detail), { shaka: d.code, category: d.category, severity: d.severity })); });
  sp.addEventListener('trackschanged', function () { self._pickLangs(); self._menuRefresh(); });
  sp.addEventListener('variantchanged', function () { self._menuRefresh(); });
  return sp.load(url, this.vod && rel > 0 ? rel : undefined).then(function () {
    if (token !== self.token) return;
    if (sp.isLive()) self.vod = false;
  }, function (e) { throw new Error(self._shakaErr(e)); });
};

PP._shakaErr = function (e) {
  var code = e && e.code;
  var d = (e && e.data) || [];
  if (code === 1001 || code === 1002) return 'The stream server answered HTTP ' + (d[1] || '') + (d[1] === 403 ? ' (access denied)' : '') + '.';
  if (code === 1003) return 'The stream server timed out.';
  if (code >= 6000 && code < 7000) {
    if (code === 6001) return 'This channel is copy-protected (DRM) and this browser doesn’t support its protection.';
    if (code === 6007 || code === 6008) return 'The DRM licence for this channel was refused.';
    return 'This channel’s copy protection (DRM) couldn’t be set up.';
  }
  if (code >= 4000 && code < 5000) return 'The DASH manifest couldn’t be read.';
  if (code >= 3000 && code < 4000) return 'This browser can’t decode this stream’s format.';
  if (code >= 1000 && code < 2000) return 'Couldn’t load the stream.';
  return 'Playback error' + (code ? ' (' + code + ')' : '') + '.';
};

  /** Starts the video; if the browser won't autoplay with sound, starts it muted (or shows a Play button). */
PP._play = function () {
  var v = this.video, self = this;
  this._blocked = false;
  var p = v.play();
  if (!p || !p.then) return; // older browsers: play() returns nothing
  p.catch(function (e) {
    if (e.name !== 'NotAllowedError') return;
    v.muted = true;
    self._volUi();
    var p2 = v.play();
    (p2 && p2.then ? p2 : Promise.resolve()).then(function () {
      V.toast('Started muted — tap the sound button to unmute.', { action: { label: 'Unmute', fn: function () { self.toggleMute(false); } } });
    }, function () {
      self._blocked = true;
      self._msg({ title: 'Ready', actions: [{ label: 'Play', primary: true, fn: function () { self._msg(null); var p3 = v.play(); if (p3 && p3.catch) p3.catch(function () {}); } }] });
    });
  });
};

/** What an HTTP error from the stream's server means, in plain words. */
V.httpStreamMsg = function (code) {
  if (code === 404) return 'The provider says this stream doesn’t exist (404). It may have been removed.';
  if (code === 401 || code === 403) return 'The provider refused this stream (' + code + '). The account may be in use on another device, or expired.';
  if (code === 429) return 'The provider is limiting connections right now (429). Wait a moment and try again.';
  if (code === 509 || code === 458) return 'The provider says too many streams are playing on this account (' + code + ').';
  if (code >= 500) return 'The provider’s server had a problem (' + code + '). Try again in a moment.';
  return 'The stream server answered HTTP ' + code + '.';
};
/** An error with the technical details kept for error reports (errors.js): what the player library said. */
V.techErr = function (msg, detail) { var e = new Error(msg); e.detail = detail; return e; };
PP._mediaDetail = function () { var e = this.video && this.video.error; return e ? { mediaError: e.code, msg: e.message || '' } : {}; };
PP._hlsError = function (d) {
  if (V.crumb) V.crumb('player', 'hls ' + (d.fatal ? 'fatal ' : '') + d.type + '/' + d.details + (d.response && d.response.code ? ' http ' + d.response.code : ''));
  if (!d.fatal) return;
  if (d.type === Hls.ErrorTypes.NETWORK_ERROR && this.started && !this._netRetry) { this._netRetry = true; this.hls.startLoad(); return; }
  if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !this._mediaRetry) { this._mediaRetry = true; this.hls.recoverMediaError(); return; }
  var code = d.response && d.response.code >= 100 ? d.response.code : 0;
  var msg;
  if (code === 410 && this.sessionId) msg = 'The conversion session ended.';
  else if (code === 502 && this.attemptVia === 'relay') msg = 'The server couldn’t reach the stream. It may be offline.';
  else if (code) msg = V.httpStreamMsg(code);
  else if (/Incompatible|codec/i.test(d.details)) msg = 'This browser can’t decode this stream’s video or audio.';
  else if (/manifestParsingError/i.test(d.details)) msg = 'That address doesn’t point to a playable stream.';
  else if (d.type === Hls.ErrorTypes.NETWORK_ERROR) msg = this.attemptVia === 'direct' ? 'The provider doesn’t allow direct playback in a browser.' : 'Couldn’t load the stream.';
  else msg = 'Playback error (' + d.details + ').';
  this._fatal(V.techErr(msg, { hls: d.type + '/' + d.details, http: code || undefined, reason: d.reason || (d.error && d.error.message) || undefined, frag: d.frag ? d.frag.sn : undefined }));
};
PP._mtsErr = function (type, detail, info) {
  var code = info && info.code;
  if (type === 'NetworkError' && code >= 100) return V.httpStreamMsg(code);
  if (type === 'MediaError') return 'This browser can’t decode this stream’s format.';
  if (/Unsupported|Codec|FormatError/i.test(detail + (info && info.msg))) return 'This browser can’t decode this stream’s format.';
  if (type === 'NetworkError') return this.attemptVia === 'direct' ? 'The provider doesn’t allow direct playback in a browser.' : 'Couldn’t load the stream.';
  return 'Playback error (' + (detail || type) + ').';
};
PP._mediaErr = function () {
  var e = this.video.error;
  if (!e) return 'Playback error.';
  if (e.code === 3 && this.it && this.it.dr) return 'This copy-protected channel couldn’t be decrypted.';
  return { 1: 'Playback was stopped.', 2: 'A network error stopped playback.', 3: 'This browser couldn’t decode the video.', 4: 'This browser can’t play this format.' }[e.code] || 'Playback error.';
};

PP._fatal = function (err) {
  if (this._failNow) { this._failNow(err); return; }
  if (!this.it) return;
  // Through the stream relay, while the server can't be reached (restarting): the relay doesn't need it, so keep
  // reconnecting to the same relay address (good for 12 hours) instead of giving up or asking the server for another.
  // (Only when the server was reachable before and isn't now; at most 5 minutes; a retry that fails comes back here.)
  var a0 = this.attempt;
  if (a0 && a0.via === 'direct' && this.reachInfo && this.reachInfo.relay && V._rtEver && !V.rt.open() && this._relayHoldSince !== -1) {
    if (!this._relayHoldSince) this._relayHoldSince = Date.now();
    if (Date.now() - this._relayHoldSince < 5 * 60e3) {
      var it0 = this.it, tok0 = this.token, me0 = this, pos0 = this.vod ? this.position || this._lastPos || 0 : 0;
      this._msg({ spin: true, title: 'Reconnecting…' });
      setTimeout(function () { if (tok0 === me0.token) me0.load(it0, { quiet: true, only: a0, alt: me0.alt, startAt: pos0 || undefined, onFail: function (e) { me0._fatal(e); } }); }, 3000);
      return;
    }
    this._relayHoldSince = -1; // (given up holding for this title)
  }
  // (Smart failover with other copies to go to: one quick reconnect to this one, not four.)
  var smart = S.settings && S.settings.smartFailover !== false && this._altsLeft && this._altsLeft.length;
  if (!this.vod && this.reconnects < (smart ? 1 : 4)) {
    this.reconnects++;
    var it = this.it, tok = this.token, a = this.attempt;
    this._msg({ spin: true, title: 'Reconnecting…' });
    var me = this;
    setTimeout(function () { if (tok === me.token) me.load(it, { quiet: true, only: a, alt: me.alt }); }, 1500 * this.reconnects);
    return;
  }
  if (this.vod && this.started && this.reconnects < 3) {
    this.reconnects++;
    var pos = this.position, it2 = this.it, tok2 = this.token, a2 = this.attempt;
    this._msg({ spin: true, title: 'Reconnecting…' });
    var me2 = this;
    setTimeout(function () { if (tok2 === me2.token) me2.load(it2, { quiet: true, only: a2, alt: me2.alt, startAt: pos }); }, 1500 * this.reconnects);
    return;
  }
  this._failed(err);
};

  /**
   * Smart failover: which of the copies not tried yet work right now, all asked at once by the server (/api/play/race).
   * Resolves to its answer (also kept for 45 s), or null.
   */
PP._race = function (withCurrent) {
  var it = this.it, self = this;
  if (!it || !S.settings || S.settings.smartFailover === false) return Promise.resolve(null);
  if (this._raced && Date.now() - this._raced.at < 45000 && (!withCurrent || this._raced.cur === this.alt)) return Promise.resolve(this._raced);
  if (this._racing) return this._racing;
  var cur = this.alt;
  var ex = (this._triedAlts || []).concat(withCurrent ? [] : [cur]);
  this._racing = V.api('/api/play/race', { body: { k: it.k, exclude: ex, current: withCurrent ? cur : undefined } }).then(function (r) {
    self._racing = null;
    if (self.it !== it) return null;
    self._raced = { at: Date.now(), order: (r && r.order) || [], cur: withCurrent ? cur : null };
    if (V.crumb) V.crumb('player', 'copies tried at once: ' + self._raced.order.map(function (e) { return (e.alt + 2) + (e.ok ? ' ok ' + e.ms + 'ms' : e.busy ? ' busy' : e.untested ? ' ?' : ' failed') ; }).join(', '));
    return self._raced;
  }, function () { self._racing = null; return null; });
  return this._racing;
};
  /** The race found this copy failing and another one working (so trying more ways of playing this one won't help). */
PP._raceSaysSwitch = function (r) {
  if (!r || r.cur !== this.alt) return false;
  var me = r.order.filter(function (e) { return e.alt === r.cur; })[0];
  var left = this._altsLeft || [];
  return !!me && !me.ok && !me.busy && !me.untested && r.order.some(function (e) { return e.ok && left.indexOf(e.alt) >= 0; });
};
  /** A copy (still to try) whose provider answered far quicker than this one's, when this one hasn't started. */
PP._fasterCopy = function (r) {
  if (!r || r.cur !== this.alt) return null;
  var left = this._altsLeft || [], cur = this.alt;
  var me = r.order.filter(function (e) { return e.alt === cur; })[0];
  var best = r.order.filter(function (e) { return e.ok && left.indexOf(e.alt) >= 0; }).sort(function (a, b) { return a.ms - b.ms; })[0];
  if (!best) return null;
  if (me && me.ok) return me.ms > Math.max(2500, best.ms * 3) ? best : null; // (answers, but far slower)
  if (me && !me.busy && !me.untested) return best; // (didn't answer)
  // (Not looked at — its account had no room for another look: only when another copy answered quickly, and not while
  // the server is converting this one, which takes a while anyway.)
  var a = this.attempt;
  return a && a.via === 'session' ? null : best.ms < 2500 ? best : null;
};
  /** The copies still to try, in the order the race found them: working ones first (quickest first), failed ones last. */
PP._reorderAlts = function (raced) {
  if (!raced || !raced.order || !raced.order.length || !this._altsLeft) return;
  var left = this._altsLeft, pos = {};
  raced.order.forEach(function (e, i) { pos[e.alt] = { i: i, bad: !e.ok && !e.untested && !e.busy }; });
  this._altsLeft = left.slice().sort(function (x, y) {
    var a = pos[x], b = pos[y];
    var ra = a ? (a.bad ? 2 : 0) : 1, rb = b ? (b.bad ? 2 : 0) : 1;
    return ra - rb || (a ? a.i : 0) - (b ? b.i : 0);
  });
};
  /** Everything failed for this stream: try a backup stream if the channel has one. */
PP._failed = function (err) {
  // (With just one other copy there's nothing to choose between: straight to it.)
  if (this._altsLeft && this._altsLeft.length > 1 && S.settings && S.settings.smartFailover !== false && !this._raceDone) {
    // (First the others are looked at, all at once: the next copy tried is one that works right now.)
    var tk = this.token, me0 = this, e0 = err;
    this._raceDone = true;
    if ((this._triedAlts || []).indexOf(this.alt) < 0) (this._triedAlts || (this._triedAlts = [])).push(this.alt);
    this._step('Finding a copy that works', 'Checking all ' + ((this.it.a || []).length + 1) + ' copies at once');
    this._teardownMedia();
    return this._race().then(function (r) {
      if (tk !== me0.token) return;
      me0._reorderAlts(r);
      me0._failed(e0);
    });
  }
  this._raceDone = false;
  if (this._altsLeft && this._altsLeft.length) {
    this._healthFail(err, true);
    if ((this._triedAlts || []).indexOf(this.alt) < 0) (this._triedAlts || (this._triedAlts = [])).push(this.alt);
    var next = this._altsLeft.shift();
    var total = (this.it.a || []).length + 1;
    var why = /slow to start|isn’t answering/i.test(err && err.message || '') ? 'answered too slowly' : shortWhy(err);
    this._step('Switching to copy ' + (next + 2) + ' of ' + total, 'Copy ' + (this.alt + 2) + ' ' + why + ((this._srcNames && this._srcNames[next]) ? ' · next: ' + this._srcNames[next] : ''));
    var tok = this.token, it = this.it;
    var me = this;
    // (A film: the backup starts where this one was, or was meant to start — not at the beginning.)
    var at = !this.vod ? 0 : this.started ? this.position : this._loadAt || 0;
    setTimeout(function () { if (tok === me.token) me.load(it, { alt: next, quiet: true, startAt: at || undefined }); }, 400);
    return;
  }
  this._error(err);
};

PP._afterStart = function () {
  this.started = true;
  this._relayHoldSince = 0;
  // (Playing again for half a minute: the next drop gets its full set of reconnects again.)
  var tkR = this.token, meR = this;
  setTimeout(function () { if (meR.token === tkR && meR.started) meR.reconnects = 0; }, 30000);
  this._everStarted = true;
  this._startedAlt = this.alt;
  this._msg(null);
  var vod = this.vod;
  var lb = V.$('[data-a=golive]', this.host);
  lb.hidden = vod && this.it.t !== 'catchup';
  if (this.it.t === 'catchup') { lb.textContent = 'Back to live'; lb.classList.add('behind'); }
  else lb.textContent = 'Live';
  this.el.classList.toggle('is-live', !vod);
  this._menuRefresh();
  if (this.boost !== 1) this.setBoost(this.boost, true);
  V.emit('player-started', this);
  if (this.statsOn) this._statsTick();
  var sp = V.pref('speed');
  if (vod && sp && sp !== 1) this.video.playbackRate = sp;
  this._pickLangs();
  this._loadExtras();
  this._checkSound();
  this._watchPicture();
  if (this._routeReason(this._routeName(this.attempt)) === 'https' || (this.attempt && this.attempt.via === 'session' && location.protocol === 'https:' && /^http:/i.test(this.url) && !this._mixedOk)) V.mixedTip();
  if (this.onPlaying) this.onPlaying(this);
  V.rt.presence({ k: this.it.t === 'catchup' ? this.it.catchupOf : this.it.k, n: this.it.n, pos: this.vod ? this.position : 0, alt: this.alt, force: true });
  this._mediaSession();
  this._wakeLock(true);
  this._statStart();
};

  /**
   * A stream that plays but shows nothing: a black picture with the sound going (a channel whose provider is down
   * often keeps sending sound over black), no picture at all, or a picture that has stopped while the time moves on.
   * Checked every 2 s on a tiny copy of the picture; after 20 s of it (45 s for a film — dark scenes happen) the next
   * copy of the channel is tried, or, with none, this one is started again once and then the viewer is told.
   * (Not for radio, sound-only mode, or while paused, seeking or buffering.)
   */
PP._watchPicture = function () {
  var self = this, tok = this.token, v = this.video, it = this.it;
  clearInterval(this._picTimer);
  if (!it || it.t === 'radio' || (this.attempt && this.attempt.audioOnly)) return;
  var STEP = 2, c = null, g = null, readable = true;
  var black = 0, still = 0, none = 0, lastT = v.currentTime, lastFrames = null, lastPic = null;
  // The frame counter is only trusted where it has been seen counting in this playback, and not on a device where
  // it turned out not to (some older TVs report the same number while the picture plays fine). A picture the page
  // can look at that still changes isn't stopped either, whatever the counter says.
  var counted = 0, litSeen = false;
  var noStill = +V.ls.get('noStillCheck', 0);
  var stillOk = !(noStill && Date.now() - noStill < 60 * 86400e3);
  var limit = this.vod ? 45 : 20;
  try { c = document.createElement('canvas'); c.width = 32; c.height = 18; g = c.getContext('2d', { willReadFrequently: true }); } catch (e) { g = null; }
  this._picTimer = setInterval(function () {
    if (tok !== self.token || !self.started) { clearInterval(self._picTimer); return; }
    var moved = v.currentTime - lastT;
    lastT = v.currentTime;
    // (Only while it really plays: paused, seeking, buffering or in sound-only mode isn't the picture's fault.)
    // (Nor in a hidden tab: browsers stop drawing the picture there to save power.)
    if (v.paused || v.seeking || v.readyState < 3 || moved < 1 || self._aoActive || document.hidden || v.webkitCurrentPlaybackTargetIsWireless) { black = still = none = 0; lastFrames = null; return; }
    if (!v.videoWidth) none += STEP; else none = 0;
    var changed = false;
    if (v.videoWidth && g && readable) {
      try {
        g.drawImage(v, 0, 0, 32, 18);
        var d = g.getImageData(0, 0, 32, 18).data, sum = 0, lit = 0;
        for (var i = 0; i < d.length; i += 4) { var y = (d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10; sum += y; if (y > 40) lit++; }
        // Black: dark on average and hardly anything lit (a small channel logo in a corner still counts as black).
        // (Only where the page has seen the picture lit, or the counter counting: on some TVs the picture is drawn
        // where the page can't see it, and every look comes back black.)
        // (Only once the page has seen the picture lit: a PlayStation's frame counter counts while every look at its
        // picture comes back black — it's drawn where the page can't see it — and that had films "converted" for nothing.)
        if (sum / 576 < 12 && lit < 15) { if (litSeen) black += STEP; } else { black = 0; litSeen = true; }
        // (A rough picture of the picture: four rows of brightness. Moving pictures change it.)
        var pic = [0, 0, 0, 0];
        for (var j = 0; j < d.length; j += 4) pic[Math.floor(j / 4 / 32 / 4.5)] += d[j] + d[j + 1] + d[j + 2];
        changed = !!lastPic && pic.some(function (x, n) { return Math.abs(x - lastPic[n]) > 600; });
        lastPic = pic;
        if (changed) still = 0;
      } catch (e) { readable = false; } // (a picture from another site the browser won't let the page look at)
    }
    // The picture stopped: no new frames while the time goes on (works whatever the picture's origin).
    var q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    var frames = q ? q.totalVideoFrames : v.webkitDecodedFrameCount;
    if (v.videoWidth && typeof frames === 'number') {
      if (lastFrames !== null && frames > lastFrames) counted++;
      if (lastFrames !== null && frames === lastFrames && stillOk && counted >= 3 && !changed) still += STEP; else still = 0;
      lastFrames = frames;
    }
    var why = none >= 12 ? 'no picture' : black >= limit ? 'a black picture' : still >= limit ? 'a picture that has stopped' : '';
    if (why) { clearInterval(self._picTimer); self._badPicture(why); }
  }, STEP * 1000);
};

/** What to do about a picture that isn't there (see _watchPicture). */
PP._badPicture = function (why) {
  var it = this.it, tok = this.token, self = this;
  if (!it) return;
  // "Stopped" again for the same title after already switching for it (another copy, or the server's conversion,
  // whose picture certainly moves): it's this device's frame counter that's wrong, not the picture. Not checked again
  // on this device (for two months), and nothing is switched.
  if (why === 'a picture that has stopped') {
    var hits = V._stillHits || (V._stillHits = {});
    hits[it.k] = (hits[it.k] || 0) + 1;
    if (hits[it.k] > 1) { V.ls.set('noStillCheck', Date.now()); if (V.crumb) V.crumb('player', 'frame counter unreliable here: "stopped picture" check off'); this._watchPicture(); return; }
  }
  var err = new Error('The stream played with ' + why + '.');
  var a = this.attempt || {};
  var canConvert = S.settings.ffmpeg && !(a.via === 'session' && a.mode === 'transcode') && !this._picConverted;
  var at0 = this.vod ? this.position : 0;
  // No picture at all, with the sound going: almost always a picture this browser can't decode (HEVC, 10-bit…) —
  // the server's conversion fixes that for this same copy. (Tried first; a black picture tries other copies first.)
  if (why === 'no picture' && canConvert) {
    this._picConverted = true;
    // (A conversion that only repackaged the picture: this browser can't decode that picture — it's HEVC more often
    // than not. From now on this device has such pictures converted.)
    if (a.via === 'session' && a.mode === 'remux' && V.codecs().indexOf('hevc') >= 0) { V.ls.set('noHevc', Date.now()); V.codecs.forget(); }
    this._healthFail(err, true);
    this.osd('No picture from this copy — converting it on the server…', 3500);
    setTimeout(function () { if (tok === self.token) self.load(it, { force: 'transcode', quiet: true, alt: self.alt, startAt: at0 || undefined }); }, 400);
    return;
  }
  if (this._altsLeft && this._altsLeft.length) { this._picConverted = this._picRetried = false; this.osd('This copy shows ' + why + ' — trying another', 3500); this._failed(err); return; }
  if (canConvert) {
    this._picConverted = true;
    this._healthFail(err, true);
    this.osd('This copy shows ' + why + ' — converting it on the server…', 3500);
    setTimeout(function () { if (tok === self.token) self.load(it, { force: 'transcode', quiet: true, alt: self.alt, startAt: at0 || undefined }); }, 400);
    return;
  }
  this._healthFail(err, false);
  if (!this._picRetried) {
    // (Once: a decoder that got stuck, or a provider that hiccupped, often comes back on a fresh start.)
    this._picRetried = true;
    this.osd('The stream shows ' + why + ' — starting it again…', 3000);
    var at = this.vod ? this.position : 0, a = this.attempt;
    setTimeout(function () { if (tok === self.token) self.load(it, { quiet: true, only: a, alt: self.alt, startAt: at || undefined }); }, 800);
    return;
  }
  V.toast('“' + it.n + '” shows ' + why + ' and has no other copy to switch to. Its provider may be having trouble.', { error: true, ms: 9000 });
};

/**
 * AirPlay sends the address of what's playing and the Apple TV fetches it itself — but streams this page feeds to the
 * video itself (hls.js, mpegts.js, a conversion in the browser) have no such address, so only the sound went across.
 * When the video goes to an AirPlay device that way, it's started again from an address the TV can fetch: the
 * stream's own HLS or MP4 address (through the stream relay when it's on), else a conversion on the server, signed
 * so the TV needs no sign-in.
 */
PP._feedsItself = function () { var v = this.video; return !!(this.hls || this.mts || this.shaka || this.mb || v.srcObject || /^blob:/.test(v.currentSrc || '')); };
PP._airplayPlan = function () {
  var a = this.attempt || {}, info = this.reachInfo || {}, plan = [];
  var abs = function (u) { return /^https?:\/\//i.test(u || ''); };
  var plain = !this.headers || !Object.keys(this.headers).length;
  if (a.via === 'direct' && plain && abs(a.url)) {
    if (a.kind === 'hls') plan.push({ via: 'direct', kind: 'hls', url: a.url, native: true, airplay: true });
    else if (a.kind === 'native' && !a.mkv) plan.push({ via: 'direct', kind: 'native', url: a.url, airplay: true });
    else if (a.kind === 'ts' && info.alt && abs(info.alt.url)) plan.push({ via: 'direct', kind: 'hls', url: info.alt.url, native: true, airplay: true });
  }
  // (The TV plays H.264 and HEVC; the server repackages the stream as HLS for it, converting only what it must.)
  if (S.settings.ffmpeg) plan.push({ via: 'session', mode: a.via === 'session' && a.mode === 'transcode' ? 'transcode' : 'remux', native: true, airplay: true });
  return plan;
};
/**
 * The AirPlay button: playing in a way the TV can fetch first (on an iPhone or iPad the page's own player even turns
 * AirPlay off for the video while it feeds it), then the device list. (The list needs a tap to open: when the stream had
 * to be started again, a button says when it's ready.)
 */
PP.airplay = function () {
  var v = this.video, self = this, it = this.it;
  if (!v.webkitShowPlaybackTargetPicker) return;
  if (!it || !this._feedsItself()) { try { v.disableRemotePlayback = false; } catch (e) {} v.webkitShowPlaybackTargetPicker(); return; }
  var plan = this._airplayPlan();
  if (!plan.length) { V.toast('Only the sound can go to AirPlay for this stream: the server can’t convert it (ffmpeg isn’t installed).', { error: true, ms: 8000 }); v.webkitShowPlaybackTargetPicker(); return; }
  var at = this.vod ? this.position : 0;
  this._apBusy = this.token;
  this._apPick = true;
  this.load(it, { quiet: true, plan: plan, alt: this.alt, startAt: at || undefined });
};
PP._apReady = function () {
  if (!this._apPick || this._feedsItself()) return;
  this._apPick = false;
  var v = this.video, self = this;
  this._msg({ title: 'Ready for AirPlay', sub: 'The picture can go to your TV now.', actions: [
    { label: 'Choose the AirPlay device', primary: true, fn: function () { self._msg(null); try { v.disableRemotePlayback = false; } catch (e) {} v.webkitShowPlaybackTargetPicker(); } },
    { label: 'Not now', fn: function () { self._msg(null); } },
  ] });
};
PP._toAirplay = function () {
  var it = this.it, self = this, tok = this.token;
  if (!it || this._apBusy === tok || !this._feedsItself()) return;
  var plan = this._airplayPlan();
  if (!plan.length) { V.toast('Only the sound can go to AirPlay for this stream: the server can’t convert it (ffmpeg isn’t installed).', { error: true, ms: 8000 }); return; }
  this._apBusy = tok;
  var at = this.vod ? this.position : 0;
  this.osd('Sending the picture to AirPlay…', 3000);
  setTimeout(function () { if (tok === self.token) self.load(it, { quiet: true, plan: plan, alt: self.alt, startAt: at || undefined }); }, 200);
};

  /**
   * Playing straight from the provider with the browser's own player: when the picture plays but no sound is decoded
   * (AC-3/DTS audio in an MKV or MP4), switch to the server's conversion at the same spot.
   */
PP._checkSound = function () {
  var a = this.attempt, v = this.video, tok = this.token, self = this;
  if (!a || a.via !== 'direct' || a.kind !== 'native' || !this.vod || v.webkitAudioDecodedByteCount === undefined || v.webkitCurrentPlaybackTargetIsWireless) return;
  if (!S.settings.ffmpeg && !(this.reachInfo && this.reachInfo.mse && V.mbSupported())) return;
  var t0 = v.currentTime;
  setTimeout(function () {
    if (tok !== self.token || v.paused || v.muted || v.currentTime - t0 < 1.5) return;
    if (v.webkitAudioDecodedByteCount === 0 && !(v.audioTracks && v.audioTracks.length === 0)) {
      if (a.mkv) V.ls.set('mkvSoundFail', (V.ls.get('mkvSoundFail', 0) || 0) + 1);
      var here = self.reachInfo && self.reachInfo.mse && V.mbSupported();
      self.osd(here ? 'No sound from this file — converting it in this browser…' : 'No sound from this file — converting on the server…', 2500);
      self.load(self.it, { force: here ? 'browser' : 'remux', startAt: self.position, quiet: true, alt: self.alt });
    }
  }, 4000);
};

  // ------------------------------------------------------------ statistics (Admin → Statistics)
  /** Which way the stream reached us, in the words the statistics use. */
PP._routeName = function (a) {
  if (!a) return '';
  if (a.via === 'direct') return a.helper ? 'helper' : (a.native || a.kind === 'native') ? 'native' : 'direct';
  if (a.via === 'browser') return S.settings && (S.settings.features || []).indexOf('browserRoute') >= 0 ? 'browser' : 'direct';
  return { split: 'split', relay: 'relay', party: 'relay', session: 'convert', local: 'local' }[a.via] || '';
};
  /** Why a stream went through the server. */
PP._routeReason = function (route) {
  if (route === 'local') return 'library';
  // (Converting because the picture didn't show the direct way; because a direct way was tried and didn't start; or
  // because this browser can't play the format at all.)
  if (route === 'convert') return this._forced || this._quality() ? 'chosen' : this._picConverted ? 'picture' : this._triedDirect ? 'direct-failed' : 'format';
  if (route !== 'relay') return '';
  var info = this.reachInfo;
  if ((S.settings.routing || '') === 'server') return 'setting';
  if (info && info.blocked === 'headers') return 'headers';
  if (info && info.blocked === 'mixed') return 'https';
  if (this._triedDirect) return 'direct-failed';
  return info ? 'blocked' : 'unknown';
};
PP._statStart = function () {
  var it = this.it, a = this.attempt;
  if (!it || !a || it.offlineUrl) return;
  var route = this._routeName(a);
  if (!route) return;
  var k = it.t === 'catchup' ? it.catchupOf : it.k;
  var sig = k + '|' + this.alt + '|' + route;
  if (this._statSig === sig && this._statId) return; // a reconnect, not a new play
  this._statFlush();
  this._statSig = sig; this._statId = null; this._statSec = 0;
  var self = this;
  // Time to start: from pressing Play to this first picture (once per title — not a reconnect or a switch later on).
  var ms = !this._startTimed && this._clickAt ? Date.now() - this._clickAt : 0;
  this._startTimed = true;
  V.api('/api/stats/play', { body: { k: k, alt: this.alt, route: route, reason: this._routeReason(route), host: location.host, cu: it.t === 'catchup' ? 1 : undefined, ms: ms || undefined } }).then(function (r) { if (self._statSig === sig) self._statId = r.id; }).catch(function () {});
  // Over 15 seconds: an error report ("Slow to start") with what each step took, to see where the time went.
  if (ms > 15000 && V.reportError) {
    V.reportError('slow', { message: 'Slow to start (' + (MODE_LABEL[a.via + ':' + (a.kind === '?' ? 'native' : a.kind || a.mode)] || route) + ')' }, {
      seconds: Math.round(ms / 1000), alt: this.alt, attempts: (this._attemptLog || []).slice(), raced: this._raced ? this._raced.order : undefined,
      item: { k: it.k, t: it.t, n: it.n, backups: (it.a || []).length }, caps: V._caps || undefined, media: V.mediaSupport ? V.mediaSupport() : undefined,
    });
  }
};
PP._statTick = function () {
  if (!this._statSig || !this.started || this.video.paused) return;
  this._statSec = (this._statSec || 0) + 1;
  if (this._statSec >= 60) this._statFlush();
};
PP._statFlush = function () {
  if (this._statId && this._statSec > 0) V.api('/api/stats/watch', { body: { id: this._statId, sec: this._statSec }, keepalive: true }).catch(function () {});
  this._statSec = 0;
};

PP._error = function (err) {
  this.started = false; // (nothing plays now: Play means try again, and the pause the teardown causes saves nothing)
  this._teardownMedia();
  this._healthFail(err, false);
  var me = this;
  var acts = [{ label: 'Try again', primary: true, fn: function () { me.load(me.it, { startAt: me.vod ? me._lastPos || 0 : 0 }); } }];
  // (Converting doesn't help when the server can't reach the stream at all.)
  if (S.settings.ffmpeg && !(this.attempt && this.attempt.via === 'session') && !/couldn.t reach|provider/i.test(err.message || '')) acts.push({ label: 'Convert on the server', fn: function () { me.load(me.it, { force: 'transcode', startAt: me._lastPos || 0 }); } });
  // A channel that's down: one press to the next one.
  if (this.it && (this.it.t === 'live' || this.it.t === 'radio') && V.zap) acts.push({ label: 'Next channel', fn: function () { V.zap(1); } });
  // Tell the admin about it, in the viewer's own words (problem.js).
  this._failedWith = err;
  if (V.reportProblem && this.it) acts.push({ label: 'Report a problem', fn: function () { V.reportProblem(me, { failed: true }); } });
  var sub = err.message;
  // (Nothing is playing now: the play button says so, and the channel card doesn't sit on top of the message.)
  var pb = V.$('[data-a=play]', this.host);
  if (pb) { pb.innerHTML = V.icon('play'); pb.setAttribute('aria-label', 'Play'); }
  this.el.classList.add('paused');
  var lc = V.$('.vp-live', this.host);
  if (lc) lc.hidden = true;
  this._msg({ title: 'Can’t play this right now', sub: sub, actions: acts });
  // Every way of playing it failed: report it, with what each way said.
  if (V.reportError && this.it) {
    var it2 = this.it;
    V.reportError('playback', { message: err.message }, { // (no stack: what each way said is what matters)
      item: { k: it2.k, t: it2.t, n: it2.n, g: it2.g, backups: (it2.a || []).length, offline: !!it2.offlineUrl, drm: !!it2.dr, ext: (String(it2.u || '').split('?')[0].match(/\.(\w{2,5})$/) || [])[1] || '' },
      final: err.detail, attempts: (this._attemptLog || []).slice(), reconnects: this.reconnects, started: !!this._everStarted,
      caps: V._caps || undefined, media: V.mediaSupport(), hlsWay: this._hlsWay || undefined, reach: this.reachInfo ? Object.keys(this.reachInfo).filter(function (x) { return !/^(url|u|input|src)$/.test(x); }).reduce(function (o, x) { o[x] = this.reachInfo[x]; return o; }.bind(this), {}) : undefined,
    });
  }
  V.announce('Playback failed: ' + sub);
};

/** A copy that wouldn't play (statistics and channel health): which one, and what the player said. */
PP._healthFail = function (err, backup) {
  var it = this.it, d = err && err.detail;
  if (!it || it.offlineUrl) return;
  V.api('/api/stats/play', { body: { k: it.t === 'catchup' ? it.catchupOf : it.k, alt: this.alt, failed: true, backup: backup || undefined, msg: String((err && err.message) || '').slice(0, 200), code: d && d.http ? d.http : undefined, started: this._startedAlt === this.alt || undefined, cu: it.t === 'catchup' ? 1 : undefined } }).catch(function () {});
};

/* Starting to play, step by step: what's happening now (which provider, which way, which copy), how long it's been,
   and — when it's slow — what's being done about it, so a slow start doesn't look like it's stuck. */
var shortWhy = function (e) {
  var m = String((e && e.message) || '');
  if (/didn’t start in time|timed out/i.test(m)) return 'it didn’t answer in time';
  if (/decode|format|codec/i.test(m)) return 'this device can’t play its format';
  if (/busy|connection/i.test(m)) return 'the provider’s connections are busy';
  return 'that didn’t work';
};
PP._stepFor = function (a, i, n) {
  var name = (this._srcNames && this._srcNames[this.alt]) || 'the provider';
  var it = this.it || {};
  var copies = it.a && it.a.length ? 'Copy ' + (this.alt + 2) + ' of ' + (it.a.length + 1) + ' · ' : '';
  var way = n > 1 ? ' (way ' + (i + 1) + ' of ' + n + ')' : '';
  var title, detail;
  if (a.via === 'session') { title = a.mode === 'transcode' ? 'Converting the video for this device' : 'The server is getting the stream ready'; detail = (a.mode === 'transcode' ? 'The server converts it as it plays' : 'Repackaging it so this device can play it') + ', from ' + name; }
  else if (a.via === 'relay') { title = 'Connecting through the server'; detail = 'From ' + name; }
  else if (a.via === 'browser') { title = 'Converting the sound in this browser'; detail = 'From ' + name; }
  else if (a.via === 'local') { title = 'Opening the file'; detail = 'On the server'; }
  else if (a.via === 'party') { title = 'Joining the watch party'; detail = 'Through the server'; }
  else { title = 'Connecting to ' + name; detail = 'Playing it straight from the provider'; }
  if (i > 0 && this._lastWhy) detail = 'The last way: ' + this._lastWhy + ' · ' + detail;
  this._step(title, copies + detail + way);
};
PP._step = function (title, detail) {
  var self = this;
  this._stepTitle = title; this._stepDetail = detail || '';
  this._msg({ spin: true, title: title, sub: this._stepSub(), hint: this._stepHint() });
  V.$('.vp-msg', this.host).setAttribute('data-step', '');
  if (!this._stepT) this._stepT = setInterval(function () {
    var b = V.$('.vp-msg', self.host);
    if (!b || b.hidden || !b.hasAttribute('data-step') || self.started) { clearInterval(self._stepT); self._stepT = null; return; }
    var sEl = V.$('.s', b), hEl = V.$('.h', b), h = self._stepHint();
    if (sEl) sEl.textContent = self._stepSub();
    if (hEl) { hEl.textContent = h; hEl.hidden = !h; }
  }, 1000);
};
PP._stepSub = function () {
  var secs = Math.round((Date.now() - (this._stT0 || Date.now())) / 1000);
  return [this._stepDetail, secs >= 2 ? secs + ' s' : ''].filter(Boolean).join(' · ');
};
PP._stepHint = function () {
  var secs = (Date.now() - (this._stT0 || Date.now())) / 1000;
  if (this._racing && !this.started) return 'Taking a moment: checking the other copies at the same time…';
  if (this._warmS && !this.started) return 'Taking a moment: the server is getting its own version ready at the same time, in case this way doesn’t start.';
  if (secs < 10) return '';
  // (The provider answered quickly when asked: it's this way of playing it that's slow, not the provider.)
  var me = this._raced && this._raced.order ? this._raced.order.filter(function (e) { return e.alt === this.alt; }, this)[0] : null;
  if (me && me.ok && me.ms < 2500) return 'The provider is answering quickly; this way of playing it is what’s slow. The next way is tried shortly.';
  var more = this._altsLeft && this._altsLeft.length;
  if (more) return 'Slow to answer. If another copy answers faster, it switches to it by itself.';
  if (secs > 25) return 'This provider is very slow right now. It keeps trying, then moves on to another way of playing it.';
  return 'Some providers take a while to start a stream. It keeps trying.';
};
/**
 * It's buffering — and whose fault is it? A viewer can't tell the provider's server from their own Wi-Fi from the app,
 * and ends up restarting things that were fine. When it has waited 5 seconds, or keeps stopping (the third time in
 * three minutes), the player finds out — is this device online, how quickly does the server here answer — and says
 * which it is, with the way out when there is one (another copy). Jumping about in the video doesn't count.
 */
PP._stalled = function () {
  var self = this, v = this.video, tk = this.token, now = Date.now();
  clearTimeout(this._whyT);
  if (v.seeking || (this._seekAt && now - this._seekAt < 8000) || !this.it) return;
  if (this._stallsFor !== tk) { this._stallsFor = tk; this._stalls = []; this._whyAt = 0; }
  this._stalls = this._stalls.filter(function (t) { return now - t < 180e3; });
  this._stalls.push(now);
  var often = this._stalls.length >= 3;
  this._whyT = setTimeout(function () {
    if (tk !== self.token || !self._stallAt || v.paused || v.seeking) return;
    self._why().then(function (w) {
      if (tk !== self.token || !self._stallAt || v.paused) return;
      self._whyAt = Date.now();
      if (V.crumb) V.crumb('player', 'buffering: ' + w.who + (often ? ' (keeps stopping)' : ''));
      var acts = [];
      if (w.who !== 'device' && self._altsLeft && self._altsLeft.length && self.it.t !== 'catchup') acts.push({ label: 'Try another copy', primary: true, fn: function () { self._failed(new Error('This copy kept stopping.')); } });
      self._msg({ spin: true, title: often ? 'It keeps stopping' : 'Waiting for more of the video', sub: w.text, actions: acts });
    });
  }, often ? 1500 : 5000);
};
/** Where the hold-up is: { who: 'device' | 'provider' | 'source', text }. */
PP._why = function () {
  var a = this.attempt || {}, viaServer = a.via === 'session' || a.via === 'relay' || a.via === 'party';
  if (navigator.onLine === false) return Promise.resolve({ who: 'device', text: 'This device is offline. It carries on by itself when the connection is back.' });
  var t0 = Date.now(), done = false;
  return new Promise(function (resolve) {
    var end = function (ok) {
      if (done) return;
      done = true;
      var ms = Date.now() - t0;
      if (!ok || ms > 2500) return resolve({ who: 'device', text: 'The connection between this device and the server is ' + (ok ? 'slow' : 'not getting through') + ' right now — the Wi‑Fi or internet here, not the channel.' });
      resolve(viaServer
        ? { who: 'source', text: 'Your connection is fine (the server answered in ' + ms + ' ms). The provider is sending this slowly, or the server is busy converting it.' }
        : { who: 'provider', text: 'Your connection is fine (the server answered in ' + ms + ' ms). The provider is sending this slowly — nothing on this device needs restarting.' });
    };
    setTimeout(function () { end(false); }, 4000);
    try { fetch('/api/ping?t=' + t0, { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { end(r.ok); }, function () { end(false); }); } catch (e) { end(false); }
  });
};

PP._msg = function (m) {
  var box = V.$('.vp-msg', this.host);
  box.removeAttribute('data-step');
  if (!m) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<div>' + (m.spin ? '<div class="spinner" role="progressbar" aria-label="Loading"></div>' : '') + (m.title ? '<div class="t">' + V.esc(m.title) + '</div>' : '') + (m.sub ? '<div class="s">' + V.esc(m.sub) + '</div>' : '') + (m.hint !== undefined ? '<div class="s h"' + (m.hint ? '' : ' hidden') + '>' + V.esc(m.hint) + '</div>' : '') + '<div class="acts"></div></div>';
  (m.actions || []).forEach(function (a) {
    var b = document.createElement('button');
    b.className = 'btn' + (a.primary ? ' primary' : '');
    b.textContent = a.label;
    b.onclick = function (e) { e.stopPropagation(); a.fn(); };
    V.$('.acts', box).appendChild(b);
  });
  var f = V.$('.acts .btn', box);
  if (f && document.activeElement && this.el.contains(document.activeElement)) f.focus();
};

PP._teardownMedia = function () {
  V.emit('player-teardown', this);
  if (this.hls) { try { this.hls.destroy(); } catch (e) {} this.hls = null; }
  this._hlsAttach = null;
  // Each step on its own: one throwing (pausing a stream that never loaded) mustn't leave the rest undone and the
  // provider connection open.
  if (this.mts) {
    var m = this.mts; this.mts = null;
    ['pause', 'unload', 'detachMediaElement', 'destroy'].forEach(function (f) { try { m[f](); } catch (e) {} });
  }
  if (this.shaka) { var sp = this.shaka; this.shaka = null; try { this._shakaGone = sp.destroy().catch(function () {}); } catch (e) { this._shakaGone = null; } }
  clearInterval(this._pinger);
  clearInterval(this._picTimer);
  this._dropSeekOnMeta();
  if (this.sessionId) { V.api('/api/session/' + this.sessionId, { method: 'DELETE', keepalive: true }).catch(function () {}); this.sessionId = null; }
  if (this.mb) { this.mb.stop(); this.mb = null; }
  var v = this.video;
  try { v.pause(); } catch (e) {}
  V.$$('track', v).forEach(function (t) { t.remove(); });
  try { if (v.srcObject) v.srcObject = null; } catch (e) {} // (a stream fed in another way: it would win over src)
  v.removeAttribute('src');
  try { v.load(); } catch (e) {}
  // (hls.js and mpegts.js turn AirPlay off on the element while they feed it on an iPhone or iPad; the next way of
  // playing may be one the TV can fetch.)
  try { if (v.disableRemotePlayback) v.disableRemotePlayback = false; } catch (e) {}
  this._netRetry = this._mediaRetry = false;
};

PP._teardown = function () {
  // An attempt still starting (a new title, or closing): end it now. Left alone, its timer and listeners stay on the
  // video and later fail or unhook the next title's attempt. (Its token is already old, so nothing else follows.)
  if (this._failNow) this._failNow(new Error('Stopped.'));
  this._statFlush();
  this._saveProgress();
  this._accountWatched();
  this._teardownMedia();
  this.attempt = null;
  this._closeMenu();
};

PP.stop = function () {
  this.token++;
  this._teardown();
  this.it = null;
  this.started = false;
  this.el.classList.remove('has-media');
  this._msg(null);
  this.osd('');
  this._wakeLock(false);
  V.$('.vp-art', this.host).hidden = true;
  V.$('.vp-side', this.host).hidden = true;
};

  // ------------------------------------------------------------ position
Object.defineProperty(PP, 'base', { configurable: true, get: function () { return (this.sessionId || this.mb ? this.offset : 0) + ((this.it && this.it.startOffset) || 0); } });
Object.defineProperty(PP, 'position', { configurable: true, get: function () { return this.base + (this.video.currentTime || 0); } });
Object.defineProperty(PP, 'duration', { configurable: true, get: function () {
  if (this.it && this.it.t === 'catchup') return this.it.d;
  if (this.sessionDuration) return this.sessionDuration;
  var d = this.video.duration;
  if (isFinite(d) && d > 0) return d + this.base;
  return this.it && this.it.d ? this.it.d : 0;
} });
Object.defineProperty(PP, 'liveWindow', { configurable: true, get: function () {
  var s = this.video.seekable;
  if (!s.length) return null;
  var start = s.start(0), end = s.end(s.length - 1);
  // A raw MPEG-TS channel can only go back as far as this browser still holds it (the seekable range starts at 0).
  var b = this.video.buffered;
  if (this.mts && b.length) start = Math.max(start, b.start(0));
  // HLS: back to what the provider still lists, or what this browser still holds, whichever goes further.
  else if (this.hls && b.length) {
    var lv = this.hls.levels && this.hls.levels[this.hls.currentLevel >= 0 ? this.hls.currentLevel : 0];
    var fr = lv && lv.details && lv.details.fragments;
    start = Math.max(start, Math.min(fr && fr.length ? fr[0].start : start, b.start(0)));
  }
  return end - start >= (V.tune ? V.tune.minWindow : 60) ? { start: start, end: end } : null;
} });

PP.seek = function (t, fromRemote) {
  this._seekAt = Date.now(); // (waiting after a jump isn't "it keeps stopping": _stalled)
  if (!this.started) return;
  var v = this.video;
  if (!this.vod) { var w = this.liveWindow; if (w) { v.currentTime = V.clamp(t, w.start, w.end - 2); this._userBehind = w.end - v.currentTime > 15; } return; }
  var tot = this.duration;
  t = Math.max(0, tot ? Math.min(t, tot - 1) : t);
  var rel = t - this.base;
  var s = v.seekable;
  var end = s.length ? s.end(s.length - 1) : 0;
  if (this.it.t === 'catchup') {
    if (rel >= 0 && rel <= end - 2) v.currentTime = rel;
    else if (this.onCatchupSeek) this.onCatchupSeek(this.it, t);
  } else if (this.mb) {
    // Converting in this browser: within what's ready, just move; elsewhere, start converting from there.
    var b = v.buffered, inside = false;
    for (var bi = 0; bi < b.length; bi++) if (rel >= b.start(bi) && rel <= b.end(bi) - 1) inside = true;
    if (inside) v.currentTime = rel;
    else this.load(this.it, { startAt: t, only: this.attempt, quiet: true, alt: this.alt });
  } else if (!this.sessionId) v.currentTime = t;
  else if (rel >= 0 && rel <= end - 2) v.currentTime = rel;
  else this.load(this.it, { startAt: t, only: this.attempt, quiet: true, alt: this.alt });
  if (!fromRemote && this.onUserAction) this.onUserAction('seek');
};
PP.skip = function (d) {
  if (!this.vod && this.liveWindow) { if (d < 0) this._userBehind = true; this.seek(this.video.currentTime + d); }
  else this.seek(this.position + d);
  this.osd((d > 0 ? '+' : '−') + Math.abs(d) + ' s', 900, 'skipfx');
};
PP.goLive = function () {
  if (this.it && this.it.t === 'catchup') { if (this.onBackToLive) this.onBackToLive(this.it); return; }
  this._userBehind = false;
  var v = this.video;
  if (this.hls && this.hls.liveSyncPosition) v.currentTime = this.hls.liveSyncPosition;
  else if (this.shaka && this.shaka.isLive()) this.shaka.goToLive();
  else if (v.seekable.length) v.currentTime = v.seekable.end(v.seekable.length - 1) - 2;
  v.play().catch(function () {});
};
Object.defineProperty(PP, 'behindLive', { configurable: true, get: function () {
  if (this.vod) return 0;
  var v = this.video;
  var edge = this.hls && this.hls.liveSyncPosition ? this.hls.liveSyncPosition : (v.seekable.length ? v.seekable.end(v.seekable.length - 1) : 0);
  return Math.max(0, edge - v.currentTime);
} });

PP._saveProgress = function (final) {
  if (!this.it || !this.vod || !this.started || this.it.t === 'catchup' || this.it.t === 'radio' && !this.it.d) return;
  var pos = final ? this.duration : this.position;
  var dur = this.duration;
  this._lastPos = pos;
  if (!final && pos < 10) return;
  V.saveProgress(this.it, pos, dur, final);
};
  /**
   * Adds the time actually watched to history: the first time after 10 s (so it shows up right away), then about
   * once a minute while watching, and whatever's left when you stop.
   */
PP._accountWatched = function (leaving) {
  if (!this.it || !this._watchStart) return;
  var secs = Math.round(this._watched || 0);
  if (secs < (this._inHistory ? 1 : 10)) return;
  V.played(this.it, secs, leaving);
  this._inHistory = true;
  this._watched = 0;
};

  // ------------------------------------------------------------ controls
PP.togglePlay = function () {
  // (After "Can't play this right now": Play means try again.)
  if (!this.started && this._failedWith && this.it && !V.$('.vp-msg', this.host).hidden) { this.load(this.it, { startAt: this.vod ? this._lastPos || 0 : 0 }); return; }
  if (!this.started) return;
  var v = this.video;
  if (v.paused) v.play().catch(function () {}); else v.pause();
  if (this.onUserAction) this.onUserAction(v.paused ? 'pause' : 'play');
};
PP.toggleMute = function (force) {
  var v = this.video;
  v.muted = force === undefined ? !v.muted : force;
  if (!v.muted && v.volume === 0) v.volume = 0.5;
  this._volUi();
  this.osd(v.muted ? 'Muted' : 'Volume ' + Math.round(v.volume * 100) + '%', 900);
};
PP.setVolume = function (x) { var v = this.video; v.volume = V.clamp(x, 0, 1); v.muted = v.volume === 0; this._volUi(); };
PP.toggleFullscreen = function () {
  var d = document;
  if (d.fullscreenElement || d.webkitFullscreenElement) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); return; }
  var el = this.el;
  if (el.requestFullscreen) el.requestFullscreen().then(function () { try { if (screen.orientation && screen.orientation.lock && V.device.touch) screen.orientation.lock('landscape').catch(function () {}); } catch (e) {} }).catch(function () {});
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  else if (this.video.webkitEnterFullscreen) {
    // iPhone: only the video itself goes full screen, and only once it has loaded enough to know its size.
    var me = this;
    if (this.video.readyState < 1) { this.osd('Full screen works once the video has started', 1800); return; }
    try { this.video.webkitEnterFullscreen(); } catch (e) { me.osd('Full screen isn’t available right now', 1800); }
  }
};
PP.togglePip = function () {
  var v = this.video;
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(function () {});
  else if (v.requestPictureInPicture) {
    var me = this;
    v.requestPictureInPicture().catch(function (e) {
      // Safari on iPhone says no for some streams (those played through Media Source, like server conversions):
      // its own way sometimes still works; when it doesn't, say so plainly (it isn't a fault in the app).
      if (v.webkitSetPresentationMode && v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode('picture-in-picture')) {
        try { v.webkitSetPresentationMode('picture-in-picture'); return; } catch (x) {}
      }
      me.osd(e && e.name === 'NotSupportedError' ? 'Picture-in-picture isn’t available for this stream on this device' : 'Picture-in-picture didn’t start', 2500);
    });
  }
  else if (v.webkitSetPresentationMode) { try { v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture'); } catch (e) { this.osd('Picture-in-picture isn’t available for this stream on this device', 2500); } }
};
PP.setRate = function (r) { this.video.playbackRate = r; V.setPref('speed', r); this.osd('Speed ' + (r === 1 ? 'normal' : r + '×'), 1000); if (this.onUserAction) this.onUserAction('rate'); };
PP.step = function (dir) { var v = this.video; if (!this.vod) return; v.pause(); v.currentTime = Math.max(0, v.currentTime + dir / 25); };

/** Can this browser process sound at all (Web Audio)? */
V.canBoost = function () { return !!(window.AudioContext || window.webkitAudioContext); };
  /** Louder than 100% through Web Audio (only for streams the browser may process). */
PP.setBoost = function (x, quietly) {
  // (No Web Audio in this browser — PlayStation, some TVs: no way to make it louder here, whichever way it plays.)
  if (x !== 1 && !V.canBoost()) { if (!quietly) V.toast('Volume boost isn’t available on this device.', { error: true }); return; }
  var a = this.attempt;
  var safe = !a || (V.audioReadable ? V.audioReadable(this, a, true) : a.via !== 'direct' || a.kind !== 'native');
  // (A stream the page can't read: played through the server's relay, then boosted — as Clear dialogue does: soundfx.js.)
  if (x !== 1 && !safe && !quietly && V.fxRelay) { this._fxBoostX = x; if (V.fxRelay(this, 'boost')) return; }
  if (x !== 1 && !safe) { if (!quietly) V.toast('Volume boost isn’t possible for this stream. Reload it through the server to use it.', { error: true }); return; }
  this.boost = x;
  if (x === 1 && !this._audioSrc) return;
  try {
    if (V.audioGraph) V.audioGraph(this);
    else if (!this._audioSrc) {
      this._ac = this._ac || new (window.AudioContext || window.webkitAudioContext)();
      this._audioSrc = this._ac.createMediaElementSource(this.video);
      this._gain = this._ac.createGain();
      this._comp = this._ac.createDynamicsCompressor();
      this._audioSrc.connect(this._gain).connect(this._comp).connect(this._ac.destination);
    }
    if (this._ac.state === 'suspended') this._ac.resume();
    this._gain.gain.value = x;
    if (!quietly) this.osd(x === 1 ? 'Volume boost off' : 'Volume boost ' + Math.round(x * 100) + '%', 1200);
  } catch (e) { V.fail(e); }
};

PP.setFit = function (f) { this.fit = f; V.ls.set('fit', f); this._applyFit(); };
PP.setZoom = function (z) { this.zoom = z; this._applyFit(); };
PP.setAdjust = function (k, val) { this.adjust = Object.assign({}, this.adjust); this.adjust[k] = val; V.ls.set('adjust', this.adjust); this._applyFit(); };
PP._filter = function () { var a = this.adjust, p = []; if (a.b !== 1) p.push('brightness(' + a.b + ')'); if (a.c !== 1) p.push('contrast(' + a.c + ')'); if (a.s !== 1) p.push('saturate(' + a.s + ')'); return p.join(' '); };
PP._applyFit = function () { this.video.style.objectFit = this.fit; this.video.style.transform = this.zoom !== 1 ? 'scale(' + this.zoom + ')' : ''; this.video.style.filter = this._filter(); };

PP._applySubStyle = function () {
  var st = V.pref('subStyle') || { size: 100, color: '#ffffff', bg: 'rgba(0,0,0,0.6)', edge: 'shadow', font: 'sans', pos: 0 };
  var el = V.$('#cue-style') || document.head.appendChild(Object.assign(document.createElement('style'), { id: 'cue-style' }));
  var edge = { shadow: '0 2px 4px rgba(0,0,0,.9)', outline: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 4px #000', raised: '1px 1px 0 #000, 2px 2px 0 #000', none: 'none' }[st.edge] || 'none';
  var font = { sans: 'system-ui, sans-serif', serif: 'Georgia, serif', mono: 'ui-monospace, monospace', casual: '"Comic Sans MS", "Comic Neue", cursive', large: 'system-ui, sans-serif' }[st.font] || 'system-ui, sans-serif';
  // Size: from the height of the picture on screen — 4.5% of it at 100% (a TV's or a film's usual size), so it's the
  // same size against the picture in a small window, full screen, on a phone held upright or on a TV. (It was "3.2em":
  // over three times the page's text size, which each browser took differently, and nothing to do with the picture.)
  var px = this._cuePx(st.size || 100);
  this._cueAt = px;
  el.textContent = '.vp video::cue { font-size: ' + px + 'px; color: ' + st.color + '; background: ' + st.bg + '; text-shadow: ' + edge + '; font-family: ' + font + '; line-height: 1.25; }' +
    // (Closed captions — laid out on a 32-column grid — a little smaller: captions.js.)
    '.vp.cc-on video::cue { font-size: ' + Math.round(px * 0.7) + 'px; }' +
    '.vp { --cue-scale: ' + (st.size || 100) / 100 + '; --cue-px: ' + px + 'px; }';
  this._watchCueSize();
};
/** The subtitle size in pixels for this size setting (100 = normal), from the picture's height on screen. */
PP._cuePx = function (size) {
  var v = this.video, h = (v && v.clientHeight) || 0;
  // (The picture itself, inside the box: a wide film in a tall box — a phone held upright — has bars above and below.)
  if (v && v.videoWidth && v.videoHeight && v.clientWidth && (!this.fit || this.fit === 'contain')) h = Math.min(h, v.clientWidth * v.videoHeight / v.videoWidth);
  if (!h) h = window.innerHeight || 720;
  var px = h * 0.045 * size / 100;
  return Math.round(Math.max(13 * size / 100, Math.min(80 * size / 100, px)));
};
/** The size follows the picture: a window resized, full screen, a phone turned, a new video's shape. */
PP._watchCueSize = function () {
  var self = this, v = this.video;
  if (!v || v._cueWatch) return;
  v._cueWatch = true;
  var again = function () {
    var st = V.pref('subStyle') || {};
    var px = self._cuePx(st.size || 100);
    if (Math.abs(px - (self._cueAt || 0)) >= 2) self._applySubStyle();
    self._placeCues();
  };
  if (window.ResizeObserver) { try { new ResizeObserver(again).observe(v); } catch (e) {} }
  window.addEventListener('resize', again);
  v.addEventListener('loadedmetadata', again);
  // Where the lines go: just above the bottom of the picture — not the bottom of the video's box, which on a phone
  // held upright (a wide picture in a tall box) is far below it, in the black.
  var hook = function (t) { if (t && !t._placed) { t._placed = true; t.addEventListener('cuechange', function () { self._placeCues(t); }); } };
  for (var i = 0; i < v.textTracks.length; i++) hook(v.textTracks[i]);
  if (v.textTracks.addEventListener) v.textTracks.addEventListener('addtrack', function (e) { hook(e.track); });
};
/** Puts the lines showing now just above the bottom of the picture (lines a subtitle file places itself, and closed
    captions, keep their own places). */
PP._placeCues = function (only) {
  var v = this.video;
  if (!v || !v.clientHeight) return;
  var H = v.clientHeight, W = v.clientWidth, h = H;
  if (v.videoWidth && v.videoHeight && (!this.fit || this.fit === 'contain')) h = Math.min(H, W * v.videoHeight / v.videoWidth);
  var bottom = (H + h) / 2 - h * 0.05; // (5% of the picture up from its bottom edge)
  var line = Math.max(10, Math.min(100, Math.round(bottom / H * 1000) / 10));
  var tracks = only ? [only] : Array.prototype.slice.call(v.textTracks);
  tracks.forEach(function (t) {
    if (t.mode !== 'showing' || t.kind === 'captions' || !t.activeCues) return;
    for (var j = 0; j < t.activeCues.length; j++) {
      var c = t.activeCues[j];
      if (c._own === undefined) c._own = c.line !== 'auto' && c.line !== undefined && !c._placedAt;
      if (c._own || c._placedAt === line || !('snapToLines' in c)) continue;
      try { c.snapToLines = false; c.lineAlign = 'end'; c.line = line; c._placedAt = line; } catch (e) {}
    }
  });
};

PP.screenshot = function () {
  var v = this.video;
  if (!v.videoWidth) return V.toast('Nothing to capture yet', { error: true });
  var c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  try {
    var ctx = c.getContext('2d');
    ctx.filter = this._filter() || 'none';
    ctx.drawImage(v, 0, 0);
    var name = ((this.it ? this.it.n : 'screenshot').replace(/[\\/:*?"<>|]+/g, ' ').trim()) + ' ' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-') + '.png';
    c.toBlob(function (b) { if (!b) return V.toast('Screenshots aren’t possible for this stream', { error: true }); V.download(name, b); }, 'image/png');
  } catch (e) {
    // A stream played straight from the provider: the browser won't let the page copy its picture, but the server can
    // take the same moment from the same copy (films and episodes).
    var it = this.it;
    if (!(S.settings.ffmpeg && this.vod && it && (it.t === 'movie' || it.t === 'episode'))) return V.toast('This stream doesn’t allow screenshots.', { error: true });
    var at = this.position, nm = ((it.n || 'screenshot').replace(/[\\/:*?"<>|]+/g, ' ').trim()) + ' ' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-') + '.png';
    V.toast('Taking the screenshot…', { ms: 2500 });
    fetch('/api/frame/' + encodeURIComponent(it.k) + '?shot=1&t=' + at.toFixed(1) + '&alt=' + this.alt, { credentials: 'same-origin', headers: { 'X-App': '1' } })
      .then(function (r) { if (!r.ok) throw new Error(r.status === 409 ? 'one' : 'no'); return r.blob(); })
      .then(function (b) { V.download(nm, b); }, function (er) { V.toast(er.message === 'one' ? 'Screenshots of this stream need a second connection, and the provider allows only one.' : 'Couldn’t take a screenshot of this stream.', { error: true }); });
  }
};

PP.osd = function (html, ms, cls) {
  var o = V.$('.vp-osd', this.host);
  clearTimeout(this._osdT);
  if (!html) { o.classList.remove('show'); return; }
  o.className = 'vp-osd show ' + (cls || '');
  o.innerHTML = V.esc(html);
  if (ms !== 0) this._osdT = setTimeout(function () { o.classList.remove('show'); }, ms || 2000);
};

  // ------------------------------------------------------------ tracks
Object.defineProperty(PP, 'levels', { configurable: true, get: function () {
  if (this.hls) return this.hls.levels || [];
  if (this.shaka) return this.shaka.getVariantTracks().filter(function (t, i, all) { return all.findIndex(function (x) { return x.height === t.height && x.bandwidth === t.bandwidth; }) === i; });
  return [];
} });
PP._levelLabel = function (l) { if (!l) return ''; var h = l.height ? l.height + 'p' : (l.name || 'Stream'); var br = l.bitrate || l.bandwidth; return h + (br ? ' · ' + V.fmtBits(br) : ''); };

  /**
   * Subtitles on? 'always', 'off', or 'foreign': only when what you hear isn't one of your languages.
   * (Older setting: "turn subtitles on automatically".)
   */
PP._subsWanted = function (audioLang) {
  var mode = V.pref('subsMode') || (V.pref('subsDefault') ? 'always' : 'off');
  if (mode === 'always') return true;
  if (mode !== 'foreign') return false;
  var mine = ((S.profile && S.profile.langs) || S.settings.defaultLangs || []).concat([V.pref('audioLang') || '']).filter(Boolean).map(function (x) { return String(x).slice(0, 2).toLowerCase(); });
  var heard = String(audioLang || (this.it && this.it.lg && this.it.lg[0]) || '').slice(0, 2).toLowerCase();
  return !!heard && heard !== 'mu' && heard !== 'un' && mine.indexOf(heard) < 0;
};
  /** Picks audio/subtitle tracks matching the profile's preferred languages. */
PP._pickLangs = function () {
  var al = (V.pref('audioLang') || '').toLowerCase(), sl = (V.pref('subLang') || '').toLowerCase();
  var heard = '';
  if (this.hls && this.hls.audioTracks && this.hls.audioTracks.length && al) { var at = this.hls.audioTracks.filter(function (t) { return (t.lang || '').toLowerCase().indexOf(al.slice(0, 2)) === 0; })[0]; heard = at ? at.lang : ''; }
  if (this.hls && !heard && this.hls.audioTracks && this.hls.audioTracks[this.hls.audioTrack]) heard = this.hls.audioTracks[this.hls.audioTrack].lang || '';
  var on = this._subsWanted(heard);
  if (!sl) sl = ((S.profile && S.profile.langs) || S.settings.defaultLangs || ['en'])[0] || '';
  // Native video with several audio tracks (Safari, some TVs).
  var vt = this.video.audioTracks;
  if (al && vt && vt.length > 1) { for (var q = 0; q < vt.length; q++) { var lang = (vt[q].language || '').toLowerCase(); if (lang && lang.indexOf(al.slice(0, 2)) === 0) { for (var z = 0; z < vt.length; z++) vt[z].enabled = z === q; break; } } }
  var m = function (lang) { lang = String(lang || '').toLowerCase(); return function (x) { return x && (lang === x || lang.indexOf(x) === 0 || (V.langName(x) || '').toLowerCase() === lang); }; };
  if (this.hls) {
    if (al && this.hls.audioTracks.length > 1) { var ai = this.hls.audioTracks.findIndex(function (t) { return m(t.lang || t.name)(al); }); if (ai >= 0 && ai !== this.hls.audioTrack) this.hls.audioTrack = ai; }
    if (on && sl && this.hls.subtitleTracks.length && this.hls.subtitleTrack < 0) { var si = this.hls.subtitleTracks.findIndex(function (t) { return m(t.lang || t.name)(sl); }); if (si >= 0) { this.hls.subtitleTrack = si; this.hls.subtitleDisplay = true; } }
  }
  if (this.shaka) {
    try { if (al) this.shaka.selectAudioLanguage(al); if (on && sl) { this.shaka.selectTextLanguage(sl); this.shaka.setTextTrackVisibility(true); } } catch (e) {}
  }
};

  /** For videos: subtitle/audio tracks inside the file (read by the server) and skip-intro markers. */
PP._loadExtras = function () {
  var it = this.it;
  if (!it || !this.vod || it.t === 'catchup' || it.t === 'radio') return;
  var tok = this.token;
  if (this.sessionInfo) this._fileTracks = { audio: this.sessionInfo.audio || [], subs: this.sessionInfo.subs || [] };
  else if (S.settings.ffmpeg && !this.hls && !this.shaka && !this.mts) {
    var me = this;
    // (Converting in this browser: it already knows the sound tracks; the server only looks for subtitles.)
    if (this.mb) this._fileTracks = { audio: this.mb.audioTracks || [], subs: [] };
    V.api('/api/probe/' + encodeURIComponent(it.k) + '?alt=' + this.alt).then(function (p) { if (tok === me.token) { me._fileTracks = { audio: me.mb ? me.mb.audioTracks || [] : p.audio || [], subs: (p.subs || []).filter(function (s) { return s.text || (s.pic && V.picdec); }) }; me._menuRefresh(); me._resumeSubs(); } }).catch(function () {});
  } else if (this.mb) this._fileTracks = { audio: this.mb.audioTracks || [], subs: [] };
  // (Subtitles fetched online that were on: on again — a reload takes every subtitle off the video, and a conversion
  // that started somewhere else needs their times moved by the new amount.)
  var keep = this._extKeep;
  if (keep && keep.k === it.k && V.addExtSub) V.addExtSub(this, keep.url, keep.label, keep.lang, true);
  else if (this.sessionInfo) this._resumeSubs();
  if (it.t === 'episode' || it.t === 'movie') {
    var me2 = this;
    V.api('/api/markers/' + encodeURIComponent(it.k)).then(function (m) { if (tok === me2.token) { me2.markers = m; me2._drawMarks(); } }).catch(function () {});
  }
};
  /** After a reload (reconnecting, or the conversion restarting elsewhere): the track that was on, else the usual choice. */
PP._resumeSubs = function () {
  var on = this._fileSub;
  if (on >= 0 && this._fileTracks && this._fileTracks.subs.some(function (x) { return x.i === on; })) this.fileSub(on);
  else this._autoSubs();
};
PP._autoSubs = function () {
  var sl = (V.pref('subLang') || ((S.profile && S.profile.langs) || S.settings.defaultLangs || ['en'])[0] || '').toLowerCase();
  if (!this._fileTracks) return;
  var cur = (this._fileTracks.audio || [])[this.audioTrack || 0];
  if (!this._subsWanted(cur && cur.lang)) return;
  var subs = this._fileTracks.subs;
  var s = subs.filter(function (x) { return !sl || String(x.lang).toLowerCase().indexOf(sl.slice(0, 2)) === 0; }).sort(function (a, b) { return (a.forced ? 1 : 0) - (b.forced ? 1 : 0); })[0];
  if (s && this._fileSub !== s.i) this.fileSub(s.i);
};
  /** Turns on a subtitle track read from the file by the server. */
PP.fileSub = function (i) {
  var v = this.video;
  V.$$('track', v).forEach(function (t) { t.remove(); });
  for (var j = 0; j < v.textTracks.length; j++) v.textTracks[j].mode = 'disabled';
  this._fileSub = i;
  if (i < 0) return this._menuRefresh();
  var s = (this._fileTracks.subs || []).filter(function (x) { return x.i === i; })[0];
  var tr = document.createElement('track');
  tr.kind = 'subtitles';
  tr.label = (s && (s.title || V.langName(s.lang))) || 'Subtitles';
  tr.srclang = (s && s.lang ? s.lang : 'und').slice(0, 3);
  // (s.side: a subtitle file next to the video — picsubs.js. Converting from part-way through: the times are moved back.)
  var off = (this.sessionId || this.mb) && this.offset ? this.offset : 0;
  tr.src = s && s.side ? s.side + (off ? '?offset=' + off : '') : '/api/subs/' + encodeURIComponent(this.it.k) + '/' + i + '?alt=' + this.alt + (off ? '&offset=' + off : '');
  tr.default = true;
  v.appendChild(tr);
  this.osd('Loading subtitles…', 1500);
  setTimeout(function () { for (var j = 0; j < v.textTracks.length; j++) v.textTracks[j].mode = v.textTracks[j].label === tr.label ? 'showing' : 'disabled'; }, 50);
  this._menuRefresh();
};
  /** Switches to another audio track in the file (restarts the conversion at the same spot). */
PP.fileAudio = function (i) {
  this.audioTrack = i;
  var v = this.video, a = this.attempt;
  // The browser's own player can switch itself where it lists the tracks (Safari; Chrome with a flag).
  if (a && a.via === 'direct' && a.kind === 'native' && v.audioTracks && v.audioTracks.length > i) {
    for (var j = 0; j < v.audioTracks.length; j++) v.audioTracks[j].enabled = j === i;
    return this._menuRefresh();
  }
  // Converting in this browser: start again on that track, at the same spot.
  if (this.mb) return this.load(this.it, { startAt: this.position, only: a, quiet: true, alt: this.alt });
  // A film or episode this browser can convert itself (through the stream relay, which lets the page read it): that
  // track here, the server's conversion only if that doesn't work.
  var ri = this.reachInfo, src = (ri && ri.url) || (a && a.via === 'direct' && a.url);
  if (this.vod && src && /^https?:/i.test(src) && V.mbSupported() && (!ri || ri.relay || ri.mse) && !this._quality()) {
    return this.load(this.it, { startAt: this.position, plan: [{ via: 'browser', kind: 'mb', url: src }].concat(S.settings.ffmpeg ? [{ via: 'session', mode: 'remux' }] : []), quiet: true, alt: this.alt });
  }
  this.load(this.it, { force: 'remux', startAt: this.position, quiet: true, alt: this.alt });
};

PP._tracks = function () {
  var out = {};
  var hls = this.hls, sp = this.shaka, v = this.video, self = this;
  if (hls && this.levels.length > 1) {
    var auto = hls.autoLevelEnabled, cur = hls.currentLevel;
    out.quality = {
      value: auto ? 'Auto' + (cur >= 0 && this.levels[cur] ? ' (' + this._levelLabel(this.levels[cur]).split(' ·')[0] + ')' : '') : this._levelLabel(this.levels[cur]),
      items: [{ label: 'Auto', on: auto, fn: function () { hls.currentLevel = -1; } }].concat(this.levels.map(function (l, i) { return { label: self._levelLabel(l), on: !auto && cur === i, fn: function () { hls.currentLevel = i; } }; }).reverse()),
    };
  }
  if (sp) {
    var vars = this.levels.filter(function (t) { return t.height; }).sort(function (a, b) { return b.height - a.height || b.bandwidth - a.bandwidth; });
    var abr = sp.getConfiguration().abr.enabled;
    var active = sp.getVariantTracks().filter(function (t) { return t.active; })[0];
    if (vars.length > 1) out.quality = { value: abr ? 'Auto' + (active && active.height ? ' (' + active.height + 'p)' : '') : this._levelLabel(active), items: [{ label: 'Auto', on: abr, fn: function () { sp.configure({ abr: { enabled: true } }); } }].concat(vars.map(function (t) { return { label: self._levelLabel(t), on: !abr && active && active.id === t.id, fn: function () { sp.configure({ abr: { enabled: false } }); sp.selectVariantTrack(t, true); } }; })) };
    var langs = sp.getAudioLanguagesAndRoles();
    if (langs.length > 1) out.audio = { value: active ? V.langName(active.language) : '', items: langs.map(function (l) { return { label: l.label || V.langName(l.language) || 'Audio', on: active && active.language === l.language, fn: function () { sp.selectAudioLanguage(l.language, l.role); } }; }) };
    var texts = sp.getTextTracks();
    if (texts.length) {
      var vis = sp.isTextTrackVisible();
      var act = texts.filter(function (t) { return t.active; })[0];
      out.subs = { value: vis && act ? act.label || V.langName(act.language) : 'Off', items: [{ label: 'Off', on: !vis, fn: function () { sp.setTextTrackVisibility(false); } }].concat(texts.map(function (t) { return { label: t.label || V.langName(t.language) || 'Subtitles', on: vis && t.active, fn: function () { sp.selectTextTrack(t); sp.setTextTrackVisibility(true); } }; })) };
    }
  }
  if (hls && hls.audioTracks && hls.audioTracks.length > 1) out.audio = { value: (hls.audioTracks[hls.audioTrack] || {}).name || '', items: hls.audioTracks.map(function (t, i) { return { label: t.name || V.langName(t.lang) || 'Track ' + (i + 1), on: hls.audioTrack === i, fn: function () { hls.audioTrack = i; } }; }) };
  var hs = hls && hls.subtitleTracks ? hls.subtitleTracks : [];
  if (hs.length) out.subs = { value: hls.subtitleTrack >= 0 ? hs[hls.subtitleTrack].name || hs[hls.subtitleTrack].lang : 'Off', items: [{ label: 'Off', on: hls.subtitleTrack < 0, fn: function () { hls.subtitleTrack = -1; } }].concat(hs.map(function (t, i) { return { label: t.name || V.langName(t.lang) || 'Track ' + (i + 1), on: hls.subtitleTrack === i, fn: function () { hls.subtitleTrack = i; hls.subtitleDisplay = true; } }; })) };
  var ft = this._fileTracks;
  if (ft && ft.subs.length && !out.subs) {
    out.subs = { value: this._fileSub >= 0 ? 'On' : 'Off', items: [{ label: 'Off', on: !(this._fileSub >= 0), fn: function () { self.fileSub(-1); } }].concat(ft.subs.map(function (s) { return { label: (s.title || V.langName(s.lang) || 'Track ' + (s.i + 1)) + (s.forced ? ' (forced)' : ''), on: self._fileSub === s.i, fn: function () { self.fileSub(s.i); } }; })) };
  } else if (!out.subs && v.textTracks.length) {
    var tt = Array.prototype.slice.call(v.textTracks);
    out.subs = { value: (tt.filter(function (t) { return t.mode === 'showing'; })[0] || {}).label || 'Off', items: [{ label: 'Off', on: tt.every(function (t) { return t.mode !== 'showing'; }), fn: function () { tt.forEach(function (t) { t.mode = 'disabled'; }); } }].concat(tt.map(function (t, i) { return { label: t.label || V.langName(t.language) || 'Track ' + (i + 1), on: t.mode === 'showing', fn: function () { tt.forEach(function (x) { x.mode = x === t ? 'showing' : 'disabled'; }); } }; })) };
  }
  if (!out.audio && !(ft && ft.audio.length > 1) && v.audioTracks && v.audioTracks.length > 1) {
    var at = Array.prototype.slice.call(v.audioTracks);
    out.audio = { value: (at.filter(function (t) { return t.enabled; })[0] || {}).label || '', items: at.map(function (t, i) { return { label: t.label || V.langName(t.language) || 'Track ' + (i + 1), on: t.enabled, fn: function () { self.fileAudio(i); } }; }) };
  }
  if (ft && ft.audio.length > 1 && !out.audio && (S.settings.ffmpeg || this.mb)) {
    out.audio = { value: (ft.audio[this.audioTrack || 0] || {}).title || V.langName((ft.audio[this.audioTrack || 0] || {}).lang) || 'Track ' + ((this.audioTrack || 0) + 1), items: ft.audio.map(function (a) { return { label: [a.title || V.langName(a.lang) || 'Track ' + (a.i + 1), a.codec ? a.codec.toUpperCase() : '', a.channels > 2 ? a.channels + 'ch' : ''].filter(Boolean).join(' · '), on: (self.audioTrack || 0) === a.i, fn: function () { self.fileAudio(a.i); } }; }) };
  }
  if (V.extSubsInto) V.extSubsInto(this, out); // (subtitles found online)
  return out;
};

PP.cycleAudio = function () {
  var a = this._tracks().audio;
  if (!a) return this.osd('Only one audio track', 1200);
  var i = a.items.findIndex(function (x) { return x.on; });
  var next = a.items[(i + 1) % a.items.length];
  next.fn();
  this.osd('Audio: ' + next.label, 1500);
};
PP.toggleSubs = function () {
  var s = this._tracks().subs;
  if (!s) return this.osd('No subtitles for this', 1200);
  var on = s.items.findIndex(function (x) { return x.on; });
  var next = on <= 0 ? s.items[1] : s.items[0];
  next.fn();
  this.osd('Subtitles: ' + next.label, 1500);
  this._menuRefresh();
};

  // ------------------------------------------------------------ menus
PP._menuPages = function (kind) {
  var v = this.video, self = this;
  var pages = {};
  var main = [];
  var tr = this._tracks();
  if (kind === 'cc') {
    if (tr.subs) { main.push({ label: 'Subtitles', value: tr.subs.value, page: 'subs' }); pages.subs = tr.subs.items; } else main.push({ label: 'Subtitles', value: 'None', inert: true, fn: function () {} });
    if (tr.audio) { main.push({ label: 'Audio', value: tr.audio.value, page: 'audio' }); pages.audio = tr.audio.items; }
    main.push({ label: 'Subtitle style', value: '', fn: function () { V.subtitleStyleDialog(); } });
    // Subtitles found online (SubDL, Addic7ed, OpenSubtitles): see integrations.js.
    if ((S.settings.subtitles || S.settings.opensubtitles) && this.it && (this.it.t === 'movie' || this.it.t === 'episode')) main.push({ label: 'Find subtitles…', value: '', fn: function () { V.findSubtitles(self); } });
    if (V.ccMenuExtras) V.ccMenuExtras(this, main, pages); // (subtitle timing: subtiming.js)
    pages.main = main;
    return pages;
  }
  if (tr.quality) { main.push({ label: 'Quality', value: tr.quality.value, page: 'quality' }); pages.quality = tr.quality.items; }
  else if (S.settings.ffmpeg && this.vod) {
    var cur = this._quality();
    main.push({ label: 'Quality', value: cur ? cur + 'p' : 'Original', page: 'squality' });
    pages.squality = [0, 1080, 720, 480, 360].map(function (h) { return { label: h ? h + 'p (converted)' : 'Original', on: cur === h, fn: function () { V.setPref('quality', h ? String(h) : 'auto'); self.load(self.it, { startAt: self.position, quiet: true, alt: self.alt, force: h ? 'transcode' : undefined }); } }; });
  }
  if (this.vod) {
    main.push({ label: 'Speed', value: v.playbackRate === 1 ? 'Normal' : v.playbackRate + '×', page: 'speed' });
    pages.speed = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map(function (r) { return { label: r === 1 ? 'Normal' : r + '×', on: v.playbackRate === r, fn: function () { self.setRate(r); } }; });
  }
  var fits = { contain: 'Fit', cover: 'Fill (crop)', fill: 'Stretch' };
  main.push({ label: 'Picture', value: fits[this.fit], page: 'fit' });
  pages.fit = Object.keys(fits).map(function (k) { return { label: fits[k], on: self.fit === k, fn: function () { self.setFit(k); } }; });
  main.push({ label: 'Zoom', value: Math.round(this.zoom * 100) + '%', page: 'zoom' });
  pages.zoom = [1, 1.1, 1.2, 1.33, 1.5, 2].map(function (z) { return { label: Math.round(z * 100) + '%', on: self.zoom === z, fn: function () { self.setZoom(z); } }; });
  var a = this.adjust;
  main.push({ label: 'Brightness & colour', value: a.b !== 1 || a.c !== 1 || a.s !== 1 ? 'Custom' : 'Normal', page: 'adjust' });
  var levels = [0.6, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
  pages.adjust = [
    { label: 'Brightness', value: Math.round(a.b * 100) + '%', page: 'adj-b' },
    { label: 'Contrast', value: Math.round(a.c * 100) + '%', page: 'adj-c' },
    { label: 'Colour', value: Math.round(a.s * 100) + '%', page: 'adj-s' },
    { label: 'Reset', fn: function () { self.adjust = { b: 1, c: 1, s: 1 }; V.ls.set('adjust', self.adjust); self._applyFit(); } },
  ];
  ['b', 'c', 's'].forEach(function (k) { pages['adj-' + k] = levels.map(function (x) { return { label: Math.round(x * 100) + '%', on: a[k] === x, fn: function () { self.setAdjust(k, x); }, back: 'adjust' }; }); });
  if (V.canBoost()) main.push({ label: 'Volume boost', value: this.boost === 1 ? 'Off' : Math.round(this.boost * 100) + '%', page: 'boost' });
  pages.boost = [1, 1.5, 2, 3].map(function (x) { return { label: x === 1 ? 'Off' : Math.round(x * 100) + '%', on: self.boost === x, fn: function () { self.setBoost(x); } }; });
  var left = V.sleepLeft();
  // ("End of this video" isn't a time: V._sleepAt -1.)
  var atEnd = V._sleepAt === -1;
  main.push({ label: 'Sleep timer', value: atEnd ? 'End of video' : left ? Math.ceil(left / 60000) + ' min left' : 'Off', page: 'sleep' });
  pages.sleep = [0, 15, 30, 45, 60, 90, 120].map(function (m) { return { label: m ? m + ' minutes' : 'Off', on: m === 0 ? !left : false, fn: function () { V.setSleep(m); } }; }).concat(this.vod || atEnd ? [{ label: 'End of this video', on: atEnd, fn: function () { V.setSleep(-1); } }] : []);
  if (this.it && this.it.a && this.it.a.length) {
    main.push({ label: 'Source', value: this.alt >= 0 ? 'Backup ' + (this.alt + 1) : 'Main', page: 'alts' });
    pages.alts = [{ label: 'Main', on: this.alt < 0, fn: function () { self.load(self.it, { alt: -1, startAt: self.vod ? self.position : 0 }); } }].concat(this.it.a.map(function (x, i) { var host = ''; try { host = new URL(x.u).host; } catch (e) {} return { label: 'Backup ' + (i + 1) + (host ? ' · ' + host : ''), on: self.alt === i, fn: function () { self.load(self.it, { alt: i, startAt: self.vod ? self.position : 0 }); } }; }));
  }
  if (this.it && this.vod && (this.it.t === 'episode' || this.it.t === 'movie')) main.push({ label: 'Mark intro / credits', value: '', fn: function () { V.markersDialog(self); } });
  main.push({ label: 'Screenshot', value: '', fn: function () { self.screenshot(); } });
  main.push({ label: 'Stream info', value: this.statsOn ? 'On' : 'Off', fn: function () { self.toggleStats(); } });
  if (this.it) main.push({ label: 'Reload', value: '', fn: function () { self.load(self.it, { startAt: self.vod ? self.position : 0, alt: self.alt }); } });
  // (Audio sync, sound only, open in another app: avsync.js, audioonly.js, extplayer.js.)
  if (V.playerMenuExtras) V.playerMenuExtras(this, main, pages);
  pages.main = main;
  return pages;
};

var MENU_GROUP = { Quality: 0, Speed: 0, Source: 0, 'Sleep timer': 0, 'Sound only': 0, Reload: 0, 'Autoplay next episode': 0, Picture: 1, Zoom: 1, 'Brightness & colour': 1, 'Mark intro / credits': 1, Screenshot: 1, 'Volume boost': 2, 'Clear dialogue': 2, 'Night mode': 2, 'Audio sync': 2 };
// A small picture for each setting, so it's quick to see what's what.
var MENU_ICON = {
  Quality: 'hd', Speed: 'gauge', Source: 'server', 'Sleep timer': 'timer', 'Sound only': 'headphones', Reload: 'refresh', 'Autoplay next episode': 'skipnext',
  Picture: 'aspect', Zoom: 'zoom', 'Brightness & colour': 'sun', Brightness: 'sun', Contrast: 'contrast', Colour: 'palette', Reset: 'restart',
  'Volume boost': 'vol', 'Clear dialogue': 'mic', 'Night mode': 'moon', 'Audio sync': 'sync',
  'Mark intro / credits': 'pin', Screenshot: 'camera', 'Stream info': 'info', 'Your queue': 'playlist', 'Report a problem': 'help', 'Open in another app': 'openapp',
  'Control from your phone': 'remote', 'Add to multiview': 'multi',
  Subtitles: 'cc', Audio: 'globe', 'Subtitle style': 'edit', 'Find subtitles…': 'search', 'Subtitle timing': 'sync',
};
var menuIcon = function (it) { return it.icon || MENU_ICON[it.label] || (/record/i.test(it.label) ? 'rec' : /open/i.test(it.label) ? 'openapp' : 'sliders'); };
/* The settings: a big panel over the picture (above the buttons), its settings in four columns — Playback, Picture,
   Sound, More — each with a picture, its name and what it's set to, so it all fits without scrolling. A setting's
   choices open in the same panel. The gear (or the close button, Back, or a click outside) closes it again. On
   phones it's a sheet from the bottom (p12.css, p16.css). */
PP._openMenu = function (page, kind) {
  var m = V.$('.vp-menu', this.host);
  kind = kind || this._menuKind || 'gear';
  this._menuKind = kind;
  var pages = this._menuPages(kind);
  var items = pages[page] || pages.main;
  // The same page drawn again (a step in a setting, new tracks): keep the highlighted line where it was.
  var keep = (page || 'main') === this._menuPage && !m.hidden && document.activeElement && m.contains(document.activeElement) ? document.activeElement.getAttribute('data-i') : null;
  var scrollWas = keep !== null && V.$('.mb', m) ? V.$('.mb', m).scrollTop : 0;
  this._menuPage = page || 'main';
  m.hidden = false;
  var parent = this._menuPage.indexOf('adj-') === 0 ? 'adjust' : 'main';
  var radio = this._menuPage !== 'main' && this._menuPage !== 'adjust';
  var from = (pages[parent] || pages.main || []).filter(function (x) { return x.page === page; })[0];
  var title = this._menuPage === 'main' ? (kind === 'cc' ? 'Subtitles & audio' : 'Settings') : from ? from.label : 'Settings';
  var back = this._menuPage !== 'main' ? '<button class="mi back" data-back="' + parent + '" aria-label="Back">' + V.icon('back') + '</button>' : '';
  var head = '<div class="mh">' + back + '<span class="mh-t">' + (from && radio ? '<span class="mh-ic">' + V.icon(menuIcon(from)) + '</span>' : '') + V.esc(title) + '</span>' +
    '<button class="mh-x" data-close aria-label="Close" title="Close">' + V.icon('x') + '</button></div>';
  // A line that does nothing when pressed (Audio sync's "Sound in sync", say) just says how things are.
  var inert = function (it) { return it.inert ? ' data-inert' : ''; };
  var row = function (it, i) {
    if (radio) return '<button class="mi opt' + (it.on ? ' on' : '') + '" data-i="' + i + '"' + inert(it) + ' role="menuitemradio" aria-checked="' + !!it.on + '"><span class="dot">' + (it.on ? V.icon('check') : '') + '</span><span class="ml">' + V.esc(it.label) + '</span>' + (it.value ? '<span class="mv">' + V.esc(it.value) + '</span>' : '') + '</button>';
    var val = it.value !== undefined && it.value !== '' ? '<span class="mv">' + V.esc(it.value) + '</span>' : '';
    return '<button class="mi tile" data-i="' + i + '"' + inert(it) + ' role="menuitem"><span class="mic">' + V.icon(menuIcon(it)) + '</span><span class="mtx"><span class="ml">' + V.esc(it.label) + '</span>' + val + '</span>' + (it.page ? V.icon('next', 'mnx') : '') + '</button>';
  };
  var body, wide = false;
  if (this._menuPage === 'main' && kind !== 'cc' && items.length > 7) {
    // In sections (Playback, Picture, Sound, More), side by side.
    var groups = [['Playback', []], ['Picture', []], ['Sound', []], ['More', []]];
    items.forEach(function (it, i) {
      var g = MENU_GROUP[it.label] !== undefined ? MENU_GROUP[it.label] : /record/i.test(it.label) ? 0 : 3;
      groups[g][1].push(row(it, i));
    });
    groups = groups.filter(function (g) { return g[1].length; });
    wide = true;
    body = '<div class="mb cols" style="--cols:' + groups.length + '">' + groups.map(function (g) { return '<div class="mcol" role="group" aria-label="' + g[0] + '"><div class="mg" role="presentation">' + g[0] + '</div>' + g[1].join('') + '</div>'; }).join('') + '</div>';
  } else body = '<div class="mb' + (radio ? ' opts' + (items.length > 6 ? ' many' : '') : ' list') + '">' + items.map(row).join('') + '</div>';
  m.className = 'vp-menu big' + (wide ? ' wide' : '') + (radio ? ' radio' : '');
  // (The button that opened it shows it's open.)
  var host = this.host;
  ['gear', 'cc'].forEach(function (x) { var bt = V.$('[data-a=' + x + ']', host); if (bt) bt.setAttribute('aria-expanded', String(x === (kind === 'cc' ? 'cc' : 'gear'))); });
  m.setAttribute('aria-label', title);
  m.innerHTML = head + body;
  var self = this;
  m.onclick = function (e) {
    e.stopPropagation();
    if (e.target.closest('[data-close]')) return self._closeMenu();
    var bk = e.target.closest('[data-back]');
    if (bk) return self._openMenu(bk.dataset.back);
    var b = e.target.closest('[data-i]');
    if (!b) return;
    var it = items[+b.dataset.i];
    if (it.page) return self._openMenu(it.page);
    it.fn();
    if (self._menuPage === 'main') self._closeMenu(); else self._openMenu(it.back || parent);
  };
  // (The highlight starts on the first line that does something, so a remote's first press isn't wasted.)
  var first = (keep !== null && V.$('.mi[data-i="' + keep + '"]', m)) || V.$('.mi[aria-checked=true]', m) || V.$('.mb .mi:not([data-inert])', m) || V.$('.mb .mi', m);
  // (Not on touch screens: there the highlight just looks like a stuck tap. Remotes and keyboards still get it.)
  var touch = !V.tvMode && window.matchMedia && matchMedia('(hover: none)').matches;
  if (first && (!touch || keep !== null)) first.focus({ preventScroll: true });
  var mb = V.$('.mb', m);
  if (mb) mb.scrollTop = scrollWas;
  m.scrollTop = 0;
};
/** Back (Esc, a remote's Back): from a setting's choices to the settings; from the settings, closed. */
PP._menuBack = function () {
  var pg = this._menuPage || 'main';
  if (pg === 'main') return this._closeMenu();
  this._openMenu(pg.indexOf('adj-') === 0 ? 'adjust' : 'main');
};
PP._menuRefresh = function () { var m = V.$('.vp-menu', this.host); if (m && !m.hidden) this._openMenu(this._menuPage); this._ccButton(); };
PP._closeMenu = function () { var m = V.$('.vp-menu', this.host); var host = this.host; ['gear', 'cc'].forEach(function (x) { var bt = V.$('[data-a=' + x + ']', host); if (bt) bt.setAttribute('aria-expanded', 'false'); }); if (m && !m.hidden) { m.hidden = true; var b = V.$('[data-a=' + (this._menuKind === 'cc' ? 'cc' : 'gear') + ']', this.host); if (b && this.el.contains(document.activeElement)) b.focus(); } };
PP._ccButton = function () { var t = this._tracks(); var b = V.$('[data-a=cc]', this.host); if (b) b.classList.toggle('dim', !t.subs && !t.audio); };

  // ------------------------------------------------------------ stats
PP.toggleStats = function (force) {
  this.statsOn = force === undefined ? !this.statsOn : force;
  V.$('.vp-stats', this.host).hidden = !this.statsOn;
  clearInterval(this._statsT);
  var me = this;
  if (this.statsOn) { this._statsTick(); this._statsT = setInterval(function () { me._statsTick(); }, 1000); }
};
PP._statsTick = function () {
  var v = this.video, rows = [], a = this.attempt;
  rows.push(['Playback', a ? (a.helper ? MODE_LABEL.helper : a.native ? MODE_LABEL['native:hls'] : MODE_LABEL[a.via + ':' + (a.kind === '?' ? 'native' : a.kind || a.mode)] || a.via) : '–']);
  rows.push(['Resolution', v.videoWidth ? v.videoWidth + '×' + v.videoHeight : (this.it && this.it.t === 'radio' ? 'Audio only' : '–')]);
  if (this.hls) {
    var l = this.levels[this.hls.currentLevel] || this.levels[this.hls.loadLevel] || {};
    rows.push(['Codecs', [l.videoCodec, l.audioCodec].filter(Boolean).join(', ') || '–']);
    rows.push(['Bitrate', V.fmtBits(l.bitrate)]);
    rows.push(['Bandwidth', V.fmtBits(this.hls.bandwidthEstimate)]);
  }
  if (this.mts) { var mi = this.mts.mediaInfo || {}, st = this.mts.statisticsInfo || {}; rows.push(['Codecs', [mi.videoCodec, mi.audioCodec].filter(Boolean).join(', ') || '–']); rows.push(['Download', st.speed ? V.fmtBits(st.speed * 8 * 1024) : '–']); }
  if (this.shaka) { var s2 = this.shaka.getStats(); var act = this.shaka.getVariantTracks().filter(function (t) { return t.active; })[0] || {}; rows.push(['Codecs', [act.videoCodec, act.audioCodec].filter(Boolean).join(', ') || '–']); rows.push(['Bitrate', V.fmtBits(s2.streamBandwidth)]); rows.push(['Bandwidth', V.fmtBits(s2.estimatedBandwidth)]); }
  if (this.sessionInfo) rows.push(['Source', [this.sessionInfo.vcodec, this.sessionInfo.height ? this.sessionInfo.height + 'p' : ''].filter(Boolean).join(' · ') || '–']);
  var b = v.buffered, ahead = 0;
  for (var i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5 && b.end(i) > v.currentTime) ahead = b.end(i) - v.currentTime;
  rows.push(['Buffer', ahead.toFixed(1) + ' s']);
  if (v.getVideoPlaybackQuality) { var q = v.getVideoPlaybackQuality(); rows.push(['Dropped frames', q.droppedVideoFrames + ' of ' + q.totalVideoFrames]); }
  if (this.alt >= 0) rows.push(['Stream', 'Backup ' + (this.alt + 1)]);
  try { rows.push(['Server', new URL(this.url).host]); } catch (e) {}
  V.$('.vp-stats', this.host).innerHTML = '<button class="pbtn sm" data-a="stats-x" aria-label="Hide stream info">' + V.icon('x') + '</button><dl>' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + V.esc(r[1]) + '</dd>'; }).join('') + '</dl>';
};

  // ------------------------------------------------------------ UI updates
PP._titles = function () {
  var it = this.it;
  var t = V.$('.vp-title', this.host), s = V.$('.vp-sub', this.host);
  if (!it) { t.textContent = ''; s.textContent = ''; return; }
  if (it.t === 'episode') { var show = V.showOf(it); t.textContent = show ? show.n : it.n; s.textContent = V.epLabel(it) + (it.et ? ' · ' + it.et : ''); }
  else if (it.t === 'catchup') { t.textContent = it.channelName; s.textContent = it.n + ' · ' + V.fmtDay(it.prog.s) + ' ' + V.fmtClock(it.prog.s); }
  else if (it.t === 'live' || it.t === 'radio') { t.textContent = (it.no ? it.no + '  ' : '') + it.n; var nn = V.epg.nowNext(it); s.textContent = nn.now ? nn.now.t : ''; }
  else { t.textContent = it.n; s.textContent = [it.y, it.d ? V.fmtLen(it.d) : ''].filter(Boolean).join(' · '); }
  V.$('.vp-ttl', this.host).textContent = '';
  document.title = it.n + ' · ' + ((S.settings && S.settings.brand && S.settings.brand.name) || '');
};

PP._volUi = function () {
  var v = this.video;
  var vol = V.$('.vol', this.host);
  if (vol) { vol.value = v.muted ? 0 : v.volume; vol.style.setProperty('--p', (v.muted ? 0 : v.volume) * 100 + '%'); }
  V.$('[data-a=mute]', this.host).innerHTML = V.icon(v.muted || v.volume === 0 ? 'mute' : 'vol');
  V.ls.set('volume', v.volume); V.ls.set('muted', v.muted);
};

PP._drawMarks = function () {
  var box = V.$('.marks', this.host);
  var m = this.markers, tot = this.duration;
  if (!box) return;
  box.innerHTML = '';
  if (!m || !tot) return;
  ['intro', 'credits'].forEach(function (k) { var x = m[k]; if (x) box.insertAdjacentHTML('beforeend', '<i class="mk ' + k + '" style="left:' + (x.start / tot * 100) + '%;width:' + ((x.end - x.start) / tot * 100) + '%"></i>'); });
};

PP._tick = function () {
  var v = this.video;
  var t1 = V.$('.vp-t1', this.host), t2 = V.$('.vp-t2', this.host), seek = V.$('.vp-seek', this.host);
  if (!this.started) { t1.textContent = ''; t2.textContent = ''; return; }
  if (this.vod) {
    var pos = this.position, tot = this.duration;
    t1.textContent = V.fmtDur(pos);
    // Time left, or (a tap on it switches, and it's remembered) the time it ends — at the speed it's playing.
    var left = Math.max(0, tot - pos);
    t2.textContent = !tot ? '' : V.pref('timeEnds') ? 'Ends ' + V.fmtClock(Date.now() + left / (v.playbackRate || 1) * 1000) : '−' + V.fmtDur(left);
    seek.hidden = !tot;
    if (tot) {
      var f = V.clamp(pos / tot, 0, 1);
      if (!seek.classList.contains('drag')) { // (being dragged: it shows where it will go, not where it is)
        V.$('.fill', seek).style.width = f * 100 + '%';
        V.$('.knob', seek).style.left = f * 100 + '%';
      }
      seek.setAttribute('aria-valuenow', Math.round(pos));
      seek.setAttribute('aria-valuemax', Math.round(tot));
      seek.setAttribute('aria-valuetext', V.fmtDur(pos) + ' of ' + V.fmtDur(tot));
      var b = v.buffered;
      if (b.length) V.$('.buf', seek).style.width = Math.min(100, ((this.base + b.end(b.length - 1)) / tot) * 100) + '%';
      if (!V.$('.mk', seek) && this.markers) this._drawMarks();
    }
    if (this.onTick) this.onTick(pos, tot);
    return;
  }
  var behind = this.behindLive;
  var lb = V.$('[data-a=golive]', this.host);
  lb.classList.toggle('behind', behind > 12);
  lb.textContent = behind > 12 ? 'Go live' : 'Live';
  t1.textContent = behind > 12 ? '−' + V.fmtDur(behind) : '';
  t2.textContent = '';
  var w = this.liveWindow;
  seek.hidden = !w;
  if (w) {
    var f2 = (v.currentTime - w.start) / (w.end - w.start);
    V.$('.fill', seek).style.width = V.clamp(f2, 0, 1) * 100 + '%';
    V.$('.knob', seek).style.left = V.clamp(f2, 0, 1) * 100 + '%';
    V.$('.buf', seek).style.width = '100%';
  }
  if (this.onTick) this.onTick(0, 0);
};

PP._replaceVideo = function () {
  var old = this.video;
  var nv = document.createElement('video');
  nv.playsInline = true; nv.preload = 'auto'; nv.volume = old.volume; nv.muted = old.muted;
  nv.setAttribute('x-webkit-airplay', 'allow');
  old.replaceWith(nv);
  this.video = nv;
  this._audioSrc = null; this._gain = null; this.boost = 1;
  this._applyFit();
  this._bindVideo(nv);
  this._watchCueSize();
};

PP._mediaSession = function () {
  if (!('mediaSession' in navigator) || !this.it) return;
  var it = this.it, self = this;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: it.t === 'episode' ? (it.et || it.n) : it.n, artist: it.t === 'episode' ? ((V.showOf(it) || {}).n || '') + ' ' + V.epLabel(it) : (S.settings.brand || {}).name || '', artwork: it.i ? [{ src: it.i, sizes: '512x512' }] : [] });
    navigator.mediaSession.setActionHandler('play', function () { self.video.play(); });
    navigator.mediaSession.setActionHandler('pause', function () { self.video.pause(); });
    navigator.mediaSession.setActionHandler('seekbackward', function (d) { self.skip(-((d && d.seekOffset) || V.skipLen('back'))); });
    navigator.mediaSession.setActionHandler('seekforward', function (d) { self.skip((d && d.seekOffset) || V.skipLen('fwd')); });
    navigator.mediaSession.setActionHandler('nexttrack', self.onNext ? function () { self.onNext(); } : null);
  } catch (e) {}
};
  /** Keeps the screen on while playing (where the browser allows it). */
PP._wakeLock = function (on) {
  var self = this;
  try {
    if (on && navigator.wakeLock && !this._lock && !this._locking) {
      this._locking = true;
      navigator.wakeLock.request('screen').then(function (l) { self._locking = false; self._lock = l; l.addEventListener('release', function () { self._lock = null; }); }, function () { self._locking = false; });
    } else if (!on && this._lock) { this._lock.release(); this._lock = null; }
  } catch (e) {}
};

PP._bindVideo = function (v) {
  var h = this.host, self = this;
  // AirPlay: the TV fetches the stream itself (see _toAirplay).
  v.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', function () { if (v === self.video && v.webkitCurrentPlaybackTargetIsWireless) self._toAirplay(); });
  v.addEventListener('playing', function () { if (v !== self.video) return; if (v.webkitCurrentPlaybackTargetIsWireless) self._toAirplay(); else if (self._apPick) setTimeout(function () { self._apReady(); }, 300); });
  v.addEventListener('volumechange', function () { self._volUi(); });
  v.addEventListener('play', function () { V.$('[data-a=play]', h).innerHTML = V.icon('pause'); V.$('[data-a=play]', h).setAttribute('aria-label', 'Pause'); self.el.classList.remove('paused'); self._wakeLock(true); });
  v.addEventListener('pause', function () { V.$('[data-a=play]', h).innerHTML = V.icon('play'); V.$('[data-a=play]', h).setAttribute('aria-label', 'Play'); self.el.classList.add('paused'); self._saveProgress(); self._wake(true); });
  v.addEventListener('playing', function () { if (self.started) self._msg(null); self._stallAt = 0; clearTimeout(self._whyT); });
  v.addEventListener('waiting', function () { if (self.started) { self._msg({ spin: true }); self._stallAt = Date.now(); self._stalled(); } });
  // (Starting: the first of the video has arrived — the last step before the picture.)
  v.addEventListener('loadedmetadata', function () { var b = V.$('.vp-msg', self.host); if (!self.started && self._stepTitle && b && b.hasAttribute('data-step')) self._step(self._stepTitle, 'The video is arriving, starting…'); });
  v.addEventListener('timeupdate', function () {
    var now = Date.now();
    if (self._lastTU && !v.paused && now - self._lastTU < 2000) self._watched = (self._watched || 0) + (now - self._lastTU) / 1000;
    self._lastTU = now;
    self._tick();
  });
  v.addEventListener('ratechange', function () { self._menuRefresh(); });
  v.addEventListener('ended', function () {
    if (!self.started) return;
    if (self.vod) { self._saveProgress(true); if (self.onEnded) self.onEnded(self); }
    else self._fatal(new Error('The stream ended.'));
  });
  v.addEventListener('error', function () { if (self.started && !self._failNow && self.video === v) self._fatal(V.techErr(self._mediaErr(), self._mediaDetail())); });
  v.addEventListener('enterpictureinpicture', function () { self.el.classList.add('pip'); });
  v.addEventListener('leavepictureinpicture', function () { self.el.classList.remove('pip'); });
};

PP._bind = function () {
  var h = this.host, self = this;
  h.addEventListener('click', function (e) {
    var b = e.target.closest('[data-a]');
    // The settings panel is open: a click anywhere else closes it (and does nothing else).
    var menu = V.$('.vp-menu', h);
    if (!menu.hidden && !(b && (b.dataset.a === 'gear' || b.dataset.a === 'cc'))) { self._closeMenu(); if (!b) return; }
    if (!b) {
      if ((e.target === self.video || e.target.closest('.vp-art') || e.target === self.el) && self.started && !self._swiped) {
        if (V.device.touch && !self._recentWake) { self._wake(); return; }
        if (self.vod) self.togglePlay(); else if (self.onTap) self.onTap();
      }
      self._swiped = false;
      return;
    }
    e.stopPropagation();
    var a = b.dataset.a;
    if (a === 'play') self.togglePlay();
    else if (a === 'rw') self.skip(-V.skipLen('back'));
    else if (a === 'ff') self.skip(V.skipLen('fwd'));
    else if (a === 'audioonly' && V.audioOnly) V.audioOnly.toggle(self);
    else if (a === 'mute') self.toggleMute();
    else if (a === 'fs') self.toggleFullscreen();
    else if (a === 'pip') self.togglePip();
    else if (a === 'golive') self.goLive();
    else if (a === 'stats-x') self.toggleStats(false);
    else if (a === 'timeends') { V.setPref('timeEnds', !V.pref('timeEnds')); self._tick(); }
    else if (a === 'hidectl') { self.hideControls(); return; }
    else if (a === 'gear' || a === 'cc') { var m = V.$('.vp-menu', h); if (m.hidden || self._menuKind !== a) { self._menuKind = a; self._openMenu('main', a); } else self._closeMenu(); }
    else if (self.onButton) self.onButton(a, b);
    self._wake();
  });
  var vol = V.$('.vol', h);
  vol.addEventListener('input', function (e) { self.setVolume(+e.target.value); });
  setInterval(function () {
    if (!self.started) return;
    self._tick();
    self._statTick();
    if ((self._watched || 0) >= (self._inHistory ? 60 : 10)) self._accountWatched();
    if (self.vod && !self.video.paused && Date.now() - (self._lastSave || 0) > 10000) { self._lastSave = Date.now(); self._saveProgress(); }
    // Stall watchdog: stuck buffering for 15 s → reconnect.
    if (self._stallAt && !self.video.paused && Date.now() - self._stallAt > 15000) { self._stallAt = 0; self._fatal(new Error('The stream stopped.')); }
  }, 1000);
  window.addEventListener('online', function () { if (self.it && self.started && (self.video.readyState < 3 || self._stallAt)) self._fatal(new Error('Network came back')); });
  var fsChange = function () { var fs = (document.fullscreenElement || document.webkitFullscreenElement) === self.el; self.el.classList.toggle('fs', fs); V.$('[data-a=fs]', h).innerHTML = V.icon(fs ? 'fsx' : 'fs'); };
  document.addEventListener('fullscreenchange', fsChange);
  document.addEventListener('webkitfullscreenchange', fsChange);

  var seek = V.$('.vp-seek', h);
  var at = function (e) {
    var r = seek.getBoundingClientRect();
    var f = V.clamp((e.clientX - r.left) / r.width, 0, 1);
    if (self.vod) return f * self.duration;
    var w = self.liveWindow;
    return w ? w.start + f * (w.end - w.start) : 0;
  };
  var tip = V.$('.tip', seek), tipImg = V.$('img', tip), tipT = V.$('span', tip);
  var frameReq = V.debounce(function (t) {
    if (!self.vod || !self.it || !S.settings.ffmpeg || self.it.t === 'catchup' || self.it.t === 'radio') return;
    if (self._noFrames === self.it.k) return; // the server said it can't for this one (e.g. a one-connection provider)
    var g = self._frameStep || 10;
    var src = '/api/frame/' + encodeURIComponent(self.it.k) + '?t=' + Math.round(t / g) * g + '&w=240';
    var k0 = self.it.k;
    tipImg.onload = function () { tipImg.hidden = false; self._frameFails = 0; };
    tipImg.onerror = function () { tipImg.hidden = true; self._frameFails = (self._frameFails || 0) + 1; if (self._frameFails >= 2) self._noFrames = k0; };
    if (tipImg.getAttribute('src') !== src) tipImg.src = src;
  }, 180);
  // Dragging the timeline. Where you press is where it goes; from there it follows your finger or the mouse — and the
  // further you move away from the bar (up or down), the finer it gets: half speed, a quarter, a tenth, so a few
  // seconds either way are easy to hit even on a phone and a three-hour film. The picture moves once, when you let go
  // (a conversion on the server starts again at each jump). The mouse wheel over the bar steps 5 seconds (1 with Shift).
  var drag = false, cur = 0, lastX = 0, fine = 1, wheelT = null;
  var span = function () { var w = self.liveWindow; return self.vod ? [0, self.duration || 0] : w ? [w.start, w.end] : [0, 0]; };
  var show = function (t, note) {
    var sp = span(), r = seek.getBoundingClientRect();
    var f = sp[1] > sp[0] ? V.clamp((t - sp[0]) / (sp[1] - sp[0]), 0, 1) : 0;
    V.$('.fill', seek).style.width = f * 100 + '%'; V.$('.knob', seek).style.left = f * 100 + '%';
    tip.style.left = V.clamp(f * r.width, 60, Math.max(60, r.width - 60)) + 'px';
    var d = t - self.position, by = Math.abs(d) >= 1 ? ' (' + (d > 0 ? '+' : '−') + V.fmtDur(Math.abs(d)) + ')' : '';
    tipT.textContent = (self.vod ? V.fmtDur(t) + by : '−' + V.fmtDur(sp[1] - t)) + (note ? ' · ' + note : '');
    seek.setAttribute('aria-valuetext', self.vod ? V.fmtDur(t) + ' of ' + V.fmtDur(sp[1]) : V.fmtDur(sp[1] - t) + ' behind live');
  };
  var frameAt = function (t) { self._frameStep = fine < 1 ? 2 : 10; frameReq(t); };
  seek.addEventListener('pointermove', function (e) {
    var r = seek.getBoundingClientRect();
    if (drag) {
      var sp = span(), away = Math.max(r.top - e.clientY, e.clientY - r.bottom, 0);
      fine = away < 45 ? 1 : away < 110 ? 0.5 : away < 180 ? 0.25 : 0.1;
      cur = V.clamp(cur + (e.clientX - lastX) / r.width * (sp[1] - sp[0]) * fine, sp[0], sp[1]);
      lastX = e.clientX;
      seek.classList.toggle('fine', fine < 1);
      show(cur, fine === 1 ? '' : fine === 0.5 ? 'fine ½' : fine === 0.25 ? 'fine ¼' : 'fine ⅒');
      frameAt(cur);
      return;
    }
    if (wheelT) return;
    var t = at(e);
    tipT.textContent = self.vod ? V.fmtDur(t) : (self.liveWindow ? '−' + V.fmtDur(self.liveWindow.end - t) : '');
    tip.style.left = V.clamp(e.clientX - r.left, 60, r.width - 60) + 'px';
    if (e.pointerType === 'mouse') frameAt(t);
  });
  seek.addEventListener('pointerleave', function () { if (!drag) tipImg.hidden = true; });
  var endDrag = function () { drag = false; fine = 1; seek.classList.remove('drag'); seek.classList.remove('fine'); tipImg.hidden = true; };
  seek.addEventListener('pointerdown', function (e) {
    if (e.button > 0) return;
    if (wheelT) { clearTimeout(wheelT); wheelT = null; }
    drag = true; fine = 1; cur = at(e); lastX = e.clientX;
    seek.classList.add('drag');
    try { seek.setPointerCapture(e.pointerId); } catch (x) {}
    show(cur); frameAt(cur);
  });
  seek.addEventListener('pointerup', function () { if (drag) { endDrag(); self.seek(cur); } });
  // (The touch was taken away — a call coming in, the system's own swipe: nothing moves.)
  seek.addEventListener('pointercancel', function () { if (drag) { endDrag(); self._tick(); } });
  seek.addEventListener('wheel', function (e) {
    if (!self.started || drag || (!self.vod && !self.liveWindow)) return;
    var d = e.deltaY || e.deltaX;
    if (!d) return;
    e.preventDefault();
    var sp = span();
    if (!wheelT) cur = self.position;
    cur = V.clamp(cur + (d < 0 ? 1 : -1) * (e.shiftKey ? 1 : 5), sp[0], sp[1]);
    seek.classList.add('drag');
    show(cur);
    clearTimeout(wheelT);
    wheelT = setTimeout(function () { wheelT = null; seek.classList.remove('drag'); self.seek(cur); }, 350);
  }, { passive: false });
  seek.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); self.skip(e.shiftKey ? -60 : -V.skipLen('back')); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); self.skip(e.shiftKey ? 60 : V.skipLen('fwd')); }
    else if (e.key === 'Home') { e.preventDefault(); self.seek(0); }
    else if (e.key === 'End' && self.vod) { e.preventDefault(); self.seek(self.duration - 5); }
  });

  // Touch: double-tap sides to skip, swipe up/down on live TV to change channel.
  var sw = null, lastTap = 0;
  this.el.addEventListener('pointerdown', function (e) {
    if (e.pointerType !== 'touch' || e.target.closest('.vp-ctrl, .vp-menu, .vp-top, .vp-msg button, .vp-side, .vp-skip, .vp-upnext, .vp-end')) return;
    sw = { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  this.el.addEventListener('pointerup', function (e) {
    if (!sw || e.pointerType !== 'touch') return;
    var dx = e.clientX - sw.x, dy = e.clientY - sw.y, dt = Date.now() - sw.t;
    sw = null;
    if (dt > 700) return;
    if (Math.abs(dy) > 60 && Math.abs(dx) < 50 && self.onSwipe) { self._swiped = true; self.onSwipe(dy < 0 ? 'up' : 'down'); return; }
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && (self.vod || self.liveWindow) && self.started) {
      var now = Date.now();
      if (now - lastTap < 320) { var r = self.el.getBoundingClientRect(); var x = (e.clientX - r.left) / r.width; if (x < 0.35) { self._swiped = true; self.skip(-V.skipLen('back')); } else if (x > 0.65) { self._swiped = true; self.skip(V.skipLen('fwd')); } lastTap = 0; } else lastTap = now;
    }
  });
  var wake = function () { self._wake(); };
  // Only a real move of the mouse brings the controls back: browsers also send "moves" when what's under a still
  // pointer changes (the controls fading out, the clock ticking), which kept them from ever hiding. Just after
  // "Hide the controls" it takes a bigger move, so the hand still on the mouse doesn't bring them straight back.
  var mx = -1, my = -1;
  this.el.addEventListener('mousemove', function (e) {
    var d = Math.abs(e.clientX - mx) + Math.abs(e.clientY - my);
    if (d < (self._hiddenAt && Date.now() - self._hiddenAt < 3000 ? 40 : 6)) return;
    mx = e.clientX; my = e.clientY;
    self._wake();
  });
  this.el.addEventListener('touchstart', wake, { passive: true });
  this.el.addEventListener('focusin', wake);
  this.el.addEventListener('mouseleave', function () { if (!self.video.paused && V.$('.vp-menu', h).hidden && !V.$('.vp-seek.drag', h)) self.el.classList.add('idle'); });
};

/** "Hide the controls": everything goes until the mouse moves, the screen is touched or a key is pressed. */
PP.hideControls = function () {
  this._closeMenu();
  clearTimeout(this._idleT);
  this._hiddenAt = Date.now();
  this._recentWake = false;
  this.el.classList.add('idle');
  if (this.el.contains(document.activeElement) && document.activeElement !== this.el) { try { this.el.focus(); } catch (e) {} }
};
PP._wake = function (sticky) {
  var self = this;
  if (this._hiddenAt && Date.now() - this._hiddenAt < 900) return; // (the click or key that hid them)
  this._hiddenAt = 0;
  var wasIdle = this.el.classList.contains('idle');
  this.el.classList.remove('idle');
  this._recentWake = !wasIdle;
  clearTimeout(this._idleT);
  this._idleT = setTimeout(function () {
    if (V.$('.vp-seek.drag', self.host)) return self._wake(sticky); // (the timeline is being dragged: the controls stay)
    if (!self.video.paused && V.$('.vp-menu', self.host).hidden && V.$('.vp-side', self.host).hidden && self.started && !(document.activeElement && document.activeElement.classList.contains('vol'))) { self.el.classList.add('idle'); self._recentWake = false; }
  }, sticky ? 4500 : 2500);
};

// ---------------------------------------------------------------- sleep timer
V._sleepAt = 0;
V.sleepLeft = function () { return V._sleepAt === -1 ? 1 : V._sleepAt ? Math.max(0, V._sleepAt - Date.now()) : 0; };
V.setSleep = function (min) {
  clearTimeout(V._sleepT);
  if (min === -1) { V._sleepAt = -1; V.toast('Stopping at the end of this video'); return; }
  V._sleepAt = min ? Date.now() + min * 60000 : 0;
  clearInterval(V._sleepFade);
  if (min) {
    // The last 30 seconds fade out, then it pauses — and a while later stops, freeing the provider connection.
    V._sleepT = setTimeout(function () {
      var p = V.player; if (!p) return;
      var v0 = p.video.volume, steps = 30;
      V._sleepFade = setInterval(function () {
        steps--;
        p.video.volume = Math.max(0, v0 * steps / 30);
        if (steps > 0) return;
        clearInterval(V._sleepFade);
        V._sleepAt = 0;
        p.video.pause();
        p.video.volume = v0;
        V.toast('Sleep timer: paused');
        V._sleepT = setTimeout(function () { if (V.player.video.paused && V.watch.it) V.closePlayer(); }, 10 * 60000);
      }, 1000);
    }, Math.max(0, min * 60000 - 30000));
    V.toast('Sleep timer: ' + min + ' minutes');
  } else V.toast('Sleep timer off');
};

/** Can the browser's own player handle this MKV (from the provider's codec info)? Chrome and Edge usually can. */
/** What this browser plays by itself (sent to the server so it can pick the copy that needs no conversion). */
V.playCaps = function () {
  var c = V.codecs();
  var MS = window.ManagedMediaSource || window.MediaSource;
  var v = document.createElement('video');
  var ok = function (t) { try { return (MS && MS.isTypeSupported(t)) || v.canPlayType(t) === 'probably'; } catch (e) { return false; } };
  return {
    mkv: V.mkvBrowser(), hevc: c.indexOf('hevc') >= 0, vp9: c.indexOf('vp9') >= 0, av1: c.indexOf('av1') >= 0,
    ac3: ok('audio/mp4; codecs="ac-3"'), eac3: ok('audio/mp4; codecs="ec-3"'), mb: V.mbSupported(),
  };
};
/** Chrome and Edge (not the TV versions) play MKV files themselves. */
V.mkvBrowser = function () {
  if ((V.ls.get('mkvSoundFail', 0) || 0) >= 3) return false; // this device keeps failing: stop trying
  return /Chrome\//.test(navigator.userAgent) && !/SamsungBrowser|Tizen|Web0S|webOS|SMART-TV/i.test(navigator.userAgent);
};
V.mkvPlays = function (c) {
  if (!c || !c.v) return false;
  if (!V.mkvBrowser()) return false;
  var vOk = c.v === 'h264' ? !/10|12|422|444/.test(c.pix || '') : c.v === 'vp9' || c.v === 'av1' ? V.codecs().indexOf(c.v) >= 0 : (c.v === 'hevc' || c.v === 'h265') && V.codecs().indexOf('hevc') >= 0;
  var caps = V._caps || (V._caps = V.playCaps());
  var aOk = !c.a || ['aac', 'mp3', 'opus', 'vorbis', 'flac'].indexOf(c.a) >= 0 || (c.a === 'ac3' && caps.ac3) || (c.a === 'eac3' && caps.eac3);
  return vOk && aOk;
};

/** Move this device to the direct (http) address and carry on playing there. */
V.handoff = function (it, startAt) {
  var k = it.t === 'catchup' ? it.catchupOf : it.k;
  V.player._msg({ spin: true, title: 'Switching to the direct address…' });
  V.api('/api/handoff', { body: { to: '#/play/' + encodeURIComponent(k) + '?t=' + Math.round(startAt || (V.progressOf(k) || {}).p || 0) } }).then(function (r) { location.href = r.url; }).catch(function (e) { V.player._msg({ title: 'Couldn’t switch', sub: e.message, actions: [{ label: 'Play through the server', primary: true, fn: function () { V.player.load(it, { relayOk: true, startAt: startAt }); } }] }); });
};
