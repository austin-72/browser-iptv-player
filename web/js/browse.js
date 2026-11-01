/* Browsing: Movies, Series, Live TV, Radio and a channel's own page. */
'use strict';

V.sortItems = function (items, sort) {
  var a = items.slice();
  if (sort === 'az') a.sort(function (x, y) { return x.n.localeCompare(y.n); });
  else if (sort === 'za') a.sort(function (x, y) { return y.n.localeCompare(x.n); });
  else if (sort === 'new') a.sort(function (x, y) { return (y.ad || 0) - (x.ad || 0); });
  else if (sort === 'year') a.sort(function (x, y) { return (y.y || 0) - (x.y || 0); });
  else if (sort === 'rating') a.sort(function (x, y) { return (y.r || 0) - (x.r || 0); });
  else if (sort === 'num') a.sort(function (x, y) { return (x.no || 0) - (y.no || 0); });
  else if (sort === 'genre') a.sort(function (x, y) { var gx = (x.gn && x.gn[0]) || '\uffff', gy = (y.gn && y.gn[0]) || '\uffff'; return gx.localeCompare(gy) || x.n.localeCompare(y.n); });
  return a;
};

function vodPage(view, r, type, title) {
  var all = type === 'movie' ? S.movies : S.shows;
  var g = r.q.get('g') || '';
  var genre = r.q.get('genre') || '';
  var sort = r.q.get('sort') || (V.ls.get('sort.' + type) || 'default');
  var groups = V.groupsOf(type).sort(function (a, b) { return a.name.localeCompare(b.name); });
  var genres = [];
  S.genres.forEach(function (list, name) { var n = list.filter(function (x) { return x.t === type && (!g || x.g === g); }).length; if (n >= 1) genres.push({ name: name, n: n }); });
  genres.sort(function (a, b) { return b.n - a.n; });
  var hidden = new Set(S.data.hidden);
  var items = all.filter(function (x) { return !hidden.has(x.k) && (!g || x.g === g) && (!genre || (x.gn || []).indexOf(genre) >= 0); });
  items = V.sortItems(items, sort === 'default' ? (g || genre ? 'az' : 'new') : sort);
  var setQ = function (k, v) { var q = new URLSearchParams(r.q); if (v) q.set(k, v); else q.delete(k); V.router.go('#/' + r.name + (q.toString() ? '?' + q : ''), true); };
  view.innerHTML = V.pageHead(title, '<div class="page-tools">' +
    '<label class="sel"><span class="sr-only">Category</span><select class="input" data-f="g"><option value="">All categories</option>' + groups.map(function (x) { return '<option value="' + V.esc(x.name) + '"' + (x.name === g ? ' selected' : '') + '>' + V.esc(x.name) + ' (' + x.items.length + ')</option>'; }).join('') + '</select></label>' +
    (genres.length ? '<label class="sel"><span class="sr-only">Genre</span><select class="input" data-f="genre"><option value="">All genres</option>' + genres.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (x) { return '<option value="' + V.esc(x.name) + '"' + (x.name === genre ? ' selected' : '') + '>' + V.esc(x.name) + ' (' + x.n + ')</option>'; }).join('') + '</select></label>' : '') +
    '<label class="sel"><span class="sr-only">Sort</span><select class="input" data-f="sort">' + [['default', 'Suggested'], ['new', 'Newest'], ['az', 'A–Z'], ['za', 'Z–A'], ['year', 'Release year'], ['rating', 'Rating'], ['genre', 'Genre']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === sort ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
    (g ? '<button class="btn sm" data-pin-g>' + V.icon('pin') + ' Pin to home</button>' : '') + '</div>') +
    (genres.length ? V.chips([{ v: '', l: 'All genres' }].concat(genres.filter(function (x) { return x.n >= 3; }).slice(0, 16).map(function (x) { return { v: x.name, l: x.name }; })), genre, 'genre') : '') +
    '<p class="count dim">' + V.plural(items.length, type === 'movie' ? 'movie' : 'series', type === 'movie' ? 'movies' : 'series') + '</p><div class="grid-host"></div>';
  V.$$('[data-f]', view).forEach(function (s) { s.onchange = function () { if (s.dataset.f === 'sort') V.ls.set('sort.' + type, s.value); setQ(s.dataset.f, s.value === 'default' ? '' : s.value); }; });
  V.$$('[data-genre]', view).forEach(function (b) { b.onclick = function () { setQ('genre', b.dataset.genre); }; });
  var pin = V.$('[data-pin-g]', view);
  if (pin) pin.onclick = function () { var id = type + '|' + g; if (S.data.home.pinned.indexOf(id) < 0) { S.data.home.pinned.push(id); V.saveHome(); } V.toast('Pinned to your home page'); };
  if (!all.length) { V.$('.grid-host', view).innerHTML = V.empty('No ' + title.toLowerCase() + ' yet', 'None of the lists have any, or your language settings hide them.'); return; }
  V.grid(V.$('.grid-host', view), items, { empty: 'Nothing matches.' });
}
V.route('movies', function (view, r) { vodPage(view, r, 'movie', 'Movies'); });
V.route('series', function (view, r) { vodPage(view, r, 'show', 'Series'); });

