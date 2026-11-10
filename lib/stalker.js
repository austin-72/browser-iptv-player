'use strict';
/**
 * Stalker / Ministra middleware portals ("MAC address" IPTV, as used by MAG set-top boxes).
 *
 * The portal is a JSON API (load.php / portal.php) that a box talks to with its MAC address in a cookie and a
 * token from a handshake. Channels and films carry a `cmd` rather than an address: the real, short-lived stream
 * address is asked for (create_link) just before playback. So the catalogue gets an address on this server —
 * /api/proxy/stalker/<list>/<kind>/<id> — which asks the portal and redirects the player to the real stream.
 */
const crypto = require('crypto');
const { fetchAny } = require('./net');
const { HttpError, log } = require('./util');

const UA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const MAX_VOD_PAGES = 3000; // ~40,000 titles: enough for real portals without asking for hours
const PAGE_CONCURRENCY = 6;
const REFUSED_MS = 20000; // after a failed sign-in again, requests fail at once for this long rather than each signing in

/** "00:1a:79:aa:bb:cc", "001A79AABBCC" or "00-1A-…" → "00:1A:79:AA:BB:CC". */
function normMac(mac) {
  const hex = String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (hex.length !== 12) throw new HttpError(400, 'Enter the MAC address the portal knows (like 00:1A:79:12:34:56).');
  return hex.match(/../g).join(':');
}

/** The portal address the way people paste it (…/c/, …/stalker_portal/c/, a full load.php) → API addresses to try. */
function apiCandidates(portal) {
  let s = String(portal || '').trim();
  if (!s) throw new HttpError(400, 'Enter the portal address.');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch { throw new HttpError(400, 'That portal address isn’t valid.'); }
  const out = [];
  const add = (x) => { if (!out.includes(x)) out.push(x); };
  if (/\.php$/i.test(u.pathname)) add(u.origin + u.pathname);
  const p = u.pathname.replace(/\/+$/, '');
  const dir = p.replace(/\/c$/i, '').replace(/\/[^/]*\.php$/i, '');
  if (/stalker_portal/i.test(p)) add(u.origin + p.replace(/(\/stalker_portal).*$/i, '$1') + '/server/load.php');
  add(u.origin + dir + '/portal.php');
  add(u.origin + dir + '/server/load.php');
  add(u.origin + '/portal.php');
  add(u.origin + '/stalker_portal/server/load.php');
  return { list: out, referer: u.origin + (p.endsWith('/c') ? p + '/' : p || '/') };
}

/** A device id derived from the MAC when the admin doesn't give one (stable, like a real box's). */
const derivedId = (mac, salt) => crypto.createHash('sha256').update(salt + mac).digest('hex').toUpperCase();

/** A command → the address in it ("ffmpeg http://…" → "http://…"). */
function cmdUrl(cmd) {
  const m = /(https?:\/\/\S+|rtmp:\/\/\S+|udp:\/\/\S+|rtp:\/\/\S+)/i.exec(String(cmd || ''));
  return m ? m[1] : '';
}
const jsOf = (j) => (j && typeof j === 'object' && 'js' in j ? j.js : j);
const asArr = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []);

class Stalker {
  constructor() {
    this.sessions = new Map(); // list id → { api, token, at }
    this.cmds = new Map(); // list id → Map('live:<id>' | 'vod:<id>' → cmd)
    this.linkHosts = new Set(); // hosts that create_link handed out (relaying them is allowed)
    this.logins = new Map(); // list id → sign-in in progress (shared by every request that needs one)
    this.refused = new Map(); // list id → { at, err, who }: the last sign-in again failed (don't retry it for every request)
  }

  /** Validates what the admin typed and returns the list fields to keep. */
  spec(input) {
    const mac = normMac(input.mac);
    const { list } = apiCandidates(input.portal || input.server || input.url);
    const portal = String(input.portal || input.server || input.url).trim();
    return {
      portal: /^https?:/i.test(portal) ? portal : 'http://' + portal, mac, apiHint: list[0],
      serial: String(input.serial || '').trim().slice(0, 64), deviceId: String(input.deviceId || '').trim().slice(0, 128),
      deviceId2: String(input.deviceId2 || '').trim().slice(0, 128), signature: String(input.signature || '').trim().slice(0, 128),
      vod: input.vod !== false, portalGuide: input.portalGuide !== false,
    };
  }

