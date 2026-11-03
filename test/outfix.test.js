'use strict';
// Fixes in the HDHomeRun tuner (lib/outputs.js), watch-party sharing (lib/fanout.js) and outgoing proxies (lib/net.js):
// a relayed Stalker channel's address for ffmpeg, lists that grew for ever, byte ranges, and abort listeners.
// Everything runs against local pretend servers (no network).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { Outputs } = require('../lib/outputs');
const { Fanout } = require('../lib/fanout');
const { tunnel } = require('../lib/net');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outfix-'));
const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));
const get = (url, headers = {}) => new Promise((ok, no) => http.get(url, { headers }, (r) => { const parts = []; r.on('data', (c) => parts.push(c)); r.on('end', () => ok({ status: r.statusCode, headers: r.headers, body: Buffer.concat(parts) })); }).on('error', no));

// ---------------------------------------------------------------- HDHomeRun: what ffmpeg is asked to open
/** A tuner with one Stalker channel; the fake "ffmpeg" writes the address it was given to a file. */
function tuner({ viaProxy, loopbackBase } = {}) {
  const dir = tmp();
  const argsFile = path.join(dir, 'args');
  const bin = path.join(dir, 'fake-ffmpeg.sh');
  fs.writeFileSync(bin, `#!/bin/sh\nfor a; do if [ "$prev" = "-i" ]; then printf '%s' "$a" > "${argsFile}"; fi; prev="$a"; done\n`);
  fs.chmodSync(bin, 0o755);
  const it = { k: 'c1', n: 'Portal One', t: 'live', src: 'S', u: '/api/proxy/stalker/S/live/42', h: {} };
  const profiles = [{ id: 'A', name: 'Dad', admin: true, restrictions: {} }];
  const out = new Outputs({
    dir, catalog: {}, lists: { stalkerLink: async () => 'http://portal.invalid/live/42.m3u8', all: () => [] }, accounts: { profiles, profile: (id) => profiles.find((p) => p.id === id) || null },
    epg: {}, settings: () => ({}), media: { available: true, ffmpegBin: bin }, clientIp: () => '192.168.1.5', ready: async () => {},
    hiddenFor: () => new Set(), inputOf: (x) => ({ input: 'http://127.0.0.1:1/c/x' + x.u, headers: {} }),
    relayPath: (u) => '/c/signed/api/proxy?u=' + encodeURIComponent(u),
    videoViaProxy: () => !!viaProxy, connLimit: () => 0, usage: () => 0, serveLocal: () => {}, ...(loopbackBase ? { loopbackBase } : {}),
  });
  out._lineup = () => [{ num: '1', it }];
  out._locked = () => false;
  out.update({ hdhr: { enabled: true, tuners: 2 } });
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try { if (!(await out.handle(req, res, u.pathname, u.searchParams))) { res.writeHead(404); res.end(); } } catch (e) { if (!res.headersSent) res.writeHead(e.status || 500); res.end(e.message); }
  });
  return { srv, given: () => fs.readFileSync(argsFile, 'utf8') };
}

