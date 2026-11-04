/* Integrations: subtitles found online (SubDL, Addic7ed, OpenSubtitles), playback health reports (for Admin → Overview),
   the connection speed test, and the admin's Integrations and "API & automations" pages. */
'use strict';
(function () {
  // ------------------------------------------------------------ subtitles found online
  var ext = function (p) { return p._extSubs || (p._extSubs = []); };
  var subUrl = function (p, url) { return url + (p.sessionId && p.offset ? '?offset=' + p.offset : ''); };

  /** Adds a fetched subtitle to the video and shows it. */
  V.addExtSub = function (p, url, label, lang) {
    var v = p.video;
    var list = ext(p);
    var have = list.filter(function (x) { return x.url === url; })[0];
    if (!have) {
      var tr = document.createElement('track');
      tr.kind = 'subtitles';
      tr.label = label;
      tr.srclang = (lang || 'und').slice(0, 3);
      tr.src = subUrl(p, url);
      tr.setAttribute('data-ext', '1');
      v.appendChild(tr);
      have = { url: url, label: label, lang: lang, el: tr };
      list.push(have);
    }
    if (p.hls && p.hls.subtitleTrack >= 0) p.hls.subtitleTrack = -1;
    setTimeout(function () {
      for (var j = 0; j < v.textTracks.length; j++) v.textTracks[j].mode = v.textTracks[j].label === have.label ? 'showing' : 'disabled';
      p._extOn = have.url;
      if (p._menuRefresh) p._menuRefresh();
    }, 60);
  };
  /** Fetched subtitles in the player's Subtitles menu, next to whatever the stream or file has. */
  V.extSubsInto = function (p, out) {
    var list = (p._extSubs || []).filter(function (x) { return x.el && x.el.parentNode === p.video; });
    p._extSubs = list;
    if (!list.length) return;
    var v = p.video;
    var hideExt = function () { list.forEach(function (x) { if (x.el.track) x.el.track.mode = 'disabled'; }); p._extOn = null; };
    var items = out.subs ? out.subs.items.filter(function (x) { return !list.some(function (e) { return e.label === x.label; }); }).map(function (x) { var fn = x.fn; return { label: x.label, on: x.on && !p._extOn, fn: function () { hideExt(); fn(); } }; }) : [{ label: 'Off', on: !p._extOn, fn: hideExt }];
    list.forEach(function (e) {
      items.push({ label: e.label, on: p._extOn === e.url, fn: function () { for (var j = 0; j < v.textTracks.length; j++) v.textTracks[j].mode = v.textTracks[j].label === e.label ? 'showing' : 'disabled'; p._extOn = e.url; } });
    });
    out.subs = { value: p._extOn ? (list.filter(function (e) { return e.url === p._extOn; })[0] || {}).label : out.subs ? out.subs.value : 'Off', items: items };
  };

  var subLabel = function (lang, from) { return (V.langName(lang) || lang) + (from ? ' (' + from + ')' : ''); };
  var osLeft = function (q) { return q && q.remaining !== undefined && Date.now() - (q.at || 0) < 24 * 3600e3 ? q.remaining : null; };
  V.findSubtitles = function (p) {
    var it = p.it;
    if (!it) return;
    var body = document.createElement('div');
    body.innerHTML = '<p class="dim small">Found online, in your languages. Pick one to show it.</p><div class="os-list"><div class="spinner"></div></div>';
    V.dialog({ title: 'Find subtitles', body: body, wide: true, actions: [{ label: 'Close' }] });
    V.api('/api/opensubs/search?k=' + encodeURIComponent(it.k)).then(function (r) {
      var box = V.$('.os-list', body);
      if (!box) return;
      if (!r.list.length) { box.innerHTML = '<p>Nothing found for “' + V.esc(it.n) + '” in your languages.</p>'; return; }
      var left = osLeft(r.quota);
      var anyCostly = r.list.some(function (x) { return x.costly; });
      box.innerHTML = '<ul class="os-ul">' + r.list.map(function (x) {
        return '<li><button class="btn ghost block os-pick" data-f="' + V.esc(x.id || x.fileId) + '" data-l="' + V.esc(x.lang) + '" data-s="' + V.esc(x.from || '') + '"' + (x.costly && left === 0 ? ' disabled' : '') + '><b>' + V.esc(V.langName(x.lang) || x.lang) + '</b> <span class="truncate">' + V.esc(x.name) + '</span><small class="dim">' +
          [x.from, x.pack ? 'whole season' : '', x.downloads ? V.plural(x.downloads, 'download') : '', x.hi ? 'for the hard of hearing' : '', x.machine ? 'machine translated' : '', x.fromTrusted ? 'trusted' : '', x.cached ? 'saved here' : x.costly ? 'uses 1 of today’s OpenSubtitles downloads' : ''].filter(Boolean).join(' · ') + '</small></button></li>';
      }).join('') + '</ul>' + (anyCostly ? '<p class="dim small">' + (left !== null ? 'OpenSubtitles: ' + V.plural(left, 'download') + ' left today.' : 'OpenSubtitles allows only a few downloads a day.') + ' The others are free.</p>' : '');
      box.onclick = function (e) {
        var b = e.target.closest('.os-pick');
        if (!b || b.disabled) return;
        b.disabled = true;
        V.api('/api/opensubs/get', { body: { id: b.dataset.f, fileId: b.dataset.f } }).then(function (g) {
          V.addExtSub(p, g.url, subLabel(b.dataset.l, b.dataset.s), b.dataset.l);
          var d = body.closest('dialog'); if (d && d._finish) d._finish(null);
          p.osd && p.osd('Subtitles on', 1200);
        }).catch(function (err) { b.disabled = false; V.fail(err); });
      };
      var first = V.$('.os-pick:not([disabled])', box); if (first) first.focus();
    }).catch(function (e) { var box = V.$('.os-list', body); if (box) box.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
  };

  /** Does the player already have subtitles in this language (from the stream, the file, or fetched)? */
  var hasSubsIn = function (p, lang) {
    lang = String(lang || '').slice(0, 2).toLowerCase();
    var v = p.video, i;
    for (i = 0; i < v.textTracks.length; i++) if (String(v.textTracks[i].language || '').slice(0, 2).toLowerCase() === lang) return true;
    var hs = p.hls && p.hls.subtitleTracks ? p.hls.subtitleTracks : [];
    for (i = 0; i < hs.length; i++) if (String(hs[i].lang || '').slice(0, 2).toLowerCase() === lang) return true;
    var fs = (p._fileTracks && p._fileTracks.subs) || [];
    for (i = 0; i < fs.length; i++) if (String(fs[i].lang || '').slice(0, 2).toLowerCase() === lang) return true;
    return false;
  };
  /*
   * Fetching automatically: the free sources ~15 seconds in; if they have nothing, OpenSubtitles (which allows only a few
   * downloads a day) once it's been watched for 3 minutes — so channel-surfing and quick peeks don't use them up.
   */
  V.on('playing', function (it) {
    if (!it || (it.t !== 'movie' && it.t !== 'episode') || !(S.settings.subtitles || S.settings.opensubtitles) || !V.pref('autoFetchSubs')) return;
    var p = V.player, tok = p.token;
    var still = function () { return p.token === tok && V.watch.it === it; };
    var lang = function () { return (V.pref('subLang') || ((S.profile && S.profile.langs) || S.settings.defaultLangs || ['en'])[0] || 'en').slice(0, 2); };
    var wanted = function () {
      var cur = p._fileTracks && (p._fileTracks.audio || [])[p.audioTrack || 0];
      if (p._subsWanted && !p._subsWanted(cur && cur.lang)) return false;
      return !hasSubsIn(p, lang());
    };
    var tryFetch = function (costly) {
      return V.api('/api/opensubs/auto', { body: { k: it.k, lang: lang(), costly: costly } }).then(function (r) {
        if (r && r.url && still() && wanted()) { V.addExtSub(p, r.url, subLabel(r.lang, r.from), r.lang); p.osd && p.osd('Subtitles from ' + (r.from || 'online'), 2000); return true; }
        return false;
      }).catch(function () { return false; });
    };
    setTimeout(function () {
      if (!still() || !wanted()) return;
      tryFetch(false).then(function (got) {
        if (got) return;
        var waited = 0;
        var tick = setInterval(function () {
          if (!still()) { clearInterval(tick); return; }
          if (!p.video || p.video.paused) return; // counts time actually watched
          waited += 5;
          if (waited < 165) return;
          clearInterval(tick);
          if (wanted()) tryFetch(true);
        }, 5000);
      });
    }, 15000);
  });


  // ------------------------------------------------------------ playback health → Admin → Overview
  var health = { stalls: 0, stallMs: 0, since: 0, v: null };
  var watchVideo = function (v) {
    if (health.v === v) return;
    health.v = v;
    v.addEventListener('waiting', function () { if (V.watch.it && !v.seeking && v.currentTime > 0.5) { health.stalls++; health.since = Date.now(); } });
    v.addEventListener('playing', function () { if (health.since) { health.stallMs += Date.now() - health.since; health.since = 0; } });
  };
  V.playbackStats = function () {
    var p = V.player, v = p.video, a = p.attempt || {};
    var out = { route: a.helper ? 'helper' : a.via === 'browser' || p.mb ? 'browser' : a.via === 'direct' || a.via === 'split' ? 'direct' : a.via === 'relay' ? 'relay' : a.via === 'local' ? 'local' : a.via ? 'convert' : '', w: v.videoWidth || 0, h: v.videoHeight || 0 };
    // (Straight from the provider, or through the stream relay; and why the server carries it when it does.)
    if ((out.route === 'direct' || out.route === 'browser') && p.reachInfo && p.reachInfo.relay) out.sr = 1;
    if (out.route === 'convert' || out.route === 'relay') { try { out.why = p._routeReason(out.route); } catch (e) {} if (a.mode) out.mode = a.mode; }
    var b = v.buffered, ahead = 0;
    for (var i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5 && b.end(i) > v.currentTime) ahead = b.end(i) - v.currentTime;
    out.buf = Math.round(ahead * 10) / 10;
    if (p.hls) { var l = p.levels[p.hls.currentLevel] || p.levels[p.hls.loadLevel] || {}; out.br = Math.round((l.bitrate || 0) / 1000); out.bw = Math.round((p.hls.bandwidthEstimate || 0) / 1000); out.lvl = l.height ? l.height + 'p' : ''; }
    else if (p.mts) { var st = p.mts.statisticsInfo || {}; out.bw = st.speed ? Math.round(st.speed * 8) : 0; }
    else if (p.shaka) { try { var ss = p.shaka.getStats(); out.br = Math.round((ss.streamBandwidth || 0) / 1000); out.bw = Math.round((ss.estimatedBandwidth || 0) / 1000); } catch (e) {} }
    if (v.getVideoPlaybackQuality) { var q = v.getVideoPlaybackQuality(); out.dropped = q.droppedVideoFrames || 0; out.frames = q.totalVideoFrames || 0; }
    out.stalls = health.stalls; out.stallMs = health.stallMs + (health.since ? Date.now() - health.since : 0);
    health.stalls = 0; health.stallMs = 0; if (health.since) health.since = Date.now();
    return out;
  };
  setInterval(function () {
    if (!V.watch || !V.watch.it || !V.player || !S.conn || document.hidden && V.player.video.paused) return;
    watchVideo(V.player.video);
    if (V.player.video.paused && !health.stalls) return;
    V.api('/api/presence/stats', { body: { conn: S.conn, s: V.playbackStats() } }).catch(function () {});
  }, 10000);
  V.on('playing', function () { if (V.player) watchVideo(V.player.video); health.stalls = 0; health.stallMs = 0; health.since = 0; });

  // ------------------------------------------------------------ speed test
  var mbps = function (bytes, ms) { return Math.round(((bytes * 8) / Math.max(1, ms) / 1000) * 10) / 10; };
  var verdict = function (m) {
    if (!m) return { t: 'No result', c: 'err' };
    if (m >= 25) return { t: 'Great — fine even for 4K', c: 'ok' };
    if (m >= 12) return { t: 'Good for HD (1080p); may struggle with 4K', c: 'ok' };
    if (m >= 6) return { t: 'Fine for HD 720p; 1080p may stutter', c: '' };
    if (m >= 3) return { t: 'Enough for standard definition', c: 'warn' };
    return { t: 'Too slow for smooth video', c: 'err' };
  };
  /** Reads a response for up to `ms` (or `max` bytes) → { bytes, ms, ttfb }. */
  var readFor = function (url, opts, ms, max) {
    var ac = window.AbortController ? new AbortController() : null;
    var t0 = Date.now(), ttfb = 0, n = 0;
    var timer = setTimeout(function () { if (ac) ac.abort(); }, ms + 4000);
    return fetch(url, Object.assign({ cache: 'no-store', signal: ac ? ac.signal : undefined }, opts || {})).then(function (r) {
      ttfb = Date.now() - t0;
      if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
      if (!r.body || !r.body.getReader) return r.arrayBuffer().then(function (b) { n = b.byteLength; return { bytes: n, ms: Date.now() - t0 - ttfb, ttfb: ttfb, r: r }; });
      var rd = r.body.getReader(), t1 = Date.now();
      var step = function () {
        return rd.read().then(function (x) {
          if (!x.done) n += x.value.length;
          if (x.done || Date.now() - t1 > ms || n >= max) { try { if (ac) ac.abort(); } catch (e) {} return { bytes: n, ms: Date.now() - t1, ttfb: ttfb, r: r }; }
          return step();
        });
      };
      return step();
    }).then(function (x) { clearTimeout(timer); return x; }, function (e) { clearTimeout(timer); if (n && e && e.name === 'AbortError') return { bytes: n, ms: Date.now() - t0 - ttfb, ttfb: ttfb }; throw e; });
  };
  /** Straight from this device to the provider (works only when the provider lets web pages read it). */
  var directProbe = function (t) {
    var u = t.u;
    if (t.headers || (location.protocol === 'https:' && /^http:/i.test(u))) return Promise.reject(new Error('blocked'));
    if (/\.m3u8(\?|$)/i.test(u)) {
      var t0 = Date.now();
      var getText = function (url) { return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text().then(function (x) { return { text: x, url: r.url || url }; }); }); };
      var pick = function (pl) { var lines = pl.text.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(function (x) { return x && x.charAt(0) !== '#'; }); return lines.length ? new URL(lines[lines.length > 3 ? lines.length - 2 : 0], pl.url).href : ''; };
      return getText(u).then(function (pl) {
        var nx = pick(pl);
        if (!nx) throw new Error('empty');
        return /\.m3u8(\?|$)/i.test(nx) ? getText(nx).then(function (p2) { return pick(p2); }) : nx;
      }).then(function (seg) { var ttfb0 = Date.now() - t0; return readFor(seg, {}, 5000, 16e6).then(function (x) { x.ttfb = ttfb0; return x; }); });
    }
    return readFor(u, t.kind === 'movie' ? { headers: { Range: 'bytes=0-16777215' } } : {}, 5000, 16e6);
  };
  V.speedTest = function (opts) {
    opts = opts || {};
    var body = document.createElement('div');
    body.className = 'speedtest';
    body.innerHTML = '<p class="dim">Checks how fast this device reaches this server, and how fast it reaches your provider. It takes about 20 seconds.</p>' +
      '<label class="field"><span>Provider to test</span><select class="input" data-list><option value="">Loading…</option></select></label>' +
      '<dl class="kv st-res"></dl><p class="st-verdict"></p>';
    var res = function () { return V.$('.st-res', body); };
    var row = function (k, label, val) { var dl = res(); var el = V.$('[data-k="' + k + '"]', dl); if (!el) { dl.insertAdjacentHTML('beforeend', '<dt>' + V.esc(label) + '</dt><dd data-k="' + k + '"></dd>'); el = V.$('[data-k="' + k + '"]', dl); } el.innerHTML = val; };
    var targets = [];
    V.api('/api/speedtest/targets').then(function (t) {
      targets = t;
      var sel = V.$('[data-list]', body);
      sel.innerHTML = t.length ? t.map(function (x) { return '<option value="' + V.esc(x.id) + '">' + V.esc(x.name) + (x.busy ? ' (all connections in use)' : '') + '</option>'; }).join('') : '<option value="">No lists to test</option>';
      var cur = V.watch && V.watch.it ? V.watch.it.src : '';
      if (cur && t.some(function (x) { return x.id === cur; })) sel.value = cur;
    }).catch(function () {});
    var running = false;
    var run = function () {
      if (running) return false;
      running = true;
      res().innerHTML = '';
      V.$('.st-verdict', body).textContent = '';
      var out = {};
      var spin = '<span class="spinner sm"></span>';
      row('ping', 'Delay to this server', spin);
      var pings = [], i = 0;
      var ping = function () { var t0 = performance.now(); return V.api('/api/speedtest/ping').then(function () { pings.push(performance.now() - t0); i++; return i < 5 ? ping() : null; }); };
      return ping().then(function () {
        pings.sort(function (a, b) { return a - b; });
        out.ping = Math.round(pings[Math.floor(pings.length / 2)]);
        row('ping', 'Delay to this server', out.ping + ' ms');
        row('down', 'Download from this server', spin);
        return readFor('/api/speedtest/down?mb=2', {}, 3000, 2e6).then(function () { return readFor('/api/speedtest/down?mb=40', {}, 5000, 40e6); });
      }).then(function (x) {
        out.down = mbps(x.bytes, x.ms);
        row('down', 'Download from this server', out.down + ' Mbit/s');
        row('up', 'Upload to this server', spin);
        var size = /Mobi|Android|iPhone/i.test(navigator.userAgent) ? 4 : 10;
        var blob = new Blob([new Uint8Array(size * 1024 * 1024)]);
        var t0 = Date.now();
        return V.api('/api/speedtest/up', { body: blob, headers: { 'Content-Type': 'application/octet-stream' } }).then(function (r) { out.up = mbps(r.bytes, Date.now() - t0); row('up', 'Upload to this server', out.up + ' Mbit/s'); });
      }).then(function () {
        var id = V.$('[data-list]', body).value;
        var t = targets.filter(function (x) { return x.id === id; })[0];
        if (!t) return;
        row('prov', 'From ' + t.name, spin);
        if (t.busy) { row('prov', 'From ' + t.name, 'not tested — every connection is in use right now'); return; }
        // (A list behind the stream relay: this device mustn't contact the provider itself — the server measures.)
        return ((S.settings.relayLists || []).indexOf(t.id) >= 0 ? Promise.reject(new Error('relay')) : directProbe(t)).then(function (x) {
          out.prov = mbps(x.bytes, x.ms);
          row('prov', 'From ' + t.name + ' (straight to this device)', out.prov + ' Mbit/s · first byte after ' + x.ttfb + ' ms');
        }, function () {
          return V.api('/api/speedtest/provider', { body: { list: id } }).then(function (r) {
            if (!r.ok) { row('prov', 'From ' + t.name, V.esc(r.error || 'failed')); return; }
            out.prov = r.mbps;
            out.provByServer = true;
            row('prov', 'From ' + t.name + ' (measured by the server)', r.mbps + ' Mbit/s · first byte after ' + r.ttfb + ' ms');
          });
        });
      }).then(function () {
        var limit = Math.min(out.down || 0, out.prov === undefined ? Infinity : out.prov);
        var vd = verdict(limit === Infinity ? out.down : limit);
        V.$('.st-verdict', body).innerHTML = '<b class="' + vd.c + '">' + V.esc(vd.t) + '</b>' + (out.prov === undefined ? '<br><small class="dim">That’s from this server; the provider couldn’t be tested, so it may still be the slow part.</small>' : '') + (out.provByServer ? '<br><small class="dim">This provider doesn’t let web pages read its streams directly, so the server measured it. Streams from it may go through the server on this device.</small>' : '') +
          (out.prov !== undefined && out.prov < out.down / 2 ? '<br><small class="dim">The provider is the slow part, not your network.</small>' : out.down < 8 && out.ping > 150 ? '<br><small class="dim">This device is a long way from the server (or on a slow network).</small>' : '');
      }).catch(function (e) { V.$('.st-verdict', body).innerHTML = '<span class="err">' + V.esc(e.message) + '</span>'; }).then(function () { running = false; return false; });
    };
    V.dialog({ title: 'Test the connection', body: body, wide: true, actions: [{ label: 'Close' }, { label: 'Start', primary: true, fn: run }] });
  };

  // ------------------------------------------------------------ Settings: subtitles, connection test
  V.settingsExtra = function () {
    var pf = S.data.prefs;
    return ((S.settings.subtitles || S.settings.opensubtitles) ? '<section class="card-sec"><h2>Subtitles found online</h2>' +
        '<label class="switch"><input type="checkbox" data-pref="autoFetchSubs"' + (pf.autoFetchSubs ? ' checked' : '') + '><span class="sw"></span><span><b>Fetch subtitles automatically</b><small>When a film or episode has none in your language and you’d want them</small></span></label>' +
        '<p class="dim small">You can also pick some yourself while watching: the subtitles button → Find subtitles.</p></section>' : '') +
      '<section class="card-sec"><h2>Connection</h2><p class="dim">How fast this device reaches the server and your provider, and what that’s good for.</p><button class="btn" data-a="speedtest">' + V.icon('pulse') + ' Test my connection</button></section>';
  };
  V.settingsExtraBind = function (view) {
    var st = V.$('[data-a=speedtest]', view);
    if (st) st.addEventListener('click', function () { V.speedTest(); });
  };
  // ------------------------------------------------------------ Admin → Overview: watching now, live
  var fmtK = function (kbps) { return kbps >= 1000 ? (Math.round(kbps / 100) / 10) + ' Mbit/s' : kbps ? kbps + ' kbit/s' : '–'; };
  var ROUTE = { local: 'Your own file (from this server)', direct: 'Direct from the provider', browser: 'Converted in the browser', relay: 'Through this server', convert: 'Converted on this server', helper: 'Direct (helper)' };
  // Why this server carries a stream (Admin → Statistics has the same words).
  var WHY = { format: 'a format this device can’t play', picture: 'no picture the direct way', 'direct-failed': 'the direct way didn’t start', chosen: 'quality chosen by the viewer', headers: 'needs headers browsers can’t send', https: 'plain http on an https page', setting: 'admin setting', blocked: 'the provider blocks web players', library: 'your own file' };
  var routeText = function (s) {
    if (!s || !s.route) return '';
    if ((s.route === 'direct' || s.route === 'browser') && s.sr) return s.route === 'browser' ? 'Converted in the browser · through the stream relay' : 'Direct · through the stream relay';
    var t = ROUTE[s.route] || s.route;
    if (s.route === 'convert' && s.mode) t += ' (' + (s.mode === 'transcode' ? 'transcoding' : 'repackaging') + ')';
    if (WHY[s.why]) t += ' — ' + WHY[s.why];
    return t;
  };
  var acctState = function (l) {
    var a = l.account;
    if (!l.hasAccount) return { cls: '', label: 'Playlist link', note: 'No account details for this kind of list' };
    if (!a) return { cls: '', label: 'Not checked yet', note: '' };
    var days = a.expires ? Math.floor((a.expires - Date.now()) / 86400e3) : null;
    var st = String(a.status || '').toLowerCase();
    var bad = (st && st !== 'active') || (days !== null && days < 0);
    var cls = bad ? 'bad' : days !== null && days <= 14 ? 'warn' : a.error && !a.checkedAt ? 'warn' : 'ok';
    var bits = [];
    if (a.expires) bits.push((days < 0 ? 'expired ' : 'expires ') + new Date(a.expires).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + (days >= 0 ? ' (' + V.plural(days, 'day') + ')' : ''));
    if (a.trial) bits.push('trial');
    if (a.active !== '' && a.active !== undefined) bits.push('provider says ' + a.active + ' in use');
    if (a.checkedAt) bits.push('checked ' + V.fmtAgo(a.checkedAt));
    var note = bits.join(' · ');
    return { cls: cls, label: a.status ? a.status.charAt(0).toUpperCase() + a.status.slice(1) : a.error ? 'Couldn’t check' : '?', note: note.charAt(0).toUpperCase() + note.slice(1), error: a.error };
  };
  var viewerRow = function (r) {
    var s = r.stats;
    var chips = s ? [routeText(s), s.h ? s.h + 'p' : '', s.bitrate ? 'stream ' + fmtK(s.bitrate) : '', s.bandwidth ? 'connection ' + fmtK(s.bandwidth) : '', 'buffer ' + s.buffer + ' s',
      s.stalls ? V.plural(s.stalls, 'pause') + ' to load (' + s.stallSecs + ' s) in ' + V.plural(s.minutes, 'min') : '', s.droppedPct ? s.droppedPct + '% frames dropped' : ''].filter(Boolean) : [];
    return '<li class="pv-row"><span class="pv-dot ' + (s ? r.health : 'wait') + '" title="' + (s ? (r.health === 'good' ? 'Smooth' : r.health === 'fair' ? 'Some trouble' : 'Struggling') : 'Waiting for the first report') + '"></span>' +
      '<div class="pv-who"><div><b>' + V.esc(r.profile) + '</b> · ' + (r.hidden ? '<span class="dim">(private)</span>' : V.esc(r.n)) + ' <span class="dim">on ' + V.esc(r.device) + ' · ' + V.fmtAgo(r.at) + '</span></div>' +
      (s ? '<div class="aw-stats small"><span class="aw-h ' + r.health + '">' + (r.health === 'good' ? 'Smooth' : r.health === 'fair' ? 'Some trouble' : 'Struggling') + '</span>' + chips.map(function (x) { return '<span>' + V.esc(x) + '</span>'; }).join('') + '</div>' : '<div class="dim small">Waiting for the first report…</div>') + '</div></li>';
  };
  /** Admin → Overview: each provider with its account and connections, and who's watching from it — live. */
  V.adminWatching = function (sec) {
    if (!sec) return;
    var draw = function () {
      if (!document.body.contains(sec)) return;
      V.api('/api/admin/watching').then(function (w) {
        var byList = {};
        w.rows.forEach(function (r) { (byList[r.lid || ''] = byList[r.lid || ''] || []).push(r); });
        var cards = w.lists.map(function (l) {
          var st = acctState(l), rows = byList[l.id] || [];
          var limit = l.limit || 0, used = l.used || 0;
          var dots = limit && limit <= 12 ? '<span class="pv-dots" aria-hidden="true">' + Array.from({ length: limit }, function (_, i) { return '<i class="' + (i < used ? 'on' : '') + '"></i>'; }).join('') + '</span>' : '';
          return '<article class="pv' + (rows.length || used ? ' busy' : '') + '"><header class="pv-h"><b class="pv-name">' + V.esc(l.name) + '</b><span class="pv-st ' + st.cls + '">' + V.esc(st.label) + '</span><span class="sp"></span>' +
            '<span class="pv-conn' + (limit && used >= limit ? ' full' : '') + '">' + dots + (limit ? used + ' of ' + V.plural(limit, 'connection') : used ? V.plural(used, 'connection') + ' in use' : 'idle') + '</span></header>' +
            (st.note ? '<div class="pv-meta small dim">' + V.esc(st.note) + '</div>' : '') +
            (st.error ? '<div class="pv-meta small err">Last check: ' + V.esc(st.error) + '</div>' : '') +
            (rows.length ? '<ul class="pv-list">' + rows.map(viewerRow).join('') + '</ul>' : '') +
            (l.other && l.other.length ? '<div class="pv-meta small">' + l.other.map(function (o) { return V.esc((o.who ? o.who + ' · ' : '') + (o.device || '') + (o.n ? ': ' + o.n : '')); }).join('<br>') + '</div>' : '') +
            (!rows.length && !(l.other && l.other.length) ? '<div class="pv-none small dim">Nobody watching</div>' : '') + '</article>';
        });
        var loose = byList[''] || [];
        // (Lists that are gone or off, or one's own files: still shown, apart.)
        Object.keys(byList).forEach(function (k) { if (k && !w.lists.some(function (l) { return l.id === k; })) loose = loose.concat(byList[k]); });
        var html = '<div class="sec-h"><h2>Providers and watching now</h2><span class="sp"></span><div class="btn-row"><button class="btn sm" data-acct>' + V.icon('refresh') + ' Check accounts</button><button class="btn sm" data-a="speedtest">' + V.icon('pulse') + ' Test the connection</button></div></div>' +
          (w.rows.length ? '' : '<p class="dim small pv-quiet">Nobody is watching right now.</p>') +
          (cards.length ? '<div class="pv-grid">' + cards.join('') + '</div>' : '<p class="dim">No provider lists.</p>') +
          (loose.length ? '<article class="pv pv-loose"><header class="pv-h"><b class="pv-name">Not from a provider</b></header><ul class="pv-list">' + loose.map(viewerRow).join('') + '</ul></article>' : '');
        // (Every 5 seconds: redraw only when something changed, and keep focus on the button — a TV remote is often on it.)
        if (html !== sec._html) {
          var fa = document.activeElement, had = fa && sec.contains(fa) ? (fa.hasAttribute('data-acct') ? '[data-acct]' : '[data-a=speedtest]') : '';
          sec._html = html;
          sec.innerHTML = html;
          if (had) try { V.$(had, sec).focus({ preventScroll: true }); } catch (e) {}
        }
        clearTimeout(sec._t);
        sec._t = setTimeout(draw, 5000);
      }).catch(function () { clearTimeout(sec._t); sec._t = setTimeout(draw, 15000); });
    };
    sec.onclick = function (e) {
      if (e.target.closest('[data-a=speedtest]')) V.speedTest({ admin: true });
      var c = e.target.closest('[data-acct]');
      if (c && !c.disabled) {
        c.disabled = true;
        c.innerHTML = '<span class="spinner sm"></span> Checking…';
        V.api('/api/admin/accounts/check', { method: 'POST' }).then(function () { sec._html = ''; draw(); }).catch(V.fail);
      }
    };
    draw();
  };

  // ------------------------------------------------------------ Admin → Integrations
  var secretField = function (name, label, val, hint) { return '<label class="field"><span>' + label + '</span><input class="input" data-f="' + name + '" value="' + V.esc(val || '') + '" autocomplete="off" spellcheck="false">' + (hint ? '<small class="dim">' + hint + '</small>' : '') + '</label>'; };
  // (After a save reloads a tab: the button to put focus back on.)
  var focusBack = function (body, sel) {
    var el = null;
    try { el = sel && V.$(sel, body); } catch (e) {}
    if (el) try { el.focus({ preventScroll: true }); } catch (e) {}
  };
  V.adminTabs.integrations = function (body, A, refocus) {
    // (Reloading after a save: keep the page as it is until the new one is ready, rather than a spinner.)
    if (!refocus) body.innerHTML = '<div class="spinner"></div>';
    V.api('/api/admin/integrations').then(function (I) {
      var o = I.opensubtitles, sd = I.subdl || {}, src = I.sources || {};
      var left = o.quota && o.quota.remaining !== undefined ? '<p class="dim small">' + V.plural(o.quota.remaining, 'download') + ' left today (checked ' + V.fmtAgo(o.quota.at) + '). Fetching automatically leaves the last ' + (o.reserve || 2) + ' for choosing by hand.</p>' : '';
      body.innerHTML = '<section class="card-sec"><h2>Subtitles found online</h2><p class="dim">Lets anyone find subtitles for a film or episode that has none in their language (the subtitles button → Find subtitles), or fetch them automatically. Sources are searched together; the free ones are used first.</p>' +
        '<h3>SubDL <span class="dim small">· main source</span></h3><p class="dim small">Free: sign up at subdl.com, then your account → API key. 2,000 searches a day; downloads aren’t counted.</p>' +
        '<div class="int-fields">' + secretField('sd.apiKey', 'API key', sd.apiKey) + '</div>' +
        '<label class="switch"><input type="checkbox" data-src="gestdown"' + (src.gestdown !== false ? ' checked' : '') + '><span class="sw"></span><span><b>Addic7ed (through Gestdown)</b><small>Free, no key needed. TV episodes only — often the quickest after an episode airs.</small></span></label>' +
        '<div class="btn-row"><button class="btn primary" data-save="sd">Save</button><button class="btn" data-test="all">Test all sources</button></div><div class="all-test small"></div></section>' +
        '<section class="card-sec"><h2>Backup: OpenSubtitles.com</h2><p class="dim">The biggest library, used when the free sources have nothing. A free API key (opensubtitles.com → your profile → API consumers) allows 5 downloads a day, shared by everyone here; subtitles already saved here don’t count again. Signing in with an account only raises that with a VIP subscription.</p>' +
        '<div class="int-fields">' + secretField('os.apiKey', 'API key', o.apiKey) + secretField('os.username', 'Account username (optional)', o.username) + '<label class="field"><span>Account password</span><input class="input" type="password" data-f="os.password" value="' + V.esc(o.password) + '" autocomplete="new-password"></label></div>' +
        left +
        '<div class="btn-row"><button class="btn primary" data-save="os">Save</button><button class="btn" data-test="os">Test</button></div><p class="os-test small"></p></section>';
      focusBack(body, refocus);
      body.onclick = function (e) {
        var s = e.target.closest('[data-save]');
        if (s && !s.disabled) {
          var val = function (k) { var el = V.$('[data-f="' + k + '"]', body); return el ? el.value : undefined; };
          var on = function (k) { var el = V.$('[data-src="' + k + '"]', body); return !!(el && el.checked); };
          var patch = s.dataset.save === 'os' ? { opensubtitles: { apiKey: val('os.apiKey'), username: val('os.username'), password: val('os.password') } }
            : { subdl: { apiKey: val('sd.apiKey') }, sources: { gestdown: on('gestdown') } };
          s.disabled = true;
          V.put('/api/admin/integrations', patch).then(function () { V.toast('Saved — reload other open pages to see the change'); V.adminTabs.integrations(body, A, '[data-save="' + s.dataset.save + '"]'); }).catch(function (err) { s.disabled = false; V.fail(err); });
        }
        var tb = e.target.closest('[data-test]');
        if (tb && tb.disabled) return;
        if (tb) tb.disabled = true;
        var again = function () { tb.disabled = false; };
        if (tb && tb.dataset.test === 'all') {
          var box = V.$('.all-test', body);
          box.textContent = 'Testing…';
          var NAMES = { subdl: 'SubDL', gestdown: 'Addic7ed (Gestdown)', opensubtitles: 'OpenSubtitles' };
          V.api('/api/admin/integrations/subtitles/test', { method: 'POST' }).then(function (r) {
            box.innerHTML = '<ul class="simple">' + Object.keys(NAMES).map(function (k) {
              var x = r[k] || {};
              var msg = !x.on ? '<span class="dim">off</span>' : !x.ok ? '<span class="err">' + V.esc(x.error || 'failed') + '</span>' :
                V.icon('check', 'tiny ok') + ' works' + (k === 'gestdown' ? ' (episodes only)' : x.found !== undefined ? ' — ' + V.plural(x.found, 'result') + ' for The Matrix' : '');
              return '<li><b>' + NAMES[k] + '</b>: ' + msg + '</li>';
            }).join('') + '</ul>';
          }).catch(function (e) { box.innerHTML = '<span class="err">' + V.esc(e.message) + '</span>'; }).then(again);
          return;
        }
        if (tb) {
          var out = V.$('.os-test', body);
          out.textContent = 'Testing…';
          V.api('/api/admin/integrations/opensubtitles/test', { method: 'POST' }).then(function (r) { out.innerHTML = r.ok ? V.icon('check', 'tiny ok') + ' The API key works' + (r.account ? ', and the account signed in.' : r.error ? ', but the account didn’t sign in: ' + V.esc(r.error) : '.') : '<span class="err">' + V.esc(r.error || 'It didn’t work.') + '</span>'; })
            .catch(function (e) { out.innerHTML = '<span class="err">' + V.esc(e.message) + '</span>'; }).then(again);
        }
      };
    }).catch(function (e) { body.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
  };

  // ------------------------------------------------------------ Admin → API & automations
  var SCOPE = { read: 'Read only — what’s playing, devices, search, channels', control: 'Control devices — also play, pause, stop, change channel, volume', admin: 'Admin — everything, including list refreshes' };
  V.adminTabs.api = function (body, A, refocus) {
    if (!refocus) body.innerHTML = '<div class="spinner"></div>';
    var reload = function (sel) { V.adminTabs.api(body, A, sel || '[data-a=newkey]'); };
    V.api('/api/admin/integrations').then(function (I) {
      var base = location.origin + '/api/v1';
      var profOpts = '<option value="">Any profile (sees everything)</option>' + ((A && A.profiles) || []).map(function (p) { return '<option value="' + p.id + '">Only ' + V.esc(p.name) + '’s devices and titles</option>'; }).join('');
      body.innerHTML = '<section class="card-sec"><h2>API keys</h2><p class="dim">For Home Assistant, scripts and other automations. Send the key as <code>Authorization: Bearer &lt;key&gt;</code> to <code>' + V.esc(base) + '</code>. A key is shown once, when it’s made.</p>' +
        (I.apiKeys.length ? '<ul class="simple">' + I.apiKeys.map(function (k) { return '<li class="row-between"><span><b>' + V.esc(k.name) + '</b> <span class="dim">· ' + V.esc(k.scope) + ' · <code>' + V.esc(k.hint) + '</code> · ' + (k.lastUsed ? 'used ' + V.fmtAgo(k.lastUsed) : 'never used') + '</span></span><button class="btn sm danger" data-revoke="' + V.esc(k.id) + '">Revoke</button></li>'; }).join('') + '</ul>' : '<p class="dim">No keys yet.</p>') +
        '<div class="grid2"><label class="field"><span>Name</span><input class="input" data-k="name" placeholder="Home Assistant" maxlength="60"></label><label class="field"><span>It may</span><select class="input" data-k="scope">' + I.scopes.map(function (s) { return '<option value="' + s + '"' + (s === 'control' ? ' selected' : '') + '>' + V.esc(SCOPE[s]) + '</option>'; }).join('') + '</select></label>' +
        '<label class="field"><span>Profile</span><select class="input" data-k="profile">' + profOpts + '</select></label></div><button class="btn primary" data-a="newkey">' + V.icon('plus') + ' Make a key</button>' +
        '<details class="api-ref"><summary>What the API can do</summary><ul class="small">' +
        ['GET /now — what each device is playing', 'GET /devices — signed-in devices (the id is used below)', 'POST /devices/{id}/play — {"k": "…"} or {"channel": 101} or {"title": "…"}', 'POST /devices/{id}/command — {"cmd": "pause" | "resume" | "toggle" | "stop" | "zap" (+ "dir": 1 or -1) | "channel" (+ "n") | "volume" (+ "v": 0–1) | "mute" | "seek" (+ "pos") | "sleep" (+ "min")}', 'GET /search?q=… — titles and channels', 'GET /channels — every channel with its number', 'GET /items/{k} — one title', 'GET /status — lists, accounts (admin keys)', 'POST /lists/{id}/refresh — refresh a list (admin keys)'].map(function (x) { return '<li><code>' + V.esc(x) + '</code></li>'; }).join('') + '</ul></details></section>' +
        '<section class="card-sec"><h2>Webhooks</h2><p class="dim">The server sends a short JSON message to these addresses when something happens. Each is signed: <code>X-Signature: sha256=…</code> (HMAC-SHA256 of the body with the webhook’s secret). Failed deliveries are tried again three times.</p>' +
        (I.webhooks.length ? '<ul class="simple">' + I.webhooks.map(function (h) { return '<li><div class="row-between"><span><b>' + V.esc(h.name) + '</b> <span class="dim">· ' + V.esc(h.url) + '</span>' + (h.enabled ? '' : ' <span class="chip sm">off</span>') + '</span><span class="btn-row"><button class="btn sm" data-htest="' + V.esc(h.id) + '">Send a test</button><button class="btn sm" data-hsecret="' + V.esc(h.id) + '">Secret</button><button class="btn sm danger" data-hdel="' + V.esc(h.id) + '">Delete</button></span></div><div class="dim small">' + h.events.map(function (e) { return V.esc(I.events[e] || e); }).join(' · ') + '</div></li>'; }).join('') + '</ul>' : '<p class="dim">No webhooks yet.</p>') +
        '<div class="grid2"><label class="field"><span>Address</span><input class="input" data-h="url" placeholder="http://homeassistant.local:8123/api/webhook/iptv" spellcheck="false"></label><label class="field"><span>Name</span><input class="input" data-h="name" placeholder="Home Assistant" maxlength="60"></label></div>' +
        '<div class="chips">' + Object.keys(I.events).map(function (e) { return '<label class="chip-check"><input type="checkbox" data-ev="' + e + '"' + (/^playback/.test(e) ? ' checked' : '') + '><span>' + V.esc(I.events[e]) + '</span></label>'; }).join('') + '</div>' +
        '<button class="btn primary" data-a="newhook">' + V.icon('plus') + ' Add webhook</button>' +
        '<h3>Recent deliveries</h3>' + (I.deliveries.length ? '<ul class="simple small">' + I.deliveries.map(function (d) { return '<li>' + (d.ok ? V.icon('check', 'tiny ok') : V.icon('x', 'tiny err')) + ' <b>' + V.esc(d.event) + '</b> → ' + V.esc(d.name) + ' <span class="dim">· ' + V.fmtAgo(d.at) + ' · ' + (d.status ? 'HTTP ' + d.status : V.esc(d.error || 'no answer')) + (d.attempt > 1 ? ' · try ' + d.attempt : '') + '</span></li>'; }).join('') + '</ul>' : '<p class="dim small">None yet.</p>') + '</section>';
      focusBack(body, refocus);
      // A key or secret to copy (V.copy also works on plain-http addresses, where the clipboard API doesn't).
      var showSecret = function (title, intro, value, copy) {
        return V.dialog({ title: title, body: (intro ? '<p>' + intro + '</p>' : '') + '<input class="input mono" readonly value="' + V.esc(value) + '" onfocus="this.select()">', actions: (copy ? [{ label: 'Copy', fn: function () { V.copy(value); return false; } }] : []).concat([{ label: 'Done', primary: true }]) });
      };
      // One request per button at a time.
      var once = function (b, req) { if (b.disabled) return; b.disabled = true; req().catch(V.fail).then(function () { if (b.isConnected) b.disabled = false; }); };
      body.onclick = function (e) {
        var b;
        if ((b = e.target.closest('[data-a=newkey]'))) {
          once(b, function () {
            return V.api('/api/admin/apikeys', { body: { name: V.$('[data-k=name]', body).value, scope: V.$('[data-k=scope]', body).value, profile: V.$('[data-k=profile]', body).value } }).then(function (r) {
              showSecret('Your new API key', 'Copy it now — it won’t be shown again.', r.key, true).then(function () { reload(); });
            });
          });
        } else if ((b = e.target.closest('[data-revoke]'))) {
          V.confirm('Revoke this key? Anything using it stops working.', { ok: 'Revoke', danger: true }).then(function (ok) { if (ok) V.del('/api/admin/apikeys/' + encodeURIComponent(b.dataset.revoke)).then(function () { V.toast('Key revoked'); reload(); }).catch(V.fail); });
        } else if ((b = e.target.closest('[data-a=newhook]'))) {
          var evs = V.$$('[data-ev]', body).filter(function (x) { return x.checked; }).map(function (x) { return x.dataset.ev; });
          once(b, function () {
            return V.api('/api/admin/webhooks', { body: { url: V.$('[data-h=url]', body).value, name: V.$('[data-h=name]', body).value, events: evs } }).then(function (h) {
              showSecret('Webhook added', 'Its signing secret (also under “Secret” later):', h.secret).then(function () { reload('[data-a=newhook]'); });
            });
          });
        } else if ((b = e.target.closest('[data-hdel]'))) {
          V.confirm('Delete this webhook?', { ok: 'Delete', danger: true }).then(function (ok) { if (ok) V.del('/api/admin/webhooks/' + encodeURIComponent(b.dataset.hdel)).then(function () { V.toast('Webhook deleted'); reload('[data-a=newhook]'); }).catch(V.fail); });
        } else if ((b = e.target.closest('[data-htest]'))) {
          var hid = b.dataset.htest;
          once(b, function () {
            return V.api('/api/admin/webhooks/' + encodeURIComponent(hid) + '/test', { method: 'POST' }).then(function (d) {
              V.toast(d.ok ? 'Delivered (HTTP ' + d.status + ')' : 'Not delivered: ' + (d.status ? 'HTTP ' + d.status : d.error), d.ok ? {} : { error: true });
              setTimeout(function () { reload('[data-htest="' + hid + '"]'); }, 300);
            });
          });
        } else if ((b = e.target.closest('[data-hsecret]'))) {
          once(b, function () { return V.api('/api/admin/webhooks/' + encodeURIComponent(b.dataset.hsecret) + '/secret').then(function (r) { showSecret('Signing secret', '', r.secret); }); });
        }
      };
    }).catch(function (e) { body.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
  };
})();
