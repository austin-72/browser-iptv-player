'use strict';
/**
 * "Find guides and logos": suggestions for channels with no TV guide or no logo, from public databases.
 *
 *  - iptv-org (https://github.com/iptv-org/api): every known TV channel with its alternative names and country
 *    (channels.json), logos (logos.json) and which sites have listings for it (guides.json). Its channel ids
 *    ("BBCOne.uk") are what many XMLTV guides use, so a guide the admin already has may simply need linking.
 *  - epg.pw: ready-made XMLTV guides per country (https://epg.pw/xmltv/epg_GB.xml.gz). Only the start of each file
 *    (its channel list) is read here; the whole guide is downloaded only once the admin accepts a match from it.
 *
 * Nothing is downloaded until the admin asks. The indexes are big, so they're read as a stream, only the few fields
 * needed are kept (name, other names, country, logo, whether a guide exists), and they're cached in
 * data/cache/publicdb for a week. The matches are only suggestions: nothing changes until the admin accepts them.
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { StringDecoder } = require('string_decoder');
const { autoGunzip } = require('./xmltv');
const { normName } = require('./util');

const WEEK = 7 * 86400e3;
const IPTVORG = () => String(process.env.IPTVORG_API_BASE || 'https://iptv-org.github.io/api').replace(/\/+$/, '');
const EPGPW = () => String(process.env.EPGPW_BASE || 'https://epg.pw').replace(/\/+$/, '');
// The countries epg.pw has a guide file for (https://epg.pw/xmltv.html).
const EPGPW_COUNTRIES = ['AU', 'BR', 'CA', 'CN', 'DE', 'FR', 'GB', 'HK', 'ID', 'IN', 'JP', 'MY', 'NZ', 'PH', 'RU', 'SG', 'TW', 'US', 'VN', 'ZA'];
const COUNTRY_NAMES = {
  AU: 'Australia', BR: 'Brazil', CA: 'Canada', CN: 'China', DE: 'Germany', FR: 'France', GB: 'United Kingdom', HK: 'Hong Kong', ID: 'Indonesia', IN: 'India', JP: 'Japan',
  MY: 'Malaysia', NZ: 'New Zealand', PH: 'Philippines', RU: 'Russia', SG: 'Singapore', TW: 'Taiwan', US: 'United States', VN: 'Vietnam', ZA: 'South Africa',
};
const cc = (c) => { const x = String(c || '').trim().toUpperCase(); return x === 'UK' ? 'GB' : x === 'USA' ? 'US' : x; };
// Country words in category names: "UK | Sports", "|US| News", "[DE] Sport", "Canada: News".
const TAG = /^\s*[[|(]?\s*([A-Z]{2,3})\s*(?:[\]|):▎➾✦•-]|\s)/;
const WORDS = { 'united kingdom': 'GB', britain: 'GB', england: 'GB', scotland: 'GB', wales: 'GB', 'united states': 'US', america: 'US', usa: 'US', canada: 'CA', australia: 'AU', ireland: 'IE', germany: 'DE', deutschland: 'DE', france: 'FR', spain: 'ES', españa: 'ES', italy: 'IT', italia: 'IT', portugal: 'PT', brazil: 'BR', brasil: 'BR', netherlands: 'NL', india: 'IN', 'new zealand': 'NZ', 'south africa': 'ZA', poland: 'PL', turkey: 'TR', mexico: 'MX', arabic: '', latino: '' };
const KNOWN = new Set('US GB CA AU NZ IE ZA IN PK FR DE AT CH BE NL ES MX AR BR PT IT TR GR RU UA PL RO HU CZ SK BG RS HR BA SI MK AL SE NO DK FI IS EE LV LT CN JP KR VN TH ID MY PH SA AE EG MA DZ TN IQ IR IL HK TW SG'.split(' '));

/** Calls onItem(obj) for each element of a big JSON array, reading the stream a piece at a time. */
async function eachJsonItem(stream, onItem) {
  const dec = new StringDecoder('utf8');
  let depth = 0, inStr = false, esc = false, cur = '';
  for await (const chunk of stream) {
    const s = dec.write(chunk);
    let from = depth >= 2 ? 0 : -1;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      if (inStr) { if (esc) esc = false; else if (ch === 92) esc = true; else if (ch === 34) inStr = false; continue; }
      if (ch === 34) inStr = true;
      else if (ch === 123 || ch === 91) { depth++; if (depth === 2) from = i; }
      else if (ch === 125 || ch === 93) {
        if (depth === 2 && from >= 0) { cur += s.slice(from, i + 1); let o = null; try { o = JSON.parse(cur); } catch {} if (o) onItem(o); cur = ''; from = -1; }
        depth--;
      }
    }
    if (depth >= 2 && from >= 0) cur += s.slice(from);
    if (cur.length > 4e6) throw new Error('An entry in the public list is far too big');
  }
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => { if (e[0] === '#') { try { return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)); } catch { return m; } } return ENT[e.toLowerCase()] || m; }).trim();

