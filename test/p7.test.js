// The play queue (lib/playqueue.js, lib/routes-p7.js), viewers' own problem reports (lib/errors.js, kind "user")
// and the clear dialogue / night mode settings saved per profile.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const { apply, MAX } = require('../lib/playqueue');
const { ErrorReports, KINDS, scrubNote } = require('../lib/errors');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p7-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const keys = (q) => q.map((x) => x.k);

test('queue changes: add, play next, move, remove, played, clear', () => {
  let q = [];
  q = apply(q, { op: 'add', item: { k: 'm1', t: 'movie', n: 'One' } });
  q = apply(q, { op: 'add', item: { k: 'e1', t: 'episode', n: 'Show S1:E1', sk: 's1' } });
  q = apply(q, { op: 'next', item: { k: 'm2', t: 'movie', n: 'Two' } });
  assert.deepStrictEqual(keys(q), ['m2', 'm1', 'e1']);
  assert.strictEqual(q[2].sk, 's1');
  // Adding again moves it, it isn't there twice.
  q = apply(q, { op: 'add', item: { k: 'm2', t: 'movie' } });
  assert.deepStrictEqual(keys(q), ['m1', 'e1', 'm2']);
  q = apply(q, { op: 'move', k: 'm2', by: -1 });
  assert.deepStrictEqual(keys(q), ['m1', 'm2', 'e1']);
  q = apply(q, { op: 'move', k: 'm1', to: 99 });
  assert.deepStrictEqual(keys(q), ['m2', 'e1', 'm1']);
  q = apply(q, { op: 'move', k: 'm1', by: -10 });
  assert.deepStrictEqual(keys(q), ['m1', 'm2', 'e1']);
  // A queued series leaves the queue when one of its episodes starts.
  q = apply(q, { op: 'add', item: { k: 's2', t: 'show', n: 'Series' } });
  q = apply(q, { op: 'played', k: 's2e5', sk: 's2' });
  assert.deepStrictEqual(keys(q), ['m1', 'm2', 'e1']);
  q = apply(q, { op: 'played', k: 'm2' });
  q = apply(q, { op: 'remove', k: 'e1' });
  assert.deepStrictEqual(keys(q), ['m1']);
  assert.deepStrictEqual(apply(q, { op: 'clear' }), []);
  // Bad input.
  assert.throws(() => apply(q, { op: 'add', item: {} }), /Nothing to add/);
  assert.throws(() => apply(q, { op: 'nope' }), /Unknown/);
  assert.strictEqual(apply(q, { op: 'add', item: { k: 'x', t: 'live' } })[1].t, 'movie', 'only films, series and episodes');
  let big = [];
  for (let i = 0; i < MAX; i++) big = apply(big, { op: 'add', item: { k: 'k' + i } });
  assert.throws(() => apply(big, { op: 'add', item: { k: 'one-more' } }), /full/);
  assert.strictEqual(apply(big, { op: 'add', item: { k: 'k5' } }).length, MAX, 'moving one that is there is fine');
});

test('viewer reports: one issue each, never dropped as repeats, kept when collecting is off, limited per device', () => {
  const r = new ErrorReports({ dataDir: tmp(), version: '1' });
  assert.strictEqual(KINDS.user, 'Reported by a viewer');
  const rep = (note) => ({ kind: 'user', v: 'v1', message: 'Won’t play — News', ctx: { ua: 'TV' }, crumbs: [{ t: 10, k: 'click', m: 'Report a problem' }], extra: { choice: 'play', choiceLabel: 'Won’t play', note, item: { n: 'News' }, attempts: [{ via: 'direct', msg: 'refused' }] } });
  const a = r.add(rep('Stops after a minute'), { device: 'TV', profile: 'Mum', ip: '1.1.1.1' });
  const b = r.add(rep('Stops after a minute'), { device: 'TV', profile: 'Mum', ip: '1.1.1.1' });
  assert.notStrictEqual(a.id, b.id, 'the same report twice is two issues');
  assert.strictEqual(a.note, 'Stops after a minute');
  assert.strictEqual(a.choice, 'Won’t play');
  assert.deepStrictEqual(a.items, { News: 1 });
  const t = r.text([r.get(a.id)]);
  assert.match(t, /Reported by a viewer: Won’t play — News/);
  assert.match(t, /Viewer’s note: Stops after a minute/);
  assert.match(t, /"via": "direct"/, 'the ways it tried are in the text');
  // Off: automatic reports are dropped, a viewer's own isn't.
  r.on = false;
  assert.strictEqual(r.add({ kind: 'error', message: 'x' }, {}), null);
  assert.ok(r.add(rep('while off'), { ip: '2.2.2.2' }));
  r.on = true;
  // At most 12 an hour from one device and profile.
  let n = 0;
  for (let i = 0; i < 20; i++) if (r.add(rep('n' + i), { ip: '3.3.3.3', profile: 'Kid' })) n++;
  assert.strictEqual(n, 12);
  assert.ok(r.add(rep('another profile'), { ip: '3.3.3.3', profile: 'Dad' }));
  // Passwords in a note are removed like everywhere else.
  const s = r.add(rep('see http://bob:hunter2@x.example/live/bob/hunter2/1.ts'), { ip: '4.4.4.4' });
  assert.ok(!JSON.stringify(s).includes('hunter2'));
});

