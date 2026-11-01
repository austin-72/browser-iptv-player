'use strict';
/**
 * Trakt (trakt.tv) for each profile: connect with a code shown on screen (works on TVs), log what's watched as it's
 * watched (scrobbling), keep My List and the Trakt watchlist the same, thumbs ↔ ratings, and copy history either way.
 * The admin registers a Trakt app once (client id + secret); each profile's tokens stay on this server.
 */
const path = require('path');
const { JsonFile } = require('./store');
const { HttpError, log } = require('./util');

const BASE = process.env.TRAKT_BASE || 'https://api.trakt.tv';
const LIKE = 8, DISLIKE = 3; // thumbs up / down as Trakt ratings (1–10)

class Trakt {
  /**
   * getConf() → { clientId, clientSecret }; fetch: the app's fetch.
   * lib: { catalog(), userdata, tmdbOf(it) → id string, episodes(showKey) → Promise<[...]> }
   */
  constructor({ dataDir, getConf, fetch, lib, base = BASE }) {
    this.store = new JsonFile(path.join(dataDir, 'trakt.json'), { profiles: {} });
    this.getConf = getConf;
    this.fetch = fetch;
    this.lib = lib || {};
    this.base = base;
    this.pending = new Map(); // pid → { device_code, user_code, url, expires, interval, next }
    this.searchCache = new Map();
  }

  enabled() { const c = this.getConf() || {}; return !!(c.clientId && c.clientSecret); }
  prof(pid) { return this.store.data.profiles[pid] || null; }

  status(pid) {
    const p = this.prof(pid);
    const pend = this.pending.get(pid);
    return {
      enabled: this.enabled(), connected: !!(p && p.access), user: p ? p.user || '' : '',
      opts: p ? p.opts || {} : {}, lastSync: p ? p.lastSync || 0 : 0, lastError: p ? p.lastError || '' : '',
      pending: pend && pend.expires > Date.now() ? { code: pend.user_code, url: pend.url, expires: pend.expires } : null,
    };
  }

