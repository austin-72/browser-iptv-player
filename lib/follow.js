'use strict';
/**
 * Following teams and competitions: what's in the guide (and on event channels) is indexed once per guide update,
 * so a profile's "Events" are a few Set lookups.
 *
 *   teamsOf("Live: Arsenal v Chelsea")           → ["Arsenal", "Chelsea"]
 *   teamsOf("Chiefs @ Bills")                     → ["Chiefs", "Bills"]
 *   teamsOf("UFC 310: Pantoja vs Asakura")        → ["Pantoja", "Asakura"]
 *   compOf({ t: "Live: Formula 1 Grand Prix" })   → "Formula 1"
 *
 * Names are compared loosely: accents, "FC", "&"/"and" and punctuation don't matter, short forms come from
 * lib/sports-names.json ("Man Utd" = "Manchester United"), a nickname matches the full name ("Chiefs" = "Kansas City
 * Chiefs") and small typos are forgiven ("Arsnal").
 */
const NAMES = require('./sports-names.json');

const DROP = new Set(['fc', 'afc', 'cf', 'sc', 'fk', 'sk', 'the', 'hd', 'club', 'ud', 'cd']);
/** "Brighton & Hove Albion F.C." → "brighton and hove albion" */
function nk(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/['’.]/g, '')
    .replace(/[^a-z0-9+]+/g, ' ').split(' ').filter((w) => w && !DROP.has(w)).join(' ');
}

// Short forms → the name shown (both as keys).
const TEAM_CANON = new Map();
const TEAM_SHOW = new Map();
for (const g of NAMES.teams) { const c = nk(g[0]); TEAM_SHOW.set(c, g[0]); for (const n of g) TEAM_CANON.set(nk(n), c); }
const COMP_CANON = new Map();
const COMP_SHOW = new Map();
const COMP_RE = [];
for (const g of NAMES.competitions) {
  const c = nk(g[0]);
  COMP_SHOW.set(c, g[0]);
  for (const n of g) COMP_CANON.set(nk(n), c);
  const alt = g.map((n) => nk(n).replace(/[+]/g, '\\+').replace(/ /g, '\\s+')).sort((a, b) => b.length - a.length).join('|');
  COMP_RE.push([c, new RegExp(`(?:^|\\s)(?:${alt})(?:\\s|$)`)]);
}
const teamCanon = (k) => TEAM_CANON.get(k) || k;
const compCanon = (k) => COMP_CANON.get(k) || k;

// Words that don't pick out a team on their own ("United" is half of England).
const GENERIC = new Set(['united', 'city', 'town', 'county', 'rovers', 'athletic', 'wanderers', 'albion', 'real', 'sporting', 'fc', 'club', 'state', 'university', 'college', 'saint', 'st', 'new', 'north', 'south', 'east', 'west', 'women', 'men', 'u21', 'u23', 'u19', 'u18', 'b', 'ii', 'reserves', 'academy', 'olympic', 'olympique', 'dynamo', 'inter', 'racing', 'sport', 'sports']);

/** Small typos: Damerau-Levenshtein distance, giving up past `max`. */
function dist(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[b.length];
}
const typoOk = (a, b) => { const n = Math.min(a.length, b.length); const max = n >= 9 ? 2 : n >= 5 ? 1 : 0; return max > 0 && dist(a, b, max) <= max; };

/** Does a followed team (key) mean this team in a listing (key)? */
function sameTeam(f, t) {
  if (!f || !t) return false;
  const cf = teamCanon(f), ct = teamCanon(t);
  if (cf === ct || f === t) return true;
  // A nickname is the end of the full name: "chiefs" / "kansas city chiefs", "lakers" / "los angeles lakers".
  const tail = (long, short) => long.length > short.length && long.endsWith(' ' + short) && !GENERIC.has(short) && short.length >= 4;
  for (const [x, y] of [[cf, ct], [ct, cf], [f, t], [t, f]]) if (tail(x, y)) return true;
  return typoOk(cf, ct);
}

/** Does a followed competition (key) mean this game? */
function sameComp(f, game) {
  if (!f) return false;
  const cf = compCanon(f);
  if (game.lg && (compCanon(game.lg) === cf || typoOk(cf, compCanon(game.lg)))) return true;
  // "Six Nations" in "Rugby: Six Nations - England v France"
  return cf.length >= 3 && (' ' + game.hay + ' ').includes(' ' + cf + ' ');
}

const LIVE_PREFIX = /^\s*(?:live|en vivo|en directo|direct|ao vivo)\s*[:\-–|]?\s+/i;
const NOT_A_GAME = /\b(?:highlights?|review|preview|reaction|replay|rewind|classics?|magazine|analysis|build[- ]?up|countdown|pre[- ]?(?:game|match|race|show)|post[- ]?(?:game|match|race)|talk|news|debate|daily|weekly|recap|best of|goals of|extra time|the pundits|phone[- ]?in|studio|documentary|story of)\b/i;
const GAMEY = /\b(?:live|grand prix|race|qualifying|sprint|fight night|ufc \d+|main card|prelims|main event|final|semi[- ]?finals?|quarter[- ]?finals?|round \d+|stage \d+|day \d+|game \d+|practice|derby|test match|playoffs?|bowl)\b/i;

/** The two sides of a match in a programme title, or []. */
function teamsOf(title) {
  let t = String(title || '').replace(LIVE_PREFIX, '').replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  // "Premier League: Arsenal v Chelsea", "UFC 310: Pantoja vs Asakura", "NFL - Chiefs @ Bills"
  const pre = /^([^:|]{2,40}?)\s*(?::|\||\s[-–]\s)\s*(.+\s(?:vs?\.?|versus|@|at|x)\s.+)$/i.exec(t);
  if (pre) t = pre[2];
  let parts = t.split(/\s+(?:vs\.?|v\.?|versus|@)\s+/i);
  if (parts.length !== 2) parts = t.split(/\s+(?:at|x)\s+/i);
  if (parts.length !== 2) return [];
  const side = (x) => x.replace(/\s+[-–|,:].*$/, '').replace(/\s+\d+\s*$/, '').replace(/^\d+\s+/, '').trim();
  const [a, b] = parts.map(side);
  const ok = (x) => x && x.length <= 40 && x.split(/\s+/).length <= 5 && /[a-z]/i.test(x) && !/^(?:the|a|tba|tbd|tbc)$/i.test(x);
  return ok(a) && ok(b) ? [a, b] : [];
}

/** The competition (shown name) for a programme: from the short-forms list, a specific category, or a title prefix. */
function compOf(p) {
  const hay = nk([p.t, p.st || '', ...[].concat(p.c || [])].join(' | '));
  for (const [c, re] of COMP_RE) if (re.test(hay)) return COMP_SHOW.get(c);
  const SPORTWORD = /sport|football|soccer|basketball|baseball|hockey|tennis|golf|racing|motor|boxing|mma|wrestling|cricket|rugby|cycling|darts|snooker|league|cup|championship/i;
  const GENERICCAT = /^(?:sports?|sport event|sports event|live|live sport|football|soccer|other|event|events|sports? - .{0,3})$/i;
  const cat = [].concat(p.c || []).find((c) => SPORTWORD.test(c) && !GENERICCAT.test(c.trim()) && !/^(?:sports?|football|soccer|basketball|baseball|hockey|tennis|golf|cricket|rugby|boxing)$/i.test(c.trim()));
  if (cat) return cat.trim().replace(/^sports?\s*[-:]\s*/i, '');
  if (p.st && p.st.length <= 40 && !/\s(?:vs?\.?|@)\s/i.test(p.st)) return p.st;
  const m = /^([A-Z][\w .'&+]{1,30}?)\s*:\s/.exec(String(p.t || '').replace(LIVE_PREFIX, ''));
  if (m && !/^live$/i.test(m[1]) && !/\d/.test(m[1])) return m[1].trim();
  return '';
}

const SPORT_CAT = /sport|football|soccer|basketball|baseball|hockey|tennis|golf|racing|motor|boxing|mma|ufc|wrestling|cricket|rugby|athletic|nfl|nba|nhl|mlb|ncaa|f1\b|formula|cycling|darts|snooker|olympic/i;
const SPORT_GRP = /sport|espn|ppv|dazn|nfl|nba|nhl|mlb|tsn|bein|fox sports|sky sports|tnt sports|golf|racing|ufc|wwe|goal|event/i;
/** Is this programme sport? (Categories first; with none, a sports channel and a match-like title.) */
function isSport(p, it) {
  const cats = [].concat(p.c || []).join(' | ');
  if (cats) {
    if (/^(?:event)$/i.test(cats)) return false;
    if (SPORT_CAT.test(cats) || /\b(?:league|cup|championship|grand prix|liga|serie a|ligue)\b/i.test(cats)) return true;
    const h = nk(cats);
    return COMP_RE.some(([, re]) => re.test(h));
  }
  return SPORT_GRP.test(`${it.g || ''} ${it.n || ''}`) && (/\s(?:vs?\.?|@|at)\s/i.test(` ${p.t} `) || GAMEY.test(p.t));
}

// The same game on several channels: the same two teams starting within half an hour of each other (listings and
// event channels' names rarely agree to the minute), or the same title at the same quarter hour.
const gameId = (keys, t, s) => (keys ? keys.slice().sort().join('~') + '|' + Math.round(s / 3600e3) : nk(t) + '|' + Math.round(s / 900e3));
function findGame(map, id, s) {
  const g = map.get(id);
  if (g || id.indexOf('~') < 0) return g;
  // (A game at 19:45 and one at 20:10 round to different hours: look at the hour either side too.)
  const [pair, h] = id.split('|');
  for (const d of [-1, 1]) { const o = map.get(pair + '|' + (+h + d)); if (o && Math.abs(o.s - s) <= 30 * 60e3) return o; }
  return null;
}
const HD = /\b(?:HD|FHD|UHD|4K|1080p?|720p)\b/i;

/**
 * The index: games (matches, fights, races…) in the next few days, each with every channel that shows it, plus the
 * teams and competitions seen (for suggestions). Built in slices.
 */
class SportsIndex {
  constructor() {
    this.games = [];
    this.teams = new Map(); // key → { n, c }
    this.comps = new Map();
    this.version = 0;
    this.builtAt = 0;
    this._match = new Map(); // follow key → Set of team keys (for this version)
  }

  /** A generator: yields now and then so the server keeps answering. channels: [{ it, list(from, to) }] */
  *build(channels, now = Date.now(), hours = 72) {
    const games = new Map();
    const teams = new Map(), comps = new Map();
    const shown = new Map(); // team key → { written form → count }
    let n = 0;
    for (const { it, list } of channels) {
      if ((++n & 255) === 0) yield;
      for (const p of list(now - 6 * 3600e3, now + hours * 3600e3)) {
        if (p.e <= now || !p.t) continue;
        if (!isSport(p, it) && !(it.rn && /event/i.test([].concat(p.c || []).join(' ')))) continue;
        if (NOT_A_GAME.test(p.t)) continue;
        const tm = teamsOf(p.t);
        const lg = compOf(p);
        if (tm.length !== 2 && !(lg && (GAMEY.test(p.t) || it.rn))) continue;
        const keys = tm.map((x) => teamCanon(nk(x))).filter(Boolean);
        const id = gameId(keys.length === 2 ? keys : null, p.t, p.s);
        let g = findGame(games, id, p.s);
        if (!g) {
          g = { id, s: p.s, e: p.e, t: p.t, lg: lg || '', tm: keys, ks: [], hay: nk([p.t, p.st || '', ...[].concat(p.c || [])].join(' ')) };
          if (p.st) g.st = p.st;
          games.set(id, g);
          for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const tt = teams.get(k) || { n: '', c: 0 };
            tt.c++;
            teams.set(k, tt);
            const f = shown.get(k) || new Map();
            f.set(tm[i], (f.get(tm[i]) || 0) + 1);
            shown.set(k, f);
          }
          if (lg) { const ck = compCanon(nk(lg)); const cc = comps.get(ck) || { n: COMP_SHOW.get(ck) || lg, c: 0 }; cc.c++; comps.set(ck, cc); }
        }
        if (g.ks.length < 40 && !g.ks.includes(it.k)) g.ks.push(it.k);
        if (p.e > g.e) g.e = p.e;
      }
    }
    // "Bills" and "Buffalo Bills" in the same guide: one team (when the nickname points at only one full name), and
    // the same game on two channels written both ways becomes one game.
    const full = new Map();
    for (const k of teams.keys()) {
      const w = k.split(' ');
      if (w.length < 2) continue;
      const nick = w[w.length - 1];
      if (nick.length < 4 || GENERIC.has(nick) || !teams.has(nick)) continue;
      full.set(nick, full.has(nick) && full.get(nick) !== k ? null : k);
    }
    for (const [nick, k] of full) {
      if (!k) continue;
      const a = teams.get(nick), b = teams.get(k);
      b.c += a.c;
      teams.delete(nick);
      for (const [w, c] of shown.get(nick) || []) { const f = shown.get(k); f.set(w, c * 0.5 + (f.get(w) || 0)); } // (the full name wins)
    }
    if (full.size) {
      const merged = new Map();
      for (const g of games.values()) {
        if (g.tm.length === 2) {
          g.tm = g.tm.map((k) => full.get(k) || k);
          g.id = gameId(g.tm, g.t, g.s);
        }
        const m = findGame(merged, g.id, g.s);
        if (!m) { merged.set(g.id, g); continue; }
        for (const k of g.ks) if (!m.ks.includes(k) && m.ks.length < 40) m.ks.push(k);
        if (g.e > m.e) m.e = g.e;
        if (!m.lg && g.lg) m.lg = g.lg;
        if (g.t.length > m.t.length) m.t = g.t;
        m.hay += ' ' + g.hay;
      }
      games.clear();
      for (const [id, g] of merged) games.set(id, g);
    }
    // Each team's name as shown: the short-forms list's, or the way it's written most often.
    for (const [k, tt] of teams) {
      if (TEAM_SHOW.has(k)) { tt.n = TEAM_SHOW.get(k); continue; }
      let best = '', bn = -1;
      for (const [w, c] of shown.get(k) || []) if (c > bn || (c === bn && w.length > best.length)) { best = w; bn = c; }
      tt.n = best;
    }
    this.games = [...games.values()].sort((a, b) => a.s - b.s);
    this.teams = teams;
    this.comps = comps;
    this.version++;
    this.builtAt = now;
    this._match = new Map();
    return this;
  }

  /** The team keys in the index a followed team means (worked out once per index version). */
  teamKeys(name) {
    const f = nk(name);
    let set = this._match.get(f);
    if (!set) {
      set = new Set();
      for (const k of this.teams.keys()) if (sameTeam(f, k)) set.add(k);
      if (this._match.size >= 5000) this._match.clear(); // (any title can be asked about: don't keep them all)
      this._match.set(f, set);
    }
    return set;
  }

  /**
   * Games involving what a profile follows: [{ g, why }] (live and future, soonest first).
   * follows: { teams: [names], comps: [names] }; teamsOnly: leave out games matched only by competition.
   */
  matching(follows, { now = Date.now(), teamsOnly = false, until = Infinity } = {}) {
    const teamSets = (follows.teams || []).map((n) => [n, this.teamKeys(n)]);
    const compKeys = teamsOnly ? [] : (follows.comps || []).map((n) => [n, nk(n)]);
    const out = [];
    for (const g of this.games) {
      if (g.e <= now || g.s > until) continue;
      let why = '';
      // (Said as they follow it, unless that was a typo or a short form: "Arsnal" shows as the guide's "Arsenal".)
      for (const [n, set] of teamSets) {
        const k = g.tm.find((x) => set.has(x));
        if (!k) continue;
        const f = ' ' + nk(n) + ' ', t = ' ' + k + ' ';
        why = f.includes(t) || t.includes(f) ? n : (this.teams.get(k) || {}).n || n;
        break;
      }
      const byTeam = !!why;
      if (!why) for (const [n, k] of compKeys) if (sameComp(k, g)) { why = n; break; }
      if (why) out.push({ g, why, team: byTeam });
    }
    return out;
  }

  /** Suggestions as someone types: teams and competitions from the guide. [{ n, kind, c }] */
  suggest(q, limit = 12) {
    const nq = nk(q);
    const out = [];
    const score = (key, name) => {
      if (!nq) return 1;
      const nn = nk(name);
      if (nn === nq || key === teamCanon(nq) || key === compCanon(nq)) return 5;
      if (nn.startsWith(nq) || nn.split(' ').some((w) => w.startsWith(nq))) return 4;
      if (nq.length >= 3 && nn.includes(nq)) return 3;
      if (nq.length >= 4 && (sameTeam(nq, key) || nn.split(' ').some((w) => w.length >= 4 && typoOk(w, nq)) || typoOk(nn, nq))) return 2;
      return 0;
    };
    for (const [k, t] of this.teams) { const s = score(k, t.n); if (s) out.push({ n: t.n, kind: 'team', c: t.c, s }); }
    for (const [k, c] of this.comps) { const s = score(k, c.n); if (s) out.push({ n: c.n, kind: 'comp', c: c.c, s }); }
    // Typed a known short form whose team isn't on right now: still offer the full name.
    if (nq && TEAM_CANON.has(nq) && !out.some((x) => x.s === 5 && x.kind === 'team')) out.push({ n: TEAM_SHOW.get(TEAM_CANON.get(nq)), kind: 'team', c: 0, s: 5 });
    if (nq && COMP_CANON.has(nq) && !out.some((x) => x.s === 5 && x.kind === 'comp')) out.push({ n: COMP_SHOW.get(COMP_CANON.get(nq)), kind: 'comp', c: 0, s: 5 });
    out.sort((a, b) => b.s - a.s || b.c - a.c || a.n.localeCompare(b.n));
    return out.slice(0, limit).map(({ n, kind, c }) => ({ n, kind, c }));
  }
}

/** A programme's teams and competition, as names to follow (the shown forms). */
function aboutProgramme(p) {
  const teams = teamsOf(p.t).map((x) => { const k = teamCanon(nk(x)); return TEAM_SHOW.get(k) || x; });
  const lg = compOf(p);
  return { teams, comp: lg ? COMP_SHOW.get(compCanon(nk(lg))) || lg : '' };
}

module.exports = { nk, teamsOf, compOf, isSport, sameTeam, sameComp, dist, SportsIndex, aboutProgramme, HD, teamCanon, compCanon };
