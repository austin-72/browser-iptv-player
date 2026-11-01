'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JsonFile } = require('./store');
const { HttpError } = require('./util');

/**
 * The admin's own touches to the channel line-up, kept apart from the providers' lists so they survive every refresh:
 *  - per channel: a new name, logo, number, category, place in its category (sort key), hidden, which guide channel
 *    to use and a guide time offset;
 *  - per guide: a time offset (hours) for guides whose times are off;
 *  - placeholder listings on/off (channels with no guide data get hourly blocks in the guide);
 *  - parental locks: categories and channels that need the parental PIN.
 * Stored in data/channels.json. Only channels the admin changed have an entry, so it stays tiny however big the lists.
 */
const DEFAULT = { ch: {}, guideOffsets: {}, placeholders: true, locks: { groups: [], keys: [] }, pin: null };
const FIELDS = ['n', 'logo', 'num', 'g', 'so', 'hide', 'eo', 'off'];
const UNLOCK_MS = 30 * 60e3;
const PIN_RE = /^\d{4,8}$/;

const scrypt = (pw, salt) => crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32, { N: 16384 });

class Overrides {
  constructor(dir) {
    this.file = new JsonFile(path.join(dir, 'channels.json'), DEFAULT);
    this.logoDir = path.join(dir, 'logos');
    this.unlocked = new Map(); // session id → until (ms)
    this.fails = new Map(); // session id → { n, until }
    this._sets();
  }

  get d() { return this.file.data; }
  save() { this.file.save(); }

  _sets() {
    this.lockGroups = new Set((this.d.locks.groups || []).map((g) => String(g).toLowerCase()));
    this.lockKeys = new Set(this.d.locks.keys || []);
  }

  /** A short fingerprint of everything that changes what devices are sent (part of the catalogue cache key). */
  sig() { return crypto.createHash('md5').update(JSON.stringify([this.d.locks, this.d.placeholders])).digest('hex').slice(0, 8); }

  // ------------------------------------------------------------ channel overrides
  get(k) { return this.d.ch[k] || null; }

  /** Sets or clears fields on one channel. A field set to null / '' / false is removed; an empty entry is dropped. */
  set(k, patch, original) {
    const o = { ...(this.d.ch[k] || {}) };
    for (const f of FIELDS) {
      if (!(f in patch)) continue;
      let v = patch[f];
      if (f === 'num' || f === 'so') v = Number(v) > 0 ? Math.round(Number(v) * 1000) / 1000 : null;
      else if (f === 'off') v = Number(v) ? Math.max(-24, Math.min(24, Math.round(Number(v) * 2) / 2)) : null;
      else if (f === 'hide') v = !!v || null;
      else if (v !== null && v !== undefined) v = String(v).trim().slice(0, f === 'logo' ? 2000 : 200) || null;
      if (v === null || v === undefined || v === false) delete o[f]; else o[f] = v;
    }
    if (original) { o.n0 = original.n0 || o.n0; o.t = original.t || o.t; if (original.g0) o.g0 = original.g0; }
    const any = FIELDS.some((f) => f in o);
    if (any) { o.at = Date.now(); this.d.ch[k] = o; } else delete this.d.ch[k];
    this.save();
    return any ? o : null;
  }

  reset(k) { const had = !!this.d.ch[k]; delete this.d.ch[k]; if (had) this.save(); return had; }

  /** Applies an override to a catalogue item (keeping its own values to go back to). */
  static applyTo(it, o) {
    if (!it._o) it._o = { n: it.n, logo: it.logo, num: it.num, g: it.g };
    const b = it._o;
    it.n = o.n || b.n;
    it.logo = o.logo || b.logo;
    it.num = o.num || b.num;
    it.g = o.g || b.g;
    if (o.so) it.so = o.so; else delete it.so;
    if (o.eo) it.eo = o.eo; else delete it.eo;
    if (o.off) it.eoff = o.off; else delete it.eoff;
  }

  static restore(it) {
    if (!it._o) return;
    Object.assign(it, it._o);
    delete it._o; delete it.so; delete it.eo; delete it.eoff;
  }

  /**
   * During a catalogue build: moves overrides of renamed channels to their new keys, applies the rest and leaves out
   * hidden channels. `renamed`: old key → new key. Returns the items to keep.
   */
  apply(items, renamed) {
    const ch = this.d.ch;
    const keys = Object.keys(ch);
    if (!keys.length) return items;
    let dirty = false;
    if (renamed && renamed.size) {
      for (const k of keys) {
        const to = renamed.get(k);
        if (to && !ch[to]) { ch[to] = ch[k]; delete ch[k]; dirty = true; }
      }
    }
    const out = [];
    for (const it of items) {
      const o = (it.t === 'live' || it.t === 'radio') ? ch[it.k] : null;
      if (o) {
        if (!o.n0 || o.n0 !== (it._o ? it._o.n : it.n)) { o.n0 = it._o ? it._o.n : it.n; o.t = it.t; o.g0 = it._o ? it._o.g : it.g; dirty = true; }
        if (o.hide) continue;
        Overrides.applyTo(it, o);
      }
      out.push(it);
    }
    if (dirty) this.save();
    return out;
  }

