/* Watching: the full-screen player layer, mini player, skip intro, up next, channel zapping, side panels and keys. */
'use strict';

V.watch = { it: null, list: null, mini: false };

/** Plays an item. opts: { startAt, list (for channel up/down), resume: true|false (ask), party, quiet } */
V.play = function (it, opts) {
  if (it && it.k) V.ls.session('playedHere', it.k);
  opts = opts || {};
  if (!it) return;
  // "Play on the TV" mode (Remote): send it there instead.
  if (V.playOnTarget && V.playOnTarget(it, opts)) return;
  if (it.t === 'show') return V.loadEpisodes(it).then(function (eps) { var r = V.resumePoint(it, eps); if (r.ep) V.play(r.ep, Object.assign({}, opts, { startAt: r.pos })); else V.toast('No episodes found', { error: true }); }).catch(V.fail);
  // Episodes fetched on demand (Xtream) live only in the server's memory: after a server restart, have it fetch
  // the show's episodes again before playing (once per show per page load).
  if (it.t === 'episode' && it.sk && S.extra && S.extra.has(it.k) && !opts._checked && !(V._epsOk || (V._epsOk = {}))[it.sk]) {
    return V.api('/api/item/' + encodeURIComponent(it.k)).catch(function (e) {
      if (e.status === 404) return V.api('/api/show/' + encodeURIComponent(it.sk) + '/episodes');
    }).then(function () { V._epsOk[it.sk] = 1; V.play(it, Object.assign({}, opts, { _checked: true })); }, function () { V.play(it, Object.assign({}, opts, { _checked: true })); });
  }
  var p = V.progressOf(it.k);
  var startAt = opts.startAt;
  if (startAt === undefined) startAt = p && !p.w && p.p > 20 && (it.t === 'movie' || it.t === 'episode') ? Math.max(0, p.p - 5) : 0;
  var layer = V.$('#player-layer');
  layer.hidden = false;
  document.body.classList.add('watching');
  V.watch.it = it;
  if (opts.list) V.watch.list = opts.list;
  else if (it.t === 'live' || it.t === 'radio') V.watch.list = V.watch.list && V.watch.list.indexOf(it) >= 0 ? V.watch.list : (it.t === 'live' ? S.live : S.radio);
  V.setMini(opts.mini === true ? true : false);
  if (it.t === 'live' || it.t === 'radio') V.watch.lastChannel = V.watch.channel && V.watch.channel !== it ? V.watch.channel : V.watch.lastChannel, V.watch.channel = it;
  V.player.load(it, { startAt: startAt });
  V.watch.upnextDismissed = false;
  V.watch.skipped = {};
  V.$('[data-a=next]', V.player.host).hidden = it.t !== 'episode' || !V.nextEpisode(it);
  V.$('[data-a=episodes]', V.player.host).hidden = it.t !== 'episode';
  V.$('[data-a=channels]', V.player.host).hidden = !(it.t === 'live' || it.t === 'radio' || it.t === 'catchup');
  V.$('[data-a=bookmark]', V.player.host).hidden = !(it.t === 'movie' || it.t === 'episode');
  V.$('[data-a=party]', V.player.host).hidden = !S.settings.allowParties || it.t === 'catchup';
  V.closeSide();
  if (it.t === 'live' || it.t === 'radio') V.showLiveCard(true);
  V.rt.presence({ k: it.t === 'catchup' ? it.catchupOf : it.k, n: it.n, pos: startAt });
  if (!opts.party && V.party && V.party.current && V.party.current.k !== it.k && !opts.fromParty) V.party.changeItem(it);
  if (!opts.mini) setTimeout(function () { V.player.el.focus(); }, 50);
  V.emit('playing', it);
};

V.closePlayer = function () {
  if (V.party && V.party.current) V.party.leave();
  V.player.stop();
  V.$('#player-layer').hidden = true;
  document.body.classList.remove('watching', 'mini-playing');
  V.watch.it = null;
  V.rt.presence(null);
  if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
  document.title = (S.settings.brand || {}).name || document.title;
  V.emit('stopped');
  if (V.router) V.router.refresh();
};

V.setMini = function (on) {
  V.watch.mini = !!on;
  var layer = V.$('#player-layer');
  layer.classList.toggle('mini', !!on);
  document.body.classList.toggle('mini-playing', !!on && !layer.hidden);
  document.body.classList.toggle('watching', !on && !layer.hidden);
  if (on && document.fullscreenElement) document.exitFullscreen().catch(function () {});
  if (!on) setTimeout(function () { V.player.el.focus(); }, 30);
};

// ---------------------------------------------------------------- live info card & zapping
V.showLiveCard = function (auto) {
  var it = V.watch.it;
  var box = V.$('.vp-live', V.player.host);
  if (!it || (it.t !== 'live' && it.t !== 'radio')) { box.hidden = true; return; }
  var nn = V.epg.nowNext(it);
  var pct = nn.now ? V.clamp((Date.now() - nn.now.s) / (nn.now.e - nn.now.s), 0, 1) : 0;
  box.innerHTML = '<div class="lc-logo">' + V.art(it.i, it.n, 'art') + '</div><div class="lc-body"><div class="lc-ch"><b class="num">' + (it.no || '') + '</b> ' + V.esc(it.n) + '</div>' +
    (nn.now ? '<div class="lc-now">' + V.esc(nn.now.t) + '</div><div class="lc-time">' + V.fmtClock(nn.now.s) + ' – ' + V.fmtClock(nn.now.e) + ' · ' + V.fmtLeft((nn.now.e - Date.now()) / 1000) + '</div><div class="bar"><i style="width:' + pct * 100 + '%"></i></div>' : '<div class="lc-now dim">No guide information</div>') +
    (nn.next ? '<div class="lc-next">Next ' + V.fmtClock(nn.next.s) + ' · ' + V.esc(nn.next.t) + '</div>' : '') + '</div>' +
    (V.catchup.available(it) && nn.now ? '<button class="btn sm" data-a="restart">' + V.icon('restart') + ' Start over</button>' : '');
  box.hidden = false;
  clearTimeout(V.watch.liveT);
  V.watch.liveT = setTimeout(function () { box.hidden = true; }, auto ? 6000 : 8000);
};

