'use strict';
/**
 * Event / pay-per-view channels: providers put the event and its start time in the channel's name, and give no guide.
 *
 *   "USA | PPV 03: UFC 310: Pantoja vs Asakura (Sat 7 Dec 22:00 ET)"  → PPV 03 (USA), "UFC 310: Pantoja vs Asakura", Sat 7 Dec 22:00 New York time
 *   "NFL 05 | Bills vs Chiefs @ 8:20 PM ET"                           → NFL 05, "Bills vs Chiefs", the next 20:20 New York time
 *   "EVENT 12 - 2026-11-02 19:45 Arsenal v Chelsea"                   → EVENT 12, "Arsenal v Chelsea", 2 Nov 2026 19:45 (the list's time zone)
 *   "ESPN+ 14: NCAAF | Texas vs Michigan 11/02 3:30PM EST"            → ESPN+ 14, "Texas vs Michigan" (NCAAF), 2 Nov 15:30 New York time
 *   "DAZN 4 - NO EVENT STREAMING"                                    → DAZN 4, no event right now
 *
 * parseEventName() reads one name; EventGuide turns the parsed channels into guide listings (3 hours long, or until
 * the next event on that channel), linked to the channel like any guide (see lib/epg.js `setVirtual`).
 * Times without a zone use the list's own time zone (Xtream Codes `server_info.timezone`), then the server's.
 */

const DEFAULT_LEN = 3 * 3600e3;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
// Zones as providers write them. US and central-European abbreviations mean "the time on the clocks there" (providers
// write EST all year), so they follow daylight saving; GMT, UTC and BST are fixed; UK means London time.
const ZONES = {
  ET: 'America/New_York', EST: 'America/New_York', EDT: 'America/New_York', EASTERN: 'America/New_York',
  CT: 'America/Chicago', CST: 'America/Chicago', CDT: 'America/Chicago', CENTRAL: 'America/Chicago',
  MT: 'America/Denver', MST: 'America/Denver', MDT: 'America/Denver',
  PT: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles', PACIFIC: 'America/Los_Angeles',
  UK: 'Europe/London', CET: 'Europe/Paris', CEST: 'Europe/Paris', WET: 'Europe/Lisbon', WEST: 'Europe/Lisbon', EET: 'Europe/Athens', EEST: 'Europe/Athens',
  AEST: 'Australia/Sydney', AEDT: 'Australia/Sydney',
  GMT: 0, UTC: 0, Z: 0, BST: 60,
};
const ZONE_WORDS = Object.keys(ZONES).filter((z) => z !== 'Z').sort((a, b) => b.length - a.length).join('|');

// Words that make a numbered channel an event channel even with nothing else in its name.
const EVENTISH = /\b(?:ppv|pay[- ]?per[- ]?view|events?|live ?events?|match ?(?:day|centre|center)?|game ?(?:day|pass)?|fight ?(?:night|pass)?|extra|pass|box ?office|ticket|sunday ticket|league ?pass|center ?ice|extra ?innings|espn\+|dazn|flo ?\w*|peacock|paramount\+?|prime|fubo|nfl|nba|nhl|mlb|mls|wnba|ncaa[fb]?|ufc|wwe|aew|pfl|bkfc|boxing|f1|motogp|nascar|indycar|epl|efl|ucl|uel|uecl|liga|serie a|bundesliga|ligue|tsn\+?|sn ?now|b1g\+?|sec\+?|acc ?(?:n|network)?x?|big ?ten|stan|optus|kayo|viaplay|ziggo|sky ?go|now ?tv|bein|setanta|canal\+|movistar|eleven|arena|sport ?tv|sports?|soccer|football|hockey|baseball|basketball|tennis|golf|cricket|rugby|darts|snooker|racing|motorsport)\b/i;
const NO_EVENT = /\b(?:no (?:live )?(?:events?|games?|matche?s?|fights?|streams?)(?: (?:on|now|right now|today|tonight|streaming|scheduled|currently|at the moment|available|live))*|nothing (?:on|scheduled|streaming)|off[ -]?air|(?:stream |channel )?offline|stand ?by|waiting for (?:the )?(?:next )?event|currently empty|no programming)\b/i;
const ENDED = /^(?:end(?:ed)?|finished|over|full ?time|ft|replay)$/i;
const LIVE_WORD = /^(?:live(?: now)?|on air|now|in progress|🔴)$/i;
const NEXT_WORD = /^(?:next|soon|upcoming|coming up|later)$/i;
const FILLER = /^(?:hd|fhd|uhd|sd|4k|8k|\d+k exclusive|exclusive|all|vip|backup|multi|raw|60fps|50fps|eng|english|en|us|usa|uk|ca|tba|tbd|tbc|starts?|start time|kick[- ]?off|ko|from|at|on|time)$/i;
const SPORTY = /\b(?:vs?\.?|versus|@|at)\b|\b(?:ppv|ufc|wwe|aew|pfl|boxing|fight|bout|nfl|nba|nhl|mlb|mls|wnba|ncaa[fb]?|college|football|soccer|hockey|baseball|basketball|tennis|golf|cricket|rugby|darts|snooker|racing|grand prix|f1|formula|motogp|nascar|indycar|premier league|champions league|europa|la ?liga|serie a|bundesliga|ligue 1|cup|derby|final|playoffs?|match|game ?\d|round|qualifying|race|tour|open|championship|olympic)\b/i;

