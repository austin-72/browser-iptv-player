/* Home: hero, then rows — continue watching, recommendations, live now, new… in the order the profile chose. */
'use strict';

V.HOME_ROWS = [
  { id: 'continue', name: 'Continue watching' },
  { id: 'shared', name: 'Sent to you' },
  { id: 'list', name: 'My List' },
  { id: 'top', name: 'Top picks for you' },
  { id: 'mix', name: 'Recommended by several things you watched' },
  { id: 'because', name: 'Because you watched…' },
  { id: 'people', name: 'Actors and directors you like' },
  { id: 'live', name: 'On now' },
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
  var notHidden = function (it) { return it && S.data.hidden.indexOf(it.k) < 0; };
  var keysToItems = function (keys) { return (keys || []).map(V.entry).filter(notHidden); };
  var hasVod = S.movies.length + S.shows.length > 0;

  // Hero
  var heroIt = V.entry(recs.hero) || (V.continueWatching()[0] || {}).it;
  if (heroIt && heroIt.t === 'episode') heroIt = V.showOf(heroIt) || heroIt;
  if (!heroIt && hasVod) { var pool = S.movies.concat(S.shows).filter(function (x) { return x.i; }); heroIt = pool[Math.floor(Math.random() * Math.min(pool.length, 200))]; }
  var html = '';
  if (heroIt && (heroIt.t === 'movie' || heroIt.t === 'show')) {
    html += '<section class="hero" style="--tint:' + V.tint(heroIt.n) + '"><div class="hero-bg">' + (heroIt.bd || heroIt.i ? '<img src="' + V.esc(heroIt.bd || heroIt.i) + '" alt="" referrerpolicy="no-referrer"' + (heroIt.bd ? '' : ' class="blur"') + '>' : '') + '</div>' +
      '<div class="hero-body"><div class="hero-kicker">' + V.esc(heroIt.t === 'show' ? 'Series' : 'Movie') + (recs.hero === heroIt.k ? ' · Picked for you' : '') + '</div><h2 class="hero-t">' + V.esc(heroIt.n) + '</h2>' +
      '<div class="hero-meta">' + [heroIt.y, heroIt.c, heroIt.r ? '★ ' + heroIt.r : '', (heroIt.gn || []).slice(0, 3).join(' · ')].filter(Boolean).map(V.esc).join('<span class="dot-sep"></span>') + '</div>' +
      '<p class="hero-plot" hidden></p>' +
      '<div class="hero-acts"><button class="btn primary lg" data-hero="play">' + V.icon('play') + ' Play</button><a class="btn lg" href="' + V.hrefOf(heroIt) + '">' + V.icon('info') + ' More info</a>' +
      '<button class="icon-btn lg" data-hero="list" aria-label="My List">' + V.icon(V.inList('list', heroIt.k) ? 'check' : 'plus') + '</button></div></div></section>';
  }
  if (hasVod) html += '<div class="moods">' + V.MOODS.map(function (m) { return '<a class="chip" href="#/mood/' + m.id + '">' + V.esc(m.label) + '</a>'; }).join('') + '</div>';
  html += '<div class="rows"></div><div class="home-foot"><button class="btn ghost" data-home="customize">' + V.icon('sliders') + ' Customise this page</button></div>';
  view.innerHTML = html;
  if (heroIt) {
    V.$('[data-hero=play]', view) && (V.$('[data-hero=play]', view).onclick = function () { V.play(heroIt); });
    var lb = V.$('[data-hero=list]', view);
    if (lb) lb.onclick = function () { V.toggle('list', heroIt.k).then(function (on) { lb.innerHTML = V.icon(on ? 'check' : 'plus'); V.toast(on ? 'Added to My List' : 'Removed from My List'); }); };
    V.api('/api/item/' + encodeURIComponent(heroIt.k)).then(function (d) {
      var p = V.$('.hero-plot', view);
      if (p && d.plot) { p.textContent = d.plot; p.hidden = false; }
      if (d.bd && !heroIt.bd) { heroIt.bd = d.bd; var img = V.$('.hero-bg img', view); if (img) { img.src = d.bd; img.classList.remove('blur'); } }
    }).catch(function () {});
  }
  V.$('[data-home=customize]', view).onclick = V.customizeHome;

  var rows = V.$('.rows', view);
  var add = function (o) { var r = V.row(o); if (r) rows.appendChild(r); };
  var builders = {
    continue: function () { add({ id: 'continue', title: 'Continue watching for ' + S.profile.name, items: V.continueWatching().map(function (c) { return { it: c.it, next: c.next, play: true }; }), cardOpts: { shape: 'wide', showName: true }, play: true }); },
    list: function () { add({ id: 'list', title: 'My List', items: keysToItems(S.data.list), more: '#/mine' }); },
    shared: function () {
      var soc = S.socialCache;
      if (!soc) return;
      var seen = new Set(), items = [];
      (S.recentShares || []).forEach(function (m) { var it = V.entry(m.item.k); if (it && !seen.has(it.k)) { seen.add(it.k); items.push(it); } });
      add({ id: 'shared', title: 'Sent to you', items: items.slice(0, 20), more: '#/messages' });
    },
    top: function () { add({ id: 'top', title: 'Top picks for ' + S.profile.name, items: keysToItems(recs.top).slice(0, 30), track: true }); },
    mix: function () { (recs.rows || []).filter(function (r) { return r.id.indexOf('mix:') === 0; }).forEach(function (r) { add({ id: r.id, title: r.title, items: keysToItems(r.keys), track: true }); }); },
    people: function () { (recs.rows || []).filter(function (r) { return r.id.indexOf('cast:') === 0 || r.id.indexOf('dir:') === 0; }).forEach(function (r) { add({ id: r.id, title: r.title, items: keysToItems(r.keys), track: true }); }); },
    because: function () { (recs.rows || []).filter(function (r) { return r.id.indexOf('because:') === 0; }).forEach(function (r) { add({ id: r.id, title: r.title, items: keysToItems(r.keys), track: true }); }); },
    genres: function () { (recs.rows || []).filter(function (r) { return r.id.indexOf('genre:') === 0; }).forEach(function (r) { add({ id: r.id, title: r.title, items: keysToItems(r.keys), track: true }); }); },
    live: function () {
      var favs = keysToItems(S.data.favs).filter(function (x) { return x.t === 'live'; });
      var recent = V.recentChannels().filter(function (x) { return x.t === 'live'; });
      var seen = new Set(), items = [];
      favs.concat(recent).forEach(function (c) { if (!seen.has(c.k)) { seen.add(c.k); items.push(c); } });
      if (items.length < 12) S.live.filter(function (c) { return V.epg.nowNext(c).now; }).slice(0, 40).forEach(function (c) { if (!seen.has(c.k)) { seen.add(c.k); items.push(c); } });
      if (!items.length) items = S.live.slice(0, 30);
      add({ id: 'live', title: 'On now', items: items.slice(0, 40), more: '#/live', play: true });
    },
    favs: function () { add({ id: 'favs', title: 'Favourite channels', items: keysToItems(S.data.favs).filter(function (x) { return x.t === 'live' || x.t === 'radio'; }), play: true, more: '#/live?g=__fav' }); },
    recentch: function () { add({ id: 'recentch', title: 'Recently watched channels', items: V.recentChannels().slice(0, 30), play: true }); },
    household: function () { add({ id: 'household', title: 'Popular in your household', items: keysToItems(recs.household), numbered: true }); },
    new: function () {
      var items = S.movies.concat(S.shows).filter(function (x) { return x.ad && notHidden(x); }).sort(function (a, b) { return b.ad - a.ad; }).slice(0, 40);
      add({ id: 'new', title: 'New additions', items: items, more: '#/movies?sort=new' });
    },
    pinned: function () {
      (S.data.home.pinned || []).forEach(function (p) {
        var parts = p.split('|'), type = parts[0], g = parts.slice(1).join('|');
        var m = S.groups[type] && S.groups[type].get(g);
        if (m && m.length) add({ id: 'pinned:' + p, title: g, items: m.slice(0, 40), more: '#/' + ({ live: 'live', radio: 'radio', movie: 'movies', show: 'series' }[type]) + '?g=' + encodeURIComponent(g), play: type === 'live' || type === 'radio' });
      });
    },
    sharedlists: function () { V.sharedLists().forEach(function (l) { add({ id: 'shared:' + l.id, title: l.name + ' · shared list', items: l.items.map(function (x) { return V.entry(x.k); }).filter(Boolean), more: '#/mine' }); }); },
    random: function () {
      if (!hasVod) return;
      var pool = S.movies.concat(S.shows).filter(function (x) { return x.i && notHidden(x) && !V.progressOf(x.k); });
      add({ id: 'random', title: 'Something different', items: V.shuffle(pool, V.hash(new Date().toDateString() + S.profile.id)).slice(0, 24), track: true });
    },
  };
  order.forEach(function (id) { if (!hid.has(id) && builders[id]) { try { builders[id](); } catch (e) { console.error(e); } } });
  if (!rows.children.length) {
    rows.innerHTML = S.items.length ? V.empty('Nothing here yet', 'Start watching something and this page fills up with picks for you.') : V.empty('No channels or videos yet', S.profile.admin ? 'Add your playlists in Admin → Lists. Everyone sees them as soon as they’re loaded.' : 'The admin hasn’t added any playlists yet.', S.profile.admin ? '<a class="btn primary" href="#/admin/lists">Add a list</a>' : '');
  }
  if (!S.recs || Date.now() - (S.recsAt || 0) > 5 * 60e3) V.loadRecs();
});

