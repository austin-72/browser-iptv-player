'use strict';
// Home → "Right now" (web/js/rightnow.js): which parts the panel has, in which order, and what each says.
// (The page itself isn't here: the script runs against a stand-in for the app's own helpers.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'rightnow.js'), 'utf8');
const NOW = Date.now();
const ids = (ps) => Array.from(ps, (p) => p.id); // (arrays from the script's own world: copied to compare)
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** The app as the panel sees it. over: what differs from an ordinary household. */
function app(over = {}) {
  const items = {
    show1: { k: 'show1', t: 'show', n: 'Copper Creek' },
    ep1: { k: 'ep1', t: 'episode', n: 'Copper Creek S02E02 Open Road', sk: 'show1', s: 2, e: 2, et: 'Open Road' },
    film: { k: 'film', t: 'movie', n: 'Lumen', y: 2026 },
    ch1: { k: 'ch1', t: 'live', n: 'Nova News 24', g: 'News', i: '/n24.png' },
    ch2: { k: 'ch2', t: 'live', n: 'Planet Wild', g: 'Documentary' },
    ch3: { k: 'ch3', t: 'live', n: 'Goal TV', g: 'Sports' },
    ch4: { k: 'ch4', t: 'live', n: 'Racing Live', g: 'Sports' },
    ...(over.items || {}),
  };
  const guide = { ch1: { t: 'Evening News', s: NOW - 20 * 60e3, e: NOW + 14 * 60e3 }, ch3: { t: 'Goals of the Week', s: NOW - 60e3, e: NOW + 90 * 60e3 }, ...(over.guide || {}) };
  const off = over.off || {};
  const S = {
    profile: { id: 'me', name: 'Alex', ...(over.profile || {}) },
    settings: { off, ...(over.settings || {}) },
    live: ['ch1', 'ch2', 'ch3', 'ch4'].map((k) => items[k]).filter(Boolean).slice(0, over.channels == null ? 4 : over.channels),
    data: { home: { hidden: over.hidden || [] }, favs: over.favs || [], reminders: over.reminders || [], history: [] },
  };
  const V = {
    areaOff: (a) => off[a] === true,
    ls: { get: (k, d) => d, set() {} },
    api: async () => ({}),
    entry: (k) => items[k] || null,
    showOf: (it) => items[it.sk] || null,
    epLabel: (it) => (it && it.s != null ? `S${it.s}:E${it.e}` : ''),
    epg: { nowNext: (c) => ({ now: guide[c.k] || null, next: null }) },
    recentChannels: () => (over.recent || []).map((k) => items[k]),
    avatar: () => '<span class="avatar"></span>',
    icon: (n) => `<svg data-i="${n}"></svg>`,
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    fmtDay: (ms) => (ms - NOW < 20 * 3600e3 ? 'Today' : 'Tomorrow'),
    fmtClock: () => '8:00 PM',
    fmtLeft: (sec) => Math.max(1, Math.round(sec / 60)) + ' min left',
    on: () => () => {}, debounce: (fn) => fn,
  };
  const ctx = { V, S, Date, Math, Promise, document: {}, setInterval() {}, clearInterval() {} };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { V, S, parts: (soc) => V.rightNow._parts({ profiles: [{ id: 'me', name: 'Alex' }, { id: 'sam', name: 'Sam' }, { id: 'jo', name: 'Jordan' }], presence: [], conversations: [], parties: [], ...soc }) };
}

