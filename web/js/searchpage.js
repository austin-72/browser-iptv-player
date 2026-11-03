/* Search: titles, channels and episodes as you type (typos forgiven), TV listings, voice input, recent searches. */
'use strict';
V.route('search', function (view, r) {
  var q0 = r.q.get('q') || '';
  var voice = window.SpeechRecognition || window.webkitSpeechRecognition;
  view.innerHTML = '<h1 class="sr-only">Search</h1><div class="search-page"><form class="search-box" role="search"><span class="sb-i">' + V.icon('search') + '</span>' +
    '<input type="search" class="input" data-q placeholder="Movies, series, channels, people…" aria-label="Search" autocomplete="off" enterkeyhint="search" value="' + V.esc(q0) + '">' +
    (voice ? '<button type="button" class="icon-btn" data-voice aria-label="Search by voice">' + V.icon('mic') + '</button>' : '') + '</form><div class="search-out"></div></div>';
  var input = V.$('[data-q]', view), out = V.$('.search-out', view);
  var epgReq = 0, peopleReq = 0, rec = null, partial = false, ranLen = 0;
  // Voice input still listening when the page is left: stop it (a late result would search on another page).
  V.pageCleanup = function () { epgReq++; peopleReq++; if (rec) { try { rec.abort(); } catch (e) {} rec = null; } };
  var run = function (q) {
    if (!document.contains(view)) return; // (another page by now)
    q = q.trim();
    history.replaceState(null, '', '#/search' + (q ? '?q=' + encodeURIComponent(q) : ''));
    V.router.current = location.hash;
    if (!q) {
      var recent = S.data.searches;
      var trending = (S.recs && S.recs.top || []).slice(0, 12).map(V.entry).filter(Boolean);
      recent = recent.slice(0, 10);
      out.innerHTML = (recent.length ? '<div class="sr-recent-h"><h2>Recent searches</h2><button class="btn sm ghost" data-clear-s>Clear all</button></div><div class="chips">' + recent.map(function (x) { return '<span class="chip"><button class="chip-b" data-s="' + V.esc(x) + '">' + V.icon('clock', 'tiny') + ' ' + V.esc(x) + '</button><button class="x" data-del-s="' + V.esc(x) + '" aria-label="Remove “' + V.esc(x) + '” from recent searches">' + V.icon('x') + '</button></span>'; }).join('') + '</div>' : '') + '<div class="sr-rows"></div>';
      var row = V.row({ id: 'sugg', title: 'Suggestions for you', items: trending });
      if (row) V.$('.sr-rows', out).appendChild(row);
      return;
    }
    var all = V.search.find(q, { limit: 300, episodes: true });
    partial = !!all.partial; ranLen = S.items ? S.items.length : 0;
    var by = { movie: [], show: [], live: [], radio: [], episode: [] };
    all.forEach(function (it) { if (by[it.t]) by[it.t].push(it); });
    var top = all.filter(function (it) { return it.t !== 'episode'; }).slice(0, 18);
    // "90s comedy", "horror 2023", "sci-fi 1980s": genre and years as filters.
    var f = V.searchFilters(q);
    var filtered = null;
    if (f) {
      var fits = function (it) { return (!f.from || (it.y && it.y >= f.from && it.y <= f.to)) && (!f.genres.length || f.genres.every(function (g) { return (it.gn || []).indexOf(g) >= 0; })) && !V.inList('hidden', it.k); };
      if (f.rest) filtered = V.search.find(f.rest, { types: ['movie', 'show'], limit: 2000 }).filter(fits);
      else {
        // Everything matching, best rated first: only the 60 shown are kept in order (not a sort of the whole catalogue per key press).
        filtered = [];
        var scan = function (it) {
          var r = it.r || 0, n = filtered.length;
          if (n >= 60 && r <= (filtered[n - 1].r || 0)) return;
          if (!fits(it)) return;
          var i = n;
          while (i > 0 && (filtered[i - 1].r || 0) < r) i--;
          filtered.splice(i, 0, it);
          if (filtered.length > 60) filtered.pop();
        };
        S.movies.forEach(scan);
        S.shows.forEach(scan);
      }
    }
    out.innerHTML = all.length || (filtered && filtered.length) ? '<div class="sr-people"></div><div class="sr-rows"></div>' : '<div class="sr-people"></div><div class="empty"><h2>No matches for “' + V.esc(q) + '”</h2><p>Try fewer words, or check the spelling.</p></div>';
    var rows = V.$('.sr-rows', out);
    // Actors and directors (the server knows everyone's cast), after a short pause.
    var my2 = ++peopleReq;
    if (q.length >= 3) setTimeout(function () {
      if (my2 !== peopleReq) return;
      V.api('/api/search/people?q=' + encodeURIComponent(q)).then(function (people) {
        if (my2 !== peopleReq || !people.length) return;
        var box = V.$('.sr-people', out);
        if (!box) return;
        var empty = V.$('.empty', out);
        if (empty) empty.remove();
        people.forEach(function (pp) {
          var both = pp.dir.length && pp.cast.length;
          var mk = function (keys, label) { var items = keys.map(V.entry).filter(Boolean); if (items.length) { var x = V.row({ id: 'p:' + pp.name + label, title: pp.name + label, items: items }); if (x) box.appendChild(x); } };
          if (pp.dir.length) mk(pp.dir, both || pp.role === 'dir' ? ' · directed' : '');
          if (pp.cast.length) mk(pp.cast, both ? ' · starring' : '');
        });
      }).catch(function () {});
    }, 350);
    if (rows) {
      var add = function (o) { var x = V.row(o); if (x) rows.appendChild(x); };
      if (filtered && filtered.length) add({ id: 'filt', title: f.label, items: filtered.slice(0, 60) });
      add({ id: 'top', title: 'Top results', items: top });
      add({ id: 'ch', title: 'Channels', items: by.live, play: true });
      add({ id: 'mv', title: 'Movies', items: by.movie });
      add({ id: 'sh', title: 'Series', items: by.show });
      add({ id: 'ep', title: 'Episodes', items: by.episode, play: true, cardOpts: { showName: true } });
      add({ id: 'ra', title: 'Radio', items: by.radio, play: true });
    }
    // TV listings matching (from the guide), after a short pause.
    var my = ++epgReq;
    if (q.length >= 3 && S.live.length) setTimeout(function () {
      if (my !== epgReq) return;
      V.epg.search(q).then(function (hits) {
        if (my !== epgReq || !hits.length) return;
        var now = Date.now();
        var sec = document.createElement('section');
        sec.className = 'row';
        sec.innerHTML = '<div class="row-h"><h2>On TV</h2></div><ul class="hits">' + hits.slice(0, 20).map(function (h, i) { var c = V.entry(h.k); if (!c) return ''; return '<li><button class="hit" data-h="' + i + '"><span class="dim num">' + V.fmtDay(h.s) + ' ' + V.fmtClock(h.s) + '</span><b>' + V.esc(h.t) + '</b><span class="dim truncate">' + V.esc(c.n) + (h.s <= now && h.e > now ? ' · on now' : '') + '</span></button></li>'; }).join('') + '</ul>';
        sec.onclick = function (e) { var b = e.target.closest('[data-h]'); if (b) { var h = hits[+b.dataset.h]; V.programmeDialog(V.entry(h.k), h); } };
        var none = V.$('.empty', out); // (the guide found something after all)
        if (none) none.remove();
        (V.$('.sr-rows', out) || out).appendChild(sec);
      }).catch(function () {});
    }, 500);
  };
  // A search is remembered when it's used (Enter, or opening a result) — not every half-typed word.
  // Results follow typing after a short pause (and only the latest counts); the suggestions under the box sooner.
  var typeT = null, lastRun = null;
  var runSoon = function () { clearTimeout(typeT); typeT = setTimeout(function () { typeT = null; if (input.value !== lastRun) { lastRun = input.value; run(input.value); } }, 120); };
  input.addEventListener('input', runSoon);
  var ac = V.autocomplete(input, {});
  V.$('form', view).onsubmit = function (e) { e.preventDefault(); clearTimeout(typeT); if (input.value !== lastRun) { lastRun = input.value; run(input.value); } V.addSearch(input.value.trim()); ac.close(); input.blur(); };
  // The search index was still being built when this was typed (or more of a big catalogue has come since): the full
  // answer, now it's ready — unless you've moved on into the results.
  var offReady = V.on('search-ready', function () {
    if (!document.contains(view)) { offReady(); return; }
    var ae = document.activeElement;
    if (input.value.trim() && (partial || (S.items && S.items.length !== ranLen)) && (ae === input || !out.contains(ae))) run(input.value);
  });
  var cleanup0 = V.pageCleanup;
  V.pageCleanup = function () { clearTimeout(typeT); offReady(); ac.destroy(); if (cleanup0) cleanup0(); };
  out.addEventListener('click', function (e) {
    var d = e.target.closest('[data-del-s]');
    if (d) { e.stopPropagation(); e.preventDefault(); V.removeSearch(d.dataset.delS); run(''); return; }
    if (e.target.closest('[data-clear-s]')) { V.removeSearch(null); run(''); return; }
    var b = e.target.closest('[data-s]');
    if (b) { input.value = b.dataset.s; lastRun = input.value; run(b.dataset.s); return; }
    if (e.target.closest('[data-k]') && input.value.trim().length > 1) V.addSearch(input.value.trim());
  }, true);
  var vb = V.$('[data-voice]', view);
  if (vb) vb.onclick = function () {
    if (rec) { try { rec.abort(); } catch (e) {} }
    rec = new voice();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    vb.classList.add('listening');
    V.announce('Listening');
    var me = rec;
    rec.onresult = function (ev) { if (me !== rec || !document.contains(view)) return; var t = Array.prototype.map.call(ev.results, function (x) { return x[0].transcript; }).join(''); input.value = t; run(t); };
    rec.onend = function () { if (me !== rec) return; rec = null; vb.classList.remove('listening'); if (input.value && document.contains(view)) V.addSearch(input.value); };
    rec.onerror = function (ev) { if (me !== rec) return; vb.classList.remove('listening'); if (ev.error !== 'no-speech') V.toast('Voice search: ' + ev.error, { error: true }); };
    rec.start();
  };
  lastRun = q0;
  run(q0);
  if (!V.device.tv) setTimeout(function () { input.focus(); }, 50);
});

