'use strict';
const fs = require('fs');
const path = require('path');
const { log, isGuestId } = require('./util');

const DAY = 86400e3;
const STOP = new Set('the a an of and in on at to for with from by la le les el los las de der die das und et y i ii iii part movie film season'.split(' '));

/**
 * Recommendations, per profile, saved on disk (users/<id>.recs.json) and refreshed as the profile watches.
 *
 * Score = how well a title's features (genres, cast, director, group, language, era) fit what the profile has
 * watched (time-decayed and weighted by how much was watched, thumbs up/down, My List, chosen interests)
 * + TMDB's "people who liked X also liked Y" for everything watched + what others in the household watch
 * − titles shown again and again without being opened. Results are re-ranked for variety (MMR) so the same few
 * titles don't dominate, and every row keeps changing as new things are watched.
 */
class Recs {
  constructor({ dir, catalog, userdata, accounts, tmdb }) {
    this.dir = dir;
    this.catalog = catalog;
    this.userdata = userdata;
    this.accounts = accounts;
    this.tmdb = tmdb;
    this.timers = new Map();
    this.running = new Map();
    this.featCache = new Map();
    this.featVersion = '';
  }

  file(pid) { return path.join(this.dir, `${pid}.recs.json`); }

  get(pid) {
    if (isGuestId(pid)) return (this.guestRecs && this.guestRecs.get(pid)) || null; // (a guest's: not on disk)
    try { return JSON.parse(fs.readFileSync(this.file(pid), 'utf8')); } catch { return null; }
  }
  /** A guest left: its recommendations go too. */
  forget(pid) { clearTimeout(this.timers.get(pid)); this.timers.delete(pid); if (this.guestRecs) this.guestRecs.delete(pid); }

  /** Something changed for this profile: recompute soon (debounced). */
  touch(pid, delay = 20000) {
    clearTimeout(this.timers.get(pid));
    this.timers.set(pid, setTimeout(() => this.compute(pid).catch((e) => log('Recommendations failed:', e.message)), delay));
  }

  async fresh(pid, maxAgeMs = 6 * 3600e3) {
    const r = this.get(pid);
    if (r && r.version === this.catalog.version.split('.')[0] && Date.now() - r.at < maxAgeMs) return r;
    return this.compute(pid);
  }

