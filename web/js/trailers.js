/* Trailers: "Watch the trailer" plays here (not on a new YouTube tab — on a TV there's no coming back from that), and
   a Trailers page: one trailer after another of the films and series on your lists — what's popular first — to flick
   through like short videos and pick something: Play, My List, or its page. Trailers are the provider's, or TMDB's
   (server.js /api/trailers). */
'use strict';

(function () {
  /** A YouTube video id from an id or a link ("https://youtu.be/…", "…watch?v=…"): '' if it isn't one. */
  V.ytId = function (s) {
    var m = /(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/.exec(String(s || '')) || /^([\w-]{11})$/.exec(String(s || '').replace(/^\s+|\s+$/g, ''));
    return m ? m[1] : '';
  };
  var embed = function (id, muted) {
    return 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?autoplay=1&playsinline=1&rel=0&modestbranding=1&iv_load_policy=3&enablejsapi=1' + (muted ? '&mute=1' : '');
  };
  var frame = function (id, muted, title) {
    return '<iframe class="trl-frame" src="' + embed(id, muted) + '" title="' + V.esc(title ? 'Trailer: ' + title : 'Trailer') + '" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>';
  };

  /** "Watch the trailer": in a window here. */
  V.playTrailer = function (tr, title) {
    var id = V.ytId(tr);
    if (!id) return V.toast('There’s no trailer for this one.', { error: true });
    V.dialog({ title: title ? 'Trailer: ' + title : 'Trailer', wide: true, cls: 'trl-dlg', body: '<div class="trl-box">' + frame(id, false, title) + '</div>' });
  };

  // ------------------------------------------------------------ the Trailers page
  // What to show, in order: films and series on your lists, those popular worldwide first (TMDB's popularity, then
  // rating), then the newest added — not ones you've finished or hidden. Films and series take turns (?t= for one).
  var candidates = function (type) {
    var hidden = {};
    ((S.data && S.data.hidden) || []).forEach(function (k) { hidden[k] = 1; });
    var ok = function (x) { var p = S.data && S.data.progress && S.data.progress[x.k]; return !hidden[x.k] && !(p && p.w) && (x.i || x.bd); };
    var rank = function (a, b) { return (b.pp || 0) - (a.pp || 0) || (b.r || 0) - (a.r || 0) || (b.ad || 0) - (a.ad || 0); };
    var mv = type === 'show' ? [] : (S.movies || []).filter(ok).sort(rank).slice(0, 300);
    var sh = type === 'movie' ? [] : (S.shows || []).filter(ok).sort(rank).slice(0, 300);
    var out = [];
    for (var i = 0; i < Math.max(mv.length, sh.length); i++) { if (mv[i]) out.push(mv[i]); if (sh[i]) out.push(sh[i]); }
    return out;
  };

  V.route('trailers', function (view, r) {
    var type = r.q.get('t') === 'movie' ? 'movie' : r.q.get('t') === 'show' ? 'show' : '';
    var list = candidates(type);
    var found = []; // [{ it, v, p }] — titles whose trailer is known, in order
    var asked = 0, cur = 0, busy = null, ended = false;
    var muted = true;
    try { muted = V.ls.get('trl.sound') !== '1'; } catch (e) {}
    view.innerHTML = '<div class="trl">' +
      '<div class="trl-top"><a class="icon-btn" href="#/' + (type === 'show' ? 'series' : 'movies') + '" aria-label="Back">' + V.icon('back') + '</a><h1>Trailers</h1>' +
      '<div class="chips">' + [['', 'All'], ['movie', 'Films'], ['show', 'Series']].map(function (c) { return '<a class="chip' + (c[0] === type ? ' on' : '') + '" href="#/trailers' + (c[0] ? '?t=' + c[0] : '') + '">' + c[1] + '</a>'; }).join('') + '</div></div>' +
      '<div class="trl-stage"><div class="trl-vid"><div class="spinner"></div></div>' +
      '<div class="trl-info"></div>' +
      '<div class="trl-nav"><button class="icon-btn trl-up" data-prev aria-label="Previous trailer">' + V.icon('back') + '</button><button class="icon-btn trl-down" data-next aria-label="Next trailer">' + V.icon('back') + '</button></div></div></div>';
    var vid = V.$('.trl-vid', view), info = V.$('.trl-info', view);
    if (!list.length) { vid.innerHTML = ''; info.innerHTML = V.empty('No trailers yet', 'Films and series with pictures show up here once your lists are loaded.'); return; }

    // Trailers are looked up a few titles at a time, ahead of where you are.
    var more = function () {
      if (busy || ended) return busy;
      var keys = list.slice(asked, asked + 10).map(function (x) { return x.k; });
      asked += keys.length;
      if (!keys.length) { ended = true; return null; }
      busy = V.api('/api/trailers?k=' + encodeURIComponent(keys.join(','))).then(function (res) {
        busy = null;
        keys.forEach(function (k) { var t = res && res[k]; var it = V.entry(k); if (t && t.v && it) found.push({ it: it, v: t.v, p: t.p || '' }); });
        // (Nothing among these: on to the next few, a little way at most.)
        if (found.length <= cur && asked < list.length && asked < 120) return more();
      }, function (e) { busy = null; ended = true; throw e; });
      return busy;
    };

    var show = function () {
      var f = found[cur];
      if (!f) {
        if (ended || asked >= list.length) { vid.innerHTML = ''; info.innerHTML = V.empty('That’s all for now', S.settings.tmdb ? 'No more trailers among your titles.' : 'Trailers come from your provider, or from TMDB once a TMDB key is added (Admin → Recommendations).'); }
        return;
      }
      var it = f.it, mine = V.inList('list', it.k);
      // (Its picture behind, until the video has loaded.)
      vid.style.backgroundImage = it.bd || it.i ? 'url("' + String(it.bd || it.i).replace(/["\\]/g, '') + '")' : '';
      vid.innerHTML = frame(f.v, muted, it.n);
      info.innerHTML = '<div class="trl-t"><h2>' + V.esc(it.n) + '</h2><div class="trl-meta dim">' + [it.y || '', it.t === 'show' ? 'Series' : 'Film', it.r ? '★ ' + it.r : '', (it.gn || []).slice(0, 3).join(', ')].filter(Boolean).map(V.esc).join(' · ') + '</div>' +
        (f.p ? '<p class="trl-plot clamp3">' + V.esc(f.p) + '</p>' : '') + '</div>' +
        '<div class="trl-acts"><button class="btn primary" data-a="play">' + V.icon('play') + ' ' + (it.t === 'show' ? 'Episodes' : 'Play') + '</button>' +
        '<button class="btn" data-a="list" aria-pressed="' + mine + '">' + V.icon(mine ? 'check' : 'plus') + ' My List</button>' +
        '<a class="btn" href="#/title/' + encodeURIComponent(it.k) + '">' + V.icon('info') + ' Details</a>' +
        '<button class="btn" data-a="sound">' + V.icon(muted ? 'mute' : 'vol') + ' ' + (muted ? 'Sound on' : 'Sound off') + '</button></div>' +
        '<div class="trl-count dim">' + (cur + 1) + (ended && found.length ? ' of ' + found.length : '') + '</div>';
      V.$('[data-prev]', view).disabled = cur === 0;
      if (found.length - cur < 4) more();
    };
    var go = function (d) {
      var n = cur + d;
      if (n < 0) return;
      if (n >= found.length) {
        if (ended) return;
        var p = more();
        if (p) p.then(function () { if (found.length > n) { cur = n; show(); } else show(); });
        return;
      }
      cur = n;
      show();
    };

    view.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-next')) return go(1);
      if (b.hasAttribute('data-prev')) return go(-1);
      var f = found[cur];
      if (!f) return;
      var a = b.dataset.a;
      if (a === 'play') { if (f.it.t === 'show') V.router.go('#/title/' + encodeURIComponent(f.it.k)); else { vid.innerHTML = ''; V.play(f.it); } } // (the trailer stops: it used to carry on, with its sound, under the film)
      else if (a === 'list') V.toggle('list', f.it.k).then(function () { show(); });
      else if (a === 'sound') { muted = !muted; try { V.ls.set('trl.sound', muted ? '0' : '1'); } catch (x) {} show(); }
    });
    // Up and down (keys, a remote, the wheel, a swipe) move between trailers.
    var onKey = function (e) {
      if (V.$('dialog[open]') || /^(INPUT|SELECT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '')) return;
      if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.keyCode === 34) { e.preventDefault(); e.stopPropagation(); go(1); }
      else if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.keyCode === 33) { e.preventDefault(); e.stopPropagation(); go(-1); }
    };
    document.addEventListener('keydown', onKey, true);
    var wheelAt = 0;
    var onWheel = function (e) { if (Math.abs(e.deltaY) < 20 || Date.now() - wheelAt < 700) return; wheelAt = Date.now(); e.preventDefault(); go(e.deltaY > 0 ? 1 : -1); };
    var stage = V.$('.trl-stage', view);
    stage.addEventListener('wheel', onWheel, { passive: false });
    var y0 = null;
    stage.addEventListener('touchstart', function (e) { y0 = e.touches[0].clientY; }, { passive: true });
    stage.addEventListener('touchend', function (e) { if (y0 === null) return; var dy = e.changedTouches[0].clientY - y0; y0 = null; if (Math.abs(dy) > 60) go(dy < 0 ? 1 : -1); }, { passive: true });
    V.pageCleanup = function () { document.removeEventListener('keydown', onKey, true); vid.innerHTML = ''; };

    var p = more();
    if (p) p.then(show, function (e) { vid.innerHTML = ''; info.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
  });
})();
