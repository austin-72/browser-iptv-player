// Fixes in the DVR (lib/dvr.js) and the outputs for other apps (lib/outputs.js): a full disk while a recording is
// saved, deleting one while it's saved, a stream that keeps dying, tuner streams the app left early, a deleted tuner
// profile, and the parental PIN.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Dvr } = require('../lib/dvr');
const { Catalog } = require('../lib/catalog');
const { Outputs } = require('../lib/outputs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dvrfix-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(50); } return false; };
const newDvr = (dir, deps = {}) => new Dvr(dir, { ffmpeg: () => ({ available: false }), source: () => null, programmes: () => [], allowed: () => true, connFree: () => true, ...deps }, { tick: 1e9 });
/** A recording that was made in `parts` pieces, now being saved. */
function madeRec(dvr, dir, parts) {
  const r = dvr.add('p1', { k: 'c1', s: Date.now() + 3600e3, e: Date.now() + 7200e3, t: 'Made' });
  r.dir = path.join(dir, 'recordings');
  fs.mkdirSync(r.dir, { recursive: true });
  r.parts = parts; r.state = 'saving';
  for (let i = 0; i < parts; i++) fs.writeFileSync(path.join(r.dir, `${r.id}.${i}.ts`), Buffer.alloc(300000, i + 1));
  return r;
}

test('DVR: a full disk while the pieces are joined fails the recording (no crash, not stuck saving)', { skip: !fs.existsSync('/dev/full') && 'no /dev/full' }, async () => {
  const dir = tmp();
  const dvr = newDvr(dir);
  const uncaught = [];
  const onErr = (e) => uncaught.push(e);
  process.on('uncaughtException', onErr);
  try {
    const r = madeRec(dvr, dir, 2);
    fs.symlinkSync('/dev/full', path.join(r.dir, `${r.id}.ts`)); // (every write there: "no space left")
    await Promise.race([dvr._finish(r), wait(5000)]);
    assert.strictEqual(r.state, 'failed', 'not stuck in "saving"');
    assert.match(r.err, /ENOSPC/);
    assert.deepStrictEqual(uncaught, []);
    assert.ok(!fs.existsSync(path.join(r.dir, `${r.id}.ts`)), 'the half-joined file goes');
    assert.ok(fs.existsSync(path.join(r.dir, `${r.id}.0.ts`)) && fs.existsSync(path.join(r.dir, `${r.id}.1.ts`)), 'the pieces stay');
  } finally { process.off('uncaughtException', onErr); dvr.stop(); }
});

test('DVR: deleting a recording while it is being saved leaves no file behind and it never becomes "done"', async () => {
  const dir = tmp();
  // A slow "ffmpeg" that makes the MP4 a second later.
  const bin = path.join(dir, 'fake-ffmpeg.sh');
  fs.writeFileSync(bin, '#!/bin/sh\nsleep 1\nfor a; do last="$a"; done\nhead -c 5000 /dev/zero > "$last"\n');
  fs.chmodSync(bin, 0o755);
  const notes = [];
  const dvr = newDvr(dir, { ffmpeg: () => ({ bin, available: true }), notify: (pid, r, what) => notes.push(what) });
  try {
    const r = madeRec(dvr, dir, 2);
    const saving = dvr._finish(r);
    await wait(300);
    dvr.remove('p1', r.id, false);
    await saving;
    assert.notStrictEqual(r.state, 'done');
    assert.ok(!notes.includes('done'));
    assert.deepStrictEqual(fs.readdirSync(r.dir).filter((f) => f.startsWith(r.id)), [], 'nothing left on disk');
    assert.strictEqual(dvr.find(r.id), null);
  } finally { dvr.stop(); }
});

test('DVR: a stream that keeps dying is not asked for again by the clock before its wait is over', async () => {
  const dir = tmp();
  let asks = 0;
  const dvr = newDvr(dir, { ffmpeg: () => ({ bin: 'ffmpeg', available: true }), source: () => ({ input: 'http://127.0.0.1:1/x.ts', headers: {} }), connFree: () => { asks++; return false; } });
  try {
    const r = dvr.add('p1', { k: 'c1', s: Date.now() + 3600e3, e: Date.now() + 7200e3, t: 'Dies' });
    r.s = Date.now() - 60e3; r.state = 'waiting'; r.parts = 1; r.retry = Date.now() + 60e3;
    await dvr.tick();
    assert.strictEqual(asks, 0, 'waits');
    r.retry = Date.now() - 1;
    await dvr.tick();
    assert.strictEqual(asks, 1, 'then tries again');
  } finally { dvr.stop(); }
});

// ---------------------------------------------------------------- outputs
function fixture(provBase, { locked = null } = {}) {
  const items = [
    { name: 'News One', type: 'live', url: `${provBase}/live/u/p/1.ts`, group: 'News', lang: 'en', chno: '1' },
    { name: 'Late Night', type: 'live', url: `${provBase}/live/u/p/2.ts`, group: 'Adult', lang: 'en', chno: '2' },
  ];
  const settings = () => ({ userAgent: 'test', tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [], epgDays: 1, defaultLangs: [] });
  const ls = { all: () => [{ id: 'L', name: 'L', enabled: true, type: 'xtream', account: { maxConnections: '2' } }], parsed: new Map([['L', { items, epgUrls: [] }]]), extras: [] };
  const epg = { has: () => false, resolve: () => null, range: () => [] };
  const cat = new Catalog({ lists: ls, epg, getSettings: settings });
  cat.build();
  if (locked) cat.overrides = { hasLocks: true, isLocked: (it) => it.n === locked };
  const profiles = [{ id: 'A', name: 'Dad', admin: true, restrictions: {} }, { id: 'B', name: 'Mum', restrictions: {} }];
  const accounts = { profiles, profile: (id) => profiles.find((p) => p.id === id) || null };
  const out = new Outputs({
    dir: tmp(), catalog: cat, lists: ls, accounts, epg, settings, media: { available: false }, clientIp: () => '192.168.1.5', ready: async () => {},
    hiddenFor: () => new Set(), inputOf: (it) => ({ input: it.u, headers: {} }), relayPath: (u) => '/relay?u=' + encodeURIComponent(u),
    videoViaProxy: () => false, connLimit: () => 2, usage: () => 0, serveLocal: () => {},
  });
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try { if (!(await out.handle(req, res, u.pathname, u.searchParams))) { res.writeHead(404); res.end('app'); } } catch (e) { if (!res.headersSent) res.writeHead(e.status || 500); res.end(e.message); }
  });
  return { out, cat, srv, profiles };
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const get = (base, p) => new Promise((ok, no) => http.get(base + p, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => ok({ status: r.statusCode, headers: r.headers, body: b })); }).on('error', no));