  // ------------------------------------------------------------ guides
  guideOffset(gid) { return Number(this.d.guideOffsets[gid]) || 0; }
  setGuideOffset(gid, hours) {
    const h = Math.max(-24, Math.min(24, Math.round((Number(hours) || 0) * 2) / 2));
    if (h) this.d.guideOffsets[gid] = h; else delete this.d.guideOffsets[gid];
    this.save();
    return h;
  }
  get placeholders() { return this.d.placeholders !== false; }
  setPlaceholders(on) { this.d.placeholders = !!on; this.save(); }

  // ------------------------------------------------------------ parental locks
  /** Is this item behind the parental PIN? (Episodes follow their series.) */
  isLocked(it, get) {
    if (!it || (!this.lockKeys.size && !this.lockGroups.size)) return false;
    if (this.lockKeys.has(it.k)) return true;
    if (this.lockGroups.size && (this.lockGroups.has(String(it.g).toLowerCase()) || (it.rg && this.lockGroups.has(String(it.rg).toLowerCase())))) return true;
    if (it.sk && get) { const show = get(it.sk); if (show && show !== it) return this.isLocked(show); }
    return false;
  }
  get hasLocks() { return this.lockKeys.size + this.lockGroups.size > 0; }

  setLocks({ groups, keys }) {
    if (Array.isArray(groups)) this.d.locks.groups = [...new Set(groups.map((g) => String(g).trim()).filter(Boolean))].slice(0, 2000);
    if (Array.isArray(keys)) this.d.locks.keys = [...new Set(keys.map(String).filter(Boolean))].slice(0, 20000);
    this._sets();
    this.save();
  }
  lock(kind, value, on) {
    const list = kind === 'group' ? this.d.locks.groups : this.d.locks.keys;
    const lc = String(value).toLowerCase();
    const i = list.findIndex((x) => (kind === 'group' ? String(x).toLowerCase() === lc : x === value));
    if (on && i < 0) list.push(String(value));
    if (!on && i >= 0) list.splice(i, 1);
    this._sets();
    this.save();
  }

  get hasPin() { return !!(this.d.pin && this.d.pin.hash); }
  setPin(pin) {
    if (pin === '' || pin === null) { this.d.pin = null; this.save(); return; }
    if (!PIN_RE.test(String(pin))) throw new HttpError(400, 'The parental PIN is 4 to 8 digits.');
    const salt = crypto.randomBytes(16).toString('hex');
    this.d.pin = { salt, hash: scrypt(pin, salt).toString('hex') };
    this.unlocked.clear();
    this.save();
  }

  /** Unlocks locked channels on one device for 30 minutes. Kids profiles can't; 5 wrong PINs → 5 minutes' wait. */
  unlock(sessId, profile, pin) {
    if (profile && profile.kids) throw new HttpError(403, 'Kids profiles can’t unlock locked channels.');
    if (!this.hasPin) throw new HttpError(409, 'No parental PIN has been set yet (Admin → Channels).');
    const f = this.fails.get(sessId);
    if (f && f.until > Date.now()) throw new HttpError(429, `Too many wrong PINs. Try again in ${Math.ceil((f.until - Date.now()) / 60e3)} min.`);
    const want = Buffer.from(this.d.pin.hash, 'hex');
    const got = scrypt(String(pin || ''), this.d.pin.salt);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      const n = (f && !(f.until && f.until <= Date.now()) ? f.n : 0) + 1; // (a lockout that has run out starts again)
      this.fails.set(sessId, { n, until: n >= 5 ? Date.now() + 5 * 60e3 : 0 });
      throw new HttpError(403, 'That PIN isn’t right.');
    }
    this.fails.delete(sessId);
    const until = Date.now() + UNLOCK_MS;
    this.unlocked.set(sessId, until);
    if (this.unlocked.size > 500) for (const [k, t] of this.unlocked) if (t < Date.now()) this.unlocked.delete(k);
    return until;
  }
  relock(sessId) { this.unlocked.delete(sessId); }
  unlockedUntil(sessId) { const t = this.unlocked.get(sessId) || 0; return t > Date.now() ? t : 0; }
  /** May this request see locked things? (Only a device that entered the parental PIN in the last 30 minutes; never a kids profile.) */
  allowed(ctx) {
    if (!ctx || !ctx.profile) return false;
    if (ctx.profile.kids) return false;
    return !!(ctx.sess && this.unlockedUntil(ctx.sess.id));
  }

  // ------------------------------------------------------------ uploaded logos
  saveLogo(dataUrl) {
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) throw new HttpError(400, 'Send the logo as a PNG, JPEG or WebP picture.');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 600e3) throw new HttpError(413, 'That picture is too big (600 KB at most).');
    fs.mkdirSync(this.logoDir, { recursive: true });
    const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    fs.writeFileSync(path.join(this.logoDir, name), buf);
    return name;
  }
  logoPath(name) {
    if (!/^[a-f0-9]{20}\.(png|jpg|webp)$/.test(name)) return null;
    const f = path.join(this.logoDir, name);
    return fs.existsSync(f) ? f : null;
  }
}

module.exports = { Overrides };