/** "90s comedy" → { genres: ['Comedy'], from: 1990, to: 1999, rest: '', label: 'Comedy from the 1990s' }; null when there's nothing to filter on. */
V.searchFilters = function (q) {
  var words = V.norm(q).split(' ').filter(Boolean);
  if (!words.length) return null;
  var genres = [], from = 0, to = 0, rest = [];
  var known = {};
  S.genres.forEach(function (list, name) { known[V.norm(name)] = name; });
  var alias = { scifi: 'Science Fiction', 'sci': 'Science Fiction', romcom: 'Romance', cartoon: 'Animation', cartoons: 'Animation', animated: 'Animation', docs: 'Documentary', documentaries: 'Documentary', doc: 'Documentary', scary: 'Horror', funny: 'Comedy', comedies: 'Comedy', thrillers: 'Thriller', westerns: 'Western', musicals: 'Music', kids: 'Family', war: 'War' };
  for (var i = 0; i < words.length; i++) {
    var w = words[i], two = words[i + 1] ? w + ' ' + words[i + 1] : '';
    var m;
    if (two && known[two]) { genres.push(known[two]); i++; continue; }
    if (two === 'sci fi' || two === 'science fiction') { genres.push('Science Fiction'); i++; continue; }
    if (known[w] && w.length > 2) { genres.push(known[w]); continue; }
    if (known[w.replace(/s$/, '')] && w.length > 3) { genres.push(known[w.replace(/s$/, '')]); continue; }
    if (alias[w] && known[V.norm(alias[w])]) { genres.push(alias[w]); continue; }
    if ((m = /^(19|20)?(\d)0s$/.exec(w))) { var c = m[1] ? +(m[1] + m[2] + '0') : (+m[2] >= 3 ? 1900 + +m[2] * 10 : 2000 + +m[2] * 10); from = c; to = c + 9; continue; }
    if ((m = /^((?:19|20)\d\d)$/.exec(w)) && words.length > 1) { from = to = +m[1]; continue; }
    rest.push(w);
  }
  if (!genres.length && !from) return null;
  var label = (genres.length ? genres.join(' & ') : 'Films and series') + (from ? (from === to ? ' from ' + from : ' from the ' + from + 's') : '');
  return { genres: genres, from: from, to: to, rest: rest.join(' '), label: label };
};
