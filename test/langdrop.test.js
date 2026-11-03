// Titles in languages nobody in the household uses are left out of the catalogue altogether; the catalogue goes to
// devices in pages.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { Catalog } = require('../lib/catalog');

function catalog(lists, keep) {
  const parsed = new Map(lists.map((l) => [l.id, { items: l.items, epgUrls: [] }]));
  const ls = { all: () => lists.map((l) => ({ id: l.id, name: l.id, enabled: true, type: l.type || 'xtream' })), parsed };
  const c = new Catalog({ lists: ls, epg: { has: () => false, resolve: () => null }, getSettings: () => ({ tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [] }) });
  if (keep !== undefined) c.keepLangs = () => keep;
  c.build();
  return c;
}
const movie = (name, lang, extra) => ({ name, type: 'movie', url: `http://p/${encodeURIComponent(name)}${Math.random()}.mp4`, group: 'Movies', lang, ...extra });
const live = (name, lang) => ({ name, type: 'live', url: `http://p/${encodeURIComponent(name)}.ts`, group: 'TV', lang });
const names = (c) => c.items.map((i) => i.n).sort();

test('an English-only household: French and Arabic titles are left out, unknown ones follow the setting', () => {
  const lists = [
    { id: 'A', items: [movie('Hello', 'en'), movie('Bonjour', 'fr'), movie('Marhaba', 'ar'), movie('Mystery Film', ''), live('News One', 'en'), live('Info Deux', 'fr')] },
    { id: 'F', type: 'folder', items: [movie('Holiday Video', 'fr')] },
  ];
  const all = catalog(lists);
  assert.deepStrictEqual(names(all), ['Bonjour', 'Hello', 'Holiday Video', 'Info Deux', 'Marhaba', 'Mystery Film', 'News One']);
  const en = catalog(lists, { langs: new Set(['en']), unknown: true });
  // (A folder of the household's own videos is always kept.)
  assert.deepStrictEqual(names(en), ['Hello', 'Holiday Video', 'Mystery Film', 'News One']);
  const strict = catalog(lists, { langs: new Set(['en']), unknown: false });
  assert.deepStrictEqual(names(strict), ['Hello', 'Holiday Video', 'News One']);
  const enfr = catalog(lists, { langs: new Set(['en', 'fr']), unknown: false });
  assert.deepStrictEqual(names(enfr), ['Bonjour', 'Hello', 'Holiday Video', 'Info Deux', 'News One']);
  assert.deepStrictEqual(names(catalog(lists, null)), names(all), 'null keeps everything');
});

test('the catalogue is sent in pages: live channels first, every item once', async () => {
  process.env.CATALOG_PAGE = '10';
  delete require.cache[require.resolve('../lib/catalog')];
  const { Catalog: C2 } = require('../lib/catalog');
  const items = [];
  for (let i = 0; i < 25; i++) items.push(movie(`Film ${i}`, 'en'));
  for (let i = 0; i < 7; i++) items.push(live(`Channel ${i}`, 'en'));
  const parsed = new Map([['A', { items, epgUrls: [] }]]);
  const c = new C2({ lists: { all: () => [{ id: 'A', name: 'A', enabled: true, type: 'xtream' }], parsed }, epg: { has: () => false, resolve: () => null }, getSettings: () => ({ hiddenGroups: [], hiddenKeys: [], groupRules: [] }) });
  c.build();
  const out = await c.payloadAsync({ id: 'p', restrictions: {} });
  assert.strictEqual(out.pages.length, 4);
  const pages = out.pages.map((g) => JSON.parse(zlib.gunzipSync(g)));
  assert.ok(pages.every((p, i) => p.page === i && p.pages === 4 && p.total === 32));
  const got = pages.flatMap((p) => p.items);
  assert.strictEqual(got.length, 32);
  assert.strictEqual(new Set(got.map((x) => x.k)).size, 32);
  assert.ok(got.slice(0, 7).every((x) => x.t === 'live'), 'live channels come first');
  assert.deepStrictEqual(JSON.parse(out.raw(2)).items, pages[2].items);
  delete process.env.CATALOG_PAGE;
});
