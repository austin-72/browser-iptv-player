// Smarter categories (lib/smartcats.js), TMDB titles that are one film ("Austin Powers 2: …"), undated titles not
// matched to a newer film, and My List's order.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const Smart = require('../lib/smartcats');
const T = require('../lib/titles');
const { Catalog } = require('../lib/catalog');
const { Tmdb } = require('../lib/tmdb');
const { UserData } = require('../lib/userdata');

const ON = { smart: { on: true } };
const tagOf = (it, deps, S = ON) => Smart.tagger(S, deps).tag({ lg: ['en'], ...it });
const has = (ids, ...want) => { for (const w of want) assert.ok(ids.includes(w), `${w} in ${ids.join(' ')}`); };
const lacks = (ids, ...no) => { for (const w of no) assert.ok(!ids.includes(w), `${w} not in ${ids.join(' ')}`); };

test('channels: networks, genres, sports, local stations, events, countries', () => {
  const ch = (n, g, extra) => tagOf({ t: 'live', n, g, rg: g, ...extra });
  has(ch('ABC 6 COLUMBUS OH (WSYX)', 'ABC'), 'n:abc', 'g:local');
  has(ch('FOX 30 (WFOX) Jacksonville', 'Local - Fox'), 'n:fox', 'g:local');
  lacks(ch('FOX SOCCER PLUS', 'Sports'), 'n:fox', 'g:local');
  has(ch('FOX SOCCER PLUS', 'Sports'), 'n:foxsports', 'g:sports', 's:soccer');
  has(ch('ESPN+ 035', 'ESPN+'), 'n:espn', 'g:sports');
  has(ch('NHL VEGAS GOLDEN KNIGHTS', 'NHL'), 'g:sports', 's:hockey');
  has(ch('BBC NEWS', 'News'), 'n:bbc', 'g:news');
  has(ch('DISNEY XD EAST', 'Kids'), 'n:disney', 'g:kids');
  has(ch('HULU ORIGINALS 15', 'Hulu Network'), 'n:hulu');
  has(ch('NETFLIX 24/7 STRANGER THINGS', '24/7 Shows'), 'n:netflix', 'g:247');
  has(ch('PEACOCK EEVNT 11', 'PPV Live Event'), 'n:peacock', 'e:ppv');
  has(ch('SKY SPORTS 2', '4K UHD'), 'n:sky', 'g:sports', 'g:uhd');
  has(ch('CHRISTMAS 24/7', 'Movies'), 'h:christmas', 'g:movies');
  has(ch('TSN 2', 'Sports', { co: 'CA' }), 'n:tsn', 'c:CA');
  has(ch('GEO SUPER', 'Philippines'), 'c:PH');
  // A general category alone says little: "Entertainment" only when there's nothing better.
  has(ch('VH1', 'Entertainment'), 'n:mtv', 'g:music');
  lacks(ch('VH1', 'Entertainment'), 'g:entertainment');
  has(ch('SOMETHING', 'Entertainment'), 'g:entertainment');
  // Nothing at all: "Everything else", so it can still be found.
  has(ch('XYZ 12', 'Misc'), 'g:other');
  // What the guide shows decides too.
  const epgCats = () => ['Sports', 'Sports event', 'Football', 'News'];
  has(tagOf({ t: 'live', n: 'CHANNEL 7', g: 'TV', epg: 'c7' }, { epgCats }), 'g:sports');
  lacks(tagOf({ t: 'live', n: 'CHANNEL 7', g: 'TV', epg: 'c7' }, { epgCats }, { smart: { on: true, epg: false } }), 'g:sports');
});

