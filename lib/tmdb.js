'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchAny } = require('./net');
const { JsonFile, ShardedJson } = require('./store');
const { log } = require('./util');
const { AsyncLocalStorage } = require('async_hooks');
// What a page is waiting for goes ahead of the background jobs (matching, filling in details…) — see turn().
// (Set around each request the server answers; a job a request starts stops counting as the page's after a minute.)
const PAGE = new AsyncLocalStorage();

const { pickCert, seasonsOfGroup, IMG } = require('./tmdbmore'); // (IMG: TMDB's picture address — TMDB_IMG_BASE points it at a stand-in, for tests)
const META_V = 2; // bump when details() starts keeping something new (extras — services, keywords — are marked x)
const STALE = Symbol('stale'); // on an answer from the cache past its time (TMDB not answering just then)
const yearOf = (r) => parseInt(String((r && (r.release_date || r.first_air_date)) || '').slice(0, 4), 10) || 0;
/** The year a list first had this title (its "added" date), or 0. */
const addedYear = (it) => (it && it.ad > 0 && it.ad < Date.now() + 86400e3 ? new Date(it.ad).getFullYear() : 0);
/**
 * The title's own year (the provider's), not one TMDB's details filled in (it._ym: see applyMeta in server.js).
 * (1970: a provider's empty release date read as a date — "1970-01-01" — so no year at all.)
 */
const ownYear = (it) => { const y = it && !it._ym ? it.y || 0 : 0; return y === 1970 ? 0 : y; };
/** The languages spoken in a title (TMDB's spoken_languages, or a series' languages). */
const langsOf = (j) => [...new Set(((j.spoken_languages || []).map((x) => x && x.iso_639_1)).concat(j.languages || []).filter((x) => typeof x === 'string' && /^[a-z]{2}$/.test(x)))].slice(0, 8);
const plainT = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
/**
 * A TMDB entry that can't be this title: years apart from the title's own, or out years after the list had it
 * ("Fall", added in 2022, given the number of "Fall 2: Deadpoint" from 2026). late: the list had it early on purpose.
 */
const yearConflict = (it, ty, late) => {
  if (!ty) return false;
  const own = ownYear(it);
  if (own) return Math.abs(own - ty) > 1;
  const ay = addedYear(it);
  return !late && !!ay && ty > ay + 1;
};
// Watch providers TMDB lists as "<service> Amazon Channel" etc.: the service itself.
const CHANNEL_SUFFIX = /\s+(?:amazon|apple tv|roku premium|youtube|prime video)\s+channels?$/i;

/**
 * The Movie Database (themoviedb.org): free API key from the admin. Used to match titles, fetch artwork, plots,
 * genres, cast and age ratings, and — most importantly — "people who liked X also liked Y" recommendations.
 * Every answer is cached on disk, and requests are rate-limited.
 */
class Tmdb {
  /** How many titles have been matched — counted at most every 20 seconds (counting 200,000 keys takes 40 ms, and it
      was done for every row of every Home page to see whether anything had changed). */
  get mapCount() {
    const now = Date.now();
    if (!this._mc || now - this._mc.at > 20000) this._mc = { at: now, n: this.map && this.map.data && this.map.data.m ? Object.keys(this.map.data.m).length : 0 };
    return this._mc.n;
  }

