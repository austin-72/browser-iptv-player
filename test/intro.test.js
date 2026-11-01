'use strict';
/*
 * Tests for lib/intro.js — run with:  node test/intro.test.js
 * Generates synthetic episodes with ffmpeg in test/tmp-intro/ (removed at the end unless KEEP=1).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const {
  IntroDetector, computeFingerprint, compareFingerprints, classifyChapter, chaptersToMarkers, makeRealPower,
} = require('../lib/intro');

const TMP = path.join(__dirname, 'tmp-intro');
const SR = 22050;               // synthesis rate (ffmpeg resamples on encode)
const INTRO_LEN = 35;
const CREDITS_LEN = 25;
const TOL = 1.5;
let failures = 0;
const summary = [];

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// ------------------------------------------------------------------------------------------
// Deterministic synthesis
// ------------------------------------------------------------------------------------------
function rngFrom(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : [...String(seed)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addTone(buf, t0, dur, freq, amp, harmonics, decay, rng) {
  const s0 = Math.round(t0 * SR);
  const n = Math.round(dur * SR);
  const phase0 = rng ? rng() * 6.283 : 0;
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.008) * Math.exp(-t / decay) * Math.min(1, (n - i) / (0.01 * SR));
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += Math.sin(phase0 + 2 * Math.PI * freq * h * t) / (h * h * 0.7 + 0.3);
    buf[s0 + i] += amp * env * v;
  }
}

function addNoiseBurst(buf, t0, dur, amp, decay, rng, lp) {
  const s0 = Math.round(t0 * SR);
  const n = Math.round(dur * SR);
  let y = 0;
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const x = rng() * 2 - 1;
    y = lp ? y + lp * (x - y) : x;
    buf[s0 + i] += amp * Math.exp(-(i / SR) / decay) * y;
  }
}

function addKick(buf, t0, amp) {
  const s0 = Math.round(t0 * SR);
  let ph = 0;
  for (let i = 0; i < 0.25 * SR && s0 + i < buf.length; i++) {
    const t = i / SR;
    const f = 50 + 90 * Math.exp(-t / 0.04);
    ph += 2 * Math.PI * f / SR;
    buf[s0 + i] += amp * Math.exp(-t / 0.09) * Math.sin(ph);
  }
}

/** Music-like signal: melody + chords + drums, from a seed. */
function music(seed, dur, { bpm, root, fadeOut = 0 } = {}) {
  const rng = rngFrom(seed);
  const buf = new Float32Array(Math.round(dur * SR));
  bpm = bpm || 90 + Math.floor(rng() * 60);
  root = root || 180 + rng() * 140;
  const beat = 60 / bpm;
  const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
  const chordRoots = [0, 5, 7, 3, 8, 10].map((x) => x - 12);
  let step = 0;
  for (let t = 0; t < dur; t += beat / 2, step++) {
    const beatIdx = step >> 1;
    // melody (some rests)
    if (rng() > 0.15) {
      const st = scale[Math.floor(rng() * scale.length)];
      addTone(buf, t, beat * (rng() < 0.3 ? 1.2 : 0.6), root * Math.pow(2, st / 12), 0.18, 4, beat * 0.5, rng);
    }
    // chords every 2 beats
    if (step % 4 === 0) {
      const cr = chordRoots[Math.floor(rng() * chordRoots.length)];
      for (const iv of [0, 4, 7]) addTone(buf, t, beat * 2.1, root * Math.pow(2, (cr + iv) / 12), 0.07, 3, beat * 1.4, rng);
    }
    if (step % 2 === 0) {
      if (beatIdx % 2 === 0) addKick(buf, t, 0.35);
      else addNoiseBurst(buf, t, 0.2, 0.18, 0.06, rng, 0.5);
    }
    addNoiseBurst(buf, t, 0.05, 0.05, 0.015, rng, 0.9);
  }
  if (fadeOut > 0) {
    const n = Math.round(fadeOut * SR);
    for (let i = 0; i < n; i++) buf[buf.length - n + i] *= 1 - i / n * 0.8;
  }
  return buf;
}

function bandpass(f, q) {
  const w = 2 * Math.PI * f / SR, al = Math.sin(w) / (2 * q), a0 = 1 + al;
  return { b0: al / a0, b2: -al / a0, a1: -2 * Math.cos(w) / a0, a2: (1 - al) / a0 };
}

