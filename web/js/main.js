/* Start-up: who's watching → load the profile's data and catalogue → show the app. Offline: downloads only. */
'use strict';

V.applyBrand = function () {
  var b = S.settings && S.settings.brand;
  var st = V.$('#brand-accent');
  if (!st) { st = document.createElement('style'); st.id = 'brand-accent'; document.head.appendChild(st); }
  st.textContent = b && b.accent ? ':root{--accent:' + b.accent + ' !important}' : '';
};

V.enterApp = function () {
  if (V._entering) return V._entering;
  V._entering = V._enterApp().then(function (x) { V._entering = null; return x; }, function (e) { V._entering = null; throw e; });
  return V._entering;
};
/** A line under the loading spinner ('' removes it). */
V.loadMsg = function (text) {
  var box = V.$('#loading'); if (!box) return;
  var lt = V.$('.load-msg', box);
  if (!text) { if (lt) lt.remove(); return; }
  if (!lt) { lt = document.createElement('p'); lt.className = 'load-msg'; lt.setAttribute('role', 'status'); box.appendChild(lt); }
  lt.textContent = text;
};
V._enterApp = function () {
  V.$('#profiles').hidden = true;
  V.$('#loading').hidden = false;
  V.loadMsg('');
  // Just after the server (re)starts, the catalogue takes a moment: say so instead of a bare spinner.
  var slow = setTimeout(function () { V.loadMsg('Getting the channels and films ready…'); }, 2500);
  return V.refreshMe().then(function () {
    V.applyTheme(S.data.prefs.theme || 'midnight');
    V.ls.set('theme', S.data.prefs.theme || 'midnight');
    V.applyLook();
    V.applyBrand();
    return V.loadCatalog();
  }).then(function () {
    clearTimeout(slow); V.loadMsg('');
    V.$('#loading').hidden = true;
    V.$('#shell').hidden = false;
    V.renderShell();
    V.rt.connect();
    V.epg.load().then(function () { if (/^(home|live|channel)$/.test(document.body.dataset.page)) V.router.refresh(); });
    V.loadRecs();
    V.loadSharedLists().catch(function () {});
    V.downloads.load();
    if (!location.hash || location.hash === '#' || location.hash === '#/') location.replace('#/home');
    V.router.stack = [];
    V.router.render();
    if (V.startupPlay) V.startupPlay();
    // Episodes in your progress/history that aren't loaded yet (Xtream series): fetch, then re-draw the rows they belong in.
    // A new profile with nothing watched yet: ask what it likes (once).
    if (!S.data.prefs.onboarded && !S.data.history.length && !Object.keys(S.data.ratings).length && !S.profile.kids) setTimeout(V.onboard, 1200);
    // The admin hears about provider accounts running out (once a day per device).
    if (S.alerts && S.alerts.length && V.ls.get('alertDay', '') !== new Date().toDateString()) {
      V.ls.set('alertDay', new Date().toDateString());
      var a = S.alerts[0];
      V.toast(a.kind === 'expiry' ? a.list + (a.days < 0 ? ' has expired' : ' expires in ' + V.plural(a.days, 'day')) : a.list + ': account ' + a.status, { error: true, ms: 12000, action: { label: 'Details', fn: function () { V.router.go('#/admin'); } } });
    }
    V.drawRemoteBar();
    V.warmEpisodes().then(function (changed) {
      if (changed && /^(home|mine)$/.test(document.body.dataset.page) && window.scrollY < 400 && !(V.watch && V.watch.it && !V.watch.mini)) V.router.refresh();
      V.offerResume();
    });
  }).catch(function (e) {
    clearTimeout(slow); V.loadMsg('');
    V.$('#loading').hidden = true;
    if (e.status === 403) return V.showProfiles();
    V.fail(e);
    V.showProfiles();
  });
};

/** Handoff: if this profile was watching something on another device a moment ago, offer to carry on here. */
V.offerResume = function () {
  if (!S.profile || !S.data) return;
  var cw = V.continueWatching()[0];
  if (!cw || cw.next) return;
  var p = V.progressOf(cw.it.k);
  if (!p || Date.now() - p.at > 20 * 60e3) return;
  // Once per spot per tab (reloading the page doesn't ask again).
  // (Not what was just playing on this very device — the page reloaded after an update, or the profile was switched.)
  if (V.ls.session('playedHere') === cw.it.k) return;
  // (Home's banner is already offering it: "Continue watching … Resume".)
  if (document.body.dataset.page === 'home' && V.$('.hero [data-hero=play]') && /Resume/.test(V.$('.hero [data-hero=play]').textContent)) return;
  var sig = cw.it.k + '|' + Math.round(p.p);
  if (V.ls.session('resumeOffered') === sig) return;
  V.ls.session('resumeOffered', sig);
  V.toast('Continue “' + (cw.it.t === 'episode' ? ((V.showOf(cw.it) || {}).n || cw.it.n) + ' ' + V.epLabel(cw.it) : cw.it.n) + '” from ' + V.fmtDur(p.p) + '?', { action: { label: 'Resume', fn: function () { V.play(cw.it); } }, ms: 12000 });
};

