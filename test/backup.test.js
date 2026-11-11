'use strict';
// A backup, taken through the server and put back into an empty one, brings everything back: profiles and their
// PINs, settings, lists (an uploaded one whole; one from an address is downloaded again), a profile's settings and where it left a film.
// Also: every page carries the security policy, and none has a script of its own written into it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const zlib = require('zlib');
const { spawn } = require('child_process');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => ok(n)); }); });

/** A server on its own data folder: { req, raw, stop, exited, out }. */
async function server(dataDir, port, env = {}) {
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const me = { out: '', cookie: '', code: undefined };
  app.stdout.on('data', (d) => { me.out += d; });
  app.stderr.on('data', (d) => { me.out += d; });
  app.on('exit', (c) => { me.code = c === null ? -1 : c; });
  me.raw = (method, p, body, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-App': '1', ...(me.cookie ? { Cookie: me.cookie } : {}), ...headers }, body, redirect: 'manual' });
  me.req = async (method, p, body) => {
    const r = await me.raw(method, p, body !== undefined ? JSON.stringify(body) : undefined, body !== undefined ? { 'Content-Type': 'application/json' } : {});
    const sc = r.headers.get('set-cookie');
    if (sc) me.cookie = sc.split(';')[0];
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, text: t, headers: r.headers };
  };
  me.exited = async (ms = 15000) => { for (let i = 0; i < ms / 100 && me.code === undefined; i++) await wait(100); return me.code; };
  me.stop = () => { try { app.kill('SIGKILL'); } catch {} };
  for (let i = 0; i < 150 && !/Ready/.test(me.out) && me.code === undefined; i++) await wait(100);
  assert.match(me.out, /Ready/, me.out.slice(-600));
  return me;
}

