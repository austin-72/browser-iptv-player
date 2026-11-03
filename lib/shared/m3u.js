/* Playlist formats: M3U/M3U8 (extended or plain), PLS, XSPF, ASX, JSON, plain URL lists,
   and single HLS streams. Handles encodings, relative/local addresses, headers, DRM and catch-up info. */
'use strict';

/** Decodes playlist bytes: BOM-aware UTF-8/UTF-16, falling back to Windows-1252 for legacy files. */
V.decodeText = (buf) => {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  // UTF-16 without a BOM: lots of zero bytes in alternating positions.
  const n = Math.min(u8.length, 400);
  let evenZero = 0, oddZero = 0;
  for (let i = 0; i < n; i++) if (u8[i] === 0) { if (i % 2) oddZero++; else evenZero++; }
  if (n > 8 && oddZero > n / 4 && evenZero < n / 50) return new TextDecoder('utf-16le').decode(u8);
  if (n > 8 && evenZero > n / 4 && oddZero < n / 50) return new TextDecoder('utf-16be').decode(u8);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { return new TextDecoder('windows-1252').decode(u8); }
};

V.m3u = (() => {
  // (Names are short: a cap keeps an 80 KB line without "=" from taking seconds.)
  const ATTR = /([A-Za-z0-9_:.-]{1,64})\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,"']+))/g;
  const VIDEO_FILE = /\.(mp4|m4v|mkv|avi|mov|webm|wmv|flv|mpg|mpeg|divx|3gp|ogv|vob)(\?|$)/i;
  const AUDIO_FILE = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|wma)(\?|$)/i;
  const EPISODE = /^(.*?)[\s._-]*\bS(\d{1,2})\s*[ ._-]?\s*E(\d{1,4})\b\s*[-–:.]?\s*(.*)$/i;
  const HEADER_NAMES = { 'user-agent': 'User-Agent', referer: 'Referer', referrer: 'Referer', origin: 'Origin', cookie: 'Cookie', authorization: 'Authorization' };

  function attrs(s) {
    const out = {};
    ATTR.lastIndex = 0;
    let m;
    while ((m = ATTR.exec(s))) out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    return out;
  }
  function splitExtinf(body) {
    // (Commas inside quoted values don't count. A single quote only opens a value right after "=", so an
    // apostrophe elsewhere — Bob's — isn't taken for one.)
    let q = '';
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (q) { if (c === q) q = ''; }
      else if (c === '"') q = c;
      else if (c === "'" && /=\s*$/.test(body.slice(Math.max(0, i - 8), i))) q = c;
      else if (c === ',') return [body.slice(0, i), body.slice(i + 1)];
    }
    return [body, ''];
  }
  const headerName = (k) => HEADER_NAMES[k.toLowerCase()] || k.replace(/(^|-)([a-z])/g, (_, a, b) => a + b.toUpperCase());
  function addHeaders(target, params) {
    for (const [k, v] of params) {
      const key = k.trim();
      if (!key || !/^[A-Za-z0-9-]+$/.test(key) || v == null) continue;
      target[headerName(key)] = String(v);
    }
  }

  /** Makes an entry address usable: absolute URL, resolved relative path, or file:// for local paths. */
  function resolve(line, base) {
    let u = line.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return { url: u };
    if (u.startsWith('//')) return { url: (base && base.startsWith('http:') ? 'http:' : 'https:') + u };
    if (/^[a-zA-Z]:[\\/]/.test(u)) return { url: 'file:///' + encodeURI(u.replace(/\\/g, '/')).replace(/#/g, '%23'), local: true };
    if (u.startsWith('\\\\')) return { url: 'file:' + encodeURI(u.replace(/\\/g, '/')).replace(/#/g, '%23'), local: true };
    if (base && /^https?:/i.test(base)) { try { return { url: new URL(u, base).href }; } catch {} }
    if (base && base.startsWith('file:')) { try { return { url: new URL(u.replace(/\\/g, '/'), base).href, local: true }; } catch {} }
    if (u.startsWith('/')) return { url: 'file://' + encodeURI(u).replace(/#/g, '%23'), local: true };
    return { url: u, relative: true };
  }

  function classify(url, name, duration, a) {
    const u = url.toLowerCase();
    if (a && /^(true|1)$/i.test(a.radio || '')) return 'radio';
    if (/\/series\//.test(u)) return 'series';
    if (/\/movie\//.test(u)) return 'movie';
    if (AUDIO_FILE.test(u)) return 'radio';
    if (VIDEO_FILE.test(u) || duration > 0) return EPISODE.test(name) ? 'series' : 'movie';
    return 'live';
  }

  /** Kodi inputstream.adaptive DRM → {type, keys|url, headers} */
  function drmFrom(props) {
    const type = (props['inputstream.adaptive.license_type'] || props['inputstream.adaptive.drm'] || '').toLowerCase();
    const key = props['inputstream.adaptive.license_key'] || '';
    if (!type && !key) return null;
    let t = /clearkey|org\.w3/.test(type) ? 'clearkey' : /widevine/.test(type) ? 'widevine' : /playready/.test(type) ? 'playready' : (key && /^[0-9a-f]{32}:[0-9a-f]{32}/i.test(key) ? 'clearkey' : type || 'unknown');
    const drm = { type: t };
    if (t === 'clearkey') {
      const keys = {};
      const b64hex = (s) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')); return [...b].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''); };
      if (key.trim().startsWith('{')) {
        try { for (const k of JSON.parse(key).keys || []) keys[b64hex(k.kid)] = b64hex(k.k); } catch {}
      } else if (/^https?:/i.test(key)) drm.url = key.split('|')[0];
      else for (const pair of key.split(',')) { const [kid, k] = pair.trim().split(':'); if (kid && k) keys[kid.toLowerCase()] = k.toLowerCase(); }
      if (Object.keys(keys).length) drm.keys = keys;
    } else if (key) {
      const [url, hdrs] = key.split('|');
      drm.url = url;
      if (hdrs) { drm.headers = {}; addHeaders(drm.headers, new URLSearchParams(hdrs)); }
    }
    return drm;
  }

  // ------------------------------------------------------------ M3U
  function parseM3U(text, base) {
    const lines = text.split(/\r\n|\r|\n/);
    const header = {};
    const items = [];
    let cur = null, grp = '', alb = '', art = '', opts = {}, props = {}, http = {}, name = '';
    let sawHeader = false, isHls = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXTM3U')) { sawHeader = true; Object.assign(header, attrs(line.slice(7))); continue; }
      if (line.startsWith('#EXT-X-TARGETDURATION') || line.startsWith('#EXT-X-STREAM-INF') || line.startsWith('#EXT-X-MEDIA-SEQUENCE')) isHls = true;
      if (line.startsWith('#EXTINF:') || line.startsWith('#EXTINF ')) {
        const [meta, title] = splitExtinf(line.slice(8));
        const dur = parseFloat(meta);
        cur = { duration: Number.isNaN(dur) ? -1 : dur, a: attrs(meta.replace(/^\s*-?\d+(\.\d+)?/, '')), title: title.trim() };
        continue;
      }
      if (line.startsWith('#PLAYLIST:')) { name = line.slice(10).trim(); continue; }
      if (line.startsWith('#EXTGRP:')) { grp = line.slice(8).trim(); continue; }
      if (line.startsWith('#EXTALB:')) { alb = line.slice(8).trim(); continue; }
      if (line.startsWith('#EXTART:')) { art = line.slice(8).trim(); continue; }
      if (line.startsWith('#EXTVLCOPT:')) {
        const kv = line.slice(11), i = kv.indexOf('=');
        if (i > 0) opts[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
        continue;
      }
      if (line.startsWith('#KODIPROP:')) {
        const kv = line.slice(10), i = kv.indexOf('=');
        if (i > 0) props[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
        continue;
      }
      if (line.startsWith('#EXTHTTP:')) {
        try { const j = JSON.parse(line.slice(9)); addHeaders(http, Object.entries(j)); } catch {}
        continue;
      }
      if (line.startsWith('#')) continue;
      // Not a comment: an address. Accept URLs, local paths, and relative paths that look like files.
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(line) && !/^(\/|[a-zA-Z]:[\\/]|\\\\|\.{1,2}[\\/])/.test(line) && !(/[\\/]/.test(line) || /\.[a-z0-9]{2,5}(\?|$)/i.test(line))) { cur = null; continue; }
      if (isHls) continue;

      const a = cur ? cur.a : {};
      let addr = line;
      const headers = {};
      const ua = opts['http-user-agent'] || a['user-agent'] || a['http-user-agent'];
      const ref = opts['http-referrer'] || opts['http-referer'] || a['http-referrer'] || a['http-referer'] || a.referrer || a.referer;
      if (ua) headers['User-Agent'] = ua;
      if (ref) headers.Referer = ref;
      if (opts['http-origin']) headers.Origin = opts['http-origin'];
      if (opts['http-cookie']) headers.Cookie = opts['http-cookie'];
      if (props['inputstream.adaptive.stream_headers']) addHeaders(headers, new URLSearchParams(props['inputstream.adaptive.stream_headers']));
      if (props['inputstream.adaptive.common_headers']) addHeaders(headers, new URLSearchParams(props['inputstream.adaptive.common_headers']));
      Object.assign(headers, http);
      const pipe = addr.indexOf('|');
      if (pipe > 0) { addHeaders(headers, new URLSearchParams(addr.slice(pipe + 1))); addr = addr.slice(0, pipe); }
      const r = resolve(addr, base);
      const url = r.url;
      const dur = cur ? cur.duration : -1;
      let title = (cur && cur.title) || a['tvg-name'] || '';
      if (!title) { try { title = decodeURIComponent(url.split(/[?#]/)[0].split(/[\\/]/).pop()) || url; } catch { title = url; } }
      // Catch-up: on when the channel (or the whole list) names a catch-up type, or the channel has its own
      // archive length / source. A list-wide catchup-days on its own only sets the default length.
      const catchupType = (a.catchup || a['catchup-type'] || header.catchup || header['catchup-type'] || '').toLowerCase();
      // (An archive length of 0 means none.)
      const entryDays = [a['catchup-days'], a.timeshift, a['tvg-rec']].find((v) => v && parseFloat(v) !== 0) || '';
      const catchupDays = parseFloat(entryDays || header['catchup-days'] || '') || 0;
      const catchupSource = a['catchup-source'] || header['catchup-source'] || '';
      const catchupOn = (catchupType && !/^(none|disabled|off|0|false)$/.test(catchupType)) || !!a['catchup-source'] || !!entryDays;
      const manifest = (props['inputstream.adaptive.manifest_type'] || '').toLowerCase();
      const e = {
        name: title,
        url,
        tvgId: a['tvg-id'] || a['tvg_id'] || '',
        tvgName: a['tvg-name'] || '',
        logo: a['tvg-logo'] || a.logo || a['tvg-logo-small'] || '',
        group: a['group-title'] || grp || alb || '',
        chno: a['tvg-chno'] || a['channel-number'] || a['tvg-num'] || a.channel_number || '',
        headers,
        duration: dur > 0 ? dur : 0,
        type: classify(url, title, dur, a),
        lang: a['tvg-language'] || '',
        country: a['tvg-country'] || '',
        shift: parseFloat(a['tvg-shift'] || header['tvg-shift'] || '') || 0,
        attrs: a,
      };
      if (art) e.artist = art;
      if (r.local) e.local = true;
      if (r.relative) e.relative = true;
      if (manifest === 'mpd' || manifest === 'dash') e.dash = true;
      const drm = drmFrom(props);
      if (drm) e.drm = drm;
      if (catchupOn) {
        e.catchup = { type: catchupType || (catchupSource ? (/^https?:/i.test(catchupSource) ? 'default' : 'append') : 'shift'), source: catchupSource, days: catchupDays || 7 };
      }
      items.push(e);
      cur = null; grp = ''; opts = {}; props = {}; http = {};
    }
    const epg = header['url-tvg'] || header['x-tvg-url'] || header['tvg-url'] || '';
    return { items, header, sawHeader, isHls, name, epgUrls: epg.split(/[,\s]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s)) };
  }

  // ------------------------------------------------------------ other formats
  const mk = (name, url, base, extra = {}) => {
    const r = resolve(url, base);
    return { name: name || url, url: r.url, tvgId: '', tvgName: '', logo: '', group: '', chno: '', headers: {}, duration: 0, type: classify(r.url, name || '', -1), lang: '', country: '', shift: 0, attrs: {}, ...(r.local ? { local: true } : {}), ...(r.relative ? { relative: true } : {}), ...extra };
  };

  function parsePLS(text, base) {
    const files = {}, titles = {}, lens = {};
    for (const l of text.split(/\r?\n/)) {
      const m = l.match(/^\s*(File|Title|Length)(\d+)\s*=\s*(.*)$/i);
      if (!m) continue;
      ({ file: files, title: titles, length: lens })[m[1].toLowerCase()][m[2]] = m[3].trim();
    }
    const items = Object.keys(files).sort((a, b) => a - b).map((n) => {
      const len = parseFloat(lens[n]);
      const e = mk(titles[n], files[n], base, { duration: len > 0 ? len : 0 });
      if (len > 0 && e.type === 'live') e.type = 'movie';
      return e;
    });
    return { items, epgUrls: [], sawHeader: true };
  }

  function parseXML(text, base) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('This XML playlist couldn’t be read.');
    const t = (el, sel) => { const x = el.querySelector(sel); return x ? x.textContent.trim() : ''; };
    const root = doc.documentElement.nodeName.toLowerCase();
    const items = [];
    if (root === 'playlist') { // XSPF
      for (const tr of doc.querySelectorAll('track')) {
        const loc = t(tr, 'location');
        if (!loc) continue;
        const dur = parseFloat(t(tr, 'duration')) / 1000;
        items.push(mk(t(tr, 'title') || '', loc, base, { logo: t(tr, 'image'), group: t(tr, 'album'), artist: t(tr, 'creator') || undefined, duration: dur > 0 ? dur : 0 }));
      }
      return { items, epgUrls: [], sawHeader: true, name: t(doc.documentElement, ':scope > title') };
    }
    if (root === 'asx') {
      for (const en of doc.querySelectorAll('entry')) {
        const ref = en.querySelector('ref');
        const href = ref && (ref.getAttribute('href') || ref.getAttribute('HREF'));
        if (href) items.push(mk(t(en, 'title'), href, base));
      }
      return { items, epgUrls: [], sawHeader: true };
    }
    throw new Error('This XML file isn’t a playlist (XSPF or ASX). If it’s a TV guide, add it under Settings → Guide.');
  }

  function parseJSON(text, base) {
    let j;
    try { j = JSON.parse(text); } catch { throw new Error('This JSON file couldn’t be read.'); }
    const list = Array.isArray(j) ? j : j.channels || j.items || j.streams || j.playlist || j.entries || (j.data && (Array.isArray(j.data) ? j.data : j.data.channels)) || [];
    const pick = (o, ...ks) => { for (const k of ks) if (o[k] != null && o[k] !== '') return Array.isArray(o[k]) ? o[k][0] : o[k]; return ''; };
    const items = [];
    for (const o of list) {
      if (!o || typeof o !== 'object') continue;
      let url = pick(o, 'url', 'stream', 'stream_url', 'streamUrl', 'link', 'src', 'source', 'file', 'uri');
      if (url && typeof url === 'object') url = url.url || url.src || '';
      if (!url) continue;
      const e = mk(String(pick(o, 'name', 'title', 'channel', 'label')), String(url), base, {
        logo: String(pick(o, 'logo', 'icon', 'tvg_logo', 'tvgLogo', 'image', 'thumbnail', 'poster') || ''),
        group: String(pick(o, 'group', 'group_title', 'groupTitle', 'category', 'categories', 'genre') || ''),
        tvgId: String(pick(o, 'tvg_id', 'tvgId', 'epg_id', 'epgId', 'id') || ''),
      });
      const ua = pick(o, 'user_agent', 'userAgent'), ref = pick(o, 'referrer', 'referer');
      if (ua) e.headers['User-Agent'] = String(ua);
      if (ref) e.headers.Referer = String(ref);
      items.push(e);
    }
    return { items, epgUrls: [], sawHeader: true };
  }

  /** Detects the format and parses it. `base` is the playlist's own address (for relative entries). */
  function parse(text, { base = '' } = {}) {
    const t = String(text).replace(/^﻿/, '');
    const head = t.slice(0, 600).trimStart();
    const lower = head.toLowerCase();
    let out;
    if (/^<!doctype html|^<html/.test(lower)) throw new Error('That address returned a web page, not a playlist. It may need a login, or the address may be wrong.');
    if (lower.startsWith('[playlist]')) out = { ...parsePLS(t, base), format: 'PLS' };
    else if (lower.startsWith('<')) out = { ...parseXML(t, base), format: /<asx/i.test(head) ? 'ASX' : 'XSPF' };
    else if (lower.startsWith('{') || lower.startsWith('[')) out = { ...parseJSON(t, base), format: 'JSON' };
    else {
      out = parseM3U(t, base);
      out.format = out.sawHeader ? 'M3U' : 'URL list';
      if (out.isHls) {
        // This is one HLS stream, not a list of channels.
        if (!/^https?:/i.test(base)) throw new Error('This is a single HLS stream, not a playlist. Add it by its web address instead.');
        let name = 'Stream';
        try { name = decodeURIComponent(new URL(base).pathname.split('/').filter(Boolean).slice(-2).join(' ')).replace(/\.m3u8?$/i, '') || name; } catch {}
        out = { items: [mk(name, base, '', { type: 'live' })], epgUrls: [], sawHeader: true, format: 'HLS stream', single: true };
      }
    }
    out.header = out.header || {};
    out.epgUrls = out.epgUrls || [];
    return out;
  }

  function episode(name) {
    const m = String(name).match(EPISODE);
    if (!m) return null;
    return { show: m[1].replace(/[\s._-]+$/, '').trim() || name, season: +m[2], episode: +m[3], title: m[4].trim() };
  }

  const q = (s) => String(s ?? '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
  function generate(entries, epgUrl) {
    const out = [`#EXTM3U${epgUrl ? ` url-tvg="${q(epgUrl)}"` : ''}`];
    for (const e of entries) {
      if (!e.url) continue;
      let ext = `#EXTINF:${e.duration || -1} tvg-id="${q(e.tvgId)}" tvg-name="${q(e.tvgName || e.name)}" tvg-logo="${q(e.logo)}"`;
      if (e.chno) ext += ` tvg-chno="${q(e.chno)}"`;
      if (e.shift) ext += ` tvg-shift="${e.shift}"`;
      if (e.type === 'radio') ext += ' radio="true"';
      if (e.catchup) ext += ` catchup="${q(e.catchup.type)}" catchup-days="${e.catchup.days}"${e.catchup.source ? ` catchup-source="${q(e.catchup.source)}"` : ''}`;
      out.push(`${ext} group-title="${q(e.group)}",${q(e.name)}`);
      const h = e.headers || {};
      if (h['User-Agent']) out.push(`#EXTVLCOPT:http-user-agent=${h['User-Agent']}`);
      if (h.Referer) out.push(`#EXTVLCOPT:http-referrer=${h.Referer}`);
      const rest = Object.fromEntries(Object.entries(h).filter(([k]) => k !== 'User-Agent' && k !== 'Referer'));
      if (Object.keys(rest).length) out.push(`#EXTHTTP:${JSON.stringify(rest)}`);
      if (e.drm) {
        out.push(`#KODIPROP:inputstream.adaptive.license_type=${e.drm.type === 'clearkey' ? 'clearkey' : e.drm.type === 'widevine' ? 'com.widevine.alpha' : e.drm.type}`);
        if (e.drm.keys) out.push(`#KODIPROP:inputstream.adaptive.license_key=${Object.entries(e.drm.keys).map(([k, v]) => `${k}:${v}`).join(',')}`);
        else if (e.drm.url) out.push(`#KODIPROP:inputstream.adaptive.license_key=${e.drm.url}`);
      }
      out.push(e.url);
    }
    return out.join('\n') + '\n';
  }

  return { parse, generate, episode, resolve };
})();
