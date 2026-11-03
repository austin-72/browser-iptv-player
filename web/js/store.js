/* The profile's data and the catalogue, kept in sync with the server. */
'use strict';

V.TYPE_NAMES = { live: 'Live TV', radio: 'Radio', movie: 'Movie', show: 'Series', episode: 'Episode', catchup: 'Catch-up' };
V.entry = function (k) { return (S.byKey && S.byKey.get(k)) || (S.extra && S.extra.get(k)) || null; };

// ---------------------------------------------------------------- catalogue
V.loadCatalog = function (force, tries) {
  var pid = S.profile.id;
  var cacheKey = 'catalog:' + pid;
  var cached = null;
  // (A newer load replaces this one: the pages still coming for this one stop.)
  var token = S.catalogLoad = (S.catalogLoad || 0) + 1;
  var start = force ? Promise.resolve(null) : V.idb.get(cacheKey);
  return start.then(function (c) {
    cached = c;
    var h = {};
    if (c && c.etag) h['If-None-Match'] = c.etag;
    // With a copy here already, the server can send just what changed since.
    return fetch('/api/catalog' + (c && c.etag && c.data && c.data.items ? '?since=' + encodeURIComponent(c.etag) : ''), { headers: h, credentials: 'same-origin' });
  }).then(function (r) {
    if (r.status === 304 && cached) return cached.data;
    // Still being put together on the server (a huge catalogue after a change): the copy here meanwhile, or wait and
    // ask again.
    if (r.status === 503 && r.headers.get('Retry-After')) {
      if (cached && cached.data) { setTimeout(function () { V.emit('catalog-stale', {}); }, 15000); return cached.data; }
      if ((tries || 0) < 60) return new Promise(function (ok) { setTimeout(ok, 5000); }).then(function () { return V.loadCatalog(force, (tries || 0) + 1); });
    }
    if (!r.ok) return V.catalogError(r);
    var etag = r.headers.get('ETag');
    return r.json().then(function (data) {
      if (data.delta) {
        if (!cached || !cached.data) return V.loadCatalog(true);
        data = V.applyCatalogDelta(cached.data, data);
      } else if (data.pages > 1) {
        // A big catalogue comes in pages: start with the first (all the live channels and the first films), and
        // fetch the rest in the background. It's kept on this device once it's all here.
        V.catalogRest(token, pid, cacheKey, etag, data);
        return data;
      }
      V.idb.set(cacheKey, { etag: etag, data: data });
      return data;
    });
  }, function (e) {
    if (cached) { S.offlineCatalog = true; return cached.data; }
    throw e;
  }).then(function (data) {
    if (token !== S.catalogLoad && S.items) return data; // (a newer load already drew)
    S.catalogVersion = data.base || data.version;
    V.index(data.items || []);
    V.emit('catalog');
    return data;
  });
};

/** A refused answer, as a readable error (a proxy's own error page isn't JSON: say what it means instead). */
V.catalogError = function (r) {
  return r.text().then(function (t) {
    var j = null;
    try { j = JSON.parse(t); } catch (e) {}
    if (j && j.error) throw new Error(j.error);
    throw new Error(r.status >= 500 ? 'The server is busy getting the catalogue ready. Try again in a minute.' : 'Couldn’t load the catalogue');
  });
};

