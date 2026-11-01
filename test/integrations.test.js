// Subtitles (SubDL, Gestdown, OpenSubtitles), Trakt, API keys and webhooks — against local stand-ins (test/mock/integrations.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const mock = require('./mock/integrations');
const { OpenSubtitles, Subtitles, srtToVtt, RESERVE } = require('../lib/subtitles');
const { langCode, pickFromDownload } = require('../lib/subsources');
const { zip } = require('../lib/zip');
const { Trakt } = require('../lib/trakt');
const { ApiKeys } = require('../lib/apikeys');
const { Webhooks, sign } = require('../lib/webhooks');
const { shiftVtt } = require('../lib/routes-p5');
const { JsonFile } = require('../lib/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p5-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('SRT becomes WebVTT', () => {
  const v = srtToVtt('﻿1\r\n00:00:01,5 --> 00:00:02,250\r\n{\\an8}Hello\r\n<font color="red">there</font>\r\n\r\n2\r\n0:01:00,000 --> 0:01:02,000\r\nBye\r\n');
  assert.match(v, /^WEBVTT\n/);
  assert.match(v, /00:00:01\.500 --> 00:00:02\.250\nHello\nthere/);
  assert.match(v, /00:01:00\.000 --> 00:01:02\.000\nBye/);
  assert.doesNotMatch(v, /\n1\n|\n2\n/, 'cue numbers dropped');
  assert.strictEqual(srtToVtt('WEBVTT\n\n00:00.000 --> 00:01.000\nx'), 'WEBVTT\n\n00:00.000 --> 00:01.000\nx\n');
  const s = shiftVtt('WEBVTT\n\n00:00:05.000 --> 00:00:07.500\nA\n\n00:01:00.000 --> 00:01:02.000\nB', -10);
  assert.doesNotMatch(s, /\nA/);
  assert.match(s, /00:00:50\.000 --> 00:00:52\.000\nB/);
});

test('OpenSubtitles: search order, one download per file, quota message', async () => {
  const m = await mock.start({ quota: 1 });
  const dir = tmp();
  const conf = { apiKey: 'oskey', username: 'me', password: 'pw' };
  const os1 = new OpenSubtitles({ dataDir: dir, getConf: () => conf, fetch, base: m.osBase });
  try {
    const list = await os1.search({ tmdb: 603, langs: ['en'] });
    assert.deepStrictEqual(list.map((x) => x.fileId), [3, 2, 4, 1], 'English first, real before machine-translated, most downloaded first');
    assert.strictEqual(m.state.lastSearch.tmdb_id, '603');
    assert.strictEqual(m.state.lastSearch.languages, 'en');
    await os1.search({ tmdb: 603, langs: ['en'] });
    assert.strictEqual(m.state.osSearches, 1, 'searches are cached');
    await os1.search({ parentTmdb: 1399, season: 2, episode: 3, langs: ['fr', 'en'] });
    assert.deepStrictEqual([m.state.lastSearch.parent_tmdb_id, m.state.lastSearch.season_number, m.state.lastSearch.episode_number, m.state.lastSearch.languages], ['1399', '2', '3', 'en,fr']);

    const f = await os1.download(3);
    const vtt = fs.readFileSync(f, 'utf8');
    assert.match(vtt, /^WEBVTT/);
    assert.match(vtt, /Café/, 'Windows-1252 decoded');
    assert.doesNotMatch(vtt, /\\an8/);
    assert.strictEqual(m.state.lastAuth, 'Bearer jwt', 'signed in to the account for more downloads');
    await os1.download(3);
    assert.strictEqual(m.state.osDownloads, 1, 'cached on disk');
    await assert.rejects(os1.download(2), (e) => e.status === 429 && /used up/.test(e.message));
    // The cache stays within its limits.
    for (let i = 10; i < 15; i++) fs.writeFileSync(os1.file(i), 'WEBVTT\n' + 'x'.repeat(1000));
    os1.prune(3, 1e9);
    assert.strictEqual(fs.readdirSync(os1.dir).filter((x) => x.endsWith('.vtt')).length, 3);
  } finally { m.close(); }
});

