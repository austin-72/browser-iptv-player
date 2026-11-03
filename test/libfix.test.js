'use strict';
// Fixes in lib/: library scans of big folders, zip bombs, deleted profiles coming back, home-list matching cost,
// intro-detection processes outliving the server, recommendations while the catalogue reloads.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('library scan lists each folder once (no per-file readdir / exists checks)', async () => {
  const { Library } = require('../lib/library');
  const root = tmp('libfix-');
  const films = path.join(root, 'Films');
  fs.mkdirSync(films);
  for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(films, `Movie ${i} (2001).mp4`), '');
  fs.writeFileSync(path.join(films, 'Movie 7 (2001).jpg'), '');
  fs.writeFileSync(path.join(films, 'Movie 7 (2001).en.srt'), '');
  const show = path.join(root, 'Show', 'Season 1');
  fs.mkdirSync(show, { recursive: true });
  fs.writeFileSync(path.join(show, 'Show S01E01.mkv'), '');
  fs.writeFileSync(path.join(root, 'Show', 'poster.png'), '');
  const store = { data: { items: {}, scannedAt: null }, save() {} };
  const lib = new Library({ folders: () => [root], store, media: { probeAvailable: false }, thumbDir: tmp('libfix-th-') });
  const orig = { readdirSync: fs.readdirSync, existsSync: fs.existsSync };
  let readdirs = 0, exists = 0;
  fs.readdirSync = function (...a) { readdirs++; return orig.readdirSync.apply(this, a); };
  fs.existsSync = function (...a) { exists++; return orig.existsSync.apply(this, a); };
  try { await lib.scan(); } finally { Object.assign(fs, orig); }
  const items = lib.items();
  assert.strictEqual(items.length, 401);
  assert.ok(readdirs <= 5, `readdirSync called ${readdirs} times`);
  assert.strictEqual(exists, 0);
  const m7 = items.find((i) => i.title === 'Movie 7');
  assert.strictEqual(m7.poster, path.join(films, 'Movie 7 (2001).jpg'));
  assert.deepStrictEqual(m7.subs.map((s) => s.lang), ['en']);
  assert.strictEqual(items.find((i) => i.title === 'Movie 8').poster, null);
  assert.strictEqual(items.find((i) => i.type === 'episode').poster, path.join(root, 'Show', 'poster.png'));
});

test('unzip never inflates past maxBytes, even when the zip lies about sizes', () => {
  const { zip, unzip } = require('../lib/zip');
  const buf = zip([{ name: 'a.srt', data: Buffer.alloc(8 * 1024 * 1024) }]);
  // Claim the file is 10 bytes (central directory "uncompressed size").
  const cd = buf.readUInt32LE(buf.length - 22 + 16);
  buf.writeUInt32LE(10, cd + 24);
  assert.throws(() => unzip(buf, { maxBytes: 1024 * 1024 }), /too big/);
  // Normal zips still unpack.
  const ok = unzip(zip([{ name: 'x/b.srt', data: 'hello' }]));
  assert.strictEqual(ok[0].data.toString(), 'hello');
  assert.ok(zlib); // (zlib is what the limit is passed to)
});

test('a removed profile is not written back by a pending save', async () => {
  const { UserData } = require('../lib/userdata');
  const { JsonFile } = require('../lib/store');
  const dir = tmp('libfix-ud-');
  const ud = new UserData(dir);
  ud.played('p1', { k: 'a', s: 30, t: 'movie' });
  ud.remove('p1');
  await new Promise((r) => setTimeout(r, 450));
  JsonFile.flushAll();
  assert.ok(!fs.existsSync(path.join(dir, 'p1.json')), 'profile file came back');
});

