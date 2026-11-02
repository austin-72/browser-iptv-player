/* Admin → Error reports: problems sent automatically by viewers' devices (errors.js) and the server, grouped into
   issues. Each opens to the latest report in full: the error, where in the code (file, line and the line itself), the
   device, what was playing, and what happened just before. "Copy report" puts all of it on the clipboard as text. */
'use strict';
(function () {
  (V.adminExtraTabs = V.adminExtraTabs || []).push(['errors', 'Error reports', 'stats']);
  var state = { show: 'open', kind: '' };
  var ICON = { playback: 'play', server: 'shield', startup: 'refresh', freeze: 'clock', resource: 'info', user: 'user' };
  /** What a viewer said in their own report (Report a problem): shown big, before everything else. */
  var said = function (choice, note) {
    return '<div class="er-note"><span class="er-choice">' + esc(choice || 'Something’s wrong') + '</span>' + (note ? esc(note) : '<span class="dim">No note.</span>') + '</div>';
  };
  var when = function (t) { return t ? V.fmtAgo(t) : ''; };
  var esc = V.esc;

  var kv = function (o, skip) {
    return '<p class="er-kv">' + Object.keys(o || {}).filter(function (k) { return o[k] !== undefined && o[k] !== '' && (!skip || skip.indexOf(k) < 0); }).map(function (k) {
      var v = o[k];
      return '<span><b>' + esc(k) + '</b> ' + esc(typeof v === 'object' ? JSON.stringify(v) : String(v)) + '</span>';
    }).join('') + '</p>';
  };

  var sampleHtml = function (s) {
    var c = s.ctx || {};
    var dev = [c.device || s.device, c.tv ? 'TV' : c.touch ? 'touch' : '', c.screen, c.viewport ? 'window ' + c.viewport : '', c.conn, c.online === false ? 'offline' : ''].filter(Boolean).join(' · ');
    var ex = s.extra || {};
    var attempts = ex.attempts || [];
    return '<div class="er-sample">' +
      '<p class="small"><b>' + esc(new Date(s.at).toLocaleString()) + '</b> · ' + esc(s.device || '?') + (s.profile ? ' · ' + esc(s.profile) : '') + ' · app ' + esc(s.v || '?') + ' · server ' + esc(s.server || '?') + (s.count > 1 ? ' · <b>' + s.count + '×</b> on that page' : '') + '</p>' +
      (s.page ? '<p class="small dim">Page: <code>' + esc(s.page) + '</code></p>' : '') +
      (s.kind === 'user' ? '<h4>The viewer said</h4>' + said(ex.choiceLabel || ex.choice, ex.note) : '<p class="er-msg">' + esc((s.name && s.message.indexOf(s.name) !== 0 ? s.name + ': ' : '') + s.message) + '</p>') +
      (s.kind === 'user' && ex.final ? '<p class="er-msg">It couldn’t be played: ' + esc(ex.final) + '</p>' : '') +
      (s.stack ? '<pre class="er-pre">' + esc(s.stack) + '</pre>' : s.where ? '<pre class="er-pre">at ' + esc(s.where.file + ':' + s.where.line + ':' + s.where.col) + (s.where.code ? '\n    > ' + esc(s.where.code) : '') + '</pre>' : '') +
      (attempts.length ? '<h4>Ways it tried to play</h4><ol class="er-att">' + attempts.map(function (a) { return '<li><b>' + esc(a.via) + (a.kind ? ' (' + esc(a.kind) + ')' : '') + '</b>' + (a.alt >= 0 ? ' · backup ' + (a.alt + 1) : '') + ' · ' + (a.ms || 0) + ' ms — ' + esc(a.msg || '') + (a.detail ? ' <code>' + esc(JSON.stringify(a.detail)) + '</code>' : '') + '</li>'; }).join('') + '</ol>' : '') +
      (ex.item ? '<h4>Title</h4>' + kv(ex.item) : '') +
      (Object.keys(ex).filter(function (k) { return ['attempts', 'item', 'note', 'choice', 'choiceLabel'].indexOf(k) < 0; }).length ? '<h4>Details</h4>' + kv(ex, ['attempts', 'item', 'note', 'choice', 'choiceLabel']) : '') +
      (c.player ? '<h4>Player</h4>' + kv(c.player) : '') +
      '<h4>Device</h4><p class="small">' + esc(dev) + '</p>' + kv(c, ['player', 'device', 'screen', 'viewport', 'conn', 'online', 'tv', 'touch']) +
      ((s.crumbs || []).length ? '<h4>Before it happened</h4><ol class="er-crumbs">' + s.crumbs.map(function (b) { return '<li><span class="dim">−' + ((b.t || 0) / 1000).toFixed(1) + ' s</span> <b>' + esc(b.k) + '</b> ' + esc(b.m) + '</li>'; }).join('') + '</ol>' : '') +
      '</div>';
  };

  var detail = function (box, id) {
    box.innerHTML = '<div class="spinner sm"></div>';
    V.api('/api/admin/errors/' + id).then(function (is) {
      var others = (is.samples || []).slice(1);
      box.innerHTML = '<div class="btn-row er-acts">' +
        '<button class="btn sm primary" data-copy>' + V.icon('copy') + ' Copy report</button>' +
        (is.status === 'fixed' ? '<button class="btn sm" data-status="open">Reopen</button>' : '<button class="btn sm" data-status="fixed">' + V.icon('check') + ' Mark fixed</button>') +
        '<button class="btn sm danger" data-del>Delete</button></div>' +
        (Object.keys(is.devices || {}).length ? '<p class="small dim">Devices: ' + Object.keys(is.devices).map(function (d) { return esc(d) + ' (' + is.devices[d] + ')'; }).join(', ') + '</p>' : '') +
        (Object.keys(is.items || {}).length ? '<p class="small dim">Titles: ' + Object.keys(is.items).map(function (d) { return esc(d) + ' (' + is.items[d] + ')'; }).join(', ') + '</p>' : '') +
        (is.samples && is.samples[0] ? sampleHtml(is.samples[0]) : '') +
        (others.length ? '<details class="er-more"><summary>' + V.plural(others.length, 'earlier report') + '</summary>' + others.map(sampleHtml).join('') + '</details>' : '');
      box.onclick = function (e) {
        if (e.target.closest('[data-copy]')) V.copy(is.text, 'Report copied');
        var st = e.target.closest('[data-status]');
        if (st) V.put('/api/admin/errors/' + id, { status: st.dataset.status }).then(function () { V.toast(st.dataset.status === 'fixed' ? 'Marked fixed — it reopens if it happens again on a newer version' : 'Reopened'); draw(V.$('.admin-body')); }).catch(V.fail);
        if (e.target.closest('[data-del]')) V.del('/api/admin/errors/' + id).then(function () { draw(V.$('.admin-body')); }).catch(V.fail);
      };
    }).catch(function (e) { box.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; });
  };

  var draw = function (body) {
    if (!body) return;
    V.api('/api/admin/errors').then(function (R) {
      var all = R.issues;
      var open = all.filter(function (x) { return x.status === 'open'; }), fixed = all.filter(function (x) { return x.status === 'fixed'; });
      var list = (state.show === 'open' ? open : state.show === 'fixed' ? fixed : all).filter(function (x) { return !state.kind || x.kind === state.kind; });
      var kinds = {}; all.forEach(function (x) { kinds[x.kind] = (kinds[x.kind] || 0) + 1; });
      body.innerHTML = '<section class="card-sec"><div class="sec-h"><h2>Error reports</h2><a class="btn sm" href="/api/admin/errors-report.txt" download>' + V.icon('download') + ' Download open ones (.txt)</a></div>' +
        '<p class="dim">When something goes wrong on a device — a bug in the app, a title that won’t play, a page that freezes — the device tells the server, with what’s needed to fix it: the error and the line of code, the device and browser, what was playing and how, and what happened just before. Server errors are here too. Passwords, PINs and stream logins are never included. The same list is kept in <code>error-reports.txt</code> in the data folder.</p>' +
        '<label class="switch"><input type="checkbox" data-on' + (R.on ? ' checked' : '') + '><span class="sw"></span><span><b>Collect error reports</b><small>From every device, automatically</small></span></label></section>' +
        '<div class="chips" role="group" aria-label="Show">' +
        [['open', 'Open', open.length], ['fixed', 'Fixed', fixed.length], ['all', 'All', all.length]].map(function (c) { return '<button class="chip' + (state.show === c[0] ? ' on' : '') + '" data-show="' + c[0] + '" aria-pressed="' + (state.show === c[0]) + '">' + c[1] + ' <small>' + c[2] + '</small></button>'; }).join('') +
        (Object.keys(kinds).length > 1 ? '<select class="input sm er-kind" aria-label="Kind"><option value="">Every kind</option>' + Object.keys(kinds).map(function (k) { return '<option value="' + k + '"' + (state.kind === k ? ' selected' : '') + '>' + esc(R.kinds[k] || k) + ' (' + kinds[k] + ')</option>'; }).join('') + '</select>' : '') +
        '</div>' +
        (list.length ? '<div class="er-list">' + list.map(function (x) {
          var devs = Object.keys(x.devices || {}).length;
          return '<details class="er-issue' + (x.status === 'fixed' ? ' fixed' : '') + '" data-id="' + x.id + '"><summary>' +
            '<span class="er-kind-ic">' + V.icon(ICON[x.kind] || 'info') + '</span><span class="er-sum"><span class="er-title">' + esc(x.title) + '</span>' +
            (x.kind === 'user' && x.note ? '<span class="er-note">“' + esc(x.note) + '”</span>' : '') +
            '<span class="small dim">' + esc(x.label) + ' · <b>' + x.count + '×</b> · ' + V.plural(devs, 'device') + ' · last ' + when(x.last) + (x.where ? ' · <code>' + esc(x.where) + '</code>' : '') + (x.reopened ? ' · <span class="err">came back</span>' : '') + (x.status === 'fixed' ? ' · fixed' : '') + '</span></span></summary>' +
            '<div class="er-body"></div></details>';
        }).join('') + '</div>' : '<p class="dim">' + (all.length ? 'Nothing here.' : 'No problems reported yet.') + '</p>') +
        (all.length ? '<div class="btn-row">' + (fixed.length ? '<button class="btn sm" data-clear="fixed">Clear fixed</button>' : '') + '<button class="btn sm danger" data-clear="all">Clear all</button></div>' : '');
      V.$$('.er-issue', body).forEach(function (d) {
        d.addEventListener('toggle', function () { if (d.open && !d._loaded) { d._loaded = true; detail(V.$('.er-body', d), d.dataset.id); } });
      });
      var ks = V.$('.er-kind', body);
      if (ks) ks.onchange = function () { state.kind = ks.value; draw(body); };
      V.$('[data-on]', body).onchange = function (e) { V.put('/api/admin/errors-settings', { on: e.target.checked }).then(function (r) { V.toast(r.on ? 'Collecting error reports' : 'Error reports off'); }).catch(V.fail); };
      body.onclick = function (e) {
        var c = e.target.closest('[data-show]');
        if (c) { state.show = c.dataset.show; draw(body); return; }
        var cl = e.target.closest('[data-clear]');
        if (cl) V.confirm(cl.dataset.clear === 'all' ? 'Delete every error report?' : 'Delete the ones marked fixed?', { ok: 'Delete', danger: true }).then(function (ok) { if (ok) V.del('/api/admin/errors/' + cl.dataset.clear).then(function () { draw(body); }).catch(V.fail); });
      };
    }).catch(function (e) { body.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; });
  };
  V.adminTabs.errors = function (body) { body.innerHTML = '<div class="spinner"></div>'; draw(body); };
})();
