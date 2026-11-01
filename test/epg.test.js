// Only the guide programmes of channels the catalogue uses stay in memory; the rest is read back when needed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Epg } = require('../lib/epg');

test('keeps only used channels in memory, still knows the others, reads them back when they become used', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-'));
  const now = Date.now();
  const prog = (t) => [{ s: now - 1800e3, e: now + 1800e3, t }];
  fs.writeFileSync(path.join(dir, 'g1.json'), JSON.stringify({ channels: { 'a.us': { names: ['A'] }, 'b.us': { names: ['B'] } }, programmes: { 'a.us': prog('News A'), 'b.us': prog('News B') } }));
  let e = new Epg(dir);
  assert.ok(e.has('a.us') && e.has('b.us'));
  await e.useOnly(new Set(['a.us']));
  assert.strictEqual(e.idx.programmes.has('b.us'), false, 'b dropped from memory');
  assert.ok(e.has('b.us'), 'but still known to have programmes');
  assert.strictEqual(e.resolve({ name: 'B' }), 'b.us', 'and still linkable by name');
  // The next start reads only what's needed.
  e = new Epg(dir);
  assert.deepStrictEqual([...e.idx.programmes.keys()], ['a.us']);
  // A channel that becomes used is read back from disk.
  await e.useOnly(new Set(['a.us', 'b.us']));
  assert.strictEqual(e.nowNext('b.us').now.t, 'News B');
  // New guide data keeps the full copy on disk but only the needed part in memory.
  await e.useOnly(new Set(['a.us']));
  e.setSource('g1', { channels: { 'a.us': { names: ['A'] }, 'b.us': { names: ['B'] } }, programmes: { 'a.us': prog('A2'), 'b.us': prog('B2') } });
  assert.strictEqual(e.idx.programmes.has('b.us'), false);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'g1.json'), 'utf8')).programmes['b.us']);
});
