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
    // (A page of an area the admin switched off: Home instead.)
    if (V.pageOff(r.name)) { V.router.go('#/home', true); return; }
    var fn = V.routes[r.name] || V.routes.home;
    var prevHash = V.router.current;
    V.router.current = r.hash;
    if (V.router.stack[V.router.stack.length - 2] === r.hash) V.router.stack.pop(); else if (prevHash !== r.hash) V.router.stack.push(r.hash);
    if (V.router.stack.length > 50) V.router.stack.shift();
    V.closeMenus();
    // (Playing on top of its page — a phone held upright — and still on it: it stays there.)
    if (V.watch && V.watch.it && !V.watch.mini && !keepScroll && !(V.watch.dock && V.onDockPage(r))) V.setMini(true);
    V.$$('[data-nav]').forEach(function (a) { var on = a.dataset.nav === r.name || (a.dataset.nav === 'home' && !V.routes[r.name]) || (!!a.dataset.also && a.dataset.also.split(',').indexOf(r.name) >= 0); a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    document.body.dataset.page = r.name;
    if (V.pageCleanup) { try { V.pageCleanup(); } catch (e) {} V.pageCleanup = null; }
    // A fresh container for every page: listeners a page attached (and late async renders) can't leak into the next.
    var fresh = view.cloneNode(false);
    view.parentNode.replaceChild(fresh, view);
    view = fresh;
    view.className = 'view view-' + r.name + (keepScroll ? '' : ' enter');
    try { fn(view, r); } catch (e) { console.error(e); view.innerHTML = '<div class="empty"><h2>Something went wrong</h2><p>' + V.esc(e.message) + '</p></div>'; }
    V.emit('route', r); // (easy.js: the section links on Settings)
    var y = keepScroll ? window.scrollY : V.router.scroll[r.hash] || 0;
    window.scrollTo(0, y);
    // A row of tabs wider than the screen (Admin on a phone): bring the current one into view.
    var tab = V.$('.tabs .tab.on', view);
    if (tab && tab.parentNode.scrollWidth > tab.parentNode.clientWidth) tab.parentNode.scrollLeft = Math.max(0, tab.offsetLeft - tab.parentNode.offsetLeft - (tab.parentNode.clientWidth - tab.offsetWidth) / 2);
    if (!keepScroll) {
      var h1 = V.$('h1', view);
      V.announce((h1 ? h1.textContent : r.name) + ' page');
      if (!V.tvMode) view.focus({ preventScroll: true });
      // (Unless the page has already put focus somewhere itself, like the guide on what's on now.)
      else setTimeout(function () { var a = document.activeElement, vw = V.$('#view'); if (a && a !== document.body && vw && vw.contains(a)) return; var pick = ['#view .hero-acts .btn', '#view .tp-acts .btn', '#view .grp.on', '#view .card', '#view button', '#view a']; var f = null; for (var i = 0; i < pick.length && !f; i++) f = V.$(pick[i]); if (f) f.focus({ preventScroll: true }); }, 60); // (in that order: Play on a title page, not the first genre chip)
    }
  },
};
window.addEventListener('hashchange', function () {
  Array.prototype.forEach.call(document.querySelectorAll('dialog.dlg'), function (d) { if (d._routeClose) d._routeClose(); });
  V.router.render();
});