/** The local clock (year, month, day, hours, minutes, weekday) somewhere at time t. zone: IANA name or fixed minutes. */
const fmtCache = new Map();
function partsAt(t, zone) {
  if (typeof zone === 'number') {
    const d = new Date(t + zone * 60e3);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: d.getUTCDay() };
  }
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
    fmtCache.set(zone, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(t))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: WEEKDAYS[String(o.weekday).slice(0, 3).toLowerCase()] };
}
/** Minutes a zone is ahead of UTC at time t. */
function offsetAt(t, zone) {
  if (typeof zone === 'number') return zone;
  const p = partsAt(t, zone);
  return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s || 0) - Math.floor(t / 1000) * 1000) / 60e3);
}
/** The moment a local clock time happens in a zone. */
function zonedTime(y, mo, d, h, mi, zone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const o1 = offsetAt(guess, zone);
  let t = guess - o1 * 60e3;
  const o2 = offsetAt(t, zone);
  if (o2 !== o1) t = guess - o2 * 60e3;
  return t;
}
/** A usable zone: an IANA name the system knows, fixed minutes, or null. */
function checkZone(z) {
  if (typeof z === 'number' && Number.isFinite(z)) return z;
  if (!z || typeof z !== 'string') return null;
  if (/^utc$|^gmt$|^z$/i.test(z)) return 0;
  const m = /^(?:utc|gmt)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(z.trim());
  if (m) return (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +(m[3] || 0));
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch { return null; }
}
const serverZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 0; } catch { return 0; } })();
const american = (z) => typeof z === 'string' && /^America\//.test(z);

// ------------------------------------------------------------------ date and time pieces
// Each finder returns { i, len, ...fields } for the first match in s (or null). They're tried on what's left after
// earlier pieces are cut out, so "2026-11-02 19:45" doesn't also read as a time "02 19".
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?(?![a-z])';
const ZONE_AT = new RegExp(`^\\s*[(\\[]?\\s*(?:(GMT|UTC)\\s*([+-])\\s*(\\d{1,2})(?::?(\\d{2}))?|([+-])(\\d{2}):?(\\d{2})|(Z)|(${ZONE_WORDS})(?:\\s*time)?)(?![\\w])\\s*[)\\]]?`);
const RX = {
  // 2026-11-02, 2026/11/02, 2026.11.02, 20261102 (with T or a space before an optional time)
  iso: /(?<![\d:])(20\d{2})([-/.])(\d{1,2})\2(\d{1,2})(?!\d)|(?<!\d)(20\d{2})(\d{2})(\d{2})(?=T\d|\s|$)/,
  // 02/11/2026, 11/02/26, 02.11.2026, 02-11-2026, 11/02, 02.11 (two-part dots only next to a time)
  dmy: /(?<![\d:.,])(\d{1,2})([/.-])(\d{1,2})(?:\2(\d{4}|\d{2}))?(?![\d:]|\.\d)/,
  // 7 Dec, 7th December 2026, 07-Dec-2026, Dec 7, December 7th, 2026, Dec. 7
  dMon: new RegExp(`(?<![\\w])(\\d{1,2})(?:st|nd|rd|th)?[\\s-]*${MON}(?:[\\s-]*(20\\d{2}|\\d{2}(?![\\d:])))?`, 'i'),
  monD: new RegExp(`(?<![\\w])${MON}\\s*(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])(?:,?\\s*(20\\d{2}))?`, 'i'),
  wday: /(?<![\w])(mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)(?:day|nesday|urday)?\.?(?![\w])/i,
  rel: /(?<![\w])(today|tonight|tomorrow|tmrw|tmw)(?![\w])/i,
  // 7:30pm, 8:20 PM, 7pm, 7 p.m., 19:45, 20h45, 19:45:00, T19:45 — and only then 19.45
  time: /(?<![\d.:/])T?(\d{1,2})(?:([:.h])(\d{2})(?::\d{2})?)?\s*([ap])\.?\s*m\.?(?![\w])|(?<![\d.:/])T?(\d{1,2})([:h])(\d{2})(?::\d{2})?(?!\d)/i,
  timeDot: /(?<![\d.:/\w])(\d{1,2})\.(\d{2})(?![\d.])/,
  // A zone on its own: "(UK)", "(ET)", "UK time", "ET" — capitals only, so "et" in a title stays.
  zone: new RegExp(`[(\\[]\\s*(${ZONE_WORDS})\\s*[)\\]]|(?<![\\w])(${ZONE_WORDS})(?:\\s+time)?(?![\\w])`),
};
function take(s, re) {
  const m = re.exec(s);
  if (!m) return null;
  return { m, s: s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length) };
}

