'use strict';
// Stream relay, watch-party sharing, outgoing requests and Stalker portals: fixes for leaks, hangs and login storms.
// Everything runs against local pretend servers (no network).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');
const { Proxy } = require('../lib/proxy');
const { Fanout } = require('../lib/fanout');
const { Stalker } = require('../lib/stalker');
const { fetchAny } = require('../lib/net');

const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${srv.address().port}`)));
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** Rejects if `p` hasn't settled after `ms` (so a hang shows up as a failure, not a stuck test). */
const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: still waiting after ${ms} ms`)), ms))]);

// ------------------------------------------------------------------ outgoing requests (lib/net.js)
test('net: a POST through an outgoing proxy sends its body', async () => {
  let got = null;
  const prx = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => { got = { url: req.url, method: req.method, body: Buffer.concat(parts).toString() }; res.writeHead(200); res.end('{}'); });
  });
  const base = await listen(prx);
  try {
    const r = await fetchAny('http://media.invalid/Users/AuthenticateByName', { method: 'POST', body: '{"Username":"a"}', headers: { 'Content-Type': 'application/json' }, proxy: base });
    await r.text();
    assert.strictEqual(got.method, 'POST');
    assert.strictEqual(got.body, '{"Username":"a"}');
  } finally { prx.close(); }
});

test('net: a gzip answer cut off half-way fails instead of hanging', async () => {
  const gz = zlib.gzipSync(require('crypto').randomBytes(200000)); // (doesn't compress, so it really is cut off)
  const prx = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
    res.write(gz.subarray(0, 1000));
    setTimeout(() => res.socket.destroy(), 50);
  });
  const base = await listen(prx);
  try {
    const r = await fetchAny('http://cut.invalid/x', { proxy: base });
    await within(assert.rejects(r.text()), 3000, 'reading the cut-off answer');
  } finally { prx.close(); prx.closeAllConnections(); }
});

// ------------------------------------------------------------------ stream relay (lib/proxy.js)
function relayApp(proxy) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    proxy.handle(req, res, u.searchParams).catch((e) => { if (!res.headersSent) { res.writeHead(e.status || 500); res.end(String(e.message)); } });
  });
  return listen(srv).then((base) => ({ srv, base }));
}

test('relay: an endless stream at a .m3u8 address is passed on, not buffered whole', async () => {
  let open = 0, timer;
  const prov = http.createServer((req, res) => {
    open++;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    const pkt = Buffer.alloc(188 * 50, 0x47);
    timer = setInterval(() => res.write(pkt), 20);
    res.on('close', () => { open--; clearInterval(timer); });
  });
  const pbase = await listen(prov);
  const proxy = new Proxy(() => ({ userAgent: 'test' }));
  const app = await relayApp(proxy);
  try {
    const ac = new AbortController();
    const r = await within(fetch(app.base + proxy.sign(pbase + '/live/1.m3u8'), { signal: ac.signal }), 3000, 'first bytes');
    assert.strictEqual(r.status, 200);
    const reader = r.body.getReader();
    const { value } = await within(reader.read(), 3000, 'first chunk');
    assert.strictEqual(value[0], 0x47);
    ac.abort();
    await wait(300);
    assert.strictEqual(open, 0, 'the provider connection closes when the viewer leaves');
  } finally { clearInterval(timer); app.srv.close(); prov.close(); prov.closeAllConnections(); app.srv.closeAllConnections(); }
});

test('relay: a real playlist at a .m3u8 address is still rewritten', async () => {
  const prov = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.bin"\n#EXTINF:6,\nseg1.ts?a=1\n'); });
  const pbase = await listen(prov);
  const proxy = new Proxy(() => ({ userAgent: 'test' }));
  const app = await relayApp(proxy);
  try {
    const r = await fetch(app.base + proxy.sign(pbase + '/a/b.m3u8'));
    const text = await r.text();
    assert.match(r.headers.get('content-type'), /mpegurl/);
    const lines = text.split('\n');
    const seg = lines.find((l) => l.startsWith('/api/proxy'));
    const key = /URI="([^"]+)"/.exec(text)[1];
    const q = (s) => new URL(s, 'http://x').searchParams;
    assert.strictEqual(proxy.verify(q(seg).get('d'), q(seg).get('s')).u, pbase + '/a/seg1.ts?a=1');
    assert.strictEqual(proxy.verify(q(key).get('d'), q(key).get('s')).u, pbase + '/a/k.bin');
  } finally { app.srv.close(); prov.close(); }
});

test('relay: a provider that never answers gives up (504) rather than waiting minutes', async () => {
  const prov = http.createServer(() => {});
  const pbase = await listen(prov);
  const proxy = new Proxy(() => ({ userAgent: 'test' }));
  proxy.firstByteMs = 300;
  const app = await relayApp(proxy);
  try {
    const r = await within(fetch(app.base + proxy.sign(pbase + '/chan.ts')), 3000, 'answer');
    assert.strictEqual(r.status, 504);
  } finally { app.srv.close(); prov.close(); prov.closeAllConnections(); }
});

// ------------------------------------------------------------------ watch-party sharing (lib/fanout.js)
function fanApp(fan) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    fan.handle(req, res, u.searchParams).catch((e) => { if (!res.headersSent) { res.writeHead(e.status || 500); res.end(String(e.message)); } });
  });
  return listen(srv).then((base) => ({ srv, base }));
}

