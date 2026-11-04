// The catalogue built over and over after TMDB lookups: a merged copy's match dropped (so it was looked up, merged and
// dropped again after every build), the same doubtful matches dropped and found again, and "titles to put together"
// that the build always leaves apart (a fight night's prelims and main card, years apart).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const { Tmdb, ownYear } = require('../lib/tmdb');
const { Catalog } = require('../lib/catalog');

let n = 0;
const movie = (name, group) => ({ name, type: 'movie', url: `http://p/movie/u/p/${++n}.mp4`, group });
const lists = [
  { id: 'A', items: [movie('EN - Spirited Away - 2001', '|EN| ANIMATION'), movie('EN - UFC 300 Prelims', '|EN| SPORTS'), movie('EN - Heat - 1995', '|EN| CRIME')] },
  { id: 'B', items: [movie('Sen to Chihiro no Kamikakushi (2001)', 'Movies'), movie('UFC 300 Main Card', 'Sports'), movie('Heat (2013)', 'Movies')] },
];
const parsed = new Map(lists.map((l) => [l.id, { items: l.items, epgUrls: [] }]));
const mk = (ids) => {
  const c = new Catalog({ lists: { all: () => lists.map((l) => ({ id: l.id, name: l.id, enabled: true, type: 'xtream' })), parsed }, epg: { has: () => false, resolve: () => null }, getSettings: () => ({ tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [] }) });
  c.keepLangs = () => ({ langs: new Set(['en']), unknown: true });
  c.tmdbOf = (k) => (ids[k] && ids[k].id ? ids[k] : null);
  return c;
};

test('a copy put together with another by TMDB stays matched, so the next build puts them together again', () => {
  const ids = {};
  const c = mk(ids);
  c.build();
  const by = (n) => c.items.find((i) => i.n === n);
  const kA = by('Spirited Away').k, kB = by('Sen to Chihiro no Kamikakushi').k;
  ids[kA] = { id: 129, type: 'movie' }; ids[kB] = { id: 129, type: 'movie' };
  for (const h of c.items.filter((i) => i.n === 'Heat')) ids[h.k] = { id: 949, type: 'movie' };
  for (const u of c.items.filter((i) => /^UFC 300/.test(i.n))) ids[u.k] = { id: 777, type: 'movie' };
  assert.strictEqual(c.pendingSameTmdb().length, 1, 'only Spirited Away: not the fight night, not the Heats years apart');
  c.build();
  assert.strictEqual(c.items.filter((i) => /spirited|chihiro/i.test(i.n)).length, 1);
  assert.deepStrictEqual(c.pendingSameTmdb(), [], 'nothing left to put together');
  assert.ok(c.mergedKeys.has(kB) || c.mergedKeys.has(kA), 'the merged copy is known as one');
  // The server moves saved things to the title's key — the copy's own match stays.
  const t = new Tmdb({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'loop-')), getKey: () => '' });
  Object.assign(t.map.data.m, JSON.parse(JSON.stringify(ids)));
  t.meta.data.m[kB] = { tmdb: 129, title: 'Spirited Away' };
  t.migrateKeys(c.renamed, c.mergedKeys);
  const gone = c.mergedKeys.has(kB) ? kB : kA;
  assert.strictEqual(t.map.data.m[gone].id, 129, 'kept');
  // Built again with what's kept: put together again, with nothing to look up.
  Object.keys(ids).forEach((k) => delete ids[k]); Object.assign(ids, t.map.data.m);
  c.build();
  assert.strictEqual(c.items.filter((i) => /spirited|chihiro/i.test(i.n)).length, 1, 'still one');
  // (A plain rename still moves: the old key is gone for good.)
  const t2 = new Tmdb({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'loop-')), getKey: () => '' });
  t2.map.data.m.old = { id: 5 };
  t2.migrateKeys(new Map([['old', 'new']]), new Set());
  assert.deepStrictEqual([t2.map.data.m.old, t2.map.data.m.new], [undefined, { id: 5 }]);
});

test('1970 (an empty release date) is no year of the title’s own', () => {
  assert.strictEqual(ownYear({ y: 1970 }), 0);
  assert.strictEqual(ownYear({ y: 1971 }), 1971);
  assert.strictEqual(ownYear({ y: 2020, _ym: 1 }), 0);
});

