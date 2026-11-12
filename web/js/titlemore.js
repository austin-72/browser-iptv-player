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
  V.titleLogo = function (el, url, name) {
    if (!el || !url || el.querySelector('.t-logo')) return;
    var img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = function () {
      // (Gone, or showing another title by now.)
      if (!inDoc(el) || el.textContent !== name || img.naturalWidth < 40) return;
      el.innerHTML = '';
      img.className = 't-logo'; img.alt = name;
      el.appendChild(img);
      el.classList.add('has-logo');
    };
    img.src = url;
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

  /** On a title's page, once its basics are drawn. d: what /api/item gave. */
  V.titleMore = function (view, it, d) {
    if (!S.settings.tmdb || (it.t !== 'movie' && it.t !== 'show')) return;
    var isShow = it.t === 'show';
    V.titleMoreData(it.k).then(function (m) {
      if (!m || m.none || !inDoc(view) || !V.$('.title-page', view)) return;
      if (m.logo && !V.areaOff('logos')) V.titleLogo(V.$('.tp-info h1', view), m.logo, it.n);
      var plot = V.$('.tp-plot', view);
      if (m.tagline && plot && !V.$('.tp-tag', view)) plot.insertAdjacentHTML('beforebegin', '<p class="tp-tag">' + V.esc(m.tagline) + '</p>');
      // An age rating found where there was none.
      if (m.cert && !d.c && !V.$('.tp-meta .cert', view)) { var tm = V.$('.tp-meta', view); if (tm) tm.insertAdjacentHTML('afterbegin', '<span class="cert">' + V.esc(m.cert) + '</span><span class="dot-sep"></span>'); }

      // Who made it: names that open the person's page.
      var cr = V.$('.tp-credits', view);
      if (cr && (m.crew || []).length) {
        var by = {}, order = [];
        m.crew.forEach(function (c) { if (!by[c.job]) { by[c.job] = []; order.push(c.job); } by[c.job].push(c); });
        var plural = { Director: 'Directors', Writer: 'Writers', Creator: 'Created by', Music: 'Music', Photography: 'Photography', Book: 'From the book by' };
        var lines = order.map(function (job) {
          var l = by[job];
          return '<div><b>' + V.esc(job === 'Creator' || job === 'Book' || job === 'Music' || job === 'Photography' ? plural[job] : l.length > 1 ? plural[job] : job) + ':</b> ' + l.map(function (c) { return '<a href="' + personHref(c, m.people) + '">' + V.esc(c.name) + '</a>'; }).join(', ') + '</div>';
        }).join('');
        // (In place of the one line of names there was: "Director: …" / "Created by: …".)
        var old = V.$$('.tp-credits > div', view).filter(function (x) { return /^(Director|Created by):/.test(x.textContent); })[0];
        if (old) old.outerHTML = lines; else cr.insertAdjacentHTML('afterbegin', lines);
      }
      // A series whose episodes may be in another order than TMDB's usual.
      if (cr && isShow && m.order !== undefined && !S.profile.kids && !V.$('[data-order]', cr)) {
        var fix = V.$('.tp-fix', cr);
        var ob = document.createElement('div');
        ob.innerHTML = '<button class="linkish" data-order>' + (m.order ? 'Episodes shown in another order · change' : 'Episodes in the wrong order?') + '</button>';
        cr.insertBefore(ob, fix || null);
        V.$('[data-order]', ob).onclick = function () { V.episodeOrder(it); };
      }

      var host = V.$('.tp-extra', view);
      if (!host) return;
      var html = '';
      // The cast, with faces.
      if ((m.cast || []).length) {
        html += '<section class="tp-cast"><h2>Cast</h2><ul class="pc-row">' + m.cast.map(function (c) {
          return '<li><a class="pc" href="' + personHref(c, m.people) + '"><span class="pc-face" style="--tint:' + V.tint(c.name) + '">' + faceHtml(c) + '</span><span class="pc-n">' + V.esc(c.name) + '</span>' +
            (c.as ? '<span class="pc-as">' + V.esc(c.as) + '</span>' : '') + (c.n ? '<span class="pc-as">' + V.plural(c.n, 'episode') + '</span>' : '') + '</a></li>';
        }).join('') + '</ul></section>';
        var plain = V.$$('.tp-credits > div', view).filter(function (x) { return /^Cast:/.test(x.textContent); })[0];
        if (plain) plain.hidden = true;
      }
      // Facts.
      var f = m.facts || {}, rows = [];
      var row = function (k, v) { if (v) rows.push('<div><dt>' + k + '</dt><dd>' + v + '</dd></div>'); };
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
      if (rows.length) html += '<section class="tp-facts"><h2>Details</h2><dl class="facts">' + rows.join('') + '</dl></section>';
      // What viewers wrote.
      if ((m.reviews || []).length) {
        html += '<section class="tp-reviews"><h2>What viewers wrote</h2><p class="dim small">From people on TMDB. They may give the story away.</p>' + m.reviews.map(function (r, i) {
          var long = r.text.length > 420;
          return '<article class="rv"><div class="rv-h"><b>' + V.esc(r.by) + '</b>' + (r.stars ? '<span class="rv-s">★ ' + r.stars + '<span class="dim">/10</span></span>' : '') + (r.at ? '<span class="dim">' + V.esc(date(r.at)) + '</span>' : '') + '</div>' +
            '<p class="rv-t' + (long ? ' clamped' : '') + '" id="rv' + i + '">' + V.esc(r.text).replace(/\n+/g, '<br>') + '</p>' + (long ? '<button class="linkish" data-rv="' + i + '" aria-expanded="false" aria-controls="rv' + i + '">Read it all</button>' : '') + '</article>';
        }).join('') + '</section>';
      }
      host.innerHTML = html;
      host.onclick = function (e) {
        var b = e.target.closest('[data-rv]');
        if (!b) return;
        var t = V.$('#rv' + b.getAttribute('data-rv'), host), open = t.classList.toggle('clamped') === false;
        b.textContent = open ? 'Show less' : 'Read it all'; b.setAttribute('aria-expanded', open ? 'true' : 'false');
      };
      var pr = V.$('.pc-row', host);
      if (pr && V.rowDrag) V.rowDrag(pr);
    }).catch(function () {});
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
    view.innerHTML = '<div class="person-page"><div class="spinner"></div></div>';
    var url = '/api/person/' + (/^\d+$/.test(id) ? id : '0') + (name ? '?n=' + encodeURIComponent(name) : '');
    Promise.all([V.api(url), V.areaOff('wishlist') || S.profile.kids ? Promise.resolve({ list: [] }) : V.api('/api/wishlist').catch(function () { return { list: [] }; })]).then(function (res) {
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
