// Event / PPV channel names: the event, its start time and "nothing on" read from the channel's name, and the
// listings made from them. Every name here is made up, in the styles providers use.
const test = require('node:test');
const assert = require('node:assert');
const { parseEventName, EventGuide, checkZone } = require('../lib/events');

// Sunday 1 November 2026, 15:00 UTC: 10:00 in New York (EST, the clocks went back that morning), 15:00 in London
// (GMT), 16:00 in Paris (CET), 07:00 in Los Angeles.
const NOW = Date.UTC(2026, 10, 1, 15, 0);
const iso = (t) => (t ? new Date(t).toISOString().slice(0, 16) + 'Z' : null);

// [name, list time zone, expected] — expected: null (not an event channel) or the fields to check.
const CASES = [
  // The examples from the brief
  ['USA | PPV 03: UFC 310: Pantoja vs Asakura (Sat 7 Dec 22:00 ET)', '', { chan: 'PPV 03', tag: 'USA', title: 'UFC 310: Pantoja vs Asakura', start: '2026-12-08T03:00Z' }],
  ['NFL 05 | Bills vs Chiefs @ 8:20 PM ET', '', { chan: 'NFL 05', title: 'Bills vs Chiefs', start: '2026-11-02T01:20Z' }],
  ['EVENT 12 - 2026-11-02 19:45 Arsenal v Chelsea', 'Europe/London', { chan: 'EVENT 12', title: 'Arsenal v Chelsea', start: '2026-11-02T19:45Z' }],
  ['ESPN+ 14: NCAAF | Texas vs Michigan 11/02 3:30PM EST', '', { chan: 'ESPN+ 14', comp: 'NCAAF', title: 'Texas vs Michigan', start: '2026-11-02T20:30Z' }],
  ['DAZN 4 - NO EVENT STREAMING', '', { chan: 'DAZN 4', none: true, title: '', start: null }],

  // US zones: abbreviations follow the clocks there (EDT written in November still means New York time)
  ['NBA 07: Lakers @ Celtics 7:30 PM ET', '', { chan: 'NBA 07', title: 'Lakers @ Celtics', start: '2026-11-02T00:30Z' }],
  ['NHL 03 | Maple Leafs vs Canadiens | 19:00 ET', '', { title: 'Maple Leafs vs Canadiens', start: '2026-11-02T00:00Z' }],
  ['MLB 12 - Yankees vs Red Sox 1:05PM ET', '', { title: 'Yankees vs Red Sox', start: '2026-11-01T18:05Z' }],
  ['NFL 09: Bears vs Packers 12:00 PM CT', '', { title: 'Bears vs Packers', start: '2026-11-01T18:00Z' }],
  ['FOX 12 | Oregon vs USC 7:30 PM PT', '', { chan: 'FOX 12', title: 'Oregon vs USC', start: '2026-11-02T03:30Z' }],
  ['ESPN+ 3: Texas vs Oklahoma 11/07 12:00PM EDT', '', { start: '2026-11-07T17:00Z' }],
  ['MLS 4 | Inter Miami vs LAFC | Sat 11/7 7:30 PM ET', '', { title: 'Inter Miami vs LAFC', start: '2026-11-08T00:30Z' }],
  ['NBA | Lakers vs Celtics 7:30PM ET', '', { chan: 'NBA', title: 'Lakers vs Celtics', start: '2026-11-02T00:30Z' }],
  ['NBA 2: Suns vs Kings 12:30 AM ET', '', { start: '2026-11-02T05:30Z' }], // 00:30 was this morning: the next one
  ['PPV 8: Dec 13 8PM ET - UFC 323', '', { chan: 'PPV 8', title: 'UFC 323', start: '2026-12-14T01:00Z' }],
  ['PPV 5 - Canelo vs Crawford - November 8th 2026 9pm ET', '', { title: 'Canelo vs Crawford', start: '2026-11-09T02:00Z' }],

  // UK and Europe
  ['UK: Sky Sports Box Office 2 - Joshua v Fury - Sat 22:00 (UK)', '', { chan: 'Sky Sports Box Office 2', tag: 'UK', title: 'Joshua v Fury', start: '2026-11-07T22:00Z' }],
  ['PPV 6 | Usyk v Dubois | 8 Nov 21:00 GMT', '', { title: 'Usyk v Dubois', start: '2026-11-08T21:00Z' }],
  ['EVENT 7 - 02/11/2026 19:30 BST - Celtic v Rangers', '', { title: 'Celtic v Rangers', start: '2026-11-02T18:30Z' }], // BST is fixed: UTC+1
  ['DAZN 2 | Inter vs Milan | 03.11.2026 20:45 CEST', '', { title: 'Inter vs Milan', start: '2026-11-03T19:45Z' }], // Paris clocks
  ['EVENT 2 | PSG vs OM | 20h45 CET | 08/11', '', { title: 'PSG vs OM', start: '2026-11-08T19:45Z' }], // day first outside the US
  ['EVENT 9 | Tomorrow 20:00 CET | Bayern vs Dortmund', '', { title: 'Bayern vs Dortmund', start: '2026-11-02T19:00Z' }],
  ['EVENT 1 - 3 Jan 15:00 UK Arsenal v Spurs', '', { title: 'Arsenal v Spurs', start: '2027-01-03T15:00Z' }], // the nearest 3 January
  ['Peacock 07: Premier League | Spurs v Man City | Sun 2 Nov 14:00 UK', '', { chan: 'Peacock 07', comp: 'Premier League', title: 'Spurs v Man City', start: '2026-11-02T14:00Z' }],

  // Offsets
  ['EVENT 3 - 2026-11-03 20:00 GMT+2 Real Madrid v Barcelona', '', { title: 'Real Madrid v Barcelona', start: '2026-11-03T18:00Z' }],
  ['EVENT 3 - 2026-11-03 20:00+01:00 Real Madrid v Barcelona', '', { start: '2026-11-03T19:00Z' }],
  ['EVENT 3 | Real Madrid v Barcelona | 3 Nov 18:00 UTC-5', '', { start: '2026-11-03T23:00Z' }],
  ['EVENT 30 - 2026-11-04T19:00:00Z - Ajax v PSV', '', { title: 'Ajax v PSV', start: '2026-11-04T19:00Z' }],

  // No zone in the name: the list's own time zone
  ['EVENT 20 - 20:00 Porto v Benfica', 'Europe/Lisbon', { start: '2026-11-01T20:00Z' }],
  ['EVENT 20 - 20:00 Porto v Benfica', 'America/New_York', { start: '2026-11-02T01:00Z' }],
  ['EVENT 20 - 20:00 Porto v Benfica', '+03:00', { start: '2026-11-01T17:00Z' }],
  ['EVENT 20 - 20:00 CET Porto v Benfica', 'America/New_York', { start: '2026-11-01T19:00Z' }], // the name's zone wins
  ['EVENT 6 - Lyon et Marseille 20:00', 'Europe/Paris', { title: 'Lyon et Marseille', start: '2026-11-01T19:00Z' }], // "et" isn't a zone

  // Only a time or a weekday: the next one (something that started under 3 hours ago is on now)
  ['EVENT 4 - 09:00 Leeds v Hull', 'Europe/London', { start: '2026-11-02T09:00Z' }],
  ['EVENT 5 - 13:30 Leeds v Hull', 'Europe/London', { start: '2026-11-01T13:30Z' }],
  ['PPV 2: Boxing: Smith vs Jones (Sun 14:00 UK)', '', { start: '2026-11-01T14:00Z' }],
  ['PPV 2: Boxing: Smith vs Jones (Sun 08:00 UK)', '', { start: '2026-11-08T08:00Z' }],
  ['PPV 11 - 20:00', 'UTC', { chan: 'PPV 11', title: '', start: '2026-11-01T20:00Z', none: false }],

  // Live, ended, the older pipe style with the channel at the end
  ['SOCCER PPV 1 | LIVE | Chelsea vs Man Utd', '', { chan: 'SOCCER PPV 1', title: 'Chelsea vs Man Utd', live: true, start: null }],
  ['End | Chelsea vs. Man Utd | all | 31-10-2026 | 00:00 (GMT) | 8K EXCLUSIVE | US: SOCCER PPV 1', '', { chan: 'SOCCER PPV 1', tag: 'US', title: 'Chelsea vs. Man Utd', ended: true, start: '2026-10-31T00:00Z' }],
  ['EVENT 8 | Chelsea 2-1 Arsenal | Ended', '', { title: 'Chelsea 2-1 Arsenal', ended: true, start: null }],
  ['Arsenal v Chelsea (EVENT 12)', '', { chan: 'EVENT 12', title: 'Arsenal v Chelsea' }],
  ['PPV 1 | WrestleMania 43', '', { chan: 'PPV 1', title: 'WrestleMania 43', start: null }],
  ['Sky Sports 1 | Arsenal v Chelsea', '', { chan: 'Sky Sports 1', title: 'Arsenal v Chelsea', start: null }],

  // Nothing on
  ['PPV 09 | Off Air', '', { chan: 'PPV 09', none: true }],
  ['EVENT 3 - No Events Scheduled', '', { chan: 'EVENT 3', none: true }],
  ['USA | PPV 05', '', { chan: 'PPV 05', tag: 'USA', none: true }],
  ['NFL 08 | HD', '', { chan: 'NFL 08', none: true }],
  ['ESPN+ 21 - No live event right now', '', { chan: 'ESPN+ 21', none: true }],

  // Ordinary channels
  ['Sky Sports F1 | HD', '', null],
  ['Sky Sports Main Event', '', null],
  ['BBC One HD', '', null],
  ['BBC Two | HD', '', null],
  ['ITV 1 HD', '', null],
  ['Channel 4 +1', '', null],
  ['Fox Sports 1 - East', '', null],
  ['ESPN 2 | US', '', null],
  ['beIN Sports 3 | Arabic', '', null],
  ['TSN 1', '', null],
  ['Nick Jr. 2', '', null],
  ['UK: Sky Cinema Premiere', '', null],
  ['CNN International', '', null],
];

