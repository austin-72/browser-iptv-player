/* TV guide grid: channels down the side, time across. Only the rows on screen are drawn. */
'use strict';
V.route('guide', function (view, r) {
  var PX = V.device.touch && window.innerWidth < 700 ? 4 : 6; // pixels per minute
  var ROW = 64;
  var dayOff = parseInt(r.q.get('d') || '0', 10) || 0;
  var g = r.q.get('g') || V.startGroup('guide', V.ls.get('guidegroup')) || '';
  var colours = V.pref('guideColours') !== false;
  var onlyEpg = V.ls.get('guideOnlyEpg', true);
  var maxPast = Math.max(0, Math.min(7, S.live.reduce(function (m, c) { return c.cu ? Math.max(m, (c.cu.days || 7)) : m; }, 0)));
  var day0 = new Date(); day0.setHours(0, 0, 0, 0);
  var start = day0.getTime() + dayOff * 86400e3;
  var end = start + 86400e3;
  var groups = V.groupsOf('live').sort(function (a, b) { return a.name.localeCompare(b.name); });
  // Only channels in your languages (Settings → Languages): ones whose language couldn't be worked out stay out
  // of the guide (they're still on the Live TV page). Favourites always show.
  var want = (S.profile && S.profile.langs && S.profile.langs.length ? S.profile.langs : (S.settings.defaultLangs || []));
  var langOk = function (c) { if (!want.length || V.inList('favs', c.k)) return true; return (c.lg || []).some(function (l) { return want.indexOf(l) >= 0; }); };
  var mine = g === '__fav' || g.indexOf('__my:') === 0;
  var chans = (g ? V.channelsFor(g, 'live') : S.live).filter(function (c) { return (!onlyEpg || c.E) && (mine || langOk(c)); });
  var dayOpts = [];
  for (var d = -maxPast; d <= 7; d++) dayOpts.push('<option value="' + d + '"' + (d === dayOff ? ' selected' : '') + '>' + V.fmtDay(day0.getTime() + d * 86400e3 + 3600e3) + '</option>');
  view.innerHTML = V.pageHead('TV guide', '<div class="page-tools">' +
    '<select class="input" data-day aria-label="Day">' + dayOpts.join('') + '</select>' +
    '<select class="input" data-grp aria-label="Group">' + V.channelGroups('live', { recent: false, empty: true }).map(function (x) { return '<option value="' + V.esc(x.v) + '"' + (x.v === g ? ' selected' : '') + '>' + V.esc(x.l) + '</option>'; }).join('') + '</select>' +
    '<label class="check"><input type="checkbox" data-only' + (onlyEpg ? ' checked' : '') + '><span>Only with listings</span></label>' +
    '<button class="btn" data-now>' + V.icon('clock') + ' Now</button>' +
    '<form class="inline" data-sf><input class="input" type="search" placeholder="Search listings" aria-label="Search listings" data-sq><button class="btn" aria-label="Search">' + V.icon('search') + '</button></form>' +
    '<a class="btn" href="#/onlater">' + V.icon('bell') + ' On later</a></div>') + V.guideLegend(colours) +
    '<div class="guide" tabindex="-1"><div class="g-corner">' + V.esc(V.fmtDay(start + 3600e3)) + '</div><div class="g-times"></div><div class="g-chans"></div><div class="g-body"><div class="g-canvas"></div><div class="g-nowline"></div></div></div>';
  if (!chans.length) { V.$('.guide', view).outerHTML = V.empty('No guide listings', S.live.length ? 'None of these channels have TV listings. Untick “Only with listings” to see them anyway.' : 'There are no live channels.'); bindTools(); return; }
  var body = V.$('.g-body', view), canvas = V.$('.g-canvas', view), times = V.$('.g-times', view), side = V.$('.g-chans', view), nowline = V.$('.g-nowline', view);
  var width = (end - start) / 60000 * PX;
  canvas.style.width = width + 'px';
  canvas.style.height = chans.length * ROW + 'px';
  side.style.height = chans.length * ROW + 'px';
  var th = '';
  for (var t = start; t < end; t += 1800e3) th += '<span style="left:' + (t - start) / 60000 * PX + 'px">' + V.fmtClock(t) + '</span>';
  times.innerHTML = '<div style="width:' + width + 'px">' + th + '</div>';
  var drawn = new Set();
  var px = function (ms) { return (ms - start) / 60000 * PX; };
  function draw() {
    var top = body.scrollTop, h = body.clientHeight;
    var a = Math.max(0, Math.floor(top / ROW) - 4), b = Math.min(chans.length, Math.ceil((top + h) / ROW) + 4);
    var need = [];
    for (var i = a; i < b; i++) if (!drawn.has(i)) need.push(i);
    if (!need.length) return;
    need.forEach(function (i) { drawn.add(i); });
    var keys = need.map(function (i) { return chans[i].k; });
    side.insertAdjacentHTML('beforeend', need.map(function (i) { var c = chans[i]; return '<button class="g-ch" style="top:' + i * ROW + 'px" data-k="' + V.esc(c.k) + '" aria-label="' + V.esc(c.n) + '"><span class="num">' + (c.no || '') + '</span>' + V.art(c.i, c.n, 'art sm') + '<span class="truncate">' + V.esc(c.n) + '</span></button>'; }).join(''));
    V.epg.range(keys, start, end).then(function (res) {
      var now = Date.now();
      var html = '';
      need.forEach(function (i) {
        var c = chans[i];
        var list = res[c.k] || [];
        if (!list.length) html += '<div class="gp none" style="top:' + i * ROW + 'px;left:0;width:' + width + 'px"><span class="gp-stick">' + (V.parental && !V.parental.open(c) ? V.icon('lock') + ' Locked' : 'No listings') + '</span></div>';
        list.forEach(function (p) {
          var l = Math.max(0, px(p.s)), rr = Math.min(width, px(p.e));
          if (rr - l < 2) return;
          var cls = (p.e <= now ? (V.catchup.canPlay(c, p) ? 'past arch' : 'past') : p.s <= now ? 'now' : '') + (p.ph ? ' ph' : colours ? ' k-' + (V.progKind(p, c) || 'none') : '');
          var rem = V.hasReminder(c, p);
          html += '<button class="gp ' + cls + '" style="top:' + i * ROW + 'px;left:' + l + 'px;width:' + (rr - l - 2) + 'px" data-k="' + V.esc(c.k) + '" data-s="' + p.s + '" title="' + V.esc(p.t + ' · ' + V.fmtClock(p.s) + '–' + V.fmtClock(p.e)) + '"><b class="truncate">' + (rem ? V.icon('bellf', 'tiny') : '') + V.esc(p.t) + '</b><small class="truncate">' + V.fmtClock(p.s) + (p.st ? ' · ' + V.esc(p.st) : '') + '</small></button>';
        });
        // The listings stop part-way through the day: say so in the empty space rather than leave it blank.
        var last = list.length ? list[list.length - 1].e : 0;
        if (last && last < end - 30 * 60e3) { var ll = Math.max(0, px(last)); html += '<div class="gp none" style="top:' + i * ROW + 'px;left:' + ll + 'px;width:' + (width - ll) + 'px"><span class="gp-stick">' + (last > start ? 'No listings after ' + V.fmtClock(last) : 'No listings') + '</span></div>'; }
      });
      canvas.insertAdjacentHTML('beforeend', html);
      if (wantNow) focusNow();
    });
  }
  var placeNow = function () { var n = Date.now(); nowline.hidden = n < start || n > end; nowline.style.left = px(n) + 'px'; nowline.style.height = chans.length * ROW + 'px'; };
  placeNow();
  var tdraw = V.throttle(draw, 80);
  body.addEventListener('scroll', function () { times.scrollLeft = body.scrollLeft; side.scrollTop = body.scrollTop; tdraw(); }, { passive: true });
  // From the start of the current half hour, so what's on now shows with its title (and the now line just after).
  var scrollNow = function () { body.scrollLeft = Math.max(0, px(Math.floor(Date.now() / 1800e3) * 1800e3) - 16); };
  if (dayOff === 0) scrollNow(); else body.scrollLeft = px(start + 18 * 3600e3);
  draw();
  setTimeout(draw, 50);
  // With a remote: start on what's on now on the first channel, not on the buttons above the guide.
  // (Once the programmes have arrived, and only if nothing else has been picked yet.)
  var wantNow = V.tvMode && dayOff === 0;
  function focusNow() {
    var a = document.activeElement;
    if (a && a !== document.body && !(a.closest && a.closest('.page-tools, .page-head'))) { wantNow = false; return; }
    var cur = V.$('.gp.now', canvas);
    if (cur) { wantNow = false; cur.focus({ preventScroll: true }); }
  }
  if (wantNow) setTimeout(function () { if (wantNow) focusNow(); }, 120);
  var tick = setInterval(placeNow, 30000);
  V.pageCleanup = function () { clearInterval(tick); };
  side.addEventListener('click', function (e) { var b = e.target.closest('[data-k]'); if (b) V.play(V.entry(b.dataset.k), { list: chans }); });
  canvas.addEventListener('click', function (e) {
    var b = e.target.closest('.gp[data-s]');
    if (!b) return;
    var c = V.entry(b.dataset.k);
    V.epg.range([c.k], start, end).then(function (res) { var p = (res[c.k] || []).filter(function (x) { return String(x.s) === b.dataset.s; })[0]; if (p) V.programmeDialog(c, p, chans); });
  });
  // Arrow keys move between programmes on TVs / keyboards.
  canvas.addEventListener('keydown', function (e) {
    var cur = e.target.closest('.gp');
    if (!cur || ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(e.key) < 0) return;
    e.preventDefault(); e.stopPropagation();
    if (cur.classList.contains('none')) return;
    var top = parseFloat(cur.style.top), left = parseFloat(cur.style.left), w = parseFloat(cur.style.width);
    var all = V.$$('.gp[data-s]', canvas);
    var best = null, bd = Infinity;
    all.forEach(function (x) {
      var t2 = parseFloat(x.style.top), l2 = parseFloat(x.style.left), w2 = parseFloat(x.style.width);
      var ok = e.key === 'ArrowRight' ? t2 === top && l2 > left : e.key === 'ArrowLeft' ? t2 === top && l2 < left : e.key === 'ArrowDown' ? t2 === top + ROW : t2 === top - ROW;
      if (!ok) return;
      var dd = e.key === 'ArrowRight' ? l2 - left : e.key === 'ArrowLeft' ? left - l2 : Math.abs((l2 + w2 / 2) - (left + w / 2));
      if (dd < bd) { bd = dd; best = x; }
    });
    if (best) { best.focus(); best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); setTimeout(draw, 60); }
    // At the edge of the guide (top row, first programme): on to the buttons above or the channel list.
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowLeft') && V.tvMove) {
      if (e.key === 'ArrowLeft') { var ch = V.$('.g-ch[style*="top:' + top + 'px"]', side); if (ch) { ch.focus({ preventScroll: true }); return; } }
      V.tvMove(e.key === 'ArrowUp' ? 'up' : 'left', cur);
    }
  });
  function bindTools() {
    var go = function (k, v) { var q = new URLSearchParams(r.q); if (v) q.set(k, v); else q.delete(k); V.router.go('#/guide' + (q.toString() ? '?' + q : ''), true); };
    V.$('[data-day]', view).onchange = function (e) { go('d', e.target.value === '0' ? '' : e.target.value); };
    V.$('[data-grp]', view).onchange = function (e) { V.ls.set('guidegroup', e.target.value); go('g', e.target.value); };
    V.$('[data-only]', view).onchange = function (e) { V.ls.set('guideOnlyEpg', e.target.checked); V.router.refresh(); };
    V.$('[data-now]', view).onclick = function () { if (dayOff) go('d', ''); else scrollNow(); };
    var lc = V.$('[data-colours]', view);
    if (lc) lc.onchange = function () { V.setPref('guideColours', lc.checked); V.router.refresh(); };
    V.$('[data-sf]', view).onsubmit = function (e) { e.preventDefault(); var q = V.$('[data-sq]', view).value.trim(); if (q) V.programmeSearch(q); };
  }
  bindTools();
});

