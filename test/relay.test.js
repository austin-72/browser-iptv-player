// The stream relay (relay/relay.js) and the server's side of it (lib/streamrelay.js): sealed addresses, HLS playlists
// rewritten so everything comes through the relay, headers the provider needs, ranges, CORS, refusals, the optional
// proxy for the server's own traffic, and the real server handing out relay addresses.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const { relayUrl, testRelay } = require('../lib/streamrelay');

const SECRET = 'test-secret-0123456789abcdef';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const FILM = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));

/** A pretend provider: HLS that needs a User-Agent, a key, segments, a film with ranges, a playlist without a name, a redirect. */
function provider() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, ua: req.headers['user-agent'], ref: req.headers.referer });
    const base = `http://127.0.0.1:${srv.address().port}`;
    if (req.url.startsWith('/live/') && req.headers['user-agent'] !== 'TestUA/1') { res.writeHead(403); return res.end('wrong app'); }
    if (req.url === '/live/joe/s3cret/master.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nv1/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\n${base}/live/joe/s3cret/v2/index.m3u8\n`); }
    if (/^\/live\/joe\/s3cret\/v[12]\/index\.m3u8$/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'application/x-mpegURL' }); return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nseg1.ts\n#EXTINF:4,\n/live/joe/s3cret/seg2.ts?token=abc\n'); }
    if (/\/seg[12]\.ts/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end(Buffer.from('TS-' + req.url)); }
    if (req.url.endsWith('/key.bin')) { res.writeHead(200); return res.end(Buffer.alloc(16, 7)); }
    if (req.url === '/movie/joe/s3cret/film.mp4') {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (m) { const a = +m[1], b = m[2] ? +m[2] : FILM.length - 1; res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${a}-${b}/${FILM.length}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' }); return res.end(FILM.subarray(a, b + 1)); }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': FILM.length, 'Accept-Ranges': 'bytes' }); return res.end(FILM);
    }
    if (req.url === '/redir') { res.writeHead(302, { Location: '/movie/joe/s3cret/film.mp4' }); return res.end(); }
    if (req.url === '/noname') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('#EXTM3U\n#EXTINF:4,\npart1.ts\n'); }
    if (req.url === '/list.m3u') { res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); return res.end(`#EXTM3U\n#EXTINF:-1 tvg-id="r1" group-title="News",Relay News\n#EXTVLCOPT:http-user-agent=TestUA/1\n${base}/live/joe/s3cret/master.m3u8\n#EXTINF:-1 group-title="Films" tvg-type="movie",Relay Film (2020)\n${base}/movie/joe/s3cret/film.mp4\n`); }
    res.writeHead(404); res.end();
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, seen, base: `http://127.0.0.1:${srv.address().port}` })));
}
async function startRelay(env, script) {
  const port = await freePort();
  const p = spawn(process.execPath, [script || path.join(__dirname, '..', 'relay', 'relay.js')], { env: { ...process.env, RELAY_SECRET: SECRET, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 50 && !/Stream relay/.test(out); i++) await wait(50);
  assert.match(out, /Stream relay/, out);
  return { p, base: `http://127.0.0.1:${port}`, out: () => out };
}
/** What a sealed relay address carries (the test knows the secret). */
function unseal(url, secret) {
  const tok = /\/e\/([A-Za-z0-9_-]+)/.exec(url)[1];
  const b = Buffer.from(tok, 'base64url');
  const d = require('crypto').createDecipheriv('aes-256-gcm', require('crypto').createHash('sha256').update('relay-key:' + secret).digest(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(b.length - 16));
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8'));
}
/** A copy of relay.js in a folder of its own (for the tests that let it replace its own file). */
function relayCopy() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-copy-'));
  const f = path.join(d, 'relay.js');
  fs.copyFileSync(path.join(__dirname, '..', 'relay', 'relay.js'), f);
  return f;
}
const relayLinks = (text) => text.split('\n').filter((l) => l && !l.startsWith('#'));

test('the relay: sealed addresses, rewritten playlists, headers, ranges, CORS and refusals', { timeout: 30000 }, async () => {
  const pv = await provider();
  const r = await startRelay({ RELAY_ALLOW_PRIVATE: '1' });
  const strict = await startRelay({});
  try {
    const h = { 'User-Agent': 'TestUA/1' };
    // The master playlist: every address in it comes back through the relay, and none shows the provider's login.
    const u = relayUrl(r.base, SECRET, `${pv.base}/live/joe/s3cret/master.m3u8`, h);
    assert.ok(u.startsWith(`${r.base}/e/`) && u.endsWith('/master.m3u8'), u);
    assert.ok(!u.includes('s3cret') && !u.includes('joe'), 'the address is sealed');
    let res = await fetch(u);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('content-type'), /mpegurl/);
    const master = await res.text();
    const vars = relayLinks(master);
    assert.strictEqual(vars.length, 2);
    for (const v of vars) assert.ok(v.startsWith('/e/') && !v.includes('s3cret'), v);
    // A variant: its key and both segments (relative and absolute-path) through the relay too.
    const variant = await (await fetch(r.base + vars[0])).text();
    const key = /URI="([^"]+)"/.exec(variant)[1];
    assert.ok(key.startsWith('/e/'));
    assert.deepStrictEqual([...Buffer.from(await (await fetch(r.base + key)).arrayBuffer())], [...Buffer.alloc(16, 7)]);
    const segs = relayLinks(variant);
    assert.strictEqual(await (await fetch(r.base + segs[0])).text(), 'TS-/live/joe/s3cret/v1/seg1.ts');
    assert.strictEqual(await (await fetch(r.base + segs[1])).text(), 'TS-/live/joe/s3cret/seg2.ts?token=abc');
    assert.ok(pv.seen.filter((x) => x.url.startsWith('/live/')).every((x) => x.ua === 'TestUA/1'), 'the provider gets the headers it needs');
    // Without the headers the provider says no — and that answer is passed on.
    assert.strictEqual((await fetch(relayUrl(r.base, SECRET, `${pv.base}/live/joe/s3cret/master.m3u8`))).status, 403);
    // A film: whole, a range, after a redirect; HEAD; a preflight.
    const f = relayUrl(r.base, SECRET, `${pv.base}/movie/joe/s3cret/film.mp4`);
    assert.deepStrictEqual(Buffer.from(await (await fetch(f)).arrayBuffer()), FILM);
    res = await fetch(f, { headers: { Range: 'bytes=100-199' } });
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get('content-range'), `bytes 100-199/${FILM.length}`);
    assert.deepStrictEqual(Buffer.from(await res.arrayBuffer()), FILM.subarray(100, 200));
    assert.deepStrictEqual(Buffer.from(await (await fetch(relayUrl(r.base, SECRET, `${pv.base}/redir`))).arrayBuffer()), FILM);
    res = await fetch(f, { method: 'HEAD' });
    assert.strictEqual(res.headers.get('content-length'), String(FILM.length));
    res = await fetch(f, { method: 'OPTIONS' });
    assert.strictEqual(res.status, 204);
    // A playlist with no name and a plain-text type is still recognised (by its first bytes) and rewritten.
    const nn = await (await fetch(relayUrl(r.base, SECRET, `${pv.base}/noname`))).text();
    assert.ok(relayLinks(nn)[0].startsWith('/e/'), nn);
    // Refusals: a changed or expired address, another secret, an address on the relay's own network.
    const bad = u.replace(/\/e\/(.)/, (m, c) => `/e/${c === 'A' ? 'B' : 'A'}`);
    assert.strictEqual((await fetch(bad)).status, 403);
    assert.strictEqual((await fetch(relayUrl(r.base, SECRET, `${pv.base}/movie/joe/s3cret/film.mp4`, {}, -5))).status, 403);
    assert.strictEqual((await fetch(relayUrl(r.base, 'another-secret-0123456789', `${pv.base}/movie/joe/s3cret/film.mp4`))).status, 403);
    assert.strictEqual((await fetch(relayUrl(strict.base, SECRET, `${pv.base}/movie/joe/s3cret/film.mp4`))).status, 403, 'private addresses are refused unless allowed');
    assert.strictEqual((await fetch(r.base + '/e/nonsense/x.ts')).status, 403);
    // The server's test of the relay.
    assert.strictEqual((await testRelay(r.base, SECRET, fetch)).ok, true);
    assert.match((await testRelay(r.base, 'another-secret-0123456789', fetch)).error, /secret is different/);
    assert.match((await testRelay('http://127.0.0.1:1', SECRET, fetch)).error, /Couldn’t reach/);
  } finally { r.p.kill(); strict.p.kill(); pv.srv.close(); }
});

