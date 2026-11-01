'use strict';
/**
 * The merged, cleaned-up catalogue for other apps:
 *  - an Xtream Codes login per profile (TiviMate, IPTV Smarters, OTT Navigator… on a TV box), showing exactly what
 *    that profile may watch: languages, kids, age limit, types, blocked categories;
 *  - an HDHomeRun tuner on the local network (Plex, Jellyfin, Emby add it as a TV tuner).
 * Both are off until the admin turns them on. Streams go straight from the provider when the app can play them
 * (a redirect); otherwise this server relays them.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { JsonFile } = require('./store');
const { HttpError, sendJSON, sendText, log } = require('./util');
const { fetchAny } = require('./net');

// ------------------------------------------------------------ small helpers
function fnv31(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h & 0x7fffffff) || 1;
}
const xmlEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const extOf = (u, dflt) => { const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(String(u || '').split('?')[0]); return m ? m[1].toLowerCase() : dflt; };
const b64 = (s) => Buffer.from(String(s || ''), 'utf8').toString('base64');
const pad = (n) => String(n).padStart(2, '0');
const fmtXt = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
const fmtXmltv = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`; };
const slug = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'user';

/** Is this a local-network (or this machine's / Tailscale's) address? */
function privateIp(ip) {
  const v = String(ip || '').replace(/^::ffff:/, '');
  return /^(127\.|10\.|192\.168\.|169\.254\.)/.test(v) || /^172\.(1[6-9]|2\d|3[01])\./.test(v) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v) || v === '::1' || /^f[cd][0-9a-f]{2}:/i.test(v) || /^fe80:/i.test(v);
}

/** Writes a big JSON array a slice at a time (no huge string, the server keeps answering in between). */
async function streamJsonArray(res, iter, head = '[', tail = ']') {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.write(head);
  let first = true, buf = [];
  const flush = async () => {
    if (!buf.length) return;
    const ok = res.write((first ? '' : ',') + buf.join(','));
    first = false; buf = [];
    if (!ok) await new Promise((r) => res.once('drain', r));
    else await new Promise((r) => setImmediate(r));
  };
  for (const o of iter) {
    buf.push(JSON.stringify(o));
    if (buf.length >= 500) await flush();
    if (res.destroyed) return;
  }
  await flush();
  res.end(tail);
}

class Outputs {
  /**
   * d: { dir, catalog, lists, accounts, epg, settings(), hiddenFor(pid), inputOf(it), relayPath(url, headers),
   *      videoViaProxy(listId), connLimit(it), usage(listId) → streams in use, serveLocal(req, res, it), media }
   */
  constructor(d) {
    this.d = d;
    this.store = new JsonFile(path.join(d.dir, 'outputs.json'), { xtream: { enabled: false }, hdhr: { enabled: false, tuners: 2, profile: '', deviceId: '' }, logins: {} });
    if (!this.store.data.hdhr.deviceId) { this.store.data.hdhr.deviceId = crypto.randomBytes(4).toString('hex').toUpperCase(); this.store.save(); }
    this.authCache = new Map(); // sha(user:pass) → { pid, until }
    this.fails = new Map(); // ip → { n, since, blockedUntil }
    this.ids = null; // { version, byId: Map(id → key) }
    this.active = new Map(); // stream id → { kind, pid, k, n, since, ip, bytes }
    this.seq = 0;
  }

  get cfg() { return this.store.data; }

  // ------------------------------------------------------------ admin
  view(host) {
    const c = this.cfg;
    const base = host ? `http://${host}` : '';
    return {
      xtream: { enabled: !!c.xtream.enabled, server: base },
      hdhr: { enabled: !!c.hdhr.enabled, tuners: c.hdhr.tuners || 2, profile: c.hdhr.profile || '', deviceId: c.hdhr.deviceId, address: base },
      logins: Object.entries(c.logins).map(([pid, x]) => ({ profile: pid, user: x.user, createdAt: x.createdAt })),
      active: [...this.active.values()].map((a) => ({ kind: a.kind, profile: a.pid, n: a.n, since: a.since, ip: a.ip, bytes: a.bytes })),
    };
  }

