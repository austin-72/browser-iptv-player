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
  return function () {
    if (c) return c;
    c = ['h264'];
    var MS = window.ManagedMediaSource || window.MediaSource;
    var v = document.createElement('video');
    var ok = function (t) { try { return (MS && MS.isTypeSupported(t)) || v.canPlayType(t) === 'probably'; } catch (e) { return false; } };
    if (ok('video/mp4; codecs="hvc1.1.6.L93.B0"') || ok('video/mp4; codecs="hev1.1.6.L93.B0"')) c.push('hevc');
    if (ok('video/mp4; codecs="av01.0.05M.08"')) c.push('av1');
    if (ok('video/webm; codecs="vp9"')) c.push('vp9');
    return c;
  };
})();

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
    '  <div class="vp-seekrow"><span class="vp-t1 num"></span><div class="vp-seek" role="slider" tabindex="0" aria-label="Seek"><div class="track"><div class="buf"></div><div class="fill"></div><div class="marks"></div></div><div class="knob"></div><div class="tip"><img alt="" hidden><span></span></div></div><span class="vp-t2 num"></span></div>' +
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
    '    <button class="pbtn" data-a="cc" aria-label="Subtitles and audio" title="Subtitles and audio">' + V.icon('cc') + '</button>' +
    '    <button class="pbtn" data-a="bookmark" aria-label="Bookmark this moment" title="Bookmark">' + V.icon('bookmark') + '</button>' +
    '    <button class="pbtn" data-a="gear" aria-label="Playback settings" title="Settings">' + V.icon('gear') + '</button>' +
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
  if (!opts.quiet) { this.audioTrack = undefined; this._saveProgress(); this._accountWatched(); this._inHistory = false; this.reconnects = 0; this._watchStart = Date.now(); this._watched = 0; this._forced = !!opts.force; this._statFlush(); this._statSig = null; this._statId = null; }
  this._triedDirect = false;
  if (opts.alt === undefined && !opts.quiet) { this.alt = -1; this._altsLeft = S.settings && it.a ? it.a.map(function (x, i) { return i; }) : []; }
  else if (opts.alt !== undefined) this.alt = opts.alt;
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
  this._msg({ spin: true, title: opts.quiet ? 'Reconnecting…' : '' });
  this._wake(true);
  // Which copy to play: one whose provider has a free connection and that this page can play directly.
  var pickSource = !opts.quiet && opts.alt === undefined && !opts.only && !opts.force && !it.offlineUrl && it.t !== 'catchup' && S.conn !== undefined;
  var plan, errs = [];
  // Each way of playing it in turn (direct → through the server → conversion), until one starts.
  var next = function (i) {
    if (token !== self.token) return;
    if (i >= plan.length) return giveUp();
    var a = plan[i];
    return self._attempt(a, token, opts.startAt || 0).then(function () {
      if (token !== self.token) return;
      self.attempt = a;
      self._afterStart();
    }, function (e) {
      if (token !== self.token) return;
      errs.push(e);
      if (a.via === 'direct' || a.via === 'split') self._triedDirect = true;
      console.warn('[player] attempt failed', a.via, a.kind || a.mode, e.message);
      self._teardownMedia();
      // The browser can't decode it: another route to the same bytes won't help — go straight to conversion.
      if (/decode|format|codec/i.test(e.message) && a.via !== 'session') { var rest = plan.slice(i + 1).filter(function (x) { return x.via === 'session' || (x.via === 'browser' && a.via !== 'browser'); }); plan = plan.slice(0, i + 1).concat(rest); }
      // The server said the provider allows this, but it didn't load: have it check again next time.
      if (a.via === 'direct' && !a.native && !a.helper && a.kind !== 'native' && !/decode|format|codec/i.test(e.message)) V.api('/api/play/reach', { body: { k: it.t === 'catchup' ? it.catchupOf : it.k, alt: self.alt, url: it.t === 'catchup' ? it.u : undefined, origin: location.origin, forget: true } }).catch(function () {});
      if (i < plan.length - 1) self._msg({ spin: true, title: plan[i + 1].via === 'relay' ? 'Connecting through the server…' : plan[i + 1].via === 'session' ? 'Converting on the server…' : plan[i + 1].via === 'browser' ? 'Converting in this browser…' : 'Trying another way…' });
      return next(i + 1);
    });
  };
  // The most useful failure: from the server's attempts (it can see the real problem), else the browser's.
  var giveUp = function () {
    var tagged = errs.map(function (e2, i2) { return { e: e2, via: plan[i2] ? plan[i2].via : '' }; });
    var pick = tagged.filter(function (x) { return x.via === 'relay' && !/decode|format/i.test(x.e.message); })[0] || tagged.filter(function (x) { return x.via !== 'direct' && !/decode|format/i.test(x.e.message); })[0] || tagged.filter(function (x) { return !/decode|format/i.test(x.e.message); })[0] || tagged[tagged.length - 1];
    var best = pick && pick.e;
    if (token === self.token) self._failed(best || new Error('This couldn’t be played.'));
  };
  return (pickSource ? this._sources(it, token, opts) : Promise.resolve(true)).then(function (go) {
    if (!go || token !== self.token) return;
    return (opts.only ? Promise.resolve([opts.only]) : self._plan(it, opts.force).then(function (p0) { return opts.quiet || opts.alt !== undefined ? p0 : self._directCopy(it, opts.force, p0); })).then(function (p) {
      plan = p;
      return next(0);
    }, function (e) { if (token === self.token) self._failed(e); });
  });
};

  /** Picks the copy to play (see /api/play/sources). Returns false when it asked the viewer something instead. */