test('films and series: services from labels, categories and TMDB — never the title; genres, holidays, themes, studios', () => {
  const meta = {
    k1: { wp: ['Disney Plus', 'Hulu'], kw: ['christmas', 'santa claus', 'superhero'], co: ['Pixar'] },
    k2: { nw: ['HBO'], kw: ['zombie'], ol: 'en' },
    k3: { kw: [], ol: 'ja' },
  };
  const deps = { meta: (k) => meta[k] || null };
  const t = (it) => tagOf({ t: 'movie', ...it }, deps);
  const madMax = t({ k: 'x', n: 'Mad Max: Fury Road', g: 'Action', rg: 'ACTION', gn: ['Action', 'Adventure'] });
  has(madMax, 'g:action', 'g:adventure');
  lacks(madMax, 'n:max');
  has(t({ k: 'x', n: 'Glass Onion', g: 'Netflix', gn: ['Comedy', 'Mystery'] }), 'n:netflix', 'g:comedy', 'g:mystery');
  has(t({ k: 'x', n: 'Luca', svc: 'Disney+', gn: ['Animation'] }), 'n:disneyplus', 'g:animation');
  has(t({ k: 'k1', n: 'A Film', g: 'Movies', gn: ['Family'] }), 'n:disneyplus', 'n:hulu', 'h:christmas', 't:superhero', 'st:pixar', 'g:kids');
  has(tagOf({ t: 'show', k: 'k2', n: 'A Show', g: 'Series', gn: ['Drama'] }, deps), 'n:max', 't:zombie', 'g:drama');
  has(t({ k: 'k3', n: 'Spirited', g: 'Movies', gn: ['Animation'] }), 'g:anime');
  has(t({ k: 'x', n: 'Halloween', g: 'Horror', y: 1978, gn: ['Horror'] }), 'h:halloween', 'g:horror');
  has(t({ k: 'x', n: 'Casablanca', y: 1942, g: 'Classic Movies Collection', gn: ['Drama'] }), 'g:classic');
  has(t({ k: 'x', n: 'Die Hard', g: 'Action', gn: ['Action'], plot: 'NYPD cop John McClane goes on a Christmas vacation to visit his wife.' }), 'h:christmas');
  lacks(tagOf({ t: 'movie', k: 'x', n: 'Die Hard', g: 'Action', gn: ['Action'], plot: 'A Christmas party.' }, deps, { smart: { on: true, plot: false } }), 'h:christmas');
  has(t({ k: 'x', n: 'Some Show', g: 'Quebec Noel' }), 'h:christmas');
  has(t({ k: 'x', n: 'UFC 311: Makhachev vs. Moicano', g: 'Sport', rg: 'VOD - SPORT', gn: ['Action'] }), 'g:sports', 's:fighting');
  has(t({ k: 'x', n: 'Goodfellas', g: 'Gangster & Mafia', gn: ['Crime'] }), 't:gangster', 'g:crime');
  // Adult titles: only that.
  assert.deepStrictEqual(t({ k: 'x', n: 'X', g: 'Adult +18', adult: true, gn: ['Comedy'] }), ['g:adult']);
});

test('the admin’s choices: kinds off, categories hidden, renamed, their own; what devices are told', () => {
  const S = { smart: Smart.clean({ on: true, kinds: { sport: false }, hidden: ['n:abc', 'nope'], names: { 'g:comedy': 'Funny stuff', bad: 'x' }, custom: [{ n: 'Wrestling', words: 'wwe, aew', types: ['live'] }, { n: '', words: 'x' }], region: 'gb', min: 0 }) };
  assert.strictEqual(S.smart.region, 'GB');
  assert.strictEqual(S.smart.min, 1);
  assert.deepStrictEqual(S.smart.hidden, ['n:abc'], 'only known ones');
  assert.deepStrictEqual(S.smart.names, { 'g:comedy': 'Funny stuff' });
  assert.strictEqual(S.smart.custom.length, 1);
  const own = S.smart.custom[0].id;
  const ids = tagOf({ t: 'live', n: 'WWE NETWORK', g: 'Sports' }, {}, S);
  has(ids, own, 'g:sports');
  lacks(ids, 's:fighting');
  lacks(tagOf({ t: 'live', n: 'ABC 7', g: 'ABC' }, {}, S), 'n:abc');
  const pub = Smart.publicView(S);
  assert.strictEqual(pub.on, true);
  assert.ok(pub.defs.find((d) => d.id === 'g:comedy').n === 'Funny stuff');
  assert.ok(!pub.defs.some((d) => d.k === 'sport'));
  assert.ok(!pub.defs.some((d) => d.id === 'n:abc'));
  assert.ok(pub.defs.some((d) => d.id === own && d.types[0] === 'live'));
  assert.deepStrictEqual(Smart.publicView({}).on, false);
  assert.strictEqual(Smart.tagger({}).tag({ t: 'live', n: 'ABC' }), null, 'off: nothing');
});

