'use strict';
/**
 * Free subtitle sources, used before OpenSubtitles (whose free plan allows 5 downloads a day):
 *  - SubDL (subdl.com): a free API key, 2,000 searches a day; downloads aren't counted against the key.
 *  - Gestdown (api.gestdown.info, a front end to Addic7ed): TV episodes only, no key.
 * Each returns [{ id, source, lang, name, hi, downloads, pack }] and fetches a file as SRT/VTT text.
 */
const { HttpError } = require('./util');
const { unzip } = require('./zip');

const UA = 'SuperstationIPTV/2.3 (+subtitles)';
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

function pickFromDownload(buf, { season, episode } = {}) {
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) return /^\uFEFF?\[Script Info\]/i.test(buf.slice(0, 40).toString()) ? Buffer.from(assToSrt(buf.toString('utf8'))) : buf; // not a zip: the file itself
  const all = unzip(buf, { maxFiles: 500, maxBytes: 60 * 1024 * 1024 }).filter((f) => f.data.length > 20);
  let files = all.filter((f) => /\.(srt|vtt)$/i.test(f.name));
  // (Only styled .ass/.ssa ones in it: those, as plain subtitles.)
  if (!files.length) files = all.filter((f) => /\.(ass|ssa)$/i.test(f.name)).map((f) => ({ name: f.name, data: Buffer.from(assToSrt(f.data.toString('utf8'))) })).filter((f) => f.data.length > 20);
  if (!files.length) throw new HttpError(502, 'The download had no subtitles this player can show (.srt, .vtt, .ass and .ssa are used).');
  if (season && episode && files.length > 1) {
    const re = new RegExp(`(^|[^0-9])(s0*${season}[ ._-]*e0*${episode}|0*${season}x0*${episode})(?![0-9])`, 'i');
    const hit = files.find((f) => re.test(f.name.split('/').pop()));
    if (hit) return hit.data;
    const ep = new RegExp(`(^|[^0-9])e0*${episode}(?![0-9])`, 'i');
    const hit2 = files.find((f) => ep.test(f.name.split('/').pop()));
    if (hit2) return hit2.data;
  }
  return files.sort((a, b) => b.data.length - a.data.length)[0].data;
}

// ---------------------------------------------------------------- SubDL
class SubDL {
  constructor({ fetch, getKey }) { this.fetch = fetch; this.getKey = getKey; this.name = 'SubDL'; }
  enabled() { return !!this.getKey(); }
  /** q: { tmdb, parentTmdb, imdb, query, year, season, episode, langs } */
  async search(q) {
    const B = BASES();
    const p = new URLSearchParams({ api_key: this.getKey(), subs_per_page: '30' });
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
    let j = await this._ask(`${B.subdl}/subtitles?${p}`);
    // (SubDL often doesn't have a title's TMDB number, or files it under another: asked again by name — and year,
    // for a film — before giving up.)
    if (!(j && j.subtitles && j.subtitles.length) && (p.has('tmdb_id') || p.has('imdb_id')) && q.query) {
      p.delete('tmdb_id'); p.delete('imdb_id');
      p.set('film_name', q.query);
      if (!q.season && q.year) p.set('year', String(q.year));
      j = await this._ask(`${B.subdl}/subtitles?${p}`);
    }
    if (!j) return [];
    const only = langs.length === 1 ? langCode(langs[0]) : '';
    return (j.subtitles || []).filter((x) => x && x.url).map((x) => {
      const pack = !!(x.full_season || (q.season && !x.episode && x.episode_from !== q.episode));
      // (Its language as SubDL says it — "EN", or "english" — else, when one language was asked for, that one.)
      const lang = langCode(x.language) || langCode(x.lang) || only;
      return {
        id: `sd:${q.season || 0}:${q.episode || 0}:${x.url}`, source: 'subdl', lang, name: x.release_name || x.name || 'Subtitles',
        hi: !!x.hi, downloads: Number(x.downloads || x.download_count) || 0, pack,
      };
    }).filter((x) => x.lang);
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
  async download(id) {
    const m = /^sd:(\d+):(\d+):(.+)$/.exec(id);
    const url = m && SubDL.fileUrl(m[3]);
    if (!url) throw new HttpError(400, 'That SubDL subtitle’s address isn’t one this player can fetch.');
    const buf = await getBuffer(this.fetch, url, 'SubDL', (u) => SubDL.fileUrl(u));
    return pickFromDownload(buf, { season: +m[1], episode: +m[2] });
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

module.exports = { SubDL, Gestdown, langCode, englishName, pickFromDownload, sameTitle, assToSrt };
