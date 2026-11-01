// Watch-party streaming (one provider connection for the whole party) and connection counting with multiview tiles.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Fanout, CHUNK } = require('../lib/fanout');
const { listUsage } = require('../lib/usage');

const TS = 188;
/** A TS packet: PID, payload byte; PAT (PID 0) names a PMT on PID 0x1000. */
function pkt(pid, fill) { const b = Buffer.alloc(TS, fill || 0xff); b[0] = 0x47; b[1] = 0x40 | ((pid >> 8) & 0x1f); b[2] = pid & 0xff; b[3] = 0x10; return b; }
function pat() {
  const b = pkt(0, 0xff);
  b[4] = 0; // pointer field
  b.set([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xf0, 0x00], 5); // table 0, 1 programme → PMT PID 0x1000
  return b;
}

/** A pretend provider: HLS playlist + segments, an endless TS channel, an MP4 file. Counts requests. */
function provider() {
  const hits = { pl: 0, seg: 0, ts: 0, file: 0 };
  let tsRes = [];
  const file = Buffer.alloc(5 * 1024 * 1024 + 123);
  for (let i = 0; i < file.length; i++) file[i] = i % 251;
  const srv = http.createServer((req, res) => {
    if (req.url === '/live.m3u8') { hits.pl++; res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:6,\nseg1.ts\n#EXTINF:6,\nseg2.ts\n'); }
    if (/^\/seg\d\.ts$/.test(req.url)) { hits.seg++; setTimeout(() => { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); res.end(Buffer.alloc(TS * 50, 0x47)); }, 80); return; }
    if (req.url === '/chan') { hits.ts++; res.writeHead(200, { 'Content-Type': 'video/mp2t' }); tsRes.push(res); req.on('close', () => { tsRes = tsRes.filter((r) => r !== res); }); return; }
    if (req.url === '/film.mp4') {
      hits.file++;
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      const a = m ? +m[1] : 0, b = m && m[2] ? Math.min(+m[2], file.length - 1) : file.length - 1;
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${a}-${b}/${file.length}`, 'Content-Length': b - a + 1 });
      return res.end(file.subarray(a, b + 1));
    }
    res.writeHead(404); res.end();
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, hits, file, base: `http://127.0.0.1:${srv.address().port}`, send: (b) => tsRes.forEach((r) => r.write(b)) })));
}

/** The app side: /api/fan → Fanout.handle. */
function app(fan) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    fan.handle(req, res, u.searchParams).catch((e) => { res.writeHead(e.status || 500); res.end(String(e.message)); });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}
const get = (url, headers) => fetch(url, { headers }).then(async (r) => ({ status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) }));

test('HLS: three members, one provider request per playlist refresh and per segment', async () => {
  const p = await provider();
  const fan = new Fanout({ fetch });
  const a = await app(fan);
  try {
    const root = a.base + fan.sign({ p: 'party1', k: 'ch', u: p.base + '/live.m3u8', m: 'pl' });
    const lists = await Promise.all([1, 2, 3].map(() => get(root)));
    assert.strictEqual(p.hits.pl, 1, 'one playlist request for three members');
    const text = lists[0].body.toString();
    assert.ok(!text.includes(p.base), 'every address points back at the server');
    const segs = text.split('\n').filter((l) => l.startsWith('/api/fan'));
    assert.strictEqual(segs.length, 2);
    // Everyone asks for both segments at about the same moment.
    const got = await Promise.all([1, 2, 3].flatMap(() => segs.map((s) => get(a.base + s))));
    assert.ok(got.every((g) => g.status === 200 && g.body.length === TS * 50));
    assert.strictEqual(p.hits.seg, 2, 'one request per segment');
    // A byte range of a cached segment comes from the copy already here.
    const part = await get(a.base + segs[0], { Range: 'bytes=0-187' });
    assert.strictEqual(part.status, 206);
    assert.strictEqual(part.body.length, TS);
    assert.strictEqual(p.hits.seg, 2);
    assert.ok(fan.active('party1'));
    assert.ok(!fan.active('party2'));
  } finally { a.srv.close(); p.srv.close(); a.srv.closeAllConnections(); p.srv.closeAllConnections(); }
});

test('MPEG-TS: one upstream connection broadcast; late joiners start on a packet with the tables first; slow members dropped', async () => {
  const p = await provider();
  const fan = new Fanout({ fetch, slowBytes: 512 * 1024 });
  const a = await app(fan);
  const url = a.base + fan.sign({ p: 'party1', k: 'ch', u: p.base + '/chan', m: 'ts' });
  const readers = [];
  const open = () => new Promise((ok) => {
    const r = { bytes: Buffer.alloc(0) };
    r.req = http.get(url, (res) => { r.res = res; res.on('data', (d) => { r.bytes = Buffer.concat([r.bytes, d]); }); ok(r); });
    readers.push(r);
  });
  try {
    const m1 = await open();
    const m2 = await open();
    await new Promise((r) => setTimeout(r, 100));
    p.send(Buffer.concat([pat(), pkt(0x1000, 0x02), pkt(0x100, 0x11), pkt(0x100, 0x12)]));
    // Half a packet: held back until the rest arrives.
    const p3 = pkt(0x100, 0x13);
    p.send(p3.subarray(0, 100));
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(m1.bytes.length, TS * 4);
    assert.strictEqual(m2.bytes.length, TS * 4);
    // Someone joins late: the PAT and PMT first, then whatever comes next — always whole packets.
    const m3 = await open();
    await new Promise((r) => setTimeout(r, 100));
    p.send(Buffer.concat([p3.subarray(100), pkt(0x100, 0x14)]));
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(p.hits.ts, 1, 'one connection to the provider');
    assert.strictEqual(m3.bytes.length % TS, 0);
    assert.strictEqual(m3.bytes[0], 0x47);
    assert.strictEqual(((m3.bytes[1] & 0x1f) << 8) | m3.bytes[2], 0, 'PAT first');
    assert.strictEqual(((m3.bytes[TS + 1] & 0x1f) << 8) | m3.bytes[TS + 2], 0x1000, 'then the PMT');
    assert.strictEqual(m3.bytes.length, TS * 4);
    assert.strictEqual(m1.bytes.length, TS * 6);
    // A member who stops reading is dropped once too much is waiting for them; the others carry on.
    m2.res.pause();
    const big = Buffer.concat(Array.from({ length: 1000 }, () => pkt(0x100, 0x20)));
    for (let i = 0; i < 60; i++) { p.send(big); await new Promise((r) => setTimeout(r, 5)); }
    await new Promise((r) => setTimeout(r, 300));
    const b = fan.ts.values().next().value;
    assert.ok(b && b.clients.size === 2, `the slow member was dropped (${b && b.clients.size} left)`);
    assert.ok(m1.bytes.length > TS * 50000, 'the others kept getting it');
  } finally {
    for (const b of [...fan.ts.values()]) fan._close(b);
    readers.forEach((r) => r.req.destroy());
    a.srv.close(); p.srv.close(); a.srv.closeAllConnections(); p.srv.closeAllConnections();
  }
});

test('Files: shared 2 MB pieces, one request to the provider at a time', async () => {
  const p = await provider();
  let inFlight = 0, most = 0;
  const counting = (u, o) => { inFlight++; most = Math.max(most, inFlight); return fetch(u, o).then((r) => { const done = () => { inFlight--; }; return r.arrayBuffer().then((ab) => { done(); return new Response(ab, { status: r.status, headers: r.headers }); }); }); };
  const fan = new Fanout({ fetch: counting });
  const a = await app(fan);
  try {
    const url = a.base + fan.sign({ p: 'party1', k: 'film', u: p.base + '/film.mp4', m: 'file' });
    // Two members ask for the start at the same time, then the same later piece.
    const [x, y] = await Promise.all([get(url, { Range: 'bytes=0-' }), get(url, { Range: 'bytes=0-' })]);
    assert.strictEqual(x.status, 206);
    assert.strictEqual(x.body.length, CHUNK);
    assert.ok(x.body.equals(p.file.subarray(0, CHUNK)) && y.body.equals(x.body));
    assert.match(x.headers.get('content-range'), new RegExp(`^bytes 0-${CHUNK - 1}/${p.file.length}$`));
    const at = CHUNK * 2 + 1000;
    const [z1, z2] = await Promise.all([get(url, { Range: `bytes=${at}-` }), get(url, { Range: `bytes=${at}-` })]);
    assert.ok(z1.body.equals(p.file.subarray(at, CHUNK * 3)) && z2.body.equals(z1.body));
    // The last piece and a suffix range.
    const end = await get(url, { Range: 'bytes=-50' });
    assert.ok(end.body.equals(p.file.subarray(p.file.length - 50)));
    assert.ok(p.hits.file <= 4, `pieces fetched once each (${p.hits.file})`);
    assert.strictEqual(most, 1, 'never more than one request to the provider at once');
  } finally { a.srv.close(); p.srv.close(); a.srv.closeAllConnections(); p.srv.closeAllConnections(); }
});

test('signed links only', async () => {
  const fan = new Fanout({ fetch });
  const good = new URL('http://x' + fan.sign({ p: 'a', u: 'http://example.com/x', m: 'seg' })).searchParams;
  assert.strictEqual(fan.verify(good.get('d'), good.get('s')).u, 'http://example.com/x');
  assert.throws(() => fan.verify(good.get('d'), 'x'.repeat(32)), /Invalid/);
});

test('connection counting: multiview tiles each count; a sharing party counts once', () => {
  const listOf = (k) => ({ a: 'L1', b: 'L1', c: 'L2' }[k] || '');
  const conns = [
    { id: 'c1', pid: 'alex', deviceName: 'PC', playing: null, multi: [{ k: 'a', n: 'A' }, { k: 'b', n: 'B' }, { k: 'c', n: 'C' }] },
    { id: 'c2', pid: 'sam', deviceName: 'TV', playing: { k: 'a', n: 'A' } },
    { id: 'c3', pid: 'jo', deviceName: 'Phone', playing: { k: 'a', n: 'A' } },
    { id: 'c4', pid: 'kid', deviceName: 'Tablet', playing: { k: 'c', n: 'C' } },
  ];
  let u = listUsage(conns, { listOf });
  assert.strictEqual(u.get('L1').length, 4);
  assert.strictEqual(u.get('L2').length, 2);
  assert.ok(u.get('L1')[0].tile && u.get('L1')[0].id === 'c1' && u.get('L1')[0].playing.n === 'A');
  // Sam and Jo are in a party sharing one connection.
  u = listUsage(conns, { listOf, sharedPartyOf: (c) => (c.pid === 'sam' || c.pid === 'jo' ? 'p1' : null) });
  assert.strictEqual(u.get('L1').length, 3);
  assert.deepStrictEqual(u.get('L1').map((x) => x.id), ['c1', 'c1', 'c2']);
});
