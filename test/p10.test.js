// Home rows from Trakt / TMDB lists, the Wishlist and its alerts, the bell on series, and "Your viewing".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const integ = require('./mock/integrations');
const tmdbMock = require('./mock/tmdb');
const { HomeLists, parseSource } = require('../lib/homelists');
const { Wishlist } = require('../lib/wishlist');
const { Viewing } = require('../lib/viewing');
const { Trakt } = require('../lib/trakt');
const { Tmdb } = require('../lib/tmdb');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p10-'));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tl = (type, title, year, ids = {}) => ({ type, [type]: { title, year, ids } });

const TRAKT_LISTS = {
  'alex/sci-fi': { name: 'Sci-fi classics', items: [tl('movie', 'The Matrix', 1999, { trakt: 1, tmdb: 1, imdb: 'tt0133093' }), tl('movie', 'Inception', 2010, { tmdb: 2 }), tl('movie', 'Blade Runner', 1982, { tmdb: 7 }), tl('show', 'Night Train', 2021, { tmdb: 43 }), tl('movie', 'Interstellar', 2014, {}), { type: 'person', person: { name: 'Someone' } }] },
  'alex/secret': { name: 'Secret', private: true, items: [] },
  oscars: { name: 'Oscar winners', items: [tl('movie', 'Titanic', 1997, { tmdb: 5 })] },
};
const TRAKT_CHARTS = { movies: [tl('movie', 'Blade Runner', 1982, { tmdb: 7 }), tl('movie', 'Toy Story', 1995, { tmdb: 6 })] };

test('parseSource understands Trakt and TMDB links', () => {
  assert.deepStrictEqual(parseSource('https://trakt.tv/users/alex/lists/sci-fi?sort=rank,asc'), { kind: 'trakt-list', ref: 'alex/sci-fi' });
  assert.deepStrictEqual(parseSource('alex/sci-fi'), { kind: 'trakt-list', ref: 'alex/sci-fi' });
  assert.deepStrictEqual(parseSource('https://trakt.tv/lists/2142753'), { kind: 'trakt-list', ref: '2142753' });
  assert.deepStrictEqual(parseSource('https://trakt.tv/movies/trending'), { kind: 'trakt-chart', ref: 'movies/trending' });
  assert.deepStrictEqual(parseSource('https://www.themoviedb.org/list/7001-best-of-sci-fi'), { kind: 'tmdb-list', ref: '7001' });
  assert.deepStrictEqual(parseSource('https://www.themoviedb.org/collection/100-the-matrix-collection'), { kind: 'tmdb-collection', ref: '100' });
  assert.deepStrictEqual(parseSource('https://www.themoviedb.org/keyword/9715-superhero/movie'), { kind: 'tmdb-keyword', ref: '9715:movie' });
  assert.deepStrictEqual(parseSource({ kind: 'trakt-chart', ref: 'shows/popular' }), { kind: 'trakt-chart', ref: 'shows/popular' });
  assert.throws(() => parseSource('https://example.com/list'), /isn’t a Trakt or TMDB list/);
  assert.throws(() => parseSource(''), /Paste/);
  assert.throws(() => parseSource({ kind: 'trakt-chart', ref: 'movies/worst' }), /Unknown/);
});

/** A small catalogue with the shape lists and matching need. */
function fakeCatalog(list) {
  const c = { items: [], byKey: new Map(), version: '1' };
  c.set = (items) => { c.items = items; c.byKey = new Map(items.map((i) => [i.k, i])); c.version = String(+c.version + 1); };
  c.get = (k) => c.byKey.get(k) || null;
  c.findTitle = (n) => c.items.filter((i) => (i.t === 'movie' || i.t === 'show') && i.n.toLowerCase() === String(n).toLowerCase()).map((i) => i.k);
  c.filterFor = () => ({ test: (it) => !it.adult, sig: '' });
  c.visible = (p, k) => c.get(k);
  c.set(list);
  return c;
}

