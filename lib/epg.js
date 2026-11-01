'use strict';
const fs = require('fs');
const path = require('path');
const { normName } = require('./util');

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
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.sources = new Map();
    this.order = [];
    this.onChange = () => {};
    this.keep = null; // Set of channel ids whose programmes are kept in memory (null: all)
    try { const k = JSON.parse(fs.readFileSync(path.join(dir, 'keep.json'), 'utf8')); if (Array.isArray(k)) this.keep = new Set(k); } catch {}
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f === 'keep.json') continue;
      try {
        this.sources.set(path.basename(f, '.json'), this._trim(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));
      } catch (e) {
        console.warn(`Skipping unreadable guide cache ${f}: ${e.message}`);
      }
    }
    this.rebuild();
  }

  /** A source as kept in memory: every channel, every channel id that has programmes, the needed programmes. */
  _trim(data) {
    const progs = data.programmes || {};
    const ids = data.ids || Object.keys(progs);
    if (!this.keep) return { channels: data.channels || {}, programmes: progs, ids };
    const kept = {};
    for (const cid of Object.keys(progs)) if (this.keep.has(cid)) kept[cid] = progs[cid];
    return { channels: data.channels || {}, programmes: kept, ids };
  }

  /**
   * The channel ids the catalogue links to. Programmes of other channels are dropped from memory; ones that are now
   * needed but were dropped are read back from disk (one guide at a time, letting requests through in between).
   */
  useOnly(ids) {
    const next = new Set(ids);
    const missing = !!this.keep && [...next].some((id) => !this.keep.has(id) && this.idx.withProgs.has(id));
    if (this.keep && !missing && this.keep.size === next.size) return Promise.resolve(false);
    this.keep = next;
    try { fs.writeFileSync(path.join(this.dir, 'keep.json'), JSON.stringify([...next])); } catch {}
    if (!missing) {
      for (const [sid, src] of this.sources) this.sources.set(sid, this._trim(src));
      this.rebuild(true);
      return Promise.resolve(true);
    }
    if (this._reloading) return this._reloading.then(() => this.useOnly(next));
    const files = [...this.sources.keys()];
    this._reloading = (async () => {
      for (const sid of files) {
        await new Promise((r) => setImmediate(r));
        if (!this.sources.has(sid)) continue;
        try { this.sources.set(sid, this._trim(JSON.parse(fs.readFileSync(path.join(this.dir, sid + '.json'), 'utf8')))); } catch {}
      }
      this.rebuild();
    })().finally(() => { this._reloading = null; });
    return this._reloading;
  }

  setOrder(ids) {
    this.order = ids;
    this.rebuild();
  }

  setSource(id, data) {
    const tmp = path.join(this.dir, id + '.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, path.join(this.dir, id + '.json'));
    this.sources.set(id, this._trim(data));
    this.rebuild();
  }

  removeSource(id) {
    this.sources.delete(id);
    try { fs.unlinkSync(path.join(this.dir, id + '.json')); } catch {}
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
          const merged = [...existing];
          for (const p of list) if (!existing.some((q) => p.s < q.e && p.e > q.s)) merged.push(p);
          merged.sort((a, b) => a.s - b.s);
          programmes.set(cid, merged);
        }
      }
    }
    this.idx = { channels, names, lower, programmes, withProgs };
    if (!quiet) this.onChange();
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
    const list = epgId && this.idx.programmes.get(epgId);
    if (!list) return [];
    const out = [];
    for (let i = this._firstEndingAfter(list, from); i < list.length && list[i].s < to; i++) out.push(list[i]);
    return out;
  }

  nowNext(epgId, t = Date.now()) {
    const list = epgId && this.idx.programmes.get(epgId);
    if (!list) return { now: null, next: null };
    const i = this._firstEndingAfter(list, t);
    const p = list[i];
    if (p && p.s <= t) return { now: p, next: list[i + 1] || null };
    return { now: null, next: p || null };
  }

  /** Does some guide have programmes for this channel? (Also when they're not in memory right now.) */
  has(epgId) {
    return !!(epgId && this.idx.withProgs.has(epgId));
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

module.exports = { Epg };