const SRT2 = (t) => `1\n00:00:01,000 --> 00:00:02,000\n${t}\n`;
test('Subtitle sources: languages, season packs', () => {
  assert.deepStrictEqual(['EN', 'english', 'BR_PT', 'pt-br', 'Portuguese', 'fr', 'French', 'Farsi/Persian', 'Chinese BG code', 'Klingon'].map(langCode), ['en', 'en', 'pt', 'pt', 'pt', 'fr', 'fr', 'fa', 'zh', '']);
  const pack = zip([{ name: 'Show.S02E02.srt', data: SRT2('two') }, { name: 'sub/Show.2x03.srt', data: SRT2('three') }, { name: 'nfo.txt', data: 'x'.repeat(500) }]);
  assert.strictEqual(pickFromDownload(pack, { season: 2, episode: 3 }).toString(), SRT2('three'));
  assert.strictEqual(pickFromDownload(Buffer.from('plain srt'), {}).toString(), 'plain srt', 'not a zip: as it is');
});

test('Subtitles from every source: free ones first, OpenSubtitles kept back', async () => {
  const m = await mock.start({ quota: 3 });
  const env = { SUBDL_BASE: m.subdlBase, SUBDL_DL_BASE: m.subdlDlBase, GESTDOWN_BASE: m.gestdownBase };
  const saved = {}; for (const k in env) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const dir = tmp();
  const conf = { subdl: { apiKey: 'sdkey' }, sources: { gestdown: true }, opensubtitles: { apiKey: 'oskey' } };
  const subs = new Subtitles({ dataDir: dir, getConf: () => conf, fetch, osBase: m.osBase });
  try {
    assert.deepStrictEqual(subs.active(), ['subdl', 'gestdown', 'opensubtitles']);
    // A film: SubDL and OpenSubtitles; English first, free before OpenSubtitles.
    const film = await subs.search({ tmdb: 603, query: 'Film', year: 2020, langs: ['en', 'fr'] });
    assert.deepStrictEqual(film.filter((x) => x.lang === 'en').map((x) => x.source), ['subdl', 'opensubtitles', 'opensubtitles', 'opensubtitles']);
    assert.ok(film.filter((x) => x.source === 'opensubtitles').every((x) => x.costly && x.from === 'OpenSubtitles'));
    assert.ok(film.filter((x) => x.source !== 'opensubtitles').every((x) => !x.costly));
    assert.strictEqual(m.state.subs.subdl[0].tmdb_id, '603');
    assert.strictEqual(m.state.subs.subdl[0].languages, 'EN,FR');
    assert.strictEqual(m.state.subs.gestdown.length, 0, 'Gestdown is for episodes only');

    // Fetching from SubDL: the zip is opened and turned into WebVTT, and only fetched once.
    const tok = await subs.get(film[0].id);
    assert.match(tok, /^[0-9a-f]{24}$/);
    assert.match(fs.readFileSync(subs.file(tok), 'utf8'), /^WEBVTT[\s\S]*SubDL film-en/);
    await subs.get(film[0].id);
    assert.strictEqual(m.state.subs.subdlDownloads, 1);
    const again = await subs.search({ tmdb: 603, query: 'Film', year: 2020, langs: ['en', 'fr'] });
    assert.ok(again.find((x) => x.id === film[0].id).cached, 'shown as saved here');

    // An episode: all four; the single episode before the season pack; Addic7ed's unfinished one left out.
    const ep = await subs.search({ parentTmdb: 4242, query: 'Show', season: 2, episode: 3, langs: ['en'] });
    const srcs = ep.map((x) => x.source);
    assert.ok(srcs.includes('subdl') && srcs.includes('gestdown') && srcs.includes('opensubtitles'));
    assert.ok(!ep.some((x) => /WIP|S02E04/.test(x.name)));
    const sd = ep.filter((x) => x.source === 'subdl');
    assert.deepStrictEqual(sd.map((x) => x.pack), [false, true]);
    assert.ok(srcs.indexOf('opensubtitles') > srcs.lastIndexOf('gestdown'));
    assert.match(m.state.subs.gestdown.find((p) => /subtitles\/get/.test(p)), /show-uuid\/2\/3\/English$/);
    // A season pack picks the right episode out of the zip.
    assert.match(fs.readFileSync(subs.file(await subs.get(sd[1].id)), 'utf8'), /Episode three/);
    assert.match(fs.readFileSync(subs.file(await subs.get(ep.find((x) => x.source === 'gestdown').id)), 'utf8'), /Addic7ed g1/);

    // Fetching automatically: a free one, never OpenSubtitles unless allowed.
    conf.subdl.apiKey = ''; conf.sources = { gestdown: false }; subs.clear();
    const before = m.state.osDownloads;
    assert.strictEqual(await subs.auto({ tmdb: 1, query: 'Film', year: 2020 }, 'en'), null, 'only OpenSubtitles has it: not used yet');
    assert.strictEqual(m.state.osDownloads, before);
    const got = await subs.auto({ tmdb: 1, query: 'Film', year: 2020 }, 'en', { allowCostly: true });
    assert.strictEqual(got.source, 'opensubtitles');
    assert.strictEqual(subs.quota.remaining, RESERVE, 'down to the reserve');
    // With only the reserve left, automatic fetching leaves it for choosing by hand (what's already saved still works).
    const saved1 = got.id;
    const r2 = await subs.auto({ tmdb: 1, query: 'Film', year: 2020 }, 'en', { allowCostly: true });
    assert.strictEqual(r2.id, saved1, 'the saved one is reused, free');
    fs.unlinkSync(subs.file(got.token));
    assert.strictEqual(await subs.auto({ tmdb: 1, query: 'Film', year: 2020 }, 'en', { allowCostly: true }), null);
    assert.strictEqual(m.state.osDownloads, before + 1);
    // …but can still be picked by hand.
    await subs.get(saved1);
    assert.strictEqual(m.state.osDownloads, before + 2);

    // A bad SubDL key is reported; a source that's down doesn't stop the others.
    conf.subdl.apiKey = 'wrong'; conf.sources = { gestdown: true }; conf.opensubtitles.apiKey = ''; subs.clear();
    m.state.subs.gestdownDown = true;
    await assert.rejects(subs.search({ parentTmdb: 4242, query: 'Show', season: 2, episode: 3, langs: ['en'] }), /SubDL: Invalid API key/);
    const t = await subs.test();
    assert.deepStrictEqual([t.subdl.ok, t.gestdown.on, t.opensubtitles.on], [false, true, false]);
    conf.subdl.apiKey = 'sdkey'; subs.clear();
    assert.strictEqual((await subs.search({ parentTmdb: 4242, query: 'Show', season: 2, episode: 3, langs: ['en'] })).length, 2, 'SubDL still answers with Gestdown down');
    m.state.subs.gestdownDown = false;
    await assert.rejects(subs.get('zz:1'), /Bad subtitle/);
    await assert.rejects(subs.get('pn:0:0:abc'), /Bad subtitle/);
    await assert.rejects(subs.get('sd:0:0:../../etc/passwd'), /Bad subtitle/);
  } finally {
    for (const k in saved) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    m.close();
  }
});

