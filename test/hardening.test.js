'use strict';
// Things found by reading the whole project again: each one a way the server could be held up, data lost, or a limit got round.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Overrides } = require('../lib/overrides');
const { ErrorReports } = require('../lib/errors');
const { JsonFile } = require('../lib/store');
const { Stats } = require('../lib/stats');

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), n + '-'));

test('the parental PIN: unlocked for the profile that entered it, and wrong guesses add up across devices and profiles', () => {
  const dir = tmp('ov');
  const ov = new Overrides(dir);
  ov.setPin('4321');
  const mum = { id: 'mum' }, teen = { id: 'teen' };
  assert.ok(ov.unlock('tv', mum, '4321') > Date.now());
  assert.strictEqual(ov.allowed({ sess: { id: 'tv' }, profile: mum }), true);
  assert.strictEqual(ov.allowed({ sess: { id: 'tv' }, profile: teen }), false, 'another profile on the same TV');
  assert.strictEqual(ov.allowed({ sess: { id: 'tv' }, profile: { id: 'k', kids: true } }), false);
  // 15 wrong guesses, each from a fresh device and a fresh profile (so neither of their own counts stops it)…
  for (let i = 0; i < 15; i++) assert.throws(() => ov.unlock('s' + i, { id: 'p' + i }, '0000'), /isn’t right/);
  // …and it's locked for everyone, the right PIN included, for a while.
  assert.throws(() => ov.unlock('fresh', { id: 'fresh' }, '4321'), /Too many wrong PINs/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a stack line made to be slow to read doesn’t hold the server', () => {
  const dir = tmp('er');
  const er = new ErrorReports({ dataDir: dir });
  const t0 = Date.now();
  const out = er.mapStack('at' + ' '.repeat(11000) + 'x\n    at f (http://h/app.js?v=1:10:20)', '1');
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
  assert.ok(Array.isArray(out.frames));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a data file that can’t be read just now is left alone — not replaced by an empty one', () => {
  const dir = tmp('st');
  const f = path.join(dir, 'u.json');
  fs.writeFileSync(f, JSON.stringify({ list: [1, 2, 3] }));
  // (A directory where the file should be: reading it fails with something other than "not found" or bad JSON.)
  const g = path.join(dir, 'busy.json');
  fs.mkdirSync(g);
  const j = new JsonFile(g, { list: [] });
  assert.strictEqual(j.readFailed, true);
  j.data.list.push(9); j.flush(true);
  assert.ok(fs.statSync(g).isDirectory(), 'nothing written over it');
  // A file that reads but isn't JSON still falls back to its .bak, with a copy kept.
  fs.writeFileSync(f + '.bak', JSON.stringify({ list: [7] }));
  fs.writeFileSync(f, '{ broken');
  const k = new JsonFile(f, { list: [] });
  assert.deepStrictEqual(k.data.list, [7]);
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('u.json.corrupt-')));
  JsonFile.all.delete(j); JsonFile.all.delete(k);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('statistics: a provider named like something every object has stays a name', () => {
  const dir = tmp('sx');
  const st = new Stats(dir);
  const o = {};
  st._bump(o, '__proto__', 'plays', 1);
  st._bump(o, 'constructor', 'plays', 1);
  assert.strictEqual({}.plays, undefined);
  assert.deepStrictEqual(Object.keys(o).sort(), ['(__proto__)', '(constructor)']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('who may add profiles is the admin\'s setting, with a kids profile in the house too', () => {
  const { Accounts } = require('../lib/accounts');
  const dir = tmp('acc');
  const acc = new Accounts(dir, { defaultPassword: 'house-password' });
  const admin = acc.create({ name: 'Admin', pin: '1234' }, null, {});
  acc.create({ name: 'Kid', kids: true }, { profileId: admin.id }, {});
  // Left off: anyone here can add one (the admin's choice, said on the page).
  assert.ok(acc.create({ name: 'Visitor' }, { profileId: null }, { adminOnlyProfiles: false }).id);
  // Turned on: only from the admin's profile.
  assert.throws(() => acc.create({ name: 'Another' }, { profileId: null }, { adminOnlyProfiles: true }), /Only the admin/);
  assert.ok(acc.create({ name: 'Another' }, { profileId: admin.id }, { adminOnlyProfiles: true }).id);
  fs.rmSync(dir, { recursive: true, force: true });
});

// (The pieces above keep timers of their own — saving later, tidying up: nothing to wait for here.)
test.after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });
