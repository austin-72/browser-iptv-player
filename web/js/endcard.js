/* When something finishes playing.
   - An episode: the next one with a picture and its story, playing by itself after a countdown (Autoplay, a switch
     right there and in the player's menu), plus Previous, Random episode, All episodes and Watch again. After the
     last episode: Previous, Random, Watch again and the series' page.
   - A film: the next film of its series (TMDB collection) first, then films like it.
   Also: the episodes of a series are fetched as soon as one of its episodes plays, so "next" is known in time (a
   series from an Xtream list only has its episodes once they've been asked for — autoplay used to find nothing). */
'use strict';
(function () {
  var COUNT = 10; // seconds before the next episode plays by itself
  var timer = null;
  var autoplay = function () { return V.pref('autoplayNext') !== false; };
  V.setAutoplay = function (on) { V.setPref('autoplayNext', !!on); V.player.osd(on ? 'Autoplay on' : 'Autoplay off', 1200); };

  // ------------------------------------------------------------ episodes: next, previous, random
  var listOf = function (ep) {
    var show = V.showOf(ep);
    var list = S.epsByShow.get(ep.sk) || [];
    if (show && show._eps && show._eps.length > list.length) list = show._eps;
    return list;
  };
  V.prevEpisode = function (ep) {
    if (!ep || ep.t !== 'episode') return null;
    var list = listOf(ep);
    for (var i = 0; i < list.length; i++) if (list[i].k === ep.k) return list[i - 1] || null;
    var prev = null;
    for (var j = 0; j < list.length; j++) if (list[j].s < ep.s || (list[j].s === ep.s && list[j].e < ep.e)) prev = list[j];
    return prev;
  };
  V.randomEpisode = function (ep) {
    var list = listOf(ep).filter(function (e) { return e.k !== ep.k; });
    if (!list.length) return null;
    var fresh = list.filter(function (e) { var p = V.progressOf(e.k); return !(p && p.w); });
    var pool = fresh.length ? fresh : list;
    return pool[Math.floor(Math.random() * pool.length)];
  };
  V.playPrevEpisode = function () { var it = V.watch.it; if (!it) return; var pv = V.prevEpisode(it); if (pv) V.play(pv, { startAt: 0 }); else if (V.player) V.player.osd('This is the first episode', 1500); };
  // Fetch the series' episodes as soon as one plays (so the next one is known before this one ends).
  V.on('playing', function (it) {
    hide();
    if (it && it.t === 'episode') { var show = V.showOf(it); if (show && V.loadEpisodes) V.loadEpisodes(show).then(function () { if (V.watch.it === it) { var b = V.$('[data-a=next]', V.player.host); if (b) b.hidden = !V.upNext(it); if (V.remotePush) V.remotePush(); } }).catch(function () {}); }
  });
  V.on('stopped', hide);

  // ------------------------------------------------------------ the card
  function box() {
    var host = V.player && V.player.host;
    if (!host) return null;
    var b = V.$('.vp-end', host);
    if (!b) { b = document.createElement('div'); b.className = 'vp-end'; b.hidden = true; var msg = V.$('.vp-msg', host); (msg ? msg.parentNode : host).appendChild(b); }
    // (The viewer plays or seeks the finished title again: the card — and its countdown — goes.)
    var v = V.player.video;
    if (v && !v._endHooked) { v._endHooked = true; var shown = function () { var e2 = V.player && V.$('.vp-end', V.player.host); return e2 && !e2.hidden; }; v.addEventListener('play', function () { if (shown()) hide(); }); v.addEventListener('seeking', function () { if (shown() && !v.ended) hide(); }); }
    return b;
  }
  function hide() { clearInterval(timer); timer = null; var b = V.player && V.player.host && V.$('.vp-end', V.player.host); if (b) { b.hidden = true; b.innerHTML = ''; } }
  V.hideEndCard = hide;
  var sw = function () { return '<label class="ve-auto"><input type="checkbox" data-ve-auto' + (autoplay() ? ' checked' : '') + '><span class="ve-sw" aria-hidden="true"></span><span>Autoplay</span></label>'; };
  var art = function (x, fallback) { return V.art((x && x.i) || (fallback && fallback.i) || '', (x && x.n) || '', 'art'); };
  var focusFirst = function (b) { if (document.activeElement && b.contains(document.activeElement) && document.activeElement !== b) return; var f = V.$('[data-ve-first]', b) || V.$('button', b); if (f && (V.tvMode || V.device.tv || (document.activeElement && V.player.el.contains(document.activeElement)))) f.focus(); };

  /** An episode ended (it: the episode; nx: what plays next, if anything). */
  V.showEpisodeEnd = function (it, nx, o) {
    o = o || {};
    var b = box();
    if (!b) return;
    var show = V.showOf(it) || {};
    var pv = V.prevEpisode(it);
    var rnd = listOf(it).length > 2;
    var queued = nx && nx.queued;
    var head = nx
      ? '<div class="ve-next"><div class="ve-art">' + art(nx, show) + '</div><div class="ve-info"><div class="dim small">' + (queued ? 'Next in your queue' : 'Next episode') + (nx.t === 'episode' ? ' · ' + V.esc(V.epLabel(nx)) : '') + '</div>' +
        '<div class="ve-t">' + V.esc(nx.t === 'episode' ? (nx.et || nx.n) : nx.n) + '</div>' + (nx.plot ? '<p class="ve-plot">' + V.esc(nx.plot) + '</p>' : '') + (nx.d ? '<div class="dim small">' + V.fmtLen(nx.d) + '</div>' : '') + '</div></div>'
      : '<div class="ve-done"><div class="ve-t">That was the last episode' + (show.n ? ' of “' + V.esc(show.n) + '”' : '') + '</div></div>';
    b.innerHTML = '<div class="ve-box"><div class="ve-top"><span class="dim small">' + V.esc(show.n || '') + ' · ' + V.esc(V.epLabel(it)) + ' finished</span><span class="sp"></span>' + (nx ? sw() : '') + '<button class="pbtn" data-ve="x" aria-label="Close">' + V.icon('x') + '</button></div>' + head +
      '<div class="ve-acts">' +
        (nx ? '<button class="btn primary" data-ve="next" data-ve-first>' + V.icon('play') + ' <span class="ve-c">' + (queued ? 'Play next' : 'Next episode') + '</span></button>' : '') +
        (pv ? '<button class="btn" data-ve="prev">' + V.icon('back') + ' Previous episode</button>' : '') +
        (rnd ? '<button class="btn" data-ve="random">' + V.icon('shuffle') + ' Random episode</button>' : '') +
        '<button class="btn" data-ve="episodes">' + V.icon('stack') + ' All episodes</button>' +
        '<button class="btn" data-ve="again"' + (nx ? '' : ' data-ve-first') + '>' + V.icon('restart') + ' Watch again</button>' +
        (!nx && show.k ? '<button class="btn" data-ve="page">Series page</button>' : '') +
      '</div></div>';
    b.hidden = false;
    var left = o.count || COUNT;
    var tick = function () {
      var c = V.$('.ve-c', b);
      if (!c) return;
      // No countdown when Autoplay is off, the viewer said "Not now", left the player (mini) or is choosing an
      // episode themselves — or something else is playing by now.
      var off = !autoplay() || o.noAuto || V.watch.mini || V.watch.side || V.watch.it !== it || b.hidden;
      if (off) { c.textContent = queued ? 'Play next' : 'Next episode'; if (V.watch.it !== it || b.hidden) { clearInterval(timer); timer = null; } return; }
      c.textContent = (queued ? 'Play next' : 'Next episode') + ' in ' + left + ' s';
      if (left-- <= 0) { clearInterval(timer); timer = null; V.autoNext ? V.autoNext(nx) : V.playUpNext(nx); }
    };
    clearInterval(timer);
    if (nx) { tick(); timer = setInterval(tick, 1000); }
    b.onclick = function (e) {
      e.stopPropagation();
      if (V.stillHere) V.stillHere();
      var a = e.target.closest('[data-ve]');
      if (!a) return;
      var w = a.dataset.ve;
      if (w === 'x') { hide(); return; }
      if (w === 'next') { hide(); V.playUpNext(nx); }
      else if (w === 'prev') { hide(); V.play(pv, { startAt: 0 }); }
      else if (w === 'random') { var r = V.randomEpisode(it); hide(); if (r) V.play(r, { startAt: 0 }); }
      else if (w === 'again') { hide(); V.play(it, { startAt: 0 }); }
      else if (w === 'episodes') { V.openSide('episodes'); }
      else if (w === 'page') { V.setMini(true); V.router.go(V.hrefOf(show)); }
    };
    b.onchange = function (e) { if (e.target.hasAttribute('data-ve-auto')) { V.setAutoplay(e.target.checked); tick(); } };
    focusFirst(b);
  };

  /** A film ended: the next film of its series, then others like it. */
  V.showMovieEnd = function (it) {
    var b = box();
    if (!b) return;
    var like = V.similar ? V.similar(it, 12) : [];
    var draw = function (seriesNext, colName) {
      var items = (seriesNext ? [seriesNext] : []).concat(like.filter(function (x) { return !seriesNext || x.k !== seriesNext.k; })).slice(0, 12);
      // (Drawn again when the film's series arrives: a TV viewer already moving along the row keeps their place.)
      var had = document.activeElement && b.contains(document.activeElement) ? document.activeElement.getAttribute('data-k') || document.activeElement.getAttribute('data-ve') : null;
      b.innerHTML = '<div class="ve-box wide"><div class="ve-top"><span class="dim small">“' + V.esc(it.n) + '” finished</span><span class="sp"></span><button class="pbtn" data-ve="x" aria-label="Close">' + V.icon('x') + '</button></div>' +
        (seriesNext ? '<div class="ve-next"><div class="ve-art poster">' + art(seriesNext) + '</div><div class="ve-info"><div class="dim small">Next in ' + V.esc(colName || 'the series') + '</div><div class="ve-t">' + V.esc(seriesNext.n) + '</div>' + (seriesNext.plot ? '<p class="ve-plot">' + V.esc(seriesNext.plot) + '</p>' : '') + (seriesNext.y ? '<div class="dim small">' + seriesNext.y + '</div>' : '') + '</div></div>' : '') +
        (items.length > (seriesNext ? 1 : 0) ? '<div class="dim small ve-h">' + (seriesNext ? 'More like this' : 'You might like') + '</div><div class="ve-row">' + items.filter(function (x) { return !seriesNext || x.k !== seriesNext.k; }).map(function (x) {
          return '<button class="ve-card" data-k="' + V.esc(x.k) + '"><span class="ve-p">' + V.art(x.i, x.n, 'art') + '</span><span class="ve-n truncate">' + V.esc(x.n) + '</span><span class="dim small">' + (x.y || '') + '</span></button>';
        }).join('') + '</div>' : '') +
        '<div class="ve-acts">' + (seriesNext ? '<button class="btn primary" data-ve="play" data-k="' + V.esc(seriesNext.k) + '" data-ve-first>' + V.icon('play') + ' Play “' + V.esc(seriesNext.n) + '”</button>' : '') +
        '<button class="btn" data-ve="again"' + (seriesNext ? '' : ' data-ve-first') + '>' + V.icon('restart') + ' Watch again</button><button class="btn" data-ve="close">Close</button></div></div>';
      b.hidden = false;
      var back = had && (V.$('[data-k="' + had.replace(/"/g, '') + '"]', b) || V.$('[data-ve="' + had.replace(/"/g, '') + '"]', b));
      if (back) back.focus(); else focusFirst(b);
    };
    b.onclick = function (e) {
      e.stopPropagation();
      var c = e.target.closest('[data-k]');
      var a = e.target.closest('[data-ve]');
      if (a && a.dataset.ve === 'x') { hide(); return; }
      if (a && a.dataset.ve === 'close') { hide(); V.closePlayer(); return; }
      if (a && a.dataset.ve === 'again') { hide(); V.play(it, { startAt: 0 }); return; }
      if (c) { var x = V.entry(c.dataset.k); if (x) { hide(); V.play(x, { startAt: V.progressOf(x.k) && !V.progressOf(x.k).w ? V.progressOf(x.k).p : 0 }); } }
    };
    draw(null);
    // Its film series (from TMDB): the first part after this one that's here and not finished.
    if (it.col) V.api('/api/collection/' + encodeURIComponent(it.k)).then(function (c) {
      if (!c || !c.parts || V.watch.it !== it || b.hidden) return;
      var after = false, nx = null;
      c.parts.forEach(function (p) { var x = p.k && V.entry(p.k); if (x && x.k === it.k) after = true; else if (after && !nx && x && V.pctOf(x.k) < 0.9) nx = x; });
      if (nx) draw(nx, c.name);
    }).catch(function () {});
  };

  // ------------------------------------------------------------ the player's menu: Autoplay
  V.playerMenuExtras = (function (prev) {
    return function (p, main, pages) {
      if (prev) prev(p, main, pages);
      if (p.it && p.it.t === 'episode') main.push({ label: 'Autoplay next episode', value: autoplay() ? 'On' : 'Off', fn: function () { V.setAutoplay(!autoplay()); } });
    };
  })(V.playerMenuExtras);
})();
