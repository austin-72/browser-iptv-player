/* Live connection to the server (server-sent events): messages, other devices, watch parties, catalogue updates. */
'use strict';
V.rt = (function () {
  var es = null;
  var retry = 0;

  function connect() {
    close();
    if (!window.EventSource || !S.profile) return;
    es = new EventSource('/api/events?device=' + encodeURIComponent(V.device.id) + '&name=' + encodeURIComponent(V.device.name));
    es.onopen = function () { V._epsOk = {}; }; // (re)connected: the server may have restarted
    es.addEventListener('hello', function (e) { S.conn = JSON.parse(e.data).conn; retry = 0; V.emit('rt:connected'); V.rt.presence(S.nowPlaying || null); });
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
    on('profile', function () { V.refreshMe().then(function () { V.loadCatalog().catch(function () {}); }); });
    on('removed', function () { V.toast('This profile was removed.', { error: true }); V.leaveProfile(); });
    on('lists', function () { V.emit('shared-lists'); });
    on('notify', function (d) { V.notify(d); });
    on('devstate', function (d) { V.emit('devstate', d); });
    on('app-updated', function () { V.appUpdated(); });
    on('restarting', function () { V.toast('The server is restarting for an update — back in a moment.', { ms: 8000 }); });
    es.onerror = function () {
      if (es && es.readyState === 2) { close(); retry++; setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, retry))); }
    };
  }
  function close() { if (es) { try { es.close(); } catch (e) {} es = null; } S.conn = null; }

  var lastPresence = '';
  return {
    connect: connect,
    close: close,
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
