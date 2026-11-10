// Using someone else's screen as a remote: asked first, on that screen; nothing of what's on it shown before; the
// screen's own profile needs no asking; a "no" holds a minute; the screen can stop it; another profile there ends it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('a phone asks before it becomes another profile’s remote', { timeout: 60000 }, async () => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rask-'));
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const streams = [];
  const client = () => {
    let cookie = '', conn = '';
    const api = async (method, p, body) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-App': '1', 'Content-Type': 'application/json', Cookie: cookie, 'X-Conn': conn }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.getSetCookie(); if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
      return { status: r.status, body: j };
    };
    const o = { api, sse: '' };
    o.connect = async (name) => {
      const res = await new Promise((ok) => { http.get(`http://127.0.0.1:${port}/api/events?name=${encodeURIComponent(name)}`, { headers: { Cookie: cookie } }, ok); });
      streams.push(res);
      res.on('data', (d) => { o.sse += d; });
      for (let i = 0; i < 50 && !/"conn"/.test(o.sse); i++) await wait(50);
      conn = o.conn = JSON.parse(/data: (\{"conn".*\})/.exec(o.sse)[1]).conn;
    };
    o.event = async (name) => { for (let i = 0; i < 60; i++) { const m = new RegExp('event: ' + name + '\\ndata: (.*)\\n', 'g'); const all = [...o.sse.matchAll(m)]; if (all.length) return JSON.parse(all[all.length - 1][1]); await wait(50); } return null; };
    return o;
  };
  const phone = client(), tv = client(), phone2 = client();
  try {
    for (let i = 0; i < 100 && !/Ready/.test(out); i++) await wait(100);
    assert.match(out, /Ready/, out);
    for (const c of [phone, tv, phone2]) assert.strictEqual((await c.api('POST', '/api/login', { password: 'pw-test' })).status, 200);
    const alex = (await phone.api('POST', '/api/profiles', { name: 'Alex', avatar: 1, pin: '1234' })).body; // (the admin)
    const sam = (await phone.api('POST', '/api/profiles', { name: 'Sam', avatar: 2 })).body;
    assert.strictEqual((await tv.api('POST', `/api/profiles/${sam.id}/select`, {})).status, 200);
    assert.strictEqual((await phone2.api('POST', `/api/profiles/${sam.id}/select`, {})).status, 200);
    await tv.connect('Living room TV'); await phone.connect('Alex phone'); await phone2.connect('Sam phone');
    await tv.api('POST', '/api/presence', { conn: tv.conn, playing: { k: 'secret-film', n: 'A Private Film', pos: 10 } });

    // The TV reconnected (its old connection still half-open): one screen in the list, not two — its newest.
    const oldConn = tv.conn;
    tv.sse = ''; await tv.connect('Living room TV');
    assert.notStrictEqual(tv.conn, oldConn);
    const tvs = (await phone2.api('GET', '/api/devices')).body.filter((x) => x.name === 'Living room TV');
    assert.deepStrictEqual(tvs.map((x) => x.conn), [tv.conn], JSON.stringify(tvs));
    await tv.api('POST', '/api/presence', { conn: tv.conn, playing: { k: 'secret-film', n: 'A Private Film', pos: 10 } });

    // Not asked yet: listed, but not what's on it, and it can't be controlled.
    let d = (await phone.api('GET', '/api/devices')).body.find((x) => x.conn === tv.conn);
    assert.deepStrictEqual([d.ok, d.playing, d.profile], [false, null, 'Sam']);
    assert.strictEqual((await phone.api('POST', `/api/devices/${tv.conn}/command`, { cmd: 'pause' })).status, 404);
    // Sam's own phone: no asking.
    d = (await phone2.api('GET', '/api/devices')).body.find((x) => x.conn === tv.conn);
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.playing.n, 'A Private Film');

    // Asked: the TV is asked; a "no" holds a minute.
    assert.deepStrictEqual((await phone.api('POST', `/api/devices/${tv.conn}/ask`)).body, { asked: true });
    let ask = await tv.event('remote-ask');
    assert.strictEqual(ask.from, 'Alex');
    assert.strictEqual((await phone.api('GET', '/api/devices')).body.find((x) => x.conn === tv.conn).asked, true);
    assert.strictEqual((await phone.api('POST', `/api/remote-ask/${ask.id}`, { allow: true })).status, 404, 'only the screen answers');
    assert.strictEqual((await tv.api('POST', `/api/remote-ask/${ask.id}`, { allow: false })).status, 200);
    assert.strictEqual((await phone.event('remote-answer')).ok, false);
    assert.strictEqual((await phone.api('POST', `/api/devices/${tv.conn}/ask`)).status, 429);
    assert.strictEqual((await phone.api('POST', `/api/devices/${tv.conn}/command`, { cmd: 'pause' })).status, 404);

    // A yes (from another phone of the admin's this time would be the same): controlling, and what's on.
    const phone3 = client();
    await phone3.api('POST', '/api/login', { password: 'pw-test' });
    await phone3.api('POST', `/api/profiles/${alex.id}/select`, { pin: '1234' });
    await phone3.connect('Alex tablet');
    tv.sse = '';
    await phone3.api('POST', `/api/devices/${tv.conn}/ask`);
    ask = await tv.event('remote-ask');
    assert.strictEqual((await tv.api('POST', `/api/remote-ask/${ask.id}`, { allow: true })).status, 200);
    assert.strictEqual((await phone3.event('remote-answer')).ok, true);
    d = (await phone3.api('GET', '/api/devices')).body.find((x) => x.conn === tv.conn);
    assert.deepStrictEqual([d.ok, d.playing && d.playing.n], [true, 'A Private Film']);
    assert.strictEqual((await phone3.api('POST', `/api/devices/${tv.conn}/command`, { cmd: 'pause' })).status, 200);
    assert.ok(await tv.event('command'));
    assert.strictEqual((await phone.api('GET', '/api/devices')).body.find((x) => x.conn === tv.conn).ok, false, 'only the phone that was allowed');

    // The screen stops it.
    assert.deepStrictEqual((await tv.api('POST', '/api/remote-ok/stop')).body, { stopped: 1 });
    assert.strictEqual((await phone3.api('POST', `/api/devices/${tv.conn}/command`, { cmd: 'pause' })).status, 404);
  } finally {
    for (const s of streams) s.destroy();
    app.kill();
  }
});
