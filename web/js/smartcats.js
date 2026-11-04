/* Smarter categories (Admin → Categories): channels, films and series grouped by network and streaming service,
   genre, sport, holiday, theme and studio instead of the providers' own categories; trending and popular worldwide
   (TMDB's charts); My List in the order things were played, added or liked. The server works out each item's
   categories (lib/smartcats.js: it.sc); this groups by them. */
'use strict';
(function () {
  var cfg = function () { return (S.settings && S.settings.smart) || { on: false }; };
  var defsSrc = null, defsById = {}, kindOrder = {};
  var defs = function () {
    var c = cfg();
    if (defsSrc !== c) {
      defsSrc = c; defsById = {}; kindOrder = {};
      (c.defs || []).forEach(function (d, i) { d.i = i; defsById[d.id] = d; });
      (c.kinds || []).forEach(function (k, i) { kindOrder[k.k] = i; });
    }
    return defsById;
  };
  var ID = /^(?:n|g|s|h|t|st|c|e|x|tr|v|p):\S+$/;
  var VOD = { movie: 1, show: 1 };

  V.smart = {
    on: function () { return !!cfg().on; },
    cfg: cfg,
    isId: function (id) { return typeof id === 'string' && ID.test(id); },
    def: function (id) { return defs()[id] || null; },
    /** A category's name ("In cinemas now" for films, "On TV this week" for series). */
    label: function (id, type) {
      if (id && id.indexOf('p:') === 0) return id.slice(2);
      var d = defs()[id];
      return d ? (d.nt && d.nt[type]) || d.n : id;
    },
    kindName: function (k) { var ks = cfg().kinds || []; for (var i = 0; i < ks.length; i++) if (ks[i].k === k) return ks[i].n; return k === 'prov' ? 'From your providers' : ''; },
    season: function () { return cfg().season || []; },
  };

  // ---------------------------------------------------------------- trending worldwide (TMDB's charts)
  var trend = null, trendAt = 0, trendLoading = null;
  V.smart.loadTrend = function (force) {
    if (!V.smart.on()) return Promise.resolve(null);
    if (trendLoading) return trendLoading;
    if (trend && !force && Date.now() - trendAt < 3600e3) return Promise.resolve(trend);
    trendLoading = V.api('/api/smart/trending').then(function (r) {
      trend = r || { lists: {} }; trendAt = Date.now(); trendMemo = {};
      V.emit('trending');
      // (Something on screen shows the charts: drawn again with them.)
      var pg = document.body.dataset.page, h = location.hash;
      if (pg === 'home' || ((pg === 'movies' || pg === 'series') && /[?&]g=tr(%3A|:)/.test(h))) V.router.refresh();
      return trend;
    }).catch(function () { return null; }).then(function (r) { trendLoading = null; return r; });
    return trendLoading;
  };
  V.on('trending-push', function () { V.smart.loadTrend(true); });
  V.smart.trendAt = function () { return trendAt; };
  var trendMemo = {}, trendStamp = -1;
  /** A chart's titles here, in chart order: the first copy of each that this profile has. */
  var trendItems = function (id, type) {
    if (trendStamp !== S.catalogStamp) { trendMemo = {}; trendStamp = S.catalogStamp; }
    var mk = id + '|' + type;
    if (trendMemo[mk]) return trendMemo[mk];
    if (!trend) { V.smart.loadTrend(); return []; }
    var l = (trend.lists[id] || {})[type] || [], out = [], seen = new Set();
    for (var i = 0; i < l.length; i++) {
      for (var j = 0; j < l[i].length; j++) { var it = S.byKey.get(l[i][j]); if (it && it.t === type && !seen.has(it.k)) { seen.add(it.k); out.push(it); break; } }
    }
    trendMemo[mk] = out;
    return out;
  };
  var virtualItems = function (id, type) {
    if (id.indexOf('tr:') === 0) return trendItems(id, type);
    var all = type === 'movie' ? S.movies : S.shows;
    var mk = id + '|' + type;
    if (trendStamp !== S.catalogStamp) { trendMemo = {}; trendStamp = S.catalogStamp; }
    if (trendMemo[mk]) return trendMemo[mk];
    var out;
    if (id === 'v:new') { var since = Date.now() / 1000 - 30 * 86400; out = all.filter(function (x) { return (x.ad || 0) >= since; }).sort(function (a, b) { return (b.ad || 0) - (a.ad || 0); }); }
    else if (id === 'v:rel') { var y = new Date().getFullYear() - 1; out = all.filter(function (x) { return (x.y || 0) >= y; }).sort(function (a, b) { return (b.pp || 0) - (a.pp || 0) || (b.ad || 0) - (a.ad || 0); }); }
    else out = [];
    trendMemo[mk] = out;
    return out;
  };

  // ---------------------------------------------------------------- what's in a category
  /** The items of a category (smart id, "p:" + a provider's category, or a provider's category by its name). */
  V.groupItems = function (type, id) {
    if (!id) return [];
    if (V.smart.isId(id)) {
      if (id.indexOf('p:') === 0) return (S.groups[type] && S.groups[type].get(id.slice(2))) || [];
      if (id.indexOf('tr:') === 0 || id.indexOf('v:') === 0) return VOD[type] ? virtualItems(id, type) : [];
      return (S.sgroups && S.sgroups[type] && S.sgroups[type].get(id)) || [];
    }
    return (S.groups[type] && S.groups[type].get(id)) || [];
  };
  var memberSets = {};
  /** Is this item in that category? */
  V.inGroup = function (it, id) {
    if (!id) return true;
    if (!V.smart.isId(id)) return it.g === id;
    if (id.indexOf('p:') === 0) return it.g === id.slice(2);
    if (id.indexOf('tr:') === 0 || id.indexOf('v:') === 0) {
      var mk = id + '|' + it.t, set = memberSets[mk];
      if (!set || set.src !== virtualItems(id, it.t)) { var src = virtualItems(id, it.t); set = memberSets[mk] = new Set(src.map(function (x) { return x.k; })); set.src = src; }
      return set.has(it.k);
    }
    return !!it.sc && it.sc.indexOf(id) >= 0;
  };

  /**
   * The categories to offer for a type, in order: [{ name: id, label, kind, items }]. Smarter ones (when on: networks,
   * genres, … — what's in season first among the holidays), then the providers' own when the admin keeps them.
   * Off: the providers' categories, A–Z.
   */
  V.groupList = function (type) {
    var out = [];
    var prov = function () { var l = []; if (S.groups && S.groups[type]) S.groups[type].forEach(function (items, name) { l.push({ name: name, label: name, kind: 'prov', items: items }); }); return l.sort(function (a, b) { return V.nameCmp(a.label, b.label); }); };
    if (!V.smart.on()) return prov();
    var c = cfg(), d = defs(), min = c.min || 1, season = c.season || [];
    var m = (S.sgroups && S.sgroups[type]) || new Map();
    var add = function (def, items) { if (items.length >= min) out.push({ name: def.id, label: V.smart.label(def.id, type), kind: def.k, items: items, def: def }); };
    (c.defs || []).forEach(function (def) {
      if (def.types && def.types.indexOf(type) < 0) return;
      if (def.k === 'top') { if (VOD[type]) add(def, virtualItems(def.id, type)); return; }
      if (def.k === 'hol' && c.holidays === 'season' && season.indexOf(def.id) < 0) return;
      var items = m.get(def.id);
      if (items) add(def, items);
    });
    // (Order: the kinds as the admin has them; within one, the charts and holidays as listed — in season first — the
    // biggest countries first, everything else A–Z, with "Everything else" and "Adults only" at the end.)
    var last = { 'g:other': 2, 'g:adult': 1 };
    out.sort(function (a, b) {
      var ka = kindOrder[a.kind] || 0, kb = kindOrder[b.kind] || 0;
      if (ka !== kb) return ka - kb;
      if (a.kind === 'top') return a.def.i - b.def.i;
      if (a.kind === 'hol') { var sa = season.indexOf(a.name), sb = season.indexOf(b.name); if ((sa >= 0) !== (sb >= 0)) return sa >= 0 ? -1 : 1; if (sa >= 0) return sa - sb; return a.def.i - b.def.i; }
      if (a.kind === 'country') return b.items.length - a.items.length;
      if ((last[a.name] || 0) !== (last[b.name] || 0)) return (last[a.name] || 0) - (last[b.name] || 0);
      return V.nameCmp(a.label, b.label);
    });
    if (c.keep) out = out.concat(prov().map(function (x) { x.name = 'p:' + x.name; return x; }));
    return out;
  };

  /** <option>s for a category list, in groups under each kind's name. */
  V.groupOptions = function (list, cur) {
    var html = '', open = '';
    list.forEach(function (x) {
      if (x.head !== undefined) return;
      var k = x.kind || '';
      if (k && k !== open && V.smart.on()) { if (open) html += '</optgroup>'; html += '<optgroup label="' + V.esc(V.smart.kindName(k)) + '">'; open = k; }
      html += '<option value="' + V.esc(x.v !== undefined ? x.v : x.name) + '"' + ((x.v !== undefined ? x.v : x.name) === cur ? ' selected' : '') + '>' + V.esc(x.l || x.label || x.name) + (x.n !== undefined ? ' (' + x.n + ')' : x.items ? ' (' + x.items.length + ')' : '') + '</option>';
    });
    return html + (open ? '</optgroup>' : '');
  };

  /** A short line naming what something is: its network and genre ("Netflix · Comedy"), else its provider's category. */
  V.catLabel = function (it) {
    if (!it) return '';
    if (!V.smart.on() || !it.sc || !it.sc.length) return it.g || '';
    var pick = [], net = null, gen = null;
    for (var i = 0; i < it.sc.length; i++) {
      var id = it.sc[i];
      if (!defs()[id]) continue;
      if (!net && id.indexOf('n:') === 0) net = id;
      if (!gen && id.indexOf('g:') === 0 && id !== 'g:other' && id !== 'g:entertainment') gen = id;
    }
    if (net) pick.push(V.smart.label(net)); if (gen) pick.push(V.smart.label(gen));
    return pick.length ? pick.join(' · ') : it.g || '';
  };

  /** Quick choices above Movies / Series: the charts, the holidays in season, the biggest services. */
  V.smart.chips = function (type, cur, base) {
    if (!V.smart.on()) return '';
    var list = V.groupList(type);
    var top = list.filter(function (x) { return x.kind === 'top'; });
    var season = V.smart.season();
    var hol = list.filter(function (x) { return x.kind === 'hol' && season.indexOf(x.name) >= 0; });
    var nets = list.filter(function (x) { return x.kind === 'net'; }).sort(function (a, b) { return b.items.length - a.items.length; }).slice(0, 8);
    var chips = top.concat(hol, nets);
    if (!chips.length) return '';
    return '<div class="moods smart-chips" role="group" aria-label="Quick categories">' + chips.map(function (x) {
      return '<a class="chip' + (x.name === cur ? ' on' : '') + '" href="#/' + base + '?g=' + encodeURIComponent(x.name) + '"' + (x.name === cur ? ' aria-current="true"' : '') + '>' + (x.kind === 'hol' ? V.icon('sparkle') + ' ' : '') + V.esc(x.label) + '</a>';
    }).join('') + '</div>';
  };

  /** Names a search can find a category's titles by (its name, other names: "xmas"). */
  V.smart.searchNames = function (id) {
    var d = defs()[id];
    if (!d) return [];
    var out = [V.norm(d.n)];
    if (d.nt) for (var t in d.nt) out.push(V.norm(d.nt[t]));
    (d.aka || []).forEach(function (a) { out.push(V.norm(a)); });
    return out;
  };
  /** Categories whose name a search matches ("christmas" → Christmas), for links at the top of the results. */
  V.smart.matching = function (q) {
    var nq = V.norm(q);
    if (!V.smart.on() || nq.length < 3) return [];
    var out = [];
    (cfg().defs || []).forEach(function (d) {
      if (d.k === 'top' || d.k === 'country') return;
      var names = V.smart.searchNames(d.id);
      if (names.some(function (n) { return n === nq || (nq.length >= 4 && n.lastIndexOf(nq, 0) === 0); })) out.push(d);
    });
    return out.slice(0, 6);
  };

  // ---------------------------------------------------------------- My List: recently played, then added or liked
  /**
   * My List in order: what was played most recently first, then the rest by when it was added (or given a thumbs up,
   * when the admin counts liked titles as part of it). order: 'played' | 'added' | 'az'.
   */
  V.myListOrdered = function (order) {
    var c = cfg();
    order = order || c.listOrder || 'played';
    var d = S.data || {};
    var keys = (d.list || []).slice();
    var liked = c.liked !== false;
    if (liked) for (var k in d.ratings || {}) if (d.ratings[k] > 0 && keys.indexOf(k) < 0) { var it0 = V.entry(k); if (it0 && VOD[it0.t]) keys.push(k); }
    var addedAt = function (k, i) { var a = (d.listAt || {})[k] || 0, r = liked && d.ratings && d.ratings[k] > 0 ? (d.ratedAt || {})[k] || 0 : 0; return Math.max(a, r) || (1e12 - i); };
    var played = {};
    if (order === 'played') {
      (d.history || []).forEach(function (h) { var at = h.at || 0; [h.k, h.sk].forEach(function (x) { if (x && (!played[x] || played[x] < at)) played[x] = at; }); });
      for (var pk in d.progress || {}) { var p = d.progress[pk]; [pk, p.sk].forEach(function (x) { if (x && p.at && (!played[x] || played[x] < p.at)) played[x] = p.at; }); }
    }
    var items = [];
    keys.forEach(function (k, i) { var it = V.entry(k); if (it) items.push({ it: it, p: played[k] || 0, a: addedAt(k, i) }); });
    if (order === 'az') items.sort(function (x, y) { return V.nameCmp(x.it.n, y.it.n); });
    else items.sort(function (x, y) { return (y.p - x.p) || (y.a - x.a); });
    return items.map(function (x) { return x.it; });
  };

  // ---------------------------------------------------------------- home rows: trending worldwide, the holiday in season
  V.HOME_ROWS.splice(4, 0, { id: 'trending', name: 'Trending worldwide' });
  V.HOME_ROWS.splice(5, 0, { id: 'holiday', name: 'Holiday picks (in season)' });
  var prevRow = V.homeRowBuilder;
  V.homeRowBuilder = function (id, add) {
    if (id === 'trending') {
      if (!V.smart.on()) return;
      var m = trendItems('tr:week', 'movie'), s = trendItems('tr:week', 'show'), mixed = [];
      for (var i = 0; i < Math.max(m.length, s.length) && mixed.length < 40; i++) { if (m[i]) mixed.push(m[i]); if (s[i]) mixed.push(s[i]); }
      mixed = mixed.filter(function (x) { return !V.inList('hidden', x.k); });
      if (mixed.length >= 3) add({ id: 'trending', title: 'Trending worldwide this week', items: mixed, numbered: true, more: '#/movies?g=tr%3Aweek' });
      return;
    }
    if (id === 'holiday') {
      if (!V.smart.on()) return;
      V.smart.season().forEach(function (h) {
        var def = V.smart.def(h);
        if (!def) return;
        var pool = V.groupItems('movie', h).concat(V.groupItems('show', h)).filter(function (x) { return !V.inList('hidden', x.k); });
        pool.sort(function (a, b) { return (b.pp || 0) - (a.pp || 0) || (b.r || 0) - (a.r || 0); });
        if (pool.length >= 3) add({ id: 'holiday:' + h, title: def.n + ' picks', items: pool.slice(0, 40), more: '#/movies?g=' + encodeURIComponent(h) });
      });
      return;
    }
    if (prevRow) prevRow(id, add);
  };

  // ---------------------------------------------------------------- Admin → Categories: the switch and its choices
  var prevTab = V.adminTabs.categories;
  V.adminTabs.categories = function (body, A) {
    body.innerHTML = '<div class="smart-adm"><div class="spinner"></div></div><div class="smart-rest"></div>';
    prevTab(V.$('.smart-rest', body), A);
    var box = V.$('.smart-adm', body);
    var st = null, open = V.ls.get('smartAdmOpen', '') || '';
    var load = function () { return V.api('/api/admin/smart').then(function (r) { st = r; draw(); }).catch(function (e) { box.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; }); };
    var TYPES = [['live', 'Live TV'], ['movie', 'Movies'], ['show', 'Series'], ['radio', 'Radio']];
    var countOf = function (id) { var c = st.counts[id] || {}; return TYPES.map(function (t) { return c[t[0]] ? c[t[0]] + ' ' + t[1].toLowerCase() : ''; }).filter(Boolean).join(', '); };
    var draw = function () {
      var c = st.config, hidden = new Set(c.hidden || []);
      var sw = function (k, title, help, on) { return '<label class="switch"><input type="checkbox" data-sm="' + k + '"' + (on ? ' checked' : '') + '><span class="sw"></span><span><b>' + title + '</b>' + (help ? '<small>' + help + '</small>' : '') + '</span></label>'; };
      var kinds = st.kinds.map(function (k) {
        var list = st.builtins.filter(function (d) { return d.k === k.k; });
        if (k.k === 'own') list = (c.custom || []).map(function (x) { return { id: x.id, n: x.n, k: 'own' }; });
        var used = list.filter(function (d) { return countOf(d.id); }).length;
        return '<div class="smart-kind-row"><label class="check"><input type="checkbox" data-kind-on="' + k.k + '"' + (c.kinds[k.k] !== false ? ' checked' : '') + '><span><b>' + V.esc(k.n) + '</b></span></label>' +
          '<details class="smart-kind" data-kind="' + k.k + '"' + (open === k.k ? ' open' : '') + '><summary class="dim small">' + (k.k === 'own' ? V.plural(list.length, 'category', 'categories') + ' — add or change' : used + ' of ' + list.length + ' have something — choose and rename') + '</summary>' +
          (k.k === 'own' ? ownEditor(c) : '<table class="rules smart-defs"><thead><tr><th>Show</th><th>Category</th><th>Name it</th><th>Now</th></tr></thead><tbody>' + list.map(function (d) {
            return '<tr data-id="' + V.esc(d.id) + '"><td><input type="checkbox" data-show' + (hidden.has(d.id) ? '' : ' checked') + ' aria-label="Show ' + V.esc(d.n) + '"></td><td>' + V.esc(d.n) + (st.season.indexOf(d.id.slice(2)) >= 0 && d.k === 'hol' ? ' <span class="chip sm pri">in season</span>' : '') + '</td><td><input class="input" data-name value="' + V.esc((c.names || {})[d.id] || '') + '" placeholder="' + V.esc(d.n) + '"></td><td class="dim small">' + V.esc(countOf(d.id) || '—') + '</td></tr>';
          }).join('') + '</tbody></table>') + '</details></div>';
      }).join('');
      box.innerHTML = '<section class="card-sec"><h2>Smarter categories</h2>' +
        sw('on', 'Use smarter categories', 'Instead of each provider’s own categories (“VOD - NEW ADDED”, “|EN| ✪ COMEDY”), everything is grouped by what it is: networks and streaming services (Netflix, Disney+, Hulu, ABC, ESPN…), genres (Comedy, Horror, Sports…), sports, holidays (Christmas, Halloween…), themes and studios. Movies and Series get Trending, Popular and Top rated from TMDB — worldwide, not what this household watches. Applies to Live TV, the guide, Movies and Series straight away.', c.on) +
        '<div class="smart-opts"' + (c.on ? '' : ' hidden') + '>' +
        sw('keep', 'Keep the providers’ categories too', 'Listed after the smarter ones, under “From your providers”.', c.keep) +
        sw('extras', 'Fetch streaming services, keywords and studios from TMDB', 'In the background, about 7 titles a second: which services each film and series is on, its keywords (for holidays and themes), its networks and studios, and how popular it is worldwide. ' + (st.tmdb ? st.extras.withExtras.toLocaleString() + ' of ' + st.extras.fetched.toLocaleString() + ' titles with TMDB details have them so far.' : 'Needs a TMDB key (Admin → Recommendations).'), c.extras) +
        sw('epg', 'Let the guide decide a channel’s genre too', 'A channel whose listings are mostly sport, news, films or children’s programmes goes in that genre.', c.epg) +
        sw('plot', 'A holiday in the plot counts', 'A film whose description mentions Christmas, Halloween, Thanksgiving… goes under that holiday (as well as by its keywords, title and category).', c.plot) +
        sw('liked', 'My List includes titles given a thumbs up', '', c.liked) +
        '<div class="field-row"><label class="field"><span>Streaming services as they are in</span><input class="input" data-sm-v="region" maxlength="2" value="' + V.esc(c.region) + '" style="max-width:5rem" placeholder="US"></label>' +
        '<label class="field"><span>Holidays</span><select class="input" data-sm-v="holidays"><option value="always"' + (c.holidays !== 'season' ? ' selected' : '') + '>Always listed (in season first)</option><option value="season"' + (c.holidays === 'season' ? ' selected' : '') + '>Only listed around the day</option></select></label>' +
        '<label class="field"><span>My List order</span><select class="input" data-sm-v="listOrder"><option value="played"' + (c.listOrder !== 'added' ? ' selected' : '') + '>Recently played first, then recently added or liked</option><option value="added"' + (c.listOrder === 'added' ? ' selected' : '') + '>Recently added or liked</option></select></label>' +
        '<label class="field"><span>Hide categories with fewer than</span><input class="input" type="number" min="1" max="50" data-sm-v="min" value="' + (c.min || 2) + '" style="max-width:5rem"></label></div>' +
        '<p class="dim small">Holidays can always be searched for (“christmas”, “halloween”), listed or not. ' + (st.trendingAt ? 'TMDB’s charts were last fetched ' + V.fmtAgo(st.trendingAt) + '.' : st.tmdb ? 'TMDB’s charts are fetched a couple of minutes after this is turned on.' : 'Trending and popular need a TMDB key (Admin → Recommendations).') + '</p>' +
        '<h3>Categories</h3><p class="dim small">Turn a whole kind on or off, untick single categories, or give them your own names. The counts are what’s in each now.</p>' + kinds +
        '<div class="btn-row"><button class="btn primary" data-sm-save>Save</button><button class="btn" data-sm-refresh>' + V.icon('refresh') + ' Work them out again now</button></div></div></section>';
    };
    var ownEditor = function (c) {
      return '<p class="dim small">Your own: a name, and words that put a channel or title in it when they’re in its name, its provider’s category or its genres (commas between them).</p><table class="rules smart-own"><thead><tr><th>Name</th><th>Words</th><th>For</th><th><span class="sr-only">Remove</span></th></tr></thead><tbody>' + (c.custom || []).map(function (x, i) {
        return '<tr data-own="' + i + '" data-oid="' + V.esc(x.id) + '"><td><input class="input" data-o="n" value="' + V.esc(x.n) + '" placeholder="Wrestling"></td><td><input class="input" data-o="words" value="' + V.esc(x.words) + '" placeholder="wwe, aew, wrestling"></td><td><select class="input" data-o="types"><option value="">Everything</option>' + TYPES.map(function (t) { return '<option value="' + t[0] + '"' + ((x.types || [])[0] === t[0] ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('') + '</select></td><td><button class="icon-btn" data-own-rm aria-label="Remove">' + V.icon('trash') + '</button></td></tr>';
      }).join('') + '</tbody></table><button class="btn sm" data-own-add>' + V.icon('plus') + ' Add one</button>';
    };
    var collect = function () {
      var c = st.config, out = { kinds: {}, hidden: [], names: {}, custom: [] };
      V.$$('[data-sm]', box).forEach(function (i) { out[i.dataset.sm] = i.checked; });
      V.$$('[data-sm-v]', box).forEach(function (i) { out[i.dataset.smV] = i.value; });
      V.$$('[data-kind-on]', box).forEach(function (i) { out.kinds[i.dataset.kindOn] = i.checked; });
      V.$$('.smart-defs [data-id]', box).forEach(function (tr) { var id = tr.dataset.id; if (!V.$('[data-show]', tr).checked) out.hidden.push(id); var n = V.$('[data-name]', tr).value.trim(); if (n) out.names[id] = n; });
      V.$$('.smart-own [data-own]', box).forEach(function (tr) { var t = V.$('[data-o=types]', tr).value; out.custom.push({ id: tr.dataset.oid || '', n: V.$('[data-o=n]', tr).value.trim(), words: V.$('[data-o=words]', tr).value.trim(), types: t ? [t] : [] }); });
      // (Custom ones that are hidden keep that.)
      (c.hidden || []).forEach(function (id) { if (id.indexOf('x:') === 0 && out.hidden.indexOf(id) < 0) out.hidden.push(id); });
      return out;
    };
    var save = function (msg) {
      var b = collect();
      // (Every device gets the new ones with the settings, and the catalogue with them on, straight after.)
      return V.adminSave({ smart: b }, msg || 'Saved — the categories are being worked out again').then(function (r) { setTimeout(load, 2500); return r; });
    };
    box.onclick = function (e) {
      if (e.target.closest('[data-sm-save]')) save();
      else if (e.target.closest('[data-sm-refresh]')) V.api('/api/admin/smart/refresh', { body: {} }).then(function () { V.toast('Working them out again'); setTimeout(load, 2000); }).catch(V.fail);
      else if (e.target.closest('[data-own-add]')) { st.config = Object.assign({}, st.config, collect()); st.config.custom.push({ id: '', n: '', words: '', types: [] }); open = 'own'; draw(); }
      else if (e.target.closest('[data-own-rm]')) { var i = +e.target.closest('[data-own]').dataset.own; st.config = Object.assign({}, st.config, collect()); st.config.custom.splice(i, 1); open = 'own'; draw(); }
    };
    box.onchange = function (e) {
      var t = e.target;
      if (t.dataset.sm === 'on') { V.$('.smart-opts', box).hidden = !t.checked; save(t.checked ? 'Smarter categories on — working them out' : 'Back to the providers’ categories'); }
    };
    box.addEventListener('toggle', function (e) { var d = e.target; if (d.classList && d.classList.contains('smart-kind')) { if (d.open) open = d.dataset.kind; else if (open === d.dataset.kind) open = ''; V.ls.set('smartAdmOpen', open); } }, true);
    load();
  };
})();
