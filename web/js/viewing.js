/* Your viewing: time watched by week / month / year, what and when, compared with the period before; the household's
   totals for the admin; and a Year in review. Server side: lib/viewing.js and lib/routes-p10.js. */
'use strict';
(function () {
  var DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var REVIEW_MIN = 3600; // seconds in a year before it gets a review
  var KINDS = [['l', 'Live TV'], ['m', 'Films'], ['e', 'Series'], ['o', 'Other']];

  /** 3 h 20 min, 45 min, 120 h */
  var hm = function (s) {
    var m = Math.round((s || 0) / 60);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    return h >= 100 || !(m % 60) ? h.toLocaleString() + ' h' : h + ' h ' + (m % 60) + ' min';
  };
  var hoursBig = function (s) { var h = (s || 0) / 3600; return h >= 10 ? Math.round(h).toLocaleString() : (Math.round(h * 10) / 10).toLocaleString(); };
  var hourName = function (h) { if (h < 0) return ''; var a = h % 12 || 12, b = (h + 1) % 12 || 12; return a + (h < 12 ? ' am' : ' pm') + '–' + b + (h + 1 < 12 || h + 1 === 24 ? ' am' : ' pm'); };
  var partOfDay = function (h) { return h < 0 ? '' : h < 5 ? 'late at night' : h < 12 ? 'in the morning' : h < 17 ? 'in the afternoon' : h < 21 ? 'in the evening' : 'late in the evening'; };
  var dayOf = function (key) { var p = key.split('-'); return new Date(+p[0], +p[1] - 1, +(p[2] || 1)); };
  var shortDay = function (d) { return d.toLocaleDateString([], { day: 'numeric', month: 'short' }); };

  /** "2 h more than last week" / "about the same" */
  var delta = function (now, before, what, unit) {
    if (!before && !now) return '';
    if (!before) return 'Nothing the ' + what + ' before';
    var d = now - before;
    if (Math.abs(d) < Math.max(unit === 'time' ? 600 : 1, before * 0.05)) return 'About the same as the ' + what + ' before';
    var amount = unit === 'time' ? hm(Math.abs(d)) : V.plural(Math.abs(d), unit);
    return '<span class="' + (d > 0 ? 'vw-up' : 'vw-down') + '">' + V.icon(d > 0 ? 'up' : 'down', 'tiny') + ' ' + amount + (d > 0 ? ' more' : ' less') + '</span> than the ' + what + ' before';
  };

  /** Bars for a series of values (one colour: how much). Each bar says its value on hover and to screen readers. */
  var bars = function (vals, labels, o) {
    o = o || {};
    var max = Math.max.apply(null, vals.concat([1]));
    return '<div class="vw-bars' + (o.cls ? ' ' + o.cls : '') + '" role="list" aria-label="' + V.esc(o.label || '') + '">' + vals.map(function (v, i) {
      var tip = (o.full ? o.full[i] : labels[i]) + ': ' + (v ? hm(v) : 'nothing');
      return '<div class="vw-bar' + (o.mark === i ? ' mark' : '') + (i > vals.length / 2 ? ' r' : '') + '" role="listitem" tabindex="' + (o.focus ? '0' : '-1') + '" aria-label="' + V.esc(tip) + '"><span class="vw-tip">' + V.esc(tip) + '</span><i style="height:' + (v ? Math.max(3, Math.round((v / max) * 100)) : 0) + '%"></i><small>' + V.esc(labels[i]) + '</small></div>';
    }).join('') + '</div>';
  };
  var topList = function (title, list, emptyText) {
    list = list.filter(function (x) { return x.s >= 60; }); // (under a minute: a moment's look, not worth a line)
    if (!list.length) return '<section class="card-sec vw-top"><h2>' + title + '</h2><p class="dim">' + emptyText + '</p></section>';
    var max = Math.max.apply(null, list.map(function (x) { return x.s; }).concat([1]));
    return '<section class="card-sec vw-top"><h2>' + title + '</h2><ol>' + list.slice(0, 5).map(function (x) {
      var it = x.here && V.entry(x.k);
      var name = it ? '<a href="' + V.hrefOf(it) + '">' + V.esc(it.n) + '</a>' : V.esc(x.n || 'Something no longer here');
      return '<li><div class="vw-li"><span class="truncate">' + name + '</span><span class="dim num">' + hm(x.s) + '</span></div><div class="vw-meter"><i style="width:' + Math.max(2, Math.round((x.s / max) * 100)) + '%"></i></div></li>';
    }).join('') + '</ol></section>';
  };

  V.route('viewing', function (view, r) {
    var period = ['week', 'month', 'year'].indexOf(r.args[0]) >= 0 ? r.args[0] : 'week';
    var offset = Math.max(0, parseInt(r.q.get('back'), 10) || 0);
    var house = r.q.get('who') === 'house' && S.profile.admin;
    var now = new Date();
    var reviewYear = now.getMonth() === 11 ? now.getFullYear() : now.getFullYear() - 1;
    var href = function (p, b, h) { return '#/viewing/' + p + (b || h ? '?' + [b ? 'back=' + b : '', h ? 'who=house' : ''].filter(Boolean).join('&') : ''); };
    var what = { week: 'week', month: 'month', year: 'year' }[period];
    view.innerHTML = V.pageHead('Your viewing', '<span class="vw-review"></span>') +
      '<div class="tabs" role="tablist">' + [['week', 'Week'], ['month', 'Month'], ['year', 'Year']].map(function (t) { return '<a role="tab" class="tab' + (t[0] === period ? ' on' : '') + '" aria-selected="' + (t[0] === period) + '" href="' + href(t[0], 0, house) + '">' + t[1] + '</a>'; }).join('') + '</div>' +
      '<div class="vw-nav"><a class="icon-btn" href="' + href(period, offset + 1, house) + '" aria-label="The ' + what + ' before">' + V.icon('back') + '</a><h2 class="vw-when" aria-live="polite"></h2>' +
      (offset ? '<a class="icon-btn" href="' + href(period, offset - 1, house) + '" aria-label="The ' + what + ' after">' + V.icon('next') + '</a>' : '<span class="icon-btn ghost" aria-hidden="true"></span>') +
      (S.profile.admin ? '<span class="sp"></span><div class="chips" role="toolbar" aria-label="Whose viewing"><a class="chip' + (house ? '' : ' on') + '"' + (house ? '' : ' aria-current="true"') + ' href="' + href(period, offset, false) + '">' + V.esc(S.profile.name) + '</a><a class="chip' + (house ? ' on' : '') + '"' + (house ? ' aria-current="true"' : '') + ' href="' + href(period, offset, true) + '">' + V.icon('users', 'tiny') + ' Household</a></div>' : '') +
      '</div><div class="vw-body"><div class="spinner"></div></div>';
    var body = V.$('.vw-body', view), when = V.$('.vw-when', view);
    // A year in review only for a year with at least an hour watched (this year from December).
    V.api('/api/viewing/years').then(function (ys) {
      var best = 0;
      Object.keys(ys).forEach(function (y) { y = +y; if (y <= reviewYear && ys[y] >= REVIEW_MIN && y > best) best = y; });
      var slot = V.$('.vw-review', view);
      if (best && slot) slot.outerHTML = '<a class="btn" href="#/review/' + best + '">' + V.icon('sparkle') + ' Your ' + best + ' in review</a>';
    }).catch(function () {});
    var label = function (d) {
      if (period === 'year') return String(new Date(d.from).getFullYear());
      if (period === 'month') { var m = new Date(d.from); return MONTHS[m.getMonth()] + ' ' + m.getFullYear(); }
      return (offset === 0 ? 'This week · ' : offset === 1 ? 'Last week · ' : '') + shortDay(new Date(d.from)) + ' – ' + shortDay(new Date(d.to - 86400e3));
    };
    if (house) {
      V.api('/api/admin/viewing?period=' + period + '&offset=' + offset).then(function (d) {
        when.textContent = label(d);
        var max = Math.max.apply(null, d.people.map(function (p) { return p.total.s; }).concat([1]));
        body.innerHTML = '<div class="vw-tiles">' + tile('Household time watched', hm(d.total.s), delta(d.total.s, d.previous.s, what, 'time')) + tile('Films finished', String(d.total.f || 0), delta(d.total.f, d.previous.f, what, 'film')) +
          KINDS.slice(0, 3).map(function (k) { return tile(k[1], hm(d.total[k[0]] || 0), ''); }).join('') + '</div>' +
          '<section class="card-sec"><h2>By profile</h2><ol class="vw-people">' + d.people.slice().sort(function (a, b) { return b.total.s - a.total.s; }).map(function (p) {
            return '<li>' + V.avatar(p.avatar, 'sm') + '<div class="grow"><div class="vw-li"><b class="truncate">' + V.esc(p.name) + '</b><span class="dim num">' + hm(p.total.s) + '</span></div><div class="vw-meter"><i style="width:' + Math.max(p.total.s ? 2 : 0, Math.round((p.total.s / max) * 100)) + '%"></i></div>' +
              '<div class="faint small">' + KINDS.slice(0, 3).map(function (k) { return k[1] + ' ' + hm(p.total[k[0]] || 0); }).join(' · ') + (p.total.f ? ' · ' + V.plural(p.total.f, 'film') + ' finished' : '') + '</div></div></li>';
          }).join('') + '</ol><p class="dim small">Only totals are shown here: what each person watched stays on their own page.</p></section>';
      }).catch(function (e) { body.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
      return;
    }
    V.api('/api/viewing?period=' + period + '&offset=' + offset).then(function (d) {
      when.textContent = label(d);
      var t = d.total, p = d.previous;
      if (!t.s && !p.s && offset === 0 && !d.firstDay) { body.innerHTML = V.empty('Nothing watched yet', 'Watch something and your time, favourites and habits show up here.'); return; }
      var labels, full;
      if (period === 'year') { labels = d.series.map(function (x) { return MONTHS[+x.key.slice(5, 7) - 1].slice(0, 3); }); full = d.series.map(function (x) { return MONTHS[+x.key.slice(5, 7) - 1]; }); }
      else if (period === 'month') { labels = d.series.map(function (x) { var n = +x.key.slice(8, 10); return n === 1 || n % 5 === 0 ? String(n) : ''; }); full = d.series.map(function (x) { return shortDay(dayOf(x.key)); }); }
      else { labels = d.series.map(function (x) { return DAYS[(dayOf(x.key).getDay() + 6) % 7].slice(0, 3); }); full = d.series.map(function (x) { return DAYS[(dayOf(x.key).getDay() + 6) % 7] + ' ' + shortDay(dayOf(x.key)); }); }
      var todayKey = (function () { var n = new Date(); return n.getFullYear() + '-' + ('0' + (n.getMonth() + 1)).slice(-2) + '-' + ('0' + n.getDate()).slice(-2); })();
      var mark = -1;
      d.series.forEach(function (x, i) { if (x.key === todayKey || x.key === todayKey.slice(0, 7)) mark = i; });
      var kinds = KINDS.filter(function (k) { return t[k[0]] >= 60; });
      d.genres = d.genres.filter(function (g) { return g.s >= 60; });
      var sum = t.s || 1;
      body.innerHTML = '<div class="vw-tiles">' +
        tile('Time watched', hm(t.s), delta(t.s, p.s, what, 'time')) +
        tile('Films finished', String(t.f || 0), delta(t.f, p.f, what, 'film')) +
        tile('Days you watched', String(t.days), period === 'week' ? 'out of 7' : 'longest run: ' + V.plural(t.streak, 'day')) +
        tile('Longest streak', V.plural(d.longest, 'day'), d.current ? 'Now: ' + V.plural(d.current, 'day') + ' in a row' : 'Watch something today to start one') + '</div>' +
        '<section class="card-sec"><h2>' + (period === 'year' ? 'Time watched each month' : 'Time watched each day') + '</h2>' + bars(d.series.map(function (x) { return x.s; }), labels, { full: full, mark: mark, focus: true, label: 'Time watched' }) +
        (kinds.length ? '<div class="vw-kinds" aria-label="By type">' + kinds.map(function (k) { return '<div class="vw-kind"><div class="vw-li"><b>' + k[1] + '</b><span class="dim num">' + hm(t[k[0]]) + ' · ' + Math.round((t[k[0]] / sum) * 100) + '%</span></div><div class="vw-meter"><i style="width:' + Math.max(2, Math.round((t[k[0]] / sum) * 100)) + '%"></i></div></div>'; }).join('') + '</div>' : '') + '</section>' +
        '<div class="vw-cols">' +
        topList('Top series', d.shows, 'No series this ' + what + '.') + topList('Top films', d.films, 'No films this ' + what + '.') + topList('Top channels', d.channels, 'No live TV this ' + what + '.') +
        '<section class="card-sec vw-top"><h2>Top genres</h2>' + (d.genres.length ? '<div class="chips">' + d.genres.map(function (g) { return '<span class="chip">' + V.esc(g.g) + ' <small>' + hm(g.s) + '</small></span>'; }).join('') + '</div>' : '<p class="dim">Genres show up once titles have them (TMDB adds them).</p>') + '</section>' +
        '</div>' +
        '<section class="card-sec"><h2>When you watch</h2>' + (d.bestDay >= 0 ? '<p>Mostly on <b>' + DAYS[d.bestDay] + 's</b>, ' + partOfDay(d.bestHour) + ' (busiest hour: <b>' + hourName(d.bestHour) + '</b>).</p>' : '<p class="dim">Not enough yet.</p>') +
        '<div class="vw-when2"><div><h3 class="small dim">By day of the week</h3>' + bars(d.week, DAYS.map(function (x) { return x.slice(0, 2); }), { full: DAYS, mark: d.bestDay, cls: 'sm', label: 'By day of the week' }) + '</div>' +
        '<div><h3 class="small dim">By hour</h3>' + bars(d.hours, d.hours.map(function (x, i) { return i % 6 ? '' : String(i); }), { full: d.hours.map(function (x, i) { return hourName(i); }), mark: d.bestHour, cls: 'sm hours', label: 'By hour of the day' }) + '</div></div></section>' +
        '<p class="dim small center">Counted from what this profile plays here' + (d.firstDay ? ', since ' + dayOf(d.firstDay).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' }) : '') + '. Paused history isn’t counted.</p>';
    }).catch(function (e) { body.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
  });
  function tile(name, value, note) { return '<div class="vw-tile"><div class="dim small">' + V.esc(name) + '</div><div class="vw-big num">' + V.esc(value) + '</div>' + (note ? '<div class="small vw-note">' + note + '</div>' : '') + '</div>'; }

  // ------------------------------------------------------------ year in review
  V.route('review', function (view, r) {
    var now = new Date();
    var year = parseInt(r.args[0], 10) || (now.getMonth() === 11 ? now.getFullYear() : now.getFullYear() - 1);
    view.innerHTML = '<div class="yr-page"><div class="spinner"></div></div>';
    var box = V.$('.yr-page', view);
    V.api('/api/viewing/review?year=' + year).then(function (d) {
      var t = d.total;
      var head = '<header class="page-h"><h1>Your ' + year + ' in review</h1><a class="btn" href="#/viewing/year?back=' + (now.getFullYear() - year) + '">' + V.icon('chart') + ' All the numbers</a></header>';
      if (t.s < REVIEW_MIN) { box.innerHTML = '<header class="page-h"><h1>Your ' + year + ' in review</h1></header>' + V.empty('Not enough to look back on', t.s ? 'There’s less than an hour of viewing recorded for ' + year + ' on this profile — a year in review needs a bit more.' : 'There’s no viewing recorded for ' + year + ' on this profile.', '<div class="btn-row empty-acts"><a class="btn primary" href="#/viewing">Your viewing</a><a class="btn" href="#/home">Home</a></div>'); return; }
      var first = function (l) { return l && l[0]; };
      var poster = function (x) { var it = x && x.here && V.entry(x.k); return it ? V.art(it.i, it.n, 'art yr-poster') : ''; };
      var rest = function (l) { return l.length > 1 ? '<ol start="2" class="yr-rest">' + l.slice(1).map(function (x, i) { return '<li><span class="yr-n" aria-hidden="true">' + (i + 2) + '.</span><span class="truncate">' + V.esc(x.n) + '</span><span class="num">' + hm(x.s) + '</span></li>'; }).join('') + '</ol>' : ''; };
      var cards = [];
      cards.push('<section class="yr-card yr-c1" tabindex="0" aria-label="Your year"><div class="yr-k">' + V.esc(d.name) + ', your ' + year + '</div><div class="yr-huge num">' + hoursBig(t.s) + '</div><div class="yr-unit">hours watched</div>' +
        '<p class="yr-p">That’s ' + V.plural(t.days, 'day') + ' with something on' + (t.f ? ', and ' + V.plural(t.f, 'film') + ' watched to the end' : '') + '.</p></section>');
      var s1 = first(d.shows);
      if (s1) cards.push('<section class="yr-card yr-c2" tabindex="0" aria-label="Your top series"><div class="yr-k">Your series of the year</div>' + poster(s1) + '<div class="yr-name">' + V.esc(s1.n) + '</div><div class="yr-p">' + hm(s1.s) + '</div>' + rest(d.shows) + '</section>');
      var f1 = first(d.films);
      if (f1) cards.push('<section class="yr-card yr-c3" tabindex="0" aria-label="Your top films"><div class="yr-k">Films you spent the most time with</div>' + poster(f1) + '<div class="yr-name">' + V.esc(f1.n) + '</div>' + rest(d.films) + (t.f ? '<div class="yr-p">' + V.plural(t.f, 'film') + ' finished in all</div>' : '') + '</section>');
      var c1 = first(d.channels);
      if (c1) cards.push('<section class="yr-card yr-c4" tabindex="0" aria-label="Your top channels"><div class="yr-k">Your channel</div><div class="yr-name">' + V.esc(c1.n) + '</div><div class="yr-p">' + hm(c1.s) + ' of live TV there</div>' + rest(d.channels) + '</section>');
      if (d.genres.length) cards.push('<section class="yr-card yr-c5" tabindex="0" aria-label="Your top genres"><div class="yr-k">What you were in the mood for</div><div class="yr-genres">' + d.genres.map(function (g, i) { return '<span class="yr-g g' + i + '">' + V.esc(g.g) + '</span>'; }).join('') + '</div></section>');
      cards.push('<section class="yr-card yr-c6" tabindex="0" aria-label="Your rhythm"><div class="yr-k">Your rhythm</div>' +
        (d.bestMonth >= 0 ? '<div class="yr-row"><span>Busiest month</span><b>' + MONTHS[d.bestMonth] + '</b></div>' : '') +
        (d.bestDay >= 0 ? '<div class="yr-row"><span>Favourite day</span><b>' + DAYS[d.bestDay] + '</b></div>' : '') +
        (d.bestHour >= 0 ? '<div class="yr-row"><span>Favourite time</span><b>' + hourName(d.bestHour) + '</b></div>' : '') +
        '<div class="yr-row"><span>Longest streak</span><b>' + V.plural(t.streak, 'day') + '</b></div>' +
        bars(d.months, MONTHS.map(function (m) { return m.charAt(0); }), { full: MONTHS, mark: d.bestMonth, cls: 'yr-bars', label: 'Time watched each month' }) + '</section>');
      box.innerHTML = head + '<div class="yr-cards">' + cards.join('') + '</div>';
    }).catch(function (e) {
      box.innerHTML = '<header class="page-h"><h1>Year in review</h1></header>' + V.empty('Not yet', V.esc(e.message), '<div class="btn-row empty-acts"><a class="btn" href="#/review/' + (now.getFullYear() - 1) + '">Your ' + (now.getFullYear() - 1) + '</a><a class="btn" href="#/viewing">Your viewing</a></div>');
    });
  });
})();
