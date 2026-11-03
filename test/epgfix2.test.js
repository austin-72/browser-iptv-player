// Guide and TMDB fixes, second pass: gzip told by a first chunk of one byte, a broken gzip letting the download go,
// a guide cut short not replacing a whole one, guides saved a piece at a time, TMDB entries that are gone, and older
// TMDB answers used while TMDB is failing. (Only local fakes: nothing here goes to the internet.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { Readable, PassThrough } = require('stream');
const { parseXMLTV } = require('../lib/xmltv');
const { Epg, jsonPieces } = require('../lib/epg');
const { JsonFile } = require('../lib/store');
const { Tmdb } = require('../lib/tmdb');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = 3600e3;
const ts = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
const progXml = (n, ch = 'a') => Array.from({ length: n }, (_, i) => `<programme start="${ts(i * H)}" stop="${ts((i + 1) * H)}" channel="${ch}"><title>P${i}</title></programme>`).join('');
const doc = (n) => `<?xml version="1.0"?><tv><channel id="a"><display-name>A</display-name></channel>${progXml(n)}</tv>`;

test('gzip is recognised even when the first chunk is a single byte', async () => {
  const gz = zlib.gzipSync(doc(3));
  const r = await parseXMLTV(Readable.from([gz.subarray(0, 1), gz.subarray(1, 2), gz.subarray(2)]));
  assert.strictEqual(r.programmeCount, 3);
  // A plain guide whose first chunk is one byte, and a whole download of one byte, still work as before.
  const plain = Buffer.from(doc(2));
  assert.strictEqual((await parseXMLTV(Readable.from([plain.subarray(0, 1), plain.subarray(1)]))).programmeCount, 2);
  await assert.rejects(parseXMLTV(Readable.from([Buffer.from('x')])), /valid XMLTV/);
});

