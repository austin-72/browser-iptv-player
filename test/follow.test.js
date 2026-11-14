// Following teams and competitions: names from listings, loose matching, the index, and the real server's routes
// (Events, suggestions, automatic reminders, event channels in the guide). All names are made up or generic.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const F = require('../lib/follow');

test('teams and competitions from programme titles', () => {
  const T = (t) => F.teamsOf(t);
  assert.deepStrictEqual(T('Live: Arsenal v Chelsea'), ['Arsenal', 'Chelsea']);
  assert.deepStrictEqual(T('Chiefs @ Bills'), ['Chiefs', 'Bills']);
  assert.deepStrictEqual(T('UFC 310: Pantoja vs Asakura'), ['Pantoja', 'Asakura']);
  assert.deepStrictEqual(T('Premier League: Spurs v Man City'), ['Spurs', 'Man City']);
  assert.deepStrictEqual(T('Man Utd vs. Liverpool (Premier League)'), ['Man Utd', 'Liverpool']);
  assert.deepStrictEqual(T('NFL - Chiefs @ Bills'), ['Chiefs', 'Bills']);
  assert.deepStrictEqual(T('Lakers at Celtics'), ['Lakers', 'Celtics']);
  assert.deepStrictEqual(T('Flamengo x Palmeiras'), ['Flamengo', 'Palmeiras']);
  assert.deepStrictEqual(T('Live: Formula 1 Grand Prix'), []);
  assert.deepStrictEqual(T('Live at the Apollo'), []);
  const C = (t, c) => F.compOf({ t, c });
  assert.strictEqual(C('Live: Formula 1 Grand Prix'), 'Formula 1');
  assert.strictEqual(C('F1: Qualifying'), 'Formula 1');
  assert.strictEqual(C('Arsenal v Chelsea', ['Sports', 'English Premier League']), 'Premier League');
  assert.strictEqual(C('Texas vs Michigan', ['NCAAF']), 'College football');
  assert.strictEqual(C('Rugby: Six Nations - England v France'), 'Six Nations');
  assert.strictEqual(C('Leinster v Munster', ['Rugby Union: URC']), 'Rugby Union: URC');
  assert.deepStrictEqual(F.aboutProgramme({ t: 'Man Utd v Spurs', c: ['Premier League'] }), { teams: ['Manchester United', 'Tottenham Hotspur'], comp: 'Premier League' });
});

test('loose name matching: short forms, nicknames, typos — and not too loose', () => {
  const same = (a, b) => F.sameTeam(F.nk(a), F.nk(b));
  assert.ok(same('Manchester United', 'Man Utd'));
  assert.ok(same('Man United', 'Manchester United FC'));
  assert.ok(same('Kansas City Chiefs', 'Chiefs'));
  assert.ok(same('Lakers', 'Los Angeles Lakers'));
  assert.ok(same('LA Lakers', 'Los Angeles Lakers'));
  assert.ok(same('Arsnal', 'Arsenal'));
  assert.ok(same('Atletico Madrid', 'Atlético Madrid'));
  assert.ok(same('Brighton and Hove Albion', 'Brighton & Hove Albion'));
  assert.ok(same('Paris Saint-Germain', 'PSG'));
  assert.ok(!same('Manchester City', 'Manchester United'));
  assert.ok(!same('Newcastle United', 'United'));
  assert.ok(!same('Real Madrid', 'Real Betis'));
  assert.ok(!same('Chelsea', 'Celtic'));
  assert.ok(!same('Inter Milan', 'AC Milan'));
  assert.ok(F.dist('kitten', 'sitting', 3) === 3 && F.dist('abc', 'acb', 2) === 1);
});