test('Trakt: connect with a code, refresh, scrobble films and episodes, sync both ways', async () => {
  const m = await mock.start({ expiresIn: 3600 }); // runs out within a day: refreshed before use
  const dir = tmp();
  const items = new Map();
  const add = (it) => items.set(it.k, it);
  add({ k: 'm1', t: 'movie', n: 'The Matrix', y: 1999, tmdb: '603', d: 8000 });
  add({ k: 'm2', t: 'movie', n: 'Untagged Film', y: 2001, d: 6000 });
  add({ k: 'm3', t: 'movie', n: 'Remote Film', y: 2020, tmdb: '777', d: 6000 });
  add({ k: 's1', t: 'show', n: 'Harbor Lights', y: 2022, tmdb: '42' });
  add({ k: 'e1', t: 'episode', n: 'Harbor Lights S01E03', sk: 's1', s: 1, e: 3, d: 2800 });
  const cat = { get: (k) => items.get(k) || null, items: [...items.values()], version: 1, findTitle: (t) => [...items.values()].filter((x) => x.n === t).map((x) => x.k) };
  const users = new Map();
  const ud = {
    of: (pid) => { if (!users.has(pid)) users.set(pid, { data: { list: [], ratings: {}, progress: {} } }); return users.get(pid); },
    toggle(pid, f, k, on) { const d = this.of(pid).data; d[f] = d[f].filter((x) => x !== k); if (on) d[f].unshift(k); },
    rate(pid, k, v) { this.of(pid).data.ratings[k] = v; },
    progress(pid, r) { this.of(pid).data.progress[r.k] = { p: 0, d: r.d, w: true, at: Date.now() }; },
  };
  const byTmdb = (id, type) => { for (const it of items.values()) if (it.t === type && it.tmdb === id) return it.k; return null; };
  const tr = new Trakt({ dataDir: dir, getConf: () => ({ clientId: 'cid', clientSecret: 'sec' }), fetch, base: m.traktBase, lib: { catalog: () => cat, userdata: ud, tmdbOf: (it) => it.tmdb || '', byTmdb, episodes: async () => [items.get('e1')] } });
  try {
    const st = await tr.start('p1');
    assert.strictEqual(st.code, 'ABCD1234');
    assert.strictEqual((await tr.poll('p1')).state, 'waiting');
    m.state.trakt.approved = true;
    tr.pending.get('p1').next = 0;
    const ok = await tr.poll('p1');
    assert.strictEqual(ok.state, 'connected');
    assert.strictEqual(tr.status('p1').user, 'alex');
    // Tokens are kept on disk, not in the browser.
    tr.store.flush();
    assert.match(fs.readFileSync(path.join(dir, 'trakt.json'), 'utf8'), /"access":"tok\d"/);

    await tr.scrobble('p1', 'start', items.get('m1'), 12.5);
    assert.ok(m.state.trakt.refreshes >= 1, 'the token was refreshed before it ran out');
    await tr.scrobble('p1', 'stop', items.get('e1'), 95);
    await tr.scrobble('p1', 'pause', items.get('m2'), 40);
    const sc = m.state.trakt.scrobbles;
    assert.deepStrictEqual(sc[0].movie.ids, { tmdb: 603 });
    assert.strictEqual(sc[0].progress, 12.5);
    assert.deepStrictEqual([sc[1].action, sc[1].show.ids.tmdb, sc[1].episode.season, sc[1].episode.number], ['stop', 42, 1, 3]);
    assert.deepStrictEqual(sc[2].movie.ids, { trakt: 55 }, 'no TMDB id: found by a Trakt search by title and year');

    // Watchlist: Trakt's film comes into My List, ours goes to Trakt.
    ud.toggle('p1', 'list', 'm1', true);
    ud.rate('p1', 'm1', 1);
    m.state.trakt.ratings = [{ rating: 3, movie: { title: 'Remote Film', year: 2020, ids: { tmdb: 777 } } }];
    let r = await tr.sync('p1');
    assert.ok(ud.of('p1').data.list.includes('m3'), 'pulled into My List');
    assert.ok(m.state.trakt.added.movies.some((x) => x.ids.tmdb === 603), 'pushed to the watchlist');
    assert.strictEqual(ud.of('p1').data.ratings.m3, -1, 'a 3/10 on Trakt is a thumbs down here');
    assert.ok(m.state.trakt.rated.movies.some((x) => x.ids.tmdb === 603 && x.rating === 8), 'thumbs up → 8/10');
    assert.ok(r.added >= 1 && r.pushed >= 1);
    // Removed here since the last sync → removed on Trakt.
    ud.toggle('p1', 'list', 'm1', false);
    r = await tr.sync('p1');
    assert.ok(m.state.trakt.removed.some((b) => (b.movies || []).some((x) => x.ids.tmdb === 603)));
    // Removed on Trakt → removed here.
    m.state.trakt.watchlist.movies = [];
    r = await tr.sync('p1');
    assert.ok(!ud.of('p1').data.list.includes('m3'));

    const imp = await tr.importHistory('p1');
    assert.strictEqual(imp.movies, 1);
    assert.ok(ud.of('p1').data.progress.m3.w);
    ud.progress('p1', { k: 'e1', d: 2800 });
    const ex = await tr.exportHistory('p1');
    assert.strictEqual(ex.episodes, 1);
    assert.ok(ex.movies >= 1);

    tr.disconnect('p1');
    assert.strictEqual(tr.status('p1').connected, false);
  } finally { m.close(); }
});

