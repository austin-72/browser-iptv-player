/* Error reports: problems on this device are sent to the server automatically (Admin → Error reports), with what's
   needed to fix them: the error and its stack, the page, this device and browser, what was playing and how, and the
   last things that happened before it. Stream addresses lose their user names, passwords and tokens first.
   Loaded early (before the rest of the app), and written for old smart-TV browsers: no modern syntax. */
'use strict';
(function () {
  var V = (window.V = window.V || {});
  var T0 = Date.now();
  var crumbs = [];
  var queue = [];
  var seen = {}; // fingerprint → { at, n, sent }
  var sentTotal = 0;
  var timer = null;
  var MAX_PAGE = 40; // reports per page load
  var userSent = []; // when this device sent a viewer's own report (kind "user")

  var appV = (function () {
    var s = document.querySelectorAll('script[src*="app.js"]');
    var m = s.length && /[?&]v=([\w-]+)/.exec(s[s.length - 1].src);
    return m ? m[1] : '';
  })();

  /** Passwords, user names and tokens out of anything that may hold a stream address. */
  var scrub = V.scrubText = function (s) {
    if (s == null) return '';
    return String(s)
      .replace(/(\/\/)[^\/@\s:]+:[^\/@\s]+@/g, '$1…:…@')
      .replace(/(\/(?:live|movie|movies|series|timeshift|timeshifts|play|hls|stream)\/)[^\/\s?#]+\/[^\/\s?#]+\//gi, '$1…/…/')
      .replace(/([?&;](?:username|user|password|pass|pwd|token|access_token|auth|key|api_key|apikey|api-key|sig|signature|mac|sn|serial|e|hash|session|sid)=)[^&#\s"']+/gi, '$1…')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/g, '$1 …')
      .replace(/([A-Za-z0-9_-]{48,})/g, function (m) { return m.slice(0, 6) + '…'; });
  };
  /** The same for every string inside an object (a copy; {} if it can't be copied). */
  var scrubAll = function (o) { try { return JSON.parse(scrub(JSON.stringify(o, function (k, v) { return typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) + '…' : v; }))); } catch (e) { return {}; } };
  var clip = function (s, n) { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n) + '…' : s; };

  // ------------------------------------------------------------ what happened before (breadcrumbs)
  /** k: nav | click | key | api | player | toast | log | net | app */
  var crumb = V.crumb = function (k, m) {
    m = clip(scrub(m), 240);
    var last = crumbs[crumbs.length - 1];
    if (last && last.k === k && last.m === m) { last.n = (last.n || 1) + 1; last.at = Date.now(); return; }
    crumbs.push({ at: Date.now(), k: k, m: m });
    if (crumbs.length > 50) crumbs.shift();
  };
  var describe = function (el) {
    if (!el || !el.tagName) return '';
    var t = el.closest ? el.closest('button,a,[role=button],[role=tab],[data-a],input,select,textarea,label,.card,[data-k],li') || el : el;
    var tag = t.tagName.toLowerCase();
    var bits = [tag];
    if (t.id) bits.push('#' + t.id);
    var a = t.getAttribute && (t.getAttribute('data-a') || t.getAttribute('data-act') || t.getAttribute('data-save') || t.getAttribute('data-test'));
    if (a) bits.push('[' + a + ']');
    var cls = typeof t.className === 'string' ? t.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
    if (cls) bits.push('.' + cls);
    var label = (t.getAttribute && (t.getAttribute('aria-label') || t.getAttribute('title'))) || (tag === 'input' ? (t.type || '') + (t.type === 'checkbox' ? (t.checked ? ' on' : ' off') : '') : (t.textContent || '').replace(/\s+/g, ' ').trim());
    if (tag === 'a' && t.getAttribute('href')) bits.push(t.getAttribute('href').slice(0, 60));
    return bits.join('') + (label ? ' “' + clip(label, 50) + '”' : '');
  };
  // PINs and passwords never get in: not their keys, not the PIN pad's buttons.
  var PRIVATE = '.pin-dlg,.pin-keys,[data-pin],[data-private],input[type=password]';
  var isPrivate = function (el) { try { return !!(el && el.closest && el.closest(PRIVATE)); } catch (e) { return false; } };
  document.addEventListener('click', function (e) { crumb('click', isPrivate(e.target) ? 'PIN pad' : describe(e.target)); }, true);
  document.addEventListener('keydown', function (e) {
    var k = e.key || e.keyCode;
    var el = e.target || {};
    var field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '') || el.isContentEditable;
    // Navigation and remote keys only — nothing typed into a field, nothing on the PIN pad.
    if (isPrivate(el) || isPrivate(document.activeElement)) { if (k === 'Enter' || k === 'Escape' || k === 13 || k === 27) crumb('key', 'PIN pad ' + k); return; }
    if (field && !/^(Enter|Escape|Tab|ArrowUp|ArrowDown)$/.test(k) && k !== 13 && k !== 27) return;
    if (/^(Arrow|Enter|Escape|Backspace|Media|Channel|Page|Home|End|Tab|GoBack|Back|Info|ColorF|XF86)/.test(k) || (typeof k === 'number' && k > 0) || (k && k.length === 1)) crumb('key', (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + k);
  }, true);
  window.addEventListener('hashchange', function () { crumb('nav', location.hash); });
  window.addEventListener('online', function () { crumb('net', 'online'); });
  window.addEventListener('offline', function () { crumb('net', 'offline'); });
  document.addEventListener('visibilitychange', function () { crumb('app', 'page ' + document.visibilityState); if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); flush(true); } else visibleAt = Date.now(); });
  window.addEventListener('pagehide', function () { flush(true); });

  // Server calls: method, path, status and time (not the bodies; query strings scrubbed).
  var rawFetch = window.fetch;
  if (window.fetch) {
    var of = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      var t = Date.now();
      var mine = /^\/|^https?:\/\/[^\/]*$/.test(url) || url.indexOf(location.origin) === 0;
      var path = mine ? url.replace(location.origin, '') : url.replace(/^(https?:\/\/[^\/]+).*$/, '$1/…');
      var p = of.apply(this, arguments);
      if (path.indexOf('/api/client-errors') >= 0 || path.indexOf('/api/presence') >= 0 || path.indexOf('/api/stats/') >= 0) return p;
      return p.then(function (r) { crumb('api', method + ' ' + path + ' → ' + r.status + ' (' + (Date.now() - t) + ' ms)'); return r; }, function (e) { crumb('api', method + ' ' + path + ' → failed: ' + (e && e.message) + ' (' + (Date.now() - t) + ' ms)'); throw e; });
    };
  }
  // Warnings and errors written to the console show up as breadcrumbs; errors are reported too.
  var wrapConsole = function (name) {
    var c = window.console;
    if (!c || !c[name]) return;
    var orig = c[name];
    c[name] = function () {
      try {
        var args = Array.prototype.slice.call(arguments);
        var text = args.map(function (a) { return a instanceof Error ? (a.name + ': ' + a.message) : typeof a === 'object' ? (function () { try { return JSON.stringify(a); } catch (e) { return String(a); } })() : String(a); }).join(' ');
        crumb('log', name + ': ' + text);
        if (name === 'error') {
          var err = args.filter(function (a) { return a instanceof Error; })[0];
          report('console', err || { message: text }, {});
        }
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  };
  wrapConsole('warn');
  wrapConsole('error');

  // ------------------------------------------------------------ the state of things when it happened
  var player = function () {
    var p = V.player;
    if (!p || !p.it) return null;
    try {
      var v = p.video || {};
      var a = p.attempt || {};
      var buf = 0;
      try { for (var i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) >= v.currentTime) buf = v.buffered.end(i) - v.currentTime; } catch (e) {}
      var o = {
        item: { k: p.it.k, t: p.it.t, n: clip(p.it.n, 80), alt: p.alt, backups: (p.it.a || []).length },
        route: p._routeName ? p._routeName(a) : '', via: a.via || '', kind: a.kind || a.mode || '', started: !!p.started, vod: !!p.vod,
        pos: Math.round(v.currentTime || 0), dur: isFinite(v.duration) ? Math.round(v.duration) : 'live', paused: !!v.paused, rate: v.playbackRate,
        ready: v.readyState, net: v.networkState, buffered: Math.round(buf * 10) / 10, size: (v.videoWidth || 0) + 'x' + (v.videoHeight || 0),
        reconnects: p.reconnects || 0, session: !!p.sessionId, offset: p.offset || 0, ext: !!p.extPlayer,
      };
      if (v.error) o.mediaError = v.error.code + (v.error.message ? ' ' + clip(v.error.message, 160) : '');
      if (p.hls) { try { o.hls = { level: p.hls.currentLevel, levels: (p.hls.levels || []).length, bw: Math.round((p.hls.bandwidthEstimate || 0) / 1000) + ' kbps', audio: p.hls.audioTrack, subs: p.hls.subtitleTrack }; } catch (e) {} }
      if (v.textTracks) { var on = []; for (var j = 0; j < v.textTracks.length; j++) if (v.textTracks[j].mode === 'showing') on.push(v.textTracks[j].label || v.textTracks[j].language); if (on.length) o.subsOn = on.join(', '); }
      if (p.audioTrack !== undefined) o.audioTrack = p.audioTrack;
      return o;
    } catch (e) { return { error: 'couldn’t read the player: ' + e.message }; }
  };
  var context = function () {
    var n = navigator, c = n.connection || {}, S = V.S || {}, d = V.device || {};
    var o = {
      device: d.name || '', tv: !!d.tv, touch: !!d.touch, ua: n.userAgent, platform: n.platform || '', lang: n.language || '',
      tz: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return ''; } })(),
      screen: (screen.width || 0) + 'x' + (screen.height || 0) + '@' + (window.devicePixelRatio || 1), viewport: innerWidth + 'x' + innerHeight,
      online: n.onLine !== false, conn: c.effectiveType ? c.effectiveType + (c.downlink ? ' ' + c.downlink + ' Mbps' : '') + (c.saveData ? ' save-data' : '') : '',
      memGB: n.deviceMemory || undefined, cores: n.hardwareConcurrency || undefined,
      heapMB: window.performance && performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + '/' + Math.round(performance.memory.jsHeapSizeLimit / 1048576) : undefined,
      upFor: Math.round((Date.now() - T0) / 1000) + ' s', visible: document.visibilityState, standalone: !!(window.matchMedia && matchMedia('(display-mode: standalone)').matches),
      sw: !!(n.serviceWorker && n.serviceWorker.controller), https: location.protocol === 'https:',
      profile: S.profile ? (S.profile.name + (S.profile.admin ? ' (admin)' : '') + (S.profile.kids ? ' (kids)' : '')) : '(choosing a profile)',
      theme: document.documentElement.getAttribute('data-theme') || undefined,
    };
    var pl = player();
    if (pl) o.player = pl;
    return o;
  };
  var snapCrumbs = function () {
    var now = Date.now();
    return crumbs.map(function (c) { return { t: now - c.at, k: c.k, m: c.m + (c.n > 1 ? ' (×' + c.n + ')' : '') }; });
  };

  // ------------------------------------------------------------ reporting
  var hiddenAt = 0, visibleAt = 0; // (a page just back on screen had its timers slowed while hidden: not a freeze)
  /**
   * Reports a problem. kind: error | rejection | console | shown | playback | resource | startup | freeze | user.
   * err: an Error, or { message, stack, source: { file, line, col } }. extra: anything that helps (kept small).
   * "user" is a viewer's own report (Report a problem): never dropped as a repeat, sent straight away, at most 5 in
   * 10 minutes. Returns true when it will be sent.
   */
  var report = V.reportError = function (kind, err, extra) {
    try {
      err = err || {};
      var mine = kind === 'user';
      var message = clip(scrub(err.message || err.reason || String(err)), 1000);
      if (mine) {
        var t0 = Date.now();
        userSent = userSent.filter(function (t) { return t0 - t < 10 * 60e3; });
        if (userSent.length >= 5 || !message) return false;
        userSent.push(t0);
      }
      if (!message || message === 'Script error.' && !err.stack) return; // (another site's script: nothing to go on)
      if (/AbortError|ResizeObserver loop|The play\(\) request was interrupted|NotAllowedError: play\(\) failed/i.test((err.name || '') + ': ' + message)) return;
      var stack = clip(scrub(err.stack || ''), 12000);
      var top = (/(app\.js[^\s)]*:\d+:\d+)/.exec(stack) || [])[1] || (err.source ? err.source.line : '');
      var fp = kind + '|' + message.replace(/\d+/g, '#').slice(0, 160) + '|' + String(top).replace(/\?v=[\w-]+/, '');
      var s = seen[fp];
      var now = Date.now();
      if (mine) s = { n: 1 }; // (a viewer's own report: always sent, never counted as a repeat)
      else if (s) {
        s.n++;
        if (now - s.at < 5 * 60e3) return; // the same again soon: counted, sent with the next one
      } else s = seen[fp] = { n: 1 };
      if (sentTotal >= MAX_PAGE && !mine) return;
      s.at = now;
      var count = s.n; s.n = 0;
      if (!mine) sentTotal++;
      queue.push({
        kind: kind, v: appV, at: now, count: count, message: message, name: clip(err.name || '', 80), stack: stack,
        source: err.source ? { file: scrub(err.source.file || ''), line: err.source.line || 0, col: err.source.col || 0 } : undefined,
        page: scrub(location.hash || '/'), ctx: scrubAll(context()), crumbs: snapCrumbs(), extra: scrubAll(extra || {}),
      });
      clearTimeout(timer);
      timer = setTimeout(function () { flush(false); }, mine ? 50 : 1500);
      return true;
    } catch (e) { return false; }
  };

  var KEY = 'errQueue';
  var save = function (list) { try { localStorage.setItem(KEY, JSON.stringify(list.slice(-10))); } catch (e) {} };
  var flush = function (leaving) {
    clearTimeout(timer);
    if (!queue.length) return;
    var batch = queue.splice(0, 10);
    var body = JSON.stringify({ reports: batch });
    // (keepalive requests are limited to 64 KB: drop the breadcrumbs of a big batch when leaving the page)
    if (leaving && body.length > 60000) { batch.forEach(function (r) { r.crumbs = r.crumbs.slice(-15); r.ctx.player = r.ctx.player ? { item: r.ctx.player.item, route: r.ctx.player.route } : undefined; }); body = JSON.stringify({ reports: batch }); }
    var send = rawFetch ? function (u, o) { return rawFetch.call(window, u, o); } : null;
    var failed = function () { save(batch.concat(queue)); };
    if (send) {
      send('/api/client-errors', { method: 'POST', headers: { 'X-App': '1', 'Content-Type': 'application/json' }, body: body, keepalive: leaving && body.length < 64000, credentials: 'same-origin' })
        .then(function (r) { if (r.status >= 500 || r.status === 0) failed(); }, failed);
    } else {
      try { var x = new XMLHttpRequest(); x.open('POST', '/api/client-errors'); x.setRequestHeader('X-App', '1'); x.setRequestHeader('Content-Type', 'application/json'); x.onerror = failed; x.send(body); } catch (e) { failed(); }
    }
    if (queue.length) timer = setTimeout(function () { flush(leaving); }, 2000);
  };
  // Reports that couldn't be sent last time (offline, server restarting): send them now.
  setTimeout(function () {
    var old = null;
    try { old = JSON.parse(localStorage.getItem(KEY) || 'null'); localStorage.removeItem(KEY); } catch (e) {}
    if (old && old.length) { queue = old.concat(queue); flush(false); }
  }, 8000);

  // ------------------------------------------------------------ catching them
  window.addEventListener('error', function (e) {
    var t = e.target;
    // A script or stylesheet that didn't load (not pictures: posters are often missing at the provider).
    if (t && t !== window && t.tagName) {
      // (Not a script the proxy in front added to the page — Cloudflare's analytics, its bot check: the page's
      // security policy stops those, see below.)
      if (/^(SCRIPT|LINK)$/.test(t.tagName) && !/cloudflareinsights\.com|\/cdn-cgi\//i.test(t.src || t.href || '')) report('resource', { message: t.tagName.toLowerCase() + ' didn’t load: ' + scrub(t.src || t.href || '') });
      return;
    }
    var err = e.error;
    // mpegts.js still adding video to a player the browser already gave up on (a decode error the player handles by
    // reconnecting): a knock-on effect, not a fault of its own.
    if (err && err.name === 'InvalidStateError' && /vendor\/mpegts/.test(String(err.stack || e.filename || ''))) { crumb('log', 'mpegts: ' + err.message); return; }
    if (err && err instanceof Error) report('error', err);
    else report('error', { message: e.message || 'Unknown error', source: { file: e.filename, line: e.lineno, col: e.colno } });
  }, true);
  // Something the page's security policy stopped (server.js CSP) — it shouldn't happen: reported, so a part of the app
  // the policy doesn't know about is found out rather than quietly not working. (Not a browser extension's doing, and
  // only where it came from, never a whole address.)
  var cspSeen = 0;
  document.addEventListener('securitypolicyviolation', function (e) {
    var from = String(e.sourceFile || '');
    if (/^(chrome|moz|safari-web|ms-browser)-extension:/i.test(from) || cspSeen >= 5) return;
    var what = String(e.blockedURI || '');
    // (Nor a proxy in front adding scripts of its own to the page — Cloudflare's analytics and bot checks do: those
    // are stopped too, which the app doesn't mind. Noted, not reported.)
    var proxys = /cloudflareinsights\.com|\/cdn-cgi\//i.test(what);
    if (!proxys && what === 'inline') { try { var ss = document.scripts, si; for (si = 0; si < ss.length; si++) if (!ss[si].src && /cdn-cgi|__CF\$/.test(ss[si].textContent || '')) proxys = true; } catch (x) {} }
    if (proxys) { crumb('log', 'security policy stopped a script the proxy in front added'); return; }
    var m = /^(https?|wss?):\/\/[^/?#]+/i.exec(what);
    what = m ? m[0] : what.slice(0, 20);
    cspSeen++;
    report('resource', { message: 'Stopped by the page’s security policy: ' + String(e.effectiveDirective || e.violatedDirective || '').slice(0, 40) + ' ' + what + (from ? ' (from ' + from.split(/[?#]/)[0].split('/').slice(-1)[0].slice(0, 40) + ':' + (e.lineNumber || 0) + ')' : '') });
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    if (r && (r.offline || r.proxy)) return; // (the server couldn't be reached, or the proxy in front of it answered: not a bug)
    if (r && r.status && r.status < 500) return; // (the server said no — a message the viewer saw, not a bug)
    // The in-browser converter tidying up after a conversion that was stopped or failed (its error was already
    // handled — the player moved on to another way of playing): a knock-on effect, not a fault of its own.
    // (Safari words it "Cannot close a writable stream that is closed or errored"; a read the converter still had going
    // when it was stopped — the provider saying 503, busy — ends the same way.)
    if (r && /writable stream|already canceled|^Error fetching |aborted/i.test(String(r.message || '')) && /vendor\/mediabunny/.test(String(r.stack || ''))) { crumb('log', 'mediabunny: ' + scrub(String(r.message))); return; }
    report('rejection', r instanceof Error ? r : { message: (r && r.message) || (typeof r === 'string' ? r : (function () { try { return JSON.stringify(r); } catch (x) { return String(r); } })()), stack: r && r.stack });
  });
  // The page froze (nothing ran for a long time while it was on screen): usually a slow loop on a slow device.
  // Not a freeze: the computer or phone sleeping, the screen locked, or the browser slowing the page's timers down
  // (a covered window, battery saving, a phone app in the background). Those show up as a long gap too, but other
  // things (server calls, events) still ran during it, the browser said it was suspending the page, or the gap is
  // far longer than anyone would sit through. A real freeze is one somebody was there for: they'd just tapped,
  // clicked or pressed a key, or something was playing.
  var tick = Date.now(), suspendedAt = 0, inputAt = 0;
  var markSuspended = function () { suspendedAt = Date.now(); };
  document.addEventListener('freeze', markSuspended);   // (Chrome's page lifecycle: the page is being frozen)
  document.addEventListener('resume', markSuspended);
  window.addEventListener('pageshow', function (e) { if (e.persisted) markSuspended(); });
  var userInput = function () { inputAt = Date.now(); };
  document.addEventListener('pointerdown', userInput, true);
  document.addEventListener('keydown', userInput, true);
  document.addEventListener('touchstart', userInput, true);
  setInterval(function () {
    var now = Date.now(), gap = now - tick, from = tick;
    tick = now;
    // (Over 2 minutes: asleep, not frozen — nobody sits through that without reloading, and an iPhone's home-screen app
    // goes on saying it's on screen while the phone has put it to sleep.)
    if (gap <= 8000 || gap > 120e3 || document.visibilityState !== 'visible' || now - hiddenAt <= gap + 2000 || now - visibleAt <= gap + 2000 || now - suspendedAt <= gap + 2000) return;
    // Something else ran during the "freeze" (a server call finished, a click was noted…): the page wasn't stuck,
    // only this timer was held back.
    // (Only after the moment this 1-second timer should have run: whatever started the freeze — the tap, a server
    // answer — is often noted just before the heavy work, in the same moment.)
    for (var i = crumbs.length - 1; i >= 0; i--) { var c = crumbs[i]; if (c.at > from + 1500 && c.at < now - 50) return; if (c.at <= from) break; }
    var vid = document.querySelector('video');
    var watching = !!(vid && !vid.paused && !vid.ended);
    if (!watching && !(inputAt && inputAt <= from + 1500 && from - inputAt < 15000)) return; // nobody was there to notice
    report('freeze', { message: 'The page didn’t respond for ' + Math.round(gap / 1000) + ' seconds' }, { seconds: Math.round(gap / 1000), after: watching ? 'while playing' : Math.round((from - inputAt) / 1000) + ' s after a tap, click or key' });
  }, 1000);

  // The app's own failures (see core.js V.fail and player.js) report through V.reportError; startup sets this.
  V._errorsReady = true;
  crumb('app', 'page loaded' + (appV ? ' (app ' + appV + ')' : ''));
})();