/**
 * Pulls the date, time and time zone out of an event name. Returns { rest, y, mo, d, dmy: [a, b], wd, rel, h, mi, zone }.
 */
function datePieces(s) {
  const out = {};
  let r;
  if ((r = take(s, RX.iso))) { const m = r.m; out.y = +(m[1] || m[5]); out.mo = +(m[3] || m[6]); out.d = +(m[4] || m[7]); s = r.s; }
  if (!out.mo && (r = take(s, RX.dMon))) { const m = r.m; out.d = +m[1]; out.mo = MONTHS[m[2].toLowerCase().slice(0, 3)]; if (m[3]) out.y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; s = r.s; }
  if (!out.mo && (r = take(s, RX.monD))) { const m = r.m; out.mo = MONTHS[m[1].toLowerCase().slice(0, 3)]; out.d = +m[2]; if (m[3]) out.y = +m[3]; s = r.s; }
  let tr = take(s, RX.time), dot = false;
  if (!tr) { tr = take(s, RX.timeDot); dot = true; }
  if (tr) {
    const m = tr.m;
    let h, mi;
    if (dot) { h = +m[1]; mi = +m[2]; } else if (m[4] !== undefined) { h = +m[1]; mi = +(m[3] || 0); const pm = /p/i.test(m[4]); if (h > 12) h = 99; else if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; } else { h = +m[5]; mi = +m[7]; }
    if (h <= 23 && mi <= 59) {
      out.h = h; out.mi = mi;
      // A zone straight after the time: "8:20 PM ET", "19:45 (UK)", "20:00 GMT+1", "19:45+01:00", "T19:45Z".
      const after = s.slice(m.index + m[0].length);
      const z = ZONE_AT.exec(after);
      s = s.slice(0, m.index) + ' ' + (z ? after.slice(z[0].length) : after);
      if (z) {
        if (z[1]) out.zone = (z[2] === '-' ? -1 : 1) * (+z[3] * 60 + +(z[4] || 0));
        else if (z[5]) out.zone = (z[5] === '-' ? -1 : 1) * (+z[6] * 60 + +z[7]);
        else if (z[8]) out.zone = 0;
        else { out.zone = ZONES[z[9].toUpperCase()]; out.zoneWord = z[9]; }
      }
    }
  }
  if (out.zone === undefined && (r = take(s, RX.zone))) { const w = r.m[1] || r.m[2]; out.zone = ZONES[w.toUpperCase()]; out.zoneWord = w; s = r.s; }
  // d/m or m/d (after the time is out of the way, so "19.45" stays a time)
  if (!out.mo && (r = take(s, RX.dmy))) {
    const m = r.m;
    const a = +m[1], b = +m[3];
    // "1.5" or "2-1" alone isn't a date: dots need a year or a time, dashes a year.
    const ok = m[2] === '/' || m[4] || (m[2] === '.' && out.h !== undefined);
    if (ok && a >= 1 && b >= 1 && a <= 31 && b <= 31 && (a <= 12 || b <= 12)) {
      out.dmy = [a, b];
      if (m[4]) out.y = m[4].length === 2 ? 2000 + +m[4] : +m[4];
      s = r.s;
    }
  }
  if ((r = take(s, RX.wday))) { out.wd = WEEKDAYS[r.m[1].toLowerCase().slice(0, 3)]; s = r.s; }
  if ((r = take(s, RX.rel))) { out.rel = /^tom|^tm/i.test(r.m[1]) ? 1 : 0; s = r.s; }
  out.rest = s;
  return out;
}