// ---------------------------------------------------------------- shell
V.renderShell = function () {
  var b = S.settings.brand || {};
  var logo = b.logo ? (/^data:|^https?:|^\//.test(b.logo) ? '<img src="' + V.esc(b.logo) + '" alt="">' : '<span class="brand-emoji">' + V.esc(b.logo) + '</span>') : '';
  V.$('#brand').innerHTML = logo + '<span class="brand-name">' + V.esc(b.name || '') + '</span>';
  V.$('#brand').setAttribute('aria-label', (b.name || 'Home') + ' — home');
  V.$('#me-btn').innerHTML = V.avatar(S.profile.avatar, 'sm') + '<span class="sr-only">' + V.esc(S.profile.name) + ' — profile menu</span>';
  // (Admin — or, for a profile the admin made a manager, the few sections that role has.)
  V.$$('[data-admin-only]').forEach(function (x) { x.hidden = !V.canManage(); var nm = S.profile.admin ? 'Admin' : 'Manage'; x.setAttribute('aria-label', nm); x.title = nm; });
  V.applyAreas();
  // (Which kinds there are, from the lists already sorted by kind: not a pass over half a million items.)
  var types = new Set();
  if (S.live && S.live.length) types.add('live');
  if (S.radio && S.radio.length) types.add('radio');
  if (S.movies && S.movies.length) types.add('movie');
  if (S.shows && S.shows.length) types.add('show');
  if (S.episodes && S.episodes.length) types.add('episode');
  if (!S.live && S.items) S.items.forEach(function (i) { types.add(i.t); });
  V.$$('[data-need]').forEach(function (x) { x.hidden = !x.dataset.need.split(',').some(function (t) { return types.has(t); }); });
  // Phones: the one Live TV tab opens radio when there are radio stations and no TV channels.
  var lt = V.$('#tabbar [data-nav=live]');
  if (lt) { var radioOnly = !types.has('live') && types.has('radio'); lt.setAttribute('href', radioOnly ? '#/radio' : '#/live'); V.$('span', lt).textContent = radioOnly ? 'Radio' : 'Live TV'; V.$('use', lt).setAttribute('href', radioOnly ? '#i-radio' : '#i-tv'); }
  V.updateUnread();
  V.headerSearch();
  document.title = b.name || '';
};

/** A search box in the top bar on wide screens (not TVs: there the Search page is a press away). The first letter typed
 *  goes to the Search page — the results there follow what's typed, in its own box — and Enter does too. */
V.headerSearch = function () {
  if (V.$('#hdr-search')) return;
  var link = V.$('#topbar [data-nav=search]');
  if (!link) return;
  var f = document.createElement('form');
  f.id = 'hdr-search';
  f.className = 'hdr-search';
  f.setAttribute('role', 'search');
  f.innerHTML = '<span class="hs-i">' + V.icon('search') + '</span><input type="search" class="hs-in" placeholder="Search" aria-label="Search films, series, channels and people" enterkeyhint="search" spellcheck="false">';
  link.parentNode.insertBefore(f, link);
  var inp = V.$('input', f);
  var go = function (q) { inp.value = ''; inp.blur(); V.router.go('#/search' + (q ? '?q=' + encodeURIComponent(q) : '')); };
  // (Keys pressed while the page changes are kept, and the Search page's box takes them: nothing typed is lost.)
  inp.addEventListener('input', function () {
    var buf = inp.value;
    if (!buf.trim() || /^#\/search/.test(location.hash)) return;
    inp.value = '';
    var grab = function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key && e.key.length === 1) { buf += e.key; e.preventDefault(); } else if (e.key === 'Backspace') { buf = buf.slice(0, -1); e.preventDefault(); }
    };
    document.addEventListener('keydown', grab, true);
    var ta = V.searchTypeAhead = { take: function () { document.removeEventListener('keydown', grab, true); if (V.searchTypeAhead === ta) V.searchTypeAhead = null; return buf; } };
    setTimeout(function () { if (V.searchTypeAhead === ta) ta.take(); }, 4000);
    V.router.go('#/search?q=' + encodeURIComponent(buf.trim()));
  });
  f.onsubmit = function (e) { e.preventDefault(); go(inp.value.trim()); };
  // Escape with nothing to close: out of the box.
  inp.addEventListener('keydown', function (e) { if ((e.key === 'Escape' || e.key === 'Esc') && !e.defaultPrevented) { inp.value = ''; inp.blur(); } });
};
V.updateUnread = function () {
  var n = (V.areaOff('messages') ? 0 : S.unread || 0) + (S.alertsUnread || 0); // (messages, and alerts in New for you)
  V.$$('.unread-badge').forEach(function (x) { x.textContent = n > 99 ? '99+' : n || ''; x.hidden = !n; });
};

