'use strict';
const crypto = require('crypto');
const zlib = require('zlib');
const P = require('./parse');
const { log } = require('./util');
const T = require('./titles');
const EV = require('./events');

let L;
try { L = require('./langs'); } catch { L = { detect: () => ({ langs: [], clean: '', cleanGroup: '' }), matches: () => true, names: {} }; }

const ADULT = /(^|[^a-z])(xxx|adults?|18\s*\+|\+\s*18|porn|erotic|for adults|hustler|playboy|brazzers|nsfw)([^a-z]|$)/i;
const KIDS = /(^|[^a-z])(kids?|children|cartoons?|animation|animated|anime|family|junior|jr|toons?|baby|babies|preschool|enfants?|niños|infantil|kinder|bambini)([^a-z]|$)/i;
const QUALITY = /[\s._-]*[[(]?\b(4k|uhd|fhd|hd|sd|hevc|h\.?26[45]|x26[45]|1080p|720p|2160p|480p|hdr|dolby vision|multi[- ]?(?:sub|audio)?|vostfr|vf|subbed|dubbed)\b[\])]?/gi;

// How strict each certificate is (0 = little kids … 4 = adults only).
const CERT = {
  'g': 0, 'tv-y': 0, 'tv-y7': 0, 'tv-y7-fv': 0, 'tv-g': 0, 'u': 0, 'all': 0, '0': 0,
  'pg': 1, 'tv-pg': 1,
  'pg-13': 2, 'tv-14': 2, '12': 2, '12a': 2, '13': 2,
  'r': 3, 'tv-ma': 3, '15': 3, '16': 3, 'ma15+': 3, '17': 3,
  'nc-17': 4, 'x': 4, '18': 4, 'r18+': 4, 'xxx': 4,
};
function certLevel(c) {
  if (!c) return -1;
  const k = String(c).trim().toLowerCase().replace(/^(fsk|age|ages)\s*/, '').replace(/\s+/g, '');
  if (k in CERT) return CERT[k];
  const n = parseInt(k, 10);
  if (!Number.isNaN(n)) return n <= 6 ? 0 : n <= 10 ? 1 : n <= 14 ? 2 : n <= 17 ? 3 : 4;
  return -1;
}

const QWORDS = /\b(hd|fhd|uhd|4k|sd|hevc|h265|h264|1080p|720p|backup|the)\b/g;
const norm0 = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(QWORDS, '').replace(/[^a-z0-9Ѐ-ӿ؀-ۿ぀-ヿ一-鿿가-힯]+/g, '');
/**
 * The name as a merge key. Scripts the line above drops (Greek, Hebrew, Thai, Devanagari…) can leave only digits or
 * nothing ("ΑΝΤ1" and "ΕΡΤ1" both → "1"), so different channels and films merged: then the name itself goes in too.
 * (Names that keep letters keep exactly the same key: it's in viewers' history and progress.)
 */
const norm = (s) => {
  const n = norm0(s);
  if (/\D/.test(n)) return n;
  const raw = String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  if (!/\p{L}/u.test(raw.replace(/[a-zЀ-ӿ؀-ۿ぀-ヿ一-鿿가-힯]+/g, ''))) return n; // (nothing was dropped but tags and signs)
  return n + '|' + raw.replace(QWORDS, ' ').trim().replace(/\s+/g, ' ');
};
// A channel's name key: a name with nothing kept from it still goes by its guide id first, as it always did.
const liveNorm = (name, tvgId) => (norm0(name) ? norm(name) : String(tvgId || '').toLowerCase() || norm(name));
const keyOf = (id) => crypto.createHash('sha1').update(id).digest('base64url').slice(0, 11);

function cleanTitle(s) {
  let t = String(s || '').replace(QUALITY, ' ').replace(/[\u1d2c-\u1d6a]+/g, ' ');
  // What's left between removed quality tags ("TF1 HDR/UHD/4K" → "TF1 / /"): drop the orphaned slashes and a
  // lone "+", but not the one in a name ("CANAL+").
  t = t.replace(/(?:\s*\/)+(?=\s|$|\+)/g, ' ').replace(/\s+\+(?=\s|$)/g, ' ').replace(/\s{2,}/g, ' ');
  t = t.replace(/[\s|:•·▎\/-]+$/, '').replace(/^[\s|:•·▎\/-]+/, '').trim();
  return t || String(s || '').trim();
}
function yearOf(s) {
  const m = String(s || '').match(/[([\s.-]((?:19|20)\d{2})[)\]\s.]*$/) || String(s || '').match(/\(((?:19|20)\d{2})\)/);
  return m ? parseInt(m[1], 10) : 0;
}
const stripYear = (s) => String(s || '').replace(/\s*[([]((?:19|20)\d{2})[)\]]\s*$/, '').replace(/\s+((?:19|20)\d{2})$/, '').trim();
/**
 * Genre names, tidied so the same genre from different sources (providers, TMDB's movie and TV lists, other
 * languages) groups together: "Sci-Fi & Fantasy" → Science Fiction + Fantasy, "Comédie" → Comedy, …
 */
const GENRE_ALIAS = new Map(Object.entries({
  'sci-fi': 'Science Fiction', scifi: 'Science Fiction', 'sci fi': 'Science Fiction', 'science-fiction': 'Science Fiction', 'science fiction': 'Science Fiction',
  documentary: 'Documentary', documentaries: 'Documentary', docu: 'Documentary', documentaire: 'Documentary', documental: 'Documentary', dokumentation: 'Documentary',
  animation: 'Animation', animated: 'Animation', cartoon: 'Animation', cartoons: 'Animation', anime: 'Anime',
  comedy: 'Comedy', comedie: 'Comedy', 'comédie': 'Comedy', comedia: 'Comedy', 'komödie': 'Comedy', sitcom: 'Comedy',
  drama: 'Drama', drame: 'Drama', dramas: 'Drama',
  horror: 'Horror', horreur: 'Horror', terror: 'Horror',
  thriller: 'Thriller', suspense: 'Thriller', crime: 'Crime', policier: 'Crime', 'true crime': 'Crime',
  romance: 'Romance', romantic: 'Romance', action: 'Action', adventure: 'Adventure', aventure: 'Adventure',
  family: 'Family', kids: 'Kids', children: 'Kids', enfants: 'Kids', fantasy: 'Fantasy', mystery: 'Mystery',
  history: 'History', historical: 'History', war: 'War', politics: 'Politics', western: 'Western',
  music: 'Music', musical: 'Music', reality: 'Reality', 'reality-tv': 'Reality', 'reality tv': 'Reality', news: 'News',
  talk: 'Talk', soap: 'Soap', 'tv movie': 'TV Movie', sport: 'Sport', sports: 'Sport', biography: 'Biography', biopic: 'Biography',
}));
const normGenre = (g) => {
  const k = String(g || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!k || k.length > 28 || /^\d+$/.test(k)) return '';
  return GENRE_ALIAS.get(k) || k.replace(/\b\w/g, (c) => c.toUpperCase());
};
const genresOf = (s) => {
  const out = [];
  for (const part of (Array.isArray(s) ? s : String(s || '').split(/[,/|&;]+/))) {
    for (const x of String(part).split(/\s+&\s+|\s+and\s+/i)) { const g = normGenre(x); if (g && !out.includes(g)) out.push(g); }
  }
  return out;
};
const COUNTRY_TAG = /^\s*[[|(]?\s*([A-Z]{2,3})\s*[\]|):▎➾✦•-]/;
const COUNTRIES = new Set('US USA UK GB CA AU NZ IE ZA IN PK FR DE AT CH BE NL ES MX AR BR PT IT TR GR RU UA PL RO HU CZ SK BG RS HR BA SI MK AL SE NO DK FI IS EE LV LT CN JP KR VN TH ID MY PH SA AE EG MA DZ TN IQ IR IL'.split(' '));

