'use strict';
// More from TMDB (lib/tmdbmore.js, lib/routes-p14.js): what a title's page adds, people, episode orders, ratings from
// other countries, rows made by choosing — on answers shaped as TMDB gives them, and through the real server against
// a stand-in TMDB (no request ever leaves this machine).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const M = require('../lib/tmdbmore');
const { certLevel } = require('../lib/catalog');
const { parseSource } = require('../lib/homelists');
const N = require('../lib/subnames');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => ok(n)); }); });

// A film's details as TMDB answers /movie/{id}?append_to_response=credits,release_dates,images,external_ids,reviews,alternative_titles
const FILM = {
  id: 603, title: 'The Matrix', original_title: 'The Matrix', original_language: 'en', tagline: 'Believe the unbelievable.', status: 'Released', homepage: 'https://www.warnerbros.com/movies/matrix',
  budget: 63000000, revenue: 463517383, imdb_id: 'tt0133093', release_date: '1999-03-31', production_companies: [{ name: 'Village Roadshow Pictures' }, { name: 'Warner Bros. Pictures' }], production_countries: [{ iso_3166_1: 'US' }],
  credits: {
    cast: [{ id: 6384, name: 'Keanu Reeves', character: 'Thomas A. Anderson / Neo', profile_path: '/keanu.jpg', order: 0 }, { id: 2975, name: 'Laurence Fishburne', character: 'Morpheus', profile_path: null, order: 1 }, { id: 9, name: 'A Voice', character: 'Computer (voice)', profile_path: '/../x.jpg', order: 2 }],
    crew: [{ id: 9340, name: 'Lilly Wachowski', job: 'Director', profile_path: '/lw.jpg' }, { id: 9339, name: 'Lana Wachowski', job: 'Director' }, { id: 9340, name: 'Lilly Wachowski', job: 'Writer' }, { id: 1, name: 'Don Davis', job: 'Original Music Composer' }, { id: 2, name: 'Bill Pope', job: 'Director of Photography' }, { id: 3, name: 'Someone Else', job: 'Gaffer' }],
  },
  release_dates: { results: [
    { iso_3166_1: 'US', release_dates: [{ certification: 'R', type: 3, release_date: '1999-03-31T00:00:00.000Z' }, { certification: '', type: 1, release_date: '1999-03-24T00:00:00.000Z' }, { certification: 'R', type: 4, release_date: '1999-09-21T00:00:00.000Z' }, { certification: 'R', type: 5, release_date: '1999-12-07T00:00:00.000Z' }, { certification: 'R', type: 3, release_date: '2019-08-30T00:00:00.000Z' }] },
    { iso_3166_1: 'GB', release_dates: [{ certification: '15', type: 3, release_date: '1999-06-11T00:00:00.000Z' }] },
    { iso_3166_1: 'DE', release_dates: [{ certification: '16', type: 3, release_date: '1999-06-17T00:00:00.000Z' }] },
  ] },
  images: { logos: [{ file_path: '/de.png', iso_639_1: 'de', aspect_ratio: 3, vote_average: 9 }, { file_path: '/en-low.png', iso_639_1: 'en', aspect_ratio: 3, vote_average: 2 }, { file_path: '/en.png', iso_639_1: 'en', aspect_ratio: 4.1, vote_average: 5.3 }, { file_path: '/square.png', iso_639_1: 'en', aspect_ratio: 1, vote_average: 9 }, { file_path: '/none.svg', iso_639_1: null, aspect_ratio: 3, vote_average: 8 }] },
  external_ids: { imdb_id: 'tt0133093' },
  reviews: { total_results: 3, results: [
    { author: 'ohlalipop', author_details: { name: '', username: 'ohlalipop', rating: 9 }, created_at: '2017-01-25T02:11:01.000Z', url: 'https://www.themoviedb.org/review/58880e1bc3a3684480008dd3', content: 'I have **watched** this _three_ times.\r\n\r\n<em>Still</em> holds up — see [my blog](https://spam.example/x) for more words about it and why.' },
    { author: 'x', author_details: { rating: null }, created_at: '2020-01-01T00:00:00.000Z', url: 'javascript:alert(1)', content: 'Too short.' },
    { author: 'Manuel', author_details: { name: 'Manuel São Bento', rating: 10 }, created_at: '2021-12-22T10:00:00.000Z', url: 'https://www.themoviedb.org/review/61c2', content: 'x'.repeat(3000) },
  ] },
  alternative_titles: { titles: [{ iso_3166_1: 'RU', title: 'Матрица' }, { iso_3166_1: 'US', title: 'The Matrix 1' }, { iso_3166_1: 'FR', title: 'Matrix' }, { iso_3166_1: 'GB', title: 'the matrix' }] },
};
const SHOW = {
  id: 71446, name: 'Money Heist', original_name: 'La casa de papel', original_language: 'es', status: 'Ended', number_of_seasons: 3, number_of_episodes: 41, first_air_date: '2017-05-02', last_air_date: '2021-12-03', origin_country: ['ES'],
  networks: [{ name: 'Netflix' }, { name: 'Antena 3' }], created_by: [{ id: 1, name: 'Álex Pina', profile_path: '/ap.jpg' }],
  aggregate_credits: { cast: [{ id: 10, name: 'Úrsula Corberó', profile_path: '/uc.jpg', roles: [{ character: 'Tokio (voice)', episode_count: 2 }, { character: 'Tokio', episode_count: 41 }], total_episode_count: 41 }], crew: [{ id: 20, name: 'Jesús Colmenar', jobs: [{ job: 'Director', episode_count: 16 }] }, { id: 21, name: 'Manel Santisteban', jobs: [{ job: 'Original Music Composer', episode_count: 41 }] }] },
  content_ratings: { results: [{ iso_3166_1: 'ES', rating: '16' }, { iso_3166_1: 'BR', rating: 'L' }, { iso_3166_1: 'US', rating: 'NR' }] },
  alternative_titles: { results: [{ iso_3166_1: 'ES', title: 'La casa de papel (Antena 3)' }, { iso_3166_1: 'US', title: 'Money Heist' }] },
};