V.profileMenu = function (btn) {
  var items = [
    { header: S.profile.name },
    { label: 'Settings', icon: 'gear', fn: function () { V.router.go('#/settings'); } },
    { label: 'My List & history', icon: 'bookmark', fn: function () { V.router.go('#/mine'); } },
    V.palette ? { label: 'Quick launcher', icon: 'search', hint: V.device.touch || V.tvMode ? '' : 'Ctrl+K', fn: function () { V.palette.open(); } } : null,
    { label: 'Wishlist', icon: 'star', area: 'wishlist', fn: function () { V.router.go('#/wishlist'); } },
    { label: 'Your viewing', icon: 'chart', area: 'viewing', fn: function () { V.router.go('#/viewing'); } },
    { label: 'Downloads', icon: 'download', fn: function () { V.router.go('#/downloads'); } },
    V.dvr && V.dvr.visible() ? { label: 'Recordings', icon: 'rec', fn: function () { V.router.go('#/recordings'); } } : null,
    V.canManage() ? { label: S.profile.admin ? 'Admin' : 'Manage', icon: 'shield', fn: function () { V.router.go('#/admin'); } } : null,
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
  var ne = t === 'show' && V.newEpsOf ? V.newEpsOf(it.k) : null;
  if (o.next) badges += '<span class="badge">Next</span>';
  else if (ne) badges += '<span class="badge new">' + (ne.n > 1 ? ne.n + ' new' : 'New episode') + '</span>';
  else if (V.isNew(it) && t !== 'live' && t !== 'radio') badges += '<span class="badge new">New</span>';
  if (it.es === 'live') badges += '<span class="badge live">Live</span>';
  if (it.cu) badges += '<span class="badge" title="Catch-up">' + V.icon('archive') + '</span>';
  if (it.cam) badges += '<span class="badge warn" title="Recorded in a cinema: poor picture and sound">CAM</span>';
  if (it.lo) badges += '<span class="badge" title="On the server">' + V.icon('server') + '</span>';
  if (it.lk && V.parental && !V.parental.open(it)) badges += '<span class="badge" title="Locked: needs the parental PIN">' + V.icon('lock') + '</span>';
  var sub = o.sub;
  if (sub === undefined) {
    if (t === 'live' || t === 'radio') { var nn = V.epg.nowNext(it); sub = nn.now ? nn.now.t : it.ev ? (it.es === 'ended' ? 'Ended · ' : '') + it.ev : it.es === 'none' ? 'No event right now' : V.catLabel ? V.catLabel(it) : it.g; }
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

/** Clicking a card: channels play straight away; titles — those in Continue watching too — open their page, which offers
    Resume (a series: "Resume S1:E3", or the next episode). */
V.cardClick = function (e) {
  var a = e.target.closest('a.card');
  if (!a) return;
  var it = V.entry(a.dataset.k);
  if (!it) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
  if (it.t === 'live' || it.t === 'radio' || a.dataset.play === '1') {
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

/** A title's or channel's options. opts.onPage: the title's own page, whose buttons already do Play, My List,
 *  Download and Shuffle — the menu then has only what the page doesn't (queue, send, watch together…). */
V.itemMenu = function (anchor, it, opts) {
  opts = opts || {};
  var u = V.unit(it);
  var isCh = it.t === 'live' || it.t === 'radio';
  var items = [
    { header: it.n },
    { label: isCh ? 'Watch' : V.progressOf(it.k) && !V.progressOf(it.k).w ? 'Resume' : 'Play', icon: 'play', fn: function () { V.play(it); } },
    !isCh ? { label: 'Details', icon: 'info', fn: function () { V.router.go(V.hrefOf(it)); } } : { label: 'Programme guide', icon: 'clock', fn: function () { V.router.go('#/channel/' + encodeURIComponent(it.k)); } },
    isCh ? { label: V.inList('favs', it.k) ? 'Remove from favourites' : 'Add to favourites', icon: V.inList('favs', it.k) ? 'heartf' : 'heart', fn: function () { V.toggle('favs', it.k).then(function (on) { V.toast(on ? 'Added to favourites' : 'Removed from favourites'); }); } }
      : { label: V.inList('list', u.k) ? 'Remove from My List' : 'Add to My List', icon: V.inList('list', u.k) ? 'check' : 'plus', fn: function () { V.toggle('list', u.k).then(function (on) { V.toast(on ? 'Added to My List' : 'Removed from My List'); }); } },
    { label: 'Send to someone…', icon: 'send', area: 'messages', fn: function () { V.shareDialog(it); } },
    S.settings.allowParties ? { label: 'Watch together…', icon: 'party', fn: function () { V.party.startDialog(it); } } : null,
    it.t === 'live' && V.multiview && S.live.length > 1 ? { label: 'Add to multiview', icon: 'grid', area: 'multiview', fn: function () { V.multiview.open(it); } } : null,
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
  if (V.itemMenuExtras) V.itemMenuExtras(items, it, isCh);
  if (opts.onPage) {
    var onPage = { play: 1, info: 1, plus: 1, check: 1, download: 1, shuffle: 1 };
    items = items.filter(function (x) { return !x || x.sep || x.header || !onPage[x.icon]; });
    // (No separator first or last, nor two in a row.)
    items = items.filter(function (x, i, a) { return x && !(x.sep && (i === 1 || i === a.length - 1 || (a[i - 1] && a[i - 1].sep))); });
    if (items.length <= 1) { V.toast('Everything for this is on the page'); return; }
  }
  V.menu(anchor, items, { align: 'left' });
};

// ---------------------------------------------------------------- rows (horizontal) & grids
/** Dragging a row sideways with the mouse (a finger and a trackpad scroll it by themselves). A press that didn't move
    is still a click on the card. */
V.rowDrag = function (sc) {
  var x0 = 0, left0 = 0, down = false, moved = false;
  var move = function (e) {
    if (!down) return;
    var dx = e.clientX - x0;
    if (!moved && Math.abs(dx) < 6) return;
    if (!moved) { moved = true; sc.classList.add('dragging'); }
    sc.scrollLeft = left0 - dx;
    e.preventDefault();
  };
  var up = function () {
    if (!down) return;
    down = false;
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    if (moved) setTimeout(function () { moved = false; sc.classList.remove('dragging'); }, 0); // (after the click that ends the drag — if there is one: let go outside the row and there isn't)
  };
  sc.addEventListener('mousedown', function (e) {
    if (e.button !== 0 || V.tvMode || sc.scrollWidth <= sc.clientWidth) return;
    down = true; moved = false; x0 = e.clientX; left0 = sc.scrollLeft;
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  // (The click a drag ends with isn't a click on the card under the pointer.)
  sc.addEventListener('click', function (e) { if (moved) { moved = false; e.preventDefault(); e.stopPropagation(); } }, true);
  sc.addEventListener('dragstart', function (e) { e.preventDefault(); });
};
/** A row works out its pages once it's on the page and in view (and again when the window changes size). */
V.rowSeen = (function () {
  var io = null;
  try { if (window.IntersectionObserver) io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting && e.target._where) e.target._where(); }); }, { rootMargin: '200px 0px' }); } catch (e) { io = null; }
  window.addEventListener('resize', V.throttle(function () { V.$$('.row').forEach(function (r) { if (r._where) r._where(); }); }, 200));
  return function (sec) {
    if (io) io.observe(sec);
    else { setTimeout(function () { sec._where(); }, 0); sec.addEventListener('mouseenter', function () { sec._where(); }); }
  };
})();

/** A titled horizontal row. o: { id, title, items, more (href), cardOpts, play, numbered } */
V.row = function (o) {
  if (!o.items || !o.items.length) return null;
  var sec = document.createElement('section');
  sec.className = 'row' + (o.cls ? ' ' + o.cls : '');
  sec.dataset.row = o.id || '';
  sec.setAttribute('aria-label', o.title);
  // (The page buttons: always there on a device with a mouse — see .row-pg in p27.css — with which page of how many.)
  var pager = '<div class="row-pg"><button class="row-pg-b prev" type="button" aria-label="Previous titles in ' + V.esc(o.title) + '" tabindex="-1" disabled>' + V.icon('back') + '</button><span class="row-pg-n" aria-hidden="true"></span><button class="row-pg-b next" type="button" aria-label="More titles in ' + V.esc(o.title) + '" tabindex="-1">' + V.icon('next') + '</button></div>';
  sec.innerHTML = '<div class="row-h"><h2>' + (o.more ? '<a href="' + o.more + '">' + V.esc(o.title) + ' ' + V.icon('next') + '</a>' : V.esc(o.title)) + '</h2>' + (o.extra || '') + pager + '</div>' +
    '<div class="row-wrap"><button class="row-btn prev" aria-label="Scroll left" tabindex="-1">' + V.icon('back') + '</button><div class="row-scroll" data-list></div><button class="row-btn next" aria-label="Scroll right" tabindex="-1">' + V.icon('next') + '</button></div>';
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
      html += V.card(it, co).replace('<a ', '<a ' + (o.play || x.play ? 'data-play="1" ' : ''));
    }
    sc.insertAdjacentHTML('beforeend', html);
  };
  batch();
  // Where the row is: the first and last page switch their button off, and the header says "2 / 5".
  var pgN = V.$('.row-pg-n', sec), pgPrev = V.$('.row-pg-b.prev', sec), pgNext = V.$('.row-pg-b.next', sec);
  var where = function () {
    var w = sc.clientWidth;
    if (!w) return; // (not on the page yet)
    var first = sc.firstElementChild, pad = parseFloat(getComputedStyle(sc).paddingLeft) || 0;
    var gap = first && first.nextElementSibling ? first.nextElementSibling.offsetLeft - first.offsetLeft - first.offsetWidth : 0;
    var step = first ? first.offsetWidth + gap : w, inner = Math.max(step, w - pad * 2);
    var per = Math.max(1, Math.floor((inner + gap) / step)), pages = Math.max(1, Math.ceil(o.items.length / per));
    var atStart = sc.scrollLeft < 8, atEnd = n >= o.items.length && sc.scrollLeft + w > sc.scrollWidth - 8;
    var cur = atStart ? 1 : atEnd ? pages : Math.min(pages, Math.max(1, Math.round(sc.scrollLeft / (per * step)) + 1));
    if (!atEnd && cur === pages && pages > 1) cur = pages - 1;
    if (!atStart && cur === 1 && pages > 1) cur = 2;
    sec.classList.toggle('at-start', atStart);
    sec.classList.toggle('at-end', atEnd);
    sec.classList.toggle('can-page', pages > 1);
    pgN.textContent = cur + ' / ' + pages;
    pgPrev.disabled = atStart; pgNext.disabled = atEnd;
  };
  sec._where = where;
  sc.addEventListener('scroll', V.throttle(function () {
    if (n < o.items.length && sc.scrollLeft + sc.clientWidth * 2 > sc.scrollWidth) batch();
    where();
  }, 120), { passive: true });
  sec.classList.add('at-start');
  // A page at a time, and always whole cards: forward puts the first card that isn't fully in view at the left edge;
  // back puts the card before the first one in view at the right.
  var page = function (dir) {
    if (dir > 0 && n < o.items.length) batch();
    var kids = sc.children, pad = parseFloat(getComputedStyle(sc).paddingLeft) || 0, box = sc.getBoundingClientRect();
    var from = box.left + pad, to = box.right - pad, target = null, i, r;
    if (dir > 0) {
      for (i = 0; i < kids.length; i++) { r = kids[i].getBoundingClientRect(); if (r.right > to + 2) { target = sc.scrollLeft + r.left - from; break; } }
      if (target === null) target = sc.scrollWidth;
    } else {
      var firstIn = -1;
      for (i = 0; i < kids.length; i++) { r = kids[i].getBoundingClientRect(); if (r.left >= from - 2) { firstIn = i; break; } }
      if (firstIn <= 0) target = 0;
      else {
        var edge = kids[firstIn].getBoundingClientRect().left - (to - from); // (a page's width before the first card in view)
        target = 0;
        for (i = 0; i < firstIn; i++) { r = kids[i].getBoundingClientRect(); if (r.left >= edge - 2) { target = sc.scrollLeft + r.left - from; break; } }
      }
    }
    sc.scrollTo({ left: Math.max(0, target), behavior: V.reduceMotion && V.reduceMotion() ? 'auto' : 'smooth' });
  };
  V.$('.row-btn.prev', sec).onclick = pgPrev.onclick = function () { page(-1); };
  V.$('.row-btn.next', sec).onclick = pgNext.onclick = function () { page(1); };
  V.rowDrag(sc);
  V.rowSeen(sec);
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
  g.dataset.list = '';
  g._items = items;
  host.appendChild(g);
  var n = 0;
  var more = function () {
    var html = '';
    var end = Math.min(items.length, n + (o.batch || 60));
    for (; n < end; n++) html += V.card(items[n], o.cardOpts);
    g.insertAdjacentHTML('beforeend', html);
    if (n >= items.length && sentinel) { io.disconnect(); sentinel.remove(); sentinel = null; }
  };
  // (Drawn as far as card i: a jump to a letter further down than what's drawn yet.)
  g._upTo = function (i) { while (n <= i && n < items.length) more(); };
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
  if (V.areaOff('messages')) { V.toast('Messages are switched off on this server.'); return Promise.resolve(); }
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
