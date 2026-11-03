'use strict';
/**
 * The DVR's routes (lib/dvr.js does the recording) and its links into the rest of the server: recordings play like
 * the server's own files ("rec:<id>" items, files under the "dvr" library), a running recording counts as a viewer of
 * its channel's provider connection, and who may record follows Admin → DVR. Registered from server.js with one line.
 */
const { Dvr } = require('./dvr');
const { HttpError } = require('./util');

/**
 * deps: { route, requireProfile, requireAdmin, readJSON, D, catalog(), epg, chanShift, inputOf, srcList, connLimit,
 *         listUsage, accounts, hub, media, lists, hooks }
 */
module.exports = function p12(deps) {
  const { route, requireProfile, requireAdmin, readJSON, D, epg, chanShift, inputOf, srcList, connLimit, listUsage, accounts, hub, media, lists, hooks } = deps;
  const cat = () => deps.catalog();
  const isChannel = (it) => !!it && (it.t === 'live' || it.t === 'radio');
  // A running recording's "viewer" id: not its own id (other profiles see who's using a connection).
  const connId = (recId) => 'dvr:' + require('crypto').createHash('sha256').update('dvr-conn:' + recId).digest('hex').slice(0, 12);

  const allowedProfile = (prof) => {
    if (!prof) return false;
    const a = dvr.cfg.access;
    if (a === 'off') return false;
    if (a === 'priority') return !!(prof.priority || prof.admin);
    return true;
  };
  const programmes = (k, from, to) => {
    const it = cat().get(k);
    if (!it || !it.epg) return [];
    const sh = chanShift(it);
    return epg.range(it.epg, from - sh, to - sh).map((x) => ({ s: x.s + sh, e: x.e + sh, t: x.t, st: x.st || '', ep: x.ep || '', d: x.d || '' }));
  };

  const dvr = new Dvr(D, {
    ffmpeg: () => ({ bin: media.ffmpegBin, available: media.available, netArgs: (input, headers) => media._netArgs(input, { headers }) }),
    source: (k) => {
      const it = cat().get(k);
      if (!isChannel(it)) return null;
      const src = inputOf(it, -1);
      return src && !src.local ? { input: src.input, headers: src.headers || {}, list: srcList(it, -1), name: it.n } : null;
    },
    programmes,
    allowed: (pid) => allowedProfile(accounts.profile(pid)),
    connFree: (k, recId) => {
      const it = cat().get(k);
      if (!it) return false;
      const limit = connLimit(it, -1);
      if (!limit) return true;
      const lid = srcList(it, -1);
      const users = (listUsage().get(lid) || []).filter((c) => c.id !== connId(recId));
      // (The stream relay's connections beyond the one its films count as, once server.js passes relayExtra.)
      return users.length + (deps.relayExtra ? deps.relayExtra(lid) || 0 : 0) < limit;
    },
    notify: (pid, r, what) => { for (const c of hub.conns) if (c.pid === pid) hub.send(c, 'dvr', { what, id: r.id, t: r.t, err: r.err || '' }); },
  });

  // ------------------------------------------------------------ links into the rest of the server
  // Running recordings are "viewers" of their channel (they hold a provider connection; nobody can bump them).
  hooks.dvrConns = () => dvr.running().map((r) => ({ id: connId(r.id), pid: r.pid, deviceName: 'Recording', playing: { k: r.k, n: r.t, at: r.started }, rec: true }));
  // "rec:<id>": a finished recording, played like the server's own files.
  hooks.dvrItem = (prof, k) => {
    const r = dvr.find(k.slice(4));
    if (!r || (r.pid !== prof.id && !prof.admin)) throw new HttpError(404, 'That recording isn’t here any more.');
    if (r.state !== 'done') throw new HttpError(409, 'It’s still being recorded.');
    return { k, t: 'movie', n: r.t, u: `local:dvr:${r.id}`, loc: { list: 'dvr', id: r.id }, src: '', g: 'Recordings' };
  };
  // A recording's file: only for its own profile (and the admin).
  hooks.dvrOwnerOk = (prof, id) => { const r = dvr.find(id); return !!r && !!prof && (prof.admin || r.pid === prof.id); };
  // The server stopping or restarting (any way): end the recorders, which carry on after the restart.
  process.on('exit', () => dvr.stop());
  const libraryItem = lists.libraryItem.bind(lists);
  lists.libraryItem = (listId, id) => (listId === 'dvr' ? dvr.fileOf(id) : libraryItem(listId, id));

  // ------------------------------------------------------------ what devices see
  const canRecord = (prof) => {
    if (allowedProfile(prof)) return;
    throw new HttpError(403, dvr.cfg.access === 'off' ? 'Recording is turned off (Admin → DVR).' : 'Only priority profiles can record (Admin → DVR).');
  };
  const nameOf = (pid) => (accounts.profile(pid) || {}).name || '';
  const listFor = (prof) => {
    const recs = prof.admin ? dvr.store.data.recs : dvr.of(prof.id);
    return recs.filter((r) => r.state !== 'cancelled' && r.state !== 'skipped').map((r) => ({ ...dvr.view(r), who: r.pid !== prof.id ? nameOf(r.pid) : '' }));
  };
  const channelOf = (ctx, k) => {
    const it = deps.item(ctx, String(k || ''));
    if (!isChannel(it)) throw new HttpError(400, 'Only TV and radio channels can be recorded.');
    return it;
  };

  route('GET', '/api/dvr', (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const rules = (prof.admin ? dvr.store.data.rules : dvr.rulesOf(prof.id)).map((x) => ({ id: x.id, k: x.k, ch: x.ch, t: x.t, who: x.pid !== prof.id ? nameOf(x.pid) : '' }));
    return { can: allowedProfile(prof), access: dvr.cfg.access, ffmpeg: media.available, recs: listFor(prof), rules, pre: dvr.cfg.pre, post: dvr.cfg.post };
  });
  // Record one programme: { k, s, e, t, st?, ep?, d? } (times as the device shows them).
  route('POST', '/api/dvr/record', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    canRecord(prof);
    media.requireFfmpeg();
    const b = await readJSON(req);
    const it = channelOf(ctx, b.k);
    const r = dvr.add(prof.id, { k: it.k, ch: it.n, s: b.s, e: b.e, t: b.t, st: b.st, ep: b.ep, d: b.d });
    return dvr.view(r);
  });
  // Record what's on now (until it ends; an hour when the channel has no guide).
  route('POST', '/api/dvr/now', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    canRecord(prof);
    media.requireFfmpeg();
    const b = await readJSON(req);
    const it = channelOf(ctx, b.k);
    // Already recording this channel (the guide may have moved the programme's times since): that one.
    const on = dvr.running().find((r) => r.k === it.k && r.pid === prof.id);
    if (on) return dvr.view(on);
    const now = Date.now();
    const cur = programmes(it.k, now - 1000, now + 1000).find((x) => x.s <= now && x.e > now);
    const mins = Math.max(5, Math.min(720, Number(b.minutes) || 60));
    // (Guide entries of a whole day, or that began long ago: record from now, for at most 12 hours.)
    const s0 = cur && (cur.e - cur.s > 12 * 3600e3 - 60e3 || now - cur.s > 6 * 3600e3) ? now : cur && cur.s;
    const r = cur
      ? dvr.add(prof.id, { k: it.k, ch: it.n, s: s0, e: Math.min(cur.e, s0 + 12 * 3600e3 - 60e3), t: cur.t, st: cur.st, ep: cur.ep, d: cur.d })
      : dvr.add(prof.id, { k: it.k, ch: it.n, s: now, e: now + mins * 60e3, t: it.n });
    return dvr.view(r);
  });
  // Record every episode: { k, t }.
  route('POST', '/api/dvr/series', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    canRecord(prof);
    media.requireFfmpeg();
    const b = await readJSON(req);
    const it = channelOf(ctx, b.k);
    const rule = dvr.addRule(prof.id, { k: it.k, ch: it.n, t: b.t });
    return { id: rule.id, k: rule.k, ch: rule.ch, t: rule.t, recs: listFor(prof).filter((r) => r.rule === rule.id).length };
  });
  route('DELETE', '/api/dvr/rules/:id', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); dvr.removeRule(prof.id, p.id, !!prof.admin); return { ok: true }; });
  route('POST', '/api/dvr/:id/stop', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); return dvr.view(dvr.stopNow(prof.id, p.id, !!prof.admin)); });
  route('PUT', '/api/dvr/:id', async (req, res, p, q, ctx) => { const prof = requireProfile(ctx); const b = await readJSON(req); return dvr.view(dvr.setKeep(prof.id, p.id, !!b.keep, !!prof.admin)); });
  route('DELETE', '/api/dvr/:id', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); dvr.remove(prof.id, p.id, !!prof.admin); return { ok: true }; });

  // ------------------------------------------------------------ Admin → DVR
  const adminView = () => ({ config: dvr.cfg, defaultDir: require('path').join(D, 'recordings'), usage: dvr.usage(), ffmpeg: media.available, running: dvr.running().length, scheduled: dvr.store.data.recs.filter((r) => r.state === 'scheduled' || r.state === 'waiting').length });
  route('GET', '/api/admin/dvr', (req, res, p, q, ctx) => { requireAdmin(ctx); return adminView(); });
  route('PUT', '/api/admin/dvr', async (req, res, p, q, ctx) => { requireAdmin(ctx); dvr.setConfig(await readJSON(req)); return adminView(); });

  return { dvr };
};
