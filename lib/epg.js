'use strict';
const fs = require('fs');
const path = require('path');
const { normName, log } = require('./util');
const { readGuideSync, readGuideAsync } = require('./guidefile');

/**
 * One channel's listings made safe for the lookups below (which halve the list by end time, so they need it sorted
 * with no overlaps): sorted by start, a programme cut short where the next one starts, a second one in the same slot
 * dropped, one without a sensible end given half an hour. (A long block with shorter programmes inside it made
 * "on now" come up empty.) A list that is fine already is returned as it is.
 */
function tidy(list) {
  if (!Array.isArray(list)) return [];
  let ok = !list.length || list[0].e > list[0].s;
  for (let i = 1; ok && i < list.length; i++) ok = list[i].s >= list[i - 1].e && list[i].e > list[i].s;
  if (ok) return list;
  const out = [];
  for (let p of [...list].sort((a, b) => a.s - b.s)) {
    if (!(p.e > p.s)) p = { ...p, e: p.s + 30 * 60e3 };
    const prev = out[out.length - 1];
    if (prev && p.s < prev.e) {
      if (p.s <= prev.s) continue;
      out[out.length - 1] = { ...prev, e: p.s };
    }
    out.push(p);
  }
  return out;
}

/**
 * A guide's JSON text in pieces of about a megabyte: the same text as JSON.stringify(data), which for a huge guide
 * held the whole server up while it ran and could pass the longest string there can be ("Invalid string length").
 */
function* jsonPieces(data) {
  let out = '{', first = true;
  for (const [k, v] of Object.entries(data)) {
    const key = (first ? '' : ',') + JSON.stringify(k) + ':';
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.toJSON !== 'function') {
      out += key + '{'; first = false;
      let f = true;
      for (const [k2, v2] of Object.entries(v)) {
        const s = JSON.stringify(v2);
        if (s === undefined) continue;
        out += (f ? '' : ',') + JSON.stringify(k2) + ':' + s; f = false;
        if (out.length > 1 << 20) { yield out; out = ''; }
      }
      out += '}';
    } else {
      const s = JSON.stringify(v);
      if (s === undefined) continue;
      out += key + s; first = false;
    }
  }
  yield out + '}';
}

/** Writes a guide's file a piece at a time, letting requests through in between. */
async function writeJson(file, data) {
  const fh = await fs.promises.open(file, 'w');
  try {
    for (const piece of jsonPieces(data)) {
      const b = Buffer.from(piece);
      for (let o = 0; o < b.length;) o += (await fh.write(b, o)).bytesWritten;
    }
  } finally { await fh.close(); }
}

/** Programmes in a guide (all channels). */
const countProgs = (progs) => { let n = 0; for (const cid in progs) n += (progs[cid] || []).length; return n; };
const TRUNCATED = Symbol.for('biptv.guideTruncated'); // set by lib/xmltv.js on a guide whose download stopped early

/**
 * Holds parsed guide data for every EPG source (one JSON file per source on disk)
 * and a merged index used to look up programmes by EPG channel id.
 *
 * Guides cover far more channels than the lists have (dozens of guides, millions of programmes, gigabytes in memory).
 * So only the programmes of channels the catalogue actually uses are kept in memory (`useOnly`, remembered in
 * keep.json for the next start); the files on disk keep everything, and a channel that becomes used later is read
 * back from them. The channel names stay for all, so new channels can still be linked.
 */