test('API keys: shown once, stored hashed, scoped, slowed down when guessed', () => {
  const dir = tmp();
  const k = new ApiKeys(dir);
  const { id, key } = k.create({ name: 'HA', scope: 'control' });
  assert.match(key, /^iptv_/);
  k.store.flush();
  const saved = fs.readFileSync(path.join(dir, 'apikeys.json'), 'utf8');
  assert.ok(!saved.includes(key), 'only a hash is kept');
  const got = k.verify(`Bearer ${key}`, '1.2.3.4');
  assert.strictEqual(got.id, id);
  assert.ok(ApiKeys.allows(got, 'read') && ApiKeys.allows(got, 'control') && !ApiKeys.allows(got, 'admin'));
  assert.strictEqual(k.verify('Bearer nope', '5.5.5.5'), null);
  assert.strictEqual(k.verify('Basic xyz', '5.5.5.5'), null);
  for (let i = 0; i < 10; i++) k.verify('Bearer wrong' + i, '6.6.6.6');
  assert.throws(() => k.verify(`Bearer ${key}`, '6.6.6.6'), (e) => e.status === 429);
  assert.ok(k.verify(`Bearer ${key}`, '1.2.3.4'), 'other addresses unaffected');
  assert.throws(() => k.create({ name: 'x', scope: 'root' }));
  k.revoke(id);
  assert.strictEqual(k.verify(`Bearer ${key}`, '1.2.3.4'), null);
});

