'use strict';
/**
 * Reads a watchlist someone exported from another service into titles for the wishlist (lib/wishlist.js):
 *
 *   Letterboxd   Settings → Data → Export: watchlist.csv (Date,Name,Year,Letterboxd URI) — and its other files with
 *                the same columns (watched.csv, a list's own export, which has a few lines about the list first).
 *                Letterboxd is films only.
 *   IMDb         a list's or the watchlist's Export: Const (tt…), Title, Title Type, Year and more.
 *   anything     a CSV with a Title (or Name) column, and Year and Type columns if it has them.
 *
 * Only the file is read: nothing is fetched from those services.
 */

/** CSV text → rows of cells (quoted cells, "" for a quote, commas and line breaks inside quotes, CRLF, a BOM). */
function parseCsv(text, maxRows = 5000) {
  const s = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      if (rows.length >= maxRows) return rows;
    } else cell += c;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

const key = (h) => String(h || '').toLowerCase().replace(/[^a-z]/g, '');
/** IMDb's and others' words for what a title is → 'movie' | 'show' | '' (not something a wishlist holds). */
function kindOf(v) {
  const t = key(v);
  if (!t) return 'movie';
  if (/^(tvseries|tvminiseries|series|show|tvshow|tv|miniseries|tvspecial)$/.test(t)) return t === 'tvspecial' ? 'movie' : 'show';
  if (/^(movie|film|feature|tvmovie|video|short|tvshort|documentary)$/.test(t)) return 'movie';
  return ''; // an episode, a game, a podcast…
}

/**
 * text → { format: 'letterboxd' | 'imdb' | 'csv', entries: [{ t, n, y, imdb? }], skipped }
 * Throws an Error with a message for the person when it isn't a list of titles.
 */
function parseWatchlist(text, { max = 2000 } = {}) {
  const rows = parseCsv(text, max + 20);
  // The header: the first of the first few lines with a title column (a Letterboxd list starts with lines about the list).
  // (One with a Year column too wins over an earlier one without: that earlier one describes the list itself.)
  let at = -1, cols = null;
  const titleCol = (h) => (h.indexOf('title') >= 0 ? h.indexOf('title') : h.indexOf('name'));
  const heads = [];
  for (let i = 0; i < Math.min(rows.length, 12); i++) { const h = rows[i].map(key); if (titleCol(h) >= 0 && rows[i].length >= 2) heads.push({ i, h }); }
  const pick = heads.find((x) => x.h.indexOf('year') >= 0) || heads[0];
  if (pick) {
    const h = pick.h, i = pick.i, title = titleCol(h);
    at = i;
    cols = { title, year: h.indexOf('year'), type: h.indexOf('titletype') >= 0 ? h.indexOf('titletype') : h.indexOf('type'), imdb: h.indexOf('const') >= 0 ? h.indexOf('const') : h.indexOf('imdbid'), uri: h.findIndex((x) => x === 'letterboxduri' || x === 'url') };
  }
  if (at < 0) throw new Error('That doesn’t look like an exported list: it needs a line of column names with “Title” or “Name” in it. Letterboxd’s watchlist.csv and IMDb’s list export both work.');
  const head = rows[at].map(key);
  const format = cols.imdb >= 0 && head.indexOf('const') >= 0 ? 'imdb' : head.indexOf('letterboxduri') >= 0 || rows.slice(at + 1, at + 6).some((r) => /letterboxd\.com|boxd\.it/.test(r.join(' '))) ? 'letterboxd' : 'csv';
  const entries = [], seen = new Set();
  let skipped = 0;
  for (const r of rows.slice(at + 1)) {
    const n = String(r[cols.title] || '').trim().slice(0, 200);
    if (!n) { skipped++; continue; }
    const t = cols.type >= 0 ? kindOf(r[cols.type]) : 'movie';
    if (!t) { skipped++; continue; }
    const y = cols.year >= 0 ? parseInt(String(r[cols.year] || '').slice(0, 4), 10) || 0 : 0;
    const imdb = cols.imdb >= 0 && /^tt\d{5,10}$/.test(String(r[cols.imdb] || '').trim()) ? String(r[cols.imdb]).trim() : '';
    const id = imdb || t + '|' + n.toLowerCase() + '|' + y;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(imdb ? { t, n, y, imdb } : { t, n, y });
    if (entries.length >= max) break;
  }
  if (!entries.length) throw new Error('No titles were found in that file.');
  return { format, entries, skipped };
}

module.exports = { parseCsv, parseWatchlist };