test('the relay as a proxy for the server’s own traffic (sign-in, plain requests and CONNECT)', { timeout: 20000 }, async () => {
  const pv = await provider();
  const pport = await freePort();
  const r = await startRelay({ RELAY_ALLOW_PRIVATE: '1', PROXY_PORT: String(pport), PROXY_USER: 'me', PROXY_PASS: 'pw' });
  try {
    for (let i = 0; i < 40 && !/HTTP proxy/.test(r.out()); i++) await wait(50);
    const via = (auth) => new Promise((ok) => {
      const req = http.request({ host: '127.0.0.1', port: pport, method: 'GET', path: `${pv.base}/movie/joe/s3cret/film.mp4`, headers: auth ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(auth).toString('base64') } : {} }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => ok({ status: res.statusCode, body: Buffer.concat(c) })); });
      req.end();
    });
    assert.strictEqual((await via('')).status, 407);
    assert.strictEqual((await via('me:wrong')).status, 407);
    const ok = await via('me:pw');
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.body, FILM);
    // CONNECT: a tunnel to the provider.
    const tunnel = await new Promise((done) => {
      const req = http.request({ host: '127.0.0.1', port: pport, method: 'CONNECT', path: `127.0.0.1:${new URL(pv.base).port}`, headers: { 'Proxy-Authorization': 'Basic ' + Buffer.from('me:pw').toString('base64') } });
      req.on('connect', (res, sock) => {
        sock.write(`GET /key.bin HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        const c = []; sock.on('data', (d) => c.push(d)); sock.on('end', () => done({ status: res.statusCode, text: Buffer.concat(c).toString('latin1') }));
      });
      req.end();
    });
    assert.strictEqual(tunnel.status, 200);
    assert.match(tunnel.text, /^HTTP\/1\.1 200/);
  } finally { r.p.kill(); pv.srv.close(); }
});

test('the relay fetches films whole: one connection, instant seeking, finished films reported, unwatched ones stopped', { timeout: 60000 }, async () => {
  const crypto = require('crypto');
  const SIZE = 12 * 1024 * 1024 + 4321;
  const BIG = crypto.randomBytes(SIZE);
  let open = 0, most = 0;
  const asked = [];
  // A provider that sends about 8 MB/s, with or without ranges; a playlist marked as a film; a file of no known size.
  const srv = http.createServer((req, res) => {
    open++; most = Math.max(most, open); res.on('close', () => open--);
    asked.push(req.url + ' ' + (req.headers.range || ''));
    if (req.url === '/hls.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXTINF:4,\nseg.ts\n'); }
    if (req.url === '/nosize.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4' }); return res.end(BIG.subarray(0, 1000)); }
    const m = req.url === '/norange.mp4' ? null : /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const a = m ? +m[1] : 0, b = m && m[2] ? +m[2] : SIZE - 1;
    res.writeHead(m ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': b - a + 1, ...(m ? { 'Content-Range': `bytes ${a}-${b}/${SIZE}` } : {}) });
    let p = a;
    const step = () => { if (res.destroyed) return; if (p > b) return res.end(); const n = Math.min(128 * 1024, b - p + 1); res.write(BIG.subarray(p, p + n)); p += n; setTimeout(step, 15); };
    step();
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const pbase = `http://127.0.0.1:${srv.address().port}`;
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cache-'));
  const r = await startRelay({ RELAY_ALLOW_PRIVATE: '1', RELAY_CACHE_DIR: cache });
  const film = (p, i) => relayUrl(r.base, SECRET, pbase + p, {}, 3600, { w: 1, i });
  const bytes = async (u, range) => { const res = await fetch(u, range ? { headers: { Range: range } } : {}); return { status: res.status, cr: res.headers.get('content-range'), buf: Buffer.from(await res.arrayBuffer()) }; };
  const downloads = async (playing) => {
    const t = String(Math.floor(Date.now() / 1000));
    const q = playing === undefined ? '' : `playing=${encodeURIComponent(playing)}&`;
    const sig = crypto.createHmac('sha256', SECRET).update('downloads:' + (playing || '') + ':' + t).digest('base64url').slice(0, 32);
    return (await fetch(`${r.base}/downloads?${q}t=${t}&s=${sig}`)).json();
  };
  try {
    const u = film('/film.mp4', 'f1');
    // The start, then straight to the end (where MP4s keep their index): both right away and correct.
    let x = await bytes(u, 'bytes=0-65535');
    assert.strictEqual(x.status, 206);
    assert.strictEqual(x.cr, `bytes 0-65535/${SIZE}`);
    assert.ok(x.buf.equals(BIG.subarray(0, 65536)));
    const t0 = Date.now();
    x = await bytes(u, 'bytes=-30000');
    assert.ok(x.buf.equals(BIG.subarray(SIZE - 30000)), 'the end of the file');
    assert.ok(Date.now() - t0 < 1000, 'seeking ahead jumps the download there');
    // Still downloading; the server's view of it.
    let d = await downloads();
    assert.strictEqual(d.films.length, 1);
    assert.deepStrictEqual(d.films[0].ids, ['f1']);
    assert.strictEqual(d.films[0].done, false);
    // The whole film, read while it downloads: every byte right.
    x = await bytes(u);
    assert.strictEqual(x.status, 200);
    assert.ok(x.buf.equals(BIG));
    for (let i = 0; i < 50 && !(d = await downloads()).films[0].done; i++) await wait(100);
    assert.strictEqual(d.films[0].done, true);
    assert.strictEqual(d.films[0].downloading, false);
    assert.strictEqual(most, 1, 'never more than one provider connection');
    // Now it's all here: reading again, and from the middle, doesn't touch the provider.
    const n = asked.length;
    x = await bytes(u, 'bytes=5000000-5999999');
    assert.ok(x.buf.equals(BIG.subarray(5000000, 6000000)));
    assert.strictEqual(asked.length, n);
    // A HEAD request answers from what the relay knows.
    const h = await fetch(u, { method: 'HEAD' });
    assert.strictEqual(h.headers.get('content-length'), String(SIZE));
    assert.strictEqual(h.headers.get('accept-ranges'), 'bytes');
    // A provider without ranges: still fetched whole from the start, still plays.
    x = await bytes(film('/norange.mp4', 'f2'), 'bytes=0-999');
    assert.ok(x.buf.equals(BIG.subarray(0, 1000)));
    // Not something to keep whole (a playlist, or no size): relayed as it comes.
    assert.match((await bytes(film('/hls.m3u8', 'f3'))).buf.toString(), /#EXTM3U/);
    assert.ok((await bytes(film('/nosize.mp4', 'f4'))).buf.equals(BIG.subarray(0, 1000)));
    // The server says f2 isn't being played any more: its download stops (no reader left).
    await wait(200);
    d = await downloads('');
    await wait(300);
    d = await downloads('');
    const f2 = d.films.find((f) => f.ids.includes('f2'));
    assert.ok(f2 && !f2.downloading && !f2.done, JSON.stringify(d));
    // A wrong signature gets nothing.
    assert.strictEqual((await fetch(`${r.base}/downloads?t=1&s=x`)).status, 403);
  } finally { r.p.kill(); srv.close(); }
});

test('the relay: odd read sizes don’t fetch parts twice, two readers don’t fight over one film, zapping lets go at once', { timeout: 60000 }, async () => {
  const SIZE = 12 * 1048576;
  const data = Buffer.alloc(SIZE); for (let i = 0; i < SIZE; i++) data[i] = (i * 7 + (i >> 12)) & 255;
  let served = 0, conns = 0, open = 0;
  const prov = http.createServer((req, res) => {
    if (req.url.startsWith('/slow')) { open++; res.on('close', () => open--); setTimeout(() => { if (!res.destroyed) { res.writeHead(200, { 'content-type': 'video/mp2t' }); res.write(Buffer.alloc(1000)); } }, 800); return; }
    conns++;
    const m = /bytes=(\d+)-/.exec(req.headers.range || ''); const a = m ? +m[1] : 0;
    res.writeHead(m ? 206 : 200, { 'content-type': 'video/mp4', 'content-length': SIZE - a, ...(m ? { 'content-range': `bytes ${a}-${SIZE - 1}/${SIZE}` } : {}), 'accept-ranges': 'bytes' });
    let p = a;
    const step = () => { if (res.destroyed) return; if (p >= SIZE) return res.end(); const n = Math.min(100003, SIZE - p); served += n; const ok = res.write(data.subarray(p, p + n)); p += n; if (ok) setTimeout(step, 2); else res.once('drain', () => setTimeout(step, 2)); };
    step();
  });
  await new Promise((ok) => prov.listen(0, '127.0.0.1', ok));
  const P = prov.address().port;
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-odd-'));
  const relay = await startRelay({ RELAY_ALLOW_PRIVATE: '1', RELAY_CACHE_DIR: cache });
  const read = (u, range, limit) => new Promise((ok) => {
    http.get(u, { headers: range ? { range } : {} }, (res) => {
      const bufs = []; let got = 0;
      res.on('data', (c) => { bufs.push(c); got += c.length; if (limit && got >= limit) { res.destroy(); ok(Buffer.concat(bufs)); } });
      res.on('end', () => ok(Buffer.concat(bufs)));
    });
  });
  try {
    // Part of the start, then from 8 MB to the end, then everything: the provider sends the film about once.
    let u = relayUrl(relay.base, SECRET, `http://127.0.0.1:${P}/a.mp4`, {}, 3600, { w: 1, i: 'a' });
    await read(u, 'bytes=0-', 1048576 * 2);
    assert.ok((await read(u, 'bytes=8388608-')).equals(data.subarray(8388608)));
    await wait(300);
    assert.ok((await read(u, 'bytes=0-')).equals(data));
    assert.ok(served < SIZE * 1.25, `fetched ${(served / 1048576).toFixed(1)} MB of a ${SIZE / 1048576} MB film`);
    // Two readers far apart in another film: both get it, with a handful of connections (not thousands).
    served = 0; conns = 0;
    u = relayUrl(relay.base, SECRET, `http://127.0.0.1:${P}/b.mp4`, {}, 3600, { w: 1, i: 'b' });
    const [x, y] = await Promise.all([read(u, 'bytes=0-'), read(u, 'bytes=10485760-')]);
    assert.ok(x.equals(data) && y.equals(data.subarray(10485760)));
    assert.ok(conns < 20, conns + ' connections');
    // A viewer who zaps away before the provider answers: the provider connection closes straight away.
    const z = relayUrl(relay.base, SECRET, `http://127.0.0.1:${P}/slow.ts`, {});
    const req = http.get(z, () => {}); req.on('error', () => {});
    await wait(300); req.destroy();
    await wait(1500);
    assert.strictEqual(open, 0, 'the provider connection was let go');
  } finally { relay.p.kill(); prov.close(); }
});

test('the relay reaches providers through a proxy: HTTP (plain and CONNECT) and SOCKS5, playlists and whole films too', { timeout: 60000 }, async () => {
  const { makeRelay } = require('../lib/streamrelay');
  const tls = require('tls');
  const FILM2 = Buffer.alloc(3 * 1048576, 7);
  const seen = []; // what the provider saw: [path, from the proxy?]
  const prov = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === '/live.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXTINF:6,\nseg1.ts\n'); }
    if (req.url === '/seg1.ts') { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end(Buffer.alloc(1880, 1)); }
    if (req.url === '/trace') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('h=x\nip=' + (req.headers['x-via'] || '203.0.113.9') + '\n'); }
    if (req.url === '/film.mp4') {
      const m = /bytes=(\d+)-/.exec(req.headers.range || ''); const a = m ? +m[1] : 0;
      res.writeHead(m ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': FILM2.length - a, ...(m ? { 'Content-Range': `bytes ${a}-${FILM2.length - 1}/${FILM2.length}` } : {}) });
      return res.end(FILM2.subarray(a));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => prov.listen(0, '127.0.0.1', ok));
  const P = prov.address().port;
  // An HTTP proxy with a sign-in: plain requests with the full address, and CONNECT tunnels.
  let httpUses = 0;
  const hp = http.createServer((req, res) => {
    if (req.headers['proxy-authorization'] !== 'Basic ' + Buffer.from('u:p w').toString('base64')) { res.writeHead(407); return res.end(); }
    httpUses++;
    const u = new URL(req.url);
    const h = { ...req.headers, 'x-via': '198.51.100.7' }; delete h['proxy-authorization'];
    const up = http.request(u, { method: req.method, headers: h }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  hp.on('connect', (req, sock, head) => {
    if (req.headers['proxy-authorization'] !== 'Basic ' + Buffer.from('u:p w').toString('base64')) return sock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    httpUses++;
    const [h, port] = req.url.split(':');
    const up = net.connect(+port, h, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.destroy());
  });
  await new Promise((ok) => hp.listen(0, '127.0.0.1', ok));
  // A SOCKS5 proxy (no sign-in).
  let socksUses = 0;
  const sp = net.createServer((c) => {
    c.once('data', () => {
      c.write(Buffer.from([5, 0]));
      c.once('data', (d) => {
        const len = d[4]; const host = d.subarray(5, 5 + len).toString(); const port = d.readUInt16BE(5 + len);
        socksUses++;
        const up = net.connect(port, host, () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); up.pipe(c); c.pipe(up); });
        up.on('error', () => c.destroy());
      });
    });
  });
  await new Promise((ok) => sp.listen(0, '127.0.0.1', ok));
  const HP = `http://u:${encodeURIComponent('p w')}@127.0.0.1:${hp.address().port}`;
  const SP = `socks5://127.0.0.1:${sp.address().port}`;
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-px-'));
  const relay = await startRelay({ RELAY_ALLOW_PRIVATE: '1', RELAY_CACHE_DIR: cache });
  // The server side: the proxy goes inside the sealed address (devices never see it).
  let mode = 'list';
  const rel = makeRelay({ getSettings: () => ({ relay: { url: relay.base, secret: SECRET, all: true } }), listOf: () => ({}), proxyOf: () => (mode === 'list' ? HP : '') });
  try {
    const sealedUrl = rel.wrap(`http://127.0.0.1:${P}/live.m3u8`, {});
    assert.ok(!sealedUrl.includes('127.0.0.1:' + hp.address().port) && !sealedUrl.includes('p%20w'), 'the proxy isn’t readable in the address');
    assert.strictEqual(unseal(sealedUrl, SECRET).p, HP);
    mode = '';
    assert.strictEqual(unseal(rel.wrap(`http://127.0.0.1:${P}/x.ts`, {}), SECRET).p, undefined, 'no proxy: straight from the relay');
    // A playlist through the HTTP proxy (plain http: the full address), and its segment through it too.
    let r = await fetch(sealedUrl);
    const text = await r.text();
    assert.strictEqual(r.status, 200);
    const seg = new URL(relayLinks(text)[0], relay.base).href;
    assert.strictEqual(unseal(seg, SECRET).p, HP, 'segments keep the proxy');
    r = await fetch(seg);
    assert.strictEqual((await r.arrayBuffer()).byteLength, 1880);
    assert.strictEqual(httpUses, 2);
    // The same through SOCKS5, and a film fetched whole through it.
    const viaSocks = relayUrl(relay.base, SECRET, `http://127.0.0.1:${P}/film.mp4`, {}, 3600, { w: 1, i: 'f', p: SP });
    r = await fetch(viaSocks, { headers: { Range: 'bytes=1048576-' } });
    assert.strictEqual(r.status, 206);
    assert.strictEqual((await r.arrayBuffer()).byteLength, FILM2.length - 1048576);
    assert.ok(socksUses >= 1);
    // A wrong sign-in or a proxy that isn't there: a clear error, not a hang.
    r = await fetch(relayUrl(relay.base, SECRET, `http://127.0.0.1:${P}/seg1.ts`, {}, 60, { p: HP.replace('p%20w', 'nope') }));
    assert.strictEqual(r.status, 502);
    assert.match(await r.text(), /username or password/);
    r = await fetch(relayUrl(relay.base, SECRET, `https://127.0.0.1:${P}/seg1.ts`, {}, 60, { p: 'socks5://127.0.0.1:1' }));
    assert.strictEqual(r.status, 502);
    assert.match(await r.text(), /Proxy/);
    // CONNECT for https addresses: the tunnel is made with the sign-in (the TLS on top fails here: no https provider).
    const before = httpUses;
    r = await fetch(relayUrl(relay.base, SECRET, `https://127.0.0.1:${P}/seg1.ts`, {}, 60, { p: HP }));
    assert.strictEqual(httpUses, before + 1, 'a CONNECT tunnel through the proxy');
    assert.strictEqual(r.status, 502);
    // Admin → Stream relay → Test: what address providers see, straight from the relay and through the proxy.
    const { testRelayProxy } = require('../lib/streamrelay');
    const own = await testRelayProxy(relay.base, SECRET, '', fetch, `http://127.0.0.1:${P}/trace`);
    const via = await testRelayProxy(relay.base, SECRET, HP, fetch, `http://127.0.0.1:${P}/trace`);
    assert.deepStrictEqual([own.ok, own.ip, via.ok, via.ip], [true, '203.0.113.9', true, '198.51.100.7']);
    const bad = await testRelayProxy(relay.base, SECRET, 'socks5://127.0.0.1:1', fetch, `http://127.0.0.1:${P}/trace`);
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /Proxy/);
  } finally { relay.p.kill(); prov.close(); hp.close(); sp.close(); }
});

test('the relay updates itself only with a valid signature and a working file', { timeout: 20000 }, async () => {
  const crypto = require('crypto');
  const copy = relayCopy();
  const r = await startRelay({}, copy);
  const send = (code, secret, t = String(Math.floor(Date.now() / 1000))) => fetch(r.base + '/update', { method: 'POST', body: code, headers: { 'X-Relay-Time': t, 'X-Relay-Sig': crypto.createHmac('sha256', secret).update('update:' + t + ':' + crypto.createHash('sha256').update(code).digest('hex')).digest('base64url').slice(0, 32) } });
  try {
    const good = fs.readFileSync(copy, 'utf8').replace("const VERSION = '", "const VERSION = 'next-");
    assert.strictEqual((await send(good, 'not-the-secret-123456')).status, 403);
    assert.strictEqual((await send(good, SECRET, '1000')).status, 403, 'an old signature');
    assert.strictEqual((await send('this is not ( javascript', SECRET)).status, 400);
    assert.strictEqual((await send('console.log(1)', SECRET)).status, 400, 'not a relay.js');
    assert.doesNotMatch(fs.readFileSync(copy, 'utf8'), /VERSION = 'next-/);
    const ok = await send(good, SECRET);
    assert.strictEqual(ok.status, 200);
    assert.match((await ok.json()).to, /^next-/);
    for (let i = 0; i < 40 && r.p.exitCode === null; i++) await wait(50);
    assert.strictEqual(r.p.exitCode, 0);
    assert.match(fs.readFileSync(copy, 'utf8'), /VERSION = 'next-/);
  } finally { r.p.kill(); }
});

test('the real server: relay addresses for direct streams, per list, for other apps; admin only', { timeout: 60000 }, async () => {
  const pv = await provider();
  const r = await startRelay({ RELAY_ALLOW_PRIVATE: '1' });
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const api = async (method, p, body) => {
    const h = { 'X-App': '1' };
    if (cookie) h.Cookie = cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: res.status, body: j };
  };
  try {
    for (let i = 0; i < 100 && !/Ready/.test(out); i++) await wait(100);
    await api('POST', '/api/login', { password: 'pw-test' });
    await api('POST', '/api/profiles', { name: 'Alex', pin: '1234', avatar: 1 });
    const list = (await api('POST', '/api/admin/lists', { type: 'url', name: 'Relayed', url: `${pv.base}/list.m3u` })).body;
    let cat;
    for (let i = 0; i < 60; i++) { cat = (await api('GET', '/api/catalog')).body; if (cat && cat.items && cat.items.length >= 2) break; await wait(200); }
    const ch = cat.items.find((x) => x.n === 'Relay News');
    const film = cat.items.find((x) => /Relay Film/.test(x.n));
    assert.ok(ch && film, JSON.stringify(cat && cat.items));
    // Without the relay: the provider's own address.
    let reach = (await api('POST', '/api/play/reach', { k: film.k, origin: base })).body;
    assert.ok(!reach.relay && reach.url.includes('s3cret'));
    // With it (for every list): sealed relay addresses that play.
    let s = (await api('PUT', '/api/admin/settings', { relay: { url: r.base + '/' } })).body;
    assert.deepStrictEqual(s.relay, { url: r.base, all: true, hasSecret: true, proxy: '' }, 'the secret is never shown here');
    const secret = (await api('GET', '/api/admin/relay/secret')).body.secret;
    assert.ok(secret.length >= 30);
    // (The relay was started with another secret: the test says so.)
    assert.match((await api('POST', '/api/admin/relay/test')).body.error, /secret is different/);
    r.p.kill();
    const r2 = await startRelay({ RELAY_ALLOW_PRIVATE: '1', RELAY_SECRET: secret });
    try {
      await api('PUT', '/api/admin/settings', { relay: { url: r2.base } });
      assert.strictEqual((await api('POST', '/api/admin/relay/test')).body.ok, true);
      reach = (await api('POST', '/api/play/reach', { k: ch.k, origin: base })).body;
      assert.strictEqual(reach.relay, true);
      assert.strictEqual(reach.kind, 'hls');
      assert.strictEqual(reach.mse, true);
      assert.ok(reach.url.startsWith(r2.base + '/e/') && !reach.url.includes('s3cret'), reach.url);
      const master = await (await fetch(reach.url)).text();
      assert.match(master, /#EXT-X-STREAM-INF/, 'the channel’s User-Agent went with it');
      // The server's own reading of a film — a conversion, a look inside — is from the relay's whole copy too (the one
      // devices play from), so the film is fetched from the provider once.
      let ffprobe = true;
      try { require('child_process').execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); } catch { ffprobe = false; }
      if (ffprobe) {
        await api('GET', `/api/probe/${film.k}?alt=-1`); // (not a real video: what matters is how the relay was asked)
        const t0 = String(Math.floor(Date.now() / 1000));
        const sig0 = require('crypto').createHmac('sha256', secret).update('downloads::' + t0).digest('base64url').slice(0, 32);
        const dl0 = await (await fetch(`${r2.base}/downloads?t=${t0}&s=${sig0}`)).json();
        assert.ok(dl0.films.some((f) => f.ids.includes(require('../lib/streamrelay').playId(film.k, -1))), 'asked for whole: ' + JSON.stringify(dl0));
      }
      reach = (await api('POST', '/api/play/reach', { k: film.k, origin: base })).body;
      assert.strictEqual(reach.kind, 'native');
      // A film: the relay is asked to fetch it whole (the channel isn't).
      const sealed = unseal(reach.url, secret);
      assert.strictEqual(sealed.w, 1);
      assert.strictEqual(sealed.i, require('../lib/streamrelay').playId(film.k, -1));
      assert.strictEqual(sealed.a, require('../lib/streamrelay').acctId((list.list || list).id), 'its account (whose connections its films share)');
      assert.ok(!unseal((await api('POST', '/api/play/reach', { k: ch.k, origin: base })).body.url, secret).w, 'live channels aren’t fetched whole');
      assert.deepStrictEqual(Buffer.from(await (await fetch(reach.url)).arrayBuffer()), FILM);
      // The relay now has it all, and says so when the server asks.
      const t = String(Math.floor(Date.now() / 1000));
      const sig = require('crypto').createHmac('sha256', secret).update('downloads::' + t).digest('base64url').slice(0, 32);
      const dl = await (await fetch(`${r2.base}/downloads?t=${t}&s=${sig}`)).json();
      assert.ok(dl.films.some((f) => f.done && f.ids.includes(sealed.i)), JSON.stringify(dl));
      // The same version as this server's relay.js: nothing to update.
      const tested = (await api('POST', '/api/admin/relay/test')).body;
      assert.strictEqual(tested.outdated, false);
      assert.strictEqual(tested.films, 1);
      // Devices are told which lists are behind the relay (they then never contact those providers themselves).
      const boot = (await api('GET', '/api/boot')).body;
      assert.deepStrictEqual(boot.relayLists, [list.id]);
      // "Open in another app" goes through the relay too.
      const ext = (await api('POST', '/api/play/external', { k: film.k })).body;
      assert.strictEqual(ext.how, 'relay');
      assert.ok(ext.url.startsWith(r2.base + '/e/'));
      assert.strictEqual(unseal(ext.url, secret).w, 1);
      // "Update the relay": this relay runs from a copy, which it replaces with the server's relay.js and restarts.
      const copy = relayCopy();
      fs.writeFileSync(copy, fs.readFileSync(copy, 'utf8').replace("const VERSION = '", "const VERSION = 'old-"));
      const r3 = await startRelay({ RELAY_ALLOW_PRIVATE: '1', RELAY_SECRET: secret }, copy);
      try {
        await api('PUT', '/api/admin/settings', { relay: { url: r3.base } });
        const before = (await api('POST', '/api/admin/relay/test')).body;
        assert.strictEqual(before.outdated, true);
        const up = (await api('POST', '/api/admin/relay/update')).body;
        assert.strictEqual(up.ok, true, JSON.stringify(up));
        assert.match(up.from, /^old-/);
        for (let i = 0; i < 40 && r3.p.exitCode === null; i++) await wait(50);
        assert.strictEqual(r3.p.exitCode, 0, 'it exits so Docker starts it again');
        assert.strictEqual(fs.readFileSync(copy, 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'relay', 'relay.js'), 'utf8'));
      } finally { r3.p.kill(); await api('PUT', '/api/admin/settings', { relay: { url: r2.base } }); }
      // One list straight from the provider again.
      await api('PUT', `/api/admin/lists/${list.id}`, { relay: 'off' });
      reach = (await api('POST', '/api/play/reach', { k: film.k, origin: base })).body;
      assert.ok(!reach.relay);
      assert.deepStrictEqual((await api('GET', '/api/boot')).body.relayLists, []);
      // Every list off by default, this one on.
      await api('PUT', '/api/admin/settings', { relay: { all: false } });
      await api('PUT', `/api/admin/lists/${list.id}`, { relay: 'on' });
      assert.strictEqual((await api('POST', '/api/play/reach', { k: film.k, origin: base })).body.relay, true);
      // A bad address is refused; a new secret changes it; turning it off.
      assert.strictEqual((await api('PUT', '/api/admin/settings', { relay: { url: 'not an address' } })).status, 400);
      await api('PUT', '/api/admin/settings', { relay: { newSecret: true } });
      assert.notStrictEqual((await api('GET', '/api/admin/relay/secret')).body.secret, secret);
      await api('PUT', '/api/admin/settings', { relay: { url: '' } });
      assert.ok(!(await api('POST', '/api/play/reach', { k: film.k, origin: base })).body.relay);
      assert.doesNotMatch(out, new RegExp(secret), 'the secret is never logged');
    } finally { r2.p.kill(); }
  } finally { app.kill(); r.p.kill(); pv.srv.close(); }
});

test('a play whose film the relay already has doesn’t count towards the connection limit', () => {
  const { listUsage } = require('../lib/usage');
  const conns = [{ id: 'a', playing: { k: 'f1', alt: -1 } }, { id: 'b', playing: { k: 'live1' } }, { id: 'c', playing: { k: 'f2' } }];
  const use = listUsage(conns, { listOf: () => 'L', freed: (pl) => pl.k === 'f1' });
  assert.deepStrictEqual(use.get('L').map((c) => c.id), ['b', 'c']);
  assert.deepStrictEqual(listUsage(conns, { listOf: () => 'L' }).get('L').length, 3);
});

test('relay 5: films of one account share its connections (everyone kept ahead), watched parts deleted, old films go, struggling reported', { timeout: 90000 }, async () => {
  const crypto = require('crypto');
  const MB = 1048576;
  const SIZE = 24 * MB;
  const data = crypto.randomBytes(SIZE);
  let open = 0, most = 0, refused = 0;
  const speed = { '/a.mp4': 4 * MB, '/b.mp4': 4 * MB, '/t.mp4': 8 * MB, '/x.mp4': 8 * MB, '/s1.mp4': 200 * 1024, '/s2.mp4': 200 * 1024 }; // bytes a second
  // A provider account that allows ONE connection at a time for a.mp4 and b.mp4 (a second one is refused).
  const prov = http.createServer((req, res) => {
    const limited = /^\/[ab]\.mp4/.test(req.url);
    if (limited) { if (open >= 1) { refused++; res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('too many connections'); } open++; most = Math.max(most, open); res.on('close', () => open--); }
    const m = /bytes=(\d+)-/.exec(req.headers.range || ''); const a = m ? +m[1] : 0;
    res.writeHead(206, { 'content-type': 'video/mp4', 'content-length': SIZE - a, 'content-range': `bytes ${a}-${SIZE - 1}/${SIZE}`, 'accept-ranges': 'bytes' });
    let p = a; const per = Math.max(1, Math.round((speed[req.url] || 4 * MB) / 20));
    const step = () => { if (res.destroyed) return; if (p >= SIZE) return res.end(); const n = Math.min(per, SIZE - p); res.write(data.subarray(p, p + n)); p += n; setTimeout(step, 50); };
    step();
  });
  await new Promise((ok) => prov.listen(0, '127.0.0.1', ok));
  const P = prov.address().port;
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'relay5-'));
  const relay = await startRelay({ RELAY_ALLOW_PRIVATE: '1', RELAY_CACHE_DIR: cache, RELAY_BLOCK_MB: '1', RELAY_BACK_S: '2', RELAY_AHEAD_S: '4', RELAY_SWAP_S: '2', RELAY_MIN_RUN_MS: '500', RELAY_TICK_MS: '100', RELAY_SWEEP_MS: '300', RELAY_STRAIN_AFTER_MS: '1000' });
  const film = (f, extra) => relayUrl(relay.base, SECRET, `http://127.0.0.1:${P}${f}`, {}, 3600, { w: 1, i: f.slice(1, -4), ...extra });
  const downloads = async (budget, since) => {
    const t = String(Math.floor(Date.now() / 1000));
    const sig = (x) => crypto.createHmac('sha256', SECRET).update(x + ':' + t).digest('base64url').slice(0, 32);
    let q = `t=${t}&s=${sig('downloads:')}`;
    if (budget !== undefined) q += `&budget=${encodeURIComponent(budget)}&bs=${sig('budget:' + budget)}`;
    if (since !== undefined) q += `&since=${since}`;
    return (await fetch(`${relay.base}/downloads?${q}`)).json();
  };
  // A pretend player: reads at `rate` bytes a second (from `from`), noting its longest wait for data.
  const play = (u, rate, from, ms) => new Promise((ok) => {
    const t0 = Date.now(); let got = 0, last = Date.now(), longest = 0, first = 0;
    const req = http.get(u, { headers: { range: `bytes=${from}-` } }, (res) => {
      const bufs = [];
      res.on('data', (c) => {
        const now = Date.now(); if (!first) first = now - t0;
        longest = Math.max(longest, now - last); last = now;
        bufs.push(c); got += c.length;
        // Faster than playback: pause until "the picture" catches up.
        const ahead = got / rate * 1000 - (now - t0);
        if (ahead > 300) { res.pause(); setTimeout(() => { last = Date.now(); res.resume(); }, ahead - 200); }
        if (now - t0 > ms) { req.destroy(); ok({ got, longest, first, buf: Buffer.concat(bufs) }); }
      });
      res.on('end', () => ok({ got, longest, first, buf: Buffer.concat(bufs) }));
    });
    req.on('error', () => {});
  });
  const blocks = (key) => fs.readdirSync(cache).filter((f) => f.startsWith(key + '.')).map((f) => +f.split('.')[1]).sort((x, y) => x - y);
  try {
    // The account allows one connection: the server says so. Two people start films (each 24 MB, 60 s long → 400 KB/s).
    await downloads('acc1:1');
    const A = play(film('/a.mp4', { a: 'acc1', d: 60 }), SIZE / 60, 0, 9000);
    await wait(1500);
    const B = play(film('/b.mp4', { a: 'acc1', d: 60 }), SIZE / 60, 0, 7000);
    const [ra, rb] = await Promise.all([A, B]);
    assert.strictEqual(most, 1, 'never more than the account’s one connection');
    assert.strictEqual(refused, 0, 'never refused by the provider');
    assert.ok(ra.buf.equals(data.subarray(0, ra.got)) && rb.buf.equals(data.subarray(0, rb.got)), 'every byte right');
    assert.ok(rb.first < 4000, `the second film started in ${rb.first} ms (the first one had enough ready to spare the connection)`);
    assert.ok(ra.got >= SIZE / 60 * 8 && rb.got >= SIZE / 60 * 6, `both kept playing (${(ra.got / MB).toFixed(1)} MB and ${(rb.got / MB).toFixed(1)} MB)`);
    assert.ok(ra.longest < 2500 && rb.longest < 2500, `no long waits (${ra.longest} ms, ${rb.longest} ms)`);
    let d = await downloads();
    assert.strictEqual(d.version, '7');
    assert.strictEqual(d.accounts.acc1.budget, 1);
    assert.ok(!d.strain.some((e) => e.a === 'acc1'), 'it kept up: ' + JSON.stringify(d.strain));

    // The part already watched is deleted (keeping 2 s back here, 10 minutes normally), the first and last pieces stay;
    // seeking back fetches it again.
    const key = crypto.createHash('sha256').update(`http://127.0.0.1:${P}/t.mp4`).digest('hex').slice(0, 32);
    const T = film('/t.mp4', { d: 24 }); // 1 MB a second
    const rt = await play(T, 3 * MB, 0, 5000);
    assert.ok(rt.buf.equals(data.subarray(0, rt.got)));
    const tail = play(T, 1 * MB, rt.got, 3000); // (still watching, further on)
    await wait(1500);
    const left = blocks(key);
    assert.ok(left.includes(0), 'the first piece stays');
    assert.ok(!left.includes(2) && !left.includes(3), 'watched pieces are gone: ' + left.join(','));
    const back = await (await fetch(T, { headers: { Range: `bytes=${2 * MB}-${3 * MB - 1}` } })).arrayBuffer();
    assert.ok(Buffer.from(back).equals(data.subarray(2 * MB, 3 * MB)), 'seeking back fetches it again');
    await tail;

    // A film is kept for at most twice its length once nobody watches it (x: 2 s long).
    const X = film('/x.mp4', { d: 2 });
    await (await fetch(X, { headers: { Range: 'bytes=0-99' } })).arrayBuffer();
    assert.ok((await downloads()).films.some((f) => f.ids.includes('x')));
    await wait(5500);
    assert.ok(!(await downloads()).films.some((f) => f.ids.includes('x')), 'gone after twice its length');

    // Too slow to keep up (each film 400 KB/s, the provider sends 200 KB/s, one connection between them): reported.
    await downloads('acc2:1');
    d = await downloads();
    const before = d.seq;
    const s1 = play(film('/s1.mp4', { a: 'acc2', d: 60 }), SIZE / 60, 0, 7000);
    const s2 = play(film('/s2.mp4', { a: 'acc2', d: 60 }), SIZE / 60, 0, 7000);
    await Promise.all([s1, s2]);
    d = await downloads(undefined, before);
    const ev = d.strain.filter((e) => e.a === 'acc2');
    assert.ok(ev.length >= 1, 'it says it couldn’t keep up: ' + JSON.stringify(d.strain));
    assert.ok(ev[0].viewers >= 1 && ev[0].budget === 1 && ev[0].t > 0);
    assert.ok(!d.strain.some((e) => e.seq <= before), 'only what’s new');
  } finally { relay.p.kill(); prov.close(); }
});

