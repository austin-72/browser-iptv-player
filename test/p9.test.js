// Channel health (passive counts, the "may be down" mark, which copy plays first, the background checker and its
// safety rules) and "Find guides and logos" (public iptv-org / epg.pw data, from a local stand-in).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const zlib = require('zlib');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const mock = require('./mock/publicdb');
const { Health, probe, classify, codeOf } = require('../lib/health');
const { PublicDb, eachJsonItem, xmltvChannels, nameKeys } = require('../lib/publicdb');

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('failures are sorted into the channel’s fault, the account’s limit and the device', () => {
  assert.strictEqual(classify('The provider says this stream doesn’t exist (404). It may have been removed.', 404), 'dead');
  assert.strictEqual(classify('The server couldn’t reach the stream. It may be offline.', 0), 'dead');
  assert.strictEqual(classify('The provider says too many streams are playing on this account (509).', 509), 'busy');
  assert.strictEqual(classify('The provider is limiting connections right now (429).', 429), 'busy');
  assert.strictEqual(classify('This browser can’t decode this stream’s format.', 0), 'device');
  assert.strictEqual(classify('This channel is copy-protected (DRM) and this browser doesn’t support its protection.', 0), 'device');
  assert.strictEqual(codeOf('The stream server answered HTTP 502.'), 502);
  assert.strictEqual(codeOf('doesn’t exist (404).'), 404);
  assert.strictEqual(codeOf('x', { http: 410 }), 410);
  assert.strictEqual(codeOf('nothing'), 0);
});

test('health records: rolling counters, dead copies, the "may be down" set and copy order', () => {
  const items = new Map();
  const it = { k: 'K1', t: 'live', n: 'One', g: 'News', src: 'A', u: 'http://a/1.ts', alts: [{ l: 'B', u: 'http://b/1.ts' }, { l: 'A', u: 'http://a/1b.ts' }] };
  const solo = { k: 'K2', t: 'live', n: 'Two', g: 'News', src: 'A', u: 'http://a/2.ts' };
  items.set('K1', it); items.set('K2', solo);
  const cat = { get: (k) => items.get(k) || null, items: [...items.values()], version: '1' };
  let downs = 0;
  const h = new Health(tmp('hl-'), { catalog: () => cat, onDown: () => { downs++; } });
  const ids = Health.copies(it).map((c) => c.id);
  assert.deepStrictEqual(ids, ['K1|A|0', 'K1|B|0', 'K1|A|1'], 'two copies from one list are told apart');
  const dead = { ok: false, by: 'p', msg: 'The provider says this stream doesn’t exist (404).' };
  // Device and account problems don't make a channel dead.
  for (let i = 0; i < 5; i++) h.record(solo, -1, { ok: false, by: 'p', msg: 'This browser can’t decode this stream’s format.' });
  for (let i = 0; i < 5; i++) h.record(solo, -1, { ok: false, by: 'p', msg: 'too many streams (509)', code: 509 });
  assert.strictEqual(h.d.copies['K2|A|0'].n, 0);
  assert.deepStrictEqual(h.downKeys(), []);
  // Three failures in a row (or two from the checker) make a copy dead; a channel is down when every copy is.
  h.record(solo, -1, dead); h.record(solo, -1, dead);
  assert.deepStrictEqual(h.downKeys(), []);
  h.record(solo, -1, dead);
  assert.deepStrictEqual(h.downKeys(), ['K2']);
  h._downCheck();
  assert.strictEqual(downs, 1, 'devices hear about it');
  h.record(solo, -1, { ok: true, by: 'p', route: 'direct' });
  assert.deepStrictEqual(h.downKeys(), [], 'a success clears it');
  // It played, then stopped: not a dead channel.
  for (let i = 0; i < 4; i++) h.record(solo, -1, { ...dead, started: true });
  assert.strictEqual(h.d.copies['K2|A|0'].n, 0);
  // K1: the main copy is dead, one backup works, one was never tried → not "down".
  h.record(it, -1, { ...dead, by: 'c' }); h.record(it, -1, { ...dead, by: 'c' });
  h.record(it, 0, { ok: true, by: 'c' });
  assert.ok(Health.dead(h.d.copies['K1|A|0']));
  assert.deepStrictEqual(h.downKeys(), []);
  const f = h.failing({});
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].k, 'K1');
  assert.ok(f[0].backup && !f[0].allDown);
  assert.ok(f[0].copies[1].works);
  // A copy whose address changed starts again.
  it.u = 'http://a/1-new.ts';
  h.record(it, -1, { ...dead, by: 'p' });
  assert.strictEqual(h.d.copies['K1|A|0'].n, 1);
  // Copy order: the preferred backup first; with "skip after 1", failing copies last.
  assert.strictEqual(h.rank(it), null);
  h.prefer('K1', 'K1|A|1');
  const r1 = h.rank(it);
  assert.strictEqual(r1(1), -1);
  assert.strictEqual(r1(-1), 0);
  h.prefer('K1', '');
  h.setOpts({ skipAfter: 1 });
  const r2 = h.rank(it);
  assert.strictEqual(r2(-1), 1);
  assert.strictEqual(r2(0), 0);
  // Stream addresses (they carry logins) never end up in the record.
  h.record(solo, -1, { ok: false, by: 'c', msg: 'Couldn’t open http://bob:secret@prov.example/live/bob/secret/9.ts now' });
  assert.ok(!JSON.stringify(h.d).includes('secret'));
  // Providers: 7 days, per day.
  const pv = h.providers([{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }]);
  assert.strictEqual(pv[0].days.length, 7);
  assert.ok(pv[0].fail >= 6 && pv[0].ok >= 1);
  assert.strictEqual(pv[1].rate, 100);
  h.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(h.store.file), 'utf8'));
  assert.ok(Object.keys(saved.copies).length <= 4, 'one small record per copy, not a log');
  h._downCheck();
  assert.strictEqual(downs, 2);
});

