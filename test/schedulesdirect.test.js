'use strict';
// Schedules Direct as a TV guide (lib/schedulesdirect.js), against a pretend Schedules Direct: signing in once and
// keeping the token, a lineup's stations and listings in the shape guides are kept in, only changed programmes asked
// for again, their error codes in plain words — and through the real server: added in Admin, matched to a channel,
// the account's password hash never sent back.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { SchedulesDirect, stationCid } = require('../lib/schedulesdirect');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => ok(n)); }); });
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

/** A pretend Schedules Direct with one account (viewer / the-right-password) and one lineup of two stations. */
async function pretendSd() {
  const sd = { calls: [], programs: 0, expireNext: false, token: 'tok-1', n: 1, md5: { EP000000010001: 'm1', MV000000020000: 'm2', SH000000030000: 'm3' } };
  const today = new Date().toISOString().slice(0, 10);
  const at = (h) => `${today}T${String(h).padStart(2, '0')}:00:00Z`;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const p = new URL(req.url, 'http://x').pathname.replace(/^\/20141201/, '');
      sd.calls.push(req.method + ' ' + p);
      const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      let j = null; try { j = JSON.parse(body); } catch {}
      if (p === '/token') {
        if (!/superstation-iptv/.test(req.headers['user-agent'] || '')) return send(400, { code: 1005, message: 'Unknown client' });
        if (!j || j.username !== 'viewer' || j.password !== sha1('the-right-password')) return send(400, { code: 4003, message: 'Invalid username or password.' });
        sd.token = 'tok-' + (++sd.n);
        return send(200, { code: 0, message: 'OK', token: sd.token, tokenExpires: Math.round(Date.now() / 1000) + 86400 });
      }
      if (req.headers.token !== sd.token) return send(403, { code: 4006, message: 'Token has expired. Request new token.' });
      if (sd.expireNext) { sd.expireNext = false; sd.token = 'gone'; return send(403, { code: 4006, message: 'Token has expired. Request new token.' }); }
      if (p === '/lineups') return send(200, { code: 0, lineups: [{ lineup: 'USA-OTA-90210', name: 'Local Over the Air Broadcast', transport: 'Antenna', location: '90210' }, { lineup: 'USA-OLD-1', name: 'Gone', isDeleted: true }] });
      if (p === '/lineups/USA-OTA-90210') return send(200, {
        map: [{ stationID: '10001', uhfVhf: 7, atscMajor: 7, atscMinor: 1 }, { stationID: '10002', channel: '28' }],
        stations: [{ stationID: '10001', name: 'KABC', callsign: 'KABCDT', affiliate: 'ABC', stationLogo: [{ URL: 'https://logos.example/kabc.png' }] }, { stationID: '10002', name: 'KCET', callsign: 'KCETDT' }],
        metadata: { lineup: 'USA-OTA-90210', transport: 'Antenna' },
      });
      if (p === '/schedules') return send(200, (j || []).map((s) => (s.stationID === '10001'
        ? { stationID: '10001', programs: [{ programID: 'EP000000010001', airDateTime: at(18), duration: 1800, md5: sd.md5.EP000000010001, new: true, ratings: [{ body: 'USA Parental Rating', code: 'TV14' }] }, { programID: 'MV000000020000', airDateTime: at(19), duration: 7200, md5: sd.md5.MV000000020000 }], metadata: { md5: 'x', startDate: today } }
        : s.stationID === '10002' ? { stationID: '10002', programs: [{ programID: 'SH000000030000', airDateTime: at(20), duration: 3600, md5: sd.md5.SH000000030000 }, { programID: 'SH000000099999', airDateTime: at(21), duration: 3600, md5: 'm9' }], metadata: {} }
          : { stationID: s.stationID, code: 2201, response: 'STATIONID_DELETED' })));
      if (p === '/programs') {
        sd.programs += (j || []).length;
        const all = {
          EP000000010001: { programID: 'EP000000010001', titles: [{ title120: 'The Rookie' }], episodeTitle150: 'The Hunt', descriptions: { description100: [{ descriptionLanguage: 'en', description: 'Short.' }], description1000: [{ descriptionLanguage: 'es', description: 'En español.' }, { descriptionLanguage: 'en', description: 'Nolan tracks a fugitive.' }] }, genres: ['Crime drama', 'Action', 'Drama', 'Extra'], metadata: [{ Gracenote: { season: 6, episode: 3 } }], entityType: 'Episode' },
          MV000000020000: { programID: 'MV000000020000', titles: [{ title120: 'Heat' }], descriptions: { description100: [{ descriptionLanguage: 'en', description: 'A heist.' }] }, genres: ['Crime'], contentRating: [{ body: 'MPAA', code: 'R' }], entityType: 'Movie' },
          SH000000030000: { programID: 'SH000000030000', titles: [{ title120: sd.md5.SH000000030000 === 'm3' ? 'SoCal Connected' : 'SoCal Connected (updated)' }], entityType: 'Show' },
        };
        return send(200, (j || []).map((id) => all[id] || { programID: id, code: 6001, message: 'queued' }));
      }
      send(404, { code: 4000, message: 'Invalid endpoint' });
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  sd.base = `http://127.0.0.1:${srv.address().port}/20141201`;
  sd.close = () => srv.close();
  sd.count = (what) => sd.calls.filter((c) => c === what).length;
  return sd;
}

