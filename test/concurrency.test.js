// Watching at once (lib/concurrency.js): streams per provider counted every minute, hourly peaks and averages, time at
// the connection limit, people turned away, the week grid in the admin's time, and old data dropped.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Concurrency } = require('../lib/concurrency');

test('watching at once: per provider, per hour, against the limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conc-'));
  let use = new Map();
  const c = new Concurrency(dir, {
    usage: () => use,
    lists: () => [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }],
    limitOf: (id) => (id === 'A' ? 2 : 0),
  }, { every: 0 });
  const H = 3600e3, M = 60e3;
  const t0 = Date.UTC(2026, 10, 2, 18, 0, 0); // a Monday, 18:00 UTC
  const viewers = (n) => Array.from({ length: n }, (_, i) => ({ id: 'c' + i }));
  // 18:00–18:09: A has 1, then 2 (its limit) for 5 minutes; B has 3.
  for (let m = 0; m < 10; m++) {
    use = new Map([['A', viewers(m < 5 ? 1 : 2)], ['B', viewers(3)]]);
    c.sample(t0 + m * M);
  }
  // 19:00: A has nobody.
  use = new Map();
  c.sample(t0 + H);
  c.turnedAway('s1|k', ['A'], t0 + 8 * M);
  c.turnedAway('s1|k', ['A'], t0 + 8 * M + 1000); // (the same person again within a minute: once)
  c.turnedAway('s2|k', ['A', 'A', ''], t0 + 9 * M);
  use = new Map([['A', viewers(1)]]);
  const r = c.report(7, 360, t0 + H + 5 * M); // the admin is at UTC−6
  const a = r.providers.find((p) => p.id === 'A'), b = r.providers.find((p) => p.id === 'B');
  assert.strictEqual(a.now, 1);
  assert.strictEqual(a.limit, 2);
  assert.strictEqual(a.peak, 2);
  assert.strictEqual(a.peakAt, t0);
  assert.strictEqual(a.fullMins, 5);
  assert.strictEqual(a.away, 2);
  assert.strictEqual(a.mins, 11);
  assert.ok(Math.abs(a.avg - 15 / 11) < 1e-9);
  assert.deepStrictEqual(a.hours.map((h) => [h.t, h.peak, h.full, h.away]), [[t0, 2, 5, 2], [t0 + H, 0, 0, 0]]);
  assert.strictEqual(b.limit, 0);
  assert.strictEqual(b.peak, 3);
  assert.strictEqual(b.fullMins, 0, 'no limit known: never "at the limit"');
  assert.strictEqual(r.providers[0].id, 'B', 'busiest first');
  // 18:00 UTC on a Monday is noon on Monday at UTC−6.
  assert.deepStrictEqual(a.grid[1][12], [2, 1.5, 5]);
  assert.strictEqual(r.minutes.length, 11);
  assert.deepStrictEqual(r.minutes[9][1], { A: 2, B: 3 });
  // Kept on disk, and old data goes.
  c.store.flush();
  const again = new Concurrency(dir, { usage: () => new Map(), lists: () => [{ id: 'A', name: 'Alpha' }], limitOf: () => 2 }, { every: 0 });
  assert.strictEqual(again.report(7, 0, t0 + 2 * H).providers.find((p) => p.id === 'A').peak, 2);
  again.sample(t0 + 3 * 86400e3);
  assert.ok(again.store.data.minutes.every((m) => m.t > t0 + H), 'minutes older than 48 hours go');
  again.sample(t0 + 121 * 86400e3);
  assert.ok(!again.store.data.hours.B, 'hours older than 120 days go');
  assert.strictEqual(again.report(7, 0, t0 + 121 * 86400e3).providers.find((p) => p.id === 'A').peak, 0);
  again.reset();
  assert.deepStrictEqual(again.store.data.hours, {});
});