/** The channel list at the start of an XMLTV file: [{ id, names, icon }]. Stops reading at the first programme. */
async function xmltvChannels(stream) {
  const dec = new StringDecoder('utf8');
  let buf = '';
  const out = [];
  const src = autoGunzip(stream);
  try {
    for await (const chunk of src) {
      buf += dec.write(chunk);
      let pos = 0;
      for (;;) {
        const i = buf.indexOf('<channel', pos);
        const p = buf.indexOf('<programme', pos);
        if (p !== -1 && (i === -1 || p < i)) return out;
        if (i === -1) { pos = buf.length; break; }
        const end = buf.indexOf('</channel>', i);
        if (end === -1) { pos = i; break; }
        const x = buf.slice(i, end);
        const id = /\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(x);
        const names = []; const re = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g; let m;
        while ((m = re.exec(x))) { const n = unxml(m[1]); if (n && !names.includes(n)) names.push(n); }
        const icon = /<icon[^>]*\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(x);
        if (id) out.push({ id: unxml(id[1] !== undefined ? id[1] : id[2]), names, icon: icon ? unxml(icon[1] !== undefined ? icon[1] : icon[2]) : '' });
        pos = end + 10;
      }
      buf = buf.slice(pos);
      if (buf.length > 2e6) buf = buf.slice(-2000);
      if (out.length > 20000) return out;
    }
    return out;
  } finally { try { src.destroy(); stream.destroy(); } catch {} }
}

/** Name variants to look up: the name itself, and without a country word or tag at either end ("BBC One UK" → "BBC One"). */
function nameKeys(name) {
  const keys = new Set();
  const n = String(name || '').replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const add = (s) => { const k = normName(s); if (k && k.length >= 2) keys.add(k); };
  add(n);
  const parts = n.split(/[\s:|-]+/).filter(Boolean);
  if (parts.length > 1 && KNOWN.has(cc(parts[parts.length - 1]))) add(parts.slice(0, -1).join(' '));
  if (parts.length > 1 && KNOWN.has(cc(parts[0]))) add(parts.slice(1).join(' '));
  add(n.replace(/\s*\b(east|west|\+1|plus ?1)\s*$/i, ''));
  return [...keys];
}

/** Country hints for one of our channels: { strong: 'GB' | '', langs: ['en'] }. raw: the provider's entry { g, n, c }. */
function hintsOf(it, list, raw) {
  let strong = '';
  const tv = /\.([a-z]{2})(?:@|$)/i.exec(it.tvgId || '');
  if (tv) strong = cc(tv[1]);
  if (!strong && raw && raw.c && KNOWN.has(cc(raw.c))) strong = cc(raw.c);
  // (The provider's own category and name, before tidying took "UK |" off them, then the tidied ones.)
  for (const g of [raw && raw.g, raw && raw.n, it._o ? it._o.g : it.g, it.rg, it.g]) {
    if (strong || !g) continue;
    const m = TAG.exec(String(g));
    if (m && KNOWN.has(cc(m[1]))) { strong = cc(m[1]); break; }
    const lw = String(g).toLowerCase();
    for (const [w, c] of Object.entries(WORDS)) if (c && lw.includes(w)) { strong = c; break; }
  }
  const langs = [];
  if (list && list.lang) langs.push(list.lang);
  for (const l of it.lg || []) if (!langs.includes(l)) langs.push(l);
  return { strong, langs };
}

class PublicDb {
  /** deps: { dataDir, fetch, log, fromCountry(cc) → language(s) } */
  constructor({ dataDir, fetch, log, fromCountry }) {
    this.dir = path.join(dataDir, 'cache', 'publicdb');
    this.fetch = fetch;
    this.log = log || (() => {});
    this.fromCountry = fromCountry || (() => null);
    this.mem = null; // the iptv-org index while in use
    this.epgpw = new Map(); // country → { at, channels }
    this._idle = null;
  }

