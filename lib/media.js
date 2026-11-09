'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { uid, isUrl, log, HttpError } = require('./util');
const { picKind } = require('./picsubs');

const IDLE_MS = 45000;

// Quality ladder for converted streams (height, video kbit/s).
const LADDER = { 2160: 16000, 1440: 9000, 1080: 6000, 720: 3000, 480: 1400, 360: 800, 240: 450 };

/**
 * Wraps ffmpeg/ffprobe: probing, thumbnails, subtitles, MP4 downloads and on-the-fly HLS sessions that
 * remux or transcode anything a browser can't play (MKV, AVI, WMV, HEVC, AV1, MPEG-2, AC-3/DTS audio, RTMP/RTSP/UDP…).
 */
/** ffmpeg's last words, said plainly (the full text stays in the server log). */
/** The HTTP status the provider answered ffmpeg with (0: none in its words). */
function ffmpegHttpStatus(stderr) {
  const t = String(stderr || '');
  const http = t.match(/Server returned (\d{3})[^\n]*|HTTP error (\d{3})/i);
  if (http) return +(http[1] || http[2]);
  // (Other codes are only named by their kind: "Server returned 4XX Client Error, but not one of 40{0,1,3,4}".)
  const kind = t.match(/Server returned ([45])XX/i);
  return kind ? +kind[1] * 100 : /404 Not Found/i.test(t) ? 404 : /403 Forbidden/i.test(t) ? 403 : 0;
}

const CONNECT_ERR = /Connection refused|Connection timed out|timed out|Network is unreachable|Name or service not known|Failed to resolve/i;

/** Did the provider refuse or not answer (an HTTP status, or no connection at all)? Starting again won't help then. */
function providerFailed(stderr) { return !!ffmpegHttpStatus(stderr) || CONNECT_ERR.test(String(stderr || '')); }

/** ffmpeg failed because of the hardware encoder itself (its own words only; addresses left out). */
function hwEncoderFailed(stderr) {
  const t = String(stderr || '').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '');
  if (!t || providerFailed(t)) return false;
  return /vaapi|qsv|nvenc|cuda|videotoolbox|hwupload|hwaccel|hw_frames|hwdevice|AVHWDeviceContext|Device creation failed|\/dev\/dri|renderD|libva|Impossible to convert|Function not implemented/i.test(t);
}

/** The status a failed start answers with: 404 and 403 as the provider said (401 → 403: a 401 means "signed out" to the page), else 502. */
function sessionStatus(stderr) {
  const st = ffmpegHttpStatus(stderr);
  return st === 404 ? 404 : st === 401 || st === 403 ? 403 : 502;
}

function friendlyFfmpegError(stderr, code) {
  const t = String(stderr || '');
  const st = ffmpegHttpStatus(t);
  if (st === 404) return 'The provider says this stream doesn’t exist (404). It may have been removed — try again later or pick another source.';
  if (st === 401 || st === 403) return `The provider refused this stream (${st}). The account may be in use on another device, or expired.`;
  if (st === 429) return 'The provider is limiting connections right now (429). Wait a moment and try again.';
  if (st >= 500) return `The provider’s server had a problem (${st}). Try again in a moment.`;
  if (CONNECT_ERR.test(t)) return 'Couldn’t reach the provider’s server. Try again in a moment.';
  if (/Invalid data found when processing input/i.test(t)) return 'The provider sent something that isn’t a playable video.';
  const last = t.trim().split('\n').slice(-2).join(' ').replace(/\[[^\]]*@ 0x[0-9a-f]+\]\s*/gi, '').replace(/https?:\/\/\S+/g, '(stream address)').slice(0, 240);
  return `Couldn’t play this stream: ${last || `the converter stopped (code ${code})`}`;
}

