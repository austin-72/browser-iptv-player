/* Live connection to the server (server-sent events): messages, other devices, watch parties, catalogue updates. */
'use strict';
V.rt = (function () {
  var es = null;
  var retry = 0;
  var timer = 0;
  // Network back: reconnect now rather than at the end of the back-off.
  window.addEventListener('online', function () { if (S.profile && (!es || es.readyState !== 1)) { retry = 0; clearTimeout(timer); connect(); } });

  function connect() {
    close();
    if (!window.EventSource || !S.profile) return;
    es = new EventSource('/api/events?device=' + encodeURIComponent(V.device.id) + '&name=' + encodeURIComponent(V.device.name));
    es.onopen = function () { V._epsOk = {}; }; // (re)connected: the server may have restarted
    // (A new connection — the server may have restarted and forgotten who's watching what: always say it again, so it
    // doesn't hand someone else the provider connection this device is using, and the stream relay keeps it.)
    es.addEventListener('hello', function (e) { S.conn = JSON.parse(e.data).conn; retry = 0; lastPresence = ''; V._rtEver = true; V.net.up(); V.emit('rt:connected'); V.rt.presence(S.nowPlaying || null); });
    var on = function (name, fn) { es.addEventListener(name, function (e) { var d; try { d = JSON.parse(e.data); } catch (x) { return; } fn(d); }); };
    on('message', function (m) { V.emit('message', m); });
    on('read', function (d) { V.emit('read', d); });
    on('react', function (d) { V.emit('react', d); });
    on('unsend', function (d) { V.emit('unsend', d); });
    on('progress', function (d) {
      if (!S.data) return;
      if (d.rec) S.data.progress[d.k] = d.rec;
      V.emit('progress', d.k);
      V.emit('remote-progress', d);
    });
    on('data', V.debounce(function () { V.refreshMe(); }, 800)); // several changes in a burst → one refresh
    on('party', function (d) { V.emit('party', d); });
    on('command', function (d) { V.emit('command', d); });
    on('catalog', function (d) { if (d.version !== S.catalogVersion) V.emit('catalog-stale', d); });
    on('settings', function (d) { S.settings = Object.assign(S.settings || {}, d); V.emit('settings'); });
    on('profiles', function () { V.emit('profiles'); });
    on('health', function (d) { V.emit('health-v', d); });
    on('profile', function () { V.refreshMe().then(function () { V.loadCatalog().catch(function () {}); }); });
    on('removed', function () { V.toast('This profile was removed.', { error: true }); V.leaveProfile(); });
    on('lists', function () { V.emit('shared-lists'); });
    on('notify', function (d) { V.notify(d); });
    on('devstate', function (d) { V.emit('devstate', d); });
    on('remote-ask', function (d) { V.emit('remote-ask', d); }); // (remote.js: someone asks to use this screen as a remote)
    on('remote-answer', function (d) { V.emit('remote-answer', d); });
    on('app-updated', function () { V.appUpdated(); });
    on('screentime', function (d) { V.emit('screentime', d); });
    on('dvr', function (d) { V.emit('dvr', d); });
    on('trending', function () { V.emit('trending-push'); }); // (TMDB's charts fetched again: smartcats.js)
    on('restarting', function () { V.toast('The server is restarting for an update — back in a moment.', { ms: 8000 }); });
    es.onerror = function () {
      V.net.down();
      if (es && es.readyState === 2) {
        close(); retry++; clearTimeout(timer); timer = setTimeout(connect, Math.min(V.watch && V.watch.it ? 3000 : 15000, 1000 * Math.pow(2, retry))); // (while watching: back within seconds of the server)
        // The server refused (rather than couldn't be reached): if this device was signed out, any request says so.
        V.api('/api/me').catch(function () {});
      }
    };
  }
  function close() { if (es) { try { es.close(); } catch (e) {} es = null; } S.conn = null; }

  var lastPresence = '';
  return {
    connect: connect,
    close: close,
    open: function () { return !!(es && es.readyState === 1 && S.conn); },
    /** Tell the household what this device is playing (only if the profile allows it). */
    presence: function (playing) {
      S.nowPlaying = playing;
      if (!S.conn) return;
      // With "show what I'm watching" off, the server still learns which provider connection is in use (so others
      // aren't sent to a busy one), but nobody sees what it is.
      var body = { conn: S.conn, playing: playing ? (V.pref('presence') !== false ? playing : { k: playing.k, alt: playing.alt, hidden: true }) : null };
      var sig = JSON.stringify(body.playing && { k: body.playing.k, alt: body.playing.alt });
      if (sig === lastPresence && !(playing && playing.force)) return;
      lastPresence = sig;
      V.api('/api/presence', { body: body }).catch(function () {});
    },
  };
})();

