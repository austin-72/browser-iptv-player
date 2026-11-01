#!/usr/bin/env node
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable } = require('stream');

const cfg = require('./lib/config');
const { JsonFile } = require('./lib/store');
const { Epg } = require('./lib/epg');
const { Media } = require('./lib/media');
const { Proxy } = require('./lib/proxy');
const { Reach } = require('./lib/reach');
const { zipFolder } = require('./lib/zip');
const { Stats } = require('./lib/stats');
const { fetchAny } = require('./lib/net');
const { Lists } = require('./lib/lists');
const { Catalog, genresOf } = require('./lib/catalog');
const { Accounts } = require('./lib/accounts');
const { UserData } = require('./lib/userdata');
const { Hub, Social } = require('./lib/social');
const { Tmdb } = require('./lib/tmdb');
const { Recs } = require('./lib/recs');
const { Markers } = require('./lib/markers');
const P = require('./lib/parse');
const { xmlEsc, fmtTime } = require('./lib/xmltv');
const { HttpError, sendJSON, sendText, readBody, readJSON, isUrl, clampInt, log } = require('./lib/util');

let L = { names: {}, list: () => [] };
try { L = require('./lib/langs'); } catch {}

// ---------------------------------------------------------------- storage & settings
const D = cfg.dataDir;
fs.mkdirSync(D, { recursive: true });
const preset = cfg.presets || {};
const DEFAULT_SETTINGS = {
  brand: { name: (preset.brand && preset.brand.name) || 'IPTV Player', logo: (preset.brand && preset.brand.logo) || '', accent: (preset.brand && preset.brand.accent) || '' },
  userAgent: 'VLC/3.0.21 LibVLC/3.0.21',
  routing: 'direct-first', // 'direct-first' | 'server' | 'direct-only'
  defaultLangs: Array.isArray(preset.defaultLangs) ? preset.defaultLangs : [],
  showUnknownLang: true,
  hiddenGroups: [], hiddenKeys: [],
  epgDays: 7, epgPastDays: 7, epgRefreshHours: 12,
  transcodePreset: 'veryfast', transcodeCrf: 22, transcodeMaxHeight: 1080, maxTranscodes: 3, maxSessions: 10, remuxReadrate: 0, hwaccel: '',
  tmdbKey: '', introDetection: true,
  adminOnlyProfiles: false, allowDownloads: true, allowParties: true,
  exportKey: crypto.randomBytes(12).toString('hex'),
  allowedHosts: [],
};
const settingsStore = new JsonFile(path.join(D, 'settings.json'), DEFAULT_SETTINGS);
const settings = () => settingsStore.data;
const defaultPassword = process.env.SITE_PASSWORD || preset.sitePassword || 'changeme';

const media = new Media(cfg, D, settings);
const proxy = new Proxy(settings);
const reach = new Reach(proxy);
const stats = new Stats(D);
proxy.onBytes = (split, n) => stats.bytes(split ? 'split' : 'relay', n);
/** Count what a response sends (for Admin → Statistics). */
function countBytes(res, kind) {
  let n = 0;
  const w = res.write, e = res.end;
  res.write = function (c, ...a) { if (c && typeof c !== 'function') n += c.length || 0; return w.call(this, c, ...a); };
  res.end = function (c, ...a) { if (c && typeof c !== 'function') n += c.length || 0; return e.call(this, c, ...a); };
  res.once('close', () => stats.bytes(kind, n));
}
const accounts = new Accounts(D, { defaultPassword });
const userdata = new UserData(path.join(D, 'users'));
const hub = new Hub();
const social = new Social(D, { hub, accounts });
const epg = new Epg(path.join(D, 'epg'));
let catalog;
let rebuildTimer = null;
const scheduleRebuild = (ms = 1500) => { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(rebuildCatalog, ms); };
const lists = new Lists({
  dir: path.join(D, 'lists'), media, getSettings: settings,
  onChange: () => scheduleRebuild(),
  onGuides: (what, id, data) => {
    if (what === 'data') epg.setSource(id, data);
    else if (what === 'removed') epg.removeSource(id);
    epg.setOrder(lists.guides().filter((g) => g.enabled).map((g) => g.id));
    for (const sid of epg.sources.keys()) if (!lists.guides().some((g) => g.id === sid && g.enabled)) epg.removeSource(sid);
  },
});
catalog = new Catalog({ lists, epg, getSettings: settings });
const tmdb = new Tmdb({ dataDir: D, getKey: () => settings().tmdbKey, base: cfg.tmdbBase });
const recs = new Recs({ dir: path.join(D, 'users'), catalog, userdata, accounts, tmdb });

function applyMeta(it, m) {
  if (!m) return;
  // TMDB's genres are the consistent ones (the provider's vary from category to category).
  if (m.gn && m.gn.length) it.gn = genresOf(m.gn);
  for (const k of ['plot', 'cast', 'dir', 'bd', 'c', 'tmdb']) if (!it[k] && m[k] && (!Array.isArray(m[k]) || m[k].length)) it[k] = m[k];
  if (!it.y && m.y) it.y = m.y;
  if (!it.r && m.r) it.r = m.r;
  if (!it.d && m.d) it.d = m.d;
  if (!it.logo && m.poster) it.logo = m.poster;
  if (m.poster) it.poster = m.poster;
}
function rebuildCatalog() {
  catalog.build();
  const meta = tmdb.meta.data.m;
  for (const it of catalog.items) applyMeta(it, meta[it.k]);
  catalog.cache.clear();
  hub.toAll('catalog', { version: catalog.version });
  // New titles: look them up on TMDB in the background (a minute later, so start-up stays quick).
  clearTimeout(rebuildCatalog.enrichTimer);
  rebuildCatalog.enrichTimer = setTimeout(() => { try { startEnrich(true); } catch (e) { log('TMDB:', e.message); } }, 60e3);
}
epg.onChange = () => { if (catalog && catalog.epgChanged()) hub.toAll('catalog', { version: catalog.version }); };

/** What ffmpeg should open for an item: a local file or the stream address with its headers. */
function inputOf(it, alt = -1, overrideUrl = '') {
  if (it.loc) {
    const li = lists.libraryItem(it.loc.list, it.loc.id);
    return li ? { input: li.path, headers: {}, local: li } : null;
  }
  const a = alt >= 0 && it.alts && it.alts[alt] ? it.alts[alt] : { u: it.u, h: it.h };
  const u = overrideUrl || a.u;
  // Playlist entries can name files on the server itself (file:// or a plain path).
  if (/^file:/i.test(u)) {
    let file = null;
    try { file = require('url').fileURLToPath(u); } catch {}
    if (!file || !LOCAL_MEDIA.test(file) || !fs.existsSync(file)) return null;
    return { input: file, headers: {}, local: { path: file } };
  }
  return { input: u, headers: a.h || {} };
}
/**
 * How many connections the provider account behind an item allows at once (0 = unknown / no limit).
 * Accounts that allow only one must never get a second connection from this server while someone watches —
 * the provider would refuse it or, worse, cut the viewer off.
 */
function connLimit(it, alt = -1) {
  const id = alt >= 0 && it.alts && it.alts[alt] ? it.alts[alt].l : it.src;
  const l = id && lists.store.data.lists.find((x) => x.id === id);
  const n = parseInt(l && l.account && l.account.maxConnections, 10);
  return n > 0 ? n : 0;
}
const oneConnection = (it, alt = -1) => connLimit(it, alt) === 1;
function listFormats(it, alt = -1) {
  const id = alt >= 0 && it.alts && it.alts[alt] ? it.alts[alt].l : it.src;
  const l = id && lists.store.data.lists.find((x) => x.id === id);
  return (l && l.account && l.account.formats) || [];
}
const markers = new Markers({ dataDir: D, catalog, media, inputOf: (e) => inputOf(e), allowed: (e) => { const n = connLimit(e); return n === 0 || n >= 3; } }); // it reads 2 episodes at once
markers.enabled = () => settings().introDetection !== false;

// node server.js --set-password 'new password'
const pwArg = process.argv.indexOf('--set-password');
if (pwArg > 0) {
  try { accounts.setSitePassword(process.argv[pwArg + 1]); JsonFile.flushAll(); accounts.store.flush(); console.log('Site password changed. Every device has been signed out.'); process.exit(0); } catch (e) { console.error(e.message); process.exit(1); }
}

// ---------------------------------------------------------------- helpers
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.ts': 'video/mp2t', '.m3u8': 'application/vnd.apple.mpegurl',
};

