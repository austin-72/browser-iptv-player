'use strict';
/**
 * "Your viewing": compact daily totals per profile, kept in viewing/<profile>.json.
 *
 *   days   'YYYY-MM-DD' → { s, l, m, e, o, f, h: {hour: secs}, i: {key: secs} }   (s = all seconds; l live, m films,
 *          e series, o other; f films finished; h and i are dropped after 45 days, the totals kept for 800)
 *   months 'YYYY-MM'    → { s, l, m, e, o, f, h: [24], w: [7], i: {key: secs} (top 80), g: {genre: secs} }
 *   names  key → [name, type]   (so last year's favourites keep their names after they leave the lists)
 *
 * Fed from what the app already reports (seconds watched per sitting, and progress for "finished"); the first
 * time a profile is looked at, its existing watch history fills in what came before.
 */
const fs = require('fs');
const path = require('path');
const { JsonFile } = require('./store');

const DETAIL_DAYS = 45;
const KEEP_DAYS = 800;
const TOP_MONTH = 80;
const TOP_DAY = 12;

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const kindOf = (t) => (t === 'episode' || t === 'show' ? 'e' : t === 'movie' ? 'm' : t === 'live' || t === 'catchup' || t === 'radio' ? 'l' : 'o');
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
const topOf = (obj, n) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
const addInto = (into, from) => { for (const [k, v] of Object.entries(from || {})) into[k] = (into[k] || 0) + v; return into; };

class Viewing {
  /** deps: { dataDir, catalog(), userdata } */
  constructor({ dataDir, catalog, userdata }) {
    this.dir = path.join(dataDir, 'viewing');
    fs.mkdirSync(this.dir, { recursive: true });
    this.catalog = catalog;
    this.userdata = userdata;
    this.files = new Map();
  }

  of(pid) {
    let f = this.files.get(pid);
    if (f) return f;
    const file = path.join(this.dir, `${pid}.json`);
    const fresh = !fs.existsSync(file) && !fs.existsSync(file + '.bak');
    f = new JsonFile(file, { v: 1, days: {}, months: {}, names: {} }, { delay: 20000 });
    this.files.set(pid, f);
    if (fresh) { try { this._seed(pid, f); } catch {} }
    return f;
  }

  forget(pid) {
    this.files.delete(pid);
    for (const ext of ['.json', '.json.bak']) { try { fs.unlinkSync(path.join(this.dir, pid + ext)); } catch {} }
  }

  /** What a catalogue key stands for in the totals: an episode counts for its series. */
  _unit(k, t, sk, n) {
    const cat = this.catalog();
    let it = cat.get(k);
    if ((t === 'episode' || (it && it.t === 'episode')) && (sk || (it && it.sk))) {
      const show = cat.get(sk || it.sk);
      return { k: sk || it.sk, t: 'show', n: show ? show.n : String(n || '').replace(/\s+S\d+E\d+.*$/i, ''), gn: show ? show.gn : null };
    }
    return { k, t: (it && it.t) || t || 'other', n: it ? it.n : String(n || ''), gn: it ? it.gn : null };
  }

