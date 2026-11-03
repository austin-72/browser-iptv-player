'use strict';
/**
 * Home rows from Trakt and TMDB lists, the Wishlist with new-arrival alerts (and the bell on series pages), and
 * "Your viewing" (stats and a year in review per profile). Registered from server.js at // [routes:p10].
 *
 * It listens in on three things the server already does, without changing them: seconds watched and progress
 * (userdata.played / userdata.progress → viewing totals and films finished) and new episodes found for a series
 * (userdata.addNewEpisodes → an alert in the inbox, or nothing when the profile muted that series).
 */
const { HomeLists, CHARTS } = require('./homelists');
const { Wishlist } = require('./wishlist');
const { Viewing } = require('./viewing');
const { HttpError, log } = require('./util');

const IMG = 'https://image.tmdb.org/t/p/';
const obj = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {}); // (a body of null, a number or a list)

/**
 * deps: { route, requireProfile, requireAdmin, readJSON, D, catalog(), userdata, accounts, hub, tmdb, trakt }
 */
module.exports = function p10(deps) {
  const { route, requireProfile, requireAdmin, readJSON, D, userdata, accounts, hub, tmdb, trakt } = deps;
  const cat = () => deps.catalog();
  const tmdbOf = (it) => (it && it.tmdb && it.tmdb !== '0' ? String(it.tmdb) : (() => { const m = tmdb && tmdb.map && tmdb.map.data.m[it.k]; return m && m.id ? String(m.id) : ''; })());
  const lists = new HomeLists({ dataDir: D, catalog: cat, tmdb, trakt, tmdbOf });
  const wl = new Wishlist(D);
  const viewing = new Viewing({ dataDir: D, catalog: cat, userdata });

  const visibleFor = (prof) => {
    const f = cat().filterFor(prof);
    const hidden = new Set(userdata.of(prof.id).data.hidden || []);
    return (k) => { const it = cat().get(k); return !!it && !hidden.has(k) && f.test(it); };
  };
  const online = (pid) => [...hub.conns].some((c) => c.pid === pid);
  const prefOn = (pid, k) => userdata.prefs(pid)[k] !== false;

  // ================================================================ listening in (see the note at the top)
  {
    const played = userdata.played.bind(userdata);
    userdata.played = (pid, b) => {
      try { viewing.of(pid); } catch {} // (first time: filled in from the history as it was before this sitting)
      const r = played(pid, b);
      try { if (b && !userdata.of(pid).data.prefs.historyPaused) viewing.record(pid, b); } catch (e) { log(`Viewing: ${e.message}`); }
      return r;
    };
    const progress = userdata.progress.bind(userdata);
    userdata.progress = (pid, b) => {
      const was = b && b.k ? !!(userdata.of(pid).data.progress[b.k] || {}).w : true;
      const rec = progress(pid, b);
      try {
        // A film watched to the end here (not just marked as watched, or copied from Trakt): ≥ 10 minutes of it played lately.
        if (rec && rec.w && !was) {
          const it = cat().get(b.k);
          const since = Date.now() - 12 * 3600e3;
          if (((it && it.t) || b.t) === 'movie' && userdata.of(pid).data.history.some((h) => h.k === b.k && h.at > since && h.s >= 600)) viewing.finished(pid);
        }
      } catch {}
      return rec;
    };
    const addNew = userdata.addNewEpisodes.bind(userdata);
    userdata.addNewEpisodes = (pid, sk, keys) => {
      if (wl.muted(pid, sk)) return false;
      const ok = addNew(pid, sk, keys);
      if (ok) {
        try {
          const show = cat().get(sk);
          const name = show ? show.n : 'a series';
          const eps = keys.map((k) => cat().get(k)).filter(Boolean);
          const last = eps[eps.length - 1];
          wl.alert(pid, { kind: 'episode', k: sk, show: name, title: keys.length > 1 ? `${keys.length} new episodes of ${name}` : `New episode of ${name}`, body: last ? last.et || `Season ${last.s}, episode ${last.e}` : '', i: show ? show.poster || show.logo || '' : '', n: keys.length, eps: keys }, { seen: online(pid) });
        } catch (e) { log(`Alerts: ${e.message}`); }
      }
      return ok;
    };
    // A profile removed: its rows, wishlist, alerts and viewing totals go too.
    const remove = userdata.remove.bind(userdata);
    userdata.remove = (pid) => { remove(pid); try { lists.forgetProfile(pid); wl.forget(pid); viewing.forget(pid); } catch {} };
  }
  /** Series a profile follows with the bell (server.js adds them to the ones it checks for new episodes). */
  const followsOf = (pid) => wl.follows(pid);

  // ================================================================ home rows from lists
  route('GET', '/api/homelists', (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const rows = lists.rowsView(prof, visibleFor(prof));
    // Never fetched yet (just added on another device, or the first fetch failed): try again in the background.
    for (const r of lists.rowsOf(prof.id)) { const s = lists.store.data.sources[r.src]; if (s && !s.at && !lists.busy.has(r.src) && Date.now() - (s.tried || 0) > 600e3) lists.refresh(r.src).catch(() => {}); }
    return { available: lists.available(prof.id), rows };
  });
  route('POST', '/api/homelists/rows', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const b = obj(await readJSON(req));
    const r = await lists.addRow(prof.id, b.kind ? { kind: b.kind, ref: b.ref, text: b.text } : String(b.text || ''));
    if (b.name) lists.renameRow(prof.id, r.row.id, b.name);
    return { row: r.row, existed: r.existed, rows: lists.rowsView(prof, visibleFor(prof)) };
  });
  route('PUT', '/api/homelists/rows/:id', async (req, res, p, q, ctx) => { const prof = requireProfile(ctx); return lists.renameRow(prof.id, p.id, obj(await readJSON(req)).name); });
  route('DELETE', '/api/homelists/rows/:id', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); lists.removeRow(prof.id, p.id); return { ok: true }; });
  route('POST', '/api/homelists/rows/:id/refresh', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const r = lists.rowsOf(prof.id).find((x) => x.id === p.id);
    if (!r) throw new HttpError(404, 'No such row.');
    const s = lists.store.data.sources[r.src];
    if (s && s.at && Date.now() - s.at < 10 * 60e3) return lists.fullView(prof, p.id, visibleFor(prof)); // (fetched moments ago)
    await lists.refresh(r.src);
    return lists.fullView(prof, p.id, visibleFor(prof));
  });
  route('GET', '/api/homelists/rows/:id', (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const out = lists.fullView(prof, p.id, visibleFor(prof));
    const wished = wl.has(prof.id) ? wl.of(prof.id).wish : [];
    for (const x of out.items) if (!x.k && wished.some((w) => w.t === x.t && (x.tmdb && w.tmdb ? w.tmdb === x.tmdb : w.n.toLowerCase() === x.n.toLowerCase()))) x.wished = 1;
    return out;
  });
  route('GET', '/api/homelists/trakt-mine', async (req, res, p, q, ctx) => ({ lists: await lists.myTraktLists(requireProfile(ctx).id) }));
  route('GET', '/api/homelists/charts', () => CHARTS);

  // ================================================================ wishlist
  const wishOut = (prof, w) => {
    const vis = visibleFor(prof);
    const o = { id: w.id, t: w.t, n: w.n, y: w.y || 0, at: w.at };
    if (w.tmdb) o.tmdb = w.tmdb;
    if (w.p) o.p = w.p;
    if (w.got && vis(w.got)) { o.k = w.got; o.gotAt = w.gotAt; }
    return o;
  };
  route('GET', '/api/wishlist', (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    safeCheck();
    return { tmdb: !!(tmdb && tmdb.enabled()), list: (wl.has(prof.id) ? wl.of(prof.id).wish : []).map((w) => wishOut(prof, w)) };
  });
  route('POST', '/api/wishlist', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const b = obj(await readJSON(req));
    const e = { t: b.t === 'show' || b.t === 'tv' ? 'show' : 'movie', n: String(b.n || ''), y: b.y, tmdb: b.tmdb };
    const k = lists.matchEntry(e);
    if (k && visibleFor(prof)(k)) return { here: k };
    const w = wl.add(prof.id, { ...e, p: b.p });
    return { item: wishOut(prof, w) };
  });
  route('DELETE', '/api/wishlist/:id', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); wl.remove(prof.id, p.id); return { ok: true }; });
  route('GET', '/api/wishlist/search', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const s = String(q.get('q') || '').trim().slice(0, 100);
    if (!(tmdb && tmdb.enabled())) throw new HttpError(400, 'Searching for titles that aren’t here needs TMDB: the admin can add a free key in Admin → Recommendations.');
    if (s.length < 2) return { results: [] };
    let j;
    try { j = await tmdb.get('/search/multi', { query: s, include_adult: 'false' }, 86400e3); } catch (e) { throw new HttpError(502, /key/i.test(e.message) ? 'TMDB rejected the key — the admin can check it in Admin → Recommendations.' : `TMDB didn’t answer (${e.message}).`); }
    const vis = visibleFor(prof);
    const wished = wl.has(prof.id) ? wl.of(prof.id).wish : [];
    const out = [];
    for (const r of (j && j.results) || []) {
      if (r.media_type !== 'movie' && r.media_type !== 'tv') continue;
      if (r.adult) continue;
      const e = { t: r.media_type === 'tv' ? 'show' : 'movie', n: String(r.title || r.name || ''), y: parseInt(String(r.release_date || r.first_air_date || '').slice(0, 4), 10) || 0, tmdb: String(r.id) };
      if (!e.n) continue;
      if (r.poster_path) e.p = IMG + 'w185' + r.poster_path;
      e.plot = String(r.overview || '').slice(0, 240);
      const k = lists.matchEntry(e);
      if (k && vis(k)) e.k = k;
      const w = wished.find((x) => x.t === e.t && (x.tmdb ? x.tmdb === e.tmdb : x.n.toLowerCase() === e.n.toLowerCase()));
      if (w) e.wish = w.id;
      out.push(e);
      if (out.length >= 20) break;
    }
    return { results: out };
  });

  // The bell on a series page: follow (alerts even when it isn't in My List or being watched) or mute.
  route('GET', '/api/series-follow', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); const x = wl.has(prof.id) ? wl.of(prof.id) : { follow: [], mute: [] }; return { follow: x.follow, mute: x.mute }; });
  route('PUT', '/api/series-follow/:sk', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const b = obj(await readJSON(req));
    const it = cat().visible(prof, p.sk);
    if (!it || it.t !== 'show') throw new HttpError(404, 'That series isn’t here.');
    return wl.setFollow(prof.id, it.k, b.on === true ? true : b.on === false ? false : null);
  });

  // ================================================================ alerts (Messages → New for you)
  const alertOut = (a) => ({ id: a.id, kind: a.kind, k: a.k, title: a.title, body: a.body, at: a.at, read: !!a.read, i: a.i || '', n: a.n || 0 });
  route('GET', '/api/alerts', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); safeCheck(); return { list: wl.alerts(prof.id).map(alertOut), unread: wl.unread(prof.id) }; });
  route('GET', '/api/alerts/unseen', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); safeCheck(); return { list: wl.takeUnseen(prof.id).map(alertOut), unread: wl.unread(prof.id) }; });
  route('POST', '/api/alerts/read', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const b = obj(await readJSON(req));
    wl.markRead(prof.id, b.all ? 'all' : (Array.isArray(b.ids) ? b.ids.map(String) : []));
    return { unread: wl.unread(prof.id) };
  });
  route('DELETE', '/api/alerts/:id', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); wl.removeAlert(prof.id, p.id); return { unread: wl.unread(prof.id) }; });

  // Wished titles that have arrived: checked when the catalogue changes (a list refresh) or TMDB matched more titles.
  let lastSig = '';
  function checkArrivals() {
    const c = cat();
    if (!c.items.length) return;
    const sig = c.version + ':' + (tmdb && tmdb.map ? Object.keys(tmdb.map.data.m).length : 0);
    if (sig === lastSig) return;
    lastSig = sig;
    if (!wl.pids().some((pid) => wl.of(pid).wish.some((w) => !w.got))) return;
    const vis = new Map();
    const got = wl.arrivals((w, pid) => {
      const prof = accounts.profile(pid);
      if (!prof) return null;
      const k = lists.matchEntry(w);
      if (!k) return null;
      if (!vis.has(pid)) vis.set(pid, visibleFor(prof));
      return vis.get(pid)(k) ? k : null;
    });
    for (const [pid, arrived] of got) {
      if (!prefOn(pid, 'wishlistAlerts')) continue;
      const seen = online(pid);
      for (const { w, k } of arrived) { const it = c.get(k); wl.alert(pid, { kind: 'wish', k, title: `${it ? it.n : w.n} is here`, body: 'It was on your wishlist.', i: (it && (it.poster || it.logo)) || w.p || '' }, { seen }); }
      const first = arrived[0];
      const fit = c.get(first.k);
      // Several at once: one notification for all of them (each still has its own line in the inbox).
      hub.toProfile(pid, 'notify', arrived.length > 1
        ? { kind: 'wish', title: `${arrived.length} titles from your wishlist are here`, body: arrived.slice(0, 4).map((x) => (c.get(x.k) || x.w).n).join(', ') + (arrived.length > 4 ? '…' : ''), k: '' }
        : { kind: 'wish', title: `${fit ? fit.n : first.w.n} is here`, body: 'It was on your wishlist.', k: first.k, i: (fit && (fit.poster || fit.logo)) || '' });
    }
  }
  // (Also when someone looks at their wishlist or alerts: nothing to do unless the catalogue changed.)
  function safeCheck() { try { checkArrivals(); } catch (e) { log(`Wishlist: ${e.message}`); } }
  setInterval(safeCheck, 60e3).unref();
  setTimeout(safeCheck, 90e3).unref();
  // Lists for Home rows: fetched again about once a day (one at a time, a few seconds apart).
  setInterval(() => lists.refreshDue().catch(() => {}), 30 * 60e3).unref();
  setTimeout(() => lists.refreshDue().catch(() => {}), 5 * 60e3).unref();

  // ================================================================ your viewing
  route('GET', '/api/viewing', (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    return viewing.summary(prof.id, String(q.get('period') || 'week'), parseInt(q.get('offset'), 10) || 0);
  });
  route('GET', '/api/viewing/review', (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const now = new Date();
    const y = parseInt(q.get('year'), 10) || (now.getMonth() === 11 ? now.getFullYear() : now.getFullYear() - 1);
    if (y > now.getFullYear() || (y === now.getFullYear() && now.getMonth() < 11)) throw new HttpError(400, `${y} isn’t over yet — your year in review opens in December.`);
    return { ...viewing.review(prof.id, y), name: prof.name, avatar: prof.avatar };
  });
  route('GET', '/api/viewing/years', (req, res, p, q, ctx) => viewing.years(requireProfile(ctx).id));
  route('GET', '/api/admin/viewing', (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const period = String(q.get('period') || 'week'), offset = parseInt(q.get('offset'), 10) || 0;
    const people = accounts.profiles.map((pr) => {
      const s = viewing.summary(pr.id, period, offset);
      return { id: pr.id, name: pr.name, avatar: pr.avatar, total: s.total, previous: s.previous };
    });
    const sum = (k, which) => people.reduce((a, x) => a + (x[which][k] || 0), 0);
    const r = Viewing.range(['week', 'month', 'year'].includes(period) ? period : 'week', offset);
    return { period, offset, from: r.from, to: r.to, label: r.label, people, total: { s: sum('s', 'total'), l: sum('l', 'total'), m: sum('m', 'total'), e: sum('e', 'total'), o: sum('o', 'total'), f: sum('f', 'total') }, previous: { s: sum('s', 'previous'), f: sum('f', 'previous') } };
  });

  return {
    lists, wl, viewing, followsOf, checkArrivals,
    publicFlags: () => ({ homeLists: { trakt: lists.traktReady(), tmdb: lists.tmdbReady() } }),
  };
};
