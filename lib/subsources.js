'use strict';
/**
 * Free subtitle sources, used before OpenSubtitles (whose free plan allows 5 downloads a day):
 *  - SubDL (subdl.com): a free API key, 2,000 searches a day; downloads aren't counted against the key.
 *  - Gestdown (api.gestdown.info, a front end to Addic7ed): TV episodes only, no key.
 * Each returns [{ id, source, lang, name, hi, downloads, pack }] and fetches a file as SRT/VTT text.
 */
const { HttpError } = require('./util');
const { unzip } = require('./zip');
const { episodeOfName } = require('./subcheck');

const UA = 'SuperstationIPTV/2.5 (+subtitles)';
const BASES = () => ({
  subdl: process.env.SUBDL_BASE || 'https://api.subdl.com/api/v1',
  subdlDl: process.env.SUBDL_DL_BASE || 'https://dl.subdl.com',
  gestdown: process.env.GESTDOWN_BASE || 'https://api.gestdown.info',
});

// ---------------------------------------------------------------- languages
const CODES = ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'sv', 'da', 'no', 'nb', 'fi', 'is', 'pl', 'cs', 'sk', 'sl', 'hr', 'sr', 'bs', 'mk', 'bg', 'ro', 'hu', 'el', 'tr', 'ru', 'uk', 'be', 'lt', 'lv', 'et', 'ar', 'he', 'fa', 'ur', 'hi', 'bn', 'ta', 'te', 'ml', 'kn', 'mr', 'pa', 'gu', 'si', 'th', 'vi', 'id', 'ms', 'tl', 'zh', 'ja', 'ko', 'sq', 'hy', 'ka', 'az', 'kk', 'uz', 'eu', 'ca', 'gl', 'cy', 'ga', 'af', 'sw', 'am', 'my', 'km', 'lo', 'ne', 'mn'];
let byName = null;
const englishName = (code) => { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; } };
/** Whatever a source calls a language ("EN", "english", "Portuguese (Brazilian)", "pt-BR", "BR_PT") → "en". */
function langCode(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^br[_-]pt$/i.test(s)) return 'pt'; // SubDL's Brazilian Portuguese
  if (/^[a-z]{2}([-_][a-z]{2,4})?$/i.test(s)) return s.slice(0, 2).toLowerCase();
  if (!byName) {
    byName = new Map();
    for (const c of CODES) byName.set(englishName(c).toLowerCase(), c);
    for (const [n, c] of [['farsi', 'fa'], ['farsi/persian', 'fa'], ['brazilian portuguese', 'pt'], ['portuguese (brazilian)', 'pt'], ['brazillian portuguese', 'pt'], ['chinese bg code', 'zh'], ['big 5 code', 'zh'],
      ['chinese (simplified)', 'zh'], ['chinese (traditional)', 'zh'], ['serbian (latin)', 'sr'], ['serbian (cyrillic)', 'sr'], ['norwegian', 'no'], ['spanish (latin america)', 'es'], ['spanish (spain)', 'es'], ['french (canadian)', 'fr'], ['english (us)', 'en'], ['english (uk)', 'en']]) byName.set(n, c);
  }
  const low = s.toLowerCase();
  return byName.get(low) || byName.get(low.replace(/\s*\(.*\)$/, '')) || '';
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
const sameTitle = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.replace(/^the /, '') === y.replace(/^the /, '')); };

