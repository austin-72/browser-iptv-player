// Stalker portals, Jellyfin/Plex libraries, the outputs for other apps (Xtream login, HDHomeRun) and 24/7 channels.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Lists } = require('../lib/lists');
const { Catalog } = require('../lib/catalog');
const { Outputs, fnv31, privateIp } = require('../lib/outputs');
const { MyChannels, positionAt, scheduleBetween } = require('../lib/mychannels');
const { normMac, apiCandidates } = require('../lib/stalker');
const mocks = require('./mock/p4mocks');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p4-'));
const settings = () => ({ userAgent: 'test', tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [], epgDays: 2, defaultLangs: [] });
const newLists = () => new Lists({ dir: tmp(), media: {}, getSettings: settings });

test('Stalker: MAC and portal addresses are read the way people paste them', () => {
  assert.strictEqual(normMac('00-1a-79-ab-cd-ef'), '00:1A:79:AB:CD:EF');
  assert.strictEqual(normMac('001A79ABCDEF'), '00:1A:79:AB:CD:EF');
  assert.throws(() => normMac('00:1A:79'));
  const c = apiCandidates('portal.example:8080/stalker_portal/c/');
  assert.strictEqual(c.list[0], 'http://portal.example:8080/stalker_portal/server/load.php');
  assert.ok(apiCandidates('http://p.example/c/').list.includes('http://p.example/portal.php'));
});

