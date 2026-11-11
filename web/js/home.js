/* Home: hero, then rows — continue watching, recommendations, live now, new… in the order the profile chose. */
'use strict';

V.HOME_ROWS = [
  { id: 'continue', name: 'Continue watching' },
  { id: 'neweps', name: 'New episodes' },
  { id: 'shared', name: 'Sent to you' },
  { id: 'list', name: 'My List' },
  { id: 'top', name: 'Top picks for you' },
  { id: 'mix', name: 'Recommended by several things you watched' },
  { id: 'because', name: 'Because you watched…' },
  { id: 'people', name: 'Actors and directors you like' },
  { id: 'live', name: 'On now' },
  { id: 'ontv', name: 'On TV now: sports, films, kids, news' },
  { id: 'events', name: 'Events: teams and competitions you follow' },
  { id: 'onlater', name: 'On later today: films and sport' },
  { id: 'favs', name: 'Favourite channels' },
  { id: 'household', name: 'Popular in your household' },
  { id: 'new', name: 'New additions' },
  { id: 'genres', name: 'Your favourite genres' },
  { id: 'pinned', name: 'Pinned categories' },
  { id: 'sharedlists', name: 'Shared lists' },
  { id: 'recentch', name: 'Recently watched channels' },
  { id: 'random', name: 'Something different' },
];

