'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchAny } = require('./net');
const { JsonFile, ShardedJson } = require('./store');
const { log } = require('./util');

const IMG = 'https://image.tmdb.org/t/p/';
const META_V = 2; // bump when details() starts keeping something new
const STALE = Symbol('stale'); // on an answer from the cache past its time (TMDB not answering just then)

/**
 * The Movie Database (themoviedb.org): free API key from the admin. Used to match titles, fetch artwork, plots,
 * genres, cast and age ratings, and — most importantly — "people who liked X also liked Y" recommendations.
 * Every answer is cached on disk, and requests are rate-limited.
 */
class Tmdb {
  constructor({ dataDir, getKey, base, getLang }) {
    this.dir = path.join(dataDir, 'cache', 'tmdb');
    fs.mkdirSync(this.dir, { recursive: true });
    this.getKey = getKey;
    this.base = base;
    this.map = new JsonFile(path.join(dataDir, 'tmdb-map.json'), { m: {} }, { delay: 15000, background: true }); // item key -> {id, type} | {none: ts}
    // item key -> metadata: a quarter of a million titles is ~150 MB, so it's kept in 64 pieces (data/meta/).
    this.meta = new ShardedJson(path.join(dataDir, 'meta'), { legacy: path.join(dataDir, 'meta.json'), delay: 15000 });
    // Series → each episode's title, plot, picture and air date (see episodes()), in pieces like meta.
    this.eps = new ShardedJson(path.join(dataDir, 'meta-eps'), { delay: 15000 });
    // The language TMDB's titles and plots are in ('' = TMDB's default, US English).
    this.getLang = getLang || (() => '');
    this.queue = Promise.resolve();
    this.inflight = 0;
    this.last = 0;
    this.lastError = '';
    // TMDB said to slow down (429) or isn't answering properly (5xx, timeouts): no request before this time.
    this.pauseUntil = 0;
    this.trouble = 0; // such answers in a row
  }

  /** Waits before the next request: as long as TMDB asked (Retry-After), or longer each time it keeps failing (up to 30 s). */
  _slowDown(ms) {
    this.trouble++;
    const wait = ms > 0 ? Math.min(ms, 60e3) : Math.min(30e3, 1000 * 2 ** Math.min(5, this.trouble - 1));
    this.pauseUntil = Math.max(this.pauseUntil, Date.now() + wait);
  }

  enabled() { return !!this.getKey(); }