async function getJson(fetch, url, opts = {}) {
  let r;
  try { r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || 12000) }); } catch (e) { throw new HttpError(502, `${opts.name || 'The subtitle site'} didn’t answer (${(e.cause && e.cause.message) || e.message}).`); }
  if (r.status === 404) return null;
  const t = await r.text();
  let j = null;
  try { j = t ? JSON.parse(t) : null; } catch {}
  if (r.status === 429 || r.status === 423) { const e = new HttpError(429, `${opts.name || 'The subtitle site'} is busy; try again in a minute.`); e.busy = true; throw e; }
  if (!r.ok) throw new HttpError(502, `${opts.name || 'The subtitle site'} said ${r.status}${j && (j.error || j.message) ? ': ' + (j.error || j.message) : ''}.`);
  return j;
}
async function getBuffer(fetch, url, name, allowed) {
  let r;
  try {
    if (!allowed) r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    else {
      // (An address a viewer's request names — SubDL's file: every hop of a redirect must be one of its own too.)
      for (let hop = 0, u = url; ; hop++) {
        r = await fetch(u, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
        if (r.status < 300 || r.status >= 400 || !r.headers.get('location')) break;
        const to = allowed(new URL(r.headers.get('location'), u).toString());
        if (!to || hop >= 4) throw new Error('it sent the download somewhere else');
        u = to;
      }
    }
  } catch (e) { throw new HttpError(502, `Couldn’t download the subtitles from ${name} (${(e.cause && e.cause.message) || e.message}).`); }
  if (r.status === 429 || r.status === 423) throw new HttpError(429, `${name} is busy; try again in a minute.`);
  if (!r.ok) throw new HttpError(502, `Couldn’t download the subtitles from ${name} (${r.status}).`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 20 * 1024 * 1024) throw new HttpError(502, 'That subtitle file is too big.');
  return buf;
}

/**
 * A downloaded file → the subtitle text. Zips (SubDL) may hold a whole season: the episode's file is
 * picked by its SxxEyy / 1x02 name, otherwise the biggest subtitle file.
 */
/**
 * An .ass / .ssa subtitle file (styled subtitles — common for anime, and in some releases) as plain SRT: each line's
 * times and words, without its styling.
 */
function assToSrt(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  let fmt = null, n = 0;
  const out = [];
  const t = (x) => { const m = /^(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})$/.exec(String(x).trim()); if (!m) return null; const ms = Math.round(Number('0.' + m[4]) * 1000); return `${String(m[1]).padStart(2, '0')}:${m[2].padStart(2, '0')}:${m[3].padStart(2, '0')},${String(ms).padStart(3, '0')}`; };
  for (const l of lines) {
    if (/^Format:/i.test(l) && /Text\s*$/i.test(l)) fmt = l.slice(7).split(',').map((x) => x.trim().toLowerCase());
    else if (/^Dialogue:/i.test(l) && fmt) {
      const parts = l.slice(9).split(',');
      const text2 = parts.slice(fmt.length - 1).join(',');
      const a = t(parts[fmt.indexOf('start')]), b = t(parts[fmt.indexOf('end')]);
      const words = text2.replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ').replace(/[ \t]*\n[ \t\n]*/g, '\n').trim(); // (no blank line inside a cue: it would end it)
      if (a && b && words) out.push(`${++n}\n${a} --> ${b}\n${words}\n`);
    }
  }
  return out.join('\n');
}

/** A file in a season's zip that is no episode's subtitles: forced / foreign-parts-only ones, notes, samples. */
const sideFile = (name) => /(^|[^a-z])(forced|foreign|non[ ._-]?english|signs?|songs?|sample|readme|info)(?![a-z])/i.test(name);
const discPart = (name) => { const m = /(^|[^a-z0-9])(?:cd|dis[ck])[ ._-]?([1-4])(?![0-9a-z])/i.exec(name); return m ? +m[2] : 0; };
const noEpisode = (episode, n) => { const e = new HttpError(502, `That season pack has no file for episode ${episode}${n ? ` (${n} files, none of them it)` : ''}.`); e.noEpisode = true; return e; };

/**
 * Which file in a zip is this episode's. Season packs name their files every which way — "Show.S02E05.x.srt",
 * "2x05", "Episode 5", "05 Breakage.en.srt", "Show - 05 [720p].srt", or just the episode's title — so each is tried
 * in turn. A pack in which no file can be told to be the episode is refused (the biggest file used to be taken: in
 * a pack whose files are "01 Title.srt" … "13 Title.srt" that was always the longest episode of the season, whatever
 * was playing).
 */
