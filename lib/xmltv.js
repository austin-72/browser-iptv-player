'use strict';
const zlib = require('zlib');
const { PassThrough } = require('stream');

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

const reCache = new Map();
const re = (key, src, flags) => {
  let r = reCache.get(key);
  if (!r) { r = new RegExp(src, flags); reCache.set(key, r); }
  r.lastIndex = 0;
  return r;
};

function attr(tag, name) {
  const m = tag.match(re('a:' + name, `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return m ? decode(m[1] ?? m[2]) : '';
}

function inner(s) {
  const cdata = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return decode(s.replace(/<[^>]+>/g, '')).trim();
}

function elements(xml, tag) {
  const out = [];
  const r = re('e:' + tag, `<${tag}(\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  let m;
  while ((m = r.exec(xml))) out.push({ attrs: m[1] || '', text: m[2] !== undefined ? inner(m[2]) : '' });
  return out;
}

// "20261028140000 +0000" -> epoch ms (also "+05:30": some guides put a colon in the offset)
function parseTime(s) {
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*([+-])?(\d{2})?:?(\d{2})?/);
  if (!m) return NaN;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if (m[7]) t -= (m[7] === '-' ? -1 : 1) * ((+m[8] || 0) * 60 + (+m[9] || 0)) * 60000;
  return t;
}

function episodeLabel(eps) {
  const onscreen = eps.find((e) => /onscreen/.test(e.attrs));
  if (onscreen) return onscreen.text;
  const ns = eps.find((e) => /xmltv_ns/.test(e.attrs));
  if (ns) {
    const [s, e] = ns.text.split('.').map((p) => parseInt(p.split('/')[0], 10));
    const parts = [];
    if (!Number.isNaN(s)) parts.push('S' + String(s + 1).padStart(2, '0'));
    if (!Number.isNaN(e)) parts.push('E' + String(e + 1).padStart(2, '0'));
    return parts.join('');
  }
  return '';
}

// A copy of a piece of text that doesn't hold on to the text it was cut from. (Titles and descriptions cut out of the
// download kept every downloaded chunk alive: a guide's listings took several times the memory they need.)
const own = (s) => (' ' + s).slice(1);

function parseChannel(xml) {
  const open = xml.slice(0, xml.indexOf('>') + 1);
  const id = attr(open, 'id');
  if (!id) return null;
  const icon = xml.match(/<icon\s[^>]*src\s*=\s*"([^"]*)"/);
  return { id, names: elements(xml, 'display-name').map((e) => e.text).filter(Boolean).map(own), icon: icon ? own(decode(icon[1])) : '' };
}

/** { ch, p }: the channel id is kept out of the programme (deleting it afterwards made every programme a slow, big object). */
function parseProgramme(xml) {
  const open = xml.slice(0, xml.indexOf('>') + 1);
  const ch = attr(open, 'channel');
  const p = {
    s: parseTime(attr(open, 'start')),
    e: parseTime(attr(open, 'stop')),
  };
  if (!ch || Number.isNaN(p.s)) return null;
  const pick = (tag) => (elements(xml, tag)[0] || {}).text || '';
  p.t = own(pick('title') || 'Untitled');
  const st = pick('sub-title'); if (st) p.st = own(st);
  const d = pick('desc'); if (d) p.d = own(d);
  const cats = elements(xml, 'category').map((c) => c.text).filter(Boolean); if (cats.length) p.c = cats.slice(0, 3).map(own);
  const ep = episodeLabel(elements(xml, 'episode-num')); if (ep) p.ep = own(ep);
  const icon = xml.match(/<icon\s[^>]*src\s*=\s*"([^"]*)"/); if (icon) p.ic = own(decode(icon[1]));
  if (/<new\s*\/?>/.test(xml)) p.n = 1;
  const rating = xml.match(/<rating[^>]*>\s*<value>([^<]*)<\/value>/); if (rating) p.r = own(decode(rating[1]).trim());
  return { ch, p };
}

/** Wraps a byte stream and transparently gunzips it if it starts with the gzip magic bytes. */
function autoGunzip(src) {
  const out = new PassThrough();
  let started = false;
  let head = null; // the first bytes, until there are two to tell gzip by (a first chunk of one byte was read as plain)
  const start = (first) => {
    started = true;
    src.removeListener('data', onData);
    src.pause();
    let target = out;
    if (typeof first !== 'string' && first[0] === 0x1f && first[1] === 0x8b) {
      target = zlib.createGunzip();
      target.on('error', (e) => out.destroy(e));
      target.pipe(out);
    }
    target.write(first);
    src.pipe(target);
    src.resume();
  };
  const onData = (chunk) => {
    if (typeof chunk === 'string') return start(chunk);
    head = head ? Buffer.concat([head, chunk]) : chunk;
    if (head.length >= 2) start(head);
  };
  src.on('data', onData);
  src.once('end', () => { if (!started) out.end(head || undefined); });
  src.on('error', (e) => out.destroy(e));
  // Reading stopped (a broken gzip, an error, or the reader gave up): let the download go too — it used to stay paused,
  // holding the provider's connection open.
  out.once('close', () => { if (!src.destroyed && !src.readableEnded) src.destroy(); });
  return out;
}