test('relay 5 on the server: films it shares connections for count once; budgets and struggling reach the relay and Statistics', async () => {
  const { listUsage } = require('../lib/usage');
  const conns = [{ id: 'a', playing: { k: 'f1' } }, { id: 'b', playing: { k: 'live1' } }, { id: 'c', playing: { k: 'f2' } }, { id: 'd', playing: { k: 'f3' } }];
  const use = listUsage(conns, { listOf: () => 'L', freed: (pl) => pl.k === 'f3', pooled: (pl) => /^f/.test(pl.k) });
  const L = use.get('L');
  assert.deepStrictEqual(L.map((c) => c.id), ['a', 'b'], 'f1 and f2 together once, f3 not at all (the relay has it)');
  assert.ok(L[0].relayShared);
  assert.deepStrictEqual(L[0].viewers.map((v) => v.id), ['a', 'c']);
  // The relay is told each account's share, signed, and answers with what it couldn't do.
  const crypto = require('crypto');
  const { relayDownloads, acctId } = require('../lib/streamrelay');
  let asked = '';
  const fake = async (u) => { asked = u; return { ok: true, json: async () => ({ ok: true, version: '5', films: [], accounts: { [acctId('L')]: { runs: 2 } }, strain: [{ seq: 4, t: 1, a: acctId('L'), viewers: 3 }], seq: 4 }) }; };
  const j = await relayDownloads('https://relay.example', SECRET, ['x'], fake, { budget: { [acctId('L')]: 2 }, since: 3, full: true });
  const q = new URL(asked).searchParams;
  assert.strictEqual(q.get('budget'), acctId('L') + ':2');
  assert.strictEqual(q.get('bs'), crypto.createHmac('sha256', SECRET).update('budget:' + q.get('budget') + ':' + q.get('t')).digest('base64url').slice(0, 32));
  assert.strictEqual(q.get('since'), '3');
  assert.strictEqual(j.strain[0].viewers, 3);
  assert.deepStrictEqual(await relayDownloads('https://relay.example', SECRET, [], fake), [], 'the old answer when not asked for more');
  // Statistics keep the times it couldn't keep up.
  const { Concurrency } = require('../lib/concurrency');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conc-strain-'));
  const cc = new Concurrency(dir, { usage: () => new Map([['L', [{ id: 'a' }]]]), lists: () => [{ id: 'L', name: 'Main' }], limitOf: () => 2, extra: () => 1 }, { every: 0 });
  assert.deepStrictEqual(cc.sample(), { L: 2 }, 'the relay’s extra connection counts');
  cc.relayStrain('L', { t: Date.now(), viewers: 3, films: 2, runs: 2, budget: 2, least: 12, need: 1e6, rate: 5e5 });
  const r = cc.report(7);
  assert.strictEqual(r.strain.length, 1);
  assert.strictEqual(r.strain[0].name, 'Main');
  assert.strictEqual(r.providers[0].strain, 1);
});

