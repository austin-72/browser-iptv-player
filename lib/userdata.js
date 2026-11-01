'use strict';
const fs = require('fs');
const path = require('path');
const { JsonFile } = require('./store');
const { HttpError, uid } = require('./util');

const DEFAULT = {
  progress: {}, // key -> { p: position s, d: duration s, w: watched, at: ms, sk: show key, n: name }
  history: [], // newest first: { k, at, s: seconds watched, t: type, sk }
  list: [], // My List (movies/shows), newest first
  favs: [], // favourite channels
  ratings: {}, // key -> 1 | -1
  bookmarks: [], // { id, k, t, note, at }
  hidden: [], // "not interested"
  reminders: [], // { k, s, e, t }
  searches: [],
  impressions: {}, // key -> times shown on the home screen without being opened
  home: { order: [], hidden: [], pinned: [] }, // rows
  prefs: {},
  days: {}, // 'YYYY-MM-DD' -> { s: seconds watched, movie, episode, live… } (Your week)
  newEps: {}, // show key -> { n: new episodes, at, eps: [keys] } (New episodes)
};

const PREFS = {
  theme: 'midnight', uiScale: 1, reduceMotion: false, tvMode: 'auto', autoplayNext: true, autoSkipIntro: false, autoSkipCredits: false,
  previews: true, audioLang: '', subLang: '', subsDefault: false,
  subStyle: { size: 100, color: '#ffffff', bg: 'rgba(0,0,0,0.6)', edge: 'shadow', font: 'sans', pos: 0 },
  quality: 'auto', dataSaver: false, volume: 1, muted: false, speed: 1, presence: true, historyPaused: false, autoDeleteWatched: false,
  subsMode: '', // '' (use subsDefault) | 'off' | 'always' | 'foreign' (only when the audio isn't in your language)
  stillWatching: true, newEpisodeAlerts: true, onboarded: false,
  skipBack: 10, skipFwd: 10, // seconds the skip buttons, keys, double-taps and the phone remote jump
  reminderAction: 'note', // 'note' | 'switch' (change to the channel after a 10 s countdown)
};

// Channel lists of your own (Live TV, guide): lists, favourites' order, start-up groups, guide colours.
Object.assign(PREFS, { chanLists: [], favOrder: [], liveStart: '__last', guideStart: '__last', guideColours: true });

