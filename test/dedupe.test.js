// Duplicate titles across (and within) providers become one entry; different titles stay apart.
const test = require('node:test');
const assert = require('node:assert');
const { Catalog } = require('../lib/catalog');
const T = require('../lib/titles');

test('end tags come off titles (language, cinema recordings, a dashed year)', () => {
  const t = (n, y) => { const r = T.tidyVod(n, y || 0); return [r.n, r.y, r.cam]; };
  assert.deepStrictEqual(t('Preacher-eng'), ['Preacher', 0, false]);
  assert.deepStrictEqual(t('Parish_eng'), ['Parish', 0, false]);
  assert.deepStrictEqual(t('Grafted - 2024 sub'), ['Grafted', 2024, false]);
  assert.deepStrictEqual(t('Evil Dead Burn - 2026 CAM'), ['Evil Dead Burn', 2026, true]);
  assert.deepStrictEqual(t('The Critic hdts'), ['The Critic', 0, true]);
  assert.deepStrictEqual(t("Now You See Me: Now You Don't (HDAM)"), ["Now You See Me: Now You Don't", 0, true]);
  assert.deepStrictEqual(t('Things Heard & Seen ( 2021)'), ['Things Heard & Seen', 2021, false]);
  assert.deepStrictEqual(t('Project Power-2020', 2020), ['Project Power', 2020, false]);
  // …but not real titles
  for (const n of ['Spy Cam', 'Yellow Sub', 'Spider-Man', 'Jay-Z', 'Blade Runner 2049']) assert.strictEqual(T.tidyVod(n).n, n);
  assert.strictEqual(T.tidyVod('Act-1978', 2020).n, 'Act-1978'); // the list says 2020: 1978 is part of the name
  assert.strictEqual(T.tidyVod('Ataturk 1881-1919').n, 'Ataturk 1881-1919'); // a span
});

function catalog(lists, series = {}) {
  const parsed = new Map(lists.map((l) => [l.id, { items: l.items, epgUrls: [] }]));
  const ls = {
    all: () => lists.map((l) => ({ id: l.id, name: l.id, enabled: true, type: 'xtream' })),
    parsed,
    xtSeries: async (lid, id) => { const s = series[`${lid}:${id}`]; if (!s) throw new Error('no such series'); return { info: {}, episodes: s }; },
  };
  const c = new Catalog({ lists: ls, epg: { has: () => false, resolve: () => null }, getSettings: () => ({ tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [] }) });
  c.build();
  return c;
}
const movie = (name, extra) => ({ name, type: 'movie', url: `http://p/${encodeURIComponent(name)}${Math.random()}.mp4`, group: 'EN | Movies', lang: 'en', ...extra });
const show = (name, id, extra) => ({ name, type: 'show', url: '', group: 'EN | Series', lang: 'en', xt: { kind: 'series', id }, ...extra });
const titles = (c, t) => c.items.filter((i) => i.t === t).map((i) => `${i.n}${i.y ? ' ' + i.y : ''}`).sort();

test('films: same name and year, a copy without a year, a year apart with a TMDB id; different films stay apart', () => {
  const c = catalog([
    { id: 'A', items: [movie('Key & Peele', { year: 2012 }), movie('The Hunger Games (2012)', { tmdb: '70160' }), movie('Ghostbusters (1984)', { tmdb: '620' }), movie('Lee (2024)', { tmdb: '832964' }), movie('GP van Las Vegas - Race (2024)')] },
    { id: 'B', items: [movie('Key And Peele', { year: 2012 }), movie('The Hunger Games'), movie('Ghostbusters (2016)', { tmdb: '43074' }), movie('Lee (2023)'), movie('GP van Las Vegas - Race (2025)'), movie('Preacher Movie-eng (2019)'), movie('Contract Killers (2008)', { tmdb: '13277' })] },
    { id: 'C', items: [movie('Preacher Movie (2019)'), movie('Contract Killers (2014)', { tmdb: '264891' })] },
  ]);
  assert.deepStrictEqual(titles(c, 'movie'), ['Contract Killers 2008', 'Contract Killers 2014', 'GP van Las Vegas - Race 2024', 'GP van Las Vegas - Race 2025', 'Ghostbusters 1984', 'Ghostbusters 2016', 'Key & Peele 2012', 'Lee 2024', 'Preacher Movie 2019', 'The Hunger Games 2012']);
  const kp = c.items.find((i) => i.n === 'Key & Peele');
  assert.strictEqual(kp.alts.length, 1, 'the other copy is a backup');
  // History made under the old keys moves to the merged one.
  assert.ok([...c.renamed.values()].includes(kp.k));
});

