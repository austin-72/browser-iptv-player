'use strict';
// Titles alike (lib/alike.js): "More like this" on a title's page, and the "More" step (what is like those).
const test = require('node:test');
const assert = require('node:assert');
const { Alike } = require('../lib/alike');
const { Recs } = require('../lib/recs');
const { norm, stripYear } = require('../lib/catalog');

const film = (k, n, gn, extra) => Object.assign({ k, n, t: 'movie', gn, lg: ['en'], y: 2020, g: 'Films' }, extra || {});
const ITEMS = [
  film('a', 'Star Raid', ['Science Fiction', 'Action'], { cast: 'Ann Lee, Bo Park', dir: 'Cy Diaz', r: 7 }),
  film('a2', 'Star Raid', ['Science Fiction', 'Action'], { lg: ['fr'] }), // another copy of the same film
  film('b', 'Star Raid II', ['Science Fiction', 'Action'], { cast: 'Ann Lee', dir: 'Cy Diaz', r: 6 }),
  film('c', 'Moon Base', ['Science Fiction', 'Adventure'], { r: 8 }),
  film('d', 'Laugh Riot', ['Comedy']),
  film('e', 'Tearjerker', ['Drama', 'Romance']),
  film('f', 'Deep Orbit', ['Science Fiction', 'Thriller'], { r: 7.5 }),
  film('g', 'Robot Wars', ['Action', 'Science Fiction'], { adult: true }),
  { k: 's', n: 'Star Raid: The Series', t: 'show', gn: ['Science Fiction', 'Action'], lg: ['en'], y: 2020 },
];
const catalog = {
  version: '1.0',
  items: ITEMS,
  byKey: new Map(ITEMS.map((x) => [x.k, x])),
  get(k) { return this.byKey.get(k) || null; },
  findTitle(title, year) { const t = norm(stripYear(title)); return ITEMS.filter((x) => norm(stripYear(x.n)) === t && (!year || !x.y || Math.abs(x.y - year) <= 1)).map((x) => x.k); },
};
const recs = new Recs({ dir: '/nonexistent', catalog, userdata: null, accounts: null, tmdb: null });
const noTmdb = { enabled: () => false };

test('one title: the same kind, most alike first, the title itself and its other copies left out', async () => {
  const al = new Alike({ catalog: () => catalog, recs, tmdb: noTmdb });
  const out = await al.of(['a']);
  assert.ok(!out.includes('a') && !out.includes('a2'), 'not itself, in any copy');
  assert.ok(!out.includes('s'), 'films only for a film');
  assert.strictEqual(out[0], 'b', 'the sequel, sharing genres, cast and director, first');
  assert.ok(out.includes('c') && out.includes('f'), 'other science fiction');
  assert.ok(!out.includes('d') && !out.includes('e'), 'nothing unlike it');
});

test('what the profile may not see, and what was already shown, are left out', async () => {
  const al = new Alike({ catalog: () => catalog, recs, tmdb: noTmdb });
  const out = await al.of(['a'], { filter: (it) => !it.adult, skip: ['b'] });
  assert.ok(!out.includes('g'), 'adult title filtered');
  assert.ok(!out.includes('b'), 'already shown');
  const all = await al.of(['a']);
  assert.ok(all.includes('g'));
});

test('several titles (the More step): alike to the set, the set itself left out', async () => {
  const al = new Alike({ catalog: () => catalog, recs, tmdb: noTmdb });
  const out = await al.of(['b', 'c'], { skip: ['a'] });
  assert.ok(!out.includes('a') && !out.includes('a2') && !out.includes('b') && !out.includes('c'));
  assert.ok(out.includes('f'));
});

test('TMDB’s own picks come first, matched to what is here by title and year; one copy each', async () => {
  const tmdb = { enabled: () => true, related: async (it) => (it.k === 'e' ? [{ type: 'movie', title: 'Laugh Riot', year: 2020, w: 1 }, { type: 'movie', title: 'Not Here', year: 2020, w: 1 }, { type: 'tv', title: 'Star Raid: The Series', year: 2020, w: 1 }] : []) };
  const al = new Alike({ catalog: () => catalog, recs, tmdb });
  const out = await al.of(['e']);
  assert.strictEqual(out[0], 'd', 'a comedy, though nothing alike in genre, because TMDB says so');
  assert.ok(!out.includes('s'), 'a series isn’t offered for a film');
  // The copies of one film count once.
  const tm2 = { enabled: () => true, related: async () => [{ type: 'movie', title: 'Star Raid', year: 2020, w: 1 }] };
  const out2 = await new Alike({ catalog: () => catalog, recs, tmdb: tm2 }).of(['f']);
  assert.strictEqual(out2.filter((k) => k === 'a' || k === 'a2').length, 1);
  assert.ok(out2[0] === 'a' || out2[0] === 'a2');
});

test('TMDB failing is no failure: the features still give an answer', async () => {
  const tmdb = { enabled: () => true, related: async () => { throw new Error('down'); } };
  const out = await new Alike({ catalog: () => catalog, recs, tmdb }).of(['a']);
  assert.strictEqual(out[0], 'b');
});
