'use strict';
/**
 * Subtitles from OpenSubtitles.com (REST API v1) for films and episodes that have none in the viewer's language.
 * The admin enters an API key (and optionally an account, which gives more downloads a day). Files are converted to
 * WebVTT and kept on disk (oldest dropped past a size limit), so a subtitle is only ever downloaded once.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpError, log } = require('./util');

const BASE = process.env.OPENSUBTITLES_BASE || 'https://api.opensubtitles.com/api/v1';
const UA = 'BrowserIPTVPlayer v2';
const MAX_FILES = 400, MAX_BYTES = 60 * 1024 * 1024;

/** SRT (or already-VTT) text → WebVTT. Handles BOMs, CRLF, "," millisecond separators and stray numbering. */
function srtToVtt(text) {
  let s = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (/^WEBVTT/.test(s)) return s + '\n';
  // Some files use '.' or ',' with fewer digits; normalise every timing line.
  s = s.replace(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g,
    (m, h1, m1, s1, f1, h2, m2, s2, f2) => `${h1.padStart(2, '0')}:${m1}:${s1}.${f1.padEnd(3, '0')} --> ${h2.padStart(2, '0')}:${m2}:${s2}.${f2.padEnd(3, '0')}`);
  const blocks = s.split(/\n{2,}/).map((b) => b.split('\n'));
  const out = ['WEBVTT', ''];
  for (const lines of blocks) {
    let i = 0;
    if (/^\d+$/.test((lines[0] || '').trim()) && /-->/.test(lines[1] || '')) i = 1; // the cue number
    if (!/-->/.test(lines[i] || '')) continue;
    // Strip SubStation-style tags ({\an8}) that browsers show literally; keep <i>, <b>, <u>.
    const textLines = lines.slice(i + 1).map((l) => l.replace(/\{\\[^}]*\}/g, '').replace(/<\/?font[^>]*>/gi, ''));
    out.push(lines[i].trim(), ...textLines, '');
  }
  return out.join('\n');
}

/** Decodes a downloaded file whatever its encoding: UTF-8 if valid, else Windows-1252 (the usual for old SRTs). */
function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {}
  try { return new TextDecoder('windows-1252').decode(buf); } catch { return buf.toString('latin1'); }
}

class OpenSubtitles {
  /** getConf() → { apiKey, username, password }; fetch: the app's fetch (honours outgoing proxies). */
  constructor({ dataDir, getConf, fetch, base = BASE }) {
    this.dir = path.join(dataDir, 'subtitles');
    fs.mkdirSync(this.dir, { recursive: true });
    this.getConf = getConf;
    this.fetch = fetch;
    this.base = base;
    this.searches = new Map(); // query → { at, list }
    this.token = null; // { value, at, base }
    this.quota = null; // { remaining, resetAt } from the last download
  }

  enabled() { const c = this.getConf() || {}; return !!c.apiKey; }