test('holidays in season', () => {
  const at = (m, d) => Smart.inSeason(new Date(2026, m - 1, d, 12));
  assert.deepStrictEqual(at(10, 20), ['halloween']);
  assert.deepStrictEqual(at(11, 4).slice(0, 1), ['thanksgiving'], 'nearest first');
  assert.ok(at(11, 4).includes('christmas'));
  assert.ok(at(12, 28).includes('newyear') && at(1, 2).includes('newyear'));
  assert.deepStrictEqual(at(8, 10), []);
});

test('the catalogue gets them as it’s built, sends them, and can work them out again', async () => {
  const items = [{ name: 'ESPN 2', type: 'live', url: 'http://p/live/u/p/1.ts', group: 'Sports' }, { name: 'Glass Onion (2022)', type: 'movie', url: 'http://p/movie/u/p/2.mp4', group: 'Netflix' }];
  let S = { tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [], smart: { on: true } };
  const c = new Catalog({ lists: { all: () => [{ id: 'A', name: 'A', enabled: true, type: 'url' }], parsed: new Map([['A', { items, epgUrls: [] }]]) }, epg: { has: () => false, resolve: () => null }, getSettings: () => S });
  c.tagger = () => Smart.tagger(S);
  c.build();
  const espn = c.items.find((x) => x.t === 'live');
  has(espn.sc, 'n:espn', 'g:sports');
  assert.deepStrictEqual(Catalog.compact(espn).sc, espn.sc);
  S = { ...S, smart: { on: false } };
  assert.strictEqual(await c.retag(), 2);
  assert.ok(!c.items.some((x) => x.sc), 'off: none left');
  assert.ok(!('sc' in Catalog.compact(espn)));
});

test('TMDB’s charts matched to the catalogue', async () => {
  const pages = { '/trending/movie/week': [{ id: 1 }, { id: 2 }, { id: 9 }], '/tv/popular': [{ id: 5 }] };
  const tmdb = { enabled: () => true, map: { data: { m: { a: { id: 1, type: 'movie' }, b: { id: 2, type: 'movie' }, b2: { id: 2, type: 'movie' }, s: { id: 5, type: 'tv' } } } }, get: async (p) => ({ results: pages[p] || [], total_pages: 1 }) };
  const cat = { version: '1', items: [{ k: 'a', t: 'movie' }, { k: 'b', t: 'movie' }, { k: 'b2', t: 'movie' }, { k: 's', t: 'show' }, { k: 'z', t: 'movie', tmdb: '9' }] };
  const tr = new Smart.Trending({ tmdb, catalog: () => cat });
  await tr.refresh();
  const v = tr.view();
  assert.deepStrictEqual(v.lists['tr:week'].movie, [['a'], ['b', 'b2'], ['z']], 'in chart order; every copy; the provider’s own id too');
  assert.deepStrictEqual(v.lists['tr:pop'].show, [['s']]);
});

