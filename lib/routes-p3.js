'use strict';
/**
 * Channel editing (Admin → Channels), guide matching and offsets, placeholder listings, parental locks and the
 * "On later" listings. Registered from server.js; everything it needs is passed in.
 */
const { Catalog } = require('./catalog');
const { Overrides } = require('./overrides');
const { normName } = require('./util');

const SPORT_CAT = /sport|football|soccer|basketball|baseball|hockey|tennis|golf|racing|motor|boxing|mma|ufc|wrestling|cricket|rugby|athletic|nfl|nba|nhl|mlb|ncaa|f1\b|formula|cycling|darts|snooker|olympic/i;
const FILM_CAT = /^(movie|movies|film|films|feature film|cinema|movie - .*)$|\bmovie\b|\bfilm\b/i;
const NEWS_CAT = /news|current affairs/i;
const KIDS_CAT = /kids|children|animation|cartoon|preschool/i;
const SPORT_GRP = /sport|espn|ppv|dazn|nfl|nba|nhl|mlb|tsn|bein|fox sports|sky sports|tnt sports|golf|racing|ufc|wwe|goal/i;
const LEAGUES = [
  ['NFL', /\bnfl\b/i], ['NBA', /\bnba\b/i], ['NHL', /\bnhl\b/i], ['MLB', /\bmlb\b/i], ['MLS', /\bmls\b/i], ['WNBA', /\bwnba\b/i],
  ['College sports', /\bncaa|college (football|basketball)/i], ['UFC', /\bufc\b/i], ['WWE', /\bwwe\b/i], ['Boxing', /boxing|fight night/i],
  ['Formula 1', /formula 1|\bf1\b|grand prix/i], ['NASCAR', /nascar/i], ['IndyCar', /indycar/i], ['MotoGP', /motogp/i],
  ['Premier League', /premier league|\bepl\b/i], ['Champions League', /champions league|\bucl\b/i], ['Europa League', /europa league/i],
  ['La Liga', /la ?liga/i], ['Serie A', /serie a\b/i], ['Bundesliga', /bundesliga/i], ['Ligue 1', /ligue 1/i], ['FA Cup', /fa cup/i],
  ['World Cup', /world cup/i], ['Tennis', /tennis|\batp\b|\bwta\b|wimbledon|open championship/i], ['Golf', /golf|\bpga\b|masters/i],
  ['Cricket', /cricket|\bipl\b|test match|t20/i], ['Rugby', /rugby/i], ['Darts', /darts/i], ['Snooker', /snooker/i], ['Cycling', /cycling|tour de france/i],
];
const GENERIC = /^(sports?|sport event|sports event|live|live sport|football|soccer|other)$/i;
const obj = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {}); // (a body of null, a number or a list)

