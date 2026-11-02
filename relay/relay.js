#!/usr/bin/env node
// Stream relay for Browser IPTV Player — run it on a small internet machine (a VPS) so viewers' devices fetch their
// streams through it instead of straight from the provider. The provider only ever sees this machine's address, and
// your home server carries none of the video. One file, Node 18+, no packages.
//
//   RELAY_SECRET=<the secret from Admin → Network & proxies> node relay.js
//
// Settings (environment variables):
//   RELAY_SECRET        required. The same secret as in Admin → Network & proxies → Stream relay.
//   PORT                where it listens (default 8090). Put https in front of it (see docs/stream-relay.md).
//   PROXY_PORT          optional: also be an HTTP proxy (with CONNECT) on this port for the server's own traffic.
//   PROXY_USER, PROXY_PASS   required with PROXY_PORT: the proxy's sign-in.
//   RELAY_ALLOW_PRIVATE=1    allow addresses on this machine's own network (off: only public internet addresses).
//   RELAY_CACHE_DIR     where whole films and episodes are kept while they're watched (default: the system's temp folder).
//   RELAY_CACHE_GB      the most they may take up (default: the free disk space minus 5 GB).
//
// How it's used: the server signs each stream address with the secret (lib/streamrelay.js). The relay checks the
// signature and the expiry, fetches the address with the headers the provider needs, and passes the answer on with
// permission for web pages to read it (CORS). HLS playlists are rewritten so their segments, keys and variants come
// through the relay too.
//
// Films and episodes (the server marks them) are fetched whole, as fast as the provider sends them, onto this
// machine's disk, and played from there: seeking is instant, and once the file is here the provider connection is
// free for someone else (the server asks /downloads which ones are finished). Seeking ahead of the download makes the
// relay jump there first. The server can also send a newer relay.js (Admin → Stream relay → Update the relay).
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const pathMod = require('path');
const vm = require('vm');

const VERSION = '3';
const SECRET = process.env.RELAY_SECRET || '';
const PORT = Number(process.env.PORT) || 8090;
const PROXY_PORT = Number(process.env.PROXY_PORT) || 0;
const PROXY_USER = process.env.PROXY_USER || '';
const PROXY_PASS = process.env.PROXY_PASS || '';
const ALLOW_PRIVATE = process.env.RELAY_ALLOW_PRIVATE === '1';
const MAX_PLAYLIST = 8 * 1024 * 1024;
const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a);

// ---------------------------------------------------------------- sealed addresses (the same rules as lib/streamrelay.js)
// An address is the provider's address, its headers and an expiry, encrypted and sealed with a key made from the
// secret (AES-256-GCM): only this relay and your server can make or read one, and devices never see the provider's
// address or login.
const KEY = crypto.createHash('sha256').update('relay-key:' + SECRET).digest();
const sigOf = (token) => crypto.createHmac('sha256', SECRET).update(token).digest('base64url').slice(0, 32);
function seal(o) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(JSON.stringify(o), 'utf8'), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]).toString('base64url');
}
function open(token) {
  try {
    const b = Buffer.from(token, 'base64url');
    if (b.length < 30) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(b.length - 16));
    const o = JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8'));
    if (!o || typeof o.u !== 'string' || !/^https?:\/\//i.test(o.u) || !(o.e > Date.now() / 1000)) return null;
    return o;
  } catch { return null; }
}
/** { u, h, e, w?, i? } → "/e/<sealed>/<name>" (the name keeps the file type visible to players). */
function signPath(o) {
  let name = 'stream';
  try { name = decodeURIComponent(new URL(o.u).pathname.split('/').pop() || 'stream'); } catch {}
  name = name.replace(/[^\w.-]/g, '_').slice(-80) || 'stream';
  return `/e/${seal(o)}/${name}`;
}

// ---------------------------------------------------------------- only public internet addresses
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || (x.startsWith('::ffff:') && isPrivate(x.slice(7)));
}
async function publicHost(host) {
  if (ALLOW_PRIVATE) return true;
  host = host.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return !isPrivate(host);
  if (/^localhost$|\.localhost$|\.local$|\.lan$|\.internal$/i.test(host)) return false;
  try { const all = await dns.promises.lookup(host, { all: true }); return all.length > 0 && all.every((r) => !isPrivate(r.address)); } catch { return false; }
}