test('HDHomeRun: an app that leaves while the provider is slow to answer doesn’t leave a provider connection open', { timeout: 20000 }, async () => {
  // A provider that answers after 700 ms, then streams for ever.
  let open = 0;
  const prov = http.createServer((req, res) => {
    open++;
    res.on('close', () => { open--; });
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      const iv = setInterval(() => { if (res.destroyed) return clearInterval(iv); res.write(Buffer.alloc(188 * 50, 0x47)); }, 50);
    }, 700);
  });
  const pbase = await listen(prov);
  const f = fixture(pbase);
  const base = await listen(f.srv);
  try {
    f.out.update({ hdhr: { enabled: true, tuners: 2 } });
    const req = http.get(base + '/auto/v1');
    req.on('error', () => {});
    await until(() => open === 1);
    await wait(150);
    req.destroy(); // (Plex gave up before the provider answered)
    assert.ok(await until(() => open === 0, 4000), 'the provider connection is closed');
    assert.strictEqual([...f.out.active.values()].filter((a) => a.live).length, 0);
    // A normal one still plays, and ends when the app goes.
    const got = await new Promise((ok) => { const r2 = http.get(base + '/auto/v1', (res) => { res.once('data', () => { ok(res.statusCode); r2.destroy(); }); }); r2.on('error', () => {}); });
    assert.strictEqual(got, 200);
    assert.ok(await until(() => open === 0, 4000));
  } finally { f.srv.close(); prov.closeAllConnections(); prov.close(); }
});