module.exports = function routesP3({ route, requireProfile, requireAdmin, readJSON, HttpError, serveFile, catalog: cat, epg, lists, overrides, hub, settings, progOut, chanShift, scheduleRebuild, nowCache }) {
  const pushCatalog = () => { const c = cat(); c.metaChanged(); nowCache.clear(); hub.toAll('catalog', { version: c.version }); };
  const isChan = (it) => it && (it.t === 'live' || it.t === 'radio');
  const listName = (id) => { const l = lists.all().find((x) => x.id === id); return l ? l.name : ''; };

  // ------------------------------------------------------------ Admin → Channels
  const view = (it) => ({
    k: it.k, t: it.t, n: it.n, n0: it._o ? it._o.n : it.n, num: it.num || 0, g: it.g, g0: it._o ? it._o.g : it.g, logo: it.logo || '', logo0: it._o ? it._o.logo || '' : it.logo || '',
    so: it.so || 0, src: it.src || '', epg: it.epg || '', eo: it.eo || '', off: it.eoff || 0, ov: !!overrides.get(it.k), locked: overrides.isLocked(it), tvgId: it.tvgId || '',
  });
  const hiddenView = (k, o) => ({ k, t: o.t || 'live', n: o.n || o.n0 || k, n0: o.n0 || '', num: o.num || 0, g: o.g || o.g0 || '', g0: o.g0 || '', logo: o.logo || '', so: o.so || 0, src: '', epg: '', eo: o.eo || '', off: o.off || 0, ov: true, hidden: true, locked: false });

  route('GET', '/api/admin/channels', (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const c = cat();
    const nq = normName(String(q.get('q') || ''));
    const list = String(q.get('list') || ''), g = String(q.get('g') || ''), type = String(q.get('type') || '');
    const show = String(q.get('show') || ''); // '' | 'changed' | 'hidden' | 'locked' | 'noguide'
    const from = Math.max(0, Number(q.get('from')) || 0), n = Math.min(500, Math.max(1, Number(q.get('n')) || 200));
    const groups = new Map();
    let all = [];
    for (const it of c.items) {
      if (!isChan(it)) continue;
      groups.set(it.g, (groups.get(it.g) || 0) + 1);
      if (type && it.t !== type) continue;
      if (list && it.src !== list && !(it.alts || []).some((a) => a.l === list)) continue;
      if (g && it.g !== g) continue;
      if (nq && !normName(it.n).includes(nq) && !(it._o && normName(it._o.n).includes(nq)) && String(it.num) !== nq) continue;
      if (show === 'changed' && !overrides.get(it.k)) continue;
      if (show === 'locked' && !overrides.isLocked(it)) continue;
      if (show === 'noguide' && it.epg) continue;
      if (show === 'hidden') continue;
      all.push(it);
    }
    all.sort((a, b) => (a.so || a.num || 0) - (b.so || b.num || 0));
    let out = all.map(view);
    if (show === 'hidden' || show === 'changed' || (!list && !show)) {
      const hidden = Object.entries(overrides.d.ch).filter(([, o]) => o.hide).map(([k, o]) => hiddenView(k, o))
        .filter((h) => (!g || h.g === g) && (!type || h.t === type) && (!nq || normName(h.n).includes(nq) || normName(h.n0).includes(nq)));
      out = show === 'hidden' ? hidden : out.concat(show === 'changed' ? hidden : []);
    }
    for (const o of out) o.srcName = listName(o.src);
    return {
      total: out.length, items: out.slice(from, from + n),
      groups: [...groups.entries()].map(([name, count]) => ({ name, n: count, locked: overrides.lockGroups.has(String(name).toLowerCase()) })).sort((a, b) => a.name.localeCompare(b.name)),
      lists: lists.all().map((l) => ({ id: l.id, name: l.name })), hasPin: overrides.hasPin, placeholders: overrides.placeholders,
      changed: Object.keys(overrides.d.ch).length,
    };
  });

  /** Changes one channel now, without rebuilding the catalogue (hiding drops it; showing it again needs a rebuild). */
  function change(k, patch) {
    const c = cat();
    const it = c.get(k);
    const orig = it ? { n0: it._o ? it._o.n : it.n, t: it.t, g0: it._o ? it._o.g : it.g } : null;
    if ('num' in patch && !('so' in patch)) patch.so = null; // a new number puts it in that place
    const was = overrides.get(k);
    const o = overrides.set(k, patch, orig);
    let relink = false, rebuild = false;
    if (it && isChan(it)) {
      if (o && o.hide) { c.items = c.items.filter((x) => x !== it); c.byKey.delete(k); Overrides.restore(it); }
      else if (o) { relink = (it.eo || '') !== (o.eo || ''); Overrides.applyTo(it, o); }
      else { relink = !!it.eo; Overrides.restore(it); }
    } else if (was && was.hide && !(o && o.hide)) rebuild = true;
    if (relink) c.epgChanged();
    return { o, rebuild };
  }
  const finish = (rebuild) => { if (rebuild) scheduleRebuild(300); else pushCatalog(); };

  route('PUT', '/api/admin/channels/:k', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const b = obj(await readJSON(req));
    const patch = {};
    for (const f of ['n', 'logo', 'num', 'g', 'so', 'hide', 'eo', 'off']) if (f in b) patch[f] = b[f];
    if ('lock' in b) overrides.lock('key', p.k, !!b.lock);
    const r = change(p.k, patch);
    finish(r.rebuild);
    const it = cat().get(p.k);
    return it ? view(it) : r.o ? hiddenView(p.k, r.o) : { k: p.k };
  });
  route('DELETE', '/api/admin/channels/:k', (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const was = overrides.get(p.k);
    const it = cat().get(p.k);
    overrides.reset(p.k);
    if (it) { const relink = !!it.eo; Overrides.restore(it); if (relink) cat().epgChanged(); }
    finish(!!(was && was.hide));
    const now = cat().get(p.k);
    return now ? view(now) : { k: p.k, gone: true };
  });

  route('POST', '/api/admin/channels/bulk', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const b = obj(await readJSON(req));
    const keys = (Array.isArray(b.keys) ? b.keys : []).map(String).slice(0, 5000);
    let rebuild = false;
    const c = cat();
    if (b.action === 'renumber') {
      let n = Math.max(1, Math.floor(Number(b.from) || 1));
      const sorted = keys.map((k) => c.get(k)).filter(Boolean).sort((x, y) => (x.so || x.num || 0) - (y.so || y.num || 0));
      for (const it of sorted) rebuild = change(it.k, { num: n++ }).rebuild || rebuild;
    } else if (b.action === 'order') {
      // A category's new order: its channels take its own numbers (as sort places) in this order, so the order also
      // holds in "All channels" without changing anyone's channel number.
      const its = keys.map((k) => c.get(k)).filter(isChan);
      const places = its.map((it) => it.so || it.num || 0).sort((x, y) => x - y);
      for (let i = 1; i < places.length; i++) if (places[i] <= places[i - 1]) places[i] = places[i - 1] + 0.001;
      its.forEach((it, i) => change(it.k, { so: places[i] === it.num ? null : places[i] }));
    } else {
      for (const k of keys) {
        if (b.action === 'hide') rebuild = change(k, { hide: true }).rebuild || rebuild;
        else if (b.action === 'unhide') rebuild = change(k, { hide: false }).rebuild || rebuild;
        else if (b.action === 'move') rebuild = change(k, { g: String(b.g || '').trim() || null }).rebuild || rebuild;
        else if (b.action === 'lock' || b.action === 'unlock') overrides.lock('key', k, b.action === 'lock');
        else if (b.action === 'reset') { const was = overrides.get(k); const it = c.get(k); overrides.reset(k); if (it) Overrides.restore(it); if (was && was.hide) rebuild = true; }
        else throw new HttpError(400, 'Unknown action');
      }
    }
    finish(rebuild);
    return { ok: true, rebuild };
  });

  route('POST', '/api/admin/channels/logo', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const b = obj(await readJSON(req));
    const name = overrides.saveLogo(b.data);
    return { logo: '/api/channel-logo/' + name };
  });
  route('GET', '/api/channel-logo/:name', (req, res, p) => {
    const f = overrides.logoPath(p.name);
    if (!f) throw new HttpError(404, 'Not found');
    serveFile(req, res, f, { cache: 'private, max-age=604800' });
  }, 'site');

  // ------------------------------------------------------------ guide matching and offsets
  const peek = (cid, offH) => {
    const sh = (Number(offH) || 0) * 3600e3, now = Date.now();
    return epg.range(cid, now - sh - 1, now - sh + 6 * 3600e3).slice(0, 4).map((x) => ({ s: x.s + sh, e: x.e + sh, t: x.t }));
  };
  route('GET', '/api/admin/guide-channels', (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const qs = String(q.get('q') || '').trim();
    const hits = epg.search(qs, 60).filter((h) => epg.has(h.id));
    return hits.map((h) => ({ id: h.id, name: h.name, icon: h.icon, peek: peek(h.id, Number(q.get('off')) || 0) }));
  });
  route('GET', '/api/admin/guide-peek', (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    return { id: String(q.get('id') || ''), peek: peek(String(q.get('id') || ''), Number(q.get('off')) || 0) };
  });
  route('GET', '/api/admin/guide-offsets', (req, res, p, q, ctx) => { requireAdmin(ctx); return { offsets: overrides.d.guideOffsets, placeholders: overrides.placeholders }; });
  route('PUT', '/api/admin/guides/:id/offset', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const b = obj(await readJSON(req));
    const h = overrides.setGuideOffset(p.id, b.hours);
    nowCache.clear();
    epg.setOffsets(overrides.d.guideOffsets).then(() => { nowCache.clear(); hub.toAll('catalog', { version: cat().version }); }).catch(() => {});
    return { hours: h };
  });
  route('PUT', '/api/admin/epg-placeholders', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const b = obj(await readJSON(req));
    overrides.setPlaceholders(b.on !== false);
    hub.toAll('settings', { epgPlaceholders: overrides.placeholders });
    pushCatalog();
    return { on: overrides.placeholders };
  });

  // ------------------------------------------------------------ parental locks
  route('GET', '/api/admin/locks', (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const c = cat();
    return {
      hasPin: overrides.hasPin, groups: overrides.d.locks.groups,
      keys: overrides.d.locks.keys.map((k) => { const it = c.get(k); return { k, n: it ? it.n : (overrides.get(k) || {}).n0 || k }; }),
    };
  });
  route('POST', '/api/admin/locks/toggle', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const b = obj(await readJSON(req));
    if (b.kind !== 'group' && b.kind !== 'key') throw new HttpError(400, 'Unknown lock');
    overrides.lock(b.kind, String(b.value || ''), !!b.on);
    pushCatalog();
    return { ok: true, groups: overrides.d.locks.groups, keys: overrides.d.locks.keys };
  });
  route('PUT', '/api/admin/parental-pin', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const b = obj(await readJSON(req));
    overrides.setPin(b.pin === '' || b.pin === null ? null : String(b.pin));
    hub.toAll('settings', { parentalPin: overrides.hasPin });
    return { hasPin: overrides.hasPin };
  });

  route('GET', '/api/parental', (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    return { pin: overrides.hasPin, locks: overrides.hasLocks, until: prof.kids ? 0 : overrides.unlockedUntil(ctx.sess.id, prof.id), kids: !!prof.kids };
  });
  route('POST', '/api/parental/unlock', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const b = obj(await readJSON(req));
    return { until: overrides.unlock(ctx.sess.id, prof, b.pin) };
  });
  route('POST', '/api/parental/lock', (req, res, p, q, ctx) => { requireProfile(ctx); overrides.relock(ctx.sess.id); return { ok: true }; });
  /** Once unlocked: the locked items' addresses and listings (they were left out of the catalogue). */
  route('GET', '/api/parental/items', (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    if (!overrides.allowed(ctx)) throw new HttpError(423, 'Enter the parental PIN first.');
    const c = cat();
    const f = c.filterFor(prof);
    const now = Date.now();
    const items = [], guide = {};
    for (const k of String(q.get('keys') || '').split(',').slice(0, 2000)) {
      const it = c.get(k);
      if (!it || !overrides.isLocked(it, (x) => c.get(x)) || !f.test(it.t === 'episode' ? (c.get(it.sk) || it) : it)) continue;
      items.push(Catalog.compact(it));
      if (it.epg) { const l = epg.range(it.epg, now - 3 * 3600e3, now + 8 * 3600e3); if (l.length) guide[k] = l.map(progOut); }
    }
    return { items, guide, until: overrides.unlockedUntil(ctx.sess.id, ctx.profile && ctx.profile.id) };
  });

  // ------------------------------------------------------------ On later
  const kindOf = (x, it) => {
    const cats = x.c ? [].concat(x.c).join(' | ') : '';
    if (cats) {
      if (SPORT_CAT.test(cats)) return 'sport';
      if (FILM_CAT.test(cats) || /movie|film/i.test(cats)) return 'film';
      if (KIDS_CAT.test(cats)) return 'kids';
      if (NEWS_CAT.test(cats)) return 'news';
      return '';
    }
    if (SPORT_GRP.test(it.g + ' ' + it.n) && /\bvs?\.?\b|\bat\b|\blive\b|grand prix|match|final|derby|fight/i.test(x.t)) return 'sport';
    return '';
  };
  const leagueOf = (x) => {
    const hay = [x.t, x.st || '', ...[].concat(x.c || [])].join(' | ');
    for (const [name, re] of LEAGUES) if (re.test(hay)) return name;
    const specific = [].concat(x.c || []).find((c) => SPORT_CAT.test(c) && !GENERIC.test(c.trim()));
    if (specific) return specific.trim().replace(/^sports?\s*[-:]\s*/i, '');
    const pre = /^([A-Z][\w .'&]{2,30}?)\s*[:–-]\s/.exec(x.t);
    if (pre && !/^live$/i.test(pre[1])) return pre[1].trim();
    return 'More sports';
  };
  const laterCache = new Map();
  route('GET', '/api/onlater', (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const c = cat();
    const f = c.filterFor(prof);
    const hours = Math.max(1, Math.min(72, Number(q.get('h')) || 48));
    const kinds = new Set(String(q.get('kinds') || 'sport,film').split(',').filter((x) => ['sport', 'film', 'news', 'kids'].includes(x)));
    const ck = c.version + f.sig + hours + [...kinds].join();
    const hit = laterCache.get(ck);
    if (hit && Date.now() - hit.t < 5 * 60e3) return hit.v;
    const now = Date.now(), until = now + hours * 3600e3;
    const seen = new Map();
    const out = [];
    for (const it of c.items) {
      if (it.t !== 'live' || !it.epg || !f.test(it)) continue;
      if (overrides.hasLocks && overrides.isLocked(it)) continue;
      const sh = chanShift(it);
      for (const x of epg.range(it.epg, now - sh, until - sh)) {
        const s = x.s + sh;
        if (s < now - 60e3) continue; // (started already: that's "on now")
        const kind = kindOf(x, it);
        if (!kind || !kinds.has(kind)) continue;
        // The same match or film on several channels: once, on the first (favourite channels come first on devices).
        const dk = normName(x.t) + '|' + s;
        const prev = seen.get(dk);
        if (prev) { prev.also = (prev.also || 0) + 1; if (!prev.ks) prev.ks = []; if (prev.ks.length < 6) prev.ks.push(it.k); continue; }
        const o = { k: it.k, s, e: x.e + sh, t: x.t, kind };
        if (x.st) o.st = x.st;
        if (x.ep) o.ep = x.ep;
        if (x.c) o.c = x.c;
        if (x.n) o.n = 1;
        if (kind === 'sport') o.lg = leagueOf(x);
        seen.set(dk, o);
        out.push(o);
        if (out.length > 3000) break;
      }
      if (out.length > 3000) break;
    }
    out.sort((a, b) => a.s - b.s);
    const v = { at: now, items: out.slice(0, 1500) };
    laterCache.set(ck, { t: Date.now(), v });
    while (laterCache.size > 20) laterCache.delete(laterCache.keys().next().value);
    return v;
  });
};
