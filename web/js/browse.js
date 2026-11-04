/* Browsing: Movies, Series, Live TV, Radio and a channel's own page. */
'use strict';

// (One collator for every comparison: localeCompare makes one each time, which takes seconds over 100,000 titles on a TV.)
var nameCmp = (function () { try { var c = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }); return function (x, y) { return c.compare(x, y); }; } catch (e) { return function (x, y) { return String(x).localeCompare(y); }; } })();
V.nameCmp = nameCmp;
// A–Z by a key worked out once per title (plain letters, numbers padded so "2" comes before "10"), the collator only
// for ties: comparing keys is many times quicker than the collator over 50,000 titles.
var NONASCII = /[^\x00-\x7f]/, DIGIT = /\d/;
var azKey = function (n) {
  n = String(n || '');
  var k = NONASCII.test(n) ? V.norm(n) : n.toLowerCase();
  return DIGIT.test(k) ? k.replace(/\d+/g, function (d) { return d.length >= 10 ? d : ('0000000000' + d).slice(-10); }) : k;
};
var azSort = function (items, desc) {
  var keys = new Array(items.length), ix = new Array(items.length);
  for (var i = 0; i < items.length; i++) { keys[i] = azKey(items[i].n); ix[i] = i; }
  ix.sort(function (p, q) { var a = keys[p], b = keys[q], c = a < b ? -1 : a > b ? 1 : nameCmp(items[p].n, items[q].n); return (desc ? -c : c) || p - q; });
  var out = new Array(items.length);
  for (var j = 0; j < ix.length; j++) out[j] = items[ix[j]];
  return out;
};
V.sortItems = function (items, sort) {
  if (sort === 'az' || sort === 'za') return azSort(items, sort === 'za');
  var a = items.slice();
  if (sort === 'new') a.sort(function (x, y) { return (y.ad || 0) - (x.ad || 0); });
  else if (sort === 'year') a.sort(function (x, y) { return (y.y || 0) - (x.y || 0); });
  else if (sort === 'rating') a.sort(function (x, y) { return (y.r || 0) - (x.r || 0); });
  // (How popular worldwide — TMDB's measure — then rating, then newest.)
  else if (sort === 'pop') a.sort(function (x, y) { return (y.pp || 0) - (x.pp || 0) || (y.r || 0) - (x.r || 0) || (y.ad || 0) - (x.ad || 0); });
  else if (sort === 'num') a.sort(function (x, y) { return (x.no || 0) - (y.no || 0); });
  else if (sort === 'genre') a.sort(function (x, y) { var gx = (x.gn && x.gn[0]) || '\uffff', gy = (y.gn && y.gn[0]) || '\uffff'; return nameCmp(gx, gy) || nameCmp(x.n, y.n); });
  return a;
};

// What a Movies / Series page works out from the whole catalogue, kept until the catalogue changes: going back to the
// page, or changing a filter, doesn't sort 50,000 titles again.
var browseMemo = { stamp: -1, m: {} };
V.browseMemo = function (key, fn) {
  if (browseMemo.stamp !== S.catalogStamp) browseMemo = { stamp: S.catalogStamp, m: {} };
  var m = browseMemo.m;
  if (!(key in m)) m[key] = fn();
  return m[key];
};