test('the index: one game on several channels, nicknames joined, suggestions, matching', () => {
  const NOW = Date.UTC(2026, 10, 1, 15, 0), H = 3600e3;
  const ch = (k, n, progs, extra) => ({ it: { k, n, g: 'Sport', ...extra }, list: () => progs });
  const p = (h, len, t, c) => ({ s: NOW + h * H, e: NOW + (h + len) * H, t, c });
  const idx = new F.SportsIndex();
  const g = idx.build([
    ch('a', 'Arena 1', [p(-0.5, 2, 'Live: Arsenal v Chelsea', ['Football']), p(1.5, 1, 'Arsenal v Chelsea - Highlights', ['Football']), p(4, 2, 'Kansas City Chiefs @ Buffalo Bills', ['NFL'])]),
    ch('b', 'Arena Plus', [p(-0.25, 2, 'Arsenal vs. Chelsea', ['Sports']), p(6, 3, 'Live: Formula 1 Grand Prix', ['Motor Racing'])], { hd: 1 }),
    ch('c', 'NFL 05', [p(4.25, 3, 'Chiefs @ Bills', ['Sports', 'Event'])], { rn: 'NFL 05 | Chiefs @ Bills' }),
    ch('d', 'Cooking', [p(1, 1, 'Bake Off', ['Cookery'])]),
  ], NOW);
  while (!g.next().done);
  const titles = idx.games.map((x) => [x.t, x.ks.slice().sort().join(',')]);
  assert.deepStrictEqual(titles, [['Live: Arsenal v Chelsea', 'a,b'], ['Kansas City Chiefs @ Buffalo Bills', 'a,c'], ['Live: Formula 1 Grand Prix', 'b']]);
  assert.ok(!idx.teams.has('chiefs') && idx.teams.get('kansas city chiefs').n === 'Kansas City Chiefs');
  // Suggestions: from what's there, typos and short forms included.
  assert.deepStrictEqual(idx.suggest('chel').map((x) => x.n), ['Chelsea']);
  assert.strictEqual(idx.suggest('Chelsae')[0].n, 'Chelsea');
  assert.strictEqual(idx.suggest('f1')[0].n, 'Formula 1');
  assert.strictEqual(idx.suggest('man utd')[0].n, 'Manchester United'); // a known short form, though not on now
  assert.ok(idx.suggest('').length >= 5);
  // Matching what someone follows.
  const m = idx.matching({ teams: ['Chiefs'], comps: ['F1'] }, { now: NOW });
  assert.deepStrictEqual(m.map((x) => [x.g.t, x.why, x.team]), [['Kansas City Chiefs @ Buffalo Bills', 'Chiefs', true], ['Live: Formula 1 Grand Prix', 'F1', false]]);
  assert.deepStrictEqual(idx.matching({ teams: ['Chiefs'], comps: ['F1'] }, { now: NOW, teamsOnly: true }).length, 1);
  assert.deepStrictEqual(idx.matching({ teams: ['Arsnal'], comps: [] }, { now: NOW }).map((x) => x.why), ['Arsenal']);
});

