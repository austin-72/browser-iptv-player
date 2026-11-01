// The real server: API keys (Bearer, scopes, no CSRF header needed), the cookie API still needing X-App,
// speed-test limits, live viewing reports and webhooks on events.
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

test('API keys, CSRF, speed test, viewing reports and webhooks on the real server', { timeout: 60000 }, async () => {
  const m = await mock.start();
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5srv-'));
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test', OPENSUBTITLES_BASE: m.osBase, TRAKT_BASE: m.traktBase, SUBDL_BASE: m.subdlBase, SUBDL_DL_BASE: m.subdlDlBase, PODNAPISI_BASE: m.podnapisiBase, GESTDOWN_BASE: m.gestdownBase }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const req = async (method, p, { body, headers = {}, raw = false } = {}) => {
    const h = { ...headers };
    if (cookie && !h.Authorization) h.Cookie = cookie;
    if (body !== undefined && !(body instanceof Buffer)) { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    const r = await fetch(base + p, { method, headers: h, body });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    if (raw) return r;
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j };
  };
  const X = { 'X-App': '1' };
  try {
    for (let i = 0; i < 100 && !/Ready/.test(out); i++) await wait(100);
    assert.match(out, /Ready/, out);
    assert.strictEqual((await req('POST', '/api/login', { body: { password: 'pw-test' }, headers: X })).status, 200);
    const prof = await req('POST', '/api/profiles', { body: { name: 'Alex', pin: '1234', avatar: 1 }, headers: X });
    assert.strictEqual(prof.status, 200, JSON.stringify(prof.json));

    // The cookie API still needs the custom header (CSRF).
    assert.strictEqual((await req('POST', '/api/admin/apikeys', { body: { name: 'x', scope: 'read' } })).status, 403);
    const rk = await req('POST', '/api/admin/apikeys', { body: { name: 'Read', scope: 'read' }, headers: X });
    const ck = await req('POST', '/api/admin/apikeys', { body: { name: 'Control', scope: 'control' }, headers: X });
    const read = rk.json.key, ctl = ck.json.key;
    const integ = await req('GET', '/api/admin/integrations');
    assert.ok(integ.json.apiKeys.every((k) => !JSON.stringify(k).includes(read)), 'keys are never listed in full');

    // Keys, not cookies, open /api/v1 — and no X-App header is needed there.
    const noCookie = async (method, p, key, body) => { const save = cookie; cookie = ''; try { return await req(method, p, { body, headers: key ? { Authorization: `Bearer ${key}` } : {} }); } finally { cookie = save; } };
    assert.strictEqual((await noCookie('GET', '/api/v1/devices')).status, 401);
    assert.strictEqual((await noCookie('GET', '/api/v1/devices', 'iptv_wrong')).status, 401);
    const devs = await noCookie('GET', '/api/v1/devices', read);
    assert.strictEqual(devs.status, 200);
    assert.ok(Array.isArray(devs.json));
    assert.strictEqual((await noCookie('POST', '/api/v1/devices/abc/command', read, { cmd: 'pause' })).status, 403, 'a read-only key can’t control');
    assert.strictEqual((await noCookie('POST', '/api/v1/devices/abc/command', ctl, { cmd: 'pause' })).status, 404, 'control key: no such device');
    assert.strictEqual((await noCookie('GET', '/api/v1/status', ctl)).status, 403, 'admin only');
    assert.strictEqual((await noCookie('GET', '/api/v1/search?q=zz', read)).status, 200);

    // A device connected for live updates shows up, can be controlled, and its playback reports reach the dashboard.
    const events = await new Promise((ok) => { const r = http.get(`${base}/api/events?name=Test%20TV`, { headers: { Cookie: cookie } }, ok); });
    let sse = '';
    events.on('data', (d) => { sse += d; });
    for (let i = 0; i < 50 && !/"conn"/.test(sse); i++) await wait(50);
    const conn = JSON.parse(/data: (\{"conn".*\})/.exec(sse)[1]).conn;
    const dv = await noCookie('GET', '/api/v1/devices', read);
    assert.ok(dv.json.some((d) => d.id === conn && d.name === 'Test TV'));
    assert.strictEqual((await noCookie('POST', `/api/v1/devices/${conn}/command`, ctl, { cmd: 'volume', v: 0.4 })).status, 200);
    for (let i = 0; i < 50 && !/"cmd":"volume"/.test(sse); i++) await wait(50);
    assert.match(sse, /"cmd":"volume","from":"API: Control"/);
    assert.strictEqual((await noCookie('POST', `/api/v1/devices/${conn}/command`, ctl, { cmd: 'takeover' })).status, 400, 'only household-safe commands');

    // Webhooks: playback started (from presence) and a profile being chosen.
    const hk = await req('POST', '/api/admin/webhooks', { body: { url: `${m.base}/hook`, events: ['playback.started', 'playback.stopped', 'profile.signed_in'] }, headers: X });
    assert.ok(hk.json.secret);
    assert.strictEqual((await req('POST', '/api/presence', { body: { conn, playing: { k: 'k1', n: 'Some Film', alt: -1 } }, headers: X })).status, 200);
    assert.strictEqual((await req('POST', '/api/presence/stats', { body: { conn, s: { route: 'direct', br: 4500, bw: 20000, w: 1920, h: 1080, buf: 12, stalls: 1, stallMs: 800, dropped: 5, frames: 500 } }, headers: X })).json.ok, true);
    const w = await req('GET', '/api/admin/watching');
    assert.strictEqual(w.json.rows.length, 1);
    assert.deepStrictEqual([w.json.rows[0].device, w.json.rows[0].stats.route, w.json.rows[0].stats.h, w.json.rows[0].stats.stalls], ['Test TV', 'direct', 1080, 1]);
    await req('POST', '/api/presence', { body: { conn, playing: null }, headers: X });
    const pid = prof.json.id;
    await req('POST', `/api/profiles/${pid}/select`, { body: { pin: '1234' }, headers: X });
    for (let i = 0; i < 60 && m.state.hooks.length < 3; i++) await wait(50);
    const evs = m.state.hooks.map((h) => JSON.parse(h.body).event);
    assert.deepStrictEqual(evs.sort(), ['playback.started', 'playback.stopped', 'profile.signed_in']);
    events.destroy();

    // Speed test: capped sizes.
    const big = await req('GET', '/api/speedtest/down?mb=999', { raw: true });
    assert.strictEqual(big.headers.get('content-length'), String(50 * 1024 * 1024));
    await big.body.cancel();
    const small = await req('GET', '/api/speedtest/down?mb=1', { raw: true });
    assert.strictEqual((await small.arrayBuffer()).byteLength, 1024 * 1024);
    const up = await req('POST', '/api/speedtest/up', { body: Buffer.alloc(2 * 1024 * 1024), headers: { ...X, 'Content-Type': 'application/octet-stream' } });
    assert.strictEqual(up.json.bytes, 2 * 1024 * 1024);
    const tooBig = await req('POST', '/api/speedtest/up', { body: Buffer.alloc(31 * 1024 * 1024), headers: { ...X, 'Content-Type': 'application/octet-stream' } }).catch(() => ({ status: 413 }));
    assert.strictEqual(tooBig.status, 413);

    // Integrations: secrets are kept but never sent back.
    await req('PUT', '/api/admin/integrations', { body: { opensubtitles: { apiKey: 'oskey' }, trakt: { clientId: 'cid', clientSecret: 'sec' } }, headers: X });
    const i2 = await req('GET', '/api/admin/integrations');
    assert.ok(!JSON.stringify(i2.json).includes('oskey') && !JSON.stringify(i2.json).includes('"sec"'));
    await req('PUT', '/api/admin/integrations', { body: { subdl: { apiKey: 'sdkey' }, sources: { gestdown: false } }, headers: X });
    const i3 = await req('GET', '/api/admin/integrations');
    assert.ok(!JSON.stringify(i3.json).includes('sdkey'), 'the SubDL key isn’t sent back');
    assert.deepStrictEqual(i3.json.sources, { podnapisi: true, gestdown: false });
    assert.strictEqual(i3.json.opensubtitles.reserve, 2);
    const st = await req('POST', '/api/admin/integrations/subtitles/test', { headers: X });
    assert.deepStrictEqual([st.json.subdl.ok, st.json.podnapisi.ok, st.json.gestdown.on], [true, true, false]);
    const me = await req('GET', '/api/boot');
    assert.ok(me.status === 200);
    const t = await req('POST', '/api/trakt/connect', { headers: X });
    assert.strictEqual(t.json.code, 'ABCD1234');
    for (let i = 0; i < 30 && !fs.existsSync(path.join(dir, 'integrations.json')); i++) await wait(100);
    const secretsOnDisk = fs.readFileSync(path.join(dir, 'integrations.json'), 'utf8');
    assert.ok(secretsOnDisk.includes('oskey'));
    assert.doesNotMatch(out, /oskey|sdkey|iptv_[A-Za-z0-9_-]{20}/, 'never logged');
  } finally {
    app.kill();
    m.close();
  }
});
