// A tiny stand-in for the TMDB API, for tests. node test/mock/tmdb.js [port] — or require it: start({ port }) → { base, state, close }.
const http = require('http');
const M = {
  1: { title: 'The Matrix', y: 1999, g: ['Action', 'Science Fiction'], recs: [2, 3, 7], cert: 'R' },
  2: { title: 'Inception', y: 2010, g: ['Action', 'Science Fiction', 'Thriller'], recs: [3, 1], cert: 'PG-13' },
  3: { title: 'Interstellar', y: 2014, g: ['Science Fiction', 'Drama'], recs: [2], cert: 'PG-13' },
  4: { title: 'The Notebook', y: 2004, g: ['Romance', 'Drama'], recs: [5], cert: 'PG-13' },
  5: { title: 'Titanic', y: 1997, g: ['Romance', 'Drama'], recs: [4], cert: 'PG-13' },
  6: { title: 'Toy Story', y: 1995, g: ['Animation', 'Family', 'Comedy'], recs: [], cert: 'G' },
  7: { title: 'Blade Runner', y: 1982, g: ['Science Fiction', 'Thriller'], recs: [1], cert: 'R' },
  8: { title: 'The Matrix Reloaded', y: 2003, g: ['Action', 'Science Fiction'], recs: [1], cert: 'R' },
  9: { title: 'Titanic II', y: 2010, g: ['Action'], recs: [], cert: 'PG-13' },
};
const COLS = { 100: { name: 'The Matrix Collection', parts: [1, 8] } };
// Series (ids 40+), TMDB lists and keywords (Home rows, Wishlist search).
const TV = { 42: { name: 'Harbor Lights', y: 2022 }, 43: { name: 'Night Train', y: 2021 }, 44: { name: 'Unaired Saga', y: 2026 } };
const LISTS = { 7001: { name: 'Best of Sci-Fi', items: [{ t: 'movie', id: 1 }, { t: 'movie', id: 3 }, { t: 'movie', id: 7 }, { t: 'tv', id: 43 }, { t: 'movie', id: 2 }] } };
const KEYWORDS = { 9715: { name: 'superhero', movie: [8, 1, 9] } };
const colOf = (id) => Object.keys(COLS).find((c) => COLS[c].parts.includes(+id));
const res = (r, code, o) => { r.writeHead(code, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
const card = (id) => ({ id: +id, title: M[id].title, release_date: `${M[id].y}-01-01`, poster_path: `/p${id}.jpg` });
const tvCard = (id) => ({ id: +id, name: TV[id].name, first_air_date: `${TV[id].y}-05-01`, poster_path: `/t${id}.jpg` });
const handler = (state) => (q, r) => {
  const u = new URL(q.url, 'http://x');
  state.hits.push(u.pathname);
  if (u.searchParams.get('api_key') !== 'testkey') return res(r, 401, { status_message: 'Invalid API key' });
  let m;
  if (u.pathname === '/configuration') return res(r, 200, { images: {} });
  if (u.pathname === '/search/multi') {
    const qs = (u.searchParams.get('query') || '').toLowerCase();
    const hit = (t) => t.toLowerCase().includes(qs);
    return res(r, 200, { results: [
      ...Object.keys(M).filter((id) => hit(M[id].title)).map((id) => ({ ...card(id), media_type: 'movie', overview: `${M[id].title} plot.` })),
      ...Object.keys(TV).filter((id) => hit(TV[id].name)).map((id) => ({ ...tvCard(id), media_type: 'tv' })),
      ...(hit('Some Person') ? [{ id: 5, name: 'Some Person', media_type: 'person' }] : []),
    ] });
  }
  if ((m = u.pathname.match(/^\/list\/(\d+)$/))) {
    const l = LISTS[m[1]];
    if (!l) return res(r, 404, { status_message: 'Not found' });
    const page = +(u.searchParams.get('page') || 1), per = 3, all = l.items;
    const items = all.slice((page - 1) * per, page * per).map((x) => (x.t === 'tv' ? { ...tvCard(x.id), media_type: 'tv' } : { ...card(x.id), media_type: 'movie' }));
    return res(r, 200, { id: +m[1], name: l.name, items, page, total_pages: Math.ceil(all.length / per), total_results: all.length });
  }
  if ((m = u.pathname.match(/^\/keyword\/(\d+)$/)) && KEYWORDS[m[1]]) return res(r, 200, { id: +m[1], name: KEYWORDS[m[1]].name });
  if ((m = u.pathname.match(/^\/discover\/(movie|tv)$/))) {
    const kw = KEYWORDS[u.searchParams.get('with_keywords')];
    const ids = (kw && kw[m[1]]) || [];
    return res(r, 200, { page: 1, total_pages: 1, results: ids.map((id) => (m[1] === 'tv' ? tvCard(id) : card(id))) });
  }
  if ((m = u.pathname.match(/^\/tv\/(\d+)$/)) && TV[m[1]]) return res(r, 200, { ...tvCard(m[1]), overview: 'A series.', genres: [{ name: 'Drama' }], credits: { cast: [], crew: [] }, content_ratings: { results: [] } });
  if ((m = u.pathname.match(/^\/search\/(movie|tv)$/))) {
    const qs = (u.searchParams.get('query') || '').toLowerCase();
    const exact = Object.keys(M).filter((id) => M[id].title.toLowerCase() === qs);
    const partial = Object.keys(M).filter((id) => !exact.includes(id) && qs.length > 3 && M[id].title.toLowerCase().includes(qs));
    return res(r, 200, { results: exact.concat(partial).map(card) });
  }
  if ((m = u.pathname.match(/^\/movie\/(\d+)\/(recommendations|similar)$/))) return res(r, 200, { results: m[2] === 'similar' ? [] : (M[m[1]] || { recs: [] }).recs.map(card) });
  if ((m = u.pathname.match(/^\/collection\/(\d+)$/)) && COLS[m[1]]) return res(r, 200, { id: +m[1], name: COLS[m[1]].name, parts: COLS[m[1]].parts.map((id) => ({ ...card(id), release_date: `${M[id].y}-03-31` })) });
  if ((m = u.pathname.match(/^\/movie\/(\d+)$/)) && M[m[1]]) {
    const x = M[m[1]];
    const col = colOf(m[1]);
    return res(r, 200, { id: +m[1], belongs_to_collection: col ? { id: +col, name: COLS[col].name } : null, title: x.title, overview: `${x.title} plot from TMDB.`, genres: x.g.map((name) => ({ name })), release_date: `${x.y}-03-31`, runtime: 120, vote_average: 8.1, poster_path: `/p${m[1]}.jpg`, backdrop_path: `/b${m[1]}.jpg`,
      credits: { cast: [{ name: 'Actor One' }, { name: 'Actor Two' }], crew: [{ job: 'Director', name: 'Some Director' }] }, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: x.cert }] }] } });
  }
  res(r, 404, { status_message: 'Not found' });
};
function start({ port = 0 } = {}) {
  const state = { hits: [] };
  const srv = http.createServer(handler(state));
  return new Promise((ok) => srv.listen(port, '127.0.0.1', () => ok({ base: `http://127.0.0.1:${srv.address().port}`, state, close: () => { srv.close(); srv.closeAllConnections(); } })));
}
module.exports = { start, M, TV, LISTS, KEYWORDS };
if (require.main === module) start({ port: +process.argv[2] || 9200 }).then(() => console.log('mock tmdb up'));
