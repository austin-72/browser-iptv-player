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
V._enterApp = function () {
  V.$('#profiles').hidden = true;
  V.$('#loading').hidden = false;
  return V.refreshMe().then(function () {
    V.applyTheme(S.data.prefs.theme || 'midnight');
    V.ls.set('theme', S.data.prefs.theme || 'midnight');
    V.applyLook();
    V.applyBrand();
    return V.loadCatalog();
  }).then(function () {
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
    // Episodes in your progress/history that aren't loaded yet (Xtream series): fetch, then re-draw the rows they belong in.
    V.warmEpisodes().then(function (changed) {
      if (changed && /^(home|mine)$/.test(document.body.dataset.page) && window.scrollY < 400 && !(V.watch && V.watch.it && !V.watch.mini)) V.router.refresh();
      V.offerResume();
    });
  }).catch(function (e) {
    V.$('#loading').hidden = true;
    if (e.status === 403) return V.showProfiles();
    V.fail(e);
    V.showProfiles();
  });
};

/** Handoff: if this profile was watching something on another device a moment ago, offer to carry on here. */
V.offerResume = function () {
  var cw = V.continueWatching()[0];
  if (!cw || cw.next) return;
  var p = V.progressOf(cw.it.k);
  if (!p || Date.now() - p.at > 20 * 60e3) return;
  V.toast('Continue “' + (cw.it.t === 'episode' ? ((V.showOf(cw.it) || {}).n || cw.it.n) + ' ' + V.epLabel(cw.it) : cw.it.n) + '” from ' + V.fmtDur(p.p) + '?', { action: { label: 'Resume', fn: function () { V.play(cw.it); } }, ms: 12000 });
};

V.boot = function () {
  V.applyTheme(V.ls.get('theme', 'midnight'));
  V.initWatch();
  V.player.onUserAction = function () { V.party.onUserAction(); };
  V.$('#me-btn').onclick = function (e) { V.profileMenu(e.currentTarget); };
  V.on('signedout', function () { location.replace('/'); });
  V.on('catalog-stale', V.debounce(function () { V.loadCatalog().then(function () { V.renderShell(); if (!V.watch.it || V.watch.mini) V.router.refresh(); }).catch(function () {}); }, 4000));
  V.on('profiles', function () { if (!S.profile) V.api('/api/boot').then(function (b) { S.boot = b; if (!V.$('#profiles').hidden) V.showProfiles(); }); });
  V.on('settings', function () { V.renderShell(); V.applyBrand(); });
  V.on('data', function (f) { if (f === 'list' || f === 'favs' || f === '*') { if (document.body.dataset.page === 'mine') V.router.refresh(); } });
  setInterval(function () { V.checkReminders(); }, 20000);
  window.addEventListener('scroll', V.throttle(function () { document.body.classList.toggle('scrolled', window.scrollY > 30); }, 100), { passive: true });
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); V.installPrompt = e; });
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(function () {});
  // Pressing the brand or Home while the mini player is open stays where you are.
  V.$('#brand').onclick = function (e) { e.preventDefault(); V.router.go('#/home'); };
  V.api('/api/boot', { allow401: true }).then(function (b) {
    S.boot = b;
    S.settings = b;
    V.$('#loading').hidden = true;
    // Straight back into this device's profile (unless this device asks “Who’s watching?” every time).
    if (b.current && (!V.ls.get('askProfile', false) || /[?&]stay\b/.test(location.search))) return V.enterApp();
    V.showProfiles();
  }).catch(function (e) {
    V.$('#loading').hidden = true;
    if (e.status === 401) return location.replace('/');
    if (e.offline) return V.offlineMode();
    V.$('#profiles').hidden = false;
    V.$('#profiles').innerHTML = V.empty('Can’t reach the server', V.esc(e.message), '<button class="btn primary" onclick="location.reload()">Try again</button>');
  });
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
  V.toast('You’re offline — showing your downloads.', { ms: 6000 });
  window.addEventListener('online', function () { location.reload(); });
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', V.boot); else V.boot();