class Epg {
  /**
   * background: the saved guides are read once load() is called, a little at a time (the server answers meanwhile;
   * `ready` resolves when they're all in). Otherwise (tests) they're read straight away.
   */
  constructor(dir, { offsets, background = false } = {}) {
    this.dir = dir;
    // Per guide: hours to add to every programme time (a guide whose times are off). Applied as the guide is read.
    this.offsets = offsets || {};
    fs.mkdirSync(dir, { recursive: true });
    this.sources = new Map();
    this._writes = new Map(); // guide id → its file being written
    this.order = [];
    this.onChange = () => {};
    this.keep = null; // Set of channel ids whose programmes are kept in memory (null: all)
    this.virtual = new Map(); // listings made here, not read from a guide: event channels ("ev:<key>", lib/events.js)
    try { const k = JSON.parse(fs.readFileSync(path.join(dir, 'keep.json'), 'utf8')); if (Array.isArray(k)) this.keep = new Set(k); } catch {}
    this._touched = new Set(); // guides given new listings (or removed) while the saved ones were still being read
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'keep.json');
    if (!background) {
      for (const f of files) {
        try { this.sources.set(path.basename(f, '.json'), this._readFile(f, readGuideSync(fs.readFileSync(path.join(dir, f)), this._want()))); } catch (e) { console.warn(`Skipping unreadable guide cache ${f}: ${e.message}`); }
      }
      this.loaded = true;
      this.rebuild();
      this.ready = Promise.resolve();
      return;
    }
    this.loaded = false;
    this.rebuild(true);
    // (Started by load(): the server puts its catalogue in place first, then reads these.)
    this._files = files;
    this.ready = new Promise((r) => { this._go = r; }).then(() => this._loadAll(this._files));
  }
  /** Starts reading the saved guides (background mode); `ready` resolves when they're in. */
  load() { if (this._go) { this._go(); this._go = null; } return this.ready; }

  /** Which channels' programmes to turn into objects while reading a guide's file (null: all). */
  _want() { const keep = this.keep; return keep ? (cid) => keep.has(cid) : null; }
  /** A guide as read from its file (only the wanted channels' programmes in it) → as kept in memory. */
  _readFile(f, data) { return this._trim(data, path.basename(f, '.json'), false, true); }

  /** The saved guides, one after another in the background; the index once, when they're all in. */
  async _loadAll(files) {
    const t0 = Date.now();
    let bytes = 0, n = 0;
    for (const f of files) {
      const sid = path.basename(f, '.json');
      try {
        const buf = await fs.promises.readFile(path.join(this.dir, f));
        bytes += buf.length;
        const data = await readGuideAsync(buf, this._want());
        // (New listings arrived for it meanwhile, or it was removed: those stand, not the older file.)
        if (!this._touched.has(sid)) { this.sources.set(sid, this._readFile(f, data)); n++; }
      } catch (e) {
        console.warn(`Skipping unreadable guide cache ${f}: ${e.message}`);
      }
    }
    this.loaded = true;
    this._touched.clear();
    this.rebuild();
    if (n) log(`Guides: ${n} read in ${((Date.now() - t0) / 1000).toFixed(1)} s (${Math.round(bytes / 1048576)} MB)`);
    // (A catalogue that asked for other channels meanwhile: now.)
    if (this._pendingUse) { const ids = this._pendingUse; this._pendingUse = null; await this.useOnly(ids); }
  }

  /** A source as kept in memory: every channel, every channel id that has programmes, the needed programmes. */
  _trim(data, sid, inMemory, fromFile) {
    const progs = data.programmes || {};
    const ids = data.ids || Object.keys(progs);
    // The whole guide's count, also once most of it is out of memory. (Read from a file by lib/guidefile.js: counted
    // there, and only the wanted channels' programmes are in it.)
    const count = inMemory || fromFile ? data.count : countProgs(progs);
    // (An offset only copies the programmes kept in memory; the file on disk keeps the guide's own times.
    // A source already in memory has its offset applied: only dropping channels then.)
    const want = (Number(this.offsets[sid]) || 0) * 3600e3;
    const off = inMemory ? 0 : want;
    // (Read from a guide: tidied once here. Already in memory: tidy already.)
    const shifted = (list) => { if (!inMemory) list = tidy(list); return off ? list.map((p) => ({ ...p, s: p.s + off, e: p.e + off })) : list; };
    if (!this.keep) { if (inMemory) return { channels: data.channels || {}, programmes: progs, ids, count }; const all = {}; for (const cid of Object.keys(progs)) all[cid] = shifted(progs[cid]); return { channels: data.channels || {}, programmes: all, ids, count }; }
    const kept = {};
    for (const cid of Object.keys(progs)) if (this.keep.has(cid)) kept[cid] = shifted(progs[cid]);
    return { channels: data.channels || {}, programmes: kept, ids, count };
  }

  /**
   * A guide read again from its file. Waits for the guide's new listings still being written (reading the file before
   * that brought the older listings back), and leaves alone a guide that got new listings while it was being read.
   */
  async _reread(sid) {
    if (this._writes.has(sid)) await this._writes.get(sid);
    const before = this.sources.get(sid);
    if (!before) return;
    try {
      const buf = await fs.promises.readFile(path.join(this.dir, sid + '.json'));
      const data = await readGuideAsync(buf, this._want());
      if (this.sources.get(sid) === before && !this._writes.has(sid)) this.sources.set(sid, this._trim(data, sid, false, true));
    } catch {}
  }

  /** New guide offsets (hours by guide id): the guides whose offset changed are read again from disk. */
  setOffsets(map) {
    const next = { ...(map || {}) };
    const changed = [...this.sources.keys()].filter((sid) => (Number(next[sid]) || 0) !== (Number(this.offsets[sid]) || 0));
    this.offsets = next;
    if (!changed.length) return Promise.resolve(false);
    return (async () => {
      for (const sid of changed) {
        await new Promise((r) => setImmediate(r));
        await this._reread(sid);
      }
      this.rebuild();
      return true;
    })();
  }

  /**
   * The channel ids the catalogue links to. Programmes of other channels are dropped from memory; ones that are now
   * needed but were dropped are read back from disk (one guide at a time, letting requests through in between).
   */
  useOnly(ids) {
    // (Still reading the saved guides: a catalogue linked to half of them would drop the rest's channels. Afterwards.)
    if (this.loaded === false) { this._pendingUse = new Set(ids); return this.ready.then(() => false); }
    const next = new Set(ids);
    const missing = !!this.keep && [...next].some((id) => !this.keep.has(id) && this.idx.withProgs.has(id));
    if (this.keep && !missing && this.keep.size === next.size) return Promise.resolve(false);
    this.keep = next;
    try { fs.writeFileSync(path.join(this.dir, 'keep.json'), JSON.stringify([...next])); } catch {}
    if (!missing) {
      for (const [sid, src] of this.sources) this.sources.set(sid, this._trim(src, sid, true));
      this.rebuild(true);
      return Promise.resolve(true);
    }
    if (this._reloading) return this._reloading.then(() => this.useOnly(next));
    const files = [...this.sources.keys()];
    this._reloading = (async () => {
      for (const sid of files) {
        await new Promise((r) => setImmediate(r));
        await this._reread(sid);
      }
      this.rebuild();
    })().finally(() => { this._reloading = null; });
    return this._reloading;
  }

  setOrder(ids) {
    this.order = ids;
    this.rebuild();
  }

  /**
   * A guide's new listings. soon: written to disk in the background and the index rebuilt a moment later, once for a
   * whole burst (a list with dozens of guides refreshes them one after another; rebuilding after each one, then
   * linking every channel again, kept the server busy for minutes).
   */
  setSource(id, data, { soon = false } = {}) {
    const file = path.join(this.dir, id + '.json'), tmp = file + '.tmp';
    // A download that stopped early (no </tv>) with under half the programmes of the guide there was: keep that one.
    // (Thrown: the guide is shown as failed and tried again sooner. A whole document is always taken.)
    const old = this.sources.get(id);
    if (data && data.programmes && data.programmes[TRUNCATED] && old && old.count > 0) {
      const n = countProgs(data.programmes);
      if (n < old.count / 2) throw new Error(`The guide stopped part way (${n} programmes, the last one had ${old.count}): kept the last one`);
    }
    this._touched.add(id);
    this.sources.set(id, this._trim(data, id));
    if (!soon) {
      // (Written a piece at a time, not as one string: see jsonPieces.)
      const fd = fs.openSync(tmp, 'w');
      try { for (const piece of jsonPieces(data)) fs.writeFileSync(fd, piece); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      this.rebuild();
      return;
    }
    const prev = this._writes.get(id) || Promise.resolve();
    const w = prev.then(() => writeJson(tmp, data)).then(() => fs.promises.rename(tmp, file).catch(() => fs.promises.copyFile(tmp, file))).catch((e) => console.warn(`Couldn’t save guide ${id}: ${e.message}`));
    this._writes.set(id, w);
    w.finally(() => { if (this._writes.get(id) === w) this._writes.delete(id); });
    this.rebuildSoon();
  }
  rebuildSoon() {
    const now = Date.now();
    if (!this._soonFirst) this._soonFirst = now;
    clearTimeout(this._soonT);
    this._soonT = setTimeout(() => { this._soonFirst = 0; this._soonT = null; this.rebuild(); }, Math.max(0, Math.min(3000, this._soonFirst + 30000 - now)));
  }

  removeSource(id) {
    this._touched.add(id);
    this.sources.delete(id);
    const rm = () => { try { fs.unlinkSync(path.join(this.dir, id + '.json')); } catch {} };
    if (this._writes.has(id)) this._writes.get(id).then(rm); else rm();
    this.rebuild();
  }

  rebuild(quiet) {
    const channels = new Map();
    const names = new Map();
    const lower = new Map();
    const programmes = new Map();
    const withProgs = new Set(); // channels with programmes in some guide (kept in memory or not)
    const ids = [...this.order.filter((i) => this.sources.has(i)), ...[...this.sources.keys()].filter((i) => !this.order.includes(i))];
    for (const sid of ids) {
      const src = this.sources.get(sid);
      for (const [cid, info] of Object.entries(src.channels || {})) {
        if (!channels.has(cid)) channels.set(cid, info);
        lower.set(cid.toLowerCase(), cid);
        for (const n of info.names || []) {
          const k = normName(n);
          if (k && !names.has(k)) names.set(k, cid);
        }
        const k = normName(cid.replace(/\.[a-z]{2,3}$/i, ''));
        if (k && !names.has(k)) names.set(k, cid);
      }
      for (const cid of src.ids || Object.keys(src.programmes || {})) {
        withProgs.add(cid);
        if (!channels.has(cid)) { channels.set(cid, { names: [cid], icon: '' }); lower.set(cid.toLowerCase(), cid); }
      }
      for (const [cid, list] of Object.entries(src.programmes || {})) {
        if (!channels.has(cid)) { channels.set(cid, { names: [cid], icon: '' }); lower.set(cid.toLowerCase(), cid); }
        const existing = programmes.get(cid);
        if (!existing) programmes.set(cid, list);
        else {
          // Merge two sources for the same channel; first source wins on overlap.
          // (existing is sorted by start: find the first one ending after p starts, by halving — not a full scan per
          // programme, which made merging big guides very slow.)
          const merged = [...existing];
          for (const p of list) {
            let lo = 0, hi = existing.length;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (existing[mid].e <= p.s) lo = mid + 1; else hi = mid; }
            let clash = false;
            for (let j = lo; j < existing.length && existing[j].s < p.e; j++) if (existing[j].e > p.s) { clash = true; break; }
            if (!clash) merged.push(p);
          }
          merged.sort((a, b) => a.s - b.s);
          programmes.set(cid, merged);
        }
      }
    }
    this.idx = { channels, names, lower, programmes, withProgs };
    // (While the saved guides are still being read: once, when they're all in.)
    if (!quiet && this.loaded !== false) this.onChange();
  }

  /** Listings made from event channels' names (id → programmes). They take part like any guide's. */
  setVirtual(map) {
    this.virtual = map || new Map();
    if (this.loaded !== false) this.onChange(); // (still reading the saved guides: with them, when they're in)
  }

  /** Finds the EPG channel id for a playlist channel: manual mapping, then tvg-id, then name. */
  resolve({ epgOverride, tvgId, tvgName, name }) {
    const { channels, names, lower } = this.idx;
    if (epgOverride) return epgOverride;
    if (tvgId) {
      if (channels.has(tvgId)) return tvgId;
      const l = lower.get(tvgId.toLowerCase());
      if (l) return l;
    }
    for (const n of [tvgName, name, tvgId]) {
      const hit = n && names.get(normName(n));
      if (hit) return hit;
    }
    return null;
  }

  _firstEndingAfter(list, t) {
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].e <= t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  range(epgId, from, to) {
    const list = epgId && (this.virtual.get(epgId) || this.idx.programmes.get(epgId));
    if (!list) return [];
    const out = [];
    for (let i = this._firstEndingAfter(list, from); i < list.length && list[i].s < to; i++) out.push(list[i]);
    return out;
  }

  nowNext(epgId, t = Date.now()) {
    const list = epgId && (this.virtual.get(epgId) || this.idx.programmes.get(epgId));
    if (!list) return { now: null, next: null };
    const i = this._firstEndingAfter(list, t);
    const p = list[i];
    if (p && p.s <= t) return { now: p, next: list[i + 1] || null };
    return { now: null, next: p || null };
  }

  /** Does some guide have programmes for this channel? (Also when they're not in memory right now.) */
  has(epgId) {
    return !!(epgId && (this.idx.withProgs.has(epgId) || this.virtual.has(epgId)));
  }

  search(q, limit = 40) {
    const nq = normName(q);
    const out = [];
    for (const [id, info] of this.idx.channels) {
      const hay = [id, ...(info.names || [])];
      if (!nq || hay.some((h) => normName(h).includes(nq))) {
        out.push({ id, name: (info.names || [])[0] || id, icon: info.icon || '', programmes: (this.idx.programmes.get(id) || []).length });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  stats() {
    let programmes = 0;
    const ends = [];
    for (const l of this.idx.programmes.values()) { programmes += l.length; if (l.length) ends.push(l[l.length - 1].e); }
    ends.sort((a, b) => a - b);
    // When the listings run out for a typical channel (the median), so the admin can see a guide that stopped updating.
    return { channels: this.idx.channels.size, programmes, until: ends.length ? ends[ends.length >> 1] : null };
  }
}

module.exports = { Epg, jsonPieces };
