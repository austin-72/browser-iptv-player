'use strict';
/**
 * The DVR: live TV recorded by this server, from the TV guide ("Record", "Record every episode") or right away from
 * the player ("Record this"). Kept in dvr.json; the files go to the recordings folder (Admin → DVR).
 *
 * A recording starts a minute early and ends a couple of minutes late (the admin's padding), uses one connection to
 * the channel's provider while it runs (it shows as "Recording" among the people watching, and is never bumped by
 * someone else), copies the stream as it comes (no converting), and if the stream drops it carries on in a new piece
 * as soon as it's back. When it ends the pieces are joined and, when possible, turned into an MP4 so it plays in any
 * browser with instant seeking. Waiting for a free connection: it keeps trying until the programme is over.
 *
 * Who may record (Admin → DVR): everyone, only priority profiles (and admins), or nobody. Recordings already made stay
 * watchable by their profile either way; scheduled ones of a profile that may no longer record are skipped.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { JsonFile } = require('./store');
const { HttpError, log } = require('./util');

const MIN = 60e3;
const MAX_LEN = 12 * 3600e3;      // the longest one recording may be
const SCAN_EVERY = 5 * MIN;       // series rules look at the guide this often
const AHEAD = 3 * 86400e3;        // …this far ahead
const ACCESS = ['everyone', 'priority', 'off'];
const newId = () => crypto.randomBytes(9).toString('base64url');
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

const DEFAULTS = {
  config: { access: 'everyone', dir: '', maxGB: 0, keepDays: 0, watchedDays: 0, pre: 1, post: 2 },
  recs: [],   // { id, pid, k, ch, t, st, ep, d, s, e, pre, post, rule, state, at, started, ended, parts, file, size, drops, err, keep }
  rules: [],  // { id, pid, k, ch, t, at, keepN? (only the latest N episodes are kept; 0 or absent: all) }
};

class Dvr {
  /**
   * deps: {
   *   ffmpeg: () => ({ bin, available, netArgs(input, headers) }),
   *   source: (k) => ({ input, headers, list, name }) | null      the channel's stream (null: it's gone)
   *   programmes: (k, from, to) => [{ s, e, t, st, ep, d }]        its guide, in real time (shift applied)
   *   allowed: (pid) => bool                                       may this profile record? (uses the access setting)
   *   connFree: (k, recId) => bool                                 is a provider connection free for this channel?
   *   notify?: (pid, rec, what) => void
   *   watchedAt?: (pid, recId) => ms                               when its profile watched it to the end (0: not yet)
   * }
   */
  constructor(dataDir, deps, { tick = 10e3 } = {}) {
    this.dataDir = dataDir;
    this.deps = deps;
    this.store = new JsonFile(path.join(dataDir, 'dvr.json'), DEFAULTS);
    this.procs = new Map(); // rec id → { proc, part, stopping }
    this.lastScan = 0;
    this.now = () => Date.now();
    // Recordings that were running when the server stopped: carry on (if still on) or finish what's there.
    for (const r of this.store.data.recs) if (r.state === 'recording' || r.state === 'saving') r.state = 'resume';
    this._timer = setInterval(() => this.tick().catch((e) => log('DVR: ' + e.message)), tick);
    this._timer.unref();
  }

  get cfg() { return this.store.data.config; }
  get dir() { return this.cfg.dir || path.join(this.dataDir, 'recordings'); }
  /** A recording's own folder: where it started (so changing the setting mid-recording doesn't lose it). */
  dirOf(r) { return r.dir || this.dir; }
  save() { this.store.save(); }
  /** The server is stopping: end the recorders (what they wrote stays; they carry on in a new piece after the restart). */
  stop() { this.stopped = true; clearInterval(this._timer); for (const [, p] of this.procs) { try { p.proc.kill('SIGKILL'); } catch {} } this.procs.clear(); }

  setConfig(b) {
    const c = this.cfg;
    if (b.access !== undefined) { if (!ACCESS.includes(b.access)) throw new HttpError(400, 'Unknown setting'); c.access = b.access; }
    if (b.dir !== undefined) {
      const d = String(b.dir || '').trim();
      if (d && !path.isAbsolute(d)) throw new HttpError(400, 'The folder must be a full path on the server, like /media/recordings.');
      if (d) { try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); } catch (e) { throw new HttpError(400, `The server can’t write to ${d} (${e.code || e.message}).`); } }
      c.dir = d;
    }
    const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
    if (b.maxGB !== undefined) c.maxGB = num(b.maxGB, 0, 100000);
    if (b.keepDays !== undefined) c.keepDays = num(b.keepDays, 0, 3650);
    if (b.watchedDays !== undefined) c.watchedDays = num(b.watchedDays, 0, 365);
    if (b.pre !== undefined) c.pre = num(b.pre, 0, 30);
    if (b.post !== undefined) c.post = num(b.post, 0, 120);
    this.save();
    return c;
  }

  // ------------------------------------------------------------ scheduling
  find(id) { return this.store.data.recs.find((r) => r.id === id) || null; }
  of(pid) { return this.store.data.recs.filter((r) => r.pid === pid); }
  rulesOf(pid) { return this.store.data.rules.filter((r) => r.pid === pid); }
  /** The same programme already wanted by this profile (or being recorded for it). */
  _dupe(pid, k, s, { forRule = false } = {}) {
    return this.store.data.recs.find((r) => r.pid === pid && r.k === k && Math.abs(r.s - s) < MIN && r.state !== 'cancelled' && r.state !== 'failed' && (forRule || (r.state !== 'skipped' && !r.stoppedEarly))) || null;
  }

  /** p: { k, ch, s, e, t, st?, ep?, d? } → the recording (scheduled, or started straight away when it's on now). */
  add(pid, p, { rule = '' } = {}) {
    const now = this.now();
    const s = Number(p.s), e = Number(p.e);
    if (!(s > 0) || !(e > s)) throw new HttpError(400, 'When is it on?');
    if (e - s > MAX_LEN) throw new HttpError(400, 'A recording can be at most 12 hours.');
    if (e <= now) throw new HttpError(400, 'That has already ended.');
    const dup = this._dupe(pid, p.k, s, { forRule: !!rule });
    if (dup) return dup;
    // (Asking again for an episode that was skipped: record it after all.)
    const skipped = !rule && this.store.data.recs.find((r) => r.pid === pid && r.k === p.k && Math.abs(r.s - s) < MIN && r.state === 'skipped');
    if (skipped) { skipped.state = 'scheduled'; skipped.err = ''; this.save(); if (s - skipped.pre * MIN <= now) this.tick().catch(() => {}); return skipped; }
    const r = {
      id: newId(), pid, k: String(p.k), ch: String(p.ch || ''), t: String(p.t || 'Recording').slice(0, 200),
      st: p.st ? String(p.st).slice(0, 200) : '', ep: p.ep ? String(p.ep).slice(0, 40) : '', d: p.d ? String(p.d).slice(0, 400) : '',
      s, e, pre: this.cfg.pre, post: this.cfg.post, rule, state: 'scheduled', at: now, started: 0, ended: 0, parts: 0, file: '', size: 0, drops: 0, err: '', keep: false,
    };
    this.store.data.recs.push(r);
    this.save();
    if (s - r.pre * MIN <= now) this.tick().catch(() => {});
    return r;
  }

  /** "Record every episode": this title on this channel, whenever the guide has it. */
  addRule(pid, { k, ch, t }) {
    const title = String(t || '').trim().slice(0, 200);
    if (!title) throw new HttpError(400, 'Which programme?');
    let rule = this.store.data.rules.find((x) => x.pid === pid && x.k === k && norm(x.t) === norm(title));
    if (!rule) { rule = { id: newId(), pid, k: String(k), ch: String(ch || ''), t: title, at: this.now() }; this.store.data.rules.push(rule); this.save(); }
    this.scan(rule);
    return rule;
  }
  /** "Keep the latest N episodes" for a series rule (0: all of them). */
  setRule(pid, id, patch, admin) {
    const rule = this.store.data.rules.find((x) => x.id === id && (admin || x.pid === pid));
    if (!rule) throw new HttpError(404, 'Not found');
    if (patch && patch.keepN !== undefined) {
      const n = Math.max(0, Math.min(100, Math.round(Number(patch.keepN) || 0)));
      if (n) rule.keepN = n; else delete rule.keepN;
    }
    this.save();
    this._cleanup();
    return rule;
  }
  removeRule(pid, id, admin) {
    const rule = this.store.data.rules.find((x) => x.id === id && (admin || x.pid === pid));
    if (!rule) throw new HttpError(404, 'Not found');
    this.store.data.rules = this.store.data.rules.filter((x) => x !== rule);
    // Its upcoming recordings go too (ones made, or being made, stay).
    for (const r of this.store.data.recs) if (r.rule === id && r.state === 'scheduled') r.state = 'cancelled';
    this._prune();
    this.save();
  }

  /** Series rules: schedule their programmes in the guide (each episode once; a repeat of one already recorded is skipped). */
  scan(only) {
    const now = this.now();
    this.lastScan = now;
    for (const rule of only ? [only] : this.store.data.rules) {
      if (!this.deps.allowed(rule.pid)) continue;
      let progs = [];
      try { progs = this.deps.programmes(rule.k, now, now + AHEAD) || []; } catch {}
      const all = this.store.data.recs.filter((r) => r.rule === rule.id && r.state !== 'cancelled');
      const mine = all.filter((r) => r.state !== 'failed');
      const seen = new Set(mine.filter((r) => r.st || r.ep).map((r) => norm(r.st) + '|' + norm(r.ep)));
      for (const p of progs) {
        if (norm(p.t) !== norm(rule.t) || p.e <= now) continue;
        if (all.some((r) => Math.abs(r.s - p.s) < MIN)) continue; // (this airing: already scheduled, skipped, made or failed)
        const ident = p.st || p.ep ? norm(p.st) + '|' + norm(p.ep) : '';
        if (ident && seen.has(ident) && !this._dupe(rule.pid, rule.k, p.s)) continue;
        try { this.add(rule.pid, { k: rule.k, ch: rule.ch, s: p.s, e: p.e, t: p.t, st: p.st, ep: p.ep, d: p.d }, { rule: rule.id }); if (ident) seen.add(ident); } catch {}
      }
    }
  }

  /** Cancel (scheduled), stop and delete (recording), or delete (made). */
  remove(pid, id, admin) {
    const r = this.find(id);
    if (!r || (!admin && r.pid !== pid)) throw new HttpError(404, 'Not found');
    const p = this.procs.get(id);
    if (p) { p.stopping = 'delete'; this._kill(p); }
    this._deleteFiles(r);
    this._drop(r);
    this._prune();
    this.save();
  }
  /** Gone from the list. One episode of "every episode" that isn't over yet stays as "skipped" (hidden), so the
   *  rule doesn't schedule it again. */
  _drop(r) { r.state = r.rule && this.now() < this.endAt(r) && r.state !== 'done' ? 'skipped' : 'cancelled'; }
  /** Stop a recording now and keep what's there. */
  stopNow(pid, id, admin) {
    const r = this.find(id);
    if (!r || (!admin && r.pid !== pid)) throw new HttpError(404, 'Not found');
    // Waiting to carry on after the stream dropped: save what's there.
    if (r.state === 'waiting' && r.parts) { r.e = Math.min(r.e, this.now()); r.post = 0; r.stoppedEarly = true; r.state = 'saving'; this._finish(r); this.save(); return r; }
    if (r.state === 'scheduled' || r.state === 'waiting') { this._drop(r); this._prune(); this.save(); return r; }
    if (r.state !== 'recording') return r;
    r.e = Math.min(r.e, this.now()); r.post = 0; r.stoppedEarly = true;
    const p = this.procs.get(id);
    if (p) { p.stopping = 'stop'; this._kill(p); }
    this.save();
    return r;
  }
  setKeep(pid, id, keep, admin) {
    const r = this.find(id);
    if (!r || (!admin && r.pid !== pid)) throw new HttpError(404, 'Not found');
    r.keep = !!keep;
    this.save();
    return r;
  }
  _prune() {
    // Cancelled entries leave the list (after the tick that might still need them).
    this.store.data.recs = this.store.data.recs.filter((r) => r.state !== 'cancelled' || this.procs.has(r.id));
  }

  // ------------------------------------------------------------ the clock
  startAt(r) { return r.s - (r.pre || 0) * MIN; }
  endAt(r) { return r.e + (r.post || 0) * MIN; }

  async tick() {
    const now = this.now();
    let dirty = false;
    for (const r of this.store.data.recs) {
      if (r.state === 'resume') { dirty = true; if (now < this.endAt(r) && this.deps.allowed(r.pid)) { r.state = 'waiting'; } else { r.state = 'saving'; this._finish(r); continue; } }
      if (r.state === 'scheduled' || r.state === 'waiting') {
        if (now >= this.endAt(r)) {
          dirty = true;
          if (r.parts) { r.state = 'saving'; this._finish(r); } else { r.err = r.state === 'waiting' ? 'There was no free connection to the provider.' : r.err || 'It didn’t start (was the server off?).'; r.state = 'failed'; this._note(r, 'failed'); }
          continue;
        }
        if (now < this.startAt(r)) continue;
        if (r.state === 'waiting' && r.retry > now) continue; // (a stream that keeps dying: not before its wait is over)
        if (!this.deps.allowed(r.pid)) { dirty = true; this._cantGoOn(r, 'Recording is turned off for this profile (Admin → DVR).'); continue; }
        dirty = true;
        this._start(r);
      } else if (r.state === 'recording' && now >= this.endAt(r)) {
        const p = this.procs.get(r.id);
        if (p && !p.stopping) { p.stopping = 'stop'; this._kill(p); }
        else if (!p) { r.state = 'saving'; this._finish(r); }
      }
    }
    if (now - this.lastScan >= SCAN_EVERY) this.scan();
    if (dirty) this.save();
    this._cleanup();
  }

  // ------------------------------------------------------------ recording
  _part(r, n) { return path.join(this.dirOf(r), `${r.id}.${n}.ts`); }
  _start(r) {
    const ff = this.deps.ffmpeg();
    if (!ff || !ff.available) return this._cantGoOn(r, 'Recording needs ffmpeg on the server.');
    const src = this.deps.source(r.k);
    if (!src) return this._cantGoOn(r, 'That channel isn’t in the lists any more.');
    if (!this.deps.connFree(r.k, r.id)) { if (r.state !== 'waiting') log(`DVR: “${r.t}” is waiting for a free connection`); r.state = 'waiting'; r.err = 'Waiting for a free connection to the provider…'; return; }
    if (!r.dir) r.dir = this.dir;
    try { fs.mkdirSync(r.dir, { recursive: true }); } catch (e) { return this._cantGoOn(r, `Can’t write to the recordings folder (${e.code || e.message}).`); }
    const n = r.parts;
    r.parts++;
    const out = this._part(r, n);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...ff.netArgs(src.input, src.headers)];
    if (/^https?:/i.test(src.input)) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10', '-rw_timeout', '20000000');
    args.push('-fflags', '+genpts+discardcorrupt', '-i', src.input, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-f', 'mpegts', '-y', out);
    const proc = spawn(ff.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const p = { proc, part: n, stopping: '', errText: '', at: this.now() };
    proc.stderr.on('data', (d) => { p.errText = (p.errText + d).slice(-600); });
    this.procs.set(r.id, p);
    if (!r.started) r.started = this.now();
    r.state = 'recording'; r.err = '';
    if (n === 0) { log(`DVR: recording “${r.t}” (${r.ch || r.k})`); this._note(r, 'started'); }
    proc.on('error', (e) => { this.procs.delete(r.id); this._cantGoOn(r, 'The recorder couldn’t start: ' + e.message); this.save(); });
    proc.on('exit', () => {
      if (this.stopped) return; // (the server is stopping: it carries on after the restart)
      if (this.procs.get(r.id) === p) this.procs.delete(r.id); // (not a newer recorder started for it meanwhile)
      if (p.stopping === 'delete') { this._deleteFiles(r); return; }
      if (r.state === 'failed') return;
      if (!p.stopping && r.state === 'recording' && this.now() < this.endAt(r) - 2000) {
        // The stream dropped: carry on in a new piece (a few seconds later, or on the next tick).
        r.drops++;
        r.err = (p.errText.trim().split('\n').pop() || 'The stream stopped').slice(0, 200);
        r.state = 'waiting';
        // A stream that dies straight away again and again (gone at the provider): wait longer each time, up to a
        // minute, instead of asking the provider every few seconds.
        r.quick = this.now() - p.at < 15000 ? (r.quick || 0) + 1 : 0;
        const wait = Math.min(60000, 3000 * Math.pow(2, Math.max(0, r.quick - 1)));
        r.retry = this.now() + wait;
        this.save();
        setTimeout(() => { if (!this.stopped && r.state === 'waiting' && this.now() < this.endAt(r)) { this._start(r); this.save(); } }, wait).unref();
        return;
      }
      r.state = 'saving';
      this.save();
      this._finish(r);
    });
  }
  /** It can't (re)start: fail it, or, when part of it was already recorded, save that part. */
  _cantGoOn(r, err) {
    r.err = err;
    if (r.parts) { r.state = 'saving'; this._finish(r); } else { r.state = 'failed'; this._note(r, 'failed'); }
  }
  _kill(p) {
    try { p.proc.kill('SIGINT'); } catch {}
    setTimeout(() => { try { p.proc.kill('SIGKILL'); } catch {} }, 8000).unref();
  }

  /** Joins the pieces into one file, then makes it an MP4 when the streams allow (else it stays MPEG-TS). */
  async _finish(r) {
    // (Deleted while it was being saved: what was made so far goes too, and it isn't "done".)
    const gone = () => { if (r.state !== 'cancelled' && r.state !== 'skipped') return false; this._deleteFiles(r); return true; };
    let joining = false;
    try {
      const parts = [];
      for (let i = 0; i < Math.max(r.parts, 1); i++) { const f = this._part(r, i); try { if (fs.statSync(f).size > 0) parts.push(f); } catch {} }
      const ts = path.join(this.dirOf(r), `${r.id}.ts`);
      const there = (f) => { try { return fs.statSync(f).size > 1024; } catch { return false; } };
      if (!parts.length) {
        // (The server stopped while it was being saved: the pieces were already joined.)
        const mp4 = path.join(this.dirOf(r), `${r.id}.mp4`);
        if (!there(ts) && there(mp4)) { r.file = mp4; r.size = fs.statSync(mp4).size; r.ended = r.ended || this.now(); r.state = 'done'; this.save(); this._note(r, 'done'); return; }
        if (!there(ts)) { r.state = 'failed'; r.err = r.err || 'Nothing was recorded.'; this.save(); this._note(r, 'failed'); return; }
      } else if (parts.length === 1) fs.renameSync(parts[0], ts);
      else {
        // MPEG-TS pieces join by putting them one after the other.
        // (A write that fails, e.g. the disk is full, ends the saving with that error instead of leaving it stuck.)
        joining = true;
        const out = fs.createWriteStream(ts);
        const broke = new Promise((ok, no) => out.on('error', no));
        broke.catch(() => {});
        for (const f of parts) {
          const rs = fs.createReadStream(f);
          try { await Promise.race([broke, new Promise((ok, no) => { rs.on('error', no); rs.on('end', ok); rs.pipe(out, { end: false }); })]); } finally { rs.destroy(); }
        }
        await Promise.race([broke, new Promise((ok) => out.end(ok))]);
        joining = false;
        if (gone()) return;
        for (const f of parts) { try { fs.unlinkSync(f); } catch {} }
      }
      r.file = ts;
      const ff = this.deps.ffmpeg();
      if (ff && ff.available) {
        const mp4 = path.join(this.dirOf(r), `${r.id}.mp4`);
        const ok = await new Promise((done) => {
          const p = spawn(ff.bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-fflags', '+genpts', '-i', ts, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', '-y', mp4], { stdio: 'ignore' });
          p.on('error', () => done(false));
          p.on('exit', (code) => done(code === 0));
        });
        if (gone()) return;
        let good = false;
        try { good = ok && fs.statSync(mp4).size > 1024; } catch {}
        if (good) { try { fs.unlinkSync(ts); } catch {} r.file = mp4; } else { try { fs.unlinkSync(mp4); } catch {} }
      }
      try { r.size = fs.statSync(r.file).size; } catch { r.size = 0; }
      r.ended = this.now();
      r.state = 'done';
      log(`DVR: saved “${r.t}” (${(r.size / 1e9).toFixed(2)} GB${r.drops ? `, the stream dropped ${r.drops}×` : ''})`);
      this._note(r, 'done');
    } catch (e) {
      // (The half-joined file goes; the pieces stay.)
      if (joining) { try { fs.unlinkSync(path.join(this.dirOf(r), `${r.id}.ts`)); } catch {} }
      if (gone()) return;
      r.state = 'failed'; r.err = 'Couldn’t save it: ' + e.message;
    }
    this.save();
  }
  _deleteFiles(r) {
    const files = [r.file, path.join(this.dirOf(r), `${r.id}.ts`), path.join(this.dirOf(r), `${r.id}.mp4`)];
    for (let i = 0; i < Math.max(r.parts, 1); i++) files.push(this._part(r, i));
    for (const f of files) if (f) { try { fs.unlinkSync(f); } catch {} }
  }
  _note(r, what) { try { if (this.deps.notify) this.deps.notify(r.pid, r, what); } catch {} }

  /**
   * Old recordings go after the admin's number of days, watched ones that many days after they were watched, a series'
   * beyond the number of episodes its rule keeps, and the oldest first when they take more than the limit. One marked
   * "keep" is never deleted by any of these.
   */
  _cleanup() {
    const now = this.now();
    const c = this.cfg;
    let changed = false;
    const done = this.store.data.recs.filter((r) => r.state === 'done');
    const drop = (r) => { this._deleteFiles(r); r.state = 'cancelled'; changed = true; };
    if (c.watchedDays > 0 && this.deps.watchedAt) {
      for (const r of done) {
        if (r.keep || r.state !== 'done') continue;
        let w = 0;
        try { w = this.deps.watchedAt(r.pid, r.id) || 0; } catch {}
        if (w && now - w > c.watchedDays * 86400e3) drop(r);
      }
    }
    for (const rule of this.store.data.rules) {
      if (!(rule.keepN > 0)) continue;
      const mine = done.filter((r) => r.rule === rule.id && r.state === 'done' && !r.keep).sort((a, b) => (b.ended || b.e) - (a.ended || a.e));
      for (const r of mine.slice(rule.keepN)) drop(r);
    }
    if (c.keepDays > 0) for (const r of done) if (!r.keep && now - (r.ended || r.e) > c.keepDays * 86400e3) { this._deleteFiles(r); r.state = 'cancelled'; changed = true; }
    if (c.maxGB > 0) {
      let total = done.filter((r) => r.state === 'done').reduce((a, r) => a + (r.size || 0), 0);
      for (const r of done.filter((x) => x.state === 'done' && !x.keep).sort((a, b) => (a.ended || a.e) - (b.ended || b.e))) {
        if (total <= c.maxGB * 1e9) break;
        total -= r.size || 0; this._deleteFiles(r); r.state = 'cancelled'; changed = true;
      }
    }
    // Failed and missed ones are listed for a week.
    for (const r of this.store.data.recs) if (r.state === 'failed' && now - this.endAt(r) > 7 * 86400e3) { this._deleteFiles(r); r.state = 'cancelled'; changed = true; }
    for (const r of this.store.data.recs) if (r.state === 'skipped' && now > this.endAt(r)) { r.state = 'cancelled'; changed = true; }
    if (changed) { this._prune(); this.save(); }
  }

  // ------------------------------------------------------------ for the rest of the server
  /** Recordings running now, as "viewers" of their channel (they use a provider connection). */
  running() { return this.store.data.recs.filter((r) => r.state === 'recording'); }
  /** The file of a finished recording ({ path }), for playing it. */
  fileOf(id) {
    const r = this.find(id);
    if (!r || r.state !== 'done' || !r.file) return null;
    try { fs.accessSync(r.file); } catch { return null; }
    return { path: r.file };
  }
  usage() {
    const done = this.store.data.recs.filter((r) => r.state === 'done');
    let free = 0;
    try { const s = fs.statfsSync(fs.existsSync(this.dir) ? this.dir : this.dataDir); free = s.bavail * s.bsize; } catch {}
    return { count: done.length, bytes: done.reduce((a, r) => a + (r.size || 0), 0), free, dir: this.dir };
  }
  /** What a device sees of a recording. */
  view(r) {
    return { id: r.id, k: r.k, ch: r.ch, t: r.t, st: r.st, ep: r.ep, d: r.d, s: r.s, e: r.e, state: r.state, rule: r.rule || '', started: r.started, ended: r.ended, size: r.size, drops: r.drops, err: r.err, keep: !!r.keep, ext: r.file ? path.extname(r.file).slice(1) : '' };
  }
}

module.exports = { Dvr, ACCESS };