test('event channel names: event, start time, nothing on (table)', () => {
  const bad = [];
  for (const [name, tz, want] of CASES) {
    const got = parseEventName(name, { tz, now: NOW });
    if (want === null) { if (got !== null) bad.push(`${name}: expected an ordinary channel, got ${JSON.stringify(got)}`); continue; }
    if (!got) { bad.push(`${name}: not read as an event channel`); continue; }
    for (const [k, v] of Object.entries(want)) {
      const have = k === 'start' ? iso(got.start) : got[k];
      if (have !== v) bad.push(`${name} [${tz}]: ${k} = ${JSON.stringify(have)}, expected ${JSON.stringify(v)}`);
    }
  }
  assert.deepStrictEqual(bad, []);
  assert.ok(CASES.length >= 60);
});

test('time zones: names, offsets and junk', () => {
  assert.strictEqual(checkZone('Europe/London'), 'Europe/London');
  assert.strictEqual(checkZone('UTC'), 0);
  assert.strictEqual(checkZone('+05:30'), 330);
  assert.strictEqual(checkZone('GMT-4'), -240);
  assert.strictEqual(checkZone('Not/AZone'), null);
  assert.strictEqual(checkZone(''), null);
  // A list zone that isn't real falls back without throwing.
  assert.ok(parseEventName('EVENT 20 - 20:00 Porto v Benfica', { tz: 'Mars/Olympus', now: NOW }).start);
});

