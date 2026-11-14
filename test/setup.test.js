// A new install with no starting password: the setup page (the site password and the admin profile chosen there,
// from the home network only), the time zone from the browser, and the setup guide's state — on the real server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const start = async (dir, extra = {}) => {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, NO_RESPAWN: '1', ...extra };
  delete env.SITE_PASSWORD; delete env.TZ;
  if (extra.SITE_PASSWORD) env.SITE_PASSWORD = extra.SITE_PASSWORD;
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const s = { app, out: '', base: `http://127.0.0.1:${port}` };
  app.stdout.on('data', (d) => { s.out += d; });
  app.stderr.on('data', (d) => { s.out += d; });
  for (let i = 0; i < 300 && !/Ready/.test(s.out); i++) await wait(100);
  assert.match(s.out, /Ready/, s.out);
  s.stop = async () => { app.kill(); for (let i = 0; i < 50 && app.exitCode === null && app.signalCode === null; i++) await wait(100); };
  return s;
};
const device = (s) => {
  const d = { cookie: '' };
  d.req = async (method, p, body, headers = {}) => {
    const h = { 'X-App': '1', ...headers };
    if (d.cookie) h.Cookie = d.cookie;
    if (body !== undefined) { body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    const r = await fetch(s.base + p, { method, headers: h, body, redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc) d.cookie = sc.split(';')[0];
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, text: t };
  };
  return d;
};

test('a new install opens the setup page, and is set up once', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  let s = await start(dir);
  try {
    assert.match(s.out, /Set up {4}open it in a browser/, 'the start-up message says how to set it up');
    assert.doesNotMatch(s.out, /changeme/, 'no shared default password any more');
    const a = device(s);
    const page = await a.req('GET', '/');
    assert.match(page.text, /Set up and start/, 'the setup page, not the sign-in page');
    assert.strictEqual((await a.req('GET', '/setup.js')).status, 200);
    assert.strictEqual((await a.req('POST', '/api/login', { password: 'changeme' })).status, 401, 'the old default doesn’t sign in');

    // From outside the home network: refused, and nothing changes.
    const away = await a.req('POST', '/api/setup', { password: 'household-pw', name: 'Sam', pin: '2468' }, { 'X-Forwarded-For': '8.8.8.8' });
    assert.strictEqual(away.status, 403);
    assert.match((await a.req('GET', '/', undefined, { 'X-Forwarded-For': '8.8.8.8' })).text, /isn’t on the same home network/);
    // What's wrong is said, and nothing is half made.
    assert.strictEqual((await a.req('POST', '/api/setup', { password: 'short', name: 'Sam', pin: '2468' })).status, 400);
    const badPin = await a.req('POST', '/api/setup', { password: 'household-pw', name: 'Sam', pin: '12' });
    assert.strictEqual(badPin.status, 400);
    assert.match(badPin.json.error, /PIN/);
    assert.strictEqual((await a.req('POST', '/api/setup', { password: 'household-pw', name: '', pin: '2468' })).status, 400);

    const ok = await a.req('POST', '/api/setup', { password: 'household-pw', name: 'Sam', pin: '2468', tz: 'Asia/Tokyo' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
    const boot = await a.req('GET', '/api/boot');
    assert.strictEqual(boot.status, 200);
    assert.strictEqual(boot.json.profiles.length, 1);
    assert.ok(boot.json.profiles[0].admin, 'the profile made is the admin');
    assert.strictEqual(boot.json.current, boot.json.profiles[0].id, 'and this device is in it already');
    assert.strictEqual(boot.json.defaultPassword, false);
    const adm = await a.req('GET', '/api/admin');
    assert.strictEqual(adm.status, 200);
    assert.strictEqual(adm.json.status.tz.now, 'Asia/Tokyo', 'the time zone of the browser that set it up');
    assert.strictEqual(adm.json.settings.setupDone, false, 'the setup guide still to do');

    // Only once.
    const again = device(s);
    assert.strictEqual((await again.req('POST', '/api/setup', { password: 'other-pw-1', name: 'Eve', pin: '1357' })).status, 409);
    assert.doesNotMatch((await again.req('GET', '/')).text, /Set up and start/, 'the sign-in page now');
    assert.strictEqual((await again.req('POST', '/api/login', { password: 'household-pw' })).status, 200, 'the chosen password signs in');

    // The time zone and the guide can be changed in Admin.
    assert.strictEqual((await a.req('PUT', '/api/admin/settings', { timeZone: 'Not/AZone' })).status, 400);
    assert.strictEqual((await a.req('PUT', '/api/admin/settings', { timeZone: 'Europe/London', setupDone: true })).status, 200);
    const adm2 = await a.req('GET', '/api/admin');
    assert.strictEqual(adm2.json.status.tz.now, 'Europe/London');
    assert.strictEqual(adm2.json.settings.setupDone, true);
    const qr = await a.req('GET', '/api/admin/qr?text=' + encodeURIComponent('http://192.168.1.20:8080'));
    assert.match(qr.json.svg, /^<svg/);
    assert.strictEqual((await a.req('GET', '/api/admin/qr?text=javascript:alert(1)')).status, 400);

    // After a restart: still set up, with its time zone.
    await s.stop();
    s = await start(dir);
    assert.doesNotMatch(s.out, /Set up {4}open it/);
    const b = device(s);
    assert.strictEqual((await b.req('POST', '/api/login', { password: 'household-pw' })).status, 200);
  } finally { await s.stop(); }
});

test('a starting password given (SITE_PASSWORD) still works as before: no setup page', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-pw-'));
  const s = await start(dir, { SITE_PASSWORD: 'given-pw' });
  try {
    const a = device(s);
    assert.doesNotMatch((await a.req('GET', '/')).text, /Set up and start/);
    assert.strictEqual((await a.req('POST', '/api/setup', { password: 'household-pw', name: 'Sam', pin: '2468' })).status, 409);
    assert.strictEqual((await a.req('POST', '/api/login', { password: 'given-pw' })).status, 200);
  } finally { await s.stop(); }
});

test('an install made before the setup page, still on changeme, keeps working', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-old-'));
  // (What an older version made: the default password, nothing else.)
  let s = await start(dir, { SITE_PASSWORD: 'changeme' });
  await s.stop();
  s = await start(dir);
  try {
    const a = device(s);
    assert.doesNotMatch((await a.req('GET', '/')).text, /Set up and start/);
    assert.strictEqual((await a.req('POST', '/api/login', { password: 'changeme' })).status, 200);
    assert.match(s.out, /still the default/);
  } finally { await s.stop(); }
});