test('age ratings: the household’s country, then the US, then another that says something', () => {
  const pick = (j, type, region) => M.pickCert(j, type, region, certLevel);
  assert.deepStrictEqual(pick(FILM, 'movie', 'US'), { c: 'R', cc: 'US' });
  assert.deepStrictEqual(pick(FILM, 'movie', 'GB'), { c: '15', cc: 'GB' });
  assert.deepStrictEqual(pick(FILM, 'movie', 'JP'), { c: 'R', cc: 'US' }, 'none for that country: the US one');
  // No US rating worth the name ("NR"): Spain's, not Brazil's "L" — a bare letter means different things in different countries.
  assert.deepStrictEqual(pick(SHOW, 'tv', 'US'), { c: '16', cc: 'ES' });
  assert.deepStrictEqual(pick({ content_ratings: { results: [{ iso_3166_1: 'BR', rating: 'L' }] } }, 'tv', 'US'), { c: '', cc: '' });
  assert.deepStrictEqual(pick({}, 'movie', 'US'), { c: '', cc: '' });
  // What parental limits make of them (lib/catalog.js): 0 little kids … 4 adults only, -1 unknown.
  assert.deepStrictEqual(['G', 'PG-13', 'TV-MA', '15', '16', 'FSK 12', 'K-12', 'MA15+', 'R18+', 'TP', 'AL', '14A', '18A', 'U/A', 'pg13'].map(certLevel), [0, 2, 3, 3, 3, 2, 2, 3, 4, 0, 0, 2, 3, 1, 2]);
  assert.deepStrictEqual(['NR', 'Unrated', 'A', 'B', 'L', 'M', 'T', ''].map(certLevel), [-1, -1, -1, -1, -1, -1, -1, -1], 'nothing is read into these');
});

test('a film’s page: logo, tagline, cast and makers, facts, release dates, reviews, other names', () => {
  const t = M.shapeTitle(FILM, { type: 'movie', lang: 'en', region: 'US', level: certLevel });
  assert.strictEqual(t.logo, M.IMG + 'w500/en.png', 'English, the best liked, wide enough to read');
  assert.strictEqual(M.logoOf(FILM, 'de'), M.IMG + 'w500/de.png');
  assert.strictEqual(M.logoOf({ images: { logos: [{ file_path: '/none.svg', iso_639_1: null, aspect_ratio: 3 }, { file_path: '/ja.png', iso_639_1: 'ja', aspect_ratio: 3 }] } }, 'fr'), M.IMG + 'w500/none.svg', 'one without words rather than one in a language nobody here reads');
  assert.strictEqual(M.logoOf({}, 'en'), '');
  assert.strictEqual(t.tagline, 'Believe the unbelievable.');
  assert.deepStrictEqual(t.cast.slice(0, 2), [{ id: 6384, name: 'Keanu Reeves', as: 'Thomas A. Anderson / Neo', img: M.IMG + 'w185/keanu.jpg' }, { id: 2975, name: 'Laurence Fishburne', as: 'Morpheus', img: '' }]);
  assert.deepStrictEqual([t.cast[2].as, t.cast[2].img], ['Computer', ''], '"(voice)" off the end; a picture path that isn’t one is no picture');
  assert.deepStrictEqual(t.crew.map((c) => `${c.job}: ${c.name}`), ['Director: Lilly Wachowski', 'Director: Lana Wachowski', 'Writer: Lilly Wachowski', 'Music: Don Davis', 'Photography: Bill Pope']);
  assert.deepStrictEqual(t.dates, [{ what: 'In cinemas', date: '1999-03-31' }, { what: 'Digital', date: '1999-09-21' }, { what: 'On disc', date: '1999-12-07' }], 'the first of each; the premiere and the re-release aren’t listed');
  assert.deepStrictEqual(M.datesOf(FILM, 'DE'), [{ what: 'In cinemas', date: '1999-06-17' }]);
  assert.deepStrictEqual([t.facts.status, t.facts.original, t.facts.budget, t.facts.revenue, t.facts.site, t.imdb, t.cert], ['', '', 63000000, 463517383, 'https://www.warnerbros.com/movies/matrix', 'tt0133093', 'R']);
  assert.deepStrictEqual(t.facts.studios, ['Village Roadshow Pictures', 'Warner Bros. Pictures']);
  // Reviews: plain words (no markup, no links out), the too-short one left out, a long one cut, only TMDB's own address kept.
  assert.strictEqual(t.reviews.length, 2);
  assert.deepStrictEqual([t.reviews[0].by, t.reviews[0].stars, t.reviews[0].at, t.reviews[0].url], ['ohlalipop', 9, '2017-01-25', 'https://www.themoviedb.org/review/58880e1bc3a3684480008dd3']);
  assert.strictEqual(t.reviews[0].text, 'I have watched this three times.\n\n Still holds up — see my blog for more words about it and why.');
  assert.ok(t.reviews[1].by === 'Manuel São Bento' && t.reviews[1].text.length <= 2401 && t.reviews[1].text.endsWith('…'));
  assert.strictEqual(M.reviewsOf({ reviews: { results: [{ content: 'y'.repeat(50), url: 'https://evil.example/review/1', author: 'a' }] } })[0].url, '');
  // A page of reviews on its own (GET /reviews): all of it, each with its id.
  const page = { results: Array.from({ length: 20 }, (_, i) => ({ id: 'id' + i, author: 'a' + i, content: 'z'.repeat(60) })) };
  assert.strictEqual(M.reviewsOf(page).length, 6);
  assert.deepStrictEqual([M.reviewsOf(page, 0).length, M.reviewsOf(page, 0)[19].id], [20, 'id19']);
  assert.deepStrictEqual(t.aka, ['The Matrix 1', 'Матрица', 'Matrix'], 'not its own name again; the US and British ones first');
  assert.strictEqual(M.shapeTitle({ ...FILM, homepage: 'javascript:alert(1)', imdb_id: 'x', external_ids: {} }, { type: 'movie' }).facts.site, '');
  assert.strictEqual(M.shapeTitle({ ...FILM, homepage: 'http://insecure.example', imdb_id: '<b>', external_ids: {} }, { type: 'movie' }).imdb, '');
});

