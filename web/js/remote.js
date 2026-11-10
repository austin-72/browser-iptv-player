/* Phone and TV: approve a TV's sign-in code, use this device as a remote for another, and "play on the TV" mode. */
'use strict';

// ---------------------------------------------------------------- signing a TV in
/** Settings → Sign in a TV: type the code the TV shows. */
V.pairDialog = function (code) {
  return V.dialog({
    title: 'Sign in a TV',
    body: '<p class="dim">On the TV, choose <b>Sign in with your phone</b>. Type the code it shows.</p>' +
      '<label class="field"><span>Code</span><input class="input code-input" data-code maxlength="7" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC-123" value="' + V.esc(code || '') + '"></label>' +
      '<label class="check"><input type="radio" name="as" value="me" checked><span>Open it as <b>' + V.esc(S.profile.name) + '</b></span></label>' +
      '<label class="check"><input type="radio" name="as" value="choose"><span>Let the TV choose a profile (“Who’s watching?”)</span></label><div class="err" role="alert"></div>',
    actions: [{ label: 'Cancel' }, { label: 'Sign in', primary: true, fn: function (d) {
      var c = V.$('[data-code]', d).value.trim();
      if (c.replace(/[^a-z0-9]/gi, '').length < 6) { V.$('.err', d).textContent = 'The code has 6 letters and numbers.'; return false; }
      return V.api('/api/pair/approve', { body: { code: c, as: V.$('[name=as]:checked', d).value } }).then(function (r) {
        V.toast('Signed in ' + r.device + '. Control it with the remote button at the top.', { ms: 8000, action: { label: 'Remote', fn: function () { V.router.go('#/remote'); } } });
      }, function (e) { V.$('.err', d).textContent = e.message; return false; });
    } }],
    onOpen: function (d) { var i = V.$('[data-code]', d); i.addEventListener('input', function () { var v = i.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); i.value = v.length > 3 ? v.slice(0, 3) + '-' + v.slice(3) : v; }); },
  });
};
// The QR code on the TV opens "#/pair?c=ABC123" on the phone.
V.route('pair', function (view, r) {
  var c = (r.q.get('c') || '').toUpperCase();
  view.innerHTML = V.empty('Sign in a TV', 'Check the code matches the one on the TV.');
  V.router.go('#/settings', true);
  setTimeout(function () { V.pairDialog(c.length === 6 ? c.slice(0, 3) + '-' + c.slice(3) : c); }, 100);
});

// ---------------------------------------------------------------- after switching to the direct address
// "#/play/<key>?t=120": play something (after switching address), then leave its page underneath.
V.route('play', function (view, r) {
  var it = V.entry(r.args[0]);
  if (!it) { V.router.go('#/home', true); return; }
  V.router.go(V.hrefOf(it), true);
  setTimeout(function () { V.play(it, { startAt: +(r.q.get('t') || 0) || undefined }); }, 50);
});

// ---------------------------------------------------------------- remote control
V.remote = V.remote || { watchers: {} };
V.remote.target = V.ls.session('remoteTarget') || null; // { conn, name } while "play on the TV" is on

V.route('remote', function (view, r) {
  var conn = r.args[0];
  if (!conn) return remoteList(view);
  remotePad(view, conn);
});

