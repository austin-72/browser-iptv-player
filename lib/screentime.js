'use strict';
/**
 * Screen time for profiles (Admin → Profiles): a daily limit per day of the week, the hours watching is allowed
 * (from the morning until bedtime), extra time for today, and "ask for more time" requests.
 *
 * Time is counted by the server, a minute at a time, from what the household's devices are doing (see
 * lib/routes-p11.js): a profile watching on two devices, in a watch party or in multiview counts once per minute.
 * Days and hours are the server's time zone, or the profile's own one when the admin sets it.
 *
 * Data: screentime.json — { rules: { pid: rule }, usage: { pid: { day, min, extra, until, last } },
 *                           history: { pid: { 'YYYY-MM-DD': minutes } }, requests: [ … ] }
 */
const path = require('path');
const { JsonFile } = require('./store');
const { HttpError, uid } = require('./util');

const DEFAULT_MORNING = '06:00'; // when bedtime ends if the admin only set a bedtime
const KEEP_DAYS = 14;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}
function serverTz() {
  const env = process.env.TZ;
  if (env && validTz(env)) return env;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
const fmts = new Map();
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** Wall-clock time in a time zone: { date: 'YYYY-MM-DD', dow: 0 (Sunday)–6, min: minutes since midnight, sec }. */
function localParts(t, tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23' });
    if (fmts.size > 50) fmts.clear();
    fmts.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(t))) o[p.type] = p.value;
  const h = Number(o.hour) % 24;
  return { date: `${o.year}-${o.month}-${o.day}`, dow: WD[o.weekday], min: h * 60 + Number(o.minute), sec: Number(o.second) };
}
const toMin = (s) => { const m = TIME_RE.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** One day's rule: { limit: minutes or null (no daily limit), from: 'HH:MM' or '', to (bedtime): 'HH:MM' or '' }. */
function cleanDay(d) {
  d = d && typeof d === 'object' ? d : {};
  const lim = d.limit === null || d.limit === undefined || d.limit === '' ? null : Math.round(Number(d.limit));
  return {
    limit: lim === null || !Number.isFinite(lim) ? null : Math.max(0, Math.min(24 * 60, lim)),
    from: TIME_RE.test(String(d.from || '')) ? String(d.from) : '',
    to: TIME_RE.test(String(d.to || '')) ? String(d.to) : '',
  };
}
/**
 * A profile's rule as the admin sends it: { on, mode: 'same'|'week'|'each', days: [7 day rules, Sunday first],
 * or same: day, school: day (Mon–Fri), weekend: day (Sat, Sun); tz: '' (the server's) or an IANA name }.
 */
function cleanRule(r) {
  r = r && typeof r === 'object' ? r : {};
  const mode = ['same', 'week', 'each'].includes(r.mode) ? r.mode : 'week';
  let days;
  if (mode === 'same' && r.same) days = Array.from({ length: 7 }, () => cleanDay(r.same));
  else if (mode === 'week' && (r.school || r.weekend)) days = Array.from({ length: 7 }, (_, i) => cleanDay(i === 0 || i === 6 ? r.weekend : r.school));
  else days = Array.from({ length: 7 }, (_, i) => cleanDay(Array.isArray(r.days) ? r.days[i] : null));
  const tz = r.tz && validTz(String(r.tz)) ? String(r.tz) : '';
  if (r.tz && !tz) throw new HttpError(400, `“${String(r.tz).slice(0, 60)}” isn’t a time zone this server knows (try one like Europe/London).`);
  return { on: r.on !== false, mode, days, tz };
}

/** Where `min` is against a day's hours: { inside, untilEnd (minutes), untilStart (minutes), early }. */
function hoursAt(day, min) {
  let from = toMin(day.from), to = toMin(day.to);
  if (from === null && to === null) return null; // no hours set
  if (from === null) from = toMin(DEFAULT_MORNING);
  if (to === null) to = 24 * 60; // from a time in the morning until midnight
  if (from === to) return null;
  const inside = from < to ? min >= from && min < to : min >= from || min < to;
  const untilEnd = inside ? (to === 24 * 60 ? 24 * 60 - min : (to - min + 1440) % 1440 || 1440) : 0;
  const untilStart = inside ? 0 : (from - min + 1440) % 1440;
  // Outside: nearer to bedtime (just gone) than to the morning start → "bedtime", otherwise "too early".
  const sinceEnd = to === 24 * 60 ? min : (min - to + 1440) % 1440;
  return { inside, untilEnd, untilStart, early: !inside && untilStart < sinceEnd };
}

class ScreenTime {
  /** now(): the clock (tests pass their own). tzDefault(): the server's time zone. */
  constructor(dataDir, { now = Date.now, tzDefault = serverTz } = {}) {
    this.store = new JsonFile(path.join(dataDir, 'screentime.json'), { rules: {}, usage: {}, history: {}, requests: [] }, { delay: 2000 });
    this.now = now;
    this.tzDefault = tzDefault;
  }

  get d() { return this.store.data; }
  tzOf(pid) { const r = this.d.rules[pid]; return (r && r.tz) || this.tzDefault(); }
  rule(pid) { const r = this.d.rules[pid]; return r && r.on ? r : null; }
  /** Profiles with a rule switched on. */
  limitedIds() { return Object.keys(this.d.rules).filter((id) => this.d.rules[id].on); }

  setRule(pid, rule) {
    if (rule === null) { delete this.d.rules[pid]; this.store.save(); return null; }
    this.d.rules[pid] = cleanRule(rule);
    this.store.save();
    return this.d.rules[pid];
  }
  forget(pid) {
    delete this.d.rules[pid]; delete this.d.usage[pid]; delete this.d.history[pid];
    this.d.requests = this.d.requests.filter((x) => x.pid !== pid);
    this.store.save();
  }

  /** Today's record for a profile (a new day starts afresh). */
  usage(pid, date) {
    let u = this.d.usage[pid];
    if (!u || u.day !== date) {
      u = this.d.usage[pid] = { day: date, min: 0, extra: 0, until: u ? u.until || 0 : 0, last: u ? u.last || 0 : 0 };
      this.store.save();
    }
    return u;
  }

  /**
   * How things stand for a profile right now:
   * { limited, used, allowance (null: no daily limit), left (minutes, null: no limit today), blocked, reason
   *   ('limit' | 'bedtime' | 'early'), nextAt (when watching is possible again, ms), bedtime, from, extra, tz, asked }
   */
  state(pid, t = this.now()) {
    const r = this.rule(pid);
    if (!r) return { limited: false };
    const tz = r.tz || this.tzDefault();
    const lp = localParts(t, tz);
    const day = r.days[lp.dow] || cleanDay(null);
    const u = this.usage(pid, lp.date);
    const allowance = day.limit === null ? null : day.limit + (u.extra || 0);
    const leftDaily = allowance === null ? Infinity : Math.max(0, allowance - u.min);
    const h = hoursAt(day, lp.min);
    let leftHours = !h ? Infinity : h.inside ? h.untilEnd - lp.sec / 60 : 0;
    if (u.until > t) leftHours = Math.max(leftHours, (u.until - t) / 60000);
    leftHours = leftHours === Infinity ? Infinity : Math.max(0, Math.ceil(leftHours - 1e-9));
    const left = Math.min(leftDaily, leftHours);
    const blocked = left <= 0;
    let reason = '';
    if (leftDaily <= 0) reason = 'limit';
    else if (leftHours <= 0) reason = h && h.early ? 'early' : 'bedtime';
    else if (left !== Infinity) reason = leftHours < leftDaily ? 'bedtime' : 'limit'; // what will stop it next
    let nextAt = 0;
    if (blocked) {
      if (reason === 'limit') {
        // Tomorrow, at the start of tomorrow's hours (or midnight).
        const tomorrow = r.days[(lp.dow + 1) % 7] || cleanDay(null);
        const startMin = tomorrow.from || tomorrow.to ? toMin(tomorrow.from || DEFAULT_MORNING) : 0;
        nextAt = t + ((1440 - lp.min + startMin) * 60 - lp.sec) * 1000;
      } else nextAt = t + (h.untilStart * 60 - lp.sec) * 1000;
    }
    const asked = this.d.requests.some((x) => x.pid === pid && x.status === 'pending' && x.day === lp.date);
    return {
      limited: true, used: u.min, allowance, left: left === Infinity ? null : left, blocked, reason, nextAt,
      bedtime: day.to || '', from: day.from || (day.to ? DEFAULT_MORNING : ''), extra: u.extra || 0, tz, asked, day: lp.date,
    };
  }

  /** Counts a minute for each profile in `watching` (a Set of profile ids) — once per profile per clock minute. */
  tick(watching, t = this.now()) {
    const counted = [];
    const minute = Math.floor(t / 60000);
    for (const pid of watching) {
      const r = this.rule(pid);
      if (!r) continue;
      const lp = localParts(t, r.tz || this.tzDefault());
      const u = this.usage(pid, lp.date);
      if (u.last === minute) continue;
      u.last = minute;
      u.min++;
      const h = this.d.history[pid] || (this.d.history[pid] = {});
      h[lp.date] = u.min;
      const days = Object.keys(h).sort();
      while (days.length > KEEP_DAYS) delete h[days.shift()];
      counted.push(pid);
    }
    if (counted.length) this.store.save();
    return counted;
  }

  /**
   * Extra time for today: adds to today's limit, and when it's (nearly) bedtime it also lets them watch that much
   * past bedtime (or from now, when bedtime has already passed).
   */
  grant(pid, minutes, t = this.now()) {
    minutes = Math.round(Number(minutes));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 12 * 60) throw new HttpError(400, 'Give between 1 minute and 12 hours.');
    const r = this.rule(pid);
    if (!r) throw new HttpError(400, 'This profile has no screen time limits.');
    const before = this.state(pid, t);
    const lp = localParts(t, r.tz || this.tzDefault());
    const u = this.usage(pid, lp.date);
    u.extra = (u.extra || 0) + minutes;
    const day = r.days[lp.dow];
    const h = hoursAt(day, lp.min);
    if (h) {
      // Past bedtime: from now. Before bedtime: past it, if bedtime would come before the extra time is used.
      const end = h.inside ? t + h.untilEnd * 60000 - lp.sec * 1000 : t;
      const base = Math.max(u.until > t ? u.until : 0, end);
      if (!h.inside || before.reason === 'bedtime' || u.until > t) u.until = base + minutes * 60000;
    }
    for (const x of this.d.requests) if (x.pid === pid && x.status === 'pending') { x.status = 'approved'; x.gave = minutes; x.doneAt = t; }
    this.store.save();
    return this.state(pid, t);
  }

  /** Back to the normal limits for today (extra time removed; the minutes watched stay counted). */
  resetToday(pid, { clearUsed = false } = {}, t = this.now()) {
    const r = this.rule(pid);
    if (!r) return { limited: false };
    const lp = localParts(t, r.tz || this.tzDefault());
    const u = this.usage(pid, lp.date);
    u.extra = 0; u.until = 0;
    if (clearUsed) { u.min = 0; const h = this.d.history[pid]; if (h) h[lp.date] = 0; }
    this.store.save();
    return this.state(pid, t);
  }

  /** "Ask for more time": one waiting request per profile. */
  ask(pid, minutes, note, t = this.now()) {
    const st = this.state(pid, t);
    if (!st.limited) throw new HttpError(400, 'There’s no limit to ask about.');
    minutes = [15, 30, 60].includes(Number(minutes)) ? Number(minutes) : 30;
    const old = this.d.requests.find((x) => x.pid === pid && x.status === 'pending');
    if (old) { old.minutes = minutes; old.note = String(note || '').slice(0, 200); old.at = t; old.day = st.day; this.store.save(); return old; }
    const req = { id: uid(), pid, minutes, note: String(note || '').slice(0, 200), at: t, day: st.day, status: 'pending' };
    this.d.requests.push(req);
    if (this.d.requests.length > 200) this.d.requests.splice(0, this.d.requests.length - 200);
    this.store.save();
    return req;
  }
  answer(id, ok, minutes, t = this.now()) {
    const req = this.d.requests.find((x) => x.id === id);
    if (!req) throw new HttpError(404, 'That request isn’t there any more.');
    if (req.status !== 'pending') return { req, state: this.state(req.pid, t) };
    if (!ok) { req.status = 'declined'; req.doneAt = t; this.store.save(); return { req, state: this.state(req.pid, t) }; }
    const state = this.grant(req.pid, minutes || req.minutes, t);
    return { req, state };
  }
  pending() { return this.d.requests.filter((x) => x.status === 'pending'); }

  /** For Admin → Profiles: the rule, today, and the last week. */
  adminView(pid, t = this.now()) {
    const r = this.d.rules[pid] || null;
    const h = this.d.history[pid] || {};
    return { rule: r, state: r && r.on ? this.state(pid, t) : { limited: false }, week: Object.keys(h).sort().slice(-7).map((d) => ({ day: d, min: h[d] })), requests: this.d.requests.filter((x) => x.pid === pid && x.status === 'pending') };
  }
}

module.exports = { ScreenTime, cleanRule, localParts, hoursAt, serverTz, validTz, hhmm };
