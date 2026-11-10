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
const tls = require('tls');
const dns = require('dns');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const pathMod = require('path');
const vm = require('vm');

const VERSION = '7';
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
  // (An IPv4 address written inside an IPv6 one — "::ffff:7f00:1" is 127.0.0.1, "64:ff9b::…" the same through NAT64 — is judged as that IPv4 address.)
  const m4 = /^(?:::ffff:|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(x);
  if (m4) return isPrivate(m4[1] || [parseInt(m4[2], 16) >> 8, parseInt(m4[2], 16) & 255, parseInt(m4[3], 16) >> 8, parseInt(m4[3], 16) & 255].join('.'));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || /^fe[89ab]/.test(x) || x.startsWith('::ffff:') || x.startsWith('64:ff9b:');
}
async function publicHost(host) {
  if (ALLOW_PRIVATE) return true;
  host = host.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return !isPrivate(host);
  if (/^localhost$|\.localhost$|\.local$|\.lan$|\.internal$/i.test(host)) return false;
  try { const all = await dns.promises.lookup(host, { all: true }); return all.length > 0 && all.every((r) => !isPrivate(r.address)); } catch { return false; }
}

// ---------------------------------------------------------------- through a proxy (when the server asks for one)
// The server can send each address with a proxy (Admin → Network & proxies → Stream relay): the relay then connects
// to the provider through it, so the provider sees the proxy's address instead of this machine's. HTTP and HTTPS
// proxies (CONNECT, or the full address for plain http) and SOCKS5 (the proxy looks the name up), with a sign-in.
function tunnel(proxyUrl, host, port, timeout = 20000) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = new URL(proxyUrl); } catch { return reject(new Error('Bad proxy address')); }
    const user = decodeURIComponent(p.username || ''), pass = decodeURIComponent(p.password || '');
    const isSocks = /^socks/i.test(p.protocol);
    const pport = Number(p.port) || (isSocks ? 1080 : p.protocol === 'https:' ? 443 : 8080);
    const sock = p.protocol === 'https:' ? tls.connect({ host: p.hostname, port: pport, servername: p.hostname }) : net.connect(pport, p.hostname);
    let done = false;
    const fail = (e) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); reject(Object.assign(e instanceof Error ? e : new Error(String(e)), { status: 502 })); };
    const timer = setTimeout(() => fail(new Error('The proxy didn’t answer')), timeout);
    sock.on('error', (e) => fail(new Error(`Proxy: ${e.message}`)));
    const ok = () => { if (done) return; done = true; clearTimeout(timer); sock.removeAllListeners('data'); resolve(sock); };
    let buf = Buffer.alloc(0);
    if (!isSocks) {
      sock.once(p.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
        const auth = user ? `Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}\r\n` : '';
        sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
      });
      sock.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) { if (buf.length > 16384) fail(new Error('Proxy: bad answer')); return; }
        const code = parseInt(buf.slice(0, end).toString('latin1').split(' ')[1], 10);
        if (code !== 200) return fail(new Error(code === 407 ? 'The proxy wants a different username or password' : `The proxy refused (HTTP ${code})`));
        const rest = buf.slice(end + 4);
        ok();
        if (rest.length) sock.unshift(rest);
      });
      return;
    }
    let stage = 0;
    sock.once('connect', () => sock.write(Buffer.from(user ? [5, 2, 0, 2] : [5, 1, 0])));
    const connectReq = () => {
      const h = Buffer.from(host);
      sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
      stage = 2;
    };
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (stage === 0) {
        if (buf.length < 2) return;
        const m = buf[1]; buf = buf.slice(2);
        if (m === 0xff) return fail(new Error('The proxy wants a username and password'));
        if (m === 2) { const u = Buffer.from(user), pw = Buffer.from(pass); sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw])); stage = 1; return; }
        connectReq();
      } else if (stage === 1) {
        if (buf.length < 2) return;
        if (buf[1] !== 0) return fail(new Error('The proxy rejected the username or password'));
        buf = buf.slice(2);
        connectReq();
      } else if (stage === 2) {
        if (buf.length < 5) return;
        if (buf[1] !== 0) return fail(new Error(`The proxy couldn’t connect (SOCKS error ${buf[1]})`));
        const len = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4];
        if (buf.length < len) return;
        const rest = buf.slice(len);
        ok();
        if (rest.length) sock.unshift(rest);
      }
    });
  });
}
/** The proxy's own address must be on the public internet too (unless RELAY_ALLOW_PRIVATE). */
async function proxyOk(proxyUrl) {
  try { const p = new URL(proxyUrl); return /^(https?|socks5h?):$/i.test(p.protocol) && (await publicHost(p.hostname)); } catch { return false; }
}

