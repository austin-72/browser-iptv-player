'use strict';
const crypto = require('crypto');
const path = require('path');
const { JsonFile } = require('./store');
const { HttpError, uid, isGuestId } = require('./util');

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
  /**
   * defaultPassword: the starting password (SITE_PASSWORD, defaults.json), else "changeme" for installs made before
   * there was a setup page. setupIfNew: no starting password was given — a new install has none at all and opens the
   * setup page instead (the site password and the admin profile chosen there; site.setup until then).
   */
  constructor(dataDir, { defaultPassword, setupIfNew }) {
    this.store = new JsonFile(path.join(dataDir, 'accounts.json'), { site: {}, profiles: [], sessions: {} });
    const d = this.store.data;
    if (!d.site.hash && setupIfNew) {
      // (A password nobody knows, so the sign-in page can't be used until setup has chosen one.)
      Object.assign(d.site, makeHash(crypto.randomBytes(24).toString('base64url')), { isDefault: true, setup: true, changedAt: Date.now(), preset: makeHash(defaultPassword) });
      this.store.save();
    } else if (!d.site.hash) { Object.assign(d.site, makeHash(defaultPassword), { isDefault: true, changedAt: Date.now(), preset: makeHash(defaultPassword) }); this.store.save(); }
    else this._presetChanged(defaultPassword);
    const now = Date.now();
    for (const [k, s] of Object.entries(d.sessions)) if (s.expires < now) delete d.sessions[k];
    this.fails = new Map();
    this.pinFails = new Map();
    // Guests (Admin → Profiles → Guest): profiles that aren't kept — one for each device that opens one, in memory
    // only, gone when the guest leaves (or after a day unused, or when the server restarts). Not in `profiles`, so
    // nothing the household shares (what others watch, popular here, messages) includes them.
    this.guests = new Map();
    this.guestCfg = () => null; // ({ on, kids, maxCert, adult }: set by the server from its settings)
    this.onGuestEnd = null;
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
  /** The session a new cookie token stands for (straight after newSession). */
  sessionOf(token) { return this.d.sessions[sha(token)] || null; }

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
    // (Signed-in devices that expired are forgotten here rather than listed.)
    let gone = 0;
    for (const [k, s] of Object.entries(this.d.sessions)) if (s.expires < Date.now()) { delete this.d.sessions[k]; gone++; }
    if (gone) this.store.save();
    return Object.values(this.d.sessions).map((s) => ({ id: s.id, name: s.name, created: s.created, seen: s.seen, ip: s.ip, profile: s.profileId }));
  }

  /** Signs out every device not used for `days` days (except `keepId`). Returns how many. */
  endIdleSessions(days, keepId) {
    let n = 0;
    for (const [k, s] of Object.entries(this.d.sessions)) if (s.id !== keepId && Date.now() - s.seen > days * 86400e3) { delete this.d.sessions[k]; n++; }
    if (n) this.store.save();
    return n;
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
    delete site.setup; // (a password given in the settings: no setup page)
    this.store.data.sessions = {};
    this.store.save();
    this.presetApplied = true;
    return true;
  }

  setSitePassword(pw, keepKey) {
    pw = String(pw || '');
    if (pw.length < 6) throw new HttpError(400, 'Use at least 6 characters.');
    Object.assign(this.d.site, makeHash(pw), { isDefault: false, changedAt: Date.now() });
    delete this.d.site.setup;
    // Sign out every other device.
    for (const k of Object.keys(this.d.sessions)) if (k !== keepKey) delete this.d.sessions[k];
    this.store.save();
  }

  // ------------------------------------------------------------ profiles
  get profiles() { return this.d.profiles; }
  profile(id) { return this.profiles.find((p) => p.id === id) || this.guest(id); }
  /** One of the household's own profiles (not a guest). */
  realProfile(id) { return this.profiles.find((p) => p.id === id) || null; }

  // ------------------------------------------------------------ guests
  /** A guest's profile, while guests are allowed and it hasn't left. (After a restart, "Who's watching?" again.) */
  guest(id, make) {
    if (!isGuestId(id)) return null;
    const c = this.guestCfg();
    if (!c || !c.on) return null;
    let g = this.guests.get(id);
    if (!g && !make) return null;
    if (!g) { g = { id, name: 'Guest', avatar: 'guest', guest: true, admin: false, pin: null, langs: null, unknownLang: null, interests: [], createdAt: Date.now() }; this.guests.set(id, g); }
    // (The admin's choices for guests, as they are now.)
    g.kids = !!c.kids;
    const cert = c.maxCert === '' || c.maxCert === undefined || c.maxCert === null ? (c.kids ? 1 : '') : Number(c.maxCert);
    g.restrictions = { types: [], maxCert: cert, adult: !!c.adult && !c.kids, blockedGroups: [] }; // (adult: 18+ groups, never with kids only)
    g.seenAt = Date.now();
    return g;
  }
  /** "Who's watching?" → Guest: a new guest for this device (a guest from before on it is gone). */
  startGuest(sess) {
    const c = this.guestCfg();
    if (!c || !c.on) throw new HttpError(403, 'Guests aren’t allowed here.');
    if (sess.profileId && isGuestId(sess.profileId)) this.endGuest(sess.profileId);
    const id = 'guest-' + uid();
    sess.profileId = id;
    this.store.save();
    return this.guest(id, true);
  }
  /** A guest left: what it watched, liked and listed is forgotten. */
  endGuest(id) {
    if (!isGuestId(id)) return;
    this.guests.delete(id);
    if (this.onGuestEnd) { try { this.onGuestEnd(id); } catch {} }
  }
  /** Guests nobody used for a day (a device that was just closed): forgotten. */
  dropIdleGuests(ms = 86400e3) {
    let n = 0;
    for (const [id, g] of this.guests) if (Date.now() - (g.seenAt || 0) > ms) { this.endGuest(id); n++; }
    return n;
  }
  /** The Guest button on "Who's watching?" (when guests are allowed). */
  guestSummary() {
    const c = this.guestCfg();
    return c && c.on ? { id: 'guest', name: 'Guest', avatar: 'guest', guest: true, admin: false, kids: !!c.kids, priority: false, hasPin: false, lastUsedAt: 0 } : null;
  }
  admin() { return this.profiles.find((p) => p.admin) || null; }

  summary(p) {
    return { id: p.id, name: p.name, avatar: p.avatar, admin: !!p.admin, kids: !!p.kids, priority: !!p.priority, hasPin: !!(p.pin && p.pin.hash), lastUsedAt: p.lastUsedAt || 0 };
  }

  /** Full profile for its owner / the admin (never the PIN hash). */
  view(p) {
    const { pin, ...rest } = p;
    return { ...rest, hasPin: !!(pin && pin.hash) };
  }

  create(fields, sess, settings) {
    // (A body that isn't an object — `null`, a number — is treated as empty rather than crashing.)
    let { name, avatar, pin, kids, langs, interests } = fields && typeof fields === 'object' ? fields : {};
    name = String(name || '').trim().slice(0, NAME_MAX);
    if (!name) throw new HttpError(400, 'Give the profile a name.');
    if (this.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, 'There’s already a profile with that name.');
    const first = this.profiles.length === 0;
    // (Who may add one is the admin's choice — Admin → Profiles → "Only the admin can add profiles" — with a kids
    // profile in the house too; the page says what leaving it off means then.)
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
  update(id, patch, { byAdmin, self, sess }) {
    const p = this.realProfile(id);
    if (!p) throw new HttpError(404, 'Profile not found');
    if (!byAdmin && !self) throw new HttpError(403, 'You can only change your own profile.');
    if (!patch || typeof patch !== 'object') patch = {};
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
      // (Counts towards the same lockout as choosing the profile, so the current PIN can't be guessed here instead.)
      if (p.pin && p.pin.hash && !byAdmin && !this._pinTry(p, patch.currentPin, sess)) throw new HttpError(403, 'The current PIN isn’t right.');
      if (!next) {
        if (p.admin) throw new HttpError(400, 'The admin profile must keep a PIN.');
        if (p.manager) throw new HttpError(400, 'A manager’s profile must keep a PIN. Take the manager role away first.');
        p.pin = null;
      } else {
        if (!PIN_RE.test(next)) throw new HttpError(400, 'A PIN is 4 to 8 digits.');
        p.pin = makeHash(next);
        // A new PIN starts with no wrong guesses (an admin resetting a forgotten one unlocks it straight away).
        for (const k of [...this.pinFails.keys()]) if (k.startsWith(`${id}|`)) this.pinFails.delete(k);
        // Devices that remembered the old PIN must enter the new one (see pinCurrent) — except the one changing it.
        p.pinAt = Date.now();
        if (sess) {
          const old = sess.pinOk && sess.pinOk[id];
          const until = old && typeof old === 'object' && old.until > Date.now() ? old.until : Date.now() + SESSION_DAYS * 86400e3;
          sess.pinOk = { ...(sess.pinOk || {}), [id]: { at: p.pinAt, until } };
        }
      }
    }
    if (byAdmin) {
      if ('kids' in patch && !p.admin) p.kids = !!patch.kids;
      // A manager: a second grown-up who can fix channels, refresh lists, deal with error reports and answer
      // screen-time requests — and nothing else in Admin (which requests: MANAGER_API in server.js).
      if ('manager' in patch && !p.admin) {
        if (patch.manager && !(p.pin && p.pin.hash)) throw new HttpError(400, 'Give this profile a PIN first: a manager’s profile has to be locked.');
        p.manager = !!patch.manager;
      }
      if (p.kids || p.admin) p.manager = false; // (never a kids' profile; the admin already can)
      // Priority viewers get a provider connection first when there aren't enough for everyone.
      if ('priority' in patch) p.priority = !!patch.priority;
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
    const p = this.realProfile(id);
    if (!p) throw new HttpError(404, 'Profile not found');
    if (p.admin) throw new HttpError(400, 'Make another profile the admin before removing this one.');
    this.d.profiles = this.profiles.filter((x) => x.id !== id);
    for (const s of Object.values(this.d.sessions)) if (s.profileId === id) s.profileId = null;
    this.store.save();
  }

  transferAdmin(fromId, toId) {
    const a = this.realProfile(fromId), b = this.realProfile(toId);
    if (!a || !a.admin) throw new HttpError(403, 'Only the admin can do that.');
    if (!b) throw new HttpError(404, 'Profile not found');
    if (!b.pin || !b.pin.hash) throw new HttpError(400, `${b.name} needs a PIN before they can be the admin.`);
    a.admin = false;
    b.admin = true;
    b.kids = false;
    b.manager = false;
    b.restrictions = { types: [], maxCert: '', adult: (b.restrictions || {}).adult || false, blockedGroups: [] };
    this.store.save();
  }

  /** Is the PIN for this profile still remembered on this device? (old records: a timestamp, 30 minutes) */
  pinRemembered(sess, id) {
    const v = sess && sess.pinOk && sess.pinOk[id];
    if (!v) return false;
    if (!this.pinCurrent(sess, this.profile(id))) return false;
    return typeof v === 'number' ? Date.now() - v < 30 * 60e3 : Date.now() < v.until;
  }

  /**
   * Has this device entered the profile's PIN since it was last changed? A changed PIN (say, one a child found out)
   * has to be entered again on every other device that had the profile open or remembered.
   */
  pinCurrent(sess, p) {
    if (!p || !(p.pin && p.pin.hash) || !p.pinAt) return true;
    const v = sess && sess.pinOk && sess.pinOk[p.id];
    const at = typeof v === 'number' ? v : (v && v.at) || 0;
    return at >= p.pinAt;
  }

  /** Checks a PIN with one lockout for every place a PIN is typed. Returns whether it's right. */
  _pinTry(p, pin, sess) {
    // Wrong guesses lock the device that made them, so someone else trying your profile on their phone doesn't lock
    // you out on yours. Many wrong guesses across devices still lock the profile everywhere for a while.
    const devKey = `${p.id}|${(sess && sess.id) || ''}`, allKey = `${p.id}|*`;
    const dev = this.pinFails.get(devKey) || { count: 0, until: 0 };
    const all = this.pinFails.get(allKey) || { count: 0, until: 0 };
    const until = Math.max(dev.until, all.until);
    if (until > Date.now()) throw new HttpError(429, `Too many wrong PINs. Try again in ${Math.ceil((until - Date.now()) / 60000)} minute(s).`);
    if (checkHash(p.pin, String(pin || ''))) { this.pinFails.delete(devKey); this.pinFails.delete(allKey); return true; }
    // Only a PIN that was typed counts: the app first asks without one to see whether a PIN is needed, and tapping a
    // profile a few times mustn't lock its owner out.
    if (pin) {
      dev.count++;
      if (dev.count >= PIN_FAILS) { dev.until = Date.now() + 5 * 60e3; dev.count = 0; }
      all.count++;
      // (Twice as long each time, a day at most: 15 minutes every time left a 4-digit PIN open to a few days of patient guessing from fresh sign-ins.)
      if (all.count >= PIN_FAILS * 4) { all.locks = (all.locks || 0) + 1; all.until = Date.now() + Math.min(24 * 60, 15 * 2 ** (all.locks - 1)) * 60e3; all.count = 0; }
      this.pinFails.set(devKey, dev);
      this.pinFails.set(allKey, all);
    }
    return false;
  }

  /** The profile this device was last using, if it can be opened without asking for anything. */
  resumable(sess) {
    const p = sess && sess.profileId && this.profile(sess.profileId);
    if (!p) return null;
    return !(p.pin && p.pin.hash) || this.pinRemembered(sess, p.id) ? p : null;
  }

  /** An uploaded photo ("img:<id>:<version>"). */
  setAvatar(id, tag) {
    const p = this.realProfile(id);
    if (!p) throw new HttpError(404, 'Profile not found');
    p.avatar = tag;
    this.store.save();
  }

  /** Forget this device's PIN for a profile (Lock). */
  lock(sess, id) {
    if (isGuestId(sess.profileId)) this.endGuest(sess.profileId);
    if (sess.pinOk) delete sess.pinOk[id || sess.profileId];
    sess.profileId = null;
    this.store.save();
  }

  /**
   * Opens a profile on this device. PIN profiles need the PIN, which is then remembered on this device — for
   * 6 months with remember=true (the default), otherwise for 30 minutes.
   */
  select(sess, id, pin, remember = true) {
    if (id === 'guest' || isGuestId(id)) return this.startGuest(sess);
    const p = this.realProfile(id);
    if (!p) throw new HttpError(404, 'Profile not found');
    const needsPin = p.pin && p.pin.hash;
    const recent = this.pinRemembered(sess, id);
    if (needsPin && !(recent && pin === undefined)) {
      if (!this._pinTry(p, pin, sess)) throw new HttpError(pin ? 403 : 401, pin ? 'Wrong PIN.' : 'PIN required');
      sess.pinOk = { ...(sess.pinOk || {}), [id]: { at: Date.now(), until: Date.now() + (remember ? SESSION_DAYS * 86400e3 : 30 * 60e3) } };
    }
    sess.profileId = id;
    p.lastUsedAt = Date.now();
    this.store.save();
    return p;
  }

  checkPin(id, pin, sess) {
    const p = this.profile(id);
    return !!(p && (!(p.pin && p.pin.hash) || this._pinTry(p, pin, sess)));
  }

  pinRecord(id) { const p = this.profile(id); return p && p.pin ? { salt: p.pin.salt } : null; }
}

module.exports = { Accounts, deviceName, COOKIE };
