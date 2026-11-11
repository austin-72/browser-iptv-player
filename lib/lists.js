'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { fetchAny } = require('./net');
const { SchedulesDirect } = require('./schedulesdirect');
const P = require('./parse');
const { parseXMLTV } = require('./xmltv');
const { Library } = require('./library');
const { JsonFile } = require('./store');
const { HttpError, uid, log, isUrl } = require('./util');
const { Stalker } = require('./stalker');
const { MediaServer } = require('./mediaserver');
const { Worker } = require('worker_threads');

/** Kinds whose saved copy lib/listworker.js can read (the others need more of the server, and are small). */
const WORKER_TYPES = new Set(['url', 'file', 'xtream']);
/**
 * A list's saved copy read into entries on another thread (lib/listworker.js), so a huge one doesn't hold the
 * server up. Resolves to { items, epgUrls, format, name }; rejects if that thread failed (the caller then reads it here).
 */
function parseInWorker(file, l) {
  return new Promise((resolve, reject) => {
    let w;
    const limit = Math.round(require('v8').getHeapStatistics().heap_size_limit / 1048576);
    try { w = new Worker(path.join(__dirname, 'listworker.js'), { workerData: { file, list: JSON.parse(JSON.stringify(l)) }, resourceLimits: { maxOldGenerationSizeMb: limit } }); } catch (e) { return reject(e); }
    let head = null, done = false;
    const items = [];
    w.on('message', (m) => {
      if (m.error) { done = true; reject(new Error(m.error)); w.terminate(); }
      else if (m.head) head = m.head;
      else if (m.items) { for (const it of m.items) items.push(it); setImmediate(() => w.postMessage(1)); }
      else if (m.done) { done = true; const { count, ...rest } = head || {}; resolve({ ...rest, items }); }
    });
    w.on('error', (e) => { if (!done) { done = true; reject(e); } });
    w.on('exit', (code) => { if (!done) { done = true; reject(new Error(`the reading thread stopped (${code})`)); } });
  });
}

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
  // (Unpacked up to a limit, and not while holding the server: a small file that unpacks to gigabytes ran it out of memory.)
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    buf = await new Promise((ok, no) => require('zlib').gunzip(buf, { maxOutputLength: Math.max(limit, 64 << 20) * 8 }, (e, out) => (e ? no(new Error(e.code === 'ERR_BUFFER_TOO_LARGE' ? 'That file is too big.' : 'That file is damaged (it couldn’t be unpacked).')) : ok(out))));
  }
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
/** Runs a generator in ~25 ms slices, letting the server answer requests in between. */
function runSteps(g, slice = 25) {
  return new Promise((resolve, reject) => {
    const run = () => {
      const end = Date.now() + slice;
      try { while (Date.now() < end) if (g.next().done) return resolve(); } catch (e) { return reject(e); }
      setImmediate(run);
    };
    run();
  });
}
/**
 * A provider's list as an array: some panels send an object keyed by id instead. Anything else (an error object,
 * `{user_info:{auth:0}}`, null) is not a list: null, never fake entries. `key`: a field every entry must have.
 */
function xtList(x, key) {
  if (Array.isArray(x)) return x;
  if (!x || typeof x !== 'object') return null;
  const v = Object.values(x);
  return v.every((e) => e && typeof e === 'object' && !Array.isArray(e) && (!key || key in e)) ? v : null;
}
const arr = (x, key) => xtList(x, key) || [];
/** A real "info" answer (series or film details), not an empty body, a login error or a list. */
const xtInfo = (d, k) => !!(d && typeof d === 'object' && !Array.isArray(d) && !d.user_info && (d.info || d[k]));
const hasSeasons = (d) => !!(d && Array.isArray(d.seasons) && d.seasons.length);