/**
 * When the event starts, from the pieces: a full date, a date without a year (the nearest such date), a weekday (the
 * next one) or just a time (the next one). Something that started less than `len` ago counts as on now, not next week.
 */
function resolveStart(p, zone, now, len = DEFAULT_LEN) {
  if (p.h === undefined) return null;
  const z = p.zone !== undefined ? p.zone : zone;
  const loc = partsAt(now, z);
  let y = p.y, mo = p.mo, d = p.d;
  if (!mo && p.dmy) {
    const [a, b] = p.dmy;
    // Which is the month? The one that can't be a day decides; otherwise US zones write month first, others day first.
    const mFirst = b > 12 ? true : a > 12 ? false : (american(z) || (typeof p.zoneWord === 'string' && /^(E|C|M|P)(S|D)?T$/i.test(p.zoneWord)));
    mo = mFirst ? a : b; d = mFirst ? b : a;
  }
  if (mo) {
    if (!y) {
      // The year that puts the date nearest to today.
      let best = null;
      for (const yy of [loc.y - 1, loc.y, loc.y + 1]) {
        const t = zonedTime(yy, mo, d, p.h, p.mi, z);
        if (!best || Math.abs(t - now) < Math.abs(best - now)) best = t;
      }
      return best;
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return zonedTime(y, mo, d, p.h, p.mi, z);
  }
  // Today's date there, moved on by days until it fits.
  const at = (plus) => { const base = new Date(Date.UTC(loc.y, loc.mo - 1, loc.d + plus)); return zonedTime(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), p.h, p.mi, z); };
  if (p.wd !== undefined) {
    let plus = (p.wd - loc.wd + 7) % 7;
    if (plus === 0 && at(0) + len <= now) plus = 7;
    return at(plus);
  }
  if (p.rel === 1) return at(1);
  const t0 = at(0);
  if (p.rel === 0) return t0;
  return t0 + len > now ? t0 : at(1);
}

