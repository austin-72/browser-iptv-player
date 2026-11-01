'use strict';
/**
 * Intro / end-credits detection for TV episodes.
 *
 * Dependency-free (only Node core + the ffmpeg / ffprobe CLIs, no chromaprint).
 *
 *   const { IntroDetector } = require('./intro');
 *   const d = new IntroDetector({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', log: console.log });
 *   await d.fingerprint(input, { start, duration, headers })   // -> { hop, start, offset, frames, valid, ... }
 *   await d.duration(input, { headers })                      // -> seconds or 0
 *   await d.chapters(input, { headers })                      // -> { intro, credits }
 *   await d.detectSeason([{ id, input, headers }], opts)      // -> [{ id, intro, credits, source }]
 *
 * How it works
 * ------------
 * Audio is decoded to mono 16-bit PCM at 5 kHz. Overlapping 2048-sample (0.41 s) Hann-windowed
 * frames are taken every 500 samples (hop = 0.1 s). Each frame's spectrum (own radix-2 FFT) is
 * reduced to 33 log-spaced band energies in 300–2000 Hz, and a Haitsma–Kalker style 32-bit
 * sub-fingerprint is derived from the sign of the time-and-frequency energy difference.
 *
 * Two fingerprints are compared at every relative offset: the per-frame bit error count is
 * smoothed with a short centred window, frames under a bit-error-rate threshold are "matching",
 * matching frames separated by short gaps are merged into runs, and the best scoring runs are kept.
 * Every episode is compared with a few neighbouring episodes of the same season, and the intro /
 * credits of an episode is the candidate with the most cross-episode support (median boundaries).
 * Chapter markers (Intro / Opening / OP, Credits / Ending / ED / Outro …) win over audio analysis.
 */

const { spawn } = require('child_process');

// ---------------------------------------------------------------------------------------------
// Fingerprint configuration
// ---------------------------------------------------------------------------------------------
const SAMPLE_RATE = 5000;      // Hz – enough for the 300–2000 Hz analysis band
const FRAME_SIZE = 2048;       // samples (0.4096 s); also the FFT size
const HOP_SIZE = 500;          // samples (0.1 s)
const N_BANDS = 33;            // -> 32 bits
const F_MIN = 300;
const F_MAX = 2000;
const SILENCE_RMS = 0.0015;    // frames quieter than ~-56 dBFS are treated as "no evidence"
const MAX_WINDOW_SEC = 1800;   // hard cap on analysed audio per call

const HOP_SEC = HOP_SIZE / SAMPLE_RATE;
const FRAME_SEC = FRAME_SIZE / SAMPLE_RATE;
// Sub-fingerprint k is derived from frames k and k+1 -> its centre in seconds from window start.
const FP_OFFSET = FRAME_SEC / 2 + HOP_SEC / 2;

// 16-bit popcount table
const POPCNT16 = new Uint8Array(65536);
for (let i = 1; i < 65536; i++) POPCNT16[i] = (i & 1) + POPCNT16[i >>> 1];

// ---------------------------------------------------------------------------------------------
// FFT (iterative radix-2, in place) + real-input wrapper
// ---------------------------------------------------------------------------------------------
function makeFFT(n) {
  if (n & (n - 1)) throw new Error('FFT size must be a power of two');
  const levels = Math.log2(n) | 0;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0, x = i; b < levels; b++, x >>>= 1) r = (r << 1) | (x & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  /** Forward transform in place: X[k] = sum x[t] e^{-2 pi i k t / n} */
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >>> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const a = start + k, b = a + half;
          const wr = cos[t], wi = -sin[t];
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  };
}

/**
 * Returns power(frame, kLo, kHi, out): power spectrum |X[k]|^2 for k in [kLo, kHi) of a real
 * frame of length n, computed with one complex FFT of length n/2.
 */
