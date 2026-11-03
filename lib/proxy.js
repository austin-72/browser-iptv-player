'use strict';
const { fetchAny } = require('./net');
const crypto = require('crypto');
const { Readable } = require('stream');
const { HttpError } = require('./util');

/**
 * Stream relay. The browser talks only to the server; the server fetches the upstream stream with the
 * right User-Agent/Referer and relays it. This avoids CORS and mixed-content problems.
 * Only URLs that the server itself has signed can be relayed, so it can't be used as an open proxy.
 */
class Proxy {
  constructor(getSettings) {
    this.secret = crypto.randomBytes(32);
    this.getSettings = getSettings;
    this.sniffCache = new Map();
    this.firstByteMs = 30000; // a provider that hasn't started answering in this time gets a 504 (and the request is closed)
  }

  /** split: only the playlists come through here; the video segments are fetched by the browser from the provider. */
  sign(u, { ua, ref, raw, h, split } = {}) {
    const d = Buffer.from(JSON.stringify({ u, ua: ua || undefined, ref: ref || undefined, raw: raw ? 1 : undefined, h: h && Object.keys(h).length ? h : undefined, split: split ? 1 : undefined })).toString('base64url');
    const s = crypto.createHmac('sha256', this.secret).update(d).digest('base64url').slice(0, 32);
    return `/api/proxy?d=${d}&s=${s}`;
  }