V.refreshMe = function () {
  return V.api('/api/me').then(function (j) {
    S.profile = j.profile;
    var prefs = S.data ? S.data.prefs : null;
    S.data = j.data;
    if (prefs) S.data.prefs = Object.assign({}, j.data.prefs);
    S.settings = j.settings;
    S.unread = j.unread;
    S.alerts = j.alerts || [];
    V.emit('me');
    V.emit('data', '*');
    return j;
  });
};

/** Something worth telling the profile about (a new episode…): a toast here, and a system notification when allowed. */
V.notify = function (d) {
  if (!d || !d.title) return;
  var open = function () { if (d.k) V.router.go(V.hrefOf(V.entry(d.k) || { t: 'show', k: d.k })); };
  V.toast(d.title + (d.body ? ' — ' + d.body : ''), { action: d.k ? { label: 'Open', fn: open } : null, ms: 9000 });
  try {
    if (document.hidden && window.Notification && Notification.permission === 'granted') {
      var opts = { body: d.body || '', icon: d.i || '/icon-192.png', tag: d.kind + ':' + (d.k || ''), data: { url: location.origin + '/' + (d.k ? '#/title/' + encodeURIComponent(d.k) : '') } };
      if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.ready.then(function (reg) { reg.showNotification(d.title, opts); });
      else { var n = new Notification(d.title, opts); n.onclick = function () { window.focus(); open(); n.close(); }; }
    }
  } catch (e) {}
};
/** A new version of the app is on the server. */
V.appUpdated = function () {
  if (V._updToast) return;
  V._updToast = true;
  // Not in the middle of something: just reload. Otherwise offer it.
  if (!(V.watch && V.watch.it) && !document.querySelector('dialog[open]')) { setTimeout(function () { location.reload(); }, 1500); return; }
  V.toast('A new version is ready.', { action: { label: 'Reload', fn: function () { location.reload(); } }, ms: 30000 });
};

// ---------------------------------------------------------------- connection status
// A small note while this device is offline or can't reach the server (things keep working where they can).
V.net = (function () {
  var bar = null, shownAt = 0, downSince = 0, wait = 0;
  function show(text, offline) {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'netbar';
      bar.setAttribute('role', 'status');
      document.body.appendChild(bar);
    }
    bar.className = offline ? 'off' : '';
    bar.innerHTML = '<span class="nb-dot"></span><span>' + V.esc(text) + '</span>' + (offline && location.hash.indexOf('#/downloads') !== 0 ? ' <a href="#/downloads">Downloads</a>' : '');
    if (!shownAt) shownAt = Date.now();
    document.body.classList.add('has-netbar');
  }
  function hide() {
    clearTimeout(wait); downSince = 0;
    if (!bar || !shownAt) return;
    var was = shownAt; shownAt = 0;
    document.body.classList.remove('has-netbar');
    bar.remove(); bar = null;
    if (Date.now() - was > 2500) V.toast('Back online.', { ms: 2500 });
  }
  function check() {
    if (navigator.onLine === false) return show('You’re offline. Downloads still play.', true);
    // A blip (the server restarting, Wi-Fi switching) shouldn't flash a warning: only after a few seconds.
    if (downSince) return; // already waiting (the browser retries every few seconds)
    downSince = Date.now();
    wait = setTimeout(function () { if (downSince) show('Can’t reach the server — trying again…', false); }, 6000);
  }
  window.addEventListener('offline', check);
  window.addEventListener('online', function () {
    if (!shownAt) return;
    // (The live connection may have stayed up through a short drop.)
    if (V.rt.open()) hide(); else show('Reconnecting…', false);
  });
  return {
    down: check,
    up: function () {
      var wasDown = !!shownAt;
      hide();
      // Missed catalogue changes while away: fetch them (only what changed).
      if (wasDown && V.loadCatalog) V.loadCatalog().catch(function () {});
    },
  };
})();
