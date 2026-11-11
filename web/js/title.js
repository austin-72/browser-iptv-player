/* A movie's or series' page: details, play/resume, seasons and episodes, more like this. */
'use strict';

V.similar = function (it, n) {
  var gn = new Set((it.gn || []).map(function (g) { return g.toLowerCase(); }));
  var pool = it.t === 'show' ? S.shows : S.movies;
  var scored = [];
  for (var i = 0; i < pool.length; i++) {
    var x = pool[i];
    if (x.k === it.k || V.inList('hidden', x.k)) continue;
    var s = 0;
    (x.gn || []).forEach(function (g) { if (gn.has(g.toLowerCase())) s += 2; });
    if (x.g === it.g) s += 1.5;
    if (it.y && x.y && Math.abs(it.y - x.y) < 6) s += 0.5;
    if ((x.lg || [])[0] === (it.lg || [])[0]) s += 0.3;
    if (s > 1.5) scored.push([s + (x.r || 0) / 20, x]);
  }
  scored.sort(function (a, b) { return b[0] - a[0]; });
  return scored.slice(0, n || 18).map(function (x) { return x[1]; });
};

V.route('title', function (view, r) {
  var it = V.entry(r.args[0]);
  if (!it) { view.innerHTML = V.empty('Not found', 'It may have been removed from the lists.', '<div class="btn-row empty-acts"><a class="btn" href="#/search">Search</a><a class="btn" href="#/home">Home</a></div>'); return; }
  if (it.t === 'episode') it = V.showOf(it) || it;
  var isShow = it.t === 'show';
  // (Light catalogue: a film's stream address fetched while its page is read, so Play doesn't wait for it.)
  if (!isShow && it.lz && !it.u && V.fetchAddresses) V.fetchAddresses([it.k]).catch(function () {});
  var p = V.progressOf(it.k);
  view.innerHTML = '<article class="title-page">' +
    '<div class="tp-hero" style="--tint:' + V.tint(it.n) + '"><div class="tp-bg">' + (it.bd || it.i ? '<img src="' + V.esc(it.bd || it.i) + '" alt="" referrerpolicy="no-referrer"' + (it.bd ? '' : ' class="blur"') + '>' : '') + '</div>' +
    '<div class="tp-main">' + (it.i ? '<div class="tp-poster">' + V.art(it.i, it.n, 'art') + '</div>' : '') + '<div class="tp-info">' +
    '<div class="dim">' + V.esc(isShow ? 'Series' : 'Movie') + ' · ' + V.esc(V.catLabel ? V.catLabel(it) : it.g) + '</div><h1>' + V.esc(it.n) + '</h1>' +
    (V.newEpsOf(it.k) ? '<div class="tp-new"><span class="badge new">' + V.esc(V.newEpsLabel(it.k)) + '</span></div>' : '') +
    '<div class="tp-meta"></div><div class="tp-acts"></div><p class="tp-plot"></p><div class="tp-credits dim"></div><div class="tp-social"></div></div></div></div>' +
    (isShow ? '<section class="tp-eps"><div class="eps-h"><h2>Episodes</h2><select class="input" data-season aria-label="Season" hidden></select>' + ((S.settings.allowDownloads || S.profile.admin) && !V.device.tv ? '<button class="btn sm" data-a="dlseason" title="Download this season">' + V.icon('download') + ' Season</button>' : '') + '</div><div class="eps"><div class="spinner"></div></div></section>' : '') +
    '<section class="tp-col" hidden></section><section class="tp-bm" hidden></section><div class="tp-more"></div></article>';
  // A poster that doesn't load isn't replaced with initials here — the title is right next to it anyway.
  var pimg = V.$('.tp-poster img', view);
  if (pimg) pimg.addEventListener('error', function () { var pp = V.$('.tp-poster', view); if (pp) pp.hidden = true; });

  var meta = function (d) {
    var bits = [d.y, d.c ? '<span class="cert">' + V.esc(d.c) + '</span>' : '', d.r ? '★ ' + d.r : '', !isShow && d.d ? V.fmtLen(d.d) : '', isShow && d.ne ? V.plural(d.ne, 'episode') : '', (d.lg || []).map(V.langName).join(', '), d.nt || it.nt ? '<span class="note">' + V.esc(d.nt || it.nt) + '</span>' : ''].filter(Boolean);
    V.$('.tp-meta', view).innerHTML = bits.join('<span class="dot-sep"></span>') + (d.gn && d.gn.length ? '<div class="tp-genres">' + d.gn.map(function (g) { return '<a class="chip sm" href="#/' + (isShow ? 'series' : 'movies') + '?genre=' + encodeURIComponent(g) + '">' + V.esc(g) + '</a>'; }).join('') + '</div>' : '');
  };
  meta(it);
  var drawActs = function (eps) {
    var html = '';
    if (isShow) {
      var rp = V.resumePoint(it, eps || []);
      if (rp.ep && V.warmPlay) V.warmPlay(rp.ep);
      html += '<button class="btn primary lg" data-a="play"' + (rp.ep ? '' : ' disabled') + '>' + V.icon('play') + ' ' + V.esc(rp.label) + '</button>';
      if (V.shuffleShow && eps && eps.length > 1) html += '<button class="btn lg" data-a="shuffle">' + V.icon('shuffle') + ' Shuffle</button>';
    } else {
      var resume = p && !p.w && p.p > 20;
      if (V.warmPlay) V.warmPlay(it);
      html += '<button class="btn primary lg" data-a="play">' + V.icon('play') + ' ' + (resume ? 'Resume' : 'Play') + '</button>';
      if (resume) html += '<button class="btn lg" data-a="restart">' + V.icon('restart') + ' From the start</button>';
    }
    // The round buttons: only what's used most (My List, rating, download, new-episode alerts). Queue, Send and Watch
    // together are under More — a long row of icons wrapped onto two or three lines, and was hard to read.
    var inList = V.inList('list', it.k), rate = V.ratingOf(it.k);
    html += '<div class="tp-icons">' +
      '<button class="icon-btn lg" data-a="list" aria-pressed="' + inList + '" title="My List" aria-label="My List">' + V.icon(inList ? 'check' : 'plus') + '</button>' +
      '<button class="icon-btn lg" data-a="up" aria-pressed="' + (rate > 0) + '" title="I like this" aria-label="I like this">' + V.icon(rate > 0 ? 'thumbupf' : 'thumbup') + '</button>' +
      '<button class="icon-btn lg" data-a="down" aria-pressed="' + (rate < 0) + '" title="Not for me" aria-label="Not for me">' + V.icon(rate < 0 ? 'thumbdownf' : 'thumbdown') + '</button>' +
      ((S.settings.allowDownloads || S.profile.admin) && !V.device.tv ? '<button class="icon-btn lg" data-a="dl" title="' + (isShow ? 'Download episodes' : 'Download') + '" aria-label="' + (isShow ? 'Download episodes' : 'Download') + '">' + V.icon('download') + '</button>' : '') +
      (isShow && V.bellButton ? V.bellButton(it) : '') + // (alerts for new episodes: homelists.js)
      '<button class="icon-btn lg" data-a="more" title="More: queue, send, watch together…" aria-label="More">' + V.icon('dots') + '</button></div>';
    // (Drawn again — the episodes arrived, a rating — the button that had the focus keeps it: on a TV it would be lost.)
    var had = document.activeElement && V.$('.tp-acts', view).contains(document.activeElement) ? document.activeElement.getAttribute('data-a') : null;
    V.$('.tp-acts', view).innerHTML = html;
    if (had) { var back = V.$('.tp-acts [data-a="' + had + '"]', view); if (back) back.focus({ preventScroll: true }); }
    // Short names under the round buttons (shown on touch screens and TVs, where there's no hover to explain them).
    var names = { list: 'My List', queue: 'Queue', up: 'Like', down: 'Not for me', share: 'Send', party: 'Together', dl: 'Download', bell: 'Alerts', more: 'More' };
    V.$$('.tp-acts .icon-btn', view).forEach(function (b) { var n = names[b.dataset.a] || b.getAttribute('aria-label') || ''; if (n) b.setAttribute('data-l', n); });
  };
  drawActs(S.epsByShow.get(it.k));

  // (The episode list's "Season" download: that season chosen in the dialog.)
  var dlSeason = V.$('[data-a=dlseason]', view);
  if (dlSeason) dlSeason.addEventListener('click', function () { var s2 = V.$('[data-season]', view); V.downloads.chooseSeries(it, s2 && s2.value !== '' ? +s2.value : undefined); });
  V.$('.tp-acts', view).addEventListener('click', function (e) {
    var b = e.target.closest('[data-a]');
    if (!b) return;
    var a = b.dataset.a;
    if (a === 'play') V.play(it);
    else if (a === 'restart') V.play(it, { startAt: 0 });
    else if (a === 'shuffle') V.shuffleShow(it);
    else if (a === 'list') V.toggle('list', it.k).then(function (on) { b.innerHTML = V.icon(on ? 'check' : 'plus'); b.setAttribute('aria-pressed', on); V.toast(on ? 'Added to My List' : 'Removed from My List'); });
    else if (a === 'up' || a === 'down') { var v = a === 'up' ? 1 : -1; var cur = V.ratingOf(it.k); V.rate(it.k, cur === v ? 0 : v); drawActs(it._eps || S.epsByShow.get(it.k)); if (cur !== v) V.toast(v > 0 ? 'Thanks — you’ll see more like this' : 'Got it — you’ll see less like this'); }
    else if (a === 'share') V.shareDialog(it);
    else if (a === 'party') V.party.startDialog(it);
    else if (a === 'dl') { if (isShow) { var ss = V.$('[data-season]', view); V.downloads.chooseSeries(it, ss && ss.value !== '' ? +ss.value : undefined); } else V.downloads.start(it); }
    else if (a === 'more') V.itemMenu(b, it, { onPage: true });
    else if (a === 'bell' && V.toggleBell) V.toggleBell(it, b);
    else if (a === 'queue') V.queue.menu(b, it);
  });

  // Full details from the server (plot, cast, trailer, episodes; TMDB when enabled).
  V.api('/api/item/' + encodeURIComponent(it.k)).then(function (d) {
    Object.keys(d).forEach(function (k) { if (d[k] && !it[k] && ['bd', 'gn', 'c', 'y', 'r', 'd'].indexOf(k) >= 0) it[k] = d[k]; });
    meta(d);
    if (d.bd) { var img = V.$('.tp-bg img', view); if (img) { img.src = d.bd; img.classList.remove('blur'); } else V.$('.tp-bg', view).innerHTML = '<img src="' + V.esc(d.bd) + '" alt="" referrerpolicy="no-referrer">'; }
    V.$('.tp-plot', view).textContent = d.plot || '';
    var people = function (s) { return String(s).split(',').map(function (x) { x = x.trim(); return x ? '<a href="#/search?q=' + encodeURIComponent(x) + '">' + V.esc(x) + '</a>' : ''; }).filter(Boolean).join(', '); };
    V.$('.tp-credits', view).innerHTML = (d.cast ? '<div><b>Cast:</b> ' + people(d.cast) + '</div>' : '') + (d.dir ? '<div><b>' + (isShow ? 'Created by' : 'Director') + ':</b> ' + people(d.dir) + '</div>' : '') +
      (d.tr && V.ytId(d.tr) ? '<div><button class="linkish" data-trailer>' + V.icon('film') + ' Watch the trailer</button></div>' : '') +
      (S.settings.tmdb && !S.profile.kids ? '<div class="tp-fix"><button class="linkish" data-fix>' + (d.fixed ? 'Details corrected by your household · change' : 'Wrong poster or details?') + '</button></div>' : '');
    var tb = V.$('[data-trailer]', view);
    if (tb) tb.onclick = function () { V.playTrailer(d.tr, it.n); }; // (here, not on a YouTube tab: web/js/trailers.js)
    // No trailer from the provider: TMDB's, when there's one.
    else if (S.settings.tmdb && !V.areaOff('trailers') && (it.t === 'movie' || it.t === 'show')) V.api('/api/trailers?k=' + encodeURIComponent(it.k)).then(function (t) {
      var x = t && t[it.k], cr = V.$('.tp-credits', view);
      if (!x || !x.v || !cr || V.$('[data-trailer]', cr)) return;
      var div = document.createElement('div');
      div.innerHTML = '<button class="linkish" data-trailer>' + V.icon('film') + ' Watch the trailer</button>';
      var fix = V.$('.tp-fix', cr);
      cr.insertBefore(div, fix || null);
      V.$('[data-trailer]', div).onclick = function () { V.playTrailer(x.v, it.n); };
    }).catch(function () {});
    var fx = V.$('[data-fix]', view);
    if (fx) fx.onclick = function () { V.fixDetails(it, d); };
    if (d.col) V.drawCollection(V.$('.tp-col', view), it);
    if (d.watchedBy && d.watchedBy.length && S.socialCache) {
      var names = d.watchedBy.map(function (id) { var pr = S.socialCache.profiles.filter(function (x) { return x.id === id; })[0]; return pr ? V.avatar(pr.avatar, 'xs') + V.esc(pr.name) : ''; }).filter(Boolean);
      if (names.length) V.$('.tp-social', view).innerHTML = '<span class="dim">Also watched by</span> ' + names.join(' ');
    }
    if (isShow) {
      var eps = (d.episodes || []).map(function (e) {
        var ex = V.entry(e.k);
        if (!ex) { S.extra.set(e.k, e); ex = e; }
        if (e.plot && !ex.plot) ex.plot = e.plot;
        // (Each episode's own title, picture and air date from TMDB, when the provider's were missing or plain.)
        if (e.tm && ex !== e) { if (e.et) ex.et = e.et; if (e.i) ex.i = e.i; if (e.air) ex.air = e.air; if (e.d && !ex.d) ex.d = e.d; }
        return ex;
      });
      it._eps = eps;
      if (!eps.length && d.epsError) {
        V.$('.eps', view).innerHTML = '<p class="dim">' + V.esc(d.epsError) + '</p><button class="btn" data-eps-retry>' + V.icon('refresh') + ' Try again</button>';
        V.$('[data-eps-retry]', view).onclick = function () { V.router.refresh(); };
      } else drawEpisodes(eps, d.upcoming || []);
      // What's coming: the next episode's date (TMDB), under the facts at the top.
      if (d.next && d.next.air) V.$('.tp-meta', view).insertAdjacentHTML('beforeend', '<div class="tp-next">' + V.icon('clock', 'tiny') + ' Next episode ' + V.esc(V.epLabel({ t: 'episode', s: d.next.s, e: d.next.e })) + (d.next.et && !/^Episode \d+$/i.test(d.next.et) ? ' “' + V.esc(d.next.et) + '”' : '') + ' — ' + V.esc(V.airsOn(d.next.air)) + '</div>');
      else if (d.ended) V.$('.tp-meta', view).insertAdjacentHTML('beforeend', '<div class="tp-next dim">Series ended</div>');
      drawActs(eps);
      if (typeof drawBookmarks === 'function') drawBookmarks(); // (episode bookmarks, now the episodes are known)
    }
  }).catch(function (e) {
    if (!isShow) return;
    V.$('.eps', view).innerHTML = '<p class="err">' + V.esc(e.message) + '</p><button class="btn" data-eps-retry>' + V.icon('refresh') + ' Try again</button>';
    V.$('[data-eps-retry]', view).onclick = function () { V.router.refresh(); };
  });

  function drawEpisodes(eps, coming) {
    var box = V.$('.eps', view);
    var sel = V.$('[data-season]', view);
    coming = coming || [];
    if (!eps.length) { box.innerHTML = '<p class="dim">No episodes found.</p>'; return; }
    var seasons = [];
    eps.forEach(function (e) { if (seasons.indexOf(e.s) < 0) seasons.push(e.s); });
    // (A season only TMDB knows of yet — coming soon — is listed after the others.)
    coming.forEach(function (c) { if (seasons.indexOf(c.s) < 0) seasons.push(c.s); });
    var rp = V.resumePoint(it, eps);
    var cur = rp.ep ? rp.ep.s : seasons[0];
    sel.innerHTML = seasons.map(function (s) {
      var n = eps.filter(function (e) { return e.s === s; }).length, soon = coming.filter(function (c) { return c.s === s; }).length;
      return '<option value="' + s + '"' + (s === cur ? ' selected' : '') + '>' + (s ? 'Season ' + s : 'Specials') + ' (' + (n ? n + (soon ? ' + ' + soon + ' coming' : '') : soon + ' coming') + ')</option>';
    }).join('');
    sel.hidden = seasons.length < 2;
    // Episodes after the last one here (TMDB's): still to air, or aired and not on the lists yet. Not playable.
    var comingRows = function (s) {
      return coming.filter(function (c) { return c.s === s; }).map(function (c) {
        return '<div class="ep ep-soon" aria-disabled="true"><span class="ep-play"><span class="ep-n num">' + c.e + '</span><span class="ep-art" style="--tint:' + V.tint(it.n) + '">' + (c.i ? '<img src="' + V.esc(c.i) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '') + '<span class="ep-when">' + V.esc(c.out ? 'Not here yet' : V.airsOn(c.air, true)) + '</span></span></span>' +
          '<div class="ep-body"><div class="ep-t"><b>' + (c.et ? '<span class="ep-tn num">' + c.e + ' · </span>' + V.esc(c.et) : V.esc(V.epLabel({ t: 'episode', s: c.s, e: c.e }))) + '</b><span class="dim">' + [c.air ? (c.out ? 'Aired ' + V.epAirDate(c.air) + ' · not on your lists yet' : V.airsOn(c.air)) : 'Date not known yet', c.d ? V.fmtLen(c.d) : ''].filter(Boolean).join(' · ') + '</span></div>' + (c.plot ? '<p class="dim clamp3">' + V.esc(c.plot) + '</p>' : '') + '</div></div>';
      }).join('');
    };
    var render = function (s) {
      box.innerHTML = eps.filter(function (e) { return e.s === s; }).map(function (e) {
        var pct = V.pctOf(e.k);
        var img = e.i || it.i;
        var isNew = V.isNewEpisode(it.k, e.k);
        // (The number before the title shows only on phones, where the number column is hidden: "3 · Low Tide".)
        return '<div class="ep' + (rp.ep && rp.ep.k === e.k ? ' cur' : '') + '" data-k="' + V.esc(e.k) + '"><button class="ep-play" data-ep="play" aria-label="Play ' + V.esc(V.epLabel(e) + ' ' + (e.et || '')) + '"><span class="ep-n num">' + e.e + '</span><span class="ep-art" style="--tint:' + V.tint(e.n) + '">' + (img ? '<img src="' + V.esc(img) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '') + '<span class="ep-pl">' + V.icon('play') + '</span>' + (pct > 0 && pct < 1 ? '<span class="bar"><i style="width:' + pct * 100 + '%"></i></span>' : '') + '</span></button>' +
          '<div class="ep-body"><div class="ep-t"><b>' + (e.et && e.e != null ? '<span class="ep-tn num">' + e.e + ' · </span>' : '') + V.esc(e.et || V.epLabel(e)) + '</b>' + (isNew ? ' <span class="badge new">New</span>' : '') + (pct >= 1 ? ' ' + V.icon('check', 'tiny ok') : '') + '<span class="dim">' + [e.air ? V.epAirDate(e.air) : '', e.d ? V.fmtLen(e.d) : '', e.r ? '★ ' + e.r : ''].filter(Boolean).join(' · ') + '</span></div>' + (e.plot ? '<p class="dim clamp3">' + V.esc(e.plot) + '</p>' : '') + '</div>' +
          '<button class="icon-btn" data-ep="menu" aria-label="More for this episode">' + V.icon('dots') + '</button></div>';
      }).join('') + comingRows(s);
    };
    render(cur);
    sel.onchange = function () { render(+sel.value); };
    box.onclick = function (e) {
      var row = e.target.closest('[data-k]');
      if (row && !V.entry(row.dataset.k)) return;
      if (!row) return;
      var ep = V.entry(row.dataset.k);
      var b = e.target.closest('[data-ep]');
      if (b && b.dataset.ep === 'menu') {
        var p2 = V.progressOf(ep.k);
        V.menu(b, [
          { label: 'Play', icon: 'play', fn: function () { V.play(ep); } },
          p2 ? { label: 'Play from the start', icon: 'restart', fn: function () { V.play(ep, { startAt: 0 }); } } : null,
          { label: p2 && p2.w ? 'Mark as not watched' : 'Mark as watched', icon: 'check', fn: function () { if (p2 && p2.w) { V.del('/api/history?k=' + encodeURIComponent(ep.k)).then(function () { delete S.data.progress[ep.k]; render(ep.s); }); } else { V.saveProgress(ep, ep.d || 1, ep.d || 1, true); render(ep.s); } } },
          { label: 'Send to someone…', icon: 'send', area: 'messages', fn: function () { V.shareDialog(ep); } },
          S.settings.allowDownloads || S.profile.admin ? { label: 'Download', icon: 'download', fn: function () { V.downloads.start(ep); } } : null,
          { label: 'Watch together…', icon: 'party', fn: function () { V.party.startDialog(ep); } },
        ].concat(V.queue && !V.areaOff('queue') ? [{ sep: true }].concat(V.queue.menuItems(ep)) : []));
      } else V.play(ep);
    };
  }

  // Bookmarks for this title (drawn again once a series' episodes are known: theirs are found by the episode).
  var drawBookmarks = function () {
  var bms = S.data.bookmarks.filter(function (b) { var x = V.entry(b.k); return b.k === it.k || (x && x.sk === it.k); });
  if (bms.length) {
    var bs = V.$('.tp-bm', view);
    bs.hidden = false;
    // In order (by episode, then time); bookmarks with nothing to say but the time sit side by side.
    bms = bms.slice().sort(function (a, b) { var xa = V.entry(a.k) || {}, xb = V.entry(b.k) || {}; return ((xa.s || 0) - (xb.s || 0)) || ((xa.e || 0) - (xb.e || 0)) || (a.t - b.t); });
    // (The same moment saved twice shows once.)
    bms = bms.filter(function (b, i) { return !bms.slice(0, i).some(function (o) { return o.k === b.k && Math.abs(o.t - b.t) < 3 && (o.note || '') === (b.note || ''); }); });
    var bare = bms.every(function (b) { var x = V.entry(b.k); return !b.note && !(x && x.t === 'episode'); });
    bs.innerHTML = '<h2>Your bookmarks</h2><ul class="bms' + (bare ? ' bare' : '') + '">' + bms.map(function (b) { var x = V.entry(b.k); return '<li><button class="btn sm" data-bm="' + b.id + '">' + V.icon('play') + ' ' + V.fmtDur(b.t) + '</button><span>' + (x && x.t === 'episode' ? '<b>' + V.esc(V.epLabel(x)) + '</b> ' : '') + V.esc(b.note || '') + '</span></li>'; }).join('') + '</ul>';
    bs.onclick = function (e) { var b = e.target.closest('[data-bm]'); if (!b) return; var bm = bms.filter(function (x) { return x.id === b.dataset.bm; })[0]; V.play(V.entry(bm.k), { startAt: bm.t }); };
  }
  };
  drawBookmarks();
  var more = V.row({ id: 'similar', title: 'More like this', items: V.similar(it) });
  if (more) V.$('.tp-more', view).appendChild(more);
});

