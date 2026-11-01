'use strict';
const crypto = require('crypto');
const path = require('path');
const { JsonFile } = require('./store');
const { HttpError, uid } = require('./util');

const COOKIE = 'iptv_sid';
const SESSION_DAYS = 180;
const MAX_FAILS = 6;
const PIN_FAILS = 5;
const PIN_RE = /^\d{4,8}$/;
const NAME_MAX = 24;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const scrypt = (pw, saltHex, n = 16384) => crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64, { N: n });
function makeHash(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: scrypt(secret, salt).toString('hex') };
}
function checkHash(rec, secret) {
  if (!rec || !rec.hash) return false;
  const want = Buffer.from(rec.hash, 'hex');
  const got = scrypt(secret, rec.salt);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function deviceName(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android') : /Tizen|SMART-TV|SmartTV|Web0S|webOS|BRAVIA|AFT|CrKey|GoogleTV|Android TV|HbbTV/i.test(ua) ? 'TV' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${br} on ${os}` : os;
}

/**
 * Site password + device sessions + profiles ("Who's watching?").
 * The first profile created is the only admin. Profiles can have a PIN; the admin's is required.
 */
class Accounts {
  constructor(dataDir, { defaultPassword }) {
    this.store = new JsonFile(path.join(dataDir, 'accounts.json'), { site: {}, profiles: [], sessions: {} });
    const d = this.store.data;
    if (!d.site.hash) { Object.assign(d.site, makeHash(defaultPassword), { isDefault: true, changedAt: Date.now(), preset: makeHash(defaultPassword) }); this.store.save(); }
    else this._presetChanged(defaultPassword);
    const now = Date.now();
    for (const [k, s] of Object.entries(d.sessions)) if (s.expires < now) delete d.sessions[k];
    this.fails = new Map();
    this.pinFails = new Map();
  }

  get d() { return this.store.data; }

  // ------------------------------------------------------------ site password & sessions
  login(password, ip, ua) {
    const f = this.fails.get(ip) || { count: 0, until: 0 };
    if (f.until > Date.now()) throw new HttpError(429, `Too many wrong tries. Wait ${Math.ceil((f.until - Date.now()) / 60000)} minute(s) and try again.`);
    if (!checkHash(this.d.site, password)) {
      f.count++;
      if (f.count >= MAX_FAILS) { f.until = Date.now() + Math.min(60, 5 * 2 ** (f.count - MAX_FAILS)) * 60e3; }
      this.fails.set(ip, f);
      throw new HttpError(401, 'That password isn’t right.');
    }
    this.fails.delete(ip);
    return this.newSession(ip, ua);
  }

  /** A signed-in device (after the password, or approved from another device). Returns its cookie token. */
  newSession(ip, ua, extra = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.d.sessions[sha(token)] = { id: uid(), created: Date.now(), seen: Date.now(), expires: Date.now() + SESSION_DAYS * 86400e3, ua: String(ua || '').slice(0, 300), ip, name: deviceName(ua), profileId: null, pinOk: {}, ...extra };
    this.store.save();
    return token;
  }
  sessionById(id) { return Object.values(this.d.sessions).find((s) => s.id === id) || null; }

  cookie(token, secure) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
  }
  clearCookie() { return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`; }

  token(req) {
    const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    return m ? m[1] : null;
  }

  /** The device session for a request, or null. */
  session(req) {
    const t = this.token(req);
    if (!t) return null;
    const s = this.d.sessions[sha(t)];
    if (!s || s.expires < Date.now()) return null;
    if (Date.now() - s.seen > 60e3) {
      s.seen = Date.now();
      s.expires = Date.now() + SESSION_DAYS * 86400e3;
      this.store.save();
    }
    s._key = sha(t);
    return s;
  }

  logout(req) { const t = this.token(req); if (t) { delete this.d.sessions[sha(t)]; this.store.save(); } }

  sessionsList() {
    return Object.values(this.d.sessions).map((s) => ({ id: s.id, name: s.name, created: s.created, seen: s.seen, ip: s.ip, profile: s.profileId }));
  }

  endSession(id) {
    for (const [k, s] of Object.entries(this.d.sessions)) if (s.id === id) delete this.d.sessions[k];
    this.store.save();
  }

  /**
   * The starting password in defaults.json / SITE_PASSWORD was edited since last time: use the new one (and sign
   * everyone out). A password the admin set in Admin → Security is kept unless the file is edited again later.
   */
  _presetChanged(pw) {
    const site = this.store.data.site;
    if (site.preset ? checkHash(site.preset, pw) : (!site.isDefault || checkHash(site, pw))) {
      if (!site.preset) { site.preset = makeHash(pw); this.store.save(); }
      return false;
    }
    Object.assign(site, makeHash(pw), { isDefault: true, changedAt: Date.now(), preset: makeHash(pw) });
    this.store.data.sessions = {};
    this.store.save();
    this.presetApplied = true;
    return true;
  }

  setSitePassword(pw, keepKey) {
    pw = String(pw || '');
    if (pw.length < 6) throw new HttpError(400, 'Use at least 6 characters.');
    Object.assign(this.d.site, makeHash(pw), { isDefault: false, changedAt: Date.now() });
    // Sign out every other device.
    for (const k of Object.keys(this.d.sessions)) if (k !== keepKey) delete this.d.sessions[k];
    this.store.save();
  }

  // ------------------------------------------------------------ profiles
  get profiles() { return this.d.profiles; }
  profile(id) { return this.profiles.find((p) => p.id === id) || null; }
  admin() { return this.profiles.find((p) => p.admin) || null; }

  summary(p) {
    return { id: p.id, name: p.name, avatar: p.avatar, admin: !!p.admin, kids: !!p.kids, hasPin: !!(p.pin && p.pin.hash), lastUsedAt: p.lastUsedAt || 0 };
  }

  /** Full profile for its owner / the admin (never the PIN hash). */
  view(p) {
    const { pin, ...rest } = p;
    return { ...rest, hasPin: !!(pin && pin.hash) };
  }

  create({ name, avatar, pin, kids, langs, interests }, sess, settings) {
    name = String(name || '').trim().slice(0, NAME_MAX);
    if (!name) throw new HttpError(400, 'Give the profile a name.');
    if (this.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, 'There’s already a profile with that name.');
    const first = this.profiles.length === 0;
    if (!first && settings && settings.adminOnlyProfiles) {
      const cur = sess && this.profile(sess.profileId);
      if (!cur || !cur.admin) throw new HttpError(403, 'Only the admin can add profiles.');
    }
    if (first && !PIN_RE.test(String(pin || ''))) throw new HttpError(400, 'The admin profile needs a PIN of 4 to 8 digits, so nobody else can open the admin settings.');
    if (pin && !PIN_RE.test(String(pin))) throw new HttpError(400, 'A PIN is 4 to 8 digits.');
    const p = {
      id: uid(), name, avatar: Math.max(0, parseInt(avatar, 10) || 0), admin: first, kids: !first && !!kids,
      pin: pin ? makeHash(pin) : null, langs: Array.isArray(langs) && langs.length ? langs.map(String) : null, unknownLang: null,
      interests: Array.isArray(interests) ? interests.slice(0, 20).map(String) : [],
      restrictions: kids ? { types: [], maxCert: 1, adult: false, blockedGroups: [] } : { types: [], maxCert: '', adult: false, blockedGroups: [] },
      createdAt: Date.now(),
    };
    this.profiles.push(p);
    this.store.save();
    return p;
  }

  /**
   * Changes to a profile. `byAdmin`: the admin may change everything (limits, kids, reset PIN);
   * a profile may change its own name, picture, languages and PIN (with the current PIN).
   */
  update(id, patch, { byAdmin, self }) {
    const p = this.profile(id);
    if (!p) throw new HttpError(404, 'Profile not found');
    if (!byAdmin && !self) throw new HttpError(403, 'You can only change your own profile.');
    if ('name' in patch) {
      const name = String(patch.name || '').trim().slice(0, NAME_MAX);
      if (!name) throw new HttpError(400, 'Give the profile a name.');
      if (this.profiles.some((x) => x !== p && x.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, 'There’s already a profile with that name.');
      p.name = name;
    }
    if ('avatar' in patch) p.avatar = Math.max(0, parseInt(patch.avatar, 10) || 0); // pictures; photos go through setAvatar
    if ('langs' in patch) p.langs = Array.isArray(patch.langs) ? patch.langs.map(String) : null;
    if ('unknownLang' in patch) p.unknownLang = typeof patch.unknownLang === 'boolean' ? patch.unknownLang : null;
    if ('interests' in patch && Array.isArray(patch.interests)) p.interests = patch.interests.slice(0, 20).map(String);
    if ('pin' in patch) {
      const next = patch.pin ? String(patch.pin) : '';
      if (p.pin && p.pin.hash && !byAdmin && !checkHash(p.pin, String(patch.currentPin || ''))) throw new HttpError(403, 'The current PIN isn’t right.');
      if (!next) {
        if (p.admin) throw new HttpError(400, 'The admin profile must keep a PIN.');
        p.pin = null;
      } else {
        if (!PIN_RE.test(next)) throw new HttpError(400, 'A PIN is 4 to 8 digits.');
        p.pin = makeHash(next);
      }
    }
    if (byAdmin) {
      if ('kids' in patch && !p.admin) p.kids = !!patch.kids;
      if (patch.restrictions && typeof patch.restrictions === 'object') {
        const r = patch.restrictions;
        p.restrictions = {
          types: Array.isArray(r.types) ? r.types.filter((t) => ['live', 'radio', 'movie', 'show'].includes(t)) : (p.restrictions || {}).types || [],
          maxCert: r.maxCert === '' || r.maxCert === null || r.maxCert === undefined ? '' : Math.max(0, Math.min(4, Number(r.maxCert))),
          adult: !!r.adult,
          blockedGroups: Array.isArray(r.blockedGroups) ? r.blockedGroups.map(String).slice(0, 500) : [],
        };
      }
    }
    this.store.save();
    return p;
  }

  remove(id) {
    const p = this.profile(id);
    if (!p) throw new HttpError(404, 'Profile not found');
    if (p.admin) throw new HttpError(400, 'Make another profile the admin before removing this one.');
    this.d.profiles = this.profiles.filter((x) => x.id !== id);
    for (const s of Object.values(this.d.sessions)) if (s.profileId === id) s.profileId = null;
    this.store.save();
  }

  transferAdmin(fromId, toId) {
    const a = this.profile(fromId), b = this.profile(toId);
    if (!a || !a.admin) throw new HttpError(403, 'Only the admin can do that.');
    if (!b) throw new HttpError(404, 'Profile not found');
    if (!b.pin || !b.pin.hash) throw new HttpError(400, `${b.name} needs a PIN before they can be the admin.`);
    a.admin = false;
    b.admin = true;
    b.kids = false;
    b.restrictions = { types: [], maxCert: '', adult: (b.restrictions || {}).adult || false, blockedGroups: [] };
    this.store.save();
  }

  /** Is the PIN for this profile still remembered on this device? (old records: a timestamp, 30 minutes) */
  pinRemembered(sess, id) {
    const v = sess && sess.pinOk && sess.pinOk[id];
    if (!v) return false;
    return typeof v === 'number' ? Date.now() - v < 30 * 60e3 : Date.now() < v.until;
  }

  /** The profile this device was last using, if it can be opened without asking for anything. */
  resumable(sess) {
    const p = sess && sess.profileId && this.profile(sess.profileId);
    if (!p) return null;
    return !(p.pin && p.pin.hash) || this.pinRemembered(sess, p.id) ? p : null;
  }

  /** An uploaded photo ("img:<id>:<version>"). */
  setAvatar(id, tag) {
    const p = this.profile(id);
    if (!p) throw new HttpError(404, 'Profile not found');
    p.avatar = tag;
    this.store.save();
  }

  /** Forget this device's PIN for a profile (Lock). */
  lock(sess, id) {
    if (sess.pinOk) delete sess.pinOk[id || sess.profileId];
    sess.profileId = null;
    this.store.save();
  }

  /**
   * Opens a profile on this device. PIN profiles need the PIN, which is then remembered on this device — for
   * 6 months with remember=true (the default), otherwise for 30 minutes.
   */
  select(sess, id, pin, remember = true) {
    const p = this.profile(id);
    if (!p) throw new HttpError(404, 'Profile not found');
    const needsPin = p.pin && p.pin.hash;
    const recent = this.pinRemembered(sess, id);
    if (needsPin && !(recent && pin === undefined)) {
      const f = this.pinFails.get(id) || { count: 0, until: 0 };
      if (f.until > Date.now()) throw new HttpError(429, `Too many wrong PINs. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} minute(s).`);
      if (!checkHash(p.pin, String(pin || ''))) {
        f.count++;
        if (f.count >= PIN_FAILS) { f.until = Date.now() + 5 * 60e3; f.count = 0; }
        this.pinFails.set(id, f);
        throw new HttpError(pin ? 403 : 401, pin ? 'Wrong PIN.' : 'PIN required');
      }
      this.pinFails.delete(id);
      sess.pinOk = { ...(sess.pinOk || {}), [id]: { at: Date.now(), until: Date.now() + (remember ? SESSION_DAYS * 86400e3 : 30 * 60e3) } };
    }
    sess.profileId = id;
    p.lastUsedAt = Date.now();
    this.store.save();
    return p;
  }

  checkPin(id, pin) {
    const p = this.profile(id);
    return !!(p && (!p.pin || checkHash(p.pin, String(pin || ''))));
  }

  pinRecord(id) { const p = this.profile(id); return p && p.pin ? { salt: p.pin.salt } : null; }
}

module.exports = { Accounts, deviceName, COOKIE };