function makeRealPower(n) {
  const m = n >>> 1;
  const fft = makeFFT(m);
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  const wc = new Float64Array(m + 1);
  const ws = new Float64Array(m + 1);
  for (let k = 0; k <= m; k++) {
    wc[k] = Math.cos((2 * Math.PI * k) / n);
    ws[k] = Math.sin((2 * Math.PI * k) / n);
  }
  return function power(x, kLo, kHi, out) {
    for (let i = 0; i < m; i++) { re[i] = x[2 * i]; im[i] = x[2 * i + 1]; }
    fft(re, im);
    for (let k = kLo; k < kHi; k++) {
      const kk = k % m;
      const km = (m - kk) % m;
      const a = re[kk], b = im[kk], c = re[km], d = im[km];
      const er = (a + c) * 0.5, ei = (b - d) * 0.5;      // even part
      const or = (b + d) * 0.5, oi = (c - a) * 0.5;      // odd part
      const cw = wc[k], sw = ws[k];                      // W^k = cw - i sw
      const xr = er + cw * or + sw * oi;
      const xi = ei + cw * oi - sw * or;
      out[k - kLo] = xr * xr + xi * xi;
    }
  };
}

let _fpTables = null;
function fpTables() {
  if (_fpTables) return _fpTables;
  const win = new Float64Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_SIZE - 1));
  const edges = new Int32Array(N_BANDS + 1);
  for (let b = 0; b <= N_BANDS; b++) {
    const f = F_MIN * Math.pow(F_MAX / F_MIN, b / N_BANDS);
    edges[b] = Math.round((f * FRAME_SIZE) / SAMPLE_RATE);
  }
  _fpTables = { win, edges, power: makeRealPower(FRAME_SIZE) };
  return _fpTables;
}

/**
 * Pure-JS fingerprint of mono s16 PCM sampled at SAMPLE_RATE.
 * @param {Int16Array} pcm
 * @returns {{frames: Uint32Array, valid: Uint8Array}}
 */
function computeFingerprint(pcm) {
  const { win, edges, power } = fpTables();
  const nFrames = pcm.length >= FRAME_SIZE ? Math.floor((pcm.length - FRAME_SIZE) / HOP_SIZE) + 1 : 0;
  const nOut = Math.max(0, nFrames - 1);
  const frames = new Uint32Array(nOut);
  const valid = new Uint8Array(nOut);
  if (!nOut) return { frames, valid };
  const kLo = edges[0], kHi = edges[N_BANDS];
  const spec = new Float64Array(kHi - kLo);
  const buf = new Float64Array(FRAME_SIZE);
  let prev = new Float64Array(N_BANDS), cur = new Float64Array(N_BANDS);
  let prevLoud = false;
  const silenceSum = SILENCE_RMS * SILENCE_RMS * FRAME_SIZE;
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP_SIZE;
    let ss = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const s = pcm[off + i] / 32768;
      ss += s * s;
      buf[i] = s * win[i];
    }
    const loud = ss > silenceSum;
    power(buf, kLo, kHi, spec);
    for (let b = 0; b < N_BANDS; b++) {
      let e = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) e += spec[k - kLo];
      cur[b] = e;
    }
    if (f > 0) {
      let bits = 0;
      for (let b = 0; b < 32; b++) {
        const d = (cur[b] - cur[b + 1]) - (prev[b] - prev[b + 1]);
        if (d > 0) bits |= (1 << b);
      }
      frames[f - 1] = bits >>> 0;
      valid[f - 1] = loud && prevLoud ? 1 : 0;
    }
    const t = prev; prev = cur; cur = t;
    prevLoud = loud;
  }
  return { frames, valid };
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------
/**
 * Find the longest / best common aligned runs between two fingerprints.
 * Times returned are absolute (seconds in the respective inputs).
 *
 * @param fa, fb fingerprints from IntroDetector#fingerprint / computeFingerprint
 * @param opt.minLen, opt.maxLen   accepted run length in seconds
 * @param opt.threshold            smoothed bit-error-rate threshold (default 0.35)
 * @param opt.maxGap               gap (s) of non-matching frames bridged inside a run (default 3)
 * @param opt.topK                 number of distinct candidates returned (default 4)
 * @returns [{ aStart, aEnd, bStart, bEnd, ber, score, len }] sorted by score desc
 */
