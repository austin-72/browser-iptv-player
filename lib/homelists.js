'use strict';
/**
 * Home rows made from outside lists: public Trakt lists, a profile's own Trakt lists, Trakt's trending / popular /
 * anticipated charts, TMDB lists, collections and keywords. Each list is fetched once for the whole household,
 * kept on disk (cache/homelists/) and refreshed about once a day. A row shows only the titles the providers have here,
 * matched by TMDB (or IMDb) id first, then by title and year. Nothing here opens a stream.
 */
const fs = require('fs');
const path = require('path');
const { JsonFile } = require('./store');
const { HttpError, hash, log } = require('./util');

const IMG = 'https://image.tmdb.org/t/p/';
const DAY = 86400e3;
const MAX_ENTRIES = 1000;
const MAX_ROWS = 20; // per profile

const CHARTS = [
  { ref: 'movies/trending', name: 'Trending films on Trakt' },
  { ref: 'shows/trending', name: 'Trending series on Trakt' },
  { ref: 'movies/popular', name: 'Popular films on Trakt' },
  { ref: 'shows/popular', name: 'Popular series on Trakt' },
  { ref: 'movies/anticipated', name: 'Most anticipated films on Trakt' },
  { ref: 'shows/anticipated', name: 'Most anticipated series on Trakt' },
];

const yearOf = (s) => parseInt(String(s || '').slice(0, 4), 10) || 0;

/**
 * What someone pasted: a Trakt or TMDB link, "user/list", or an explicit { kind, ref }.
 * → { kind: 'trakt-list'|'trakt-mine'|'trakt-chart'|'tmdb-list'|'tmdb-collection'|'tmdb-keyword', ref }
 */
