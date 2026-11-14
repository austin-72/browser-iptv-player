'use strict';
// Copies that play something else (lib/badcopies.js): the admin hides a provider's copy of a film or an episode for
// everyone; another copy takes its place, and a title with none goes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { BadCopies, copyId } = require('../lib/badcopies');
const { Catalog } = require('../lib/catalog');

test('a copy is known by its provider list and the provider’s number for the file — never the login in its address', () => {
  assert.strictEqual(copyId('A', 'movie', 'http://p.example:8080/movie/someuser/s3cret/1451268.mp4'), 'A:m:1451268');
  assert.strictEqual(copyId('A', 'episode', 'http://p.example/series/u/p/872058.mkv?token=x'), 'A:e:872058');
  assert.notStrictEqual(copyId('A', 'movie', 'http://p/movie/u/p/5.mp4'), copyId('A', 'episode', 'http://p/series/u/p/5.mp4'), 'a film and an episode with the same number differ');
  assert.notStrictEqual(copyId('A', 'movie', 'http://p/movie/u/p/1451268.mp4'), copyId('B', 'movie', 'http://p/movie/u/p/1451268.mp4'), 'and so do two providers');
  // An address without a number: a fingerprint of it, with nothing of the address in it.
  const h = copyId('A', 'movie', 'http://p.example/files/my-secret-path/film.m3u8');
  assert.match(h, /^A:m:h[0-9a-f]{16}$/);
  assert.ok(!/secret|example/.test(h));
});

test('the list: hidden, asked about, shown again; the address is never kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'badcopies-'));
  try {
    const b = new BadCopies(dir);
    assert.strictEqual(b.has('A', 'movie', 'http://p/movie/u/p/77.mp4'), false);
    const id = b.add({ list: 'A', t: 'movie', url: 'http://p/movie/u/p/77.mp4', k: 'K', n: 'The Cat in the Hat (2026)' });
    assert.ok(b.has('A', 'movie', 'http://other-host/movie/x/y/77.mkv'), 'the same file, whatever address it comes by');
    assert.strictEqual(b.list[0].url, undefined);
    assert.strictEqual(b.list[0].n, 'The Cat in the Hat (2026)');
    assert.ok(b.sig().includes(id));
    assert.strictEqual(b.remove(id).k, 'K');
    assert.strictEqual(b.remove(id), null);
    assert.strictEqual(b.has('A', 'movie', 'http://p/movie/u/p/77.mp4'), false);
    b.store.flush(true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the catalogue: another copy takes a hidden one’s place, and a film with none left goes', () => {
  const mv = (name, list, id) => ({ name, type: 'movie', url: `http://${list.toLowerCase()}.example/movie/u/p/${id}.mp4`, group: 'Kids' });
  const parsed = new Map([
    ['A', { items: [mv('The Cat in the Hat (2026)', 'A', 1451268), mv('Clifford the Big Red Dog (2021)', 'A', 889158)], epgUrls: [] }],
    ['B', { items: [mv('The Cat in the Hat (2026)', 'B', 3001)], epgUrls: [] }],
  ]);
  const c = new Catalog({ lists: { all: () => [{ id: 'A', name: 'A', enabled: true, type: 'm3u' }, { id: 'B', name: 'B', enabled: true, type: 'm3u' }], parsed }, epg: { has: () => false, resolve: () => null }, getSettings: () => ({ tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [] }) });
  c.build();
  const cat = () => c.items.find((x) => x.t === 'movie' && /Cat in the Hat/.test(x.n));
  assert.strictEqual(cat().src, 'A');
  assert.strictEqual((cat().alts || []).length, 1, 'two copies: A’s, with B’s as its backup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'badcopies-'));
  try {
    const bad = new BadCopies(dir);
    c.isBadCopy = (l, t, u) => bad.has(l, t, u);
    // A's copy plays something else: B's copy takes its place.
    bad.add({ list: 'A', t: 'movie', url: 'http://a.example/movie/u/p/1451268.mp4' });
    c.build();
    assert.ok(cat(), 'still there');
    assert.strictEqual(cat().src, 'B');
    assert.match(cat().u, /3001\.mp4$/);
    assert.ok(!cat().alts, 'no backup left');
    // B's too: the film goes. Clifford (not hidden) stays.
    bad.add({ list: 'B', t: 'movie', url: 'http://b.example/movie/u/p/3001.mp4' });
    c.build();
    assert.strictEqual(cat(), undefined);
    assert.ok(c.items.some((x) => /Clifford/.test(x.n)));
    // A backup that plays something else just isn't offered.
    bad.remove(bad.list.find((x) => x.list === 'A').id);
    c.build();
    assert.strictEqual(cat().src, 'A');
    assert.ok(!cat().alts);
    bad.store.flush(true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