  async _req(p, { method = 'GET', body, auth = false, base } = {}) {
    const c = this.getConf() || {};
    if (!c.apiKey) throw new HttpError(400, 'Subtitles aren’t set up — the admin adds an OpenSubtitles API key in Admin → Integrations.');
    const headers = { 'Api-Key': c.apiKey, 'User-Agent': UA, Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (auth && this.token) headers.Authorization = `Bearer ${this.token.value}`;
    let r;
    try {
      r = await this.fetch((base || this.base) + p, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    } catch (e) { throw new HttpError(502, `OpenSubtitles didn’t answer (${(e.cause && e.cause.message) || e.message}).`); }
    let j = null;
    const t = await r.text();
    try { j = t ? JSON.parse(t) : null; } catch {}
    if (r.status === 401 || r.status === 403) throw new HttpError(502, 'OpenSubtitles turned down the API key or account. The admin can check it in Admin → Integrations.');
    if (r.status === 406 || r.status === 429) {
      const reset = j && (j.reset_time_utc || j.reset_time);
      const err = new HttpError(429, `Today’s subtitle downloads are used up${reset ? ` (more ${typeof reset === 'string' && /T/.test(reset) ? 'after ' + new Date(reset).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'in ' + reset})` : ''}. ${c.username ? '' : 'Adding an OpenSubtitles account in Admin → Integrations gives more a day.'}`.trim());
      err.quota = true;
      throw err;
    }
    if (!r.ok) throw new HttpError(502, `OpenSubtitles said ${r.status}${j && j.message ? ': ' + j.message : ''}.`);
    return j;
  }

  /** Signs in to the account (if one is set) for more downloads a day; kept for 12 hours. */
  async _login() {
    const c = this.getConf() || {};
    if (!c.username || !c.password) return;
    if (this.token && Date.now() - this.token.at < 12 * 3600e3 && this.token.user === c.username) return;
    const j = await this._req('/login', { method: 'POST', body: { username: c.username, password: c.password } });
    if (j && j.token) {
      // The login may name a different API host for this account (e.g. vip-api).
      const b = j.base_url ? `https://${String(j.base_url).replace(/^https?:\/\//, '').replace(/\/+$/, '')}/api/v1` : null;
      this.token = { value: j.token, at: Date.now(), user: c.username, base: this.base === 'https://api.opensubtitles.com/api/v1' ? b : null };
    }
  }

  /**
   * Finds subtitles. q: { tmdb, imdb, parentTmdb, parentImdb, query, year, season, episode, langs: ['en','fr'], hi }.
   * Returns [{ fileId, lang, name, downloads, hi, rating, fromTrusted, machine }] best first.
   */
  async search(q) {
    const params = new URLSearchParams();
    const langs = (q.langs || []).map((l) => String(l).slice(0, 2).toLowerCase()).filter(Boolean);
    if (langs.length) params.set('languages', [...new Set(langs)].sort().join(','));
    if (q.season) { // an episode: by the show's ids where known
      if (q.parentTmdb) params.set('parent_tmdb_id', String(q.parentTmdb));
      else if (q.parentImdb) params.set('parent_imdb_id', String(q.parentImdb).replace(/^tt/, ''));
      else if (q.query) params.set('query', q.query);
      params.set('season_number', String(q.season));
      if (q.episode) params.set('episode_number', String(q.episode));
    } else if (q.tmdb) params.set('tmdb_id', String(q.tmdb));
    else if (q.imdb) params.set('imdb_id', String(q.imdb).replace(/^tt/, ''));
    else if (q.query) { params.set('query', q.query); if (q.year) params.set('year', String(q.year)); }
    else throw new HttpError(400, 'Not enough to search with.');
    if (q.moviehash) params.set('moviehash', q.moviehash);
    // The API wants its parameters sorted and lower-case (it redirects otherwise).
    const qs = new URLSearchParams([...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))).toString();
    const hit = this.searches.get(qs);
    if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.list;
    const j = await this._req('/subtitles?' + qs);
    const list = ((j && j.data) || []).map((d) => {
      const a = d.attributes || {};
      const f = (a.files || [])[0] || {};
      return {
        fileId: f.file_id, lang: a.language || '', name: a.release || f.file_name || (a.feature_details && a.feature_details.title) || 'Subtitles',
        downloads: a.download_count || 0, hi: !!a.hearing_impaired, rating: a.ratings || 0, fromTrusted: !!a.from_trusted, machine: !!(a.machine_translated || a.ai_translated),
      };
    }).filter((x) => x.fileId);
    // Best first: the viewer's first language, real (not machine) translations, trusted uploaders, most downloaded.
    const order = langs;
    list.sort((a, b) => ((order.indexOf(a.lang.slice(0, 2)) + 99) % 99 - (order.indexOf(b.lang.slice(0, 2)) + 99) % 99) || (a.machine - b.machine) || ((!!q.hi === a.hi ? 0 : 1) - (!!q.hi === b.hi ? 0 : 1)) || (b.fromTrusted - a.fromTrusted) || (b.downloads - a.downloads));
    this.searches.set(qs, { at: Date.now(), list });
    if (this.searches.size > 300) this.searches.delete(this.searches.keys().next().value);
    return list;
  }

  file(fileId) { return path.join(this.dir, `${String(fileId).replace(/\D/g, '')}.vtt`); }
  has(fileId) { try { return fs.statSync(this.file(fileId)).size > 0; } catch { return false; } }

  /** Downloads one subtitle file (once), converts it to WebVTT and returns its path. */
  async download(fileId) {
    const id = String(fileId).replace(/\D/g, '');
    if (!id) throw new HttpError(400, 'Bad subtitle');
    const f = this.file(id);
    if (this.has(id)) { try { const now = new Date(); fs.utimesSync(f, now, now); } catch {} return f; }
    try { await this._login(); } catch (e) { log(`OpenSubtitles sign-in: ${e.message}`); }
    const j = await this._req('/download', { method: 'POST', body: { file_id: Number(id), sub_format: 'srt' }, auth: true, base: this.token && this.token.base });
    if (!j || !j.link) throw new HttpError(502, 'OpenSubtitles didn’t give a download link.');
    if (j.remaining !== undefined) this.quota = { remaining: j.remaining, resetAt: j.reset_time_utc || null, at: Date.now() };
    let r;
    try { r = await this.fetch(j.link, { signal: AbortSignal.timeout(30000) }); } catch (e) { throw new HttpError(502, `Couldn’t download the subtitles (${(e.cause && e.cause.message) || e.message}).`); }
    if (!r.ok) throw new HttpError(502, `Couldn’t download the subtitles (${r.status}).`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new HttpError(502, 'That subtitle file is too big.');
    const vtt = srtToVtt(decodeText(buf));
    const tmp = f + '.' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(tmp, vtt);
    fs.renameSync(tmp, f);
    this.prune();
    return f;
  }

  /** Keeps the cache within its limits: the least recently used files go first. */
  prune(maxFiles = MAX_FILES, maxBytes = MAX_BYTES) {
    let files;
    try { files = fs.readdirSync(this.dir).filter((x) => x.endsWith('.vtt')).map((x) => { const p = path.join(this.dir, x); const st = fs.statSync(p); return { p, size: st.size, at: st.mtimeMs }; }); } catch { return; }
    files.sort((a, b) => b.at - a.at);
    let total = 0;
    files.forEach((x, i) => { total += x.size; if (i >= maxFiles || total > maxBytes) { try { fs.unlinkSync(x.p); } catch {} } });
  }

  async test() { await this._req('/infos/formats'); try { await this._login(); } catch (e) { return { ok: true, account: false, error: e.message }; } return { ok: true, account: !!this.token }; }
}

module.exports = { OpenSubtitles, srtToVtt, decodeText };
