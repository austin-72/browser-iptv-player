/* Admin: lists, guides, profiles, languages, playback, recommendations, brand, security, backup. */
'use strict';
V.route('admin', function (view, r) {
  // A manager (a role the admin gives a profile: Profiles) gets four sections of this and no more.
  var mgr = !S.profile.admin && V.canManage();
  var MGR_TABS = ['manage', 'channels', 'health', 'errors'];
  if (!S.profile.admin && !mgr) { view.innerHTML = V.empty('Admin only', 'Only the admin profile can open this.'); return; }
  var tab = r.args[0] || (mgr ? 'manage' : 'overview');
  if (mgr && MGR_TABS.indexOf(tab) < 0) tab = 'manage';
  var names = { overview: 'Overview', stats: 'Statistics', lists: 'Lists', guides: 'TV guides', profiles: 'Profiles', content: 'Languages & content', categories: 'Categories', playback: 'Playback', network: 'Network & proxies', recs: 'Recommendations', brand: 'Brand', security: 'Security', mychannels: 'My channels', outputs: 'Other apps', integrations: 'Integrations', api: 'API & automations', apps: 'Backups & updates' };
  // The sections, in groups (a sidebar on big screens; group chips and sub-tabs on phones).
  var groups = [
    ['status', 'Status', ['overview', 'stats', 'errors', 'health']],
    ['sources', 'Lists & channels', ['lists', 'channels', 'guides', 'categories', 'mychannels']],
    ['viewing', 'Viewing', ['playback', 'dvr', 'content', 'recs']],
    ['people', 'People & security', ['profiles', 'security']],
    ['connect', 'Connections', ['network', 'outputs', 'integrations', 'api']],
    ['system', 'System', ['brand', 'apps']],
  ];
  // Sections added by other parts of the app: [id, label, after which section].
  (V.adminExtraTabs || []).forEach(function (t) {
    names[t[0]] = names[t[0]] || t[1];
    if (groups.some(function (g) { return g[2].indexOf(t[0]) >= 0; })) return;
    var g = groups.filter(function (x) { return x[2].indexOf(t[2]) >= 0; })[0] || groups[groups.length - 1];
    var i = g[2].indexOf(t[2]);
    g[2].splice(i < 0 ? g[2].length : i + 1, 0, t[0]);
  });
  if (mgr) { names.manage = 'Requests and lists'; groups = [['manage', 'Managing', MGR_TABS.slice()]]; }
  groups.forEach(function (g) { g[2] = g[2].filter(function (id) { return names[id] && (V.adminTabs[id] || id === 'overview'); }); });
  // (Pages reached from inside another, like "Find guides": shown under that one's group.)
  var within = { findguides: 'guides' };
  var cur = within[tab] || tab;
  var group = groups.filter(function (g) { return g[2].indexOf(cur) >= 0; })[0] || groups[0];
  var link = function (id, cls) { return '<a class="' + cls + (id === cur ? ' on' : '') + '"' + (id === cur ? ' aria-current="page"' : '') + ' href="#/admin/' + id + '">' + V.esc(names[id]) + '</a>'; };
  view.innerHTML = V.pageHead(mgr ? 'Manage' : 'Admin') + '<div class="adm' + (mgr ? ' is-mgr' : '') + '">' +
    '<nav class="adm-nav" aria-label="Admin sections">' + groups.map(function (g) { return '<div class="adm-g"><div class="adm-gh">' + V.esc(g[1]) + '</div>' + g[2].map(function (id) { return link(id, 'adm-l'); }).join('') + '</div>'; }).join('') + '</nav>' +
    '<div class="adm-main">' +
    '<div class="adm-groups" role="tablist" aria-label="Admin groups">' + groups.map(function (g) { return '<a role="tab" class="chip' + (g === group ? ' on' : '') + '" aria-selected="' + (g === group) + '" href="#/admin/' + g[2][0] + '">' + V.esc(g[1]) + '</a>'; }).join('') + '</div>' +
    (group[2].length > 1 ? '<div class="tabs adm-sub" role="tablist">' + group[2].map(function (id) { return '<a role="tab" class="tab' + (id === cur ? ' on' : '') + '" aria-selected="' + (id === cur) + '" href="#/admin/' + id + '">' + V.esc(names[id]) + '</a>'; }).join('') + '</div>' : '') +
    '<h2 class="adm-title">' + V.esc(names[cur] || 'Admin') + '</h2>' +
    '<div class="admin-body"><div class="spinner"></div></div></div></div>';
  var on = V.$('.adm-groups .on', view);
  if (on && on.scrollIntoView) try { on.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {}
  var body = V.$('.admin-body', view);
  V.api('/api/admin').then(function (A) {
    S.admin = A;
    // Left the page before this came back: don't draw (or start timers) into it — its clean-up has already run.
    if (!document.documentElement.contains(body)) return;
    (V.adminTabs[tab] || (mgr ? V.adminTabs.manage : V.adminTabs.overview))(body, A);
    // "Add a list" from an empty home page: straight to the form.
    if (tab === 'lists' && r.q.get('add') && /^#\/admin\/lists/.test(location.hash)) {
      try { history.replaceState(null, '', '#/admin/lists'); } catch (e) {}
      V.addListDialog().then(function (ok) { if (ok) V.router.refresh(); });
    }
  }).catch(function (e) { body.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
});

V.adminSave = function (patch, msg) {
  return V.put('/api/admin/settings', patch).then(function (s) { S.admin.settings = s; V.toast(msg || 'Saved'); return s; }).catch(function (e) { V.fail(e); throw e; });
};

V.adminTabs = {};

/** A number field's value, or null when it's empty (put the saved value back then, rather than saving 0). */
V.adminNum = function (el, saved) {
  var v = String(el.value).trim();
  if (v === '' || isNaN(+v)) { el.value = saved === undefined || saved === null ? '' : saved; V.toast('Enter a number', { error: true }); return null; }
  return +v;
};

/* A manager's first page: requests for more time, and fetching a list or guide again. (What a manager may ask the
   server for: MANAGER_API in server.js.) */
V.adminTabs.manage = function (body, A) {
  var when = function (s) { return s && s.at ? 'fetched ' + V.fmtAgo(s.at) : 'not fetched yet'; };
  var row = function (kind, x) {
    var s = x.status || {};
    return '<li class="mg-row" data-kind="' + kind + '" data-id="' + V.esc(x.id) + '"><div class="grow"><b>' + V.esc(x.name || 'Unnamed') + '</b>' + (x.enabled === false ? ' <span class="chip sm">Off</span>' : '') +
      '<div class="dim small">' + (s.error ? '<span class="err">' + V.esc(s.error) + '</span> · ' : '') + (kind === 'lists' && s.count ? s.count.toLocaleString() + ' entries · ' : '') + when(s) + '</div></div>' +
      '<button class="btn sm" data-refresh' + (x.enabled === false ? ' disabled' : '') + '>' + V.icon('refresh') + ' Fetch again</button></li>';
  };
  body.innerHTML = '<section class="card-sec"><h2>Asking for more time</h2><div data-mg-reqs><div class="spinner"></div></div></section>' +
    '<section class="card-sec"><h2>Lists</h2><p class="dim">Channels missing, or a film that should be there by now? Fetch the list again.</p>' + ((A.lists || []).length ? '<ul class="mg-list">' + A.lists.map(function (l) { return row('lists', l); }).join('') + '</ul>' : '<p class="dim">No lists yet.</p>') + '</section>' +
    ((A.guides || []).length ? '<section class="card-sec"><h2>TV guides</h2><ul class="mg-list">' + A.guides.map(function (g) { return row('guides', g); }).join('') + '</ul></section>' : '') +
    '<p class="dim small">' + V.icon('info', 'tiny') + ' As a manager you can also fix channels, look at which channels are failing and deal with error reports — the other sections here. Settings, the lists’ own details, profiles, PINs and locks, backups and updates are the admin’s.</p>';
  var box = V.$('[data-mg-reqs]', body);
  var fmt = function (m) { return m >= 60 ? (m % 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m / 60 + (m === 60 ? ' hour' : ' hours')) : m + ' min'; };
  var draw = function () {
    return V.api('/api/admin/screentime').then(function (r) {
      if (!document.documentElement.contains(body)) return;
      var pend = (r.pending || []).filter(function (x) { return x.pid !== S.profile.id; });
      var lim = Object.keys(r.profiles || {}).filter(function (id) { var x = r.profiles[id]; return id !== S.profile.id && x.rule && x.rule.on; });
      var nameOf = function (id) { var p = (A.profiles || []).filter(function (y) { return y.id === id; })[0]; return p ? p.name : 'Someone'; };
      box.innerHTML = (pend.length ? '<ul class="mg-list">' + pend.map(function (q) {
        return '<li class="mg-row" data-req="' + V.esc(q.id) + '" data-min="' + (+q.minutes || 0) + '"><div class="grow"><b>' + V.esc(q.name) + '</b> asks for ' + V.esc(fmt(+q.minutes || 0)) + ' more' + (q.note ? '<div class="dim small">“' + V.esc(q.note) + '”</div>' : '') + '</div>' +
          '<button class="btn sm primary" data-give>Give ' + V.esc(fmt(+q.minutes || 0)) + '</button><button class="btn sm" data-no>Not today</button></li>';
      }).join('') + '</ul>' : '<p class="dim">Nobody is asking right now. A request also pops up here the moment it’s made.</p>') +
        (lim.length ? '<h3 class="mg-h">Give extra time today</h3><ul class="mg-list">' + lim.map(function (id) {
          return '<li class="mg-row" data-pid="' + V.esc(id) + '"><div class="grow"><b>' + V.esc(nameOf(id)) + '</b></div>' + [15, 30, 60].map(function (m) { return '<button class="btn sm" data-grant="' + m + '">+' + fmt(m) + '</button>'; }).join('') + '</li>';
        }).join('') + '</ul>' : '');
    }).catch(function (e) { box.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
  };
  draw();
  body.onclick = function (e) {
    var b = e.target.closest('button'), li = b && b.closest('.mg-row');
    if (!b || !li || b.disabled) return;
    if (b.hasAttribute('data-refresh')) {
      b.disabled = true;
      V.api('/api/admin/' + li.dataset.kind + '/' + encodeURIComponent(li.dataset.id) + '/refresh', { method: 'POST' }).then(function (x) {
        V.toast(x && x.running ? 'Still fetching — it carries on by itself.' : 'Fetched again');
        if (!(x && x.running)) V.router.refresh(); else b.disabled = false;
      }).catch(function (er) { b.disabled = false; V.fail(er); });
    } else if (b.hasAttribute('data-give') || b.hasAttribute('data-no')) {
      b.disabled = true;
      var ok = b.hasAttribute('data-give');
      (V.stAnswer ? V.stAnswer(li.dataset.req, ok, ok ? +li.dataset.min : 0) : Promise.reject(new Error('Screen time isn’t available.'))).then(null, function (er) { b.disabled = false; V.fail(er); });
    } else if (b.hasAttribute('data-grant')) {
      b.disabled = true;
      V.api('/api/admin/screentime/' + encodeURIComponent(li.dataset.pid) + '/grant', { body: { minutes: +b.dataset.grant } }).then(function () { b.disabled = false; V.toast('Done — ' + fmt(+b.dataset.grant) + ' more today.'); }, function (er) { b.disabled = false; V.fail(er); });
    }
  };
};

V.adminTabs.overview = function (body, A) {
  var st = A.status;
  var pname = function (id) { var p = A.profiles.filter(function (x) { return x.id === id; })[0]; return p ? p.name : '?'; };
  body.innerHTML = (st.alerts || []).map(function (a) { return '<div class="note warn">' + V.icon('bell') + ' <span>' + (a.kind === 'expiry' ? '<b>' + V.esc(a.list) + '</b> ' + (a.days < 0 ? 'has expired.' : a.days === 0 ? 'expires today.' : 'expires in ' + V.plural(a.days, 'day') + '.') : '<b>' + V.esc(a.list) + '</b>: the provider says the account is “' + V.esc(a.status) + '”.') + '</span></div>'; }).join('') +
    (st.needsRestart ? '<div class="note">' + V.icon('refresh') + ' <span>An update to the server is on disk. It takes effect the next time you restart the server. <a href="#/admin/apps">Details</a></span></div>' : '') +
    (st.errors && st.errors.open ? '<div class="note">' + V.icon('info') + ' <span>' + V.plural(st.errors.open, 'problem') + ' reported by devices or the server, the latest ' + V.fmtAgo(st.errors.last) + '. <a href="#/admin/errors">See the error reports</a>.</span></div>' : '') +
    (st.defaultPassword ? '<div class="note warn">' + V.icon('shield') + ' <span>The site password is still the default. <a href="#/admin/security">Change it</a>.</span></div>' : '') +
    (st.epg && st.epg.programmes && st.epg.until && st.epg.until < Date.now() + 3 * 3600e3 ? '<div class="note warn">' + V.icon('clock') + ' <span>TV guide listings ' + (st.epg.until < Date.now() ? 'ran out ' + V.fmtAgo(st.epg.until) : 'run out at ' + V.fmtClock(st.epg.until)) + ' for most channels — the guide source may have stopped updating. <a href="#/admin/guides">Check the TV guides</a>.</span></div>' : '') +
    (!st.ffmpeg ? '<div class="note warn">' + V.icon('info') + ' ffmpeg isn’t installed, so MKV/AVI/HEVC/RTMP etc. can’t be converted and downloads can’t be converted to MP4. The Docker image includes it.</div>' : '') +
    (!A.lists.length ? '<div class="note">' + V.icon('info') + ' <span>No lists yet. <a href="#/admin/lists">Add your first playlist</a> — everyone sees it right away.</span></div>' : '') +
    '<div class="stats">' + [['Channels', st.catalog.counts.live || 0], ['Movies', st.catalog.counts.movie || 0], ['Series', st.catalog.counts.show || 0], ['Episodes', st.catalog.counts.episode || 0], ['Radio', st.catalog.counts.radio || 0], ['Guide programmes', st.epg.programmes || 0], ['Profiles', A.profiles.length], ['Signed-in devices', A.devices.length]].filter(function (x) { return x[0] !== 'Episodes' || x[1]; }).map(function (x) { return '<div class="stat"><b class="num">' + Number(x[1]).toLocaleString() + '</b><span>' + x[0] + '</span></div>'; }).join('') + '</div>' +
    // Providers (their accounts and connections) and who's watching from each: filled in live (integrations.js).
    '<section class="card-sec pv-sec" data-watching><div class="sec-h"><h2>Providers and watching now</h2></div>' + (A.watching.length ? '<ul class="simple">' + A.watching.map(function (w) { return '<li><b>' + V.esc(pname(w.pid)) + '</b> · ' + V.esc(w.n) + ' <span class="dim">on ' + V.esc(w.device) + ' · ' + V.fmtAgo(w.at) + '</span></li>'; }).join('') + '</ul>' : '<div class="spinner sm"></div>') + '</section>' +
    '<section class="card-sec"><h2>Server conversions</h2>' + (st.sessions.length ? '<ul class="simple">' + st.sessions.map(function (s) { return '<li>' + V.esc(s.label) + ' <span class="dim">· ' + (s.transcode ? 'transcoding' + (s.hw ? ' (' + s.hw + ')' : '') + (s.height ? ' ' + s.height + 'p' : '') : 'remuxing') + ' · ' + V.esc(pname(s.owner)) + ' · ' + V.fmtAgo(s.startedAt) + '</span> <button class="btn sm" data-stop="' + s.id + '">Stop</button></li>'; }).join('') + '</ul>' : '<p class="dim">None running.</p>') + '</section>' +
    '<section class="card-sec"><h2>Server</h2><dl class="kv"><dt>Version</dt><dd>' + V.esc(st.version) + '</dd><dt>ffmpeg</dt><dd>' + (st.ffmpeg ? V.esc(st.ffmpegVersion) + (st.hw ? ' · hardware: ' + st.hw : '') : 'not found') + '</dd><dt>Intro detection</dt><dd>' + (st.intro ? 'available' : 'unavailable') + '</dd><dt>TMDB</dt><dd>' + (st.tmdb.enabled ? 'on · ' + st.tmdb.matched + ' titles matched' + (st.tmdb.error ? ' · ' + V.esc(st.tmdb.error) : '') : 'off') + '</dd><dt>Data folder</dt><dd><code>' + V.esc(st.dataDir) + '</code></dd><dt>Listening on</dt><dd>' + V.esc(st.listen) + '</dd><dt>System</dt><dd>' + V.esc(st.platform + ' · Node ' + st.node) + '</dd><dt>Up for</dt><dd>' + V.fmtLen(st.uptime) + '</dd>' + (st.mem ? '<dt>Memory</dt><dd>' + V.fmtSize(st.mem) + (st.items ? ' · ' + V.plural(st.items, 'catalogue entry', 'catalogue entries') : '') + '</dd>' : '') + '</dl></section>';
  if (V.adminWatching) V.adminWatching(V.$('[data-watching]', body)); // live: quality, route, connections (integrations.js)
  body.onclick = function (e) {
    var b = e.target.closest('[data-stop]'); if (b) { b.disabled = true; V.del('/api/admin/sessions/' + b.dataset.stop).then(function () { V.router.refresh(); }).catch(function (x) { b.disabled = false; V.fail(x); }); }
  };
};
/** "EVESTV · active · expires 30 Oct 2027 (364 days) · 1 connection · in use by Mom (Living Room TV)" */
V.adminAccountLine = function (l) {
  var a = l.account || {};
  var days = a.expires ? Math.floor((a.expires - Date.now()) / 86400e3) : null;
  var use = l.inUse || [];
  return '<b>' + V.esc(l.name) + '</b> <span class="dim">· ' + V.esc(a.status || '?') + (a.expires ? ' · expires ' + new Date(a.expires).toLocaleDateString() + ' (<span class="' + (days <= 14 ? 'err' : '') + '">' + (days < 0 ? 'expired' : V.plural(days, 'day')) + '</span>)' : '') +
    (a.maxConnections ? ' · ' + V.plural(+a.maxConnections, 'connection') + ' allowed' : '') + (a.activeConnections !== undefined && a.activeConnections !== '' ? ' · provider says ' + V.esc(a.activeConnections) + ' in use' : '') + '</span>' +
    (use.length ? '<div class="small">In use by ' + use.map(function (u) { return V.esc(u.name) + ' (' + V.esc(u.device) + ': ' + V.esc(u.n) + ')'; }).join(', ') + '</div>' : '') + (a.checkedAt ? '<div class="dim small">Checked ' + V.fmtAgo(a.checkedAt) + '</div>' : '');
};

/** A list's live channels, series and films with duplicates combined, and how many only this list has. */
V.listUniqLine = function (u) {
  if (!u) return '';
  var parts = [['live', 'live channel', 'live channels'], ['show', 'series', 'series'], ['movie', 'film', 'films']].filter(function (x) { return u[x[0]] && u[x[0]][0]; });
  if (!parts.length) return '';
  var n = function (v, one, many) { return Number(v).toLocaleString() + ' ' + (v === 1 ? one : many); };
  return '<div class="al-s small dim al-uniq">' + parts.map(function (x) { var c = u[x[0]]; return n(c[0], x[1], x[2]) + ' <span title="Not in any other list">(' + Number(c[1]).toLocaleString() + ' only here)</span>'; }).join(' · ') + '</div>';
};

V.adminTabs.lists = function (body, A) {
  var draw = function () {
    // Keep the focus on the same button through a redraw (a TV remote would lose its place every 4 s while refreshing).
    var fa = document.activeElement, fli = fa && body.contains(fa) && fa.closest('[data-id]');
    var fk = fli ? ['data-up', 'data-down', 'data-en', 'data-ct', 'data-ref', 'data-edit', 'data-del'].filter(function (k) { return fa.hasAttribute(k); })[0] : null;
    var fid = fli ? fli.dataset.id : null;
    body.innerHTML = '<div class="page-tools"><button class="btn primary" data-add>' + V.icon('plus') + ' Add a list</button><span class="dim">Lists are merged into one catalogue for everyone, with duplicates combined (other copies become backup streams). Order matters: the first list wins when the same channel is in several.</span></div>' +
      (A.lists.length ? '<ul class="adm-list">' + A.lists.map(function (l, i) {
        var s = l.status || {};
        var px = l.proxy === 'none' ? 'no proxy' : l.proxy ? ((A.settings.proxies || []).filter(function (x) { return x.id === l.proxy; })[0] || {}).name : '';
        var info = (l.type === 'xtream' || (l.type === 'stalker' && l.account) ? (l.account ? V.adminAccountLine(l) : '') : V.listInfo && V.listInfo(l) ? V.listInfo(l) : l.type === 'folder' ? V.esc((l.folders || []).join(', ')) : l.type === 'url' ? V.esc(l.url) : 'Uploaded file') + (px ? '<div>' + V.icon('globe', 'tiny') + ' Proxy: ' + V.esc(px) + '</div>' : '');
        return '<li class="' + (l.enabled ? '' : 'off') + '" data-id="' + l.id + '"><div class="al-h"><span class="al-type">' + ({ url: 'Playlist', file: 'File', xtream: 'Xtream', folder: 'Folder', stalker: 'Portal', mediaserver: ({ jellyfin: 'Jellyfin', emby: 'Emby', plex: 'Plex' })[l.kind] || 'Library' }[l.type]) + '</span><b>' + V.esc(l.name) + '</b>' + (s.format ? '<span class="chip sm">' + V.esc(s.format) + '</span>' : '') + '<span class="sp"></span>' +
          '<button class="icon-btn" data-up aria-label="Move up"' + (i ? '' : ' disabled') + '>' + V.icon('up') + '</button><button class="icon-btn" data-down aria-label="Move down"' + (i < A.lists.length - 1 ? '' : ' disabled') + '>' + V.icon('down') + '</button>' +
          '<label class="switch sm"><input type="checkbox" data-en' + (l.enabled ? ' checked' : '') + '><span class="sw"></span><span class="sr-only">Enabled</span></label>' + (l.type !== 'folder' ? '<button class="icon-btn" data-ct aria-label="Test how many streams play at once" title="Test how many streams play at once">' + V.icon('pulse') + '</button>' : '') + '<button class="icon-btn" data-ref aria-label="Refresh now"' + (l.refreshing ? ' disabled' : '') + '>' + V.icon('refresh') + '</button><button class="icon-btn" data-edit aria-label="Edit">' + V.icon('edit') + '</button><button class="icon-btn" data-del aria-label="Delete">' + V.icon('trash') + '</button></div>' +
          '<div class="al-b dim small">' + info + '</div><div class="al-s small">' + (l.refreshing ? '<span class="spinner sm"></span> Refreshing…' : s.ok ? V.icon('check', 'tiny ok') + ' ' + V.plural(s.count || 0, 'item') + ' · updated ' + V.fmtAgo(s.at) : s.error ? '<span class="err">' + V.icon('x', 'tiny') + ' ' + V.esc(s.error) + '</span>' + (s.count ? ' <span class="dim">(using the saved copy)</span>' : '') : '') +
          (l.refreshHours ? ' · every ' + l.refreshHours + ' h' : ' · no automatic refresh') + (l.lang ? ' · language forced: ' + V.esc(V.langName(l.lang)) : '') + '</div>' +
          V.listUniqLine(l.uniq) +
          (l.testing ? '<div class="al-s small"><span class="spinner sm"></span> Testing how many streams play at once…</div>' : l.connTest ? '<div class="al-s small">' + V.icon('pulse', 'tiny') + ' ' + V.connTestLine(l.connTest) + ' <span class="dim">· tested ' + V.fmtAgo(l.connTest.at) + '</span></div>' : '') + '</li>';
      }).join('') + '</ul>' : V.empty('No lists yet', 'Add an M3U/M3U8 playlist (any format: PLS, XSPF, JSON…), an Xtream Codes account, an uploaded file, or a folder of your own videos on the server.'));
    if (fk) {
      var row = V.$$('[data-id]', body).filter(function (x) { return x.dataset.id === fid; })[0];
      var nf = row && (V.$('[' + fk + ']:not([disabled])', row) || V.$('[data-edit]', row));
      if (nf) nf.focus();
    }
  };
  draw();
  var reload = function () { return V.api('/api/admin').then(function (a) { A = S.admin = a; draw(); }); };
  body.onclick = function (e) {
    if (e.target.closest('[data-add]')) return V.addListDialog().then(function (ok) { if (ok) reload(); });
    var li = e.target.closest('[data-id]');
    if (!li) return;
    var id = li.dataset.id, l = A.lists.filter(function (x) { return x.id === id; })[0];
    var b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-ct')) { V.connTestDialog(l).then(reload); return; }
    if (b.hasAttribute('data-ref')) { b.disabled = true; V.api('/api/admin/lists/' + id + '/refresh', { method: 'POST' }).then(function (r) { var bad = r && !r.running && r.status && r.status.ok === false; // (it used to say "Refreshed" for a refresh that failed)
      V.toast(r && r.running ? 'Still refreshing in the background — this list shows the result when it’s done' : bad ? 'Couldn’t refresh: ' + (r.status.error || 'unknown error') + ' — the saved copy is still used.' : 'Refreshed', { ms: r && r.running ? 6000 : bad ? 9000 : 3000, error: !!bad }); reload(); }).catch(function (x) { V.fail(x); reload(); }); }
    else if (b.hasAttribute('data-del')) V.confirm('Remove “' + l.name + '”? Its channels and videos disappear for everyone.', { ok: 'Remove', danger: true }).then(function (ok) { if (ok) V.del('/api/admin/lists/' + id).then(reload).catch(V.fail); });
    else if (b.hasAttribute('data-edit')) V.editListDialog(l).then(function (ok) { if (ok) reload(); });
    else if (b.hasAttribute('data-up') || b.hasAttribute('data-down')) {
      var ids = A.lists.map(function (x) { return x.id; });
      var i = ids.indexOf(id), j = b.hasAttribute('data-up') ? i - 1 : i + 1;
      ids.splice(j, 0, ids.splice(i, 1)[0]);
      // (Off until the new order is drawn: a second press would send an order worked out from the old one.)
      b.disabled = true;
      V.api('/api/admin/lists-order', { body: { ids: ids } }).then(reload).catch(function (x) { V.fail(x); reload(); });
    }
  };
  // (A failed switch is put back: reload draws what the server has.)
  body.onchange = function (e) { if (e.target.hasAttribute('data-en')) { var id = e.target.closest('[data-id]').dataset.id; V.put('/api/admin/lists/' + id, { enabled: e.target.checked }).then(reload).catch(function (x) { V.fail(x); reload(); }); } };
  var t = setInterval(function () {
    if (!document.documentElement.contains(body)) { clearInterval(t); return; } // (the page is gone)
    if (A.lists.some(function (l) { return l.refreshing || l.testing; }) && !V.$('dialog[open]')) reload().catch(function () {});
  }, 4000);
  V.pageCleanup = function () { clearInterval(t); };
};

var CT_KINDS = [['live', 'Live TV'], ['show', 'TV shows'], ['movie', 'Movies']];
/** How many at once, in words: "3 at once", "6 or more", plus streams that were already playing. */
V.connTestCount = function (r, already) {
  if (!r || !(r.max >= 1)) return '—';
  if (!r.limited) return r.max + ' or more';
  return already ? r.max + ' more (' + (r.max + already) + ' in all)' : String(r.max);
};
/** "Plays at once: Live TV 2 · TV shows 2 · Movies 6 or more" */
V.connTestLine = function (ct) {
  var parts = CT_KINDS.filter(function (k) { return ct[k[0]]; }).map(function (k) { return k[1] + ' <b>' + V.esc(V.connTestCount(ct[k[0]], ct.already)) + '</b>'; });
  return parts.length ? 'Streams at once: ' + parts.join(' · ') : 'Connection test didn’t finish';
};

/** Admin → Lists → (pulse): how many streams of each kind this list plays at once, tested live. */
V.connTestDialog = function (l) {
  var dots = function (n) { var h = ''; for (var i = 1; i <= 6; i++) h += '<span class="ct-dot" data-n="' + i + '"><span class="sr-only">' + i + '</span></span>'; return h; };
  var timer = null, running = false;
  return V.dialog({
    title: 'How many at once? · ' + l.name, wide: true, cls: 'ct-dlg',
    body: '<p class="dim">Opens streams from this list one after another without closing the earlier ones — live TV first, then TV shows, then movies, up to 6 of each — and finds where the provider refuses another or cuts one off. It takes a minute or three and uses about as much internet as 6 streams.</p>' +
      ((l.inUse || []).length ? '<div class="note warn">' + V.icon('info') + ' <span>' + V.esc(l.inUse.map(function (u) { return u.name + ' (' + u.device + ')'; }).join(', ')) + ' ' + (l.inUse.length > 1 ? 'are' : 'is') + ' watching from this list now. The test can interrupt them, and what they’re playing counts toward the limit.</span></div>' : '') +
      '<div class="ct-rows">' + CT_KINDS.map(function (k) { return '<div class="ct-row" data-k="' + k[0] + '"><b>' + k[1] + '</b><span class="ct-dots" aria-hidden="true">' + dots() + '</span><span class="ct-res dim">Not tested</span></div>'; }).join('') + '</div>' +
      '<p class="ct-foot dim small" aria-live="polite"></p>' +
      '<details class="ct-log"><summary>What happened</summary><ol class="small"></ol></details>' +
      '<p class="dim small">The test runs from the server' + (l.proxy !== 'none' && (l.proxy || (S.admin && S.admin.settings.proxy)) ? ', through this list’s proxy' : '') + '. Once it’s done, the result is used to tell people who else is watching when every stream is in use — instead of what the provider says. Some providers also limit how many different places (internet connections) can watch at once; this can’t test that.</p>',
    actions: [{ label: 'Close', value: true }, { label: 'Start test', primary: true, fn: function (d) {
      var btn = V.$('.dlg-f .primary', d);
      if (running) { V.del('/api/admin/lists/' + l.id + '/conntest').then(d._poll).catch(V.fail); return false; }
      btn.disabled = true;
      V.api('/api/admin/lists/' + l.id + '/conntest', { body: {} }).then(function () { d._poll(); }).catch(function (e) { btn.disabled = false; V.fail(e); });
      return false;
    } }],
    onOpen: function (d) {
      var draw = function (r) {
        var job = r.job, saved = r.saved;
        var btn = V.$('.dlg-f .primary', d);
        running = !!(job && job.running);
        if (btn) { btn.disabled = false; btn.textContent = running ? 'Stop' : (job || saved) ? 'Test again' : 'Start test'; btn.classList.toggle('danger', running); btn.classList.toggle('primary', true); }
        var already = job ? job.already : saved ? saved.already : 0;
        CT_KINDS.forEach(function (k) {
          var row = V.$('.ct-row[data-k="' + k[0] + '"]', d);
          var K = job && job.kinds.filter(function (x) { return x.k === k[0]; })[0];
          var res = K ? (K.state === 'done' ? { max: K.max, limited: K.limited, why: K.why } : null) : saved && saved[k[0]];
          var last = {}, top = 0;
          (K ? K.steps : []).forEach(function (x) { last[x.n] = x; });
          for (var i = 1; i <= 6; i++) if (last[i] && last[i].ok) top = i;
          var next = Math.min(6, top + 1);
          V.$$('.ct-dot', row).forEach(function (dot) {
            var n = +dot.dataset.n, st = '';
            if (res) st = n <= res.max ? 'ok' : res.limited && n === res.max + 1 ? 'fail' : '';
            else if (K) st = last[n] && last[n].ok ? 'ok' : last[n] && (K.state === 'error' || K.limited) ? 'fail' : K.state === 'running' && n === next ? 'run' : '';
            dot.className = 'ct-dot' + (st ? ' ' + st : '');
          });
          var txt, cls = 'dim';
          if (K && K.state !== 'done') {
            txt = { waiting: 'Waiting', pausing: 'Letting the provider close the last streams…', finding: 'Finding something to play…', running: 'Stream ' + next + '…', skipped: K.note || 'Nothing to test', error: K.why || 'Couldn’t test', stopped: 'Stopped' }[K.state] || K.state;
            if (K.state === 'error') cls = 'err';
          } else if (res) {
            txt = '<b>' + V.esc(V.connTestCount(res, already)) + '</b> at once' + (res.why ? ' · <span class="dim">' + V.esc(res.why) + '</span>' : res.limited ? '' : ' · <span class="dim">no limit up to 6</span>');
            cls = '';
          } else txt = 'Not tested';
          var el = V.$('.ct-res', row);
          el.className = 'ct-res ' + cls;
          el.innerHTML = K && K.state !== 'done' ? V.esc(txt) : txt;
          row.classList.toggle('busy', !!(K && ['running', 'finding', 'pausing'].indexOf(K.state) >= 0));
        });
        V.$('.ct-foot', d).textContent = running ? 'Testing… you can close this; the test keeps going.' : job && job.endedAt ? 'Finished ' + V.fmtAgo(job.endedAt) + '.' + (job.error ? ' ' + job.error : '') : saved ? 'Last tested ' + V.fmtAgo(saved.at) + '.' : '';
        var log = job ? job.log : [];
        var ol = V.$('.ct-log ol', d);
        if (ol.children.length !== log.length) ol.innerHTML = log.map(function (x) { return '<li><span class="dim">' + V.fmtClock(x.at) + '</span> ' + V.esc(x.text) + '</li>'; }).join('');
        V.$('.ct-log', d).hidden = !log.length;
      };
      var poll = function () {
        if (timer === -1) return;
        clearTimeout(timer);
        return V.api('/api/admin/lists/' + l.id + '/conntest').then(function (r) { if (timer === -1) return; draw(r); if (r.job && r.job.running) timer = setTimeout(poll, 1000); }).catch(function () { if (timer !== -1) timer = setTimeout(poll, 3000); });
      };
      d._poll = poll;
      poll();
    },
    onClose: function () { clearTimeout(timer); timer = -1; },
  });
};

V.langSelect = function (cur) { return '<select class="input" name="lang"><option value="">Detect automatically</option>' + (S.boot.languages || []).map(function (l) { return '<option value="' + l.code + '"' + (l.code === cur ? ' selected' : '') + '>' + V.esc(l.name) + '</option>'; }).join('') + '</select>'; };

/** Admin → TV guides → Add Schedules Direct: sign in, pick one of the account's lineups (lib/schedulesdirect.js). */
V.addSdDialog = function () {
  var lineups = [];
  var cred = function (d) { var f = V.$('form', d); return { username: f.username.value.trim(), password: f.password.value }; };
  return V.dialog({
    title: 'Add Schedules Direct',
    body: '<form class="sd-form"><p class="dim">A paid listings service for the US, Canada and more (schedulesdirect.org). Add the lineup for your area to your account on their site first, then sign in here to pick it.</p>' +
      '<label class="field"><span>User name</span><input class="input" name="username" autocomplete="off" spellcheck="false"></label>' +
      '<label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="new-password"></label>' +
      '<div class="btn-row"><button type="button" class="btn" data-sd-find>Find my lineups</button></div>' +
      '<label class="field" data-sd-pick hidden><span>Lineup</span><select class="input" name="lineup"></select></label>' +
      '<p class="dim small">The password itself isn’t kept: only its hash, which is what the service takes. Listings are fetched when guides refresh, and only what changed since last time. The first fetch of a big lineup can take a few minutes.</p>' +
      '<div class="err" role="alert"></div></form>',
    actions: [{ label: 'Cancel', value: false }, { label: 'Add guide', primary: true, fn: function (d) {
      var f = V.$('form', d), err = V.$('.err', d), c = cred(d);
      if (!lineups.length) { err.textContent = 'Press “Find my lineups” first.'; return false; }
      var l = lineups.filter(function (x) { return x.id === f.lineup.value; })[0];
      if (!l) { err.textContent = 'Choose a lineup.'; return false; }
      err.textContent = 'Fetching the listings… a big lineup can take a few minutes.';
      return V.api('/api/admin/guides', { body: { name: 'Schedules Direct: ' + l.name, sd: { username: c.username, password: c.password, lineup: l.id } } }).then(function (g) {
        V.toast(g.status && g.status.ok ? 'Guide added · ' + (g.status.channels || 0) + ' stations' : 'Guide added, but: ' + ((g.status && g.status.error) || 'it didn’t load'), { error: !(g.status && g.status.ok), ms: 8000 });
        return true;
      }, function (e) { err.textContent = e.message; return false; });
    } }],
    onOpen: function (d) {
      V.$('form', d).onsubmit = function (e) { e.preventDefault(); };
      V.$('[data-sd-find]', d).onclick = function () {
        var b = this, err = V.$('.err', d), c = cred(d);
        if (!c.username || !c.password) { err.textContent = 'Enter the user name and password.'; return; }
        b.disabled = true; err.textContent = 'Signing in…';
        V.api('/api/admin/schedulesdirect/lineups', { body: c }).then(function (r) {
          lineups = r.lineups || [];
          err.textContent = lineups.length ? '' : 'The account has no lineups yet. Add one at schedulesdirect.org (your account → Lineups), then try again.';
          var sel = V.$('select[name=lineup]', d);
          sel.innerHTML = lineups.map(function (l) { return '<option value="' + V.esc(l.id) + '">' + V.esc(l.name + (l.location ? ' · ' + l.location : '') + (l.transport ? ' (' + l.transport + ')' : '')) + '</option>'; }).join('');
          V.$('[data-sd-pick]', d).hidden = !lineups.length;
          if (lineups.length) sel.focus();
        }).catch(function (e) { err.textContent = e.message; }).then(function () { b.disabled = false; });
      };
    },
  });
};

V.addListDialog = function () {
  return V.dialog({
    title: 'Add a list', wide: true,
    body: '<div class="tabs" role="tablist">' + [['url', 'Web address'], ['xtream', 'Xtream Codes'], ['stalker', 'MAC portal'], ['mediaserver', 'Media server'], ['file', 'Upload a file'], ['folder', 'Folder on the server']].map(function (t, i) { return '<button class="tab' + (i ? '' : ' on') + '" data-m="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>' +
      '<form class="list-form">' +
      '<div data-pane="url"><label class="field"><span>Playlist address</span><input class="input" name="url" placeholder="https://provider.example/playlist.m3u" autocomplete="off"></label><p class="dim small">M3U/M3U8 (extended or plain), PLS, XSPF, ASX, JSON or a plain list of addresses — the format is detected automatically. Guides named in the playlist (url-tvg) are added too.</p></div>' +
      '<div data-pane="xtream" hidden><label class="field"><span>Server</span><input class="input" name="server" placeholder="http://provider.example:8080" autocomplete="off"><small class="dim">You can paste a full get.php or player_api.php link; the username and password are read from it.</small></label><div class="grid2"><label class="field"><span>Username</span><input class="input" name="username" autocomplete="off"></label><label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="off"></label></div></div>' +
      '<div data-pane="file" hidden><label class="field"><span>Playlist file</span><input class="input" type="file" name="file" accept=".m3u,.m3u8,.txt,.pls,.xspf,.asx,.wpl,.json,.gz"></label></div>' +
      '<div data-pane="folder" hidden><label class="field"><span>Folder (on the server)</span><div class="inline"><input class="input" name="folder" placeholder="/media/movies"><button type="button" class="btn" data-browse>Browse…</button></div><small class="dim">Movies, shows (Show/Season 1/Show S01E02.mkv) and music. Files are played in place; anything a browser can’t play is converted. In Docker, mount the folder into the container first.</small></label></div>' +
      (V.addListPanes ? V.addListPanes() : '') +
      '<div class="grid2"><label class="field"><span>Name (optional)</span><input class="input" name="name" maxlength="60"></label><label class="field"><span>Language of everything in it</span>' + V.langSelect('') + '</label></div>' +
      '<details><summary>More</summary><div class="grid2"><label class="field"><span>Refresh every (hours, 0 = never)</span><input class="input" name="refreshHours" type="number" min="0" max="168" value="12"></label><label class="field"><span>User-Agent to send (optional)</span><input class="input" name="ua" placeholder="Default"></label></div><label class="check"><input type="checkbox" name="useGuide" checked><span>Use the TV guide this list points to</span></label></details>' +
      '<div class="err" role="alert"></div></form>',
    actions: [{ label: 'Cancel', value: false }, { label: 'Add list', primary: true, fn: function (d) {
      var mode = V.$('.tab.on', d).dataset.m;
      var f = V.$('form', d);
      var fd = new FormData(f);
      var common = { name: fd.get('name'), lang: fd.get('lang'), refreshHours: +fd.get('refreshHours'), ua: fd.get('ua'), useGuide: !!fd.get('useGuide') };
      V.$('.err', d).textContent = 'Loading the list… big lists can take a minute.';
      var p;
      if (mode === 'file') {
        var file = fd.get('file');
        if (!file || !file.size) { V.$('.err', d).textContent = 'Choose a file.'; return false; }
        p = fetch('/api/admin/lists/upload?' + new URLSearchParams({ name: common.name || '', fileName: file.name, lang: common.lang || '' }), { method: 'POST', headers: { 'X-App': '1' }, body: file, credentials: 'same-origin' }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); return j; }); });
      } else {
        var b = Object.assign({ type: mode }, common);
        if (mode === 'url') b.url = fd.get('url');
        if (mode === 'xtream') { b.server = fd.get('server'); b.username = fd.get('username'); b.password = fd.get('password'); }
        if (mode === 'folder') b.folders = [fd.get('folder')];
        if (V.addListBody) V.addListBody(mode, fd, b, d);
        p = V.api('/api/admin/lists', { body: b });
      }
      return p.then(function (l) { V.toast('Added “' + l.name + '” · ' + V.plural((l.status && l.status.count) || 0, 'item')); return true; }, function (e) { V.$('.err', d).textContent = e.message; return false; });
    } }],
    onOpen: function (d) {
      d.addEventListener('click', function (e) {
        var t = e.target.closest('[data-m]');
        if (t) { V.$$('[data-m]', d).forEach(function (x) { x.classList.toggle('on', x === t); }); V.$$('[data-pane]', d).forEach(function (p) { p.hidden = p.dataset.pane !== t.dataset.m; }); }
        if (e.target.closest('[data-browse]')) V.folderPicker().then(function (p) { if (p) V.$('[name=folder]', d).value = p; });
      });
      var srv = V.$('[name=server]', d);
      srv.addEventListener('change', function () { try { var u = new URL(/^https?:/.test(srv.value) ? srv.value : 'http://' + srv.value); var us = u.searchParams.get('username'), pw = u.searchParams.get('password'); if (us) V.$('[name=username]', d).value = us; if (pw) V.$('[name=password]', d).value = pw; } catch (e) {} });
    },
  });
};

V.editListDialog = function (l) {
  return V.dialog({
    title: 'Edit “' + l.name + '”', wide: true,
    body: '<form class="list-form"><label class="field"><span>Name</span><input class="input" name="name" value="' + V.esc(l.name) + '"></label>' +
      (l.type === 'url' ? '<label class="field"><span>Address</span><input class="input" name="url" value="' + V.esc(l.url) + '"></label>' : '') +
      (l.type === 'xtream' ? '<label class="field"><span>Server</span><input class="input" name="server" value="' + V.esc(l.server) + '"></label><div class="grid2"><label class="field"><span>Username</span><input class="input" name="username" value="' + V.esc(l.username) + '"></label><label class="field"><span>Password</span><input class="input" type="password" name="password" value="' + V.esc(l.password) + '"></label></div>' : '') +
      (l.type === 'file' ? '<label class="field"><span>Replace the file</span><input class="input" type="file" name="file"></label>' : '') +
      (V.editListFields ? V.editListFields(l) : '') +
      '<div class="grid2"><label class="field"><span>Language of everything in it</span>' + V.langSelect(l.lang) + '</label><label class="field"><span>Refresh every (hours, 0 = never)</span><input class="input" name="refreshHours" type="number" min="0" max="168" value="' + l.refreshHours + '"></label></div>' +
      (l.type !== 'folder' ? '<label class="field"><span>User-Agent (optional)</span><input class="input" name="ua" value="' + V.esc(l.ua || '') + '"></label><label class="check"><input type="checkbox" name="useGuide"' + (l.useGuide !== false ? ' checked' : '') + '><span>Use the TV guide this list points to</span></label>' + (V.evTzField ? V.evTzField(l) : '') +
        '<label class="field"><span>Proxy for this list</span><select class="input" name="proxy"><option value="">The default (' + V.esc(((S.admin.settings.proxies || []).filter(function (x) { return x.id === S.admin.settings.proxy; })[0] || { name: 'none' }).name) + ')</option><option value="none"' + (l.proxy === 'none' ? ' selected' : '') + '>No proxy</option>' + (S.admin.settings.proxies || []).map(function (x) { return '<option value="' + x.id + '"' + (l.proxy === x.id ? ' selected' : '') + '>' + V.esc(x.name) + '</option>'; }).join('') + '</select><small class="dim">Set up proxies in Admin → Network & proxies.</small></label>' : '') +
        (S.admin.settings.relay && S.admin.settings.relay.url ? '<label class="field"><span>Viewers’ direct streams</span><select class="input" name="relay"><option value="">The default (' + (S.admin.settings.relay.all ? 'through the stream relay' : 'straight from the provider') + ')</option><option value="on"' + (l.relay === 'on' ? ' selected' : '') + '>Through the stream relay</option><option value="off"' + (l.relay === 'off' ? ' selected' : '') + '>Straight from the provider</option></select><small class="dim">The stream relay is set up in Admin → Network &amp; proxies.</small></label>' : '') + '</form>',
    actions: [{ label: 'Cancel', value: false }, { label: 'Save', primary: true, fn: function (d) {
      var fd = new FormData(V.$('form', d));
      var patch = {};
      ['name', 'url', 'server', 'username', 'password', 'ua', 'lang', 'refreshHours', 'proxy', 'portal', 'mac', 'serial', 'deviceId', 'deviceId2', 'signature', 'token', 'kind', 'evTz', 'relay'].forEach(function (k) { if (fd.has(k)) patch[k] = fd.get(k); });
      V.$$('[data-bool]', d).forEach(function (x) { patch[x.name] = x.checked; });
      // An emptied name or refresh field keeps what was saved (the server would store a blank name, or 0 = never refresh).
      if (patch.name !== undefined && !String(patch.name).trim()) delete patch.name;
      if (patch.refreshHours !== undefined) { if (String(patch.refreshHours).trim() === '' || isNaN(+patch.refreshHours)) delete patch.refreshHours; else patch.refreshHours = +patch.refreshHours; }
      if (patch.proxy === (l.proxy || '')) delete patch.proxy;
      if (patch.relay === (l.relay || '')) delete patch.relay;
      if (V.$('[name=useGuide]', d)) patch.useGuide = !!fd.get('useGuide');
      var file = fd.get('file');
      return V.put('/api/admin/lists/' + l.id, patch).then(function () {
        if (file && file.size) return fetch('/api/admin/lists/' + l.id + '/file', { method: 'PUT', headers: { 'X-App': '1' }, body: file, credentials: 'same-origin' }).then(function (r) { if (!r.ok) return r.json().then(function (j) { throw new Error(j.error); }); });
      }).then(function () { V.toast('Saved'); return true; });
    } }],
  });
};

V.folderPicker = function () {
  return V.dialog({
    title: 'Choose a folder on the server', wide: true,
    body: '<div class="fp-path dim"></div><ul class="fp-list"></ul>',
    actions: [{ label: 'Cancel', value: null }, { label: 'Use this folder', primary: true, fn: function (d) { return d._path || null; } }],
    onOpen: function (d) {
      var open = function (p) {
        V.api('/api/admin/fs' + (p ? '?path=' + encodeURIComponent(p) : '')).then(function (r) {
          d._path = r.path;
          V.$('.fp-path', d).textContent = r.path ? r.path + (r.files ? ' · ' + r.files + ' files' : '') : 'Choose a starting place';
          V.$('.fp-list', d).innerHTML = (r.parent !== null && r.path ? '<li><button class="btn ghost block" data-p="' + V.esc(r.parent) + '">' + V.icon('up') + ' Up</button></li>' : '') + r.dirs.map(function (x) { return '<li><button class="btn ghost block" data-p="' + V.esc(x.path) + '">' + V.icon('folder') + ' ' + V.esc(x.name) + '</button></li>'; }).join('');
        }).catch(V.fail);
      };
      d.addEventListener('click', function (e) { var b = e.target.closest('[data-p]'); if (b) open(b.dataset.p); });
      open('');
    },
  });
};

V.adminTabs.guides = function (body, A) {
  body.innerHTML = '<div class="page-tools"><button class="btn primary" data-add>' + V.icon('plus') + ' Add a guide (XMLTV)</button><button class="btn" data-add-sd>' + V.icon('plus') + ' Add Schedules Direct…</button><span class="dim">Guides named by your lists are added automatically. Channels are matched by tvg-id, then by name.</span></div>' +
    '<div class="grid2 small-grid"><label class="field"><span>Days of listings to keep ahead</span><input class="input" type="number" min="1" max="21" data-s="epgDays" value="' + A.settings.epgDays + '"></label><label class="field"><span>Days to keep in the past (for catch-up)</span><input class="input" type="number" min="0" max="14" data-s="epgPastDays" value="' + A.settings.epgPastDays + '"></label><label class="field"><span>Refresh every (hours)</span><input class="input" type="number" min="1" max="168" data-s="epgRefreshHours" value="' + A.settings.epgRefreshHours + '"></label></div>' +
    (A.guides.length ? '<ul class="adm-list">' + A.guides.map(function (g) { var s = g.status || {}; return '<li class="' + (g.enabled ? '' : 'off') + '" data-id="' + g.id + '"><div class="al-h"><b>' + V.esc(g.name) + '</b>' + (g.auto ? '<span class="chip sm">from a list</span>' : '') + '<span class="sp"></span><label class="switch sm"><input type="checkbox" data-en aria-label="Use ' + V.esc(g.name) + '"' + (g.enabled ? ' checked' : '') + '><span class="sw"></span></label><button class="icon-btn" data-ref aria-label="Refresh">' + V.icon('refresh') + '</button>' + (g.auto ? '' : '<button class="icon-btn" data-del aria-label="Delete">' + V.icon('trash') + '</button>') + '</div><div class="al-b dim small">' + V.esc(g.sd ? 'Schedules Direct · lineup ' + g.url.slice(3) + ' · account ' + g.sd.user : g.url.replace(/(password=)[^&]+/, '$1•••')) + '</div><div class="al-s small">' + (s.ok ? V.icon('check', 'tiny ok') + ' ' + (s.channels || 0) + ' channels · ' + (s.programmes || 0).toLocaleString() + ' programmes · ' + V.fmtAgo(s.at) : s.error ? '<span class="err">' + V.esc(s.error) + '</span>' : 'Not loaded yet') + '</div></li>'; }).join('') + '</ul>' : V.empty('No guides', 'Add an XMLTV address (.xml or .xml.gz).'));
  body.onchange = function (e) {
    if (e.target.dataset.s) { var k = e.target.dataset.s, n = V.adminNum(e.target, S.admin.settings[k]); if (n === null) return; var p = {}; p[k] = n; V.adminSave(p).catch(function () {}); }
    if (e.target.hasAttribute('data-en')) V.put('/api/admin/guides/' + e.target.closest('[data-id]').dataset.id, { enabled: e.target.checked }).then(function () { V.router.refresh(); }).catch(function (x) { V.fail(x); V.router.refresh(); });
  };
  body.onclick = function (e) {
    if (e.target.closest('[data-add-sd]')) return V.addSdDialog().then(function (ok) { if (ok) V.router.refresh(); });
    if (e.target.closest('[data-add]')) return V.prompt('Guide address (XMLTV)', { placeholder: 'https://…/guide.xml.gz' }).then(function (u) { if (u) { V.toast('Loading the guide…'); V.api('/api/admin/guides', { body: { url: u } }).then(function (g) { V.toast(g.status && g.status.ok ? 'Guide loaded' : 'Guide added, but: ' + ((g.status && g.status.error) || 'not loaded')); V.router.refresh(); }).catch(V.fail); } });
    var li = e.target.closest('[data-id]');
    if (!li) return;
    var rb = e.target.closest('[data-ref]');
    if (rb) { rb.disabled = true; V.toast('Refreshing…'); V.api('/api/admin/guides/' + li.dataset.id + '/refresh', { method: 'POST' }).then(function () { V.router.refresh(); }).catch(function (x) { rb.disabled = false; V.fail(x); }); }
    if (e.target.closest('[data-del]')) V.confirm('Remove this TV guide? Channels that get their listings from it will show none until another guide covers them.', { ok: 'Remove', danger: true }).then(function (yes) { if (yes) V.del('/api/admin/guides/' + li.dataset.id).then(function () { V.router.refresh(); }).catch(V.fail); });
  };
};

// Admin → Profiles. Everyone on one screen as a short row (who they are, what they're limited to); a row opens
// to that profile's settings, in sections: what they can watch, screen time (web/js/screentime.js puts it in
// its slot), connections, then the PIN and the account. What goes for the whole household is below the list.
var PROF_CERTS = [['', 'No limit'], ['0', 'Little kids (G, TV-Y)'], ['1', 'Kids (PG, TV-PG)'], ['2', 'Teens (PG-13, TV-14)'], ['3', 'Mature (R, TV-MA)']];
var PROF_TYPES = [['live', 'Live TV'], ['movie', 'Movies'], ['show', 'Series'], ['radio', 'Radio']];
var profOpen = {}; // (the rows that are open: kept while the page is drawn again)
/** A profile's limits in a line, for its row. */
function profLimits(p, A) {
  if (p.admin) return 'No limits (the admin sees everything)';
  var r = p.restrictions || {}, bits = [];
  if (p.kids) bits.push('Kids’ titles and channels only');
  var c = PROF_CERTS.filter(function (x) { return x[0] !== '' && x[0] === String(r.maxCert); })[0];
  if (c) bits.push('Age limit: ' + c[1].replace(/\s*\(.*$/, ''));
  if (r.types && r.types.length && r.types.length < PROF_TYPES.length) bits.push('Only ' + PROF_TYPES.filter(function (t) { return r.types.indexOf(t[0]) >= 0; }).map(function (t) { return t[1]; }).join(', '));
  if (r.adult && !p.kids && !A.settings.noAdult) bits.push('Adult (18+) allowed');
  var nb = (r.blockedGroups || []).length;
  if (nb) bits.push(nb + (nb === 1 ? ' blocked category' : ' blocked categories'));
  return bits.join(' · ') || 'No limits';
}
function profChips(p) {
  return (p.admin ? ' <span class="chip sm">Admin</span>' : '') + (p.kids ? ' <span class="chip sm">Kids</span>' : '') + (p.manager && !p.kids && !p.admin ? ' <span class="chip sm">Manager</span>' : '') + (p.priority ? ' <span class="chip sm pri">Priority</span>' : '') + (p.online ? ' <span class="chip sm ok">online</span>' : '');
}
V.adminTabs.profiles = function (body, A) {
  var s = A.settings;
  var hasKids = A.profiles.some(function (p) { return p.kids; });
  var opts = function (list, cur) { return list.map(function (c) { return '<option value="' + c[0] + '"' + (String(cur === undefined || cur === null ? '' : cur) === c[0] ? ' selected' : '') + '>' + c[1] + '</option>'; }).join(''); };
  var card = function (p) {
    var r = p.restrictions || {};
    return '<li data-id="' + p.id + '"><details class="ap"' + (profOpen[p.id] ? ' open' : '') + '>' +
      '<summary class="ap-h">' + V.avatar(p.avatar, 'lg') + '<div class="ap-who"><div class="ap-n"><b>' + V.esc(p.name) + '</b><span data-chips>' + profChips(p) + '</span><span class="chip sm warn" data-dirty hidden>Not saved</span></div>' +
        '<div class="ap-lim small"><span data-lim>' + V.esc(profLimits(p, A)) + '</span><span data-st-sum></span></div>' +
        '<div class="dim small">' + (p.hasPin ? 'PIN set' : 'No PIN') + ' · languages: ' + (p.langs ? V.esc(p.langs.map(function (c) { return V.langName(c); }).join(', ')) || 'none' : 'default') + ' · last used ' + V.fmtAgo(p.lastUsedAt) + '</div></div>' +
        '<span class="ap-x" aria-hidden="true"></span></summary>' +
      '<div class="ap-body">' +
        (p.admin ? '' : '<section class="ap-sec ap-limits"><h4>What they can watch</h4>' +
          '<label class="check"><input type="checkbox" data-r="kids"' + (p.kids ? ' checked' : '') + '><span>Kids profile <small class="dim">— only kids’ titles and channels</small></span></label>' +
          '<div class="grid2"><label class="field"><span>Age limit</span><select class="input" data-r="maxCert">' + opts(PROF_CERTS, r.maxCert) + '</select></label>' +
          '<div class="field"><span>Can watch</span><div class="chips">' + PROF_TYPES.map(function (t) { var on = !r.types || !r.types.length || r.types.indexOf(t[0]) >= 0; return '<label class="chip-check"><input type="checkbox" data-type="' + t[0] + '"' + (on ? ' checked' : '') + '><span>' + t[1] + '</span></label>'; }).join('') + '</div></div></div>' +
          '<label class="check"><input type="checkbox" data-r="adult"' + (r.adult && !p.kids ? ' checked' : '') + (p.kids ? ' disabled' : '') + '><span>Allow adult (18+) groups' + (s.noAdult ? ' <small class="dim">— off for everyone (Languages & content → Adult content)</small>' : ' <small class="dim">— not for a kids profile</small>') + '</span></label>' +
          '<label class="field"><span>Blocked categories (one per line)</span><textarea class="input" rows="2" data-r="blockedGroups">' + V.esc((r.blockedGroups || []).join('\n')) + '</textarea></label></section>') +
        '<div data-st-slot></div>' +
        '<section class="ap-sec"><h4>When every connection is in use</h4><label class="check ap-pri"><input type="checkbox" data-pri' + (p.priority ? ' checked' : '') + '><span>Priority viewer <small class="dim">— takes a connection from someone on a standard profile; standard viewers can’t take one from them. Saved straight away.</small></span></label></section>' +
        (p.admin ? '' : '<section class="ap-sec"><h4>Helping run things</h4><label class="check ap-mgr"><input type="checkbox" data-mgr' + (p.manager && !p.kids ? ' checked' : '') + (p.kids ? ' disabled' : '') + '><span>Manager <small class="dim">— can fix channels, fetch lists and guides again, deal with error reports and answer requests for more screen time. Can’t see or change settings, lists’ sign-in details, profiles, PINs and locks, backups or updates. ' + (p.kids ? 'Not for a kids profile.' : p.hasPin ? 'Saved straight away.' : 'Needs a PIN on this profile first.') + '</small></span></label></section>') +
        '<div class="ap-foot">' + (p.admin ? '<span></span>' : '<div class="btn-row"><button class="btn sm primary" data-save>Save changes</button></div>') +
          '<div class="btn-row ap-acct"><button class="btn sm" data-pin>' + (p.hasPin ? 'Change PIN' : 'Set a PIN') + '</button>' + (p.admin ? '' : '<button class="btn sm" data-make>Make admin</button><button class="btn sm danger" data-del>Delete profile</button>') + '</div></div>' +
      '</div></details></li>';
  };
  body.innerHTML = '<div class="page-tools ap-tools"><button class="btn primary" data-add>' + V.icon('plus') + ' Add a profile</button><span class="dim small">' + A.profiles.length + (A.profiles.length === 1 ? ' profile' : ' profiles') + '. Open one to change what it can watch, its screen time or its PIN.</span></div>' +
    '<ul class="adm-profiles">' + A.profiles.map(card).join('') + '</ul>' +
    '<section class="card-sec adm-house"><h2>For the whole household</h2>' +
    '<label class="check"><input type="checkbox" data-aop' + (s.adminOnlyProfiles ? ' checked' : '') + '><span>Only the admin can add profiles <small class="dim" data-aopnote' + (hasKids && !s.adminOnlyProfiles ? '' : ' hidden') + '>— off now: anyone here, a child on a kids profile too, can add a profile without limits</small></span></label>' +
    // A Guest on "Who's watching?" (web/js/guest.js): nothing it watches is kept or shown to anyone else.
    '<h3>Guest</h3><label class="check"><input type="checkbox" data-guest="guestProfile"' + (s.guestProfile ? ' checked' : '') + '><span>Offer a Guest on “Who’s watching?” <small class="dim">— for visitors: no PIN, nothing they watch, like or add to My List is saved (it’s forgotten when they leave), and none of it goes into anyone’s recommendations or “also watched”. Guests can’t record, message, start watch parties or change anything here.</small></span></label>' +
    '<div class="adm-guest"' + (s.guestProfile ? '' : ' hidden') + '><div class="grid2"><div><label class="check"><input type="checkbox" data-guest="guestKids"' + (s.guestKids ? ' checked' : '') + '><span>Kids’ titles and channels only</span></label>' +
    '<label class="check"><input type="checkbox" data-guest="guestAdult"' + (s.guestAdult ? ' checked' : '') + '><span>Allow adult (18+) groups <small class="dim">— not with kids’ titles only' + (s.noAdult ? '; off for everyone now (Languages & content → Adult content)' : '') + '</small></span></label></div>' +
    '<label class="field"><span>Age limit for guests</span><select class="input" data-guest="guestMaxCert">' + opts(PROF_CERTS, s.guestMaxCert || '') + '</select></label></div></div></section>';
  var byId = function (id) { return A.profiles.filter(function (x) { return x.id === id; })[0]; };
  // (With a kids profile in the house, the page says what leaving "Only the admin can add profiles" off means.)
  var aopNote = function () { V.$('[data-aopnote]', body).hidden = V.$('[data-aop]', body).checked || !A.profiles.some(function (x) { return x.kids; }); };
  var dirty = function (li, on) { var d = V.$('[data-dirty]', li); if (d) d.hidden = !on; li.classList.toggle('dirty', !!on); };
  // (Which rows are open, for when the page is drawn again after a PIN or a deletion.)
  body.addEventListener('toggle', function (e) { var li = e.target.classList && e.target.classList.contains('ap') && e.target.closest('[data-id]'); if (li) profOpen[li.dataset.id] = e.target.open; }, true);
  body.addEventListener('input', function (e) { var li = e.target.closest('.ap-limits, .st-box') && e.target.closest('[data-id]'); if (li) dirty(li, true); });
  body.onchange = function (e) {
    var t = e.target, li = t.closest('[data-id]');
    if (t.hasAttribute('data-aop')) V.adminSave({ adminOnlyProfiles: t.checked }).then(aopNote).catch(function () { t.checked = !t.checked; aopNote(); });
    else if (t.hasAttribute('data-guest')) {
      var gp = {};
      gp[t.dataset.guest] = t.type === 'checkbox' ? t.checked : t.value;
      if (t.dataset.guest === 'guestProfile') V.$('.adm-guest', body).hidden = !t.checked;
      V.adminSave(gp).then(function (ns) { if (ns) Object.assign(A.settings, gp); }).catch(function () {});
    } else if (t.hasAttribute('data-mgr')) {
      var mOn = t.checked, mp = byId(li.dataset.id);
      V.put('/api/admin/profiles/' + li.dataset.id, { manager: mOn }).then(function () {
        if (mp) { mp.manager = mOn; V.$('[data-chips]', li).innerHTML = profChips(mp); }
        V.toast(mOn ? (mp ? mp.name : 'They') + ' is now a manager' : (mp ? mp.name : 'They') + ' is no longer a manager');
      }).catch(function (err) { t.checked = !mOn; V.fail(err); });
    } else if (t.hasAttribute('data-pri')) {
      // Saved straight away (it isn't one of the limits).
      var on = t.checked, p = byId(li.dataset.id);
      V.put('/api/admin/profiles/' + li.dataset.id, { priority: on }).then(function () {
        if (p) { p.priority = on; V.$('[data-chips]', li).innerHTML = profChips(p); }
        V.toast(on ? (p ? p.name : 'They') + ' now has priority' : (p ? p.name : 'They') + ' is a standard viewer again');
      }).catch(function (err) { t.checked = !on; V.fail(err); });
    } else if (li && t.closest('.ap-limits, .st-box')) {
      // (A kids profile never gets the adult groups.)
      if (t.getAttribute('data-r') === 'kids') { var ad = V.$('[data-r=adult]', li); ad.disabled = t.checked; if (t.checked) ad.checked = false; }
      dirty(li, true);
    }
  };
  body.onclick = function (e) {
    if (e.target.closest('[data-add]')) { S.boot.firstRun = false; return V.addProfileDialog(); }
    var li = e.target.closest('[data-id]');
    if (!li) return;
    var id = li.dataset.id, p = byId(id);
    if (e.target.closest('[data-save]')) {
      var types = V.$$('[data-type]', li).filter(function (x) { return x.checked; }).map(function (x) { return x.dataset.type; });
      var kids = V.$('[data-r=kids]', li).checked;
      var rs = { maxCert: V.$('[data-r=maxCert]', li).value, types: types.length === 4 ? [] : types, adult: V.$('[data-r=adult]', li).checked, blockedGroups: V.$('[data-r=blockedGroups]', li).value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean) };
      V.put('/api/admin/profiles/' + id, { kids: kids, restrictions: rs }).then(function () {
        // (The row says what was saved.)
        p.kids = kids; p.restrictions = rs;
        aopNote();
        V.$('[data-chips]', li).innerHTML = profChips(p);
        V.$('[data-lim]', li).textContent = profLimits(p, A);
        dirty(li, false);
        V.toast('Saved');
      }).catch(V.fail);
    } else if (e.target.closest('[data-pin]')) V.prompt('New PIN for ' + p.name + ' (4–8 digits' + (p.admin ? '' : ', empty to remove') + ')', { type: 'password' }).then(function (pin) { if (pin === null) return; V.put('/api/admin/profiles/' + id, { pin: pin }).then(function () { V.toast('Saved'); V.router.refresh(); }).catch(V.fail); });
    else if (e.target.closest('[data-make]')) V.confirm('Make ' + p.name + ' the admin? You’ll stop being the admin. (There’s only ever one.)', { ok: 'Make admin', danger: true }).then(function (ok) { if (ok) V.api('/api/admin/profiles/' + id + '/make-admin', { method: 'POST' }).then(function () { location.reload(); }).catch(V.fail); });
    else if (e.target.closest('[data-del]')) V.confirm('Delete ' + p.name + '? Their history, lists and messages are removed.', { ok: 'Delete', danger: true }).then(function (ok) { if (ok) V.del('/api/admin/profiles/' + id).then(function () { delete profOpen[id]; V.router.refresh(); }).catch(V.fail); });
  };
};


V.adminTabs.content = function (body, A) {
  var s = A.settings;
  body.innerHTML = '<section class="card-sec"><h2>Default languages</h2><p class="dim">Profiles see only these languages unless they choose their own. Leave all unticked to show everything.</p><div class="lang-pick">' + V.langChecks(s.defaultLangs) + '</div>' +
    '<label class="check"><input type="checkbox" data-unknown' + (s.showUnknownLang ? ' checked' : '') + '><span>Show things whose language can’t be worked out</span></label>' +
    '<label class="check"><input type="checkbox" data-tmdblang' + (s.tmdbLangs !== false ? ' checked' : '') + '><span>Use TMDB’s original language when a film’s or series’ language is only guessed</span></label>' +
    '<p class="dim small">When a provider only says “EN” for a whole category, or nothing at all, a Korean film in it counts as Korean, so profiles see the languages they chose. Not for cartoons and children’s titles (usually dubbed), multi-language copies, or a copy whose name says its language. Needs a TMDB key.</p>' +
    '<button class="btn primary" data-save-l>Save languages</button><div class="lang-stats dim small"></div></section>' +
    // Adult (18+) content left out for everyone (lib/catalog.js isAdult; the counts come with /api/admin/groups).
    '<section class="card-sec adm-adult"><h2>Adult content</h2><label class="check"><input type="checkbox" data-noadult' + (s.noAdult ? ' checked' : '') + '><span>Leave out adult (18+) content for everyone <small class="dim">— porn channels and films are taken out of the catalogue altogether: no profile sees them (the admin neither), they can’t be searched for or played, and “Allow adult (18+) groups” on a profile no longer does anything.</small></span></label><p class="dim small adult-stats"></p></section>' +
    '<section class="card-sec"><h2>Hidden categories</h2><p class="dim">Hidden for everyone (the admin too). Tick to hide.</p><input class="input" type="search" data-gf placeholder="Filter categories"><div class="groups-adm"><div class="spinner"></div></div><button class="btn primary" data-save-g>Save hidden categories</button></section>';
  // What the lists hold that counts as adult, by the providers' own categories (so a missed one can be spotted).
  var adultEl = V.$('.adult-stats', body), adultTries = 0;
  var adultNote = function (a) {
    if (!a) return;
    var on = !!S.admin.settings.noAdult;
    var gs = a.groups || [];
    var names = gs.slice(0, 8).map(function (x) { return V.esc(x[0]) + ' (' + Number(x[1]).toLocaleString() + ')'; }).join(', ') + (gs.length > 8 ? ' and ' + (gs.length - 8) + ' more' : '');
    var miss = ' Something adult still showing? Tick its category under Hidden categories below.';
    if (!!a.off !== on) adultEl.innerHTML = 'The catalogue is being rebuilt — with big lists that takes a minute or two.';
    else if (!a.n) adultEl.innerHTML = 'Nothing in your lists counts as adult content right now.' + (on ? miss : '');
    else adultEl.innerHTML = (on ? 'Left out: ' : 'In your lists: ') + Number(a.n).toLocaleString() + (a.n === 1 ? ' adult entry' : ' adult entries') + (names ? ' — ' + names : '') + '.' + (on ? miss : ' Only profiles allowed adult groups see them now.');
  };
  // (After a change: look again until the rebuilt catalogue is the one in use, while this page is still open.)
  var adultWait = function () {
    if (!document.body.contains(adultEl) || ++adultTries > 120) return;
    V.api('/api/admin/groups').then(function (g) {
      if (!document.body.contains(adultEl)) return;
      adultNote(g.adult);
      if (g.adult && !!g.adult.off !== !!S.admin.settings.noAdult) setTimeout(adultWait, 5000);
    }).catch(function () { setTimeout(adultWait, 5000); });
  };
  V.$('[data-noadult]', body).onchange = function (e) {
    var box = e.target, on = box.checked;
    V.adminSave({ noAdult: on }, on ? 'Saved — adult content is being taken out' : 'Saved — the catalogue is being rebuilt').then(function () { adultTries = 0; adultNote({ off: !on }); setTimeout(adultWait, 3000); }).catch(function () { box.checked = !on; });
  };
  V.api('/api/admin/groups').then(function (g) {
    adultNote(g.adult);
    var hidden = new Set(s.hiddenGroups || []);
    var langs = Object.keys(g.langs).sort(function (a, b) { return g.langs[b] - g.langs[a]; });
    V.$('.lang-stats', body).innerHTML = 'In your lists: ' + langs.slice(0, 20).map(function (l) { return (l === '?' ? 'unknown' : V.esc(V.langName(l))) + ' ' + g.langs[l].toLocaleString(); }).join(' · ');
    var draw = function (q) {
      var nq = V.norm(q);
      V.$('.groups-adm', body).innerHTML = g.groups.filter(function (x) { return !nq || V.norm(x.name).indexOf(nq) >= 0; }).slice(0, 800).map(function (x) {
        var t = Object.keys(x.types).map(function (k) { return x.types[k] + ' ' + (V.TYPE_NAMES[k] || k).toLowerCase(); }).join(', ');
        var l = Object.keys(x.langs).sort(function (a, b) { return x.langs[b] - x.langs[a]; }).slice(0, 2).map(function (c) { return c === '?' ? '?' : c.toUpperCase(); }).join('/');
        return '<label class="check"><input type="checkbox" value="' + V.esc(x.name) + '"' + (hidden.has(x.name) ? ' checked' : '') + '><span>' + V.esc(x.name) + ' <small class="dim">' + V.esc(t || 'hidden') + (l ? ' · ' + l : '') + '</small></span></label>';
      }).join('');
    };
    draw('');
    V.$('[data-gf]', body).addEventListener('input', V.debounce(function (e) { draw(e.target.value); }, 150));
    body.addEventListener('change', function (e) { if (e.target.closest('.groups-adm')) { if (e.target.checked) hidden.add(e.target.value); else hidden.delete(e.target.value); } });
    V.$('[data-save-g]', body).onclick = function () { V.adminSave({ hiddenGroups: Array.from(hidden) }, 'Saved — the catalogue is being rebuilt'); };
  }).catch(function (e) { var gb = V.$('.groups-adm', body); if (gb) gb.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; V.$('[data-save-g]', body).disabled = true; }); // (not a spinner forever, nor a Save that does nothing)
  V.$('[data-save-l]', body).onclick = function () { V.adminSave({ defaultLangs: V.$$('.lang-pick input:checked', body).map(function (x) { return x.value; }), showUnknownLang: V.$('[data-unknown]', body).checked, tmdbLangs: V.$('[data-tmdblang]', body).checked }, 'Saved — everyone using the default sees the change (a language nobody had before takes a few minutes to appear)'); };
};

/**
 * The admin's PIN again, asked before what replaces the server's code or all its data (server.js requireAdminPin):
 * resolves with the PIN typed, or null when the box was closed.
 */
function adminPin(what) {
  return V.prompt('Enter the admin PIN to ' + what, { type: 'password' }).then(function (pin) { return pin ? String(pin).trim() : null; });
}

/** Whether the chosen hardware encoder works (the server tries it when it starts and when the choice changes). */
function hwNote(s, st) {
  var c = st && st.hwCheck;
  if (!s.hwaccel) return '<p class="note small" data-hwnote hidden></p>';
  if (!c || c.want !== s.hwaccel) return '<p class="note small" data-hwnote>Checking whether it works…</p>';
  return c.ok ? '<p class="note small" data-hwnote>Working: conversions use the graphics chip.</p>'
    : '<p class="note warn small" data-hwnote><b>Not working, so conversions use software.</b> ' + V.esc(c.why) + '</p>';
}

V.adminTabs.playback = function (body, A) {
  var s = A.settings, st = A.status;
  var opt = function (cur, list) { return list.map(function (o) { return '<option value="' + o[0] + '"' + (String(cur) === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>'; }).join(''); };
  body.innerHTML = '<section class="card-sec"><h2>How streams reach the viewer</h2>' +
    '<label class="check"><input type="radio" name="routing" value="direct-first"' + (s.routing === 'direct-first' ? ' checked' : '') + '><span><b>Direct first</b> — each device connects straight to the provider. When a provider blocks web players (CORS), the browser’s built-in player or the provider’s own HLS copy is used, or only the playlist text comes through here while the video still goes direct. A stream goes fully through this server only when nothing else works (or it needs special headers or converting). Desktop browsers can add the <i>direct-streams helper</i> (Settings) to make every stream direct.</span></label>' +
    '<label class="check"><input type="radio" name="routing" value="server"' + (s.routing === 'server' ? ' checked' : '') + '><span><b>Always through this server</b> — most compatible; the provider sees one address.</span></label>' +
    '<label class="check"><input type="radio" name="routing" value="direct-only"' + (s.routing === 'direct-only' ? ' checked' : '') + '><span><b>Direct only</b> — never send video through this server. Streams that can’t be reached directly won’t play (unless the viewer has the direct-streams helper).</span></label>' +
    '<label class="field"><span>User-Agent sent to providers</span><input class="input" data-s="userAgent" value="' + V.esc(s.userAgent) + '"></label>' +
    '<label class="switch"><input type="checkbox" data-b="smartFailover"' + (s.smartFailover !== false ? ' checked' : '') + '><span class="sw"></span><span><b>Switch to a working copy quickly</b><small>When a channel or film has copies from several lists and the one playing fails (or is slow to start), the server tries the others all at once — through the stream relay when it’s on, one per provider account, never on an account with no free connection — and the player goes straight to the quickest one that works, instead of trying them one by one. Off: one after another, as before.</small></span></label>' +
    '<label class="switch"><input type="checkbox" data-b="warmStart"' + (s.warmStart !== false ? ' checked' : '') + '><span class="sw"></span><span><b>Get ready when a title’s page opens</b><small>The server looks inside the film or episode the Play button would start as soon as its page is open — when the account has a connection to spare — so pressing Play doesn’t wait for that. One short extra connection to the provider per page opened.</small></span></label>' +
    '<label class="switch"><input type="checkbox" data-b="quickStart"' + (s.quickStart !== false ? ' checked' : '') + '><span class="sw"></span><span><b>Start conversions quickly</b><small>When the provider has said what a film or episode is (or for a live channel), the server starts converting straight away and looks inside the stream at the same time, instead of one after the other — a few seconds sooner. This briefly uses two connections, so only when the account has room for two. If the look finds something else is needed, the conversion starts again that way.</small></span></label></section>' +
    '<section class="card-sec"><h2>Conversion (ffmpeg)</h2>' + (st.ffmpeg ? '' : '<p class="note warn">ffmpeg isn’t installed.</p>') +
    // (What's converted and what's passed on: lib/media.js needsVideoTranscode; tonemap: whether this ffmpeg can.)
    (st.ffmpeg ? '<p class="dim small">Each device says what it can decode, and only what it can’t is converted. A picture it decodes (H.264 everywhere; HEVC, AV1 or VP9 where the device has them) is passed on as it is, with the sound made AAC; anything else — Xvid, MPEG-2, WMV, 10-bit H.264, a film taller than the device decodes — is re-encoded to H.264. Interlaced pictures are deinterlaced on the way, and an HDR film converted for a screen that can’t show it is brought down to ordinary colours' + (st.tonemap ? '.' : ' — <b>not with this ffmpeg</b> (it lacks the <i>zscale</i> filter), so those come out grey.') + '</p>' : '') +
    '<div class="grid2"><label class="field"><span>Hardware encoder</span><select class="input" data-s="hwaccel">' + opt(s.hwaccel, [['', 'None (software)'], ['vaapi', 'Intel/AMD (VAAPI)'], ['qsv', 'Intel Quick Sync'], ['nvenc', 'NVIDIA (NVENC)'], ['videotoolbox', 'Apple (VideoToolbox)']]) + '</select><small class="dim">Available: ' + (st.encoders.length ? st.encoders.join(', ') : 'none detected') + '. Falls back to software if it fails.</small>' + hwNote(s, st) + '</label>' +
    '<label class="field"><span>Software speed</span><select class="input" data-s="transcodePreset">' + opt(s.transcodePreset, [['ultrafast', 'Fastest (bigger)'], ['superfast', 'Very fast'], ['veryfast', 'Fast (recommended)'], ['faster', 'Balanced'], ['fast', 'Better quality'], ['medium', 'Best quality (slow)']]) + '</select></label>' +
    '<label class="field"><span>Highest resolution when converting</span><select class="input" data-s="transcodeMaxHeight">' + opt(s.transcodeMaxHeight, [[2160, '4K'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [480, '480p']]) + '</select></label>' +
    '<label class="field"><span>Quality (CRF, lower = better)</span><input class="input" type="number" min="16" max="35" data-s="transcodeCrf" value="' + s.transcodeCrf + '"></label>' +
    '<label class="field"><span>Most conversions at once (0 = no limit)</span><input class="input" type="number" min="0" max="32" data-s="maxTranscodes" value="' + s.maxTranscodes + '"></label>' +
    '<label class="field"><span>Most server streams at once</span><input class="input" type="number" min="1" max="64" data-s="maxSessions" value="' + s.maxSessions + '"></label></div></section>' +
    areasHtml(s) +
    '<section class="card-sec"><h2>Features</h2>' + [['introDetection', 'Detect intros and end credits automatically (compares episodes’ audio on the server)']].map(function (x) { return '<label class="switch"><input type="checkbox" data-b="' + x[0] + '"' + (s[x[0]] ? ' checked' : '') + '><span class="sw"></span><span>' + x[1] + '</span></label>'; }).join('') + '</section>';
  // What's switched on: one press for "just watching", or each part by itself.
  var areasSave = function (off, extra, msg) {
    var p = Object.assign({ off: off }, extra || {});
    return V.adminSave(p, msg).then(function (saved) {
      S.settings = Object.assign(S.settings, { off: saved.off || {}, allowDownloads: saved.allowDownloads !== false, allowParties: saved.allowParties !== false });
      V.emit('settings');
      var sec = V.$('.adm-areas', body);
      if (sec) { var f = document.activeElement && document.activeElement.getAttribute && (document.activeElement.getAttribute('data-area-sw') || document.activeElement.getAttribute('data-areas')); sec.outerHTML = areasHtml(saved); var back = f && V.$('.adm-areas [data-area-sw="' + f + '"], .adm-areas [data-areas="' + f + '"]', body); if (back) back.focus(); }
    });
  };
  body.addEventListener('click', function (e) {
    var pb = e.target.closest('[data-areas]');
    if (!pb) return;
    var off = {};
    if (pb.dataset.areas === 'simple') AREA_SW.forEach(function (x) { if (!x[3]) off[x[0]] = true; });
    areasSave(off, { allowDownloads: pb.dataset.areas !== 'simple', allowParties: pb.dataset.areas !== 'simple' }, pb.dataset.areas === 'simple' ? 'Simple: the extras are off for everyone' : 'Everything is switched on');
  });
  body.onchange = function (e) {
    var t = e.target, p = {};
    if (t.name === 'routing') p.routing = t.value;
    else if (t.dataset.s && t.type === 'number') { p[t.dataset.s] = V.adminNum(t, S.admin.settings[t.dataset.s]); if (p[t.dataset.s] === null) return; }
    else if (t.dataset.s) p[t.dataset.s] = t.dataset.s === 'transcodeMaxHeight' ? +t.value : t.value;
    else if (t.dataset.areaSw) {
      var cur = Object.assign({}, S.admin.settings.off || {}), sw = AREA_SW.filter(function (x) { return x[0] === t.dataset.areaSw; })[0];
      if (sw && sw[3]) { var ex = {}; ex[sw[0]] = t.checked; areasSave(cur, ex).catch(function () { t.checked = !t.checked; }); return; }
      if (t.checked) delete cur[t.dataset.areaSw]; else cur[t.dataset.areaSw] = true;
      areasSave(cur).catch(function () { t.checked = !t.checked; });
      return;
    }
    else if (t.dataset.b) p[t.dataset.b] = t.checked;
    else return;
    V.adminSave(p).then(function (saved) {
      if ('hwaccel' in p) { st.hwCheck = saved && saved._hwCheck; var n = V.$('[data-hwnote]', body); if (n) n.outerHTML = hwNote(S.admin.settings, st); }
      if (p.routing || t.dataset.b) S.settings = Object.assign(S.settings, { routing: p.routing || S.settings.routing }, 'smartFailover' in p ? { smartFailover: p.smartFailover } : {}); });
  };
};

/* Admin → Playback → What's switched on. [setting or area, name, what it is, true = its own older setting (on = true)]
   The areas are V.AREAS (core.js) and AREAS (server.js). */
var AREA_SW = [
  ['messages', 'Messages', 'Chat between profiles and “Send to someone”. Alerts for new episodes stay.'],
  ['allowParties', 'Watch parties', 'Watching the same thing together, in step.', true],
  ['allowDownloads', 'Downloads', 'Saving films and episodes on a device to watch offline.', true],
  ['multiview', 'Multiview', 'Several channels on the screen at once.'],
  ['trailers', 'Trailers', 'The trailers page and “Watch the trailer”.'],
  ['moods', 'Pick something for me', '“Surprise me”, the moods and “Pick for several of us” on Home.'],
  ['queue', 'Play queue', '“Play next” and “Add to queue”.'],
  ['wishlist', 'Wishlist', 'Asking to be told when a film or series arrives.'],
  ['follow', 'Teams and competitions', 'Following teams to get their games on Home, with reminders.'],
  ['viewing', 'Viewing statistics', 'Your viewing, Your week and Year in review.'],
  ['themes', 'A choice of looks', 'All 25 colour themes. Off: Midnight, Daylight and High contrast only.'],
];
function areasHtml(s) {
  var off = s.off || {};
  var isOn = function (x) { return x[3] ? s[x[0]] !== false : off[x[0]] !== true; };
  var nOff = AREA_SW.filter(function (x) { return !isOn(x); }).length;
  return '<section class="card-sec adm-areas"><h2>What’s switched on</h2>' +
    '<p class="dim">Switch off the parts this household doesn’t use. They go from every menu and page, for everyone, and the server stops answering for them. Nothing is deleted: switch a part back on and it’s as it was.</p>' +
    '<div class="btn-row"><button class="btn sm" data-areas="simple"' + (nOff === AREA_SW.length ? ' disabled' : '') + '>Simple: just watching</button><button class="btn sm" data-areas="all"' + (nOff ? '' : ' disabled') + '>Everything on</button><span class="dim small">' + (nOff ? nOff + ' of ' + AREA_SW.length + ' switched off' : 'Everything is on') + '</span></div>' +
    '<div class="areas">' + AREA_SW.map(function (x) {
      return '<label class="switch"><input type="checkbox" data-area-sw="' + x[0] + '"' + (isOn(x) ? ' checked' : '') + '><span class="sw"></span><span><b>' + x[1] + '</b><small class="dim">' + x[2] + '</small></span></label>';
    }).join('') + '</div></section>';
}

V.adminTabs.recs = function (body, A) {
  var s = A.settings;
  body.innerHTML = '<section class="card-sec"><h2>The Movie Database (TMDB)</h2><p class="dim small">Data and images from ' + V.TMDB_LOGO + '. This product uses the TMDB API but is not endorsed or certified by TMDB.</p><p>With a free TMDB key, recommendations use TMDB’s “people who liked this also liked…” lists for everything each profile watches, blended with what they’ve watched here. TMDB also fills in posters, plots, cast, genres and age ratings for titles your lists don’t describe. (IMDb has no public API, so TMDB is used instead.)</p>' +
    '<ol class="small dim"><li>Create a free account at themoviedb.org.</li><li>Settings → API → request an API key (choose “Developer”, any app name).</li><li>Paste the “API Key” or “API Read Access Token” below.</li></ol>' +
    '<label class="field"><span>TMDB key</span><div class="inline"><input class="input" data-key value="' + V.esc(s.tmdbKey || '') + '" placeholder="Paste the key"><button class="btn" data-save>Save</button><button class="btn" data-test>Test</button></div></label>' +
    '<p class="dim small">Status: ' + (A.status.tmdb.enabled ? 'on · ' + A.status.tmdb.matched + ' titles have details' + (A.status.tmdb.error ? ' · <span class="err">' + V.esc(A.status.tmdb.error) + '</span>' : '') : 'off') + '</p>' +
    '<div class="tmdb-fetch"></div></section>' +
    (A.status.tmdb.enabled ? V.tmdbOptionsHtml(s) + '<section class="card-sec"><h2>Episode details</h2><p class="dim">Each episode’s own title, plot, picture and first air date from TMDB, for series your lists describe only as “Episode 3” or with no plots and pictures. Shown on each series’ page; the provider’s own titles and plots stay where they’re good.</p><div class="tmdb-eps"></div></section>' : '') +
    '<section class="card-sec"><h2>How recommendations work</h2><p class="dim">Each profile’s picks are worked out on the server and saved on disk. They use what the profile watched (more weight for finished and recent things), thumbs up/down, My List and chosen interests; TMDB’s related titles; actors and directors you keep watching; titles several of your favourites point to; and what others in the household watch. Titles that keep being shown without being opened make way for new ones, and rows are re-ranked for variety.</p></section>';
  body.onclick = function (e) {
    if (e.target.closest('[data-save]')) V.adminSave({ tmdbKey: V.$('[data-key]', body).value }).then(function () { V.router.refresh(); });
    if (e.target.closest('[data-test]')) V.api('/api/admin/tmdb/test', { method: 'POST' }).then(function (j) { V.toast(j.ok ? 'TMDB works' : 'TMDB: ' + j.error, { error: !j.ok }); }).catch(V.fail);
  };
  if (A.status.tmdb.enabled) { V.tmdbFetchPanel(V.$('.tmdb-fetch', body)); V.tmdbEpisodesPanel(V.$('.tmdb-eps', body)); V.tmdbOptionsWire(body); }
};

/** Admin → Recommendations → Options: what TMDB fills in, and how. */
V.TMDB_LANGS = [['', 'English (TMDB’s default)'], ['en-GB', 'English (UK)'], ['es-ES', 'Spanish (Spain)'], ['es-MX', 'Spanish (Latin America)'], ['fr-FR', 'French'], ['fr-CA', 'French (Canada)'], ['de-DE', 'German'], ['it-IT', 'Italian'], ['pt-BR', 'Portuguese (Brazil)'], ['pt-PT', 'Portuguese (Portugal)'], ['nl-NL', 'Dutch'], ['sv-SE', 'Swedish'], ['da-DK', 'Danish'], ['nb-NO', 'Norwegian'], ['fi-FI', 'Finnish'], ['pl-PL', 'Polish'], ['tr-TR', 'Turkish'], ['ar-SA', 'Arabic'], ['hi-IN', 'Hindi'], ['ja-JP', 'Japanese'], ['ko-KR', 'Korean'], ['zh-CN', 'Chinese']];
V.tmdbOptionsHtml = function (s) {
  var sw = function (k, on, title, hint) { return '<label class="switch"><input type="checkbox" data-opt="' + k + '"' + (on ? ' checked' : '') + '><span class="sw"></span><span><b>' + title + '</b><small>' + hint + '</small></span></label>'; };
  return '<section class="card-sec tmdb-opts"><h2>Options</h2>' +
    sw('tmdbAuto', s.tmdbAuto !== false, 'Look up new titles by themselves', 'A minute after the lists change, titles nobody has looked up yet get their posters, plots and genres. Off: only when you press a button above.') +
    sw('tmdbTitles', s.tmdbTitles !== false, 'Use TMDB’s titles', 'When the match is sure, every copy of a film or series is called what TMDB calls it (“Spider-Man: Into the Spider-Verse” instead of “Spider Man Into The Spiderverse”). Changing this puts the catalogue together again.') +
    '<label class="field"><span>Episode details</span><select class="input" data-opt-sel="tmdbEpisodes"><option value="open"' + (s.tmdbEpisodes !== 'off' ? ' selected' : '') + '>Fetched when someone opens a series (and with the buttons below)</option><option value="off"' + (s.tmdbEpisodes === 'off' ? ' selected' : '') + '>Only with the buttons below</option></select></label>' +
    '<label class="field"><span>Language of titles and plots</span><select class="input" data-opt-sel="tmdbLang">' + V.TMDB_LANGS.map(function (o) { return '<option value="' + o[0] + '"' + ((s.tmdbLang || '') === o[0] ? ' selected' : '') + '>' + V.esc(o[1]) + '</option>'; }).join('') + '</select><small class="dim">Where TMDB has them in that language (it falls back to English). Details already fetched change when they’re fetched again (“Update everything”).</small></label>' +
    '</section>';
};
V.tmdbOptionsWire = function (body) {
  var box = V.$('.tmdb-opts', body);
  if (!box) return;
  box.addEventListener('change', function (e) {
    var t = e.target, patch = {};
    if (t.dataset.opt) patch[t.dataset.opt] = t.checked;
    else if (t.dataset.optSel) patch[t.dataset.optSel] = t.value;
    else return;
    V.adminSave(patch, t.dataset.opt === 'tmdbTitles' ? 'Saved — the catalogue is being put together again' : 'Saved').catch(function () { if (t.dataset.opt) t.checked = !t.checked; });
  });
};

/** Admin → Recommendations → Episode details: how many series have them, and fetching them for many at once. */
V.tmdbEpisodesPanel = function (box) {
  var info = null, timer = null, groups = null, picked = new Set(), groupF = '';
  var draw = function () {
    var j = info.job, c = info.counts, last = info.last;
    var pct = j && j.total ? j.done / j.total : 0;
    box.innerHTML = '<div class="stats small-stats">' + [['Series with details', c.shows], ['With episode details', c.withEps], ['Episodes described', c.episodes]].map(function (x) { return '<div class="stat"><b class="num">' + Number(x[1]).toLocaleString() + '</b><span>' + x[0] + '</span></div>'; }).join('') + '</div>' +
      (j ? '<div class="tf-job"><div class="tf-h"><b>Fetching episode details</b><span class="sp"></span><button class="btn sm" data-te-stop>Stop</button></div><div class="bar big"><i style="width:' + (pct * 100).toFixed(1) + '%"></i></div><div class="dim small">' + j.done.toLocaleString() + ' of ' + V.plural(j.total, 'series', 'series') + ' · ' + (j.episodes || 0).toLocaleString() + ' episodes' + (j.current ? '<br>Now: ' + V.esc(j.current) : '') + '</div></div>'
        : last && last.finished && Date.now() - last.finished < 3600e3 ? '<p class="dim small">' + (last.stopped ? 'Stopped' : 'Finished') + ' ' + V.fmtAgo(last.finished) + ': ' + V.plural(last.found || 0, 'series', 'series') + ', ' + (last.episodes || 0).toLocaleString() + ' episodes.</p>' : '') +
      '<div class="btn-row"' + (j ? ' hidden' : '') + '><button class="btn primary" data-te="mine">' + V.icon('download') + ' Series the household watches (' + Number(c.household).toLocaleString() + ')</button><button class="btn" data-te="all">Every series with details</button><button class="btn" data-te="fresh">' + V.icon('refresh') + ' Fetch the household’s again</button></div>' +
      '<details class="tf-groups" data-te-groups' + (picked.size ? ' open' : '') + '><summary>By category</summary>' + (groups ? '<div class="inline"><input class="input" type="search" data-te-filter placeholder="Filter categories" value="' + V.esc(groupF) + '"><button class="btn" data-te="groups"' + (j || !picked.size ? ' disabled' : '') + '>Fetch ' + (picked.size ? V.plural(picked.size, 'category', 'categories') : 'selected') + '</button></div><div class="tf-glist">' + groups.filter(function (g) { return !groupF || V.norm(g.name).indexOf(V.norm(groupF)) >= 0; }).slice(0, 400).map(function (g) { return '<label class="check"><input type="checkbox" value="' + V.esc(g.id) + '"' + (picked.has(g.id) ? ' checked' : '') + '><span>' + V.esc(g.name) + ' <small class="dim">' + V.plural(g.total, 'series', 'series') + '</small></span></label>'; }).join('') + '</div>' : '<div class="spinner sm"></div>') + '</details>';
  };
  var load = function () {
    clearTimeout(timer);
    return V.api('/api/admin/tmdb/episodes').then(function (r) {
      info = r;
      var f = document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-te-filter]');
      draw();
      if (f) { var inp = V.$('[data-te-filter]', box); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
      if (r.job && box.isConnected) timer = setTimeout(load, 2000);
    }).catch(function (e) { box.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
  };
  box.addEventListener('toggle', function (e) {
    if (!e.target.matches || !e.target.matches('[data-te-groups]') || !e.target.open || groups) return;
    V.api('/api/admin/tmdb/enrich').then(function (r) { groups = r.groups.filter(function (g) { return g.t === 'show'; }); draw(); V.$('[data-te-groups]', box).open = true; }).catch(V.fail);
  }, true);
  box.addEventListener('click', function (e) {
    var b = e.target.closest('[data-te]');
    if (b && !b.disabled) {
      var m = b.dataset.te, req = { mode: m === 'fresh' ? 'mine' : m, fresh: m === 'fresh' };
      if (m === 'groups') req.groups = Array.from(picked);
      var go = function () { V.api('/api/admin/tmdb/episodes', { body: req }).then(function (j) { if (j.nothing) V.toast('They all have episode details already'); picked.clear(); load(); }).catch(V.fail); };
      if (m === 'all') V.confirm('Fetch episode details for all ' + Number(info.counts.shows).toLocaleString() + ' series with details? That’s one request per season — it takes a while, and everything keeps working meanwhile.', { ok: 'Fetch them' }).then(function (ok) { if (ok) go(); });
      else go();
    }
    if (e.target.closest('[data-te-stop]')) V.del('/api/admin/tmdb/episodes').then(load);
  });
  box.addEventListener('change', function (e) { if (e.target.closest('.tf-glist')) { if (e.target.checked) picked.add(e.target.value); else picked.delete(e.target.value); var gb = V.$('[data-te=groups]', box); gb.disabled = !picked.size; gb.textContent = 'Fetch ' + (picked.size ? V.plural(picked.size, 'category', 'categories') : 'selected'); } });
  box.addEventListener('input', V.debounce(function (e) { if (e.target.matches('[data-te-filter]')) { groupF = e.target.value; draw(); var inp = V.$('[data-te-filter]', box); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }, 200));
  load();
  var prevCleanup = V.pageCleanup;
  V.pageCleanup = function () { clearTimeout(timer); if (prevCleanup) prevCleanup(); };
};

/** Admin → Recommendations: fetch TMDB details (what's missing, everything again, or chosen categories) with progress. */
V.tmdbFetchPanel = function (box) {
  var info = null, groupF = '', picked = new Set(), timer = null;
  var draw = function () {
    var j = info.job || null, c = info.counts, last = info.last;
    var pct = j && j.total ? j.done / j.total : 0;
    var eta = j && j.done > 5 ? (Date.now() - j.started) / j.done * (j.total - j.done) / 1000 : 0;
    box.innerHTML = '<div class="stats small-stats">' + [['Movies & series', c.titles], ['With details', c.fetched], ['Not looked up yet', c.missing], ['Not found on TMDB', c.noMatch]].map(function (x) { return '<div class="stat"><b class="num">' + Number(x[1]).toLocaleString() + '</b><span>' + x[0] + '</span></div>'; }).join('') + '</div>' +
      (j ? '<div class="tf-job"><div class="tf-h"><b>' + ({ visible: 'Filling in what the household can see', missing: 'Fetching everything not fetched yet', all: 'Updating everything', groups: 'Fetching: ' + V.esc(j.label || 'chosen categories') }[j.mode] || 'Fetching') + '</b><span class="sp"></span><button class="btn sm" data-tf-stop>Stop</button></div>' +
        '<div class="bar big"><i style="width:' + (pct * 100).toFixed(1) + '%"></i></div><div class="dim small">' + j.done.toLocaleString() + ' of ' + j.total.toLocaleString() + ' (' + Math.floor(pct * 100) + '%) · ' + (j.found || 0).toLocaleString() + ' found · ' + (j.missed || 0).toLocaleString() + ' not on TMDB' + (eta ? ' · about ' + V.fmtLen(eta) + ' left' : '') + (j.current ? '<br>Now: ' + V.esc(j.current) : '') + '</div></div>'
        : last && last.finished && Date.now() - last.finished < 3600e3 ? '<p class="dim small">' + (last.stopped ? 'Stopped' : 'Finished') + ' ' + V.fmtAgo(last.finished) + ': ' + (last.found || 0).toLocaleString() + ' found, ' + (last.missed || 0).toLocaleString() + ' not on TMDB.</p>' : '') +
      '<div class="btn-row tf-acts"' + (j ? ' hidden' : '') + '>' +
      '<button class="btn primary" data-tf="missing">' + V.icon('download') + ' Fetch everything not fetched yet</button>' +
      '<button class="btn" data-tf="visible">Only what profiles can see</button>' +
      '<button class="btn" data-tf="all">' + V.icon('refresh') + ' Update everything</button>' +
      '<button class="btn" data-tf="retry">Try again for ones TMDB didn’t find</button></div>' +
      '<details class="tf-groups"' + (picked.size ? ' open' : '') + '><summary>By category</summary><div class="inline"><input class="input" type="search" data-tf-filter placeholder="Filter categories" value="' + V.esc(groupF) + '"><button class="btn" data-tf="groups"' + (j || !picked.size ? ' disabled' : '') + '>Fetch ' + (picked.size ? V.plural(picked.size, 'category', 'categories') : 'selected') + '</button></div>' +
      '<div class="tf-glist">' + info.groups.filter(function (g) { return !groupF || V.norm(g.name).indexOf(V.norm(groupF)) >= 0; }).slice(0, 400).map(function (g) {
        return '<label class="check"><input type="checkbox" value="' + V.esc(g.id) + '"' + (picked.has(g.id) ? ' checked' : '') + '><span>' + V.esc(g.name) + ' <small class="dim">' + (g.t === 'show' ? 'series' : 'movies') + ' · ' + g.fetched + '/' + g.total + '</small><span class="fetch-bar"><i style="width:' + (g.total ? g.fetched / g.total * 100 : 0) + '%"></i></span></span></label>';
      }).join('') + '</div></details>';
  };
  var load = function () {
    clearTimeout(timer);
    return V.api('/api/admin/tmdb/enrich').then(function (r) {
      info = r;
      var f = document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-tf-filter]');
      draw();
      if (f) { var inp = V.$('[data-tf-filter]', box); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
      if (r.job && box.isConnected) timer = setTimeout(load, 2000);
    }).catch(function (e) { box.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
  };
  box.addEventListener('click', function (e) {
    var b = e.target.closest('[data-tf]');
    if (b) {
      var mode = b.dataset.tf, body = { mode: mode === 'retry' ? 'missing' : mode, retry: mode === 'retry' };
      if (mode === 'groups') body.groups = Array.from(picked);
      var go = function () { V.api('/api/admin/tmdb/enrich', { body: body }).then(function (j) { if (j.nothing) V.toast('Nothing to fetch there'); picked.clear(); load(); }).catch(V.fail); };
      if (mode === 'all') V.confirm('Fetch details again for all ' + info.counts.titles.toLocaleString() + ' movies and series? At about 7 a second this takes a while; everything keeps working meanwhile.', { ok: 'Update everything' }).then(function (ok) { if (ok) go(); });
      else go();
    }
    if (e.target.closest('[data-tf-stop]')) V.del('/api/admin/tmdb/enrich').then(load);
  });
  box.addEventListener('change', function (e) { if (e.target.closest('.tf-glist')) { if (e.target.checked) picked.add(e.target.value); else picked.delete(e.target.value); var gb = V.$('[data-tf=groups]', box); gb.disabled = !picked.size; gb.textContent = 'Fetch ' + (picked.size ? V.plural(picked.size, 'category', 'categories') : 'selected'); } });
  box.addEventListener('input', V.debounce(function (e) { if (e.target.matches('[data-tf-filter]')) { groupF = e.target.value; draw(); var inp = V.$('[data-tf-filter]', box); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }, 200));
  load();
  var prevCleanup = V.pageCleanup;
  V.pageCleanup = function () { clearTimeout(timer); if (prevCleanup) prevCleanup(); };
};

V.adminTabs.network = function (body, A) {
  var st = A.settings;
  var proxies = (st.proxies || []).map(function (x) { return Object.assign({}, x); });
  var draw = function () {
    body.innerHTML = '<section class="card-sec"><h2>Proxies</h2><p class="dim">Send the server’s own traffic to providers through a proxy (HTTP or SOCKS5): list downloads, account checks, TV guides, TMDB, and every stream that goes through the server (relays and conversions). Each list can use the default, another proxy, or none (Admin → Lists → edit).</p>' +
      '<ul class="adm-list proxies">' + (proxies.length ? proxies.map(function (x, i) {
        return '<li data-i="' + i + '"><div class="grid2"><label class="field"><span>Name</span><input class="input" data-k="name" value="' + V.esc(x.name) + '"></label><label class="field"><span>Address</span><input class="input" data-k="url" value="' + V.esc(x.url) + '" placeholder="socks5://user:password@host:1080"></label></div>' +
          '<label class="check"><input type="checkbox" data-k="video"' + (x.video ? ' checked' : '') + '><span>Video too: viewers’ streams from lists using this proxy always go through the server (and so through the proxy) instead of straight from the provider. (With the stream relay, choose below whether the relay uses proxies instead.)</span></label>' +
          '<div class="btn-row"><button class="btn sm" data-test>Test</button><button class="btn sm danger" data-rm>Remove</button><span class="dim small" data-res></span></div></li>';
      }).join('') : '<li class="dim">No proxies.</li>') + '</ul>' +
      '<div class="btn-row"><button class="btn" data-add>' + V.icon('plus') + ' Add a proxy</button></div>' +
      '<label class="field"><span>Default for everything</span><select class="input" data-def><option value="">No proxy</option>' + proxies.filter(function (x) { return x.id; }).map(function (x) { return '<option value="' + x.id + '"' + (st.proxy === x.id ? ' selected' : '') + '>' + V.esc(x.name) + '</option>'; }).join('') + '</select></label>' +
      '<button class="btn primary" data-save-p>Save proxies</button></section>' +
      (function () {
        var r = st.relay || {};
        var https = location.protocol === 'https:';
        return '<section class="card-sec"><h2>Stream relay</h2><p class="dim">Send viewers’ <b>direct</b> streams through a small relay on an internet machine of yours (a VPS) instead of straight from the provider. The provider then only sees the relay’s address, never your home’s or your viewers’, and this server still carries none of the video. It also lets streams play that a provider normally only allows in apps. <a href="https://github.com/austin-72/superstation-iptv/blob/main/docs/stream-relay.md" target="_blank" rel="noopener">How to set one up</a> (about 10 minutes).</p>' +
          '<label class="field"><span>The relay’s address</span><input class="input" data-relay-url value="' + V.esc(r.url || '') + '" placeholder="https://relay.example.com"><small class="dim">' + (https ? 'This page is on https, so the relay needs an https address too.' : 'An https address is best; plain http works only while this app is opened on plain http.') + '</small></label>' +
          '<label class="check"><input type="checkbox" data-relay-all' + (r.all !== false ? ' checked' : '') + '><span>Use it for every list (each list can still choose in its own settings)</span></label>' +
          '<label class="field"><span>How the relay connects to providers</span><select class="input" data-relay-proxy>' +
            [['', 'Directly (providers see the relay’s address)'], ['list', 'Through each list’s proxy (the same proxy this server uses)']].concat(proxies.filter(function (x) { return x.id; }).map(function (x) { return [x.id, 'Through ' + x.name]; })).map(function (o) { return '<option value="' + V.esc(o[0]) + '"' + ((r.proxy || '') === o[0] ? ' selected' : '') + '>' + V.esc(o[1]) + '</option>'; }).join('') +
          '</select><small class="dim">With a proxy, providers see the proxy’s address instead of the relay’s — handy when a provider only accepts one address, or blocks data-centre addresses like the relay’s. All the video then goes through the proxy too, so mind its data allowance. Proxies are set up above; press Test after saving to check them.</small></label>' +
          (r.hasSecret ? '<p class="small">The relay needs this server’s secret: <button class="btn sm" data-relay-copy>' + V.icon('copy') + ' Copy the secret</button> <button class="btn sm" data-relay-new>Make a new secret</button></p>' : '<p class="dim small">A secret is made when you save the address.</p>') +
          '<div class="btn-row"><button class="btn primary" data-relay-save>Save</button>' + (r.url ? '<button class="btn" data-relay-test>Test</button><button class="btn" data-relay-off>Stop using it</button>' : '') + '<span class="dim small" data-relay-res></span></div>' +
          (r.url && https && /^http:/i.test(r.url) ? '<p class="note warn">' + V.icon('info') + ' <span>This relay is plain http, so browsers opening this app on https can’t use it; their streams go through the server instead.</span></p>' : '') +
          '<p class="dim small">Everything this server reads from those lists goes through the relay too: conversions, downloads, recordings, other apps and channel checks. Streams a browser can’t play as they are (MKV films with AC-3 sound, for example) are converted in the browser when it can, else by this server — both reading from the relay. Lists, guides and account checks still go from this server: set the relay up as this server’s proxy too (see the guide) to hide your home’s address from those as well.</p></section>';
      })() +
      '<section class="card-sec"><h2>Direct playback from an https address</h2><p class="dim">Browsers won’t play a plain-http stream on a secure (https) page, so streams from http-only providers have to go through the server when people use your https address. Give this server’s plain-http address here (your home network address, e.g. <code>http://192.168.1.20:' + (location.port || 8080) + '</code>, or a public one) and those devices can switch to it and play straight from the provider. They stay signed in.</p>' +
      '<p class="dim small">Note: on plain http, what the app sends isn’t encrypted. A home-network address keeps that inside your home (and then the switch only works at home).</p>' +
      '<label class="field"><span>Direct (http) address</span><div class="inline"><input class="input" data-direct value="' + V.esc(st.directAddress || '') + '" placeholder="http://192.168.1.20:' + (location.port || 8080) + '">' + (st.directAddress ? '<a class="btn" target="_blank" rel="noopener" href="' + V.esc(st.directAddress) + '">Test</a>' : '') + '</div></label>' +
      '<label class="field"><span>When a stream needs it</span><select class="input" data-dmode>' + [['ask', 'Ask the viewer (they can remember the choice per device)'], ['auto', 'Switch automatically'], ['off', 'Never switch (play through the server)']].map(function (o) { return '<option value="' + o[0] + '"' + ((st.directSwitch || 'ask') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
      '<button class="btn primary" data-save-d>Save</button></section>';
  };
  draw();
  // Redraw without losing what's typed but not saved yet in the other sections (keep: their fields' attributes).
  var redraw = function (keep) {
    var vals = keep.map(function (a) { var el = V.$('[' + a + ']', body); return el ? el.value : null; });
    draw();
    keep.forEach(function (a, i) { var el = V.$('[' + a + ']', body); if (el && vals[i] !== null) el.value = vals[i]; });
  };
  var collect = function () { V.$$('.proxies [data-i]', body).forEach(function (li) { var x = proxies[+li.dataset.i]; x.name = V.$('[data-k=name]', li).value; x.url = V.$('[data-k=url]', li).value.trim(); x.video = V.$('[data-k=video]', li).checked; }); };
  body.onclick = function (e) {
    var li = e.target.closest('[data-i]');
    if (e.target.closest('[data-add]')) { collect(); proxies.push({ name: 'Proxy ' + (proxies.length + 1), url: '', video: false }); redraw(['data-relay-url', 'data-direct']); }
    else if (li && e.target.closest('[data-rm]')) { collect(); proxies.splice(+li.dataset.i, 1); redraw(['data-relay-url', 'data-direct']); }
    else if (li && e.target.closest('[data-test]')) {
      collect();
      var x = proxies[+li.dataset.i], res = V.$('[data-res]', li);
      res.textContent = 'Testing…';
      V.api('/api/admin/proxy/test', { body: { url: x.url, id: x.id } }).then(function (r) { res.innerHTML = r.ok ? V.icon('check', 'tiny ok') + ' Works · ' + r.ms + ' ms' + (r.ip ? ' · the internet sees ' + V.esc(r.ip) : '') : '<span class="err">' + V.esc(r.error || 'HTTP ' + r.status) + '</span>'; }).catch(function (er) { res.innerHTML = '<span class="err">' + V.esc(er.message) + '</span>'; });
    } else if (e.target.closest('[data-save-p]')) { collect(); V.adminSave({ proxies: proxies, proxy: V.$('[data-def]', body).value }, 'Saved — lists using a changed proxy refresh').then(function (r) { proxies = (r.proxies || []).map(function (x) { return Object.assign({}, x); }); st = r; redraw(['data-relay-url', 'data-direct']); }).catch(function () {}); }
    else if (e.target.closest('[data-relay-save]')) V.adminSave({ relay: { url: V.$('[data-relay-url]', body).value.trim(), all: V.$('[data-relay-all]', body).checked, proxy: V.$('[data-relay-proxy]', body).value } }, 'Saved').then(function (r) { st = r; redraw(['data-direct']); }).catch(function () {});
    else if (e.target.closest('[data-relay-off]')) V.confirm('Stop using the stream relay? Direct streams go straight to the providers again.', { ok: 'Stop using it' }).then(function (ok) { if (ok) V.adminSave({ relay: { url: '' } }, 'The stream relay is off').then(function (r) { st = r; redraw(['data-direct']); }).catch(function () {}); });
    else if (e.target.closest('[data-relay-new]')) V.confirm('Make a new secret? The relay stops working until you give it the new one.', { ok: 'Make a new secret', danger: true }).then(function (ok) { if (ok) V.adminSave({ relay: { newSecret: true } }, 'New secret made — copy it to the relay').then(function (r) { st = r; redraw(['data-relay-url', 'data-direct']); }).catch(function () {}); });
    else if (e.target.closest('[data-relay-copy]')) V.api('/api/admin/relay/secret').then(function (r) { V.copy(r.secret, 'Secret copied — paste it into the relay’s RELAY_SECRET'); }).catch(V.fail);
    else if (e.target.closest('[data-relay-test]')) { var rr = V.$('[data-relay-res]', body); rr.textContent = 'Testing…'; V.api('/api/admin/relay/test', { method: 'POST' }).then(function (r) { rr.innerHTML = r.ok ? V.icon('check', 'tiny ok') + ' The relay works (' + r.ms + ' ms' + (r.streams ? ', ' + V.plural(r.streams, 'stream') + ' playing through it' : '') + (r.films ? ', ' + V.plural(r.films, 'film') + ' on its disk' : '') + ')' + (r.outdated ? ' <span class="warn">It runs version ' + V.esc(String(r.version)) + '; this server has ' + V.esc(r.latest) + '.</span> <button class="btn sm primary" data-relay-update>Update the relay</button>' : '') +
        // Its proxies: what providers will see.
        (!r.proxies && r.ownIp ? '<br>' + V.icon('info', 'tiny') + ' Providers see the relay’s address: ' + V.esc(r.ownIp) + ' <span class="dim">(through a VPN: the VPN’s)</span>' : '') +
        (r.proxies ? '<span class="relay-px">' + (r.ownIp ? '<br>' + V.icon('info', 'tiny') + ' The relay’s own address: ' + V.esc(r.ownIp) : '') + r.proxies.map(function (x) { return '<br>' + (x.ok ? V.icon('check', 'tiny ok') + ' Through ' + V.esc(x.name) + ': works · ' + x.ms + ' ms · providers see ' + V.esc(x.ip || '?') : '<span class="err">Through ' + V.esc(x.name) + ': ' + V.esc(x.error) + '</span>'); }).join('') + '</span>' : '') +
        (r.proxyNote ? '<br><span class="dim">' + V.esc(r.proxyNote) + '</span>' : '') : '<span class="err">' + V.esc(r.error) + '</span>'; }).catch(V.fail); }
    else if (e.target.closest('[data-relay-update]')) { var ru = V.$('[data-relay-res]', body); ru.textContent = 'Updating the relay…'; V.api('/api/admin/relay/update', { method: 'POST' }).then(function (r) { if (!r.ok) { ru.innerHTML = '<span class="err">' + V.esc(r.error) + '</span>'; return; } ru.textContent = 'Updated to version ' + r.to + ' — it’s restarting…'; setTimeout(function () { var t = V.$('[data-relay-test]', body); if (t && body.isConnected) t.click(); }, 6000); }).catch(function (er) { ru.textContent = ''; V.fail(er); }); }
    else if (e.target.closest('[data-save-d]')) V.adminSave({ directAddress: V.$('[data-direct]', body).value.trim(), directSwitch: V.$('[data-dmode]', body).value }).then(function (r) { st = r; S.settings.directAddress = r.directAddress; S.settings.directSwitch = r.directSwitch; redraw(['data-relay-url']); }).catch(function () {});
  };
};

V.adminTabs.categories = function (body, A) {
  var st = A.settings;
  var rules = (st.groupRules || []).map(function (r) { return Object.assign({}, r); });
  var groups = [];
  var draw = function () {
    body.innerHTML = '<section class="card-sec"><h2>Tidy category names</h2><label class="switch"><input type="checkbox" data-tidy' + (st.tidyGroups !== false ? ' checked' : '') + '><span class="sw"></span><span>Clean up providers’ category names: “|NA| USA ESPN+” → “ESPN+”, “VOD - NETFLIX” → “Netflix”, “TV ᴿᴬᵂ ⁶⁰ᶠᵖˢ” → “TV”, ALL CAPITALS → Title Case. Categories that end up with the same name are merged.</span></label></section>' +
      '<section class="card-sec"><h2>Your rules</h2><p class="dim">Rename, merge or hide categories. <code>*</code> matches anything (<code>Netflix*</code>, <code>*PPV*</code>). The first rule that matches wins. Rename several to the same name to merge them.</p>' +
      '<table class="rules"><thead><tr><th>Category</th><th>Becomes</th><th>Hide</th><th>Only for</th><th><span class="sr-only">Remove</span></th></tr></thead><tbody>' + rules.map(function (r, i) {
        return '<tr data-i="' + i + '"><td><input class="input" data-k="match" value="' + V.esc(r.match) + '" list="grp-names" placeholder="NETFLIX*"></td><td><input class="input" data-k="to" value="' + V.esc(r.to || '') + '" placeholder="Netflix"' + (r.hide ? ' disabled' : '') + '></td><td><input type="checkbox" data-k="hide"' + (r.hide ? ' checked' : '') + ' aria-label="Hide"></td>' +
          '<td><select class="input" data-k="types"><option value="">Everything</option>' + [['live', 'Live TV'], ['movie', 'Movies'], ['show', 'Series'], ['radio', 'Radio']].map(function (t) { return '<option value="' + t[0] + '"' + ((r.types || [])[0] === t[0] ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('') + '</select></td><td><button class="icon-btn" data-rm aria-label="Remove rule">' + V.icon('trash') + '</button></td></tr>';
      }).join('') + '</tbody></table><datalist id="grp-names">' + groups.slice(0, 2000).map(function (g) { return '<option value="' + V.esc(g.name) + '">'; }).join('') + '</datalist>' +
      '<div class="btn-row"><button class="btn" data-add>' + V.icon('plus') + ' Add a rule</button><button class="btn primary" data-save>Save and rebuild</button></div></section>' +
      '<section class="card-sec"><h2>Categories now</h2><input class="input" type="search" data-f placeholder="Filter"><div class="cat-now dim small"></div></section>';
    listNow('');
  };
  var listNow = function (q) {
    var nq = V.norm(q);
    var box = V.$('.cat-now', body);
    if (box) box.innerHTML = groups.filter(function (g) { return !nq || V.norm(g.name).indexOf(nq) >= 0; }).slice(0, 600).map(function (g) { var t = Object.keys(g.types).map(function (k) { return g.types[k] + ' ' + (V.TYPE_NAMES[k] || k).toLowerCase(); }).join(', '); return '<button class="chip sm" data-use="' + V.esc(g.name) + '" title="Make a rule for this">' + V.esc(g.name) + ' <small>' + V.esc(t) + '</small></button>'; }).join(' ');
  };
  var collect = function () { V.$$('.rules [data-i]', body).forEach(function (tr) { var r = rules[+tr.dataset.i]; r.match = V.$('[data-k=match]', tr).value.trim(); r.to = V.$('[data-k=to]', tr).value.trim(); r.hide = V.$('[data-k=hide]', tr).checked; var t = V.$('[data-k=types]', tr).value; r.types = t ? [t] : []; }); };
  // (collect first: rules typed while the category names were loading aren't lost.)
  V.api('/api/admin/groups').then(function (g) { groups = g.groups; collect(); draw(); }).catch(V.fail);
  draw();
  body.onclick = function (e) {
    var tr = e.target.closest('[data-i]');
    if (e.target.closest('[data-add]')) { collect(); rules.push({ match: '', to: '', hide: false, types: [] }); draw(); }
    else if (tr && e.target.closest('[data-rm]')) { collect(); rules.splice(+tr.dataset.i, 1); draw(); }
    else if (e.target.closest('[data-use]')) { collect(); rules.push({ match: e.target.closest('[data-use]').dataset.use, to: '', hide: false, types: [] }); draw(); var last = V.$$('.rules [data-k=to]', body).pop(); if (last) last.focus(); }
    else if (e.target.closest('[data-save]')) { collect(); V.adminSave({ groupRules: rules.filter(function (r) { return r.match; }), tidyGroups: V.$('[data-tidy]', body).checked }, 'Saved — the catalogue is being rebuilt').then(function (r) {
      st = r; rules = (r.groupRules || []).map(function (x) { return Object.assign({}, x); });
      draw(); // (now the rows match the saved rules, so later edits are collected onto the right ones)
      setTimeout(function () { V.api('/api/admin/groups').then(function (g) { groups = g.groups; collect(); draw(); }).catch(function () {}); }, 4000);
    }).catch(function () {}); }
  };
  body.onchange = function (e) {
    if (e.target.dataset.k === 'hide') { var to = V.$('[data-k=to]', e.target.closest('tr')); to.disabled = e.target.checked; }
    // (Remembered here too: a redraw — adding a rule — would otherwise tick it again, and "Save and rebuild" turn it back on.)
    if (e.target.hasAttribute('data-tidy')) { var on = e.target.checked; V.adminSave({ tidyGroups: on }, 'Saved — the catalogue is being rebuilt').then(function (r) { st = r; }).catch(function () { st.tidyGroups = !on; var c = V.$('[data-tidy]', body); if (c) c.checked = !on; }); st.tidyGroups = on; }
  };
  body.oninput = V.debounce(function (e) { if (e.target.hasAttribute('data-f')) listNow(e.target.value); }, 150);
};

V.adminTabs.brand = function (body, A) {
  var b = A.settings.brand || {};
  body.innerHTML = '<section class="card-sec"><h2>Brand</h2><p class="dim">The name and logo shown to signed-in profiles. The sign-in page never shows them.</p>' +
    '<label class="field"><span>Name</span><input class="input" data-name value="' + V.esc(b.name) + '" maxlength="60"></label>' +
    '<label class="field"><span>Logo: an emoji, or upload an image (SVG/PNG, square works best)</span><div class="inline"><input class="input" data-logo value="' + V.esc(/^data:/.test(b.logo || '') ? '' : b.logo || '') + '" placeholder="📺" maxlength="8"><input type="file" accept="image/*" data-file><button class="btn" data-clear>No logo</button></div></label>' +
    '<label class="field"><span>Accent colour (optional, overrides the theme’s)</span><div class="inline"><input type="color" data-accent value="' + (b.accent || '#e50914') + '"><label class="check"><input type="checkbox" data-use-accent' + (b.accent ? ' checked' : '') + '><span>Use it</span></label></div></label>' +
    '<div class="brand-preview"></div><button class="btn primary" data-save>Save brand</button></section>';
  var logo = b.logo || '';
  var prev = function () { var name = V.$('[data-name]', body).value; V.$('.brand-preview', body).innerHTML = '<div class="brand-demo">' + (logo ? (/^data:/.test(logo) ? '<img src="' + V.esc(logo) + '" alt="">' : '<span class="brand-emoji">' + V.esc(logo) + '</span>') : '') + '<span class="brand-name">' + V.esc(name) + '</span></div>'; };
  prev();
  body.addEventListener('input', function (e) { if (e.target.dataset.logo !== undefined) logo = e.target.value; prev(); });
  body.addEventListener('change', function (e) {
    if (e.target.dataset.file === undefined) return;
    var f = e.target.files[0];
    if (!f) return;
    if (f.size > 400000) return V.toast('Please use an image under 400 KB', { error: true });
    var r = new FileReader();
    r.onload = function () { logo = r.result; prev(); };
    r.readAsDataURL(f);
  });
  body.onclick = function (e) {
    if (e.target.closest('[data-clear]')) { logo = ''; V.$('[data-logo]', body).value = ''; prev(); }
    if (e.target.closest('[data-save]')) V.adminSave({ brand: { name: V.$('[data-name]', body).value, logo: logo, accent: V.$('[data-use-accent]', body).checked ? V.$('[data-accent]', body).value : '' } }).then(function (s) { S.settings.brand = s.brand; V.renderShell(); V.applyBrand(); });
  };
};

V.adminTabs.security = function (body, A) {
  var idle = A.devices.filter(function (d) { return d.id !== A.me && Date.now() - d.seen > 30 * 86400e3; }).length;
  body.innerHTML = '<section class="card-sec"><h2>Site password</h2><p class="dim">Everyone needs this before they see anything. Changing it signs out every other device.</p>' +
    '<div class="grid2"><label class="field"><span>New password</span><input class="input" type="password" data-pw autocomplete="new-password"></label><label class="field"><span>Repeat it</span><input class="input" type="password" data-pw2 autocomplete="new-password"></label></div><button class="btn primary" data-a="pw">Change password</button></section>' +
    '<section class="card-sec"><div class="sec-h"><h2>Signed-in devices <span class="dim num">(' + A.devices.length + ')</span></h2>' + (idle ? '<button class="btn sm" data-a="prune">' + V.icon('logout') + ' Sign out ' + V.plural(idle, 'device') + ' unused for 30+ days</button>' : '') + '</div><ul class="simple">' + A.devices.sort(function (a, b) { return (b.id === A.me) - (a.id === A.me) || b.seen - a.seen; }).map(function (d, i, all) { var p = A.profiles.filter(function (x) { return x.id === d.profile; })[0]; var me = d.id === A.me; return '<li><b>' + V.esc(d.name) + '</b>' + (me ? ' <span class="badge">This device</span>' : '') + ' <span class="dim">· ' + V.esc(d.ip || '') + (me ? '' : ' · last seen ' + V.fmtAgo(d.seen)) + (p ? ' · ' + V.esc(p.name) : '') + '</span>' + (me ? '' : ' <button class="btn sm" data-end="' + d.id + '">Sign out</button>') + '</li>' + (i === 19 && all.length > 20 ? '</ul><details class="more-devs"><summary>Show ' + (all.length - 20) + ' more</summary><ul class="simple">' : ''); }).join('') + '</ul>' + (A.devices.length > 20 ? '</details>' : '') + '</section>' +
    '<section class="card-sec"><h2>Addresses this server answers to</h2><p class="dim">IP addresses, localhost and local names (.local/.lan) always work. While the site password is the default, other names (like a domain behind a reverse proxy) must be listed here or in the ALLOWED_HOSTS setting — this blocks “DNS rebinding” attacks.</p><label class="field"><span>Extra host names (one per line)</span><textarea class="input" rows="3" data-hosts>' + V.esc((A.settings.allowedHosts || []).join('\n')) + '</textarea></label><button class="btn" data-a="hosts">Save</button></section>';
  body.onclick = function (e) {
    var b = e.target.closest('[data-a]'), end = e.target.closest('[data-end]');
    if (end) { end.disabled = true; return V.del('/api/admin/devices/' + end.dataset.end).then(function () { V.router.refresh(); }).catch(function (x) { end.disabled = false; V.fail(x); }); }
    if (!b) return;
    if (b.dataset.a === 'prune') return V.api('/api/admin/devices/prune', { body: { days: 30 } }).then(function (r) { V.toast('Signed out ' + V.plural(r.removed, 'device')); V.router.refresh(); }).catch(V.fail);
    if (b.dataset.a === 'pw') {
      var a = V.$('[data-pw]', body).value, c = V.$('[data-pw2]', body).value;
      if (a !== c) return V.toast('The passwords don’t match', { error: true });
      V.api('/api/admin/password', { body: { next: a } }).then(function () { V.toast('Password changed. Other devices were signed out.'); V.router.refresh(); }).catch(V.fail);
    }
    if (b.dataset.a === 'hosts') V.adminSave({ allowedHosts: V.$('[data-hosts]', body).value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean) });
  };
};

V.adminTabs.apps = function (body, A) {
  var base = location.origin + A.status.exportBase;
  body.innerHTML = '<section class="card-sec"><h2>Use the combined list in other apps</h2><p class="dim">VLC, Kodi, TiviMate, Plex and others can use these addresses. They contain a secret key — anyone with them can watch, so keep them private.</p>' +
    '<label class="field"><span>Playlist (M3U)</span><div class="inline"><input class="input" readonly value="' + V.esc(base + '/playlist.m3u') + '"><button class="btn" data-copy="' + V.esc(base + '/playlist.m3u') + '">Copy</button></div></label>' +
    '<label class="field"><span>TV guide (XMLTV)</span><div class="inline"><input class="input" readonly value="' + V.esc(base + '/epg.xml') + '"><button class="btn" data-copy="' + V.esc(base + '/epg.xml') + '">Copy</button></div></label>' +
    '<button class="btn" data-newkey>Make a new key (old addresses stop working)</button></section>' +
    '<section class="card-sec"><h2>Backups</h2><p class="dim">Everything: settings, lists, profiles, history, messages, recommendations (providers’ channel lists are downloaded again after a restore). A backup is made every night and kept in the data folder’s <code>backups</code> folder. Restoring replaces it all and restarts the server (Docker restarts it automatically).</p>' +
    '<label class="field narrow"><span>Nightly backups to keep (0 = none)</span><input class="input" type="number" min="0" max="60" data-bdays value="' + (A.settings.backupDays === undefined ? 7 : A.settings.backupDays) + '"></label>' +
    '<ul class="simple backups"><li class="dim">Loading…</li></ul>' +
    '<div class="btn-row"><button class="btn primary" data-bnow>' + V.icon('plus') + ' Make a backup now</button><a class="btn" href="/api/admin/backup">' + V.icon('download') + ' Download a fresh backup</a><label class="btn">' + V.icon('upload') + ' Restore from a file<input type="file" accept=".gz,.json" data-restore hidden></label></div></section>' +
    '<section class="card-sec"><h2>Updates</h2><div class="upd dim">Loading…</div>' +
    '<p class="dim small">Upload the app’s .zip (the GitHub copy) and it replaces the program files only — your settings (defaults.json, docker-compose.yml) and data are never touched.</p><label class="btn">' + V.icon('upload') + ' Update from a .zip<input type="file" accept=".zip" data-update hidden></label></section>';
  var loadBackups = function () {
    V.api('/api/admin/backups').then(function (r) {
      V.$('.backups', body).innerHTML = r.list.length ? r.list.map(function (b) { return '<li>' + V.icon('archive', 'tiny') + ' <b>' + V.esc(b.name.replace(/^backup-|\.json\.gz$/g, '').replace(/-manual-(\d\d)(\d\d)/, ' (made by hand at $1:$2)')) + '</b> <span class="dim">· ' + V.fmtSize(b.size) + '</span> <a class="btn sm" href="/api/admin/backups/' + encodeURIComponent(b.name) + '">Download</a> <button class="btn sm" data-brestore="' + V.esc(b.name) + '">Restore</button> <button class="icon-btn sm" data-bdel="' + V.esc(b.name) + '" aria-label="Delete">' + V.icon('trash') + '</button></li>'; }).join('') : '<li class="dim">No backups yet — the first nightly one is made after 3 am.</li>';
    }).catch(function (e) { var ul = V.$('.backups', body); if (ul) ul.innerHTML = '<li class="err">' + V.esc(e.message) + '</li>'; }); // (not "Loading…" forever)
  };
  var loadUpdate = function () {
    V.api('/api/admin/update').then(function (u) {
      V.$('.upd', body).innerHTML = '<p>Running version <b>' + V.esc(u.version) + '</b>' + (u.onDisk && u.onDisk !== u.version ? ' · version <b>' + V.esc(u.onDisk) + '</b> is on disk' : '') + ' · started ' + V.fmtAgo(u.started) + '.</p>' +
        (u.pending ? '<p class="note">' + V.icon('refresh') + ' New code found — restarting as soon as nobody is watching through the server.</p>' : u.needsRestart ? '<p class="note warn">' + V.icon('refresh') + ' New server code is on disk. It takes effect when you restart the server' + (u.docker ? ' (<code>docker compose restart</code>)' : '') + '.</p>' : '') +
        '<p class="small">' + (u.autoRestart ? 'New program files dropped into the app folder are picked up automatically: the web app reloads on its own, and the server restarts itself when nobody is watching through it.' : 'New web-app files are picked up automatically. New server files wait until you restart the server — it never restarts on its own.') + '</p>';
    }).catch(function () {});
  };
  loadBackups(); loadUpdate();
  body.onclick = function (e) {
    var c = e.target.closest('[data-copy]'); if (c) V.copy(c.dataset.copy);
    var bn = e.target.closest('[data-bnow]');
    if (bn) { bn.disabled = true; V.api('/api/admin/backups', { method: 'POST' }).then(function () { V.toast('Backup made'); loadBackups(); }).catch(V.fail).then(function () { bn.disabled = false; }); }
    var br = e.target.closest('[data-brestore]');
    if (br) V.confirm('Replace everything on this server with the backup from ' + br.dataset.brestore + '?', { ok: 'Restore', danger: true }).then(function (ok) { return ok ? adminPin('restore this backup') : null; }).then(function (pin) { if (pin) V.api('/api/admin/backups/' + encodeURIComponent(br.dataset.brestore) + '/restore', { method: 'POST', headers: { 'X-Admin-Pin': pin } }).then(function () { V.toast('Restored. The server is restarting…'); setTimeout(function () { location.reload(); }, 6000); }).catch(V.fail); });
    var bd = e.target.closest('[data-bdel]');
    if (bd) V.confirm('Delete the backup ' + bd.dataset.bdel + '?', { ok: 'Delete', danger: true }).then(function (ok) { if (ok) V.del('/api/admin/backups/' + encodeURIComponent(bd.dataset.bdel)).then(loadBackups).catch(V.fail); });
    if (e.target.closest('[data-newkey]')) V.confirm('Make a new key? Apps using the old addresses stop working.', { ok: 'New key', danger: true }).then(function (ok) { if (ok) V.adminSave({ newExportKey: true }).then(function () { V.router.refresh(); }); });
  };
  body.onchange = function (e) {
    // (An emptied field would save 0 = no nightly backups at all.)
    if (e.target.hasAttribute('data-bdays')) { var bdays = V.adminNum(e.target, S.admin.settings.backupDays === undefined ? 7 : S.admin.settings.backupDays); if (bdays !== null) V.adminSave({ backupDays: bdays }).catch(function () {}); return; }
    if (e.target.dataset.update !== undefined) {
      var z = e.target.files[0];
      if (!z) return;
      e.target.value = '';
      adminPin('install this update').then(function (pin) {
      if (!pin) return;
      V.toast('Uploading the update…');
      fetch('/api/admin/update', { method: 'POST', headers: { 'X-App': '1', 'X-Admin-Pin': pin }, body: z, credentials: 'same-origin' }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); V.toast('Updated ' + V.plural(j.files, 'file') + (j.version ? ' to version ' + j.version : '') + (j.restart ? ' — the server restarts when nobody is watching.' : ' — restart the server to finish.'), { ms: 10000 }); loadUpdate(); }); }).catch(V.fail);
      });
      return;
    }
    if (e.target.dataset.restore === undefined) return;
    var f = e.target.files[0];
    if (!f) return;
    V.confirm('Replace everything on this server with “' + f.name + '”?', { ok: 'Restore', danger: true }).then(function (ok) {
      if (!ok) return;
      adminPin('restore this backup').then(function (pin) {
      if (!pin) return;
      fetch('/api/admin/restore', { method: 'POST', headers: { 'X-App': '1', 'X-Admin-Pin': pin }, body: f, credentials: 'same-origin' }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); V.toast('Restored. The server is restarting…'); setTimeout(function () { location.reload(); }, 5000); }); }).catch(V.fail);
      });
    });
  };
};
