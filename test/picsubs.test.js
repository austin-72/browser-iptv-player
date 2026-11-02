// Picture subtitles (PGS, VobSub, DVB), teletext and subtitle timing: the browser's decoders (web/js/picsubdec.js, run
// here in a VM like the browser would), the server's Matroska and MPEG-TS readers, the extraction from a real file
// with ffmpeg, and the routes on the real server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const F = require('./picsubs-fixture');
const { MkvReader, TsSubs, PicSubs, esSubs } = require('../lib/picsubs');

const ctx = { V: {}, window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'picsubdec.js'), 'utf8'), ctx);
const D = ctx.V.picdec;
const px = (it, x, y) => Array.from(it.rgba.slice((y * it.w + x) * 4, (y * it.w + x) * 4 + 4));
const plain = (x) => JSON.parse(JSON.stringify(x)); // (values made inside the VM)
let ffmpeg = false;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpeg = true; } catch {}

test('PGS: display sets, palettes, pictures split over several segments, palette-only updates', () => {
  const pic = F.box(300, 80, { frame: 1, fill: 2 });
  const pal = [[1, 235, 128, 128, 255], [2, 16, 128, 128, 200]];
  const p = new D.Pgs();
  p.feed(new Uint8Array(F.pgsSet({ objects: [{ id: 0, x: 810, y: 900, pic }], palette: pal })));
  let out = p.picture();
  assert.deepStrictEqual([out.w, out.h, out.items.length], [1920, 1080, 1]);
  const it = out.items[0];
  assert.deepStrictEqual([it.x, it.y, it.w, it.h], [810, 900, 300, 80]);
  assert.deepStrictEqual(px(it, 0, 0), [254, 254, 254, 255], 'frame: white');
  assert.deepStrictEqual(px(it, 150, 40), [0, 0, 0, 200], 'inside: black, partly transparent');
  // The same picture, new colours (a fade): "palette update only".
  p.feed(new Uint8Array(F.pgsSet({ state: 0, paletteOnly: true, objects: [{ id: 0, x: 810, y: 900, pic }], palette: [[1, 235, 128, 128, 100], [2, 16, 128, 128, 50]] })));
  out = p.picture();
  assert.strictEqual(out.items.length, 1);
  assert.strictEqual(px(out.items[0], 0, 0)[3], 100);
  // An empty composition clears the screen.
  p.feed(new Uint8Array(F.pgsSet({ state: 0, objects: [] })));
  assert.strictEqual(p.picture().items.length, 0);
  // A big, busy picture: the run-length data goes over several object segments.
  const big = { w: 1800, h: 120, px: new Uint8Array(1800 * 120) };
  for (let i = 0; i < big.px.length; i++) big.px[i] = 1 + ((i * 7 + (i >> 5)) % 3);
  const set = F.pgsSet({ objects: [{ id: 3, x: 60, y: 900, pic: big }], palette: [[1, 235, 128, 128, 255], [2, 128, 128, 128, 255], [3, 16, 128, 128, 255]] });
  const q = new D.Pgs();
  q.feed(new Uint8Array(set));
  const b = q.picture().items[0];
  assert.deepStrictEqual([b.w, b.h], [1800, 120]);
  for (const [x, y] of [[0, 0], [1799, 119], [901, 77]]) {
    const v = big.px[y * 1800 + x];
    assert.strictEqual(px(b, x, y)[0], v === 1 ? 254 : v === 2 ? 130 : 0, `pixel ${x},${y}`);
  }
  // .sup files: segments behind "PG" headers, grouped into display sets with their times.
  const sets = D.splitSup(new Uint8Array(F.sup([{ t: 1.5, data: set }, { t: 3, data: F.pgsSet({ state: 0, objects: [] }) }])));
  assert.deepStrictEqual(plain(sets.map((s) => s.pts)), [1.5, 3]);
  assert.strictEqual(sets[0].data.length, set.length);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(D.pgsInfo(sets[1].data))), { state: 0, objects: 0, w: 1920, h: 1080 });
});

