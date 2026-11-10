'use strict';
// Adult (18+) content: what counts as it (a category or the provider's own mark, not an ordinary title that happens
// to hold a word), and the admin's switch that leaves it out of the catalogue for everyone.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Lists } = require('../lib/lists');
const { Catalog, isAdult } = require('../lib/catalog');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'noadult-'));
const GROWN = { id: 'mum', name: 'Mum', restrictions: { types: [], maxCert: '', adult: true, blockedGroups: [] } };
const PLAIN = { id: 'dad', name: 'Dad', restrictions: { types: [], maxCert: '', adult: false, blockedGroups: [] } };

const ITEMS = [
  { name: 'Late Night Film (2011)', type: 'movie', url: 'http://p/a1.mp4', group: 'VOD - ADULT +18', lang: 'en' },
  { name: 'Night Channel HD', type: 'live', url: 'http://p/a2.ts', group: 'FOR ADULTS', lang: 'en' },
  { name: 'Marked By The Provider (2015)', type: 'movie', url: 'http://p/a3.mp4', group: 'Movies', lang: 'en', adult: true },
  { name: 'Playboy TV', type: 'live', url: 'http://p/a4.ts', group: 'Entertainment', lang: 'en' },
  { name: 'xXx: Return of Xander Cage (2017)', type: 'movie', url: 'http://p/m1.mp4', group: 'Action', lang: 'en' },
  { name: 'The Hustler (1961)', type: 'movie', url: 'http://p/m2.mp4', group: 'Classics', lang: 'en' },
  { name: 'The Lying Life of Adults (2023)', type: 'movie', url: 'http://p/m3.mp4', group: 'Drama', lang: 'en' },
  { name: 'Mroczny Film (+18) (2019)', type: 'movie', url: 'http://p/m4.mp4', group: 'Drama', lang: 'en' },
  { name: 'ADULT SWIM HD', type: 'live', url: 'http://p/c1.ts', group: 'Entertainment', lang: 'en' },
  { name: 'Robot Night (2020)', type: 'movie', url: 'http://p/m5.mp4', group: 'ADULT SWIM', lang: 'en' },
  { name: 'News One', type: 'live', url: 'http://p/c2.ts', group: 'News', lang: 'en' },
];

function make(extra) {
  const S = Object.assign({ userAgent: 'test', tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [], epgDays: 1, defaultLangs: [] }, extra);
  const lists = new Lists({ dir: tmp(), media: {}, getSettings: () => S });
  lists.store.data.lists = [{ id: 'L', name: 'L', enabled: true, type: 'm3u' }];
  lists.parsed.set('L', { items: ITEMS.map((x) => ({ ...x })), epgUrls: [] });
  const cat = new Catalog({ lists, epg: { has: () => false, resolve: () => null }, getSettings: () => S });
  cat.build();
  return { cat, S };
}
const names = (cat, p) => { const f = cat.filterFor(p); return cat.items.filter((it) => f.test(it)).map((it) => it.n); };

test('what counts as adult: categories and the provider\'s mark, not ordinary titles', () => {
  for (const [raw, type] of [
    [{ group: 'FOR ADULTS', name: 'x' }, 'live'], [{ group: 'VOD - ADULT +18', name: 'x' }, 'movie'], [{ group: 'XXX', name: 'x' }, 'movie'],
    [{ group: 'Adultos', name: 'x' }, 'movie'], [{ group: 'Erotik', name: 'x' }, 'live'], [{ group: 'Movies', name: 'x', adult: true }, 'movie'],
    [{ group: 'Entertainment', name: 'XXX: Brazzers TV' }, 'live'], [{ group: 'Entertainment', name: 'Hustler TV HD' }, 'live'], [{ group: 'Movies', name: '[XXX] Something' }, 'movie'],
    [{ group: 'Entertainment', name: 'Playboy TV' }, 'live'], [{ group: 'Entertainment', name: 'US: PLAYBOY' }, 'live'], [{ group: 'Entertainment', name: 'Penthouse HD 1' }, 'live'],
  ]) assert.strictEqual(isAdult(raw, type), true, JSON.stringify(raw));
  for (const [raw, type] of [
    [{ group: 'US | ADULT SWIM', name: 'Rick and Morty' }, 'show'], [{ group: 'Adult Animation', name: 'Family Guy' }, 'show'], [{ group: 'Young Adult', name: 'x' }, 'movie'],
    [{ group: 'Music', name: 'STINGRAY POP ADULT' }, 'live'], [{ group: 'Action', name: 'xXx' }, 'movie'], [{ group: 'Docs', name: 'The Playboy Murders' }, 'show'],
    [{ group: 'PL', name: 'XXX Jubileuszowy Festiwal' }, 'movie'], [{ group: 'Comedy', name: 'Adult World (2013)' }, 'movie'], [{ group: 'Sports', name: 'Sky Sports F1' }, 'live'],
    [{ group: '24/7', name: 'Tundukkan Playboy Itu' }, 'live'], [{ group: 'Documentary', name: 'Money Shot: The Pornhub Story (2023)' }, 'movie'], [{ group: '24/7', name: 'The Playboy Club' }, 'live'],
  ]) assert.strictEqual(isAdult(raw, type), false, JSON.stringify(raw));
});

