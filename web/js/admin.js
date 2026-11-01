/* Admin: lists, guides, profiles, languages, playback, recommendations, brand, security, backup. */
'use strict';
V.route('admin', function (view, r) {
  if (!S.profile.admin) { view.innerHTML = V.empty('Admin only', 'Only the admin profile can open this.'); return; }
  var tab = r.args[0] || 'overview';
  var tabs = [['overview', 'Overview'], ['stats', 'Statistics'], ['lists', 'Lists'], ['guides', 'TV guides'], ['profiles', 'Profiles'], ['content', 'Languages & content'], ['categories', 'Categories'], ['playback', 'Playback'], ['network', 'Network & proxies'], ['recs', 'Recommendations'], ['brand', 'Brand'], ['security', 'Security'], ['apps', 'Backups, updates & apps']];
  view.innerHTML = V.pageHead('Admin') + '<div class="tabs admin-tabs" role="tablist">' + tabs.map(function (t) { return '<a role="tab" class="tab' + (t[0] === tab ? ' on' : '') + '" aria-selected="' + (t[0] === tab) + '" href="#/admin/' + t[0] + '">' + t[1] + '</a>'; }).join('') + '</div><div class="admin-body"><div class="spinner"></div></div>';
  var body = V.$('.admin-body', view);
  V.api('/api/admin').then(function (A) {
    S.admin = A;
    (V.adminTabs[tab] || V.adminTabs.overview)(body, A);
  }).catch(function (e) { body.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
});

V.adminSave = function (patch, msg) {
  return V.put('/api/admin/settings', patch).then(function (s) { S.admin.settings = s; V.toast(msg || 'Saved'); return s; }).catch(function (e) { V.fail(e); throw e; });
};

V.adminTabs = {};

V.adminTabs.overview = function (body, A) {
  var st = A.status;
  var pname = function (id) { var p = A.profiles.filter(function (x) { return x.id === id; })[0]; return p ? p.name : '?'; };
  var xt = A.lists.filter(function (l) { return l.type === 'xtream' && l.account; });
  body.innerHTML = (st.alerts || []).map(function (a) { return '<div class="note warn">' + V.icon('bell') + ' ' + (a.kind === 'expiry' ? '<b>' + V.esc(a.list) + '</b> ' + (a.days < 0 ? 'has expired.' : a.days === 0 ? 'expires today.' : 'expires in ' + V.plural(a.days, 'day') + '.') : '<b>' + V.esc(a.list) + '</b>: the provider says the account is “' + V.esc(a.status) + '”.') + '</div>'; }).join('') +
    (st.defaultPassword ? '<div class="note warn">' + V.icon('shield') + ' The site password is still the default. <a href="#/admin/security">Change it</a>.</div>' : '') +
    (!st.ffmpeg ? '<div class="note warn">' + V.icon('info') + ' ffmpeg isn’t installed, so MKV/AVI/HEVC/RTMP etc. can’t be converted and downloads can’t be converted to MP4. The Docker image includes it.</div>' : '') +
    (!A.lists.length ? '<div class="note">' + V.icon('info') + ' No lists yet. <a href="#/admin/lists">Add your first playlist</a> — everyone sees it right away.</div>' : '') +
    '<div class="stats">' + [['Channels', st.catalog.counts.live || 0], ['Movies', st.catalog.counts.movie || 0], ['Series', st.catalog.counts.show || 0], ['Episodes', st.catalog.counts.episode || 0], ['Radio', st.catalog.counts.radio || 0], ['Guide programmes', st.epg.programmes || 0], ['Profiles', A.profiles.length], ['Signed-in devices', A.devices.length]].map(function (x) { return '<div class="stat"><b class="num">' + Number(x[1]).toLocaleString() + '</b><span>' + x[0] + '</span></div>'; }).join('') + '</div>' +
    (xt.length ? '<section class="card-sec"><div class="sec-h"><h2>Provider accounts</h2><button class="btn sm" data-acct>' + V.icon('refresh') + ' Check now</button></div><ul class="simple">' + xt.map(function (l) { return '<li>' + V.adminAccountLine(l) + '</li>'; }).join('') + '</ul></section>' : '') +
    '<section class="card-sec"><h2>Watching now</h2>' + (A.watching.length ? '<ul class="simple">' + A.watching.map(function (w) { return '<li><b>' + V.esc(pname(w.pid)) + '</b> · ' + V.esc(w.n) + ' <span class="dim">on ' + V.esc(w.device) + ' · ' + V.fmtAgo(w.at) + '</span></li>'; }).join('') + '</ul>' : '<p class="dim">Nobody is watching right now.</p>') + '</section>' +
    '<section class="card-sec"><h2>Server conversions</h2>' + (st.sessions.length ? '<ul class="simple">' + st.sessions.map(function (s) { return '<li>' + V.esc(s.label) + ' <span class="dim">· ' + (s.transcode ? 'transcoding' + (s.hw ? ' (' + s.hw + ')' : '') + (s.height ? ' ' + s.height + 'p' : '') : 'remuxing') + ' · ' + V.esc(pname(s.owner)) + ' · ' + V.fmtAgo(s.startedAt) + '</span> <button class="btn sm" data-stop="' + s.id + '">Stop</button></li>'; }).join('') + '</ul>' : '<p class="dim">None running.</p>') + '</section>' +
    '<section class="card-sec"><h2>Server</h2><dl class="kv"><dt>Version</dt><dd>' + V.esc(st.version) + '</dd><dt>ffmpeg</dt><dd>' + (st.ffmpeg ? V.esc(st.ffmpegVersion) + (st.hw ? ' · hardware: ' + st.hw : '') : 'not found') + '</dd><dt>Intro detection</dt><dd>' + (st.intro ? 'available' : 'unavailable') + '</dd><dt>TMDB</dt><dd>' + (st.tmdb.enabled ? 'on · ' + st.tmdb.matched + ' titles matched' + (st.tmdb.error ? ' · ' + V.esc(st.tmdb.error) : '') : 'off') + '</dd><dt>Data folder</dt><dd><code>' + V.esc(st.dataDir) + '</code></dd><dt>Listening on</dt><dd>' + V.esc(st.listen) + '</dd><dt>System</dt><dd>' + V.esc(st.platform + ' · Node ' + st.node) + '</dd><dt>Up for</dt><dd>' + V.fmtLen(st.uptime) + '</dd></dl></section>';
  body.onclick = function (e) {
    var b = e.target.closest('[data-stop]'); if (b) V.del('/api/admin/sessions/' + b.dataset.stop).then(function () { V.router.refresh(); });
    var c = e.target.closest('[data-acct]'); if (c) { c.disabled = true; V.api('/api/admin/accounts/check', { method: 'POST' }).then(function () { V.router.refresh(); }).catch(V.fail); }
  };
};
/** "EVESTV · active · expires 30 Oct 2027 (364 days) · 1 connection · in use by Mom (Living Room TV)" */
V.adminAccountLine = function (l) {
  var a = l.account || {};
  var days = a.expires ? Math.floor((a.expires - Date.now()) / 86400e3) : null;
  var use = l.inUse || [];
  return '<b>' + V.esc(l.name) + '</b> <span class="dim">· ' + V.esc(a.status || '?') + (a.expires ? ' · expires ' + new Date(a.expires).toLocaleDateString() + ' (<span class="' + (days <= 14 ? 'err' : '') + '">' + (days < 0 ? 'expired' : V.plural(days, 'day')) + '</span>)' : '') +
    (a.maxConnections ? ' · ' + V.plural(+a.maxConnections, 'connection') + ' allowed' : '') + (a.activeConnections !== undefined && a.activeConnections !== '' ? ' · provider says ' + a.activeConnections + ' in use' : '') + '</span>' +
    (use.length ? '<div class="small">In use by ' + use.map(function (u) { return V.esc(u.name) + ' (' + V.esc(u.device) + ': ' + V.esc(u.n) + ')'; }).join(', ') + '</div>' : '') + (a.checkedAt ? '<div class="dim small">Checked ' + V.fmtAgo(a.checkedAt) + '</div>' : '');
};

V.adminTabs.lists = function (body, A) {
  var draw = function () {
    body.innerHTML = '<div class="page-tools"><button class="btn primary" data-add>' + V.icon('plus') + ' Add a list</button><span class="dim">Lists are merged into one catalogue for everyone, with duplicates combined (other copies become backup streams). Order matters: the first list wins when the same channel is in several.</span></div>' +
      (A.lists.length ? '<ul class="adm-list">' + A.lists.map(function (l, i) {
        var s = l.status || {};
        var px = l.proxy === 'none' ? 'no proxy' : l.proxy ? ((A.settings.proxies || []).filter(function (x) { return x.id === l.proxy; })[0] || {}).name : '';
        var info = (l.type === 'xtream' ? (l.account ? V.adminAccountLine(l) : '') : l.type === 'folder' ? V.esc((l.folders || []).join(', ')) : l.type === 'url' ? V.esc(l.url) : 'Uploaded file') + (px ? '<div>' + V.icon('globe', 'tiny') + ' Proxy: ' + V.esc(px) + '</div>' : '');
        return '<li class="' + (l.enabled ? '' : 'off') + '" data-id="' + l.id + '"><div class="al-h"><span class="al-type">' + ({ url: 'Playlist', file: 'File', xtream: 'Xtream', folder: 'Folder' }[l.type]) + '</span><b>' + V.esc(l.name) + '</b>' + (s.format ? '<span class="chip sm">' + V.esc(s.format) + '</span>' : '') + '<span class="sp"></span>' +
          '<button class="icon-btn" data-up aria-label="Move up"' + (i ? '' : ' disabled') + '>' + V.icon('up') + '</button><button class="icon-btn" data-down aria-label="Move down"' + (i < A.lists.length - 1 ? '' : ' disabled') + '>' + V.icon('down') + '</button>' +
          '<label class="switch sm"><input type="checkbox" data-en' + (l.enabled ? ' checked' : '') + '><span class="sw"></span><span class="sr-only">Enabled</span></label><button class="icon-btn" data-ref aria-label="Refresh now">' + V.icon('refresh') + '</button><button class="icon-btn" data-edit aria-label="Edit">' + V.icon('edit') + '</button><button class="icon-btn" data-del aria-label="Delete">' + V.icon('trash') + '</button></div>' +
          '<div class="al-b dim small">' + info + '</div><div class="al-s small">' + (l.refreshing ? '<span class="spinner sm"></span> Refreshing…' : s.ok ? V.icon('check', 'tiny ok') + ' ' + V.plural(s.count || 0, 'item') + ' · updated ' + V.fmtAgo(s.at) : s.error ? '<span class="err">' + V.icon('x', 'tiny') + ' ' + V.esc(s.error) + '</span>' + (s.count ? ' <span class="dim">(using the saved copy)</span>' : '') : '') +
          (l.refreshHours ? ' · every ' + l.refreshHours + ' h' : ' · no automatic refresh') + (l.lang ? ' · language forced: ' + V.esc(V.langName(l.lang)) : '') + '</div></li>';
      }).join('') + '</ul>' : V.empty('No lists yet', 'Add an M3U/M3U8 playlist (any format: PLS, XSPF, JSON…), an Xtream Codes account, an uploaded file, or a folder of your own videos on the server.'));
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
    if (b.hasAttribute('data-ref')) { b.disabled = true; V.api('/api/admin/lists/' + id + '/refresh', { method: 'POST' }).then(function () { V.toast('Refreshed'); reload(); }).catch(function (x) { V.fail(x); reload(); }); }
    else if (b.hasAttribute('data-del')) V.confirm('Remove “' + l.name + '”? Its channels and videos disappear for everyone.', { ok: 'Remove', danger: true }).then(function (ok) { if (ok) V.del('/api/admin/lists/' + id).then(reload); });
    else if (b.hasAttribute('data-edit')) V.editListDialog(l).then(function (ok) { if (ok) reload(); });
    else if (b.hasAttribute('data-up') || b.hasAttribute('data-down')) {
      var ids = A.lists.map(function (x) { return x.id; });
      var i = ids.indexOf(id), j = b.hasAttribute('data-up') ? i - 1 : i + 1;
      ids.splice(j, 0, ids.splice(i, 1)[0]);
      V.api('/api/admin/lists-order', { body: { ids: ids } }).then(reload);
    }
  };
  body.onchange = function (e) { if (e.target.hasAttribute('data-en')) { var id = e.target.closest('[data-id]').dataset.id; V.put('/api/admin/lists/' + id, { enabled: e.target.checked }).then(reload).catch(V.fail); } };
  var t = setInterval(function () { if (A.lists.some(function (l) { return l.refreshing; })) reload(); }, 4000);
  V.pageCleanup = function () { clearInterval(t); };
};

V.langSelect = function (cur) { return '<select class="input" name="lang"><option value="">Detect automatically</option>' + (S.boot.languages || []).map(function (l) { return '<option value="' + l.code + '"' + (l.code === cur ? ' selected' : '') + '>' + V.esc(l.name) + '</option>'; }).join('') + '</select>'; };

V.addListDialog = function () {
  return V.dialog({
    title: 'Add a list', wide: true,
    body: '<div class="tabs" role="tablist">' + [['url', 'Web address'], ['xtream', 'Xtream Codes'], ['file', 'Upload a file'], ['folder', 'Folder on the server']].map(function (t, i) { return '<button class="tab' + (i ? '' : ' on') + '" data-m="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>' +
      '<form class="list-form">' +
      '<div data-pane="url"><label class="field"><span>Playlist address</span><input class="input" name="url" placeholder="https://provider.example/playlist.m3u" autocomplete="off"></label><p class="dim small">M3U/M3U8 (extended or plain), PLS, XSPF, ASX, JSON or a plain list of addresses — the format is detected automatically. Guides named in the playlist (url-tvg) are added too.</p></div>' +
      '<div data-pane="xtream" hidden><label class="field"><span>Server</span><input class="input" name="server" placeholder="http://provider.example:8080" autocomplete="off"><small class="dim">You can paste a full get.php or player_api.php link; the username and password are read from it.</small></label><div class="grid2"><label class="field"><span>Username</span><input class="input" name="username" autocomplete="off"></label><label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="off"></label></div></div>' +
      '<div data-pane="file" hidden><label class="field"><span>Playlist file</span><input class="input" type="file" name="file" accept=".m3u,.m3u8,.txt,.pls,.xspf,.asx,.wpl,.json,.gz"></label></div>' +
      '<div data-pane="folder" hidden><label class="field"><span>Folder (on the server)</span><div class="inline"><input class="input" name="folder" placeholder="/media/movies"><button type="button" class="btn" data-browse>Browse…</button></div><small class="dim">Movies, shows (Show/Season 1/Show S01E02.mkv) and music. Files are played in place; anything a browser can’t play is converted. In Docker, mount the folder into the container first.</small></label></div>' +
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
      '<div class="grid2"><label class="field"><span>Language of everything in it</span>' + V.langSelect(l.lang) + '</label><label class="field"><span>Refresh every (hours, 0 = never)</span><input class="input" name="refreshHours" type="number" min="0" max="168" value="' + l.refreshHours + '"></label></div>' +
      (l.type !== 'folder' ? '<label class="field"><span>User-Agent (optional)</span><input class="input" name="ua" value="' + V.esc(l.ua || '') + '"></label><label class="check"><input type="checkbox" name="useGuide"' + (l.useGuide !== false ? ' checked' : '') + '><span>Use the TV guide this list points to</span></label>' +
        '<label class="field"><span>Proxy for this list</span><select class="input" name="proxy"><option value="">The default (' + V.esc(((S.admin.settings.proxies || []).filter(function (x) { return x.id === S.admin.settings.proxy; })[0] || { name: 'none' }).name) + ')</option><option value="none"' + (l.proxy === 'none' ? ' selected' : '') + '>No proxy</option>' + (S.admin.settings.proxies || []).map(function (x) { return '<option value="' + x.id + '"' + (l.proxy === x.id ? ' selected' : '') + '>' + V.esc(x.name) + '</option>'; }).join('') + '</select><small class="dim">Set up proxies in Admin → Network & proxies.</small></label>' : '') + '</form>',
    actions: [{ label: 'Cancel', value: false }, { label: 'Save', primary: true, fn: function (d) {
      var fd = new FormData(V.$('form', d));
      var patch = {};
      ['name', 'url', 'server', 'username', 'password', 'ua', 'lang', 'refreshHours', 'proxy'].forEach(function (k) { if (fd.has(k)) patch[k] = fd.get(k); });
      if (patch.proxy === (l.proxy || '')) delete patch.proxy;
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
  body.innerHTML = '<div class="page-tools"><button class="btn primary" data-add>' + V.icon('plus') + ' Add a guide (XMLTV)</button><span class="dim">Guides named by your lists are added automatically. Channels are matched by tvg-id, then by name.</span></div>' +
    '<div class="grid2 small-grid"><label class="field"><span>Days of listings to keep ahead</span><input class="input" type="number" min="1" max="21" data-s="epgDays" value="' + A.settings.epgDays + '"></label><label class="field"><span>Days to keep in the past (for catch-up)</span><input class="input" type="number" min="0" max="14" data-s="epgPastDays" value="' + A.settings.epgPastDays + '"></label><label class="field"><span>Refresh every (hours)</span><input class="input" type="number" min="1" max="168" data-s="epgRefreshHours" value="' + A.settings.epgRefreshHours + '"></label></div>' +
    (A.guides.length ? '<ul class="adm-list">' + A.guides.map(function (g) { var s = g.status || {}; return '<li class="' + (g.enabled ? '' : 'off') + '" data-id="' + g.id + '"><div class="al-h"><b>' + V.esc(g.name) + '</b>' + (g.auto ? '<span class="chip sm">from a list</span>' : '') + '<span class="sp"></span><label class="switch sm"><input type="checkbox" data-en' + (g.enabled ? ' checked' : '') + '><span class="sw"></span></label><button class="icon-btn" data-ref aria-label="Refresh">' + V.icon('refresh') + '</button>' + (g.auto ? '' : '<button class="icon-btn" data-del aria-label="Delete">' + V.icon('trash') + '</button>') + '</div><div class="al-b dim small">' + V.esc(g.url.replace(/(password=)[^&]+/, '$1•••')) + '</div><div class="al-s small">' + (s.ok ? V.icon('check', 'tiny ok') + ' ' + (s.channels || 0) + ' channels · ' + (s.programmes || 0).toLocaleString() + ' programmes · ' + V.fmtAgo(s.at) : s.error ? '<span class="err">' + V.esc(s.error) + '</span>' : 'Not loaded yet') + '</div></li>'; }).join('') + '</ul>' : V.empty('No guides', 'Add an XMLTV address (.xml or .xml.gz).'));
  body.onchange = function (e) {
    if (e.target.dataset.s) { var p = {}; p[e.target.dataset.s] = +e.target.value; V.adminSave(p); }
    if (e.target.hasAttribute('data-en')) V.put('/api/admin/guides/' + e.target.closest('[data-id]').dataset.id, { enabled: e.target.checked }).then(function () { V.router.refresh(); });
  };
  body.onclick = function (e) {
    if (e.target.closest('[data-add]')) return V.prompt('Guide address (XMLTV)', { placeholder: 'https://…/guide.xml.gz' }).then(function (u) { if (u) { V.toast('Loading the guide…'); V.api('/api/admin/guides', { body: { url: u } }).then(function (g) { V.toast(g.status && g.status.ok ? 'Guide loaded' : 'Guide added, but: ' + ((g.status && g.status.error) || 'not loaded')); V.router.refresh(); }).catch(V.fail); } });
    var li = e.target.closest('[data-id]');
    if (!li) return;
    if (e.target.closest('[data-ref]')) { V.toast('Refreshing…'); V.api('/api/admin/guides/' + li.dataset.id + '/refresh', { method: 'POST' }).then(function () { V.router.refresh(); }).catch(V.fail); }
    if (e.target.closest('[data-del]')) V.del('/api/admin/guides/' + li.dataset.id).then(function () { V.router.refresh(); });
  };
};

V.adminTabs.profiles = function (body, A) {
  var certs = [['', 'No limit'], ['0', 'Little kids (G, TV-Y)'], ['1', 'Kids (PG, TV-PG)'], ['2', 'Teens (PG-13, TV-14)'], ['3', 'Mature (R, TV-MA)']];
  body.innerHTML = '<div class="page-tools"><button class="btn primary" data-add>' + V.icon('plus') + ' Add a profile</button><label class="check"><input type="checkbox" data-aop' + (A.settings.adminOnlyProfiles ? ' checked' : '') + '><span>Only the admin can add profiles</span></label></div>' +
    '<ul class="adm-profiles">' + A.profiles.map(function (p) {
      var r = p.restrictions || {};
      return '<li data-id="' + p.id + '"><div class="ap-h">' + V.avatar(p.avatar, 'lg') + '<div><b>' + V.esc(p.name) + '</b>' + (p.admin ? ' <span class="chip sm">Admin</span>' : '') + (p.kids ? ' <span class="chip sm">Kids</span>' : '') + (p.online ? ' <span class="chip sm ok">online</span>' : '') +
        '<div class="dim small">' + (p.hasPin ? 'PIN set' : 'No PIN') + ' · languages: ' + (p.langs ? p.langs.map(V.langName).join(', ') || 'none' : 'default') + ' · last used ' + V.fmtAgo(p.lastUsedAt) + '</div></div></div>' +
        (p.admin ? '' : '<div class="ap-limits grid2"><label class="field"><span>Age limit</span><select class="input" data-r="maxCert">' + certs.map(function (c) { return '<option value="' + c[0] + '"' + (String(r.maxCert) === c[0] ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('') + '</select></label>' +
          '<div class="field"><span>Can watch</span><div class="chips">' + [['live', 'Live TV'], ['movie', 'Movies'], ['show', 'Series'], ['radio', 'Radio']].map(function (t) { var on = !r.types || !r.types.length || r.types.indexOf(t[0]) >= 0; return '<label class="chip-check"><input type="checkbox" data-type="' + t[0] + '"' + (on ? ' checked' : '') + '><span>' + t[1] + '</span></label>'; }).join('') + '</div></div>' +
          '<label class="check"><input type="checkbox" data-r="kids"' + (p.kids ? ' checked' : '') + '><span>Kids profile (only kids’ titles and channels)</span></label><label class="check"><input type="checkbox" data-r="adult"' + (r.adult ? ' checked' : '') + '><span>Allow adult (18+) groups</span></label>' +
          '<label class="field wide"><span>Blocked categories (one per line)</span><textarea class="input" rows="2" data-r="blockedGroups">' + V.esc((r.blockedGroups || []).join('\n')) + '</textarea></label></div>') +
        '<div class="btn-row">' + (p.admin ? '' : '<button class="btn sm primary" data-save>Save limits</button>') + '<button class="btn sm" data-pin>' + (p.hasPin ? 'Reset PIN' : 'Set a PIN') + '</button>' + (p.admin ? '' : '<button class="btn sm" data-make>Make admin</button><button class="btn sm danger" data-del>Delete</button>') + '</div></li>';
    }).join('') + '</ul>';
  body.onchange = function (e) { if (e.target.hasAttribute('data-aop')) V.adminSave({ adminOnlyProfiles: e.target.checked }); };
  body.onclick = function (e) {
    if (e.target.closest('[data-add]')) { S.boot.firstRun = false; return V.addProfileDialog(); }
    var li = e.target.closest('[data-id]');
    if (!li) return;
    var id = li.dataset.id, p = A.profiles.filter(function (x) { return x.id === id; })[0];
    if (e.target.closest('[data-save]')) {
      var types = V.$$('[data-type]', li).filter(function (x) { return x.checked; }).map(function (x) { return x.dataset.type; });
      V.put('/api/admin/profiles/' + id, { kids: V.$('[data-r=kids]', li).checked, restrictions: { maxCert: V.$('[data-r=maxCert]', li).value, types: types.length === 4 ? [] : types, adult: V.$('[data-r=adult]', li).checked, blockedGroups: V.$('[data-r=blockedGroups]', li).value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean) } }).then(function () { V.toast('Saved'); }).catch(V.fail);
    } else if (e.target.closest('[data-pin]')) V.prompt('New PIN for ' + p.name + ' (4–8 digits' + (p.admin ? '' : ', empty to remove') + ')', { type: 'password' }).then(function (pin) { if (pin === null) return; V.put('/api/admin/profiles/' + id, { pin: pin }).then(function () { V.toast('Saved'); V.router.refresh(); }).catch(V.fail); });
    else if (e.target.closest('[data-make]')) V.confirm('Make ' + p.name + ' the admin? You’ll stop being the admin. (There’s only ever one.)', { ok: 'Make admin', danger: true }).then(function (ok) { if (ok) V.api('/api/admin/profiles/' + id + '/make-admin', { method: 'POST' }).then(function () { location.reload(); }).catch(V.fail); });
    else if (e.target.closest('[data-del]')) V.confirm('Delete ' + p.name + '? Their history, lists and messages are removed.', { ok: 'Delete', danger: true }).then(function (ok) { if (ok) V.del('/api/admin/profiles/' + id).then(function () { V.router.refresh(); }).catch(V.fail); });
  };
};

V.adminTabs.content = function (body, A) {
  var s = A.settings;
  body.innerHTML = '<section class="card-sec"><h2>Default languages</h2><p class="dim">Profiles see only these languages unless they choose their own. Leave all unticked to show everything.</p><div class="lang-pick">' + V.langChecks(s.defaultLangs) + '</div>' +
    '<label class="check"><input type="checkbox" data-unknown' + (s.showUnknownLang ? ' checked' : '') + '><span>Show things whose language can’t be worked out</span></label><button class="btn primary" data-save-l>Save languages</button><div class="lang-stats dim small"></div></section>' +
    '<section class="card-sec"><h2>Hidden categories</h2><p class="dim">Hidden for everyone (the admin too). Tick to hide.</p><input class="input" type="search" data-gf placeholder="Filter categories"><div class="groups-adm"><div class="spinner"></div></div><button class="btn primary" data-save-g>Save hidden categories</button></section>';
  V.api('/api/admin/groups').then(function (g) {
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
  });
  V.$('[data-save-l]', body).onclick = function () { V.adminSave({ defaultLangs: V.$$('.lang-pick input:checked', body).map(function (x) { return x.value; }), showUnknownLang: V.$('[data-unknown]', body).checked }, 'Saved — everyone using the default sees the change'); };
};

V.adminTabs.playback = function (body, A) {
  var s = A.settings, st = A.status;
  var opt = function (cur, list) { return list.map(function (o) { return '<option value="' + o[0] + '"' + (String(cur) === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>'; }).join(''); };
  body.innerHTML = '<section class="card-sec"><h2>How streams reach the viewer</h2>' +
    '<label class="check"><input type="radio" name="routing" value="direct-first"' + (s.routing === 'direct-first' ? ' checked' : '') + '><span><b>Direct first</b> — each device connects straight to the provider. When a provider blocks web players (CORS), the browser’s built-in player or the provider’s own HLS copy is used, or only the playlist text comes through here while the video still goes direct. A stream goes fully through this server only when nothing else works (or it needs special headers or converting). Desktop browsers can add the <i>direct-streams helper</i> (Settings) to make every stream direct.</span></label>' +
    '<label class="check"><input type="radio" name="routing" value="server"' + (s.routing === 'server' ? ' checked' : '') + '><span><b>Always through this server</b> — most compatible; the provider sees one address.</span></label>' +
    '<label class="check"><input type="radio" name="routing" value="direct-only"' + (s.routing === 'direct-only' ? ' checked' : '') + '><span><b>Direct only</b> — never send video through this server. Streams that can’t be reached directly won’t play (unless the viewer has the direct-streams helper).</span></label>' +
    '<label class="field"><span>User-Agent sent to providers</span><input class="input" data-s="userAgent" value="' + V.esc(s.userAgent) + '"></label></section>' +
    '<section class="card-sec"><h2>Conversion (ffmpeg)</h2>' + (st.ffmpeg ? '' : '<p class="note warn">ffmpeg isn’t installed.</p>') +
    '<div class="grid2"><label class="field"><span>Hardware encoder</span><select class="input" data-s="hwaccel">' + opt(s.hwaccel, [['', 'None (software)'], ['vaapi', 'Intel/AMD (VAAPI)'], ['qsv', 'Intel Quick Sync'], ['nvenc', 'NVIDIA (NVENC)'], ['videotoolbox', 'Apple (VideoToolbox)']]) + '</select><small class="dim">Available: ' + (st.encoders.length ? st.encoders.join(', ') : 'none detected') + '. Falls back to software if it fails.</small></label>' +
    '<label class="field"><span>Software speed</span><select class="input" data-s="transcodePreset">' + opt(s.transcodePreset, [['ultrafast', 'Fastest (bigger)'], ['superfast', 'Very fast'], ['veryfast', 'Fast (recommended)'], ['faster', 'Balanced'], ['fast', 'Better quality'], ['medium', 'Best quality (slow)']]) + '</select></label>' +
    '<label class="field"><span>Highest resolution when converting</span><select class="input" data-s="transcodeMaxHeight">' + opt(s.transcodeMaxHeight, [[2160, '4K'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [480, '480p']]) + '</select></label>' +
    '<label class="field"><span>Quality (CRF, lower = better)</span><input class="input" type="number" min="16" max="35" data-s="transcodeCrf" value="' + s.transcodeCrf + '"></label>' +
    '<label class="field"><span>Most conversions at once (0 = no limit)</span><input class="input" type="number" min="0" max="32" data-s="maxTranscodes" value="' + s.maxTranscodes + '"></label>' +
    '<label class="field"><span>Most server streams at once</span><input class="input" type="number" min="1" max="64" data-s="maxSessions" value="' + s.maxSessions + '"></label></div></section>' +
    '<section class="card-sec"><h2>Features</h2>' + [['allowDownloads', 'Allow downloads for offline viewing'], ['allowParties', 'Allow watch parties'], ['introDetection', 'Detect intros and end credits automatically (compares episodes’ audio on the server)']].map(function (x) { return '<label class="switch"><input type="checkbox" data-b="' + x[0] + '"' + (s[x[0]] ? ' checked' : '') + '><span class="sw"></span><span>' + x[1] + '</span></label>'; }).join('') + '</section>';
  body.onchange = function (e) {
    var t = e.target, p = {};
    if (t.name === 'routing') p.routing = t.value;
    else if (t.dataset.s) p[t.dataset.s] = t.type === 'number' || t.dataset.s === 'transcodeMaxHeight' ? +t.value : t.value;
    else if (t.dataset.b) p[t.dataset.b] = t.checked;
    else return;
    V.adminSave(p).then(function () { if (p.routing || t.dataset.b) S.settings = Object.assign(S.settings, { routing: p.routing || S.settings.routing }); });
  };
};

V.adminTabs.recs = function (body, A) {
  var s = A.settings;
  body.innerHTML = '<section class="card-sec"><h2>The Movie Database (TMDB)</h2><p class="dim small">Data and images from ' + V.TMDB_LOGO + '. This product uses the TMDB API but is not endorsed or certified by TMDB.</p><p>With a free TMDB key, recommendations use TMDB’s “people who liked this also liked…” lists for everything each profile watches, blended with what they’ve watched here. TMDB also fills in posters, plots, cast, genres and age ratings for titles your lists don’t describe. (IMDb has no public API, so TMDB is used instead.)</p>' +
    '<ol class="small dim"><li>Create a free account at themoviedb.org.</li><li>Settings → API → request an API key (choose “Developer”, any app name).</li><li>Paste the “API Key” or “API Read Access Token” below.</li></ol>' +
    '<label class="field"><span>TMDB key</span><div class="inline"><input class="input" data-key value="' + V.esc(s.tmdbKey || '') + '" placeholder="Paste the key"><button class="btn" data-save>Save</button><button class="btn" data-test>Test</button></div></label>' +
    '<p class="dim small">Status: ' + (A.status.tmdb.enabled ? 'on · ' + A.status.tmdb.matched + ' titles have details' + (A.status.tmdb.error ? ' · <span class="err">' + V.esc(A.status.tmdb.error) + '</span>' : '') : 'off') + '</p>' +
    '<div class="tmdb-fetch"></div></section>' +
    '<section class="card-sec"><h2>How recommendations work</h2><p class="dim">Each profile’s picks are worked out on the server and saved on disk. They use what the profile watched (more weight for finished and recent things), thumbs up/down, My List and chosen interests; TMDB’s related titles; actors and directors you keep watching; titles several of your favourites point to; and what others in the household watch. Titles that keep being shown without being opened make way for new ones, and rows are re-ranked for variety.</p></section>';
  body.onclick = function (e) {
    if (e.target.closest('[data-save]')) V.adminSave({ tmdbKey: V.$('[data-key]', body).value }).then(function () { V.router.refresh(); });
    if (e.target.closest('[data-test]')) V.api('/api/admin/tmdb/test', { method: 'POST' }).then(function (j) { V.toast(j.ok ? 'TMDB works' : 'TMDB: ' + j.error, { error: !j.ok }); });
  };
  if (A.status.tmdb.enabled) V.tmdbFetchPanel(V.$('.tmdb-fetch', body));
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
        return '<label class="check"><input type="checkbox" value="' + V.esc(g.id) + '"' + (picked.has(g.id) ? ' checked' : '') + '><span>' + V.esc(g.name) + ' <small class="dim">' + (g.t === 'show' ? 'series' : 'movies') + ' · ' + g.fetched + '/' + g.total + '</small><span class="mini-bar"><i style="width:' + (g.total ? g.fetched / g.total * 100 : 0) + '%"></i></span></span></label>';
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
          '<label class="check"><input type="checkbox" data-k="video"' + (x.video ? ' checked' : '') + '><span>Video too: viewers’ streams from lists using this proxy always go through the server (and so through the proxy) instead of straight from the provider</span></label>' +
          '<div class="btn-row"><button class="btn sm" data-test>Test</button><button class="btn sm danger" data-rm>Remove</button><span class="dim small" data-res></span></div></li>';
      }).join('') : '<li class="dim">No proxies.</li>') + '</ul>' +
      '<div class="btn-row"><button class="btn" data-add>' + V.icon('plus') + ' Add a proxy</button></div>' +
      '<label class="field"><span>Default for everything</span><select class="input" data-def><option value="">No proxy</option>' + proxies.filter(function (x) { return x.id; }).map(function (x) { return '<option value="' + x.id + '"' + (st.proxy === x.id ? ' selected' : '') + '>' + V.esc(x.name) + '</option>'; }).join('') + '</select></label>' +
      '<button class="btn primary" data-save-p>Save proxies</button></section>' +
      '<section class="card-sec"><h2>Direct playback from an https address</h2><p class="dim">Browsers won’t play a plain-http stream on a secure (https) page, so streams from http-only providers have to go through the server when people use your https address. Give this server’s plain-http address here (your home network address, e.g. <code>http://192.168.1.20:' + (location.port || 8080) + '</code>, or a public one) and those devices can switch to it and play straight from the provider. They stay signed in.</p>' +
      '<p class="dim small">Note: on plain http, what the app sends isn’t encrypted. A home-network address keeps that inside your home (and then the switch only works at home).</p>' +
      '<label class="field"><span>Direct (http) address</span><div class="inline"><input class="input" data-direct value="' + V.esc(st.directAddress || '') + '" placeholder="http://192.168.1.20:8080">' + (st.directAddress ? '<a class="btn" target="_blank" rel="noopener" href="' + V.esc(st.directAddress) + '">Test</a>' : '') + '</div></label>' +
      '<label class="field"><span>When a stream needs it</span><select class="input" data-dmode>' + [['ask', 'Ask the viewer (they can remember the choice per device)'], ['auto', 'Switch automatically'], ['off', 'Never switch (play through the server)']].map(function (o) { return '<option value="' + o[0] + '"' + ((st.directSwitch || 'ask') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
      '<button class="btn primary" data-save-d>Save</button></section>';
  };
  draw();
  var collect = function () { V.$$('.proxies [data-i]', body).forEach(function (li) { var x = proxies[+li.dataset.i]; x.name = V.$('[data-k=name]', li).value; x.url = V.$('[data-k=url]', li).value.trim(); x.video = V.$('[data-k=video]', li).checked; }); };
  body.onclick = function (e) {
    var li = e.target.closest('[data-i]');
    if (e.target.closest('[data-add]')) { collect(); proxies.push({ name: 'Proxy ' + (proxies.length + 1), url: '', video: false }); draw(); }
    else if (li && e.target.closest('[data-rm]')) { collect(); proxies.splice(+li.dataset.i, 1); draw(); }
    else if (li && e.target.closest('[data-test]')) {
      collect();
      var x = proxies[+li.dataset.i], res = V.$('[data-res]', li);
      res.textContent = 'Testing…';
      V.api('/api/admin/proxy/test', { body: { url: x.url, id: x.id } }).then(function (r) { res.innerHTML = r.ok ? V.icon('check', 'tiny ok') + ' Works · ' + r.ms + ' ms' + (r.ip ? ' · the internet sees ' + V.esc(r.ip) : '') : '<span class="err">' + V.esc(r.error || 'HTTP ' + r.status) + '</span>'; });
    } else if (e.target.closest('[data-save-p]')) { collect(); V.adminSave({ proxies: proxies, proxy: V.$('[data-def]', body).value }, 'Saved — lists using a changed proxy refresh').then(function (r) { proxies = r.proxies.map(function (x) { return Object.assign({}, x); }); st = r; draw(); }); }
    else if (e.target.closest('[data-save-d]')) V.adminSave({ directAddress: V.$('[data-direct]', body).value.trim(), directSwitch: V.$('[data-dmode]', body).value }).then(function (r) { st = r; S.settings.directAddress = r.directAddress; S.settings.directSwitch = r.directSwitch; draw(); });
  };
};

V.adminTabs.categories = function (body, A) {
  var st = A.settings;
  var rules = (st.groupRules || []).map(function (r) { return Object.assign({}, r); });
  var groups = [];
  var draw = function () {
    body.innerHTML = '<section class="card-sec"><h2>Tidy category names</h2><label class="switch"><input type="checkbox" data-tidy' + (st.tidyGroups !== false ? ' checked' : '') + '><span class="sw"></span><span>Clean up providers’ category names: “|NA| USA ESPN+” → “ESPN+”, “VOD - NETFLIX” → “Netflix”, “TV ᴿᴬᵂ ⁶⁰ᶠᵖˢ” → “TV”, ALL CAPITALS → Title Case. Categories that end up with the same name are merged.</span></label></section>' +
      '<section class="card-sec"><h2>Your rules</h2><p class="dim">Rename, merge or hide categories. <code>*</code> matches anything (<code>Netflix*</code>, <code>*PPV*</code>). The first rule that matches wins. Rename several to the same name to merge them.</p>' +
      '<table class="rules"><thead><tr><th>Category</th><th>Becomes</th><th>Hide</th><th>Only for</th><th></th></tr></thead><tbody>' + rules.map(function (r, i) {
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
  V.api('/api/admin/groups').then(function (g) { groups = g.groups; draw(); });
  draw();
  body.onclick = function (e) {
    var tr = e.target.closest('[data-i]');
    if (e.target.closest('[data-add]')) { collect(); rules.push({ match: '', to: '', hide: false, types: [] }); draw(); }
    else if (tr && e.target.closest('[data-rm]')) { collect(); rules.splice(+tr.dataset.i, 1); draw(); }
    else if (e.target.closest('[data-use]')) { collect(); rules.push({ match: e.target.closest('[data-use]').dataset.use, to: '', hide: false, types: [] }); draw(); var last = V.$$('.rules [data-k=to]', body).pop(); if (last) last.focus(); }
    else if (e.target.closest('[data-save]')) { collect(); V.adminSave({ groupRules: rules.filter(function (r) { return r.match; }), tidyGroups: V.$('[data-tidy]', body).checked }, 'Saved — the catalogue is being rebuilt').then(function (r) { st = r; rules = (r.groupRules || []).map(function (x) { return Object.assign({}, x); }); setTimeout(function () { V.api('/api/admin/groups').then(function (g) { groups = g.groups; draw(); }); }, 4000); }); }
  };
  body.onchange = function (e) { if (e.target.dataset.k === 'hide') { var to = V.$('[data-k=to]', e.target.closest('tr')); to.disabled = e.target.checked; } if (e.target.hasAttribute('data-tidy')) V.adminSave({ tidyGroups: e.target.checked }, 'Saved — the catalogue is being rebuilt'); };
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
  body.innerHTML = '<section class="card-sec"><h2>Site password</h2><p class="dim">Everyone needs this before they see anything. Changing it signs out every other device.</p>' +
    '<div class="grid2"><label class="field"><span>New password</span><input class="input" type="password" data-pw autocomplete="new-password"></label><label class="field"><span>Repeat it</span><input class="input" type="password" data-pw2 autocomplete="new-password"></label></div><button class="btn primary" data-a="pw">Change password</button></section>' +
    '<section class="card-sec"><h2>Signed-in devices</h2><ul class="simple">' + A.devices.sort(function (a, b) { return b.seen - a.seen; }).map(function (d) { var p = A.profiles.filter(function (x) { return x.id === d.profile; })[0]; return '<li><b>' + V.esc(d.name) + '</b> <span class="dim">· ' + V.esc(d.ip || '') + ' · last seen ' + V.fmtAgo(d.seen) + (p ? ' · ' + V.esc(p.name) : '') + '</span> <button class="btn sm" data-end="' + d.id + '">Sign out</button></li>'; }).join('') + '</ul></section>' +
    '<section class="card-sec"><h2>Addresses this server answers to</h2><p class="dim">IP addresses, localhost and local names (.local/.lan) always work. While the site password is the default, other names (like a domain behind a reverse proxy) must be listed here or in the ALLOWED_HOSTS setting — this blocks “DNS rebinding” attacks.</p><label class="field"><span>Extra host names (one per line)</span><textarea class="input" rows="3" data-hosts>' + V.esc((A.settings.allowedHosts || []).join('\n')) + '</textarea></label><button class="btn" data-a="hosts">Save</button></section>';
  body.onclick = function (e) {
    var b = e.target.closest('[data-a]'), end = e.target.closest('[data-end]');
    if (end) return V.del('/api/admin/devices/' + end.dataset.end).then(function () { V.router.refresh(); });
    if (!b) return;
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
    }).catch(function () {});
  };
  var loadUpdate = function () {
    V.api('/api/admin/update').then(function (u) {
      V.$('.upd', body).innerHTML = '<p>Running version <b>' + V.esc(u.version) + '</b>' + (u.onDisk && u.onDisk !== u.version ? ' · version <b>' + V.esc(u.onDisk) + '</b> is on disk' : '') + ' · started ' + V.fmtAgo(u.started) + '.</p>' +
        (u.pending ? '<p class="note">' + V.icon('refresh') + ' New code found — restarting as soon as nobody is watching through the server.</p>' : u.needsRestart ? '<p class="note warn">' + V.icon('refresh') + ' New code is on disk. Restart the server to use it.</p>' : '') +
        '<p class="small">' + (u.autoRestart ? 'New program files dropped into the app folder are picked up automatically: the web app reloads on its own, and the server restarts itself when nobody is watching through it.' : 'New web-app files are picked up automatically; new server files need a restart.') + '</p>';
    }).catch(function () {});
  };
  loadBackups(); loadUpdate();
  body.onclick = function (e) {
    var c = e.target.closest('[data-copy]'); if (c) V.copy(c.dataset.copy);
    if (e.target.closest('[data-bnow]')) V.api('/api/admin/backups', { method: 'POST' }).then(function () { V.toast('Backup made'); loadBackups(); }).catch(V.fail);
    var br = e.target.closest('[data-brestore]');
    if (br) V.confirm('Replace everything on this server with the backup from ' + br.dataset.brestore + '?', { ok: 'Restore', danger: true }).then(function (ok) { if (ok) V.api('/api/admin/backups/' + encodeURIComponent(br.dataset.brestore) + '/restore', { method: 'POST' }).then(function () { V.toast('Restored. The server is restarting…'); setTimeout(function () { location.reload(); }, 6000); }).catch(V.fail); });
    var bd = e.target.closest('[data-bdel]');
    if (bd) V.confirm('Delete the backup ' + bd.dataset.bdel + '?', { ok: 'Delete', danger: true }).then(function (ok) { if (ok) V.del('/api/admin/backups/' + encodeURIComponent(bd.dataset.bdel)).then(loadBackups); });
    if (e.target.closest('[data-newkey]')) V.confirm('Make a new key? Apps using the old addresses stop working.', { ok: 'New key', danger: true }).then(function (ok) { if (ok) V.adminSave({ newExportKey: true }).then(function () { V.router.refresh(); }); });
  };
  body.onchange = function (e) {
    if (e.target.hasAttribute('data-bdays')) { V.adminSave({ backupDays: +e.target.value }); return; }
    if (e.target.dataset.update !== undefined) {
      var z = e.target.files[0];
      if (!z) return;
      V.toast('Uploading the update…');
      fetch('/api/admin/update', { method: 'POST', headers: { 'X-App': '1' }, body: z, credentials: 'same-origin' }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); V.toast('Updated ' + V.plural(j.files, 'file') + (j.version ? ' to version ' + j.version : '') + (j.restart ? ' — the server restarts when nobody is watching.' : ' — restart the server to finish.'), { ms: 10000 }); loadUpdate(); }); }).catch(V.fail);
      return;
    }
    if (e.target.dataset.restore === undefined) return;
    var f = e.target.files[0];
    if (!f) return;
    V.confirm('Replace everything on this server with “' + f.name + '”?', { ok: 'Restore', danger: true }).then(function (ok) {
      if (!ok) return;
      fetch('/api/admin/restore', { method: 'POST', headers: { 'X-App': '1' }, body: f, credentials: 'same-origin' }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); V.toast('Restored. The server is restarting…'); setTimeout(function () { location.reload(); }, 5000); }); }).catch(V.fail);
    });
  };
};
