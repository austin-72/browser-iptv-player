// Big stores (lib/store.js): TMDB details kept in 64 small files written in the background, moved over from the old
// single meta.json; a JsonFile written in the background; and the guide parser coping with a broken guide.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { JsonFile, ShardedJson, shardOf } = require('../lib/store');
const { parseXMLTV } = require('../lib/xmltv');

test('sharded store: moved over from one big file, only changed pieces written, without holding the server up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-'));
  const m = {};
  for (let i = 0; i < 20000; i++) m['k' + i] = { plot: 'x'.repeat(200), n: i };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ m }));
  fs.writeFileSync(path.join(dir, 'meta.json.bak'), JSON.stringify({ m }));
  let s = new ShardedJson(path.join(dir, 'meta'), { legacy: path.join(dir, 'meta.json'), delay: 10 });
  assert.strictEqual(Object.keys(s.data.m).length, 20000);
  assert.ok(!fs.existsSync(path.join(dir, 'meta.json')), 'the old file is moved aside');
  assert.ok(fs.existsSync(path.join(dir, 'meta', 'old-meta.json')));
  assert.strictEqual(fs.readdirSync(path.join(dir, 'meta')).filter((f) => /^[0-9a-f]{2}\.json$/.test(f)).length, 64);
  // One change: one piece written.
  const f = path.join(dir, 'meta', shardOf('k5').toString(16).padStart(2, '0') + '.json');
  const other = path.join(dir, 'meta', shardOf('k5') === 0 ? '01.json' : '00.json');
  const t0 = fs.statSync(other).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  s.data.m.k5 = { plot: 'new', n: 5 };
  delete s.data.m.k6;
  s.data.m.knew = { n: -1 };
  s.save();
  await new Promise((r) => setTimeout(r, 100));
  await s.flush();
  assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).k5.plot, 'new');
  assert.strictEqual(fs.statSync(other).mtimeMs === t0 || shardOf('k6') === parseInt(path.basename(other), 16) || shardOf('knew') === parseInt(path.basename(other), 16), true, 'untouched pieces aren’t written');
  // Read back.
  s = new ShardedJson(path.join(dir, 'meta'), { legacy: path.join(dir, 'meta.json') });
  assert.strictEqual(s.data.m.k5.plot, 'new');
  assert.ok(!('k6' in s.data.m));
  assert.strictEqual(s.data.m.knew.n, -1);
  assert.strictEqual(Object.keys(s.data.m).length, 20000);
  // On shutdown, pending changes are written at once.
  s.data.m.k7 = { n: 'last' };
  s.save();
  JsonFile.flushAll();
  s = new ShardedJson(path.join(dir, 'meta'));
  assert.strictEqual(s.data.m.k7.n, 'last');
});

test('a JsonFile written in the background still ends up on disk, and on shutdown straight away', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgjson-'));
  const f = path.join(dir, 'map.json');
  const j = new JsonFile(f, { m: {} }, { delay: 5, background: true });
  j.data.m.a = 1; j.save();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { m: { a: 1 } });
  j.data.m.b = 2; j.save();
  JsonFile.flushAll();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { m: { a: 1, b: 2 } });
});

test('a broken guide (an element that never closes) is read past instead of filling memory', async () => {
  function* gen() {
    yield '<?xml version="1.0"?><tv><channel id="a"><display-name>A</display-name></channel>';
    yield '<programme start="20261102000000 +0000" stop="20261102010000 +0000" channel="a"><title>Never closed';
    const pad = 'x'.repeat(1 << 20);
    for (let i = 0; i < 30; i++) yield pad;
    yield '<programme start="20261102010000 +0000" stop="20261102020000 +0000" channel="a"><title>Fine</title></programme></tv>';
  }
  const r = await parseXMLTV(Readable.from(gen()));
  assert.deepStrictEqual(Object.keys(r.channels), ['a']);
  assert.strictEqual(r.programmeCount, 1);
});
