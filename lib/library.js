'use strict';
const fs = require('fs');
const path = require('path');
const { hash, log } = require('./util');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.ts', '.m2ts', '.mts', '.wmv', '.flv', '.mpg', '.mpeg', '.vob', '.3gp', '.ogv', '.divx']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wav', '.wma', '.alac', '.aiff']);
const NATIVE_CONTAINER = new Set(['.mp4', '.m4v', '.webm', '.mov', '.ogv', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wav']);
const NATIVE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);
const NATIVE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le']);
const IMG = ['.jpg', '.jpeg', '.png', '.webp'];

const JUNK = /\b(2160p|1080p|720p|480p|4k|uhd|hdr10?|dv|bluray|blu ray|brrip|bdrip|webrip|web dl|web|hdtv|dvdrip|x264|x265|h264|h 264|h265|hevc|aac|ac3|dts|atmos|remux|proper|repack|extended|unrated|10bit|xvid)\b.*$/i;

const tidy = (s) => String(s || '').replace(/[._]+/g, ' ').replace(JUNK, '').replace(/[\s\-[(]+$/, '').replace(/\s+/g, ' ').trim();

function parseName(file, root) {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file, path.extname(file));
  const clean = base.replace(/[._]+/g, ' ');
  const dir = path.dirname(file);
  const parent = path.basename(dir);
  const grand = path.basename(path.dirname(dir));
  const isSeasonDir = (d) => /^(season|series|s)\s*\d+$/i.test(d) || /^specials$/i.test(d);
  const showFromDirs = () => {
    if (isSeasonDir(parent) && path.dirname(dir) !== root) return tidy(grand);
    if (dir !== root) return tidy(parent);
    return '';
  };

  if (AUDIO_EXT.has(ext)) {
    const track = clean.match(/^(\d{1,3})[\s.-]+(.*)$/);
    return {
      type: 'audio',
      title: tidy(track ? track[2] : clean) || clean,
      album: dir !== root ? parent : '',
      artist: dir !== root && path.dirname(dir) !== root ? grand : '',
      track: track ? parseInt(track[1], 10) : null,
    };
  }

  let m = clean.match(/^(.*?)[\s-]*\b[Ss](\d{1,2})[\s.]?[Ee](\d{1,3})(?:[-Ee]+\d{1,3})?\b(.*)$/) ||
    clean.match(/^(.*?)[\s-]*\b(\d{1,2})x(\d{2,3})\b(.*)$/);
  if (!m && isSeasonDir(parent)) {
    const e = clean.match(/^(.*?)\b(?:e|ep|episode)\s*(\d{1,3})\b(.*)$/i);
    const sn = parent.match(/(\d+)/);
    if (e) m = [null, e[1], sn ? sn[1] : '0', e[2], e[3]];
  }
  if (m) {
    const show = tidy(m[1]) || showFromDirs() || 'Unknown show';
    return {
      type: 'episode',
      show,
      season: parseInt(m[2], 10),
      episode: parseInt(m[3], 10),
      title: tidy(m[4].replace(/^[\s-]+/, '')) || '',
    };
  }

  const year = clean.match(/[([\s]((?:19|20)\d{2})[)\]\s]?/);
  let title = clean;
  if (year && year.index > 0) title = clean.slice(0, year.index);
  title = tidy(title) || clean;
  return { type: 'movie', title, year: year ? parseInt(year[1], 10) : null };
}

/** Is a real path (symlinks followed) inside a folder's real path? */
const within = (real, rootReal) => real === rootReal || real.startsWith(rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep);

function findImage(dir, names, have) {
  for (const n of names) {
    for (const e of IMG) {
      // (During a scan the folder's listing is already known: no disk lookup per name.)
      if (have) { const hit = have.get((n + e).toLowerCase()); if (hit) return path.join(dir, hit); continue; }
      const p = path.join(dir, n + e);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * Your own media folders (movies, shows, music, home video). Files are scanned in place:
 * nothing is copied or moved. Titles are worked out from file and folder names
 * ("Show Name/Season 1/Show Name S01E02.mkv", "Movie Title (1999).mp4").
 */
class Library {
  constructor({ folders, store, media, thumbDir }) {
    this.folders = folders; // () => [absolute folder paths]
    this.store = store; // JsonFile { items: {id: item}, scannedAt }
    this.media = media;
    this.thumbDir = thumbDir;
    fs.mkdirSync(thumbDir, { recursive: true });
    this.scanning = false;
    this.progress = { found: 0, probed: 0, toProbe: 0 };
    this.thumbQueue = Promise.resolve();
  }

  items() {
    return Object.values(this.store.data.items);
  }

  /**
   * A file to serve, or null. Its real path (symlinks followed) must still be inside its media folder's: a symlink
   * leading out of the folder, or a file swapped for one after the scan, isn't served (nor are such subtitles).
   */
  get(id) {
    const it = this.store.data.items[id];
    if (!it || !this.inside(it.path, it.root)) return null;
    const subs = (it.subs || []).filter((s) => s && this.inside(s.path, it.root));
    return subs.length === (it.subs || []).length ? it : { ...it, subs };
  }

  /** Is this file really inside the media folder `root` (or, for an item saved without one, any of the folders)? */
  inside(file, root) {
    let real;
    try { real = fs.realpathSync(file); } catch { return false; }
    for (const r of root ? [root] : this.folders() || []) {
      try { if (within(real, fs.realpathSync(r))) return true; } catch {}
    }
    return false;
  }

  status() {
    return { scanning: this.scanning, scannedAt: this.store.data.scannedAt, count: Object.keys(this.store.data.items).length, ...this.progress };
  }

  async scan() {
    if (this.scanning) return this.status();
    this.scanning = true;
    this.progress = { found: 0, probed: 0, toProbe: 0 };
    const started = Date.now();
    // Each folder is listed once per scan: listing it again for every file in it (posters, subtitles) made a scan of
    // a folder with thousands of files take minutes and hold up the server.
    this._dirs = new Map();
    try {
      const folders = this.folders() || [];
      const old = this.store.data.items;
      const next = {};
      for (const root of folders) {
        const visited = new Set();
        // (The folder itself may be a symlink: what's inside is compared with where it really is.)
        let rootReal;
        try { rootReal = await fs.promises.realpath(root); } catch { continue; }
        await this._walk(root, root, visited, rootReal, async (file, st) => {
          const id = hash(file);
          const prev = old[id];
          const ext = path.extname(file).toLowerCase();
          const parsed = parseName(file, root);
          const item = {
            id, path: file, root, ext,
            kind: AUDIO_EXT.has(ext) ? 'audio' : 'video',
            size: st.size, mtime: st.mtimeMs,
            addedAt: prev ? prev.addedAt : Date.now(),
            ...parsed,
          };
          if (prev && prev.size === st.size && prev.mtime === st.mtimeMs && prev.probe) item.probe = prev.probe;
          item.poster = this._poster(file, item, root);
          item.subs = this._subs(file);
          next[id] = item;
          this.progress.found++;
        });
      }
      this.store.data.items = next;
      this.store.data.scannedAt = Date.now();
      this.store.save();
      log(`Library scan: ${Object.keys(next).length} files in ${folders.length} folder(s), ${Date.now() - started} ms`);
    } finally {
      this.scanning = false;
      this._dirs = null;
    }
    this._probeAll();
    return this.status();
  }

  async _walk(dir, root, visited, rootReal, onFile) {
    let real;
    try { real = await fs.promises.realpath(dir); } catch { return; }
    if (visited.has(real) || !within(real, rootReal)) return; // (a symlink out of the media folder isn't followed)
    visited.add(real);
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('@') || e.name === '$RECYCLE.BIN') continue;
      const full = path.join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try { const st = await fs.promises.stat(full); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; }
        if (isFile) { try { if (!within(await fs.promises.realpath(full), rootReal)) continue; } catch { continue; } }
      }
      if (isDir) await this._walk(full, root, visited, rootReal, onFile);
      else if (isFile) {
        const ext = path.extname(e.name).toLowerCase();
        if (!VIDEO_EXT.has(ext) && !AUDIO_EXT.has(ext)) continue;
        if (/sample/i.test(e.name) && /sample/i.test(path.basename(e.name, ext).split(/[-. ]/).pop())) continue;
        try { await onFile(full, await fs.promises.stat(full)); } catch {}
      }
    }
  }

  /** A folder's subtitle files and file names (read once per scan): { subs, lower: Map(lower-case name → name) }. */
  _listing(dir) {
    const hit = this._dirs && this._dirs.get(dir);
    if (hit) return hit;
    let names;
    try { names = fs.readdirSync(dir); } catch { names = []; }
    const lower = new Map();
    for (const n of names) if (!lower.has(n.toLowerCase())) lower.set(n.toLowerCase(), n);
    const out = { subs: names.filter((n) => /\.(srt|vtt|ass|ssa)$/i.test(n)), lower };
    if (this._dirs) this._dirs.set(dir, out);
    return out;
  }

  _poster(file, item, root) {
    const dir = path.dirname(file);
    const base = path.basename(file, path.extname(file));
    const have = (d) => (this._dirs ? this._listing(d).lower : undefined);
    const own = findImage(dir, [base, `${base}-poster`, `${base}-thumb`], have(dir));
    if (own) return own;
    if (item.type === 'episode') {
      return findImage(dir, ['poster', 'folder', 'cover'], have(dir)) || (dir !== root ? findImage(path.dirname(dir), ['poster', 'folder', 'cover'], have(path.dirname(dir))) : null);
    }
    if (dir === root) return null;
    return findImage(dir, ['poster', 'folder', 'cover', 'movie', 'front', 'albumart', 'AlbumArtSmall'], have(dir));
  }

  _subs(file) {
    const dir = path.dirname(file);
    const base = path.basename(file, path.extname(file));
    let names;
    if (this._dirs) names = this._listing(dir).subs;
    else try { names = fs.readdirSync(dir); } catch { return []; }
    return names
      .filter((n) => /\.(srt|vtt|ass|ssa)$/i.test(n) && n.startsWith(base))
      .map((n) => {
        const mid = n.slice(base.length).replace(/\.(srt|vtt|ass|ssa)$/i, '').replace(/^[.\s_-]+/, '');
        return { path: path.join(dir, n), label: mid || 'Subtitles', lang: (mid.match(/^[a-z]{2,3}\b/i) || [''])[0].toLowerCase() };
      });
  }

  async _probeAll() {
    if (!this.media.probeAvailable) return;
    const pending = this.items().filter((i) => !i.probe);
    this.progress.toProbe = pending.length;
    let n = 0;
    const worker = async () => {
      while (pending.length) {
        const it = pending.shift();
        const p = await this.media.probe(it.path);
        const cur = this.store.data.items[it.id];
        if (cur) cur.probe = p || { failed: true };
        this.progress.probed++;
        if (++n % 25 === 0) this.store.save();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    this.store.save();
  }

  /** True when the browser can play the file directly (no ffmpeg needed). */
  isNative(item) {
    if (!NATIVE_CONTAINER.has(item.ext)) return false;
    const p = item.probe;
    if (!p || p.failed) return item.ext !== '.mov';
    if (item.kind === 'audio' || !p.vcodec || p.vcodec === 'mjpeg' || p.vcodec === 'png') return !p.acodec || NATIVE_AUDIO.has(p.acodec);
    if (!NATIVE_VIDEO.has(p.vcodec)) return false;
    if (p.pixfmt && /10le|12le|422|444/.test(p.pixfmt) && p.vcodec === 'h264') return false;
    return !p.acodec || NATIVE_AUDIO.has(p.acodec);
  }

  canCopyVideo(item) {
    const p = item.probe;
    return !!(p && p.vcodec === 'h264' && !(p.pixfmt && /10le|12le|422|444/.test(p.pixfmt)));
  }

  /** Returns a path to a poster/thumbnail image, generating one with ffmpeg if needed. */
  async thumb(item) {
    if (item.poster && fs.existsSync(item.poster) && this.inside(item.poster, item.root)) return item.poster;
    if (item.kind !== 'video') throw new Error('no artwork');
    const out = path.join(this.thumbDir, `${item.id}-${Math.round(item.mtime)}.jpg`);
    if (fs.existsSync(out)) return out;
    const failMark = out + '.fail';
    if (fs.existsSync(failMark)) throw new Error('no artwork');
    const dur = (item.probe && item.probe.duration) || 0;
    const at = dur ? Math.min(dur * 0.2, 600) : 30;
    const job = this.thumbQueue.then(() => this.media.thumbnail(item.path, out, at)
      .catch(() => this.media.thumbnail(item.path, out, 1))
      .catch((e) => { fs.writeFileSync(failMark, ''); throw e; }));
    this.thumbQueue = job.catch(() => {});
    return job;
  }
}

module.exports = { Library, parseName };