test('Webhooks: signed, only the events asked for, retried after a failure', async () => {
  const m = await mock.start({ hookFailFirst: 1 });
  const dir = tmp();
  const h = new Webhooks(dir, { fetch, retries: [50, 50, 50] });
  try {
    const saved = h.save({ url: `${m.base}/hook`, name: 'HA', events: ['playback.started', 'reminder.due'] });
    assert.ok(saved.secret);
    assert.throws(() => h.save({ url: 'ftp://x', events: ['playback.started'] }));
    assert.throws(() => h.save({ url: `${m.base}/hook`, events: ['nope'] }));
    assert.strictEqual(h.emit('playback.stopped', {}), 0, 'not subscribed');
    assert.strictEqual(h.emit('playback.started', { title: 'Film' }), 1);
    for (let i = 0; i < 40 && m.state.hooks.length < 2; i++) await wait(25);
    assert.strictEqual(m.state.hooks.length, 2, 'failed once, then delivered');
    const got = m.state.hooks[1];
    assert.strictEqual(got.headers['x-signature'], sign(saved.secret, got.body));
    assert.strictEqual(got.headers['x-signature'], 'sha256=' + crypto.createHmac('sha256', saved.secret).update(got.body).digest('hex'));
    assert.strictEqual(JSON.parse(got.body).data.title, 'Film');
    assert.strictEqual(h.log[0].ok, true);
    assert.strictEqual(h.log[1].ok, false);
    const t = await h.test(saved.id);
    assert.ok(t.ok);
  } finally { h.stop(); m.close(); JsonFile.all.delete(h.store); }
});