  async _req(p, { method = 'GET', body, pid, auth = true } = {}) {
    const c = this.getConf() || {};
    if (!c.clientId) throw new HttpError(400, 'Trakt isn’t set up — the admin adds a Trakt app in Admin → Integrations.');
    const headers = { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': c.clientId, 'User-Agent': 'BrowserIPTVPlayer/2' };
    if (auth && pid) {
      await this._fresh(pid);
      const pr = this.prof(pid);
      if (!pr || !pr.access) throw new HttpError(400, 'This profile isn’t connected to Trakt.');
      headers.Authorization = `Bearer ${pr.access}`;
    }
    let r;
    try { r = await this.fetch(this.base + p, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) }); } catch (e) {
      throw new HttpError(502, `Trakt didn’t answer (${(e.cause && e.cause.message) || e.message}).`);
    }
    const t = await r.text();
    let j = null;
    try { j = t ? JSON.parse(t) : null; } catch {}
    return { status: r.status, ok: r.ok, json: j };
  }

  /** Starts connecting a profile: Trakt gives a short code the viewer types at trakt.tv/activate. */
  async start(pid) {
    const c = this.getConf() || {};
    if (!this.enabled()) throw new HttpError(400, 'Trakt isn’t set up — the admin adds a Trakt app in Admin → Integrations.');
    const r = await this._req('/oauth/device/code', { method: 'POST', body: { client_id: c.clientId }, auth: false });
    if (!r.ok || !r.json) throw new HttpError(502, `Trakt said ${r.status}. The admin can check the Trakt app details.`);
    const j = r.json;
    const pend = { device_code: j.device_code, user_code: j.user_code, url: j.verification_url || 'https://trakt.tv/activate', expires: Date.now() + (j.expires_in || 600) * 1000, interval: Math.max(1, j.interval || 5) * 1000, next: 0 };
    this.pending.set(pid, pend);
    return { code: pend.user_code, url: pend.url, expires: pend.expires, interval: pend.interval };
  }

  /** Checks whether the viewer has entered the code yet. → { state: 'waiting'|'connected'|'expired'|'denied' } */
  async poll(pid) {
    const pend = this.pending.get(pid);
    if (!pend) return { state: this.prof(pid) && this.prof(pid).access ? 'connected' : 'none' };
    if (Date.now() > pend.expires) { this.pending.delete(pid); return { state: 'expired' }; }
    if (Date.now() < pend.next) return { state: 'waiting' };
    pend.next = Date.now() + pend.interval;
    const c = this.getConf() || {};
    const r = await this._req('/oauth/device/token', { method: 'POST', body: { code: pend.device_code, client_id: c.clientId, client_secret: c.clientSecret }, auth: false });
    if (r.status === 200 && r.json && r.json.access_token) {
      this.pending.delete(pid);
      this._saveTokens(pid, r.json);
      try { const u = await this._req('/users/settings', { pid }); if (u.ok && u.json && u.json.user) this.prof(pid).user = u.json.user.username || u.json.user.name || ''; this.store.save(); } catch {}
      return { state: 'connected', user: this.prof(pid).user || '' };
    }
    if (r.status === 400) return { state: 'waiting' };
    if (r.status === 429) { pend.interval += 1000; return { state: 'waiting' }; }
    this.pending.delete(pid);
    if (r.status === 418) return { state: 'denied' };
    if (r.status === 410 || r.status === 404 || r.status === 409) return { state: 'expired' };
    return { state: 'error', error: `Trakt said ${r.status}` };
  }

  _saveTokens(pid, j) {
    const p = this.store.data.profiles[pid] || (this.store.data.profiles[pid] = { opts: { scrobble: true, watchlist: true, ratings: true } });
    p.access = j.access_token;
    p.refresh = j.refresh_token;
    p.expires = ((j.created_at || Math.floor(Date.now() / 1000)) + (j.expires_in || 7776000)) * 1000;
    p.lastError = '';
    this.store.save();
  }

  /** Refreshes a profile's token a day before it runs out. */
  async _fresh(pid) {
    const p = this.prof(pid);
    if (!p || !p.refresh || Date.now() < p.expires - 86400e3) return;
    const c = this.getConf() || {};
    const r = await this._req('/oauth/token', { method: 'POST', auth: false, body: { refresh_token: p.refresh, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', grant_type: 'refresh_token' } });
    if (r.ok && r.json && r.json.access_token) this._saveTokens(pid, r.json);
    else if (r.status === 401 || r.status === 400) { p.access = ''; p.lastError = 'Trakt signed this profile out — connect again in Settings.'; this.store.save(); }
  }

  disconnect(pid) {
    const p = this.prof(pid);
    if (p && p.access) {
      const c = this.getConf() || {};
      this._req('/oauth/revoke', { method: 'POST', auth: false, body: { token: p.access, client_id: c.clientId, client_secret: c.clientSecret } }).catch(() => {});
    }
    delete this.store.data.profiles[pid];
    this.pending.delete(pid);
    this.store.save();
  }

  setOpts(pid, opts) {
    const p = this.prof(pid);
    if (!p) throw new HttpError(400, 'This profile isn’t connected to Trakt.');
    p.opts = { ...(p.opts || {}), ...Object.fromEntries(['scrobble', 'watchlist', 'ratings'].filter((k) => k in opts).map((k) => [k, !!opts[k]])) };
    this.store.save();
    return p.opts;
  }

  // ------------------------------------------------------------ matching our titles to Trakt's
  /** What Trakt needs to know which film / episode this is. null when it can't be named. */
  async ident(it) {
    if (!it) return null;
    const cat = this.lib.catalog();
    if (it.t === 'episode') {
      const show = it.sk && cat.get(it.sk);
      if (!show || !it.s || !it.e) return null;
      const ids = await this._ids(show, 'show');
      if (!ids) return null;
      return { kind: 'episode', body: { show: { title: show.n, year: show.y || undefined, ids }, episode: { season: it.s, number: it.e } } };
    }
    if (it.t === 'movie' || it.t === 'show') {
      const ids = await this._ids(it, it.t);
      return ids ? { kind: it.t, body: { [it.t]: { title: it.n, year: it.y || undefined, ids } } } : null;
    }
    return null;
  }

  /** Trakt ids for a film or series: TMDB id when known, else a Trakt search by title and year (cached). */
  async _ids(it, type) {
    const tm = this.lib.tmdbOf ? this.lib.tmdbOf(it) : it.tmdb;
    if (tm) return { tmdb: Number(tm) };
    const key = `${type}:${it.n}:${it.y || ''}`;
    if (this.searchCache.has(key)) return this.searchCache.get(key);
    let ids = null;
    try {
      const r = await this._req(`/search/${type}?query=${encodeURIComponent(it.n)}${it.y ? `&years=${it.y}` : ''}&limit=3`, { auth: false });
      const hit = r.ok && Array.isArray(r.json) ? r.json.find((x) => x[type] && (!it.y || !x[type].year || Math.abs(x[type].year - it.y) <= 1)) : null;
      if (hit) ids = { trakt: hit[type].ids.trakt };
    } catch {}
    this.searchCache.set(key, ids);
    if (this.searchCache.size > 2000) this.searchCache.delete(this.searchCache.keys().next().value);
    return ids;
  }

  // ------------------------------------------------------------ scrobbling
  /** action: start | pause | stop; progress 0–100. */
  async scrobble(pid, action, it, progress) {
    const p = this.prof(pid);
    if (!this.enabled() || !p || !p.access || (p.opts && p.opts.scrobble === false)) return { skipped: true };
    if (!['start', 'pause', 'stop'].includes(action)) throw new HttpError(400, 'Unknown action');
    const id = await this.ident(it);
    if (!id || id.kind === 'show') return { skipped: true, why: 'not matched' };
    const r = await this._req(`/scrobble/${action}`, { method: 'POST', pid, body: { ...id.body, progress: Math.max(0, Math.min(100, Number(progress) || 0)) } });
    if (r.status === 409) return { ok: true, duplicate: true }; // Trakt already logged this a moment ago
    if (!r.ok) { p.lastError = `Logging to Trakt failed (${r.status}).`; this.store.save(); return { ok: false, status: r.status }; }
    return { ok: true };
  }

  // ------------------------------------------------------------ syncing
  /** My List ↔ watchlist and thumbs ↔ ratings, both ways. Removals on either side since the last sync carry over. */
  async sync(pid) {
    const p = this.prof(pid);
    if (!p || !p.access) throw new HttpError(400, 'This profile isn’t connected to Trakt.');
    const cat = this.lib.catalog(), ud = this.lib.userdata;
    const opts = p.opts || {};
    const out = { added: 0, removed: 0, pushed: 0, rated: 0 };
    const keyOfTrakt = (x, type) => { const o = x[type]; if (!o) return null; const ids = o.ids || {}; return this._findLocal(type, ids, o.title, o.year); };
    try {
      if (opts.watchlist !== false) {
        const [wm, ws] = await Promise.all([this._req('/sync/watchlist/movies', { pid }), this._req('/sync/watchlist/shows', { pid })]);
        const remote = new Map(); // local key → trakt entry
        for (const [r, type] of [[wm, 'movie'], [ws, 'show']]) for (const x of (r.ok && r.json) || []) { const k = keyOfTrakt(x, type); if (k) remote.set(k, { type, ids: x[type].ids }); }
        const local = new Set(ud.of(pid).data.list.filter((k) => { const it = cat.get(k); return it && (it.t === 'movie' || it.t === 'show'); }));
        const before = new Set(p.wl || []);
        // Removed on Trakt since last time → remove here; removed here → remove there.
        for (const k of local) if (before.has(k) && !remote.has(k)) { ud.toggle(pid, 'list', k, false); local.delete(k); out.removed++; }
        const drop = { movies: [], shows: [] };
        for (const [k, x] of remote) if (before.has(k) && !local.has(k)) { drop[x.type + 's'].push({ ids: x.ids }); remote.delete(k); }
        if (drop.movies.length || drop.shows.length) await this._req('/sync/watchlist/remove', { method: 'POST', pid, body: drop });
        for (const k of remote.keys()) if (!local.has(k)) { ud.toggle(pid, 'list', k, true); local.add(k); out.added++; }
        const add = { movies: [], shows: [] };
        for (const k of local) if (!remote.has(k)) { const id = await this.ident(cat.get(k)); if (id && id.body[id.kind]) { add[id.kind + 's'].push({ ids: id.body[id.kind].ids }); out.pushed++; } }
        if (add.movies.length || add.shows.length) await this._req('/sync/watchlist', { method: 'POST', pid, body: add });
        p.wl = [...local];
      }
      if (opts.ratings !== false) {
        const [rm, rs] = await Promise.all([this._req('/sync/ratings/movies', { pid }), this._req('/sync/ratings/shows', { pid })]);
        const ratings = ud.of(pid).data.ratings;
        const seen = new Set();
        for (const [r, type] of [[rm, 'movie'], [rs, 'show']]) for (const x of (r.ok && r.json) || []) {
          const k = keyOfTrakt(x, type);
          if (!k) continue;
          seen.add(k);
          const v = x.rating >= 7 ? 1 : x.rating <= 4 ? -1 : 0;
          if (v && ratings[k] !== v) { ud.rate(pid, k, v); out.rated++; }
        }
        const push = { movies: [], shows: [] };
        for (const [k, v] of Object.entries(ratings)) {
          if (seen.has(k)) continue;
          const it = cat.get(k);
          if (!it || (it.t !== 'movie' && it.t !== 'show')) continue;
          const id = await this.ident(it);
          if (id && id.body[id.kind]) push[id.kind + 's'].push({ ids: id.body[id.kind].ids, rating: v > 0 ? LIKE : DISLIKE });
        }
        if (push.movies.length || push.shows.length) { await this._req('/sync/ratings', { method: 'POST', pid, body: push }); out.rated += push.movies.length + push.shows.length; }
      }
      p.lastSync = Date.now();
      p.lastError = '';
    } catch (e) { p.lastError = e.message; this.store.save(); throw e; }
    this.store.save();
    return out;
  }

  /** Our film/series for a Trakt entry: by TMDB id, else by title and year. */
  _findLocal(type, ids, title, year) {
    const cat = this.lib.catalog();
    const want = type === 'movie' ? 'movie' : 'show';
    if (ids && ids.tmdb) {
      const k = this.lib.byTmdb ? this.lib.byTmdb(String(ids.tmdb), want) : null;
      if (k) return k;
    }
    if (title && cat.findTitle) {
      for (const k of cat.findTitle(title, year || 0)) { const it = cat.get(k); if (it && it.t === want && (!year || !it.y || Math.abs(it.y - year) <= 1)) return k; }
    }
    return null;
  }

  /** Watched films (and episodes of series we have) from Trakt → marked as watched here. */
  async importHistory(pid) {
    const ud = this.lib.userdata, cat = this.lib.catalog();
    const out = { movies: 0, episodes: 0 };
    const rm = await this._req('/sync/watched/movies', { pid });
    for (const x of (rm.ok && rm.json) || []) {
      const k = this._findLocal('movie', x.movie && x.movie.ids, x.movie && x.movie.title, x.movie && x.movie.year);
      if (k && !(ud.of(pid).data.progress[k] || {}).w) { const it = cat.get(k); ud.progress(pid, { k, p: it.d || 6000, d: it.d || 6000, t: 'movie', n: it.n }); out.movies++; }
    }
    const rs = await this._req('/sync/watched/shows', { pid });
    let shows = 0;
    for (const x of (rs.ok && rs.json) || []) {
      const sk = this._findLocal('show', x.show && x.show.ids, x.show && x.show.title, x.show && x.show.year);
      if (!sk || ++shows > 60) continue; // (each series' episodes may have to be asked from the provider)
      let eps = [];
      try { eps = await this.lib.episodes(sk); } catch { continue; }
      for (const s of x.seasons || []) for (const e of s.episodes || []) {
        const ep = eps.find((y) => y.s === s.number && y.e === e.number);
        if (ep && !(ud.of(pid).data.progress[ep.k] || {}).w) { ud.progress(pid, { k: ep.k, p: ep.d || 2700, d: ep.d || 2700, sk, t: 'episode', n: ep.n }); out.episodes++; }
      }
    }
    return out;
  }

  /** What this profile finished here → Trakt history. */
  async exportHistory(pid) {
    const ud = this.lib.userdata, cat = this.lib.catalog();
    const d = ud.of(pid).data;
    const body = { movies: [], episodes: [], shows: [] };
    const byShow = new Map();
    for (const [k, rec] of Object.entries(d.progress)) {
      if (!rec.w) continue;
      const it = cat.get(k);
      if (!it) continue;
      const at = new Date(rec.at || Date.now()).toISOString();
      if (it.t === 'movie') { const id = await this.ident(it); if (id) body.movies.push({ ids: id.body.movie.ids, watched_at: at }); }
      else if (it.t === 'episode' && it.sk) {
        const show = cat.get(it.sk);
        if (!show) continue;
        if (!byShow.has(it.sk)) { const ids = await this._ids(show, 'show'); byShow.set(it.sk, ids ? { ids, seasons: {} } : null); }
        const s = byShow.get(it.sk);
        if (s) (s.seasons[it.s] || (s.seasons[it.s] = [])).push({ number: it.e, watched_at: at });
      }
      if (body.movies.length > 1000) break;
    }
    for (const s of byShow.values()) if (s) body.shows.push({ ids: s.ids, seasons: Object.entries(s.seasons).map(([n, eps]) => ({ number: Number(n), episodes: eps })) });
    const r = await this._req('/sync/history', { method: 'POST', pid, body });
    if (!r.ok) throw new HttpError(502, `Trakt said ${r.status}.`);
    const added = (r.json && r.json.added) || {};
    return { movies: added.movies || 0, episodes: added.episodes || 0 };
  }

  /** Every few hours, for every connected profile. */
  async syncAll() {
    for (const pid of Object.keys(this.store.data.profiles)) {
      const p = this.prof(pid);
      if (!p.access || Date.now() - (p.lastSync || 0) < 5 * 3600e3) continue;
      try { await this.sync(pid); } catch (e) { log(`Trakt sync: ${e.message}`); }
    }
  }
}

module.exports = { Trakt, LIKE, DISLIKE };