class Media {
  constructor(cfg, dataDir, getSettings) {
    this.cfg = cfg;
    this.ffmpegBin = cfg.ffmpeg;
    this.ffprobeBin = cfg.ffprobe;
    this.getSettings = getSettings;
    this.available = false;
    this.probeAvailable = false;
    this.version = '';
    this.major = 0;
    this.encoders = new Set();
    this.sessions = new Map();
    this.tmpDir = path.join(dataDir, 'tmp');
    this.cacheDir = path.join(dataDir, 'cache');
    this.probeCache = new Map();
    this.hwFailed = false;
    fs.rmSync(this.tmpDir, { recursive: true, force: true });
    fs.mkdirSync(this.tmpDir, { recursive: true });
    fs.mkdirSync(path.join(this.cacheDir, 'thumbs'), { recursive: true });
    fs.mkdirSync(path.join(this.cacheDir, 'subs'), { recursive: true });
    this._reaper = setInterval(() => this._reap(), 10000);
    this._reaper.unref();
  }

  detect() {
    const run = (bin, args) => new Promise((resolve) => {
      execFile(bin, args, { timeout: 10000, maxBuffer: 4 << 20 }, (err, out) => resolve(err ? null : String(out)));
    });
    return Promise.all([run(this.ffmpegBin, ['-version']), run(this.ffprobeBin, ['-version']), run(this.ffmpegBin, ['-hide_banner', '-encoders'])]).then(([f, p, enc]) => {
      this.available = !!f;
      this.probeAvailable = !!p;
      if (f) {
        const m = f.match(/ffmpeg version (\S+)/);
        this.version = m ? m[1] : 'unknown';
        const n = this.version.match(/(\d+)\./);
        this.major = n ? parseInt(n[1], 10) : 0;
        if (!this.major && /^n?\d{4}|git|N-/.test(this.version)) this.major = 99;
      }
      for (const line of String(enc || '').split('\n')) { const m = line.match(/^\s*V\S*\s+(\S+)/); if (m) this.encoders.add(m[1]); }
      return { ffmpeg: this.available, ffprobe: this.probeAvailable, version: this.version };
    });
  }

  requireFfmpeg() {
    if (!this.available) throw new HttpError(501, 'This needs ffmpeg, which the server couldn’t find. Install ffmpeg (the Docker image includes it) and restart.');
  }

  get hw() {
    const want = (this.getSettings().hwaccel || this.cfg.hwaccel || '').toLowerCase();
    if (!want || this.hwFailed) return '';
    const enc = { vaapi: 'h264_vaapi', nvenc: 'h264_nvenc', qsv: 'h264_qsv', videotoolbox: 'h264_videotoolbox' }[want];
    return enc && this.encoders.has(enc) ? want : '';
  }

  _netArgs(input, { headers } = {}) {
    const a = [];
    if (isUrl(input)) {
      const h = { ...(headers || {}) };
      a.push('-user_agent', h['User-Agent'] || this.getSettings().userAgent);
      delete h['User-Agent'];
      const lines = Object.entries(h).filter(([k, v]) => /^[A-Za-z0-9-]+$/.test(k) && !/[\r\n]/.test(String(v))).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      if (lines) a.push('-headers', lines);
    } else if (/^rtsps?:/i.test(input)) a.push('-rtsp_transport', 'tcp');
    return a;
  }

