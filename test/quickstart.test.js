// Quick restarts: guides read in the background (only the channels in use), the finished catalogue saved and put back.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Epg } = require('../lib/epg');
const G = require('../lib/guidefile');
const catsnap = require('../lib/catsnap');
const { Catalog } = require('../lib/catalog');

test('a guide file is read without one big string, only the wanted channels made into objects', () => {
  const data = {
    channels: { 'a"b': { names: ['x\\"y}{]['] }, c: { names: ['C'] } },
    programmes: { 'a"b': [{ s: 1, e: 2, t: 'he said "hi" \\', d: '{[}]', n: { x: [1, { y: 2 }] } }], c: [], d: [{ s: 3, e: 4, t: 'é😀' }, { s: 4, e: 5, t: 'z' }] },
    extra: [1, 2], flag: true, num: -1.5e3,
  };
  for (const text of [JSON.stringify(data), JSON.stringify(data, null, 2)]) {
    const r = G.readGuideSync(Buffer.from(text), (c) => c !== 'c');
    assert.deepStrictEqual(r.programmes, { 'a"b': data.programmes['a"b'], d: data.programmes.d });
    assert.deepStrictEqual(r.ids, ['a"b', 'c', 'd'], 'every channel with programmes is still known');
    assert.strictEqual(r.count, 3, 'and every programme counted');
    assert.deepStrictEqual(r.channels, data.channels);
    assert.deepStrictEqual([r.extra, r.flag, r.num], [[1, 2], true, -1500]);
    assert.deepStrictEqual(G.readGuideSync(Buffer.from(text), null).programmes, data.programmes);
  }
  assert.throws(() => G.readGuideSync(Buffer.from('{"programmes":{"a":[{"s":1}'), null), /unfinished/);
});

test('guides read in the background: nothing linked to half of them, new listings meanwhile win', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epgbg-'));
  const now = Date.now();
  const prog = (t) => [{ s: now - 1800e3, e: now + 1800e3, t }];
  fs.writeFileSync(path.join(dir, 'g1.json'), JSON.stringify({ channels: { 'a.us': { names: ['A'] }, 'b.us': { names: ['B'] } }, programmes: { 'a.us': prog('A old'), 'b.us': prog('B') } }));
  fs.writeFileSync(path.join(dir, 'g2.json'), JSON.stringify({ channels: { 'c.us': { names: ['C'] } }, programmes: { 'c.us': prog('C') } }));
  fs.writeFileSync(path.join(dir, 'keep.json'), JSON.stringify(['a.us', 'b.us', 'c.us']));
  const e = new Epg(dir, { background: true });
  let changes = 0;
  e.onChange = () => changes++;
  assert.strictEqual(e.loaded, false);
  // A catalogue asking for fewer channels while they're read: not acted on until they're all in.
  e.useOnly(new Set(['a.us']));
  e.setSource('g1', { channels: { 'a.us': { names: ['A'] } }, programmes: { 'a.us': prog('A new') } });
  await e.load();
  assert.strictEqual(changes, 1, 'one change, when they are all in');
  assert.strictEqual(e.nowNext('a.us').now.t, 'A new', 'the newer listings stand');
  assert.ok(e.has('c.us'));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'keep.json'), 'utf8')), ['a.us'], 'the use asked for meanwhile, applied after');
});