function vodPage(view, r, type, title) {
  var all = type === 'movie' ? S.movies : S.shows;
  var g = r.q.get('g') || '';
  var genre = r.q.get('genre') || '';
  var sort = r.q.get('sort') || (V.ls.get('sort.' + type) || 'default');
  var smart = V.smart && V.smart.on();
  var groups = V.groupList(type);
  var chart = g.indexOf('tr:') === 0; // (TMDB's charts: in their own order)
  var genres = V.browseMemo('genres|' + type + '|' + g, function () {
    var out = [];
    S.genres.forEach(function (list, name) { var n = 0; for (var i = 0; i < list.length; i++) if (list[i].t === type && (!g || V.inGroup(list[i], g))) n++; if (n >= 1) out.push({ name: name, n: n }); });
    return out.sort(function (a, b) { return b.n - a.n; });
  });
  var hidden = new Set(S.data.hidden);
  var dec = r.q.get('dec') || '', minR = +(r.q.get('rmin') || 0), maxLen = +(r.q.get('len') || 0);
  var decOk = function (x) {
    if (!dec) return true;
    if (!x.y) return false;
    if (dec === 'new') return x.y >= new Date().getFullYear() - 1;
    if (dec === 'old') return x.y < 1970;
    var d = +dec; return x.y >= d && x.y < d + 10;
  };
  var lenOk = function (x) { if (!maxLen || type !== 'movie') return true; if (!x.d) return false; return maxLen > 0 ? x.d <= maxLen * 60 : x.d >= -maxLen * 60; };
  // (Sorted once, then filtered: the same order as filtering first, as the sorts keep ties in catalogue order.)
  // (Suggested: a chart's own order; with smarter categories, what's popular worldwide first; otherwise A–Z.)
  var sortBy = sort === 'default' ? (chart ? 'rank' : g || genre ? (smart ? 'pop' : 'az') : 'new') : sort;
  var base = g ? V.groupItems(type, g) : genre ? (S.genres.get(genre) || []).filter(function (x) { return x.t === type; }) : all;
  var sorted = V.browseMemo('sort|' + type + '|' + g + '|' + genre + '|' + sortBy + (chart ? '|' + V.smart.trendAt() : ''), function () { return sortBy === 'rank' ? base : V.sortItems(base, sortBy); });
  var items = sorted.filter(function (x) { return !hidden.has(x.k) && (!g || V.inGroup(x, g)) && (!genre || (x.gn || []).indexOf(genre) >= 0) && decOk(x) && (!minR || (x.r || 0) >= minR) && lenOk(x); });
  if (chart && V.smart) V.smart.loadTrend();
  var setQ = function (k, v) { var q = new URLSearchParams(r.q); if (v) q.set(k, v); else q.delete(k); V.router.go('#/' + r.name + (q.toString() ? '?' + q : ''), true); };
  view.innerHTML = V.pageHead(title, '<div class="page-tools">' +
    '<label class="sel"><span class="sr-only">Category</span><select class="input" data-f="g"><option value="">All categories</option>' + V.groupOptions(groups, g) + '</select></label>' +
    (genres.length ? '<label class="sel"><span class="sr-only">Genre</span><select class="input" data-f="genre"><option value="">All genres</option>' + genres.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (x) { return '<option value="' + V.esc(x.name) + '"' + (x.name === genre ? ' selected' : '') + '>' + V.esc(x.name) + ' (' + x.n + ')</option>'; }).join('') + '</select></label>' : '') +
    '<label class="sel"><span class="sr-only">Years</span><select class="input" data-f="dec">' + [['', 'Any year'], ['new', 'Last 2 years'], ['2020', '2020s'], ['2010', '2010s'], ['2000', '2000s'], ['1990', '1990s'], ['1980', '1980s'], ['1970', '1970s'], ['old', 'Before 1970']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === dec ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
    '<label class="sel"><span class="sr-only">Rating</span><select class="input" data-f="rmin">' + [['', 'Any rating'], ['6', '★ 6+'], ['7', '★ 7+'], ['8', '★ 8+']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === String(minR || '') ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
    (type === 'movie' ? '<label class="sel"><span class="sr-only">Length</span><select class="input" data-f="len">' + [['', 'Any length'], ['90', 'Under 1½ hours'], ['100', 'Under 1 h 40'], ['120', 'Under 2 hours'], ['-150', 'Long (2½ h+)']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === String(maxLen || '') ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' : '') +
    '<label class="sel"><span class="sr-only">Sort</span><select class="input" data-f="sort">' + [['default', chart ? 'Chart order' : 'Suggested'], ['pop', 'Popular worldwide'], ['new', 'Newest'], ['az', 'A–Z'], ['za', 'Z–A'], ['year', 'Release year'], ['rating', 'Rating'], ['genre', 'Genre']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === sort ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
    (g ? '<button class="btn sm" data-pin-g>' + V.icon('pin') + ' Pin to home</button>' : '') + '</div>') +
    // (No row of genre buttons as well: the Genre list above does the same, and the page starts sooner. With smarter
    // categories: the charts, the holiday in season and the big services, one tap away.)
    (smart ? V.smart.chips(type, g, r.name) : '') +
    '<p class="count dim">' + V.plural(items.length, type === 'movie' ? 'movie' : 'series', type === 'movie' ? 'movies' : 'series') + (g || genre || dec || minR || maxLen ? ' · <button class="linkish" data-clear-f>Clear filters</button>' : '') + '</p><div class="grid-host"></div>';
  V.$$('[data-f]', view).forEach(function (s) { s.onchange = function () { if (s.dataset.f === 'sort') V.ls.set('sort.' + type, s.value); setQ(s.dataset.f, s.value === 'default' ? '' : s.value); }; });
  V.$$('[data-genre]', view).forEach(function (b) { b.onclick = function () { setQ('genre', b.dataset.genre); }; });
  var cf = V.$('[data-clear-f]', view);
  if (cf) cf.onclick = function () { var q = new URLSearchParams(r.q); ['g', 'genre', 'dec', 'rmin', 'len'].forEach(function (k) { q.delete(k); }); V.router.go('#/' + r.name + (q.toString() ? '?' + q : ''), true); };
  var pin = V.$('[data-pin-g]', view);
  if (pin) pin.onclick = function () { var id = type + '|' + g; if (S.data.home.pinned.indexOf(id) < 0) { S.data.home.pinned.push(id); V.saveHome(); } V.toast('Pinned to your home page'); };
  if (g && V.smart && V.smart.isId(g)) { var h1 = V.$('h1', view); if (h1) h1.textContent = title + ': ' + V.smart.label(g, type); }
  if (!all.length) { V.$('.grid-host', view).innerHTML = V.empty('No ' + title.toLowerCase() + ' yet', 'None of the lists have any, or your language settings hide them.', '<div class="btn-row empty-acts"><a class="btn" href="#/settings">Language settings</a></div>'); return; }
  V.grid(V.$('.grid-host', view), items, { empty: 'Nothing matches.' });
}
V.route('movies', function (view, r) { vodPage(view, r, 'movie', 'Movies'); });
V.route('series', function (view, r) { vodPage(view, r, 'show', 'Series'); });

// ---------------------------------------------------------------- Live TV & radio
function channelsPage(view, r, type) {
  var all = type === 'radio' ? S.radio : S.live;
  var g = r.q.get('g') || (type === 'live' ? V.startGroup('live', V.ls.get('livegroup.' + type)) : V.ls.get('livegroup.' + type)) || '';
  var favs = V.favChannels(type);
  var recent = V.recentChannels().filter(function (c) { return c.t === type; });
  var list = g === '__fav' ? favs : g === '__recent' ? recent : g ? V.channelsFor(g, type) : all;
  // Pay-per-view channels with nothing on ("No event streaming now") or a finished event: hidden unless asked for.
  // (The admin can have them shown always: Admin → TV guides → Event channels.)
  var hideByAdmin = S.settings.hideEmptyEvents !== false;
  var showEmpty = !hideByAdmin || V.ls.get('showEmptyEvents', false);
  var emptyN = hideByAdmin ? list.filter(V.eventEmpty).length : 0;
  if (!showEmpty && g !== '__fav') list = list.filter(function (c) { return !V.eventEmpty(c) || V.inList('favs', c.k); });
  view.innerHTML = V.pageHead(type === 'radio' ? 'Radio' : 'Live TV', '<div class="page-tools"><input class="input" type="search" data-filter placeholder="Find a channel or number" aria-label="Find a channel"><span class="pt-links">' + (type === 'live' ? '<a class="btn" href="#/guide">' + V.icon('clock') + ' TV guide</a><a class="btn" href="#/onlater">' + V.icon('bell') + ' On later</a>' + (V.dvr && V.dvr.visible() ? '<a class="btn" href="#/recordings">' + V.icon('rec') + ' Recordings</a>' : '') : '') + '<a class="btn" href="#/mychannels">' + V.icon('list') + ' Your lists</a>' +
    (type === 'live' && V.multiview && all.length > 1 ? '<a class="btn" href="#/multiview">' + V.icon('grid') + ' Multiview</a>' : '') +
    // Radio and live TV link to each other (on phones the tab bar has one Live TV tab for both).
    (type === 'live' && S.radio.length ? '<a class="btn" href="#/radio">' + V.icon('radio') + ' Radio</a>' : '') +
    (type === 'radio' && S.live.length ? '<a class="btn" href="#/live">' + V.icon('tv') + ' Live TV</a><a class="btn" href="#/guide">' + V.icon('clock') + ' TV guide</a>' : '') + '</span></div>') +
    '<div class="live-layout"><nav class="groups" aria-label="Channel groups">' +
    V.channelGroups(type)
      .map(function (x) { if (x.head) return '<div class="grp-h">' + V.esc(x.head) + '</div>'; return '<button class="grp' + (x.v === g ? ' on' : '') + '" data-g="' + V.esc(x.v) + '"' + (x.v === g ? ' aria-current="true"' : '') + '><span class="truncate">' + V.esc(x.l) + '</span><small>' + x.n + '</small></button>'; }).join('') +
    '</nav><div class="ch-col">' + (emptyN ? '<label class="check small ev-toggle"><input type="checkbox" data-empty-ev' + (showEmpty ? ' checked' : '') + '><span>Show ' + V.plural(emptyN, 'event channel') + ' with nothing on</span></label>' : '') + '<div class="ch-list" data-list></div></div></div>';
  var box = V.$('.ch-list', view);
  var et = V.$('[data-empty-ev]', view);
  if (et) et.onchange = function () { V.ls.set('showEmptyEvents', et.checked); V.router.refresh(); };
  var curIo = null;
  var render = function (items) {
    box._items = items;
    var n = 0;
    box.innerHTML = '';
    var more = function () {
      var html = '';
      for (var end = Math.min(items.length, n + (n ? 80 : 40)); n < end; n++) html += V.channelRow(items[n]);
      box.insertAdjacentHTML('beforeend', html);
    };
    more();
    if (!items.length) box.innerHTML = V.empty(g === '__fav' ? 'No favourites yet' : 'No channels here', g === '__fav' ? 'Use the heart on a channel to add it.' : g.indexOf('__my:') === 0 ? 'Add channels to this list in “Your lists”.' : '');
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
  // Every half minute: the progress bars move on, and a channel whose programme has changed shows the new one.
  var tick = setInterval(function () {
    V.$$('.chr', box).forEach(function (el) {
      var it = V.entry(el.dataset.k); var nn = V.epg.nowNext(it);
      var ns = nn.now ? nn.now.s : 0;
      if (el._ns !== undefined && el._ns !== ns && it && document.activeElement !== el && !el.contains(document.activeElement)) { var tmp = document.createElement('div'); tmp.innerHTML = V.channelRow(it); var fresh = tmp.firstElementChild; if (fresh) { fresh._ns = ns; el.parentNode.replaceChild(fresh, el); } return; }
      el._ns = ns;
      var b = V.$('.bar i', el); if (b && nn.now) b.style.width = V.clamp((Date.now() - nn.now.s) / (nn.now.e - nn.now.s), 0, 1) * 100 + '%';
    });
  }, 30000);
  V.pageCleanup = function () { clearInterval(tick); if (curIo) curIo.disconnect(); };
}
/** An event channel with nothing on: its name says so, or its event (from its name) is over and nothing follows. */
V.eventEmpty = function (c) {
  if (c.es === 'none' || c.es === 'ended') return true;
  if (!c.evc || !c.E) return false;
  var nn = V.epg.nowNext(c);
  return !nn.now && !nn.next && V.epg.earlier(c).length > 0;
};
V.channelRow = function (c) {
  var nn = V.epg.nowNext(c);
  var pct = nn.now ? V.clamp((Date.now() - nn.now.s) / (nn.now.e - nn.now.s), 0, 1) : 0;
  var playing = V.watch && V.watch.it && (V.watch.it.k === c.k || V.watch.it.catchupOf === c.k);
  var fav = V.inList('favs', c.k);
  return '<a class="chr' + (playing ? ' on' : '') + '" href="#/channel/' + encodeURIComponent(c.k) + '" data-k="' + V.esc(c.k) + '" aria-label="' + V.esc((c.no ? 'Channel ' + c.no + ', ' : '') + c.n + (V.isDown && V.isDown(c.k) ? ' (may be down)' : '') + (nn.now ? ', now: ' + nn.now.t : '')) + '">' +
    '<span class="chr-no num">' + (c.no || '') + '</span>' + V.art(c.i, c.n, 'art chr-logo') +
    '<span class="chr-main"><span class="dn-row"><span class="chr-name truncate">' + V.esc(c.n) + (c.cu ? ' ' + V.icon('archive', 'tiny') : '') + '</span>' + (V.downMark ? V.downMark(c) : '') + '</span>' +
    (c.lk && !V.parental.open(c) ? '<span class="chr-now dim truncate">' + V.icon('lock', 'tiny') + ' Locked</span>' : nn.now ? '<span class="chr-now truncate' + (nn.now.ph ? ' ph' : '') + '">' + V.esc(nn.now.t) + '</span><span class="bar"><i style="width:' + pct * 100 + '%"></i></span>' : c.ev ? '<span class="chr-now truncate">' + V.eventLabel(c) + '</span>' : '<span class="chr-now dim truncate">' + V.esc(c.es === 'none' ? 'No event right now' : c.g) + '</span>') + '</span>' +
    '<span class="chr-next dim truncate">' + (nn.next && !nn.next.ph ? '<span class="chr-nl">Next</span> ' + V.fmtClock(nn.next.s) + ' ' + V.esc(nn.next.t) : '') + '</span>' +
    '<button class="icon-btn" data-fav="' + V.esc(c.k) + '" aria-pressed="' + fav + '" aria-label="Favourite">' + V.icon(fav ? 'heartf' : 'heart') + '</button></a>';
};
/** A pay-per-view channel's event: "LIVE · Chelsea vs. Man Utd", "Ended · …". */
V.eventLabel = function (c) {
  var tag = c.es === 'live' ? '<b class="ev-live">Live</b> · ' : c.es === 'ended' ? '<span class="dim">Ended ·</span> ' : c.es === 'next' ? '<span class="dim">Next ·</span> ' : '';
  return tag + V.esc(c.ev || '');
};
V.route('live', function (view, r) { channelsPage(view, r, 'live'); });
V.route('radio', function (view, r) { channelsPage(view, r, 'radio'); });

// ---------------------------------------------------------------- one channel
V.route('channel', function (view, r) {
  var c = V.entry(r.args[0]);
  if (!c) { view.innerHTML = V.empty('Channel not found', 'It may have been removed from the lists.', '<div class="btn-row empty-acts"><a class="btn" href="#/live">All channels</a></div>'); return; }
  var fav = V.inList('favs', c.k);
  var nn = V.epg.nowNext(c);
  var canCU = V.catchup.available(c);
  view.innerHTML = '<div class="ch-page"><header class="ch-head">' + V.art(c.i, c.n, 'art ch-big') + '<div><div class="dim">' + V.esc(V.catLabel ? V.catLabel(c) : c.g) + (c.no ? ' · Channel ' + c.no : '') + (canCU ? ' · ' + V.icon('archive', 'tiny') + ' Catch-up ' + ((c.cu && c.cu.days) || 7) + ' days' : '') + '</div><h1>' + V.esc(c.n) + '</h1>' + (V.isDown && V.isDown(c.k) ? '<p class="dn-note"><span class="dn-badge">' + V.icon('pulse', 'tiny') + ' May be down</span> It hasn’t played the last few times anyone tried.</p>' : '') +
    (nn.now ? '<p><b>Now:</b> ' + V.esc(nn.now.t) + ' <span class="dim">' + V.fmtClock(nn.now.s) + '–' + V.fmtClock(nn.now.e) + '</span></p>' : '') +
    '<div class="acts"><button class="btn primary lg" data-a="play">' + V.icon('play') + ' Watch</button>' + (canCU && nn.now ? '<button class="btn lg" data-a="start">' + V.icon('restart') + ' Start over</button>' : '') +
    '<button class="icon-btn lg" data-a="fav" aria-pressed="' + fav + '" aria-label="Favourite">' + V.icon(fav ? 'heartf' : 'heart') + '</button><button class="icon-btn lg" data-a="mylist" aria-label="Add to one of your lists">' + V.icon('list') + '</button><button class="icon-btn lg" data-a="share" aria-label="Send to someone">' + V.icon('send') + '</button>' + (S.settings.allowParties ? '<button class="icon-btn lg" data-a="party" aria-label="Watch together">' + V.icon('party') + '</button>' : '') + '</div></div></header>' +
    '<div class="sched"><div class="spinner"></div></div></div>';
  var acts = function (e) {
    var b = e.target.closest('[data-a]');
    if (!b) return;
    var a = b.dataset.a;
    if (a === 'play') V.play(c);
    else if (a === 'start') V.playCatchup(c, nn.now, 0);
    else if (a === 'fav') V.toggle('favs', c.k).then(function (on) { b.innerHTML = V.icon(on ? 'heartf' : 'heart'); b.setAttribute('aria-pressed', on); });
    else if (a === 'share') V.shareDialog(c);
    else if (a === 'mylist') V.addToChannelList(c, b);
    else if (a === 'party') V.party.startDialog(c);
  };
  view.addEventListener('click', acts);
  var sched = V.$('.sched', view);
  if (!c.E) { sched.innerHTML = '<p class="dim">' + (c.es === 'none' ? 'No event right now.' : c.ev ? V.eventLabel(c) + ' · the channel’s name doesn’t say when it starts.' : 'No guide information for this channel.') + '</p>'; return; }
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
          (live ? '<button class="btn sm primary" data-p="live">' + V.icon('play') + ' Watch</button>' : cu ? '<button class="btn sm" data-p="cu" data-s="' + p.s + '">' + V.icon('play') + ' Play</button>' : !past ? '<button class="icon-btn" data-p="rem" data-s="' + p.s + '" aria-pressed="' + rem + '" aria-label="Remind me">' + V.icon(rem ? 'bellf' : 'bell') + '</button>' : '') + (V.dvr ? V.dvr.progButton(c, p) : '') + '</li>';
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
      else if (b.dataset.p === 'dvr') V.dvr.progClick(c, p, b);
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
  // (The guide's tile for it shows the bell — or not — straight away, wherever the reminder was set from.)
  V.$$('.gp[data-s="' + p.s + '"]').forEach(function (el) {
    if (el.dataset.k !== c.k) return;
    var b = V.$('b', el), bell = b && V.$('.tiny', b);
    if (on && bell) bell.parentNode.removeChild(bell);
    else if (!on && b && !bell) b.insertAdjacentHTML('afterbegin', V.icon('bellf', 'tiny'));
  });
  V.emit('reminders');
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
    if ((r.sw || V.pref('reminderAction') === 'switch') && V.reminderSwitch && !document.hidden) V.reminderSwitch(c, r);
    else V.toast(msg, { action: { label: 'Watch', fn: function () { V.play(c); } }, ms: 20000 });
    try { if (window.Notification && Notification.permission === 'granted' && document.hidden) new Notification(msg); } catch (e) {}
  });
  var keep = S.data.reminders.filter(function (r) { return r.e > now; });
  // Finished ones just drop off here; the server tidies its own copy (never send a whole list from an old copy).
  if (keep.length !== S.data.reminders.length) S.data.reminders = keep;
};