test('lists are fetched once, matched by id then title and year, and only what is here is shown', async () => {
  const m = await integ.start({ traktLists: TRAKT_LISTS, traktCharts: TRAKT_CHARTS, traktMine: { 'my-faves': { name: 'My faves', items: [tl('movie', 'Toy Story', 1995, { tmdb: 6 })] } } });
  const tm = await tmdbMock.start();
  const dir = tmp();
  try {
    const cat = fakeCatalog([
      { k: 'm1', t: 'movie', n: 'The Matrix', y: 1999, tmdb: '1' },
      { k: 'm7', t: 'movie', n: 'Blade Runner', y: 1983 }, // year off by one: still the same film
      { k: 'mi', t: 'movie', n: 'Interstellar', y: 2014 },
      { k: 'mx', t: 'movie', n: 'Inception', y: 2010, tmdb: '999' }, // same name, another film
      { k: 's43', t: 'show', n: 'Night Train', y: 2021 },
      { k: 'm6', t: 'movie', n: 'Toy Story', y: 1995 },
    ]);
    let conf = { clientId: '', clientSecret: '' };
    const trakt = new Trakt({ dataDir: dir, getConf: () => conf, fetch, base: m.traktBase, lib: { catalog: () => cat } });
    let key = '';
    const tmdb = new Tmdb({ dataDir: dir, getKey: () => key, base: tm.base });
    const hl = new HomeLists({ dataDir: dir, catalog: () => cat, tmdb, trakt });
    const vis = () => true;

    await assert.rejects(hl.addRow('p1', 'alex/sci-fi'), /Trakt app.*Client ID is enough/);
    await assert.rejects(hl.addRow('p1', 'https://www.themoviedb.org/list/7001'), /TMDB key/);
    conf = { clientId: 'cid', clientSecret: '' }; // public lists: the client id alone
    const r = await hl.addRow('p1', 'https://trakt.tv/users/alex/lists/sci-fi');
    assert.strictEqual(r.row.name, 'Sci-fi classics');
    const [row] = hl.rowsView({ id: 'p1' }, vis);
    assert.strictEqual(row.total, 5, 'people are skipped');
    assert.deepStrictEqual(row.keys, ['m1', 'm7', 's43', 'mi'], 'Inception here is another film (different TMDB id)');
    assert.strictEqual(row.here, 4);
    const full = hl.fullView({ id: 'p1' }, row.id, vis);
    assert.deepStrictEqual(full.items.filter((x) => !x.k).map((x) => x.n), ['Inception']);
    // The same list for another profile: no second fetch.
    const reads = m.state.trakt.listReads;
    await hl.addRow('p2', 'alex/sci-fi');
    assert.strictEqual(m.state.trakt.listReads, reads);
    assert.strictEqual((await hl.addRow('p1', 'alex/sci-fi')).existed, true);
    // Visibility per profile.
    assert.strictEqual(hl.rowsView({ id: 'p2' }, (k) => k !== 'm1')[0].here, 3);
    await assert.rejects(hl.addRow('p1', 'alex/secret'), /doesn’t know that list/);
    await assert.rejects(hl.addRow('p1', 'trakt.tv/users/alex/lists/nope'), /doesn’t know/);
    // Charts.
    const ch = await hl.addRow('p1', { kind: 'trakt-chart', ref: 'movies/popular' });
    assert.strictEqual(ch.row.name, 'Popular films on Trakt');
    assert.deepStrictEqual(hl.rowsView({ id: 'p1' }, vis).find((x) => x.id === ch.row.id).keys, ['m7', 'm6']);
    // The profile's own Trakt lists need it connected.
    await assert.rejects(hl.addRow('p1', { kind: 'trakt-mine', ref: 'my-faves' }), /Connect Trakt/);
    trakt.store.data.profiles.p1 = { access: m.state.trakt.token, refresh: 'r', expires: Date.now() + 30 * 86400e3, opts: {} };
    assert.deepStrictEqual((await hl.myTraktLists('p1')).map((l) => l.ref), ['my-faves']);
    const mine = await hl.addRow('p1', { kind: 'trakt-mine', ref: 'my-faves' });
    assert.strictEqual(mine.row.name, 'My faves');

    // TMDB: a list (several pages), a collection and a keyword.
    key = 'testkey';
    const tl1 = await hl.addRow('p1', 'https://www.themoviedb.org/list/7001-best-of-sci-fi');
    const v1 = hl.rowsView({ id: 'p1' }, vis).find((x) => x.id === tl1.row.id);
    assert.strictEqual(v1.total, 5);
    assert.deepStrictEqual(v1.keys, ['m1', 'mi', 'm7', 's43']);
    assert.ok(hl.fullView({ id: 'p1' }, tl1.row.id, vis).items.find((x) => x.n === 'Inception').p.startsWith('https://image.tmdb.org/'));
    const col = await hl.addRow('p1', 'https://www.themoviedb.org/collection/100');
    assert.strictEqual(col.row.name, 'The Matrix Collection');
    const kw = await hl.addRow('p1', 'https://www.themoviedb.org/keyword/9715-superhero');
    assert.match(kw.row.name, /Superhero \(films\)/);

    // A new copy of the catalogue: matched again (the TMDB id now decides).
    cat.set(cat.items.concat([{ k: 'm2', t: 'movie', n: 'Inception', y: 2010, tmdb: '2' }]));
    assert.ok(hl.rowsView({ id: 'p1' }, vis)[0].keys.includes('m2'));

    // Refresh: lists more than a day old are fetched again; unused ones are forgotten after a week.
    const src = hl.store.data.sources['trakt-list:alex/sci-fi'];
    src.at = Date.now() - 2 * 86400e3; src.tried = 0;
    TRAKT_LISTS['alex/sci-fi'].items.push(tl('movie', 'Titanic', 1997, { tmdb: 5 }));
    await hl.refreshDue({ gap: 0 });
    assert.strictEqual(hl.store.data.sources['trakt-list:alex/sci-fi'].n, 6);
    hl.removeRow('p1', r.row.id); hl.removeRow('p2', r.row.id);
    hl.store.data.sources['trakt-list:alex/sci-fi'].at = Date.now() - 8 * 86400e3;
    hl.store.data.sources['trakt-list:alex/sci-fi'].tried = 0;
    await hl.refreshDue({ gap: 0 });
    assert.ok(!hl.store.data.sources['trakt-list:alex/sci-fi'], 'unused and old: forgotten');
  } finally { m.close(); tm.close(); }
});

