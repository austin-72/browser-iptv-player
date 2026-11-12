'use strict';
/**
 * Home rows made from outside lists: TMDB lists, collections and keywords. Each list is fetched once for the whole household,
 * kept on disk (cache/homelists/) and refreshed about once a day. A row shows only the titles the providers have here,
 * matched by TMDB (or IMDb) id first, then by title and year. Nothing here opens a stream.
 */
const fs = require('fs');
const path = require('path');
const { JsonFile } = require('./store');
const { HttpError, hash, log } = require('./util');
const { TmdbMore, discoverOf, packChoice, unpackChoice } = require('./tmdbmore');

const IMG = 'https://image.tmdb.org/t/p/';
const DAY = 86400e3;
const MAX_ENTRIES = 1000;
const MAX_ROWS = 20; // per profile


const yearOf = (s) => parseInt(String(s || '').slice(0, 4), 10) || 0;

/**
 * What someone pasted: a TMDB link, or an explicit { kind, ref }.
 * → { kind: 'tmdb-list'|'tmdb-collection'|'tmdb-keyword', ref }
 */
function parseSource(input) {
  if (input && typeof input === 'object') {
    const kind = String(input.kind || '');
    const ref = String(input.ref || '').trim();
    if (!ref) throw new HttpError(400, 'Which list?');
    if (['tmdb-list', 'tmdb-collection'].includes(kind) && /^\d+$/.test(ref)) return { kind, ref };
    if (kind === 'tmdb-keyword' && /^\d+(:(movie|tv))?$/.test(ref)) return { kind, ref: ref.includes(':') ? ref : ref + ':movie' };
    // A row made by choosing (genre, years, rating, language, streaming service): what was chosen is its reference.
    if (kind === 'tmdb-discover') { const c = unpackChoice(ref); if (!c) throw new HttpError(400, 'That isn’t a row this can make.'); const packed = packChoice(c); if (packed === '{}') throw new HttpError(400, 'Choose at least one thing for the row: a genre, years, a rating, a language or a service.'); return { kind, ref: packed }; }
    if (input.text) return parseSource(String(input.text));
    throw new HttpError(400, 'That isn’t a list this can read.');
  }
  const s = String(input || '').trim();
  if (!s) throw new HttpError(400, 'Paste a TMDB list, collection or keyword link.');
  let m;
  if (/trakt\.tv/i.test(s)) throw new HttpError(400, 'Trakt lists aren’t supported any more. A TMDB list, collection or keyword link works.');
  if ((m = /themoviedb\.org\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?list\/(\d+)/i.exec(s))) return { kind: 'tmdb-list', ref: m[1] };
  if ((m = /themoviedb\.org\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?collection\/(\d+)/i.exec(s))) return { kind: 'tmdb-collection', ref: m[1] };
  if ((m = /themoviedb\.org\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?keyword\/(\d+)[^/?#\s]*(?:\/(movie|tv))?/i.exec(s))) return { kind: 'tmdb-keyword', ref: `${m[1]}:${(m[2] || 'movie').toLowerCase()}` };
  if ((m = /^tmdb[:\s]+(list|collection|keyword)[:\s]+(\d+)$/i.exec(s))) return parseSource({ kind: 'tmdb-' + m[1].toLowerCase(), ref: m[2] });
  throw new HttpError(400, /^https?:\/\//i.test(s) ? 'That link isn’t a TMDB list. Open the list, collection or keyword on themoviedb.org and copy its address.' : 'Paste a TMDB list, collection or keyword link.');
}

class HomeLists {
  /** deps: { dataDir, catalog(), tmdb, tmdbOf(it) } */
  constructor({ dataDir, catalog, tmdb, tmdbOf }) {
    this.catalog = catalog;
    this.tmdb = tmdb;
    this.tmdbOf = tmdbOf || ((it) => it.tmdb || '');
    this.dir = path.join(dataDir, 'cache', 'homelists');
    fs.mkdirSync(this.dir, { recursive: true });
    // sources: id → { id, kind, ref, name, at, err, n, tried }; profiles: pid → { rows: [{ id, src, name }] }
    this.store = new JsonFile(path.join(dataDir, 'homelists.json'), { sources: {}, profiles: {} });
    this.entries = new Map(); // source id → [entry] (read from disk when first needed)
    this.matched = new Map(); // source id → { sig, keys: [key|null aligned with entries] }
    this.idx = null; // { v, m: Map('movie'+tmdb → key, 'i'+imdb → key) }
    this.busy = new Map(); // source id → Promise (one fetch at a time per list)
  }

  // ------------------------------------------------------------ what's available
  tmdbReady() { return !!(this.tmdb && this.tmdb.enabled()); }
  available() { return { tmdb: this.tmdbReady() }; }
  _need(kind) {
    // (Rows from Trakt, which this no longer uses: kept as they were, not fetched again — and not shown.)
    if (!kind.startsWith('tmdb')) throw new HttpError(400, 'Trakt lists aren’t supported any more.');
    if (!this.tmdbReady()) throw new HttpError(400, 'TMDB lists need a TMDB key: the admin can add a free one in Admin → Recommendations.');
  }

  sourceId(kind, ref) { return `${kind}:${ref}`; }
  _file(id) { return path.join(this.dir, hash(id, 16) + '.json'); }

  // ------------------------------------------------------------ fetching
  /** Fetches (or re-fetches) a list → { name, entries }. Throws a friendly error. */
  async _fetch(src) {
    this._need(src.kind);
    return this._fetchTmdb(src.kind, src.ref);
  }

  _fromTmdb(r, typeHint) {
    const mt = r.media_type || typeHint;
    if (mt !== 'movie' && mt !== 'tv') return null;
    const e = { t: mt === 'tv' ? 'show' : 'movie', n: String(r.title || r.name || '').slice(0, 200), y: yearOf(r.release_date || r.first_air_date), tmdb: String(r.id) };
    if (r.poster_path) e.p = IMG + 'w185' + r.poster_path;
    return e.n ? e : null;
  }

  async _tmdbGet(p, params) {
    let j;
    try { j = await this.tmdb.get(p, params, 20 * 3600e3); } catch (e) { throw new HttpError(502, /key/i.test(e.message) ? 'TMDB rejected the key — the admin can check it in Admin → Recommendations.' : `TMDB didn’t answer (${e.message}).`); }
    if (!j || (!j.id && !j.results && !j.items && !j.parts)) throw new HttpError(404, 'TMDB doesn’t know that list.');
    return j;
  }

  async _fetchTmdb(kind, ref) {
    const entries = [];
    let name = '';
    if (kind === 'tmdb-list') {
      for (let page = 1; page <= 10; page++) {
        const j = await this._tmdbGet(`/list/${ref}`, page > 1 ? { page: String(page) } : {});
        if (page === 1) name = j.name || `TMDB list ${ref}`;
        for (const r of j.items || j.results || []) { const e = this._fromTmdb(r, 'movie'); if (e) entries.push(e); }
        if (!j.total_pages || page >= j.total_pages || entries.length >= MAX_ENTRIES) break;
      }
    } else if (kind === 'tmdb-collection') {
      const j = await this._tmdbGet(`/collection/${ref}`, {});
      name = j.name || `TMDB collection ${ref}`;
      for (const r of (j.parts || []).slice().sort((a, b) => String(a.release_date || '9').localeCompare(String(b.release_date || '9')))) { const e = this._fromTmdb(r, 'movie'); if (e) entries.push(e); }
    } else if (kind === 'tmdb-discover') {
      const more = new TmdbMore({ tmdb: this.tmdb });
      const region = this.tmdb.getRegion ? this.tmdb.getRegion() : 'US';
      const o = await more.options(region).catch(() => ({ genres: { movie: [], tv: [] }, services: [] }));
      const choice = unpackChoice(ref) || {};
      const type = choice.type === 'tv' ? 'tv' : 'movie';
      const d = discoverOf(choice, region, { genres: new Map(o.genres[type].map((g) => [g.id, g.name])), services: new Map(o.services.map((x) => [x.id, x.name])), langName: (c) => { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(c); } catch { return c; } } });
      name = d.name;
      for (let page = 1; page <= 5; page++) {
        const j = await this._tmdbGet(`/discover/${d.type}`, { ...d.params, page: String(page) });
        for (const r of j.results || []) { const e = this._fromTmdb(r, d.type); if (e) entries.push(e); }
        if (!j.total_pages || page >= j.total_pages) break;
      }
    } else if (kind === 'tmdb-keyword') {
      const [id, type] = ref.split(':');
      const kw = await this._tmdbGet(`/keyword/${id}`, {});
      name = `${kw.name ? kw.name.charAt(0).toUpperCase() + kw.name.slice(1) : 'Keyword ' + id} (${type === 'tv' ? 'series' : 'films'})`;
      for (let page = 1; page <= 5; page++) {
        const j = await this._tmdbGet(`/discover/${type === 'tv' ? 'tv' : 'movie'}`, { with_keywords: id, sort_by: 'popularity.desc', include_adult: 'false', page: String(page) });
        for (const r of j.results || []) { const e = this._fromTmdb(r, type === 'tv' ? 'tv' : 'movie'); if (e) entries.push(e); }
        if (!j.total_pages || page >= j.total_pages) break;
      }
    }
    return { name: String(name).slice(0, 120), entries: entries.slice(0, MAX_ENTRIES) };
  }

  /** Fetches a source now (one fetch at a time per list) and saves it. Returns the source record. */
  refresh(id) {
    if (this.busy.has(id)) return this.busy.get(id);
    const src = this.store.data.sources[id];
    if (!src) return Promise.reject(new HttpError(404, 'No such list.'));
    const p = (async () => {
      src.tried = Date.now();
      try {
        const got = await this._fetch(src);
        src.name = got.name || src.name;
        src.n = got.entries.length;
        src.at = Date.now();
        src.err = '';
        this.entries.set(id, got.entries);
        this.matched.delete(id);
        try { fs.writeFileSync(this._file(id), JSON.stringify(got.entries)); } catch (e) { log(`Home lists: ${e.message}`); }
        if (this.onRefresh) { try { this.onRefresh(id); } catch {} }
      } catch (e) {
        src.err = e.message;
        if (!src.at) throw e;
      } finally { this.store.save(); this.busy.delete(id); }
      return src;
    })();
    this.busy.set(id, p);
    return p;
  }

  entriesOf(id) {
    if (this.entries.has(id)) return this.entries.get(id);
    let list = [];
    try { list = JSON.parse(fs.readFileSync(this._file(id), 'utf8')); } catch {}
    if (!Array.isArray(list)) list = [];
    this.entries.set(id, list);
    // Not every list stays in memory: only the ones looked at recently.
    if (this.entries.size > 60) this.entries.delete(this.entries.keys().next().value);
    return list;
  }

  // ------------------------------------------------------------ matching titles to the catalogue
  _index() {
    const cat = this.catalog();
    const mapSize = this.tmdb && this.tmdb.map ? (this.tmdb.mapCount !== undefined ? this.tmdb.mapCount : Object.keys(this.tmdb.map.data.m).length) : 0;
    const v = cat.version + ':' + mapSize;
    if (this.idx && this.idx.v === v) return this.idx;
    const m = new Map();
    for (const it of cat.items) {
      if (it.t !== 'movie' && it.t !== 'show') continue;
      const t = this.tmdbOf(it);
      if (t && !m.has(it.t + t)) m.set(it.t + t, it.k);
      if (it.imdb && !m.has('i' + it.imdb)) m.set('i' + it.imdb, it.k);
    }
    this.idx = { v, m };
    return this.idx;
  }

  /** The catalogue key for a list entry, or null. By TMDB id, IMDb id, then title and year (±1). */
  matchEntry(e, idx) {
    const { m } = idx || this._index();
    if (e.tmdb && m.has(e.t + e.tmdb)) return m.get(e.t + e.tmdb);
    if (e.imdb && m.has('i' + e.imdb)) return m.get('i' + e.imdb);
    const cat = this.catalog();
    if (!e.n || !cat.findTitle) return null;
    for (const k of cat.findTitle(e.n, e.y || 0)) {
      const it = cat.get(k);
      if (!it || it.t !== e.t) continue;
      if (e.y && it.y && Math.abs(it.y - e.y) > 1) continue;
      // Both sides know their TMDB id and it differs: a different title with the same name.
      const t = this.tmdbOf(it);
      if (e.tmdb && t && t !== e.tmdb) continue;
      return k;
    }
    return null;
  }

  keysOf(id) {
    const idx = this._index();
    const v = idx.v;
    const hit = this.matched.get(id);
    if (hit && hit.sig === v) return hit.keys;
    // (One index for the whole list: _index() counts the TMDB map each time, and that per entry was 1000 × 100k.)
    const keys = this.entriesOf(id).map((e) => this.matchEntry(e, idx));
    this.matched.set(id, { sig: v, keys });
    if (this.matched.size > 80) this.matched.delete(this.matched.keys().next().value);
    return keys;
  }

  // ------------------------------------------------------------ a profile's rows
  // (Not rows from Trakt lists, which this no longer reads.)
  rowsOf(pid) { const p = this.store.data.profiles[pid]; return p ? p.rows.filter((r) => !String(r.src).startsWith('trakt')) : []; }

  /** Adds a row for a profile; fetches the list straight away so mistakes show at once. */
  async addRow(pid, input) {
    const { kind, ref } = parseSource(input);
    this._need(kind);
    const prof = this.store.data.profiles[pid] || (this.store.data.profiles[pid] = { rows: [] });
    const id = this.sourceId(kind, ref);
    const have = prof.rows.find((r) => r.src === id);
    if (have) return { row: have, existed: true };
    if (prof.rows.length >= MAX_ROWS) throw new HttpError(400, `That’s ${MAX_ROWS} list rows already — remove one first.`);
    const fresh = !this.store.data.sources[id];
    if (fresh) this.store.data.sources[id] = { id, kind, ref, name: '', at: 0, err: '', n: 0 };
    const src = this.store.data.sources[id];
    if (!src.at || Date.now() - src.at > DAY) {
      try { await this.refresh(id); } catch (e) { if (fresh) delete this.store.data.sources[id]; this.store.save(); throw e; }
    }
    const row = { id: 'xl:' + hash(id, 10), src: id, name: src.name || ref, at: Date.now() };
    prof.rows.push(row);
    this.store.save();
    return { row, existed: false };
  }

  removeRow(pid, rowId) {
    const prof = this.store.data.profiles[pid];
    if (!prof) return false;
    const n = prof.rows.length;
    prof.rows = prof.rows.filter((r) => r.id !== rowId);
    this.store.save();
    return prof.rows.length !== n;
  }

  renameRow(pid, rowId, name) {
    const r = this.rowsOf(pid).find((x) => x.id === rowId);
    if (!r) throw new HttpError(404, 'No such row.');
    const src = this.store.data.sources[r.src] || {};
    r.name = String(name || '').trim().slice(0, 80) || src.name || r.name;
    this.store.save();
    return r;
  }

  /** What Home needs: for each row, the keys of the titles here that this profile can see. */
  rowsView(prof, visible) {
    return this.rowsOf(prof.id).map((r) => {
      const src = this.store.data.sources[r.src] || {};
      const entries = this.entriesOf(r.src);
      const keys = this.keysOf(r.src);
      const here = [];
      const seen = new Set();
      for (const k of keys) if (k && !seen.has(k) && visible(k)) { seen.add(k); here.push(k); }
      return { id: r.id, name: r.name || src.name || '', kind: src.kind || '', listName: src.name || '', total: entries.length, here: here.length, keys: here.slice(0, 60), at: src.at || 0, err: src.err || '', loading: this.busy.has(r.src) || (!src.at && !src.err) };
    });
  }

  /** The whole list for "See the whole list": every entry, with the key here when there is one. */
  fullView(prof, rowId, visible) {
    const r = this.rowsOf(prof.id).find((x) => x.id === rowId);
    if (!r) throw new HttpError(404, 'That row isn’t on your home page any more.');
    const src = this.store.data.sources[r.src] || {};
    const entries = this.entriesOf(r.src);
    const keys = this.keysOf(r.src);
    const items = entries.map((e, i) => {
      const k = keys[i] && visible(keys[i]) ? keys[i] : null;
      const o = { t: e.t, n: e.n, y: e.y || 0 };
      if (e.tmdb) o.tmdb = e.tmdb;
      if (e.p) o.p = e.p;
      if (k) o.k = k;
      return o;
    });
    return { id: r.id, name: r.name || src.name, listName: src.name, kind: src.kind, ref: src.ref, at: src.at || 0, err: src.err || '', total: entries.length, here: items.filter((x) => x.k).length, items };
  }

  // ------------------------------------------------------------ background
  /** Lists in use that are more than a day old: fetched again, one at a time. Unused ones are forgotten after a week. */
  async refreshDue({ gap = 3000 } = {}) {
    const used = new Set();
    for (const p of Object.values(this.store.data.profiles)) for (const r of p.rows || []) used.add(r.src);
    for (const [id, src] of Object.entries(this.store.data.sources)) {
      if (!used.has(id)) {
        if (Date.now() - Math.max(src.at || 0, src.tried || 0) > 7 * DAY) { delete this.store.data.sources[id]; this.entries.delete(id); this.matched.delete(id); try { fs.unlinkSync(this._file(id)); } catch {} this.store.save(); }
        continue;
      }
      const due = Date.now() - (src.at || 0) > DAY && Date.now() - (src.tried || 0) > 3 * 3600e3;
      if (!due) continue;
      try { this._need(src.kind); } catch { continue; } // (TMDB not set up, or a Trakt list: leave the last copy)
      try { await this.refresh(id); } catch (e) { log(`Home list ${src.name || id}: ${e.message}`); }
      await new Promise((ok) => setTimeout(ok, gap));
    }
  }

  forgetProfile(pid) {
    delete this.store.data.profiles[pid];
    for (const [id, s] of Object.entries(this.store.data.sources)) if (s.pid === pid) delete this.store.data.sources[id];
    this.store.save();
  }
}

module.exports = { HomeLists, parseSource };