  _file(n) { return path.join(this.dir, n); }
  _read(n) { try { return JSON.parse(fs.readFileSync(this._file(n), 'utf8')); } catch { return null; } }
  _write(n, data) { fs.mkdirSync(this.dir, { recursive: true }); const f = this._file(n); fs.writeFileSync(f + '.tmp', JSON.stringify(data)); fs.renameSync(f + '.tmp', f); }
  /** Lets the big indexes go when nobody has used them for a while. */
  _keep() { clearTimeout(this._idle); this._idle = setTimeout(() => { this.mem = null; this.epgpw.clear(); }, 15 * 60e3); this._idle.unref(); }

  info() {
    const st = (n) => { try { return fs.statSync(this._file(n)).mtimeMs; } catch { return 0; } };
    return { iptvorg: st('iptvorg.json'), epgpw: EPGPW_COUNTRIES.map((c) => ({ cc: c, at: st(`epgpw-${c}.json`) })).filter((x) => x.at) };
  }

  async _get(url, signal) {
    const res = await this.fetch(url, { headers: { 'User-Agent': 'superstation-iptv (guide finder)', Accept: '*/*' }, redirect: 'follow', signal });
    if (!res.ok) { try { res.body && res.body.cancel(); } catch {} throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status }); }
    return Readable.fromWeb(res.body);
  }
  /** Downloads and reads one public file; a failure says, in plain words, which site and what to check. */
  async _fetchRead(url, signal, use) {
    try { return await use(await this._get(url, signal)); } catch (e) {
      if (e.plain || (signal && signal.aborted)) throw e;
      const host = (() => { try { return new URL(url).host; } catch { return 'the site'; } })();
      const tech = String((e.cause && (e.cause.code || e.cause.message)) || e.message || e);
      const msg = e.status
        ? `${host} answered with an error (HTTP ${e.status}). It may be busy or have moved things; try again later.`
        : `Couldn’t reach ${host}. Check that this server can reach the internet, and if it goes through a proxy (Admin → Network & proxies), that the proxy works.`;
      throw Object.assign(new Error(msg), { plain: true, status: e.status || 0, tech });
    }
  }

  /** The iptv-org index: { at, ch: [[id, name, alts, country, closed]], logo: { id: url }, guide: { id: n } }. */
  async iptvorg({ refresh = false, say = () => {}, signal } = {}) {
    this._keep();
    if (this.mem && !refresh && Date.now() - this.mem.at < WEEK) return this.mem;
    let d = refresh ? null : this._read('iptvorg.json');
    if (!d || Date.now() - d.at > WEEK || !Array.isArray(d.ch)) {
      const base = IPTVORG();
      const ch = [], logo = {}, logoScore = {}, guide = {};
      say('Downloading the iptv-org channel list…');
      await this._fetchRead(base + '/channels.json', signal, (st) => eachJsonItem(st, (o) => {
        if (!o || !o.id || !o.name) return;
        const alts = Array.isArray(o.alt_names) ? o.alt_names.filter((x) => typeof x === 'string').slice(0, 8) : [];
        ch.push([String(o.id), String(o.name), alts, cc(o.country), o.closed || o.replaced_by ? 1 : 0, o.is_nsfw ? 1 : 0]);
      }));
      say('Downloading the iptv-org logos…');
      await this._fetchRead(base + '/logos.json', signal, (st) => eachJsonItem(st, (o) => {
        if (!o || !o.channel || !o.url || !/^https?:\/\//i.test(o.url)) return;
        // The channel's main logo, as a PNG/JPEG (older TVs draw SVGs badly), a decent size and currently in use.
        const s = (o.feed ? 0 : 4) + (o.in_use === false ? 0 : 2) + (/svg/i.test(o.format || o.url) ? 0 : 2) + (Number(o.width) >= 200 ? 1 : 0) - (Array.isArray(o.tags) && o.tags.some((t) => /dark|white|light/i.test(t)) ? 1 : 0);
        if (logoScore[o.channel] === undefined || s > logoScore[o.channel]) { logoScore[o.channel] = s; logo[o.channel] = String(o.url); }
      }));
      say('Downloading the iptv-org guide list…');
      await this._fetchRead(base + '/guides.json', signal, (st) => eachJsonItem(st, (o) => { if (o && o.channel) guide[o.channel] = (guide[o.channel] || 0) + 1; }));
      d = { at: Date.now(), ch, logo, guide };
      this._write('iptvorg.json', d);
      this.log(`Guide finder: iptv-org has ${ch.length} channels, ${Object.keys(logo).length} logos`);
    }
    // Lookups: by id (lower case) and by every name variant.
    const byId = new Map(), byName = new Map();
    d.ch.forEach((c, i) => {
      byId.set(c[0].toLowerCase(), i);
      for (const n of [c[1], ...c[2]]) for (const k of nameKeys(n)) { const a = byName.get(k); if (!a) byName.set(k, [i]); else if (a.length < 12 && !a.includes(i)) a.push(i); }
    });
    this.mem = { ...d, byId, byName };
    return this.mem;
  }

  /** epg.pw's channel list for a country: { at, channels: [[id, name, icon]] } (cached for a week; [] when it has none). */
  async epgpwCountry(code, { refresh = false, signal } = {}) {
    this._keep();
    code = cc(code);
    if (!EPGPW_COUNTRIES.includes(code)) return null;
    const hit = this.epgpw.get(code);
    if (hit && !refresh && Date.now() - hit.at < WEEK) return hit;
    let d = refresh ? null : this._read(`epgpw-${code}.json`);
    if (!d || Date.now() - d.at > WEEK) {
      const chans = await this._fetchRead(this.epgpwUrl(code), signal, (st) => xmltvChannels(st));
      d = { at: Date.now(), channels: chans.map((c) => [c.id, c.names[0] || c.id, c.icon || '', c.names.slice(1, 4)]) };
      this._write(`epgpw-${code}.json`, d);
    }
    const byName = new Map();
    for (const c of d.channels) for (const n of [c[1], ...(c[3] || [])]) for (const k of nameKeys(n)) if (!byName.has(k)) byName.set(k, c);
    const v = { ...d, byName };
    this.epgpw.set(code, v);
    return v;
  }
  epgpwUrl(code) { return `${EPGPW()}/xmltv/epg_${cc(code)}.xml.gz`; }

  /**
   * Suggestions for channels. chans: [{ it, list, needGuide, needLogo }]. guides: helpers for the guides already
   * loaded: { has(id) → bool, nameOf(id) }. opts.iptvGuide: the address of the admin's own iptv-org guide server.
   */
  async suggest(chans, { guides, iptvGuide = '', say = () => {}, signal, refresh = false } = {}) {
    const db = await this.iptvorg({ refresh, say, signal });
    // Which epg.pw countries are worth a look: the countries our channels seem to be from.
    const want = new Set();
    const prelim = chans.map((x) => {
      const h = hintsOf(x.it, x.list, x.raw);
      const m = this._matchIptv(db, x.it, h);
      const country = h.strong || (m && db.ch[m.i][3]) || '';
      if (x.needGuide && country && EPGPW_COUNTRIES.includes(country)) want.add(country);
      return { x, h, m, country };
    });
    const unreachable = [];
    let problem = '';
    for (const code of want) {
      if (signal && signal.aborted) throw new Error('Stopped');
      say(`Reading the epg.pw channel list for ${COUNTRY_NAMES[code] || code}…`);
      try { await this.epgpwCountry(code, { refresh, signal }); } catch (e) {
        if (signal && signal.aborted) throw e;
        this.log(`Guide finder: epg.pw ${code}: ${e.tech || e.message}`);
        if (e.status !== 404) unreachable.push(COUNTRY_NAMES[code] || code); // (404: no guide for that country)
        if (!e.status) problem = e.message;
      }
    }
    say('Matching…');
    const out = [];
    for (const { x, h, m, country } of prelim) {
      const it = x.it;
      const s = { k: it.k, n: it.n, num: it.num || 0, g: it.g, logo0: it.logo || '', needGuide: !!x.needGuide, needLogo: !!x.needLogo, country };
      if (m) { const c = db.ch[m.i]; s.match = { id: c[0], name: c[1], country: c[3], conf: m.conf, why: m.why }; }
      // Logo: iptv-org's for the matched channel.
      if (x.needLogo && m && db.logo[db.ch[m.i][0]]) s.logo = { url: db.logo[db.ch[m.i][0]], conf: m.conf, from: 'iptv-org' };
      if (x.needGuide) {
        let g = null;
        // 1. A guide the admin already has uses the iptv-org id: just link it.
        if (m && guides.has(db.ch[m.i][0])) g = { kind: 'existing', id: db.ch[m.i][0], conf: m.conf, label: `Already in your guide “${guides.nameOf(db.ch[m.i][0]) || 'TV guide'}”` };
        // 2. epg.pw's guide for that country has a channel of that name.
        if (!g && country) {
          const pw = this.epgpw.get(country);
          if (pw) {
            const names = [it.n, it._o && it._o.n, it.tvgName, m && db.ch[m.i][1], ...(m ? db.ch[m.i][2] : [])].filter(Boolean);
            let hit = null, exact = false;
            for (const n of names) { for (const k of nameKeys(n)) { hit = pw.byName.get(k); if (hit) { exact = n === names[0] || normName(n) === normName(it.n); break; } } if (hit) break; }
            if (hit) {
              let conf = (h.strong ? 0.9 : m ? Math.min(0.88, m.conf) : 0.6) - (exact ? 0 : 0.05);
              if (!h.strong && !m) conf = 0.55;
              g = { kind: 'epgpw', id: String(hit[0]), name: String(hit[1]).replace(/^\s*\[[^\]]*\]\s*/, ''), cc: country, url: this.epgpwUrl(country), conf: Math.round(conf * 100) / 100, label: `epg.pw · ${COUNTRY_NAMES[country] || country}: ${String(hit[1]).replace(/^\s*\[[^\]]*\]\s*/, '')}` };
              if (x.needLogo && !s.logo && hit[2] && /^https?:\/\//i.test(hit[2])) s.logo = { url: hit[2], conf: g.conf, from: 'epg.pw' };
            }
          }
        }
        // 3. The admin's own iptv-org guide server (it names channels by their iptv-org id).
        if (!g && m && iptvGuide && db.guide[db.ch[m.i][0]]) g = { kind: 'iptvorg', id: db.ch[m.i][0], url: iptvGuide, conf: m.conf, label: `Your iptv-org guide: ${db.ch[m.i][0]}` };
        if (g) s.guide = g;
      }
      if (s.logo || s.guide) out.push(s);
    }
    const warnings = unreachable.length ? [`Guides from epg.pw couldn’t be read for ${unreachable.join(', ')}, so none are suggested from it. ${problem || 'Try again later.'}`] : [];
    return { at: Date.now(), checked: chans.length, items: out, countries: [...want], warnings };
  }

  /** The best iptv-org channel for one of ours: { i, conf (0–1), why } or null. */
  _matchIptv(db, it, h) {
    if (it.tvgId) {
      const i = db.byId.get(String(it.tvgId).toLowerCase().replace(/@.*$/, ''));
      if (i !== undefined) return { i, conf: 0.97, why: 'Same guide id as the playlist gives' };
    }
    const seen = new Map();
    const names = [it.n, it._o && it._o.n, it.tvgName].filter(Boolean);
    names.forEach((n, ni) => {
      for (const k of nameKeys(n)) for (const i of db.byName.get(k) || []) {
        const c = db.ch[i];
        const exact = normName(c[1]) === k;
        const sc = (exact ? 0.72 : 0.66) - ni * 0.02;
        if (!seen.has(i) || seen.get(i) < sc) seen.set(i, sc);
      }
    });
    if (!seen.size) return null;
    const langOk = (country) => { const l = this.fromCountry(country); const ls = Array.isArray(l) ? l : l ? [l] : []; return h.langs.some((x) => ls.includes(x)); };
    const scored = [...seen.entries()].map(([i, base]) => {
      const c = db.ch[i];
      let s = base, why = 'Same name';
      if (h.strong) { if (c[3] === h.strong) { s += 0.24; why += `, same country (${c[3]})`; } else s -= 0.3; }
      else if (h.langs.length && c[3]) { if (langOk(c[3])) { s += 0.08; why += ', same language'; } else s -= 0.1; }
      if (c[4]) s -= 0.12; // closed
      if (c[5] && !it.adult) s -= 0.2;
      return { i, s, why };
    }).sort((a, b) => b.s - a.s);
    const best = scored[0];
    if (scored.length === 1 && !h.strong) { best.s += 0.12; best.why += ', the only channel of that name'; }
    else if (scored[1] && scored[1].s > best.s - 0.05) { best.s -= 0.15; best.why += ', but there are others of that name'; }
    const conf = Math.max(0.05, Math.min(0.96, best.s));
    return { i: best.i, conf: Math.round(conf * 100) / 100, why: best.why };
  }
}

module.exports = { PublicDb, eachJsonItem, xmltvChannels, nameKeys, hintsOf, EPGPW_COUNTRIES, COUNTRY_NAMES };
