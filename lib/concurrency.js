'use strict';
/**
 * How many provider connections each list (provider account) uses at once, over time — so the admin can see which
 * provider is busiest, when, and whether the household runs into an account's connection limit.
 *
 * Every minute the server counts the streams each list is serving right now (the same count the connection limits
 * use: each device or multiview tile, a watch party's shared stream once, recordings included, films the stream relay
 * already has not) and notes the list's limit. Kept in concurrency.json:
 *   minutes  the last 48 hours, one sample a minute: { t, n: { listId: count } }
 *   hours    the last 120 days, one entry an hour per list: { peak, sum, mins, full } (full: minutes at the limit)
 *   away     times someone was turned away because every copy was busy, per hour and list
 *   limits   each list's limit as last seen (0 = unknown or none)
 *   strain   times the stream relay couldn't keep up with the films being watched (the last 500): { t, list, viewers,
 *            films, runs, budget, least, need, rate } — when usage peaked beyond what the provider sends
 */
const path = require('path');
const { JsonFile } = require('./store');

const MIN = 60e3, HOUR = 3600e3;
const KEEP_MIN = 48 * HOUR;
const KEEP_HOURS = 120 * 24 * HOUR;
const hourOf = (t) => Math.floor(t / HOUR) * HOUR;

class Concurrency {
  /**
   * deps: { usage() → Map(listId → viewers[]), lists() → [{ id, name }], limitOf(listId) → number,
   *         extra(listId) → connections in use beyond what usage() shows (the stream relay's shared ones) }
   */
  constructor(dataDir, deps, { every = MIN } = {}) {
    this.deps = deps;
    this.store = new JsonFile(path.join(dataDir, 'concurrency.json'), { since: Date.now(), minutes: [], hours: {}, away: {}, limits: {} }, { delay: 10000 });
    this.recentAway = new Map(); // who|list → when (one "turned away" per person and list a minute)
    if (every) { this._timer = setInterval(() => { try { this.sample(); } catch {} }, every); this._timer.unref(); }
  }
  stop() { clearInterval(this._timer); }

  /** Counts what each list is serving now (called every minute). */
  sample(now = Date.now()) {
    const d = this.store.data;
    const use = this.deps.usage();
    const n = {};
    for (const l of this.deps.lists()) {
      const c = (use.get(l.id) || []).length + ((this.deps.extra && this.deps.extra(l.id)) || 0);
      const lim = this.deps.limitOf(l.id) || 0;
      d.limits[l.id] = lim;
      if (c) n[l.id] = c;
      const h = (d.hours[l.id] || (d.hours[l.id] = {}));
      const k = String(hourOf(now));
      const e = h[k] || (h[k] = { peak: 0, sum: 0, mins: 0, full: 0 });
      e.peak = Math.max(e.peak, c);
      e.sum += c;
      e.mins++;
      if (lim && c >= lim) e.full++;
    }
    d.minutes.push({ t: now, n });
    this._prune(now);
    this.store.save();
    return n;
  }

  /** The stream relay couldn't keep up (lib/streamrelay.js reports it): note when, and how busy it was. */
  relayStrain(listId, e) {
    const d = this.store.data;
    if (!d.strain) d.strain = [];
    const num = (x) => (Number.isFinite(Number(x)) ? Math.round(Number(x)) : 0);
    d.strain.push({ t: num(e.t) || Date.now(), list: String(listId || ''), viewers: num(e.viewers), films: num(e.films), runs: num(e.runs), budget: num(e.budget), least: num(e.least), stalled: num(e.stalled), need: num(e.need), rate: num(e.rate) });
    if (d.strain.length > 500) d.strain.splice(0, d.strain.length - 500);
    this.store.save();
  }

  /** Someone wanted to watch and every copy was busy: note it against those lists. */
  turnedAway(who, listIds, now = Date.now()) {
    const d = this.store.data;
    const k = String(hourOf(now));
    for (const l of new Set(listIds.filter(Boolean))) {
      const key = who + '|' + l;
      if (now - (this.recentAway.get(key) || 0) < MIN) continue;
      this.recentAway.set(key, now);
      const a = d.away[l] || (d.away[l] = {});
      a[k] = (a[k] || 0) + 1;
    }
    if (this.recentAway.size > 2000) for (const [key, t] of this.recentAway) if (now - t > MIN) this.recentAway.delete(key);
    this.store.save();
  }

