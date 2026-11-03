// Guide, TMDB and store fixes: offsets with a colon, empty guides, parsed guides kept small, overlapping listings,
// guide re-reads racing a write, TMDB rate limits and household corrections, and writes cut short by a shutdown.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { Readable } = require('stream');
const { parseXMLTV, parseTime } = require('../lib/xmltv');
const { Epg } = require('../lib/epg');
const { JsonFile, ShardedJson } = require('../lib/store');
const { Tmdb } = require('../lib/tmdb');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('times with a "+05:30" style offset keep their minutes', () => {
  assert.strictEqual(new Date(parseTime('20261028140000 +05:30')).toISOString(), '2026-10-28T08:30:00.000Z');
  assert.strictEqual(new Date(parseTime('20261028140000 +0530')).toISOString(), '2026-10-28T08:30:00.000Z');
  assert.strictEqual(new Date(parseTime('20261028140000 -0100')).toISOString(), '2026-10-28T15:00:00.000Z');
  assert.strictEqual(new Date(parseTime('20261028140000')).toISOString(), '2026-10-28T14:00:00.000Z');
});

test('an empty guide is an error (the last good one stays) rather than an empty guide', async () => {
  await assert.rejects(parseXMLTV(Readable.from(['<?xml version="1.0"?><tv generator-info-name="x"></tv>'])), /empty/i);
  const r = await parseXMLTV(Readable.from(['<tv><channel id="a"><display-name>A</display-name></channel></tv>']));
  assert.deepStrictEqual(Object.keys(r.channels), ['a'], 'a guide with channels only is still read');
});

test('a parsed guide doesn’t keep the whole downloaded text in memory', () => {
  // (In a child with --expose-gc: what the parsed listings take, compared with a plain copy of them.)
  const script = `
    const { parseXMLTV } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'xmltv'))});
    const { Readable } = require('stream');
    function* gen() {
      yield '<tv>';
      let s = '';
      for (let i = 0; i < 40000; i++) {
        s += '<programme start="20261102' + String(i % 24).padStart(2, '0') + '0000 +0000" stop="20261102' + String(i % 24).padStart(2, '0') + '3000 +0000" channel="c' + (i % 200) + '"><title>Title number ' + i + '</title><desc>' + 'A fairly long description of the programme. '.repeat(4) + i + '</desc><credits>' + 'z'.repeat(1500) + '</credits></programme>';
        if (s.length > 65536) { yield s; s = ''; }
      }
      yield s + '</tv>';
    }
    (async () => {
      gc(); gc();
      const base = process.memoryUsage().heapUsed;
      let r = await parseXMLTV(Readable.from(gen()));
      if (process.argv[1] === 'copy') r = JSON.parse(JSON.stringify(r));
      globalThis.keep = r;
      await new Promise((ok) => setTimeout(ok, 50));
      gc(); gc();
      console.log(JSON.stringify({ used: process.memoryUsage().heapUsed - base, n: r.programmeCount }));
    })();`;
  const run = (mode) => {
    const out = spawnSync(process.execPath, ['--expose-gc', '-e', script, mode], { encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    return JSON.parse(out.stdout.trim().split('\n').pop());
  };
  const parsed = run('parsed'), copy = run('copy');
  assert.strictEqual(parsed.n, 40000);
  assert.ok(parsed.used < copy.used * 1.6, `parsed listings take ${Math.round(parsed.used / 1e6)} MB, a plain copy of them ${Math.round(copy.used / 1e6)} MB`);
});

test('overlapping listings in one guide: "on now" and ranges still find the programme on air', () => {
  const e = new Epg(tmp('epgov-'));
  const H = 3600e3;
  e.setSource('g', {
    channels: {},
    programmes: {
      a: [{ s: 0, e: 10 * H, t: 'Long block' }, { s: 2 * H, e: 3 * H, t: 'Inside' }],
      b: [{ s: 2 * H, e: 3 * H, t: 'Two' }, { s: 0, e: 1 * H, t: 'Zero' }, { s: 1 * H, e: 1 * H, t: 'No end' }, { s: 1 * H, e: 2 * H, t: 'Dup' }],
    },
  });
  // A long block with a shorter one inside: the block ends when the next one starts.
  assert.strictEqual(e.nowNext('a', 1 * H).now.t, 'Long block');
  assert.strictEqual(e.nowNext('a', 2.5 * H).now.t, 'Inside');
  assert.deepStrictEqual(e.range('a', 0, 10 * H).map((p) => p.t), ['Long block', 'Inside']);
  // Out of order, a programme without a sensible end, and a second one in the same slot.
  assert.deepStrictEqual(e.range('b', 0, 10 * H).map((p) => [p.t, p.s / H, p.e / H]), [['Zero', 0, 1], ['No end', 1, 1.5], ['Two', 2, 3]]);
  assert.strictEqual(e.nowNext('b', 1.2 * H).now.t, 'No end');
  // A tidy guide is kept as it is (no copy).
  const list = [{ s: 0, e: H, t: 'x' }, { s: H, e: 2 * H, t: 'y' }];
  e.setSource('g2', { channels: {}, programmes: { c: list } });
  assert.strictEqual(e.idx.programmes.get('c'), list);
});

test('a guide read back from disk never brings back an older copy than the one being written', async () => {
  const dir = tmp('epgrace-');
  const now = Date.now();
  const prog = (t) => [{ s: now - 1800e3, e: now + 1800e3, t }];
  const big = {};
  for (let i = 0; i < 3000; i++) big['x' + i] = [{ s: now, e: now + 60e3, t: 'Filler ' + 'y'.repeat(300) }];
  fs.writeFileSync(path.join(dir, 'g1.json'), JSON.stringify({ channels: {}, programmes: { 'a.us': prog('Old A'), 'b.us': prog('Old B'), ...big } }));
  const e = new Epg(dir);
  await e.useOnly(new Set(['a.us']));
  // New listings arrive (written in the background) just as b becomes used and is read back from disk.
  e.setSource('g1', { channels: {}, programmes: { 'a.us': prog('New A'), 'b.us': prog('New B'), ...big } }, { soon: true });
  await e.useOnly(new Set(['a.us', 'b.us']));
  assert.strictEqual(e.nowNext('a.us').now.t, 'New A');
  assert.strictEqual(e.nowNext('b.us').now.t, 'New B');
  clearTimeout(e._soonT);
});

function fakeTmdb(handler) {
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push({ url: req.url, at: Date.now() }); handler(req, res, hits); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, hits, base: `http://127.0.0.1:${srv.address().port}/3` })));
}

