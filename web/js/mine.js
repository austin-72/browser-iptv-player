/* "My stuff": My List, favourite channels, bookmarks, shared lists and watch history. */
'use strict';
V.route('mine', function (view, r) {
  var tab = r.args[0] || 'list';
  if ((tab === 'queue' && V.areaOff('queue')) || (tab === 'week' && V.areaOff('viewing'))) tab = 'list'; // (switched off by the admin)
  var tabs = [{ v: 'list', l: 'My List' }].concat(V.queue && !V.areaOff('queue') ? [{ v: 'queue', l: 'Queue' + (V.queue.list().length ? ' (' + V.queue.list().length + ')' : '') }] : [], [{ v: 'favs', l: 'Favourite channels' }, { v: 'bookmarks', l: 'Bookmarks' }, { v: 'shared', l: 'Shared lists' }, { v: 'history', l: 'History' }], V.areaOff('viewing') ? [] : [{ v: 'week', l: 'Your week' }]);
  view.innerHTML = V.pageHead('My stuff') + '<div class="tabs" role="tablist">' + tabs.map(function (t) { return '<a role="tab" class="tab' + (t.v === tab ? ' on' : '') + '" aria-selected="' + (t.v === tab) + '" href="#/mine/' + t.v + '">' + t.l + '</a>'; }).join('') + '</div><div class="tab-body"></div>';
  var body = V.$('.tab-body', view);
  if (tab === 'list') {
    // Recently played first, then recently added (or liked) — or as chosen here (kept on this device).
    var lo = V.ls.get('myListOrder', '') || ((S.settings.smart || {}).listOrder || 'played');
    var items = V.myListOrdered ? V.myListOrdered(lo) : S.data.list.map(V.entry).filter(Boolean);
    body.innerHTML = '<div class="page-tools"><label class="sel"><span class="sr-only">Order</span><select class="input" data-lo>' + [['played', 'Recently played'], ['added', 'Recently added'], ['az', 'A–Z']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === lo ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label></div><div class="grid-host"></div>';
    V.$('[data-lo]', body).onchange = function (e) { V.ls.set('myListOrder', e.target.value); V.router.refresh(); };
    V.grid(V.$('.grid-host', body), items, { empty: '<h2>Your list is empty</h2><p>Use ' + V.icon('plus', 'tiny') + ' on any movie or series to save it here.</p><div class="btn-row empty-acts"><a class="btn" href="#/movies">Browse movies</a><a class="btn" href="#/series">Browse series</a></div>' });
  } else if (tab === 'queue' && V.queue && !V.areaOff('queue')) {
    V.queue.render(body);
  } else if (tab === 'favs') {
    var favs = S.data.favs.map(V.entry).filter(Boolean);
    if (!favs.length) body.innerHTML = V.empty('No favourite channels', 'Use the heart on a channel to add it.', '<div class="btn-row empty-acts"><a class="btn" href="#/live">Go to Live TV</a></div>');
    else { body.innerHTML = '<div class="ch-list" data-list></div>'; var box = V.$('.ch-list', body); box._items = favs; box.innerHTML = favs.map(V.channelRow).join(''); box.onclick = function (e) { var f = e.target.closest('[data-fav]'); if (f) { e.preventDefault(); V.toggle('favs', f.dataset.fav).then(function () { V.router.refresh(); }); return; } var row = e.target.closest('[data-k]'); if (row) { e.preventDefault(); V.play(V.entry(row.dataset.k), { list: favs }); } }; }
  } else if (tab === 'week' && !V.areaOff('viewing')) {
    body.innerHTML = '<div class="spinner"></div>';
    V.api('/api/me/week').then(function (w) {
      var days = w.days.slice(-7), prev = w.days.slice(0, 7);
      var sum = function (a, k) { return a.reduce(function (t, d) { return t + (d[k || 's'] || 0); }, 0); };
      var tot = sum(days), before = sum(prev);
      var max = Math.max.apply(null, days.map(function (d) { return d.s; }).concat([1]));
      var h = function (sec) { return sec >= 3600 ? (sec / 3600).toFixed(sec >= 36000 ? 0 : 1) + ' h' : Math.round(sec / 60) + ' min'; };
      var kinds = [['movie', 'Films'], ['episode', 'Series'], ['live', 'Live TV'], ['other', 'Other']].filter(function (k) { return sum(days, k[0]) > 0; });
      body.innerHTML = '<section class="card-sec week"><h2>' + (tot ? h(tot) + ' watched in the last 7 days' : 'Nothing watched in the last 7 days') + '</h2>' +
        (before ? '<p class="dim">' + (tot >= before ? h(tot - before) + ' more' : h(before - tot) + ' less') + ' than the week before.</p>' : '') +
        '<div class="week-bars" role="img" aria-label="Time watched per day">' + days.map(function (d) {
          var dt = new Date(d.day + 'T12:00:00');
          return '<div class="wb"><span class="wb-v num">' + (d.s ? h(d.s) : '') + '</span><span class="wb-bar"><i style="height:' + Math.round(d.s / max * 100) + '%"></i></span><span class="wb-d">' + dt.toLocaleDateString([], { weekday: 'short' }) + '</span></div>';
        }).join('') + '</div>' +
        (kinds.length ? '<p>' + kinds.map(function (k) { return '<span class="chip">' + k[1] + ': ' + h(sum(days, k[0])) + '</span>'; }).join(' ') + '</p>' : '') +
        (w.top.length ? '<h3>Most watched</h3><ol class="week-top">' + w.top.map(function (t) { var it = V.entry(t.k); return '<li>' + (it ? '<a href="' + V.hrefOf(it) + '">' + V.esc(it.n) + '</a>' : V.esc(t.n)) + ' <span class="dim">· ' + h(t.s) + '</span></li>'; }).join('') + '</ol>' : '') + '</section>';
    }).catch(function (e) { body.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
  } else if (tab === 'bookmarks') {
    var bms = S.data.bookmarks;
    body.innerHTML = bms.length ? '<ul class="bm-list">' + bms.map(function (b) {
      var it = V.entry(b.k);
      var show = it && it.t === 'episode' ? V.showOf(it) : null;
      return '<li data-id="' + V.esc(b.id) + '">' + V.art(it ? it.i || (show || {}).i : '', b.n, 'art bm-art') + '<div class="bm-b"><b>' + V.esc(show ? show.n + ' · ' + V.epLabel(it) : (it ? it.n : b.n)) + '</b><span class="dim">at ' + V.fmtDur(b.t) + ' · ' + V.fmtAgo(b.at) + '</span>' + (b.note ? '<p>' + V.esc(b.note) + '</p>' : '') + '</div>' +
        '<div class="bm-acts">' + (it ? '<button class="btn sm primary" data-bm="play">' + V.icon('play') + ' Play</button>' : '<span class="dim">No longer available</span>') + '<button class="icon-btn" data-bm="note" aria-label="Edit note">' + V.icon('edit') + '</button><button class="icon-btn" data-bm="share" aria-label="Send to someone">' + V.icon('send') + '</button><button class="icon-btn" data-bm="del" aria-label="Delete">' + V.icon('trash') + '</button></div></li>';
    }).join('') + '</ul>' : V.empty('No bookmarks yet', 'While watching, press ' + V.icon('bookmark', 'tiny') + ' (or B) to bookmark a moment and add a note.');
    body.onclick = function (e) {
      var b = e.target.closest('[data-bm]'); if (!b) return;
      var id = b.closest('[data-id]').dataset.id;
      var bm = S.data.bookmarks.filter(function (x) { return x.id === id; })[0];
      var it = V.entry(bm.k);
      if (b.dataset.bm === 'play') V.play(it, { startAt: bm.t });
      else if (b.dataset.bm === 'note') V.prompt('Note', { value: bm.note, max: 500 }).then(function (n) { if (n !== null) { V.editBookmark(id, n); V.router.refresh(); } });
      else if (b.dataset.bm === 'share' && it) V.shareDialog(it, { pos: bm.t });
      else if (b.dataset.bm === 'del') { V.removeBookmark(id); V.router.refresh(); }
    };
  } else if (tab === 'shared') {
    V.loadSharedLists().then(function (soc) {
      var names = {};
      soc.profiles.forEach(function (p) { names[p.id] = p; });
      body.innerHTML = '<div class="page-tools"><button class="btn" data-new>' + V.icon('plus') + ' New shared list</button></div>' + (soc.lists.length ? '' : V.empty('No shared lists', 'Shared lists are watchlists everyone in the household can add to — “Movie night”, “Kids’ favourites”…'));
      soc.lists.forEach(function (l) {
        var items = l.items.map(function (x) { return V.entry(x.k); }).filter(Boolean);
        var sec = document.createElement('section');
        sec.className = 'shared-list';
        var owner = names[l.owner];
        sec.innerHTML = '<div class="row-h"><h2>' + V.esc(l.name) + '</h2><span class="dim">' + (owner ? 'by ' + V.esc(owner.name) + ' · ' : '') + V.plural(items.length, 'title') + '</span><span class="sp"></span>' + (l.owner === S.profile.id || S.profile.admin ? '<button class="icon-btn" data-l-ren="' + V.esc(l.id) + '" aria-label="Rename">' + V.icon('edit') + '</button><button class="icon-btn" data-l-del="' + V.esc(l.id) + '" aria-label="Delete list">' + V.icon('trash') + '</button>' : '') + '</div><div class="grid-host"></div>';
        body.appendChild(sec);
        if (items.length) V.grid(V.$('.grid-host', sec), items); else V.$('.grid-host', sec).innerHTML = '<p class="dim">Add titles with the “…” menu on any movie or series.</p>';
      });
      body.onclick = function (e) {
        var b;
        if (e.target.closest('[data-new]')) V.prompt('Name the shared list', { placeholder: 'Movie night', max: 60 }).then(function (n) { if (n) V.api('/api/lists', { body: { name: n } }).then(function () { V.router.refresh(); }).catch(V.fail); });
        else if ((b = e.target.closest('[data-l-del]'))) V.confirm('Delete this shared list for everyone?', { ok: 'Delete', danger: true }).then(function (ok) { if (ok) V.del('/api/lists/' + encodeURIComponent(b.dataset.lDel)).then(function () { V.router.refresh(); }).catch(V.fail); });
        else if ((b = e.target.closest('[data-l-ren]'))) V.prompt('Rename', { max: 60, value: ((b.closest('section') && V.$('h2', b.closest('section'))) || {}).textContent || '' }).then(function (n) { if (n) V.put('/api/lists/' + encodeURIComponent(b.dataset.lRen), { name: n }).then(function () { V.router.refresh(); }).catch(V.fail); });
      };
    }).catch(function (e) { body.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
  } else if (tab === 'history') {
    var paused = !!S.data.prefs.historyPaused;
    // Episodes of not-yet-opened Xtream shows are fetched in the background; wait for that first.
    if (S.warming && S.data.history.some(function (h) { return !V.entry(h.k) && h.sk; }) && !S._histWaited) {
      S._histWaited = true;
      body.innerHTML = '<div class="center"><span class="spinner"></span></div>';
      S.warming.then(function () { if (document.body.dataset.page === 'mine') V.router.refresh(); });
      return;
    }
    // Everything you've watched or started, newest first: history plus anything with a saved place.
    var prog = S.data.progress;
    var seenK = {};
    var hist = [];
    S.data.history.forEach(function (h) { if (!seenK[h.k]) { seenK[h.k] = 1; hist.push({ k: h.k, sk: h.sk, n: h.n, at: Math.max(h.at, (prog[h.k] || {}).at || 0), s: h.s }); } });
    Object.keys(prog).forEach(function (k) { if (!seenK[k]) { seenK[k] = 1; hist.push({ k: k, sk: prog[k].sk, n: prog[k].n, at: prog[k].at, s: 0 }); } });
    hist = hist.filter(function (h) { return V.entry(h.k) || (h.sk && S.byKey.get(h.sk)); }).sort(function (a, b) { return b.at - a.at; }).slice(0, 400);
    body.innerHTML = '<div class="page-tools"><label class="check"><input type="checkbox" data-pause' + (paused ? ' checked' : '') + '><span>Pause watch history (nothing new is remembered or used for recommendations)</span></label><span class="sp"></span><button class="btn danger" data-clear>Clear all history</button></div>' +
      (hist.length ? '<ul class="hist">' + hist.map(function (h, i) {
        var it = V.entry(h.k);
        if (!it) { var sh = S.byKey.get(h.sk); it = { k: sh.k, n: h.n || sh.n, t: 'show', i: sh.i }; }
        var show = it.t === 'episode' ? V.showOf(it) : null;
        var p = prog[h.k];
        var state = '', pct = 0;
        if (p && p.w) { state = 'Finished'; pct = 1; }
        else if (p && p.d) { pct = Math.min(1, p.p / p.d); state = Math.round(pct * 100) + '% · ' + V.fmtLen(Math.max(0, p.d - p.p)) + ' left'; }
        var bits = [show ? V.epLabel(it) + (it.et ? ' · ' + it.et : '') : V.TYPE_NAMES[it.t], state, V.fmtAgo(h.at)].filter(Boolean);
        return '<li data-i="' + i + '">' + V.art(it.i || (show || {}).i, it.n, 'art hist-art') + '<div class="hist-b"><b>' + V.esc(show ? show.n : it.n) + '</b><span class="dim">' + V.esc(bits.join(' · ')) + '</span>' +
          (pct > 0 && pct < 1 ? '<span class="bar"><i style="width:' + Math.round(pct * 100) + '%"></i></span>' : '') + '</div>' +
          '<button class="btn sm" data-h="play" aria-label="' + (pct > 0 && pct < 1 ? 'Resume' : 'Play') + '">' + V.icon('play') + (pct > 0 && pct < 1 ? ' Resume' : '') + '</button><button class="icon-btn" data-h="del" aria-label="Remove from history">' + V.icon('x') + '</button></li>';
      }).join('') + '</ul>' : V.empty('Nothing watched yet', 'Things you watch (or start) show up here.'));
    V.$('[data-pause]', body).onchange = function (e) { V.setPref('historyPaused', e.target.checked); V.toast(e.target.checked ? 'History paused' : 'History on'); };
    V.$('[data-clear]', body).onclick = function () { V.confirm('Clear your whole watch history, progress and searches? Recommendations start over.', { ok: 'Clear', danger: true }).then(function (ok) { if (!ok) return; V.del('/api/history').then(function () { S.data.history = []; S.data.progress = {}; S.data.searches = []; V.router.refresh(); }).catch(V.fail); }); }; // (not cleared: say so)
    body.addEventListener('click', function (e) {
      var b = e.target.closest('[data-h]'); if (!b) return;
      var h = hist[+b.closest('[data-i]').dataset.i];
      if (b.dataset.h === 'play') { var e2 = V.entry(h.k); if (e2) V.play(e2); else if (h.sk && S.byKey.get(h.sk)) V.router.go(V.hrefOf(S.byKey.get(h.sk))); }
      else V.del('/api/history?k=' + encodeURIComponent(h.k)).then(function () { S.data.history = S.data.history.filter(function (x) { return x.k !== h.k; }); delete S.data.progress[h.k]; V.router.refresh(); }).catch(V.fail);
    });
  }
});