test('one film whatever the provider calls it: a series number TMDB leaves out, a name in front, never another part', () => {
  const same = [
    ['Austin Powers 2: The Spy Who Shagged Me', 1999, 'Austin Powers: The Spy Who Shagged Me', 1999],
    ['Austin Powers 3: Austin Powers in Goldmember', 2002, 'Austin Powers in Goldmember', 2002],
    ['Sin City 2 : A Dame To Kill For', 2014, 'Sin City: A Dame to Kill For', 2014],
    ['Rush Hour 1', 1998, 'Rush Hour', 1998],
    ['Dr. Seuss How The Grinch Stole Christmas', 2000, 'How the Grinch Stole Christmas', 2000],
  ];
  for (const [a, y, b, ty] of same) assert.ok(T.sameTitle(a, y, b, ty), a);
  const apart = [
    ['UFC Fight Night 292: Moicano vs. Nolan (Prelims)', 2026, 'UFC Fight Night 292: Moicano vs. Nolan', 2026],
    ['UFC 333: Volkanovski vs. Evloev (Main-Card)', 2026, 'UFC 333: Volkanovski vs. Evloev', 2026],
    ['Paranormal Activity 2', 2010, 'Paranormal Activity', 2009],
    ['Rocky 2', 1979, 'Rocky', 1979],
    ['Agent', 2025, 'The Secret Agent', 2025],
    ['Austin Powers 2: The Spy Who Shagged Me', 0, 'Austin Powers: The Spy Who Shagged Me', 1999],
  ];
  for (const [a, y, b, ty] of apart) assert.ok(!T.sameTitle(a, y, b, ty), a);
});

test('“Austin Powers 2: …” and “Austin Powers: …” become one title, every copy a source (two from one list too)', () => {
  let n = 0;
  const mv = (name, group) => ({ name, type: 'movie', url: `http://p/movie/u/p/${++n}.mp4`, group });
  const lists = [
    { id: 'A', items: [mv('EN - Austin Powers: The Spy Who Shagged Me (1999)', '|EN| COMEDY')] },
    { id: 'B', items: [mv('EN - Austin Powers 2: The Spy Who Shagged Me (1999)', '|EN| COLLECTIONS'), mv('Austin Powers 2: The Spy Who Shagged Me (1999)', 'Comedy')] },
  ];
  const parsed = new Map(lists.map((l) => [l.id, { items: l.items, epgUrls: [] }]));
  const title = new Map(); // (what TMDB calls each match)
  const mk = (ids) => {
    const c = new Catalog({ lists: { all: () => lists.map((l) => ({ id: l.id, name: l.id, enabled: true, type: 'xtream' })), parsed }, epg: { has: () => false, resolve: () => null }, getSettings: () => ({ tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [] }) });
    c.keepLangs = () => ({ langs: new Set(['en']), unknown: true });
    // (As the server does: a sure match — TMDB's title is clearly this title.)
    c.tmdbOf = (k, it) => { const m = ids[k]; return m && it && T.sameTitle(it.n, it.y, title.get(m.id), 1999) ? m : null; };
    c.build();
    return c;
  };
  const first = mk({});
  const films = first.items.filter((i) => i.t === 'movie');
  assert.strictEqual(films.length, 2, 'apart by name alone');
  const ids = {};
  title.set(817, 'Austin Powers: The Spy Who Shagged Me');
  for (const f of films) ids[f.k] = { id: 817, type: 'movie' };
  const c = mk(ids);
  const one = c.items.filter((i) => i.t === 'movie');
  assert.strictEqual(one.length, 1);
  assert.strictEqual(one[0].alts.length, 2, 'the other two copies are its sources');
});

