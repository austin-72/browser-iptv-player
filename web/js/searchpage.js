/* Search: titles, channels and episodes as you type (typos forgiven), TV listings, voice input, recent searches. */
'use strict';
V.route('search', function (view, r) {
  var q0 = r.q.get('q') || '';
  var voice = window.SpeechRecognition || window.webkitSpeechRecognition;
  var oskWanted = V.tvMode || !(V.device && V.device.touch);
  view.innerHTML = '<h1 class="sr-only">Search</h1><div class="search-page"><form class="search-box" role="search"><span class="sb-i">' + V.icon('search') + '</span>' +
    '<input type="search" class="input" data-q placeholder="Movies, series, channels, people…" aria-label="Search" autocomplete="off" enterkeyhint="search" value="' + V.esc(q0) + '">' +
    (voice ? '<button type="button" class="icon-btn" data-voice aria-label="Search by voice">' + V.icon('mic') + '</button>' : '') +
    // (An on-screen keyboard for a TV remote with no keys to type with — and anyone else who'd rather; not on a phone,
    // which has its own.)
    (oskWanted ? '<button type="button" class="icon-btn" data-osk aria-label="On-screen keyboard" aria-expanded="false" aria-controls="sr-osk">' + V.icon('keyboard') + '</button>' : '') +
    '</form>' + (oskWanted ? '<div class="sr-osk" id="sr-osk" role="group" aria-label="On-screen keyboard" hidden></div>' : '') + '<div class="search-out"></div></div>';
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
    // "with tom hanks", "directed by nolan": people only.
    var pq = V.peopleQuery(q);
    var D = { q: q, pq: pq, all: [], by: { movie: [], show: [], live: [], radio: [], episode: [] }, top: [], f: null, filtered: null, cats: [], people: [], aka: [], akaMore: [], about: [], tv: [], pplF: null };
    cur = D; sel.cat = null; sel.dec = 0;
    // (Titles too when it's asked as a person — "with love", "director's cut" are titles as well.)
    {
      D.all = V.search.find(q, { limit: 300, episodes: true });
      partial = !!D.all.partial; ranLen = S.items ? S.items.length : 0;
      D.all.forEach(function (it) { if (D.by[it.t]) D.by[it.t].push(it); });
      D.top = D.all.filter(function (it) { return it.t !== 'episode'; }).slice(0, 24);
      // "90s comedy", "horror 2023", "sci-fi 1980s": genre and years as filters.
      var f = D.f = V.searchFilters(q);
      // ("star wars": a title, not war films with "star" in the name — a genre word only when what's typed isn't how a title starts.)
      if (f && f.rest && D.all[0] && V.norm(D.all[0].n).lastIndexOf(V.norm(q), 0) === 0) f = D.f = null;
      if (f) {
        if (f.rest) D.filtered = V.search.find(f.rest, { types: ['movie', 'show'], limit: 2000 }).filter(fits);
        else {
          // Everything matching, best rated first: only the 60 shown are kept in order (not a sort of the whole catalogue per key press).
          var fl = D.filtered = [];
          var scan = function (it) {
            var r = it.r || 0, n = fl.length;
            if (n >= 60 && r <= (fl[n - 1].r || 0)) return;
            if (!fits(it)) return;
            var i = n;
            while (i > 0 && (fl[i - 1].r || 0) < r) i--;
            fl.splice(i, 0, it);
            if (fl.length > 60) fl.pop();
          };
          S.movies.forEach(scan);
          S.shows.forEach(scan);
        }
      }
      // A category's name ("christmas", "halloween", "netflix"): its films, series and channels first, most popular first.
      D.named = V.smart && V.smart.on() ? V.smart.matching(q) : [];
    }
    draw();
    // Actors, directors and creators; the other names titles go by; what they're about (the server's), after a pause.
    var my2 = ++peopleReq;
    var who = pq ? pq.name : q;
    if (who.length >= 3) setTimeout(function () {
      if (my2 !== peopleReq) return;
      V.api('/api/search/extra?q=' + encodeURIComponent(who) + (pq ? '&people=only' + (pq.role ? '&role=' + pq.role : '') : '')).then(function (x) {
        if (my2 !== peopleReq || cur !== D) return;
        D.people = x.people || []; D.aka = (x.aka || []).map(V.entry).filter(Boolean); D.akaMore = (x.akaMore || []).map(V.entry).filter(Boolean);
        D.about = (x.about || []).map(function (a) { return { name: a.name, items: a.keys.map(V.entry).filter(Boolean) }; }).filter(function (a) { return a.items.length; });
        // "tom hanks comedy": nobody's called that — the person, then the genre or years as a filter on their titles.
        if (!D.people.length && D.f && D.f.rest && D.f.rest.length >= 3) {
          return V.api('/api/search/people?q=' + encodeURIComponent(D.f.rest)).then(function (pp) {
            if (my2 !== peopleReq || cur !== D) return;
            D.people = pp || []; D.pplF = D.f; draw(true);
          });
        }
        draw(true);
      }).catch(function () {});
    }, 300);
    // TV listings matching (from the guide), after a short pause.
    var my = ++epgReq;
    if (!pq && q.length >= 3 && S.live.length) setTimeout(function () {
      if (my !== epgReq) return;
      V.epg.search(q).then(function (hits) {
        if (my !== epgReq || cur !== D || !hits.length) return;
        D.tv = hits; draw(true);
      }).catch(function () {});
    }, 500);
  };
  var fits = function (it) { var f = cur && cur.f; return !!f && (!f.from || (it.y && it.y >= f.from && it.y <= f.to)) && (!f.genres.length || f.genres.every(function (g) { return (it.gn || []).indexOf(g) >= 0; })) && !V.inList('hidden', it.k); };

  // ---------------------------------------------------------------- drawing: chips to narrow it down, then the rows
  var cur = null, sel = { type: 'all', cat: null, dec: 0 };
  var TYPES = [['all', 'All'], ['people', 'People'], ['movie', 'Films'], ['show', 'Series'], ['live', 'Channels'], ['episode', 'Episodes'], ['radio', 'Radio']];
  var showOf = function (it) { return it.t === 'episode' ? V.showOf(it) || it : it; };
  /** The category chips: what the results fall into (and categories named like the search), most of them first. */
  var catsOf = function (D, list) {
    var smart = V.smart && V.smart.on(), n = {}, ty = {}, order = [], seen = {};
    var add = function (id, t) { if (!n[id]) { n[id] = 0; ty[id] = {}; order.push(id); } n[id]++; ty[id][t] = (ty[id][t] || 0) + 1; };
    list.slice(0, 150).forEach(function (it) {
      var b = showOf(it), t = b.t;
      if (seen[b.k]) return; // (a series' episodes: the series once)
      seen[b.k] = 1;
      if (smart) (b.sc || []).forEach(function (id) { var d = V.smart.def(id); if (d && d.k !== 'top') add(id, t); });
      else (b.gn || []).forEach(function (g) { add('gn:' + g, t); });
    });
    var named = (D.named || []).map(function (d) { return d.id; });
    var ids = order.filter(function (id) { return n[id] >= 2 || list.length < 8 || named.indexOf(id) >= 0; });
    ids.sort(function (a, b) { return (named.indexOf(b) >= 0) - (named.indexOf(a) >= 0) || n[b] - n[a]; });
    return ids.slice(0, 10).map(function (id) {
      var t = Object.keys(ty[id]).sort(function (a, b) { return ty[id][b] - ty[id][a]; })[0];
      return { id: id, n: n[id], label: id.indexOf('gn:') === 0 ? id.slice(3) : V.smart.label(id, t), t: t };
    });
  };
  var inDec = function (it) { if (!sel.dec) return true; var b = showOf(it); return b.t === 'live' || b.t === 'radio' || (!!b.y && b.y >= sel.dec && b.y < sel.dec + 10); };
  var inCat = function (it) {
    if (!sel.cat) return true;
    var b = showOf(it);
    return sel.cat.indexOf('gn:') === 0 ? (b.gn || []).indexOf(sel.cat.slice(3)) >= 0 : (b.sc || []).indexOf(sel.cat) >= 0;
  };
  var uniq = function (list) { var seen = {}; return list.filter(function (it) { if (!it || seen[it.k]) return false; seen[it.k] = 1; return true; }); };
  var draw = function (late) {
    var D = cur;
    if (!D || !document.contains(view)) return;
    // (Something in the results has the focus — a remote moving through them: it keeps it.)
    var fk = null, fr = null, ae = document.activeElement;
    if (late && out.contains(ae)) { var cd = ae.closest('[data-k]'), rw = ae.closest('[data-row]'); fk = cd && cd.getAttribute('data-k'); fr = rw && rw.getAttribute('data-row'); }
    var byT = {};
    // (The other names: close ones with the names; loose ones — a word of another name — after.)
    Object.keys(D.by).forEach(function (t) { byT[t] = uniq(D.by[t].concat(D.aka.filter(function (it) { return it.t === t; }), D.akaMore.filter(function (it) { return it.t === t; }))); });
    // (The other names: right after the best few of the names, then the rest.)
    var top = uniq(D.top.slice(0, 4).concat(D.aka.slice(0, 8), D.top.slice(4)));
    // (A channel once in the top results — the same one from several lists, or in HD and SD.)
    var chSeen = {};
    top = top.filter(function (it) {
      if (it.t !== 'live' && it.t !== 'radio') return true;
      var key = V.norm(it.n).replace(/\b(hd|fhd|uhd|sd|4k|hevc|h265|raw|backup|us|uk|ca)\b/g, '').replace(/\s+/g, ' ').trim();
      if (chSeen[key]) return false;
      chSeen[key] = 1; return true;
    }).slice(0, 24);
    var everything = uniq(top.concat(D.all, D.aka, D.akaMore));
    // People asked for: their titles are what's searched.
    if (D.pq) D.people.forEach(function (pp) { everything = everything.concat(pp.cast.concat(pp.dir).map(V.entry).filter(Boolean)); });
    D.cats = catsOf(D, everything);
    if (sel.cat && !D.cats.some(function (c) { return c.id === sel.cat; })) sel.cat = null;
    // Decades: of the films and series found, and of the categories named like the search ("horror": all horror).
    var decN = {}, decList = everything.slice();
    (D.named || []).forEach(function (d) { ['movie', 'show'].forEach(function (t) { decList = decList.concat(V.groupItems(t, d.id).slice(0, 3000)); }); });
    var seenD = {};
    decList.forEach(function (it) { var b = showOf(it); if (seenD[b.k] || !b.y || (b.t !== 'movie' && b.t !== 'show')) return; seenD[b.k] = 1; var dd = Math.floor(b.y / 10) * 10; decN[dd] = (decN[dd] || 0) + 1; });
    var decs = Object.keys(decN).map(Number).filter(function (d) { return decN[d] >= 2; }).sort(function (a, b) { return b - a; }).slice(0, 8);
    if (decs.length < 2) decs = [];
    if (sel.dec && decs.indexOf(sel.dec) < 0) sel.dec = 0;
    var cnt = { all: 1, people: D.people.length };
    Object.keys(byT).forEach(function (t) { cnt[t] = byT[t].filter(inCat).length; });
    if (sel.type !== 'all' && !cnt[sel.type] && !(sel.type === 'people' && D.people.length)) sel.type = 'all';
    var types = TYPES.filter(function (t) { return t[0] === 'all' || cnt[t[0]]; });
    var chips = (types.length > 2 || D.cats.length || decs.length ? '<div class="sr-filters">' +
      (types.length > 2 ? '<div class="chips sr-types" role="group" aria-label="Show">' + types.map(function (t) { var on = sel.type === t[0]; return '<button type="button" class="chip' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-ty="' + t[0] + '">' + t[1] + (t[0] !== 'all' ? ' <span class="dim">' + cnt[t[0]] + '</span>' : '') + '</button>'; }).join('') + '</div>' : '') +
      (D.cats.length && sel.type !== 'people' ? '<div class="chips sr-cats" role="group" aria-label="In the category"><span class="sr-cats-h">In</span>' + D.cats.map(function (c) { var on = sel.cat === c.id; return '<button type="button" class="chip' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-cat="' + V.esc(c.id) + '">' + V.esc(c.label) + ' <span class="dim">' + c.n + '</span></button>'; }).join('') + '</div>' : '') +
      (decs.length && sel.type !== 'live' && sel.type !== 'radio' ? '<div class="chips sr-cats" role="group" aria-label="From"><span class="sr-cats-h">From</span>' + decs.map(function (d) { var on = sel.dec === d; return '<button type="button" class="chip' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-dec="' + d + '">' + d + 's <span class="dim">' + decN[d] + '</span></button>'; }).join('') + '</div>' : '') +
      '</div>' : '');
    out.innerHTML = chips + '<div class="sr-rows"></div>';
    var rows = V.$('.sr-rows', out), any = false;
    var want = function (t) { return sel.type === 'all' || sel.type === t; };
    var add = function (o) { o.items = uniq(o.items).filter(inCat).filter(inDec); var x = V.row(o); if (x) { rows.appendChild(x); any = true; } };
    // One kind chosen: all of them, as a grid (films and series) or a row.
    if (sel.type === 'movie' || sel.type === 'show') {
      var g = document.createElement('div'); rows.appendChild(g);
      var list = byT[sel.type].filter(inCat).filter(inDec);
      if (list.length) { V.grid(g, list, {}); any = true; }
    }
    // A category: a link to all of it.
    var c0 = sel.cat && D.cats.filter(function (c) { return c.id === sel.cat; })[0];
    if (c0 && c0.id.indexOf('gn:') < 0 && (c0.t === 'movie' || c0.t === 'show' || c0.t === 'live')) rows.insertAdjacentHTML('afterbegin', '<p class="sr-catlink"><a class="btn sm" href="#/' + (c0.t === 'movie' ? 'movies' : c0.t === 'show' ? 'series' : 'live') + '?g=' + encodeURIComponent(c0.id) + '">' + V.esc('Everything in ' + c0.label) + ' ' + V.icon('next') + '</a></p>');
    if (sel.type === 'all' && !sel.cat && !D.pq) (D.named || []).forEach(function (d) {
      [['movie', 'films', 'movies'], ['show', 'series', 'series'], ['live', 'channels', 'live']].forEach(function (t) {
        var items = V.groupItems(t[0], d.id).filter(function (x) { return !V.inList('hidden', x.k) && inDec(x); });
        if (!items.length) return;
        if (t[0] !== 'live') items = items.slice().sort(function (a, b) { return (b.pp || 0) - (a.pp || 0) || (b.r || 0) - (a.r || 0); });
        add({ id: 'cat:' + d.id + ':' + t[0], title: V.smart.label(d.id, t[0]) + ' ' + t[1], items: items.slice(0, 40), more: '#/' + t[2] + '?g=' + encodeURIComponent(d.id), play: t[0] === 'live' });
      });
    });
    // (A genre on its own — "crime": its category's rows above are the same thing.)
    var sameAsNamed = D.f && !D.f.rest && !D.f.from && (D.named || []).length;
    if (sel.type === 'all' && D.filtered && D.filtered.length && !sameAsNamed) add({ id: 'filt', title: D.f.label, items: D.filtered.slice(0, 60) });
    // People: a row of each one's titles, as actor and as director or creator.
    if (want('people') || sel.type === 'all' && (D.pq || D.people.length)) D.people.forEach(function (pp) {
      var both = pp.dir.length && pp.cast.length, made = pp.role === 'creator' ? ' · created' : ' · directed';
      var keep = function (it) { return !D.pplF || fitsF(it, D.pplF); };
      var mk = function (keys, label) {
        var items = keys.map(V.entry).filter(Boolean).filter(keep);
        // (The name opens their page — photo, everything of theirs: titlemore.js — when those are on.)
        if (items.length) add({ id: 'p:' + pp.name + label, title: pp.name + label + (D.pplF ? ' · ' + D.pplF.label : ''), items: items, more: V.personLink ? V.personLink(pp.name) : '' });
      };
      if (pp.dir.length) mk(pp.dir, both || pp.role !== 'cast' ? made : '');
      if (pp.cast.length) mk(pp.cast, both ? ' · starring' : '');
    });
    if (sel.type === 'all') add({ id: 'top', title: 'Top results', items: top });
    if (sel.type === 'all' || sel.type === 'live') add({ id: 'ch', title: 'Channels', items: byT.live, play: true });
    if (sel.type === 'all') { add({ id: 'mv', title: 'Movies', items: byT.movie }); add({ id: 'sh', title: 'Series', items: byT.show }); }
    if (want('episode')) add({ id: 'ep', title: 'Episodes', items: byT.episode, play: true, cardOpts: { showName: true } });
    if (want('radio')) add({ id: 'ra', title: 'Radio', items: byT.radio, play: true });
    // What titles are about (TMDB's keywords: "heist", "time travel").
    if (sel.type === 'all' || sel.type === 'movie' || sel.type === 'show') D.about.forEach(function (a) {
      add({ id: 'kw:' + a.name, title: 'About “' + a.name + '”', items: sel.type === 'all' ? a.items : a.items.filter(function (it) { return it.t === sel.type; }) });
    });
    // On TV: programmes in the guide.
    if ((sel.type === 'all' || sel.type === 'live') && D.tv.length && !sel.cat) {
      var now = Date.now(), sec = document.createElement('section');
      sec.className = 'row';
      sec.innerHTML = '<div class="row-h"><h2>On TV</h2></div><ul class="hits">' + D.tv.slice(0, 20).map(function (h, i) { var c = V.entry(h.k); if (!c) return ''; return '<li><button class="hit" data-h="' + i + '"><span class="dim num">' + V.fmtDay(h.s) + ' ' + V.fmtClock(h.s) + '</span><b>' + V.esc(h.t) + '</b><span class="dim truncate">' + V.esc(c.n) + (h.s <= now && h.e > now ? ' · on now' : '') + '</span></button></li>'; }).join('') + '</ul>';
      sec.onclick = function (e) { var b = e.target.closest('[data-h]'); if (b) { var h = D.tv[+b.dataset.h]; V.programmeDialog(V.entry(h.k), h); } };
      rows.appendChild(sec); any = true;
    }
    if (!any) rows.innerHTML = D.pq ? '<div class="empty"><h2>' + (late ? 'Nobody called “' + V.esc(D.pq.name) + '”' : 'Looking for “' + V.esc(D.pq.name) + '”…') + '</h2>' + (late ? '<p>Check the spelling, or try just their surname.</p>' : '') + '</div>'
      : '<div class="empty"><h2>No matches for “' + V.esc(D.q) + '”' + (sel.cat ? ' in this category' : '') + '</h2><p>' + (sel.cat ? 'Try another category, or all of them.' : 'Try fewer words, check the spelling, or search for an actor or director.') + '</p></div>';
    if (fk || fr) { var back = (fr && fk && V.$('[data-row="' + fr + '"] [data-k="' + fk + '"]', out)) || (fk && V.$('[data-k="' + fk + '"]', out)); if (back) try { back.focus({ preventScroll: true }); } catch (e) {} }
  };
  var fitsF = function (it, f) { return (!f.from || (it.y && it.y >= f.from && it.y <= f.to)) && (!f.genres.length || f.genres.every(function (g) { return (it.gn || []).indexOf(g) >= 0; })); };
  // A search is remembered when it's used (Enter, or opening a result) — not every half-typed word.
  // Results follow typing after a short pause (and only the latest counts); the suggestions under the box sooner.
  var typeT = null, lastRun = null;
  var runSoon = function () { clearTimeout(typeT); typeT = setTimeout(function () { typeT = null; if (input.value !== lastRun) { lastRun = input.value; run(input.value); } }, 120); };
  input.addEventListener('input', runSoon);
  // (No suggestions under the box: the results below follow what's typed.)
  V.$('form', view).onsubmit = function (e) { e.preventDefault(); clearTimeout(typeT); if (input.value !== lastRun) { lastRun = input.value; run(input.value); } V.addSearch(input.value.trim()); input.blur(); };

  // ---------------------------------------------------------------- the on-screen keyboard
  var osk = V.$('#sr-osk', view), oskBtn = V.$('[data-osk]', view);
  var KEYS = 'abcdefghijklmnopqrstuvwxyz1234567890'.split('').concat(['-', "'", '&', '.']);
  var oskOpen = function (on, focusKey) {
    if (!osk) return;
    if (on && !osk.firstChild) {
      osk.innerHTML = '<div class="osk-acts">' +
        '<button type="button" class="osk-k wide" data-key=" ">Space</button>' +
        '<button type="button" class="osk-k wide" data-key="del" aria-label="Delete a letter">' + V.icon('backspace') + ' Delete</button>' +
        '<button type="button" class="osk-k wide" data-key="clear">Clear</button>' +
        '<button type="button" class="osk-k wide go" data-key="go">' + V.icon('search') + ' Search</button>' +
        '<button type="button" class="osk-k wide" data-key="close" aria-label="Close the keyboard">' + V.icon('x') + '</button></div>' +
        '<div class="osk-keys">' + KEYS.map(function (k) { return '<button type="button" class="osk-k" data-key="' + V.esc(k) + '">' + V.esc(k === ' ' ? 'Space' : k.toUpperCase()) + '</button>'; }).join('') + '</div>';
    }
    osk.hidden = !on;
    if (oskBtn) { oskBtn.setAttribute('aria-expanded', String(on)); oskBtn.classList.toggle('on', on); }
    try { V.ls.set('osk', on ? 1 : 0); } catch (e) {}
    if (on && focusKey !== false) { var k = V.$('.osk-keys .osk-k', osk); if (k) k.focus(); }
  };
  if (oskBtn) oskBtn.onclick = function () { oskOpen(osk.hidden); if (osk.hidden) oskBtn.focus(); };
  if (osk) {
    osk.onclick = function (e) {
      var b = e.target.closest('[data-key]');
      if (!b) return;
      var k = b.getAttribute('data-key'), v = input.value;
      if (k === 'close') { oskOpen(false); if (oskBtn) oskBtn.focus(); return; }
      if (k === 'go') { clearTimeout(typeT); if (input.value !== lastRun) { lastRun = input.value; run(input.value); } if (input.value.trim()) V.addSearch(input.value.trim()); oskOpen(false); var first = V.$('.sr-filters button, .search-out .card, .search-out button', view); if (first) first.focus(); return; }
      input.value = k === 'del' ? v.slice(0, -1) : k === 'clear' ? '' : v + k;
      runSoon();
      V.announce(input.value ? input.value : 'Empty');
    };
    // Back on the remote, or Escape: the keyboard closes (and not the page).
    osk.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.key === 'Esc' || e.key === 'Backspace' && V.tvMode || e.key === 'GoBack' || e.keyCode === 10009 || e.keyCode === 461) {
        e.preventDefault(); e.stopPropagation(); oskOpen(false); if (oskBtn) oskBtn.focus();
        return;
      }
      // (A real keyboard too, while a key has the focus: what's typed goes in the box.)
      if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.key === ' ' && e.target.closest('[data-key]'))) {
        e.preventDefault(); input.value += e.key; runSoon();
      }
    });
  }
  // The search index was still being built when this was typed (or more of a big catalogue has come since): the full
  // answer, now it's ready — unless you've moved on into the results.
  var offReady = V.on('search-ready', function () {
    if (!document.contains(view)) { offReady(); return; }
    var ae = document.activeElement;
    if (input.value.trim() && (partial || (S.items && S.items.length !== ranLen)) && (ae === input || !out.contains(ae))) run(input.value);
  });
  var cleanup0 = V.pageCleanup;
  V.pageCleanup = function () { clearTimeout(typeT); offReady(); if (cleanup0) cleanup0(); };
  out.addEventListener('click', function (e) {
    var d = e.target.closest('[data-del-s]');
    if (d) { e.stopPropagation(); e.preventDefault(); V.removeSearch(d.dataset.delS); run(''); return; }
    if (e.target.closest('[data-clear-s]')) { V.removeSearch(null); run(''); return; }
    var ty = e.target.closest('[data-ty]');
    if (ty) { sel.type = ty.getAttribute('data-ty'); draw(); var t2 = V.$('[data-ty="' + sel.type + '"]', out); if (t2) t2.focus(); return; }
    var de = e.target.closest('[data-dec]');
    if (de) { var dv = +de.getAttribute('data-dec'); sel.dec = sel.dec === dv ? 0 : dv; draw(); var d2 = V.$('[data-dec="' + dv + '"]', out); if (d2) d2.focus(); return; }
    var ca = e.target.closest('[data-cat]');
    if (ca) { var id = ca.getAttribute('data-cat'); sel.cat = sel.cat === id ? null : id; draw(); var c2 = V.$('[data-cat="' + id + '"]', out); if (c2) c2.focus(); return; }
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
  // On a TV, the keyboard is open to start with when there's nothing to search for yet (or it was left open); elsewhere
  // the box has the focus, the cursor after what's there (typing started in the top bar's box carries on here).
  // (Or the top bar's voice or keyboard button brought you here: that one goes.)
  var start = V.searchStart; V.searchStart = null;
  var oskWas = 0; try { oskWas = +V.ls.get('osk', 0); } catch (e) {}
  if (osk && start === 'osk') { oskOpen(true, false); setTimeout(function () { var k = V.$('.osk-keys .osk-k', osk); if (k && !osk.hidden) k.focus(); }, 50); }
  else if (osk && V.tvMode && (!q0 || oskWas)) oskOpen(true);
  else if (osk && oskWas && !V.tvMode) oskOpen(true, false);
  if (start === 'voice' && vb) vb.click();
  if (!V.device.tv && !V.tvMode && start !== 'osk') setTimeout(function () {
    var ta = V.searchTypeAhead && V.searchTypeAhead.take();
    if (ta && ta !== input.value) { input.value = ta; lastRun = ta; run(ta); }
    input.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
  }, 50);
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
    if ((m = /^((?:19|20)\d\d)$/.exec(w)) && +m[1] <= new Date().getFullYear() + 2) { from = to = +m[1]; continue; }
    rest.push(w);
  }
  if (!genres.length && !from) return null;
  var label = (genres.length ? genres.join(' & ') : 'Films and series') + (from ? (from === to ? ' from ' + from : ' from the ' + from + 's') : '');
  return { genres: genres, from: from, to: to, rest: rest.join(' '), label: label };
};

/** "with tom hanks", "starring …", "actor …" → { name, role: 'cast' }; "directed by nolan", "director …", "created by …",
 *  "films by …" → { name, role: 'dir' }; null for anything else. */
V.peopleQuery = function (q) {
  var s = String(q || '').trim().replace(/\s+/g, ' ');
  var forms = [
    [/^(?:(?:films?|movies?|shows?|series|anything|stuff)\s+)?(?:with|starring|featuring|feat\.?|ft\.?)\s+(.{3,})$/i, 'cast'],
    [/^(?:actor|actress|cast)\s*:?\s+(.{3,})$/i, 'cast'],
    [/^(?:(?:films?|movies?|shows?|series)\s+)?(?:directed by|director|dir\.?|created by|creator|made by)\s*:?\s+(.{3,})$/i, 'dir'],
    [/^(?:films?|movies?|shows?|series)\s+by\s+(.{3,})$/i, 'dir'],
    [/^(?:person|people|who)\s*:?\s+(.{3,})$/i, '']
  ];
  for (var i = 0; i < forms.length; i++) { var m = forms[i][0].exec(s); if (m) return { name: m[1].trim(), role: forms[i][1] }; }
  return null;
};