test('listings from event channels: 3 hours, or until the next event; names that move on', () => {
  const g = new EventGuide();
  const H = 3600e3;
  const at = (h) => NOW + h * H;
  const name = (t, title) => { const d = new Date(t); return `EVENT 12 - ${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} ${title}`; };
  assert.ok(g.update([{ k: 'a', n: name(at(2), 'Arsenal v Chelsea'), tz: 'UTC' }, { k: 'b', n: 'DAZN 4 - NO EVENT STREAMING', tz: '' }, { k: 'c', n: 'BBC One', tz: '' }], NOW));
  let a = g.map.get('ev:a');
  assert.strictEqual(a.length, 1);
  assert.deepStrictEqual([a[0].s, a[0].e, a[0].t], [at(2), at(5), 'Arsenal v Chelsea']);
  assert.ok(a[0].c.includes('Sports'));
  assert.ok(!g.map.has('ev:b') && !g.map.has('ev:c'));
  assert.ok(g.info.get('b').none && !g.info.has('c'));
  // The same names again: nothing changes.
  assert.strictEqual(g.update([{ k: 'a', n: name(at(2), 'Arsenal v Chelsea'), tz: 'UTC' }], NOW), false);
  // The list refreshes and the channel now names the next event, sooner than 3 hours after the first: the first
  // one runs until the next starts.
  const later = at(3);
  g.update([{ k: 'a', n: name(at(4.5), 'Spurs v Fulham'), tz: 'UTC' }], later);
  a = g.map.get('ev:a');
  assert.deepStrictEqual(a.map((x) => [x.t, (x.s - NOW) / H, (x.e - NOW) / H]), [['Arsenal v Chelsea', 2, 4.5], ['Spurs v Fulham', 4.5, 7.5]]);
  // Then it says nothing's on: the one on now stops now.
  const t2 = at(5);
  g.update([{ k: 'a', n: 'EVENT 12 - No event', tz: 'UTC' }], t2);
  a = g.map.get('ev:a') || [];
  assert.ok(a.every((x) => x.e <= t2), JSON.stringify(a));
  // A channel that's gone is forgotten.
  g.update([], t2);
  assert.strictEqual(g.map.size, 0);
});

