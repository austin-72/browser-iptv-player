// A TV's own video player (a PlayStation's) fetches streams without the page's sign-in: this server's stream
// addresses are signed for it, for a day — and a signed one opens without any cookie.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('signed stream addresses: a day long, and opened without signing in', { timeout: 30000 }, async () => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-'));
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  let cookie = '';
  const api = async (method, p, body, noCookie) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, redirect: 'manual', headers: { 'X-App': '1', 'Content-Type': 'application/json', Cookie: noCookie ? '' : cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie(); if (sc.length && !noCookie) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, body: j };
  };
  try {
    for (let i = 0; i < 300 && !/Ready/.test(out); i++) await wait(100);
    await api('POST', '/api/login', { password: 'pw-test' });
    await api('POST', '/api/profiles', { name: 'Alex', avatar: 1, pin: '1234' });
    const day = (await api('POST', '/api/cast/link', { path: '/api/session/abc123/index.m3u8', hours: 24 })).body.url;
    const cast = (await api('POST', '/api/cast/link', { path: '/api/session/abc123/index.m3u8' })).body.url;
    const exp = (u) => JSON.parse(Buffer.from(u.split('/')[2].split('.')[0], 'base64url').toString()).e - Date.now() / 1000;
    assert.ok(Math.abs(exp(day) - 24 * 3600) < 60, 'a day');
    assert.ok(Math.abs(exp(cast) - 8 * 3600) < 60, 'a cast: 8 hours, as before');
    assert.ok(Math.abs(exp((await api('POST', '/api/cast/link', { path: '/api/session/x/index.m3u8', hours: 999 })).body.url) - 24 * 3600) < 60, 'a day at most');
    // Without any cookie: the signed address reaches the stream (a session that has ended: 410), the plain one doesn't.
    assert.strictEqual((await api('GET', day, undefined, true)).status, 410);
    assert.notStrictEqual((await api('GET', '/api/session/abc123/index.m3u8', undefined, true)).status, 410);
    // And only for that session's files.
    assert.strictEqual((await api('GET', day.replace('/abc123/', '/other1/'), undefined, true)).status, 403);
    // No link for a bare prefix (it would open everyone's), none that reaches beyond its own address, and links only read.
    for (const path of ['/api/session', '/api/session/', '/api/proxy/stalker/x', '/api/proxy/anything']) assert.strictEqual((await api('POST', '/api/cast/link', { path })).status, 400, path);
    const prox = (await api('POST', '/api/cast/link', { path: '/api/proxy?d=x&s=y' })).body.url;
    assert.strictEqual((await api('GET', prox.split('/api/proxy')[0] + '/api/proxy/stalker/l/live/1', undefined, true)).status, 403);
    assert.strictEqual((await api('DELETE', day.replace('/index.m3u8', ''), undefined, true)).status, 403);
  } finally {
    app.kill();
  }
});