// ------------------------------------------------------------------ the channel part of the name
const TAG = /^\s*\|?\s*([A-Z]{2,4})\s*(?:\||:(?!\d))\s*(?=\S)/;
// "PPV 03", "NFL 05", "EVENT 12", "ESPN+ 14", "DAZN 4", "NBA LEAGUE PASS 07", "Sky Sports Box Office 2", "PPV-3", "PPV#3"
const CHAN = /^((?:[A-Za-z][\w+&!'’.]*\s+){0,4}?[A-Za-z][\w+&!'’.]*?\s*[#-]?\s*\d{1,3}[A-Za-z]?)(?:\s+(?:HD|FHD|UHD|4K|SD))?(?:\s*\|\s*|\s*:(?!\d{2})\s*|\s+[-–—~]+\s*|\s*$|\s+(?=[([]))/;
// …or at the end: "Chelsea vs. Man Utd | 20:00 (GMT) | US: SOCCER PPV 1", "Arsenal v Chelsea (EVENT 12)"
const CHAN_END = /(?:^|[|([]|\s[-–—]\s)\s*(?:([A-Z]{2,4}):\s*)?((?:[A-Za-z][\w+&!'’.]*\s+){0,3}?(?:ppv|events?|match|game|fight)\s*[#-]?\s*\d{1,3})\s*[)\]]?\s*$/i;
// Numbered channels that only ever carry events (a name like "PPV 03 | HD" with nothing else means nothing's on).
const STRONG = /\b(?:ppv|pay[- ]?per[- ]?view|events?|live ?events?|box ?office|match(?: ?(?:centre|center|day))?|game(?: ?(?:day|pass))?|fight(?: ?pass)?|extra|league ?pass|sunday ticket|ticket|espn\+|flo ?\w*|peacock|paramount\+|fubo|tsn\+|sn ?now|b1g\+|sec\+|acc ?n?x|kayo|nfl|nba|nhl|mlb|mls|wnba|ncaa[fb]?|ufc|wwe|aew|epl|f1 ?tv)\s*[#-]?\s*\d{1,3}[a-z]?$/i;
const VS = /\s(?:vs?\.?|versus|@)\s/i;
const none = (chan, tag) => ({ chan, tag, title: '', comp: '', start: null, none: true, live: false, ended: false, timed: false, zone: null });

/**
 * Reads an event channel's name. Returns null for an ordinary channel, otherwise
 * { chan, tag, title, comp, start (ms or null), none, live, ended, timed (a time was given), zone }.
 * opts: { tz (the list's time zone), now }
 */
function parseEventName(raw, opts = {}) {
  let s = String(raw || '').normalize('NFC').replace(/[ -​ ]/g, ' ').replace(/[★☆●◉•▶►⚽🏈🏀⚾🏒🥊🏎🔴🟢]+/gu, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!s || s.length > 300) return null;
  let tag = '';
  // A country tag ("USA | ", "UK: "): letters only, straight before its bar or colon ("NFL 05 | …" isn't one).
  const tm = TAG.exec(s);
  if (tm) { tag = tm[1]; s = s.slice(tm[0].length); }
  let chan = '', rest = '';
  const cm = CHAN.exec(s);
  if (cm && /[A-Za-z]/.test(cm[1]) && !VS.test(' ' + cm[1] + ' ') && !/\sat\s/i.test(' ' + cm[1] + ' ')
    // "Live 19:45" / "Sat 22:00" / "Dec 7": a time or a date, not a channel.
    && !/^(?:live|today|tonight|tomorrow|(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?)\s*\d/i.test(cm[1])) {
    chan = cm[1].trim(); rest = s.slice(cm[0].length).trim();
  }
  if (!chan) {
    const ce = CHAN_END.exec(s);
    if (ce) { chan = ce[2].trim(); if (ce[1] && !tag) tag = ce[1]; rest = s.slice(0, ce.index).trim(); }
    else if (tag && STRONG.test(tag + ' 1')) { chan = tag; tag = ''; rest = s; } // "NBA | Lakers vs Celtics 7:30PM ET"
    else return null;
  }
  chan = chan.replace(/\s*[#-]\s*(?=\d)/, ' ').replace(/\s{2,}/g, ' ');
  const strong = STRONG.test(chan);
  const eventish = strong || EVENTISH.test(chan) || (tag && EVENTISH.test(tag));
  // "DAZN 4 - NO EVENT STREAMING", "PPV 2 | Off air"
  if (NO_EVENT.test(rest)) {
    const left = rest.replace(NO_EVENT, ' ');
    if (!VS.test(' ' + left + ' ')) return none(chan, tag);
  }
  if (!rest) return strong ? none(chan, tag) : null;
  const p = datePieces(rest.replace(/@\s*(?=\d{1,2}(?:[:.h]\d{2}|\s*[ap]\.?m))/gi, ' ').replace(/\b(?:starts?|start time|kick[- ]?off|ko|from|at)\s*:?\s*(?=\d{1,2}(?:[:.h]\d{2}|\s*[ap]\.?m))/gi, ' '));
  let live = false, ended = false;
  // What's left is the event (and maybe its competition), in segments.
  const segs = p.rest.split(/\s*\|\s*|\s+[-–—~]{1,2}\s+|\s*[()[\]{}]\s*/).map((x) => x.replace(/^[\s,:;.\-–—/]+|[\s,:;\-–—/@]+$/g, '').trim()).filter(Boolean);
  const keep = [];
  for (const x of segs) {
    if (LIVE_WORD.test(x)) { live = true; continue; }
    if (ENDED.test(x)) { ended = true; continue; }
    if (NEXT_WORD.test(x) || FILLER.test(x) || /^[\d\s:./-]+$/.test(x)) continue;
    let y = x.replace(/^(?:live|on now)\s*[:\-–]?\s+/i, () => { live = true; return ''; }).replace(/\s+(?:live|hd|fhd|uhd|4k)$/i, '').trim();
    y = y.replace(/\s+(?:on|at)$/i, '').trim();
    if (y && !FILLER.test(y)) keep.push(y);
  }
  const timed = p.h !== undefined;
  const dated = !!(p.mo || p.dmy);
  if (!keep.length) {
    // Only a time: still an event channel when it's named like one (the guide then shows the channel's name).
    if (timed && eventish) return { chan, tag, title: '', comp: '', start: resolveStart(p, zoneOf(p, opts), opts.now || Date.now()), none: false, live, ended, timed, zone: p.zone !== undefined ? p.zone : null };
    return strong ? none(chan, tag) : null;
  }
  // A short first segment in front of the match is its competition ("NCAAF | Texas vs Michigan").
  let comp = '';
  const vsAt = keep.findIndex((x) => VS.test(' ' + x + ' ') || /\s(?:at|x)\s/i.test(' ' + x + ' '));
  if (keep.length > 1 && vsAt > 0 && keep[0].split(/\s+/).length <= 4 && !VS.test(' ' + keep[0] + ' ')) comp = keep.shift();
  let title = keep.join(' · ').replace(/\s{2,}/g, ' ').trim();
  if (title.length > 160) title = title.slice(0, 160).trim() + '…';
  // A real event channel says so: its name, "A vs B", or a time on a sports-looking channel. ("Fox Sports 1 - East" isn't one.)
  if (!(strong || VS.test(' ' + title + ' ') || ((timed || dated) && eventish))) return null;
  const start = timed ? resolveStart(p, zoneOf(p, opts), opts.now || Date.now()) : null;
  return { chan, tag, title, comp, start, none: false, live, ended, timed, zone: p.zone !== undefined ? p.zone : null };
}
function zoneOf(p, opts) {
  if (p.zone !== undefined) return p.zone;
  const z = checkZone(opts.tz);
  return z !== null ? z : serverZone;
}

/** Is this a sport event (for guide categories)? */
const isSporty = (ev, chan) => SPORTY.test(`${ev.comp || ''} ${ev.title || ''}`) || EVENTISH.test(chan || '');

/** A quick test before the full parse: could this channel name carry an event? */
const MAYBE = /\d{1,2}[:.h]\d{2}|\d\s*[ap]\.?m\b|\b(?:ppv|events?|no event|vs?\.?|@)\b|\d{1,2}[/.-]\d{1,2}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d/i;
const maybeEvent = (name) => MAYBE.test(String(name || ''));

// ------------------------------------------------------------------ guide listings for event channels
/**
 * Turns event channels into guide listings: each channel key gets programmes { s, e, t, c, d } under the guide id
 * "ev:<key>". Events seen earlier on the same channel are remembered (until they're over), so one runs until the
 * next one starts when that's sooner than the default length.
 */
class EventGuide {
  constructor({ len = DEFAULT_LEN } = {}) {
    this.len = len;
    this.past = new Map(); // channel key → [{ s, t, comp }] seen in earlier names
    this.map = new Map(); // "ev:<key>" → programmes
    this.info = new Map(); // channel key → parsed event
    this.version = 0;
  }

  /** channels: [{ k, n (the provider's name), tz }]. Returns true when the listings changed. */
  update(channels, now = Date.now()) {
    const map = new Map();
    const info = new Map();
    for (const ch of channels) {
      const ev = parseEventName(ch.n, { tz: ch.tz, now });
      if (!ev) continue;
      info.set(ch.k, ev);
      const seen = (this.past.get(ch.k) || []).filter((x) => x.s + this.len > now - 12 * 3600e3);
      if (ev.start && ev.title && !seen.some((x) => x.s === ev.start && x.t === ev.title)) seen.push({ s: ev.start, t: ev.title, comp: ev.comp, sport: isSporty(ev, ev.chan) });
      seen.sort((a, b) => a.s - b.s);
      // The same start, another name (a corrected title): the newest wins.
      const uniq = [];
      for (const x of seen) { if (uniq.length && uniq[uniq.length - 1].s === x.s) uniq[uniq.length - 1] = x; else uniq.push(x); }
      // Only events this name still points at, or ones before it: a name that moved on drops the old future ones.
      const cut = ev.start || (ev.none ? now : Infinity);
      const list = uniq.filter((x) => x.s <= cut || (ev.start && x.s === ev.start));
      if (list.length) this.past.set(ch.k, list.slice(-4)); else this.past.delete(ch.k);
      if (!list.length) continue;
      const progs = list.map((x, i) => {
        const next = list[i + 1];
        let e = x.s + this.len;
        if (next && next.s < e) e = next.s;
        if (ev.none && x.s < now && e > now) e = Math.max(x.s + 60e3, now); // the name says nothing's on any more
        const o = { s: x.s, e, t: x.t, c: x.sport ? ['Sports', 'Event'] : ['Event'] };
        if (x.comp) { o.st = x.comp; o.c.splice(1, 0, x.comp); }
        return o;
      }).filter((x) => x.e > now - 6 * 3600e3);
      if (progs.length) map.set('ev:' + ch.k, progs);
    }
    for (const k of [...this.past.keys()]) if (!info.has(k)) this.past.delete(k);
    const sig = JSON.stringify([...map]);
    const changed = sig !== this._sig;
    this._sig = sig;
    this.map = map;
    this.info = info;
    if (changed) this.version++;
    return changed;
  }
}

module.exports = { parseEventName, resolveStart, datePieces, zonedTime, checkZone, maybeEvent, isSporty, EventGuide, DEFAULT_LEN };
