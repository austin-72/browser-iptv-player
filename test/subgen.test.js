'use strict';
// Subtitles made from a film's sound (lib/subgen.js, lib/routes-p13.js), with a pretend whisper: finding the program
// and saying why not, a job from the film to a WebVTT file, the queue, waiting for a provider connection, stopping —
// and through the real server: who may ask, the file served, nothing about playing changed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const cfg = require('../lib/config');
const { SubGen } = require('../lib/subgen');

const hasFfmpeg = spawnSync(cfg.ffmpeg, ['-version']).status === 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(100); } return false; };
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => ok(n)); }); });

/**
 * A pretend whisper.cpp: the same options (-m -f -l -t -ovtt -of -pp), checks that what it's given is 16 kHz mono
 * 16-bit WAV, says the language it "heard" and how far it is, and writes <of>.vtt. WHISPER_FAKE_SLOW makes it take
 * that many ms; a model named *silent* writes a file with no lines.
 */
function fakeWhisper(dir, { python = false } = {}) {
  const f = path.join(dir, python ? 'whisper' : 'whisper-cli');
  const cpp = `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2);
if (a.includes('--help') || a.includes('-h')) { console.error('usage: whisper-cli [options] file0\\n  -ovtt,     --output-vtt   output result in a vtt file\\n  -of FNAME, --output-file\\n  -l LANG,   --language'); process.exit(0); }
const get = (k) => a[a.indexOf(k) + 1];
const wav = fs.readFileSync(get('-f'));
if (wav.slice(0, 4).toString() !== 'RIFF' || wav.readUInt16LE(22) !== 1 || wav.readUInt32LE(24) !== 16000 || wav.readUInt16LE(34) !== 16) { console.error('not 16 kHz mono 16-bit WAV'); process.exit(2); }
if (!fs.existsSync(get('-m'))) { console.error('no model'); process.exit(3); }
if (get('-l') !== 'auto' || !a.includes('-ovtt')) { console.error('bad options'); process.exit(4); }
console.error('whisper_full_with_state: auto-detected language: en (p = 0.97)');
console.error('whisper_print_progress_callback: progress =  50%');
setTimeout(() => {
  fs.writeFileSync(get('-of') + '.vtt', /silent/.test(get('-m')) ? 'WEBVTT\\n\\n' : 'WEBVTT\\n\\n00:00:01.000 --> 00:00:03.500\\n Hello there.\\n\\n00:00:12.000 --> 00:00:14.000\\n General Kenobi.\\n\\n');
  process.exit(0);
}, Number(process.env.WHISPER_FAKE_SLOW || 0));
`;
  const py = `#!${process.execPath}
const fs = require('fs'), path = require('path'); const a = process.argv.slice(2);
if (a.includes('--help')) { console.log('usage: whisper [-h] [--model MODEL] [--output_dir OUTPUT_DIR] [--output_format {txt,vtt,srt,tsv,json,all}] audio [audio ...]'); process.exit(0); }
const get = (k) => a[a.indexOf(k) + 1];
if (get('--output_format') !== 'vtt') process.exit(4);
console.log('Detected language: Spanish');
fs.writeFileSync(path.join(get('--output_dir'), path.basename(a[0]).replace(/\\.wav$/, '') + '.vtt'), 'WEBVTT\\n\\n00:01.000 --> 00:02.000\\nHola (' + get('--model') + ').\\n');
`;
  fs.writeFileSync(f, python ? py : cpp, { mode: 0o755 });
  return f;
}
function makeFilm(dir, name = 'film.mp4', { audio = true } = {}) {
  const f = path.join(dir, name);
  const r = spawnSync(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440'] : []), '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : []), '-movflags', '+faststart', '-y', f]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  return f;
}
const ffmpeg = () => ({ bin: cfg.ffmpeg, available: true, netArgs: () => [] });