test('plain ES5, like the rest of the browser code', () => {
  assert.ok(!/=>|\blet\b|\bconst\b|`/.test(SRC.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
});

test('a busy household: who is watching, the party, the message, the reminder, then two channels', () => {
  const a = app({ favs: ['ch1'], reminders: [{ k: 'ch3', s: NOW + 40 * 60e3, e: NOW + 100 * 60e3, t: 'Fight Night' }, { k: 'ch4', s: NOW + 5 * 3600e3, e: NOW + 6 * 3600e3, t: 'The Pundits' }] });
  const ps = a.parts({
    // (An episode of a series this device never opened: only the series is known here, the server says which episode.)
    presence: [{ pid: 'sam', k: 'ep-unknown', n: 'Copper Creek S02E03 Bridges', sk: 'show1', s: 2, e: 3, et: 'Bridges', tv: true }, { pid: 'sam', k: 'film', n: 'Lumen' }],
    parties: [{ id: 'p1', host: 'jo', n: 'Lumen', members: ['jo'] }, { id: 'p2', host: 'me', n: 'Mine', members: ['me'] }],
    conversations: [{ id: 'jo', unread: 2, last: { from: 'jo', text: 'Starting at 8' } }, { id: 'sam', unread: 0, last: { from: 'sam', text: 'old' } }],
  });
  assert.deepStrictEqual(ids(ps), ['who', 'party', 'msg', 'rem', 'now']);
  const who = ps[0];
  assert.match(text(who.html), /Sam is watching Copper Creek S2:E3 · Bridges · on the TV/);
  assert.match(who.html, /data-rn-play="ep-unknown" data-rn-sk="show1"/, 'enough to fetch the series’ episodes and play it');
  assert.strictEqual((who.html.match(/is watching/g) || []).length, 1, 'one line a person, even with two screens on');
  assert.strictEqual(who.sum, 'Sam is watching');
  assert.match(text(ps[1].html), /Jordan started a watch party Lumen Join/);
  assert.match(ps[1].html, /data-rn-party="p1"/);
  assert.match(text(ps[2].html), /2 new messages Jordan: Starting at 8 Reply/);
  assert.match(ps[2].html, /href="#\/messages\/jo"/);
  assert.match(text(ps[3].html), /Fight Night starts in 40 min Goal TV · 1 more later/);
  assert.strictEqual(ps[3].sum, '2 reminders');
  const now = text(ps[4].html);
  assert.match(now, /Evening News Nova News 24 14 min left/, 'the favourite first, with what’s on and how long is left');
  assert.strictEqual((ps[4].html.match(/rn-ch/g) || []).length, 2, 'two channels when there’s more to say');
});

test('a quiet moment: just three channels; a reminder that has started offers Watch', () => {
  const quiet = app().parts({});
  assert.deepStrictEqual(ids(quiet), ['now']);
  assert.strictEqual((quiet[0].html.match(/rn-ch/g) || []).length, 3);
  assert.match(text(quiet[0].html), /^On now Guide Evening News Nova News 24/, 'channels with a guide come first');

  const started = app({ reminders: [{ k: 'ch3', s: NOW - 5 * 60e3, e: NOW + 55 * 60e3, t: 'Fight Night' }] }).parts({});
  assert.match(text(started[0].html), /Fight Night is on now Goal TV Watch/);
  assert.match(started[0].html, /data-rn-play="ch3"/);
  const over = app({ reminders: [{ k: 'ch3', s: NOW - 3 * 3600e3, e: NOW - 2 * 3600e3, t: 'Old' }, { k: 'gone', s: NOW + 60e3, e: NOW + 3600e3, t: 'A channel that left the list' }] }).parts({});
  assert.deepStrictEqual(ids(over), ['now'], 'finished programmes and channels that are gone aren’t reminders any more');
  assert.strictEqual(app({ channels: 0 }).parts({}).length, 0, 'no live TV and nothing happening: no panel');
});

test('what stays out: messages when they’re switched off, parties when they are, your own message, and everything social for a guest', () => {
  const soc = { presence: [{ pid: 'sam', k: 'film', n: 'Lumen' }], parties: [{ id: 'p1', host: 'jo', n: 'Lumen', members: ['jo'] }], conversations: [{ id: 'jo', unread: 1, last: { from: 'jo', text: 'hi', item: null } }] };
  assert.deepStrictEqual(ids(app().parts(soc)), ['who', 'party', 'msg', 'now']);
  assert.match(text(app().parts(soc)[2].html), /New message from Jordan hi Reply/);
  assert.deepStrictEqual(ids(app({ off: { messages: true } }).parts(soc)), ['who', 'party', 'now']);
  assert.deepStrictEqual(ids(app({ settings: { allowParties: false } }).parts(soc)), ['who', 'msg', 'now']);
  assert.deepStrictEqual(ids(app({ profile: { guest: true } }).parts(soc)), ['now']);
  assert.deepStrictEqual(ids(app().parts({ conversations: [{ id: 'jo', unread: 0, last: { from: 'me', text: 'sent' } }] })), ['now']);
  // Something being watched that this profile can't see at all isn't named (the server leaves it out; a stale one here too).
  assert.deepStrictEqual(ids(app().parts({ presence: [{ pid: 'sam', k: 'not-in-my-catalogue', n: 'Hidden' }] })), ['now']);
  // Text from other people is never markup.
  const html = app().parts({ conversations: [{ id: 'jo', unread: 1, last: { from: 'jo', text: '<img src=x onerror=alert(1)>' } }] })[0].html;
  assert.ok(!/<img src=x/.test(html) && /&lt;img/.test(html));
});

test('the panel is asked for only where it’s wanted: not when the admin or the profile switched it off', () => {
  assert.match(app().V.rightNow.html(false), /^<aside class="rn" aria-label="Right now" hidden><\/aside>$/);
  assert.match(app().V.rightNow.html(true), /class="rn rn-solo"/);
  assert.strictEqual(app({ off: { rightnow: true } }).V.rightNow.html(false), '');
  assert.strictEqual(app({ hidden: ['rightnow'] }).V.rightNow.html(false), '');
});
