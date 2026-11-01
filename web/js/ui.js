/* App shell: navigation, router, cards, rows and grids, item menus and sharing. */
'use strict';

// ---------------------------------------------------------------- router
V.routes = {};
V.route = function (name, fn) { V.routes[name] = fn; };
V.router = {
  stack: [],
  scroll: {},
  current: '',
  go: function (hash, replace) { if (replace) location.replace(hash); else if (location.hash === hash) V.router.render(); else location.hash = hash; },
  back: function (fallback) { if (V.router.stack.length > 1) history.back(); else V.router.go(fallback || '#/home'); },
  parse: function () {
    var h = location.hash.replace(/^#\/?/, '') || 'home';
    var qi = h.indexOf('?');
    var path = qi >= 0 ? h.slice(0, qi) : h;
    var q = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : '');
    var parts = path.split('/').map(function (x) { try { return decodeURIComponent(x); } catch (e) { return x; } });
    return { name: parts[0], args: parts.slice(1), q: q, hash: '#/' + h };
  },
  refresh: function () { V.router.render(true); },
  render: function (keepScroll) {
    if (!S.profile) return;
    var r = V.router.parse();
    var view = V.$('#view');
    if (V.router.current && !keepScroll) V.router.scroll[V.router.current] = window.scrollY;
    var fn = V.routes[r.name] || V.routes.home;
    var prevHash = V.router.current;
    V.router.current = r.hash;
    if (V.router.stack[V.router.stack.length - 2] === r.hash) V.router.stack.pop(); else if (prevHash !== r.hash) V.router.stack.push(r.hash);
    if (V.router.stack.length > 50) V.router.stack.shift();
    V.closeMenus();
    if (V.watch && V.watch.it && !V.watch.mini && !keepScroll) V.setMini(true);
    V.$$('[data-nav]').forEach(function (a) { var on = a.dataset.nav === r.name || (a.dataset.nav === 'home' && !V.routes[r.name]); a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    document.body.dataset.page = r.name;
    if (V.pageCleanup) { try { V.pageCleanup(); } catch (e) {} V.pageCleanup = null; }
    // A fresh container for every page: listeners a page attached (and late async renders) can't leak into the next.
    var fresh = view.cloneNode(false);
    view.parentNode.replaceChild(fresh, view);
    view = fresh;
    view.className = 'view view-' + r.name;
    try { fn(view, r); } catch (e) { console.error(e); view.innerHTML = '<div class="empty"><h2>Something went wrong</h2><p>' + V.esc(e.message) + '</p></div>'; }
    var y = keepScroll ? window.scrollY : V.router.scroll[r.hash] || 0;
    window.scrollTo(0, y);
    if (!keepScroll) {
      var h1 = V.$('h1', view);
      V.announce((h1 ? h1.textContent : r.name) + ' page');
      if (!V.tvMode) view.focus({ preventScroll: true });
      else setTimeout(function () { var f = V.$('#view .hero-acts .btn, #view .tp-acts .btn, #view .card, #view button, #view a'); if (f) f.focus({ preventScroll: true }); }, 60);
    }
  },
};
window.addEventListener('hashchange', function () { V.router.render(); });

// ---------------------------------------------------------------- shell
V.renderShell = function () {
  var b = S.settings.brand || {};
  var logo = b.logo ? (/^data:|^https?:|^\//.test(b.logo) ? '<img src="' + V.esc(b.logo) + '" alt="">' : '<span class="brand-emoji">' + V.esc(b.logo) + '</span>') : '';
  V.$('#brand').innerHTML = logo + '<span class="brand-name">' + V.esc(b.name || '') + '</span>';
  V.$('#brand').setAttribute('aria-label', (b.name || 'Home') + ' — home');
  V.$('#me-btn').innerHTML = V.avatar(S.profile.avatar, 'sm') + '<span class="sr-only">' + V.esc(S.profile.name) + ' — profile menu</span>';
  V.$$('[data-admin-only]').forEach(function (x) { x.hidden = !S.profile.admin; });
  var types = new Set(S.items.map(function (i) { return i.t; }));
  V.$$('[data-need]').forEach(function (x) { x.hidden = !x.dataset.need.split(',').some(function (t) { return types.has(t); }); });
  V.updateUnread();
  document.title = b.name || '';
};
V.updateUnread = function () {
  V.$$('.unread-badge').forEach(function (x) { x.textContent = S.unread > 99 ? '99+' : S.unread || ''; x.hidden = !S.unread; });
};

V.profileMenu = function (btn) {
  var items = [
    { header: S.profile.name },
    { label: 'Settings', icon: 'gear', fn: function () { V.router.go('#/settings'); } },
    { label: 'My List & history', icon: 'bookmark', fn: function () { V.router.go('#/mine'); } },
    { label: 'Downloads', icon: 'download', fn: function () { V.router.go('#/downloads'); } },
    S.profile.admin ? { label: 'Admin', icon: 'shield', fn: function () { V.router.go('#/admin'); } } : null,
    { sep: true },
    { label: 'Switch profile', icon: 'users', fn: function () { V.leaveProfile(); } },
    S.profile.hasPin ? { label: 'Lock profile', icon: 'shield', hint: 'Ask for the PIN next time', fn: function () { V.leaveProfile(true); } } : null,
    { label: 'Sign out of this device', icon: 'logout', fn: function () { V.confirm('Sign out of this device? You’ll need the site password to come back.', { ok: 'Sign out' }).then(function (ok) { if (ok) V.api('/api/logout', { method: 'POST' }).then(function () { location.replace('/'); }); }); } },
  ];
  V.menu(btn, items);
};

// ---------------------------------------------------------------- cards
/** Card for any item. o: { size: 'poster'|'wide'|'channel', sub, progress, rank } */
V.card = function (it, o) {
  o = o || {};
  var t = it.t;
  var shape = o.shape || (t === 'live' || t === 'radio' ? 'channel' : t === 'episode' ? 'wide' : 'poster');
  var pct = o.progress !== undefined ? o.progress : (t === 'movie' || t === 'episode' ? V.pctOf(it.k) : 0);
  var img = it.i || (t === 'episode' ? (V.showOf(it) || {}).i : '');
  var alt = it.i2 || (t === 'episode' && it.i ? (V.showOf(it) || {}).i : '') || '';
  var badges = '';
  if (o.next) badges += '<span class="badge">Next</span>';
  else if (V.isNew(it) && t !== 'live' && t !== 'radio') badges += '<span class="badge new">New</span>';
  if (it.cu) badges += '<span class="badge" title="Catch-up">' + V.icon('archive') + '</span>';
  if (it.cam) badges += '<span class="badge warn" title="Recorded in a cinema: poor picture and sound">CAM</span>';
  if (it.lo) badges += '<span class="badge" title="On the server">' + V.icon('server') + '</span>';
  var sub = o.sub;
  if (sub === undefined) {
    if (t === 'live' || t === 'radio') { var nn = V.epg.nowNext(it); sub = nn.now ? nn.now.t : it.g; }
    else if (t === 'episode') sub = V.epLabel(it) + (it.et ? ' · ' + it.et : '');
    else sub = [it.y, t === 'show' ? (it.ne ? V.plural(it.ne, 'episode') : 'Series') : it.d ? V.fmtLen(it.d) : ''].filter(Boolean).join(' · ');
  }
  var title = t === 'episode' && o.showName ? (V.showOf(it) || {}).n || it.n : it.n;
  var bar = '';
  if (pct > 0 && pct < 1) bar = '<div class="bar"><i style="width:' + pct * 100 + '%"></i></div>';
  if (t === 'live' && !o.noLive) { var n2 = V.epg.nowNext(it); if (n2.now) bar = '<div class="bar live"><i style="width:' + V.clamp((Date.now() - n2.now.s) / (n2.now.e - n2.now.s), 0, 1) * 100 + '%"></i></div>'; }
  var watched = pct >= 1 ? '<span class="watched" title="Watched">' + V.icon('check') + '</span>' : '';
  var label = title + (sub ? ', ' + sub : '') + (pct > 0 && pct < 1 ? ', ' + Math.round(pct * 100) + '% watched' : '');
  return '<a class="card ' + shape + '" href="' + V.hrefOf(it) + '" data-k="' + V.esc(it.k) + '" aria-label="' + V.esc(label) + '" draggable="false">' +
    '<div class="card-art" style="--tint:' + V.tint(it.n) + '">' + (o.rank ? '<span class="rank">' + o.rank + '</span>' : '') +
    (img ? '<img src="' + V.esc(img) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="' + V.esc(V.initials(title)) + '"' + (alt && alt !== img ? ' data-alt="' + V.esc(alt) + '"' : '') + (shape === 'poster' ? ' data-title="' + V.esc(title) + '"' : '') + '>' : '<span class="ini">' + V.esc(V.initials(title)) + '</span>') +
    (shape === 'poster' && !img ? '<span class="card-tt">' + V.esc(title) + '</span>' : '') +
    '<span class="badges">' + badges + '</span>' + watched + (t === 'live' || t === 'radio' ? (it.no ? '<span class="chno num">' + it.no + '</span>' : '') : '') + bar + '</div>' +
    '<div class="card-meta"><div class="card-t truncate">' + V.esc(title) + '</div>' + (sub ? '<div class="card-s truncate">' + V.esc(sub) + '</div>' : '') + '</div></a>';
};
V.hrefOf = function (it) {
  if (it.t === 'movie' || it.t === 'show') return '#/title/' + encodeURIComponent(it.k);
  if (it.t === 'episode') return '#/title/' + encodeURIComponent(it.sk || it.k);
  return '#/channel/' + encodeURIComponent(it.k);
};

/** Clicking a card: channels and "continue" cards play straight away; titles open their page. */
V.cardClick = function (e) {
  var a = e.target.closest('a.card');
  if (!a) return;
  var it = V.entry(a.dataset.k);
  if (!it) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
  if (it.t === 'live' || it.t === 'radio' || a.dataset.play === '1' || (it.t === 'episode' && a.closest('[data-row=continue]'))) {
    e.preventDefault();
    var row = a.closest('[data-list]');
    V.play(it, { list: row && row._items && (it.t === 'live' || it.t === 'radio') ? row._items.filter(function (x) { return x.t === it.t; }) : undefined });
  }
};
document.addEventListener('click', function (e) { if (e.target.closest('#view, .dlg')) V.cardClick(e); });
document.addEventListener('contextmenu', function (e) {
  var a = e.target.closest('a.card');
  if (!a) return;
  var it = V.entry(a.dataset.k);
  if (!it) return;
  e.preventDefault();
  V.itemMenu(a, it);
});
// Long press on touch screens opens the same menu.
(function () {
  var t = null, start = null;
  document.addEventListener('touchstart', function (e) {
    var a = e.target.closest('a.card');
    if (!a) return;
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    t = setTimeout(function () { var it = V.entry(a.dataset.k); if (it) { a._long = true; V.itemMenu(a, it); if (navigator.vibrate) navigator.vibrate(15); } }, 550);
  }, { passive: true });
  document.addEventListener('touchmove', function (e) { if (t && start && (Math.abs(e.touches[0].clientX - start.x) > 10 || Math.abs(e.touches[0].clientY - start.y) > 10)) { clearTimeout(t); t = null; } }, { passive: true });
  document.addEventListener('touchend', function () { clearTimeout(t); t = null; }, { passive: true });
  document.addEventListener('click', function (e) { var a = e.target.closest('a.card'); if (a && a._long) { a._long = false; e.preventDefault(); e.stopImmediatePropagation(); } }, true);
})();

V.itemMenu = function (anchor, it) {
  var u = V.unit(it);
  var isCh = it.t === 'live' || it.t === 'radio';
  var items = [
    { header: it.n },
    { label: isCh ? 'Watch' : V.progressOf(it.k) && !V.progressOf(it.k).w ? 'Resume' : 'Play', icon: 'play', fn: function () { V.play(it); } },
    !isCh ? { label: 'Details', icon: 'info', fn: function () { V.router.go(V.hrefOf(it)); } } : { label: 'Programme guide', icon: 'clock', fn: function () { V.router.go('#/channel/' + encodeURIComponent(it.k)); } },
    isCh ? { label: V.inList('favs', it.k) ? 'Remove from favourites' : 'Add to favourites', icon: V.inList('favs', it.k) ? 'heartf' : 'heart', fn: function () { V.toggle('favs', it.k).then(function (on) { V.toast(on ? 'Added to favourites' : 'Removed from favourites'); }); } }
      : { label: V.inList('list', u.k) ? 'Remove from My List' : 'Add to My List', icon: V.inList('list', u.k) ? 'check' : 'plus', fn: function () { V.toggle('list', u.k).then(function (on) { V.toast(on ? 'Added to My List' : 'Removed from My List'); }); } },
    { label: 'Send to someone…', icon: 'send', fn: function () { V.shareDialog(it); } },
    S.settings.allowParties ? { label: 'Watch together…', icon: 'party', fn: function () { V.party.startDialog(it); } } : null,
    !isCh && S.settings.allowDownloads && it.t !== 'show' ? { label: 'Download', icon: 'download', fn: function () { V.downloads.start(it); } } : null,
    V.sharedLists && V.sharedLists().length ? { label: 'Add to a shared list…', icon: 'stack', fn: function () { V.addToSharedList(u); } } : null,
    { sep: true },
    (V.progressOf(it.k) || (it.sk && Object.keys(S.data.progress).some(function (x) { return S.data.progress[x].sk === it.sk; }))) ? { label: 'Remove from Continue Watching', icon: 'x', fn: function () {
      // For a series: every episode's place, so an earlier episode doesn't take its spot. History is kept.
      var key = it.sk || it.k;
      V.del('/api/history?progress=1&k=' + encodeURIComponent(key)).then(function () {
        Object.keys(S.data.progress).forEach(function (x) { if (x === it.k || x === key || S.data.progress[x].sk === key) delete S.data.progress[x]; });
        V.router.refresh();
      });
    } } : null,
    { label: V.inList('hidden', u.k) ? 'Show it again' : 'Not interested', icon: 'eyeoff', fn: function () { V.toggle('hidden', u.k).then(function (on) { V.toast(on ? 'Hidden. You won’t be recommended this.' : 'It’ll show up again.'); V.router.refresh(); }); } },
  ];
  V.menu(anchor, items, { align: 'left' });
};

// ---------------------------------------------------------------- rows (horizontal) & grids
/** A titled horizontal row. o: { id, title, items, more (href), cardOpts, play, numbered } */
V.row = function (o) {
  if (!o.items || !o.items.length) return null;
  var sec = document.createElement('section');
  sec.className = 'row' + (o.cls ? ' ' + o.cls : '');
  sec.dataset.row = o.id || '';
  sec.setAttribute('aria-label', o.title);
  sec.innerHTML = '<div class="row-h"><h2>' + (o.more ? '<a href="' + o.more + '">' + V.esc(o.title) + ' ' + V.icon('next') + '</a>' : V.esc(o.title)) + '</h2>' + (o.extra || '') + '</div>' +
    '<div class="row-wrap"><button class="row-btn prev" aria-label="Scroll left" tabindex="-1">' + V.icon('back') + '</button><div class="row-scroll" data-list role="list"></div><button class="row-btn next" aria-label="Scroll right" tabindex="-1">' + V.icon('next') + '</button></div>';
  var sc = V.$('.row-scroll', sec);
  sc._items = o.items;
  var n = 0;
  var batch = function () {
    var html = '';
    var end = Math.min(o.items.length, n + 24);
    for (; n < end; n++) {
      var x = o.items[n];
      var it = x.it || x;
      var co = Object.assign({}, o.cardOpts || {}, x.opts || {});
      if (o.numbered) co.rank = n + 1;
      if (x.next) co.next = true;
      html += V.card(it, co).replace('<a ', '<a role="listitem" ' + (o.play || x.play ? 'data-play="1" ' : ''));
    }
    sc.insertAdjacentHTML('beforeend', html);
  };
  batch();
  sc.addEventListener('scroll', V.throttle(function () {
    if (n < o.items.length && sc.scrollLeft + sc.clientWidth * 2 > sc.scrollWidth) batch();
    sec.classList.toggle('at-start', sc.scrollLeft < 8);
    sec.classList.toggle('at-end', sc.scrollLeft + sc.clientWidth > sc.scrollWidth - 8);
  }, 120), { passive: true });
  sec.classList.add('at-start');
  V.$('.prev', sec).onclick = function () { sc.scrollBy({ left: -sc.clientWidth * 0.9, behavior: 'smooth' }); };
  V.$('.next', sec).onclick = function () { if (n < o.items.length) batch(); sc.scrollBy({ left: sc.clientWidth * 0.9, behavior: 'smooth' }); };
  sc.addEventListener('focusin', function (e) { var a = e.target.closest('.card'); if (a && n < o.items.length && Array.prototype.indexOf.call(sc.children, a) > n - 6) batch(); });
  if (o.track) V.trackImpressions(sc);
  return sec;
};

/** A wrapping grid that renders more as you scroll. */
V.grid = function (host, items, o) {
  o = o || {};
  host.innerHTML = '';
  var g = document.createElement('div');
  g.className = 'grid ' + (o.shape || 'poster');
  g.setAttribute('role', 'list');
  g.dataset.list = '';
  g._items = items;
  host.appendChild(g);
  var n = 0;
  var more = function () {
    var html = '';
    var end = Math.min(items.length, n + (o.batch || 60));
    for (; n < end; n++) html += V.card(items[n], o.cardOpts).replace('<a ', '<a role="listitem" ');
    g.insertAdjacentHTML('beforeend', html);
    if (n >= items.length && sentinel) { io.disconnect(); sentinel.remove(); sentinel = null; }
  };
  var sentinel = document.createElement('div');
  sentinel.className = 'sentinel';
  host.appendChild(sentinel);
  var io = new IntersectionObserver(function (es) { if (es[0].isIntersecting) more(); }, { rootMargin: '1200px' });
  more();
  if (sentinel) io.observe(sentinel);
  if (!items.length && o.empty) host.innerHTML = '<div class="empty">' + o.empty + '</div>';
  g.addEventListener('focusin', function (e) { var a = e.target.closest('.card'); if (a && Array.prototype.indexOf.call(g.children, a) > n - 12 && n < items.length) more(); });
  return g;
};

/** Counts how often recommended titles are shown without being opened (so they can make way for others). */
V.trackImpressions = function (el) {
  if (!window.IntersectionObserver) return;
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting && e.target.dataset.k && !e.target._seen) { e.target._seen = true; V.impression(e.target.dataset.k); } });
  }, { threshold: 0.8 });
  var watch = function () { V.$$('.card', el).forEach(function (c) { if (!c._obs) { c._obs = true; io.observe(c); } }); };
  watch();
  new MutationObserver(watch).observe(el, { childList: true });
};

