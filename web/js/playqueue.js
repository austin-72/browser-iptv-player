/* The play queue: films, series and episodes lined up to play one after another ("Play next", "Add to queue" on
   title pages and in the … menus). When something ends, the next one starts with the usual "Up next" countdown
   (watch.js asks V.queue.after). The queue is kept on the server with the profile's other data, so it's the same on
   every device of the profile; something leaves it when it starts playing. View and change it in My stuff → Queue
   or from the player's menu (Your queue). */
'use strict';
(function () {
  var Q = V.queue = {};
  var list = Q.list = function () { return (S.data && S.data.queue) || []; };
  var find = function (k) { var l = list(); for (var i = 0; i < l.length; i++) if (l[i].k === k) return l[i]; return null; };
  Q.has = function (k) { return !!find(k); };
  var alive = function (el) { return document.documentElement.contains(el); };
  var queueable = function (it) { return !!it && (it.t === 'movie' || it.t === 'show' || it.t === 'episode'); };
  Q.queueable = queueable;

  // ------------------------------------------------------------ what each entry is
  /** The catalogue item for an entry, or a stand-in from what was saved (episodes some series only load when opened). */
  var entryOf = function (q) {
    var it = V.entry(q.k);
    if (it) return it;
    var show = q.sk ? V.entry(q.sk) : null;
    return { k: q.k, t: q.t, n: q.n || (show && show.n) || 'Unknown', sk: q.sk, i: show ? show.i : '', missing: true };
  };
  /** Episodes of series that only load when opened: load them, so queued ones can be shown and played. */
  var warmed = {};
  var warm = function (redraw) {
    list().forEach(function (q) {
      var show = q.t === 'episode' && q.sk && !V.entry(q.k) ? V.entry(q.sk) : null;
      if (!show || warmed[show.k]) return;
      warmed[show.k] = 1;
      V.loadEpisodes(show).then(function () { if (redraw) redraw(); }, function () {});
    });
  };
  /** The first queued thing that isn't what's playing (marked queued: true, for watch.js). */
  Q.after = function (it) {
    var l = list();
    for (var i = 0; i < l.length; i++) {
      var q = l[i];
      if (it && (q.k === it.k || (q.t === 'show' && q.k === it.sk))) continue;
      return Object.assign({}, entryOf(q), { queued: true, qk: q.k });
    }
    return null;
  };

  // ------------------------------------------------------------ changing it
  var local = function (op) {
    var l = list().slice();
    var i = -1;
    l.forEach(function (x, j) { if (x.k === op.k || (op.item && x.k === op.item.k)) i = j; });
    if (op.op === 'add' || op.op === 'next') {
      if (i >= 0) l.splice(i, 1);
      var e = { k: op.item.k, t: op.item.t, n: op.item.n, sk: op.item.sk, at: Date.now() };
      if (op.op === 'next') l.unshift(e); else l.push(e);
    } else if (op.op === 'remove') { if (i >= 0) l.splice(i, 1); }
    else if (op.op === 'played') l = l.filter(function (x) { return x.k !== op.k && !(op.sk && x.t === 'show' && x.k === op.sk); });
    else if (op.op === 'move' && i >= 0) { var x = l.splice(i, 1)[0]; l.splice(V.clamp(i + op.by, 0, l.length), 0, x); }
    else if (op.op === 'clear') l = [];
    return l;
  };
  /** Changes it here at once, then on the server (whose answer is the truth: another device may have changed it too). */
  var send = function (op) {
    if (!S.data) return Promise.resolve([]);
    S.data.queue = local(op);
    changed();
    return V.api('/api/queue', { body: op }).then(function (r) { S.data.queue = r.queue || []; changed(); return S.data.queue; }, function (e) {
      V.fail(e);
      return V.api('/api/queue').then(function (r) { S.data.queue = r.queue || []; changed(); });
    });
  };
  var itemOf = function (it) { return { k: it.k, t: it.t, n: it.t === 'episode' ? ((V.showOf(it) || {}).n || it.n) + ' ' + V.epLabel(it) : it.n, sk: it.sk || '' }; };
  Q.add = function (it, next) {
    if (!queueable(it)) return;
    send({ op: next ? 'next' : 'add', item: itemOf(it) });
    V.toast(next ? '“' + nameOf(it) + '” plays next' : 'Added to your queue', { action: { label: 'See queue', fn: Q.open } });
  };
  Q.remove = function (k) { return send({ op: 'remove', k: k }); };
  Q.move = function (k, by) { return send({ op: 'move', k: k, by: by }); };
  Q.clear = function () { return send({ op: 'clear' }); };
  /** Plays an entry (or what Q.after returned). */
  Q.play = function (x) {
    var q = find(x.qk || x.k) || x;
    var it = V.entry(q.k);
    if (it) return V.play(it);
    var show = q.sk ? V.entry(q.sk) : null;
    if (!show) { V.toast('“' + (q.n || 'That') + '” isn’t available any more', { error: true }); Q.remove(q.k); return; }
    V.loadEpisodes(show).then(function () {
      var ep = V.entry(q.k);
      if (ep) V.play(ep); else { V.toast('That episode isn’t available any more', { error: true }); Q.remove(q.k); }
    }).catch(V.fail);
  };

  // Something starts playing: it leaves the queue (a queued series when any of its episodes starts).
  V.on('playing', function (it) {
    if (!it || !queueable(it) || !S.data) return;
    if (list().some(function (q) { return q.k === it.k || (q.t === 'show' && q.k === it.sk); })) send({ op: 'played', k: it.k, sk: it.sk || '' });
    else nextButton();
  });

  // ------------------------------------------------------------ menus
  var nameOf = function (it) { return it.t === 'episode' ? ((V.showOf(it) || {}).n || it.n) + ' ' + V.epLabel(it) : it.n; };
  /** "Play next" and "Add to queue" (or "Remove from queue") for a … menu. */
  Q.menuItems = function (it) {
    if (!queueable(it)) return [];
    var inQ = Q.has(it.k);
    return [
      { label: 'Play next', icon: 'skipnext', fn: function () { Q.add(it, true); } },
      inQ ? { label: 'Remove from queue', icon: 'x', fn: function () { Q.remove(it.k); V.toast('Removed from your queue'); } } : { label: 'Add to queue', icon: 'playlist', fn: function () { Q.add(it, false); } },
    ];
  };
  /** The queue button on a title page. */
  Q.menu = function (anchor, it) {
    V.menu(anchor, [{ header: 'Your queue' + (list().length ? ' (' + list().length + ')' : '') }].concat(Q.menuItems(it), [{ label: 'See your queue', icon: 'list', fn: Q.open }]));
  };
  var prevItemExtras = V.itemMenuExtras;
  V.itemMenuExtras = function (items, it, isCh) {
    if (prevItemExtras) prevItemExtras(items, it, isCh);
    var add = Q.menuItems(it);
    if (!add.length) return;
    // Right after Play / Details.
    var at = 0;
    for (var i = 0; i < items.length; i++) if (items[i] && items[i].icon === 'play') at = i + 1;
    if (at && items[at] && items[at].icon === 'info') at++;
    items.splice.apply(items, [at || 1, 0].concat(add));
  };
  var prevPlayerExtras = V.playerMenuExtras;
  V.playerMenuExtras = function (p, main, pages) {
    if (prevPlayerExtras) prevPlayerExtras(p, main, pages);
    if (!p.it || p.it.t === 'catchup') return;
    var n = list().length;
    // (Opened once the menu has closed and given the focus back, so the focus can go into the panel.)
    main.push({ label: 'Your queue', value: n ? V.plural(n, 'title') : 'Empty', fn: function () { setTimeout(Q.openSide, 0); } });
  };

  // ------------------------------------------------------------ the queue view (My stuff → Queue, and in the player)
  /** Opens the queue: beside the video while watching, otherwise its page. */
  Q.open = function () {
    if (V.watch && V.watch.it && !V.watch.mini && !V.$('#player-layer').hidden) return Q.openSide();
    V.router.go('#/mine/queue');
  };
  var subOf = function (it, q) {
    if (it.missing) return it.t === 'episode' ? 'Episode' : V.TYPE_NAMES[it.t] || '';
    if (it.t === 'episode') return [V.epLabel(it), it.et].filter(Boolean).join(' · ');
    if (it.t === 'show') return 'Series · carries on where you left off';
    return ['Film', it.y, it.d ? V.fmtLen(it.d) : ''].filter(Boolean).join(' · ');
  };
  var titleOf = function (it) { return it.t === 'episode' ? ((V.showOf(it) || {}).n || it.n) : it.n; };
  var rows = function (compact) {
    var l = list();
    return '<ol class="q-list' + (compact ? ' compact' : '') + '">' + l.map(function (q, i) {
      var it = entryOf(q);
      // An episode's own still is landscape; posters (films, series, an episode without a still) stay uncropped, upright.
      var wide = it.t === 'episode' && !!it.i && !it.missing;
      var img = it.i || (it.t === 'episode' ? (V.showOf(it) || {}).i : '');
      var pct = it.t === 'movie' || it.t === 'episode' ? V.pctOf(it.k) : 0;
      var t = titleOf(it);
      return '<li class="q-row" data-k="' + V.esc(q.k) + '"><span class="q-n num">' + (i + 1) + '</span>' +
        '<span class="q-slot"><span class="q-art ' + (wide ? 'wide' : 'tall') + '" style="--tint:' + V.tint(t) + '">' + (img ? '<img src="' + V.esc(img) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '<span class="ini">' + V.esc(V.initials(t)) + '</span>') + (pct > 0 && pct < 1 ? '<span class="bar"><i style="width:' + Math.round(pct * 100) + '%"></i></span>' : '') + '</span></span>' +
        '<span class="q-b"><b class="truncate">' + V.esc(t) + '</b><span class="dim small truncate">' + V.esc(subOf(it, q)) + '</span></span>' +
        '<span class="q-acts"><button class="icon-btn" data-q="play" aria-label="Play ' + V.esc(t) + '" title="Play now">' + V.icon('play') + '</button>' +
        '<button class="icon-btn" data-q="up" aria-label="Move ' + V.esc(t) + ' up" title="Move up"' + (i ? '' : ' disabled') + '>' + V.icon('next', 'q-up') + '</button>' +
        '<button class="icon-btn" data-q="down" aria-label="Move ' + V.esc(t) + ' down" title="Move down"' + (i < l.length - 1 ? '' : ' disabled') + '>' + V.icon('next', 'q-down') + '</button>' +
        '<button class="icon-btn" data-q="del" aria-label="Remove ' + V.esc(t) + ' from the queue" title="Remove">' + V.icon('x') + '</button></span></li>';
    }).join('') + '</ol>';
  };
  var EMPTY_TEXT = 'Choose <b>Play next</b> or <b>Add to queue</b> on a film, series or episode (on its page or in its ' + V.icon('dots', 'tiny') + ' menu). They play one after another, on any of your devices.';
  /** Draws the queue into host and keeps it up to date. compact: the player's side panel. */
  var draw = function (host, compact) {
    var l = list();
    var focus = document.activeElement && host.contains(document.activeElement) ? document.activeElement : null;
    var keep = focus && focus.closest('[data-k]') ? { k: focus.closest('[data-k]').dataset.k, q: focus.dataset.q } : null;
    host.innerHTML = (l.length ? '<div class="page-tools q-tools">' + (compact ? '' : '<span class="dim">' + V.plural(l.length, 'title') + ' · plays in this order</span><span class="sp"></span>') +
      '<button class="btn sm primary" data-q="start">' + V.icon('play') + ' Play the queue</button><button class="btn sm" data-q="clear">' + V.icon('trash') + ' Clear</button></div>' + rows(compact)
      : (compact ? '<p class="dim">Your queue is empty.</p><p class="dim small">' + EMPTY_TEXT + '</p>' : V.empty('Your queue is empty', EMPTY_TEXT, '<div class="btn-row empty-acts"><a class="btn" href="#/movies">Browse movies</a><a class="btn" href="#/series">Browse series</a></div>')));
    // Keep the focus where it was (a remote moving something up several times in a row).
    if (keep) {
      var row = V.$('[data-k="' + (window.CSS && CSS.escape ? CSS.escape(keep.k) : keep.k) + '"]', host);
      var other = { up: 'down', down: 'up' }[keep.q];
      var b = row && (V.$('[data-q="' + keep.q + '"]:not([disabled])', row) || (other && V.$('[data-q="' + other + '"]:not([disabled])', row)) || V.$('[data-q=play]', row));
      if (b) b.focus(); else { var f = V.$('[data-q]', host); if (f) f.focus(); }
    }
    warm(function () { if (alive(host)) draw(host, compact); });
  };
  var act = function (e, host, compact) {
    var b = e.target.closest('[data-q]');
    if (!b || b.disabled) return false;
    e.stopPropagation();
    var a = b.dataset.q;
    var row = b.closest('[data-k]');
    var k = row && row.dataset.k;
    if (a === 'start') { var first = list()[0]; if (first) Q.play(first); }
    else if (a === 'clear') V.confirm('Clear your queue?', { ok: 'Clear', danger: true }).then(function (ok) { if (ok) Q.clear(); });
    else if (a === 'play') Q.play(find(k) || { k: k });
    else if (a === 'up' || a === 'down') { Q.move(k, a === 'up' ? -1 : 1); }
    else if (a === 'del') {
      // Focus moves to the next row's same button (or the previous row's), so a remote can keep going.
      var sib = row.nextElementSibling || row.previousElementSibling;
      Q.remove(k);
      if (sib) { var nb = V.$('[data-k="' + (window.CSS && CSS.escape ? CSS.escape(sib.dataset.k) : sib.dataset.k) + '"] [data-q=del]', host); if (nb) nb.focus(); }
    }
    return true;
  };
  var views = []; // drawn queues to update when it changes: { host, compact }
  Q.render = function (host, compact) {
    views = views.filter(function (v) { return alive(v.host) && v.host !== host; });
    views.push({ host: host, compact: !!compact });
    draw(host, compact);
    host.addEventListener('click', function (e) { act(e, host, compact); });
  };
  Q.openSide = function () {
    var side = V.$('.vp-side', V.player.host);
    if (V.watch.side === 'queue') return V.closeSide();
    V.closeSide();
    V.watch.side = 'queue';
    side.hidden = false;
    side.innerHTML = '<header><h3>Your queue</h3><button class="pbtn" data-side-x aria-label="Close">' + V.icon('x') + '</button></header><div class="side-list q-side"></div>';
    side.onclick = function (e) { if (e.target.closest('[data-side-x]')) { e.stopPropagation(); V.closeSide(); } };
    var host = V.$('.q-side', side);
    Q.render(host, true);
    var f = V.$('[data-q]', host) || V.$('[data-side-x]', side);
    if (f) f.focus();
  };
  // Closing a side panel with Back: the focus goes back to the player (not to the page behind it).
  var prevClose = V.closeSide;
  V.closeSide = function () {
    var had = V.watch && V.watch.side;
    prevClose.apply(this, arguments);
    var a = document.activeElement;
    if (had && V.player && V.watch.it && !V.watch.mini && (!a || a === document.body)) V.player.el.focus();
  };
  function changed() {
    views = views.filter(function (v) { return alive(v.host); });
    views.forEach(function (v) { draw(v.host, v.compact); });
    nextButton();
    marks();
    V.emit('queue');
  }
  /** Queue buttons on title pages, and the count on the Queue tab. */
  function marks() {
    V.$$('[data-a=queue][data-qk]').forEach(function (b) { b.setAttribute('aria-pressed', Q.has(b.dataset.qk)); });
    var tab = V.$('.tab[href="#/mine/queue"]');
    if (tab) tab.textContent = 'Queue' + (list().length ? ' (' + list().length + ')' : '');
  }
  // Changed on another device (or the profile's data was reloaded).
  V.on('data', function (f) { if (f === '*' || f === 'queue') { views = views.filter(function (v) { return alive(v.host); }); views.forEach(function (v) { draw(v.host, v.compact); }); nextButton(); marks(); } });

  /** The player's Next button: also for films when something is queued. */
  function nextButton() {
    var p = V.player, it = V.watch && V.watch.it;
    if (!p || !it || !V.upNext) return;
    var b = V.$('[data-a=next]', p.host);
    if (!b) return;
    var nx = V.upNext(it);
    b.hidden = !nx;
    var label = nx && nx.queued ? 'Play next in your queue: ' + titleOf(nx) : 'Next episode';
    b.setAttribute('aria-label', label);
    b.title = label;
  }
})();
