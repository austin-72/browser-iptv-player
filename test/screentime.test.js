// Screen time: daily limits per day of the week, bedtime and allowed hours, extra time, requests, time zones —
// the counting rules (with a pretend clock), then the real server refusing playback, counting two devices once and
// telling a device to stop.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const { ScreenTime, cleanRule, localParts } = require('../lib/screentime');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
const at = (iso) => Date.parse(iso);
const MIN = 60e3;

test('daily limit: counts once per minute, then stops; school days and weekends differ', () => {
  let now = at('2026-11-02T10:00:00Z'); // a Monday
  const st = new ScreenTime(tmp(), { now: () => now, tzDefault: () => 'UTC' });
  st.setRule('kid', { mode: 'week', school: { limit: 60 }, weekend: { limit: 120 } });
  assert.deepStrictEqual(st.state('kid').left, 60);
  // Two devices (or a party and a multiview) in the same minute: one minute.
  st.tick(new Set(['kid']));
  st.tick(new Set(['kid']));
  assert.strictEqual(st.state('kid').used, 1);
  for (let i = 1; i < 59; i++) { now += MIN; st.tick(new Set(['kid'])); }
  let s = st.state('kid');
  assert.strictEqual(s.used, 59);
  assert.strictEqual(s.left, 1);
  assert.strictEqual(s.blocked, false);
  now += MIN; st.tick(new Set(['kid']));
  s = st.state('kid');
  assert.strictEqual(s.blocked, true);
  assert.strictEqual(s.reason, 'limit');
  assert.strictEqual(s.nextAt, at('2026-11-03T00:00:00Z'), 'again tomorrow (no hours set: from midnight)');
  // Not watching: nothing counted.
  now += 5 * MIN; st.tick(new Set());
  assert.strictEqual(st.state('kid').used, 60);
  // Saturday: the weekend limit, and a new day starts at zero.
  now = at('2026-11-07T09:00:00Z');
  s = st.state('kid');
  assert.strictEqual(s.used, 0);
  assert.strictEqual(s.left, 120);
  // A profile with no rule is never limited or counted.
  assert.deepStrictEqual(st.state('other'), { limited: false });
  assert.deepStrictEqual(st.tick(new Set(['other'])), []);
});

test('bedtime and allowed hours, with extra time past bedtime', () => {
  let now = at('2026-11-02T19:00:00Z');
  const st = new ScreenTime(tmp(), { now: () => now, tzDefault: () => 'UTC' });
  st.setRule('kid', { mode: 'same', same: { from: '07:00', to: '19:30' } });
  let s = st.state('kid');
  assert.strictEqual(s.left, 30);
  assert.strictEqual(s.reason, 'bedtime', 'bedtime is what stops it next');
  assert.strictEqual(s.allowance, null);
  now = at('2026-11-02T19:30:00Z');
  s = st.state('kid');
  assert.strictEqual(s.blocked, true);
  assert.strictEqual(s.reason, 'bedtime');
  assert.strictEqual(s.nextAt, at('2026-11-03T07:00:00Z'));
  now = at('2026-11-03T05:10:00Z');
  s = st.state('kid');
  assert.strictEqual(s.blocked, true);
  assert.strictEqual(s.reason, 'early');
  assert.strictEqual(s.nextAt, at('2026-11-03T07:00:00Z'));
  // Extra time after bedtime: from now.
  now = at('2026-11-02T20:00:00Z');
  s = st.grant('kid', 30);
  assert.strictEqual(s.blocked, false);
  assert.strictEqual(s.left, 30);
  now += 31 * MIN;
  assert.strictEqual(st.state('kid').blocked, true);
  // Extra time just before bedtime: they get it past bedtime.
  now = at('2026-11-04T19:20:00Z');
  s = st.grant('kid', 20);
  assert.strictEqual(s.left, 30, '10 minutes to bedtime + 20 extra');
  // Bedtime after midnight (weekends): 07:00 until 00:30.
  st.setRule('kid', { mode: 'same', same: { from: '07:00', to: '00:30' } });
  now = at('2026-11-07T00:10:00Z');
  assert.strictEqual(st.state('kid').left, 20);
  now = at('2026-11-07T00:45:00Z');
  assert.strictEqual(st.state('kid').reason, 'bedtime');
  // Only a bedtime: the morning starts at 06:00.
  st.setRule('kid', { mode: 'same', same: { to: '20:00' } });
  now = at('2026-11-07T05:00:00Z');
  assert.strictEqual(st.state('kid').reason, 'early');
  assert.strictEqual(st.state('kid').from, '06:00');
});

