/* The quick launcher (Ctrl+K / ⌘K, a remote button, a long press on Search, the profile menu, or the button on the
   Search page): type to jump to any page, admin tab or setting, switch profile, play a channel ("BBC One", "ch 101"),
   open a film or series, or do something ("Sleep timer 30 min", "Report a problem"). Recent picks come first;
   typos are forgiven. */
'use strict';
(function () {
  var MAX = 12;
  var RECENT = 'palette.recent';

  // ------------------------------------------------------------ matching
  function dist(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev2 = null, prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      var best = i;
      for (j = 1; j <= b.length; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v;
        if (v < best) best = v;
      }
      if (best > max) return max + 1;
      prev2 = prev; prev = cur;
    }
    return prev[b.length];
  }
  /** How well `text` matches the query (0: not at all). Prefixes beat substrings beat near-misses. */
  function score(text, q) {
    var t = V.norm(text);
    if (!q) return 1;
    if (t.indexOf(q) === 0) return 100;
    var words = t.split(' ');
    var qw = q.split(' ');
    if (words.some(function (w) { return w.indexOf(q) === 0; })) return 85;
    if (qw.every(function (x) { return words.some(function (w) { return w.indexOf(x) === 0; }); })) return 75;
    if (t.indexOf(q) >= 0) return 60;
    // A typo or two: each word typed is close to the start of some word.
    var near = qw.every(function (x) {
      if (x.length < 3) return words.some(function (w) { return w.indexOf(x) === 0; });
      var max = x.length > 6 ? 2 : 1;
      return words.some(function (w) { return dist(x, w.slice(0, x.length), max) <= max || dist(x, w, max) <= max; });
    });
    if (near) return 40;
    // Initials ("pip" → "Picture-in-picture", "tm" → "TV mode").
    var ini = words.map(function (w) { return w.charAt(0); }).join(''), qq = q.replace(/ /g, '');
    return qq.length >= 2 && words.length > 1 && ini.indexOf(qq) === 0 ? 30 : 0;
  }

  // ------------------------------------------------------------ what can be found
  var setting = function (label, sel, kw) {
    return { id: 'set:' + label, label: label, hint: 'Setting', icon: 'gear', kw: kw || '', run: function () { gotoSetting(sel); } };
  };
  function gotoSetting(sel) {
    if (typeof sel === 'function') return sel();
    var find = function () {
      var el = V.$(sel);
      if (!el) return false;
      var target = el.closest('label, .field, section') || el;
      target.scrollIntoView({ block: 'center' });
      target.classList.add('pal-flash');
      setTimeout(function () { target.classList.remove('pal-flash'); }, 1800);
      var f = el.matches && el.matches('input, select, textarea, button') ? el : V.$('input, select, button', target);
      if (f) f.focus({ preventScroll: true });
      return true;
    };
    if (document.body.dataset.page === 'settings' && find()) return;
    V.router.go('#/settings');
    var n = 0;
    (function again() { if (!find() && ++n < 20) setTimeout(again, 60); })();
  }
  var ADMIN_TABS = [['overview', 'Overview'], ['stats', 'Statistics'], ['lists', 'Lists'], ['guides', 'TV guides'], ['profiles', 'Profiles', 'screen time bedtime kids age limit pin'], ['content', 'Languages & content'], ['categories', 'Categories'], ['playback', 'Playback'], ['network', 'Network & proxies'], ['recs', 'Recommendations'], ['brand', 'Brand'], ['security', 'Security', 'password devices'], ['mychannels', 'My channels'], ['outputs', 'Other apps'], ['integrations', 'Integrations', 'subtitles trakt'], ['api', 'API & automations', 'webhooks keys'], ['apps', 'Backups, updates & apps']];
  function staticEntries() {
    var out = [];
    var page = function (id, label, href, icon, kw) { out.push({ id: 'page:' + id, label: label, hint: 'Page', icon: icon || 'next', kw: kw || '', run: function () { V.router.go(href); } }); };
    var types = new Set((S.items || []).map(function (i) { return i.t; }));
    page('home', 'Home', '#/home', 'home');
    if (types.has('live')) { page('live', 'Live TV', '#/live', 'tv', 'channels'); page('guide', 'TV guide', '#/guide', 'clock', 'epg listings schedule'); page('favs', 'Favourite channels', '#/live?g=__fav', 'heart'); page('multiview', 'Multiview', '#/multiview', 'multi', 'several channels at once'); page('onlater', 'On later', '#/onlater', 'clock'); }
    if (types.has('movie')) page('movies', 'Movies', '#/movies', 'film', 'films');
    if (types.has('show')) page('series', 'Series', '#/series', 'stack', 'tv shows');
    if (types.has('radio')) page('radio', 'Radio', '#/radio', 'radio');
    page('mine', 'My List', '#/mine', 'bookmark', 'watchlist');
    page('history', 'Watch history', '#/mine/history', 'clock');
    page('queue', 'Your queue', '#/mine/queue', 'list', 'play next up');
    page('wishlist', 'Wishlist', '#/wishlist', 'star', 'wanted alerts not here yet');
    page('viewing', 'Your viewing', '#/viewing', 'chart', 'stats statistics time watched');
    if (V.routes.review) page('review', 'Year in review', '#/review', 'sparkle', 'yearly wrapped looking back');
    if (types.has('live')) page('follow', 'Teams you follow', '#/follow', 'star', 'sport sports events football team competition');
    page('search', 'Search', '#/search', 'search');
    page('messages', 'Messages', '#/messages', 'chat', 'chat');
    page('downloads', 'Downloads', '#/downloads', 'download', 'offline');
    if (V.dvr && V.dvr.visible()) page('recordings', 'Recordings', '#/recordings', 'rec', 'dvr recorded record tv');
    page('remote', 'Use this as a remote', '#/remote', 'remote', 'phone control tv');
    page('settings', 'Settings', '#/settings', 'gear', 'preferences options');
    if (S.profile && S.profile.admin) {
      page('admin', 'Admin', '#/admin', 'shield');
      var tabs = ADMIN_TABS.slice();
      (V.adminExtraTabs || []).forEach(function (t) { if (!tabs.some(function (x) { return x[0] === t[0]; })) tabs.push([t[0], t[1]]); });
      if (!tabs.some(function (x) { return x[0] === 'findguides'; })) tabs.push(['findguides', 'Find guides and logos', 'epg missing logos iptv-org']);
      tabs.forEach(function (t) { out.push({ id: 'admin:' + t[0], label: 'Admin: ' + t[1], hint: 'Admin', icon: 'shield', kw: t[2] || '', run: function () { V.router.go('#/admin/' + t[0]); } }); });
    }
    // Settings, one by one.
    out.push(setting('Subtitle style', function () { V.subtitleStyleDialog(); }, 'captions size colour font'));
    out.push(setting('Theme', '.themes .theme.on', 'colours look dark light'));
    out.push(setting('Text size', '[data-pref-sel=uiScale]', 'font bigger zoom'));
    out.push(setting('TV mode', '[data-pref-sel=tvMode]', 'remote big'));
    out.push(setting('Reduce motion', '[data-pref=reduceMotion]', 'animations'));
    out.push(setting('Languages', '[name=lmode]', 'language'));
    out.push(setting('Quality', '[data-pref-sel=quality]', 'resolution 1080p 720p'));
    out.push(setting('Preferred audio language', '[data-pref-sel=audioLang]', 'dub'));
    out.push(setting('Subtitle language', '[data-pref-sel=subLang]', 'captions'));
    out.push(setting('Subtitles on automatically', '[data-pref-sel=subsMode]', 'captions'));
    out.push(setting('Play the next episode automatically', '[data-pref=autoplayNext]', 'autoplay'));
    out.push(setting('Skip intros automatically', '[data-pref=autoSkipIntro]', 'credits'));
    out.push(setting('Are you still watching?', '[data-pref=stillWatching]'));
    out.push(setting('Data saver', '[data-pref=dataSaver]', 'mobile data'));
    out.push(setting('New episode notifications', '[data-pref=newEpisodeAlerts]', 'alerts'));
    out.push(setting('Show others what I’m watching', '[data-pref=presence]', 'privacy'));
    out.push(setting('Profile name', '[data-name]', 'rename'));
    out.push(setting('Profile picture', '[data-a=avatar]', 'avatar photo'));
    out.push(setting('Change PIN', function () { V.changePin(); }, 'password lock'));
    out.push(setting('Device name', '[data-devname]'));
    out.push(setting('Remote and keyboard buttons', function () { V.router.go('#/settings?s=remote'); }, 'coloured red green yellow blue keys mapping'));
    out.push(setting('Sign in a TV', function () { V.pairDialog(); }, 'pair code'));
    out.push(setting('Keyboard shortcuts', function () { V.keyHelp('all'); }, 'keys help'));
    (V.THEMES || []).forEach(function (t) { out.push({ id: 'theme:' + t.id, label: 'Theme: ' + t.name, hint: 'Look', icon: 'sparkle', run: function () { V.setPref('theme', t.id); V.ls.set('theme', t.id); V.applyTheme(t.id); V.toast('Theme: ' + t.name); if (document.body.dataset.page === 'settings') V.router.refresh(); } }); });
    // Profiles.
    ((S.boot && S.boot.profiles) || []).forEach(function (p) {
      if (S.profile && p.id === S.profile.id) return;
      out.push({ id: 'prof:' + p.id, label: 'Switch to ' + p.name, hint: 'Profile', icon: 'user', kw: 'profile', run: function () { switchTo(p.id); } });
    });
    out.push({ id: 'act:switch', label: 'Switch profile', hint: 'Profile', icon: 'users', kw: 'who is watching', run: function () { V.leaveProfile(); } });
    if (S.profile && S.profile.hasPin) out.push({ id: 'act:lock', label: 'Lock profile', hint: 'Profile', icon: 'lock', run: function () { V.leaveProfile(true); } });
    // Actions.
    var act = function (id, label, fn, icon, kw) { out.push({ id: 'act:' + id, label: label, hint: 'Action', icon: icon || 'play', kw: kw || '', run: fn }); };
    [15, 30, 45, 60, 90].forEach(function (m) { act('sleep' + m, 'Sleep timer ' + m + ' min', function () { V.setSleep(m); }, 'moon', 'stop after'); });
    if (V.sleepLeft && V.sleepLeft()) act('sleepoff', 'Turn off the sleep timer', function () { V.setSleep(0); }, 'moon');
    var p = V.watch && V.watch.it && V.player && V.player.started ? V.player : null;
    if (p && p.it && p.it.t === 'live' && V.audioOnly) act('soundonly', p._aoActive ? 'Turn off sound only' : 'Turn on sound only', function () { V.audioOnly.toggle(p); }, 'headphones', 'audio only listen picture off');
    ['subs', 'subsnext', 'audio', 'pip', 'info', 'last', 'playpause', 'whatson'].forEach(function (k) { if (V.actions && V.actions[k]) act(k, V.actions[k].label, V.actions[k].run, { subs: 'cc', subsnext: 'cc', audio: 'vol', pip: 'pip', info: 'info', last: 'back', playpause: 'play', whatson: 'tv' }[k], { info: 'stats details bitrate', last: 'previous channel', subs: 'captions' }[k]); });
    // Sound and subtitle timing (soundfx.js, subtiming.js), while something plays.
    if (p && p.setSoundFx && V.soundFx && V.soundFx.supported) {
      act('dialogue', V.pref('clearDialogue') ? 'Turn off clear dialogue' : 'Turn on clear dialogue', function () { p.setSoundFx('clearDialogue', !V.pref('clearDialogue')); }, 'vol', 'voices speech louder');
      act('night', V.pref('nightMode') ? 'Turn off night mode' : 'Turn on night mode', function () { p.setSoundFx('nightMode', !V.pref('nightMode')); }, 'moon', 'quiet loud explosions compress');
    }
    if (p && p.nudgeSubs && p.it && p.it.t !== 'radio') {
      act('subearlier', 'Subtitles earlier (0.1 s)', function () { p.nudgeSubs(-0.1); }, 'cc', 'subtitle timing sync delay');
      act('sublater', 'Subtitles later (0.1 s)', function () { p.nudgeSubs(0.1); }, 'cc', 'subtitle timing sync delay');
      act('subreset', 'Subtitle timing: reset', function () { p.setSubDelay(0); }, 'cc', 'subtitles sync delay in sync');
    }
    act('fullscreen', 'Full screen', function () { if (p) p.toggleFullscreen(); else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {}); }, 'fs');
    act('report', 'Report a problem', reportProblem, 'help', 'bug broken not working error');
    act('customize', 'Customise the home page', function () { V.router.go('#/home'); setTimeout(V.customizeHome, 200); }, 'sliders', 'rows');
    if (V.surprise) act('surprise', 'Surprise me', function () { V.surprise(); }, 'sparkle', 'random');
    if (V.screenTime && V.screenTime.limited()) act('askmore', 'Ask for more time', function () { V.screenTime.ask(); }, 'clock', 'screen time');
    return out;
  }
  function switchTo(id) {
    if (V.watch && V.watch.it) V.closePlayer();
    // The page's own clean-up too (multiview tiles would otherwise keep streaming behind "Who's watching?").
    if (V.pageCleanup) { try { V.pageCleanup(); } catch (e) {} V.pageCleanup = null; }
    V.rt.close();
    // As "Switch profile" does, then straight into the one picked (its PIN pad if it has one; cancelling it leaves
    // you on "Who's watching?").
    V.api('/api/profiles/leave', { body: {} }).catch(function () {}).then(function () {
      S.profile = null; S.data = null; S.items = []; S.recs = null; S.recsAt = 0; V._recsLoading = null; V._details = null; S.socialCache = null; S.extra = new Map();
      V.epg.clear();
      return V.api('/api/boot');
    }).then(function (b) { S.boot = b; V.showProfiles(); return V.selectProfile(id); }).catch(V.fail);
  }
  /** "Report a problem": a note to the admin (Admin → Error reports), with what's on screen. */
  function reportProblem() {
    // Something is playing: the player's own form (with what's wrong and how it played — problem.js).
    if (V.reportProblem && V.player && V.player.it) return V.reportProblem(V.player);
    V.dialog({
      title: 'Report a problem',
      body: '<p class="dim">Tell the admin what went wrong. Details about this device and what’s playing are added.</p><label class="field"><span>What happened?</span><textarea class="input" rows="3" data-what maxlength="800" autofocus></textarea></label>',
      actions: [{ label: 'Cancel' }, { label: 'Send', primary: true, fn: function (d) {
        var what = V.$('[data-what]', d).value.trim();
        if (!what) { V.toast('Write what happened first.', { error: true }); return false; }
        var it = V.watch && V.watch.it;
        var sent = V.reportError && V.reportError('user', { message: 'Other — ' + what.slice(0, 120) }, { choice: 'other', choiceLabel: 'Other', note: what.slice(0, 500), item: it ? { k: it.k, n: it.n, t: it.t } : undefined });
        if (sent === false) { V.toast('You’ve sent several reports just now. Please try again in a few minutes.', { error: true }); return false; }
        V.toast('Thanks for letting us know — your report has been sent.');
      } }],
    });
  }
  /** Channels, films and series for a query (the instant search). */
  function mediaEntries(q, raw) {
    var out = [];
    var m = /^(?:ch(?:annel)?\.?\s*)?(\d{1,5})$/i.exec(raw.trim());
    if (m) {
      var n = +m[1];
      (S.live || []).concat(S.radio || []).filter(function (c) { return c.no === n || String(c.no) === m[1]; }).slice(0, 3).forEach(function (c) { out.push(chEntry(c, 120)); });
    }
    if (!V.search || q.length < 2) return out;
    var hits = V.search.find(raw.replace(/^ch(annel)?\.?\s+/i, ''), { types: ['live', 'radio', 'movie', 'show'], limit: 30 });
    hits.forEach(function (it, i) {
      var base = 58 - i * 1.5 + (V.norm(it.n) === q ? 45 : V.norm(it.n).indexOf(q) === 0 ? 20 : 0);
      out.push(it.t === 'live' || it.t === 'radio' ? chEntry(it, base + 2) : itemEntry(it, base));
    });
    return out;
  }
  var chEntry = function (c, s) { return { id: 'ch:' + c.k, label: c.n, hint: (c.t === 'radio' ? 'Radio' : 'Channel') + (c.no ? ' ' + c.no : ''), icon: c.t === 'radio' ? 'radio' : 'tv', art: c.i, s: s, run: function () { V.play(c); } }; };
  var itemEntry = function (it, s) { return { id: 'item:' + it.k, label: it.n, hint: (it.t === 'show' ? 'Series' : 'Film') + (it.y ? ' · ' + it.y : ''), icon: it.t === 'show' ? 'stack' : 'film', art: it.i, s: s, run: function () { V.router.go(V.hrefOf(it)); } }; };
  /** An entry from its id (for recent picks). */
  function resolve(id, stat) {
    if (/^ch:/.test(id)) { var c = V.entry(id.slice(3)); return c ? chEntry(c, 0) : null; }
    if (/^item:/.test(id)) { var it = V.entry(id.slice(5)); return it ? itemEntry(it, 0) : null; }
    for (var i = 0; i < stat.length; i++) if (stat[i].id === id) return stat[i];
    return null;
  }
  var recent = function () { var r = V.ls.get(RECENT, []); return Array.isArray(r) ? r : []; };
  var remember = function (id) { var r = recent().filter(function (x) { return x !== id; }); r.unshift(id); V.ls.set(RECENT, r.slice(0, 8)); };

  function results(raw, stat) {
    var q = V.norm(raw);
    var rec = recent();
    if (!q) {
      var list = rec.map(function (id) { return resolve(id, stat); }).filter(Boolean).map(function (e) { return Object.assign({}, e, { recent: true }); });
      var more = ['page:home', 'page:guide', 'page:live', 'page:search', 'page:mine', 'act:sleep30', 'page:settings', 'act:report'].map(function (id) { return resolve(id, stat); }).filter(function (e) { return e && !list.some(function (x) { return x.id === e.id; }); });
      return list.concat(more).slice(0, MAX);
    }
    var scored = [];
    stat.forEach(function (e) {
      var s = Math.max(score(e.label, q), e.kw ? score(e.kw, q) * 0.7 : 0, e.hint ? score(e.hint + ' ' + e.label, q) * 0.8 : 0);
      if (s > 0) scored.push(Object.assign({}, e, { s: s + (rec.indexOf(e.id) >= 0 ? 15 - rec.indexOf(e.id) : 0) }));
    });
    mediaEntries(q, raw).forEach(function (e) { if (rec.indexOf(e.id) >= 0) e.s += 15 - rec.indexOf(e.id); if (!scored.some(function (x) { return x.id === e.id; })) scored.push(e); });
    // Entries other modules add (teams and competitions to follow: follow.js). One that fetches emits 'palette-more'.
    (V.paletteExtra || []).forEach(function (fn) { try { (fn(q, raw) || []).forEach(function (e) { if (!scored.some(function (x) { return x.id === e.id; })) scored.push(e); }); } catch (er) {} });
    scored.sort(function (a, b) { return b.s - a.s; });
    return scored.slice(0, MAX);
  }

  // ------------------------------------------------------------ the launcher
  var openDlg = null;
  function open(initial) {
    if (!S.profile) return;
    if (openDlg) { var od = V.$('dialog.palette-dlg'); if (od && od._finish) od._finish(null); return; }
    var stat = staticEntries();
    var list = [], active = 0, chosen = null, offMore = null;
    openDlg = V.dialog({
      cls: 'palette-dlg',
      body: '<div class="pal-box"><span class="pal-i">' + V.icon('search') + '</span><input class="input pal-in" type="search" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" aria-label="Go to a page, setting, channel or title, or do something" placeholder="Go to, play or do…" autocomplete="off" spellcheck="false" enterkeyhint="go"></div>' +
        '<div class="pal-list" id="pal-list" role="listbox" aria-label="Results"></div><p class="pal-foot dim small">' + (V.tvMode ? 'OK opens · Back closes' : '↑ ↓ to choose · Enter opens · Esc closes') + '</p>',
      onOpen: function (d, finish) {
        d.setAttribute('aria-label', 'Quick launcher');
        var input = V.$('.pal-in', d), box = V.$('.pal-list', d);
        if (initial) input.value = initial;
        var draw = function () {
          list = results(input.value, stat);
          if (active >= list.length) active = 0;
          box.innerHTML = list.length ? list.map(function (e, i) {
            return '<button type="button" class="pal-o' + (i === active ? ' on' : '') + '" role="option" id="pal-o' + i + '" aria-selected="' + (i === active) + '" data-i="' + i + '">' +
              (e.art ? '<span class="pal-art">' + V.art(e.art, e.label, 'art sm') + '</span>' : '<span class="pal-ic">' + V.icon(e.icon || 'next') + '</span>') +
              '<span class="pal-t truncate">' + V.esc(e.label) + '</span><span class="pal-h">' + (e.recent ? V.icon('clock', 'tiny') + ' ' : '') + V.esc(e.hint || '') + '</span></button>';
          }).join('') : '<p class="pal-none dim">Nothing matches “' + V.esc(input.value.trim()) + '”. Try fewer letters.</p>';
          if (list.length) input.setAttribute('aria-activedescendant', 'pal-o' + active); else input.removeAttribute('aria-activedescendant');
        };
        var mark = function () {
          V.$$('.pal-o', box).forEach(function (b, i) { b.classList.toggle('on', i === active); b.setAttribute('aria-selected', i === active); });
          input.setAttribute('aria-activedescendant', 'pal-o' + active);
          var on = V.$('.pal-o.on', box); if (on) on.scrollIntoView({ block: 'nearest' });
        };
        var pick = function (i) { var e = list[i]; if (!e) return; chosen = e; finish(e.id); };
        draw();
        offMore = V.on('palette-more', function () { if (input.value.trim()) draw(); });
        input.addEventListener('input', function () { active = 0; draw(); });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            // (On a TV the arrows move between the results themselves.)
            if (V.tvMode) { if (e.key === 'ArrowDown') { var f = V.$('.pal-o', box); if (f) { e.preventDefault(); e.stopPropagation(); f.focus(); } } return; }
            e.preventDefault(); e.stopPropagation();
            if (!list.length) return;
            active = (active + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
            mark();
          } else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); pick(active); }
        });
        box.addEventListener('click', function (e) { var b = e.target.closest('[data-i]'); if (b) pick(+b.dataset.i); });
        box.addEventListener('focusin', function (e) { var b = e.target.closest('[data-i]'); if (b && +b.dataset.i !== active) { active = +b.dataset.i; mark(); } });
        box.addEventListener('mousemove', function (e) { var b = e.target.closest('[data-i]'); if (b && +b.dataset.i !== active) { active = +b.dataset.i; mark(); } });
        // Typing while a result has the focus (a TV remote's number keys, a keyboard) goes into the box.
        d.addEventListener('keydown', function (e) {
          if (e.target === input || e.ctrlKey || e.metaKey || e.altKey) return;
          if (e.key && e.key.length === 1 && e.key !== ' ') { e.preventDefault(); input.focus(); input.value += e.key; active = 0; draw(); }
          else if (e.key === 'Backspace' && input.value) { e.preventDefault(); input.focus(); input.value = input.value.slice(0, -1); draw(); }
        });
        // TVs: start on the results (the on-screen keyboard only when asked for); elsewhere, type straight away.
        setTimeout(function () { if (V.tvMode && !initial) { var f = V.$('.pal-o', box); if (f) f.focus(); } else { input.focus(); } }, 40);
      },
    });
    openDlg.then(function (id) {
      openDlg = null;
      if (offMore) offMore();
      if (!id || !chosen) return;
      remember(id);
      // (After the launcher has gone, so focus and Back behave as if the thing had been picked directly.)
      setTimeout(function () { try { chosen.run(); } catch (e) { V.fail(e); } }, 30);
    });
  }
  V.palette = { report: reportProblem, open: open, score: score, entries: staticEntries, results: results };

  // ------------------------------------------------------------ ways in
  // Ctrl+K / ⌘K anywhere (also in a text box: browsers would otherwise jump to their own search bar).
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K' || e.keyCode === 75)) {
      if (!S.profile || !V.$('#profiles').hidden) return;
      e.preventDefault(); e.stopPropagation();
      open();
    }
  }, true);
  // A long press on the Search button: OK held on a remote, a finger held on a phone.
  var held = null;
  document.addEventListener('keydown', function (e) {
    var a = e.target && e.target.closest && e.target.closest('#topbar [data-nav=search]');
    if (!a || e.key !== 'Enter') return;
    e.preventDefault(); e.stopPropagation();
    if (e.repeat || held) return;
    held = setTimeout(function () { held = 'done'; open(); }, 600);
  }, true);
  document.addEventListener('keyup', function (e) {
    var a = e.target && e.target.closest && e.target.closest('#topbar [data-nav=search]');
    if (!a || e.key !== 'Enter' || !held) return;
    if (held !== 'done') { clearTimeout(held); V.router.go('#/search'); }
    held = null;
  }, true);
  var touchT = null, touchFired = false;
  document.addEventListener('touchstart', function (e) {
    var a = e.target.closest && e.target.closest('[data-nav=search]');
    if (!a) return;
    touchFired = false;
    touchT = setTimeout(function () { touchFired = true; if (navigator.vibrate) navigator.vibrate(15); open(); }, 550);
  }, { passive: true });
  document.addEventListener('touchend', function () { clearTimeout(touchT); }, { passive: true });
  document.addEventListener('touchmove', function () { clearTimeout(touchT); }, { passive: true });
  document.addEventListener('click', function (e) { if (touchFired && e.target.closest && e.target.closest('[data-nav=search]')) { touchFired = false; e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener('contextmenu', function (e) { if (e.target.closest && e.target.closest('[data-nav=search]')) { e.preventDefault(); if (!touchFired) open(); } });
  // A button on the Search page (phones, tablets, TVs).
  var origSearch = V.routes.search;
  V.routes.search = function (view, r) {
    origSearch(view, r);
    var form = V.$('.search-box', view);
    if (!form) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn sm pal-launch';
    b.innerHTML = V.icon('sparkle') + '<span>Quick launcher</span>';
    b.setAttribute('aria-label', 'Quick launcher: pages, settings, channels and actions');
    b.onclick = function () { open(V.$('[data-q]', view) ? V.$('[data-q]', view).value : ''); };
    form.parentNode.insertBefore(b, form.nextSibling);
  };
})();