test('a provider is only "Down" when several different channels fail, not one dead channel', () => {
  const items = new Map();
  for (let i = 1; i <= 5; i++) items.set('C' + i, { k: 'C' + i, t: 'live', n: 'Ch ' + i, g: 'G', src: 'P', u: `http://p/${i}.ts` });
  const cat = { get: (k) => items.get(k) || null, items: [...items.values()], version: '1' };
  const h = new Health(tmp('hlp-'), { catalog: () => cat });
  const st = () => h.providers([{ id: 'P', name: 'P' }])[0];
  const dead = { ok: false, by: 'p', msg: 'The provider says this stream doesn’t exist (404).' };
  h.record(items.get('C1'), -1, { ok: true, by: 'p' });
  for (let i = 0; i < 6; i++) h.record(items.get('C2'), -1, dead);
  let p = st();
  assert.strictEqual(p.state, 'up', 'one dead channel played over and over is a channel problem');
  assert.ok(p.rate < 50);
  assert.strictEqual(p.failingNow, 1);
  h.record(items.get('C3'), -1, dead);
  assert.notStrictEqual(st().state, 'down', 'two channels: still not the provider');
  assert.strictEqual(st().state, 'problems');
  h.record(items.get('C4'), -1, dead);
  assert.strictEqual(st().state, 'down', 'three different channels failing since the last success');
  h.record(items.get('C5'), -1, { ok: true, by: 'c' });
  assert.notStrictEqual(st().state, 'down', 'it worked again');
  // Never worked, and every channel tried failed.
  const h2 = new Health(tmp('hlp2-'), { catalog: () => cat });
  h2.record(items.get('C1'), -1, dead); h2.record(items.get('C2'), -1, dead);
  assert.strictEqual(h2.providers([{ id: 'P', name: 'P' }])[0].state, 'down');
  // Old saved data (before the per-channel list) still reads.
  h2.d.prov.P.r = 'ffff'; delete h2.d.prov.P.q;
  assert.doesNotThrow(() => h2.providers([{ id: 'P', name: 'P' }]));
});