// ---------------------------------------------------------------- fetching from the provider
function get(url, { method = 'GET', headers = {}, hops = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('bad address')); }
    publicHost(u.hostname).then((ok) => {
      if (!ok) return reject(Object.assign(new Error('Only public internet addresses can be relayed'), { status: 403 }));
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(u, { method, headers, timeout: 20000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 6) {
          res.resume();
          const next = new URL(res.headers.location, u).href;
          return get(next, { method, headers, hops: hops + 1 }).then(resolve, reject);
        }
        res.finalUrl = u.href;
        resolve(res);
      });
      req.on('timeout', () => req.destroy(new Error('The provider didn’t answer in time')));
      req.on('error', reject);
      req.end();
    }, reject);
  });
}

const isPlaylist = (res, url, head) => /mpegurl/i.test(res.headers['content-type'] || '') || /\.m3u8?(\?|$)/i.test(url) || /^\s*#EXTM3U/.test(head);

/** Every address in an HLS playlist → a signed relay address (relative ones resolved first). */
function rewrite(text, base, o) {
  const sign = (ref) => { try { return signPath({ u: new URL(ref, base).href, h: o.h, e: o.e }); } catch { return ref; } };
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (m, ref) => (/^(data|skd):/i.test(ref) ? m : `URI="${sign(ref)}"`));
    return sign(t);
  }).join('\n');
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');
  res.setHeader('Timing-Allow-Origin', '*');
}

const active = new Set();
async function relay(req, res, o) {
  const headers = { 'User-Agent': 'VLC/3.0.21 LibVLC/3.0.21', Accept: '*/*', ...(o.h || {}) };
  if (req.headers.range) headers.Range = req.headers.range;
  let up;
  try { up = await get(o.u, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers }); } catch (e) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(e.status || 502, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(e.message || 'The provider couldn’t be reached');
  }
  // The viewer left (zapped away) while the provider was answering: let go of the provider at once.
  if (res.destroyed || req.destroyed) { up.destroy(); return; }
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  const ct = up.headers['content-type'] || '';
  const headersOut = () => { const h = { 'Cache-Control': up.headers['cache-control'] || 'no-store' }; for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) if (up.headers[k]) h[k] = up.headers[k]; return h; };
  // Playlists: read (they're small), rewrite, send. Recognised by type, name, or their first bytes.
  const maybe = up.statusCode < 400 && req.method !== 'HEAD' && !req.headers.range && !/^(video|audio|image)\//i.test(ct);
  if (maybe) {
    const first = await new Promise((ok) => {
      const done = (c) => { up.off('data', done); up.off('end', end); up.off('close', end); up.off('error', end); up.pause(); ok(c || null); };
      const end = () => done(null);
      up.on('data', done); up.on('end', end); up.on('close', end); up.on('error', end); // (the provider hung up before the first byte)
    });
    if (res.destroyed) { up.destroy(); return; }
    if (!first && up.destroyed && !up.complete) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('The provider hung up'); }
    const looks = /mpegurl/i.test(ct) || /\.m3u8?(\?|$)/i.test(up.finalUrl) || (first && /^\s*(\ufeff)?#EXTM3U/.test(first.slice(0, 64).toString('utf8')));
    if (looks) {
      const chunks = first ? [first] : []; let size = first ? first.length : 0;
      up.resume();
      for await (const c of up) { size += c.length; if (size > MAX_PLAYLIST) { up.destroy(); res.writeHead(502); return res.end('Playlist too big'); } chunks.push(c); }
      const text = Buffer.concat(chunks).toString('utf8');
      const out = Buffer.from(isPlaylist(up, up.finalUrl, text.slice(0, 200)) ? rewrite(text, up.finalUrl, o) : text);
      res.writeHead(up.statusCode, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': out.length, 'Cache-Control': 'no-store' });
      return res.end(out);
    }
    res.writeHead(up.statusCode, headersOut());
    if (first) res.write(first);
    active.add(up);
    up.resume();
    up.pipe(res);
    res.on('close', () => { active.delete(up); up.destroy(); });
    up.on('error', () => res.destroy());
    return;
  }
  res.writeHead(up.statusCode, headersOut());
  if (req.method === 'HEAD') { up.resume(); return res.end(); }
  active.add(up);
  up.pipe(res);
  const done = () => { active.delete(up); up.destroy(); };
  res.on('close', done);
  up.on('error', () => res.destroy());
}

