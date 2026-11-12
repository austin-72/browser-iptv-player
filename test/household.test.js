'use strict';
// Running a household: whole parts of the app the admin switches off (their requests are refused too), and the
// manager role — a second grown-up who can fix channels, fetch lists again, deal with error reports and answer
// screen-time requests, and nothing else in Admin.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => ok(n)); }); });

/** A server on its own data folder; device() is a browser of its own (its own cookie). */
async function server(dataDir, port) {
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const me = { out: '', code: undefined };
  app.stdout.on('data', (d) => { me.out += d; });
  app.stderr.on('data', (d) => { me.out += d; });
  app.on('exit', (c) => { me.code = c === null ? -1 : c; });
  me.device = () => {
    const d = { cookie: '' };
    d.raw = (method, p, body, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-App': '1', ...(d.cookie ? { Cookie: d.cookie } : {}), ...headers }, body, redirect: 'manual' });
    d.req = async (method, p, body) => {
      const r = await d.raw(method, p, body !== undefined ? JSON.stringify(body) : undefined, body !== undefined ? { 'Content-Type': 'application/json' } : {});
      const sc = r.headers.get('set-cookie');
      if (sc) d.cookie = sc.split(';')[0];
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { status: r.status, json: j, text: t };
    };
    return d;
  };
  me.stop = () => { try { app.kill('SIGKILL'); } catch {} };
  for (let i = 0; i < 150 && !/Ready/.test(me.out) && me.code === undefined; i++) await wait(100);
  assert.match(me.out, /Ready/, me.out.slice(-600));
  return me;
}
const M3U = '#EXTM3U\n#EXTINF:-1 tvg-id="one" group-title="News",Channel One\nhttp://198.51.100.7/live/user1/secret1/one.m3u8\n#EXTINF:-1 group-title="Films",A Film (2019)\nhttp://198.51.100.7/movie/user1/secret1/1.mp4\n';

/** Signed in, with an admin (Alex, PIN 4821), Sam, Kim and a kids profile, and one uploaded list. */
async function household(srv) {
  const a = srv.device();
  assert.strictEqual((await a.req('POST', '/api/login', { password: 'pw-test' })).status, 200);
  for (const p of [{ name: 'Alex', pin: '4821' }, { name: 'Sam' }, { name: 'Kim' }, { name: 'Robin', kids: true }]) assert.strictEqual((await a.req('POST', '/api/profiles', p)).status, 200);
  const profiles = (await a.req('GET', '/api/boot')).json.profiles;
  const id = (n) => profiles.find((x) => x.name === n).id;
  assert.strictEqual((await a.req('POST', `/api/profiles/${id('Alex')}/select`, { pin: '4821' })).status, 200);
  const up = await a.raw('POST', '/api/admin/lists/upload?name=Pasted&fileName=pasted.m3u', Buffer.from(M3U));
  assert.strictEqual(up.status, 200, await up.text());
  let cat = null;
  for (let i = 0; i < 60 && !(cat && cat.items && cat.items.length >= 2); i++) { cat = (await a.req('GET', '/api/catalog')).json; if (!(cat && cat.items && cat.items.length >= 2)) await wait(200); }
  assert.ok(cat.items.length >= 2, 'the list is in the catalogue');
  return { a, id, cat };
}

test('parts of the app the admin switches off: gone from the settings every device gets, and their requests refused', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areas-'));
  const srv = await server(path.join(dir, 'data'), await freePort());
  try {
    const { a, id } = await household(srv);
    // Everything is on to begin with.
    assert.deepStrictEqual((await a.req('GET', '/api/boot')).json.off, {});
    assert.strictEqual((await a.req('POST', '/api/messages', { to: 'all', text: 'hello' })).status, 200);

    // Off: messages, the wishlist and the play queue. (A name that isn't a part of the app is dropped.)
    const saved = await a.req('PUT', '/api/admin/settings', { off: { messages: true, wishlist: true, queue: true, admin: true, moods: 'yes' } });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.json.off, { messages: true, wishlist: true, queue: true });
    assert.deepStrictEqual((await a.req('GET', '/api/boot')).json.off, { messages: true, wishlist: true, queue: true });

    const no = async (method, p, body) => { const r = await a.req(method, p, body); assert.strictEqual(r.status, 403, `${method} ${p}: ${r.text.slice(0, 120)}`); assert.match(r.json.error, /switched off/); };
    await no('POST', '/api/messages', { to: 'all', text: 'still there?' });
    await no('GET', '/api/messages/all');
    await no('GET', '/api/wishlist');
    await no('POST', '/api/wishlist', { t: 'movie', n: 'Something', y: 2020 });
    await no('POST', '/api/queue', { op: 'clear' });
    // What isn't part of them still answers: who's in the household, what was already queued, alerts, the rest.
    assert.strictEqual((await a.req('GET', '/api/social')).status, 200);
    assert.strictEqual((await a.req('GET', '/api/queue')).status, 200);
    assert.strictEqual((await a.req('GET', '/api/alerts')).status, 200);
    assert.strictEqual((await a.req('GET', '/api/viewing')).status, 200);
    // (The live connection every page keeps isn't "following teams".)
    await a.req('PUT', '/api/admin/settings', { off: { follow: true, viewing: true, trailers: true } });
    await no('GET', '/api/follow');
    await no('GET', '/api/viewing');
    await no('GET', '/api/me/week');
    await no('GET', '/api/trailers?k=x');
    assert.strictEqual((await a.req('GET', '/api/admin/viewing')).status, 200, 'the admin’s own statistics page isn’t that part');
    assert.strictEqual((await a.req('POST', '/api/messages', { to: id('Sam'), text: 'back' })).status, 200, 'messages are on again: the new choice replaced the old');

    // Home's "Right now" panel is a part like the others (it has no requests of its own to refuse).
    assert.deepStrictEqual((await a.req('PUT', '/api/admin/settings', { off: { rightnow: true } })).json.off, { rightnow: true });
    assert.deepStrictEqual((await a.req('GET', '/api/boot')).json.off, { rightnow: true });
    assert.strictEqual((await a.req('GET', '/api/social')).status, 200);

    // Everything back on: as it was (the earlier message is still there).
    assert.deepStrictEqual((await a.req('PUT', '/api/admin/settings', { off: {} })).json.off, {});
    const th = await a.req('GET', '/api/messages/all');
    assert.strictEqual(th.status, 200);
    assert.ok(JSON.stringify(th.json).includes('hello'));
    assert.strictEqual((await a.req('GET', '/api/wishlist')).status, 200);
  } finally { srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a manager: channels, fetching lists again, error reports and screen-time requests — and nothing else in Admin', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-'));
  const srv = await server(path.join(dir, 'data'), await freePort());
  try {
    const { a, id, cat } = await household(srv);
    const chan = cat.items.find((x) => /Channel One/.test(x.n));
    const listId = (await a.req('GET', '/api/admin')).json.lists[0].id;

    // The role needs a locked profile, is never a kids profile's, and only the admin gives it.
    let r = await a.req('PUT', `/api/admin/profiles/${id('Sam')}`, { manager: true });
    assert.strictEqual(r.status, 400); assert.match(r.json.error, /PIN first/);
    assert.strictEqual((await a.req('PUT', `/api/admin/profiles/${id('Sam')}`, { pin: '1357' })).status, 200);
    r = await a.req('PUT', `/api/admin/profiles/${id('Sam')}`, { manager: true });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.manager, true);
    assert.strictEqual((await a.req('PUT', `/api/admin/profiles/${id('Robin')}`, { pin: '2468' })).status, 200);
    assert.strictEqual((await a.req('PUT', `/api/admin/profiles/${id('Robin')}`, { manager: true })).json.manager, false, 'not a kids profile');
    r = await a.req('PUT', `/api/admin/profiles/${id('Sam')}`, { pin: '' });
    assert.strictEqual(r.status, 400); assert.match(r.json.error, /must keep a PIN/);

    // Sam, on a device of their own.
    const s = srv.device();
    assert.strictEqual((await s.req('POST', '/api/login', { password: 'pw-test' })).status, 200);
    assert.strictEqual((await s.req('POST', `/api/profiles/${id('Sam')}/select`, { pin: '1357' })).status, 200);
    assert.strictEqual((await s.req('GET', '/api/me')).json.profile.manager, true);

    // What a manager sees of Admin: names and how things are doing. No settings, devices, addresses or sign-in details.
    const view = await s.req('GET', '/api/admin');
    assert.strictEqual(view.status, 200);
    assert.strictEqual(view.json.manager, true);
    assert.deepStrictEqual(view.json.settings, {});
    assert.strictEqual(view.json.devices, undefined);
    assert.deepStrictEqual(Object.keys(view.json.lists[0]).sort(), ['enabled', 'id', 'name', 'refreshing', 'status', 'type']);
    assert.ok(!/secret1|user1|198\.51\.100|pinAt|hash/.test(view.text), 'nothing of the lists’ addresses or anyone’s PIN');

    const ok = async (method, p, body) => { const x = await s.req(method, p, body); assert.strictEqual(x.status, 200, `${method} ${p}: ${x.text.slice(0, 160)}`); return x.json; };
    const no = async (method, p, body) => { const x = await s.req(method, p, body); assert.strictEqual(x.status, 403, `${method} ${p} should be the admin’s: ${x.status} ${x.text.slice(0, 120)}`); };

    // Channels: renaming and hiding, not locking.
    await ok('GET', '/api/admin/channels');
    await ok('PUT', `/api/admin/channels/${encodeURIComponent(chan.k)}`, { n: 'Channel 1' });
    assert.ok(JSON.stringify((await a.req('GET', '/api/admin/channels')).json).includes('Channel 1'));
    await no('PUT', `/api/admin/channels/${encodeURIComponent(chan.k)}`, { lock: true });
    await no('POST', '/api/admin/channels/bulk', { action: 'lock', keys: [chan.k] });
    await ok('POST', '/api/admin/channels/bulk', { action: 'hide', keys: [chan.k] });
    await ok('POST', '/api/admin/channels/bulk', { action: 'unhide', keys: [chan.k] });
    await no('POST', '/api/admin/locks/toggle', { kind: 'key', value: chan.k, on: true });
    await no('PUT', '/api/admin/parental-pin', { pin: '9999' });
    // Lists: fetched again, with only "done" or "still going" back; not read, changed or removed.
    const again = await ok('POST', `/api/admin/lists/${listId}/refresh`);
    assert.ok(again.ok === true || again.running === true); assert.deepStrictEqual(Object.keys(again).length, 1);
    await no('PUT', `/api/admin/lists/${listId}`, { name: 'Mine now' });
    await no('DELETE', `/api/admin/lists/${listId}`);
    await no('POST', '/api/admin/lists', { type: 'url', url: 'http://198.51.100.9/x.m3u' });
    // Error reports and channel health: read and marked, not deleted or reconfigured.
    await ok('GET', '/api/admin/errors');
    await ok('GET', '/api/admin/health');
    await no('DELETE', '/api/admin/errors/all');
    await no('PUT', '/api/admin/errors-settings', { on: false });
    await no('GET', '/api/admin/errors-report.txt');
    await no('PUT', '/api/admin/health', { on: false });
    // Screen time: answering and giving time to others; the limits themselves, and their own time, aren't theirs.
    for (const who of ['Robin', 'Sam']) assert.strictEqual((await a.req('PUT', `/api/admin/screentime/${id(who)}`, { rule: { on: true, mode: 'same', same: { limit: 60 } } })).status, 200);
    // (Sam asks for more: it's for the admin to answer, not Sam.)
    assert.strictEqual((await s.req('POST', '/api/screentime/ask', { minutes: 30 })).status, 200);
    const mine = (await ok('GET', '/api/admin/screentime/pending')).find((x) => x.pid === id('Sam'));
    assert.ok(mine);
    await no('POST', `/api/admin/screentime/requests/${mine.id}`, { ok: true, minutes: 30 });
    // (Robin asks: Sam may answer.)
    const kid = srv.device();
    assert.strictEqual((await kid.req('POST', '/api/login', { password: 'pw-test' })).status, 200);
    assert.strictEqual((await kid.req('POST', `/api/profiles/${id('Robin')}/select`, { pin: '2468' })).status, 200);
    assert.strictEqual((await kid.req('POST', '/api/screentime/ask', { minutes: 15, note: 'one more episode' })).status, 200);
    const theirs = (await ok('GET', '/api/admin/screentime/pending')).find((x) => x.pid === id('Robin'));
    assert.strictEqual((await ok('POST', `/api/admin/screentime/requests/${theirs.id}`, { ok: true, minutes: 15 })).request.status, 'approved');
    await ok('GET', '/api/admin/screentime');
    await ok('GET', '/api/admin/screentime/pending');
    await ok('POST', `/api/admin/screentime/${id('Robin')}/grant`, { minutes: 15 });
    await no('POST', `/api/admin/screentime/${id('Sam')}/grant`, { minutes: 15 });
    await no('PUT', `/api/admin/screentime/${id('Robin')}`, { rule: null });
    await no('POST', `/api/admin/screentime/${id('Robin')}/reset`, {});
    // Everything else in Admin.
    await no('PUT', '/api/admin/settings', { noAdult: true });
    await no('POST', '/api/admin/password', { next: 'another-password' });
    await no('GET', '/api/admin/backup');
    await no('GET', '/api/admin/backups');
    await no('GET', '/api/admin/update');
    await no('GET', '/api/admin/stats');
    await no('GET', '/api/admin/relay/secret');
    await no('GET', '/api/admin/integrations');
    await no('POST', '/api/admin/apikeys', { name: 'x' });
    await no('PUT', `/api/admin/profiles/${id('Kim')}`, { manager: true });
    await no('PUT', `/api/admin/profiles/${id('Sam')}`, { kids: false });
    await no('DELETE', `/api/admin/profiles/${id('Kim')}`);
    await no('POST', `/api/admin/profiles/${id('Sam')}/make-admin`);
    await no('GET', '/api/admin/groups');
    await no('GET', '/api/admin/dvr');
    await no('GET', '/api/admin/outputs');

    // Nobody makes themselves one; an ordinary profile gets none of it.
    const k = srv.device();
    assert.strictEqual((await k.req('POST', '/api/login', { password: 'pw-test' })).status, 200);
    assert.strictEqual((await k.req('POST', `/api/profiles/${id('Kim')}/select`, {})).status, 200);
    await k.req('PUT', '/api/me', { manager: true, admin: true });
    assert.notStrictEqual((await k.req('GET', '/api/me')).json.profile.manager, true);
    for (const p of ['/api/admin', '/api/admin/channels', '/api/admin/errors', '/api/admin/screentime']) assert.strictEqual((await k.req('GET', p)).status, 403, p);

    // Made a kids profile, or the role taken away: it stops at once, on the device already signed in.
    assert.strictEqual((await a.req('PUT', `/api/admin/profiles/${id('Sam')}`, { manager: false })).json.manager, false);
    await no('GET', '/api/admin');
    await no('GET', '/api/admin/channels');
  } finally { srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a watchlist exported from Letterboxd or IMDb goes onto the wishlist: not what’s here already, nor twice', { timeout: 60000 }, async () => {
  const { parseWatchlist, parseCsv } = require('../lib/watchlist-import');
  // The files themselves.
  assert.deepStrictEqual(parseCsv('a,"b,1"\r\n"x ""q"" y","l1\nl2"\n'), [['a', 'b,1'], ['x "q" y', 'l1\nl2']]);
  const lb = '﻿Date,Name,Year,Letterboxd URI\r\n2024-01-02,"Paris, Texas",1984,https://boxd.it/29Sa\r\n2024-01-03,Heat,1995,https://boxd.it/2bg8\r\n2024-01-04,A Film,2019,https://boxd.it/zzzz\r\n2024-01-05,Heat,1995,https://boxd.it/2bg8\r\n';
  assert.deepStrictEqual(parseWatchlist(lb), { format: 'letterboxd', entries: [{ t: 'movie', n: 'Paris, Texas', y: 1984 }, { t: 'movie', n: 'Heat', y: 1995 }, { t: 'movie', n: 'A Film', y: 2019 }], skipped: 0 });
  const imdb = 'Position,Const,Created,Modified,Description,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres\n1,tt0903747,2020-01-01,2020-01-01,,Breaking Bad,Breaking Bad,https://www.imdb.com/title/tt0903747/,TV Series,9.5,49,2008,"Crime, Drama"\n2,tt0133093,,,,The Matrix,The Matrix,,Movie,8.7,136,1999,Action\n3,tt0959621,,,,Pilot,Pilot,,TV Episode,9,58,2008,Drama\n';
  assert.deepStrictEqual(parseWatchlist(imdb), { format: 'imdb', entries: [{ t: 'show', n: 'Breaking Bad', y: 2008, imdb: 'tt0903747' }, { t: 'movie', n: 'The Matrix', y: 1999, imdb: 'tt0133093' }], skipped: 1 });
  // (A Letterboxd list's own export starts with lines about the list.)
  assert.deepStrictEqual(parseWatchlist('Letterboxd list export v7\nDate,Name,Tags,URL,Description\n2024-01-01,My list,,https://boxd.it/abc,\n\nPosition,Name,Year,URL,Description\n1,Alien,1979,https://boxd.it/2awY,\n').entries, [{ t: 'movie', n: 'Alien', y: 1979 }]);
  assert.throws(() => parseWatchlist('just some words\nand more\n'), /doesn’t look like an exported list/);
  assert.throws(() => parseWatchlist('Title,Year\n'), /No titles/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlimport-'));
  const srv = await server(path.join(dir, 'data'), await freePort());
  try {
    const { a } = await household(srv);
    let r = await a.req('POST', '/api/wishlist/import', { csv: lb });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual({ format: r.json.format, total: r.json.total, added: r.json.added, here: r.json.here, already: r.json.already }, { format: 'letterboxd', total: 3, added: 2, here: 1, already: 0 });
    assert.deepStrictEqual(r.json.list.map((w) => w.n).sort(), ['Heat', 'Paris, Texas']);
    // Again, and IMDb's: nothing twice.
    r = await a.req('POST', '/api/wishlist/import', { csv: lb });
    assert.deepStrictEqual([r.json.added, r.json.already, r.json.here], [0, 2, 1]);
    r = await a.req('POST', '/api/wishlist/import', { csv: imdb });
    assert.deepStrictEqual([r.json.format, r.json.added, r.json.skipped], ['imdb', 2, 1]);
    const list = (await a.req('GET', '/api/wishlist')).json.list;
    assert.strictEqual(list.length, 4);
    assert.strictEqual(list.find((w) => w.n === 'Breaking Bad').t, 'show');
    // Not a list; nothing sent; switched off.
    assert.strictEqual((await a.req('POST', '/api/wishlist/import', { csv: 'hello\nworld' })).status, 400);
    assert.strictEqual((await a.req('POST', '/api/wishlist/import', {})).status, 400);
    await a.req('PUT', '/api/admin/settings', { off: { wishlist: true } });
    assert.strictEqual((await a.req('POST', '/api/wishlist/import', { csv: lb })).status, 403);
  } finally { srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
