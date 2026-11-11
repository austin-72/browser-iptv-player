'use strict';
// Playback fixes: a provider's refusal is passed on (and never retried as a hardware or subtitle problem), the
// https check looks once, and helpers that read ffmpeg's words. Fake providers on localhost only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { Media, ffmpegHttpStatus, providerFailed, hwEncoderFailed, sessionStatus, friendlyFfmpegError } = require('../lib/media');
const { Reach } = require('../lib/reach');
const { Proxy } = require('../lib/proxy');
const cfg = require('../lib/config');

const hasFfmpeg = spawnSync(cfg.ffmpeg, ['-version']).status === 0;
const said = (st, text) => `[http @ 0x55d1c0] HTTP error ${st} ${text}\nhttp://127.0.0.1:9/u/p/1.ts: Server returned ${st} ${text}\n`;

test('ffmpeg’s words: provider statuses, connection failures and real hardware failures', () => {
  assert.strictEqual(ffmpegHttpStatus(said(403, 'Forbidden')), 403);
  assert.strictEqual(ffmpegHttpStatus('x: Server returned 404 Not Found'), 404);
  assert.strictEqual(ffmpegHttpStatus('Invalid data found when processing input'), 0);
  assert.ok(providerFailed(said(429, 'Too Many Requests')));
  assert.ok(providerFailed('Connection to tcp://h:80 failed: Connection refused'));
  assert.ok(!providerFailed('Invalid data found when processing input'));
  // (ffmpeg names other codes only by their kind.)
  assert.strictEqual(ffmpegHttpStatus('Error opening input: Server returned 4XX Client Error, but not one of 40{0,1,3,4}'), 400);
  assert.strictEqual(ffmpegHttpStatus('Server returned 5XX Server Error reply'), 500);
  // A refusal is never a hardware problem — not even with the friendly message ("another device") alongside.
  assert.ok(!hwEncoderFailed(said(401, 'Unauthorized') + ' ' + friendlyFfmpegError(said(401, 'Unauthorized'), 1)));
  assert.ok(!hwEncoderFailed('Error while opening encoder for output stream #0:0 - maybe incorrect parameters'));
  assert.ok(!hwEncoderFailed('No such device'));
  assert.ok(!hwEncoderFailed('http://cuda.example.com/nvenc/1.ts: Invalid data found when processing input'), 'words in the address don’t count');
  assert.ok(!hwEncoderFailed(''));
  assert.ok(hwEncoderFailed('[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: unsupported device (2)'));
  assert.ok(hwEncoderFailed('[AVHWDeviceContext @ 0x1] Failed to open /dev/dri/renderD128\nDevice creation failed: -22.'));
  assert.ok(hwEncoderFailed('Impossible to convert between the formats supported by the filter'));
  // Statuses a failed start answers with (401 never: the page reads it as "signed out").
  assert.strictEqual(sessionStatus(said(404, 'Not Found')), 404);
  assert.strictEqual(sessionStatus(said(403, 'Forbidden')), 403);
  assert.strictEqual(sessionStatus(said(401, 'Unauthorized')), 403);
  assert.strictEqual(sessionStatus(said(429, 'Too Many Requests')), 502);
  assert.strictEqual(sessionStatus(said(500, 'Internal Server Error')), 502);
  assert.strictEqual(sessionStatus('Invalid data found when processing input'), 502);
});