/**
 * The admin's playlists ("lists") and guides. Each list is downloaded on a schedule, the last good copy is kept on
 * disk, and it's turned into plain items for the catalog. Kinds: url (any playlist format), file (uploaded),
 * xtream (Xtream Codes API), folder (media files on the server), stalker (Stalker/Ministra MAC portal),
 * mediaserver (a Jellyfin, Emby or Plex library).
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
    this.stalker = new Stalker();
    this.mediaserver = new MediaServer();
    // Sources that aren't the admin's lists but add entries the same way (e.g. "My channels"): { id, enabled, name, … }.
    this.extras = [];
    // Guides that come from somewhere other than an XMLTV address: 'scheme' → async (guide) => { channels, programmes }.
    this.guideProviders = {
      stalker: async (g) => {
        const l = this.get(g.url.slice('stalker:'.length));
        const data = JSON.parse(fs.readFileSync(this.rawFile(l), 'utf8'));
        return this.stalker.guide(l, data, { hours: Math.min(168, (Number(this.getSettings().epgDays) || 2) * 24) });
      },
      // A Schedules Direct lineup ("sd:<lineup id>"), with the account kept on the guide: lib/schedulesdirect.js.
      sd: async (g) => {
        if (!g.sd || !g.sd.user || !g.sd.hash) throw new Error('The Schedules Direct account isn’t set on this guide: remove it and add it again.');
        return this.sd.guide({ user: g.sd.user, hash: g.sd.hash }, g.url.slice(3), { days: Number(this.getSettings().epgDays) || 7 });
      },
    };
    this.sd = new SchedulesDirect({ dataDir: dir, ua: `superstation-iptv/${require('../package.json').version}` });
  }

  /** Kinds whose saved copy is JSON (an API's answers) rather than a playlist. */
  _isJson(l) { return l.type === 'xtream' || l.type === 'stalker' || l.type === 'mediaserver'; }
  _jsonItems(l, data) {
    if (l.type === 'stalker') return this.stalker.items(l, data);
    if (l.type === 'mediaserver') return this.mediaserver.items(l, data);
    return this._xtItems(l, data);
  }

  get ua() { return this.getSettings().userAgent; }
  all() { return this.store.data.lists; }
  guides() { return this.store.data.guides; }
  get(id) { const l = this.all().find((x) => x.id === id); if (!l) throw new HttpError(404, 'List not found'); return l; }
  rawFile(l) { return path.join(this.dir, `${l.id}.${this._isJson(l) ? 'json' : 'raw'}`); }

  /** Public view for the admin pages (passwords masked). */
  view(l) {
    const out = { ...l };
    if (out.password) out.password = '••••••••';
    if (out.token) out.token = '••••••••';
    const lib = this.libraries.get(l.id);
    if (lib) out.library = lib.status();
    out.refreshing = this.running.has(l.id);
    return out;
  }

  // ------------------------------------------------------------ admin changes
  async add(spec, content) {
    const type = spec.type;
    if (!['url', 'file', 'xtream', 'folder', 'stalker', 'mediaserver'].includes(type)) throw new HttpError(400, 'Unknown list type');
    const l = {
      id: uid(), type, name: String(spec.name || '').trim(), enabled: true,
      refreshHours: spec.refreshHours !== '' && spec.refreshHours != null && Number(spec.refreshHours) >= 0 ? Math.min(168, Number(spec.refreshHours)) : 12, // (an emptied box is the usual 12 hours, not "never")
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
    } else if (type === 'stalker') {
      Object.assign(l, this.stalker.spec(spec));
      if (!l.name) l.name = new URL(l.portal).hostname;
    } else if (type === 'mediaserver') {
      Object.assign(l, this.mediaserver.spec(spec));
      if (!l.name) l.name = { jellyfin: 'Jellyfin', emby: 'Emby', plex: 'Plex' }[l.kind];
      l.useGuide = false;
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
    const before = `${l.url}|${l.server}|${l.username}|${l.portal}|${l.mac}`;
    // (What decides whether it's downloaded again: the form sends the address and login every time, so going by
    // "was it sent" downloaded a 300,000-entry list again for a change of name.)
    const sig = () => JSON.stringify([l.url, l.server, l.username, l.password, l.ua, l.portal, l.mac, l.token, l.includeLive, l.vod, l.proxy]);
    const sigBefore = sig();
    if (l.type === 'url' && patch.url && !isUrl(patch.url)) throw new HttpError(400, 'That isn’t a web address (it should start with http:// or https://).');
    for (const k of ['name', 'ua', 'lang']) if (k in patch) l[k] = String(patch[k] || '').trim();
    if ('enabled' in patch) l.enabled = !!patch.enabled;
    if ('useGuide' in patch) l.useGuide = !!patch.useGuide;
    if ('refreshHours' in patch) l.refreshHours = Math.max(0, Math.min(168, Number(patch.refreshHours) || 0));
    if ('proxy' in patch) l.proxy = String(patch.proxy || '').slice(0, 40); // '' = the default, 'none', or a proxy id
    if ('relay' in patch) l.relay = ['on', 'off'].includes(patch.relay) ? patch.relay : ''; // viewers' direct streams through the stream relay: '' = the default
    if ('evTz' in patch) l.evTz = String(patch.evTz || '').trim().slice(0, 60); // event channels' times: '' = the provider's or the server's zone
    if (l.type === 'url' && patch.url && isUrl(patch.url)) l.url = String(patch.url).trim();
    if (l.type === 'xtream') {
      if (patch.server) l.server = xtNorm(patch.server).server;
      if (patch.username) l.username = String(patch.username).trim();
      if (patch.password && !/^•+$/.test(patch.password)) l.password = String(patch.password).trim();
    }
    if (l.type === 'stalker' || l.type === 'mediaserver') {
      const mod = l.type === 'stalker' ? this.stalker : this.mediaserver;
      const keep = { ...l };
      for (const k of ['password', 'token']) if (patch[k] === undefined || /^•+$/.test(String(patch[k]))) patch[k] = keep[k];
      const merged = mod.spec({ ...keep, ...patch });
      Object.assign(l, merged);
      if (l.type === 'stalker' && (patch.portal || patch.mac)) { delete l.api; this.stalker.sessions.delete(l.id); }
    }
    // A different account or address: the old connection test result doesn't apply — nor do the episodes and film
    // details kept from the old one (their ids are that provider's).
    if (`${l.url}|${l.server}|${l.username}|${l.portal}|${l.mac}` !== before) { delete l.connTest; this._dropXt(l.id); }
    this.store.save();
    this._syncGuides();
    if (sig() !== sigBefore) this.refresh(id, { again: true });
    else this.onChange();
    return this.view(l);
  }

  replaceFile(id, content) {
    const l = this.get(id);
    if (l.type !== 'file') throw new HttpError(400, 'Only uploaded lists can be replaced');
    // (Read first: a wrong file — a photo, a web page — used to replace the saved playlist before being found out,
    // and the list was empty after the next restart.)
    let ok = false;
    try { const parsed = this._parseText(l, P.decodeText(Buffer.isBuffer(content) ? content : Buffer.from(String(content)))); ok = !!(parsed && parsed.items && parsed.items.length); } catch {}
    if (!ok) throw new HttpError(400, 'That file isn’t a playlist with channels or videos in it — the list was left as it is.');
    fs.writeFileSync(this.rawFile(l), content);
    return this.refresh(id, { throwErrors: true, again: true }).then(() => this.view(l));
  }

  /** A list's kept episode lists and film details (data/lists/xt/<id>-…): gone with the list, or with its account. */
  _dropXt(id) {
    const dir = path.join(this.dir, 'xt');
    fs.readdir(dir, (e, names) => { if (!e) for (const n of names) if (n.startsWith(id + '-') && n.endsWith('.json')) fs.unlink(path.join(dir, n), () => {}); });
  }

  /** The server is stopping in the ordinary way: a refresh under way isn't one that crashed it (see _interrupted). */
  stopping() {
    let any = false;
    for (const x of [...this.all(), ...this.guides()]) if (x.status && x.status.running) { delete x.status.running; any = true; }
    if (any) this.store.flush();
  }

  remove(id) {
    const l = this.get(id);
    this.store.data.lists = this.all().filter((x) => x.id !== id);
    for (const f of [this.rawFile(l), path.join(this.dir, `${id}.library.json`)]) { try { fs.unlinkSync(f); } catch {} }
    this.parsed.delete(id);
    this.libraries.delete(id);
    this._dropXt(id);
    if (this.hostOwner) for (const [h, x] of this.hostOwner) if (x === id) this.hostOwner.delete(h);
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
  /**
   * A refresh that was still running when the server last stopped means the server died during it (most likely it
   * ran out of memory). Starting it again at once would just do the same, over and over: wait 6 hours (12, 24…), and
   * say so on the list. The saved copy keeps working meanwhile.
   */
  _interrupted() {
    let any = false;
    for (const x of [...this.all(), ...this.guides()]) {
      const st = x.status;
      if (!st || !st.running) continue;
      st.crashes = (st.crashes || 0) + 1;
      st.holdUntil = Date.now() + Math.min(48, 6 * 2 ** (st.crashes - 1)) * 3600e3;
      st.ok = false;
      st.error = 'The server stopped while refreshing this (probably out of memory). It tries again ' + (st.crashes > 1 ? 'later' : 'in 6 hours') + '; the saved copy is used meanwhile.';
      log(`“${x.name}”: the server stopped while refreshing it last time — not trying again until ${new Date(st.holdUntil).toISOString().slice(0, 16).replace('T', ' ')} UTC.`);
      delete st.running;
      any = true;
    }
    if (any) this.store.flush();
  }

  /** Reads each list's saved copy at startup (no network), then refreshes anything that's due. */
  loadSaved() {
    this._interrupted();
    for (const l of this.all()) {
      try { this._parseSaved(l); } catch (e) { log(`List “${l.name}”: saved copy unreadable (${e.message})`); }
    }
    this._syncGuides();
  }
  /**
   * The same without holding up the server: files are read in the background and turned into entries in short
   * slices, so the server already answers ("getting ready…") while big lists — hundreds of MB, slow on a shared
   * Windows drive in Docker — are read. (One JSON.parse of a big Xtream list is still a single step.)
   */
  async loadSavedAsync({ missingOnly = false } = {}) {
    if (!missingOnly) this._interrupted();
    for (const l of this.all()) {
      if (missingOnly && this.parsed.has(l.id)) continue;
      try {
        if (l.type === 'folder') { this._parseSaved(l); continue; }
        const f = this.rawFile(l);
        if (!fs.existsSync(f)) { this._parseSaved(l); continue; }
        if (WORKER_TYPES.has(l.type)) {
          const fresh = await parseInWorker(f, l).catch((e) => { log(`List “${l.name}”: reading it on another thread failed (${e.message}) — reading it here`); return null; });
          if (fresh) { if (this.all().includes(l)) { this.parsed.set(l.id, fresh); this._hosts(l); } continue; }
        }
        const buf = await fs.promises.readFile(f);
        if (!this.all().includes(l)) continue; // (removed meanwhile)
        await runSteps(this._parseBufSteps(l, buf));
      } catch (e) { log(`List “${l.name}”: saved copy unreadable (${e.message})`); }
    }
    this._syncGuides();
  }

  /**
   * Start-up from the saved catalogue (lib/catsnap.js): what each list's saved copy would tell — its guides, the
   * hosts its streams come from — is taken from there, and the copy itself is read only when the catalogue is next
   * put together (itemSteps). Lists the snapshot doesn't know: see loadSavedAsync({ missingOnly }).
   */
  fromSnapshot(meta) {
    this._interrupted();
    if (!this.hostOwner) this.hostOwner = new Map();
    for (const l of this.all()) {
      try {
        if (l.type === 'folder') { this._parseSaved(l); continue; }
        const m = meta && meta[l.id];
        if (!m || !fs.existsSync(this.rawFile(l))) continue;
        this.parsed.set(l.id, { items: null, epgUrls: m.epgUrls || [], format: m.format || '', name: m.name || '' });
        for (const h of m.hosts || []) this.hostOwner.set(h, l.id);
      } catch (e) { log(`List “${l.name}”: ${e.message}`); }
    }
    this._syncGuides();
  }
  /** What fromSnapshot needs again, per list (the rest is in the catalogue itself). */
  snapshotMeta() {
    const out = {};
    const hosts = new Map();
    for (const [h, id] of this.hostOwner || []) (hosts.get(id) || hosts.set(id, []).get(id)).push(h);
    for (const l of this.all()) {
      const p = this.parsed.get(l.id);
      if (!p || l.type === 'folder') continue;
      out[l.id] = { epgUrls: p.epgUrls || [], format: p.format || '', name: p.name || '', hosts: hosts.get(l.id) || [] };
    }
    return out;
  }

  _parseSaved(l, quiet) {
    if (l.type === 'folder') { this._library(l); this.parsed.set(l.id, this._folderItems(l)); return; }
    const f = this.rawFile(l);
    // No saved copy (e.g. just restored from a backup, which leaves provider downloads out): fetch it soon.
    if (!fs.existsSync(f)) { if (l.status) { l.status.at = 0; l.status.triedAt = 0; } return; }
    const g = this._parseBufSteps(l, fs.readFileSync(f));
    while (!g.next().done);
  }
  *_parseBufSteps(l, buf) {
    let parsed;
    if (this._isJson(l)) {
      const text = buf.toString('utf8');
      yield;
      const data = JSON.parse(text);
      yield;
      parsed = this._jsonItems(l, data);
    } else {
      const text = P.decodeText(buf);
      yield;
      parsed = this._parseText(l, text);
    }
    yield;
    this.parsed.set(l.id, parsed);
    this._hosts(l);
  }

  /** A list's entries for building the catalogue: read again from the saved copy if they were released. */
  itemsFor(l) {
    const g = this.itemSteps(l);
    while (!g.next().done);
    return this.parsed.get(l.id);
  }
  /** The same, in steps (the catalogue builds in slices so the server keeps answering while a big list is read). */
  *itemSteps(l, { worker = false } = {}) {
    const p = this.parsed.get(l.id);
    if (!p || p.items || l.type === 'folder') return;
    try {
      const f = this.rawFile(l);
      if (!fs.existsSync(f)) return;
      // (On another thread when the caller waits for a yielded promise: Catalog.buildAsync does.)
      if (worker && WORKER_TYPES.has(l.type)) {
        let fresh = null;
        yield parseInWorker(f, l).then((r) => { fresh = r; }, (e) => log(`List “${l.name}”: reading it on another thread failed (${e.message}) — reading it here`));
        if (fresh) { if (this.parsed.get(l.id) === p) this.parsed.set(l.id, fresh); return; }
      }
      const buf = fs.readFileSync(f);
      yield;
      if (this._isJson(l)) {
        const text = buf.toString('utf8');
        yield;
        const data = JSON.parse(text);
        yield;
        const fresh = this._jsonItems(l, data);
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
    add(l.server); add(l.url); add(l.portal);
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
  /**
   * The Xtream account behind a list: an Xtream list's own, or a playlist link from an Xtream panel
   * (…/get.php?username=…&password=…), which has the same account. null for other lists.
   */
  xtAccountOf(l) {
    if (l.type === 'xtream') return l;
    if (l.type !== 'url') return null;
    const m = /^(https?:\/\/[^/?#]+)\/get\.php\?(.*)$/i.exec(l.url || '');
    if (!m) return null;
    const q = new URLSearchParams(m[2]);
    return q.get('username') && q.get('password') ? { server: m[1], username: q.get('username'), password: q.get('password'), ua: l.ua } : null;
  }
  /** Takes the account details an Xtream server sent (user_info) onto a list; a check that worked clears an old error. */
  _setAccount(l, u) {
    const exp = parseInt(u.exp_date, 10);
    const { error, ...prev } = l.account || {};
    l.account = { ...prev, status: u.status || '', expires: exp ? exp * 1000 : null, maxConnections: u.max_connections || '', activeConnections: u.active_cons || '', trial: String(u.is_trial) === '1', formats: u.allowed_output_formats || prev.formats || [], checkedAt: Date.now() };
  }

  async accountStatus(id, maxAge = 60e3) {
    const l = this.get(id);
    const xa = this.xtAccountOf(l);
    if (!xa && l.type !== 'stalker') return null;
    if (l.account && l.account.checkedAt && Date.now() - l.account.checkedAt < maxAge) return l.account;
    if (l.type === 'stalker') {
      try { l.account = await this.stalker.account(l); this.store.save(); } catch (e) { l.account = { ...(l.account || {}), error: e.message, checkedAt: Date.now() }; }
      return l.account;
    }
    if (this._acct && this._acct[id]) return this._acct[id];
    (this._acct || (this._acct = {}))[id] = (async () => {
      try {
        const info = await this._xtApi(xa, '');
        if (!info || !info.user_info) throw new Error('The server didn’t send the account’s details.');
        this._setAccount(l, info.user_info);
        this.store.save();
      } catch (e) { l.account = { ...(l.account || {}), error: e.message, errorAt: Date.now() }; }
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

  async refresh(id, { throwErrors = false, again = false } = {}) {
    if (this.running.has(id)) {
      // (Changed while a refresh runs, e.g. a new address: that one fetched the old one, so go again once it's done.)
      if (again) (this.again || (this.again = new Set())).add(id);
      return this.running.get(id);
    }
    const job = this._refresh(id, throwErrors).finally(() => {
      this.running.delete(id);
      if (this.again && this.again.delete(id) && this.all().some((x) => x.id === id)) this.refresh(id).catch(() => {});
    });
    this.running.set(id, job);
    return job;
  }

  async _refresh(id, throwErrors) {
    const l = this.get(id);
    // (Removed while this ran: nothing of it is written or registered.)
    const gone = () => !this.all().includes(l);
    let partial = '';
    l.status = l.status || {};
    l.status.triedAt = Date.now();
    // Written down before starting: if the server dies during it, the next start knows (see loadSaved).
    l.status.running = Date.now();
    this.store.flush();
    try {
      let parsed;
      if (l.type === 'url') {
        const buf = await download(l.url, { ua: l.ua || this.ua });
        parsed = this._parseText(l, P.decodeText(buf));
        if (gone()) return this.view(l);
        await writeAtomic(this.rawFile(l), buf);
      } else if (l.type === 'file') {
        parsed = this._parseText(l, P.decodeText(fs.readFileSync(this.rawFile(l))));
      } else if (l.type === 'xtream') {
        const problems = [];
        const data = await this._xtLoad(l, problems);
        parsed = this._xtItems(l, data);
        if (!parsed.items.length) throw new Error('The account works, but it has no channels or videos.');
        if (gone()) return this.view(l);
        await writeJsonSliced(this.rawFile(l), data);
        partial = problems.join(' ');
      } else if (l.type === 'folder') {
        const lib = this._library(l);
        await lib.scan();
        parsed = this._folderItems(l);
      } else if (l.type === 'stalker' || l.type === 'mediaserver') {
        const data = await (l.type === 'stalker' ? this.stalker : this.mediaserver).load(l);
        parsed = this._jsonItems(l, data);
        if (!parsed.items.length) throw new Error('The account works, but it has nothing to watch.');
        if (gone()) return this.view(l);
        await writeJsonSliced(this.rawFile(l), data);
      }
      if (gone()) {
        if (l.type === 'folder') { this.libraries.delete(l.id); try { fs.unlinkSync(path.join(this.dir, `${l.id}.library.json`)); } catch {} }
        return this.view(l);
      }
      this.parsed.set(l.id, parsed);
      this._hosts(l);
      // Part of it failed (that part kept from the saved copy): saved, but shown as a problem and tried again sooner.
      Object.assign(l.status, { ok: !partial, error: partial || null, count: parsed.items.length, at: Date.now(), format: parsed.format });
      if (partial) l.status.partial = true; else delete l.status.partial;
      delete l.status.crashes;
      log(`List “${l.name}”: ${parsed.items.length} items`);
    } catch (e) {
      Object.assign(l.status, { ok: false, error: e.message });
      delete l.status.partial;
      if (gone()) return this.view(l);
      log(`List “${l.name}” failed: ${e.message}${this.parsed.has(l.id) ? ' (keeping the saved copy)' : ''}`);
      if (throwErrors) { delete l.status.running; this.store.save(); throw e; }
    }
    delete l.status.running;
    if (gone()) return this.view(l);
    this.store.save();
    this._syncGuides();
    this.onChange();
    if (partial) log(`List “${l.name}”: ${partial}`);
    return this.view(l);
  }

  // ------------------------------------------------------------ Xtream Codes
  async _xtApi(l, action, params = {}) {
    const url = `${l.server}/player_api.php?${xq(l, action ? { action, ...params } : params)}`;
    const text = P.decodeText(await download(url, { ua: l.ua || this.ua, timeout: 120000 })).trim();
    if (!text) return null;
    try { return JSON.parse(text); } catch { throw new Error('The server didn’t answer like an Xtream Codes server.'); }
  }

  async _xtLoad(l, problems = []) {
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
    this._setAccount(l, info.user_info); // (the account's details came with it: no separate check needed)
    const acts = ['get_live_categories', 'get_live_streams', 'get_vod_categories', 'get_vod_streams', 'get_series_categories', 'get_series'];
    const res = await Promise.all(acts.map((a) => this._xtApi(l, a).catch((e) => e)));
    // A part that failed or isn't a list (a "Too many requests" page, a login error…) would empty that whole part:
    // that part is kept from the saved copy instead. With no saved copy to keep, the refresh fails.
    let prev;
    const saved = () => {
      if (prev === undefined) {
        prev = null;
        try { const d = JSON.parse(fs.readFileSync(this.rawFile(l), 'utf8')); if (d && d.cats && !d.m3u) prev = d; } catch {}
      }
      return prev;
    };
    const why = (x) => (x instanceof Error ? x.message : x == null ? 'an empty answer' : x.user_info ? 'the login was refused' : 'an answer that isn’t a list');
    const part = (i, key, label, get) => {
      const list = res[i] instanceof Error ? null : xtList(res[i], key);
      if (list) return list;
      const old = saved() && get(saved());
      if (!Array.isArray(old)) throw new Error(`The server didn’t send the ${label} (${why(res[i])}).`);
      problems.push(`The ${label} didn’t load (${why(res[i])}): the saved copy of them is kept.`);
      return old;
    };
    // (Categories only name the groups: without them, the saved ones, or none.)
    const cats = (i, k) => (res[i] instanceof Error ? null : xtList(res[i], 'category_id')) || (saved() && saved().cats && xtList(saved().cats[k])) || [];
    const live = part(1, 'stream_id', 'live channels', (d) => d.live);
    const vod = part(3, 'stream_id', 'films', (d) => d.vod);
    const series = part(5, 'series_id', 'series', (d) => d.series);
    const u = info.user_info || {};
    const exp = parseInt(u.exp_date, 10);
    l.account = {
      status: u.status || '', expires: exp ? exp * 1000 : null, maxConnections: u.max_connections || '', activeConnections: u.active_cons || '',
      trial: String(u.is_trial) === '1', formats: u.allowed_output_formats || [], checkedAt: Date.now(),
    };
    l.tz = (info.server_info && info.server_info.timezone) || '';
    return { info, cats: { live: cats(0, 'live'), vod: cats(2, 'vod'), series: cats(4, 'series') }, live, vod, series, fetchedAt: Date.now() };
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
      if (String(s.is_adult) === '1') e.adult = true; // (the provider's own mark: lib/catalog.js isAdult)
      if (String(s.tv_archive) === '1') e.catchup = { type: 'xc', days: parseInt(s.tv_archive_duration, 10) || 7, tz: l.tz || '' };
      items.push(e);
    }
    for (const s of data.vod) {
      const id = s.stream_id;
      items.push({
        name: s.name || `Movie ${id}`, type: 'movie', url: `${l.server}/movie/${U}/${PW}/${id}.${s.container_extension || 'mp4'}`,
        logo: s.stream_icon || '', group: vc.get(String(s.category_id)) || 'Movies', category: vc.get(String(s.category_id)) || '',
        rating: parseFloat(s.rating) || 0, added: (parseInt(s.added, 10) || 0) * 1000, xt: { kind: 'vod', id }, tmdb: s.tmdb || s.tmdb_id || '',
        year: parseInt(s.year || s.releaseDate, 10) || 0, headers: {}, ...(String(s.is_adult) === '1' ? { adult: true } : null),
      });
    }
    for (const s of data.series) {
      const id = s.series_id;
      items.push({
        name: s.name || `Series ${id}`, type: 'show', url: '', logo: s.cover || '', group: sc.get(String(s.category_id)) || 'Series',
        category: sc.get(String(s.category_id)) || '', rating: parseFloat(s.rating) || 0, added: (parseInt(s.last_modified, 10) || 0) * 1000,
        plot: s.plot || '', genre: s.genre || '', cast: s.cast || '', director: s.director || '', year: parseInt(s.releaseDate || s.release_date || s.year, 10) || 0,
        backdrop: Array.isArray(s.backdrop_path) ? s.backdrop_path[0] || '' : s.backdrop_path || '', trailer: s.youtube_trailer || '', tmdb: s.tmdb || s.tmdb_id || '',
        xt: { kind: 'series', id }, headers: {}, ...(String(s.is_adult) === '1' ? { adult: true } : null),
      });
    }
    return { items, epgUrls, format: 'Xtream Codes', name: '' };
  }

  /**
   * A provider's answer kept on disk for `ttl` ms. `ok(data)` says whether an answer is real: an empty or wrong one
   * counts as a failure, so it isn't kept (the older copy is used if there is one).
   */
  async _xtCached(l, key, ttl, fn, ok = (d) => d != null) {
    // (The id in the name is the provider's own text: anything but plain letters and digits is turned into a hash,
    // so an id like "../../users" can't make this read or write a file somewhere else.)
    const safe = /^[\w.~-]{1,80}$/.test(String(key)) ? String(key) : 'h' + crypto.createHash('sha1').update(String(key)).digest('hex');
    const f = path.join(this.dir, 'xt', `${l.id}-${safe}.json`);
    const saved = () => { try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return ok(d) ? d : undefined; } catch { return undefined; } };
    try {
      const st = fs.statSync(f);
      if (Date.now() - st.mtimeMs < ttl) { const d = saved(); if (d !== undefined) return d; }
    } catch {}
    try {
      const data = await fn();
      if (!ok(data)) throw new Error('The provider sent an empty answer.');
      fs.writeFileSync(f, JSON.stringify(data));
      return data;
    } catch (e) {
      const d = saved();
      if (d !== undefined) return d;
      throw e;
    }
  }

  /** Episodes (and details) of an Xtream series. */
  async xtSeries(listId, seriesId, maxAge = 12 * 3600e3) {
    const l = this.get(listId);
    if (l.type === 'stalker') {
      const info = await this._xtCached(l, `ss${seriesId}`, maxAge, () => this.stalker.seriesInfo(l, seriesId), hasSeasons);
      return this.stalker.episodesOf(l, seriesId, info);
    }
    if (l.type === 'mediaserver') {
      const data = this._msData(l);
      return this._xtCached(l, `ms${seriesId}`, maxAge, () => this.mediaserver.episodes(l, data, seriesId), (d) => !!(d && Array.isArray(d.episodes) && d.episodes.length));
    }
    const data = await this._xtCached(l, `s${seriesId}`, maxAge, () => this._xtApi(l, 'get_series_info', { series_id: seriesId }), (d) => xtInfo(d, 'episodes'));
    const U = encodeURIComponent(l.username), PW = encodeURIComponent(l.password);
    const eps = [];
    for (const [season, list] of Object.entries((data && data.episodes) || {})) {
      for (const ep of arr(list, 'id')) {
        const info = ep.info || {};
        eps.push({
          id: ep.id, season: parseInt(ep.season || season, 10) || 0, episode: parseInt(ep.episode_num, 10) || 0, title: ep.title || '',
          url: `${l.server}/series/${U}/${PW}/${ep.id}.${ep.container_extension || 'mp4'}`, duration: parseInt(info.duration_secs, 10) || 0,
          // What's inside the file (when the provider says), so the player knows whether the browser plays it as it is.
          cx: info.video && info.video.codec_name ? { v: String(info.video.codec_name).toLowerCase(), a: String((info.audio && info.audio.codec_name) || '').toLowerCase(), pix: String(info.video.pix_fmt || '') } : null,
          plot: info.plot || '', img: info.movie_image || '', rating: parseFloat(info.rating) || 0, aired: info.releasedate || info.air_date || '',
        });
      }
    }
    eps.sort((a, b) => a.season - b.season || a.episode - b.episode);
    return { info: (data && data.info) || {}, episodes: eps };
  }

  async xtVod(listId, vodId) {
    const l = this.get(listId);
    if (l.type !== 'xtream') return {}; // (Stalker portals and media servers send the details with the list)
    const data = await this._xtCached(l, `v${vodId}`, 7 * 86400e3, () => this._xtApi(l, 'get_vod_info', { vod_id: vodId }), (d) => xtInfo(d, 'movie_data'));
    return (data && data.info) || {};
  }

  /** The small part of a media server list's saved copy that playing an episode needs (login, user). */
  _msData(l) {
    const c = this._msCache || (this._msCache = new Map());
    const hit = c.get(l.id);
    let st = null;
    try { st = fs.statSync(this.rawFile(l)).mtimeMs; } catch {}
    if (hit && hit.st === st) return hit.d;
    let d = {};
    try { const all = JSON.parse(fs.readFileSync(this.rawFile(l), 'utf8')); d = { user: all.user, token: all.token, kind: all.kind }; } catch {}
    c.set(l.id, { st, d });
    return d;
  }

  /** The real address of a Stalker portal's channel, film or episode, asked for just before playback. */
  async stalkerLink(listId, kind, id) {
    const l = this.get(listId);
    if (l.type !== 'stalker') throw new HttpError(404, 'Not a portal list');
    if (!this.stalker.cmds.has(l.id)) { const g = this.itemSteps(l); while (!g.next().done); if (!this.stalker.cmds.has(l.id)) this._parseSaved(l); }
    let seasonCmd = '';
    if (kind === 'ep') {
      const [series, rest] = String(id).split('|');
      const info = await this._xtCached(l, `ss${series}`, 12 * 3600e3, () => this.stalker.seriesInfo(l, series), hasSeasons);
      const season = ((info && info.seasons) || []).find((s) => s.id === String(rest).split('~')[0]);
      seasonCmd = season ? season.cmd : '';
      id = rest;
    }
    return this.stalker.createLink(l, kind, id, seasonCmd);
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
    for (const l of [...this.all(), ...this.extras]) {
      if (!l.enabled || l.useGuide === false) continue;
      const p = this.parsed.get(l.id);
      // Not loaded yet (start-up): keep the guides this list had, so their saved listings stay theirs
      // (dropping them here gave them new ids and every guide was fetched again).
      if (!p) {
        for (const g of this.guides()) if (g.auto && g.listId === l.id && !seen.has(g.url)) { seen.add(g.url); auto.push(g); }
        continue;
      }
      for (const url of p.epgUrls || []) {
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

  /** A guide as Admin sees it: a Schedules Direct one without its password hash. */
  guideView(g) { return g && g.sd ? { ...g, sd: { user: g.sd.user } } : g; }

  /** The lineups on a Schedules Direct account, to choose one from: { username, password } → [{ id, name, … }]. */
  sdLineups({ username, password }) {
    const user = String(username || '').trim();
    if (!user || !password) throw new HttpError(400, 'Enter the Schedules Direct user name and password.');
    return this.sd.lineups({ user, hash: SchedulesDirect.hash(String(password)) });
  }

  addGuide({ url, name, sd }) {
    if (sd && typeof sd === 'object') {
      const user = String(sd.username || '').trim(), lineup = String(sd.lineup || '').trim();
      if (!user || !sd.password) throw new HttpError(400, 'Enter the Schedules Direct user name and password.');
      if (!/^[A-Za-z0-9-]{3,80}$/.test(lineup)) throw new HttpError(400, 'Choose one of the account’s lineups.');
      if (this.guides().some((x) => x.url === 'sd:' + lineup)) throw new HttpError(400, 'That lineup is already one of the guides.');
      const g = { id: uid(), url: 'sd:' + lineup, name: String(name || '').trim().slice(0, 120) || `Schedules Direct: ${lineup}`, auto: false, enabled: true, status: {}, sd: { user, hash: SchedulesDirect.hash(String(sd.password)) } };
      this.guides().push(g);
      this.store.save();
      return this.refreshGuide(g.id);
    }
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

  /**
   * Downloads and parses one XMLTV guide; returns the parsed data for the Epg store. Asked again while it runs: the
   * running one (a big guide downloaded and read twice at once took twice the memory for nothing).
   */
  refreshGuide(id) {
    const run = this.guidesRunning || (this.guidesRunning = new Map());
    if (run.has(id)) return run.get(id);
    const job = this._refreshGuide(id).finally(() => run.delete(id));
    run.set(id, job);
    return job;
  }

  async _refreshGuide(id) {
    const g = this.guides().find((x) => x.id === id);
    if (!g) throw new HttpError(404, 'Guide not found');
    const s = this.getSettings();
    g.status = g.status || {};
    g.status.triedAt = Date.now();
    g.status.running = Date.now();
    this.store.flush();
    try {
      const now = Date.now();
      const scheme = (/^([a-z0-9]+):/i.exec(g.url) || [])[1];
      let data;
      if (scheme && this.guideProviders[scheme]) data = await this.guideProviders[scheme](g);
      else {
        const res = await fetchAny(g.url, { headers: { 'User-Agent': this.ua, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(10 * 60e3) });
        if (!res.ok) throw new Error(`The server answered HTTP ${res.status}`);
        data = await parseXMLTV(Readable.fromWeb(res.body), { from: now - (Number(s.epgPastDays) || 7) * 86400e3, to: now + (Number(s.epgDays) || 7) * 86400e3 });
      }
      g.status = { ok: true, error: null, at: Date.now(), triedAt: g.status.triedAt, channels: Object.keys(data.channels).length, programmes: data.programmeCount };
      this.store.save();
      this.onGuides('data', g.id, { channels: data.channels, programmes: data.programmes });
      log(`Guide “${g.name}”: ${g.status.channels} channels, ${g.status.programmes} programmes`);
    } catch (e) {
      // (Failing again and again: tried less and less often — 30 min, 1 h, 2 h… up to the normal refresh time.)
      g.status = { ...g.status, ok: false, error: e.message, fails: ((g.status && g.status.fails) || 0) + 1 };
      delete g.status.running;
      this.store.save();
      log(`Guide “${g.name}” failed: ${e.message}`);
    }
    return g;
  }

  // ------------------------------------------------------------ schedule
  startScheduler() {
    // (One round at a time: a slow round, e.g. a big guide, could still be going when the next one starts.)
    const tick = async () => {
      if (this._ticking) return;
      this._ticking = true;
      try { await round(); } finally { this._ticking = false; }
    };
    const round = async () => {
      const now = Date.now();
      for (const l of this.all()) {
        if (!l.enabled || !l.refreshHours) continue;
        if (l.status && l.status.holdUntil > now) continue;
        const last = (l.status && (l.status.ok ? l.status.at : l.status.triedAt)) || 0;
        const wait = l.status && !l.status.ok ? Math.min(l.refreshHours * 3600e3, 30 * 60e3) : l.refreshHours * 3600e3;
        if (now - last > wait) await this.refresh(l.id).catch(() => {});
      }
      const gh = (Number(this.getSettings().epgRefreshHours) || 12) * 3600e3;
      for (const g of this.guides()) {
        if (!g.enabled) continue;
        const st = g.status || {};
        if (st.holdUntil > now || (this.guidesRunning && this.guidesRunning.has(g.id))) continue;
        const last = (st.ok ? st.at : st.triedAt) || 0;
        const retry = Math.min(gh, 30 * 60e3 * Math.pow(2, Math.min(6, Math.max(0, (st.fails || 1) - 1))));
        if (now - last > (st.ok ? gh : retry)) await this.refreshGuide(g.id).catch(() => {});
      }
    };
    // (Not straight after starting: let the server settle and people get back to watching first.)
    setTimeout(tick, 2 * 60e3);
    setInterval(tick, 5 * 60e3).unref();
  }
}

module.exports = { Lists, download, xtNorm };
