/* A movie's or series' page: what it is and Play, then tabs — episodes or bookmarks, details, cast, reviews, more like this. */
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

// The page: a big picture with what it is and what to do, then tabs — Episodes (or, for a film, its bookmarks),
// Details, Cast, Reviews, More like this — one shown at a time, so everything is close to the top.
var tabMemo = {}; // (the tab last chosen on each title's page: Back from a title picked in More like this lands on it again)
V.route('title', function (view, r) {
  var it = V.entry(r.args[0]);
  if (!it) { view.innerHTML = V.empty('Not found', 'It may have been removed from the lists.', '<div class="btn-row empty-acts"><a class="btn" href="#/search">Search</a><a class="btn" href="#/home">Home</a></div>'); return; }
  if (it.t === 'episode') it = V.showOf(it) || it;
  var isShow = it.t === 'show';
  // (Light catalogue: a film's stream address fetched while its page is read, so Play doesn't wait for it.)
  if (!isShow && it.lz && !it.u && V.fetchAddresses) V.fetchAddresses([it.k]).catch(function () {});
  var p = V.progressOf(it.k);
  var TABS = [[isShow ? 'eps' : 'bm', isShow ? 'Episodes' : 'Bookmarks'], ['details', 'Details'], ['cast', 'Cast'], ['reviews', 'Reviews'], ['more', 'More like this']];
  var panel = function (id, html) { return '<section class="tp-panel" data-panel="' + id + '" id="tpp-' + id + '" role="tabpanel" aria-labelledby="tpt-' + id + '" tabindex="-1" hidden>' + html + '</section>'; };
  view.innerHTML = '<article class="title-page tp-a">' +
    '<div class="tp-hero' + (it.bd ? '' : ' no-bd') + '" style="--tint:' + V.tint(it.n) + '"><div class="tp-bg">' + (it.bd || it.i ? '<img src="' + V.esc(it.bd || it.i) + '" alt="" referrerpolicy="no-referrer"' + (it.bd ? '' : ' class="blur"') + '>' : '') + '</div>' +
    '<div class="tp-main">' + (it.i ? '<div class="tp-poster">' + V.art(it.i, it.n, 'art') + '</div>' : '') + '<div class="tp-info">' +
    '<div class="tp-kind">' + V.esc(isShow ? 'Series' : 'Movie') + (V.catLabel && V.catLabel(it) ? ' · ' + V.esc(V.catLabel(it)) : it.g ? ' · ' + V.esc(it.g) : '') + '</div><h1>' + V.esc(it.n) + '</h1>' +
    (V.newEpsOf(it.k) ? '<div class="tp-new"><span class="badge new">' + V.esc(V.newEpsLabel(it.k)) + '</span></div>' : '') +
    '<div class="tp-meta"></div><div class="tp-acts"></div><p class="tp-plot"></p><div class="tp-credits dim"></div><div class="tp-social"></div></div></div></div>' +
    '<div class="tabs tp-tabs" role="tablist" aria-label="About ' + V.esc(it.n) + '">' + TABS.map(function (t) {
      return '<button type="button" class="tab" role="tab" id="tpt-' + t[0] + '" data-tab="' + t[0] + '" aria-controls="tpp-' + t[0] + '" aria-selected="false"' + (t[0] === 'bm' || t[0] === 'cast' || t[0] === 'reviews' ? ' hidden' : '') + '>' + t[1] + '<span class="tab-n"></span></button>';
    }).join('') + '</div>' +
    (isShow ? panel('eps', '<div class="tp-eps"><div class="eps-h"><h2 class="sr-only">Episodes</h2><select class="input" data-season aria-label="Season" hidden></select><span class="tp-order"></span><span class="sp"></span>' + ((S.settings.allowDownloads || S.profile.admin) && !V.device.tv ? '<button class="btn sm" data-a="dlseason" title="Download this season">' + V.icon('download') + ' Season</button>' : '') + '</div><div class="eps"><div class="spinner"></div></div></div><section class="tp-bm" hidden></section>')
      : panel('bm', '<section class="tp-bm" hidden></section>')) +
    panel('details', '<dl class="facts tp-facts"></dl><div class="tp-links"></div>') +
    panel('cast', '<div class="tp-crew"></div><div class="tp-cast-host"></div>') +
    panel('reviews', '<div class="tp-reviews-host"></div>') +
    panel('more', '<section class="tp-col" hidden></section><div class="tp-alike"></div>') +
    '</article>';
  // A poster that doesn't load isn't replaced with initials here — the title is right next to it anyway.
  var pimg = V.$('.tp-poster img', view);
  if (pimg) pimg.addEventListener('error', function () { var pp = V.$('.tp-poster', view); if (pp) pp.hidden = true; });

  // ---- tabs
  var tabsEl = V.$('.tp-tabs', view);
  var tabBtn = function (id) { return V.$('[data-tab="' + id + '"]', tabsEl); };
  var cur = '', wanted = tabMemo[it.k] || '';
  var select = function (id, focus, byUser) {
    var b = tabBtn(id);
    if (!b || b.hidden) return;
    cur = id; tabMemo[it.k] = id;
    if (byUser) wanted = '';
    V.$$('[role=tab]', tabsEl).forEach(function (t) { t.setAttribute('aria-selected', String(t === b)); t.classList.toggle('on', t === b); });
    V.$$('.tp-panel', view).forEach(function (pn) { pn.hidden = pn.dataset.panel !== id; });
    if (focus) b.focus();
    // (A phone: the chosen tab scrolled into the strip's view.)
    if (tabsEl.scrollWidth > tabsEl.clientWidth) tabsEl.scrollLeft = Math.max(0, b.offsetLeft - tabsEl.offsetLeft - (tabsEl.clientWidth - b.offsetWidth) / 2);
    if (id === 'more') loadAlike();
  };
  /** A tab with something in it shows (with how many, when that helps); one with nothing hides. */
  var showTab = function (id, on, n) {
    var b = tabBtn(id);
    if (!b) return;
    b.hidden = !on;
    V.$('.tab-n', b).textContent = on && n ? ' ' + n : '';
    if (!on && cur === id) select(isShow ? 'eps' : 'details');
    // (The tab chosen last time on this page comes back once it has something in it.)
    if (on && wanted === id && cur !== id) select(id);
  };
  tabsEl.addEventListener('click', function (e) { var b = e.target.closest('[role=tab]'); if (b) select(b.dataset.tab, false, true); });
  tabsEl.addEventListener('keydown', function (e) {
    var dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir || V.tvMode) return;
    var list = V.$$('[role=tab]', tabsEl).filter(function (t) { return !t.hidden; }), i = list.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    select(list[(i + dir + list.length) % list.length].dataset.tab, true, true);
  });
  // (With a remote, the tab under the focus is the one shown: no extra press.)
  tabsEl.addEventListener('focusin', function (e) {
    var b = e.target.closest('[role=tab]');
    if (!b || !V.tvMode || b.dataset.tab === cur) return;
    // (Coming down onto the tabs lands on the one showing; moving along them shows each in turn.)
    if (!e.relatedTarget || !tabsEl.contains(e.relatedTarget)) { var on = tabBtn(cur); if (on) { on.focus(); return; } }
    select(b.dataset.tab, false, true);
  });
  view._tpShowTab = showTab;

  var meta = function (d) {
    var bits = [d.y, d.c ? '<span class="cert">' + V.esc(d.c) + '</span>' : '', d.r ? '★ ' + d.r : '', !isShow && d.d ? V.fmtLen(d.d) : '', isShow && d.ne ? V.plural(d.ne, 'episode') : '', (d.lg || []).map(V.langName).join(', '), d.nt || it.nt ? '<span class="note">' + V.esc(d.nt || it.nt) + '</span>' : ''].filter(Boolean);
    V.$('.tp-meta', view).innerHTML = bits.join('<span class="dot-sep"></span>') + (d.gn && d.gn.length ? '<div class="tp-genres">' + d.gn.map(function (g) { var sid = V.smart && V.smart.genreIdOf ? V.smart.genreIdOf(g) : ''; return '<a class="chip sm" href="#/' + (isShow ? 'series' : 'movies') + (sid ? '?g=' + encodeURIComponent(sid) : '?genre=' + encodeURIComponent(g)) + '">' + V.esc(g) + '</a>'; }).join('') + '</div>' : '');
  };
  meta(it);

  // ---- what to do: Play (saying what it plays, with how far in), then everything else with its name on it
  var trailer = null; // (a YouTube address, once known: the provider's or TMDB's)
  var pill = function (a, icon, label, pressed, extra) { return '<button type="button" class="tp-pill" data-a="' + a + '"' + (pressed !== undefined ? ' aria-pressed="' + pressed + '"' : '') + (extra || '') + '>' + V.icon(icon) + '<span>' + label + '</span></button>'; };
  var drawActs = function (eps) {
    var html = '<div class="tp-primary">';
    var bar = function (pct) { return pct > 0 && pct < 1 ? '<span class="tp-bar" aria-hidden="true"><i style="width:' + Math.round(pct * 100) + '%"></i></span>' : ''; };
    if (isShow) {
      var rp = V.resumePoint(it, eps || []);
      if (rp.ep && V.warmPlay) V.warmPlay(rp.ep);
      var pe = rp.ep ? V.progressOf(rp.ep.k) : null;
      html += '<button class="btn primary lg tp-play" data-a="play"' + (rp.ep ? '' : ' disabled') + '>' + V.icon('play') + '<span class="tp-pl"><span>' + V.esc(rp.label) + '</span>' + bar(rp.ep ? V.pctOf(rp.ep.k) : 0) + '</span></button>';
      if (V.shuffleShow && eps && eps.length > 1) html += '<button class="btn lg" data-a="shuffle">' + V.icon('shuffle') + ' Shuffle</button>';
      if (pe && !pe.w && pe.d && pe.p > 20) html += '<span class="tp-left">' + V.esc(V.fmtLeft(pe.d - pe.p)) + (rp.ep.et ? ' in “' + V.esc(rp.ep.et) + '”' : '') + '</span>';
    } else {
      var resume = p && !p.w && p.p > 20;
      if (V.warmPlay) V.warmPlay(it);
      html += '<button class="btn primary lg tp-play" data-a="play">' + V.icon('play') + '<span class="tp-pl"><span>' + (resume ? 'Resume' + (p.d ? ' · ' + V.esc(V.fmtLeft(p.d - p.p)) : '') : 'Play') + '</span>' + bar(resume ? V.pctOf(it.k) : 0) + '</span></button>';
      if (resume) html += '<button class="btn lg" data-a="restart">' + V.icon('restart') + ' From the start</button>';
    }
    html += '</div>';
    // Each with its name (it used to be a row of round icons): only what's used most; Queue, Send and Watch together
    // are under More.
    var inList = V.inList('list', it.k), rate = V.ratingOf(it.k);
    html += '<div class="tp-pills">' +
      pill('list', inList ? 'check' : 'plus', inList ? 'In My List' : 'My List', inList) +
      pill('up', rate > 0 ? 'thumbupf' : 'thumbup', rate > 0 ? 'Liked' : 'Like', rate > 0) +
      pill('down', rate < 0 ? 'thumbdownf' : 'thumbdown', 'Not for me', rate < 0) +
      (trailer ? pill('trailer', 'film', 'Trailer') : '') +
      ((S.settings.allowDownloads || S.profile.admin) && !V.device.tv ? pill('dl', 'download', 'Download', undefined, isShow ? ' aria-label="Download episodes"' : '') : '') +
      (isShow && V.bellButton ? V.bellButton(it, true) : '') + // (alerts for new episodes: homelists.js)
      pill('more', 'dots', 'More', undefined, ' aria-haspopup="menu" title="Queue, send, watch together…"') + '</div>';
    // (Drawn again — the episodes arrived, a rating — the button that had the focus keeps it: on a TV it would be lost.)
    var had = document.activeElement && V.$('.tp-acts', view).contains(document.activeElement) ? document.activeElement.getAttribute('data-a') : null;
    V.$('.tp-acts', view).innerHTML = html;
    if (had) { var back = V.$('.tp-acts [data-a="' + had + '"]', view); if (back) back.focus({ preventScroll: true }); }
  };
  drawActs(S.epsByShow.get(it.k));

  // (The episode list's "Season" download: that season chosen in the dialog.)
  var dlSeason = V.$('[data-a=dlseason]', view);
  if (dlSeason) dlSeason.addEventListener('click', function () { var s2 = V.$('[data-season]', view); V.downloads.chooseSeries(it, s2 && s2.value !== '' ? +s2.value : undefined); });
  V.$('.tp-acts', view).addEventListener('click', function (e) {
    var b = e.target.closest('[data-a]');
    if (!b) return;
    var a = b.dataset.a;
    var again = function () { drawActs(it._eps || S.epsByShow.get(it.k)); };
    if (a === 'play') V.play(it);
    else if (a === 'restart') V.play(it, { startAt: 0 });
    else if (a === 'shuffle') V.shuffleShow(it);
    else if (a === 'list') V.toggle('list', it.k).then(function (on) { again(); V.toast(on ? 'Added to My List' : 'Removed from My List'); });
    else if (a === 'up' || a === 'down') { var v = a === 'up' ? 1 : -1; var was = V.ratingOf(it.k); V.rate(it.k, was === v ? 0 : v); again(); if (was !== v) V.toast(v > 0 ? 'Thanks — you’ll see more like this' : 'Got it — you’ll see less like this'); }
    else if (a === 'trailer' && trailer) V.playTrailer(trailer, it.n);
    else if (a === 'share') V.shareDialog(it);
    else if (a === 'party') V.party.startDialog(it);
    else if (a === 'dl') { if (isShow) { var ss = V.$('[data-season]', view); V.downloads.chooseSeries(it, ss && ss.value !== '' ? +ss.value : undefined); } else V.downloads.start(it); }
    else if (a === 'more') V.itemMenu(b, it, { onPage: true });
    else if (a === 'bell' && V.toggleBell) V.toggleBell(it, b);
    else if (a === 'queue') V.queue.menu(b, it);
  });

  // ---- Details: the basics here, TMDB's facts added by titlemore.js (view._tpFacts)
  var baseFacts = [];
  var drawFacts = function () {
    var rows = baseFacts.concat(view._tpFacts || []);
    V.$('.tp-facts', view).innerHTML = rows.map(function (x) { return '<div><dt>' + x[0] + '</dt><dd>' + x[1] + '</dd></div>'; }).join('');
  };
  view._tpDrawFacts = drawFacts;
  var factsOf = function (d) {
    var out = [];
    if (!isShow && d.d) out.push(['Length', V.esc(V.fmtLen(d.d))]);
    if (isShow && d.ne) out.push(['Here', V.esc(V.plural(d.ne, 'episode'))]);
    if (d.lg && d.lg.length) out.push(['Language', V.esc(d.lg.map(V.langName).join(', '))]);
    if (d.c) out.push(['Age rating', V.esc(d.c)]);
    if (it.g) out.push(['In your lists under', V.esc(it.g)]);
    if (it.ad) { try { out.push(['Added', V.esc(new Date(it.ad * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))]); } catch (e) {} }
    return out;
  };
  baseFacts = factsOf(it); drawFacts();

  // Full details from the server (plot, cast, trailer, episodes; TMDB when enabled).
  V.api('/api/item/' + encodeURIComponent(it.k)).then(function (d) {
    Object.keys(d).forEach(function (k) { if (d[k] && !it[k] && ['bd', 'gn', 'c', 'y', 'r', 'd'].indexOf(k) >= 0) it[k] = d[k]; });
    meta(d);
    if (d.bd) { var img = V.$('.tp-bg img', view); if (img) { img.src = d.bd; img.classList.remove('blur'); } else V.$('.tp-bg', view).innerHTML = '<img src="' + V.esc(d.bd) + '" alt="" referrerpolicy="no-referrer">'; V.$('.tp-hero', view).classList.remove('no-bd'); }
    V.$('.tp-plot', view).textContent = d.plot || '';
    baseFacts = factsOf(Object.assign({}, it, d)); drawFacts();
    var people = function (s, max) { return String(s).split(',').map(function (x) { return x.trim(); }).filter(Boolean).slice(0, max || 99).map(function (x) { return '<a href="#/search?q=' + encodeURIComponent(x) + '">' + V.esc(x) + '</a>'; }).join(', '); };
    // One short line under the story (all of them are on the Cast tab): who made it, who's in it.
    V.$('.tp-credits', view).innerHTML = [d.dir ? '<span class="tp-made">' + (isShow ? 'Created by ' : 'Directed by ') + people(d.dir, 2) + '</span>' : '', d.cast ? '<span class="tp-star">Starring ' + people(d.cast, 3) + '</span>' : ''].filter(Boolean).join('<span class="dot-sep"></span>');
    // The Cast tab, from the provider's names until TMDB's (with faces) come.
    if (d.cast || d.dir) {
      V.$('.tp-crew', view).innerHTML = d.dir ? '<p><b>' + (isShow ? 'Created by' : 'Director') + ':</b> ' + people(d.dir) + '</p>' : '';
      V.$('.tp-cast-host', view).innerHTML = d.cast ? '<p class="tp-cast-plain">' + people(d.cast) + '</p>' : '';
      showTab('cast', true);
    }
    var links = V.$('.tp-links', view);
    if (S.settings.tmdb && !S.profile.kids) links.innerHTML = '<button class="linkish" data-fix>' + (d.fixed ? 'Details corrected by your household · change' : 'Wrong poster or details?') + '</button>';
    var fx = V.$('[data-fix]', view);
    if (fx) fx.onclick = function () { V.fixDetails(it, d); };
    if (d.tr && V.ytId(d.tr)) { trailer = d.tr; drawActs(it._eps || S.epsByShow.get(it.k)); }
    // No trailer from the provider: TMDB's, when there's one.
    else if (S.settings.tmdb && !V.areaOff('trailers') && (it.t === 'movie' || it.t === 'show')) V.api('/api/trailers?k=' + encodeURIComponent(it.k)).then(function (t) {
      var x = t && t[it.k];
      if (!x || !x.v || trailer || !V.$('.tp-acts', view)) return;
      trailer = x.v; drawActs(it._eps || S.epsByShow.get(it.k));
    }).catch(function () {});
    // Its logo, the cast with faces, who made it, facts, release dates, what viewers wrote (TMDB): titlemore.js.
    if (V.titleMore) V.titleMore(view, it, d);
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
      drawBookmarks(); // (episode bookmarks, now the episodes are known)
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

  // Bookmarks for this title: under the episodes for a series, in their place (their own tab) for a film. Drawn
  // again once a series' episodes are known: theirs are found by the episode.
  function drawBookmarks() {
    var bs = V.$('.tp-bm', view);
    if (!bs) return;
    var bms = S.data.bookmarks.filter(function (b) { var x = V.entry(b.k); return b.k === it.k || (x && x.sk === it.k); });
    if (!bms.length) { bs.hidden = true; if (!isShow) showTab('bm', false); return; }
    bs.hidden = false;
    // In order (by episode, then time); bookmarks with nothing to say but the time sit side by side.
    bms = bms.slice().sort(function (a, b) { var xa = V.entry(a.k) || {}, xb = V.entry(b.k) || {}; return ((xa.s || 0) - (xb.s || 0)) || ((xa.e || 0) - (xb.e || 0)) || (a.t - b.t); });
    // (The same moment saved twice shows once.)
    bms = bms.filter(function (b, i) { return !bms.slice(0, i).some(function (o) { return o.k === b.k && Math.abs(o.t - b.t) < 3 && (o.note || '') === (b.note || ''); }); });
    var bare = bms.every(function (b) { var x = V.entry(b.k); return !b.note && !(x && x.t === 'episode'); });
    bs.innerHTML = '<h2' + (isShow ? '' : ' class="sr-only"') + '>Your bookmarks</h2><ul class="bms' + (bare ? ' bare' : '') + '">' + bms.map(function (b) { var x = V.entry(b.k); return '<li><button class="btn sm" data-bm="' + b.id + '">' + V.icon('play') + ' ' + V.fmtDur(b.t) + '</button><span>' + (x && x.t === 'episode' ? '<b>' + V.esc(V.epLabel(x)) + '</b> ' : '') + V.esc(b.note || '') + '</span></li>'; }).join('') + '</ul>';
    bs.onclick = function (e) { var b = e.target.closest('[data-bm]'); if (!b) return; var bm = bms.filter(function (x) { return x.id === b.dataset.bm; })[0]; V.play(V.entry(bm.k), { startAt: bm.t }); };
    if (!isShow) showTab('bm', true, bms.length);
  }
  drawBookmarks();

  // ---- More like this: everything here that's alike (TMDB's picks, then by genre, makers, cast…: lib/alike.js),
  // and under it "More": what's like those, and so on — each press goes one step further out.
  var alike = null;
  function loadAlike() {
    if (alike) return;
    var host = V.$('.tp-alike', view);
    alike = { shown: [it.k], last: [] };
    host.innerHTML = '<div class="spinner"></div>';
    var here = function () { return document.documentElement.contains(host); };
    var take = function (keys) {
      var items = keys.map(V.entry).filter(function (x) { return x && (x.t === 'movie' || x.t === 'show') && !V.inList('hidden', x.k) && alike.shown.indexOf(x.k) < 0; });
      items.forEach(function (x) { alike.shown.push(x.k); });
      if (items.length) alike.last = items.map(function (x) { return x.k; });
      return items;
    };
    // (The server's answer, topped up with the same kind of guess made here when it has only a few.)
    var ask = function (body, fallback) {
      return V.api('/api/alike', { body: body }).then(function (r) {
        var keys = (r && r.keys) || [];
        return keys.length >= 24 ? keys : keys.concat(fallback().filter(function (k) { return keys.indexOf(k) < 0; }));
      }).catch(function () { return fallback(); });
    };
    // (Made here: by genres and category.)
    var localOf = function (seeds) {
      var out = [];
      seeds.forEach(function (k) { var x = V.entry(k); if (x) V.similar(x, 40).forEach(function (y) { if (out.indexOf(y.k) < 0) out.push(y.k); }); });
      return out;
    };
    ask({ k: it.k }, function () { return localOf([it.k]); }).then(function (keys) {
      if (!here()) return;
      var items = take(keys);
      if (!items.length) { host.innerHTML = '<p class="dim">Nothing in your lists is much like this.</p>'; return; }
      host.innerHTML = '<div class="grid poster tp-alike-grid" data-list></div><div class="tp-alike-more"><button class="btn" data-alike-more>' + V.icon('plus') + ' More</button><span class="dim small">Like the ones above</span></div>';
      var g = V.$('.tp-alike-grid', host);
      g._items = items;
      g.innerHTML = items.map(function (x) { return V.card(x); }).join('');
      var btn = V.$('[data-alike-more]', host);
      btn.onclick = function () {
        if (btn.disabled) return;
        var hadFocus = document.activeElement === btn;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner sm"></span> Finding more';
        ask({ keys: alike.last.slice(0, 24), skip: alike.shown }, function () { return localOf(alike.last.slice(0, 12)); }).then(function (more) {
          if (!here()) return;
          var add = take(more);
          if (!add.length) { V.$('.tp-alike-more', host).innerHTML = '<p class="dim">That’s everything alike.</p>'; return; }
          var first = g.children.length;
          g.insertAdjacentHTML('beforeend', add.map(function (x) { return V.card(x); }).join(''));
          g._items = g._items.concat(add);
          btn.disabled = false;
          btn.innerHTML = V.icon('plus') + ' More';
          if (hadFocus && g.children[first]) g.children[first].focus();
        });
      };
    });
  }

  // The first tab: the one chosen last time on this page, else Episodes (a series), Bookmarks (a film with some),
  // else Details.
  var first = isShow ? 'eps' : !tabBtn('bm').hidden ? 'bm' : 'details';
  select(wanted && tabBtn(wanted) && !tabBtn(wanted).hidden ? wanted : first);
  // (Until the remembered tab has something in it — the cast and reviews come a moment later — it isn't forgotten.)
  if (wanted && cur !== wanted) tabMemo[it.k] = wanted;
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
