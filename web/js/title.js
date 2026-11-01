/* A movie's or series' page: details, play/resume, seasons and episodes, more like this. */
'use strict';

V.similar = function (it, n) {
  var gn = new Set((it.gn || []).map(function (g) { return g.toLowerCase(); }));
  var pool = it.t === 'show' ? S.shows : S.movies;
  var scored = [];
  for (var i = 0; i < pool.length; i++) {
    var x = pool[i];
    if (x.k === it.k || S.data.hidden.indexOf(x.k) >= 0) continue;
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
  if (!it) { view.innerHTML = V.empty('Not found', 'It may have been removed from the lists.'); return; }
  if (it.t === 'episode') it = V.showOf(it) || it;
  var isShow = it.t === 'show';
  var p = V.progressOf(it.k);
  view.innerHTML = '<article class="title-page">' +
    '<div class="tp-hero" style="--tint:' + V.tint(it.n) + '"><div class="tp-bg">' + (it.bd || it.i ? '<img src="' + V.esc(it.bd || it.i) + '" alt="" referrerpolicy="no-referrer"' + (it.bd ? '' : ' class="blur"') + '>' : '') + '</div>' +
    '<div class="tp-main">' + (it.i ? '<div class="tp-poster">' + V.art(it.i, it.n, 'art') + '</div>' : '') + '<div class="tp-info">' +
    '<div class="dim">' + V.esc(isShow ? 'Series' : 'Movie') + ' · ' + V.esc(it.g) + '</div><h1>' + V.esc(it.n) + '</h1>' +
    '<div class="tp-meta"></div><div class="tp-acts"></div><p class="tp-plot"></p><div class="tp-credits dim"></div><div class="tp-social"></div></div></div></div>' +
    (isShow ? '<section class="tp-eps"><div class="eps-h"><h2>Episodes</h2><select class="input" data-season aria-label="Season" hidden></select></div><div class="eps"><div class="spinner"></div></div></section>' : '') +
    '<section class="tp-bm" hidden></section><div class="tp-more"></div></article>';

  var meta = function (d) {
    var bits = [d.y, d.c ? '<span class="cert">' + V.esc(d.c) + '</span>' : '', d.r ? '★ ' + d.r : '', !isShow && d.d ? V.fmtLen(d.d) : '', isShow && d.ne ? V.plural(d.ne, 'episode') : '', (d.lg || []).map(V.langName).join(', ')].filter(Boolean);
    V.$('.tp-meta', view).innerHTML = bits.join('<span class="dot-sep"></span>') + (d.gn && d.gn.length ? '<div class="tp-genres">' + d.gn.map(function (g) { return '<a class="chip sm" href="#/' + (isShow ? 'series' : 'movies') + '?genre=' + encodeURIComponent(g) + '">' + V.esc(g) + '</a>'; }).join('') + '</div>' : '');
  };
  meta(it);
  var drawActs = function (eps) {
    var html = '';
    if (isShow) {
      var rp = V.resumePoint(it, eps || []);
      html += '<button class="btn primary lg" data-a="play"' + (rp.ep ? '' : ' disabled') + '>' + V.icon('play') + ' ' + V.esc(rp.label) + '</button>';
    } else {
      var resume = p && !p.w && p.p > 20;
      html += '<button class="btn primary lg" data-a="play">' + V.icon('play') + ' ' + (resume ? 'Resume' : 'Play') + '</button>';
      if (resume) html += '<button class="btn lg" data-a="restart">' + V.icon('restart') + ' From the start</button>';
    }
    var inList = V.inList('list', it.k), rate = V.ratingOf(it.k);
    html += '<button class="icon-btn lg" data-a="list" aria-pressed="' + inList + '" title="My List" aria-label="My List">' + V.icon(inList ? 'check' : 'plus') + '</button>' +
      '<button class="icon-btn lg" data-a="up" aria-pressed="' + (rate > 0) + '" title="I like this" aria-label="I like this">' + V.icon(rate > 0 ? 'thumbupf' : 'thumbup') + '</button>' +
      '<button class="icon-btn lg" data-a="down" aria-pressed="' + (rate < 0) + '" title="Not for me" aria-label="Not for me">' + V.icon(rate < 0 ? 'thumbdownf' : 'thumbdown') + '</button>' +
      '<button class="icon-btn lg" data-a="share" title="Send to someone" aria-label="Send to someone">' + V.icon('send') + '</button>' +
      (S.settings.allowParties ? '<button class="icon-btn lg" data-a="party" title="Watch together" aria-label="Watch together">' + V.icon('party') + '</button>' : '') +
      (!isShow && S.settings.allowDownloads ? '<button class="icon-btn lg" data-a="dl" title="Download" aria-label="Download">' + V.icon('download') + '</button>' : '') +
      '<button class="icon-btn lg" data-a="more" title="More" aria-label="More">' + V.icon('dots') + '</button>';
    V.$('.tp-acts', view).innerHTML = html;
  };
  drawActs(S.epsByShow.get(it.k));

  V.$('.tp-acts', view).addEventListener('click', function (e) {
    var b = e.target.closest('[data-a]');
    if (!b) return;
    var a = b.dataset.a;
    if (a === 'play') V.play(it);
    else if (a === 'restart') V.play(it, { startAt: 0 });
    else if (a === 'list') V.toggle('list', it.k).then(function (on) { b.innerHTML = V.icon(on ? 'check' : 'plus'); b.setAttribute('aria-pressed', on); V.toast(on ? 'Added to My List' : 'Removed from My List'); });
    else if (a === 'up' || a === 'down') { var v = a === 'up' ? 1 : -1; var cur = V.ratingOf(it.k); V.rate(it.k, cur === v ? 0 : v); drawActs(it._eps); if (cur !== v) V.toast(v > 0 ? 'Thanks — you’ll see more like this' : 'Got it — you’ll see less like this'); }
    else if (a === 'share') V.shareDialog(it);
    else if (a === 'party') V.party.startDialog(it);
    else if (a === 'dl') V.downloads.start(it);
    else if (a === 'more') V.itemMenu(b, it);
  });

  // Full details from the server (plot, cast, trailer, episodes; TMDB when enabled).
  V.api('/api/item/' + encodeURIComponent(it.k)).then(function (d) {
    Object.keys(d).forEach(function (k) { if (d[k] && !it[k] && ['bd', 'gn', 'c', 'y', 'r', 'd'].indexOf(k) >= 0) it[k] = d[k]; });
    meta(d);
    if (d.bd) { var img = V.$('.tp-bg img', view); if (img) { img.src = d.bd; img.classList.remove('blur'); } else V.$('.tp-bg', view).innerHTML = '<img src="' + V.esc(d.bd) + '" alt="" referrerpolicy="no-referrer">'; }
    V.$('.tp-plot', view).textContent = d.plot || '';
    V.$('.tp-credits', view).innerHTML = (d.cast ? '<div><b>Cast:</b> ' + V.esc(d.cast) + '</div>' : '') + (d.dir ? '<div><b>' + (isShow ? 'Created by' : 'Director') + ':</b> ' + V.esc(d.dir) + '</div>' : '') +
      (d.tr ? '<div><a href="https://www.youtube.com/watch?v=' + encodeURIComponent(d.tr) + '" target="_blank" rel="noopener">' + V.icon('film') + ' Watch the trailer</a></div>' : '');
    if (d.watchedBy && d.watchedBy.length && S.socialCache) {
      var names = d.watchedBy.map(function (id) { var pr = S.socialCache.profiles.filter(function (x) { return x.id === id; })[0]; return pr ? V.avatar(pr.avatar, 'xs') + V.esc(pr.name) : ''; }).filter(Boolean);
      if (names.length) V.$('.tp-social', view).innerHTML = '<span class="dim">Also watched by</span> ' + names.join(' ');
    }
    if (isShow) {
      var eps = (d.episodes || []).map(function (e) { var ex = V.entry(e.k); if (!ex) { S.extra.set(e.k, e); ex = e; } if (e.plot && !ex.plot) ex.plot = e.plot; return ex; });
      it._eps = eps;
      drawEpisodes(eps);
      drawActs(eps);
    }
  }).catch(function (e) { if (isShow) V.$('.eps', view).innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });

  function drawEpisodes(eps) {
    var box = V.$('.eps', view);
    var sel = V.$('[data-season]', view);
    if (!eps.length) { box.innerHTML = '<p class="dim">No episodes found.</p>'; return; }
    var seasons = [];
    eps.forEach(function (e) { if (seasons.indexOf(e.s) < 0) seasons.push(e.s); });
    var rp = V.resumePoint(it, eps);
    var cur = rp.ep ? rp.ep.s : seasons[0];
    sel.innerHTML = seasons.map(function (s) { return '<option value="' + s + '"' + (s === cur ? ' selected' : '') + '>' + (s ? 'Season ' + s : 'Specials') + ' (' + eps.filter(function (e) { return e.s === s; }).length + ')</option>'; }).join('');
    sel.hidden = seasons.length < 2;
    var render = function (s) {
      box.innerHTML = eps.filter(function (e) { return e.s === s; }).map(function (e) {
        var pct = V.pctOf(e.k);
        var img = e.i || it.i;
        return '<div class="ep' + (rp.ep && rp.ep.k === e.k ? ' cur' : '') + '" data-k="' + V.esc(e.k) + '"><button class="ep-play" data-ep="play" aria-label="Play ' + V.esc(V.epLabel(e) + ' ' + (e.et || '')) + '"><span class="ep-n num">' + e.e + '</span><span class="ep-art" style="--tint:' + V.tint(e.n) + '">' + (img ? '<img src="' + V.esc(img) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '') + '<span class="ep-pl">' + V.icon('play') + '</span>' + (pct > 0 && pct < 1 ? '<span class="bar"><i style="width:' + pct * 100 + '%"></i></span>' : '') + '</span></button>' +
          '<div class="ep-body"><div class="ep-t"><b>' + V.esc(e.et || V.epLabel(e)) + '</b>' + (pct >= 1 ? ' ' + V.icon('check', 'tiny ok') : '') + '<span class="dim">' + (e.d ? V.fmtLen(e.d) : '') + '</span></div>' + (e.plot ? '<p class="dim clamp3">' + V.esc(e.plot) + '</p>' : '') + '</div>' +
          '<button class="icon-btn" data-ep="menu" aria-label="More for this episode">' + V.icon('dots') + '</button></div>';
      }).join('');
    };
    render(cur);
    sel.onchange = function () { render(+sel.value); };
    box.onclick = function (e) {
      var row = e.target.closest('[data-k]');
      if (!row) return;
      var ep = V.entry(row.dataset.k);
      var b = e.target.closest('[data-ep]');
      if (b && b.dataset.ep === 'menu') {
        var p2 = V.progressOf(ep.k);
        V.menu(b, [
          { label: 'Play', icon: 'play', fn: function () { V.play(ep); } },
          p2 ? { label: 'Play from the start', icon: 'restart', fn: function () { V.play(ep, { startAt: 0 }); } } : null,
          { label: p2 && p2.w ? 'Mark as not watched' : 'Mark as watched', icon: 'check', fn: function () { if (p2 && p2.w) { V.del('/api/history?k=' + encodeURIComponent(ep.k)).then(function () { delete S.data.progress[ep.k]; render(ep.s); }); } else { V.saveProgress(ep, ep.d || 1, ep.d || 1, true); render(ep.s); } } },
          { label: 'Send to someone…', icon: 'send', fn: function () { V.shareDialog(ep); } },
          S.settings.allowDownloads ? { label: 'Download', icon: 'download', fn: function () { V.downloads.start(ep); } } : null,
          { label: 'Watch together…', icon: 'party', fn: function () { V.party.startDialog(ep); } },
        ]);
      } else V.play(ep);
    };
  }

  // Bookmarks for this title.
  var bms = S.data.bookmarks.filter(function (b) { var x = V.entry(b.k); return b.k === it.k || (x && x.sk === it.k); });
  if (bms.length) {
    var bs = V.$('.tp-bm', view);
    bs.hidden = false;
    bs.innerHTML = '<h2>Your bookmarks</h2><ul class="bms">' + bms.map(function (b) { var x = V.entry(b.k); return '<li><button class="btn sm" data-bm="' + b.id + '">' + V.icon('play') + ' ' + V.fmtDur(b.t) + '</button><span>' + (x && x.t === 'episode' ? '<b>' + V.esc(V.epLabel(x)) + '</b> ' : '') + V.esc(b.note || '') + '</span></li>'; }).join('') + '</ul>';
    bs.onclick = function (e) { var b = e.target.closest('[data-bm]'); if (!b) return; var bm = bms.filter(function (x) { return x.id === b.dataset.bm; })[0]; V.play(V.entry(bm.k), { startAt: bm.t }); };
  }
  var more = V.row({ id: 'similar', title: 'More like this', items: V.similar(it) });
  if (more) V.$('.tp-more', view).appendChild(more);
});
