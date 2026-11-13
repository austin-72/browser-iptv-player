/* Sound only, for listening to a live channel with the picture off (and far less data).
   1. If the channel's HLS has a separate sound rendition, play just that, straight from the provider.
   2. Otherwise the server's conversion sends the sound alone (the same as radio channels).
   3. With neither (no ffmpeg, or playback must be direct), the picture is just hidden.
   A "listening" card shows the channel and what's on. The choice sticks while you change channels, until turned off. */
'use strict';
(function () {
  var HIDDEN = 'Picture hidden (the whole stream still downloads)';
  var note = function (p) { return p._aoHow === 'hidden' ? HIDDEN : 'Sound only'; };
  var card = function (p, text) {
    var it = p.it, art = V.$('.vp-art', p.host);
    if (!it || !art) return;
    var nn = V.epg && V.epg.nowNext ? V.epg.nowNext(it) : {};
    var html = V.art(it.i, it.n, 'art-radio') + '<div class="radio-name">' + V.esc(it.n) + '</div>' +
      '<div class="ao-now">' + (nn.now ? '<b>' + V.esc(nn.now.t) + '</b> <span class="dim">' + V.fmtClock(nn.now.s) + ' – ' + V.fmtClock(nn.now.e) + '</span>' : '') + '</div>' +
      (nn.next ? '<div class="ao-next dim">Next ' + V.fmtClock(nn.next.s) + ' · ' + V.esc(nn.next.t) + '</div>' : '') +
      '<div class="ao-tag">' + V.icon('headphones') + ' ' + V.esc(text || 'Sound only') + ' · <button class="linkish" data-a="audioonly">Show the picture</button></div>';
    art.hidden = false;
    // (Nothing changed: left as it is, so a remote's focus on "Show the picture" isn't lost every 30 seconds.)
    if (art._aoHtml === html && art.innerHTML) return;
    var had = art.contains(document.activeElement);
    art.innerHTML = html;
    art._aoHtml = html;
    if (had) { var l = V.$('[data-a=audioonly]', art); if (l) l.focus({ preventScroll: true }); }
  };
  // The player's own button (not the card's "Show the picture" link, which comes first in the page).
  var setBtn = function (p) {
    var b = V.$('.vz [data-a=audioonly]', p.host);
    if (!b) return;
    b.hidden = !(p.it && p.it.t === 'live');
    b.setAttribute('aria-pressed', String(!!p._aoActive));
    b.classList.toggle('on', !!p._aoActive);
  };
  var show = function (p, on, text) {
    p.el.classList.toggle('audio-only', !!on);
    if (on) card(p, text);
    else if (p.it && p.it.t !== 'radio') { var art = V.$('.vp-art', p.host); if (art) { art.hidden = true; art.innerHTML = ''; art._aoHtml = null; } }
    setBtn(p);
  };
  var enter = function (p) {
    var it = p.it;
    if (!it || it.t !== 'live') return;
    p._aoActive = true;
    // 1. A separate sound rendition in the channel's HLS.
    var hls = p.hls, tr = hls && hls.audioTracks && hls.audioTracks.length ? (hls.audioTracks[hls.audioTrack] || hls.audioTracks[0]) : null;
    if (tr && tr.url) {
      p._aoHow = 'rendition';
      return p.load(it, { only: { via: 'direct', kind: 'hls', url: tr.url, audioOnly: true }, quiet: true, alt: p.alt });
    }
    // 2. The server sends the sound alone.
    if (S.settings.ffmpeg && S.settings.routing !== 'direct-only') {
      p._aoHow = 'server';
      return p.load(it, { only: { via: 'session', mode: 'remux', audioOnly: true }, quiet: true, alt: p.alt });
    }
    // 3. Just hide the picture.
    p._aoHow = 'hidden';
    show(p, true, HIDDEN);
  };
  var leave = function (p) {
    var how = p._aoHow;
    p._aoActive = false; p._aoHow = null;
    show(p, false);
    if (how !== 'hidden' && p.it) p.load(p.it, { quiet: true, alt: p.alt });
  };
  V.audioOnly = {
    toggle: function (p) {
      var a = document.activeElement, fromCard = !!(a && a.closest && a.closest('.vp-art'));
      p._aoMode = !p._aoActive;
      if (p._aoActive) { leave(p); p.osd('Picture on', 1000); } else { enter(p); p.osd('Sound only', 1000); }
      // "Show the picture" goes away with the card: the remote's focus moves to the player's own button.
      if (fromCard) { var b = V.$('.vz [data-a=audioonly]', p.host); (b && !b.hidden && b.offsetParent ? b : p.el).focus({ preventScroll: true }); }
      if (p.onUserAction) p.onUserAction('audioonly');
    },
    /** Called as an item starts loading. */
    onLoad: function (p, it, opts) {
      if (opts.only && opts.only.audioOnly) { show(p, true); return; }
      if (opts.quiet && p._aoActive && p._aoHow === 'hidden') { show(p, true, HIDDEN); return; }
      if (!opts.quiet) {
        p._aoActive = false; p._aoHow = null;
        p.el.classList.remove('audio-only');
        // Still in "sound only" from the last channel: switch this one too once it plays.
        p._aoPending = !!(p._aoMode && it.t === 'live');
      }
      setBtn(p);
    },
  };
  V.on('player-started', function (p) {
    setBtn(p);
    if (p._aoPending) { p._aoPending = false; enter(p); }
    else if (p._aoActive) card(p, note(p));
  });
  // What's on changes: keep the card current.
  setInterval(function () { var p = V.player; if (p && p._aoActive && p.started) card(p, note(p)); }, 30000);
  V.audioOnlyMenu = function (p, main) {
    if (!p.it || p.it.t !== 'live') return;
    main.push({ label: 'Sound only', value: p._aoActive ? 'On' : 'Off', fn: function () { V.audioOnly.toggle(p); } });
  };
})();