V.zap = function (dir) {
  var it = V.watch.it;
  var list = V.watch.list || S.live;
  if (!it || !list.length) return;
  var cur = it.t === 'catchup' ? V.entry(it.catchupOf) : it;
  var i = list.indexOf(cur);
  var next = list[(i + dir + list.length) % list.length];
  if (next) V.play(next, { list: list });
};
V.zapTo = function (num) {
  var list = V.watch.list && V.watch.list[0] && V.watch.list[0].t === 'radio' ? V.watch.list : S.live;
  var hit = list.filter(function (c) { return c.no === num; })[0] || S.live.filter(function (c) { return c.no === num; })[0];
  if (hit) V.play(hit); else V.player.osd('No channel ' + num, 1500);
};
V.previousChannel = function () { if (V.watch.lastChannel) V.play(V.watch.lastChannel); };

// ---------------------------------------------------------------- skip intro / credits & up next
V.watchTick = function (pos, tot) {
  var p = V.player, it = V.watch.it;
  if (!it || !p.vod) return;
  var skip = V.$('.vp-skip', p.host);
  var m = p.markers;
  var showSkip = null;
  if (m && m.intro && pos >= m.intro.start - 0.5 && pos < m.intro.end - 1.5) showSkip = { kind: 'intro', to: m.intro.end, label: 'Skip intro' };
  if (m && m.credits && pos >= m.credits.start && pos < m.credits.end - 2) {
    var nx = it.t === 'episode' ? V.nextEpisode(it) : null;
    showSkip = { kind: 'credits', to: m.credits.end, label: nx ? 'Next episode' : 'Skip credits', next: nx };
  }
  if (showSkip && !V.watch.skipped[showSkip.kind]) {
    var auto = showSkip.kind === 'intro' ? V.pref('autoSkipIntro') : V.pref('autoSkipCredits');
    if (auto) { V.watch.skipped[showSkip.kind] = true; doSkip(showSkip); return; }
    if (skip.hidden || skip.dataset.kind !== showSkip.kind) {
      skip.hidden = false; skip.dataset.kind = showSkip.kind;
      skip.innerHTML = V.icon(showSkip.next ? 'skipnext' : 'ff') + '<span>' + showSkip.label + '</span>';
      skip.onclick = function (e) { e.stopPropagation(); V.watch.skipped[showSkip.kind] = true; V.watch.skipped.byUser = true; V.stillHere(); skip.hidden = true; doSkip(showSkip); };
      if (V.device.tv) skip.focus();
    }
  } else if (!skip.hidden) skip.hidden = true;

  // Up next: in the last 25 s of an episode (or when credits start).
  if (it.t === 'episode' && tot > 60 && !V.watch.upnextDismissed && V.pref('autoplayNext') !== false) {
    var startAt = m && m.credits ? m.credits.start : tot - 25;
    if (pos >= startAt && pos < tot) V.showUpNext(Math.ceil(Math.min(15, tot - pos)));
  }
  function doSkip(s) {
    if (s.next) { if (V.watch.skipped.byUser) V.play(s.next, { startAt: 0 }); else V.autoNext(s.next); return; }
    p.seek(s.to);
  }
};

V.showUpNext = function (secs) {
  var it = V.watch.it;
  var nx = V.nextEpisode(it);
  var box = V.$('.vp-upnext', V.player.host);
  if (!nx) return;
  if (box.hidden) {
    box.hidden = false;
    box.innerHTML = '<div class="un-art">' + V.art(nx.i || (V.showOf(nx) || {}).i, nx.n, 'art') + '</div><div class="un-body"><div class="dim small">Up next · ' + V.esc(V.epLabel(nx)) + '</div><div class="un-t">' + V.esc(nx.et || nx.n) + '</div>' +
      '<div class="un-acts"><button class="btn primary" data-un="play">' + V.icon('play') + ' <span class="un-c">Play now</span></button><button class="btn" data-un="x">Not now</button></div></div>';
    box.onclick = function (e) {
      var b = e.target.closest('[data-un]');
      if (!b) return;
      e.stopPropagation();
      V.stillHere();
      if (b.dataset.un === 'play') V.play(nx, { startAt: 0 }); else { V.watch.upnextDismissed = true; box.hidden = true; }
    };
    if (V.device.tv) V.$('[data-un=play]', box).focus();
  }
  var c = V.$('.un-c', box);
  if (c) c.textContent = 'Play in ' + Math.max(0, secs) + ' s';
};

V.onEnded = function () {
  var it = V.watch.it;
  if (V._sleepAt === -1) { V._sleepAt = 0; V.toast('Sleep timer: stopped'); return; }
  if (it && it.t === 'episode' && V.pref('autoplayNext') !== false && !V.watch.upnextDismissed) {
    var nx = V.nextEpisode(it);
    if (nx) return V.autoNext(nx);
  }
  if (it && (it.t === 'movie' || it.t === 'episode')) V.player._msg({ title: 'Finished', sub: it.n, actions: [{ label: 'Watch again', fn: function () { V.play(it, { startAt: 0 }); } }, { label: 'Close', primary: true, fn: V.closePlayer }] });
};