test('a public site that can’t be reached is named, in plain words', async () => {
  const port = await freePort();
  const old = process.env.IPTVORG_API_BASE;
  process.env.IPTVORG_API_BASE = `http://127.0.0.1:${port}/api`;
  try {
    const db = new PublicDb({ dataDir: tmp('pdbx-'), fetch });
    await assert.rejects(db.iptvorg(), (e) => /Couldn’t reach 127\.0\.0\.1:\d+\. Check that this server can reach the internet/.test(e.message) && /proxy/.test(e.message) && !/fetch failed/.test(e.message));
    const srv = http.createServer((q, r) => { r.writeHead(503); r.end(); });
    await new Promise((ok) => srv.listen(port, '127.0.0.1', ok));
    await assert.rejects(db.iptvorg(), /answered with an error \(HTTP 503\)/);
    srv.close();
  } finally { if (old === undefined) delete process.env.IPTVORG_API_BASE; else process.env.IPTVORG_API_BASE = old; }
});

test('a check asks for a moment of the stream and hangs up', async () => {
  const m = await mock.start();
  try {
    const hls = await probe(m.base + '/live/ok.m3u8', {}, { fetch });
    assert.ok(hls.ok && hls.kind === 'hls', JSON.stringify(hls));
    assert.ok(m.hits['/live/ok-lo.m3u8'] === 1 && !m.hits['/live/ok-hi.m3u8'], 'the smallest variant');
    assert.strictEqual(m.hits['/seg/8.ts'], 1, 'the newest segment');
    const ts = await probe(m.base + '/ts/ok.ts', {}, { fetch });
    assert.ok(ts.ok && ts.kind === 'stream');
    await wait(200);
    assert.strictEqual(m.hits.tsClosed, 1, 'the endless stream was closed');
    const gone = await probe(m.base + '/ts/gone', {}, { fetch });
    assert.strictEqual(gone.code, 404);
    const text = await probe(m.base + '/ts/text', {}, { fetch });
    assert.match(text.err, /message instead of video/);
    const ac = new AbortController();
    const p = probe(m.base + '/ts/ok.ts?slow', {}, { fetch, signal: ac.signal });
    ac.abort();
    assert.ok((await p).stopped);
  } finally { await m.close(); }
});

test('public lists are read as a stream, a piece at a time', async () => {
  const items = [];
  const big = JSON.stringify([{ a: 'x]}{"' }, { b: [1, { c: 'é' }] }, { d: '\\"}' }]);
  const buf = Buffer.from(big);
  const chunks = []; for (let i = 0; i < buf.length; i += 3) chunks.push(buf.slice(i, i + 3)); // (splits the é too)
  await eachJsonItem(Readable.from(chunks), (o) => items.push(o));
  assert.deepStrictEqual(items, JSON.parse(big));
  const xml = '<?xml version="1.0"?><tv><channel id="7"><display-name>A &amp; B</display-name><display-name>AB</display-name><icon src="http://x/7.png"/></channel><channel id=\'8\'><display-name>[Tag] C</display-name></channel><programme start="1" channel="7"><title>t</title></programme><channel id="9"><display-name>late</display-name></channel></tv>';
  const ch = await xmltvChannels(Readable.from([zlib.gzipSync(xml)]));
  assert.deepStrictEqual(ch.map((c) => c.id), ['7', '8'], 'stops at the first programme');
  assert.deepStrictEqual(ch[0].names, ['A & B', 'AB']);
  assert.strictEqual(ch[0].icon, 'http://x/7.png');
  assert.ok(nameKeys('BBC One UK').includes('bbcone'));
  assert.ok(nameKeys('[SkyTV] Meadow TV').includes('meadowtv'));
});

