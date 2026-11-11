'use strict';
/**
 * Schedules Direct as a TV guide (https://schedulesdirect.org — a paid listings service for the US, Canada and more).
 * The admin signs in with their own account (Admin → TV guides → Add Schedules Direct) and picks one of the lineups
 * already on it; from then on it's fetched like any other guide and its stations are matched to channels the same way
 * (by tvg-id — "I<station>.json.schedulesdirect.org", as other Schedules Direct tools write it — then by name; or by
 * hand in Admin → Channels).
 *
 * Their rules for programs that use the service, which this keeps to:
 *   - sign in rarely: the token lasts a day and is kept (in memory and in sd-cache.json), not asked for each time;
 *   - only download what changed: every programme's details are kept with their md5 and asked for again only when
 *     the schedule says they changed;
 *   - stop at an error instead of trying again and again.
 * Only the password's SHA-1 is stored (it's what the service takes), never the password.
 *
 * API: JSON, version 20141201 — POST /token, GET /lineups, GET /lineups/<id>, POST /schedules, POST /programs.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { log } = require('./util');

const BASE = 'https://json.schedulesdirect.org/20141201';
const MAX_DAYS = 14;
const STATIONS_PER_CALL = 500;   // (they allow 5000; smaller answers are kinder to a small server's memory)
const PROGRAMS_PER_CALL = 2000;

// What the service's error codes mean to the person who typed the account in.
const CODES = {
  3000: 'Schedules Direct is offline for maintenance. Try again in half an hour.',
  4001: 'This Schedules Direct account has expired. Renew it at schedulesdirect.org.',
  4003: 'Schedules Direct didn’t accept that user name and password.',
  4004: 'Schedules Direct has locked this account for 15 minutes after too many wrong passwords.',
  4005: 'This Schedules Direct account isn’t allowed to use the listings service. Ask their support.',
  4008: 'This Schedules Direct account isn’t active.',
  4009: 'Too many sign-ins to Schedules Direct today. It will work again tomorrow.',
  4010: 'This Schedules Direct account was used from too many places today. It will work again tomorrow.',
  2105: 'That lineup isn’t on the Schedules Direct account any more. Add it again at schedulesdirect.org.',
};

class SdError extends Error {
  constructor(code, message) { super(CODES[code] || `Schedules Direct: ${String(message || 'error').slice(0, 200)}${code ? ` (code ${code})` : ''}`); this.code = code; this.status = 502; }
}

const sha1 = (s) => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');
const stationCid = (id) => `I${id}.json.schedulesdirect.org`;
const pad = (n) => String(n).padStart(2, '0');
const day = (t) => new Date(t).toISOString().slice(0, 10);

class SchedulesDirect {
  /** { dataDir, ua, base?, fetch? } */
  constructor({ dataDir, ua, base, fetch: f } = {}) {
    this.base = String(base || process.env.SCHEDULES_DIRECT_URL || BASE).replace(/\/+$/, '');
    this.ua = ua || 'superstation-iptv';
    this.fetch = f || fetch;
    this.file = dataDir ? path.join(dataDir, 'sd-cache.json') : '';
    this.cache = null; // { tokens: { user: { token, exp } }, programs: { programID: [md5, title, episode title, description, episode label, genres, rating] } }
  }

  static hash(password) { return sha1(password); }

  _load() {
    if (this.cache) return this.cache;
    this.cache = { tokens: {}, programs: {} };
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (j && typeof j === 'object') this.cache = { tokens: j.tokens || {}, programs: j.programs || {} }; } catch {}
    return this.cache;
  }
  _save() {
    if (!this.file || !this.cache) return;
    try { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.cache), { mode: 0o600 }); fs.renameSync(tmp, this.file); } catch (e) { log(`Schedules Direct: couldn’t keep its cache (${e.message})`); }
  }

  async _raw(method, p, { token, body, timeout = 120e3 } = {}) {
    const headers = { 'User-Agent': this.ua, Accept: 'application/json' };
    if (token) headers.token = token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try { res = await this.fetch(this.base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) }); } catch (e) { throw new SdError(0, `couldn’t be reached (${(e.cause && e.cause.code) || e.name || e.message})`); }
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    if (j && !Array.isArray(j) && typeof j === 'object' && j.code) throw new SdError(Number(j.code), j.message || j.response);
    if (!res.ok || j === null) throw new SdError(0, `answered HTTP ${res.status}`);
    return j;
  }

  /** A token for this account: the kept one while it lasts, else a sign-in. */
  async _token(cred, fresh) {
    const c = this._load();
    const key = cred.user + ':' + cred.hash.slice(0, 8);
    const have = c.tokens[key];
    if (!fresh && have && have.token && have.exp - 600e3 > Date.now()) return have.token;
    const j = await this._raw('POST', '/token', { body: { username: cred.user, password: cred.hash }, timeout: 30e3 });
    if (!j.token) throw new SdError(0, 'gave no token');
    c.tokens = { [key]: { token: j.token, exp: j.tokenExpires ? Number(j.tokenExpires) * 1000 : Date.now() + 23 * 3600e3 } };
    this._save();
    return j.token;
  }

  /** A call with the account's token; a token the service says has expired is replaced once. */
  async _call(cred, method, p, body) {
    let token = await this._token(cred);
    try { return await this._raw(method, p, { token, body }); } catch (e) {
      if (e.code !== 4006) throw e;
      token = await this._token(cred, true);
      return this._raw(method, p, { token, body });
    }
  }

  /** The lineups on the account: [{ id, name, transport, location }]. */
  async lineups(cred) {
    const j = await this._call(cred, 'GET', '/lineups');
    return (j.lineups || []).filter((l) => l && l.lineup && !l.isDeleted).map((l) => ({ id: String(l.lineup), name: String(l.name || l.lineup), transport: String(l.transport || ''), location: String(l.location || '') }));
  }

  /**
   * A lineup's listings for the next `days` days, in the shape guides are kept in:
   * { channels: { cid: { names, icon } }, programmes: { cid: [{ s, e, t, st?, d?, ep?, c?, n?, r? }] }, programmeCount }.
   */
  async guide(cred, lineup, { days = 7 } = {}) {
    if (!/^[A-Za-z0-9-]{3,80}$/.test(String(lineup))) throw new SdError(2105);
    const lu = await this._call(cred, 'GET', '/lineups/' + lineup);
    const numbers = new Map();
    for (const m of lu.map || []) {
      const n = m.channel || (m.atscMajor ? `${m.atscMajor}.${m.atscMinor || 0}` : m.channelMajor ? `${m.channelMajor}.${m.channelMinor || 0}` : m.uhfVhf || '');
      if (m.stationID && n && !numbers.has(String(m.stationID))) numbers.set(String(m.stationID), String(n));
    }
    const channels = {};
    const ids = [];
    for (const s of lu.stations || []) {
      if (!s || !s.stationID) continue;
      const id = String(s.stationID);
      if (channels[stationCid(id)]) continue;
      const names = [s.name, s.callsign, s.affiliate && s.callsign ? `${s.affiliate} ${s.callsign}` : ''].map((x) => String(x || '').trim()).filter(Boolean);
      const logo = (Array.isArray(s.stationLogo) && s.stationLogo[0] && s.stationLogo[0].URL) || (s.logo && s.logo.URL) || '';
      channels[stationCid(id)] = { names: [...new Set(names)], icon: /^https:\/\//.test(logo) ? logo : '', num: numbers.get(id) || '' };
      ids.push(id);
    }
    if (!ids.length) throw new SdError(0, 'that lineup has no stations');

    // What's on: every station, a day at a time from today (they keep about two weeks ahead).
    const n = Math.max(1, Math.min(MAX_DAYS, Math.round(Number(days) || 7)));
    const dates = Array.from({ length: n }, (_, i) => day(Date.now() + i * 86400e3));
    const programmes = {};
    const want = new Map(); // programID → md5
    let total = 0;
    for (let i = 0; i < ids.length; i += STATIONS_PER_CALL) {
      const part = await this._call(cred, 'POST', '/schedules', ids.slice(i, i + STATIONS_PER_CALL).map((stationID) => ({ stationID, date: dates })));
      for (const st of Array.isArray(part) ? part : []) {
        if (!st || st.code || !Array.isArray(st.programs)) continue; // (a day they don't have yet, a station that's gone)
        const cid = stationCid(st.stationID);
        const list = programmes[cid] || (programmes[cid] = []);
        for (const a of st.programs) {
          const s = Date.parse(a.airDateTime), dur = Number(a.duration) || 0;
          if (!a.programID || Number.isNaN(s) || dur <= 0) continue;
          const p = { s, e: s + dur * 1000, id: String(a.programID) };
          if (a.new) p.n = 1;
          const r = Array.isArray(a.ratings) && a.ratings[0] && a.ratings[0].code;
          if (r) p.r = String(r);
          list.push(p);
          want.set(p.id, String(a.md5 || ''));
        }
      }
    }

    // Their details: the ones not kept from last time, or changed since.
    const c = this._load();
    const need = [...want.keys()].filter((id) => !c.programs[id] || c.programs[id][0] !== want.get(id));
    for (let i = 0; i < need.length; i += PROGRAMS_PER_CALL) {
      const part = await this._call(cred, 'POST', '/programs', need.slice(i, i + PROGRAMS_PER_CALL));
      for (const pr of Array.isArray(part) ? part : []) {
        if (!pr || !pr.programID || pr.code) continue; // (still being prepared on their side: next time)
        c.programs[pr.programID] = SchedulesDirect.programOf(pr, want.get(String(pr.programID)) || '');
      }
    }
    // (What's no longer in any schedule isn't kept.)
    const kept = {};
    for (const id of want.keys()) if (c.programs[id]) kept[id] = c.programs[id];
    c.programs = kept;
    this._save();

    for (const cid of Object.keys(programmes)) {
      const out = [];
      for (const a of programmes[cid].sort((x, y) => x.s - y.s)) {
        const d = kept[a.id];
        const p = { s: a.s, e: a.e, t: (d && d[1]) || 'To be announced' };
        if (d && d[2]) p.st = d[2];
        if (d && d[3]) p.d = d[3];
        if (d && d[4]) p.ep = d[4];
        if (d && d[5] && d[5].length) p.c = d[5];
        if (a.n) p.n = 1;
        if (a.r || (d && d[6])) p.r = a.r || d[6];
        // (The same airing listed twice — two days' answers overlap at midnight — once.)
        if (out.length && out[out.length - 1].s === p.s) continue;
        out.push(p);
      }
      programmes[cid] = out;
      total += out.length;
    }
    for (const cid of Object.keys(channels)) delete channels[cid].num;
    return { channels, programmes, programmeCount: total, fetched: need.length };
  }

  /** One /programs answer → what's kept of it: [md5, title, episode title, description, "S02E05", genres, rating]. */
  static programOf(pr, md5) {
    const title = ((pr.titles || [])[0] || {}).title120 || '';
    const descs = pr.descriptions || {};
    const pick = (list) => { const l = Array.isArray(list) ? list : []; const en = l.find((x) => /^en/i.test(x.descriptionLanguage || '')); return ((en || l[0] || {}).description) || ''; };
    const desc = pick(descs.description1000) || pick(descs.description100);
    let ep = '';
    for (const m of Array.isArray(pr.metadata) ? pr.metadata : []) {
      const g = m && (m.Gracenote || m.TVmaze || Object.values(m)[0]);
      if (g && (g.season || g.episode)) { ep = (g.season ? 'S' + pad(g.season) : '') + (g.episode ? 'E' + pad(g.episode) : ''); break; }
    }
    const rating = Array.isArray(pr.contentRating) && pr.contentRating[0] && pr.contentRating[0].code;
    return [md5 || String(pr.md5 || ''), String(title).slice(0, 200), String(pr.episodeTitle150 || '').slice(0, 200), String(desc).slice(0, 1200), ep, (Array.isArray(pr.genres) ? pr.genres : []).slice(0, 3).map(String), rating ? String(rating) : ''];
  }
}

module.exports = { SchedulesDirect, SdError, stationCid };