V.programmeDialog = function (c, p, list) {
  var now = Date.now();
  var live = p.s <= now && p.e > now, past = p.e <= now;
  var cu = past && V.catchup.canPlay(c, p);
  var acts = [];
  if (live) { acts.push({ label: 'Watch live', primary: true, fn: function () { V.play(c, { list: list }); } }); if (V.catchup.available(c)) acts.push({ label: 'From the start', fn: function () { V.playCatchup(c, p, 0); } }); }
  else if (cu) acts.push({ label: 'Play', primary: true, fn: function () { V.playCatchup(c, p, 0); } });
  else if (!past) acts.push({ label: V.hasReminder(c, p) ? 'Cancel reminder' : 'Remind me', primary: true, fn: function () { V.toggleReminder(c, p); } });
  acts.push({ label: 'Channel page', fn: function () { V.router.go('#/channel/' + encodeURIComponent(c.k)); } });
  V.dialog({
    title: p.t,
    body: '<p class="dim">' + V.esc(c.n) + ' · ' + V.fmtDay(p.s) + ' ' + V.fmtClock(p.s) + '–' + V.fmtClock(p.e) + (p.ep ? ' · ' + V.esc(p.ep) : '') + '</p>' + (p.st ? '<p><b>' + V.esc(p.st) + '</b></p>' : '') + (p.ic ? '<img class="prog-img" src="' + V.esc(p.ic) + '" alt="" referrerpolicy="no-referrer">' : '') + (p.d ? '<p>' + V.esc(p.d) + '</p>' : '') + (p.c ? '<p class="dim">' + p.c.map(V.esc).join(' · ') + '</p>' : ''),
    actions: acts,
  });
};

V.programmeSearch = function (q) {
  V.epg.search(q).then(function (hits) {
    var now = Date.now();
    V.dialog({
      title: 'Listings matching “' + q + '”', wide: true,
      body: hits.length ? '<ul class="hits">' + hits.map(function (h, i) { var c = V.entry(h.k); if (!c) return ''; var past = h.e <= now; return '<li><button class="hit" data-i="' + i + '"><span class="dim num">' + V.fmtDay(h.s) + ' ' + V.fmtClock(h.s) + '</span><b>' + V.esc(h.t) + '</b><span class="dim truncate">' + V.esc(c.n) + (past ? (V.catchup.canPlay(c, h) ? ' · catch-up' : ' · ended') : h.s <= now ? ' · on now' : '') + '</span></button></li>'; }).join('') + '</ul>' : '<p>Nothing found in the guide.</p>',
      onOpen: function (d, finish) { d.addEventListener('click', function (e) { var b = e.target.closest('[data-i]'); if (!b) return; var h = hits[+b.dataset.i]; finish(); V.programmeDialog(V.entry(h.k), h); }); },
    });
  }).catch(V.fail);
};
