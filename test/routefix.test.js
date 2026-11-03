// Fixes in routes p1/p6, picture subtitles, statistics, "Your viewing", 24/7 channels, parental PIN, playlist and
// title parsing: bodies that aren't objects, data that could grow without end, ffmpeg jobs left running, schedules
// that jumped on a rebuild, PIN guessing from new sessions.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'routefix-'));
// (Pending saves written now, so the test process can end.)
test.after(() => require('../lib/store').JsonFile.flushAll());
const HttpError = class extends Error { constructor(status, msg) { super(msg); this.status = status; } };

test('open in another app: a body of null is a 404 for "nothing", not a crash', async () => {
  const routes = {};
  require('../lib/routes-p1')({
    route: (m, pat, fn) => { routes[m + ' ' + pat] = fn; },
    requireProfile: (ctx) => ctx.profile, readJSON: async (req) => req.body, HttpError,
    item: (ctx, k) => { throw new HttpError(404, `no ${JSON.stringify(k)}`); },
    inputOf: () => null, isUrl: () => true, proxy: {}, castSign: (x) => x, siteOrigin: () => '', settings: () => ({}),
  });
  await assert.rejects(routes['POST /api/play/external']({ body: null }, {}, {}, null, { profile: { id: 'p' } }), (e) => e.status === 404);
});

test('picture subtitles: stopping the server stops their ffmpeg jobs too; a failed job’s packets are a 404', async () => {
  const dir = tmp();
  let mediaStopped = 0;
  const media = { cacheDir: dir, available: false, stopAll() { mediaStopped++; } };
  const { pics } = require('../lib/routes-p6')({ route: () => {}, item: () => null, inputOf: () => null, connLimit: () => 0, media, lists: null });
  const proc = spawn('sleep', ['30'], { stdio: 'ignore' });
  const gone = new Promise((r) => proc.on('exit', r));
  pics.jobs.set('h1', { h: 'h1', done: false, err: '', tracks: {}, at: Date.now(), proc, fds: {} });
  media.stopAll();
  assert.strictEqual(mediaStopped, 1, 'the media sessions still stop');
  await gone;
  assert.ok(proc.killed && !pics.jobs.has('h1'));
  // An extraction that failed (its files removed) but is still remembered: no packets, no exception.
  const h = pics.key('http://p/film.mkv');
  pics.jobs.set(h, { h, done: true, err: 'x', tracks: { 0: { kind: 'pgs', idx: [[0, 1, 0, 10, 2]], size: 10 } }, at: Date.now() });
  assert.strictEqual(pics.read('http://p/film.mkv', 0, 0, 10), null);
  clearInterval(pics._reaper);
});

test('statistics: places the player makes up are capped per day; open plays are capped', () => {
  const { Stats } = require('../lib/stats');
  const s = new Stats(tmp());
  for (let i = 0; i < 400; i++) s.play({ route: 'direct', host: `made-up-${i}.example.com`, profile: 'p1' });
  const day = Object.values(s.store.data.days)[0];
  assert.ok(Object.keys(day.places).length <= 201, `${Object.keys(day.places).length} places`);
  assert.strictEqual(Object.values(day.places).reduce((a, x) => a + x.plays, 0), 400, 'every play still counted');
  for (let i = 0; i < 20100; i++) s.open.set('x' + i, { seen: Date.now() });
  s.play({ route: 'direct', host: 'localhost', profile: 'p1' });
  assert.ok(s.open.size <= 20000);
});

test('your viewing: junk keys are ignored, and names of trimmed-away items don’t pile up', () => {
  const { Viewing } = require('../lib/viewing');
  const cat = { get: () => null };
  const v = new Viewing({ dataDir: tmp(), catalog: () => cat, userdata: { of: () => ({ data: { history: [], progress: {} } }) } });
  v.record('p1', { k: 'x'.repeat(5000), s: 600, t: 'movie' });
  v.record('p1', { k: { a: 1 }, s: 600, t: 'movie' });
  const D = v.of('p1').data;
  assert.deepStrictEqual(Object.keys(D.names), []);
  for (let i = 0; i < 2000; i++) v.record('p1', { k: 'k' + i, s: 60 + i, t: 'movie', n: 'Film ' + i });
  const used = new Set();
  for (const d of Object.values(D.days)) for (const k of Object.keys(d.i || {})) used.add(k);
  for (const m of Object.values(D.months)) for (const k of Object.keys(m.i || {})) used.add(k);
  assert.ok(Object.keys(D.names).length <= used.size + 1, `${Object.keys(D.names).length} names for ${used.size} items`);
});

