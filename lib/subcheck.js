'use strict';
/**
 * Is a subtitle file found online the right one for this video, and is it in time with it?
 *
 * Three questions, cheapest first:
 *
 *  1. What does its name say?  "Show.S02E05…" offered for S02E06 is another episode (namesOtherEpisode).
 *  2. Does it fit the video's length?  Lines that run on after the video has ended, a file half as long as the
 *     video, or one with only a handful of lines (a "forced" file: signs and foreign speech only) — fit().
 *  3. Does it match the sound?  The server listens to three minutes of the video's sound in two places (ffmpeg keeps
 *     only the sound, at telephone quality: nothing is converted and nothing about playback changes), marks where it
 *     sounds like talking, and slides the subtitle's lines along that until they line up — syncByEar(). That gives
 *       · how far off the file is (a constant offset: a different opening, a recap cut off), or
 *       · that it runs at another speed (made for a 25-frames-a-second copy of a 23.976 film, and the like), or
 *       · that it lines up nowhere: the wrong episode, or a different cut.
 *     A correction is a straight line — video time = a × file time + b — applied when the file is served
 *     (retimeVtt), so every device gets it, and remembered per title for the whole household.
 *
 * The listening is a judgement, not a measurement: music and noise can sound like talk to it, so it only claims an
 * answer when both places agree on one and it stands well clear of everything else, and says "can't tell" otherwise.
 * It has been tried on made-up sound with known answers (test/subfit.test.js), not on a shelf of real films.
 */
const { spawn } = require('child_process');

// ---------------------------------------------------------------- cues
const tsOf = (t) => { const p = String(t).replace(',', '.').split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
const TIMING = /^((?:\d+:)?\d{2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d{1,3})(.*)$/;
/** A WebVTT (or SRT) text → [{ s, e, text }] in seconds, in order. */
function cuesOf(text) {
  const out = [];
  for (const blk of String(text || '').replace(/\r\n?/g, '\n').split(/\n\n+/)) {
    const lines = blk.split('\n');
    const i = lines.findIndex((l) => TIMING.test(l));
    if (i < 0) continue;
    const m = TIMING.exec(lines[i]);
    const s = tsOf(m[1]), e = tsOf(m[2]);
    if (!(e > s)) continue;
    out.push({ s, e, text: lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim() });
  }
  return out.sort((a, b) => a.s - b.s);
}
/** A line that isn't speech: "[music]", "♪ la la ♪", "(door slams)" — left out when lining up with voices. */
const notSpeech = (t) => { const x = String(t || '').trim(); return !x || /^[\[(][^\])]*[\])]$/.test(x) || /^[♪♫#*\s]/.test(x) || /[♪♫]\s*$/.test(x); };

// ---------------------------------------------------------------- what a name says
/**
 * The episode a release name gives: "Show.S02E05.720p" → { season: 2, episode: 5 }, "S02E05-E06" → { …, to: 6 },
 * "2x05" → the same, "Show.S02.Complete" → { season: 2, pack: true }. null when it says nothing.
 */
function episodeOfName(name) {
  const n = String(name || '');
  let m = /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(?:p(?:isode)?[ ._-]?)?(\d{1,3})(?:(?:[ ._-]?-?[ ._-]?e|-)(\d{1,3}))?(?![0-9])/i.exec(n);
  if (m) { const o = { season: +m[1], episode: +m[2] }; if (m[3] && +m[3] > o.episode && +m[3] - o.episode < 60) o.to = +m[3]; return o; }
  m = /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9])/i.exec(n);
  if (m && !/\d{3,4}x\d{3,4}/.test(m[0])) return { season: +m[1], episode: +m[2] };
  m = /season[ ._-]*(\d{1,2})[ ._,-]*episode[ ._-]*(\d{1,3})/i.exec(n);
  if (m) return { season: +m[1], episode: +m[2] };
  m = /(?:^|[^a-z0-9])(?:s|season[ ._-]?)(\d{1,2})(?![0-9x])(?![ ._-]?e\d)/i.exec(n);
  if (m) return { season: +m[1], pack: true };
  return null;
}
/** Does the name plainly belong to another episode (or another season) than the one asked for? */
function namesOtherEpisode(name, season, episode) {
  if (!season || !episode) return false;
  const e = episodeOfName(name);
  if (!e) return false;
  if (e.season !== +season) return true;
  if (e.pack) return false;
  return e.to ? !(+episode >= e.episode && +episode <= e.to) : e.episode !== +episode;
}

