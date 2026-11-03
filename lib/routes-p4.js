'use strict';
/**
 * Routes for: Stalker portals (play addresses), "My channels" (24/7 channels), and the outputs for other apps
 * (Xtream Codes login per profile, HDHomeRun tuner). Registered from server.js with the server's own helpers.
 */
const path = require('path');
const { MyChannels } = require('./mychannels');
const { Outputs } = require('./outputs');

module.exports = function setupP4(d) {
  const { route, requireProfile, requireAdmin, readJSON, HttpError, catalog, lists, accounts } = d;

  // ---------------------------------------------------------------- Stalker portals: play addresses
  // /api/proxy/stalker/<list>/<live|vod|ep>/<id> → asks the portal for the stream's address just now, and redirects.
  // (Under /api/proxy so a signed cast link — and ffmpeg on this machine — can open it too.)
  route('GET', '/api/proxy/stalker/:list/:kind/:id', async (req, res, p) => {
    if (!['live', 'vod', 'ep'].includes(p.kind)) throw new HttpError(404, 'Not found');
    const url = await lists.stalkerLink(p.list, p.kind, decodeURIComponent(p.id));
    res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
    res.end();
  }, 'site');

  // ---------------------------------------------------------------- My channels
  const mych = new MyChannels({ dir: d.dataDir, catalog, lists, tmdb: d.tmdb, getSettings: d.settings, profiles: () => accounts.profiles });
  mych.register();
  // The shared guide names only what every profile watching may see: made again when a profile's restrictions change.
  let profSig = null;
  const profWatch = setInterval(() => {
    const sig = JSON.stringify((accounts.profiles || []).map((x) => [x.id, !!x.kids, x.restrictions || null]));
    if (profSig !== null && sig !== profSig) mych.refreshGuide();
    profSig = sig;
  }, 60e3);
  if (profWatch.unref) profWatch.unref();
  // Rebuilt once a day (new episodes, films that left the provider), quietly, outside the busy evening.
  const daily = setInterval(() => { if (new Date().getHours() === 4) mych.rebuildAll().catch(() => {}); }, 3600e3);
  if (daily.unref) daily.unref();

  route('GET', '/api/admin/mychannels', (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    return { channels: mych.all().map((c) => mych.view(c)), options: mych.options() };
  });
  route('GET', '/api/admin/mychannels/titles', (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const s = String(q.get('q') || '').trim().toLowerCase();
    if (s.length < 2) return [];
    const out = [];
    for (const it of catalog.items) {
      if ((it.t === 'movie' || it.t === 'show') && it.n.toLowerCase().includes(s)) out.push({ k: it.k, n: it.n, t: it.t, y: it.y || 0, i: it.poster || it.logo || '' });
      if (out.length >= 30) break;
    }
    return out;
  });
  route('POST', '/api/admin/mychannels', async (req, res, p, q, ctx) => { requireAdmin(ctx); return mych.create(await readJSON(req)); });
  route('PUT', '/api/admin/mychannels/:id', async (req, res, p, q, ctx) => { requireAdmin(ctx); return mych.update(p.id, await readJSON(req)); });
  route('DELETE', '/api/admin/mychannels/:id', (req, res, p, q, ctx) => { requireAdmin(ctx); mych.remove(p.id); return { ok: true }; });
  route('GET', '/api/mychannels/:id/now', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    // (Only a channel this profile has in its catalogue.)
    const chan = catalog.items.find((x) => x.u === `mych:${p.id}`);
    if (chan && !catalog.visible(prof, chan.k)) throw new HttpError(404, 'Channel not found');
    const visible = (it) => !!catalog.visible(prof, it.k);
    const r = await mych.now(p.id, visible, Number(q.get('t')) || Date.now());
    const pack = (it) => (it ? { ...d.Catalog.compact(it), plot: (it.plot || '').slice(0, 400) } : null);
    return { channel: r.channel, item: pack(r.item), offset: Math.round(r.offset), start: r.start, end: r.end, next: pack(r.next) };
  });
  route('GET', '/api/mychannels/:id/logo.svg', async (req, res, p) => {
    const svg = await mych.logo(p.id);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400', 'Content-Length': svg.length });
    res.end(svg);
  }, 'site');

  // ---------------------------------------------------------------- outputs for other apps
  const outputs = new Outputs({
    dir: d.dataDir, catalog, lists, accounts, epg: d.epg, settings: d.settings, media: d.media, clientIp: d.clientIp,
    ready: () => d.ready() || Promise.resolve(),
    hiddenFor: (pid) => { try { return new Set(d.userdata.of(pid).data.hidden || []); } catch { return new Set(); } },
    inputOf: d.inputOf,
    relayPath: (url, h) => d.castSign(d.proxy.sign(url, { h }), 12),
    loopbackBase: d.loopbackBase,
    videoViaProxy: d.videoViaProxy,
    connLimit: d.connLimit,
    // (Plus the connections the stream relay uses for that list beyond the one its films count as, once server.js
    // passes relayExtra: relayFinished.extra.)
    usage: (listId) => (d.listUsage().get(listId) || []).length + (d.relayExtra ? d.relayExtra(listId) || 0 : 0),
    serveLocal: (req, res, it) => { const li = lists.libraryItem(it.loc.list, it.loc.id); if (!li) throw new HttpError(404, 'Not found'); return d.serveFile(req, res, li.path); },
  });

  route('GET', '/api/admin/outputs', (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const v = outputs.view(req.headers.host);
    v.profiles = accounts.profiles.map((x) => ({ id: x.id, name: x.name, avatar: x.avatar, kids: !!x.kids, admin: !!x.admin }));
    return v;
  });
  route('PUT', '/api/admin/outputs', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    outputs.update(await readJSON(req));
    return outputs.view(req.headers.host);
  });
  route('POST', '/api/admin/outputs/logins/:pid', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const b = await readJSON(req);
    return outputs.setLogin(p.pid, b.password || '');
  });
  route('DELETE', '/api/admin/outputs/logins/:pid', (req, res, p, q, ctx) => { requireAdmin(ctx); outputs.removeLogin(p.pid); return { ok: true }; });

  return {
    mych, outputs,
    /** The outputs' own addresses (/player_api.php, /live/…, /discover.json…): true when handled. */
    handle: (req, res, pathname, q) => outputs.handle(req, res, pathname, q),
    /** May the relay fetch this address for this item? (A portal's stream addresses come from create_link.) */
    relayable: (it, url) => {
      if (!/^\/api\/proxy\/stalker\//.test(it.u || '') && !(it.alts || []).some((a) => /^\/api\/proxy\/stalker\//.test(a.u || ''))) return false;
      try { return lists.stalker.linkHosts.has(new URL(url).host); } catch { return false; }
    },
    /** In-app-only entries (24/7 channels) are left out of the exported playlist and guide. */
    exportable: (it) => !/^mych:/.test(it.u || ''),
    path,
  };
};
