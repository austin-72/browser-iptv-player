// Duplicates under different names: a provider's wrong TMDB number ("Fall" 2022 given "Fall 2: Deadpoint"'s), tags
// after the year ("Hope - 2026 CAM SUB"), a name one letter off ("Hopeu"), and the same film in another language.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const { Tmdb } = require('../lib/tmdb');
const { Catalog } = require('../lib/catalog');
const T = require('../lib/titles');

const D = (id, title, date) => ({ id, title, release_date: date, genres: [], credits: { cast: [], crew: [] }, release_dates: { results: [] } });
async function withTmdb(fn) {
  const asked = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    asked.push(u.pathname + (u.searchParams.get('query') ? '?' + u.searchParams.get('query') + '/' + (u.searchParams.get('year') || '') : ''));
    const send = (j) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (u.pathname === '/movie/1101412') return send(D(1101412, 'Fall 2: Deadpoint', '2026-08-01'));
    if (u.pathname === '/movie/985939') return send(D(985939, 'Fall', '2022-08-11'));
    if (u.pathname === '/movie/1596275') return send(D(1596275, 'Drive - The Pretenders', '2026-05-01'));
    if (u.pathname === '/movie/64690') return send(D(64690, 'Drive', '2011-09-15'));
    if (u.pathname === '/movie/40368') return send(D(40368, 'Nightmare', '1981-01-01'));
    if (u.pathname === '/search/movie') {
      const q = u.searchParams.get('query'), y = u.searchParams.get('year');
      if (q === 'Fall') return send({ results: [{ id: 1101412, title: 'Fall 2: Deadpoint', release_date: '2026-08-01' }, { id: 985939, title: 'Fall', release_date: '2022-08-11' }] });
      if (q === 'Drive') return send({ results: y === '2011' ? [{ id: 64690, title: 'Drive', release_date: '2011-09-15' }] : [{ id: 1596275, title: 'Drive - The Pretenders', release_date: '2026-05-01' }] });
      if (q === 'Nightmare') return send({ results: [{ id: 597208, title: 'Nightmare Alley', release_date: '1981-12-01' }, { id: 40368, title: 'Nightmare', release_date: '1981-01-01' }] });
      return send({ results: [] });
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(new Tmdb({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dupes3-')), getKey: () => 'k', base: `http://127.0.0.1:${srv.address().port}` }), asked); } finally { srv.close(); }
}

test('a provider’s TMDB number for another film years apart: the name is looked up instead', () => withTmdb(async (t, asked) => {
  const fall = { k: 'F', t: 'movie', n: 'Fall', tmdb: '1101412', ad: new Date(2022, 8, 6).getTime() };
  const m = await t.details(fall);
  assert.strictEqual(m.tmdb, 985939, 'Fall (2022), not Fall 2: Deadpoint (2026)');
  assert.strictEqual(t.map.data.m.F.id, 985939);
  // With a year of its own.
  const drive = { k: 'D', t: 'movie', n: 'Drive', y: 2011, tmdb: '1596275' };
  assert.strictEqual((await t.details(drive)).tmdb, 64690);
  // The one called exactly that comes first.
  assert.strictEqual((await t.details({ k: 'N', t: 'movie', n: 'Nightmare', y: 1981 })).tmdb, 40368);
  assert.ok(asked.includes('/search/movie?Fall/'));
}));

test('such a match from before is doubted (the year TMDB filled in doesn’t count as the title’s own)', () => withTmdb(async (t) => {
  t.map.data.m.Z = { id: 1507696, type: 'movie', list: 1 };
  t.meta.data.m.Z = { tmdb: 1507696, y: 2026 };
  assert.strictEqual(t.doubtful({ k: 'Z', t: 'movie', n: 'Z', y: 1969 }), true, 'Z (1969) isn’t Apocalypse Z (2026)');
  assert.strictEqual(t.doubtful({ k: 'Z', t: 'movie', n: 'Z', y: 2026, _ym: 1, ad: new Date(2021, 0, 1).getTime() }), true, 'listed in 2021');
  assert.strictEqual(t.doubtful({ k: 'Z', t: 'movie', n: 'Z', y: 2026, _ym: 1, ad: new Date(2026, 6, 1).getTime() }), false);
  t.map.data.m.Z.manual = 1;
  assert.strictEqual(t.doubtful({ k: 'Z', t: 'movie', n: 'Z', y: 1969 }), false, 'picked by hand');
}));

test('tags after the year come off; a name one letter off is the same title', () => {
  assert.deepStrictEqual(T.tidyVod('Hope - 2026 CAM SUB'), { n: 'Hope', y: 2026, note: '', cam: true });
  assert.strictEqual(T.tidyVod('Clayface - 2026 HDTS MULTI').n, 'Clayface');
  assert.ok(T.sameTitle('Hopeu', 2026, 'Hope', 2026));
  assert.ok(!T.sameTitle('Hopeu', 0, 'Hope', 2026), 'not without both years');
  assert.ok(!T.sameTitle('Cars', 2006, 'Cats', 2019));
});

test('the same film in another language is shown once, in the profile’s language', () => {
  let n = 0;
  const mv = (name, group) => ({ name, type: 'movie', url: `http://p/movie/u/p/${++n}.mp4`, group });
  const items = [mv('EN - The Nightmare Before Christmas (1993)', '|EN| KIDS'), mv('FR - L\'Étrange Noël de monsieur Jack (1993)', '|FR| FILMS')];
  const c = new Catalog({ lists: { all: () => [{ id: 'A', name: 'A', enabled: true, type: 'xtream' }], parsed: new Map([['A', { items, epgUrls: [] }]]) }, epg: { has: () => false, resolve: () => null }, getSettings: () => ({ tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [] }) });
  c.build();
  assert.strictEqual(c.items.filter((x) => x.t === 'movie').length, 2, 'two languages: two copies');
  c.foldId = (it) => 'movie:9479';
  const en = c._payloadItems(c.filterFor({ langs: ['en', 'fr'], restrictions: {} })).filter((x) => x.t === 'movie');
  assert.strictEqual(en.length, 1);
  const fr = c._payloadItems(c.filterFor({ langs: ['fr'], restrictions: {} })).filter((x) => x.t === 'movie');
  assert.deepStrictEqual(fr.map((x) => x.n), ['L\'Étrange Noël de monsieur Jack']);
});
