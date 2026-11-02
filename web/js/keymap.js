/* Remote and keyboard buttons (Settings → Remote and keyboard): what the coloured buttons, number keys, Menu/Info,
   the media keys and a few spare keyboard keys do. Each device keeps its own choice (TV remotes differ); the
   profile's default is synced with its settings. Unset buttons keep doing what they always did.
   Also the actions themselves (V.actions), shared with the quick launcher (palette.js). */
'use strict';
(function () {
  // ------------------------------------------------------------ actions
  var player = function () { return V.watch && V.watch.it && V.player && V.player.started ? V.player : null; };
  var needPlayer = function (fn) { return function () { var p = player(); if (!p) return V.toast('Nothing is playing.'); fn(p); }; };
  var liveNow = function () { var it = V.watch && V.watch.it; return !!(it && (it.t === 'live' || it.t === 'radio' || it.t === 'catchup')); };
  var go = function (h) { return function () { V.router.go(h); }; };
  var SLEEPS = [15, 30, 60, 0];
  V.actions = {
    palette: { label: 'Quick launcher', run: function () { if (V.palette) V.palette.open(); } },
    guide: { label: 'TV guide', run: go('#/guide') },
    live: { label: 'Live TV', run: go('#/live') },
    home: { label: 'Home', run: go('#/home') },
    search: { label: 'Search', run: go('#/search') },
    mylist: { label: 'My List', run: go('#/mine') },
    favs: { label: 'Favourite channels', run: go('#/live?g=__fav') },
    last: { label: 'Last channel', run: function () { if (V.watch && V.watch.lastChannel) V.previousChannel(); else V.toast('No previous channel yet.'); } },
    subs: { label: 'Subtitles on / off', run: needPlayer(function (p) { p.toggleSubs(); }) },
    subsnext: { label: 'Next subtitles', run: needPlayer(function (p) {
      var s = p._tracks().subs;
      if (!s) return p.osd('No subtitles for this', 1200);
      var i = s.items.findIndex(function (x) { return x.on; });
      var n = s.items[(i + 1) % s.items.length];
      n.fn(); p.osd('Subtitles: ' + n.label, 1500); p._menuRefresh();
    }) },
    audio: { label: 'Next audio track', run: needPlayer(function (p) { p.cycleAudio(); }) },
    sleep: { label: 'Sleep timer (15, 30, 60 min, off)', run: function () {
      var left = V.sleepLeft ? Math.ceil(V.sleepLeft() / 60000) : 0;
      var next = 15;
      for (var i = 0; i < SLEEPS.length - 1; i++) if (left > 0 && left <= SLEEPS[i]) { next = SLEEPS[i + 1]; break; }
      V.setSleep(next);
    } },
    multiview: { label: 'Multiview', run: function () { if (V.multiview) V.multiview.open(V.watch && V.watch.it && V.watch.it.t === 'live' ? V.watch.it : null); } },
    pip: { label: 'Picture-in-picture', run: needPlayer(function (p) { p.togglePip(); }) },
    soundonly: { label: 'Sound only', run: needPlayer(function (p) { if (V.audioOnly && p.it && p.it.t === 'live') V.audioOnly.toggle(p); else p.osd('Sound only is for live channels', 1500); }) },
    info: { label: 'Stream info', run: needPlayer(function (p) { p.toggleStats(); }) },
    whatson: { label: 'What’s on (live TV)', run: function () { if (liveNow()) V.showLiveCard(); else V.toast('Nothing live is playing.'); } },
    playpause: { label: 'Play / pause', run: needPlayer(function (p) { p.togglePlay(); }) },
    settings: { label: 'Settings', run: go('#/settings') },
  };
  // Other parts of the app, when they're there.
  var addIf = function (id, ok, a) { if (ok) V.actions[id] = a; };
  addIf('queue', V.queue, { label: 'Your queue', run: go('#/mine/queue') });
  addIf('wishlist', V.routes.wishlist, { label: 'Wishlist', run: go('#/wishlist') });
  addIf('follow', V.routes.follow, { label: 'Teams you follow (events)', run: go('#/follow') });
  addIf('viewing', V.routes.viewing, { label: 'Your viewing', run: go('#/viewing') });
  addIf('review', V.routes.review, { label: 'Year in review', run: go('#/review') });
  V.actions.report = { label: 'Report a problem', run: function () { if (V.reportProblem && V.player && V.player.it) V.reportProblem(V.player); else if (V.palette && V.palette.report) V.palette.report(); } };
  var PP = V.Player && V.Player.prototype;
  addIf('subsearlier', PP && PP.nudgeSubs, { label: 'Subtitles earlier (0.1 s)', run: needPlayer(function (p) { p.nudgeSubs(-0.1); }) });
  addIf('subslater', PP && PP.nudgeSubs, { label: 'Subtitles later (0.1 s)', run: needPlayer(function (p) { p.nudgeSubs(0.1); }) });
  addIf('dialogue', PP && PP.setSoundFx, { label: 'Clear dialogue on / off', run: needPlayer(function (p) { p.setSoundFx('clearDialogue', !V.pref('clearDialogue')); }) });
  addIf('night', PP && PP.setSoundFx, { label: 'Night mode on / off', run: needPlayer(function (p) { p.setSoundFx('nightMode', !V.pref('nightMode')); }) });
  /** The label for an action id (including "channel:<key>"). */
  V.actionLabel = function (id) {
    if (!id || id === 'default') return 'Usual';
    if (id === 'none') return 'Nothing';
    if (id.indexOf('channel:') === 0) { var c = V.entry(id.slice(8)); return 'Channel: ' + (c ? c.n : 'not available'); }
    return V.actions[id] ? V.actions[id].label : id;
  };
  V.runAction = function (id) {
    if (!id || id === 'default' || id === 'none') return;
    if (id.indexOf('channel:') === 0) { var c = V.entry(id.slice(8)); if (c) V.play(c); else V.toast('That channel isn’t available here.', { error: true }); return; }
    var a = V.actions[id];
    if (a) a.run();
  };

  // ------------------------------------------------------------ buttons
  var B = function (id, label, names, codes, o) { o = o || {}; return { id: id, label: label, names: names, codes: codes, vk: o.vk, tizen: o.tizen, group: o.group, colour: o.colour, usual: o.usual || 'nothing' }; };
  var BUTTONS = [
    B('red', 'Red', ['ColorF0Red'], [403], { vk: 'VK_RED', tizen: 'ColorF0Red', group: 'colour', colour: '#e53935' }),
    B('green', 'Green', ['ColorF1Green'], [404], { vk: 'VK_GREEN', tizen: 'ColorF1Green', group: 'colour', colour: '#43a047' }),
    B('yellow', 'Yellow', ['ColorF2Yellow'], [405], { vk: 'VK_YELLOW', tizen: 'ColorF2Yellow', group: 'colour', colour: '#fdd835' }),
    B('blue', 'Blue', ['ColorF3Blue'], [406], { vk: 'VK_BLUE', tizen: 'ColorF3Blue', group: 'colour', colour: '#1e88e5' }),
    B('menu', 'Menu', ['ContextMenu'], [93], { group: 'menu', usual: 'options for the highlighted poster or channel' }),
    B('info', 'Info', ['Info'], [457], { vk: 'VK_INFO', tizen: 'Info', group: 'menu', usual: 'options for the highlighted poster or channel' }),
    B('playpause', 'Play/Pause', ['MediaPlayPause'], [179, 10252], { tizen: 'MediaPlayPause', group: 'media', usual: 'play / pause' }),
    B('play', 'Play', ['MediaPlay'], [415, 250], { vk: 'VK_PLAY', tizen: 'MediaPlay', group: 'media', usual: 'play' }),
    B('pause', 'Pause', ['MediaPause'], [19], { vk: 'VK_PAUSE', tizen: 'MediaPause', group: 'media', usual: 'pause' }),
    B('stop', 'Stop', ['MediaStop'], [413, 178], { vk: 'VK_STOP', tizen: 'MediaStop', group: 'media' }),
    B('rewind', 'Rewind', ['MediaRewind'], [412, 227], { vk: 'VK_REWIND', tizen: 'MediaRewind', group: 'media', usual: 'back a few seconds' }),
    B('ffwd', 'Fast forward', ['MediaFastForward'], [417, 228], { vk: 'VK_FAST_FWD', tizen: 'MediaFastForward', group: 'media', usual: 'forward a few seconds' }),
    B('next', 'Next track', ['MediaTrackNext'], [176, 10233, 425], { vk: 'VK_TRACK_NEXT', tizen: 'MediaTrackNext', group: 'media' }),
    B('prev', 'Previous track', ['MediaTrackPrevious'], [177, 10232, 424], { vk: 'VK_TRACK_PREV', tizen: 'MediaTrackPrevious', group: 'media' }),
  ];
  for (var d = 0; d <= 9; d++) BUTTONS.push(B(String(d), String(d), [String(d)], [48 + d, 96 + d], { tizen: String(d), group: 'number', usual: 'channel number on live TV' }));
  [['F2', 113], ['F4', 115], ['F8', 119], ['F9', 120]].forEach(function (f) { BUTTONS.push(B(f[0], f[0], [f[0]], [f[1]], { group: 'spare' })); });
  var byId = {};
  BUTTONS.forEach(function (b) { byId[b.id] = b; });
  var desktop = function () { return !V.device.tv && !V.tvMode && !V.device.touch; };

  /** Which of our buttons a key press is (or null). */
  var buttonOf = function (e) {
    var k = e.key, c = e.keyCode || e.which;
    for (var i = 0; i < BUTTONS.length; i++) {
      var b = BUTTONS[i];
      if (b.group === 'number' && e.shiftKey) continue;
      if (b.names.indexOf(k) >= 0) return b;
      if (b.vk && typeof window[b.vk] === 'number' && window[b.vk] === c) return b;
      // (Key codes only when the browser doesn't name the key: 93 or 19 can be other keys on some keyboards.)
      if ((!k || k === 'Unidentified' || /^U\+/.test(k)) && b.codes.indexOf(c) >= 0) return b;
      if (b.group !== 'number' && b.group !== 'spare' && b.group !== 'menu' && b.codes.indexOf(c) >= 0 && c >= 400) return b;
    }
    return null;
  };
  V.remoteButtons = BUTTONS;
  V.remoteButtonOf = buttonOf;

  // Samsung (Tizen): the coloured, number and media keys only reach the page once registered. (LG webOS, Android
  // TV and HbbTV browsers send the coloured keys as 403–406 without asking.)
  try {
    var tid = window.tizen && window.tizen.tvinputdevice;
    if (tid) {
      var supported = {};
      try { tid.getSupportedKeys().forEach(function (k) { supported[k.name] = true; }); } catch (e) {}
      BUTTONS.concat([{ tizen: 'ChannelUp' }, { tizen: 'ChannelDown' }]).forEach(function (b) { if (b.tizen && (supported[b.tizen] || !Object.keys(supported).length)) { try { tid.registerKey(b.tizen); } catch (e) {} } });
    }
  } catch (e) {}

  // ------------------------------------------------------------ the mapping (this device, else the profile's default)
  var mapping = function () {
    var local = V.ls.get('remoteKeys', null);
    if (local && typeof local === 'object') return local;
    var def = V.pref && V.pref('remoteKeys');
    return def && typeof def === 'object' ? def : {};
  };
  var ownHere = function () { var l = V.ls.get('remoteKeys', null); return !!(l && typeof l === 'object'); };
  var setHere = function (id, act) {
    var m = Object.assign({}, mapping());
    if (!act || act === 'default') delete m[id]; else m[id] = act;
    V.ls.set('remoteKeys', m);
  };
  V.remoteMapping = mapping;

  var inLivePlayer = function () { var l = V.$('#player-layer'); return !!(l && !l.hidden && !(V.watch && V.watch.mini) && liveNow()); };
  window.addEventListener('keydown', function (e) {
    if (!S.profile || e.ctrlKey || e.metaKey || e.altKey) return;
    var b = buttonOf(e);
    if (!b) return;
    var t = e.target;
    if (V.$('dialog[open]') || V.$('.popmenu')) return; // dialogs and menus keep their own keys
    if ((b.group === 'number' || b.group === 'spare' || b.group === 'menu') && t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
    if (b.group === 'spare' && !desktop()) return;
    var act = mapping()[b.id];
    if (!act || act === 'default') return;
    // Number keys keep changing channel while live TV is playing.
    if (b.group === 'number' && inLivePlayer()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (V.crumb) V.crumb('key', 'button ' + b.id + ' → ' + act);
    V.runAction(act);
  }, true);

  // ------------------------------------------------------------ Settings → Remote and keyboard
  var GROUPS = [['colour', 'Coloured buttons'], ['menu', 'Menu and Info'], ['media', 'Media keys'], ['number', 'Number keys'], ['spare', 'Spare keyboard keys']];
  var actionOptions = function (cur, b) {
    var ids = ['default', 'none'].concat(Object.keys(V.actions));
    var html = ids.map(function (id) { return '<option value="' + id + '"' + (id === (cur || 'default') ? ' selected' : '') + '>' + V.esc(V.actionLabel(id)) + '</option>'; }).join('');
    if (cur && cur.indexOf('channel:') === 0) html += '<option value="' + V.esc(cur) + '" selected>' + V.esc(V.actionLabel(cur)) + '</option>';
    return html + '<option value="__channel">A channel…</option>';
  };
  function section() {
    var m = mapping();
    var rows = GROUPS.filter(function (g) { return g[0] !== 'spare' || desktop(); }).map(function (g) {
      var list = BUTTONS.filter(function (b) { return b.group === g[0]; });
      return '<h3>' + g[1] + '</h3>' + (g[0] === 'number' ? '<p class="dim small">While live TV is playing, the number keys still go to a channel number.</p>' : '') +
        '<div class="km-grid">' + list.map(function (b) {
          var hid = 'km-u-' + b.id;
          return '<label class="field km-row"><span>' + (b.colour ? '<i class="km-dot" style="background:' + b.colour + '"></i>' : '') + V.esc(b.label) + (b.group === 'number' || b.group === 'spare' ? '' : ' button') + '</span><select class="input" data-km="' + b.id + '" aria-describedby="' + hid + '">' + actionOptions(m[b.id], b) + '</select><small class="dim km-usual" id="' + hid + '">Usual: ' + V.esc(b.usual) + '</small></label>';
        }).join('') + '</div>';
    }).join('');
    return '<section class="card-sec" id="st-remote"><h2>Remote and keyboard</h2><p class="dim">Choose what the buttons do on <b>this device</b> (remotes differ). Buttons left on “Usual” work as they always have.' + (ownHere() ? '' : ' This device is using your profile’s default.') + '</p>' +
      '<div class="btn-row"><button class="btn" data-km-detect>' + V.icon('remote') + ' Press a button to see what it’s called</button></div>' + rows +
      '<div class="btn-row"><button class="btn" data-km-def>Make this my default on all my devices</button>' + (ownHere() ? '<button class="btn" data-km-usedef>Use my default here</button>' : '') + '<button class="btn ghost" data-km-reset>Back to the usual buttons</button></div></section>';
  }
  /** Pick a channel for a button. Resolves to its key, or null. */
  function pickChannel() {
    return V.dialog({
      title: 'Which channel?',
      body: '<label class="field"><span>Channel name or number</span><input class="input" type="search" data-cq autocomplete="off" autofocus></label><div class="km-chs"></div>',
      onOpen: function (d, finish) {
        var box = V.$('.km-chs', d);
        var draw = function (q) {
          q = q.trim();
          var list = /^\d+$/.test(q) ? (S.live || []).concat(S.radio || []).filter(function (c) { return String(c.no) === q; }) : [];
          list = list.concat(q ? V.search.find(q, { types: ['live', 'radio'], limit: 30 }) : (V.favChannels ? V.favChannels('any') : []).concat(V.recentChannels ? V.recentChannels() : [])).filter(function (x, i, a) { return x && a.indexOf(x) === i; }).slice(0, 30);
          box.innerHTML = list.map(function (c) { return '<button class="side-ch" data-k="' + V.esc(c.k) + '"><span class="num">' + (c.no || '') + '</span>' + V.art(c.i, c.n, 'art sm') + '<span class="sc-t"><span class="truncate">' + V.esc(c.n) + '</span></span></button>'; }).join('') || '<p class="dim">Type a channel’s name or number.</p>';
        };
        draw('');
        V.$('[data-cq]', d).addEventListener('input', V.debounce(function (e) { draw(e.target.value); }, 120));
        box.addEventListener('click', function (e) { var b = e.target.closest('[data-k]'); if (b) finish(b.dataset.k); });
      },
    });
  }
  /** "Press a button to see what it's called". */
  function detector(view) {
    var last = null;
    V.dialog({
      title: 'Press a button',
      body: '<p class="dim">Press any button on your remote or keyboard. Back (or Esc) closes this.</p><div class="km-det" aria-live="polite"><span class="dim">Waiting…</span></div>',
      actions: [{ label: 'Change what it does', fn: function () { if (!last) { V.toast('Press a button first.'); return false; } } , value: 'change' }, { label: 'Close', primary: true }],
      onOpen: function (d) {
        var out = V.$('.km-det', d);
        d.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' || e.keyCode === 10009 || e.keyCode === 461 || e.key === 'GoBack' || e.key === 'BrowserBack') return;
          var b = buttonOf(e);
          var nav = /^Arrow|^Enter$|^Tab$/.test(e.key);
          if (!nav) { e.preventDefault(); e.stopPropagation(); }
          last = b;
          var code = 'key “' + (e.key || '?') + '”, code ' + (e.keyCode || e.which || 0) + (e.code ? ', ' + e.code : '');
          out.innerHTML = b ? '<b class="km-name">' + (b.colour ? '<i class="km-dot" style="background:' + b.colour + '"></i>' : '') + V.esc(b.label) + (b.group === 'number' || b.group === 'spare' ? '' : ' button') + '</b><span>Does now: <b>' + V.esc(V.actionLabel(mapping()[b.id]) === 'Usual' ? b.usual.charAt(0).toUpperCase() + b.usual.slice(1) : V.actionLabel(mapping()[b.id])) + '</b></span><small class="dim">' + V.esc(code) + '</small>'
            : '<b class="km-name">' + V.esc(nav ? 'That one moves around the app' : 'Not one this app can change') + '</b><small class="dim">' + V.esc(code) + '</small>';
        }, true);
      },
    }).then(function (v) {
      if (v !== 'change' || !last) return;
      var sel = V.$('[data-km="' + last.id + '"]', view);
      if (sel) { sel.scrollIntoView({ block: 'center' }); sel.focus(); }
    });
  }
  var origSettings = V.routes.settings;
  V.routes.settings = function (view, r) {
    origSettings(view, r);
    var keysBtn = V.$('[data-a=keys]', view);
    var after = keysBtn ? keysBtn.closest('section') : null;
    var wrap = document.createElement('div');
    wrap.innerHTML = section();
    var sec = wrap.firstChild;
    if (after && after.parentNode) after.parentNode.insertBefore(sec, after.nextSibling); else (V.$('.settings', view) || view).appendChild(sec);
    var redraw = function () { var w = document.createElement('div'); w.innerHTML = section(); var n = w.firstChild; sec.parentNode.replaceChild(n, sec); sec = n; bind(); };
    var bind = function () {
      sec.addEventListener('change', function (e) {
        var s = e.target.closest('[data-km]');
        if (!s) return;
        e.stopPropagation();
        var id = s.dataset.km;
        if (s.value === '__channel') {
          pickChannel().then(function (k) { if (k) { setHere(id, 'channel:' + k); V.toast('Saved for this device'); } redraw(); var n = V.$('[data-km="' + id + '"]', sec); if (n) n.focus(); });
          return;
        }
        setHere(id, s.value);
        V.toast('Saved for this device');
      });
      sec.addEventListener('click', function (e) {
        if (e.target.closest('[data-km-detect]')) detector(sec);
        else if (e.target.closest('[data-km-def]')) { V.setPref('remoteKeys', Object.assign({}, mapping())); V.toast('Saved as your default — your other devices use it unless they have their own.'); }
        else if (e.target.closest('[data-km-usedef]')) { V.ls.del('remoteKeys'); redraw(); V.toast('This device uses your default now'); }
        else if (e.target.closest('[data-km-reset]')) { V.ls.set('remoteKeys', {}); redraw(); V.toast('The buttons work as usual on this device'); }
      });
    };
    bind();
    // "#/settings?s=remote" (from the quick launcher): straight to this section.
    if (r && r.q && r.q.get('s') === 'remote') setTimeout(function () { sec.scrollIntoView({ block: 'start' }); var f = V.$('select, button', sec); if (f) f.focus({ preventScroll: true }); }, 80);
  };
})();
