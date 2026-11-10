/* Admin: more kinds of lists (Stalker/Ministra MAC portals; Jellyfin, Emby and Plex libraries) and the
   "Other apps" tab (an Xtream Codes login per profile, and an HDHomeRun tuner for Plex, Jellyfin and Emby). */
'use strict';

/** Extra panes in "Add a list". */
V.addListPanes = function () {
  return '<div data-pane="stalker" hidden><label class="field"><span>Portal address</span><input class="input" name="portal" placeholder="http://portal.example:8080/c/" autocomplete="off"><small class="dim">The address you’d type into a MAG box or the app the provider recommends (often ending in /c/).</small></label>' +
    '<label class="field"><span>MAC address</span><input class="input" name="mac" placeholder="00:1A:79:12:34:56" autocomplete="off"></label>' +
    '<details><summary>Serial number, device ids, signature (only if the provider asks for them)</summary><div class="grid2"><label class="field"><span>Serial number</span><input class="input" name="serial" autocomplete="off"></label><label class="field"><span>Device id</span><input class="input" name="deviceId" autocomplete="off"></label>' +
    '<label class="field"><span>Device id 2</span><input class="input" name="deviceId2" autocomplete="off"></label><label class="field"><span>Signature</span><input class="input" name="signature" autocomplete="off"></label></div></details>' +
    '<label class="check"><input type="checkbox" name="stalkerVod" checked><span>Also add the portal’s films and series (big portals take a few minutes)</span></label></div>' +
    '<div data-pane="mediaserver" hidden><div class="grid2"><label class="field"><span>Kind</span><select class="input" name="kind"><option value="jellyfin">Jellyfin</option><option value="emby">Emby</option><option value="plex">Plex</option></select></label>' +
    '<label class="field"><span>Server address</span><input class="input" name="msServer" placeholder="http://192.168.1.20:8096" autocomplete="off"></label></div>' +
    '<div data-ms="emby"><div class="grid2"><label class="field"><span>Username</span><input class="input" name="msUser" autocomplete="off"></label><label class="field"><span>Password</span><input class="input" type="password" name="msPass" autocomplete="off"></label></div>' +
    '<label class="field"><span>…or an API key</span><input class="input" name="msKey" autocomplete="off"></label><label class="check"><input type="checkbox" name="includeLive"><span>Also add its Live TV channels</span></label></div>' +
    '<div data-ms="plex" hidden><label class="field"><span>Plex token</span><input class="input" name="plexToken" autocomplete="off"><small class="dim">In Plex: open any film → ⋯ → Get Info → View XML; the address ends in X-Plex-Token=….</small></label></div>' +
    '<p class="dim small">Films and series play straight from your media server. Its address must be reachable from the devices that watch, and the login is visible to them — use an account made for this, not an administrator.</p></div>';
};

/** Reads the extra panes into the new list's body. */
V.addListBody = function (mode, fd, b) {
  if (mode === 'stalker') {
    b.portal = fd.get('portal'); b.mac = fd.get('mac'); b.serial = fd.get('serial'); b.deviceId = fd.get('deviceId'); b.deviceId2 = fd.get('deviceId2'); b.signature = fd.get('signature');
    b.vod = !!fd.get('stalkerVod');
  }
  if (mode === 'mediaserver') {
    b.kind = fd.get('kind'); b.server = fd.get('msServer');
    if (b.kind === 'plex') b.token = fd.get('plexToken');
    else { b.username = fd.get('msUser'); b.password = fd.get('msPass'); b.token = fd.get('msKey'); b.includeLive = !!fd.get('includeLive'); }
  }
};

// The Jellyfin/Emby and Plex fields switch with the kind.
document.addEventListener('change', function (e) {
  if (!e.target || e.target.name !== 'kind' || !e.target.closest('[data-pane=mediaserver]')) return;
  var pane = e.target.closest('[data-pane=mediaserver]');
  V.$('[data-ms=emby]', pane).hidden = e.target.value === 'plex';
  V.$('[data-ms=plex]', pane).hidden = e.target.value !== 'plex';
});