// ---------------------------------------------------------------- whole films and episodes
const CACHE_DIR = process.env.RELAY_CACHE_DIR || pathMod.join(os.tmpdir(), 'relay-cache');
const CACHE_LIMIT = (Number(process.env.RELAY_CACHE_GB) || 0) * 1e9; // 0: the free space minus KEEP_FREE
const KEEP_FREE = 5e9;
const CHUNK = 1 << 20;                 // bookkeeping unit: which MBs of a file are here
const NEAR = 8 * CHUNK;                // a reader this far ahead of the download just waits for it
const IDLE_STOP = Number(process.env.RELAY_IDLE_STOP_MS) || 120000; // nobody reading for this long: stop downloading
// (sooner when the server says nobody's playing it any more: see /downloads)
const KEEP_FOR = 6 * 3600e3;           // a file nobody has used for this long is deleted
const wholes = new Map();              // key → Whole

/**
 * One film being fetched whole. The file on disk is as big as the film from the start; `have` marks the MBs that are
 * in. One provider connection at a time ("a run") fills it from some point onwards; a reader that needs a part that
 * isn't here, and isn't coming soon, moves the run there. When a run reaches a part that's already here, the next run
 * starts at the next gap — first after the furthest-behind reader, then from the start — until everything is in.
 */