  _prune(now) {
    const d = this.store.data;
    const cutM = now - KEEP_MIN;
    let i = 0;
    while (i < d.minutes.length && d.minutes[i].t < cutM) i++;
    if (i) d.minutes.splice(0, i);
    const cutH = now - KEEP_HOURS;
    for (const box of [d.hours, d.away]) for (const l of Object.keys(box)) {
      for (const k of Object.keys(box[l])) if (+k < cutH) delete box[l][k];
      if (!Object.keys(box[l]).length) delete box[l];
    }
  }

  /**
   * For Admin → Statistics. days: the period. tzOffset: the viewer's minutes from UTC (Date#getTimezoneOffset), for
   * the "when" grid.
   */
  report(days = 7, tzOffset = 0, now = Date.now()) {
    const d = this.store.data;
    const live = this.deps.usage();
    const names = new Map(this.deps.lists().map((l) => [l.id, l.name]));
    const from = now - days * 86400e3;
    const ids = new Set([...names.keys(), ...Object.keys(d.hours)]);
    const providers = [];
    for (const id of ids) {
      const hrs = Object.entries(d.hours[id] || {}).filter(([k]) => +k >= hourOf(from)).map(([k, e]) => ({ t: +k, ...e }));
      const away = Object.entries(d.away[id] || {}).filter(([k]) => +k >= hourOf(from)).reduce((a, [, v]) => a + v, 0);
      const mins = hrs.reduce((a, e) => a + e.mins, 0);
      if (!names.has(id) && !mins) continue;
      const busy = hrs.reduce((a, e) => a + e.sum, 0);
      const peakE = hrs.reduce((a, e) => (e.peak > (a ? a.peak : 0) ? e : a), null);
      // When: the week grid (7 days × 24 hours, the viewer's local time), the highest count and the average.
      const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ peak: 0, sum: 0, mins: 0, full: 0 })));
      for (const e of hrs) {
        const local = new Date(e.t - tzOffset * MIN);
        const g = grid[local.getUTCDay()][local.getUTCHours()];
        g.peak = Math.max(g.peak, e.peak); g.sum += e.sum; g.mins += e.mins; g.full += e.full;
      }
      const strain = (d.strain || []).filter((e) => e.list === id && e.t >= from);
      providers.push({
        id, name: names.get(id) || 'Removed list', gone: !names.has(id),
        strain: strain.length, strainLast: strain.length ? strain[strain.length - 1].t : 0,
        now: (live.get(id) || []).length + ((this.deps.extra && this.deps.extra(id)) || 0), limit: d.limits[id] || 0,
        peak: peakE ? peakE.peak : 0, peakAt: peakE ? peakE.t : 0,
        avg: mins ? busy / mins : 0, mins, fullMins: hrs.reduce((a, e) => a + e.full, 0), away,
        hours: hrs.map((e) => ({ t: e.t, peak: e.peak, avg: e.mins ? e.sum / e.mins : 0, full: e.full, away: (d.away[id] || {})[e.t] || 0 })),
        grid: grid.map((row) => row.map((g) => [g.peak, g.mins ? Math.round(g.sum / g.mins * 100) / 100 : 0, g.full])),
      });
    }
    providers.sort((a, b) => b.avg - a.avg || b.peak - a.peak || a.name.localeCompare(b.name));
    // Every list together, minute by minute (the last 48 hours) — per list too, for the chart.
    const minutes = d.minutes.filter((m) => m.t >= Math.max(from, now - KEEP_MIN));
    const strain = (d.strain || []).filter((e) => e.t >= from).slice(-60).reverse().map((e) => ({ ...e, name: names.get(e.list) || (e.list ? 'Removed list' : 'Not known') }));
    return { since: d.since, days, now, providers, minutes: minutes.map((m) => [m.t, m.n]), strain };
  }

  reset() { const d = this.store.data; d.since = Date.now(); d.minutes = []; d.hours = {}; d.away = {}; d.strain = []; this.store.save(); }
}

module.exports = { Concurrency };