function compareFingerprints(fa, fb, opt = {}) {
  const hop = fa.hop || HOP_SEC;
  const A = fa.frames, B = fb.frames;
  const va = fa.valid || new Uint8Array(A.length).fill(1);
  const vb = fb.valid || new Uint8Array(B.length).fill(1);
  const nA = A.length, nB = B.length;
  const minF = Math.max(5, Math.round((opt.minLen != null ? opt.minLen : 10) / hop));
  const maxF = opt.maxLen ? Math.round(opt.maxLen / hop) : Infinity;
  const thr = opt.threshold != null ? opt.threshold : 0.35;
  const half = opt.smooth != null ? opt.smooth : 4;
  const maxGap = Math.round((opt.maxGap != null ? opt.maxGap : 3) / hop);
  const rawThr = Math.round(32 * (opt.edgeThreshold != null ? opt.edgeThreshold : 0.32));
  const maxMean = opt.maxMeanBer != null ? opt.maxMeanBer : 0.3;
  const minValid = opt.minValid != null ? opt.minValid : 0.5;
  const topK = opt.topK || 4;
  const aT0 = (fa.start || 0) + (fa.offset != null ? fa.offset : FP_OFFSET);
  const bT0 = (fb.start || 0) + (fb.offset != null ? fb.offset : FP_OFFSET);
  const cands = [];
  if (nA < minF || nB < minF) return cands;

  // prefix count of valid frames, for evidence checks
  const VA = new Int32Array(nA + 1);
  for (let i = 0; i < nA; i++) VA[i + 1] = VA[i] + va[i];

  const L0 = Math.min(nA, nB);
  const e = new Uint8Array(L0);
  const P = new Int32Array(L0 + 1);
  const thrX = thr * 32;
  const pc = POPCNT16;

  const emit = (d, i0, s, en) => {
    while (s < en && e[s] > rawThr) s++;
    while (en > s && e[en - 1] > rawThr) en--;
    const len = en - s;
    if (len < minF || len > maxF) return;
    const errs = P[en] - P[s];
    const mean = errs / (32 * len);
    if (mean > maxMean) return;
    const ia = i0 + s;
    if (VA[ia + len] - VA[ia] < minValid * len) return;
    const score = (16 * len - errs) / 32;
    const c = { ia, ib: ia + d, n: len, ber: mean, score };
    for (let q = 0; q < cands.length; q++) {
      const x = cands[q];
      const ov = Math.min(x.ia + x.n, c.ia + c.n) - Math.max(x.ia, c.ia);
      if (ov > 0.5 * Math.min(x.n, c.n)) {
        if (c.score > x.score) { cands[q] = c; cands.sort((p, r) => r.score - p.score); }
        return;
      }
    }
    cands.push(c);
    cands.sort((p, r) => r.score - p.score);
    if (cands.length > topK * 3) cands.length = topK * 3;
  };

  for (let d = -(nA - minF); d <= nB - minF; d++) {
    const i0 = d < 0 ? -d : 0;
    const i1 = Math.min(nA, nB - d);
    const L = i1 - i0;
    if (L < minF) continue;
    let s = 0;
    P[0] = 0;
    for (let k = 0; k < L; k++) {
      const i = i0 + k, j = i + d;
      let x = 16;
      if (va[i] & vb[j]) { const v = A[i] ^ B[j]; x = pc[v & 0xffff] + pc[v >>> 16]; }
      e[k] = x;
      s += x;
      P[k + 1] = s;
    }
    // Quick reject: no window of minF frames can be good if the best case is too bad.
    if (s > 15.2 * L && L > 4 * minF) {
      // dense check on coarse blocks
      let ok = false;
      const blk = minF >> 1;
      for (let k = 0; k + blk <= L; k += blk) {
        if (P[k + blk] - P[k] < (thrX + 2) * blk) { ok = true; break; }
      }
      if (!ok) continue;
    }
    let runStart = -1, lastGood = -1;
    for (let k = 0; k < L; k++) {
      const lo = k - half < 0 ? 0 : k - half;
      const hi = k + half + 1 > L ? L : k + half + 1;
      if (P[hi] - P[lo] < thrX * (hi - lo)) {
        if (runStart < 0) runStart = k;
        else if (k - lastGood - 1 > maxGap) { emit(d, i0, runStart, lastGood + 1); runStart = k; }
        lastGood = k;
      }
    }
    if (runStart >= 0) emit(d, i0, runStart, lastGood + 1);
  }

  return cands.slice(0, topK).map((c) => ({
    aStart: round3(aT0 + c.ia * hop - hop / 2),
    aEnd: round3(aT0 + (c.ia + c.n - 1) * hop + hop / 2),
    bStart: round3(bT0 + c.ib * hop - hop / 2),
    bEnd: round3(bT0 + (c.ib + c.n - 1) * hop + hop / 2),
    len: round3(c.n * hop),
    ber: round3(c.ber),
    score: round3(c.score),
  }));
}

