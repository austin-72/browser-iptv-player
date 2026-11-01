// A tiny stand-in for the TMDB API, for tests. node test/mock/tmdb.js [port]
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
const colOf = (id) => Object.keys(COLS).find((c) => COLS[c].parts.includes(+id));
const res = (r, code, o) => { r.writeHead(code, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
const card = (id) => ({ id: +id, title: M[id].title, release_date: `${M[id].y}-01-01`, poster_path: `/p${id}.jpg` });
http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  if (u.searchParams.get('api_key') !== 'testkey') return res(r, 401, { status_message: 'Invalid API key' });
  let m;
  if (u.pathname === '/configuration') return res(r, 200, { images: {} });
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
}).listen(+process.argv[2] || 9200, () => console.log('mock tmdb up'));