test('a series’ page: who is in the most episodes as whom, its creators, where it ran', () => {
  const t = M.shapeTitle(SHOW, { type: 'tv', lang: 'en', region: 'US', level: certLevel });
  assert.deepStrictEqual(t.cast, [{ id: 10, name: 'Úrsula Corberó', as: 'Tokio', img: M.IMG + 'w185/uc.jpg', n: 41 }]);
  assert.deepStrictEqual(t.crew.map((c) => `${c.job}: ${c.name}`), ['Creator: Álex Pina', 'Music: Manel Santisteban'], 'not each episode’s director');
  assert.deepStrictEqual([t.facts.status, t.facts.original, t.facts.lang, t.facts.seasons, t.facts.episodes, t.facts.first, t.facts.last], ['Ended', 'La casa de papel', 'es', 3, 41, '2017-05-02', '2021-12-03']);
  assert.deepStrictEqual(t.facts.networks, ['Netflix', 'Antena 3']);
  assert.deepStrictEqual([t.cert, t.certFrom, t.dates.length], ['16', 'ES', 0]);
  assert.deepStrictEqual(t.aka, ['La casa de papel', 'La casa de papel (Antena 3)']);
  // Subtitles named for it under its original name aren't doubted once that name is known.
  const o = (aka) => N.otherTitle(N.describe({ name: 'La.Casa.de.Papel.S01E01.1080p.NF.WEB-DL' }), { name: 'La.Casa.de.Papel.S01E01.1080p.NF.WEB-DL' }, { query: 'Money Heist', season: 1, episode: 1, aka });
  assert.ok(o([]).doubt);
  assert.strictEqual(o(t.aka), null);
});

test('a person: what they did, one line a title; not the talk shows', () => {
  const j = { id: 6384, name: 'Keanu Reeves', biography: 'Keanu **Charles** Reeves is an actor.\r\n\r\n\r\n\r\nMore.', birthday: '1964-09-02', deathday: null, place_of_birth: 'Beirut, Lebanon', profile_path: '/kr.jpg', known_for_department: 'Acting', external_ids: { imdb_id: 'nm0000206' },
    combined_credits: {
      cast: [{ id: 603, media_type: 'movie', title: 'The Matrix', character: 'Neo', release_date: '1999-03-31', poster_path: '/m.jpg', vote_count: 25000, popularity: 80 }, { id: 245891, media_type: 'movie', title: 'John Wick', character: 'John Wick', release_date: '2014-10-22', vote_count: 19000, popularity: 60 },
        { id: 1, media_type: 'tv', name: 'The Late Show', character: 'Self', first_air_date: '2015-09-08', episode_count: 4, vote_count: 300 }, { id: 2, media_type: 'tv', name: 'Swedish Dicks', character: 'Tex', first_air_date: '2016-09-02', episode_count: 12 }, { id: 3, media_type: 'movie', title: 'Adult Thing', character: 'x', adult: true }, { id: 4, media_type: 'person', name: 'nope' }],
      crew: [{ id: 245891, media_type: 'movie', title: 'John Wick', job: 'Executive Producer', release_date: '2014-10-22' }, { id: 5, media_type: 'movie', title: 'Man of Tai Chi', job: 'Director', release_date: '2013-07-04' }],
    } };
  const p = M.shapePerson(j);
  assert.deepStrictEqual(p, { id: 6384, name: 'Keanu Reeves', img: M.IMG + 'h632/kr.jpg', bio: 'Keanu Charles Reeves is an actor.\n\nMore.', born: '1964-09-02', died: '', place: 'Beirut, Lebanon', dept: 'Actor', imdb: 'nm0000206', adult: false });
  const c = M.creditsOfPerson(j);
  assert.deepStrictEqual(c.map((x) => `${x.type} ${x.title} (${x.year}): ${x.as}`), ['movie The Matrix (1999): Neo', 'movie John Wick (2014): John Wick · Executive Producer', 'tv Swedish Dicks (2016): Tex', 'movie Man of Tai Chi (2013): Director']);
  assert.strictEqual(c[2].n, 12);
  assert.ok(c[0].pop > c[1].pop);
});

