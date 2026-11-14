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

const HW_ENC = { vaapi: 'h264_vaapi', nvenc: 'h264_nvenc', qsv: 'h264_qsv', videotoolbox: 'h264_videotoolbox' };

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
    this._probing = new Map(); // looks inside a file that are running now, by the same key
    this.filters = new Set(); // this ffmpeg's filters (detect)
    this.noDecode = new Set(); // formats this ffmpeg names but can't decode (detect)
    this.hwFailed = false;
    this.hwCheck = null; // { want, ok, why, at } — the last test of the chosen hardware encoder
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
    return Promise.all([run(this.ffmpegBin, ['-version']), run(this.ffprobeBin, ['-version']), run(this.ffmpegBin, ['-hide_banner', '-encoders']),
      run(this.ffmpegBin, ['-hide_banner', '-filters']), run(this.ffmpegBin, ['-hide_banner', '-codecs'])]).then(([f, p, enc, fil, cod]) => {
      // What this ffmpeg can do beyond the basics: its filters (HDR → SDR needs zscale and tonemap), and the formats
      // it knows by name but can't decode (AC-4 sound, say) — those are left out rather than failing the whole stream.
      this.filters = new Set();
      for (const line of String(fil || '').split('\n')) { const m = line.match(/^\s*[T.][S.][C.]\s+(\S+)\s/); if (m) this.filters.add(m[1]); }
      this.noDecode = new Set();
      for (const line of String(cod || '').split('\n')) { const m = line.match(/^\s*([D.])[E.][VAS][I.][L.][S.]\s+([a-z0-9_]+)\s/); if (m && m[1] === '.') this.noDecode.add(m[2]); }
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

  get hwWant() { return (this.getSettings().hwaccel || this.cfg.hwaccel || '').toLowerCase(); }

  get hw() {
    const want = this.hwWant;
    if (!want || this.hwFailed) return '';
    if (this.hwCheck && this.hwCheck.want === want && !this.hwCheck.ok) return '';
    const enc = HW_ENC[want];
    return enc && this.encoders.has(enc) ? want : '';
  }

  /**
   * Try the chosen hardware encoder on a half-second test picture, so a viewer never waits on one that can't work.
   * Runs when the server starts and whenever the setting changes. The answer (and why, in plain words) is shown in Admin.
   */
  testHw() {
    const want = this.hwWant;
    const done = (ok, why) => { this.hwCheck = { want, ok, why: why || '', at: Date.now() }; if (!ok) log(`Hardware encoder ${want} isn't usable: ${why} Converting with software instead.`); return this.hwCheck; };
    if (!want) { this.hwCheck = null; return Promise.resolve(null); }
    const enc = HW_ENC[want];
    if (!this.available) return Promise.resolve(done(false, 'ffmpeg isn’t installed.'));
    if (!enc || !this.encoders.has(enc)) return Promise.resolve(done(false, `This ffmpeg wasn’t built with ${enc || want}.`));
    if (want === 'vaapi' && !fs.existsSync(this.cfg.vaapiDevice)) {
      return Promise.resolve(done(false, `There’s no graphics device at ${this.cfg.vaapiDevice} inside the container. On Linux, pass it in (devices: /dev/dri:/dev/dri in docker-compose.yml). Docker Desktop on Windows or Mac can’t pass Intel or AMD graphics through, so choose None there.`));
    }
    const a = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (want === 'vaapi') a.push('-vaapi_device', this.cfg.vaapiDevice);
    a.push('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '0.5');
    a.push('-vf', want === 'vaapi' ? 'format=nv12,hwupload' : want === 'qsv' ? 'format=nv12' : 'format=yuv420p', '-c:v', enc, '-f', 'null', '-');
    return new Promise((resolve) => {
      execFile(this.ffmpegBin, a, { timeout: 20000, maxBuffer: 1 << 20 }, (err, out, errOut) => {
        if (this.hwWant !== want) return resolve(this.hwCheck); // the setting changed while this ran
        if (!err) return resolve(done(true));
        const said = String(errOut || err.message || '').split('\n').map((x) => x.replace(/^\[[^\]]*\]\s*/, '').trim()).filter(Boolean).slice(0, 2).join(' ').slice(0, 240);
        const hint = want === 'nvenc' ? ' The container needs the graphics card (gpus: all in docker-compose.yml), NVIDIA’s container support, and an image based on Debian or Ubuntu rather than Alpine.'
          : want === 'qsv' ? ' Quick Sync needs an Intel chip passed in through /dev/dri, which Docker Desktop on Windows or Mac can’t do.'
            : want === 'videotoolbox' ? ' VideoToolbox only works when the server runs straight on a Mac, not in Docker.'
              : ' The graphics driver inside the container may not support this chip.';
        resolve(done(false, `${enc} didn’t start (${said || 'no reason given'}).${hint}`));
      });
    });
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
    // (+genpts for files too: an AVI — and other files that carry no picture timestamps — can't be copied without,
    // "first pts and dts value must be set", and it changes nothing for files that have them.)
    a.push('-fflags', live ? '+genpts+discardcorrupt' : '+genpts');
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
    // (Being looked at right now — the warm-up a title's page asked for, or another viewer: wait for that look
    // instead of opening a second connection to the provider.)
    const going = this._probing.get(ck);
    if (going) return going;
    const pr = this._probe(input, opts, ck);
    this._probing.set(ck, pr);
    pr.then(() => this._probing.delete(ck), () => this._probing.delete(ck));
    return pr;
  }

  _probe(input, opts, ck) {
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
            // (For converting well: interlaced pictures are deinterlaced, HDR is brought down to ordinary colours.)
            field: v && v.field_order && !/progressive|unknown/.test(v.field_order) ? v.field_order : '',
            transfer: v ? v.color_transfer || '' : '',
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

  /**
   * Does this need re-encoding for a device that can decode `codecs` (e.g. ['h264','hevc','av1','vp9'])?
   * caps — what else the device said about itself (web/js/player.js convCaps), all optional:
   *   fmp4: the codecs it plays from MP4 pieces (AV1 and VP9 can't travel in MPEG-TS, so they're only copied then);
   *   hevc10: false when its HEVC is 8-bit only; maxH: { codec: the tallest picture it decodes }.
   */
  needsVideoTranscode(p, codecs = ['h264'], caps = null) {
    if (!p || !p.vcodec) return false;
    const ok = new Set(codecs.map((c) => c.toLowerCase()));
    ok.add('h264');
    const name = { hevc: 'hevc', h265: 'hevc', av1: 'av1', vp9: 'vp9', h264: 'h264' }[p.vcodec];
    const pix = p.pixfmt || '';
    // (4:2:2, 4:4:4 and 12-bit pictures: no browser decodes those, whatever the format.)
    if (/422|444|12le|gbr/.test(pix)) return true;
    if (name === 'h264' && /10le/.test(pix)) return true; // Hi10P can't be decoded by browsers
    if (!name || !ok.has(name)) return true;
    // (Taller than the device decodes: a phone or stick whose decoder stops at 1080p gets it brought down.)
    const maxH = caps && caps.maxH && Number(caps.maxH[name]);
    if (maxH && p.height && Math.min(p.height, p.width || p.height) > maxH * 1.12) return true;
    if (name === 'hevc') return !!(caps && caps.hevc10 === false && /10le/.test(pix));
    // HLS in MPEG-TS pieces carries H.264 and HEVC; AV1 and VP9 only go in MP4 pieces, for a device that plays those.
    if (name === 'av1' || name === 'vp9') return !(caps && Array.isArray(caps.fmp4) && caps.fmp4.includes(name));
    return false;
  }

  /** The kind of HLS pieces a copy of this goes out in: MP4 for AV1 and VP9, and for HEVC when the device asks (Apple's own player). */
  segmentsFor(p, caps = null) {
    const name = p && { hevc: 'hevc', h265: 'hevc', av1: 'av1', vp9: 'vp9' }[p.vcodec];
    if (name === 'av1' || name === 'vp9') return 'fmp4';
    if (name === 'hevc' && caps && caps.hevcMp4 === true) return 'fmp4';
    return 'ts';
  }

  /** HDR (PQ or HLG) that this ffmpeg can bring down to ordinary colours when it re-encodes. */
  isHdr(p) { return !!this.hdrKind(p); }
  /** '' for ordinary video, else how the HDR is coded: 'smpte2084' (HDR10, Dolby Vision's base) or 'arib-std-b67' (HLG). */
  hdrKind(p) { const m = /smpte2084|arib-std-b67/.exec((p && p.transfer) || ''); return m ? m[0] : ''; }
  get canTonemap() { return !this.toneFailed && this.filters.has('zscale') && this.filters.has('tonemap') && this.filters.has('setparams'); }
  /** Can this ffmpeg decode it? (Only "no" for a format it names but has no decoder for; unknown names get tried.) */
  canDecode(codec) { return !!codec && codec !== 'none' && !this.noDecode.has(codec); }

  activeTranscodes() { return [...this.sessions.values()].filter((s) => s.transcode && !s.exited).length; }

  /**
   * Starts ffmpeg writing an HLS playlist into a temp folder.
   * video: 'copy' keeps the original video; 'h264' re-encodes. height/kbps cap the quality when re-encoding.
   * fmp4 — MP4 pieces instead of MPEG-TS (see segmentsFor; `vcodec` says what's being copied); hdr — the
   * picture is HDR, brought down to ordinary colours when it's re-encoded; interlaced — it says it's interlaced; keyed —
   * a copy started part-way says where its picture really starts (see _start); noAudio — leave the sound out (a format
   * this ffmpeg can't decode would otherwise stop the whole stream).
   */
  async startSession({ input, headers, live, seek = 0, video = 'copy', audioOnly = false, audioTrack = 0, height = 0, label = '', owner = '', ip = '', priority = null, noSideOutputs = false, fmp4 = false, hdr = false, interlaced = false, noAudio = false, vcodec = '', keyed = false }) {
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
    let useHw = hw, useHdr = hdr;
    for (let tries = 0; ; tries++) {
      try {
        return await this._start({ input, headers, live, seek, transcode, audioOnly, audioTrack, height, label, owner, ip, hw: useHw, noSideOutputs, fmp4: fmp4 && !transcode && !audioOnly, hdr: useHdr, interlaced, noAudio, vcodec, keyed });
      } catch (e) {
        if (tries >= 2) throw e;
        // The HDR step must never cost the film: if ffmpeg stops on it (its own words; not the provider, not a slow
        // start), the conversion starts once more without — the colours as before rather than no film.
        if (transcode && useHdr && this.canTonemap && e.status !== 504 && !providerFailed(e.stderr) && /Parsed_(zscale|tonemap|setparams)|no path between colorspaces/i.test(String(e.stderr || ''))) {
          log(`Bringing HDR down to ordinary colours failed for ${label || 'a video'} (${String(e.message || '').slice(0, 160)}); converting without it.`);
          useHdr = false;
          continue;
        }
        // Only a hardware problem switches to software — not a provider refusing the connection or a slow start
        // (retrying those would just open a second connection to the provider). ffmpeg's own words only: the
        // friendly message for a 401/403 mentions "another device".
        if (useHw && hwEncoderFailed(e.stderr)) {
          log(`Hardware encoder ${useHw} failed (${e.message}); using software encoding from now on.`);
          this.hwFailed = true;
          this.hwCheck = { want: useHw, ok: false, why: `It failed while converting: ${String(e.message || '').slice(0, 200)}`, at: Date.now() };
          useHw = '';
          continue;
        }
        throw e;
      }
    }
  }

  async _start({ input, headers, live, seek, transcode, audioOnly, audioTrack, height, label, owner, ip = '', hw, noSideOutputs = false, fmp4 = false, hdr = false, interlaced = false, noAudio = false, vcodec = '', keyed = false }) {
    const st = this.getSettings();
    const id = uid();
    const dir = path.join(this.tmpDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const args = this._inputArgs(input, { headers, live, seek, readrate: st.remuxReadrate, hw });
    // A copy started part-way keeps the file's own clock (-copyts, counted from zero): its picture begins at the key
    // frame before the point asked for, and that frame's time is then there to read off the first piece (_keyTime).
    // (Only for a player that asked for it — `keyed`: hls.js and Apple's; a TV's or console's own player gets its
    // copies exactly as it always has.)
    keyed = !!keyed && !live && !transcode && !audioOnly && seek > 0;
    if (keyed) args.push('-copyts', '-start_at_zero');
    if (audioOnly) args.push('-map', `0:a:${audioTrack}?`, '-map', '0:a:0?', '-vn');
    else args.push('-map', '0:v:0?', ...(noAudio ? [] : ['-map', `0:a:${audioTrack}?`]));
    if (!audioOnly) {
      if (!transcode) {
        args.push('-c:v', 'copy');
        // (Apple's players only take HEVC in MP4 pieces when it's marked "hvc1".)
        if (fmp4 && /^(hevc|h265)$/.test(vcodec)) args.push('-tag:v', 'hvc1');
      } else {
        const maxH = height || Number(st.transcodeMaxHeight) || 1080;
        const kbps = LADDER[Object.keys(LADDER).map(Number).sort((a, b) => a - b).find((h) => h >= maxH) || 1080] || 6000;
        const gop = ['-force_key_frames', `expr:gte(t,n_forced*${live ? 2 : 4})`];
        // Before encoding: interlaced pictures (broadcast TV, DVDs) are deinterlaced — only frames marked interlaced,
        // so ordinary video passes untouched — and HDR is brought down to ordinary colours; left as it is, a film
        // comes out grey and washed-out on a screen that isn't showing HDR. Scaled down first: less to work on.
        const chain = (...f) => f.filter(Boolean).join(',');
        // (A stream that says it's interlaced: every frame; otherwise only frames marked so — a channel that switches,
        // or one the look inside didn't get to.)
        const deint = this.filters.has('yadif') ? `yadif=mode=send_frame:deint=${interlaced ? 'all' : 'interlaced'}` : '';
        const scale = `scale=-2:'min(${maxH},ih)'`;
        // (The colours are stated first — BT.2020 with the film's own curve: a file that marks only part of that
        // would otherwise stop the conversion, "no path between colorspaces".)
        const tone = hdr && this.canTonemap ? `setparams=color_primaries=bt2020:color_trc=${hdr === 'arib-std-b67' ? 'arib-std-b67' : 'smpte2084'}:colorspace=bt2020nc,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p` : '';
        if (hw === 'vaapi') args.push('-vf', chain(deint, tone && scale, tone, 'format=nv12', 'hwupload', tone ? '' : `scale_vaapi=w=-2:h='min(${maxH},ih)'`), '-c:v', 'h264_vaapi', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, ...gop);
        else if (hw) {
          const enc = { nvenc: 'h264_nvenc', qsv: 'h264_qsv', videotoolbox: 'h264_videotoolbox' }[hw];
          args.push('-vf', chain(deint, scale, tone, 'format=yuv420p'), '-c:v', enc, '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.3)}k`, '-bufsize', `${kbps * 2}k`, ...gop);
          if (hw === 'nvenc') args.push('-preset', 'p4');
        } else {
          args.push('-vf', chain(deint, scale, tone), '-c:v', 'libx264', '-preset', st.transcodePreset || 'veryfast', '-crf', String(st.transcodeCrf || 22),
            '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-pix_fmt', 'yuv420p', '-profile:v', 'high', ...gop);
        }
        if (tone) args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
      }
    }
    if (noAudio && !audioOnly) args.push('-an', '-sn', '-dn');
    else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-sn', '-dn');
    // Live: 2-second pieces (a TV's or phone's own player waits for about three before it starts — 6 s, not 12), the
    // last 48 s kept as before. Films: 4 s (they arrive faster than they play anyway).
    args.push('-f', 'hls', '-hls_time', live ? '2' : '4',
      '-hls_list_size', live ? '24' : '0',
      '-hls_flags', live ? 'delete_segments+independent_segments' : 'independent_segments',
      ...(live ? [] : ['-hls_playlist_type', 'event']),
      // (MP4 pieces: what AV1 and VP9 need, and HEVC for Apple's own player; MPEG-TS for everything else.)
      ...(fmp4 ? ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(dir, 'seg%05d.m4s')] : ['-hls_segment_filename', path.join(dir, 'seg%05d.ts')]),
      path.join(dir, 'index.m3u8'));
    // More outputs of the same conversion (live subtitles copied aside: lib/routes-p6.js). Copies only: no extra work.
    let side = 0;
    if (live && !audioOnly && !noSideOutputs && this.sessionOutputs && !(this._noSide && this._noSide.has(input))) { try { const more = await this.sessionOutputs({ input, headers, dir }); side = more.length; args.push(...more); } catch {} }

    const proc = spawn(this.ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const s = { id, dir, proc, live, offset: seek, lastAccess: Date.now(), stderr: '', exited: false, code: null, label, owner, ip, transcode, hw, height, startedAt: Date.now(), seg: fmp4 ? 'fmp4' : 'ts', tone: !!(transcode && hdr && this.canTonemap), noAudio: !!(noAudio && !audioOnly) };
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
        return this._start({ input, headers, live, seek, transcode, audioOnly, audioTrack, height, label, owner, ip, hw, noSideOutputs: true, fmp4, hdr, interlaced, noAudio, vcodec, keyed });
      }
      throw e;
    }
    // A copy started part-way begins at the picture's key frame before that point, the sound at the point itself.
    // Where the picture really starts is what the player counts from (and it moves up to the point, where the sound
    // is): so the position shown, resuming, and subtitles fetched separately are right, rather than up to a key-frame
    // interval out — ten seconds, in many films.
    if (keyed) {
      const key = await this._keyTime(s, fmp4);
      if (key !== null && key < seek - 0.05 && key > seek - 90) s.offset = Math.max(0, Math.round(key * 1000) / 1000);
    }
    return s;
  }

  /**
   * The time, in the film, of the first picture of a copy made with the file's own clock (see _start): read off its
   * first piece. MPEG-TS pieces carry everything 1.4 s late (ffmpeg's muxer: twice its 0.7 s -muxdelay), MP4 pieces
   * as it is. null when it can't be told.
   */
  _keyTime(s, fmp4) {
    return new Promise((resolve) => {
      // (-live_start_index 0: the first piece — the playlist is still growing, and read as a live stream's it would
      // be looked at near its end.)
      execFile(this.ffprobeBin, ['-v', 'error', '-live_start_index', '0', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-read_intervals', '%+#1', '-of', 'csv=p=0', path.join(s.dir, 'index.m3u8')], { timeout: 4000, maxBuffer: 1 << 20 }, (err, out) => {
        const t = err ? NaN : parseFloat(String(out).split(/[\r\n,]/).find((x) => x.trim() !== ''));
        resolve(Number.isFinite(t) ? t - (fmp4 ? 0 : 1.4) : null);
      });
    });
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
      '-frames:v', '1', ...(png ? [] : ['-vf', `scale=${width}:-2`, '-q:v', '6']), '-y', '-f', 'image2', '-c:v', png ? 'png' : 'mjpeg', out + '.part'];
    if (isUrl(input)) args.splice(args.indexOf('-i'), 0, '-rw_timeout', '15000000');
    // (Written beside it and renamed when whole: a picture cut short by the time limit was kept and shown for good.)
    return new Promise((resolve, reject) => {
      execFile(this.ffmpegBin, args, { timeout: 30000 }, (err) => {
        if (err || !fs.existsSync(out + '.part')) { fs.unlink(out + '.part', () => {}); return reject(new HttpError(404, 'No picture there')); }
        fs.rename(out + '.part', out, (e2) => (e2 && !fs.existsSync(out) ? reject(new HttpError(404, 'No picture there')) : resolve(out)));
      });
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
