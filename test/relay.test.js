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
async function startRelay(env) {
  const port = await freePort();
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'relay', 'relay.js')], { env: { ...process.env, RELAY_SECRET: SECRET, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 50 && !/Stream relay/.test(out); i++) await wait(50);
  assert.match(out, /Stream relay/, out);
  return { p, base: `http://127.0.0.1:${port}`, out: () => out };
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
    assert.deepStrictEqual(s.relay, { url: r.base, all: true, hasSecret: true }, 'the secret is never shown here');
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
      reach = (await api('POST', '/api/play/reach', { k: film.k, origin: base })).body;
      assert.strictEqual(reach.kind, 'native');
      assert.deepStrictEqual(Buffer.from(await (await fetch(reach.url)).arrayBuffer()), FILM);
      // Devices are told which lists are behind the relay (they then never contact those providers themselves).
      const boot = (await api('GET', '/api/boot')).body;
      assert.deepStrictEqual(boot.relayLists, [list.id]);
      // "Open in another app" goes through the relay too.
      const ext = (await api('POST', '/api/play/external', { k: film.k })).body;
      assert.strictEqual(ext.how, 'relay');
      assert.ok(ext.url.startsWith(r2.base + '/e/'));
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