// ---------------------------------------------------------------- Live TV & radio
function channelsPage(view, r, type) {
  var all = type === 'radio' ? S.radio : S.live;
  var g = r.q.get('g') || V.ls.get('livegroup.' + type) || '';
  var groups = V.groupsOf(type).sort(function (a, b) { return a.name.localeCompare(b.name); });
  var favs = all.filter(function (c) { return V.inList('favs', c.k); });
  var recent = V.recentChannels().filter(function (c) { return c.t === type; });
  var list = g === '__fav' ? favs : g === '__recent' ? recent : g ? all.filter(function (c) { return c.g === g; }) : all;
  view.innerHTML = V.pageHead(type === 'radio' ? 'Radio' : 'Live TV', '<div class="page-tools"><input class="input" type="search" data-filter placeholder="Find a channel or number" aria-label="Find a channel">' + (type === 'live' ? '<a class="btn" href="#/guide">' + V.icon('clock') + ' TV guide</a>' : '') + '</div>') +
    '<div class="live-layout"><nav class="groups" aria-label="Channel groups">' +
    [{ v: '', l: 'All channels', n: all.length }, { v: '__fav', l: 'Favourites', n: favs.length }, { v: '__recent', l: 'Recently watched', n: recent.length }].concat(groups.map(function (x) { return { v: x.name, l: x.name, n: x.items.length }; }))
      .map(function (x) { return '<button class="grp' + (x.v === g ? ' on' : '') + '" data-g="' + V.esc(x.v) + '"' + (x.v === g ? ' aria-current="true"' : '') + '><span class="truncate">' + V.esc(x.l) + '</span><small>' + x.n + '</small></button>'; }).join('') +
    '</nav><div class="ch-list" role="list" data-list></div></div>';
  var box = V.$('.ch-list', view);
  var curIo = null;
  var render = function (items) {
    box._items = items;
    var n = 0;
    box.innerHTML = '';
    var more = function () {
      var html = '';
      for (var end = Math.min(items.length, n + 80); n < end; n++) html += V.channelRow(items[n]);
      box.insertAdjacentHTML('beforeend', html);
    };
    more();
    if (!items.length) box.innerHTML = V.empty(g === '__fav' ? 'No favourites yet' : 'No channels here', g === '__fav' ? 'Use the heart on a channel to add it.' : '');
    box.onscroll = null;
    var io = new IntersectionObserver(function (es) { if (es[0].isIntersecting && n < items.length) { more(); io.unobserve(es[0].target); var last = box.lastElementChild; if (last) io.observe(last); } }, { rootMargin: '800px' });
    if (box.lastElementChild && n < items.length) io.observe(box.lastElementChild);
    if (curIo) curIo.disconnect();
    curIo = io;
  };
  render(list);
  V.$$('[data-g]', view).forEach(function (b) { b.onclick = function () { V.ls.set('livegroup.' + type, b.dataset.g); V.router.go('#/' + r.name + (b.dataset.g ? '?g=' + encodeURIComponent(b.dataset.g) : ''), true); }; });
  V.$('[data-filter]', view).addEventListener('input', V.debounce(function (e) {
    var q = e.target.value.trim();
    render(q ? V.search.find(q, { types: [type], limit: 500 }) : list);
  }, 150));
  box.addEventListener('click', function (e) {
    var fav = e.target.closest('[data-fav]');
    if (fav) { e.preventDefault(); e.stopPropagation(); V.toggle('favs', fav.dataset.fav).then(function (on) { fav.innerHTML = V.icon(on ? 'heartf' : 'heart'); fav.setAttribute('aria-pressed', on); }); return; }
    var row = e.target.closest('[data-k]');
    if (row) { e.preventDefault(); V.play(V.entry(row.dataset.k), { list: box._items }); }
  });
  var tick = setInterval(function () { V.$$('.chr', box).forEach(function (el) { var it = V.entry(el.dataset.k); var nn = V.epg.nowNext(it); var b = V.$('.bar i', el); if (b && nn.now) b.style.width = V.clamp((Date.now() - nn.now.s) / (nn.now.e - nn.now.s), 0, 1) * 100 + '%'; }); }, 30000);
  V.pageCleanup = function () { clearInterval(tick); if (curIo) curIo.disconnect(); };
}
V.channelRow = function (c) {
  var nn = V.epg.nowNext(c);
  var pct = nn.now ? V.clamp((Date.now() - nn.now.s) / (nn.now.e - nn.now.s), 0, 1) : 0;
  var playing = V.watch && V.watch.it && (V.watch.it.k === c.k || V.watch.it.catchupOf === c.k);
  var fav = V.inList('favs', c.k);
  return '<a class="chr' + (playing ? ' on' : '') + '" href="#/channel/' + encodeURIComponent(c.k) + '" data-k="' + V.esc(c.k) + '" role="listitem" aria-label="' + V.esc((c.no ? 'Channel ' + c.no + ', ' : '') + c.n + (nn.now ? ', now: ' + nn.now.t : '')) + '">' +
    '<span class="chr-no num">' + (c.no || '') + '</span>' + V.art(c.i, c.n, 'art chr-logo') +
    '<span class="chr-main"><span class="chr-name truncate">' + V.esc(c.n) + (c.cu ? ' ' + V.icon('archive', 'tiny') : '') + '</span>' +
    (nn.now ? '<span class="chr-now truncate">' + V.esc(nn.now.t) + '</span><span class="bar"><i style="width:' + pct * 100 + '%"></i></span>' : '<span class="chr-now dim truncate">' + V.esc(c.g) + '</span>') + '</span>' +
    '<span class="chr-next dim truncate">' + (nn.next ? V.fmtClock(nn.next.s) + ' ' + V.esc(nn.next.t) : '') + '</span>' +
    '<button class="icon-btn" data-fav="' + V.esc(c.k) + '" aria-pressed="' + fav + '" aria-label="Favourite">' + V.icon(fav ? 'heartf' : 'heart') + '</button></a>';
};
V.route('live', function (view, r) { channelsPage(view, r, 'live'); });
V.route('radio', function (view, r) { channelsPage(view, r, 'radio'); });