test('a backup put back into an empty server brings everything back', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-rt-'));
  const data = path.join(dir, 'data');
  const M3U = '#EXTM3U\n#EXTINF:-1 tvg-id="one" group-title="News",Channel One\nhttp://198.51.100.7/one.m3u8\n#EXTINF:-1 group-title="Films",A Film (2019)\nhttp://198.51.100.7/movie/u/p/1.mp4\n';
  let a = await server(data, await freePort());
  let b = null;
  try {
    // A household: an admin with a PIN, a second profile, a kids profile, an uploaded list, a few settings, a film part-watched.
    assert.strictEqual((await a.req('POST', '/api/login', { password: 'pw-test' })).status, 200);
    assert.strictEqual((await a.req('POST', '/api/profiles', { name: 'Alex', pin: '4821', avatar: 3 })).status, 200);
    assert.strictEqual((await a.req('POST', '/api/profiles', { name: 'Sam', avatar: 5 })).status, 200);
    assert.strictEqual((await a.req('POST', '/api/profiles', { name: 'Robin', kids: true, avatar: 7 })).status, 200);
    const boot0 = (await a.req('GET', '/api/boot')).json;
    const alex = boot0.profiles.find((x) => x.name === 'Alex');
    assert.ok(alex && alex.admin, 'the first profile is the admin');
    assert.strictEqual((await a.req('POST', `/api/profiles/${alex.id}/select`, { pin: '4821' })).status, 200);
    { const up = await a.raw('POST', '/api/admin/lists/upload?name=Pasted&fileName=pasted.m3u', Buffer.from(M3U)); assert.strictEqual(up.status, 200, await up.text()); }
    assert.strictEqual((await a.req('PUT', '/api/admin/settings', { noAdult: true, quickStart: false, transcodeMaxHeight: 720, brand: { name: 'Round Trip TV' } })).status, 200);
    let cat = null;
    for (let i = 0; i < 60 && !(cat && cat.items && cat.items.length >= 2); i++) { cat = (await a.req('GET', '/api/catalog')).json; if (!(cat && cat.items && cat.items.length >= 2)) await wait(200); }
    assert.ok(cat.items.length >= 2, 'the list is in the catalogue');
    const film = cat.items.find((x) => /A Film/.test(x.n));
    assert.ok(film);
    assert.strictEqual((await a.req('PUT', '/api/me/prefs', { dataSaver: true, audioLang: 'es' })).status, 200);
    assert.strictEqual((await a.req('POST', '/api/progress', { k: film.k, p: 1234, d: 5400 })).status, 200);
    const before = { admin: (await a.req('GET', '/api/admin')).json, me: (await a.req('GET', '/api/me')).json.data };
    assert.strictEqual(before.admin.settings.brand.name, 'Round Trip TV');
    assert.strictEqual(before.me.prefs.audioLang, 'es');
    assert.strictEqual(before.me.progress[film.k].p, 1234, 'where the film was left');

    // The backup.
    const r = await a.raw('GET', '/api/admin/backup');
    assert.strictEqual(r.status, 200);
    const backup = Buffer.from(await r.arrayBuffer());
    const inside = JSON.parse(zlib.gunzipSync(backup).toString('utf8'));
    assert.strictEqual(inside.app, 'browser-iptv-player');
    assert.ok(Object.keys(inside.files).some((f) => /accounts\.json$/.test(f)) && Object.keys(inside.files).some((f) => /settings\.json$/.test(f)));
    a.stop(); await a.exited();

    // Everything gone; a new, empty server; its own first admin puts the backup back.
    fs.rmSync(data, { recursive: true, force: true });
    b = await server(data, await freePort());
    assert.strictEqual((await b.req('POST', '/api/login', { password: 'pw-test' })).status, 200);
    assert.strictEqual((await b.req('GET', '/api/boot')).json.profiles.length, 0, 'empty to begin with');
    assert.strictEqual((await b.req('POST', '/api/profiles', { name: 'Temp', pin: '0000', avatar: 1 })).status, 200);
    // (Not a backup at all, and a damaged one: refused, nothing changed.)
    assert.strictEqual((await b.raw('POST', '/api/admin/restore', Buffer.from('not a backup'), { 'X-Admin-Pin': '0000' })).status, 400);
    assert.strictEqual((await b.raw('POST', '/api/admin/restore', zlib.gzipSync(Buffer.from(JSON.stringify({ app: 'browser-iptv-player', files: { 'settings.json': 42 } }))), { 'X-Admin-Pin': '0000' })).status, 400);
    assert.strictEqual((await b.req('GET', '/api/boot')).json.profiles.length, 1);
    // (Putting a backup back replaces everything: the admin's PIN again, not just being signed in as the admin.)
    assert.strictEqual((await b.raw('POST', '/api/admin/restore', backup, { 'Content-Type': 'application/gzip' })).status, 403, 'not without the PIN');
    assert.strictEqual((await b.raw('POST', '/api/admin/restore', backup, { 'X-Admin-Pin': '1111' })).status, 403, 'nor with a wrong one');
    assert.strictEqual((await b.raw('POST', '/api/admin/update', Buffer.from('PK'), {})).status, 403, 'an update neither');
    assert.strictEqual((await b.req('GET', '/api/boot')).json.profiles.length, 1, 'nothing changed');
    const put = await b.raw('POST', '/api/admin/restore', backup, { 'Content-Type': 'application/gzip', 'X-Admin-Pin': '0000' });
    assert.strictEqual(put.status, 200, await put.text());
    assert.strictEqual(await b.exited(), 0, 'it restarts itself after a restore');

    // Started again: the household is back.
    b = await server(data, await freePort());
    assert.strictEqual((await b.req('POST', '/api/login', { password: 'pw-test' })).status, 200);
    const boot = (await b.req('GET', '/api/boot')).json;
    assert.deepStrictEqual(boot.profiles.map((x) => x.name).sort(), ['Alex', 'Robin', 'Sam']);
    assert.ok(boot.profiles.find((x) => x.name === 'Robin').kids, 'the kids profile is still one');
    const alex2 = boot.profiles.find((x) => x.name === 'Alex');
    assert.strictEqual(alex2.id, alex.id);
    assert.notStrictEqual((await b.req('POST', `/api/profiles/${alex2.id}/select`, { pin: '0000' })).status, 200, 'the old PIN, not the stand-in admin\'s');
    assert.strictEqual((await b.req('POST', `/api/profiles/${alex2.id}/select`, { pin: '4821' })).status, 200);
    const after = (await b.req('GET', '/api/admin')).json;
    for (const k of ['noAdult', 'quickStart', 'transcodeMaxHeight']) assert.deepStrictEqual(after.settings[k], before.admin.settings[k], k);
    assert.strictEqual(after.settings.brand.name, 'Round Trip TV');
    assert.deepStrictEqual(after.lists.map((l) => [l.name, l.type]), before.admin.lists.map((l) => [l.name, l.type]));
    let cat2 = null;
    for (let i = 0; i < 60 && !(cat2 && cat2.items && cat2.items.length >= 2); i++) { cat2 = (await b.req('GET', '/api/catalog')).json; if (!(cat2 && cat2.items && cat2.items.length >= 2)) await wait(200); }
    assert.deepStrictEqual(cat2.items.map((x) => x.n).sort(), cat.items.map((x) => x.n).sort(), 'the uploaded list came back whole');
    const me2 = (await b.req('GET', '/api/me')).json.data;
    assert.strictEqual(me2.prefs.audioLang, 'es');
    assert.strictEqual(me2.prefs.dataSaver, true);
    assert.strictEqual(me2.progress[film.k].p, 1234, 'and where the film was left');
  } finally {
    a.stop(); if (b) b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every page carries the security policy, and none has a script written into it', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-'));
  const WEB = path.join(__dirname, '..', 'web');
  // Nothing in the pages or in the HTML the app writes runs script in place: the policy wouldn't run it.
  for (const f of ['index.html', 'login.html']) {
    const html = fs.readFileSync(path.join(WEB, f), 'utf8');
    assert.deepStrictEqual(html.match(/<script(?![^>]*\ssrc=)[^>]*>/g) || [], [], f + ' has a script of its own');
    assert.deepStrictEqual(html.match(/\son[a-z]+\s*=\s*["']/g) || [], [], f + ' has a handler written into it');
  }
  for (const f of fs.readdirSync(path.join(WEB, 'js')).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(WEB, 'js', f), 'utf8');
    assert.deepStrictEqual(src.match(/[\s"']on(?:click|error|load|focus|blur|change|input|submit|key\w+|mouse\w+|touch\w+|pointer\w+)\s*=\s*\\?["'][^"']/g) || [], [], f + ' writes a handler into HTML (use data- attributes and a listener)');
    assert.ok(!/javascript:/i.test(src), f + ' uses a javascript: address');
  }
  const s = await server(path.join(dir, 'data'), await freePort());
  const off = await server(path.join(dir, 'data2'), await freePort(), { CSP: 'off' });
  try {
    const page = await s.req('GET', '/');
    const csp = page.headers.get('content-security-policy') || '';
    assert.match(page.text, /<script src="\/login\.js"><\/script>/, 'the sign-in page');
    const dirs = Object.fromEntries(csp.split(';').map((x) => x.trim().split(/\s+/)).map((x) => [x[0], x.slice(1)]));
    assert.ok(dirs['script-src'].includes("'self'") && !dirs['script-src'].includes("'unsafe-inline'") && !dirs['script-src'].includes("'unsafe-eval'") && !dirs['script-src'].includes('*'), csp);
    assert.deepStrictEqual(dirs['object-src'], ["'none'"]);
    assert.deepStrictEqual(dirs['frame-ancestors'], ["'self'"]);
    assert.deepStrictEqual(dirs['base-uri'], ["'self'"]);
    assert.ok(dirs['media-src'].includes('*') && dirs['img-src'].includes('*') && dirs['connect-src'].includes('*'), 'providers\' streams and pictures come from anywhere');
    assert.strictEqual(page.headers.get('x-frame-options'), 'SAMEORIGIN');
    // The sign-in page's script is there for someone not signed in; nothing else is.
    const js = await s.req('GET', '/login.js');
    assert.strictEqual(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.match(js.text, /api\/login/);
    assert.strictEqual((await s.req('GET', '/early.js')).status, 302, 'the app\'s files need signing in');
    // Signed in: the app page, its early script, and an API answer all carry it.
    assert.strictEqual((await s.req('POST', '/api/login', { password: 'pw-test' })).status, 200);
    const app = await s.req('GET', '/');
    assert.match(app.text, /<script src="\/early\.js\?v=[\w.-]+"><\/script>/);
    assert.strictEqual(app.headers.get('content-security-policy'), csp);
    const early = await s.req('GET', '/early.js');
    assert.strictEqual(early.status, 200);
    assert.match(early.text, /client-errors/);
    assert.strictEqual((await s.req('GET', '/api/boot')).headers.get('content-security-policy'), csp);
    // Switched off (CSP=off): neither header.
    const p2 = await off.req('GET', '/');
    assert.strictEqual(p2.headers.get('content-security-policy'), null);
    assert.strictEqual(p2.headers.get('x-frame-options'), null);
    assert.strictEqual(p2.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    s.stop(); off.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