// ---------------------------------------------------------------- the real server
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('Events, suggestions, automatic reminders and event channels on the real server', { timeout: 90000 }, async () => {
  const H = 3600e3;
  const base = Math.floor(Date.now() / H) * H;
  const fmt = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
  const utc = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  let pl;
  const m3u = () => [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="arena1" group-title="Sport",Arena Sports 1', 'http://127.0.0.1:1/a1.m3u8',
    '#EXTINF:-1 tvg-id="arena1" group-title="Sport",Arena Plus HD', 'http://127.0.0.1:1/a2.m3u8',
    '#EXTINF:-1 group-title="Events",' + `EVENT 12 - ${utc(base + 2 * H)} Arsenal v Chelsea`, 'http://127.0.0.1:1/e12.m3u8',
    '#EXTINF:-1 group-title="Events",NFL 05 | Chiefs @ Bills @ ' + new Date(base + 5 * H).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET', 'http://127.0.0.1:1/n5.m3u8',
    '#EXTINF:-1 group-title="Events",DAZN 4 - NO EVENT STREAMING', 'http://127.0.0.1:1/d4.m3u8',
    '#EXTINF:-1 group-title="News",Daily News', 'http://127.0.0.1:1/news.m3u8',
  ].join('\n') + '\n';
  const guide = () => ['<?xml version="1.0"?><tv><channel id="arena1"><display-name>Arena 1</display-name></channel>',
    `<programme start="${fmt(base - H)}" stop="${fmt(base + H)}" channel="arena1"><title>Live: Spurs v Man City</title><category>Football</category></programme>`,
    `<programme start="${fmt(base + H)}" stop="${fmt(base + 2 * H)}" channel="arena1"><title>The Pundits</title><category>Sports</category></programme>`,
    `<programme start="${fmt(base + 2 * H)}" stop="${fmt(base + 4 * H)}" channel="arena1"><title>Arsenal v Chelsea</title><category>Premier League</category></programme>`,
    `<programme start="${fmt(base + 6 * H)}" stop="${fmt(base + 9 * H)}" channel="arena1"><title>Live: Formula 1 Grand Prix</title><category>Motor Racing</category></programme>`,
    '</tv>'].join('\n');
  pl = http.createServer((q, r) => { if (q.url.startsWith('/guide')) { r.writeHead(200, { 'Content-Type': 'application/xml' }); r.end(guide()); } else { r.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); r.end(m3u()); } }).listen(0, '127.0.0.1');
  await new Promise((r) => pl.once('listening', r));
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8srv-'));
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test', TZ: 'America/New_York' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  let cookie = '';
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-App': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie(); if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, body: j, text: t };
  };
  try {
    for (let i = 0; i < 300 && !/Ready/.test(out); i++) await wait(100);
    assert.match(out, /Ready/, out);
    assert.strictEqual((await api('POST', '/api/login', { password: 'pw-test' })).status, 200);
    const admin = (await api('POST', '/api/profiles', { name: 'Alex', avatar: 1, pin: '1234' })).body;
    assert.ok(admin.admin);
    const list = (await api('POST', '/api/admin/lists', { type: 'url', name: 'Events', url: `http://127.0.0.1:${pl.address().port}/list.m3u` })).body;
    // (The server runs on New York time; this list's event times are UTC, which the admin sets on the list.)
    assert.strictEqual((await api('PUT', `/api/admin/lists/${list.id}`, { evTz: 'UTC' })).status, 200);
    assert.strictEqual((await api('POST', '/api/admin/guides', { url: `http://127.0.0.1:${pl.address().port}/guide.xml`, name: 'Sport guide' })).status, 200);
    // Event channels get listings from their names (and link like a guide); the guide arrives too.
    let cat, ev12, nfl, dazn, ev;
    for (let i = 0; i < 100; i++) {
      cat = (await api('GET', '/api/catalog')).body;
      ev12 = cat && cat.items.find((x) => x.n === 'EVENT 12');
      nfl = cat && cat.items.find((x) => x.n === 'NFL 05');
      ev = (await api('GET', '/api/follow/suggest?q=spurs')).body; // (from the guide, once it's read and indexed)
      const rr = ev12 && ev12.E ? (await api('GET', `/api/epg/range?keys=${encodeURIComponent(ev12.k)}&from=${base}&to=${base + 12 * H}`)).body : {};
      if (ev12 && ev12.E && nfl && nfl.E && ev && ev.some((x) => x.c > 0) && rr[ev12.k] && rr[ev12.k][0] && rr[ev12.k][0].s === base + 2 * H) break;
      await wait(300);
    }
    assert.ok(ev && ev.some((x) => x.c > 0), out);
    assert.ok(ev12 && ev12.E && ev12.evc, JSON.stringify(ev12));
    assert.strictEqual(ev12.ev, 'Arsenal v Chelsea');
    dazn = cat.items.find((x) => x.n === 'DAZN 4');
    assert.strictEqual(dazn.es, 'none');
    const r = (await api('GET', `/api/epg/range?keys=${encodeURIComponent(ev12.k)},${encodeURIComponent(nfl.k)}&from=${base}&to=${base + 12 * H}`)).body;
    assert.deepStrictEqual(r[ev12.k].map((x) => [x.t, x.s - base, x.e - base]), [['Arsenal v Chelsea', 2 * H, 5 * H]]);
    assert.strictEqual(r[nfl.k][0].t, 'Chiefs @ Bills');
    assert.strictEqual(r[nfl.k][0].s, base + 5 * H);
    // …so search and On later find them.
    assert.ok((await api('GET', '/api/epg/search?q=chiefs')).body.some((h) => h.k === nfl.k));
    assert.ok((await api('GET', '/api/onlater?h=24&kinds=sport')).body.items.some((x) => x.t === 'Chiefs @ Bills' || (x.ks || []).includes(nfl.k) || x.k === nfl.k));

    // "Why no listings?": a channel no guide carries says so (and that it still plays); one with listings doesn't claim that.
    const news = cat.items.find((x) => x.n === 'Daily News'), arena = cat.items.find((x) => x.n === 'Arena Sports 1');
    const whyNews = (await api('GET', '/api/epg/why/' + encodeURIComponent(news.k))).body;
    assert.strictEqual(whyNews.reason, 'no-match', JSON.stringify(whyNews));
    assert.match(whyNews.text, /None of the 1 TV guide carries this channel \(the provider gave it no guide name\)/);
    assert.match(whyNews.fix, /pick its guide channel by hand/);
    const whyArena = (await api('GET', '/api/epg/why/' + encodeURIComponent(arena.k))).body;
    assert.ok(['gap', 'ran-out'].includes(whyArena.reason), JSON.stringify(whyArena));
    assert.strictEqual((await api('GET', '/api/epg/why/nope')).status, 404);

    // Following: suggestions, then Events (live first, the best copy: an HD one the profile can see).
    const sug = (await api('GET', '/api/follow/suggest?q=Chelsae')).body;
    assert.strictEqual(sug[0].n, 'Chelsea');
    assert.deepStrictEqual((await api('GET', '/api/follow/about?t=' + encodeURIComponent('Man Utd v Spurs') + '&c=Premier%20League')).body, { teams: ['Manchester United', 'Tottenham Hotspur'], comp: 'Premier League' });
    let f = (await api('PUT', '/api/follow', { teams: ['Arsenal', 'Kansas City Chiefs', 'Tottenham'], comps: ['F1'] })).body;
    assert.deepStrictEqual([f.teams.length, f.comps, f.auto, f.sw], [3, ['F1'], true, false]);
    const events = (await api('GET', '/api/follow/events')).body;
    const t = events.items.map((x) => [x.t, x.live]);
    assert.deepStrictEqual(t[0], ['Live: Spurs v Man City', true], JSON.stringify(t));
    const ars = events.items.find((x) => /Arsenal v Chelsea/.test(x.t));
    const hd = cat.items.find((x) => x.n === 'Arena Plus');
    assert.strictEqual(ars.k, hd.k, 'the HD copy');
    assert.strictEqual(ars.also, 2, 'one game on three channels');
    assert.ok(events.items.some((x) => x.t === 'Chiefs @ Bills' && x.why === 'Kansas City Chiefs'));
    assert.ok(events.items.some((x) => /Formula 1/.test(x.t) && x.why === 'F1'));

    // Automatic reminders for the teams' games (not the competition's), and not one that's removed.
    let me = (await api('GET', '/api/me')).body;
    let rems = me.data.reminders.filter((x) => x.a);
    assert.deepStrictEqual(rems.map((x) => x.t).sort(), ['Arsenal v Chelsea', 'Chiefs @ Bills']);
    const chiefs = rems.find((x) => x.t === 'Chiefs @ Bills');
    await api('POST', '/api/reminders', { remove: { k: chiefs.k, s: chiefs.s } });
    // Switching channel automatically: the reminders follow the choice.
    f = (await api('PUT', '/api/follow', { sw: true })).body;
    me = (await api('GET', '/api/me')).body;
    rems = me.data.reminders.filter((x) => x.a);
    assert.deepStrictEqual(rems.map((x) => [x.t, x.sw]), [['Arsenal v Chelsea', 1]], 'the removed one stays removed');
    // Unfollowing takes the team's automatic reminders away; turning reminders off too.
    await api('POST', '/api/follow/toggle', { kind: 'team', n: 'Arsenal', on: false });
    me = (await api('GET', '/api/me')).body;
    assert.strictEqual(me.data.reminders.filter((x) => x.a).length, 0);
    await api('POST', '/api/follow/toggle', { kind: 'team', n: 'Arsenal', on: true });
    assert.strictEqual((await api('GET', '/api/me')).body.data.reminders.filter((x) => x.a).length, 1);
    await api('PUT', '/api/follow', { auto: false });
    assert.strictEqual((await api('GET', '/api/me')).body.data.reminders.filter((x) => x.a).length, 0);
    assert.strictEqual((await api('POST', '/api/follow/toggle', { kind: 'nope', n: 'x' })).status, 400);

    // Each profile its own; kids profiles see only what they may.
    const kid = (await api('POST', '/api/profiles', { name: 'Kid', avatar: 2, kids: true })).body;
    await api('POST', `/api/profiles/${kid.id}/select`, {});
    assert.deepStrictEqual((await api('GET', '/api/follow')).body.teams, []);
    assert.strictEqual((await api('GET', '/api/follow/events')).body.following, 0);
    await api('POST', `/api/profiles/${admin.id}/select`, { pin: '1234' });

    // Admin: event channels found, and hiding empty ones from Live TV (a setting every device hears about).
    const a = (await api('GET', '/api/admin/events')).body;
    assert.deepStrictEqual([a.total, a.empty, a.hideEmpty], [3, 1, true]);
    assert.strictEqual((await api('GET', '/api/boot')).body.hideEmptyEvents, true);
    await api('PUT', '/api/admin/events', { hideEmpty: false });
    assert.strictEqual((await api('GET', '/api/boot')).body.hideEmptyEvents, false);
    await api('POST', `/api/profiles/${kid.id}/select`, {});
    assert.strictEqual((await api('PUT', '/api/admin/events', { hideEmpty: true })).status, 403);
    await wait(700); // (saved a moment later)
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'follow.json'), 'utf8'));
    assert.ok(saved.p[admin.id] && saved.admin.hideEmptyEvents === false);
  } finally {
    app.kill();
    pl.close();
  }
});
