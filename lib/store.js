'use strict';
const fs = require('fs');
const path = require('path');

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);

function withDefaults(obj, defs) {
  for (const k of Object.keys(defs)) {
    if (obj[k] === undefined) obj[k] = structuredClone(defs[k]);
    else if (isPlain(obj[k]) && isPlain(defs[k])) withDefaults(obj[k], defs[k]);
  }
  return obj;
}

/**
 * A JSON file kept in memory and written back atomically (write temp file, then rename).
 * The previous version is kept as <file>.bak so a crash mid-write can never lose your lists.
 */
class JsonFile {
  /** delay: how long changes are gathered before writing (big files that change often use a longer one). */
  constructor(file, defaults = {}, { delay = 300, background = false } = {}) {
    this.file = file;
    this.defaults = defaults;
    this.delay = delay;
    // background: written without holding up the server (big files); on shutdown it's still written straight away.
    this.background = background;
    this._timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = this._load();
    JsonFile.all.add(this);
  }

  _load() {
    for (const f of [this.file, this.file + '.bak']) {
      try {
        return withDefaults(JSON.parse(fs.readFileSync(f, 'utf8')), this.defaults);
      } catch (e) {
        if (e.code !== 'ENOENT') {
          console.warn(`Could not read ${f}: ${e.message}`);
          try { fs.copyFileSync(f, `${f}.corrupt-${Date.now()}`); } catch {}
        }
      }
    }
    return structuredClone(this.defaults);
  }

  save() {
    if (JsonFile.frozen) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), this.delay);
  }

  flush(now) {
    clearTimeout(this._timer);
    this._timer = null;
    if (JsonFile.frozen) return;
    if (this.background && !now) return this._flushBg();
    const tmp = this.file + '.tmp';
    this._gen = (this._gen || 0) + 1; // (a background write still under way is older: it must not replace this one)
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      if (fs.existsSync(this.file)) {
        try { fs.copyFileSync(this.file, this.file + '.bak'); } catch {}
      }
      try {
        fs.renameSync(tmp, this.file);
      } catch (e) {
        // Windows / Docker Desktop folders sometimes refuse a rename for a moment (EPERM/EBUSY): write in place.
        fs.copyFileSync(tmp, this.file);
        try { fs.unlinkSync(tmp); } catch {}
      }
      this._fails = 0;
    } catch (e) {
      // Disk full or the folder is busy: keep the data in memory and try again shortly instead of crashing.
      this._fails = (this._fails || 0) + 1;
      if (this._fails === 1 || this._fails % 20 === 0) console.error(`Could not save ${path.basename(this.file)}: ${e.message} (will keep trying)`);
      if (!this._timer) this._timer = setTimeout(() => this.flush(), Math.min(60000, 2000 * this._fails));
    }
  }

  _flushBg() {
    if (this._bg) { this._again = true; return this._bg; }
    // (Its own temp file: a write straight away on shutdown used the same one while this was still writing to it,
    // and this then put its older copy in place of the newer one.)
    const tmp = this.file + '.tmp-bg';
    const text = JSON.stringify(this.data);
    const gen = this._gen = (this._gen || 0) + 1;
    this._bg = (async () => {
      try {
        await fs.promises.writeFile(tmp, text);
        if (gen !== this._gen) { await fs.promises.unlink(tmp).catch(() => {}); return; }
        await fs.promises.copyFile(this.file, this.file + '.bak').catch(() => {});
        if (gen !== this._gen) { await fs.promises.unlink(tmp).catch(() => {}); return; }
        try { await fs.promises.rename(tmp, this.file); } catch { await fs.promises.copyFile(tmp, this.file); await fs.promises.unlink(tmp).catch(() => {}); }
        this._fails = 0;
      } catch (e) {
        this._fails = (this._fails || 0) + 1;
        if (this._fails === 1 || this._fails % 20 === 0) console.error(`Could not save ${path.basename(this.file)}: ${e.message} (will keep trying)`);
        this._again = true;
      }
    })().finally(() => { this._bg = null; if (this._again) { this._again = false; this.save(); } });
    return this._bg;
  }

  replace(data) {
    this.data = withDefaults(data, this.defaults);
    this.flush();
  }

  /** Forget pending writes and stop writing (a backup was just restored over these files; a restart follows). */
  static discardAll() {
    JsonFile.frozen = true;
    // (A background write still under way stops too: it would put the old data back over the restored file.)
    for (const f of JsonFile.all) { clearTimeout(f._timer); f._timer = null; f._gen = (f._gen || 0) + 1; }
  }

  static flushAll() {
    if (JsonFile.frozen) return;
    for (const f of JsonFile.all) {
      if (f._timer || f._bg || f._again) {
        try { f.flush(true); } catch (e) { console.error('Save failed for', f.file, e.message); }
      }
    }
  }
}
JsonFile.all = new Set();

/**
 * A big map ({ m: { key: value } }) kept in many small files instead of one huge one: data/<name>/00.json … 3f.json.
 * Only the files whose keys changed are written, in the background (a 160 MB meta.json written in one go froze the
 * server for most of a minute on Docker Desktop for Windows). Use it like a JsonFile: change `data.m[key]` (setting or
 * deleting a key marks its file), then `save()`. A change inside a value (`data.m[k].at = 0`) needs `touch(k)`.
 * The old single file (`legacy`) is read once and moved into the folder.
 */