test('TMDB: "429 Too Many Requests" pauses the job for as long as TMDB asks', async () => {
  const f = await fakeTmdb((req, res) => { res.writeHead(429, { 'Retry-After': '1', 'Content-Type': 'application/json' }); res.end('{"status_code":25}'); });
  try {
    const t = new Tmdb({ dataDir: tmp('tmdb429-'), getKey: () => 'k', base: f.base });
    const items = Array.from({ length: 50 }, (_, i) => ({ k: 'k' + i, t: 'movie', n: 'Film ' + i }));
    let stop = false;
    const job = t.enrich(items, { stop: () => stop });
    await sleep(1500);
    stop = true;
    await job;
    assert.ok(f.hits.length <= 3, `${f.hits.length} requests in 1.5 s while TMDB said to wait a second`);
    assert.match(t.lastError, /429/);
    JsonFile.flushAll();
  } finally { f.srv.close(); }
});

test('TMDB: a household correction made while a lookup is under way isn’t overwritten by it', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = await fakeTmdb(async (req, res) => {
    if (req.url.startsWith('/3/search/movie')) await gate;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/3/search/movie')) return res.end(JSON.stringify({ results: [{ id: 111 }] }));
    const id = Number((/\/movie\/(\d+)/.exec(req.url) || [])[1]);
    res.end(JSON.stringify({ id, title: 'Film ' + id, overview: 'Plot ' + id }));
  });
  try {
    const t = new Tmdb({ dataDir: tmp('tmdbman-'), getKey: () => 'k', base: f.base });
    const it = { k: 'm1', t: 'movie', n: 'Some film' };
    const auto = t.details(it); // the background job, waiting on the search
    await sleep(100);
    const fixed = t.setMatch(it, { id: 222, type: 'movie' });
    await sleep(300);
    release();
    await Promise.all([auto, fixed]);
    assert.deepStrictEqual(t.map.data.m.m1, { id: 222, type: 'movie', manual: 1 });
    assert.strictEqual(t.meta.data.m.m1.tmdb, 222);
    assert.strictEqual(t.meta.data.m.m1.manual, 1);
    JsonFile.flushAll();
  } finally { f.srv.close(); }
});

test('shutdown during a background write of the TMDB details: nothing is lost or overwritten with older data', async () => {
  const dir = tmp('shardbg-');
  let s = new ShardedJson(path.join(dir, 'meta'), { delay: 10 });
  for (let i = 0; i < 3000; i++) s.data.m['k' + i] = { plot: 'p'.repeat(2000), n: i };
  const bg = s.flush(); // in the background, one piece at a time
  s.data.m.k1 = { plot: 'changed', n: 1 };
  JsonFile.flushAll(); // shutdown
  s = new ShardedJson(path.join(dir, 'meta'));
  assert.strictEqual(Object.keys(s.data.m).length, 3000, 'pieces still being written in the background were written too');
  await bg;
  s = new ShardedJson(path.join(dir, 'meta'));
  assert.strictEqual(Object.keys(s.data.m).length, 3000);
  assert.strictEqual(s.data.m.k1.plot, 'changed', 'the background write didn’t put older data back');
  ShardedJson.all.clear();
});

test('shutdown during a background JsonFile write: the background write doesn’t put older data back', async () => {
  const dir = tmp('jsonbg-');
  const f = path.join(dir, 'map.json');
  const j = new JsonFile(f, { m: {} }, { delay: 5, background: true });
  for (let i = 0; i < 20000; i++) j.data.m['k' + i] = 'x'.repeat(200);
  const bg = j.flush();
  j.data.m.last = 'newest';
  JsonFile.flushAll();
  assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).m.last, 'newest');
  await bg;
  await sleep(50);
  assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).m.last, 'newest');
  JsonFile.all.delete(j);
});

test('a damaged piece of the TMDB details is kept aside, not silently overwritten', () => {
  const dir = tmp('shardbad-');
  fs.mkdirSync(path.join(dir, 'meta'));
  fs.writeFileSync(path.join(dir, 'meta', '00.json'), '{"a": tru');
  const s = new ShardedJson(path.join(dir, 'meta'));
  assert.ok(fs.readdirSync(path.join(dir, 'meta')).some((f) => /^00\.json\.corrupt-\d+$/.test(f)));
  ShardedJson.all.delete(s);
});