function remoteList(view) {
  view.innerHTML = V.pageHead('Remote') + '<p class="dim">Pick a screen to control.</p><div class="remote-devs"><div class="spinner"></div></div>' +
    '<div class="btn-row"><button class="btn" data-pair>' + V.icon('tv') + ' Sign in a TV</button></div>';
  var shown = null;
  var draw = function () {
    V.api('/api/devices').then(function (devs) {
      var others = devs.filter(function (d) { return d.conn !== S.conn; });
      var box = V.$('.remote-devs', view);
      if (!box) return;
      var html = others.length ? others.map(function (d) {
        // Someone else's screen: asked first (what's on it isn't shown until they allow it).
        if (d.ok === false) return '<button class="remote-dev rm-ask" data-ask="' + V.esc(d.conn) + '"' + (d.asked ? ' disabled' : '') + '>' + V.icon(d.tv ? 'tv' : 'devices') + '<span><b>' + V.esc(d.name) + '</b>' + (d.profile ? ' <span class="chip sm">' + V.esc(d.profile) + '</span>' : '') + '<small class="dim">' + (d.asked ? 'Asked — waiting for an answer on that screen' : 'Ask to use it as a remote') + '</small></span>' + V.icon('lock') + '</button>';
        return '<a class="remote-dev" href="#/remote/' + encodeURIComponent(d.conn) + '">' + V.icon(d.tv ? 'tv' : 'devices') + '<span><b>' + V.esc(d.name) + '</b>' + (d.profile ? ' <span class="chip sm">' + V.esc(d.profile) + '</span>' : '') + '<small class="dim">' + (d.playing ? 'Playing ' + V.esc(d.playing.n || '') : 'Nothing playing') + '</small></span>' + V.icon('next') + '</a>';
      }).join('') : V.empty('No other screens open', '', '<ol class="rm-steps"><li>Open the app on your TV or computer.</li><li>Pick <b>' + V.esc(S.profile.name) + '</b> there — it shows up here in a few seconds.</li></ol><p class="dim small">TV not signed in yet? Choose “Sign in with your phone” on it, then <b>Sign in a TV</b> below.</p>');
      if (html !== shown) { shown = html; box.innerHTML = html; } // (not redrawn every 5 seconds when nothing changed)
    }).catch(V.fail);
  };
  draw();
  var t = setInterval(draw, 5000);
  var off = V.on('remote-answer', function (d) { if (d.ok) V.router.go('#/remote/' + encodeURIComponent(d.conn)); else draw(); });
  V.pageCleanup = function () { clearInterval(t); off(); };
  V.$('[data-pair]', view).onclick = function () { V.pairDialog(); };
  V.$('.remote-devs', view).addEventListener('click', function (e) {
    var b = e.target.closest('[data-ask]');
    if (b) { b.disabled = true; V.remoteAsk(b.dataset.ask).then(function () { shown = null; draw(); }, function () { b.disabled = false; }); }
  });
}

/** Ask the person at another profile's screen to let this phone be its remote. */
V.remoteAsk = function (conn) {
  return V.api('/api/devices/' + encodeURIComponent(conn) + '/ask', { method: 'POST' }).then(function (r) {
    if (r && r.asked) V.toast('Asked — they need to allow it on that screen', { ms: 6000 });
    return r;
  }).catch(function (e) { V.fail(e); throw e; });
};

/** A remote for one screen: straight away for your own; someone else's once they've allowed it. */
function remotePad(view, conn) {
  view.innerHTML = '<div class="spinner"></div>';
  V.api('/api/devices').then(function (devs) {
    var d = devs.filter(function (x) { return x.conn === conn; })[0];
    if (!d) return V.router.go('#/remote', true);
    if (d.ok !== false) return remotePadOpen(view, conn);
    var drawAsk = function (asked) {
      view.innerHTML = V.pageHead('Remote') + '<div class="rm-asking">' + V.empty(d.name + (d.profile ? ' (' + d.profile + ')' : ''), asked ? 'Waiting for them to allow it on that screen…' : 'This is someone else’s screen. They need to allow your phone to be its remote.', asked ? '' : '<button class="btn primary" data-ask>' + V.icon('remote') + ' Ask to connect</button>') + '</div>';
      var b = V.$('[data-ask]', view);
      if (b) b.onclick = function () { b.disabled = true; V.remoteAsk(conn).then(function () { drawAsk(true); }, function () { b.disabled = false; }); };
    };
    drawAsk(d.asked);
    var off = V.on('remote-answer', function (a) {
      if (a.conn !== conn) return;
      off(); V.pageCleanup = null;
      if (a.ok) remotePadOpen(view, conn); else drawAsk(false);
    });
    V.pageCleanup = function () { off(); };
  }).catch(V.fail);
}

