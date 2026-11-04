'use strict';
// Fixes: 24/7 channels' guide and "what's on" respect each profile's restrictions; HLS playlists are read with a size limit; media folders don't serve files through symlinks that
// lead out of them; screen time on the night the clocks change, and a bedtime after midnight.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Lists } = require('../lib/lists');
const { Catalog } = require('../lib/catalog');
const { MyChannels } = require('../lib/mychannels');

const tmp = (p = 'kidsfix-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const settings = () => ({ userAgent: 'test', tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [], epgDays: 1, defaultLangs: [] });
const KIDS = { id: 'kid', name: 'Kid', kids: true, restrictions: { types: [], maxCert: 1, adult: false, blockedGroups: [] } };
const GROWN = { id: 'mum', name: 'Mum', restrictions: { types: [], maxCert: '', adult: true, blockedGroups: [] } };

function base() {
  const items = [
    { name: 'Happy Bunny (2010)', type: 'movie', url: 'http://p/k1.mp4', group: 'Kids Movies', lang: 'en', duration: 3600 },
    { name: 'Late Night Film (2011)', type: 'movie', url: 'http://p/a1.mp4', group: 'Adults', lang: 'en', duration: 3600 },
  ];
  const lists = new Lists({ dir: tmp(), media: {}, getSettings: settings });
  lists.store.data.lists = [{ id: 'L', name: 'L', enabled: true, type: 'm3u' }];
  lists.parsed.set('L', { items, epgUrls: [] });
  const cat = new Catalog({ lists, epg: { has: () => false, resolve: () => null }, getSettings: settings });
  cat.build();
  const kidK = cat.items.find((i) => i.n === 'Happy Bunny').k, adultK = cat.items.find((i) => i.n === 'Late Night Film').k;
  assert.ok(cat.get(adultK).adult && cat.get(kidK).kids);
  return { lists, cat, kidK, adultK };
}
const family = async (mc, cat, kidK, adultK) => {
  const ch = await mc.create({ name: 'Family Time', group: 'Kids', source: { type: 'titles', keys: [kidK, adultK] }, order: 'order' });
  cat.build();
  return ch;
};

async function channels() {
  const { lists, cat, kidK, adultK } = base();
  let profiles = [];
  const mc = new MyChannels({ dir: lists.dir, catalog: cat, lists, tmdb: null, getSettings: settings, profiles: () => profiles });
  mc.register();
  const ch = await family(mc, cat, kidK, adultK);
  return { mc, cat, ch, setProfiles: (p) => { profiles = p; } };
}

test('My channels: the shared guide never names a title a profile watching the channel may not see', { timeout: 20000 }, async () => {
  const { mc, cat, ch, setProfiles } = await channels();
  const titles = async () => new Set((await mc.guide()).programmes[`mych.${ch.id}`].map((p) => p.t));
  const chan = cat.items.find((i) => i.u === `mych:${ch.id}`);
  assert.ok(cat.visible(KIDS, chan.k), 'the channel (in a Kids group) is on the kids profile');
  // Before: the guide named the adult film to everyone, the kids profile included.
  setProfiles([KIDS, GROWN]);
  let t = await titles();
  assert.ok(t.has('Happy Bunny'));
  assert.ok(!t.has('Late Night Film'), 'not named while a kids profile can see the channel');
  // Only grown-ups who may see it: named.
  setProfiles([GROWN]);
  t = await titles();
  assert.ok(t.has('Late Night Film'));
  // (No profiles known, e.g. the old tests: unchanged.)
  setProfiles([]);
  assert.ok((await titles()).has('Late Night Film'));
});

test('My channels: what’s on now for a profile, and a channel the profile can’t see', { timeout: 20000 }, async () => {
  const { lists, cat, kidK, adultK } = base();
  const routes = new Map();
  const { HttpError } = require('../lib/util');
  // The route as server.js registers it.
  const p4 = require('../lib/routes-p4')({
    route: (m, pat, h) => routes.set(m + ' ' + pat, h), requireProfile: (ctx) => ctx.profile, requireAdmin: () => {}, readJSON: async () => ({}),
    HttpError, catalog: cat, lists, accounts: { profiles: [KIDS, GROWN], profile: () => null }, dataDir: lists.dir, settings, Catalog,
    epg: {}, media: {}, userdata: { of: () => ({ data: {} }) }, listUsage: () => new Map(), ready: () => null,
  });
  const mc = p4.mych;
  const ch = await family(mc, cat, kidK, adultK);
  const now = routes.get('GET /api/mychannels/:id/now');
  const q = (t) => new URLSearchParams(t ? { t: String(t) } : {});
  const c = mc.get(ch.id);
  // A time when the adult film is on: the kids profile gets the next thing it may see instead.
  const startOfAdult = c.start + (c.entries[0][0] === adultK ? 0 : c.entries[0][1] * 1000) + 60e3;
  const kid = await now(null, null, { id: ch.id }, q(startOfAdult), { profile: KIDS });
  assert.notStrictEqual(kid.item.k, adultK);
  assert.ok(!kid.next || kid.next.k !== adultK);
  const mum = await now(null, null, { id: ch.id }, q(startOfAdult), { profile: GROWN });
  assert.strictEqual(mum.item.k, adultK);
  // A channel not on this profile at all (not in a kids group): refused.
  const other = await mc.create({ name: 'Grown-up Films', group: 'Films', source: { type: 'titles', keys: [kidK, adultK] } });
  cat.build();
  await assert.rejects(now(null, null, { id: other.id }, q(), { profile: KIDS }), (e) => e.status === 404);
});

test('HLS playlists are read with a size limit (a provider sending without end)', { timeout: 20000 }, async () => {
  const { readCapped } = require('../lib/conntest');
  const { probe } = require('../lib/health');
  let closed = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === '/master.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nendless.m3u8\n'); }
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.on('close', () => closed++);
    const chunk = Buffer.alloc(64 * 1024, '#');
    const more = () => { while (!res.destroyed && res.write(chunk)); if (!res.destroyed) res.once('drain', more); };
    more();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const before = process.memoryUsage().rss;
    await assert.rejects(readCapped(await fetch(base + '/endless.m3u8'), 2 * 1024 * 1024), /more than expected/);
    for (let i = 0; i < 40 && !closed; i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(closed >= 1, 'the connection was let go');
    const r = await probe(base + '/master.m3u8', {}, { fetch, timeout: 10000 });
    assert.strictEqual(r.ok, false);
    assert.match(r.err, /more than expected/);
    assert.ok(process.memoryUsage().rss - before < 200 * 1024 * 1024);
    // A normal playlist is read whole.
    const small = await readCapped({ body: new Response('#EXTM3U\nseg1.ts\n').body });
    assert.strictEqual(small.toString(), '#EXTM3U\nseg1.ts\n');
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('media folders: nothing is listed or served through a symlink that leads out of the folder', async () => {
  const { Library } = require('../lib/library');
  const real = tmp('kidsfix-media-');
  const outside = tmp('kidsfix-out-');
  fs.writeFileSync(path.join(outside, 'Secret (2001).mp4'), 'secret');
  fs.mkdirSync(path.join(outside, 'More'));
  fs.writeFileSync(path.join(outside, 'More', 'Other (2002).mp4'), 'x');
  fs.writeFileSync(path.join(outside, 'private.jpg'), 'jpg');
  fs.mkdirSync(path.join(real, 'Films'));
  fs.writeFileSync(path.join(real, 'Films', 'Good (2003).mp4'), 'ok');
  fs.writeFileSync(path.join(real, 'Films', 'Kept (2004).mp4'), 'ok');
  fs.symlinkSync(path.join(real, 'Films', 'Good (2003).mp4'), path.join(real, 'Alias (2005).mp4')); // inside: fine
  fs.symlinkSync(path.join(outside, 'Secret (2001).mp4'), path.join(real, 'Films', 'Secret (2001).mp4'));
  fs.symlinkSync(path.join(outside, 'More'), path.join(real, 'More'));
  // The folder the admin added is itself a symlink (a mounted drive, say): still works.
  const root = path.join(tmp('kidsfix-link-'), 'media');
  fs.symlinkSync(real, root);
  const store = { data: { items: {}, scannedAt: null }, save() {} };
  const lib = new Library({ folders: () => [root], store, media: { probeAvailable: false, thumbnail: async () => { throw new Error('no ffmpeg'); } }, thumbDir: tmp() });
  await lib.scan();
  const titles = lib.items().map((i) => i.title).sort();
  assert.deepStrictEqual(titles, ['Alias', 'Good', 'Kept']);
  const good = lib.items().find((i) => i.title === 'Good');
  assert.ok(lib.get(good.id), 'served');
  // After the scan, a file is swapped for a symlink out of the folder: not served any more.
  const kept = lib.items().find((i) => i.title === 'Kept');
  fs.unlinkSync(kept.path);
  fs.symlinkSync(path.join(outside, 'Secret (2001).mp4'), kept.path);
  assert.strictEqual(lib.get(kept.id), null);
  // A poster or subtitles swapped the same way aren't handed out either.
  good.poster = path.join(real, 'Films', 'Good (2003).jpg');
  fs.symlinkSync(path.join(outside, 'private.jpg'), good.poster);
  await assert.rejects(lib.thumb(good));
  good.subs = [{ path: good.poster, label: 'x', lang: '' }];
  assert.deepStrictEqual(lib.get(good.id).subs, []);
});

test('screen time: the night the clocks change, and a bedtime after midnight', () => {
  const { ScreenTime } = require('../lib/screentime');
  const at = (iso) => Date.parse(iso);
  let now = 0;
  const st = new ScreenTime(tmp(), { now: () => now, tzDefault: () => 'Europe/London' });
  st.setRule('kid', { mode: 'same', same: { from: '07:00', to: '20:00' } });
  // Clocks go back (25 Oct 2026, 02:00 BST → 01:00 GMT): watch again at 07:00 on the clock, not 06:00.
  now = at('2026-10-24T19:30:00Z'); // 20:30 BST
  assert.strictEqual(st.state('kid').nextAt, at('2026-10-25T07:00:00Z'));
  // Clocks go forward (29 Mar 2026, 01:00 GMT → 02:00 BST): 07:00 BST, not 08:00.
  now = at('2026-03-28T20:30:00Z');
  assert.strictEqual(st.state('kid').nextAt, at('2026-03-29T06:00:00Z'));
  // Time left until a bedtime after the change: real minutes (00:30 BST → 03:30 GMT is four hours).
  st.setRule('kid', { mode: 'same', same: { from: '07:00', to: '03:30' } });
  now = at('2026-10-24T23:30:00Z');
  assert.strictEqual(st.state('kid').left, 240);
  // A normal night: unchanged.
  now = at('2026-11-07T00:30:00Z');
  assert.strictEqual(st.state('kid').left, 180);

  // Bedtime after midnight: the small hours still count as the evening's day (its limit isn't new at midnight).
  const u = new ScreenTime(tmp(), { now: () => now, tzDefault: () => 'UTC' });
  u.setRule('kid', { mode: 'same', same: { limit: 60, from: '07:00', to: '01:00' } });
  now = at('2026-11-06T22:30:00Z');
  for (let i = 0; i < 60; i++) { u.tick(new Set(['kid'])); now += 60e3; }
  now = at('2026-11-07T00:15:00Z');
  let s = u.state('kid');
  assert.strictEqual(s.blocked, true);
  assert.strictEqual(s.reason, 'limit');
  assert.strictEqual(s.used, 60);
  assert.strictEqual(s.day, '2026-11-06');
  assert.strictEqual(s.nextAt, at('2026-11-07T07:00:00Z'), 'again this morning');
  // Minutes watched in the small hours count towards that evening.
  u.grant('kid', 10);
  u.tick(new Set(['kid']));
  assert.strictEqual(u.state('kid').used, 61);
  now = at('2026-11-07T07:00:00Z');
  s = u.state('kid');
  assert.strictEqual(s.used, 0);
  assert.strictEqual(s.left, 60);
});
