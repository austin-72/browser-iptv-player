/* Instant search over the catalogue: prefix and substring matches first, then typo-tolerant matches. */
'use strict';
V.search = (function () {
  var idx = null; // { names: [normalised], words: Map(word -> [item indexes]), items }

  function build() {
    var items = S.items || [];
    // Plus episodes of on-demand (Xtream) series that have been fetched so far.
    if (S.extra && S.extra.size) { items = items.slice(); S.extra.forEach(function (e) { items.push(e); }); }
    var names = new Array(items.length), groups = new Array(items.length), gcache = new Map();
    var words = new Map();
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var n = V.norm(it.n);
      names[i] = n;
      if (it.g) { var gn = gcache.get(it.g); if (gn === undefined) gcache.set(it.g, gn = V.norm(it.g)); groups[i] = gn; }
      if (it.t === 'episode') continue;
      var ws = n.split(' ');
      for (var j = 0; j < ws.length; j++) {
        var w = ws[j];
        if (w.length < 2) continue;
        var l = words.get(w);
        if (!l) words.set(w, (l = []));
        if (l[l.length - 1] !== i) l.push(i);
      }
    }
    idx = { names: names, groups: groups, words: words, items: items };
  }

  /** Damerau–Levenshtein distance, giving up early past `max`. */
  function dist(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev2 = null, prev = [], cur;
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      cur = [i];
      var best = i;
      for (var k = 1; k <= b.length; k++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(k - 1) ? 0 : 1;
        var v = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + cost);
        if (prev2 && i > 1 && k > 1 && a[i - 1] === b[k - 2] && a[i - 2] === b[k - 1]) v = Math.min(v, prev2[k - 2] + 1);
        cur[k] = v;
        if (v < best) best = v;
      }
      if (best > max) return max + 1;
      prev2 = prev; prev = cur;
    }
    return prev[b.length];
  }

  var TYPE_W = { show: 4, movie: 3, live: 3, radio: 1, episode: 0 };

  /**
   * opts: { types: ['movie','show',…], limit, episodes: bool }
   * Returns items, best first.
   */
  function find(q, opts) {
    opts = opts || {};
    if (!idx) build();
    var nq = V.norm(q);
    if (!nq) return [];
    var toks = nq.split(' ').filter(Boolean);
    var types = opts.types ? new Set(opts.types) : null;
    var scores = new Map();
    var names = idx.names, groups = idx.groups, items = idx.items;
    var num = /^\d{1,5}$/.test(nq) ? +nq : 0, spq = ' ' + nq;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (types && !types.has(it.t)) continue;
      if (it.t === 'episode' && !opts.episodes) continue;
      var n = names[i];
      var s = 0;
      if (num && it.no === num) s = 200;
      else if (n === nq) s = 120;
      else if (n.indexOf(nq) === 0) s = 90;
      else if (n.indexOf(spq) >= 0) s = 75;
      else if (n.indexOf(nq) > 0) s = 50;
      else {
        var all = true, part = 0;
        for (var t = 0; t < toks.length; t++) {
          var tk = toks[t];
          if (n.indexOf(' ' + tk) >= 0 || n.indexOf(tk) === 0) part += 2;
          else if (n.indexOf(tk) >= 0) part += 1;
          else { all = false; break; }
        }
        if (all) s = 30 + part * 4;
      }
      if (!s && groups[i] && opts.groups !== false) { var g = groups[i]; if (g === nq || g.indexOf(nq) === 0) s = 18; }
      if (s) scores.set(i, s + (TYPE_W[it.t] || 0) - Math.min(8, n.length / 12));
    }
    // Few hits: allow typos (one per 4 letters, at most two).
    if (scores.size < 12 && nq.length >= 4) {
      toks.forEach(function (tk) {
        if (tk.length < 4) return;
        var max = tk.length >= 8 ? 2 : 1;
        idx.words.forEach(function (list, w) {
          if (Math.abs(w.length - tk.length) > max || w[0] !== tk[0] && max < 2) return;
          var d = dist(tk, w, max);
          if (d > max) return;
          for (var j = 0; j < list.length; j++) {
            var it2 = items[list[j]];
            if (types && !types.has(it2.t)) continue;
            var cur = scores.get(list[j]) || 0;
            scores.set(list[j], Math.max(cur, 22 - d * 6 + (TYPE_W[it2.t] || 0)));
          }
        });
      });
    }
    // Things you've watched rank a little higher.
    var prog = S.data ? S.data.progress : {};
    var hidden = S.data && S.data.hidden.length ? new Set(S.data.hidden) : null;
    var out = [];
    scores.forEach(function (s, i) {
      var it = items[i];
      if (hidden && hidden.has(it.k)) s -= 30;
      if (prog[it.k]) s += 3;
      out.push({ s: s, n: names[i], it: it });
    });
    // Lots of matches: only the best few hundred need sorting properly.
    var lim = opts.limit || 200;
    if (out.length > lim * 3 && typeof Float64Array !== 'undefined') {
      var sc = new Float64Array(out.length);
      for (var q2 = 0; q2 < out.length; q2++) sc[q2] = -out[q2].s;
      sc.sort();
      var cut = -sc[lim - 1];
      out = out.filter(function (x) { return x.s >= cut; });
    }
    // Ties go alphabetically (by the plain-letters name, which is much quicker to compare than localeCompare).
    out.sort(function (a, b) { return b.s - a.s || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0); });
    var res = new Array(Math.min(lim, out.length));
    for (var r = 0; r < res.length; r++) res[r] = out[r].it;
    return res;
  }

  V.on('episodes-warm', function () { idx = null; });
  return { find: find, reset: function () { idx = null; }, dist: dist };
})();
