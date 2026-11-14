// Starting to play, quicker and sturdier: a server conversion starts straight away when the provider has said what
// the video is (the look inside runs alongside, and the conversion starts again if it finds something else), and an
// episode a device is still playing after the server restarted is read again from its series instead of being "not
// available".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
let ffmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { ffmpeg = false; }

test('quick start, and episodes read again after a restart', { timeout: 90000, skip: !ffmpeg && 'needs ffmpeg' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-'));
  const media = path.join(dir, 'ep.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine', '-t', '12', '-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', media]);
  const data = {
    '': { user_info: { auth: 1, status: 'Active', exp_date: '0', max_connections: '0' }, server_info: { timezone: 'UTC' } },
    get_series_categories: [{ category_id: '3', category_name: 'Series' }],
    get_series: [{ series_id: 20, name: 'Harbor Lights', category_id: '3' }],
    get_series_info: { info: { plot: 'p' }, episodes: { 1: [
      { id: 200, episode_num: 1, season: 1, title: 'Pilot', container_extension: 'mp4', info: { duration_secs: 12, video: { codec_name: 'h264', pix_fmt: 'yuv420p' }, audio: { codec_name: 'aac' } } },
      // (The provider gets this one wrong: it says HEVC. The look inside finds H.264, and the conversion starts again.)
      { id: 201, episode_num: 2, season: 1, title: 'Second', container_extension: 'mp4', info: { duration_secs: 12, video: { codec_name: 'hevc' }, audio: { codec_name: 'aac' } } },
    ] } },
  };
  const panel = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/player_api.php') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(data[u.searchParams.get('action') || ''] || [])); }
    if (/^\/series\/u\/p\/20[01]\.mp4$/.test(u.pathname)) {
      const size = fs.statSync(media).size;
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      const a = m ? +m[1] : 0, z = m && m[2] ? +m[2] : size - 1;
      res.writeHead(m ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': z - a + 1, ...(m ? { 'Content-Range': `bytes ${a}-${z}/${size}` } : {}) });
      return fs.createReadStream(media, { start: a, end: z }).pipe(res);
    }
    res.writeHead(404); res.end();
  }).listen(0, '127.0.0.1');
  await new Promise((r) => panel.once('listening', r));
  const port = await freePort();
  let app, out = '', cookie = '';
  const boot = async () => {
    out = '';
    app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    app.stdout.on('data', (d) => { out += d; });
    app.stderr.on('data', (d) => { out += d; });
    for (let i = 0; i < 300 && !/Ready/.test(out); i++) await wait(100);
    assert.match(out, /Ready/, out);
  };
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-App': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie(); if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, body: j };
  };
  try {
    await boot();
    await api('POST', '/api/login', { password: 'pw-test' });
    const me = (await api('POST', '/api/profiles', { name: 'Alex', avatar: 1, pin: '1234' })).body;
    await api('POST', '/api/admin/lists', { type: 'xtream', name: 'X', server: `http://127.0.0.1:${panel.address().port}`, username: 'u', password: 'p' });
    let show;
    for (let i = 0; i < 150 && !show; i++) { const cat = (await api('GET', '/api/catalog')).body; show = cat && cat.items && cat.items.find((x) => x.t === 'show'); if (!show) await wait(100); }
    assert.ok(show, 'the series is listed');
    const eps = (await api('GET', `/api/show/${show.k}/episodes`)).body.episodes || (await api('GET', `/api/show/${show.k}/episodes`)).body;
    const list = Array.isArray(eps) ? eps : eps.episodes;
    const e1 = list.find((x) => x.e === 1), e2 = list.find((x) => x.e === 2);
    assert.ok(e1 && e2, JSON.stringify(list));

    // Known format, room for two connections: straight away — remux, with the look inside's details in the answer.
    let s = await api('POST', '/api/play/session', { k: e1.k, codecs: ['h264'], mode: 'remux', sign: true });
    assert.strictEqual(s.status, 200, JSON.stringify(s.body) + out);
    assert.strictEqual(s.body.quick, true);
    assert.strictEqual(s.body.mode, 'remux');
    assert.ok(s.body.duration > 11 && s.body.duration < 13, 'the length, from the look inside');
    assert.match(s.body.signed, /^\/c\/[^/]+\/api\/session\/[0-9a-f]+\/index\.m3u8$/, 'signed in the same answer');
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}${s.body.signed}`)).status, 200, 'which opens without signing in');
    await api('DELETE', `/api/session/${s.body.sessionId}`);
    // Wrong details from the provider: started as a conversion, then again as a remux once the look inside answered.
    s = await api('POST', '/api/play/session', { k: e2.k, codecs: ['h264'], mode: 'remux' });
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    assert.strictEqual(s.body.mode, 'remux');
    assert.match(out, /needs no converting — starting again/);
    await api('DELETE', `/api/session/${s.body.sessionId}`);

    // The copy order also says how this device reaches the copy that goes first (one trip fewer before playing).
    const so = await api('POST', '/api/play/sources', { k: e1.k, origin: `http://127.0.0.1:${port}`, reach: { ua: 'Mozilla/5.0 Chrome/141' } });
    assert.strictEqual(so.status, 200, JSON.stringify(so.body));
    assert.ok(so.body.reach && so.body.reach.alt === so.body.sources[0].alt && so.body.reach.info.kind, JSON.stringify(so.body.reach));
    assert.strictEqual((await api('POST', '/api/play/sources', { k: e1.k })).body.reach, null, 'only when asked');
    // A screenshot of a stream the page can't copy: the server takes that moment, full size, as a PNG.
    const shot = await fetch(`http://127.0.0.1:${port}/api/frame/${e1.k}?shot=1&t=3.5&alt=-1`, { headers: { Cookie: cookie, 'X-App': '1' } });
    assert.strictEqual(shot.status, 200);
    const png = Buffer.from(await shot.arrayBuffer());
    assert.strictEqual(png.slice(1, 4).toString(), 'PNG');
    assert.strictEqual(png.readUInt32BE(16), 320, 'full width');

    // A copy on a very slow provider goes after the others next time (the 30–60 second starts came from a slow copy
    // being tried first). A second list with the same series: each episode then has a backup copy.
    await api('POST', '/api/admin/lists', { type: 'xtream', name: 'Y', server: `http://localhost:${panel.address().port}`, username: 'u', password: 'p' });
    let two = null;
    for (let i = 0; i < 100 && !two; i++) { const r = (await api('GET', `/api/show/${show.k}/episodes`)).body; const l = Array.isArray(r) ? r : (r && r.episodes) || []; const x = l.find((e) => e.e === 1); if (x && x.a && x.a.length) two = x; else await wait(150); }
    assert.ok(two, 'the episode has a backup copy');
    const firstAlt = (await api('POST', '/api/play/sources', { k: two.k })).body.sources[0].alt;
    // (That copy took 20 seconds to start, straight from its provider.)
    await api('POST', '/api/stats/play', { k: two.k, alt: firstAlt, route: 'native', reason: '', ms: 20000 });
    const after = (await api('POST', '/api/play/sources', { k: two.k })).body.sources.map((x) => x.alt);
    assert.notStrictEqual(after[0], firstAlt, 'the slow copy is no longer first: ' + JSON.stringify(after));
    assert.strictEqual(after[after.length - 1], firstAlt);
    // The copy now first is given up on by a player (nothing after 9 seconds, another copy answering quickly): it goes
    // last too, though a look at its provider would find it answering — until one of its videos starts quickly.
    const other = after[0];
    await api('POST', '/api/stats/play', { k: two.k, alt: firstAlt, route: 'native', reason: '', ms: 900 });
    await api('POST', '/api/stats/play', { k: two.k, alt: firstAlt, route: 'native', reason: '', ms: 900 });
    await api('POST', '/api/stats/play', { k: two.k, alt: firstAlt, route: 'native', reason: '', ms: 900 });
    await api('POST', '/api/stats/play', { k: two.k, alt: firstAlt, route: 'native', reason: '', ms: 900 });
    await api('POST', '/api/stats/play', { k: two.k, alt: other, failed: true, backup: true, msg: 'This copy was slow to start.' });
    let now = (await api('POST', '/api/play/sources', { k: two.k })).body.sources.map((x) => x.alt);
    assert.strictEqual(now[now.length - 1], other, 'given up on as slow: last ' + JSON.stringify(now));
    await api('POST', '/api/stats/play', { k: two.k, alt: other, route: 'convert', reason: '', ms: 3000 });
    now = (await api('POST', '/api/play/sources', { k: two.k })).body.sources.map((x) => x.alt);
    await api('POST', '/api/stats/play', { k: two.k, alt: firstAlt, failed: true, backup: true, msg: 'This copy was slow to start.' });
    now = (await api('POST', '/api/play/sources', { k: two.k })).body.sources.map((x) => x.alt);
    assert.strictEqual(now[0], other, 'started quickly since: no longer held back ' + JSON.stringify(now));

    // A converted start says where its time went, and Admin's statistics add it up.
    await api('POST', '/api/stats/play', { k: two.k, alt: now[0], route: 'convert', reason: 'format', ms: 7000, ph: { pre: 500, look: 2000, conv: 3000, net: 100, play: 1400, junk: 9e9 } });
    const sum = (await api('GET', '/api/admin/stats?days=1')).body;
    const stt = (sum.total || sum).start || {};
    assert.strictEqual(stt.cn, 1, JSON.stringify(stt));
    assert.deepStrictEqual([stt.c_pre, stt.c_look, stt.c_conv, stt.c_net, stt.c_play], [500, 2000, 3000, 100, 1400]);

    // A head start: the look inside is done when the title's page opens (once; then it's kept), within the account's
    // connections, and only for something this profile can see.
    const w1 = (await api('POST', '/api/play/warm', { k: two.k, alt: now[0] })).body;
    assert.ok(w1.ok === true || w1.why === 'off', JSON.stringify(w1));
    const w2 = (await api('POST', '/api/play/warm', { k: two.k, alt: now[0] })).body;
    assert.ok(w2.cached || w2.why === 'soon' || w2.why === 'off', JSON.stringify(w2));
    assert.strictEqual((await api('POST', '/api/play/warm', { k: 'nope' })).status, 404);

    // A restart: the server no longer knows the episode until its series is read again.
    app.kill(); await new Promise((r) => app.once('exit', r));
    await boot();
    await api('POST', `/api/profiles/${me.id}/select`, { pin: '1234' });
    assert.strictEqual((await api('POST', '/api/play/relay', { k: e1.k })).status, 404, 'unknown without its series');
    const r = await api('POST', '/api/play/relay', { k: e1.k, sk: show.k });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.url, /^\/api\/proxy\?/);
    // (A series key that isn't a series, or one this profile can't see, reads nothing.)
    assert.strictEqual((await api('POST', '/api/play/relay', { k: 'nope', sk: e1.k })).status, 404);
  } finally {
    if (app) app.kill();
    panel.close();
  }
});