test('a series on two providers lists the seasons both have once, and the extra seasons of either', async () => {
  const ep = (s, e, u) => ({ id: `${u}${s}${e}`, season: s, episode: e, title: '', url: `http://${u}/${s}/${e}.mp4` });
  const c = catalog([
    { id: 'A', items: [show('Blue Lights_eng', 1, { year: 2023, tmdb: '218344' })] },
    { id: 'B', items: [show('Blue Lights', 7, { year: 2023, tmdb: '218344' }), show('Ask ve Gozyasi', 8, { year: 2025, tmdb: '298792' })] },
    { id: 'C', items: [show('Ask ve Gozyasi - Queen of Tears', 9, { year: 2025, tmdb: '298792' })] },
  ], {
    'A:1': [ep(1, 1, 'a'), ep(1, 2, 'a')],
    'B:7': [ep(1, 1, 'b'), ep(1, 2, 'b'), ep(2, 1, 'b')],
    'B:8': [ep(1, 1, 'b')], 'C:9': [ep(1, 1, 'c')],
  });
  assert.deepStrictEqual(titles(c, 'show'), ['Ask ve Gozyasi 2025', 'Blue Lights 2023']);
  const bl = c.items.find((i) => i.n === 'Blue Lights');
  const eps = await c.episodes(bl.k);
  assert.deepStrictEqual(eps.map((e) => `S${e.s}E${e.e} ${e.u} +${(e.alts || []).length}`), ['S1E1 http://a/1/1.mp4 +1', 'S1E2 http://a/1/2.mp4 +1', 'S2E1 http://b/2/1.mp4 +0']);
});

test('a series on several lists: once one copy has answered, a slow provider holds the episodes back 2.5 s at most', async () => {
  const ep = (s, e, h) => ({ season: s, episode: e, title: `S${s}E${e}`, url: `http://${h}/${s}/${e}.mp4`, id: `${h}${s}${e}` });
  const c = catalog([
    { id: 'A', items: [show('Slow Tide', 1, { year: 2024, tmdb: '1' })] },
    { id: 'B', items: [show('Slow Tide', 2, { year: 2024, tmdb: '1' })] },
  ]);
  let slowDone = false;
  c.lists.xtSeries = (lid) => (lid === 'A'
    ? new Promise((ok) => setTimeout(() => { slowDone = true; ok({ info: {}, episodes: [ep(1, 1, 'a'), ep(1, 2, 'a')] }); }, 5000))
    : Promise.resolve({ info: {}, episodes: [ep(1, 1, 'b')] }));
  const st = c.items.find((i) => i.n === 'Slow Tide');
  const t0 = Date.now();
  const eps = await c.episodes(st.k);
  const ms = Date.now() - t0;
  assert.ok(ms >= 2400 && ms < 4000, `answered after ${ms} ms`);
  assert.strictEqual(slowDone, false);
  assert.deepStrictEqual(eps.map((e) => `S${e.s}E${e.e} ${e.u}`), ['S1E1 http://b/1/1.mp4'], 'what the copy that answered has');
  // The slow copy is in the next answer — added after the one that was there: the copy an episode plays from, and the
  // order of its backups, never change between reads (a player holding "backup 1" keeps getting the same one).
  c.lists.xtSeries = (lid) => Promise.resolve(lid === 'A' ? { info: {}, episodes: [ep(1, 1, 'a'), ep(1, 2, 'a')] } : { info: {}, episodes: [ep(1, 1, 'b')] });
  const again = await c.episodes(st.k);
  assert.deepStrictEqual(again.map((e) => `S${e.s}E${e.e} ${e.u} ${(e.alts || []).map((a) => a.u).join(',')}`), ['S1E1 http://b/1/1.mp4 http://a/1/1.mp4', 'S1E2 http://a/1/2.mp4 ']);
  assert.strictEqual(again[0], eps[0], 'the same episode, added to');
  // A list's copy that changed its address takes its old place.
  c.lists.xtSeries = (lid) => Promise.resolve(lid === 'A' ? { info: {}, episodes: [ep(1, 1, 'a2'), ep(1, 2, 'a')] } : { info: {}, episodes: [ep(1, 1, 'b2')] });
  const third = await c.episodes(st.k);
  assert.strictEqual(`${third[0].u} ${third[0].alts.map((a) => a.u).join(',')}`, 'http://b2/1/1.mp4 http://a2/1/1.mp4');
});