function round3(x) { return Math.round(x * 1000) / 1000; }

/**
 * Consensus of candidate segments of one episode coming from several pairings.
 * @param lists array (one per pairing) of [{start, end, ber, score}]
 */
function consensus(lists) {
  const pairs = lists.length;
  if (!pairs) return null;
  const all = [];
  lists.forEach((l, p) => l.forEach((c) => all.push({ ...c, p })));
  if (!all.length) return null;
  const iou = (a, b) => {
    const ov = Math.min(a.end, b.end) - Math.max(a.start, b.start);
    if (ov <= 0) return 0;
    return ov / (Math.max(a.end, b.end) - Math.min(a.start, b.start));
  };
  let best = null;
  for (const c of all) {
    const members = [];
    let support = 0;
    for (let p = 0; p < pairs; p++) {
      let bm = null;
      for (const x of lists[p]) {
        if (iou(c, x) >= 0.5 && (!bm || x.score > bm.score)) bm = x;
      }
      if (bm) { members.push(bm); support += bm.score; }
    }
    if (!best || members.length > best.members.length ||
        (members.length === best.members.length && support > best.support)) {
      best = { members, support };
    }
  }
  const m = best.members;
  const start = median(m.map((x) => x.start));
  const end = median(m.map((x) => x.end));
  const ber = m.reduce((s, x) => s + x.ber, 0) / m.length;
  const agree = m.length / pairs;
  const quality = Math.max(0, Math.min(1, (0.4 - ber) / 0.3));
  const confidence = round3(Math.max(0.05, Math.min(1, agree * (0.4 + 0.6 * quality))));
  return { start, end, confidence, support: m.length, pairs, ber: round3(ber) };
}

function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

// ---------------------------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------------------------
const CH_NOT = /\b(recap|previously|preview|next (episode|time|week)|summary|prologue|cold open|teaser|sneak peek|post credits?|after credits?|stinger|mid credits?|scene)\b/;
const CH_INTRO_MARK_END = /\b(intro|opening|op)\b.*\b(end|ends|stop)\b/;
const CH_INTRO = /\b(intro|introduction|opening|op|op\d+|opening (theme|song|credits|titles|sequence)|title sequence|main titles?|theme song|title song)\b/;
const CH_CREDITS = /\b(end credits?|closing credits?|end titles?|credits?|ending|ed|ed\d+|outro|closing|end song)\b/;

function classifyChapter(title) {
  const t = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!t) return null;
  if (CH_NOT.test(t)) return null;
  if (/\bopening (credits|titles)\b/.test(t)) return 'intro';
  if (CH_INTRO_MARK_END.test(t)) return null;          // "Intro End" marks the end of the intro
  if (CH_CREDITS.test(t)) return 'credits';
  if (CH_INTRO.test(t)) return 'intro';
  return null;
}

/**
 * @param chapters [{start, end, title}] (seconds)
 * @param duration seconds or 0
 */
function chaptersToMarkers(chapters, duration) {
  const res = { intro: null, credits: null };
  if (!Array.isArray(chapters) || !chapters.length) return res;
  const ch = chapters
    .map((c) => ({ start: +c.start || 0, end: +c.end || 0, title: c.title || '' }))
    .filter((c) => isFinite(c.start))
    .sort((a, b) => a.start - b.start);
  const total = duration > 0 ? duration : Math.max(...ch.map((c) => c.end || c.start));
  for (let i = 0; i < ch.length; i++) {
    const next = ch[i + 1];
    if (!(ch[i].end > ch[i].start)) ch[i].end = next ? next.start : total;
    ch[i].kind = classifyChapter(ch[i].title);
  }
  const groups = (kind) => {
    const out = [];
    for (const c of ch) {
      if (c.kind !== kind) continue;
      const last = out[out.length - 1];
      if (last && c.start - last.end < 1.0) last.end = Math.max(last.end, c.end);
      else out.push({ start: c.start, end: c.end });
    }
    return out.filter((g) => g.end - g.start >= 1);
  };
  const intro = groups('intro').find((g) => !(total > 0) || (g.start < total * 0.6 && g.end - g.start < total * 0.5));
  const credits = groups('credits').find((g) => !(total > 0) || g.start >= total * 0.4);
  if (intro) res.intro = { start: round3(intro.start), end: round3(intro.end) };
  if (credits) res.credits = { start: round3(credits.start), end: round3(credits.end) };
  if (res.intro && res.credits && res.intro.end > res.credits.start) res.credits = null;
  return res;
}

