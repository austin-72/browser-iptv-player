'use strict';
/**
 * Picture subtitles (PGS from Blu-ray, VobSub from DVD, DVB) for the browser to draw itself.
 *
 * The server never draws or converts them: ffmpeg copies the subtitle streams out of the file (stream copy, all the
 * picture tracks of a file in one pass, so one read of the file) into Matroska, which is read here as it arrives and
 * split into one packet file per track plus an index (time, duration, where the packet is). The player fetches the
 * index, then only the packets around where it's playing, and decodes them (web/js/picsubdec.js).
 * Finished extractions are kept in the cache folder like text subtitles; an unfinished one stops when nobody has
 * asked for it for a while (it may be holding a connection to the provider).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { log } = require('./util');

const CODECS = { hdmv_pgs_subtitle: 'pgs', dvd_subtitle: 'vobsub', dvb_subtitle: 'dvb' };
const MKV_CODECS = { 'S_HDMV/PGS': 'pgs', S_VOBSUB: 'vobsub', S_DVBSUB: 'dvb' };
/** The kind of picture subtitle a probed codec is ('' when it isn't one the player can draw). */
const picKind = (codec) => CODECS[String(codec || '')] || '';

// ---------------------------------------------------------------- Matroska, read as it arrives
const ID = {
  Segment: 0x18538067, Info: 0x1549A966, Tracks: 0x1654AE6B, TrackEntry: 0xAE, Cluster: 0x1F43B675, BlockGroup: 0xA0,
  TimecodeScale: 0x2AD7B1, TrackNumber: 0xD7, CodecID: 0x86, CodecPrivate: 0x63A2, Timecode: 0xE7, SimpleBlock: 0xA3, Block: 0xA1, BlockDuration: 0x9B,
};
const DESCEND = new Set([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Cluster, ID.BlockGroup]);
const KEEP = new Set([ID.TimecodeScale, ID.TrackNumber, ID.CodecID, ID.CodecPrivate, ID.Timecode, ID.SimpleBlock, ID.Block, ID.BlockDuration]);

/**
 * A streaming Matroska reader for subtitle-only files: push(chunk) as bytes arrive; calls
 * onTrack({ num, codec, priv }) and onPacket({ track, t, d, data }) (seconds). Elements it doesn't need are skipped
 * without being kept in memory; containers (Segment, Cluster…) are entered whatever their size, so files written to a
 * pipe (unknown sizes) work.
 */
