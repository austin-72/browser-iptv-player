'use strict';
/**
 * Subtitles made from a film's sound (lib/subgen.js), for when none can be found online:
 *
 *   GET    /api/subgen?k=          where things stand for a title, and whether this profile may ask
 *   POST   /api/subgen { k }       ask for them (they're made in the background; a note arrives when they're ready)
 *   DELETE /api/subgen?k=          stop a job (whoever asked, or the admin) or delete the finished ones (the admin)
 *   GET    /api/subgen/file/:id    the subtitles (WebVTT; ?offset= as for subtitles found online)
 *   GET    /api/admin/subgen       what was found on the server, for Admin → Integrations
 *
 * Who may ask is the admin's setting `subGen`: 'everyone' (the default), 'admin' or 'off'. Films and episodes only.
 *
 * deps: { route, requireProfile, requireAdmin, readJSON, HttpError, D, settings, item, inputOf, srcList, connLimit,
 *         listUsage, hub, media, hooks, relayExtra }
 */
const fs = require('fs');
const { SubGen } = require('./subgen');
const { shiftVtt } = require('./routes-p5');

module.exports = function p13(deps) {
  const { route, requireProfile, requireAdmin, readJSON, HttpError, D, settings, inputOf, srcList, connLimit, listUsage, hub, media, hooks } = deps;
  const connId = (id) => 'subs:' + id.slice(0, 12);
  const gen = new SubGen(D, {
    ffmpeg: () => ({ bin: media.ffmpegBin, available: media.available, netArgs: (input, headers) => media._netArgs(input, { headers }) }),
    connFree: (j) => {
      const limit = j.limit;
      if (!limit) return true;
      const users = (listUsage().get(j.list) || []).filter((c) => c.id !== connId(j.id));
      return users.length + (deps.relayExtra ? deps.relayExtra(j.list) || 0 : 0) < limit;
    },
    notify: (j, what) => {
      if (!j.pid) return;
      hub.toProfile(j.pid, 'notify', what === 'done'
        ? { kind: 'subs', title: `Subtitles for “${j.name}” are ready`, body: 'They’re in its Subtitles menu.', k: j.k }
        : { kind: 'subs', title: `Subtitles for “${j.name}” couldn’t be made`, body: j.err || '', k: j.k });
      hub.toProfile(j.pid, 'subgen', { k: j.k, state: what });
    },
  });
  gen.detect();
  process.on('exit', () => gen.stop());
  // While a job reads a film from a provider it's one of that provider's "viewers" (it holds a connection), like a
  // recording: listed with whoever is watching, and never taken over.
  const prev = hooks.dvrConns;
  hooks.dvrConns = () => [...(prev ? prev() : []), ...gen.reading().map((j) => ({ id: connId(j.id), pid: j.pid, deviceName: 'Making subtitles', playing: { k: j.k, n: j.name, at: j.at }, rec: true }))];

  const mode = () => { const m = settings().subGen; return m === 'admin' || m === 'off' ? m : 'everyone'; };
  const may = (prof) => gen.available && !prof.guest && (mode() === 'everyone' || (mode() === 'admin' && !!prof.admin));
  const filmOf = (ctx, k) => {
    const it = deps.item(ctx, String(k || ''));
    if (it.t !== 'movie' && it.t !== 'episode') throw new HttpError(400, 'Subtitles can be made for films and episodes.');
    return it;
  };
  const view = (prof, it) => {
    const s = gen.status(it.k);
    const out = { can: may(prof), state: s.state, pct: s.pct || 0, secs: s.secs || 0, ahead: s.ahead || 0, err: s.err || '', mine: !s.pid || s.pid === prof.id };
    if (s.state === 'done') { out.url = `/api/subgen/file/${s.id}`; out.lang = s.lang || ''; out.at = s.at; }
    return out;
  };

  route('GET', '/api/subgen', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); return view(prof, filmOf(ctx, q.get('k'))); });
  route('POST', '/api/subgen', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const b = await readJSON(req);
    const it = filmOf(ctx, b && b.k);
    if (!gen.available) throw new HttpError(400, 'This server can’t make subtitles (no speech-to-text program is set up).');
    if (!may(prof)) throw new HttpError(403, mode() === 'off' ? 'Making subtitles is turned off on this server.' : 'Only the admin can have subtitles made on this server.');
    if (gen.status(it.k).state === 'done') return view(prof, it);
    const src = inputOf(it, -1);
    if (!src) throw new HttpError(404, 'That title isn’t here any more.');
    const show = it.t === 'episode' && it.sk ? deps.catalog().get(it.sk) : null;
    const name = show ? `${show.n} S${it.s || '?'}E${it.e || '?'}` : it.n;
    gen.start({ k: it.k, name, input: src.input, headers: src.headers || {}, local: !!src.local, pid: prof.id, list: src.local ? '' : srcList(it, -1), limit: src.local ? 0 : connLimit(it, -1) });
    return view(prof, it);
  });
  route('DELETE', '/api/subgen', (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const it = filmOf(ctx, q.get('k'));
    const s = gen.status(it.k);
    if (s.state === 'none') return { ok: true };
    // (A job: whoever asked for it, or the admin. Finished ones are everyone's, so only the admin deletes them.)
    if (!prof.admin && (s.state === 'done' || (s.pid && s.pid !== prof.id))) throw new HttpError(403, 'Only the admin can do that.');
    gen.remove(it.k);
    return { ok: true };
  });
  route('GET', '/api/subgen/file/:id', (req, res, p, q, ctx) => {
    requireProfile(ctx);
    const f = gen.fileById(p.id);
    if (!f) throw new HttpError(404, 'Not made yet');
    let body = fs.readFileSync(f);
    const off = Number(q.get('offset')) || 0;
    if (off > 0) body = Buffer.from(shiftVtt(body.toString('utf8'), -off));
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'private, max-age=3600' });
    res.end(body);
  });
  route('GET', '/api/admin/subgen', (req, res, p, q, ctx) => { requireAdmin(ctx); if (q.get('again') === '1') gen.detect(); return { ...gen.info(), mode: mode(), ffmpeg: media.available }; });

  return { subgen: gen, publicFlags: () => ({ subGen: gen.available && media.available && mode() !== 'off' ? mode() : '' }) };
};
