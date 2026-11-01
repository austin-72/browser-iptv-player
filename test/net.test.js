'use strict';
// node test/net.test.js — outgoing requests through HTTP and SOCKS5 proxies (all local, no network).
const assert = require('assert');
const http = require('http');
const net = require('net');
const { fetchAny, tunnel, setProxyResolver } = require('../lib/net');

const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));
let seen = { http: 0, connect: 0, socks: 0 };

(async () => {
  const target = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`hello ${req.url}`); });
  const tport = await listen(target);

  // HTTP proxy: absolute-form requests and CONNECT tunnels, user "u" / password "p w".
  const hproxy = http.createServer((req, res) => {
    if (req.headers['proxy-authorization'] !== 'Basic ' + Buffer.from('u:p w').toString('base64')) { res.writeHead(407); return res.end(); }
    seen.http++;
    const u = new URL(req.url);
    const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.end();
  });
  hproxy.on('connect', (req, sock) => {
    seen.connect++;
    const [h, p] = req.url.split(':');
    const up = net.connect(Number(p), h, () => { sock.write('HTTP/1.1 200 Connection established\r\n\r\n'); up.pipe(sock); sock.pipe(up); });
  });
  const hport = await listen(hproxy);

  // SOCKS5 with username/password.
  const socks = net.createServer((c) => {
    let stage = 0, buf = Buffer.alloc(0);
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 3) { buf = buf.slice(2 + buf[1]); c.write(Buffer.from([5, 2])); stage = 1; }
      if (stage === 1 && buf.length >= 2) {
        const ul = buf[1], u = buf.slice(2, 2 + ul).toString(), pl = buf[2 + ul], p = buf.slice(3 + ul, 3 + ul + pl).toString();
        buf = buf.slice(3 + ul + pl);
        c.write(Buffer.from([1, u === 'me' && p === 'secret' ? 0 : 1]));
        stage = 2;
      }
      if (stage === 2 && buf.length >= 7) {
        const hl = buf[4], host = buf.slice(5, 5 + hl).toString(), port = buf.readUInt16BE(5 + hl);
        buf = Buffer.alloc(0); stage = 3; seen.socks++;
        const up = net.connect(port, host, () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); up.pipe(c); c.pipe(up); });
      }
    });
  });
  const sport = await listen(socks);

  let pass = 0;
  const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n      ', e.message); process.exitCode = 1; } };
  const url = `http://127.0.0.1:${tport}/x?y=1`;

  await t('no proxy', async () => { const r = await fetchAny(url); assert.strictEqual(await r.text(), 'hello /x?y=1'); });
  await t('http proxy (plain http address)', async () => {
    const r = await fetchAny(url, { proxy: `http://u:p%20w@127.0.0.1:${hport}` });
    assert.strictEqual(await r.text(), 'hello /x?y=1'); assert.strictEqual(seen.http, 1);
  });
  await t('http proxy: wrong password is reported', async () => { const r = await fetchAny(url, { proxy: `http://u:nope@127.0.0.1:${hport}` }); assert.strictEqual(r.status, 407); });
  await t('http proxy CONNECT tunnel', async () => {
    const sock = await tunnel(`http://u:p%20w@127.0.0.1:${hport}`, '127.0.0.1', tport);
    const body = await new Promise((ok) => { let s = ''; sock.on('data', (d) => { s += d; if (s.includes('hello')) ok(s); }); sock.write(`GET /t HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`); });
    assert.ok(/hello \/t/.test(body)); sock.destroy();
  });
  await t('socks5 with login', async () => { const r = await fetchAny(url, { proxy: `socks5://me:secret@127.0.0.1:${sport}` }); assert.strictEqual(await r.text(), 'hello /x?y=1'); assert.strictEqual(seen.socks, 1); });
  await t('socks5 wrong login fails clearly', async () => { await assert.rejects(fetchAny(url, { proxy: `socks5://me:bad@127.0.0.1:${sport}` }), /username or password/); });
  await t('resolver picks the proxy per address', async () => {
    setProxyResolver((u) => (u.includes(`:${tport}/`) ? `socks5://me:secret@127.0.0.1:${sport}` : ''));
    const r = await fetchAny(url); assert.strictEqual(await r.text(), 'hello /x?y=1'); assert.strictEqual(seen.socks, 2);
    setProxyResolver(null);
  });
  await t('streams a body through the proxy', async () => {
    const r = await fetchAny(url, { proxy: `socks5://me:secret@127.0.0.1:${sport}` });
    const reader = r.body.getReader(); const { value } = await reader.read(); assert.ok(Buffer.from(value).toString().startsWith('hello'));
  });
  console.log(`${pass} passed`);
  target.close(); hproxy.close(); socks.close();
  setTimeout(() => process.exit(), 100);
})();