test('adult content stays behind the profile permission, and ordinary titles are no longer caught by it', () => {
  const { cat } = make();
  const plain = names(cat, PLAIN), grown = names(cat, GROWN);
  for (const n of ['xXx: Return of Xander Cage', 'The Hustler', 'The Lying Life of Adults', 'Mroczny Film', 'Robot Night', 'News One']) assert.ok(plain.some((x) => x.startsWith(n)), n + ' is for everyone');
  assert.ok(plain.some((x) => /adult swim/i.test(x)), 'Adult Swim is an ordinary channel');
  for (const n of ['Late Night Film', 'Night Channel', 'Marked By The Provider', 'Playboy TV']) {
    assert.ok(!plain.some((x) => x.startsWith(n)), n + ' needs the permission');
    assert.ok(grown.some((x) => x.startsWith(n)), n + ' with the permission');
  }
  const a = cat.adultInfo();
  assert.strictEqual(a.off, false);
  assert.strictEqual(a.n, 4);
  assert.deepStrictEqual(new Map(a.groups).get('VOD - ADULT +18'), 1);
});

test('the admin\'s switch leaves adult content out for everyone', () => {
  const { cat, S } = make({ noAdult: true });
  for (const n of ['Late Night Film', 'Night Channel', 'Marked By The Provider', 'Playboy TV']) assert.ok(!cat.items.some((it) => it.n.startsWith(n)), n + ' is not in the catalogue');
  const grown = names(cat, GROWN);
  for (const n of ['xXx: Return of Xander Cage', 'The Hustler', 'News One']) assert.ok(grown.some((x) => x.startsWith(n)), n + ' stays');
  const a = cat.adultInfo();
  assert.strictEqual(a.off, true);
  assert.strictEqual(a.n, 4, 'still counted, so Admin can say what was left out');
  // The saved catalogue (quick start) keeps the count and the state.
  assert.deepStrictEqual(cat.snapshotHead().adult, a);

  // Turned on while the catalogue still holds them (until the rebuild): nobody is allowed them any more.
  const two = make();
  assert.ok(names(two.cat, GROWN).some((x) => x.startsWith('Late Night Film')));
  two.S.noAdult = true;
  assert.ok(!names(two.cat, GROWN).some((x) => x.startsWith('Late Night Film')));
  assert.ok(names(two.cat, GROWN).some((x) => x.startsWith('News One')));
  S.noAdult = false;
});

test('an Xtream provider\'s own adult mark is taken in', () => {
  const lists = new Lists({ dir: tmp(), media: {}, getSettings: () => ({}) });
  const out = lists._xtItems({ id: 'X', server: 'http://p', username: 'u', password: 'p' }, {
    info: {}, cats: { live: [{ category_id: '1', category_name: 'General' }], vod: [{ category_id: '2', category_name: 'Films' }], series: [{ category_id: '3', category_name: 'Series' }] },
    live: [{ stream_id: 1, name: 'One', category_id: '1', is_adult: '1' }, { stream_id: 2, name: 'Two', category_id: '1', is_adult: '0' }],
    vod: [{ stream_id: 3, name: 'Three', category_id: '2', is_adult: 1 }, { stream_id: 4, name: 'Four', category_id: '2' }],
    series: [{ series_id: 5, name: 'Five', category_id: '3', is_adult: '1' }],
  });
  const by = new Map(out.items.map((x) => [x.name, x]));
  assert.strictEqual(by.get('One').adult, true);
  assert.strictEqual(by.get('Three').adult, true);
  assert.strictEqual(by.get('Five').adult, true);
  assert.ok(!by.get('Two').adult && !by.get('Four').adult);
});
