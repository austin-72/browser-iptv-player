/* Remote-control / keyboard navigation: arrow keys move focus to the nearest item in that direction. */
'use strict';
(function () {
  var SEL = 'a[href], button:not([disabled]), [tabindex="0"], input:not([type=hidden]):not([disabled]), select, textarea, summary';
  var visible = function (el) {
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    var r = el.getBoundingClientRect();
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
    var cur = from.getBoundingClientRect();
    var cx = cur.left + cur.width / 2, cy = cur.top + cur.height / 2;
    var row = from.closest('.row-scroll, .chips, .tabs, .pf-grid, .vp-row, .hero-acts, .tp-acts');
    var best = null, bd = Infinity;
    V.$$(SEL, root).forEach(function (el) {
      if (el === from || !visible(el) || el.closest('[hidden], .row-btn')) return;
      if (root === document.body && el.closest('#player-layer:not(.mini), #profiles[hidden]')) return;
      var r = el.getBoundingClientRect();
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
      if (d < bd) { bd = d; best = el; }
    });
    if (best) {
      best.focus({ preventScroll: true });
      var sc = best.closest('.row-scroll');
      if (sc) { var r2 = best.getBoundingClientRect(), s = sc.getBoundingClientRect(); if (r2.left < s.left + 40 || r2.right > s.right - 40) sc.scrollBy({ left: r2.left - s.left - 48, behavior: V.reduceMotion() ? 'auto' : 'smooth' }); }
      best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: V.reduceMotion() ? 'auto' : 'smooth' });
      if (dir === 'up' && best.getBoundingClientRect().top < 90) window.scrollBy(0, -120);
      return true;
    }
    return false;
  }
  V.reduceMotion = function () { return document.documentElement.classList.contains('reduce-motion') || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); };
  document.addEventListener('keydown', function (e) {
    var k = e.key;
    var dir = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up' }[k];
    var t = document.activeElement;
    // Back button on TV remotes.
    if ((e.keyCode === 10009 || e.keyCode === 461 || k === 'BrowserBack' || k === 'GoBack') && !V.$('dialog[open]')) {
      var pl = V.$('#player-layer');
      if (pl && !pl.hidden && !pl.classList.contains('mini')) return;
      e.preventDefault();
      if (location.hash && location.hash !== '#/home') history.back();
      return;
    }
    if (k === '/' && !t.closest('input, textarea, select, [contenteditable]') && S.profile && V.$('#player-layer').hidden !== false) { e.preventDefault(); V.router.go('#/search'); return; }
    if (k === '/' && !t.closest('input, textarea, select') && S.profile && V.watch && V.watch.mini) { e.preventDefault(); V.router.go('#/search'); return; }
    if (!dir || e.altKey || e.ctrlKey || e.metaKey) return;
    if (t && (t.closest('input[type=text], input[type=search], input[type=password], input:not([type]), textarea, input[type=range], .g-canvas, .vp-seek, select') )) {
      if (!(t.tagName === 'SELECT' && V.tvMode) && !(t.tagName === 'INPUT' && (dir === 'up' || dir === 'down') && V.tvMode)) return;
    }
    var pl2 = V.$('#player-layer');
    if (pl2 && !pl2.hidden && !pl2.classList.contains('mini') && !(t && t.closest('.vp-menu, .vp-side, .vp-ctrl, .vp-top, .vp-msg, .vp-upnext, .vp-live, .vp-skip, dialog'))) return;
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
      var first = V.$$(root === document.body ? '#view button, #view a, #view .card' : SEL, root).filter(visible)[0];
      if (first) { first.focus(); e.preventDefault(); }
      return;
    }
    if (move(dir, from)) e.preventDefault();
  });
})();
