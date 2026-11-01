'use strict';
// node test/recs.test.js — the recommendation engine on a made-up catalogue (no network, no server).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Recs } = require('../lib/recs');

const films = [];
const add = (k, n, extra) => films.push({ k, t: 'movie', n, lg: ['en'], g: 'Movies', ...extra });
// What the profile liked.
add('s1', 'Heist One', { gn: ['Crime', 'Thriller'], cast: 'Ana Actor, Bo Lead', dir: 'Di Rector' });
add('s2', 'Heist Two', { gn: ['Crime', 'Thriller'], cast: 'Ana Actor, Cy Side', dir: 'Di Rector' });
add('s3', 'Space Trip', { gn: ['Science Fiction'], cast: 'Ana Actor, Dee Star', dir: 'Eve Maker' });
// Candidates.
for (let i = 1; i <= 8; i++) add('c' + i, 'Candidate ' + i, { gn: ['Crime'], cast: i <= 5 ? 'Ana Actor' : 'Someone Else', dir: i <= 3 ? 'Di Rector' : 'Other Person', r: 6 });
for (let i = 1; i <= 30; i++) add('x' + i, 'Filler ' + i, { gn: ['Romance'], cast: 'Nobody ' + i, dir: 'Nobody' });
const byKey = new Map(films.map((f) => [f.k, f]));
const byTitle = new Map(films.map((f) => [f.n.toLowerCase(), f.k]));
const catalog = {
  version: 'v1', items: films,
  get: (k) => byKey.get(k) || null,
  filterFor: () => ({ test: () => true }),
  findTitle: (t) => (byTitle.has(t.toLowerCase()) ? [byTitle.get(t.toLowerCase())] : []),
};
// TMDB "people who liked X also liked": c1–c4 are suggested by two or three favourites.
const REL = { s1: ['Candidate 1', 'Candidate 2', 'Candidate 3', 'Candidate 4', 'Candidate 7'], s2: ['Candidate 1', 'Candidate 2', 'Candidate 3', 'Candidate 4'], s3: ['Candidate 1', 'Candidate 2', 'Candidate 8'] };
const tmdb = { enabled: () => true, related: async (it) => (REL[it.k] || []).map((title, i) => ({ title, type: 'movie', w: 1 - i * 0.1 })) };
const now = Date.now();
const data = { history: ['s1', 's2', 's3'].map((k, i) => ({ k, at: now - i * 3600e3, s: 5000 })), progress: {}, ratings: { s1: 1, s2: 1 }, list: [], hidden: [], impressions: {} };
const userdata = { of: () => ({ data }) };
const accounts = { profile: () => ({ id: 'p1', interests: [] }), profiles: [{ id: 'p1' }] };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recs-'));

(async () => {
  const r = await new Recs({ dir, catalog, userdata, accounts, tmdb }).compute('p1');
  const row = (prefix) => r.rows.find((x) => x.id.startsWith(prefix));
  let pass = 0;
  const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n      ', e.message); process.exitCode = 1; } };
  t('nothing already watched is recommended', () => assert.ok(!r.top.some((k) => k.startsWith('s'))));
  t('titles several favourites point to come first in Top picks', () => assert.deepStrictEqual(r.top.slice(0, 2).sort(), ['c1', 'c2']));
  t('a combined "recommended by several things you watched" row', () => {
    const m = row('mix:');
    assert.ok(m, 'no mix row: ' + r.rows.map((x) => x.id).join(', '));
    assert.ok(/^Because you watched (Heist One|Heist Two|Space Trip), (Heist One|Heist Two|Space Trip) and more$/.test(m.title), m.title);
    assert.ok(['c1', 'c2', 'c3', 'c4'].every((k) => m.keys.includes(k)));
    assert.ok(!m.keys.includes('c7') && !m.keys.includes('c8'), 'only one favourite suggested c7/c8');
  });
  t('"More with" the actor who is in all three favourites', () => { const c = row('cast:'); assert.ok(c && c.title === 'More with Ana Actor', JSON.stringify(c)); assert.ok(['c1', 'c2', 'c3', 'c4', 'c5'].every((k) => c.keys.includes(k))); });
  t('"Directed by" the director of two favourites', () => { const d = row('dir:'); assert.ok(d && d.title === 'Directed by Di Rector', JSON.stringify(d)); assert.deepStrictEqual(d.keys.slice().sort(), ['c1', 'c2', 'c3']); });
  t('"Because you watched" rows from TMDB', () => assert.ok(r.rows.some((x) => x.id === 'because:s1')));
  t('saved to disk per profile', () => assert.ok(fs.existsSync(path.join(dir, 'p1.recs.json'))));
  console.log(`${pass} passed`);
})();
