// Fixes in screen time, Trakt, webhooks, following teams and the routes that read a request body: bedtime after
// midnight judged by the evening it started on, one Trakt token refresh at a time, webhook addresses and retries,
// bodies that aren't objects, and streams refused once a profile's time is up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const { ScreenTime } = require('../lib/screentime');
const { Trakt } = require('../lib/trakt');
const { Webhooks } = require('../lib/webhooks');
const { SportsIndex } = require('../lib/follow');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'svcfix-'));
const at = (iso) => Date.parse(iso);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('screen time: a bedtime after midnight belongs to the evening it started on', () => {
  let now = 0;
  const st = new ScreenTime(tmp(), { now: () => now, tzDefault: () => 'UTC' });
  // School nights: 06:30 until 20:00. Weekends (Saturday, Sunday): 08:00 until 00:30 the next night.
  st.setRule('kid', { mode: 'week', school: { from: '06:30', to: '20:00' }, weekend: { from: '08:00', to: '00:30' } });
  now = at('2026-11-07T00:10:00Z'); // Saturday 00:10 — still Friday night, a school night
  let s = st.state('kid');
  assert.strictEqual(s.blocked, true, 'Friday’s 20:00 bedtime still holds');
  assert.strictEqual(s.reason, 'bedtime');
  assert.strictEqual(s.nextAt, at('2026-11-07T08:00:00Z'), 'Saturday’s hours start at 08:00');
  now = at('2026-11-08T00:10:00Z'); // Sunday 00:10 — Saturday night
  assert.strictEqual(st.state('kid').left, 20);
  now = at('2026-11-09T00:10:00Z'); // Monday 00:10 — Sunday night, a weekend bedtime of 00:30
  s = st.state('kid');
  assert.strictEqual(s.blocked, false);
  assert.strictEqual(s.left, 20);
  now = at('2026-11-09T00:40:00Z');
  assert.strictEqual(st.state('kid').reason, 'bedtime');
  // After Friday's bedtime: watching again when Saturday's hours start, not at Friday's morning time.
  now = at('2026-11-06T21:00:00Z');
  s = st.state('kid');
  assert.strictEqual(s.reason, 'bedtime');
  assert.strictEqual(s.nextAt, at('2026-11-07T08:00:00Z'));
  // Saturday evening: until 00:30.
  now = at('2026-11-07T23:00:00Z');
  assert.strictEqual(st.state('kid').left, 90);
});

test('Trakt: two requests at once refresh an old token only once (the profile stays connected)', async () => {
  let refreshes = 0;
  const used = new Set();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url === '/oauth/token') {
        refreshes++;
        const b = JSON.parse(body);
        // A refresh token works once.
        if (used.has(b.refresh_token)) { res.writeHead(400); return res.end('{}'); }
        used.add(b.refresh_token);
        setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ access_token: 'new', refresh_token: 'r2', expires_in: 7776000, created_at: Math.floor(Date.now() / 1000) })); }, 50);
        return;
      }
      res.writeHead(req.headers.authorization === 'Bearer new' ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end('[]');
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const tr = new Trakt({ dataDir: tmp(), getConf: () => ({ clientId: 'cid', clientSecret: 'sec' }), fetch, base: `http://127.0.0.1:${srv.address().port}`, lib: {} });
    tr.store.data.profiles.p1 = { access: 'old', refresh: 'r1', expires: Date.now() + 3600e3, opts: {} };
    const [a, b] = await Promise.all([tr._req('/sync/watchlist/movies', { pid: 'p1' }), tr._req('/sync/watchlist/shows', { pid: 'p1' })]);
    assert.strictEqual(refreshes, 1);
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
    assert.strictEqual(tr.prof('p1').access, 'new');
    assert.strictEqual(tr.status('p1').connected, true);
    // Options sent as something other than an object: nothing changes (no crash).
    assert.deepStrictEqual(tr.setOpts('p1', null), {});
  } finally { srv.close(); }
});