async function withTmdb(fn) {
  const asked = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    asked.push(u.pathname + '?' + (u.searchParams.get('query') || '') + '/' + (u.searchParams.get('year') || ''));
    const send = (j) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (u.pathname === '/search/movie') {
      const q = u.searchParams.get('query'), y = u.searchParams.get('year');
      if (y) return send({ results: [] }); // (nothing that year: asked again without one)
      if (q === 'The Gates') return send({ results: [{ id: 853, title: 'Enemy at the Gates', release_date: '2001-03-13' }] });
      if (q === 'Angie’s Cure' || q === 'Angies Cure') return send({ results: [{ id: 998122, title: 'Angies Cure', release_date: '2022-05-01' }] });
      return send({ results: [] });
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(new Tmdb({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'loop-')), getKey: () => 'k', base: `http://127.0.0.1:${srv.address().port}` }), asked); } finally { srv.close(); }
}

test('a title with a year: not another film of a similar name years apart; one called exactly that is', () => withTmdb(async (t) => {
  assert.strictEqual(await t.match({ k: 'G', t: 'movie', n: 'The Gates', y: 2022 }), null, '"The Gates" 2022 isn’t "Enemy at the Gates"');
  assert.strictEqual((await t.match({ k: 'C', t: 'movie', n: 'Angies Cure', y: 2025 })).id, 998122, 'the provider’s year a few off');
}));

test('a doubtful match is looked up again once — what that finds stays', () => withTmdb(async (t, asked) => {
  // (As the server's clean-up leaves it: see startEnrich.)
  t.map.data.m.C = { rc: 1 };
  const it = { k: 'C', t: 'movie', n: 'Angies Cure', y: 2025 };
  const m = await t.match(it);
  assert.strictEqual(m.id, 998122);
  assert.strictEqual(m.rc, 1);
  t.meta.data.m.C = { tmdb: 998122, y: 2022 };
  assert.strictEqual(t.doubtful(it), false, 'not dropped again');
  delete t.map.data.m.C.rc;
  assert.strictEqual(t.doubtful(it), true, '(without the mark it would be)');
  // A provider's wrong number stays off when nothing is found by name.
  t.map.data.m.Z = { badList: 42, rc: 1 };
  assert.strictEqual(await t.match({ k: 'Z', t: 'movie', n: 'Nothing Like It', y: 2020, tmdb: '42' }), null);
  assert.strictEqual(t.map.data.m.Z.badList, 42);
  assert.ok(t.map.data.m.Z.none && t.map.data.m.Z.rc);
}));

test('copies of an event or a "Part One" with the same name are one title; prelims and main card stay two', () => {
  const ls = [
    { id: 'A', items: [movie('EN - A Quiet Place Part II (2021)', '|EN| HORROR'), movie('EN - UFC 300 Prelims', '|EN| SPORTS')] },
    { id: 'B', items: [movie('A Quiet Place Part II', 'Movies'), movie('UFC 300 Main Card', 'Sports')] },
  ];
  const ps = new Map(ls.map((l) => [l.id, { items: l.items, epgUrls: [] }]));
  const ids = {};
  const c = new Catalog({ lists: { all: () => ls.map((l) => ({ id: l.id, name: l.id, enabled: true, type: 'xtream' })), parsed: ps }, epg: { has: () => false, resolve: () => null }, getSettings: () => ({ tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [] }) });
  c.keepLangs = () => ({ langs: new Set(['en']), unknown: true });
  c.tmdbOf = (k) => ids[k] || null;
  // (The merge by name left out, so both copies are there to be matched: one has no year.)
  c._sameTitleSteps = function* () {};
  c.build();
  for (const it of c.items) ids[it.k] = { id: /Quiet/.test(it.n) ? 520763 : 777, type: 'movie' };
  assert.strictEqual(c.items.filter((i) => /Quiet/.test(i.n)).length, 2);
  assert.deepStrictEqual(c.pendingSameTmdb(), ['movie|520763|en']);
  c.build();
  assert.strictEqual(c.items.filter((i) => /Quiet/.test(i.n)).length, 1);
  assert.strictEqual(c.items.filter((i) => /UFC 300/.test(i.n)).length, 2);
  assert.deepStrictEqual(c.pendingSameTmdb(), []);
});