/** Extra fields in "Edit list". */
V.editListFields = function (l) {
  if (l.type === 'stalker') {
    return '<label class="field"><span>Portal address</span><input class="input" name="portal" value="' + V.esc(l.portal) + '"></label><label class="field"><span>MAC address</span><input class="input" name="mac" value="' + V.esc(l.mac) + '"></label>' +
      '<div class="grid2"><label class="field"><span>Serial number</span><input class="input" name="serial" value="' + V.esc(l.serial || '') + '"></label><label class="field"><span>Device id</span><input class="input" name="deviceId" value="' + V.esc(l.deviceId || '') + '"></label><label class="field"><span>Device id 2</span><input class="input" name="deviceId2" value="' + V.esc(l.deviceId2 || '') + '"></label><label class="field"><span>Signature</span><input class="input" name="signature" value="' + V.esc(l.signature || '') + '"></label></div>' +
      '<label class="check"><input type="checkbox" name="vod" data-bool' + (l.vod !== false ? ' checked' : '') + '><span>Include the portal’s films and series</span></label>';
  }
  if (l.type === 'mediaserver') {
    return '<label class="field"><span>Server address</span><input class="input" name="server" value="' + V.esc(l.server) + '"></label>' +
      (l.kind === 'plex' ? '<label class="field"><span>Plex token</span><input class="input" name="token" value="' + V.esc(l.token || '') + '"></label>'
        : '<div class="grid2"><label class="field"><span>Username</span><input class="input" name="username" value="' + V.esc(l.username || '') + '"></label><label class="field"><span>Password</span><input class="input" type="password" name="password" value="' + V.esc(l.password || '') + '"></label></div><label class="field"><span>API key</span><input class="input" name="token" value="' + V.esc(l.token || '') + '"></label>' +
          '<label class="check"><input type="checkbox" name="includeLive" data-bool' + (l.includeLive ? ' checked' : '') + '><span>Include its Live TV channels</span></label>');
  }
  return '';
};

/** The line under a list's name in Admin → Lists. */
V.listInfo = function (l) {
  if (l.type === 'stalker') return 'Portal ' + V.esc(l.portal) + ' · MAC ' + V.esc(l.mac);
  if (l.type === 'mediaserver') return V.esc(({ jellyfin: 'Jellyfin', emby: 'Emby', plex: 'Plex' })[l.kind] || '') + ' · ' + V.esc(l.server) + (l.username ? ' · signed in as ' + V.esc(l.username) : '');
  return '';
};

