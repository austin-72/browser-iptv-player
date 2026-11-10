'use strict';
const path = require('path');
const { JsonFile } = require('./store');

/**
 * Playback statistics for the admin: how streams reached viewers (straight from the provider, or through this
 * server) and how much data actually went through the server. Kept per day for 120 days in stats.json.
 *
 * Routes (what the player used):
 *   direct  the browser read the stream from the provider itself (hls.js / mpegts.js / Shaka)
 *   native  the browser's built-in player, straight from the provider
 *   helper  direct, thanks to the direct-streams browser helper
 *   split   video straight from the provider, only the playlist text through the server
 *   relay   the whole stream through the server
 *   convert converted by ffmpeg on the server
 *   local   the server's own files (media folders)
 */
const ROUTES = ['direct', 'native', 'helper', 'split', 'browser', 'relay', 'convert', 'local'];
const SERVER = new Set(['relay', 'convert', 'local']);
const REASONS = ['headers', 'https', 'blocked', 'direct-failed', 'setting', 'format', 'picture', 'chosen', 'library', 'unknown'];
const BYTES = ['relay', 'split', 'convert', 'download', 'local'];
const KEEP_DAYS = 120;
// Different providers / places / profiles kept per day: the place comes from what the player sends, so without a
// limit one device could fill stats.json with made-up names. The rest count under "Other".
const MAX_KEYS = 200;
const OPEN_MAX = 20000;

const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** "Home network" for addresses that only work at home; otherwise the name people typed. */
function placeOf(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!h) return 'Unknown';
  if (h === 'localhost' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(h) || h.includes(':') || /\.(local|lan|home\.arpa|localhost)$/.test(h) || !h.includes('.')) return 'Home network';
  if (h.endsWith('.ts.net') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return 'Tailscale';
  return h.slice(0, 80);
}

class Stats {
  constructor(dataDir) {
    this.store = new JsonFile(path.join(dataDir, 'stats.json'), { days: {}, since: Date.now() }, { delay: 5000 });
    this.open = new Map(); // play id → where its watch time goes
    this._prune();
  }

  _day(t) {
    const k = dayKey(t);
    const days = this.store.data.days;
    if (!days[k]) { days[k] = { plays: {}, secs: {}, bytes: {}, reasons: {}, fails: 0, hosts: {}, places: {}, profiles: {} }; this._prune(); }
    return days[k];
  }

  _prune() {
    const keys = Object.keys(this.store.data.days).sort();
    const cut = dayKey(Date.now() - KEEP_DAYS * 86400e3);
    for (const k of keys) if (k < cut) delete this.store.data.days[k];
  }

  _bump(obj, key, field, n) {
    // (A name that would land on every object — "__proto__", "constructor" — is kept as plain text.)
    key = String(key);
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') key = '(' + key + ')';
    if (!Object.prototype.hasOwnProperty.call(obj, key) && Object.keys(obj).length >= MAX_KEYS) key = 'Other';
    const o = (Object.prototype.hasOwnProperty.call(obj, key) && obj[key]) || (obj[key] = { plays: 0, direct: 0, secs: 0, dsecs: 0 });
    o[field] = (o[field] || 0) + n;
  }

  /** A stream started. Returns an id the player uses to report watch time. */
  /** startMs: how long from pressing Play to the picture (the player's own count), for "Time to start". */
  play({ route, reason, provider, host, profile, type, startMs, phases }) {
    if (!ROUTES.includes(route)) route = 'relay';
    const d = this._day();
    const direct = !SERVER.has(route);
    d.plays[route] = (d.plays[route] || 0) + 1;
    if (!direct) { const r = REASONS.includes(reason) ? reason : 'unknown'; d.reasons[r] = (d.reasons[r] || 0) + 1; }
    const place = placeOf(host);
    const prov = provider ? String(provider).slice(0, 80) : '';
    for (const [obj, key] of [[d.hosts, prov], [d.places, place], [d.profiles, profile]]) {
      if (!key) continue;
      this._bump(obj, key, 'plays', 1);
      if (direct) this._bump(obj, key, 'direct', 1);
    }
    const ms = Math.round(Number(startMs) || 0);
    if (ms > 0 && ms < 600000) {
      const st = d.start || (d.start = {});
      st.n = (st.n || 0) + 1; st.ms = (st.ms || 0) + ms;
      if (ms > 5000) st.s5 = (st.s5 || 0) + 1;
      if (ms > 15000) st.s15 = (st.s15 || 0) + 1;
      if (ms > 30000) st.s30 = (st.s30 || 0) + 1;
      // A converted start, step by step (the player's and the server's own counts): before the server was asked,
      // the server's look inside the file, getting the conversion going, and the browser showing the first picture.
      if (phases) {
        const f = (x) => { const n = Math.round(Number(x) || 0); return n > 0 && n < 600000 ? n : 0; };
        st.cn = (st.cn || 0) + 1;
        for (const k of ['pre', 'look', 'conv', 'net', 'play']) st['c_' + k] = (st['c_' + k] || 0) + f(phases[k]);
      }
      if (prov) { this._bump(d.hosts, prov, 'starts', 1); this._bump(d.hosts, prov, 'startMs', ms); if (ms > 15000) this._bump(d.hosts, prov, 'slow', 1); }
    }
    const id = Math.random().toString(36).slice(2, 12);
    this.open.set(id, { route, direct, prov, place, profile, type, seen: Date.now() });
    if (this.open.size > 5000) for (const [k, v] of this.open) if (Date.now() - v.seen > 6 * 3600e3) this.open.delete(k);
    // (Still too many: the oldest started go first, so the map can't grow without end.)
    if (this.open.size > OPEN_MAX) for (const k of this.open.keys()) { this.open.delete(k); if (this.open.size <= OPEN_MAX) break; }
    this.store.save();
    return id;
  }

