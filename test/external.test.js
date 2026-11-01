// "Open in another app": which address an outside player gets (lib/routes-p1.js).
const test = require('node:test');
const assert = require('node:assert');
const register = require('../lib/routes-p1');

function setup(items) {
  const routes = {};
  const HttpError = class extends Error { constructor(status, msg) { super(msg); this.status = status; } };
  register({
    route: (m, pat, fn) => { routes[m + ' ' + pat] = fn; },
    requireProfile: (ctx) => { if (!ctx.profile) throw new HttpError(403, 'no profile'); return ctx.profile; },
    readJSON: async (req) => req.body,
    HttpError,
    item: (ctx, k) => { const it = items[k]; if (!it) throw new HttpError(404, 'Not found'); return it; },
    inputOf: (it, alt) => {
      if (it.loc) return { input: '/media/x.mkv', local: { path: '/media/x.mkv' } };
      if (/^file:/.test(it.u)) return { input: '/x', headers: {}, local: { path: '/x' } };
      const a = alt >= 0 ? it.alts[alt] : { u: it.u, h: it.h };
      return it.proxied ? { input: 'http://127.0.0.1/loop', headers: {}, viaProxy: true } : { input: a.u, headers: a.h || {} };
    },
    isUrl: (u) => /^https?:\/\//.test(u),
    proxy: { sign: (u, o) => `/api/proxy?d=${Buffer.from(JSON.stringify({ u, h: o.h })).toString('base64url')}&s=sig` },
    castSign: (pq, hours) => `/c/tok${hours}h.sig${pq}`,
    siteOrigin: () => 'https://tv.home.test',
  });
  const call = (body) => routes['POST /api/play/external']({ body }, {}, {}, null, { profile: { id: 'p' } });
  return { call };
}

test('open in another app: provider address, or a signed 12-hour server link', async () => {
  const { call } = setup({
    plain: { t: 'live', u: 'http://prov.test/live/u/p/1.ts' },
    hdr: { t: 'movie', u: 'http://prov.test/movie/1.mp4', h: { Referer: 'http://prov.test/' } },
    prox: { t: 'live', u: 'http://prov.test/live/2.ts', proxied: true },
    mine: { t: 'movie', loc: { list: 'L1', id: 'abc' } },
    file: { t: 'movie', u: 'file:///srv/x.mkv' },
    alt: { t: 'live', u: 'http://a.test/1.ts', alts: [{ u: 'http://b.test/1.m3u8', h: { 'User-Agent': 'VLC' } }] },
    show: { t: 'show' },
  });
  assert.deepStrictEqual(await call({ k: 'plain' }), { url: 'http://prov.test/live/u/p/1.ts', how: 'direct', hours: 0 });
  const h = await call({ k: 'hdr' });
  assert.strictEqual(h.how, 'server');
  assert.strictEqual(h.hours, 12);
  assert.match(h.url, /^https:\/\/tv\.home\.test\/c\/tok12h\.sig\/api\/proxy\?d=/);
  assert.match(Buffer.from(/d=([^&]+)/.exec(h.url)[1], 'base64url').toString(), /Referer/);
  assert.strictEqual((await call({ k: 'prox' })).how, 'server');
  assert.strictEqual((await call({ k: 'mine' })).url, 'https://tv.home.test/c/tok12h.sig/api/local/L1/abc');
  await assert.rejects(call({ k: 'file' }), /can’t be opened in another app/);
  await assert.rejects(call({ k: 'show' }), /episode/);
  const a = await call({ k: 'alt', alt: 0 });
  assert.strictEqual(a.how, 'server');
  assert.match(Buffer.from(/d=([^&]+)/.exec(a.url)[1], 'base64url').toString(), /b\.test/);
});