// ---------------------------------------------------------------- page helpers
V.pageHead = function (title, extra) { return '<header class="page-h"><h1>' + V.esc(title) + '</h1>' + (extra || '') + '</header>'; };
V.chips = function (list, current, attr) {
  return '<div class="chips" role="toolbar">' + list.map(function (c) { return '<button class="chip' + (c.v === current ? ' on' : '') + '" data-' + attr + '="' + V.esc(c.v) + '" aria-pressed="' + (c.v === current) + '">' + V.esc(c.l) + (c.n !== undefined ? ' <small>' + c.n + '</small>' : '') + '</button>'; }).join('') + '</div>';
};
V.empty = function (title, text, action) {
  return '<div class="empty">' + V.icon('tv', 'empty-i') + '<h2>' + V.esc(title) + '</h2>' + (text ? '<p>' + text + '</p>' : '') + (action || '') + '</div>';
};

// ---------------------------------------------------------------- sharing
V.shareDialog = function (it, opts) {
  opts = opts || {};
  return V.api('/api/social').then(function (soc) {
    var others = soc.profiles.filter(function (p) { return p.id !== S.profile.id; });
    if (!others.length) return V.toast('There’s nobody else to send it to yet. Add more profiles first.');
    var pos = opts.pos || 0;
    V.dialog({
      title: 'Send “' + it.n + '”',
      body: '<div class="pick-people">' + [{ id: 'all', name: 'Everyone', all: true }].concat(others).map(function (p) { return '<label class="person"><input type="checkbox" value="' + p.id + '">' + (p.all ? '<span class="avatar sm all">' + V.icon('users') + '</span>' : V.avatar(p.avatar, 'sm')) + '<span>' + V.esc(p.name) + '</span></label>'; }).join('') + '</div>' +
        '<label class="field"><span>Message (optional)</span><textarea class="input" rows="2" data-msg maxlength="2000" placeholder="You have to watch this!"></textarea></label>' +
        (pos ? '<label class="check"><input type="checkbox" data-pos checked><span>Start at ' + V.fmtDur(pos) + '</span></label>' : ''),
      actions: [{ label: 'Cancel' }, { label: 'Send', primary: true, fn: function (d) {
        var to = V.$$('.person input:checked', d).map(function (x) { return x.value; });
        if (!to.length) { V.toast('Pick who to send it to', { error: true }); return false; }
        if (to.indexOf('all') >= 0) to = ['all'];
        var text = V.$('[data-msg]', d).value;
        var usePos = V.$('[data-pos]', d) && V.$('[data-pos]', d).checked;
        return Promise.all(to.map(function (id) { return V.api('/api/messages', { body: { to: id, text: text, item: { k: it.k, n: it.n, t: it.t, i: it.i || (V.showOf(it) || {}).i || '', pos: usePos ? pos : 0 } } }); })).then(function () { V.toast('Sent'); });
      } }],
    });
  }).catch(V.fail);
};

