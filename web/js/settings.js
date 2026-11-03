/* The profile's own settings: profile, languages, look, playback, privacy, this device. */
'use strict';
V.route('settings', function (view) {
  var pr = S.profile, pf = S.data.prefs;
  var langs = Array.isArray(pr.langs) ? pr.langs : null;
  var unknown = typeof pr.unknownLang === 'boolean' ? pr.unknownLang : S.settings.showUnknownLang;
  var defNames = (S.settings.defaultLangs || []).map(V.langName).join(', ') || 'all languages';
  var langOpts = function (cur) { return '<option value="">No preference</option>' + (S.boot.languages || []).map(function (l) { return '<option value="' + V.esc(l.code) + '"' + (l.code === cur ? ' selected' : '') + '>' + V.esc(l.name) + '</option>'; }).join(''); };
  var sw = function (k, label, hint) { return '<label class="switch"><input type="checkbox" data-pref="' + k + '"' + (pf[k] ? ' checked' : '') + '><span class="sw"></span><span><b>' + label + '</b>' + (hint ? '<small>' + hint + '</small>' : '') + '</span></label>'; };
  view.innerHTML = V.pageHead('Settings') + '<div class="settings">' +
    '<section class="card-sec"><h2>Profile</h2><div class="prof-row"><button class="pf-av-btn" data-a="avatar" aria-label="Change picture">' + V.avatar(pr.avatar, 'xl') + '<span class="pf-av-edit">' + V.icon('edit') + '</span></button><div class="grow">' +
    '<label class="field"><span>Name</span><div class="inline"><input class="input" data-name value="' + V.esc(pr.name) + '" maxlength="24"><button class="btn" data-a="name">Save</button></div></label>' +
    '<div class="btn-row"><button class="btn" data-a="pin">' + V.icon('lock') + ' ' + (pr.hasPin ? 'Change PIN' : 'Add a PIN') + '</button>' + (pr.hasPin && !pr.admin ? '<button class="btn" data-a="nopin">Remove PIN</button>' : '') + '</div>' +
    (pr.kids ? '<p class="note">' + V.icon('shield') + ' This is a kids profile. The admin decides what it can watch.</p>' : '') + '</div></div>' +
    '<h3>What you like</h3><div class="chips">' + V.INTERESTS.map(function (g) { return '<label class="chip-check"><input type="checkbox" data-interest value="' + g + '"' + ((pr.interests || []).indexOf(g) >= 0 ? ' checked' : '') + '><span>' + g + '</span></label>'; }).join('') + '</div></section>' +

    '<section class="card-sec"><h2>Languages</h2><p class="dim">Only titles and channels in the languages you pick are shown. The server default is: <b>' + V.esc(defNames) + '</b>.</p>' +
    '<label class="check"><input type="radio" name="lmode" value="default"' + (!langs ? ' checked' : '') + '><span>Use the default</span></label><label class="check"><input type="radio" name="lmode" value="own"' + (langs ? ' checked' : '') + '><span>Choose my own</span></label>' +
    '<div class="lang-pick"' + (langs ? '' : ' hidden') + '>' + V.langChecks(langs || S.settings.defaultLangs) + '</div>' +
    '<label class="check"><input type="checkbox" data-unknown' + (unknown ? ' checked' : '') + '><span>Also show things whose language isn’t known</span></label><button class="btn primary" data-a="langs">Save languages</button></section>' +

    '<section class="card-sec"><h2>Look</h2><div class="themes">' + V.THEMES.map(function (t) { return '<button class="theme' + (t.id === pf.theme ? ' on' : '') + '" data-theme="' + t.id + '" aria-pressed="' + (t.id === pf.theme) + '">' + V.themePreview(t) + '<span>' + V.esc(t.name) + '</span></button>'; }).join('') + '<button class="theme' + (pf.theme === 'auto' ? ' on' : '') + '" data-theme="auto" aria-pressed="' + (pf.theme === 'auto') + '"><div class="tp auto-tp"></div><span>Match my device</span></button></div>' +
    '<div class="grid2"><label class="field"><span>Text size</span><select class="input" data-pref-sel="uiScale">' + [[0.9, 'Small'], [1, 'Normal'], [1.15, 'Large'], [1.3, 'Extra large'], [1.5, 'Huge']].map(function (o) { return '<option value="' + o[0] + '"' + (+pf.uiScale === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
    '<label class="field"><span>TV mode (big, remote-friendly)</span><select class="input" data-pref-sel="tvMode">' + [['auto', 'Automatic'], ['on', 'On'], ['off', 'Off']].map(function (o) { return '<option value="' + o[0] + '"' + (pf.tvMode === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label></div>' +
    sw('reduceMotion', 'Reduce motion', 'Fewer animations') + '</section>' +

    '<section class="card-sec"><h2>Playback</h2>' + sw('autoplayNext', 'Play the next episode automatically') + sw('autoSkipIntro', 'Skip intros automatically') + sw('autoSkipCredits', 'Skip end credits automatically') +
    '<div class="grid2"><label class="field"><span>Quality</span><select class="input" data-pref-sel="quality">' + [['auto', 'Automatic (best for the connection)'], ['1080', 'Up to 1080p'], ['720', 'Up to 720p'], ['480', 'Up to 480p'], ['360', 'Up to 360p']].map(function (o) { return '<option value="' + o[0] + '"' + (String(pf.quality) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
    '<label class="field"><span>Preferred audio language</span><select class="input" data-pref-sel="audioLang">' + langOpts(pf.audioLang) + '</select></label>' +
    '<label class="field"><span>Subtitle language</span><select class="input" data-pref-sel="subLang">' + langOpts(pf.subLang) + '</select></label></div>' +
    '<label class="field"><span>Subtitles</span><select class="input" data-pref-sel="subsMode">' + [['off', 'Off unless I turn them on'], ['foreign', 'On when what I hear isn’t one of my languages'], ['always', 'Always on (when there are some in my language)']].map(function (o) { var cur = pf.subsMode || (pf.subsDefault ? 'always' : 'off'); return '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
    sw('stillWatching', 'Ask “Are you still watching?”', 'After 3 episodes in a row, or 4 hours of live TV, with nobody touching anything — so a forgotten TV doesn’t keep the connection busy') +
    sw('dataSaver', 'Data saver', 'Lower quality to use less data (good on mobile)') +
    '<button class="btn" data-a="substyle">' + V.icon('cc') + ' Subtitle style…</button></section>' +
    (V.playerPrefsHtml ? V.playerPrefsHtml() : '') +

    (V.tvMode
      ? '<section class="card-sec"><h2>Phone and TV</h2><p class="dim">Control this TV from your phone: play, pause, skip, channels, subtitles and volume, and pick things on the phone to play here.</p><div class="btn-row"><button class="btn primary" data-a="phoneremote">' + V.icon('remote') + ' Use your phone as a remote</button></div></section>'
      : '<section class="card-sec"><h2>Phone and TV</h2><p class="dim">Use this device as the remote for a TV or computer that has the app open: play, pause, skip, channels, subtitles and volume. Sign a TV in by typing the code it shows (no typing passwords with the TV remote).</p><div class="btn-row"><a class="btn primary" href="#/remote">' + V.icon('remote') + ' Use this as a remote</a><button class="btn" data-a="pair">' + V.icon('tv') + ' Sign in a TV</button></div></section>') +
    '<section class="card-sec"><h2>Notifications</h2>' + sw('newEpisodeAlerts', 'New episodes', 'Of series in My List, that you’ve been watching, or that you follow with the bell on their page') + sw('wishlistAlerts', 'Wishlist arrivals', 'When something on your wishlist arrives') +
    '<p class="dim small">Alerts also wait in Messages → New for you.</p>' +
    (window.Notification ? '<button class="btn" data-a="notif">' + V.icon('bell') + ' ' + (Notification.permission === 'granted' ? 'Notifications on this device are on' : Notification.permission === 'denied' ? 'Notifications are blocked in this browser' : 'Also notify me when the app isn’t open') + '</button>' : '') + '</section>' +
    '<section class="card-sec"><h2>Privacy</h2>' + sw('presence', 'Let others in the household see what I’m watching') +
    '<p><a href="#/mine/history">Watch history</a> · pause it or clear it there.</p><p><a href="#/viewing">Your viewing</a> · time watched, favourites and your year in review.</p></section>' +

    '<section class="card-sec"><h2>This device</h2><label class="field"><span>Device name (shown when you use “Play on…”)</span><div class="inline"><input class="input" data-devname value="' + V.esc(V.device.name) + '" maxlength="40"><button class="btn" data-a="devname">Save</button></div></label>' +
    '<label class="check"><input type="checkbox" data-askprofile' + (V.ls.get('askProfile', false) ? ' checked' : '') + '><span>Ask “Who’s watching?” every time the app opens on this device</span></label>' +
    '<div class="btn-row">' + (V.installPrompt ? '<button class="btn" data-a="install">' + V.icon('download') + ' Install as an app</button>' : '') + '<button class="btn" data-a="keys">' + V.icon('help') + ' Keyboard & remote shortcuts</button></div>' +
    (!window.isSecureContext ? '<p class="note">' + V.icon('info') + ' This address isn’t https, so installing as an app, in-app downloads and Chromecast aren’t available here. See the README for https.</p>' : '') + '</section>' +
    V.mixedSection() + V.directHelperSection() +
    (V.followSettingsHtml ? V.followSettingsHtml() : '') + // Teams and competitions (follow.js)
    (V.settingsExtra ? V.settingsExtra() : '') + // Trakt, OpenSubtitles, connection test (integrations.js)

    (!pr.admin ? '<section class="card-sec danger-zone"><h2>Remove this profile</h2><p class="dim">Deletes your history, lists and settings.</p><button class="btn danger" data-a="delete">Remove my profile</button></section>' : '') +
    '<p class="dim small center">' + V.esc((S.settings.brand || {}).name) + ' · version ' + V.esc(S.settings.version) + '</p>' +
    (S.settings.tmdb ? '<p class="dim small center tmdb-credit">' + 'Data and images from ' + V.TMDB_LOGO + '.<br>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>' : '') + '</div>';

  if (V.settingsExtraBind) V.settingsExtraBind(view);
  if (V.bindFollowSettings) V.bindFollowSettings(view);
  if (V.bindPlayerPrefs) V.bindPlayerPrefs(view);
  // http streams on this https site: does this browser let them through?
  var ms = V.$('.mixed-state', view);
  if (ms) {
    var hit = null;
    // (Addresses on this machine are always allowed, so they say nothing: use a provider's.)
    for (var mi = 0; mi < S.items.length && !hit; mi++) if (/^http:/i.test(S.items[mi].u || '') && !/^http:\/\/(localhost|127\.|\[::1\])/i.test(S.items[mi].u)) hit = S.items[mi].u;
    if (!hit) ms.textContent = 'None of the streams here use plain http.';
    else V.mixedOk(hit).then(function (ok) { ms.innerHTML = ok ? V.icon('check', 'tiny ok') + ' Allowed in this browser — http streams play straight from the provider.' : V.icon('info', 'tiny') + ' Not allowed in this browser yet, so http streams play through the server.'; });
  }
  // A Save button is off while its change is on the way (so it isn't sent twice).
  var busy = function (b, p) { b.disabled = true; return p.catch(V.fail).then(function () { b.disabled = false; }); };
  // Enter in a name box saves it, like its Save button.
  view.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || !e.target.matches('[data-name], [data-devname]')) return;
    e.preventDefault();
    var sb = V.$('[data-a="' + (e.target.hasAttribute('data-name') ? 'name' : 'devname') + '"]', view);
    if (sb && !sb.disabled) sb.click();
  });
  view.addEventListener('change', function (e) {
    var t = e.target;
    if (t.hasAttribute('data-askprofile')) { V.ls.set('askProfile', t.checked); V.toast(t.checked ? 'This device will ask who’s watching' : 'This device opens straight into your profile'); return; }
    if (t.dataset.pref) { V.setPref(t.dataset.pref, t.checked); if (t.dataset.pref === 'reduceMotion') V.applyLook(); }
    else if (t.dataset.prefSel) { var v = t.value; if (t.dataset.prefSel === 'uiScale') v = +v; V.setPref(t.dataset.prefSel, v); V.applyLook(); }
    else if (t.name === 'lmode') V.$('.lang-pick', view).hidden = t.value !== 'own';
    else if (t.dataset.interest !== undefined) V.put('/api/me', { interests: V.$$('[data-interest]:checked', view).map(function (x) { return x.value; }) }).then(function (p) { if (p && p.id) S.profile = p; }).catch(V.fail); // (kept, so the page shows them when opened again)
  });
  view.addEventListener('click', function (e) {
    var th = e.target.closest('button[data-theme]'); // (the page itself carries data-theme too)
    if (th) { V.setPref('theme', th.dataset.theme); V.ls.set('theme', th.dataset.theme); V.applyTheme(th.dataset.theme); V.$$('[data-theme]', view).forEach(function (x) { x.classList.toggle('on', x === th); x.setAttribute('aria-pressed', x === th); }); return; }
    var b = e.target.closest('[data-a]');
    if (!b) return;
    var a = b.dataset.a;
    if (a === 'avatar') V.avatarPicker(pr.avatar, { upload: true }).then(function (i) {
      if (i === null || i === undefined) return;
      var req = typeof i === 'object' && i.upload ? V.put('/api/me/avatar', { image: i.upload }) : V.put('/api/me', { avatar: i });
      req.then(function (p) { S.profile = p; V.renderShell(); V.router.refresh(); V.toast('Picture updated'); }).catch(V.fail);
    });
    else if (a === 'name') {
      var nm = V.$('[data-name]', view).value.trim();
      if (!nm) { V.toast('Type a name first', { error: true }); V.$('[data-name]', view).focus(); return; }
      busy(b, V.put('/api/me', { name: nm }).then(function (p) { S.profile = p; V.renderShell(); V.$('[data-name]', view).value = p.name; V.toast('Name saved'); }));
    }
    else if (a === 'pin') V.changePin();
    else if (a === 'nopin') V.prompt('Enter your current PIN to remove it', { type: 'password' }).then(function (cur) { if (cur === null) return; V.put('/api/me', { pin: '', currentPin: cur }).then(function (p) { S.profile = p; V.toast('PIN removed'); V.router.refresh(); }).catch(V.fail); });
    else if (a === 'langs') {
      var own = V.$('[name=lmode]:checked', view).value === 'own';
      var picked = V.$$('.lang-pick input:checked', view).map(function (x) { return x.value; });
      if (own && !picked.length) { V.toast('Pick at least one language, or use the default', { error: true }); return; }
      busy(b, V.put('/api/me', { langs: own ? picked : null, unknownLang: V.$('[data-unknown]', view).checked }).then(function (p) { S.profile = p; V.toast('Languages saved — reloading the catalogue. A language nobody here had before takes a few minutes to appear.', { ms: 7000 }); return V.loadCatalog(); }).then(function () { V.renderShell(); }));
    }
    else if (a === 'substyle') V.subtitleStyleDialog();
    else if (a === 'devname') { var n = V.$('[data-devname]', view).value.trim(); if (n) { V.ls.set('deviceName', n); V.device.name = n; V.rt.connect(); V.toast('Device name saved'); } else { V.toast('Type a name for this device first', { error: true }); V.$('[data-devname]', view).focus(); } }
    else if (a === 'notif') Notification.requestPermission().then(function () { V.router.refresh(); });
    else if (a === 'install' && V.installPrompt) { V.installPrompt.prompt(); V.installPrompt = null; }
    else if (a === 'keys') V.shortcutsHelp();
    else if (a === 'pair') V.pairDialog();
    else if (a === 'phoneremote' && V.phoneRemoteDialog) V.phoneRemoteDialog();
    else if (a === 'mixedhelp') V.mixedHelp();
    else if (a === 'delete') V.prompt('Remove your profile? Enter your PIN (or leave empty if you have none) to confirm.', { type: 'password', ok: 'Remove' }).then(function (pin) { if (pin === null) return; V.del('/api/me', { pin: pin }).then(function () { V.leaveProfile(); }).catch(V.fail); });
  });
});

V.changePin = function () {
  var pr = S.profile;
  V.dialog({
    title: pr.hasPin ? 'Change your PIN' : 'Add a PIN',
    body: (pr.hasPin ? '<label class="field"><span>Current PIN</span><input class="input" type="password" inputmode="numeric" data-cur maxlength="8"></label>' : '') + '<label class="field"><span>New PIN (4–8 digits)</span><input class="input" type="password" inputmode="numeric" data-new maxlength="8" autofocus></label><label class="field"><span>Repeat it</span><input class="input" type="password" inputmode="numeric" data-rep maxlength="8"></label>',
    actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, fn: function (d) {
      var n = V.$('[data-new]', d).value, r = V.$('[data-rep]', d).value;
      if (!/^\d{4,8}$/.test(n)) { V.toast('A PIN is 4 to 8 digits', { error: true }); return false; }
      if (n !== r) { V.toast('The two PINs don’t match', { error: true }); return false; }
      var cur = V.$('[data-cur]', d);
      return V.put('/api/me', { pin: n, currentPin: cur ? cur.value : '' }).then(function (p) { S.profile = p; V.toast('PIN saved'); V.router.refresh(); });
    } }],
  });
};

V.shortcutsHelp = function () { V.keyHelp('all'); };

V.applyLook = function () {
  var pf = (S.data && S.data.prefs) || {};
  var r = document.documentElement;
  r.style.fontSize = (16 * (+pf.uiScale || 1)) + 'px';
  r.classList.toggle('reduce-motion', !!pf.reduceMotion);
  var tv = pf.tvMode === 'on' || (pf.tvMode !== 'off' && V.device.tv);
  r.classList.toggle('tv', tv);
  V.tvMode = tv;
};

/**
 * Settings → "Direct streaming on this computer". Desktop browsers only: phones, tablets and TVs have built-in
 * players that don't need the provider's permission, and extensions aren't available there anyway.
 */
V.directHelperSection = function () {
  var ua = navigator.userAgent;
  if (V.device.touch || V.device.tv || /Mobile|Android/i.test(ua) || S.settings.routing === 'server') return '';
  var chromium = /Chrome|Chromium|Edg\//.test(ua), firefox = /Firefox\//.test(ua);
  if (!chromium && !firefox) return '';
  if (V.directHelper()) return '<section class="card-sec"><h2>Direct streaming</h2><p>' + V.icon('check') + ' The direct-streams helper is on. On this computer every channel plays straight from the provider.</p></section>';
  var where = /Edg\//.test(ua) ? 'edge://extensions' : /OPR\//.test(ua) ? 'opera://extensions' : /Brave/.test(ua) ? 'brave://extensions' : 'chrome://extensions';
  return '<section class="card-sec"><h2>Direct streaming</h2>' +
    '<p class="dim">Most channels already play straight from the provider. A few providers block web players; on this computer those go through the server instead. A tiny browser helper makes those direct too. It only lets this site read the streams it asks for, and doesn’t touch any other website.</p>' +
    (chromium ? '<ol class="steps"><li><a class="btn sm" href="/api/direct-helper.zip" download>' + V.icon('download') + ' Download the helper</a> and unzip it.</li><li>Open <code>' + where + '</code> and turn on <b>Developer mode</b>.</li><li>Click <b>Load unpacked</b> and choose the unzipped folder.</li><li>Reload this page.</li></ol>'
      : '<p class="dim small">Firefox can only load it until the next restart: <a href="/api/direct-helper.zip" download>download it</a>, unzip, then open <code>about:debugging</code> → This Firefox → Load Temporary Add-on → pick <code>manifest.json</code>. Chrome and Edge keep it permanently.</p>') +
    '</section>';
};

/** On an https address: whether this browser plays the providers' plain-http streams directly, and how to let it. */
V.mixedSection = function () {
  if (location.protocol !== 'https:' || S.settings.routing === 'server') return '';
  var how = V.mixedHowTo();
  return '<section class="card-sec"><h2>http streams</h2><p class="dim">This site is https. Streams sent over plain http only play straight from the provider when this browser allows “insecure content” for this site; otherwise they go through the server.</p>' +
    '<p class="mixed-state dim">' + V.icon('clock', 'tiny') + ' Checking…</p>' +
    (how ? '<button class="btn" data-a="mixedhelp">How to allow it in ' + how.browser + '</button>' : '') + '</section>';
};

/** TMDB's required attribution notice, with a link to them, shown wherever TMDB data is in use. */
V.TMDB_LOGO = '<a href="https://www.themoviedb.org/" target="_blank" rel="noopener">The Movie Database (TMDB)</a>';