test('the finished catalogue saved and put back: same items, same version, ETag known without building', async () => {
  let n = 0;
  const items = [];
  for (let i = 0; i < 12; i++) items.push({ name: `Film ${i} (2001)`, type: 'movie', url: `http://p/movie/u/p/${++n}.mp4`, group: 'Movies' });
  for (let i = 1; i <= 3; i++) items.push({ name: `Show S01E0${i}`, type: 'series', url: `http://p/series/u/p/${++n}.mp4`, group: 'Series' });
  items.push({ name: 'News One', type: 'live', url: 'http://p/live/u/p/1.ts', group: 'News' });
  const ls = [{ id: 'A', name: 'A', enabled: true, type: 'url' }];
  const mk = () => new Catalog({ lists: { all: () => ls, parsed: new Map([['A', { items, epgUrls: [] }]]) }, epg: { has: () => false, resolve: () => null }, getSettings: () => ({ tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [] }) });
  const a = mk();
  a.keepLangs = () => ({ langs: new Set(['en']), unknown: true });
  a.build();
  a.items.find((x) => x.t === 'movie').plot = 'Filled in later (TMDB).';
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snap-')), 'catalog.snapshot');
  const prof0 = { id: 'p', restrictions: {} };
  const sent = await a.payloadAsync(prof0); // (a device has this version)
  await catsnap.save(file, { v: 1, sig: 'S', ...a.snapshotHead(), lists: { A: { epgUrls: ['http://g'], hosts: ['p'] } } }, a.items, a.snapshotHistory());
  const snap = await catsnap.load(file);
  assert.strictEqual(snap.head.sig, 'S');
  assert.strictEqual(snap.extras.length, 1, 'what devices were sent of this version, kept too');
  const b = mk();
  b.restore(snap.items, snap.head, snap.extras);
  assert.strictEqual(b.version, a.version);
  assert.deepStrictEqual(b.items, JSON.parse(JSON.stringify(a.items)));
  assert.deepStrictEqual([...b.shows.keys()], [...a.shows.keys()]);
  assert.strictEqual(b.items.find((x) => x.t === 'movie').plot, 'Filled in later (TMDB).');
  assert.deepStrictEqual(b._keep, a._keep);
  const prof = { id: 'p', restrictions: {} };
  assert.strictEqual(b.etagFor(prof), a.etagFor(prof));
  assert.strictEqual((await b.payloadAsync(prof)).etag, b.etagFor(prof), 'the ETag a device has is the one the payload gets');
  // After the restart something changes (a guide link, a poster): that device gets just the change, not everything.
  b.items.find((x) => x.t === 'live').logo = 'https://logo/new.png';
  b.metaChanged();
  const d = await b.deltaAsync(prof, sent.etag);
  assert.ok(d && d.count === 1, 'just the one change');
  // A file cut short (the server stopped while writing it) isn't used.
  const buf = fs.readFileSync(file);
  fs.writeFileSync(file, buf.subarray(0, buf.length - 10));
  await assert.rejects(catsnap.load(file), /cut short|incomplete|unexpected end/i);
  assert.strictEqual(await catsnap.load(file + '.none'), null);
});

test('built again from the same lists: the version stays (devices keep their copy); a change gives a new one', () => {
  const items = [{ name: 'Film A (2001)', type: 'movie', url: 'http://p/movie/u/p/1.mp4', group: 'Movies' }, { name: 'News One', type: 'live', url: 'http://p/live/u/p/1.ts', group: 'News' }];
  const c = new Catalog({ lists: { all: () => [{ id: 'A', name: 'A', enabled: true, type: 'url' }], parsed: new Map([['A', { items, epgUrls: [] }]]) }, epg: { has: () => false, resolve: () => null }, getSettings: () => ({ tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [] }) });
  const meta = { poster: 'https://img/1.jpg' };
  c.decorate = (it) => { if (it.t === 'movie') it.poster = meta.poster; };
  c.build();
  const v1 = c.version;
  assert.strictEqual(c.items.find((x) => x.t === 'movie').poster, 'https://img/1.jpg', 'details go on while it is built');
  c.build();
  assert.strictEqual(c.version, v1);
  assert.strictEqual(c.sameAsBefore, true);
  meta.poster = 'https://img/2.jpg'; // (something devices have in their copy)
  c.build();
  assert.notStrictEqual(c.version, v1);
  assert.strictEqual(c.sameAsBefore, false);
  const v2 = c.version;
  c.metaChanged(); // (details changed in place: a new version, and the next identical build keeps that one)
  const v3 = c.version;
  c.build();
  assert.strictEqual(c.version, v3);
  assert.notStrictEqual(v3, v2);
});
