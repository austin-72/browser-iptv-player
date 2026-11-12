/* Remote-control / keyboard navigation: arrow keys move focus to the nearest item in that direction. */
'use strict';
(function () {
  var SEL = 'a[href], button:not([disabled]), [tabindex="0"], input:not([type=hidden]):not([disabled]), select, textarea, summary';
  // A visually hidden checkbox or radio (chips, switches) is reached through the label drawn for it.
  var rectOf = function (el) {
    var r = el.getBoundingClientRect();
    if (el.tagName === 'INPUT' && (r.width <= 2 || r.height <= 2)) { var l = el.closest('label'); if (l) return l.getBoundingClientRect(); }
    return r;
  };
  var visible = function (el) {
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    // Inside a closed <details> (only its summary can be reached).
    var dt = el.closest('details:not([open])');
    if (dt && !(el.tagName === 'SUMMARY' && el.parentNode === dt)) return false;
    var r = rectOf(el);
    return r.width > 2 && r.height > 2 && r.bottom > -window.innerHeight && r.top < window.innerHeight * 2;
  };
  function scope() {
    var d = V.$$('dialog[open]').pop();
    if (d) return d;
    var pl = V.$('#player-layer');
    if (pl && !pl.hidden && !pl.classList.contains('mini')) return pl;
    var pf = V.$('#profiles');
    if (pf && !pf.hidden) return pf;
    return document.body;
  }
  function move(dir, from) {
    var root = scope();
    var cur = rectOf(from);
    var cx = cur.left + cur.width / 2, cy = cur.top + cur.height / 2;
    var row = from.closest('.row-scroll, .chips, .tabs, .pf-grid, .vp-row, .hero-acts, .tp-acts, .toast');
    var best = null, cands = [];
    V.$$(SEL, root).forEach(function (el) {
      if (el === from || !visible(el) || el.closest('[hidden], .row-btn, .skip-link')) return;
      if (root === document.body && el.closest('#player-layer:not(.mini), #profiles[hidden]')) return;
      var r = rectOf(el);
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      var dx = x - cx, dy = y - cy;
      var main, cross;
      if (dir === 'right') { if (r.left < cur.right - 8 && dx <= 4) return; main = dx; cross = Math.abs(dy); }
      else if (dir === 'left') { if (r.right > cur.left + 8 && dx >= -4) return; main = -dx; cross = Math.abs(dy); }
      else if (dir === 'down') { if (r.top < cur.bottom - 8 && dy <= 4) return; main = dy; cross = Math.abs(dx); }
      else { if (r.bottom > cur.top + 8 && dy >= -4) return; main = -dy; cross = Math.abs(dx); }
      if (main <= 0) return;
      var d = main + cross * (dir === 'left' || dir === 'right' ? 3 : 1.2);
      // Stay in the same row when moving sideways.
      if ((dir === 'left' || dir === 'right') && row && !row.contains(el)) d += 2000;
      // Up/down: how far the gap is between the two edges, and how far apart they are sideways (0 if they overlap).
      var gap = dir === 'down' ? r.top - cur.bottom : dir === 'up' ? cur.top - r.bottom : 0;
      var side = Math.max(0, r.left - cur.right, cur.left - r.right);
      cands.push({ el: el, d: d, gap: gap, side: side, r: r });
    });
    // Up while scrolled down the page: the page's own things above come before the header bar fixed at the top.
    if (dir === 'up' && window.pageYOffset > 50 && !from.closest('#topbar')) {
      var below = cands.filter(function (c) { return !c.el.closest('#topbar'); });
      if (below.length) cands = below;
    }
    if (dir === 'up' || dir === 'down') {
      // The next line of things above/below comes first (even if what's in it is off to one side), then the nearest
      // one in that line — so Up from a row of chips reaches the filters above it rather than skipping to the header.
      // (Something that overlaps this one up/down — a tall row beside a short button — isn't "the next line".)
      var minGap = Infinity;
      var inToast = !!from.closest('#toasts');
      cands.forEach(function (c) { if (c.gap >= 0 && c.gap < minGap && (inToast || !c.el.closest('#toasts'))) minGap = c.gap; });
      cands.forEach(function (c) { c.band = c.gap >= 0 && c.gap <= minGap + 28 ? 0 : 1; });
      // A pop-up note floating at the bottom comes after the page itself (it's reached at the end of the page).
      if (!inToast) cands.forEach(function (c) { if (c.el.closest('#toasts')) c.band = 2; });
      cands.sort(function (a, b) { return a.band - b.band || (a.band ? a.d - b.d : a.side - b.side || a.d - b.d); });
    } else {
      // Left/right: things on the same line come first, so Right along the header doesn't drop into the page below.
      cands.forEach(function (c) { var q = c.r; c.band = q.bottom >= cur.top && q.top <= cur.bottom ? 0 : 1; });
      // Home's banner: "Right now" sits higher than the buttons and titles beside it, so it's never on their line.
      // Right from the last of them goes into it (not down to the chips under the banner); Left from it comes back.
      var hero = from.closest('.hero'), inRn = !!from.closest('.rn');
      if (hero && V.$('.rn', hero) && !cands.some(function (c) { return !c.band && hero.contains(c.el); })) {
        var across = cands.filter(function (c) { return hero.contains(c.el) && (dir === 'right' ? !inRn && !!c.el.closest('.rn') : inRn && !c.el.closest('.rn')); });
        if (across.length) { cands = across; row = null; }
      }
      // At the left/right edge of the page (the Live TV groups, say), stay put rather than jump up into the header
      // bar: Up gets there.
      if (!from.closest('#topbar')) cands = cands.filter(function (c) { return !c.band || !c.el.closest('#topbar'); });
      // At the end of a row of cards, chips or tabs, stay put rather than jumping to another line (or a pop-up note).
      if (row) cands = cands.filter(function (c) { return row.contains(c.el) || (!c.band && !c.el.closest('#toasts')); });
      cands.sort(function (a, b) { return a.band - b.band || a.d - b.d; });
    }
    // The nearest one that actually takes focus.
    for (var ci = 0; ci < cands.length && ci < 6; ci++) {
      cands[ci].el.focus({ preventScroll: true });
      if (document.activeElement === cands[ci].el) { best = cands[ci].el; break; }
    }
    if (best) {
      var sc = best.closest('.row-scroll');
      if (sc) { var r2 = best.getBoundingClientRect(), s = sc.getBoundingClientRect(); if (r2.left < s.left + 40 || r2.right > s.right - 40) sc.scrollBy({ left: r2.left - s.left - 48, behavior: V.reduceMotion() ? 'auto' : 'smooth' }); }
      best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: V.reduceMotion() ? 'auto' : 'smooth' });
      if (dir === 'up' && best.getBoundingClientRect().top < 90) window.scrollBy(0, -120);
      return true;
    }
    return false;
  }
  // Where focus last was (page position), for when what had it disappears.
  var last = null;
  document.addEventListener('focusin', function (e) {
    var el = e.target;
    if (!el || el === document.body || !el.getBoundingClientRect) return;
    var q = rectOf(el);
    last = { x: q.left + q.width / 2, y: q.top + q.height / 2 + window.pageYOffset, hash: location.hash, root: scope() };
  }, true);
  /**
   * The TV apps in tv-apps/ are this same site opened inside a thin wrapper. Each gives the page a way out:
   * Android TV / Fire TV: TvApp.exit() (its own bridge); Samsung: tizen.application; LG: PalmSystem.
   * (A TV's ordinary browser has none of them, and there Back at Home does nothing, as before.)
   */
  var leaveAt = 0;
  V.inTvApp = function () { return !!((window.TvApp && window.TvApp.exit) || (window.tizen && window.tizen.application) || (window.PalmSystem && window.PalmSystem.platformBack)); };
  V.leaveApp = function () {
    try { if (window.TvApp && window.TvApp.exit) return window.TvApp.exit(); } catch (e) {}
    try { if (window.tizen && window.tizen.application) return window.tizen.application.getCurrentApplication().exit(); } catch (e2) {}
    try { if (window.PalmSystem && window.PalmSystem.platformBack) return window.PalmSystem.platformBack(); } catch (e3) {}
  };
  V.reduceMotion = function () { return document.documentElement.classList.contains('reduce-motion') || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); };
  document.addEventListener('keydown', function (e) {
    var k = e.key;
    var dir = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up' }[k];
    var t = document.activeElement;
    var back = e.keyCode === 10009 || e.keyCode === 461 || k === 'BrowserBack' || k === 'GoBack';
    // Back on a remote closes an open menu or dialog first (browsers only do that for Escape).
    if (back && V.$('.popmenu')) { e.preventDefault(); V.closeMenus(); return; }
    if (back && V.$('dialog[open]')) {
      var top = V.$$('dialog[open]').pop();
      if (top && top._dismiss) { e.preventDefault(); top._dismiss(); }
      return;
    }
    // Back button on TV remotes.
    if (back) {
      var pl = V.$('#player-layer');
      if (pl && !pl.hidden && !pl.classList.contains('mini')) return;
      e.preventDefault();
      // (Opened straight on this page, with nothing of the app's to go back to: Home, rather than leaving the app.)
      if (location.hash && location.hash !== '#/home') V.router.back('#/home');
      // At Home inside one of the TV apps (tv-apps/): Back twice leaves, as TV apps do.
      else if (V.inTvApp()) {
        if (Date.now() - leaveAt < 2500) V.leaveApp();
        else { leaveAt = Date.now(); V.toast('Press Back again to leave', { ms: 2400 }); }
      }
      return;
    }
    if (k === '/' && !t.closest('input, textarea, select, [contenteditable]') && S.profile && V.$('#player-layer').hidden !== false) { e.preventDefault(); V.router.go('#/search'); return; }
    if (k === '/' && !t.closest('input, textarea, select') && S.profile && V.watch && V.watch.mini) { e.preventDefault(); V.router.go('#/search'); return; }
    // The remote's menu / info key (or the keyboard's menu key) on a poster or channel: its options (My List, hide…).
    if ((k === 'ContextMenu' || k === 'Info' || e.keyCode === 93 || e.keyCode === 457) && t && t.closest && t.closest('a.card') && V.itemMenu) {
      var card = t.closest('a.card'), ent = V.entry(card.dataset.k);
      if (ent) { e.preventDefault(); V.itemMenu(card, ent); return; }
    }
    // OK on a remote is Enter: tick a checkbox or pick a radio button (browsers only do that with Space).
    if (k === 'Enter' && t && t.tagName === 'INPUT' && (t.type === 'checkbox' || t.type === 'radio') && !e.repeat) { e.preventDefault(); t.click(); return; }
    if (!dir || e.altKey || e.ctrlKey || e.metaKey) return;
    if (t && (t.closest('input[type=text], input[type=search], input[type=password], input:not([type]), textarea, input[type=range], .g-canvas, .vp-seek, select') )) {
      // On a TV, Up/Down leave a text box or the seek bar (Left/Right still move the cursor / seek). A text area keeps
      // them while there's another line to go to.
      var vert = (dir === 'up' || dir === 'down') && V.tvMode;
      var ta = t.tagName === 'TEXTAREA' && vert && (dir === 'up' ? t.value.lastIndexOf('\n', t.selectionStart - 1) < 0 : t.value.indexOf('\n', t.selectionEnd) < 0);
      if (!(t.tagName === 'SELECT' && V.tvMode) && !(t.tagName === 'INPUT' && vert) && !(vert && t.closest('.vp-seek')) && !ta) return;
    }
    var pl2 = V.$('#player-layer');
    if (pl2 && !pl2.hidden && !pl2.classList.contains('mini') && !(t && t.closest('.vp-menu, .vp-side, .vp-ctrl, .vp-top, .vp-msg, .vp-upnext, .vp-end, .vp-live, .vp-skip, dialog'))) return;
    if (t && t.closest('.vp-menu') && (dir === 'up' || dir === 'down')) {
      e.preventDefault();
      var items = V.$$('.mi', t.closest('.vp-menu'));
      var i = items.indexOf(t);
      var n = items[(i + (dir === 'down' ? 1 : -1) + items.length) % items.length];
      if (n) n.focus();
      return;
    }
    var from = t && t !== document.body ? t : null;
    if (!from) {
      var root = scope();
      var list = V.$$(root === document.body ? '#view button, #view a, #view .card' : SEL, root).filter(visible);
      if (!list.length) list = V.$$(SEL, root).filter(visible); // (a page with nothing in it yet: the header, so the remote isn't stuck)
      // Focus was lost because what had it was drawn again (a list refreshed after removing something, a pop-up
      // note closing): carry on from the nearest thing to where it was, rather than jumping back to the top.
      var first = list[0];
      if (last && last.hash === location.hash && last.root === root) {
        var bestD = Infinity;
        list.forEach(function (el) { var q = rectOf(el), dx = q.left + q.width / 2 - last.x, dy = q.top + q.height / 2 + window.pageYOffset - last.y, dd = dx * dx + dy * dy; if (dd < bestD) { bestD = dd; first = el; } });
      }
      if (first) { first.focus(); e.preventDefault(); }
      return;
    }
    if (move(dir, from)) e.preventDefault();
    // Nothing more in that direction close by (a long table, text): scroll the page instead, so it can still be read
    // and whatever is further down can be reached.
    else if ((dir === 'up' || dir === 'down') && scope() === document.body) {
      var y = window.pageYOffset;
      window.scrollBy(0, (dir === 'down' ? 1 : -1) * Math.round(window.innerHeight * 0.6));
      if (window.pageYOffset !== y) e.preventDefault();
    }
  });
  /** Moves focus with the arrow keys from `from` (for pages that handle arrows themselves, at their edges). */
  V.tvMove = function (dir, from) { return move(dir, from); };
})();