// ---------------------------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------------------------
function runProcess(cmd, args, { timeoutMs = 120000, maxBytes = Infinity } = {}) {
  return new Promise((resolve) => {
    let child;
    const chunks = [];
    let bytes = 0, stderr = '', done = false, timedOut = false, truncated = false;
    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, error, stdout: Buffer.concat(chunks, bytes), stderr, timedOut, truncated });
    };
    const kill = () => { try { child.kill('SIGKILL'); } catch (_) { /* ignore */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      finish(-1, err);
      return;
    }
    child.stdout.on('data', (c) => {
      if (truncated) return;
      if (bytes + c.length > maxBytes) { c = c.subarray(0, maxBytes - bytes); truncated = true; }
      chunks.push(c);
      bytes += c.length;
      if (truncated) kill();
    });
    child.stderr.on('data', (c) => {
      stderr += c;
      if (stderr.length > 16384) stderr = stderr.slice(-8192);
    });
    child.on('error', (err) => finish(-1, err));
    child.on('close', (code) => finish(code));
  });
}

function isUrl(input) { return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(input)); }

function headerArgs(input, headers, rwTimeoutUs) {
  const args = [];
  if (!isUrl(input)) return args;
  const isHttp = /^https?:/i.test(input);
  if (rwTimeoutUs) args.push('-rw_timeout', String(rwTimeoutUs));
  if (isHttp) {
    args.push('-reconnect', '1', '-reconnect_delay_max', '4');
    if (headers && typeof headers === 'object') {
      const lines = [];
      for (const [k, v] of Object.entries(headers)) {
        if (v == null || v === '') continue;
        const key = String(k).replace(/[\r\n:]/g, '').trim();
        const val = String(v).replace(/[\r\n]/g, ' ').trim();
        if (!key) continue;
        if (key.toLowerCase() === 'user-agent') args.push('-user_agent', val);
        else lines.push(`${key}: ${val}`);
      }
      if (lines.length) args.push('-headers', lines.join('\r\n') + '\r\n');
    }
  }
  return args;
}

/** Simple async concurrency limiter */
function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, res, rej } = queue.shift();
    Promise.resolve().then(fn).then(res, rej).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((res, rej) => { queue.push({ fn, res, rej }); next(); });
}

// ---------------------------------------------------------------------------------------------
// IntroDetector
// ---------------------------------------------------------------------------------------------
class IntroDetector {
  /**
   * @param opts.ffmpeg / opts.ffprobe  binaries (default 'ffmpeg' / 'ffprobe')
   * @param opts.log          logger function (default: no-op)
   * @param opts.timeoutMs    per ffmpeg/ffprobe call (default 120000)
   * @param opts.probeTimeoutMs (default 30000)
   * @param opts.rwTimeoutMs  network read/write timeout for URL inputs (default 20000)
   * @param opts.concurrency  parallel ffmpeg decodes in detectSeason (default 2)
   */
  constructor(opts = {}) {
    this.ffmpegBin = opts.ffmpeg || 'ffmpeg';
    this.ffprobeBin = opts.ffprobe || 'ffprobe';
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this.timeoutMs = opts.timeoutMs || 120000;
    this.probeTimeoutMs = opts.probeTimeoutMs || 30000;
    this.rwTimeoutUs = Math.round((opts.rwTimeoutMs || 20000) * 1000);
    this.concurrency = Math.max(1, opts.concurrency || 2);
  }