test('a broken gzip download is closed, not left open at the provider', async () => {
  let closed = false;
  const srv = http.createServer((req, res) => {
    res.on('close', () => { closed = true; });
    res.writeHead(200, { 'Content-Type': 'application/gzip' });
    res.write(Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.alloc(4000, 0xff)])); // gzip magic, then junk
    // ...and the response never ends: only the client closing it frees the connection.
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/guide.xml.gz`);
    await assert.rejects(parseXMLTV(Readable.fromWeb(res.body)));
    for (let i = 0; i < 40 && !closed; i++) await sleep(25);
    assert.ok(closed, 'the provider connection was closed');
  } finally { srv.closeAllConnections(); srv.close(); }
  // (The same with a plain stream: the source is destroyed.)
  const src = new PassThrough();
  const job = parseXMLTV(src);
  src.write(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  await assert.rejects(job);
  assert.ok(src.destroyed);
});

test('a plain guide cut short doesn’t replace a much bigger one; a whole one always does', async () => {
  const dir = tmp('epgtrunc-');
  const e = new Epg(dir);
  e.setSource('g', await parseXMLTV(Readable.from([doc(20)])));
  const cut = await parseXMLTV(Readable.from([doc(20).slice(0, doc(20).indexOf('<programme start="' + ts(5 * H)))]));
  assert.strictEqual(cut.truncated, true);
  assert.strictEqual(cut.programmeCount, 5);
  // (Handed on as lib/lists.js does: channels and programmes only.)
  assert.throws(() => e.setSource('g', { channels: cut.channels, programmes: cut.programmes }), /stopped part way/);
  assert.strictEqual(e.range('a', 0, 100 * H).length, 20, 'the last good guide stays');
  // Also after a restart (the size is known from the file).
  const e2 = new Epg(dir);
  assert.throws(() => e2.setSource('g', { channels: cut.channels, programmes: cut.programmes }), /stopped part way/);
  // Cut short but not much smaller: taken.
  const most = await parseXMLTV(Readable.from([doc(20).slice(0, doc(20).indexOf('<programme start="' + ts(15 * H)))]));
  e2.setSource('g', { channels: most.channels, programmes: most.programmes });
  assert.strictEqual(e2.range('a', 0, 100 * H).length, 15);
  // A whole document is always taken, however small.
  const small = await parseXMLTV(Readable.from([doc(2)]));
  assert.strictEqual(small.truncated, false);
  e2.setSource('g', { channels: small.channels, programmes: small.programmes });
  assert.strictEqual(e2.range('a', 0, 100 * H).length, 2);
  // A new guide (nothing before it) cut short is taken too.
  e2.setSource('new', { channels: cut.channels, programmes: cut.programmes });
  assert.strictEqual(e2.sources.get('new').count, 5);
});

test('a guide is saved a piece at a time, in the same format as before', async () => {
  const progs = {};
  for (let i = 0; i < 3000; i++) progs['c' + i] = [{ s: i, e: i + 1, t: 'Title "quoted" ' + 'x'.repeat(500), u: undefined }];
  const data = { channels: { c1: { names: ['One', 'Ünï'], icon: '' }, skip: undefined }, programmes: progs };
  const pieces = [...jsonPieces(data)];
  assert.ok(pieces.length > 1, 'more than one piece');
  assert.strictEqual(pieces.join(''), JSON.stringify(data));
  assert.strictEqual([...jsonPieces({ channels: {}, programmes: {} })].join(''), JSON.stringify({ channels: {}, programmes: {} }));
  delete data.channels.skip;
  const dir = tmp('epgpieces-');
  const e = new Epg(dir);
  e.setSource('bg', data, { soon: true });
  e.setSource('now', data);
  await e._writes.get('bg');
  clearTimeout(e._soonT);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'bg.json'), 'utf8'), JSON.stringify(data));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'now.json'), 'utf8'), JSON.stringify(data));
  const back = new Epg(dir);
  assert.strictEqual(back.range('c42', 0, 100).length, 1);
});

function fakeTmdb(handler) {
  const srv = http.createServer((req, res) => handler(req, res));
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, base: `http://127.0.0.1:${srv.address().port}/3` })));
}
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

test('TMDB: an automatic match whose entry is gone (404) is dropped; a household pick stays', async () => {
  const f = await fakeTmdb((req, res) => {
    if (req.url.startsWith('/3/search/movie')) return json(res, 200, { results: [{ id: 111 }] });
    json(res, 404, { status_code: 34 });
  });
  try {
    const t = new Tmdb({ dataDir: tmp('tmdb404-'), getKey: () => 'k', base: f.base });
    assert.strictEqual(await t.details({ k: 'a', t: 'movie', n: 'Gone film' }), null);
    assert.strictEqual(t.map.data.m.a, undefined, 'looked up again next time');
    t.map.data.m.b = { id: 222, type: 'movie', manual: 1 };
    assert.strictEqual(await t.details({ k: 'b', t: 'movie', n: 'Picked film' }), null);
    assert.deepStrictEqual(t.map.data.m.b, { id: 222, type: 'movie', manual: 1 });
    JsonFile.flushAll();
  } finally { f.srv.close(); }
});

test('TMDB: while TMDB is failing, the older cached answer is used rather than nothing', async () => {
  let down = false;
  const f = await fakeTmdb((req, res) => {
    if (down) return json(res, 503, {});
    if (req.url.startsWith('/3/trending')) return json(res, 200, { results: [{ id: 5 }] });
    json(res, 200, { id: 7, title: 'Seven', overview: 'Plot' });
  });
  try {
    const t = new Tmdb({ dataDir: tmp('tmdbstale-'), getKey: () => 'k', base: f.base });
    assert.deepStrictEqual(await t.get('/trending/all/week', {}), { results: [{ id: 5 }] });
    await sleep(50); // (the cache file is written in the background)
    down = true;
    assert.deepStrictEqual(await t.get('/trending/all/week', {}, 0), { results: [{ id: 5 }] }, 'the older answer');
    await assert.rejects(t.get('/trending/tv/week', {}, 0), /503/, 'nothing cached: the error as before');
    // Details past their time: what's kept stays as it is.
    down = false;
    t.map.data.m.s = { id: 7, type: 'movie' };
    const first = await t.details({ k: 's', t: 'movie', n: 'Seven' });
    await sleep(50);
    first.at = Date.now() - 40 * 86400e3;
    down = true;
    t.pauseUntil = 0;
    const again = await t.details({ k: 's', t: 'movie', n: 'Seven' });
    assert.strictEqual(again && again.title, 'Seven');
    assert.strictEqual(t.map.data.m.s.id, 7, 'a failing TMDB doesn’t drop the match');
    JsonFile.flushAll();
  } finally { f.srv.close(); }
});
