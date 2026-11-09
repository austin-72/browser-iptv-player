/* The profile's data and the catalogue, kept in sync with the server. */
'use strict';

V.TYPE_NAMES = { live: 'Live TV', radio: 'Radio', movie: 'Movie', show: 'Series', episode: 'Episode', catchup: 'Catch-up' };
V.entry = function (k) { return (S.byKey && S.byKey.get(k)) || (S.extra && S.extra.get(k)) || null; };

// ---------------------------------------------------------------- catalogue
/**
 * The light catalogue (server: Catalog.liteItem): for TVs and games consoles — a PlayStation's browser runs out of
 * memory on a big full one and the page just dies — and for any device where loading the catalogue didn't finish
 * twice running (the page died partway: catLite, kept). About half the size, in small pieces, not kept on the device.
 */
V.liteCatalog = function () {
  var c = null;
  try { c = V.ls.get('catLite'); } catch (e) {}
  if (c === '1') return true;
  if (c === '0') return false; // (turned off on this device: Settings → Look)
  return !!(V.lite && V.lite());
};
// (Loading started and never finished, twice running: from then on the light one.)
function loadStarted() {
  if (S.catCounted) return; // (once a page load: switching profiles mid-load isn't a page that died)
  S.catCounted = true;
  try {
    var n = +(V.ls.get('catLoads') || 0);
    if (n >= 2 && V.ls.get('catLite') !== '1') { V.ls.set('catLite', '1'); S.catLiteNew = true; }
    V.ls.set('catLoads', String(n + 1));
  } catch (e) {}
}
function loadFinished() { try { V.ls.set('catLoads', '0'); } catch (e) {} }
/** Reads a light catalogue's shortened addresses ("~3~1234.mkv": table P) and category numbers (table SC). */
V.unpackCatalog = function (items, P, SC) {
  if (!items || (!P && !SC)) return;
  var un = function (s) {
    if (typeof s !== 'string' || s.charAt(0) !== '~') return s;
    var j = s.indexOf('~', 1), h = P && P[parseInt(s.slice(1, j), 36)];
    return h === undefined || h === null ? s : h + s.slice(j + 1);
  };
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.i) it.i = un(it.i);
    if (it.u) it.u = un(it.u);
    if (it.a) for (var a = 0; a < it.a.length; a++) it.a[a].u = un(it.a[a].u);
    if (it.sc && SC) for (var c = 0; c < it.sc.length; c++) if (typeof it.sc[c] === 'number') it.sc[c] = SC[it.sc[c]];
  }
};
/** Stream addresses for titles from the light catalogue (sent without them), fetched when one is played. */
V.fetchAddresses = function (keys) {
  return V.api('/api/addresses?keys=' + keys.map(encodeURIComponent).join(',')).then(function (r) {
    (r.items || []).forEach(function (x) { var it = V.entry(x.k); if (!it) return; if (x.u) it.u = x.u; if (x.a) it.a = x.a; if (x.h) it.h = x.h; });
  });
};

