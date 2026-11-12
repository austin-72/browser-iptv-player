'use strict';
/**
 * More of what TMDB knows, fetched only when a page asks for it (never for the whole catalogue):
 *
 *   title(it)        one request for a title's page (or none: fetched ahead for everything, Admin → Recommendations): its logo, tagline, the cast with who they play and their
 *                    photos, the people who made it, facts (status, original title, money, website, IMDb number),
 *                    when it came out where and how (cinemas, digital, disc), its age rating by country, what viewers
 *                    wrote about it, and the other names it goes by.
 *   person(id)       a person: photo, a few lines about them, and everything of theirs — what the household's lists
 *                    have first.
 *   orders(it)       the other orders a series' episodes are kept in (DVD order, absolute numbering …).
 *   options(region)  genres and streaming services, for building a Home row.
 *
 * Every answer is TMDB's own, kept on disk by lib/tmdb.js. A title's and a person's are given from there at once
 * whatever their age, and asked for again behind the page when older than a day. The functions that turn an answer
 * into what a page shows are plain functions of the answer, tested on their own (test/tmdbmore.test.js).
 */
const IMG = process.env.TMDB_IMG_BASE || 'https://image.tmdb.org/t/p/';
const TTL = 14 * 86400e3;
const yearOf = (s) => parseInt(String(s || '').slice(0, 4), 10) || 0;
const str = (s, n) => String(s == null ? '' : s).slice(0, n);
const img = (p, size) => (p && /^\/[\w.-]+$/.test(p) ? IMG + size + p : '');

// ---------------------------------------------------------------- age ratings
/** Every country's age rating in a details answer: Map('US' → 'PG-13'). */
function ratingsOf(j, type) {
  const out = new Map();
  if (type === 'movie') {
    for (const r of ((j.release_dates || {}).results) || []) {
      // (The cinema release's first — a film's TV showing is sometimes rated apart.)
      const ds = (r.release_dates || []).filter((d) => d && d.certification).sort((a, b) => (a.type === 3 ? 0 : 1) - (b.type === 3 ? 0 : 1));
      if (r.iso_3166_1 && ds.length) out.set(r.iso_3166_1, String(ds[0].certification).trim());
    }
  } else for (const r of ((j.content_ratings || {}).results) || []) if (r && r.iso_3166_1 && r.rating) out.set(r.iso_3166_1, String(r.rating).trim());
  return out;
}
const CERT_ORDER = ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'NL', 'ES', 'IT', 'BR', 'SE', 'NO', 'DK', 'FI', 'NZ', 'IE', 'MX', 'KR', 'JP'];
/**
 * The age rating to show and to hold parental limits to: the household's country's, then the US one, then the first
 * other country's that says something (level: lib/catalog.js certLevel — "NR" and "Unrated" say nothing).
 * → { c: 'PG-13', cc: 'US' } or { c: '', cc: '' }
 */
function pickCert(j, type, region, level) {
  const all = ratingsOf(j, type);
  for (const cc of [...new Set([region || 'US', ...CERT_ORDER, ...all.keys()])]) { const c = all.get(cc); if (c && level(c) >= 0) return { c, cc }; }
  return { c: '', cc: '' };
}

