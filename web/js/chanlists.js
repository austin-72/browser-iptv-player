/* Your own channel lists: favourites in your order, groups you make ("Sports", "Kids"…), and which group Live TV and
   the guide open on. Kept with the profile's settings, so they follow you to every device. */
'use strict';
(function () {
  var MAX_LISTS = 30, MAX_CH = 500;
  V.myLists = function () { var l = V.pref('chanLists'); return Array.isArray(l) ? l : []; };
  var save = function (lists) { V.setPref('chanLists', lists); };
  var types = function (type) { return type === 'radio' ? ['radio'] : type === 'any' ? ['live', 'radio'] : ['live']; };
  var ofType = function (type) { var ts = types(type); return function (c) { return c && ts.indexOf(c.t) >= 0; }; };

  /** Favourite channels in your order (ones you haven't placed yet go after, newest first). */
  V.favChannels = function (type) {
    var order = V.pref('favOrder') || [];
    var pos = {};
    order.forEach(function (k, i) { pos[k] = i; });
    return S.data.favs.map(V.entry).filter(ofType(type)).sort(function (a, b) {
      var x = pos[a.k], y = pos[b.k];
      if (x === undefined && y === undefined) return 0;
      if (x === undefined) return 1;
      if (y === undefined) return -1;
      return x - y;
    });
  };
  V.myListItems = function (id, type) {
    var l = V.myLists().filter(function (x) { return x.id === id; })[0];
    return l ? l.keys.map(V.entry).filter(ofType(type || 'any')) : [];
  };

  /** Every group a channel list can show: All, Favourites, Recently watched, your lists, then the categories. */
  V.channelGroups = function (type, o) {
    o = o || {};
    var all = type === 'radio' ? S.radio : S.live;
    var out = [{ v: '', l: type === 'radio' ? 'All stations' : 'All channels', n: all.length }, { v: '__fav', l: 'Favourites', n: V.favChannels(type).length }];
    if (o.recent !== false) out.push({ v: '__recent', l: 'Recently watched', n: V.recentChannels().filter(function (c) { return c.t === type; }).length });
    V.myLists().forEach(function (l) { var n = V.myListItems(l.id, type).length; if (n || o.empty) out.push({ v: '__my:' + l.id, l: l.name, n: n, my: true }); });
    // (Smarter categories: under a heading for each kind — networks, genres, sports… — in their order.)
    if (o.cats !== false) {
      var kind = null, smart = V.smart && V.smart.on();
      V.groupList(type).forEach(function (x) {
        if (smart && x.kind !== kind) { kind = x.kind; out.push({ head: V.smart.kindName(kind), kind: kind }); }
        out.push({ v: x.name, l: x.label, n: x.items.length, kind: smart ? x.kind : '' });
      });
    }
    return out;
  };
  /** The channels in one of those groups. */
  V.channelsFor = function (g, type) {
    var all = type === 'radio' ? S.radio : S.live;
    if (!g) return all;
    if (g === '__fav') return V.favChannels(type);
    if (g === '__recent') return V.recentChannels().filter(function (c) { return c.t === type; });
    if (g.indexOf('__my:') === 0) return V.myListItems(g.slice(5), type);
    return all.filter(function (c) { return V.inGroup(c, g); });
  };
  /** Which group Live TV / the guide opens on: your choice (Settings in "My channel lists"), else the last one used. */
  V.startGroup = function (where, remembered) {
    var p = V.pref(where === 'guide' ? 'guideStart' : 'liveStart');
    if (p && p !== '__last') {
      var ok = p === '__fav' || p === '__recent' || (p.indexOf('__my:') === 0 ? V.myLists().some(function (l) { return '__my:' + l.id === p; }) : V.groupItems('live', p).length > 0);
      if (ok) return p;
    }
    // (A provider's category from before smarter categories were turned on: not one of the choices now.)
    if (remembered && V.smart && V.smart.on() && !(V.smart.cfg().keep) && remembered.indexOf('__') !== 0 && !V.smart.isId(remembered)) return '';
    return remembered || '';
  };

  /** "Add to a list" menu for one channel. */
  V.addToChannelList = function (c, anchor) {
    var lists = V.myLists();
    var items = lists.map(function (l) {
      var on = l.keys.indexOf(c.k) >= 0;
      return { label: l.name, checked: on, fn: function () { V.setInChannelList(l.id, c.k, !on); V.toast(on ? 'Removed from ' + l.name : 'Added to ' + l.name); } };
    });
    if (items.length) items.push({ sep: true });
    items.push({ label: 'New list…', icon: 'plus', fn: function () { V.newChannelList([c.k]); } });
    items.push({ label: 'Edit your lists', icon: 'edit', fn: function () { V.router.go('#/mychannels'); } });
    V.menu(anchor, items);
  };
  V.setInChannelList = function (id, k, on) {
    var lists = V.myLists().map(function (l) { return { id: l.id, name: l.name, keys: l.keys.slice() }; });
    var l = lists.filter(function (x) { return x.id === id; })[0];
    if (!l) return;
    var i = l.keys.indexOf(k);
    if (on && i < 0 && l.keys.length < MAX_CH) l.keys.push(k);
    if (!on && i >= 0) l.keys.splice(i, 1);
    save(lists);
  };
  V.newChannelList = function (keys) {
    return V.prompt('Name your list', { placeholder: 'Sports, Kids, Late night…', max: 40, ok: 'Create' }).then(function (name) {
      name = (name || '').trim();
      if (!name) return null;
      var lists = V.myLists().slice();
      if (lists.length >= MAX_LISTS) { V.toast('That’s the most lists you can have (' + MAX_LISTS + ').', { error: true }); return null; }
      var l = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: name, keys: (keys || []).slice(0, MAX_CH) };
      lists.push(l);
      save(lists);
      V.toast('Made “' + name + '”');
      return l;
    });
  };

  // ------------------------------------------------------------ the page to arrange them (#/mychannels)
  V.route('mychannels', function (view) {
    var sel = V.ls.get('mych.sel', '__fav');
    var lists = V.myLists();
    if (sel !== '__fav' && !lists.some(function (l) { return '__my:' + l.id === sel; })) sel = '__fav';
    var startOpts = function (pref) {
      var cur = V.pref(pref) || '__last';
      var opts = [['__last', 'Where I was last time'], ['', 'All channels'], ['__fav', 'Favourites'], ['__recent', 'Recently watched']].concat(lists.map(function (l) { return ['__my:' + l.id, l.name]; })).concat(V.groupList('live').map(function (g) { return [g.name, g.label]; }));
      return opts.map(function (o) { return '<option value="' + V.esc(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + V.esc(o[1]) + '</option>'; }).join('');
    };
    var keysOf = function () { if (sel === '__fav') return V.favChannels('any').map(function (c) { return c.k; }); var l = lists.filter(function (x) { return '__my:' + x.id === sel; })[0]; return l ? l.keys.slice() : []; };
    var draw = function () {
      lists = V.myLists();
      var keys = keysOf();
      var cur = lists.filter(function (x) { return '__my:' + x.id === sel; })[0];
      view.innerHTML = V.pageHead('Your channel lists', '<div class="page-tools"><a class="btn" href="#/live">' + V.icon('tv') + ' Live TV</a></div>') +
        '<p class="dim">Put your favourites in your own order and make lists of your own. They show up in Live TV, the guide, the channel list while you watch and the phone remote.</p>' +
        '<div class="mych">' +
        '<nav class="groups mych-lists" aria-label="Your lists">' +
        '<button class="grp' + (sel === '__fav' ? ' on' : '') + '" data-sel="__fav"><span class="truncate">' + V.icon('heartf', 'tiny') + ' Favourites</span><small>' + V.favChannels('any').length + '</small></button>' +
        lists.map(function (l) { return '<button class="grp' + (sel === '__my:' + l.id ? ' on' : '') + '" data-sel="__my:' + V.esc(l.id) + '"><span class="truncate">' + V.esc(l.name) + '</span><small>' + l.keys.length + '</small></button>'; }).join('') +
        '<button class="btn block" data-new>' + V.icon('plus') + ' New list</button></nav>' +
        '<section class="mych-body">' +
        '<div class="mych-head"><h2>' + V.esc(cur ? cur.name : 'Favourites') + '</h2>' + (cur ? '<button class="btn sm" data-rename>' + V.icon('edit') + ' Rename</button><button class="btn sm danger" data-delete>' + V.icon('trash') + ' Delete list</button>' : '') + '</div>' +
        '<form class="inline mych-add" data-addf><input class="input" type="search" data-q placeholder="Add channels: name or number" aria-label="Find a channel to add"></form><div class="mych-found"></div>' +
        (keys.length ? '<ol class="mych-ch" data-ol>' + keys.map(function (k, i) {
          var c = V.entry(k);
          if (!c) return '';
          return '<li draggable="true" data-k="' + V.esc(k) + '"><span class="num">' + (c.no || '') + '</span>' + V.art(c.i, c.n, 'art sm') + '<span class="truncate">' + V.esc(c.n) + '</span><span class="sp"></span>' +
            '<button class="icon-btn" data-up aria-label="Move ' + V.esc(c.n) + ' up"' + (i === 0 ? ' disabled' : '') + '>' + V.icon('back', 'chev-up') + '</button><button class="icon-btn" data-down aria-label="Move ' + V.esc(c.n) + ' down"' + (i === keys.length - 1 ? ' disabled' : '') + '>' + V.icon('back', 'chev-down') + '</button><button class="icon-btn" data-rm aria-label="Remove ' + V.esc(c.n) + '">' + V.icon('x') + '</button></li>';
        }).join('') + '</ol>' : V.empty(cur ? 'This list is empty' : 'No favourites yet', 'Find channels above to add them.')) +
        '<div class="grid2 mych-start"><label class="field"><span>Live TV opens on</span><select class="input" data-start="liveStart">' + startOpts('liveStart') + '</select></label><label class="field"><span>The TV guide opens on</span><select class="input" data-start="guideStart">' + startOpts('guideStart') + '</select></label></div>' +
        '</section></div>';
    };
    var setKeys = function (keys) {
      if (sel === '__fav') {
        // Favourites: the order is a setting; adding or removing is the heart.
        V.setPref('favOrder', keys);
        return;
      }
      var all = V.myLists().map(function (l) { return { id: l.id, name: l.name, keys: '__my:' + l.id === sel ? keys.slice(0, MAX_CH) : l.keys }; });
      save(all);
    };
    var row = function (k) { return V.$('[data-k="' + (window.CSS && CSS.escape ? CSS.escape(k) : k) + '"]', view); };
    var move = function (k, d) { var keys = keysOf(); var i = keys.indexOf(k), j = i + d; if (i < 0 || j < 0 || j >= keys.length) return; keys.splice(j, 0, keys.splice(i, 1)[0]); setKeys(keys); draw(); var li = row(k), b = li && V.$('[data-' + (d < 0 ? 'up' : 'down') + ']', li); if (b && !b.disabled) b.focus(); else { b = li && V.$('[data-' + (d < 0 ? 'down' : 'up') + ']', li); if (b) b.focus(); } };
    // Channels matching the search box (not ones already in the list).
    var find = function () {
      var qi = V.$('[data-q]', view), box = V.$('.mych-found', view);
      if (!qi || !box) return;
      var q = qi.value.trim(), have = keysOf();
      var found = q ? V.search.find(q, { types: ['live', 'radio'], limit: 12 }).filter(function (c) { return have.indexOf(c.k) < 0; }) : [];
      box.innerHTML = found.map(function (c) { return '<button class="side-ch mych-hit" data-add="' + V.esc(c.k) + '"><span class="num">' + (c.no || '') + '</span>' + V.art(c.i, c.n, 'art sm') + '<span class="truncate">' + V.esc(c.n) + '</span>' + V.icon('plus') + '</button>'; }).join('') +
        (q && !found.length ? '<p class="dim small">No channels match “' + V.esc(q) + '”' + (have.length ? ' (or they’re already in the list)' : '') + '.</p>' : '');
    };
    /** Draws it again after adding a channel: the search stays as it was, so several can be added in a row. */
    var redrawKeepSearch = function () {
      var qi = V.$('[data-q]', view), q = qi ? qi.value : '';
      draw();
      qi = V.$('[data-q]', view);
      if (!qi) return;
      qi.value = q; find();
      var next = V.$('.mych-hit', view);
      (next || qi).focus();
    };
    /** Shows one list, with the focus on its name on the left. */
    var pick = function (v) {
      sel = v; V.ls.set('mych.sel', sel); draw();
      var f = V.$('[data-sel="' + (window.CSS && CSS.escape ? CSS.escape(sel) : sel) + '"]', view); if (f) f.focus();
    };
    draw();
    view.addEventListener('click', function (e) {
      var b;
      if ((b = e.target.closest('[data-sel]'))) { pick(b.dataset.sel); return; }
      if (e.target.closest('[data-new]')) return V.newChannelList([]).then(function (l) { if (l) pick('__my:' + l.id); });
      if (e.target.closest('[data-rename]')) { var cur = V.myLists().filter(function (x) { return '__my:' + x.id === sel; })[0]; if (!cur) return; return V.prompt('Rename the list', { value: cur.name, max: 40, ok: 'Rename' }).then(function (n) { n = (n || '').trim(); if (!n) return; save(V.myLists().map(function (l) { return { id: l.id, name: '__my:' + l.id === sel ? n : l.name, keys: l.keys }; })); pick(sel); }); }
      if (e.target.closest('[data-delete]')) return V.confirm('Delete this list? The channels stay where they are.', { ok: 'Delete', danger: true }).then(function (ok) { if (!ok) return; save(V.myLists().filter(function (l) { return '__my:' + l.id !== sel; })); ['liveStart', 'guideStart'].forEach(function (p) { if (V.pref(p) === sel) V.setPref(p, '__last'); }); pick('__fav'); V.toast('List deleted'); });
      var li = e.target.closest('[data-k]');
      if (li && e.target.closest('[data-up]')) return move(li.dataset.k, -1);
      if (li && e.target.closest('[data-down]')) return move(li.dataset.k, 1);
      if (li && e.target.closest('[data-rm]')) {
        // The focus goes on to the next channel's ×, so a remote can keep going.
        var k0 = li.dataset.k, sib = li.nextElementSibling || li.previousElementSibling, sk = sib && sib.dataset.k;
        var after = function () { draw(); var n = sk && row(sk); var f = (n && V.$('[data-rm]', n)) || V.$('[data-q]', view); if (f) f.focus(); };
        if (sel === '__fav') V.toggle('favs', k0, false).then(after); else { setKeys(keysOf().filter(function (k) { return k !== k0; })); after(); }
        return;
      }
      if ((b = e.target.closest('[data-add]'))) {
        if (b.disabled) return;
        b.disabled = true; // (not added twice by a double click)
        var k = b.dataset.add;
        if (sel === '__fav') V.toggle('favs', k, true).then(function () { var o = keysOf().filter(function (x) { return x !== k; }); o.push(k); V.setPref('favOrder', o); redrawKeepSearch(); }, function () { b.disabled = false; });
        else { var keys = keysOf(); if (keys.indexOf(k) < 0) keys.push(k); setKeys(keys); redrawKeepSearch(); }
      }
    });
    view.addEventListener('change', function (e) { var s = e.target.closest('[data-start]'); if (s) { V.setPref(s.dataset.start, s.value); V.toast('Saved'); } });
    view.addEventListener('submit', function (e) { e.preventDefault(); find(); var h = V.$('.mych-hit', view); if (h) h.focus(); }); // (Enter: to the first match)
    view.addEventListener('input', V.debounce(function (e) { if (e.target.hasAttribute('data-q')) find(); }, 150));
    // Desktop: drag a channel to a new place.
    var dragK = null;
    view.addEventListener('dragstart', function (e) { var li = e.target.closest('[data-k]'); if (!li) return; dragK = li.dataset.k; li.classList.add('dragging'); try { e.dataTransfer.setData('text/plain', dragK); e.dataTransfer.effectAllowed = 'move'; } catch (x) {} });
    view.addEventListener('dragover', function (e) { if (dragK && e.target.closest('[data-ol] [data-k]')) e.preventDefault(); });
    view.addEventListener('drop', function (e) {
      var li = e.target.closest('[data-ol] [data-k]');
      if (!dragK || !li) return;
      e.preventDefault();
      var keys = keysOf().filter(function (k) { return k !== dragK; });
      var r = li.getBoundingClientRect();
      var at = keys.indexOf(li.dataset.k) + (e.clientY > r.top + r.height / 2 ? 1 : 0);
      keys.splice(at < 0 ? keys.length : at, 0, dragK);
      dragK = null;
      setKeys(keys);
      draw();
    });
    view.addEventListener('dragend', function () { dragK = null; });
  });
})();