  /** Seconds watched in one sitting (from /api/played). at: when (defaults to now). */
  record(pid, { k, s, t, sk, n }, at = Date.now(), file) {
    const secs = Math.max(0, Math.min(4 * 3600, Number(s) || 0));
    // (Keys come from the device: only real-looking ones, so the file can't be filled with junk.)
    if (!k || !secs || typeof k !== 'string' || k.length > 300 || (sk != null && (typeof sk !== 'string' || sk.length > 300))) return;
    const f = file || this.of(pid);
    const D = f.data;
    const kind = kindOf(t);
    const u = this._unit(k, t, sk, n);
    const dk = dayKey(at), mk = monthKey(at);
    const day = D.days[dk] || (D.days[dk] = { s: 0 });
    const mon = D.months[mk] || (D.months[mk] = { s: 0, h: new Array(24).fill(0), w: new Array(7).fill(0), i: {}, g: {} });
    const hr = new Date(at).getHours(), wd = (new Date(at).getDay() + 6) % 7; // Monday first
    for (const o of [day, mon]) { o.s += secs; o[kind] = (o[kind] || 0) + secs; }
    day.h = day.h || {}; day.h[hr] = (day.h[hr] || 0) + secs;
    day.i = day.i || {}; day.i[u.k] = (day.i[u.k] || 0) + secs;
    let trimmed = false;
    if (Object.keys(day.i).length > TOP_DAY * 2) { day.i = Object.fromEntries(topOf(day.i, TOP_DAY)); trimmed = true; }
    mon.h[hr] += secs; mon.w[wd] += secs;
    mon.i[u.k] = (mon.i[u.k] || 0) + secs;
    if (Object.keys(mon.i).length > TOP_MONTH * 2) { mon.i = Object.fromEntries(topOf(mon.i, TOP_MONTH)); trimmed = true; }
    for (const g of (u.gn || []).slice(0, 4)) mon.g[g] = (mon.g[g] || 0) + secs;
    if (u.n) D.names[u.k] = [String(u.n).slice(0, 120), u.t === 'show' ? 'show' : u.t === 'movie' ? 'movie' : u.t === 'live' || u.t === 'radio' ? 'live' : 'other'];
    if (trimmed) D._pruned = ''; // (names of what was trimmed away go too, not only once a day)
    this._prune(D, at);
    f.save();
  }

  /** A film was watched to the end. */
  finished(pid, at = Date.now(), file) {
    const f = file || this.of(pid);
    const D = f.data;
    const day = D.days[dayKey(at)] || (D.days[dayKey(at)] = { s: 0 });
    const mon = D.months[monthKey(at)] || (D.months[monthKey(at)] = { s: 0, h: new Array(24).fill(0), w: new Array(7).fill(0), i: {}, g: {} });
    day.f = (day.f || 0) + 1;
    mon.f = (mon.f || 0) + 1;
    f.save();
  }

  _prune(D, now = Date.now()) {
    if (D._pruned === dayKey(now)) return;
    D._pruned = dayKey(now);
    const detailCut = dayKey(addDays(now, -DETAIL_DAYS)), keepCut = dayKey(addDays(now, -KEEP_DAYS));
    for (const k of Object.keys(D.days)) {
      if (k < keepCut) delete D.days[k];
      else if (k < detailCut) { delete D.days[k].h; delete D.days[k].i; }
    }
    const mCut = monthKey(addDays(now, -KEEP_DAYS));
    const thisMonth = monthKey(now);
    for (const k of Object.keys(D.months)) {
      if (k < mCut) delete D.months[k];
      else if (k < thisMonth) { const m = D.months[k]; if (Object.keys(m.i || {}).length > TOP_MONTH) m.i = Object.fromEntries(topOf(m.i, TOP_MONTH)); }
    }
    const used = new Set();
    for (const d of Object.values(D.days)) for (const k of Object.keys(d.i || {})) used.add(k);
    for (const m of Object.values(D.months)) for (const k of Object.keys(m.i || {})) used.add(k);
    for (const k of Object.keys(D.names)) if (!used.has(k)) delete D.names[k];
  }

  /** First look at a profile: its watch history (and finished films) fill in the totals before recording began. */
  _seed(pid, f) {
    const d = this.userdata.of(pid).data;
    for (const h of (d.history || []).slice().reverse()) if (h && h.k && h.s > 0) this.record(pid, h, h.at || Date.now(), f);
    for (const [, p] of Object.entries(d.progress || {})) if (p && p.w && p.t === 'movie' && p.at) this.finished(pid, p.at, f);
    f.data.seeded = Date.now();
    f.save();
  }

