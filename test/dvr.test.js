// The DVR (lib/dvr.js, lib/routes-p12.js): recording a live stream into an MP4, carrying on when the stream drops,
// waiting for a free connection, who may record, series rules, cleaning up, and the real server's routes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const cfg = require('../lib/config');
const { Dvr } = require('../lib/dvr');

const hasFfmpeg = spawnSync(cfg.ffmpeg, ['-version']).status === 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(100); } return false; };

/** A pretend provider: /live/1.ts sends an MPEG-TS stream at about real speed; ?drop=1 cuts it after a moment. */
function provider(ts) {
  let drops = 0;
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/live/1.ts')) {
      const cut = /drop=1/.test(req.url) && drops++ === 0;
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      let p = 0;
      const step = () => {
        if (res.destroyed) return;
        if (cut && p > ts.length / 6) return res.destroy();
        if (p >= ts.length) p = 0; // round and round, like a live channel
        res.write(ts.subarray(p, p + 188 * 200)); p += 188 * 200;
        setTimeout(step, 60);
      };
      return step();
    }
    if (req.url === '/list.m3u') { res.writeHead(200); return res.end(`#EXTM3U\n#EXTINF:-1 tvg-id="c1" group-title="News",DVR News\nhttp://127.0.0.1:${srv.address().port}/live/1.ts\n`); }
    res.writeHead(404); res.end();
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}
function makeTs(dir) {
  const f = path.join(dir, 'src.ts');
  const r = spawnSync(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-f', 'mpegts', f]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  return fs.readFileSync(f);
}
const duration = (f) => Number(spawnSync(cfg.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout.toString().trim());

test('the DVR records, survives a dropped stream, waits for a connection, follows who may record, and tidies up', { skip: !hasFfmpeg && 'no ffmpeg', timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-'));
  const pv = await provider(makeTs(dir));
  let url = pv.base + '/live/1.ts';
  let free = true;
  const allowed = new Set(['p1']);
  const progs = [];
  const dvr = new Dvr(dir, {
    ffmpeg: () => ({ bin: cfg.ffmpeg, available: true, netArgs: () => [] }),
    source: (k) => (k === 'gone' ? null : { input: url, headers: {}, list: 'L', name: 'News' }),
    programmes: () => progs,
    allowed: (pid) => allowed.has(pid),
    connFree: () => free,
  }, { tick: 200 });
  dvr.setConfig({ pre: 0, post: 0 });
  try {
    // A programme on now for ~3 s: recorded, saved as MP4, playable.
    const now = Date.now();
    let r = dvr.add('p1', { k: 'c1', ch: 'News', s: now - 1000, e: now + 3000, t: 'The News' });
    assert.ok(await until(() => r.state === 'recording', 5000), r.state + ' ' + r.err);
    assert.deepStrictEqual(dvr.running().map((x) => x.id), [r.id], 'it counts as using a connection');
    assert.ok(await until(() => r.state === 'done'), r.state + ' ' + r.err);
    assert.strictEqual(path.extname(r.file), '.mp4');
    assert.ok(duration(r.file) > 1.5, 'a real recording');
    assert.deepStrictEqual(dvr.fileOf(r.id), { path: r.file });
    assert.strictEqual(dvr.running().length, 0);
    // The stream drops part way (ffmpeg reconnects by itself), and the recorder itself stops: it carries on in a
    // new piece, and the pieces are joined.
    url = pv.base + '/live/1.ts?drop=1';
    r = dvr.add('p1', { k: 'c2', s: Date.now(), e: Date.now() + 9000, t: 'Dropped' });
    assert.ok(await until(() => r.state === 'recording', 5000));
    await wait(2500);
    dvr.procs.get(r.id).proc.kill('SIGKILL');
    assert.ok(await until(() => r.state === 'done', 30000), r.state + ' ' + r.err);
    assert.ok(r.drops >= 1, 'it noticed the drop');
    assert.ok(r.parts >= 2);
    assert.ok(duration(r.file) > 2);
    assert.deepStrictEqual(fs.readdirSync(dvr.dir).filter((f) => f.startsWith(r.id)), [r.id + '.mp4'], 'only the joined file is left');
    url = pv.base + '/live/1.ts';
    // No free connection for the whole programme: it waits, then says why.
    free = false;
    r = dvr.add('p1', { k: 'c3', s: Date.now(), e: Date.now() + 1500, t: 'Busy' });
    assert.ok(await until(() => r.state === 'waiting', 3000));
    assert.ok(await until(() => r.state === 'failed', 5000));
    assert.match(r.err, /no free connection/);
    free = true;
    // A profile that may not record: its recordings don't start.
    r = dvr.add('p2', { k: 'c1', s: Date.now(), e: Date.now() + 2000, t: 'Not allowed' });
    assert.ok(await until(() => r.state === 'failed', 3000));
    assert.match(r.err, /turned off/);
    // A channel that's gone.
    r = dvr.add('p1', { k: 'gone', s: Date.now(), e: Date.now() + 2000, t: 'Gone' });
    assert.ok(await until(() => r.state === 'failed', 3000));
    // Stopping early keeps what's there; deleting a scheduled one cancels it.
    r = dvr.add('p1', { k: 'c5', s: Date.now(), e: Date.now() + 60000, t: 'Long' });
    assert.ok(await until(() => r.state === 'recording', 3000));
    await wait(1500);
    dvr.stopNow('p1', r.id);
    assert.ok(await until(() => r.state === 'done', 15000), r.state);
    const later = dvr.add('p1', { k: 'c1', s: Date.now() + 3600e3, e: Date.now() + 7200e3, t: 'Later' });
    assert.strictEqual(dvr.add('p1', { k: 'c1', s: later.s, e: later.e, t: 'Later' }), later, 'the same programme once');
    assert.throws(() => dvr.remove('p2', later.id), /Not found/, 'only its profile (or an admin)');
    dvr.remove('p1', later.id);
    assert.ok(!dvr.find(later.id));
    assert.throws(() => dvr.add('p1', { k: 'c1', s: Date.now() - 7200e3, e: Date.now() - 3600e3, t: 'Past' }), /already ended/);
    // Series: each episode once, a repeat of one already scheduled skipped, other titles ignored.
    const t0 = Date.now() + 3600e3;
    progs.push({ s: t0, e: t0 + 1800e3, t: 'Quiz Night', st: 'Round one', ep: '' }, { s: t0 + 3600e3, e: t0 + 5400e3, t: 'quiz night', st: 'Round two', ep: '' },
      { s: t0 + 7200e3, e: t0 + 9000e3, t: 'Quiz Night', st: 'Round one', ep: '' }, { s: t0 + 10800e3, e: t0 + 12600e3, t: 'Other show', st: '', ep: '' });
    const rule = dvr.addRule('p1', { k: 'c1', ch: 'News', t: 'Quiz Night' });
    let fromRule = dvr.of('p1').filter((x) => x.rule === rule.id);
    assert.deepStrictEqual(fromRule.map((x) => x.st), ['Round one', 'Round two']);
    dvr.scan();
    assert.strictEqual(dvr.of('p1').filter((x) => x.rule === rule.id).length, 2, 'scanning again adds nothing');
    dvr.removeRule('p1', rule.id);
    fromRule = dvr.of('p1').filter((x) => x.rule === rule.id);
    assert.strictEqual(fromRule.length, 0, 'its upcoming recordings go with it');
    // Cleaning up: over the size limit, the oldest goes first (one marked "keep" stays).
    const done = dvr.store.data.recs.filter((x) => x.state === 'done');
    assert.strictEqual(done.length, 3);
    dvr.setKeep('p1', done[0].id, true);
    dvr.cfg.maxGB = 1e-9 * (done[0].size + 10); // (the setting itself is whole GB)
    dvr._cleanup();
    const left = dvr.store.data.recs.filter((x) => x.state === 'done');
    assert.deepStrictEqual(left.map((x) => x.id), [done[0].id]);
    assert.ok(!fs.existsSync(done[1].file));
    // Settings are checked.
    assert.throws(() => dvr.setConfig({ access: 'sometimes' }), /Unknown/);
    assert.throws(() => dvr.setConfig({ dir: 'relative/path' }), /full path/);
  } finally { dvr.stop(); pv.srv.close(); }
});

test('the server: record now, stop, play the recording, and Admin → DVR decides who may record', { skip: !hasFfmpeg && 'no ffmpeg', timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-srv-'));
  const pv = await provider(makeTs(dir));
  const port = await freePort();
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const jar = {};
  const api = async (who, method, p, body) => {
    const h = { 'X-App': '1' };
    if (jar[who]) h.Cookie = jar[who];
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
    const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: res.status, body: j, raw: t };
  };
  try {
    for (let i = 0; i < 100 && !/Ready/.test(out); i++) await wait(100);
    await api('a', 'POST', '/api/login', { password: 'pw-test' });
    const admin = (await api('a', 'POST', '/api/profiles', { name: 'Alex', pin: '1234', avatar: 1 })).body;
    await api('a', 'POST', '/api/admin/lists', { type: 'url', name: 'TV', url: `${pv.base}/list.m3u` });
    let cat;
    for (let i = 0; i < 60; i++) { cat = (await api('a', 'GET', '/api/catalog')).body; if (cat && cat.items && cat.items.length) break; await wait(200); }
    const ch = cat.items.find((x) => x.n === 'DVR News');
    assert.ok(ch);
    // A second, standard profile on another device.
    const kid = (await api('a', 'POST', '/api/profiles', { name: 'Sam', avatar: 2 })).body;
    await api('b', 'POST', '/api/login', { password: 'pw-test' });
    const sel = await api('b', 'POST', `/api/profiles/${kid.id}/select`, {});
    assert.strictEqual(sel.status, 200, sel.raw);
    const samOk = true;
    // Everyone may record by default.
    let st = (await api('a', 'GET', '/api/dvr')).body;
    assert.strictEqual(st.can, true);
    assert.strictEqual(st.access, 'everyone');
    // Record now (no guide: an hour), then stop it after a few seconds.
    const rec = (await api('a', 'POST', '/api/dvr/now', { k: ch.k })).body;
    assert.strictEqual(rec.t, 'DVR News');
    assert.ok(await until(async () => ((await api('a', 'GET', '/api/dvr')).body.recs.find((x) => x.id === rec.id) || {}).state === 'recording', 15000));
    // Pressing it again while it records gives the same recording (not a second one on another connection).
    assert.strictEqual((await api('a', 'POST', '/api/dvr/now', { k: ch.k })).body.id, rec.id);
    await wait(3000);
    await api('a', 'POST', `/api/dvr/${rec.id}/stop`);
    let r;
    assert.ok(await until(async () => (r = (await api('a', 'GET', '/api/dvr')).body.recs.find((x) => x.id === rec.id)).state === 'done', 20000), JSON.stringify(r));
    assert.strictEqual(r.ext, 'mp4');
    // It plays like the server's own files.
    let res = await fetch(`${base}/api/local/dvr/${rec.id}`, { headers: { Cookie: jar.a, Range: 'bytes=0-99' } });
    assert.strictEqual(res.status, 206);
    assert.strictEqual(Buffer.from(await res.arrayBuffer()).length, 100);
    res = await fetch(`${base}/api/file/${encodeURIComponent('rec:' + rec.id)}`, { headers: { Cookie: jar.a, 'X-App': '1', Range: 'bytes=0-9' } });
    assert.strictEqual(res.status, 206, 'the "rec:" item resolves to its file');
    // Only priority profiles (and admins): the standard profile can't, the admin still can.
    const ad = (await api('a', 'PUT', '/api/admin/dvr', { access: 'priority' })).body;
    assert.strictEqual(ad.config.access, 'priority');
    assert.strictEqual(ad.usage.count, 1);
    if (samOk) {
      assert.strictEqual((await api('b', 'GET', '/api/dvr')).body.can, false);
      const no = await api('b', 'POST', '/api/dvr/now', { k: ch.k });
      assert.strictEqual(no.status, 403);
      assert.match(no.body.error, /priority/);
      // …and can't see or touch the admin's recordings.
      assert.strictEqual((await api('b', 'GET', '/api/dvr')).body.recs.length, 0);
      assert.strictEqual((await api('b', 'DELETE', `/api/dvr/${rec.id}`)).status, 404);
    }
    assert.strictEqual((await api('a', 'GET', '/api/dvr')).body.can, true);
    // Off for everyone.
    await api('a', 'PUT', '/api/admin/dvr', { access: 'off' });
    assert.strictEqual((await api('a', 'POST', '/api/dvr/now', { k: ch.k })).status, 403);
    // A programme from the guide (times as the device shows them), then cancelled.
    await api('a', 'PUT', '/api/admin/dvr', { access: 'everyone' });
    const t0 = Date.now() + 3600e3;
    const sch = (await api('a', 'POST', '/api/dvr/record', { k: ch.k, s: t0, e: t0 + 1800e3, t: 'Late show' })).body;
    assert.strictEqual(sch.state, 'scheduled');
    assert.strictEqual((await api('a', 'POST', '/api/dvr/record', { k: 'nope', s: t0, e: t0 + 60e3, t: 'x' })).status, 404);
    await api('a', 'DELETE', `/api/dvr/${sch.id}`);
    assert.ok(!(await api('a', 'GET', '/api/dvr')).body.recs.some((x) => x.id === sch.id));
    // Deleting the recording removes its file.
    await api('a', 'DELETE', `/api/dvr/${rec.id}`);
    assert.strictEqual((await fetch(`${base}/api/local/dvr/${rec.id}`, { headers: { Cookie: jar.a } })).status, 404);
    assert.ok(admin);
  } finally { app.kill(); pv.srv.close(); }
});