  constructor({ dataDir, getKey, base, getLang, getRegion, wantExtras }) {
    this.dir = path.join(dataDir, 'cache', 'tmdb');
    fs.mkdirSync(this.dir, { recursive: true });
    this.getKey = getKey;
    this.base = base;
    this.map = new JsonFile(path.join(dataDir, 'tmdb-map.json'), { m: {} }, { delay: 15000, background: true }); // item key -> {id, type} | {none: ts}
    // (Every change to it asks for a save: that's when the count above is taken again.)
    { const sv = this.map.save.bind(this.map); this.map.save = (...a) => { this._mc = null; return sv(...a); }; }
    // item key -> metadata: a quarter of a million titles is ~150 MB, so it's kept in 64 pieces (data/meta/).
    this.meta = new ShardedJson(path.join(dataDir, 'meta'), { legacy: path.join(dataDir, 'meta.json'), delay: 15000 });
    // Series → each episode's title, plot, picture and air date (see episodes()), in pieces like meta.
    this.eps = new ShardedJson(path.join(dataDir, 'meta-eps'), { delay: 15000 });
    // The language TMDB's titles and plots are in ('' = TMDB's default, US English).
    this.getLang = getLang || (() => '');
    // Streaming services are by country (Admin → Categories → Smarter categories); whether they're wanted at all.
    this.getRegion = getRegion || (() => 'US');
    this.wantExtras = wantExtras || (() => false);
    this.waiting = { page: [], job: [] }; // (requests waiting their turn — a page's go first)
    this.turnT = null;
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

  /**
   * What smarter categories use, from a details answer: keywords (Christmas, superhero…), the streaming services it's
   * on in the household's country, its TV networks and studios, original language, and how popular it is worldwide.
   */
  static extrasOf(j, region = 'US') {
    const kw = ((j.keywords || {}).keywords || (j.keywords || {}).results || []).map((k) => String(k.name || '')).filter(Boolean).slice(0, 40);
    const pr = (((j['watch/providers'] || {}).results || {})[region || 'US']) || {};
    const wp = [];
    for (const kind of ['flatrate', 'free', 'ads']) for (const p of pr[kind] || []) { const n = String(p.provider_name || '').replace(CHANNEL_SUFFIX, '').trim(); if (n && !wp.includes(n)) wp.push(n); }
    const out = { x: 1, kw, wp: wp.slice(0, 12), wr: region || 'US' };
    const nw = (j.networks || []).map((n) => String(n.name || '')).filter(Boolean).slice(0, 6);
    if (nw.length) out.nw = nw;
    const co = (j.production_companies || []).map((c) => String(c.name || '')).filter(Boolean).slice(0, 6);
    if (co.length) out.co = co;
    if (j.original_language) out.ol = j.original_language;
    const sl = langsOf(j);
    if (sl.length) out.sl = sl;
    if (j.popularity) out.pop = Math.round(j.popularity * 10) / 10;
    if (j.vote_count) out.vc = j.vote_count;
    return out;
  }

  /**
   * A match that can't be this title: TMDB's year is years apart from the title's own, or after the list had it
   * (a search for a name with no year, or a wrong number from the provider). Dropped, so it's looked up again.
   */
  doubtful(it) {
    const m = it && this.map.data.m[it.k];
    // (rc: looked up again once already — what that found stays, so the same titles aren't dropped and found again
    // after every build: the provider's year is sometimes a few years off.)
    if (!m || !m.id || m.manual || m.rc) return false;
    const d = this.meta.data.m[it.k];
    return !!(d && d.y && String(d.tmdb) === String(m.id) && yearConflict(it, d.y, m.late));
  }

  /**
   * A film's or series' language from TMDB, for a copy whose own was only guessed (it._lgw: lib/catalog.js): its
   * original language, as [code] — or null to leave it. Not for cartoons and children's titles (usually dubbed), a
   * multi-language copy, or one labelled with a language the title is also spoken in. names: the app's language codes.
   */
  static langFor(it, m, names) {
    if (!it || !m || !m.ol || !it._lgw) return null;
    const ol = m.ol === 'cn' ? 'zh' : m.ol;
    if (!names[ol]) return null; // (one this app doesn't know, or "xx": no language)
    const lg = it.lg || [];
    if (lg.includes('mul') || (lg.length === 1 && lg[0] === ol)) return null;
    if (it.kids || (m.gn || []).some((g) => /animation|family|kids/i.test(g))) return null;
    if (lg.length && (m.sl || []).some((x) => lg.includes(x))) return null;
    return [ol];
  }

  /** An answer already in the cache, whatever its age, or null: no request is made. */
  async cached(p, params = {}) {
    const lang = this.getLang();
    if (lang && !params.language && !/^\/configuration/.test(p)) params = { ...params, language: lang };
    const file = path.join(this.dir, crypto.createHash('sha1').update(p + '?' + new URLSearchParams(params)).digest('hex') + '.json');
    try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return null; }
  }