test('finding the speech-to-text program, and saying why not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subgen-find-'));
  try {
    const bin = fakeWhisper(dir), model = path.join(dir, 'ggml-base.bin');
    fs.writeFileSync(model, 'model');
    assert.deepStrictEqual((({ available, kind, why }) => ({ available, kind, why }))(new SubGen(dir, { ffmpeg }, { bin, model }).detect().info()), { available: true, kind: 'cpp', why: '' });
    assert.match(new SubGen(dir, { ffmpeg }, { bin, model: '' }).detect().why, /needs a model file: set WHISPER_MODEL/);
    assert.match(new SubGen(dir, { ffmpeg }, { bin, model: path.join(dir, 'missing.bin') }).detect().why, /isn’t there or can’t be read/);
    assert.match(new SubGen(dir, { ffmpeg }, { bin: path.join(dir, 'nothing-here'), model }).detect().why, /couldn’t be run/);
    // Something else by that name.
    const other = path.join(dir, 'other');
    fs.writeFileSync(other, `#!${process.execPath}\nconsole.log('usage: other [--loud]');\n`, { mode: 0o755 });
    assert.match(new SubGen(dir, { ffmpeg }, { bin: other, model }).detect().why, /isn’t a whisper this app knows/);
    // The Python command line needs no model file (it has names, "base" unless told).
    const pdir = path.join(dir, 'py'); fs.mkdirSync(pdir);
    assert.strictEqual(new SubGen(dir, { ffmpeg }, { bin: fakeWhisper(pdir, { python: true }), model: '' }).detect().info().kind, 'py');
    const g = new SubGen(dir, { ffmpeg }, { bin: path.join(dir, 'nothing-here'), model });
    assert.throws(() => g.detect().start({ k: 'x', name: 'X', input: 'x', local: true }), /can’t make subtitles/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a job: the film’s sound, the words, a WebVTT file kept — one at a time, waiting for a connection, stopped on request', { skip: !hasFfmpeg && 'no ffmpeg', timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subgen-'));
  const bin = fakeWhisper(dir), model = path.join(dir, 'ggml-base.bin'), silent = path.join(dir, 'ggml-silent.bin');
  fs.writeFileSync(model, 'model'); fs.writeFileSync(silent, 'model');
  const film = makeFilm(dir), mute = makeFilm(dir, 'mute.mp4', { audio: false });
  const notes = [];
  let free = true;
  const g = new SubGen(path.join(dir, 'data'), { ffmpeg, connFree: () => free, notify: (j, what) => notes.push(what + ':' + j.k) }, { bin, model, waitMs: 100, maxWaitMs: 1500 }).detect();
  try {
    assert.deepStrictEqual(g.status('movie:1'), { state: 'none' });
    // Two asked for at once: the second waits its turn; asking again for one under way changes nothing.
    assert.strictEqual(g.start({ k: 'movie:1', name: 'One', input: film, local: true, pid: 'p1' }).state !== 'none', true);
    assert.strictEqual(g.start({ k: 'movie:2', name: 'Two', input: film, local: true, pid: 'p1' }).state, 'queued');
    g.start({ k: 'movie:2', name: 'Two', input: film, local: true, pid: 'p1' });
    assert.strictEqual(g.queue.length, 1);
    assert.ok(await until(() => g.status('movie:1').state === 'done' && g.status('movie:2').state === 'done'), JSON.stringify([g.status('movie:1'), g.status('movie:2')]));
    const made = g.made('movie:1');
    assert.strictEqual(made.lang, 'en');
    assert.match(fs.readFileSync(made.path, 'utf8'), /^WEBVTT\n\n00:00:01\.000 --> 00:00:03\.500\n Hello there\./);
    assert.strictEqual(g.fileById(made.id), made.path);
    assert.strictEqual(g.fileById('../../etc/passwd'), '');
    assert.deepStrictEqual(notes, ['done:movie:1', 'done:movie:2']);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'data', 'gen-subs')).filter((n) => !/\.(vtt|json)$/.test(n)), [], 'the sound it worked from is gone');

    // No sound; nothing said; a provider with no connection free (it waits, then gives up); deleted.
    g.start({ k: 'movie:mute', name: 'Mute', input: mute, local: true, pid: 'p1' });
    assert.ok(await until(() => g.status('movie:mute').state === 'failed'));
    assert.match(g.status('movie:mute').err, /^It has no sound to make subtitles from\.$/);
    g.model = silent;
    g.start({ k: 'movie:quiet', name: 'Quiet', input: film, local: true, pid: 'p1' });
    assert.ok(await until(() => g.status('movie:quiet').state === 'failed'));
    assert.match(g.status('movie:quiet').err, /Nothing was said/);
    g.model = model;
    free = false;
    g.start({ k: 'movie:far', name: 'Far', input: film, local: false, pid: 'p1' });
    assert.ok(await until(() => g.status('movie:far').state === 'waiting'));
    assert.deepStrictEqual(g.reading(), [], 'waiting isn’t using a connection');
    free = true;
    assert.ok(await until(() => g.status('movie:far').state === 'done'));
    free = false;
    g.start({ k: 'movie:never', name: 'Never', input: film, local: false, pid: 'p1' });
    assert.ok(await until(() => g.status('movie:never').state === 'failed', 5000));
    assert.match(g.status('movie:never').err, /Every connection to its provider stayed in use/);
    g.remove('movie:1');
    assert.deepStrictEqual(g.status('movie:1'), { state: 'none' });
    // Stopped while it's being written.
    free = true;
    process.env.WHISPER_FAKE_SLOW = '20000';
    g.start({ k: 'movie:slow', name: 'Slow', input: film, local: true, pid: 'p1' });
    assert.ok(await until(() => g.status('movie:slow').state === 'writing'));
    // (How far along it is arrives a moment after it starts writing.)
    assert.ok(await until(() => g.status('movie:slow').pct === 50), String(g.status('movie:slow').pct));
    g.remove('movie:slow');
    delete process.env.WHISPER_FAKE_SLOW;
    assert.ok(await until(() => !g.current));
    assert.deepStrictEqual(g.status('movie:slow'), { state: 'none' });
    assert.ok(!notes.includes('failed:movie:slow'), 'stopping isn’t a failure to tell anyone about');
  } finally { delete process.env.WHISPER_FAKE_SLOW; g.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the server: subtitles made for a film on request, who may ask, and the file served', { skip: !hasFfmpeg && 'no ffmpeg', timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subgen-srv-'));
  const bin = fakeWhisper(dir), model = path.join(dir, 'ggml-base.bin');
  fs.writeFileSync(model, 'model');
  const film = makeFilm(dir);
  let hits = 0;
  const pv = http.createServer((req, res) => {
    if (/\/movie\//.test(req.url)) { hits++; res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fs.statSync(film).size }); return fs.createReadStream(film).pipe(res); }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => pv.listen(0, '127.0.0.1', ok));
  const port = await freePort();
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(dir, 'data'), NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test', WHISPER_BIN: bin, WHISPER_MODEL: model }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const device = () => {
    const d = { cookie: '' };
    d.raw = (method, p, body, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-App': '1', ...(d.cookie ? { Cookie: d.cookie } : {}), ...headers }, body });
    d.req = async (method, p, body) => {
      const r = await d.raw(method, p, body !== undefined ? JSON.stringify(body) : undefined, body !== undefined ? { 'Content-Type': 'application/json' } : {});
      const sc = r.headers.get('set-cookie');
      if (sc) d.cookie = sc.split(';')[0];
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { status: r.status, json: j, text: t };
    };
    return d;
  };
  try {
    for (let i = 0; i < 150 && !/Ready/.test(out); i++) await wait(100);
    assert.match(out, /Ready/, out.slice(-500));
    const a = device();
    assert.strictEqual((await a.req('POST', '/api/login', { password: 'pw-test' })).status, 200);
    assert.strictEqual((await a.req('POST', '/api/profiles', { name: 'Alex', pin: '4821' })).status, 200);
    assert.strictEqual((await a.req('POST', '/api/profiles', { name: 'Sam' })).status, 200);
    const M3U = `#EXTM3U\n#EXTINF:-1 group-title="Films",Quiet Words (2021)\nhttp://127.0.0.1:${pv.address().port}/movie/u/p/1.mp4\n#EXTINF:-1 group-title="News",News One\nhttp://127.0.0.1:${pv.address().port}/live/1.ts\n`;
    assert.strictEqual((await a.raw('POST', '/api/admin/lists/upload?name=L&fileName=l.m3u', Buffer.from(M3U))).status, 200);
    let cat = null, it = null, ch = null;
    for (let i = 0; i < 60 && !(it && ch); i++) { cat = (await a.req('GET', '/api/catalog')).json; it = cat && cat.items && cat.items.find((x) => /Quiet Words/.test(x.n)); ch = cat && cat.items && cat.items.find((x) => x.n === 'News One'); if (!(it && ch)) await wait(200); }
    assert.ok(it && ch);
    const k = encodeURIComponent(it.k);

    // Found on the server, and every device is told it's there.
    const info = (await a.req('GET', '/api/admin/subgen')).json;
    assert.deepStrictEqual([info.available, info.kind, info.mode], [true, 'cpp', 'everyone']);
    assert.strictEqual((await a.req('GET', '/api/boot')).json.subGen, 'everyone');
    assert.deepStrictEqual((({ can, state }) => ({ can, state }))((await a.req('GET', `/api/subgen?k=${k}`)).json), { can: true, state: 'none' });
    assert.strictEqual((await a.req('POST', '/api/subgen', { k: ch.k })).status, 400, 'not a live channel');

    // Only the admin: Sam is refused.
    assert.strictEqual((await a.req('PUT', '/api/admin/settings', { subGen: 'admin' })).status, 200);
    const s = device();
    await s.req('POST', '/api/login', { password: 'pw-test' });
    const sam = (await s.req('GET', '/api/boot')).json.profiles.find((x) => x.name === 'Sam');
    assert.strictEqual((await s.req('POST', `/api/profiles/${sam.id}/select`, {})).status, 200);
    assert.strictEqual((await s.req('GET', `/api/subgen?k=${k}`)).json.can, false);
    assert.strictEqual((await s.req('POST', '/api/subgen', { k: it.k })).status, 403);
    assert.strictEqual(hits, 0, 'nothing was read from the provider for any of that');

    // The admin asks: made in the background, from one read of the film.
    const st = await a.req('POST', '/api/subgen', { k: it.k });
    assert.strictEqual(st.status, 200, st.text);
    assert.ok(['queued', 'waiting', 'audio', 'writing', 'done'].includes(st.json.state));
    let done = null;
    assert.ok(await until(async () => { done = (await a.req('GET', `/api/subgen?k=${k}`)).json; return done.state === 'done' || done.state === 'failed'; }), JSON.stringify(done));
    assert.strictEqual(done.state, 'done', done.err);
    assert.strictEqual(done.lang, 'en');
    assert.strictEqual(hits, 1);
    // Anyone can use them once they're there (Sam too); only the admin deletes them.
    const vtt = await s.req('GET', done.url);
    assert.match(vtt.text, /^WEBVTT\n\n00:00:01\.000 --> 00:00:03\.500\n Hello there\./);
    const later = await s.req('GET', done.url + '?offset=10');
    assert.ok(!/Hello there/.test(later.text) && /00:00:02\.000 --> 00:00:04\.000\n General Kenobi\./.test(later.text), 'a conversion that starts 10 s in: the lines move with it');
    assert.strictEqual((await s.req('GET', `/api/subgen?k=${k}`)).json.state, 'done');
    assert.strictEqual((await s.req('DELETE', `/api/subgen?k=${k}`)).status, 403);
    assert.strictEqual((await a.req('DELETE', `/api/subgen?k=${k}`)).status, 200);
    assert.strictEqual((await a.req('GET', `/api/subgen?k=${k}`)).json.state, 'none');
    // Off: nobody, and devices are told it isn't there.
    await a.req('PUT', '/api/admin/settings', { subGen: 'off' });
    assert.strictEqual((await a.req('GET', '/api/boot')).json.subGen, '');
    assert.strictEqual((await a.req('POST', '/api/subgen', { k: it.k })).status, 403);
  } finally { app.kill('SIGKILL'); pv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
