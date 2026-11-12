/* Home → "Right now": a small panel inside the big banner (or on its own when there's no banner) with what's
   happening in the household this minute — who else is watching, a watch party you're invited to, a new message,
   your next reminder and a couple of channels. Each part is only there when it has something to say; with nothing
   but channels it's just those; with no channels either there's no panel. It folds away to one line (remembered on
   this device), a profile can leave it out in Customise, and the admin can switch it off for everyone
   (Admin → Playback → What's switched on). */
'use strict';

V.rightNow = (function () {
  var soc = null, socAt = 0, fetching = null;
  var FOLD = 'home.rnFold';
  // Folded or open is remembered on each device. Until someone chooses: open where it sits beside the banner's title,
  // folded to its one line where it sits under it (a phone), so the rows below aren't pushed down the screen.
  var NARROW = '(max-width: 899px)';
  var folded = function () {
    var v = V.ls.get(FOLD, null);
    if (v == null) return !!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia(NARROW).matches);
    return !!v;
  };
  var wanted = function () { return !V.areaOff('rightnow') && (S.data.home.hidden || []).indexOf('rightnow') < 0; };
  var guest = function () { return !!(S.profile && S.profile.guest); };

  function social(force) {
    if (!force && soc && Date.now() - socAt < 20e3) return Promise.resolve(soc);
    if (fetching) return fetching;
    fetching = V.api('/api/social').then(function (s) {
      fetching = null; soc = s; socAt = Date.now();
      S.socialCache = s; S.unread = s.unread; if (V.updateUnread) V.updateUnread();
      return s;
    }, function (e) { fetching = null; throw e; });
    return fetching;
  }

  /** "in 40 min", "at 8:00 PM", "tomorrow at 8:00 PM". */
  function when(ms) {
    var d = ms - Date.now();
    if (d < 60e3) return 'now';
    if (d < 90 * 60e3) return 'in ' + Math.max(1, Math.round(d / 60e3)) + ' min';
    var day = V.fmtDay(ms);
    return (day === 'Today' ? '' : day === 'Tomorrow' ? 'tomorrow ' : day + ' ') + 'at ' + V.fmtClock(ms);
  }
  function titleOf(it, x) {
    // (An episode of a series this device hasn't opened yet: the server said which series and episode.)
    if (!it && x && x.sk) return { n: (V.entry(x.sk) || {}).n || x.n, sub: (x.s != null ? 'S' + x.s + ':E' + x.e : '') + (x.et ? ' · ' + x.et : '') };
    if (!it) return { n: x ? x.n : '', sub: '' };
    if (it.t === 'episode') return { n: (V.showOf(it) || {}).n || it.n, sub: V.epLabel(it) + (it.et ? ' · ' + it.et : '') };
    if (it.t === 'live' || it.t === 'radio') { var nn = V.epg.nowNext(it); return { n: it.n, sub: nn.now ? nn.now.t : '' }; }
    return { n: it.n, sub: it.y ? String(it.y) : '' };
  }

  /** The parts with something in them, in the order they matter: { id, html, sum }. */
  function parts(s) {
    var out = [], now = Date.now(), me = S.profile.id;
    var name = function (pid) { var p = (s.profiles || []).filter(function (x) { return x.id === pid; })[0]; return p ? p.name : 'Someone'; };
    var av = function (pid) { var p = (s.profiles || []).filter(function (x) { return x.id === pid; })[0]; return V.avatar(p ? p.avatar : 0, 'sm'); };

    // 1. Who else is watching (each profile decides whether others see this: Settings → Privacy)
    var seen = {};
    var pres = guest() ? [] : (s.presence || []).filter(function (x) { if (seen[x.pid] || !(V.entry(x.k) || (x.sk && V.entry(x.sk)))) return false; seen[x.pid] = 1; return true; });
    if (pres.length) {
      out.push({ id: 'who', sum: pres.length === 1 ? name(pres[0].pid) + ' is watching' : pres.length + ' people are watching', html: pres.slice(0, 3).map(function (x, i) {
        var it = V.entry(x.k), t = titleOf(it, x), who = name(x.pid), play = 'data-rn-play="' + V.esc(x.k) + '"' + (x.sk ? ' data-rn-sk="' + V.esc(x.sk) + '"' : '');
        var sub = [t.sub, x.tv ? 'on the TV' : ''].filter(Boolean).join(' · ');
        return '<div class="rn-row"><span class="rn-av">' + av(x.pid) + '<i class="rn-dot" aria-hidden="true"></i></span><span class="rn-tx"><b>' + V.esc(who) + ' is watching ' + V.esc(t.n) + '</b>' + (sub ? '<small>' + V.esc(sub) + '</small>' : '') + '</span>' +
          (i ? '<button class="icon-btn sm" ' + play + ' aria-label="Watch ' + V.esc(t.n) + ' too">' + V.icon('play') + '</button>' : '') + '</div>' +
          (i ? '' : '<div class="rn-acts"><button class="btn sm primary" ' + play + '>' + V.icon('play') + ' Watch it too</button><a class="btn sm" href="#/remote">' + V.icon('remote') + ' Use as remote</a></div>');
      }).join('') });
    }

    // 2. A watch party you're invited to and haven't joined
    var inv = guest() || (S.settings && S.settings.allowParties === false) ? [] : (s.parties || []).filter(function (p) { return p.host !== me && (p.members || []).indexOf(me) < 0; });
    if (inv.length) {
      var p0 = inv[0];
      out.push({ id: 'party', sum: 'a watch party', html: '<div class="rn-row">' + V.icon('party', 'rn-i') + '<span class="rn-tx"><b>' + V.esc(name(p0.host)) + ' started a watch party</b><small>' + V.esc(p0.n || '') + '</small></span><button class="btn sm primary" data-rn-party="' + V.esc(p0.id) + '">Join</button></div>' });
    }

    // 3. A message you haven't read
    if (!guest() && !V.areaOff('messages')) {
      var unread = (s.conversations || []).filter(function (c) { return c.unread > 0 && c.last && c.last.from !== me; });
      if (unread.length) {
        var c0 = unread[0], m = c0.last, n = unread.reduce(function (a, c) { return a + c.unread; }, 0);
        var text = m.text || (m.item ? 'Sent you ' + m.item.n : m.party ? 'Invited you to a watch party' : 'New message');
        out.push({ id: 'msg', sum: n === 1 ? '1 new message' : n + ' new messages', html: '<div class="rn-row">' + V.icon('chat', 'rn-i') + '<span class="rn-tx"><b>' + (n > 1 ? n + ' new messages' : 'New message from ' + V.esc(name(m.from))) + '</b><small>' + V.esc((n > 1 ? name(m.from) + ': ' : c0.id === 'all' ? 'To everyone: ' : '') + text) + '</small></span><a class="btn sm" href="#/messages/' + encodeURIComponent(c0.id) + '">Reply</a></div>' });
      }
    }

    // 4. Your next reminder
    var rems = (S.data.reminders || []).filter(function (r) { return r.e > now && V.entry(r.k); }).sort(function (a, b) { return a.s - b.s; });
    if (rems.length) {
      var r0 = rems[0], ch = V.entry(r0.k), on = r0.s <= now + 60e3, more = rems.length - 1;
      var sub = ch.n + (more ? ' · ' + more + ' more later' : '');
      out.push({ id: 'rem', sum: rems.length === 1 ? '1 reminder' : rems.length + ' reminders', html: on ?
        '<div class="rn-row">' + V.icon('bellf', 'rn-i warn') + '<span class="rn-tx"><b>' + V.esc(r0.t) + ' is on now</b><small>' + V.esc(sub) + '</small></span><button class="btn sm primary" data-rn-play="' + V.esc(ch.k) + '">Watch</button></div>' :
        '<a class="rn-row rn-link" href="#/onlater">' + V.icon('bellf', 'rn-i warn') + '<span class="rn-tx"><b>' + V.esc(r0.t) + ' starts ' + V.esc(when(r0.s)) + '</b><small>' + V.esc(sub) + '</small></span></a>' });
    }

    // 5. On now: your channels first (favourites, then the ones watched lately), then the first with a guide
    if (S.live.length) {
      var got = {}, chans = [], want = out.length ? 2 : 3; // (three when they're all there is to show)
      var take = function (c) { if (c && c.t === 'live' && !got[c.k] && chans.length < want) { got[c.k] = 1; chans.push(c); } };
      (S.data.favs || []).map(V.entry).forEach(take);
      V.recentChannels().forEach(take);
      for (var i = 0, looked = 0; chans.length < want && i < S.live.length && looked < 60; i++) { if (V.epg.nowNext(S.live[i]).now) { looked++; take(S.live[i]); } }
      for (var j = 0; chans.length < want && j < S.live.length; j++) take(S.live[j]);
      if (chans.length) {
        out.push({ id: 'now', sum: '', html: '<div class="rn-h"><h3>On now</h3><a href="#/guide">Guide</a></div>' + chans.map(function (c) {
          var nn = V.epg.nowNext(c), left = nn.now ? V.fmtLeft((nn.now.e - now) / 1000) : '';
          return '<button class="rn-row rn-ch" data-rn-play="' + V.esc(c.k) + '"><span class="rn-logo">' + (c.i ? '<img src="' + V.esc(c.i) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : V.icon('tv')) + '</span><span class="rn-tx"><b>' + V.esc(nn.now ? nn.now.t : c.n) + '</b><small>' + V.esc(nn.now ? c.n : c.g || '') + '</small></span>' + (left ? '<span class="rn-left">' + V.esc(left) + '</span>' : '') + '</button>';
        }).join('') });
      }
    }
    return out;
  }

  function draw(el, s) {
    var ps = parts(s);
    if (!ps.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    var sums = ps.map(function (p) { return p.sum; }).filter(Boolean);
    var isFolded = folded();
    el.classList.toggle('rn-folded', isFolded);
    if (isFolded) {
      el.innerHTML = '<button class="rn-pill" data-rn-fold="0" aria-expanded="false">' + (sums.length ? '<i class="rn-dot" aria-hidden="true"></i>' : '') + '<span>' + V.esc(sums.length ? sums.join(' · ') : 'Right now') + '</span>' + V.icon('next', 'rn-chev down') + '</button>';
      return;
    }
    // (Redrawn each minute: keep the keyboard's place.)
    var had = document.activeElement && el.contains(document.activeElement) ? (document.activeElement.getAttribute('data-rn-play') || document.activeElement.getAttribute('href') || '') : null;
    el.innerHTML = '<div class="rn-top"><h2>Right now</h2><button class="icon-btn sm" data-rn-fold="1" aria-expanded="true" aria-label="Fold Right now away">' + V.icon('next', 'rn-chev up') + '</button></div>' +
      '<div class="rn-secs">' + ps.map(function (p) { return '<section class="rn-sec rn-' + p.id + '">' + p.html + '</section>'; }).join('') + '</div>';
    if (had) { var again = V.$$('[data-rn-play], a[href]', el).filter(function (x) { return (x.getAttribute('data-rn-play') || x.getAttribute('href')) === had; })[0]; if (again) again.focus({ preventScroll: true }); }
  }

  /** Fills the panel (an <aside class="rn">) and keeps it current until the page changes. */
  function mount(el) {
    if (!el) return;
    var alive = true, timer = null, n = 0;
    var show = function (force) { social(force).then(function (s) { if (alive && document.documentElement.contains(el)) draw(el, s); }).catch(function () { if (alive && !soc) draw(el, { profiles: [], presence: [], conversations: [], parties: [] }); }); };
    el.addEventListener('click', function (e) {
      var b;
      if ((b = e.target.closest('[data-rn-fold]'))) { V.ls.set(FOLD, b.dataset.rnFold === '1' ? 1 : 0); draw(el, soc || {}); var f = V.$('[data-rn-fold]', el); if (f) f.focus(); return; }
      if ((b = e.target.closest('[data-rn-party]'))) { V.party.join(b.dataset.rnParty); return; }
      if ((b = e.target.closest('[data-rn-play]'))) {
        var k = b.dataset.rnPlay, it = V.entry(k), show = b.dataset.rnSk ? V.entry(b.dataset.rnSk) : null;
        if (it) V.play(it);
        else if (show) V.loadEpisodes(show).then(function () { var ep = V.entry(k); if (ep) V.play(ep); else V.router.go(V.hrefOf(show)); }).catch(V.fail);
      }
    });
    var offs = ['message', 'read', 'unsend'].map(function (ev) { return V.on(ev, V.debounce(function () { show(true); }, 600)); });
    offs.push(V.on('party', V.debounce(function () { show(false); }, 2000))); // (a party says something every few seconds: no more than one look in twenty)
    offs.push(V.on('reminders', function () { if (soc) draw(el, soc); }));
    // The minutes move on by themselves; who's watching is asked again every other minute (nothing announces it).
    timer = setInterval(function () { if (document.hidden) return; n++; if (n % 2 === 0) show(true); else if (soc) draw(el, soc); }, 60e3);
    var prev = V.pageCleanup;
    V.pageCleanup = function () { alive = false; clearInterval(timer); offs.forEach(function (off) { off(); }); if (prev) prev(); };
    if (soc) draw(el, soc); // (what was known a moment ago, straight away)
    show(false);
  }

  return {
    wanted: wanted,
    /** The empty panel, for home.js to put in the banner (solo: there's no banner). */
    html: function (solo) { return wanted() ? '<aside class="rn' + (solo ? ' rn-solo' : '') + '" aria-label="Right now" hidden></aside>' : ''; },
    mount: mount,
    _parts: parts, // (tests)
  };
})();