test('PINs, codes and passwords are taken out of a viewer’s note', () => {
  const cases = {
    'my PIN is 4321, then it stops': 'my PIN is … then it stops',
    'PIN: 1234': 'PIN: …',
    'pin code is 5555': 'pin code is …',
    'the password is hunter2 lol': 'the password is … lol',
    'Password: s3cr3t!': 'Password: …',
    'passcode 778899': 'passcode …',
    'code: 12345': 'code: …',
    'my pw=abc': 'my pw=…',
    // Not secrets: left alone.
    'error code 403 shows': 'error code 403 shows',
    'it asks for the password again': 'it asks for the password again',
    'stops after 10 minutes': 'stops after 10 minutes',
  };
  for (const [a, b] of Object.entries(cases)) assert.strictEqual(scrubNote(a), b, a);
  const r = new ErrorReports({ dataDir: tmp(), version: '1' });
  const is = r.add({ kind: 'user', v: 'v1', message: 'Won’t play — News', extra: { choice: 'play', choiceLabel: 'Won’t play', note: 'Kids profile, my PIN is 4321' } }, { ip: '9.9.9.9' });
  assert.strictEqual(is.note, 'Kids profile, my PIN is …');
  assert.ok(!r.text([r.get(is.id)]).includes('4321'));
  assert.ok(!JSON.stringify(r.list()).includes('4321'));
});

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

test('the real server: the queue syncs between devices, sound settings are kept, viewer reports arrive', { timeout: 60000 }, async () => {
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
    return { status: r.status, json: j };
  };
  let events = null;
  try {
    for (let i = 0; i < 100 && !/Ready/.test(out); i++) await wait(100);
    assert.match(out, /Ready/, out);
    await req('POST', '/api/login', { password: 'pw-test' });
    assert.strictEqual((await req('POST', '/api/profiles', { name: 'Alex', avatar: 1, pin: '1234' })).status, 200);
    assert.strictEqual((await req('GET', '/api/queue')).json.queue.length, 0);

    // Another device of the same profile hears about changes.
    events = await new Promise((ok) => { http.get(`${base}/api/events?name=Phone`, { headers: { Cookie: cookie } }, ok); });
    let sse = '';
    events.on('data', (d) => { sse += d; });
    for (let i = 0; i < 50 && !/"conn"/.test(sse); i++) await wait(50);
    const conn = JSON.parse(/data: (\{"conn".*\})/.exec(sse)[1]).conn;

    let r = await req('POST', '/api/queue', { op: 'add', item: { k: 'film-a', t: 'movie', n: 'Film A' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    await req('POST', '/api/queue', { op: 'add', item: { k: 'ep-1', t: 'episode', n: 'Show S1:E1', sk: 'show-1' } });
    r = await req('POST', '/api/queue', { op: 'next', item: { k: 'film-b', t: 'movie', n: 'Film B' } });
    assert.deepStrictEqual(keys(r.json.queue), ['film-b', 'film-a', 'ep-1']);
    const told = () => (sse.match(/"field":"queue"/g) || []).length;
    for (let i = 0; i < 60 && told() < 3; i++) await wait(50);
    assert.match(sse, /event: data\ndata: \{"field":"queue"\}/, 'other devices are told');
    // The device that made the change isn't told about its own change.
    const before = told();
    assert.strictEqual(before, 3, 'one for each change');
    await req('POST', '/api/queue', { op: 'move', k: 'ep-1', by: -1 }, { 'X-Conn': conn });
    await wait(300);
    assert.strictEqual(told(), before);
    // It's in the profile's data (what every device loads), in order.
    const me = await req('GET', '/api/me');
    assert.deepStrictEqual(keys(me.json.data.queue), ['film-b', 'ep-1', 'film-a']);
    r = await req('POST', '/api/queue', { op: 'played', k: 'film-b' });
    assert.deepStrictEqual(keys(r.json.queue), ['ep-1', 'film-a']);
    assert.strictEqual((await req('POST', '/api/queue', { op: 'bogus' })).status, 400);
    r = await req('POST', '/api/queue', { op: 'clear' });
    assert.deepStrictEqual(r.json.queue, []);

    // Clear dialogue and night mode are profile settings.
    const pr = await req('PUT', '/api/me/prefs', { clearDialogue: true, nightMode: true });
    assert.strictEqual(pr.json.clearDialogue, true);
    assert.strictEqual(pr.json.nightMode, true);
    assert.strictEqual((await req('GET', '/api/me')).json.data.prefs.nightMode, true);

    // A viewer's report goes in even with automatic reports off, and twice is twice.
    await req('PUT', '/api/admin/errors-settings', { on: false });
    const rep = { kind: 'user', v: 'x', message: 'No sound — Film A', ctx: {}, crumbs: [], extra: { choice: 'sound', choiceLabel: 'No sound', note: 'Silent from the start' } };
    assert.deepStrictEqual((await req('POST', '/api/client-errors', { reports: [rep, { kind: 'error', message: 'auto' }] })).json, { ok: true, n: 1 });
    assert.deepStrictEqual((await req('POST', '/api/client-errors', { reports: [rep] })).json, { ok: true, n: 1 });
    const list = (await req('GET', '/api/admin/errors')).json;
    const mine = list.issues.filter((x) => x.kind === 'user');
    assert.strictEqual(mine.length, 2);
    assert.strictEqual(mine[0].note, 'Silent from the start');
    assert.strictEqual(mine[0].label, 'Reported by a viewer');
    assert.ok(!list.issues.some((x) => x.title === 'auto'));
    const one = (await req('GET', `/api/admin/errors/${mine[0].id}`)).json;
    assert.match(one.text, /Viewer’s note: Silent from the start/);
  } finally { if (events) events.destroy(); app.kill(); }
});