test('wishlist: arrivals, one alert per title, the bell', () => {
  const dir = tmp();
  const wl = new Wishlist(dir);
  const a = wl.add('p1', { t: 'movie', n: 'Inception', y: 2010, tmdb: '2' });
  assert.strictEqual(wl.add('p1', { t: 'movie', n: 'inception', y: 2010, tmdb: '2' }).id, a.id, 'no duplicates');
  wl.add('p1', { t: 'tv', n: 'Unaired Saga', y: 2026 });
  assert.strictEqual(wl.of('p1').wish.length, 2);
  assert.strictEqual(wl.of('p1').wish[1].t, 'movie');
  let got = wl.arrivals((w) => (w.tmdb === '2' ? 'm2' : null));
  assert.deepStrictEqual(got.get('p1').map((x) => x.k), ['m2']);
  assert.strictEqual(wl.arrivals((w) => (w.tmdb === '2' ? 'm2' : null)).size, 0, 'only once');
  // Episode alerts for one series gather into one unread alert.
  wl.alert('p1', { kind: 'episode', k: 's1', show: 'Night Train', title: 'New episode of Night Train', n: 1, eps: ['e1'] });
  wl.alert('p1', { kind: 'episode', k: 's1', show: 'Night Train', title: 'New episode of Night Train', n: 1, eps: ['e2'] });
  wl.alert('p1', { kind: 'wish', k: 'm2', title: 'Inception is here' }, { seen: true });
  assert.strictEqual(wl.alerts('p1').length, 2);
  assert.strictEqual(wl.alerts('p1')[1].title, '2 new episodes of Night Train');
  assert.strictEqual(wl.unread('p1'), 2);
  assert.deepStrictEqual(wl.takeUnseen('p1').map((x) => x.k), ['s1'], 'the profile wasn’t online for that one');
  assert.strictEqual(wl.takeUnseen('p1').length, 0);
  wl.markRead('p1', 'all');
  assert.strictEqual(wl.unread('p1'), 0);
  wl.alert('p1', { kind: 'episode', k: 's1', show: 'Night Train', title: 'New episode of Night Train', n: 1, eps: ['e3'] });
  assert.strictEqual(wl.alerts('p1').length, 3, 'read ones stay; a new one starts');
  wl.setFollow('p1', 's9', true);
  assert.deepStrictEqual(wl.follows('p1'), ['s9']);
  wl.setFollow('p1', 's9', false);
  assert.ok(wl.muted('p1', 's9'));
  assert.deepStrictEqual(wl.follows('p1'), []);
  wl.setFollow('p1', 's9', null);
  assert.ok(!wl.muted('p1', 's9'));
});

