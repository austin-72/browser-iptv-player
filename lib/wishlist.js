'use strict';
/**
 * Each profile's Wishlist (films and series that aren't here yet, found on TMDB or in a list row), the series it
 * follows (or has muted) with the bell on the series page, and its alerts: "on your wishlist and now here",
 * "3 new episodes of X". Alerts wait in the profile's inbox (Messages → New for you) until they're read.
 * Kept in wishlist.json.
 */
const path = require('path');
const { JsonFile } = require('./store');
const { HttpError, uid } = require('./util');

const MAX_WISH = 500;
const MAX_ALERTS = 100;

class Wishlist {
  constructor(dataDir) {
    // profiles: pid → { wish: [{ id, t, n, y, tmdb, p, at, got, gotAt }], follow: [show keys], mute: [show keys], alerts: [...] }
    this.store = new JsonFile(path.join(dataDir, 'wishlist.json'), { profiles: {} });
  }

  of(pid) {
    const d = this.store.data.profiles;
    const p = d[pid] || (d[pid] = {});
    for (const k of ['wish', 'follow', 'mute', 'alerts']) if (!Array.isArray(p[k])) p[k] = [];
    return p;
  }
  has(pid) { return !!this.store.data.profiles[pid]; }
  pids() { return Object.keys(this.store.data.profiles); }
  forget(pid) { delete this.store.data.profiles[pid]; this.store.save(); }

  // ------------------------------------------------------------ wishlist
  /** { t: 'movie'|'show', n, y, tmdb?, p? } → the entry (an existing one when it's already there). */
  add(pid, e) {
    const t = e && (e.t === 'show' || e.t === 'tv') ? 'show' : 'movie';
    const n = String((e && e.n) || '').trim().slice(0, 200);
    if (!n) throw new HttpError(400, 'Which title?');
    const y = Math.max(0, Math.min(3000, parseInt(e.y, 10) || 0));
    const tmdb = /^\d+$/.test(String(e.tmdb || '')) ? String(e.tmdb) : '';
    const p = this.of(pid);
    const same = (x) => x.t === t && (tmdb && x.tmdb ? x.tmdb === tmdb : x.n.toLowerCase() === n.toLowerCase() && (!y || !x.y || x.y === y));
    const have = p.wish.find(same);
    if (have) return have;
    if (p.wish.length >= MAX_WISH) throw new HttpError(400, `Your wishlist is full (${MAX_WISH}). Remove a few first.`);
    const w = { id: uid(), t, n, y, at: Date.now() };
    if (tmdb) w.tmdb = tmdb;
    if (/^tt\d{5,10}$/.test(String(e.imdb || ''))) w.imdb = String(e.imdb); // (from an imported IMDb list: matched by it when it arrives)
    if (e.p && /^https:\/\/image\.tmdb\.org\//.test(String(e.p))) w.p = String(e.p).slice(0, 300);
    p.wish.unshift(w);
    this.store.save();
    return w;
  }

  remove(pid, id) {
    const p = this.of(pid);
    const n = p.wish.length;
    p.wish = p.wish.filter((w) => w.id !== id);
    this.store.save();
    return p.wish.length !== n;
  }

  /**
   * Wished titles that are here now: match(entry) → key | null. Marks them and returns the newly arrived
   * [{ w, k }] for each profile: Map(pid → [...]).
   */
  arrivals(match) {
    const out = new Map();
    for (const pid of this.pids()) {
      const p = this.of(pid);
      for (const w of p.wish) {
        if (w.got) continue;
        const k = match(w, pid);
        if (!k) continue;
        w.got = k;
        w.gotAt = Date.now();
        if (!out.has(pid)) out.set(pid, []);
        out.get(pid).push({ w, k });
      }
    }
    if (out.size) this.store.save();
    return out;
  }

  // ------------------------------------------------------------ the bell on series pages
  /** on: true = follow, false = mute, null = back to automatic. */
  setFollow(pid, sk, on) {
    const p = this.of(pid);
    p.follow = p.follow.filter((x) => x !== sk);
    p.mute = p.mute.filter((x) => x !== sk);
    if (on === true) p.follow.unshift(sk);
    if (on === false) p.mute.unshift(sk);
    p.follow = p.follow.slice(0, 500);
    p.mute = p.mute.slice(0, 500);
    this.store.save();
    return { follow: on === true, mute: on === false };
  }
  follows(pid) { return this.has(pid) ? this.of(pid).follow : []; }
  muted(pid, sk) { return this.has(pid) && this.of(pid).mute.includes(sk); }

  // ------------------------------------------------------------ alerts (the inbox)
  /**
   * Adds an alert, or updates the unread one about the same title (so a series gets one alert, counting its new
   * episodes). a: { kind: 'wish'|'episode', k, title, body, i, n, eps } → the alert.
   */
  alert(pid, a, { seen = false } = {}) {
    const p = this.of(pid);
    const same = p.alerts.find((x) => x.k === a.k && x.kind === a.kind && !x.read);
    if (same) {
      if (a.kind === 'episode') { same.eps = [...new Set([...(same.eps || []), ...(a.eps || [])])].slice(-50); same.n = same.eps.length || (same.n || 1) + (a.n || 1); }
      same.title = a.kind === 'episode' && same.n > 1 && a.show ? `${same.n} new episodes of ${a.show}` : a.title;
      same.body = a.body || same.body;
      same.at = Date.now();
      same.seen = same.seen && seen;
      // (newest first)
      p.alerts = [same, ...p.alerts.filter((x) => x !== same)];
      this.store.save();
      return same;
    }
    const x = { id: uid(), kind: a.kind, k: a.k || '', title: String(a.title || '').slice(0, 200), body: String(a.body || '').slice(0, 300), at: Date.now(), read: false, seen: !!seen };
    if (a.i) x.i = String(a.i).slice(0, 500);
    if (a.n) x.n = a.n;
    if (a.eps) x.eps = a.eps.slice(-50);
    p.alerts.unshift(x);
    if (p.alerts.length > MAX_ALERTS) p.alerts.length = MAX_ALERTS;
    this.store.save();
    return x;
  }

  alerts(pid) { return this.has(pid) ? this.of(pid).alerts : []; }
  unread(pid) { return this.alerts(pid).filter((a) => !a.read).length; }

  /** ids: [..] or 'all'. */
  markRead(pid, ids) {
    let n = 0;
    for (const a of this.alerts(pid)) if (!a.read && (ids === 'all' || ids.includes(a.id))) { a.read = true; a.seen = true; n++; }
    if (n) this.store.save();
    return n;
  }
  /** The ones no device has shown yet (the profile wasn't online): shown once, next time the app opens. */
  takeUnseen(pid) {
    const out = this.alerts(pid).filter((a) => !a.seen && !a.read);
    for (const a of out) a.seen = true;
    if (out.length) this.store.save();
    return out;
  }
  removeAlert(pid, id) {
    const p = this.of(pid);
    p.alerts = p.alerts.filter((a) => a.id !== id);
    this.store.save();
  }
}

module.exports = { Wishlist };