V.boot = function () {
  V.applyTheme(V.ls.get('theme', 'midnight'));
  V.initWatch();
  V.player.onUserAction = function () { V.party.onUserAction(); };
  V.$('#me-btn').onclick = function (e) { V.profileMenu(e.currentTarget); };
  V.on('signedout', function () { location.replace('/'); });
  // A new catalogue on the server: loaded again. (The light one — a TV, a console — is loaded whole each time, so not
  // while something's playing, and not more than every 20 minutes: when you're next moving between pages.)
  var staleReload = function () { S.catStale = false; S.catLoadedAt = Date.now(); V.loadCatalog().then(function () { V.renderShell(); if (!V.watch.it || V.watch.mini) V.router.refresh(); }).catch(function () {}); };
  V.on('catalog-stale', V.debounce(function () {
    if (S.catLite && ((V.watch.it && !V.watch.mini) || Date.now() - (S.catLoadedAt || 0) < 20 * 60e3)) { S.catStale = true; return; }
    staleReload();
  }, 4000));
  V.on('route', function () { if (S.catStale && !(V.watch.it && !V.watch.mini) && Date.now() - (S.catLoadedAt || 0) >= 20 * 60e3) setTimeout(staleReload, 1500); });
  V.on('profiles', function () { if (!S.profile) V.api('/api/boot').then(function (b) { S.boot = b; if (!V.$('#profiles').hidden) V.showProfiles(); }); });
  V.on('settings', function () { V.renderShell(); V.applyBrand(); });
  V.on('data', function (f) { if (f === 'list' || f === 'favs' || f === '*') { if (document.body.dataset.page === 'mine') V.router.refresh(); } });
  setInterval(function () { V.checkReminders(); }, 20000);
  window.addEventListener('scroll', V.throttle(function () { document.body.classList.toggle('scrolled', window.scrollY > 30); }, 100), { passive: true });
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); V.installPrompt = e; });
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(function () {});
  // Pressing the brand or Home while the mini player is open stays where you are.
  V.$('#brand').onclick = function (e) { e.preventDefault(); V.router.go('#/home'); };
  var tries = 0;
  var load = function () { V.api('/api/boot', { allow401: true }).then(function (b) {
    V.loadMsg('');
    S.boot = b;
    S.settings = b;
    V.$('#loading').hidden = true;
    // Straight back into this device's profile (unless this device asks “Who’s watching?” every time).
    if (b.current && (!V.ls.get('askProfile', false) || /[?&]stay\b/.test(location.search))) return V.enterApp();
    V.showProfiles();
  }).catch(function (e) {
    // The server may just be restarting: give it a few seconds before falling back to downloads.
    if ((e.offline && navigator.onLine !== false || e.status >= 502 && e.status <= 504) && ++tries < 5) {
      V.loadMsg('Connecting to the server…');
      return setTimeout(load, 1500 * tries);
    }
    V.$('#loading').hidden = true;
    if (e.status === 401) return location.replace('/');
    if (e.offline) return V.offlineMode();
    V.$('#profiles').hidden = false;
    V.$('#profiles').innerHTML = V.empty('Can’t reach the server', V.esc(e.message), '<button class="btn primary" onclick="location.reload()">Try again</button>');
  }); };
  load();
};

/** No connection: show what's been downloaded on this device. */
V.offlineMode = function () {
  S.settings = { brand: { name: '' }, allowDownloads: true, ffmpeg: false, routing: 'direct-only' };
  S.profile = { id: '', name: 'Offline', avatar: 0 };
  S.data = { prefs: V.ls.get('offlinePrefs', {}), progress: {}, history: [], list: [], favs: [], hidden: [], ratings: {}, bookmarks: [], reminders: [], searches: [], home: { order: [], hidden: [], pinned: [] } };
  S.items = []; V.index([]);
  V.$('#shell').hidden = false;
  V.$('#profiles').hidden = true;
  document.body.classList.add('offline');
  V.downloads.load().then(function () { location.hash = '#/downloads'; V.router.render(); });
  var offline = navigator.onLine === false;
  V.toast(offline ? 'You’re offline — showing your downloads.' : 'Can’t reach the server — showing your downloads. Trying again…', { ms: 6000 });
  // Keep checking for the server, and go back in as soon as it answers — unless a download is playing: then just offer.
  var tries = 0, timer = 0, offered = false;
  var back = function () {
    if (V.watch && V.watch.it) {
      if (!offered) { offered = true; V.toast('The server is back.', { ms: 30000, action: { label: 'Reload', fn: function () { location.reload(); } } }); }
      return;
    }
    location.reload();
  };
  var again = function () {
    clearTimeout(timer);
    tries++;
    fetch('/api/boot', { headers: { 'X-App': '1' }, cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      if (r.ok || r.status === 401) back(); else timer = setTimeout(again, Math.min(30000, 3000 * tries));
    }, function () { timer = setTimeout(again, Math.min(30000, 3000 * tries)); });
  };
  window.addEventListener('online', function () { tries = 0; again(); });
  timer = setTimeout(again, 3000);
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', V.boot); else V.boot();
