'use strict';
/**
 * More from TMDB, asked for by a page (lib/tmdbmore.js): a title's logo, cast with photos, makers, facts, release
 * dates and reviews; a person's page; the order a series' episodes are in. Registered from server.js at // [routes:p14].
 *
 *   GET  /api/title/:k/more      what a title's page adds (one TMDB request the first time, then from the cache)
 *   GET  /api/person/:id         a person, with what the household's lists have of theirs first (?n=Name: looked up)
 *   GET  /api/item/:k/orders     the orders this series' episodes can be shown in
 *   POST /api/item/:k/order      { id | '' } — chosen for everyone (not from a kids profile)
 *   GET/POST/DELETE /api/admin/tmdb/extras   every title's page fetched ahead: how far it is, start, stop
 *
 * deps: { route, requireProfile, requireAdmin, readJSON, HttpError, tmdb, catalog(), item, userdata, byTmdb(type, id) → [keys],
 *         areaOff(name), certLevel, log, hub, onOrder(show) }
 */
const { TmdbMore } = require('./tmdbmore');

module.exports = function p14(deps) {
  const { route, requireProfile, readJSON, HttpError, tmdb } = deps;
  const more = new TmdbMore({ tmdb, level: deps.certLevel });
  const cat = () => deps.catalog();
  const off = (a) => !!(deps.areaOff && deps.areaOff(a));
  const titleOf = (ctx, k) => {
    let it = deps.item(ctx, String(k || ''));
    if (it.t === 'episode' && it.sk) it = cat().get(it.sk) || it;
    if (it.t !== 'movie' && it.t !== 'show') throw new HttpError(400, 'Only films and series have these.');
    return it;
  };
  const need = () => { if (!tmdb.enabled()) throw new HttpError(400, 'This needs a TMDB key: the admin can add a free one in Admin → Recommendations.'); };
  const fail = (e) => { if (e instanceof HttpError) throw e; throw new HttpError(502, /key/i.test(e.message) ? 'TMDB rejected the key — the admin can check it in Admin → Recommendations.' : `TMDB didn’t answer (${e.message}).`); };

  route('GET', '/api/title/:k/more', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const it = titleOf(ctx, p.k);
    if (!tmdb.enabled()) return { none: true };
    let m;
    try { m = await more.title(it); } catch { return { none: true }; }
    if (!m) return { none: true };
    // (A rating found for a title that had none: its parental limits hold from now on.)
    if (m.certNew && !it.c) it.c = m.cert;
    const people = !off('people');
    const out = {
      tagline: m.tagline, logo: off('logos') ? '' : m.logo, facts: m.facts, dates: m.dates, imdb: m.imdb, cert: m.cert, certFrom: m.certFrom,
      // (People's pages turned off: their names still, as before — nothing to open.)
      cast: m.cast.map((c) => (people ? c : { name: c.name, as: c.as })), crew: m.crew.map((c) => (people ? c : { name: c.name, job: c.job })), people,
      reviews: prof.kids || off('reviews') ? [] : m.reviews,
    };
    if (it.t === 'show' && !prof.kids) { const mt = tmdb.map.data.m[it.k]; out.order = (mt && mt.eg) || ''; }
    return out;
  });

  // ---------------------------------------------------------------- people
  route('GET', '/api/person/:id', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    need();
    if (off('people')) throw new HttpError(404, 'People’s pages are turned off on this server.');
    const f = cat().filterFor(prof);
    const hidden = new Set(userdata(prof).hidden || []);
    const hereOf = (type, id) => (deps.byTmdb(type === 'tv' ? 'show' : 'movie', id) || []).map((k) => cat().get(k)).filter((x) => x && !hidden.has(x.k) && f.test(x));
    let id = Number(p.id) || 0;
    try {
      // (By name — from a cast list kept as names, or the search box: the one whose work is here.)
      if (!id && q.get('n')) id = await more.findPerson(String(q.get('n')), (type, tid) => hereOf(type, tid).length > 0);
      if (!id) throw new HttpError(404, 'TMDB doesn’t know anyone by that name.');
      const pr = await more.person(id);
      if (!pr || pr.adult) throw new HttpError(404, 'TMDB doesn’t know that person.');
      const here = [], rest = [];
      for (const c of pr.credits) {
        const l = hereOf(c.type, c.id);
        if (l.length) here.push({ k: l[0].k, as: c.as, n: c.n || 0, y: l[0].y || c.year || 0 });
        else rest.push(c);
      }
      here.sort((a, b) => (b.y || 0) - (a.y || 0));
      rest.sort((a, b) => b.pop - a.pop);
      const { credits, adult, ...out } = pr;
      out.here = here.slice(0, 120);
      // (What isn't here: the best known, for the Wishlist. Not shown on a kids profile — it isn't filtered by age.)
      out.more = prof.kids ? [] : rest.slice(0, 30).map((c) => ({ tmdb: c.id, type: c.type, title: c.title, year: c.year, poster: c.poster, as: c.as }));
      out.total = pr.credits.length;
      return out;
    } catch (e) { return fail(e); }
  });
  const userdata = (prof) => { try { return deps.userdata.of(prof.id).data || {}; } catch { return {}; } };

  // ---------------------------------------------------------------- the order of a series' episodes
  route('GET', '/api/item/:k/orders', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    if (prof.kids) throw new HttpError(403, 'Ask a grown-up to change this one.');
    need();
    const it = titleOf(ctx, p.k);
    if (it.t !== 'show') throw new HttpError(400, 'Only series have episodes.');
    const mt = tmdb.map.data.m[it.k];
    try { return { current: (mt && mt.eg) || '', options: await more.orders(it) }; } catch (e) { return fail(e); }
  });
  route('POST', '/api/item/:k/order', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    if (prof.kids) throw new HttpError(403, 'Ask a grown-up to change this one.');
    need();
    const it = titleOf(ctx, p.k);
    if (it.t !== 'show') throw new HttpError(400, 'Only series have episodes.');
    const b = await readJSON(req);
    const id = String((b && b.id) || '');
    const mt = tmdb.map.data.m[it.k];
    if (!mt || !mt.id) throw new HttpError(400, 'This series hasn’t been found on TMDB.');
    let name = 'as first shown';
    if (id) {
      let opts;
      try { opts = await more.orders(it); } catch (e) { return fail(e); }
      const o = opts.find((x) => x.id === id);
      if (!o) throw new HttpError(400, 'That isn’t one of this series’ orders.');
      name = o.name;
      mt.eg = id;
    } else delete mt.eg;
    tmdb.map.save();
    // The episodes' titles, plots and pictures in that order, now (the page is drawn again with them).
    let n = 0;
    try { const r = await tmdb.episodes(it, { fresh: true }); if (r && r.s) for (const s of Object.keys(r.s)) n += Object.keys(r.s[s]).length; } catch (e) { return fail(e); }
    if (id && !n) { delete mt.eg; tmdb.map.save(); await tmdb.episodes(it, { fresh: true }).catch(() => null); throw new HttpError(502, 'TMDB has no episodes in that order just now. Nothing was changed.'); }
    if (deps.log) deps.log(`${prof.name} set the episode order of “${it.n}” to ${name}`);
    if (deps.onOrder) { try { deps.onOrder(it); } catch {} }
    return { ok: true, order: id, episodes: n };
  });

  // ---------------------------------------------------------------- fetching every title's page ahead (admin)
  /**
   * So that no page waits for TMDB the first time it is opened: one request per title that has details and whose
   * page isn't saved yet (mode 'all': every one again), at the pace of everything else asked of TMDB (about 7 a
   * second). In memory only: stopped by a restart, and picks up where it was when started again — what is saved is
   * skipped. Each answer also gives the title its IMDb number, its other names, and an age rating if it had none.
   */
  let job = null, last = null;
  const titlesToFetch = () => {
    const seen = new Set(), out = [];
    const map = tmdb.map.data.m;
    for (const it of cat().items) {
      if (it.t !== 'movie' && it.t !== 'show') continue;
      const mt = map[it.k];
      if (!mt || !mt.id || !mt.type) continue;
      const id = mt.type + mt.id;
      if (seen.has(id)) continue; // (copies of one title share its page)
      seen.add(id);
      out.push(it);
    }
    return out;
  };
  route('GET', '/api/admin/tmdb/extras', (req, res, p, q, ctx) => { deps.requireAdmin(ctx); return { job: job ? job.status : null, last, titles: tmdb.enabled() ? titlesToFetch().length : 0 }; });
  route('POST', '/api/admin/tmdb/extras', async (req, res, p, q, ctx) => {
    deps.requireAdmin(ctx);
    need();
    if (job) return job.status;
    const b = await readJSON(req).catch(() => ({}));
    const all = !!(b && b.mode === 'all');
    const todo = titlesToFetch();
    if (!todo.length) return { running: false, nothing: true };
    const j = job = { status: { running: true, mode: all ? 'all' : 'missing', total: todo.length, done: 0, fetched: 0, had: 0, failed: 0, bytes: 0, current: '', started: Date.now() } };
    if (deps.log) deps.log(`TMDB: fetching page extras ahead for ${todo.length.toLocaleString('en-US')} titles${all ? ' (all of them again)' : ''}`);
    (async () => {
      let breath = Date.now();
      for (const it of todo) {
        if (job !== j) break;
        if (Date.now() - breath > 30) { await new Promise((r) => setImmediate(r)); breath = Date.now(); }
        j.status.current = it.n;
        try {
          const s = await more.saved(it);
          if (s.have && !all) { j.status.had++; j.status.bytes += s.bytes; } else {
            if (all && s.have) await tmdb.get(more.titleReq(tmdb.map.data.m[it.k]).p, more.titleReq(tmdb.map.data.m[it.k]).params, 0).catch(() => null);
            const m = await more.title(it, { size: true });
            if (m) { j.status.fetched++; j.status.bytes += m.bytes || 0; if (m.certNew && !it.c) it.c = m.cert; } else j.status.failed++;
          }
        } catch (e) { if (/key/i.test(e.message)) { j.status.error = e.message; break; } j.status.failed++; }
        j.status.done++;
      }
    })().finally(() => {
      j.status.running = false; j.status.finished = Date.now(); j.status.current = '';
      last = j.status;
      if (job === j) job = null;
      if (deps.log) deps.log(`TMDB: page extras ${j.status.stopped ? 'stopped' : 'done'} — ${j.status.fetched.toLocaleString('en-US')} fetched, ${j.status.had.toLocaleString('en-US')} already here, ${Math.round(j.status.bytes / 1048576).toLocaleString('en-US')} MB`);
    });
    return j.status;
  });
  route('DELETE', '/api/admin/tmdb/extras', (req, res, p, q, ctx) => { deps.requireAdmin(ctx); if (job) { job.status.stopped = true; last = job.status; } job = null; return { ok: true }; });

  return { more };
};