  _headers(l, token, referer) {
    const h = {
      'User-Agent': l.ua || UA, 'X-User-Agent': 'Model: MAG250; Link: WiFi', Accept: '*/*',
      Cookie: `mac=${encodeURIComponent(l.mac)}; stb_lang=en; timezone=${encodeURIComponent(l.tz || 'UTC')}`,
    };
    if (referer) h.Referer = referer;
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  async _get(url, headers, timeout = 30000) {
    let res;
    try { res = await fetchAny(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeout) }); } catch (e) {
      throw new Error(`The portal didn’t answer (${e.name === 'TimeoutError' ? 'timed out' : (e.cause && e.cause.message) || e.message})`);
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403 || /authorization failed/i.test(text.slice(0, 200))) { const e = new Error('The portal refused this MAC address (or the token expired).'); e.auth = true; throw e; }
    if (!res.ok) throw new Error(`The portal answered HTTP ${res.status}`);
    try { return JSON.parse(text); } catch { const e = new Error('The portal didn’t answer like a Stalker/Ministra portal.'); e.notJson = true; throw e; }
  }

  /** Handshake + get_profile; remembers the API address that worked and the token. */
  async login(l) {
    const { list, referer } = apiCandidates(l.portal);
    const tries = l.api ? [l.api, ...list.filter((x) => x !== l.api)] : list;
    let lastErr = null;
    for (const api of tries) {
      try {
        const hs = jsOf(await this._get(`${api}?type=stb&action=handshake&token=&prehash=0&JsHttpRequest=1-xml`, this._headers(l, '', referer), 15000));
        const token = hs && hs.token;
        if (!token) throw new Error(hs && hs.msg ? `The portal says: ${hs.msg}` : 'The portal didn’t give a token.');
        const sn = l.serial || derivedId(l.mac, 'sn').slice(0, 13);
        const id1 = l.deviceId || derivedId(l.mac, 'id1');
        const id2 = l.deviceId2 || l.deviceId || derivedId(l.mac, 'id2');
        const sig = l.signature || derivedId(l.mac + sn + id1, 'sig');
        const q = new URLSearchParams({ type: 'stb', action: 'get_profile', hd: '1', ver: 'ImageDescription: 0.2.18-r23-250; ImageDate: Wed Aug 29 10:49:53 EEST 2018; PORTAL version: 5.6.2; API Version: JS API version: 343; STB API version: 146; Player Engine version: 0x58c', num_banks: '2', sn, stb_type: 'MAG250', client_type: 'STB', image_version: '218', video_out: 'hdmi', device_id: id1, device_id2: id2, signature: sig, auth_second_step: '1', hw_version: '1.7-BD-00', not_valid_token: '0', JsHttpRequest: '1-xml' });
        const prof = jsOf(await this._get(`${api}?${q}`, this._headers(l, token, referer), 15000));
        if (prof && typeof prof === 'object' && (prof.status === 1 || prof.status === '1') && prof.msg) throw new Error(`The portal says: ${prof.msg}`);
        if (prof && prof.blocked && String(prof.blocked) === '1') throw new Error('The portal says this device is blocked.');
        const sess = { api, token, referer, at: Date.now() };
        this.sessions.set(l.id, sess);
        this.refused.delete(l.id);
        l.api = api;
        return sess;
      } catch (e) {
        lastErr = e;
        if (!e.notJson && !/didn’t answer \(|HTTP 404/.test(e.message)) break; // the right address, wrong account: stop there
      }
    }
    throw lastErr || new Error('Couldn’t reach the portal.');
  }

  /**
   * Signs in again when `stale` (the session a request used) stopped working. Requests that find out at the same
   * time share one handshake (many portals cancel the previous token with each one, so separate handshakes would
   * keep cancelling each other), and after a failed sign-in the next ones wait REFUSED_MS instead of hammering the portal.
   */
  _relogin(l, stale) {
    const cur = this.sessions.get(l.id);
    if (cur && cur !== stale && Date.now() - cur.at < 6 * 3600e3) return Promise.resolve(cur); // someone already signed in again
    const pending = this.logins.get(l.id);
    if (pending) return pending;
    const no = this.refused.get(l.id);
    if (no && no.who === l.mac + l.portal && Date.now() - no.at < REFUSED_MS) return Promise.reject(no.err);
    const p = this.login(l).catch((err) => { this.refused.set(l.id, { at: Date.now(), err, who: l.mac + l.portal }); throw err; }).finally(() => this.logins.delete(l.id));
    this.logins.set(l.id, p);
    return p;
  }

  /** One API call (signing in first, and once more if the token has expired). */
  async call(l, params, timeout = 30000) {
    let sess = this.sessions.get(l.id);
    if (!sess || Date.now() - sess.at > 6 * 3600e3) sess = await this._relogin(l, sess);
    const q = new URLSearchParams({ ...params, JsHttpRequest: '1-xml' });
    try {
      return jsOf(await this._get(`${sess.api}?${q}`, this._headers(l, sess.token, sess.referer), timeout));
    } catch (e) {
      if (!e.auth) throw e;
      sess = await this._relogin(l, sess);
      try {
        return jsOf(await this._get(`${sess.api}?${q}`, this._headers(l, sess.token, sess.referer), timeout));
      } catch (e2) {
        // Refused even with a fresh token: don't sign in again for every request that follows.
        if (e2.auth && this.sessions.get(l.id) === sess) this.refused.set(l.id, { at: Date.now(), err: e2, who: l.mac + l.portal });
        throw e2;
      }
    }
  }

  /** Account details (expiry) as the Xtream lists keep them. */
  async account(l) {
    const info = await this.call(l, { type: 'account_info', action: 'get_main_info' }).catch(() => null);
    let expires = null;
    for (const k of ['end_date', 'expire_billing_date', 'phone', 'expires', 'tariff_expired_date']) {
      const v = info && info[k];
      if (!v) continue;
      const n = /^\d{9,11}$/.test(String(v)) ? Number(v) * 1000 : Date.parse(String(v).replace(/,\s*(\d{1,2}:\d\d\s*[ap]m)?$/i, ''));
      if (n > 0) { expires = n; break; }
    }
    return { status: info ? 'Active' : '', expires, maxConnections: '', activeConnections: '', trial: false, formats: [], checkedAt: Date.now(), mac: l.mac };
  }

  async _pages(l, type, category) {
    const out = [];
    const first = await this.call(l, { type, action: 'get_ordered_list', category, genre: '*', sortby: 'added', p: '1' }).catch(() => null);
    if (!first || !first.data) return out;
    out.push(...asArr(first.data));
    const per = Number(first.max_page_items) || asArr(first.data).length || 14;
    const pages = Math.min(Math.ceil((Number(first.total_items) || 0) / per), this._pageBudget);
    this._pageBudget -= Math.max(0, pages - 1);
    let next = 2;
    const worker = async () => {
      while (next <= pages) {
        const p = next++;
        const r = await this.call(l, { type, action: 'get_ordered_list', category, genre: '*', sortby: 'added', p: String(p) }).catch(() => null);
        if (r && r.data) out.push(...asArr(r.data));
      }
    };
    await Promise.all(Array.from({ length: PAGE_CONCURRENCY }, worker));
    return out;
  }

  /** Everything the list needs, saved to disk as the list's copy. */
  async load(l) {
    await this.login(l);
    const account = await this.account(l);
    const genres = asArr(await this.call(l, { type: 'itv', action: 'get_genres' }).catch(() => []));
    const all = await this.call(l, { type: 'itv', action: 'get_all_channels' }, 120000);
    const channels = asArr(all && all.data ? all.data : all).map((c) => ({
      id: String(c.id), name: c.name, number: c.number, cmd: c.cmd, logo: c.logo || '', genre: String(c.tv_genre_id || ''), xmltv: c.xmltv_id || '',
      archive: String(c.tv_archive) === '1' ? Number(c.tv_archive_duration) || 0 : 0,
    }));
    const data = { account, genres: genres.map((g) => ({ id: String(g.id), title: g.title || g.name || '' })), channels, vodCats: [], vod: [], seriesCats: [], series: [], fetchedAt: Date.now() };
    if (l.vod !== false) {
      this._pageBudget = MAX_VOD_PAGES;
      for (const [type, catKey, key] of [['vod', 'vodCats', 'vod'], ['series', 'seriesCats', 'series']]) {
        const cats = asArr(await this.call(l, { type, action: 'get_categories' }).catch(() => [])).filter((c) => c && c.id !== '*' && c.id !== '');
        data[catKey] = cats.map((c) => ({ id: String(c.id), title: c.title || c.name || '' }));
        for (const c of cats) {
          if (this._pageBudget <= 0) break;
          for (const v of await this._pages(l, type, c.id)) {
            data[key].push({
              id: String(v.id), name: v.name || v.o_name || '', cat: String(c.id), cmd: v.cmd || '', series: type === 'series' || String(v.is_series) === '1',
              plot: v.description || '', year: parseInt(v.year, 10) || 0, cast: v.actors || '', director: v.director || '', genre: v.genres_str || '',
              rating: parseFloat(v.rating_imdb) || parseFloat(v.rating_kinopoisk) || 0, logo: v.screenshot_uri || v.cover_big || '', minutes: parseInt(v.time, 10) || 0,
              added: Date.parse(v.added || '') || 0,
            });
          }
        }
      }
      // (Some portals list series among the films: keep each title once.)
      const seen = new Set(data.series.map((s) => s.id));
      data.series.push(...data.vod.filter((v) => v.series && !seen.has(v.id)));
      data.vod = data.vod.filter((v) => !v.series);
    }
    l.account = account;
    return data;
  }

  _abs(l, u) {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    try { const o = new URL(l.portal); return u.startsWith('/') ? o.origin + u : ''; } catch { return ''; }
  }

  /** The saved copy → catalogue entries (and the commands to ask for at play time). */
  items(l, data) {
    const cmds = new Map();
    const genre = new Map((data.genres || []).map((g) => [g.id, g.title]));
    const vc = new Map((data.vodCats || []).map((g) => [g.id, g.title]));
    const sc = new Map((data.seriesCats || []).map((g) => [g.id, g.title]));
    const base = `/api/proxy/stalker/${l.id}`;
    const items = [];
    for (const c of data.channels || []) {
      cmds.set('live:' + c.id, c.cmd);
      items.push({
        name: c.name || `Channel ${c.id}`, type: 'live', url: `${base}/live/${encodeURIComponent(c.id)}`, logo: this._abs(l, c.logo),
        group: genre.get(c.genre) || 'Live', category: genre.get(c.genre) || '', chno: c.number ? String(c.number) : '',
        tvgId: c.xmltv || `stalker.${l.id}.${c.id}`, headers: {},
      });
    }
    for (const v of data.vod || []) {
      cmds.set('vod:' + v.id, v.cmd);
      items.push({
        name: v.name || `Film ${v.id}`, type: 'movie', url: `${base}/vod/${encodeURIComponent(v.id)}`, logo: this._abs(l, v.logo),
        group: vc.get(v.cat) || 'Movies', category: vc.get(v.cat) || '', year: v.year, plot: v.plot, cast: v.cast, director: v.director, genre: v.genre,
        rating: v.rating, duration: v.minutes * 60, added: v.added, xt: { kind: 'vod', id: v.id }, headers: {},
      });
    }
    for (const v of data.series || []) {
      items.push({
        name: v.name || `Series ${v.id}`, type: 'show', url: '', logo: this._abs(l, v.logo), group: sc.get(v.cat) || vc.get(v.cat) || 'Series',
        category: sc.get(v.cat) || '', year: v.year, plot: v.plot, cast: v.cast, director: v.director, genre: v.genre, rating: v.rating, added: v.added,
        xt: { kind: 'series', id: v.id }, headers: {},
      });
    }
    this.cmds.set(l.id, cmds);
    const epgUrls = l.portalGuide !== false && (data.channels || []).length ? [`stalker:${l.id}`] : [];
    return { items, epgUrls, format: 'Stalker portal', name: '' };
  }

  /** A series' seasons and episodes (cached by the caller). */
  async seriesInfo(l, id) {
    const r = await this.call(l, { type: 'series', action: 'get_ordered_list', movie_id: id, season_id: '0', episode_id: '0', p: '1' }).catch(() => null)
      || await this.call(l, { type: 'vod', action: 'get_ordered_list', movie_id: id, season_id: '0', episode_id: '0', p: '1' });
    const seasons = asArr(r && r.data ? r.data : []).map((s, i) => ({
      id: String(s.id), season: parseInt((String(s.name || '').match(/\d+/) || [''])[0], 10) || parseInt(String(s.id).split(':')[1], 10) || i + 1,
      cmd: s.cmd || '', eps: asArr(s.series).map((n) => parseInt(n, 10)).filter((n) => n > 0), plot: s.description || '', logo: s.screenshot_uri || '',
    }));
    return { seasons };
  }

  /** In the shape lists.xtSeries returns. */
  episodesOf(l, id, data) {
    const eps = [];
    for (const s of data.seasons || []) {
      for (const n of s.eps) {
        eps.push({ id: `${s.id}~${n}`, season: s.season, episode: n, title: '', url: `/api/proxy/stalker/${l.id}/ep/${encodeURIComponent(`${id}|${s.id}~${n}`)}`, duration: 0, cx: null, plot: s.plot || '', img: this._abs(l, s.logo), rating: 0, aired: '' });
      }
    }
    return { info: {}, episodes: eps };
  }

  /**
   * The real stream address for a channel, film or episode, asked for just before playback.
   * kind: live | vod | ep (id "<series>|<season id>~<episode>", the season's cmd looked up from the series info).
   */
  async createLink(l, kind, id, seasonCmd) {
    let cmd, type, extra = {};
    if (kind === 'live') { cmd = (this.cmds.get(l.id) || new Map()).get('live:' + id); type = 'itv'; }
    else if (kind === 'vod') { cmd = (this.cmds.get(l.id) || new Map()).get('vod:' + id); type = 'vod'; }
    else if (kind === 'ep') { cmd = seasonCmd; type = 'vod'; extra = { series: String(id.split('~')[1] || '') }; }
    if (!cmd) throw new HttpError(404, 'The portal doesn’t list that any more. Refresh the list.');
    let url = '';
    try {
      const r = await this.call(l, { type, action: 'create_link', cmd, series: extra.series || '', forced_storage: 'undefined', disable_ad: '0', download: '0' }, 20000);
      url = cmdUrl(r && r.cmd);
      if (r && r.error && !url) throw new Error(`The portal says: ${r.error}`);
    } catch (e) {
      // A command that already is a real address (and not the portal's own "localhost" placeholder) still works.
      const direct = cmdUrl(cmd);
      if (direct && !/\/\/(localhost|127\.)/.test(direct) && kind !== 'ep') url = direct;
      else throw new HttpError(502, e.message);
    }
    if (!url) throw new HttpError(502, 'The portal didn’t give a stream address.');
    try { this.linkHosts.add(new URL(url).host); } catch {}
    if (this.linkHosts.size > 500) this.linkHosts = new Set([...this.linkHosts].slice(-200));
    return url;
  }

  /** The portal's own TV guide → { channels, programmes } like the XMLTV reader gives. */
  async guide(l, data, { hours = 48 } = {}) {
    // (A failure is a failure — thrown, so the guide kept from last time stays: an empty one used to be saved over it.)
    const r = await this.call(l, { type: 'itv', action: 'get_epg_info', period: String(hours) }, 180000);
    const byCh = (r && (r.data || r)) || {};
    const channels = {};
    const programmes = {};
    let count = 0;
    const known = new Map((data.channels || []).map((c) => [c.id, c]));
    for (const [chId, list] of Object.entries(byCh)) {
      const c = known.get(String(chId));
      if (!c) continue;
      const cid = c.xmltv || `stalker.${l.id}.${c.id}`;
      channels[cid] = { names: [c.name], icon: this._abs(l, c.logo) };
      const out = [];
      for (const p of asArr(list)) {
        const s = (Number(p.start_timestamp) || Date.parse(p.time) / 1000 || 0) * 1000;
        const e = (Number(p.stop_timestamp) || Date.parse(p.time_to) / 1000 || 0) * 1000;
        if (!s || !e || e <= s) continue;
        const x = { s, e, t: String(p.name || '') };
        if (p.descr) x.d = String(p.descr);
        if (p.category) x.c = [String(p.category)];
        out.push(x);
      }
      out.sort((a, b) => a.s - b.s);
      if (out.length) { programmes[cid] = out; count += out.length; }
    }
    return { channels, programmes, programmeCount: count };
  }
}

module.exports = { Stalker, normMac, apiCandidates, cmdUrl };
