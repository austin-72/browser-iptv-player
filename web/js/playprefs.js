/* Player settings and small extras: skip lengths, buffer size, rewinding live TV, what the app does when it opens,
   what a reminder does, shuffle play for a series, and the extra entries in the player's and titles' menus. */
'use strict';
(function () {
  // ---------------------------------------------------------------- settings
  var opt = function (list, cur) { return list.map(function (o) { return '<option value="' + o[0] + '"' + (String(cur) === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>'; }).join(''); };
  V.playerPrefsHtml = function () {
    var secs = V.SKIP_CHOICES.map(function (n) { return [n, n + ' seconds']; });
    var onOpen = V.ls.get('onOpen', 'home');
    var chans = (S.live || []).concat(S.radio || []);
    var chosen = V.ls.get('onOpenChannel', '');
    return '<section class="card-sec player-prefs"><h2>Player</h2>' +
      '<div class="grid2"><label class="field"><span>Skip back</span><select class="input" data-pref-num="skipBack">' + opt(secs, V.skipLen('back')) + '</select></label>' +
      '<label class="field"><span>Skip forward</span><select class="input" data-pref-num="skipFwd">' + opt(secs, V.skipLen('fwd')) + '</select></label>' +
      '<label class="field wide"><span>When a reminder starts</span><select class="input" data-pref-sel="reminderAction">' + opt([['note', 'Show a note'], ['switch', 'Switch to the channel (10 s countdown)']], V.pref('reminderAction') || 'note') + '</select></label></div>' +
      '<h3>On this device</h3>' +
      '<div class="grid2"><label class="field"><span>Buffer</span><select class="input" data-ls-sel="bufferSize">' + opt([['normal', 'Normal'], ['large', 'Large (for a patchy connection)'], ['xlarge', 'Extra large (for unreliable providers)']], V.tune.bufKind()) + '</select><small class="dim">More buffer: fewer pauses, a few seconds more behind live.</small></label>' +
      '<label class="field"><span>Rewind live TV</span><select class="input" data-ls-sel="rewindMin">' + opt([[0, 'Off'], [5, 'Up to 5 minutes'], [15, 'Up to 15 minutes'], [30, 'Up to 30 minutes']], V.ls.get('rewindMin', 15)) + '</select><small class="dim">Keeps what this device has already played, so you can go back and pause. Uses this device’s memory, nothing on the server.</small></label>' +
      '<label class="field"><span>When the app opens</span><select class="input" data-ls-sel="onOpen">' + opt([['home', 'Home'], ['last', 'The last channel I watched'], ['channel', 'A channel I choose']], onOpen) + '</select></label>' +
      '<label class="field" data-open-ch' + (onOpen === 'channel' ? '' : ' hidden') + '><span>Channel</span><select class="input" data-ls-sel="onOpenChannel"><option value="">Choose a channel…</option>' + chans.map(function (c) { return '<option value="' + V.esc(c.k) + '"' + (c.k === chosen ? ' selected' : '') + '>' + V.esc((c.no ? c.no + ' · ' : '') + c.n) + '</option>'; }).join('') + '</select></label></div>' +
      '</section>';
  };
  V.bindPlayerPrefs = function (view) {
    view.addEventListener('change', function (e) {
      var t = e.target;
      if (t.dataset.prefNum) { V.setPref(t.dataset.prefNum, +t.value); V.toast('Saved'); }
      else if (t.dataset.lsSel) {
        var k = t.dataset.lsSel, v = k === 'rewindMin' ? +t.value : t.value;
        V.ls.set(k, v);
        if (k === 'onOpen') { var box = V.$('[data-open-ch]', view); if (box) box.hidden = v !== 'channel'; }
        V.toast(k === 'bufferSize' || k === 'rewindMin' ? 'Saved — from the next channel or video' : 'Saved');
      }
    });
  };

  // ---------------------------------------------------------------- when the app opens
  V.on('playing', function (it) { if (it && (it.t === 'live' || it.t === 'radio')) V.ls.set('lastChannelK', it.k); });
  /** Right after the app opens on Home (once per tab): play the last or a chosen channel, if this device wants that. */
  V.startupPlay = function () {
    var mode = V.ls.get('onOpen', 'home');
    if (mode === 'home' || V.ls.session('openedOnce')) return;
    V.ls.session('openedOnce', 1);
    if (!/^#\/home\b/.test(location.hash || '#/home')) return; // opened on a link to somewhere else
    var it = V.entry(mode === 'last' ? V.ls.get('lastChannelK', '') : V.ls.get('onOpenChannel', ''));
    // (After the first page has settled: a page drawn after it would shrink the player to the mini player.)
    if (it) setTimeout(function () { if (!V.watch.it && /^#\/home\b/.test(location.hash || '#/home')) V.play(it); }, 600);
  };

  // ---------------------------------------------------------------- reminders that switch channel
  /** "X starts now": switch to the channel after a 10 s countdown (Cancel / Switch now). */
  V.reminderSwitch = function (c, r) {
    if (V.watch && V.watch.it && V.watch.it.k === c.k) return;
    var box = V.$('#toasts');
    if (!box) return V.play(c);
    var t = document.createElement('div');
    t.className = 'toast rem-switch';
    t.setAttribute('role', 'alert');
    var left = 10;
    var text = function () { return '“' + r.t + '” is starting on ' + c.n + ' — switching in ' + left + ' s'; };
    t.innerHTML = '<span data-t>' + V.esc(text()) + '</span><button class="toast-act" data-go>Switch now</button><button class="toast-act" data-no>Cancel</button>';
    var timer;
    var close = function () { clearInterval(timer); t.classList.add('out'); setTimeout(function () { t.remove(); }, 250); };
    var go = function () { close(); V.play(c); };
    V.$('[data-go]', t).onclick = go;
    V.$('[data-no]', t).onclick = close;
    box.appendChild(t);
    timer = setInterval(function () { left--; if (left <= 0) go(); else V.$('[data-t]', t).textContent = text(); }, 1000);
    // On a TV the remote can reach it at once.
    if (V.tvMode) setTimeout(function () { var b = V.$('[data-no]', t); if (b) b.focus(); }, 50);
  };

  // ---------------------------------------------------------------- shuffle play
  var listOf = function (show) {
    var list = S.epsByShow.get(show.k) || [];
    if (show._eps && show._eps.length > list.length) list = show._eps;
    return list;
  };
  /** Plays a random episode (unwatched ones first), then keeps picking at random until something else is played. */
  V.shuffleShow = function (show) {
    if (!show) return;
    return V.loadEpisodes(show).then(function (eps) {
      eps = eps && eps.length ? eps : listOf(show);
      if (!eps.length) return V.toast('No episodes found', { error: true });
      V.watch.shuffle = { sk: show.k, played: {}, next: {} };
      var first = pick(null, eps);
      V.play(first, { startAt: 0 });
      V.toast('Shuffle on — episodes play in random order');
    }).catch(V.fail);
  };
  var pick = function (cur, list) {
    var sh = V.watch.shuffle;
    var pool = list.filter(function (e) { return (!cur || e.k !== cur.k) && !sh.played[e.k]; });
    var fresh = pool.filter(function (e) { var pr = V.progressOf(e.k); return !(pr && pr.w); });
    var cand = fresh.length ? fresh : pool;
    if (!cand.length) { sh.played = {}; cand = list.filter(function (e) { return !cur || e.k !== cur.k; }); }
    return cand[Math.floor(Math.random() * cand.length)] || null;
  };
  var origNext = V.nextEpisode;
  V.nextEpisode = function (ep) {
    var sh = V.watch && V.watch.shuffle;
    if (!sh || !ep || ep.sk !== sh.sk) return origNext(ep);
    if (sh.next[ep.k] !== undefined) return sh.next[ep.k];
    var show = V.entry(sh.sk);
    var n = show ? pick(ep, listOf(show)) : null;
    sh.next[ep.k] = n;
    return n;
  };
  V.on('playing', function (it) {
    var sh = V.watch && V.watch.shuffle;
    if (!sh) return;
    if (it && it.t === 'episode' && it.sk === sh.sk) sh.played[it.k] = 1;
    else V.watch.shuffle = null; // something else: shuffle ends
  });
  V.on('stopped', function () { if (V.watch) V.watch.shuffle = null; });

  // ---------------------------------------------------------------- menus
  V.playerMenuExtras = function (p, main, pages) {
    if (V.avsyncMenu) V.avsyncMenu(p, main, pages);
    if (V.audioOnlyMenu) V.audioOnlyMenu(p, main);
    if (V.extPlayerMenu) V.extPlayerMenu(p, main);
  };
  V.itemMenuExtras = function (items, it) {
    var at = items.indexOf(items.filter(function (x) { return x && x.sep; })[0]);
    if (at < 0) at = items.length;
    var add = [];
    if (it.t === 'show') add.push({ label: 'Shuffle play', icon: 'shuffle', fn: function () { V.shuffleShow(it); } });
    else if (it.t === 'live' || it.t === 'radio' || it.t === 'movie' || it.t === 'episode') add.push({ label: 'Open in another app…', icon: 'openapp', fn: function () { V.openInApp(it); } });
    items.splice.apply(items, [at, 0].concat(add));
  };
})();
