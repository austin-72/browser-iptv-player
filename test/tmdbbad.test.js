// A provider's TMDB number that's "0" or wrong: the name is looked up instead (those titles used to stay "not looked
// up yet" however often details were fetched).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const { Tmdb } = require('../lib/tmdb');

test('a wrong TMDB number from the provider falls back to the name', async () => {
  const asked = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    asked.push(u.pathname);
    const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (u.pathname === '/search/tv') return send(200, { results: [{ id: 55 }] });
    if (u.pathname === '/tv/55') return send(200, { id: 55, name: 'Hungry for Answers', overview: 'Food.', first_air_date: '2022-01-01', genres: [], credits: { cast: [], crew: [] }, content_ratings: { results: [] } });
    send(404, { status_code: 34 });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmdbbad-'));
    const t = new Tmdb({ dataDir: dir, getKey: () => 'k', base: `http://127.0.0.1:${srv.address().port}` });
    for (const bad of ['0', '299903']) {
      const it = { k: 'K' + bad, t: 'show', n: 'Hungry for Answers', y: 2022, tmdb: bad };
      const m = await t.details(it);
      assert.ok(m && m.tmdb === 55, `found by name (provider said ${bad})`);
      assert.strictEqual(t.map.data.m[it.k].id, 55);
      assert.ok(t.meta.data.m[it.k], 'so it counts as looked up');
    }
    assert.ok(!asked.includes('/tv/0'), 'a "0" isn’t even asked for');
    assert.ok(asked.includes('/tv/299903'));
  } finally { srv.close(); }
});