test('relay 5: a film nobody reads stops downloading; a request the provider can’t be asked doesn’t hang; a refusal is tried again', { timeout: 60000 }, async () => {
  const SIZE = 8 * 1048576;
  let open = 0, refuse = true;
  const prov = http.createServer((req, res) => {
    if (req.url === '/busy.mp4' && refuse) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('too many connections'); }
    open++; res.on('close', () => open--);
    const m = /bytes=(\d+)-/.exec(req.headers.range || ''); const a = m ? +m[1] : 0;
    res.writeHead(206, { 'content-type': 'video/mp4', 'content-length': SIZE - a, 'content-range': `bytes ${a}-${SIZE - 1}/${SIZE}` });
    let p = a;
    const step = () => { if (res.destroyed) return; if (p >= SIZE) return res.end(); res.write(Buffer.alloc(65536, 1)); p += 65536; setTimeout(step, 50); };
    step();
  });
  await new Promise((ok) => prov.listen(0, '127.0.0.1', ok));
  const P = prov.address().port;
  const relay = await startRelay({ RELAY_ALLOW_PRIVATE: '1', RELAY_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'relay5b-')), RELAY_IDLE_STOP_MS: '800' });
  try {
    // A HEAD request starts the film, but nobody reads it: the provider connection goes after the idle time.
    const u = relayUrl(relay.base, SECRET, `http://127.0.0.1:${P}/a.mp4`, {}, 3600, { w: 1, i: 'a' });
    const h = await fetch(u, { method: 'HEAD' });
    assert.strictEqual(h.headers.get('content-length'), String(SIZE));
    await wait(400);
    assert.strictEqual(open, 1);
    await wait(1500);
    assert.strictEqual(open, 0, 'the download stopped');
    // A header the request can't carry: an answer, not a request that waits forever.
    // (Sealed by hand: the server's own relayUrl() leaves such a header out.)
    const crypto = require('crypto');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update('relay-key:' + SECRET).digest(), iv);
    const body = Buffer.concat([c.update(JSON.stringify({ u: `http://127.0.0.1:${P}/b.mp4`, h: { 'X-Bad': 'caf\u0101' }, e: Math.floor(Date.now() / 1000) + 600, w: 1, i: 'b' })), c.final()]);
    const bad = `${relay.base}/e/${Buffer.concat([iv, body, c.getAuthTag()]).toString('base64url')}/b.mp4`;
    const t0 = Date.now();
    const r = await fetch(bad, { signal: AbortSignal.timeout(8000) });
    assert.ok(r.status >= 400 && Date.now() - t0 < 5000, 'answered ' + r.status);
    // "Too many connections" at the start: next time it's tried again as a whole film (not relayed as it comes).
    const busy = relayUrl(relay.base, SECRET, `http://127.0.0.1:${P}/busy.mp4`, {}, 3600, { w: 1, i: 'busy' });
    assert.strictEqual((await fetch(busy, { headers: { Range: 'bytes=0-99' } })).status, 403);
    refuse = false;
    const ok = await fetch(busy, { headers: { Range: 'bytes=0-99' } });
    assert.strictEqual(ok.status, 206);
    await ok.arrayBuffer();
    const t = String(Math.floor(Date.now() / 1000));
    const sig = require('crypto').createHmac('sha256', SECRET).update('downloads::' + t).digest('base64url').slice(0, 32);
    const d = await (await fetch(`${relay.base}/downloads?t=${t}&s=${sig}`)).json();
    assert.ok(d.films.some((f) => f.ids.includes('busy')), 'kept whole this time');
  } finally { relay.p.kill(); prov.close(); }
});
