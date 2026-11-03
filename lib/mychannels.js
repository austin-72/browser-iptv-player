'use strict';
/**
 * "My channels": 24/7 channels the admin makes from the catalogue's films and series (a category, a genre, a
 * TMDB collection, or picked titles), played in order, shuffled or by year.
 *
 * Nothing is streamed or stored as a long schedule: each channel keeps its running order (item keys and lengths)
 * and a start time, and what's on at any moment follows from that — the same for everyone, every time. Tuning in
 * plays the current film or episode with the normal player from the right point and moves on to the next item
 * when it ends ("virtual live", no work for the server). The guide is generated from the same running order.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JsonFile } = require('./store');
const { HttpError, uid, log } = require('./util');
const { fetchAny } = require('./net');

const SRC_ID = 'mych';
const DEFAULT_LEN = { movie: 100 * 60, episode: 45 * 60 };
const MAX_ENTRIES = 4000;
const MAX_SERIES = 150;

/** A deterministic shuffle (the same channel always shuffles the same way, until it's rebuilt with a new seed). */
function seededShuffle(arr, seed) {
  let h = crypto.createHash('sha256').update(String(seed)).digest();
  let i = 0;
  const rnd = () => {
    if (i + 4 > h.length) { h = crypto.createHash('sha256').update(h).digest(); i = 0; }
    const v = h.readUInt32BE(i); i += 4;
    return v / 0x100000000;
  };
  const a = arr.slice();
  for (let j = a.length - 1; j > 0; j--) { const k = Math.floor(rnd() * (j + 1)); [a[j], a[k]] = [a[k], a[j]]; }
  return a;
}

/**
 * Where a channel is at time t. entries: [[key, seconds, showKey?], …], epoch: ms. Returns { index, offset (s),
 * start (ms), end (ms) } or null for an empty channel. Pure, so it can be tested on its own.
 */
function positionAt(entries, epoch, t) {
  if (!entries || !entries.length) return null;
  const cycle = entries.reduce((a, e) => a + Math.max(1, e[1]), 0) * 1000;
  let into = (t - epoch) % cycle;
  if (into < 0) into += cycle;
  const cycleStart = t - into;
  let acc = 0;
  for (let i = 0; i < entries.length; i++) {
    const len = Math.max(1, entries[i][1]) * 1000;
    if (into < acc + len) return { index: i, offset: (into - acc) / 1000, start: cycleStart + acc, end: cycleStart + acc + len };
    acc += len;
  }
  return { index: 0, offset: 0, start: cycleStart, end: cycleStart + Math.max(1, entries[0][1]) * 1000 };
}

/** Everything on a channel between two times: [{ index, start, end }]. */
function scheduleBetween(entries, epoch, from, to, max = 2000) {
  const out = [];
  let pos = positionAt(entries, epoch, from);
  while (pos && pos.start < to && out.length < max) {
    out.push({ index: pos.index, start: pos.start, end: pos.end });
    const i = (pos.index + 1) % entries.length;
    const len = Math.max(1, entries[i][1]) * 1000;
    pos = { index: i, start: pos.end, end: pos.end + len };
  }
  return out;
}

class MyChannels {
  constructor({ dir, catalog, lists, tmdb, getSettings, profiles }) {
    this.dir = dir;
    this.profiles = profiles || (() => []); // the household's profiles (for what the shared guide may name)
    this.catalog = catalog;
    this.lists = lists;
    this.tmdb = tmdb;
    this.getSettings = getSettings;
    this.store = new JsonFile(path.join(dir, 'mychannels.json'), { channels: [] });
    this.logoDir = path.join(dir, 'mychannels-logos');
    fs.mkdirSync(this.logoDir, { recursive: true });
    this.source = { id: SRC_ID, type: 'mychannels', name: 'My channels', enabled: true, useGuide: true, lang: '' };
    this.building = new Map();
  }

  all() { return this.store.data.channels; }
  get(id) { const c = this.all().find((x) => x.id === id); if (!c) throw new HttpError(404, 'Channel not found'); return c; }

  /** Joins the catalogue (as an extra source) and the guides. */
  register() {
    if (!this.lists.extras.includes(this.source)) this.lists.extras.push(this.source);
    this.lists.guideProviders.mych = async () => this.guide();
    this._publish();
  }

