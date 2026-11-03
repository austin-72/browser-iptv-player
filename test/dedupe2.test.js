// Duplicates across languages the household watches the same way, series made from a playlist's episodes, channels
// with and without a country, and names with providers' shelf tags.
const test = require('node:test');
const assert = require('node:assert');
const { Catalog } = require('../lib/catalog');
const T = require('../lib/titles');

let n = 0;
function catalog(lists, keep = { langs: new Set(['en']), unknown: true }) {
  const parsed = new Map(lists.map((l) => [l.id, { items: l.items, epgUrls: [] }]));
  const ls = { all: () => lists.map((l) => ({ id: l.id, name: l.id, enabled: true, type: l.type || 'xtream' })), parsed };
  const c = new Catalog({ lists: ls, epg: { has: () => false, resolve: () => null }, getSettings: () => ({ tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [] }) });
  c.keepLangs = () => keep;
  c.build();
  return c;
}
const url = (kind) => `http://p/${kind}/u/p/${++n}.mp4`;
const movie = (name, group, extra) => ({ name, type: 'movie', url: url('movie'), group, ...extra });
const show = (name, group, extra) => ({ name, type: 'show', url: '', group, xt: { kind: 'series', id: ++n }, ...extra });
const ep = (name, group) => ({ name, type: 'series', url: url('series'), group });
const live = (name, group) => ({ name, type: 'live', url: url('live'), group });
const of = (c, t) => c.items.filter((i) => i.t === t);

test('one film for the household: its English, multi-language and "English dubbed" copies', () => {
  const c = catalog([
    { id: 'A', type: 'url', items: [movie('Get Smart (2008)', '[MULTI-LANG] MOVIES'), movie('Incendies', '[MULTI-LANG] MOVIES')] },
    { id: 'B', items: [movie('EN - Get Smart (2008)', '|EN| ACTION'), movie('Get Smart (2008)', 'Hindi English Dubbed'), movie('EN - Incendies', '|EN| DRAMA')] },
  ]);
  const films = of(c, 'movie');
  assert.deepStrictEqual(films.map((f) => f.n).sort(), ['Get Smart', 'Incendies']);
  const gs = films.find((f) => f.n === 'Get Smart');
  assert.deepStrictEqual(gs.lg, ['en'], 'the English copy leads');
  assert.strictEqual(gs.alts.length, 2, 'the others are its backups');
  assert.ok(c.renamed.size >= 1, 'saved things on the other copies move over');
  // A household that sees every language keeps them apart, as before.
  const all = catalog([{ id: 'A', type: 'url', items: [movie('Get Smart (2008)', '[MULTI-LANG] MOVIES')] }, { id: 'B', items: [movie('EN - Get Smart (2008)', '|EN| ACTION')] }], null);
  assert.strictEqual(of(all, 'movie').length, 2);
});

test('a series made from a playlist\'s episodes joins the provider series of that name; its two copies are one', () => {
  const c = catalog([
    { id: 'A', type: 'url', items: [ep('EN| Case Closed S01 E01', '[EN] KIDS'), ep('EN| Case Closed S01 E02', '[EN] KIDS'), ep('Case Closed [MULTI-SUB] S01 E01', '[MULTI-LANG] KIDS'), ep('Case Closed [MULTI-SUB] S01 E03', '[MULTI-LANG] KIDS'),
      ep('EN| Only Here S01 E01', '[EN] SERIES'), ep('Only Here [MULTI-SUB] S01 E01', '[MULTI-LANG] SERIES')] },
    { id: 'B', items: [show('Case Closed', '|EN| ANIME')] },
  ]);
  const shows = of(c, 'show');
  assert.deepStrictEqual(shows.map((s) => s.n).sort(), ['Case Closed', 'Only Here'], 'no "EN| " left, one of each');
  const cc = shows.find((s) => s.n === 'Case Closed');
  assert.ok(cc.xt, 'the provider\'s series');
  const eps = of(c, 'episode').filter((e) => e.sk === cc.k).map((e) => `${e.s}x${e.e}`).sort();
  assert.deepStrictEqual(eps, ['1x1', '1x2', '1x3'], 'each episode once');
  assert.strictEqual(of(c, 'episode').find((e) => e.sk === cc.k && e.e === 1).alts.length, 1, 'the other copy of S01E01 is a backup');
  const oh = shows.find((s) => s.n === 'Only Here');
  assert.strictEqual(of(c, 'episode').filter((e) => e.sk === oh.k).length, 1);
});

test('channels: a copy without a country joins the one country that name has; different countries stay apart', () => {
  const c = catalog([
    { id: 'A', type: 'url', items: [live('FOX NEWS', 'News'), live('CA| SPACE', 'Canada'), live('UK| SPACE', 'UK'), live('USA - NBC 13 DES MOINES', '|NA| USA NBC'), live('VIRGIN ONE ˢ', 'UK General')] },
    { id: 'B', items: [live('US| FOX NEWS', 'US| NEWS'), live('US| NBC 13 DES MOINES', 'US| NBC'), live('VIP| BOX OFFICE 74', 'VIP'), live('NBA| Lakers TV', 'NBA')] },
  ]);
  const names = of(c, 'live').map((x) => x.n).sort();
  assert.deepStrictEqual(names, ['BOX OFFICE 74', 'FOX NEWS', 'NBA| Lakers TV', 'NBC 13 DES MOINES', 'SPACE', 'SPACE', 'VIRGIN ONE']);
});

test('names: shelf tags and editions', () => {
  assert.strictEqual(T.stripShelf('TV| IFC'), 'IFC');
  assert.strictEqual(T.stripShelf('24/7-EN - AGENT OF SHIELD'), '24/7 AGENT OF SHIELD');
  assert.strictEqual(T.stripShelf('NHL LIVE| 18'), 'NHL LIVE| 18');
  assert.deepStrictEqual(T.tidyVod('Avengers: Endgame - 2019 (IMAX)'), { n: 'Avengers: Endgame', y: 2019, note: 'IMAX', cam: false });
  assert.strictEqual(T.tidyVod('The Imax Story').n, 'The Imax Story');
});

test('patterns from real lists: country tags, "_msub", numbered event channels', () => {
  const c = catalog([
    { id: 'A', items: [show('The Office (US)', '|EN| COMEDY'), show('The Office (UK)', '|EN| COMEDY'), show('Prison Break (2005)_msub', '|MULTI| ✪ ENGLISH MULTISUB'),
      live('US (ESPN+ 310) | Pacific vs. Denver Oct 31 5:00PM ET (2026-10-31 17:00:10)', '|NA| USA ESPN+'), live('NA - FLINT FIREBIRDS', '|NA| OHL')] },
    { id: 'B', items: [show('EN - Prison Break (2005)', '|EN| SERIES'), live('US (ESPN+ 310) | Toledo vs. Ohio (2026-10-31 18:00:00)', '|NA| USA ESPN+')] },
  ]);
  const shows = of(c, 'show').map((s) => s.n).sort();
  assert.deepStrictEqual(shows, ['Prison Break', 'The Office', 'The Office'], 'US and UK Office apart; the two Prison Breaks one');
  const espn = of(c, 'live').filter((x) => x.n === 'ESPN+ 310');
  assert.strictEqual(espn.length, 2, 'per provider: their games differ');
  assert.deepStrictEqual(espn.map((x) => x.ev).sort(), ['Pacific vs. Denver', 'Toledo vs. Ohio']);
  assert.ok(of(c, 'live').some((x) => x.n === 'FLINT FIREBIRDS'));
});