test('24/7 channels: settings that aren’t an object are a 400; a rebuild keeps what’s on now in its slot', { timeout: 20000 }, async () => {
  const { Lists } = require('../lib/lists');
  const { Catalog } = require('../lib/catalog');
  const { MyChannels } = require('../lib/mychannels');
  const settings = () => ({ userAgent: 'test', tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [], epgDays: 2, defaultLangs: [] });
  const lists = new Lists({ dir: tmp(), media: {}, getSettings: settings });
  const items = [];
  for (let i = 1; i <= 8; i++) items.push({ name: `Drama Film ${i} (${2000 + i})`, type: 'movie', url: `http://p/d${i}.mp4`, group: 'Drama', lang: 'en', duration: 3000 + i * 300 });
  lists.store.data.lists = [{ id: 'L', name: 'L', enabled: true, type: 'm3u' }];
  lists.parsed.set('L', { items: items.slice(), epgUrls: [] });
  const cat = new Catalog({ lists, epg: { has: () => false, resolve: () => null }, getSettings: settings });
  const mc = new MyChannels({ dir: lists.dir, catalog: cat, lists, tmdb: null, getSettings: settings });
  mc.register();
  cat.build();
  for (const bad of [null, 5, 'x', []]) await assert.rejects(mc.create(bad), (e) => e.status === 400);
  const ch = await mc.create({ name: 'Drama', source: { type: 'category', value: 'Drama', kind: 'movie' }, order: 'order' });
  await assert.rejects(mc.update(ch.id, null), (e) => e.status === 400);
  const c = mc.get(ch.id);
  const t = Date.now();
  const before = await mc.now(ch.id, () => true, t);
  // A film that comes before the one on now leaves the catalogue: the channel is rebuilt without it.
  const at = c.entries.findIndex((e) => e[0] === before.item.k);
  const drop = cat.get(c.entries[(at + c.entries.length - 1) % c.entries.length][0]);
  lists.parsed.set('L', { items: items.filter((x) => x.url !== drop.u), epgUrls: [] });
  cat.build();
  await mc.build(ch.id);
  assert.strictEqual(c.entries.length, 7);
  const after = await mc.now(ch.id, () => true, t);
  assert.strictEqual(after.item.k, before.item.k, 'the same film is still on');
  assert.strictEqual(after.start, before.start);
  assert.strictEqual(Math.round(after.offset), Math.round(before.offset));
});

test('parental PIN: wrong guesses count per profile too, so new sessions don’t get new tries', () => {
  const { Overrides } = require('../lib/overrides');
  const o = new Overrides(tmp());
  o.setPin('4321');
  const teen = { id: 'teen' };
  for (let i = 0; i < 5; i++) assert.throws(() => o.unlock('sess-' + i, teen, '0000'), (e) => e.status === 403);
  assert.throws(() => o.unlock('sess-new', teen, '4321'), (e) => e.status === 429, 'locked out on a fresh session too');
  assert.ok(o.unlock('sess-other', { id: 'parent' }, '4321') > Date.now(), 'other profiles aren’t affected');
});

test('playlists and titles: a bad number entity in XSPF, and very long names, don’t fail or stall', () => {
  const P = require('../lib/parse');
  const r = P.parse('<playlist><trackList><track><title>A &#99999999; &amp; B</title><location>http://x/a.mp3</location></track></trackList></playlist>', '');
  assert.strictEqual(r.items[0].name, 'A &#99999999; & B');
  const T = require('../lib/titles');
  const t0 = Date.now();
  T.tidyVod('a' + ' -'.repeat(20000) + 'x1');
  assert.ok(Date.now() - t0 < 500, `${Date.now() - t0} ms`);
  assert.deepStrictEqual(T.tidyVod('EN - Apollo 13 (1995) TOM HANKS').n, 'Apollo 13');
});