function parseSource(input) {
  if (input && typeof input === 'object') {
    const kind = String(input.kind || '');
    const ref = String(input.ref || '').trim();
    if (!ref) throw new HttpError(400, 'Which list?');
    if (kind === 'trakt-chart' && !CHARTS.some((c) => c.ref === ref)) throw new HttpError(400, 'Unknown Trakt chart.');
    if (['trakt-list', 'trakt-mine', 'trakt-chart'].includes(kind)) return { kind, ref: ref.slice(0, 200) };
    if (['tmdb-list', 'tmdb-collection'].includes(kind) && /^\d+$/.test(ref)) return { kind, ref };
    if (kind === 'tmdb-keyword' && /^\d+(:(movie|tv))?$/.test(ref)) return { kind, ref: ref.includes(':') ? ref : ref + ':movie' };
    if (input.text) return parseSource(String(input.text));
    throw new HttpError(400, 'That isn’t a list this can read.');
  }
  let s = String(input || '').trim();
  if (!s) throw new HttpError(400, 'Paste a Trakt or TMDB list link, or a Trakt “user/list”.');
  let m;
  if ((m = /trakt\.tv\/users\/([^/?#\s]+)\/lists\/([^/?#\s]+)/i.exec(s))) return { kind: 'trakt-list', ref: `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}` };
  if ((m = /trakt\.tv\/lists\/([^/?#\s]+)/i.exec(s))) return { kind: 'trakt-list', ref: decodeURIComponent(m[1]) };
  if ((m = /trakt\.tv\/(movies|shows)\/(trending|popular|anticipated)/i.exec(s))) return { kind: 'trakt-chart', ref: `${m[1].toLowerCase()}/${m[2].toLowerCase()}` };
  if ((m = /themoviedb\.org\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?list\/(\d+)/i.exec(s))) return { kind: 'tmdb-list', ref: m[1] };
  if ((m = /themoviedb\.org\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?collection\/(\d+)/i.exec(s))) return { kind: 'tmdb-collection', ref: m[1] };
  if ((m = /themoviedb\.org\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?keyword\/(\d+)[^/?#\s]*(?:\/(movie|tv))?/i.exec(s))) return { kind: 'tmdb-keyword', ref: `${m[1]}:${(m[2] || 'movie').toLowerCase()}` };
  if (/^https?:\/\//i.test(s)) throw new HttpError(400, 'That link isn’t a Trakt or TMDB list. Open the list on trakt.tv or themoviedb.org and copy its address.');
  if ((m = /^tmdb[:\s]+(list|collection|keyword)[:\s]+(\d+)$/i.exec(s))) return parseSource({ kind: 'tmdb-' + m[1].toLowerCase(), ref: m[2] });
  s = s.replace(/^@/, '');
  if ((m = /^([\w.-]+)\/(?:lists\/)?([\w.-]+)$/.exec(s))) return { kind: 'trakt-list', ref: `${m[1]}/${m[2]}` };
  throw new HttpError(400, 'Paste a Trakt or TMDB list link, or a Trakt “user/list”.');
}

class HomeLists {
  /** deps: { dataDir, catalog(), tmdb, trakt (lib/trakt.js instance), tmdbOf(it) } */
  constructor({ dataDir, catalog, tmdb, trakt, tmdbOf }) {
    this.catalog = catalog;
    this.tmdb = tmdb;
    this.trakt = trakt;
    this.tmdbOf = tmdbOf || ((it) => it.tmdb || '');
    this.dir = path.join(dataDir, 'cache', 'homelists');
    fs.mkdirSync(this.dir, { recursive: true });
    // sources: id → { id, kind, ref, pid?, name, at, err, n, tried }; profiles: pid → { rows: [{ id, src, name }] }
    this.store = new JsonFile(path.join(dataDir, 'homelists.json'), { sources: {}, profiles: {} });
    this.entries = new Map(); // source id → [entry] (read from disk when first needed)
    this.matched = new Map(); // source id → { sig, keys: [key|null aligned with entries] }
    this.idx = null; // { v, m: Map('movie'+tmdb → key, 'i'+imdb → key) }
    this.busy = new Map(); // source id → Promise (one fetch at a time per list)
  }

  // ------------------------------------------------------------ what's available
  traktReady() { const c = (this.trakt && this.trakt.getConf()) || {}; return !!c.clientId; }
  tmdbReady() { return !!(this.tmdb && this.tmdb.enabled()); }
  available(pid) {
    const tp = pid && this.trakt && this.trakt.prof(pid);
    return { trakt: this.traktReady(), traktConnected: !!(tp && tp.access), tmdb: this.tmdbReady(), charts: CHARTS };
  }
  _need(kind) {
    if (kind.startsWith('trakt') && !this.traktReady()) throw new HttpError(400, 'Trakt lists need a Trakt app on this server: the admin adds one in Admin → Integrations (for public lists the Client ID is enough).');
    if (kind.startsWith('tmdb') && !this.tmdbReady()) throw new HttpError(400, 'TMDB lists need a TMDB key: the admin can add a free one in Admin → Recommendations.');
  }

  sourceId(kind, ref, pid) { return kind === 'trakt-mine' ? `trakt-mine:${pid}:${ref}` : `${kind}:${ref}`; }
  _file(id) { return path.join(this.dir, hash(id, 16) + '.json'); }

  // ------------------------------------------------------------ fetching
  /** Fetches (or re-fetches) a list → { name, entries }. Throws a friendly error. */
  async _fetch(src) {
    this._need(src.kind);
    const { kind, ref } = src;
    if (kind.startsWith('trakt')) return this._fetchTrakt(kind, ref, src.pid);
    return this._fetchTmdb(kind, ref);
  }

  async _traktGet(p, pid) {
    const r = await this.trakt._req(p, pid ? { pid } : { auth: false });
    if (r.status === 404) throw new HttpError(404, 'Trakt doesn’t know that list (or it’s private).');
    if (r.status === 401 || r.status === 403) throw new HttpError(400, pid ? 'Trakt says this profile isn’t allowed to read that list — connect Trakt again in Settings.' : 'Trakt refused: the list may be private, or the Trakt app details in Admin → Integrations are wrong.');
    if (!r.ok) throw new HttpError(502, `Trakt said ${r.status}. Try again later.`);
    return r.json;
  }

  _fromTrakt(x) {
    const type = x.movie ? 'movie' : x.show ? 'show' : null;
    const o = type ? x[type] : x.title ? x : null; // (popular charts are plain films / series)
    if (!o) return null;
    const ids = o.ids || {};
    const e = { t: type || (x.first_aired !== undefined || o.first_aired !== undefined ? 'show' : 'movie'), n: String(o.title || '').slice(0, 200), y: Number(o.year) || 0 };
    if (ids.tmdb) e.tmdb = String(ids.tmdb);
    if (ids.imdb) e.imdb = String(ids.imdb);
    if (ids.trakt) e.trakt = ids.trakt;
    return e.n ? e : null;
  }

  async _fetchTrakt(kind, ref, pid) {
    let name = '', raw = [];
    if (kind === 'trakt-chart') {
      const [what, chart] = ref.split('/');
      raw = await this._traktGet(`/${what}/${chart}?limit=100`);
      name = (CHARTS.find((c) => c.ref === ref) || {}).name || 'Trakt';
      // (popular is a plain list of films / series)
      if (chart === 'popular') raw = (raw || []).map((o) => ({ [what === 'movies' ? 'movie' : 'show']: o }));
    } else if (kind === 'trakt-mine') {
      if (!pid) throw new HttpError(400, 'Connect Trakt in Settings first.');
      const info = await this._traktGet(`/users/me/lists/${encodeURIComponent(ref)}`, pid);
      name = (info && info.name) || ref;
      raw = await this._traktGet(`/users/me/lists/${encodeURIComponent(ref)}/items/movie,show`, pid);
    } else {
      const parts = ref.split('/');
      const base = parts.length === 2 ? `/users/${encodeURIComponent(parts[0])}/lists/${encodeURIComponent(parts[1])}` : `/lists/${encodeURIComponent(parts[0])}`;
      const info = await this._traktGet(base);
      name = (info && info.name) || ref;
      raw = await this._traktGet(`${base}/items/movie,show`);
    }
    const entries = [];
    for (const x of Array.isArray(raw) ? raw : []) { const e = this._fromTrakt(x); if (e) entries.push(e); if (entries.length >= MAX_ENTRIES) break; }
    return { name: String(name).slice(0, 120), entries };
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
    const mapSize = this.tmdb && this.tmdb.map ? Object.keys(this.tmdb.map.data.m).length : 0;
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
  matchEntry(e) {
    const { m } = this._index();
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
    const v = this._index().v;
    const hit = this.matched.get(id);
    if (hit && hit.sig === v) return hit.keys;
    const keys = this.entriesOf(id).map((e) => this.matchEntry(e));
    this.matched.set(id, { sig: v, keys });
    if (this.matched.size > 80) this.matched.delete(this.matched.keys().next().value);
    return keys;
  }

  // ------------------------------------------------------------ a profile's rows
  rowsOf(pid) { const p = this.store.data.profiles[pid]; return p ? p.rows : []; }

  /** Adds a row for a profile; fetches the list straight away so mistakes show at once. */
  async addRow(pid, input) {
    const { kind, ref } = parseSource(input);
    this._need(kind);
    if (kind === 'trakt-mine') { const tp = this.trakt.prof(pid); if (!tp || !tp.access) throw new HttpError(400, 'Connect Trakt in Settings first.'); }
    const prof = this.store.data.profiles[pid] || (this.store.data.profiles[pid] = { rows: [] });
    const id = this.sourceId(kind, ref, pid);
    const have = prof.rows.find((r) => r.src === id);
    if (have) return { row: have, existed: true };
    if (prof.rows.length >= MAX_ROWS) throw new HttpError(400, `That’s ${MAX_ROWS} list rows already — remove one first.`);
    const fresh = !this.store.data.sources[id];
    if (fresh) this.store.data.sources[id] = { id, kind, ref, ...(kind === 'trakt-mine' ? { pid } : {}), name: '', at: 0, err: '', n: 0 };
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

  /** Trakt lists of a connected profile (to pick from). */
  async myTraktLists(pid) {
    this._need('trakt');
    const tp = this.trakt.prof(pid);
    if (!tp || !tp.access) return [];
    const j = await this._traktGet('/users/me/lists', pid);
    return (Array.isArray(j) ? j : []).map((l) => ({ ref: String((l.ids && l.ids.slug) || (l.ids && l.ids.trakt) || ''), name: String(l.name || ''), n: l.item_count || 0 })).filter((l) => l.ref);
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
      try { this._need(src.kind); } catch { continue; } // (Trakt / TMDB not set up: leave the last copy)
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

module.exports = { HomeLists, parseSource, CHARTS };