/** Speech-like signal: glottal pulses through formant resonators, syllables & pauses. */
function speech(seed, dur) {
  const rng = rngFrom(seed);
  const buf = new Float32Array(Math.round(dur * SR));
  let f0base = 95 + rng() * 120;
  let t = 0.05;
  const st = [[0, 0], [0, 0], [0, 0]];
  while (t < dur) {
    const phraseEnd = Math.min(dur, t + 1.5 + rng() * 2.5);
    while (t < phraseEnd) {
      const syl = 0.12 + rng() * 0.2;
      const voiced = rng() > 0.2;
      const F = [300 + rng() * 550, 900 + rng() * 1400, 2300 + rng() * 700];
      const filt = F.map((f, k) => bandpass(f, k === 0 ? 5 : 8));
      const f0 = f0base * (0.85 + rng() * 0.35);
      const s0 = Math.round(t * SR), n = Math.round(syl * SR);
      let ph = 0;
      for (let i = 0; i < n && s0 + i < buf.length; i++) {
        const env = Math.sin(Math.PI * i / n);
        let x;
        if (voiced) { ph += (f0 * (1 + 0.1 * Math.sin(i / n * 3))) / SR; x = ph >= 1 ? (ph -= 1, 1.0) : 0; x -= 0.01; }
        else x = (rng() * 2 - 1) * 0.15;
        let y = 0;
        for (let k = 0; k < 3; k++) {
          const c = filt[k], s = st[k];
          const o = c.b0 * x + s[0];
          s[0] = -c.a1 * o + s[1];
          s[1] = c.b2 * x - c.a2 * o;
          y += o * (k === 0 ? 1 : 0.6);
        }
        buf[s0 + i] += 0.9 * env * y;
      }
      t += syl;
    }
    f0base = Math.max(85, Math.min(240, f0base * (0.9 + rng() * 0.2)));
    t += 0.25 + rng() * 0.6;
  }
  return buf;
}

function concat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function mixInto(dst, src, at, gain) {
  const s0 = Math.round(at * SR);
  for (let i = 0; i < src.length && s0 + i < dst.length; i++) dst[s0 + i] += gain * src[i];
}

/** Unique "episode body": speech with underscore music cues and room tone. */
function uniqueContent(seed, dur) {
  const rng = rngFrom(seed + ':layout');
  const buf = speech(seed + ':speech', dur);
  let t = 2 + rng() * 10;
  let k = 0;
  while (t < dur - 5) {
    const len = Math.min(dur - t, 8 + rng() * 14);
    mixInto(buf, music(`${seed}:cue${k++}`, len), t, 0.5);
    t += len + 10 + rng() * 25;
  }
  const r2 = rngFrom(seed + ':room');
  let y = 0;
  for (let i = 0; i < buf.length; i++) { y += 0.02 * ((r2() * 2 - 1) - y); buf[i] += 0.02 * y; }
  return buf;
}

function writePcm(file, buf, gain, noiseAmp, noiseSeed) {
  const rng = rngFrom(noiseSeed);
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    let v = buf[i] * gain + noiseAmp * (rng() * 2 - 1);
    v = Math.max(-1, Math.min(1, v * 0.7));
    out.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  fs.writeFileSync(file, out);
}

function ff(args, what) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg (${what}) failed: ${r.stderr}`);
}

function encodeEpisode(pcmFile, out, dur, { abr, ar }) {
  ff(['-f', 's16le', '-ar', String(SR), '-ac', '1', '-i', pcmFile,
    '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=10:duration=${dur}`,
    '-map', '1:v', '-map', '0:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '38', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', abr, '-ar', String(ar), '-ac', '2', '-shortest', out], out);
}