  /** ffprobe once: duration, audio presence, chapters. Throws on failure. */
  async probe(input, { headers } = {}) {
    const args = ['-v', 'error', ...headerArgs(input, headers, this.rwTimeoutUs),
      '-show_entries', 'format=duration:stream=codec_type,duration:chapter=start_time,end_time:chapter_tags=title',
      '-of', 'json', String(input)];
    const r = await runProcess(this.ffprobeBin, args, { timeoutMs: this.probeTimeoutMs, maxBytes: 4 << 20 });
    if (r.timedOut) throw new Error('ffprobe timed out');
    if (r.error) throw r.error;
    if (r.code !== 0) throw new Error(`ffprobe failed (${r.code}): ${r.stderr.trim().split('\n').pop() || ''}`);
    let j;
    try { j = JSON.parse(r.stdout.toString('utf8')); } catch (e) { throw new Error('ffprobe: bad JSON'); }
    const streams = Array.isArray(j.streams) ? j.streams : [];
    let duration = parseFloat(j.format && j.format.duration);
    if (!(duration > 0)) {
      duration = Math.max(0, ...streams.map((s) => parseFloat(s.duration) || 0));
    }
    const chapters = (Array.isArray(j.chapters) ? j.chapters : []).map((c) => ({
      start: parseFloat(c.start_time) || 0,
      end: parseFloat(c.end_time) || 0,
      title: (c.tags && (c.tags.title || c.tags.TITLE)) || '',
    }));
    return {
      duration: duration > 0 && isFinite(duration) ? duration : 0,
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
      hasVideo: streams.some((s) => s.codec_type === 'video'),
      chapters,
    };
  }

  /** Duration in seconds (0 if unknown / on error). */
  async duration(input, { headers } = {}) {
    try { return (await this.probe(input, { headers })).duration; } catch (e) {
      this.log(`[intro] duration failed for ${short(input)}: ${e.message}`);
      return 0;
    }
  }

  /** Intro / credits from chapter titles. Never throws. */
  async chapters(input, { headers } = {}) {
    try {
      const p = await this.probe(input, { headers });
      return chaptersToMarkers(p.chapters, p.duration);
    } catch (e) {
      this.log(`[intro] chapters failed for ${short(input)}: ${e.message}`);
      return { intro: null, credits: null };
    }
  }

  /** Decode mono PCM (Int16Array @ 5 kHz) of a window. Returns empty array for audio-less input. */
  async decode(input, { start = 0, duration = 600, headers } = {}) {
    start = Math.max(0, +start || 0);
    duration = Math.max(1, Math.min(MAX_WINDOW_SEC, +duration || 600));
    const args = ['-hide_banner', '-nostdin', '-v', 'error'];
    if (start > 0) args.push('-ss', start.toFixed(3));
    args.push(...headerArgs(input, headers, this.rwTimeoutUs), '-i', String(input),
      '-t', duration.toFixed(3), '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-acodec', 'pcm_s16le', '-f', 's16le', 'pipe:1');
    const maxBytes = Math.ceil(duration * SAMPLE_RATE) * 2 + 4096;
    const r = await runProcess(this.ffmpegBin, args, { timeoutMs: this.timeoutMs, maxBytes });
    if (r.error) throw r.error;
    const enough = r.stdout.length >= Math.min(maxBytes - 4096, 60 * SAMPLE_RATE * 2) * 0.99;
    if (r.timedOut && !enough) throw new Error(`ffmpeg timed out after ${this.timeoutMs} ms`);
    if (r.timedOut) this.log(`[intro] ffmpeg timed out for ${short(input)}; using ${(r.stdout.length / 2 / SAMPLE_RATE).toFixed(1)} s`);
    if (r.code !== 0 && !r.truncated && !r.timedOut) {
      if (/does not contain any stream|matches no streams|no audio/i.test(r.stderr) && !r.stdout.length) {
        return new Int16Array(0);
      }
      if (r.stdout.length < SAMPLE_RATE * 2 * 5) {
        throw new Error(`ffmpeg failed (${r.code}): ${r.stderr.trim().split('\n').pop() || ''}`);
      }
    }
    let buf = r.stdout;
    if (buf.length & 1) buf = buf.subarray(0, buf.length - 1);
    if (buf.byteOffset & 1) buf = Buffer.from(buf);
    return new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
  }

  /**
   * Audio fingerprint of [start, start+duration).
   * @returns {{hop:number, start:number, offset:number, frames:Uint32Array, valid:Uint8Array, seconds:number}}
   *   Sub-fingerprint k is centred at  start + offset + k*hop  seconds.
   */
  async fingerprint(input, { start = 0, duration = 600, headers } = {}) {
    const pcm = await this.decode(input, { start, duration, headers });
    const { frames, valid } = computeFingerprint(pcm);
    return {
      hop: HOP_SEC, start: Math.max(0, +start || 0), offset: FP_OFFSET,
      frames, valid, seconds: pcm.length / SAMPLE_RATE,
    };
  }