test('a series’ episodes in another order', () => {
  const groups = { results: [{ id: '5acf93e60e0a26346d0000ce', name: 'DVD Order', type: 3, episode_count: 14, group_count: 1, description: 'As the creator meant.' }, { id: 'nope', name: 'x', type: 1, episode_count: 5 }, { id: '5acf93e60e0a26346d0000cf', name: 'Empty', type: 2, episode_count: 0 }] };
  assert.deepStrictEqual(M.shapeOrders(groups), [{ id: '5acf93e60e0a26346d0000ce', name: 'DVD Order', kind: 'DVD order', seasons: 1, episodes: 14, note: 'As the creator meant.' }]);
  assert.deepStrictEqual(M.shapeOrders(null), []);
  const still = (p) => (p ? 'IMG' + p : '');
  // Firefly, as shown on TV (the pilot last) and as on the discs (the pilot first).
  const g = { groups: [{ name: 'Season 1', order: 1, episodes: [{ name: 'Serenity', order: 0, season_number: 1, episode_number: 11, still_path: '/s.jpg', air_date: '2002-12-20', runtime: 86, vote_average: 8.24 }, { name: 'The Train Job', order: 1, season_number: 1, episode_number: 1, overview: 'A job.' }] }, { name: 'Specials', order: 0, episodes: [{ name: 'Making Of', order: 0, season_number: 0, episode_number: 3 }] }] };
  const s = M.seasonsOfGroup(g, still);
  assert.deepStrictEqual(s[1][1], ['Serenity', '', 'IMG/s.jpg', '2002-12-20', 86, 8.2, 1, 11], 'with where it is in the usual order: what subtitle sites go by');
  assert.deepStrictEqual([s[1][2][0], s[1][2][6], s[1][2][7], s[0][1][0]], ['The Train Job', 1, 1, 'Making Of']);
  // Numbered straight through: one season of everything. Groups without season names count 1, 2, 3.
  const abs = M.seasonsOfGroup({ groups: [{ name: 'All Episodes', order: 0, episodes: [{ name: 'a', order: 0, season_number: 1, episode_number: 1 }, { name: 'b', order: 1, season_number: 2, episode_number: 1 }] }] }, still);
  assert.deepStrictEqual([Object.keys(abs), abs[1][2][0], abs[1][2][6]], [['1'], 'b', 2]);
  const arcs = M.seasonsOfGroup({ groups: [{ name: 'East Blue', order: 0, episodes: [{ name: 'a', order: 0 }] }, { name: 'Alabasta', order: 1, episodes: [{ name: 'b', order: 0 }] }] }, still);
  assert.deepStrictEqual(Object.keys(arcs), ['1', '2']);
  assert.deepStrictEqual(M.seasonsOfGroup(null, still), {});
});

test('a Home row made by choosing: what TMDB is asked, and what the row is called', () => {
  const names = { genres: new Map([[28, 'Action'], [35, 'Comedy']]), services: new Map([[8, 'Netflix']]), langName: (c) => ({ ko: 'Korean' }[c] || c) };
  let d = M.discoverOf({ type: 'movie', genres: [28, 35], from: 2010, stars: 7, sort: 'rated' }, 'US', names);
  assert.deepStrictEqual(d, { type: 'movie', name: 'Best-rated Action + Comedy films since 2010 rated 7+', params: { include_adult: 'false', with_genres: '28,35', 'primary_release_date.gte': '2010-01-01', 'vote_average.gte': '7', 'vote_count.gte': '80', sort_by: 'vote_average.desc' } });
  d = M.discoverOf({ type: 'tv', lang: 'ko', service: 8, from: 2019, to: 2021 }, 'GB', names);
  assert.deepStrictEqual(d, { type: 'tv', name: 'Series 2019–2021 in Korean on Netflix', params: { include_adult: 'false', 'first_air_date.gte': '2019-01-01', 'first_air_date.lte': '2021-12-31', with_original_language: 'ko', with_watch_providers: '8', watch_region: 'GB', sort_by: 'popularity.desc' } });
  d = M.discoverOf({ sort: 'newest', genres: ['28; drop table', 99999999, -1] }, 'xx', names);
  assert.strictEqual(d.params.sort_by, 'primary_release_date.desc');
  assert.match(d.params['primary_release_date.lte'], /^\d{4}-\d\d-\d\d$/, 'newest: not ones still to come');
  assert.strictEqual(d.params.with_genres, undefined, 'only numbers get through');
  // Kept as one line of text; only what is understood survives; the same choice is the same row.
  assert.strictEqual(M.packChoice({ type: 'tv', genres: [35, 28, 35], from: '2010', stars: '7.5', lang: 'ko', service: '8', sort: 'rated', evil: '<script>', to: 'x' }), '{"type":"tv","genres":[28,35],"from":2010,"stars":7.5,"lang":"ko","service":8,"sort":"rated"}');
  assert.strictEqual(M.packChoice({}), '{}');
  assert.deepStrictEqual(parseSource({ kind: 'tmdb-discover', ref: '{"genres":[35,28],"junk":1}' }), { kind: 'tmdb-discover', ref: '{"genres":[28,35]}' });
  assert.throws(() => parseSource({ kind: 'tmdb-discover', ref: '{}' }), /Choose at least one/);
  assert.throws(() => parseSource({ kind: 'tmdb-discover', ref: 'not json' }), /isn’t a row/);
});