test('extra time, resets and "ask for more time"', () => {
  let now = at('2026-11-02T12:00:00Z');
  const st = new ScreenTime(tmp(), { now: () => now, tzDefault: () => 'UTC' });
  st.setRule('kid', { mode: 'same', same: { limit: 1 } });
  st.tick(new Set(['kid']));
  assert.strictEqual(st.state('kid').blocked, true);
  const r = st.ask('kid', 15, 'Just this episode');
  assert.strictEqual(st.state('kid').asked, true);
  assert.strictEqual(st.ask('kid', 30).id, r.id, 'one waiting request per profile');
  assert.strictEqual(st.pending().length, 1);
  const { state } = st.answer(r.id, true);
  assert.strictEqual(state.blocked, false);
  assert.strictEqual(state.left, 30);
  assert.strictEqual(state.extra, 30);
  assert.strictEqual(st.pending().length, 0);
  // Declined: nothing changes.
  const r2 = st.ask('kid', 60);
  assert.strictEqual(st.answer(r2.id, false).state.left, 30);
  assert.throws(() => st.grant('kid', 0), /between/);
  assert.throws(() => st.grant('nobody', 10), /no screen time/);
  // Back to normal for today: extra time gone; the minutes watched stay unless cleared too.
  assert.strictEqual(st.resetToday('kid').blocked, true);
  assert.strictEqual(st.resetToday('kid', { clearUsed: true }).left, 1);
  // Turned off: not limited, and the rule is kept for later.
  st.setRule('kid', { on: false, mode: 'same', same: { limit: 1 } });
  assert.deepStrictEqual(st.state('kid'), { limited: false });
  assert.strictEqual(st.adminView('kid').rule.on, false);
  // Saved to disk.
  st.store.flush();
  const again = new ScreenTime(path.dirname(st.store.file), { now: () => now, tzDefault: () => 'UTC' });
  assert.strictEqual(again.d.rules.kid.days[1].limit, 1);
});

test('time zones: the server’s, or the profile’s own', () => {
  const now = at('2026-11-02T22:30:00Z'); // Monday 22:30 in London, Tuesday 07:30 in Tokyo, Monday 17:30 in New York
  assert.deepStrictEqual(localParts(now, 'Asia/Tokyo'), { date: '2026-11-03', dow: 2, min: 7 * 60 + 30, sec: 0 });
  const st = new ScreenTime(tmp(), { now: () => now, tzDefault: () => 'Europe/London' });
  const rule = { mode: 'same', same: { from: '07:00', to: '20:00' } };
  st.setRule('a', rule);
  st.setRule('b', { ...rule, tz: 'Asia/Tokyo' });
  st.setRule('c', { ...rule, tz: 'America/New_York' });
  assert.strictEqual(st.state('a').blocked, true, 'London: past bedtime');
  assert.strictEqual(st.state('a').tz, 'Europe/London');
  assert.strictEqual(st.state('b').blocked, false, 'Tokyo: morning');
  assert.strictEqual(st.state('b').left, 12 * 60 + 30);
  assert.strictEqual(st.state('c').left, 150, 'New York: 2 h 30 to bedtime');
  // The day (and so the daily count) follows the profile's time zone.
  st.tick(new Set(['b']));
  assert.deepStrictEqual(Object.keys(st.d.history.b), ['2026-11-03']);
  assert.throws(() => cleanRule({ tz: 'Mars/Olympus' }), /time zone/);
  // Weekday groups: "each day" keeps seven separate rules.
  const each = cleanRule({ mode: 'each', days: [{ limit: 10 }, { limit: 20 }, null, null, null, null, { limit: 70 }] });
  assert.deepStrictEqual(each.days.map((d) => d.limit), [10, 20, null, null, null, null, 70]);
});