/** The other pages of a big catalogue, one after another; the pages already on screen are re-drawn once it's all here. */
V.catalogRest = function (token, pid, cacheKey, etag, first) {
  var all = first.items.slice(), page = 1, tries = 0;
  var stale = function () { return token !== S.catalogLoad || !S.profile || S.profile.id !== pid; };
  var show = function () {
    var el = V.$('#cat-more');
    if (!S.catalogLoading) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'cat-more'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.innerHTML = '<span class="spinner sm"></span> Loading the rest of the catalogue… ' + Math.floor(100 * S.catalogLoading.got / Math.max(1, S.catalogLoading.total)) + '%';
  };
  S.catalogLoading = { got: all.length, total: first.total || all.length };
  show();
  var next = function () {
    if (stale()) return;
    if (page >= first.pages) {
      var data = { version: first.version, base: first.base, items: all };
      S.catalogLoading = null; show();
      S.catalogVersion = data.base || data.version;
      V.index(all);
      V.emit('catalog');
      V.renderShell();
      // (Re-drawn only when it won't get in the way: not while typing, in a dialog, or watching full screen.)
      var ae = document.activeElement;
      var busy = (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) || V.$('dialog[open]') || (V.watch && V.watch.it && !V.watch.mini);
      if (!busy) V.router.refresh();
      // (A very big catalogue may not fit in this browser's storage: then it's fetched again next time.)
      try { var w = V.idb.set(cacheKey, { etag: etag, data: data }); if (w && w.catch) w.catch(function () {}); } catch (e) {}
      return;
    }
    return fetch('/api/catalog?page=' + page + '&v=' + encodeURIComponent(etag || ''), { credentials: 'same-origin' }).then(function (r) {
      if (stale()) return;
      // The catalogue changed meanwhile: start again with the new one.
      if (r.status === 409) { S.catalogLoading = null; show(); return V.loadCatalog(true).catch(function () {}); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json().then(function (d) {
        if (stale()) return;
        for (var i = 0; i < d.items.length; i++) all.push(d.items[i]);
        page++; tries = 0;
        S.catalogLoading.got = all.length;
        show();
        return next();
      });
    }).catch(function () {
      if (stale()) return;
      // (A dropped connection or a busy server: wait and ask for the same page again, a few times.)
      if (++tries > 4) { S.catalogLoading = null; show(); V.toast('Part of the catalogue didn’t load. It will try again when the page reloads.', { error: true }); return; }
      return new Promise(function (ok) { setTimeout(ok, 3000 * tries); }).then(next);
    });
  };
  next();
};

/** Applies the changes the server sent ({set, del}) to the copy kept on this device. */
V.applyCatalogDelta = function (old, d) {
  var pos = new Map();
  var items = old.items.slice();
  items.forEach(function (it, i) { pos.set(it.k, i); });
  d.set.forEach(function (it) { var i = pos.get(it.k); if (i === undefined) { pos.set(it.k, items.length); items.push(it); } else items[i] = it; });
  if (d.del.length) { var gone = new Set(d.del); items = items.filter(function (it) { return !gone.has(it.k); }); }
  return { version: d.version, base: d.base, items: items };
};

V.index = function (items) {
  S.items = items;
  S.byKey = new Map();
  S.extra = S.extra || new Map();
  S.live = []; S.radio = []; S.movies = []; S.shows = []; S.episodes = [];
  S.epsByShow = new Map();
  var groups = { live: new Map(), radio: new Map(), movie: new Map(), show: new Map() };
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    S.byKey.set(it.k, it);
    if (it.t === 'live') S.live.push(it);
    else if (it.t === 'radio') S.radio.push(it);
    else if (it.t === 'movie') S.movies.push(it);
    else if (it.t === 'show') S.shows.push(it);
    else if (it.t === 'episode') {
      S.episodes.push(it);
      var l = S.epsByShow.get(it.sk);
      if (!l) S.epsByShow.set(it.sk, (l = []));
      l.push(it);
    }
    var gm = groups[it.t];
    if (gm) { var g = gm.get(it.g); if (!g) gm.set(it.g, (g = [])); g.push(it); }
  }
  // (so: the admin's place for a channel in its category, Admin → Channels; otherwise the channel number.)
  S.live.sort(function (a, b) { return (a.so || a.no || 0) - (b.so || b.no || 0); });
  S.radio.sort(function (a, b) { return (a.so || a.no || 0) - (b.so || b.no || 0); });
  S.epsByShow.forEach(function (l) { l.sort(function (a, b) { return a.s - b.s || a.e - b.e; }); });
  S.groups = groups;
  S.genres = new Map();
  for (var j = 0; j < items.length; j++) {
    var x = items[j];
    if ((x.t === 'movie' || x.t === 'show') && x.gn) x.gn.forEach(function (gname) { var arr = S.genres.get(gname); if (!arr) S.genres.set(gname, (arr = [])); arr.push(x); });
  }
  if (V.search) V.search.reset();
};

/** Groups for a type, biggest first, as [{name, items}]. */
V.groupsOf = function (type) {
  var m = S.groups && S.groups[type];
  if (!m) return [];
  var out = [];
  m.forEach(function (list, name) { out.push({ name: name, items: list }); });
  return out;
};

V.showOf = function (it) { return it && it.sk ? V.entry(it.sk) : null; };
V.unit = function (it) { return it && it.t === 'episode' ? V.showOf(it) || it : it; };

