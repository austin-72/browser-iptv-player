/* TV guide data, fetched from the server: a rolling now/next window for every channel, plus ranges on demand. */
'use strict';
V.epg = (function () {
  var now = {}; // key -> [programmes] (about −3 h … +8 h)
  var loadedAt = 0;
  var ranges = new Map(); // key -> {from, to, list}
  var loading = null;
  var shift = function (it, list) {
    if (!it || !it.sh || !list) return list;
    var d = it.sh * 3600e3;
    return list.map(function (p) { return Object.assign({}, p, { s: p.s + d, e: p.e + d }); });
  };

  function load() {
    if (loading) return loading;
    loading = V.api('/api/epg/now').then(function (j) {
      now = (j && j.p) || {};
      loadedAt = Date.now();
      ranges.clear();
      V.emit('epg');
    }).catch(function () {}).then(function () { loading = null; });
    return loading;
  }
  setInterval(function () { if (S.profile && !document.hidden && Date.now() - loadedAt > 20 * 60e3) load(); }, 60e3);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S.profile && Date.now() - loadedAt > 10 * 60e3) load(); });

  function listFor(it) {
    if (!it) return null;
    var k = it.t === 'catchup' ? it.catchupOf : it.k;
    return now[k] ? shift(V.entry(k) || it, now[k]) : null;
  }

  return {
    load: load,
    has: function (it) { return !!(it && (it.E || now[it.k])); },
    nowNext: function (it, t) {
      t = t || Date.now();
      var list = listFor(it);
      if (!list) return { now: null, next: null };
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (p.e <= t) continue;
        if (p.s <= t) return { now: p, next: list[i + 1] || null };
        return { now: null, next: p };
      }
      return { now: null, next: null };
    },
    upcoming: function (it, n) {
      var list = listFor(it) || [];
      var t = Date.now();
      return list.filter(function (p) { return p.s > t; }).slice(0, n || 8);
    },
    earlier: function (it) {
      var list = listFor(it) || [];
      var t = Date.now();
      return list.filter(function (p) { return p.e <= t; }).reverse();
    },
    /** Programmes for many channels between two times. Resolves to {key: [programmes]}. */
    range: function (keys, from, to) {
      var need = keys.filter(function (k) { var r = ranges.get(k); return !(r && r.from <= from && r.to >= to); });
      var done = function () {
        var out = {};
        keys.forEach(function (k) { var r = ranges.get(k); var it = V.entry(k); out[k] = r ? shift(it, r.list.filter(function (p) { return p.e > from && p.s < to; })) : (listFor(it) || []).filter(function (p) { return p.e > from && p.s < to; }); });
        return out;
      };
      if (!need.length) return Promise.resolve(done());
      var chunks = [];
      for (var i = 0; i < need.length; i += 150) chunks.push(need.slice(i, i + 150));
      var f = from - 3600e3, t2 = to + 3600e3;
      return Promise.all(chunks.map(function (c) {
        return V.api('/api/epg/range?keys=' + c.map(encodeURIComponent).join(',') + '&from=' + f + '&to=' + t2).then(function (j) {
          c.forEach(function (k) { ranges.set(k, { from: f, to: t2, list: j[k] || [] }); });
        });
      })).then(done, done);
    },
    search: function (q) { return V.api('/api/epg/search?q=' + encodeURIComponent(q)); },
    clear: function () { now = {}; ranges.clear(); loadedAt = 0; },
  };
})();