  // ------------------------------------------------------------ reading it back
  /** [from, to) for a period: week (Monday first), month or year; offset 0 = this one, 1 = the one before… */
  static range(period, offset = 0, now = Date.now()) {
    const d = new Date(startOfDay(now));
    if (period === 'year') { const y = d.getFullYear() - offset; return { from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime(), label: String(y) }; }
    if (period === 'month') { const a = new Date(d.getFullYear(), d.getMonth() - offset, 1); const b = new Date(a.getFullYear(), a.getMonth() + 1, 1); return { from: a.getTime(), to: b.getTime(), label: a.toLocaleString('en-GB', { month: 'long', year: 'numeric' }) }; }
    const monday = addDays(d.getTime(), -((d.getDay() + 6) % 7) - 7 * offset);
    return { from: monday, to: addDays(monday, 7), label: '' };
  }

  _days(D, from, to) {
    const out = [];
    for (let t = from; t < to; t = addDays(t, 1)) out.push([dayKey(t), D.days[dayKey(t)] || null]);
    return out;
  }
  _months(D, from, to) {
    const out = [];
    for (let t = from; t < to; t = new Date(new Date(t).getFullYear(), new Date(t).getMonth() + 1, 1).getTime()) out.push([monthKey(t), D.months[monthKey(t)] || null]);
    return out;
  }

  /** Totals for [from, to): seconds by kind, films finished, days watched, longest streak, and per-day / per-month. */
  _totals(D, from, to, byMonth) {
    const tot = { s: 0, l: 0, m: 0, e: 0, o: 0, f: 0, days: 0, streak: 0 };
    let run = 0;
    const days = this._days(D, from, Math.min(to, addDays(startOfDay(Date.now()), 1)));
    for (const [, x] of days) {
      if (x) for (const k of ['s', 'l', 'm', 'e', 'o', 'f']) tot[k] += x[k] || 0;
      if (x && x.s >= 60) { tot.days++; run++; tot.streak = Math.max(tot.streak, run); } else run = 0;
    }
    const series = byMonth ? this._months(D, from, to).map(([k, x]) => ({ key: k, s: x ? x.s : 0, l: x ? x.l || 0 : 0, m: x ? x.m || 0 : 0, e: x ? x.e || 0 : 0 }))
      : this._days(D, from, to).map(([k, x]) => ({ key: k, s: x ? x.s : 0, l: x ? x.l || 0 : 0, m: x ? x.m || 0 : 0, e: x ? x.e || 0 : 0 }));
    return { tot, series };
  }

  /** Items, hours, weekdays and genres for [from, to): from the daily detail when it covers the period, else monthly. */
  _detail(D, from, to) {
    const items = {}, hours = new Array(24).fill(0), week = new Array(7).fill(0), genres = {};
    const detailFrom = startOfDay(addDays(Date.now(), -DETAIL_DAYS + 1));
    const monthly = from < detailFrom && (to - from) > 8 * 86400e3; // (a short period long ago has no detail left)
    if (!monthly) {
      for (const [k, x] of this._days(D, from, to)) {
        if (!x) continue;
        addInto(items, x.i);
        for (const [h, v] of Object.entries(x.h || {})) hours[+h] += v;
        const p = k.split('-');
        week[(new Date(+p[0], +p[1] - 1, +p[2]).getDay() + 6) % 7] += x.s || 0;
      }
      const cat = this.catalog();
      for (const [k, v] of Object.entries(items)) { const it = cat.get(k); for (const g of ((it && it.gn) || []).slice(0, 4)) genres[g] = (genres[g] || 0) + v; }
    } else {
      for (const [, x] of this._months(D, from, to)) {
        if (!x) continue;
        addInto(items, x.i);
        addInto(genres, x.g);
        (x.h || []).forEach((v, i) => { hours[i] += v || 0; });
        (x.w || []).forEach((v, i) => { week[i] += v || 0; });
      }
    }
    return { items, hours, week, genres };
  }

  _named(D, entries, type, n) {
    const cat = this.catalog();
    const out = [];
    for (const [k, s] of entries) {
      if (s < 60) break; // (sorted: the rest are under a minute too — not worth listing)
      const it = cat.get(k);
      const nm = D.names[k] || (it ? [it.n, it.t] : null);
      const t = it ? (it.t === 'radio' ? 'live' : it.t) : nm ? nm[1] : '';
      if (t !== type) continue;
      out.push({ k, n: nm ? nm[0] : '', s: Math.round(s), here: !!it });
      if (out.length >= n) break;
    }
    return out;
  }