const SHARDS = 64;
const shardOf = (k) => { let h = 2166136261; const s = String(k); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % SHARDS; };
class ShardedJson {
  constructor(dir, { legacy = '', delay = 15000 } = {}) {
    this.dir = dir;
    this.delay = delay;
    this.dirty = new Set();
    this._timer = null;
    this._writing = null;
    fs.mkdirSync(dir, { recursive: true });
    const m = {};
    let found = false;
    for (let i = 0; i < SHARDS; i++) {
      const f = path.join(dir, `${i.toString(16).padStart(2, '0')}.json`);
      for (const ff of [f, f + '.bak']) {
        try { Object.assign(m, JSON.parse(fs.readFileSync(ff, 'utf8'))); found = true; break; } catch (e) {
          // (Kept aside like a JsonFile's: the next write of this piece would otherwise replace it for good.)
          if (e.code !== 'ENOENT') { console.warn(`Could not read ${ff}: ${e.message}`); try { fs.copyFileSync(ff, `${ff}.corrupt-${Date.now()}`); } catch {} }
        }
      }
    }
    // The old one-file store: read it once, write it out in pieces, and move it aside.
    if (!found && legacy) {
      for (const f of [legacy, legacy + '.bak']) {
        try {
          const old = JSON.parse(fs.readFileSync(f, 'utf8'));
          Object.assign(m, (old && old.m) || {});
          for (let i = 0; i < SHARDS; i++) this.dirty.add(i);
          break;
        } catch {}
      }
      if (this.dirty.size) {
        this._flushSync(m);
        for (const f of [legacy, legacy + '.bak']) { try { fs.renameSync(f, path.join(dir, 'old-' + path.basename(f))); } catch {} }
      }
    }
    const self = this;
    this.data = {
      m: new Proxy(m, {
        set(t, k, v) { t[k] = v; if (typeof k === 'string') self.dirty.add(shardOf(k)); return true; },
        deleteProperty(t, k) { if (k in t) { delete t[k]; if (typeof k === 'string') self.dirty.add(shardOf(k)); } return true; },
      }),
    };
    this._raw = m;
    ShardedJson.all.add(this);
  }
  touch(k) { this.dirty.add(shardOf(k)); this.save(); }
  save() {
    if (JsonFile.frozen || !this.dirty.size) return;
    clearTimeout(this._timer);
    // (Written at least every minute while changes keep coming, not only after a quiet moment.)
    const due = this._first || (this._first = Date.now());
    this._timer = setTimeout(() => this.flush(), Math.max(0, Math.min(this.delay, due + 60000 - Date.now())));
  }
  _groups(only) {
    const g = new Map([...only].map((i) => [i, {}]));
    for (const k of Object.keys(this._raw)) { const i = shardOf(k); const o = g.get(i); if (o) o[k] = this._raw[k]; }
    return g;
  }
  _file(i) { return path.join(this.dir, `${i.toString(16).padStart(2, '0')}.json`); }
  _flushSync(m) {
    this._gen = (this._gen || 0) + 1; // (a background write still under way stops: what it has left is older)
    const raw = this._raw; this._raw = m || raw;
    const only = new Set(this.dirty); this.dirty.clear();
    for (const [i, o] of this._groups(only)) {
      const f = this._file(i);
      try { fs.writeFileSync(f + '.tmp', JSON.stringify(o)); try { fs.renameSync(f + '.tmp', f); } catch { fs.copyFileSync(f + '.tmp', f); fs.unlinkSync(f + '.tmp'); } } catch (e) { this.dirty.add(i); console.error(`Could not save ${f}: ${e.message}`); }
    }
    if (!m) this._raw = raw;
  }
  /** Writes the changed pieces in the background, one at a time (letting requests through in between). */
  flush() {
    clearTimeout(this._timer); this._timer = null; this._first = 0;
    if (JsonFile.frozen || !this.dirty.size) return this._writing || Promise.resolve();
    if (this._writing) return this._writing.then(() => this.flush());
    const only = new Set(this.dirty); this.dirty.clear();
    // (The pieces being written are remembered: on shutdown they're written straight away too — they had left `dirty`,
    // so the ones not reached yet were lost. Own temp files, and stopping once that happened, as for a JsonFile.)
    this._inflight = only;
    const gen = this._gen = (this._gen || 0) + 1;
    this._writing = (async () => {
      const groups = this._groups(only);
      for (const [i, o] of groups) {
        if (gen !== this._gen || JsonFile.frozen) break; // (or a backup was restored over these files)
        const f = this._file(i), tmp = f + '.tmp-bg';
        try {
          await fs.promises.writeFile(tmp, JSON.stringify(o));
          if (gen !== this._gen || JsonFile.frozen) { await fs.promises.unlink(tmp).catch(() => {}); break; }
          try { await fs.promises.rename(tmp, f); } catch { await fs.promises.copyFile(tmp, f); await fs.promises.unlink(tmp).catch(() => {}); }
        } catch (e) { this.dirty.add(i); console.error(`Could not save ${f}: ${e.message} (will keep trying)`); }
        await new Promise((r) => setImmediate(r));
      }
    })().finally(() => { this._writing = null; this._inflight = null; if (this.dirty.size) this.save(); });
    return this._writing;
  }
  /** On shutdown: whatever is still pending, written now. */
  flushNow() {
    clearTimeout(this._timer); this._timer = null;
    if (this._inflight) for (const i of this._inflight) this.dirty.add(i);
    if (!JsonFile.frozen && this.dirty.size) this._flushSync();
  }
}
ShardedJson.all = new Set();
// (JsonFile.flushAll, used on shutdown and before backups, writes these too.)
const flushAll0 = JsonFile.flushAll;
JsonFile.flushAll = function () { flushAll0.call(JsonFile); if (!JsonFile.frozen) for (const s of ShardedJson.all) { try { s.flushNow(); } catch (e) { console.error('Save failed for', s.dir, e.message); } } };

module.exports = { JsonFile, ShardedJson, shardOf };
