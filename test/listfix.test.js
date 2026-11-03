// Lists: a refresh where part of an Xtream answer fails, empty answers in the details cache, names in other
// scripts as merge keys, guides asked for twice at once, and changes or removals while a refresh runs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Lists } = require('../lib/lists');
const { Catalog, norm } = require('../lib/catalog');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'listfix-'));
const settings = () => ({ userAgent: 'test', tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [], epgDays: 2, defaultLangs: [] });
const newLists = () => new Lists({ dir: tmp(), media: {}, getSettings: settings });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) }));
  });
}

/** A fake Xtream panel; `mode[action]` makes one answer go wrong: html, auth0, error, empty, http500. */
function fakeXtream() {
  const mode = {};
  const hits = [];
  const data = {
    '': { user_info: { auth: 1, status: 'Active', exp_date: '0' }, server_info: { timezone: 'UTC' } },
    get_live_categories: [{ category_id: '1', category_name: 'News' }],
    get_live_streams: [{ stream_id: 1, name: 'News One', category_id: '1' }, { stream_id: 2, name: 'News Two', category_id: '1' }],
    get_vod_categories: [{ category_id: '2', category_name: 'Films' }],
    get_vod_streams: { 10: { stream_id: 10, name: 'Film A', category_id: '2', container_extension: 'mkv' } }, // (keyed by id: some panels do)
    get_series_categories: [],
    get_series: [{ series_id: 20, name: 'Show A' }],
    get_series_info: { info: { plot: 'p' }, episodes: { 1: [{ id: 200, episode_num: 1, title: 'Pilot', container_extension: 'mp4' }] } },
    get_vod_info: { info: { plot: 'film' }, movie_data: { stream_id: 10 } },
  };
  const p = serve((req, res) => {
    const u = new URL(req.url, 'http://x');
    const a = u.searchParams.get('action') || '';
    hits.push(a);
    const m = mode[a];
    if (m === 'http500') { res.writeHead(500); return res.end('oops'); }
    if (m === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><body>Too many requests</body></html>'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (m === 'empty') return res.end('');
    if (m === 'auth0') return res.end(JSON.stringify({ user_info: { auth: 0 } }));
    if (m === 'error') return res.end(JSON.stringify({ error: 'Something went wrong' }));
    res.end(JSON.stringify(data[a] === undefined ? [] : data[a]));
  });
  return p.then((s) => ({ ...s, mode, hits, data }));
}

test('Xtream: a part that fails or isn’t a list keeps the saved copy of that part, and says so', { timeout: 30000 }, async () => {
  const x = await fakeXtream();
  try {
    const lists = newLists();
    const v = await lists.add({ type: 'xtream', server: x.base, username: 'u', password: 'p' });
    assert.strictEqual(v.status.ok, true);
    assert.strictEqual(v.status.count, 4);
    const names = () => lists.itemsFor(lists.get(v.id)).items.map((i) => i.name).sort();
    assert.deepStrictEqual(names(), ['Film A', 'News One', 'News Two', 'Show A']);

    // A "Too many requests" page for the channels, a login error for the films, an error object for the series.
    x.mode.get_live_streams = 'html';
    x.mode.get_vod_streams = 'auth0';
    x.mode.get_series = 'error';
    x.mode.get_live_categories = 'http500';
    const r = await lists.refresh(v.id);
    assert.strictEqual(r.status.ok, false, 'not reported as all fine');
    assert.strictEqual(r.status.partial, true);
    assert.match(r.status.error, /live channels/);
    assert.match(r.status.error, /films/);
    assert.match(r.status.error, /series/);
    assert.strictEqual(r.status.count, 4);
    assert.deepStrictEqual(names(), ['Film A', 'News One', 'News Two', 'Show A'], 'nothing disappeared, nothing made up');
    assert.ok(!names().some((n) => /undefined/.test(n)));
    const saved = JSON.parse(fs.readFileSync(lists.rawFile(lists.get(v.id)), 'utf8'));
    assert.strictEqual(saved.live.length, 2, 'the good saved copy wasn’t overwritten');
    assert.strictEqual(saved.cats.live[0].category_name, 'News', 'categories kept too');
    assert.strictEqual(lists.itemsFor(lists.get(v.id)).items.find((i) => i.name === 'News One').group, 'News');

    // Working again: all fine.
    for (const k of Object.keys(x.mode)) delete x.mode[k];
    x.data.get_live_streams.push({ stream_id: 3, name: 'News Three', category_id: '1' });
    const ok = await lists.refresh(v.id);
    assert.strictEqual(ok.status.ok, true);
    assert.strictEqual(ok.status.error, null);
    assert.ok(!('partial' in ok.status));
    assert.strictEqual(ok.status.count, 5);

    // No saved copy to fall back on: adding it fails rather than saving a list without its channels.
    x.mode.get_live_streams = 'html';
    await assert.rejects(newLists().add({ type: 'xtream', server: x.base, username: 'u', password: 'p' }), /live channels/);
  } finally { await x.close(); }
});

test('details cache: an empty or wrong answer isn’t kept; the older copy is used instead', { timeout: 30000 }, async () => {
  const x = await fakeXtream();
  try {
    const lists = newLists();
    const v = await lists.add({ type: 'xtream', server: x.base, username: 'u', password: 'p' });
    const f = path.join(lists.dir, 'xt', `${v.id}-s20.json`);
    // Empty body, nothing saved yet: an error, and nothing cached.
    x.mode.get_series_info = 'empty';
    await assert.rejects(lists.xtSeries(v.id, 20), /empty/);
    assert.ok(!fs.existsSync(f));
    x.mode.get_series_info = 'auth0';
    await assert.rejects(lists.xtSeries(v.id, 20));
    assert.ok(!fs.existsSync(f));
    // A real answer is kept…
    delete x.mode.get_series_info;
    assert.strictEqual((await lists.xtSeries(v.id, 20)).episodes.length, 1);
    // …and when it's out of date and the provider sends nothing, the old one is used and stays.
    const old = new Date(Date.now() - 2 * 86400e3);
    fs.utimesSync(f, old, old);
    x.mode.get_series_info = 'empty';
    assert.strictEqual((await lists.xtSeries(v.id, 20)).episodes.length, 1);
    assert.ok(JSON.parse(fs.readFileSync(f, 'utf8')).episodes, 'not replaced by null');
    // A poisoned copy from before (null) isn't used: asked again.
    fs.writeFileSync(f, 'null');
    delete x.mode.get_series_info;
    const before = x.hits.filter((a) => a === 'get_series_info').length;
    assert.strictEqual((await lists.xtSeries(v.id, 20)).episodes.length, 1);
    assert.strictEqual(x.hits.filter((a) => a === 'get_series_info').length, before + 1);
    // Films: the same.
    x.mode.get_vod_info = 'empty';
    await assert.rejects(lists.xtVod(v.id, 10));
    assert.ok(!fs.existsSync(path.join(lists.dir, 'xt', `${v.id}-v10.json`)));
    delete x.mode.get_vod_info;
    assert.strictEqual((await lists.xtVod(v.id, 10)).plot, 'film');
  } finally { await x.close(); }
});

test('Stalker: an episode link with no series details gives an error, not a TypeError', async () => {
  const lists = newLists();
  lists.store.data.lists.push({ id: 'S', type: 'stalker', name: 'Portal', enabled: true, portal: 'http://127.0.0.1:9/c/' });
  lists.stalker.cmds.set('S', new Map());
  let info = { seasons: [] };
  lists.stalker.seriesInfo = async () => info;
  lists.stalker.createLink = async (l, kind, id, cmd) => ({ kind, id, cmd });
  fs.writeFileSync(path.join(lists.dir, 'xt', 'S-ss7.json'), 'null'); // (what the old code could leave behind)
  await assert.rejects(lists.stalkerLink('S', 'ep', '7|7:1~2'), (e) => !(e instanceof TypeError) && /empty/.test(e.message));
  info = { seasons: [{ id: '7:1', season: 1, cmd: 'CMD1', eps: [1, 2] }] };
  assert.deepStrictEqual(await lists.stalkerLink('S', 'ep', '7|7:1~2'), { kind: 'ep', id: '7:1~2', cmd: 'CMD1' });
});

test('merge keys: names in Greek, Hebrew, Thai… stay apart; names that keep letters keep the same key', () => {
  assert.notStrictEqual(norm('ΑΝΤ1'), norm('ΕΡΤ1'));
  assert.notStrictEqual(norm('ערוץ 12'), norm('כאן 12'));
  assert.notStrictEqual(norm('ช่อง 3'), norm('ไทย 3'));
  assert.strictEqual(norm('ΕΡΤ1 HD'), norm('ΕΡΤ1'), 'quality tags still don’t matter');
  assert.notStrictEqual(norm('स्टार प्लस'), norm('ज़ी टीवी'));
  // Unchanged for everything that already had letters (or was only digits / tags).
  const same = { 'BBC One HD': 'bbcone', 'The Office (US)': 'officeus', 'Canal+ FHD': 'canal', 'Россия 1': 'россия1', 'Café Olé': 'cafeole', 'NHK 総合': 'nhk総合', '24': '24', 'HD': '', 'Mega ΗΔ': 'mega' };
  for (const [n, k] of Object.entries(same)) assert.strictEqual(norm(n), k, n);

  const items = ['ΑΝΤ1', 'ΕΡΤ1', 'ΕΡΤ2', 'ΣΚΑΪ'].map((name, i) => ({ name, type: 'live', url: `http://p/${i}.ts`, group: 'GR | Ελληνικά', lang: 'el' }));
  items.push({ name: 'ΕΡΤ1 HD', type: 'live', url: 'http://p/9.ts', group: 'GR | Ελληνικά', lang: 'el' });
  items.push(...['Η Νύχτα', 'Το Σπίτι'].map((name, i) => ({ name, type: 'movie', url: `http://p/m${i}.mp4`, group: 'GR | Ταινίες', lang: 'el', year: 2020 })));
  const ls = { all: () => [{ id: 'A', name: 'A', enabled: true, type: 'url' }], parsed: new Map([['A', { items, epgUrls: [] }]]) };
  const c = new Catalog({ lists: ls, epg: { has: () => false, resolve: () => null }, getSettings: settings });
  c.build();
  const live = c.items.filter((i) => i.t === 'live');
  assert.strictEqual(live.length, 4, 'four channels, the HD copy merged into its own channel');
  assert.strictEqual(live.find((i) => /ΕΡΤ1/.test(i.n)).alts.length, 1);
  assert.ok(live.filter((i) => i.n !== 'ΕΡΤ1').every((i) => !(i.alts || []).length));
  assert.strictEqual(c.items.filter((i) => i.t === 'movie').length, 2);
});

test('a guide asked for again while it downloads is downloaded once', { timeout: 20000 }, async () => {
  let hits = 0;
  const g = await serve(async (req, res) => {
    hits++;
    await wait(300);
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end('<?xml version="1.0"?><tv><channel id="a"><display-name>A</display-name></channel></tv>');
  });
  try {
    const lists = newLists();
    const got = [];
    lists.onGuides = (what) => { if (what === 'data') got.push(what); };
    lists.guides().push({ id: 'G', url: g.base + '/guide.xml', name: 'G', auto: false, enabled: true, status: {} });
    const a = lists.refreshGuide('G'), b = lists.refreshGuide('G');
    assert.strictEqual(a, b, 'the running job');
    await a;
    assert.strictEqual(hits, 1);
    assert.strictEqual(got.length, 1);
    assert.strictEqual(lists.guides()[0].status.ok, true);
    await lists.refreshGuide('G');
    assert.strictEqual(hits, 2, 'once done, it can run again');
    await assert.rejects(lists.refreshGuide('nope'), /not found/);
  } finally { await g.close(); }
});

test('a new address saved while a refresh runs is fetched once that one ends; a list removed meanwhile leaves nothing', { timeout: 20000 }, async () => {
  const hits = [];
  let delay = 0;
  const s = await serve(async (req, res) => {
    hits.push(req.url);
    await wait(delay);
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
    res.end(`#EXTM3U\n#EXTINF:-1,Chan ${req.url.slice(1, 2)}\nhttp://stream.invalid/${req.url.slice(1, 2)}.ts\n`);
  });
  try {
    const lists = newLists();
    const v = await lists.add({ type: 'url', url: s.base + '/a.m3u' });
    delay = 300;
    const job = lists.refresh(v.id);
    await wait(50);
    lists.update(v.id, { url: s.base + '/b.m3u' });
    await job;
    for (let i = 0; i < 50 && (lists.running.has(v.id) || !hits.includes('/b.m3u')); i++) await wait(50);
    while (lists.running.has(v.id)) await wait(20);
    assert.ok(hits.includes('/b.m3u'), 'the new address was fetched');
    assert.strictEqual(lists.itemsFor(lists.get(v.id)).items.map((i) => i.name).join(), 'Chan b');

    // Removed while refreshing: no file written, no hosts registered.
    const job2 = lists.refresh(v.id);
    await wait(50);
    const raw = lists.rawFile(lists.get(v.id));
    lists.remove(v.id);
    await job2;
    assert.ok(!fs.existsSync(raw));
    assert.ok(!lists.parsed.has(v.id));
    assert.ok(![...lists.hostOwner.values()].includes(v.id));
  } finally { await s.close(); }
});