test('viewing: daily totals, streaks, periods and a year in review', () => {
  const dir = tmp();
  const cat = fakeCatalog([
    { k: 'ch1', t: 'live', n: 'News One' }, { k: 'f1', t: 'movie', n: 'Iron Meridian', gn: ['Action'] },
    { k: 's1', t: 'show', n: 'Harbor Lights', gn: ['Crime', 'Drama'] }, { k: 'e1', t: 'episode', n: 'Harbor Lights S01E01', sk: 's1' },
  ]);
  const DAY = 86400e3;
  // Existing history (newest first) fills in what came before.
  const now = Date.now();
  const user = { history: [{ k: 'e1', at: now - 2 * DAY, s: 1800, t: 'episode', sk: 's1' }, { k: 'ch1', at: now - 3 * DAY, s: 600, t: 'live' }], progress: { f1: { w: true, t: 'movie', at: now - 3 * DAY } } };
  const userdata = { of: () => ({ data: user }) };
  const v = new Viewing({ dataDir: dir, catalog: () => cat, userdata });
  const D = v.of('p1').data;
  assert.ok(D.seeded);
  const sum0 = Object.values(D.days).reduce((a, d) => a + d.s, 0);
  assert.strictEqual(sum0, 2400);
  v.record('p1', { k: 'f1', s: 3000, t: 'movie' });
  v.record('p1', { k: 'e1', s: 1200, t: 'episode', sk: 's1' });
  v.record('p1', { k: 'ch1', s: 999999, t: 'live' }); // (capped at 4 hours a sitting)
  v.finished('p1');
  cat.set(cat.items.concat([{ k: 'f9', t: 'movie', n: 'Timing Test' }]));
  v.record('p1', { k: 'f9', s: 20, t: 'movie' }); // (a moment's look: counted in the time, not listed)
  const yest = now - DAY;
  v.record('p1', { k: 'ch1', s: 300, t: 'live' }, yest);
  const w = v.summary('p1', 'month');
  assert.ok(w.total.s >= 3000 + 1200 + 4 * 3600);
  assert.strictEqual(w.total.f >= 1, true);
  assert.strictEqual(w.films[0].n, 'Iron Meridian');
  assert.ok(!w.films.some((x) => x.k === 'f9'), 'items under a minute aren’t listed');
  assert.strictEqual(w.shows[0].n, 'Harbor Lights', 'episodes count for their series');
  assert.strictEqual(w.channels[0].n, 'News One');
  assert.ok(w.genres.some((g) => g.g === 'Crime'));
  assert.ok(v.longestStreak(D) >= 2);
  assert.strictEqual(v.currentStreak(D) >= 2, true);
  const wk = v.summary('p1', 'week');
  assert.strictEqual(wk.series.length, 7);
  const yr = v.summary('p1', 'year');
  assert.strictEqual(yr.series.length, 12);
  // Last year: nothing, but it still answers.
  const r = v.review('p1', new Date().getFullYear() - 1);
  assert.strictEqual(r.total.s, 0);
  assert.strictEqual(r.months.length, 12);
  const rt = v.review('p1', new Date().getFullYear());
  assert.ok(rt.total.s > 0);
  assert.strictEqual(rt.films[0].k, 'f1');
  // Names survive the title leaving the lists.
  cat.set([]);
  assert.strictEqual(v.review('p1', new Date().getFullYear()).films[0].n, 'Iron Meridian');
  // Small: old detail is dropped.
  D.days['2020-01-01'] = { s: 5, h: { 1: 5 }, i: { x: 5 } };
  D._pruned = '';
  v._prune(D);
  assert.ok(!D.days['2020-01-01']);
});

// ---- the real server
function client(base) {
  let cookie = '';
  return async (method, p, body) => {
    const h = { 'X-App': '1' };
    if (cookie) h.Cookie = cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, body: j, text: t };
  };
}

