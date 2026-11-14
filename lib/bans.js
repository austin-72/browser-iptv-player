'use strict';
// Addresses the admin has put off the server for a while (Admin → Overview → watching now → Remove): every request
// from one is turned away until its time is up — the page says so, and why when the admin gave a reason.
const path = require('path');
const net = require('net');
const { JsonFile } = require('./store');
const { uid, HttpError } = require('./util');

/** The same address written two ways (::ffff:192.168.1.5 and 192.168.1.5) is one address. */
const norm = (ip) => String(ip || '').trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
/** This machine itself — what every visitor looks like behind a proxy that isn't trusted (TRUST_PROXY). */
const loopback = (ip) => { const a = norm(ip); return a === '::1' || a === 'localhost' || /^127\./.test(a); };

class Bans {
  constructor(dataDir) {
    this.store = new JsonFile(path.join(dataDir, 'bans.json'), { list: [] });
    this.d = this.store.data;
    if (!Array.isArray(this.d.list)) this.d.list = [];
  }

  /** The bans still running, soonest to end first (those for good last). Ended ones are forgotten. */
  list() {
    const now = Date.now();
    const before = this.d.list.length;
    this.d.list = this.d.list.filter((b) => !b.until || b.until > now);
    if (this.d.list.length !== before) this.store.save();
    return this.d.list.slice().sort((a, b) => (a.until || Infinity) - (b.until || Infinity));
  }

  /** The ban an address is under right now, or null. (Called for every request: no saving, no sorting.) */
  of(ip) {
    if (!this.d.list.length) return null;
    const a = norm(ip), now = Date.now();
    for (const b of this.d.list) if (b.ip === a && (!b.until || b.until > now)) return b;
    return null;
  }

  /**
   * Puts an address off the server. minutes: how long (0 = until lifted). An address already banned gets the new
   * time and reason. → the ban.
   */
  add({ ip, minutes, reason, who, device, by }) {
    const a = norm(ip);
    if (!a || !net.isIP(a)) throw new HttpError(400, 'There’s no address to ban for this device.');
    if (loopback(a)) throw new HttpError(400, 'Every device reaches this server through this computer’s own address (127.0.0.1), so banning it would shut everyone out. If the server is behind a reverse proxy, set TRUST_PROXY so it sees each viewer’s own address.');
    const m = Math.max(0, Math.min(5256000, Math.round(Number(minutes) || 0))); // (at most ten years: else "until lifted")
    const now = Date.now();
    this.d.list = this.d.list.filter((b) => b.ip !== a);
    const b = { id: uid(), ip: a, at: now, until: m ? now + m * 60e3 : 0, reason: String(reason || '').trim().slice(0, 200), who: String(who || '').slice(0, 60), device: String(device || '').slice(0, 60), by: String(by || '').slice(0, 60) };
    this.d.list.push(b);
    this.store.save();
    return b;
  }

  /** Lets an address back in. → whether there was such a ban. */
  lift(id) {
    const n = this.d.list.length;
    this.d.list = this.d.list.filter((b) => b.id !== id);
    if (this.d.list.length === n) return false;
    this.store.save();
    return true;
  }
}

module.exports = { Bans, norm, loopback };
