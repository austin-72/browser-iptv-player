'use strict';
/**
 * Titles alike, for "More like this" on a title's page (lib/alike.js). Registered from server.js at // [routes:p15].
 *
 *   POST /api/alike   { k } — what is like this title; { keys: [k…], skip: [k…] } — what is like these, leaving out
 *                     the ones already shown (the page's "More" button) → { keys: [k…] }, the most alike first
 *
 * deps: { route, requireProfile, readJSON, HttpError, catalog(), recs, tmdb, userdata }
 */
const { Alike } = require('./alike');

module.exports = function p15(deps) {
  const { route, requireProfile, readJSON, HttpError } = deps;
  const alike = new Alike({ catalog: deps.catalog, recs: deps.recs, tmdb: deps.tmdb });
  const hiddenOf = (prof) => { try { return new Set((deps.userdata.of(prof.id).data || {}).hidden || []); } catch { return new Set(); } };

  route('POST', '/api/alike', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const b = (await readJSON(req)) || {};
    const keys = (Array.isArray(b.keys) ? b.keys : [b.k]).filter((k) => typeof k === 'string' && k).slice(0, 40);
    if (!keys.length) throw new HttpError(400, 'Which title?');
    const cat = deps.catalog();
    const f = cat.filterFor(prof);
    const hidden = hiddenOf(prof);
    // (Only titles the profile may see are asked about, or shown.)
    const seeds = keys.filter((k) => { const it = cat.get(k); return it && f.test(it); });
    if (!seeds.length) return { keys: [] };
    const skip = (Array.isArray(b.skip) ? b.skip : []).filter((k) => typeof k === 'string').slice(0, 3000);
    const out = await alike.of(seeds, {
      filter: (it) => f.test(it) && !hidden.has(it.k),
      skip,
      n: Number(b.n) || (seeds.length > 1 ? 48 : 80),
      // (A first look at one title: TMDB about it. The "More" step: about the best few of what was shown.)
      tmdbSeeds: seeds.length > 1 ? 6 : 1,
    });
    return { keys: out };
  });
};