PP._sources = function (it, token, opts) {
  var self = this;
  return (location.protocol === 'https:' && /^http:/i.test(it.u || '') ? V.mixedOk(it.u) : Promise.resolve(false)).then(function (mok) {
    return V.api('/api/play/sources', { body: { k: it.k, origin: location.origin, caps: V._caps || (V._caps = V.playCaps()), mixedOk: mok || undefined } });
  }).then(function (r) { return self._useSources(r, it, token, opts); }, function () { return true; });
};
PP._useSources = function (r, it, token, opts) {
  if (token !== this.token) return false;
  var srcs = r.sources || [];
  if (!srcs.length) return true;
  var self = this;
  if (r.allBusy && !opts.busyOk) {
    var by = [];
    srcs.forEach(function (x) { x.by.forEach(function (b) { if (!by.some(function (y) { return y.conn === b.conn; })) by.push(b); }); });
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
            free.forEach(function (b) { V.api('/api/devices/' + b.conn + '/command', { body: { cmd: 'takeover' } }).catch(function () {}); });
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
    bump.forEach(function (b) { V.api('/api/devices/' + b.conn + '/command', { body: { cmd: 'takeover' } }).catch(function () {}); });
    this._msg({ spin: true, title: 'Taking the connection from ' + names.join(' and ') + '…', sub: 'You have priority.' });
    return new Promise(function (res) { setTimeout(res, 3500); }).then(function () {
      if (token !== self.token) return false;
      self._msg(null);
      srcs[0].bump = [];
      return self._useSources(r, it, token, Object.assign({}, opts, { busyOk: true }));
    });
  }
  var first = srcs[0];
  this.alt = first.alt;
  this._connLimit = first.limit || 0;
  this._busyAlts = srcs.filter(function (x, i) { return x.busy || (i && x.bump && x.bump.length); }).map(function (x) { return x.alt; });
  this._altsLeft = srcs.slice(1).map(function (x) { return x.alt; });
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
  var cands = this._altsLeft.filter(function (x) { return busy.indexOf(x) < 0; }).slice(0, 3); // (not one someone here is already using)
  var token = this.token;
  var at = function (i) {
    if (i >= cands.length || token !== self.token) { self.alt = orig.alt; self.reachInfo = orig.info; self._mixedOk = orig.mok; self.vod = orig.vod; return plan; }
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
  // An http stream on this https page: fine when this browser has been told to allow it for the site.
  return (mixed ? V.mixedOk(url) : Promise.resolve(false)).then(function (mok) {
  if (mok) mixed = false;
  self._mixedOk = mok;
  return V.api('/api/play/reach', { body: { k: key, alt: self.alt, url: it.t === 'catchup' ? url : undefined, origin: location.origin, ua: navigator.userAgent, mixedOk: mok || undefined } }).then(null, function () { return null; }).then(function (info) {
    if (!info) return fallback();
    // (A server from before it knew about this still says "blocked": go by what the browser said.)
    if (info.blocked === 'mixed' && mok) { self.reachInfo = info; return fallback(); }
    {
      self.reachInfo = info;
      if (info.finite) self.vod = it.t !== 'live';
      if (!info.blocked && info.kind !== 'ffmpeg') plan = self._directRoutes(info, it);
      // MKV films whose codecs this browser decodes (Chrome, Edge): try the browser's own player first.
      if (info.kind === 'ffmpeg' && !info.blocked && V.mkvPlays(info.codecs)) plan = [{ via: 'direct', kind: 'native', url: info.url || url, mkv: true }];
      // Files the provider lets this page read: this browser can convert them itself (MKV, AC-3 sound…) before the
      // server has to.
      // (For files the server doesn't ask whether the page may read them — a <video> doesn't need it — so the
      // conversion finds out itself, at once.)
      if (!info.blocked && !q && V.mbSupported() && (it.t === 'movie' || it.t === 'episode' || (info.finite && it.t !== 'live' && it.t !== 'radio')) && (info.kind === 'ffmpeg' || info.kind === 'native' || (info.kind === 'ts' && info.mse))) plan.push({ via: 'browser', kind: 'mb', url: info.url || url });
      if (info.kind === 'ffmpeg') return plan.concat(routing === 'direct-only' ? [] : sessions);
      if (routing === 'direct-only') {
        if (!plan.length) throw new Error(info.blocked === 'headers' ? 'This channel needs special headers that browsers can’t send. Ask the admin to allow playback through the server.' : info.blocked === 'mixed' ? 'This page is https but the stream is plain http, which browsers block. Ask the admin to allow playback through the server.' : 'The provider doesn’t let browsers play this directly. Ask the admin to allow playback through the server.');
        return plan;
      }
      plan.push({ via: 'relay', kind: info.kind === 'dash' ? 'dash' : '?', url: url });
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
  var direct = routing !== 'server' && !hasHeaders && !mixed && (g !== 'ffmpeg');
  if (g === 'dash') {
    if (direct) plan.push({ via: 'direct', kind: 'dash', url: url });
    if (routing !== 'direct-only') plan.push({ via: 'relay', kind: 'dash', url: url });
    if (!it.dr && routing !== 'direct-only') plan = plan.concat(sessions);
    return plan;
  }
  // No file extension: ask the server what it is (it reads only the first bytes), then connect directly.
  var sniff = direct && g === 'unknown' ? V.api('/api/play/relay', { body: { k: it.t === 'catchup' ? it.catchupOf : it.k, alt: this.alt, url: it.t === 'catchup' ? url : undefined, sniff: true } }).then(function (sn) {
    if (sn.finite) self.vod = it.t !== 'live';
    g = { hls: 'hls', ts: 'ts', native: 'native', dash: 'dash', ffmpeg: 'ffmpeg' }[sn.kind] || 'unknown';
    if (g === 'ffmpeg') direct = false;
  }, function () {}) : Promise.resolve();
  return sniff.then(function () {
  if (direct) {
    var order = { hls: ['hls'], ts: ['ts'], native: ['native'], dash: ['dash'], unknown: ['ts', 'hls', 'native'] }[g] || ['native'];
    order.forEach(function (k) { plan.push({ via: 'direct', kind: k, url: url }); });
  }
  if (routing !== 'server' && !hasHeaders && !mixed && (g === 'ffmpeg' || g === 'native') && self.vod && !self._quality() && V.mbSupported()) plan.push({ via: 'browser', kind: 'mb', url: url });
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
  return new Promise(function (resolve, reject) {
    var v = self.video;
    var done = false;
    var cleanup = function () { clearTimeout(timer); v.removeEventListener('playing', ok); v.removeEventListener('error', onErr); v.removeEventListener('canplay', onCanPlay); self._failNow = null; };
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
    var fail = function (e) { if (!done) { done = true; cleanup(); reject(e instanceof Error ? e : new Error(String(e))); } };
    var onErr = function () { fail(new Error(self._mediaErr())); };
    var onCanPlay = function () { if (self._blocked) ok(); };
    v.addEventListener('playing', ok);
    v.addEventListener('error', onErr);
    v.addEventListener('canplay', onCanPlay);
    // Direct attempts give up quickly so the server can take over.
    var timer = setTimeout(function () { fail(new Error('It didn’t start in time.')); }, a.via === 'session' ? 60000 : a.via === 'browser' ? 45000 : a.via === 'direct' || a.via === 'split' ? 12000 : 25000);
    self._failNow = fail;
    self._attach(a, token, startAt).catch(fail);
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
PP._attach = function (a, token, startAt) {
  var self = this;
  if (this._audioSrc && (a.via === 'direct') && a.kind === 'native') this._replaceVideo();
  this.offset = 0;
  this.sessionDuration = 0;
  this.attemptVia = a.via;
  var it = this.it;
  var src = it.t === 'catchup' ? it.u : null;
  var go = { kind: a.kind, url: a.url };
  var prep = Promise.resolve(go);
  if (a.via === 'relay') {
    prep = V.api('/api/play/relay', { body: { k: it.t === 'catchup' ? it.catchupOf : it.k, alt: this.alt, url: src || undefined, sniff: go.kind === '?' } }).then(function (r) {
      if (token !== self.token) return null;
      go.url = r.url;
      if (go.kind === '?') {
        if (r.finite) self.vod = true;
        go.kind = { hls: 'hls', ts: 'ts', native: 'native', dash: 'dash' }[r.kind];
        if (!go.kind) throw new Error('This format needs converting.');
      }
      if (go.kind === 'dash') go.url = self.url;
      return go;
    });
  } else if (a.via === 'session') {
    var body = { k: it.t === 'catchup' ? it.catchupOf : it.k, alt: this.alt, url: src || undefined, mode: a.mode, seek: this.vod ? startAt : 0, live: !this.vod, codecs: V.codecs(), height: a.height || this._quality() || 0, audio: this.audioTrack === undefined || this.audioTrack === null ? undefined : this.audioTrack, audioLang: V.pref('audioLang') || ((S.profile && S.profile.langs) || [])[0] || '' };
    prep = V.api('/api/play/session', { body: body }).then(function (s) {
      if (token !== self.token) { V.api('/api/session/' + s.sessionId, { method: 'DELETE' }).catch(function () {}); return null; }
      self.sessionId = s.sessionId;
      if (self.audioTrack === undefined && s.audioTrack !== undefined) self.audioTrack = s.audioTrack;
      self.sessionInfo = s;
      self.offset = s.offset || 0;
      self.sessionDuration = s.duration || 0;
      if (s.duration) self.vod = true;
      go.kind = 'hls'; go.url = s.url;
      var sid = s.sessionId;
      self._pinger = setInterval(function () { V.api('/api/session/' + sid + '/ping', { method: 'POST' }).catch(function () {}); }, 15000);
      return go;
    });
  }
  return prep.then(function (g) { if (g) return self._attachMedia(a, token, startAt, g.kind, g.url); });
};
PP._attachMedia = function (a, token, startAt, kind, url) {
  var self = this, v = this.video, it = this.it;
  var rel = Math.max(0, (startAt || 0) - this.offset - (it.startOffset || 0));
  var bufGoal = V.pref('dataSaver') ? 15 : 30;
  if (kind === 'hls' && a.native) {
    v.src = url;
    if (rel > 0) v.addEventListener('loadedmetadata', function () { v.currentTime = rel; }, { once: true });
  } else if (kind === 'hls') {
    return (window.Hls ? Promise.resolve() : V.loadScript('/vendor/hls.min.js').catch(function () {})).then(function () { return self._attachHls(a, token, url, rel, bufGoal); });
  } else if (kind === 'ts') {
    return (window.mpegts ? Promise.resolve() : V.loadScript('/vendor/mpegts.js')).then(function () { return self._attachTs(url); });
  } else if (kind === 'dash') {
    return this._attachDash(url, rel, bufGoal, a.via === 'relay' ? 'all' : a.via === 'split' ? 'manifest' : '', token).then(function () { if (token === self.token) self._play(); });
  } else if (kind === 'mb') {
    var lim = this._connLimit || 0;
    return V.mbStart(v, url, this.vod ? (startAt || 0) : 0, {
      parallel: lim && lim <= 2 ? 1 : 2,
      audioTrack: this.audioTrack === undefined || this.audioTrack === null ? -1 : this.audioTrack,
      lang: V.pref('audioLang') || ((S.profile && S.profile.langs) || [])[0] || '',
      onError: function (e) { if (token === self.token) self._fatal(new Error('The conversion in this browser stopped (' + (e && e.message || e) + ').')); },
    }).then(function (ctl) {
      if (token !== self.token) { ctl.stop(); return; }
      self.mb = ctl;
      if (ctl.audioTrack >= 0) self.audioTrack = ctl.audioTrack;
      self.offset = ctl.offset;
      self.sessionDuration = ctl.duration || 0;
      self._play();
    });
  } else {
    v.src = url;
    if (rel > 0) v.addEventListener('loadedmetadata', function () { v.currentTime = rel; }, { once: true });
  }
  this._play();
};
PP._attachHls = function (a, token, url, rel, bufGoal) {
  var v = this.video;
  {
    if (window.Hls && Hls.isSupported()) {
      var q = this._quality();
      var hls = new Hls({
        enableWorker: true, maxBufferLength: bufGoal, backBufferLength: 60, startPosition: this.vod && rel > 0 ? rel : -1,
        manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 4, fragLoadingMaxRetry: 6, capLevelToPlayerSize: true,
        lowLatencyMode: false, abrEwmaDefaultEstimate: V.pref('dataSaver') ? 800000 : 3000000,
      });
      this.hls = hls;
      var self = this;
      hls.on(Hls.Events.ERROR, function (_, d) { self._hlsError(d); });
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
      v.src = url;
      if (rel > 0) v.addEventListener('loadedmetadata', function () { v.currentTime = rel; }, { once: true });
    } else throw new Error('This browser can’t play HLS streams.');
  }
  this._play();
};
PP._attachTs = function (url) {
  var v = this.video;
  {
    if (!(window.mpegts && mpegts.getFeatureList().mseLivePlayback)) throw new Error('This browser can’t play MPEG-TS streams.');
    var self2 = this;
    var p = mpegts.createPlayer({ type: 'mpegts', isLive: !this.vod, url: new URL(url, location.href).href }, {
      enableWorker: true, lazyLoad: false, autoCleanupSourceBuffer: true,
      liveBufferLatencyChasing: !this.vod, liveBufferLatencyMaxLatency: 12, liveBufferLatencyMinRemain: 3,
    });
    p.on(mpegts.Events.ERROR, function (type, detail, info) { self2._fatal(new Error(self2._mtsErr(type, detail, info))); });
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

PP._attachDash = function (url, rel, bufGoal, viaServer, token) {
  var self = this;
  return (window.shaka ? Promise.resolve() : V.loadScript('/vendor/shaka-player.compiled.js')).then(function () {
    if (!self._shakaReady) { shaka.polyfill.installAll(); self._shakaReady = true; }
    if (!shaka.Player.isBrowserSupported()) throw new Error('This browser can’t play DASH streams.');
    var gone = self._shakaGone || Promise.resolve();
    self._shakaGone = null;
    return gone;
  }).then(function () {
    if (token !== self.token) return;
    var sp = new shaka.Player();
    self.shaka = sp;
    return Promise.resolve(sp.attach(self.video)).then(function () { return self._shakaLoad(sp, url, rel, bufGoal, viaServer, token); });
  });
};
PP._shakaLoad = function (sp, url, rel, bufGoal, viaServer, token) {
  var it = this.it;
  var cfg = { streaming: { bufferingGoal: bufGoal, rebufferingGoal: 2, retryParameters: { maxAttempts: 4, timeout: 20000 } }, manifest: { retryParameters: { maxAttempts: 2, timeout: 20000 } } };
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
  sp.addEventListener('error', function (ev) { self._fatal(new Error(self._shakaErr(ev.detail))); });
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
PP._hlsError = function (d) {
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
  this._fatal(new Error(msg));
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
  if (!this.vod && this.reconnects < 4) {
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

  /** Everything failed for this stream: try a backup stream if the channel has one. */
PP._failed = function (err) {
  if (this._altsLeft && this._altsLeft.length) {
    var next = this._altsLeft.shift();
    var total = (this.it.a || []).length + 1;
    this._msg({ spin: true, title: 'Trying backup stream ' + (next + 2) + ' of ' + total + '…' });
    var tok = this.token, it = this.it;
    var me = this;
    setTimeout(function () { if (tok === me.token) me.load(it, { alt: next, quiet: true }); }, 400);
    return;
  }
  this._error(err);
};

PP._afterStart = function () {
  this.started = true;
  this._msg(null);
  var vod = this.vod;
  var lb = V.$('[data-a=golive]', this.host);
  lb.hidden = vod && this.it.t !== 'catchup';
  if (this.it.t === 'catchup') { lb.textContent = 'Back to live'; lb.classList.add('behind'); }
  else lb.textContent = 'Live';
  this.el.classList.toggle('is-live', !vod);
  this._menuRefresh();
  if (this.boost !== 1) this.setBoost(this.boost, true);
  if (this.statsOn) this._statsTick();
  var sp = V.pref('speed');
  if (vod && sp && sp !== 1) this.video.playbackRate = sp;
  this._pickLangs();
  this._loadExtras();
  this._checkSound();
  if (this._routeReason(this._routeName(this.attempt)) === 'https' || (this.attempt && this.attempt.via === 'session' && location.protocol === 'https:' && /^http:/i.test(this.url) && !this._mixedOk)) V.mixedTip();
  if (this.onPlaying) this.onPlaying(this);
  V.rt.presence({ k: this.it.t === 'catchup' ? this.it.catchupOf : this.it.k, n: this.it.n, pos: this.vod ? this.position : 0, alt: this.alt, force: true });
  this._mediaSession();
  this._wakeLock(true);
  this._statStart();
};

  /**
   * Playing straight from the provider with the browser's own player: when the picture plays but no sound is decoded
   * (AC-3/DTS audio in an MKV or MP4), switch to the server's conversion at the same spot.
   */
PP._checkSound = function () {
  var a = this.attempt, v = this.video, tok = this.token, self = this;
  if (!a || a.via !== 'direct' || a.kind !== 'native' || !this.vod || v.webkitAudioDecodedByteCount === undefined) return;
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
  return { split: 'split', relay: 'relay', session: 'convert', local: 'local' }[a.via] || '';
};
  /** Why a stream went through the server. */
PP._routeReason = function (route) {
  if (route === 'local') return 'library';
  if (route === 'convert') return this._forced || this._quality() ? 'chosen' : 'format';
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
  V.api('/api/stats/play', { body: { k: k, alt: this.alt, route: route, reason: this._routeReason(route), host: location.host } }).then(function (r) { if (self._statSig === sig) self._statId = r.id; }).catch(function () {});
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
  this._teardownMedia();
  if (this.it && !this.it.offlineUrl) V.api('/api/stats/play', { body: { k: this.it.t === 'catchup' ? this.it.catchupOf : this.it.k, failed: true } }).catch(function () {});
  var me = this;
  var acts = [{ label: 'Try again', primary: true, fn: function () { me.load(me.it, { startAt: me.vod ? me._lastPos || 0 : 0 }); } }];
  // (Converting doesn't help when the server can't reach the stream at all.)
  if (S.settings.ffmpeg && !(this.attempt && this.attempt.via === 'session') && !/couldn.t reach|provider/i.test(err.message || '')) acts.push({ label: 'Convert on the server', fn: function () { me.load(me.it, { force: 'transcode', startAt: me._lastPos || 0 }); } });
  // A channel that's down: one press to the next one.
  if (this.it && (this.it.t === 'live' || this.it.t === 'radio') && V.zap) acts.push({ label: 'Next channel', fn: function () { V.zap(1); } });
  var sub = err.message;
  this._msg({ title: 'Can’t play this right now', sub: sub, actions: acts });
  V.announce('Playback failed: ' + sub);
};

PP._msg = function (m) {
  var box = V.$('.vp-msg', this.host);
  if (!m) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<div>' + (m.spin ? '<div class="spinner" role="progressbar" aria-label="Loading"></div>' : '') + (m.title ? '<div class="t">' + V.esc(m.title) + '</div>' : '') + (m.sub ? '<div class="s">' + V.esc(m.sub) + '</div>' : '') + '<div class="acts"></div></div>';
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
  if (this.hls) { try { this.hls.destroy(); } catch (e) {} this.hls = null; }
  if (this.mts) { try { this.mts.pause(); this.mts.unload(); this.mts.detachMediaElement(); this.mts.destroy(); } catch (e) {} this.mts = null; }
  if (this.shaka) { var sp = this.shaka; this.shaka = null; this._shakaGone = sp.destroy().catch(function () {}); }
  clearInterval(this._pinger);
  if (this.sessionId) { V.api('/api/session/' + this.sessionId, { method: 'DELETE', keepalive: true }).catch(function () {}); this.sessionId = null; }
  if (this.mb) { this.mb.stop(); this.mb = null; }
  var v = this.video;
  try { v.pause(); } catch (e) {}
  V.$$('track', v).forEach(function (t) { t.remove(); });
  v.removeAttribute('src');
  try { v.load(); } catch (e) {}
  this._netRetry = this._mediaRetry = false;
};

PP._teardown = function () {
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
  return end - start >= 60 ? { start: start, end: end } : null;
} });

PP.seek = function (t, fromRemote) {
  if (!this.started) return;
  var v = this.video;
  if (!this.vod) { var w = this.liveWindow; if (w) v.currentTime = V.clamp(t, w.start, w.end - 2); return; }
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
  if (!this.vod && this.liveWindow) this.seek(this.video.currentTime + d);
  else this.seek(this.position + d);
  this.osd((d > 0 ? '+' : '−') + Math.abs(d) + ' s', 900, 'skipfx');
};
PP.goLive = function () {
  if (this.it && this.it.t === 'catchup') { if (this.onBackToLive) this.onBackToLive(this.it); return; }
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
  else if (this.video.webkitEnterFullscreen) this.video.webkitEnterFullscreen();
};
PP.togglePip = function () {
  var v = this.video;
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(function () {});
  else if (v.requestPictureInPicture) v.requestPictureInPicture().catch(V.fail);
  else if (v.webkitSetPresentationMode) v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
};
PP.setRate = function (r) { this.video.playbackRate = r; V.setPref('speed', r); this.osd('Speed ' + (r === 1 ? 'normal' : r + '×'), 1000); if (this.onUserAction) this.onUserAction('rate'); };
PP.step = function (dir) { var v = this.video; if (!this.vod) return; v.pause(); v.currentTime = Math.max(0, v.currentTime + dir / 25); };

  /** Louder than 100% through Web Audio (only for streams the browser may process). */
PP.setBoost = function (x, quietly) {
  var a = this.attempt;
  var safe = !a || a.via !== 'direct' || a.kind !== 'native';
  if (x !== 1 && !safe) { if (!quietly) V.toast('Volume boost isn’t possible for this stream. Reload it through the server to use it.', { error: true }); return; }
  this.boost = x;
  if (x === 1 && !this._audioSrc) return;
  try {
    if (!this._audioSrc) {
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
  el.textContent = '.vp video::cue { font-size: ' + Math.round((st.size || 100) * 0.032 * 100) / 100 + 'em; color: ' + st.color + '; background: ' + st.bg + '; text-shadow: ' + edge + '; font-family: ' + font + '; line-height: 1.25; }' +
    '.vp { --cue-scale: ' + (st.size || 100) / 100 + '; }';
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
  } catch (e) { V.toast('This stream doesn’t allow screenshots.', { error: true }); }
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
    V.api('/api/probe/' + encodeURIComponent(it.k) + '?alt=' + this.alt).then(function (p) { if (tok === me.token) { me._fileTracks = { audio: me.mb ? me.mb.audioTracks || [] : p.audio || [], subs: (p.subs || []).filter(function (s) { return s.text; }) }; me._menuRefresh(); me._autoSubs(); } }).catch(function () {});
  } else if (this.mb) this._fileTracks = { audio: this.mb.audioTracks || [], subs: [] };
  if (this.sessionInfo) this._autoSubs();
  if (it.t === 'episode' || it.t === 'movie') {
    var me2 = this;
    V.api('/api/markers/' + encodeURIComponent(it.k)).then(function (m) { if (tok === me2.token) { me2.markers = m; me2._drawMarks(); } }).catch(function () {});
  }
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
  tr.src = '/api/subs/' + encodeURIComponent(this.it.k) + '/' + i + '?alt=' + this.alt + (this.sessionId && this.offset ? '&offset=' + this.offset : '');
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
    if (tr.subs) { main.push({ label: 'Subtitles', value: tr.subs.value, page: 'subs' }); pages.subs = tr.subs.items; } else main.push({ label: 'Subtitles', value: 'None', fn: function () {} });
    if (tr.audio) { main.push({ label: 'Audio', value: tr.audio.value, page: 'audio' }); pages.audio = tr.audio.items; }
    main.push({ label: 'Subtitle style', value: '', fn: function () { V.subtitleStyleDialog(); } });
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
  main.push({ label: 'Volume boost', value: this.boost === 1 ? 'Off' : Math.round(this.boost * 100) + '%', page: 'boost' });
  pages.boost = [1, 1.5, 2, 3].map(function (x) { return { label: x === 1 ? 'Off' : Math.round(x * 100) + '%', on: self.boost === x, fn: function () { self.setBoost(x); } }; });
  var left = V.sleepLeft();
  main.push({ label: 'Sleep timer', value: left ? Math.ceil(left / 60000) + ' min left' : 'Off', page: 'sleep' });
  pages.sleep = [0, 15, 30, 45, 60, 90, 120].map(function (m) { return { label: m ? m + ' minutes' : 'Off', on: m === 0 ? !left : false, fn: function () { V.setSleep(m); } }; }).concat(this.vod ? [{ label: 'End of this video', fn: function () { V.setSleep(-1); } }] : []);
  if (this.it && this.it.a && this.it.a.length) {
    main.push({ label: 'Source', value: this.alt >= 0 ? 'Backup ' + (this.alt + 1) : 'Main', page: 'alts' });
    pages.alts = [{ label: 'Main', on: this.alt < 0, fn: function () { self.load(self.it, { alt: -1, startAt: self.vod ? self.position : 0 }); } }].concat(this.it.a.map(function (x, i) { var host = ''; try { host = new URL(x.u).host; } catch (e) {} return { label: 'Backup ' + (i + 1) + (host ? ' · ' + host : ''), on: self.alt === i, fn: function () { self.load(self.it, { alt: i, startAt: self.vod ? self.position : 0 }); } }; }));
  }
  if (S.settings.ffmpeg && this.it) main.push({ label: 'Convert on the server', value: this.attempt && this.attempt.via === 'session' ? 'On' : 'Off', fn: function () { self.load(self.it, { force: 'transcode', startAt: self.vod ? self.position : 0, alt: self.alt }); } });
  if (this.it && this.vod && (this.it.t === 'episode' || this.it.t === 'movie')) main.push({ label: 'Mark intro / credits', value: '', fn: function () { V.markersDialog(self); } });
  main.push({ label: 'Screenshot', value: '', fn: function () { self.screenshot(); } });
  main.push({ label: 'Stream info', value: this.statsOn ? 'On' : 'Off', fn: function () { self.toggleStats(); } });
  if (this.it) main.push({ label: 'Reload', value: '', fn: function () { self.load(self.it, { startAt: self.vod ? self.position : 0, alt: self.alt }); } });
  pages.main = main;
  return pages;
};

PP._openMenu = function (page, kind) {
  var m = V.$('.vp-menu', this.host);
  kind = kind || this._menuKind || 'gear';
  this._menuKind = kind;
  var pages = this._menuPages(kind);
  var items = pages[page] || pages.main;
  this._menuPage = page || 'main';
  m.hidden = false;
  var parent = this._menuPage.indexOf('adj-') === 0 ? 'adjust' : 'main';
  var back = this._menuPage !== 'main' ? '<button class="mi back" data-back="' + parent + '">' + V.icon('back') + '<span>Back</span></button>' : '';
  var radio = this._menuPage !== 'main' && this._menuPage !== 'adjust';
  m.innerHTML = back + items.map(function (it, i) {
    return '<button class="mi" data-i="' + i + '" role="' + (radio ? 'menuitemradio' : 'menuitem') + '"' + (radio ? ' aria-checked="' + !!it.on + '"' : '') + '>' + (radio ? '<span class="dot">' + (it.on ? V.icon('check') : '') + '</span>' : '') + '<span class="ml">' + V.esc(it.label) + '</span>' + (it.value !== undefined && it.value !== '' ? '<span class="mv">' + V.esc(it.value) + '</span>' : '') + (it.page ? V.icon('next') : '') + '</button>';
  }).join('');
  var self = this;
  m.onclick = function (e) {
    e.stopPropagation();
    var bk = e.target.closest('[data-back]');
    if (bk) return self._openMenu(bk.dataset.back);
    var b = e.target.closest('[data-i]');
    if (!b) return;
    var it = items[+b.dataset.i];
    if (it.page) return self._openMenu(it.page);
    it.fn();
    if (self._menuPage === 'main') self._closeMenu(); else self._openMenu(it.back || parent);
  };
  var first = V.$('.mi[aria-checked=true]', m) || V.$('.mi', m);
  if (first) first.focus();
};
PP._menuRefresh = function () { var m = V.$('.vp-menu', this.host); if (m && !m.hidden) this._openMenu(this._menuPage); this._ccButton(); };
PP._closeMenu = function () { var m = V.$('.vp-menu', this.host); if (m && !m.hidden) { m.hidden = true; var b = V.$('[data-a=' + (this._menuKind === 'cc' ? 'cc' : 'gear') + ']', this.host); if (b && this.el.contains(document.activeElement)) b.focus(); } };
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
    t2.textContent = tot ? '−' + V.fmtDur(Math.max(0, tot - pos)) : '';
    seek.hidden = !tot;
    if (tot) {
      var f = V.clamp(pos / tot, 0, 1);
      V.$('.fill', seek).style.width = f * 100 + '%';
      V.$('.knob', seek).style.left = f * 100 + '%';
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
  old.replaceWith(nv);
  this.video = nv;
  this._audioSrc = null; this._gain = null; this.boost = 1;
  this._applyFit();
  this._bindVideo(nv);
};

PP._mediaSession = function () {
  if (!('mediaSession' in navigator) || !this.it) return;
  var it = this.it, self = this;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: it.t === 'episode' ? (it.et || it.n) : it.n, artist: it.t === 'episode' ? ((V.showOf(it) || {}).n || '') + ' ' + V.epLabel(it) : (S.settings.brand || {}).name || '', artwork: it.i ? [{ src: it.i, sizes: '512x512' }] : [] });
    navigator.mediaSession.setActionHandler('play', function () { self.video.play(); });
    navigator.mediaSession.setActionHandler('pause', function () { self.video.pause(); });
    navigator.mediaSession.setActionHandler('seekbackward', function () { self.skip(-10); });
    navigator.mediaSession.setActionHandler('seekforward', function () { self.skip(30); });
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
  v.addEventListener('volumechange', function () { self._volUi(); });
  v.addEventListener('play', function () { V.$('[data-a=play]', h).innerHTML = V.icon('pause'); V.$('[data-a=play]', h).setAttribute('aria-label', 'Pause'); self.el.classList.remove('paused'); self._wakeLock(true); });
  v.addEventListener('pause', function () { V.$('[data-a=play]', h).innerHTML = V.icon('play'); V.$('[data-a=play]', h).setAttribute('aria-label', 'Play'); self.el.classList.add('paused'); self._saveProgress(); self._wake(true); });
  v.addEventListener('playing', function () { if (self.started) self._msg(null); self._stallAt = 0; });
  v.addEventListener('waiting', function () { if (self.started) { self._msg({ spin: true }); self._stallAt = Date.now(); } });
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
  v.addEventListener('error', function () { if (self.started && !self._failNow && self.video === v) self._fatal(new Error(self._mediaErr())); });
  v.addEventListener('enterpictureinpicture', function () { self.el.classList.add('pip'); });
  v.addEventListener('leavepictureinpicture', function () { self.el.classList.remove('pip'); });
};

PP._bind = function () {
  var h = this.host, self = this;
  h.addEventListener('click', function (e) {
    var b = e.target.closest('[data-a]');
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
    else if (a === 'rw') self.skip(-10);
    else if (a === 'ff') self.skip(30);
    else if (a === 'mute') self.toggleMute();
    else if (a === 'fs') self.toggleFullscreen();
    else if (a === 'pip') self.togglePip();
    else if (a === 'golive') self.goLive();
    else if (a === 'stats-x') self.toggleStats(false);
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
    var src = '/api/frame/' + encodeURIComponent(self.it.k) + '?t=' + Math.round(t / 10) * 10 + '&w=240';
    var k0 = self.it.k;
    tipImg.onload = function () { tipImg.hidden = false; self._frameFails = 0; };
    tipImg.onerror = function () { tipImg.hidden = true; self._frameFails = (self._frameFails || 0) + 1; if (self._frameFails >= 2) self._noFrames = k0; };
    if (tipImg.getAttribute('src') !== src) tipImg.src = src;
  }, 180);
  seek.addEventListener('pointermove', function (e) {
    var t = at(e);
    tipT.textContent = self.vod ? V.fmtDur(t) : (self.liveWindow ? '−' + V.fmtDur(self.liveWindow.end - t) : '');
    var r = seek.getBoundingClientRect();
    tip.style.left = V.clamp(e.clientX - r.left, 60, r.width - 60) + 'px';
    if (e.pointerType === 'mouse' || drag) frameReq(t);
    if (drag) { var f = V.clamp((e.clientX - r.left) / r.width, 0, 1); V.$('.fill', seek).style.width = f * 100 + '%'; V.$('.knob', seek).style.left = f * 100 + '%'; }
  });
  seek.addEventListener('pointerleave', function () { tipImg.hidden = true; });
  var drag = false;
  seek.addEventListener('pointerdown', function (e) { drag = true; seek.classList.add('drag'); seek.setPointerCapture(e.pointerId); });
  seek.addEventListener('pointerup', function (e) { if (drag) { drag = false; seek.classList.remove('drag'); tipImg.hidden = true; self.seek(at(e)); } });
  seek.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); self.skip(e.shiftKey ? -60 : -10); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); self.skip(e.shiftKey ? 60 : 10); }
    else if (e.key === 'Home') { e.preventDefault(); self.seek(0); }
    else if (e.key === 'End' && self.vod) { e.preventDefault(); self.seek(self.duration - 5); }
  });

  // Touch: double-tap sides to skip, swipe up/down on live TV to change channel.
  var sw = null, lastTap = 0;
  this.el.addEventListener('pointerdown', function (e) {
    if (e.pointerType !== 'touch' || e.target.closest('.vp-ctrl, .vp-menu, .vp-top, .vp-msg button, .vp-side, .vp-skip, .vp-upnext')) return;
    sw = { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  this.el.addEventListener('pointerup', function (e) {
    if (!sw || e.pointerType !== 'touch') return;
    var dx = e.clientX - sw.x, dy = e.clientY - sw.y, dt = Date.now() - sw.t;
    sw = null;
    if (dt > 700) return;
    if (Math.abs(dy) > 60 && Math.abs(dx) < 50 && self.onSwipe) { self._swiped = true; self.onSwipe(dy < 0 ? 'up' : 'down'); return; }
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && self.vod && self.started) {
      var now = Date.now();
      if (now - lastTap < 320) { var r = self.el.getBoundingClientRect(); var x = (e.clientX - r.left) / r.width; if (x < 0.35) { self._swiped = true; self.skip(-10); } else if (x > 0.65) { self._swiped = true; self.skip(10); } lastTap = 0; } else lastTap = now;
    }
  });
  var wake = function () { self._wake(); };
  this.el.addEventListener('mousemove', wake);
  this.el.addEventListener('touchstart', wake, { passive: true });
  this.el.addEventListener('focusin', wake);
  this.el.addEventListener('mouseleave', function () { if (!self.video.paused && V.$('.vp-menu', h).hidden) self.el.classList.add('idle'); });
};

PP._wake = function (sticky) {
  var self = this;
  var wasIdle = this.el.classList.contains('idle');
  this.el.classList.remove('idle');
  this._recentWake = !wasIdle;
  clearTimeout(this._idleT);
  this._idleT = setTimeout(function () {
    if (!self.video.paused && V.$('.vp-menu', self.host).hidden && V.$('.vp-side', self.host).hidden && self.started && !(document.activeElement && document.activeElement.classList.contains('vol'))) { self.el.classList.add('idle'); self._recentWake = false; }
  }, sticky ? 5000 : 3200);
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
