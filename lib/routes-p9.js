'use strict';
/**
 * Channel health (Admin → Channel health, the "may be down" mark) and "Find guides and logos" (Admin → TV guides).
 * Registered from server.js with one line; everything it needs is passed in. See lib/health.js and lib/publicdb.js.
 */
const path = require('path');
const { JsonFile } = require('./store');
const { Overrides } = require('./overrides');
const { Health, Checker } = require('./health');
const { PublicDb } = require('./publicdb');
const { normName } = require('./util');

let L = { fromCountry: () => null };
try { L = require('./langs'); } catch {}

/**
 * deps: { route, requireProfile, requireAdmin, readJSON, HttpError, D, catalog(), lists, hub, epg, overrides, nowCache,
 *         listUsage, fetch, headers(h), connTest, media, p4, hooks, log }
 */
module.exports = function routesP9(deps) {
  const { route, requireProfile, requireAdmin, readJSON, HttpError, D, lists, hub, epg, overrides, nowCache, log } = deps;
  const cat = () => deps.catalog();
  const isChan = (it) => it && (it.t === 'live' || it.t === 'radio');
  const pushCatalog = () => { const c = cat(); c.metaChanged(); nowCache.clear(); hub.toAll('catalog', { version: c.version }); };

  // ================================================================ channel health
  const health = new Health(D, { catalog: cat, onDown: (v) => hub.toAll('health', { v }) });
  const checker = new Checker({
    health, catalog: cat, lists, log,
    usage: (id) => deps.listUsage().get(id) || [],
    conns: () => hub.conns,
    headers: deps.headers,
    fetch: deps.fetch,
    timeout: Number(process.env.HEALTH_CHECK_TIMEOUT_MS) || 15000,
    other: (id) => {
      if (deps.connTest && deps.connTest.running()) return 'A connection test is running.';
      if (deps.media && [...deps.media.sessions.values()].some((s) => !s.exited)) return 'The server is converting a stream for someone.';
      const out = deps.p4 && deps.p4.outputs && deps.p4.outputs.active;
      if (out && [...out.values()].some((a) => a.list === id && (a.live || Date.now() - (a.at || 0) < 120e3))) return 'Another app is playing from this provider.';
      return '';
    },
  });

  // What devices already report: each play's outcome counts against the copy it used.
  deps.hooks.played = (it, alt, b) => {
    if (!isChan(it) || b.cu) return;
    if (b.failed) {
      const o = { ok: false, by: 'p', msg: String(b.msg || '').slice(0, 200), code: Number(b.code) || 0, started: !!b.started };
      if (Number.isInteger(b.alt)) health.record(it, b.alt, o);
      else if (!b.backup) for (const c of Health.copies(it)) health.record(it, c.alt, o); // (an older app: every copy was tried)
    } else health.record(it, alt, { ok: true, by: 'p', route: String(b.route || '') });
  };
  // Which copy plays first: someone is about to watch, so a check on that provider stops at once.
  deps.hooks.rank = (it) => { checker.yieldTo(it); return isChan(it) ? health.rank(it) : null; };

  route('GET', '/api/health/down', (req, res, p, q, ctx) => {
    requireProfile(ctx);
    return { v: health.downV, keys: health.opts.marks === false ? [] : health.downKeys().slice(0, 5000) };
  });

  const checkedToday = () => {
    const m = new Map(), now = Date.now();
    for (const r of Object.values(health.d.copies)) if (now - (r.ck || 0) < 86400e3) m.set(r.l, (m.get(r.l) || 0) + 1);
    return m;
  };
  route('GET', '/api/admin/health', (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const all = lists.all().filter((l) => l.type !== 'folder');
    const today = checkedToday();
    const counts = checker.counts();
    const providers = health.providers(all).map((pv) => {
      const l = all.find((x) => x.id === pv.id);
      const lim = Checker.limitOf(l);
      return { ...pv, type: l.type, enabled: !!l.enabled, checkable: checker.checkable(l), limit: lim.known ? (lim.n === Infinity ? 0 : lim.n) : null, tight: Checker.tight(l), channels: counts.get(l.id) || 0, checked: today.get(l.id) || 0, lastPass: health.d.passes[l.id] || 0, estimate: checker.estimate(l), ...checker.status(l.id) };
    });
    const list = String(q.get('list') || ''), show = String(q.get('show') || ''), qs = String(q.get('q') || '').trim();
    const failing = health.failing({ list, show, q: qs, norm: normName });
    const names = {}; for (const l of lists.all()) names[l.id] = l.name;
    const from = Math.max(0, Number(q.get('from')) || 0), n = Math.min(300, Math.max(1, Number(q.get('n')) || 100));
    const all2 = health.failing({});
    return {
      opts: health.opts, inWindow: checker.inWindow(), providers, names,
      failing: { total: failing.length, items: failing.slice(from, from + n) },
      summary: { failing: all2.length, down: all2.filter((x) => x.down).length, backup: all2.filter((x) => x.backup).length, marked: health.downKeys().length },
    };
  });
  route('PUT', '/api/admin/health', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const b = await readJSON(req);
    const o = health.setOpts(b);
    return { opts: o };
  });
  route('POST', '/api/admin/health/lists/:id/check', (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const l = lists.get(p.id);
    try { checker.start(l, ctx.sess && ctx.sess.id); } catch (e) { throw new HttpError(e.status || 400, e.message); }
    return checker.status(l.id);
  });
  route('DELETE', '/api/admin/health/lists/:id/check', (req, res, p, q, ctx) => { requireAdmin(ctx); checker.stop(p.id); return checker.status(p.id); });
  route('POST', '/api/admin/health/prefer', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const b = await readJSON(req);
    const k = String(b.k || ''), id = String(b.id || '');
    const it = cat().get(k);
    if (id && (!isChan(it) || !Health.copies(it).some((c) => c.id === id))) throw new HttpError(404, 'That copy of the channel isn’t there any more.');
    health.prefer(k, id);
    return { ok: true, prefer: id };
  });
  route('POST', '/api/admin/health/forget', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const b = await readJSON(req);
    health.forget(String(b.k || ''));
    return { ok: true };
  });

  // ================================================================ find guides and logos
  const finder = new JsonFile(path.join(D, 'guidefinder.json'), { iptvGuide: '', applied: 0 });
  const db = new PublicDb({ dataDir: D, fetch: deps.fetch, log, fromCountry: L.fromCountry });
  let job = null; // { running, step, at, error, result, ac }
  const jobView = () => (job ? { running: job.running, step: job.step, at: job.at, ended: job.ended || 0, error: job.error || '' } : null);
  const guideName = (id) => {
    for (const [sid, src] of epg.sources) if (src.channels && src.channels[id]) { const g = lists.guides().find((x) => x.id === sid); return g ? g.name : ''; }
    return '';
  };
  const needs = () => {
    let guide = 0, logo = 0;
    for (const it of cat().items) if (isChan(it)) { if (!it.epg) guide++; if (!it.logo) logo++; }
    return { guide, logo };
  };

  route('GET', '/api/admin/findguides', (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const r = job && job.result;
    return { job: jobView(), result: r ? { at: r.at, checked: r.checked, countries: r.countries, items: r.items, warnings: r.warnings || [] } : null, cache: db.info(), iptvGuide: finder.data.iptvGuide || '', need: needs() };
  });
  route('PUT', '/api/admin/findguides/settings', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const b = await readJSON(req);
    const u = String(b.iptvGuide || '').trim();
    if (u && !/^https?:\/\//i.test(u)) throw new HttpError(400, 'Enter a web address starting with http:// or https://');
    finder.data.iptvGuide = u.slice(0, 500);
    finder.save();
    return { iptvGuide: finder.data.iptvGuide };
  });
  route('POST', '/api/admin/findguides/scan', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const b = await readJSON(req).catch(() => ({}));
    if (job && job.running) return jobView();
    const ac = new AbortController();
    job = { running: true, step: 'Starting…', at: Date.now(), ac };
    const me = job;
    (async () => {
      const chans = [];
      const listOf = new Map(lists.all().map((l) => [l.id, l]));
      for (const it of cat().items) {
        if (!isChan(it) || (it.epg && it.logo)) continue;
        chans.push({ it, list: listOf.get(it.src), needGuide: !it.epg, needLogo: !it.logo });
        if (chans.length >= 20000) break;
      }
      // The providers' own categories and names ("UK | Entertainment") say which country a channel is from; the
      // catalogue keeps only the tidied ones. Read them again from the saved lists, a slice at a time.
      me.step = 'Reading your lists…';
      const want = new Set(chans.map((x) => x.it.u));
      const raw = new Map();
      for (const l of lists.all()) {
        if (!l.enabled || l.type === 'folder' || ac.signal.aborted) continue;
        const g = lists.itemSteps(l);
        let t = Date.now();
        while (!g.next().done) if (Date.now() - t > 25) { await new Promise((r) => setImmediate(r)); t = Date.now(); }
        const p = lists.parsed.get(l.id);
        for (const e of (p && p.items) || []) if (want.has(e.url)) raw.set(e.url, { g: e.group || e.category || '', n: e.name || '', c: e.country || '' });
      }
      if (lists.releaseItemsSoon) lists.releaseItemsSoon();
      for (const x of chans) x.raw = raw.get(x.it.u) || null;
      if (!chans.length) { me.result = { at: Date.now(), checked: 0, countries: [], items: [] }; return; }
      me.result = await db.suggest(chans, { guides: { has: (id) => epg.has(id), nameOf: guideName }, iptvGuide: finder.data.iptvGuide || '', refresh: !!b.refresh, signal: ac.signal, say: (s) => { me.step = s; } });
    })().catch((e) => { me.error = ac.signal.aborted ? 'Stopped.' : e.plain ? e.message : `Couldn’t get the public lists: ${e.message}`; log(`Guide finder: ${e.message}${e.tech ? ` (${e.tech})` : ''}`); })
      .finally(() => { me.running = false; me.ended = Date.now(); me.step = ''; });
    return jobView();
  });
  route('DELETE', '/api/admin/findguides/scan', (req, res, p, q, ctx) => { requireAdmin(ctx); if (job && job.running) job.ac.abort(); return jobView(); });

  /** Accepts suggestions: [{ k, logo: true, guide: true }]. Only what the last search suggested can be applied. */
  route('POST', '/api/admin/findguides/apply', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const b = await readJSON(req);
    const r = job && job.result;
    if (!r) throw new HttpError(409, 'Look for matches first.');
    const byK = new Map(r.items.map((s) => [s.k, s]));
    const c = cat();
    const addGuides = new Map();
    let logos = 0, guides = 0;
    for (const want of (Array.isArray(b.items) ? b.items : []).slice(0, 20000)) {
      const s = byK.get(String(want && want.k));
      const it = s && c.get(s.k);
      if (!isChan(it)) continue;
      const patch = {};
      if (want.logo && s.logo && !it.logo) { patch.logo = s.logo.url; logos++; }
      if (want.guide && s.guide && !it.epg) {
        patch.eo = s.guide.id; guides++;
        if (s.guide.url && !lists.guides().some((g) => g.url === s.guide.url)) addGuides.set(s.guide.url, s.guide.kind === 'epgpw' ? s.guide.label.split(':')[0] : 'Your iptv-org guide');
      }
      if (!Object.keys(patch).length) continue;
      const o = overrides.set(s.k, patch, { n0: it._o ? it._o.n : it.n, t: it.t, g0: it._o ? it._o.g : it.g });
      if (o) Overrides.applyTo(it, o);
      s.done = { logo: !!patch.logo || (s.done && s.done.logo), guide: !!patch.eo || (s.done && s.done.guide) };
    }
    const added = [];
    for (const [url, name] of addGuides) {
      added.push(name);
      lists.addGuide({ url, name }).catch((e) => log(`Guide finder: adding “${name}”: ${e.message}`)); // (downloads in the background)
    }
    finder.data.applied = (finder.data.applied || 0) + logos + guides;
    finder.save();
    if (guides) c.epgChanged();
    if (logos || guides) pushCatalog();
    return { logos, guides, added };
  });

  return { health, checker, db };
};