test('HDHomeRun: a Stalker channel through the relay gives ffmpeg a full loopback address, not "/c/…"', { timeout: 10000 }, async () => {
  const t = tuner({ viaProxy: true });
  const port = await listen(t.srv);
  try {
    const r = await get(`http://127.0.0.1:${port}/auto/v1`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(t.given(), `http://127.0.0.1:${port}/c/signed/api/proxy?u=${encodeURIComponent('http://portal.invalid/live/42.m3u8')}`);
  } finally { t.srv.close(); }
});

test('HDHomeRun: the server’s own loopback address is used when it is given; a direct portal address is unchanged', { timeout: 10000 }, async () => {
  const a = tuner({ viaProxy: true, loopbackBase: () => 'https://127.0.0.1:9999' });
  const b = tuner({ viaProxy: false });
  const pa = await listen(a.srv), pb = await listen(b.srv);
  try {
    await get(`http://127.0.0.1:${pa}/auto/v1`);
    assert.match(a.given(), /^https:\/\/127\.0\.0\.1:9999\/c\/signed\/api\/proxy\?u=/);
    await get(`http://127.0.0.1:${pb}/auto/v1`);
    assert.strictEqual(b.given(), 'http://portal.invalid/live/42.m3u8');
  } finally { a.srv.close(); b.srv.close(); }
});

// ---------------------------------------------------------------- watch-party sharing
const body = Buffer.from('0123456789');
const fanOf = (now) => new Fanout({
  now,
  fetch: async (u, opts) => {
    const m = /bytes=(\d+)-(\d+)/.exec((opts.headers && opts.headers.Range) || '');
    const part = m ? body.subarray(Number(m[1]), Number(m[2]) + 1) : body;
    return new Response(part, { status: m ? 206 : 200, headers: m ? { 'Content-Range': `bytes ${m[1]}-${Number(m[1]) + part.length - 1}/${body.length}`, 'Content-Type': 'video/mp4' } : { 'Content-Type': 'video/mp2t' } });
  },
});
/** A fake response that records what was sent. */
function fakeRes() {
  const r = { status: 0, headers: {}, body: null };
  r.writeHead = (s, h) => { r.status = s; r.headers = h || {}; };
  r.end = (b) => { r.body = b ? Buffer.from(b) : Buffer.alloc(0); };
  return r;
}
const ask = async (fan, t, range) => {
  const res = fakeRes();
  const s = new URL('http://x' + fan.sign(t));
  await fan.handle({ headers: range ? { range } : {} }, res, s.searchParams);
  return res;
};

test('Watch party: segment ranges — suffix ranges answered, inverted or empty ones refused with 416', async () => {
  const fan = fanOf();
  const t = { p: 'P1', u: 'http://prov.invalid/seg1.ts', m: 'seg' };
  let r = await ask(fan, t, 'bytes=-3');
  assert.strictEqual(r.status, 206);
  assert.strictEqual(r.body.toString(), '789');
  assert.strictEqual(r.headers['Content-Range'], 'bytes 7-9/10');
  r = await ask(fan, t, 'bytes=-50'); // (more than there is: the whole thing)
  assert.strictEqual(r.status, 206);
  assert.strictEqual(r.body.toString(), '0123456789');
  r = await ask(fan, t, 'bytes=5-2');
  assert.strictEqual(r.status, 416);
  assert.strictEqual(r.headers['Content-Range'], 'bytes */10');
  assert.strictEqual((await ask(fan, t, 'bytes=-0')).status, 416);
  assert.strictEqual((await ask(fan, t, 'bytes=10-')).status, 416);
  r = await ask(fan, t, 'bytes=2-4');
  assert.strictEqual(r.body.toString(), '234');
  r = await ask(fan, t, 'bytes=8-');
  assert.strictEqual(r.body.toString(), '89');
  assert.strictEqual((await ask(fan, t)).status, 200);
});

test('Watch party: files and parties nobody uses any more are forgotten', async () => {
  let clock = 1e6;
  const fan = fanOf(() => clock);
  await ask(fan, { p: 'old', u: 'http://prov.invalid/film.mp4', m: 'file' }, 'bytes=0-');
  assert.strictEqual(fan.files.size, 1);
  assert.strictEqual(fan.seen.size, 1);
  clock += 5 * 60e3;
  await ask(fan, { p: 'new', u: 'http://prov.invalid/other.mp4', m: 'file' }, 'bytes=0-');
  assert.strictEqual(fan.files.size, 2, 'still recent: kept');
  assert.strictEqual(fan.seen.size, 2);
  clock += 11 * 60e3; // ("old" unused for 16 min, "new" for 11)
  await ask(fan, { p: 'new', u: 'http://prov.invalid/seg.ts', m: 'seg' });
  assert.deepStrictEqual([...fan.files.keys()], ['http://prov.invalid/other.mp4']);
  assert.deepStrictEqual([...fan.seen.keys()], ['new']);
  assert.ok(fan.active('new'));
});

// ---------------------------------------------------------------- outgoing proxies
test('net: tunnel() takes its abort listener off a long-lived signal once it is done', async () => {
  // A pretend HTTP proxy that accepts CONNECT, and one that refuses.
  const mk = (code) => net.createServer((s) => s.once('data', () => s.write(`HTTP/1.1 ${code} X\r\n\r\n`)));
  const good = mk(200), bad = mk(403);
  const gp = await listen(good), bp = await listen(bad);
  const ac = new AbortController();
  let n = 0;
  const add = ac.signal.addEventListener.bind(ac.signal), rm = ac.signal.removeEventListener.bind(ac.signal);
  ac.signal.addEventListener = (...a) => { if (a[0] === 'abort') n++; return add(...a); };
  ac.signal.removeEventListener = (...a) => { if (a[0] === 'abort') n--; return rm(...a); };
  try {
    for (let i = 0; i < 5; i++) { const s = await tunnel(`http://127.0.0.1:${gp}`, 'example.invalid', 80, ac.signal); s.destroy(); }
    for (let i = 0; i < 3; i++) await assert.rejects(tunnel(`http://127.0.0.1:${bp}`, 'example.invalid', 80, ac.signal), /refused/);
    assert.strictEqual(n, 0, 'no listeners left behind');
  } finally { good.close(); bad.close(); }
});