class MkvReader {
  constructor({ onTrack, onPacket }) {
    this.onTrack = onTrack; this.onPacket = onPacket;
    this.buf = Buffer.alloc(0); this.skip = 0; this.scale = 1e6; this.cluster = 0; this.track = null; this.pending = null;
  }
  static vint(b, i, keepMarker) {
    if (i >= b.length) return null;
    const first = b[i];
    let len = 1, mask = 0x80;
    while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
    if (len > 8 || i + len > b.length) return null;
    let v = keepMarker ? first : first & (mask - 1), allOnes = (first & (mask - 1)) === mask - 1;
    for (let k = 1; k < len; k++) { v = v * 256 + b[i + k]; if (b[i + k] !== 0xff) allOnes = false; }
    return { v, len, unknown: !keepMarker && allOnes };
  }
  push(chunk) {
    if (this.skip) {
      const n = Math.min(this.skip, chunk.length);
      this.skip -= n; chunk = chunk.subarray(n);
      if (!chunk.length) return;
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let i = 0;
    for (;;) {
      const id = MkvReader.vint(this.buf, i, true);
      if (!id) break;
      const sz = MkvReader.vint(this.buf, i + id.len, false);
      if (!sz) break;
      const head = id.len + sz.len, start = i + head;
      if (DESCEND.has(id.v)) { this._enter(id.v); i = start; continue; }
      if (sz.unknown) { i = start; continue; } // (an unknown-size leaf can't be skipped: treat it as a container)
      if (!KEEP.has(id.v)) {
        const have = this.buf.length - start;
        if (have >= sz.v) { i = start + sz.v; continue; }
        this.skip = sz.v - have; i = this.buf.length; break;
      }
      if (this.buf.length - start < sz.v) break; // wait for the rest
      this._leaf(id.v, this.buf.subarray(start, start + sz.v));
      i = start + sz.v;
    }
    this.buf = i >= this.buf.length ? Buffer.alloc(0) : Buffer.from(this.buf.subarray(i));
  }
  end() { this._flush(); }
  _enter(id) {
    if (id === ID.TrackEntry) { this._endTrack(); this.track = { num: 0, codec: '', priv: null }; }
    if (id === ID.Cluster || id === ID.Tracks) this._endTrack();
    if (id === ID.BlockGroup || id === ID.Cluster) this._flush();
  }
  _endTrack() { if (this.track) { this.onTrack(this.track); this.track = null; } }
  _uint(b) { let v = 0; for (const x of b) v = v * 256 + x; return v; }
  _leaf(id, b) {
    if (id === ID.TimecodeScale) this.scale = this._uint(b) || 1e6;
    else if (id === ID.TrackNumber && this.track) this.track.num = this._uint(b);
    else if (id === ID.CodecID && this.track) this.track.codec = b.toString('latin1').replace(/\0+$/, '');
    else if (id === ID.CodecPrivate && this.track) this.track.priv = Buffer.from(b);
    else if (id === ID.Timecode) this.cluster = this._uint(b);
    else if (id === ID.SimpleBlock || id === ID.Block) {
      this._flush();
      const tn = MkvReader.vint(b, 0, false);
      if (!tn || b.length < tn.len + 3) return;
      const rel = b.readInt16BE(tn.len);
      if (b[tn.len + 2] & 0x06) return; // laced: never used for subtitles
      this.pending = { track: tn.v, t: (this.cluster + rel) * this.scale / 1e9, d: 0, data: Buffer.from(b.subarray(tn.len + 3)) };
      if (id === ID.SimpleBlock) this._flush();
    } else if (id === ID.BlockDuration && this.pending) { this.pending.d = this._uint(b) * this.scale / 1e9; this._flush(); }
  }
  _flush() { if (this.pending) { const p = this.pending; this.pending = null; this.onPacket(p); } }
}

/** What the player needs to know about a packet without decoding it: 2 = a fresh start (decoding can begin here), 4 = clears the screen. */
function packetFlags(kind, b) {
  const u16 = (i) => (b[i] << 8) | b[i + 1];
  if (kind === 'pgs') {
    for (let i = 0; i + 3 <= b.length;) {
      const t = b[i], len = u16(i + 1);
      if (t === 0x16 && len >= 11) return ((b[i + 10] & 0xC0) ? 2 : 0) | (b[i + 13] === 0 ? 4 : 0);
      i += 3 + len;
    }
    return 0;
  }
  if (kind === 'dvb') {
    let i = b[0] === 0x20 && b[1] === 0x00 ? 2 : 0;
    while (i + 6 <= b.length && b[i] === 0x0f) {
      const t = b[i + 1], len = u16(i + 4);
      if (t === 0x10 && len >= 2) return (((b[i + 7] >> 2) & 3) ? 2 : 0) | (len < 8 ? 4 : 0);
      i += 6 + len;
    }
    return 0;
  }
  return 2; // VobSub: every packet stands alone
}

// ---------------------------------------------------------------- extraction jobs
const IDLE_MS = 90e3;

class PicSubs {
  /** media: the Media instance (ffmpeg and its input options); dir: where finished extractions are kept. */
  constructor(media, dir) {
    this.media = media;
    this.dir = dir;
    this.jobs = new Map(); // input hash → job
    fs.mkdirSync(dir, { recursive: true });
    this._reaper = setInterval(() => this._reap(), 15e3);
    this._reaper.unref();
  }
  key(input) { return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, 24); }
  /** Is this file's extraction running, or done and kept? (Then no probe or connection is needed.) */
  known(input) { const h = this.key(input); return this.jobs.has(h) || fs.existsSync(this._meta(h)); }
  _meta(h) { return path.join(this.dir, `${h}.pics.json`); }
  _bin(h, track) { return path.join(this.dir, `${h}-${track}.pics`); }

