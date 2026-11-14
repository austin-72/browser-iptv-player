// What's coming on a series' page (TMDB): episodes after the last one on the lists — still to air, or aired and not
// here yet — and the next one's date; and trailers (the provider's or TMDB's) for the Trailers page.
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
const day = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);

test('a series’ coming episodes and the next one’s date; trailers from TMDB', { timeout: 60000 }, async () => {
  const m3u = '#EXTM3U\n' +
    '#EXTINF:-1 group-title="Series",Night Desk S01 E01\nhttp://127.0.0.1:1/series/u/p/1.mkv\n' +
    '#EXTINF:-1 group-title="Series",Night Desk S01 E02\nhttp://127.0.0.1:1/series/u/p/2.mkv\n' +
    '#EXTINF:-1 group-title="Movies",Copper Creek (2024)\nhttp://127.0.0.1:1/movie/u/p/3.mp4\n';
  const pl = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); r.end(m3u); }).listen(0, '127.0.0.1');
  const ep = (n, air, name) => ({ episode_number: n, name: name || 'Episode ' + n, overview: 'Plot ' + n, air_date: air, runtime: 45, vote_average: 7.5 });
  const tm = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    const send = (j) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(j)); };
    if (u.pathname === '/search/tv') return send({ results: [{ id: 77, name: 'Night Desk', first_air_date: '2025-01-01' }] });
    if (u.pathname === '/search/movie') return send({ results: [{ id: 5, title: 'Copper Creek', release_date: '2024-02-02' }] });
    if (u.pathname === '/tv/77') return send({ id: 77, name: 'Night Desk', first_air_date: '2025-01-01', status: 'Returning Series', genres: [], seasons: [{ season_number: 1 }, { season_number: 2 }], next_episode_to_air: { season_number: 2, episode_number: 1, name: 'Return', air_date: day(9) }, credits: { cast: [], crew: [] }, content_ratings: { results: [] } });
    if (u.pathname === '/tv/77/season/1') return send({ episodes: [ep(1, '2025-01-01'), ep(2, '2025-01-08'), ep(3, day(-10), 'The Leak'), ep(4, day(3), 'Deadline')] });
    if (u.pathname === '/tv/77/season/2') return send({ episodes: [ep(1, day(9), 'Return'), ep(2, '')] });
    if (u.pathname === '/movie/5') return send({ id: 5, title: 'Copper Creek', release_date: '2024-02-02', genres: [], credits: { cast: [], crew: [] }, release_dates: { results: [] } });
    if (u.pathname === '/movie/5/videos') return send({ results: [{ site: 'YouTube', key: 'teaser12345', type: 'Teaser', official: true, iso_639_1: 'en' }, { site: 'YouTube', key: 'trailer1234', type: 'Trailer', official: true, iso_639_1: 'en' }, { site: 'Vimeo', key: 'x', type: 'Trailer' }] });
    r.writeHead(404); r.end('{}');
  }).listen(0, '127.0.0.1');
  await Promise.all([pl, tm].map((s) => new Promise((r) => s.listening ? r() : s.once('listening', r))));
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coming-'));
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test', TMDB_BASE: `http://127.0.0.1:${tm.address().port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  let cookie = '';
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-App': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie(); if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, body: j };
  };
  try {
    for (let i = 0; i < 300 && !/Ready/.test(out); i++) await wait(100);
    assert.match(out, /Ready/, out);
    await api('POST', '/api/login', { password: 'pw-test' });
    const me = await api('POST', '/api/profiles', { name: 'Alex', avatar: 1, pin: '1234' });
    assert.ok(me.body && me.body.id, JSON.stringify(me));
    await api('POST', '/api/admin/lists', { type: 'url', name: 'L', url: `http://127.0.0.1:${pl.address().port}/list.m3u` });
    let cat;
    for (let i = 0; i < 100; i++) { cat = (await api('GET', '/api/catalog')).body; if (cat && cat.items && cat.items.some((x) => x.t === 'show')) break; await wait(100); }
    const show = cat.items.find((x) => x.t === 'show'), film = cat.items.find((x) => x.t === 'movie');
    assert.ok(show && film, JSON.stringify(cat && cat.items && cat.items.map((x) => x.t + ':' + x.n)));
    assert.strictEqual((await api('PUT', '/api/admin/settings', { tmdbKey: 'testkey' })).status, 200);

    const d = (await api('GET', `/api/item/${encodeURIComponent(show.k)}`)).body;
    assert.deepStrictEqual(d.upcoming.map((e) => [e.s, e.e, e.out]), [[1, 3, true], [1, 4, false], [2, 1, false], [2, 2, false]], 'after the last one here: aired-not-here, then still to air (a new season too)');
    assert.strictEqual(d.upcoming[1].et, 'Deadline');
    assert.deepStrictEqual(d.next, { s: 2, e: 1, et: 'Return', air: day(9) });
    assert.strictEqual(d.episodes.length, 2, 'the playable ones: only those on the lists');
    assert.strictEqual(d.episodes[0].r, 7.5);

    // Trailers: TMDB's official trailer (not the teaser), for titles matched; nothing for a key it may not see.
    await api('GET', `/api/item/${encodeURIComponent(film.k)}`); // (matched)
    const t = (await api('GET', `/api/trailers?k=${encodeURIComponent(film.k)},nope`)).body;
    assert.deepStrictEqual(Object.keys(t), [film.k]);
    assert.strictEqual(t[film.k].v, 'trailer1234');
  } finally {
    app.kill(); pl.close(); tm.close();
  }
});
