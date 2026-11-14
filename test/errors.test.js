// Error reports (lib/errors.js): secrets removed, stacks mapped back to the source files, grouping, "fixed" coming
// back on a newer version, server errors, limits — and the real server's routes and bundle mapping.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { ErrorReports, scrub } = require('../lib/errors');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'err-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('stream logins, tokens and keys are removed', () => {
  const s = scrub('http://bob:hunter2@prov.example/live/bob/hunter2/123.ts?token=abc123&x=1 get.php?username=bob&password=pw Bearer eyJhbGciOiJIUzI1NiJ9.abc iptv_ABCDEFGHIJKLMNOPQRSTUV');
  for (const bad of ['hunter2', 'bob', 'abc123', '=pw', 'eyJhbGci', 'ABCDEFGHIJKLMNOP']) assert.ok(!s.includes(bad), `${bad} in ${s}`);
  assert.match(s, /\/live\/…\/…\/123\.ts/);
  assert.match(s, /x=1/, 'other parameters kept');
});

test('stacks point at the source file and line, with the code', () => {
  const r = new ErrorReports({ dataDir: tmp(), root: path.join(__dirname, '..') });
  // The bundle: each file as "/* name */\n" + text, joined with "\n;\n".
  const parts = [{ file: 'a.js', text: 'line a1\nline a2\n' }, { file: 'b.js', text: 'var x = 1;\nfoo.bar();\nlast' }];
  r.setBundle('v1', parts);
  const bundle = parts.map((p) => `/* ${p.file} */\n` + p.text).join('\n;\n').split('\n');
  const at = bundle.indexOf('foo.bar();') + 1;
  const m = r.mapStack(`TypeError: x\n    at Object.go (http://tv.local:8080/app.js?v=v1:${at}:5)\n    at http://tv.local:8080/app.js?v=v1:${bundle.indexOf('line a2') + 1}:1\ngo@http://tv.local/app.js?v=v1:${bundle.indexOf('last') + 1}:2`, 'v1');
  assert.deepStrictEqual(m.frames.map((f) => [f.file, f.line, f.fn]), [['web/js/b.js', 2, 'Object.go'], ['web/js/a.js', 2, '(anonymous)'], ['web/js/b.js', 3, 'go']]);
  assert.strictEqual(m.frames[0].code, 'foo.bar();');
  assert.match(m.stack, /at Object\.go \(web\/js\/b\.js:2:5\)\n\s+> foo\.bar\(\);/);
  // Server frames: relative to the app folder, with the line of code.
  const s = r.mapStack(`Error: y\n    at handle (${path.join(__dirname, '..', 'server.js')}:1:1)`, '');
  assert.strictEqual(s.frames[0].file, 'server.js');
  assert.ok(s.frames[0].code.length > 0);
});

test('reports are grouped, kept small, and come back after "fixed" on a newer version', () => {
  const dir = tmp();
  const logs = [];
  const r = new ErrorReports({ dataDir: dir, log: (m) => logs.push(m), version: '9.9' });
  r.setBundle('v1', [{ file: 'player.js', text: 'a\nb\nc' }]);
  const rep = (over = {}) => ({ kind: 'error', v: 'v1', message: 'Cannot read properties of undefined (reading \'k\') 123', stack: 'TypeError: …\n    at PP.load (http://x/app.js?v=v1:3:9)', page: '#/live', ctx: { ua: 'TV', player: { item: { n: 'News' } } }, crumbs: [{ t: 500, k: 'click', m: 'button “Play”' }], ...over });
  const a = r.add(rep(), { device: 'Living Room TV', profile: 'Mom' });
  const b = r.add(rep({ message: 'Cannot read properties of undefined (reading \'k\') 456', count: 3 }), { device: 'Phone' });
  assert.strictEqual(a.id, b.id, 'numbers don’t split an issue');
  assert.strictEqual(a.count, 4);
  assert.deepStrictEqual(a.devices, { 'Living Room TV': 1, Phone: 3 });
  assert.strictEqual(a.where, 'web/js/player.js:2 in PP.load');
  assert.strictEqual(logs.length, 1, 'only a new issue is logged');
  assert.match(logs[0], /Error report \(new\).*player\.js:2/);
  const other = r.add(rep({ stack: 'TypeError\n    at other (http://x/app.js?v=v1:1:1)' }), {});
  assert.notStrictEqual(other.id, a.id, 'a different place is a different issue');
  // Playback failures group by message and the ways tried, listing the titles.
  const p1 = r.add({ kind: 'playback', v: 'v1', message: 'The provider refused this stream (403).', extra: { item: { n: 'News' }, attempts: [{ via: 'direct' }, { via: 'relay' }] } }, {});
  const p2 = r.add({ kind: 'playback', v: 'v1', message: 'The provider refused this stream (403).', extra: { item: { n: 'Sports' }, attempts: [{ via: 'direct' }, { via: 'relay' }] } }, {});
  assert.strictEqual(p1.id, p2.id);
  assert.deepStrictEqual(p1.items, { News: 1, Sports: 1 });
  // Fixed: the same version again doesn't reopen it; a newer one does.
  r.current = 'v1';
  r.setStatus(a.id, 'fixed');
  r.add(rep(), {});
  assert.strictEqual(r.get(a.id).status, 'fixed');
  r.add(rep({ v: 'v2' }), {});
  assert.strictEqual(r.get(a.id).status, 'open');
  assert.strictEqual(r.get(a.id).reopened, 1);
  assert.match(logs[logs.length - 1], /back again/);
  // Only the last few full reports are kept, and big ones are clipped.
  for (let i = 0; i < 8; i++) r.add(rep({ message: 'x'.repeat(5000), stack: 'y'.repeat(50000), crumbs: Array(200).fill({ t: 1, k: 'k', m: 'z'.repeat(2000) }) }), {});
  const big = r.list().find((x) => x.title.startsWith('xxx'));
  const full = r.get(big.id);
  assert.strictEqual(full.samples.length, 5);
  assert.ok(JSON.stringify(full.samples[0]).length < 40000, 'clipped');
  // Server errors.
  const se = r.addServer(new Error('boom at /live/bob/secret/1.ts'), { method: 'GET', path: '/api/x', profile: 'Mom' });
  assert.strictEqual(se.kind, 'server');
  assert.ok(!JSON.stringify(se).includes('secret'));
  // The text version has what's needed.
  const t = r.text([r.get(a.id)]);
  assert.match(t, /web\/js\/player\.js:2/);
  assert.match(t, /Living Room TV/);
  assert.match(t, /click: button “Play”/);
  // Off: nothing is kept.
  r.on = false;
  assert.strictEqual(r.add(rep({ message: 'new while off' }), {}), null);
  // Rate limit per address.
  r.on = true;
  let ok = 0; for (let i = 0; i < 60; i++) if (r.allowed('1.2.3.4')) ok++;
  assert.strictEqual(ok, 40);
  assert.ok(r.allowed('5.6.7.8'));
});

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