function remotePadOpen(view, conn) {
  var st = null, name = '', seek = null, artOf = '';
  // (The screen's connection is gone — it reloaded, or closed: first see whether it's back on a new one, and only
  // then go to the list. Nothing once this page has been left.)
  var gone = false;
  var cmd = function (c, extra) {
    return V.api('/api/devices/' + encodeURIComponent(conn) + '/command', { body: Object.assign({ cmd: c }, extra || {}) }).catch(function (e) {
      if (gone) return;
      if (e.status !== 404) return V.fail(e);
      follow(function () { if (!gone) { V.toast('That screen isn’t open any more.'); V.router.go('#/remote', true); } });
    });
  };
  view.innerHTML = '<div class="remote">' +
    '<header class="rm-h"><a class="icon-btn" href="#/remote" aria-label="All screens">' + V.icon('back') + '</a><b class="rm-dev truncate">Remote</b><span class="sp"></span><button class="btn sm" data-target>' + V.icon('cast') + ' Pick things to play here</button></header>' +
    '<div class="rm-now"><div class="rm-art"></div><div class="rm-info"><div class="rm-t">Connecting…</div><div class="rm-s dim"></div></div></div>' +
    '<div class="rm-seek" hidden><span class="num rm-t1"></span><input type="range" min="0" max="100" value="0" data-seek aria-label="Position"><span class="num rm-t2"></span></div>' +
    '<div class="rm-main">' +
    '<button class="rm-b" data-c="skip" data-d="-' + V.skipLen('back') + '" aria-label="Back ' + V.skipLen('back') + ' seconds">' + V.skipIcon('back') + '</button>' +
    '<button class="rm-b big" data-c="toggle" aria-label="Play or pause">' + V.icon('play') + '</button>' +
    '<button class="rm-b" data-c="skip" data-d="' + V.skipLen('fwd') + '" aria-label="Forward ' + V.skipLen('fwd') + ' seconds">' + V.skipIcon('fwd') + '</button></div>' +
    '<div class="rm-row rm-live" hidden><button class="btn" data-c="zap" data-dir="-1">' + V.icon('up') + ' Channel up</button><button class="btn" data-c="zap" data-dir="1">' + V.icon('down') + ' Channel down</button><button class="btn" data-c="live">Go live</button><button class="btn" data-c="restart">' + V.icon('restart') + ' Start over</button></div>' +
    '<div class="rm-row"><button class="btn" data-c="prev" hidden>' + V.icon('back') + ' Previous episode</button><button class="btn" data-c="next" hidden>' + V.icon('skipnext') + ' Next episode</button><button class="btn" data-c="subs">' + V.icon('cc') + ' Subtitles</button><button class="btn" data-c="audio">Audio</button><button class="btn" data-sleep>' + V.icon('moon') + ' Sleep timer</button><button class="btn danger" data-c="stop">Stop</button></div>' +
    '<div class="rm-vol"><button class="icon-btn" data-c="mute" aria-label="Mute">' + V.icon('vol') + '</button><input type="range" min="0" max="100" value="100" data-vol aria-label="Volume"></div>' +
    '<div class="rm-msg" hidden></div>' +
    // Working the TV's screen itself: arrows, OK, Back, the main pages, and searching by typing on the phone.
    '<details class="rm-nav"' + (V.ls.get('rm.nav', true) ? ' open' : '') + '><summary>Move around on the TV</summary>' +
      '<div class="rm-dpad"><button class="rm-k up" data-key="ArrowUp" aria-label="Up">' + V.icon('next') + '</button><button class="rm-k left" data-key="ArrowLeft" aria-label="Left">' + V.icon('back') + '</button>' +
      '<button class="rm-k ok" data-key="Enter">OK</button><button class="rm-k right" data-key="ArrowRight" aria-label="Right">' + V.icon('next') + '</button><button class="rm-k down" data-key="ArrowDown" aria-label="Down">' + V.icon('next') + '</button></div>' +
      '<div class="rm-row"><button class="btn" data-key="GoBack">' + V.icon('back') + ' Back</button><button class="btn" data-tvnav="home">' + V.icon('home') + ' Home</button><button class="btn" data-tvnav="live">' + V.icon('tv') + ' Live TV</button><button class="btn" data-tvnav="guide">' + V.icon('clock') + ' Guide</button><button class="btn" data-tvnav="movies">' + V.icon('film') + ' Movies</button><button class="btn" data-tvnav="series">' + V.icon('stack') + ' Series</button></div>' +
      '<div class="inline"><input class="input" type="search" data-tvq placeholder="Search on the TV" enterkeyhint="search"><button class="btn" data-tvsearch>' + V.icon('search') + '</button></div>' +
    '</details>' +
    '<div class="rm-numpad" hidden>' + [1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, 'go'].map(function (n) { return n === '' ? '<span></span>' : '<button class="rm-k" data-num="' + n + '">' + (n === 'go' ? 'Go' : n) + '</button>'; }).join('') + '<div class="rm-numval num" aria-live="polite"></div></div>' +
    '<section class="rm-ch"><div class="inline"><input class="input" type="search" data-chq placeholder="Find a channel or type its number"><button class="btn" data-go>Go</button></div><div class="chips rm-grps" role="group" aria-label="Channel group"></div><div class="rm-chl"></div></section></div>';
  var $ = function (q) { return V.$(q, view); };
  var draw = function () {
    if (!st) return;
    if (st.idle) { $('.rm-t').textContent = 'Nothing playing'; $('.rm-s').textContent = 'Pick something below or on any page, and choose “Play on…”.'; $('.rm-art').innerHTML = ''; artOf = ''; $('.rm-seek').hidden = true; return; }
    // (Only when the picture changes: put in again with every update from the screen — once a second — it flashed.)
    var artNow = (st.i || '') + '|' + (st.n || '');
    if (artNow !== artOf) { artOf = artNow; $('.rm-art').innerHTML = V.art(st.i, st.n, 'art'); }
    $('.rm-t').textContent = st.n + (st.no ? ' · ' + st.no : '');
    $('.rm-s').textContent = st.sub || '';
    V.$('[data-c=toggle]', view).innerHTML = V.icon(st.paused ? 'play' : 'pause');
    $('.rm-seek').hidden = !(st.vod && st.dur);
    if (st.vod && st.dur && !seek) { var sk = $('[data-seek]'); sk.max = st.dur; sk.value = st.pos; $('.rm-t1').textContent = V.fmtDur(st.pos); $('.rm-t2').textContent = '−' + V.fmtDur(Math.max(0, st.dur - st.pos)); }
    $('.rm-live').hidden = st.vod;
    V.$('[data-c=next]', view).hidden = !st.next;
    V.$('[data-c=prev]', view).hidden = !st.prev;
    V.$('.rm-numpad', view).hidden = st.vod;
    if (document.activeElement !== $('[data-vol]')) $('[data-vol]').value = Math.round((st.muted ? 0 : st.vol) * 100);
    V.$('[data-c=mute]', view).innerHTML = V.icon(st.muted ? 'mute' : 'vol');
    V.$('[data-c=subs]', view).textContent = 'Subtitles' + (st.subs ? ': ' + st.subs.value : '');
    V.$('[data-c=audio]', view).hidden = !st.audio;
    V.$('[data-sleep]', view).innerHTML = V.icon('moon') + (st.sleep ? ' ' + st.sleep + ' min' : ' Sleep timer');
    var m = $('.rm-msg'); m.hidden = !st.msg; m.textContent = st.msg || '';
  };
  var off = V.on('devstate', function (d) { if (d.from === conn) { st = d.state; draw(); } });
  // (The screen reconnected — its page reloaded, its network blinked: it has a new connection, and this remote follows
  // it there instead of talking to the old one.)
  var devId = '';
  var following = false;
  function follow(orElse) {
    if (!devId || following) { if (orElse && !devId) orElse(); return; }
    following = true;
    V.api('/api/devices').then(function (devs) {
      following = false;
      if (gone) return;
      if (!orElse && devs.some(function (x) { return x.conn === conn; })) return;
      var d = devs.filter(function (x) { return x.ok !== false && x.deviceId === devId && x.conn !== S.conn && x.conn !== conn; })[0];
      if (d) V.router.go('#/remote/' + encodeURIComponent(d.conn), true);
      else if (orElse) orElse();
    }).catch(function () { following = false; });
  }
  var hello = function () { cmd('watch'); follow(); };
  hello();
  var t = setInterval(hello, 10000);
  V.api('/api/devices').then(function (devs) { var d = devs.filter(function (x) { return x.conn === conn; })[0]; if (d) { name = d.name; devId = d.deviceId || ''; $('.rm-dev').textContent = d.name; drawTarget(); } else V.router.go('#/remote', true); }).catch(function () {}); // (offline a moment: the page tries again)
  V.pageCleanup = function () { clearInterval(t); off(); cmd('unwatch'); gone = true; };
  var drawTarget = function () { var on = V.remote.target && V.remote.target.conn === conn; var b = $('[data-target]'); b.classList.toggle('primary', !!on); b.innerHTML = V.icon('cast') + (on ? ' Playing things here: on' : ' Pick things to play here'); };
  view.addEventListener('click', function (e) {
    var b = e.target.closest('[data-c]');
    if (b) {
      var c = b.dataset.c, extra = {};
      if (b.dataset.d) extra.d = +b.dataset.d;
      if (b.dataset.dir) extra.dir = +b.dataset.dir;
      if ((c === 'subs' || c === 'audio') && st && st[c] && st[c].items.length > 2) {
        return V.menu(b, st[c].items.map(function (label, i) { return { label: label, checked: i === st[c].on, fn: function () { cmd(c, { i: i }); } }; }));
      }
      if (c === 'stop') return V.confirm('Stop playing on ' + (name || 'that screen') + '?', { ok: 'Stop' }).then(function (ok) { if (ok) cmd('stop'); });
      cmd(c, extra);
      if (navigator.vibrate) navigator.vibrate(15);
      return;
    }
    var kb = e.target.closest('[data-key]');
    if (kb) { cmd('key', { key: kb.dataset.key }); if (navigator.vibrate) navigator.vibrate(10); return; }
    var nb = e.target.closest('[data-tvnav]');
    if (nb) { cmd('nav', { to: nb.dataset.tvnav }); return; }
    if (e.target.closest('[data-tvsearch]')) { tvSearch(); return; }
    var nu = e.target.closest('[data-num]');
    if (nu) {
      var nv = $('.rm-numval');
      if (nu.dataset.num === 'go') { if (nv.textContent) cmd('channel', { n: +nv.textContent }); nv.textContent = ''; return; }
      nv.textContent = (nv.textContent + nu.dataset.num).slice(-4);
      clearTimeout(numT); numT = setTimeout(function () { if (nv.textContent) { cmd('channel', { n: +nv.textContent }); nv.textContent = ''; } }, 2000);
      return;
    }
    if (e.target.closest('[data-sleep]')) return V.menu(e.target.closest('[data-sleep]'), [0, 15, 30, 45, 60, 90].map(function (m) { return { label: m ? m + ' minutes' : 'Off', fn: function () { cmd('sleep', { min: m }); } }; }));
    if (e.target.closest('[data-target]')) {
      if (V.remote.target && V.remote.target.conn === conn) V.setRemoteTarget(null); else { V.setRemoteTarget({ conn: conn, name: name || 'the TV' }); V.toast('Now anything you press Play on here plays on ' + (name || 'the TV') + '.', { ms: 6000 }); }
      drawTarget();
      return;
    }
    var rg = e.target.closest('[data-rmgrp]');
    if (rg) { V.ls.set('rm.grp', rg.dataset.rmgrp); chList(''); return; }
    var ch = e.target.closest('[data-k]');
    if (ch) { cmd('play', { k: ch.dataset.k }); return; }
    if (e.target.closest('[data-go]')) goCh();
  });
  var numT = 0;
  var tvSearch = function () { var q = $('[data-tvq]').value.trim(); cmd('nav', { to: 'search', q: q }); };
  $('[data-tvq]').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); tvSearch(); } });
  view.addEventListener('toggle', function (e) { if (e.target.classList && e.target.classList.contains('rm-nav')) V.ls.set('rm.nav', e.target.open); }, true);
  var goCh = function () { var q = $('[data-chq]').value.trim(); if (/^\d+$/.test(q)) cmd('channel', { n: +q }); };
  $('[data-chq]').addEventListener('keydown', function (e) { if (e.key === 'Enter') goCh(); });
  var chList = function (q) {
    var grp = V.ls.get('rm.grp', '');
    var items = q ? V.search.find(q, { types: ['live', 'radio'], limit: 60 }) : grp ? V.channelsFor(grp, 'live').slice(0, 200) : V.recentChannels().concat(V.favChannels ? V.favChannels('any') : S.data.favs.map(V.entry).filter(Boolean)).filter(function (x, i, a) { return x && a.indexOf(x) === i; }).slice(0, 30);
    // Your groups as chips: recent & favourites, then your own lists.
    var chips = V.$('.rm-grps');
    if (chips && V.myLists) chips.innerHTML = [{ v: '', l: 'Recent & favourites' }, { v: '__fav', l: 'Favourites' }].concat(V.myLists().map(function (l) { return { v: '__my:' + l.id, l: l.name }; })).map(function (x) { return '<button class="chip sm' + (x.v === grp ? ' on' : '') + '" data-rmgrp="' + V.esc(x.v) + '" aria-pressed="' + (x.v === grp) + '">' + V.esc(x.l) + '</button>'; }).join('');
    $('.rm-chl').innerHTML = items.map(function (c) { var nn = V.epg.nowNext(c); return '<button class="side-ch" data-k="' + V.esc(c.k) + '"><span class="num">' + (c.no || '') + '</span>' + V.art(c.i, c.n, 'art sm') + '<span class="sc-t"><span class="truncate">' + V.esc(c.n) + '</span><small class="truncate dim">' + V.esc(nn.now ? nn.now.t : c.ev || c.g) + '</small></span></button>'; }).join('') || '<p class="dim">Favourite and recently watched channels show up here.</p>';
  };
  chList('');
  $('[data-chq]').addEventListener('input', V.debounce(function (e) { chList(e.target.value.trim()); }, 150));
  var sk = $('[data-seek]');
  sk.addEventListener('input', function () { seek = +sk.value; $('.rm-t1').textContent = V.fmtDur(seek); });
  sk.addEventListener('change', function () { cmd('seek', { pos: seek }); setTimeout(function () { seek = null; }, 1500); });
  $('[data-vol]').addEventListener('input', V.throttle(function (e) { cmd('volume', { v: +e.target.value / 100 }); }, 150));
}