// ---------------------------------------------------------------- fetching from the provider
function get(url, { method = 'GET', headers = {}, hops = 0, proxy = '' } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('bad address')); }
    // (Through a proxy the provider is looked up and reached by the proxy, so only a literal private address is refused.)
    const check = proxy ? proxyOk(proxy).then((ok) => ok && (ALLOW_PRIVATE || !net.isIP(u.hostname.replace(/^\[|\]$/g, '')) || !isPrivate(u.hostname.replace(/^\[|\]$/g, '')))) : publicHost(u.hostname);
    check.then(async (ok) => { try {
      if (!ok) return reject(Object.assign(new Error(proxy ? 'That proxy (or address) can’t be used' : 'Only public internet addresses can be relayed'), { status: 403 }));
      const mod = u.protocol === 'https:' ? https : http;
      let opts = { method, headers, timeout: 20000 };
      let target = u;
      if (proxy) {
        const p = new URL(proxy);
        if (u.protocol === 'http:' && /^https?:$/i.test(p.protocol)) {
          // Plain http through an HTTP proxy: ask the proxy for the full address.
          const auth = p.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}` } : {};
          const pmod = p.protocol === 'https:' ? https : http;
          target = null;
          opts = { method, host: p.hostname, port: Number(p.port) || (p.protocol === 'https:' ? 443 : 8080), path: u.href, headers: { Host: u.host, ...headers, ...auth }, timeout: 20000, agent: false };
          return finish(pmod.request(opts, onRes));
        }
        let sock, conn;
        try {
          sock = await tunnel(proxy, u.hostname, Number(u.port) || (u.protocol === 'https:' ? 443 : 80));
          // (TLS to the provider inside the tunnel; its errors before the request starts are handled here.)
          conn = u.protocol !== 'https:' ? sock : await new Promise((ok, no) => {
            const c = tls.connect({ socket: sock, servername: net.isIP(u.hostname) ? undefined : u.hostname });
            c.once('secureConnect', () => { c.removeListener('error', no); c.setTimeout(0); ok(c); });
            c.once('error', no);
            c.setTimeout(20000, () => c.destroy(new Error('The provider didn’t answer in time')));
          });
        } catch (e) { if (sock) sock.destroy(); return reject(Object.assign(new Error((e && e.message) || 'The proxy failed'), { status: 502 })); }
        opts = { ...opts, agent: false, createConnection: () => conn };
      }
      finish(mod.request(target, opts, onRes));
      function onRes(res) { try {
        // (The proxy itself said no to the sign-in: a 407 would confuse players, which treat it as their own proxy's.)
        if (proxy && res.statusCode === 407) { res.resume(); return reject(Object.assign(new Error('Proxy: it wants a different username or password'), { status: 502 })); }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 6) {
          res.resume();
          const next = new URL(res.headers.location, u).href;
          return get(next, { method, headers, hops: hops + 1, proxy }).then(resolve, reject);
        }
        res.finalUrl = u.href;
        resolve(res);
      } catch (e) { res.resume(); reject(Object.assign(e instanceof Error ? e : new Error(String(e)), { status: 502 })); } } // (a bad redirect)
      function finish(req) {
        req.on('timeout', () => req.destroy(new Error('The provider didn’t answer in time')));
        req.on('error', (e) => reject(proxy ? Object.assign(new Error((e && e.message) || 'The proxy failed'), { status: 502 }) : e));
        req.end();
      }
      // (A header the request can't carry, and the like: an answer, not a promise that never settles.)
    } catch (e) { reject(Object.assign(e instanceof Error ? e : new Error(String(e)), { status: 502 })); } }, reject);
  });
}

const isPlaylist = (res, url, head) => /mpegurl/i.test(res.headers['content-type'] || '') || /\.m3u8?(\?|$)/i.test(url) || /^\s*#EXTM3U/.test(head);

/** Every address in an HLS playlist → a signed relay address (relative ones resolved first). */
function rewrite(text, base, o) {
  const sign = (ref) => { try { return signPath({ u: new URL(ref, base).href, h: o.h, e: o.e, ...(o.p ? { p: o.p } : {}) }); } catch { return ref; } };
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
  try { up = await get(o.u, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, proxy: o.p || '' }); } catch (e) {
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
  // ("bytes=0-" is the whole thing: ffmpeg asks for playlists that way, and they went back unrewritten.)
  const maybe = up.statusCode < 400 && req.method !== 'HEAD' && (!req.headers.range || /^bytes=0-$/i.test(String(req.headers.range).trim())) && !/^(video|audio|image)\//i.test(ct);
  if (maybe) {
    const first = await new Promise((ok) => {
      const done = (c) => { up.off('data', done); up.off('end', end); up.off('close', end); up.off('error', end); up.pause(); ok(c || null); };
      const end = () => done(null);
      up.on('data', done); up.on('end', end); up.on('close', end); up.on('error', end); // (the provider hung up before the first byte)
    });
    if (res.destroyed) { up.destroy(); return; }
    if (!first && up.destroyed && !up.complete) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('The provider hung up'); }
    // (By its first bytes above all: an address ending .m3u8 that sends the video itself — it starts with a transport
    // stream's 0x47 — was read as a playlist until it was "too big".)
    const startsM3u = !!first && /^\s*(\ufeff)?#EXTM3U/.test(first.slice(0, 64).toString('utf8'));
    const looks = startsM3u || ((/mpegurl/i.test(ct) || /\.m3u8?(\?|$)/i.test(up.finalUrl)) && !(first && first[0] === 0x47));
    if (looks) {
      const chunks = first ? [first] : []; let size = first ? first.length : 0;
      up.resume();
      for await (const c of up) { size += c.length; if (size > MAX_PLAYLIST) { up.destroy(); res.writeHead(502); return res.end('Playlist too big'); } chunks.push(c); }
      const text = Buffer.concat(chunks).toString('utf8');
      const out = Buffer.from(isPlaylist(up, up.finalUrl, text.slice(0, 200)) ? rewrite(text, up.finalUrl, o) : text);
      res.writeHead(up.statusCode === 206 ? 200 : up.statusCode, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': out.length, 'Cache-Control': 'no-store' });
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
const CHUNK = 1 << 20;                 // bookkeeping unit: which MBs of a film are here
const BLOCK = Number(process.env.RELAY_BLOCK_MB || 16) * CHUNK; // kept in pieces this big, so watched parts can go
const NEAR = 8 * CHUNK;                // a reader this far ahead of the download just waits for it
const IDLE_STOP = Number(process.env.RELAY_IDLE_STOP_MS) || 120000; // nobody reading for this long: stop downloading
// (sooner when the server says nobody's playing it any more: see /downloads)
const KEEP_FOR = 6 * 3600e3;           // a film nobody has used for this long is deleted (and after twice its length)
const AHEAD = Number(process.env.RELAY_AHEAD_S) || 600;  // the aim: 10 minutes ready ahead of every viewer
const BACK = Number(process.env.RELAY_BACK_S) || 600;    // what's kept behind the viewer: 10 minutes at most
const MIN_RUN = Number(process.env.RELAY_MIN_RUN_MS) || 20000; // a download keeps its connection this long before another film may take it
const SWAP = Number(process.env.RELAY_SWAP_S) || 240;    // …and gives it up early to a viewer this much further behind
const GUESS_LEN = 6600;                // a film's length when the server doesn't know it (1 h 50)
const SETTLED = Number(process.env.RELAY_STRAIN_AFTER_MS) || 20000; // (waiting just after starting or seeking isn't struggling)
const wholes = new Map();              // key → Whole
const budgets = new Map();             // provider account → { n, at }: provider connections the relay may use for its films
const strain = [];                     // times it couldn't keep up (for the server: Admin → Statistics)
let strainSeq = 0;

/**
 * One film being fetched whole. `have` marks the MBs that are on disk, in BLOCK-sized files (so the part already
 * watched can be deleted). One provider connection at a time ("a run") fills it from some point onwards; a reader that
 * needs a part that isn't here, and isn't coming soon, moves the run there. When a run reaches a part that's already
 * here, the next run starts at the next gap — first after the furthest-behind reader, then from the part still kept —
 * until everything is in.
 *
 * Films of one provider account share its connections (the server says how many: see budgets): the scheduler below
 * decides which films get one, so that every viewer has at least AHEAD seconds ready.
 */
class Whole {
  constructor(key, o) {
    this.key = key; this.o = o; this.ids = new Set(o.i ? [String(o.i)] : []);
    this.acct = typeof o.a === 'string' ? o.a.slice(0, 40) : '';
    this.len = Number(o.d) > 0 ? Number(o.d) : 0;
    this.size = 0; this.type = 'application/octet-stream'; this.ranges = true;
    this.have = null; this.haveCount = 0; this.chunks = 0;
    this.fds = new Map(); this.floor = 0; this.trimmed = 0;
    this.readers = new Set(); this.waiters = new Set();
    this.run = null; this.failed = null; this.done = false; this.bypass = false; this.errors = 0;
    this.parked = false; this.starting = false; this.grantWait = null; this.asking = 0; this.wantAt = -1;
    this.lastUse = Date.now(); this.idleTimer = null; this.started = Date.now();
  }
  headers() { return { 'User-Agent': 'VLC/3.0.21 LibVLC/3.0.21', Accept: '*/*', ...(this.o.h || {}) }; }
  chunkHave(i) { return !!(this.have && this.have[i]); }
  /** Bytes a second of the film (its size over its length). */
  bps() { return this.size / (this.len || GUESS_LEN) || 1; }
  // ---- the pieces on disk
  blockFile(b) { return pathMod.join(CACHE_DIR, `${this.key}.${b}.bin`); }
  fdOf(b) {
    let fd = this.fds.get(b);
    if (fd != null) { this.fds.delete(b); this.fds.set(b, fd); return fd; }
    fd = fs.openSync(this.blockFile(b), fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
    this.fds.set(b, fd);
    if (this.fds.size > 12) { const [ob, ofd] = this.fds.entries().next().value; this.fds.delete(ob); try { fs.closeSync(ofd); } catch {} }
    return fd;
  }
  /** Writes buf at byte pos of the film (across pieces as needed). */
  writeAt(buf, pos) {
    return new Promise((ok, no) => {
      const step = (off) => {
        if (off >= buf.length) return ok();
        const p = pos + off, b = Math.floor(p / BLOCK), n = Math.min(buf.length - off, (b + 1) * BLOCK - p);
        let fd;
        try { fd = this.fdOf(b); } catch (e) { return no(e); }
        fs.write(fd, buf, off, n, p - b * BLOCK, (err) => (err ? no(err) : step(off + n)));
      };
      step(0);
    });
  }
  /** Reads up to n bytes at pos (never past the end of a piece). */
  readAt(buf, n, pos) {
    const b = Math.floor(pos / BLOCK);
    n = Math.min(n, (b + 1) * BLOCK - pos);
    return new Promise((ok, no) => { let fd; try { fd = this.fdOf(b); } catch (e) { return no(e); } fs.read(fd, buf, 0, n, pos - b * BLOCK, (err, k) => (err ? no(err) : ok(k))); });
  }
  /** Deletes one piece: its MBs are no longer here. */
  dropBlock(b) {
    const fd = this.fds.get(b);
    if (fd != null) { try { fs.closeSync(fd); } catch {} this.fds.delete(b); }
    try { fs.unlinkSync(this.blockFile(b)); } catch {}
    let n = 0;
    for (let i = (b * BLOCK) / CHUNK; i < Math.min(this.chunks, ((b + 1) * BLOCK) / CHUNK); i++) if (this.have[i]) { this.have[i] = 0; this.haveCount--; n++; }
    this.trimmed += Math.min(n * CHUNK, this.size);
  }
  /**
   * The part already watched goes: everything more than BACK seconds behind the furthest-behind viewer (the first and
   * the last piece stay — players read the film's index there). Nothing goes while nobody is reading.
   */
  trim() {
    if (!this.have || !this.readers.size || this.size <= 3 * BLOCK) return;
    const behind = Math.min(...[...this.readers].map((x) => x.pos));
    const cut = behind - BACK * this.bps();
    if (cut <= BLOCK) return;
    this.floor = Math.max(this.floor, Math.floor(cut / CHUNK) * CHUNK);
    const last = Math.floor((this.size - 1) / BLOCK);
    const r = this.run;
    for (let b = 1; b < last && (b + 1) * BLOCK <= cut; b++) {
      if (r && r.from < (b + 1) * BLOCK && r.at >= b * BLOCK) continue; // (being written)
      let any = false;
      for (let i = (b * BLOCK) / CHUNK; i < ((b + 1) * BLOCK) / CHUNK; i++) if (this.have[i]) { any = true; break; }
      if (any) this.dropBlock(b);
    }
  }
  /** The end (exclusive) of the bytes readable from p onwards: whole MBs that are in, then the running download. */
  availEnd(p, limit) {
    if (!this.have || p >= this.size) return p;
    let i = Math.floor(p / CHUNK);
    const stop = limit ? Math.min(this.chunks, Math.ceil(limit / CHUNK)) : this.chunks;
    while (i < stop && this.have[i]) i++;
    let end = Math.min(i * CHUNK, this.size);
    const r = this.run;
    if (r && r.from <= end && r.written > end) end = r.written;
    return Math.max(end, p);
  }
  /** Seconds of film ready for a reader (Infinity once it's all there to the end). */
  aheadOf(x) { const e = this.availEnd(x.pos); return e >= this.size ? Infinity : (e - x.pos) / this.bps(); }
  /** The least any of its viewers has ready (0 for a film still starting). */
  ahead() {
    if (!this.size) return 0;
    if (!this.readers.size) return Infinity;
    let a = Infinity;
    for (const x of this.readers) a = Math.min(a, this.aheadOf(x));
    return a;
  }
  /** Wants a provider connection: starting, or a viewer has something still to come. */
  wants() {
    if (this.failed || this.bypass) return false;
    if (this.grantWait) return this.asking > 0;
    if (!this.size || !this.readers.size) return false;
    return !this.done || this.ahead() !== Infinity;
  }
  wake() { for (const w of this.waiters) w(); this.waiters.clear(); }
  wait(ms) { return new Promise((ok) => { const t = setTimeout(done, ms); function done() { clearTimeout(t); ok(); } this.waiters.add(done); }); }
  bytesHere() { return Math.min(this.haveCount * CHUNK, this.size); }
  /** What's still to download (from the part still kept to the end). */
  toFetch() {
    if (!this.have) return 0;
    let n = 0;
    for (let i = Math.floor(this.floor / CHUNK); i < this.chunks; i++) if (!this.have[i]) n++;
    return Math.min(n * CHUNK, this.size);
  }
  /** Waits for the scheduler to give this film a provider connection (false: nobody wants it any more). */
  grant() {
    if (mayStart(this)) { this.starting = true; return Promise.resolve(true); } // (taken at once, so two films can't both take the last one)
    this.askedAt = Date.now();
    return new Promise((ok) => { this.grantWait = ok; kick(); });
  }
  /** Starts the first run at `from`; resolves once the size and type are known (or this film can't be done whole). */
  async begin(from) {
    if (!(await this.grant())) return false;
    this.starting = true;
    try {
      from = Math.floor(from / CHUNK) * CHUNK;
      const up = await get(this.o.u, { headers: { ...this.headers(), Range: `bytes=${from}-` }, proxy: this.o.p || '' });
      const ct = up.headers['content-type'] || '';
      let total = 0;
      if (up.statusCode === 206) { const m = /\/(\d+)\s*$/.exec(up.headers['content-range'] || ''); total = m ? Number(m[1]) : 0; }
      else if (up.statusCode === 200) { total = Number(up.headers['content-length']) || 0; this.ranges = false; if (from) from = 0; }
      // (Refused — "too many connections", say: no film this time, but try again next time. A playlist, a page or
      // no size: not something to keep whole.)
      if (up.statusCode >= 400) { up.destroy(); this.retryLater = true; return false; }
      if (!total || /mpegurl|text\/|json|html/i.test(ct) || /\.m3u8?(\?|$)/i.test(up.finalUrl || '')) { up.destroy(); return false; }
      if (!makeRoom(total, this)) { up.destroy(); return false; }
      this.size = total; this.type = ct || 'application/octet-stream';
      this.chunks = Math.ceil(total / CHUNK); this.have = new Uint8Array(this.chunks);
      try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { up.destroy(); return false; }
      this.attach(up, from);
      this.holdSince = Date.now();
      this.armIdle(); // (cleared as soon as someone reads)
      return true;
    } finally { this.starting = false; kick(); }
  }
  /** Writes one provider answer into the film from `from` onwards. */
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
      // (Writes still queued when the run was stopped are dropped: the part may already be deleted as watched,
      // or being fetched by another run.)
      writing = writing.then(() => (r.stop && this.run !== r ? Promise.resolve(false) : this.writeAt(buf, pos).then(() => true)).then((wrote) => {
        if (!this.have || !wrote) return;
        r.written = pos + buf.length;
        gotBy.set(this.acct, (gotBy.get(this.acct) || 0) + buf.length);
        // The MBs this write finished (runs start on an MB boundary, so every MB from `pos` on is this run's).
        for (let i = Math.floor(pos / CHUNK); i < this.chunks; i++) {
          if (Math.min((i + 1) * CHUNK, this.size) > r.written) break;
          if (!this.have[i]) { this.have[i] = 1; this.haveCount++; }
        }
        this.errors = 0;
        this.wake();
        // Ran into a part that's already here (or the end): this run is done.
        const next = r.written / CHUNK;
        if (r.last || r.written >= this.size || (this.ranges && r.written % CHUNK === 0 && this.have[next])) { this.endRun(r); return; }
        if (!r.stop) up.resume();
      }, () => { this.fail(new Error('The relay’s disk is full or failing')); }));
    });
    up.on('end', () => writing.then(() => { if (this.run === r && !r.stop) this.endRun(r); }));
    up.on('error', () => writing.then(() => { if (this.run === r && !r.stop) { this.errors++; this.endRun(r, true); } }));
    up.on('close', () => writing.then(() => { if (this.run === r && !r.stop) { this.errors++; this.endRun(r, true); } }));
  }
  /** Lets go of the open pieces (they're opened again when needed): a finished film, or nobody watching. */
  closeFds() { for (const fd of this.fds.values()) { try { fs.closeSync(fd); } catch {} } this.fds.clear(); }
  /** Nobody reading: after IDLE_STOP the download stops, so the provider connection is free again. */
  armIdle() {
    if (this.readers.size) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.readers.size) { if (this.run) this.stopRun(); this.closeFds(); } }, IDLE_STOP);
  }
  stopRun() { if (this.run) { this.run.stop = true; try { this.run.up.destroy(); } catch {} this.run = null; } this.holdSince = 0; kick(); }
  endRun(r, broken) {
    r.stop = true; try { r.up.destroy(); } catch {}
    if (this.run === r) this.run = null;
    if (this.missingFrom(this.floor) < 0) return this.complete();
    if (broken && this.errors > 4) return this.fail(new Error('The provider keeps dropping the connection'));
    const later = broken ? Math.min(5000, 500 * this.errors) : 0;
    this.retryAt = Date.now() + later;
    // (Another film of this account is waiting for a connection: the scheduler decides who has it next.)
    if (!broken && budgetOf(this.acct) && othersWaiting(this)) { this.holdSince = 0; return kick(); }
    setTimeout(() => this.next(), later);
  }
  /** The first MB not here at or after byte p (-1: none). */
  missingFrom(p) {
    if (!this.have) return -1;
    for (let i = Math.floor(p / CHUNK); i < this.chunks; i++) if (!this.have[i]) return i;
    return -1;
  }
  complete() {
    if (!this.done) log(`whole ${this.key.slice(0, 8)}: all ${(this.size / 1e9).toFixed(2)} GB here in ${Math.round((Date.now() - this.started) / 1000)} s`);
    this.done = true;
    if (this.run) { this.run.stop = true; try { this.run.up.destroy(); } catch {} this.run = null; }
    this.holdSince = 0;
    if (!this.readers.size) this.closeFds();
    this.wake(); kick();
  }
  fail(e) { this.failed = e; if (this.run) { this.run.stop = true; try { this.run.up.destroy(); } catch {} this.run = null; } this.wake(); kick(); }
  /** The next gap to fill: where a viewer is waiting, after the furthest-behind reader, then from the part still kept. */
  next() {
    if (this.failed || this.run || !this.readers.size || !this.have) return;
    if (!mayStart(this)) return kick();
    if (this.wantAt >= 0 && !this.chunkHave(Math.floor(this.wantAt / CHUNK))) { const at = this.wantAt; this.wantAt = -1; return this.startAt(at); }
    this.wantAt = -1;
    const behind = Math.min(...[...this.readers].map((x) => x.pos));
    let i = this.missingFrom(behind);
    if (i < 0) i = this.missingFrom(Math.min(this.floor, behind));
    if (i < 0) return this.complete();
    this.done = false;
    this.startAt(i * CHUNK);
  }
  startAt(from) {
    if (!this.ranges) from = 0;
    if (!this.holdSince) this.holdSince = Date.now();
    if (this.run) { this.run.stop = true; try { this.run.up.destroy(); } catch {} this.run = null; }
    this.done = false;
    const r = { stop: false };
    this.run = { from, at: from, written: from, t0: Date.now(), up: { destroy() { r.stop = true; } } }; // a placeholder while connecting
    const ph = this.run;
    get(this.o.u, { headers: { ...this.headers(), Range: `bytes=${from}-` }, proxy: this.o.p || '' }).then((up) => {
      if (this.run !== ph) return up.destroy();
      // The same film, or nothing: a "too many connections" page or a placeholder video must not land in the file.
      const ct = up.headers['content-type'] || '';
      const m = /\/(\d+)\s*$/.exec(up.headers['content-range'] || '');
      const same = !/mpegurl|text\/|json|html/i.test(ct) && (up.statusCode === 206 ? m && Number(m[1]) === this.size : up.statusCode === 200 && Number(up.headers['content-length']) === this.size);
      if (!same) { up.destroy(); this.run = null; this.errors++; return this.endRun({ up: { destroy() {} }, stop: false }, true); }
      // The provider ignored the range (it sends the whole film from the start): carry on that way.
      if (from && up.statusCode !== 206) { this.ranges = false; from = 0; }
      this.attach(up, from);
      this.run.t0 = ph.t0;
    }, () => { if (this.run === ph) { this.run = null; this.errors++; this.endRun({ up: { destroy() {} }, stop: false }, true); } });
  }
  /** A reader needs byte p: if it isn't here and the download won't reach it soon, move the download there. */
  need(p) {
    if (this.failed) return;
    const r = this.run;
    if (r && r.from <= p && p <= r.at + NEAR) return;
    if (!r && !this.readers.size) return;
    if (!this.ranges && r) return; // can't jump: wait
    // Another reader is being served by the current run (two TVs on one film, or a player reading the start and the
    // end of an MP4): let it get going (a few MB or seconds) before moving it, so they don't keep cancelling each
    // other's download — each move is a new connection to the provider.
    if (r && (r.written - r.from < NEAR && Date.now() - (r.t0 || 0) < 4000) && [...this.readers].some((x) => x.pos >= r.from && x.pos <= r.at + NEAR)) return;
    this.done = false;
    // No connection of its own right now (another film of this account has it): the scheduler decides.
    if (!r && !mayStart(this)) { this.wantAt = Math.floor(p / CHUNK) * CHUNK; return kick(); }
    this.startAt(Math.floor(p / CHUNK) * CHUNK);
  }
  addReader(x) { this.readers.add(x); this.lastUse = Date.now(); clearTimeout(this.idleTimer); if (!this.run) this.next(); kick(); }
  dropReader(x) {
    if (!this.readers.delete(x)) return;
    this.lastUse = Date.now();
    kick();
    if (this.readers.size) return;
    this.armIdle();
  }
  remove() {
    clearTimeout(this.idleTimer);
    if (this.run) { this.run.stop = true; try { this.run.up.destroy(); } catch {} this.run = null; }
    if (this.grantWait) { const g = this.grantWait; this.grantWait = null; g(false); }
    this.closeFds();
    const blocks = this.size ? Math.ceil(this.size / BLOCK) : 0;
    for (let b = 0; b < blocks; b++) { try { fs.unlinkSync(this.blockFile(b)); } catch {} }
    this.have = null;
    if (wholes.get(this.key) === this) wholes.delete(this.key);
    kick();
  }
  status() {
    const a = this.ahead();
    return { ids: [...this.ids], size: this.size, here: this.bytesHere(), done: this.done, downloading: !!this.run, readers: this.readers.size, ahead: a === Infinity ? -1 : Math.round(a), waiting: !this.run && this.wants() };
  }
}

// ---------------------------------------------------------------- sharing an account's connections between films
/** How many provider connections films of this account may use at once (0: as many as they need). */
function budgetOf(a) { const b = a && budgets.get(a); return b ? b.n : 0; }
/** Another film of this account wants a connection and has none. */
const othersWaiting = (w) => { for (const x of wholes.values()) if (x !== w && x.acct === w.acct && !x.run && !x.starting && !x.failed && !x.bypass && x.wants()) return true; return false; };
const runningIn = (a, except) => { let n = 0; for (const w of wholes.values()) if (w !== except && w.acct === a && (w.run || w.starting)) n++; return n; };
/** May this film open a provider connection now (it has none, and its account has one free)? */
function mayStart(w) {
  if (w.run || w.starting) return true;
  const n = budgetOf(w.acct);
  if (!n) return true;
  if (w.parked) return false;
  return runningIn(w.acct, w) < n;
}
let kicked = false;
function kick() { if (kicked) return; kicked = true; setImmediate(() => { kicked = false; schedule(); }); }
/** Hands this film the connection (its first, or another film's). */
function resume(w) {
  w.parked = false;
  if (!w.grantWait && w.retryAt > Date.now()) return; // (the provider just dropped it: after a pause)
  if (w.grantWait) { const g = w.grantWait; w.grantWait = null; w.starting = true; g(true); return; }
  if (!w.run) w.next();
}
/**
 * For every provider account with a limit: the films whose viewers have the least ready get the connections. A film
 * that's running gives its connection up when another viewer is short of AHEAD seconds and it has more than that
 * itself (or SWAP seconds more than them) — once it has had it for MIN_RUN, so connections don't flap. Films nobody is
 * watching give theirs up first. Spare connections keep fetching ahead (all of a film, if there's time).
 */
function schedule() {
  const now = Date.now();
  const byAcct = new Map();
  for (const w of wholes.values()) {
    if (w.failed || w.bypass) continue;
    // The "starting" film whose request is gone: nobody wants it any more.
    if (w.grantWait && w.asking <= 0) { w.remove(); continue; }
    (byAcct.get(w.acct) || byAcct.set(w.acct, []).get(w.acct)).push(w);
  }
  for (const [a, list] of byAcct) {
    const n = budgetOf(a);
    const st = list.map((w) => ({ w, ahead: w.ahead(), wants: w.wants() }));
    if (!n) { for (const s of st) if (s.wants && !s.w.run && !s.w.starting) resume(s.w); noteStrain(a, st, 0, now); continue; }
    let running = st.filter((s) => s.w.run || s.w.starting);
    // Fewer connections than before (someone started watching live TV on this account): the ones with the most ready stop.
    while (running.length > n) {
      const v = running.filter((s) => !s.w.starting).sort((x, y) => y.ahead - x.ahead)[0];
      if (!v) break;
      v.w.parked = true; v.w.stopRun(); running = running.filter((s) => s !== v);
    }
    const waiting = st.filter((s) => s.wants && !s.w.run && !s.w.starting && (s.w.grantWait || !(s.w.retryAt > now))).sort((x, y) => x.ahead - y.ahead);
    for (const c of waiting) {
      if (running.length < n) { resume(c.w); running.push(c); continue; }
      if (c.ahead >= AHEAD) break;
      const v = running.filter((s) => s.w.run && !s.w.starting && (!s.w.readers.size || now - (s.w.holdSince || s.w.run.t0 || 0) >= MIN_RUN)).sort((x, y) => y.ahead - x.ahead)[0];
      if (!v || !(!v.w.readers.size || v.ahead >= AHEAD + 60 || v.ahead - c.ahead >= SWAP)) break;
      v.w.parked = true; v.w.stopRun();
      running = running.filter((s) => s !== v);
      resume(c.w); running.push(c);
    }
    // (Everyone else may run when there's room.)
    for (const s of st) if (s.w.parked && !s.wants) s.w.parked = false;
    noteStrain(a, st, n, now);
  }
}
setInterval(() => { schedule(); for (const w of wholes.values()) try { w.trim(); } catch {} }, Number(process.env.RELAY_TICK_MS) || 1000).unref();

/**
 * Struggling to keep up: the films being watched on an account need more than the provider is sending (over the last
 * 20 s) while someone has less than half of AHEAD ready, or someone pressed play and has waited more than 5 s for a
 * connection. (How long a viewer waits for the next bytes says little: the player has its own store of the film.)
 * Noted at most once a minute per account, with the worst of it, for the server to show when it happened.
 */
const lastStrain = new Map();
const gotBy = new Map();   // account → bytes fetched for its films so far
const rateLog = new Map(); // account → [[time, bytes so far], …] (the last 20 s)
function noteStrain(a, st, n, now) {
  const hist = rateLog.get(a) || [];
  hist.push([now, gotBy.get(a) || 0]);
  while (hist.length > 2 && now - hist[1][0] >= 20000) hist.shift();
  rateLog.set(a, hist);
  const span = (now - hist[0][0]) / 1000;
  const rate = span * 1000 >= Math.min(10000, SETTLED) ? (hist[hist.length - 1][1] - hist[0][1]) / span : Infinity;
  let viewers = 0, stalled = 0, least = Infinity, need = 0;
  for (const s of st) {
    viewers += s.w.readers.size;
    // Someone pressed play and is still waiting for the film to start, because the connections are all busy.
    if (s.w.grantWait && s.w.asking > 0 && now - s.w.askedAt > 5000) { viewers++; stalled++; least = 0; }
    let settled = false;
    for (const x of s.w.readers) {
      if (now - x.t0 < SETTLED) continue;
      settled = true;
      least = Math.min(least, s.w.aheadOf(x));
    }
    if (settled && s.ahead !== Infinity) need += s.w.bps();
  }
  const short = need > 0 && rate < need * 0.95 && least < AHEAD / 2;
  const runs = st.filter((s) => s.w.run).length;
  if (!stalled && !short) return;
  const prev = lastStrain.get(a);
  if (prev && now - prev.t < 60000) { prev.stalled = Math.max(prev.stalled, stalled); prev.viewers = Math.max(prev.viewers, viewers); prev.least = Math.min(prev.least, Math.round(least)); return; }
  const e = { seq: ++strainSeq, t: now, a, viewers, films: st.filter((s) => s.w.readers.size).length, runs, budget: n, least: least === Infinity ? -1 : Math.round(least), stalled, need: Math.round(need), rate: rate === Infinity ? -1 : Math.round(rate) };
  lastStrain.set(a, e);
  strain.push(e);
  if (strain.length > 500) strain.splice(0, strain.length - 500);
  log(`can't keep up${a ? ' (account ' + a.slice(0, 6) + ')' : ''}: ${viewers} watching, ${runs}${n ? ' of ' + n : ''} connections, ${stalled} waiting to start${least < Infinity ? ', least ready ' + Math.round(least) + ' s' : ''}${need ? `, needs ${(need * 8 / 1e6).toFixed(1)} Mbit/s, getting ${rate === Infinity ? '?' : (rate * 8 / 1e6).toFixed(1)}` : ''}`);
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
    let r = diskFree() - KEEP_FREE - o.reduce((s, w) => s + w.toFetch(), 0);
    if (CACHE_LIMIT) r = Math.min(r, CACHE_LIMIT - o.reduce((s, w) => s + w.bytesHere() + w.toFetch(), 0));
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
    if (![...w.ids].some((i) => activeIds.has(i))) w.stopRun();
  }
}
// A film is kept for at most twice its length (and never more than KEEP_FOR unused) once nobody is watching it.
setInterval(() => {
  const now = Date.now();
  for (const w of [...wholes.values()]) {
    if (w.readers.size || w.grantWait || w.starting || w.asking > 0) continue;
    const old = now - w.started > 2 * (w.len || GUESS_LEN) * 1000;
    if (old || now - w.lastUse > KEEP_FOR || (w.bypass && now - w.started > 10 * 60e3)) w.remove();
  }
}, Number(process.env.RELAY_SWEEP_MS) || 60e3).unref();

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
    w.ready = w.begin(m && m[1] === '' ? 0 : a).catch(() => { w.retryLater = true; return false; }).then((ok) => {
      if (!ok && wholes.get(key) === w && !w.have) { if (w.retryLater) w.remove(); else w.bypass = true; }
      return ok;
    });
  }
  if (o.i) w.ids.add(String(o.i));
  if (Number(o.d) > 0 && !w.len) w.len = Number(o.d);
  // (Waiting for a connection of its own: a viewer who gives up meanwhile no longer counts.)
  w.asking++;
  let gone = false;
  const left = () => { if (!gone) { gone = true; w.asking--; kick(); } };
  res.on('close', left);
  let ok;
  try { ok = await w.ready; } finally { left(); }
  if (res.destroyed) { if (ok) w.armIdle(); return; }
  if (!ok || w.bypass) return relay(req, res, o);
  const size = w.size;
  let b = size - 1;
  if (m) {
    if (m[1] === '') { a = Math.max(0, size - Number(m[2] || 0)); }
    else if (m[2] !== '') b = Math.min(Number(m[2]), size - 1);
    if (a >= size || a > b) { w.armIdle(); res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
  }
  const head = { 'Content-Type': w.type, 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1, 'Cache-Control': 'no-store' };
  if (m) head['Content-Range'] = `bytes ${a}-${b}/${size}`;
  res.writeHead(m ? 206 : 200, head);
  if (req.method === 'HEAD') { w.armIdle(); return res.end(); }
  const reader = { pos: a, t0: Date.now(), waitSince: 0 };
  w.addReader(reader);
  res.on('close', () => w.dropReader(reader));
  try {
    let p = a;
    const buf = Buffer.allocUnsafe(CHUNK);
    while (p <= b && !res.destroyed) {
      if (!w.have) throw new Error('gone');
      const end = Math.min(w.availEnd(p, Math.min(b + 1, p + 2 * CHUNK)), b + 1);
      if (end > p) {
        reader.waitSince = 0;
        let got;
        try { got = await w.readAt(buf, Math.min(end - p, CHUNK), p); } catch (e) { if (w.have && !w.chunkHave(Math.floor(p / CHUNK))) continue; throw e; }
        if (!got) { if (w.have && !w.chunkHave(Math.floor(p / CHUNK))) continue; throw new Error('read'); }
        if (!res.write(Buffer.from(buf.subarray(0, got)))) await drained(res);
        p += got; reader.pos = p; w.lastUse = Date.now();
        continue;
      }
      if (w.failed) throw w.failed;
      if (!reader.waitSince) reader.waitSince = Date.now();
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

const sameSig = (a, b) => { a = Buffer.from(String(a || '')); b = Buffer.from(String(b || '')); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const signedQuery = (req, what) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const t = q.get('t') || '';
  return /^\d+$/.test(t) && Math.abs(Date.now() / 1000 - Number(t)) < 300 && sameSig(q.get('s'), sigOf(what + ':' + t));
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
  // The server asks which films are fully here (their provider connection is free again), says how many provider
  // connections each account's films may use, and collects the times the relay couldn't keep up.
  if (path === '/downloads') {
    const q = new URL(req.url, 'http://x').searchParams;
    const playing = q.get('playing') || '';
    if (!signedQuery(req, 'downloads:' + playing)) { res.writeHead(403); return res.end(); }
    if (q.has('playing')) stopUnwatched(new Set(playing.split(',').filter(Boolean)));
    const bq = q.get('budget');
    if (bq !== null && q.get('bs') === sigOf('budget:' + bq + ':' + q.get('t'))) {
      const now = Date.now();
      for (const part of bq.split(',')) { const [acct, n] = part.split(':'); if (acct && /^\d+$/.test(n || '')) budgets.set(acct.slice(0, 40), { n: Math.min(64, Number(n)), at: now }); }
      for (const [acct, v] of budgets) if (now - v.at > 10 * 60e3) budgets.delete(acct); // (no word for 10 minutes: no limit known)
      kick();
    }
    const since = Number(q.get('since')) || 0;
    const accts = {};
    for (const w of wholes.values()) {
      if (!w.size || w.bypass) continue;
      const x = accts[w.acct] || (accts[w.acct] = { budget: budgetOf(w.acct), runs: 0, viewers: 0, films: 0, waiting: 0 });
      if (w.run) x.runs++;
      x.viewers += w.readers.size;
      if (w.readers.size) x.films++;
      if (!w.run && w.wants()) x.waiting++;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, version: VERSION, films: [...wholes.values()].filter((w) => w.size && !w.bypass).map((w) => w.status()), accounts: accts, strain: strain.filter((e) => e.seq > since), seq: strainSeq }));
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
    const up = (u.protocol === 'https:' ? https : http).request(u, { method: req.method, headers: h }, (r) => { res.writeHead(r.statusCode, r.headers); r.on('error', () => res.destroy()); r.pipe(res); });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    // (The server stopped fetching — a film abandoned, a channel changed: the provider's connection goes too. It used
    // to stay open, holding one of the account's connections.)
    res.on('close', () => up.destroy());
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
  // One bad connection must not stop everyone's streams: note it and carry on.
  process.on('uncaughtException', (e) => log('error: ' + ((e && e.stack) || e)));
  // Films left over from before a restart: their bookkeeping is gone, so start afresh.
  try { for (const f of fs.readdirSync(CACHE_DIR)) if (/^[0-9a-f]{32}(\.\d+)?\.bin(\.\w+)?$/.test(f)) fs.unlinkSync(pathMod.join(CACHE_DIR, f)); } catch {}
  server.listen(PORT, () => log(`Stream relay ${VERSION} on port ${PORT} (whole films kept in ${CACHE_DIR}, ${(diskFree() / 1e9).toFixed(0)} GB free)`));
  if (PROXY_PORT) startProxy();
}
module.exports = { signPath, seal, open, rewrite, isPrivate, VERSION, Whole, schedule, budgets };
