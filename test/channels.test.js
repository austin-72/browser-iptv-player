// Admin channel edits, guide offsets and matching, parental locks (enforced by the server), "On later".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Catalog } = require('../lib/catalog');
const { Overrides } = require('../lib/overrides');
const { Epg } = require('../lib/epg');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-ch-'));
const chan = (name, extra) => ({ name, type: 'live', url: `http://p/${encodeURIComponent(name)}.m3u8`, group: 'UK | News', lang: 'en', tvgId: extra && extra.tvgId || '', ...extra });

function catalog(items, ov, epg) {
  const ls = { all: () => [{ id: 'A', name: 'A', enabled: true, type: 'url' }], parsed: new Map([['A', { items, epgUrls: [] }]]) };
  const c = new Catalog({ lists: ls, epg: epg || { has: () => false, resolve: () => null }, getSettings: () => ({ tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [] }) });
  c.overrides = ov;
  c.build();
  return c;
}

test('channel edits survive a rebuild; hidden channels stay out; reset goes back', () => {
  const dir = tmp();
  const ov = new Overrides(dir);
  const items = [chan('BBC One', { chno: '1' }), chan('BBC Two', { chno: '2' }), chan('ITV1', { chno: '3' })];
  let c = catalog(items, ov);
  const one = c.items.find((i) => i.n === 'BBC One');
  const two = c.items.find((i) => i.n === 'BBC Two');
  ov.set(one.k, { n: 'BBC One HD', num: 101, g: 'Favourite UK', logo: 'https://x/logo.png' }, { n0: one.n, t: 'live' });
  ov.set(two.k, { hide: true }, { n0: two.n, t: 'live' });
  c = catalog(items, ov); // the next refresh of the lists
  const one2 = c.get(one.k);
  assert.strictEqual(one2.n, 'BBC One HD');
  assert.strictEqual(one2.num, 101);
  assert.strictEqual(one2.g, 'Favourite UK');
  assert.strictEqual(Catalog.compact(one2).i, 'https://x/logo.png');
  assert.strictEqual(c.get(two.k), null, 'hidden');
  assert.strictEqual(ov.get(two.k).n0, 'BBC Two', 'the original name is remembered for the editor');
  ov.reset(one.k);
  Overrides.restore(one2);
  assert.strictEqual(one2.n, 'BBC One');
  ov.file.flush();
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'channels.json'), 'utf8')).ch[two.k].hide);
});

test('an edit made under a channel’s old key follows it to the new key', () => {
  const ov = new Overrides(tmp());
  ov.set('oldkey', { n: 'Renamed' }, { n0: 'X', t: 'live' });
  const it = { k: 'newkey', t: 'live', n: 'X', g: 'G' };
  const out = ov.apply([it], new Map([['oldkey', 'newkey']]));
  assert.strictEqual(out[0].n, 'Renamed');
  assert.ok(ov.get('newkey') && !ov.get('oldkey'));
});

test('a sort place and a guide offset reach devices; the guide channel can be picked by hand', () => {
  const ov = new Overrides(tmp());
  const epg = { has: (id) => id === 'picked.uk' || id === 'auto.uk', resolve: ({ epgOverride, tvgId }) => epgOverride || (tvgId === 'auto.uk' ? 'auto.uk' : null) };
  const items = [chan('Sky News', { tvgId: 'auto.uk', shift: 1 })];
  let c = catalog(items, ov, epg);
  const k = c.items[0].k;
  assert.strictEqual(c.items[0].epg, 'auto.uk');
  ov.set(k, { eo: 'picked.uk', off: -1.5, so: 7.5 }, { n0: 'Sky News', t: 'live' });
  c = catalog(items, ov, epg);
  const o = Catalog.compact(c.get(k));
  assert.strictEqual(c.get(k).epg, 'picked.uk');
  assert.strictEqual(o.sh, -0.5, 'the playlist’s tvg-shift (+1) and the admin’s offset (−1.5) add up');
  assert.strictEqual(o.so, 7.5);
});

