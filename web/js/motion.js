/* A little life in the posters: a picture settles in with a small rock when it arrives, and the posters in a row
   sway gently as the row moves left or right (leaning with the motion, swinging back with a small nod when it stops).
   Kept small and short so it's never in the way; off with Settings → Reduce motion (or the system's reduced motion),
   and for pictures already shown a moment ago (a page drawn again doesn't set everything moving again). */
'use strict';

(function () {
  var still = function () { return !!(V.reduceMotion && V.reduceMotion()) || document.documentElement.classList.contains('reduce-motion'); };

  // ------------------------------------------------------------ a picture arriving
  var seen = {}; // picture → when it last did its arrival (ms)
  var seenN = 0;
  document.addEventListener('load', function (e) {
    var img = e.target;
    if (!img || img.tagName !== 'IMG' || still()) return;
    var card = img.parentNode && img.parentNode.classList && img.parentNode.classList.contains('card-art') ? img.parentNode.parentNode : null;
    if (!card || !card.classList || !card.classList.contains('card')) return;
    var src = img.currentSrc || img.src, now = Date.now();
    if (seen[src] && now - seen[src] < 60000) return;
    if (++seenN > 3000) { seen = {}; seenN = 0; }
    seen[src] = now;
    // (Off screen — a row's far end, a long grid below: nothing to see, so nothing to do.)
    var r = img.getBoundingClientRect();
    if (r.right < 0 || r.left > window.innerWidth || r.bottom < 0 || r.top > window.innerHeight) return;
    // Left and right alike, a different lean for each poster (from its place), so a row doesn't move as one block.
    var i = Array.prototype.indexOf.call(card.parentNode ? card.parentNode.children : [], card);
    card.style.setProperty('--in-lean', (i % 2 ? 1 : -1) * (1.2 + (i % 3) * 0.5) + 'deg');
    card.classList.remove('art-in');
    void card.offsetWidth; // (again from the start, if it was mid-way)
    card.classList.add('art-in');
  }, true);
  document.addEventListener('animationend', function (e) {
    if (e.animationName === 'artRock' && e.target.classList) { e.target.classList.remove('art-in'); e.target.style.removeProperty('--in-lean'); }
  }, true);

  // ------------------------------------------------------------ a row moving
  // How fast the row moves sets how far its posters lean (a little, at most); when it stops they swing back.
  var MAX = 2.6; // degrees
  var rows = [];
  var track = function (sc) {
    for (var i = 0; i < rows.length; i++) if (rows[i].sc === sc) return rows[i];
    var o = { sc: sc, x: sc.scrollLeft, t: Date.now(), lean: 0, peak: 0, idle: null, settle: null };
    rows.push(o);
    if (rows.length > 40) rows.shift();
    return o;
  };
  var setLean = function (o, deg) {
    if (Math.abs(deg - o.lean) < 0.15 && deg !== 0) return;
    if (deg === o.lean) return;
    o.lean = deg;
    if (deg) o.sc.classList.add('swaying');
    o.sc.style.setProperty('--sway', deg.toFixed(2) + 'deg');
  };
  document.addEventListener('scroll', function (e) {
    var sc = e.target;
    if (!sc || !sc.classList || !sc.classList.contains('row-scroll')) return;
    var o = track(sc);
    var now = Date.now(), x = sc.scrollLeft, dt = Math.max(16, now - o.t), v = (x - o.x) / dt; // px per ms
    o.x = x; o.t = now;
    if (still()) return;
    // (Moving right — the posters slide left — they trail behind: the bottom swings back the other way.)
    var deg = Math.max(-MAX, Math.min(MAX, -v * 1.1));
    setLean(o, Math.round(deg * 10) / 10);
    if (Math.abs(deg) > Math.abs(o.peak || 0)) o.peak = deg;
    clearTimeout(o.idle); clearTimeout(o.settle);
    // Stopped: a small swing past upright (the nod), then still.
    o.idle = setTimeout(function () {
      var nod = -(o.peak || 0) * 0.35;
      o.peak = 0;
      setLean(o, Math.abs(nod) >= 0.3 ? Math.round(nod * 10) / 10 : 0);
      o.settle = setTimeout(function () {
        setLean(o, 0);
        o.settle = setTimeout(function () { if (!o.lean) o.sc.classList.remove('swaying'); }, 700);
      }, 220);
    }, 90);
  }, true);
  // (A page drawn again: rows from before are gone.)
  V.on('route', function () { rows = []; });
})();
