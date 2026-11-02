/* Following teams and competitions: the Events row on Home and section in On later (live first, then what's next,
   on the best channel you can watch), the Follow button on sports programmes, the "Teams you follow" page, and the
   admin's event-channel switches. The server does the matching (lib/routes-p8.js). */
'use strict';
(function () {
  var conf = null, confAt = 0, confP = null;
  var evCache = null;

  // ---------------------------------------------------------------- data
  var getConf = function (force) {
    var who = S.profile && S.profile.id;
    if (!force && conf && conf.pid === who && Date.now() - confAt < 60e3) return Promise.resolve(conf);
    if (confP) return confP;
    confP = V.api('/api/follow').then(function (c) { c.pid = who; conf = c; confAt = Date.now(); return c; }).then(function (c) { confP = null; return c; }, function (e) { confP = null; throw e; });
    return confP;
  };
  var setConf = function (c) { c.pid = S.profile && S.profile.id; conf = c; confAt = Date.now(); evCache = null; };
  var nk = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
  var follows = function (kind, n) { var list = conf ? conf[kind === 'comp' ? 'comps' : 'teams'] : []; return list.some(function (x) { return nk(x) === nk(n); }); };
  var toggle = function (kind, n, on) {
    return V.api('/api/follow/toggle', { body: { kind: kind, n: n, on: on } }).then(function (c) {
      setConf(c);
      V.toast(c.on ? 'Following ' + n + (kind === 'team' && c.auto ? '. You’ll get a reminder before their games.' : '') : 'Stopped following ' + n);
      return c.on;
    });
  };
  var loadEvents = function (force) {
    var who = S.profile && S.profile.id;
    if (!force && evCache && evCache.pid === who && Date.now() - evCache.at < 60e3) return Promise.resolve(evCache.v);
    return V.api('/api/follow/events').then(function (v) { evCache = { pid: who, at: Date.now(), v: v }; return v; });
  };
  V.follow = { conf: getConf, toggle: toggle, events: loadEvents, follows: function (kind, n) { return follows(kind, n); } };

  /** Is this programme sport (so it gets a Follow button)? */
  V.isSportProg = function (c, p) {
    if (!p || p.ph) return false;
    if (V.progKind(p) === 'sport') return true;
    if (c && c.evc && p.c && [].concat(p.c).join(' ').indexOf('Event') >= 0) return /\s(vs?\.?|@|at|x)\s/i.test(' ' + p.t + ' ') || !!p.st;
    return !(p.c && p.c.length) && /\s(vs?\.?|@)\s/i.test(' ' + p.t + ' ');
  };

  // ---------------------------------------------------------------- the Follow dialog (from a programme)
  V.followDialog = function (p) {
    var q = '?t=' + encodeURIComponent(p.t || '') + (p.st ? '&st=' + encodeURIComponent(p.st) : '') + (p.c ? '&c=' + encodeURIComponent([].concat(p.c).join('|')) : '');
    return Promise.all([V.api('/api/follow/about' + q), getConf()]).then(function (r) {
      var a = r[0];
      var opts = a.teams.map(function (n) { return { kind: 'team', n: n }; });
      if (a.comp) opts.push({ kind: 'comp', n: a.comp });
      var chip = function (o, i) {
        var on = follows(o.kind, o.n);
        return '<button class="chip fol-chip" data-i="' + i + '" aria-pressed="' + on + '">' + V.icon(on ? 'starf' : 'star') + '<span>' + V.esc(o.n) + '</span>' + (o.kind === 'comp' ? '<small>competition</small>' : '') + '</button>';
      };
      return V.dialog({
        title: 'Follow',
        body: '<p class="dim">' + V.esc(p.t) + '</p>' + (opts.length ? '<p>Get this on Home and in On later, with reminders for your teams’ games:</p><div class="chips fol-opts" role="group" aria-label="Follow">' + opts.map(chip).join('') + '</div>' : '<p>I couldn’t tell which teams play in this one. You can look for them on the next page.</p>'),
        actions: [{ label: 'Teams you follow…', fn: function () { V.router.go('#/follow'); } }, { label: 'Done', primary: true, value: true }],
        onOpen: function (d) {
          d.addEventListener('click', function (e) {
            var b = e.target.closest('.fol-chip');
            if (!b) return;
            var o = opts[+b.dataset.i];
            toggle(o.kind, o.n, !follows(o.kind, o.n)).then(function (on) { b.setAttribute('aria-pressed', on); b.querySelector('.i').outerHTML = V.icon(on ? 'starf' : 'star'); }).catch(V.fail);
          });
          var f = d.querySelector('.fol-chip');
          if (f) setTimeout(function () { f.focus(); }, 40);
        },
      });
    }).catch(V.fail);
  };

  // ---------------------------------------------------------------- Events: rows and lists
  var chanOf = function (x) { return V.entry(x.k); };
  var when = function (x) {
    var d = new Date(x.s).toDateString(), n = new Date();
    var day = d === n.toDateString() ? '' : (n.setDate(n.getDate() + 1), d === n.toDateString() ? 'Tomorrow ' : V.fmtDay(x.s) + ' ');
    return day + V.fmtClock(x.s);
  };
  // (In lists: the day on its own line, so "Tomorrow" doesn't push everything over on a phone.)
  var whenHtml = function (x) {
    var w = when(x), t = V.fmtClock(x.s);
    return w === t ? V.esc(t) : '<small class="ev-day">' + V.esc(w.slice(0, w.length - t.length).trim()) + '</small>' + V.esc(t);
  };
  /** The match itself first: "Premier League: Arsenal v Chelsea" → "Arsenal v Chelsea" (the competition is shown beside it). */
  var short = function (x) {
    var t = String(x.t).replace(/^\s*live\s*[:\-–]\s*/i, '');
    var m = /^([^:|]{2,40}?)\s*[:|]\s*(.+\s(?:vs?\.?|@|at|x)\s.+)$/i.exec(t);
    return m ? m[2] : t;
  };
  var card = function (x, i) {
    var c = chanOf(x);
    if (!c) return '';
    var sub = (x.lg ? x.lg + ' · ' : '') + c.n + (x.also ? ' · also on ' + x.also : '');
    var label = (x.live ? 'Watch ' : '') + x.t + ', ' + (x.live ? 'live now' : when(x)) + ' on ' + c.n;
    return '<button class="ol-card k-sport ev-card' + (x.live ? ' live' : '') + '" data-ev="' + i + '" aria-label="' + V.esc(label) + '">' +
      '<span class="ol-when">' + (x.live ? '<b class="ev-live">Live</b>' : V.esc(when(x))) + '</span><b class="clamp2">' + V.esc(short(x)) + '</b>' +
      '<span class="ol-ch">' + V.art(c.i, c.n, 'art sm') + '<small class="truncate">' + V.esc(sub) + '</small></span>' +
      (x.live ? '<span class="ev-go">' + V.icon('play') + ' Watch</span>' : '') + '</button>';
  };
  var open = function (x, list) {
    var c = chanOf(x);
    if (!c) return;
    if (x.live) return V.play(c);
    V.programmeDialog(c, { s: x.s, e: x.e, t: x.t, st: x.st, c: x.lg ? ['Sports', x.lg] : ['Sports'] }, list);
  };

  /** Home: the Events row (games of what you follow: on now, then next). */
  V.eventsRow = function () {
    if (!S.live.length) return null;
    var sec = document.createElement('section');
    sec.className = 'row ev-row';
    sec.dataset.row = 'events';
    sec.setAttribute('aria-label', 'Events: your teams and competitions');
    sec.hidden = true;
    loadEvents().then(function (v) {
      var items = v.items.filter(chanOf).slice(0, 30);
      if (!items.length) { sec.remove(); return; }
      sec.innerHTML = '<div class="row-h"><h2><a href="#/onlater">Events: your teams ' + V.icon('next') + '</a></h2></div><div class="row-wrap"><div class="row-scroll ol-cards ev-cards">' + items.map(card).join('') + '</div></div>';
      sec.hidden = false;
      sec.addEventListener('click', function (e) { var b = e.target.closest('[data-ev]'); if (b) open(items[+b.dataset.ev]); });
      // (These cards have nothing under them, so "nearest" left a focused one on the screen's edge: show the whole row.)
      sec.addEventListener('focusin', function () { setTimeout(function () { var w = V.$('.row-wrap', sec); if (w) w.scrollIntoView({ block: 'nearest', behavior: V.reduceMotion && V.reduceMotion() ? 'auto' : 'smooth' }); }, 0); });
    }).catch(function () { sec.remove(); });
    return sec;
  };

  /** On later: the Events section at the top (a list, with Watch and reminder buttons). */
  V.eventsSection = function (box) {
    if (!box) return;
    loadEvents().then(function (v) {
      var items = v.items.filter(chanOf);
      if (!v.following) {
        box.innerHTML = '<div class="ev-empty"><p>' + V.icon('star') + ' Follow your teams and competitions to see their games here first, with reminders.</p><a class="btn" href="#/follow">Choose teams</a></div>';
        return;
      }
      var live = items.filter(function (x) { return x.live; }), next = items.filter(function (x) { return !x.live; }).slice(0, 40);
      var row = function (x) {
        var i = items.indexOf(x), c = chanOf(x);
        var rem = V.hasReminder(c, x);
        return '<li class="ol-i' + (x.live ? ' ev-on' : '') + '"><button class="ol-b" data-ev="' + i + '"><span class="ol-time num">' + (x.live ? '<b class="ev-live">Live</b>' : whenHtml(x)) + '</span>' + V.art(c.i, c.n, 'art sm') +
          '<span class="ol-main"><b class="clamp2">' + V.esc(short(x)) + '</b><small class="dim truncate">' + V.esc(c.n) + (x.lg ? ' · ' + V.esc(x.lg) : '') + (x.also ? ' · also on ' + V.plural(x.also, 'channel') : '') + (x.why && nk(x.why) !== nk(x.lg) ? ' · ' + V.icon('starf', 'tiny') + ' ' + V.esc(x.why) : '') + '</small></span></button>' +
          (x.live ? '<button class="btn sm primary" data-watch="' + i + '">' + V.icon('play') + ' Watch</button>' : '<button class="icon-btn" data-evrem="' + i + '" aria-pressed="' + rem + '" aria-label="Remind me about ' + V.esc(x.t) + '">' + V.icon(rem ? 'bellf' : 'bell') + '</button>') + '</li>';
      };
      box.innerHTML = '<h2 class="ev-h">Events <a class="btn ghost sm" href="#/follow">' + V.icon('star') + ' Teams you follow</a></h2>' +
        (live.length ? '<h3>On now</h3><ul class="ol-list">' + live.map(row).join('') + '</ul>' : '') +
        (next.length ? '<h3>Coming up</h3><ul class="ol-list">' + next.map(row).join('') + '</ul>' : '') +
        (!items.length ? '<p class="dim">Nothing coming up in the next three days for the teams and competitions you follow.</p>' : '');
      box.onclick = function (e) {
        var w = e.target.closest('[data-watch]');
        if (w) { var c0 = chanOf(items[+w.dataset.watch]); if (c0) V.play(c0); return; }
        var rb = e.target.closest('[data-evrem]');
        if (rb) { var x = items[+rb.dataset.evrem], c = chanOf(x); var on = V.toggleReminder(c, x); rb.innerHTML = V.icon(on ? 'bellf' : 'bell'); rb.setAttribute('aria-pressed', on); return; }
        var b = e.target.closest('[data-ev]');
        if (b) open(items[+b.dataset.ev]);
      };
    }).catch(function (e) { box.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
  };

  // ---------------------------------------------------------------- the quick launcher: "Follow Arsenal", "Arsenal: their games"
  var palCache = {}, palKeys = [];
  var palFetch = V.debounce(function (q, raw) {
    if (palCache[q]) return;
    getConf().catch(function () {});
    V.api('/api/follow/suggest?q=' + encodeURIComponent(raw.trim()) + '&n=3').then(function (r) {
      palCache[q] = r; palKeys.push(q);
      if (palKeys.length > 40) delete palCache[palKeys.shift()];
      V.emit('palette-more');
    }).catch(function () { palCache[q] = []; });
  }, 180);
  V.paletteExtra = V.paletteExtra || [];
  V.paletteExtra.push(function (q, raw) {
    if (!S.live.length || q.length < 3) return [];
    var hits = palCache[q];
    if (!hits) { palFetch(q, raw); return []; }
    return hits.map(function (o, i) {
      var on = conf && follows(o.kind, o.n);
      return on ? { id: 'fol:' + o.n, label: o.n + ': their games', hint: 'Following', icon: 'starf', s: 52 - i * 2, run: function () { V.router.go('#/onlater'); } }
        : { id: 'fol:' + o.n, label: 'Follow ' + o.n, hint: [o.kind === 'comp' ? 'Competition' : '', o.c ? V.plural(o.c, 'game') + ' in the guide' : ''].filter(Boolean).join(' · '), icon: 'star', s: 48 - i * 2, run: function () { toggle(o.kind, o.n, true).catch(V.fail); } };
    });
  });

  // ---------------------------------------------------------------- Teams you follow (#/follow)
  V.route('follow', function (view) {
    view.innerHTML = V.pageHead('Teams you follow', '<div class="page-tools"><a class="btn" href="#/onlater">' + V.icon('bell') + ' On later</a></div>') +
      '<div class="fol-page"><section class="card-sec"><h2>Find a team or competition</h2><p class="dim">Names come from what’s in the TV guide and on event channels. Short forms and small typos are fine (“Man Utd”, “Arsnal”).</p>' +
      '<input class="input" type="search" data-fq placeholder="Arsenal, Chiefs, Premier League, Formula 1…" aria-label="Find a team or competition" autocomplete="off">' +
      '<div class="chips fol-sug" data-sug role="group" aria-label="Suggestions"></div></section>' +
      '<section class="card-sec"><h2>You follow</h2><div data-mine><div class="spinner"></div></div></section>' +
      '<section class="card-sec"><h2>Reminders</h2><div data-sw></div></section></div>';
    var sug = [], mine = V.$('[data-mine]', view), sugBox = V.$('[data-sug]', view), swBox = V.$('[data-sw]', view), input = V.$('[data-fq]', view);
    var drawMine = function () {
      var all = conf.teams.map(function (n) { return { kind: 'team', n: n }; }).concat(conf.comps.map(function (n) { return { kind: 'comp', n: n }; }));
      mine.innerHTML = all.length ? '<div class="chips">' + all.map(function (o) { return '<span class="chip on fol-mine">' + V.icon('starf') + V.esc(o.n) + (o.kind === 'comp' ? ' <small>competition</small>' : '') + '<button class="x" data-unf="' + o.kind + '" data-n="' + V.esc(o.n) + '" aria-label="Stop following ' + V.esc(o.n) + '">' + V.icon('x') + '</button></span>'; }).join('') + '</div>' : '<p class="dim">Nothing yet. Pick some above, or use <b>Follow</b> on a match in the guide or On later.</p>';
      swBox.innerHTML = '<label class="switch"><input type="checkbox" data-auto' + (conf.auto ? ' checked' : '') + '><span class="sw"></span><span><b>Remind me about my teams’ games</b><small>Reminders are set by themselves for games in the next two days, on the best channel you can watch.</small></span></label>' +
        '<label class="switch"><input type="checkbox" data-swc' + (conf.sw ? ' checked' : '') + (conf.auto ? '' : ' disabled') + '><span class="sw"></span><span><b>Switch channel automatically</b><small>When one of those games starts, change to it after a 10-second countdown (you can cancel).</small></span></label>';
    };
    var drawSug = function () {
      sugBox.innerHTML = sug.length ? sug.map(function (o, i) { var on = follows(o.kind, o.n); return '<button class="chip fol-chip" data-s="' + i + '" aria-pressed="' + on + '">' + V.icon(on ? 'starf' : 'star') + '<span>' + V.esc(o.n) + '</span><small>' + [o.kind === 'comp' ? 'competition' : '', o.c ? V.plural(o.c, 'game') : ''].filter(Boolean).join(' · ') + '</small></button>'; }).join('') : '<p class="dim">' + (input.value.trim() ? 'Nothing like that in the guide right now.' + (input.value.trim().length > 1 ? ' <button class="btn sm" data-add>Follow “' + V.esc(input.value.trim()) + '” anyway</button>' : '') : 'No sport in the guide right now.') + '</p>';
    };
    var ask = function () {
      var q = input.value.trim();
      V.api('/api/follow/suggest?q=' + encodeURIComponent(q) + '&n=' + (q ? 12 : 20)).then(function (r) { if (input.value.trim() !== q) return; sug = r; drawSug(); }).catch(function () {});
    };
    getConf(true).then(function () { drawMine(); ask(); }).catch(function (e) { mine.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
    input.addEventListener('input', V.debounce(ask, 200));
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var f = V.$('.fol-chip', sugBox); if (f) f.focus(); } });
    view.addEventListener('click', function (e) {
      var s = e.target.closest('[data-s]');
      if (s) { var o = sug[+s.dataset.s]; toggle(o.kind, o.n, !follows(o.kind, o.n)).then(function () { drawSug(); drawMine(); var again = V.$('[data-s="' + s.dataset.s + '"]', sugBox); if (again) again.focus(); }).catch(V.fail); return; }
      var a = e.target.closest('[data-add]');
      if (a) { toggle('team', input.value.trim(), true).then(function () { drawMine(); drawSug(); }).catch(V.fail); return; }
      var u = e.target.closest('[data-unf]');
      if (u) toggle(u.dataset.unf, u.dataset.n, false).then(function () { drawMine(); drawSug(); var f = V.$('[data-unf]', mine) || input; f.focus(); }).catch(V.fail);
    });
    view.addEventListener('change', function (e) {
      if (!e.target.matches('[data-auto], [data-swc]')) return;
      var body = e.target.hasAttribute('data-auto') ? { auto: e.target.checked } : { sw: e.target.checked };
      V.put('/api/follow', body).then(function (c) { setConf(c); drawMine(); V.toast('Saved'); }).catch(V.fail);
    });
  });

  /** Settings → Teams and competitions. */
  V.followSettingsHtml = function () {
    return '<section class="card-sec"><h2>Teams and competitions</h2><p class="dim" data-folsum>Follow teams and competitions to get their games on Home (Events) and in On later, with reminders.</p><a class="btn" href="#/follow">' + V.icon('star') + ' Teams you follow…</a></section>';
  };
  V.bindFollowSettings = function (view) {
    var el = V.$('[data-folsum]', view);
    if (el) getConf().then(function (c) { var n = c.teams.length + c.comps.length; if (n) el.textContent = 'You follow ' + c.teams.concat(c.comps).slice(0, 6).join(', ') + (n > 6 ? ' and ' + (n - 6) + ' more' : '') + '.' + (c.auto && c.teams.length ? ' Reminders for your teams’ games are on' + (c.sw ? ', and switch channel automatically.' : '.') : ''); }).catch(function () {});
  };

  // ---------------------------------------------------------------- admin: event channels
  var ZONES = [['', 'Automatic (the provider’s, else the server’s)'], ['America/New_York', 'US Eastern'], ['America/Chicago', 'US Central'], ['America/Denver', 'US Mountain'], ['America/Los_Angeles', 'US Pacific'], ['Europe/London', 'UK'], ['Europe/Paris', 'Central Europe'], ['UTC', 'UTC'], ['Australia/Sydney', 'Sydney']];
  V.evTzField = function (l) {
    var cur = l.evTz || '';
    var opts = ZONES.slice();
    if (cur && !opts.some(function (z) { return z[0] === cur; })) opts.push([cur, cur]);
    return '<label class="field"><span>Time zone of event channels’ times</span><select class="input" name="evTz">' + opts.map(function (z) { return '<option value="' + V.esc(z[0]) + '"' + (z[0] === cur ? ' selected' : '') + '>' + V.esc(z[1]) + '</option>'; }).join('') + '</select><small class="dim">Used when a channel name like “EVENT 12 - 19:45 Arsenal v Chelsea” doesn’t say.</small></label>';
  };
  var guidesTab = V.adminTabs && V.adminTabs.guides;
  if (guidesTab) {
    V.adminTabs.guides = function (body, A) {
      guidesTab(body, A);
      V.api('/api/admin/events').then(function (r) {
        var sec = document.createElement('section');
        sec.className = 'card-sec ev-admin';
        sec.innerHTML = '<h2>Event channels</h2><p class="dim">' + (r.total ? V.plural(r.total, 'event channel') + ' found (pay-per-view and event feeds); ' + r.timed + ' say when their event starts and get listings from their names; ' + r.empty + ' have nothing on.' : 'No event channels found. Channels like “PPV 03: UFC 310 (Sat 22:00 ET)” get listings from their names.') + '</p>' +
          (r.sample.length ? '<ul class="ev-sample">' + r.sample.map(function (x) { return '<li><span class="num">' + V.esc(V.fmtDay(x.s) + ' ' + V.fmtClock(x.s)) + '</span> <b>' + V.esc(x.t) + '</b> <span class="dim">' + V.esc(x.n) + '</span></li>'; }).join('') + '</ul>' : '') +
          '<label class="switch"><input type="checkbox" data-hide-ev' + (r.hideEmpty ? ' checked' : '') + '><span class="sw"></span><span>Hide event channels with nothing on from Live TV <small class="dim">(each viewer can still show them with “Show event channels with nothing on”)</small></span></label>';
        var anchor = V.$('.ce-gset', body);
        if (anchor && anchor.nextSibling) body.insertBefore(sec, anchor.nextSibling); else body.appendChild(sec);
        sec.querySelector('[data-hide-ev]').onchange = function (e) { V.put('/api/admin/events', { hideEmpty: e.target.checked }).then(function (x) { S.settings.hideEmptyEvents = x.hideEmpty; V.toast('Saved'); }).catch(V.fail); };
      }).catch(function () {});
    };
  }

})();
