// Sign-in, profiles and live connections on the real server: PIN lockouts, a changed PIN on other devices, live
// connections ending with their device's session, API keys of removed profiles, and odd requests that used to crash.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const mock = require('./mock/integrations');

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('sessions, PINs and live connections', { timeout: 60000 }, async () => {
  const m = await mock.start();
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authfix-'));
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const X = { 'X-App': '1' };
  // One browser: its own cookie.
  const device = () => {
    const d = { cookie: '' };
    d.req = async (method, p, body, headers = {}) => {
      const h = { ...X, ...headers };
      if (d.cookie) h.Cookie = d.cookie;
      if (body !== undefined && typeof body !== 'string') body = JSON.stringify(body);
      if (body !== undefined) h['Content-Type'] = 'application/json';
      const r = await fetch(base + p, { method, headers: h, body });
      const sc = r.headers.get('set-cookie');
      if (sc) d.cookie = sc.split(';')[0];
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { status: r.status, json: j };
    };
    // A live connection (server-sent events): resolves once it says hello; .ended turns true when the server ends it.
    d.events = () => new Promise((ok, fail) => {
      const r = http.get(`${base}/api/events?name=Test`, { headers: { Cookie: d.cookie } }, (res) => {
        const e = { res, text: '', ended: false, conn: null };
        res.on('data', (c) => { e.text += c; const mm = /data: \{"conn":"([^"]+)"/.exec(e.text); if (mm && !e.conn) { e.conn = mm[1]; ok(e); } });
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

    // Odd requests get an answer instead of a crash (or no answer at all).
    const raw = await new Promise((ok) => { const r = http.request({ host: '127.0.0.1', port, path: '//', method: 'GET' }, (res) => { res.resume(); ok(res.statusCode); }); r.on('error', () => ok(0)); r.setTimeout(3000, () => { r.destroy(); ok(-1); }); r.end(); });
    assert.strictEqual(raw, 400, 'a path of "//" is answered');
    const a = device();
    assert.strictEqual((await a.req('POST', '/api/login', 'null')).status, 401, 'a JSON body of null is a wrong password, not a server error');
    assert.strictEqual((await a.req('POST', '/api/login', { password: 'pw-test' })).status, 200);
    const admin = await a.req('POST', '/api/profiles', { name: 'Admin', pin: '1234' });
    assert.strictEqual(admin.status, 200);
    const mum = await a.req('POST', '/api/profiles', { name: 'Mum', pin: '1111' });
    const kid = await a.req('POST', '/api/profiles', { name: 'Kid', kids: true });
    const dad = await a.req('POST', '/api/profiles', { name: 'Dad', pin: '5555' });
    assert.strictEqual((await a.req('POST', '/api/presence', 'null')).status, 200);
    assert.strictEqual((await a.req('POST', '/api/devices/nope/command', 7)).status, 404);
    assert.strictEqual((await a.req('PUT', '/api/me', 'null')).status, 200);

    // Asking whether a PIN is needed (the app does it on every tap of a profile) isn't a wrong guess.
    const b = device();
    await b.req('POST', '/api/login', { password: 'pw-test' });
    for (let i = 0; i < 7; i++) assert.strictEqual((await b.req('POST', `/api/profiles/${mum.json.id}/select`, {})).status, 401);
    assert.strictEqual((await b.req('POST', `/api/profiles/${mum.json.id}/select`, { pin: '1111' })).status, 200, 'not locked out by taps');

    // Guessing the current PIN while changing it counts towards the lockout too (on Dad's profile, opened on a phone).
    const ph = device();
    await ph.req('POST', '/api/login', { password: 'pw-test' });
    assert.strictEqual((await ph.req('POST', `/api/profiles/${dad.json.id}/select`, { pin: '5555' })).status, 200);
    for (let i = 0; i < 5; i++) assert.strictEqual((await ph.req('PUT', '/api/me', { pin: '3333', currentPin: '000' + i })).status, 403);
    assert.strictEqual((await ph.req('PUT', '/api/me', { pin: '3333', currentPin: '0009' })).status, 429);
    // …but only on the phone that guessed: Dad's own TV still opens his profile.
    const tv = device();
    await tv.req('POST', '/api/login', { password: 'pw-test' });
    assert.strictEqual((await tv.req('POST', `/api/profiles/${dad.json.id}/select`, { pin: '5555' })).status, 200, 'other devices not locked out');
    // Many wrong guesses across devices lock the profile everywhere.
    const gran = await a.req('POST', '/api/profiles', { name: 'Gran', pin: '7777' });
    for (let n = 0; n < 4; n++) {
      const g = device();
      await g.req('POST', '/api/login', { password: 'pw-test' });
      for (let i = 0; i < 5; i++) await g.req('POST', `/api/profiles/${gran.json.id}/select`, { pin: '900' + i });
    }
    assert.strictEqual((await tv.req('POST', `/api/profiles/${gran.json.id}/select`, { pin: '7777' })).status, 429, 'profile-wide lockout');
    // The admin setting a new PIN unlocks it.
    assert.strictEqual((await a.req('PUT', `/api/admin/profiles/${gran.json.id}`, { pin: '7878' })).status, 200);
    assert.strictEqual((await tv.req('POST', `/api/profiles/${gran.json.id}/select`, { pin: '7878' })).status, 200, 'reset unlocks');

    // The admin resets Mum's PIN.
    assert.strictEqual((await a.req('PUT', `/api/admin/profiles/${mum.json.id}`, { pin: '2222' })).status, 200);
    // A changed PIN: other devices that had the profile open need the new one.
    assert.strictEqual((await b.req('GET', '/api/me')).status, 403, 'old PIN no longer opens the profile');
    const boot = await b.req('GET', '/api/boot');
    assert.strictEqual(boot.json.current, null);

    // Device C opens Mum with the new PIN and changes it itself: C stays in; device B (also re-entered) is sent back.
    const c = device();
    await c.req('POST', '/api/login', { password: 'pw-test' });
    assert.strictEqual((await c.req('POST', `/api/profiles/${mum.json.id}/select`, { pin: '2222' })).status, 200);
    const d = device();
    await d.req('POST', '/api/login', { password: 'pw-test' });
    assert.strictEqual((await d.req('POST', `/api/profiles/${mum.json.id}/select`, { pin: '2222' })).status, 200);
    const dEv = await d.events();
    assert.strictEqual((await c.req('PUT', '/api/me', { pin: '4444', currentPin: '2222' })).status, 200);
    assert.strictEqual((await c.req('GET', '/api/me')).status, 200, 'the device that changed it keeps the profile');
    assert.strictEqual((await c.req('GET', '/api/boot')).json.current, mum.json.id);
    assert.strictEqual((await d.req('GET', '/api/me')).status, 403);
    assert.ok(await until(() => dEv.ended), 'the other device’s live connection ends');
    assert.strictEqual((await d.req('POST', `/api/profiles/${mum.json.id}/select`, { pin: '2222' })).status, 403);
    assert.strictEqual((await d.req('POST', `/api/profiles/${mum.json.id}/select`, { pin: '4444' })).status, 200);

    // Signing out ends that device's live connection (it stops getting messages and commands).
    const e1 = await d.events();
    assert.strictEqual((await d.req('POST', '/api/logout', {})).status, 200);
    assert.ok(await until(() => e1.ended), 'signed out: live connection ended');
    // The admin signing a device out (Admin → Devices) does the same.
    const e2 = await c.events();
    const devs = (await a.req('GET', '/api/admin')).json.devices;
    const mumSess = devs.filter((x) => x.profile === mum.json.id); // (devices B and C)
    assert.strictEqual(mumSess.length, 2);
    for (const x of mumSess) assert.strictEqual((await a.req('DELETE', `/api/admin/devices/${x.id}`)).status, 200);
    assert.ok(await until(() => e2.ended), 'removed device: live connection ended');
    assert.strictEqual((await c.req('GET', '/api/me')).status, 401);

    // A live connection that ends while playing: playback "stopped" is sent, as when the app says so itself.
    await a.req('POST', '/api/admin/webhooks', { url: `${m.base}/hook`, events: ['playback.started', 'playback.stopped'] });
    const e3 = await a.events();
    await a.req('POST', '/api/presence', { conn: e3.conn, playing: { k: 'k1', n: 'A Film', alt: -1 } });
    await until(() => m.state.hooks.length >= 1);
    e3.res.destroy();
    assert.ok(await until(() => m.state.hooks.some((h) => JSON.parse(h.body).event === 'playback.stopped')), 'stopped on disconnect');
    assert.strictEqual((await a.req('GET', '/api/devices')).json.length, 0);

    // An API key made for a profile that's later removed doesn't become a household-wide key.
    const k = await a.req('POST', '/api/admin/apikeys', { name: 'Kid', scope: 'control', profile: kid.json.id });
    const v1 = (p) => fetch(base + p, { headers: { Authorization: `Bearer ${k.json.key}` } }).then((r) => r.status);
    assert.strictEqual(await v1('/api/v1/devices'), 200);
    assert.strictEqual((await a.req('DELETE', `/api/admin/profiles/${kid.json.id}`)).status, 200);
    assert.strictEqual(await v1('/api/v1/devices'), 403);
    // (An item address with a stray % is "not found", not a server error.)
    const rk = await a.req('POST', '/api/admin/apikeys', { name: 'Read', scope: 'read' });
    assert.strictEqual((await fetch(base + '/api/v1/items/a%25zz', { headers: { Authorization: `Bearer ${rk.json.key}` } })).status, 404);

    assert.doesNotMatch(out, /TypeError|Unhandled|Unexpected error/, out);
  } finally {
    app.kill();
    m.close();
  }
});
