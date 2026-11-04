/* Home rows from TMDB lists ("x of y here", See the whole list), the Wishlist, alerts in Messages →
   New for you, and the bell on series pages. Server side: lib/routes-p10.js. */
'use strict';
(function () {
  var HL = V.homeLists = { rows: [], avail: null, at: 0, pid: null, loading: null };
  var FOLLOW = { follow: [], mute: [], at: 0, pid: null };

  // ------------------------------------------------------------ loading the rows
  V.loadHomeLists = function (force) {
    if (!S.profile) return Promise.resolve();
    if (HL.pid !== S.profile.id) { HL.rows = []; HL.at = 0; HL.pid = S.profile.id; syncDefs(); }
    if (!force && HL.loading) return HL.loading;
    if (!force && Date.now() - HL.at < 5 * 60e3) return Promise.resolve();
    var who = S.profile.id;
    HL.at = Date.now();
    HL.loading = V.api('/api/homelists').then(function (r) {
      if (!S.profile || S.profile.id !== who) return;
      var before = JSON.stringify(HL.rows);
      HL.rows = r.rows || [];
      HL.avail = r.available || null;
      syncDefs();
      // A list still being fetched for the first time: look again shortly.
      if (HL.rows.some(function (x) { return x.loading; })) setTimeout(function () { V.loadHomeLists(true); }, 6000);
      if (before !== JSON.stringify(HL.rows) && document.body.dataset.page === 'home' && !V.$('dialog[open]')) V.router.refresh();
    }).catch(function () {}).then(function () { HL.loading = null; });
    return HL.loading;
  };
  /** The rows join the others in "Customise this page" (show / hide / order). */
  function syncDefs() {
    V.HOME_ROWS = V.HOME_ROWS.filter(function (r) { return r.id.indexOf('xl:') !== 0; });
    HL.rows.forEach(function (r) { V.HOME_ROWS.push({ id: r.id, name: r.name + ' · list' }); });
  }
  var rowOf = function (id) { return HL.rows.filter(function (r) { return r.id === id; })[0] || null; };

  /** home.js asks for rows it doesn't know: these are ours. */
  V.homeRowBuilder = function (id, add) {
    if (id.indexOf('xl:') !== 0) return;
    var r = rowOf(id);
    if (!r) return;
    var hidden = new Set(S.data.hidden);
    var items = r.keys.map(V.entry).filter(function (it) { return it && !hidden.has(it.k); });
    add({ id: id, title: r.name, items: items, more: '#/homelist/' + encodeURIComponent(id), track: true, cls: 'hl-row',
      extra: '<span class="hl-count dim small">' + V.esc(hereText(r)) + '</span><button class="icon-btn sm hl-menu" data-hl-menu="' + V.esc(id) + '" aria-label="Options for ' + V.esc(r.name) + '">' + V.icon('dots') + '</button>' });
  };
  function hereText(r) { return r.total ? r.here + ' of ' + r.total + ' here' : r.err ? 'Couldn’t load the list' : 'Loading…'; }

  V.homeFootExtra = function () { return '<button class="btn ghost" data-hl-add>' + V.icon('plus') + ' Add a row from a list</button>'; };

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-hl-menu]');
    if (b) { e.preventDefault(); rowMenu(b, b.getAttribute('data-hl-menu')); return; }
    if (e.target.closest('[data-hl-add]')) { e.preventDefault(); V.addListRow(); }
  });

  function homeOrder() {
    var h = S.data.home;
    return (h.order && h.order.length ? h.order : []).concat(V.HOME_ROWS.map(function (r) { return r.id; })).filter(function (x, i, a) { return a.indexOf(x) === i; });
  }
  function rowMenu(btn, id) {
    var r = rowOf(id);
    if (!r) return;
    V.menu(btn, [
      { header: r.name },
      { label: 'See the whole list', icon: 'list', fn: function () { V.router.go('#/homelist/' + encodeURIComponent(id)); } },
      { label: 'Move to the top', icon: 'up', fn: function () { var o = homeOrder().filter(function (x) { return x !== id; }); o.unshift(id); S.data.home.order = o; V.saveHome(); V.router.refresh(); } },
      { label: 'Rename…', icon: 'edit', fn: function () { V.prompt('Name this row', { value: r.name, max: 80 }).then(function (n) { if (!n) return; V.put('/api/homelists/rows/' + encodeURIComponent(id), { name: n }).then(function () { V.loadHomeLists(true); }).catch(V.fail); }); } },
      { label: 'Hide this row', icon: 'eyeoff', hint: 'Show it again in Customise this page', fn: function () { if (S.data.home.hidden.indexOf(id) < 0) S.data.home.hidden.push(id); V.saveHome(); V.router.refresh(); } },
      { sep: true },
      { label: 'Remove this row', icon: 'trash', danger: true, fn: function () { removeRow(id); } },
    ], { align: 'left' });
  }
  function removeRow(id) {
    V.del('/api/homelists/rows/' + encodeURIComponent(id)).then(function () {
      HL.rows = HL.rows.filter(function (x) { return x.id !== id; });
      syncDefs();
      var h = S.data.home;
      h.order = (h.order || []).filter(function (x) { return x !== id; });
      h.hidden = (h.hidden || []).filter(function (x) { return x !== id; });
      V.saveHome();
      V.toast('Row removed');
      if (document.body.dataset.page === 'home') V.router.refresh();
    }).catch(V.fail);
  }

  // ------------------------------------------------------------ adding a row
  V.addListRow = function () {
    var av = HL.avail || {};
    var body = '<p class="dim">A row on your home page with the titles from a list that are here. It’s checked again every day.</p>' +
      '<label class="field"><span>Paste a list link</span><div class="inline"><input class="input" data-hl-text placeholder="themoviedb.org/list/… , /collection/… or /keyword/…" autocomplete="off"><button class="btn primary" data-hl-go>Add</button></div>' +
      '<small class="dim">A TMDB list (people share lists of Oscar winners, a director’s films…), a collection (every film of a series) or a keyword (“christmas”, “time travel”…).</small></label>' +
      '<p class="hl-msg err" role="alert" hidden></p>' +
      (av.tmdb ? '' : '<p class="note" data-need="tmdb">' + V.icon('info') + ' <span>TMDB lists aren’t available: they need a TMDB key. ' + (S.profile.admin ? 'Add a free one in <a href="#/admin/recs">Admin → Recommendations</a>.' : 'The admin can add a free one in Admin → Recommendations.') + '</span></p>');
    V.dialog({
      title: 'Add a row from a list', wide: true, body: body,
      onOpen: function (d, finish) {
        var msg = V.$('.hl-msg', d), input = V.$('[data-hl-text]', d);
        var busy = false;
        var go = function (payload, btn) {
          if (busy) return;
          busy = true; msg.hidden = true;
          if (btn) btn.disabled = true;
          var note = V.toast('Fetching the list…', { ms: 20000 });
          V.api('/api/homelists/rows', { body: payload }).then(function (res) {
            note();
            var id = res.row.id;
            var o = homeOrder().filter(function (x) { return x !== id; });
            var at = o.indexOf('continue');
            o.splice(at >= 0 ? at + 1 : 0, 0, id);
            S.data.home.order = o;
            S.data.home.hidden = (S.data.home.hidden || []).filter(function (x) { return x !== id; });
            V.saveHome();
            HL.rows = res.rows; syncDefs(); HL.at = Date.now();
            var r = rowOf(id);
            V.toast(res.existed ? 'That list is already on your home page.' : 'Added “' + res.row.name + '”' + (r ? ' — ' + hereText(r) : ''));
            finish(true);
            if (document.body.dataset.page === 'home') V.router.refresh(); else V.router.go('#/home');
          }).catch(function (e) {
            note();
            // TMDB isn't set up and the dialog already says so: point at that note rather than repeat it.
            var need = /TMDB key/.test(e.message) ? 'tmdb' : '';
            var shown = need && V.$('[data-need=' + need + ']', d);
            V.$$('[data-need]', d).forEach(function (x) { x.classList.remove('warn'); x.removeAttribute('role'); });
            if (shown) { msg.hidden = true; shown.classList.add('warn'); shown.setAttribute('role', 'alert'); V.announce(shown.textContent); return; }
            msg.textContent = e.message; msg.hidden = false;
          }).then(function () { busy = false; if (btn) btn.disabled = false; });
        };
        V.$('[data-hl-go]', d).onclick = function (e) { var t = input.value.trim(); if (!t) { input.focus(); return; } go({ text: t }, e.currentTarget); };
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); V.$('[data-hl-go]', d).click(); } });
        d.addEventListener('click', function (e) {
          if (e.target.closest('a[href^="#/"]')) finish(null);
        });
      },
    });
  };

  // ------------------------------------------------------------ the whole list
  V.route('homelist', function (view, r) {
    var id = r.args[0] || '';
    var show = r.q.get('show') || 'all';
    view.innerHTML = '<div class="hl-page"><div class="spinner"></div></div>';
    var box = V.$('.hl-page', view);
    var wishes = [];
    Promise.all([V.api('/api/homelists/rows/' + encodeURIComponent(id)), V.api('/api/wishlist').catch(function () { return { list: [] }; })]).then(function (res) {
      var L = res[0];
      wishes = res[1].list || [];
      draw(L);
    }).catch(function (e) { box.innerHTML = V.empty('Not found', V.esc(e.message), '<div class="btn-row empty-acts"><a class="btn" href="#/home">Home</a></div>'); });

    function wishFor(x) { return wishes.filter(function (w) { return w.t === x.t && (x.tmdb && w.tmdb ? w.tmdb === x.tmdb : w.n.toLowerCase() === x.n.toLowerCase()); })[0] || null; }
    function draw(L) {
      var hidden = new Set(S.data.hidden);
      var items = L.items.map(function (x, i) { x.rank = i + 1; x.it = x.k ? V.entry(x.k) : null; if (x.it && hidden.has(x.k)) x.it = null; return x; });
      var here = items.filter(function (x) { return x.it; }), missing = items.filter(function (x) { return !x.it; });
      var list = show === 'here' ? here : show === 'missing' ? missing : items;
      var src = { 'tmdb-list': 'TMDB list', 'tmdb-collection': 'TMDB collection', 'tmdb-keyword': 'TMDB keyword' }[L.kind] || 'List';
      box.innerHTML = V.pageHead(L.name, '<button class="btn" data-hl="refresh">' + V.icon('refresh') + ' Check again</button><button class="icon-btn" data-hl-menu="' + V.esc(L.id) + '" aria-label="Row options">' + V.icon('dots') + '</button>') +
        '<p class="hl-sum"><b>' + here.length + ' of ' + L.total + ' here</b> <span class="dim">· ' + V.esc(src) + (L.listName && L.listName !== L.name ? ': ' + V.esc(L.listName) : '') + (L.at ? ' · checked ' + V.fmtAgo(L.at) : '') + '</span></p>' +
        (L.err ? '<p class="note warn">' + V.icon('info') + ' The last check failed: ' + V.esc(L.err) + '</p>' : '') +
        V.chips([{ v: 'all', l: 'Everything', n: items.length }, { v: 'here', l: 'Here', n: here.length }, { v: 'missing', l: 'Not here', n: missing.length }], show, 'show') +
        (missing.length && show !== 'here' ? '<p class="dim small">Titles that aren’t here can go on your <a href="#/wishlist">wishlist</a>: you’ll get an alert when one arrives.</p>' : '') +
        '<div class="grid poster hl-grid" data-list></div>';
      var g = V.$('.hl-grid', box);
      g._items = here.map(function (x) { return x.it; });
      g.innerHTML = list.length ? list.map(function (x) { return x.it ? V.card(x.it, { rank: x.rank }) : missCard(x); }).join('') : '<div class="empty">' + (show === 'here' ? 'None of these are here yet.' : 'Everything on this list is here.') + '</div>';
      box.onclick = function (e) {
        var c = e.target.closest('[data-show]');
        if (c) { show = c.getAttribute('data-show'); try { history.replaceState(null, '', '#/homelist/' + encodeURIComponent(id) + (show === 'all' ? '' : '?show=' + show)); } catch (x) {} draw(L); var f = V.$('[data-show="' + show + '"]', box); if (f) f.focus(); return; }
        if (e.target.closest('[data-hl=refresh]')) {
          var b = e.target.closest('[data-hl=refresh]'); b.disabled = true;
          V.api('/api/homelists/rows/' + encodeURIComponent(id) + '/refresh', { method: 'POST' }).then(function (L2) { V.toast('Checked'); V.loadHomeLists(true); draw(L2); }).catch(function (er) { b.disabled = false; V.fail(er); });
          return;
        }
        var m = e.target.closest('[data-miss]');
        if (m) {
          var x = list[+m.getAttribute('data-miss')];
          var w = wishFor(x);
          // (Off until the answer: a second press would add it twice, or remove it twice.)
          if (m.disabled) return;
          m.disabled = true;
          var undo = function (er) { m.disabled = false; V.fail(er); };
          if (w) V.del('/api/wishlist/' + w.id).then(function () { wishes = wishes.filter(function (y) { return y !== w; }); V.toast('Removed from your wishlist'); redrawMiss(m, x); }).catch(undo);
          else V.api('/api/wishlist', { body: { t: x.t, n: x.n, y: x.y, tmdb: x.tmdb, p: x.p } }).then(function (res2) {
            if (res2.here) { V.toast('It’s here!'); V.router.go(V.hrefOf(V.entry(res2.here) || { t: x.t, k: res2.here })); return; }
            wishes.push(res2.item); V.toast('On your wishlist — you’ll get an alert when it arrives'); redrawMiss(m, x);
          }).catch(undo);
        }
      };
      function redrawMiss(el, x) { var i = el.getAttribute('data-miss'); el.outerHTML = missCard(x).replace('data-miss="i"', 'data-miss="' + i + '"'); var n = V.$('[data-miss="' + i + '"]', box); if (n) n.focus(); }
      function missCard(x) {
        var i = list.indexOf(x);
        var w = wishFor(x);
        var label = x.n + (x.y ? ' (' + x.y + ')' : '') + ', not here. ' + (w ? 'On your wishlist — press to remove' : 'Press to add to your wishlist');
        return '<button class="card poster hl-miss' + (w ? ' wished' : '') + '" data-miss="' + (i < 0 ? 'i' : i) + '" aria-label="' + V.esc(label) + '" aria-pressed="' + !!w + '">' +
          '<div class="card-art" style="--tint:' + V.tint(x.n) + '"><span class="rank">' + x.rank + '</span>' + (x.p ? '<img src="' + V.esc(x.p) + '" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="' + V.esc(V.initials(x.n)) + '" data-title="' + V.esc(x.n) + '">' : '<span class="card-tt big">' + V.esc(x.n) + '</span>') +
          '<span class="badges"><span class="badge">Not here</span></span><span class="hl-wish">' + V.icon(w ? 'check' : 'plus') + '<span>' + (w ? 'Wishlist' : 'Wishlist') + '</span></span></div>' +
          '<div class="card-meta"><div class="card-t truncate">' + V.esc(x.n) + '</div><div class="card-s truncate">' + V.esc([x.y, x.t === 'show' ? 'Series' : 'Film'].filter(Boolean).join(' · ')) + '</div></div></button>';
      }
    }
  });

  // ------------------------------------------------------------ the wishlist
  V.route('wishlist', function (view) {
    var tmdbOn = !!S.settings.tmdb;
    var listsOn = tmdbOn; // (list rows need TMDB)
    view.innerHTML = V.pageHead('Wishlist') + '<p class="dim">Films and series that aren’t here yet. When one arrives you get an alert' + (S.data.prefs.wishlistAlerts === false ? ' (they’re off in <a href="#/settings">Settings</a>)' : '') + '.</p>' +
      (tmdbOn ? '<form class="wl-search" role="search"><input class="input" type="search" data-wq placeholder="Search for any film or series" aria-label="Search for any film or series" autocomplete="off"><button class="btn primary">' + V.icon('search') + ' Search</button></form><div class="wl-results" aria-live="polite"></div>'
        : '<p class="note">' + V.icon('info') + ' <span>Searching for any film or series needs a free TMDB key. ' + (S.profile.admin ? 'Add one in <a href="#/admin/recs">Admin → Recommendations</a>.' : 'The admin can add one in Admin → Recommendations.') + (listsOn ? ' Until then, you can add titles that aren’t here from a list row’s “See the whole list” on Home.' : '') + '</span></p>') +
      '<h2 class="wl-h">On your wishlist</h2><div class="wl-list"><div class="spinner"></div></div>';
    var listBox = V.$('.wl-list', view), resBox = V.$('.wl-results', view);
    var wishes = [], results = [];
    var load = function () { return V.api('/api/wishlist').then(function (r) { wishes = r.list; drawList(); }).catch(function (e) { listBox.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; }); };
    var line = function (x, act) {
      return '<div class="wl-item">' + V.art(x.p || (x.k && (V.entry(x.k) || {}).i), x.n, 'art wl-art') + '<div class="grow"><b>' + V.esc(x.n) + '</b> <span class="dim">' + V.esc([x.y || '', x.t === 'show' ? 'Series' : 'Film'].filter(Boolean).join(' · ')) + '</span>' +
        (x.plot ? '<p class="dim small clamp2">' + V.esc(x.plot) + '</p>' : '') + (x.gotAt ? '<p class="ok small">' + V.icon('check', 'tiny') + ' Arrived ' + V.fmtAgo(x.gotAt) + '</p>' : '') + '</div><div class="wl-acts">' + act + '</div></div>';
    };
    function drawList() {
      if (!wishes.length) {
        listBox.innerHTML = '<p class="dim">' + (tmdbOn ? 'Nothing yet. Search above, or add titles that aren’t here from a list row’s “See the whole list” on Home.'
          : listsOn ? 'Nothing yet. Add a row from a list at the bottom of Home, then open its “See the whole list” to add the titles that aren’t here.'
          : 'Nothing yet.') + '</p>';
        return;
      }
      listBox.innerHTML = wishes.map(function (w, i) {
        var it = w.k && V.entry(w.k);
        return line(w, (it ? '<a class="btn primary sm" href="' + V.hrefOf(it) + '">' + V.icon('play') + ' It’s here</a>' : '<span class="chip sm">Waiting</span>') + '<button class="icon-btn sm" data-wdel="' + i + '" aria-label="Remove ' + V.esc(w.n) + ' from your wishlist">' + V.icon('trash') + '</button>');
      }).join('');
    }
    function drawResults(q) {
      if (!results.length) { resBox.innerHTML = '<p class="dim">Nothing found for “' + V.esc(q) + '”.</p>'; return; }
      resBox.innerHTML = '<h2 class="sr-only">Results</h2>' + results.map(function (x, i) {
        var it = x.k && V.entry(x.k);
        var on = wishes.some(function (w) { return w.id === x.wish || (w.tmdb && w.tmdb === x.tmdb); });
        return line(x, it ? '<a class="btn sm" href="' + V.hrefOf(it) + '">' + V.icon('check') + ' Here — open</a>' : on ? '<span class="chip sm on">' + V.icon('check', 'tiny') + ' On your wishlist</span>' : '<button class="btn sm primary" data-wadd="' + i + '">' + V.icon('plus') + ' Add to wishlist</button>');
      }).join('');
    }
    var form = V.$('.wl-search', view);
    if (form) form.onsubmit = function (e) {
      e.preventDefault();
      var q = V.$('[data-wq]', view).value.trim();
      if (q.length < 2) return;
      resBox.innerHTML = '<div class="spinner"></div>';
      V.api('/api/wishlist/search?q=' + encodeURIComponent(q)).then(function (r) { results = r.results; drawResults(q); }).catch(function (er) { resBox.innerHTML = '<p class="err">' + V.esc(er.message) + '</p>'; });
    };
    view.addEventListener('click', function (e) {
      var b = e.target.closest('[data-wadd]');
      if (b) {
        var x = results[+b.getAttribute('data-wadd')];
        b.disabled = true;
        V.api('/api/wishlist', { body: x }).then(function (r) {
          if (r.here) { x.k = r.here; V.toast('It’s already here'); } else { wishes.unshift(r.item); x.wish = r.item.id; V.toast('On your wishlist — you’ll get an alert when it arrives'); drawList(); }
          drawResults('');
          var nb = V.$('[data-wadd]', resBox) || V.$('[data-wq]', view); if (nb) nb.focus();
        }).catch(function (er) { b.disabled = false; V.fail(er); });
      }
      var d = e.target.closest('[data-wdel]');
      if (d) {
        var w = wishes[+d.getAttribute('data-wdel')];
        d.disabled = true; // (a second press would delete it again: "not found")
        V.del('/api/wishlist/' + w.id).then(function () { wishes = wishes.filter(function (y) { return y !== w; }); drawList(); V.toast('Removed from your wishlist'); var f = V.$('[data-wdel]', listBox) || V.$('[data-wq]', view); if (f) f.focus(); }).catch(function (er) { d.disabled = false; V.fail(er); });
      }
    });
    load();
  });

  // ------------------------------------------------------------ alerts: Messages → New for you
  S.alertsUnread = 0;
  var setUnread = function (n) { S.alertsUnread = n || 0; V.updateUnread(); };
  var countAlerts = V.debounce(function () { if (S.profile) V.api('/api/alerts').then(function (r) { setUnread(r.unread); V.emit('alerts', r); }).catch(function () {}); }, 1500);
  // Alerts that came while no device was open: shown once, next time the app opens.
  var takeUnseen = function () {
    V.api('/api/alerts/unseen').then(function (r) {
      setUnread(r.unread);
      var l = r.list || [];
      if (!l.length) return;
      var open = function () { V.router.go('#/messages/alerts'); };
      if (l.length === 1) V.toast(l[0].title + (l[0].body ? ' — ' + l[0].body : ''), { action: { label: 'Open', fn: l[0].k && V.entry(l[0].k) ? function () { V.router.go(V.hrefOf(V.entry(l[0].k))); } : open }, ms: 10000 });
      else V.toast(l.length + ' new things for you: ' + l.slice(0, 3).map(function (a) { return a.title; }).join(' · '), { action: { label: 'See all', fn: open }, ms: 12000 });
    }).catch(function () {});
  };
  var lastPid = null;
  V.on('rt:connected', function () {
    if (!S.profile) return;
    var fresh = lastPid !== S.profile.id;
    lastPid = S.profile.id;
    if (fresh) { takeUnseen(); FOLLOW.at = 0; }
    V.loadHomeLists(fresh);
  });
  V.on('catalog', function () { if (S.profile) V.loadHomeLists(true); });
  (function (orig) { V.notify = function (d) { orig(d); countAlerts(); }; })(V.notify);

  V.alertsPreview = function () { return S.alertsUnread ? V.plural(S.alertsUnread, 'new alert') : 'New episodes and wishlist arrivals'; };
  V.alertsThread = function (thread, done) {
    thread.innerHTML = '<header class="th-h"><a class="icon-btn back-btn" href="#/messages" aria-label="Back">' + V.icon('back') + '</a><span class="avatar sm all">' + V.icon('bell') + '</span><h2>New for you</h2><span class="sp"></span><a class="btn sm" href="#/wishlist">Wishlist</a></header><div class="msgs al-list" role="list"><div class="spinner"></div></div>';
    var box = V.$('.al-list', thread);
    var list = [];
    var draw = function () {
      box.innerHTML = list.length ? list.map(function (a) {
        var it = a.k && V.entry(a.k);
        return '<div class="al' + (a.read ? '' : ' unread') + '" role="listitem">' + V.art(a.i || (it && it.i), a.title, 'art al-art') + '<div class="grow"><b>' + V.esc(a.title) + '</b>' + (a.body ? '<div class="dim small">' + V.esc(a.body) + '</div>' : '') + '<div class="faint small">' + V.fmtAgo(a.at) + '</div></div>' +
          '<div class="al-acts">' + (it ? '<a class="btn sm primary" href="' + V.hrefOf(it) + '">Open</a>' : '') + '<button class="icon-btn sm" data-al-del="' + a.id + '" aria-label="Delete this alert">' + V.icon('x') + '</button></div></div>';
      }).join('') : '<p class="dim center">No alerts yet. You get one when a new episode of a series you watch arrives, or something on your <a href="#/wishlist">wishlist</a>.</p>';
    };
    V.api('/api/alerts').then(function (r) {
      list = r.list; draw();
      if (r.unread) V.api('/api/alerts/read', { body: { all: true } }).then(function (x) { setUnread(x.unread); if (done) done(); }).catch(function () {});
    }).catch(function (e) { box.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-al-del]');
      if (b) V.del('/api/alerts/' + b.getAttribute('data-al-del')).then(function (r) { list = list.filter(function (a) { return a.id !== b.getAttribute('data-al-del'); }); draw(); setUnread(r.unread); }).catch(V.fail);
    });
  };

  // ------------------------------------------------------------ the bell on series pages
  var loadFollow = function () {
    if (FOLLOW.pid === S.profile.id && Date.now() - FOLLOW.at < 10 * 60e3) return Promise.resolve(FOLLOW);
    return V.api('/api/series-follow').then(function (r) { FOLLOW.follow = r.follow; FOLLOW.mute = r.mute; FOLLOW.at = Date.now(); FOLLOW.pid = S.profile.id; return FOLLOW; });
  };
  /** Followed without asking: in My List, or watched in the last 4 months (the server checks those anyway). */
  var autoFollow = function (sk) {
    if (V.inList('list', sk)) return true;
    var since = Date.now() - 120 * 86400e3;
    if (S.data.history.some(function (h) { return h.sk === sk && h.at > since; })) return true;
    var p = S.data.progress;
    return Object.keys(p).some(function (k) { return p[k].sk === sk && p[k].at > since; });
  };
  var stateOf = function (sk) {
    var muted = FOLLOW.mute.indexOf(sk) >= 0, explicit = FOLLOW.follow.indexOf(sk) >= 0;
    return { on: !muted && (explicit || autoFollow(sk)), explicit: explicit, muted: muted, auto: autoFollow(sk) };
  };
  var bellLabel = function (on) { return on ? 'Alerts for new episodes are on' : 'Get an alert for new episodes'; };
  V.bellButton = function (it) {
    if (it.t !== 'show') return '';
    var st = FOLLOW.pid === S.profile.id ? stateOf(it.k) : { on: autoFollow(it.k) };
    if (FOLLOW.pid !== S.profile.id || Date.now() - FOLLOW.at > 10 * 60e3) loadFollow().then(function () { var b = V.$('[data-a=bell]'); if (b) paint(b, stateOf(it.k).on); }).catch(function () {});
    return '<button class="icon-btn lg" data-a="bell" aria-pressed="' + st.on + '" title="' + bellLabel(st.on) + '" aria-label="' + bellLabel(st.on) + '">' + V.icon(st.on ? 'bellf' : 'bell') + '</button>';
  };
  function paint(b, on) { b.innerHTML = V.icon(on ? 'bellf' : 'bell'); b.setAttribute('aria-pressed', String(on)); b.title = bellLabel(on); b.setAttribute('aria-label', bellLabel(on)); }
  V.toggleBell = function (it, b) {
    loadFollow().then(function () {
      var st = stateOf(it.k);
      // On → off: forget an explicit follow, or mute one that's followed because you watch it. Off → on: the reverse.
      var want = st.on ? (st.auto ? false : null) : (st.auto ? null : true);
      return V.put('/api/series-follow/' + encodeURIComponent(it.k), { on: want }).then(function () {
        FOLLOW.follow = FOLLOW.follow.filter(function (x) { return x !== it.k; });
        FOLLOW.mute = FOLLOW.mute.filter(function (x) { return x !== it.k; });
        if (want === true) FOLLOW.follow.push(it.k);
        if (want === false) FOLLOW.mute.push(it.k);
        var on = stateOf(it.k).on;
        paint(b, on);
        V.toast(on ? (S.data.prefs.newEpisodeAlerts === false ? 'Following — but new-episode alerts are off in Settings' : 'You’ll get an alert when a new episode arrives') : 'No alerts for this series');
      });
    }).catch(V.fail);
  };
})();
