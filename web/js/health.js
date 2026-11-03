/* Channel health: the small "may be down" mark on channels that keep failing (Live TV, the guide, a channel's page),
   and Admin → Channel health — per provider up/down and 7-day success rate, channels failing now with what went
   wrong and which backups work, the background checker's settings and "Check now". See lib/health.js. */
'use strict';
(function () {
  (V.adminExtraTabs = V.adminExtraTabs || []).push(['health', 'Channel health', 'channels']);

  // ------------------------------------------------------------ the "may be down" mark
  S.down = {};
  var downV = 0, downAt = 0, loading = false;
  var MARK_TITLE = 'This channel hasn’t played the last few times anyone tried';
  V.isDown = function (k) { return !!(S.down && S.down[k]); };
  /** A small "May be down" badge to go after a channel's name, or ''. */
  V.downMark = function (c) {
    return c && V.isDown(c.k) ? '<span class="dn-badge" title="' + MARK_TITLE + '">' + V.icon('pulse', 'tiny') + '<span class="dn-t">May be down</span></span>' : '';
  };
  // Pages already drawn: add or take away the badge where the list changed (Live TV rows, the guide's channels).
  var refreshMarks = function () {
    V.$$('.chr[data-k] .dn-row, .g-ch[data-k] .dn-row').forEach(function (el) {
      var row = el.closest('[data-k]'), k = row.dataset.k, has = V.$('.dn-badge', el);
      if (V.isDown(k) && !has) el.insertAdjacentHTML('beforeend', V.downMark({ k: k }));
      else if (!V.isDown(k) && has) has.parentNode.removeChild(has);
      var lab = row.getAttribute('aria-label') || '';
      if (V.isDown(k) && lab.indexOf('(may be down)') < 0) row.setAttribute('aria-label', lab + ' (may be down)');
      else if (!V.isDown(k)) row.setAttribute('aria-label', lab.replace(' (may be down)', ''));
    });
  };
  var load = function () {
    if (loading || !S.profile) return;
    loading = true;
    V.api('/api/health/down').then(function (r) {
      var m = {}, before = Object.keys(S.down || {}).sort().join();
      (r.keys || []).forEach(function (k) { m[k] = 1; });
      S.down = m; downV = r.v; downAt = Date.now();
      if (Object.keys(m).sort().join() !== before) { refreshMarks(); V.emit('health-down'); }
    }).catch(function () {}).then(function () { loading = false; });
  };
  V.on('catalog', function () { if (Date.now() - downAt > 5 * 60e3) load(); });
  V.on('health-v', function (d) { if (d && d.v !== downV) load(); });
  setInterval(function () { if (!document.hidden && Date.now() - downAt > 15 * 60e3) load(); }, 60e3);

  // ------------------------------------------------------------ Admin → Channel health
  var esc = V.esc;
  var mem = { list: '', show: '', q: '' };
  var STATE = { up: ['Up', 'ok'], down: ['Down', 'bad'], problems: ['Problems', 'warn'], unknown: ['Not enough plays yet', ''] };
  var hh = function (h) { return (h < 10 ? '0' : '') + h + ':00'; };
  var dur = function (s) { return s < 90 ? Math.round(s) + ' seconds' : s < 5400 ? Math.round(s / 60) + ' minutes' : (Math.round(s / 360) / 10) + ' hours'; };

  var bars = function (p) {
    var max = 1;
    p.days.forEach(function (d) { max = Math.max(max, d.ok + d.fail); });
    var label = p.days.map(function (d, i) { return (6 - i === 0 ? 'today' : (6 - i) + ' days ago') + ': ' + d.ok + ' worked, ' + d.fail + ' failed'; }).join('; ');
    return '<span class="hl-bars" role="img" aria-label="Last 7 days — ' + esc(label) + '">' + p.days.map(function (d) {
      var t = d.ok + d.fail, h = t ? Math.max(12, Math.round(t / max * 100)) : 0;
      return '<span class="hl-bar" title="' + d.ok + ' worked, ' + d.fail + ' failed"><i style="height:' + h + '%"><b style="height:' + (t ? Math.round(d.fail / t * 100) : 0) + '%"></b></i></span>';
    }).join('') + '</span>';
  };

  var provHtml = function (p, A) {
    var s = STATE[p.state] || STATE.unknown;
    var job = p.job, running = job && !job.done;
    var est = p.estimate || {};
    var line = p.rate === null ? '<span class="dim">No plays or checks in the last 7 days.</span>' : '<b>' + p.rate + '%</b> of ' + V.plural(p.ok + p.fail, 'attempt') + ' worked in the last 7 days';
    var now = p.current ? 'Checking “' + esc(p.current.n) + '”…' : running ? (p.waiting ? 'Waiting: ' + esc(p.waiting) : 'Checking…') : p.waiting && A.opts.on && A.inWindow ? 'Waiting: ' + esc(p.waiting) : '';
    return '<li class="hl-prov" data-id="' + esc(p.id) + '"><div class="hl-ph"><b>' + esc(p.name) + '</b><span class="chip sm hl-st ' + s[1] + '">' + s[0] + '</span>' + (p.enabled ? '' : '<span class="chip sm">Off</span>') + '<span class="sp"></span>' +
      (p.checkable ? (running ? '<button class="btn sm" data-stop>' + V.icon('x') + ' Stop checking</button>' : '<button class="btn sm" data-check>' + V.icon('pulse') + ' Check now</button>') : '') + '</div>' +
      '<div class="hl-pb">' + bars(p) + '<div class="hl-pt small"><div>' + line + '</div>' +
      (p.failingNow ? '<div>' + V.plural(p.failingNow, 'channel') + ' failing now' + (p.state !== 'down' && p.lastOk ? ' <span class="dim">— the provider itself works</span>' : '') + '</div>' : '') +
      '<div class="dim">' + (p.lastOk ? 'Last worked ' + V.fmtAgo(p.lastOk) : 'No success recorded') + (p.lastFail ? ' · last failure ' + V.fmtAgo(p.lastFail) + (p.lastErr ? ': “' + esc(p.lastErr) + '”' : '') : '') + '</div></div></div>' +
      (p.checkable ? '<div class="small dim">' + V.plural(p.channels, 'live channel') + ' · ' + p.checked + ' checked in the last day' + (est.copies ? ' · a full check takes about ' + dur(est.seconds) + (A.opts.on && est.nights > 1 ? ' (' + est.nights + ' nights)' : '') : '') + (p.limit === 1 ? ' · one stream at a time' : p.limit === null ? ' · stream limit unknown' : '') + '</div>' : '<div class="small dim">This kind of list isn’t checked in the background; plays still count.</div>') +
      (running && job ? '<div class="small hl-run">' + (p.current ? '<span class="spinner sm"></span> ' : '') + now + ' <span class="dim">· ' + job.n + ' of ' + job.total + ' done, ' + job.fail + ' failed</span></div>' : now ? '<div class="small hl-run">' + now + '</div>' : job && job.done ? '<div class="small dim">Last “Check now” ' + (job.stopped ? 'stopped' : 'finished') + ' ' + V.fmtAgo(job.done) + ': ' + job.n + ' checked, ' + job.fail + ' failed.</div>' : '') +
      (p.checkable ? '<label class="check small"><input type="checkbox" data-gentle' + (p.gentle ? ' checked' : '') + '><span>Check gently <span class="dim">(for providers that count each check as a sign-in): one check every 45 seconds, at most 120 a night</span></span></label>' : '') + '</li>';
  };

  var copyHtml = function (c, f, A) {
    var where = esc(A.names[c.list] || 'Removed list') + (c.alt < 0 ? '' : ' <span class="dim">(backup ' + (c.alt + 1) + ')</span>');
    if (!c.failing) return '<li class="hl-copy">' + where + ' · ' + (c.works ? '<span class="ok-t">' + V.icon('check', 'tiny') + ' works</span> <span class="dim">' + V.fmtAgo(c.lastOk) + '</span>' : '<span class="dim">not tried lately</span>') + (f.prefer === c.id ? ' · <b>plays first</b>' : '') + '</li>';
    return '<li class="hl-copy bad">' + where + ' · <span class="err">' + esc(c.err || 'Didn’t play') + '</span> <span class="dim">· ' + V.plural(c.n, 'time') + ' in a row' + (c.since ? ', since ' + V.fmtAgo(c.since) : '') + (c.by === 'c' ? ' · last seen by a check' : ' · last seen by a viewer') + '</span>' + (f.prefer === c.id ? ' · <b>plays first</b>' : '') + '</li>';
  };

  var rowHtml = function (f, A) {
    var work = f.copies.filter(function (c) { return c.works && c.id !== f.prefer; })[0];
    var main = f.copies[0];
    return '<li class="hl-row" data-k="' + esc(f.k) + '">' + V.art(f.logo, f.n, 'art sm') +
      '<div class="hl-main"><div><b>' + esc(f.n) + '</b> <span class="dim small">' + (f.num ? f.num + ' · ' : '') + esc(f.g) + '</span>' + (f.down ? ' <span class="chip sm bad">Marked “may be down”</span>' : f.allDown ? ' <span class="chip sm warn">No copy works</span>' : f.backup ? ' <span class="chip sm">A backup works</span>' : '') + '</div>' +
      '<ul class="hl-copies">' + f.copies.map(function (c) { return copyHtml(c, f, A); }).join('') + '</ul></div>' +
      '<div class="hl-acts">' + (f.prefer ? '<button class="btn sm" data-prefer="">Back to the usual order</button>' : work && main.failing && work.id !== main.id ? '<button class="btn sm primary" data-prefer="' + esc(work.id) + '">Use the backup first</button>' : '') +
      '<button class="btn sm" data-hide>Hide channel</button><button class="btn sm ghost" data-forget>Forget</button></div></li>';
  };

  V.adminTabs.health = function (body) {
    var A = null, timer = null;
    var qs = function () { return 'list=' + encodeURIComponent(mem.list) + '&show=' + encodeURIComponent(mem.show) + '&q=' + encodeURIComponent(mem.q) + '&n=200'; };
    var seq = 0;
    var load = function () {
      var mine = ++seq;
      return V.api('/api/admin/health?' + qs()).then(function (r) {
        // (An older answer arriving after a newer one — typing in the search — mustn't draw over it.)
        if (!body.isConnected || mine !== seq) return;
        A = r; draw();
        clearTimeout(timer);
        if (r.providers.some(function (p) { return (p.job && !p.job.done) || p.current; })) timer = setTimeout(load, 3000);
      }).catch(function (e) { if (body.isConnected && mine === seq) body.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; });
    };
    var draw = function () {
      var o = A.opts, sm = A.summary;
      var keep = focusKey();
      var hours = function (cur) { var h = ''; for (var i = 0; i < 24; i++) h += '<option value="' + i + '"' + (i === cur ? ' selected' : '') + '>' + hh(i) + '</option>'; return h; };
      body.innerHTML =
        '<section class="card-sec"><h2>Summary</h2>' +
        '<p class="dim">Each time someone plays a channel, their device already tells the server whether it worked, from which provider and what went wrong. That’s counted here per channel and per provider, without opening anything extra. Channels whose every copy keeps failing get a “May be down” badge in Live TV, the guide and the channel’s page, so nobody keeps trying them.</p>' +
        '<div class="stats">' + [['Failing now', sm.failing], ['No copy works', sm.down], ['A backup works', sm.backup], ['Marked “may be down”', sm.marked]].map(function (x) { return '<div class="stat"><b class="num">' + x[1] + '</b><span>' + x[0] + '</span></div>'; }).join('') + '</div></section>' +
        '<section class="card-sec"><h2>Providers</h2>' + (A.providers.length ? '<ul class="hl-provs">' + A.providers.map(function (p) { return provHtml(p, A); }).join('') + '</ul>' : '<p class="dim">No lists yet.</p>') + '</section>' +
        '<details class="card-sec hl-set"' + (mem.setOpen ? ' open' : '') + '><summary><b>' + V.icon('sliders') + ' Background checks and settings</b> <span class="dim">' + (o.on ? 'checking ' + hh(o.from) + '–' + hh(o.to) : 'background checks off') + '</span></summary>' +
        '<label class="switch"><input type="checkbox" data-o="on"' + (o.on ? ' checked' : '') + '><span class="sw"></span><span><b>Check live channels in the background</b><small>One channel at a time, a few seconds apart, in the hours below. A check asks for a moment of the stream (an HLS playlist and its newest segment, or the first few KB) and closes it.</small></span></label>' +
        '<div class="grid2 small-grid"><label class="field"><span>From</span><select class="input" data-o="from">' + hours(o.from) + '</select></label><label class="field"><span>Until</span><select class="input" data-o="to">' + hours(o.to) + '</select></label>' +
        '<label class="field"><span>Time between checks</span><select class="input" data-o="gap">' + [5, 10, 20, 30, 60].map(function (s) { return '<option value="' + s + '"' + (s === o.gap ? ' selected' : '') + '>' + s + ' seconds</option>'; }).join('') + (([5, 10, 20, 30, 60].indexOf(o.gap) < 0) ? '<option value="' + o.gap + '" selected>' + o.gap + ' seconds</option>' : '') + '</select></label>' +
        '<label class="field"><span>Skip copies that failed their last…</span><select class="input" data-o="skipAfter">' + [[0, 'Don’t skip'], [2, '2 tries'], [3, '3 tries'], [5, '5 tries']].map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === o.skipAfter ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></label></div>' +
        '<p class="small dim">Skipped copies are tried last instead of first when a channel plays; they’re never removed.</p>' +
        '<label class="switch"><input type="checkbox" data-o="marks"' + (o.marks !== false ? ' checked' : '') + '><span class="sw"></span><span><b>Show “may be down” on channels that keep failing</b><small>Only when every copy failed several times in a row in the last 2 days, with no success since.</small></span></label>' +
        '<p class="small dim">A check never runs while anyone is watching from that provider (or stopped a few minutes ago), during a connection test, or while another app or a conversion uses it — and it stops the moment someone presses Play. On a provider that allows one stream at a time (or whose limit isn’t known yet), checks wait until nobody else has the app open. Some providers count every check as a sign-in: tick “Check gently” for those.</p></details>' +
        '<section class="card-sec"><h2>Failing now</h2>' +
        '<div class="page-tools hl-tools"><input class="input" type="search" data-f="q" value="' + esc(mem.q) + '" placeholder="Find a channel" aria-label="Find a channel">' +
        '<select class="input" data-f="list" aria-label="Provider"><option value="">Every provider</option>' + A.providers.map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.id === mem.list ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select>' +
        '<select class="input" data-f="show" aria-label="Show"><option value="">Every failing channel</option><option value="down"' + (mem.show === 'down' ? ' selected' : '') + '>No copy works</option><option value="backup"' + (mem.show === 'backup' ? ' selected' : '') + '>A backup works</option></select></div>' +
        (A.failing.items.length ? '<ul class="hl-list">' + A.failing.items.map(function (f) { return rowHtml(f, A); }).join('') + '</ul>' + (A.failing.total > A.failing.items.length ? '<p class="dim small">Showing ' + A.failing.items.length + ' of ' + A.failing.total + '. Narrow it down with the search or filters.</p>' : '') :
          '<p class="dim">' + (mem.q || mem.list || mem.show ? 'Nothing matches.' : 'No channel is failing right now.') + '</p>') +
        (sm.failing ? '<div class="btn-row"><button class="btn sm ghost" data-forgetall>Forget all failures</button></div>' : '') + '</section>';
      if (keep) {
        var el = null;
        try { el = V.$(keep.sel, body) || (keep.alt && V.$(keep.alt, body)); } catch (e) {}
        if (el) { el.focus(); if (el.type === 'search') try { el.setSelectionRange(el.value.length, el.value.length); } catch (e2) {} }
      }
    };
    // (The page is drawn again after each change: keep the focus where it was, for keyboards and TV remotes.)
    var ATTRS = ['data-check', 'data-stop', 'data-gentle', 'data-o', 'data-f', 'data-prefer', 'data-hide', 'data-forget', 'data-forgetall'];
    var focusKey = function () {
      var a = document.activeElement;
      if (!a || !body.contains(a)) return null;
      var attr = ATTRS.filter(function (n) { return a.hasAttribute(n); })[0];
      if (!attr) return null;
      var box = a.closest('[data-id],[data-k]');
      var pre = box ? (box.hasAttribute('data-id') ? '[data-id="' + box.dataset.id + '"] ' : '[data-k="' + box.dataset.k + '"] ') : '';
      var v = a.getAttribute(attr);
      var other = attr === 'data-check' ? 'data-stop' : attr === 'data-stop' ? 'data-check' : '';
      return { sel: pre + '[' + attr + (v ? '="' + v + '"' : '') + ']', alt: other ? pre + '[' + other + ']' : '' };
    };
    body.onclick = function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var pv = b.closest('[data-id]'), row = b.closest('[data-k]');
      if (b.hasAttribute('data-check')) { b.disabled = true; V.api('/api/admin/health/lists/' + encodeURIComponent(pv.dataset.id) + '/check', { method: 'POST' }).then(load).catch(function (x) { V.fail(x); load(); }); }
      else if (b.hasAttribute('data-stop')) V.del('/api/admin/health/lists/' + encodeURIComponent(pv.dataset.id) + '/check').then(load).catch(V.fail);
      else if (b.hasAttribute('data-prefer')) V.api('/api/admin/health/prefer', { body: { k: row.dataset.k, id: b.dataset.prefer } }).then(function () { V.toast(b.dataset.prefer ? 'That backup plays first from now on' : 'Back to the usual order'); load(); }).catch(V.fail);
      else if (b.hasAttribute('data-forget')) V.api('/api/admin/health/forget', { body: { k: row.dataset.k } }).then(load).catch(V.fail);
      else if (b.hasAttribute('data-forgetall')) V.confirm('Forget every failure recorded so far? The providers’ 7-day history goes too.', { ok: 'Forget' }).then(function (ok) { if (ok) V.api('/api/admin/health/forget', { body: {} }).then(load).catch(V.fail); });
      else if (b.hasAttribute('data-hide')) {
        var f = A.failing.items.filter(function (x) { return x.k === row.dataset.k; })[0];
        V.confirm('Hide “' + (f ? f.n : 'this channel') + '” for everyone? You can show it again in Admin → Channels (Hidden ones).', { ok: 'Hide' }).then(function (ok) {
          if (ok) V.put('/api/admin/channels/' + encodeURIComponent(row.dataset.k), { hide: true }).then(function () { V.toast('Hidden'); load(); }).catch(V.fail);
        });
      }
    };
    body.onchange = function (e) {
      var t = e.target;
      if (t.dataset.o) { var p = {}; p[t.dataset.o] = t.type === 'checkbox' ? t.checked : +t.value; V.put('/api/admin/health', p).then(function () { V.toast('Saved'); load(); }).catch(V.fail); }
      else if (t.hasAttribute('data-gentle')) { var g = {}; g[t.closest('[data-id]').dataset.id] = t.checked; V.put('/api/admin/health', { gentle: g }).then(function () { V.toast(t.checked ? 'This provider is checked gently' : 'Saved'); load(); }).catch(V.fail); }
      else if (t.dataset.f === 'list' || t.dataset.f === 'show') { mem[t.dataset.f] = t.value; load(); }
    };
    body.addEventListener('toggle', function (e) { if (e.target.classList && e.target.classList.contains('hl-set')) mem.setOpen = e.target.open; }, true);
    body.oninput = V.debounce(function (e) { if (e.target.dataset.f === 'q') { mem.q = e.target.value.trim(); load(); } }, 300);
    var prevCleanup = V.pageCleanup;
    V.pageCleanup = function () { clearTimeout(timer); if (prevCleanup) prevCleanup(); };
    load();
  };
})();