function serveFile(req, res, file, { type, download, cache, headers: extra } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { throw new HttpError(404, 'File not found'); }
  if (!st.isFile()) throw new HttpError(404, 'File not found');
  const headers = {
    'Content-Type': type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Cache-Control': cache || 'no-cache', 'Last-Modified': st.mtime.toUTCString(), ...(extra || {}),
  };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(typeof download === 'string' ? download : path.basename(file))}`;
  const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
  if (range && st.size) {
    let start = range[1] === '' ? st.size - parseInt(range[2], 10) : parseInt(range[1], 10);
    let end = range[1] !== '' && range[2] !== '' ? parseInt(range[2], 10) : st.size - 1;
    start = Math.max(0, start); end = Math.min(end, st.size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function sendGz(req, res, raw, gz, type, etag) {
  if (etag && req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
  const h = { 'Content-Type': type, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
  if (etag) h.ETag = etag;
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(200, { ...h, 'Content-Encoding': 'gzip', 'Content-Length': gz.length }); return res.end(gz); }
  res.writeHead(200, { ...h, 'Content-Length': raw.length });
  res.end(raw);
}
function sendJsonGz(req, res, obj) {
  const raw = Buffer.from(JSON.stringify(obj));
  if (raw.length < 2048) return sendJSON(res, 200, obj);
  sendGz(req, res, raw, zlib.gzipSync(raw, { level: 5 }), 'application/json; charset=utf-8');
}

const LOCAL_MEDIA = /\.(mp4|m4v|mkv|avi|mov|webm|wmv|flv|mpg|mpeg|ts|m2ts|mts|vob|3gp|ogv|divx|mp3|m4a|aac|flac|ogg|oga|opus|wav|wma|asf|rm|rmvb)$/i;
const NATIVE_EXT = /\.(mp4|m4v|webm|mp3|m4a|aac|flac|ogg|oga|opus|wav)$/i;
const secureReq = (req) => !!req.socket.encrypted || (cfg.trustProxy && /^https/i.test(req.headers['x-forwarded-proto'] || ''));
const clientIp = (req) => (cfg.trustProxy && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';

function requireProfile(ctx) {
  if (!ctx.profile) throw new HttpError(403, 'Choose a profile first.');
  return ctx.profile;
}
function requireAdmin(ctx) {
  const p = requireProfile(ctx);
  if (!p.admin) throw new HttpError(403, 'Only the admin can do that.');
  return p;
}
function item(ctx, k) {
  const p = requireProfile(ctx);
  const it = catalog.visible(p, k);
  if (!it) throw new HttpError(404, 'That isn’t available.');
  return it;
}
function publicSettings() {
  const s = settings();
  return {
    brand: s.brand, routing: s.routing, allowDownloads: s.allowDownloads !== false, allowParties: s.allowParties !== false,
    ffmpeg: media.available, tmdb: !!s.tmdbKey, version: cfg.version, defaultLangs: s.defaultLangs, showUnknownLang: s.showUnknownLang !== false,
    langNames: L.names || {}, introDetection: s.introDetection !== false && !!markers.detector,
  };
}

// ---------------------------------------------------------------- routes
const routes = [];
const route = (method, pattern, handler, level = 'profile') => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, level });
};

// ---- sign in (site password)
route('POST', '/api/login', async (req, res) => {
  const { password } = await readJSON(req);
  const token = accounts.login(password, clientIp(req), req.headers['user-agent']);
  res.setHeader('Set-Cookie', accounts.cookie(token, secureReq(req)));
  return { ok: true };
}, 'public');
route('POST', '/api/logout', (req, res) => {
  accounts.logout(req);
  res.setHeader('Set-Cookie', accounts.clearCookie());
  return { ok: true };
}, 'site');

// ---- profiles
route('GET', '/api/boot', (req, res, p, q, ctx) => ({
  ...publicSettings(),
  profiles: accounts.profiles.map((x) => accounts.summary(x)),
  // Open straight into this device's profile when nothing has to be asked (no PIN, or it's remembered here).
  current: (accounts.resumable(ctx.sess) || {}).id || null,
  last: ctx.sess.profileId || null,
  device: ctx.sess.name,
  firstRun: accounts.profiles.length === 0,
  defaultPassword: accounts.d.site.isDefault,
  languages: L.list ? L.list() : [],
}), 'site');
route('POST', '/api/profiles', async (req, res, p, q, ctx) => {
  const b = await readJSON(req);
  const prof = accounts.create(b, ctx.sess, settings());
  if (accounts.profiles.length === 1) { accounts.select(ctx.sess, prof.id, String(b.pin || '')); }
  hub.toAll('profiles', {});
  return accounts.summary(prof);
}, 'site');
route('POST', '/api/profiles/:id/select', async (req, res, p, q, ctx) => {
  const { pin, remember } = await readJSON(req);
  const prof = accounts.select(ctx.sess, p.id, pin === undefined ? undefined : String(pin), remember !== false);
  return { ok: true, profile: accounts.view(prof) };
}, 'site');
route('POST', '/api/profiles/leave', async (req, res, p, q, ctx) => {
  const b = await readJSON(req).catch(() => ({}));
  if (b && b.lock) accounts.lock(ctx.sess); else { ctx.sess.profileId = null; accounts.store.save(); }
  return { ok: true };
}, 'site');

// ---- me
route('GET', '/api/me', (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  sendJsonGz(req, res, { profile: accounts.view(prof), data: userdata.snapshot(prof.id), settings: publicSettings(), unread: social.unread(prof.id), catalogVersion: catalog.version });
});
route('PUT', '/api/me', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readJSON(req);
  const allowed = ['name', 'avatar', 'langs', 'unknownLang', 'interests', 'pin', 'currentPin'];
  const patch = Object.fromEntries(Object.entries(b).filter(([k]) => allowed.includes(k)));
  if (prof.kids && ('langs' in patch || 'unknownLang' in patch) && !prof.admin) { /* kids may still choose languages */ }
  accounts.update(prof.id, patch, { self: true });
  if ('langs' in patch || 'unknownLang' in patch || 'interests' in patch) recs.touch(prof.id, 2000);
  hub.toAll('profiles', {});
  return accounts.view(prof);
});
// Profile photos: stored as data/avatars/<profile id>.jpg (sent already shrunk to a square JPEG by the app).
const AVATARS = path.join(D, 'avatars');
route('PUT', '/api/me/avatar', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const { image } = await readJSON(req);
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
  if (!m) throw new HttpError(400, 'Send a JPG, PNG or WebP picture.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 400e3) throw new HttpError(413, 'That picture is too big.');
  const ok = (m[1] === 'jpeg' && buf[0] === 0xff && buf[1] === 0xd8) || (m[1] === 'png' && buf[1] === 0x50) || (m[1] === 'webp' && buf.slice(8, 12).toString() === 'WEBP');
  if (!ok) throw new HttpError(400, 'That isn’t a picture.');
  fs.mkdirSync(AVATARS, { recursive: true });
  fs.writeFileSync(path.join(AVATARS, prof.id + '.img'), buf);
  accounts.setAvatar(prof.id, `img:${prof.id}:${Date.now().toString(36)}`);
  hub.toAll('profiles', {});
  return accounts.view(accounts.profile(prof.id));
});
route('GET', '/api/avatar/:pid', (req, res, p) => {
  const file = path.join(AVATARS, String(p.pid).replace(/[^a-z0-9]/gi, '') + '.img');
  if (!fs.existsSync(file)) throw new HttpError(404, 'No picture');
  const buf = fs.readFileSync(file);
  const type = buf[0] === 0x89 ? 'image/png' : buf.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/jpeg';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.end(buf);
}, 'site');
route('PUT', '/api/me/prefs', async (req, res, p, q, ctx) => { const prof = requireProfile(ctx); const r = userdata.setPrefs(prof.id, await readJSON(req)); changed(ctx, prof, 'prefs'); return r; });
route('DELETE', '/api/me', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const { pin } = await readJSON(req);
  if (prof.admin) throw new HttpError(400, 'The admin profile can’t be removed. Make someone else the admin first.');
  if (!accounts.checkPin(prof.id, pin)) throw new HttpError(403, 'Wrong PIN.');
  accounts.remove(prof.id); userdata.remove(prof.id); social.forgetProfile(prof.id);
  hub.toAll('profiles', {});
  return { ok: true };
});

// ---- catalogue & details
route('GET', '/api/catalog', (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const out = catalog.payload(prof);
  sendGz(req, res, out.raw, out.gz, 'application/json; charset=utf-8', out.etag);
});
route('GET', '/api/item/:k', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  let it = item(ctx, p.k);
  it = await catalog.details(it.k) || it;
  if (tmdb.enabled() && (it.t === 'movie' || it.t === 'show') && !(tmdb.meta.data.m[it.k] && tmdb.meta.data.m[it.k].at)) {
    try { const m = await tmdb.details(it); applyMeta(it, m); } catch {}
  }
  const out = { ...Catalog.compact(it), plot: it.plot || '', cast: it.cast || '', dir: it.dir || '', tr: it.tr || '', poster: it.poster || '', markers: it.t === 'episode' || it.t === 'movie' ? markers.get(it.k) : null };
  if (it.t === 'show') {
    const eps = await catalog.episodes(it.k).catch(() => []);
    out.episodes = eps.map((e) => ({ ...Catalog.compact(e), plot: (e.plot || '').slice(0, 400) }));
  }
  if (it.sk) { const show = catalog.get(it.sk); if (show) out.show = { k: show.k, n: show.n, i: show.logo || '' }; }
  // Others in the household who watched it.
  out.watchedBy = accounts.profiles.filter((x) => x.id !== prof.id && userdata.of(x.id).data.history.some((h) => h.k === it.k || h.sk === it.k)).map((x) => x.id);
  return out;
});
route('GET', '/api/show/:k/episodes', async (req, res, p, q, ctx) => {
  const it = item(ctx, p.k);
  const eps = await catalog.episodes(it.k);
  return eps.map((e) => ({ ...Catalog.compact(e), plot: (e.plot || '').slice(0, 400) }));
});
route('GET', '/api/recs', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const r = await recs.fresh(prof.id, q.get('force') ? 0 : 6 * 3600e3);
  return r || { top: [], rows: [], household: [] };
});

// ---- guide
const nowCache = new Map();
function epgVisible(prof) {
  const f = catalog.filterFor(prof);
  return catalog.items.filter((it) => it.epg && (it.t === 'live' || it.t === 'radio') && f.test(it));
}
const progOut = (x) => { const o = { s: x.s, e: x.e, t: x.t }; if (x.st) o.st = x.st; if (x.d) o.d = x.d.length > 320 ? x.d.slice(0, 320) + '…' : x.d; if (x.c) o.c = x.c; if (x.ep) o.ep = x.ep; if (x.ic) o.ic = x.ic; if (x.n) o.n = 1; if (x.r) o.r = x.r; return o; };
route('GET', '/api/epg/now', (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const ck = catalog.version + catalog.filterFor(prof).sig;
  const hit = nowCache.get(ck);
  if (hit && Date.now() - hit.t < 60e3) return sendGz(req, res, hit.raw, hit.gz, 'application/json; charset=utf-8');
  const now = Date.now();
  const out = {};
  for (const it of epgVisible(prof)) {
    const list = epg.range(it.epg, now - 3 * 3600e3, now + 8 * 3600e3);
    if (list.length) out[it.k] = list.map(progOut);
  }
  const raw = Buffer.from(JSON.stringify({ at: now, p: out }));
  const entry = { t: Date.now(), raw, gz: zlib.gzipSync(raw, { level: 5 }) };
  nowCache.set(ck, entry);
  if (nowCache.size > 20) nowCache.delete(nowCache.keys().next().value);
  sendGz(req, res, entry.raw, entry.gz, 'application/json; charset=utf-8');
});
route('GET', '/api/epg/range', (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const from = Number(q.get('from')) || Date.now() - 3600e3;
  const to = Math.min(Number(q.get('to')) || from + 6 * 3600e3, from + 3 * 86400e3);
  const out = {};
  for (const k of String(q.get('keys') || '').split(',').slice(0, 400)) {
    const it = catalog.visible(prof, k);
    if (it && it.epg) out[k] = epg.range(it.epg, from, to).map(progOut);
  }
  sendJsonGz(req, res, out);
});
route('GET', '/api/epg/search', (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const needle = String(q.get('q') || '').trim().toLowerCase();
  if (needle.length < 2) return [];
  const now = Date.now();
  const hits = [];
  for (const it of epgVisible(prof)) {
    for (const x of epg.range(it.epg, now - 7 * 86400e3, now + 8 * 86400e3)) {
      if (String(x.t).toLowerCase().includes(needle) || (x.st && x.st.toLowerCase().includes(needle))) hits.push({ k: it.k, ...progOut(x) });
    }
    if (hits.length > 600) break;
  }
  hits.sort((a, b) => Math.abs(a.s - now) - Math.abs(b.s - now));
  return hits.slice(0, 150);
});

// ---- your data
route('POST', '/api/progress', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readJSON(req);
  const rec = userdata.progress(prof.id, b);
  hub.toProfile(prof.id, 'progress', { k: b.k, rec }, ctx.conn);
  return rec || {};
});
route('POST', '/api/played', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readJSON(req);
  userdata.played(prof.id, b);
  recs.touch(prof.id);
  changed(ctx, prof, 'history');
  if (b.k) markers.want(b.k);
  return { ok: true };
});
route('POST', '/api/toggle', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const { field, k, on } = await readJSON(req);
  if (!['list', 'favs', 'hidden'].includes(field)) throw new HttpError(400, 'Unknown list');
  const v = userdata.toggle(prof.id, field, String(k), on);
  if (field !== 'favs') recs.touch(prof.id, 5000);
  hub.toProfile(prof.id, 'data', { field }, ctx.conn);
  return { on: v };
});
// Tell this profile's other devices that something changed, so they show it without a reload.
const changed = (ctx, prof, field) => hub.toProfile(prof.id, 'data', { field }, ctx.conn);
route('POST', '/api/rate', async (req, res, p, q, ctx) => { const prof = requireProfile(ctx); const { k, v } = await readJSON(req); userdata.rate(prof.id, String(k), Number(v) || 0); recs.touch(prof.id, 3000); changed(ctx, prof, 'ratings'); return { ok: true }; });
route('POST', '/api/bookmarks', async (req, res, p, q, ctx) => { const prof = requireProfile(ctx); const r = userdata.addBookmark(prof.id, await readJSON(req)); changed(ctx, prof, 'bookmarks'); return r; });
route('PUT', '/api/bookmarks/:id', async (req, res, p, q, ctx) => { const prof = requireProfile(ctx); const r = userdata.editBookmark(prof.id, p.id, (await readJSON(req)).note); changed(ctx, prof, 'bookmarks'); return r; });
route('DELETE', '/api/bookmarks/:id', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); userdata.removeBookmark(prof.id, p.id); changed(ctx, prof, 'bookmarks'); return { ok: true }; });
route('POST', '/api/reminders', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readJSON(req);
  const list = b.add || b.remove ? userdata.reminder(prof.id, b) : (userdata.setReminders(prof.id, b.list), null);
  changed(ctx, prof, 'reminders');
  return { ok: true, list };
});
route('POST', '/api/searches', async (req, res, p, q, ctx) => { userdata.addSearch(requireProfile(ctx).id, (await readJSON(req)).q); return { ok: true }; });
route('DELETE', '/api/searches', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); userdata.removeSearch(prof.id, q.get('q') || ''); changed(ctx, prof, 'searches'); return { ok: true }; });
route('POST', '/api/impressions', async (req, res, p, q, ctx) => { userdata.impressions(requireProfile(ctx).id, (await readJSON(req)).keys); return { ok: true }; });
route('PUT', '/api/home', async (req, res, p, q, ctx) => { const prof = requireProfile(ctx); const r = userdata.setHome(prof.id, await readJSON(req)); changed(ctx, prof, 'home'); return r; });
route('DELETE', '/api/history', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); userdata.clearHistory(prof.id, q.get('k') || '', q.get('progress') === '1'); recs.touch(prof.id, 3000); changed(ctx, prof, 'history'); return { ok: true }; });

// ---- playback
function relayable(it, url) {
  if (!url) return true;
  const hosts = new Set();
  const add = (u) => { try { hosts.add(new URL(u).host); } catch {} };
  add(it.u);
  for (const a of it.alts || []) add(a.u);
  if (it.cu && it.cu.source) add(it.cu.source);
  let h;
  try { h = new URL(url).host; } catch { return false; }
  return hosts.has(h);
}
route('POST', '/api/play/relay', async (req, res, p, q, ctx) => {
  const b = await readJSON(req);
  const it = item(ctx, String(b.k || ''));
  const src = inputOf(it, Number.isInteger(b.alt) ? b.alt : -1, b.url || '');
  if (!src || src.local) throw new HttpError(400, 'Nothing to relay');
  if (b.url && !relayable(it, b.url)) throw new HttpError(403, 'That address doesn’t belong to this channel');
  if (!isUrl(src.input)) throw new HttpError(400, 'Only web addresses can be relayed');
  const hdr = { h: src.headers };
  const out = { url: proxy.sign(src.input, hdr) };
  if (b.check) await proxy.check(src.input, hdr);
  if (b.sniff) Object.assign(out, await proxy.sniff(src.input, hdr));
  return out;
});
// How can this viewer's browser get the stream straight from the provider? (see lib/reach.js)
route('POST', '/api/play/reach', async (req, res, p, q, ctx) => {
  const b = await readJSON(req);
  const it = item(ctx, String(b.k || ''));
  if (b.url && !relayable(it, b.url)) throw new HttpError(403, 'That address doesn’t belong to this channel');
  const src = inputOf(it, Number.isInteger(b.alt) ? b.alt : -1, b.url || '');
  if (!src || src.local || !isUrl(src.input)) throw new HttpError(400, 'Not a web address');
  const origin = typeof b.origin === 'string' && /^https?:\/\/[^/]+$/.test(b.origin) ? b.origin : `${req.secure ? 'https' : 'http'}://${req.headers.host}`;
  if (b.forget) { reach.forget(src.input, origin); return { ok: true }; }
  const alt = Number.isInteger(b.alt) ? b.alt : -1;
  return reach.check(src.input, { h: src.headers }, origin, typeof b.ua === 'string' ? b.ua.slice(0, 300) : '', { limit: connLimit(it, alt), formats: listFormats(it, alt) });
});
// Playback statistics: the player says which route it used and for how long (Admin → Statistics).
route('POST', '/api/stats/play', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readJSON(req);
  let provider = '', type = '';
  try {
    const it = item(ctx, String(b.k || ''));
    type = it.t;
    const src = inputOf(it, Number.isInteger(b.alt) ? b.alt : -1);
    if (src && !src.local && isUrl(src.input)) provider = new URL(src.input).host;
  } catch {}
  if (b.failed) { stats.fail(); return { ok: true }; }
  return { id: stats.play({ route: String(b.route || ''), reason: String(b.reason || ''), provider, host: String(b.host || req.headers.host || ''), profile: prof.id, type }) };
});
route('POST', '/api/stats/watch', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readJSON(req);
  stats.watch(String(b.id || ''), b.sec, prof.id);
  return { ok: true };
});
route('GET', '/api/admin/stats', (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const names = {};
  for (const pr of accounts.d.profiles) names[pr.id] = pr.name;
  return stats.summary(clampInt(q.get('days'), 1, 120, 30), names);
});
route('DELETE', '/api/admin/stats', (req, res, p, q, ctx) => { requireAdmin(ctx); stats.reset(); return { ok: true }; });
// The optional browser helper for desktop Chrome/Edge (extension/), named after this site.
route('GET', '/api/direct-helper.zip', (req, res) => {
  const name = `${settings().brand.name || 'IPTV Player'} – Direct Streams`.slice(0, 75);
  const buf = zipFolder(path.join(cfg.root, 'extension'), 'direct-streams-helper', (file, data) => {
    if (file !== 'manifest.json') return data;
    const m = JSON.parse(data.toString('utf8'));
    m.name = name;
    return Buffer.from(JSON.stringify(m, null, 2));
  });
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="direct-streams-helper.zip"', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}, 'site');
route('POST', '/api/play/session', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readJSON(req);
  const it = item(ctx, String(b.k || ''));
  if (b.url && !relayable(it, b.url)) throw new HttpError(403, 'That address doesn’t belong to this channel');
  const src = inputOf(it, Number.isInteger(b.alt) ? b.alt : -1, b.url || '');
  if (!src) throw new HttpError(404, 'File not found');
  const isProto = /^(rtmpt?e?s?|rtsps?|udp|rtp|srt|mmsh?|mmst):\/\//i.test(src.input);
  if (!src.local && !isUrl(src.input) && !isProto) throw new HttpError(400, 'This kind of address can’t be played');
  const wasCached = media.probeCached(src.input, src.headers);
  const pr = await media.probe(src.input, { headers: src.headers, timeout: isProto ? 20000 : 15000 });
  if (!pr && (isProto || src.local)) throw new HttpError(502, 'The server couldn’t open that stream.');
  // One-connection accounts: let the provider free the slot the look-inside used before the real connection.
  if (!wasCached && !src.local && oneConnection(it, Number.isInteger(b.alt) ? b.alt : -1)) await new Promise((ok) => setTimeout(ok, 1500));
  const finite = !!(pr && pr.duration > 0) && b.live !== true;
  const live = !finite;
  const codecs = Array.isArray(b.codecs) ? b.codecs.map(String) : ['h264'];
  const height = clampInt(b.height, 0, 2160, 0);
  const transcode = b.mode === 'transcode' || media.needsVideoTranscode(pr, codecs) || !!(height && pr && pr.height && pr.height > height);
  const audioOnly = !!(pr && !pr.vcodec && pr.acodec) || it.t === 'radio';
  const seek = finite ? Math.max(0, Number(b.seek) || 0) : 0;
  const audioTrack = clampInt(b.audio, 0, 64, 0);
  const s = await media.startSession({ input: src.input, headers: src.headers, live, seek, video: transcode ? 'h264' : 'copy', audioOnly, audioTrack, height, label: it.n, owner: prof.id });
  return {
    url: `/api/session/${s.id}/index.m3u8`, sessionId: s.id, offset: s.offset, duration: finite ? pr.duration : 0, mode: transcode ? 'transcode' : 'remux',
    audio: pr ? pr.audio : [], subs: pr ? pr.subs.filter((x) => x.text) : [], chapters: pr ? pr.chapters : [], height: pr ? pr.height : 0, vcodec: pr ? pr.vcodec : '',
  };
});
// DASH through the server: Shaka asks for every manifest/segment here (only addresses on the item's own hosts).
route('GET', '/api/dash', async (req, res, p, q, ctx) => {
  if (req.headers['x-app'] !== '1') throw new HttpError(403, 'Missing X-App header');
  const it = item(ctx, String(q.get('k') || ''));
  const url = String(q.get('u') || '');
  if (!isUrl(url) || !relayable(it, url)) throw new HttpError(403, 'That address doesn’t belong to this channel');
  const src = inputOf(it, clampInt(q.get('alt'), -1, 99, -1));
  const headers = proxy.headers({ h: (src && src.headers) || {} });
  if (req.headers.range) headers.Range = req.headers.range;
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  let up;
  try { up = await fetchAny(url, { headers, signal: ac.signal, redirect: 'follow' }); } catch (e) { if (ac.signal.aborted) return; throw new HttpError(502, `Upstream error: ${(e.cause && e.cause.message) || e.message}`); }
  const out = { 'Cache-Control': 'no-cache' };
  const enc = !!up.headers.get('content-encoding');
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) { if (enc && k === 'content-length') continue; const v = up.headers.get(k); if (v) out[k] = v; }
  res.writeHead(up.status, out);
  if (!up.body) return res.end();
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
});
route('GET', '/api/session/:sid/:file', (req, res, p) => {
  if (!/^(index\.m3u8|seg\d+\.ts)$/.test(p.file)) throw new HttpError(400, 'Bad file');
  const s = media.touch(p.sid);
  if (!s) throw new HttpError(410, 'Playback session ended');
  const file = path.join(s.dir, p.file);
  countBytes(res, 'convert');
  if (p.file === 'index.m3u8') return sendText(res, 200, fs.readFileSync(file, 'utf8'), 'application/vnd.apple.mpegurl', req.cast ? { 'Access-Control-Allow-Origin': '*' } : {});
  serveFile(req, res, file, { type: 'video/mp2t', cache: 'max-age=3600', headers: req.cast ? { 'Access-Control-Allow-Origin': '*' } : {} });
}, 'site');
route('POST', '/api/session/:sid/ping', (req, res, p) => ({ alive: !!media.touch(p.sid) }), 'site');
route('DELETE', '/api/session/:sid', (req, res, p) => { media.stopSession(p.sid); return { ok: true }; }, 'site');
route('GET', '/api/proxy', (req, res, p, q) => proxy.handle(req, res, q, req.cast), 'site');
route('GET', '/api/local/:list/:id', (req, res, p) => {
  countBytes(res, 'local');
  const li = lists.libraryItem(p.list, p.id);
  if (!li) throw new HttpError(404, 'File not found');
  serveFile(req, res, li.path, { headers: req.cast ? { 'Access-Control-Allow-Origin': '*' } : {} });
}, 'site');
route('GET', '/api/file/:k', (req, res, p, q, ctx) => {
  countBytes(res, 'local');
  const it = item(ctx, p.k);
  const src = inputOf(it, clampInt(q.get('alt'), -1, 99, -1));
  if (!src || !src.local) throw new HttpError(404, 'Not a file on this server');
  serveFile(req, res, src.input);
});
route('GET', '/api/art/:list/:id', async (req, res, p) => {
  const lib = lists.libraries.get(p.list);
  const li = lib && lib.get(p.id);
  if (!li) throw new HttpError(404, 'Not found');
  let file;
  try { file = await lib.thumb(li); } catch { throw new HttpError(404, 'No artwork'); }
  serveFile(req, res, file, { cache: 'private, max-age=86400' });
}, 'site');
route('GET', '/api/probe/:k', async (req, res, p, q, ctx) => {
  const it = item(ctx, p.k);
  if (oneConnection(it, clampInt(q.get('alt'), -1, 99, -1))) throw new HttpError(409, 'The provider allows only one connection at a time, so the server can’t look inside while you watch.');
  const src = inputOf(it, clampInt(q.get('alt'), -1, 99, -1));
  if (!src) throw new HttpError(404, 'Not found');
  const pr = await media.probe(src.input, { headers: src.headers });
  if (!pr) throw new HttpError(502, 'Couldn’t read the stream');
  return { duration: pr.duration, vcodec: pr.vcodec, acodec: pr.acodec, height: pr.height, audio: pr.audio, subs: pr.subs, chapters: pr.chapters };
});
route('GET', '/api/subs/:k/:track', async (req, res, p, q, ctx) => {
  const it = item(ctx, p.k);
  if (oneConnection(it, clampInt(q.get('alt'), -1, 99, -1))) throw new HttpError(409, 'The provider allows only one connection at a time, so subtitles inside the file can’t be read while you watch.');
  const src = inputOf(it, clampInt(q.get('alt'), -1, 99, -1));
  if (!src) throw new HttpError(404, 'Not found');
  let vtt = await media.subtitles(src.input, clampInt(p.track, 0, 99, 0), { headers: src.headers });
  const off = Number(q.get('offset')) || 0;
  if (off) {
    const shift = (t) => {
      const [h, m, s] = t.split(':');
      const ms = Math.max(0, Math.round(((+h) * 3600 + (+m) * 60 + parseFloat(s) - off) * 1000));
      const z = (n, l = 2) => String(n).padStart(l, '0');
      return `${z(Math.floor(ms / 3600000))}:${z(Math.floor(ms / 60000) % 60)}:${z(Math.floor(ms / 1000) % 60)}.${z(ms % 1000, 3)}`;
    };
    vtt = vtt.replace(/(\d+:\d{2}:\d{2}\.\d{3})/g, (m) => shift(m)).replace(/^(\d{2}:\d{2}\.\d{3})/gm, (m) => shift('00:' + m));
  }
  sendText(res, 200, vtt, 'text/vtt; charset=utf-8');
});
route('GET', '/api/frame/:k', async (req, res, p, q, ctx) => {
  const it = item(ctx, p.k);
  if (it.t === 'live') throw new HttpError(400, 'Not for live channels');
  if (oneConnection(it)) throw new HttpError(409, 'The provider allows only one connection at a time.');
  const src = inputOf(it);
  if (!src) throw new HttpError(404, 'Not found');
  const t = Math.round((Number(q.get('t')) || 0) / 10) * 10;
  const file = await media.frame(src.input, t, { headers: src.headers, width: clampInt(q.get('w'), 120, 640, 240) });
  serveFile(req, res, file, { cache: 'private, max-age=604800' });
});
route('GET', '/api/download/:k', async (req, res, p, q, ctx) => {
  countBytes(res, 'download');
  const prof = requireProfile(ctx);
  if (settings().allowDownloads === false && !prof.admin) throw new HttpError(403, 'Downloads are turned off.');
  const it = item(ctx, p.k);
  if (it.t === 'live' || it.t === 'show') throw new HttpError(400, 'Only movies, episodes and audio can be downloaded.');
  const src = inputOf(it, clampInt(q.get('alt'), -1, 99, -1));
  if (!src) throw new HttpError(404, 'Not found');
  const safe = it.n.replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 120) || 'video';
  const height = clampInt(q.get('height'), 0, 2160, 0);
  const pr = await media.probe(src.input, { headers: src.headers });
  if (!pr) throw new HttpError(502, 'Couldn’t read the video.');
  const okVideo = !pr.vcodec || (pr.vcodec === 'h264' && !/10le|12le|422|444/.test(pr.pixfmt || ''));
  const okAudio = !pr.acodec || ['aac', 'mp3'].includes(pr.acodec);
  const isMp4 = /mp4|mov/.test(pr.format) || NATIVE_EXT.test(src.input.split('?')[0]);
  const ext = !pr.vcodec && pr.acodec ? (pr.acodec === 'mp3' ? '.mp3' : pr.acodec === 'flac' ? '.flac' : '.m4a') : '.mp4';
  res.setHeader('X-Duration', String(Math.round(pr.duration || 0)));
  if (isMp4 && okVideo && okAudio && !height) {
    if (src.local) return serveFile(req, res, src.input, { download: safe + path.extname(src.input) });
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const up = await fetchAny(src.input, { headers: proxy.headers({ h: src.headers }), signal: ac.signal, redirect: 'follow' });
    if (!up.ok) throw new HttpError(502, `The stream server answered HTTP ${up.status}`);
    const h = { 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safe + '.mp4')}`, 'Cache-Control': 'no-store' };
    if (up.headers.get('content-length') && !up.headers.get('content-encoding')) h['Content-Length'] = up.headers.get('content-length');
    res.writeHead(200, h);
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
    return;
  }
  if (!pr.vcodec && pr.acodec) {
    // Audio: hand over as-is if the browser can play it, else convert to AAC.
    if (src.local && NATIVE_EXT.test(src.input)) return serveFile(req, res, src.input, { download: safe + path.extname(src.input) });
  }
  media.mp4(src.input, { headers: src.headers, transcode: !okVideo || !!(height && pr.height > height), height, audioTrack: clampInt(q.get('audio'), 0, 64, 0) }, req, res, safe + ext);
});
route('GET', '/api/markers/:k', (req, res, p, q, ctx) => { const it = item(ctx, p.k); markers.want(it.k); return markers.get(it.k); });
route('POST', '/api/markers/:k', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const it = item(ctx, p.k);
  const b = await readJSON(req);
  return markers.set(it.k, b.kind, b.start === null ? null : b.start, b.end, { season: !!b.season, by: prof.id });
});

// ---- social
route('GET', '/api/social', (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const presence = [];
  for (const c of hub.conns) {
    if (c.pid === prof.id || !c.playing) continue;
    const pr = userdata.prefs(c.pid);
    if (pr.presence === false) continue;
    const it = catalog.visible(prof, c.playing.k);
    if (it) presence.push({ pid: c.pid, k: c.playing.k, n: it.n, i: it.logo || '', at: c.playing.at });
  }
  return {
    profiles: accounts.profiles.map((x) => ({ ...accounts.summary(x), online: hub.online().includes(x.id) })),
    conversations: social.conversations(prof.id), unread: social.unread(prof.id), lists: social.lists(), parties: social.partiesFor(prof.id), presence,
  };
});
route('GET', '/api/messages/:conv', (req, res, p, q, ctx) => social.thread(requireProfile(ctx).id, p.conv, Number(q.get('before')) || Infinity));
route('POST', '/api/messages', async (req, res, p, q, ctx) => social.send(requireProfile(ctx).id, await readJSON(req)));
route('POST', '/api/messages/:conv/read', (req, res, p, q, ctx) => ({ n: social.markRead(requireProfile(ctx).id, p.conv) }));
route('POST', '/api/messages-react', async (req, res, p, q, ctx) => { const b = await readJSON(req); return social.react(requireProfile(ctx).id, b.id, b.emoji); });
route('DELETE', '/api/messages/:id', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); social.removeMessage(prof.id, p.id, prof.admin); return { ok: true }; });
route('POST', '/api/lists', async (req, res, p, q, ctx) => social.createList(requireProfile(ctx).id, (await readJSON(req)).name));
route('PUT', '/api/lists/:id', async (req, res, p, q, ctx) => { const prof = requireProfile(ctx); return social.editList(prof.id, p.id, await readJSON(req), prof.admin); });
route('DELETE', '/api/lists/:id', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); social.removeList(prof.id, p.id, prof.admin); return { ok: true }; });
route('POST', '/api/party', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  if (settings().allowParties === false) throw new HttpError(403, 'Watch parties are turned off.');
  const b = await readJSON(req);
  item(ctx, String(b.k || ''));
  return social.createParty(prof.id, b);
});
route('GET', '/api/party/:id', (req, res, p, q, ctx) => { requireProfile(ctx); return social.partyView(social.party(p.id)); });
route('POST', '/api/party/:id/join', (req, res, p, q, ctx) => social.joinParty(requireProfile(ctx).id, p.id));
route('POST', '/api/party/:id/leave', (req, res, p, q, ctx) => { social.leaveParty(requireProfile(ctx).id, p.id); return { ok: true }; });
route('POST', '/api/party/:id/state', async (req, res, p, q, ctx) => social.partyState(requireProfile(ctx).id, p.id, await readJSON(req)));
route('POST', '/api/party/:id/chat', async (req, res, p, q, ctx) => social.partyChat(requireProfile(ctx).id, p.id, await readJSON(req)) || { ok: true });
route('POST', '/api/party/:id/settings', async (req, res, p, q, ctx) => { social.partySettings(requireProfile(ctx).id, p.id, await readJSON(req)); return { ok: true }; });

// ---- live connection, presence, devices
route('GET', '/api/events', (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  hub.open(req, res, { pid: prof.id, sess: ctx.sess.id, deviceId: String(q.get('device') || '').slice(0, 40), deviceName: String(q.get('name') || ctx.sess.name).slice(0, 60) });
});
route('POST', '/api/presence', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readJSON(req);
  const c = hub.conn(String(b.conn || ''));
  if (c && c.pid === prof.id) c.playing = b.playing && b.playing.k ? { k: String(b.playing.k), pos: Number(b.playing.pos) || 0, at: Date.now(), n: String(b.playing.n || '').slice(0, 200) } : null;
  return { ok: true };
});
route('GET', '/api/devices', (req, res, p, q, ctx) => hub.devices(requireProfile(ctx).id));
route('POST', '/api/devices/:conn/command', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const c = hub.conn(p.conn);
  if (!c || c.pid !== prof.id) throw new HttpError(404, 'That device isn’t connected any more.');
  const b = await readJSON(req);
  if (!['play', 'pause', 'resume', 'stop', 'seek'].includes(b.cmd)) throw new HttpError(400, 'Unknown command');
  hub.send(c, 'command', { cmd: b.cmd, k: b.k, pos: Number(b.pos) || 0, from: ctx.sess.name });
  return { ok: true };
});

// ---- casting: short-lived links a Chromecast/AirPlay receiver can open without signing in
const castSecret = crypto.randomBytes(32);
const castSign = (pathq, hours = 8) => {
  const exp = Math.floor(Date.now() / 1000) + hours * 3600;
  const data = Buffer.from(JSON.stringify({ p: pathq.split('?')[0].split('/').slice(0, 4).join('/'), e: exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', castSecret).update(data).digest('base64url').slice(0, 24);
  return `/c/${data}.${sig}${pathq}`;
};
route('POST', '/api/cast/link', async (req, res, p, q, ctx) => {
  requireProfile(ctx);
  const { path: pq } = await readJSON(req);
  if (!/^\/api\/(session|proxy|local)\b/.test(String(pq || ''))) throw new HttpError(400, 'Only stream addresses can be cast');
  return { url: castSign(String(pq)) };
});

// ---- admin
route('GET', '/api/admin', (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const s = settings();
  const counts = {};
  for (const it of catalog.items) counts[it.t] = (counts[it.t] || 0) + 1;
  return {
    settings: { ...s, tmdbKey: s.tmdbKey ? '••••' + s.tmdbKey.slice(-4) : '' },
    lists: lists.all().map((l) => lists.view(l)), guides: lists.guides(),
    profiles: accounts.profiles.map((x) => ({ ...accounts.view(x), online: hub.online().includes(x.id) })),
    devices: accounts.sessionsList(),
    status: {
      version: cfg.version, ffmpeg: media.available, ffmpegVersion: media.version, hw: media.hw, encoders: [...media.encoders].filter((e) => /h264_/.test(e)),
      sessions: [...media.sessions.values()].map((x) => ({ id: x.id, label: x.label, owner: x.owner, transcode: x.transcode, hw: x.hw, height: x.height, startedAt: x.startedAt })),
      catalog: { version: catalog.version, total: catalog.items.length, counts, shows: catalog.shows.size },
      epg: epg.stats(), tmdb: { enabled: tmdb.enabled(), error: tmdb.lastError, matched: Object.keys(tmdb.meta.data.m).length }, intro: !!markers.detector,
      dataDir: D, listen: `${cfg.host}:${cfg.port}`, platform: `${process.platform} ${os.release()}`, node: process.version, uptime: Math.round(process.uptime()),
      defaultPassword: accounts.d.site.isDefault, exportBase: `/k/${s.exportKey}`,
    },
    watching: [...hub.conns].filter((c) => c.playing).map((c) => ({ pid: c.pid, device: c.deviceName, k: c.playing.k, n: c.playing.n, at: c.playing.at })),
  };
});
route('PUT', '/api/admin/settings', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const b = await readJSON(req);
  const s = settings();
  const num = (k, min, max) => { if (k in b) s[k] = clampInt(b[k], min, max, s[k]); };
  if (typeof b.userAgent === 'string') s.userAgent = b.userAgent.trim() || DEFAULT_SETTINGS.userAgent;
  if (['direct-first', 'server', 'direct-only'].includes(b.routing)) s.routing = b.routing;
  if (Array.isArray(b.defaultLangs)) s.defaultLangs = b.defaultLangs.map(String);
  for (const k of ['showUnknownLang', 'adminOnlyProfiles', 'allowDownloads', 'allowParties', 'introDetection']) if (k in b) s[k] = !!b[k];
  if (Array.isArray(b.hiddenGroups)) s.hiddenGroups = b.hiddenGroups.map(String);
  if (Array.isArray(b.hiddenKeys)) s.hiddenKeys = b.hiddenKeys.map(String);
  if (typeof b.transcodePreset === 'string' && /^(ultrafast|superfast|veryfast|faster|fast|medium)$/.test(b.transcodePreset)) s.transcodePreset = b.transcodePreset;
  if ('hwaccel' in b && ['', 'vaapi', 'nvenc', 'qsv', 'videotoolbox'].includes(b.hwaccel)) { s.hwaccel = b.hwaccel; media.hwFailed = false; }
  if (typeof b.tmdbKey === 'string' && !/^•/.test(b.tmdbKey)) s.tmdbKey = b.tmdbKey.trim();
  num('epgDays', 1, 21); num('epgPastDays', 0, 14); num('epgRefreshHours', 1, 168); num('transcodeCrf', 16, 35); num('transcodeMaxHeight', 240, 2160);
  num('maxTranscodes', 0, 32); num('maxSessions', 1, 64); num('remuxReadrate', 0, 10);
  if (Array.isArray(b.allowedHosts)) s.allowedHosts = b.allowedHosts.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (b.brand && typeof b.brand === 'object') {
    s.brand = {
      name: String(b.brand.name || '').trim().slice(0, 60) || s.brand.name,
      logo: typeof b.brand.logo === 'string' && b.brand.logo.length < 600000 ? b.brand.logo : s.brand.logo,
      accent: /^#[0-9a-f]{6}$/i.test(b.brand.accent || '') ? b.brand.accent : '',
    };
  }
  if (b.newExportKey) s.exportKey = crypto.randomBytes(12).toString('hex');
  settingsStore.save();
  if ('hiddenGroups' in b || 'hiddenKeys' in b || 'defaultLangs' in b || 'showUnknownLang' in b) scheduleRebuild(100);
  hub.toAll('settings', publicSettings());
  return { ...s, tmdbKey: s.tmdbKey ? '••••' + s.tmdbKey.slice(-4) : '' };
});
route('POST', '/api/admin/password', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const { next } = await readJSON(req);
  accounts.setSitePassword(next, ctx.sess._key);
  return { ok: true };
});
route('POST', '/api/admin/lists', async (req, res, p, q, ctx) => { requireAdmin(ctx); return lists.add(await readJSON(req)); });
route('POST', '/api/admin/lists/upload', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const buf = await readBody(req, 400 * 1024 * 1024);
  return lists.add({ type: 'file', name: q.get('name') || '', fileName: q.get('fileName') || '', lang: q.get('lang') || '' }, buf);
});
route('PUT', '/api/admin/lists/:id', async (req, res, p, q, ctx) => { requireAdmin(ctx); return lists.update(p.id, await readJSON(req)); });
route('PUT', '/api/admin/lists/:id/file', async (req, res, p, q, ctx) => { requireAdmin(ctx); return lists.replaceFile(p.id, await readBody(req, 400 * 1024 * 1024)); });
route('DELETE', '/api/admin/lists/:id', (req, res, p, q, ctx) => { requireAdmin(ctx); lists.remove(p.id); return { ok: true }; });
route('POST', '/api/admin/lists/:id/refresh', async (req, res, p, q, ctx) => { requireAdmin(ctx); return lists.refresh(p.id); });
route('POST', '/api/admin/lists-order', async (req, res, p, q, ctx) => { requireAdmin(ctx); lists.reorder((await readJSON(req)).ids || []); return { ok: true }; });
route('POST', '/api/admin/guides', async (req, res, p, q, ctx) => { requireAdmin(ctx); return lists.addGuide(await readJSON(req)); });
route('PUT', '/api/admin/guides/:id', async (req, res, p, q, ctx) => { requireAdmin(ctx); return lists.updateGuide(p.id, await readJSON(req)); });
route('DELETE', '/api/admin/guides/:id', (req, res, p, q, ctx) => { requireAdmin(ctx); lists.removeGuide(p.id); return { ok: true }; });
route('POST', '/api/admin/guides/:id/refresh', (req, res, p, q, ctx) => { requireAdmin(ctx); return lists.refreshGuide(p.id); });
route('PUT', '/api/admin/profiles/:id', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const prof = accounts.update(p.id, await readJSON(req), { byAdmin: true });
  recs.touch(prof.id, 2000);
  hub.toAll('profiles', {});
  hub.toProfile(prof.id, 'profile', {});
  return accounts.view(prof);
});
route('DELETE', '/api/admin/profiles/:id', (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  accounts.remove(p.id); userdata.remove(p.id); social.forgetProfile(p.id);
  hub.toProfile(p.id, 'removed', {});
  hub.toAll('profiles', {});
  return { ok: true };
});
route('POST', '/api/admin/profiles/:id/make-admin', (req, res, p, q, ctx) => { const a = requireAdmin(ctx); accounts.transferAdmin(a.id, p.id); hub.toAll('profiles', {}); return { ok: true }; });
route('DELETE', '/api/admin/devices/:id', (req, res, p, q, ctx) => { requireAdmin(ctx); accounts.endSession(p.id); return { ok: true }; });
route('GET', '/api/admin/groups', (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const groups = new Map();
  const langs = {};
  const add = (it) => {
    const key = it.g;
    const e = groups.get(key) || { name: key, count: 0, types: {}, langs: {} };
    e.count++; e.types[it.t] = (e.types[it.t] || 0) + 1;
    for (const l of it.lg.length ? it.lg : ['?']) { e.langs[l] = (e.langs[l] || 0) + 1; langs[l] = (langs[l] || 0) + 1; }
    groups.set(key, e);
  };
  for (const l of lists.all()) { const parsed = lists.parsed.get(l.id); if (!parsed) continue; }
  for (const it of catalog.items) if (it.t !== 'episode') add(it);
  for (const g of settings().hiddenGroups) if (!groups.has(g)) groups.set(g, { name: g, count: 0, types: {}, langs: {}, hidden: true });
  return { groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)), langs };
});
route('POST', '/api/admin/tmdb/test', async (req, res, p, q, ctx) => { requireAdmin(ctx); try { return { ok: await tmdb.test() }; } catch (e) { return { ok: false, error: e.message }; } });
let enrichJob = null;
/**
 * Fill in posters, plots, genres, cast and directors from TMDB for titles that don't have them yet — started by the
 * admin, and automatically in the background whenever the catalogue changes. Devices get the new details every
 * few minutes (and at the end).
 */
function startEnrich(auto = false) {
  if (enrichJob || !tmdb.enabled()) return enrichJob ? enrichJob.status : null;
  let todo = catalog.items.filter((it) => (it.t === 'movie' || it.t === 'show') && !tmdb.meta.data.m[it.k] && !(tmdb.map.data.m[it.k] && tmdb.map.data.m[it.k].none));
  if (!todo.length) return { running: false, total: 0, done: 0 };
  // What the household can actually see comes first (in their languages), and of that what they've watched or
  // saved; titles in languages nobody uses come last.
  const filters = accounts.profiles.map((p) => catalog.filterFor(p));
  const mine = new Set();
  for (const p of accounts.profiles) { const d = userdata.of(p.id).data; for (const h of d.history) mine.add(h.sk || h.k); for (const k of d.list) mine.add(k); }
  const rank = (it) => (mine.has(it.k) ? 0 : filters.some((f) => f.test(it)) ? 1 : 2);
  todo = todo.map((it, i) => ({ it, r: rank(it), i })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.it);
  if (auto) log(`TMDB: filling in details for ${todo.length} titles in the background`);
  let lastPush = Date.now();
  const push = () => { catalog.metaChanged(); hub.toAll('catalog', { version: catalog.version }); lastPush = Date.now(); };
  enrichJob = { status: { running: true, total: todo.length, done: 0, auto } };
  tmdb.enrich(todo, {
    onItem: (it, m) => { applyMeta(it, m); enrichJob.status.done++; if (Date.now() - lastPush > 5 * 60e3) push(); },
    stop: () => !enrichJob,
  }).finally(() => { push(); enrichJob = null; });
  return enrichJob.status;
}
route('POST', '/api/admin/tmdb/enrich', (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  if (!tmdb.enabled()) throw new HttpError(400, 'Add a TMDB key first.');
  return startEnrich() || { running: false };
});
route('GET', '/api/admin/tmdb/enrich', (req, res, p, q, ctx) => { requireAdmin(ctx); return enrichJob ? enrichJob.status : { running: false }; });
route('DELETE', '/api/admin/tmdb/enrich', (req, res, p, q, ctx) => { requireAdmin(ctx); enrichJob = null; return { ok: true }; });
route('DELETE', '/api/admin/sessions/:id', (req, res, p, q, ctx) => { requireAdmin(ctx); media.stopSession(p.id); return { ok: true }; });
route('GET', '/api/admin/fs', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  let dir = q.get('path');
  if (!dir) {
    const roots = [{ name: 'Home', path: os.homedir() }];
    if (process.platform === 'win32') { for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${l}:\\`)) roots.push({ name: `${l}:`, path: `${l}:\\` }); } else {
      roots.push({ name: '/', path: '/' });
      for (const m of ['/media', '/mnt', '/Volumes', '/data', '/srv']) if (fs.existsSync(m)) roots.push({ name: m, path: m });
    }
    return { path: '', parent: null, dirs: roots };
  }
  dir = path.resolve(dir);
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { throw new HttpError(400, `Can’t open ${dir}: ${e.code}`); }
  const dirs = [];
  let files = 0;
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = fs.statSync(path.join(dir, e.name)).isDirectory(); } catch {} }
    if (isDir) dirs.push({ name: e.name, path: path.join(dir, e.name) }); else files++;
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? '' : parent, dirs, files };
});
route('GET', '/api/admin/backup', (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  JsonFile.flushAll();
  const files = {};
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!['tmp', 'cache', 'epg', 'thumbs', 'xt'].includes(e.name)) walk(path.join(dir, e.name), r); } else if (!/\.(bak|tmp)$/.test(e.name) && !/^corrupt/.test(e.name)) files[r] = fs.readFileSync(path.join(dir, e.name)).toString('base64');
    }
  };
  walk(D, '');
  const body = zlib.gzipSync(Buffer.from(JSON.stringify({ app: 'browser-iptv-player', version: cfg.version, createdAt: new Date().toISOString(), files })));
  res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': body.length, 'Content-Disposition': `attachment; filename="iptv-backup-${new Date().toISOString().slice(0, 10)}.json.gz"` });
  res.end(body);
});
route('POST', '/api/admin/restore', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  let data;
  try { let buf = await readBody(req, 2 * 1024 * 1024 * 1024); if (buf[0] === 0x1f) buf = zlib.gunzipSync(buf); data = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'That isn’t a backup file from this app.'); }
  if (!data || data.app !== 'browser-iptv-player' || !data.files) throw new HttpError(400, 'That isn’t a backup file from this app.');
  for (const [rel, b64] of Object.entries(data.files)) {
    if (rel.includes('..') || path.isAbsolute(rel)) continue;
    const f = path.join(D, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
  }
  res.on('finish', () => { log('Backup restored — restarting.'); setTimeout(() => process.exit(0), 500); });
  return { ok: true, restart: true };
});

