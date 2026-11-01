'use strict';
/**
 * API keys for automations (Home Assistant, scripts): `Authorization: Bearer <key>`.
 * Only a hash of each key is kept; the key itself is shown once, when it's made.
 * Scopes: read (what's playing, devices, search, channels) · control (also play/pause/stop/zap/volume on devices)
 * · admin (also everything an admin key should, e.g. list refresh).
 */
const path = require('path');
const crypto = require('crypto');
const { JsonFile } = require('./store');
const { HttpError, uid } = require('./util');

const SCOPES = ['read', 'control', 'admin'];
const RANK = { read: 1, control: 2, admin: 3 };
const hash = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

class ApiKeys {
  constructor(dataDir) {
    this.store = new JsonFile(path.join(dataDir, 'apikeys.json'), { keys: [] });
    this.fails = new Map(); // ip → { n, until }
  }

  list() { return this.store.data.keys.map((k) => ({ id: k.id, name: k.name, scope: k.scope, profile: k.profile || '', hint: k.hint, created: k.created, lastUsed: k.lastUsed || 0 })); }

  /** → { id, key } — the key is only ever returned here. */
  create({ name, scope, profile }) {
    if (!SCOPES.includes(scope)) throw new HttpError(400, 'Pick what the key may do.');
    name = String(name || '').trim().slice(0, 60) || 'API key';
    const key = 'iptv_' + crypto.randomBytes(24).toString('base64url');
    const k = { id: uid(), name, scope, profile: profile ? String(profile) : '', hash: hash(key), hint: key.slice(0, 9) + '…' + key.slice(-4), created: Date.now(), lastUsed: 0 };
    this.store.data.keys.push(k);
    this.store.save();
    return { id: k.id, key };
  }

  revoke(id) {
    const before = this.store.data.keys.length;
    this.store.data.keys = this.store.data.keys.filter((k) => k.id !== id);
    if (this.store.data.keys.length === before) throw new HttpError(404, 'No such key');
    this.store.save();
  }

  /** The key behind an Authorization header, or null. Repeated wrong keys from one address are slowed down. */
  verify(header, ip = '') {
    const m = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
    if (!m) return null;
    const f = this.fails.get(ip);
    if (f && f.until > Date.now()) throw new HttpError(429, 'Too many wrong API keys — wait a minute.');
    const h = hash(m[1]);
    const hb = Buffer.from(h, 'hex');
    const k = this.store.data.keys.find((x) => { const b = Buffer.from(x.hash, 'hex'); return b.length === hb.length && crypto.timingSafeEqual(b, hb); });
    if (!k) {
      const n = (f ? f.n : 0) + 1;
      this.fails.set(ip, { n, until: n >= 10 ? Date.now() + 60e3 : 0 });
      if (this.fails.size > 1000) this.fails.clear();
      return null;
    }
    this.fails.delete(ip);
    if (Date.now() - (k.lastUsed || 0) > 60e3) { k.lastUsed = Date.now(); this.store.save(); }
    return k;
  }

  static allows(key, need) { return !!key && (RANK[key.scope] || 0) >= (RANK[need] || 99); }
}

module.exports = { ApiKeys, SCOPES };