// ---------------------------------------------------------------- shared watchlists
V.sharedLists = function () { return S.sharedLists || []; };
V.loadSharedLists = function () { return V.api('/api/social').then(function (s) { S.sharedLists = s.lists; S.socialCache = s; S.unread = s.unread; V.updateUnread(); return s; }); };
V.addToSharedList = function (it) {
  var lists = V.sharedLists();
  V.dialog({
    title: 'Add to a shared list',
    body: '<div class="pick-list">' + lists.map(function (l) { var has = l.items.some(function (x) { return x.k === it.k; }); return '<button class="btn block" data-l="' + l.id + '"' + (has ? ' disabled' : '') + '>' + V.esc(l.name) + (has ? ' · already there' : '') + '</button>'; }).join('') + '</div>' +
      '<button class="btn block ghost" data-new>' + V.icon('plus') + ' New shared list</button>',
    onOpen: function (d, finish) {
      d.addEventListener('click', function (e) {
        var b = e.target.closest('[data-l]');
        if (b) V.put('/api/lists/' + b.dataset.l, { add: { k: it.k } }).then(function () { V.toast('Added'); V.loadSharedLists(); finish(); }).catch(V.fail);
        if (e.target.closest('[data-new]')) V.prompt('Name the shared list', { placeholder: 'Movie night', max: 60 }).then(function (n) { if (!n) return; V.api('/api/lists', { body: { name: n } }).then(function (l) { return V.put('/api/lists/' + l.id, { add: { k: it.k } }); }).then(function () { V.toast('Added'); V.loadSharedLists(); finish(); }).catch(V.fail); });
      });
    },
  });
};
