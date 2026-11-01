'use strict';
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { fetchAny } = require('./net');
const P = require('./parse');
const { parseXMLTV } = require('./xmltv');
const { Library } = require('./library');
const { JsonFile } = require('./store');
const { HttpError, uid, log, isUrl } = require('./util');

/** Write a file without blocking, and only replace the old copy once the new one is complete. */
async function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, file);
}

/**
 * Save a provider's (often 100 MB+) answer as JSON a slice at a time: JSON.stringify of the whole thing would hold
 * up the server for a second or more, and need a second copy of it in memory as one huge string.
 */
async function writeJsonSliced(file, data) {
  const tmp = file + '.tmp';
  const fh = await fs.promises.open(tmp, 'w');
  try {
    let first = true;
    await fh.write('{');
    for (const k of Object.keys(data)) {
      const v = data[k];
      if (v === undefined) continue;
      await fh.write((first ? '' : ',') + JSON.stringify(k) + ':');
      first = false;
      if (Array.isArray(v) && v.length > 2000) {
        await fh.write('[');
        for (let i = 0; i < v.length; i += 2000) await fh.write((i ? ',' : '') + v.slice(i, i + 2000).map((x) => (x === undefined ? 'null' : JSON.stringify(x))).join(','));
        await fh.write(']');
      } else await fh.write(JSON.stringify(v));
    }
    await fh.write('}');
  } finally { await fh.close(); }
  await fs.promises.rename(tmp, file);
}

const MAX_LIST_BYTES = 400 * 1024 * 1024;