test('VobSub: SPU packets, interlaced run lengths, .idx palette, display times', () => {
  const idx = D.parseIdx(F.IDX(720, 480, [0x000000, 0xffffff, 0x808080, 0x102030, 0xff0000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  assert.deepStrictEqual([idx.w, idx.h, idx.palette.length, idx.palette[4]], [720, 480, 16, 0xff0000]);
  const pic = F.box(201, 51, { frame: 3, fill: 1 });
  pic.px[25 * 201 + 7] = 2; // (one odd pixel on an odd line… the bottom field)
  const v = D.vobsub(new Uint8Array(F.vobPacket({ x: 100, y: 400, pic, colours: [0, 1, 4, 3], alphas: [0, 15, 8, 15], end: 2.5 })), idx.palette);
  assert.deepStrictEqual([v.x, v.y, v.w, v.h, v.start], [100, 400, 201, 51, 0]);
  assert.ok(Math.abs(v.end - 2.5) < 0.02, `ends after ${v.end} s`);
  assert.deepStrictEqual(px(v, 0, 0), [0x10, 0x20, 0x30, 255], 'frame: colour 3');
  assert.deepStrictEqual(px(v, 100, 24), [255, 255, 255, 255], 'inside: colour 1');
  assert.deepStrictEqual(px(v, 7, 25), [255, 0, 0, 136], 'emphasis: palette entry 4, half transparent');
  assert.strictEqual(D.vobsub(new Uint8Array([0, 4, 0, 2]), idx.palette), null, 'a broken packet is ignored');
});

test('DVB: page, region, CLUT and object segments; 4-bit pixel strings; pages of other languages are left out', () => {
  const pic = F.box(160, 40, { frame: 1, fill: 2 });
  const set = new Uint8Array(F.dvbSet({ x: 280, y: 480, pic, clut: [[1, 235, 128, 128, 0], [2, 16, 128, 128, 0x80]] }));
  const d = new D.Dvb();
  d.feed(set);
  const out = d.picture();
  assert.deepStrictEqual([out.w, out.h, out.items.length], [720, 576, 1]);
  assert.deepStrictEqual([out.items[0].x, out.items[0].y, out.items[0].w, out.items[0].h], [280, 480, 160, 40]);
  assert.deepStrictEqual(px(out.items[0], 0, 0), [254, 254, 254, 255]);
  assert.deepStrictEqual(px(out.items[0], 80, 21), [0, 0, 0, 127]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(D.dvbInfo(set))), { timeout: 10, state: 2, regions: 1 });
  const other = new D.Dvb({ comp: 2, anc: 2 });
  other.feed(set);
  assert.strictEqual(other.picture().items.length, 0);
  d.feed(new Uint8Array(F.dvbSet({ state: 0 })));
  assert.strictEqual(d.picture().items.length, 0, 'an empty page clears');
});

test('Teletext: subtitle pages, boxed rows, national characters, descriptors', () => {
  const t = new D.Ttx(0x888);
  assert.deepStrictEqual(Array.from(t.feed(new Uint8Array(F.ttxPes(F.ttxSubtitle(8, 0x88, ['Hello from teletext', 'Line }wo'], 1))))), []);
  // The next header in the magazine completes the page.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.feed(new Uint8Array(F.ttxPes([F.ttxPacket(8, 0, { page: 0x99 })]))))), [{ text: 'Hello from teletext\nLine üwo' }]);
  t.feed(new Uint8Array(F.ttxPes([F.ttxPacket(8, 0, { page: 0x88, erase: true })])));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.feed(new Uint8Array(F.ttxPes([F.ttxPacket(8, 0, { page: 0x88 })]))))), [{ text: '' }], 'an erased page clears');
  const other = new D.Ttx(0x777);
  other.feed(new Uint8Array(F.ttxPes(F.ttxSubtitle(8, 0x88, ['Not mine']))));
  assert.deepStrictEqual(Array.from(other.feed(new Uint8Array(F.ttxPes([F.ttxPacket(8, 0, { page: 0x99 })])))), []);
  const desc = F.ttxDesc([{ lang: 'deu', type: 2, page: 0x888 }, { lang: 'eng', type: 1, page: 0x100 }]).concat(F.dvbDesc([{ lang: 'fra', comp: 3, anc: 4 }]));
  const want = [{ kind: 'ttx', lang: 'deu', page: 0x888, hi: false }, { kind: 'dvb', lang: 'fra', hi: false, comp: 3, anc: 4 }];
  assert.deepStrictEqual(JSON.parse(JSON.stringify(D.esSubs(new Uint8Array(desc)))), want);
  assert.deepStrictEqual(esSubs(Buffer.from(desc)).map((x) => x.kind + x.lang), ['ttxdeu', 'dvbfra'], 'the server reads them the same way');
});