test('HDHomeRun: the tuner’s profile deleted gives no channels (not the admin’s); PIN-locked ones stay out of other apps', { timeout: 20000 }, async () => {
  const f = fixture('http://prov.example', { locked: 'Late Night' });
  const base = await listen(f.srv);
  try {
    f.out.update({ hdhr: { enabled: true, profile: 'B' }, xtream: { enabled: true } });
    let lu = JSON.parse((await get(base, '/lineup.json')).body);
    assert.deepStrictEqual(lu.map((x) => x.GuideName), ['News One'], 'locked channel left out');
    assert.strictEqual((await get(base, '/auto/v2')).status, 404);
    f.profiles.splice(1, 1); // (Mum's profile deleted)
    lu = JSON.parse((await get(base, '/lineup.json')).body);
    assert.deepStrictEqual(lu, []);
    assert.strictEqual((await get(base, '/auto/v1')).status, 404);
    // Xtream: the locked channel isn't listed, and its stream isn't given out.
    const dad = f.out.setLogin('A');
    const live = JSON.parse((await get(base, `/player_api.php?username=dad&password=${dad.password}&action=get_live_streams`)).body);
    assert.deepStrictEqual(live.map((x) => x.name), ['News One']);
    const lockedId = f.out.idOf(f.cat.items.find((i) => i.n === 'Late Night').k);
    assert.strictEqual((await get(base, `/live/dad/${dad.password}/${lockedId}.ts`)).status, 404);
    assert.strictEqual((await get(base, `/live/dad/${dad.password}/${live[0].stream_id}.ts`)).status, 302);
  } finally { f.srv.close(); }
});

test('keep rules: a series keeps its latest N episodes, watched recordings go some days after, and “keep” beats both', () => {
  const dir = tmp();
  const watched = {};
  const dvr = newDvr(dir, { watchedAt: (pid, id) => watched[pid + ':' + id] || 0 });
  const DAY = 86400e3;
  const now = Date.now();
  const rdir = path.join(dir, 'recordings');
  fs.mkdirSync(rdir, { recursive: true });
  const rule = dvr.addRule('p1', { k: 'c1', ch: 'One', t: 'The Show' });
  const other = dvr.addRule('p1', { k: 'c1', ch: 'One', t: 'Another Show' });
  let n = 0;
  /** A finished recording that ended `daysAgo` days ago, with its file. */
  const made = (name, daysAgo, extra = {}) => {
    const s0 = now + 3600e3 + (++n) * 600e3; // (each its own airing)
    const r = dvr.add('p1', { k: 'c1', s: s0, e: s0 + 1800e3, t: name });
    Object.assign(r, { dir: rdir, state: 'done', ended: now - daysAgo * DAY, file: path.join(rdir, r.id + '.mp4'), size: 1000 }, extra);
    fs.writeFileSync(r.file, 'x'.repeat(1000));
    return r;
  };
  const there = (r) => fs.existsSync(r.file) && dvr.find(r.id) && dvr.find(r.id).state === 'done';
  const e1 = made('The Show', 5, { rule: rule.id }), e2 = made('The Show', 4, { rule: rule.id }), e3 = made('The Show', 3, { rule: rule.id, keep: true });
  const e4 = made('The Show', 2, { rule: rule.id }), e5 = made('The Show', 1, { rule: rule.id });
  const o1 = made('Another Show', 9, { rule: other.id }), film = made('A Film', 8);

  // Nothing set: everything stays.
  dvr._cleanup();
  assert.ok([e1, e2, e3, e4, e5, o1, film].every(there));

  // The latest two of The Show (the one marked "keep" stays besides, and isn't one of the two).
  assert.strictEqual(dvr.setRule('p1', rule.id, { keepN: 2 }).keepN, 2);
  assert.deepStrictEqual([e1, e2, e3, e4, e5].map(there), [false, false, true, true, true]);
  assert.ok(there(o1) && there(film), 'another series and a one-off are left alone');
  assert.throws(() => dvr.setRule('someone-else', rule.id, { keepN: 1 }), /Not found/);
  assert.strictEqual(dvr.setRule('admin', rule.id, { keepN: 0 }, true).keepN, undefined, 'back to every episode (an admin may change anyone’s)');

  // Watched ones go a day after they were watched: not sooner, and not unwatched ones.
  dvr.setConfig({ watchedDays: 1 });
  watched['p1:' + e4.id] = now - 2 * DAY;      // watched two days ago
  watched['p1:' + e5.id] = now - 3600e3;       // an hour ago
  watched['p1:' + e3.id] = now - 9 * DAY;      // long ago, but marked "keep"
  watched['p2:' + film.id] = now - 9 * DAY;    // by someone else: it's its own profile's watching that counts
  dvr._cleanup();
  assert.deepStrictEqual([e3, e4, e5, o1, film].map(there), [true, false, true, true, true]);
  assert.strictEqual(dvr.setConfig({ watchedDays: 0 }).watchedDays, 0);
  watched['p1:' + e5.id] = now - 30 * DAY;
  dvr._cleanup();
  assert.ok(there(e5), 'off again: watched ones stay');
  dvr.stop();
  dvr.store.flush(true); // (nothing left waiting to be written once the folder is gone)
  fs.rmSync(dir, { recursive: true, force: true });
});