test('what is saved is given at once; older than a day, it is asked for again behind the page', async () => {
  const { Tmdb } = require('../lib/tmdb');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmdbsoft-'));
  let hits = 0, tagline = 'First';
  const srv = http.createServer((req, res) => { hits++; setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 603, title: 'The Matrix', tagline })); }, 150); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const t = new Tmdb({ dataDir: dir, getKey: () => 'k', base: `http://127.0.0.1:${srv.address().port}` });
    const more = new M.TmdbMore({ tmdb: t, level: certLevel });
    t.map.data.m.x = { id: 603, type: 'movie' };
    const it = { k: 'x', t: 'movie', n: 'The Matrix' };
    assert.deepStrictEqual(await more.saved(it), { have: false, bytes: 0 });
    assert.deepStrictEqual(await more.saved({ k: 'nope' }), { have: false, bytes: 0, unmatched: true });
    assert.strictEqual((await more.title(it)).tagline, 'First'); // (nothing saved: TMDB is waited for)
    assert.strictEqual(hits, 1);
    await wait(50);
    assert.strictEqual((await more.saved(it)).have, true);
    tagline = 'Second';
    assert.strictEqual((await more.title(it)).tagline, 'First');
    assert.strictEqual(hits, 1, 'within a day: from what is saved, nothing asked');
    // Two days old: still given at once (TMDB takes 150 ms here), and asked for again behind it — once.
    const r = more.titleReq(t.map.data.m.x), old = new Date(Date.now() - 2 * 86400e3);
    fs.utimesSync(t.cacheFile(r.p, r.params), old, old);
    const t0 = Date.now();
    const [a, b] = await Promise.all([more.title(it), more.title(it)]);
    assert.ok(a.tagline === 'First' && b.tagline === 'First' && Date.now() - t0 < 120, `${Date.now() - t0} ms`);
    for (let i = 0; i < 40 && (await more.title(it)).tagline !== 'Second'; i++) await wait(50);
    assert.strictEqual((await more.title(it)).tagline, 'Second', 'next time: the new answer');
    assert.strictEqual(hits, 2);
    // TMDB down: what is saved, however old.
    srv.close(); srv.closeAllConnections();
    fs.utimesSync(t.cacheFile(r.p, r.params), old, old);
    assert.strictEqual((await more.title(it)).tagline, 'Second');
  } finally { srv.close(); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
});

// ---------------------------------------------------------------- through the real server
function fakeTmdb() {
  const hits = [];
  const epg = '5acf93e60e0a26346d0000ce';
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(u.pathname + u.search.replace(/api_key=[^&]*&?/, ''));
    const send = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.searchParams.get('api_key') !== 'testkey') return send({}, 401);
    const p = u.pathname;
    if (p === '/configuration') return send({ images: {} });
    if (p === '/search/movie') return send({ results: /matrix/i.test(u.searchParams.get('query')) ? [{ id: 603, title: 'The Matrix', release_date: '1999-03-31' }] : /obscur/i.test(u.searchParams.get('query')) ? [{ id: 900, title: 'Obscura', release_date: '2015-01-01' }] : /toy/i.test(u.searchParams.get('query')) ? [{ id: 862, title: 'Toy Story', release_date: '1995-11-22' }] : [] });
    if (p === '/search/tv') return send({ results: /firefly/i.test(u.searchParams.get('query')) ? [{ id: 1437, name: 'Firefly', first_air_date: '2002-09-20' }] : [] });
    if (p === '/movie/603') return send({ ...FILM, overview: 'A hacker learns the truth.', genres: [{ name: 'Action' }], runtime: 136, vote_average: 8.2 });
    if (p === '/movie/603/reviews') {
      const pg = Number(u.searchParams.get('page')) || 1;
      const more = [1, 2].map((n) => ({ id: 'r' + n, author: 'p' + n, author_details: { rating: n * 4 }, created_at: `2024-0${n}-01T00:00:00.000Z`, content: `Page two review number ${n}, long enough to be shown here.` }));
      return send({ id: 603, page: pg, total_pages: 2, total_results: 5, results: pg === 1 ? FILM.reviews.results : pg === 2 ? more : [] });
    }
    if (p === '/movie/862') return send({ id: 862, title: 'Toy Story', release_date: '1995-11-22', genres: [{ name: 'Family' }], credits: { cast: [{ id: 31, name: 'Tom Hanks', character: 'Woody (voice)' }], crew: [] }, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'G', type: 3, release_date: '1995-11-22T00:00:00.000Z' }] }] }, reviews: { results: [{ author: 'a', content: 'A lovely film for everyone, start to finish, and it still looks good.' }] } });
    if (p === '/movie/900') return send({ id: 900, title: 'Obscura', original_title: 'Obskura', release_date: '2015-01-01', genres: [], credits: { cast: [{ id: 6384, name: 'Keanu Reeves', character: 'Walk-on', order: 30 }], crew: [] }, release_dates: { results: [{ iso_3166_1: 'DE', release_dates: [{ certification: '18', type: 3, release_date: '2015-01-01T00:00:00.000Z' }] }] } });
    if (p === '/tv/1437') return send({ id: 1437, name: 'Firefly', first_air_date: '2002-09-20', status: 'Canceled', genres: [], seasons: [{ season_number: 1 }], credits: { cast: [], crew: [] }, content_ratings: { results: [] }, aggregate_credits: { cast: [], crew: [] } });
    if (p === '/tv/1437/season/1') return send({ episodes: [{ episode_number: 1, name: 'The Train Job', overview: 'A job.' }, { episode_number: 2, name: 'Bushwhacked' }, { episode_number: 11, name: 'Serenity' }] });
    if (p === '/tv/1437/episode_groups') return send({ results: [{ id: epg, name: 'DVD Order', type: 3, episode_count: 3, group_count: 1 }] });
    if (p === `/tv/episode_group/${epg}`) return send({ id: epg, groups: [{ name: 'Season 1', order: 1, episodes: [{ name: 'Serenity', order: 0, season_number: 1, episode_number: 11 }, { name: 'The Train Job', order: 1, season_number: 1, episode_number: 1 }, { name: 'Bushwhacked', order: 2, season_number: 1, episode_number: 2 }] }] });
    if (p === '/person/6384') return send({ id: 6384, name: 'Keanu Reeves', biography: 'An actor.', birthday: '1964-09-02', profile_path: '/kr.jpg', known_for_department: 'Acting', combined_credits: { cast: [{ id: 603, media_type: 'movie', title: 'The Matrix', character: 'Neo', release_date: '1999-03-31', vote_count: 9 }, { id: 900, media_type: 'movie', title: 'Obscura', character: 'Walk-on', release_date: '2015-01-01', vote_count: 1 }, { id: 245891, media_type: 'movie', title: 'John Wick', character: 'John Wick', release_date: '2014-10-22', poster_path: '/jw.jpg', vote_count: 5 }], crew: [] } });
    if (p === '/person/66') return send({ id: 66, name: 'Someone', adult: true, combined_credits: { cast: [], crew: [] } });
    if (p === '/search/person') return send({ results: /keanu/i.test(u.searchParams.get('query')) ? [{ id: 1, name: 'Keanu Reeves', popularity: 99, known_for: [{ id: 5, media_type: 'movie' }] }, { id: 6384, name: 'Keanu Reeves', popularity: 20, known_for: [{ id: 603, media_type: 'movie' }] }] : [] });
    if (/^\/genre\/(movie|tv)\/list$/.test(p)) return send({ genres: [{ id: 28, name: 'Action' }, { id: 35, name: 'Comedy' }] });
    if (/^\/watch\/providers\/(movie|tv)$/.test(p)) return send({ results: [{ provider_id: 337, provider_name: 'Disney Plus', display_priority: 2 }, { provider_id: 8, provider_name: 'Netflix', display_priority: 0 }, { provider_id: 1899, provider_name: 'HBO Max Amazon Channel', display_priority: 1 }] });
    if (p === '/discover/movie') return send({ page: 1, total_pages: 1, results: u.searchParams.get('with_genres') === '28' ? [{ id: 603, title: 'The Matrix', release_date: '1999-03-31' }, { id: 245891, title: 'John Wick', release_date: '2014-10-22' }] : [] });
    return send({}, 404);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ base: `http://127.0.0.1:${srv.address().port}`, hits, close: () => { srv.close(); srv.closeAllConnections(); } })));
}

