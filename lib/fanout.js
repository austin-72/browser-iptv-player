'use strict';
const crypto = require('crypto');
const { HttpError } = require('./util');

/**
 * Watch-party streaming: one provider connection, many viewers.
 *
 * Normally every viewer's browser fetches the stream itself (one provider connection each). In a watch party the
 * members watch the same thing at the same moment, so the server fetches it once and hands the same bytes to
 * everyone:
 *  - HLS ('pl' playlists, 'seg' segments/keys): a short-lived shared cache keyed by the upstream address, so N
 *    members cause one upstream request per playlist refresh and per segment (requests in flight are shared too).
 *  - Continuous MPEG-TS ('ts'): one upstream request, broadcast to every member. Someone joining later starts at the
 *    next 188-byte packet, with the latest PAT/PMT tables first so the player can start decoding. A member who can't
 *    keep up is dropped (their player reconnects) rather than holding everyone else back.
 *  - Files ('file': MP4 films and episodes): fetched in 2 MB pieces, one at a time, and shared — the members play in
 *    sync, so they ask for the same pieces.
 * Only addresses this server signed can be fetched (like the relay), so it can't be used as an open proxy.
 */
const CHUNK = 2 * 1024 * 1024;
const TS = 188;
const SLOW = 8 * 1024 * 1024; // bytes waiting for one member before they're dropped
const IDLE_MS = 8000; // keep a broadcast open this long after the last member leaves (zapping, reconnecting)

class Fanout {
  /**
   * fetch(url, opts) → Response (WHATWG); headers(target) → request headers for upstream; maxBytes: cache size.
   * onUpstream(kind) is called for every request made to the provider (tests and statistics).
   */
  constructor({ fetch, headers, maxBytes = 96 * 1024 * 1024, onUpstream, onBytes, now, slowBytes } = {}) {
    this.fetch = fetch;
    this.headers = headers || (() => ({}));
    this.secret = crypto.randomBytes(32);
    this.maxBytes = maxBytes;
    this.cache = new Map(); // key -> { at, ttl, size, value, pending }
    this.size = 0;
    this.ts = new Map(); // upstream url -> broadcast
    this.files = new Map(); // upstream url -> { total, type, queue }
    this.streams = new Map(); // party id -> { k, url, kind, list, at }
    this.seen = new Map(); // party id -> last request time
    this.onUpstream = onUpstream || (() => {});
    this.onBytes = onBytes || null;
    this.now = now || (() => Date.now());
    this.upstream = 0;
    this.slowBytes = slowBytes || SLOW;
  }

