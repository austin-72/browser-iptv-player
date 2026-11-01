'use strict';
const fs = require('fs');
const path = require('path');
const { normName } = require('./util');

/**
 * Holds parsed guide data for every EPG source (one JSON file per source on disk)
 * and a merged index used to look up programmes by EPG channel id.
 */
class Epg {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.sources = new Map();
    this.order = [];
    this.onChange = () => {};
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        this.sources.set(path.basename(f, '.json'), JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      } catch (e) {
        console.warn(`Skipping unreadable guide cache ${f}: ${e.message}`);
      }
    }
    this.rebuild();
  }

  setOrder(ids) {
    this.order = ids;
    this.rebuild();
  }

  setSource(id, data) {
    const tmp = path.join(this.dir, id + '.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, path.join(this.dir, id + '.json'));
    this.sources.set(id, data);
    this.rebuild();
  }

  removeSource(id) {
    this.sources.delete(id);
    try { fs.unlinkSync(path.join(this.dir, id + '.json')); } catch {}
    this.rebuild();
  }

  rebuild() {
    const channels = new Map();
    const names = new Map();
    const lower = new Map();
    const programmes = new Map();
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
    this.idx = { channels, names, lower, programmes };
    this.onChange();
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

  has(epgId) {
    return !!(epgId && this.idx.programmes.has(epgId));
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
    for (const l of this.idx.programmes.values()) programmes += l.length;
    return { channels: this.idx.channels.size, programmes };
  }
}

module.exports = { Epg };
