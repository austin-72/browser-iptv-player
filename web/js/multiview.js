/* Multiview: several live channels on screen at once. Sound comes from the one with focus (click it, or OK on a
   remote). Each tile is its own connection to the provider: the household's connection limits, "who's using it",
   take-over and priority viewers all apply to tiles too (they're reported with presence). */
'use strict';
(function () {
  var MAX_TV = 9, MAX_PHONE = 2;
  var state = { keys: [], focus: 0, layout: 'auto' }; // kept on this device
  var tiles = []; // { it, alt, el, v, hls, mts, token, tries }
  var active = false, view = null;
  var phone = function () { return window.innerWidth <= 760; };
  var max = function () { return phone() ? MAX_PHONE : MAX_TV; };

  function load() {
    var s = V.ls.get('multiview', null);
    if (s && s.keys) state = { keys: s.keys.filter(function (k) { return V.entry(k); }), focus: s.focus || 0, layout: s.layout || 'auto' };
    if (state.keys.length > max()) state.keys = state.keys.slice(0, max());
    if (state.focus >= state.keys.length) state.focus = 0;
  }
  function save() { V.ls.set('multiview', state); }

  // ---------------------------------------------------------------- presence: every tile is a connection
  function report(skip) {
    if (!S.conn) return Promise.resolve();
    var hide = V.pref('presence') === false;
    var multi = active ? tiles.filter(function (t, i) { return i !== skip && t.live; }).map(function (t) { return { k: t.it.k, n: hide ? '' : t.it.n, alt: t.alt, hidden: hide || undefined }; }) : [];
    var np = S.nowPlaying;
    return V.api('/api/presence', { body: { conn: S.conn, playing: np ? { k: np.k, n: np.n, alt: np.alt, pos: np.pos, hidden: np.hidden } : null, multi: multi } }).catch(function () {});
  }

  // ---------------------------------------------------------------- the provider's connections
  /** Before a tile starts: is there a free connection? Resolves { alt } to play, or null (cancelled). */
  function claim(it, replacing) {
    return report(replacing).then(function () {
      return V.api('/api/play/sources', { body: { k: it.k, origin: location.origin } });
    }).then(function (r) {
      var srcs = r.sources || [];
      if (!srcs.length) return { alt: -1 };
      var s0 = srcs[0];
      if (!r.allBusy) {
        // A priority viewer: take a connection from a standard profile automatically.
        // (Not this device's own tiles, though: ask which one to replace instead.)
        if (s0.bump && s0.bump.length) {
          var bump = s0.bump;
          if (bump.some(function (b) { return b.conn === S.conn && b.tile; })) {
            var others = (s0.by || []).filter(function (b) { return !(b.conn === S.conn && b.tile) && (b.mine || !b.priority); });
            if (others.length < bump.length) return busy(it, srcs);
            bump = others.slice(0, bump.length);
          }
          return takeOver(bump).then(function () { return { alt: s0.alt }; });
        }
        return { alt: s0.alt };
      }
      return busy(it, srcs);
    }, function () { return { alt: -1 }; });
  }
  function takeOver(list) {
    list.forEach(function (b) { V.api('/api/devices/' + b.conn + '/command', { body: { cmd: 'takeover', k: b.k } }).catch(function () {}); });
    V.toast('Taking the connection…', { ms: 3000 });
    return new Promise(function (res) { setTimeout(res, 3500); });
  }
  function busy(it, srcs) {
    var by = [];
    srcs.forEach(function (x) { (x.by || []).forEach(function (b) { if (!by.some(function (y) { return y.conn === b.conn && y.k === b.k; })) by.push(b); }); });
    var s0 = srcs[0], lim = s0.limit;
    var allowed = (s0.name || 'The provider') + ' allows ' + (lim === 1 ? 'one stream' : lim + ' streams') + ' at a time.';
    var mineHere = by.filter(function (b) { return b.mine && b.tile && b.conn === S.conn; });
    var others = by.filter(function (b) { return !(b.mine && b.tile && b.conn === S.conn); });
    var locked = srcs.every(function (x) { return x.locked; });
    var free = others.filter(function (b) { return b.mine || !b.priority; });
    var acts = [{ label: 'Cancel', value: null }];
    // Your own tiles use them: offer to replace one.
    mineHere.forEach(function (b) {
      var idx = tiles.map(function (t) { return t.it.k; }).indexOf(b.k);
      if (idx >= 0) acts.push({ label: 'Replace “' + b.n + '”', value: { replace: idx } });
    });
    if (!locked && free.length) acts.push({ label: free[0].mine ? 'Move it here' : 'Take over', primary: true, value: { take: true } });
    var who = others[0] || mineHere[0] || {};
    var body = '<p>' + (mineHere.length && !others.length ? 'Your multiview already uses every connection to this provider. ' : locked ? V.esc(who.name) + ' has priority, and priority viewers can’t be taken over. ' : V.esc(who.name || 'Someone') + ' is watching “' + V.esc(who.n || '') + '” on ' + V.esc(who.device || 'another device') + '. ') + V.esc(allowed) + '</p>';
    return V.dialog({ title: 'No free connection for “' + it.n + '”', body: body, actions: acts }).then(function (v) {
      if (!v) return null;
      if (v.take) return takeOver(free).then(function () { return { alt: s0.alt }; });
      if (v.replace !== undefined) { removeTile(v.replace, true); return report().then(function () { return { alt: s0.alt }; }); }
      return null;
    });
  }

  // ---------------------------------------------------------------- one tile's playback
  function teardown(t) {
    t.token++;
    t.live = false;
    clearTimeout(t.retry);
    if (t.hls) { try { t.hls.destroy(); } catch (e) {} t.hls = null; }
    if (t.mts) { try { t.mts.destroy(); } catch (e) {} t.mts = null; }
    if (t.v) { try { t.v.removeAttribute('src'); t.v.load(); } catch (e) {} }
  }
  function msg(t, text, spin) {
    var m = V.$('.mv-msg', t.el);
    if (!m) return;
    m.hidden = !text && !spin;
    m.innerHTML = (spin ? '<div class="spinner"></div>' : '') + (text ? '<span>' + V.esc(text) + '</span>' : '');
  }
  function start(t) {
    teardown(t);
    var token = ++t.token, it = t.it;
    t.live = true; // (counts as a connection from the moment it asks for one)
    msg(t, '', true);
    var mixed = location.protocol === 'https:' && /^http:/i.test(it.u || '') && V.mixedOk && !(V.relayOn && V.relayOn()) ? V.mixedOk(it.u) : Promise.resolve(false);
    mixed.then(function (mok) {
      return V.api('/api/play/reach', { body: { k: it.k, alt: t.alt, origin: location.origin, ua: navigator.userAgent, mixedOk: mok || undefined } }).catch(function () { return null; });
    }).then(function (info) {
      if (token !== t.token) return;
      var routes = info && !info.blocked && info.kind !== 'ffmpeg' ? V.Player.prototype._directRoutes(info, it).filter(function (r) { return r.kind === 'hls' || r.kind === 'ts' || r.kind === 'native'; }) : [];
      if ((S.settings.routing || '') === 'server') routes = [];
      if ((S.settings.routing || '') !== 'direct-only') routes.push({ via: 'relay' });
      tryRoute(t, token, routes, 0);
    });
  }
  function tryRoute(t, token, routes, i) {
    if (token !== t.token) return;
    if (i >= routes.length) return failed(t, 'This channel didn’t start.');
    var r = routes[i];
    var prep = r.via === 'relay'
      ? V.api('/api/play/relay', { body: { k: t.it.k, alt: t.alt, sniff: true } }).then(function (x) { return { kind: x.kind, url: x.url }; })
      : Promise.resolve({ kind: r.kind, url: r.url, native: r.native });
    prep.then(function (g) { return attach(t, token, g, r.via === 'relay' ? 25000 : 12000); }).then(function () {
      if (token !== t.token) return;
      t.tries = 0;
      msg(t, '');
    }, function () {
      if (token !== t.token) return;
      if (t.hls) { try { t.hls.destroy(); } catch (e) {} t.hls = null; }
      if (t.mts) { try { t.mts.destroy(); } catch (e) {} t.mts = null; }
      tryRoute(t, token, routes, i + 1);
    });
  }
  function attach(t, token, g, wait) {
    var v = t.v;
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () { finish(new Error('timeout')); }, wait);
      var finish = function (e) { if (done) return; done = true; clearTimeout(timer); v.removeEventListener('playing', onPlay); v.removeEventListener('error', onErr); if (e) reject(e); else resolve(); };
      var onPlay = function () { finish(); };
      var onErr = function () { finish(new Error('media error')); };
      v.addEventListener('playing', onPlay);
      v.addEventListener('error', onErr);
      var play = function () { var p = v.play(); if (p && p.catch) p.catch(function () { if (!v.muted) { v.muted = true; v.play().catch(function () {}); sound(); } }); };
      var lost = function () { if (token === t.token && t.live) again(t); };
      if (!g || !g.kind || g.kind === 'dash') return finish(new Error('format'));
      if ((g.kind === 'hls' && g.native) || g.kind === 'native') { v.src = g.url; play(); return; }
      if (g.kind === 'hls') {
        (window.Hls ? Promise.resolve() : V.loadScript('/vendor/hls.min.js')).then(function () {
          if (token !== t.token) return finish(new Error('gone'));
          if (!(window.Hls && Hls.isSupported())) { if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = g.url; return play(); } return finish(new Error('no hls')); }
          var h = new Hls({ enableWorker: true, maxBufferLength: 10, backBufferLength: 0, capLevelToPlayerSize: true, abrEwmaDefaultEstimate: 1500000, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 3 });
          t.hls = h;
          h.on(Hls.Events.ERROR, function (_, d) { if (d.fatal) { if (!done) finish(new Error(d.details)); else lost(); } });
          h.loadSource(g.url);
          h.attachMedia(v);
          play();
        }, function (e) { finish(e); });
        return;
      }
      if (g.kind === 'ts') {
        (window.mpegts ? Promise.resolve() : V.loadScript('/vendor/mpegts.js')).then(function () {
          if (token !== t.token) return finish(new Error('gone'));
          if (!(window.mpegts && mpegts.getFeatureList().mseLivePlayback)) return finish(new Error('no ts'));
          var p = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: new URL(g.url, location.href).href }, { enableWorker: true, lazyLoad: false, autoCleanupSourceBuffer: true, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 10, liveBufferLatencyMinRemain: 2 });
          t.mts = p;
          p.on(mpegts.Events.ERROR, function () { if (!done) finish(new Error('ts error')); else lost(); });
          p.attachMediaElement(v);
          p.load();
          play();
        }, function (e) { finish(e); });
        return;
      }
      finish(new Error('format'));
    });
  }
  // It stopped after it had started: try again a few times, then say so.
  function again(t) {
    if (++t.tries > 4) return failed(t, 'This channel stopped.');
    msg(t, 'Reconnecting…', true);
    clearTimeout(t.retry);
    t.retry = setTimeout(function () { if (active && tiles.indexOf(t) >= 0) start(t); }, 2500 * t.tries);
  }
  function failed(t, text) {
    teardown(t);
    report();
    var m = V.$('.mv-msg', t.el);
    if (!m) return;
    m.hidden = false;
    m.innerHTML = '<span>' + V.esc(text) + '</span><button class="btn sm" data-act="retry">Try again</button>';
  }

  // ---------------------------------------------------------------- drawing
  function layoutOf(n) {
    if (n <= 1) return 'one';
    if (phone()) return 'stack';
    if (n === 2) return 'two';
    var big = state.layout === 'big' || (state.layout === 'auto' && n === 3);
    if (big && n <= 4) return 'big';
    return 'grid';
  }
  function gridStyle(n, lay) {
    if (lay === 'grid') { var cols = Math.ceil(Math.sqrt(n)); var rows = Math.ceil(n / cols); return 'grid-template-columns:repeat(' + cols + ',1fr);grid-template-rows:repeat(' + rows + ',1fr)'; }
    if (lay === 'big') return 'grid-template-columns:3fr 1fr;grid-template-rows:repeat(' + (n - 1) + ',1fr)';
    if (lay === 'two') return 'grid-template-columns:1fr 1fr;grid-template-rows:1fr';
    return '';
  }
  function label(t) {
    var it = t.it, nn = V.epg.nowNext(it);
    return '<div class="mv-lab">' + (it.no ? '<span class="mv-no">' + it.no + '</span>' : '') + '<b class="truncate">' + V.esc(it.n) + '</b>' + (nn.now ? '<small class="truncate">' + V.esc(nn.now.t) + '</small>' : '') + '</div>';
  }
  function draw() {
    if (!view) return;
    var n = tiles.length, lay = layoutOf(n);
    var canLayout = !phone() && (n === 3 || n === 4);
    view.innerHTML = '<div class="mv">' +
      '<header class="mv-bar"><button class="icon-btn" data-mv="back" aria-label="Back">' + V.icon('back') + '</button><h1>Multiview</h1>' +
      '<span class="mv-hint dim small">' + (n ? (V.tvMode ? 'OK: sound · Menu: options' : 'Click a channel for its sound') : '') + '</span><span class="sp"></span>' +
      (canLayout ? '<div class="chips mv-lay" role="group" aria-label="Layout"><button class="chip' + (lay === 'grid' ? ' on' : '') + '" data-lay="equal" aria-pressed="' + (lay === 'grid') + '">' + V.icon('grid') + ' Equal</button><button class="chip' + (lay === 'big' ? ' on' : '') + '" data-lay="big" aria-pressed="' + (lay === 'big') + '">' + V.icon('mini') + ' One big</button></div>' : '') +
      (n < max() ? '<button class="btn" data-mv="add">' + V.icon('plus') + ' Add a channel</button>' : '<span class="dim small">' + (phone() ? 'Two channels at once on a phone' : 'Up to ' + MAX_TV + ' channels') + '</span>') +
      '</header>' +
      (n ? '<div class="mv-grid mv-' + lay + '" style="' + gridStyle(n, lay) + '"></div>'
        : '<div class="empty"><h2>Watch several channels at once</h2><p>Add two or more live channels. Sound comes from the one you pick.</p><button class="btn primary" data-mv="add">' + V.icon('plus') + ' Add a channel</button></div>') +
      '</div>';
    var grid = V.$('.mv-grid', view);
    tiles.forEach(function (t, i) {
      var on = i === state.focus;
      var el = t.el || document.createElement('div');
      if (!t.el) {
        el.innerHTML = '<video playsinline muted></video><div class="mv-msg" hidden></div><div class="mv-top"><span class="mv-snd"></span></div><div class="mv-info"></div>' +
          '<div class="mv-acts"><button class="pbtn" data-act="sound" aria-label="Sound from this channel">' + V.icon('vol') + '</button><button class="pbtn" data-act="swap" aria-label="Change channel">' + V.icon('tv') + '</button><button class="pbtn" data-act="full" aria-label="Full screen">' + V.icon('fs') + '</button><button class="pbtn" data-act="remove" aria-label="Remove">' + V.icon('x') + '</button></div>';
        t.el = el;
        t.v = V.$('video', el);
      }
      el.className = 'mv-tile' + (on ? ' on' : '') + (lay === 'big' && on ? ' big' : '');
      el.tabIndex = 0;
      el.dataset.i = i;
      el.setAttribute('aria-label', t.it.n + (on ? ' — sound on' : ''));
      V.$('.mv-info', el).innerHTML = label(t);
      grid.appendChild(el);
    });
    sound();
  }
  function sound() {
    tiles.forEach(function (t, i) {
      var on = i === state.focus;
      if (t.v) { t.v.muted = !on; if (on && t.v.paused && t.live) t.v.play().catch(function () {}); }
      if (t.el) {
        t.el.classList.toggle('on', on);
        var s = V.$('.mv-snd', t.el);
        if (s) s.innerHTML = on ? V.icon(t.v && t.v.muted ? 'mute' : 'vol') : '';
      }
    });
  }
  function setFocus(i) {
    if (i < 0 || i >= tiles.length) return;
    var relayout = layoutOf(tiles.length) === 'big' && i !== state.focus;
    state.focus = i; save();
    if (relayout) draw(); else sound();
    var t = tiles[i];
    if (t.v && t.v.muted && t.live) { t.v.muted = false; t.v.play().catch(function () {}); }
  }

  // ---------------------------------------------------------------- changes
  function addTile(it, alt) {
    var t = { it: it, alt: alt, el: null, v: null, token: 0, tries: 0, live: false };
    tiles.push(t);
    state.keys = tiles.map(function (x) { return x.it.k; });
    if (tiles.length === 1) state.focus = 0;
    save();
    draw();
    start(t);
    report();
  }
  function removeTile(i, quiet) {
    var t = tiles[i];
    if (!t) return;
    teardown(t);
    tiles.splice(i, 1);
    if (t.el) t.el.remove();
    if (state.focus >= tiles.length) state.focus = Math.max(0, tiles.length - 1);
    else if (i < state.focus) state.focus--;
    state.keys = tiles.map(function (x) { return x.it.k; });
    save();
    if (!quiet) { draw(); report(); }
  }
  function swapTile(i, it) {
    var t = tiles[i];
    if (!t) return;
    teardown(t);
    report();
    claim(it, i).then(function (c) {
      if (!c) { start(t); return; } // (cancelled: back to what it was)
      t.it = it; t.alt = c.alt; t.tries = 0;
      state.keys = tiles.map(function (x) { return x.it.k; });
      save(); draw(); start(t); report();
    });
  }
  function add(it) {
    if (!it || it.t !== 'live') return;
    if (tiles.some(function (t) { return t.it.k === it.k; })) return V.toast('“' + it.n + '” is already in the multiview');
    if (tiles.length >= max()) return V.toast(phone() ? 'A phone shows two channels at once' : 'Multiview shows up to ' + MAX_TV + ' channels');
    return claim(it).then(function (c) { if (c && active) addTile(it, c.alt); });
  }

  /** A list of channels to pick from (favourites first). */
  function pick(title) {
    var used = tiles.map(function (t) { return t.it.k; });
    var list = S.live.filter(function (c) { return used.indexOf(c.k) < 0; });
    var favs = list.filter(function (c) { return V.inList('favs', c.k); });
    list = favs.concat(list.filter(function (c) { return favs.indexOf(c) < 0; }));
    var row = function (c) { var nn = V.epg.nowNext(c); return '<button class="mv-pick-i" data-k="' + V.esc(c.k) + '">' + (c.no ? '<span class="num">' + c.no + '</span>' : '') + V.art(c.i, c.n, 'art sm') + '<span class="b"><b>' + V.esc(c.n) + '</b>' + (nn.now ? '<small class="dim">' + V.esc(nn.now.t) + '</small>' : '') + '</span></button>'; };
    return V.dialog({
      title: title || 'Add a channel', cls: 'mv-pick-dlg',
      body: '<input class="input" type="search" data-f placeholder="Find a channel or number" aria-label="Find a channel"><div class="mv-pick"></div>',
      onOpen: function (d, finish) {
        var box = V.$('.mv-pick', d);
        var drawList = function (q) {
          var nq = V.norm(q || '');
          var rows = list.filter(function (c) { return !nq || V.norm(c.n).indexOf(nq) >= 0 || String(c.no) === q; }).slice(0, 300);
          box.innerHTML = rows.map(row).join('') || '<p class="dim">No channels match.</p>';
        };
        drawList('');
        V.$('[data-f]', d).addEventListener('input', function (e) { drawList(e.target.value); });
        box.addEventListener('click', function (e) { var b = e.target.closest('[data-k]'); if (b) finish(V.entry(b.dataset.k)); });
      },
    });
  }

  function stopAll() { tiles.forEach(teardown); }
  function full(i) {
    var t = tiles[i];
    if (!t) return;
    // The tiles stop while it plays full screen (they'd use connections of their own); Back comes back here.
    stopAll();
    active = false;
    report();
    V.play(t.it, { list: tiles.map(function (x) { return x.it; }) });
  }
  function tileMenu(i, anchor) {
    var t = tiles[i];
    if (!t) return;
    V.menu(anchor || t.el, [
      { header: t.it.n },
      { label: 'Sound from this channel', icon: 'vol', fn: function () { setFocus(i); } },
      { label: 'Change channel', icon: 'tv', fn: function () { pick('Change “' + t.it.n + '”').then(function (it) { if (it) swapTile(i, it); }); } },
      { label: 'Full screen', icon: 'fs', fn: function () { full(i); } },
      { sep: true },
      { label: 'Remove', icon: 'x', fn: function () { removeTile(i); } },
    ], { align: 'left' });
  }

  // ---------------------------------------------------------------- the page
  V.route('multiview', function (v, r) {
    view = v;
    load();
    active = true;
    document.body.classList.add('mv-on');
    tiles = state.keys.map(function (k) { return { it: V.entry(k), alt: -1, el: null, v: null, token: 0, tries: 0, live: false }; }).filter(function (t) { return t.it && t.it.t === 'live'; });
    V.pageCleanup = function () { stopAll(); active = false; document.body.classList.remove('mv-on'); report(); view = null; };
    draw();
    var adding = r.q.get('add') ? V.entry(r.q.get('add')) : null;
    if (r.q.get('add')) history.replaceState(null, '', '#/multiview');
    // The channels already here start one after another (each asks whether its provider has a free connection).
    var chain = Promise.resolve();
    tiles.slice().forEach(function (t) {
      chain = chain.then(function () {
        if (!active || tiles.indexOf(t) < 0) return;
        var i = tiles.indexOf(t);
        return claim(t.it, i).then(function (c) { if (!active) return; if (!c) { removeTile(tiles.indexOf(t)); return; } t.alt = c.alt; start(t); return report(); });
      });
    });
    chain.then(function () {
      if (active && adding && !tiles.some(function (t) { return t.it.k === adding.k; })) return add(adding);
    }).then(function () {
      // Fewer than two: ask for another straight away.
      if (active && view === v && tiles.length < 2) setTimeout(function () { if (active && view === v) pick(tiles.length ? 'Add another channel' : 'Add a channel').then(function (it) { if (it) add(it); }); }, 300);
    });

    v.addEventListener('click', function (e) {
      var b = e.target.closest('[data-mv], [data-lay], [data-act]');
      var tile = e.target.closest('.mv-tile');
      var i = tile ? +tile.dataset.i : -1;
      if (b && b.dataset.mv === 'back') return V.router.back('#/live');
      if (b && b.dataset.mv === 'add') return pick().then(function (it) { if (it) add(it); });
      if (b && b.dataset.lay) { state.layout = b.dataset.lay === 'big' ? 'big' : 'equal'; save(); return draw(); }
      if (b && b.dataset.act && i >= 0) {
        e.stopPropagation();
        var a = b.dataset.act;
        if (a === 'sound') setFocus(i);
        else if (a === 'swap') pick('Change “' + tiles[i].it.n + '”').then(function (it) { if (it) swapTile(i, it); });
        else if (a === 'full') full(i);
        else if (a === 'remove') removeTile(i);
        else if (a === 'retry') { tiles[i].tries = 0; claim(tiles[i].it, i).then(function (c) { if (c) { tiles[i].alt = c.alt; start(tiles[i]); report(); } }); }
        return;
      }
      if (i >= 0) setFocus(i);
    });
    v.addEventListener('dblclick', function (e) { var tile = e.target.closest('.mv-tile'); if (tile && !e.target.closest('[data-act]')) full(+tile.dataset.i); });
    v.addEventListener('keydown', function (e) {
      var tile = e.target.closest && e.target.closest('.mv-tile');
      if (!tile || e.target !== tile) return;
      var i = +tile.dataset.i;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFocus(i); }
      else if (e.key === 'ContextMenu' || e.key === 'Info' || e.keyCode === 93 || e.keyCode === 457 || e.key === 'm') { e.preventDefault(); tileMenu(i, tile); }
      else if (e.key === 'f') { e.preventDefault(); full(i); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeTile(i); }
    });
    // Phones: a long press on a tile opens its options.
    var lp = null;
    v.addEventListener('touchstart', function (e) { var tile = e.target.closest('.mv-tile'); if (!tile || e.target.closest('[data-act]')) return; lp = setTimeout(function () { tileMenu(+tile.dataset.i, tile); }, 600); }, { passive: true });
    v.addEventListener('touchend', function () { clearTimeout(lp); });
    v.addEventListener('touchmove', function () { clearTimeout(lp); }, { passive: true });
    // What's on now: refresh the labels now and then.
    var tick = setInterval(function () { if (!active) return clearInterval(tick); tiles.forEach(function (t) { if (t.el) V.$('.mv-info', t.el).innerHTML = label(t); }); }, 60000);
  });

  // Back from a full-screen tile: the page draws again (V.closePlayer refreshes it) and the tiles start again.
  V.on('playing', function () { if (active && V.watch.it) { stopAll(); active = false; report(); } });
  V.on('rt:connected', function () { if (active) report(); });

  // ---------------------------------------------------------------- ways in
  V.multiview = {
    /** Opens multiview with this channel added (from the player, a channel's menu…). */
    open: function (it) {
      if (V.watch && V.watch.it) V.closePlayer();
      V.router.go('#/multiview' + (it ? '?add=' + encodeURIComponent(it.k) : ''));
    },
    /** Someone took a connection one of the tiles was using (see watch.js "takeover"). */
    takeover: function (d) {
      if (!active || !d.k) return false;
      var i = tiles.map(function (t) { return t.it.k; }).indexOf(d.k);
      if (i < 0) return false;
      var name = tiles[i].it.n;
      removeTile(i);
      V.toast((d.from || 'Someone') + (d.priority ? ' has priority and' : '') + ' needed the connection “' + name + '” was using.', { ms: 10000 });
      return true;
    },
    get active() { return active; },
  };
  // The player's menu, on a live channel.
  V.playerMenuExtras = (function (prev) {
    return function (p, main, pages) {
      if (prev) prev(p, main, pages);
      if (p.it && p.it.t === 'live' && S.live.length > 1) main.push({ label: 'Add to multiview', value: '', fn: function () { V.multiview.open(p.it); } });
    };
  })(V.playerMenuExtras);
})();