  /** The channels as catalogue entries (one live channel each). */
  _publish(changed) {
    const items = this.all().filter((c) => c.enabled !== false && (c.entries || []).length).map((c) => ({
      name: c.name, type: 'live', url: `mych:${c.id}`, logo: c.logo || `/api/mychannels/${c.id}/logo.svg?v=${c.builtAt || 0}`,
      group: c.group || 'My channels', category: c.group || 'My channels', chno: c.num ? String(c.num) : '', tvgId: `mych.${c.id}`, tvgName: c.name,
      lang: c.lang || '', headers: {},
    }));
    this.lists.parsed.set(SRC_ID, { items, epgUrls: items.length ? ['mych:all'] : [], format: 'My channels', name: '' });
    this.lists._syncGuides();
    if (changed) {
      this.lists.onChange();
      this.refreshGuide(changed === 'soon' ? 3000 : 0);
    }
  }

  /** Makes the guide again (also when a profile's restrictions change: see _guideViewers). */
  refreshGuide(delay = 0) {
    const g = this.lists.guides().find((x) => x.url === 'mych:all');
    if (g) setTimeout(() => this.lists.refreshGuide(g.id).catch(() => {}), delay);
  }

  // ------------------------------------------------------------ admin
  /** What channels can be made from: categories, genres, collections in the catalogue now. */
  options() {
    const cats = new Map(), genres = new Map(), cols = new Map();
    const meta = this.tmdb && this.tmdb.meta && this.tmdb.meta.data && this.tmdb.meta.data.m || {};
    for (const it of this.catalog.items) {
      if (it.t !== 'movie' && it.t !== 'show') continue;
      const ck = it.t + '|' + it.g;
      cats.set(ck, (cats.get(ck) || 0) + 1);
      for (const g of it.gn || []) genres.set(g, (genres.get(g) || 0) + 1);
      if (it.col) {
        const m = meta[it.k] && meta[it.k].col;
        const c = cols.get(it.col) || { id: it.col, name: (m && m.name) || '', n: 0 };
        c.n++;
        if (!c.name && m && m.name) c.name = m.name;
        cols.set(it.col, c);
      }
    }
    return {
      categories: [...cats].map(([k, n]) => ({ type: k.split('|')[0], name: k.slice(k.indexOf('|') + 1), n })).sort((a, b) => b.n - a.n).slice(0, 500),
      genres: [...genres].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
      collections: [...cols.values()].filter((c) => c.n > 1).map((c) => ({ ...c, name: c.name || `Collection ${c.id}` })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  _clean(b, prev = {}) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Send the channel’s settings.');
    const name = String(b.name !== undefined ? b.name : prev.name || '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Give the channel a name.');
    const src = (b.source && typeof b.source === 'object' ? b.source : null) || prev.source || {};
    const type = ['category', 'genre', 'collection', 'titles'].includes(src.type) ? src.type : null;
    if (!type) throw new HttpError(400, 'Choose what the channel plays.');
    const source = { type, kind: ['movie', 'show', 'any'].includes(src.kind) ? src.kind : 'any' };
    if (type === 'titles') {
      source.keys = (Array.isArray(src.keys) ? src.keys : []).map(String).filter((k) => this.catalog.get(k)).slice(0, 500);
      if (!source.keys.length) throw new HttpError(400, 'Pick at least one film or series.');
    } else {
      source.value = String(src.value || '').slice(0, 200);
      if (!source.value) throw new HttpError(400, 'Choose a ' + (type === 'collection' ? 'collection' : type) + '.');
    }
    const order = ['order', 'shuffle', 'year'].includes(b.order) ? b.order : prev.order || 'shuffle';
    const num = parseInt(b.num !== undefined ? b.num : prev.num, 10);
    const logo = b.logo !== undefined ? String(b.logo || '').trim().slice(0, 2000) : prev.logo || '';
    if (logo && !/^(https?:\/\/|data:image\/)/i.test(logo)) throw new HttpError(400, 'The logo must be a web address (or leave it empty for a picture made from the posters).');
    return { name, source, order, num: num > 0 && num < 100000 ? num : 0, logo, group: String(b.group !== undefined ? b.group : prev.group || '').trim().slice(0, 40) };
  }

  async create(b) {
    const c = { id: uid(), ...this._clean(b), enabled: true, start: Date.now(), seed: uid(), createdAt: Date.now(), entries: [], builtAt: 0 };
    if (!c.num) c.num = 900 + this.all().length + 1;
    this.all().push(c);
    await this.build(c.id);
    if (!c.entries.length) {
      this.store.data.channels = this.all().filter((x) => x !== c);
      this.store.save();
      throw new HttpError(400, 'Nothing in the catalogue matches that — the channel would be empty.');
    }
    this._publish('soon');
    return this.view(c);
  }

  async update(id, b) {
    const c = this.get(id);
    const next = this._clean(b, c);
    const rebuild = JSON.stringify([next.source, next.order]) !== JSON.stringify([c.source, c.order]);
    Object.assign(c, next);
    if ('enabled' in b) c.enabled = !!b.enabled;
    if (b.reshuffle) c.seed = uid();
    if (rebuild || b.reshuffle || b.rebuild) await this.build(c.id);
    else this.store.save();
    this._publish('soon');
    return this.view(c);
  }

  remove(id) {
    this.get(id);
    this.store.data.channels = this.all().filter((x) => x.id !== id);
    this.store.save();
    try { fs.unlinkSync(path.join(this.logoDir, id + '.svg')); } catch {}
    this._publish('soon');
  }

  view(c) {
    const pos = positionAt(c.entries, c.start, Date.now());
    const cur = pos && this.catalog.get(c.entries[pos.index][0]);
    const total = (c.entries || []).reduce((a, e) => a + e[1], 0);
    return { id: c.id, name: c.name, num: c.num, logo: c.logo, group: c.group, source: c.source, order: c.order, enabled: c.enabled !== false, count: (c.entries || []).length, hours: Math.round(total / 360) / 10, builtAt: c.builtAt, now: cur ? cur.n : '' };
  }

  // ------------------------------------------------------------ the running order
  _matches(c) {
    const s = c.source;
    const kindOk = (it) => (s.kind === 'any' ? it.t === 'movie' || it.t === 'show' : it.t === s.kind);
    if (s.type === 'titles') return s.keys.map((k) => this.catalog.get(k)).filter((it) => it && (it.t === 'movie' || it.t === 'show'));
    return this.catalog.items.filter((it) => {
      if (!kindOk(it) || it.adult) return false;
      if (s.type === 'category') return it.g === s.value || it.rg === s.value;
      if (s.type === 'genre') return (it.gn || []).includes(s.value);
      if (s.type === 'collection') return String(it.col || '') === String(s.value);
      return false;
    });
  }

  /** Works out the running order (asks providers for series' episodes and films' lengths when it must). */
  build(id) {
    if (this.building.has(id)) return this.building.get(id);
    const job = this._build(id).finally(() => this.building.delete(id));
    this.building.set(id, job);
    return job;
  }

  async _build(id) {
    const c = this.get(id);
    let titles = this._matches(c);
    if (c.order === 'year') titles.sort((a, b) => (a.y || 0) - (b.y || 0) || a.n.localeCompare(b.n));
    else if (c.order === 'order' && c.source.type !== 'titles') titles.sort((a, b) => a.n.localeCompare(b.n));
    titles = titles.slice(0, 2000);
    const blocks = []; // per title: [[key, seconds, showKey?], …]
    let series = 0;
    const langs = new Map();
    for (const it of titles) {
      for (const l of (it.lg || []).slice(0, 1)) langs.set(l, (langs.get(l) || 0) + 1);
      if (it.t === 'movie') {
        let d = it.d || 0;
        if (!d && it.xt) { try { await this.catalog.details(it.k); d = it.d || 0; } catch {} }
        blocks.push([[it.k, d || DEFAULT_LEN.movie]]);
      } else {
        if (++series > MAX_SERIES) continue;
        let eps = [];
        try { eps = await this.catalog.episodes(it.k); } catch (e) { log(`My channels: episodes of “${it.n}”: ${e.message}`); }
        if (eps.length) blocks.push(eps.map((e) => [e.k, e.d || DEFAULT_LEN.episode, it.k]));
      }
      if (blocks.reduce((a, b) => a + b.length, 0) > MAX_ENTRIES) break;
    }
    let entries;
    if (c.order === 'shuffle') {
      // Films shuffled; a series' episodes stay in order, spread through the channel.
      const flat = [];
      for (const b of blocks) {
        if (b.length === 1) flat.push(b[0]);
        else flat.push(...b.map((e, i) => ({ e, s: b[0][2], i })));
      }
      const mixed = seededShuffle(flat.map((x, i) => i), c.seed + ':' + c.id).map((i) => flat[i]);
      // Put each series' episodes back in their own order, in the slots the shuffle gave that series.
      const bySeries = new Map();
      for (const x of flat) if (x && x.s) (bySeries.get(x.s) || bySeries.set(x.s, []).get(x.s)).push(x.e);
      const used = new Map();
      entries = mixed.map((x) => {
        if (!x || !x.s) return x;
        const n = used.get(x.s) || 0;
        used.set(x.s, n + 1);
        return bySeries.get(x.s)[n];
      });
    } else entries = [].concat(...blocks);
    // What's on now keeps its slot: a rebuild (daily, or a film leaving the catalogue) changes the running order's
    // length, and without this everything on the channel (and its guide) would jump to somewhere else mid-programme.
    const t = Date.now();
    const was = positionAt(c.entries, c.start, t);
    const wasKey = was && c.entries[was.index][0];
    c.entries = entries.slice(0, MAX_ENTRIES).map((e) => (e[2] ? [e[0], Math.round(e[1]), e[2]] : [e[0], Math.round(e[1])]));
    const at = wasKey ? c.entries.findIndex((e) => e[0] === wasKey) : -1;
    if (at >= 0) c.start = was.start - c.entries.slice(0, at).reduce((a, e) => a + Math.max(1, e[1]), 0) * 1000;
    c.lang = [...langs].sort((a, b) => b[1] - a[1]).map((x) => x[0])[0] || '';
    c.builtAt = Date.now();
    this.store.save();
    return c;
  }

  /** Rebuilds every channel (daily, and after big catalogue changes), quietly. */
  async rebuildAll() {
    for (const c of this.all()) { try { await this.build(c.id); } catch (e) { log(`My channels: “${c.name}”: ${e.message}`); } }
    this._publish(true);
  }

  // ------------------------------------------------------------ watching
  /** An entry's catalogue item (fetching a series' episodes first if the server hasn't got them since starting). */
  async _entryItem(e) {
    let it = this.catalog.get(e[0]);
    if (!it && e[2]) { try { await this.catalog.episodes(e[2]); } catch {} it = this.catalog.get(e[0]); }
    return it;
  }

  /**
   * What's on a channel now, for one profile: { item, offset (s), start, end, next }. Items this profile can't see
   * (or that have left the catalogue) are passed over to the next one.
   */
  async now(id, visible, t = Date.now()) {
    const c = this.get(id);
    const pos = positionAt(c.entries, c.start, t);
    if (!pos) throw new HttpError(404, 'This channel has nothing to play.');
    let { index, offset, start, end } = pos;
    for (let n = 0; n < Math.min(50, c.entries.length); n++) {
      const e = c.entries[index];
      const it = await this._entryItem(e);
      if (it && visible(it)) {
        let next = null;
        for (let m = 1; m <= 5 && !next; m++) { const ne = c.entries[(index + m) % c.entries.length]; const ni = await this._entryItem(ne); if (ni && visible(ni)) next = ni; }
        return { channel: { id: c.id, name: c.name, num: c.num }, item: it, offset: n === 0 ? offset : 0, start, end, next };
      }
      index = (index + 1) % c.entries.length;
      start = end; end = start + Math.max(1, c.entries[index][1]) * 1000; offset = 0;
    }
    throw new HttpError(404, 'Nothing on this channel can be shown on this profile.');
  }

  /**
   * The profiles that can see a channel, as the guide checks them. The guide is one listing shared by every profile,
   * so it names a title only when all of them may see it (like the catalogue: adult, certificate, kids, blocked
   * groups). Languages and content types are left out of that check: they'd blank the guide for everyone else.
   */
  _guideViewers(c, chans) {
    const chan = chans.get(`mych:${c.id}`);
    return (this.profiles() || []).filter((p) => !chan || this.catalog.visible(p, chan.k))
      .map((p) => ({ ...p, langs: [], unknownLang: true, restrictions: { ...(p.restrictions || {}), types: [] } }));
  }

  /** The guide for every channel: 6 hours back to `days` ahead. */
  async guide() {
    const days = Math.min(7, Number(this.getSettings().epgDays) || 2);
    const from = Date.now() - 6 * 3600e3, to = Date.now() + days * 86400e3;
    const channels = {}, programmes = {};
    let count = 0;
    const chans = new Map();
    for (const it of this.catalog.items) if (it.t === 'live' && /^mych:/.test(it.u || '')) chans.set(it.u, it);
    for (const c of this.all()) {
      if (c.enabled === false || !(c.entries || []).length) continue;
      const cid = `mych.${c.id}`;
      channels[cid] = { names: [c.name], icon: c.logo || '' };
      const viewers = this._guideViewers(c, chans);
      const ok = new Map();
      // (A key not in the catalogue now, e.g. episodes not fetched yet, is named by its series, which is checked.)
      const shown = (k) => {
        if (!k || !viewers.length || !this.catalog.get(k)) return true;
        if (!ok.has(k)) ok.set(k, viewers.every((p) => !!this.catalog.visible(p, k)));
        return ok.get(k);
      };
      const list = [];
      for (const slot of scheduleBetween(c.entries, c.start, from, to)) {
        const e = c.entries[slot.index];
        // Something a profile watching this channel mustn't see is listed without its name or details.
        const hide = !shown(e[2]) || !shown(e[0]);
        const it = hide ? null : this.catalog.get(e[0]);
        const show = e[2] && !hide ? this.catalog.get(e[2]) : null;
        const p = { s: slot.start, e: slot.end, t: show ? show.n : it ? it.n : 'Next programme' };
        if (it && it.t === 'episode') { p.st = `S${it.s} E${it.e}${it.et ? ' · ' + it.et : ''}`; p.ep = `S${it.s} E${it.e}`; }
        if (it && it.plot) p.d = String(it.plot).slice(0, 600);
        p.c = [it && it.t === 'episode' ? 'Series' : 'Movie'];
        list.push(p);
      }
      programmes[cid] = list;
      count += list.length;
    }
    return { channels, programmes, programmeCount: count };
  }

  // ------------------------------------------------------------ logo: a 2×2 of the channel's posters
  async logo(id) {
    const c = this.get(id);
    const file = path.join(this.logoDir, `${c.id}-${c.builtAt || 0}.svg`);
    try { return fs.readFileSync(file); } catch {}
    for (const f of fs.readdirSync(this.logoDir)) if (f.startsWith(c.id + '-')) { try { fs.unlinkSync(path.join(this.logoDir, f)); } catch {} }
    const pics = [];
    const seen = new Set();
    for (const e of c.entries || []) {
      const it = this.catalog.get(e[2] || e[0]);
      const u = it && (it.poster || it.logo);
      if (!u || seen.has(u) || !/^https?:/i.test(u)) continue;
      seen.add(u);
      pics.push(u);
      if (pics.length >= 4) break;
    }
    const imgs = [];
    for (const u of pics) {
      try {
        const res = await fetchAny(u, { signal: AbortSignal.timeout(8000) });
        const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
        const buf = Buffer.from(await res.arrayBuffer());
        if (res.ok && /^image\//.test(type) && buf.length < 2e6) imgs.push(`data:${type};base64,${buf.toString('base64')}`);
      } catch {}
    }
    const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
    const hue = parseInt(crypto.createHash('md5').update(c.name).digest('hex').slice(0, 2), 16) * 360 / 256;
    const tiles = imgs.map((d, i) => `<image href="${d}" x="${(i % 2) * 200}" y="${Math.floor(i / 2) * 200}" width="200" height="200" preserveAspectRatio="xMidYMid slice"/>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400"><rect width="400" height="400" rx="40" fill="hsl(${hue.toFixed(0)},55%,32%)"/>` +
      `<clipPath id="r"><rect width="400" height="400" rx="40"/></clipPath><g clip-path="url(#r)">${tiles}<rect y="250" width="400" height="150" fill="rgba(0,0,0,.62)"/></g>` +
      `<text x="200" y="${imgs.length ? 340 : 215}" font-family="Inter,Segoe UI,Helvetica,Arial,sans-serif" font-size="${c.name.length > 14 ? 40 : 54}" font-weight="800" fill="#fff" text-anchor="middle">${esc(c.name.length > 22 ? c.name.slice(0, 21) + '…' : c.name)}</text></svg>`;
    try { fs.writeFileSync(file, svg); } catch {}
    return Buffer.from(svg);
  }
}

module.exports = { MyChannels, positionAt, scheduleBetween, seededShuffle, SRC_ID };
