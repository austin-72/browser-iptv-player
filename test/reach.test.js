'use strict';
// node test/reach.test.js — the server's "can the browser reach this directly?" check against a fake provider.
const http = require('http');
const assert = require('assert');
const { Reach, xtreamHls, httpsCopy } = require('../lib/reach');
const { Proxy } = require('../lib/proxy');

const TS = Buffer.alloc(188 * 3); for (let i = 0; i < 3; i++) TS[i * 188] = 0x47;
const hits = {};
const srv = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  hits[p] = (hits[p] || 0) + 1;
  const open = () => res.setHeader('Access-Control-Allow-Origin', '*');
  const m3u = (body) => { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); res.end(body); };
  const media = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nseg1.ts\n#EXTINF:2,\nseg2.ts\n';
  if (p === '/open/a.m3u8') { open(); return m3u(media); }
  if (p === '/open/seg1.ts') { open(); res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end(TS); }
  if (p === '/shut/a.m3u8') return m3u(media);
  if (p === '/shut/seg1.ts') { res.writeHead(200); return res.end(TS); }
  if (p === '/split/master.m3u8') return m3u('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nv.m3u8\n');
  if (p === '/split/v.m3u8') return m3u(media);
  if (p === '/split/seg1.ts') { open(); res.writeHead(200); return res.end(TS); }
  if (p === '/hop/a.m3u8') { res.writeHead(302, { Location: `http://localhost:${port}/open/a.m3u8` }); return res.end(); }
  if (p === '/noext/stream') return m3u(media.replace(/seg/g, '/open/seg'));
  if (/^\/xt\/(live\/)?u\/p\/\d+(\.ts)?$/.test(p)) { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end(TS); }
  if (/^\/xt\/live\/u\/p\/\d+\.m3u8$/.test(p)) return m3u(media.replace(/seg/g, '/split/seg'));
  if (p === '/vod/movie.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 32 }); return res.end(Buffer.from('\0\0\0\x20ftypisom' + ' '.repeat(20))); }
  res.writeHead(404); res.end();
});
let port;
srv.listen(0, '127.0.0.1', async () => {
  port = srv.address().port;
  const B = `http://127.0.0.1:${port}`;
  const r = new Reach(new Proxy(() => ({ userAgent: 'Test' })));
  const O = 'http://192.168.1.5:8080';
  const check = (u, hdr) => r.check(u, hdr || {}, O, 'Mozilla/5.0');
  let pass = 0;
  const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n      ', e.message); process.exitCode = 1; } };

  await t('open provider → direct', async () => { const x = await check(`${B}/open/a.m3u8`); assert.equal(x.kind, 'hls'); assert.equal(x.mse, true); });
  await t('blocked provider → not direct, no split', async () => { const x = await check(`${B}/shut/a.m3u8`); assert.equal(x.mse, false); assert.equal(x.split, false); });
  await t('blocked playlists, open segments → split', async () => { const x = await check(`${B}/split/master.m3u8`); assert.equal(x.mse, false); assert.equal(x.split, true); assert.ok(x.splitUrl.startsWith('/api/proxy?')); });
  await t('blocked redirect to an open address → direct to the final address', async () => { const x = await check(`${B}/hop/a.m3u8`); assert.equal(x.mse, true); assert.equal(x.url, `http://localhost:${port}/open/a.m3u8`); });
  await t('HLS without extension is recognised', async () => { const x = await check(`${B}/noext/stream`); assert.equal(x.kind, 'hls'); assert.equal(x.split, true); });
  await t('blocked Xtream TS → finds its HLS copy', async () => { const x = await check(`${B}/xt/u/p/1`); assert.equal(x.kind, 'ts'); assert.equal(x.mse, false); assert.ok(x.alt && x.alt.split); assert.equal(x.alt.url, `${B}/xt/live/u/p/1.m3u8`); });
  await t('next Xtream channel: no new connection to the provider', async () => { const x = await check(`${B}/xt/u/p/2`); assert.equal(x.kind, 'ts'); assert.ok(x.alt); assert.equal(hits['/xt/u/p/2'] || 0, 0); assert.equal(hits['/xt/live/u/p/2.m3u8'] || 0, 0); });
  await t('MP4 file → kind native (plays in <video> with no permission needed)', async () => { const x = await check(`${B}/vod/movie.mp4`); assert.equal(x.kind, 'native'); assert.equal(x.finite, true); });
  await t('listed headers not actually needed → still direct', async () => { const x = await check(`${B}/open/a.m3u8?h=1`, { h: { 'User-Agent': 'Special' } }); assert.equal(x.blocked, ''); });
  await t('headers really needed → blocked', async () => { const x = await check(`${B}/needs-headers`, { h: { Cookie: 'a=b' } }); assert.equal(x.blocked, 'headers'); });
  await t('https page + http stream with no https copy → mixed', async () => { const x = await r.check(`${B}/open/a.m3u8`, {}, 'https://tv.example.com', ''); assert.equal(x.blocked, 'mixed'); });
  await t('address helpers', async () => {
    assert.equal(xtreamHls('http://h:8080/user/pw/123'), 'http://h:8080/live/user/pw/123.m3u8');
    assert.equal(xtreamHls('http://h:8080/live/user/pw/123.ts?x=1'), 'http://h:8080/live/user/pw/123.m3u8?x=1');
    assert.equal(xtreamHls('http://h/movie/user/pw/5.mp4'), '');
    assert.equal(httpsCopy('http://cdn.example.com/a.m3u8'), 'https://cdn.example.com/a.m3u8');
    assert.equal(httpsCopy('http://cdn.example.com:8080/a.m3u8'), '');
  });
  const p = new Proxy(() => ({ userAgent: 'T' }));
  await t('split playlists keep segments direct, keys through the server', async () => {
    const out = p.rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nseg1.ts\n', 'http://cdn/x/a.m3u8', { split: 1 });
    assert.ok(out.includes('URI="/api/proxy?'), 'key via server');
    assert.ok(out.includes('URI="http://cdn/x/init.mp4"'), 'init direct');
    assert.ok(out.includes('\nhttp://cdn/x/seg1.ts'), 'segment direct');
    const master = p.rewritePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n', 'http://cdn/x/m.m3u8', { split: 1 });
    assert.ok(master.includes('\n/api/proxy?'), 'variant playlists via server');
  });
  console.log(`${pass} passed`);
  srv.close();
});