  verify(d, s) {
    if (!d || !s) throw new HttpError(400, 'Missing signature');
    const expect = crypto.createHmac('sha256', this.secret).update(d).digest('base64url').slice(0, 32);
    if (s.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expect))) {
      throw new HttpError(403, 'Invalid or expired stream link (restart playback)');
    }
    return JSON.parse(Buffer.from(d, 'base64url').toString('utf8'));
  }

  /** Request headers for upstream: default User-Agent, then the stream's own (UA, Referer, Origin, Cookie…). */
  headers({ ua, ref, h: extra } = {}) {
    const h = { 'User-Agent': ua || this.getSettings().userAgent, Accept: '*/*' };
    if (ref) {
      h.Referer = ref;
      try { h.Origin = new URL(ref).origin; } catch {}
    }
    for (const [k, v] of Object.entries(extra || {})) {
      if (/^(host|content-length|connection|transfer-encoding|accept-encoding)$/i.test(k)) continue;
      h[k] = v;
    }
    return h;
  }

  /**
   * Works out what kind of stream a URL serves: 'hls', 'ts', 'native' (mp4/webm/audio), or 'ffmpeg'
   * (needs conversion, e.g. MKV), plus whether it's a finite file. Uses the file extension when it can, otherwise reads the first bytes.
   */
  /** Confirms a stream answers (HTTP 2xx and some data) within 10 seconds. */
  async check(url, hdr) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    try {
      const res = await fetchAny(url, { headers: this.headers(hdr), signal: ac.signal, redirect: 'follow' });
      if (!res.ok) throw new HttpError(502, `The stream server answered HTTP ${res.status}`);
      const reader = res.body.getReader();
      const { done } = await reader.read();
      if (done) throw new HttpError(502, 'The stream server sent nothing');
      return { ok: true };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `Could not reach the stream: ${err.name === 'AbortError' ? 'timed out' : (err.cause?.message || err.message)}`);
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
  }

  async sniff(url, hdr) {
    const ext = (url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    const e = ext ? ext.toLowerCase() : '';
    if (e === 'm3u8' || e === 'm3u') return { kind: 'hls' };
    if (e === 'mpd') return { kind: 'dash' };
    if (['mp4', 'm4v', 'webm', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'mov'].includes(e)) return { kind: 'native', finite: true };
    if (['mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'vob', 'divx'].includes(e)) return { kind: 'ffmpeg', finite: true };
    if (e === 'ts' || e === 'mts' || e === 'm2ts') return { kind: 'ts' };

    const cached = this.sniffCache.get(url);
    if (cached && Date.now() - cached.t < 10 * 60e3) return cached.result;
    let kind = 'ts';
    let finite = false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12000);
    try {
      const res = await fetchAny(url, { headers: this.headers(hdr), signal: ac.signal, redirect: 'follow' });
      if (!res.ok) throw new HttpError(502, `The stream server answered HTTP ${res.status}`);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      // A known length means a file (seekable video), not a never-ending live stream.
      finite = Number(res.headers.get('content-length')) > 0 || res.headers.get('accept-ranges') === 'bytes';
      const reader = res.body.getReader();
      let bytes = Buffer.alloc(0);
      while (bytes.length < 400) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes = Buffer.concat([bytes, Buffer.from(value)]);
      }
      const head = bytes.slice(0, 16).toString('latin1');
      const text = bytes.slice(0, 400).toString('latin1');
      if (ct.includes('dash+xml') || /<MPD[\s>]/.test(text)) kind = 'dash';
      else if (ct.includes('mpegurl') || head.replace(/^﻿|^ï»¿/, '').trimStart().startsWith('#EXTM3U')) kind = 'hls';
      else if (bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47)) kind = 'ts';
      else if (bytes.slice(4, 8).toString('latin1') === 'ftyp') kind = 'native';
      else if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) kind = ct.includes('webm') ? 'native' : 'ffmpeg';
      else if (/^(audio\/|video\/(mp4|webm|ogg))/.test(ct)) kind = 'native';
      else if (ct.includes('mp2t') || ct.includes('mpeg')) kind = 'ts';
      else kind = 'ffmpeg';
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `Could not reach the stream: ${err.name === 'AbortError' ? 'timed out' : (err.cause?.message || err.message)}`);
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
    const result = { kind, finite: finite && kind !== 'hls' };
    this.sniffCache.set(url, { result, t: Date.now() });
    return result;
  }

  rewritePlaylist(text, base, hdr, prefix = '') {
    const abs = (u) => { try { return new URL(u, base).href; } catch { return u; } };
    // Split mode: in a media playlist, segments (and init/partial segments) stay pointed at the provider.
    // Variant playlists, renditions and encryption keys (tiny, and often not browser-readable) still come through here.
    const direct = hdr && hdr.split && !/#EXT-X-STREAM-INF/i.test(text);
    return text.split(/\r?\n/).map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        if (!t.includes('URI="')) return line;
        const seg = direct && /^#EXT-X-(MAP|PART|PRELOAD-HINT)\b/i.test(t);
        return t.replace(/URI="([^"]+)"/g, (m, u) => `URI="${seg ? abs(u) : prefix + this.sign(abs(u), hdr)}"`);
      }
      return direct ? abs(t) : prefix + this.sign(abs(t), hdr);
    }).join('\n');
  }

  async handle(req, res, query, prefix = '') {
    const target = this.verify(query.get('d'), query.get('s'));
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const headers = this.headers(target);
    if (req.headers.range) headers.Range = req.headers.range;
    let up;
    // (Without a limit of our own, fetch waits up to 5 minutes for a provider that accepted the connection but never answers.)
    let late = false;
    const slow = setTimeout(() => { late = true; ac.abort(); }, this.firstByteMs);
    try {
      up = await fetchAny(target.u, { headers, signal: ac.signal, redirect: 'follow' });
    } catch (err) {
      if (late) throw new HttpError(504, 'The stream server didn’t answer in time');
      if (ac.signal.aborted) return;
      throw new HttpError(502, `Upstream error: ${err.cause?.message || err.message}`);
    } finally { clearTimeout(slow); }
    const ct = (up.headers.get('content-type') || '').toLowerCase();
    const len = Number(up.headers.get('content-length') || 0);
    const looksPlaylist = ct.includes('mpegurl') || (/\.m3u8?$/i.test(new URL(up.url).pathname) && !ct.startsWith('video/'));
    // raw: hand the file over untouched (used when the viewer downloads a playlist or guide).
    let pre = null; // the first bytes, already read, when it turned out not to be a playlist
    let ended = false;
    if (up.ok && up.body && looksPlaylist && !target.raw && (!len || len < 20e6)) {
      // Look at the start before reading it all: some providers send an endless MPEG-TS stream from a .m3u8
      // address, which must be passed on as it comes rather than collected in memory.
      const reader = up.body.getReader();
      const parts = [];
      let n = 0;
      while (n < 16) { const r = await reader.read(); if (r.done) { ended = true; break; } parts.push(Buffer.from(r.value)); n += r.value.length; }
      const head = Buffer.concat(parts).toString('utf8').replace(/^\uFEFF/, '');
      if (head.trimStart().startsWith('#EXTM3U')) {
        while (!ended) {
          const r = await reader.read();
          if (r.done) break;
          parts.push(Buffer.from(r.value)); n += r.value.length;
          if (n > 20e6) throw new HttpError(502, 'The playlist is too big');
        }
        const text = Buffer.concat(parts).toString('utf8').replace(/^\uFEFF/, '');
        const body = Buffer.from(this.rewritePlaylist(text, up.url, target, prefix || ''));
        if (this.onBytes) this.onBytes(!!target.split, body.length);
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': body.length, 'Cache-Control': 'no-cache', ...(prefix ? { 'Access-Control-Allow-Origin': '*' } : {}) });
        res.end(body);
        return;
      }
      pre = Buffer.concat(parts);
      reader.releaseLock();
    }
    const out = { 'Cache-Control': 'no-cache' };
    if (prefix) out['Access-Control-Allow-Origin'] = '*';
    const encoded = !!up.headers.get('content-encoding'); // fetch already decoded it, so the length would be wrong
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
      if (encoded && h === 'content-length') continue;
      const v = up.headers.get(h);
      if (v) out[h] = v;
    }
    res.writeHead(up.status, out);
    if (pre && pre.length) res.write(pre);
    if (!up.body || ended) { if (this.onBytes && pre) this.onBytes(!!target.split, pre.length); return res.end(); }
    const body = Readable.fromWeb(up.body);
    body.on('error', () => res.destroy());
    if (this.onBytes) { let n = pre ? pre.length : 0; body.on('data', (c) => { n += c.length; }); res.once('close', () => this.onBytes(!!target.split, n)); }
    body.pipe(res);
  }
}

module.exports = { Proxy };