/** Episodes of a show: from the catalogue, or loaded from the server (Xtream series load on demand). */
V.loadEpisodes = function (show) {
  if (show._eps) return Promise.resolve(show._eps);
  var local = S.epsByShow.get(show.k) || [];
  if (!show.x && local.length) { show._eps = local; return Promise.resolve(local); }
  return V.api('/api/show/' + encodeURIComponent(show.k) + '/episodes').then(function (eps) {
    eps.forEach(function (e) { if (!S.byKey.has(e.k)) S.extra.set(e.k, e); });
    if (V.search) V.search.reset();
    show._eps = eps.map(function (e) { return V.entry(e.k) || e; });
    return show._eps;
  });
};

/**
 * Episodes of Xtream series are fetched only when a show is opened, so after a reload the ones in your progress
 * and history aren't known yet. Fetch them for the shows you've been watching (a few at a time) and re-draw.
 */
V.warmEpisodes = function () {
  if (!S.data || !S.byKey) return Promise.resolve(false);
  var want = [], seen = {};
  var add = function (k, sk) {
    if (!sk || seen[sk] || V.entry(k)) return;
    var show = S.byKey.get(sk);
    if (!show || show._eps) return;
    seen[sk] = 1; want.push(show);
  };
  var prog = S.data.progress;
  Object.keys(prog).sort(function (a, b) { return prog[b].at - prog[a].at; }).forEach(function (k) { add(k, prog[k].sk); });
  S.data.history.forEach(function (h) { add(h.k, h.sk); });
  want = want.slice(0, 20);
  if (!want.length) return (S.warming = Promise.resolve(false));
  var i = 0;
  var next = function () { if (i >= want.length) return Promise.resolve(); var sh = want[i++]; return V.loadEpisodes(sh).catch(function () {}).then(next); };
  S.warming = Promise.all([next(), next(), next()]).then(function () { V.emit('episodes-warm'); return true; });
  return S.warming;
};

// ---------------------------------------------------------------- the profile's data
V.progressOf = function (k) { return (S.data && S.data.progress[k]) || null; };
V.pctOf = function (k) { var p = V.progressOf(k); if (!p) return 0; if (p.w) return 1; return p.d ? V.clamp(p.p / p.d, 0, 1) : 0; };

var pendingProgress = {};
var flushProgress = V.debounce(function () { V.flushProgress(); }, 2500);
V.flushProgress = function (keepalive) {
  var list = Object.keys(pendingProgress).map(function (k) { return pendingProgress[k]; });
  pendingProgress = {};
  list.forEach(function (b) { V.api('/api/progress', { body: b, keepalive: !!keepalive }).catch(function () { pendingProgress[b.k] = pendingProgress[b.k] || b; }); });
};
V.saveProgress = function (it, pos, dur, immediate) {
  if (!it || !it.k || it.t === 'live' || it.t === 'catchup' || S.data.prefs.historyPaused) return;
  if (!dur || !isFinite(dur)) return;
  var watched = pos / dur > 0.92 || (dur > 1200 && dur - pos < 180);
  var prev = S.data.progress[it.k] || {};
  S.data.progress[it.k] = { p: watched ? 0 : pos, d: dur, w: watched || !!prev.w, at: Date.now(), sk: it.sk, n: it.n, t: it.t };
  pendingProgress[it.k] = { k: it.k, p: pos, d: dur, sk: it.sk || '', n: it.n, t: it.t };
  if (immediate) V.flushProgress(true); else flushProgress();
  V.emit('progress', it.k);
};
window.addEventListener('pagehide', function () { V.flushProgress(true); });
document.addEventListener('visibilitychange', function () { if (document.hidden) V.flushProgress(true); });

V.played = function (it, seconds, leaving) {
  if (!it || !it.k || !S.data || S.data.prefs.historyPaused) return;
  var k = it.t === 'catchup' ? it.catchupOf : it.k;
  var t = it.t === 'catchup' ? 'live' : it.t;
  var h = S.data.history;
  if (h[0] && h[0].k === k && Date.now() - h[0].at < 6 * 3600e3) { h[0].at = Date.now(); h[0].s = (h[0].s || 0) + seconds; } else h.unshift({ k: k, at: Date.now(), s: seconds, t: t, sk: it.sk, n: it.n });
  V.api('/api/played', { body: { k: k, s: seconds, t: t, sk: it.sk || '', n: it.n || '' }, keepalive: !!leaving }).catch(function () {});
  V.emit('history');
};