  _inputArgs(input, { headers, live, seek, readrate, hw }) {
    const a = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...this._netArgs(input, { headers })];
    if (isUrl(input)) a.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10', '-rw_timeout', '20000000');
    if (/^(udp|rtp|srt):/i.test(input)) a.push('-analyzeduration', '3000000', '-probesize', '3000000');
    if (live) a.push('-fflags', '+genpts+discardcorrupt');
    if (hw === 'vaapi') a.push('-vaapi_device', this.cfg.vaapiDevice);
    if (seek > 0) a.push('-ss', String(seek));
    if (readrate && !live && this.major >= 5) a.push('-readrate', String(readrate));
    a.push('-i', input);
    return a;
  }

  /** Stream details: codecs, size, duration, and every audio/subtitle track. Cached for 10 minutes. */
  /** Would probe() answer from its cache (no new connection)? */
  probeCached(input, headers = {}) {
    const hit = this.probeCache.get(input + '|' + JSON.stringify(headers || {}));
    return !!(hit && Date.now() - hit.t < 600e3);
  }

  probe(input, opts = {}) {
    if (!this.probeAvailable) return Promise.resolve(null);
    const ck = input + '|' + JSON.stringify(opts.headers || {});
    const hit = this.probeCache.get(ck);
    if (hit && Date.now() - hit.t < 600e3) return Promise.resolve(hit.p);
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters'];
    args.push(...this._netArgs(input, opts));
    if (isUrl(input)) args.push('-rw_timeout', '10000000');
    if (/^(udp|rtp|srt):/i.test(input)) args.push('-analyzeduration', '3000000', '-probesize', '3000000');
    args.push(input);
    return new Promise((resolve) => {
      execFile(this.ffprobeBin, args, { timeout: opts.timeout || 20000, maxBuffer: 16 << 20 }, (err, out) => {
        if (err) return resolve(null);
        try {
          const j = JSON.parse(out);
          const st = j.streams || [];
          const v = st.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
          const audio = st.filter((s) => s.codec_type === 'audio');
          const subs = st.filter((s) => s.codec_type === 'subtitle');
          const tag = (s, k) => (s.tags && (s.tags[k] || s.tags[k.toUpperCase()])) || '';
          const p = {
            duration: parseFloat(j.format && j.format.duration) || 0,
            format: (j.format && j.format.format_name) || '',
            bitrate: parseInt(j.format && j.format.bit_rate, 10) || 0,
            vcodec: v ? v.codec_name : null,
            vprofile: v ? v.profile || '' : '',
            acodec: audio[0] ? audio[0].codec_name : null,
            width: v ? v.width : null,
            height: v ? v.height : null,
            pixfmt: v ? v.pix_fmt : null,
            audioTracks: audio.length,
            audio: audio.map((s, i) => ({ i, lang: tag(s, 'language'), title: tag(s, 'title'), codec: s.codec_name, channels: s.channels || 0, def: !!(s.disposition && s.disposition.default) })),
            subs: subs.map((s, i) => ({ i, lang: tag(s, 'language'), title: tag(s, 'title'), codec: s.codec_name, text: !/pgs|dvd_sub|dvb_sub|hdmv|xsub/.test(s.codec_name || ''), pic: picKind(s.codec_name), forced: !!(s.disposition && s.disposition.forced) })),
            chapters: (j.chapters || []).map((c) => ({ start: parseFloat(c.start_time) || 0, end: parseFloat(c.end_time) || 0, title: tag(c, 'title') })),
          };
          this.probeCache.set(ck, { p, t: Date.now() });
          if (this.probeCache.size > 2000) this.probeCache.delete(this.probeCache.keys().next().value);
          resolve(p);
        } catch {
          resolve(null);
        }
      });
    });
  }

  /** Does this need re-encoding for a browser that can decode `codecs` (e.g. ['h264','hevc','av1','vp9'])? */
  needsVideoTranscode(p, codecs = ['h264']) {
    if (!p || !p.vcodec) return false;
    const ok = new Set(codecs.map((c) => c.toLowerCase()));
    ok.add('h264');
    if (p.vcodec === 'h264' && p.pixfmt && /10le|12le|422|444/.test(p.pixfmt)) return true; // Hi10P etc. can't be decoded by browsers
    const name = { hevc: 'hevc', h265: 'hevc', av1: 'av1', vp9: 'vp9', h264: 'h264' }[p.vcodec];
    // HLS (MPEG-TS segments) can carry h264 and hevc; others must be re-encoded in a session.
    if (name === 'hevc') return !ok.has('hevc');
    return name !== 'h264';
  }

  activeTranscodes() { return [...this.sessions.values()].filter((s) => s.transcode && !s.exited).length; }

  /**
   * Starts ffmpeg writing an HLS playlist into a temp folder.
   * video: 'copy' keeps the original video; 'h264' re-encodes. height/kbps cap the quality when re-encoding.
   */
  async startSession({ input, headers, live, seek = 0, video = 'copy', audioOnly = false, audioTrack = 0, height = 0, label = '', owner = '', priority = null, noSideOutputs = false }) {
    this.requireFfmpeg();
    const st = this.getSettings();
    const max = Math.max(1, Number(st.maxSessions) || 8);
    // priority(owner) → true for a priority profile: their conversions are the last to be stopped when the server is full.
    const pri = (x) => !!(priority && x.owner && priority(x.owner));
    const mine = !!(priority && owner && priority(owner));
    while (this.sessions.size >= max) {
      const all = [...this.sessions.values()].sort((a, b) => (pri(a) - pri(b)) || (a.lastAccess - b.lastAccess));
      this.stopSession(all[0].id);
    }
    const transcode = !audioOnly && video !== 'copy';
    if (transcode && Number(st.maxTranscodes) > 0 && this.activeTranscodes() >= Number(st.maxTranscodes) && mine) {
      // A priority viewer: stop the most recently started conversion of someone on a standard profile.
      const std = [...this.sessions.values()].filter((x) => x.transcode && !x.exited && !pri(x)).sort((a, b) => b.startedAt - a.startedAt)[0];
      if (std) { log(`Stopping a conversion for a standard profile to make room for a priority viewer.`); this.stopSession(std.id); }
    }
    if (transcode && Number(st.maxTranscodes) > 0 && this.activeTranscodes() >= Number(st.maxTranscodes)) {
      throw new HttpError(503, 'The server is already converting as many videos as it’s allowed to. Try again in a moment.');
    }
    const hw = transcode ? this.hw : '';
    try {
      return await this._start({ input, headers, live, seek, transcode, audioOnly, audioTrack, height, label, owner, hw, noSideOutputs });
    } catch (e) {
      // Only a hardware problem switches to software — not a provider refusing the connection or a slow start
      // (retrying those would just open a second connection to the provider). ffmpeg's own words only: the
      // friendly message for a 401/403 mentions "another device".
      if (!hw || !hwEncoderFailed(e.stderr)) throw e;
      log(`Hardware encoder ${hw} failed (${e.message}); using software encoding from now on.`);
      this.hwFailed = true;
      return this._start({ input, headers, live, seek, transcode, audioOnly, audioTrack, height, label, owner, hw: '', noSideOutputs });
    }
  }

  async _start({ input, headers, live, seek, transcode, audioOnly, audioTrack, height, label, owner, hw, noSideOutputs = false }) {
    const st = this.getSettings();
    const id = uid();
    const dir = path.join(this.tmpDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const args = this._inputArgs(input, { headers, live, seek, readrate: st.remuxReadrate, hw });
    if (audioOnly) args.push('-map', `0:a:${audioTrack}?`, '-map', '0:a:0?', '-vn');
    else args.push('-map', '0:v:0?', '-map', `0:a:${audioTrack}?`);
    if (!audioOnly) {
      if (!transcode) args.push('-c:v', 'copy');
      else {
        const maxH = height || Number(st.transcodeMaxHeight) || 1080;
        const kbps = LADDER[Object.keys(LADDER).map(Number).sort((a, b) => a - b).find((h) => h >= maxH) || 1080] || 6000;
        const gop = ['-force_key_frames', `expr:gte(t,n_forced*${live ? 2 : 4})`];
        if (hw === 'vaapi') args.push('-vf', `format=nv12,hwupload,scale_vaapi=w=-2:h='min(${maxH},ih)'`, '-c:v', 'h264_vaapi', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, ...gop);
        else if (hw) {
          const enc = { nvenc: 'h264_nvenc', qsv: 'h264_qsv', videotoolbox: 'h264_videotoolbox' }[hw];
          args.push('-vf', `scale=-2:'min(${maxH},ih)',format=yuv420p`, '-c:v', enc, '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.3)}k`, '-bufsize', `${kbps * 2}k`, ...gop);
          if (hw === 'nvenc') args.push('-preset', 'p4');
        } else {
          args.push('-vf', `scale=-2:'min(${maxH},ih)'`, '-c:v', 'libx264', '-preset', st.transcodePreset || 'veryfast', '-crf', String(st.transcodeCrf || 22),
            '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-pix_fmt', 'yuv420p', '-profile:v', 'high', ...gop);
        }
      }
    }
    args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-sn', '-dn');
    // Live: 2-second pieces (a TV's or phone's own player waits for about three before it starts — 6 s, not 12), the
    // last 48 s kept as before. Films: 4 s (they arrive faster than they play anyway).
    args.push('-f', 'hls', '-hls_time', live ? '2' : '4',
      '-hls_list_size', live ? '24' : '0',
      '-hls_flags', live ? 'delete_segments+independent_segments' : 'independent_segments',
      ...(live ? [] : ['-hls_playlist_type', 'event']),
      '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
      path.join(dir, 'index.m3u8'));
    // More outputs of the same conversion (live subtitles copied aside: lib/routes-p6.js). Copies only: no extra work.
    let side = 0;
    if (live && !audioOnly && !noSideOutputs && this.sessionOutputs && !(this._noSide && this._noSide.has(input))) { try { const more = await this.sessionOutputs({ input, headers, dir }); side = more.length; args.push(...more); } catch {} }

    const proc = spawn(this.ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const s = { id, dir, proc, live, offset: seek, lastAccess: Date.now(), stderr: '', exited: false, code: null, label, owner, transcode, hw, height, startedAt: Date.now() };
    proc.stderr.on('data', (d) => { s.stderr = (s.stderr + d).slice(-4000); });
    proc.on('exit', (code) => {
      s.exited = true; s.code = code;
      // Ended with an error while copying subtitles aside: leave them out for this stream from now on.
      if (side && code) { (this._noSide || (this._noSide = new Set())).add(input); if (this._noSide.size > 200) this._noSide.delete(this._noSide.values().next().value); }
    });
    proc.on('error', (e) => { s.exited = true; s.stderr += e.message; });
    this.sessions.set(id, s);
    log(`Session ${id} started (${transcode ? `transcode${hw ? ' ' + hw : ''}${height ? ' ' + height + 'p' : ''}` : audioOnly ? 'audio' : 'remux'}${seek ? ` from ${Math.round(seek)}s` : ''}) ${label}`);
    try {
      await this._waitReady(s);
    } catch (e) {
      this.stopSession(id);
      // The subtitles copied aside must never cost the picture: start again without them.
      // (Not when the provider refused or didn't answer: that would be a second connection straight after a "no".)
      if (side && e.status !== 504 && !providerFailed(e.stderr)) {
        log(`Session ${id}: failed with the subtitle copy (${String(e.message).slice(0, 120)}) — starting again without it`);
        return this._start({ input, headers, live, seek, transcode, audioOnly, audioTrack, height, label, owner, hw, noSideOutputs: true });
      }
      throw e;
    }
    return s;
  }

  async _waitReady(s) {
    const file = path.join(s.dir, 'index.m3u8');
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      try {
        const txt = fs.readFileSync(file, 'utf8');
        if (txt.includes('#EXTINF')) return;
      } catch {}
      if (s.exited && s.code !== 0) {
        // (A 404/403 from the provider is passed on, so the page doesn't try other routes to a dead stream.)
        const err = new HttpError(sessionStatus(s.stderr), friendlyFfmpegError(s.stderr, s.code));
        err.stderr = s.stderr;
        throw err;
      }
      if (s.exited && s.code === 0 && fs.existsSync(file)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new HttpError(504, 'Timed out waiting for the stream to start');
  }

  touch(id) {
    const s = this.sessions.get(id);
    if (s) s.lastAccess = Date.now();
    return s;
  }

  stopSession(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    try { s.proc.kill('SIGKILL'); } catch {}
    setTimeout(() => fs.rm(s.dir, { recursive: true, force: true }, () => {}), 500);
  }

  _reap() {
    const now = Date.now();
    for (const s of this.sessions.values()) if (now - s.lastAccess > IDLE_MS) this.stopSession(s.id);
  }

  stopAll() { for (const id of [...this.sessions.keys()]) this.stopSession(id); }

  /** Continuous MPEG-TS for other apps (VLC, Plex, Jellyfin). */
  pipeTS(input, { headers }, req, res) {
    this.requireFfmpeg();
    const args = [...this._inputArgs(input, { headers, live: true }), '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-f', 'mpegts', 'pipe:1'];
    const proc = spawn(this.ffmpegBin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
    proc.stdout.pipe(res);
    const kill = () => { try { proc.kill('SIGKILL'); } catch {} };
    req.on('close', kill);
    proc.on('exit', () => res.end());
  }

  /**
   * A browser-playable MP4 (H.264/AAC) streamed as it's made — for downloads. Copies the video when it can.
   * onProgress(seconds) is called as ffmpeg works.
   */
  mp4(input, { headers, transcode, height = 0, audioTrack = 0 }, req, res, filename) {
    this.requireFfmpeg();
    const st = this.getSettings();
    const args = [...this._inputArgs(input, { headers, live: false }), '-map', '0:v:0?', '-map', `0:a:${audioTrack}?`];
    if (transcode) {
      const h = height || Number(st.transcodeMaxHeight) || 1080;
      args.push('-vf', `scale=-2:'min(${h},ih)'`, '-c:v', 'libx264', '-preset', st.transcodePreset || 'veryfast', '-crf', String(st.transcodeCrf || 22), '-pix_fmt', 'yuv420p');
    } else args.push('-c:v', 'copy');
    args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-sn', '-dn', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
    const proc = spawn(this.ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    res.writeHead(200, {
      'Content-Type': 'video/mp4', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename || 'video.mp4')}`,
    });
    proc.stdout.pipe(res);
    const kill = () => { try { proc.kill('SIGKILL'); } catch {} };
    req.on('close', kill);
    proc.on('exit', (code) => { if (code) log(`Download conversion failed: ${err.trim().split('\n').pop()}`); res.end(); });
  }

  /** One subtitle track as WebVTT (text subtitles only). Cached on disk. */
  subtitles(input, track, { headers } = {}) {
    this.requireFfmpeg();
    const file = path.join(this.cacheDir, 'subs', crypto.createHash('sha1').update(input + '#' + track).digest('hex') + '.vtt');
    if (fs.existsSync(file)) return Promise.resolve(fs.readFileSync(file, 'utf8'));
    const args = [...this._inputArgs(input, { headers }), '-map', `0:s:${track}`, '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1'];
    return new Promise((resolve, reject) => {
      execFile(this.ffmpegBin, args, { timeout: 15 * 60e3, maxBuffer: 64 << 20 }, (err, out) => {
        if (err || !String(out).startsWith('WEBVTT')) return reject(new HttpError(502, 'Couldn’t read that subtitle track'));
        fs.writeFile(file, out, () => {});
        resolve(String(out));
      });
    });
  }

  /** A small JPEG frame at time t (seconds), for seek-bar previews and artwork. Cached on disk. */
  /** One picture from a video at t seconds: a small JPEG (thumbnails), or — png — full size (the player's screenshot). */
  frame(input, t, { headers, width = 320, png = false } = {}) {
    if (!this.available) return Promise.reject(new HttpError(501, 'ffmpeg not available'));
    const out = path.join(this.cacheDir, 'thumbs', crypto.createHash('sha1').update(`${input}@${t}@${width}@${png}`).digest('hex') + (png ? '.png' : '.jpg'));
    if (fs.existsSync(out)) return Promise.resolve(out);
    const args = [...this._netArgs(input, { headers }), '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(Math.max(0, t)), '-i', input,
      '-frames:v', '1', ...(png ? [] : ['-vf', `scale=${width}:-2`, '-q:v', '6']), '-y', out];
    if (isUrl(input)) args.splice(args.indexOf('-i'), 0, '-rw_timeout', '15000000');
    return new Promise((resolve, reject) => {
      execFile(this.ffmpegBin, args, { timeout: 30000 }, (err) => (err || !fs.existsSync(out) ? reject(new HttpError(404, 'No picture there')) : resolve(out)));
    });
  }

  thumbnail(file, out, at) {
    if (!this.available) return Promise.reject(new Error('ffmpeg not available'));
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(Math.max(0, at)), '-i', file,
      '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', '-y', out];
    return new Promise((resolve, reject) => {
      execFile(this.ffmpegBin, args, { timeout: 30000 }, (err) => (err || !fs.existsSync(out) ? reject(err || new Error('no frame')) : resolve(out)));
    });
  }
}

module.exports = { Media, LADDER, friendlyFfmpegError, ffmpegHttpStatus, providerFailed, hwEncoderFailed, sessionStatus };