V.loadCatalog = function (force, tries) {
  var pid = S.profile.id;
  var cacheKey = 'catalog:' + pid;
  var cached = null;
  if (!tries) loadStarted();
  var lite = V.liteCatalog();
  S.catLite = lite;
  // (A newer load replaces this one: the pages still coming for this one stop.)
  var token = S.catalogLoad = (S.catalogLoad || 0) + 1;
  var start = force || lite ? Promise.resolve(null) : V.readCatalogCache(cacheKey);
  return start.then(function (c) {
    cached = c;
    var h = {};
    if (c && c.etag) h['If-None-Match'] = c.etag;
    // With a copy here already, the server can send just what changed since.
    if (lite) return fetch('/api/catalog?lite=1', { credentials: 'same-origin' });
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
      if (data.lite) V.unpackCatalog(data.items, data.P, data.SC);
      if (data.delta) {
        if (!cached || !cached.data) return V.loadCatalog(true);
        data = V.applyCatalogDelta(cached.data, data);
      } else if (data.pages > 1) {
        // A big catalogue comes in pages: start with the first (all the live channels and the first films), and
        // fetch the rest in the background. It's kept on this device once it's all here.
        V.catalogRest(token, pid, cacheKey, etag, data);
        return data;
      }
      if (!lite) V.saveCatalogCache(cacheKey, etag, data);
      return data;
    });
  }, function (e) {
    if (cached) { S.offlineCatalog = true; return cached.data; }
    throw e;
  }).then(function (data) {
    if (token !== S.catalogLoad && S.items) return data; // (a newer load already drew)
    S.catalogVersion = data.base || data.version;
    var items = data.items || [];
    // A big copy from this device: the first part now (the page can be drawn), the rest in slices just after.
    if (items.length > 150000 && !data.pages) indexInParts(token, items);
    else V.index(items);
    if (!data.pages || data.pages <= 1) loadFinished();
    S.catLoadedAt = Date.now();
    if (S.catLiteNew) { S.catLiteNew = false; setTimeout(function () { V.toast('This device had trouble loading everything, so it now loads a lighter catalogue (the same titles, less kept in memory).', { ms: 8000 }); }, 1500); }
    V.emit('catalog');
    return data;
  });
};
function indexInParts(token, items) {
  // (Opened on a title or channel that's in the later part: all of it now, rather than "not found" for a moment.)
  var m = /^#\/(title|channel)\/([^?]+)/.exec(location.hash), want = null;
  if (m) { try { want = decodeURIComponent(m[2]); } catch (e) { want = m[2]; } }
  if (want) for (var w = 100000; w < items.length; w++) if (items[w].k === want) { V.index(items); return; }
  var all = items.slice(0, 100000), i = all.length;
  V.index(all);
  var step = function () {
    if (token !== S.catalogLoad || S.items !== all) return;
    if (i >= items.length) { V.catalogComplete(); return; }
    for (var end = Math.min(items.length, i + 25000); i < end; i++) all.push(items[i]);
    V.indexMore(all).then(step);
  };
  setTimeout(step, 50);
}
/** All of a big catalogue is in: everything that uses it hears, and the page is drawn again if that won't get in the way. */
V.catalogComplete = function () {
  V.emit('catalog');
  V.renderShell();
  // (Re-drawn only when it won't get in the way: not while typing, in a dialog, or watching full screen.)
  var ae = document.activeElement;
  var busy = (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) || V.$('dialog[open]') || (V.watch && V.watch.it && !V.watch.mini);
  if (!busy) V.router.refresh();
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

// The copy of the catalogue kept on this device, in parts of 5,000: one put or get of half a million titles holds
// the page up for a second or more (several on a TV); parts are written in idle moments and read one at a time.
var CACHE_PART = 5000;
V.saveCatalogCache = function (key, etag, data) {
  var items = (data && data.items) || [];
  var parts = Math.ceil(items.length / CACHE_PART);
  var go = function () {
    if (parts <= 1) return V.idb.set(key, { etag: etag, data: data });
    var head = { etag: etag, data: { version: data.version, base: data.base, items: null, parts: parts, total: items.length } };
    var i = 0;
    var next = function () {
      if (i >= parts) return V.idb.set(key, head).then(function () {
        // (Parts left from a bigger catalogue before.)
        return V.idb.keys().then(function (ks) { ks.forEach(function (k) { var m = typeof k === 'string' && k.indexOf(key + '#') === 0 ? +k.slice(key.length + 1) : -1; if (m >= parts) V.idb.del(k); }); });
      });
      var p = i++;
      return new Promise(function (ok) { V.idle(ok, { timeout: 1500 }); }).then(function () { return V.idb.set(key + '#' + p, items.slice(p * CACHE_PART, (p + 1) * CACHE_PART)); }).then(next);
    };
    // (The old copy's head goes first, so a copy half written is never taken for a whole one.)
    return V.idb.del(key).then(next);
  };
  try { var w = go(); if (w && w.catch) w.catch(function () {}); return w; } catch (e) { return Promise.resolve(); }
};
V.readCatalogCache = function (key) {
  return V.idb.get(key).then(function (c) {
    if (!c || !c.data || !c.data.parts) return c || null;
    var items = [], i = 0;
    var next = function () {
      if (i >= c.data.parts) {
        if (items.length !== c.data.total) return null;
        return { etag: c.etag, data: { version: c.data.version, base: c.data.base, items: items } };
      }
      return V.idb.get(key + '#' + i++).then(function (part) {
        if (!part || !part.length) return null; // (a part missing: no copy, then)
        for (var j = 0; j < part.length; j++) items.push(part[j]);
        return next();
      });
    };
    return next();
  }).catch(function () { return null; });
};

/**
 * One page of a big catalogue. The answer is read in a worker and handed over a few thousand titles at a time: reading
 * 100,000 titles at once holds the page up for a quarter of a second here, and seconds on a TV. (Browsers without
 * workers, or where one can't start, read it here.)
 */
V.fetchCatalogPage = (function () {
  var w = null, broken = false, seq = 0, waiting = {};
  var SRC = 'onmessage=function(e){var id=e.data.id;try{fetch(e.data.url,{credentials:"same-origin"}).then(function(r){if(!r.ok){postMessage({id:id,status:r.status});return;}' +
    'return r.json().then(function(d){var it=d.items||[];for(var i=0;i<it.length;i+=2000)postMessage({id:id,part:it.slice(i,i+2000)});postMessage({id:id,status:200});});})' +
    '.catch(function(err){postMessage({id:id,error:String(err&&err.message||err)});});}catch(err){postMessage({id:id,error:String(err&&err.message||err),nofetch:true});}};';
  var here = function (url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) return { status: r.status, items: [] };
      return r.json().then(function (d) { return { status: 200, items: d.items || [] }; });
    });
  };
  var fallback = function () {
    broken = true;
    if (w) { try { w.terminate(); } catch (e) {} w = null; }
    var ws = waiting; waiting = {};
    Object.keys(ws).forEach(function (id) { here(ws[id].url).then(ws[id].ok, ws[id].no); });
  };
  var worker = function () {
    if (w || broken) return w;
    try {
      if (!window.Worker || !window.Blob || !window.URL || !URL.createObjectURL) { broken = true; return null; }
      w = new Worker(URL.createObjectURL(new Blob([SRC], { type: 'text/javascript' })));
      w.onmessage = function (e) {
        var m = e.data, job = waiting[m.id];
        if (!job) return;
        if (m.part) { for (var i = 0; i < m.part.length; i++) job.items.push(m.part[i]); return; }
        if (m.nofetch) { fallback(); return; }
        delete waiting[m.id];
        if (m.error) job.no(new Error(m.error));
        else job.ok({ status: m.status, items: job.items });
      };
      w.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); fallback(); };
    } catch (e) { broken = true; w = null; }
    return w;
  };
  var fn = function (url) {
    var wk = worker();
    if (!wk) return here(url);
    return new Promise(function (ok, no) {
      var id = ++seq;
      waiting[id] = { ok: ok, no: no, items: [], url: url };
      wk.postMessage({ id: id, url: location.protocol + '//' + location.host + url });
    });
  };
  /** Done with pages for now (the worker isn't kept around). */
  fn.done = function () { if (w && !Object.keys(waiting).length) { try { w.terminate(); } catch (e) {} w = null; } };
  return fn;
})();