// ---- exports for other apps (VLC, Kodi, Plex…): /k/<exportKey>/playlist.m3u and /k/<exportKey>/epg.xml
function exportM3U(req, res, key) {
  const b = `${req.headers['x-forwarded-proto'] && cfg.trustProxy ? req.headers['x-forwarded-proto'] : secureReq(req) ? 'https' : 'http'}://${req.headers.host}/k/${key}`;
  const items = catalog.items.filter((it) => it.u && it.t !== 'show' && !it.adult).map((it) => ({
    name: it.n, url: it.loc ? `${b}/file/${it.loc.list}/${it.loc.id}` : it.u, tvgId: it.epg ? it.k : '', tvgName: it.n, logo: it.logo, group: it.g, chno: it.num || '', headers: it.h || {}, type: it.t === 'episode' ? 'series' : it.t,
  }));
  sendText(res, 200, P.generate(items, `${b}/epg.xml`), 'audio/x-mpegurl; charset=utf-8', { 'Content-Disposition': 'inline; filename="playlist.m3u"' });
}
function exportXmltv(req, res) {
  const now = Date.now();
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="browser-iptv-player">'];
  const live = catalog.items.filter((it) => it.epg && !it.adult);
  for (const it of live) out.push(`<channel id="${xmlEsc(it.k)}"><display-name>${xmlEsc(it.n)}</display-name>${it.logo ? `<icon src="${xmlEsc(it.logo)}"/>` : ''}</channel>`);
  for (const it of live) {
    for (const x of epg.range(it.epg, now - 2 * 3600e3, now + settings().epgDays * 86400e3)) {
      let s = `<programme start="${fmtTime(x.s)}" stop="${fmtTime(x.e)}" channel="${xmlEsc(it.k)}"><title>${xmlEsc(x.t)}</title>`;
      if (x.st) s += `<sub-title>${xmlEsc(x.st)}</sub-title>`;
      if (x.d) s += `<desc>${xmlEsc(x.d)}</desc>`;
      out.push(s + '</programme>');
    }
  }
  out.push('</tv>');
  const raw = Buffer.from(out.join('\n'));
  sendGz(req, res, raw, zlib.gzipSync(raw), 'application/xml; charset=utf-8');
}

