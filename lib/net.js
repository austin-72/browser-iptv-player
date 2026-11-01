'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const zlib = require('zlib');
const { Readable } = require('stream');

/**
 * Outgoing proxies (Admin → Network). `resolver(url)` says which proxy, if any, a request to that address goes
 * through: 'http://user:pass@host:port', 'https://…' or 'socks5://user:pass@host:port'. Redirects keep the proxy
 * of the first address.
 */
let resolver = () => '';
function setProxyResolver(fn) { resolver = typeof fn === 'function' ? fn : () => ''; }
function proxyFor(url) { try { return resolver(url) || ''; } catch { return ''; } }

/** A socket to host:port through the proxy (SOCKS5, or an HTTP(S) proxy's CONNECT). */
function tunnel(proxyUrl, host, port, signal, timeout = 20000) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = new URL(proxyUrl); } catch { return reject(new Error('Bad proxy address')); }
    const user = decodeURIComponent(p.username || ''), pass = decodeURIComponent(p.password || '');
    const isSocks = /^socks/i.test(p.protocol);
    const pport = Number(p.port) || (isSocks ? 1080 : p.protocol === 'https:' ? 443 : 8080);
    const sock = p.protocol === 'https:' ? tls.connect({ host: p.hostname, port: pport, servername: p.hostname }) : net.connect(pport, p.hostname);
    let done = false;
    const fail = (e) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); reject(e instanceof Error ? e : new Error(String(e))); };
    const timer = setTimeout(() => fail(new Error('The proxy didn’t answer')), timeout);
    if (signal) { if (signal.aborted) return fail(new Error('aborted')); signal.addEventListener('abort', () => fail(new Error('aborted')), { once: true }); }
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
    // SOCKS5 (RFC 1928/1929); the proxy looks the name up (socks5h behaviour, which also avoids DNS leaks).
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

/** Can the server reach a test address through this proxy? (Admin → Network → Test) */
async function testProxy(proxyUrl, target = 'https://www.cloudflare.com/cdn-cgi/trace') {
  const t0 = Date.now();
  const res = await fetchAny(target, { proxy: proxyUrl, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  const ip = (text.match(/^ip=(.+)$/m) || [])[1] || '';
  return { ok: res.ok, status: res.status, ms: Date.now() - t0, ip };
}

/**
 * fetch() that also works for streams on "bad ports".
 * Node's built-in fetch follows the browser rule that refuses ports such as 554, 5060, 6000 or
 * 10080. IPTV servers do sometimes use them, so when fetch refuses a port this falls back to a
 * plain http(s) request that returns the same shape (ok, status, url, headers, body, text...).
 */
async function fetchAny(url, opts = {}) {
  const proxy = opts.proxy !== undefined ? opts.proxy : proxyFor(url);
  if (proxy) return legacy(url, { ...opts, proxy }, 0);
  try {
    return await fetch(url, opts);
  } catch (e) {
    const why = String((e.cause && e.cause.message) || e.message);
    if (!/bad port/i.test(why)) throw e;
    return legacy(url, opts, 0);
  }
}

async function legacy(url, opts, hops) {
  const u = new URL(url);
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  let reqOpts = {};
  if (opts.proxy) {
    const p = new URL(opts.proxy);
    if (u.protocol === 'http:' && /^https?:$/.test(p.protocol)) {
      // Plain http through an HTTP proxy: ask the proxy for the full address.
      const auth = p.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}` } : {};
      reqOpts = { viaProxy: { mod: p.protocol === 'https:' ? https : http, host: p.hostname, port: Number(p.port) || (p.protocol === 'https:' ? 443 : 8080), path: u.href, headers: { Host: u.host, ...auth } } };
    } else {
      const sock = await tunnel(opts.proxy, u.hostname, port, opts.signal);
      const conn = u.protocol === 'https:' ? tls.connect({ socket: sock, servername: u.hostname }) : sock;
      reqOpts = { agent: false, createConnection: () => conn };
    }
  }
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const headers = { 'Accept-Encoding': 'gzip, deflate', ...(opts.headers || {}) };
    const done = (res) => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location && opts.redirect !== 'manual') {
        res.resume();
        if (hops >= 10) return reject(new TypeError('fetch failed', { cause: new Error('too many redirects') }));
        return resolve(legacy(new URL(res.headers.location, u).href, opts, hops + 1));
      }
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) v.forEach((x) => h.append(k, x)); else if (v != null) h.set(k, String(v));
      }
      let stream = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      const empty = code === 204 || code === 304 || opts.method === 'HEAD';
      let web = null;
      const buf = async () => {
        const parts = [];
        for await (const c of stream) parts.push(c);
        return Buffer.concat(parts);
      };
      resolve({
        ok: code >= 200 && code < 300, status: code, statusText: res.statusMessage || '', url: u.href, headers: h, get body() { if (empty) return null; return web || (web = Readable.toWeb(stream)); }, redirected: hops > 0,
        text: async () => (await buf()).toString('utf8'),
        arrayBuffer: async () => { const b = await buf(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
        json: async () => JSON.parse((await buf()).toString('utf8')),
      });
    };
    const vp = reqOpts.viaProxy;
    const req = vp
      ? vp.mod.request({ host: vp.host, port: vp.port, path: vp.path, method: opts.method || 'GET', headers: { ...headers, ...vp.headers }, signal: opts.signal }, done)
      : mod.request(u, { method: opts.method || 'GET', headers, signal: opts.signal, ...reqOpts }, done);
    req.on('error', (err) => reject(new TypeError('fetch failed', { cause: err })));
    req.setTimeout(30000, () => req.destroy(new Error('timed out')));
    req.end();
  });
}

module.exports = { fetchAny, setProxyResolver, proxyFor, testProxy, tunnel };