// ---------------------------------------------------------------- one channel
V.route('channel', function (view, r) {
  var c = V.entry(r.args[0]);
  if (!c) { view.innerHTML = V.empty('Channel not found', 'It may have been removed from the lists.'); return; }
  var fav = V.inList('favs', c.k);
  var nn = V.epg.nowNext(c);
  var canCU = V.catchup.available(c);
  view.innerHTML = '<div class="ch-page"><header class="ch-head">' + V.art(c.i, c.n, 'art ch-big') + '<div><div class="dim">' + V.esc(c.g) + (c.no ? ' · Channel ' + c.no : '') + (canCU ? ' · ' + V.icon('archive', 'tiny') + ' Catch-up ' + ((c.cu && c.cu.days) || 7) + ' days' : '') + '</div><h1>' + V.esc(c.n) + '</h1>' +
    (nn.now ? '<p><b>Now:</b> ' + V.esc(nn.now.t) + ' <span class="dim">' + V.fmtClock(nn.now.s) + '–' + V.fmtClock(nn.now.e) + '</span></p>' : '') +
    '<div class="acts"><button class="btn primary lg" data-a="play">' + V.icon('play') + ' Watch</button>' + (canCU && nn.now ? '<button class="btn lg" data-a="start">' + V.icon('restart') + ' Start over</button>' : '') +
    '<button class="icon-btn lg" data-a="fav" aria-pressed="' + fav + '" aria-label="Favourite">' + V.icon(fav ? 'heartf' : 'heart') + '</button><button class="icon-btn lg" data-a="share" aria-label="Send to someone">' + V.icon('send') + '</button>' + (S.settings.allowParties ? '<button class="icon-btn lg" data-a="party" aria-label="Watch together">' + V.icon('party') + '</button>' : '') + '</div></div></header>' +
    '<div class="sched"><div class="spinner"></div></div></div>';
  var acts = function (e) {
    var b = e.target.closest('[data-a]');
    if (!b) return;
    var a = b.dataset.a;
    if (a === 'play') V.play(c);
    else if (a === 'start') V.playCatchup(c, nn.now, 0);
    else if (a === 'fav') V.toggle('favs', c.k).then(function (on) { b.innerHTML = V.icon(on ? 'heartf' : 'heart'); b.setAttribute('aria-pressed', on); });
    else if (a === 'share') V.shareDialog(c);
    else if (a === 'party') V.party.startDialog(c);
  };
  view.addEventListener('click', acts);
  var sched = V.$('.sched', view);
  if (!c.E) { sched.innerHTML = '<p class="dim">No guide information for this channel.</p>'; return; }
  var now = Date.now();
  var from = now - (canCU ? Math.min(7, (c.cu && c.cu.days) || 7) : 0.25) * 86400e3;
  V.epg.range([c.k], from, now + 3 * 86400e3).then(function (res) {
    var list = res[c.k] || [];
    var days = {};
    list.forEach(function (p) { var d = V.fmtDay(p.s); (days[d] = days[d] || []).push(p); });
    sched.innerHTML = Object.keys(days).map(function (d) {
      return '<h3>' + V.esc(d) + '</h3><ul class="progs">' + days[d].map(function (p) {
        var live = p.s <= now && p.e > now, past = p.e <= now;
        var cu = past && V.catchup.canPlay(c, p);
        var rem = V.hasReminder(c, p);
        return '<li class="prog' + (live ? ' now' : '') + (past ? ' past' : '') + '"><span class="pt num">' + V.fmtClock(p.s) + '</span><span class="pb"><b>' + V.esc(p.t) + '</b>' + (p.st ? ' <span class="dim">· ' + V.esc(p.st) + '</span>' : '') + (p.ep ? ' <span class="dim">' + V.esc(p.ep) + '</span>' : '') + (p.d ? '<small class="dim clamp2">' + V.esc(p.d) + '</small>' : '') + '</span>' +
          (live ? '<button class="btn sm primary" data-p="live">' + V.icon('play') + ' Watch</button>' : cu ? '<button class="btn sm" data-p="cu" data-s="' + p.s + '">' + V.icon('play') + ' Play</button>' : !past ? '<button class="icon-btn" data-p="rem" data-s="' + p.s + '" aria-pressed="' + rem + '" aria-label="Remind me">' + V.icon(rem ? 'bellf' : 'bell') + '</button>' : '') + '</li>';
      }).join('') + '</ul>';
    }).join('') || '<p class="dim">No guide information for this channel.</p>';
    var cur = V.$('.prog.now', sched);
    if (cur) setTimeout(function () { cur.scrollIntoView({ block: 'center' }); }, 50);
    sched.onclick = function (e) {
      var b = e.target.closest('[data-p]');
      if (!b) return;
      var p = list.filter(function (x) { return String(x.s) === b.dataset.s; })[0];
      if (b.dataset.p === 'live') V.play(c);
      else if (b.dataset.p === 'cu') V.playCatchup(c, p, 0);
      else if (b.dataset.p === 'rem') { var on = V.toggleReminder(c, p); b.innerHTML = V.icon(on ? 'bellf' : 'bell'); b.setAttribute('aria-pressed', on); }
    };
  });
});