class Whole {
  constructor(key, o) {
    this.key = key; this.o = o; this.ids = new Set(o.i ? [String(o.i)] : []);
    this.size = 0; this.type = 'application/octet-stream'; this.ranges = true;
    this.have = null; this.haveCount = 0; this.chunks = 0;
    this.file = pathMod.join(CACHE_DIR, key + '.bin'); this.fd = null;
    this.readers = new Set(); this.waiters = new Set();
    this.run = null; this.failed = null; this.done = false; this.bypass = false; this.errors = 0;
    this.lastUse = Date.now(); this.idleTimer = null; this.started = Date.now();
  }
  headers() { return { 'User-Agent': 'VLC/3.0.21 LibVLC/3.0.21', Accept: '*/*', ...(this.o.h || {}) }; }
  chunkHave(i) { return !!(this.have && this.have[i]); }
  /** The end (exclusive) of the bytes readable from p onwards: whole MBs that are in, then the running download. */
  availEnd(p) {
    if (!this.have || p >= this.size) return p;
    let i = Math.floor(p / CHUNK);
    while (i < this.chunks && this.have[i]) i++;
    let end = Math.min(i * CHUNK, this.size);
    const r = this.run;
    if (r && r.from <= end && r.written > end) end = r.written;
    return Math.max(end, p);
  }
  wake() { for (const w of this.waiters) w(); this.waiters.clear(); }
  wait(ms) { return new Promise((ok) => { const t = setTimeout(done, ms); function done() { clearTimeout(t); ok(); } this.waiters.add(done); }); }
  bytesHere() { return Math.min(this.haveCount * CHUNK, this.size); }
  /** Starts the first run at `from`; resolves once the size and type are known (or this film can't be done whole). */
  async begin(from) {
    from = Math.floor(from / CHUNK) * CHUNK;
    const up = await get(this.o.u, { headers: { ...this.headers(), Range: `bytes=${from}-` } });
    const ct = up.headers['content-type'] || '';
    let total = 0;
    if (up.statusCode === 206) { const m = /\/(\d+)\s*$/.exec(up.headers['content-range'] || ''); total = m ? Number(m[1]) : 0; }
    else if (up.statusCode === 200) { total = Number(up.headers['content-length']) || 0; this.ranges = false; if (from) from = 0; }
    if (up.statusCode >= 400 || !total || /mpegurl|text\/|json|html/i.test(ct) || /\.m3u8?(\?|$)/i.test(up.finalUrl || '')) { up.destroy(); return false; }
    if (!makeRoom(total, this)) { up.destroy(); return false; }
    this.size = total; this.type = ct || 'application/octet-stream';
    this.chunks = Math.ceil(total / CHUNK); this.have = new Uint8Array(this.chunks);
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      this.fd = fs.openSync(this.file, 'w+');
      fs.ftruncateSync(this.fd, total);
    } catch (e) {
      up.destroy();
      if (this.fd != null) { try { fs.closeSync(this.fd); } catch {} this.fd = null; }
      try { fs.unlinkSync(this.file); } catch {}
      return false;
    }
    this.attach(up, from);
    return true;
  }
  /** Writes one provider answer into the file from `from` onwards. */
  attach(up, from) {
    const r = { up, from, at: from, written: from, stop: false, t0: Date.now() };
    this.run = r;
    let writing = Promise.resolve();
    up.on('data', (buf) => {
      if (r.stop) return;
      // Reaching an MB that's already here (another run filled it): write up to it and end this run there.
      if (this.ranges) {
        const nb = (Math.floor(r.at / CHUNK) + 1) * CHUNK;
        if (r.at + buf.length > nb && nb < this.size && this.have[nb / CHUNK]) { buf = buf.subarray(0, nb - r.at); r.last = true; }
      }
      const pos = r.at;
      r.at += buf.length;
      up.pause();
      writing = writing.then(() => new Promise((ok) => fs.write(this.fd, buf, 0, buf.length, pos, (err) => {
        if (err) { this.fail(new Error('The relay’s disk is full or failing')); return ok(); }
        r.written = pos + buf.length;
        // The MBs this write finished (runs start on an MB boundary, so every MB from `pos` on is this run's).
        for (let i = Math.floor(pos / CHUNK); i < this.chunks; i++) {
          if (Math.min((i + 1) * CHUNK, this.size) > r.written) break;
          if (!this.have[i]) { this.have[i] = 1; this.haveCount++; }
        }
        this.errors = 0;
        this.wake();
        // Ran into a part that's already here (or the end): this run is done.
        const next = r.written / CHUNK;
        if (r.last || r.written >= this.size || (this.ranges && r.written % CHUNK === 0 && this.have[next])) { this.endRun(r); return ok(); }
        if (!r.stop) up.resume();
        ok();
      })));
    });
    up.on('end', () => writing.then(() => { if (this.run === r && !r.stop) this.endRun(r); }));
    up.on('error', () => writing.then(() => { if (this.run === r && !r.stop) { this.errors++; this.endRun(r, true); } }));
    up.on('close', () => writing.then(() => { if (this.run === r && !r.stop) { this.errors++; this.endRun(r, true); } }));
  }
  endRun(r, broken) {
    r.stop = true; try { r.up.destroy(); } catch {}
    if (this.run === r) this.run = null;
    if (this.haveCount >= this.chunks) return this.complete();
    if (broken && this.errors > 4) return this.fail(new Error('The provider keeps dropping the connection'));
    setTimeout(() => this.next(), broken ? Math.min(5000, 500 * this.errors) : 0);
  }
  complete() {
    this.done = true; this.run = null;
    log(`whole ${this.key.slice(0, 8)}: all ${(this.size / 1e9).toFixed(2)} GB here in ${Math.round((Date.now() - this.started) / 1000)} s`);
    this.wake();
  }
  fail(e) { this.failed = e; if (this.run) { this.run.stop = true; try { this.run.up.destroy(); } catch {} this.run = null; } this.wake(); }
  /** The next gap to fill: after the furthest-behind reader first, then from the start. Nothing if nobody's reading. */
  next() {
    if (this.done || this.failed || this.run || !this.readers.size) return;
    const behind = Math.min(...[...this.readers].map((x) => x.pos));
    let i = Math.floor(behind / CHUNK);
    while (i < this.chunks && this.have[i]) i++;
    if (i >= this.chunks) { i = 0; while (i < this.chunks && this.have[i]) i++; }
    if (i >= this.chunks) return this.complete();
    this.startAt(i * CHUNK);
  }
  startAt(from) {
    if (!this.ranges) from = 0;
    if (this.run) { this.run.stop = true; try { this.run.up.destroy(); } catch {} this.run = null; }
    const r = { stop: false };
    this.run = { from, at: from, written: from, t0: Date.now(), up: { destroy() { r.stop = true; } } }; // a placeholder while connecting
    const ph = this.run;
    get(this.o.u, { headers: { ...this.headers(), Range: `bytes=${from}-` } }).then((up) => {
      if (this.run !== ph) return up.destroy();
      // The same film, or nothing: a "too many connections" page or a placeholder video must not land in the file.
      const ct = up.headers['content-type'] || '';
      const m = /\/(\d+)\s*$/.exec(up.headers['content-range'] || '');
      const same = !/mpegurl|text\/|json|html/i.test(ct) && (up.statusCode === 206 ? m && Number(m[1]) === this.size : up.statusCode === 200 && Number(up.headers['content-length']) === this.size);
      if (!same) { up.destroy(); this.run = null; this.errors++; return this.endRun({ up: { destroy() {} }, stop: false }, true); }
      // The provider ignored the range (it sends the whole file from the start): carry on that way.
      if (from && up.statusCode !== 206) { this.ranges = false; from = 0; }
      this.attach(up, from);
    }, () => { if (this.run === ph) { this.run = null; this.errors++; this.endRun({ up: { destroy() {} }, stop: false }, true); } });
  }
  /** A reader needs byte p: if it isn't here and the download won't reach it soon, move the download there. */
  need(p) {
    if (this.done || this.failed) return;
    const r = this.run;
    if (r && r.from <= p && p <= r.at + NEAR) return;
    if (!r && !this.readers.size) return;
    if (!this.ranges && r) return; // can't jump: wait
    // Another reader is being served by the current run (two TVs on one film, or a player reading the start and the
    // end of an MP4): let it get going (a few MB or seconds) before moving it, so they don't keep cancelling each
    // other's download — each move is a new connection to the provider.
    if (r && (r.written - r.from < NEAR && Date.now() - (r.t0 || 0) < 4000) && [...this.readers].some((x) => x.pos >= r.from && x.pos <= r.at + NEAR)) return;
    this.startAt(Math.floor(p / CHUNK) * CHUNK);
  }
  addReader(x) { this.readers.add(x); this.lastUse = Date.now(); clearTimeout(this.idleTimer); if (!this.run) this.next(); }
  dropReader(x) {
    this.readers.delete(x); this.lastUse = Date.now();
    if (this.readers.size) return;
    clearTimeout(this.idleTimer);
    // Nobody watching for a while: stop downloading, so the provider connection is free again.
    this.idleTimer = setTimeout(() => { if (!this.readers.size && this.run) { this.run.stop = true; try { this.run.up.destroy(); } catch {} this.run = null; } }, IDLE_STOP);
  }
  remove() {
    clearTimeout(this.idleTimer);
    if (this.run) { this.run.stop = true; try { this.run.up.destroy(); } catch {} this.run = null; }
    if (this.fd != null) { try { fs.closeSync(this.fd); } catch {} this.fd = null; }
    try { fs.unlinkSync(this.file); } catch {}
    wholes.delete(this.key);
  }
  status() { return { ids: [...this.ids], size: this.size, here: this.bytesHere(), done: this.done, downloading: !!this.run, readers: this.readers.size }; }
}

