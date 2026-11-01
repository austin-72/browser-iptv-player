'use strict';
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { Readable } = require('stream');

/**
 * fetch() that also works for streams on "bad ports".
 * Node's built-in fetch follows the browser rule that refuses ports such as 554, 5060, 6000 or
 * 10080. IPTV servers do sometimes use them, so when fetch refuses a port this falls back to a
 * plain http(s) request that returns the same shape (ok, status, url, headers, body, text...).
 */
async function fetchAny(url, opts = {}) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    const why = String((e.cause && e.cause.message) || e.message);
    if (!/bad port/i.test(why)) throw e;
    return legacy(url, opts, 0);
  }
}

function legacy(url, opts, hops) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const headers = { 'Accept-Encoding': 'gzip, deflate', ...(opts.headers || {}) };
    const req = mod.request(u, { method: opts.method || 'GET', headers, signal: opts.signal }, (res) => {
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
    });
    req.on('error', (err) => reject(new TypeError('fetch failed', { cause: err })));
    req.setTimeout(30000, () => req.destroy(new Error('timed out')));
    req.end();
  });
}

module.exports = { fetchAny };
