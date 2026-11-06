/* A little life in the posters: a picture settles in with a small rock when it arrives, and the posters in a row
   sway gently as the row moves left or right (leaning with the motion, swinging back with a small nod when it stops).
   Kept small and short so it's never in the way; off with Settings → Reduce motion (or the system's reduced motion),
   on devices that are slow to draw (TVs, games consoles: V.lite in settings.js), and for pictures already shown a
   moment ago (a page drawn again doesn't set everything moving again). */
'use strict';

(function () {
  var root = document.documentElement;
  // (Lite: TVs and games consoles — a PlayStation's browser repaints far more than a computer's — get none of it.)
  var still = function () { return !!(V.reduceMotion && V.reduceMotion()) || root.classList.contains('reduce-motion') || root.classList.contains('lite'); };

  // ------------------------------------------------------------ a picture arriving
  // (Nothing measured here — no layout read per picture, which on a page of a hundred posters added up: lazy-loaded
  // pictures only arrive near the screen anyway. Class changes wait for the next frame, all together.)
  var seen = {}; // picture → when it last did its arrival (ms)
  var seenN = 0, queue = [], queued = false;
  var flush = function () {
    queued = false;
    var q = queue; queue = [];
    for (var n = 0; n < q.length; n++) q[n].classList.add('art-in');
  };
  document.addEventListener('load', function (e) {
    var img = e.target;
    if (!img || img.tagName !== 'IMG' || still()) return;
    var art = img.parentNode, card = art && art.parentNode;
    if (!card || !art.classList || !art.classList.contains('card-art') || !card.classList || !card.classList.contains('card')) return;
    var src = img.src, now = Date.now();
    if (seen[src] && now - seen[src] < 60000) return;
    if (++seenN > 3000) { seen = {}; seenN = 0; }
    seen[src] = now;
    if (card.classList.contains('art-in')) return;
    // A different lean for each poster (from its place), so a row doesn't move as one block.
    var i = 0;
    for (var x = card.previousElementSibling; x && i < 6; x = x.previousElementSibling) i++;
    card.classList.remove('art-b', 'art-c');
    if (i % 3) card.classList.add(i % 3 === 1 ? 'art-b' : 'art-c');
    queue.push(card);
    if (!queued) { queued = true; requestAnimationFrame(flush); }
  }, true);
  document.addEventListener('animationend', function (e) {
    if (/^artRock/.test(e.animationName) && e.target.classList) e.target.classList.remove('art-in', 'art-b', 'art-c');
  }, true);

  // ------------------------------------------------------------ a row moving
  // How fast the row moves sets how far its posters lean (a little, at most); when it stops they swing back with a
  // small nod. (A few changes a scroll — not one on every step, which had every poster's style worked out again each
  // time: the posters then glide there on the graphics chip.)
  var MAX = 2.6; // degrees
  var rows = [];
  var track = function (sc) {
    for (var i = 0; i < rows.length; i++) if (rows[i].sc === sc) return rows[i];
    var o = { sc: sc, x: sc.scrollLeft, t: Date.now(), lean: 0, want: 0, peak: 0, idle: null, settle: null, frame: false };
    rows.push(o);
    if (rows.length > 40) rows.shift();
    return o;
  };
  var apply = function (o) {
    o.frame = false;
    if (o.want === o.lean) return;
    o.lean = o.want;
    if (o.lean) o.sc.classList.add('swaying');
    o.sc.style.setProperty('--sway', o.lean.toFixed(1) + 'deg');
  };
  var setLean = function (o, deg) {
    if (deg && Math.abs(deg - o.want) < 0.4) return;
    o.want = deg;
    if (!o.frame) { o.frame = true; requestAnimationFrame(function () { apply(o); }); }
  };
  document.addEventListener('scroll', function (e) {
    var sc = e.target;
    if (!sc || !sc.classList || !sc.classList.contains('row-scroll') || still()) return;
    var o = track(sc);
    var now = Date.now(), x = sc.scrollLeft, dt = Math.max(16, now - o.t), v = (x - o.x) / dt; // px per ms
    o.x = x; o.t = now;
    // (Moving right — the posters slide left — hung from the top, their bottoms trail behind.)
    // (In two steps only — a little, or the most — so the slant changes a few times a scroll, not on every step:
    // the change itself then glides on the graphics chip.)
    var deg = Math.max(-MAX, Math.min(MAX, -v * 1.1));
    deg = Math.abs(deg) < 0.5 ? 0 : (Math.abs(deg) < 1.8 ? 1.3 : MAX) * (deg < 0 ? -1 : 1);
    setLean(o, deg);
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

// ---------------------------------------------------------------- the background behind the posters
// A few soft glows of colour (the theme's own, and two quieter ones) drifting very slowly behind everything — a
// minute or more to cross the screen, so it's felt more than seen. Off with Settings → Look → "Moving background"
// (and on a slow device unless turned on there);
// still (not moving) with Reduce motion. Not on the player or the guide, where it would only be in the way.
(function () {
  var put = function () {
    if (document.getElementById('ambient')) return;
    var a = document.createElement('div');
    a.id = 'ambient';
    a.setAttribute('aria-hidden', 'true');
    a.innerHTML = '<i class="amb a1"></i><i class="amb a2"></i><i class="amb a3"></i>';
    document.body.insertBefore(a, document.body.firstChild);
  };
  if (document.body) put(); else document.addEventListener('DOMContentLoaded', put);
})();