  async get(p, params = {}, ttl = 7 * 86400e3) {
    const key = this.getKey();
    if (!key) throw new Error('No TMDB key');
    // (Text in the household's chosen language: Admin → Recommendations. A separate answer in the cache per language.)
    const lang = this.getLang();
    if (lang && !params.language && !/^\/configuration/.test(p)) params = { ...params, language: lang };
    const q = new URLSearchParams(params);
    const bearer = key.startsWith('eyJ');
    if (!bearer) q.set('api_key', key);
    const url = `${this.base}${p}?${q}`;
    const file = path.join(this.dir, crypto.createHash('sha1').update(p + '?' + new URLSearchParams(params)).digest('hex') + '.json');
    // (Read without holding the server up: there are tens of thousands of these, on a slow disk sometimes.)
    let st = null;
    try { st = await fs.promises.stat(file); if (Date.now() - st.mtimeMs < ttl) return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch {}
    // TMDB failing (5xx, timeouts): the older answer in the cache, when there is one, rather than nothing.
    const stale = async (e) => {
      if (!st) throw e;
      let j;
      try { j = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { throw e; }
      if (j && typeof j === 'object') Object.defineProperty(j, STALE, { value: true });
      return j;
    };
    // ~35 requests per 10 s keeps well inside TMDB's limits.
    // (And not before a pause TMDB asked for: a 429 used to be followed straight away by the next title's request,
    // ~7 a second for as long as the job ran.)
    const turn = this.queue.then(async () => { const wait = Math.max(this.last + 150, this.pauseUntil) - Date.now(); /* ~7 requests a second: well inside TMDB's limits */ if (wait > 0) await new Promise((r) => setTimeout(r, wait)); this.last = Date.now(); });
    this.queue = turn.catch(() => {});
    await turn;
    let res;
    try { res = await fetchAny(url, { headers: { Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${key}` } : {}) }, signal: AbortSignal.timeout(15000) }); } catch (e) { this._slowDown(0); return stale(e); }
    if (res.status === 401) { this.lastError = 'TMDB rejected the API key.'; throw new Error(this.lastError); }
    if (res.status === 404) { fs.writeFileSync(file, '{}'); return {}; }
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) this._slowDown(res.status === 429 ? Number(res.headers.get('retry-after')) * 1000 : 0);
      try { await res.body?.cancel(); } catch {} // (let the connection go)
      this.lastError = `TMDB answered HTTP ${res.status}`;
      if (res.status >= 500) return stale(new Error(this.lastError));
      throw new Error(this.lastError);
    }
    const j = await res.json();
    this.trouble = 0;
    this.lastError = '';
    fs.writeFile(file, JSON.stringify(j), () => {});
    return j;
  }

  async test() {
    const j = await this.get('/configuration', {}, 0);
    return !!j && !!j.images;
  }

  /** Finds the TMDB entry for a catalogue item (movie or show). Cached, including misses (for 30 days). */
  async match(it) {
    if (!it || (it.t !== 'movie' && it.t !== 'show')) return null;
    const m = this.map.data.m[it.k];
    if (m && m.id) return m;
    if (m && m.none && m.manual) return null; // someone said none of TMDB's suggestions is right
    if (m && m.none && Date.now() - m.none < 30 * 86400e3) return null;
    const type = it.t === 'show' ? 'tv' : 'movie';
    let found = null;
    // The provider's own TMDB number, when it gives one — not "0", and not one TMDB already said it doesn't have
    // (badList: then the name is looked up instead).
    const listId = /^\d+$/.test(String(it.tmdb || '')) ? Number(it.tmdb) : 0;
    if (listId > 0 && !(m && m.badList === listId)) found = { id: listId, type, list: 1 };
    else {
      const query = it.n.replace(/\s*\((19|20)\d{2}\)\s*$/, '').trim();
      const params = { query, include_adult: 'false' };
      if (it.y) params[type === 'tv' ? 'first_air_date_year' : 'year'] = String(it.y);
      let j = await this.get(`/search/${type}`, params);
      if ((!j.results || !j.results.length) && it.y) { delete params.year; delete params.first_air_date_year; j = await this.get(`/search/${type}`, params); }
      const r = (j.results || [])[0];
      if (r) found = { id: r.id, type };
      // Someone picked the right entry while TMDB was being asked: theirs stays.
      const now = this.map.data.m[it.k];
      if (now && now.manual) return now.id ? now : null;
    }
    this.map.data.m[it.k] = found || { none: Date.now() };
    this.map.save();
    return found;
  }

  /** Artwork, plot, genres, cast, director, age rating and runtime for an item. Stored in meta.json. */
  async details(it, { fresh = false, again = false } = {}) {
    const mt = await this.match(it);
    if (!mt) return null;
    const have = this.meta.data.m[it.k];
    if (have && have.tmdb === mt.id && have.v === META_V && Date.now() - (have.at || 0) < 30 * 86400e3) return have;
    const extra = mt.type === 'movie' ? 'credits,release_dates' : 'credits,content_ratings';
    // Older records (without collections): rebuild them from the cached answer when there is one (no request).
    const ttl = fresh ? 3600e3 : have && have.tmdb === mt.id && have.v !== META_V ? 365 * 86400e3 : undefined;
    const j = await this.get(`/${mt.type}/${mt.id}`, { append_to_response: extra }, ttl);
    if (!j || !j.id) {
      // TMDB doesn't have that entry (any more): an automatic match is dropped so the title is looked up again later
      // (it was kept for good). One the household picked stays.
      if (j && !j[STALE] && !mt.manual && this.map.data.m[it.k] === mt) {
        // The provider's TMDB number was wrong ("0", or a film's number on a series): look the name up instead, now.
        // (It used to be forgotten and taken again next time — those titles stayed "not looked up yet" for good.)
        if (mt.list && !again) { this.map.data.m[it.k] = { badList: mt.id }; this.map.save(); return this.details(it, { fresh, again: true }); }
        delete this.map.data.m[it.k]; this.map.save();
      }
      return null;
    }
    // (An older answer from the cache, TMDB not answering: the details kept already are as good.)
    if (j[STALE] && have && have.tmdb === mt.id) return have;
    // The household picked another entry while this one was being fetched: don't put the old one's details back.
    const cur = this.map.data.m[it.k];
    if (cur && cur.manual && !mt.manual) return cur.id ? this.details(it) : null;
    let cert = '';
    if (mt.type === 'movie') {
      const us = ((j.release_dates || {}).results || []).find((r) => r.iso_3166_1 === 'US');
      cert = us ? ((us.release_dates || []).find((d) => d.certification) || {}).certification || '' : '';
    } else {
      const us = ((j.content_ratings || {}).results || []).find((r) => r.iso_3166_1 === 'US');
      cert = us ? us.rating || '' : '';
    }
    const crew = (j.credits || {}).crew || [];
    const meta = {
      tmdb: mt.id, type: mt.type, at: Date.now(),
      plot: j.overview || '', gn: (j.genres || []).map((g) => g.name),
      cast: ((j.credits || {}).cast || []).slice(0, 8).map((c) => c.name).join(', '),
      dir: (crew.find((c) => c.job === 'Director') || {}).name || (j.created_by || []).map((c) => c.name).join(', '),
      poster: j.poster_path ? IMG + 'w342' + j.poster_path : '', bd: j.backdrop_path ? IMG + 'w1280' + j.backdrop_path : '',
      y: parseInt((j.release_date || j.first_air_date || '').slice(0, 4), 10) || 0, c: cert, r: j.vote_average ? Math.round(j.vote_average * 10) / 10 : 0,
      d: j.runtime ? j.runtime * 60 : 0, title: j.title || j.name || '', v: META_V,
    };
    if (j.belongs_to_collection && j.belongs_to_collection.id) meta.col = { id: j.belongs_to_collection.id, name: j.belongs_to_collection.name || '' };
    if (mt.manual) meta.manual = 1;
    if (have && have.at && have.tmdb === mt.id && have.v !== META_V) meta.at = have.at;
    if (j[STALE]) meta.at = 0; // (from an old answer: asked again next time)
    this.meta.data.m[it.k] = meta;
    this.meta.save();
    return meta;
  }

  /**
   * Each episode of a series as TMDB has it: { id, at, s: { season: { episode: [title, plot, still, air date,
   * minutes, rating] } } }. seasons: just those (the ones the household's lists have); otherwise all of them.
   * Kept for two weeks (a season still airing gets new episodes).
   */
  async episodes(it, { seasons = null, fresh = false } = {}) {
    if (!it || it.t !== 'show') return null;
    const mt = await this.match(it);
    if (!mt || !mt.id || mt.type !== 'tv') return null;
    const have = this.eps.data.m[it.k];
    const same = have && have.id === mt.id;
    if (!fresh && same && Date.now() - (have.at || 0) < 14 * 86400e3 && (!seasons || seasons.every((n) => have.s[n]))) return have;
    // (The series' own details, as details() asked for them: from the cache, no new request.)
    const j = await this.get(`/tv/${mt.id}`, { append_to_response: 'credits,content_ratings' }, fresh ? 3600e3 : 7 * 86400e3);
    if (!j || !j.id) return same ? have : null;
    let want = (j.seasons || []).map((x) => x.season_number).filter((n) => Number.isInteger(n) && n >= 0);
    if (seasons) want = want.filter((n) => seasons.includes(n));
    else want = want.filter((n) => n > 0);
    const out = { id: mt.id, at: Date.now(), s: same ? { ...have.s } : {} };
    for (const n of want.slice(0, 60)) {
      const sj = await this.get(`/tv/${mt.id}/season/${n}`, {}, fresh ? 3600e3 : 7 * 86400e3).catch(() => null);
      if (!sj || !Array.isArray(sj.episodes)) continue;
      const se = {};
      for (const e of sj.episodes) {
        if (!Number.isInteger(e.episode_number)) continue;
        se[e.episode_number] = [e.name || '', String(e.overview || '').slice(0, 700), e.still_path ? IMG + 'w300' + e.still_path : '', e.air_date || '', e.runtime || 0, e.vote_average ? Math.round(e.vote_average * 10) / 10 : 0];
      }
      out.s[n] = se;
    }
    this.eps.data.m[it.k] = out;
    this.eps.save();
    return out;
  }

  /** TMDB's own "recommended" and "similar" titles for an item: [{id, type, title, year}]. */
  async related(it) {
    const mt = await this.match(it);
    if (!mt) return [];
    const [a, b] = await Promise.all([
      this.get(`/${mt.type}/${mt.id}/recommendations`, {}).catch(() => ({})),
      this.get(`/${mt.type}/${mt.id}/similar`, {}).catch(() => ({})),
    ]);
    const out = [];
    const seen = new Set();
    for (const [src, w] of [[a, 1], [b, 0.6]]) {
      for (const [i, r] of (src.results || []).entries()) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push({ id: r.id, type: mt.type, title: r.title || r.name || '', year: parseInt((r.release_date || r.first_air_date || '').slice(0, 4), 10) || 0, w: w * (1 - i / 40) });
      }
    }
    return out;
  }

  /**
   * Possible TMDB entries for an item whose details look wrong: searches movies and series with and without the
   * year, and with the title's parts ("Original, English title"). Best guesses first.
   */
  async candidates(it, query) {
    const base = String(query || it.n || '').replace(/\s*\((19|20)\d{2}\)\s*$/, '').trim();
    const queries = [base];
    if (!query) for (const part of base.split(/\s*,\s+|\s+[-–:]\s+/)) if (part.length > 2 && !queries.includes(part)) queries.push(part);
    const types = it.t === 'show' ? ['tv', 'movie'] : ['movie', 'tv'];
    const seen = new Set();
    const out = [];
    const cur = this.map.data.m[it.k];
    for (const type of types) {
      for (const q of queries.slice(0, 3)) {
        const params = { query: q, include_adult: 'false' };
        const tries = it.y && !query ? [{ ...params, [type === 'tv' ? 'first_air_date_year' : 'year']: String(it.y) }, params] : [params];
        for (const p of tries) {
          let j;
          try { j = await this.get(`/search/${type}`, p); } catch { continue; }
          for (const r of (j.results || []).slice(0, 8)) {
            const id = `${type}:${r.id}`;
            if (seen.has(id)) continue;
            seen.add(id);
            const year = parseInt((r.release_date || r.first_air_date || '').slice(0, 4), 10) || 0;
            let score = (r.popularity || 0) / 100 + (r.vote_count || 0) / 2000;
            if (it.y && year) score += Math.max(0, 3 - Math.abs(year - it.y));
            if (type === (it.t === 'show' ? 'tv' : 'movie')) score += 1.5;
            if (String(r.title || r.name || '').toLowerCase() === base.toLowerCase()) score += 2;
            out.push({ id: r.id, type, title: r.title || r.name || '', original: r.original_title || r.original_name || '', year, plot: (r.overview || '').slice(0, 300), poster: r.poster_path ? IMG + 'w185' + r.poster_path : '', score, current: !!(cur && cur.id === r.id && cur.type === type) });
          }
        }
      }
    }
    out.sort((a, b) => b.current - a.current || b.score - a.score);
    return out.slice(0, 8);
  }

  /** Someone picked the right entry (or "none of these"): remember it for everyone, and fetch its details. */
  async setMatch(it, choice) {
    if (choice && choice.none) {
      this.map.data.m[it.k] = { none: Date.now(), manual: 1 };
      delete this.meta.data.m[it.k];
      this.map.save(); this.meta.save();
      return null;
    }
    const type = choice.type === 'tv' ? 'tv' : 'movie';
    this.map.data.m[it.k] = { id: Number(choice.id), type, manual: 1 };
    delete this.meta.data.m[it.k];
    this.map.save();
    return this.details(it);
  }

  /** A film series ("The Matrix Collection"): its parts in release order. */
  async collection(id) {
    const j = await this.get(`/collection/${Number(id)}`, {}, 14 * 86400e3);
    if (!j || !j.id) return null;
    const parts = (j.parts || []).map((p) => ({ id: p.id, title: p.title || '', year: parseInt((p.release_date || '').slice(0, 4), 10) || 0, poster: p.poster_path ? IMG + 'w185' + p.poster_path : '', released: !!p.release_date && new Date(p.release_date) <= new Date() }))
      .sort((a, b) => (a.year || 9999) - (b.year || 9999));
    return { id: j.id, name: j.name || '', parts };
  }

  /** Titles renamed in the catalogue: move their matches and details to the new keys. */
  migrateKeys(map) {
    let n = 0;
    for (const store of [this.map, this.meta, this.eps]) {
      const m = store.data.m;
      for (const [from, to] of map) {
        if (!(from in m)) continue;
        if (!(to in m) || (m[from] && m[from].manual)) m[to] = m[from];
        delete m[from];
        n++;
      }
      if (n) store.save();
    }
    return n;
  }

  /** Background job: fetch details for many items, a few at a time. */
  async enrich(items, { onItem, onStart, onDone, stop, fresh = false } = {}) {
    let done = 0;
    let breath = Date.now();
    for (const it of items) {
      if (stop && stop()) break;
      // Titles already known are done without waiting for anything: every few dozen milliseconds let everything else
      // through (a run of 30,000 of those held the whole server up for minutes — pages timed out).
      if (Date.now() - breath > 30) { await new Promise((r) => setImmediate(r)); breath = Date.now(); }
      if (onStart) onStart(it);
      let m = null;
      try { m = await this.details(it, { fresh }); if (m && onItem) onItem(it, m); } catch (e) { if (/key/.test(e.message)) { log(e.message); throw e; } }
      if (onDone) onDone(it, m);
      done++;
    }
    return done;
  }
}

module.exports = { Tmdb };