V.loadRecs = function () {
  S.recsAt = Date.now();
  return V.api('/api/recs').then(function (r) {
    var changed = JSON.stringify(r.top) !== JSON.stringify((S.recs || {}).top);
    S.recs = r;
    if (changed && document.body.dataset.page === 'home') V.router.refresh();
  }).catch(function () {});
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
  var render = function (d) {
    V.$('.rows-edit', d).innerHTML = order.map(function (id, i) {
      var r = V.HOME_ROWS.filter(function (x) { return x.id === id; })[0];
      return '<li><label class="check"><input type="checkbox" data-show="' + id + '"' + (hidden.has(id) ? '' : ' checked') + '><span>' + V.esc(r.name) + '</span></label><span class="sp"></span>' +
        '<button class="icon-btn sm" data-up="' + i + '" aria-label="Move up"' + (i ? '' : ' disabled') + '>' + V.icon('up') + '</button><button class="icon-btn sm" data-down="' + i + '" aria-label="Move down"' + (i < order.length - 1 ? '' : ' disabled') + '>' + V.icon('down') + '</button></li>';
    }).join('');
    V.$('.pins', d).innerHTML = pinned.length ? pinned.map(function (p, i) { return '<span class="chip on">' + V.esc(p.split('|').slice(1).join('|')) + ' <button class="x" data-unpin="' + i + '" aria-label="Unpin">' + V.icon('x') + '</button></span>'; }).join('') : '<span class="dim">No pinned categories yet.</span>';
  };
  var groupOpts = [];
  ['movie', 'show', 'live', 'radio'].forEach(function (t) { V.groupsOf(t).sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (g) { groupOpts.push('<option value="' + V.esc(t + '|' + g.name) + '">' + V.esc(V.TYPE_NAMES[t] + ' · ' + g.name) + ' (' + g.items.length + ')</option>'); }); });
  V.dialog({
    title: 'Customise your home page', wide: true,
    body: '<p class="dim">Choose which rows you see and their order.</p><ul class="rows-edit"></ul><h3>Pinned categories</h3><p class="dim">Pinned categories get their own row.</p><div class="pins chips"></div>' +
      '<div class="inline"><select class="input" data-pick><option value="">Choose a category…</option>' + groupOpts.join('') + '</select><button class="btn" data-pin>Pin</button></div>',
    actions: [{ label: 'Reset', fn: function () { S.data.home = { order: [], hidden: [], pinned: [] }; V.saveHome(); V.router.refresh(); } }, { label: 'Save', primary: true, fn: function () { S.data.home = { order: order, hidden: Array.from(hidden), pinned: pinned }; V.saveHome(); V.router.refresh(); } }],
    onOpen: function (d) {
      render(d);
      d.addEventListener('click', function (e) {
        var b;
        if ((b = e.target.closest('[data-up]'))) { var i = +b.dataset.up; order.splice(i - 1, 0, order.splice(i, 1)[0]); render(d); }
        else if ((b = e.target.closest('[data-down]'))) { var j = +b.dataset.down; order.splice(j + 1, 0, order.splice(j, 1)[0]); render(d); }
        else if ((b = e.target.closest('[data-unpin]'))) { pinned.splice(+b.dataset.unpin, 1); render(d); }
        else if (e.target.closest('[data-pin]')) { var v = V.$('[data-pick]', d).value; if (v && pinned.indexOf(v) < 0) pinned.push(v); if (pinned.indexOf('pinned') < 0) hidden.delete('pinned'); render(d); }
      });
      d.addEventListener('change', function (e) { var id = e.target.dataset.show; if (id) { if (e.target.checked) hidden.delete(id); else hidden.add(id); } });
    },
  });
};
