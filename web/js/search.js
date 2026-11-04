/* Instant search over the catalogue: a word index built a little at a time in the background (so the page never
   stalls), prefix and substring matches first, then typo-tolerant matches. Also the suggestions under a search box. */
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
  function scoreName(n, Q) {
    if (n === Q.nq) return 120;
    var p = n.indexOf(Q.nq);
    if (p === 0) return 90;
    if (p > 0) return n.indexOf(Q.spq) >= 0 ? 75 : 50;
    var part = 0;
    for (var t = 0; t < Q.toks.length; t++) {
      var tk = Q.toks[t];
      if (n.lastIndexOf(tk, 0) === 0 || n.indexOf(Q.sp[t]) >= 0) part += 2;
      else if (n.indexOf(tk) >= 0) part += 1;
      else return 0;
    }
    return 30 + part * 4;
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
    var Q = { nq: nq, spq: ' ' + nq, toks: toks, sp: toks.map(function (t) { return ' ' + t; }) };
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
    // A channel number.
    if (/^\d{1,5}$/.test(nq)) (x.byNo.get(+nq) || []).forEach(function (id) { var it = items[id]; if (types && !types.has(it.t)) return; sc.set(id, 200 + tw(it) - Math.min(8, names[id].length / 12)); });
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
    // Few hits: allow typos (one per 4 letters, at most two).
    if (out.length < 12 && nq.length >= 4) {
      toks.forEach(function (tk) {
        if (tk.length < 4) return;
        var max = tk.length >= 8 ? 2 : 1;
        var pool = max < 2 ? x.pre.get(tk[0]) || [] : x.list;
        for (var i = 0; i < pool.length; i++) {
          var wd2 = pool[i];
          if (Math.abs(wd2.length - tk.length) > max) continue;
          var d = dist(tk, wd2, max);
          if (d > max) continue;
          var list = x.words.get(wd2);
          for (var k = 0; k < list.length; k++) {
            var id2 = list[k], it2 = items[id2];
            if (types && !types.has(it2.t)) continue;
            var ts = 22 - d * 6 + tw(it2), cur = entry.get(id2);
            if (!cur) { cur = { s: ts, n: names[id2], it: it2 }; entry.set(id2, cur); out.push(cur); } else if (ts > cur.s) cur.s = ts;
          }
        }
      });
    }
    // Things you've watched rank a little higher; things you've hidden lower.
    var prog = (S.data && S.data.progress) || {};
    var hidden = S.data && S.data.hidden && S.data.hidden.length ? new Set(S.data.hidden) : null;
    for (var h = 0; h < out.length; h++) { var e2 = out[h]; if (hidden && hidden.has(e2.it.k)) e2.s -= 30; if (prog[e2.it.k]) e2.s += 3; }
    // Lots of matches: only the best few hundred need sorting properly.
    if (out.length > lim * 3 && typeof Float64Array !== 'undefined') {
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

/**
 * Suggestions under a search box as you type: up to 8 titles, channels and people. Up/Down (and a TV remote's) move
 * through them, Enter opens one (or, with none picked, runs the search), Escape closes the list.
 * o: { onSearch(q): Enter with nothing picked, onPick(it), people: true }
 */
V.autocomplete = function (input, o) {
  o = o || {};
  var host = input.closest('form') || input.parentNode;
  host.classList.add('ac-host');
  var box = document.createElement('div');
  var id = 'ac-' + V.uid();
  box.className = 'ac-list';
  box.id = id;
  box.setAttribute('role', 'listbox');
  box.setAttribute('aria-label', 'Suggestions');
  box.hidden = true;
  host.appendChild(box);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', id);
  input.setAttribute('autocomplete', 'off');
  var opts = [], active = -1, shownQ = null, people = [], peopleQ = '', peopleSeq = 0, timer = null, peopleT = null, closed = false;
  var LABEL = { movie: 'Film', show: 'Series', live: 'Channel', radio: 'Radio', person: 'Person' };
  var ICON = { movie: 'film', show: 'stack', live: 'tv', radio: 'radio', person: 'users' };

  // The letters typed, in bold where a word of the name starts with them.
  var mark = function (name, q) {
    var toks = q.toLowerCase().split(/\s+/).filter(Boolean).sort(function (a, b) { return b.length - a.length; });
    var low = name.toLowerCase(), on = [];
    toks.forEach(function (tk) {
      var p = -1;
      while ((p = low.indexOf(tk, p + 1)) >= 0) { if (p === 0 || !/[a-z0-9À-￿]/i.test(low[p - 1])) { for (var i = p; i < p + tk.length; i++) on[i] = 1; break; } }
    });
    var html = '', b = false;
    for (var i = 0; i < name.length; i++) {
      if (!!on[i] !== b) { html += b ? '</b>' : '<b>'; b = !b; }
      html += V.esc(name[i]);
    }
    return html + (b ? '</b>' : '');
  };
  var meta = function (it) {
    if (it.t === 'person') return it.role === 'dir' ? 'Director' : 'Actor';
    var bits = [LABEL[it.t] || V.TYPE_NAMES[it.t] || ''];
    if ((it.t === 'movie' || it.t === 'show') && it.y) bits.push(it.y);
    if ((it.t === 'live' || it.t === 'radio') && it.no) bits.push(it.no);
    return bits.join(' · ');
  };
  var render = function (q) {
    var list = opts;
    if (!list.length || closed) { hide(); return; }
    box.innerHTML = list.map(function (it, i) {
      return '<div class="ac-o' + (i === active ? ' on' : '') + '" role="option" id="' + id + '-' + i + '" data-i="' + i + '" aria-selected="' + (i === active) + '">' +
        '<span class="ac-ic">' + V.icon(ICON[it.t] || 'search') + '</span><span class="ac-t">' + mark(it.n, q) + '</span><span class="ac-m">' + V.esc(meta(it)) + '</span></div>';
    }).join('');
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', id + '-' + active); else input.removeAttribute('aria-activedescendant');
  };
  var hide = function () {
    box.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };
  var setActive = function (i) {
    active = i;
    var els = box.children;
    for (var k = 0; k < els.length; k++) { var on = k === i; els[k].classList.toggle('on', on); els[k].setAttribute('aria-selected', String(on)); }
    if (i >= 0 && els[i]) { input.setAttribute('aria-activedescendant', id + '-' + i); if (els[i].scrollIntoView && box.scrollHeight > box.clientHeight) els[i].scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
  };
  var compute = function () {
    timer = null;
    if (!document.contains(input)) return;
    var q = input.value.trim();
    if (q === shownQ && !box.hidden) return;
    shownQ = q;
    active = -1;
    if (!q || !S.items) { opts = []; hide(); return; }
    var list = V.search.suggest(q, 8);
    // People (from the server, which knows the cast of everything), after a pause; kept while their name still fits
    // what's typed. At most two, after the titles.
    var toks = V.norm(q).split(' ');
    var ppl = people.filter(function (p) { var ws = V.norm(p.n).split(' '); return toks.every(function (tk) { return ws.some(function (w) { return w.lastIndexOf(tk, 0) === 0; }); }); });
    opts = list.slice(0, 8 - ppl.length).concat(ppl);
    render(q);
    if (o.people !== false && q.length >= 3 && V.norm(q) !== V.norm(peopleQ)) {
      clearTimeout(peopleT);
      var my = ++peopleSeq;
      peopleT = setTimeout(function () {
        V.api('/api/search/people?q=' + encodeURIComponent(q)).then(function (pp) {
          if (my !== peopleSeq || input.value.trim() !== q) return;
          peopleQ = q;
          people = (pp || []).slice(0, 2).map(function (x) { return { t: 'person', n: x.name, role: x.role, k: 'person:' + x.name }; });
          if (people.length) { shownQ = null; compute(); }
        }).catch(function () {});
      }, 300);
    }
  };
  var schedule = function () { if (closed) closed = false; clearTimeout(timer); timer = setTimeout(compute, 40); };
  var pick = function (i) {
    var it = opts[i];
    if (!it) return;
    var q = input.value.trim();
    hide();
    shownQ = null;
    if (q.length > 1 && V.addSearch) V.addSearch(q);
    if (o.onPick && o.onPick(it) === false) return;
    if (it.t === 'person') { V.router.go('#/search?q=' + encodeURIComponent(it.n)); return; }
    input.blur();
    if (it.t === 'live' || it.t === 'radio') V.play(it);
    else V.router.go(V.hrefOf(it));
  };

  input.addEventListener('input', schedule);
  input.addEventListener('focus', function () { if (input.value.trim()) { closed = false; shownQ = null; schedule(); } });
  input.addEventListener('blur', function () { setTimeout(function () { if (document.activeElement !== input) hide(); }, 150); });
  input.addEventListener('keydown', function (e) {
    var open = !box.hidden && opts.length;
    var k = e.key;
    if (k === 'ArrowDown' || k === 'Down') {
      if (!open) { if (opts.length && input.value.trim()) { closed = false; render(input.value.trim()); setActive(0); e.preventDefault(); e.stopPropagation(); } return; }
      e.preventDefault(); e.stopPropagation();
      // At the end of the list, a TV remote moves on down the page.
      if (active >= opts.length - 1 && V.tvMode) { hide(); closed = true; if (V.tvMove) V.tvMove('down', input); return; }
      setActive(Math.min(opts.length - 1, active + 1));
    } else if (k === 'ArrowUp' || k === 'Up') {
      if (!open) return;
      if (active < 0) { hide(); closed = true; return; } // (and on a TV, Up leaves the box as usual)
      e.preventDefault(); e.stopPropagation();
      setActive(active - 1);
    } else if (k === 'Enter') {
      if (open && active >= 0) { e.preventDefault(); e.stopPropagation(); pick(active); return; }
      // The full search instead.
      clearTimeout(timer); hide(); closed = true;
      if (o.onSearch) { e.preventDefault(); o.onSearch(input.value.trim()); }
    } else if (k === 'Escape' || k === 'Esc') {
      if (open) { e.preventDefault(); e.stopPropagation(); hide(); closed = true; }
    } else if (k === 'Tab') hide();
  });
  // Mouse and touch: the box keeps focus (so the list stays), a tap or click opens the one picked.
  box.addEventListener('mousedown', function (e) { e.preventDefault(); });
  box.addEventListener('click', function (e) { var el = e.target.closest('[data-i]'); if (el) pick(+el.dataset.i); });
  box.addEventListener('mousemove', function (e) { var el = e.target.closest('[data-i]'); if (el && +el.dataset.i !== active) setActive(+el.dataset.i); });
  // The index finished after the first letters were typed: the suggestions again, complete.
  var off = V.on('search-ready', function () { if (!document.contains(input)) { off(); return; } if (!box.hidden) { shownQ = null; compute(); } });
  return {
    close: function () { clearTimeout(timer); hide(); closed = true; },
    refresh: function () { shownQ = null; compute(); },
    destroy: function () { off(); clearTimeout(timer); clearTimeout(peopleT); if (box.parentNode) box.parentNode.removeChild(box); },
  };
};
