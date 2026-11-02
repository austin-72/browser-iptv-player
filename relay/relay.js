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
//
// How it's used: the server signs each stream address with the secret (lib/streamrelay.js). The relay checks the
// signature and the expiry, fetches the address with the headers the provider needs, and passes the answer on with
// permission for web pages to read it (CORS). HLS playlists are rewritten so their segments, keys and variants come
// through the relay too.
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');
const crypto = require('crypto');
const { Readable } = require('stream');

const VERSION = '1';
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
/** { u, h, e } → "/e/<sealed>/<name>" (the name keeps the file type visible to players). */
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
    res.writeHead(e.status || 502, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(e.message || 'The provider couldn’t be reached');
  }
  const ct = up.headers['content-type'] || '';
  const headersOut = () => { const h = { 'Cache-Control': up.headers['cache-control'] || 'no-store' }; for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) if (up.headers[k]) h[k] = up.headers[k]; return h; };
  // Playlists: read (they're small), rewrite, send. Recognised by type, name, or their first bytes.
  const maybe = up.statusCode < 400 && req.method !== 'HEAD' && !req.headers.range && !/^(video|audio|image)\//i.test(ct);
  if (maybe) {
    const first = await new Promise((ok) => { const done = (c) => { up.off('data', done); up.off('end', end); up.pause(); ok(c || null); }; const end = () => done(null); up.on('data', done); up.on('end', end); });
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

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Max-Age': '86400' }); return res.end(); }
  const path = (req.url || '/').split('?')[0];
  // The server's test: is the secret the same? (Answers with nothing else.)
  if (path === '/check') {
    const q = new URL(req.url, 'http://x').searchParams;
    const t = q.get('t') || '';
    const ok = /^\d+$/.test(t) && Math.abs(Date.now() / 1000 - Number(t)) < 300 && q.get('s') === sigOf('check:' + t);
    res.writeHead(ok ? 200 : 403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(ok ? { ok: true, version: VERSION, streams: active.size } : { ok: false, error: 'The secret doesn’t match' }));
  }
  if (path === '/' || path === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('Stream relay ' + VERSION + '\n'); }
  const m = /^\/e\/([A-Za-z0-9_-]+)(?:\/[^/]*)?$/.exec(path);
  if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404); return res.end(); }
  const o = open(m[1]);
  if (!o) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('This address isn’t valid (or has expired)'); }
  try { await relay(req, res, o); } catch (e) { if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy(); }
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
  server.listen(PORT, () => log(`Stream relay ${VERSION} on port ${PORT}`));
  if (PROXY_PORT) startProxy();
}
module.exports = { signPath, seal, open, rewrite, isPrivate };