test('in the catalogue: short channel name, event aside, a key that stays as the event changes, per list', () => {
  const { Catalog } = require('../lib/catalog');
  const build = (a, b) => {
    const lists = [{ id: 'A', items: a }, { id: 'B', items: b }];
    const ls = { all: () => lists.map((l) => ({ id: l.id, name: l.id, enabled: true, type: 'url' })), parsed: new Map(lists.map((l) => [l.id, { items: l.items, epgUrls: [] }])) };
    const c = new Catalog({ lists: ls, epg: { has: () => false, resolve: () => null }, getSettings: () => ({ tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [] }) });
    c.build();
    return c.items;
  };
  const ch = (name, i) => ({ name, type: 'live', url: `http://p/${i}.m3u8`, group: 'Events' });
  const one = build([ch('USA | PPV 03: UFC 310: Pantoja vs Asakura (Sat 7 Dec 22:00 ET)', 1), ch('DAZN 4 - NO EVENT STREAMING', 2), ch('Sky Sports Main Event HD', 3)], [ch('USA | PPV 03: Canelo vs Crawford 9pm ET', 4)]);
  const ppv = one.filter((x) => x.n === 'PPV 03');
  assert.strictEqual(ppv.length, 2, 'two providers’ PPV 03 stay apart');
  assert.deepStrictEqual(ppv.map((x) => x.ev).sort(), ['Canelo vs Crawford', 'UFC 310: Pantoja vs Asakura']);
  assert.ok(ppv.every((x) => x.rn));
  assert.strictEqual(one.find((x) => x.n === 'DAZN 4').evs, 'none');
  const sky = one.find((x) => /Sky Sports Main Event/.test(x.n));
  assert.ok(sky && !sky.rn && !sky.ev && sky.hd);
  // The next day the name carries another event: same channel (key), new event.
  const two = build([ch('USA | PPV 03: Boxing: Usyk v Dubois (Sun 8 Dec 21:00 UK)', 1)], []);
  const a1 = ppv.find((x) => x.src === 'A'), a2 = two.find((x) => x.n === 'PPV 03');
  assert.strictEqual(a2.k, a1.k);
  assert.strictEqual(a2.ev, 'Boxing: Usyk v Dubois');
});