test('guide and logo suggestions: country hints, confidence and the week-long cache', async () => {
  const m = await mock.start();
  const old = [process.env.IPTVORG_API_BASE, process.env.EPGPW_BASE];
  process.env.IPTVORG_API_BASE = m.iptvBase; process.env.EPGPW_BASE = m.epgpwBase;
  try {
    const dir = tmp('pdb-');
    const db = new PublicDb({ dataDir: dir, fetch, fromCountry: require('../lib/langs').fromCountry });
    const mk = (k, n, g, extra) => ({ it: { k, n, g, t: 'live', lg: ['en'], ...extra }, needGuide: true, needLogo: true });
    const chans = [mk('a', 'Harbour One HD', 'UK | Entertainment'), mk('b', 'Meadow TV', 'UK | Kids'), mk('c', 'Copper News', 'News', { tvgId: 'CopperNews.us' }), mk('d', 'Lantern Sport', 'DE | Sport'), mk('e', 'Harbour One', 'Entertainment'), mk('f', 'Nobody Knows', 'Misc')];
    const r = await db.suggest(chans, { guides: { has: (id) => id === 'MeadowTV.uk', nameOf: () => 'My guide' } });
    const by = Object.fromEntries(r.items.map((s) => [s.k, s]));
    assert.strictEqual(by.a.match.id, 'HarbourOne.uk');
    assert.ok(by.a.match.conf >= 0.85);
    assert.match(by.a.logo.url, /harbour\.png$/, 'a PNG beats an SVG');
    assert.strictEqual(by.a.guide.kind, 'epgpw');
    assert.strictEqual(by.a.guide.id, '4401');
    assert.match(by.a.guide.url, /epg_GB\.xml\.gz$/);
    assert.strictEqual(by.b.guide.kind, 'existing', 'a guide that already has the iptv-org id is just linked');
    assert.match(by.b.logo.url, /meadow\.png$/, 'the main feed’s logo');
    assert.strictEqual(by.c.match.why, 'Same guide id as the playlist gives');
    assert.strictEqual(by.c.guide.id, '5501');
    assert.ok(!by.d, 'no epg.pw guide for DE and no logo: nothing to suggest');
    assert.ok(by.e.match.conf < 0.85, 'same name in two countries, no hint: not sure');
    assert.ok(!by.f);
    assert.ok(m.hits['/xmltv/epg_GB.xml.gz'] === 1 && m.hits['/xmltv/epg_US.xml.gz'] === 1);
    assert.ok(!m.hits['/xmltv/epg_FR.xml.gz'], 'only the countries needed');
    assert.ok(fs.existsSync(path.join(dir, 'cache', 'publicdb', 'iptvorg.json')));
    // The admin's own iptv-org guide.
    const r2 = await db.suggest([chans[3]], { guides: { has: () => false, nameOf: () => '' }, iptvGuide: 'http://own.example/guide.xml' });
    assert.strictEqual(r2.items[0].guide.kind, 'iptvorg');
    assert.strictEqual(r2.items[0].guide.id, 'LanternSport.de');
    // Cached: a new instance doesn't download again.
    const n = m.hits['/api/channels.json'];
    const db2 = new PublicDb({ dataDir: dir, fetch });
    await db2.suggest([chans[0]], { guides: { has: () => false, nameOf: () => '' } });
    assert.strictEqual(m.hits['/api/channels.json'], n);
  } finally { [process.env.IPTVORG_API_BASE, process.env.EPGPW_BASE] = old; if (old[0] === undefined) delete process.env.IPTVORG_API_BASE; if (old[1] === undefined) delete process.env.EPGPW_BASE; await m.close(); }
});