// ---------------------------------------------------------------- reminders
V.hasReminder = function (c, p) { return S.data.reminders.some(function (r) { return r.k === c.k && r.s === p.s; }); };
V.toggleReminder = function (c, p) {
  var on = V.hasReminder(c, p);
  if (on) S.data.reminders = S.data.reminders.filter(function (r) { return !(r.k === c.k && r.s === p.s); });
  else {
    S.data.reminders.push({ k: c.k, s: p.s, e: p.e, t: p.t });
    if (window.Notification && Notification.permission === 'default') Notification.requestPermission().catch(function () {});
    V.toast('I’ll remind you when “' + p.t + '” starts');
  }
  V.api('/api/reminders', { body: on ? { remove: { k: c.k, s: p.s } } : { add: { k: c.k, s: p.s, e: p.e, t: p.t } } }).catch(V.fail);
  return !on;
};
V.checkReminders = function () {
  if (!S.data) return;
  var now = Date.now();
  var due = S.data.reminders.filter(function (r) { return r.s - now < 60e3 && !r.done; });
  due.forEach(function (r) {
    r.done = true;
    var c = V.entry(r.k);
    if (!c) return;
    var msg = '“' + r.t + '” is starting on ' + c.n;
    V.toast(msg, { action: { label: 'Watch', fn: function () { V.play(c); } }, ms: 20000 });
    try { if (window.Notification && Notification.permission === 'granted' && document.hidden) new Notification(msg); } catch (e) {}
  });
  var keep = S.data.reminders.filter(function (r) { return r.e > now; });
  // Finished ones just drop off here; the server tidies its own copy (never send a whole list from an old copy).
  if (keep.length !== S.data.reminders.length) S.data.reminders = keep;
};