test('guide offsets shift a whole guide (in memory only) and can be changed later', async () => {
  const dir = tmp();
  const h = 3600e3;
  const data = { channels: { 'a.uk': { names: ['A'] } }, programmes: { 'a.uk': [{ s: 10 * h, e: 11 * h, t: 'News' }] } };
  let e = new Epg(dir, { offsets: { g1: 2 } });
  e.setSource('g1', data);
  assert.deepStrictEqual(e.range('a.uk', 0, 99 * h).map((p) => p.s / h), [12]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'g1.json'), 'utf8')).programmes['a.uk'][0].s, 10 * h, 'the file keeps the guide’s own times');
  await e.setOffsets({ g1: -1 });
  assert.deepStrictEqual(e.range('a.uk', 0, 99 * h).map((p) => p.s / h), [9]);
  e.useOnly(['a.uk']);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(e.range('a.uk', 0, 99 * h).map((p) => p.s / h), [9], 'dropping unused channels doesn’t shift it again');
  e = new Epg(dir, { offsets: { g1: 0.5 } }); // after a restart
  assert.deepStrictEqual(e.range('a.uk', 0, 99 * h).map((p) => p.s / h), [10.5]);
});

test('parental PIN: locks, wrong guesses, kids profiles', () => {
  const ov = new Overrides(tmp());
  ov.setLocks({ groups: ['Adults'], keys: ['k2'] });
  assert.ok(ov.isLocked({ k: 'x', g: 'adults' }));
  assert.ok(ov.isLocked({ k: 'k2', g: 'News' }));
  assert.ok(!ov.isLocked({ k: 'k3', g: 'News' }));
  assert.ok(ov.isLocked({ k: 'e1', g: 'Shows', sk: 's1' }, (k) => (k === 's1' ? { k: 's1', g: 'Adults' } : null)), 'an episode follows its series');
  assert.throws(() => ov.unlock('s', {}, '1234'), /No parental PIN/);
  ov.setPin('2468');
  assert.throws(() => ov.unlock('s', { kids: true }, '2468'), /Kids profiles/);
  for (let i = 0; i < 4; i++) assert.throws(() => ov.unlock('s', {}, '0000'), /isn’t right/);
  assert.throws(() => ov.unlock('s', {}, '0000'), /isn’t right/);
  assert.throws(() => ov.unlock('s', {}, '2468'), /Too many/);
  assert.ok(ov.unlock('t', {}, '2468') > Date.now());
  assert.ok(ov.allowed({ profile: {}, sess: { id: 't' } }));
  assert.ok(!ov.allowed({ profile: { kids: true }, sess: { id: 't' } }));
  assert.ok(!ov.allowed({ profile: {}, sess: { id: 's' } }));
});