/** The other pages of a big catalogue, one after another. Each is indexed as it comes (a little at a time), so search
 *  finds it straight away; the pages already on screen are re-drawn once it's all here. */
V.catalogRest = function (token, pid, cacheKey, etag, first) {
  var all = first.items, page = 1, tries = 0, indexing = Promise.resolve();
  var stale = function () { return token !== S.catalogLoad || !S.profile || S.profile.id !== pid; };
  var show = function () {
    var el = V.$('#cat-more');
    if (!S.catalogLoading) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'cat-more'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.innerHTML = '<span class="spinner sm"></span> Loading the rest of the catalogue… ' + Math.floor(100 * S.catalogLoading.got / Math.max(1, S.catalogLoading.total)) + '%';
  };
  S.catalogLoading = { got: all.length, total: first.total || all.length };
  show();
  var finish = function () {
    if (stale()) return;
    var data = { version: first.version, base: first.base, items: all };
    S.catalogLoading = null; show();
    V.fetchCatalogPage.done();
    S.catalogVersion = data.base || data.version;
    loadFinished();
    V.catalogComplete();
    // (A very big catalogue may not fit in this browser's storage: then it's fetched again next time. The light one
    // isn't kept: reading it back would cost a slow device as much as fetching it.)
    if (!first.lite) V.saveCatalogCache(cacheKey, etag, data);
  };
  var next = function () {
    if (stale()) return;
    if (page >= first.pages) { indexing.then(finish); return; }
    return V.fetchCatalogPage('/api/catalog?page=' + page + '&v=' + encodeURIComponent(etag || '') + (first.lite ? '&lite=1' : '')).then(function (r) {
      if (stale()) return;
      // The catalogue changed meanwhile: start again with the new one.
      if (r.status === 409) { S.catalogLoading = null; show(); return V.loadCatalog(true).catch(function () {}); }
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      if (first.lite) V.unpackCatalog(r.items, first.P, first.SC);
      for (var i = 0; i < r.items.length; i++) all.push(r.items[i]);
      page++; tries = 0;
      S.catalogLoading.got = all.length;
      show();
      indexing = indexing.then(function () { if (!stale()) return V.indexMore(all); });
      return next();
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

// ---------------------------------------------------------------- the catalogue, sorted out by kind
var epCmp = function (a, b) { return (a.s || 0) - (b.s || 0) || (a.e || 0) - (b.e || 0); };
var chCmp = function (a, b) { return (a.so || a.no || 0) - (b.so || b.no || 0); };
/** Sorts items[from..to) into the lists by kind (episodes into their series, in order). True if channels were added. */
function indexRange(items, from, to) {
  var groups = S.groups, chans = false;
  for (var i = from; i < to; i++) {
    var it = items[i];
    S.byKey.set(it.k, it);
    var t = it.t;
    if (t === 'live') { S.live.push(it); chans = true; }
    else if (t === 'radio') { S.radio.push(it); chans = true; }
    else if (t === 'movie') S.movies.push(it);
    else if (t === 'show') S.shows.push(it);
    else if (t === 'episode') {
      S.episodes.push(it);
      var l = S.epsByShow.get(it.sk);
      if (!l) S.epsByShow.set(it.sk, (l = []));
      // (They nearly always come in order: then it's just the end of the list.)
      if (!l.length || epCmp(l[l.length - 1], it) <= 0) l.push(it);
      else { var lo = 0, hi = l.length; while (lo < hi) { var mid = (lo + hi) >> 1; if (epCmp(l[mid], it) <= 0) lo = mid + 1; else hi = mid; } l.splice(lo, 0, it); }
    }
    var gm = groups[t];
    if (gm) { var g = gm.get(it.g); if (!g) gm.set(it.g, (g = [])); g.push(it); }
    // Smarter categories (smartcats.js): a title can be in several.
    var sc = it.sc, sm = sc && S.sgroups && S.sgroups[t];
    if (sm) for (var c = 0; c < sc.length; c++) { var sg = sm.get(sc[c]); if (!sg) sm.set(sc[c], (sg = [])); sg.push(it); }
    if ((t === 'movie' || t === 'show') && it.gn) for (var j = 0; j < it.gn.length; j++) { var arr = S.genres.get(it.gn[j]); if (!arr) S.genres.set(it.gn[j], (arr = [])); arr.push(it); }
  }
  S.indexedN = to;
  return chans;
}
function sortChannels() {
  // (so: the admin's place for a channel in its category, Admin → Channels; otherwise the channel number.)
  S.live.sort(chCmp);
  S.radio.sort(chCmp);
}
V.index = function (items) {
  S.items = items;
  S.byKey = new Map();
  S.extra = S.extra || new Map();
  S.live = []; S.radio = []; S.movies = []; S.shows = []; S.episodes = [];
  S.epsByShow = new Map();
  S.groups = { live: new Map(), radio: new Map(), movie: new Map(), show: new Map() };
  S.sgroups = { live: new Map(), radio: new Map(), movie: new Map(), show: new Map() };
  S.genres = new Map();
  S.indexedN = 0;
  S.catalogStamp = (S.catalogStamp || 0) + 1; // (for lists worked out from the catalogue and kept: browse.js)
  indexRange(items, 0, items.length);
  sortChannels();
  if (V.search) V.search.reset();
};
/**
 * More of the catalogue now on screen (its later pages, added to the end of the same list): sorted in a few
 * milliseconds at a time, between key presses. Resolves once it's all in.
 */
V.indexMore = function (items) {
  if (items !== S.items) {
    if (!S.items || !S.byKey || !items.length || items[0] !== S.items[0] || items.length < S.items.length) { V.index(items); return Promise.resolve(); }
    S.items = items;
  }
  var chans = false;
  return new Promise(function (done) {
    var tick = function (dl) {
      if (S.items !== items) { done(); return; } // (another catalogue by now)
      while (S.indexedN < items.length) {
        if (indexRange(items, S.indexedN, Math.min(items.length, S.indexedN + 500))) chans = true;
        if (dl.timeRemaining() <= 0) break;
      }
      if (S.indexedN < items.length) { V.idle(tick, { timeout: 300 }); return; }
      if (chans) sortChannels();
      S.catalogStamp = (S.catalogStamp || 0) + 1;
      if (V.search) V.search.reset(true);
      done();
    };
    V.idle(tick, { timeout: 300 });
  });
};

/** Groups for a type, biggest first, as [{name, items}]. */
// (The providers' own categories. The ones to show people — smarter ones when the admin has them on: V.groupList.)
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
  // (Asked for once at a time: playing an episode, its page and the player's buttons all want them at once.)
  if (show._epsP) return show._epsP;
  show._epsP = V.api('/api/show/' + encodeURIComponent(show.k) + '/episodes').then(function (eps) {
    show._epsP = null;
    eps.forEach(function (e) { if (!S.byKey.has(e.k)) S.extra.set(e.k, e); });
    if (V.search) V.search.changed();
    show._eps = eps.map(function (e) { return V.entry(e.k) || e; });
    return show._eps;
  }, function (e) { show._epsP = null; throw e; });
  return show._epsP;
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
  // (No profile open — back at "Who's watching?" while something was still on its way: nothing to continue.)
  if (!S.data || !S.data.progress) return out;
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