test('channel health and guide finder on the real server', { timeout: 120000 }, async () => {
  const m = await mock.start();
  const port = await freePort();
  const dir = tmp('p9srv-');
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test', IPTVORG_API_BASE: m.iptvBase, EPGPW_BASE: m.epgpwBase, HEALTH_CHECK_TIMEOUT_MS: '4000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const jar = { a: '', b: '' };
  const req = async (method, p, { body, who = 'a' } = {}) => {
    const h = { 'X-App': '1' };
    if (jar[who]) h.Cookie = jar[who];
    if (body !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    const r = await fetch(base + p, { method, headers: h, body });
    const sc = r.headers.get('set-cookie');
    if (sc) jar[who] = sc.split(';')[0];
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j };
  };
  const until = async (fn, ms = 20000, what = '') => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('Timed out: ' + what + '\n' + out.slice(-2000)); await wait(250); } };
  try {
    await until(() => /Ready/.test(out), 15000, 'start');
    assert.strictEqual((await req('POST', '/api/login', { body: { password: 'pw-test' } })).status, 200);
    const prof = await req('POST', '/api/profiles', { body: { name: 'Alex', pin: '1234', avatar: 1 } });
    assert.strictEqual(prof.status, 200, JSON.stringify(prof.json));
    assert.strictEqual((await req('GET', '/api/health/down', { who: 'b' })).status, 401, 'needs a profile');
    const la = await req('POST', '/api/admin/lists', { body: { type: 'url', url: m.base + '/playlist.m3u', name: 'Alpha' } });
    assert.strictEqual(la.status, 200, JSON.stringify(la.json));
    await req('POST', '/api/admin/lists', { body: { type: 'url', url: m.base + '/playlist2.m3u', name: 'Beta' } });
    const chans = await until(async () => { const r = await req('GET', '/api/admin/channels?n=50'); return r.json && r.json.total >= 5 && r.json.items; }, 20000, 'catalogue');
    const K = Object.fromEntries(chans.map((c) => [c.n, c.k]));
    const alpha = la.json.id;
    assert.ok(K['Meadow TV'] && K['Unknown Thing'] && K['Harbour One'], JSON.stringify(Object.keys(K)));
    await until(async () => (await req('POST', '/api/play/sources', { body: { k: K['Meadow TV'] } })).json.sources.length === 2, 10000, 'the backup copy');

    // ---- passive: what devices report
    const fail404 = { failed: true, msg: 'The provider says this stream doesn’t exist (404). It may have been removed.' };
    for (let i = 0; i < 2; i++) await req('POST', '/api/stats/play', { body: { k: K['Unknown Thing'], alt: -1, ...fail404 } });
    assert.deepStrictEqual((await req('GET', '/api/health/down')).json.keys, []);
    await req('POST', '/api/stats/play', { body: { k: K['Unknown Thing'], alt: -1, ...fail404 } });
    const down = await req('GET', '/api/health/down');
    assert.deepStrictEqual(down.json.keys, [K['Unknown Thing']], 'three failures in a row → may be down');
    for (let i = 0; i < 4; i++) await req('POST', '/api/stats/play', { body: { k: K['Harbour One'], alt: -1, failed: true, msg: 'This browser can’t decode this stream’s format.' } });
    await req('POST', '/api/stats/play', { body: { k: K['Meadow TV'], alt: -1, backup: true, ...fail404 } });
    await req('POST', '/api/stats/play', { body: { k: K['Meadow TV'], alt: 0, route: 'direct', reason: '' } });
    let H = (await req('GET', '/api/admin/health')).json;
    assert.strictEqual(H.summary.failing, 2, JSON.stringify(H.failing));
    assert.ok(!H.failing.items.some((f) => f.k === K['Harbour One']), 'a browser problem isn’t the channel’s fault');
    const meadow = H.failing.items.find((f) => f.k === K['Meadow TV']);
    assert.ok(meadow.backup && meadow.copies[1].works);
    const stats = (await req('GET', '/api/admin/stats?days=1')).json;
    assert.strictEqual(stats.fails, 7, 'a copy that failed before its backup played isn’t a failed play');

    // ---- which copy plays first
    const order = async (k) => (await req('POST', '/api/play/sources', { body: { k } })).json.sources.map((s) => s.alt);
    assert.deepStrictEqual(await order(K['Meadow TV']), [-1, 0]);
    assert.strictEqual((await req('POST', '/api/admin/health/prefer', { body: { k: K['Meadow TV'], id: meadow.copies[1].id } })).status, 200);
    assert.deepStrictEqual(await order(K['Meadow TV']), [0, -1], 'use the backup copy first');
    await req('POST', '/api/admin/health/prefer', { body: { k: K['Meadow TV'], id: '' } });
    assert.deepStrictEqual(await order(K['Meadow TV']), [-1, 0]);
    await req('PUT', '/api/admin/health', { body: { skipAfter: 1 } });
    assert.deepStrictEqual(await order(K['Meadow TV']), [0, -1], 'failing copies go last');
    await req('PUT', '/api/admin/health', { body: { skipAfter: 0, gap: 2 } });
    assert.strictEqual((await req('POST', '/api/admin/health/prefer', { body: { k: K['Meadow TV'], id: 'nope' } })).status, 404);

    // ---- "Check now": one channel at a time; what each one did
    await req('POST', `/api/admin/health/lists/${alpha}/check`);
    await until(async () => { const p = (await req('GET', '/api/admin/health')).json.providers.find((x) => x.id === alpha); return p.job && p.job.done; }, 40000, 'alpha pass');
    H = (await req('GET', '/api/admin/health')).json;
    let pa = H.providers.find((p) => p.id === alpha);
    assert.strictEqual(pa.job.n, 5, JSON.stringify(pa));
    assert.strictEqual(pa.job.fail, 3, 'Meadow TV, Lantern Sport, Unknown Thing');
    await wait(200);
    assert.strictEqual(m.hits.tsOpen, m.hits.tsClosed, 'every stream it opened was closed');
    const lantern = H.failing.items.find((f) => f.k === K['Lantern Sport']);
    assert.match(lantern.copies[0].err, /message instead of video/);
    assert.strictEqual(lantern.copies[0].by, 'c');
    assert.ok(H.failing.items.find((f) => f.k === K['Unknown Thing']).down);
    assert.ok(!H.failing.items.some((f) => f.k === K['Harbour One'] || f.k === K['Copper News']));
    assert.strictEqual(pa.checked, 5);

    // Someone else watching from Alpha: no checks there.
    assert.strictEqual((await req('POST', '/api/login', { body: { password: 'pw-test' }, who: 'b' })).status, 200);
    assert.strictEqual((await req('POST', `/api/profiles/${prof.json.id}/select`, { body: { pin: '1234' }, who: 'b' })).status, 200);
    const sse = await new Promise((ok) => http.get(`${base}/api/events?name=Lounge`, { headers: { Cookie: jar.b } }, ok));
    let ev = '';
    sse.on('data', (d) => { ev += d; });
    await until(() => /"conn"/.test(ev), 5000, 'sse');
    const conn = JSON.parse(/data: (\{"conn".*\})/.exec(ev)[1]).conn;
    await req('POST', '/api/presence', { body: { conn, playing: { k: K['Harbour One'], n: 'Harbour One', alt: -1 } }, who: 'b' });
    await req('POST', '/api/admin/health/forget', { body: { k: K['Lantern Sport'] } });
    await req('POST', `/api/admin/health/lists/${alpha}/check`);
    await wait(2500);
    H = (await req('GET', '/api/admin/health')).json;
    pa = H.providers.find((p) => p.id === alpha);
    assert.strictEqual(pa.job.n, 0, 'nothing checked while someone watches');
    assert.match(pa.waiting, /watching/);
    // Beta's limit isn't known: with someone else's app open, it waits too.
    const beta = H.providers.find((p) => p.name === 'Beta');
    assert.ok(beta.tight);
    await req('POST', `/api/admin/health/lists/${beta.id}/check`);
    await wait(1500);
    H = (await req('GET', '/api/admin/health')).json;
    assert.match(H.providers.find((p) => p.id === beta.id).waiting, /one stream at a time/);
    assert.strictEqual((await req('DELETE', `/api/admin/health/lists/${alpha}/check`)).json.job.stopped, true);
    await req('DELETE', `/api/admin/health/lists/${beta.id}/check`);
    sse.destroy();
    await wait(300);
    // Nobody else: Beta is checked ("Check now" by the admin, whose own app is open, still runs).
    await req('POST', `/api/admin/health/lists/${beta.id}/check`);
    await until(async () => { const p = (await req('GET', '/api/admin/health')).json.providers.find((x) => x.id === beta.id); return p.job && p.job.done; }, 15000, 'beta pass');
    H = (await req('GET', '/api/admin/health')).json;
    const pb = H.providers.find((p) => p.id === beta.id);
    assert.strictEqual(pb.job.n, 1);
    assert.strictEqual(pb.job.ok, 1);
    assert.ok(pb.estimate.copies === 1 && pb.estimate.seconds > 0);

    // ---- find guides and logos
    let F = (await req('GET', '/api/admin/findguides')).json;
    assert.strictEqual(F.result, null, 'nothing runs until the admin asks');
    assert.ok(!m.hits['/api/channels.json']);
    assert.strictEqual((await req('POST', '/api/admin/findguides/apply', { body: { items: [{ k: K['Harbour One'], logo: true }] } })).status, 409);
    await req('POST', '/api/admin/findguides/scan', { body: {} });
    F = await until(async () => { const r = (await req('GET', '/api/admin/findguides')).json; return !r.job.running && r; }, 20000, 'scan');
    assert.ok(!F.job.error, F.job.error);
    assert.deepStrictEqual(F.result.warnings, [], 'no guide for a country (404) isn’t a problem to report');
    const sug = Object.fromEntries(F.result.items.map((s) => [s.n, s]));
    assert.ok(sug['Harbour One'] && sug['Harbour One'].guide.id === '4401', JSON.stringify(F.result.items));
    assert.strictEqual(sug['Meadow TV'].guide.id, '4402');
    assert.ok(sug['Harbour One'].match.conf >= 0.85, 'the provider’s own “UK |” category tells the countries apart');
    const ap = await req('POST', '/api/admin/findguides/apply', { body: { items: [{ k: K['Harbour One'], logo: true, guide: true }, { k: K['Meadow TV'], logo: true }, { k: 'nope', logo: true }] } });
    assert.deepStrictEqual(ap.json, { logos: 2, guides: 1, added: ['epg.pw · United Kingdom'] });
    const ch = await until(async () => { const r = (await req('GET', '/api/admin/channels?q=Harbour')).json.items[0]; return r.epg === '4401' && r; }, 20000, 'guide linked');
    assert.strictEqual(ch.eo, '4401');
    assert.match(ch.logo, /harbour\.png$/);
    assert.ok(ch.ov, 'kept with the admin’s channel edits');
    const g = (await req('GET', '/api/admin')).json.guides;
    assert.strictEqual(g.filter((x) => /epg_GB/.test(x.url)).length, 1);
    const meadowCh = (await req('GET', '/api/admin/channels?q=Meadow')).json.items[0];
    assert.match(meadowCh.logo, /meadow\.png$/);
    assert.ok(!meadowCh.eo, 'only what was ticked');
    // Survives a list refresh.
    await req('POST', `/api/admin/lists/${alpha}/refresh`);
    await wait(1500);
    assert.match((await req('GET', '/api/admin/channels?q=Harbour')).json.items[0].logo, /harbour\.png$/);
    assert.ok(!/Error|TypeError/.test(out.replace(/Guide finder: epg\.pw \w+: .*/g, '')), out.slice(-3000));
  } finally {
    app.kill();
    await m.close();
  }
});