test('Matroska read as it arrives (any chunk sizes); MPEG-TS subtitle streams read as the file grows', () => {
  const packets = [
    { track: 1, t: 1.5, d: 2, data: Buffer.from('first') }, { track: 2, t: 2.25, d: 0, data: Buffer.from('second') },
    { track: 1, t: 40, d: 1.5, data: Buffer.alloc(70000, 7) },
  ];
  const file = F.mkv({ tracks: [{ num: 1, codec: 'S_VOBSUB', priv: 'size: 720x576\npalette: 000000' }, { num: 2, codec: 'S_HDMV/PGS' }], packets });
  for (const size of [1, 7, 4096, file.length]) {
    const got = [], tracks = [];
    const r = new MkvReader({ onTrack: (t) => tracks.push(t), onPacket: (p) => got.push(p) });
    for (let i = 0; i < file.length; i += size) r.push(file.subarray(i, i + size));
    r.end();
    assert.deepStrictEqual(tracks.map((t) => [t.num, t.codec, t.priv ? t.priv.toString() : null]), [[1, 'S_VOBSUB', 'size: 720x576\npalette: 000000'], [2, 'S_HDMV/PGS', null]]);
    assert.deepStrictEqual(got.map((p) => [p.track, p.t, p.d, p.data.length]), [[1, 1.5, 2, 5], [2, 2.25, 0, 6], [1, 40, 1.5, 70000]], `chunks of ${size}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tssubs-'));
  const ts = path.join(dir, 'subs.ts');
  const pes = [{ t: 2, data: F.ttxPes(F.ttxSubtitle(8, 0x88, ['One'])) }, { t: 4, data: F.ttxPes(F.ttxSubtitle(1, 0x00, ['Other magazine'])) }, { t: 5, data: F.ttxPes([F.ttxPacket(8, 0, { page: 0x99 })]) }];
  const whole = F.tsFile({ pid: 0x300, desc: F.ttxDesc([{ lang: 'eng', type: 2, page: 0x888 }]), pes });
  fs.writeFileSync(ts, whole.subarray(0, 188 * 5 + 77)); // (half a packet: read on the next poll)
  const r = new TsSubs(ts);
  let a = r.since(0);
  fs.writeFileSync(ts, whole);
  const b = r.since(a.next);
  const all = a.packets.concat(b.packets);
  assert.deepStrictEqual(b.streams, [{ pid: 0x300, subs: [{ kind: 'ttx', lang: 'eng', hi: false, page: 0x888 }] }]);
  assert.deepStrictEqual(all.map((x) => x.pts), [2, 5], 'teletext from other magazines is left out');
  const t = new D.Ttx(0x888);
  t.feed(new Uint8Array(Buffer.from(all[0].data, 'base64')));
  assert.strictEqual(t.feed(new Uint8Array(Buffer.from(all[1].data, 'base64')))[0].text, 'One');
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A film with a PGS track, two VobSub tracks and a DVB track (made by ffmpeg from VobSub), like a Blu-ray/DVD rip. */
function makeFilm(dir) {
  const pal = [[1, 235, 128, 128, 255], [2, 16, 128, 128, 255]];
  const sets = [];
  [[2, 3], [7, 2], [12, 4]].forEach(([t, d], n) => {
    sets.push({ t, data: F.pgsSet({ num: n * 2, objects: [{ id: 0, x: 700 + n * 10, y: 900, pic: F.box(500, 60) }], palette: pal }) });
    sets.push({ t: t + d, data: F.pgsSet({ num: n * 2 + 1, state: 0, objects: [] }) });
  });
  fs.writeFileSync(path.join(dir, 'pgs.sup'), F.sup(sets));
  const vpal = [0, 0xffffff, 0x808080, 0, 0xffff00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const vob = (shift) => F.mkv({ tracks: [{ num: 1, codec: 'S_VOBSUB', priv: F.IDX(720, 480, vpal) }], packets: [[1, 2], [5, 2], [9, 3]].map(([t, d], n) => ({ track: 1, t: t + shift, d, data: F.vobPacket({ x: 200 + n * 20, y: 400, pic: F.box(300, 40, { frame: 2, fill: 1 }), end: d }) })) });
  fs.writeFileSync(path.join(dir, 'a.mkv'), vob(0));
  fs.writeFileSync(path.join(dir, 'b.mkv'), vob(0.5));
  const film = path.join(dir, 'Subtitle Test Film (2020).mkv');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-copyts', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=16', '-i', path.join(dir, 'pgs.sup'), '-i', path.join(dir, 'a.mkv'), '-i', path.join(dir, 'b.mkv'),
    '-map', '0:v', '-map', '1:s', '-map', '2:s', '-map', '3:s', '-map', '2:s', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:s:0', 'copy', '-c:s:1', 'copy', '-c:s:2', 'copy', '-c:s:3', 'dvbsub',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=fre', '-metadata:s:s:2', 'language=spa', '-metadata:s:s:3', 'language=ger', film]);
  for (const f of ['pgs.sup', 'a.mkv', 'b.mkv']) fs.rmSync(path.join(dir, f));
  return film;
}
const TRACKS = [{ i: 0, codec: 'hdmv_pgs_subtitle' }, { i: 1, codec: 'dvd_subtitle' }, { i: 2, codec: 'dvd_subtitle' }, { i: 3, codec: 'dvb_subtitle' }];

test('Extraction with ffmpeg: every picture track of a file in one pass, kept, read back and decoded', { skip: !ffmpeg && 'ffmpeg not installed', timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picsubs-'));
  const film = makeFilm(dir);
  const media = { available: true, ffmpegBin: 'ffmpeg', _inputArgs: (input) => ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input] };
  const ps = new PicSubs(media, path.join(dir, 'cache'));
  let r = ps.index(film, {}, TRACKS, 0);
  for (let i = 0; i < 200 && !r.done; i++) { await new Promise((ok) => setTimeout(ok, 100)); r = ps.index(film, {}, null, 0); }
  assert.ok(r.done && !r.err, r.err);
  assert.strictEqual(r.codec, 'pgs');
  assert.deepStrictEqual(r.idx.map((e) => [e[0], e[4]]), [[2, 2], [5, 4], [7, 2], [9, 4], [12, 2], [16, 4]], 'times, fresh starts and clears');
  // Decode what's on screen at 8 s from the stored packets.
  const pg = new D.Pgs();
  for (const e of r.idx.slice(0, 3)) pg.feed(new Uint8Array(ps.read(film, 0, e[2], e[3])));
  assert.deepStrictEqual(plain(pg.picture().items.map((x) => [x.x, x.y, x.w, x.h])), [[710, 900, 500, 60]]);
  // VobSub: its palette comes with the index; the second track is half a second later.
  const v1 = ps.index(film, {}, null, 1), v2 = ps.index(film, {}, null, 2);
  assert.deepStrictEqual(v1.idx.map((e) => e[0]), [1, 5, 9]);
  assert.deepStrictEqual(v2.idx.map((e) => e[0]), [1.5, 5.5, 9.5]);
  const ix = D.parseIdx(v1.priv);
  const sub = D.vobsub(new Uint8Array(ps.read(film, 1, v1.idx[2][2], v1.idx[2][3])), ix.palette);
  assert.deepStrictEqual([sub.x, sub.y, sub.w, sub.h], [240, 400, 300, 40]);
  assert.deepStrictEqual(px(sub, 150, 20), [255, 255, 255, 255]);
  assert.ok(Math.abs(sub.end - 3) < 0.02);
  // DVB (re-encoded by ffmpeg's own DVB encoder): the same picture comes back.
  const dv = ps.index(film, {}, null, 3);
  assert.ok(dv.idx.length >= 3);
  const dd = new D.Dvb();
  dd.feed(new Uint8Array(ps.read(film, 3, dv.idx[0][2], dv.idx[0][3])));
  const dp = dd.picture();
  assert.deepStrictEqual(plain(dp.items.map((x) => [x.w, x.h])), [[300, 40]]);
  assert.ok(px(dp.items[0], 150, 20).slice(0, 3).every((c) => c >= 250), "white");
  // Kept: a new reader (e.g. after a restart) answers from the cache without ffmpeg.
  const again = new PicSubs({ available: false }, path.join(dir, 'cache'));
  assert.ok(again.known(film));
  assert.strictEqual(again.index(film, {}, null, 1).idx.length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('Routes on the real server: picture tracks in the probe and the session, index, packets, subtitle timing saved', { skip: !ffmpeg && 'ffmpeg not installed', timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p6srv-'));
  const media = path.join(dir, 'media');
  fs.mkdirSync(media);
  makeFilm(media);
  // Subtitle files next to it.
  fs.writeFileSync(path.join(media, 'Subtitle Test Film (2020).en.srt'), '1\r\n00:00:02,000 --> 00:00:04,500\r\nHello from a file\r\n\r\n2\r\n00:01:10,000 --> 00:01:12,000\r\nLater on\r\n');
  fs.writeFileSync(path.join(media, 'Subtitle Test Film (2020).French.forced.srt'), Buffer.from('1\n00:00:03,000 --> 00:00:05,000\nD\xe9j\xe0 vu\n', 'latin1'));
  fs.writeFileSync(path.join(media, 'Subtitle Test Film (2020).de.ass'), '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:06.25,0:00:08.00,Default,,0,0,0,,{\\b1}Hallo{\\b0}, Welt\\Nzweite Zeile\n');
  const port = await freePort();
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(dir, 'data'), NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const req = async (method, p, body, raw) => {
    const h = { 'X-App': '1' };
    if (cookie) h.Cookie = cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    if (raw) return r;
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, text: t };
  };
  try {
    for (let i = 0; i < 100 && !/Ready/.test(out); i++) await wait(100);
    assert.match(out, /Ready/, out);
    assert.strictEqual((await req('POST', '/api/login', { password: 'pw-test' })).status, 200);
    assert.strictEqual((await req('POST', '/api/profiles', { name: 'Alex', pin: '1234', avatar: 1 })).status, 200);
    const add = await req('POST', '/api/admin/lists', { type: 'folder', folders: [media], name: 'Films' });
    assert.strictEqual(add.status, 200, add.text);
    let k = null;
    for (let i = 0; i < 50 && !k; i++) {
      const cat = await req('GET', '/api/catalog');
      const m = /"k":"([^"]+)"[^{}]*"n":"Subtitle Test Film/.exec(cat.text) || /"n":"Subtitle Test Film[^{}]*"k":"([^"]+)"/.exec(cat.text);
      if (m) k = m[1]; else await wait(200);
    }
    assert.ok(k, 'the film is in the catalogue');
    const pr = await req('GET', `/api/probe/${encodeURIComponent(k)}`);
    assert.deepStrictEqual(pr.json.subs.map((s) => [s.i, s.lang, s.text, s.pic]), [[0, 'eng', false, 'pgs'], [1, 'fre', false, 'vobsub'], [2, 'spa', false, 'vobsub'], [3, 'ger', false, 'dvb']]);
    // A conversion lists them too (the player shows them like text tracks).
    const ss = await req('POST', '/api/play/session', { k, mode: 'remux', seek: 5, codecs: ['h264'] });
    assert.strictEqual(ss.status, 200, ss.text);
    assert.deepStrictEqual(ss.json.subs.map((s) => s.pic), ['pgs', 'vobsub', 'vobsub', 'dvb']);
    assert.ok(ss.json.offset > 0, 'converting from part-way: the player adds the offset');
    await req('DELETE', `/api/session/${ss.json.sessionId}`);
    // The index, polled until the copy is done.
    let ix = null;
    for (let i = 0; i < 100; i++) { ix = (await req('GET', `/api/picsubs/${encodeURIComponent(k)}/1?from=0`)).json; if (ix.done) break; await wait(150); }
    assert.ok(ix.done && !ix.err, JSON.stringify(ix));
    assert.strictEqual(ix.codec, 'vobsub');
    assert.match(ix.priv, /palette:/);
    assert.deepStrictEqual(ix.idx.map((e) => e[0]), [1, 5, 9]);
    const more = (await req('GET', `/api/picsubs/${encodeURIComponent(k)}/1?from=2`)).json;
    assert.deepStrictEqual(more.idx.map((e) => e[0]), [9], 'only the entries the player doesn’t have');
    // Packets: two neighbours at once.
    const e1 = ix.idx[1], e2 = ix.idx[2];
    const bin = await req('GET', `/api/picsubs/${encodeURIComponent(k)}/1/data?o=${e1[2]}&n=${e2[2] + e2[3] - e1[2]}`, undefined, true);
    assert.strictEqual(bin.status, 200);
    const buf = new Uint8Array(await bin.arrayBuffer());
    const sub = D.vobsub(buf.subarray(e2[2] - e1[2], e2[2] - e1[2] + e2[3]), D.parseIdx(ix.priv).palette);
    assert.deepStrictEqual([sub.x, sub.w, sub.h], [240, 300, 40]);
    // Not a picture track, or no such file: plain errors.
    assert.strictEqual((await req('GET', `/api/picsubs/${encodeURIComponent(k)}/7`)).status, 404);
    // Subtitle timing is saved per title in the profile's settings.
    const pf = await req('PUT', '/api/me/prefs', { subDelay: { [k]: 1.5 } });
    assert.strictEqual(pf.status, 200);
    assert.deepStrictEqual(pf.json.subDelay, { [k]: 1.5 });
    // Subtitle files next to the film: listed with their languages, served as WebVTT, moved back for a conversion.
    const side = await req('GET', `/api/sidesubs/${encodeURIComponent(k)}`);
    assert.deepStrictEqual(side.json.map((x) => [x.lang, x.label, x.forced]).sort(), [['de', 'German · .ass', false], ['en', 'English · .srt', false], ['fr', 'French · .srt', true]]);
    const n = (lang) => side.json.find((x) => x.lang === lang).n;
    const en = await req('GET', `/api/sidesubs/${encodeURIComponent(k)}/${n('en')}`);
    assert.match(en.text, /^WEBVTT/);
    assert.match(en.text, /00:00:02\.000 --> 00:00:04\.500\nHello from a file/);
    assert.match((await req('GET', `/api/sidesubs/${encodeURIComponent(k)}/${n('fr')}`)).text, /Déjà vu/, 'old Windows text files are read too');
    assert.match((await req('GET', `/api/sidesubs/${encodeURIComponent(k)}/${n('de')}`)).text, /00:00:06\.250 --> 00:00:08\.000\nHallo, Welt\nzweite Zeile/);
    const moved = await req('GET', `/api/sidesubs/${encodeURIComponent(k)}/${n('en')}?offset=60`);
    assert.match(moved.text, /00:00:00\.000 --> 00:00:00\.000\nHello/);
    assert.match(moved.text, /00:00:10\.000 --> 00:00:12\.000\nLater on/);
    assert.strictEqual((await req('GET', `/api/sidesubs/${encodeURIComponent(k)}/9`)).status, 404);
    // Live conversions: no subtitles copied aside for this one.
    assert.strictEqual((await req('GET', '/api/sessionsubs/nope')).status, 410);
  } finally {
    app.kill('SIGKILL');
    await wait(200);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