test('Schedules Direct: one sign-in, a lineup’s listings, only what changed asked for again, errors in plain words', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-'));
  const pv = await pretendSd();
  try {
    const cred = { user: 'viewer', hash: SchedulesDirect.hash('the-right-password') };
    assert.match(cred.hash, /^[0-9a-f]{40}$/);
    let sd = new SchedulesDirect({ dataDir: dir, base: pv.base, ua: 'superstation-iptv/test' });
    assert.deepStrictEqual(await sd.lineups(cred), [{ id: 'USA-OTA-90210', name: 'Local Over the Air Broadcast', transport: 'Antenna', location: '90210' }]);

    const g = await sd.guide(cred, 'USA-OTA-90210', { days: 2 });
    const a = stationCid('10001'), b = stationCid('10002');
    assert.strictEqual(a, 'I10001.json.schedulesdirect.org');
    assert.deepStrictEqual(g.channels[a], { names: ['KABC', 'KABCDT', 'ABC KABCDT'], icon: 'https://logos.example/kabc.png' });
    assert.deepStrictEqual(g.channels[b], { names: ['KCET', 'KCETDT'], icon: '' });
    assert.strictEqual(g.programmeCount, 4);
    const [rookie, heat] = g.programmes[a];
    assert.deepStrictEqual({ t: rookie.t, st: rookie.st, d: rookie.d, ep: rookie.ep, c: rookie.c, n: rookie.n, r: rookie.r, len: rookie.e - rookie.s }, { t: 'The Rookie', st: 'The Hunt', d: 'Nolan tracks a fugitive.', ep: 'S06E03', c: ['Crime drama', 'Action', 'Drama'], n: 1, r: 'TV14', len: 1800e3 });
    assert.deepStrictEqual({ t: heat.t, d: heat.d, r: heat.r, st: heat.st }, { t: 'Heat', d: 'A heist.', r: 'R', st: undefined });
    assert.strictEqual(heat.s, rookie.s + 3600e3);
    assert.deepStrictEqual(g.programmes[b].map((p) => p.t), ['SoCal Connected', 'To be announced'], 'one whose details aren’t ready yet still has its slot');
    assert.strictEqual(pv.count('POST /token'), 1);
    assert.strictEqual(pv.programs, 4);

    // Again — after a restart too (the token and the details were kept): no sign-in, and only the one still waiting is asked for.
    sd = new SchedulesDirect({ dataDir: dir, base: pv.base, ua: 'superstation-iptv/test' });
    await sd.guide(cred, 'USA-OTA-90210', { days: 2 });
    assert.strictEqual(pv.count('POST /token'), 1, 'the token is kept for its day');
    assert.strictEqual(pv.programs, 5);
    // A programme changed on their side (its md5 did): that one is fetched again.
    pv.md5.SH000000030000 = 'm3b';
    const g3 = await sd.guide(cred, 'USA-OTA-90210', { days: 2 });
    assert.strictEqual(pv.programs, 7);
    assert.strictEqual(g3.programmes[b][0].t, 'SoCal Connected (updated)');
    // Their side says the token ran out early: one new sign-in, and the call goes through.
    pv.expireNext = true;
    assert.strictEqual((await sd.lineups(cred)).length, 1);
    assert.strictEqual(pv.count('POST /token'), 2);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'sd-cache.json'), 'utf8')).programs.EP000000010001[1], 'The Rookie');
    assert.ok(!fs.readFileSync(path.join(dir, 'sd-cache.json'), 'utf8').includes('the-right-password'));

    // A wrong password, a lineup that isn't theirs, the service not there: said plainly, and not tried again.
    const before = pv.calls.length;
    await assert.rejects(sd.lineups({ user: 'viewer', hash: SchedulesDirect.hash('wrong') }), /didn’t accept that user name and password/);
    assert.strictEqual(pv.calls.length, before + 1);
    await assert.rejects(sd.guide(cred, '../status'), /lineup isn’t on the Schedules Direct account/);
    await assert.rejects(new SchedulesDirect({ dataDir: dir, base: 'http://127.0.0.1:9/20141201' }).lineups({ user: 'x', hash: SchedulesDirect.hash('y') }), /Schedules Direct: couldn’t be reached/);
  } finally { pv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the server: a Schedules Direct lineup added in Admin gives its channel listings, and its password is never sent back', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-srv-'));
  const pv = await pretendSd();
  const port = await freePort();
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(dir, 'data'), NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test', SCHEDULES_DIRECT_URL: pv.base }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', cookie = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const raw = (method, p, body, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-App': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body });
  const req = async (method, p, body) => {
    const r = await raw(method, p, body !== undefined ? JSON.stringify(body) : undefined, body !== undefined ? { 'Content-Type': 'application/json' } : {});
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, text: t };
  };
  try {
    for (let i = 0; i < 300 && !/Ready/.test(out); i++) await wait(100);
    assert.match(out, /Ready/, out.slice(-500));
    assert.strictEqual((await req('POST', '/api/login', { password: 'pw-test' })).status, 200);
    assert.strictEqual((await req('POST', '/api/profiles', { name: 'Alex', pin: '4821' })).status, 200);
    const M3U = '#EXTM3U\n#EXTINF:-1 tvg-id="I10001.json.schedulesdirect.org" group-title="Local",ABC 7 Los Angeles\nhttp://198.51.100.7/live/1.ts\n#EXTINF:-1 group-title="Local",KCET\nhttp://198.51.100.7/live/2.ts\n';
    assert.strictEqual((await raw('POST', '/api/admin/lists/upload?name=Local&fileName=local.m3u', Buffer.from(M3U))).status, 200);

    // Sign in to see the lineups; a wrong password says so.
    let r = await req('POST', '/api/admin/schedulesdirect/lineups', { username: 'viewer', password: 'nope' });
    assert.strictEqual(r.status, 502); assert.match(r.json.error, /didn’t accept that user name and password/);
    r = await req('POST', '/api/admin/schedulesdirect/lineups', { username: 'viewer', password: 'the-right-password' });
    assert.deepStrictEqual(r.json.lineups.map((l) => l.id), ['USA-OTA-90210']);
    // Add it: the listings are fetched, and what comes back has the account's name but nothing of its password.
    r = await req('POST', '/api/admin/guides', { name: 'Schedules Direct: Local', sd: { username: 'viewer', password: 'the-right-password', lineup: 'USA-OTA-90210' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.status.ok, r.json.status.channels, r.json.status.programmes, r.json.url, r.json.sd], [true, 2, 4, 'sd:USA-OTA-90210', { user: 'viewer' }]);
    const hash = SchedulesDirect.hash('the-right-password');
    const admin = await req('GET', '/api/admin');
    assert.ok(!admin.text.includes(hash) && !admin.text.includes('the-right-password'));
    assert.deepStrictEqual(admin.json.guides.find((g) => g.url === 'sd:USA-OTA-90210').sd, { user: 'viewer' });
    r = await req('POST', `/api/admin/guides/${r.json.id}/refresh`);
    assert.ok(!r.text.includes(hash));
    assert.strictEqual((await req('POST', '/api/admin/guides', { sd: { username: 'viewer', password: 'the-right-password', lineup: 'USA-OTA-90210' } })).status, 400, 'not twice');

    // The channels: one by its tvg-id, one by its name.
    let cat = null, abc = null, kcet = null;
    for (let i = 0; i < 80 && !(abc && abc.E && kcet && kcet.E); i++) { cat = (await req('GET', '/api/catalog')).json; abc = cat && cat.items && cat.items.find((x) => /ABC 7/.test(x.n)); kcet = cat && cat.items && cat.items.find((x) => x.n === 'KCET'); if (!(abc && abc.E && kcet && kcet.E)) await wait(250); }
    assert.ok(abc && abc.E, 'matched by tvg-id');
    assert.ok(kcet && kcet.E, 'matched by name');
    const from = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
    const range = (await req('GET', `/api/epg/range?keys=${encodeURIComponent(abc.k)},${encodeURIComponent(kcet.k)}&from=${from}&to=${from + 86400e3}`)).json;
    assert.deepStrictEqual(range[abc.k].map((p) => p.t), ['The Rookie', 'Heat']);
    assert.strictEqual(range[kcet.k][0].t, 'SoCal Connected');
  } finally { app.kill('SIGKILL'); pv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