const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Everything that belongs to one profile: progress, history, lists, bookmarks, ratings, settings. */
class UserData {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.files = new Map();
  }

  of(pid) {
    let f = this.files.get(pid);
    if (!f) { f = new JsonFile(path.join(this.dir, `${pid}.json`), DEFAULT); this.files.set(pid, f); }
    return f;
  }

  remove(pid) {
    this.files.delete(pid);
    for (const ext of ['.json', '.json.bak', '.recs.json']) { try { fs.unlinkSync(path.join(this.dir, pid + ext)); } catch {} }
  }

  prefs(pid) { return { ...PREFS, ...this.of(pid).data.prefs, subStyle: { ...PREFS.subStyle, ...(this.of(pid).data.prefs.subStyle || {}) } }; }

  setPrefs(pid, patch) {
    const f = this.of(pid);
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in PREFS)) continue;
      if (k === 'subStyle' && v && typeof v === 'object') f.data.prefs.subStyle = { ...PREFS.subStyle, ...(f.data.prefs.subStyle || {}), ...v };
      else f.data.prefs[k] = v;
    }
    f.save();
    return this.prefs(pid);
  }

  /** Saves where you are in a video. Counts as watched past ~92% (or within the last 3 minutes of a long one). */
  progress(pid, { k, p, d, sk, n, t }) {
    const f = this.of(pid);
    if (!k) throw new HttpError(400, 'key required');
    if (f.data.prefs.historyPaused) return null;
    const pos = Math.max(0, Number(p) || 0), dur = Math.max(0, Number(d) || 0);
    const watched = dur > 0 && (pos / dur > 0.92 || (dur > 1200 && dur - pos < 180));
    const prev = f.data.progress[k] || {};
    const rec = { p: watched ? 0 : pos, d: dur, w: watched || !!prev.w, at: Date.now() };
    if (sk) rec.sk = sk;
    if (n) rec.n = String(n).slice(0, 200);
    if (t) rec.t = t;
    f.data.progress[k] = rec;
    const keys = Object.keys(f.data.progress);
    if (keys.length > 5000) {
      keys.sort((a, b) => f.data.progress[a].at - f.data.progress[b].at);
      for (const x of keys.slice(0, keys.length - 5000)) delete f.data.progress[x];
    }
    f.save();
    return rec;
  }

  /** A play event for history and recommendations (seconds actually watched in this sitting). */
  played(pid, { k, s, t, sk, n }) {
    const f = this.of(pid);
    if (!k || f.data.prefs.historyPaused) return;
    const h = f.data.history;
    const last = h[0];
    if (last && last.k === k && Date.now() - last.at < 6 * 3600e3) { last.at = Date.now(); last.s = (last.s || 0) + (Number(s) || 0); } else h.unshift({ k, at: Date.now(), s: Number(s) || 0, t, sk, ...(n ? { n: String(n).slice(0, 200) } : {}) });
    if (h.length > 3000) h.length = 3000;
    // Time watched per day (Your week).
    const secs = Math.max(0, Math.min(4 * 3600, Number(s) || 0));
    if (secs) {
      const days = f.data.days || (f.data.days = {});
      const dk = dayKey();
      const d = days[dk] || (days[dk] = { s: 0 });
      d.s += secs;
      const kind = t === 'episode' || t === 'show' ? 'episode' : t === 'movie' ? 'movie' : t === 'live' || t === 'catchup' ? 'live' : 'other';
      d[kind] = (d[kind] || 0) + secs;
      const keys = Object.keys(days).sort();
      for (const old of keys.slice(0, Math.max(0, keys.length - 70))) delete days[old];
    }
    if (sk && f.data.newEps && f.data.newEps[sk]) { const ne = f.data.newEps[sk]; ne.eps = (ne.eps || []).filter((x) => x !== k); ne.n = ne.eps.length; if (!ne.n) delete f.data.newEps[sk]; }
    delete f.data.impressions[k];
    if (sk) delete f.data.impressions[sk];
    f.save();
  }

  toggle(pid, field, k, on) {
    const f = this.of(pid);
    const list = f.data[field];
    if (!Array.isArray(list)) throw new HttpError(400, 'Unknown list');
    const has = list.includes(k);
    const want = on === undefined ? !has : !!on;
    if (want && !has) list.unshift(k);
    if (!want && has) f.data[field] = list.filter((x) => x !== k);
    if (f.data[field].length > 5000) f.data[field].length = 5000;
    f.save();
    return want;
  }

  rate(pid, k, v) {
    const f = this.of(pid);
    if (!v) delete f.data.ratings[k]; else f.data.ratings[k] = v > 0 ? 1 : -1;
    f.save();
  }

  addBookmark(pid, { k, t, note, n }) {
    const f = this.of(pid);
    if (!k) throw new HttpError(400, 'key required');
    const b = { id: uid(), k, t: Math.max(0, Number(t) || 0), note: String(note || '').slice(0, 500), n: String(n || '').slice(0, 200), at: Date.now() };
    f.data.bookmarks.unshift(b);
    if (f.data.bookmarks.length > 2000) f.data.bookmarks.length = 2000;
    f.save();
    return b;
  }
  editBookmark(pid, id, note) {
    const f = this.of(pid);
    const b = f.data.bookmarks.find((x) => x.id === id);
    if (!b) throw new HttpError(404, 'Bookmark not found');
    b.note = String(note || '').slice(0, 500);
    f.save();
    return b;
  }
  removeBookmark(pid, id) {
    const f = this.of(pid);
    f.data.bookmarks = f.data.bookmarks.filter((x) => x.id !== id);
    f.save();
  }

  setReminders(pid, list) {
    const f = this.of(pid);
    f.data.reminders = (Array.isArray(list) ? list : []).filter((r) => r && r.k && r.s > Date.now() - 3600e3).slice(0, 200);
    f.save();
  }

  /** Add or remove one reminder (so devices with an older copy of the list can't wipe each other's). */
  reminder(pid, { add, remove }) {
    const f = this.of(pid);
    let list = f.data.reminders.filter((r) => r && r.k && r.e > Date.now());
    if (remove) list = list.filter((r) => !(r.k === remove.k && r.s === remove.s));
    if (add && add.k && !list.some((r) => r.k === add.k && r.s === add.s)) {
      list.push({ k: String(add.k), s: Number(add.s) || 0, e: Number(add.e) || 0, t: String(add.t || '').slice(0, 200) });
    }
    f.data.reminders = list.slice(-200);
    f.save();
    return f.data.reminders;
  }

  /** Forget one recent search (or all when q is empty). */
  removeSearch(pid, q) {
    const f = this.of(pid);
    f.data.searches = q ? f.data.searches.filter((x) => x !== q) : [];
    f.save();
  }

  addSearch(pid, q) {
    const f = this.of(pid);
    q = String(q || '').trim().slice(0, 80);
    if (!q || f.data.prefs.historyPaused) return;
    const lq = q.toLowerCase();
    f.data.searches = [q, ...f.data.searches.filter((x) => x.toLowerCase() !== lq && !lq.startsWith(x.toLowerCase()))].slice(0, 10);
    f.save();
  }

  impressions(pid, keys) {
    const f = this.of(pid);
    const imp = f.data.impressions;
    for (const k of (keys || []).slice(0, 200)) imp[k] = (imp[k] || 0) + 1;
    const all = Object.keys(imp);
    if (all.length > 4000) for (const k of all.slice(0, all.length - 4000)) delete imp[k];
    f.save();
  }

  setHome(pid, home) {
    const f = this.of(pid);
    const h = home || {};
    f.data.home = { order: (h.order || []).map(String).slice(0, 60), hidden: (h.hidden || []).map(String).slice(0, 60), pinned: (h.pinned || []).map(String).slice(0, 30) };
    f.save();
    return f.data.home;
  }

  /** progressOnly: just forget where you were (Remove from Continue Watching), keep the history. */
  clearHistory(pid, k, progressOnly = false) {
    const f = this.of(pid);
    if (k && progressOnly) { delete f.data.progress[k]; for (const [x, p] of Object.entries(f.data.progress)) if (p.sk === k) delete f.data.progress[x]; }
    else if (k) { f.data.history = f.data.history.filter((h) => h.k !== k && h.sk !== k); delete f.data.progress[k]; for (const [x, p] of Object.entries(f.data.progress)) if (p.sk === k) delete f.data.progress[x]; } else { f.data.history = []; f.data.progress = {}; f.data.searches = []; }
    f.save();
  }

  /**
   * Titles were renamed or merged in the catalogue (map: old key → new key): move everything saved under the old keys.
   * Returns how many things moved.
   */
  migrateKeys(pid, map) {
    if (!map || !map.size) return 0;
    const f = this.of(pid);
    const d = f.data;
    let n = 0;
    const to = (k) => { const v = k && map.get(k); if (v) { n++; return v; } return k; };
    const arr = (a) => { const out = []; for (const k of a || []) { const x = to(k); if (!out.includes(x)) out.push(x); } return out; };
    const obj = (o) => { const out = {}; for (const [k, v] of Object.entries(o || {})) { const x = to(k); if (!(x in out) || x === k) out[x] = v; } return out; };
    d.progress = obj(d.progress);
    for (const p of Object.values(d.progress)) if (p.sk) p.sk = to(p.sk);
    for (const h of d.history) { h.k = to(h.k); if (h.sk) h.sk = to(h.sk); }
    d.list = arr(d.list); d.favs = arr(d.favs); d.hidden = arr(d.hidden);
    d.ratings = obj(d.ratings); d.impressions = obj(d.impressions); d.newEps = obj(d.newEps);
    for (const b of d.bookmarks) b.k = to(b.k);
    for (const r of d.reminders) r.k = to(r.k);
    if (n) f.save();
    return n;
  }

  /** Time watched over the last `days` days, per day (oldest first). */
  week(pid, days = 7) {
    const d = this.of(pid).data.days || {};
    const out = [];
    for (let i = days - 1; i >= 0; i--) { const k = dayKey(Date.now() - i * 86400e3); out.push({ day: k, ...(d[k] || { s: 0 }) }); }
    return out;
  }

  /** New episodes arrived for a show this profile follows. */
  addNewEpisodes(pid, showKey, epKeys) {
    const f = this.of(pid);
    const ne = f.data.newEps || (f.data.newEps = {});
    const cur = ne[showKey] || { eps: [] };
    const eps = [...new Set([...(cur.eps || []), ...epKeys])].slice(-50);
    if (eps.length === (cur.eps || []).length) return false;
    ne[showKey] = { n: eps.length, at: Date.now(), eps };
    f.save();
    return true;
  }
  clearNewEpisodes(pid, showKey) {
    const f = this.of(pid);
    if (f.data.newEps && f.data.newEps[showKey]) { delete f.data.newEps[showKey]; f.save(); return true; }
    return false;
  }

  /** Everything the app needs at start-up for this profile. */
  snapshot(pid) {
    const d = this.of(pid).data;
    return {
      progress: d.progress, history: d.history.slice(0, 400), list: d.list, favs: d.favs, ratings: d.ratings, bookmarks: d.bookmarks.slice(0, 500),
      hidden: d.hidden, reminders: d.reminders, searches: d.searches, home: d.home, prefs: this.prefs(pid), newEps: d.newEps || {},
    };
  }
}

module.exports = { UserData, PREFS, dayKey };