/** "Play on the TV" mode: Play buttons on this device send to the chosen screen instead. */
V.setRemoteTarget = function (t) {
  V.remote.target = t;
  V.ls.session('remoteTarget', t);
  V.drawRemoteBar();
};
V.drawRemoteBar = function () {
  var bar = V.$('#remote-bar');
  var t = V.remote.target;
  if (!t) { if (bar) bar.remove(); document.body.classList.remove('remote-on'); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'remote-bar'; document.body.appendChild(bar); }
  document.body.classList.add('remote-on');
  bar.innerHTML = V.icon('cast') + '<span class="truncate">Playing on <b>' + V.esc(t.name) + '</b></span><a class="btn sm" href="#/remote/' + encodeURIComponent(t.conn) + '">' + V.icon('remote') + ' Remote</a><button class="icon-btn" data-off aria-label="Play here instead">' + V.icon('x') + '</button>';
  V.$('[data-off]', bar).onclick = function () { V.setRemoteTarget(null); V.toast('Playing on this device again'); };
};
/** Called by V.play: true when it was sent to the TV instead. */
V.playOnTarget = function (it, opts) {
  var t = V.remote.target;
  if (!t || (opts && opts.here)) return false;
  var k = it.t === 'catchup' ? it.catchupOf : it.k;
  V.api('/api/devices/' + encodeURIComponent(t.conn) + '/command', { body: { cmd: 'play', k: k, pos: opts && opts.startAt } }).then(function () {
    V.toast('Playing “' + it.n + '” on ' + t.name, { action: { label: 'Remote', fn: function () { V.router.go('#/remote/' + encodeURIComponent(t.conn)); } } });
  }).catch(function (e) {
    if (e.status === 404) { V.setRemoteTarget(null); V.toast(t.name + ' isn’t connected any more — playing here.'); V.play(it, Object.assign({}, opts, { here: true })); } else V.fail(e);
  });
  return true;
};
V.on('rt:connected', function () { V.drawRemoteBar(); });

