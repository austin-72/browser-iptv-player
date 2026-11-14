'use strict';
// Removing a viewer (Admin → Overview → watching now → Remove): what they play stops, their address is turned away
// for as long as the admin chose — every device there — and it can be let back in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const { Bans, norm } = require('../lib/bans');

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the ban list: one address however it is written, an end, and never this machine itself', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bans-'));
  try {
    const b = new Bans(dir);
    assert.throws(() => b.add({ ip: '127.0.0.1', minutes: 5 }), /127\.0\.0\.1/);
    assert.throws(() => b.add({ ip: '::1', minutes: 5 }));
    assert.throws(() => b.add({ ip: '', minutes: 5 }));
    const x = b.add({ ip: '::ffff:203.0.113.9', minutes: 30, reason: ' Sharing ' });
    assert.strictEqual(x.ip, '203.0.113.9');
    assert.strictEqual(x.reason, 'Sharing');
    assert.ok(b.of('203.0.113.9') && b.of('::FFFF:203.0.113.9'), 'the same address written another way');
    assert.strictEqual(b.of('203.0.113.10'), null);
    assert.ok(x.until > Date.now() + 29 * 60e3 && x.until < Date.now() + 31 * 60e3);
    // Banned again: one entry, the new length.
    b.add({ ip: '203.0.113.9', minutes: 0 });
    assert.strictEqual(b.list().length, 1);
    assert.strictEqual(b.of('203.0.113.9').until, 0, 'until let back in');
    // Ended ones are forgotten.
    b.d.list.push({ id: 'old', ip: '203.0.113.11', until: Date.now() - 1000 });
    assert.strictEqual(b.of('203.0.113.11'), null);
    assert.strictEqual(b.list().length, 1);
    assert.ok(b.lift(b.list()[0].id));
    assert.strictEqual(b.of('203.0.113.9'), null);
    assert.strictEqual(norm('::ffff:10.0.0.2'), '10.0.0.2');
    b.store.flush(true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the admin removes a viewer: playback stops, the address is turned away for the time chosen, then let back in', { timeout: 90000 }, async () => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kick-'));
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test', TRUST_PROXY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const all = [];
  // One browser at an address of its own (as a proxy in front would say: TRUST_PROXY).
  const device = (ip) => {
    const d = { cookie: '', ip };
    all.push(d);
    d.req = async (method, p, body) => {
      const h = { 'X-App': '1', 'X-Forwarded-For': ip };
      if (d.cookie) h.Cookie = d.cookie;
      if (body !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
      const r = await fetch(base + p, { method, headers: h, body });
      const sc = r.headers.get('set-cookie');
      if (sc) d.cookie = sc.split(';')[0];
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { status: r.status, json: j, text: t, banned: r.headers.get('x-banned') };
    };
    d.events = (name) => new Promise((ok, fail) => {
      const r = d.evReq = http.get(`${base}/api/events?name=${encodeURIComponent(name)}&device=${encodeURIComponent(name)}`, { headers: { Cookie: d.cookie, 'X-Forwarded-For': ip } }, (res) => {
        const e = { text: '', ended: false, conn: null };
        res.on('data', (c) => { e.text += c; const m = /data: \{"conn":"([^"]+)"/.exec(e.text); if (m && !e.conn) { e.conn = m[1]; ok(e); } });
        res.on('end', () => { e.ended = true; });
        res.on('close', () => { e.ended = true; });
        if (res.statusCode !== 200) { res.resume(); fail(new Error(`events: ${res.statusCode}`)); }
      });
      r.on('error', fail);
    });
    return d;
  };
  const until = async (fn, ms = 3000) => { for (let i = 0; i < ms / 50 && !fn(); i++) await wait(50); return fn(); };
  try {
    for (let i = 0; i < 300 && !/Ready/.test(out); i++) await wait(100);
    assert.match(out, /Ready/, out);

    const admin = device('198.51.100.1');
    assert.strictEqual((await admin.req('POST', '/api/login', { password: 'pw-test' })).status, 200);
    assert.strictEqual((await admin.req('POST', '/api/profiles', { name: 'Admin', pin: '1234' })).status, 200);
    const sam = await admin.req('POST', '/api/profiles', { name: 'Sam' });
    // Sam watches on a TV; a phone at the same address has a profile open too; a laptop elsewhere as well.
    const open = async (ip, name) => {
      const d = device(ip);
      await d.req('POST', '/api/login', { password: 'pw-test' });
      assert.strictEqual((await d.req('POST', `/api/profiles/${sam.json.id}/select`, {})).status, 200);
      d.ev = await d.events(name);
      return d;
    };
    const tv = await open('203.0.113.7', 'Living room TV');
    const phone = await open('203.0.113.7', 'Phone');
    const laptop = await open('203.0.113.8', 'Laptop');
    assert.strictEqual((await tv.req('POST', '/api/presence', { conn: tv.ev.conn, playing: { k: 'x1', n: 'A film', pos: 10 } })).status, 200);

    // Only the admin may.
    assert.strictEqual((await laptop.req('POST', '/api/admin/kick', { conn: tv.ev.conn, minutes: 5 })).status, 403);

    // The admin sees the TV, its address, and who else is there.
    const w = await admin.req('GET', '/api/admin/watching');
    const row = w.json.rows.find((r) => r.conn === tv.ev.conn);
    assert.ok(row, 'the TV is watching');
    assert.strictEqual(row.ip, '203.0.113.7');
    assert.strictEqual(row.you, false);
    assert.strictEqual(row.local, false, 'not a home-network address');
    assert.deepStrictEqual(row.shared, ['Sam on Phone']);

    // Not a device at the admin's own address: that would shut the admin out too.
    const mine = await open('198.51.100.1', 'Admin’s other tablet');
    await mine.req('POST', '/api/presence', { conn: mine.ev.conn, playing: { k: 'x2', n: 'Another', pos: 0 } });
    const self = await admin.req('POST', '/api/admin/kick', { conn: mine.ev.conn, minutes: 5 });
    assert.strictEqual(self.status, 400);
    assert.match(self.json.error, /same address as you/);
    assert.strictEqual((await admin.req('GET', '/api/admin/watching')).json.rows.find((r) => r.conn === mine.ev.conn).you, true);

    // Removed for 2 hours, with a reason.
    const k = await admin.req('POST', '/api/admin/kick', { conn: tv.ev.conn, minutes: 120, reason: 'Sharing the password' });
    assert.strictEqual(k.status, 200, JSON.stringify(k.json));
    assert.strictEqual(k.json.devices, 2, 'the TV and the phone there');
    assert.ok(Math.abs(k.json.ban.until - (Date.now() + 120 * 60e3)) < 10e3);
    // Their pages are told, then their live connections end; the laptop's doesn't.
    assert.ok(await until(() => tv.ev.ended && phone.ev.ended), 'live connections at that address end');
    assert.match(tv.ev.text, /event: kicked\ndata: \{"until":\d+,"reason":"Sharing the password"\}/);
    assert.match(phone.ev.text, /event: kicked/);
    await wait(300);
    assert.strictEqual(laptop.ev.ended, false, 'another address carries on');

    // Every request from that address is turned away: the app's, and a page, which says why and until when.
    const me = await tv.req('GET', '/api/me');
    assert.strictEqual(me.status, 403);
    assert.strictEqual(me.banned, '1');
    assert.strictEqual(me.json.banned, true);
    assert.match(me.json.error, /removed from this server by the admin/);
    const page = await phone.req('GET', '/');
    assert.strictEqual(page.status, 403);
    assert.match(page.text, /You’ve been removed/);
    assert.match(page.text, /Sharing the password/);
    assert.match(page.text, /come back <b>at |come back <b>on /);
    assert.strictEqual((await device('203.0.113.7').req('POST', '/api/login', { password: 'pw-test' })).status, 403, 'not even signing in');
    assert.strictEqual((await laptop.req('GET', '/api/me')).status, 200);

    // The admin's list of who's removed, and letting them back in.
    const list = (await admin.req('GET', '/api/admin/bans')).json.bans;
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].who, 'Sam');
    assert.strictEqual(list[0].device, 'Living room TV');
    assert.match(list[0].when, /^(at|on) /);
    assert.strictEqual((await admin.req('GET', '/api/admin/watching')).json.bans.length, 1);
    assert.strictEqual((await admin.req('DELETE', `/api/admin/bans/${list[0].id}`)).status, 200);
    assert.strictEqual((await tv.req('GET', '/api/me')).status, 200, 'back in, still signed in');

    // Removed until let back in, and signed out: after being let in again, the site password is needed.
    tv.ev = await tv.events('Living room TV');
    await tv.req('POST', '/api/presence', { conn: tv.ev.conn, playing: { k: 'x1', n: 'A film', pos: 10 } });
    const k2 = await admin.req('POST', '/api/admin/kick', { conn: tv.ev.conn, minutes: 0, signOut: true });
    assert.strictEqual(k2.json.ban.until, 0);
    assert.strictEqual((await tv.req('GET', '/api/me')).json.until, 0);
    const p2 = await tv.req('GET', '/');
    assert.match(p2.text, /until they let you back in/);
    assert.strictEqual((await admin.req('DELETE', `/api/admin/bans/${k2.json.ban.id}`)).status, 200);
    assert.strictEqual((await admin.req('DELETE', `/api/admin/bans/${k2.json.ban.id}`)).status, 404, 'already ended');
    assert.strictEqual((await tv.req('GET', '/api/me')).status, 401, 'signed out');
    assert.strictEqual((await phone.req('GET', '/api/me')).status, 200, 'the phone there wasn’t signed out');

    // A device that's gone can't be removed.
    assert.strictEqual((await admin.req('POST', '/api/admin/kick', { conn: 'gone', minutes: 5 })).status, 404);
    assert.doesNotMatch(out, /TypeError|ReferenceError/);
  } finally {
    for (const d of all) if (d.evReq) d.evReq.destroy();
    app.kill();
    await wait(200);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