test('Stalker: handshake, channels, films, series, guide, and the stream address asked for at play time', { timeout: 30000 }, async () => {
  const m = await mocks.stalkerPortal();
  try {
    const lists = newLists();
    const v = await lists.add({ type: 'stalker', portal: m.portal, mac: '00:1a:79:00:00:01' });
    assert.strictEqual(v.status.ok, true, v.status.error);
    assert.strictEqual(v.status.count, 2 + 20 + 1);
    const l = lists.get(v.id);
    assert.ok(l.account && l.account.expires > Date.UTC(2029, 0, 1), 'expiry read from the portal');
    const items = lists.parsed.get(l.id).items;
    const news = items.find((i) => i.name === 'Portal News');
    assert.strictEqual(news.url, `/api/proxy/stalker/${l.id}/live/1`);
    assert.strictEqual(news.group, 'News');
    assert.strictEqual(items.find((i) => i.name === 'Portal Sport').logo, m.base + '/stalker_portal/misc/logos/2.png');
    // Played: create_link gives the real, tokenised address.
    const url = await lists.stalkerLink(l.id, 'live', '1');
    assert.match(url, /\/stream\/live\/1\.ts\?play_token=abc$/);
    assert.ok(lists.stalker.linkHosts.has(new URL(url).host));
    // The token expired: signed in again, once, and the request repeated.
    const before = m.st.handshakes;
    m.st.expireNext = true;
    await lists.stalkerLink(l.id, 'live', '2');
    assert.strictEqual(m.st.handshakes, before + 1);
    // Films and series
    assert.strictEqual(items.filter((i) => i.type === 'movie').length, 20);
    const film = items.find((i) => i.name === 'Portal Film 3');
    assert.strictEqual(film.duration, 95 * 60);
    assert.match(await lists.stalkerLink(l.id, 'vod', film.xt.id), /\/stream\/vod\//);
    const eps = await lists.xtSeries(l.id, '900');
    assert.deepStrictEqual(eps.episodes.map((e) => `${e.season}x${e.episode}`), ['1x1', '1x2', '1x3', '2x1']);
    const epUrl = eps.episodes[1].url;
    const m2 = epUrl.match(/\/ep\/(.+)$/);
    assert.match(await lists.stalkerLink(l.id, 'ep', decodeURIComponent(m2[1])), /eyJzZWFzb24iOjF9-2\.mp4$/);
    // The portal's own guide
    lists._syncGuides();
    const g = lists.guides().find((x) => x.url === `stalker:${l.id}`);
    assert.ok(g, 'a guide from the portal is added');
    let got = null;
    lists.onGuides = (what, id, data) => { if (what === 'data') got = data; };
    await lists.refreshGuide(g.id);
    assert.ok(got && got.programmes[`stalker.${l.id}.1`].length === 2, 'portal guide read');
    // After a restart, the saved copy is read back without the network.
    const again = new Lists({ dir: lists.dir, media: {}, getSettings: settings });
    again.loadSaved();
    assert.strictEqual(again.parsed.get(l.id).items.length, 23);
    // A wrong MAC is refused with the portal's words.
    await assert.rejects(newLists().add({ type: 'stalker', portal: m.portal, mac: '00:1A:79:00:00:99' }), /Unknown MAC/);
  } finally { m.srv.close(); }
});

test('Jellyfin and Plex libraries: films, series, episodes and direct stream addresses', { timeout: 30000 }, async () => {
  const jf = await mocks.jellyfin();
  const px = await mocks.plex();
  try {
    const lists = newLists();
    const v = await lists.add({ type: 'mediaserver', kind: 'jellyfin', server: jf.base + '/web/index.html', username: 'tv', password: 'secret', includeLive: true });
    assert.strictEqual(v.status.ok, true, v.status.error);
    assert.strictEqual(v.password, '••••••••');
    const items = lists.parsed.get(v.id).items;
    const lake = items.find((i) => i.name === 'Lake House Rules');
    assert.strictEqual(lake.url, `${jf.base}/Videos/m1/stream.mkv?static=true&api_key=JT`);
    assert.strictEqual(lake.duration, 6060);
    assert.strictEqual(lake.cast, 'Ada Alves');
    assert.strictEqual(lake.director, 'Kai Sato');
    assert.strictEqual(lake.tmdb, '42');
    assert.match(lake.logo, /\/Items\/m1\/Images\/Primary\?maxHeight=600/);
    assert.ok(items.find((i) => i.name === 'Antenna One' && i.type === 'live'), 'Live TV channels when asked for');
    const eps = await lists.xtSeries(v.id, 's1');
    assert.deepStrictEqual(eps.episodes.map((e) => [e.season, e.episode, e.duration]), [[1, 1, 2880], [1, 2, 0]]);
    assert.strictEqual(eps.episodes[1].url, `${jf.base}/Videos/e2/stream.mp4?static=true&api_key=JT`);
    await assert.rejects(newLists().add({ type: 'mediaserver', kind: 'jellyfin', server: jf.base, username: 'tv', password: 'nope' }), /refused/);

    const p = await lists.add({ type: 'mediaserver', kind: 'plex', server: px.base, token: 'PT' });
    const pit = lists.parsed.get(p.id).items;
    const red = pit.find((i) => i.name === 'Red Horizon');
    assert.strictEqual(red.url, `${px.base}/library/parts/55/123/file.mp4?X-Plex-Token=PT`);
    assert.strictEqual(red.group, 'Films');
    assert.strictEqual(red.tmdb, '77');
    assert.strictEqual(red.duration, 6540);
    const show = pit.find((i) => i.type === 'show');
    const peps = await lists.xtSeries(p.id, show.xt.id);
    assert.strictEqual(peps.episodes[0].url, `${px.base}/library/parts/66/1/file.mkv?X-Plex-Token=PT`);
    // Through the catalogue like any list: the series' episodes are found lazily.
    const cat = new Catalog({ lists, epg: { has: () => false, resolve: () => null }, getSettings: settings });
    cat.build();
    const hl = cat.items.find((i) => i.n === 'Harbor Lights');
    const ce = await cat.episodes(hl.k);
    assert.strictEqual(ce[0].et, 'Low Tide');
  } finally { jf.srv.close(); px.srv.close(); }
});

// ---------------------------------------------------------------- outputs
function outputsFixture() {
  const items = [
    { name: 'News One', type: 'live', url: 'http://prov.example/live/u/p/1.ts', group: 'News', lang: 'en', chno: '1', tvgId: 'news1' },
    { name: 'Kids TV', type: 'live', url: 'http://prov.example/live/u/p/2.ts', group: 'Kids', lang: 'en', chno: '2' },
    { name: 'Header Channel', type: 'live', url: 'http://prov.example/live/u/p/3.m3u8', group: 'News', lang: 'en', chno: '3', headers: { Referer: 'http://x' } },
    { name: 'Grown-up Film (2020)', type: 'movie', url: 'http://prov.example/movie/u/p/10.mkv', group: 'Action', lang: 'en', cert: 'R' },
    { name: 'Family Film (2021)', type: 'movie', url: 'http://prov.example/movie/u/p/11.mp4', group: 'Kids', lang: 'en', cert: 'G' },
    { name: 'A Show', type: 'show', url: '', group: 'Drama', lang: 'en', xt: { kind: 'series', id: 5 } },
  ];
  const ls = {
    all: () => [{ id: 'L', name: 'L', enabled: true, type: 'xtream', account: { maxConnections: '2' } }], parsed: new Map([['L', { items, epgUrls: [] }]]), extras: [],
    xtSeries: async () => ({ info: {}, episodes: [{ id: 77, season: 1, episode: 1, title: 'Pilot', url: 'http://prov.example/series/u/p/77.mkv', duration: 1500 }] }),
  };
  const now = Date.now();
  const epg = { has: (id) => id === 'news1', resolve: ({ tvgId }) => (tvgId === 'news1' ? 'news1' : null), range: () => [{ s: now - 600e3, e: now + 600e3, t: 'Headlines', d: 'Today' }, { s: now + 600e3, e: now + 1200e3, t: 'Weather' }] };
  const cat = new Catalog({ lists: ls, epg, getSettings: settings });
  cat.build();
  const profiles = [{ id: 'A', name: 'Dad', admin: true, restrictions: {} }, { id: 'K', name: 'Kiddo', kids: true, restrictions: { maxCert: 1 } }];
  const accounts = { profiles, profile: (id) => profiles.find((p) => p.id === id) || null };
  let ip = '192.168.1.5';
  const out = new Outputs({
    dir: tmp(), catalog: cat, lists: ls, accounts, epg, settings, media: { available: false }, clientIp: () => ip, ready: async () => {},
    hiddenFor: () => new Set(), inputOf: (it) => ({ input: it.u, headers: it.h || {} }), relayPath: (u) => '/c/signed/api/proxy?u=' + encodeURIComponent(u),
    videoViaProxy: () => false, connLimit: () => 2, usage: () => 0, serveLocal: () => {},
  });
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try { if (!(await out.handle(req, res, u.pathname, u.searchParams))) { res.writeHead(404); res.end('app'); } } catch (e) { res.writeHead(e.status || 500); res.end(e.message); }
  });
  return { out, cat, srv, setIp: (x) => { ip = x; } };
}
const get = (base, p, opts = {}) => new Promise((ok, no) => http.get(base + p, opts, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => ok({ status: r.statusCode, headers: r.headers, body: b, json: () => JSON.parse(b) })); }).on('error', no));