/**
 * Streams an XMLTV document and returns { channels, programmes } restricted to [from, to].
 * Memory stays bounded because elements are parsed as soon as they are complete.
 */
const TRUNCATED = Symbol.for('biptv.guideTruncated');
const MAX_ELEMENT = 4 << 20; // one <channel> or <programme> is never anywhere near this big
async function parseXMLTV(stream, { from = -Infinity, to = Infinity } = {}) {
  const channels = {};
  const programmes = {};
  let total = 0;
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let sawRoot = false;

  const handle = (kind, xml) => {
    if (kind === 'channel') {
      const c = parseChannel(xml);
      if (c) channels[c.id] = { names: c.names, icon: c.icon };
    } else {
      const r = parseProgramme(xml);
      if (!r) return;
      const { ch, p } = r;
      if (Number.isNaN(p.e)) p.e = p.s + 30 * 60000;
      if (p.e < from || p.s > to) return;
      (programmes[ch] || (programmes[ch] = [])).push(p);
      total++;
    }
  };

  const drain = () => {
    let pos = 0;
    // Remember where the next tag of each kind is, so each buffer is scanned only once per kind.
    let ci = buf.indexOf('<channel');
    let pi = buf.indexOf('<programme');
    for (;;) {
      if (ci !== -1 && ci < pos) ci = buf.indexOf('<channel', pos);
      if (pi !== -1 && pi < pos) pi = buf.indexOf('<programme', pos);
      let i; let kind;
      if (ci === -1 && pi === -1) break;
      if (pi === -1 || (ci !== -1 && ci < pi)) { i = ci; kind = 'channel'; } else { i = pi; kind = 'programme'; }
      const after = buf[i + kind.length + 1];
      if (after === undefined) { pos = i; break; }
      if (!/[\s>/]/.test(after)) { pos = i + 1; continue; }
      const openEnd = buf.indexOf('>', i);
      if (openEnd === -1) { pos = i; break; }
      let end;
      if (buf[openEnd - 1] === '/') end = openEnd + 1;
      else {
        const close = buf.indexOf(`</${kind}>`, openEnd);
        if (close === -1) {
          // Never closed (a broken guide): don't wait for it forever — the buffer would grow until it fails ("Invalid
          // string length", after reading hundreds of MB). Once a few MB have come after it, skip it.
          if (buf.length - i > MAX_ELEMENT) { pos = i + 1; continue; }
          pos = i; break;
        }
        end = close + kind.length + 3;
      }
      handle(kind, buf.slice(i, end));
      pos = end;
    }
    buf = buf.slice(pos);
    // Nothing useful is pending and the buffer is just whitespace/preamble: keep only a small tail.
    if (buf.length > 1 << 20 && buf.indexOf('<channel') === -1 && buf.indexOf('<programme') === -1) {
      buf = buf.slice(-64);
    }
    // (Still big: whatever is pending isn't a guide element that will finish; keep the tail only.)
    if (buf.length > 2 * MAX_ELEMENT) buf = buf.slice(-MAX_ELEMENT);
  };

  for await (const chunk of autoGunzip(stream)) {
    buf += decoder.decode(chunk, { stream: true });
    if (!sawRoot && buf.includes('<tv')) sawRoot = true;
    drain();
  }
  buf += decoder.decode();
  drain();
  // (Whatever is left after the last element ends with </tv> in a whole document: without it the download stopped early.)
  const truncated = !/<\/tv\s*>/.test(buf);

  if (!sawRoot && !Object.keys(channels).length && !total) {
    throw new Error('Not a valid XMLTV file (no <tv> element found)');
  }
  // (An empty <tv></tv> — a provider having a bad moment — would replace a good guide with nothing: keep the last one.)
  if (!Object.keys(channels).length && !total) throw new Error('The guide is empty (no channels or programmes in it)');
  for (const list of Object.values(programmes)) list.sort((a, b) => a.s - b.s);
  // A guide cut short is still read, but marked (where it's kept, lib/epg.js, a much smaller one doesn't replace a whole
  // one). The mark goes on the programmes too: they're handed on without the rest of this.
  if (truncated) Object.defineProperty(programmes, TRUNCATED, { value: true });
  return { channels, programmes, programmeCount: total, truncated };
}

const xmlEsc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}

module.exports = { parseXMLTV, parseTime, xmlEsc, fmtTime, autoGunzip, TRUNCATED };
