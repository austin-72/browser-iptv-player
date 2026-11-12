'use strict';
/**
 * Titles alike: "More like this" on a title's page (lib/routes-p15.js).
 *
 * For one title, or for a set of them (the page's "More" button: what is like the ones already shown), the films or
 * series here most like them: TMDB's own "recommended" and "similar" lists first when TMDB is on (people who liked
 * one also liked the other), then by what recommendations compare (lib/recs.js: genres, category, cast, director,
 * language, decade, words in the name). Another copy of the same title (another list, another language) shows once.
 */
const { norm, stripYear } = require('./catalog');

class Alike {
  /** { catalog: () => Catalog, recs: Recs (features, sim), tmdb } */
  constructor({ catalog, recs, tmdb }) {
    this.catalog = catalog;
    this.recs = recs;
    this.tmdb = tmdb;
  }

  /**
   * seeds: [key]; o: { filter(it) → bool (what the profile may see), skip: [key] (already shown), n (how many),
   * min (how alike, 0–1), tmdbSeeds (how many seeds TMDB is asked about) }. → [key], the most alike first.
   */
  async of(seedKeys, o = {}) {
    const cat = this.catalog();
    const seeds = [];
    for (const k of seedKeys || []) { const it = cat.get(k); if (it && (it.t === 'movie' || it.t === 'show') && !seeds.includes(it)) seeds.push(it); }
    if (!seeds.length) return [];
    const type = seeds[0].t;
    const n = Math.max(1, Math.min(200, o.n || 60));
    const min = o.min === undefined ? 0.45 : o.min;
    const skip = new Set(o.skip || []);
    const same = (it) => norm(stripYear(it.n)) + '|' + (it.y || '');
    // (The seeds themselves and what was already shown, in any of their copies, aren't offered.)
    const seedNames = new Set(seeds.map(same));
    for (const s of seeds) skip.add(s.k);
    for (const k of skip) { const it = cat.get(k); if (it) seedNames.add(same(it)); }
    const ok = (it) => !!it && it.t === type && !skip.has(it.k) && !seedNames.has(same(it)) && (!o.filter || o.filter(it));
    const score = new Map();
    const bump = (k, v) => score.set(k, (score.get(k) || 0) + v);

    // 1. TMDB: people who liked it also liked… (cached for a week by lib/tmdb.js).
    if (this.tmdb && this.tmdb.enabled && this.tmdb.enabled() && o.tmdb !== false) {
      const ask = seeds.slice(0, o.tmdbSeeds || 8);
      const lists = await Promise.all(ask.map((s) => this.tmdb.related(s).catch(() => [])));
      for (const rel of lists) {
        for (const r of rel || []) {
          if ((r.type === 'tv' ? 'show' : 'movie') !== type) continue;
          for (const ck of cat.findTitle(r.title, r.year)) { const c = cat.get(ck); if (ok(c)) bump(c.k, (1 + (r.w || 0)) / ask.length); }
        }
      }
    }

    // 2. By what they're made of: one picture of the seeds, every title of that kind compared with it.
    if (this.recs) {
      const vec = new Map();
      for (const s of seeds) for (const [f, v] of this.recs.features(s)) vec.set(f, (vec.get(f) || 0) + v / seeds.length);
      let n2 = 0;
      for (const v of vec.values()) n2 += v * v;
      vec.norm = Math.sqrt(n2) || 1;
      for (const it of cat.items) {
        if (it.t !== type || !ok(it)) continue;
        const s = this.recs.sim(vec, this.recs.features(it));
        if (s >= min) bump(it.k, s);
      }
    }

    // Best first (a better rating breaks ties); one copy of each title.
    const ranked = [...score.entries()].map(([k, s]) => { const it = cat.get(k); return { it, s: s + Math.min(10, it.r || 0) / 200 }; });
    ranked.sort((a, b) => b.s - a.s);
    const out = [], seen = new Set();
    for (const { it } of ranked) {
      const id = same(it);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(it.k);
      if (out.length >= n) break;
    }
    return out;
  }
}

module.exports = { Alike };