// ---------------------------------------------------------------- new episodes
V.newEpsOf = function (sk) { var n = S.data && S.data.newEps && S.data.newEps[sk]; return n && n.n ? n : null; };
V.newEpsLabel = function (sk) { var n = V.newEpsOf(sk); return !n ? '' : n.n > 1 ? n.n + ' new episodes' : 'New episode'; };
V.isNewEpisode = function (sk, k) { var n = V.newEpsOf(sk); return !!(n && n.eps && n.eps.indexOf(k) >= 0); };

// ---------------------------------------------------------------- film series ("Part of the X Collection")
V.drawCollection = function (box, it) {
  V.api('/api/collection/' + encodeURIComponent(it.k)).then(function (c) {
    if (!c || !c.parts || c.parts.length < 2) return;
    box.hidden = false;
    var next = null;
    c.parts.forEach(function (p) { var x = p.k && V.entry(p.k); if (!next && x && V.pctOf(x.k) < 1) next = x; });
    box.innerHTML = '<div class="col-h"><h2>' + V.esc(c.name) + '</h2><span class="dim">' + c.have + ' of ' + c.parts.length + ' here</span><span class="sp"></span>' +
      (next ? '<button class="btn" data-col-next>' + V.icon('play') + ' ' + (V.progressOf(next.k) ? 'Continue the series' : 'Watch in order') + '</button>' : '') + '</div>' +
      '<ol class="col-parts">' + c.parts.map(function (p, i) {
        var x = p.k && V.entry(p.k);
        var cur = x && x.k === it.k;
        var pct = x ? V.pctOf(x.k) : 0;
        var body = '<span class="cp-art" style="--tint:' + V.tint(p.title) + '">' + (p.poster || (x && x.i) ? '<img src="' + V.esc((x && x.i) || p.poster) + '" alt="" loading="lazy" referrerpolicy="no-referrer" data-rm>' : '') + (pct >= 1 ? '<span class="cp-done">' + V.icon('check') + '</span>' : '') + (pct > 0 && pct < 1 ? '<span class="bar"><i style="width:' + pct * 100 + '%"></i></span>' : '') + '</span>' +
          '<span class="cp-n num">' + (i + 1) + '</span><span class="cp-t">' + V.esc(p.title) + '</span><span class="dim small">' + (p.year || (p.released ? '' : 'Coming soon')) + (x ? '' : (p.released ? ' · not in your lists' : '')) + '</span>';
        return '<li class="' + (x ? 'have' : 'missing') + (cur ? ' cur' : '') + '">' + (x ? '<a href="' + V.hrefOf(x) + '">' + body + '</a>' : '<div>' + body + '</div>') + '</li>';
      }).join('') + '</ol>';
    var nb = V.$('[data-col-next]', box);
    if (nb) nb.onclick = function () { V.play(next); };
  }).catch(function () {});
};