// ---- the real server: locks are enforced there, not just hidden in the app
function startServer(dir, port, pl) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, DATA_DIR: dir, PORT: String(port), SITE_PASSWORD: 'pw', NO_RESPAWN: '1', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return { child, log: () => log, pl };
}
function client(port) {
  let cookie = '';
  return (method, p, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'X-App': '1', 'Content-Type': 'application/json', Cookie: cookie, ...(data ? { 'Content-Length': data.length } : {}), 'Accept-Encoding': 'identity' } }, (res) => {
      const sc = res.headers['set-cookie'];
      if (sc) cookie = sc.map((c) => c.split(';')[0]).join('; ');
      const ch = [];
      res.on('data', (c) => ch.push(c));
      res.on('end', () => { const t = Buffer.concat(ch).toString(); let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, body: j, text: t }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the server enforces locks and applies channel edits', { timeout: 60000 }, async () => {
  const m3u = '#EXTM3U\n#EXTINF:-1 tvg-id="n.uk" group-title="News",Daily News\nhttp://127.0.0.1:1/news.m3u8\n#EXTINF:-1 group-title="Late Night",After Dark\nhttp://127.0.0.1:1/late.m3u8\n#EXTINF:-1 group-title="News",World Desk\nhttp://127.0.0.1:1/world.m3u8\n';
  const pl = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); r.end(m3u); }).listen(0, '127.0.0.1');
  await new Promise((r) => pl.once('listening', r));
  const dir = tmp();
  const port = 8229;
  const srv = startServer(dir, port);
  try {
    const api = client(port);
    for (let i = 0; i < 100; i++) { try { const r = await api('GET', '/api/boot'); if (r.status) break; } catch {} await wait(100); }
    assert.strictEqual((await api('POST', '/api/login', { password: 'pw' })).status, 200);
    const admin = (await api('POST', '/api/profiles', { name: 'Alex', avatar: 1, pin: '1234' })).body;
    assert.ok(admin.admin);
    const added = await api('POST', '/api/admin/lists', { type: 'url', name: 'Test', url: `http://127.0.0.1:${pl.address().port}/list.m3u` });
    assert.strictEqual(added.status, 200, added.text);
    let cat;
    for (let i = 0; i < 50; i++) { cat = (await api('GET', '/api/catalog')).body; if (cat && cat.items && cat.items.length === 3) break; await wait(200); }
    const late = cat.items.find((x) => x.n === 'After Dark');
    const news = cat.items.find((x) => x.n === 'Daily News');
    assert.ok(late.u, 'not locked yet: it has its address');

    // Lock "Late Night" and set the PIN.
    assert.strictEqual((await api('PUT', '/api/admin/parental-pin', { pin: '2468' })).status, 200);
    assert.strictEqual((await api('POST', '/api/admin/locks/toggle', { kind: 'group', value: 'Late Night', on: true })).status, 200);
    cat = (await api('GET', '/api/catalog')).body;
    const late2 = cat.items.find((x) => x.k === late.k);
    assert.ok(late2.lk && !late2.u && !late2.a, 'locked: sent without its address');
    assert.ok(cat.items.find((x) => x.k === news.k).u, 'others unaffected');
    const blocked = await api('POST', '/api/play/sources', { k: late.k, origin: 'http://x' });
    assert.strictEqual(blocked.status, 423);
    assert.strictEqual((await api('GET', `/api/parental/items?keys=${late.k}`)).status, 423);
    assert.strictEqual((await api('POST', '/api/parental/unlock', { pin: '1111' })).status, 403);
    const un = await api('POST', '/api/parental/unlock', { pin: '2468' });
    assert.strictEqual(un.status, 200);
    assert.strictEqual((await api('POST', '/api/play/sources', { k: late.k, origin: 'http://x' })).status, 200);
    const got = (await api('GET', `/api/parental/items?keys=${late.k}`)).body;
    assert.ok(got.items[0].u.endsWith('late.m3u8'));
    await api('POST', '/api/parental/lock');
    assert.strictEqual((await api('POST', '/api/play/sources', { k: late.k, origin: 'http://x' })).status, 423, 'locked again');

    // A kids profile can't unlock.
    const kid = (await api('POST', '/api/profiles', { name: 'Kid', avatar: 2, kids: true })).body;
    await api('POST', `/api/profiles/${kid.id}/select`, {});
    assert.strictEqual((await api('POST', '/api/parental/unlock', { pin: '2468' })).status, 403);
    await api('POST', `/api/profiles/${admin.id}/select`, { pin: '1234' });

    // Channel edits: rename, number, move; hide; reset brings it back.
    const ed = await api('PUT', `/api/admin/channels/${encodeURIComponent(news.k)}`, { n: 'News 24', num: 50, g: 'My News' });
    assert.strictEqual(ed.status, 200, ed.text);
    cat = (await api('GET', '/api/catalog')).body;
    const n2 = cat.items.find((x) => x.k === news.k);
    assert.deepStrictEqual([n2.n, n2.no, n2.g], ['News 24', 50, 'My News']);
    const world = cat.items.find((x) => x.n === 'World Desk');
    await api('POST', '/api/admin/channels/bulk', { keys: [world.k], action: 'hide' });
    cat = (await api('GET', '/api/catalog')).body;
    assert.ok(!cat.items.some((x) => x.k === world.k), 'hidden');
    const listed = (await api('GET', '/api/admin/channels?show=hidden')).body;
    assert.deepStrictEqual(listed.items.map((x) => x.n0), ['World Desk']);
    await api('DELETE', `/api/admin/channels/${encodeURIComponent(world.k)}`);
    for (let i = 0; i < 30; i++) { cat = (await api('GET', '/api/catalog')).body; if (cat.items.some((x) => x.k === world.k)) break; await wait(200); }
    assert.ok(cat.items.some((x) => x.k === world.k), 'back after a reset');
    // Exports use the edited name and number.
    const s = (await api('GET', '/api/admin')).body.settings;
    const exp = await api('GET', `/k/${s.exportKey}/playlist.m3u`);
    assert.match(exp.text, /tvg-chno="50"[^\n]*,News 24/);
  } finally {
    srv.child.kill();
    pl.close();
  }
});