test('home list matching builds / sizes the index once per list, not once per entry', () => {
  const { HomeLists } = require('../lib/homelists');
  const items = [{ k: 'm1', t: 'movie', n: 'One', tmdb: '1' }, { k: 'm2', t: 'movie', n: 'Two', tmdb: '2' }];
  const cat = { version: 'v1', items, get: (k) => items.find((x) => x.k === k), findTitle: () => [] };
  let sized = 0;
  const m = new Proxy({ a: 1, b: 2 }, { ownKeys(t) { sized++; return Reflect.ownKeys(t); } });
  const hl = new HomeLists({ dataDir: tmp('libfix-hl-'), catalog: () => cat, tmdb: { enabled: () => true, map: { data: { m } } }, trakt: null });
  hl.entries.set('src', Array.from({ length: 500 }, (_, i) => ({ t: 'movie', n: 'X' + i, tmdb: String(i % 3) })));
  const keys = hl.keysOf('src');
  assert.strictEqual(keys[1], 'm1');
  assert.strictEqual(keys[2], 'm2');
  assert.strictEqual(keys[0], null);
  assert.ok(sized <= 2, `TMDB map sized ${sized} times`);
});

test('intro detection ffprobe/ffmpeg processes stop when the server exits', { timeout: 20000 }, async () => {
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); res.write(Buffer.alloc(188, 0x47)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const token = 'libfix' + process.pid + Date.now();
  const url = `http://127.0.0.1:${srv.address().port}/${token}.ts`;
  const code = `const { IntroDetector } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'intro'))});
    new IntroDetector().probe(${JSON.stringify(url)}).catch(() => {});
    setTimeout(() => process.exit(0), 1000);`;
  const ours = () => {
    const out = [];
    for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
      let cl = '';
      try { cl = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
      const argv = cl.split('\0');
      if (/ffprobe$/.test(argv[0]) && cl.includes(token)) out.push(+pid);
    }
    return out;
  };
  try {
    await new Promise((resolve) => spawn(process.execPath, ['-e', code], { stdio: 'ignore' }).on('exit', resolve));
    await new Promise((r) => setTimeout(r, 300));
    const left = ours();
    for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    assert.deepStrictEqual(left, [], 'ffprobe still running after the server exited');
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test('recommendations survive the catalogue reloading while TMDB is asked', async () => {
  const { Recs } = require('../lib/recs');
  let films = [];
  const add = (k, n, extra) => films.push({ k, t: 'movie', n, lg: ['en'], g: 'Movies', ...extra });
  add('s1', 'Seed One', { gn: ['Crime'], cast: 'Ana' });
  add('s2', 'Seed Two', { gn: ['Crime'], cast: 'Ana' });
  for (let i = 1; i <= 8; i++) add('c' + i, 'Cand ' + i, { gn: ['Crime'], cast: 'Ana', r: 6 });
  const byKey = () => new Map(films.map((f) => [f.k, f]));
  const catalog = {
    version: 'v1', get items() { return films; },
    get: (k) => byKey().get(k) || null,
    filterFor: () => ({ test: (it) => it.t === 'movie' || it.t === 'show' }),
    findTitle: (t) => films.filter((f) => f.n === t).map((f) => f.k),
  };
  const tmdb = {
    enabled: () => true,
    related: async (it) => {
      const out = ['Cand 1', 'Cand 2', 'Cand 3', 'Cand 4'].map((title) => ({ title, type: 'movie', w: 1 }));
      // The second favourite's answer arrives after a reload dropped the first favourite and two suggestions.
      if (it.k === 's2') films = films.filter((f) => !['s1', 'c1', 'c2'].includes(f.k));
      return out;
    },
  };
  const now = Date.now();
  const data = { history: [{ k: 's1', at: now, s: 5000 }, { k: 's2', at: now - 1000, s: 5000 }], progress: {}, ratings: {}, list: [], hidden: [], impressions: {} };
  const r = await new Recs({ dir: tmp('libfix-recs-'), catalog, userdata: { of: () => ({ data }) }, accounts: { profile: () => ({ id: 'p1', interests: [] }), profiles: [{ id: 'p1' }] }, tmdb }).compute('p1');
  assert.ok(r && Array.isArray(r.rows));
  assert.ok(!r.rows.some((x) => x.seed === 's1' && x.id.startsWith('because:')), 'no row for a title that is gone');
});
