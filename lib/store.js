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
  constructor(file, defaults = {}, { delay = 300 } = {}) {
    this.file = file;
    this.defaults = defaults;
    this.delay = delay;
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

  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    if (JsonFile.frozen) return;
    const tmp = this.file + '.tmp';
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

  replace(data) {
    this.data = withDefaults(data, this.defaults);
    this.flush();
  }

  /** Forget pending writes and stop writing (a backup was just restored over these files; a restart follows). */
  static discardAll() {
    JsonFile.frozen = true;
    for (const f of JsonFile.all) { clearTimeout(f._timer); f._timer = null; }
  }

  static flushAll() {
    if (JsonFile.frozen) return;
    for (const f of JsonFile.all) {
      if (f._timer) {
        try { f.flush(); } catch (e) { console.error('Save failed for', f.file, e.message); }
      }
    }
  }
}
JsonFile.all = new Set();

module.exports = { JsonFile };