function diskFree() { try { const s = fs.statfsSync(fs.existsSync(CACHE_DIR) ? CACHE_DIR : os.tmpdir()); return s.bavail * s.bsize; } catch { return 0; } }
/**
 * Room for a film of `size` bytes: the free disk, less what the films still downloading will take, less KEEP_FREE (and
 * within RELAY_CACHE_GB). Deletes films nobody is watching, the longest-unused first. False when it can't be found.
 */
function makeRoom(size, self) {
  const others = () => [...wholes.values()].filter((w) => w !== self && w.size);
  const room = () => {
    const o = others();
    let r = diskFree() - KEEP_FREE - o.reduce((s, w) => s + (w.size - w.bytesHere()), 0);
    if (CACHE_LIMIT) r = Math.min(r, CACHE_LIMIT - o.reduce((s, w) => s + w.size, 0));
    return r;
  };
  if (room() >= size) return true;
  for (const w of others().filter((x) => !x.readers.size).sort((x, y) => x.lastUse - y.lastUse)) { w.remove(); if (room() >= size) return true; }
  return false;
}
/** The server says which films are still being watched; downloads for any other film stop when nobody's reading. */
function stopUnwatched(activeIds) {
  for (const w of wholes.values()) {
    if (!w.run || w.readers.size || !w.ids.size) continue;
    if (![...w.ids].some((i) => activeIds.has(i))) { w.run.stop = true; try { w.run.up.destroy(); } catch {} w.run = null; }
  }
}
setInterval(() => { for (const w of [...wholes.values()]) if (!w.readers.size && (Date.now() - w.lastUse > KEEP_FOR || (w.bypass && Date.now() - w.started > 10 * 60e3))) w.remove(); }, 10 * 60e3).unref();