// ---------------------------------------------------------------- Admin → Other apps
V.adminTabs.outputs = function (body, A) {
  body.innerHTML = '<div class="spinner"></div>';
  var O = null;
  var copyRow = function (label, value) { return '<label class="field"><span>' + label + '</span><div class="inline"><input class="input" readonly value="' + V.esc(value) + '"><button class="btn" data-copy="' + V.esc(value) + '">Copy</button></div></label>'; };
  // (What had focus before a redraw, to put it back: a TV remote would otherwise be left nowhere.)
  var pending = null;
  var focusOf = function (a) {
    if (!a || !body.contains(a)) return null;
    var li = a.closest('[data-pid]');
    var attr = ['data-o', 'data-login', 'data-setpw', 'data-nologin', 'data-copy'].filter(function (x) { return a.hasAttribute(x); })[0];
    return attr ? { pid: li ? li.getAttribute('data-pid') : null, attr: attr, val: attr === 'data-o' ? a.getAttribute(attr) : '' } : null;
  };
  var refocus = function (f) {
    if (!f) return;
    var scope = f.pid ? V.$$('[data-pid]', body).filter(function (x) { return x.getAttribute('data-pid') === f.pid; })[0] : body;
    var el = scope ? V.$$('[' + f.attr + ']', scope).filter(function (x) { return !f.val || x.getAttribute(f.attr) === f.val; })[0] : null;
    if (!el && scope && f.pid) el = V.$('button', scope); // ("Make a login" became "New password", or the login went)
    if (el) try { el.focus({ preventScroll: true }); } catch (e) {}
  };
  var draw = function () {
    var keep = pending || focusOf(document.activeElement);
    pending = null;
    var base = location.protocol + '//' + location.host;
    var logins = {};
    O.logins.forEach(function (x) { logins[x.profile] = x; });
    body.innerHTML =
      '<section class="card-sec"><h2>' + V.icon('tv') + ' A login for IPTV apps (Xtream Codes)</h2>' +
      '<p class="dim">TiviMate, IPTV Smarters, OTT Navigator and most other IPTV apps can sign in here as if this were a provider. Each profile gets its own login and sees what it sees here: its languages, age limit and categories, with duplicates already merged and names tidied. Streams go straight from your providers to the app where possible.</p>' +
      '<label class="check"><input type="checkbox" data-o="xtream"' + (O.xtream.enabled ? ' checked' : '') + '><span>Turn on Xtream Codes logins</span></label>' +
      (O.xtream.enabled ? copyRow('Server (in the app: “Xtream Codes” / “Xtream API”)', base) +
        '<ul class="simple out-logins">' + O.profiles.map(function (p) {
          var l = logins[p.id];
          return '<li data-pid="' + V.esc(p.id) + '">' + V.avatar(p.avatar, 'sm') + ' <b>' + V.esc(p.name) + '</b>' + (p.kids ? ' <span class="chip sm">Kids</span>' : '') + ' <span class="dim">· ' + (l ? 'username <code>' + V.esc(l.user) + '</code>' : 'no login') + '</span>' +
            '<span class="sp"></span><button class="btn sm" data-login>' + (l ? 'New password' : 'Make a login') + '</button>' + (l ? '<button class="btn sm" data-setpw>Choose password</button><button class="icon-btn sm" data-nologin aria-label="Remove login">' + V.icon('trash') + '</button>' : '') + '</li>';
        }).join('') + '</ul><p class="dim small">The playlist and guide for the same login: <code>' + V.esc(base) + '/get.php?username=…&amp;password=…&amp;type=m3u_plus</code> and <code>/xmltv.php?username=…&amp;password=…</code>. The 24/7 channels from My channels aren’t included (only this app can play them).</p>' : '') +
      '</section>' +
      '<section class="card-sec"><h2>' + V.icon('server') + ' A TV tuner for Plex, Jellyfin and Emby (HDHomeRun)</h2>' +
      '<p class="dim">Lets Plex, Jellyfin or Emby add your live channels as if this were an HDHomeRun tuner on the network — so they can show them, and record them with their own DVR. Only devices on your home network can use it, and there’s no password, so leave it off if you don’t need it.</p>' +
      '<label class="check"><input type="checkbox" data-o="hdhr"' + (O.hdhr.enabled ? ' checked' : '') + '><span>Turn on the tuner</span></label>' +
      (O.hdhr.enabled ? '<div class="grid2"><label class="field"><span>Tuners (streams at once)</span><input class="input" type="number" min="1" max="8" data-o="tuners" value="' + O.hdhr.tuners + '"></label>' +
        '<label class="field"><span>Channels as seen by</span><select class="input" data-o="profile">' + O.profiles.map(function (p) { return '<option value="' + V.esc(p.id) + '"' + ((O.hdhr.profile || '') === p.id || (!O.hdhr.profile && p.admin) ? ' selected' : '') + '>' + V.esc(p.name) + '</option>'; }).join('') + '</select></label></div>' +
        copyRow('Tuner address (Plex: Live TV &amp; DVR → Set up → enter it by hand; Jellyfin: Live TV → Tuner devices → HDHomeRun)', base) +
        copyRow('TV guide for it (XMLTV)', base + '/hdhr/epg.xml') +
        '<p class="dim small">The tuner never uses more of a provider’s connections than it allows, counting everyone watching here.</p>' : '') +
      '</section>' +
      (O.active.length ? '<section class="card-sec"><h2>Other apps, in the last few hours</h2><ul class="simple">' + O.active.map(function (a) { var p = O.profiles.filter(function (x) { return x.id === a.profile; })[0]; return '<li>' + V.esc(a.kind === 'hdhr' ? 'Tuner' : 'Xtream login') + ' · ' + V.esc(p ? p.name : '') + ' · ' + V.esc(a.n) + ' <span class="dim">· ' + V.esc(a.ip) + ' · since ' + V.fmtAgo(a.since) + '</span></li>'; }).join('') + '</ul></section>' : '');
    refocus(keep);
  };
  var load = function () { return V.api('/api/admin/outputs').then(function (r) { O = r; draw(); }).catch(function (e) { body.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; }); };
  // (A failed save redraws too, so the switch shows what's really saved.)
  var save = function (el, patch) {
    pending = focusOf(el); el.disabled = true;
    return V.put('/api/admin/outputs', patch).then(function () { V.toast('Saved'); }, V.fail).then(load);
  };
  var showPw = function (r) {
    return V.dialog({ title: 'Login for the app', body: '<p>Server: <code>' + V.esc(location.protocol + '//' + location.host) + '</code></p><p>Username: <code>' + V.esc(r.user) + '</code></p><p>Password: <code class="big">' + V.esc(r.password) + '</code></p><p class="dim small">Write it down — it isn’t shown again (you can always make a new one).</p>', actions: [{ label: 'Copy password', fn: function () { V.copy(r.password); return false; } }, { label: 'Done', primary: true, value: true }] });
  };
  load();
  body.onclick = function (e) {
    var c = e.target.closest('[data-copy]'); if (c) return V.copy(c.dataset.copy);
    var li = e.target.closest('[data-pid]');
    if (!li) return;
    var pid = li.dataset.pid, path = '/api/admin/outputs/logins/' + encodeURIComponent(pid);
    var b = e.target.closest('button');
    if (!b || b.disabled) return;
    // (The list is redrawn once the password dialog closes, with focus back on this row.)
    var made = function (r) { return showPw(r).then(function () { pending = focusOf(b) || { pid: pid, attr: 'data-login' }; return load(); }); };
    var send = function (req) { b.disabled = true; req().then(made).catch(function (err) { if (b.isConnected) b.disabled = false; V.fail(err); }); };
    // (A new password for a login that exists stops the apps using the old one: asked first.)
    if (b.hasAttribute('data-login')) { if (/New password/.test(b.textContent)) V.confirm('Make a new password for this login? Apps signed in with the current one stop working until they’re given the new one.', { ok: 'New password' }).then(function (yes) { if (yes) send(function () { return V.api(path, { body: {} }); }); }); else send(function () { return V.api(path, { body: {} }); }); }
    else if (b.hasAttribute('data-setpw')) V.prompt('New password for this login (6 characters or more)', { type: 'text' }).then(function (pw) { if (pw) send(function () { return V.api(path, { body: { password: pw } }); }); });
    else if (b.hasAttribute('data-nologin')) V.confirm('Remove this login? Apps signed in with it stop working.', { ok: 'Remove', danger: true }).then(function (ok) { if (ok) { pending = { pid: pid, attr: 'data-login' }; V.del(path).then(function () { V.toast('Login removed'); return load(); }).catch(function (err) { pending = null; V.fail(err); }); } });
  };
  body.onchange = function (e) {
    var k = e.target.dataset.o;
    if (k === 'xtream') save(e.target, { xtream: { enabled: e.target.checked } });
    else if (k === 'hdhr') save(e.target, { hdhr: { enabled: e.target.checked } });
    else if (k === 'tuners') { var n = V.adminNum(e.target, O.hdhr.tuners); if (n !== null) save(e.target, { hdhr: { tuners: n } }); }
    else if (k === 'profile') save(e.target, { hdhr: { profile: e.target.value } });
  };
};