// ---------------------------------------------------------------- does it fit the video's length?
/**
 * cues against the video's length in seconds (0: not known — then only "hardly any lines" can be said).
 * → { ok, why: '' | 'long' | 'short' | 'sparse' | 'empty', last, over }
 */
function fit(cues, dur) {
  if (!cues.length) return { ok: false, why: 'empty', last: 0, over: 0 };
  const last = cues[cues.length - 1].e, first = cues[0].s;
  const span = Math.max(60, dur > 0 ? dur : last);
  // (A film's worth of talk is hundreds of lines; a "forced" file has a few dozen at most.)
  if (cues.length < Math.max(8, span / 60 * 1.2) && span >= 300) return { ok: false, why: 'sparse', last, over: 0 };
  if (!(dur > 0)) return { ok: true, why: '', last, over: 0 };
  const over = last - dur;
  if (over > Math.max(20, dur * 0.012)) return { ok: false, why: 'long', last, over };
  if (dur > 600 && last < dur * 0.5) return { ok: false, why: 'short', last, over };
  if (dur > 600 && first > dur * 0.5) return { ok: false, why: 'short', last, over };
  return { ok: true, why: '', last, over };
}

// ---------------------------------------------------------------- moving a file's times
const fmtTs = (t) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${x.toFixed(3).padStart(6, '0')}`; };
/** Every cue's times through t → a·t + b (cues that end before 0 are dropped). */
function retimeVtt(text, a, b) {
  if (a === 1 && !b) return String(text);
  return String(text).replace(/\r\n?/g, '\n').split(/\n\n+/).map((blk) => {
    const lines = blk.split('\n');
    const i = lines.findIndex((l) => TIMING.test(l));
    if (i < 0) return blk;
    const m = TIMING.exec(lines[i]);
    const s = a * tsOf(m[1]) + b, e = a * tsOf(m[2]) + b;
    if (e <= 0) return null;
    lines[i] = `${fmtTs(Math.max(0, s))} --> ${fmtTs(e)}${m[3]}`;
    return lines.join('\n');
  }).filter((x) => x !== null).join('\n\n');
}

// ---------------------------------------------------------------- listening
const FRAME = 0.04; // seconds a frame
const RATE = 8000;
/**
 * Sound (16-bit mono at RATE) → one number a frame, 0…1: how much it sounds like someone talking just then.
 *
 * Speech goes up and down in loudness several times a second (syllables); music, engines, rain and applause hold
 * steadier. So: the loudness of each frame in decibels, then how much that moves within about half a second around
 * the frame, less whatever is usual for this stretch of the film (so a scene with restless music all through doesn't
 * count as talk all through). Louder-or-quieter doesn't matter, only the movement — which is what lets speech under
 * music be found at all. It is a rough ear: it is only ever used by sliding a subtitle file's lines along it and
 * asking where they fit best.
 */
function speechiness(pcm) {
  const per = Math.round(RATE * FRAME), n = Math.floor(pcm.length / per);
  const db = new Float32Array(n), out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let i = f * per, e = i + per; i < e; i++) sum += pcm[i] * pcm[i];
    db[f] = 10 * Math.log10(sum / per + 1);
  }
  const W = 6;
  for (let i = 0; i < n; i++) {
    let s = 0, q = 0, k = 0;
    for (let j = Math.max(0, i - W), e = Math.min(n - 1, i + W); j <= e; j++) { s += db[j]; q += db[j] * db[j]; k++; }
    out[i] = Math.min(1, Math.sqrt(Math.max(0, q / k - (s / k) * (s / k))) / 6);
  }
  // Less the usual for the 20 seconds around (its lower third: what this stretch sounds like when nobody talks).
  const half = Math.round(10 / FRAME), usual = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    if (i % 5 === 0) { const a = Array.from(out.subarray(Math.max(0, i - half), Math.min(n, i + half))).sort((x, y) => x - y); last = a[Math.floor(a.length * 0.3)]; }
    usual[i] = last;
  }
  for (let i = 0; i < n; i++) out[i] = Math.max(0, out[i] - usual[i]);
  return out;
}
/** The file's spoken lines as 0/1 a frame, for file times from..to (seconds). */
function cueFrames(cues, from, to) {
  const n = Math.max(0, Math.round((to - from) / FRAME)), out = new Uint8Array(n);
  for (const c of cues) {
    if (c.e <= from || c.s >= to || notSpeech(c.text)) continue;
    const a = Math.max(0, Math.round((c.s - from) / FRAME)), b = Math.min(n, Math.round((c.e - from) / FRAME));
    for (let i = a; i < b; i++) out[i] = 1;
  }
  return out;
}
/**
 * How well the file's lines fit the sound (from video time t0) at every offset within ±maxLag seconds.
 * → { z: Float32Array (per offset: how far that fit stands above the rest, in standard deviations; NaN where the
 *     file has hardly a line), M, talk, lines } — index k is offset (M − k)·FRAME seconds, video − file.
 */
function lagScores(feat, cues, t0, maxLag) {
  const n = feat.length, M = Math.round(maxLag / FRAME), win = n * FRAME;
  const vec = cueFrames(cues, t0 - maxLag, t0 + win + maxLag); // index j ↔ file time t0 − maxLag + j·FRAME
  let ma = 0, talk = 0;
  for (let i = 0; i < n; i++) { ma += feat[i]; if (feat[i] > 0.08) talk++; }
  ma /= n || 1;
  const a = new Float32Array(n);
  let va = 0;
  for (let i = 0; i < n; i++) { a[i] = feat[i] - ma; va += a[i] * a[i]; }
  let inWin = 0; { const c0 = cueFrames(cues, t0, t0 + win); for (let i = 0; i < c0.length; i++) inWin += c0[i]; }
  const out = { z: new Float32Array(2 * M + 1).fill(NaN), M, talk: talk / (n || 1), lines: inWin / (n || 1), n };
  if (n < 500 || va < 1e-6) return out;
  const pre = new Float64Array(vec.length + 1);
  for (let j = 0; j < vec.length; j++) pre[j + 1] = pre[j] + vec[j];
  const sc = new Float32Array(2 * M + 1);
  let sum = 0, sq = 0, used = 0;
  for (let k = 0; k <= 2 * M; k++) {
    const cnt = pre[k + n] - pre[k];
    if (cnt < n * 0.03 || cnt > n * 0.97) { sc[k] = NaN; continue; } // (hardly a line in this stretch of the file, or nothing but)
    let s = 0;
    for (let i = 0; i < n; i++) if (vec[i + k]) s += a[i];
    const pb = cnt / n, v = s / Math.sqrt(va * n * pb * (1 - pb) + 1e-9);
    sc[k] = v; sum += v; sq += v * v; used++;
  }
  if (used < 50) return out;
  const mean = sum / used, sd = Math.sqrt(Math.max(1e-12, sq / used - mean * mean));
  for (let k = 0; k <= 2 * M; k++) out.z[k] = isNaN(sc[k]) ? NaN : (sc[k] - mean) / sd;
  out.used = used;
  return out;
}
/** The top of z near index k (within ±r), and where: finer than a frame, by a parabola through it and its neighbours. */
function peakNear(z, k, r) {
  let best = -Infinity, at = -1;
  for (let i = Math.max(0, k - r), e = Math.min(z.length - 1, k + r); i <= e; i++) if (z[i] > best) { best = z[i]; at = i; }
  if (at < 0) return { z: -Infinity, k: k };
  let frac = 0;
  if (at > 0 && at < z.length - 1 && !isNaN(z[at - 1]) && !isNaN(z[at + 1])) { const den = z[at - 1] - 2 * z[at] + z[at + 1]; if (den < 0) frac = Math.max(-0.5, Math.min(0.5, 0.5 * (z[at - 1] - z[at + 1]) / den)); }
  return { z: best, k: at + frac };
}
/**
 * The offset the places listened to agree on. Each place alone is noisy — some other offset often scores nearly
 * as well by chance — but chance doesn't pick the same offset twice. → { j (the fits added up), second (the best
 * sum anywhere else), offs: [offset per place], zs: [fit per place] }
 */
function agree(scores, slack = 25) {
  const first = scores[0], L = first.z.length;
  const J = new Float32Array(L).fill(NaN);
  for (let k = 0; k < L; k++) {
    if (isNaN(first.z[k])) continue;
    let j = first.z[k];
    for (let w = 1; w < scores.length; w++) { const p = peakNear(scores[w].z, k, slack); j += p.z === -Infinity ? -9 : p.z; }
    J[k] = j;
  }
  let best = -Infinity, bk = 0;
  for (let k = 0; k < L; k++) if (J[k] > best) { best = J[k]; bk = k; }
  let second = -Infinity; const guard = Math.round(3 / FRAME);
  for (let k = 0; k < L; k++) if (Math.abs(k - bk) > guard && J[k] > second) second = J[k];
  const ps = scores.map((s, w) => peakNear(s.z, bk, w ? slack : 1));
  return { j: best, second, offs: ps.map((p) => (first.M - p.k) * FRAME), zs: ps.map((p) => p.z) };
}

/** Speeds a file can be off by: made for one frame rate, played with a video at another. (a: video time = a × file time.) */
const SPEEDS = [25 / 23.976, 23.976 / 25, 25 / 24, 24 / 25];
const SLIGHT = [24 / 23.976, 23.976 / 24]; // (a tenth of a percent: seen as two places a little apart, not tried as such)

/**
 * read(start, secs) → Promise<Int16Array> (mono, RATE); cues; dur: the video's length (0: unknown).
 * → { state: 'ok' | 'mismatch' | 'unknown', a, b, offset, z, windows: [...] }
 *    ok: in time once moved by a, b (a = 1, b = 0: it already was).  mismatch: lines up nowhere.
 *
 * How sure is sure: with two places, their fits added up must reach 8.5, each be a clear fit of its own, and the sum
 * stand well clear of the best sum at any other offset; one place alone (a short video) must stand out much more. "Lines up nowhere" is only said when
 * both places plainly had talk in them, the file plainly had lines there, and nothing came near — and the caller
 * treats even that as a reason to try other subtitles first, not as proof.
 */
async function syncByEar({ read, cues, dur, maxLag = 120, secs = 180 }) {
  const out = { state: 'unknown', a: 1, b: 0, offset: 0, z: 0, windows: [] };
  if (cues.length < 8) return out;
  const end = dur > 0 ? dur : cues[cues.length - 1].e;
  const starts = end > 1500 ? [Math.max(120, end * 0.12), end * 0.6] : end > 500 ? [Math.min(90, end * 0.15), Math.max(end * 0.55, 240)] : [Math.max(0, Math.min(30, end * 0.1))];
  const len = Math.min(secs, Math.max(60, end * 0.4));
  const heard = [];
  for (const t0 of starts) {
    let pcm = null;
    try { pcm = await read(t0, len); } catch (e) { out.windows.push({ t0, err: e.message }); continue; }
    if (!pcm || pcm.length < RATE * 45) { out.windows.push({ t0, err: 'too little sound' }); continue; }
    heard.push({ t0, len: pcm.length / RATE, feat: speechiness(pcm) });
  }
  if (!heard.length) return out;
  // The file as it is, and as it would be for a copy at another speed.
  const tries = [];
  for (const a of [1, ...(heard.length > 1 ? SPEEDS : [])]) {
    const scaled = a === 1 ? cues : cues.map((c) => ({ s: c.s * a, e: c.e * a, text: c.text }));
    const scores = heard.map((h) => lagScores(h.feat, scaled, h.t0, maxLag));
    tries.push({ a, scores, ...agree(scores) });
  }
  const one = tries[0];
  heard.forEach((h, w) => out.windows.push({ t0: Math.round(h.t0), len: Math.round(h.len), talk: Math.round(one.scores[w].talk * 100) / 100, lines: Math.round(one.scores[w].lines * 100) / 100, offset: Math.round(one.offs[w] * 100) / 100, z: Math.round(one.zs[w] * 10) / 10 }));
  const good = (t) => (heard.length > 1 ? t.j >= 8.5 && t.j >= t.second * 1.3 && Math.min(...t.zs) >= 3 : t.j >= 5 && t.j >= t.second * 1.6);
  // (Another speed has to be plainly better than the file as it is.)
  let pick = good(one) ? one : null;
  for (const t of tries.slice(1)) if (good(t) && t.j > (pick ? pick.j * 1.25 : 0)) pick = t;
  out.j = Math.round(one.j * 10) / 10; out.second = Math.round(one.second * 10) / 10;
  if (!pick) {
    const best = Math.max(...tries.map((t) => t.j));
    const clear = heard.length > 1 && out.windows.every((w) => !w.err && w.talk >= 0.12 && w.talk <= 0.85 && w.lines >= 0.1);
    if (clear && best < 6.5) out.state = 'mismatch';
    return out;
  }
  out.state = 'ok'; out.z = Math.round(pick.j * 10) / 10;
  let a = pick.a, b = pick.offs.reduce((x, y) => x + y, 0) / pick.offs.length;
  if (heard.length > 1 && Math.abs(pick.offs[0] - pick.offs[1]) > 0.3) {
    // The two places a little apart: a slightly different speed (24 against 23.976 frames a second is 3.6 s an hour).
    const mid = (h) => h.t0 + h.len / 2;
    const f1 = (mid(heard[0]) - pick.offs[0]) / a, f2 = (mid(heard[1]) - pick.offs[1]) / a;
    const fitA = (mid(heard[1]) - mid(heard[0])) / (f2 - f1);
    const snap = [...SLIGHT.map((s) => s * a), a].find((s) => Math.abs(fitA - s) < 0.0005);
    if (snap) { a = snap; b = (mid(heard[0]) - a * f1 + mid(heard[1]) - a * f2) / 2; }
  }
  out.a = a; out.b = b; out.offset = pick.offs[0];
  return out;
}

/**
 * The sound of `secs` seconds of a video from `start`, as 16-bit mono at RATE with everything outside the range of a
 * voice filtered away. ff: { bin, netArgs(input, headers) }.
 */
function listen(ff, { input, headers, local, start, secs, timeoutMs = 75000, onChild }) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...(local ? [] : ff.netArgs(input, headers || {})), '-ss', String(Math.max(0, start)), '-i', input,
      '-t', String(secs), '-map', '0:a:0', '-vn', '-sn', '-dn', '-af', 'highpass=f=200,lowpass=f=3400', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'];
    let p;
    try { p = spawn(ff.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return reject(e); }
    if (onChild) onChild(p);
    const chunks = []; let size = 0, err = '', done = false;
    const finish = (e, v) => { if (done) return; done = true; clearTimeout(timer); try { p.kill('SIGKILL'); } catch {} if (e) reject(e); else resolve(v); };
    // (Out of time: what was read is used if it is a minute or more.)
    const timer = setTimeout(() => (size >= RATE * 2 * 60 ? finish(null, toPcm(Buffer.concat(chunks))) : finish(new Error('reading the sound took too long'))), timeoutMs);
    p.stdout.on('data', (d) => { chunks.push(d); size += d.length; if (size > RATE * 2 * (secs + 5)) finish(null, toPcm(Buffer.concat(chunks))); });
    p.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
    p.on('error', (e) => finish(e));
    p.on('close', () => { if (size < RATE * 2) finish(new Error((err.trim().split('\n').pop() || 'no sound could be read').slice(0, 200))); else finish(null, toPcm(Buffer.concat(chunks))); });
  });
}
const toPcm = (buf) => new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));

module.exports = { cuesOf, notSpeech, episodeOfName, namesOtherEpisode, fit, retimeVtt, speechiness, cueFrames, lagScores, agree, syncByEar, listen, FRAME, RATE, SPEEDS };