  /**
   * Detect intros and credits for episodes of one season.
   * @param items [{ id, input, headers }]
   * @param opts.introWindow  seconds from the start searched for the intro (default 600)
   * @param opts.creditsWindow seconds before the end searched for credits (default 480)
   * @param opts.minIntro / maxIntro / minCredits / maxCredits  seconds
   * @param opts.partners     how many other episodes each episode is compared with (default 3)
   * @param opts.threshold    bit error rate threshold (default 0.35)
   * @returns [{ id, intro:{start,end,confidence}|null, credits:{...}|null, source, error? }]
   */
  async detectSeason(items, opts = {}) {
    const o = {
      introWindow: 600, creditsWindow: 480, minIntro: 10, maxIntro: 150, minCredits: 10,
      maxCredits: 0, partners: 3, threshold: 0.35, ...opts,
    };
    const t0 = Date.now();
    const limit = limiter(this.concurrency);
    const eps = (items || []).map((it, idx) => ({
      idx, id: it && it.id != null ? it.id : idx, input: it && it.input, headers: it && it.headers,
      probe: null, chap: { intro: null, credits: null }, error: null,
      intro: null, credits: null, introSrc: null, creditsSrc: null,
    }));

    // 1) probe (duration, audio, chapters)
    await Promise.all(eps.map((ep) => limit(async () => {
      if (!ep.input) { ep.error = 'no input'; return; }
      try {
        ep.probe = await this.probe(ep.input, { headers: ep.headers });
        ep.chap = chaptersToMarkers(ep.probe.chapters, ep.probe.duration);
      } catch (e) {
        ep.error = e.message;
        this.log(`[intro] probe failed for ${ep.id}: ${e.message}`);
      }
    })));
    for (const ep of eps) {
      if (ep.chap.intro) { ep.intro = { ...ep.chap.intro, confidence: 1 }; ep.introSrc = 'chapters'; }
      if (ep.chap.credits) { ep.credits = { ...ep.chap.credits, confidence: 1 }; ep.creditsSrc = 'chapters'; }
    }

    const usable = eps.filter((ep) => ep.probe && ep.probe.hasAudio);
    const dur = (ep) => (ep.probe && ep.probe.duration) || 0;

    // 2) audio analysis for one segment kind
    const analyse = async (kind) => {
      const isIntro = kind === 'intro';
      const pool = isIntro ? usable : usable.filter((ep) => dur(ep) > 0);
      const need = pool.filter((ep) => !ep[kind]);
      if (!need.length || pool.length < 2) return;
      const win = (ep) => {
        const D = dur(ep);
        if (isIntro) {
          const w = D > 0 ? Math.min(o.introWindow, Math.max(D * 0.5, Math.min(D, 60))) : o.introWindow;
          return { start: 0, duration: Math.min(w, MAX_WINDOW_SEC) };
        }
        const w = Math.min(o.creditsWindow, Math.max(D * 0.4, Math.min(D, 60)), MAX_WINDOW_SEC);
        return { start: Math.max(0, D - w), duration: w };
      };
      // choose partners: nearest episodes in list order
      const pairs = new Map();
      const partnersOf = new Map();
      const pos = new Map(pool.map((ep, i) => [ep, i]));
      for (const ep of need) {
        const i = pos.get(ep);
        const list = [];
        for (let k = 1; list.length < o.partners && k < pool.length; k++) {
          if (i + k < pool.length) list.push(pool[i + k]);
          if (list.length < o.partners && i - k >= 0) list.push(pool[i - k]);
        }
        partnersOf.set(ep, list);
        for (const p of list) {
          const key = ep.idx < p.idx ? `${ep.idx}:${p.idx}` : `${p.idx}:${ep.idx}`;
          if (!pairs.has(key)) pairs.set(key, ep.idx < p.idx ? [ep, p] : [p, ep]);
        }
      }
      // fingerprints (lazily, once per episode)
      const fps = new Map();
      const involved = new Set();
      for (const [a, b] of pairs.values()) { involved.add(a); involved.add(b); }
      await Promise.all([...involved].map((ep) => limit(async () => {
        const w = win(ep);
        const t = Date.now();
        try {
          const fp = await this.fingerprint(ep.input, { ...w, headers: ep.headers });
          fps.set(ep, fp);
          this.log(`[intro] ${kind} fingerprint ${ep.id}: ${w.start.toFixed(1)}+${fp.seconds.toFixed(1)} s in ${Date.now() - t} ms`);
        } catch (e) {
          this.log(`[intro] ${kind} fingerprint failed for ${ep.id}: ${e.message}`);
        }
      })));
      // compare pairs
      const minLen = isIntro ? o.minIntro : o.minCredits;
      const maxLen = isIntro ? o.maxIntro : (o.maxCredits || 0);
      const results = new Map(); // ep -> [lists]
      for (const ep of need) results.set(ep, []);
      for (const [a, b] of pairs.values()) {
        const fa = fps.get(a), fb = fps.get(b);
        if (!fa || !fb || !fa.frames.length || !fb.frames.length) continue;
        // each comparison is synchronous CPU work (~0.1–0.3 s for 10-minute windows): let the
        // event loop breathe between pairs so a server stays responsive
        await new Promise((r) => setImmediate(r));
        const t = Date.now();
        let cands = [];
        try {
          cands = compareFingerprints(fa, fb, { minLen, maxLen, threshold: o.threshold });
        } catch (e) {
          this.log(`[intro] compare failed ${a.id}/${b.id}: ${e.message}`);
          continue;
        }
        this.log(`[intro] ${kind} ${a.id}~${b.id}: ${cands.length ? cands.slice(0, 2).map((c) => `${c.aStart.toFixed(1)}-${c.aEnd.toFixed(1)}|${c.bStart.toFixed(1)}-${c.bEnd.toFixed(1)} ber=${c.ber}`).join(', ') : 'no match'} (${Date.now() - t} ms)`);
        if (results.has(a)) results.get(a).push(cands.map((c) => ({ start: c.aStart, end: c.aEnd, ber: c.ber, score: c.score })));
        if (results.has(b)) results.get(b).push(cands.map((c) => ({ start: c.bStart, end: c.bEnd, ber: c.ber, score: c.score })));
      }
      for (const ep of need) {
        const lists = results.get(ep);
        const c = consensus(lists);
        if (!c) continue;
        const D = dur(ep);
        let { start, end } = c;
        if (isIntro && start < 1.0) start = 0;
        if (!isIntro && D > 0 && D - end < 2.5) end = D;
        if (D > 0) end = Math.min(end, D);
        ep[kind] = { start: round3(start), end: round3(end), confidence: c.confidence };
        ep[kind + 'Src'] = 'audio';
      }
    };

    try { await analyse('intro'); } catch (e) { this.log(`[intro] intro analysis failed: ${e.message}`); }
    try { await analyse('credits'); } catch (e) { this.log(`[intro] credits analysis failed: ${e.message}`); }

    const out = eps.map((ep) => {
      let { intro, credits } = ep;
      if (intro && credits && intro.end > credits.start) {
        if ((intro.confidence || 0) >= (credits.confidence || 0)) credits = null; else intro = null;
      }
      const srcs = new Set();
      if (intro) srcs.add(ep.introSrc);
      if (credits) srcs.add(ep.creditsSrc);
      const source = srcs.size === 0 ? 'none' : [...srcs].sort().join('+');
      const r = { id: ep.id, intro, credits, source };
      if (ep.error) r.error = ep.error;
      return r;
    });
    this.log(`[intro] detectSeason: ${eps.length} episodes in ${Date.now() - t0} ms`);
    return out;
  }
}

function short(s) {
  s = String(s);
  return s.length > 80 ? s.slice(0, 40) + '…' + s.slice(-30) : s;
}

module.exports = {
  IntroDetector,
  computeFingerprint,
  compareFingerprints,
  chaptersToMarkers,
  classifyChapter,
  consensus,
  makeFFT,
  makeRealPower,
  constants: { SAMPLE_RATE, FRAME_SIZE, HOP_SIZE, HOP_SEC, FRAME_SEC, FP_OFFSET, N_BANDS, F_MIN, F_MAX },
};
