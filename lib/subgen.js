'use strict';
/**
 * Subtitles made from a film's own sound, for when none can be found online. Optional: it needs a speech-to-text
 * program on the server, found the way ffmpeg is —
 *
 *   WHISPER_BIN     the program (default: whisper-cli, then whisper, on the PATH; then <data>/whisper/whisper-cli)
 *   WHISPER_MODEL   whisper.cpp: the model file (ggml-base.bin …) — it has none built in. Default: the newest
 *                   ggml-*.bin in <data>/whisper.
 *                   OpenAI's whisper / whisper-ctranslate2: a model name (default "base").
 *
 * <data>/whisper is there so a Docker install needs no image of its own and no settings: one program file built for
 * the image (tools/whisper) and one model file, dropped into the data folder. It is left out of backups, and a
 * restored backup can't put anything there (it is a program this server runs).
 *
 * Two families are understood, told apart by their --help: whisper.cpp ("-ovtt") and the Python command line
 * ("--output_format"). Nothing is bundled and there is no npm package: without the program this whole part is off.
 *
 * A job never touches how anything plays. It is a background task of its own: ffmpeg reads the film once and keeps
 * only its sound (16 kHz mono WAV, about 115 MB an hour, deleted afterwards), the program writes a WebVTT file, and
 * that file is kept in <data>/gen-subs to be offered like subtitles found online. While the sound is read from a
 * provider it uses one of that provider's connections (shown among the people watching), and it waits for a free one.
 * One job at a time; the rest queue.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { HttpError, log } = require('./util');

const QUEUE_MAX = 5;
const idOf = (k) => crypto.createHash('sha1').update('gen-subs:' + String(k)).digest('hex').slice(0, 20);
const onPath = (name) => {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) { const f = path.join(d, name + ext); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch {} }
  }
  return '';
};

class SubGen {
  /**
   * deps: {
   *   ffmpeg: () => ({ bin, available, netArgs(input, headers) }),
   *   connFree?: (job) => bool      is a provider connection free for this title? (files on the server: always)
   *   notify?: (job, what) => void  'done' | 'failed'
   * }
   */
  constructor(dataDir, deps, { bin = process.env.WHISPER_BIN || '', model = process.env.WHISPER_MODEL || '', waitMs = 15e3, maxWaitMs = 3600e3 } = {}) {
    this.dir = path.join(dataDir, 'gen-subs');
    this.own = path.join(dataDir, 'whisper');
    this.deps = deps;
    this.bin = bin; this.model = model; this.askedModel = model;
    this.waitMs = waitMs; this.maxWaitMs = maxWaitMs;
    this.kind = ''; this.why = 'Not looked for yet.';
    this.jobs = new Map(); // id → job (queued, running, or the last failure)
    this.queue = [];
    this.current = null;
  }

  /** The program in <data>/whisper, if one is there and can be run. */
  _ownBin() {
    for (const n of process.platform === 'win32' ? ['whisper-cli.exe', 'whisper-cli'] : ['whisper-cli']) { const f = path.join(this.own, n); try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch {} }
    return '';
  }
  /** The newest whisper.cpp model file in <data>/whisper (not the little voice-detection ones, nor a download still under way). */
  _ownModel() {
    let best = null;
    try {
      for (const n of fs.readdirSync(this.own)) {
        if (!/^ggml-.+\.bin$/i.test(n) || /silero|vad|for-tests/i.test(n)) continue;
        const st = fs.statSync(path.join(this.own, n));
        if (st.isFile() && st.size > 1024 * 1024 && (!best || st.mtimeMs > best.at)) best = { f: path.join(this.own, n), at: st.mtimeMs };
      }
    } catch {}
    return best ? best.f : '';
  }
  /** Looks for the program (once at start; again from Admin). */
  detect() {
    this.kind = ''; this.where = '';
    this.model = this.askedModel;
    const onP = this.bin ? '' : onPath('whisper-cli') || onPath('whisper-cpp') || onPath('whisper') || onPath('whisper-ctranslate2');
    const mine = this.bin || onP ? '' : this._ownBin();
    const bin = this.bin || onP || mine;
    if (!bin) {
      let there = false; try { there = fs.existsSync(path.join(this.own, 'whisper-cli')); } catch {}
      this.why = there ? `The program in ${this.own} can’t be run by this server (it isn’t marked as a program, or was built for another kind of system).`
        : `No speech-to-text program was found. Put whisper.cpp’s whisper-cli and a model file in ${this.own} (tools/whisper builds one for Docker), install one on the server, or set WHISPER_BIN.`;
      return this;
    }
    let help = '';
    try { const r = spawnSync(bin, ['--help'], { timeout: 20000, encoding: 'utf8' }); if (r.error) throw r.error; help = String(r.stdout || '') + String(r.stderr || ''); } catch (e) {
      // (A program built for another kind of Linux than this one "isn't there" when started: the loader it asks for is missing.)
      this.why = e.code === 'ENOENT' && fs.existsSync(bin) ? `“${bin}” was built for another kind of system than this server runs on (the Docker image is Alpine Linux: tools/whisper builds one for it).` : `“${bin}” couldn’t be run (${e.code || e.message}).`;
      return this;
    }
    const kind = /-ovtt\b|--output-vtt/.test(help) ? 'cpp' : /--output_format/.test(help) ? 'py' : '';
    if (!kind) { this.why = `“${bin}” isn’t a whisper this app knows how to ask for subtitles (its --help mentions neither -ovtt nor --output_format)${/not found|No such file/i.test(help) ? ' — it looks built for another kind of system' : ''}.`; return this; }
    if (kind === 'cpp') {
      if (!this.model) this.model = this._ownModel();
      if (!this.model) { this.why = `whisper.cpp needs a model file: put one (for example ggml-small.bin) in ${this.own}, or set WHISPER_MODEL to one.`; return this; }
      try { fs.accessSync(this.model, fs.constants.R_OK); } catch { this.why = `The model file ${this.model}${this.askedModel ? ' (WHISPER_MODEL)' : ''} isn’t there or can’t be read.`; return this; }
    }
    this.foundBin = bin; this.kind = kind; this.why = ''; this.where = bin === mine ? 'data' : this.bin ? 'env' : 'path';
    return this;
  }
  get available() { return !!this.kind; }
  info() { return { available: this.available, kind: this.kind, bin: this.foundBin || this.bin || '', model: this.kind ? this.model || (this.kind === 'py' ? 'base' : '') : '', why: this.why, where: this.where || '', folder: this.own }; }

  _meta(id) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, id + '.json'), 'utf8')); } catch { return null; } }
  /** The finished file for a title ({ id, path, lang, at }), or null. */
  made(k) {
    const id = idOf(k), f = path.join(this.dir, id + '.vtt');
    try { if (fs.statSync(f).size < 8) return null; } catch { return null; }
    const m = this._meta(id) || {};
    return { id, path: f, lang: m.lang || '', at: m.at || 0, k: m.k || '' };
  }
  fileById(id) { if (!/^[0-9a-f]{20}$/.test(String(id))) return ''; const f = path.join(this.dir, id + '.vtt'); return fs.existsSync(f) ? f : ''; }

  /** What a device is told about a title: { state: 'none' | 'queued' | 'waiting' | 'audio' | 'writing' | 'done' | 'failed', … }. */
  status(k) {
    const j = this.jobs.get(idOf(k));
    if (j && j.state !== 'done') return { state: j.state, id: j.id, pct: j.pct || 0, secs: j.secs || 0, ahead: j.state === 'queued' ? this.queue.indexOf(j) + (this.current ? 1 : 0) : 0, err: j.err || '', pid: j.pid };
    const m = this.made(k);
    return m ? { state: 'done', id: m.id, lang: m.lang, at: m.at } : { state: 'none' };
  }

  /** job: { k, name, input, headers, local, pid, list } → its status. */
  start(job) {
    if (!this.available) throw new HttpError(400, 'This server can’t make subtitles: ' + this.why);
    const ff = this.deps.ffmpeg();
    if (!ff || !ff.available) throw new HttpError(400, 'Making subtitles needs ffmpeg on the server.');
    const id = idOf(job.k);
    const have = this.jobs.get(id);
    if (have && ['queued', 'waiting', 'audio', 'writing'].includes(have.state)) return this.status(job.k);
    if (this.queue.length >= QUEUE_MAX) throw new HttpError(429, 'Several titles are already waiting for subtitles. Try again when they’re done.');
    const j = { ...job, id, state: 'queued', pct: 0, secs: 0, err: '', at: Date.now() };
    this.jobs.set(id, j);
    this.queue.push(j);
    this._next();
    return this.status(job.k);
  }

  /** Stops a job that's waiting or running; or deletes the finished file. */
  remove(k) {
    const id = idOf(k), j = this.jobs.get(id);
    if (j) {
      j.cancelled = true;
      this.queue = this.queue.filter((x) => x !== j);
      if (j.proc) { try { j.proc.kill('SIGKILL'); } catch {} }
      this.jobs.delete(id);
    }
    for (const ext of ['.vtt', '.json', '.wav']) { try { fs.unlinkSync(path.join(this.dir, id + ext)); } catch {} }
  }

  /** Jobs reading from a provider right now (they hold one of its connections). */
  reading() { return this.current && this.current.state === 'audio' && !this.current.local ? [this.current] : []; }
  stop() { this.stopped = true; if (this.current && this.current.proc) { try { this.current.proc.kill('SIGKILL'); } catch {} } }

  _next() {
    if (this.current || this.stopped) return;
    const j = this.queue.shift();
    if (!j) return;
    this.current = j;
    this._run(j).then(() => {
      j.state = 'done';
      this.jobs.delete(j.id);
      log(`Subtitles made for “${j.name}”${j.lang ? ` (${j.lang})` : ''}`);
      try { if (this.deps.notify) this.deps.notify(j, 'done'); } catch {}
    }, (e) => {
      for (const ext of ['.wav', '.tmp.vtt']) { try { fs.unlinkSync(path.join(this.dir, j.id + ext)); } catch {} }
      if (j.cancelled) return;
      j.state = 'failed'; j.err = String((e && e.message) || e).slice(0, 300);
      log(`Subtitles for “${j.name}” failed: ${j.err}`);
      try { if (this.deps.notify) this.deps.notify(j, 'failed'); } catch {}
    }).finally(() => { this.current = null; this._next(); });
  }

  _spawn(j, bin, args, onLine) {
    return new Promise((ok, no) => {
      let tail = '';
      const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      j.proc = p;
      try { os.setPriority(p.pid, 10); } catch {} // (below whoever is watching)
      const feed = (d) => { const s = d.toString('utf8'); tail = (tail + s).slice(-2000); for (const line of s.split(/[\r\n]+/)) if (line) { try { onLine(line); } catch {} } };
      p.stdout.on('data', feed); p.stderr.on('data', feed);
      p.on('error', (e) => { j.proc = null; no(new Error(`${path.basename(bin)} couldn’t be started (${e.code || e.message})`)); });
      p.on('exit', (code) => { j.proc = null; if (j.cancelled) return no(new Error('cancelled')); if (code === 0) return ok(tail); const e = new Error(`${path.basename(bin)} stopped with an error${tail.trim() ? ': ' + tail.trim().split(/[\r\n]+/).slice(-2).join(' ').slice(0, 200) : ''}`); e.tail = tail; no(e); });
    });
  }

  async _run(j) {
    fs.mkdirSync(this.dir, { recursive: true });
    const ff = this.deps.ffmpeg();
    const wav = path.join(this.dir, j.id + '.wav');
    const base = path.join(this.dir, j.id + '.tmp');
    // A provider connection, when it's a provider's film: wait for one rather than take it from someone watching.
    if (!j.local && this.deps.connFree) {
      const t0 = Date.now();
      while (!this.deps.connFree(j)) {
        j.state = 'waiting';
        if (j.cancelled) throw new Error('cancelled');
        if (Date.now() - t0 > this.maxWaitMs) throw new Error('Every connection to its provider stayed in use. Try again when fewer people are watching.');
        await new Promise((r) => setTimeout(r, this.waitMs));
      }
    }
    // 1. The sound alone, as whisper wants it.
    j.state = 'audio';
    await this._spawn(j, ff.bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1', '-nostats', ...(j.local ? [] : ff.netArgs(j.input, j.headers || {})), '-i', j.input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', '-y', wav], (line) => {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m) j.secs = Math.round(Number(m[1]) / 1e6);
    }).catch((e) => { throw new Error(/cancelled/.test(e.message) ? 'cancelled' : /matches no streams|does not contain any stream/i.test(e.tail || '') ? 'It has no sound to make subtitles from.' : 'Its sound couldn’t be read (' + e.message + ')'); });
    if (!(fs.existsSync(wav) && fs.statSync(wav).size > 4096)) throw new Error('It has no sound to make subtitles from.');
    // 2. Words from the sound.
    j.state = 'writing'; j.pct = 0;
    const threads = String(Math.max(1, Math.min(8, (os.cpus() || []).length - 1)));
    let lang = '';
    const seen = (line) => {
      const p = /progress\s*=\s*(\d+)%/.exec(line); if (p) j.pct = Math.min(99, Number(p[1]));
      const l = /auto-detected language:\s*([a-z]{2,3})\b/i.exec(line) || /Detected language:\s*([A-Za-z]+)/.exec(line); if (l) lang = l[1].toLowerCase();
    };
    let out;
    if (this.kind === 'cpp') {
      await this._spawn(j, this.foundBin, ['-m', this.model, '-f', wav, '-l', 'auto', '-t', threads, '-ovtt', '-of', base, '-pp'], seen);
      out = base + '.vtt';
    } else {
      const tmp = path.join(this.dir, j.id + '.out');
      fs.mkdirSync(tmp, { recursive: true });
      try {
        await this._spawn(j, this.foundBin, [wav, '--model', this.model || 'base', '--output_format', 'vtt', '--output_dir', tmp, '--verbose', 'False'], seen);
        const f = fs.readdirSync(tmp).find((n) => /\.vtt$/i.test(n));
        if (f) fs.renameSync(path.join(tmp, f), base + '.vtt');
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
      out = base + '.vtt';
    }
    try { fs.unlinkSync(wav); } catch {}
    let text = '';
    try { text = fs.readFileSync(out, 'utf8'); } catch {}
    if (!/^﻿?WEBVTT/.test(text) || !/-->/.test(text)) { try { fs.unlinkSync(out); } catch {} throw new Error(/^﻿?WEBVTT/.test(text) ? 'Nothing was said in it that could be written down.' : 'The program wrote no subtitles.'); }
    if (lang.length > 3) { try { lang = (require('./subsources').langCode(lang) || ''); } catch { lang = ''; } }
    j.lang = lang;
    fs.renameSync(out, path.join(this.dir, j.id + '.vtt'));
    fs.writeFileSync(path.join(this.dir, j.id + '.json'), JSON.stringify({ k: j.k, n: j.name, lang, at: Date.now(), by: j.pid || '', with: this.kind, model: path.basename(this.model || 'base') }));
  }
}

module.exports = { SubGen, idOf };