  // ------------------------------------------------------------------ signing
  sign(t) {
    const d = Buffer.from(JSON.stringify(t)).toString('base64url');
    const s = crypto.createHmac('sha256', this.secret).update(d).digest('base64url').slice(0, 32);
    return `/api/fan?d=${d}&s=${s}`;
  }
  verify(d, s) {
    if (!d || !s) throw new HttpError(400, 'Missing signature');
    const expect = crypto.createHmac('sha256', this.secret).update(d).digest('base64url').slice(0, 32);
    if (s.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expect))) throw new HttpError(403, 'Invalid party stream link (restart playback)');
    return JSON.parse(Buffer.from(d, 'base64url').toString('utf8'));
  }

  // ------------------------------------------------------------------ which parties are sharing right now
  /** Remembers the shared stream for a party (one at a time: a new title replaces the old one). */
  register(party, info) { this.streams.set(party, { ...info, at: this.now() }); }
  streamFor(party, k) { const s = this.streams.get(party); return s && s.k === k ? s : null; }
  forget(party) { this.streams.delete(party); this.seen.delete(party); }
  /** Has anyone in this party fetched the shared stream in the last 20 seconds? */
  active(party) { const t = this.seen.get(party); return !!t && this.now() - t < 20000; }
  _touch(party) { if (party) this.seen.set(party, this.now()); }

  // ------------------------------------------------------------------ requests
  async handle(req, res, q) {
    const t = this.verify(q.get('d'), q.get('s'));
    this._touch(t.p);
    if (t.m === 'ts') return this._ts(req, res, t);
    if (t.m === 'file') return this._file(req, res, t);
    if (t.m === 'pl') return this._playlist(req, res, t);
    return this._segment(req, res, t);
  }

  async _get(t, kind, extra) {
    this.upstream++;
    this.onUpstream(kind, t.u);
    const headers = { ...this.headers(t), ...(extra || {}) };
    const r = await this.fetch(t.u, { headers, redirect: 'follow' });
    return r;
  }

  /** A shared, short-lived cache: everyone asking for `key` while it's being fetched waits for the same answer. */
  _cached(key, ttl, fn) {
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && hit.pending) return hit.pending;
    if (hit && now - hit.at < hit.ttl) { this.cache.delete(key); this.cache.set(key, hit); return Promise.resolve(hit.value); }
    if (hit) this._drop(key);
    const entry = { at: now, ttl, size: 0, value: null, pending: null };
    entry.pending = Promise.resolve().then(fn).then((v) => {
      entry.pending = null;
      entry.value = v;
      entry.ttl = typeof v.ttl === 'number' ? v.ttl : ttl;
      entry.at = this.now();
      entry.size = v.body ? v.body.length : 0;
      this.size += entry.size;
      this._trim();
      return v;
    }, (e) => { this.cache.delete(key); throw e; });
    this.cache.set(key, entry);
    return entry.pending;
  }
  _drop(key) { const e = this.cache.get(key); if (e) { this.size -= e.size; this.cache.delete(key); } }
  _trim() {
    for (const [k, e] of this.cache) {
      if (this.size <= this.maxBytes) break;
      if (!e.pending) this._drop(k);
    }
  }

  async _playlist(req, res, t) {
    const v = await this._cached('pl:' + t.u, 1500, async () => {
      const up = await this._get(t, 'playlist');
      const text = await up.text();
      if (!up.ok) return { status: up.status, type: 'text/plain', body: Buffer.from(text), ttl: 1000 };
      const body = Buffer.from(this.rewrite(text, up.url || t.u, t));
      // Live playlists change every few seconds; finished ones (films) never do.
      const live = !/#EXT-X-ENDLIST/i.test(text);
      const td = Number((/#EXT-X-TARGETDURATION:\s*(\d+(?:\.\d+)?)/i.exec(text) || [])[1]) || 6;
      return { status: 200, type: 'application/vnd.apple.mpegurl', body, ttl: live ? Math.max(500, Math.min(3000, td * 1000 / 3)) : 10 * 60e3 };
    });
    this._send(res, v, { 'Cache-Control': 'no-cache' });
  }

  async _segment(req, res, t) {
    const v = await this._cached('seg:' + t.u, 30e3, async () => {
      const up = await this._get(t, 'segment');
      const body = Buffer.from(await up.arrayBuffer());
      return { status: up.status, type: up.headers.get('content-type') || 'video/mp2t', body, ttl: up.ok ? 30e3 : 1000 };
    });
    // (Byte-range playlists ask for parts of one file: serve them from the cached whole.)
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range && v.status === 200) {
      const a = Number(range[1]), b = range[2] ? Math.min(Number(range[2]), v.body.length - 1) : v.body.length - 1;
      if (a >= v.body.length) { res.writeHead(416, { 'Content-Range': `bytes */${v.body.length}` }); return res.end(); }
      const part = v.body.subarray(a, b + 1);
      res.writeHead(206, { 'Content-Type': v.type, 'Content-Length': part.length, 'Content-Range': `bytes ${a}-${b}/${v.body.length}`, 'Accept-Ranges': 'bytes' });
      return res.end(part);
    }
    this._send(res, v, { 'Cache-Control': 'max-age=60' });
  }

  _send(res, v, extra) {
    if (this.onBytes) this.onBytes(v.body.length);
    res.writeHead(v.status, { 'Content-Type': v.type, 'Content-Length': v.body.length, ...extra });
    res.end(v.body);
  }

  /** Points every address in an HLS playlist back here (playlists as 'pl', segments and keys as 'seg'). */
  rewrite(text, base, t) {
    const abs = (u) => { try { return new URL(u, base).href; } catch { return u; } };
    const master = /#EXT-X-STREAM-INF/i.test(text);
    const mk = (u, m) => this.sign({ p: t.p, k: t.k, h: t.h, ua: t.ua, ref: t.ref, u: abs(u), m });
    return text.split(/\r?\n/).map((line) => {
      const s = line.trim();
      if (!s) return line;
      if (s.startsWith('#')) {
        if (!s.includes('URI="')) return line;
        // Alternative renditions (#EXT-X-MEDIA) are playlists; keys, init sections and parts are files.
        const isPl = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF)\b/i.test(s);
        return s.replace(/URI="([^"]+)"/g, (m0, u) => `URI="${mk(u, isPl ? 'pl' : 'seg')}"`);
      }
      return mk(s, master ? 'pl' : 'seg');
    }).join('\n');
  }

  // ------------------------------------------------------------------ continuous MPEG-TS, broadcast
  _ts(req, res, t) {
    let b = this.ts.get(t.u);
    if (!b) { b = this._open(t); this.ts.set(t.u, b); }
    clearTimeout(b.idle);
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-cache' });
    if (res.flushHeaders) res.flushHeaders();
    // Start with the latest programme tables, so a late joiner's player knows what's in the stream.
    if (b.pat) res.write(b.pat);
    for (const pkt of b.pmt.values()) res.write(pkt);
    b.clients.add(res);
    res.on('close', () => {
      b.clients.delete(res);
      if (!b.clients.size) b.idle = setTimeout(() => this._close(b), IDLE_MS);
    });
  }

  _open(t) {
    const b = { url: t.u, clients: new Set(), ac: new AbortController(), carry: Buffer.alloc(0), pat: null, pmt: new Map(), pmtPids: new Set(), idle: null, bytes: 0 };
    (async () => {
      try {
        this.upstream++;
        this.onUpstream('ts', t.u);
        const up = await this.fetch(t.u, { headers: this.headers(t), signal: b.ac.signal, redirect: 'follow' });
        if (!up.ok || !up.body) throw new Error('HTTP ' + up.status);
        const reader = up.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          this._data(b, Buffer.from(value));
        }
      } catch (e) { /* the members' players reconnect */ }
      this._close(b);
    })();
    return b;
  }

  _close(b) {
    clearTimeout(b.idle);
    if (this.ts.get(b.url) === b) this.ts.delete(b.url);
    try { b.ac.abort(); } catch {}
    for (const r of b.clients) { try { r.end(); } catch {} }
    b.clients.clear();
  }

  /** Passes on whole 188-byte packets only, so anyone can start at the next piece; notes the PAT and PMTs. */
  _data(b, chunk) {
    let buf = b.carry.length ? Buffer.concat([b.carry, chunk]) : chunk;
    // Find the packet boundary (sync byte every 188 bytes).
    let start = 0;
    while (start < buf.length && !(buf[start] === 0x47 && (start + TS >= buf.length || buf[start + TS] === 0x47))) start++;
    const n = Math.floor((buf.length - start) / TS) * TS;
    const out = buf.subarray(start, start + n);
    b.carry = Buffer.from(buf.subarray(start + n));
    if (!n) return;
    for (let i = 0; i < out.length; i += TS) this._tables(b, out.subarray(i, i + TS));
    b.bytes += out.length;
    if (this.onBytes) this.onBytes(out.length * b.clients.size);
    for (const r of b.clients) {
      // Someone whose connection can't keep up: drop them rather than make everyone wait.
      if (r.writableLength > this.slowBytes) { b.clients.delete(r); try { r.destroy(); } catch {} continue; }
      r.write(out);
    }
  }

  _tables(b, p) {
    if (p[0] !== 0x47) return;
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    if (pid === 0) {
      b.pat = Buffer.from(p);
      if (!(p[1] & 0x40)) return; // not the start of a table
      const afc = (p[3] >> 4) & 3;
      let off = 4 + (afc & 2 ? p[4] + 1 : 0);
      off += 1 + p[off]; // pointer field
      if (p[off] !== 0) return;
      const len = ((p[off + 1] & 0x0f) << 8) | p[off + 2];
      const end = Math.min(TS - 4, off + 3 + len - 4);
      for (let i = off + 8; i + 4 <= end; i += 4) {
        const prog = (p[i] << 8) | p[i + 1];
        if (prog) b.pmtPids.add(((p[i + 2] & 0x1f) << 8) | p[i + 3]);
      }
    } else if (b.pmtPids.has(pid)) b.pmt.set(pid, Buffer.from(p));
  }

  // ------------------------------------------------------------------ files, in shared pieces
  async _file(req, res, t) {
    const f = this.files.get(t.u) || this.files.set(t.u, { total: 0, type: '', queue: Promise.resolve() }).get(t.u);
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    let a = m && m[1] ? Number(m[1]) : 0;
    let want = m && m[2] ? Number(m[2]) : Infinity;
    if (m && !m[1] && m[2]) { a = -Number(m[2]); want = Infinity; } // suffix range (the last N bytes): resolved once the size is known
    const idx = Math.floor(Math.max(0, a) / CHUNK);
    let piece = await this._piece(t, f, idx);
    if (a < 0) { a = Math.max(0, f.total + a); piece = await this._piece(t, f, Math.floor(a / CHUNK)); }
    if (!f.total) { res.writeHead(502); return res.end(); }
    if (a >= f.total) { res.writeHead(416, { 'Content-Range': `bytes */${f.total}` }); return res.end(); }
    const from = a - piece.start;
    const to = Math.min(piece.body.length, (want === Infinity ? Infinity : want - piece.start + 1));
    const part = piece.body.subarray(from, to);
    if (this.onBytes) this.onBytes(part.length);
    res.writeHead(206, { 'Content-Type': f.type || 'video/mp4', 'Content-Length': part.length, 'Content-Range': `bytes ${a}-${a + part.length - 1}/${f.total}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    res.end(part);
    // The next piece, ready before anyone asks (still one request at a time).
    const next = piece.start + piece.body.length;
    if (next < f.total) this._piece(t, f, idx + 1).catch(() => {});
  }

  /** One piece of a file; requests to the provider go one after another (one connection). */
  _piece(t, f, idx) {
    return this._cached(`file:${t.u}:${idx}`, 10 * 60e3, () => {
      const run = f.queue.then(async () => {
        const start = idx * CHUNK;
        const up = await this._get(t, 'file', { Range: `bytes=${start}-${start + CHUNK - 1}` });
        const body = Buffer.from(await up.arrayBuffer());
        const cr = /\/(\d+)\s*$/.exec(up.headers.get('content-range') || '');
        if (cr) f.total = Number(cr[1]);
        else if (up.status === 200) f.total = body.length; // the provider ignored the range: the whole file
        f.type = up.headers.get('content-type') || f.type;
        if (!up.ok) throw new HttpError(502, `The provider answered HTTP ${up.status}`);
        return { start, body: up.status === 200 ? body.subarray(start, start + CHUNK) : body };
      });
      f.queue = run.catch(() => {});
      return run;
    });
  }
}

module.exports = { Fanout, CHUNK };
