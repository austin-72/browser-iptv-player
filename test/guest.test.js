// The Guest on "Who's watching?": only when the admin allows it; a new one for each visit, kept in memory only, gone
// when it leaves; not in what the household shares (who else watched this); can't do what would be kept or shared.
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

test('a guest: offered when allowed, watches without anything kept or shared', { timeout: 60000 }, async () => {
  const m3u = '#EXTM3U\n#EXTINF:-1 group-title="Movies",Big Film (2020)\nhttp://127.0.0.1:1/movie/u/p/1.mp4\n#EXTINF:-1 group-title="News",Daily News\nhttp://127.0.0.1:1/news.m3u8\n';
  const pl = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); r.end(m3u); }).listen(0, '127.0.0.1');
  await new Promise((r) => pl.once('listening', r));
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-'));
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const client = () => {
    let cookie = '';
    return async (method, p, body) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-App': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.getSetCookie(); if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
      return { status: r.status, body: j };
    };
  };
  const admin = client(), guest = client(), guest2 = client();
  try {
    for (let i = 0; i < 100 && !/Ready/.test(out); i++) await wait(100);
    assert.match(out, /Ready/, out);
    assert.strictEqual((await admin('POST', '/api/login', { password: 'pw-test' })).status, 200);
    const alex = (await admin('POST', '/api/profiles', { name: 'Alex', avatar: 1, pin: '1234' })).body;
    assert.ok(alex.admin);
    await admin('POST', '/api/admin/lists', { type: 'url', name: 'L', url: `http://127.0.0.1:${pl.address().port}/list.m3u` });
    let film;
    for (let i = 0; i < 100 && !film; i++) { const c = (await admin('GET', '/api/catalog')).body; film = c && c.items && c.items.find((x) => x.n === 'Big Film'); if (!film) await wait(100); }
    assert.ok(film, 'catalogue built');

    for (const g of [guest, guest2]) assert.strictEqual((await g('POST', '/api/login', { password: 'pw-test' })).status, 200);
    assert.strictEqual((await guest('GET', '/api/boot')).body.guest, null, 'not offered until the admin allows it');
    assert.strictEqual((await guest('POST', '/api/profiles/guest/select', {})).status, 403);

    assert.strictEqual((await admin('PUT', '/api/admin/settings', { guestProfile: true })).status, 200);
    const boot = (await guest('GET', '/api/boot')).body;
    assert.strictEqual(boot.guest.name, 'Guest');
    assert.ok(!boot.profiles.some((p) => p.guest), 'not one of the household’s profiles');
    assert.strictEqual((await guest('POST', '/api/profiles/guest/select', {})).status, 200);
    await guest2('POST', '/api/profiles/guest/select', {});
    const me = (await guest('GET', '/api/me')).body;
    assert.ok(me.profile.guest && /^guest-/.test(me.profile.id));
    assert.notStrictEqual((await guest2('GET', '/api/me')).body.profile.id, me.profile.id, 'each visit its own');

    // It watches and lists — on its own visit only.
    assert.strictEqual((await guest('POST', '/api/played', { k: film.k, t: 'movie', s: 600 })).status, 200);
    assert.strictEqual((await guest('POST', '/api/progress', { k: film.k, p: 600, d: 6000 })).status, 200);
    assert.strictEqual((await guest('POST', '/api/toggle', { field: 'list', k: film.k, on: true })).status, 200);
    let d = (await guest('GET', '/api/me')).body.data;
    assert.ok(d.history.some((h) => h.k === film.k) && d.list.includes(film.k));
    assert.deepStrictEqual((await guest2('GET', '/api/me')).body.data.list, [], 'the other guest doesn’t see it');
    // Nothing on disk; nothing others see.
    await wait(1200);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'users')).filter((f) => /guest/.test(f)), []);
    assert.strictEqual((await admin('POST', `/api/profiles/${alex.id}/select`, { pin: '1234' })).status, 200);
    const info = (await admin('GET', `/api/item/${encodeURIComponent(film.k)}`)).body;
    assert.deepStrictEqual(info.watchedBy, [], 'not “also watched by”');

    // What would be kept or shared: no.
    for (const [m, p, b] of [['POST', '/api/wishlist', { t: 'movie', n: 'X' }], ['PUT', '/api/me', { name: 'Hacker' }], ['POST', '/api/messages', { to: 'all', text: 'hi' }], ['POST', '/api/dvr/record', {}], ['PUT', '/api/admin/settings', { guestProfile: false }], ['POST', '/api/profiles', { name: 'New' }]]) {
      assert.strictEqual((await guest(m, p, b)).status, 403, m + ' ' + p);
    }

    // Leaving forgets it: choosing Guest again starts empty.
    assert.strictEqual((await guest('POST', '/api/profiles/leave', {})).status, 200);
    await guest('POST', '/api/profiles/guest/select', {});
    d = (await guest('GET', '/api/me')).body.data;
    assert.deepStrictEqual([d.history.length, d.list.length], [0, 0]);

    // Adult (18+) groups: off unless allowed, and never with kids' titles only.
    const r = () => (guest('GET', '/api/me').then((x) => x.body.profile.restrictions));
    assert.strictEqual((await r()).adult, false);
    await admin('PUT', '/api/admin/settings', { guestAdult: true });
    assert.strictEqual((await r()).adult, true);
    await admin('PUT', '/api/admin/settings', { guestKids: true });
    assert.strictEqual((await r()).adult, false, 'kids only wins');
    await admin('PUT', '/api/admin/settings', { guestKids: false, guestAdult: false });

    // Turned off: guests are out.
    assert.strictEqual((await admin('PUT', '/api/admin/settings', { guestProfile: false })).status, 200);
    assert.strictEqual((await guest('GET', '/api/me')).status, 403);
    assert.strictEqual((await guest('GET', '/api/boot')).body.guest, null);
  } finally {
    app.kill();
    pl.close();
  }
});
