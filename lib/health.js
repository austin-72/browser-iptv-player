'use strict';
/**
 * Channel health: which channels (and which copies of them, on which provider) play, and which are dead.
 *
 * Passive: every play attempt devices already report (/api/stats/play) is counted against the copy it used — a
 * success with its route, or a failure with the player's message and HTTP status. Nothing extra is opened.
 *
 * Active (optional, off by default): a slow background checker that asks for a live channel's stream briefly (an HLS
 * playlist and its newest segment's headers, or the first few KB of an MPEG-TS stream) — one channel at a time, a few
 * seconds apart, only in a chosen night-time window (or when the admin presses "Check now"), and only when that
 * provider is quiet: nobody watching from it or just finished, no connection test, no other app or conversion using
 * it, and — when the provider allows a single stream (or its limit isn't known) — nobody with the app open at all,
 * since anyone could be about to press Play. A check stops the moment someone starts watching.
 *
 * Kept small in health.json: per copy a handful of rolling counters (failures in a row, last error, last success,
 * the last 7 days' totals), per provider the last 7 days and the last few outcomes. Never a log of every play.
 */
const path = require('path');
const crypto = require('crypto');
const { JsonFile } = require('./store');
const { parseHls } = require('./conntest');

const DAY = 86400e3;
const KEEP_DAYS = 7;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Local day number (days since 1970 in the server's time zone). */
const dayNo = (t = Date.now()) => Math.floor((t - new Date(t).getTimezoneOffset() * 60e3) / DAY);
const uhash = (u) => crypto.createHash('sha1').update(String(u || '')).digest('base64url').slice(0, 8);
const isChan = (it) => it && (it.t === 'live' || it.t === 'radio');
const CHECKABLE = new Set(['url', 'file', 'xtream']);
const DEFAULT_OPTS = { on: false, from: 2, to: 6, gap: 10, skipAfter: 0, marks: true };
const GENTLE_GAP = 45; // seconds between checks on a provider that counts each one as a login
const GENTLE_CAP = 120; // …and at most this many a night

/** What a failure says about the channel: 'dead' (the channel's fault), 'busy' (the account's limit), 'device' (this browser). */
function classify(msg, code) {
  const m = String(msg || '');
  if ([429, 456, 458, 509].includes(code) || /too many|connection limit|limiting connections|in use on another device|max(imum)? connections/i.test(m)) return 'busy';
  if (/decod|codec|format|DRM|copy-protect|licen[cs]e|this browser|in a browser|conversion session|https page|was stopped/i.test(m)) return 'device';
  return 'dead';
}
/** The HTTP status in a player's message ("…answered HTTP 404.", "…doesn’t exist (404)"), or 0. */
function codeOf(msg, detail) {
  const d = detail && Number(detail.http);
  if (d >= 100 && d < 600) return d;
  const m = /(?:HTTP |\()([1-5]\d\d)\b/.exec(String(msg || ''));
  return m ? Number(m[1]) : 0;
}
function whyCode(code) {
  if (code === 404) return 'Not found (HTTP 404) — the channel may have been removed';
  if (code === 401 || code === 403) return `Refused (HTTP ${code})`;
  if (code >= 500) return `The provider’s server had a problem (HTTP ${code})`;
  return `HTTP ${code}`;
}
function whyErr(e) {
  const m = String((e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || e);
  if (e && (e.name === 'AbortError' || e.name === 'TimeoutError') || /timeout|aborted/i.test(m)) return 'Nothing arrived in time';
  if (/ECONNRESET|socket hang up|terminated|other side closed/i.test(m)) return 'The provider closed the connection';
  if (/ECONNREFUSED/.test(m)) return 'The provider refused to connect';
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'The provider’s address couldn’t be found';
  return m.slice(0, 120);
}

/**
 * Asks for a stream briefly. HLS: the playlist (the smallest variant's, if it's a master playlist) and the headers of
 * its newest segment. Anything else: the first 4 KB. Resolves to { ok, code, err, kind, ms } or { stopped: true }.
 */
async function probe(url, headers, { fetch, signal, timeout = 15000 } = {}) {
  const ac = new AbortController();
  const stop = () => ac.abort();
  if (signal) { if (signal.aborted) return { stopped: true }; signal.addEventListener('abort', stop, { once: true }); }
  const timer = setTimeout(() => ac.abort(), timeout);
  const t0 = Date.now();
  const open = [];
  const get = async (u) => { const r = await fetch(u, { headers, signal: ac.signal, redirect: 'follow' }); open.push(r); return r; };
  const done = (o) => ({ ms: Date.now() - t0, ...o });
  try {
    const res = await get(url);
    if (!res.ok) return done({ ok: false, code: res.status, err: whyCode(res.status) });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const reader = res.body.getReader();
    const parts = [];
    let n = 0, ended = false, list = null;
    while (n < 4096) {
      const r = await reader.read();
      if (r.done) { ended = true; break; }
      parts.push(Buffer.from(r.value)); n += r.value.length;
      if (list === null) list = ct.includes('mpegurl') || Buffer.concat(parts).slice(0, 64).toString('latin1').replace(/^﻿|^ï»¿/, '').trimStart().startsWith('#EXTM3U');
      if (list) { // a playlist: read it all (they're small)
        while (n < 512 * 1024) { const r2 = await reader.read(); if (r2.done) { ended = true; break; } parts.push(Buffer.from(r2.value)); n += r2.value.length; }
        break;
      }
    }
    try { reader.cancel().catch(() => {}); } catch {}
    const body = Buffer.concat(parts);
    if (list) {
      let pl = parseHls(body.toString('utf8'), res.url || url);
      if (pl.variants.length) {
        const v = pl.variants.slice().sort((a, b) => a.bw - b.bw)[0];
        const r = await get(v.url);
        if (!r.ok) return done({ ok: false, code: r.status, err: whyCode(r.status), kind: 'hls' });
        pl = parseHls(await r.text(), r.url || v.url);
      }
      if (!pl.segs.length) return done({ ok: false, err: 'The playlist has no video in it', kind: 'hls' });
      const seg = pl.end ? pl.segs[0] : pl.segs[pl.segs.length - 1];
      const r = await get(seg);
      if (!r.ok) return done({ ok: false, code: r.status, err: 'Video segment: ' + whyCode(r.status), kind: 'hls' });
      return done({ ok: true, kind: 'hls' });
    }
    if (!body.length) return done({ ok: false, err: 'The provider sent nothing and closed the connection' });
    if (/^(text\/(html|plain)|application\/json)/.test(ct) && ended) {
      return done({ ok: false, err: 'The provider answered with a message instead of video: “' + body.toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) + '”' });
    }
    if (ended && n < 1024) return done({ ok: false, err: 'The provider sent almost nothing' });
    return done({ ok: true, kind: 'stream' });
  } catch (e) {
    if (signal && signal.aborted) return { stopped: true };
    return done({ ok: false, err: whyErr(e) });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', stop);
    for (const r of open) { try { if (r.body && !r.bodyUsed) r.body.cancel().catch(() => {}); } catch {} }
  }
}

class Health {
  /** onDown(v): the set of channels that "may be down" changed (devices fetch it again). */
  constructor(dataDir, { catalog, onDown } = {}) {
    this.store = new JsonFile(path.join(dataDir, 'health.json'), { opts: { ...DEFAULT_OPTS }, gentle: {}, prefer: {}, copies: {}, prov: {}, passes: {} });
    this.catalog = catalog || (() => null);
    this.onDown = onDown || (() => {});
    this.downV = 1;
    this._down = null;
    this._downSig = '';
    this._saveT = null;
    this._prune();
    setInterval(() => this._prune(), 3600e3).unref();
  }

  get d() { return this.store.data; }
  get opts() { return this.d.opts; }
  /** Saves at most every 20 s (records change with every play). */
  _touch() {
    this._down = null;
    if (!this._saveT) { this._saveT = setTimeout(() => { this._saveT = null; this.store.save(); this._downCheck(); }, 20000); this._saveT.unref(); }
    if (!this._dc) { this._dc = setTimeout(() => { this._dc = null; this._downCheck(); }, 3000); this._dc.unref(); }
  }
  flush() { clearTimeout(this._saveT); this._saveT = null; this.store.flush(); }

  setOpts(p) {
    const o = this.d.opts;
    if ('on' in p) o.on = !!p.on;
    if ('marks' in p) o.marks = !!p.marks;
    for (const f of ['from', 'to']) if (f in p) o[f] = Math.max(0, Math.min(23, Math.round(Number(p[f]) || 0)));
    if ('gap' in p) o.gap = Math.max(2, Math.min(300, Math.round(Number(p.gap) || 10)));
    if ('skipAfter' in p) o.skipAfter = Math.max(0, Math.min(20, Math.round(Number(p.skipAfter) || 0)));
    if (p.gentle && typeof p.gentle === 'object') for (const [id, on] of Object.entries(p.gentle)) { if (on) this.d.gentle[id] = true; else delete this.d.gentle[id]; }
    this.store.save();
    this._down = null;
    this._downCheck();
    return o;
  }

  // ------------------------------------------------------------ copies
  /** Every copy of a channel: [{ alt, l, u, id }] (id = channel key | list | which copy from that list). */
  static copies(it) {
    const seen = new Map();
    const out = [];
    const add = (alt, l, u) => { const n = seen.get(l) || 0; seen.set(l, n + 1); out.push({ alt, l: l || '', u: u || '', id: `${it.k}|${l || ''}|${n}` }); };
    add(-1, it.src, it.u);
    (it.alts || []).forEach((a, i) => add(i, a.l, a.u));
    return out;
  }
  copyOf(it, alt) { return Health.copies(it).find((c) => c.alt === alt) || null; }

  /**
   * One outcome for one copy. o: { ok, by: 'p' (a device played it) | 'c' (the checker), route, msg, code, started }.
   * A copy whose address changed starts again from nothing.
   */
  record(it, alt, o) {
    if (!isChan(it)) return;
    const c = this.copyOf(it, alt);
    if (!c) return;
    const now = Date.now();
    const uh = uhash(c.u);
    let r = this.d.copies[c.id];
    if (!r || r.uh !== uh) r = this.d.copies[c.id] = { k: it.k, l: c.l, uh, n: 0, w: [] };
    const day = dayNo(now);
    let w = r.w[r.w.length - 1];
    if (!w || w[0] !== day) { w = [day, 0, 0]; r.w.push(w); while (r.w.length && r.w[0][0] <= day - KEEP_DAYS) r.w.shift(); }
    const p = this._prov(c.l, day);
    if (o.by === 'c') r.ck = now;
    if (o.ok) {
      r.ok = now; r.n = 0; delete r.s; r.by = o.by;
      if (o.route) r.r = String(o.route).slice(0, 12);
      w[1]++;
      p.w[p.w.length - 1][1]++; p.ok = now; Health._recent(p, 1, it.k);
    } else {
      const msg = String(o.msg || '').replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '(address)').slice(0, 140); // (never a stream address: they carry logins)
      const code = Number(o.code) || codeOf(msg);
      const x = classify(msg, code);
      r.e = msg || (code ? whyCode(code) : 'Didn’t play'); r.c = code || undefined; r.x = x; r.f = now; r.by = o.by;
      if (o.started) { this._touch(); return; } // (it played, then stopped: not a dead channel)
      if (x === 'dead') { if (!r.n) r.s = now; r.n = (r.n || 0) + 1; w[2]++; }
      if (x === 'busy') p.w[p.w.length - 1][3]++;
      else if (x === 'dead') { p.w[p.w.length - 1][2]++; p.f = now; p.e = r.e; Health._recent(p, 0, it.k); }
    }
    this._touch();
  }

  /** A provider's last 30 outcomes, with which channel: [worked (1/0), channel key]. */
  static _recent(p, ok, k) { const q = p.q || (p.q = []); q.push([ok, k]); if (q.length > 30) q.splice(0, q.length - 30); }

  _prov(l, day) {
    const p = this.d.prov[l] || (this.d.prov[l] = { w: [], q: [] });
    if (!p.q) { p.q = []; delete p.r; }
    if (!p.w.length || p.w[p.w.length - 1][0] !== day) { p.w.push([day, 0, 0, 0]); while (p.w.length && p.w[0][0] <= day - KEEP_DAYS) p.w.shift(); }
    return p;
  }

  /** Forgets a channel's history (or everything). */
  forget(k) {
    if (!k) { this.d.copies = {}; this.d.prov = {}; } else for (const id of Object.keys(this.d.copies)) if (this.d.copies[id].k === k) delete this.d.copies[id];
    this.store.save();
    this._down = null; this._downCheck();
  }

  /** "Use the backup copy first": the copy id to put first for a channel ('' = back to normal). */
  prefer(k, id) {
    if (id) this.d.prefer[k] = String(id); else delete this.d.prefer[k];
    this.store.save();
  }

  /** Is this copy dead, as far as anyone can tell? (Several failures in a row, recently, and no success since.) */
  static dead(r, now = Date.now()) {
    if (!r || !r.n) return false;
    if (now - (r.f || 0) > 2 * DAY) return false;
    return r.n >= 3 || (r.n >= 2 && r.by === 'c');
  }

  /** Channels whose every copy is dead (the "may be down" mark). Only copies with a record count: an untried backup might work. */
  downKeys() {
    if (this._down) return this._down;
    const cat = this.catalog();
    const now = Date.now();
    const deadBy = new Map();
    for (const [id, r] of Object.entries(this.d.copies)) if (Health.dead(r, now)) { const s = deadBy.get(r.k) || new Set(); s.add(id); deadBy.set(r.k, s); }
    const out = [];
    for (const [k, ids] of deadBy) {
      const it = cat && cat.get(k);
      if (!isChan(it)) continue;
      const all = Health.copies(it);
      if (all.every((c) => ids.has(c.id) && this.d.copies[c.id].uh === uhash(c.u))) out.push(k);
    }
    out.sort();
    this._down = out;
    return out;
  }
  _downCheck() {
    const sig = this.opts.marks === false ? '' : this.downKeys().join(',');
    if (sig === this._downSig) return;
    this._downSig = sig;
    this.downV++;
    try { this.onDown(this.downV); } catch {}
  }

  /** For /api/play/sources: a number per copy, lower plays first (the preferred backup; copies that failed their last N checks last). */
  rank(it) {
    const pref = this.d.prefer[it.k];
    const skip = this.opts.skipAfter || 0;
    if (!pref && !skip) return null;
    const copies = Health.copies(it);
    return (alt) => {
      const c = copies.find((x) => x.alt === alt);
      if (!c) return 0;
      if (pref && c.id === pref) return -1;
      const r = skip && this.d.copies[c.id];
      return r && r.n >= skip && r.uh === uhash(c.u) && Date.now() - (r.f || 0) < 2 * DAY ? 1 : 0;
    };
  }

  // ------------------------------------------------------------ the admin's view
  /** Per provider: up / down / problems, success rate over 7 days and per day, last success and failure. */
  providers(lists) {
    const today = dayNo();
    return lists.map((l) => {
      const p = this.d.prov[l.id] || { w: [], q: [] };
      const days = [];
      for (let d = today - KEEP_DAYS + 1; d <= today; d++) { const x = p.w.find((y) => y[0] === d); days.push(x ? { ok: x[1], fail: x[2], busy: x[3] || 0 } : { ok: 0, fail: 0, busy: 0 }); }
      const ok = days.reduce((a, x) => a + x.ok, 0), fail = days.reduce((a, x) => a + x.fail, 0);
      const now = Date.now();
      // Down means the provider, not a channel: since its last success, failures on several different channels
      // (3, or every channel tried when it never worked). One dead channel tried again and again is a channel problem.
      const q = p.q || [];
      const since = new Set();
      let i = q.length - 1;
      for (; i >= 0 && !q[i][0]; i--) since.add(q[i][1]);
      const everOk = q.some((x) => x[0]);
      const tried = new Set(q.map((x) => x[1]));
      const failedChans = new Set(q.filter((x) => !x[0]).map((x) => x[1]));
      const failingNow = new Set(Object.values(this.d.copies).filter((r) => r.l === l.id && r.n > 0 && now - (r.f || 0) < KEEP_DAYS * DAY).map((r) => r.k)).size;
      let state = 'unknown';
      if (now - (p.f || 0) < 6 * 3600e3 && (since.size >= 3 || (!everOk && since.size >= 2 && since.size === tried.size))) state = 'down';
      else if (ok + fail >= 5 && ok / (ok + fail) < 0.8 && failedChans.size >= 2) state = 'problems';
      else if (p.ok && now - p.ok < DAY) state = 'up';
      else if (ok) state = 'up';
      return { id: l.id, name: l.name, state, rate: ok + fail ? Math.round((ok / (ok + fail)) * 100) : null, ok, fail, days, lastOk: p.ok || 0, lastFail: p.f || 0, lastErr: p.e || '', failingNow, gentle: !!this.d.gentle[l.id] };
    });
  }

  /** Channels with a copy failing now (and how its other copies do). */
  failing({ list = '', show = '', q = '', norm = (s) => String(s).toLowerCase() } = {}) {
    const cat = this.catalog();
    const now = Date.now();
    const byK = new Map();
    for (const [id, r] of Object.entries(this.d.copies)) if (r.n > 0 && now - (r.f || 0) < KEEP_DAYS * DAY) { const a = byK.get(r.k) || []; a.push(id); byK.set(r.k, a); }
    const out = [];
    const nq = q ? norm(q) : '';
    for (const [k] of byK) {
      const it = cat && cat.get(k);
      if (!isChan(it)) continue;
      if (nq && !norm(it.n).includes(nq) && String(it.num) !== q) continue;
      const copies = Health.copies(it).map((c) => {
        const r = this.d.copies[c.id];
        const fresh = r && r.uh === uhash(c.u);
        return {
          id: c.id, alt: c.alt, list: c.l, failing: !!(fresh && r.n > 0), dead: !!(fresh && Health.dead(r, now)), n: fresh ? r.n || 0 : 0, since: fresh ? r.s || 0 : 0,
          err: fresh && r.n ? r.e || '' : '', code: fresh && r.n ? r.c || 0 : 0, lastFail: fresh ? r.f || 0 : 0, lastOk: fresh ? r.ok || 0 : 0, by: fresh ? r.by || '' : '', checked: fresh ? r.ck || 0 : 0,
          works: !!(fresh && !r.n && r.ok && now - r.ok < KEEP_DAYS * DAY),
        };
      });
      if (list && !copies.some((c) => c.failing && c.list === list)) continue;
      const allDown = copies.every((c) => c.failing);
      const backup = copies.some((c) => c.works);
      if (show === 'down' && !allDown) continue;
      if (show === 'backup' && !backup) continue;
      const worst = Math.max(...copies.map((c) => c.n));
      out.push({ k, n: it.n, num: it.num || 0, g: it.g, logo: it.logo || '', copies, allDown, backup, down: allDown && copies.every((c) => c.dead), worst, prefer: this.d.prefer[k] || '' });
    }
    out.sort((a, b) => (b.down - a.down) || (b.allDown - a.allDown) || (b.worst - a.worst) || a.n.localeCompare(b.n));
    return out;
  }

  /** Copies a device had trouble with lately that the checker hasn't looked at since (checked first). */
  suspects(listId) {
    const now = Date.now();
    return Object.entries(this.d.copies).filter(([, r]) => r.l === listId && r.n > 0 && r.by === 'p' && now - (r.ck || 0) > 2 * 3600e3 && now - (r.f || 0) < 2 * DAY)
      .sort((a, b) => (b[1].f || 0) - (a[1].f || 0)).map(([id, r]) => ({ id, k: r.k }));
  }
  lastCheck(id) { const r = this.d.copies[id]; return (r && r.ck) || 0; }

  _prune() {
    const now = Date.now();
    const cat = this.catalog();
    const have = cat && cat.items && cat.items.length;
    let dirty = false;
    for (const [id, r] of Object.entries(this.d.copies)) {
      const last = Math.max(r.ok || 0, r.f || 0, r.ck || 0);
      if (now - last > 30 * DAY || (have && !cat.get(r.k) && now - last > 3 * DAY)) { delete this.d.copies[id]; dirty = true; }
    }
    for (const k of Object.keys(this.d.prefer)) if (have && !cat.get(k)) { delete this.d.prefer[k]; dirty = true; }
    if (dirty) this.store.save();
  }
}

/**
 * The background checker. deps: { health, catalog(), lists, usage(listId) → viewers, other(listId) → why it's busy
 * ('' = free), conns() → the open app connections, headers(h), fetch, log }.
 */
class Checker {
  constructor(deps) {
    Object.assign(this, deps);
    this.manual = new Map(); // list id → { at, by (session), cursor, n, ok, fail, total, done, stopped }
    this.cursor = new Map(); // list id → where the nightly pass is in the catalogue
    this.current = null;
    this.lastOn = new Map(); // list id → when its last check ended
    this.lastUsed = new Map(); // list id → when someone was last seen watching from it
    this.waiting = new Map(); // list id → why it isn't being checked right now
    this.nightly = new Map(); // list id → { day, n } checks tonight
    this.rr = 0;
    this._t = setInterval(() => this.tick().catch((e) => this.log(`Channel checks: ${e.message}`)), deps.every || 3000);
    this._t.unref();
  }

  get opts() { return this.health.opts; }
  inWindow(t = Date.now()) {
    const h = new Date(t).getHours(), { from, to } = this.opts;
    return from === to ? true : from < to ? h >= from && h < to : h >= from || h < to;
  }
  /** How many live streams a list allows: { n, known } (n = Infinity when tested and none was refused). */
  static limitOf(l) {
    const ct = l.connTest && l.connTest.live;
    if (ct && ct.max >= 1) return ct.limited ? { n: ct.max + (l.connTest.already || 0), known: true } : { n: Infinity, known: true };
    const n = parseInt(l.account && l.account.maxConnections, 10);
    return n > 0 ? { n, known: true } : { n: 1, known: false };
  }
  static tight(l) { const x = Checker.limitOf(l); return !x.known || x.n < 2; }
  gapFor(l) { return (this.health.d.gentle[l.id] ? Math.max(GENTLE_GAP, this.opts.gap) : this.opts.gap) * 1000; }
  checkable(l) { return l && l.enabled && CHECKABLE.has(l.type); }

  /** Live channel copies per list (for progress and estimates), counted once per catalogue version. */
  counts() {
    const cat = this.catalog();
    if (this._counts && this._counts.v === cat.version) return this._counts.m;
    const m = new Map();
    for (const it of cat.items) {
      if (it.t !== 'live') continue;
      for (const c of Health.copies(it)) if (/^https?:\/\//i.test(c.u)) m.set(c.l, (m.get(c.l) || 0) + 1);
    }
    this._counts = { v: cat.version, m };
    return m;
  }

  /** Why this provider can't be checked right now ('' = it can). */
  blocked(l, job) {
    const now = Date.now();
    if ((this.usage(l.id) || []).length) return 'Someone is watching from this provider.';
    if (now - (this.lastUsed.get(l.id) || 0) < 3 * 60e3) return 'Someone was watching from it a moment ago.';
    const other = this.other(l.id);
    if (other) return other;
    if (Checker.tight(l)) {
      const open = [...this.conns()].filter((c) => !(job && job.by && c.sess === job.by));
      if (open.length) return 'This provider allows one stream at a time, so checks wait until nobody ' + (job ? 'else ' : '') + 'has the app open.';
    }
    return '';
  }

  /** Starts a "Check now" pass for one list (still only when it's quiet). */
  start(l, by) {
    if (!this.checkable(l)) throw Object.assign(new Error('Only playlists and Xtream Codes accounts can be checked.'), { status: 400 });
    const old = this.manual.get(l.id);
    if (old && !old.done) return old;
    const job = { at: Date.now(), by: by || '', cursor: 0, n: 0, ok: 0, fail: 0, total: this.counts().get(l.id) || 0, done: 0, stopped: false };
    this.manual.set(l.id, job);
    this.waiting.delete(l.id);
    setImmediate(() => this.tick().catch(() => {}));
    return job;
  }
  stop(listId) {
    const job = this.manual.get(listId);
    if (job && !job.done) { job.done = Date.now(); job.stopped = true; }
    if (this.current && this.current.list === listId) this.current.ac.abort();
    return job || null;
  }
  /** Someone is about to play this channel: a check on any of its providers stops at once. */
  yieldTo(it) {
    const cur = this.current;
    if (!cur || !it) return;
    if (Health.copies(it).some((c) => c.l === cur.list)) { cur.ac.abort(); cur.yielded = true; }
  }

  status(listId) {
    const job = this.manual.get(listId);
    const cur = this.current && this.current.list === listId ? { k: this.current.k, n: this.current.n, at: this.current.at } : null;
    return { job: job ? { at: job.at, n: job.n, ok: job.ok, fail: job.fail, total: job.total, done: job.done, stopped: job.stopped } : null, current: cur, waiting: this.waiting.get(listId) || '' };
  }

  async tick() {
    if (this.current || this._busy) return;
    this._busy = true;
    try { await this._tick(); } finally { this._busy = false; }
  }

  async _tick() {
    const now = Date.now();
    const all = this.lists.all().filter((l) => this.checkable(l));
    for (const l of all) if ((this.usage(l.id) || []).length) this.lastUsed.set(l.id, now);
    const night = this.opts.on && this.inWindow(now);
    const cands = all.filter((l) => { const j = this.manual.get(l.id); return (j && !j.done) || night; });
    if (!night) for (const l of all) if (!this.manual.get(l.id) || this.manual.get(l.id).done) this.waiting.delete(l.id);
    if (!cands.length) return;
    const day = dayNo(now - 12 * 3600e3); // (a night's checks count together across midnight)
    for (let i = 0; i < cands.length; i++) {
      const l = cands[(this.rr + i) % cands.length];
      const job = this.manual.get(l.id);
      const manual = !!(job && !job.done);
      const why = this.blocked(l, manual ? job : null);
      if (why) { this.waiting.set(l.id, why); continue; }
      if (now - (this.lastOn.get(l.id) || 0) < this.gapFor(l)) continue;
      const nc = this.nightly.get(l.id);
      if (!manual && this.health.d.gentle[l.id] && nc && nc.day === day && nc.n >= GENTLE_CAP) { this.waiting.set(l.id, `Checked ${GENTLE_CAP} channels tonight (this provider counts each check as a login).`); continue; }
      const target = this.next(l, manual ? job : null);
      if (!target) {
        if (manual) { job.done = Date.now(); this.waiting.delete(l.id); } else this.waiting.set(l.id, 'Every channel has been checked in the last day.');
        continue;
      }
      this.waiting.delete(l.id);
      this.rr = (this.rr + i + 1) % Math.max(1, cands.length);
      await this.check(l, target, manual ? job : null);
      if (!manual) { const x = this.nightly.get(l.id); if (x && x.day === day) x.n++; else this.nightly.set(l.id, { day, n: 1 }); }
      return;
    }
  }

  /** The next copy to check on a list: one a device had trouble with first, then the next due one in catalogue order. */
  next(l, job) {
    const cat = this.catalog();
    const now = Date.now();
    const okUrl = (u) => /^https?:\/\//i.test(u || '');
    for (const s of this.health.suspects(l.id)) {
      const it = cat.get(s.k);
      const c = it && it.t === 'live' && Health.copies(it).find((x) => x.id === s.id && okUrl(x.u));
      if (c) return { it, c };
    }
    // Due: not checked for a day (nightly) or half an hour ("Check now", which also looks again at failing ones).
    const due = (id) => {
      const ago = now - this.health.lastCheck(id);
      if (ago > (job ? 30 * 60e3 : 20 * 3600e3)) return true;
      const r = job && this.health.d.copies[id];
      return !!(r && r.n > 0 && job.at > (r.ck || 0));
    };
    const items = cat.items;
    let i = job ? job.cursor : this.cursor.get(l.id) || 0;
    for (let scanned = 0; scanned < 50000 && i < items.length; scanned++, i++) {
      const it = items[i];
      if (it.t !== 'live') continue;
      const c = Health.copies(it).find((x) => x.l === l.id && okUrl(x.u) && due(x.id));
      if (c) { if (job) job.cursor = i; else this.cursor.set(l.id, i); return { it, c }; }
    }
    if (i < items.length) { if (job) job.cursor = i; else this.cursor.set(l.id, i); return null; } // (more next time)
    if (job) job.cursor = items.length; else this.cursor.set(l.id, 0);
    this.health.d.passes[l.id] = now;
    return null;
  }

  async check(l, { it, c }, job) {
    const ac = new AbortController();
    const cur = { list: l.id, k: it.k, n: it.n, at: Date.now(), ac };
    this.current = cur;
    const tight = Checker.tight(l);
    const openAt = new Set([...this.conns()].map((x) => x.id));
    // Stop at once if someone starts watching (or, on a one-stream provider, opens the app).
    const watch = setInterval(() => {
      if ((this.usage(l.id) || []).length || this.other(l.id)) return ac.abort();
      if (tight) for (const x of this.conns()) if (!openAt.has(x.id) && !(job && job.by && x.sess === job.by)) return ac.abort();
      if (job && job.done) ac.abort();
    }, 200);
    let r;
    try {
      const a = (it.alts || [])[c.alt];
      r = await probe(c.u, this.headers(c.alt >= 0 ? (a && a.h) || {} : it.h || {}), { fetch: this.fetch, signal: ac.signal, timeout: this.timeout || 15000 });
    } finally { clearInterval(watch); this.current = null; this.lastOn.set(l.id, Date.now()); }
    if (r.stopped) { if (!(job && job.done)) this.waiting.set(l.id, cur.yielded ? 'Stopped: someone started watching.' : 'Stopped: the provider got busy.'); return r; }
    this.health.record(it, c.alt, { ok: r.ok, by: 'c', route: 'check', msg: r.err, code: r.code });
    if (job) { job.n++; if (r.ok) job.ok++; else job.fail++; }
    return r;
  }

  /** How long a full pass takes for a list, at the current settings: { copies, perCheck (s), seconds, nights }. */
  estimate(l) {
    const copies = this.counts().get(l.id) || 0;
    const per = this.gapFor(l) / 1000 + 2;
    const seconds = Math.round(copies * per);
    const win = ((this.opts.to - this.opts.from + 24) % 24 || 24) * 3600;
    const perNight = Math.min(Math.floor(win / per), this.health.d.gentle[l.id] ? GENTLE_CAP : Infinity);
    return { copies, perCheck: per, seconds, nights: copies ? Math.ceil(copies / Math.max(1, perNight)) : 0 };
  }
}

module.exports = { Health, Checker, probe, classify, codeOf, dayNo, DEFAULT_OPTS, GENTLE_GAP, GENTLE_CAP };