test('through the server: a title’s extras, a person, episode orders, a row by choosing — and what kids and switches hide', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmdbmore-'));
  const t = await fakeTmdb();
  const port = await freePort();
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(dir, 'data'), NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test', TMDB_BASE: t.base, TMDB_IMG_BASE: 'http://img.test/' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const device = () => {
    const d = { cookie: '' };
    d.raw = (method, p, body, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-App': '1', ...(d.cookie ? { Cookie: d.cookie } : {}), ...headers }, body });
    d.req = async (method, p, body) => {
      const r = await d.raw(method, p, body !== undefined ? JSON.stringify(body) : undefined, body !== undefined ? { 'Content-Type': 'application/json' } : {});
      const sc = r.headers.get('set-cookie');
      if (sc) d.cookie = sc.split(';')[0];
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch {}
      return { status: r.status, json: j, text: txt };
    };
    return d;
  };
  try {
    for (let i = 0; i < 150 && !/Ready/.test(out); i++) await wait(100);
    assert.match(out, /Ready/, out.slice(-500));
    const a = device();
    assert.strictEqual((await a.req('POST', '/api/login', { password: 'pw-test' })).status, 200);
    assert.strictEqual((await a.req('POST', '/api/profiles', { name: 'Alex', pin: '4821' })).status, 200);
    assert.strictEqual((await a.req('POST', '/api/profiles', { name: 'Robin', kids: true })).status, 200);
    const M3U = '#EXTM3U\n#EXTINF:-1 group-title="Films",The Matrix (1999)\nhttp://127.0.0.1:9/movie/u/p/1.mp4\n#EXTINF:-1 group-title="Films",Obscura (2015)\nhttp://127.0.0.1:9/movie/u/p/2.mp4\n#EXTINF:-1 group-title="Films",Toy Story (1995)\nhttp://127.0.0.1:9/movie/u/p/3.mp4\n'
      + '#EXTINF:-1 group-title="Series",Firefly S01 E01\nhttp://127.0.0.1:9/series/u/p/11.mp4\n#EXTINF:-1 group-title="Series",Firefly S01 E02\nhttp://127.0.0.1:9/series/u/p/12.mp4\n#EXTINF:-1 group-title="Series",Firefly S01 E03\nhttp://127.0.0.1:9/series/u/p/13.mp4\n';
    assert.strictEqual((await a.raw('POST', '/api/admin/lists/upload?name=L&fileName=l.m3u', Buffer.from(M3U))).status, 200);
    let cat = null, film = null, odd = null, show = null, toy = null;
    for (let i = 0; i < 60 && !(film && odd && show && toy); i++) { cat = (await a.req('GET', '/api/catalog')).json; const its = (cat && cat.items) || []; film = its.find((x) => /Matrix/.test(x.n)); odd = its.find((x) => /Obscura/.test(x.n)); toy = its.find((x) => /Toy Story/.test(x.n)); show = its.find((x) => x.t === 'show' && /Firefly/.test(x.n)); if (!(film && odd && show && toy)) await wait(200); }
    assert.ok(film && odd && show && toy, JSON.stringify(cat && cat.items && cat.items.map((x) => [x.t, x.n])));
    const more = async (d, k) => (await d.req('GET', `/api/title/${encodeURIComponent(k)}/more`)).json;

    // No key: nothing, and nothing asked of TMDB.
    assert.deepStrictEqual(await more(a, film.k), { none: true });
    assert.strictEqual((await a.req('GET', '/api/person/6384')).status, 400);
    assert.strictEqual(t.hits.length, 0);
    assert.strictEqual((await a.req('PUT', '/api/admin/settings', { tmdbKey: 'testkey' })).status, 200);

    // A film's page.
    assert.strictEqual((await a.req('GET', `/api/item/${encodeURIComponent(film.k)}`)).status, 200); // (its basics first, as a page does)
    const m = await more(a, film.k);
    assert.deepStrictEqual([m.tagline, m.logo, m.imdb, m.cert, m.people], ['Believe the unbelievable.', 'http://img.test/w500/en.png', 'tt0133093', 'R', true]);
    assert.deepStrictEqual(m.cast[0], { id: 6384, name: 'Keanu Reeves', as: 'Thomas A. Anderson / Neo', img: 'http://img.test/w185/keanu.jpg' });
    assert.ok(m.crew.some((c) => c.job === 'Director') && m.dates.length === 3 && m.reviews.length === 2 && m.facts.budget === 63000000);
    const asked = t.hits.filter((h) => /^\/movie\/603\?/.test(h) && /images/.test(h));
    assert.strictEqual(asked.length, 1);
    assert.match(decodeURIComponent(asked[0]), /append_to_response=credits,release_dates,images,external_ids,reviews,alternative_titles&include_image_language=en,null/);
    await more(a, film.k);
    assert.strictEqual(t.hits.filter((h) => /^\/movie\/603\?/.test(h) && /images/.test(h)).length, 1, 'asked once: kept after that');
    // A film with no US rating gets Germany's — and a kids profile no longer sees it.
    const k = device();
    await k.req('POST', '/api/login', { password: 'pw-test' });
    const robin = (await k.req('GET', '/api/boot')).json.profiles.find((x) => x.name === 'Robin');
    assert.strictEqual((await k.req('POST', `/api/profiles/${robin.id}/select`, {})).status, 200);
    assert.strictEqual((await a.req('GET', `/api/item/${encodeURIComponent(odd.k)}`)).json.c || '', '18', 'the age rating: Germany’s, there being no US one');
    // On a kids profile: no reviews. With the switches off: names without pages, no logo.
    assert.strictEqual((await a.req('PUT', '/api/admin/settings', { off: { people: true, logos: true } })).status, 200);
    const m2 = await more(a, film.k);
    assert.deepStrictEqual([m2.logo, m2.people, m2.cast[0]], ['', false, { name: 'Keanu Reeves', as: 'Thomas A. Anderson / Neo' }]);
    assert.strictEqual((await a.req('GET', '/api/person/6384')).status, 404);
    assert.strictEqual((await a.req('PUT', '/api/admin/settings', { off: { people: false, logos: false, reviews: true } })).status, 200);
    assert.strictEqual((await more(a, film.k)).reviews.length, 0);
    assert.strictEqual((await a.req('PUT', '/api/admin/settings', { off: { reviews: false } })).status, 200);
    assert.strictEqual((await a.req('GET', `/api/title/${encodeURIComponent(film.k)}/more`)).json.reviews.length, 2);
    // More of them, a page at a time: how many in all, then each page (the short one left out), and none past the last.
    const rv = (d, n) => d.req('GET', `/api/title/${encodeURIComponent(film.k)}/reviews?page=${n}`);
    assert.strictEqual((await more(a, film.k)).reviewCount, 3);
    const r1 = (await rv(a, 1)).json;
    assert.deepStrictEqual([r1.page, r1.pages, r1.total, r1.reviews.map((r) => r.by)], [1, 2, 5, ['ohlalipop', 'Manuel São Bento']]);
    const r2 = (await rv(a, 2)).json;
    assert.deepStrictEqual([r2.page, r2.reviews.map((r) => [r.id, r.stars, r.at])], [2, [['r1', 4, '2024-01-01'], ['r2', 8, '2024-02-01']]]);
    assert.strictEqual((await rv(a, 'x')).json.page, 1);
    assert.strictEqual((await a.req('PUT', '/api/admin/settings', { off: { reviews: true } })).status, 200);
    assert.strictEqual((await rv(a, 2)).status, 404, 'reviews switched off');
    assert.strictEqual((await more(a, film.k)).reviewCount, 0);
    assert.strictEqual((await a.req('PUT', '/api/admin/settings', { off: { reviews: false } })).status, 200);

    // A person: what is here first (the walk-on in Obscura too, though its own page lists only the leads), the rest for the Wishlist.
    const p = (await a.req('GET', '/api/person/6384')).json;
    assert.deepStrictEqual([p.name, p.dept, p.img, p.total], ['Keanu Reeves', 'Actor', 'http://img.test/h632/kr.jpg', 3]);
    assert.deepStrictEqual(p.here.map((h) => [h.k, h.as]), [[odd.k, 'Walk-on'], [film.k, 'Neo']]);
    assert.deepStrictEqual(p.more, [{ tmdb: 245891, type: 'movie', title: 'John Wick', year: 2014, poster: 'http://img.test/w185/jw.jpg', as: 'John Wick' }]);
    // By name: of two people called that, the one whose work is here.
    assert.strictEqual((await a.req('GET', '/api/person/0?n=' + encodeURIComponent('Keanu Reeves'))).json.id, 6384);
    assert.strictEqual((await a.req('GET', '/api/person/0?n=Nobody%20Atall')).status, 404);
    assert.strictEqual((await a.req('GET', '/api/person/66')).status, 404, 'not adult performers');

    // The order of a series' episodes: as on the discs, the pilot first.
    assert.strictEqual((await a.req('GET', `/api/item/${encodeURIComponent(show.k)}`)).status, 200);
    const titles = async () => (await a.req('GET', `/api/item/${encodeURIComponent(show.k)}`)).json.episodes.map((e) => e.et);
    assert.deepStrictEqual((await titles()).slice(0, 2), ['The Train Job', 'Bushwhacked']);
    const orders = (await a.req('GET', `/api/item/${encodeURIComponent(show.k)}/orders`)).json;
    assert.deepStrictEqual([orders.current, orders.options.map((o) => [o.name, o.kind, o.episodes])], ['', [['DVD Order', 'DVD order', 3]]]);
    assert.strictEqual((await a.req('POST', `/api/item/${encodeURIComponent(show.k)}/order`, { id: 'ffffffffffffffffffffffff' })).status, 400);
    assert.strictEqual((await a.req('POST', `/api/item/${encodeURIComponent(show.k)}/order`, { id: orders.options[0].id })).json.episodes, 3);
    assert.deepStrictEqual(await titles(), ['Serenity', 'The Train Job', 'Bushwhacked']);
    assert.strictEqual((await more(a, show.k)).order, orders.options[0].id);
    assert.match(out, /Alex set the episode order of “Firefly” to DVD Order/);
    assert.strictEqual((await a.req('POST', `/api/item/${encodeURIComponent(show.k)}/order`, { id: '' })).status, 200);
    assert.deepStrictEqual((await titles()).slice(0, 2), ['The Train Job', 'Bushwhacked']);

    assert.strictEqual((await a.req('GET', `/api/item/${encodeURIComponent(toy.k)}`)).json.c, 'G');
    // A kids profile: the page's extras without reviews, no changing the order, a person without the list of what isn't here.
    assert.notStrictEqual((await k.req('GET', `/api/title/${encodeURIComponent(film.k)}/more`)).status, 200, 'an R film isn’t this profile’s to ask about');
    const mk = await more(k, toy.k);
    assert.ok(mk.cast.length === 1 && mk.reviews.length === 0 && (await more(a, toy.k)).reviews.length === 1);
    assert.strictEqual((await k.req('GET', `/api/item/${encodeURIComponent(show.k)}/orders`)).status, 403);
    assert.strictEqual((await k.req('POST', `/api/item/${encodeURIComponent(show.k)}/order`, { id: '' })).status, 403);
    const pk = (await k.req('GET', '/api/person/6384')).json;
    assert.deepStrictEqual([pk.here.map((h) => h.k), pk.more], [[], []], 'an R film and an 18 one: neither is this profile’s to see');

    // Every title's page fetched ahead (Admin → Recommendations): only what isn't saved yet — Obscura's, never opened.
    assert.strictEqual((await k.req('POST', '/api/admin/tmdb/extras', {})).status, 403);
    const pages = () => t.hits.filter((h) => /^\/(movie|tv)\/\d+\?/.test(h) && /images/.test(h)).length;
    const runJob = async (body) => {
      const st = await a.req('POST', '/api/admin/tmdb/extras', body);
      assert.strictEqual(st.status, 200, st.text);
      let j = null;
      for (let i = 0; i < 100; i++) { j = (await a.req('GET', '/api/admin/tmdb/extras')).json; if (!j.job && j.last && j.last.finished >= st.json.started) break; await wait(100); }
      return j;
    };
    let before = pages();
    let jr = await runJob({});
    assert.deepStrictEqual([jr.titles, jr.last.total, jr.last.done, jr.last.fetched, jr.last.had, jr.last.failed], [4, 4, 4, 1, 3, 0]);
    assert.ok(jr.last.bytes > 1000 && pages() === before + 1);
    assert.match(out, /TMDB: page extras done — 1 fetched, 3 already here/);
    jr = await runJob({});
    assert.deepStrictEqual([jr.last.fetched, jr.last.had, pages()], [0, 4, before + 1], 'again: nothing to do, nothing asked');
    // A page opened after that comes straight from what is saved.
    assert.strictEqual((await more(a, odd.k)).cast[0].name, 'Keanu Reeves');
    assert.strictEqual(pages(), before + 1);
    // "Fetch them all again": every one asked for afresh.
    jr = await runJob({ mode: 'all' });
    assert.deepStrictEqual([jr.last.fetched, jr.last.had, pages()], [4, 0, before + 5]);

    // A row made by choosing.
    const opts = (await a.req('GET', '/api/homelists/options')).json;
    assert.deepStrictEqual([opts.genres.movie.map((g) => g.name), opts.services.map((s) => s.name)], [['Action', 'Comedy'], ['Netflix', 'Disney Plus']], 'services in TMDB’s order, without the "… Amazon Channel" doubles');
    const row = (await a.req('POST', '/api/homelists/rows', { kind: 'tmdb-discover', ref: JSON.stringify({ type: 'movie', genres: [28], sort: 'rated' }) })).json;
    assert.strictEqual(row.row.name, 'Best-rated Action films');
    const mine = row.rows.find((r) => r.id === row.row.id);
    assert.deepStrictEqual([mine.here, mine.total, mine.kind], [1, 2, 'tmdb-discover']);
    assert.strictEqual((await a.req('POST', '/api/homelists/rows', { kind: 'tmdb-discover', ref: '{}' })).status, 400);
    assert.doesNotMatch(out, /testkey/);
  } finally {
    const gone = new Promise((ok) => app.once('exit', ok));
    app.kill();
    await Promise.race([gone, wait(3000)]);
    t.close();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
});