// ---------------------------------------------------------------- "Wrong poster or details?"
V.fixDetails = function (it, d) {
  var load = function (dlg, q) {
    var list = V.$('.fix-list', dlg);
    list.innerHTML = '<div class="spinner"></div>';
    V.api('/api/item/' + encodeURIComponent(it.k) + '/matches' + (q ? '?q=' + encodeURIComponent(q) : '')).then(function (r) {
      if (!r.options.length) { list.innerHTML = '<p class="dim">Nothing found. Try another title below.</p>'; return; }
      list.innerHTML = r.options.map(function (o, i) {
        return '<button class="fix-opt' + (o.current ? ' cur' : '') + '" data-i="' + i + '"><span class="fo-art">' + (o.poster ? '<img src="' + V.esc(o.poster) + '" alt="" loading="lazy" referrerpolicy="no-referrer" data-rm>' : '') + '</span><span class="fo-b"><b>' + V.esc(o.title) + '</b> <span class="dim">' + (o.year || '') + ' · ' + (o.type === 'tv' ? 'Series' : 'Movie') + (o.current ? ' · shown now' : '') + '</span>' +
          (o.original && o.original !== o.title ? '<span class="dim small">' + V.esc(o.original) + '</span>' : '') + '<span class="small clamp3">' + V.esc(o.plot || 'No description.') + '</span></span></button>';
      }).join('');
      list.onclick = function (e) {
        var b = e.target.closest('[data-i]');
        if (!b) return;
        var o = r.options[+b.dataset.i];
        save({ id: o.id, type: o.type }, dlg, o.title);
      };
    }).catch(function (e) { list.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
  };
  var save = function (body, dlg, label) {
    V.api('/api/item/' + encodeURIComponent(it.k) + '/match', { body: body }).then(function (r) {
      Object.assign(it, r.item);
      V.toast(body.none ? 'Details removed for everyone' : 'Fixed for everyone — now showing “' + label + '”');
      if (dlg && dlg._finish) dlg._finish();
      V.router.refresh();
    }).catch(V.fail);
  };
  V.dialog({
    title: 'Which one is “' + it.n + '”?', wide: true,
    body: '<p class="dim">Pick the right one and everyone in the household gets the correct poster, description, cast and recommendations.</p><div class="fix-list"></div>' +
      '<form class="inline fix-q"><input class="input" placeholder="Search for another title" value="' + V.esc(it.n) + '"><button class="btn">Search</button></form>',
    actions: [{ label: 'None of these', fn: function (dlg) { save({ none: true }, dlg); } }, { label: 'Cancel' }],
    onOpen: function (dlg) {
      load(dlg);
      V.$('.fix-q', dlg).onsubmit = function (e) { e.preventDefault(); load(dlg, V.$('.fix-q input', dlg).value.trim()); };
    },
  });
};

/** "2008-02-10" → "10 Feb 2008" (an episode's first showing, from TMDB). */
/** "Airs tomorrow", "Airs Thu 12 Nov", "Airs 3 Feb 2027" (short: without "Airs"), from TMDB's "2026-11-12". */
V.airsOn = function (d, short) {
  var m = /^(\d{4})-(\d\d)-(\d\d)/.exec(d || '');
  if (!m) return '';
  var day = new Date(+m[1], +m[2] - 1, +m[3]), now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var n = Math.round((day - today) / 86400e3), txt;
  try {
    if (n === 0) txt = 'today'; else if (n === 1) txt = 'tomorrow';
    else if (n > 1 && n < 7) txt = day.toLocaleDateString(undefined, { weekday: 'long' });
    else txt = day.toLocaleDateString(undefined, n > 0 && n < 300 ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (e) { txt = d; }
  return short ? txt.charAt(0).toUpperCase() + txt.slice(1) : 'Airs ' + txt;
};
V.epAirDate = function (d) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  if (!m) return '';
  try { return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return d; }
};
