/* Making things easier to find:
   - the phone remote: a Remote button in the top bar whenever another of your screens is open (with a dot while it
     plays something), "Use as a remote" in the profile menu, a nudge when your TV starts playing, and on the TV a QR
     code that opens its remote on your phone (profile menu, player menu, and a one-time tip);
   - Settings: a row of section links at the top (sticky), so nothing is a long scroll away. */
'use strict';
(function () {
  var isTV = function () { return !!V.tvMode; };

  // ------------------------------------------------------------ other screens (for the Remote button)
  var screens = [];
  var told = {}; // conn|item → shown the "playing on your TV" nudge (once each, this session)
  var poll = null;
  var refresh = function () {
    if (!S.profile || isTV() || document.hidden) return;
    V.api('/api/devices').then(function (devs) {
      screens = (devs || []).filter(function (d) { return d.conn !== S.conn && d.ok !== false; }); // (someone else's screen: only once they've allowed it)
      drawButton();
      nudge();
    }).catch(function () {});
  };
  var start = function () {
    clearInterval(poll);
    if (isTV()) { screens = []; drawButton(); return; }
    refresh();
    poll = setInterval(refresh, 20000);
  };
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  V.on('rt:connected', start);
  // (Also on moving to another page, at most every 5 s: a screen that just opened shows up sooner.)
  var lastLook = 0;
  V.on('route', function () { if (Date.now() - lastLook > 5000) { lastLook = Date.now(); refresh(); } });

  var playingOn = function () { return screens.filter(function (d) { return d.playing && !d.playing.hidden; }); };
  /** Where the Remote button goes: straight to the one other screen, or the list. */
  var target = function () {
    var pl = playingOn();
    var one = pl.length === 1 ? pl[0] : screens.length === 1 ? screens[0] : null;
    return one ? '#/remote/' + encodeURIComponent(one.conn) : '#/remote';
  };
  var drawButton = function () {
    var bar = V.$('#topbar');
    if (!bar) return;
    var b = V.$('#remote-btn');
    if (!screens.length || isTV()) { if (b) b.hidden = true; return; }
    if (!b) {
      b = document.createElement('a');
      b.id = 'remote-btn';
      b.className = 'icon-btn remote-btn';
      b.innerHTML = V.icon('remote') + '<span class="rb-dot" hidden></span>';
      var msgs = V.$('[data-nav=messages]', bar);
      bar.insertBefore(b, msgs || V.$('#me-btn', bar));
    }
    var pl = playingOn();
    b.hidden = false;
    b.href = target();
    var label = pl.length ? 'Remote — ' + (pl[0].playing.n || 'playing') + ' on ' + pl[0].name : 'Use this as a remote for ' + (screens.length === 1 ? screens[0].name : 'another screen');
    b.setAttribute('aria-label', label);
    b.title = label;
    V.$('.rb-dot', b).hidden = !pl.length;
  };
  // Your TV started playing something while you're on this phone: offer the remote (once per thing per screen).
  var nudge = function () {
    if (S.nowPlaying || V.player && V.player.started) return;
    playingOn().forEach(function (d) {
      var key = d.conn + '|' + d.playing.k;
      if (told[key] || !d.tv || d.profile) return; // (only your own TVs, not someone else's screen)
      var fresh = Date.now() - (d.playing.at || 0) < 60000;
      told[key] = true;
      if (!fresh) return;
      V.toast('“' + (d.playing.n || 'Something') + '” is playing on ' + d.name, { ms: 7000, action: { label: 'Remote', fn: function () { V.router.go('#/remote/' + encodeURIComponent(d.conn)); } } });
    });
  };
  // (The first look marks what's already playing as seen, so opening the app doesn't greet you with a toast.)
  var primed = false;
  var firstNudge = nudge;
  nudge = function () { if (!primed) { primed = true; playingOn().forEach(function (d) { told[d.conn + '|' + d.playing.k] = true; }); return; } firstNudge(); };

  // ------------------------------------------------------------ the TV: control it from your phone
  /** The address that opens this screen's remote on a phone. */
  var remoteLink = function () { return location.origin + '/#/remote' + (S.conn ? '/' + encodeURIComponent(S.conn) : ''); };
  V.phoneRemoteDialog = function () {
    var link = remoteLink();
    return V.dialog({
      title: 'Use your phone as a remote',
      body: '<div class="pr-dlg"><img class="pr-qr" alt="" src="/api/qr?text=' + encodeURIComponent(link) + '" onerror="this.remove()">' +
        '<div class="pr-txt"><ol class="pr-steps"><li>Point your phone’s camera at the code' + ' <span class="dim">(or open <b>' + V.esc(location.host) + '</b> on it)</span>.</li>' +
        '<li>Sign in and pick <b>' + V.esc(S.profile.name) + '</b>.</li>' +
        '<li>Your phone shows the remote for <b>' + V.esc(V.device.name || 'this TV') + '</b>: play, pause, skip, channels, subtitles and volume. Anything you pick on the phone can play here too.</li></ol>' +
        '<p class="dim small">Later, the <span class="pr-ic">' + V.icon('remote') + '</span> button at the top of the app on your phone opens it straight away while this TV is on.</p></div></div>',
      actions: [{ label: 'Done', primary: true }],
    });
  };
  // A one-time tip on a TV, a little while after it opens.
  var tipLater = function () {
    if (!isTV() || V.ls.get('tipPhoneRemote', false)) return;
    setTimeout(function () {
      if (!isTV() || V.ls.get('tipPhoneRemote', false) || (V.player && V.player.started)) return;
      V.ls.set('tipPhoneRemote', true);
      V.toast('Tip: you can use your phone as the remote', { ms: 10000, action: { label: 'Show me', fn: V.phoneRemoteDialog } });
    }, 25000);
  };
  V.on('rt:connected', tipLater);

  // The player's menu (More): on a TV, "Control from your phone"; elsewhere, nothing new.
  V.playerMenuExtras = (function (prev) {
    return function (p, main, pages) {
      if (prev) prev(p, main, pages);
      if (isTV()) main.push({ label: 'Control from your phone', value: '', fn: function () { V.phoneRemoteDialog(); } });
    };
  })(V.playerMenuExtras);

  // The profile menu: "Use as a remote" (phones and computers) or "Control from your phone" (TVs).
  var menu = V.profileMenu;
  V.profileMenu = function (btn) {
    var realMenu = V.menu;
    V.menu = function (b, items) {
      V.menu = realMenu;
      var add = isTV()
        ? { label: 'Control from your phone', icon: 'remote', fn: function () { V.phoneRemoteDialog(); } }
        : { label: 'Use as a remote', icon: 'remote', hint: screens.length ? (playingOn()[0] || screens[0]).name : '', fn: function () { V.router.go(target()); } };
      var at = 0;
      for (var i = 0; i < items.length; i++) if (items[i] && items[i].label === 'Downloads') at = i + 1;
      items.splice(at || 3, 0, add);
      return realMenu(b, items);
    };
    try { return menu(btn); } finally { V.menu = realMenu; }
  };

  // ------------------------------------------------------------ Settings: jump to a section
  V.on('route', function (r) {
    if (!r || r.name !== 'settings') return;
    setTimeout(function () {
      var view = V.$('#view'), box = V.$('.settings', view);
      if (!box || V.$('.st-jump', view)) return;
      var secs = V.$$('.settings > .card-sec', view).filter(function (s) { var h = V.$('h2', s); return h && h.textContent.trim(); });
      if (secs.length < 4) return;
      var short = { 'Remote and keyboard': 'Remote buttons', 'Phone and TV': 'Phone remote', 'Remove this profile': '' };
      var nav = document.createElement('nav');
      nav.className = 'st-jump chips';
      nav.setAttribute('aria-label', 'Settings sections');
      var seen = {};
      nav.innerHTML = secs.map(function (s, i) {
        var t = V.$('h2', s).textContent.trim();
        var label = short[t] !== undefined ? short[t] : t;
        if (!label || seen[label]) return '';
        seen[label] = true;
        if (!s.id) s.id = 'st-' + i;
        return '<a class="chip" href="#" data-jump="' + s.id + '">' + V.esc(label) + '</a>';
      }).join('');
      box.parentNode.insertBefore(nav, box);
      nav.addEventListener('click', function (e) {
        var a = e.target.closest('[data-jump]');
        if (!a) return;
        e.preventDefault();
        var s = document.getElementById(a.dataset.jump);
        if (!s) return;
        s.scrollIntoView({ block: 'start', behavior: V.$('html.reduce-motion') ? 'auto' : 'smooth' });
        s.classList.remove('st-flash'); void s.offsetWidth; s.classList.add('st-flash');
        var f = V.$('input, select, button, a[href]', s);
        if (f) setTimeout(function () { f.focus({ preventScroll: true }); }, 350);
      });
      // "#/settings?s=look" and the like: straight to that section (the remote buttons have their own: keymap.js).
      var want = r.q && r.q.get ? String(r.q.get('s') || '').toLowerCase() : '';
      if (want && want !== 'remote') {
        var hit = V.$$('[data-jump]', nav).filter(function (a) { return a.textContent.trim().toLowerCase().indexOf(want) === 0; })[0];
        var target = hit && document.getElementById(hit.dataset.jump);
        if (target) target.scrollIntoView({ block: 'start' });
      }
    }, 0);
  });
})();