  features(it) {
    // (By the catalogue's content, not its every touch: a guide refresh changes the second half of the version, and
    // working out 100,000 titles' features again each time held the server for a second or more.)
    // (…but posters, genres and cast being filled in — a ".m…" second half — does count: features are made of those.)
    const vp = String(this.catalog.version).split('.');
    const fv = vp[0] + (vp[1] && vp[1][0] === 'm' ? '.' + vp[1] : '');
    if (this.featVersion !== fv) { this.featCache.clear(); this.featVersion = fv; }
    let f = this.featCache.get(it.k);
    if (f) return f;
    f = new Map();
    const add = (k, w) => f.set(k, (f.get(k) || 0) + w);
    for (const g of it.gn || []) add('g:' + g.toLowerCase(), 1.4);
    if (it.g) add('grp:' + it.g.toLowerCase(), it.gn && it.gn.length ? 0.4 : 1);
    for (const c of String(it.cast || '').split(',').slice(0, 5)) { const n = c.trim().toLowerCase(); if (n) add('c:' + n, 0.5); }
    for (const d of String(it.dir || '').split(',').slice(0, 2)) { const n = d.trim().toLowerCase(); if (n) add('d:' + n, 0.7); }
    if (it.lg && it.lg[0]) add('l:' + it.lg[0], 0.3);
    if (it.y) add('era:' + Math.floor(it.y / 10) * 10, 0.25);
    add('t:' + it.t, 0.2);
    const words = String(it.n || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
    for (const w of words.slice(0, 3)) add('w:' + w, 0.35);
    let norm = 0;
    for (const v of f.values()) norm += v * v;
    f.norm = Math.sqrt(norm) || 1;
    this.featCache.set(it.k, f);
    return f;
  }

  sim(a, b) {
    let dot = 0;
    const [s, l] = a.size < b.size ? [a, b] : [b, a];
    for (const [k, v] of s) { const w = l.get(k); if (w) dot += v * w; }
    return dot / (a.norm * b.norm);
  }

  async compute(pid) {
    if (this.running.has(pid)) return this.running.get(pid);
    const job = this._compute(pid).finally(() => this.running.delete(pid));
    this.running.set(pid, job);
    return job;
  }

  async _compute(pid) {
    const t0 = Date.now();
    const profile = this.accounts.profile(pid);
    if (!profile) return null;
    const cat = this.catalog;
    const ud = this.userdata.of(pid).data;
    const filter = cat.filterFor(profile);
    const now = Date.now();
    const unit = (k) => { const it = cat.get(k); if (!it) return null; if (it.t === 'episode' && it.sk) return cat.get(it.sk) || it; return it; };

    // 1. What this profile likes (seed weights per title/show).
    const seeds = new Map();
    const addSeed = (it, w) => { if (it && (it.t === 'movie' || it.t === 'show')) seeds.set(it.k, (seeds.get(it.k) || 0) + w); };
    for (const h of ud.history) {
      const it = unit(h.k);
      if (!it) continue;
      const age = (now - h.at) / DAY;
      const decay = Math.pow(0.5, age / 45);
      const pr = ud.progress[h.k];
      const frac = pr && pr.w ? 1 : pr && pr.d ? Math.max(0.15, pr.p / pr.d) : Math.min(1, (h.s || 60) / 1800);
      addSeed(it, decay * (0.3 + frac));
    }
    for (const [k, v] of Object.entries(ud.ratings)) addSeed(unit(k), v > 0 ? 2 : -2.5);
    for (const k of ud.list.slice(0, 200)) addSeed(unit(k), 0.6);

    // Profile vector.
    const vec = new Map();
    for (const [k, w] of seeds) {
      const it = cat.get(k);
      if (!it) continue;
      for (const [f, v] of this.features(it)) vec.set(f, (vec.get(f) || 0) + v * w);
    }
    for (const g of profile.interests || []) vec.set('g:' + g.toLowerCase(), (vec.get('g:' + g.toLowerCase()) || 0) + 1.2);
    let n2 = 0;
    for (const [f, v] of vec) { if (v <= 0) vec.delete(f); else n2 += v * v; }
    vec.norm = Math.sqrt(n2) || 1;

    // 2. TMDB: what people who liked the profile's favourites also liked.
    const tmdbBoost = new Map();
    const bySeeds = new Map(); // candidate → the watched titles whose "people also liked" lists include it
    const because = [];
    const topSeeds = [...seeds.entries()].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, 25);
    if (this.tmdb && this.tmdb.enabled()) {
      for (const [k, w] of topSeeds) {
        const it = cat.get(k);
        let rel = [];
        try { rel = await this.tmdb.related(it); } catch (e) { if (/key/.test(e.message)) break; }
        const keys = [];
        for (const r of rel) {
          for (const ck of cat.findTitle(r.title, r.year)) {
            const c = cat.get(ck);
            if (!c || c.k === k || (c.t !== (r.type === 'tv' ? 'show' : 'movie'))) continue;
            tmdbBoost.set(ck, (tmdbBoost.get(ck) || 0) + r.w * Math.min(2, w));
            if (!bySeeds.has(ck)) bySeeds.set(ck, new Set());
            bySeeds.get(ck).add(k);
            if (!keys.includes(ck)) keys.push(ck);
          }
        }
        if (keys.length >= 3) because.push({ seed: k, keys, src: 'tmdb' });
      }
    }

    // 3. Household: what other profiles watch.
    const household = new Map();
    for (const p of this.accounts.profiles) {
      if (p.id === pid) continue;
      const other = this.userdata.of(p.id).data;
      const seen = new Set();
      for (const h of other.history.slice(0, 300)) {
        const it = unit(h.k);
        if (!it || seen.has(it.k)) continue;
        seen.add(it.k);
        household.set(it.k, (household.get(it.k) || 0) + Math.pow(0.5, (now - h.at) / (30 * DAY)));
      }
    }

    // 4. Score every visible movie and show the profile hasn't finished or rejected.
    const done = new Set();
    for (const [k, p] of Object.entries(ud.progress)) if (p.w) { const u = unit(k); if (u && u.t === 'movie') done.add(u.k); }
    for (const [k, v] of Object.entries(ud.ratings)) if (v < 0) { const u = unit(k); if (u) done.add(u.k); }
    for (const k of ud.hidden) done.add(k);
    const started = new Set(ud.history.map((h) => (unit(h.k) || {}).k));
    const imp = ud.impressions || {};
    const scored = [];
    for (const it of cat.items) {
      if (it.t !== 'movie' && it.t !== 'show') continue;
      if (done.has(it.k) || seeds.has(it.k) || started.has(it.k)) continue;
      if (!filter.test(it)) continue;
      const f = this.features(it);
      let s = vec.size ? this.sim(vec, f) : 0;
      s += Math.min(1.2, (tmdbBoost.get(it.k) || 0) * 0.35);
      const nSeeds = bySeeds.has(it.k) ? bySeeds.get(it.k).size : 0;
      if (nSeeds > 1) s += Math.min(0.6, (nSeeds - 1) * 0.2); // several of your favourites point to it
      s += Math.log1p(household.get(it.k) || 0) * 0.15;
      if (it.r) s += Math.min(10, it.r) / 100;
      if (it.ad && now - it.ad < 30 * DAY) s += 0.04;
      s -= Math.min(0.5, (imp[it.k] || 0) * 0.06);
      if (!it.logo) s -= 0.05;
      if (s > 0) scored.push({ it, s, f });
    }
    scored.sort((a, b) => b.s - a.s);
    const pool = scored.slice(0, 600);

    // 5. Variety: MMR re-ranking.
    const mmr = (cands, n, lambda = 0.72) => {
      const picked = [];
      const rest = cands.slice();
      while (picked.length < n && rest.length) {
        let best = -Infinity, bi = 0;
        for (let i = 0; i < Math.min(rest.length, 150); i++) {
          let maxSim = 0;
          for (const p of picked) { const x = this.sim(rest[i].f, p.f); if (x > maxSim) maxSim = x; }
          const v = lambda * rest[i].s - (1 - lambda) * maxSim;
          if (v > best) { best = v; bi = i; }
        }
        picked.push(rest.splice(bi, 1)[0]);
      }
      return picked;
    };
    const top = mmr(pool, 30).map((x) => x.it.k);

    // "Because you watched X": TMDB rows first, otherwise nearest neighbours by features.
    const rows = [];
    const usedSeeds = new Set();
    // (The catalogue can be reloaded while TMDB is asked above: titles found then may be gone now.)
    for (const b of because) {
      if (rows.length >= 4) break;
      const seedIt = cat.get(b.seed);
      if (!seedIt) continue;
      const keys = b.keys.filter((k) => !done.has(k) && !seeds.has(k) && !started.has(k) && cat.get(k) && filter.test(cat.get(k))).slice(0, 20);
      if (keys.length < 3) continue;
      usedSeeds.add(b.seed);
      rows.push({ id: 'because:' + b.seed, title: `Because you watched ${seedIt.n}`, seed: b.seed, keys });
    }
    const recentSeeds = [];
    for (const h of ud.history) { const u = unit(h.k); if (u && (u.t === 'movie' || u.t === 'show') && !recentSeeds.includes(u.k) && (seeds.get(u.k) || 0) > 0) recentSeeds.push(u.k); if (recentSeeds.length >= 6) break; }
    for (const k of recentSeeds) {
      if (rows.length >= 4) break;
      if (usedSeeds.has(k)) continue;
      const sf = this.features(cat.get(k));
      const near = pool.map((x) => ({ ...x, s: this.sim(sf, x.f) + x.s * 0.2 })).filter((x) => x.s > 0.15).sort((a, b) => b.s - a.s);
      const keys = mmr(near.slice(0, 120), 18, 0.8).map((x) => x.it.k);
      if (keys.length >= 4) rows.push({ id: 'because:' + k, title: `Because you watched ${cat.get(k).n}`, seed: k, keys });
    }
    // Recommended by several things you watched at once (the strongest signal there is).
    const scoreOf = new Map(scored.map((x) => [x.it.k, x]));
    const multi = [...bySeeds.entries()].filter(([ck, set]) => set.size >= 2 && scoreOf.has(ck)).sort((a, b) => b[1].size - a[1].size || scoreOf.get(b[0]).s - scoreOf.get(a[0]).s);
    if (multi.length >= 4) {
      const tally = new Map();
      for (const [, set] of multi.slice(0, 30)) for (const sk of set) tally.set(sk, (tally.get(sk) || 0) + 1);
      const names = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([sk]) => (cat.get(sk) || {}).n || '').filter(Boolean);
      const keys = mmr(multi.slice(0, 80).map(([ck]) => scoreOf.get(ck)), 20, 0.8).map((x) => x.it.k);
      if (names.length) rows.unshift({ id: 'mix:all', title: `Because you watched ${names.join(', ')}${tally.size > 2 ? ' and more' : ''}`, keys, seeds: [...tally.keys()].slice(0, 6) });
    }