V.MOODS = [
  { id: 'funny', label: 'Something funny', g: ['comedy', 'sitcom', 'stand-up', 'comédie', 'comedia'] },
  { id: 'tense', label: 'Edge of my seat', g: ['thriller', 'action', 'crime', 'mystery', 'suspense'] },
  { id: 'feelgood', label: 'Feel-good', g: ['family', 'romance', 'music', 'musical', 'animation', 'comedy'] },
  { id: 'mind', label: 'Mind-bending', g: ['science fiction', 'sci-fi', 'sci-fi & fantasy', 'fantasy', 'mystery'] },
  { id: 'scary', label: 'Something scary', g: ['horror', 'terror'] },
  { id: 'learn', label: 'Learn something', g: ['documentary', 'history', 'news', 'docu'] },
  { id: 'kids', label: 'For the kids', g: ['kids', 'family', 'animation', 'children'] },
  { id: 'epic', label: 'Big & epic', g: ['adventure', 'war', 'western', 'action & adventure', 'history'] },
];
V.moodItems = function (id) {
  var m = V.MOODS.filter(function (x) { return x.id === id; })[0];
  if (!m) return [];
  var out = [];
  [S.movies, S.shows].forEach(function (list) {
    list.forEach(function (it) {
      var gs = (it.gn || []).map(function (g) { return g.toLowerCase(); }).concat([String(it.g).toLowerCase()]);
      if (gs.some(function (g) { return m.g.some(function (w) { return g.indexOf(w) >= 0; }); })) out.push(it);
    });
  });
  return V.shuffle(out.filter(function (it) { return !V.inList('hidden', it.k); }), V.hash(id + new Date().toDateString()));
};
/** n items picked at random (the same ones for the same seed) from several lists, without copying them: ok() filters. */
V.sample = function (lists, n, seed, ok) {
  var total = 0, i;
  for (i = 0; i < lists.length; i++) total += (lists[i] || []).length;
  var out = [], seen = {}, s = parseInt(String(seed || Math.random()).replace(/\D/g, '').slice(0, 9) || '7', 10) || 7;
  var at = function (j) { for (var q = 0; q < lists.length; q++) { var l = lists[q] || []; if (j < l.length) return l[j]; j -= l.length; } return null; };
  for (var tries = 0; out.length < n && tries < n * 40 && total; tries++) {
    s = (s * 9301 + 49297) % 233280;
    var j = Math.floor((s / 233280) * total) + (tries % 7) * 104729 % total; // (a step that reaches past the generator's 233280 values)
    j %= total;
    if (seen[j]) continue;
    seen[j] = 1;
    var x = at(j);
    if (ok(x)) out.push(x);
  }
  return out;
};
V.shuffle = function (arr, seed) {
  var a = arr.slice();
  var s = parseInt(String(seed || Math.random()).replace(/\D/g, '').slice(0, 9) || '7', 10) || 7;
  for (var i = a.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; var j = Math.floor((s / 233280) * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
};

V.route('home', function (view) {
  var recs = S.recs || { top: [], rows: [], household: [] };
  var hid = new Set(S.data.home.hidden || []);
  var order = (S.data.home.order && S.data.home.order.length ? S.data.home.order : []).concat(V.HOME_ROWS.map(function (r) { return r.id; })).filter(function (x, i, a) { return a.indexOf(x) === i; });
  var hiddenSet = new Set(S.data.hidden);
  var notHidden = function (it) { return it && !hiddenSet.has(it.k); };
  var keysToItems = function (keys) { return (keys || []).map(V.entry).filter(notHidden); };
  var hasVod = S.movies.length + S.shows.length > 0;

  // Hero
  // What you're in the middle of leads (watched in the last two weeks): its picture, how much is left, one Resume
  // button. The film picked for you is for when there's nothing to resume.
  var cw0 = V.continueWatching()[0];
  var resumeIt = cw0 && cw0.it && (cw0.it.t === 'movie' || cw0.it.t === 'episode') && Date.now() - (cw0.at || 0) < 14 * 86400e3 ? cw0.it : null;
  var resumeNext = !!(resumeIt && cw0.next);
  var heroIt = resumeIt || V.entry(recs.hero) || (cw0 || {}).it;
  if (heroIt && heroIt.t === 'episode') heroIt = V.showOf(heroIt) || heroIt;
  if (resumeIt && !(heroIt.t === 'movie' || heroIt.t === 'show')) { resumeIt = null; heroIt = V.entry(recs.hero); }

  var resumeMeta = function () {
    var pr = V.progressOf(resumeIt.k), left = pr && pr.d && !pr.w ? Math.max(1, Math.round((pr.d - pr.p) / 60)) : 0;
    return [resumeIt.t === 'episode' ? V.epLabel(resumeIt) + (resumeIt.et ? ' · ' + resumeIt.et : '') : heroIt.y, resumeNext ? 'Next episode' : left ? left + ' min left' : ''].filter(Boolean);
  };
  if (!heroIt && hasVod) { var pool = S.movies.concat(S.shows).filter(function (x) { return x.i; }); heroIt = pool[Math.floor(Math.random() * Math.min(pool.length, 200))]; }
  var html = '';
  if ((S.data.home.hidden || []).indexOf('hero') >= 0) { heroIt = null; resumeIt = null; } // (Customise → "The big banner at the top": off)
  if (heroIt && (heroIt.t === 'movie' || heroIt.t === 'show')) {
    html += '<section class="hero" style="--tint:' + V.tint(heroIt.n) + '"><div class="hero-bg">' + (heroIt.bd || heroIt.i ? '<img src="' + V.esc(heroIt.bd || heroIt.i) + '" alt="" referrerpolicy="no-referrer"' + (heroIt.bd ? '' : ' class="blur"') + '>' : '') + '</div>' +
      '<div class="hero-body"><div class="hero-kicker">' + (resumeIt ? 'Continue watching' : V.esc(heroIt.t === 'show' ? 'Series' : 'Movie') + (recs.hero === heroIt.k ? ' · Picked for you' : '')) + '</div><h2 class="hero-t">' + V.esc(heroIt.n) + '</h2>' +
      '<div class="hero-meta">' + (resumeIt ? resumeMeta() : [heroIt.y, heroIt.c, heroIt.r ? '★ ' + heroIt.r : '', (heroIt.gn || []).slice(0, 3).join(' · ')].filter(Boolean)).map(V.esc).join('<span class="dot-sep"></span>') + '</div>' +
      (resumeIt && !resumeNext && V.pctOf(resumeIt.k) > 0 ? '<div class="hero-prog" role="presentation"><i style="width:' + Math.round(V.pctOf(resumeIt.k) * 100) + '%"></i></div>' : '') +
      '<p class="hero-plot" hidden></p>' +
      '<div class="hero-acts"><button class="btn primary lg" data-hero="play">' + V.icon('play') + (resumeIt ? (resumeNext ? ' Play ' : ' Resume ') + (resumeIt.t === 'episode' ? V.esc(V.epLabel(resumeIt)) : '') : ' Play') + '</button><a class="btn lg" href="' + V.hrefOf(heroIt) + '">' + V.icon('info') + ' More info</a>' +
      '<button class="icon-btn lg" data-hero="list" aria-label="My List">' + V.icon(V.inList('list', heroIt.k) ? 'check' : 'plus') + '</button></div></div></section>';
  }
  if (hasVod && !V.areaOff('moods')) html += '<div class="moods"><button class="chip accent" data-home="surprise">' + V.icon('sparkle') + ' Surprise me</button>' + (S.boot && S.boot.profiles && S.boot.profiles.length > 1 ? '<a class="chip" href="#/together">' + V.icon('party') + ' Pick for several of us</a>' : '') + V.MOODS.filter(function (m) { return !(S.profile && S.profile.kids && (m.id === 'scary' || m.id === 'kids')); }).map(function (m) { return '<a class="chip" href="#/mood/' + m.id + '">' + V.esc(m.label) + '</a>'; }).join('') /* (a kids' profile: no "Something scary", and everything is for kids already) */ + '</div>';
  html += '<div class="rows"></div><div class="home-foot"><button class="btn ghost" data-home="customize">' + V.icon('sliders') + ' Customise this page</button>' + (V.homeFootExtra ? V.homeFootExtra() : '') + '</div>';
  view.innerHTML = '<h1 class="sr-only">Home</h1>' + html;
  if (heroIt) {
    V.$('[data-hero=play]', view) && (V.$('[data-hero=play]', view).onclick = function () { V.play(resumeIt || heroIt); });
    var lb = V.$('[data-hero=list]', view);
    if (lb) lb.onclick = function () { V.toggle('list', heroIt.k).then(function (on) { lb.innerHTML = V.icon(on ? 'check' : 'plus'); V.toast(on ? 'Added to My List' : 'Removed from My List'); }); };
    V.details(heroIt.k).then(function (d) {
      // (The page may have been drawn again with another title by now.)
      var ht = V.$('.hero-t', view);
      if (!ht || ht.textContent !== heroIt.n) return;
      var p = V.$('.hero-plot', view);
      if (p && d.plot && !resumeIt) { p.textContent = d.plot; p.hidden = false; }
      // Swap the blurred poster for the backdrop (something else may already have copied the details onto the item).
      if (d.bd) { if (!heroIt.bd) heroIt.bd = d.bd; var img = V.$('.hero-bg img.blur', view); if (img) { img.src = d.bd; img.classList.remove('blur'); } }
    }).catch(function () {});
  }
  V.$('[data-home=customize]', view).onclick = V.customizeHome;
  var sb = V.$('[data-home=surprise]', view);
  if (sb) sb.onclick = function () { V.surprise(); };

  var rows = V.$('.rows', view);
  // Rows are built first, then put in order and cut to a page's worth (see below).
  var built = [], curId = '';
  var push = function (el, id) { if (el) built.push({ id: id || curId, el: el }); };
  var add = function (o) { push(V.row(o)); };
  // The recommendation rows (top picks, because you watched…, genres, people) are one row, "For you", with a chip
  // for each; the two channel rows are one, "Your channels". Each sits where the first of its parts would have.
  var recSets = [], chanSets = {};
  var rec = function (o) { if (o.items && o.items.length) { if (!recSets.length) built.push({ id: 'foryou', ph: 'foryou' }); recSets.push(o); } };
  var chan = function (which, items) { if (!chanSets.favs && !chanSets.recentch) built.push({ id: 'channels', ph: 'channels' }); chanSets[which] = items; };
  var builders = {
    continue: function () {
      var cw = V.continueWatching();
      // (Light catalogue: these are the likeliest to be played next — their stream addresses fetched now, not after Play.)
      var need = cw.map(function (c) { return c.it; }).filter(function (x) { return x && x.lz && !x.u; }).slice(0, 40).map(function (x) { return x.k; });
      if (need.length && V.fetchAddresses) V.fetchAddresses(need).catch(function () {});
      add({ id: 'continue', title: 'Continue watching for ' + S.profile.name, items: cw.map(function (c) { return { it: c.it, next: c.next }; }), cardOpts: { shape: 'wide', showName: true } }); // (opens its page, with Resume: ui.js V.cardClick)
    },
    list: function () { add({ id: 'list', title: 'My List', items: V.myListOrdered ? V.myListOrdered().filter(notHidden) : keysToItems(S.data.list), more: '#/mine' }); },
    neweps: function () {
      var ne = S.data.newEps || {};
      var items = Object.keys(ne).sort(function (a, b) { return ne[b].at - ne[a].at; }).map(V.entry).filter(notHidden);
      add({ id: 'neweps', title: 'New episodes', items: items });
    },
    ontv: function () {
      if (!S.live.length) return;
      V.ON_TV.forEach(function (kind) {
        var items = V.onTvNow(kind.id).slice(0, 30);
        if (items.length >= 3) add({ id: 'ontv:' + kind.id, title: kind.label, items: items, play: true, more: '#/guide' });
      });
    },
    onlater: function () { push(V.onLaterRow && V.onLaterRow()); },
    events: function () { push(V.eventsRow && !V.areaOff('follow') && V.eventsRow()); },
    shared: function () {
      var soc = S.socialCache;
      if (!soc || V.areaOff('messages')) return;
      var seen = new Set(), items = [];
      (S.recentShares || []).forEach(function (m) { var it = V.entry(m.item.k); if (it && !seen.has(it.k)) { seen.add(it.k); items.push(it); } });
      add({ id: 'shared', title: 'Sent to you', items: items.slice(0, 20), more: '#/messages' });
    },
    top: function () { rec({ id: 'top', title: 'Top picks', items: keysToItems(recs.top).slice(0, 30) }); },
    mix: function () { (recs.rows || []).filter(function (r) { return r.id.indexOf('mix:') === 0; }).forEach(function (r) { rec({ id: r.id, title: r.title, items: keysToItems(r.keys) }); }); },
    people: function () { (recs.rows || []).filter(function (r) { return r.id.indexOf('cast:') === 0 || r.id.indexOf('dir:') === 0; }).forEach(function (r) { rec({ id: r.id, title: r.title, items: keysToItems(r.keys) }); }); },
    because: function () { (recs.rows || []).filter(function (r) { return r.id.indexOf('because:') === 0; }).forEach(function (r) { rec({ id: r.id, title: r.title, items: keysToItems(r.keys) }); }); },
    genres: function () { (recs.rows || []).filter(function (r) { return r.id.indexOf('genre:') === 0; }).forEach(function (r) { rec({ id: r.id, title: r.title, items: keysToItems(r.keys) }); }); },
    live: function () {
      var favs = keysToItems(S.data.favs).filter(function (x) { return x.t === 'live'; });
      var recent = V.recentChannels().filter(function (x) { return x.t === 'live'; });
      var seen = new Set(), items = [];
      favs.concat(recent).forEach(function (c) { if (!seen.has(c.k)) { seen.add(c.k); items.push(c); } });
      // (The first 40 with something on: not a look at every channel.)
      if (items.length < 12) for (var i = 0, got = 0; got < 40 && i < S.live.length; i++) { var c = S.live[i]; if (V.epg.nowNext(c).now) { got++; if (!seen.has(c.k)) { seen.add(c.k); items.push(c); } } }
      if (!items.length) items = S.live.slice(0, 30);
      add({ id: 'live', title: 'On now', items: items.slice(0, 40), more: '#/live', play: true });
    },
    favs: function () { chan('favs', keysToItems(S.data.favs).filter(function (x) { return x.t === 'live' || x.t === 'radio'; })); },
    recentch: function () { chan('recentch', V.recentChannels().slice(0, 30)); },
    household: function () { add({ id: 'household', title: 'Popular in your household', items: keysToItems(recs.household), numbered: true }); },
    new: function () {
      var items = V.topN([S.movies, S.shows], 40, function (x) { return x.ad && notHidden(x) ? x.ad : 0; });
      add({ id: 'new', title: 'New additions', items: items, more: '#/movies?sort=new' });
    },
    pinned: function () {
      (S.data.home.pinned || []).forEach(function (p) {
        var parts = p.split('|'), type = parts[0], g = parts.slice(1).join('|');
        var m = V.groupItems(type, g);
        if (m && m.length) add({ id: 'pinned:' + p, title: V.smart ? V.smart.label(g, type) : g, items: m.slice(0, 40), more: '#/' + ({ live: 'live', radio: 'radio', movie: 'movies', show: 'series' }[type]) + '?g=' + encodeURIComponent(g), play: type === 'live' || type === 'radio' });
      });
    },
    sharedlists: function () { V.sharedLists().forEach(function (l) { add({ id: 'shared:' + l.id, title: l.name + ' · shared list', items: l.items.map(function (x) { return V.entry(x.k); }).filter(Boolean), more: '#/mine' }); }); },
    random: function () {
      if (!hasVod) return;
      // (24 picked straight from the lists — the same ones all day for this profile — instead of sorting all of them
      // into a random order first: on a big catalogue that was a quarter of a second of every visit to Home.)
      var ok = function (x) { return x && x.i && notHidden(x) && !V.progressOf(x.k); };
      add({ id: 'random', title: 'Something different', items: V.sample([S.movies, S.shows], 24, V.hash(new Date().toDateString() + S.profile.id), ok), track: true });
    },
  };
  order.forEach(function (id) { curId = id; if (!hid.has(id) && builders[id]) { try { builders[id](); } catch (e) { console.error(e); } } else if (!hid.has(id) && V.homeRowBuilder) { try { V.homeRowBuilder(id, add); } catch (e) { console.error(e); } } }); // (rows from lists: homelists.js)
  // "For you": the chip chosen last time (this visit) stays chosen.
  var forYou = function (i) {
    var set = recSets[i] || recSets[0];
    var el = V.row({ id: 'foryou', title: 'For ' + S.profile.name, items: set.items, track: true });
    if (!el) return null;
    if (recSets.length > 1) {
      var chips = document.createElement('div');
      chips.className = 'chips fy-chips'; chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Which picks');
      chips.innerHTML = recSets.slice(0, 12).map(function (r, j) { return '<button class="chip sm' + (r === set ? ' on' : '') + '" data-fy="' + j + '" aria-pressed="' + (r === set) + '">' + V.esc(r.title) + '</button>'; }).join('');
      el.insertBefore(chips, V.$('.row-wrap', el));
      chips.onclick = function (e) {
        var b = e.target.closest('[data-fy]');
        if (!b || !el.parentNode) return;
        V.ls.session('home.fy', recSets[+b.dataset.fy].id);
        var nu = forYou(+b.dataset.fy);
        if (nu) { nu._hid = 'foryou'; el.parentNode.replaceChild(nu, el); var on = V.$('.fy-chips .on', nu); if (on && on.focus) on.focus(); }
      };
    }
    return el;
  };
  built.forEach(function (b) {
    if (b.ph === 'foryou') { var want = V.ls.session('home.fy'), at = 0; recSets.forEach(function (r, j) { if (r.id === want) at = j; }); b.el = forYou(at); }
    if (b.ph === 'channels') {
      var seenCh = {}, both = (chanSets.favs || []).concat(chanSets.recentch || []).filter(function (c) { if (seenCh[c.k]) return false; seenCh[c.k] = 1; return true; });
      b.el = V.row({ id: 'channels', title: 'Your channels', items: both, play: true, more: chanSets.favs && chanSets.favs.length ? '#/live?g=__fav' : '#/live' });
    }
  });
  built = built.filter(function (b) { return b.el; });
  // The order: yours, if you set one in Customise. Otherwise the page sorts itself (V.homeOrder): what you're in the
  // middle of and new episodes first, live TV up at the hours you watch it here, rows you use up, rows you never do down.
  var ids = [];
  built.forEach(function (b) { if (ids.indexOf(b.id) < 0) ids.push(b.id); });
  if (!V.homeManual()) {
    var sorted = V.homeOrder(ids);
    built = built.map(function (b, i) { return { b: b, i: i }; }).sort(function (x, y) { return (sorted.indexOf(x.b.id) - sorted.indexOf(y.b.id)) || (x.i - y.i); }).map(function (x) { return x.b; });
  }
  // A page's worth (8 rows); the rest behind "More" — open for the rest of this visit once asked for.
  // (Rows that are still hidden — events and "on later" fill in afterwards, or go away — don't use up a place.)
  var CAP = 8, shownN = 0, cut = built.length;
  built.forEach(function (b, i) { if (!b.el.hidden) shownN++; if (shownN === CAP && cut === built.length) cut = i + 1; });
  var open = !!V.ls.session('home.more') || built.length - cut <= 1;
  built.forEach(function (b, i) { b.el._hid = b.id; if (open || i < cut) rows.appendChild(b.el); });
  if (!open) {
    var rest = built.slice(cut);
    var mb = document.createElement('div');
    mb.className = 'home-more';
    mb.innerHTML = '<button class="btn" data-home="more">' + V.icon('down') + ' ' + rest.length + ' more rows</button>';
    rows.appendChild(mb);
    V.$('button', mb).onclick = function () {
      V.ls.session('home.more', 1);
      mb.remove();
      rest.forEach(function (b) { rows.appendChild(b.el); });
      var f = null;
      rest.some(function (b) { f = b.el.hidden ? null : V.$('a[href], button:not([disabled]), [tabindex="0"]', b.el); return !!f; });
      if (f && f.focus) f.focus();
    };
  }
  var seenIds = [];
  built.slice(0, open ? built.length : cut).forEach(function (b) { if (!b.el.hidden && seenIds.indexOf(b.id) < 0) seenIds.push(b.id); });
  V.homeSeen(seenIds);
  rows.addEventListener('click', function (e) {
    var sec = e.target.closest('.card, .ol-card') && e.target.closest('section.row, section');
    if (sec && sec._hid) V.homeUsed(sec._hid);
  });
  if (!rows.children.length) {
    rows.innerHTML = S.items.length ? V.empty('Nothing here yet', 'Start watching something and this page fills up with picks for you.') : V.empty('No channels or videos yet', S.profile.admin ? 'Add your playlists in Admin → Lists. Everyone sees them as soon as they’re loaded.' : 'The admin hasn’t added any playlists yet.', S.profile.admin ? '<a class="btn primary" href="#/admin/lists?add=1">Add a list</a>' : '');
  }
  if (!S.recs || Date.now() - (S.recsAt || 0) > 5 * 60e3) V.loadRecs();
  if (V.loadHomeLists) V.loadHomeLists();
});

/* How this profile uses Home on this device: which rows it picks from, and whether it watches live TV or films and
   series at each time of day. Kept on the device (so a TV and a phone each get their own order); halved every two
   weeks so old habits fade. */
var LIVE_ROWS = { live: 1, ontv: 1, events: 1, onlater: 1, channels: 1 };
var useKey = function () { return 'home.use.' + ((S.profile && S.profile.id) || ''); };
var useGet = function () {
  var u = V.ls.get(useKey(), null) || {};
  u.r = u.r || {}; u.s = u.s || {}; u.h = u.h || {};
  var day = Math.floor(Date.now() / 86400e3);
  if (!u.d) u.d = day;
  if (day - u.d >= 14) { u.d = day; [u.r, u.s].forEach(function (m) { Object.keys(m).forEach(function (k) { m[k] = Math.floor(m[k] / 2); if (!m[k]) delete m[k]; }); }); Object.keys(u.h).forEach(function (k) { u.h[k] = [Math.floor(u.h[k][0] / 2), Math.floor(u.h[k][1] / 2)]; }); }
  return u;
};
var hourBucket = function () { var h = new Date().getHours(); return h < 5 ? 'n' : h < 11 ? 'm' : h < 17 ? 'a' : h < 23 ? 'e' : 'n'; };
V.homeUsed = function (id) { var u = useGet(); u.r[id] = Math.min(999, (u.r[id] || 0) + 1); V.ls.set(useKey(), u); };
/** Rows shown on a visit (counted at most once every ten minutes: the page is drawn several times as things load). */
V.homeSeen = function (ids) {
  var u = useGet();
  if (Date.now() - (u.t || 0) < 600e3) return;
  u.t = Date.now();
  ids.forEach(function (id) { u.s[id] = Math.min(999, (u.s[id] || 0) + 1); });
  V.ls.set(useKey(), u);
};
/** Something was played: live or not, at this time of day. */
V.homePlayed = function (it) {
  if (!it || !S.profile) return;
  var u = useGet(), b = hourBucket(), c = u.h[b] || [0, 0];
  c[it.t === 'live' || it.t === 'radio' || it.t === 'catchup' ? 0 : 1]++;
  u.h[b] = c;
  V.ls.set(useKey(), u);
};
/** Did this profile put the rows in an order of its own (Customise → the arrows)? Saved in the standard order — as
    Customise used to do when only a row was hidden — isn't one. */
V.homeManual = function () {
  var o = (S.data.home && S.data.home.order) || [];
  if (!o.length) return false;
  // (Rows from lists — "xl:…" — are put after Continue by the page that adds them: where they sit isn't your order.)
  var std = V.HOME_ROWS.map(function (r) { return r.id; }).filter(function (id) { return o.indexOf(id) >= 0 && id.indexOf('xl:') !== 0; });
  var mine = o.filter(function (id) { return std.indexOf(id) >= 0; });
  return mine.join('|') !== std.join('|');
};
/** The rows' ids, sorted for now (the order given is the standard one). */
V.homeOrder = function (ids, use, bucket, tv) {
  var u = use || useGet(), c = u.h[bucket || hourBucket()] || [0, 0], n = c[0] + c[1];
  var liveAdj = n >= 5 ? (c[0] / n > 0.6 ? -6 : c[0] / n < 0.25 ? 3 : 0) : (tv === undefined ? V.device.tv : tv) ? -2 : 0;
  var FIRST = { 'continue': -300, neweps: -200, shared: -100 };
  var score = {};
  ids.forEach(function (id, i) {
    if (FIRST[id]) { score[id] = FIRST[id]; return; }
    var clicks = u.r[id] || 0;
    score[id] = i - Math.min(5, 1.5 * Math.log(1 + clicks) / Math.LN2) + ((u.s[id] || 0) >= 15 && !clicks ? 4 : 0) + (LIVE_ROWS[id] ? liveAdj : 0);
  });
  return ids.slice().sort(function (a, b) { return (score[a] - score[b]) || (ids.indexOf(a) - ids.indexOf(b)); });
};

V.loadRecs = function () {
  if (V._recsLoading) return V._recsLoading; // (one request at a time: start-up asks from several places)
  S.recsAt = Date.now();
  var who = S.profile && S.profile.id;
  var mine = V._recsLoading = V.api('/api/recs').then(function (r) {
    if (!S.profile || S.profile.id !== who) return; // (someone else picked their profile meanwhile)
    var changed = JSON.stringify(r.top) !== JSON.stringify((S.recs || {}).top);
    S.recs = r;
    if (changed && document.body.dataset.page === 'home') V.router.refresh();
  }).catch(function () {}).then(function () { if (V._recsLoading === mine) V._recsLoading = null; });
  return mine;
};

/** A title's full details, kept for a couple of minutes (the home page is re-drawn several times as things load). */
V.details = function (k) {
  var c = V._details || (V._details = {});
  var hit = c[k];
  if (hit && Date.now() - hit.at < 120e3) return hit.p;
  var p = V.api('/api/item/' + encodeURIComponent(k));
  c[k] = { at: Date.now(), p: p };
  p.catch(function () { if (c[k] && c[k].p === p) delete c[k]; });
  return p;
};

V.route('mood', function (view, r) {
  var m = V.MOODS.filter(function (x) { return x.id === r.args[0]; })[0];
  if (!m) return V.router.go('#/home', true);
  view.innerHTML = V.pageHead(m.label) + '<div class="grid-host"></div>';
  V.grid(V.$('.grid-host', view), V.moodItems(m.id), { empty: 'Nothing matched this mood yet. Titles need genre information — the admin can turn on TMDB in Admin → Recommendations.' });
});

V.customizeHome = function () {
  var home = S.data.home;
  var order = (home.order && home.order.length ? home.order : []).concat(V.HOME_ROWS.map(function (r) { return r.id; })).filter(function (x, i, a) { return a.indexOf(x) === i && V.HOME_ROWS.some(function (r) { return r.id === x; }); });
  var hidden = new Set(home.hidden || []);
  var pinned = (home.pinned || []).slice();
  var moved = false;
  var render = function (d) {
    V.$('.rows-edit', d).innerHTML = order.map(function (id, i) {
      var r = V.HOME_ROWS.filter(function (x) { return x.id === id; })[0];
      return '<li><label class="check"><input type="checkbox" data-show="' + id + '"' + (hidden.has(id) ? '' : ' checked') + '><span>' + V.esc(r.name) + '</span></label><span class="sp"></span>' +
        '<button class="icon-btn sm" data-up="' + i + '" aria-label="Move up"' + (i ? '' : ' disabled') + '>' + V.icon('up') + '</button><button class="icon-btn sm" data-down="' + i + '" aria-label="Move down"' + (i < order.length - 1 ? '' : ' disabled') + '>' + V.icon('down') + '</button></li>';
    }).join('');
    V.$('.pins', d).innerHTML = pinned.length ? pinned.map(function (p, i) { return '<span class="chip on">' + V.esc(V.smart ? V.smart.label(p.split('|').slice(1).join('|'), p.split('|')[0]) : p.split('|').slice(1).join('|')) + ' <button class="x" data-unpin="' + i + '" aria-label="Unpin">' + V.icon('x') + '</button></span>'; }).join('') : '<span class="dim">No pinned categories yet.</span>';
  };
  var groupOpts = [];
  ['movie', 'show', 'live', 'radio'].forEach(function (t) { V.groupList(t).forEach(function (g) { groupOpts.push('<option value="' + V.esc(t + '|' + g.name) + '">' + V.esc(V.TYPE_NAMES[t] + ' · ' + g.label) + ' (' + g.items.length + ')</option>'); }); });
  V.dialog({
    title: 'Customise your home page', wide: true,
    body: '<p class="dim">Choose which rows you see. Until you move one, the page orders them itself — by the time of day, this device, and the rows you use; move any with the arrows and they stay in your order (Reset goes back). Recommendations share one “For you” row, and favourite and recent channels one “Your channels” row.</p><label class="check"><input type="checkbox" data-show="hero"' + (hidden.has('hero') ? '' : ' checked') + '><span>The big banner at the top (what to resume, or a pick for you)</span></label><ul class="rows-edit"></ul>' + (V.homeFootExtra ? '<p>' + V.homeFootExtra() + '</p>' : '') + '<h3>Pinned categories</h3><p class="dim">Pinned categories get their own row.</p><div class="pins chips"></div>' +
      '<div class="inline"><select class="input" data-pick><option value="">Choose a category…</option>' + groupOpts.join('') + '</select><button class="btn" data-pin>Pin</button></div>',
    actions: [{ label: 'Reset', fn: function () { S.data.home = { order: [], hidden: [], pinned: [] }; V.saveHome(); V.router.refresh(); } }, { label: 'Save', primary: true, fn: function () { S.data.home = { order: moved || V.homeManual() ? order : [], hidden: Array.from(hidden), pinned: pinned }; V.saveHome(); V.router.refresh(); } }],
    onOpen: function (d) {
      render(d);
      d.addEventListener('click', function (e) {
        var b;
        if ((b = e.target.closest('[data-up]'))) { moved = true; var i = +b.dataset.up; order.splice(i - 1, 0, order.splice(i, 1)[0]); render(d); }
        else if ((b = e.target.closest('[data-down]'))) { moved = true; var j = +b.dataset.down; order.splice(j + 1, 0, order.splice(j, 1)[0]); render(d); }
        else if ((b = e.target.closest('[data-unpin]'))) { pinned.splice(+b.dataset.unpin, 1); render(d); }
        else if (e.target.closest('[data-pin]')) { var v = V.$('[data-pick]', d).value; if (v && pinned.indexOf(v) < 0) pinned.push(v); if (pinned.indexOf('pinned') < 0) hidden.delete('pinned'); render(d); }
      });
      d.addEventListener('change', function (e) { var id = e.target.dataset.show; if (id) { if (e.target.checked) hidden.delete(id); else hidden.add(id); } });
    },
  });
};

// ---------------------------------------------------------------- on TV now, by kind (from the guide's categories)
V.ON_TV = [
  { id: 'sports', label: 'Sports on now', cat: /sport|football|soccer|basketball|baseball|hockey|tennis|golf|racing|motor|boxing|mma|ufc|wrestling|cricket|rugby|athletic|nfl|nba|nhl|mlb|ncaa|f1\b|formula/i, grp: /sport|espn|ppv|dazn|nfl|nba|nhl|mlb|tsn|bein|fox sports|sky sports|tnt sports|golf|racing|ufc|wwe/i },
  { id: 'movies', label: 'Films on TV now', cat: /^(movie|movies|film|films|feature film|cinema)$|\bmovie\b/i, grp: /movie|cinema|film|hbo|starz|showtime|cinemax|tcm|amc/i, needCat: true },
  { id: 'kids', label: 'Kids’ TV on now', cat: /kids|children|animation|cartoon|preschool|family/i, grp: /kids|cartoon|disney junior|nick jr|nickelodeon|boomerang|baby/i },
  { id: 'news', label: 'News on now', cat: /news|current affairs/i, grp: /news|cnn|msnbc|fox news|bbc news|sky news|cnbc|bloomberg/i },
];
// All four kinds in one pass over the channels (tens of thousands of them), kept for the minute: the home page is drawn
// several times as things load.
var onTvMemo = null;
V.on('epg', function () { onTvMemo = null; });
V.onTvNow = function (kind) {
  if (!V.ON_TV.some(function (x) { return x.id === kind; })) return [];
  var stamp = [Math.floor(Date.now() / 60000), S.catalogStamp, S.live.length, S.data.favs.length, S.data.favs[0], S.data.hidden.length, S.data.hidden[0]].join('|');
  if (!onTvMemo || onTvMemo.stamp !== stamp) onTvMemo = { stamp: stamp, by: onTvAll() };
  return onTvMemo.by[kind].slice();
};
function onTvAll() {
  var by = {};
  V.ON_TV.forEach(function (k) { by[k.id] = []; });
  var favs = new Set(S.data.favs), hidden = new Set(S.data.hidden); // (a Set: thousands of channels × the hidden list)
  for (var i = 0; i < S.live.length; i++) {
    var c = S.live[i];
    if (hidden.has(c.k)) continue;
    // (No guide for it: nothing on, without making up the placeholder blocks to find that out.)
    var now = V.epg.has(c) ? V.epg.nowNext(c).now : null;
    if (now && now.ph) now = null; // (a placeholder block isn't a programme)
    if (!now && c.es !== 'live') continue; // (nothing on: in none of them)
    var cats = now && now.c ? [].concat(now.c).join(' ') : '';
    var gn = cats ? '' : c.g + ' ' + c.n;
    for (var j = 0; j < V.ON_TV.length; j++) {
      var k = V.ON_TV[j], hit = false;
      if (cats) hit = k.cat.test(cats);
      else if (!k.needCat) hit = k.grp.test(gn) && (k.id !== 'kids' || c.kd || /kids|cartoon|junior|nick/i.test(gn));
      if (hit) by[k.id].push([c, (favs.has(c.k) ? 2 : 0) + (now ? 1 : 0)]);
    }
  }
  Object.keys(by).forEach(function (id) { by[id] = by[id].sort(function (a, b) { return b[1] - a[1]; }).map(function (x) { return x[0]; }); });
  return by;
}

// ---------------------------------------------------------------- surprise me
V.surprise = function () {
  var recs = S.recs || {};
  var pool = (recs.top || []).slice(0, 40).map(V.entry).filter(function (x) { return x && !V.progressOf(x.k) && S.data.hidden.indexOf(x.k) < 0; });
  if (pool.length < 5) pool = pool.concat(S.movies.concat(S.shows).filter(function (x) { return x.i && (x.r || 0) >= 6.5 && !V.progressOf(x.k); }).slice(0, 300));
  if (!pool.length) return V.toast('Watch a few things first and this gets better.');
  var shown = [];
  var pick = function () { var left = pool.filter(function (x) { return shown.indexOf(x) < 0; }); if (!left.length) { shown = []; left = pool; } var it = left[Math.floor(Math.random() * left.length)]; shown.push(it); return it; };
  var it = pick();
  var draw = function (d) {
    V.$('.surprise', d).innerHTML = '<div class="sp-art">' + V.art(it.i, it.n, 'art') + '</div><div class="sp-b"><div class="dim">' + V.esc(it.t === 'show' ? 'Series' : 'Movie') + '</div><h3>' + V.esc(it.n) + '</h3><div class="dim">' + [it.y, it.r ? '★ ' + it.r : '', it.d ? V.fmtLen(it.d) : '', (it.gn || []).slice(0, 3).join(' · ')].filter(Boolean).map(V.esc).join(' · ') + '</div><p class="sp-plot dim clamp3"></p></div>';
    V.details(it.k).then(function (x) { var p = V.$('.sp-plot', d); if (p && x.plot) p.textContent = x.plot; }).catch(function () {});
  };
  V.dialog({
    title: 'How about this?', cls: 'surprise-dlg',
    body: '<div class="surprise"></div>',
    actions: [
      { label: 'Another one', fn: function (d) { it = pick(); draw(d); return false; } },
      { label: 'More info', fn: function () { V.router.go(V.hrefOf(it)); } },
      { label: 'Play', primary: true, fn: function () { V.play(it); } },
    ],
    onOpen: draw,
  });
};

// ---------------------------------------------------------------- pick something for several of us
V.route('together', function (view, r) {
  var chosen = (r.q.get('with') || '').split(',').filter(Boolean);
  var people = ((S.boot && S.boot.profiles) || []).filter(function (p) { return p.id !== S.profile.id; });
  view.innerHTML = V.pageHead('Pick for several of us') + '<p class="dim">Choose who’s watching with you. You get things everyone should like — and nobody has seen.</p>' +
    '<div class="together-who">' + people.map(function (p) { var on = chosen.indexOf(p.id) >= 0; return '<button class="who' + (on ? ' on' : '') + '" data-p="' + p.id + '" aria-pressed="' + on + '"><span class="who-av">' + V.avatar(p.avatar, 'lg') + '<span class="who-ok">' + V.icon('check') + '</span></span><span>' + V.esc(p.name) + '</span></button>'; }).join('') + '</div><div class="grid-host"></div>';
  var host = V.$('.grid-host', view);
  var seq = 0;
  var draw = function () {
    var mine = ++seq;
    if (!people.length) { host.innerHTML = V.empty('Nobody else here yet', 'This needs more than one profile. The admin can add them in Admin → Profiles.'); return; }
    if (!chosen.length) { host.innerHTML = V.empty('Who’s with you?', 'Tap the people watching with you.'); return; }
    host.innerHTML = '<div class="spinner"></div>';
    V.api('/api/recs/group?ids=' + chosen.join(',')).then(function (res) {
      if (mine !== seq) return; // (someone else was picked meanwhile)
      var items = res.keys.map(V.entry).filter(Boolean);
      host.innerHTML = '';
      if (!res.common) host.insertAdjacentHTML('beforeend', '<p class="dim">You don’t have much in common yet, so here’s a mix of each person’s top picks.</p>');
      var g = document.createElement('div');
      host.appendChild(g);
      V.grid(g, items, { empty: 'Nothing yet — watch a few things first.' });
    }).catch(function (e) { if (mine === seq) host.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
  };
  // Picking someone updates the picks in place (focus and scroll stay where they are — easier with a remote).
  V.$$('[data-p]', view).forEach(function (b) {
    b.onclick = function () {
      var i = chosen.indexOf(b.dataset.p);
      if (i >= 0) chosen.splice(i, 1); else chosen.push(b.dataset.p);
      var on = chosen.indexOf(b.dataset.p) >= 0;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
      try { history.replaceState(null, '', '#/together' + (chosen.length ? '?with=' + chosen.join(',') : '')); } catch (e) {}
      draw();
    };
  });
  draw();
});

// ---------------------------------------------------------------- a new profile: what do you like?
V.onboard = function () {
  V.api('/api/onboard').then(function (r) {
    var items = r.keys.map(V.entry).filter(Boolean);
    if (items.length < 8) { V.setPref('onboarded', true); return; }
    var picked = [];
    V.dialog({
      title: 'What do you like?', wide: true, cls: 'onboard-dlg', dismiss: false,
      body: '<p class="dim">Pick a few things you’ve enjoyed (3 or more), and your recommendations start from there.</p><div class="onb-grid">' + items.map(function (it) {
        return '<button class="onb" data-k="' + V.esc(it.k) + '" aria-pressed="false">' + V.art(it.i, it.n, 'art') + '<span class="onb-t">' + V.esc(it.n) + '</span><span class="onb-ok">' + V.icon('check') + '</span></button>';
      }).join('') + '</div>',
      actions: [
        { label: 'Skip', fn: function () { V.setPref('onboarded', true); } },
        { label: 'Done', primary: true, fn: function (d) {
          if (picked.length < 3) { V.toast('Pick at least 3'); return false; }
          return V.api('/api/onboard', { body: { keys: picked } }).then(function () { S.data.prefs.onboarded = true; picked.forEach(function (k) { S.data.ratings[k] = 1; }); V.toast('Thanks! Your picks are being worked out.'); setTimeout(function () { V.loadRecs(); }, 2500); });
        } },
      ],
      onOpen: function (d) {
        d.addEventListener('click', function (e) {
          var b = e.target.closest('.onb');
          if (!b) return;
          var k = b.dataset.k, i = picked.indexOf(k);
          if (i >= 0) picked.splice(i, 1); else picked.push(k);
          b.setAttribute('aria-pressed', i < 0);
          b.classList.toggle('on', i < 0);
          V.$('.dlg-f .primary', d).textContent = picked.length ? 'Done (' + picked.length + ')' : 'Done';
        });
      },
    });
  }).catch(function () {});
};
