/* Instant search over the catalogue: a word index built a little at a time in the background (so the page never
   stalls), prefix and substring matches first, then typo-tolerant matches. */
'use strict';
V.search = (function () {
  var TYPE_W = { show: 4, movie: 3, live: 3, radio: 1, episode: 0 };
  var idx = null; // see fresh()
  var ver = 0; // goes up whenever what a search can find changes (remembered answers are dropped)
  var pending = false, urgent = false;

  // Everything but episodes is indexed by word: episodes are found through their series (an episode is called
  // "<series> S01E02"), which keeps the index a quarter the size.
  function fresh(src) {
    return {
      src: src, pos: 0, done: false,
      items: [], names: [], // id -> item, id -> its name in plain letters
      words: new Map(), // word -> [ids]
      list: [], // every word once (typo and middle-of-word matches)
      pre: new Map(), // first 1, 2 and 3 letters -> [words]
      groups: new Map(), // category in plain letters -> [ids]
      byNo: new Map(), // channel number -> [ids]
      starts: new Map(), // the name's first 1, 2 and 3 letters -> [ids] (one or two letters typed: what starts with them)
      gnorm: new Map(), snames: new Map(), mark: [], qid: 0,
    };
  }

  function addItem(x, it) {
    var id = x.items.length, n = V.norm(it.n);
    x.items.push(it); x.names.push(n);
    var ws = n.split(' ');
    for (var j = 0; j < ws.length; j++) {
      var w = ws[j];
      if (!w) continue;
      var l = x.words.get(w);
      if (!l) {
        x.words.set(w, (l = []));
        x.list.push(w);
        for (var p = 1; p <= 3 && p <= w.length; p++) { var k = w.slice(0, p), b = x.pre.get(k); if (!b) x.pre.set(k, (b = [])); b.push(w); }
      }
      if (l[l.length - 1] !== id) l.push(id);
    }
    for (var q = 1; q <= 3 && q <= n.length; q++) { var sk = n.slice(0, q), sl = x.starts.get(sk); if (!sl) x.starts.set(sk, (sl = [])); sl.push(id); }
    if (it.no) { var nl = x.byNo.get(it.no); if (!nl) x.byNo.set(it.no, (nl = [])); nl.push(id); }
    if (it.g) {
      var g = x.gnorm.get(it.g);
      if (g === undefined) x.gnorm.set(it.g, (g = V.norm(it.g)));
      if (g) { var gl = x.groups.get(g); if (!gl) x.groups.set(g, (gl = [])); gl.push(id); }
    }
    // Smarter categories by name too: "christmas", "halloween", "netflix" find what's in them.
    if (it.sc && V.smart && V.smart.on()) for (var si = 0; si < it.sc.length; si++) {
      var sn = x.snames.get(it.sc[si]);
      if (sn === undefined) x.snames.set(it.sc[si], (sn = V.smart.searchNames(it.sc[si])));
      for (var sj = 0; sj < sn.length; sj++) { if (!sn[sj] || sn[sj] === g) continue; var sl2 = x.groups.get(sn[sj]); if (!sl2) x.groups.set(sn[sj], (sl2 = [])); if (sl2[sl2.length - 1] !== id) sl2.push(id); }
    }
  }

  /** Indexes for up to `ms` milliseconds; true once everything is in. */
  function step(ms) {
    var x = idx, src = x.src, end = V.now() + ms;
    while (x.pos < src.length) {
      var it = src[x.pos++];
      if (it && it.t !== 'episode') addItem(x, it);
      if ((x.pos & 127) === 0 && V.now() > end) break;
    }
    if (x.pos >= src.length && !x.done) {
      x.done = true; ver++; cache = {}; urgent = false;
      V.emit('search-ready');
    }
    return x.done;
  }

  function schedule() {
    if (pending || !idx || idx.done) return;
    pending = true;
    V.idle(function (dl) {
      pending = false;
      if (!idx || idx.done) return;
      step(Math.max(4, dl.timeRemaining()));
      schedule();
    }, { soon: urgent, max: 12 });
  }

  /** The catalogue changed. append: the new list is the old one with more on the end (more pages of a big catalogue). */
  function reset(append) {
    var src = S.items || [];
    if (append && idx && idx.src.length && src.length >= idx.src.length && src[0] === idx.src[0] && src[idx.src.length - 1] === idx.src[idx.src.length - 1]) {
      idx.src = src; idx.done = idx.pos >= src.length;
    } else { idx = fresh(src); urgent = false; }
    ver++; cache = {};
    schedule();
  }
  function sync() { if (!idx || (idx.src !== S.items && S.items)) reset(false); }

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

  /** How well a name (plain letters) matches: the whole query exactly, at the start, at a word, inside a word; or
   *  every word typed somewhere in it. 0: not at all. */
  var ART = /^(the|a|an) /;
  // Small words a name may leave out ("fast and furious" is Fast & Furious), and numbers written either way.
  var STOP = { and: 1, the: 1, of: 1, a: 1, an: 1, n: 1, to: 1, in: 1 };
  var ALT = { 1: 'i', 2: 'ii', 3: 'iii', 4: 'iv', 5: 'v', 6: 'vi', 7: 'vii', 8: 'viii', 9: 'ix', 10: 'x', i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10', one: '1', two: '2', three: '3', four: '4', five: '5' };
  function scoreName(n, Q) {
    if (n === Q.nq) return 120;
    var p = n.indexOf(Q.nq);
    if (p === 0) return 90;
    // ("The" left off: "dark knight" is The Dark Knight.)
    if (!Q.art && n.length > 3 && ART.test(n)) { var n2 = n.replace(ART, ''); if (n2 === Q.nq) return 118; if (n2.lastIndexOf(Q.nq, 0) === 0) return 88; }
    if (p > 0) return n.indexOf(Q.spq) >= 0 ? 75 : 50;
    var part = 0, miss = 0;
    for (var t = 0; t < Q.toks.length; t++) {
      var tk = Q.toks[t], al = Q.alt[t];
      if (n.lastIndexOf(tk, 0) === 0 || n.indexOf(Q.sp[t]) >= 0) part += 2;
      else if (al && (' ' + n + ' ').indexOf(' ' + al + ' ') >= 0) part += 2;
      else if (n.indexOf(tk) >= 0) part += 1;
      else if (Q.opt[t]) miss++;
      else return 0;
    }
    if (miss === Q.toks.length) return 0;
    return 30 + part * 4 - miss * 3;
  }

  /** A name against what's typed, a typo or two allowed: each word typed starts a word of the name, or is one with a
   *  letter or two wrong. 0: not that either. */
  function fuzzy(n, Q) {
    var ws = n.split(' '), part = 0, typos = 0, miss = 0;
    for (var t = 0; t < Q.toks.length; t++) {
      var tk = Q.toks[t], al = Q.alt[t];
      if (n.lastIndexOf(tk, 0) === 0 || n.indexOf(Q.sp[t]) >= 0) { part += 2; continue; }
      if (al && (' ' + n + ' ').indexOf(' ' + al + ' ') >= 0) { part += 2; continue; }
      var d = 9;
      if (tk.length >= 4) {
        var max = tk.length >= 8 ? 2 : 1;
        for (var w = 0; w < ws.length && d > 0; w++) {
          var wd = ws[w];
          if (Math.abs(wd.length - tk.length) <= max) d = Math.min(d, dist(tk, wd, max));
          // (Still typing it: the start of a longer word.)
          if (wd.length > tk.length) d = Math.min(d, dist(tk, wd.slice(0, tk.length), max));
        }
        if (d > max) d = 9;
      }
      if (d < 9) { part += 1; typos += d; }
      else if (Q.opt[t]) miss++;
      else return 0;
    }
    if (miss === Q.toks.length) return 0;
    return 30 + part * 4 - typos * 5 - miss * 3 + (ws.length <= Q.toks.length ? 6 : 0);
  }

  /** Words of the index starting with tk. */
  function wordsFrom(x, tk) {
    var b = x.pre.get(tk.length <= 3 ? tk : tk.slice(0, 3));
    if (!b) return [];
    if (tk.length <= 3) return b;
    var out = [];
    for (var i = 0; i < b.length; i++) if (b[i].lastIndexOf(tk, 0) === 0) out.push(b[i]);
    return out;
  }

  var EPCODE = /^(s\d{1,2}(e\d{1,4})?|e\d{1,4}|\d{1,2}x\d{1,3})$/;
  var epNames = new Map();
  function epName(e) { var n = epNames.get(e); if (n === undefined) { if (epNames.size > 30000) epNames = new Map(); n = V.norm(e.n); epNames.set(e, n); } return n; }

  var cache = {}, cacheN = 0;

  /**
   * opts: { types: ['movie','show',…], limit, episodes: bool, groups: false }
   * Returns items, best first.
   */
  function find(q, opts) {
    opts = opts || {};
    var nq = V.norm(q);
    if (!nq) return [];
    sync();
    var lim = opts.limit || 200;
    var key = nq + '|' + (opts.types ? opts.types.join(',') : '') + '|' + (opts.episodes ? 1 : 0) + (opts.groups === false ? 0 : 1) + '|' + lim;
    var hit = cache[key];
    if (hit && hit.ver === ver && Date.now() - hit.at < 20000) return hit.res.slice();
    var res = run(nq, opts, lim);
    if (res.partial) return res; // (not kept: there's more to find in a moment)
    if (++cacheN > 60) { cache = {}; cacheN = 0; }
    cache[key] = { ver: ver, at: Date.now(), res: res };
    return res.slice();
  }

  function run(nq, opts, lim) {
    var x = idx;
    var toks = nq.split(' ').filter(Boolean);
    // A year with other words ("dune 2021"): that year's first, and not a word the name must have.
    var yr = 0;
    var Q = { nq: nq, spq: ' ' + nq, toks: toks, sp: toks.map(function (t) { return ' ' + t; }), art: ART.test(nq),
      alt: toks.map(function (t) { return ALT[t] || ''; }),
      opt: toks.map(function (t) { if (toks.length > 1 && /^(19|20)\d\d$/.test(t)) { yr = +t; return 1; } return toks.length > 1 && STOP[t] ? 1 : 0; }) };
    var types = opts.types ? new Set(opts.types) : null;
    var names = x.names, items = x.items, mark = x.mark, qid = ++x.qid;
    var sc = new Map();
    var tw = function (it) { return TYPE_W[it.t] || 0; };
    var consider = function (id) {
      if (mark[id] === qid) return;
      mark[id] = qid;
      var it = items[id];
      if (types && !types.has(it.t)) return;
      var n = names[id], s = scoreName(n, Q);
      if (s) sc.set(id, s + tw(it) - Math.min(8, n.length / 12));
    };
    // One to three letters: what starts with them is plenty (and far quicker than every word starting with them).
    var enough = false;
    var A = toks.length === 1 && nq.length <= 3 ? x.starts.get(nq) : null;
    if (A) { for (var a = 0; a < A.length; a++) consider(A[a]); enough = sc.size >= lim; }
    // Candidates: everything with a word starting like the most telling word typed (the one with fewest titles).
    var best = null, bestCost = Infinity;
    for (var t = 0; t < toks.length && !enough; t++) {
      if ((Q.opt[t] || Q.alt[t]) && toks.length > 1 && toks.some(function (o, i) { return !Q.opt[i] && !Q.alt[i]; })) continue;
      var ws = wordsFrom(x, toks[t]), cost = 0;
      for (var w = 0; w < ws.length && cost < bestCost; w++) cost += x.words.get(ws[w]).length;
      if (cost < bestCost || (cost === bestCost && best && toks[t].length > best.tk.length)) { bestCost = cost; best = { tk: toks[t], ws: ws }; }
    }
    if (best) for (var b = 0; b < best.ws.length; b++) { var l = x.words.get(best.ws[b]); for (var j = 0; j < l.length; j++) consider(l[j]); }
    // Not many: also where it's in the middle of a word ("sports" in "nbcsports", "zz" in "jazz").
    if (best && sc.size < lim) {
      for (var m = 0; m < x.list.length; m++) {
        var wd = x.list[m];
        if (wd.length > best.tk.length && wd.indexOf(best.tk, 1) > 0) { var l2 = x.words.get(wd); for (var j2 = 0; j2 < l2.length; j2++) consider(l2[j2]); }
      }
    }
    // Spelled together or apart ("spiderman" is Spider-Man, "super man" Superman): names without their spaces.
    var sq = nq.replace(/ /g, '');
    if (sc.size < 20 && sq.length >= 5 && x.done) {
      if (!x.sq || x.sq.length !== names.length) x.sq = names.map(function (n) { return n.replace(/ /g, ''); });
      for (var u = 0; u < x.sq.length; u++) {
        if (x.sq[u].indexOf(sq) < 0 || sc.has(u)) continue;
        var itu = items[u];
        if (types && !types.has(itu.t)) continue;
        sc.set(u, (x.sq[u] === sq ? 100 : x.sq[u].lastIndexOf(sq, 0) === 0 ? 80 : 52) + tw(itu) - Math.min(8, names[u].length / 12));
      }
    }
    // A channel number.
    if (/^\d{1,5}$/.test(nq)) (x.byNo.get(+nq) || []).forEach(function (id) { var it = items[id]; if (types && !types.has(it.t)) return; sc.set(id, Math.max(sc.get(id) || 0, 119 + tw(it) - Math.min(8, names[id].length / 12))); });
    // A category's name.
    if (opts.groups !== false && !enough && sc.size < lim * 3) {
      x.groups.forEach(function (ids, g) {
        if (sc.size >= lim * 3 || (g !== nq && g.lastIndexOf(nq, 0) !== 0)) return;
        for (var i = 0; i < ids.length && sc.size < lim * 3; i++) {
          var id = ids[i];
          if (sc.has(id)) continue;
          var it = items[id];
          if (types && !types.has(it.t)) continue;
          sc.set(id, 18 + tw(it) - Math.min(8, names[id].length / 12));
        }
      });
    }
    var out = [], entry = new Map();
    sc.forEach(function (s, id) { var en = { s: s, n: names[id], it: items[id] }; entry.set(id, en); out.push(en); });
    // Still being indexed (just after the catalogue came): look through some of what isn't yet, the slow way.
    if (!x.done) {
      urgent = true; schedule();
      var src = x.src, stop = Math.min(src.length, x.pos + 4000);
      for (var r = x.pos; r < stop; r++) {
        var it3 = src[r];
        if (!it3 || it3.t === 'episode' || (types && !types.has(it3.t))) continue;
        var n3 = V.norm(it3.n), s3 = scoreName(n3, Q);
        if (s3) out.push({ s: s3 + tw(it3) - Math.min(8, n3.length / 12), n: n3, it: it3 });
      }
    }
    // Episodes: those of the best-matching series (typed "s2", "s01e04"… too).
    if (opts.episodes && (!types || types.has('episode'))) {
      var core = toks.filter(function (tk) { return !EPCODE.test(tk); });
      var shows = [];
      if (core.length) {
        if (core.length === toks.length && (!types || types.has('show'))) { for (var o = 0; o < out.length; o++) if (out[o].it.t === 'show') shows.push(out[o]); }
        else shows = run(core.join(' '), { types: ['show'], groups: false }, 40).map(function (it, i) { return { s: 1000 - i, it: it }; });
        if (shows.length > 30) { shows.sort(function (a, b) { return b.s - a.s; }); shows.length = 30; }
        shows.forEach(function (sh) {
          var eps = sh.it._eps || (S.epsByShow && S.epsByShow.get(sh.it.k)) || [];
          for (var e = 0; e < eps.length; e++) {
            var ep = eps[e], en = epName(ep), es = scoreName(en, Q);
            if (es) out.push({ s: es - Math.min(8, en.length / 12), n: en, it: ep });
          }
        });
      }
    }
    // Few good hits: allow typos — one per four letters of a word, at most two — every word typed still in the name
    // ("the last huose", "how to train your dargon"), scored on the whole name like the rest.
    var bestS = 0;
    for (var bs = 0; bs < out.length; bs++) if (out[bs].s > bestS) bestS = out[bs].s;
    if (nq.length >= 4 && (out.length < 12 || bestS < 70)) {
      var fz = toks.map(function (tk, ti) { return { tk: tk, ti: ti }; }).filter(function (o) { return o.tk.length >= 4 && !Q.opt[o.ti] && !Q.alt[o.ti]; })
        .sort(function (a, b) { return b.tk.length - a.tk.length; }).slice(0, 2);
      var tried = {};
      fz.forEach(function (o) {
        var tk = o.tk, max = tk.length >= 8 ? 2 : 1;
        var pool = max < 2 ? x.pre.get(tk[0]) || [] : x.list;
        for (var i = 0; i < pool.length; i++) {
          var wd2 = pool[i];
          if (Math.abs(wd2.length - tk.length) > max || dist(tk, wd2, max) > max) continue;
          var list = x.words.get(wd2);
          for (var k = 0; k < list.length; k++) {
            var id2 = list[k];
            if (tried[id2]) continue;
            tried[id2] = 1;
            var it2 = items[id2];
            if (types && !types.has(it2.t)) continue;
            var fs = fuzzy(names[id2], Q);
            if (!fs) continue;
            var ts = fs + tw(it2) - Math.min(8, names[id2].length / 12), cur = entry.get(id2);
            if (!cur) { cur = { s: ts, n: names[id2], it: it2 }; entry.set(id2, cur); out.push(cur); } else if (ts > cur.s) cur.s = ts;
          }
        }
      });
    }
    // Things you've watched rank a little higher; things you've hidden lower.
    var prog = (S.data && S.data.progress) || {};
    var hidden = S.data && S.data.hidden && S.data.hidden.length ? new Set(S.data.hidden) : null;
    // Popular ones first among those that match as well (TMDB's popularity), and the year typed.
    for (var h = 0; h < out.length; h++) {
      var e2 = out[h], it4 = e2.it;
      if (hidden && hidden.has(it4.k)) e2.s -= 30;
      if (prog[it4.k]) e2.s += 3;
      if (it4.pp) e2.s += Math.min(7, Math.log(1 + it4.pp));
      if (yr && it4.y) e2.s += it4.y === yr ? 25 : -4;
    }
    // Lots of matches: only the best few hundred need sorting properly.
    if (out.length > lim * 3 && typeof Float64Array !== 'undefined' && Float64Array.prototype.sort) {
      var fa = new Float64Array(out.length);
      for (var q2 = 0; q2 < out.length; q2++) fa[q2] = -out[q2].s;
      fa.sort();
      var cut = -fa[lim - 1];
      out = out.filter(function (y) { return y.s >= cut; });
    }
    // Ties go alphabetically (by the plain-letters name, which is much quicker to compare than localeCompare).
    out.sort(function (a, b) { return b.s - a.s || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0); });
    var res = new Array(Math.min(lim, out.length));
    for (var z = 0; z < res.length; z++) res[z] = out[z].it;
    if (!x.done) res.partial = true;
    return res;
  }

  /** Up to n things to suggest while typing: titles and channels, one of each name (a channel in HD and SD once). */
  function suggest(q, n) {
    n = n || 8;
    var list = find(q, { limit: n * 5, types: ['movie', 'show', 'live', 'radio'], groups: false });
    var seen = {}, out = [];
    for (var i = 0; i < list.length && out.length < n; i++) {
      var it = list[i];
      if (V.inList && S.data && V.inList('hidden', it.k)) continue;
      var key = (it.t === 'live' || it.t === 'radio' ? 'ch' : it.t) + '|' + V.norm(it.n).replace(/\b(hd|fhd|uhd|sd|4k|hevc|h265|raw|backup)\b/g, '').replace(/\s+/g, ' ').trim() + '|' + (it.y || '');
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(it);
    }
    if (list.partial) out.partial = true;
    return out;
  }

  /** Finishes the index now (tests, and a page that can't wait). */
  function buildNow() { sync(); while (!idx.done) step(1000); }

  V.on('episodes-warm', function () { ver++; cache = {}; });
  return { find: find, suggest: suggest, reset: reset, changed: function () { ver++; cache = {}; }, ready: function () { return !!idx && idx.done; }, buildNow: buildNow, dist: dist };
})();