test('Xtream output: off by default, one login per profile, each sees what that profile may watch', { timeout: 20000 }, async () => {
  const f = outputsFixture();
  await new Promise((r) => f.srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${f.srv.address().port}`;
  try {
    assert.strictEqual((await get(base, '/player_api.php?username=dad&password=x')).status, 404, 'off until turned on');
    f.out.update({ xtream: { enabled: true } });
    const dad = f.out.setLogin('A');
    const kid = f.out.setLogin('K', 'kidpass1');
    assert.strictEqual(dad.user, 'dad');
    assert.ok(!JSON.stringify(f.out.store.data).includes(dad.password), 'only a hash is kept');
    const info = (await get(base, `/player_api.php?username=dad&password=${dad.password}`)).json();
    assert.strictEqual(info.user_info.auth, 1);
    assert.strictEqual(info.user_info.max_connections, '2');
    assert.strictEqual((await get(base, '/player_api.php?username=dad&password=wrong')).status, 401);
    const live = (await get(base, `/player_api.php?username=dad&password=${dad.password}&action=get_live_streams`)).json();
    assert.deepStrictEqual(live.map((x) => x.name), ['News One', 'Kids TV', 'Header Channel']);
    assert.ok(live.every((x) => Number.isInteger(x.stream_id) && x.stream_id > 0));
    // Ids are stable from one build of the catalogue to the next.
    const id1 = live[0].stream_id;
    f.cat.build();
    assert.strictEqual(f.out.idOf(f.cat.items.find((i) => i.n === 'News One').k), id1);
    assert.strictEqual(id1, fnv31(f.cat.items.find((i) => i.n === 'News One').k));
    const cats = (await get(base, `/player_api.php?username=dad&password=${dad.password}&action=get_live_categories`)).json();
    assert.deepStrictEqual(cats.map((c) => c.category_name).sort(), ['Kids', 'News']);
    const onlyNews = (await get(base, `/player_api.php?username=dad&password=${dad.password}&action=get_live_streams&category_id=${cats.find((c) => c.category_name === 'News').category_id}`)).json();
    assert.strictEqual(onlyNews.length, 2);
    // The kids profile: kids' things only.
    const kvod = (await get(base, '/player_api.php?username=kiddo&password=kidpass1&action=get_vod_streams')).json();
    assert.deepStrictEqual(kvod.map((x) => x.name), ['Family Film (2021)']);
    const dvod = (await get(base, `/player_api.php?username=dad&password=${dad.password}&action=get_vod_streams`)).json();
    assert.strictEqual(dvod.length, 2);
    assert.strictEqual(dvod.find((x) => x.name.startsWith('Grown')).container_extension, 'mkv');
    // Series and their episodes
    const ser = (await get(base, `/player_api.php?username=dad&password=${dad.password}&action=get_series`)).json();
    const sinfo = (await get(base, `/player_api.php?username=dad&password=${dad.password}&action=get_series_info&series_id=${ser[0].series_id}`)).json();
    assert.strictEqual(sinfo.episodes['1'][0].info.duration_secs, 1500);
    // A short guide for a channel
    const epg = (await get(base, `/player_api.php?username=dad&password=${dad.password}&action=get_short_epg&stream_id=${id1}`)).json();
    assert.strictEqual(Buffer.from(epg.epg_listings[0].title, 'base64').toString(), 'Headlines');
    // Streams: straight from the provider, or through the relay when it needs headers; not for another profile.
    let r = await get(base, `/live/dad/${dad.password}/${id1}.ts`);
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.location, 'http://prov.example/live/u/p/1.ts');
    r = await get(base, `/live/dad/${dad.password}/${live[2].stream_id}.m3u8`);
    assert.match(r.headers.location, /^\/c\/signed\/api\/proxy\?u=/);
    const grownId = dvod.find((x) => x.name.startsWith('Grown')).stream_id;
    assert.strictEqual((await get(base, `/movie/kiddo/kidpass1/${grownId}.mkv`)).status, 404);
    // The playlist and guide for a login
    const m3u = await get(base, `/get.php?username=dad&password=${dad.password}&type=m3u_plus&output=ts`);
    assert.match(m3u.body, /#EXTINF:-1 tvg-id="\d+" tvg-name="News One"/);
    assert.match(m3u.body, new RegExp(`/live/dad/${dad.password}/${id1}\\.ts`));
    const xml = await get(base, `/xmltv.php?username=dad&password=${dad.password}`);
    assert.match(xml.body, /<programme start="\d{14} \+0000" stop="\d{14} \+0000" channel="\d+"><title>Headlines<\/title>/);
    // App pages are left alone; wrong passwords get blocked after a while.
    assert.strictEqual((await get(base, '/api/item/123')).body, 'app');
    for (let i = 0; i < 10; i++) await get(base, '/player_api.php?username=dad&password=nope');
    assert.strictEqual((await get(base, `/player_api.php?username=dad&password=${dad.password}`)).status, 429);
  } finally { f.srv.close(); }
});

test('HDHomeRun tuner: local network only, lineup, guide, tuner and connection limits', { timeout: 20000 }, async () => {
  const f = outputsFixture();
  await new Promise((r) => f.srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${f.srv.address().port}`;
  try {
    assert.strictEqual((await get(base, '/discover.json')).body, 'app', 'off: not answered');
    f.out.update({ hdhr: { enabled: true, tuners: 1 } });
    const d = (await get(base, '/discover.json')).json();
    assert.strictEqual(d.TunerCount, 1);
    assert.strictEqual(d.LineupURL, `${base}/lineup.json`);
    const lu = (await get(base, '/lineup.json')).json();
    assert.deepStrictEqual(lu.map((x) => x.GuideNumber), ['1', '2', '3']);
    assert.strictEqual(lu[0].URL, `${base}/auto/v1`);
    const xml = await get(base, '/hdhr/epg.xml');
    assert.match(xml.body, /<channel id="1"><display-name>1<\/display-name><display-name>News One<\/display-name>/);
    // A busy tuner: the next viewer is told so.
    f.out.active.set('x', { kind: 'hdhr', live: true, pid: 'A', list: 'L', at: Date.now() });
    assert.strictEqual((await get(base, '/auto/v2')).status, 503);
    f.out.active.clear();
    f.setIp('203.0.113.9');
    assert.strictEqual((await get(base, '/discover.json')).status, 403, 'not from the internet');
    assert.ok(privateIp('10.1.2.3') && privateIp('100.100.1.1') && !privateIp('8.8.8.8'));
  } finally { f.srv.close(); }
});

// ---------------------------------------------------------------- 24/7 channels
test('24/7 schedule: the same for everyone, continuous, wraps around', () => {
  const entries = [['a', 600], ['b', 1200], ['c', 300]]; // a 35-minute cycle
  const epoch = Date.UTC(2026, 0, 1, 0, 0, 0);
  let p = positionAt(entries, epoch, epoch + 700e3);
  assert.deepStrictEqual([p.index, p.offset], [1, 100]);
  p = positionAt(entries, epoch, epoch + 2100e3 * 3 + 1850e3); // three cycles later, 30 min 50 s in
  assert.deepStrictEqual([p.index, Math.round(p.offset)], [2, 50]);
  assert.deepStrictEqual(positionAt(entries, epoch, epoch + 123456), positionAt(entries, epoch, epoch + 123456), 'deterministic');
  p = positionAt(entries, epoch, epoch - 60e3); // before the start: counts back
  assert.strictEqual(p.index, 2);
  const s = scheduleBetween(entries, epoch, epoch, epoch + 4200e3);
  for (let i = 1; i < s.length; i++) assert.strictEqual(s[i].start, s[i - 1].end, 'no gaps');
  assert.deepStrictEqual(s.map((x) => x.index), [0, 1, 2, 0, 1, 2]);
});

test('24/7 channels: built from the catalogue, shuffled the same way every time, what’s on now, guide', { timeout: 20000 }, async () => {
  const items = [];
  for (let i = 1; i <= 6; i++) items.push({ name: `Comedy Film ${i} (${2000 + i})`, type: 'movie', url: `http://p/m${i}.mp4`, group: 'Comedy', lang: 'en', duration: 3600 + i * 60 });
  items.push({ name: 'Sitcom', type: 'show', url: '', group: 'Comedy', lang: 'en', xt: { kind: 'series', id: 1 } });
  const lists = newLists();
  lists.store.data.lists = [{ id: 'L', name: 'L', enabled: true, type: 'xtream' }];
  lists.parsed.set('L', { items, epgUrls: [] });
  lists.xtSeries = async () => ({ info: {}, episodes: [1, 2, 3].map((n) => ({ id: n, season: 1, episode: n, title: `Ep ${n}`, url: `http://p/e${n}.mp4`, duration: 1320 })) });
  const cat = new Catalog({ lists, epg: { has: () => false, resolve: () => null }, getSettings: settings });
  const mc = new MyChannels({ dir: lists.dir, catalog: cat, lists, tmdb: null, getSettings: settings });
  mc.register();
  cat.build();
  await assert.rejects(mc.create({ name: 'Empty', source: { type: 'category', value: 'Nothing here' } }), /empty/);
  const ch = await mc.create({ name: 'Comedy 24/7', source: { type: 'category', value: 'Comedy', kind: 'any' }, order: 'shuffle' });
  assert.strictEqual(ch.count, 9);
  const c = mc.get(ch.id);
  const eps = c.entries.filter((e) => e[2]).map((e) => cat.get(e[0]).e);
  assert.deepStrictEqual(eps, [1, 2, 3], 'a series keeps its episode order inside a shuffle');
  const order1 = c.entries.map((e) => e[0]).join();
  await mc.build(ch.id);
  assert.strictEqual(c.entries.map((e) => e[0]).join(), order1, 'the same shuffle until asked to shuffle again');
  await mc.update(ch.id, { reshuffle: true });
  // The channel is in the catalogue as a live channel, with its guide.
  cat.build();
  const live = cat.items.find((i) => i.t === 'live' && i.n === 'Comedy 24/7');
  assert.ok(live && live.u === `mych:${ch.id}` && live.num >= 900);
  assert.deepStrictEqual(live.lg, ['en'], 'the language of what it plays');
  const g = await mc.guide();
  const progs = g.programmes[`mych.${ch.id}`];
  assert.ok(progs.length >= 10);
  for (let i = 1; i < progs.length; i++) assert.strictEqual(progs[i].s, progs[i - 1].e);
  // What's on now matches the guide.
  const t = Date.now();
  const now = await mc.now(ch.id, () => true, t);
  const slot = progs.find((p) => p.s <= t && p.e > t);
  assert.strictEqual(now.start, slot.s);
  assert.ok(now.offset >= 0 && now.offset * 1000 <= now.end - now.start);
  assert.ok(now.next);
  // Something this profile can't see is passed over.
  const hiddenK = now.item.k;
  const later = await mc.now(ch.id, (it) => it.k !== hiddenK, t);
  assert.notStrictEqual(later.item.k, hiddenK);
  assert.strictEqual(later.offset, 0);
  // Picked titles, oldest first
  const picked = await mc.create({ name: 'Two films', source: { type: 'titles', keys: cat.items.filter((i) => i.t === 'movie').slice(0, 2).map((i) => i.k).reverse() }, order: 'year' });
  const pc = mc.get(picked.id);
  assert.ok(cat.get(pc.entries[0][0]).y < cat.get(pc.entries[1][0]).y);
  mc.remove(picked.id);
  assert.strictEqual(mc.all().length, 1);
});

test('a guide sync before the saved lists load keeps their guides (and their saved listings)', () => {
  const lists = newLists();
  lists.store.data.lists.push({ id: 'L1', type: 'xtream', name: 'Prov', enabled: true, server: 'http://p', username: 'u', password: 'p' });
  lists.store.data.guides.push({ id: 'G1', url: 'http://p/xmltv.php', name: 'From Prov', auto: true, listId: 'L1', enabled: true, status: {} });
  // Start-up: something else (e.g. My channels) publishes and syncs guides before L1 is parsed.
  lists.parsed.set('extra', { items: [], epgUrls: [], format: 'x', name: '' });
  lists._syncGuides();
  assert.deepStrictEqual(lists.guides().map((g) => g.id), ['G1']);
  // Once L1 is loaded, the same guide (same id) stays.
  lists.parsed.set('L1', { items: [], epgUrls: ['http://p/xmltv.php'], format: 'Xtream Codes', name: '' });
  lists._syncGuides();
  assert.deepStrictEqual(lists.guides().map((g) => g.id), ['G1']);
});
