/* The player's layout: which control sits where, for each way the player is shown — a computer, a phone held upright
   with the video on top of its page, upright full screen, sideways, and the small player — each for films and
   episodes or for live TV. The admin arranges them in Admin → Player layout (V.adminTabs.player, below); what they
   don't change stays as built in. The built-in arrangement (2.8.7) is the household's own, made in the layout sampler.
   - V.plLayout(id): the arrangement in force for a layout, { zone: [control, …] } — every control exactly once.
   - V.plLayoutId(): which layout the player is in now.  V.relayout(): puts the controls where they belong.
   The player's markup (player.js) has a box per zone (.vz[data-z=…]); the small player's buttons are drawn here. */
'use strict';
(function () {
  // ---------------------------------------------------------------- controls
  // n: name · ic: icon · t: drawn as text · when: when it shows at all (whatever the layout) · lock: can't be hidden
  var C = {
    back: { n: 'Back', ic: 'back', lock: 1, when: 'Always. Full screen: leaves the player. On top of its page: makes it the small player.' },
    title: { n: 'Title', t: 'title', when: 'Always: the title, and the episode or programme under it.' },
    party: { n: 'Watch together', ic: 'party', some: 1, when: 'When watch parties are allowed (Admin → Playback). Not on catch-up.' },
    cast: { n: 'Cast', ic: 'cast', some: 1, when: 'In Chrome on the https address, when there’s a Chromecast to cast to.' },
    mini: { n: 'Small player', ic: 'mini', when: 'Keep watching in a corner while you browse.' },
    play: { n: 'Play / pause', ic: 'play', lock: 1, when: 'Always.' },
    rw: { n: 'Back 10 seconds', ic: 'rw', some: 1, when: 'Films, episodes and catch-up.' },
    ff: { n: 'Forward 30 seconds', ic: 'ff', some: 1, when: 'Films, episodes and catch-up.' },
    vol: { n: 'Volume', ic: 'vol', when: 'Always. A slider opens beside it on a computer.' },
    golive: { n: 'Live / Back to live', t: 'live', some: 1, when: 'Live TV and catch-up.' },
    next: { n: 'Next episode', ic: 'skipnext', some: 1, when: 'Episodes with a next one.' },
    episodes: { n: 'Episodes', ic: 'stack', some: 1, when: 'Episodes: the series’ episodes beside the video.' },
    channels: { n: 'Channels', ic: 'list', some: 1, when: 'Live TV, radio and catch-up: the channel list beside the video.' },
    audioonly: { n: 'Sound only', ic: 'headphones', some: 1, when: 'Live TV: picture off, less data. Also in Settings.' },
    cc: { n: 'Subtitles and audio', ic: 'cc', when: 'Always.' },
    bookmark: { n: 'Bookmark', ic: 'bookmark', some: 1, when: 'Films and episodes.' },
    gear: { n: 'Settings', ic: 'gear', lock: 1, when: 'Always: quality, speed, sleep timer, source, picture, sound and more.' },
    hidectl: { n: 'Hide the controls', ic: 'eyeoff', some: 1, when: 'With a mouse: hides everything until the mouse moves. Never on touch screens or TVs.' },
    pip: { n: 'Picture in picture', ic: 'pip', some: 1, when: 'Browsers that have picture in picture.' },
    fs: { n: 'Full screen', ic: 'fs', when: 'Always.' },
    elapsed: { n: 'Time played', t: 'time', txt: '24:10', when: 'Always (live TV: how far behind live).' },
    timeleft: { n: 'Time left / Ends at', t: 'time', txt: '−18:52', some: 1, when: 'Films, episodes and catch-up. Press it for the clock time it ends.' },
    mclose: { n: 'Stop', ic: 'x', lock: 1, act: 'close', when: 'Small player: stops and closes it.' },
    mmute: { n: 'Mute', ic: 'vol', act: 'mute', when: 'Small player.' },
    mopen: { n: 'Back to full screen', ic: 'fs', act: 'open', when: 'Small player. Tapping the video does the same.' },
    mplay: { n: 'Play / pause', ic: 'play', act: 'toggle', when: 'Small player.' },
    mrw: { n: 'Back 10 seconds', ic: 'rw', act: 'rw', some: 1, when: 'Small player: films, episodes and catch-up.' },
    mff: { n: 'Forward 30 seconds', ic: 'ff', act: 'ff', some: 1, when: 'Small player: films, episodes and catch-up.' },
    mnext: { n: 'Next episode', ic: 'skipnext', act: 'next', some: 1, when: 'Small player: episodes with a next one.' }
  };
  V.PL_CONTROLS = C;
  var ZN = { 'top-left': 'Top bar, left', 'top-right': 'Top bar, right', center: 'Middle of the picture', 'seek-left': 'Before the seek bar', 'seek-right': 'After the seek bar', 'row-left': 'Control bar, left', 'row-right': 'Control bar, right', 'mini-left': 'Top left', 'mini-right': 'Top right', hidden: 'Not shown' };

  // ---------------------------------------------------------------- the layouts, as built in
  var TOP = function () { return { 'top-left': ['back', 'title'], 'top-right': ['mini', 'party', 'cast', 'gear'] }; };
  var mk = function (o) { var t = TOP(); Object.keys(o).forEach(function (k) { t[k] = o[k]; }); return t; };
  var VOD_BIG = function () { return mk({ center: ['rw', 'play', 'ff'], 'seek-left': ['elapsed'], 'seek-right': ['timeleft'], 'row-left': ['vol'], 'row-right': ['next', 'episodes', 'cc', 'bookmark', 'pip', 'fs'], hidden: ['golive', 'channels', 'audioonly', 'hidectl'] }); };
  var LIVE_BIG = function () { return mk({ center: ['play'], 'seek-left': ['elapsed'], 'seek-right': [], 'row-left': ['vol', 'golive'], 'row-right': ['channels', 'cc', 'pip', 'fs'], hidden: ['rw', 'ff', 'bookmark', 'timeleft', 'next', 'episodes', 'audioonly', 'hidectl'] }); };
  var MINI = function () { return { 'mini-left': ['mclose'], 'mini-right': ['mmute', 'mopen'], hidden: ['mplay', 'mrw', 'mff', 'mnext'] }; };
  var phoneUp = VOD_BIG(); phoneUp['row-right'] = ['next', 'cc', 'bookmark', 'pip', 'fs']; phoneUp.hidden = ['episodes', 'golive', 'channels', 'audioonly', 'hidectl'];
  V.PL_DEFAULT = {
    'desk-episode': mk({ center: [], 'seek-left': ['elapsed'], 'seek-right': ['timeleft'], 'row-left': ['play', 'rw', 'ff', 'vol'], 'row-right': ['next', 'episodes', 'cc', 'bookmark', 'pip', 'fs'], hidden: ['golive', 'channels', 'audioonly', 'hidectl'] }),
    'desk-live': mk({ center: [], 'seek-left': ['elapsed'], 'seek-right': [], 'row-left': ['play', 'vol', 'golive'], 'row-right': ['channels', 'cc', 'pip', 'fs'], hidden: ['rw', 'ff', 'bookmark', 'timeleft', 'next', 'episodes', 'hidectl', 'audioonly'] }),
    'desk-mini': MINI(),
    'phone-up-episode': phoneUp,
    'phone-up-live': LIVE_BIG(),
    'phone-up-full': VOD_BIG(),
    'phone-up-full-live': LIVE_BIG(),
    'phone-side-episode': VOD_BIG(),
    'phone-side-live': LIVE_BIG(),
    'phone-mini': MINI()
  };
  // How each one is shown in the editor.
  var LAYOUTS = [
    { id: 'desk-episode', g: 'Computer', name: 'Film or episode', shape: 'desk', note: 'The player filling the window or the screen.' },
    { id: 'desk-live', g: 'Computer', name: 'Live TV', shape: 'desk', live: 1, note: 'Live channels and radio, and catch-up (which also gets the film controls this one hides, where Film or episode has them).' },
    { id: 'desk-mini', g: 'Computer', name: 'Small player', shape: 'mini', note: 'In a corner while you browse.' },
    { id: 'phone-up-episode', g: 'Phone', name: 'Upright · film or episode', shape: 'dock', note: 'Held upright: the video on top of its page.' },
    { id: 'phone-up-live', g: 'Phone', name: 'Upright · live TV', shape: 'dock', live: 1, note: 'Held upright: the video on top of the channel’s page.' },
    { id: 'phone-up-full', g: 'Phone', name: 'Upright full screen · film or episode', shape: 'upfull', note: 'Held upright with “video on top of its page” switched off.' },
    { id: 'phone-up-full-live', g: 'Phone', name: 'Upright full screen · live TV', shape: 'upfull', live: 1, note: 'Held upright with “video on top of its page” switched off.' },
    { id: 'phone-side-episode', g: 'Phone', name: 'Sideways · film or episode', shape: 'side', note: 'Turned sideways, or with Full screen.' },
    { id: 'phone-side-live', g: 'Phone', name: 'Sideways · live TV', shape: 'side', live: 1, note: 'Turned sideways, or with Full screen.' },
    { id: 'phone-mini', g: 'Phone', name: 'Small player', shape: 'mini', note: 'In a corner while you browse; tap it to bring it back.' }
  ];
  var idsOf = function (z) { var a = []; Object.keys(z).forEach(function (k) { a = a.concat(z[k]); }); return a; };

  /** The admin's arrangement completed from the built-in one: each control once, none lost, the locked ones shown. */
  var complete = function (id, a) {
    var d = V.PL_DEFAULT[id], ids = idsOf(d), seen = {}, out = {};
    Object.keys(d).forEach(function (z) {
      out[z] = ((a && a[z]) || []).filter(function (c) { if (seen[c] || ids.indexOf(c) < 0) return false; seen[c] = 1; return true; });
    });
    // (Not mentioned — a control added in a later version — where the built-in arrangement has it.)
    Object.keys(d).forEach(function (z) { d[z].forEach(function (c) { if (!seen[c]) { out[z].push(c); seen[c] = 1; } }); });
    out.hidden = out.hidden.filter(function (c) {
      if (!C[c].lock) return true;
      var home = Object.keys(d).filter(function (z) { return z !== 'hidden' && d[z].indexOf(c) >= 0; })[0];
      out[home].push(c);
      return false;
    });
    return out;
  };
  V.plLayout = function (id) {
    var all = S.settings && S.settings.playerLayout;
    return complete(id, all && all[id]);
  };

  // ---------------------------------------------------------------- which one, and putting the controls there
  var isPhone = function () { return !!(V.device && V.device.touch) && !V.tvMode && Math.min(window.innerWidth, window.innerHeight) <= 900; };
  V.plLayoutId = function () {
    var it = V.watch && V.watch.it, live = !!(it && /^(live|radio|catchup)$/.test(it.t)), phone = isPhone();
    if (V.watch && V.watch.mini) return phone ? 'phone-mini' : 'desk-mini';
    if (!phone) return live ? 'desk-live' : 'desk-episode';
    if (V.watch && V.watch.dock) return live ? 'phone-up-live' : 'phone-up-episode';
    if (window.innerHeight > window.innerWidth) return live ? 'phone-up-full-live' : 'phone-up-full';
    return live ? 'phone-side-live' : 'phone-side-episode';
  };
  /** Catch-up uses the live layout, plus the film controls it hides where the film layout of the same kind has them. */
  var forItem = function (id, it) {
    var z = V.plLayout(id);
    if (!it || it.t !== 'catchup' || !/live$/.test(id)) return z;
    var vod = V.plLayout(id === 'phone-up-full-live' ? 'phone-up-full' : id.replace(/-live$/, '-episode'));
    ['rw', 'ff', 'timeleft'].forEach(function (c) {
      if (z.hidden.indexOf(c) < 0) return;
      var at = Object.keys(vod).filter(function (k) { return k !== 'hidden' && vod[k].indexOf(c) >= 0; })[0];
      if (!at) return;
      z.hidden.splice(z.hidden.indexOf(c), 1);
      // (Next to its neighbour in the film layout when that one's in the same place here.)
      var i = vod[at].indexOf(c), nb = vod[at][i + 1] && z[at].indexOf(vod[at][i + 1]);
      if (nb >= 0) z[at].splice(nb, 0, c); else z[at].push(c);
    });
    return z;
  };
  var EL = { title: '.vp-titles', vol: '.vol-wrap', elapsed: '.vp-t1', timeleft: '.vp-t2' };
  V.relayout = function () {
    var p = V.player;
    if (!p || !p.host) return;
    var id = V.plLayoutId(), it = V.watch && V.watch.it, mini = /mini$/.test(id);
    if (mini) { drawMini(id); return; }
    var z = forItem(id, it), key = id + JSON.stringify(z);
    if (p._plKey === key) return;
    p._plKey = key;
    if (!p._plEls) { p._plEls = {}; Object.keys(C).forEach(function (c) { if (!C[c].act) p._plEls[c] = V.$('.vz ' + (EL[c] || '[data-a=' + c + ']'), p.host); }); }
    var had = document.activeElement;
    Object.keys(z).forEach(function (zn) {
      var box = V.$('.vz[data-z="' + zn + '"]', p.host);
      if (box) z[zn].forEach(function (c) { var el = p._plEls[c]; if (el) box.appendChild(el); });
    });
    // (Moving a control takes the focus off it: put it back.)
    if (had && had !== document.activeElement && p.host.contains(had)) try { had.focus({ preventScroll: true }); } catch (e) {}
    p.host.setAttribute('data-layout', id);
  };

  // The small player's buttons, drawn for the layout in force.
  var drawMini = function (id) {
    var layer = V.$('#player-layer'), p = V.player;
    if (!layer || !p) return;
    var z = V.plLayout(id), v = p.video, vod = !!p.vod;
    var nextB = V.$('[data-a=next]', p.host);
    ['mini-left', 'mini-right'].forEach(function (zn) {
      var box = V.$('.mini-bar[data-z="' + zn + '"]', layer);
      if (!box) return;
      box.innerHTML = z[zn].map(function (c) {
        var d = C[c], ic = d.ic, n = d.n;
        if (c === 'mmute' && v && v.muted) { ic = 'mute'; n = 'Unmute'; }
        if (c === 'mplay' && v && !v.paused) { ic = 'pause'; n = 'Pause'; }
        var off = ((c === 'mrw' || c === 'mff') && !vod) || (c === 'mnext' && (!nextB || nextB.hidden));
        return off ? '' : '<button class="icon-btn sm" data-mini="' + d.act + '" aria-label="' + V.esc(n) + '" title="' + V.esc(n) + '">' + V.icon(ic) + '</button>';
      }).join('');
    });
  };
  V.drawMiniBar = function () { if (V.watch && V.watch.mini) drawMini(V.plLayoutId()); };
  // (The mute and play buttons show what they'd do: follow the video.)
  ['volumechange', 'play', 'pause'].forEach(function (ev) { document.addEventListener(ev, function () { if (V.watch && V.watch.mini) V.drawMiniBar(); }, true); });
  var rt = null;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { var l = V.$('#player-layer'); if (l && !l.hidden) V.relayout(); }, 150); });
  V.on('settings', function () { var l = V.$('#player-layer'); if (V.player) V.player._plKey = null; if (l && !l.hidden) { V.relayout(); V.drawMiniBar(); } });

  // ---------------------------------------------------------------- Admin → Player layout
  (V.adminExtraTabs = V.adminExtraTabs || []).push(['player', 'Player layout', 'playback']);
  V.adminTabs = V.adminTabs || {};
  V.adminTabs.player = function (body, A) {
    var saved = JSON.parse(JSON.stringify((A.settings && A.settings.playerLayout) || {}));
    var work = {};
    LAYOUTS.forEach(function (l) { work[l.id] = complete(l.id, saved[l.id]); });
    var cur = 'desk-episode', sel = null, drag = null, saveT = null;
    try { var rem = V.ls.get('plEditor', ''); if (V.PL_DEFAULT[rem]) cur = rem; } catch (e) {}
    var L = function (id) { return LAYOUTS.filter(function (l) { return l.id === id; })[0]; };
    var same = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
    var changed = function (id) { return !same(work[id], complete(id, null)); };

    var chip = function (c) {
      var d = C[c], l = L(cur), on = sel === c, inner, cls = 'ple-c';
      if (d.ic) { cls += ' ic'; inner = V.icon(d.ic) + '<span class="ple-n">' + V.esc(d.n) + '</span>'; }
      else if (d.t === 'title') { cls += ' tx ttl'; inner = '<b>' + (l.live ? 'Nova News 24' : 'Harbor Lights') + '</b><small>' + (l.live ? 'Morning Briefing' : 'S1 · E2 · The Tide Line') + '</small>'; }
      else if (d.t === 'live') { cls += ' tx lv'; inner = 'Live'; }
      else { cls += ' tx tm'; inner = l.live && c === 'elapsed' ? '−0:42' : d.txt; }
      if (d.some) cls += ' some';
      if (c === 'play' && cur.indexOf('mini') < 0) cls += ' big';
      return '<button type="button" class="' + cls + (on ? ' on' : '') + '" data-c="' + c + '" aria-pressed="' + on + '" title="' + V.esc(d.n) + '" aria-label="' + V.esc(d.n) + '">' + inner + '</button>';
    };
    var zone = function (zn, extra) {
      var list = work[cur][zn] || [];
      return '<div class="ple-z' + (list.length ? '' : ' empty') + (extra ? ' ' + extra : '') + '" data-z="' + zn + '" data-label="' + ZN[zn] + '">' + list.map(chip).join('') + '</div>';
    };
    var frame = function () {
      var l = L(cur);
      if (l.shape === 'mini') return '<div class="ple-dev mini-page ' + (cur === 'phone-mini' ? 'ph' : 'pc') + '"><div class="ple-under">' + new Array(cur === 'phone-mini' ? 10 : 19).join('<i></i>') + '</div><div class="ple-mini"><div class="ple-pic"></div>' + zone('mini-left', 'ml') + zone('mini-right', 'mr') + '</div></div>';
      var ui = '<div class="ple-ui"><div class="ple-row">' + zone('top-left', 'grow') + zone('top-right') + '</div>' +
        '<div class="ple-mid">' + zone('center') + '</div>' +
        '<div class="ple-row">' + zone('seek-left') + '<div class="ple-track' + (l.live ? ' lv' : '') + '"><i></i></div>' + zone('seek-right') + '</div>' +
        '<div class="ple-row">' + zone('row-left') + '<span class="grow"></span>' + zone('row-right') + '</div></div>';
      var pic = '<div class="ple-pic' + (l.live ? ' lv' : '') + '"></div>';
      if (l.shape === 'dock') return '<div class="ple-dev dock"><div class="ple-strip">' + pic + ui + '</div><div class="ple-page"><b>' + (l.live ? 'Nova News 24' : 'Harbor Lights') + '</b><span>' + (l.live ? 'The channel’s page: today’s schedule' : 'The title page: episodes, details, cast, reviews, more like this') + '</span></div></div>';
      return '<div class="ple-dev ' + l.shape + '">' + pic + ui + '</div>';
    };
    var draw = function () {
      var l = L(cur), z = sel && work[cur], at = null;
      if (sel) Object.keys(z).forEach(function (k) { if (z[k].indexOf(sel) >= 0) at = k; });
      var d = sel && C[sel];
      var groups = ['Computer', 'Phone'].map(function (g) {
        return '<div class="ple-g"><span class="ple-gh">' + g + '</span>' + LAYOUTS.filter(function (x) { return x.g === g; }).map(function (x) {
          return '<button type="button" class="chip' + (x.id === cur ? ' on' : '') + '" data-lay="' + x.id + '" aria-pressed="' + (x.id === cur) + '">' + V.esc(x.name) + (changed(x.id) ? ' <span class="ple-dot" title="Changed">•</span>' : '') + '</button>';
        }).join('') + '</div>';
      }).join('');
      body.innerHTML = '<section class="card adm-sec ple">' +
        '<p class="dim">Where each control sits in the player, for every way it’s shown. Drag a control to another place, or into “Not shown” to leave it out; or tap one and use the buttons under the picture. Changes save by themselves and reach every screen at once. A control with a dashed outline only shows up sometimes (tap it to see when).</p>' +
        '<label class="switch"><input type="checkbox" data-tappause' + (A.settings.tapToPause ? ' checked' : '') + '><span class="sw"></span><span><b>Tap or click the picture to pause</b><small>Off: only the pause button pauses, and a tap on the picture shows or hides the controls (a click shows them). The small player works as before either way.</small></span></label>' +
        '<div class="ple-groups">' + groups + '</div>' +
        '<div class="ple-head"><h3>' + V.esc(l.g + ' · ' + l.name) + '</h3><span class="dim small">' + V.esc(l.note) + '</span></div>' +
        '<div class="ple-stage">' + frame() + '</div>' +
        '<div class="ple-tray"><span class="ple-gh">Not shown here</span>' + zone('hidden', 'tray') + '</div>' +
        '<div class="ple-insp" aria-live="polite">' + (d ? '<div class="grow"><b>' + V.esc(d.n) + '</b> <span class="dim small">· ' + V.esc(ZN[at]) + '</span><div class="dim small">' + V.esc(d.when) + (d.lock ? ' Can’t be left out.' : '') + '</div></div>' +
          '<div class="ple-acts"><button type="button" class="btn sm" data-mv="-1"' + (z[at].indexOf(sel) === 0 ? ' disabled' : '') + '>◀ Earlier</button><button type="button" class="btn sm" data-mv="1"' + (z[at].indexOf(sel) === z[at].length - 1 ? ' disabled' : '') + '>Later ▶</button>' +
          '<label class="sr-only" for="ple-to">Move to</label><select class="input sm" id="ple-to">' + Object.keys(z).filter(function (k) { return k !== 'hidden' || !d.lock; }).map(function (k) { return '<option value="' + k + '"' + (k === at ? ' selected' : '') + '>' + (k === at ? 'Move to…' : ZN[k]) + '</option>'; }).join('') + '</select>' +
          '<button type="button" class="btn sm" data-done>Done</button></div>'
          : '<span class="dim small">Tap a control to move it without dragging.</span>') + '</div>' +
        '<div class="btn-row"><button type="button" class="btn" data-reset' + (changed(cur) ? '' : ' disabled') + '>Back to the built-in layout</button><button type="button" class="btn" data-reset-all' + (LAYOUTS.some(function (x) { return changed(x.id); }) ? '' : ' disabled') + '>All layouts back to built-in</button><span class="dim small ple-saved"></span></div>' +
        '</section>';
      if (sel) { var b = V.$('.ple-c[data-c="' + sel + '"]', body); if (b) b.focus({ preventScroll: true }); }
    };
    var save = function () {
      clearTimeout(saveT);
      saveT = setTimeout(function () {
        var o = {};
        LAYOUTS.forEach(function (l) { if (changed(l.id)) o[l.id] = work[l.id]; });
        V.put('/api/admin/settings', { playerLayout: Object.keys(o).length ? o : null }).then(function (s) {
          S.admin.settings = s; S.settings.playerLayout = s.playerLayout || null; V.emit('settings');
          var t = V.$('.ple-saved', body); if (t) t.textContent = 'Saved';
        }).catch(V.fail);
      }, 400);
    };
    var where = function (c) { var z = work[cur]; for (var k in z) if (z[k].indexOf(c) >= 0) return { z: k, i: z[k].indexOf(c) }; return null; };
    var move = function (c, zn, i) {
      var z = work[cur], w = where(c);
      if (!w || !z[zn] || (zn === 'hidden' && C[c].lock)) { if (zn === 'hidden') V.toast(C[c].n + ' can’t be left out'); return; }
      z[w.z].splice(w.i, 1);
      if (w.z === zn && i > w.i) i--;
      i = i === null || i === undefined ? z[zn].length : Math.max(0, Math.min(i, z[zn].length));
      z[zn].splice(i, 0, c);
      sel = c; draw(); save();
    };
    body.onclick = function (e) {
      var t = e.target;
      var lay = t.closest('[data-lay]');
      if (lay) { cur = lay.getAttribute('data-lay'); sel = null; try { V.ls.set('plEditor', cur); } catch (er) {} draw(); return; }
      var ch = t.closest('.ple-c');
      if (ch && e.detail === 0) { sel = sel === ch.dataset.c ? null : ch.dataset.c; draw(); return; }
      var mv = t.closest('[data-mv]');
      if (mv && sel) { var w = where(sel); move(sel, w.z, w.i + (mv.getAttribute('data-mv') === '1' ? 2 : -1)); return; }
      if (t.closest('[data-done]')) { sel = null; draw(); return; }
      if (t.closest('[data-reset]')) { work[cur] = complete(cur, null); sel = null; draw(); save(); return; }
      if (t.closest('[data-reset-all]')) {
        V.confirm('Put every layout back to the built-in one?', { title: 'Player layout', ok: 'Put back' }).then(function (ok) { if (ok) all(); });
      }
    };
    var all = function () { LAYOUTS.forEach(function (l) { work[l.id] = complete(l.id, null); }); sel = null; draw(); save(); };
    body.onchange = function (e) {
      if (e.target.id === 'ple-to' && sel) move(sel, e.target.value, null);
      if (e.target.hasAttribute('data-tappause')) V.adminSave({ tapToPause: e.target.checked }).then(function (s) { A.settings = s; S.settings.tapToPause = !!s.tapToPause; }).catch(function () {});
    };

    // Dragging: mouse, pen or finger; a press without moving selects instead.
    var zoneAt = function (x, y) { var el = document.elementFromPoint(x, y), z = el && el.closest('.ple-z'); return z && body.contains(z) ? z : null; };
    var indexIn = function (z, x, y) {
      var kids = Array.prototype.filter.call(z.children, function (k) { return k.classList.contains('ple-c') && !k.classList.contains('src'); });
      for (var i = 0; i < kids.length; i++) { var r = kids[i].getBoundingClientRect(); if (y < r.top - 4) return i; if (y <= r.bottom + 4 && x < r.left + r.width / 2) return i; }
      return kids.length;
    };
    var unhot = function () { Array.prototype.forEach.call(body.querySelectorAll('.ple-z.hot'), function (z) { z.classList.remove('hot'); }); var ph = V.$('.ple-ph', body); if (ph) ph.parentNode.removeChild(ph); };
    body.onpointerdown = function (e) {
      var ch = e.target.closest('.ple-c');
      if (!ch || e.button > 0) return;
      drag = { ch: ch, c: ch.dataset.c, x: e.clientX, y: e.clientY, on: false, id: e.pointerId };
    };
    var onMove = function (e) {
      if (!document.documentElement.contains(body)) return detach();
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.on) {
        if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 7) return;
        drag.on = true;
        drag.g = drag.ch.cloneNode(true); drag.g.className += ' ghost'; document.body.appendChild(drag.g);
        drag.ch.classList.add('src'); body.classList.add('ple-dragging');
      }
      if (e.cancelable) e.preventDefault();
      var r = drag.g.getBoundingClientRect();
      drag.g.style.left = (e.clientX - r.width / 2) + 'px'; drag.g.style.top = (e.clientY - r.height / 2) + 'px';
      unhot();
      var z = zoneAt(e.clientX, e.clientY);
      if (z) {
        z.classList.add('hot');
        var kids = Array.prototype.filter.call(z.children, function (k) { return k.classList.contains('ple-c') && !k.classList.contains('src'); });
        var ph = document.createElement('span'); ph.className = 'ple-ph';
        z.insertBefore(ph, kids[indexIn(z, e.clientX, e.clientY)] || null);
      }
    };
    var onUp = function (e, cancel) {
      if (!drag || e.pointerId !== drag.id) return;
      var d = drag; drag = null;
      if (!d.on) { if (!cancel) { sel = sel === d.c ? null : d.c; draw(); } return; }
      var z = cancel ? null : zoneAt(e.clientX, e.clientY), i = z ? indexIn(z, e.clientX, e.clientY) : null;
      unhot(); if (d.g.parentNode) d.g.parentNode.removeChild(d.g); body.classList.remove('ple-dragging');
      if (z) move(d.c, z.getAttribute('data-z'), i); else d.ch.classList.remove('src');
    };
    var up = function (e) { onUp(e, false); }, cancel = function (e) { onUp(e, true); };
    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    // (Gone once the page has changed.)
    var detach = function () { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel); };
    draw();
  };
})();
