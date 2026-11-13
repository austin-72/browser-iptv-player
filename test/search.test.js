'use strict';
// Search as you type (web/js/search.js): what a search finds, and in which order — run against a small catalogue.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'search.js'), 'utf8');
const CORE = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'core.js'), 'utf8');
const NORM = /V\.norm = function[\s\S]*?\n\};/.exec(CORE)[0];

function search(items) {
  const V = { on() { return () => {}; }, emit() {}, idle() {}, now: () => Date.now(), smart: null };
  const S = { items, data: { progress: {}, hidden: [] } };
  const ctx = vm.createContext({ V, S, Map, Set, Float64Array, Date, Math, String, Array });
  vm.runInContext(NORM + '\n' + SRC, ctx);
  V.search.buildNow();
  return (q, o) => Array.from(V.search.find(q, o || {}), (it) => it.k);
}

const CAT = [
  { k: 'dk', t: 'movie', n: 'The Dark Knight', y: 2008, pp: 90 },
  { k: 'dkr', t: 'movie', n: 'The Dark Knight Rises', y: 2012, pp: 60 },
  { k: 'ff', t: 'movie', n: 'Fast & Furious', y: 2009, pp: 40 },
  { k: 'ff2', t: 'movie', n: 'The Fast and the Furious', y: 2001, pp: 50 },
  { k: 'r2', t: 'movie', n: 'Rocky II', y: 1979, pp: 20 },
  { k: 'r1', t: 'movie', n: 'Rocky', y: 1976, pp: 30 },
  { k: 'sm', t: 'movie', n: 'Spider-Man', y: 2002, pp: 70 },
  { k: 'smh', t: 'movie', n: 'Spider-Man: Homecoming', y: 2017, pp: 80 },
  { k: 'dune84', t: 'movie', n: 'Dune', y: 1984, pp: 20 },
  { k: 'dune21', t: 'movie', n: 'Dune', y: 2021, pp: 300 },
  { k: 'br', t: 'movie', n: 'Blade Runner', y: 1982, pp: 40 },
  { k: 'br49', t: 'movie', n: 'Blade Runner 2049', y: 2017, pp: 60 },
  { k: 'dunes', t: 'show', n: 'Dunes of Gold', y: 2019, pp: 1 },
  { k: 'cnn', t: 'live', n: 'CNN International', no: 202 },
  { k: 'disc', t: 'live', n: 'Discovery Channel', no: 20 },
  { k: 'twenty', t: 'movie', n: '20', y: 2023 },
  { k: 'lh', t: 'movie', n: 'The Last House', y: 2026, pp: 5 },
  { k: 'lh2', t: 'movie', n: 'The Lost House Party', y: 2011, pp: 5 },
  { k: 'last', t: 'show', n: 'Last Week Tonight', y: 2014, pp: 40 },
  { k: 'drg', t: 'movie', n: 'How to Train Your Dragon', y: 2010, pp: 60 },
  { k: 'sw', t: 'movie', n: 'Star Wars', y: 1977, pp: 90 },
  { k: 'ts2', t: 'movie', n: 'Toy Story 2', y: 1999, pp: 50 },
  { k: 'ahs', t: 'show', n: 'American Horror Story', y: 2011, pp: 60 },
];

test('names: whole, the start, "the" left off, small words and numbers either way, together or apart', () => {
  const find = search(CAT);
  assert.deepStrictEqual(find('dark knight').slice(0, 2), ['dk', 'dkr'], 'without "The"');
  assert.ok(find('fast and furious').slice(0, 2).includes('ff'), 'Fast & Furious, typed with "and"');
  assert.ok(find('fast and furious').includes('ff2'));
  assert.strictEqual(find('rocky 2')[0], 'r2', '2 is II');
  assert.ok(find('spiderman').includes('sm') && find('spiderman').includes('smh'), 'spelled together');
  assert.strictEqual(find('spiderman')[0], 'sm');
  assert.strictEqual(find('blade runner 2049')[0], 'br49', 'a year that is part of the name');
  assert.strictEqual(find('blade runner')[0], 'br');
  assert.strictEqual(find('202')[0], 'cnn', 'a channel number');
});

test('a year typed with the name: that one first; the more popular of two with the same name', () => {
  const find = search(CAT);
  assert.strictEqual(find('dune 1984')[0], 'dune84');
  assert.strictEqual(find('dune 2021')[0], 'dune21');
  assert.strictEqual(find('dune')[0], 'dune21', 'the popular one');
  assert.ok(find('dune').indexOf('dunes') > 1, 'an exact name before a longer one');
  assert.deepStrictEqual(find('the'), find('the'), 'a small word alone still searches');
  assert.ok(find('the').length > 0);
});

test('typos: the whole name still counts — every word typed in it, a letter or two wrong', () => {
  const find = search(CAT);
  assert.strictEqual(find('the last huose')[0], 'lh');
  assert.strictEqual(find('how to train your dargon')[0], 'drg');
  assert.strictEqual(find('star wras')[0], 'sw');
  assert.ok(!find('toy story 2').includes('ahs'), 'not a title that only shares one word');
  assert.strictEqual(find('20')[0], 'twenty', 'a title of exactly that name before channel 20');
  assert.ok(find('20').includes('disc'), 'and the channel');
});