// ---------------------------------------------------------------- side panels (episodes, channels, party)
V.closeSide = function () { var s = V.$('.vp-side', V.player.host); s.hidden = true; s.innerHTML = ''; V.watch.side = null; };
V.openSide = function (kind) {
  var side = V.$('.vp-side', V.player.host);
  if (V.watch.side === kind) return V.closeSide();
  V.watch.side = kind;
  side.hidden = false;
  var it = V.watch.it;
  var head = function (t) { return '<header><h3>' + V.esc(t) + '</h3><button class="pbtn" data-side-x aria-label="Close">' + V.icon('x') + '</button></header>'; };
  side.onclick = function (e) { if (e.target.closest('[data-side-x]')) { e.stopPropagation(); V.closeSide(); } };
  if (kind === 'episodes') {
    var show = V.showOf(it);
    side.innerHTML = head(show ? show.n : 'Episodes') + '<div class="side-list"><div class="spinner"></div></div>';
    V.loadEpisodes(show).then(function (eps) {
      var list = V.$('.side-list', side);
      if (!list) return;
      list.innerHTML = eps.map(function (e) { var pct = V.pctOf(e.k); return '<button class="side-ep' + (e.k === it.k ? ' on' : '') + '" data-k="' + V.esc(e.k) + '"><span class="num">' + V.esc(V.epLabel(e)) + '</span><span class="truncate">' + V.esc(e.et || e.n) + '</span>' + (pct ? '<i class="bar"><b style="width:' + pct * 100 + '%"></b></i>' : '') + '</button>'; }).join('');
      list.onclick = function (ev) { var b = ev.target.closest('[data-k]'); if (b) { ev.stopPropagation(); V.play(V.entry(b.dataset.k)); } };
      var on = V.$('.on', list); if (on) on.scrollIntoView({ block: 'center' });
      var f = on || V.$('button', list); if (f) f.focus();
    }).catch(V.fail);
  } else if (kind === 'channels') {
    var list = V.watch.list || S.live;
    var cur = it.t === 'catchup' ? V.entry(it.catchupOf) : it;
    side.innerHTML = head('Channels') + '<input class="input side-filter" placeholder="Filter channels" aria-label="Filter channels"><div class="side-list"></div>';
    var render = function (q) {
      var nq = V.norm(q);
      var rows = list.filter(function (c) { return !nq || V.norm(c.n).indexOf(nq) >= 0 || String(c.no) === q; }).slice(0, 400);
      V.$('.side-list', side).innerHTML = rows.map(function (c) { var nn = V.epg.nowNext(c); return '<button class="side-ch' + (c === cur ? ' on' : '') + '" data-k="' + V.esc(c.k) + '"><span class="num">' + (c.no || '') + '</span>' + V.art(c.i, c.n, 'art sm') + '<span class="sc-t"><span class="truncate">' + V.esc(c.n) + '</span><small class="truncate dim">' + V.esc(nn.now ? nn.now.t : c.g) + '</small></span></button>'; }).join('');
    };
    render('');
    V.$('.side-filter', side).addEventListener('input', function (e) { render(e.target.value); });
    V.$('.side-list', side).onclick = function (ev) { var b = ev.target.closest('[data-k]'); if (b) { ev.stopPropagation(); V.play(V.entry(b.dataset.k), { list: list }); } };
    var on = V.$('.side-list .on', side); if (on) { on.scrollIntoView({ block: 'center' }); on.focus(); }
  } else if (kind === 'party') {
    if (V.party) V.party.renderSide(side, head);
  }
};