test('a title with no year isn’t matched to one that came out after the list had it; such a match is doubted', async () => {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (j) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (u.pathname === '/search/movie') return send({ results: [{ id: 2026, release_date: '2026-09-18' }, { id: 1576, release_date: '2002-03-15' }] });
    if (u.pathname === '/movie/1576') return send({ id: 1576, title: 'Resident Evil', release_date: '2002-03-15', genres: [], credits: { cast: [], crew: [] }, release_dates: { results: [] }, keywords: { keywords: [{ name: 'zombie' }] }, 'watch/providers': { results: { US: { flatrate: [{ provider_name: 'Netflix' }, { provider_name: 'Paramount Plus Apple TV Channel' }] } } }, popularity: 41.27, production_companies: [{ name: 'Constantin Film' }] });
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-'));
    const t = new Tmdb({ dataDir: dir, getKey: () => 'k', base: `http://127.0.0.1:${srv.address().port}`, wantExtras: () => true });
    const it = { k: 'R', t: 'movie', n: 'Resident Evil', ad: new Date(2020, 5, 1).getTime() };
    const m = await t.details(it);
    assert.strictEqual(m.tmdb, 1576, 'the 2002 film, not the 2026 one');
    assert.deepStrictEqual(m.kw, ['zombie']);
    assert.deepStrictEqual(m.wp, ['Netflix', 'Paramount Plus'], 'services, without "… Apple TV Channel"');
    assert.strictEqual(m.pop, 41.3);
    assert.strictEqual(m.x, 1);
    assert.strictEqual(t.doubtful(it), false);
    // An old wrong one (from before): doubted, so it's looked up again.
    t.map.data.m.W = { id: 2026, type: 'movie' };
    t.meta.data.m.W = { tmdb: 2026, y: 2026, v: 2, at: Date.now() };
    assert.strictEqual(t.doubtful({ k: 'W', t: 'movie', n: 'Resident Evil', ad: new Date(2020, 5, 1).getTime() }), true);
    assert.strictEqual(t.doubtful({ k: 'W', t: 'movie', n: 'Resident Evil', ad: new Date(2026, 8, 20).getTime() }), false);
    t.map.data.m.W.manual = 1;
    assert.strictEqual(t.doubtful({ k: 'W', t: 'movie', n: 'Resident Evil', ad: new Date(2020, 5, 1).getTime() }), false, 'picked by hand: left alone');
  } finally { srv.close(); }
});

test('My List remembers when titles were added and liked', () => {
  const ud = new UserData(fs.mkdtempSync(path.join(os.tmpdir(), 'ml-')));
  ud.toggle('p', 'list', 'a', true);
  const at = ud.of('p').data.listAt.a;
  assert.ok(at > 0);
  ud.rate('p', 'b', 1);
  assert.ok(ud.of('p').data.ratedAt.b > 0);
  assert.ok(ud.snapshot('p').listAt.a === at && ud.snapshot('p').ratedAt.b > 0);
  ud.toggle('p', 'list', 'a', false);
  assert.ok(!('a' in ud.of('p').data.listAt));
  ud.rate('p', 'b', 0);
  assert.ok(!('b' in ud.of('p').data.ratedAt));
});

test('genres TMDB gives series no name for: from its keywords, else a clear phrase in the description', () => {
  const show = (k, kw, extra) => tagOf({ t: 'show', n: 'Show ' + k, k, g: 'Series', rg: 'Series', gn: ['Drama', 'Mystery'], ...extra }, { meta: (key) => (key === k && kw ? { kw } : null) }, { smart: { on: true, plot: true } });
  has(show('a', ['supernatural horror', 'small town']), 'g:horror', 'g:drama', 'g:mystery');
  has(show('b', ['zombie apocalypse']), 'g:horror');
  has(show('c', ['psychological thriller']), 'g:thriller');
  has(show('d', ['love triangle', 'high school']), 'g:romance');
  lacks(show('e', ['bromance', 'loss of loved one']), 'g:romance');
  has(show('f', ['period drama']), 'g:history');
  has(show('g', ['musician']), 'g:music');
  has(show('h', ['sports documentary']), 'g:sports');
  has(show('i', ['stand-up comedy']), 'g:standup', 'g:comedy');
  has(show('j', ['cooking competition']), 'g:lifestyle', 'g:reality');
  has(show('k', ['christian faith']), 'g:faith');
  lacks(show('l', ['time travel', 'space travel']), 'g:lifestyle', 'g:horror');
  // No keywords: the description, only for clear phrases.
  has(show('m', null, { plot: 'A horror anthology of stories set in one cursed town.' }), 'g:horror');
  lacks(show('n', null, { plot: 'He survived the horrors of war and came home.' }), 'g:horror');
  has(show('o', null, { plot: 'A romantic comedy about two rival bakers.' }), 'g:romance');
  // A film's description isn't read for these (TMDB names its genres).
  lacks(tagOf({ t: 'movie', n: 'Film', k: 'p', g: 'Movies', plot: 'A horror anthology.' }, {}, { smart: { on: true, plot: true } }), 'g:horror');
});