test('the real server: devices report, the admin sees them mapped to web/js, server errors are kept', { timeout: 60000 }, async () => {
  const port = await freePort();
  const dir = tmp();
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const req = async (method, p, body, headers = {}) => {
    const h = { 'X-App': '1', ...headers };
    if (cookie) h.Cookie = cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, text: t };
  };
  try {
    for (let i = 0; i < 300 && !/Ready/.test(out); i++) await wait(100);
    assert.strictEqual((await req('POST', '/api/client-errors', { reports: [] })).status, 401, 'signed-in devices only');
    await req('POST', '/api/login', { password: 'pw-test' });
    // Before a profile is chosen (the profile picker) reports are still taken.
    const page = await req('GET', '/');
    const v = /app\.js\?v=([\w-]+)/.exec(page.text)[1];
    const js = (await req('GET', '/app.js')).text.split('\n');
    const line = js.findIndex((l) => l.includes('PP._fatal = function')) + 1;
    assert.ok(line > 0);
    const r1 = await req('POST', '/api/client-errors', { reports: [{ kind: 'error', v, message: 'TypeError: test', stack: `TypeError: test\n    at PP._fatal (${base}/app.js?v=${v}:${line + 1}:10)`, page: '#/live', ctx: { ua: 'x' }, crumbs: [] }] });
    assert.deepStrictEqual(r1.json, { ok: true, n: 1 });
    const prof = await req('POST', '/api/profiles', { name: 'Alex', avatar: 1, pin: '1234' });
    assert.strictEqual(prof.status, 200, JSON.stringify(prof.json));
    const list = await req('GET', '/api/admin/errors');
    assert.ok(list.json && list.json.issues, JSON.stringify(list));
    assert.strictEqual(list.json.issues.length, 1);
    const is = list.json.issues[0];
    assert.match(is.where, /^web\/js\/player\.js:\d+ in PP\._fatal$/);
    const one = await req('GET', `/api/admin/errors/${is.id}`);
    assert.match(one.json.samples[0].stack, /web\/js\/player\.js:\d+:10\)\n\s+> /, 'the line of code is shown');
    assert.match(one.json.text, /TypeError: test/);
    const txt = await req('GET', '/api/admin/errors-report.txt');
    assert.match(txt.text, /player\.js/);
    assert.strictEqual((await req('PUT', `/api/admin/errors/${is.id}`, { status: 'fixed' })).json.status, 'fixed');
    const adm = await req('GET', '/api/admin');
    assert.strictEqual(adm.json.status.errors.open, 0);
    // Too big a body is refused; the setting turns collecting off.
    const huge = await req('POST', '/api/client-errors', { reports: [{ message: 'x'.repeat(300 * 1024) }] }).catch(() => ({ status: 413 })); // (the server may just hang up)
    assert.strictEqual(huge.status, 413);
    await req('PUT', '/api/admin/errors-settings', { on: false });
    assert.strictEqual((await req('POST', '/api/client-errors', { reports: [{ kind: 'error', message: 'while off' }] })).json.off, true);
    await req('PUT', '/api/admin/errors-settings', { on: true });
    for (let i = 0; i < 40 && !fs.existsSync(path.join(dir, 'error-reports.txt')); i++) await wait(100);
    assert.match(fs.readFileSync(path.join(dir, 'error-reports.txt'), 'utf8'), /Error reports/);
    assert.match(out, /Error report \(new\): Error — TypeError: test — at web\/js\/player\.js/);
  } finally { app.kill(); }
});
