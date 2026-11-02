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
  view.innerHTML = V.pageHead('Remote') + '<p class="dim">Pick a screen to control. Screens show up while the app is open on them — signed in as you, or signed in from this device with a code.</p><div class="remote-devs"><div class="spinner"></div></div>' +
    '<div class="btn-row"><button class="btn" data-pair>' + V.icon('tv') + ' Sign in a TV</button></div>';
  var draw = function () {
    V.api('/api/devices').then(function (devs) {
      var others = devs.filter(function (d) { return d.conn !== S.conn; });
      var box = V.$('.remote-devs', view);
      if (!box) return;
      box.innerHTML = others.length ? others.map(function (d) {
        return '<a class="remote-dev" href="#/remote/' + encodeURIComponent(d.conn) + '">' + V.icon(d.tv ? 'tv' : 'devices') + '<span><b>' + V.esc(d.name) + '</b>' + (d.profile ? ' <span class="chip sm">' + V.esc(d.profile) + '</span>' : '') + '<small class="dim">' + (d.playing ? 'Playing ' + V.esc(d.playing.n || '') : 'Nothing playing') + '</small></span>' + V.icon('next') + '</a>';
      }).join('') : V.empty('No other screens open', 'Open the app on your TV or computer and pick ' + V.esc(S.profile.name) + ' there: it shows up here within a few seconds. A TV that isn’t signed in yet: choose “Sign in with your phone” on it, then “Sign in a TV” below. On the TV, Profile menu → “Control from your phone” shows a code your phone’s camera can open.');
    }).catch(V.fail);
  };
  draw();
  var t = setInterval(draw, 5000);
  V.pageCleanup = function () { clearInterval(t); };
  V.$('[data-pair]', view).onclick = function () { V.pairDialog(); };
}

function remotePad(view, conn) {
  var st = null, name = '', seek = null;
  var cmd = function (c, extra) { return V.api('/api/devices/' + encodeURIComponent(conn) + '/command', { body: Object.assign({ cmd: c }, extra || {}) }).catch(function (e) { V.fail(e); if (e.status === 404) V.router.go('#/remote', true); }); };
  view.innerHTML = '<div class="remote">' +
    '<header class="rm-h"><a class="icon-btn" href="#/remote" aria-label="All screens">' + V.icon('back') + '</a><b class="rm-dev truncate">Remote</b><span class="sp"></span><button class="btn sm" data-target>' + V.icon('cast') + ' Pick things to play here</button></header>' +
    '<div class="rm-now"><div class="rm-art"></div><div class="rm-info"><div class="rm-t">Connecting…</div><div class="rm-s dim"></div></div></div>' +
    '<div class="rm-seek" hidden><span class="num rm-t1"></span><input type="range" min="0" max="100" value="0" data-seek aria-label="Position"><span class="num rm-t2"></span></div>' +
    '<div class="rm-main">' +
    '<button class="rm-b" data-c="skip" data-d="-' + V.skipLen('back') + '" aria-label="Back ' + V.skipLen('back') + ' seconds">' + V.skipIcon('back') + '</button>' +
    '<button class="rm-b big" data-c="toggle" aria-label="Play or pause">' + V.icon('play') + '</button>' +
    '<button class="rm-b" data-c="skip" data-d="' + V.skipLen('fwd') + '" aria-label="Forward ' + V.skipLen('fwd') + ' seconds">' + V.skipIcon('fwd') + '</button></div>' +
    '<div class="rm-row rm-live" hidden><button class="btn" data-c="zap" data-dir="-1">' + V.icon('up') + ' Channel up</button><button class="btn" data-c="zap" data-dir="1">' + V.icon('down') + ' Channel down</button><button class="btn" data-c="live">Go live</button><button class="btn" data-c="restart">' + V.icon('restart') + ' Start over</button></div>' +
    '<div class="rm-row"><button class="btn" data-c="next" hidden>' + V.icon('skipnext') + ' Next episode</button><button class="btn" data-c="subs">' + V.icon('cc') + ' Subtitles</button><button class="btn" data-c="audio">Audio</button><button class="btn" data-sleep>' + V.icon('moon') + ' Sleep timer</button><button class="btn danger" data-c="stop">Stop</button></div>' +
    '<div class="rm-vol"><button class="icon-btn" data-c="mute" aria-label="Mute">' + V.icon('vol') + '</button><input type="range" min="0" max="100" value="100" data-vol aria-label="Volume"></div>' +
    '<div class="rm-msg" hidden></div>' +
    '<section class="rm-ch"><div class="inline"><input class="input" type="search" data-chq placeholder="Find a channel or type its number"><button class="btn" data-go>Go</button></div><div class="chips rm-grps" role="group" aria-label="Channel group"></div><div class="rm-chl"></div></section></div>';
  var $ = function (q) { return V.$(q, view); };
  var draw = function () {
    if (!st) return;
    if (st.idle) { $('.rm-t').textContent = 'Nothing playing'; $('.rm-s').textContent = 'Pick something below or on any page, and choose “Play on…”.'; $('.rm-art').innerHTML = ''; $('.rm-seek').hidden = true; return; }
    $('.rm-art').innerHTML = V.art(st.i, st.n, 'art');
    $('.rm-t').textContent = st.n + (st.no ? ' · ' + st.no : '');
    $('.rm-s').textContent = st.sub || '';
    V.$('[data-c=toggle]', view).innerHTML = V.icon(st.paused ? 'play' : 'pause');
    $('.rm-seek').hidden = !(st.vod && st.dur);
    if (st.vod && st.dur && !seek) { var sk = $('[data-seek]'); sk.max = st.dur; sk.value = st.pos; $('.rm-t1').textContent = V.fmtDur(st.pos); $('.rm-t2').textContent = '−' + V.fmtDur(Math.max(0, st.dur - st.pos)); }
    $('.rm-live').hidden = st.vod;
    V.$('[data-c=next]', view).hidden = !st.next;
    if (document.activeElement !== $('[data-vol]')) $('[data-vol]').value = Math.round((st.muted ? 0 : st.vol) * 100);
    V.$('[data-c=mute]', view).innerHTML = V.icon(st.muted ? 'mute' : 'vol');
    V.$('[data-c=subs]', view).textContent = 'Subtitles' + (st.subs ? ': ' + st.subs.value : '');
    V.$('[data-c=audio]', view).hidden = !st.audio;
    V.$('[data-sleep]', view).innerHTML = V.icon('moon') + (st.sleep ? ' ' + st.sleep + ' min' : ' Sleep timer');
    var m = $('.rm-msg'); m.hidden = !st.msg; m.textContent = st.msg || '';
  };
  var off = V.on('devstate', function (d) { if (d.from === conn) { st = d.state; draw(); } });
  var hello = function () { cmd('watch'); };
  hello();
  var t = setInterval(hello, 10000);
  V.api('/api/devices').then(function (devs) { var d = devs.filter(function (x) { return x.conn === conn; })[0]; if (d) { name = d.name; $('.rm-dev').textContent = d.name; drawTarget(); } else V.router.go('#/remote', true); });
  V.pageCleanup = function () { clearInterval(t); off(); cmd('unwatch'); };
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