/** Downloads a URL into a Buffer (any encoding; gzip handled by fetch), with a size limit. */
async function download(url, { ua, headers = {}, timeout = 180000, limit = MAX_LIST_BYTES } = {}) {
  let res;
  try {
    res = await fetchAny(url, { headers: { 'User-Agent': ua, Accept: '*/*', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    throw new Error(`Couldn’t download it: ${e.name === 'TimeoutError' ? 'timed out' : (e.cause && e.cause.message) || e.message}`);
  }
  if (!res.ok) throw new Error(`The server answered HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (check the address, login or that the account is active)' : ''}`);
  const chunks = [];
  let size = 0;
  for await (const c of Readable.fromWeb(res.body)) {
    size += c.length;
    if (size > limit) throw new Error('That file is too big.');
    chunks.push(c);
  }
  let buf = Buffer.concat(chunks);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = require('zlib').gunzipSync(buf);
  return buf;
}

function xtNorm(server) {
  let s = String(server || '').trim();
  if (!s) throw new HttpError(400, 'Enter the server address.');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch { throw new HttpError(400, 'That server address isn’t valid.'); }
  const username = u.searchParams.get('username'), password = u.searchParams.get('password');
  u.search = ''; u.hash = '';
  const p = u.pathname.replace(/\/(get|player_api|xmltv|panel_api)\.php$/i, '').replace(/\/+$/, '');
  return { server: u.origin + p, username, password };
}
const xq = (c, extra = {}) => new URLSearchParams({ username: c.username, password: c.password, ...extra }).toString();
const arr = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []);

/**
 * The admin's playlists ("lists") and guides. Each list is downloaded on a schedule, the last good copy is kept on
 * disk, and it's turned into plain items for the catalog. Kinds: url (any playlist format), file (uploaded),
 * xtream (Xtream Codes API), folder (media files on the server).
 */
class Lists {
  constructor({ dir, media, getSettings, onChange, onGuides }) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'xt'), { recursive: true });
    this.store = new JsonFile(path.join(dir, 'lists.json'), { lists: [], guides: [] });
    this.media = media;
    this.getSettings = getSettings;
    this.onChange = onChange || (() => {});
    this.onGuides = onGuides || (() => {});
    this.parsed = new Map(); // id -> { items, epgUrls, format, name }
    this.libraries = new Map();
    this.running = new Map();
    this.guideStatus = new Map();
  }

  get ua() { return this.getSettings().userAgent; }
  all() { return this.store.data.lists; }
  guides() { return this.store.data.guides; }
  get(id) { const l = this.all().find((x) => x.id === id); if (!l) throw new HttpError(404, 'List not found'); return l; }
  rawFile(l) { return path.join(this.dir, `${l.id}.${l.type === 'xtream' ? 'json' : 'raw'}`); }

  /** Public view for the admin pages (passwords masked). */
  view(l) {
    const out = { ...l };
    if (out.password) out.password = '••••••••';
    const lib = this.libraries.get(l.id);
    if (lib) out.library = lib.status();
    out.refreshing = this.running.has(l.id);
    return out;
  }

  // ------------------------------------------------------------ admin changes
  async add(spec, content) {
    const type = spec.type;
    if (!['url', 'file', 'xtream', 'folder'].includes(type)) throw new HttpError(400, 'Unknown list type');
    const l = {
      id: uid(), type, name: String(spec.name || '').trim(), enabled: true,
      refreshHours: Number(spec.refreshHours) >= 0 ? Number(spec.refreshHours) : 12,
      useGuide: spec.useGuide !== false, ua: String(spec.ua || '').trim(), lang: String(spec.lang || '').trim(),
      addedAt: Date.now(), status: { ok: false, error: null, count: 0, at: null },
    };
    if (type === 'url') {
      if (!isUrl(spec.url)) throw new HttpError(400, 'Enter a web address starting with http:// or https://');
      l.url = String(spec.url).trim();
      if (!l.name) { try { l.name = new URL(l.url).hostname; } catch {} }
    } else if (type === 'xtream') {
      const n = xtNorm(spec.server);
      l.server = n.server;
      l.username = String(spec.username || n.username || '').trim();
      l.password = String(spec.password || n.password || '').trim();
      if (!l.username || !l.password) throw new HttpError(400, 'Enter the username and password.');
      if (!l.name) l.name = new URL(l.server).hostname;
    } else if (type === 'file') {
      if (!content || !content.length) throw new HttpError(400, 'Choose a playlist file.');
      if (!l.name) l.name = String(spec.fileName || 'Uploaded list').replace(/\.[a-z0-9]+$/i, '');
      l.refreshHours = 0;
    } else if (type === 'folder') {
      const folders = (Array.isArray(spec.folders) ? spec.folders : [spec.folder]).map((f) => String(f || '').trim()).filter(Boolean).map((f) => path.resolve(f));
      if (!folders.length) throw new HttpError(400, 'Choose at least one folder.');
      const bad = folders.find((f) => !fs.existsSync(f) || !fs.statSync(f).isDirectory());
      if (bad) throw new HttpError(400, `Folder not found on the server: ${bad}`);
      l.folders = folders;
      if (!l.name) l.name = path.basename(folders[0]) || 'Media';
      l.refreshHours = 6;
    }
    // Make sure it works before saving it.
    if (type === 'file') fs.writeFileSync(this.rawFile(l), content);
    this.all().push(l);
    try {
      await this.refresh(l.id, { throwErrors: true });
    } catch (e) {
      this.store.data.lists = this.all().filter((x) => x.id !== l.id);
      try { fs.unlinkSync(this.rawFile(l)); } catch {}
      this.store.save();
      throw new HttpError(400, e.message);
    }
    this.store.save();
    this._syncGuides();
    return this.view(l);
  }

  update(id, patch) {
    const l = this.get(id);
    const before = `${l.url}|${l.server}|${l.username}`;
    for (const k of ['name', 'ua', 'lang']) if (k in patch) l[k] = String(patch[k] || '').trim();
    if ('enabled' in patch) l.enabled = !!patch.enabled;
    if ('useGuide' in patch) l.useGuide = !!patch.useGuide;
    if ('refreshHours' in patch) l.refreshHours = Math.max(0, Math.min(168, Number(patch.refreshHours) || 0));
    if ('proxy' in patch) l.proxy = String(patch.proxy || '').slice(0, 40); // '' = the default, 'none', or a proxy id
    if (l.type === 'url' && patch.url && isUrl(patch.url)) l.url = String(patch.url).trim();
    if (l.type === 'xtream') {
      if (patch.server) l.server = xtNorm(patch.server).server;
      if (patch.username) l.username = String(patch.username).trim();
      if (patch.password && !/^•+$/.test(patch.password)) l.password = String(patch.password).trim();
    }
    // A different account or address: the old connection test result doesn't apply.
    if (`${l.url}|${l.server}|${l.username}` !== before) delete l.connTest;
    this.store.save();
    this._syncGuides();
    if (patch.url || patch.server || patch.username || patch.password || patch.ua || 'proxy' in patch) this.refresh(id);
    else this.onChange();
    return this.view(l);
  }

  replaceFile(id, content) {
    const l = this.get(id);
    if (l.type !== 'file') throw new HttpError(400, 'Only uploaded lists can be replaced');
    fs.writeFileSync(this.rawFile(l), content);
    return this.refresh(id, { throwErrors: true }).then(() => this.view(l));
  }

  remove(id) {
    const l = this.get(id);
    this.store.data.lists = this.all().filter((x) => x.id !== id);
    for (const f of [this.rawFile(l), path.join(this.dir, `${id}.library.json`)]) { try { fs.unlinkSync(f); } catch {} }
    this.parsed.delete(id);
    this.libraries.delete(id);
    this.store.save();
    this._syncGuides();
    this.onChange();
  }

  reorder(ids) {
    const byId = new Map(this.all().map((l) => [l.id, l]));
    const next = ids.map((i) => byId.get(i)).filter(Boolean);
    for (const l of this.all()) if (!next.includes(l)) next.push(l);
    this.store.data.lists = next;
    this.store.save();
    this.onChange();
  }

  // ------------------------------------------------------------ loading
  /** Reads each list's saved copy at startup (no network), then refreshes anything that's due. */
  loadSaved() {
    for (const l of this.all()) {
      try { this._parseSaved(l); } catch (e) { log(`List “${l.name}”: saved copy unreadable (${e.message})`); }
    }
    this._syncGuides();
  }

  _parseSaved(l, quiet) {
    if (l.type === 'folder') { this._library(l); this.parsed.set(l.id, this._folderItems(l)); return; }
    const f = this.rawFile(l);
    // No saved copy (e.g. just restored from a backup, which leaves provider downloads out): fetch it soon.
    if (!fs.existsSync(f)) { if (l.status) { l.status.at = 0; l.status.triedAt = 0; } return; }
    const buf = fs.readFileSync(f);
    this.parsed.set(l.id, l.type === 'xtream' ? this._xtItems(l, JSON.parse(buf.toString('utf8'))) : this._parseText(l, P.decodeText(buf)));
    this._hosts(l);
  }

  /** A list's entries for building the catalogue: read again from the saved copy if they were released. */
  itemsFor(l) {
    const g = this.itemSteps(l);
    while (!g.next().done);
    return this.parsed.get(l.id);
  }
  /** The same, in steps (the catalogue builds in slices so the server keeps answering while a big list is read). */
  *itemSteps(l) {
    const p = this.parsed.get(l.id);
    if (!p || p.items || l.type === 'folder') return;
    try {
      const f = this.rawFile(l);
      if (!fs.existsSync(f)) return;
      const buf = fs.readFileSync(f);
      yield;
      if (l.type === 'xtream') {
        const text = buf.toString('utf8');
        yield;
        const data = JSON.parse(text);
        yield;
        const fresh = this._xtItems(l, data);
        // (Unless the list was refreshed or removed meanwhile: then that newer state stays.)
        if (this.parsed.get(l.id) === p) this.parsed.set(l.id, fresh);
      } else {
        const text = P.decodeText(buf);
        yield;
        const fresh = this._parseText(l, text);
        if (this.parsed.get(l.id) === p) this.parsed.set(l.id, fresh);
      }
      // (The hosts are the same as when it was first read: the saved copy hasn't changed.)
    } catch (e) { log(`List “${l.name}”: saved copy unreadable (${e.message})`); }
  }
  releaseItemsSoon(ms = 3 * 60e3) {
    clearTimeout(this._releaseTimer);
    this._releaseTimer = setTimeout(() => this.releaseItems(), ms);
    if (this._releaseTimer.unref) this._releaseTimer.unref();
  }
  /** Frees the raw entries (big lists take hundreds of MB); the catalogue has what it needs. */
  releaseItems() {
    for (const [id, p] of this.parsed) { const l = this.all().find((x) => x.id === id); if (p.items && l && l.type !== 'folder') this.parsed.set(id, { ...p, items: null }); }
  }

  /** Which list each stream host belongs to (so requests to it use that list's proxy). */
  _hosts(l) {
    if (!this.hostOwner) this.hostOwner = new Map();
    for (const [h, id] of this.hostOwner) if (id === l.id) this.hostOwner.delete(h);
    const add = (u) => { const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(u || ''); if (m) this.hostOwner.set(m[1].toLowerCase(), l.id); };
    add(l.server); add(l.url);
    const p = this.parsed.get(l.id);
    const seen = new Set();
    for (const it of (p && p.items) || []) {
      const u = it.url || '';
      const k = u.slice(0, 40);
      if (seen.has(k)) continue;
      seen.add(k);
      add(u);
    }
    for (const u of (p && p.epgUrls) || []) add(u);
  }
  ownerOf(url) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(url || '');
    return m && this.hostOwner ? this.hostOwner.get(m[1].toLowerCase()) || '' : '';
  }

  /**
   * The provider's account details right now (status, expiry, connections in use) — a quick request that doesn't
   * use a stream connection. Cached for `maxAge` ms.
   */
  async accountStatus(id, maxAge = 60e3) {
    const l = this.get(id);
    if (l.type !== 'xtream') return null;
    if (l.account && l.account.checkedAt && Date.now() - l.account.checkedAt < maxAge) return l.account;
    if (this._acct && this._acct[id]) return this._acct[id];
    (this._acct || (this._acct = {}))[id] = (async () => {
      try {
        const info = await this._xtApi(l, '');
        const u = (info && info.user_info) || {};
        const exp = parseInt(u.exp_date, 10);
        l.account = { ...(l.account || {}), status: u.status || '', expires: exp ? exp * 1000 : null, maxConnections: u.max_connections || '', activeConnections: u.active_cons || '', trial: String(u.is_trial) === '1', formats: u.allowed_output_formats || (l.account || {}).formats || [], checkedAt: Date.now() };
        this.store.save();
      } catch (e) { if (l.account) l.account.error = e.message; }
      return l.account;
    })().finally(() => { delete this._acct[id]; });
    return this._acct[id];
  }

  _parseText(l, text) {
    const base = l.type === 'url' ? l.url : '';
    const r = P.parse(text, base);
    if (!r.items.length) throw new Error(r.sawHeader ? 'The playlist has no playable entries.' : 'This doesn’t look like a playlist (M3U, PLS, XSPF, ASX or JSON).');
    return { items: r.items, epgUrls: r.epgUrls || [], format: r.format || 'M3U', name: r.name || '' };
  }

  async refresh(id, { throwErrors = false } = {}) {
    if (this.running.has(id)) return this.running.get(id);
    const job = this._refresh(id, throwErrors).finally(() => this.running.delete(id));
    this.running.set(id, job);
    return job;
  }

  async _refresh(id, throwErrors) {
    const l = this.get(id);
    l.status = l.status || {};
    l.status.triedAt = Date.now();
    try {
      let parsed;
      if (l.type === 'url') {
        const buf = await download(l.url, { ua: l.ua || this.ua });
        parsed = this._parseText(l, P.decodeText(buf));
        await writeAtomic(this.rawFile(l), buf);
      } else if (l.type === 'file') {
        parsed = this._parseText(l, P.decodeText(fs.readFileSync(this.rawFile(l))));
      } else if (l.type === 'xtream') {
        const data = await this._xtLoad(l);
        parsed = this._xtItems(l, data);
        if (!parsed.items.length) throw new Error('The account works, but it has no channels or videos.');
        await writeJsonSliced(this.rawFile(l), data);
      } else if (l.type === 'folder') {
        const lib = this._library(l);
        await lib.scan();
        parsed = this._folderItems(l);
      }
      this.parsed.set(l.id, parsed);
      this._hosts(l);
      Object.assign(l.status, { ok: true, error: null, count: parsed.items.length, at: Date.now(), format: parsed.format });
      log(`List “${l.name}”: ${parsed.items.length} items`);
    } catch (e) {
      Object.assign(l.status, { ok: false, error: e.message });
      log(`List “${l.name}” failed: ${e.message}${this.parsed.has(l.id) ? ' (keeping the saved copy)' : ''}`);
      if (throwErrors) throw e;
    }
    this.store.save();
    this._syncGuides();
    this.onChange();
    return this.view(l);
  }

  // ------------------------------------------------------------ Xtream Codes
  async _xtApi(l, action, params = {}) {
    const url = `${l.server}/player_api.php?${xq(l, action ? { action, ...params } : params)}`;
    const text = P.decodeText(await download(url, { ua: l.ua || this.ua, timeout: 120000 })).trim();
    if (!text) return null;
    try { return JSON.parse(text); } catch { throw new Error('The server didn’t answer like an Xtream Codes server.'); }
  }

  async _xtLoad(l) {
    let info;
    try {
      info = await this._xtApi(l, '');
      if (!info || !info.user_info) throw new Error('The server didn’t answer like an Xtream Codes server.');
    } catch (e) {
      // Not the API? Many panels still offer the M3U export.
      try {
        const buf = await download(`${l.server}/get.php?${xq(l, { type: 'm3u_plus', output: 'ts' })}`, { ua: l.ua || this.ua });
        return { m3u: P.decodeText(buf), fetchedAt: Date.now() };
      } catch { throw e; }
    }
    if (String(info.user_info.auth) === '0') throw new Error('The server rejected that username or password.');
    const acts = ['get_live_categories', 'get_live_streams', 'get_vod_categories', 'get_vod_streams', 'get_series_categories', 'get_series'];
    const res = await Promise.all(acts.map((a) => this._xtApi(l, a).catch(() => [])));
    const u = info.user_info || {};
    const exp = parseInt(u.exp_date, 10);
    l.account = {
      status: u.status || '', expires: exp ? exp * 1000 : null, maxConnections: u.max_connections || '', activeConnections: u.active_cons || '',
      trial: String(u.is_trial) === '1', formats: u.allowed_output_formats || [], checkedAt: Date.now(),
    };
    l.tz = (info.server_info && info.server_info.timezone) || '';
    return { info, cats: { live: arr(res[0]), vod: arr(res[2]), series: arr(res[4]) }, live: arr(res[1]), vod: arr(res[3]), series: arr(res[5]), fetchedAt: Date.now() };
  }

  _xtItems(l, data) {
    const epgUrls = [`${l.server}/xmltv.php?${xq(l)}`];
    if (data.m3u) {
      const r = this._parseText({ ...l, type: 'url', url: l.server + '/' }, data.m3u);
      return { ...r, epgUrls: r.epgUrls.length ? r.epgUrls : epgUrls, format: 'Xtream Codes (M3U)' };
    }
    const cat = (list) => new Map(list.map((x) => [String(x.category_id), x.category_name]));
    const lc = cat(data.cats.live), vc = cat(data.cats.vod), sc = cat(data.cats.series);
    const formats = (data.info && data.info.user_info && data.info.user_info.allowed_output_formats) || [];
    const liveExt = !formats.length || formats.includes('ts') ? 'ts' : formats.includes('m3u8') ? 'm3u8' : formats[0];
    const U = encodeURIComponent(l.username), PW = encodeURIComponent(l.password);
    const items = [];
    for (const s of data.live) {
      const id = s.stream_id;
      const e = {
        name: s.name || `Channel ${id}`, type: s.stream_type === 'radio_streams' ? 'radio' : 'live',
        url: `${l.server}/live/${U}/${PW}/${id}.${liveExt}`, tvgId: s.epg_channel_id || '', logo: s.stream_icon || '',
        group: lc.get(String(s.category_id)) || 'Live', category: lc.get(String(s.category_id)) || '', chno: s.num ? String(s.num) : '',
        added: (parseInt(s.added, 10) || 0) * 1000, xt: { kind: 'live', id }, headers: {},
      };
      if (String(s.tv_archive) === '1') e.catchup = { type: 'xc', days: parseInt(s.tv_archive_duration, 10) || 7, tz: l.tz || '' };
      items.push(e);
    }
    for (const s of data.vod) {
      const id = s.stream_id;
      items.push({
        name: s.name || `Movie ${id}`, type: 'movie', url: `${l.server}/movie/${U}/${PW}/${id}.${s.container_extension || 'mp4'}`,
        logo: s.stream_icon || '', group: vc.get(String(s.category_id)) || 'Movies', category: vc.get(String(s.category_id)) || '',
        rating: parseFloat(s.rating) || 0, added: (parseInt(s.added, 10) || 0) * 1000, xt: { kind: 'vod', id }, tmdb: s.tmdb || s.tmdb_id || '',
        year: parseInt(s.year || s.releaseDate, 10) || 0, headers: {},
      });
    }
    for (const s of data.series) {
      const id = s.series_id;
      items.push({
        name: s.name || `Series ${id}`, type: 'show', url: '', logo: s.cover || '', group: sc.get(String(s.category_id)) || 'Series',
        category: sc.get(String(s.category_id)) || '', rating: parseFloat(s.rating) || 0, added: (parseInt(s.last_modified, 10) || 0) * 1000,
        plot: s.plot || '', genre: s.genre || '', cast: s.cast || '', director: s.director || '', year: parseInt(s.releaseDate || s.release_date || s.year, 10) || 0,
        backdrop: Array.isArray(s.backdrop_path) ? s.backdrop_path[0] || '' : s.backdrop_path || '', trailer: s.youtube_trailer || '', tmdb: s.tmdb || s.tmdb_id || '',
        xt: { kind: 'series', id }, headers: {},
      });
    }
    return { items, epgUrls, format: 'Xtream Codes', name: '' };
  }

  async _xtCached(l, key, ttl, fn) {
    const f = path.join(this.dir, 'xt', `${l.id}-${key}.json`);
    try {
      const st = fs.statSync(f);
      if (Date.now() - st.mtimeMs < ttl) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {}
    try {
      const data = await fn();
      fs.writeFileSync(f, JSON.stringify(data));
      return data;
    } catch (e) {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
      throw e;
    }
  }

  /** Episodes (and details) of an Xtream series. */
  async xtSeries(listId, seriesId, maxAge = 12 * 3600e3) {
    const l = this.get(listId);
    const data = await this._xtCached(l, `s${seriesId}`, maxAge, () => this._xtApi(l, 'get_series_info', { series_id: seriesId }));
    const U = encodeURIComponent(l.username), PW = encodeURIComponent(l.password);
    const eps = [];
    for (const [season, list] of Object.entries((data && data.episodes) || {})) {
      for (const ep of arr(list)) {
        const info = ep.info || {};
        eps.push({
          id: ep.id, season: parseInt(ep.season || season, 10) || 0, episode: parseInt(ep.episode_num, 10) || 0, title: ep.title || '',
          url: `${l.server}/series/${U}/${PW}/${ep.id}.${ep.container_extension || 'mp4'}`, duration: parseInt(info.duration_secs, 10) || 0,
          plot: info.plot || '', img: info.movie_image || '', rating: parseFloat(info.rating) || 0, aired: info.releasedate || info.air_date || '',
        });
      }
    }
    eps.sort((a, b) => a.season - b.season || a.episode - b.episode);
    return { info: (data && data.info) || {}, episodes: eps };
  }

  async xtVod(listId, vodId) {
    const l = this.get(listId);
    const data = await this._xtCached(l, `v${vodId}`, 7 * 86400e3, () => this._xtApi(l, 'get_vod_info', { vod_id: vodId }));
    return (data && data.info) || {};
  }

  // ------------------------------------------------------------ media folders
  _library(l) {
    let lib = this.libraries.get(l.id);
    if (!lib) {
      lib = new Library({
        folders: () => l.folders || [], media: this.media,
        store: new JsonFile(path.join(this.dir, `${l.id}.library.json`), { items: {}, scannedAt: null }),
        thumbDir: path.join(this.dir, 'thumbs'),
      });
      this.libraries.set(l.id, lib);
    }
    return lib;
  }

  libraryItem(listId, id) {
    const lib = this.libraries.get(listId);
    return lib ? lib.get(id) : null;
  }

  _folderItems(l) {
    const lib = this._library(l);
    const items = [];
    for (const i of lib.items()) {
      const base = { url: `local:${l.id}:${i.id}`, local: { list: l.id, id: i.id }, logo: i.poster ? `/api/art/${l.id}/${i.id}` : `/api/art/${l.id}/${i.id}`, headers: {}, added: i.addedAt, duration: (i.probe && i.probe.duration) || 0 };
      if (i.type === 'episode') items.push({ ...base, name: `${i.show} S${String(i.season).padStart(2, '0')}E${String(i.episode).padStart(2, '0')}${i.title ? ' ' + i.title : ''}`, type: 'episode', group: 'TV Shows', show: i.show, ep: { season: i.season, episode: i.episode, title: i.title || '' } });
      else if (i.type === 'audio') items.push({ ...base, name: i.title, type: 'radio', group: i.album || 'Music', artist: i.artist || '', logo: i.poster ? base.logo : '' });
      else items.push({ ...base, name: i.title, type: 'movie', group: 'Movies', year: i.year || 0 });
    }
    return { items, epgUrls: [], format: 'Media folder', name: '' };
  }

  // ------------------------------------------------------------ guides (XMLTV)
  /** Guides come from the lists (url-tvg / Xtream) plus any the admin adds by hand. */
  _syncGuides() {
    const manual = this.guides().filter((g) => !g.auto);
    const auto = [];
    const seen = new Set(manual.map((g) => g.url));
    for (const l of this.all()) {
      if (!l.enabled || l.useGuide === false) continue;
      const p = this.parsed.get(l.id);
      for (const url of (p && p.epgUrls) || []) {
        if (seen.has(url)) continue;
        seen.add(url);
        const prev = this.guides().find((g) => g.auto && g.url === url);
        auto.push(prev || { id: uid(), url, name: `From ${l.name}`, auto: true, listId: l.id, enabled: true, status: {} });
      }
    }
    const before = this.guides().map((g) => g.id).join();
    this.store.data.guides = [...manual, ...auto];
    if (this.store.data.guides.map((g) => g.id).join() !== before) { this.store.save(); this.onGuides('changed'); }
  }

  addGuide({ url, name }) {
    if (!isUrl(url)) throw new HttpError(400, 'Enter a web address starting with http:// or https://');
    const g = { id: uid(), url: String(url).trim(), name: String(name || '').trim() || new URL(url).hostname, auto: false, enabled: true, status: {} };
    this.guides().push(g);
    this.store.save();
    return this.refreshGuide(g.id);
  }

  updateGuide(id, patch) {
    const g = this.guides().find((x) => x.id === id);
    if (!g) throw new HttpError(404, 'Guide not found');
    if ('enabled' in patch) g.enabled = !!patch.enabled;
    if ('name' in patch) g.name = String(patch.name || '').trim() || g.name;
    this.store.save();
    this.onGuides('changed');
    return g;
  }

  removeGuide(id) {
    const g = this.guides().find((x) => x.id === id);
    if (!g) throw new HttpError(404, 'Guide not found');
    if (g.auto) { g.enabled = false; } else this.store.data.guides = this.guides().filter((x) => x.id !== id);
    this.store.save();
    this.onGuides('removed', id);
  }

  /** Downloads and parses one XMLTV guide; returns the parsed data for the Epg store. */
  async refreshGuide(id) {
    const g = this.guides().find((x) => x.id === id);
    if (!g) throw new HttpError(404, 'Guide not found');
    const s = this.getSettings();
    g.status = g.status || {};
    g.status.triedAt = Date.now();
    try {
      const res = await fetchAny(g.url, { headers: { 'User-Agent': this.ua, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(10 * 60e3) });
      if (!res.ok) throw new Error(`The server answered HTTP ${res.status}`);
      const now = Date.now();
      const data = await parseXMLTV(Readable.fromWeb(res.body), { from: now - (Number(s.epgPastDays) || 7) * 86400e3, to: now + (Number(s.epgDays) || 7) * 86400e3 });
      g.status = { ok: true, error: null, at: Date.now(), channels: Object.keys(data.channels).length, programmes: data.programmeCount };
      this.store.save();
      this.onGuides('data', g.id, { channels: data.channels, programmes: data.programmes });
      log(`Guide “${g.name}”: ${g.status.channels} channels, ${g.status.programmes} programmes`);
    } catch (e) {
      g.status = { ...g.status, ok: false, error: e.message };
      this.store.save();
      log(`Guide “${g.name}” failed: ${e.message}`);
    }
    return g;
  }

  // ------------------------------------------------------------ schedule
  startScheduler() {
    const tick = async () => {
      const now = Date.now();
      for (const l of this.all()) {
        if (!l.enabled || !l.refreshHours) continue;
        const last = (l.status && (l.status.ok ? l.status.at : l.status.triedAt)) || 0;
        const wait = l.status && !l.status.ok ? Math.min(l.refreshHours * 3600e3, 30 * 60e3) : l.refreshHours * 3600e3;
        if (now - last > wait) await this.refresh(l.id).catch(() => {});
      }
      const gh = (Number(this.getSettings().epgRefreshHours) || 12) * 3600e3;
      for (const g of this.guides()) {
        if (!g.enabled) continue;
        const st = g.status || {};
        const last = (st.ok ? st.at : st.triedAt) || 0;
        if (now - last > (st.ok ? gh : Math.min(gh, 30 * 60e3))) await this.refreshGuide(g.id).catch(() => {});
      }
    };
    setTimeout(tick, 3000);
    setInterval(tick, 5 * 60e3).unref();
  }
}

module.exports = { Lists, download, xtNorm };
