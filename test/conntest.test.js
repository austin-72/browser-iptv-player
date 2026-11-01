// The admin's "how many streams at once?" test, against a stand-in provider with a connection limit.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { ConnTest, parseHls } = require('../lib/conntest');

/** A provider allowing `n` streams at once; `mode` says what happens to one more: refuse | kick | msg. */
function provider() {
  const conns = new Map(); // account -> [res]
  const srv = http.createServer((req, res) => {
    const m = /^\/(\w+)\/(\w+)\/(\d+)\/(\w+)$/.exec(req.url);
    if (!m) { res.writeHead(404); return res.end(); }
    const [, mode, kind, n, id] = m;
    if (id === 'dead') { res.writeHead(404); return res.end(); }
    const list = conns.get(mode + n) || conns.set(mode + n, []).get(mode + n);
    if (list.length >= +n) {
      if (mode === 'kick') list.shift().destroy();
      else if (mode === 'msg') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('Max connections reached'); }
      else { res.writeHead(403); return res.end(); }
    }
    list.push(res);
    res.on('close', () => { const i = list.indexOf(res); if (i >= 0) list.splice(i, 1); });
    const live = kind === 'live';
    res.writeHead(200, live ? { 'Content-Type': 'video/mp2t' } : { 'Content-Type': 'video/mp4', 'Content-Length': 400e6 });
    const chunk = Buffer.alloc(64 * 1024, 0x47);
    if (live) { const t = setInterval(() => res.write(chunk), 40); res.on('close', () => clearInterval(t)); return; }
    let sent = 0;
    const pump = () => { while (sent < 400e6) { sent += chunk.length; if (!res.write(chunk)) return res.once('drain', pump); } res.end(); };
    pump();
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

async function run(base, mode, n, kinds) {
  const l = { id: 'L', type: 'url', name: 'Test' };
  const items = [];
  for (const id of ['dead', 1, 2, 3, 4, 5, 6, 7]) items.push({ t: 'live', n: `Ch ${id}`, g: `g${id}`, src: 'L', u: `${base}/${mode}/live/${n}/${id}` });
  for (const id of [1, 2, 3, 4, 5, 6, 7]) items.push({ t: 'movie', n: `Film ${id}`, g: `m${id}`, src: 'L', u: `${base}/${mode}/movie/${n}/${id}` });
  const ct = new ConnTest({
    lists: { get: () => l, store: { save() {} }, accountStatus: async () => null },
    catalog: { items, episodes: async () => [] },
    headers: (h) => ({ ...h }), usage: () => [], timing: { live: 400, vod: 400, pause: 300 },
  });
  ct.start('L', { kinds });
  for (let i = 0; i < 600 && ct.status('L').running; i++) await new Promise((r) => setTimeout(r, 100));
  return { job: ct.status('L'), saved: l.connTest };
}

test('finds the limit whether the provider refuses, sends a message, or cuts the oldest', { timeout: 120000 }, async () => {
  const { srv, base } = await provider();
  try {
    let r = await run(base, 'refuse', 2, ['live']);
    const live = r.job.kinds[0];
    assert.strictEqual(live.state, 'done');
    assert.strictEqual(live.max, 2);
    assert.strictEqual(live.how, 'refused');
    assert.match(live.why, /403/);
    assert.strictEqual(live.steps[0].ok, false, 'the dead first channel was tried first…');
    assert.strictEqual(live.steps[1].ok, true, '…and another one was used instead');
    assert.deepStrictEqual(r.saved.live, { max: 2, limited: true, how: 'refused', why: live.why });

    r = await run(base, 'msg', 1, ['movie']);
    assert.strictEqual(r.job.kinds[0].max, 1);
    assert.match(r.job.kinds[0].why, /Max connections reached/);

    r = await run(base, 'kick', 2, ['live', 'movie']);
    for (const K of r.job.kinds) {
      assert.strictEqual(K.max, 2, `${K.k}: ${K.why}`);
      assert.strictEqual(K.how, 'kicks', `${K.k}: a cut-off older stream is noticed`);
    }

    r = await run(base, 'refuse', 9, ['live']);
    assert.strictEqual(r.job.kinds[0].max, 6);
    assert.strictEqual(r.job.kinds[0].limited, false);
  } finally { srv.close(); srv.closeAllConnections(); }
});

test('reads HLS master and media playlists', () => {
  const m = parseHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000\nhi/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=600000\nlo/index.m3u8\n', 'http://p/x/master.m3u8');
  assert.deepStrictEqual(m.variants.map((v) => v.url), ['http://p/x/hi/index.m3u8', 'http://p/x/lo/index.m3u8']);
  const p = parseHls('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:120\n#EXTINF:4,\na.ts\n#EXTINF:4,\n/b.ts\n#EXT-X-ENDLIST\n', 'http://p/x/v.m3u8');
  assert.deepStrictEqual([p.seq, p.target, p.end, p.segs], [120, 4, true, ['http://p/x/a.ts', 'http://p/b.ts']]);
});