// (Looked up for every title when lists are drawn — with a big catalogue, a Set rather than searching the array each
// time. It's made again whenever the list is a different one or has changed length or ends.)
var inListCache = {};
V.inList = function (field, k) {
  var a = S.data[field];
  if (!a) return false;
  if (a.length < 50) return a.indexOf(k) >= 0;
  var c = inListCache[field];
  if (!c || c.a !== a || c.n !== a.length || c.first !== a[0] || c.last !== a[a.length - 1]) c = inListCache[field] = { a: a, n: a.length, first: a[0], last: a[a.length - 1], set: new Set(a) };
  return c.set.has(k);
};
V.toggle = function (field, k, on) {
  var list = S.data[field];
  var has = list.indexOf(k) >= 0;
  var want = on === undefined ? !has : !!on;
  if (want && !has) list.unshift(k);
  if (!want && has) S.data[field] = list.filter(function (x) { return x !== k; });
  delete inListCache[field];
  V.emit('data', field);
  return V.api('/api/toggle', { body: { field: field, k: k, on: want } }).then(function () { return want; }, function (e) {
    // (Not saved: put it back as it was, so the button and the list agree.)
    var l2 = S.data[field];
    if (want && l2.indexOf(k) >= 0 && !has) S.data[field] = l2.filter(function (x) { return x !== k; });
    else if (!want && has && l2.indexOf(k) < 0) l2.unshift(k);
    delete inListCache[field];
    V.emit('data', field);
    V.fail(e); return has;
  });
};
V.rate = function (k, v) {
  if (!v) delete S.data.ratings[k]; else S.data.ratings[k] = v;
  V.emit('data', 'ratings');
  return V.api('/api/rate', { body: { k: k, v: v } }).catch(V.fail);
};
V.ratingOf = function (k) { return S.data.ratings[k] || 0; };

// Changes made close together are gathered and sent as one (each one is kept, not just the last).
var prefPatch = {};
var savePrefs = V.debounce(function () { var p = prefPatch; prefPatch = {}; if (Object.keys(p).length) V.put('/api/me/prefs', p).catch(V.fail); }, 600);
V.setPref = function (k, v) {
  S.data.prefs[k] = v;
  prefPatch[k] = v;
  savePrefs();
  V.emit('prefs', k);
};
V.pref = function (k) { return S.data && S.data.prefs ? S.data.prefs[k] : undefined; };

V.addBookmark = function (it, t, note) {
  return V.api('/api/bookmarks', { body: { k: it.k, t: t, note: note || '', n: it.n } }).then(function (b) { S.data.bookmarks.unshift(b); V.emit('data', 'bookmarks'); return b; });
};
V.removeBookmark = function (id) { S.data.bookmarks = S.data.bookmarks.filter(function (b) { return b.id !== id; }); V.emit('data', 'bookmarks'); return V.del('/api/bookmarks/' + id).catch(V.fail); };
V.editBookmark = function (id, note) { var b = S.data.bookmarks.filter(function (x) { return x.id === id; })[0]; if (b) b.note = note; V.emit('data', 'bookmarks'); return V.put('/api/bookmarks/' + id, { note: note }).catch(V.fail); };

// The last 10; a longer search replaces the bits of it typed before ("sabri" → "sabrina").
V.addSearch = function (q) { if (!q) return; var lq = q.toLowerCase(); S.data.searches = [q].concat(S.data.searches.filter(function (x) { var lx = x.toLowerCase(); return lx !== lq && lq.indexOf(lx) !== 0; })).slice(0, 10); V.api('/api/searches', { body: { q: q } }).catch(function () {}); };
/** Forget one recent search, or all of them (q = null). */
V.removeSearch = function (q) {
  S.data.searches = q === null ? [] : S.data.searches.filter(function (x) { return x !== q; });
  V.del('/api/searches' + (q === null ? '' : '?q=' + encodeURIComponent(q))).catch(V.fail);
};

var impressions = new Set();
var flushImpressions = V.debounce(function () { var keys = Array.from(impressions); impressions.clear(); if (keys.length) V.api('/api/impressions', { body: { keys: keys } }).catch(function () {}); }, 8000);
V.impression = function (k) { impressions.add(k); flushImpressions(); };