  /**
   * The original language (and the languages spoken) of titles looked up before those were kept, read from TMDB's
   * answers already in the cache — no requests. Resolves to how many were filled in.
   */
  async backfillLanguages({ stop } = {}) {
    const m = this.meta.data.m;
    let n = 0, i = 0;
    for (const [k, d] of Object.entries(m)) {
      if (stop && stop()) break;
      if (!d || d.ol || d.noOl || !d.tmdb) continue;
      if ((++i & 63) === 0) await new Promise((r) => setImmediate(r));
      const movie = d.type !== 'tv';
      let j = null;
      for (const extra of movie ? ['credits,release_dates,keywords,watch/providers', 'credits,release_dates'] : ['credits,content_ratings,keywords,watch/providers', 'credits,content_ratings']) {
        j = await this.cached(`/${movie ? 'movie' : 'tv'}/${d.tmdb}`, { append_to_response: extra });
        if (j && j.id) break;
      }
      if (j && j.original_language) { d.ol = j.original_language; const sl = langsOf(j); if (sl.length) d.sl = sl; n++; } else d.noOl = 1;
    }
    if (n) this.meta.save();
    return n;
  }

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
    const forPage = Tmdb.forPage();
    await this.turn(forPage);
    let res;
    // (A page doesn't wait a quarter of a minute for an answer: the saved one, or the page says so, after 8 s.)
    try { res = await fetchAny(url, { headers: { Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${key}` } : {}) }, signal: AbortSignal.timeout(forPage ? 8000 : 15000) }); } catch (e) { this._slowDown(0); return stale(e); }
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

  /** Is what's running now for a page someone has open (a request, less than a minute old)? */
  static forPage() { const at = PAGE.getStore(); return !!at && Date.now() - at < 60e3; }
  /** Runs fn (a request the server is answering) as a page's: its TMDB requests go first. */
  static page(fn) { return PAGE.run(Date.now(), fn); }
  /** Runs fn as a background job's, whatever started it. */
  static job(fn) { return PAGE.exit(fn); }

  /**
   * Waits for this request's turn: ~7 a second (well inside TMDB's limits), and not before a pause TMDB asked for.
   * A page's requests go ahead of the background jobs' — a person's page used to wait behind a whole queue of
   * titles being matched — and wait out at most 3 s of a pause after timeouts or errors (the saved answer, or an
   * error, rather than a page that sits there half a minute).
   */
  turn(forPage) {
    return new Promise((go) => {
      this.waiting[forPage ? 'page' : 'job'].push({ go, at: Date.now() });
      if (forPage && this.turnT) { clearTimeout(this.turnT); this.turnT = null; }
      this._next();
    });
  }
  _next() {
    if (this.turnT) return;
    const page = this.waiting.page.length > 0;
    const q = page ? this.waiting.page : this.waiting.job;
    if (!q.length) return;
    const pause = page ? Math.min(this.pauseUntil, q[0].at + 3000) : this.pauseUntil;
    const wait = Math.max(this.last + 150, pause) - Date.now();
    if (wait > 0) { this.turnT = setTimeout(() => { this.turnT = null; this._next(); }, wait); return; }
    this.last = Date.now();
    q.shift().go();
    this._next();
  }

  /** The file an answer is (or would be) kept in. */
  cacheFile(p, params = {}) {
    const lang = this.getLang();
    if (lang && !params.language && !/^\/configuration/.test(p)) params = { ...params, language: lang };
    return path.join(this.dir, crypto.createHash('sha1').update(p + '?' + new URLSearchParams(params)).digest('hex') + '.json');
  }
  /**
   * The saved answer at once, whatever its age — and when it is older than freshFor, TMDB is asked again behind it,
   * for next time. TMDB is only waited for when nothing is saved. (For what a page shows the moment it opens.)
   */
  async getSoft(p, params = {}, freshFor = 86400e3) {
    const file = this.cacheFile(p, params);
    let st = null;
    try { st = await fs.promises.stat(file); } catch {}
    if (st) {
      let j;
      try { j = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch {}
      if (j && typeof j === 'object') {
        if (Date.now() - st.mtimeMs > freshFor && this.getKey()) {
          if (!this._behind) this._behind = new Set();
          // (One at a time per answer, and not a pile of them: a busy evening opens many pages.)
          // (As a background job: the page has its answer already.)
          if (!this._behind.has(file) && this._behind.size < 40) { this._behind.add(file); Tmdb.job(() => this.get(p, params, 0)).catch(() => {}).finally(() => this._behind.delete(file)); }
        }
        return j;
      }
    }
    return this.get(p, params, freshFor);
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
      if (ownYear(it)) params[type === 'tv' ? 'first_air_date_year' : 'year'] = String(ownYear(it));
      let j = await this.get(`/search/${type}`, params);
      if ((!j.results || !j.results.length) && ownYear(it)) { delete params.year; delete params.first_air_date_year; j = await this.get(`/search/${type}`, params); }
      // No year to go by: not something that came out after the list had it ("Resident Evil" added in 2020 isn't the
      // 2026 film — TMDB puts the newest, most talked-about one first).
      // (None that old: the newest it is — the list had it early. Marked, so it isn't doubted again: see doubtful.)
      // (And the one called exactly that first: "Nightmare" 2022 is "Nightmare", not "Nightmare Alley".)
      // A year of its own: within a year of it, or one called exactly that (the provider's year is sometimes a few
      // off) — not another film of a similar name years apart ("The Gates" 2022 isn't "Enemy at the Gates" 2001).
      const own = ownYear(it);
      const latest = own ? 0 : addedYear(it);
      const fits = (x) => (own ? !yearOf(x) || Math.abs(yearOf(x) - own) <= 1 : !latest || !yearOf(x) || yearOf(x) <= latest + 1);
      const nq = plainT(query);
      const res = j.results || [];
      const exact = (x) => plainT(x.title || x.name) === nq || plainT(x.original_title || x.original_name) === nq;
      const r = res.find((x) => fits(x) && exact(x)) || res.find(fits) || (own ? res.find(exact) : res[0]);
      if (r) found = { id: r.id, type };
      if (r && latest && yearOf(r) > latest + 1) found.late = 1;
      // Someone picked the right entry while TMDB was being asked: theirs stays.
      const now = this.map.data.m[it.k];
      if (now && now.manual) return now.id ? now : null;
    }
    // (Looked up again after a doubtful match — see doubtful: marked, and a wrong number from the provider stays off.)
    if (m && m.rc) { if (found) found.rc = 1; }
    this.map.data.m[it.k] = found || Object.assign({ none: Date.now() }, m && m.rc ? { rc: 1 } : null, m && m.badList ? { badList: m.badList } : null);
    this.map.save();
    return found;
  }

  /** Artwork, plot, genres, cast, director, age rating and runtime for an item. Stored in meta.json. */
  async details(it, { fresh = false, again = false } = {}) {
    const mt = await this.match(it);
    if (!mt) return null;
    const have = this.meta.data.m[it.k];
    // (Details from before streaming services and keywords were kept: fetched again when those are wanted — see
    // wantExtras, Admin → Categories → Smarter categories.)
    if (have && have.tmdb === mt.id && have.v === META_V && Date.now() - (have.at || 0) < 30 * 86400e3 && (have.x || !this.wantExtras())) return have;
    const extra = (mt.type === 'movie' ? 'credits,release_dates' : 'credits,content_ratings') + ',keywords,watch/providers';
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
    // The provider's TMDB number is another film's (years apart from this one): look the name up instead.
    if (mt.list && !mt.manual && !again && yearConflict(it, parseInt((j.release_date || j.first_air_date || '').slice(0, 4), 10) || 0)) {
      if (this.map.data.m[it.k] === mt) { this.map.data.m[it.k] = { badList: mt.id }; this.map.save(); }
      return this.details(it, { fresh, again: true });
    }
    // The household picked another entry while this one was being fetched: don't put the old one's details back.
    const cur = this.map.data.m[it.k];
    if (cur && cur.manual && !mt.manual) return cur.id ? this.details(it) : null;
    // The age rating: the household's country's, then the US one, then another country's — a title with no US rating
    // (many from elsewhere) used to have none, and parental limits let it through.
    const cert = pickCert(j, mt.type, this.getRegion(), require('./catalog').certLevel).c;
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
    // For subtitle searches: a film's IMDb number, and the name it has where it was made ("La casa de papel").
    if (/^tt\d{5,10}$/.test(String(j.imdb_id || ''))) meta.im = j.imdb_id;
    const ot = String(j.original_title || j.original_name || '').slice(0, 120);
    if (ot && ot !== meta.title) meta.ot = ot;
    // (Found out when its page was opened — lib/tmdbmore.js: kept through a refresh of the basics.)
    if (have && have.tmdb === mt.id) { if (!meta.im && have.im) meta.im = have.im; if (have.aka) meta.aka = have.aka; }
    Object.assign(meta, Tmdb.extrasOf(j, this.getRegion()));
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
    // (eg: the household chose another order for this series' episodes — DVD order, numbered straight through …)
    const eg = /^[0-9a-f]{24}$/i.test(String(mt.eg || '')) ? String(mt.eg) : '';
    const same = have && have.id === mt.id && (have.eg || '') === eg;
    // (A series with an episode coming: looked at again once that day has come — it's out, or the next one is known.)
    const today = new Date().toISOString().slice(0, 10);
    const nextPassed = same && have.nx && have.nx[3] && have.nx[3] < today && Date.now() - (have.at || 0) > 86400e3;
    // (Kept before the next episode was: looked at again once, when the series' page is opened.)
    const before = same && have.nx === undefined && !!seasons;
    if (!fresh && same && !nextPassed && !before && Date.now() - (have.at || 0) < 14 * 86400e3 && (!seasons || seasons.every((n) => have.s[n]))) return have;
    // (The series' own details, as details() asked for them: from the cache, no new request.)
    const dm = this.meta.data.m[it.k];
    const j = await this.get(`/tv/${mt.id}`, { append_to_response: dm && dm.x ? 'credits,content_ratings,keywords,watch/providers' : 'credits,content_ratings' }, fresh || nextPassed || before ? 3600e3 : 7 * 86400e3);
    if (!j || !j.id) return same ? have : null;
    // The next episode TMDB knows of ([season, episode, title, air date]), and its season too — a new season the
    // lists don't have yet — so the series' page can say what's coming and when.
    const nx = j.next_episode_to_air && Number.isInteger(j.next_episode_to_air.season_number) ? [j.next_episode_to_air.season_number, j.next_episode_to_air.episode_number, j.next_episode_to_air.name || '', j.next_episode_to_air.air_date || ''] : null;
    let want = (j.seasons || []).map((x) => x.season_number).filter((n) => Number.isInteger(n) && n >= 0);
    if (seasons) want = want.filter((n) => seasons.includes(n) || (nx && n === nx[0]));
    else want = want.filter((n) => n > 0);
    const out = { id: mt.id, at: Date.now(), s: same ? { ...have.s } : {}, nx, end: /ended|canceled/i.test(j.status || '') ? 1 : 0 };
    if (eg) {
      // The whole order in one answer. (What is coming next is numbered TMDB's usual way: not said for these.)
      const gj = await this.get(`/tv/episode_group/${eg}`, {}, fresh ? 3600e3 : 7 * 86400e3).catch(() => null);
      const s = seasonsOfGroup(gj, (p) => (p ? IMG + 'w300' + p : ''));
      if (!Object.keys(s).length) return same ? have : null;
      out.s = s; out.eg = eg; out.nx = null;
      this.eps.data.m[it.k] = out;
      this.eps.save();
      return out;
    }
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

  /**
   * A title's trailer on YouTube (its video id), from TMDB: an official trailer first, in the household's language or
   * English, then any trailer, then a teaser. Only for titles already matched (no searching for one just for this).
   * '' when there's none. (Kept a month: trailers don't change.)
   */
  async trailer(it) {
    const mt = it && this.map.data.m[it.k];
    if (!mt || !mt.id || !mt.type) return '';
    const lang = String(this.getLang() || 'en').slice(0, 2);
    const j = await this.get(`/${mt.type}/${mt.id}/videos`, { include_video_language: `${lang},en,null` }, 30 * 86400e3).catch(() => null);
    const vs = ((j && j.results) || []).filter((v) => v.site === 'YouTube' && /^[\w-]{11}$/.test(v.key || ''));
    const score = (v) => (v.type === 'Trailer' ? 0 : v.type === 'Teaser' ? 2 : 4) + (v.official ? 0 : 1) + (v.iso_639_1 === lang ? 0 : v.iso_639_1 === 'en' ? 0.5 : 1);
    vs.sort((a, b) => score(a) - score(b) || String(b.published_at || '').localeCompare(String(a.published_at || '')));
    const v = vs.find((x) => /^(Trailer|Teaser)$/.test(x.type));
    return v ? v.key : '';
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
  migrateKeys(map, keep) {
    let n = 0;
    for (const store of [this.map, this.meta, this.eps]) {
      const m = store.data.m;
      for (const [from, to] of map) {
        if (!(from in m)) continue;
        // (A copy merged into another title — keep: its own match stays too, as the copy is in the lists again at the
        // next build, and it's by that match that it's put together with the other again. Dropping it had that copy
        // looked up again, merged again, and its match moved again after every build — the catalogue built over and over.)
        if (keep && keep.has(from)) { if (!(to in m) && m[from] && typeof m[from] === 'object') { m[to] = { ...m[from] }; n++; } continue; }
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

module.exports = { Tmdb, yearConflict, ownYear };