// ---------------------------------------------------------------- web app (built from web/ on start)
const WEB = path.join(cfg.root, 'web');
const PUBLIC = path.join(cfg.root, 'public');
let bundle = null;
function buildBundle() {
  const order = JSON.parse(fs.readFileSync(path.join(WEB, 'order.json'), 'utf8'));
  const js = order.js.map((f) => `/* ${f} */\n` + fs.readFileSync(path.join(WEB, 'js', f), 'utf8')).join('\n;\n');
  const css = order.css.map((f) => fs.readFileSync(path.join(WEB, 'css', f), 'utf8')).join('\n');
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const v = crypto.createHash('sha1').update(js + css + html).digest('hex').slice(0, 10);
  const mk = (s) => { const raw = Buffer.from(s); return { raw, gz: zlib.gzipSync(raw, { level: 9 }), etag: `"${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16)}"` }; };
  bundle = { v, js: mk(js), css: mk(css), html, sw: mk(fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8').replace('__VERSION__', v)) };
  return bundle;
}
const getBundle = () => (process.env.DEV ? buildBundle() : bundle || buildBundle());
function appHtml() {
  const b = getBundle();
  const s = settings();
  const brand = s.brand || {};
  const esc = (x) => String(x || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return b.html.replace(/__V__/g, b.v).replace(/__BRAND__/g, esc(brand.name)).replace('__ACCENT__', /^#[0-9a-f]{6}$/i.test(brand.accent || '') ? `<style>:root{--brand:${brand.accent}}</style>` : '');
}
const LOGIN_HTML = () => fs.readFileSync(path.join(WEB, 'login.html'), 'utf8');

// ---------------------------------------------------------------- server
const HOSTNAME = os.hostname().toLowerCase();
function hostAllowed(hostHeader) {
  if (!hostHeader) return true;
  const h = hostHeader.toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return true;
  if (h === HOSTNAME || h === `${HOSTNAME}.local` || h === HOSTNAME.split('.')[0] || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa') || h.endsWith('.ts.net')) return true;
  if (cfg.allowedHosts.includes('*') || cfg.allowedHosts.includes(h) || (settings().allowedHosts || []).includes(h)) return true;
  // Once the site password isn't the default one, any address is fine (a stranger's page can't sign in).
  return !accounts.d.site.isDefault;
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  let pathname;
  try { pathname = decodeURIComponent(u.pathname); } catch { pathname = u.pathname; }
  const ctx = { sess: null, profile: null, conn: req.headers['x-conn'] || '' };
  try {
    if (!hostAllowed(cfg.trustProxy && req.headers['x-forwarded-host'] ? req.headers['x-forwarded-host'] : req.headers.host)) {
      throw new HttpError(403, `This server doesn’t answer to “${req.headers.host}”. Add it with the ALLOWED_HOSTS setting (see README), or change the site password first.`);
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    // Cast links: /c/<token>/api/session/... etc. — no cookie needed, CORS open, valid for a few hours.
    const cm = pathname.match(/^\/c\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)(\/api\/(?:session|proxy|local)\/?.*)$/);
    if (cm) {
      const sig = crypto.createHmac('sha256', castSecret).update(cm[1]).digest('base64url').slice(0, 24);
      let tok;
      try { tok = JSON.parse(Buffer.from(cm[1], 'base64url').toString('utf8')); } catch {}
      if (sig !== cm[2] || !tok || tok.e < Date.now() / 1000 || !cm[3].startsWith(tok.p)) throw new HttpError(403, 'This cast link has expired.');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Allow-Methods': 'GET, HEAD' }); return res.end(); }
      req.cast = `/c/${cm[1]}.${cm[2]}`;
      pathname = cm[3];
      ctx.sess = { id: 'cast' };
      for (const r of routes) {
        if (r.level !== 'site' || (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD'))) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
        const out = await r.handler(req, res, params, u.searchParams, ctx);
        if (!res.headersSent && out !== undefined) sendJSON(res, 200, out);
        return;
      }
      throw new HttpError(404, 'Not found');
    }

    // Exports with the access key.
    const km = pathname.match(/^\/k\/([a-f0-9]+)\/(playlist\.m3u|epg\.xml|file\/([^/]+)\/([^/]+))$/);
    if (km) {
      if (!crypto.timingSafeEqual(Buffer.from(km[1].padEnd(24).slice(0, 24)), Buffer.from(String(settings().exportKey).padEnd(24).slice(0, 24))) || km[1] !== settings().exportKey) throw new HttpError(401, 'Wrong access key');
      if (km[2] === 'playlist.m3u') return exportM3U(req, res, km[1]);
      if (km[2] === 'epg.xml') return exportXmltv(req, res);
      const li = lists.libraryItem(km[3], km[4]);
      if (!li) throw new HttpError(404, 'Not found');
      return serveFile(req, res, li.path);
    }

    ctx.sess = accounts.session(req);
    if (ctx.sess && ctx.sess.profileId) ctx.profile = accounts.profile(ctx.sess.profileId);
    // Keep the browser's cookie as fresh as the session: renewed once a day when the app is opened, so a device in
    // regular use never has to sign in again.
    if (ctx.sess && (pathname === '/' || pathname === '/api/boot') && Date.now() - (ctx.sess.cookieAt || ctx.sess.created) > 86400e3) {
      ctx.sess.cookieAt = Date.now();
      accounts.store.save();
      res.setHeader('Set-Cookie', accounts.cookie(accounts.token(req), secureReq(req)));
    }

    // CSRF: changes must come from our own pages (a custom header can't be sent cross-site without CORS approval).
    if (pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method) && req.headers['x-app'] !== '1') throw new HttpError(403, 'Missing X-App header');

    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        if (r.level !== 'public' && !ctx.sess) throw new HttpError(401, 'Sign in required');
        if (r.level === 'profile' && !ctx.profile) throw new HttpError(403, 'Choose a profile first.');
        const params = {};
        r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
        const out = await r.handler(req, res, params, u.searchParams, ctx);
        if (!res.headersSent && out !== undefined) sendJSON(res, 200, out);
        return;
      }
      throw new HttpError(ctx.sess ? 404 : 401, ctx.sess ? 'Not found' : 'Sign in required');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');

    // Signed out: the sign-in page and a neutral icon are all there is.
    if (!ctx.sess) {
      if (pathname === '/favicon.ico' || pathname === '/icon.svg') return serveFile(req, res, path.join(PUBLIC, 'icon.svg'), { cache: 'max-age=86400' });
      if (pathname !== '/') { res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' }); return res.end(); }
      return sendText(res, 200, LOGIN_HTML(), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
    }
    const b = getBundle();
    if (pathname === '/app.js') return sendGz(req, res, b.js.raw, b.js.gz, 'text/javascript; charset=utf-8', b.js.etag);
    if (pathname === '/app.css') return sendGz(req, res, b.css.raw, b.css.gz, 'text/css; charset=utf-8', b.css.etag);
    if (pathname === '/sw.js') return sendGz(req, res, b.sw.raw, b.sw.gz, 'text/javascript; charset=utf-8', b.sw.etag);
    if (pathname === '/manifest.webmanifest') {
      const s = settings();
      return sendText(res, 200, JSON.stringify({
        name: s.brand.name, short_name: s.brand.name.slice(0, 14), start_url: '/', display: 'standalone', background_color: '#0b0d12', theme_color: '#0b0d12',
        icons: [{ src: '/brand-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }, { src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
      }), 'application/manifest+json');
    }
    if (pathname === '/brand-icon.svg') {
      const s = settings();
      const logo = s.brand.logo || '';
      if (/^data:image\//.test(logo)) {
        const m = logo.match(/^data:(image\/[a-z+.-]+);base64,(.*)$/i);
        if (m) { const buf = Buffer.from(m[2], 'base64'); res.writeHead(200, { 'Content-Type': m[1], 'Content-Length': buf.length, 'Cache-Control': 'no-cache' }); return res.end(buf); }
      }
      return serveFile(req, res, path.join(PUBLIC, 'icon.svg'));
    }
    if (pathname === '/' || !path.extname(pathname)) return sendText(res, 200, appHtml(), 'text/html; charset=utf-8', { 'Cache-Control': 'no-cache', 'X-Page': 'app' });
    const file = path.join(PUBLIC, path.normalize(pathname.slice(1)));
    if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(403, 'Forbidden');
    return serveFile(req, res, file, { cache: pathname.startsWith('/vendor/') ? 'public, max-age=2592000, immutable' : 'no-cache' });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500 && ![501, 502, 503, 504].includes(status)) console.error(err);
    if (!res.headersSent) sendJSON(res, status, { error: err.message || 'Server error' });
    else res.destroy();
  }
}

const tls = cfg.httpsCert && cfg.httpsKey ? { cert: fs.readFileSync(cfg.httpsCert), key: fs.readFileSync(cfg.httpsKey) } : null;
const server = tls ? https.createServer(tls, handle) : http.createServer(handle);
server.keepAliveTimeout = 65000;
server.requestTimeout = 0;
server.headersTimeout = 70000;

function shutdown() {
  log('Shutting down…');
  media.stopAll();
  JsonFile.flushAll();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// A home server should keep running: log unexpected errors instead of dropping everyone's streams.
process.on('uncaughtException', (e) => { console.error('Unexpected error (the server keeps running):', e && e.stack || e); });
process.on('unhandledRejection', (e) => { console.error('Unhandled promise rejection (the server keeps running):', e && e.stack || e); });

(async () => {
  const ff = await media.detect();
  lists.loadSaved();
  for (const g of lists.guides()) if (!g.enabled) epg.removeSource(g.id);
  epg.setOrder(lists.guides().filter((g) => g.enabled).map((g) => g.id));
  rebuildCatalog();
  buildBundle();
  server.listen(cfg.port, cfg.host, () => {
    const shown = ['0.0.0.0', '::'].includes(cfg.host) ? 'localhost' : cfg.host;
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log('');
    console.log(`  ${settings().brand.name} ${cfg.version} is running`);
    console.log(`  ➜ Open      ${tls ? 'https' : 'http'}://${shown}:${cfg.port}`);
    for (const ip of ['0.0.0.0', '::'].includes(cfg.host) ? ips : []) console.log(`  ➜ Network   ${tls ? 'https' : 'http'}://${ip}:${cfg.port}`);
    console.log(`  ➜ Data      ${D}`);
    console.log(`  ➜ ffmpeg    ${ff.ffmpeg ? `found (${ff.version})` : 'NOT FOUND – conversion of MKV/AVI/HEVC/RTMP etc. is off'}`);
    if (accounts.presetApplied) console.log(`  ➜ Password  changed to the new one in ${process.env.SITE_PASSWORD ? "SITE_PASSWORD" : "defaults.json"} — everyone has been signed out`);
    else if (accounts.d.site.isDefault) console.log(`  ➜ Password  the site password is still the default (${defaultPassword}) — change it in Admin`);
    console.log('');
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${cfg.port} is already in use. Start with --port 8081 (or set PORT).`);
    else console.error(e);
    process.exit(1);
  });
  lists.startScheduler();
})();