V.saveHome = function () { return V.put('/api/home', S.data.home).catch(V.fail); };

// ---------------------------------------------------------------- what to show
/** Continue watching: started and unfinished, newest first. For series, the episode to resume or the next one. */
V.continueWatching = function () {
  var out = [];
  var seenShows = new Set();
  var prog = S.data.progress;
  var keys = Object.keys(prog).sort(function (a, b) { return prog[b].at - prog[a].at; });
  for (var i = 0; i < keys.length && out.length < 40; i++) {
    var k = keys[i], p = prog[k];
    var it = V.entry(k);
    if (!it) continue;
    if (S.data.hidden.indexOf(k) >= 0) continue;
    if (it.sk && S.data.hidden.indexOf(it.sk) >= 0) continue; // "Not interested" on the series
    if (it.t === 'episode') {
      if (seenShows.has(it.sk)) continue;
      seenShows.add(it.sk);
      if (p.w) { var nx = V.nextEpisode(it); if (nx && !(prog[nx.k] && prog[nx.k].w)) out.push({ it: nx, next: true, at: p.at }); continue; }
      // The latest episode you started; if it's barely begun, still show it when you've watched more of the series.
      if (p.p > 20 || keys.some(function (k2) { return k2 !== k && prog[k2].sk === it.sk; })) out.push({ it: it, at: p.at });
      continue;
    }
    if (it.t === 'movie' && !p.w && p.p > 30) out.push({ it: it, at: p.at });
  }
  return out;
};

V.nextEpisode = function (ep) {
  var list = (S.epsByShow.get(ep.sk) || []);
  var show = V.showOf(ep);
  if (show && show._eps && show._eps.length > list.length) list = show._eps;
  for (var i = 0; i < list.length; i++) if (list[i].k === ep.k) return list[i + 1] || null;
  for (var j = 0; j < list.length; j++) if (list[j].s > ep.s || (list[j].s === ep.s && list[j].e > ep.e)) return list[j];
  return null;
};

/** Where to start a show: the episode in progress, else the one after the last watched, else the first. */
V.resumePoint = function (show, eps) {
  var prog = S.data.progress;
  var best = null;
  (eps || []).forEach(function (e) { var p = prog[e.k]; if (p && (!best || p.at > prog[best.k].at)) best = e; });
  if (!best) return { ep: (eps || [])[0] || null, pos: 0, label: 'Play' };
  var p = prog[best.k];
  if (p.w) {
    var i = eps.indexOf(best);
    var nx = eps[i + 1];
    return nx ? { ep: nx, pos: 0, label: 'Play ' + V.epLabel(nx) } : { ep: eps[0], pos: 0, label: 'Watch again' };
  }
  return { ep: best, pos: p.p, label: 'Resume ' + V.epLabel(best) };
};

V.recentChannels = function () {
  var out = [];
  var seen = new Set();
  S.data.history.forEach(function (h) { var it = V.entry(h.k); if (it && (it.t === 'live' || it.t === 'radio') && !seen.has(h.k)) { seen.add(h.k); out.push(it); } });
  return out;
};

V.isNew = function (it) { return it.ad && Date.now() / 1000 - it.ad < 14 * 86400; };
// (Tracks inside files and streams name their language with three letters: "eng", "ger"/"deu"…)
V.langName = (function () {
  var LANG3 = { eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', nob: 'no', dan: 'da', fin: 'fi', pol: 'pl', rus: 'ru', ukr: 'uk', jpn: 'ja', chi: 'zh', zho: 'zh', kor: 'ko', ara: 'ar', tur: 'tr', gre: 'el', ell: 'el', heb: 'he', hin: 'hi', cze: 'cs', ces: 'cs', slo: 'sk', slk: 'sk', hun: 'hu', rum: 'ro', ron: 'ro', bul: 'bg', hrv: 'hr', srp: 'sr', slv: 'sl', ice: 'is', isl: 'is', tha: 'th', vie: 'vi', ind: 'id', may: 'ms', msa: 'ms', per: 'fa', fas: 'fa', cat: 'ca', wel: 'cy', cym: 'cy', gle: 'ga', est: 'et', lav: 'lv', lit: 'lt' };
  return function (code) { var n = S.settings && S.settings.langNames, c = String(code || '').toLowerCase(); return (n && (n[code] || n[c] || n[LANG3[c]])) || String(code || '').toUpperCase(); };
})();