/**
 * The combined catalogue: every enabled list merged into one, duplicates folded together (other copies become
 * backup streams), languages detected, series grouped into shows, and each item given a stable key so progress,
 * bookmarks and recommendations survive list refreshes.
 */
// Streaming-service labels providers put in front of titles ("NF - Title" = from Netflix): not part of the name.
const SERVICE = /^\s*(NF|NETFLIX|D\+|DSNP|DISNEY\+?|A\+|ATV\+?|APPLE TV\+?|AMZ|PRIME|HBO|MAX|HULU|PCK|PEACOCK|P\+|PARAMOUNT\+?|TOP|SC|SPT)\s*[-|:]\s+/i;
// Recordings made in a cinema: kept, but only as a backup to a proper copy of the same film.
// Names of things that come round every year (sports above all): the same name a year apart is another event.
const EVENTISH = /\b(?:race|qualifying|qualification|practice|training|grand prix|gp|vs?\.?|versus|ufc|wwe|aew|nxt|nfl|nba|nhl|mlb|f1|motogp|nascar|week|round|stage|match|matchday|highlights|final|semi-?final|awards?|oscars|grammys|ceremony|festival|concert|live|edition|season|episode|part)\b/i;
const CAMRIP = /\s*[[(]\s*(?:HD)?(?:CAM|TS|TELESYNC|TELECINE|TC|SCREENER|SCR|HDTS)(?:[- ]?RIP)?\s*[\])]/i;
const SERVICE_NAMES = { nf: 'Netflix', netflix: 'Netflix', 'd+': 'Disney+', dsnp: 'Disney+', 'disney+': 'Disney+', disney: 'Disney+', 'a+': 'Apple TV+', 'atv+': 'Apple TV+', atv: 'Apple TV+', 'apple tv+': 'Apple TV+', 'apple tv': 'Apple TV+', amz: 'Prime Video', prime: 'Prime Video', hbo: 'HBO', max: 'Max', hulu: 'Hulu', pck: 'Peacock', peacock: 'Peacock', 'p+': 'Paramount+', 'paramount+': 'Paramount+', paramount: 'Paramount+' };
const DIVIDER = /^\s*[#=*~]{3,}.*[#=*~]{3,}\s*$|^\s*[#=*~_\-–—•.\s]+\s*$/;

class Catalog {
  constructor({ lists, epg, getSettings }) {
    this.lists = lists;
    this.epg = epg;
    this.getSettings = getSettings;
    this.items = [];
    this.byKey = new Map();
    this.shows = new Map(); // showKey -> [episode keys] (from playlists)
    this.extra = new Map(); // lazily loaded episodes (Xtream)
    this.version = '0';
    this.cache = new Map();
    this.titleIndex = new Map(); // normalised title -> [keys] (for recommendations)
    this.history = new Map(); // ETag of a payload → { sig, hashes: Map(key → fingerprint) } (for sending only changes)
  }

  /** Build the catalogue in one go (start-up, tests). */
  build() {
    const g = this._steps();
    while (!g.next().done);
  }

  /** Build in short slices so the server keeps answering (and streams keep flowing) while a big catalogue is rebuilt. */
  buildAsync(slice = 25) {
    return new Promise((resolve, reject) => {
      const g = this._steps();
      const run = () => {
        const end = Date.now() + slice;
        try {
          while (Date.now() < end) if (g.next().done) return resolve();
        } catch (e) { return reject(e); }
        setImmediate(run);
      };
      run();
    });
  }

  *_steps() {
    const t0 = Date.now();
    let n = 0;
    this._building = true;
    this._epgDirty = false;
    const S = this.getSettings();
    const hiddenGroups = new Set((S.hiddenGroups || []).map((g) => g.toLowerCase()));
    const hiddenKeys = new Set(S.hiddenKeys || []);
    const merged = new Map();
    const order = [];
    const groupCache = new Map();
    for (const l of this.lists.all().concat(this.lists.extras || [])) {
      if (!l.enabled) continue;
      if (this.lists.itemSteps) yield* this.lists.itemSteps(l);
      const parsed = this.lists.parsed.get(l.id);
      if (!parsed || !parsed.items) continue;
      yield;
      for (const raw of parsed.items) {
        if ((++n & 2047) === 0) yield;
        const it = this._item(l, raw, groupCache);
        if (!it) continue;
        const prev = merged.get(it.k);
        if (!prev) { merged.set(it.k, it); order.push(it); continue; }
        this._merge(prev, it);
      }
    }
    yield;
    yield* this._inferLangSteps(order);
    yield;
    // A title whose language was only worked out from its category is the same title as one already known in that
    // language ("TOP 500" copy of a film that's also in "Action"): merge them; otherwise it gets its proper key.
    // Same title + year (or channel name + country) with a known language: index them.
    const known = new Map();
    const listLang = new Map(); // list → language → count (to find each list's main language)
    let nk = 0;
    for (const it of order) {
      if ((++nk & 16383) === 0) yield;
      if (!it._kp || !it.lg || !it.lg.length || it._noLang) continue;
      const ll = listLang.get(it.src) || new Map();
      ll.set(it.lg[0], (ll.get(it.lg[0]) || 0) + 1);
      listLang.set(it.src, ll);
      const list = known.get(it._kp) || [];
      list.push(it);
      known.set(it._kp, list);
    }
    yield;
    for (let i = 0; i < order.length; i++) {
      if ((i & 8191) === 0) yield;
      const it = order[i];
      if (!it._kp) continue;
      const kp = it._kp;
      it._kp = undefined;
      const wasUnknown = it._noLang;
      it._noLang = undefined;
      if (!wasUnknown || merged.get(it.k) !== it) continue;
      // Still no language: if exactly one language has this same title, it's that one ("TOP 500" copy of a film).
      if (!it.lg || !it.lg.length) {
        const cands = (known.get(kp) || []).filter((c) => c !== it);
        const langs = new Set(cands.map((c) => c.lg[0]));
        let into = langs.size === 1 ? cands[0] : null;
        if (!into && langs.size > 1) {
          // Several languages have it: the list's main language is the best guess for an unlabelled copy.
          const ll = listLang.get(it.src);
          const main = ll ? [...ll.entries()].sort((a, b) => b[1] - a[1])[0][0] : '';
          into = cands.find((c) => c.lg[0] === main) || null;
        }
        if (into) { merged.delete(it.k); this._merge(into, it); order[i] = null; }
        continue;
      }
      const nk = keyOf(kp.replace('\u0000', it.lg[0]));
      const other = merged.get(nk);
      merged.delete(it.k);
      if (other && other !== it) { this._merge(other, it); order[i] = null; continue; }
      it.k = nk;
      merged.set(nk, it);
    }
    { let w = 0; for (let i = 0; i < order.length; i++) if (order[i]) order[w++] = order[i]; order.length = w; }
    yield;
    yield* this._sameTitleSteps(order, merged);
    yield;
    // Shows from playlist episodes.
    const shows = new Map();
    for (const it of order) {
      if (it.t !== 'episode') continue;
      let show = merged.get(it.sk);
      if (!show) {
        show = { k: it.sk, t: 'show', n: it.show, g: it.g, lg: it.lg, logo: it.logo, src: it.src, ad: it.ad, adult: it.adult, kids: it.kids, eps: [] };
        merged.set(show.k, show);
        order.push(show);
      }
      if (!show.eps) show.eps = [];
      show.eps.push(it.k);
      if (!show.logo && it.logo) show.logo = it.logo;
      if (it.ad > (show.ad || 0)) show.ad = it.ad;
    }
    for (const show of merged.values()) {
      if (show.t !== 'show' || !show.eps) continue;
      show.eps.sort((a, b) => { const x = merged.get(a), y = merged.get(b); return x.s - y.s || x.e - y.e; });
      shows.set(show.k, show.eps);
    }
    yield;
    // Channel numbers: the list's own where given, otherwise counted on from the highest.
    let maxNum = 0;
    const used = new Set();
    for (const it of order) if ((it.t === 'live' || it.t === 'radio') && it.num && !used.has(it.num)) { used.add(it.num); maxNum = Math.max(maxNum, it.num); } else if (it.t === 'live' || it.t === 'radio') it.num = 0;
    for (const it of order) if ((it.t === 'live' || it.t === 'radio') && !it.num) it.num = ++maxNum;

    let items = order.filter((it) => !hiddenKeys.has(it.k) && !hiddenGroups.has(String(it.g).toLowerCase()) && !(it.rg && hiddenGroups.has(String(it.rg).toLowerCase())));
    yield;
    // Titles renamed by the tidy-up (or merged with another copy): old key → new key, so saved things move over.
    const renamed = new Map();
    let nr = 0;
    for (const it of order) {
      if ((++nr & 4095) === 0) yield;
      if (!it._lk) continue;
      for (const lk of it._lk) {
        const [tpl, field] = Array.isArray(lk) ? lk : [lk, 'k'];
        const old = tpl[0] === '\u0001' ? tpl.slice(1) : tpl.includes('\u0000') ? keyOf(tpl.replace('\u0000', (it.lg && it.lg[0]) || '')) : keyOf(tpl);
        const to = it[field];
        if (to && old !== to && !merged.has(old)) renamed.set(old, to);
      }
      it._lk = undefined;
    }
    yield;
    // The admin's channel edits (names, logos, numbers, categories, hidden…), kept apart so they survive refreshes.
    if (this.overrides) items = this.overrides.apply(items, renamed);
    const byKey = new Map();
    for (let i = 0; i < items.length; i++) { if ((i & 32767) === 0) yield; byKey.set(items[i].k, items[i]); }
    const titleIndex = new Map();
    for (let i = 0; i < items.length; i++) {
      if ((i & 16383) === 0) yield;
      const it = items[i];
      if (it.t !== 'movie' && it.t !== 'show') continue;
      const nk = norm(stripYear(it.n));
      if (!nk) continue;
      if (!titleIndex.has(nk)) titleIndex.set(nk, []);
      titleIndex.get(nk).push(it.k);
    }
    yield;
    const epgSig = yield* this._mapEpgSteps(items);
    yield;
    const vh = crypto.createHash('sha1').update(String(items.length) + '|');
    for (let i = 0; i < items.length; i++) { if ((i & 32767) === 0) yield; const it = items[i]; vh.update(it.k + (it.u || '') + (it.epg ? 'E' : '') + ','); }
    // Everything is ready: switch over in one go (nothing in between sees half a catalogue).
    for (const [k, e] of this.extra) if (!byKey.has(k)) byKey.set(k, e);
    this.renamed = renamed;
    this.items = items;
    this.byKey = byKey;
    this.shows = shows;
    this._epgSig = epgSig;
    this.titleIndex = titleIndex;
    // The guide changed while this was being built: link the channels again, now on the new catalogue.
    this._building = false;
    if (this._epgDirty) { this._epgDirty = false; this._epgSig = this._mapEpg(); }
    if (this.epg && this.epg.useOnly && this._epgUsed && items.length) this.epg.useOnly(this._epgUsed).catch(() => {});
    // (A new name every build: the details added afterwards — TMDB, guide links — differ even when the lists don't.)
    this.version = vh.digest('hex').slice(0, 12) + '.' + Date.now().toString(36);
    this.deltas = null;
    this.cache.clear();
    // The providers' raw entries aren't needed until the next rebuild: free them (they're read again from disk).
    // (A few minutes later, so a burst of changes — an admin trying out settings — doesn't read them all again each time.)
    if (this.lists.releaseItemsSoon) this.lists.releaseItemsSoon(); else if (this.lists.releaseItems) this.lists.releaseItems();
    log(`Catalogue: ${items.length} items (${[...shows.keys()].length} shows) in ${Date.now() - t0} ms`);
    return this.version;
  }

  /** A category's display name: tidied, then the admin's rules (rename / merge / hide). null = hidden. */
  _group(g, type) {
    const S = this.getSettings();
    const rules = S.groupRules || [];
    const ck = g + '\u0002' + type;
    const cache = this._gcache || (this._gcache = new Map());
    if (this._gsig !== JSON.stringify(rules)) { cache.clear(); this._gsig = JSON.stringify(rules); this._grules = rules.map((r) => ({ ...r, re: T.patternRe(r.match) })); }
    if (cache.has(ck)) return cache.get(ck);
    let out = S.tidyGroups === false ? g : T.tidyGroup(g);
    for (const r of this._grules) {
      if (r.types && r.types.length && !r.types.includes(type === 'episode' ? 'show' : type)) continue;
      if (!r.re.test(g) && !r.re.test(out)) continue;
      out = r.hide ? null : String(r.to || '').trim() || out;
      break;
    }
    cache.set(ck, out);
    return out;
  }

  _item(l, raw, groupCache) {
    if (!raw.url && raw.type !== 'show') return null;
    if (raw.relative) return null;
    // Providers put fake "channels" in as headings ("##### SPORT #####"): not something anyone can watch.
    if ((raw.type === 'live' || raw.type === 'radio') && DIVIDER.test(raw.name || '')) return null;
    let type = raw.type;
    let ep = raw.ep || null;
    let showName = raw.show || '';
    if (type === 'series') {
      const e = P.episode(raw.name);
      if (e) { type = 'episode'; ep = { season: e.season, episode: e.episode, title: e.title }; showName = e.show; } else type = 'movie';
    } else if (type === 'movie' && !ep) {
      const e = P.episode(raw.name);
      if (e && /\/series\//.test(raw.url)) { type = 'episode'; ep = { season: e.season, episode: e.episode, title: e.title }; showName = e.show; }
    }
    const gKey = (raw.group || '') + '\u0001' + (raw.category || '');
    // Pay-per-view channels that carry the event in their name: name the channel, keep the event aside.
    let ev = (type === 'live' || type === 'radio') ? T.liveEvent(raw.name) : null;
    // (Other ways of writing it, with the start time: lib/events.js. The channel then gets listings from its name.)
    const evp = type === 'live' && EV.maybeEvent(raw.name) ? EV.parseEventName(raw.name, { tz: l.evTz || l.tz }) : null;
    if (!ev && evp) ev = { n: evp.chan, tag: evp.tag, ev: evp.title ? (evp.comp ? evp.comp + ': ' : '') + evp.title : '', evs: evp.none ? 'none' : evp.ended ? 'ended' : evp.live ? 'live' : '', own: true };
    const dname = ev ? (ev.tag ? `${ev.tag}: ${ev.n}` : ev.n) : raw.name;
    let det = L.detect({ name: dname, group: raw.group || '', tvgLanguage: raw.lang || '', tvgCountry: raw.country || '', tvgId: raw.tvgId || '', category: raw.category || '', type });
    let langs = l.lang ? [l.lang] : det.langs || [];
    if (!l.lang) { const r = T.refineLangs(type, raw.name, raw.group || raw.category || '', langs, ev && ev.tag, L.fromCountry); if (r) langs = r; }
    // The legacy name (before titles were tidied): its key is kept as an alias, so history, lists and favourites
    // made before the tidy-up move over to the new key.
    const legacyBase = (() => { const d0 = ev ? L.detect({ name: raw.name, group: raw.group || '', category: raw.category || '', type }) : det; return d0.clean || raw.name; })();
    let group = det.cleanGroup;
    if (group === undefined || group === null || group === '') {
      if (!groupCache.has(gKey)) groupCache.set(gKey, cleanTitle(raw.group || raw.category || ''));
      group = groupCache.get(gKey);
    }
    let base = det.clean || dname;
    let legacy = legacyBase;
    let svc = '', cam = false;
    if (type !== 'live' && type !== 'radio') {
      const sm = SERVICE.exec(base);
      if (sm) { svc = SERVICE_NAMES[sm[1].toLowerCase()] || ''; base = base.slice(sm[0].length); }
      const lm = SERVICE.exec(legacy);
      if (lm) legacy = legacy.slice(lm[0].length);
      if (CAMRIP.test(base)) { cam = true; base = base.replace(CAMRIP, ' '); legacy = legacy.replace(CAMRIP, ' '); }
      if (showName) { const ss = SERVICE.exec(showName); if (ss) showName = showName.slice(ss[0].length); showName = showName.replace(CAMRIP, ' '); }
    }
    const legacyName = cleanTitle(legacy) || raw.name;
    let name = cleanTitle(base) || raw.name;
    let tidy = null;
    let was = null; // the name as the tidy-up made it before end tags were peeled off (its key is kept as an alias)
    if (type === 'movie' || type === 'show') {
      tidy = T.tidyVod(name, raw.year || 0);
      if (tidy.cam) cam = true;
      { const o = T.tidyVod(name, raw.year || 0, true); if (o.n !== tidy.n || o.y !== tidy.y) was = o; }
      name = tidy.n || name;
    }
    const adult = ADULT.test(raw.group || '') || ADULT.test(raw.name || '') || ADULT.test(raw.category || '');
    const kids = !adult && (KIDS.test(raw.group || '') || KIDS.test(raw.category || '') || KIDS.test(raw.genre || ''));
    const lang0 = langs[0] || '';
    const cm = String(raw.name || '').match(COUNTRY_TAG) || String(raw.group || '').match(COUNTRY_TAG);
    const country = cm && COUNTRIES.has(cm[1]) ? cm[1] : (raw.country || '').toUpperCase();
    const rawGroup = group;
    group = this._group(group, type);
    if (group === null) return null; // hidden by an admin rule
    const it = {
      t: type, n: name, g: group || (type === 'live' ? 'Channels' : type === 'radio' ? 'Radio' : type === 'show' || type === 'episode' ? 'Series' : 'Movies'),
      lg: langs, logo: raw.logo || '', u: raw.url || '', src: l.id, ad: raw.added || 0, adult, kids,
    };
    if (rawGroup && rawGroup !== it.g) it.rg = rawGroup;
    if (ev) { if (ev.ev) it.ev = ev.ev; if (ev.evs) it.evs = ev.evs; }
    if (evp) it.rn = raw.name; // (read again for its listings as time goes by: lib/events.js)
    if (type === 'live' && /\b(?:HD|FHD|UHD|4K)\b/i.test(raw.name)) it.hd = 1; // (the tidied name loses it; Events prefer HD copies)
    if (tidy && tidy.note) it.note = tidy.note;
    if (!langs.length) { it._rg = raw.group || raw.category || ''; it._noLang = true; } // for the category-majority step in build()
    if (svc) it.svc = svc;
    if (cam) it.cam = 1;
    if (raw.headers && Object.keys(raw.headers).length) it.h = raw.headers;
    if (type === 'live' || type === 'radio') {
      it.num = parseInt(raw.chno, 10) || 0;
      if (raw.tvgId) it.tvgId = raw.tvgId;
      if (raw.tvgName) it.tvgName = raw.tvgName;
      if (raw.catchup) it.cu = { ...raw.catchup, tz: raw.catchup.tz || l.tz || '' };
      if (raw.shift) it.sh = raw.shift;
      if (raw.artist) it.artist = raw.artist;
      // Same channel = same name (ignoring HD/FHD/… and language tags) in the same language and country.
      // (An event channel's key stays put as its event changes daily; per list, so two providers' "PPV 3" don't merge.)
      const id = `L:${liveNorm(name, raw.tvgId)}:${lang0}:${country}:${type}` + (ev && ev.own ? ':' + l.id : '');
      it.k = keyOf(id);
      it._kp = `L:${liveNorm(name, raw.tvgId)}:\u0000:${country}:${type}` + (ev && ev.own ? ':' + l.id : '');
      it._lk = [`L:${liveNorm(legacyName, raw.tvgId)}:\u0000:${country}:${type}`];
    } else if (type === 'episode') {
      const legacyShow = cleanTitle(stripYear(showName)) || showName || 'Unknown show';
      const show = T.tidyVod(legacyShow).n || legacyShow;
      it.show = show;
      it._lk = [keyOf(`E:${norm(legacyShow)}:${ep.season}:${ep.episode}:${lang0}`), [keyOf(`S:${norm(legacyShow)}:${lang0}`), 'sk']].map((x) => (Array.isArray(x) ? ['\u0001' + x[0], x[1]] : '\u0001' + x));
      {
        const o = T.tidyVod(legacyShow, 0, true).n || legacyShow;
        if (o !== show) it._lk.push('\u0001' + keyOf(`E:${norm(o)}:${ep.season}:${ep.episode}:${lang0}`), ['\u0001' + keyOf(`S:${norm(o)}:${lang0}`), 'sk']);
      }
      it.s = ep.season; it.e = ep.episode; it.et = ep.title || '';
      it.n = `${show} S${String(it.s).padStart(2, '0')}E${String(it.e).padStart(2, '0')}${it.et ? ' ' + it.et : ''}`;
      it.sk = keyOf(`S:${norm(show)}:${lang0}`);
      it.k = keyOf(`E:${norm(show)}:${it.s}:${it.e}:${lang0}`);
      if (raw.duration) it.d = raw.duration;
    } else if (type === 'show') {
      const y = raw.year || tidy.y || yearOf(legacyName);
      it.n = name;
      if (y) it.y = y;
      it.k = keyOf(`S:${norm(it.n)}:${lang0}`);
      it._kp = `S:${norm(it.n)}:\u0000`;
      it._lk = [`S:${norm(stripYear(legacyName))}:\u0000`];
      it.xt = { l: l.id, kind: 'series', id: raw.xt.id };
      if (was) it._lk.push(`S:${norm(was.n)}:\u0000`);
    } else {
      const y = raw.year || tidy.y || yearOf(legacyName);
      const ly = raw.year || yearOf(legacyName);
      it.n = name;
      if (y) it.y = y;
      it.k = keyOf(`M:${norm(it.n)}:${y || ''}:${lang0}`);
      it._kp = `M:${norm(it.n)}:${y || ''}:\u0000`;
      it._lk = [`M:${norm(stripYear(legacyName) || legacyName)}:${ly || ''}:\u0000`];
      if (was) it._lk.push(`M:${norm(was.n)}:${raw.year || was.y || yearOf(legacyName) || ''}:\u0000`);
      if (raw.duration) it.d = raw.duration;
    }
    if (raw.xt && type !== 'show') it.xt = { l: l.id, kind: raw.xt.kind, id: raw.xt.id };
    if (raw.local) it.loc = raw.local;
    if (raw.drm) it.dr = raw.drm;
    if (raw.dash) it.dash = 1;
    if (raw.rating) it.r = Math.round(raw.rating * 10) / 10;
    if (raw.plot) it.plot = raw.plot;
    if (raw.genre) it.gn = genresOf(raw.genre);
    if (raw.cast) it.cast = raw.cast;
    if (raw.director) it.dir = raw.director;
    if (raw.backdrop) it.bd = raw.backdrop;
    if (raw.trailer) it.tr = raw.trailer;
    if (raw.tmdb) it.tmdb = String(raw.tmdb);
    if (raw.cert) it.c = raw.cert;
    return it;
  }

  _merge(a, b) {
    // A cinema recording never plays first when there's a proper copy: swap it into the backups.
    if (a.cam && !b.cam && b.u) {
      const old = { u: a.u, h: a.h, l: a.src };
      a.u = b.u; a.h = b.h; a.src = b.src; if (b.xt) a.xt = b.xt;
      a.alts = (a.alts || []).filter((x) => x.u !== b.u);
      if (old.u) a.alts.push(old);
      delete a.cam;
      b = { ...b, u: '' };
    }
    if (b.u && b.u !== a.u && !(a.alts || []).some((x) => x.u === b.u)) {
      (a.alts || (a.alts = [])).push({ u: b.u, h: b.h, l: b.src });
    }
    // (b may already be a merged entry: its own backup copies come along too.)
    for (const x of b.alts || []) if (x.u && x.u !== a.u && !(a.alts || []).some((y) => y.u === x.u)) (a.alts || (a.alts = [])).push(x);
    // A series on several providers (or twice on one): every copy's episodes are used, so seasons only one has show.
    if (a.t === 'show' && (b.xt || b.xts)) {
      const xs = a.xts || (a.xts = a.xt ? [a.xt] : []);
      for (const x of [b.xt, ...(b.xts || [])]) if (x && !xs.some((y) => y.l === x.l && y.id === x.id)) xs.push(x);
    }
    if (b._lk) a._lk = (a._lk || []).concat(b._lk);
    if (b.k && b.k !== a.k) (a._lk || (a._lk = [])).push(['\u0001' + b.k, 'k']);
    if (!a.svc && b.svc) a.svc = b.svc;
    for (const k of ['logo', 'tvgId', 'tvgName', 'cu', 'plot', 'gn', 'cast', 'dir', 'bd', 'tr', 'tmdb', 'y', 'r', 'c', 'd', 'xt']) if (!a[k] && b[k]) a[k] = b[k];
    if (b.ad > (a.ad || 0)) a.ad = b.ad;
    if (!a.lg.length && b.lg.length) a.lg = b.lg;
    a.kids = a.kids || b.kids;
    a.adult = a.adult || b.adult;
  }

  /**
   * Films and series that are the same title but didn't get the same key: "Key & Peele" / "Key And Peele", a copy
   * without a year ("The Hunger Games" / "The Hunger Games (2012)"), or years one apart between providers ("Carry On
   * Jack" 1963 / 1964). Same type and language, and names equal once "&"/"and" and punctuation are ignored; then:
   *   • a TMDB id the provider gave that differs → different titles, never merged ("Ghostbusters" 1984 / 2016);
   *   • films: same year, or one apart, or one copy without a year when only one title by that name has one;
   *   • series: years at most one apart (or unknown) — a remake years later stays separate.
   * The first copy (list order) stays; the others become its backups (history etc. move over, see _lk).
   */
  *_sameTitleSteps(order, merged) {
    const groups = new Map();
    let n = 0;
    for (const it of order) {
      if ((++n & 16383) === 0) yield;
      if (it.t !== 'movie' && it.t !== 'show') continue;
      const m = norm(String(it.n).replace(/\s*&\s*/g, ' and '));
      if (!m) continue;
      const k = `${it.t}|${(it.lg && it.lg[0]) || ''}|${m}`;
      const g = groups.get(k);
      if (g) g.push(it); else groups.set(k, [it]);
    }
    yield;
    const tm = (it) => (it.tmdb && it.tmdb !== '0' ? String(it.tmdb) : '');
    const gone = new Set();
    n = 0;
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      if ((++n & 1023) === 0) yield;
      const event = EVENTISH.test(g[0].n);
      const heads = [];
      const fits = (h, it) => {
        if (h.tmdbs.size && tm(it) && !h.tmdbs.has(tm(it))) return false;
        if (tm(it) && h.tmdbs.has(tm(it))) return true;
        if (!it.y || !h.years.size) return false; // (decided below)
        if (h.years.has(it.y)) return true;
        // A year apart: providers date a film by its festival or its release. Only with a TMDB id on one side to say
        // what it is, and never for things that happen every year ("GP van Las Vegas - Race" 2024 / 2025).
        if (event || !(tm(it) || h.tmdbs.size)) return false;
        for (const y of h.years) if (Math.abs(y - it.y) === 1) return true;
        return false;
      };
      const join = (h, it) => {
        this._merge(h.it, it);
        if (it.y) h.years.add(it.y);
        if (tm(it)) h.tmdbs.add(tm(it));
        gone.add(it);
      };
      for (const it of g) {
        const h = heads.find((x) => fits(x, it));
        if (h) join(h, it);
        else heads.push({ it, years: new Set(it.y ? [it.y] : []), tmdbs: new Set(tm(it) ? [tm(it)] : []) });
      }
      // Copies without a year: into the one dated title of that name (none, or several → left as they are).
      const dated = heads.filter((h) => h.years.size);
      const undated = heads.filter((h) => !h.years.size);
      if (dated.length === 1) for (const h of undated) if (!(h.tmdbs.size && dated[0].tmdbs.size && ![...h.tmdbs].some((t) => dated[0].tmdbs.has(t)))) join(dated[0], h.it);
    }
    // Series under two names with the provider's TMDB id agreeing: "Ask ve Gozyasi" / "Ask ve Gozyasi - Queen of
    // Tears", "Lioness" / "Special Ops: Lioness" — same id, same year, one name inside the other. (Not films: there
    // providers give the prelims and the main card of a fight night the same id.)
    const byId = new Map();
    for (const it of order) {
      if (it.t !== 'show' || gone.has(it) || !tm(it)) continue;
      const k = `${tm(it)}|${(it.lg && it.lg[0]) || ''}`;
      const g = byId.get(k);
      if (g) g.push(it); else byId.set(k, [it]);
    }
    yield;
    for (const g of byId.values()) {
      for (let i = 0; i < g.length; i++) {
        const a = g[i];
        if (gone.has(a)) continue;
        const na = norm(a.n);
        for (let j = i + 1; j < g.length; j++) {
          const b = g[j];
          if (gone.has(b) || (a.y && b.y && a.y !== b.y)) continue;
          const nb = norm(b.n);
          if (na.length < 3 || nb.length < 3 || !(na.includes(nb) || nb.includes(na))) continue;
          this._merge(a, b);
          gone.add(b);
        }
      }
    }
    if (!gone.size) return;
    for (const it of gone) if (merged.get(it.k) === it) merged.delete(it.k);
    let w = 0;
    for (let i = 0; i < order.length; i++) if (!gone.has(order[i])) order[w++] = order[i];
    order.length = w;
    this.lastSameTitle = gone.size;
  }

  /** Posters, genres, cast… were filled in (TMDB): new version so devices fetch the catalogue again. */
  metaChanged() {
    this.version = this.version.split('.')[0] + '.m' + Date.now().toString(36);
    this.cache.clear();
  }

  /** Links channels to guide entries; returns a fingerprint of the links (to tell whether anything changed). */
  /**
   * Titles whose language couldn't be detected take the language most of their category has, when that's clear
   * (e.g. "|EU| FR SOCCER PPV" where the other channels say "FR:"). "|NA|" (North America) categories are English.
   */
  *_inferLangSteps(order) {
    const stats = new Map();
    let n = 0;
    for (const it of order) {
      if ((++n & 16383) === 0) yield;
      if (!it.lg || !it.lg.length) continue;
      const gk = it.src + '|' + it.g;
      const m = stats.get(gk) || new Map();
      m.set(it.lg[0], (m.get(it.lg[0]) || 0) + 1);
      stats.set(gk, m);
    }
    for (const it of order) {
      if ((++n & 16383) === 0) yield;
      if (it._rg === undefined) continue;
      const rg = it._rg;
      it._rg = undefined;
      if (it.lg && it.lg.length) continue; // a duplicate from another list supplied it
      const m = stats.get(it.src + '|' + it.g);
      if (m) {
        let total = 0, best = '', bn = 0;
        for (const [l, n] of m) { total += n; if (n > bn) { bn = n; best = l; } }
        if (bn >= 2 && bn / total >= 0.6 && best !== 'mul') { it.lg = [best]; continue; }
      }
      if (/^\W*NA\W/i.test(rg) || /^\W*(USA|US|CA)\W/i.test(rg)) it.lg = ['en'];
    }
  }

  _mapEpg(items = this.items) {
    const g = this._mapEpgSteps(items);
    let r;
    while (!(r = g.next()).done);
    return r.value;
  }

  *_mapEpgSteps(items) {
    if (!this.epg) return '';
    const h = crypto.createHash('sha1');
    const used = new Set();
    let n = 0;
    for (const it of items) {
      if ((++n & 16383) === 0) yield;
      if (it.t !== 'live' && it.t !== 'radio') continue;
      // Event channels: listings from their names (lib/events.js) come first, unless the admin picked a guide.
      if (it.rn && !it.eo && this.epg.virtual && this.epg.virtual.has('ev:' + it.k)) { it.epg = 'ev:' + it.k; h.update(it.k + '=ev;'); continue; }
      const id = this.epg.resolve({ epgOverride: it.eo, tvgId: it.tvgId, tvgName: it.tvgName, name: it._o ? it._o.n : it.n });
      if (id && this.epg.has(id)) { it.epg = id; used.add(id); h.update(it.k + '=' + id + ';'); } else if (it.epg) it.epg = undefined;
    }
    // Only these channels' programmes need to be in memory (the guide reads any others back if they become used).
    this._epgUsed = used;
    return h.digest('hex');
  }

  /**
   * Called when guide data changes: re-link channels to guide entries. Only when the links actually changed is the
   * catalogue re-versioned (which makes every device download it again) — a routine guide refresh doesn't.
   * Returns true when it changed.
   */
  epgChanged() {
    if (this._building) this._epgDirty = true; // (linked again on the new catalogue when the build finishes)
    const sig = this._mapEpg();
    // (Not before the first catalogue exists: then nothing is linked yet, and that doesn't mean nothing is used.)
    if (!this._building && this.items.length && this.epg.useOnly && this._epgUsed) this.epg.useOnly(this._epgUsed).catch(() => {});
    if (sig === this._epgSig) return false;
    this._epgSig = sig;
    this.version = this.version.split('.')[0] + '.' + Date.now().toString(36);
    this.cache.clear();
    return true;
  }

  get(key) { return this.byKey.get(key) || this.extra.get(key) || null; }

  // ------------------------------------------------------------ per-profile view
  /** What a profile is allowed to see: languages, content types, parental limits, hidden groups. */
  filterFor(profile) {
    const S = this.getSettings();
    const r = profile.restrictions || {};
    const langs = Array.isArray(profile.langs) ? profile.langs : (S.defaultLangs || []);
    const unknown = typeof profile.unknownLang === 'boolean' ? profile.unknownLang : S.showUnknownLang !== false;
    const allowedSet = new Set(langs);
    const types = new Set(r.types && r.types.length ? r.types : ['live', 'radio', 'movie', 'show', 'episode']);
    if (types.has('show')) types.add('episode');
    const blocked = new Set((r.blockedGroups || []).map((g) => g.toLowerCase()));
    const maxCert = r.maxCert === undefined || r.maxCert === '' || r.maxCert === null ? 99 : Number(r.maxCert);
    const kids = !!profile.kids;
    const adult = !!r.adult && !kids;
    const sig = JSON.stringify([langs, unknown, [...types], [...blocked], maxCert, kids, adult]);
    const filterLangs = langs;
    const test = (it) => {
      if (!types.has(it.t)) return false;
      if (allowedSet.size) {
        if (L.matches) { if (!L.matches(it.lg || [], allowedSet, { unknown })) return false; } else if (!it.lg || !it.lg.length) { if (!unknown) return false; } else if (!it.lg.some((l) => allowedSet.has(l))) return false;
      }
      if (it.adult && !adult) return false;
      if (blocked.size && (blocked.has(String(it.g).toLowerCase()) || (it.rg && blocked.has(String(it.rg).toLowerCase())))) return false;
      const lvl = certLevel(it.c);
      if (kids) { if (!(it.kids || (lvl >= 0 && lvl <= Math.min(1, maxCert)))) return false; } else if (lvl > maxCert) return false;
      return true;
    };
    return { test, sig, langs: filterLangs };
  }

  visible(profile, key) {
    const it = this.get(key);
    if (!it) return null;
    const f = this.filterFor(profile);
    if (it.t === 'episode' && it.sk) { const show = this.get(it.sk); if (show && !f.test(show)) return null; return f.test({ ...it, t: show ? 'show' : it.t }) ? it : null; }
    return f.test(it) ? it : null;
  }

  static compact(it) {
    const o = { k: it.k, t: it.t, n: it.n, g: it.g };
    if (it.lg && it.lg.length) o.lg = it.lg;
    // Pictures: films and series prefer TMDB's poster (consistent, rarely broken); the provider's is the fallback.
    const pic = (it.t === 'movie' || it.t === 'show') && it.poster ? it.poster : it.logo;
    if (pic) o.i = pic;
    if (it.logo && it.poster && it.logo !== it.poster) o.i2 = pic === it.poster ? it.logo : it.poster;
    if (it.u) o.u = it.u;
    if (it.h) o.h = it.h;
    if (it.alts) o.a = it.alts.map((x) => (x.h ? { u: x.u, h: x.h } : { u: x.u }));
    if (it.num) o.no = it.num;
    if (it.epg) o.E = 1;
    if (it.cu) o.cu = it.cu;
    // Guide time shift: the playlist's own (tvg-shift) plus the admin's offset for this channel.
    if (it.sh || it.eoff) o.sh = (it.sh || 0) + (it.eoff || 0);
    if (it.so) o.so = it.so;
    if (it.dr) o.dr = it.dr;
    if (it.dash) o.dash = 1;
    if (it.y) o.y = it.y;
    if (it.r) o.r = it.r;
    if (it.c) o.c = it.c;
    if (it.gn) o.gn = it.gn;
    if (it.ad) o.ad = Math.round(it.ad / 1000);
    if (it.d) o.d = Math.round(it.d);
    if (it.sk) { o.sk = it.sk; o.s = it.s; o.e = it.e; if (it.et) o.et = it.et; }
    if (it.xt && it.t === 'show') o.x = 1;
    if (it.xt && it.t === 'movie') o.xv = 1;
    if (it.loc) o.lo = 1;
    if (it.svc) o.sv = it.svc;
    if (it.cam) o.cam = 1;
    if (it.kids) o.kd = 1;
    if (it.bd) o.bd = it.bd;
    if (it.artist) o.ar = it.artist;
    if (it.ev) o.ev = it.ev;
    if (it.evs) o.es = it.evs;
    if (it.rn) o.evc = 1; // an event channel
    if (it.note) o.nt = it.note;
    if (it.t === 'show' && it.eps) o.ne = it.eps.length;
    return o;
  }

  /** A locked item as devices see it before the PIN: no addresses, no "has a guide" flag, marked locked. */
  static lockedOut(o) {
    delete o.u; delete o.a; delete o.h; delete o.E;
    o.lk = 1;
    return o;
  }

  /** The profile's catalogue as gzipped JSON, cached until the lists or the profile's limits change. */
  payload(profile) {
    const g = this._payloadSteps(profile, true);
    let r;
    while (!(r = g.next()).done);
    return r.value;
  }

  /** The same, put together in slices (and compressed off the main thread) so the server keeps answering. */
  payloadAsync(profile) {
    const f = this.filterFor(profile);
    const ck = this.version + f.sig;
    const hit = this.cache.get(ck);
    if (hit) return Promise.resolve(hit);
    // Several devices asking at once (they all hear about a new version together): make it once.
    if (!this.pending) this.pending = new Map();
    if (this.pending.has(ck)) return this.pending.get(ck);
    // One at a time: every profile asks at once after a change, and each build briefly holds a big copy in memory.
    const pr = (this._queue || Promise.resolve()).then(() => this.cache.get(this.version + f.sig) || Catalog.runSliced(this._payloadSteps(profile, false))).finally(() => this.pending.delete(ck));
    this._queue = pr.catch(() => {});
    this.pending.set(ck, pr);
    return pr;
  }

  /**
   * A finished payload. (Made out here on purpose: a getter written inside the generator would keep that whole scope
   * alive — including the uncompressed JSON, 20–80 MB for a big catalogue — for as long as the payload is cached.)
   */
  static packed(etag, gz, version, count) {
    return { etag, gz, version, count, get raw() { return zlib.gunzipSync(gz); } };
  }

  /** Runs a generator in ~25 ms slices; a yielded promise (compression on the thread pool) is waited for. */
  static runSliced(g, slice = 25) {
    return new Promise((resolve, reject) => {
      const run = (val) => {
        const end = Date.now() + slice;
        try {
          for (;;) {
            const r = g.next(val);
            val = undefined;
            if (r.done) return resolve(r.value);
            if (r.value && typeof r.value.then === 'function') return r.value.then(run, reject);
            if (Date.now() >= end) return setImmediate(run);
          }
        } catch (e) { reject(e); }
      };
      run();
    });
  }

  *_payloadSteps(profile, sync) {
    const f = this.filterFor(profile);
    const ck = this.version + f.sig;
    const hit = this.cache.get(ck);
    if (hit) return hit;
    const items = this.items;
    const base = this.version; // (read now: it may move on while this is made)
    const out = yield* this._payloadItemSteps(f, items);
    // base: the catalogue version announced to devices when it changes (they compare against this one).
    const version = ck.length > 64 ? crypto.createHash('sha1').update(ck).digest('hex').slice(0, 16) : base;
    const json = Buffer.from(JSON.stringify({ version, base, items: out }));
    yield;
    const etag = '"' + crypto.createHash('sha1').update(ck).digest('hex').slice(0, 16) + '"';
    // Only the compressed copy is kept (a big catalogue is ~20 MB as text); the rare client without gzip gets it unpacked.
    const gz = sync ? zlib.gzipSync(json, { level: 6 }) : yield new Promise((ok, no) => zlib.gzip(json, { level: 6 }, (e, z) => (e ? no(e) : ok(z))));
    // Remember a fingerprint of every item in this version, so a device that has it can get just the changes later.
    const hashes = new Map();
    for (let i = 0; i < out.length; i++) {
      if ((i & 4095) === 0) yield;
      // (A small number, not a string: a big catalogue has hundreds of thousands of these.)
      hashes.set(out[i].k, crypto.createHash('md5').update(JSON.stringify(out[i])).digest().readInt32LE(0) >> 1);
    }
    // The catalogue changed while this was being made: don't file it under the new version.
    if (items !== this.items || base !== this.version) return yield* this._payloadSteps(profile, sync);
    const res = Catalog.packed(etag, gz, version, out.length);
    let bytes = gz.length;
    for (const v of this.cache.values()) bytes += v.gz.length;
    while (this.cache.size && (this.cache.size >= 30 || bytes > 120e6)) { const first = this.cache.keys().next().value; bytes -= this.cache.get(first).gz.length; this.cache.delete(first); }
    this.cache.set(ck, res);
    this.history.set(etag, { sig: f.sig, hashes, at: Date.now() });
    // Keep the last three versions for each set of profile limits (enough for devices that were away a while).
    const same = [...this.history].filter(([, h]) => h.sig === f.sig);
    for (const [e] of same.slice(0, Math.max(0, same.length - 3))) this.history.delete(e);
    while (this.history.size > 12) this.history.delete(this.history.keys().next().value);
    return res;
  }

  /**
   * Just what changed since the version a device already has (by its ETag): { set: [items], del: [keys] }, or null
   * when that version is too old or for different settings (the device then downloads everything).
   */
  delta(profile, since) {
    const g = this._deltaSteps(profile, since, true);
    let r;
    while (!(r = g.next()).done);
    return r.value;
  }
  deltaAsync(profile, since) {
    // Every device that had the same version gets the same answer: work it out once.
    const key = since + '|' + this.version + this.filterFor(profile).sig;
    if (!this.deltas) this.deltas = new Map();
    if (this.deltas.has(key)) return this.deltas.get(key);
    const pr = (this._queue || Promise.resolve()).then(() => Catalog.runSliced(this._deltaSteps(profile, since, false)));
    this._queue = pr.catch(() => {});
    this.deltas.set(key, pr);
    pr.catch(() => this.deltas.delete(key));
    while (this.deltas.size > 20) this.deltas.delete(this.deltas.keys().next().value);
    return pr;
  }

  *_deltaSteps(profile, since, sync) {
    const old = this.history.get(since);
    const f = this.filterFor(profile);
    if (!old || old.sig !== f.sig) return null;
    const full = sync ? this.payload(profile) : this.cache.get(this.version + f.sig) || (yield* this._payloadSteps(profile, false));
    if (full.etag === since) return { same: true, etag: full.etag };
    const now = this.history.get(full.etag);
    if (!now) return null;
    const set = [], del = [];
    const changed = new Set();
    for (const [k, h] of now.hashes) if (old.hashes.get(k) !== h) changed.add(k);
    for (const k of old.hashes.keys()) if (!now.hashes.has(k)) del.push(k);
    // Too many changes: the whole thing is just as quick.
    if (changed.size + del.length > now.hashes.size / 3) return null;
    if (changed.size) for (const o of yield* this._payloadItemSteps(f, this.items)) if (changed.has(o.k)) set.push(o);
    const json = Buffer.from(JSON.stringify({ delta: true, version: full.version, base: this.version, set, del }));
    const gz = sync ? zlib.gzipSync(json, { level: 6 }) : yield new Promise((ok, no) => zlib.gzip(json, { level: 6 }, (e, z) => (e ? no(e) : ok(z))));
    return { etag: full.etag, raw: json, gz, count: set.length + del.length };
  }

  _payloadItems(f) {
    const g = this._payloadItemSteps(f, this.items);
    let r;
    while (!(r = g.next()).done);
    return r.value;
  }

  *_payloadItemSteps(f, items) {
    const showOk = new Map();
    const out = [];
    // Behind the parental PIN: sent without stream addresses (the device asks for them once the PIN is entered).
    const ov = this.overrides;
    const locked = ov && ov.hasLocks ? (it) => ov.isLocked(it, (k) => this.get(k)) : null;
    // The same film or series in several copies this profile can see (its language, multi-language, unlabelled):
    // list it once — the copy in the profile's own language.
    const allowed = new Set(f.langs || []);
    const rank = (it) => ((it.lg || []).some((l) => allowed.has(l)) ? 0 : (it.lg || []).includes('mul') ? 1 : 2);
    const groups = new Map();
    for (let i = 0; i < items.length; i++) {
      if ((i & 16383) === 0) yield;
      const it = items[i];
      if (it.t !== 'movie' && it.t !== 'show') continue;
      if (!f.test(it)) continue;
      const gk = it.t + ':' + norm(stripYear(it.n)) + ':' + (it.y || '');
      const g = groups.get(gk);
      if (!g) groups.set(gk, [it]); else g.push(it);
    }
    yield;
    const lead = new Map(); // item → the copies folded into it
    const folded = new Set();
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((a, b) => rank(a) - rank(b));
      lead.set(g[0], g.slice(1));
      for (const x of g.slice(1)) folded.add(x);
    }
    for (let i = 0; i < items.length; i++) {
      if ((i & 16383) === 0) yield;
      const it = items[i];
      if (it.t === 'episode') continue;
      if (folded.has(it) || !f.test(it)) continue;
      if (it.t === 'show') showOk.set(it.k, true);
      const o = Catalog.compact(it);
      if (locked && locked(it)) Catalog.lockedOut(o);
      const extra = lead.get(it);
      if (extra) {
        // (Only display details are borrowed: playback backups stay the item's own, which the server knows.)
        for (const x of extra) {
          const cx = Catalog.compact(x);
          for (const k of ['i', 'gn', 'y', 'r', 'c', 'bd']) if (o[k] === undefined && cx[k] !== undefined) o[k] = cx[k];
        }
      }
      out.push(o);
    }
    for (let i = 0; i < items.length; i++) {
      if ((i & 16383) === 0) yield;
      const it = items[i];
      if (it.t === 'episode' && showOk.has(it.sk)) { const o = Catalog.compact(it); if (locked && locked(it)) Catalog.lockedOut(o); out.push(o); }
    }
    return out;
  }

  // ------------------------------------------------------------ series episodes (lazy for Xtream)
  async episodes(showKey, maxAge) {
    const show = this.get(showKey);
    if (!show) return [];
    const out = (this.shows.get(showKey) || []).map((k) => this.get(k)).filter(Boolean);
    // Every copy of the series (other providers, or the same one listing it twice): the first is asked first and
    // its episodes play first; the others add backup copies of the same episodes and any seasons it doesn't have.
    const sources = (show.xts || (show.xt ? [show.xt] : [])).filter((x) => x && x.kind === 'series');
    const got = await Promise.all(sources.map((x) => this.lists.xtSeries(x.l, x.id, maxAge).then((data) => ({ x, data }), (err) => ({ x, err }))));
    if (got.length && got.every((g) => g.err) && !out.length) throw got[0].err;
    for (const { x, data } of got) {
      if (!data) continue;
      if (data.info) {
        if (!show.plot && data.info.plot) show.plot = data.info.plot;
        if (!show.cast && data.info.cast) show.cast = data.info.cast;
        if (!show.dir && data.info.director) show.dir = data.info.director;
        if (!show.gn && data.info.genre) show.gn = genresOf(data.info.genre);
        if (!show.bd && data.info.backdrop_path) show.bd = Array.isArray(data.info.backdrop_path) ? data.info.backdrop_path[0] : data.info.backdrop_path;
        if (!show.tr && data.info.youtube_trailer) show.tr = data.info.youtube_trailer;
        if (!show.tmdb && data.info.tmdb_id) show.tmdb = String(data.info.tmdb_id);
      }
      for (const ep of data.episodes) {
        const ex = out.find((e) => e.s === ep.season && e.e === ep.episode);
        if (ex) {
          if (ex.u !== ep.url && !(ex.alts || []).some((a) => a.u === ep.url)) (ex.alts || (ex.alts = [])).push(ep.cx ? { u: ep.url, l: x.l, cx: ep.cx } : { u: ep.url, l: x.l });
          else if (ex.u === ep.url && ep.cx && !ex.cx) ex.cx = ep.cx;
          continue;
        }
        const title = String(ep.title || '').replace(new RegExp(`^${show.n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-–:]?\\s*`, 'i'), '').replace(/^S\d+\s*E\d+\s*[-–:]?\s*/i, '');
        const k = keyOf(`E:${norm(show.n)}:${ep.season}:${ep.episode}:${show.lg[0] || ''}`);
        const e = {
          k, t: 'episode', n: `${show.n} S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}${title ? ' ' + title : ''}`,
          g: show.g, lg: show.lg, logo: ep.img || show.logo, u: ep.url, src: x.l, sk: show.k, show: show.n, s: ep.season, e: ep.episode, et: title,
          d: ep.duration || 0, plot: ep.plot || '', adult: show.adult, kids: show.kids, xt: { l: x.l, kind: 'episode', id: ep.id },
        };
        if (ep.cx) e.cx = ep.cx;
        if (ep.rating) e.r = ep.rating;
        this.extra.set(k, e);
        this.byKey.set(k, e);
        out.push(e);
      }
    }
    out.sort((a, b) => a.s - b.s || a.e - b.e);
    return out;
  }

  /** Details for one item (plot, cast…), filling in from Xtream when the playlist has none. */
  async details(key) {
    const it = this.get(key);
    if (!it) return null;
    if (it.t === 'movie' && it.xt && !it._vodLoaded) {
      try {
        const info = await this.lists.xtVod(it.xt.l, it.xt.id);
        it._vodLoaded = true;
        if (info) {
          if (!it.plot && (info.plot || info.description)) it.plot = info.plot || info.description;
          if (!it.cast && (info.cast || info.actors)) it.cast = info.cast || info.actors;
          if (!it.dir && info.director) it.dir = info.director;
          if (!it.gn && info.genre) it.gn = genresOf(info.genre);
          if (!it.bd && info.backdrop_path) it.bd = Array.isArray(info.backdrop_path) ? info.backdrop_path[0] : info.backdrop_path;
          if (!it.tr && info.youtube_trailer) it.tr = info.youtube_trailer;
          if (!it.tmdb && info.tmdb_id) it.tmdb = String(info.tmdb_id);
          if (!it.d && info.duration_secs) it.d = parseInt(info.duration_secs, 10) || 0;
          if (!it.c && (info.mpaa_rating || info.age)) it.c = info.mpaa_rating || info.age;
          if (!it.y && info.releasedate) it.y = parseInt(info.releasedate, 10) || 0;
        }
      } catch {}
    }
    return it;
  }

  /** Items whose title matches (for TMDB recommendations). */
  findTitle(title, year) {
    const ks = this.titleIndex.get(norm(stripYear(title))) || [];
    if (!year || ks.length < 2) return ks;
    const exact = ks.filter((k) => { const it = this.get(k); return it && (!it.y || Math.abs(it.y - year) <= 1); });
    return exact.length ? exact : ks;
  }
}

module.exports = { Catalog, norm, keyOf, certLevel, cleanTitle, stripYear, yearOf, genresOf, ADULT, KIDS };