  /** Seconds watched since the last report for a play. */
  watch(id, sec, profile) {
    const p = this.open.get(id);
    if (!p || p.profile !== profile) return;
    sec = Math.max(0, Math.min(Number(sec) || 0, 600));
    if (!sec) return;
    p.seen = Date.now();
    const d = this._day();
    d.secs[p.route] = (d.secs[p.route] || 0) + sec;
    for (const [obj, key] of [[d.hosts, p.prov], [d.places, p.place], [d.profiles, p.profile]]) {
      if (!key) continue;
      this._bump(obj, key, 'secs', sec);
      if (p.direct) this._bump(obj, key, 'dsecs', sec);
    }
    this.store.save();
  }

  fail() { this._day().fails++; this.store.save(); }

  /** Data the server sent to viewers, by kind. Called often, saved lazily. */
  bytes(kind, n) {
    if (!BYTES.includes(kind) || !(n > 0)) return;
    const d = this._day();
    d.bytes[kind] = (d.bytes[kind] || 0) + n;
    this.store.save();
  }

  /** Totals and a per-day series for the last `days` days. */
  summary(days, names = {}) {
    days = Math.max(1, Math.min(KEEP_DAYS, days | 0 || 30));
    const series = [];
    const tot = { plays: {}, secs: {}, bytes: {}, reasons: {}, fails: 0, hosts: {}, places: {}, profiles: {}, start: {} };
    const add = (into, from) => { for (const [k, v] of Object.entries(from || {})) into[k] = (into[k] || 0) + v; };
    const addObj = (into, from) => {
      for (const [k, v] of Object.entries(from || {})) {
        const o = into[k] || (into[k] = { plays: 0, direct: 0, secs: 0, dsecs: 0 });
        for (const f of ['plays', 'direct', 'secs', 'dsecs', 'starts', 'startMs', 'slow']) o[f] = (o[f] || 0) + (v[f] || 0);
      }
    };
    for (let i = days - 1; i >= 0; i--) {
      const t = Date.now() - i * 86400e3;
      const k = dayKey(t);
      const d = this.store.data.days[k];
      series.push({ day: k, secs: d ? { ...d.secs } : {}, plays: d ? { ...d.plays } : {}, bytes: d ? Object.values(d.bytes).reduce((a, b) => a + b, 0) : 0 });
      if (!d) continue;
      add(tot.plays, d.plays); add(tot.secs, d.secs); add(tot.bytes, d.bytes); add(tot.reasons, d.reasons); add(tot.start, d.start);
      tot.fails += d.fails || 0;
      addObj(tot.hosts, d.hosts); addObj(tot.places, d.places); addObj(tot.profiles, d.profiles);
    }
    const list = (o, label) => Object.entries(o).map(([k, v]) => ({ key: k, name: label ? label(k) : k, ...v })).sort((a, b) => b.secs - a.secs || b.plays - a.plays);
    return {
      days, since: this.store.data.since, series,
      plays: tot.plays, secs: tot.secs, bytes: tot.bytes, reasons: tot.reasons, fails: tot.fails, start: tot.start,
      hosts: list(tot.hosts).slice(0, 30), places: list(tot.places), profiles: list(tot.profiles, (k) => names[k] || 'Removed profile'),
    };
  }

  reset() {
    this.store.data.days = {};
    this.store.data.since = Date.now();
    this.open.clear();
    this.store.save();
  }
}

module.exports = { Stats, ROUTES, placeOf, dayKey };
