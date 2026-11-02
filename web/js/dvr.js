/* The DVR: "Record" on programmes (TV guide, a channel's schedule, the player's menu), "Record every episode", and
   the Recordings page (recording now, coming up, series, recorded, and ones that didn't work). The server does the
   recording (lib/dvr.js); Admin → DVR says who may record. Recordings play like the server's own files. */
'use strict';
(function () {
  var D = V.dvr = { state: null };
  var MIN = 60e3;

  D.load = function () {
    if (!S.profile) return Promise.resolve(null);
    return V.api('/api/dvr').then(function (s) { D.state = s; V.emit('dvr-state', s); return s; }).catch(function () { return null; });
  };
  /** May this profile record right now (and can the server)? */
  D.can = function () { return !!(D.state && D.state.can && D.state.ffmpeg); };
  /** Show "Recordings" in menus: allowed to record, or has recordings. */
  D.visible = function () { return !!(D.state && (D.can() || (D.state.recs || []).length)); };
  var live = function (r) { return r.state === 'scheduled' || r.state === 'waiting' || r.state === 'recording' || r.state === 'saving'; };
  /** The recording of this programme (scheduled, running or made), if any. */
  D.find = function (c, p) {
    var recs = (D.state && D.state.recs) || [];
    for (var i = 0; i < recs.length; i++) { var r = recs[i]; if (r.k === c.k && !r.who && Math.abs(r.s - p.s) < MIN && r.state !== 'failed') return r; }
    return null;
  };
  D.recordingNow = function (c) {
    var recs = (D.state && D.state.recs) || [], now = Date.now();
    for (var i = 0; i < recs.length; i++) { var r = recs[i]; if (r.k === c.k && !r.who && (r.state === 'recording' || r.state === 'waiting') && r.s <= now) return r; }
    return null;
  };
  var when = function (r) { return V.fmtDay(r.s) + ' ' + V.fmtClock(r.s) + '–' + V.fmtClock(r.e); };

  D.record = function (c, p) {
    return V.api('/api/dvr/record', { body: { k: c.k, s: p.s, e: p.e, t: p.t, st: p.st, ep: p.ep, d: p.d } }).then(function (r) {
      V.toast(r.state === 'recording' || p.s <= Date.now() ? 'Recording “' + r.t + '”' : 'I’ll record “' + r.t + '” · ' + when(r), { action: { label: 'Recordings', fn: function () { V.router.go('#/recordings'); } } });
      return D.load();
    }).catch(V.fail);
  };
  D.recordNow = function (c) {
    return V.api('/api/dvr/now', { body: { k: c.k } }).then(function (r) {
      V.toast('Recording “' + r.t + '” until ' + V.fmtClock(r.e), { action: { label: 'Recordings', fn: function () { V.router.go('#/recordings'); } } });
      return D.load();
    }).catch(V.fail);
  };
  D.series = function (c, p) {
    return V.api('/api/dvr/series', { body: { k: c.k, t: p.t } }).then(function (r) {
      V.toast('I’ll record every “' + r.t + '” on ' + r.ch + (r.recs ? ' (' + r.recs + ' coming up)' : ''));
      return D.load();
    }).catch(V.fail);
  };
  D.cancel = function (r) {
    var running = r.state === 'recording' || r.state === 'saving';
    return V.confirm(running ? 'Stop recording “' + r.t + '” and delete what’s been recorded?' : r.state === 'done' ? 'Delete the recording of “' + r.t + '”?' : 'Don’t record “' + r.t + '”?', { ok: running || r.state === 'done' ? 'Delete' : 'Don’t record', danger: running || r.state === 'done' }).then(function (ok) {
      if (!ok) return;
      return V.del('/api/dvr/' + r.id).then(D.load).catch(V.fail);
    });
  };
  D.stop = function (r) { return V.api('/api/dvr/' + r.id + '/stop', { method: 'POST' }).then(function () { V.toast('Stopped. The recording is being saved.'); return D.load(); }).catch(V.fail); };
  /** A finished recording, played like the server's own files. */
  D.itemOf = function (r) { return { k: 'rec:' + r.id, t: 'movie', n: r.t, u: 'local:dvr:' + r.id, g: 'Recordings', i: (V.entry(r.k) || {}).logo || '' }; };
  D.play = function (r) { V.play(D.itemOf(r)); };

  // ------------------------------------------------------------ on programmes
  /** Buttons for the programme dialog (guide.js). */
  D.progActions = function (c, p, acts) {
    if (!D.can() || p.e <= Date.now() || (c.t !== 'live' && c.t !== 'radio')) return;
    var r = D.find(c, p);
    if (r) acts.splice(1, 0, { label: r.state === 'recording' ? 'Stop recording' : 'Don’t record', fn: function () { if (r.state === 'recording') D.stop(r); else D.cancel(r); } });
    else acts.splice(1, 0, { label: p.s <= Date.now() ? 'Record the rest' : 'Record', fn: function () { D.record(c, p); } });
    var hasRule = D.state.rules.some(function (x) { return x.k === c.k && !x.who && x.t.toLowerCase() === String(p.t).toLowerCase(); });
    if (!hasRule) acts.splice(2, 0, { label: 'Record every episode', fn: function () { D.series(c, p); } });
  };
  /** The little record button on a channel's schedule (browse.js). */
  D.progButton = function (c, p) {
    if (!D.can() || p.e <= Date.now()) return '';
    var r = D.find(c, p);
    return '<button class="icon-btn dvr-pb' + (r ? ' on' : '') + '" data-p="dvr" data-s="' + p.s + '" aria-pressed="' + !!r + '" aria-label="' + (r ? 'Don’t record' : 'Record') + ' ' + V.esc(p.t) + '" title="' + (r ? 'Recording' : 'Record') + '">' + V.icon(r ? 'rec' : 'recoff') + '</button>';
  };
  D.progClick = function (c, p, b) {
    var r = D.find(c, p);
    var done = function () { var r2 = D.find(c, p); b.classList.toggle('on', !!r2); b.setAttribute('aria-pressed', !!r2); b.innerHTML = V.icon(r2 ? 'rec' : 'recoff'); };
    (r ? (r.state === 'recording' ? D.stop(r) : D.cancel(r)) : D.record(c, p)).then(done);
  };

  // ------------------------------------------------------------ the player's menu, on a channel
  V.playerMenuExtras = (function (prev) {
    return function (p, main, pages) {
      if (prev) prev(p, main, pages);
      var it = p.it;
      if (!it || (it.t !== 'live' && it.t !== 'radio') || !D.can()) return;
      var r = D.recordingNow(it);
      main.push({ label: r ? 'Stop recording' : 'Record this', value: r ? '● ' + (r.state === 'waiting' ? 'Waiting' : 'On') : '', fn: function () { if (r) D.stop(r); else D.recordNow(it); } });
    };
  })(V.playerMenuExtras);

  // ------------------------------------------------------------ the Recordings page
  var stateText = { scheduled: 'Coming up', waiting: 'Waiting for a free connection', recording: 'Recording', saving: 'Saving…', done: '', failed: 'Didn’t work' };
  function row(r) {
    var c = V.entry(r.k);
    var logo = c && c.logo ? '<img class="dvr-logo" src="' + V.esc(c.logo) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<span class="dvr-logo dvr-ph">' + V.icon('tv') + '</span>';
    var meta = [r.ch || (c && c.n) || '', when(r)];
    if (r.state === 'done') { if (r.size) meta.push(V.fmtSize(r.size)); if (r.drops) meta.push('the stream dropped ' + V.plural(r.drops, 'time')); }
    if (r.who) meta.unshift(r.who);
    var acts = '';
    if (r.state === 'done') acts = '<button class="btn sm primary" data-d="play" data-id="' + r.id + '">' + V.icon('play') + ' Play</button><button class="icon-btn sm' + (r.keep ? ' on' : '') + '" data-d="keep" data-id="' + r.id + '" aria-pressed="' + r.keep + '" aria-label="Keep (never delete automatically)" title="Keep">' + V.icon(r.keep ? 'bookmark' : 'bookmark') + '</button>';
    else if (r.state === 'recording') acts = '<button class="btn sm" data-d="stop" data-id="' + r.id + '">Stop</button>';
    acts += '<button class="icon-btn sm" data-d="del" data-id="' + r.id + '" aria-label="' + (r.state === 'done' ? 'Delete' : 'Cancel') + ' ' + V.esc(r.t) + '">' + V.icon(r.state === 'done' || r.state === 'failed' ? 'trash' : 'x') + '</button>';
    return '<li class="dvr-row s-' + r.state + '">' + logo + '<div class="grow"><b>' + V.esc(r.t) + '</b>' + (r.st ? ' <span class="dim">· ' + V.esc(r.st) + '</span>' : '') +
      '<div class="dim small">' + meta.filter(Boolean).map(V.esc).join(' · ') + '</div>' +
      (stateText[r.state] ? '<div class="small dvr-st">' + (r.state === 'recording' ? '<span class="dvr-dot"></span>' : '') + V.esc(stateText[r.state]) + (r.state === 'failed' && r.err ? ': ' + V.esc(r.err) : r.state === 'waiting' && r.err && !/^Waiting/.test(r.err) ? ' (' + V.esc(r.err) + ')' : '') + '</div>' : '') +
      '</div><div class="dvr-acts">' + acts + '</div></li>';
  }
  V.route('recordings', function (view) {
    view.innerHTML = V.pageHead('Recordings', '<div class="page-tools"><a class="btn" href="#/guide">' + V.icon('clock') + ' TV guide</a></div>') + '<div class="dvr-body"><div class="spinner"></div></div>';
    var body = V.$('.dvr-body', view);
    var draw = function () {
      var s = D.state;
      if (!s) { body.innerHTML = '<p class="err">Couldn’t load your recordings.</p>'; return; }
      var recs = s.recs.slice();
      var now = recs.filter(function (r) { return r.state === 'recording' || r.state === 'saving' || (r.state === 'waiting' && r.s <= Date.now()); });
      var next = recs.filter(function (r) { return (r.state === 'scheduled' || r.state === 'waiting') && now.indexOf(r) < 0; }).sort(function (a, b) { return a.s - b.s; });
      var made = recs.filter(function (r) { return r.state === 'done'; }).sort(function (a, b) { return b.s - a.s; });
      var bad = recs.filter(function (r) { return r.state === 'failed'; }).sort(function (a, b) { return b.s - a.s; });
      var sec = function (title, list, empty) { return list.length || empty ? '<section class="dvr-sec"><h2>' + title + (list.length ? ' <span class="dim">' + list.length + '</span>' : '') + '</h2>' + (list.length ? '<ul class="dvr-list">' + list.map(row).join('') + '</ul>' : '<p class="dim">' + empty + '</p>') + '</section>' : ''; };
      var note = !s.can ? '<p class="note">' + V.icon('info') + ' <span>' + (s.access === 'off' ? 'Recording is turned off' : 'Only priority profiles can record') + (S.profile.admin ? ' (<a href="#/admin/dvr">Admin → DVR</a>).' : '. Your recordings stay here to watch.') + '</span></p>'
        : !s.ffmpeg ? '<p class="note warn">' + V.icon('info') + ' <span>Recording needs ffmpeg on the server.</span></p>'
        : '<p class="dim">Record from the <a href="#/guide">TV guide</a> or a channel’s schedule (' + V.icon('recoff', 'tiny') + '), or with “Record this” in the player’s ' + V.icon('gear', 'tiny') + ' menu while you watch a channel.</p>';
      body.innerHTML = note + sec('Recording now', now) + sec('Coming up', next, s.can ? 'Nothing scheduled.' : '') +
        (s.rules.length ? '<section class="dvr-sec"><h2>Every episode of</h2><ul class="dvr-list">' + s.rules.map(function (x) { return '<li class="dvr-row"><span class="dvr-logo dvr-ph">' + V.icon('refresh') + '</span><div class="grow"><b>' + V.esc(x.t) + '</b><div class="dim small">' + V.esc([x.who, x.ch].filter(Boolean).join(' · ')) + '</div></div><div class="dvr-acts"><button class="icon-btn sm" data-d="rule" data-id="' + x.id + '" aria-label="Stop recording every ' + V.esc(x.t) + '">' + V.icon('x') + '</button></div></li>'; }).join('') + '</ul></section>' : '') +
        sec('Recorded', made, 'No recordings yet.') + sec('Didn’t work', bad);
    };
    body.onclick = function (e) {
      var b = e.target.closest('[data-d]');
      if (!b) return;
      var id = b.dataset.id, a = b.dataset.d;
      if (a === 'rule') { V.del('/api/dvr/rules/' + id).then(D.load).then(draw).catch(V.fail); return; }
      var r = (D.state.recs || []).filter(function (x) { return x.id === id; })[0];
      if (!r) return;
      if (a === 'play') D.play(r);
      else if (a === 'stop') D.stop(r).then(draw);
      else if (a === 'del') D.cancel(r).then(draw);
      else if (a === 'keep') V.put('/api/dvr/' + id, { keep: !r.keep }).then(function (x) { V.toast(x.keep ? 'Kept: it won’t be deleted automatically' : 'It can be deleted automatically again'); return D.load(); }).then(draw).catch(V.fail);
    };
    D.load().then(draw);
    // While something records or is saved, keep it current; and redraw whenever the recordings change (a recording
    // finished or failed while the page is open).
    var off = V.on('dvr-state', function () { if (document.documentElement.contains(view)) draw(); });
    var t = setInterval(function () { if (!document.documentElement.contains(view)) { clearInterval(t); off(); return; } if (D.state && D.state.recs.some(live)) D.load(); }, 15000);
    V.pageCleanup = function () { clearInterval(t); off(); };
  });

  // ------------------------------------------------------------ Admin → DVR
  (V.adminExtraTabs = V.adminExtraTabs || []).push(['dvr', 'DVR', 'playback']);
  V.adminTabs.dvr = function (body) {
    body.innerHTML = '<div class="spinner"></div>';
    var draw = function (a) {
      var c = a.config, u = a.usage;
      var opt = function (v, label, hint) { return '<label class="check"><input type="radio" name="dvr-access" value="' + v + '"' + (c.access === v ? ' checked' : '') + '><span><b>' + label + '</b> — ' + hint + '</span></label>'; };
      body.innerHTML = '<section class="card-sec"><h2>Who can record</h2>' + (!a.ffmpeg ? '<p class="note warn">' + V.icon('info') + ' <span>Recording needs ffmpeg on the server (the Docker image includes it).</span></p>' : '') +
        opt('everyone', 'Everyone', 'Every profile can record from the guide and the player.') + opt('priority', 'Priority profiles only', 'Priority profiles and admins can record; others can still watch what they recorded before.') + opt('off', 'Nobody', 'Recording is off. Recordings already made can still be watched.') +
        '<p class="dim small">A recording uses one connection to the channel’s provider while it runs, like someone watching. Nobody can take it over; when no connection is free it waits.</p></section>' +
        '<section class="card-sec"><h2>Storage</h2><dl class="kv"><dt>Recordings</dt><dd>' + V.plural(u.count, 'recording') + ' · ' + V.fmtSize(u.bytes) + '</dd><dt>Free space</dt><dd>' + V.fmtSize(u.free) + '</dd><dt>Now</dt><dd>' + (a.running ? V.plural(a.running, 'recording') + ' running' : 'Nothing recording') + (a.scheduled ? ' · ' + a.scheduled + ' coming up' : '') + '</dd></dl>' +
        '<label class="field"><span>Folder on the server</span><input class="input" data-dvr="dir" value="' + V.esc(c.dir) + '" placeholder="' + V.esc(a.defaultDir) + '"><small class="dim">Empty: in the data folder. With Docker, a folder you mounted (for example /media/recordings).</small></label><div class="grid2">' +
        '<label class="field"><span>Keep recordings for</span><select class="input" data-dvr="keepDays">' + [[0, 'Until deleted'], [7, '1 week'], [14, '2 weeks'], [30, '1 month'], [90, '3 months'], [365, '1 year']].map(function (o) { return '<option value="' + o[0] + '"' + (+c.keepDays === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
        '<label class="field"><span>Most space they may use (GB)</span><input class="input" type="number" min="0" data-dvr="maxGB" value="' + (c.maxGB || '') + '" placeholder="No limit"><small class="dim">The oldest go first. Ones marked “keep” stay.</small></label>' +
        '<label class="field"><span>Start early (minutes)</span><input class="input" type="number" min="0" max="30" data-dvr="pre" value="' + c.pre + '"></label>' +
        '<label class="field"><span>End late (minutes)</span><input class="input" type="number" min="0" max="120" data-dvr="post" value="' + c.post + '"></label></div>' +
        '<div class="btn-row"><button class="btn primary" data-dvr-save>Save</button><a class="btn" href="#/recordings">All recordings</a></div></section>';
    };
    var load = function () { return V.api('/api/admin/dvr').then(draw).catch(function (e) { body.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; }); };
    body.onchange = function (e) {
      if (e.target.name === 'dvr-access') V.put('/api/admin/dvr', { access: e.target.value }).then(function (a) { V.toast({ everyone: 'Everyone can record', priority: 'Only priority profiles can record', off: 'Recording is off' }[a.config.access]); draw(a); D.load(); }).catch(V.fail);
    };
    body.onclick = function (e) {
      if (!e.target.closest('[data-dvr-save]')) return;
      var patch = {};
      V.$$('[data-dvr]', body).forEach(function (x) { patch[x.dataset.dvr] = x.dataset.dvr === 'dir' ? x.value.trim() : Number(x.value) || 0; });
      V.put('/api/admin/dvr', patch).then(function (a) { V.toast('Saved'); draw(a); }).catch(V.fail);
    };
    load();
  };

  // ------------------------------------------------------------ staying current
  V.on('me', function () { if (!D.state || D.state.pid !== (S.profile && S.profile.id)) D.load().then(function (s) { if (s) s.pid = S.profile.id; }); });
  V.on('rt:connected', function () { D.load(); });
  V.on('dvr', function (d) {
    D.load();
    if (d.what === 'done') V.toast('Recorded “' + d.t + '”', { action: { label: 'Play', fn: function () { var r = (D.state.recs || []).filter(function (x) { return x.id === d.id; })[0]; if (r) D.play(r); } } });
    else if (d.what === 'failed') V.toast('Couldn’t record “' + d.t + '”' + (d.err ? ': ' + d.err : ''), { error: true, ms: 9000 });
  });
})();