  /**
   * The index of one picture track, starting the extraction of all the file's picture tracks if needed.
   * tracks: the file's picture subtitle tracks [{ i, codec }] (subtitle stream numbers, as /api/probe lists them).
   * Returns { codec, priv, done, err, n, idx: [[t, d, offset, length, flags]…] from entry `from` on }.
   */
  index(input, headers, tracks, track, from = 0) {
    const h = this.key(input);
    let job = this.jobs.get(h);
    if (!job) {
      const saved = this._load(h);
      if (saved) job = saved;
      else job = this._start(h, input, headers, tracks);
    }
    job.at = Date.now();
    const t = job.tracks[track];
    if (!t) {
      if (job.err && !Object.keys(job.tracks).length) return { done: true, err: job.err, n: 0, idx: [] }; // (couldn't start at all)
      return null; // not one of this file's picture tracks
    }
    return { codec: t.kind, priv: t.priv || '', done: job.done, err: job.err || '', n: t.idx.length, idx: t.idx.slice(Math.max(0, from | 0)) };
  }
  /** Raw packet bytes of a track (offset, length), as listed in its index. */
  read(input, track, off, len) {
    const h = this.key(input);
    const job = this.jobs.get(h) || this._load(h);
    if (!job || !job.tracks[track]) return null;
    job.at = Date.now();
    const t = job.tracks[track];
    const end = Math.min(off + len, t.size);
    if (off < 0 || end <= off) return Buffer.alloc(0);
    const fd = fs.openSync(this._bin(h, track), 'r');
    try { const b = Buffer.alloc(end - off); fs.readSync(fd, b, 0, b.length, off); return b; } finally { fs.closeSync(fd); }
  }
  _load(h) {
    let m;
    try { m = JSON.parse(fs.readFileSync(this._meta(h), 'utf8')); } catch { return null; }
    if (!m || !m.tracks) return null;
    for (const k of Object.keys(m.tracks)) { try { m.tracks[k].size = fs.statSync(this._bin(h, k)).size; } catch { return null; } }
    const job = { h, done: true, err: '', tracks: m.tracks, at: Date.now() };
    this.jobs.set(h, job);
    return job;
  }
  _start(h, input, headers, tracks) {
    const list = (tracks || []).filter((x) => picKind(x.codec));
    const job = { h, done: false, err: '', tracks: {}, at: Date.now(), proc: null, fds: {} };
    this.jobs.set(h, job);
    if (!list.length || !this.media.available) { job.done = true; job.err = list.length ? 'ffmpeg isn’t available' : 'No picture subtitles'; return job; }
    // At most two at once: the oldest one nobody's asking for gives way.
    const running = [...this.jobs.values()].filter((j) => j.proc && !j.done).sort((a, b) => a.at - b.at);
    while (running.length >= 2) this._stop(running.shift(), 'Stopped to make room for another');
    const byNum = {}; // Matroska track number (the order they're mapped in, from 1) → subtitle stream number
    list.forEach((x, k) => {
      byNum[k + 1] = x.i;
      job.tracks[x.i] = { kind: picKind(x.codec), priv: '', idx: [], size: 0 };
      job.fds[x.i] = fs.openSync(this._bin(h, x.i), 'w');
    });
    const args = [...this.media._inputArgs(input, { headers }), ...list.flatMap((x) => ['-map', `0:s:${x.i}`]), '-c:s', 'copy', '-f', 'matroska', 'pipe:1'];
    const proc = spawn(this.media.ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    job.proc = proc;
    let err = '';
    const reader = new MkvReader({
      onTrack: (tr) => { const i = byNum[tr.num], t = job.tracks[i]; if (t && tr.priv && t.kind === 'vobsub') t.priv = tr.priv.toString('latin1').slice(0, 4000); },
      onPacket: (p) => {
        const i = byNum[p.track], t = job.tracks[i];
        if (!t || !p.data.length) return;
        fs.writeSync(job.fds[i], p.data, 0, p.data.length, t.size);
        t.idx.push([Math.round(p.t * 1000) / 1000, Math.round(p.d * 1000) / 1000, t.size, p.data.length, packetFlags(t.kind, p.data)]);
        t.size += p.data.length;
      },
    });
    proc.stdout.on('data', (d) => { try { reader.push(d); } catch (e) { err = e.message; this._stop(job, 'Couldn’t read the subtitles'); } });
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    proc.on('error', (e) => { err = e.message; });
    proc.on('close', (code) => {
      if (job.done) return;
      reader.end();
      job.proc = null;
      job.done = true;
      this._closeFds(job);
      if (code !== 0) { job.err = 'Couldn’t read that subtitle track'; log(`Picture subtitles: ffmpeg stopped (${code}): ${String(err).trim().split('\n').pop()}`); this._remove(job); return; }
      const meta = { tracks: {} };
      for (const [k, t] of Object.entries(job.tracks)) meta.tracks[k] = { kind: t.kind, priv: t.priv, idx: t.idx };
      fs.writeFile(this._meta(h), JSON.stringify(meta), () => {});
    });
    return job;
  }
  _closeFds(job) { for (const fd of Object.values(job.fds || {})) { try { fs.closeSync(fd); } catch {} } job.fds = {}; }
  _remove(job) { for (const k of Object.keys(job.tracks)) fs.rm(this._bin(job.h, k), { force: true }, () => {}); }
  _stop(job, why) {
    if (job.done) return;
    job.done = true;
    job.err = why || 'Stopped';
    try { job.proc.kill('SIGKILL'); } catch {}
    job.proc = null;
    this._closeFds(job);
    this._remove(job);
    this.jobs.delete(job.h);
  }
  _reap() {
    const now = Date.now();
    for (const job of [...this.jobs.values()]) {
      if (!job.done && now - job.at > IDLE_MS) this._stop(job, 'Nobody was watching');
      else if (job.done && now - job.at > 10 * 60e3) this.jobs.delete(job.h); // (kept on disk; read again when asked)
    }
  }
  stopAll() { for (const job of [...this.jobs.values()]) this._stop(job, 'Server stopping'); }
}

// ---------------------------------------------------------------- live conversions: DVB / teletext subtitles copied aside
const REV = new Uint8Array(256);
for (let i = 0; i < 256; i++) { let r = 0; for (let k = 0; k < 8; k++) if (i & (1 << k)) r |= 1 << (7 - k); REV[i] = r; }
const ham = (b) => ((b >> 1) & 1) | (((b >> 3) & 1) << 1) | (((b >> 5) & 1) << 2) | (((b >> 7) & 1) << 3);

/** The subtitle streams a PMT's ES descriptors announce (as web/js/picsubdec.js esSubs does). */
function esSubs(d) {
  const out = [];
  for (let i = 0; i + 2 <= d.length;) {
    const tag = d[i], len = d[i + 1], x = d.subarray(i + 2, i + 2 + len);
    if (tag === 0x59) for (let k = 0; k + 8 <= x.length; k += 8) out.push({ kind: 'dvb', lang: x.subarray(k, k + 3).toString('latin1'), hi: x[k + 3] >= 0x20 && x[k + 3] <= 0x24, comp: (x[k + 4] << 8) | x[k + 5], anc: (x[k + 6] << 8) | x[k + 7] });
    if (tag === 0x56 || tag === 0x46) {
      for (let k = 0; k + 5 <= x.length; k += 5) {
        const type = x[k + 3] >> 3;
        if (type === 2 || type === 5) out.push({ kind: 'ttx', lang: x.subarray(k, k + 3).toString('latin1'), hi: type === 5, page: ((x[k + 3] & 7) || 8) * 256 + x[k + 4] });
      }
    }
    i += 2 + len;
  }
  return out;
}

/**
 * Reads the MPEG-TS file a live conversion writes its subtitle streams to, as it grows: the streams (from the PMT)
 * and their packets (PES payloads with PTS in seconds). Teletext keeps only the magazines that carry subtitles.
 */
class TsSubs {
  constructor(file) { this.file = file; this.pos = 0; this.pmt = new Set(); this.streams = {}; this.pes = {}; this.packets = []; this.seq = 0; }
  poll() {
    let size;
    try { size = fs.statSync(this.file).size; } catch { return; }
    const n = Math.min(4 << 20, Math.floor((size - this.pos) / 188) * 188);
    if (n <= 0) return;
    const buf = Buffer.alloc(n);
    const fd = fs.openSync(this.file, 'r');
    try { fs.readSync(fd, buf, 0, n, this.pos); } finally { fs.closeSync(fd); }
    this.pos += n;
    for (let i = 0; i + 188 <= n; i += 188) if (buf[i] === 0x47) this._packet(buf.subarray(i, i + 188));
    if (this.packets.length > 3000) this.packets = this.packets.slice(-2000);
  }
  _packet(b) {
    const pid = ((b[1] & 0x1f) << 8) | b[2], pusi = b[1] & 0x40, afc = (b[3] >> 4) & 3;
    let off = 4;
    if (afc & 2) off += 1 + b[4];
    if (!(afc & 1) || off >= 188) return;
    const pl = b.subarray(off);
    if (pid === 0 && pusi) {
      const sct = pl.subarray(1 + pl[0]), len = ((sct[1] & 0x0f) << 8) | sct[2];
      for (let k = 8; k + 4 <= 3 + len - 4; k += 4) if ((sct[k] << 8 | sct[k + 1]) !== 0) this.pmt.add(((sct[k + 2] & 0x1f) << 8) | sct[k + 3]);
    } else if (this.pmt.has(pid) && pusi) {
      const sct = pl.subarray(1 + pl[0]);
      if (sct[0] !== 2) return;
      const len = ((sct[1] & 0x0f) << 8) | sct[2], end = Math.min(sct.length, 3 + len - 4);
      for (let k = 12 + (((sct[10] & 0x0f) << 8) | sct[11]); k + 5 <= end;) {
        const type = sct[k], es = ((sct[k + 1] & 0x1f) << 8) | sct[k + 2], il = ((sct[k + 3] & 0x0f) << 8) | sct[k + 4];
        if (type === 0x06 && !this.streams[es]) {
          const subs = esSubs(sct.subarray(k + 5, k + 5 + il));
          if (subs.length) this.streams[es] = { pid: es, subs, mags: new Set(subs.filter((x) => x.kind === 'ttx').map((x) => x.page >> 8)) };
        }
        k += 5 + il;
      }
    } else if (this.streams[pid]) {
      if (pusi) { this._flush(pid); this.pes[pid] = [Buffer.from(pl)]; }
      else if (this.pes[pid]) this.pes[pid].push(Buffer.from(pl));
      const parts = this.pes[pid];
      if (parts && parts.length) {
        const h = parts[0], want = h.length >= 6 ? ((h[4] << 8) | h[5]) + 6 : 0;
        if (want > 6 && parts.reduce((a, x) => a + x.length, 0) >= want) this._flush(pid);
      }
    }
  }
  _flush(pid) {
    const parts = this.pes[pid];
    this.pes[pid] = null;
    if (!parts) return;
    let d = Buffer.concat(parts);
    if (d.length < 9 || d[0] !== 0 || d[1] !== 0 || d[2] !== 1) return;
    const plen = (d[4] << 8) | d[5];
    if (plen) d = d.subarray(0, plen + 6);
    if (!(d[7] & 0x80)) return; // no PTS
    const pts = ((d[9] >> 1) & 7) * 1073741824 + ((d[10] << 7) | (d[11] >> 1)) * 32768 + ((d[12] << 7) | (d[13] >> 1));
    let data = d.subarray(9 + d[8]);
    const st = this.streams[pid];
    if (st.mags.size && data[0] >= 0x10 && data[0] <= 0x1f) {
      // Teletext: only the magazines with subtitle pages (the rest is the whole teletext service).
      const keep = [Buffer.from([data[0]])];
      for (let i = 1; i + 2 <= data.length;) {
        const len = data[i + 1];
        if (len === 0x2c && i + 2 + len <= data.length) { const m = (ham(REV[data[i + 4]]) & 7) || 8; if (st.mags.has(m)) keep.push(data.subarray(i, i + 2 + len)); }
        i += 2 + len;
      }
      if (keep.length === 1) return;
      data = Buffer.concat(keep);
    }
    this.packets.push({ seq: ++this.seq, pid, pts: pts / 90000, data: data.toString('base64') });
  }
  /** Streams and the packets after `from` (a sequence number), for the player. */
  since(from) {
    this.poll();
    return { streams: Object.values(this.streams).map((x) => ({ pid: x.pid, subs: x.subs })), packets: this.packets.filter((x) => x.seq >= from).map((x) => ({ pid: x.pid, pts: x.pts, data: x.data })), next: this.seq + 1 };
  }
}

module.exports = { PicSubs, MkvReader, TsSubs, esSubs, packetFlags, picKind, CODECS, MKV_CODECS };