function pickEpisode(files, season, episode, title) {
  const base = (f) => f.name.split('/').pop();
  const best = (list) => list.slice().sort((a, b) => (sideFile(base(a)) - sideFile(base(b))) || (b.data.length - a.data.length))[0];
  // 1. Names that give a season and episode.
  const named = files.map((f) => ({ f, e: episodeOfName(base(f)) })).filter((x) => x.e && x.e.episode);
  const mine = named.filter((x) => x.e.season === season && (x.e.to ? episode >= x.e.episode && episode <= x.e.to : x.e.episode === episode)).map((x) => x.f);
  if (mine.length) return best(mine);
  if (files.length === 1) { if (named.length) throw noEpisode(episode, 0); return files[0]; }
  if (named.length >= Math.max(2, files.length / 2)) throw noEpisode(episode, files.length);
  // 2. "E05", "Ep 5", "Episode 05".
  const ep = new RegExp(`(^|[^a-z0-9])(e|ep|episode)[ ._-]?0*${episode}(?![0-9])`, 'i');
  const byE = files.filter((f) => ep.test(base(f)));
  if (byE.length) return best(byE);
  // 3. A number that counts through the files: what is left of each name once what they all start and end with is
  //    taken away begins with it ("05 Breakage.en.srt", "Show - 05 [720p].srt").
  const names = files.map((f) => base(f).replace(/\.(srt|vtt|ass|ssa)$/i, ''));
  let pre = names[0];
  for (const n of names) { let i = 0; while (i < pre.length && i < n.length && pre[i] === n[i]) i++; pre = pre.slice(0, i); }
  pre = pre.replace(/\d+$/, ''); // (a shared leading digit — "0" of 01…09 — belongs to the number)
  const nums = names.map((n) => { const m = /^\D{0,3}?(\d{1,3})(?![0-9])(?!p\b)/.exec(n.slice(pre.length)); return m ? +m[1] : null; });
  const counted = nums.filter((n) => n !== null);
  if (counted.length >= 2 && new Set(counted).size === counted.length && counted.length >= files.length * 0.6) {
    const i = nums.indexOf(episode);
    // ("00 Show, SEASON 2.srt": a note, not an episode.)
    if (i >= 0 && files[i].data.length > 2000) return files[i];
    throw noEpisode(episode, files.length);
  }
  // 4. The episode's own title in a file's name.
  const t = norm(title);
  if (t.length >= 4) {
    const hit = files.filter((f) => (' ' + norm(base(f).replace(/\.(srt|vtt|ass|ssa)$/i, '')) + ' ').includes(' ' + t + ' '));
    if (hit.length === 1) return hit[0];
  }
  throw noEpisode(episode, files.length);
}

function pickFromDownload(buf, { season, episode, title } = {}) {
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) return /^﻿?\[Script Info\]/i.test(buf.slice(0, 40).toString()) ? Buffer.from(assToSrt(buf.toString('utf8'))) : buf; // not a zip: the file itself
  const all = unzip(buf, { maxFiles: 500, maxBytes: 60 * 1024 * 1024 }).filter((f) => f.data.length > 20 && !/(^|\/)(\._|__MACOSX\/)/.test(f.name));
  let files = all.filter((f) => /\.(srt|vtt)$/i.test(f.name));
  // (Only styled .ass/.ssa ones in it: those, as plain subtitles.)
  if (!files.length) files = all.filter((f) => /\.(ass|ssa)$/i.test(f.name)).map((f) => ({ name: f.name, data: Buffer.from(assToSrt(f.data.toString('utf8'))) })).filter((f) => f.data.length > 20);
  if (!files.length) throw new HttpError(502, 'The download had no subtitles this player can show (.srt, .vtt, .ass and .ssa are used).');
  if (season && episode) return pickEpisode(files, season, episode, title).data;
  // A film: the whole thing in one file — not one disc of two, and not the foreign-parts-only file when there is a full one.
  const base = (f) => f.name.split('/').pop();
  const whole = files.filter((f) => !discPart(base(f)));
  if (!whole.length) throw new HttpError(502, 'Those subtitles are split in parts, for a copy of the film on several discs.');
  return whole.sort((a, b) => (sideFile(base(a)) - sideFile(base(b))) || (b.data.length - a.data.length))[0].data;
}