// ---------------------------------------------------------------- the real server
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the server refuses playback when time is up, counts devices together and stops them', { timeout: 60000 }, async () => {
  const port = await freePort();
  const dir = tmp();
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test', SCREENTIME_TICK_MS: '150', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const client = () => {
    let cookie = '';
    const req = async (method, p, body) => {
      const h = { 'X-App': '1' };
      if (cookie) h.Cookie = cookie;
      if (body !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
      const r = await fetch(base + p, { method, headers: h, body });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { status: r.status, json: j };
    };
    const events = async () => {
      const res = await new Promise((ok) => { http.get(`${base}/api/events?name=TV`, { headers: { Cookie: cookie } }, ok); });
      const ev = { text: '', res };
      res.on('data', (d) => { ev.text += d; });
      for (let i = 0; i < 50 && !/"conn"/.test(ev.text); i++) await wait(50);
      ev.conn = JSON.parse(/data: (\{"conn".*\})/.exec(ev.text)[1]).conn;
      return ev;
    };
    return { req, events };
  };
  const evs = [];
  try {
    for (let i = 0; i < 100 && !/Ready/.test(out); i++) await wait(100);
    assert.match(out, /Ready/, out);
    const admin = client();
    assert.strictEqual((await admin.req('POST', '/api/login', { password: 'pw-test' })).status, 200);
    const a = await admin.req('POST', '/api/profiles', { name: 'Alex', pin: '1234', avatar: 1 });
    const k = await admin.req('POST', '/api/profiles', { name: 'Sam', kids: true, avatar: 2 });
    assert.strictEqual(k.status, 200, JSON.stringify(k.json));
    const kid = client();
    await kid.req('POST', '/api/login', { password: 'pw-test' });
    assert.strictEqual((await kid.req('POST', `/api/profiles/${k.json.id}/select`, {})).status, 200);
    const play = () => kid.req('POST', '/api/play/sources', { k: 'nothing-here' });

    // No limits: playback isn't refused (this title just doesn't exist).
    assert.strictEqual((await play()).status, 404);
    assert.deepStrictEqual((await kid.req('GET', '/api/screentime')).json, { limited: false });
    assert.strictEqual((await admin.req('PUT', `/api/admin/screentime/${a.json.id}`, { rule: { mode: 'same', same: { limit: 10 } } })).status, 400, 'not the admin');
    assert.strictEqual((await admin.req('PUT', `/api/admin/screentime/${k.json.id}`, { rule: { mode: 'same', same: { limit: 10 }, tz: 'Nowhere/Land' } })).status, 400);
    assert.strictEqual((await kid.req('PUT', `/api/admin/screentime/${k.json.id}`, { rule: { mode: 'same', same: { limit: 0 } } })).status, 403, 'only the admin');

    // A daily limit of 0: every way of starting playback is refused, with the reason.
    let r = await admin.req('PUT', `/api/admin/screentime/${k.json.id}`, { rule: { mode: 'same', same: { limit: 0 } } });
    assert.strictEqual(r.status, 200);
    r = await play();
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.screentime.reason, 'limit');
    assert.match(r.json.error, /That’s all for today/);
    for (const [m, p] of [['POST', '/api/play/relay'], ['POST', '/api/play/session'], ['POST', '/api/play/reach'], ['GET', '/api/file/x'], ['GET', '/api/download/x']]) {
      assert.strictEqual((await kid.req(m, p, m === 'POST' ? { k: 'x' } : undefined)).status, 403, p);
    }
    // The admin is never limited.
    assert.strictEqual((await admin.req('POST', '/api/play/sources', { k: 'nothing-here' })).status, 404);

    // Bedtime, in the profile's own time zone: an hour that has already passed.
    const tzNow = localParts(Date.now(), 'Asia/Tokyo');
    const hh = (m) => `${String(Math.floor(((m + 1440) % 1440) / 60)).padStart(2, '0')}:${String(((m + 1440) % 1440) % 60).padStart(2, '0')}`;
    r = await admin.req('PUT', `/api/admin/screentime/${k.json.id}`, { rule: { mode: 'same', same: { from: hh(tzNow.min + 120), to: hh(tzNow.min + 180) }, tz: 'Asia/Tokyo' } });
    let s = (await kid.req('GET', '/api/screentime')).json;
    assert.strictEqual(s.blocked, true);
    assert.ok(['bedtime', 'early'].includes(s.reason));
    assert.strictEqual(s.tz, 'Asia/Tokyo');
    assert.match(s.message, /You can watch again at \d\d:\d\d/);
    assert.strictEqual((await play()).status, 403);
    // Extra time from the admin: playback allowed again.
    r = await admin.req('POST', `/api/admin/screentime/${k.json.id}/grant`, { minutes: 30 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.state.left, 30);
    assert.strictEqual((await play()).status, 404);

    // Two devices watching at once (one in multiview) count as one viewer.
    r = await admin.req('PUT', `/api/admin/screentime/${k.json.id}`, { rule: { mode: 'same', same: { limit: 120 } } });
    const e1 = await kid.events(), e2 = await kid.events();
    evs.push(e1, e2);
    const m0 = Math.floor(Date.now() / 60000);
    await kid.req('POST', '/api/presence', { conn: e1.conn, playing: { k: 'a', n: 'A' } });
    await kid.req('POST', '/api/presence', { conn: e2.conn, playing: null, multi: [{ k: 'b' }, { k: 'c' }] });
    await wait(700);
    const m1 = Math.floor(Date.now() / 60000);
    s = (await kid.req('GET', '/api/screentime')).json;
    assert.strictEqual(s.used, m1 - m0 + 1, 'one minute counted per clock minute, not per device');
    assert.match(e1.text, /event: screentime/, 'devices hear how much is left');
    // Nothing playing: nothing counted.
    await kid.req('POST', '/api/presence', { conn: e1.conn, playing: null });
    await kid.req('POST', '/api/presence', { conn: e2.conn, playing: null, multi: null });
    const before = (await admin.req('GET', '/api/admin/screentime')).json.profiles[k.json.id];
    assert.strictEqual(before.state.used, s.used);
    assert.strictEqual(before.week.length, 1);

    // Time's up while watching: the devices are told to stop.
    // (The extra time given above is for the profile's day; on a clock where that's also today in UTC it would still count.)
    await admin.req('POST', `/api/admin/screentime/${k.json.id}/reset`, {});
    await kid.req('POST', '/api/presence', { conn: e1.conn, playing: { k: 'a', n: 'A' } });
    r = await admin.req('PUT', `/api/admin/screentime/${k.json.id}`, { rule: { mode: 'same', same: { limit: 1 } } });
    for (let i = 0; i < 30 && !/"stop":true/.test(e1.text); i++) await wait(100);
    assert.match(e1.text, /"blocked":true[^\n]*"stop":true/);

    // Asking for more time: the admin hears about it, says yes, the device gets the time.
    const ea = await admin.events();
    evs.push(ea);
    r = await kid.req('POST', '/api/screentime/ask', { minutes: 15, note: 'Nearly done' });
    assert.strictEqual(r.json.asked, true);
    for (let i = 0; i < 30 && !/"ask"/.test(ea.text); i++) await wait(50);
    assert.match(ea.text, /"ask":\{[^}]*"name":"Sam","minutes":15/);
    const pend = (await admin.req('GET', '/api/admin/screentime/pending')).json;
    assert.deepStrictEqual(pend.map((x) => [x.name, x.minutes, x.note]), [['Sam', 15, 'Nearly done']], 'waiting for the admin (shown when their app opens)');
    assert.strictEqual((await kid.req('GET', '/api/admin/screentime/pending')).status, 403);
    const adm = (await admin.req('GET', '/api/admin/screentime')).json;
    assert.strictEqual(adm.pending.length, 1);
    assert.strictEqual(adm.tz, 'UTC');
    r = await admin.req('POST', `/api/admin/screentime/requests/${adm.pending[0].id}`, { ok: true });
    assert.strictEqual(r.json.state.blocked, false);
    assert.strictEqual(r.json.state.extra, 15);
    for (let i = 0; i < 30 && !/"granted":15/.test(e1.text); i++) await wait(50);
    assert.match(e1.text, /"granted":15/);
    // The admin's other devices close their pop-up; no chat messages as well (one note each side).
    assert.match(ea.text, /"answered":"/);
    assert.deepStrictEqual((await kid.req('GET', `/api/messages/${a.json.id}`)).json, []);
    // Saying no: the device hears it, nothing changes.
    const r2 = await kid.req('POST', '/api/screentime/ask', { minutes: 60 });
    const id2 = (await admin.req('GET', '/api/admin/screentime/pending')).json[0].id;
    r = await admin.req('POST', `/api/admin/screentime/requests/${id2}`, { ok: false });
    assert.strictEqual(r.json.state.extra, 15);
    for (let i = 0; i < 30 && !/"declined":true/.test(e1.text); i++) await wait(50);
    assert.match(e1.text, /"declined":true/);
    assert.strictEqual(r2.json.asked, true);

    // Turning limits off: not limited any more.
    await admin.req('PUT', `/api/admin/screentime/${k.json.id}`, { rule: null });
    assert.deepStrictEqual((await kid.req('GET', '/api/screentime')).json, { limited: false });
    // The default remote buttons sync with the profile's settings.
    r = await kid.req('PUT', '/api/me/prefs', { remoteKeys: { red: 'guide' } });
    assert.deepStrictEqual(r.json.remoteKeys, { red: 'guide' });
  } finally {
    for (const e of evs) try { e.res.destroy(); } catch {}
    app.kill();
  }
});