// ---------------------------------------------------------------- asked to be someone's remote
// Another profile's phone wants to use this screen as its remote: the person here decides. (Until they allow it,
// that phone doesn't see what's playing here, and can't control it.)
V.on('remote-ask', function (d) {
  if (!d || !d.id) return;
  var who = (d.from || 'Someone') + (d.device ? ' (' + d.device + ')' : '');
  V.dialog({
    title: 'Use this screen as a remote?',
    body: '<p><b>' + V.esc(who) + '</b> wants to use their phone as the remote for this screen. If you allow it, they’ll see what’s playing here and can control it.</p>',
    actions: [{ label: 'Don’t allow', value: false }, { label: 'Allow', primary: true, value: true }],
  }).then(function (allow) {
    allow = allow === true;
    return V.api('/api/remote-ask/' + encodeURIComponent(d.id), { body: { allow: allow } }).then(function () {
      if (allow) V.toast((d.from || 'They') + ' can now use their phone as this screen’s remote', { ms: 8000, action: { label: 'Stop', fn: function () { V.api('/api/remote-ok/stop', { method: 'POST' }).then(function () { V.toast('No other phones can control this screen now'); }).catch(V.fail); } } });
    });
  }).catch(V.fail);
});
// The answer, on the phone that asked (the Remote pages also act on it).
V.on('remote-answer', function (d) {
  if (!d) return;
  var onRemote = document.body.dataset.page === 'remote';
  if (d.ok && !onRemote) V.toast((d.name || 'The screen') + ' allowed your phone as its remote', { ms: 7000, action: { label: 'Remote', fn: function () { V.router.go('#/remote/' + encodeURIComponent(d.conn)); } } });
  else if (d.ok) V.toast((d.name || 'The screen') + ' allowed it');
  else V.toast((d.name || 'The screen') + ' didn’t allow it', { error: true });
});