const drained = (res) => new Promise((ok) => { const done = () => { res.off('drain', done); res.off('close', done); ok(); }; res.on('drain', done); res.on('close', done); });

/** Plays a film from the copy on disk, filling it from the provider as needed. Falls back to plain relaying. */
async function whole(req, res, o) {
  const key = crypto.createHash('sha256').update(o.u).digest('hex').slice(0, 32);
  let w = wholes.get(key);
  if (w && (w.failed || (w.bypass && Date.now() - w.started > 10 * 60e3))) { w.remove(); w = null; }
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  let a = m && m[1] !== '' ? Number(m[1]) : 0;
  if (!w) {
    w = new Whole(key, o);
    wholes.set(key, w);
    w.ready = w.begin(m && m[1] === '' ? 0 : a).catch(() => false).then((ok) => { if (!ok) w.bypass = true; return ok; });
  }
  if (o.i) w.ids.add(String(o.i));
  const ok = await w.ready;
  if (!ok || w.bypass) return relay(req, res, o);
  const size = w.size;
  let b = size - 1;
  if (m) {
    if (m[1] === '') { a = Math.max(0, size - Number(m[2] || 0)); }
    else if (m[2] !== '') b = Math.min(Number(m[2]), size - 1);
    if (a >= size || a > b) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
  }
  const head = { 'Content-Type': w.type, 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1, 'Cache-Control': 'no-store' };
  if (m) head['Content-Range'] = `bytes ${a}-${b}/${size}`;
  res.writeHead(m ? 206 : 200, head);
  if (req.method === 'HEAD') return res.end();
  const reader = { pos: a };
  w.addReader(reader);
  res.on('close', () => w.dropReader(reader));
  try {
    let p = a;
    const buf = Buffer.allocUnsafe(CHUNK);
    while (p <= b && !res.destroyed) {
      const end = Math.min(w.availEnd(p), b + 1);
      if (end > p) {
        const n = Math.min(end - p, CHUNK);
        const got = await new Promise((ok, no) => fs.read(w.fd, buf, 0, n, p, (err, k) => (err ? no(err) : ok(k))));
        if (!got) throw new Error('read');
        if (!res.write(Buffer.from(buf.subarray(0, got)))) await drained(res);
        p += got; reader.pos = p; w.lastUse = Date.now();
        continue;
      }
      if (w.failed) throw w.failed;
      w.need(p);
      await w.wait(15000);
    }
    res.end();
  } catch { res.destroy(); }
  finally { w.dropReader(reader); }
}

// ---------------------------------------------------------------- the server sends a newer relay.js
const UPDATE_MAX = 4 * 1024 * 1024;
async function update(req, res) {
  const t = String(req.headers['x-relay-time'] || '');
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > UPDATE_MAX) { res.writeHead(413); return res.end(); } chunks.push(c); }
  const body = Buffer.concat(chunks);
  const want = sigOf('update:' + t + ':' + crypto.createHash('sha256').update(body).digest('hex'));
  const got = String(req.headers['x-relay-sig'] || '');
  const fresh = /^\d+$/.test(t) && Math.abs(Date.now() / 1000 - Number(t)) < 300;
  if (!fresh || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end('{"ok":false,"error":"The secret doesn’t match"}'); }
  const code = body.toString('utf8');
  const v = /const VERSION = '([^']+)'/.exec(code);
  try { new vm.Script(code, { filename: 'relay.js' }); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'That isn’t a working relay.js: ' + e.message })); }
  if (!v) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"ok":false,"error":"That isn’t a relay.js"}'); }
  const tmp = __filename + '.new';
  try { fs.writeFileSync(tmp, body); fs.renameSync(tmp, __filename); } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: `The relay can’t replace its own file (${e.code || e.message}). With Docker, its folder must be mounted writable — see docs/stream-relay.md.` }));
  }
  log(`updated from ${VERSION} to ${v[1]}: restarting`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, from: VERSION, to: v[1] }));
  // Docker (restart: unless-stopped) starts it again with the new file.
  setTimeout(() => process.exit(0), 300);
}

