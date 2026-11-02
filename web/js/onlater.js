/* What's coming up: films and sport (and news, kids) in the next two days, from the TV guide; plus the guide's colours. */
'use strict';
(function () {
  var KINDS = [
    { id: 'sport', label: 'Sport', re: /sport|football|soccer|basketball|baseball|hockey|tennis|golf|racing|motor|boxing|mma|ufc|wrestling|cricket|rugby|athletic|nfl|nba|nhl|mlb|ncaa|f1\b|formula|cycling|darts|snooker|olympic/i },
    { id: 'film', label: 'Film', re: /^(movie|movies|film|films|feature film|cinema)$|\bmovie\b|\bfilm\b/i },
    { id: 'kids', label: 'Kids', re: /kids|children|animation|cartoon|preschool/i },
    { id: 'news', label: 'News', re: /news|current affairs|business|weather/i },
    { id: 'doc', label: 'Documentary', re: /documentar|nature|history|science|wildlife|educat/i },
    { id: 'music', label: 'Music', re: /music|concert/i },
  ];
  /** A programme's kind, from its guide categories: sport, film, kids, news, doc, music, other (or '' with none). */
  V.progKind = function (p) {
    if (!p || !p.c || !p.c.length) return '';
    var cats = [].concat(p.c).join(' | ');
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i].re.test(cats)) return KINDS[i].id;
    return 'other';
  };
  V.guideLegend = function (on) {
    return '<div class="g-legend" aria-label="Colours in the guide">' + (on ? KINDS.map(function (k) { return '<span class="lg-i k-' + k.id + '"><i></i>' + k.label + '</span>'; }).join('') + '<span class="lg-i k-other"><i></i>Other</span>' : '') +
      '<label class="check small"><input type="checkbox" data-colours' + (on ? ' checked' : '') + '><span>Colours</span></label></div>';
  };

  var LABELS = { sport: 'Sport', film: 'Films', news: 'News', kids: 'Kids' };
  var cache = null;
  var load = function (kinds) {
    var key = kinds.join(',');
    if (cache && cache.key === key && Date.now() - cache.at < 5 * 60e3) return Promise.resolve(cache.v);
    return V.api('/api/onlater?h=48&kinds=' + encodeURIComponent(key)).then(function (v) { cache = { key: key, at: Date.now(), v: v }; return v; });
  };
  // Favourite channels first when the same programme is on several.
  var pick = function (x) {
    var favs = S.data.favs;
    var ks = [x.k].concat(x.ks || []);
    for (var i = 0; i < ks.length; i++) if (favs.indexOf(ks[i]) >= 0 && V.entry(ks[i])) return V.entry(ks[i]);
    for (var j = 0; j < ks.length; j++) if (V.entry(ks[j])) return V.entry(ks[j]);
    return null;
  };
  // (By calendar date, not 24-hour steps: a day with a clock change is 23 or 25 hours long.)
  var dayName = function (t) {
    var d = new Date(t).toDateString(), n = new Date();
    if (d === n.toDateString()) return 'Today';
    n.setDate(n.getDate() + 1);
    return d === n.toDateString() ? 'Tomorrow' : V.fmtDay(t);
  };
  var row = function (x) {
    var c = pick(x);
    if (!c) return '';
    var rem = V.hasReminder(c, x);
    return '<li class="ol-i"><button class="ol-b" data-k="' + V.esc(c.k) + '" data-s="' + x.s + '"><span class="ol-time num">' + V.fmtClock(x.s) + '</span>' + V.art(c.i, c.n, 'art sm') +
      '<span class="ol-main"><b class="truncate">' + V.esc(x.t) + '</b><small class="dim truncate">' + V.esc(c.n) + (x.st ? ' · ' + V.esc(x.st) : '') + (x.also ? ' · also on ' + V.plural(x.also, 'channel') : '') + '</small></span></button>' +
      (x.kind === 'sport' && V.followDialog ? '<button class="icon-btn" data-fol="' + V.esc(c.k) + '" data-s="' + x.s + '" aria-label="Follow the teams in ' + V.esc(x.t) + '">' + V.icon('star') + '</button>' : '') +
      '<button class="icon-btn" data-rem="' + V.esc(c.k) + '" data-s="' + x.s + '" aria-pressed="' + rem + '" aria-label="Remind me about ' + V.esc(x.t) + '">' + V.icon(rem ? 'bellf' : 'bell') + '</button></li>';
  };
  var findItem = function (v, k, s) { return v.items.filter(function (x) { return String(x.s) === String(s) && (x.k === k || (x.ks || []).indexOf(k) >= 0); })[0]; };

  V.route('onlater', function (view, r) {
    var kinds = (r.q.get('k') || V.ls.get('onlater.k', 'sport,film')).split(',').filter(function (k) { return LABELS[k]; });
    if (!kinds.length) kinds = ['sport', 'film'];
    view.innerHTML = V.pageHead('On later', '<div class="page-tools"><a class="btn" href="#/guide">' + V.icon('clock') + ' TV guide</a><a class="btn" href="#/live">' + V.icon('tv') + ' Live TV</a></div>') +
      '<div class="chips" role="group" aria-label="What to show">' + Object.keys(LABELS).map(function (k) { return '<button class="chip' + (kinds.indexOf(k) >= 0 ? ' on' : '') + '" data-kind="' + k + '" aria-pressed="' + (kinds.indexOf(k) >= 0) + '">' + LABELS[k] + '</button>'; }).join('') + '</div>' +
      '<section class="ol-events" aria-label="Events"></section><div class="ol-body"><div class="spinner"></div></div>';
    var body = V.$('.ol-body', view);
    if (V.eventsSection) V.eventsSection(V.$('.ol-events', view));
    var data = null;
    var draw = function (v) {
      data = v;
      var items = v.items.filter(function (x) { return pick(x); });
      if (!items.length) { body.innerHTML = V.empty('Nothing found in the next two days', S.live.length ? 'The guide doesn’t list any ' + kinds.map(function (k) { return LABELS[k].toLowerCase(); }).join(' or ') + ' for your channels yet.' : 'There are no live channels.'); return; }
      var days = [];
      items.forEach(function (x) { var d = dayName(x.s); var day = days[days.length - 1]; if (!day || day.name !== d) days.push((day = { name: d, items: [] })); day.items.push(x); });
      body.innerHTML = days.map(function (day) {
        var parts = [];
        kinds.forEach(function (k) {
          var list = day.items.filter(function (x) { return x.kind === k; });
          if (!list.length) return;
          if (k === 'sport') {
            // Sport by league or competition, biggest first.
            var leagues = {};
            list.forEach(function (x) { var l = x.lg || 'More sports'; (leagues[l] = leagues[l] || []).push(x); });
            var names = Object.keys(leagues).sort(function (a, b) { return a === 'More sports' ? 1 : b === 'More sports' ? -1 : leagues[b].length - leagues[a].length || a.localeCompare(b); });
            parts.push('<h3>' + LABELS[k] + '</h3>' + names.map(function (n) { return '<h4>' + V.esc(n) + '</h4><ul class="ol-list">' + leagues[n].slice(0, 60).map(row).join('') + '</ul>'; }).join(''));
          } else parts.push('<h3>' + LABELS[k] + '</h3><ul class="ol-list">' + list.slice(0, 120).map(row).join('') + '</ul>');
        });
        return parts.length ? '<section class="ol-day"><h2>' + V.esc(day.name) + '</h2>' + parts.join('') + '</section>' : '';
      }).join('');
    };
    load(kinds).then(draw, function (e) { body.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
    view.addEventListener('click', function (e) {
      var ch = e.target.closest('[data-kind]');
      if (ch) {
        var k = ch.dataset.kind, i = kinds.indexOf(k);
        if (i >= 0 && kinds.length > 1) kinds.splice(i, 1); else if (i < 0) kinds.push(k);
        V.ls.set('onlater.k', kinds.join(','));
        V.router.go('#/onlater?k=' + kinds.join(','), true);
        return;
      }
      var fb = e.target.closest('[data-fol]');
      if (fb && data) { var fx = findItem(data, fb.dataset.fol, fb.dataset.s); if (fx) V.followDialog(fx); return; }
      var rb = e.target.closest('[data-rem]');
      if (rb && data) { var c = V.entry(rb.dataset.rem), x = findItem(data, rb.dataset.rem, rb.dataset.s); if (c && x) { var on = V.toggleReminder(c, x); rb.innerHTML = V.icon(on ? 'bellf' : 'bell'); rb.setAttribute('aria-pressed', on); } return; }
      var b = e.target.closest('.ol-b');
      if (b && data) { var c2 = V.entry(b.dataset.k), x2 = findItem(data, b.dataset.k, b.dataset.s); if (c2 && x2) V.programmeDialog(c2, x2); }
    });
  });

  /** Home page row "On later today": the next films and matches, today and tonight. */
  V.onLaterRow = function () {
    if (!S.live.length) return null;
    var sec = document.createElement('section');
    sec.className = 'row ol-row';
    sec.dataset.row = 'onlater';
    sec.setAttribute('aria-label', 'On later today');
    sec.hidden = true;
    load(['sport', 'film']).then(function (v) {
      var end = new Date(); end.setHours(23, 59, 59, 999);
      var until = Math.max(end.getTime(), Date.now() + 6 * 3600e3);
      var items = v.items.filter(function (x) { return x.s > Date.now() && x.s < until && pick(x); }).slice(0, 30);
      if (items.length < 2) { sec.remove(); return; }
      sec.innerHTML = '<div class="row-h"><h2><a href="#/onlater">On later today ' + V.icon('next') + '</a></h2></div><div class="row-wrap"><div class="row-scroll ol-cards">' + items.map(function (x) {
        var c = pick(x);
        var lab = x.kind === 'film' ? 'Film' : x.lg && x.lg !== 'More sports' ? x.lg : '';
        return '<button class="ol-card k-' + x.kind + '" data-k="' + V.esc(c.k) + '" data-s="' + x.s + '"><span class="ol-when">' + V.esc(dayName(x.s) === 'Today' ? '' : dayName(x.s) + ' ') + V.fmtClock(x.s) + '</span><b class="clamp2">' + V.esc(x.t) + '</b><span class="ol-ch">' + V.art(c.i, c.n, 'art sm') + '<small class="truncate">' + V.esc(lab) + (lab ? ' · ' : '') + V.esc(c.n) + '</small></span></button>';
      }).join('') + '</div></div>';
      sec.hidden = false;
      sec.addEventListener('click', function (e) { var b = e.target.closest('.ol-card'); if (!b) return; var c = V.entry(b.dataset.k), x = findItem(v, b.dataset.k, b.dataset.s); if (c && x) V.programmeDialog(c, x); });
    }).catch(function () { sec.remove(); });
    return sec;
  };
})();