// ---------------------------------------------------------------- SubDL
class SubDL {
  constructor({ fetch, getKey }) { this.fetch = fetch; this.getKey = getKey; this.name = 'SubDL'; }
  enabled() { return !!this.getKey(); }
  /** q: { tmdb, parentTmdb, imdb, query, year, season, episode, langs } */
  async search(q) {
    const B = BASES();
    // (releases / comment: every release name a file is said to fit, and what its uploader wrote — what the listing is
    // read from, lib/subnames.js. No "hi": that asks for ONLY the ones ticked hearing-impaired.)
    const p = new URLSearchParams({ api_key: this.getKey(), subs_per_page: '30', releases: '1', comment: '1' });
    const langs = (q.langs || []).map((l) => (String(l).toLowerCase() === 'pt-br' ? 'BR_PT' : String(l).slice(0, 2).toUpperCase())).filter(Boolean);
    if (langs.length) p.set('languages', [...new Set(langs)].join(','));
    if (q.season) {
      p.set('type', 'tv');
      if (q.parentTmdb) p.set('tmdb_id', String(q.parentTmdb)); else if (q.query) p.set('film_name', q.query); else return [];
      p.set('season_number', String(q.season));
      if (q.episode) p.set('episode_number', String(q.episode));
    } else {
      p.set('type', 'movie');
      if (q.tmdb) p.set('tmdb_id', String(q.tmdb));
      else if (q.imdb) p.set('imdb_id', /^tt/.test(q.imdb) ? q.imdb : 'tt' + q.imdb);
      else if (q.query) { p.set('film_name', q.query); if (q.year) p.set('year', String(q.year)); } else return [];
    }
    let byName = p.has('film_name');
    let j = await this._ask(`${B.subdl}/subtitles?${p}`);
    // (SubDL often doesn't have a title's TMDB number, or files it under another: asked again by name — and year,
    // for a film — before giving up.)
    if (!(j && j.subtitles && j.subtitles.length) && (p.has('tmdb_id') || p.has('imdb_id')) && q.query) {
      p.delete('tmdb_id'); p.delete('imdb_id');
      p.set('film_name', q.query);
      if (!q.season && q.year) p.set('year', String(q.year));
      byName = true;
      j = await this._ask(`${B.subdl}/subtitles?${p}`);
    }
    if (!j) return [];
    // Asked by name, SubDL answers with whatever it thinks the name means — one title, the first of several with
    // that name. Its answer says which: not ours (another number, another name, a film of another year), not used.
    if (byName) {
      const r = (j.results || [])[0];
      const id = q.season ? q.parentTmdb : q.tmdb;
      if (r && ((id && r.tmdb_id && String(r.tmdb_id) !== String(id)) || (r.name && !sameTitle(r.name, q.query) && !(id && String(r.tmdb_id) === String(id))) || (!q.season && q.year && r.year && Math.abs(r.year - q.year) > 1))) return [];
    }
    const only = langs.length === 1 ? langCode(langs[0]) : '';
    const out = [];
    for (const x of j.subtitles || []) {
      if (!x || !x.url) continue;
      const name = String(x.release_name || '').trim() || String(x.name || '').trim() || 'Subtitles';
      let pack = false;
      if (q.season) {
        if (x.season && +x.season !== +q.season) continue;
        const from = +x.episode_from || 0, end = +x.episode_end || 0;
        if (q.episode) {
          if (end > from && from && !(q.episode >= from && q.episode <= end)) continue; // episodes 1–7, and 9 was asked for
          // (A whole season — ticked as one, a range, or filed under an episode that isn't this one, as packs
          // sometimes are, under their first.)
          pack = !!x.full_season || end > from || !x.episode || +x.episode !== +q.episode;
        } else pack = true;
      }
      // (Its language as SubDL says it — "EN", or "english" — else, when one language was asked for, that one.)
      const lang = langCode(x.language) || langCode(x.lang) || only;
      if (!lang) continue;
      // (SubDL puts the account's key on each file's address; files download without it, and the id goes to browsers.)
      const url = String(x.url).split(/[?#]/)[0];
      out.push({
        id: `sd:${q.season || 0}:${q.episode || 0}:${url}`, source: 'subdl', lang, name, hi: !!x.hi, downloads: Number(x.downloads || x.download_count) || 0, pack,
        raw: { name, names: Array.isArray(x.releases) ? x.releases.slice(0, 12).map(String) : [], file: String(x.name || ''), comment: String(x.comment || ''), hi: !!x.hi, fps: x.fps || 0 },
      });
    }
    return out;
  }
  async _ask(url) {
    const j = await getJson(this.fetch, url, { name: 'SubDL' });
    if (j && j.status === false) {
      // "No subtitles found" and the like are just no results; anything else (a bad key, today's searches used up,
      // SubDL down) is said.
      if (!/not found|no (subtitle|result)|couldn.t find|can.t find/i.test(String(j.error || ''))) throw new HttpError(502, String(j.error || 'refused the search'));
      return null;
    }
    if (j && !Array.isArray(j.subtitles) && !j.status) throw new HttpError(502, 'SubDL gave an answer this player doesn’t understand.');
    return j;
  }
  async download(id, opts = {}) {
    const m = /^sd:(\d+):(\d+):(.+)$/.exec(id);
    const url = m && SubDL.fileUrl(m[3]);
    if (!url) throw new HttpError(400, 'That SubDL subtitle’s address isn’t one this player can fetch.');
    const buf = await getBuffer(this.fetch, url, 'SubDL', (u) => SubDL.fileUrl(u));
    return pickFromDownload(buf, { season: +m[1], episode: +m[2], title: opts.title });
  }
  /**
   * Where a subtitle's file is: SubDL gives a path on its download site ("/subtitle/3197651-3213944.zip"), or the
   * whole address. Only its own sites — nothing a search answer could point anywhere else. (Only paths of letters,
   * digits, "/", "." and "-" were taken before: anything else was "Bad subtitle".)
   */
  static fileUrl(u) {
    u = String(u || '').trim();
    if (/^https?:\/\//i.test(u)) {
      let x;
      try { x = new URL(u); } catch { return ''; }
      const base = new URL(BASES().subdlDl);
      // (Its own sites over https; plain http only for the configured download address itself.)
      const own = (x.hostname === base.hostname && x.port === base.port && x.protocol === base.protocol) || (/(^|\.)subdl\.com$/i.test(x.hostname) && x.protocol === 'https:');
      return own && !x.username && !x.password ? x.toString() : '';
    }
    let path = u;
    try { path = decodeURIComponent(u); } catch { try { path = decodeURI(u); } catch {} }
    if (!u.startsWith('/') || u.startsWith('//') || /(^|\/)\.\.(\/|$)|\\|[\r\n]/.test(u) || /(^|\/)\.\.(\/|$)|\\|[\r\n]/.test(path) || path.startsWith('//')) return '';
    try { path = decodeURI(u); } catch { path = u; }
    return BASES().subdlDl + encodeURI(path);
  }
}

// ---------------------------------------------------------------- Gestdown (Addic7ed)
class Gestdown {
  constructor({ fetch, isOn }) { this.fetch = fetch; this.isOn = isOn; this.name = 'Addic7ed (Gestdown)'; this.shows = new Map(); }
  enabled() { return this.isOn(); }
  async _show(q) {
    const key = norm(q.query) + '|' + (q.parentTmdb || '');
    const hit = this.shows.get(key);
    if (hit && Date.now() - hit.at < 24 * 3600e3) return hit.id;
    const j = await getJson(this.fetch, `${BASES().gestdown}/shows/search/${encodeURIComponent(q.query)}`, { name: 'Gestdown' });
    const shows = (j && j.shows) || [];
    const pick = (q.parentTmdb && shows.find((s) => String(s.tmdbId) === String(q.parentTmdb))) || shows.find((s) => sameTitle(s.name, q.query)) || (shows.length === 1 && !q.parentTmdb ? shows[0] : null);
    const id = pick ? pick.id : null;
    this.shows.set(key, { at: Date.now(), id });
    if (this.shows.size > 500) this.shows.delete(this.shows.keys().next().value);
    return id;
  }
  async search(q) {
    if (!q.season || !q.episode || !q.query || String(q.query).length < 3) return []; // TV episodes only
    const showId = await this._show(q);
    if (!showId) return [];
    const langs = [...new Set((q.langs || []).map((l) => String(l).slice(0, 2).toLowerCase()).filter(Boolean))].slice(0, 3);
    const one = async (lang) => {
      const j = await getJson(this.fetch, `${BASES().gestdown}/subtitles/get/${encodeURIComponent(showId)}/${q.season}/${q.episode}/${encodeURIComponent(englishName(lang))}`, { name: 'Gestdown' });
      return ((j && j.matchingSubtitles) || []).filter((s) => s && s.completed !== false && s.downloadUri).map((s) => ({
        id: `gd:${String(s.downloadUri).replace(/[^\w/-]/g, '')}`, source: 'gestdown', lang: langCode(s.language) || lang, name: s.version ? `${s.version}${s.hd ? ' (HD)' : ''}` : 'Subtitles',
        hi: !!s.hearingImpaired, downloads: Number(s.downloadCount) || 0,
        raw: { name: String(s.version || ''), hi: !!s.hearingImpaired },
      }));
    };
    return (await Promise.all(langs.map((l) => one(l).catch(() => [])))).flat();
  }
  async download(id) {
    const m = /^gd:(\/subtitles\/download\/[\w-]+)$/.exec(id);
    if (!m) throw new HttpError(400, 'Bad subtitle');
    return getBuffer(this.fetch, BASES().gestdown + m[1], 'Addic7ed (Gestdown)');
  }
}

module.exports = { SubDL, Gestdown, langCode, englishName, pickFromDownload, pickEpisode, sameTitle, assToSrt, norm };