const signedQuery = (req, what) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const t = q.get('t') || '';
  return /^\d+$/.test(t) && Math.abs(Date.now() / 1000 - Number(t)) < 300 && q.get('s') === sigOf(what + ':' + t);
};

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Max-Age': '86400' }); return res.end(); }
  const path = (req.url || '/').split('?')[0];
  // The server's test: is the secret the same? (Answers with nothing else.)
  if (path === '/check') {
    const ok = signedQuery(req, 'check');
    const films = [...wholes.values()].filter((w) => w.size && !w.bypass);
    res.writeHead(ok ? 200 : 403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(ok ? { ok: true, version: VERSION, streams: active.size + films.filter((w) => w.run).length, films: films.length, update: true } : { ok: false, error: 'The secret doesn’t match' }));
  }
  // The server asks which films are fully here (their provider connection is free again).
  if (path === '/downloads') {
    const q = new URL(req.url, 'http://x').searchParams;
    const playing = q.get('playing') || '';
    if (!signedQuery(req, 'downloads:' + playing)) { res.writeHead(403); return res.end(); }
    if (q.has('playing')) stopUnwatched(new Set(playing.split(',').filter(Boolean)));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, films: [...wholes.values()].filter((w) => w.size && !w.bypass).map((w) => w.status()) }));
  }
  if (path === '/update' && req.method === 'POST') { try { return await update(req, res); } catch { if (!res.headersSent) { res.writeHead(500); res.end(); } return; } }
  if (path === '/' || path === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('Stream relay ' + VERSION + '\n'); }
  const m = /^\/e\/([A-Za-z0-9_-]+)(?:\/[^/]*)?$/.exec(path);
  if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404); return res.end(); }
  const o = open(m[1]);
  if (!o) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('This address isn’t valid (or has expired)'); }
  try { await (o.w ? whole(req, res, o) : relay(req, res, o)); } catch (e) { if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy(); }
});
server.keepAliveTimeout = 65000;

// ---------------------------------------------------------------- optional: an HTTP proxy for the server's own traffic
function proxyAuthOk(req) {
  const h = req.headers['proxy-authorization'] || '';
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return false;
  const want = Buffer.from(`${PROXY_USER}:${PROXY_PASS}`);
  const got = Buffer.from(m[1], 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function startProxy() {
  const px = http.createServer(async (req, res) => {
    if (!proxyAuthOk(req)) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="relay"' }); return res.end(); }
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
    if (!(await publicHost(u.hostname))) { res.writeHead(403); return res.end('Only public internet addresses'); }
    const h = { ...req.headers };
    delete h['proxy-authorization']; delete h['proxy-connection'];
    const up = (u.protocol === 'https:' ? https : http).request(u, { method: req.method, headers: h }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  px.on('connect', async (req, sock, head) => {
    if (!proxyAuthOk(req)) { sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="relay"\r\n\r\n'); return; }
    const [host, port] = String(req.url).split(':');
    if (!(await publicHost(host))) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const up = net.connect(Number(port) || 443, host, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head && head.length) up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  px.listen(PROXY_PORT, () => log(`HTTP proxy for the server's own traffic on port ${PROXY_PORT}`));
}

if (require.main === module) {
  if (!SECRET || SECRET.length < 16) { console.error('Set RELAY_SECRET to the secret shown in Admin → Network & proxies → Stream relay (at least 16 characters).'); process.exit(1); }
  if (PROXY_PORT && (!PROXY_USER || !PROXY_PASS)) { console.error('PROXY_PORT needs PROXY_USER and PROXY_PASS.'); process.exit(1); }
  // Films left over from before a restart: their bookkeeping is gone, so start afresh.
  try { for (const f of fs.readdirSync(CACHE_DIR)) if (/^[0-9a-f]{32}\.bin(\.\w+)?$/.test(f)) fs.unlinkSync(pathMod.join(CACHE_DIR, f)); } catch {}
  server.listen(PORT, () => log(`Stream relay ${VERSION} on port ${PORT} (whole films kept in ${CACHE_DIR}, ${(diskFree() / 1e9).toFixed(0)} GB free)`));
  if (PROXY_PORT) startProxy();
}
module.exports = { signPath, seal, open, rewrite, isPrivate, VERSION };