// ---------------------------------------------------------------- buttons, keys and gestures
V.initWatch = function () {
  var p = V.player = new V.Player(V.$('#player-host'));
  p.onEnded = V.onEnded;
  p.onTick = V.watchTick;
  p.onNext = function () { var it = V.watch.it; var nx = it && it.t === 'episode' ? V.nextEpisode(it) : null; if (nx) V.play(nx, { startAt: 0 }); };
  p.onTap = function () { V.showLiveCard(); };
  p.onSwipe = function (dir) { var it = V.watch.it; if (it && (it.t === 'live' || it.t === 'radio')) V.zap(dir === 'up' ? 1 : -1); };
  p.onCatchupSeek = function (ce, t) { V.playCatchup(V.entry(ce.catchupOf), ce.prog, t); };
  p.onBackToLive = function (ce) { V.play(V.entry(ce.catchupOf)); };
  p.onPlaying = function () { if (V.watch.it && V.watch.it.t !== 'live') V.$('.vp-live', p.host).hidden = true; V.castButton(); };
  p.onButton = function (a, b) {
    var it = V.watch.it;
    if (a === 'back') { if (V.watch.mini) V.closePlayer(); else if (V.party && V.party.current) V.party.leaveConfirm(); else V.closePlayer(); }
    else if (a === 'mini') V.setMini(!V.watch.mini);
    else if (a === 'next') p.onNext();
    else if (a === 'episodes') V.openSide('episodes');
    else if (a === 'channels') V.openSide('channels');
    else if (a === 'party') { if (V.party && V.party.current) V.openSide('party'); else V.party.startDialog(it); }
    else if (a === 'bookmark') V.bookmarkNow();
    else if (a === 'cast') V.cast(b);
    else if (a === 'restart') { var nn = V.epg.nowNext(it); if (nn.now) V.playCatchup(it, nn.now, 0); }
    else if (a === 'mini-open') V.setMini(false);
    else if (a === 'mini-close') V.closePlayer();
  };
  V.$('#player-layer').addEventListener('click', function (e) {
    var b = e.target.closest('[data-mini]');
    if (b) { e.stopPropagation(); if (b.dataset.mini === 'open') V.setMini(false); else if (b.dataset.mini === 'close') V.closePlayer(); else p.togglePlay(); return; }
    if (V.watch.mini && !e.target.closest('.vp-ctrl, .vp-top, .vp-menu')) V.setMini(false);
  });

  var numBuf = '', numT = null;
  document.addEventListener('keydown', function (e) {
    var layer = V.$('#player-layer');
    if (layer.hidden || V.watch.mini) return;
    if (e.target.closest('input, textarea, select, [contenteditable], dialog')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var it = V.watch.it;
    var live = it && (it.t === 'live' || it.t === 'radio' || it.t === 'catchup');
    var k = e.key;
    // On a TV, Up/Down on the seek bar move to the buttons above/below it (not the volume).
    if (V.tvMode && (k === 'ArrowUp' || k === 'ArrowDown') && e.target.closest('.vp-seek')) return;
    var inMenu = e.target.closest('.vp-menu, .vp-side, .vp-msg, .vp-upnext, .vp-ctrl button, .vp-top button, .vp-live button, .vp-skip');
    var handled = true;
    if (k === 'Escape' || k === 'Backspace' || k === 'BrowserBack' || e.keyCode === 10009 || e.keyCode === 461) {
      if (!V.$('.vp-menu', p.host).hidden) p._closeMenu();
      else if (V.watch.side) V.closeSide();
      else if (document.fullscreenElement) document.exitFullscreen();
      else V.setMini(true);
    } else if (/^\d$/.test(k) && live) {
      numBuf = (numBuf + k).slice(-4);
      var z = V.$('.vp-zap', p.host); z.hidden = false; z.textContent = numBuf;
      clearTimeout(numT);
      numT = setTimeout(function () { z.hidden = true; var n = +numBuf; numBuf = ''; V.zapTo(n); }, 1300);
    } else if (inMenu && (k === 'Enter' || k === ' ' || k.indexOf('Arrow') === 0)) handled = false;
    else if (k === ' ' || k === 'k' || k === 'MediaPlayPause' || k === 'Enter' && e.target === p.el) p.togglePlay();
    else if (k === 'MediaPlay') p.video.play();
    else if (k === 'MediaPause') p.video.pause();
    else if (k === 'f') p.toggleFullscreen();
    else if (k === 'm') p.toggleMute();
    else if (k === 'c') p.toggleSubs();
    else if (k === 'a') p.cycleAudio();
    else if (k === 'i') { if (live) V.showLiveCard(); else p.toggleStats(); }
    else if (k === 'p') p.togglePip();
    else if (k === 'b' && it && p.vod) V.bookmarkNow();
    else if (k === 'n' && it && it.t === 'episode') p.onNext();
    else if (k === 's') { var sb = V.$('.vp-skip', p.host); if (!sb.hidden) sb.click(); }
    else if (k === 'j' || k === 'MediaRewind') p.skip(-10);
    else if (k === 'l' || k === 'MediaFastForward') p.skip(10);
    else if (k === ',') p.step(-1);
    else if (k === '.') p.step(1);
    else if (k === '<') p.setRate(Math.max(0.25, Math.round((p.video.playbackRate - 0.25) * 4) / 4));
    else if (k === '>') p.setRate(Math.min(3, Math.round((p.video.playbackRate + 0.25) * 4) / 4));
    else if (k === 'ArrowLeft') p.skip(e.shiftKey ? -60 : -10);
    else if (k === 'ArrowRight') p.skip(e.shiftKey ? 60 : 10);
    else if ((k === 'ArrowUp' || k === 'ChannelUp' || k === 'PageUp') && live) V.zap(-1);
    else if ((k === 'ArrowDown' || k === 'ChannelDown' || k === 'PageDown') && live) V.zap(1);
    else if (k === 'ArrowUp') p.setVolume(p.video.volume + 0.05);
    else if (k === 'ArrowDown') p.setVolume(p.video.volume - 0.05);
    else if (k === 'Tab') { handled = false; p._wake(); }
    else if (k === 'x' && live) V.previousChannel();
    else if (k === 'g' && live) V.router.go('#/guide');
    else if (k === '?') V.keyHelp(true, live);
    else handled = false;
    if (handled) { e.preventDefault(); p._wake(); }
  });

  // Another of your devices says "play this here".
  V.on('command', function (d) {
    var it0 = V.watch.it;
    var live = it0 && (it0.t === 'live' || it0.t === 'radio' || it0.t === 'catchup');
    if (d.cmd !== 'watch' && d.cmd !== 'unwatch' && d.cmd !== 'takeover') V.stillHere();
    if (d.cmd === 'play' && d.k) {
      var it = V.entry(d.k);
      if (!it) return V.toast('That isn’t available on this profile', { error: true });
      V.toast('Playing from ' + d.from);
      V.play(it, { startAt: d.pos || undefined });
    } else if (d.cmd === 'pause') p.video.pause();
    else if (d.cmd === 'resume') p.video.play().catch(function () {});
    else if (d.cmd === 'toggle') p.togglePlay();
    else if (d.cmd === 'stop') V.closePlayer();
    else if (d.cmd === 'seek') p.seek(d.pos || 0, true);
    else if (d.cmd === 'skip') p.skip(d.d || 10);
    else if (d.cmd === 'volume') { p.setVolume(V.clamp(d.v, 0, 1)); p.osd('Volume ' + Math.round(p.video.volume * 100) + '%', 900); }
    else if (d.cmd === 'mute') p.toggleMute(typeof d.on === 'boolean' ? d.on : undefined);
    else if (d.cmd === 'subs') { var sb = p._tracks().subs; if (sb && sb.items[d.i]) { sb.items[d.i].fn(); p._menuRefresh(); } else p.toggleSubs(); }
    else if (d.cmd === 'audio') { var au = p._tracks().audio; if (au && au.items[d.i]) au.items[d.i].fn(); else p.cycleAudio(); }
    else if (d.cmd === 'next') p.onNext();
    else if (d.cmd === 'zap' && live) V.zap(d.dir || 1);
    else if (d.cmd === 'channel') V.zapTo(d.n);
    else if (d.cmd === 'live') p.goLive();
    else if (d.cmd === 'restart' && it0) { var nn = V.epg.nowNext(it0); if (live && nn.now && V.catchup.available(it0)) V.playCatchup(it0, nn.now, 0); else p.seek(0); }
    else if (d.cmd === 'sleep') V.setSleep(d.min || 0);
    else if (d.cmd === 'watch') V.remoteWatch(d.conn, true);
    else if (d.cmd === 'unwatch') V.remoteWatch(d.conn, false);
    else if (d.cmd === 'takeover') {
      if (!V.watch.it) return;
      V.closePlayer();
      V.toast((d.from || 'Someone') + (d.priority ? ' has priority and' : '') + ' needed the connection to watch on ' + (d.device || 'another device') + '.', { ms: 10000 });
    }
    V.remotePush();
  });
  // Any key, click or touch on the player means someone's still there.
  ['keydown', 'pointerdown'].forEach(function (ev) { V.$('#player-layer').addEventListener(ev, function () { V.stillHere(); }, true); });
  // Handoff: progress made on another device for what's open here.
  V.on('remote-progress', function (d) {
    if (!V.watch.it || V.watch.it.k !== d.k || !d.rec || p.video.paused === false) return;
    if (Math.abs((d.rec.p || 0) - p.position) > 30) V.toast('You watched further on another device', { action: { label: 'Jump to ' + V.fmtDur(d.rec.p), fn: function () { p.seek(d.rec.p); } } });
  });
};

V.playCatchup = function (it, prog, offset) {
  var ce = V.catchup.entryFor(it, prog, offset || 0);
  if (!ce) return V.toast('This channel’s archive address couldn’t be worked out.', { error: true });
  V.play(ce, { startAt: 0 });
};

V.bookmarkNow = function () {
  var p = V.player, it = V.watch.it;
  if (!it || !p.vod) return;
  var t = p.position;
  V.addBookmark(it, t, '').then(function (b) {
    V.toast('Bookmarked at ' + V.fmtDur(t), { action: { label: 'Add a note', fn: function () { V.prompt('Note for ' + V.fmtDur(t), { max: 500 }).then(function (n) { if (n) V.editBookmark(b.id, n); }); } } });
  }).catch(V.fail);
};

V.markersDialog = function (p) {
  var it = p.it, pos = p.position;
  var m = p.markers || {};
  var fmt = function (x) { return x ? V.fmtDur(x.start) + ' – ' + V.fmtDur(x.end) : 'not set'; };
  V.dialog({
    title: 'Mark the intro or credits',
    body: '<p class="dim">Play to the start or end of the intro (or end credits) and press the buttons. Everyone in the household gets the skip button.</p>' +
      '<p>Intro: <b data-v="intro">' + fmt(m.intro) + '</b><br>Credits: <b data-v="credits">' + fmt(m.credits) + '</b></p>' +
      '<div class="btn-row"><button class="btn" data-m="intro-s">Intro starts here (' + V.fmtDur(pos) + ')</button><button class="btn" data-m="intro-e">Intro ends here</button></div>' +
      '<div class="btn-row"><button class="btn" data-m="credits-s">Credits start here</button><button class="btn" data-m="credits-e">Credits end here</button></div>' +
      (it.t === 'episode' ? '<label class="check"><input type="checkbox" data-season checked> <span>Use the same times for the rest of this season</span></label>' : ''),
    actions: [{ label: 'Clear', fn: function (d) { return Promise.all(['intro', 'credits'].map(function (k) { return V.api('/api/markers/' + encodeURIComponent(it.k), { body: { kind: k, start: null } }); })).then(function () { p.markers = { intro: null, credits: null }; p._drawMarks(); }); } }, { label: 'Done', primary: true }],
    onOpen: function (d) {
      var tmp = { intro: m.intro ? Object.assign({}, m.intro) : {}, credits: m.credits ? Object.assign({}, m.credits) : {} };
      d.addEventListener('click', function (e) {
        var b = e.target.closest('[data-m]');
        if (!b) return;
        var parts = b.dataset.m.split('-'), kind = parts[0];
        tmp[kind][parts[1] === 's' ? 'start' : 'end'] = p.position;
        if (kind === 'credits' && parts[1] === 's' && !tmp.credits.end) tmp.credits.end = p.duration;
        if (kind === 'intro' && parts[1] === 'e' && tmp.intro.start === undefined) tmp.intro.start = 0;
        var x = tmp[kind];
        if (x.start !== undefined && x.end !== undefined && x.end > x.start) {
          var season = V.$('[data-season]', d);
          V.api('/api/markers/' + encodeURIComponent(it.k), { body: { kind: kind, start: x.start, end: x.end, season: !!(season && season.checked) } }).then(function (res) { p.markers = res; p._drawMarks(); V.$('[data-v=' + kind + ']', d).textContent = fmt(res[kind]); V.toast('Saved'); }).catch(V.fail);
        } else V.$('[data-v=' + kind + ']', d).textContent = (x.start !== undefined ? V.fmtDur(x.start) : '?') + ' – ' + (x.end !== undefined ? V.fmtDur(x.end) : '?');
      });
    },
  });
};

V.subtitleStyleDialog = function () {
  var st = Object.assign({}, V.pref('subStyle'));
  var opt = function (k, list) { return list.map(function (o) { return '<option value="' + o[0] + '"' + (String(st[k]) === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>'; }).join(''); };
  V.dialog({
    title: 'Subtitle style',
    body: '<div class="sub-preview"><span>This is how subtitles will look.</span></div><div class="grid2">' +
      '<label class="field"><span>Size</span><select class="input" data-k="size">' + opt('size', [[75, 'Small'], [100, 'Normal'], [130, 'Large'], [165, 'Extra large'], [200, 'Huge']]) + '</select></label>' +
      '<label class="field"><span>Text colour</span><select class="input" data-k="color">' + opt('color', [['#ffffff', 'White'], ['#ffeb3b', 'Yellow'], ['#00e5ff', 'Cyan'], ['#69f0ae', 'Green'], ['#000000', 'Black']]) + '</select></label>' +
      '<label class="field"><span>Background</span><select class="input" data-k="bg">' + opt('bg', [['rgba(0,0,0,0)', 'None'], ['rgba(0,0,0,0.4)', 'Light'], ['rgba(0,0,0,0.6)', 'Medium'], ['rgba(0,0,0,0.9)', 'Solid black'], ['rgba(255,255,255,0.85)', 'White']]) + '</select></label>' +
      '<label class="field"><span>Edge</span><select class="input" data-k="edge">' + opt('edge', [['shadow', 'Drop shadow'], ['outline', 'Outline'], ['raised', 'Raised'], ['none', 'None']]) + '</select></label>' +
      '<label class="field"><span>Font</span><select class="input" data-k="font">' + opt('font', [['sans', 'Sans-serif'], ['serif', 'Serif'], ['mono', 'Monospace'], ['casual', 'Casual']]) + '</select></label></div>',
    actions: [{ label: 'Reset', fn: function () { V.setPref('subStyle', { size: 100, color: '#ffffff', bg: 'rgba(0,0,0,0.6)', edge: 'shadow', font: 'sans', pos: 0 }); } }, { label: 'Done', primary: true }],
    onOpen: function (d) {
      var prev = V.$('.sub-preview span', d);
      var paint = function () { var edge = { shadow: '0 2px 4px rgba(0,0,0,.9)', outline: '-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000', raised: '1px 1px 0 #000,2px 2px 0 #000', none: 'none' }[st.edge]; prev.style.cssText = 'font-size:' + (st.size / 100 * 1.3) + 'em;color:' + st.color + ';background:' + st.bg + ';text-shadow:' + edge + ';font-family:' + ({ sans: 'system-ui', serif: 'Georgia,serif', mono: 'monospace', casual: '"Comic Sans MS",cursive' }[st.font]); };
      paint();
      d.addEventListener('change', function (e) { var k = e.target.dataset.k; if (!k) return; st[k] = k === 'size' ? +e.target.value : e.target.value; paint(); V.setPref('subStyle', Object.assign({}, st)); });
    },
  });
};

// ---------------------------------------------------------------- casting & playing on another device
V.castButton = function () {
  var b = V.$('[data-a=cast]', V.player.host);
  var v = V.player.video;
  var can = !!(window.cast && window.cast.framework) || !!(v.remote && v.remote.watchAvailability) || !!window.WebKitPlaybackTargetAvailabilityEvent;
  b.hidden = !can && !(S.devices && S.devices.length);
  if (!V._castInit && window.isSecureContext && /Chrome/.test(navigator.userAgent) && !/Edg|OPR|SamsungBrowser/.test(navigator.userAgent) && !V.device.tv) {
    V._castInit = true;
    window.__onGCastApiAvailable = function (ok) {
      if (!ok) return;
      try { cast.framework.CastContext.getInstance().setOptions({ receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED }); b.hidden = false; } catch (e) {}
    };
    V.loadScript('https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1').catch(function () {});
  }
  if (window.WebKitPlaybackTargetAvailabilityEvent && !V._airplay) { V._airplay = true; v.addEventListener('webkitplaybacktargetavailabilitychanged', function (e) { if (e.availability === 'available') b.hidden = false; }); }
};

V.cast = function (btn) {
  var p = V.player, v = p.video, it = V.watch.it;
  var items = [];
  if (window.cast && window.cast.framework) items.push({ label: 'Chromecast', icon: 'cast', fn: V.chromecast });
  if (v.webkitShowPlaybackTargetPicker) items.push({ label: 'AirPlay', icon: 'cast', fn: function () { v.webkitShowPlaybackTargetPicker(); } });
  else if (v.remote && v.remote.prompt) items.push({ label: 'Cast this video', icon: 'cast', fn: function () { v.remote.prompt().catch(function (e) { V.toast(e.message || 'No devices found', { error: true }); }); } });
  V.api('/api/devices').then(function (devs) {
    var others = devs.filter(function (d) { return d.conn !== S.conn; });
    if (others.length) { items.push({ sep: true }); items.push({ header: 'Play on another device' }); }
    others.forEach(function (d) { items.push({ label: d.name, icon: 'devices', hint: d.playing ? 'Playing ' + d.playing.n : 'Idle', fn: function () { V.api('/api/devices/' + d.conn + '/command', { body: { cmd: 'play', k: it.t === 'catchup' ? it.catchupOf : it.k, pos: p.vod ? p.position : 0 } }).then(function () { p.video.pause(); V.toast('Playing on ' + d.name); }).catch(V.fail); } }); });
    if (!items.length) items.push({ label: window.isSecureContext ? 'No cast devices found' : 'Casting needs a secure (https) address', fn: function () {} });
    V.menu(btn, items);
  }).catch(function () { V.menu(btn, items.length ? items : [{ label: 'No cast devices found' }]); });
};

V.chromecast = function () {
  var p = V.player, it = V.watch.it;
  var ctx = cast.framework.CastContext.getInstance();
  var send = function (full, type) {
    var info = new chrome.cast.media.MediaInfo(full, type);
    info.metadata = new chrome.cast.media.GenericMediaMetadata();
    info.metadata.title = it.n;
    if (it.i) info.metadata.images = [new chrome.cast.Image(it.i)];
    info.streamType = p.vod ? chrome.cast.media.StreamType.BUFFERED : chrome.cast.media.StreamType.LIVE;
    var req = new chrome.cast.media.LoadRequest(info);
    req.currentTime = p.vod ? p.position - p.base : 0;
    return ctx.getCurrentSession().loadMedia(req).then(function () { p.video.pause(); V.toast('Casting ' + it.n); });
  };
  var go = function (pq, type) { return V.api('/api/cast/link', { body: { path: pq } }).then(function (r) { return send(location.origin + r.url, type); }); };
  var viaServer = function () {
    if (p.sessionId) return go('/api/session/' + p.sessionId + '/index.m3u8', 'application/x-mpegURL');
    // Not converting right now: ask the server to relay it (receivers can't send headers or get past CORS).
    return V.api('/api/play/relay', { body: { k: it.t === 'catchup' ? it.catchupOf : it.k, alt: p.alt, url: it.t === 'catchup' ? it.u : undefined, sniff: true } }).then(function (r) {
      if (r.kind === 'ffmpeg' || r.kind === 'ts') return V.api('/api/play/session', { body: { k: it.k, alt: p.alt, mode: 'remux', seek: p.vod ? p.position : 0, live: !p.vod, codecs: ['h264'] } }).then(function (s) { return go(s.url, 'application/x-mpegURL'); });
      return go(r.url, r.kind === 'hls' ? 'application/x-mpegURL' : r.kind === 'dash' ? 'application/dash+xml' : 'video/mp4');
    });
  };
  ctx.requestSession().then(function () {
    // Straight from the provider when the Chromecast can take it: a plain video file needs no permission, and
    // HLS/DASH do when the provider allows web players. If the Chromecast can't load it, the server relays it.
    var a = p.attempt, hdrs = p.headers || {};
    var type = !a || a.via !== 'direct' || !a.url || !/^https?:/i.test(a.url) || Object.keys(hdrs).length ? '' :
      a.kind === 'native' && !a.mkv ? 'video/mp4' :
      a.kind === 'hls' && (!a.native || (p.reachInfo && p.reachInfo.mse)) ? 'application/x-mpegURL' :
      a.kind === 'dash' && !it.dr ? 'application/dash+xml' : '';
    if (type && !p.sessionId) return send(a.url, type).catch(function () { return viaServer(); });
    return viaServer();
  }).catch(function (e) { if (e && e !== 'cancel' && e.code !== 'cancel') V.toast('Casting failed: ' + (e.description || e.code || e), { error: true }); });
};

// ---------------------------------------------------------------- are you still watching?
V.watch.auto = 0; // episodes started on their own since anyone touched anything
V.watch.lastTouch = Date.now();
V.stillHere = function () { V.watch.auto = 0; V.watch.lastTouch = Date.now(); };
/** Start the next episode on its own — unless that's been happening for a while with nobody around. */
V.autoNext = function (nx) {
  V.watch.auto++;
  if (V.watch.auto >= 3 && V.pref('stillWatching') !== false && !V.ls.session('noStillWatching')) return V.askStillWatching(function () { V.play(nx, { startAt: 0 }); });
  V.play(nx, { startAt: 0 });
};
V.askStillWatching = function (go) {
  var p = V.player, it = V.watch.it;
  p.video.pause();
  var name = it ? ((V.showOf(it) || {}).n || it.n) : '';
  p._msg({
    title: 'Are you still watching' + (name ? ' “' + name + '”' : '') + '?',
    actions: [
      { label: 'Continue watching', primary: true, fn: function () { V.stillHere(); p._msg(null); go(); } },
      { label: 'Don’t ask again this session', fn: function () { V.ls.session('noStillWatching', 1); V.stillHere(); p._msg(null); go(); } },
      { label: 'Stop', fn: function () { V.closePlayer(); } },
    ],
  });
  V.remotePush();
};
// Live TV for 4 hours with nobody touching anything: ask too (so a forgotten TV doesn't hold the connection all night).
setInterval(function () {
  var it = V.watch.it, p = V.player;
  if (!it || !p || !p.started || p.video.paused || p.vod || V.pref('stillWatching') === false || V.ls.session('noStillWatching')) return;
  if (Date.now() - V.watch.lastTouch > 4 * 3600e3) V.askStillWatching(function () { p.video.play().catch(function () {}); });
}, 60e3);

// ---------------------------------------------------------------- phone remote: tell the phones controlling this device what's on
V.remote = { watchers: {} }; // conn → expiry
V.remoteWatch = function (conn, on) {
  if (!conn) return;
  if (on) V.remote.watchers[conn] = Date.now() + 30e3; else delete V.remote.watchers[conn];
  V.remotePush(true);
};
V.remoteState = function () {
  var p = V.player, it = V.watch.it;
  if (!it || !p) return { idle: true, profile: S.profile && S.profile.name };
  var tr = p.started ? p._tracks() : {};
  var label = function (x) { return x ? { value: x.value, items: x.items.map(function (i) { return i.label; }), on: x.items.findIndex(function (i) { return i.on; }) } : null; };
  var show = it.t === 'episode' ? V.showOf(it) : null;
  var nn = it.t === 'live' || it.t === 'radio' ? V.epg.nowNext(it) : {};
  return {
    k: it.t === 'catchup' ? it.catchupOf : it.k, t: it.t, n: show ? show.n : it.n, sub: it.t === 'episode' ? V.epLabel(it) + (it.et ? ' · ' + it.et : '') : nn.now ? nn.now.t : it.ev || '',
    i: it.i || (show && show.i) || '', no: it.no || 0, pos: p.started ? Math.round(p.position) : 0, dur: Math.round(p.duration || 0), vod: !!p.vod, paused: p.video.paused, started: !!p.started,
    vol: Math.round(p.video.volume * 100) / 100, muted: p.video.muted, subs: label(tr.subs), audio: label(tr.audio), next: it.t === 'episode' && !!V.nextEpisode(it),
    msg: V.$('.vp-msg', p.host).hidden ? '' : (V.$('.vp-msg .t', p.host) || {}).textContent || '', sleep: V.sleepLeft ? Math.ceil(V.sleepLeft() / 60000) : 0, profile: S.profile && S.profile.name,
  };
};
V.remotePush = V.throttle(function () {
  var now = Date.now(), to = [];
  Object.keys(V.remote.watchers).forEach(function (c) { if (V.remote.watchers[c] > now) to.push(c); else delete V.remote.watchers[c]; });
  if (!to.length || !S.conn) return;
  V.api('/api/devices/state', { body: { conn: S.conn, to: to, state: V.remoteState() } }).catch(function () {});
}, 700);
setInterval(function () { if (Object.keys(V.remote.watchers).length) V.remotePush(); }, 2000);
V.on('playing', function () { V.remotePush(); });
V.on('stopped', function () { V.remotePush(); });

/** "?": the keyboard shortcuts (the player's while watching). */
V.keyHelp = function (inPlayer, live) { // inPlayer: true, false or 'all'
  if (V.$('dialog.keys-dlg')) return;
  var row = function (keys, what) { return '<tr><td>' + keys.map(function (x) { return '<kbd>' + V.esc(x) + '</kbd>'; }).join(' ') + '</td><td>' + V.esc(what) + '</td></tr>'; };
  var player = [
    row(['Space', 'K'], 'Play / pause'),
    row(['←', '→'], 'Back / forward 10 s (with Shift: 60 s)'),
    row(['J', 'L'], 'Back / forward 10 s'),
    row(['↑', '↓'], live ? 'Change channel' : 'Volume'),
    row(['F'], 'Full screen'), row(['M'], 'Mute'), row(['P'], 'Picture-in-picture'),
    row(['C'], 'Subtitles on / off'), row(['A'], 'Next audio track'),
  ];
  var liveRows = [row(['0–9'], 'Go to channel number'), row(['X'], 'Previous channel'), row(['G'], 'TV guide'), row(['I'], 'What’s on')];
  var vodRows = [row(['S'], 'Skip intro or credits'), row(['N'], 'Next episode'), row(['B'], 'Bookmark this moment'), row([',', '.'], 'Frame by frame (paused)'), row(['<', '>'], 'Slower / faster'), row(['I'], live === undefined ? 'Playback details (live TV: what’s on)' : 'Playback details')];
  var all = inPlayer === 'all';
  if (all) { player[3] = row(['↑', '↓'], 'Volume (live TV: change channel)'); player = player.concat(vodRows, liveRows.slice(0, 3)); }
  else player = player.concat(live ? liveRows : vodRows);
  player.push(row(['Esc'], 'Small player / close'));
  var app = [row(['/'], 'Search'), row(['←', '↑', '→', '↓'], 'Move around (remote or keyboard)'), row(['Enter'], 'Open / play'), row(['Menu'], 'Options for the highlighted poster or channel'), row(['Esc', 'Back'], 'Go back / close'), row(['?'], 'This list')];
  V.dialog({
    title: 'Keyboard shortcuts', cls: 'keys-dlg',
    body: (inPlayer ? '<h3>While watching</h3><table class="kb-table">' + player.join('') + '</table><h3>Everywhere</h3>' : '') + '<table class="kb-table">' + app.join('') + '</table>' +
      (inPlayer ? '' : '<p class="dim">Press ? while something is playing to see the player’s keys.</p>') +
      (V.tvMode || all ? '<p class="dim small">On a TV remote, the arrow keys move around, OK selects and Back goes back. Channel up/down and the number keys work while watching live TV.</p>' : ''),
    actions: [{ label: 'Close', primary: true }],
  });
};
document.addEventListener('keydown', function (e) {
  if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || !S.profile) return;
  if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable], dialog')) return;
  var layer = V.$('#player-layer');
  if (layer && !layer.hidden && !(V.watch && V.watch.mini)) return; // (the player's own handler shows its keys)
  e.preventDefault();
  V.keyHelp(false);
});