test('a provider refusing a conversion: its status is passed on, one connection, no hardware or subtitle retry', { skip: !hasFfmpeg && 'no ffmpeg', timeout: 60000 }, async () => {
  const hits = {};
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    hits[p] = (hits[p] || 0) + 1;
    const st = +(p.match(/\/(\d{3})\//) || [])[1] || 404;
    res.writeHead(st, { 'Content-Type': 'text/plain' });
    res.end('no');
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const B = `http://127.0.0.1:${srv.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playfix-'));
  const media = new Media(cfg, dir, () => ({ userAgent: 'Test', hwaccel: 'nvenc' }));
  await media.detect();
  media.encoders.add('h264_nvenc'); // (as if the server had an NVIDIA card)
  let asked = 0;
  media.sessionOutputs = async ({ dir: d }) => { asked++; return ['-map', '0:a:0?', '-c:a', 'copy', '-f', 'mpegts', path.join(d, 'side.ts')]; };
  const fails = async (p, opts) => {
    try { await media.startSession({ input: B + p, headers: {}, label: p, ...opts }); } catch (e) { return e; }
    assert.fail(`${p} should have failed`);
  };
  try {
    // Converting on "hardware": a 401 says "another device" but stays a refusal — no switch to software, no retry.
    let e = await fails('/401/a.ts', { live: false, video: 'h264' });
    assert.strictEqual(e.status, 403, '401 is passed on as 403');
    assert.strictEqual(media.hwFailed, false, 'the hardware encoder is still used');
    assert.strictEqual(hits['/401/a.ts'], 1, 'one connection only');
    e = await fails('/403/a.ts', { live: false, video: 'h264' });
    assert.strictEqual(e.status, 403);
    assert.strictEqual(media.hwFailed, false);
    assert.strictEqual(hits['/403/a.ts'], 1);
    // A live channel with subtitles copied aside: a 404 or 403 isn't the subtitles' fault — not started again.
    e = await fails('/404/live.ts', { live: true });
    assert.strictEqual(e.status, 404);
    assert.strictEqual(asked, 1, 'subtitle copy asked once');
    assert.strictEqual(hits['/404/live.ts'], 1, 'no second connection after a 404');
    e = await fails('/403/live.ts', { live: true });
    assert.strictEqual(e.status, 403);
    assert.strictEqual(hits['/403/live.ts'], 1, 'no second connection after a 403');
    e = await fails('/429/live.ts', { live: true });
    assert.strictEqual(e.status, 502);
    assert.strictEqual(hits['/429/live.ts'], 1, 'no second connection after a 429');
  } finally {
    media.stopAll();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('https page, http stream: the https copy is looked at once, then the one-connection pause', async () => {
  const r = new Reach(new Proxy(() => ({ userAgent: 'Test' })));
  const asked = [];
  r.probe = async (u) => { asked.push(u); return { kind: 'hls', finite: false, mse: true, url: u, split: false }; };
  const t0 = Date.now();
  const x = await r.check('http://cdn.example.invalid/live/u/p/7.m3u8', {}, 'https://tv.example.com', '', { limit: 1 });
  assert.deepStrictEqual(asked, ['https://cdn.example.invalid/live/u/p/7.m3u8'], 'one look, at the https copy');
  assert.strictEqual(x.url, 'https://cdn.example.invalid/live/u/p/7.m3u8');
  assert.strictEqual(x.blocked, '');
  assert.ok(Date.now() - t0 >= 1400, 'the pause for one-connection accounts still happens');
  // The https copy doesn't answer: blocked as mixed content, nothing else tried.
  r.probe = async (u) => { asked.push(u); throw new Error('no'); };
  const y = await r.check('http://cdn2.example.invalid/live/u/p/8.m3u8', {}, 'https://tv.example.com', '');
  assert.strictEqual(y.blocked, 'mixed');
  assert.strictEqual(asked.length, 2);
});

test('the server: a film whose look inside failed is still converted as a film (seek, kept segments)', { skip: !hasFfmpeg && 'no ffmpeg', timeout: 90000 }, async () => {
  const net = require('net');
  const { spawn } = require('child_process');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playfix-srv-'));
  const film = path.join(dir, 'film.ts');
  const g = spawnSync(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-f', 'mpegts', film]);
  assert.strictEqual(g.status, 0, String(g.stderr));
  // The provider: the first look at the film is refused (as if ffprobe had timed out), later connections get it.
  let filmHits = 0;
  const pv = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/list.m3u') { res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); return res.end(`#EXTM3U\n#EXTINF:-1 group-title="Movies",Probe Fails Film (2020)\nhttp://127.0.0.1:${pv.address().port}/movie/u/p/1.ts\n`); }
    if (p === '/movie/u/p/1.ts') {
      if (++filmHits === 1) { res.writeHead(503); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      return fs.createReadStream(film).pipe(res);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => pv.listen(0, '127.0.0.1', ok));
  const port = await new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => ok(n)); }); });
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(dir, 'data'), NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  let cookie = '';
  const req = async (method, p, body) => {
    const h = { 'X-App': '1' };
    if (cookie) h.Cookie = cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, text: t };
  };
  try {
    for (let i = 0; i < 100 && !/Ready/.test(out); i++) await wait(100);
    assert.match(out, /Ready/, out);
    assert.strictEqual((await req('POST', '/api/login', { password: 'pw-test' })).status, 200);
    assert.strictEqual((await req('POST', '/api/profiles', { name: 'Alex', pin: '1234', avatar: 1 })).status, 200);
    assert.strictEqual((await req('POST', '/api/admin/lists', { type: 'url', name: 'P', url: `http://127.0.0.1:${pv.address().port}/list.m3u` })).status, 200);
    let it = null;
    for (let i = 0; i < 50 && !it; i++) { const cat = (await req('GET', '/api/catalog')).json; it = cat && cat.items && cat.items.find((x) => /Probe Fails Film/.test(x.n)); if (!it) await wait(200); }
    assert.ok(it, 'the film is in the catalogue');
    assert.strictEqual(it.t, 'movie');
    const ss = await req('POST', '/api/play/session', { k: it.k, mode: 'remux', seek: 5, codecs: ['h264'] });
    assert.strictEqual(ss.status, 200, ss.text);
    assert.strictEqual(filmHits, 2, 'the look inside failed, then one connection for the conversion');
    assert.strictEqual(ss.json.offset, 5, 'a film can start part-way');
    assert.strictEqual(ss.json.seg, 'ts');
    const pl = await req('GET', ss.json.url);
    assert.match(pl.text, /#EXT-X-PLAYLIST-TYPE:EVENT/, 'converted as a film, not a live stream');
    await req('DELETE', `/api/session/${ss.json.sessionId}`);
    // A player that asks (hls.js, Apple's) is told where the copy's picture really starts and counts from there: at
    // the key frame before the point — or, as here, at the film's beginning: this provider can't start part-way.
    const sk = await req('POST', '/api/play/session', { k: it.k, mode: 'remux', seek: 5, codecs: ['h264'], caps: { keyed: true, fmp4: ['av1'], maxH: { h264: 99999 }, junk: 1 } });
    assert.strictEqual(sk.status, 200, sk.text);
    assert.ok(sk.json.offset >= 0 && sk.json.offset < 1, 'from the key frame: ' + sk.json.offset);
    assert.strictEqual(sk.json.mode, 'remux');
    assert.strictEqual(sk.json.seg, 'ts');
    await req('DELETE', `/api/session/${sk.json.sessionId}`);
  } finally {
    app.kill('SIGKILL');
    pv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the chosen hardware encoder is tried once on a test picture, and one that can’t work is never used', { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwcheck-'));
  let want = 'vaapi';
  const media = new Media({ ...cfg, vaapiDevice: path.join(dir, 'no-such-renderD128') }, dir, () => ({ userAgent: 'Test', hwaccel: want }));
  try {
    await media.detect();
    media.encoders.add('h264_vaapi'); // (built in, as in the Docker image, but no device passed through)
    const c = await media.testHw();
    assert.strictEqual(c.ok, false);
    assert.match(c.why, /no graphics device/);
    assert.match(c.why, /Docker Desktop on Windows/);
    assert.strictEqual(media.hw, '', 'conversions use software straight away');
    // An encoder this ffmpeg doesn't have.
    want = 'videotoolbox'; media.encoders.delete('h264_videotoolbox');
    assert.match((await media.testHw()).why, /wasn’t built with h264_videotoolbox/);
    // One that starts and then fails (the encoder exists in the list but not really): ffmpeg's words, plus a hint.
    want = 'nvenc'; media.encoders.add('h264_nvenc');
    const n = await media.testHw();
    if (!n.ok) { assert.match(n.why, /h264_nvenc didn’t start/); assert.match(n.why, /gpus: all/); assert.strictEqual(media.hw, ''); }
    // None chosen: nothing to test.
    want = ''; assert.strictEqual(await media.testHw(), null);
  } finally { clearInterval(media._reaper); fs.rmSync(dir, { recursive: true, force: true }); }
});