// ------------------------------------------------------------------------------------------
// HTTP server with Range support
// ------------------------------------------------------------------------------------------
function startServer(file, requiredHeaders) {
  const seen = { requests: 0, rangeRequests: 0, rejected: 0, ua: null };
  const srv = http.createServer((req, res) => {
    seen.requests++;
    seen.ua = req.headers['user-agent'];
    for (const [k, v] of Object.entries(requiredHeaders)) {
      if (req.headers[k.toLowerCase()] !== v) { seen.rejected++; res.writeHead(403); res.end('forbidden'); return; }
    }
    const size = fs.statSync(file).size;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      seen.rangeRequests++;
      let start = m[1] === '' ? size - parseInt(m[2], 10) : parseInt(m[1], 10);
      let end = m[1] !== '' && m[2] !== '' ? parseInt(m[2], 10) : size - 1;
      if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      end = Math.min(end, size - 1);
      res.writeHead(206, {
        'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1,
      });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': size });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen })));
}

// ------------------------------------------------------------------------------------------
function near(a, b) { return a != null && Math.abs(a - b) <= TOL; }
function fmtSeg(s) { return s ? `${s.start.toFixed(2)}–${s.end.toFixed(2)} (c=${s.confidence})` : 'null'; }

async function main() {
  const tStart = Date.now();
  fs.mkdirSync(TMP, { recursive: true });

  // ---- unit: FFT / chapters classification -------------------------------------------------
  {
    const n = 256, p = makeRealPower(n), x = new Float64Array(n).map(() => Math.random() - 0.5);
    const out = new Float64Array(n / 2 + 1);
    p(x, 0, n / 2 + 1, out);
    let err = 0;
    for (let k = 0; k <= n / 2; k++) {
      let r = 0, i = 0;
      for (let t = 0; t < n; t++) { r += x[t] * Math.cos(2 * Math.PI * k * t / n); i -= x[t] * Math.sin(2 * Math.PI * k * t / n); }
      err = Math.max(err, Math.abs(r * r + i * i - out[k]));
    }
    check('real FFT matches naive DFT', err < 1e-9, `max err ${err.toExponential(2)}`);
    const cases = {
      Intro: 'intro', Opening: 'intro', OP: 'intro', 'Opening Credits': 'intro', 'Intro Start': 'intro',
      Recap: null, 'Recap / Intro': null, 'Previously On': null, Prologue: null, 'Intro End': null,
      Credits: 'credits', 'End Credits': 'credits', Ending: 'credits', ED: 'credits', Outro: 'credits',
      'Post-Credits Scene': null, Preview: null, 'Chapter 3': null, Episode: null,
    };
    const bad = Object.entries(cases).filter(([t, k]) => classifyChapter(t) !== k);
    check('chapter title classification', !bad.length, bad.map(([t]) => `${t}->${classifyChapter(t)}`).join(', '));
    const m = chaptersToMarkers([
      { start: 0, end: 60, title: 'Recap' }, { start: 60, end: 150, title: 'Opening' },
      { start: 150, end: 1300, title: 'Part A' }, { start: 1300, end: 1390, title: 'Ending' },
      { start: 1390, end: 1420, title: 'Preview' }], 1420);
    check('chaptersToMarkers (Recap/Opening/Ending/Preview)',
      m.intro && m.intro.start === 60 && m.intro.end === 150 && m.credits && m.credits.start === 1300 && m.credits.end === 1390,
      JSON.stringify(m));
  }

  // ---- synthesize episodes -----------------------------------------------------------------
  let t = Date.now();
  const introAudio = music('SHARED-INTRO', INTRO_LEN, { bpm: 128, root: 220 });
  const creditsAudio = music('SHARED-CREDITS', CREDITS_LEN, { bpm: 96, root: 262, fadeOut: 3 });
  const specs = [
    { id: 'S01E01', cold: 0, total: 180, ext: 'mp4', abr: '128k', ar: 48000, gain: 1.0, noise: 0.002 },
    { id: 'S01E02', cold: 20.37, total: 220, ext: 'mp4', abr: '96k', ar: 44100, gain: 0.85, noise: 0.004 },
    { id: 'S01E03', cold: 45.05, total: 260, ext: 'mp4', abr: '160k', ar: 48000, gain: 1.12, noise: 0.003 },
    { id: 'S01E04', cold: 70.73, total: 300, ext: 'mkv', abr: '64k', ar: 44100, gain: 0.93, noise: 0.006 },
  ];
  const eps = [];
  for (const s of specs) {
    const middle = s.total - s.cold - INTRO_LEN - CREDITS_LEN;
    const audio = concat([
      uniqueContent(`${s.id}-cold`, s.cold), introAudio, uniqueContent(`${s.id}-middle`, middle), creditsAudio,
    ]);
    const pcm = path.join(TMP, `${s.id}.pcm`);
    writePcm(pcm, audio, s.gain, s.noise, `${s.id}-noise`);
    const file = path.join(TMP, `${s.id}.${s.ext}`);
    encodeEpisode(pcm, file, s.total, s);
    fs.unlinkSync(pcm);
    eps.push({ ...s, file, truth: { intro: [s.cold, s.cold + INTRO_LEN], credits: [s.total - CREDITS_LEN, s.total] } });
  }
  // unrelated episodes (nothing shared)
  const unrelated = [];
  for (let k = 0; k < 3; k++) {
    const id = `X0${k + 1}`;
    const pcm = path.join(TMP, `${id}.pcm`);
    writePcm(pcm, uniqueContent(`${id}-all`, 150 + 20 * k), 1, 0.003, `${id}-noise`);
    const file = path.join(TMP, `${id}.mp4`);
    encodeEpisode(pcm, file, 150 + 20 * k, { abr: '128k', ar: 48000 });
    fs.unlinkSync(pcm);
    unrelated.push({ id, file });
  }
  // chapters MKV made from episode 3
  const e3 = eps[2];
  const meta = path.join(TMP, 'chapters.ffmetadata');
  const ms = (x) => Math.round(x * 1000);
  fs.writeFileSync(meta, [';FFMETADATA1',
    ...[['Recap', 0, 45], ['Intro', 45, 80], ['Episode', 80, e3.total - 25], ['Credits', e3.total - 25, e3.total]]
      .map(([title, a, b]) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${ms(a)}\nEND=${ms(b)}\ntitle=${title}`)].join('\n') + '\n');
  const chapFile = path.join(TMP, 'S01E03-chapters.mkv');
  ff(['-i', e3.file, '-i', meta, '-map', '0', '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy', chapFile], 'chapters');
  // video-only file
  const noAudio = path.join(TMP, 'noaudio.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=30', '-c:v', 'libx264', '-preset', 'ultrafast', noAudio], 'noaudio');
  console.log(`# generated test media in ${((Date.now() - t) / 1000).toFixed(1)} s`);

  const logLines = [];
  const det = new IntroDetector({ log: (m) => { logLines.push(m); if (process.env.VERBOSE) console.log(m); } });

  // ---- duration / fingerprint basics -------------------------------------------------------
  {
    const d = await det.duration(eps[1].file);
    check('duration() via ffprobe', Math.abs(d - eps[1].total) < 0.2, `${d}`);
    check('duration() of missing file -> 0', (await det.duration(path.join(TMP, 'missing.mp4'))) === 0);
    t = Date.now();
    const fp = await det.fingerprint(eps[3].file, { start: 0, duration: 150 });
    const ms1 = Date.now() - t;
    check('fingerprint() shape', fp.frames instanceof Uint32Array && fp.hop >= 0.05 && fp.hop <= 0.15 &&
      Math.abs(fp.frames.length * fp.hop - 150) < 1.5, `hop=${fp.hop} frames=${fp.frames.length} (${ms1} ms incl. decode)`);
    const fpNo = await det.fingerprint(noAudio, { duration: 30 });
    check('fingerprint() of audio-less input -> empty', fpNo.frames.length === 0);
  }

  // ---- main season: cold opens of 0, 20.37, 45.05, 70.73 s (sub-hop offsets) ---------------------------------------------
  {
    t = Date.now();
    const res = await det.detectSeason(eps.map((e) => ({ id: e.id, input: e.file })),
      { introWindow: 600, creditsWindow: 480, minIntro: 10, maxIntro: 150, minCredits: 10 });
    const ms2 = Date.now() - t;
    summary.push(`main season (4 eps, 16 min of media): detectSeason ${ms2} ms`);
    for (const e of eps) {
      const r = res.find((x) => x.id === e.id);
      const ti = e.truth.intro, tc = e.truth.credits;
      const okI = r && r.intro && near(r.intro.start, ti[0]) && near(r.intro.end, ti[1]);
      const okC = r && r.credits && near(r.credits.start, tc[0]) && near(r.credits.end, tc[1]);
      check(`${e.id} (${e.ext}, cold open ${e.cold}s) intro`, okI, `got ${fmtSeg(r && r.intro)}, truth ${ti[0]}–${ti[1]}`);
      check(`${e.id} credits`, okC, `got ${fmtSeg(r && r.credits)}, truth ${tc[0]}–${tc[1]}`);
      check(`${e.id} source=audio`, r && r.source === 'audio', r && r.source);
      if (r && r.intro) summary.push(`${e.id} intro err start ${(r.intro.start - ti[0]).toFixed(2)} s, end ${(r.intro.end - ti[1]).toFixed(2)} s`);
      if (r && r.credits) summary.push(`${e.id} credits err start ${(r.credits.start - tc[0]).toFixed(2)} s, end ${(r.credits.end - tc[1]).toFixed(2)} s`);
    }
    check('main season timing < 60 s', ms2 < 60000, `${ms2} ms`);
  }

  // ---- direct compare timing on two 10-minute windows --------------------------------------
  {
    const a = computeFingerprint(new Int16Array(5000 * 600).map(() => (Math.random() - 0.5) * 20000));
    const b = computeFingerprint(new Int16Array(5000 * 600).map(() => (Math.random() - 0.5) * 20000));
    const fa = { ...a, hop: 0.1, start: 0 }, fb = { ...b, hop: 0.1, start: 0 };
    t = Date.now();
    const c = compareFingerprints(fa, fb, { minLen: 10, maxLen: 150 });
    const ms3 = Date.now() - t;
    summary.push(`compare two 10-min fingerprints: ${ms3} ms`);
    check('compare 2×10 min windows fast and no match on noise', ms3 < 3000 && c.length === 0, `${ms3} ms, ${c.length} cands`);
  }

  // ---- chapters ------------------------------------------------------------------------------
  {
    const ch = await det.chapters(chapFile);
    check('chapters() reads Intro/Credits (Recap ignored)',
      ch.intro && Math.abs(ch.intro.start - 45) < 0.01 && Math.abs(ch.intro.end - 80) < 0.01 &&
      ch.credits && Math.abs(ch.credits.start - (e3.total - 25)) < 0.01 && Math.abs(ch.credits.end - e3.total) < 0.01,
      JSON.stringify(ch));
    const none = await det.chapters(eps[0].file);
    check('chapters() without chapters -> nulls', !none.intro && !none.credits);
    const res = await det.detectSeason([{ id: 'chap', input: chapFile }, { id: 'e1', input: eps[0].file }]);
    const rc = res[0], r1 = res[1];
    check('detectSeason uses chapters when present', rc.source === 'chapters' && rc.intro && rc.intro.start === 45 &&
      rc.intro.end === 80 && rc.credits && rc.credits.start === e3.total - 25, JSON.stringify(rc));
    check('2-episode group: partner of chapter file detected by audio',
      r1.source === 'audio' && near(r1.intro && r1.intro.start, 0) && near(r1.intro && r1.intro.end, 35) &&
      near(r1.credits && r1.credits.start, 155) && near(r1.credits && r1.credits.end, 180),
      `intro ${fmtSeg(r1.intro)} credits ${fmtSeg(r1.credits)}`);
  }

  // ---- nothing shared -> no false positives ---------------------------------------------------
  {
    const res = await det.detectSeason(unrelated.map((u) => ({ id: u.id, input: u.file })));
    const fp = res.filter((r) => r.intro || r.credits);
    check('unrelated episodes -> all nulls (no false positives)', fp.length === 0 && res.every((r) => r.source === 'none'),
      fp.map((r) => `${r.id}: intro ${fmtSeg(r.intro)} credits ${fmtSeg(r.credits)}`).join('; '));
    // also: shared-intro season mixed with unrelated episodes must not give the unrelated ones anything
    const mixed = await det.detectSeason([
      { id: 'e1', input: eps[0].file }, { id: 'x1', input: unrelated[0].file }, { id: 'e2', input: eps[1].file },
    ]);
    check('mixed group: unrelated episode gets nulls', !mixed[1].intro && !mixed[1].credits, JSON.stringify(mixed[1]));
    check('mixed group: related episodes still detected', near(mixed[0].intro && mixed[0].intro.end, 35) &&
      near(mixed[2].intro && mixed[2].intro.start, eps[1].cold), `e1 ${fmtSeg(mixed[0].intro)} e2 ${fmtSeg(mixed[2].intro)}`);
  }

  // ---- bad inputs ------------------------------------------------------------------------------
  {
    let threw = false, res;
    try {
      res = await det.detectSeason([
        { id: 'e1', input: eps[0].file }, { id: 'noaudio', input: noAudio },
        { id: 'missing', input: path.join(TMP, 'does-not-exist.mp4') }, { id: 'e3', input: eps[2].file },
      ]);
    } catch (e) { threw = e; }
    check('bad inputs do not throw', !threw, threw && threw.message);
    if (res) {
      check('audio-less input -> nulls', !res[1].intro && !res[1].credits);
      check('missing input -> nulls (+error)', !res[2].intro && !res[2].credits && !!res[2].error, res[2].error);
      check('good episodes in same group still detected', near(res[0].intro && res[0].intro.start, 0) &&
        near(res[3].intro && res[3].intro.start, eps[2].cold) && near(res[3].credits && res[3].credits.start, 235),
        `e1 ${fmtSeg(res[0].intro)} e3 ${fmtSeg(res[3].intro)} / ${fmtSeg(res[3].credits)}`);
    }
  }

  // ---- http(s) URL input with headers + Range ----------------------------------------------------
  {
    const { srv, port, seen } = await startServer(eps[1].file, { 'X-Token': 'abc123', 'User-Agent': 'BiptvTest/1.0' });
    try {
      const url = `http://127.0.0.1:${port}/vod/S01E02.mp4`;
      const headers = { 'User-Agent': 'BiptvTest/1.0', 'X-Token': 'abc123' };
      const d = await det.duration(url, { headers });
      check('duration() over http with headers', Math.abs(d - eps[1].total) < 0.2, `${d}`);
      check('duration() over http without required header -> 0', (await det.duration(url)) === 0);
      t = Date.now();
      const res = await det.detectSeason([
        { id: 'e1', input: eps[0].file }, { id: 'url', input: url, headers }, { id: 'e3', input: eps[2].file },
      ]);
      const ms4 = Date.now() - t;
      const r = res[1];
      check('http URL episode intro', near(r.intro && r.intro.start, eps[1].cold) && near(r.intro && r.intro.end, eps[1].cold + INTRO_LEN), fmtSeg(r.intro));
      check('http URL episode credits', near(r.credits && r.credits.start, 195) && near(r.credits && r.credits.end, 220), fmtSeg(r.credits));
      check('http server saw Range requests and custom UA', seen.rangeRequests > 0 && seen.ua === 'BiptvTest/1.0',
        `requests=${seen.requests} range=${seen.rangeRequests} rejected=${seen.rejected}`);
      summary.push(`http group (3 eps, one via URL): ${ms4} ms`);
    } finally {
      srv.close();
    }
  }

  // ---- timeout handling -----------------------------------------------------------------------
  {
    const slow = new IntroDetector({ timeoutMs: 300, probeTimeoutMs: 300 });
    // a server that accepts but never answers
    const hang = http.createServer(() => {});
    await new Promise((r) => hang.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${hang.address().port}/x.mp4`;
    t = Date.now();
    let threw = null, res = null;
    try { res = await slow.detectSeason([{ id: 'h', input: url }, { id: 'e1', input: eps[0].file }]); } catch (e) { threw = e; }
    const ms5 = Date.now() - t;
    check('hanging URL times out, returns nulls', !threw && res && !res[0].intro && !res[0].credits && ms5 < 5000, `${ms5} ms ${threw ? threw.message : ''}`);
    hang.closeAllConnections && hang.closeAllConnections();
    hang.close();
  }

  console.log('\n# summary');
  for (const s of summary) console.log('# ' + s);
  console.log(`# total test time ${((Date.now() - tStart) / 1000).toFixed(1)} s`);

  if (!process.env.KEEP) {
    for (const f of fs.readdirSync(TMP)) fs.rmSync(path.join(TMP, f), { force: true, recursive: true });
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nALL PASSED');
}

main().catch((e) => { console.error('FAIL unexpected error', e); process.exit(1); });
