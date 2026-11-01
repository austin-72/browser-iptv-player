'use strict';
const path = require('path');
const { JsonFile } = require('./store');
const { HttpError, log } = require('./util');

let IntroDetector = null;
try { ({ IntroDetector } = require('./intro')); } catch {}

/**
 * "Skip intro" / "Skip credits" markers per episode.
 * Sources, best first: someone in the household marked it by hand → chapter names in the file → automatic
 * detection that compares the audio of several episodes of the same season (the intro and end credits are the
 * parts that sound the same in every episode).
 */
class Markers {
  constructor({ dataDir, catalog, media, inputOf, allowed }) {
    this.store = new JsonFile(path.join(dataDir, 'markers.json'), { m: {}, seasons: {} });
    this.catalog = catalog;
    this.inputOf = inputOf;
    this.media = media;
    this._detector = null;
    this.queue = Promise.resolve();
    this.pending = new Set();
    this.enabled = () => true;
    this.allowed = allowed || (() => true);
  }

  /** Made on first use (ffmpeg is only known to be there once the server has checked). */
  get detector() {
    if (!this._detector && IntroDetector && this.media.available) this._detector = new IntroDetector({ ffmpeg: this.media.ffmpegBin, ffprobe: this.media.ffprobeBin, log: () => {} });
    return this._detector;
  }

  get(key) {
    const m = this.store.data.m[key];
    return m ? { intro: m.intro || null, credits: m.credits || null, src: m.src || '' } : { intro: null, credits: null, src: '' };
  }

  /** A person marks the intro/credits. With season=true the same times are used for the rest of the season where nothing better is known. */
  set(key, kind, start, end, { season = false, by = '' } = {}) {
    if (!['intro', 'credits'].includes(kind)) throw new HttpError(400, 'kind must be intro or credits');
    const it = this.catalog.get(key);
    if (!it) throw new HttpError(404, 'Not found');
    const val = start === null ? null : { start: Math.max(0, Number(start) || 0), end: Math.max(0, Number(end) || 0) };
    if (val && val.end <= val.start) throw new HttpError(400, 'The end must be after the start.');
    const apply = (k, src) => {
      const m = this.store.data.m[k] || (this.store.data.m[k] = {});
      m[kind] = val; m.src = src; m.by = by; m.at = Date.now();
    };
    apply(key, 'manual');
    if (season && it.sk) {
      for (const e of this.episodesOf(it)) {
        if (e.k === key) continue;
        const cur = this.store.data.m[e.k];
        if (!cur || cur.src !== 'manual') apply(e.k, 'season');
      }
    }
    this.store.save();
    return this.get(key);
  }

  episodesOf(it) {
    if (!it.sk) return [];
    const keys = this.catalog.shows.get(it.sk) || [];
    const eps = keys.map((k) => this.catalog.get(k)).filter(Boolean);
    for (const e of this.catalog.extra.values()) if (e.sk === it.sk && !keys.includes(e.k)) eps.push(e);
    return eps.filter((e) => e.s === it.s).sort((a, b) => a.e - b.e);
  }

  /** Called when an episode starts: make sure its season has been analysed (in the background, one at a time). */
  want(key) {
    if (!this.detector || !this.enabled()) return;
    const it = this.catalog.get(key);
    if (!it || it.t !== 'episode') return;
    if (!this.allowed(it)) return; // one-connection provider: reading other episodes would cut the viewer off
    const sid = `${it.sk}:${it.s}`;
    const ss = this.store.data.seasons[sid];
    const m = this.store.data.m[key];
    if (m && (m.intro || m.credits)) return;
    if (ss && (ss.done || Date.now() - (ss.tried || 0) < 6 * 3600e3) && (ss.keys || []).includes(key)) return;
    if (this.pending.has(sid)) return;
    this.pending.add(sid);
    this.queue = this.queue.then(() => this._season(it, sid)).catch((e) => log('Intro detection:', e.message)).finally(() => this.pending.delete(sid));
  }

  async _season(it, sid) {
    const eps = this.episodesOf(it);
    if (!eps.length) return;
    // The episode being watched plus its neighbours (detection needs at least two).
    const idx = Math.max(0, eps.findIndex((e) => e.k === it.k));
    const pick = eps.slice(Math.max(0, idx - 2), idx + 3);
    if (pick.length < 2 && eps.length >= 2) pick.push(...eps.filter((e) => !pick.includes(e)).slice(0, 2 - pick.length));
    const inputs = [];
    for (const e of pick) {
      const inp = this.inputOf(e);
      if (inp) inputs.push({ id: e.k, input: inp.input, headers: inp.headers });
    }
    const ss = this.store.data.seasons[sid] || (this.store.data.seasons[sid] = {});
    ss.tried = Date.now();
    if (!inputs.length) return;
    const t0 = Date.now();
    let res = [];
    if (inputs.length >= 2) res = await this.detector.detectSeason(inputs, {});
    else {
      const ch = await this.detector.chapters(inputs[0].input, { headers: inputs[0].headers }).catch(() => null);
      res = [{ id: inputs[0].id, intro: ch && ch.intro, credits: ch && ch.credits, source: 'chapters' }];
    }
    let found = 0;
    for (const r of res || []) {
      const cur = this.store.data.m[r.id];
      if (cur && cur.src === 'manual') continue;
      if (!r.intro && !r.credits) continue;
      this.store.data.m[r.id] = { intro: r.intro ? { start: r.intro.start, end: r.intro.end } : null, credits: r.credits ? { start: r.credits.start, end: r.credits.end } : null, src: r.source || 'audio', at: Date.now() };
      found++;
    }
    ss.keys = [...new Set([...(ss.keys || []), ...inputs.map((x) => x.id)])];
    ss.done = found > 0;
    this.store.save();
    log(`Intro detection for ${it.show || it.n} season ${it.s}: ${found} of ${inputs.length} episodes in ${Math.round((Date.now() - t0) / 1000)} s`);
  }
}

module.exports = { Markers };