test('webhooks: addresses checked, events once each, retries capped', async () => {
  let calls = 0;
  const hooks = new Webhooks(tmp(), { fetch: async () => { calls++; throw new Error('refused'); }, retries: [60e3] });
  try {
    assert.throws(() => hooks.save(null), (e) => e.status === 400);
    assert.throws(() => hooks.save({ url: 'http://', events: ['playback.started'] }), (e) => e.status === 400);
    assert.throws(() => hooks.save({ url: 'http://x.test/', events: ['constructor', 'toString'] }), /Pick at least one/);
    const h = hooks.save({ url: 'http://127.0.0.1:9/hook', events: Array(1000).fill('playback.started') });
    assert.deepStrictEqual(h.events, ['playback.started']);
    for (let i = 0; i < 400; i++) hooks.emit('playback.started', { i });
    await wait(50);
    assert.strictEqual(calls, 400);
    assert.ok(hooks.timers.size <= 200, `retries waiting: ${hooks.timers.size}`);
  } finally { hooks.stop(); }
});

test('following: what was asked about is remembered only up to a limit', () => {
  const idx = new SportsIndex();
  for (let i = 0; i < 6000; i++) idx.teamKeys(`Team ${i}`);
  assert.ok(idx._match.size <= 5000);
});

// ---------------------------------------------------------------- the real server
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

test('the server: bodies that aren’t objects, and streams refused when time is up', { timeout: 60000 }, async () => {
  const port = await freePort();
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tmp(), NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const client = () => {
    let cookie = '';
    return async (method, p, raw) => {
      const h = { 'X-App': '1' };
      if (cookie) h.Cookie = cookie;
      if (raw !== undefined) h['Content-Type'] = 'application/json';
      const r = await fetch(base + p, { method, headers: h, body: raw, redirect: 'manual' });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { status: r.status, json: j };
    };
  };
  try {
    for (let i = 0; i < 100 && !/Ready/.test(out); i++) await wait(100);
    assert.match(out, /Ready/, out);
    const admin = client();
    await admin('POST', '/api/login', JSON.stringify({ password: 'pw-test' }));
    await admin('POST', '/api/profiles', JSON.stringify({ name: 'Alex', pin: '1234', avatar: 1 })); // (the first is the admin)
    const k = await admin('POST', '/api/profiles', JSON.stringify({ name: 'Sam', kids: true, avatar: 2 }));
    assert.strictEqual(k.status, 200, JSON.stringify(k.json));
    const kid = client();
    await kid('POST', '/api/login', JSON.stringify({ password: 'pw-test' }));
    assert.strictEqual((await kid('POST', `/api/profiles/${k.json.id}/select`, '{}')).status, 200);

    // A JSON body of null, a number or a string: a plain answer, not a server error.
    for (const raw of ['null', '5', '"x"']) {
      for (const [who, m, p] of [
        [kid, 'PUT', '/api/follow'], [kid, 'POST', '/api/follow/toggle'], [kid, 'POST', '/api/screentime/ask'],
        [kid, 'POST', '/api/parental/unlock'], [kid, 'POST', '/api/wishlist'], [kid, 'POST', '/api/alerts/read'],
        [admin, 'POST', `/api/admin/screentime/${k.json.id}/grant`], [admin, 'PUT', '/api/admin/events'], [admin, 'PUT', '/api/admin/health'],
      ]) {
        const r = await who(m, p, raw);
        assert.ok(r.status < 500, `${m} ${p} with ${raw}: ${r.status} ${JSON.stringify(r.json)}`);
      }
    }

    // Time's up: the stream relay and files on disk are refused too (not just starting playback).
    assert.strictEqual((await admin('PUT', `/api/admin/screentime/${k.json.id}`, JSON.stringify({ rule: { mode: 'same', same: { limit: 0 } } }))).status, 200);
    for (const p of ['/api/proxy?d=x&s=y', '/api/local/dvr/abc', '/api/proxy/stalker/l/live/1']) {
      const r = await kid('GET', p);
      assert.strictEqual(r.status, 403, p);
      assert.strictEqual(r.json.screentime.reason, 'limit', p);
    }
    assert.strictEqual((await kid('POST', '/api/cast/link', JSON.stringify({ path: '/api/proxy?d=x&s=y' }))).status, 403);
    // Not the admin, and not before the limit is set.
    const noLimit = (r) => !(r.json && r.json.screentime);
    assert.ok(noLimit(await admin('GET', '/api/proxy?d=x&s=y')));
    assert.strictEqual((await admin('PUT', `/api/admin/screentime/${k.json.id}`, JSON.stringify({ rule: null }))).status, 200);
    assert.ok(noLimit(await kid('GET', '/api/proxy?d=x&s=y')));
    assert.doesNotMatch(out, /Screen time: no route/);
  } finally {
    app.kill();
  }
});
