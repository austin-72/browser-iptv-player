'use strict';
/**
 * Following teams and competitions (Events on Home and in On later, automatic reminders) and event / PPV channels
 * (listings made from their names). Registered from server.js with one line; everything it needs is passed in.
 *
 * Data: data/follow.json — per profile what it follows and its reminder switches, the games already given an
 * automatic reminder (so one that was removed isn't added again), and the admin's "hide empty event channels".
 */
const path = require('path');
const { JsonFile } = require('./store');
const { EventGuide } = require('./events');
const { SportsIndex, aboutProgramme, nk, HD } = require('./follow');
const { log } = require('./util');

const DEFAULT = { p: {}, auto: {}, admin: { hideEmptyEvents: true } };
const MAX = 100;
const tick = () => new Promise((r) => setImmediate(r));
const obj = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {}); // (a body of null, a number or a list)

module.exports = function routesP8({ route, requireProfile, requireAdmin, readJSON, HttpError, D, catalog: cat, epg, lists, userdata, accounts, hub, overrides, chanShift, nowCache }) {
  const store = new JsonFile(path.join(D, 'follow.json'), DEFAULT);
  const guide = new EventGuide();
  const index = new SportsIndex();

  // ------------------------------------------------------------ event channels → listings
  let evSeen = '', evAt = 0;
  /** Reads the event channels' names again (after a list refresh, and every 15 minutes for "Sat 20:00"-style names). */
  function refreshEvents(force) {
    const c = cat();
    if (!c || !c.items || !c.items.length) return false;
    const tz = new Map(lists.all().map((l) => [l.id, l.evTz || l.tz || '']));
    const base = String(c.version).split('.')[0] + JSON.stringify([...tz]);
    if (!force && base === evSeen && Date.now() - evAt < 15 * 60e3) return false;
    evSeen = base; evAt = Date.now();
    const chans = [];
    for (const it of c.items) if (it.rn) chans.push({ k: it.k, n: it.rn, tz: tz.get(it.src) || '' });
    const changed = guide.update(chans);
    if (changed || (chans.length && !epg.virtual.size)) {
      epg.setVirtual(new Map(guide.map)); // (relinks the channels; devices hear about it if the links changed)
      if (nowCache) nowCache.clear();
    }
    return changed;
  }

  // ------------------------------------------------------------ the sports index
  let idxSig = '', building = null, lastIdx = null;
  const indexSig = () => { const c = cat(); return `${c ? c.version : ''}|${guide.version}`; };
  function rebuildIndex(force) {
    if (building) return building;
    const c = cat();
    if (!c || !c.items) return Promise.resolve();
    const sig = indexSig();
    // Once per guide or list update (and every 30 minutes, as the window moves on), never per request.
    if (!force && sig === idxSig && epg.idx === lastIdx && Date.now() - index.builtAt < 30 * 60e3) return Promise.resolve();
    idxSig = sig; lastIdx = epg.idx;
    const chans = [];
    for (const it of c.items) {
      if (it.t !== 'live' || !it.epg) continue;
      const sh = chanShift(it);
      chans.push({ it, list: (from, to) => (sh ? epg.range(it.epg, from - sh, to - sh).map((p) => ({ ...p, s: p.s + sh, e: p.e + sh })) : epg.range(it.epg, from, to)) });
    }
    const t0 = Date.now();
    const g = index.build(chans);
    building = (async () => {
      let n = 0;
      while (!g.next().done) if ((++n & 7) === 0) await tick();
      log(`Sports index: ${index.games.length} games, ${index.teams.size} teams in ${Date.now() - t0} ms`);
    })().catch((e) => log('Sports index:', e.message)).finally(() => { building = null; });
    return building.then(() => autoAll());
  }

  // ------------------------------------------------------------ what a profile follows
  const conf = (pid) => {
    const o = store.data.p[pid] || {};
    return { teams: Array.isArray(o.teams) ? o.teams : [], comps: Array.isArray(o.comps) ? o.comps : [], auto: o.auto !== false, sw: !!o.sw };
  };
  const cleanNames = (a) => {
    const out = [], seen = new Set();
    for (const x of Array.isArray(a) ? a : []) {
      const n = String(x || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const k = nk(n);
      if (k && !seen.has(k)) { seen.add(k); out.push(n); }
    }
    return out.slice(0, MAX);
  };

  /** The best channel for a game that this profile can watch: one it's allowed, HD first, then its favourites. */
  function bestChannel(g, prof, f, favs) {
    const c = cat();
    let best = null, bs = -1, n = 0;
    for (const k of g.ks) {
      const it = c.get(k);
      if (!it || !f.test(it) || (overrides.hasLocks && overrides.isLocked(it))) continue;
      n++;
      const s = (it.hd || HD.test(it.n) ? 2 : 0) + (favs && favs.has(k) ? 1 : 0) + (it.rn ? 0 : 0.5);
      if (s > bs) { bs = s; best = it; }
    }
    return best ? { it: best, n } : null;
  }

  function eventsFor(prof, { hours = 72 } = {}) {
    const fo = conf(prof.id);
    if (!fo.teams.length && !fo.comps.length) return [];
    const c = cat();
    const f = c.filterFor(prof);
    let favs = null;
    try { favs = new Set(userdata.of(prof.id).data.favs || []); } catch {}
    const now = Date.now();
    const out = [];
    for (const { g, why, team } of index.matching(fo, { now, until: now + hours * 3600e3 })) {
      const ch = bestChannel(g, prof, f, favs);
      if (!ch) continue;
      const o = { id: g.id, s: g.s, e: g.e, t: g.t, k: ch.it.k, why, live: g.s <= now };
      if (g.st) o.st = g.st;
      if (g.lg) o.lg = g.lg;
      if (team) o.team = 1;
      if (ch.n > 1) o.also = ch.n - 1;
      out.push(o);
      if (out.length >= 200) break;
    }
    // On now first, then by start time.
    out.sort((a, b) => (b.live - a.live) || a.s - b.s);
    return out;
  }

  // ------------------------------------------------------------ automatic reminders for followed teams' games
  function autoFor(prof) {
    const fo = conf(prof.id);
    const done = store.data.auto[prof.id] || {};
    const now = Date.now();
    let dirty = false, changed = false;
    for (const id of Object.keys(done)) if (done[id].e < now) { delete done[id]; dirty = true; }
    const want = new Map();
    if (fo.auto && fo.teams.length) {
      const c = cat();
      const f = c.filterFor(prof);
      let favs = null;
      try { favs = new Set(userdata.of(prof.id).data.favs || []); } catch {}
      for (const { g } of index.matching(fo, { now, teamsOnly: true, until: now + 48 * 3600e3 })) {
        if (g.s <= now + 60e3) continue;
        const ch = bestChannel(g, prof, f, favs);
        if (ch) want.set(g.id, { g, k: ch.it.k });
      }
    }
    let rems = [];
    try { rems = userdata.of(prof.id).data.reminders || []; } catch { return; }
    // Ones set automatically that no longer fit (unfollowed, or switched off): taken away again.
    for (const [id, d] of Object.entries(done)) {
      if (want.has(id) || d.s <= now) continue;
      if (rems.some((r) => r.a && r.k === d.k && r.s === d.s)) { userdata.reminder(prof.id, { remove: { k: d.k, s: d.s } }); changed = true; }
      delete done[id]; dirty = true;
    }
    for (const [id, w] of want) {
      if (done[id]) continue; // (already set once: if it was removed since, it stays removed)
      userdata.reminder(prof.id, { add: { k: w.k, s: w.g.s, e: w.g.e, t: w.g.t, sw: fo.sw, auto: 1 } });
      done[id] = { k: w.k, s: w.g.s, e: w.g.e };
      dirty = changed = true;
    }
    if (dirty) { if (Object.keys(done).length) store.data.auto[prof.id] = done; else delete store.data.auto[prof.id]; store.save(); }
    if (changed) hub.toProfile(prof.id, 'data', { field: 'reminders' });
  }
  function autoAll() {
    for (const prof of accounts.profiles) {
      if (!store.data.p[prof.id] && !store.data.auto[prof.id]) continue;
      try { autoFor(prof); } catch (e) { log('Follow reminders:', e.message); }
    }
  }

  // Event names read again as lists refresh, the index kept up to date, reminders added: all in the background.
  const timer = setInterval(() => {
    try { refreshEvents(); } catch (e) { log('Event channels:', e.message); }
    rebuildIndex().catch(() => {});
  }, 30e3);
  timer.unref();
  setTimeout(() => { try { refreshEvents(true); } catch (e) { log('Event channels:', e.message); } rebuildIndex(true).catch(() => {}); }, 3000).unref();
  const fresh = () => { refreshEvents(); return rebuildIndex(); };
  // A guide that's just been read: index it a few seconds later (several guides often arrive together).
  let soon = null;
  const onGuide = epg.onChange;
  epg.onChange = () => {
    onGuide();
    clearTimeout(soon);
    soon = setTimeout(() => rebuildIndex().catch(() => {}), 3000);
    soon.unref();
  };

  // ------------------------------------------------------------ routes
  route('GET', '/api/follow', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); return conf(prof.id); });
  route('PUT', '/api/follow', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const b = obj(await readJSON(req));
    const o = { ...conf(prof.id) };
    if ('teams' in b) o.teams = cleanNames(b.teams);
    if ('comps' in b) o.comps = cleanNames(b.comps);
    if ('auto' in b) o.auto = !!b.auto;
    if ('sw' in b) o.sw = !!b.sw;
    store.data.p[prof.id] = o;
    store.save();
    // Reminders that were set to switch (or not) follow the new choice.
    if ('sw' in b) {
      try {
        const f = userdata.of(prof.id);
        let n = 0;
        for (const r of f.data.reminders) if (r.a && !!r.sw !== o.sw) { if (o.sw) r.sw = 1; else delete r.sw; n++; }
        if (n) { f.save(); hub.toProfile(prof.id, 'data', { field: 'reminders' }); }
      } catch {}
    }
    autoFor(prof);
    return o;
  });
  route('POST', '/api/follow/toggle', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const b = obj(await readJSON(req));
    const kind = b.kind === 'comp' ? 'comps' : b.kind === 'team' ? 'teams' : null;
    if (!kind) throw new HttpError(400, 'Follow a team or a competition.');
    const name = String(b.n || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!nk(name)) throw new HttpError(400, 'Give a name to follow.');
    const o = { ...conf(prof.id) };
    const k = nk(name);
    const has = o[kind].some((x) => nk(x) === k);
    const on = b.on === undefined ? !has : !!b.on;
    if (on && !has) { if (o[kind].length >= MAX) throw new HttpError(400, `You can follow up to ${MAX}.`); o[kind] = o[kind].concat(name); }
    if (!on) o[kind] = o[kind].filter((x) => nk(x) !== k);
    store.data.p[prof.id] = o;
    store.save();
    autoFor(prof);
    return { ...o, on };
  });
  route('GET', '/api/follow/suggest', (req, res, p, q, ctx) => {
    requireProfile(ctx);
    fresh().catch(() => {});
    return index.suggest(String(q.get('q') || '').slice(0, 60), Math.min(30, Number(q.get('n')) || 12));
  });
  /** A programme's teams and competition, for its Follow button. */
  route('GET', '/api/follow/about', (req, res, p, q, ctx) => {
    requireProfile(ctx);
    const cats = String(q.get('c') || '').split('|').filter(Boolean).slice(0, 5);
    const a = aboutProgramme({ t: String(q.get('t') || '').slice(0, 200), st: String(q.get('st') || '').slice(0, 200), c: cats });
    // "Chiefs" when the guide also says "Kansas City Chiefs": offer the full name.
    a.teams = a.teams.map((n) => { const ks = [...index.teamKeys(n)]; const t = ks.length === 1 && index.teams.get(ks[0]); return t && t.n ? t.n : n; });
    return a;
  });
  route('GET', '/api/follow/events', (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    fresh().catch(() => {});
    const fo = conf(prof.id);
    return { at: Date.now(), following: fo.teams.length + fo.comps.length, items: eventsFor(prof, { hours: Math.max(1, Math.min(72, Number(q.get('h')) || 72)) }) };
  });

  // Admin: event channels found, and whether empty ones are hidden from Live TV.
  route('GET', '/api/admin/events', (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    refreshEvents();
    let total = 0, timed = 0, empty = 0;
    const sample = [];
    for (const [k, ev] of guide.info) {
      total++;
      if (ev.start) timed++;
      if (ev.none) empty++;
      if (sample.length < 8 && ev.start) { const it = cat().get(k); sample.push({ k, n: it ? it.n : ev.chan, t: ev.title, s: ev.start }); }
    }
    return { hideEmpty: store.data.admin.hideEmptyEvents !== false, total, timed, empty, sample: sample.sort((a, b) => a.s - b.s) };
  });
  route('PUT', '/api/admin/events', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const b = obj(await readJSON(req));
    store.data.admin.hideEmptyEvents = b.hideEmpty !== false;
    store.save();
    hub.toAll('settings', { hideEmptyEvents: store.data.admin.hideEmptyEvents });
    return { hideEmpty: store.data.admin.hideEmptyEvents };
  });

  return {
    publicFlags: () => ({ hideEmptyEvents: store.data.admin.hideEmptyEvents !== false }),
    refreshEvents, rebuildIndex, guide, index,
  };
};
