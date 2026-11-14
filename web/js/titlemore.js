/* More from TMDB, fetched when a page is opened (lib/routes-p14.js): on a title's page its logo, tagline, the cast with
   photos, who made it, facts, release dates and what viewers wrote; a person's page; the order of a series' episodes. */
'use strict';
(function () {
  var date = function (d) { return V.epAirDate ? V.epAirDate(d) : d; };
  /** Still on the page? (Older TV and console browsers have no isConnected.) */
  var inDoc = function (el) { return !!el && document.documentElement.contains(el); };
  var money = function (n) {
    if (!n) return '';
    var v = n >= 1e9 ? (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + ' billion' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + ' million' : Math.round(n / 1000) + ' thousand';
    return '$' + v.replace(/\.0 /, ' ');
  };
  var personHref = function (c, people) { return people && c.id ? '#/person/' + c.id : '#/search?q=' + encodeURIComponent(c.name); };
  var faceHtml = function (c) {
    return c.img ? '<img src="' + V.esc(c.img) + '" alt="" loading="lazy" referrerpolicy="no-referrer" data-rm>' : '<span class="pc-in" aria-hidden="true">' + V.esc(V.initials ? V.initials(c.name) : c.name.charAt(0)) + '</span>';
  };

  /** The title as its own lettering, in place of plain text (the text stays for screen readers and if the picture fails). */
  /*  → a promise, settled once it's in place (or won't be). On a title's page already showing, it takes no more room
   *  than the words did (Home's banner too): nothing next to it is pushed about. */
  V.titleLogo = function (el, url, name) {
    if (!el || !url || el.querySelector('.t-logo')) return Promise.resolve();
    return new Promise(function (done) {
      var img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.onload = function () {
        // (Gone, or showing another title by now.)
        if (!inDoc(el) || el.textContent !== name || img.naturalWidth < 40) { done(); return; }
        var box = el.closest && (el.closest('.tp-info') || el.closest('.hero-body'));
        var shown = box && !box.classList.contains('tp-wait') && !box.classList.contains('hb-wait');
        if (shown) img.style.maxHeight = Math.max(56, el.offsetHeight) + 'px';
        el.innerHTML = '';
        img.className = 't-logo'; img.alt = name;
        el.appendChild(img);
        el.classList.add('has-logo');
        done();
      };
      img.onerror = function () { done(); };
      img.src = url;
    });
  };

  /** One call, shared by whoever asks about the same title within a few minutes (the banner, then its page). */
  var cache = {};
  V.titleMoreData = function (k) {
    var c = cache[k];
    if (c && Date.now() - c.at < 5 * 60e3) return c.p;
    var p = V.api('/api/title/' + encodeURIComponent(k) + '/more');
    cache[k] = { at: Date.now(), p: p };
    p.catch(function () { delete cache[k]; });
    var keys = Object.keys(cache);
    if (keys.length > 40) delete cache[keys[0]];
    return p;
  };

  /** A title's basics (/api/item): fetched ahead (below), then its page has them at once. take: the page itself —
   *  what was fetched ahead is used once (a page opened again, after a fix to its details say, asks afresh). */
  var items = {};
  V.itemData = function (k, take) {
    var c = items[k];
    if (c && Date.now() - c.at < 60e3) { if (take) delete items[k]; return c.p; }
    if (take) return V.api('/api/item/' + encodeURIComponent(k));
    var p = V.api('/api/item/' + encodeURIComponent(k));
    items[k] = { at: Date.now(), p: p };
    p.catch(function () { delete items[k]; });
    var keys = Object.keys(items);
    if (keys.length > 30) delete items[keys[0]];
    return p;
  };
  /** A person's page (/api/person/…), the same. */
  var persons = {};
  V.personData = function (url) {
    var c = persons[url];
    if (c && Date.now() - c.at < 10 * 60e3) return c.p;
    var p = V.api(url);
    persons[url] = { at: Date.now(), p: p };
    p.catch(function () { delete persons[url]; });
    var keys = Object.keys(persons);
    if (keys.length > 20) delete persons[keys[0]];
    return p;
  };

  // Fetched ahead: a title's or a person's page, when the pointer rests on a card or a name for a moment (or a remote's
  // focus stays on it) — by the time it's opened, what it shows is here. One at a time; not on a data saver.
  (function () {
    var t = null, busy = false;
    var ahead = function (el) {
      if (busy || !S.profile || !el || !el.closest) return;
      var a = el.closest('a[href^="#/title/"], a[href^="#/person"]');
      if (!a) return;
      var c = navigator.connection;
      if (c && c.saveData) return;
      var h = a.getAttribute('href'), m = /^#\/title\/([^?/]+)/.exec(h), pm = /^#\/person\/(\d+)/.exec(h);
      var jobs = [];
      if (m) {
        var k = decodeURIComponent(m[1]), it = V.entry(k);
        if (!it || (it.t !== 'movie' && it.t !== 'show')) return;
        jobs.push(V.itemData(k));
        if (S.settings.tmdb) jobs.push(V.titleMoreData(k));
      } else if (S.settings.tmdb && !V.areaOff('people')) {
        // (By name too — as the person's page asks for it.)
        var nm = /^#\/person\?n=([^&]+)/.exec(h), n = '';
        if (nm) { try { n = decodeURIComponent(nm[1].replace(/\+/g, ' ')); } catch (e2) {} }
        if (pm) jobs.push(V.personData('/api/person/' + pm[1]));
        else if (n) jobs.push(V.personData('/api/person/0?n=' + encodeURIComponent(n)));
      }
      if (!jobs.length) return;
      busy = true;
      Promise.all(jobs).catch(function () {}).then(function () { busy = false; });
    };
    var soon = function (el, ms) { clearTimeout(t); t = setTimeout(function () { ahead(el); }, ms); };
    document.addEventListener('pointerover', function (e) { if (e.pointerType !== 'touch') soon(e.target, 180); }, { passive: true });
    document.addEventListener('pointerout', function () { clearTimeout(t); }, { passive: true });
    // (Touch: the moment a finger comes down on it — the tap that opens it follows a few hundred ms later.)
    document.addEventListener('touchstart', function (e) { soon(e.target, 0); }, { passive: true });
    document.addEventListener('focusin', function (e) { if (V.tvMode || (V.device && V.device.tv)) soon(e.target, 450); });
  })();

  /** On a title's page, once its basics are drawn. d: what /api/item gave. */
  V.titleMore = function (view, it, d) {
    if (!S.settings.tmdb || (it.t !== 'movie' && it.t !== 'show')) return;
    var isShow = it.t === 'show';
    V.titleMoreData(it.k).then(function (m) {
      if (!m || m.none || !inDoc(view) || !V.$('.title-page', view)) return;
      if (m.logo && !V.areaOff('logos')) view._tpLogo = V.titleLogo(V.$('.tp-info h1', view), m.logo, it.n);
      var plot = V.$('.tp-plot', view);
      if (m.tagline && plot && !V.$('.tp-tag', view)) plot.insertAdjacentHTML('beforebegin', '<p class="tp-tag">' + V.esc(m.tagline) + '</p>');
      // An age rating found where there was none.
      if (m.cert && !d.c && !V.$('.tp-meta .cert', view)) { var tm = V.$('.tp-meta', view); if (tm) tm.insertAdjacentHTML('afterbegin', '<span class="cert">' + V.esc(m.cert) + '</span><span class="dot-sep"></span>'); }

      var showTab = view._tpShowTab || function () {};
      var link = function (c) { return '<a href="' + personHref(c, m.people) + '">' + V.esc(c.name) + '</a>'; };
      // Who made it: names that open the person's page — all of them on the Cast tab, the first under the story.
      if ((m.crew || []).length) {
        var by = {}, order = [];
        m.crew.forEach(function (c) { if (!by[c.job]) { by[c.job] = []; order.push(c.job); } by[c.job].push(c); });
        var plural = { Director: 'Directors', Writer: 'Writers', Creator: 'Created by', Music: 'Music', Photography: 'Photography', Book: 'From the book by' };
        var crew = V.$('.tp-crew', view);
        if (crew) crew.innerHTML = '<dl class="facts tp-crew-l">' + order.map(function (job) {
          var l = by[job];
          return '<div><dt>' + V.esc(job === 'Creator' || job === 'Book' || job === 'Music' || job === 'Photography' ? plural[job] : l.length > 1 ? plural[job] : job) + '</dt><dd>' + l.map(link).join(', ') + '</dd></div>';
        }).join('') + '</dl>';
        var lead = by.Creator || by.Director;
        var made = V.$('.tp-made', view);
        if (lead) {
          var mh = '<span class="tp-made">' + (by.Creator ? 'Created by ' : 'Directed by ') + lead.slice(0, 2).map(link).join(', ') + '</span>';
          var cr0 = V.$('.tp-credits', view);
          if (made) made.outerHTML = mh; else if (cr0) cr0.insertAdjacentHTML('afterbegin', mh + (cr0.children.length ? '<span class="dot-sep"></span>' : ''));
        }
        showTab('cast', true);
      }
      // A series whose episodes may be in another order than TMDB's usual: said by the episode list.
      var ob = V.$('.tp-order', view);
      if (ob && isShow && m.order !== undefined && !S.profile.kids && !V.$('[data-order]', ob)) {
        ob.innerHTML = '<button class="linkish" data-order>' + (m.order ? 'Episodes shown in another order · change' : 'Episodes in the wrong order?') + '</button>';
        V.$('[data-order]', ob).onclick = function () { V.episodeOrder(it); };
      }

      // The cast, with faces (in place of the provider's names).
      var castHost = V.$('.tp-cast-host', view);
      if ((m.cast || []).length && castHost) {
        castHost.innerHTML = '<section class="tp-cast"><h2 class="sr-only">Cast</h2><ul class="pc-grid">' + m.cast.map(function (c) {
          return '<li><a class="pc" href="' + personHref(c, m.people) + '"><span class="pc-face" style="--tint:' + V.tint(c.name) + '">' + faceHtml(c) + '</span><span class="pc-n">' + V.esc(c.name) + '</span>' +
            (c.as ? '<span class="pc-as">' + V.esc(c.as) + '</span>' : '') + (c.n ? '<span class="pc-as">' + V.plural(c.n, 'episode') + '</span>' : '') + '</a></li>';
        }).join('') + '</ul></section>';
        var star = V.$('.tp-star', view), sh = '<span class="tp-star">Starring ' + m.cast.slice(0, 3).map(link).join(', ') + '</span>';
        var cr1 = V.$('.tp-credits', view);
        if (star) star.outerHTML = sh; else if (cr1) cr1.insertAdjacentHTML('beforeend', (cr1.children.length ? '<span class="dot-sep"></span>' : '') + sh);
        showTab('cast', true, m.cast.length);
      }
      // Facts, on the Details tab after the basics (title.js draws them together).
      var f = m.facts || {}, rows = [];
      var row = function (k, v) { if (v) rows.push([k, v]); };
      row('Status', V.esc(f.status || ''));
      row('Original title', f.original ? V.esc(f.original) + (f.lang && V.langName(f.lang) && V.langName(f.lang) !== f.lang ? ' <span class="dim">(' + V.esc(V.langName(f.lang)) + ')</span>' : '') : '');
      if (!f.original && f.lang && f.lang !== 'en') row('Original language', V.esc(V.langName(f.lang) || f.lang));
      (m.dates || []).forEach(function (x) { row(V.esc(x.what), V.esc(date(x.date))); });
      if (isShow) {
        row('First shown', f.first ? V.esc(date(f.first)) + (f.last && f.last !== f.first ? ' <span class="dim">· last ' + V.esc(date(f.last)) + '</span>' : '') : '');
        row('Made', f.seasons ? V.plural(f.seasons, 'season') + (f.episodes ? ', ' + V.plural(f.episodes, 'episode') : '') : '');
        row('Network', V.esc((f.networks || []).join(', ')));
      }
      row('Studio', V.esc((f.studios || []).join(', ')));
      row('Budget', money(f.budget));
      row('Box office', money(f.revenue));
      if (m.cert && m.certFrom && m.certFrom !== 'US') row('Age rating', V.esc(m.cert) + ' <span class="dim">(' + V.esc(m.certFrom) + ')</span>');
      var links = [];
      if (f.site) links.push('<a href="' + V.esc(f.site) + '" target="_blank" rel="noopener noreferrer">Official site</a>');
      if (m.imdb) links.push('<a href="https://www.imdb.com/title/' + V.esc(m.imdb) + '/" target="_blank" rel="noopener noreferrer">IMDb</a>');
      if (!S.profile.kids) row('Links', links.join(' · '));
      view._tpFacts = rows;
      if (view._tpDrawFacts) view._tpDrawFacts();
      // What viewers wrote: the first few, sorted as chosen, and more from TMDB a page at a time.
      var host = V.$('.tp-reviews-host', view);
      if ((m.reviews || []).length && host) { V.titleReviews(host, it, m); showTab('reviews', true, Math.max(m.reviewCount || 0, m.reviews.length)); }
    }).catch(function () {});
  };

  // ---------------------------------------------------------------- what viewers wrote
  var RV_SORTS = [['tmdb', 'As on TMDB'], ['new', 'Newest first'], ['old', 'Oldest first'], ['high', 'Highest rated first'], ['low', 'Lowest rated first'], ['long', 'Longest first']];
  var rvSorted = function (list, by) {
    var a = list.slice(), st = function (r) { return r.stars || 0; };
    if (by === 'new') a.sort(function (x, y) { return String(y.at).localeCompare(String(x.at)); });
    else if (by === 'old') a.sort(function (x, y) { return String(x.at).localeCompare(String(y.at)); });
    // (Reviews with no rating go last either way.)
    else if (by === 'high') a.sort(function (x, y) { return (!st(x) - !st(y)) || st(y) - st(x); });
    else if (by === 'low') a.sort(function (x, y) { return (!st(x) - !st(y)) || st(x) - st(y); });
    else if (by === 'long') a.sort(function (x, y) { return y.text.length - x.text.length; });
    return a;
  };
  /** A title's reviews on its Reviews tab: a sort, "Read it all" on long ones, and "More reviews" until there are no more. */
  V.titleReviews = function (host, it, m) {
    var list = (m.reviews || []).slice(), total = m.reviewCount == null ? null : Math.max(m.reviewCount, list.length), page = 0, pages = null, busy = false;
    var sort = V.ls.get('reviewSort', 'tmdb');
    if (!RV_SORTS.some(function (x) { return x[0] === sort; })) sort = 'tmdb';
    var key = function (r) { return r.id || r.by + '|' + r.at + '|' + r.text.slice(0, 40); };
    // (Not known how many in all — from an older server — when the first six came: perhaps more.)
    var moreLeft = function () { return pages === null ? (total === null ? list.length >= 6 : total > list.length) : page < pages; };
    var draw = function (focus) {
      var shown = rvSorted(list, sort);
      host.innerHTML = '<section class="tp-reviews"><h2 class="sr-only">What viewers wrote</h2>' +
        '<div class="rv-bar"><p class="dim small">From people on TMDB. They may give the story away.</p><span class="sp"></span>' +
        '<label class="rv-sort"><span>Sort</span><select class="input" data-rv-sort>' + RV_SORTS.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === sort ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label></div>' +
        shown.map(function (r, i) {
          var long = r.text.length > 420;
          return '<article class="rv"><div class="rv-h"><b>' + V.esc(r.by) + '</b>' + (r.stars ? '<span class="rv-s">★ ' + r.stars + '<span class="dim">/10</span></span>' : '') + (r.at ? '<span class="dim">' + V.esc(date(r.at)) + '</span>' : '') + '</div>' +
            '<p class="rv-t' + (long ? ' clamped' : '') + '" id="rv' + i + '">' + V.esc(r.text).replace(/\n+/g, '<br>') + '</p>' + (long ? '<button class="linkish" data-rv="' + i + '" aria-expanded="false" aria-controls="rv' + i + '">Read it all</button>' : '') + '</article>';
        }).join('') +
        '<div class="rv-more">' + (moreLeft() ? '<button class="btn" data-rv-more>' + (busy ? '<span class="spinner sm"></span> ' : '') + 'More reviews</button>' : '') +
        (list.length > 1 ? '<span class="dim small">' + V.plural(list.length, 'review') + (total > list.length ? ' of ' + total.toLocaleString() : '') + '</span>' : '') + '</div></section>';
      var f = focus && V.$(focus, host);
      if (f) f.focus();
    };
    var loadMore = function () {
      if (busy) return;
      busy = true; draw('[data-rv-more]');
      var b = V.$('[data-rv-more]', host); if (b) b.disabled = true;
      var before = list.length;
      // (TMDB's first page holds the few already shown and up to 20 in all: asked for once, then the next ones.)
      var want = function () {
        page++;
        return V.api('/api/title/' + encodeURIComponent(it.k) + '/reviews?page=' + page).then(function (r) {
          var seen = new Set(list.map(key));
          (r.reviews || []).forEach(function (x) { if (!seen.has(key(x))) { seen.add(key(x)); list.push(x); } });
          pages = r.pages || page; total = Math.max(r.total || 0, list.length);
          // (Nothing new on this page — only the ones already shown — and another to come: on to it.)
          if (list.length === before && page < pages) return want();
        });
      };
      want().catch(function (e) { V.toast(e.message, { error: true }); page = Math.max(0, page - 1); }).then(function () {
        busy = false;
        if (!document.documentElement.contains(host)) return;
        // (All of them now: TMDB's count takes in reviews too short to show.)
        if (pages !== null && page >= pages) total = list.length;
        draw(moreLeft() ? '[data-rv-more]' : '[data-rv-sort]');
      });
    };
    host.onclick = function (e) {
      if (e.target.closest('[data-rv-more]')) return loadMore();
      var b = e.target.closest('[data-rv]');
      if (!b) return;
      var t = V.$('#rv' + b.getAttribute('data-rv'), host), open = t.classList.toggle('clamped') === false;
      b.textContent = open ? 'Show less' : 'Read it all'; b.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    host.onchange = function (e) {
      if (!e.target.matches('[data-rv-sort]')) return;
      sort = e.target.value; V.ls.set('reviewSort', sort);
      draw('[data-rv-sort]');
    };
    draw();
  };

  // ---------------------------------------------------------------- the order of a series' episodes
  V.episodeOrder = function (it) {
    var body = document.createElement('div');
    body.innerHTML = '<p class="dim">Some series are numbered differently on disc or by your provider than when they were first shown. Pick the order that matches the episodes here, and their titles, pictures and descriptions line up — for everyone.</p><div class="eo-list"><div class="spinner"></div></div>';
    var dlg = V.dialog({ title: 'Episode order for “' + it.n + '”', wide: true, body: body, actions: [{ label: 'Close' }] });
    V.api('/api/item/' + encodeURIComponent(it.k) + '/orders').then(function (r) {
      var box = V.$('.eo-list', body);
      if (!box) return;
      var opts = [{ id: '', name: 'As first shown', kind: 'TMDB’s usual order', note: '' }].concat(r.options || []);
      if (opts.length < 2) { box.innerHTML = '<p>TMDB has only one order for this series.</p>'; return; }
      box.innerHTML = '<ul class="eo-ul">' + opts.map(function (o) {
        var cur = (r.current || '') === o.id;
        return '<li><button class="btn ghost block eo-pick' + (cur ? ' cur' : '') + '" data-id="' + V.esc(o.id) + '" aria-pressed="' + cur + '"><span class="eo-n"><b>' + V.esc(o.name) + '</b>' + (cur ? ' <span class="badge">In use</span>' : '') + '</span>' +
          '<small class="dim">' + V.esc([o.kind, o.seasons ? V.plural(o.seasons, 'season') : '', o.episodes ? V.plural(o.episodes, 'episode') : ''].filter(Boolean).join(' · ')) + '</small>' + (o.note ? '<small class="dim eo-note">' + V.esc(o.note) + '</small>' : '') + '</button></li>';
      }).join('') + '</ul>';
      box.onclick = function (e) {
        var b = e.target.closest('.eo-pick');
        if (!b || b.disabled) return;
        V.$$('.eo-pick', box).forEach(function (x) { x.disabled = true; });
        V.api('/api/item/' + encodeURIComponent(it.k) + '/order', { body: { id: b.dataset.id } }).then(function () {
          delete cache[it.k];
          V.toast('Episode order changed for everyone');
          var d = body.closest('dialog'); if (d && d._finish) d._finish(null);
          V.router.refresh();
        }).catch(function (er) { V.$$('.eo-pick', box).forEach(function (x) { x.disabled = false; }); V.fail(er); });
      };
      var first = V.$('.eo-pick.cur', box) || V.$('.eo-pick', box); if (first) first.focus();
    }).catch(function (e) { var box = V.$('.eo-list', body); if (box) box.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
    return dlg;
  };

  // ---------------------------------------------------------------- a person
  var age = function (born, died) {
    var m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(born || '');
    if (!m) return 0;
    var e = /^(\d{4})-(\d\d)-(\d\d)$/.exec(died || ''), end = e ? new Date(+e[1], +e[2] - 1, +e[3]) : new Date();
    var a = end.getFullYear() - +m[1];
    if (end.getMonth() + 1 < +m[2] || (end.getMonth() + 1 === +m[2] && end.getDate() < +m[3])) a--;
    return a > 0 && a < 130 ? a : 0;
  };
  V.route('person', function (view, r) {
    var id = r.args[0] || '', name = r.q.get('n') || '';
    if (V.areaOff('people') || !S.settings.tmdb) { view.innerHTML = V.empty('Not available', 'People’s pages are turned off on this server.', '<div class="btn-row empty-acts"><a class="btn" href="#/home">Home</a></div>'); return; }
    // (Shapes where the page's parts will be while it's fetched — the name already, when it's known.)
    var sk = '';
    for (var si = 0; si < 14; si++) sk += '<span class="sk-card"><span class="sk sk-art"></span><span class="sk sk-l" style="width:72%"></span></span>';
    view.innerHTML = '<div class="person-page pp-sk" aria-busy="true"><header class="pp-h"><div class="pp-face sk"></div><div class="pp-info" style="flex:1">' +
      (name ? '<h1>' + V.esc(name) + '</h1>' : '<span class="sk sk-h"></span>') + '<span class="sk sk-l" style="width:40%"></span><span class="sk sk-l"></span><span class="sk sk-l"></span><span class="sk sk-l" style="width:75%"></span></div></header>' +
      '<section class="pp-here"><h2>Here</h2><div class="grid">' + sk + '</div></section><span class="sr-only" role="status">Loading</span></div>';
    var url = '/api/person/' + (/^\d+$/.test(id) ? id : '0') + (name ? '?n=' + encodeURIComponent(name) : '');
    Promise.all([V.personData(url), V.areaOff('wishlist') || S.profile.kids ? Promise.resolve({ list: [] }) : V.api('/api/wishlist').catch(function () { return { list: [] }; })]).then(function (res) {
      var p = res[0], wishes = res[1].list || [];
      if (!inDoc(view)) return;
      // (Found by name: the page's own address from now on, so Back and sharing it work.)
      if (!/^\d+$/.test(id) && p.id) { try { history.replaceState(null, '', '#/person/' + p.id); } catch (e) {} }
      document.title = p.name + ' · ' + ((S.settings.brand && S.settings.brand.name) || document.title.split(' · ').pop());
      var a = age(p.born, p.died);
      var facts = [p.dept, p.born ? 'Born ' + date(p.born) + (a && !p.died ? ' (' + a + ')' : '') : '', p.died ? 'Died ' + date(p.died) + (a ? ' (aged ' + a + ')' : '') : '', p.place].filter(Boolean);
      var here = (p.here || []).map(function (h) { var it = V.entry(h.k); return it ? { it: it, as: h.as, n: h.n } : null; }).filter(Boolean);
      var wishFor = function (x) { return wishes.filter(function (w) { return String(w.tmdb || '') === String(x.tmdb) && (w.t === 'show') === (x.type === 'tv'); })[0]; };
      var missCard = function (x, i) {
        var w = wishFor(x), can = !V.areaOff('wishlist');
        var label = x.title + (x.year ? ' (' + x.year + ')' : '') + ', not here. ' + (!can ? '' : w ? 'On your wishlist — press to remove' : 'Press to add to your wishlist');
        return '<button class="card poster hl-miss' + (w ? ' wished' : '') + '" data-miss="' + i + '" aria-label="' + V.esc(label) + '" aria-pressed="' + !!w + '"' + (can ? '' : ' disabled') + '>' +
          '<div class="card-art" style="--tint:' + V.tint(x.title) + '">' + (x.poster ? '<img src="' + V.esc(x.poster) + '" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="' + V.esc(V.initials(x.title)) + '" data-title="' + V.esc(x.title) + '">' : '<span class="card-tt big">' + V.esc(x.title) + '</span>') +
          '<span class="badges"><span class="badge">Not here</span></span>' + (can ? '<span class="hl-wish">' + V.icon(w ? 'check' : 'plus') + '<span>Wishlist</span></span>' : '') + '</div>' +
          '<div class="card-meta"><div class="card-t truncate">' + V.esc(x.title) + '</div><div class="card-s truncate">' + V.esc([x.year, x.as || (x.type === 'tv' ? 'Series' : 'Film')].filter(Boolean).join(' · ')) + '</div></div></button>';
      };
      var long = (p.bio || '').length > 520;
      view.innerHTML = '<article class="person-page"><header class="pp-h"><div class="pp-face" style="--tint:' + V.tint(p.name) + '">' + (p.img ? '<img src="' + V.esc(p.img) + '" alt="" referrerpolicy="no-referrer" data-rm>' : '<span class="pc-in" aria-hidden="true">' + V.esc(V.initials(p.name)) + '</span>') + '</div>' +
        '<div class="pp-info"><h1>' + V.esc(p.name) + '</h1><div class="pp-facts dim">' + facts.map(V.esc).join('<span class="dot-sep"></span>') + '</div>' +
        (p.bio ? '<p class="pp-bio' + (long ? ' clamped' : '') + '" id="pp-bio">' + V.esc(p.bio).replace(/\n+/g, '<br><br>') + '</p>' + (long ? '<button class="linkish" data-bio aria-expanded="false" aria-controls="pp-bio">Read more</button>' : '') : '') +
        (p.imdb && !S.profile.kids ? '<p class="small"><a href="https://www.imdb.com/name/' + V.esc(p.imdb) + '/" target="_blank" rel="noopener noreferrer">On IMDb</a></p>' : '') + '</div></header>' +
        '<section class="pp-here"><h2>Here <span class="dim">' + here.length + (p.total ? ' of ' + p.total : '') + '</span></h2><div class="pp-grid"></div></section>' +
        ((p.more || []).length ? '<section class="pp-more"><h2>Also known for <span class="dim">not in your lists</span></h2><div class="grid poster pp-miss">' + p.more.map(missCard).join('') + '</div></section>' : '') + '</article>';
      var bb = V.$('[data-bio]', view);
      if (bb) bb.onclick = function () { var open = V.$('#pp-bio', view).classList.toggle('clamped') === false; bb.textContent = open ? 'Show less' : 'Read more'; bb.setAttribute('aria-expanded', open ? 'true' : 'false'); };
      var grid = V.$('.pp-grid', view);
      if (!here.length) grid.innerHTML = '<p class="dim">Nothing of theirs is in your lists right now.</p>';
      else {
        // (Who they play, under each title — in place of its year and genre.)
        var roles = {};
        here.forEach(function (h) { roles[h.it.k] = h.as + (h.n ? (h.as ? ' · ' : '') + V.plural(h.n, 'episode') : ''); });
        V.grid(grid, here.map(function (h) { return h.it; }), { cardOpts: { showName: true } });
        V.$$('.card', grid).forEach(function (c) { var k = c.getAttribute('data-k'), s = k && roles[k] && V.$('.card-s', c); if (s) { s.textContent = roles[k]; s.title = roles[k]; } });
      }
      var miss = V.$('.pp-miss', view);
      if (miss) miss.onclick = function (e) {
        var b = e.target.closest('[data-miss]');
        if (!b || b.disabled) return;
        var i = +b.getAttribute('data-miss'), x = p.more[i], w = wishFor(x);
        b.disabled = true;
        var redraw = function () { b.outerHTML = missCard(x, i); var n = V.$('[data-miss="' + i + '"]', miss); if (n) n.focus(); };
        var undo = function (er) { b.disabled = false; V.fail(er); };
        if (w) V.del('/api/wishlist/' + w.id).then(function () { wishes = wishes.filter(function (y) { return y !== w; }); V.toast('Removed from your wishlist'); redraw(); }).catch(undo);
        else V.api('/api/wishlist', { body: { t: x.type === 'tv' ? 'show' : 'movie', n: x.title, y: x.year, tmdb: String(x.tmdb), p: x.poster } }).then(function (r2) {
          if (r2.here) { V.toast('It’s here!'); V.router.go(V.hrefOf(V.entry(r2.here) || { t: x.type === 'tv' ? 'show' : 'movie', k: r2.here })); return; }
          wishes.push(r2.item); V.toast('On your wishlist — you’ll get an alert when it arrives'); redraw();
        }).catch(undo);
      };
      var h1 = V.$('h1', view); if (h1 && V.device && V.device.tv) { var f1 = V.$('.card, .linkish, a', view); if (f1) f1.focus(); }
    }).catch(function (e) {
      if (!inDoc(view)) return;
      view.innerHTML = V.empty('Couldn’t find them', V.esc(e.message), '<div class="btn-row empty-acts">' + (name ? '<a class="btn" href="#/search?q=' + encodeURIComponent(name) + '">Search for ' + V.esc(name) + '</a>' : '') + '<a class="btn" href="#/home">Home</a></div>');
    });
  });
  /** Where a person's name leads: their page when those are on, a search otherwise. */
  V.personLink = function (name) { return S.settings.tmdb && !V.areaOff('people') ? '#/person?n=' + encodeURIComponent(name) : ''; };
})();
