// A kids profile that may see a series (by the series' age rating) can play its episodes, which carry no rating
// of their own; a series it may not see stays closed, episodes included.
const test = require('node:test');
const assert = require('node:assert');
const { Catalog } = require('../lib/catalog');

test('kids profile: episodes go with their series', () => {
  let n = 0;
  const ep = (name) => ({ name, type: 'series', url: `http://p/series/u/p/${++n}.mp4`, group: 'Documentary' });
  const items = [ep('Planet Earth S01E01'), ep('Planet Earth S01E02'), ep('Crime Night S01E01')];
  const parsed = new Map([['A', { items, epgUrls: [] }]]);
  const c = new Catalog({ lists: { all: () => [{ id: 'A', name: 'A', enabled: true, type: 'url' }], parsed }, epg: { has: () => false, resolve: () => null }, getSettings: () => ({ tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [] }) });
  c.build();
  const show = (name) => c.items.find((i) => i.t === 'show' && i.n === name);
  show('Planet Earth').c = 'TV-G'; // (from TMDB: on the series only)
  show('Crime Night').c = 'TV-MA';
  const kid = { id: 'w', name: 'W', kids: true, restrictions: { types: [], maxCert: 1, adult: false, blockedGroups: [] } };
  const eps = (name) => c.items.filter((i) => i.t === 'episode' && i.sk === show(name).k);
  assert.ok(c.visible(kid, show('Planet Earth').k), 'the series is listed');
  assert.ok(eps('Planet Earth').length === 2 && eps('Planet Earth').every((e) => c.visible(kid, e.k)), 'and its episodes play');
  assert.ok(!c.visible(kid, show('Crime Night').k));
  assert.ok(eps('Crime Night').every((e) => !c.visible(kid, e.k)), 'a series it can\'t see: no episodes either');
});