test('the real server: list rows, wishlist arrivals, the bell and your viewing', { timeout: 120000 }, async () => {
  const m = await integ.start({ traktLists: TRAKT_LISTS, traktCharts: TRAKT_CHARTS });
  const tm = await tmdbMock.start();
  const entry = (name, url, group) => `#EXTINF:-1 group-title="${group}",${name}\n${url}\n`;
  let m3u = '#EXTM3U\n' + entry('News One', 'http://127.0.0.1:1/live/1.m3u8', 'News') + entry('The Matrix (1999)', 'http://127.0.0.1:1/movie/1.mp4', 'Films') + entry('Blade Runner (1982)', 'http://127.0.0.1:1/movie/7.mp4', 'Films') +
    entry('Night Train S01E01', 'http://127.0.0.1:1/series/nt1.mp4', 'Series') + entry('Harbor Lights S01E01', 'http://127.0.0.1:1/series/hl1.mp4', 'Series');
  const pl = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); r.end(m3u); }).listen(0, '127.0.0.1');
  await new Promise((r) => pl.once('listening', r));
  const port = await freePort();
  const dir = tmp();
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test', TRAKT_BASE: m.traktBase, TMDB_BASE: tm.base }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const api = client(`http://127.0.0.1:${port}`);
  try {
    for (let i = 0; i < 100 && !/Ready/.test(out); i++) await wait(100);
    assert.strictEqual((await api('POST', '/api/login', { password: 'pw-test' })).status, 200);
    assert.ok((await api('POST', '/api/profiles', { name: 'Alex', pin: '1234', avatar: 1 })).body.admin);
    const added = await api('POST', '/api/admin/lists', { type: 'url', name: 'Test', url: `http://127.0.0.1:${pl.address().port}/list.m3u` });
    assert.strictEqual(added.status, 200, added.text);
    let cat;
    for (let i = 0; i < 50; i++) { cat = (await api('GET', '/api/catalog')).body; if (cat && cat.items && cat.items.length >= 5) break; await wait(200); }
    const key = (n) => (cat.items.find((x) => x.n === n) || {}).k;
    const nightTrain = key('Night Train'), harbor = key('Harbor Lights'), matrix = key('The Matrix'), news = key('News One');
    assert.ok(nightTrain && harbor && matrix && news, JSON.stringify(cat.items.map((x) => x.n)));
    // The bell: follow Night Train (not in My List, never watched); mute Harbor Lights.
    assert.deepStrictEqual((await api('PUT', `/api/series-follow/${encodeURIComponent(nightTrain)}`, { on: true })).body, { follow: true, mute: false });
    await api('PUT', `/api/series-follow/${encodeURIComponent(harbor)}`, { on: false });
    await api('POST', '/api/me/list', {}).catch(() => {});
    assert.strictEqual((await api('POST', '/api/toggle', { field: 'list', k: harbor, on: true })).status, 200);

    // Nothing set up yet: clear messages.
    let r = await api('POST', '/api/homelists/rows', { text: 'alex/sci-fi' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /Admin → Integrations/);
    assert.strictEqual((await api('GET', '/api/wishlist/search?q=incep')).status, 400);
    assert.strictEqual((await api('PUT', '/api/admin/integrations', { trakt: { clientId: 'cid' } })).status, 200);
    assert.deepStrictEqual((await api('GET', '/api/boot')).body.homeLists, { trakt: true, tmdb: false });
    r = await api('POST', '/api/homelists/rows', { text: 'https://trakt.tv/users/alex/lists/sci-fi' });
    assert.strictEqual(r.status, 200, r.text);
    const rowId = r.body.row.id;
    let rows = (await api('GET', '/api/homelists')).body.rows;
    assert.strictEqual(rows[0].name, 'Sci-fi classics');
    assert.deepStrictEqual(rows[0].keys, [matrix, key('Blade Runner'), nightTrain]);
    assert.ok(rows[0].total >= 5);
    r = await api('POST', '/api/homelists/rows', { text: 'https://www.themoviedb.org/list/7001' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /TMDB key/);
    // The whole list: the missing ones can go on the wishlist.
    let full = (await api('GET', `/api/homelists/rows/${rowId}`)).body;
    const missing = full.items.filter((x) => !x.k);
    assert.ok(missing.some((x) => x.n === 'Inception'));
    r = await api('POST', '/api/wishlist', { t: 'movie', n: 'Inception', y: 2010, tmdb: '2' });
    assert.ok(r.body.item.id);
    assert.ok((await api('GET', `/api/homelists/rows/${rowId}`)).body.items.find((x) => x.n === 'Inception').wished);
    assert.strictEqual((await api('POST', '/api/wishlist', { t: 'movie', n: 'The Matrix', y: 1999 })).body.here, matrix, 'already here');

    // With a TMDB key: TMDB rows and searching for anything.
    assert.strictEqual((await api('PUT', '/api/admin/settings', { tmdbKey: 'testkey' })).status, 200);
    r = await api('POST', '/api/homelists/rows', { text: 'https://www.themoviedb.org/list/7001-best-of-sci-fi', name: 'Sci-fi (TMDB)' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.row.name, 'Sci-fi (TMDB)');
    const s = (await api('GET', '/api/wishlist/search?q=unaired')).body.results;
    assert.deepStrictEqual(s.map((x) => [x.t, x.n, x.y]), [['show', 'Unaired Saga', 2026]]);
    assert.ok((await api('GET', '/api/wishlist/search?q=matrix')).body.results.find((x) => x.n === 'The Matrix').k, 'says when it’s here');
    await api('POST', '/api/wishlist', s[0]);
    assert.strictEqual((await api('GET', '/api/wishlist')).body.list.length, 2);

    // Watching: a film to the end, some live TV.
    await api('POST', '/api/played', { k: matrix, s: 900, t: 'movie' });
    await api('POST', '/api/progress', { k: matrix, p: 7000, d: 7200, t: 'movie' });
    await api('POST', '/api/played', { k: news, s: 600, t: 'live' });
    const v = (await api('GET', '/api/viewing?period=week')).body;
    assert.strictEqual(v.total.s, 1500);
    assert.strictEqual(v.total.m, 900);
    assert.strictEqual(v.total.l, 600);
    assert.strictEqual(v.total.f, 1);
    assert.strictEqual(v.channels[0].k, news);
    const hh = (await api('GET', '/api/admin/viewing?period=week')).body;
    assert.strictEqual(hh.total.s, 1500);
    assert.strictEqual(hh.people[0].name, 'Alex');
    const thisYear = new Date().getFullYear();
    assert.strictEqual((await api('GET', `/api/viewing/review?year=${thisYear - 1}`)).status, 200);
    assert.strictEqual((await api('GET', `/api/viewing/review?year=${thisYear}`)).status, new Date().getMonth() === 11 ? 200 : 400);

    // The first new-episode check (20 s after the catalogue was built) learns what each followed series has.
    await wait(23000);
    // A refresh brings Inception, a Night Train episode and a Harbor Lights one.
    m3u += entry('Inception (2010)', 'http://127.0.0.1:1/movie/2.mp4', 'Films') + entry('Night Train S01E02', 'http://127.0.0.1:1/series/nt2.mp4', 'Series') + entry('Harbor Lights S01E02', 'http://127.0.0.1:1/series/hl2.mp4', 'Series');
    assert.strictEqual((await api('POST', `/api/admin/lists/${added.body.id}/refresh`)).status, 200);
    let alerts;
    for (let i = 0; i < 60; i++) { alerts = (await api('GET', '/api/alerts')).body; if (alerts.list.some((a) => a.kind === 'wish')) break; await wait(250); }
    assert.ok(alerts.list.find((a) => a.kind === 'wish' && a.title === 'Inception is here'), JSON.stringify(alerts));
    assert.ok((await api('GET', '/api/wishlist')).body.list.find((w) => w.n === 'Inception').k);
    rows = (await api('GET', '/api/homelists')).body.rows;
    assert.ok(rows.find((x) => x.id === rowId).keys.length === 4, 'Inception now shows in the row');
    for (let i = 0; i < 120; i++) { alerts = (await api('GET', '/api/alerts')).body; if (alerts.list.some((a) => a.kind === 'episode')) break; await wait(250); }
    const eps = alerts.list.filter((a) => a.kind === 'episode');
    assert.deepStrictEqual(eps.map((a) => a.title), ['New episode of Night Train'], 'followed: yes; muted Harbor Lights: no');
    assert.strictEqual(alerts.unread, 2);
    const unseen = (await api('GET', '/api/alerts/unseen')).body.list;
    assert.strictEqual(unseen.length, 2, 'no device was connected: they wait');
    assert.strictEqual((await api('GET', '/api/alerts/unseen')).body.list.length, 0);
    assert.strictEqual((await api('POST', '/api/alerts/read', { all: true })).body.unread, 0);

    // Removing the row; settings to turn wishlist alerts off are kept per profile.
    assert.strictEqual((await api('DELETE', `/api/homelists/rows/${rowId}`)).status, 200);
    assert.strictEqual((await api('GET', '/api/homelists')).body.rows.length, 1);
    assert.strictEqual((await api('PUT', '/api/me/prefs', { wishlistAlerts: false })).body.wishlistAlerts, false);
  } finally {
    app.kill();
    pl.close();
    m.close(); tm.close();
  }
});