    // The people behind what you like: actors and directors who turn up in several of your titles.
    const people = (field, limit) => {
      const w = new Map(), seen = new Map(), display = new Map();
      for (const [k, sw] of seeds) {
        if (sw <= 0) continue;
        const it = cat.get(k);
        for (const raw of String((it && it[field]) || '').split(',').slice(0, field === 'cast' ? 5 : 2)) {
          const nm = raw.trim(); if (!nm) continue;
          const id = nm.toLowerCase();
          w.set(id, (w.get(id) || 0) + sw);
          seen.set(id, (seen.get(id) || 0) + 1);
          display.set(id, nm);
        }
      }
      return [...w.entries()].filter(([id]) => seen.get(id) >= 2).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => ({ id, name: display.get(id) }));
    };
    const withPerson = (field, id) => {
      const list = [];
      for (const it of cat.items) {
        if ((it.t !== 'movie' && it.t !== 'show') || done.has(it.k) || seeds.has(it.k) || started.has(it.k) || !filter.test(it)) continue;
        if (!String(it[field] || '').toLowerCase().split(',').some((x) => x.trim() === id)) continue;
        const sc = scoreOf.get(it.k);
        list.push({ k: it.k, s: (sc ? sc.s : 0) + (it.r || 0) / 50 });
      }
      return list.sort((a, b) => b.s - a.s).slice(0, 20).map((x) => x.k);
    };
    for (const p of people('cast', 2)) {
      const keys = withPerson('cast', p.id);
      if (keys.length >= 4) rows.push({ id: 'cast:' + p.id, title: `More with ${p.name}`, keys });
    }
    for (const p of people('dir', 1)) {
      const keys = withPerson('dir', p.id);
      if (keys.length >= 3) rows.push({ id: 'dir:' + p.id, title: `Directed by ${p.name}`, keys });
    }

    // Favourite genres.
    const genreW = [...vec.entries()].filter(([f]) => f.startsWith('g:')).sort((a, b) => b[1] - a[1]).slice(0, 3);
    // Each genre row skips what's already in Top picks and the rows above it, so they don't repeat each other.
    const shown = new Set(top.slice(0, 15));
    for (const r of rows) for (const k of r.keys.slice(0, 10)) shown.add(k);
    for (const [g] of genreW) {
      const name = g.slice(2);
      const keys = pool.filter((x) => !shown.has(x.it.k) && (x.it.gn || []).some((y) => y.toLowerCase() === name)).slice(0, 40);
      const pick = mmr(keys, 18, 0.65).map((x) => x.it.k);
      for (const k of pick.slice(0, 10)) shown.add(k);
      if (pick.length >= 5) rows.push({ id: 'genre:' + name, title: `${name.replace(/\b\w/g, (c) => c.toUpperCase())} picks for you`, keys: pick });
    }
    // Popular in the household.
    const hh = [...household.entries()].filter(([k]) => !done.has(k) && !started.has(k) && cat.get(k) && filter.test(cat.get(k))).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k]) => k);
    const hero = top.find((k) => { const it = cat.get(k); return it && (it.bd || it.logo); }) || top[0] || null;
    const out = { at: Date.now(), version: cat.version.split('.')[0], top, rows, household: hh, hero, seeds: topSeeds.length, ms: Date.now() - t0 };
    if (isGuestId(pid)) (this.guestRecs || (this.guestRecs = new Map())).set(pid, out);
    else fs.writeFileSync(this.file(pid), JSON.stringify(out));
    return out;
  }
}

module.exports = { Recs };
