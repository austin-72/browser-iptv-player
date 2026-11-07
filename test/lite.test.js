// The light catalogue (TVs, games consoles): films without stream addresses (fetched when played), no second picture
// or backdrop, addresses' beginnings in a table, smarter categories by number, small pages — and the same titles.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const { Catalog } = require('../lib/catalog');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('liteItem: smaller, and read back to the same addresses and categories', () => {
  const t = Catalog.liteTables();
  const film = { k: 'a', t: 'movie', n: 'Film', u: 'http://p.example:8080/movie/user/pass/123.mkv', a: [{ u: 'http://q.example/movie/x/y/9.mp4' }], h: { 'User-Agent': 'x' }, i: 'https://image.tmdb.org/t/p/w342/abc.jpg', i2: 'http://p.example/logo.png', bd: 'https://image.tmdb.org/t/p/w1280/bd.jpg', sc: ['g:comedy', 'n:netflix'] };
  const live = { k: 'b', t: 'live', n: 'News', u: 'http://p.example:8080/live/user/pass/55.ts', a: [{ u: 'http://p.example:8080/live/user/pass/56.ts' }], i: 'http://p.example:8080/logos/news.png', sc: ['g:comedy'] };
  const lf = Catalog.liteItem(film, t), ll = Catalog.liteItem(live, t);
  assert.deepStrictEqual([lf.u, lf.a, lf.h, lf.i2, lf.bd, lf.lz], [undefined, undefined, undefined, undefined, undefined, 1]);
  assert.match(lf.i, /^~\w+~abc\.jpg$/);
  assert.match(ll.u, /^~\w+~55\.ts$/);
  assert.deepStrictEqual(lf.sc, [0, 1]);
  assert.deepStrictEqual(ll.sc, [0]);
  // (The device's reading: web/js/store.js V.unpackCatalog, the same steps.)
  const un = (s) => { if (typeof s !== 'string' || s[0] !== '~') return s; const j = s.indexOf('~', 1); return t.P[parseInt(s.slice(1, j), 36)] + s.slice(j + 1); };
  assert.strictEqual(un(ll.u), live.u);
  assert.strictEqual(un(ll.a[0].u), live.a[0].u);
  assert.strictEqual(un(lf.i), film.i);
  assert.deepStrictEqual(ll.sc.map((n) => t.SC[n]), live.sc);
  assert.ok(JSON.stringify(lf).length < JSON.stringify(film).length / 2);
});

test('the server: ?lite=1 in small pages; a film’s address when it’s played', { timeout: 60000 }, async () => {
  let m3u = '#EXTM3U\n';
  for (let i = 0; i < 30; i++) m3u += `#EXTINF:-1 tvg-logo="http://127.0.0.1:1/logos/${i}.png" group-title="News",Channel ${i}\nhttp://127.0.0.1:1/live/u/p/${i}.ts\n`;
  for (let i = 0; i < 30; i++) m3u += `#EXTINF:-1 group-title="Movies",Film Number ${i} (20${10 + (i % 15)})\nhttp://127.0.0.1:1/movie/u/p/${i}.mp4\n`;
  const pl = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); r.end(m3u); }).listen(0, '127.0.0.1');
  await new Promise((r) => pl.once('listening', r));
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-'));
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test', CATALOG_LITE_PAGE: '25' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  let cookie = '';
  const api = async (p, raw) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: raw && raw.method || 'GET', headers: { 'X-App': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: raw && raw.body ? JSON.stringify(raw.body) : undefined });
    const sc = r.headers.getSetCookie(); if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, body: j, etag: r.headers.get('etag') };
  };
  try {
    for (let i = 0; i < 100 && !/Ready/.test(out); i++) await wait(100);
    await api('/api/login', { method: 'POST', body: { password: 'pw-test' } });
    await api('/api/profiles', { method: 'POST', body: { name: 'Alex', avatar: 1, pin: '1234' } });
    await api('/api/admin/lists', { method: 'POST', body: { type: 'url', name: 'L', url: `http://127.0.0.1:${pl.address().port}/list.m3u` } });
    let full;
    for (let i = 0; i < 100; i++) { full = await api('/api/catalog'); if (full.body && full.body.items && full.body.items.length >= 60) break; await wait(100); }
    const lite = await api('/api/catalog?lite=1');
    assert.strictEqual(lite.body.lite, 1);
    assert.strictEqual(lite.body.total, full.body.items.length, 'the same titles');
    assert.strictEqual(lite.body.pages, Math.ceil(lite.body.total / 25));
    assert.notStrictEqual(lite.etag, full.etag);
    const items = lite.body.items.slice();
    for (let p = 1; p < lite.body.pages; p++) items.push(...(await api(`/api/catalog?page=${p}&v=${encodeURIComponent(lite.etag)}&lite=1`)).body.items);
    assert.strictEqual(items.length, lite.body.total);
    const ch = items.find((x) => x.t === 'live'), film = items.find((x) => x.t === 'movie');
    assert.match(ch.u, /^~\w+~\d+\.ts$/);
    assert.strictEqual(lite.body.P[parseInt(ch.u.slice(1), 36)] + ch.u.split('~')[2], full.body.items.find((x) => x.k === ch.k).u);
    assert.strictEqual(film.u, undefined);
    assert.strictEqual(film.lz, 1);
    // Played: its address.
    const a = await api(`/api/addresses?keys=${encodeURIComponent(film.k)},nope`);
    assert.deepStrictEqual(a.body.items.map((x) => x.k), [film.k]);
    assert.strictEqual(a.body.items[0].u, full.body.items.find((x) => x.k === film.k).u);
    // (Not kept on the device, so never "just the changes": a whole answer.)
    assert.strictEqual((await api(`/api/catalog?lite=1&since=${encodeURIComponent(lite.etag)}`)).status, 200);
  } finally {
    app.kill(); pl.close();
  }
});
