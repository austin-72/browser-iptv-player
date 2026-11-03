/* Subtitles and captions on live channels.
   - Closed captions (CEA-608) inside HLS video: hls.js reads them into text tracks; they're listed in the Subtitles
     menu next to the stream's own subtitle tracks (and turned on by themselves when the profile wants subtitles).
     Browsers with their own HLS player (Safari, TVs) list theirs the same way.
   - Raw MPEG-TS channels played with mpegts.js: DVB subtitles (pictures, drawn by picsubs.js), teletext subtitles
     (text) and PGS — mpegts.js hands their packets over as they arrive, with the channel's own list of them.
   - Channels the server converts anyway: their DVB / teletext subtitle streams are copied aside by the same ffmpeg
     (no extra work, no extra connection) and fetched from /api/session/<id>/subs.
   Captions inside a raw MPEG-TS channel can't be read here: mpegts.js doesn't pass them on. */
'use strict';
(function () {
  var PP = V.Player.prototype, D = V.picdec;
  if (!D) return;
  var isLive = function (p) { return p.it && (p.it.t === 'live' || p.it.t === 'catchup') && !p.vod; };
  var lname = function (l) { return V.langName(l) || (l ? String(l).toUpperCase() : ''); };

  // ---------------------------------------------------------------- live tracks (any source)
  /** The live subtitle tracks of the stream now playing: p._live = { tracks: [...], byPid: { pid: [tracks] } }. */
  function live(p) { return p._live || (p._live = { tracks: [], byPid: {}, seen: {} }); }
  /** A stream (pid) announced with its descriptors: adds a track per language / teletext page. */
  V.liveSubsAnnounce = function (p, pid, list, clock) {
    var L = live(p);
    if (L.seen[pid]) return;
    L.seen[pid] = true;
    list.forEach(function (x) {
      var tr;
      if (x.kind === 'ttx') {
        tr = { kind: 'ttx', dec: new D.Ttx(x.page), ents: [], label: lname(x.lang) + ' · teletext ' + (x.page >> 8) + ('0' + (x.page & 255).toString(16)).slice(-2) + (x.hi ? ' (hard of hearing)' : ''), lang: x.lang };
      } else {
        tr = new V.PicTrack({ kind: x.kind, label: (lname(x.lang) || 'Subtitles') + (x.hi ?' (hard of hearing)' : ''), lang: x.lang });
        if (x.kind === 'dvb' && (x.comp || x.anc)) tr.pages = { comp: x.comp, anc: x.anc };
      }
      tr.pid = pid; tr.clock = clock; tr.live = true;
      L.tracks.push(tr);
      (L.byPid[pid] || (L.byPid[pid] = [])).push(tr);
    });
    // Reconnected: the track that was on comes back on.
    var again = p._liveWant && L.tracks.filter(function (t) { return t.label === p._liveWant; })[0];
    if (again && !p._pic) p.picSub(again.kind === 'ttx' ? ttxTrack(again) : again);
    p._menuRefresh();
    autoPick(p);
  };
  /** A packet for a stream: t is in the video's own time (s). */
  V.liveSubsPacket = function (p, pid, t, data) {
    var trs = p._live && p._live.byPid[pid];
    if (!trs) return;
    for (var i = 0; i < trs.length; i++) {
      var tr = trs[i];
      if (tr.kind === 'ttx') {
        // (Followed even while it isn't shown — only the few subtitle pages the channel lists, very little work — so
        // what's already buffered ahead is there the moment it's turned on.)
        var ev = tr.dec.feed(data);
        for (var k = 0; k < ev.length; k++) addText(tr, t, ev[k].text);
      } else {
        var f = tr.kind === 'pgs' ? flagsPgs(data) : flagsDvb(data);
        tr.add({ t: t, d: 0, f: f, data: data });
      }
    }
  };
  function addText(tr, t, text) {
    var n = tr.ents.length;
    if (n && tr.ents[n - 1].text === text) return;
    if (n && t < tr.ents[n - 1].t - 5) tr.ents = [];
    tr.ents.push({ t: t, text: text });
    if (tr.ents.length > 3000) tr.ents = tr.ents.slice(1000);
  }
  function flagsPgs(b) { var x = D.pgsInfo(b); return x ? ((x.state & 0xC0) ? 2 : 0) | (x.objects ? 0 : 4) : 0; }
  function flagsDvb(b) { var x = D.dvbInfo(b); return x ? (x.state ? 2 : 0) | (x.regions ? 0 : 4) : 0; }

  // ---------------------------------------------------------------- closed captions: a little smaller
  // CEA-608 captions are laid out on a 32-column grid, so at the full subtitle size they wrap a lot. While captions
  // show, they're drawn at 70% of the subtitle size (still following Subtitle style).
  function capStyle() {
    var st = V.pref('subStyle') || {};
    var el = V.$('#cc-size-style') || document.head.appendChild(Object.assign(document.createElement('style'), { id: 'cc-size-style' }));
    el.textContent = '.vp.cc-on video::cue { font-size: ' + Math.round((st.size || 100) * 0.032 * 0.7 * 100) / 100 + 'em; }';
  }
  V.on('prefs', function (k) { if (k === 'subStyle') capStyle(); });
  PP._capsShowing = function () {
    var tt = this.video && this.video.textTracks, on = false;
    for (var i = 0; tt && i < tt.length; i++) if (tt[i].kind === 'captions' && tt[i].mode === 'showing') on = true;
    if (on && !V.$('#cc-size-style')) capStyle();
    if (on !== this.el.classList.contains('cc-on')) { if (on) this.el.classList.add('cc-on'); else this.el.classList.remove('cc-on'); }
  };
  var origCapTick = PP._tick;
  PP._tick = function () { origCapTick.apply(this, arguments); this._capsShowing(); };

  // ---------------------------------------------------------------- teletext on screen (text, in the subtitle style)
  function ttxBox(p) {
    var el = p._ttxEl;
    if (el && el.parentNode === p.el) return el;
    el = p._ttxEl = document.createElement('div');
    el.className = 'vp-ttx';
    el.setAttribute('aria-live', 'off');
    p.el.insertBefore(el, V.$('.vp-msg', p.el));
    styleTtx();
    return el;
  }
  function styleTtx() {
    var st = V.pref('subStyle') || {};
    var edge = { shadow: '0 2px 4px rgba(0,0,0,.9)', outline: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 4px #000', raised: '1px 1px 0 #000, 2px 2px 0 #000', none: 'none' }[st.edge || 'shadow'] || 'none';
    var font = { sans: 'system-ui, sans-serif', serif: 'Georgia, serif', mono: 'ui-monospace, monospace', casual: '"Comic Sans MS", "Comic Neue", cursive' }[st.font] || 'system-ui, sans-serif';
    var el = V.$('#ttx-style') || document.head.appendChild(Object.assign(document.createElement('style'), { id: 'ttx-style' }));
    el.textContent = '.vp .vp-ttx span { color: ' + (st.color || '#fff') + '; background: ' + (st.bg || 'rgba(0,0,0,0.6)') + '; text-shadow: ' + edge + '; font-family: ' + font + '; }';
  }
  V.on('prefs', function (k) { if (k === 'subStyle') { styleTtx(); var p = V.player; if (p && p._ttxEl) p._ttxEl._sig = null; } });
  function showText(p, text) {
    var el = ttxBox(p), h = p.el.getBoundingClientRect().height, size = ((V.pref('subStyle') || {}).size || 100) / 100;
    var sig = text + '|' + Math.round(h) + '|' + size;
    if (el._sig === sig) return;
    el._sig = sig;
    el.style.fontSize = Math.max(12, h * 0.045 * size) + 'px';
    el.innerHTML = '';
    if (!text) return;
    text.split('\n').forEach(function (line) { var s = document.createElement('span'); s.textContent = line; el.appendChild(s); });
  }
  /** Teletext tracks are shown with the same switch as picture tracks (p.picSub), drawn as text instead. */
  function ttxTrack(tr) {
    tr.find = V.PicTrack.prototype.find;
    tr.start = function () {};
    tr.stop = function () {};
    tr.forget = function () {};
    tr.at = function (t) { var j = tr.find(t); if (j < 0) return null; var e = tr.ents[j]; return e.text && t - e.t < 30 ? { text: e.text, id: j } : null; };
    return tr;
  }
  var origDraw = V.picDraw;
  V.picDraw = function (p, pic) {
    if (pic && pic.text !== undefined) { origDraw(p, null); return showText(p, pic.text); }
    if (p._ttxEl) showText(p, '');
    return origDraw(p, pic);
  };

  // ---------------------------------------------------------------- the Subtitles menu
  V.liveSubsInto = function (p, out) {
    var self = p, v = p.video, i;
    // Captions (CEA-608) that hls.js found in the video, next to the stream's subtitle tracks.
    var caps = [];
    for (i = 0; i < v.textTracks.length; i++) if (v.textTracks[i].kind === 'captions') caps.push(v.textTracks[i]);
    var tracks = p._live ? p._live.tracks : [];
    if (!caps.length && !tracks.length) return;
    var generic = !(p.hls && p.hls.subtitleTracks && p.hls.subtitleTracks.length) && !(p._fileTracks && p._fileTracks.subs.length) && !p.shaka;
    var capLabel = function (t) { return (t.label || lname(t.language) || 'Captions') + ' (captions)'; };
    var capsOff = function () { caps.forEach(function (t) { t.mode = 'disabled'; }); };
    var items = out.subs ? out.subs.items.filter(function (x) { return !(generic && caps.some(function (t) { return (t.label || lname(t.language)) === x.label; })); }) : [{ label: 'Off', on: true, fn: function () {} }];
    var capOn = caps.filter(function (t) { return t.mode === 'showing'; })[0];
    items = items.map(function (x, n) {
      var fn = x.fn;
      return { label: x.label, value: x.value, pic: x.pic, on: x.on && !capOn && !self._pic, fn: function () { self._liveWant = null; capsOff(); if (n === 0 && self.hls) self.hls.subtitleTrack = -1; fn(); } };
    });
    caps.forEach(function (t) {
      items.push({ label: capLabel(t), on: t.mode === 'showing', fn: function () {
        self._liveWant = null;
        if (self._pic) self.picSub(null);
        if (self.hls) self.hls.subtitleTrack = -1;
        for (var j = 0; j < v.textTracks.length; j++) if (v.textTracks[j].kind !== 'metadata') v.textTracks[j].mode = v.textTracks[j] === t ? 'showing' : 'disabled';
        self._capsShowing();
      } });
    });
    tracks.forEach(function (tr) {
      items.push({ label: tr.label, pic: true, on: self._pic === tr, fn: function () {
        capsOff();
        if (self.hls) self.hls.subtitleTrack = -1;
        for (var j = 0; j < v.textTracks.length; j++) if (v.textTracks[j].mode === 'showing') v.textTracks[j].mode = 'disabled';
        self._liveWant = tr.label; // (back on by itself after a reconnect)
        self.picSub(tr.kind === 'ttx' ? ttxTrack(tr) : tr);
      } });
    });
    if (items[0] && items[0].label === 'Off') items[0].on = !items.slice(1).some(function (x) { return x.on; });
    var cur = items.filter(function (x) { return x.on && x.label !== 'Off'; })[0];
    out.subs = { value: cur ? cur.label : 'Off', items: items };
  };

  /** Subtitles wanted (Settings → subtitles always / in other languages): turn on captions or a live track in the language. */
  function autoPick(p) {
    if (p._liveAuto || !p.started) return;
    var heard = p.hls && p.hls.audioTracks && p.hls.audioTracks[p.hls.audioTrack] ? p.hls.audioTracks[p.hls.audioTrack].lang : '';
    if (!p._subsWanted(heard)) return;
    var v = p.video, j;
    for (j = 0; j < v.textTracks.length; j++) if (v.textTracks[j].mode === 'showing') return;
    if (p._pic || (p.hls && p.hls.subtitleTrack >= 0)) return;
    var sl = String(V.pref('subLang') || ((S.profile && S.profile.langs) || S.settings.defaultLangs || ['en'])[0] || '').slice(0, 2).toLowerCase();
    var same = function (l) { l = String(l || '').toLowerCase(); return !!sl && (l.indexOf(sl) === 0 || (V.langName(l) || '').toLowerCase() === (V.langName(sl) || '').toLowerCase()); };
    var tr = (p._live ? p._live.tracks : []).filter(function (x) { return same(x.lang) && !/hearing/.test(x.label); })[0];
    if (tr) { p._liveAuto = true; p._liveWant = tr.label; p.picSub(tr.kind === 'ttx' ? ttxTrack(tr) : tr); p._menuRefresh(); return; }
    for (j = 0; j < v.textTracks.length; j++) {
      var t = v.textTracks[j];
      if (t.kind === 'captions' && same(t.language || t.label)) { p._liveAuto = true; t.mode = 'showing'; p._menuRefresh(); return; }
    }
  }

  // Captions appear in the middle of playing (hls.js makes their track when the first caption arrives).
  V.on('player-started', function (p) {
    p._liveAuto = false;
    var tt = p.video.textTracks;
    if (tt && tt.addEventListener && p._capsFor !== p.video) {
      p._capsFor = p.video;
      tt.addEventListener('addtrack', function () { if (V.player === p) { p._menuRefresh(); autoPick(p); } });
    }
    autoPick(p);
  });
  V.on('player-teardown', function (p) {
    p._live = null;
    clearTimeout(p._sessSubsT);
    p._sessSubsT = null;
    if (p._ttxEl) showText(p, '');
  });

  var origLoad = PP.load;
  PP.load = function (it, opts) { if (!(opts && opts.quiet)) this._liveWant = null; return origLoad.apply(this, arguments); };

  // ---------------------------------------------------------------- mpegts.js: subtitle packets as they arrive
  var origTs = PP._attachTs;
  PP._attachTs = function (url) {
    var r = origTs.apply(this, arguments), p = this, m = this.mts, E = window.mpegts && mpegts.Events;
    if (!m || !E) return r;
    var clock = function (pl) { return pl.video.currentTime; };
    try {
      if (E.PES_PRIVATE_DATA_DESCRIPTOR) m.on(E.PES_PRIVATE_DATA_DESCRIPTOR, function (d) {
        if (V.player !== p || p.mts !== m || !d || !d.descriptor) return;
        var list = D.esSubs(d.descriptor instanceof Uint8Array ? d.descriptor : new Uint8Array(d.descriptor));
        if (list.length) V.liveSubsAnnounce(p, d.pid, list, clock);
      });
      if (E.PES_PRIVATE_DATA_ARRIVED) m.on(E.PES_PRIVATE_DATA_ARRIVED, function (d) {
        if (V.player !== p || p.mts !== m || !d || !d.data) return;
        var t = d.pts !== undefined && d.pts !== null ? d.pts : d.nearest_pts;
        if (typeof t === 'number') V.liveSubsPacket(p, d.pid, t / 1000, d.data instanceof Uint8Array ? d.data : new Uint8Array(d.data));
      });
      if (E.PGS_SUBTITLE_ARRIVED) m.on(E.PGS_SUBTITLE_ARRIVED, function (d) {
        if (V.player !== p || p.mts !== m || !d || !d.data || typeof d.pts !== 'number') return;
        if (!(p._live && p._live.seen[d.pid])) V.liveSubsAnnounce(p, d.pid, [{ kind: 'pgs', lang: d.lang || '' }], clock);
        V.liveSubsPacket(p, d.pid, d.pts / 1000, d.data instanceof Uint8Array ? d.data : new Uint8Array(d.data));
      });
    } catch (e) { console.warn('[captions] mpegts', e); }
    return r;
  };

  // ---------------------------------------------------------------- server conversions: subtitles copied aside
  // hls.js says where the stream's clock starts; the subtitles copied aside have the same clock (MPEG-TS, 90 kHz).
  var origHls = PP._attachHls;
  PP._attachHls = function () {
    var r = origHls.apply(this, arguments), p = this, h = this.hls;
    p._initPts = null;
    if (h && window.Hls && Hls.Events.INIT_PTS_FOUND) {
      h.on(Hls.Events.INIT_PTS_FOUND, function (e, d) {
        if (p.hls !== h || p._initPts !== null || !d) return;
        var base = d.initPTS, scale = d.timescale;
        if (base && typeof base === 'object') { scale = base.timescale; base = base.baseTime; }
        if (typeof base === 'number' && isFinite(base)) p._initPts = base / (scale || 90000);
      });
    }
    return r;
  };
  V.on('player-started', function (p) {
    var s = p.sessionInfo;
    if (!s || !p.sessionId || p.vod || p._sessSubsT) return;
    var sid = p.sessionId, from = 0, tok = p.token;
    var clock = function (pl) { return pl.video.currentTime; };
    // (Each answer checks it's still for this session: one arriving after a channel change mustn't set a timer that
    // stops the next channel's subtitles from being fetched.)
    var poll = function () {
      if (p.token !== tok || p.sessionId !== sid) return;
      V.api('/api/sessionsubs/' + sid + '?from=' + from).then(function (r) {
        if (p.token !== tok || p.sessionId !== sid) return;
        if (r.none) { p._sessSubsT = null; return; } // (this conversion has no subtitles to copy)
        (r.streams || []).forEach(function (x) { V.liveSubsAnnounce(p, x.pid, x.subs, clock); });
        var base = p._initPts;
        if (base !== null && base !== undefined) (r.packets || []).forEach(function (x) { V.liveSubsPacket(p, x.pid, x.pts - base, b64(x.data)); });
        if ((base !== null && base !== undefined) || !r.packets || !r.packets.length) from = r.next;
        p._sessSubsT = setTimeout(poll, 2000);
      }, function () { if (p.token === tok && p.sessionId === sid) p._sessSubsT = setTimeout(poll, 10000); });
    };
    p._sessSubsT = setTimeout(poll, 1000);
  });
  function b64(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
})();