  /** Everything the "Your viewing" page shows for a period. */
  summary(pid, period = 'week', offset = 0) {
    if (!['week', 'month', 'year'].includes(period)) period = 'week';
    offset = Math.max(0, Math.min(50, offset | 0));
    const D = this.of(pid).data;
    const r = Viewing.range(period, offset);
    const prev = Viewing.range(period, offset + 1);
    const cur = this._totals(D, r.from, r.to, period === 'year');
    const before = this._totals(D, prev.from, prev.to, period === 'year');
    const det = this._detail(D, r.from, r.to);
    const top = topOf(det.items, 400);
    const best = (arr) => { let i = -1, v = 0; arr.forEach((x, j) => { if (x > v) { v = x; i = j; } }); return i; };
    const firstDay = Object.keys(D.days).sort()[0] || null;
    return {
      period, offset, from: r.from, to: r.to, label: r.label, firstDay,
      total: cur.tot, previous: before.tot, series: cur.series,
      films: this._named(D, top, 'movie', 8), shows: this._named(D, top, 'show', 8), channels: this._named(D, top, 'live', 8),
      genres: topOf(det.genres, 8).map(([g, s]) => ({ g, s: Math.round(s) })),
      hours: det.hours.map(Math.round), week: det.week.map(Math.round), bestHour: best(det.hours), bestDay: best(det.week),
      longest: this.longestStreak(D), current: this.currentStreak(D),
    };
  }

  longestStreak(D) {
    const keys = Object.keys(D.days).filter((k) => D.days[k].s >= 60).sort();
    let best = 0, run = 0, prev = null;
    for (const k of keys) {
      const t = new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)).getTime();
      run = prev !== null && dayKey(addDays(prev, 1)) === k ? run + 1 : 1;
      best = Math.max(best, run);
      prev = t;
    }
    return best;
  }
  currentStreak(D) {
    let n = 0;
    let t = startOfDay(Date.now());
    if (!(D.days[dayKey(t)] && D.days[dayKey(t)].s >= 60)) t = addDays(t, -1); // (today isn't over yet)
    while (D.days[dayKey(t)] && D.days[dayKey(t)].s >= 60 && n < 3000) { n++; t = addDays(t, -1); }
    return n;
  }

  /** The year in review: the big numbers and favourites of a calendar year. */
  review(pid, year) {
    const D = this.of(pid).data;
    const from = new Date(year, 0, 1).getTime(), to = new Date(year + 1, 0, 1).getTime();
    const cur = this._totals(D, from, to, true);
    const det = this._detail(D, from, to);
    const top = topOf(det.items, 400);
    const best = (arr) => { let i = -1, v = 0; arr.forEach((x, j) => { if (x > v) { v = x; i = j; } }); return i; };
    const months = cur.series;
    let bm = -1, bmv = 0;
    months.forEach((m, i) => { if (m.s > bmv) { bmv = m.s; bm = i; } });
    return {
      year, total: cur.tot, months: months.map((m) => m.s),
      films: this._named(D, top, 'movie', 5), shows: this._named(D, top, 'show', 5), channels: this._named(D, top, 'live', 5),
      genres: topOf(det.genres, 5).map(([g, s]) => ({ g, s: Math.round(s) })),
      bestMonth: bm, bestHour: best(det.hours), bestDay: best(det.week), hours: det.hours.map(Math.round), week: det.week.map(Math.round),
    };
  }

  /** Which years have anything to review (with the totals). */
  years(pid) {
    const D = this.of(pid).data;
    const out = {};
    for (const [k, m] of Object.entries(D.months)) { const y = +k.slice(0, 4); out[y] = (out[y] || 0) + (m.s || 0); }
    return out;
  }
}

module.exports = { Viewing, dayKey, monthKey };