test('fanout: a segment the provider never sends fails for everyone, and the next try asks again', async () => {
  let hits = 0;
  const prov = http.createServer(() => { hits++; });
  const pbase = await listen(prov);
  const fan = new Fanout({ fetch, timeout: 300 });
  const app = await fanApp(fan);
  try {
    const url = app.base + fan.sign({ p: 'p1', k: 'c', u: pbase + '/hang.ts', m: 'seg' });
    const rs = await within(Promise.all([fetch(url), fetch(url)]), 3000, 'members');
    assert.ok(rs.every((r) => r.status >= 500), 'both members get an error');
    assert.strictEqual(hits, 1, 'one provider request for both');
    await within(fetch(url), 3000, 'retry');
    assert.strictEqual(hits, 2, 'a failed segment isn’t remembered');
  } finally { app.srv.close(); prov.close(); prov.closeAllConnections(); }
});

test('fanout: seeking past the end of a shared file answers 416 without asking the provider', async () => {
  const file = Buffer.alloc(1000, 7);
  let hits = 0;
  const prov = http.createServer((req, res) => {
    hits++;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const a = m ? +m[1] : 0;
    if (a >= file.length) { res.writeHead(416, { 'Content-Range': `bytes */${file.length}` }); return res.end(); }
    const b = m && m[2] ? Math.min(+m[2], file.length - 1) : file.length - 1;
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${a}-${b}/${file.length}` });
    res.end(file.subarray(a, b + 1));
  });
  const pbase = await listen(prov);
  const fan = new Fanout({ fetch });
  const app = await fanApp(fan);
  try {
    const url = app.base + fan.sign({ p: 'p1', k: 'f', u: pbase + '/film.mp4', m: 'file' });
    const first = await fetch(url, { headers: { Range: 'bytes=0-' } });
    assert.strictEqual(first.status, 206);
    await first.arrayBuffer();
    const n = hits;
    const r = await fetch(url, { headers: { Range: 'bytes=5000000-' } }); // (a later piece than the one already fetched)
    assert.strictEqual(r.status, 416);
    assert.strictEqual(r.headers.get('content-range'), 'bytes */1000');
    assert.strictEqual(hits, n);
  } finally { app.srv.close(); prov.close(); }
});

// ------------------------------------------------------------------ Stalker portals (lib/stalker.js)
/** A pretend portal: every handshake gives a new token and makes the older ones invalid (as many real ones do). */
async function portal() {
  const st = { handshakes: 0, token: '', calls: 0, refused: 0 };
  const srv = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ js: o })); };
    if (q.get('action') === 'handshake') { st.handshakes++; st.token = 'T' + st.handshakes; return setTimeout(() => send({ token: st.token }), 30); }
    const tok = (req.headers.authorization || '').replace('Bearer ', '');
    if (tok !== st.token) { st.refused++; res.writeHead(401); return res.end('Authorization failed.'); }
    if (q.get('action') === 'get_profile') return send({ id: 1 });
    st.calls++;
    setTimeout(() => send({ data: [{ id: q.get('p') }] }), 20);
  });
  const base = await listen(srv);
  return { srv, st, base };
}

test('stalker: an expired token makes one new handshake, not one per request in flight', async () => {
  const p = await portal();
  const s = new Stalker();
  const l = { id: 's1', portal: p.base + '/c/', mac: '00:1A:79:00:00:01' };
  try {
    await s.call(l, { type: 'vod', action: 'get_ordered_list', p: '0' });
    assert.strictEqual(p.st.handshakes, 1);
    p.st.token = 'expired';
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => s.call(l, { type: 'vod', action: 'get_ordered_list', p: String(i) })));
    assert.deepStrictEqual(rs.map((r) => r.data[0].id), ['1', '2', '3', '4', '5', '6']);
    assert.strictEqual(p.st.handshakes, 2, 'one new handshake');
  } finally { p.srv.close(); }
});

for (const profileOk of [false, true]) {
  test(`stalker: a portal that refuses every page (sign-in ${profileOk ? 'accepted' : 'refused'}) doesn't get a handshake per page`, async () => {
    const st = { handshakes: 0 };
    const srv = http.createServer((req, res) => {
      const q = new URL(req.url, 'http://x').searchParams;
      const send = (o) => { res.writeHead(200); res.end(JSON.stringify({ js: o })); };
      if (q.get('action') === 'handshake') { st.handshakes++; return send({ token: 'T' + st.handshakes }); }
      if (q.get('action') === 'get_profile' && profileOk) return send({ id: 1 });
      if (q.get('p') === '1') return send({ data: [{ id: 'a' }], total_items: 14 * 200, max_page_items: 14 });
      res.writeHead(401); res.end('Authorization failed.');
    });
    const base = await listen(srv);
    const s = new Stalker();
    const l = { id: 's2', portal: base + '/c/', mac: '00:1A:79:00:00:02' };
    s.sessions.set(l.id, { api: base + '/portal.php', token: 'old', referer: '', at: Date.now() });
    s._pageBudget = 1000;
    try {
      const got = await s._pages(l, 'vod', '1');
      assert.strictEqual(got.length, 1);
      assert.ok(st.handshakes <= 2, `handshakes: ${st.handshakes} for 199 refused pages`);
    } finally { srv.close(); }
  });
}
