/* Screen time (set by the admin in Admin → Profiles): how much is left (on Home, and in the player near the end),
   warnings at 5 and 1 minute, a friendly "That's all for today" screen, "Ask for more time", and the admin's side:
   the limits, bedtime, extra time and answering requests. The server keeps count and enforces it (lib/routes-p11.js);
   this only shows it and stops the player when told. */
'use strict';
(function () {
  var st = null, gotAt = 0, pid = '', warned = {}, endShown = null;

  var fmtMin = function (m) {
    m = Math.max(0, Math.round(m));
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return h + ' h' + (r ? ' ' + r + ' min' : '');
  };
  var limited = function () { return !!(st && st.limited && S.profile && !S.profile.admin); };
  /** "45 min of TV left today", "Bedtime at 19:30 · 20 min left". */
  var leftText = function (s) {
    if (s.blocked) return s.reason === 'limit' ? 'No more TV today' : s.reason === 'early' ? 'TV from ' + (s.nextAtText || s.from) : 'It’s past bedtime';
    if (s.left === null) return s.bedtime ? 'Bedtime at ' + s.bedtime : 'No limit today';
    if (s.reason === 'bedtime' && s.bedtime) return fmtMin(s.left) + ' until bedtime (' + s.bedtime + ')';
    return fmtMin(s.left) + ' of TV left today';
  };

  function load() {
    if (!S.profile) return Promise.resolve(null);
    return V.api('/api/screentime').then(apply, function () { return null; });
  }
  function apply(s) {
    if (!s || s.ask || s.answered) return st;
    var was = st;
    st = s; gotAt = Date.now(); pid = S.profile ? S.profile.id : '';
    if (!limited()) { warned = {}; draw(); return st; }
    // Warnings: 5 and 1 minute(s) left (again after more time was given).
    if (s.left !== null && !s.blocked) {
      if (s.left > 5) warned = {};
      [5, 1].forEach(function (n) {
        if (s.left <= n && !warned[n] && (V.watch && V.watch.it || n === 5)) {
          warned[n] = true;
          V.toast((n === 1 ? '1 minute' : '5 minutes') + (s.reason === 'bedtime' ? ' until bedtime.' : ' of TV left today.') + (n === 1 ? ' Time to say goodbye!' : ''), { ms: 9000, action: !s.asked ? { label: 'Ask for more time', fn: V.screenTime.ask } : null });
        }
        if (s.left <= n) warned[n] = true;
      });
    }
    if (s.granted) { V.toast('You’ve got ' + fmtMin(s.granted) + ' more today.', { ms: 8000 }); closeEnd(); }
    if (s.declined) V.toast('Not today, sorry — no more time.', { ms: 8000 });
    if (s.blocked) {
      var watching = V.watch && V.watch.it || V.multiview && V.multiview.active;
      if (s.stop || watching || !was || !was.blocked) {
        if (V.watch && V.watch.it) V.closePlayer();
        if (V.multiview && V.multiview.active && /^#\/multiview/.test(location.hash)) V.router.go('#/home');
        if (s.stop || watching || (was && was.limited && !was.blocked)) showEnd();
      }
    } else closeEnd();
    draw();
    return st;
  }

  // ------------------------------------------------------------ notes on Home and in the player
  function draw() {
    placeNote();
    var hn = V.$('#st-home');
    if (hn) {
      if (!limited()) hn.remove();
      else {
        hn.className = 'st-note' + (hn.classList.contains('top') ? ' top' : '') + (st.blocked ? ' done' : st.left !== null && st.left < 15 ? ' low' : '');
        V.$('.st-t', hn).textContent = leftText(st);
        var ab = V.$('[data-st-ask]', hn);
        ab.hidden = !(st.blocked || st.left !== null && st.left < 15) || st.asked;
        V.$('.st-asked', hn).hidden = !st.asked;
      }
    }
    var layer = V.$('#player-layer');
    if (!layer) return;
    var pn = V.$('#st-player');
    var show = limited() && !st.blocked && st.left !== null && st.left < 15;
    if (!show) { if (pn) pn.remove(); return; }
    if (!pn) { pn = document.createElement('div'); pn.id = 'st-player'; pn.setAttribute('role', 'status'); layer.appendChild(pn); }
    pn.innerHTML = V.icon('clock') + '<span>' + V.esc(st.reason === 'bedtime' ? fmtMin(st.left) + ' until bedtime' : fmtMin(st.left) + ' left today') + '</span>';
  }
  var homeNote = function () {
    if (!limited()) return null;
    var d = document.createElement('div');
    d.id = 'st-home';
    d.setAttribute('role', 'status');
    d.innerHTML = V.icon('clock') + '<span class="st-t"></span><span class="st-asked dim small" hidden>· asked for more time</span><button class="btn sm" data-st-ask hidden>Ask for more time</button>';
    V.$('[data-st-ask]', d).onclick = function () { V.screenTime.ask(); };
    return d;
  };
  /** Puts the note on Home (when there's a limit and it isn't there yet). */
  function placeNote() {
    var view = V.$('#view');
    if (!view || document.body.dataset.page !== 'home' || V.$('#st-home', view)) return;
    var n = homeNote();
    if (!n) return;
    // Under the big title (with the rows), or at the top when there isn't one.
    var rows = V.$('.rows', view);
    if (rows && V.$('.hero, .moods', view)) rows.parentNode.insertBefore(n, rows);
    else { n.classList.add('top'); var h1 = V.$('h1', view); view.insertBefore(n, h1 ? h1.nextSibling : view.firstChild); }
  }
  var origHome = V.routes.home;
  V.routes.home = function (view, r) {
    origHome(view, r);
    draw();
  };

  // ------------------------------------------------------------ "That's all for today"
  function showEnd() {
    if (endShown || !limited()) return;
    var s = st;
    var title = s.reason === 'limit' ? 'That’s all for today' : s.reason === 'early' ? 'It’s a bit early for TV' : 'Time for bed';
    var sub = s.reason === 'limit' ? (s.allowance ? 'You’ve watched your ' + fmtMin(s.allowance) + ' for today.' : 'There’s no TV time today.') + ' See you tomorrow!' : s.reason === 'early' ? 'TV starts at ' + (s.nextAtText || s.from) + '.' : 'Sleep well! TV is back at ' + (s.nextAtText || s.from) + '.';
    endShown = V.dialog({
      cls: 'st-end',
      body: '<div class="st-end-b"><div class="st-moon">' + V.icon(s.reason === 'limit' ? 'smile' : 'moon') + '</div><h2>' + V.esc(title) + '</h2><p>' + V.esc(sub) + '</p>' +
        '<p class="dim small st-end-asked"' + (s.asked ? '' : ' hidden') + '>You’ve asked for more time. If it’s a yes, you’ll see it here.</p>' +
        '<div class="btn-row center">' + '<button class="btn primary" data-end="ok">OK</button>' + (s.asked ? '' : '<button class="btn" data-end="ask">Ask for more time</button>') + '<button class="btn" data-end="switch">Switch profile</button></div></div>',
      onOpen: function (d, finish) {
        d.setAttribute('aria-label', title);
        d.addEventListener('click', function (e) {
          var b = e.target.closest('[data-end]');
          if (!b) return;
          if (b.dataset.end === 'ok') finish();
          else if (b.dataset.end === 'switch') { finish(); V.leaveProfile(); }
          else V.screenTime.ask().then(function (ok) { if (ok) { b.remove(); V.$('.st-end-asked', d).hidden = false; } });
        });
      },
    });
    var mine = endShown;
    endShown.then(function () { if (endShown === mine) endShown = null; });
  }
  function closeEnd() {
    var d = V.$('dialog.st-end');
    if (d && d._finish) d._finish();
    endShown = null;
  }

  // ------------------------------------------------------------ asking for more time
  function ask() {
    if (!limited()) return Promise.resolve(false);
    return V.dialog({
      title: 'Ask for more time',
      body: '<p class="dim">The admin sees it straight away and can say yes from any device.</p>' +
        '<div class="chips st-ask-m" role="group" aria-label="How much more">' + [15, 30, 60].map(function (m, i) { return '<label class="chip-check"><input type="radio" name="stm" value="' + m + '"' + (i === 1 ? ' checked' : '') + '><span>' + fmtMin(m) + '</span></label>'; }).join('') + '</div>' +
        '<label class="field"><span>Why? (optional)</span><input class="input" data-note maxlength="200" placeholder="Just the end of this episode"></label>',
      actions: [{ label: 'Cancel', value: false }, { label: 'Ask', primary: true, fn: function (d) {
        var m = V.$('[name=stm]:checked', d);
        return V.api('/api/screentime/ask', { body: { minutes: m ? +m.value : 30, note: V.$('[data-note]', d).value } }).then(function (s) { apply(s); V.toast('Asked. You’ll see the answer here.'); return true; });
      } }],
    }).then(function (v) { return !!v; });
  }

  // ------------------------------------------------------------ playing while time is up: the screen instead
  var origPlay = V.play;
  V.play = function (it) {
    if (limited() && st.blocked && it) { showEnd(); return; }
    return origPlay.apply(this, arguments);
  };
  V.on('screentime', function (d) {
    if (d && d.ask) return askedAdmin(d.ask);
    if (d && d.answered) return closeAsk(d.answered);
    if (S.profile && !S.profile.admin) apply(d);
  });
  // A new profile, or back after a while: ask how things stand.
  V.on('me', function () { if (S.profile && (S.profile.id !== pid || Date.now() - gotAt > 60e3)) { if (S.profile.id !== pid) { st = null; warned = {}; } load(); } });
  V.on('rt:connected', function () {
    load();
    // The admin: requests that came in while this device was closed.
    if (S.profile && S.profile.admin) V.api('/api/admin/screentime/pending').then(function (list) { list.forEach(askedAdmin); }).catch(function () {});
  });
  setInterval(function () { if (limited() && document.visibilityState !== 'hidden') load(); }, 60e3);
  // (A playback refusal from the server says why: show the screen.)
  V.on('stopped', function () { draw(); });
  V.on('playing', function () { setTimeout(draw, 50); });

  // ------------------------------------------------------------ the admin: someone asked for more time
  // One pop-up per request, with the answer right there. It stays until it's answered (here or on another device)
  // or put off with ×; requests put off come back when the app is next opened.
  var asks = {};
  function askedAdmin(a) {
    if (!S.profile || !S.profile.admin || asks[a.id] || (V.ls.session('stLater') || []).indexOf(a.id) >= 0) return;
    var box = V.$('#toasts');
    if (!box) return;
    var t = document.createElement('div');
    t.className = 'toast st-ask-toast';
    t.setAttribute('role', 'alert');
    t.innerHTML = '<span>' + V.icon('clock') + ' <b>' + V.esc(a.name) + '</b> asks for ' + V.esc(fmtMin(a.minutes)) + ' more' + (a.note ? ': “' + V.esc(a.note) + '”' : '') + '</span>' +
      '<button class="toast-act" data-give>Give ' + V.esc(fmtMin(a.minutes)) + '</button><button class="toast-act" data-no>Not today</button><button class="toast-x" aria-label="Answer later">' + V.icon('x') + '</button>';
    asks[a.id] = t;
    var busy = false;
    var go = function (ok) {
      if (busy) return;
      busy = true;
      answer(a.id, ok, ok ? a.minutes : 0).then(function () { closeAsk(a.id); }, function (e) { busy = false; V.fail(e); });
    };
    V.$('[data-give]', t).onclick = function () { go(true); };
    V.$('[data-no]', t).onclick = function () { go(false); };
    V.$('.toast-x', t).onclick = function () { V.ls.session('stLater', (V.ls.session('stLater') || []).concat([a.id]).slice(-50)); closeAsk(a.id); };
    box.appendChild(t);
  }
  function closeAsk(id) {
    var t = asks[id];
    delete asks[id];
    if (!t) return;
    t.classList.add('out');
    setTimeout(function () { t.remove(); }, 250);
  }
  function answer(id, ok, minutes) {
    return V.api('/api/admin/screentime/requests/' + encodeURIComponent(id), { body: { ok: ok, minutes: minutes } }).then(function () {
      V.toast(ok ? 'Done — ' + fmtMin(minutes) + ' more today.' : 'Answered: not today.');
      if (/^#\/admin\/profiles/.test(location.hash)) V.router.refresh();
    });
  }

  // ------------------------------------------------------------ Admin → Profiles: screen time for each profile
  var LIMITS = [['', 'No daily limit'], ['0', 'None at all'], ['15', '15 min'], ['30', '30 min'], ['45', '45 min'], ['60', '1 hour'], ['90', '1 h 30 min'], ['120', '2 hours'], ['150', '2 h 30 min'], ['180', '3 hours'], ['240', '4 hours'], ['300', '5 hours'], ['360', '6 hours']];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var dayRow = function (key, label, d) {
    d = d || {};
    var lim = d.limit === null || d.limit === undefined ? '' : String(d.limit);
    var opts = LIMITS.slice();
    if (lim && !opts.some(function (o) { return o[0] === lim; })) opts.push([lim, fmtMin(+lim)]);
    return '<div class="st-day" data-day="' + key + '"><b class="st-dl">' + V.esc(label) + '</b>' +
      '<label class="field"><span>Daily limit</span><select class="input" data-f="limit">' + opts.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === lim ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>Allowed from</span><input class="input" type="time" data-f="from" value="' + V.esc(d.from || '') + '" placeholder="07:00"></label>' +
      '<label class="field"><span>Bedtime</span><input class="input" type="time" data-f="to" value="' + V.esc(d.to || '') + '" placeholder="19:30"></label></div>';
  };
  var groupsHtml = function (mode, days) {
    days = days || [];
    if (mode === 'same') return dayRow('same', 'Every day', days[1]);
    if (mode === 'each') return DAYS.map(function (n, i) { return dayRow(String(i), n, days[i]); }).join('');
    return dayRow('school', 'School days (Mon–Fri)', days[1]) + dayRow('weekend', 'Weekends (Sat, Sun)', days[6] || days[0]);
  };
  var summary = function (x) {
    var r = x.rule;
    if (!r || !r.on) return 'Off';
    var s = x.state || {};
    var one = function (d) { d = d || {}; return [d.limit === null || d.limit === undefined ? 'no daily limit' : fmtMin(d.limit), d.to ? 'bedtime ' + d.to : ''].filter(Boolean).join(', '); };
    var bits = [r.mode === 'same' ? 'Every day: ' + one(r.days[1]) : r.mode === 'week' ? 'School days: ' + one(r.days[1]) + ' · weekends: ' + one(r.days[6]) : 'Different each day'];
    if (s.limited) bits.push('today ' + fmtMin(s.used) + (s.blocked ? ' (time’s up)' : s.left !== null ? ', ' + fmtMin(s.left) + ' left' : ''));
    return bits.join(' · ');
  };
  var ZONES = null;
  /** The time zone: a dropdown like the others (a text box on browsers that can't list zones). */
  var tzField = function (cur, server) {
    if (ZONES === null) { ZONES = []; try { if (Intl.supportedValuesOf) ZONES = Intl.supportedValuesOf('timeZone'); } catch (e) {} }
    if (!ZONES.length) return '<input class="input" data-st-tz value="' + V.esc(cur) + '" placeholder="The server’s: ' + V.esc(server) + '" autocomplete="off" spellcheck="false">';
    var list = ZONES.indexOf(cur) < 0 && cur ? [cur].concat(ZONES) : ZONES;
    return '<select class="input" data-st-tz><option value="">The server’s (' + V.esc(server) + ')</option>' + list.map(function (z) { return '<option value="' + V.esc(z) + '"' + (z === cur ? ' selected' : '') + '>' + V.esc(z.replace(/_/g, ' ')) + '</option>'; }).join('') + '</select>';
  };
  function stBox(p, x, tz) {
    var r = x.rule || { on: false, mode: 'week', days: [], tz: '' };
    var s = x.state || {};
    var week = (x.week || []).map(function (w) { var d = new Date(w.day + 'T12:00:00'); return '<span class="st-wk"><b>' + V.esc(DAYS[d.getDay()].slice(0, 3)) + '</b> ' + fmtMin(w.min) + '</span>'; }).join('');
    var reqs = (x.requests || []).map(function (q) { return '<div class="st-req" data-req="' + V.esc(q.id) + '">' + V.icon('bell') + '<span>Asked for <b>' + fmtMin(q.minutes) + '</b> more' + (q.note ? ' — “' + V.esc(q.note) + '”' : '') + '</span><button class="btn sm primary" data-st-yes="' + q.minutes + '">Give ' + fmtMin(q.minutes) + '</button><button class="btn sm" data-st-no>Not today</button></div>'; }).join('');
    return '<details class="st-box"' + (reqs ? ' open' : '') + '><summary><span>' + V.icon('clock') + ' Screen time</span><small class="dim st-sum">' + V.esc(summary(x)) + '</small>' + (reqs ? ' <span class="chip sm warn">Asked for more time</span>' : '') + '</summary>' +
      reqs +
      '<label class="switch"><input type="checkbox" data-st-on' + (r.on ? ' checked' : '') + '><span class="sw"></span><span><b>Limit screen time</b><small>Counted on the server: every device, watch party and multiview together, once a minute.</small></span></label>' +
      '<div class="st-rules"' + (r.on ? '' : ' hidden') + '>' +
      '<label class="field"><span>Rules for</span><select class="input" data-st-mode><option value="same"' + (r.mode === 'same' ? ' selected' : '') + '>Every day the same</option><option value="week"' + (r.mode === 'week' ? ' selected' : '') + '>School days and weekends</option><option value="each"' + (r.mode === 'each' ? ' selected' : '') + '>Each day of the week</option></select></label>' +
      '<div class="st-days">' + groupsHtml(r.mode, r.days) + '</div>' +
      '<p class="dim small">Leave the times empty for no bedtime. Bedtime lasts until the “allowed from” time (06:00 if empty).</p>' +
      '<label class="field"><span>Time zone</span>' + tzField(r.tz || '', tz) + '</label>' +
      '<p class="dim small">Saved with the profile’s other limits (<b>Save limits</b> below).</p>' +
      (s.limited ? '<div class="st-today"><h4>Today</h4><p>' + V.esc(fmtMin(s.used) + ' watched' + (s.extra ? ' (with ' + fmtMin(s.extra) + ' extra)' : '') + ' · ' + leftText(Object.assign({}, s, { nextAtText: s.nextAtText }))) + '</p>' +
        '<div class="btn-row"><span class="dim small">Extra time today:</span><button class="btn sm" data-st-grant="15">+15 min</button><button class="btn sm" data-st-grant="30">+30 min</button><button class="btn sm" data-st-grant="60">+1 hour</button><button class="btn sm ghost" data-st-reset>Back to normal</button></div>' +
        (week ? '<div class="st-week"><span class="dim small">Last days:</span> ' + week + '</div>' : '') + '</div>' : '') +
      '</div></details>';
  }
  var readRule = function (box) {
    var mode = V.$('[data-st-mode]', box).value;
    var day = function (key) { var el = V.$('[data-day="' + key + '"]', box); if (!el) return null; var lim = V.$('[data-f=limit]', el).value; return { limit: lim === '' ? null : +lim, from: V.$('[data-f=from]', el).value, to: V.$('[data-f=to]', el).value }; };
    var r = { on: V.$('[data-st-on]', box).checked, mode: mode, tz: V.$('[data-st-tz]', box).value.trim() };
    if (mode === 'same') r.same = day('same');
    else if (mode === 'week') { r.school = day('school'); r.weekend = day('weekend'); }
    else r.days = DAYS.map(function (n, i) { return day(String(i)); });
    return r;
  };
  var origProfiles = V.adminTabs.profiles;
  V.adminTabs.profiles = function (body, A) {
    origProfiles(body, A);
    V.api('/api/admin/screentime').then(function (X) {
      V.$$('.adm-profiles > li[data-id]', body).forEach(function (li) {
        var x = X.profiles[li.dataset.id];
        if (!x) return;
        var row = V.$('.btn-row', li);
        var host = document.createElement('div');
        host.className = 'st-host';
        host.innerHTML = stBox(null, x, X.tz);
        li.insertBefore(host, row);
      });
      body.addEventListener('change', function (e) {
        var box = e.target.closest('.st-box');
        if (!box) return;
        if (e.target.hasAttribute('data-st-on')) V.$('.st-rules', box).hidden = !e.target.checked;
        if (e.target.hasAttribute('data-st-mode')) {
          // Keep what was set when switching between "same", "school days and weekends" and "each day" (read from
          // the rows still showing, i.e. the old choice).
          var was = V.$('[data-day=same]', box) ? 'same' : V.$('[data-day=school]', box) ? 'week' : 'each';
          var sel = e.target, nowMode = sel.value;
          sel.value = was;
          var cur = readRule(box), days = [];
          sel.value = nowMode;
          for (var i = 0; i < 7; i++) days.push(cur.same || (cur.school ? (i === 0 || i === 6 ? cur.weekend : cur.school) : (cur.days || [])[i]));
          V.$('.st-days', box).innerHTML = groupsHtml(e.target.value, days);
        }
      });
      // One Save for the card: "Save limits" saves the screen time too (admin.js saves the rest and says so).
      body.addEventListener('click', function (e) {
        var sv = e.target.closest('[data-save]');
        var li = sv && sv.closest('[data-id]');
        var box = li && V.$('.st-box', li);
        if (!box) return;
        var id = li.dataset.id, rule = readRule(box), had = X.profiles[id] && X.profiles[id].rule;
        if (!rule.on && !had) return; // (never set up: nothing to save)
        var wasOpen = box.open;
        V.put('/api/admin/screentime/' + id, { rule: rule }).then(function (x) { var h = box.parentNode; h.innerHTML = stBox(null, x, X.tz); if (wasOpen) V.$('.st-box', h).open = true; X.profiles[id] = x; }).catch(V.fail);
      });
      body.addEventListener('click', function (e) {
        var box = e.target.closest('.st-box');
        if (!box) return;
        var li = box.closest('[data-id]'), id = li.dataset.id;
        var btn = e.target.closest('[data-st-grant], [data-st-reset], [data-st-yes], [data-st-no]');
        if (!btn || box._busy) return;
        box._busy = true; // (a double click doesn't give the extra time twice)
        var free = function (err) { box._busy = false; V.fail(err); };
        // (Drawn again with the answer, still open, with the focus on the same button for a remote.)
        var done = function (x) { var h = box.parentNode, sel = btn.hasAttribute('data-st-grant') ? '[data-st-grant="' + btn.dataset.stGrant + '"]' : '[data-st-reset]'; h.innerHTML = stBox(null, x, X.tz); var nb = V.$('.st-box', h); nb.open = true; X.profiles[id] = x; var f = V.$(sel, nb); if (f) f.focus(); return x; };
        if (btn.hasAttribute('data-st-grant')) {
          var m = +btn.dataset.stGrant;
          V.api('/api/admin/screentime/' + id + '/grant', { body: { minutes: m } }).then(function (x) { done(x); V.toast('Gave ' + fmtMin(m) + ' more today'); }, free);
        } else if (btn.hasAttribute('data-st-reset')) {
          V.api('/api/admin/screentime/' + id + '/reset', { body: {} }).then(function (x) { done(x); V.toast('Back to the normal limits for today'); }, free);
        } else {
          // (answer() draws the page again itself.)
          var q = btn.closest('[data-req]'), yes = btn.hasAttribute('data-st-yes');
          answer(q.dataset.req, yes, yes ? +btn.dataset.stYes : 0).catch(free);
        }
      });
    }).catch(function () {});
  };

  V.screenTime = { state: function () { return st; }, load: load, ask: ask, limited: limited, showEnd: showEnd, fmt: fmtMin };
})();