// ---------------------------------------------------------------- a title's page
/** The title as a picture (the film's own lettering): in the household's language, else English, else one without words. */
function logoOf(j, lang) {
  const l2 = String(lang || 'en').slice(0, 2);
  const rank = (x) => (x.iso_639_1 === l2 ? 0 : x.iso_639_1 === 'en' ? 1 : !x.iso_639_1 ? 2 : 3);
  const logos = (((j.images || {}).logos) || []).filter((x) => x && x.file_path && rank(x) < 3 && (x.aspect_ratio || 2) >= 1.2 && (x.aspect_ratio || 2) <= 8);
  logos.sort((a, b) => rank(a) - rank(b) || (b.vote_average || 0) - (a.vote_average || 0) || (b.width || 0) - (a.width || 0));
  return logos.length ? img(logos[0].file_path, 'w500') : '';
}
const WHAT = { 1: 'Premiere', 2: 'In cinemas', 3: 'In cinemas', 4: 'Digital', 5: 'On disc', 6: 'On TV' };
/** A film's releases in one country: [{ what: 'In cinemas' | 'Digital' | 'On disc' | 'On TV', date }] — the first of each. */
function datesOf(j, region) {
  const rs = ((j.release_dates || {}).results) || [];
  const r = rs.find((x) => x.iso_3166_1 === (region || 'US')) || rs.find((x) => x.iso_3166_1 === 'US');
  if (!r) return [];
  const first = new Map();
  for (const d of (r.release_dates || []).slice().sort((a, b) => String(a.release_date).localeCompare(String(b.release_date)))) {
    const what = WHAT[d.type], date = str(d.release_date, 10);
    if (!what || what === 'Premiere' || !/^\d{4}-\d\d-\d\d$/.test(date) || first.has(what)) continue;
    first.set(what, date);
  }
  return [...first].map(([what, date]) => ({ what, date }));
}
const JOBS = [['Director', 'Director'], ['Screenplay', 'Writer'], ['Writer', 'Writer'], ['Story', 'Writer'], ['Novel', 'Book'], ['Original Music Composer', 'Music'], ['Director of Photography', 'Photography']];
/** → { cast: [{ id, name, as, img, n }], crew: [{ id, name, job, img }] } (n: episodes, for a series). */
function creditsOf(j, type) {
  const cast = [], crew = [];
  const src = type === 'tv' && j.aggregate_credits ? j.aggregate_credits : j.credits || {};
  for (const c of (src.cast || []).slice(0, 24)) {
    if (!c || !c.id || !c.name) continue;
    const role = Array.isArray(c.roles) ? c.roles.slice().sort((a, b) => (b.episode_count || 0) - (a.episode_count || 0))[0] || {} : c;
    cast.push({ id: c.id, name: str(c.name, 80), as: str(role.character, 80).replace(/\s*\((voice|uncredited)\)\s*$/i, ''), img: img(c.profile_path, 'w185'), ...(c.total_episode_count ? { n: c.total_episode_count } : {}) });
  }
  const seen = new Set();
  const add = (id, name, job, p) => { const k = id + '|' + job; if (!id || !name || seen.has(k)) return; seen.add(k); crew.push({ id, name: str(name, 80), job, img: img(p, 'w185') }); };
  if (type === 'tv') for (const c of j.created_by || []) add(c.id, c.name, 'Creator', c.profile_path);
  for (const [job, label] of JOBS) {
    for (const c of src.crew || []) {
      const has = Array.isArray(c.jobs) ? c.jobs.some((x) => x.job === job) : c.job === job;
      // (A series has a director an episode: only the ones who made it what it is — its creators, its composer.)
      if (has && !(type === 'tv' && /^(Director|Writer|Screenplay|Story|Director of Photography)$/.test(job)) && crew.filter((x) => x.job === label).length < 3) add(c.id, c.name, label, c.profile_path);
    }
  }
  return { cast, crew: crew.slice(0, 10) };
}
const plainText = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~`#>]{1,3}/g, '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
/** What viewers wrote on TMDB: [{ by, stars (of 10), at, text, url }], the longest first few. */
function reviewsOf(j) {
  const out = [];
  for (const r of (((j.reviews || {}).results) || []).slice(0, 12)) {
    const text = plainText(r && r.content);
    if (text.length < 40) continue;
    const d = r.author_details || {};
    out.push({ by: str(d.name || r.author || d.username || 'Someone', 60), stars: Number(d.rating) > 0 ? Math.round(Number(d.rating) * 10) / 10 : 0, at: str(r.created_at, 10), text: text.length > 2400 ? text.slice(0, 2400).replace(/\s+\S*$/, '') + '…' : text, url: /^https:\/\/www\.themoviedb\.org\/review\/[\w-]+$/.test(String(r.url || '')) ? r.url : '' });
  }
  return out.slice(0, 6);
}
/** The other names a title goes by: its original name, and what it is called elsewhere. */
function akaOf(j) {
  const out = [];
  const add = (t) => { t = str(t, 120).trim(); if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t); };
  add(j.original_title || j.original_name);
  const alt = j.alternative_titles || {};
  // (English-speaking countries' and the country of origin's first: what copies are most often named.)
  const pref = new Set(['US', 'GB', ...(j.origin_country || []), ...((j.production_countries || []).map((c) => c.iso_3166_1))]);
  const list = (alt.titles || alt.results || []).filter((x) => x && x.title);
  for (const x of list) if (pref.has(x.iso_3166_1)) add(x.title);
  for (const x of list) if (out.length < 14) add(x.title);
  const own = String(j.title || j.name || '').toLowerCase();
  return out.filter((t) => t.toLowerCase() !== own).slice(0, 14);
}
const money = (n) => (Number(n) >= 100000 ? Math.round(Number(n)) : 0);
const STATUS = { 'Returning Series': 'Still running', Ended: 'Ended', Canceled: 'Cancelled', 'In Production': 'Being made', 'Post Production': 'Being finished', Planned: 'Planned', Rumored: 'Rumoured', Pilot: 'Pilot only', Released: '' };
/** Everything a title's page shows beyond the basics, from one details answer. */
function shapeTitle(j, { type, lang, region, level }) {
  const cr = creditsOf(j, type);
  const ext = j.external_ids || {};
  const imdb = /^tt\d{5,10}$/.test(String(ext.imdb_id || j.imdb_id || '')) ? String(ext.imdb_id || j.imdb_id) : '';
  const cert = pickCert(j, type, region, level || (() => 0));
  const home = String(j.homepage || '');
  const facts = {
    status: STATUS[j.status] !== undefined ? STATUS[j.status] : str(j.status, 30),
    original: akaOf({ original_title: j.original_title, original_name: j.original_name, title: j.title, name: j.name })[0] || '',
    lang: /^[a-z]{2}$/.test(String(j.original_language || '')) ? j.original_language : '',
    budget: money(j.budget), revenue: money(j.revenue),
    site: /^https:\/\/[\w.-]+(\/[^\s"'<>]*)?$/.test(home) && home.length < 200 ? home : '',
    seasons: Number.isInteger(j.number_of_seasons) ? j.number_of_seasons : 0, episodes: Number.isInteger(j.number_of_episodes) ? j.number_of_episodes : 0,
    first: str(j.first_air_date || j.release_date, 10), last: type === 'tv' ? str(j.last_air_date, 10) : '',
    networks: (j.networks || []).map((n) => str(n.name, 40)).filter(Boolean).slice(0, 4),
    studios: (j.production_companies || []).map((n) => str(n.name, 40)).filter(Boolean).slice(0, 4),
    countries: (j.origin_country || (j.production_countries || []).map((c) => c.iso_3166_1) || []).filter((c) => /^[A-Z]{2}$/.test(c)).slice(0, 4),
  };
  return {
    tmdb: j.id, type, tagline: str(j.tagline, 200), logo: logoOf(j, lang), cast: cr.cast, crew: cr.crew, facts, imdb,
    dates: type === 'movie' ? datesOf(j, region) : [], cert: cert.c, certFrom: cert.cc, reviews: reviewsOf(j), reviewCount: ((j.reviews || {}).total_results) || 0, aka: akaOf(j),
  };
}

// ---------------------------------------------------------------- a person
/**
 * A person's work as a list of titles: { id, type: 'movie'|'tv', title, year, poster, as: 'who they play / what they
 * did', n: episodes, pop }. One line a title, however many parts they had in it.
 */
function creditsOfPerson(j) {
  const cc = j.combined_credits || {};
  const by = new Map();
  const put = (c, role, acting) => {
    if (!c || !c.id || (c.media_type !== 'movie' && c.media_type !== 'tv') || c.adult) return;
    const k = c.media_type + c.id;
    let e = by.get(k);
    if (!e) { e = { id: c.id, type: c.media_type, title: str(c.title || c.name, 160), year: yearOf(c.release_date || c.first_air_date), poster: img(c.poster_path, 'w185'), roles: [], jobs: [], n: 0, pop: (c.vote_count || 0) + (c.popularity || 0) * 5, acting: false }; by.set(k, e); }
    if (acting) { e.acting = true; if (role && !e.roles.includes(role)) e.roles.push(role); if (c.episode_count) e.n = Math.max(e.n, c.episode_count); } else if (role && !e.jobs.includes(role)) e.jobs.push(role);
  };
  for (const c of cc.cast || []) put(c, str(c.character, 80).replace(/\s*\((voice|uncredited)\)\s*$/i, ''), true);
  for (const c of cc.crew || []) put(c, str(c.job, 40), false);
  // (Talk shows and award nights they were a guest on aren't their work: "Self" in something they had no other part in.)
  const out = [...by.values()].filter((e) => e.title && !(e.acting && !e.jobs.length && e.roles.length && e.roles.every((r) => /^(self|himself|herself|themselves)\b/i.test(r)) && e.type === 'tv'));
  for (const e of out) { e.as = [e.roles.slice(0, 2).join(' / '), e.jobs.slice(0, 3).join(', ')].filter(Boolean).join(' · '); delete e.roles; delete e.jobs; delete e.acting; }
  return out;
}
function shapePerson(j) {
  const ext = j.external_ids || {};
  return {
    id: j.id, name: str(j.name, 100), img: img(j.profile_path, 'h632'), bio: plainText(j.biography).slice(0, 4000), born: str(j.birthday, 10), died: str(j.deathday, 10), place: str(j.place_of_birth, 100),
    dept: { Acting: 'Actor', Directing: 'Director', Writing: 'Writer', Production: 'Producer', Sound: 'Composer', Camera: 'Cinematographer', Editing: 'Editor', Creator: 'Creator' }[j.known_for_department] || '',
    imdb: /^nm\d{5,10}$/.test(String(ext.imdb_id || j.imdb_id || '')) ? String(ext.imdb_id || j.imdb_id) : '', adult: !!j.adult,
  };
}

// ---------------------------------------------------------------- a series' episodes in another order
const ORDER_KIND = { 1: 'As first shown', 2: 'Numbered straight through', 3: 'DVD order', 4: 'Digital release order', 5: 'By story arc', 6: 'Production order', 7: 'TV order' };
/** TMDB's "episode groups" of a series → [{ id, name, kind, seasons, episodes, note }], the fullest first. */
function shapeOrders(j) {
  return ((j && j.results) || []).filter((g) => g && /^[0-9a-f]{24}$/i.test(String(g.id)) && g.episode_count > 0)
    .map((g) => ({ id: String(g.id), name: str(g.name, 80), kind: ORDER_KIND[g.type] || 'Another order', seasons: g.group_count || 0, episodes: g.episode_count || 0, note: str(g.description, 240) }))
    .sort((a, b) => b.episodes - a.episodes).slice(0, 12);
}
/**
 * One episode group as the seasons map lib/tmdb.js keeps: { season: { episode: [title, plot, still, air date,
 * minutes, rating, season as first shown, episode as first shown] } }. A group named "Season 3" is season 3,
 * "Specials" is 0; otherwise the groups count 1, 2, 3 … in their order.
 */
function seasonsOfGroup(j, still) {
  const groups = ((j && j.groups) || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const named = groups.map((g) => { const m = /(?:season|series|saison|staffel|temporada)\s*(\d{1,3})\b/i.exec(g.name || ''); return m ? +m[1] : /special|extras|ova\b/i.test(g.name || '') ? 0 : null; });
  const useNames = named.filter((n) => n !== null).length === groups.length && new Set(named).size === groups.length;
  const out = {};
  let next = 1;
  groups.forEach((g, i) => {
    const sn = useNames ? named[i] : named[i] === 0 && !out[0] ? 0 : next++;
    const se = {};
    (g.episodes || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0)).forEach((e, n) => {
      se[n + 1] = [e.name || '', String(e.overview || '').slice(0, 700), still(e.still_path), e.air_date || '', e.runtime || 0, e.vote_average ? Math.round(e.vote_average * 10) / 10 : 0, Number.isInteger(e.season_number) ? e.season_number : null, Number.isInteger(e.episode_number) ? e.episode_number : null];
    });
    if (Object.keys(se).length) out[sn] = se;
  });
  return out;
}

// ---------------------------------------------------------------- a Home row made by choosing (TMDB's "discover")
const SORTS = { popular: 'popularity.desc', rated: 'vote_average.desc', newest: { movie: 'primary_release_date.desc', tv: 'first_air_date.desc' } };
/**
 * What someone chose for a row → { type, params (for /discover/…), name }.
 * choice: { type: 'movie'|'tv', genres: [id], from, to (years), stars (least, of 10), lang ('ko'), service (provider
 * id), sort: 'popular'|'rated'|'newest' } — names: { genres: Map(id → name), services: Map(id → name), langName(code) }.
 */
function discoverOf(choice, region, names = {}) {
  const c = choice || {};
  const type = c.type === 'tv' ? 'tv' : 'movie';
  const p = { include_adult: 'false' };
  const said = [];
  const genres = [...new Set((Array.isArray(c.genres) ? c.genres : []).map(Number).filter((n) => n > 0 && n < 100000))].slice(0, 4);
  if (genres.length) { p.with_genres = genres.join(','); said.push(genres.map((g) => (names.genres && names.genres.get(g)) || 'genre ' + g).join(' + ')); }
  said.push(type === 'tv' ? 'series' : 'films');
  const yr = (v) => { const n = parseInt(v, 10); return n >= 1900 && n <= 2100 ? n : 0; };
  const from = yr(c.from), to = yr(c.to);
  const dk = type === 'tv' ? 'first_air_date' : 'primary_release_date';
  if (from) p[dk + '.gte'] = `${from}-01-01`;
  if (to) p[dk + '.lte'] = `${to}-12-31`;
  if (from && to) said.push(from === to ? `from ${from}` : `${from}–${to}`); else if (from) said.push(`since ${from}`); else if (to) said.push(`up to ${to}`);
  const stars = Math.round(Number(c.stars) * 10) / 10;
  if (stars >= 1 && stars <= 9.5) { p['vote_average.gte'] = String(stars); p['vote_count.gte'] = '80'; said.push(`rated ${stars}+`); }
  if (/^[a-z]{2}$/.test(String(c.lang || ''))) { p.with_original_language = c.lang; said.push(`in ${(names.langName && names.langName(c.lang)) || c.lang}`); }
  const service = Number(c.service);
  if (service > 0 && service < 100000) { p.with_watch_providers = String(service); p.watch_region = /^[A-Z]{2}$/.test(String(region || '')) ? region : 'US'; said.push(`on ${(names.services && names.services.get(service)) || 'a streaming service'}`); }
  const sort = SORTS[c.sort] ? c.sort : 'popular';
  p.sort_by = typeof SORTS[sort] === 'string' ? SORTS[sort] : SORTS[sort][type];
  // (Best rated: not a film three people gave ten. Newest: not ones still to come.)
  if (sort === 'rated' && !p['vote_count.gte']) p['vote_count.gte'] = '200';
  if (sort === 'newest' && !to) p[dk + '.lte'] = new Date().toISOString().slice(0, 10);
  const lead = { popular: '', rated: 'Best-rated ', newest: 'Newest ' }[sort];
  let name = lead + said.join(' ');
  name = name.charAt(0).toUpperCase() + name.slice(1);
  return { type, params: p, name: name.slice(0, 120) };
}
/** A row's choice kept as one line of text (its id), and back: only what discoverOf understands survives. */
function packChoice(c) {
  const o = {};
  if (c.type === 'tv') o.type = 'tv';
  const g = [...new Set((Array.isArray(c.genres) ? c.genres : []).map(Number).filter((n) => n > 0 && n < 100000))].slice(0, 4).sort((a, b) => a - b);
  if (g.length) o.genres = g;
  for (const k of ['from', 'to']) { const n = parseInt(c[k], 10); if (n >= 1900 && n <= 2100) o[k] = n; }
  const st = Math.round(Number(c.stars) * 10) / 10; if (st >= 1 && st <= 9.5) o.stars = st;
  if (/^[a-z]{2}$/.test(String(c.lang || ''))) o.lang = c.lang;
  const sv = Number(c.service); if (sv > 0 && sv < 100000) o.service = sv;
  if (c.sort === 'rated' || c.sort === 'newest') o.sort = c.sort;
  return JSON.stringify(o);
}
const unpackChoice = (s) => { try { const o = JSON.parse(String(s)); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } };

class TmdbMore {
  /** deps: { tmdb, level(cert) → 0…4 | -1 } */
  constructor({ tmdb, level }) { this.tmdb = tmdb; this.level = level || (() => 0); }

  /** What TMDB is asked for a title's page: { p, params } (the same for every copy of the title). */
  titleReq(mt) {
    const lang = String(this.tmdb.getLang() || 'en').slice(0, 2);
    const extra = mt.type === 'movie' ? 'credits,release_dates,images,external_ids,reviews,alternative_titles' : 'aggregate_credits,content_ratings,images,external_ids,reviews,alternative_titles';
    return { p: `/${mt.type}/${mt.id}`, params: { append_to_response: extra, include_image_language: [...new Set([lang, 'en', 'null'])].join(',') }, lang };
  }
  /** Is a title's page already saved here? → { have, bytes } (matched titles only: no looking anything up). */
  async saved(it) {
    const mt = it && this.tmdb.map.data.m[it.k];
    if (!mt || !mt.id || !mt.type) return { have: false, bytes: 0, unmatched: true };
    const r = this.titleReq(mt);
    try { const st = await require('fs').promises.stat(this.tmdb.cacheFile(r.p, r.params)); return { have: st.size > 2, bytes: st.size }; } catch { return { have: false, bytes: 0 }; }
  }

  /**
   * A title's page, or null (no key, not matched). What is saved is given at once; when that is older than a day,
   * TMDB is asked again behind it for next time. Only a title never opened (or fetched ahead) waits for TMDB.
   * opts.size: also how big TMDB's answer was (out.bytes), for the job that fetches many ahead.
   */
  async title(it, opts = {}) {
    const t = this.tmdb;
    if (!t.enabled() || !it || (it.t !== 'movie' && it.t !== 'show')) return null;
    const mt = await t.match(it);
    if (!mt || !mt.id) return null;
    const { p, params, lang } = this.titleReq(mt);
    const j = await t.getSoft(p, params, 86400e3);
    if (!j || !j.id) return null;
    const out = shapeTitle(j, { type: mt.type, lang, region: t.getRegion(), level: this.level });
    if (opts.size) out.bytes = Buffer.byteLength(JSON.stringify(j));
    // What was found out is kept with the title's details, for what needs it without a page being open: subtitle
    // searches (the IMDb number, its other names), and parental limits (a rating, where there was none).
    const m = t.meta.data.m[it.k];
    if (m && m.tmdb === mt.id) {
      let ch = false;
      if (out.imdb && m.im !== out.imdb) { m.im = out.imdb; ch = true; }
      if (out.aka.length && JSON.stringify(m.aka || []) !== JSON.stringify(out.aka.slice(0, 10))) { m.aka = out.aka.slice(0, 10); ch = true; }
      if (out.cert && !m.c) { m.c = out.cert; ch = true; out.certNew = true; }
      if (ch) t.meta.save();
    }
    return out;
  }

  /** A person by TMDB number → { …shapePerson, credits: [...] } or null. */
  async person(id) {
    const t = this.tmdb;
    if (!t.enabled() || !(Number(id) > 0)) return null;
    const j = await t.getSoft(`/person/${Number(id)}`, { append_to_response: 'combined_credits,external_ids' }, 86400e3);
    if (!j || !j.id) return null;
    return { ...shapePerson(j), credits: creditsOfPerson(j) };
  }

  /**
   * The person a name means: of TMDB's people by that name, the one with the most work in the household's lists
   * (has(type, id) → is that title here?), then the best known. → TMDB number, or 0.
   */
  async findPerson(name, has) {
    const t = this.tmdb;
    const q = String(name || '').trim().slice(0, 80);
    if (!t.enabled() || q.length < 3) return 0;
    const j = await t.get('/search/person', { query: q, include_adult: 'false' }, TTL);
    const same = (a, b) => String(a || '').toLowerCase().replace(/[^a-z0-9]+/g, '') === String(b || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    let best = null;
    for (const r of ((j && j.results) || []).slice(0, 10)) {
      if (!r || !r.id || r.adult) continue;
      const here = (r.known_for || []).filter((k) => k && has(k.media_type, k.id)).length;
      const score = here * 100 + (same(r.name, q) ? 50 : 0) + Math.min(40, r.popularity || 0);
      if (!best || score > best.score) best = { id: r.id, score };
    }
    return best ? best.id : 0;
  }

  /** The orders a series' episodes can be shown in (besides TMDB's own). */
  async orders(it) {
    const t = this.tmdb;
    if (!t.enabled() || !it || it.t !== 'show') return [];
    const mt = await t.match(it);
    if (!mt || !mt.id || mt.type !== 'tv') return [];
    return shapeOrders(await t.get(`/tv/${mt.id}/episode_groups`, {}, TTL));
  }

  /** Genres and (for a country) streaming services, with their TMDB numbers, to build a row from. */
  async options(region) {
    const t = this.tmdb;
    const rg = /^[A-Z]{2}$/.test(String(region || '')) ? region : 'US';
    const out = { genres: { movie: [], tv: [] }, services: [], region: rg };
    for (const type of ['movie', 'tv']) {
      const g = await t.get(`/genre/${type}/list`, {}, 30 * 86400e3).catch(() => null);
      out.genres[type] = ((g && g.genres) || []).filter((x) => x && x.id && x.name).map((x) => ({ id: x.id, name: str(x.name, 40) }));
    }
    const seen = new Set();
    for (const type of ['movie', 'tv']) {
      const p = await t.get(`/watch/providers/${type}`, { watch_region: rg }, 30 * 86400e3).catch(() => null);
      for (const x of ((p && p.results) || []).slice().sort((a, b) => ((a.display_priorities || {})[rg] ?? a.display_priority ?? 999) - ((b.display_priorities || {})[rg] ?? b.display_priority ?? 999))) {
        if (!x || !x.provider_id || !x.provider_name || seen.has(x.provider_id) || / (amazon|apple tv|roku premium) channel$/i.test(x.provider_name)) continue;
        seen.add(x.provider_id);
        out.services.push({ id: x.provider_id, name: str(x.provider_name, 50) });
      }
    }
    out.services = out.services.slice(0, 40);
    return out;
  }
}

module.exports = { TmdbMore, shapeTitle, shapePerson, creditsOfPerson, creditsOf, shapeOrders, seasonsOfGroup, pickCert, ratingsOf, logoOf, datesOf, reviewsOf, akaOf, discoverOf, packChoice, unpackChoice, IMG };