  update(patch) {
    const c = this.cfg;
    if (patch.xtream && 'enabled' in patch.xtream) c.xtream.enabled = !!patch.xtream.enabled;
    if (patch.hdhr) {
      if ('enabled' in patch.hdhr) c.hdhr.enabled = !!patch.hdhr.enabled;
      if ('tuners' in patch.hdhr) c.hdhr.tuners = Math.max(1, Math.min(8, parseInt(patch.hdhr.tuners, 10) || 2));
      if ('profile' in patch.hdhr) c.hdhr.profile = String(patch.hdhr.profile || '');
    }
    this.store.save();
  }

  /** Sets (or makes up) a profile's password for the Xtream login. Returns it once, in clear. */
  setLogin(pid, password) {
    const p = this.d.accounts.profile(pid);
    if (!p) throw new HttpError(404, 'Profile not found');
    const pw = password ? String(password) : crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);
    if (pw.length < 6) throw new HttpError(400, 'Use at least 6 characters.');
    const taken = new Set(Object.entries(this.cfg.logins).filter(([id]) => id !== pid).map(([, x]) => x.user));
    let user = (this.cfg.logins[pid] && this.cfg.logins[pid].user) || slug(p.name);
    for (let i = 2; taken.has(user); i++) user = slug(p.name) + i;
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32).toString('hex');
    this.cfg.logins[pid] = { user, salt, hash, createdAt: Date.now() };
    this.store.save();
    this.authCache.clear();
    return { user, password: pw };
  }

  removeLogin(pid) { delete this.cfg.logins[pid]; this.store.save(); this.authCache.clear(); }

  // ------------------------------------------------------------ sign-in for the Xtream login
  _auth(req, user, pass) {
    const ip = this.d.clientIp(req);
    const f = this.fails.get(ip);
    if (f && f.blockedUntil > Date.now()) throw new HttpError(429, 'Too many wrong passwords. Try again later.');
    const key = crypto.createHash('sha256').update(`${user}\n${pass}`).digest('hex');
    const hit = this.authCache.get(key);
    if (hit && hit.until > Date.now() && this.cfg.logins[hit.pid]) return this.d.accounts.profile(hit.pid);
    const entry = Object.entries(this.cfg.logins).find(([, x]) => x.user === String(user || '').toLowerCase());
    let ok = false;
    if (entry && pass) {
      const want = Buffer.from(entry[1].hash, 'hex');
      const got = crypto.scryptSync(String(pass), Buffer.from(entry[1].salt, 'hex'), 32);
      ok = got.length === want.length && crypto.timingSafeEqual(got, want);
    }
    const prof = ok && this.d.accounts.profile(entry[0]);
    if (!prof) {
      const r = f && Date.now() - f.since < 15 * 60e3 ? f : { n: 0, since: Date.now(), blockedUntil: 0 };
      r.n++;
      if (r.n >= 10) r.blockedUntil = Date.now() + 15 * 60e3;
      this.fails.set(ip, r);
      if (this.fails.size > 5000) this.fails.clear();
      return null;
    }
    this.fails.delete(ip);
    if (this.authCache.size > 1000) this.authCache.clear();
    this.authCache.set(key, { pid: prof.id, until: Date.now() + 10 * 60e3 });
    return prof;
  }

  // ------------------------------------------------------------ numbers for the catalogue
  /** Stable numeric ids (Xtream apps want numbers): a hash of the item's key, moved on by one when two collide. */
  _idMap() {
    const cat = this.d.catalog;
    if (this.ids && this.ids.version === cat.version) return this.ids;
    const byId = new Map();
    for (const it of cat.items) this._place(byId, it.k);
    this.ids = { version: cat.version, byId };
    return this.ids;
  }
  _place(byId, k) {
    let h = fnv31(k);
    while (byId.has(h) && byId.get(h) !== k) h = (h % 0x7ffffffe) + 1;
    byId.set(h, k);
    return h;
  }
  idOf(k) {
    const { byId } = this._idMap();
    let h = fnv31(k);
    for (let i = 0; i < 64; i++) { const v = byId.get(h); if (v === k) return h; if (v === undefined) return this._place(byId, k); h = (h % 0x7ffffffe) + 1; }
    return this._place(byId, k);
  }
  keyOf(id) { return this._idMap().byId.get(Number(id)) || null; }
  catId(t, g) { return String(fnv31(`c|${t}|${g}`) % 900000 + 1000); }

  /** The items a profile may see, of one kind (live: live+radio; movie; show), never the in-app-only ones. */
  *_visible(prof, kind) {
    const f = this.d.catalog.filterFor(prof);
    const hidden = this.d.hiddenFor(prof.id);
    for (const it of this.d.catalog.items) {
      const t = it.t;
      if (kind === 'live' ? t !== 'live' && t !== 'radio' : t !== kind) continue;
      if (kind !== 'show' && !it.u) continue;
      if (/^mych:/.test(it.u || '')) continue; // (24/7 channels are played by the app itself)
      if (hidden.has(it.k) || !f.test(it)) continue;
      yield it;
    }
  }

  _cats(prof, kind) {
    const seen = new Map();
    for (const it of this._visible(prof, kind)) if (!seen.has(it.g)) seen.set(it.g, { category_id: this.catId(kind, it.g), category_name: it.g, parent_id: 0 });
    return [...seen.values()];
  }

  // ------------------------------------------------------------ Xtream: player_api.php
  _userInfo(prof, user, pass, req) {
    const limits = this.d.lists.all().map((l) => parseInt(l.account && l.account.maxConnections, 10)).filter((n) => n > 0);
    const now = Math.floor(Date.now() / 1000);
    const host = String(req.headers.host || 'localhost');
    const [hn, port] = host.includes(']') ? [host.replace(/:\d+$/, ''), (host.match(/:(\d+)$/) || [])[1]] : host.split(':');
    return {
      user_info: {
        username: user, password: pass, message: '', auth: 1, status: 'Active', exp_date: null, is_trial: '0', active_cons: String([...this.active.values()].filter((a) => a.pid === prof.id).length),
        created_at: String(Math.floor(((this.cfg.logins[prof.id] || {}).createdAt || Date.now()) / 1000)), max_connections: String(limits.length ? Math.max(...limits) : 1),
        allowed_output_formats: ['m3u8', 'ts'],
      },
      server_info: { url: hn, port: port || (req.socket.encrypted ? '443' : '80'), https_port: '', server_protocol: req.socket.encrypted ? 'https' : 'http', rtmp_port: '', timezone: 'UTC', timestamp_now: now, time_now: fmtXt(Date.now()), process: true },
    };
  }

  async playerApi(req, res, q) {
    const user = q.get('username'), pass = q.get('password');
    const prof = this._auth(req, user, pass);
    if (!prof) return sendJSON(res, 401, { user_info: { auth: 0 } });
    const action = q.get('action') || '';
    const cat = q.get('category_id') || '';
    const self = this;
    if (!action) return sendJSON(res, 200, this._userInfo(prof, user, pass, req));
    if (action === 'get_live_categories') return sendJSON(res, 200, this._cats(prof, 'live'));
    if (action === 'get_vod_categories') return sendJSON(res, 200, this._cats(prof, 'movie'));
    if (action === 'get_series_categories') return sendJSON(res, 200, this._cats(prof, 'show'));
    if (action === 'get_live_streams') {
      let n = 0;
      return streamJsonArray(res, (function* () {
        for (const it of self._visible(prof, 'live')) {
          const c = self.catId('live', it.g);
          if (cat && cat !== c) continue;
          yield { num: ++n, name: it.n, stream_type: it.t === 'radio' ? 'radio_streams' : 'live', stream_id: self.idOf(it.k), stream_icon: it.logo || '', epg_channel_id: it.epg ? String(self.idOf(it.k)) : '', added: String(Math.floor((it.ad || 0) / 1000)), is_adult: it.adult ? '1' : '0', category_id: c, category_ids: [Number(c)], custom_sid: '', tv_archive: 0, direct_source: '', tv_archive_duration: 0 };
        }
      })());
    }
    if (action === 'get_vod_streams') {
      let n = 0;
      return streamJsonArray(res, (function* () {
        for (const it of self._visible(prof, 'movie')) {
          const c = self.catId('movie', it.g);
          if (cat && cat !== c) continue;
          yield { num: ++n, name: it.y && !/\(\d{4}\)$/.test(it.n) ? `${it.n} (${it.y})` : it.n, stream_type: 'movie', stream_id: self.idOf(it.k), stream_icon: it.poster || it.logo || '', rating: it.r ? String(it.r) : '', rating_5based: it.r ? Math.round(it.r * 5) / 10 : 0, added: String(Math.floor((it.ad || 0) / 1000)), is_adult: it.adult ? '1' : '0', category_id: c, category_ids: [Number(c)], container_extension: extOf(it.u, 'mp4'), custom_sid: '', direct_source: '' };
        }
      })());
    }
    if (action === 'get_series') {
      let n = 0;
      return streamJsonArray(res, (function* () {
        for (const it of self._visible(prof, 'show')) {
          const c = self.catId('show', it.g);
          if (cat && cat !== c) continue;
          yield { num: ++n, name: it.n, series_id: self.idOf(it.k), cover: it.poster || it.logo || '', plot: it.plot || '', cast: it.cast || '', director: it.dir || '', genre: (it.gn || []).join(', '), releaseDate: it.y ? String(it.y) : '', last_modified: String(Math.floor((it.ad || 0) / 1000)), rating: it.r ? String(it.r) : '', rating_5based: it.r ? Math.round(it.r * 5) / 10 : 0, backdrop_path: it.bd ? [it.bd] : [], youtube_trailer: it.tr || '', episode_run_time: '', category_id: c, category_ids: [Number(c)] };
        }
      })());
    }
    if (action === 'get_series_info') {
      const k = this.keyOf(q.get('series_id'));
      const show = k && this.d.catalog.visible(prof, k);
      if (!show || show.t !== 'show') return sendJSON(res, 200, { seasons: [], info: {}, episodes: {} });
      const eps = await this.d.catalog.episodes(show.k).catch(() => []);
      const by = {};
      for (const e of eps) {
        if (!e.u) continue;
        (by[e.s] || (by[e.s] = [])).push({ id: String(this.idOf(e.k)), episode_num: e.e, title: e.et ? `${show.n} - S${pad(e.s)}E${pad(e.e)} - ${e.et}` : e.n, container_extension: extOf(e.u, 'mp4'), info: { duration_secs: e.d || 0, duration: e.d ? new Date(e.d * 1000).toISOString().slice(11, 19) : '', plot: e.plot || '', movie_image: e.logo || '', rating: e.r || 0 }, custom_sid: '', added: '', season: e.s, direct_source: '' });
      }
      return sendJSON(res, 200, {
        seasons: Object.keys(by).map((s) => ({ season_number: Number(s), name: `Season ${s}`, episode_count: by[s].length, cover: show.poster || show.logo || '' })),
        info: { name: show.n, cover: show.poster || show.logo || '', plot: show.plot || '', cast: show.cast || '', director: show.dir || '', genre: (show.gn || []).join(', '), releaseDate: show.y ? String(show.y) : '', rating: show.r ? String(show.r) : '', backdrop_path: show.bd ? [show.bd] : [], youtube_trailer: show.tr || '', category_id: this.catId('show', show.g) },
        episodes: by,
      });
    }
    if (action === 'get_vod_info') {
      const k = this.keyOf(q.get('vod_id'));
      const it = k && this.d.catalog.visible(prof, k);
      if (!it || it.t !== 'movie') return sendJSON(res, 200, { info: {}, movie_data: {} });
      await this.d.catalog.details(it.k).catch(() => {});
      return sendJSON(res, 200, {
        info: { name: it.n, movie_image: it.poster || it.logo || '', plot: it.plot || '', description: it.plot || '', cast: it.cast || '', director: it.dir || '', genre: (it.gn || []).join(', '), releasedate: it.y ? String(it.y) : '', duration_secs: it.d || 0, duration: it.d ? new Date(it.d * 1000).toISOString().slice(11, 19) : '', rating: it.r ? String(it.r) : '', backdrop_path: it.bd ? [it.bd] : [], youtube_trailer: it.tr || '', tmdb_id: it.tmdb || '' },
        movie_data: { stream_id: this.idOf(it.k), name: it.n, added: String(Math.floor((it.ad || 0) / 1000)), category_id: this.catId('movie', it.g), container_extension: extOf(it.u, 'mp4'), custom_sid: '', direct_source: '' },
      });
    }
    if (action === 'get_short_epg' || action === 'get_simple_data_table') {
      const k = this.keyOf(q.get('stream_id'));
      const it = k && this.d.catalog.visible(prof, k);
      if (!it || !it.epg) return sendJSON(res, 200, { epg_listings: [] });
      const now = Date.now();
      const full = action === 'get_simple_data_table';
      let list = this.d.epg.range(it.epg, full ? now - 86400e3 : now - 3 * 3600e3, now + (full ? 2 : 1) * 86400e3);
      if (!full) list = list.filter((x) => x.e > now).slice(0, Math.max(1, Math.min(50, parseInt(q.get('limit'), 10) || 4)));
      const id = this.idOf(it.k);
      return sendJSON(res, 200, { epg_listings: list.map((x, i) => ({ id: String(x.s / 1000 + i), epg_id: String(id), title: b64(x.t), lang: '', start: fmtXt(x.s), end: fmtXt(x.e), description: b64(x.d || ''), channel_id: String(id), start_timestamp: String(Math.floor(x.s / 1000)), stop_timestamp: String(Math.floor(x.e / 1000)), now_playing: x.s <= now && x.e > now ? 1 : 0, has_archive: 0 })) });
    }
    return sendJSON(res, 200, []);
  }

  // ------------------------------------------------------------ Xtream: playlist and guide for that login
  async m3u(req, res, q) {
    const user = q.get('username'), pass = q.get('password');
    const prof = this._auth(req, user, pass);
    if (!prof) return sendText(res, 401, 'Wrong username or password');
    const base = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
    const ext = q.get('output') === 'm3u8' || q.get('output') === 'hls' ? 'm3u8' : 'ts';
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl; charset=utf-8', 'Content-Disposition': 'inline; filename="playlist.m3u"' });
    res.write(`#EXTM3U url-tvg="${base}/xmltv.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}"\n`);
    let lines = [];
    const U = encodeURIComponent(user), P = encodeURIComponent(pass);
    const line = (it, kind, e) => `#EXTINF:-1 tvg-id="${it.epg ? this.idOf(it.k) : ''}" tvg-name="${it.n.replace(/"/g, "'")}" tvg-logo="${(it.poster || it.logo || '').replace(/"/g, '%22')}" group-title="${String(it.g).replace(/"/g, "'")}",${it.n}\n${base}/${kind}/${U}/${P}/${this.idOf(it.k)}.${e}\n`;
    const flush = async () => { if (!lines.length) return; const ok = res.write(lines.join('')); lines = []; if (!ok) await new Promise((r) => res.once('drain', r)); else await new Promise((r) => setImmediate(r)); };
    for (const it of this._visible(prof, 'live')) { lines.push(line(it, 'live', ext)); if (lines.length >= 500) await flush(); }
    if (q.get('type') !== 'm3u') for (const it of this._visible(prof, 'movie')) { lines.push(line(it, 'movie', extOf(it.u, 'mp4'))); if (lines.length >= 500) await flush(); }
    await flush();
    res.end();
  }

  async xmltv(req, res, q, prof) {
    if (!prof) {
      prof = this._auth(req, q.get('username'), q.get('password'));
      if (!prof) return sendText(res, 401, 'Wrong username or password');
    }
    return this._writeXmltv(res, this._visible(prof, 'live'), (it) => String(this.idOf(it.k)), (it) => [it.n]);
  }

  async _writeXmltv(res, items, idOf, namesOf) {
    const epg = this.d.epg;
    const now = Date.now();
    const days = Number(this.d.settings().epgDays) || 3;
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' });
    res.write('<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="browser-iptv-player">\n');
    const list = [...items].filter((it) => it.epg);
    let buf = [];
    const flush = async () => { if (!buf.length) return; const ok = res.write(buf.join('')); buf = []; if (!ok) await new Promise((r) => res.once('drain', r)); else await new Promise((r) => setImmediate(r)); };
    for (const it of list) {
      buf.push(`<channel id="${xmlEsc(idOf(it))}">${namesOf(it).map((n) => `<display-name>${xmlEsc(n)}</display-name>`).join('')}${it.logo ? `<icon src="${xmlEsc(it.logo)}"/>` : ''}</channel>\n`);
      if (buf.length >= 300) await flush();
    }
    for (const it of list) {
      for (const x of epg.range(it.epg, now - 2 * 3600e3, now + days * 86400e3)) {
        buf.push(`<programme start="${fmtXmltv(x.s)}" stop="${fmtXmltv(x.e)}" channel="${xmlEsc(idOf(it))}"><title>${xmlEsc(x.t)}</title>${x.st ? `<sub-title>${xmlEsc(x.st)}</sub-title>` : ''}${x.d ? `<desc>${xmlEsc(x.d)}</desc>` : ''}${(x.c || []).map((c) => `<category>${xmlEsc(c)}</category>`).join('')}</programme>\n`);
      }
      if (buf.length >= 300) await flush();
      if (res.destroyed) return;
    }
    await flush();
    res.end('</tv>\n');
  }

  // ------------------------------------------------------------ streams
  /** Where an app should get an item's stream: { redirect } (straight from the provider), { local }, or { relay }. */
  async _target(it) {
    if (it.loc) return { local: true };
    let url = it.u;
    if (/^\/api\/proxy\/stalker\//.test(url)) {
      const m = url.match(/^\/api\/proxy\/stalker\/([^/]+)\/([^/]+)\/([^/?]+)/);
      url = await this.d.lists.stalkerLink(m[1], m[2], decodeURIComponent(m[3]));
    }
    if (!/^(https?|rtmp|rtsp|udp|rtp):\/\//i.test(url || '')) throw new HttpError(404, 'This can only be played in the app.');
    const needsHeaders = it.h && Object.keys(it.h).length;
    if (needsHeaders || this.d.videoViaProxy(it.src)) {
      if (!/^https?:/i.test(url)) throw new HttpError(404, 'This can only be played in the app.');
      return { relay: this.d.relayPath(url, it.h || {}) };
    }
    return { redirect: url };
  }

  async xtStream(req, res, kind, user, pass, idExt) {
    const prof = this._auth(req, user, pass);
    if (!prof) throw new HttpError(401, 'Wrong username or password');
    const id = String(idExt).replace(/\.[a-z0-9]+$/i, '');
    const k = this.keyOf(id);
    const it = k && this.d.catalog.visible(prof, k);
    if (!it) throw new HttpError(404, 'Not found');
    const t = await this._target(it);
    this._note(req, 'xtream', prof.id, it, null);
    if (t.local) return this.d.serveLocal(req, res, it);
    res.writeHead(302, { Location: t.redirect || t.relay, 'Cache-Control': 'no-store' });
    res.end();
  }

  /** Apps that are sent straight to the provider can't be watched: remember them for a while for "in use". */
  _note(req, kind, pid, it, bytes) {
    const id = `${kind}:${pid}:${this.d.clientIp(req)}`;
    this.active.set(id, { kind, pid, k: it.k, n: it.n, since: (this.active.get(id) || {}).since || Date.now(), ip: this.d.clientIp(req), bytes: bytes || 0, at: Date.now(), list: it.src });
    for (const [x, a] of this.active) if (!a.live && Date.now() - a.at > 4 * 3600e3) this.active.delete(x);
  }

  // ------------------------------------------------------------ HDHomeRun
  _hdhrProfile() {
    const pid = this.cfg.hdhr.profile;
    return (pid && this.d.accounts.profile(pid)) || this.d.accounts.profiles.find((p) => p.admin) || null;
  }
  _lineup() {
    const prof = this._hdhrProfile();
    if (!prof) return [];
    const cat = this.d.catalog;
    if (this._lu && this._lu.version === cat.version && this._lu.pid === prof.id) return this._lu.list;
    const used = new Set();
    const list = [];
    const items = [...this._visible(prof, 'live')].filter((it) => it.t === 'live');
    for (const it of items) if (it.num && !used.has(String(it.num))) { used.add(String(it.num)); it._hn = String(it.num); } else it._hn = '';
    for (const it of items) {
      let n = it._hn;
      if (!n) { let h = fnv31(it.k) % 90000 + 10000; while (used.has(String(h))) h = h >= 99999 ? 10000 : h + 1; n = String(h); used.add(n); }
      delete it._hn;
      list.push({ num: n, it });
    }
    list.sort((a, b) => Number(a.num) - Number(b.num));
    this._lu = { version: cat.version, pid: prof.id, list };
    return list;
  }

  async hdhr(req, res, pathname) {
    const c = this.cfg.hdhr;
    const base = `http://${req.headers.host}`;
    if (pathname === '/discover.json') {
      return sendJSON(res, 200, { FriendlyName: `${(this.d.settings().brand || {}).name || 'IPTV Player'} tuner`, Manufacturer: 'Silicondust', ManufacturerURL: 'https://github.com/austin-72/browser-iptv-player', ModelNumber: 'HDTC-2US', FirmwareName: 'hdhomeruntc_atsc', FirmwareVersion: '20200101', DeviceID: c.deviceId, DeviceAuth: 'browseriptv', BaseURL: base, LineupURL: `${base}/lineup.json`, TunerCount: c.tuners || 2 });
    }
    if (pathname === '/lineup_status.json') return sendJSON(res, 200, { ScanInProgress: 0, ScanPossible: 1, Source: 'Cable', SourceList: ['Cable'] });
    if (pathname === '/lineup.post') { res.writeHead(200); return res.end(); }
    if (pathname === '/lineup.json' || pathname === '/lineup.m3u') {
      const lu = this._lineup();
      if (pathname === '/lineup.m3u') return sendText(res, 200, '#EXTM3U\n' + lu.map((x) => `#EXTINF:-1 tvg-chno="${x.num}" tvg-id="${x.num}" tvg-logo="${x.it.logo || ''}",${x.it.n}\n${base}/auto/v${x.num}\n`).join(''), 'audio/x-mpegurl');
      return sendJSON(res, 200, lu.map((x) => ({ GuideNumber: x.num, GuideName: x.it.n, URL: `${base}/auto/v${x.num}` })));
    }
    if (pathname === '/device.xml') {
      return sendText(res, 200, `<?xml version="1.0" encoding="UTF-8"?><root xmlns="urn:schemas-upnp-org:device-1-0"><URLBase>${base}</URLBase><specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><friendlyName>IPTV Player tuner</friendlyName><manufacturer>Silicondust</manufacturer><modelName>HDTC-2US</modelName><modelNumber>HDTC-2US</modelNumber><serialNumber>${c.deviceId}</serialNumber><UDN>uuid:${c.deviceId}-0000-0000-0000-000000000000</UDN></device></root>`, 'application/xml');
    }
    if (pathname === '/hdhr/epg.xml' || pathname === '/epg.xml') {
      const lu = this._lineup();
      const num = new Map(lu.map((x) => [x.it, x.num]));
      return this._writeXmltv(res, lu.map((x) => x.it), (it) => num.get(it), (it) => [num.get(it), it.n]);
    }
    const m = pathname.match(/^\/auto\/v(\d+(?:\.\d+)?)$/);
    if (m) return this._hdhrStream(req, res, m[1]);
    throw new HttpError(404, 'Not found');
  }

  async _hdhrStream(req, res, num) {
    const x = this._lineup().find((y) => y.num === num);
    if (!x) throw new HttpError(404, 'No such channel');
    const it = x.it;
    const mine = [...this.active.values()].filter((a) => a.kind === 'hdhr' && a.live);
    if (mine.length >= (this.cfg.hdhr.tuners || 2)) throw new HttpError(503, 'All tuners are in use');
    // The provider's connections: the household's viewers, plus this server's own tuner streams on that list.
    const limit = this.d.connLimit(it);
    if (limit > 0 && this.d.usage(it.src) + mine.filter((a) => a.list === it.src).length >= limit) throw new HttpError(503, 'The provider has no free connection right now');
    const src = this.d.inputOf(it);
    if (!src) throw new HttpError(404, 'Not playable');
    let input = src.input;
    if (/^\/api\/proxy\/stalker\//.test(it.u)) input = await this._target(it).then((t) => t.redirect || t.relay);
    const id = `hdhr:${++this.seq}`;
    const rec = { kind: 'hdhr', pid: this._hdhrProfile().id, k: it.k, n: it.n, since: Date.now(), ip: this.d.clientIp(req), bytes: 0, live: true, list: it.src, at: Date.now() };
    this.active.set(id, rec);
    const done = () => this.active.delete(id);
    res.on('close', done);
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store', Connection: 'close' });
    // Already MPEG-TS over HTTP: pass the bytes on. Anything else (HLS…): ffmpeg repackages it, no re-encoding.
    const isTs = /^https?:/i.test(input) && /\.ts(\?|$)|\/live\/[^/]+\/[^/]+\/\d+$/i.test(input) && !src.local;
    if (isTs) {
      try {
        const up = await fetchAny(input, { headers: { 'User-Agent': this.d.settings().userAgent || 'VLC/3.0.21 LibVLC/3.0.21', ...(src.headers || {}) }, redirect: 'follow' });
        if (!up.ok) throw new Error(`HTTP ${up.status}`);
        const body = Readable.fromWeb(up.body);
        res.on('close', () => body.destroy());
        body.on('data', (ch) => { rec.bytes += ch.length; rec.at = Date.now(); });
        body.on('error', () => res.destroy());
        return void body.pipe(res);
      } catch (e) { log(`Tuner: ${it.n}: ${e.message}`); return res.destroy(); }
    }
    if (!this.d.media.available) { res.destroy(); return; }
    const hdr = Object.entries(src.headers || {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    const args = ['-hide_banner', '-loglevel', 'error', ...(hdr && /^https?:/i.test(input) ? ['-headers', hdr] : []), '-i', input, '-map', '0:v:0?', '-map', '0:a?', '-c', 'copy', '-f', 'mpegts', 'pipe:1'];
    const ff = spawn(this.d.media.ffmpegBin || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    res.on('close', () => { try { ff.kill('SIGKILL'); } catch {} });
    ff.stdout.on('data', (ch) => { rec.bytes += ch.length; rec.at = Date.now(); });
    ff.stdout.pipe(res);
    ff.on('exit', () => res.end());
  }

  // ------------------------------------------------------------ routing (paths outside /api)
  /** Handles the outputs' own addresses; false when the path isn't one of them. */
  async handle(req, res, pathname, q) {
    const c = this.cfg;
    const xt = /^\/(player_api|get|xmltv|panel_api)\.php$/.exec(pathname);
    const xs = /^\/(api|c|k|h)\//.test(pathname) ? null : /^\/(live|movie|series)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(pathname) || /^\/()([^/]+)\/([^/]+)\/(\d+(?:\.[a-z0-9]+)?)$/i.exec(pathname);
    const hd = /^\/(discover\.json|lineup\.json|lineup\.m3u|lineup_status\.json|lineup\.post|device\.xml|epg\.xml|hdhr\/epg\.xml|auto\/v[\d.]+)$/.test(pathname);
    if (!xt && !xs && !hd) return false;
    if (xs && !xt && !c.xtream.enabled) return false;
    if (xt && !c.xtream.enabled) throw new HttpError(404, 'Not found');
    if (hd && !c.hdhr.enabled) return false;
    await this.d.ready();
    if (hd) {
      if (!privateIp(this.d.clientIp(req))) throw new HttpError(403, 'The tuner only answers on the local network.');
      await this.hdhr(req, res, pathname);
      return true;
    }
    if (xt) {
      if (xt[1] === 'player_api' || xt[1] === 'panel_api') await this.playerApi(req, res, q);
      else if (xt[1] === 'get') await this.m3u(req, res, q);
      else await this.xmltv(req, res, q);
      return true;
    }
    await this.xtStream(req, res, xs[1] === 'series' ? 'series' : xs[1] === 'movie' ? 'movie' : 'live', decodeURIComponent(xs[2]), decodeURIComponent(xs[3]), xs[4]);
    return true;
  }
}

module.exports = { Outputs, fnv31, privateIp, streamJsonArray };
