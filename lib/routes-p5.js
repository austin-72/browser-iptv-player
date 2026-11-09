'use strict';
/**
 * Integrations and admin tools: subtitles found online, the live viewing dashboard, the connection speed test,
 * API keys (for Home Assistant and scripts) and webhooks. Registered from server.js with one line.
 */
const path = require('path');
const crypto = require('crypto');
const { JsonFile } = require('./store');
const { Subtitles, RESERVE } = require('./subtitles');
const { ApiKeys, SCOPES } = require('./apikeys');
const { Webhooks, EVENTS } = require('./webhooks');
const { HttpError, sendJSON, log } = require('./util');

/** Moves every cue by `secs` (cues that end before 0 are dropped). */
/**
 * Moves every cue in a WebVTT file by secs (back, when negative): a conversion that started part-way through has its
 * clock at 0 there. Cues that end before the new 0 are dropped. Times may be "hh:mm:ss.mmm" or "mm:ss.mmm" (ffmpeg
 * writes the short form under an hour — the end times of those weren't moved, so every earlier line stayed on screen
 * at once from 0:00).
 */
function shiftVtt(text, secs) {
  const ts = (t) => { const p = t.split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  const fmt = (t) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${x.toFixed(3).padStart(6, '0')}`; };
  const re = /^((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d{3})(.*)$/;
  return String(text).replace(/\r\n?/g, '\n').split(/\n\n+/).map((blk) => {
    const lines = blk.split('\n');
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0) return blk;
    const m = re.exec(lines[i]);
    const a = ts(m[1].replace(',', '.')) + secs, b = ts(m[2].replace(',', '.')) + secs;
    if (b <= 0) return null;
    lines[i] = `${fmt(Math.max(0, a))} --> ${fmt(b)}${m[3]}`;
    return lines.join('\n');
  }).filter((x) => x !== null).join('\n\n');
}

const mask = (s) => (s ? '•'.repeat(Math.max(4, Math.min(12, String(s).length - 4))) + String(s).slice(-4) : '');
const masked = (v) => typeof v === 'string' && v.includes('•');

/**
 * deps: { route, requireProfile, requireAdmin, readJSON, readBody, D, catalog(), lists, accounts, userdata, hub, tmdb,
 *         fetch, listUsage, srcList, connLimit, accountAlerts, COMMANDS, clientIp, proxyHeaders(list) }
 */
module.exports = function p5(deps) {
  const { route, requireProfile, requireAdmin, D, lists, accounts, userdata, hub, tmdb } = deps;
  // A body of `null` or a bare number is read as {} (rather than "Cannot read properties of null" further on).
  const readJSON = async (req) => { const b = await deps.readJSON(req); return b && typeof b === 'object' ? b : {}; };
  const conf = new JsonFile(path.join(D, 'integrations.json'), { subdl: { apiKey: '' }, sources: { gestdown: true }, opensubtitles: { apiKey: '', username: '', password: '' } });
  if (!conf.data.subdl) conf.data.subdl = { apiKey: '' };
  if (!conf.data.sources) conf.data.sources = { gestdown: true };
  const subs = new Subtitles({ dataDir: D, getConf: () => conf.data, fetch: deps.fetch, log: deps.log });
  const tmdbOf = (it) => (it && it.tmdb && it.tmdb !== '0' ? String(it.tmdb) : (() => { const m = tmdb && tmdb.map && tmdb.map.data.m[it.k]; return m && m.id ? String(m.id) : ''; })());
  const keys = new ApiKeys(D);
  const hooks = new Webhooks(D, { fetch: deps.fetch });

  // ================================================================ admin: integrations
  const adminView = () => {
    const o = conf.data.opensubtitles;
    return {
      subdl: { apiKey: mask((conf.data.subdl || {}).apiKey) }, sources: { gestdown: conf.data.sources.gestdown !== false },
      opensubtitles: { apiKey: mask(o.apiKey), username: o.username || '', password: o.password ? '••••••••' : '', quota: subs.quota, reserve: RESERVE },
      apiKeys: keys.list(), scopes: SCOPES, webhooks: hooks.list(), events: EVENTS, deliveries: hooks.log.slice(0, 30),
    };
  };
  route('GET', '/api/admin/integrations', (req, res, p, q, ctx) => { requireAdmin(ctx); return adminView(); });
  route('PUT', '/api/admin/integrations', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const b = await readJSON(req);
    const put = (into, from, fields) => { for (const f of fields) if (from && f in from && !masked(from[f])) into[f] = String(from[f] || '').trim().slice(0, 300); };
    put(conf.data.opensubtitles, b.opensubtitles, ['apiKey', 'username', 'password']);
    put(conf.data.subdl, b.subdl, ['apiKey']);
    if (b.sources && typeof b.sources === 'object') for (const k of ['gestdown']) if (k in b.sources) conf.data.sources[k] = !!b.sources[k];
    subs.clear();
    conf.save();
    return adminView();
  });
  route('POST', '/api/admin/integrations/opensubtitles/test', async (req, res, p, q, ctx) => { requireAdmin(ctx); try { return await subs.os.test(); } catch (e) { return { ok: false, error: e.message }; } });
  // Tries each subtitle source with a well-known film.
  route('POST', '/api/admin/integrations/subtitles/test', async (req, res, p, q, ctx) => { requireAdmin(ctx); return subs.test(); });

  route('POST', '/api/admin/apikeys', async (req, res, p, q, ctx) => { requireAdmin(ctx); const b = await readJSON(req); if (b.profile && !accounts.profile(b.profile)) throw new HttpError(400, 'No such profile'); return keys.create(b); });
  route('DELETE', '/api/admin/apikeys/:id', (req, res, p, q, ctx) => { requireAdmin(ctx); keys.revoke(p.id); return { ok: true }; });
  route('POST', '/api/admin/webhooks', async (req, res, p, q, ctx) => { requireAdmin(ctx); return hooks.save(await readJSON(req)); });
  route('PUT', '/api/admin/webhooks/:id', async (req, res, p, q, ctx) => { requireAdmin(ctx); return hooks.save(await readJSON(req), p.id); });
  route('DELETE', '/api/admin/webhooks/:id', (req, res, p, q, ctx) => { requireAdmin(ctx); hooks.remove(p.id); return { ok: true }; });
  route('GET', '/api/admin/webhooks/:id/secret', (req, res, p, q, ctx) => { requireAdmin(ctx); return { secret: hooks.secret(p.id) }; });
  route('POST', '/api/admin/webhooks/:id/test', async (req, res, p, q, ctx) => { requireAdmin(ctx); return hooks.test(p.id); });
  route('GET', '/api/admin/webhooks/log', (req, res, p, q, ctx) => { requireAdmin(ctx); return hooks.log.slice(0, 60); });

  // ================================================================ subtitles (SubDL, Addic7ed via Gestdown; OpenSubtitles as the backup)
  const subQuery = (it, langs) => {
    const cat = deps.catalog();
    if (it.t === 'episode') {
      const show = it.sk ? cat.get(it.sk) : null;
      return { parentTmdb: show ? tmdbOf(show) : '', query: show ? show.n : it.show || it.n, season: it.s, episode: it.e, langs };
    }
    return { tmdb: tmdbOf(it), query: it.n, year: it.y || undefined, langs };
  };
  const profLangs = (prof, q) => {
    const asked = String(q.get('langs') || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (asked.length) return asked;
    return (Array.isArray(prof.langs) && prof.langs.length ? prof.langs : deps.defaultLangs() || []).slice(0, 4).concat(['en']);
  };
  const subOut = (x) => ({ id: x.id, fileId: x.id, source: x.source, from: x.from, lang: x.lang, name: x.name, downloads: x.downloads || 0, hi: !!x.hi, machine: !!x.machine, fromTrusted: !!x.fromTrusted, pack: !!x.pack, cached: !!x.cached, costly: !!x.costly });
  route('GET', '/api/opensubs/search', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const it = deps.item(ctx, String(q.get('k') || ''));
    if (it.t !== 'movie' && it.t !== 'episode') throw new HttpError(400, 'Subtitles can be found for films and episodes.');
    const list = await subs.search({ ...subQuery(it, profLangs(prof, q)), hi: q.get('hi') === '1' });
    return { list: list.slice(0, 40).map(subOut), quota: subs.quota, warnings: list.warnings || [] };
  });
  route('POST', '/api/opensubs/get', async (req, res, p, q, ctx) => {
    requireProfile(ctx);
    const b = await readJSON(req);
    // (Older pages send an OpenSubtitles file id on its own.)
    const id = /^\d+$/.test(String(b.id || b.fileId || '')) ? `os:${b.id || b.fileId}` : String(b.id || b.fileId || '');
    const tok = await subs.get(id);
    return { url: `/api/opensubs/file/${tok}`, quota: subs.quota };
  });
  /**
   * The best match in the viewer's first language, fetched — for "fetch subtitles automatically". Free sources first;
   * OpenSubtitles only when the page says the title has been watched for a while (costly: true) and it leaves a couple
   * of downloads for choosing by hand.
   */
  route('POST', '/api/opensubs/auto', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const b = await readJSON(req);
    if (!subs.enabled()) return { none: true, why: 'off' };
    const it = deps.item(ctx, String(b.k || ''));
    if (it.t !== 'movie' && it.t !== 'episode') return { none: true };
    const lang = String(b.lang || '').slice(0, 2) || profLangs(prof, new URLSearchParams()).slice(0, 1)[0];
    const got = await subs.auto({ ...subQuery(it, [lang]), hi: !!b.hi }, lang, { allowCostly: !!b.costly });
    if (!got) return { none: true, quota: subs.quota };
    return { url: `/api/opensubs/file/${got.token}`, lang: got.lang, name: got.name, source: got.source, from: got.from, quota: subs.quota };
  });
  route('GET', '/api/opensubs/file/:id', (req, res, p, q, ctx) => {
    requireProfile(ctx);
    const f = subs.file(p.id);
    let body;
    try { body = require('fs').readFileSync(f); } catch { throw new HttpError(404, 'Not downloaded'); }
    // A conversion that started part-way through: its clock starts at 0, so the cues move back by that much.
    const off = Number(q.get('offset')) || 0;
    if (off > 0) body = Buffer.from(shiftVtt(body.toString('utf8'), -off));
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'private, max-age=86400' });
    res.end(body);
  });

  // ================================================================ live viewing dashboard
  /** conn id → { samples: [...], last } — about five minutes of reports per playing device, in memory only. */
  const live = new Map();
  const num = (v, max) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0; };
  route('POST', '/api/presence/stats', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const b = await readJSON(req);
    const c = hub.conn(String(b.conn || ''));
    if (!c || c.pid !== prof.id) return { ok: false };
    const s = b.s || {};
    const smp = {
      t: Date.now(), route: String(s.route || '').slice(0, 20), br: num(s.br, 1e6), bw: num(s.bw, 1e7), w: num(s.w, 9999), h: num(s.h, 9999),
      buf: num(s.buf, 3600), stalls: num(s.stalls, 1000), stallMs: num(s.stallMs, 600000), dropped: num(s.dropped, 1e7), frames: num(s.frames, 1e8), lvl: String(s.lvl || '').slice(0, 20),
      // Through the stream relay; why it went through this server (see Statistics); remux or transcode.
      sr: !!s.sr, why: String(s.why || '').slice(0, 20), mode: String(s.mode || '').slice(0, 20),
    };
    const e = live.get(c.id) || { samples: [] };
    e.samples.push(smp);
    while (e.samples.length > 30 || (e.samples.length && smp.t - e.samples[0].t > 5 * 60e3)) e.samples.shift();
    e.last = smp;
    live.set(c.id, e);
    return { ok: true };
  });
  const summary = (e) => {
    if (!e || !e.samples.length) return null;
    const s = e.samples, last = e.last;
    const first = s[0];
    const dropped = Math.max(0, last.dropped - first.dropped), frames = Math.max(0, last.frames - first.frames);
    const bws = s.map((x) => x.bw).filter(Boolean);
    return {
      route: last.route, sr: last.sr, why: last.why, mode: last.mode, bitrate: last.br, bandwidth: bws.length ? Math.round(bws.reduce((a, b) => a + b, 0) / bws.length) : 0, w: last.w, h: last.h, buffer: last.buf,
      stalls: s.reduce((a, x) => a + x.stalls, 0), stallSecs: Math.round(s.reduce((a, x) => a + x.stallMs, 0) / 1000), droppedPct: frames ? Math.round((dropped / frames) * 1000) / 10 : 0,
      minutes: Math.max(1, Math.round((last.t - first.t) / 60e3)), age: Date.now() - last.t, level: last.lvl,
    };
  };
  const health = (x) => (!x ? '' : x.stalls >= 3 || x.droppedPct > 10 || (x.buffer < 2 && x.route !== 'browser') ? 'poor' : x.stalls || x.droppedPct > 3 || x.buffer < 5 ? 'fair' : 'good');
  route('GET', '/api/admin/watching', (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    for (const id of live.keys()) if (!hub.conn(id) || !hub.conn(id).playing) live.delete(id);
    const cat = deps.catalog();
    const rows = [...hub.conns].filter((c) => c.playing).map((c) => {
      const st = summary(live.get(c.id));
      const it = cat.get(c.playing.k);
      const lid = it ? deps.srcList(it, Number.isInteger(c.playing.alt) ? c.playing.alt : -1) : '';
      const l = lid && lists.all().find((x) => x.id === lid);
      return { conn: c.id, profile: (accounts.profile(c.pid) || {}).name || '', device: c.deviceName, k: c.playing.k, n: c.playing.hidden ? '' : c.playing.n, hidden: !!c.playing.hidden, at: c.playing.at, list: l ? l.name : '', lid: l ? l.id : '', stats: st, health: health(st) };
    });
    const use = deps.listUsage();
    // Every provider (all enabled lists but the household's own folders and files): its account, its connections in use,
    // and who's watching from it.
    const conns = lists.all().filter((l) => l.enabled && l.type !== 'folder' && l.type !== 'file').map((l) => {
      const users = use.get(l.id) || [];
      const a = l.account || null;
      const hasAccount = !!((lists.xtAccountOf && lists.xtAccountOf(l)) || l.type === 'stalker');
      return {
        id: l.id, name: l.name, type: l.type, used: users.length, limit: Number(a && a.maxConnections) || 0,
        measured: l.connTest ? Math.max(...['live', 'show', 'movie'].map((k) => (l.connTest[k] && l.connTest[k].max) || 0)) : 0,
        hasAccount, account: a ? { status: a.status || '', expires: a.expires || null, max: a.maxConnections || '', active: a.activeConnections === undefined ? '' : a.activeConnections, trial: !!a.trial, error: a.error || '', checkedAt: a.checkedAt || 0 } : null,
        // (Uses that aren't a device playing: a recording, another app.)
        other: users.filter((c) => !rows.some((r) => r.conn === c.id)).map((c) => ({ who: (accounts.profile(c.pid) || {}).name || '', device: c.deviceName || '', n: (c.playing && c.playing.n) || '' })),
      };
    });
    return { rows, lists: conns, at: Date.now() };
  });

  // ================================================================ speed test
  const RAND = crypto.randomBytes(1024 * 1024); // incompressible
  const tests = new Map(); // session → last start
  let running = 0;
  const gate = (ctx) => {
    const sid = (ctx.sess && ctx.sess.id) || 'x';
    const last = tests.get(sid) || 0;
    if (Date.now() - last < 4000) throw new HttpError(429, 'One test at a time — try again in a few seconds.');
    tests.set(sid, Date.now());
    if (tests.size > 500) tests.clear();
  };
  route('GET', '/api/speedtest/ping', () => ({ t: Date.now() }));
  route('GET', '/api/speedtest/down', (req, res, p, q, ctx) => {
    requireProfile(ctx);
    if (running >= 3) throw new HttpError(429, 'Someone else is testing right now — try again in a moment.');
    const mb = Math.max(1, Math.min(50, parseInt(q.get('mb'), 10) || 8));
    running++;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': mb * RAND.length, 'Cache-Control': 'no-store', 'Content-Encoding': 'identity' });
    let sent = 0;
    const done = () => { if (running > 0 && !res._p5done) { res._p5done = true; running--; } };
    res.on('close', done);
    const pump = () => { while (sent < mb) { sent++; if (!res.write(RAND)) return res.once('drain', pump); } res.end(); done(); };
    pump();
  });
  route('POST', '/api/speedtest/up', async (req, res, p, q, ctx) => {
    requireProfile(ctx);
    const t0 = Date.now();
    let n = 0;
    const max = 30 * 1024 * 1024;
    await new Promise((resolve, reject) => {
      req.on('data', (c) => { n += c.length; if (n > max) { req.destroy(); reject(new HttpError(413, 'Too much')); } });
      req.on('end', resolve);
      req.on('error', reject);
    });
    return { bytes: n, ms: Math.max(1, Date.now() - t0) };
  });
  /** Something to test a provider with: a live channel (or a film) from that list. */
  const probeOf = (prof, listId) => {
    const cat = deps.catalog();
    const f = cat.filterFor(prof);
    const want = (it) => it.src === listId && it.u && /^https?:/i.test(it.u) && f.test(it);
    const it = cat.items.find((x) => x.t === 'live' && want(x)) || cat.items.find((x) => x.t === 'movie' && want(x));
    return it || null;
  };
  route('GET', '/api/speedtest/targets', (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    return lists.all().filter((l) => l.enabled && l.type !== 'folder' && l.type !== 'file').map((l) => {
      const it = probeOf(prof, l.id);
      if (!it) return null;
      const lim = deps.connLimit(it), used = (deps.listUsage().get(l.id) || []).length;
      return { id: l.id, name: l.name, k: it.k, u: it.u, kind: it.t, busy: lim > 0 && used >= lim, headers: !!(it.h && Object.keys(it.h).length) };
    }).filter(Boolean);
  });
  route('POST', '/api/speedtest/provider', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    gate(ctx);
    const b = await readJSON(req);
    const it = probeOf(prof, String(b.list || ''));
    if (!it) throw new HttpError(404, 'Nothing to test on that list.');
    const lim = deps.connLimit(it), used = (deps.listUsage().get(it.src) || []).length;
    if (lim > 0 && used >= lim) return { busy: true, error: 'Every connection to this provider is in use right now, so it can’t be tested without cutting someone off.' };
    return measure(it, deps.proxyHeaders(it));
  });
  /** Reads a short sample from the provider: time to first byte, then how fast it comes (≤ 6 s, ≤ 12 MB). */
  async function measure(it, headers) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12000);
    const t0 = Date.now();
    try {
      let url = it.u;
      let r = await deps.fetch(url, { headers, signal: ac.signal, redirect: 'follow' });
      const ct = r.headers.get('content-type') || '';
      if (r.ok && (/mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(url))) {
        // A playlist: follow it to the first (or best) stream, then to a segment.
        for (let hop = 0; hop < 2; hop++) {
          const text = await r.text();
          const lines = text.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
          if (!lines.length) break;
          const next = new URL(lines[lines.length > 3 && /\.ts|\.m4s|\.aac/i.test(lines[0]) ? lines.length - 2 : 0], r.url || url).href;
          url = next;
          r = await deps.fetch(url, { headers, signal: ac.signal, redirect: 'follow' });
          if (!/mpegurl/i.test(r.headers.get('content-type') || '') && !/\.m3u8(\?|$)/i.test(url)) break;
        }
      }
      const ttfb = Date.now() - t0;
      if (!r.ok) return { ok: false, error: `The provider said ${r.status}.`, ttfb };
      const reader = r.body.getReader();
      let n = 0;
      const t1 = Date.now();
      while (Date.now() - t1 < 6000 && n < 12 * 1024 * 1024) { const { done, value } = await reader.read(); if (done) break; n += value.length; }
      try { ac.abort(); } catch {}
      const secs = Math.max(0.2, (Date.now() - t1) / 1000);
      return { ok: true, ttfb, bytes: n, mbps: Math.round(((n * 8) / secs / 1e6) * 10) / 10, by: 'server' };
    } catch (e) {
      return { ok: false, error: ac.signal.aborted ? 'The provider was too slow to answer.' : `Couldn’t reach the provider (${(e.cause && e.cause.message) || e.message}).` };
    } finally { clearTimeout(timer); }
  }

  // ================================================================ events → webhooks
  const lastPlaying = new Map(); // conn → k
  function onPresence(c) {
    const was = lastPlaying.get(c.id) || null;
    const now = c.playing ? c.playing.k : null;
    if (was === now) return;
    const base = { profile: (accounts.profile(c.pid) || {}).name || '', device: c.deviceName || '', conn: c.id };
    const info = (k, playing) => { const it = deps.catalog().get(k); const hidden = playing && playing.hidden; return { k: hidden ? undefined : k, title: hidden ? undefined : (it ? it.n : (playing && playing.n) || ''), type: it ? it.t : '', hidden: !!hidden }; };
    if (was) hooks.emit('playback.stopped', { ...base, ...info(was, null) });
    if (now) hooks.emit('playback.started', { ...base, ...info(now, c.playing) });
    if (now) lastPlaying.set(c.id, now); else { lastPlaying.delete(c.id); live.delete(c.id); }
  }
  /** A device's live connection ended: playback stopped there (webhook), and its viewing reports go. */
  function onClose(c) {
    onPresence({ ...c, playing: null });
    lastPlaying.delete(c.id);
    live.delete(c.id);
  }
  function onSignIn(prof, sess) { hooks.emit('profile.signed_in', { profile: prof.name, device: (sess && sess.name) || '' }); }

  const fired = new Set();
  const listFail = new Map();
  const expirySent = new Map();
  setInterval(() => {
    const now = Date.now();
    // Reminders that have just come due.
    for (const prof of accounts.profiles) {
      let rems = [];
      try { rems = userdata.of(prof.id).data.reminders || []; } catch {}
      for (const r of rems) {
        const id = `${prof.id}:${r.k}:${r.s}`;
        if (r.s <= now + 30e3 && r.s > now - 120e3 && !fired.has(id)) {
          fired.add(id);
          const ch = deps.catalog().get(r.k);
          hooks.emit('reminder.due', { profile: prof.name, channel: ch ? ch.n : '', k: r.k, programme: r.t || '', starts: new Date(r.s).toISOString() });
        }
      }
    }
    if (fired.size > 5000) fired.clear();
    // Lists that failed to refresh (once per failure).
    for (const l of lists.all()) {
      const st = l.status || {};
      if (l.enabled && st.ok === false && st.error && st.at !== listFail.get(l.id)) { listFail.set(l.id, st.at); hooks.emit('list.failed', { list: l.name, id: l.id, error: st.error }); }
      if (st.ok) listFail.delete(l.id);
    }
    // Provider accounts running out (once a day per list).
    const today = new Date().toDateString();
    for (const a of deps.accountAlerts()) if (a.kind === 'expiry' && expirySent.get(a.id) !== today) { expirySent.set(a.id, today); hooks.emit('account.expiring', { list: a.list, id: a.id, days: a.days }); }
  }, 30e3).unref();

  // ================================================================ API for automations (Bearer keys)
  /** /api/v1/… — called before cookie sessions; returns true when it answered. */
  async function handleApi(req, res, pathname, q) {
    const key = keys.verify(req.headers.authorization, deps.clientIp(req));
    if (!key) throw new HttpError(401, 'A valid API key is needed: Authorization: Bearer <key> (Admin → API & automations).');
    const need = (scope) => { if (!ApiKeys.allows(key, scope)) throw new HttpError(403, `This key can’t do that (it’s “${key.scope}”).`); };
    const prof = key.profile ? accounts.profile(key.profile) : null;
    // A key made for a profile that has since been removed must not turn into a key for the whole household.
    if (key.profile && !prof) throw new HttpError(403, 'This key’s profile has been removed. Make a new key (Admin → API & automations).');
    const cat = deps.catalog();
    const vis = (k) => (prof ? cat.visible(prof, k) : cat.get(k));
    const conns = () => [...hub.conns].filter((c) => !prof || c.pid === prof.id);
    const devOut = (c) => ({ id: c.id, name: c.deviceName, profile: (accounts.profile(c.pid) || {}).name || '', playing: c.playing && !c.playing.hidden ? { k: c.playing.k, title: c.playing.n, since: new Date(c.playing.at).toISOString(), position: c.playing.pos || 0 } : null, connected: new Date(c.at).toISOString() });
    const body = async () => (req.method === 'POST' ? await readJSON(req) : {});
    let m;
    const send = (o) => { sendJSON(res, 200, o); return true; };
    if (req.method === 'GET' && pathname === '/api/v1/now') { need('read'); return send(conns().filter((c) => c.playing).map(devOut)); }
    if (req.method === 'GET' && pathname === '/api/v1/devices') { need('read'); return send(conns().map(devOut)); }
    if (req.method === 'GET' && pathname === '/api/v1/channels') {
      need('read');
      const f = prof ? cat.filterFor(prof) : null;
      return send(cat.items.filter((it) => (it.t === 'live' || it.t === 'radio') && (!f || f.test(it))).slice(0, 5000).map((it) => ({ k: it.k, name: it.n, number: it.num || null, group: it.g, type: it.t })));
    }
    if (req.method === 'GET' && pathname === '/api/v1/search') {
      need('read');
      const s = String(q.get('q') || '').trim().toLowerCase();
      if (s.length < 2) return send([]);
      const f = prof ? cat.filterFor(prof) : null;
      const hits = [];
      for (const it of cat.items) {
        if (it.t === 'episode' || (f && !f.test(it))) continue;
        const n = String(it.n).toLowerCase();
        const i = n.indexOf(s);
        if (i < 0) continue;
        hits.push([it, (i === 0 ? 0 : 1) + (n === s ? -1 : 0)]);
        if (hits.length > 400) break;
      }
      hits.sort((a, b) => a[1] - b[1]);
      return send(hits.slice(0, 25).map(([it]) => ({ k: it.k, title: it.n, type: it.t, year: it.y || null, number: it.num || null })));
    }
    if (req.method === 'GET' && pathname === '/api/v1/status') {
      need('admin');
      return send({ lists: lists.all().map((l) => ({ id: l.id, name: l.name, enabled: l.enabled, ok: l.status && l.status.ok, items: l.status && l.status.count, error: (l.status && l.status.error) || null, expires: l.account && l.account.expires ? new Date(l.account.expires).toISOString() : null })), alerts: deps.accountAlerts(), watching: [...hub.conns].filter((c) => c.playing).length });
    }
    if (req.method === 'POST' && (m = pathname.match(/^\/api\/v1\/lists\/([^/]+)\/refresh$/))) { need('admin'); await lists.refresh(m[1]); return send({ ok: true }); }
    if (req.method === 'POST' && (m = pathname.match(/^\/api\/v1\/devices\/([^/]+)\/(play|command)$/))) {
      need('control');
      const c = hub.conn(m[1]);
      if (!c || (prof && c.pid !== prof.id)) throw new HttpError(404, 'That device isn’t connected.');
      const b = await body();
      const owner = accounts.profile(c.pid);
      if (m[2] === 'play') {
        let it = b.k ? (prof ? cat.visible(prof, String(b.k)) : cat.get(String(b.k))) : null;
        if (!it && b.channel !== undefined) { const n = Number(b.channel); const f = owner ? cat.filterFor(owner) : null; it = cat.items.find((x) => x.t === 'live' && (n ? x.num === n : String(x.n).toLowerCase() === String(b.channel).toLowerCase()) && (!f || f.test(x))); }
        if (!it && b.title) { const s = String(b.title).toLowerCase(); const f = owner ? cat.filterFor(owner) : null; it = cat.items.find((x) => x.t !== 'episode' && String(x.n).toLowerCase() === s && (!f || f.test(x))); }
        if (!it || (owner && !cat.visible(owner, it.k))) throw new HttpError(404, 'Nothing like that to play on that device.');
        hub.send(c, 'command', { cmd: 'play', k: it.k, from: `API: ${key.name}`, pos: Number(b.position) || 0 });
        return send({ ok: true, playing: { k: it.k, title: it.n } });
      }
      const cmd = String(b.cmd || '');
      const allowed = ['pause', 'resume', 'toggle', 'stop', 'zap', 'channel', 'volume', 'mute', 'seek', 'skip', 'next', 'subs', 'sleep', 'live'];
      if (!allowed.includes(cmd) || !deps.COMMANDS.includes(cmd)) throw new HttpError(400, `Unknown command. One of: ${allowed.join(', ')}.`);
      const out = { cmd, from: `API: ${key.name}`, conn: '' };
      for (const k of ['pos', 'd', 'v', 'i', 'n', 'dir', 'min']) if (b[k] !== undefined) out[k] = Number(b[k]) || 0;
      if (typeof b.on === 'boolean') out.on = b.on;
      hub.send(c, 'command', out);
      return send({ ok: true });
    }
    if (req.method === 'GET' && (m = pathname.match(/^\/api\/v1\/items\/([^/]+)$/))) { need('read'); let k = m[1]; try { k = decodeURIComponent(k); } catch {} const it = vis(k); if (!it) throw new HttpError(404, 'Not found'); return send({ k: it.k, title: it.n, type: it.t, year: it.y || null, group: it.g, plot: it.plot || '' }); }
    throw new HttpError(404, 'No such API endpoint. See Admin → API & automations.');
  }

  return {
    handleApi, onPresence, onClose, onSignIn, hooks, keys, subs,
    publicFlags: () => ({ subtitles: subs.enabled(), opensubtitles: subs.enabled() }),
  };
};
module.exports.shiftVtt = shiftVtt;
