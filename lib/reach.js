'use strict';
const { fetchAny } = require('./net');
const { HttpError } = require('./util');

/**
 * "Can the viewer's browser fetch this stream itself, and how?"
 *
 * A browser only refuses a stream when the *page's JavaScript* reads the bytes (hls.js, mpegts.js, Shaka) and the
 * provider's answer lacks Access-Control-Allow-Origin. So the server asks the provider the same question the
 * browser would (same Origin header, redirects followed hop by hop, since every hop is checked)
 * and reports what will work:
 *
 *   mse    the provider allows web players → the browser plays it directly with full controls
 *   url    the address to use directly (may be an https copy, or the end of a redirect chain)
 *   split  (HLS) the playlists are blocked but the video segments aren't → the server hands over only the
 *          tiny playlist text and the browser fetches all the video straight from the provider
 *   alt    an HLS version of a raw MPEG-TS channel (Xtream Codes panels serve both), which the browser's own player
 *          and the split mode can use
 *
 * The browser's built-in player (`<video src>`) needs no permission at all: MP4/WebM files everywhere, and HLS on
 * Safari, iPhone/iPad, Android and most smart TVs. The page decides that part, since only it knows its own player.
 *
 * Results are cached per provider host, so zapping doesn't probe every channel (and doesn't use up connections on
 * accounts that only allow one or two at a time).
 */

const HOUR = 3600e3;

/** What kind of stream a response is, from its type and first bytes. */
function classify(ct, bytes) {
  ct = (ct || '').toLowerCase();
  const head = bytes.slice(0, 16).toString('latin1');
  const text = bytes.slice(0, 400).toString('latin1');
  if (ct.includes('dash+xml') || /<MPD[\s>]/.test(text)) return 'dash';
  if (ct.includes('mpegurl') || head.replace(/^﻿|^ï»¿/, '').trimStart().startsWith('#EXTM3U')) return 'hls';
  if (bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47)) return 'ts';
  if (bytes.slice(4, 8).toString('latin1') === 'ftyp') return 'native';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return ct.includes('webm') ? 'native' : 'ffmpeg';
  if (/^(audio\/|video\/(mp4|webm|ogg))/.test(ct)) return 'native';
  if (ct.includes('mp2t') || ct.includes('mpeg')) return 'ts';
  return 'ffmpeg';
}

/** Kind from the address alone, when the extension says. */
function kindOfUrl(url) {
  const e = ((url.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1] || '').toLowerCase();
  if (e === 'm3u8' || e === 'm3u') return 'hls';
  if (e === 'mpd') return 'dash';
  if (['ts', 'mts', 'm2ts'].includes(e)) return 'ts';
  if (['mp4', 'm4v', 'webm', 'mov', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav'].includes(e)) return 'native';
  if (['mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'vob', 'divx'].includes(e)) return 'ffmpeg';
  return '';
}

/**
 * The HLS address of an Xtream-Codes-style live channel:
 *   http://host:port/user/pass/123   http://host:port/live/user/pass/123.ts   →   http://host:port/live/user/pass/123.m3u8
 */
function xtreamHls(url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  const m = u.pathname.match(/^(.*?)\/(?:live\/)?([^/]+)\/([^/]+)\/(\d+)(?:\.ts)?$/);
  if (!m || m[2] === 'movie' || m[2] === 'series') return '';
  u.pathname = `${m[1]}/live/${m[2]}/${m[3]}/${m[4]}.m3u8`;
  return u.href;
}

/** The https copy of an http address (only when it uses the default port, so https would too). */
function httpsCopy(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' || (u.port && u.port !== '80')) return '';
    u.protocol = 'https:'; u.port = '';
    return u.href;
  } catch { return ''; }
}

function allows(res, sent, origin) {
  const a = (res.headers.get('access-control-allow-origin') || '').trim();
  return a === '*' || a === sent || a === origin;
}

const cancel = (res) => { try { if (res && res.body) res.body.cancel().catch(() => {}); } catch {} };
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const abs = (u, base) => { try { return new URL(u, base).href; } catch { return ''; } };

class Reach {
  constructor(proxy) {
    this.proxy = proxy;
    this.hosts = new Map(); // `${origin}|${host}|${kind}` → { facts, t }
    this.urls = new Map(); // url → { kind, finite, t }
  }

  /**
   * GET the address the way a browser at `origin` would: follow redirects one hop at a time and note whether every
   * hop allows the page (after a redirect to another site the browser sends "Origin: null").
   */
  async open(url, headers, origin, signal) {
    let cur = url, sent = origin, chain = true;
    for (let hop = 0; hop < 8; hop++) {
      const res = await fetchAny(cur, { headers: { ...headers, Origin: sent }, signal, redirect: 'manual' });
      const ok = allows(res, sent, origin);
      const loc = res.status >= 300 && res.status < 400 && res.headers.get('location');
      if (loc) {
        if (!ok) chain = false;
        cancel(res);
        const next = abs(loc, cur);
        if (!next) throw new HttpError(502, 'The stream server sent a broken redirect');
        if (new URL(next).origin !== new URL(cur).origin) sent = 'null';
        cur = next;
        continue;
      }
      if (!ok) chain = false;
      // `last`: the final address on its own allows the page (so handing the browser that address works).
      return { res, final: cur, chain, last: ok, redirected: hop > 0 };
    }
    throw new HttpError(502, 'The stream server redirected too many times');
  }

  async firstBytes(res, n = 400) {
    const reader = res.body.getReader();
    let bytes = Buffer.alloc(0);
    try {
      while (bytes.length < n) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes = Buffer.concat([bytes, Buffer.from(value)]);
      }
    } finally { reader.cancel().catch(() => {}); }
    return bytes;
  }

  /** HLS: is the playlist chain allowed, and are the video segments allowed? */
  async hlsFacts(o, headers, origin, signal) {
    const text = (await o.res.text()).slice(0, 2e6);
    if (!text.trimStart().replace(/^﻿/, '').startsWith('#EXTM3U')) return { kind: 'ffmpeg' };
    let base = o.final, body = text, playlists = true;
    if (/#EXT-X-STREAM-INF/i.test(text)) {
      const ls = lines(text);
      const i = ls.findIndex((l) => /^#EXT-X-STREAM-INF/i.test(l));
      const v = ls.slice(i + 1).find((l) => !l.startsWith('#'));
      if (v) {
        const o2 = await this.open(abs(v, base), headers, origin, signal);
        if (!o2.res.ok) { cancel(o2.res); return { kind: 'hls', playlists: false, segments: null }; }
        playlists = o2.chain;
        base = o2.final; body = await o2.res.text();
      }
    }
    const ls = lines(body);
    const map = (body.match(/#EXT-X-MAP:[^\n]*URI="([^"]+)"/i) || [])[1];
    const seg = map || ls.find((l) => !l.startsWith('#'));
    let segments = null;
    if (seg) {
      const o3 = await this.open(abs(seg, base), headers, origin, signal);
      segments = o3.res.ok || o3.res.status === 206 ? o3.chain : null;
      cancel(o3.res);
    }
    return { kind: 'hls', playlists, segments };
  }

  /** Probe one address. */
  async probe(url, headers, origin, signal) {
    const o = await this.open(url, headers, origin, signal);
    if (!o.res.ok) { cancel(o.res); throw new HttpError(502, `The stream server answered HTTP ${o.res.status}`); }
    const ct = o.res.headers.get('content-type') || '';
    let kind = kindOfUrl(url);
    let finite = Number(o.res.headers.get('content-length')) > 0 || o.res.headers.get('accept-ranges') === 'bytes';
    const looksHls = kind === 'hls' || /mpegurl/i.test(ct);
    if (looksHls) {
      const f = await this.hlsFacts(o, headers, origin, signal);
      if (f.kind !== 'hls') return { kind: 'ffmpeg', finite: false, mse: false };
      const mse = o.chain && f.playlists && f.segments !== false;
      // The redirect hops refused but the final playlist allows us: give the browser the final address.
      const viaFinal = !mse && o.redirected && o.last && f.playlists && f.segments !== false;
      return { kind: 'hls', finite: false, mse: mse || viaFinal, url: viaFinal ? o.final : url, split: f.segments === true };
    }
    const bytes = await this.firstBytes(o.res);
    if (!kind) kind = classify(ct, bytes);
    if (kind === 'hls') {
      // No extension and no playlist content type, but it is one: read it properly.
      const o2 = await this.open(url, headers, origin, signal);
      if (!o2.res.ok) { cancel(o2.res); return { kind: 'hls', finite: false, mse: false }; }
      const f = await this.hlsFacts(o2, headers, origin, signal);
      const mse = o2.chain && f.playlists && f.segments !== false;
      return { kind: 'hls', finite: false, mse, url, split: f.segments === true };
    }
    finite = finite && kind !== 'ts';
    const viaFinal = !o.chain && o.redirected && o.last && kind !== 'ts'; // live TS redirect tokens are often single-use
    return { kind, finite, mse: o.chain || viaFinal, url: viaFinal ? o.final : url };
  }

  /**
   * Everything the page needs to choose a direct route.
   * hdr: the stream's own headers from the playlist. origin/ua: the viewer's page origin and browser.
   */
  async check(url, hdr, origin, ua, { limit = 0, formats = [], mixedOk = false } = {}) {
    origin = String(origin || '').slice(0, 200);
    const out = { kind: kindOfUrl(url), finite: false, url, mse: false, split: false, splitUrl: '', alt: null, blocked: '' };
    // Servers set CORS per site and usually per path section (e.g. /live/ vs /movie/), so remember it per both.
    let host;
    try { const uu = new URL(url); host = uu.host + '/' + (uu.pathname.split('/')[1] || ''); } catch { throw new HttpError(400, 'Not a web address'); }

    // Streams that list special headers (User-Agent, Referer, cookies): browsers can't send those. Many providers
    // don't actually check, so try once without them before giving up on going direct.
    const custom = hdr && ((hdr.h && Object.keys(hdr.h).length) || hdr.ua || hdr.ref);
    const browserish = { 'User-Agent': ua || this.proxy.getSettings().userAgent, Accept: '*/*', Referer: origin + '/' };
    // (Unless this browser lets the page load http addresses — "Insecure content: Allow" for the site.)
    let mixed = /^https:/i.test(origin) && /^http:/i.test(url) && !mixedOk;

    // Files the browser's own player handles (MP4/WebM/audio) need no permission, and MKV/AVI go to the converter:
    // nothing to ask the provider (which also saves a connection on accounts that allow only one).
    if (!custom && !mixed && (out.kind === 'native' || out.kind === 'ffmpeg')) { out.finite = true; return out; }

    const key = `${origin}|${host}|${out.kind || '?'}`;
    const hit = this.hosts.get(key);
    const known = hit && Date.now() - hit.t < (hit.facts.mse || hit.facts.split ? 6 * HOUR : HOUR);
    const urlHit = this.urls.get(url);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12000);
    try {
      if (known && out.kind && !hit.facts.redirects) {
        Object.assign(out, { mse: hit.facts.mse, split: hit.facts.split, kind: hit.facts.kind, finite: hit.facts.finite }, { url: hit.facts.https ? httpsCopy(url) : url });
      } else if (known && !hit.facts.redirects && ((urlHit && Date.now() - urlHit.t < HOUR) || hit.facts.kind)) {
        // Addresses without an extension (typical for Xtream: /user/pass/123): channels in the same section of the
        // same provider are the same kind, so don't open a connection per channel just to look (accounts often
        // allow only one or two at a time).
        const k = urlHit && Date.now() - urlHit.t < HOUR ? urlHit : hit.facts;
        Object.assign(out, { mse: hit.facts.mse, split: hit.facts.split }, { kind: k.kind, finite: k.finite, url: hit.facts.https ? httpsCopy(url) : url });
      } else {
        let target = url, https = false;
        if (mixed) {
          // An https page can't load http video at all. Many providers answer on https too.
          const h = httpsCopy(url);
          if (h) {
            try { await this.probe(h, browserish, origin, ac.signal); target = h; https = true; mixed = false; } catch {}
          }
        }
        if (mixed) { out.blocked = 'mixed'; return out; }
        let r;
        try {
          r = await this.probe(target, browserish, origin, ac.signal);
          // One-connection accounts: give the provider a moment to free the slot the check used.
          if (limit === 1) await new Promise((ok) => setTimeout(ok, 1500));
        } catch (e) {
          if (!custom) throw e;
          out.blocked = 'headers';
          return out;
        }
        Object.assign(out, r);
        if (!r.url) out.url = target;
        this.urls.set(url, { kind: r.kind, finite: r.finite, t: Date.now() });
        this.hosts.set(`${origin}|${host}|${kindOfUrl(url) || '?'}`, { t: Date.now(), facts: { mse: r.mse, split: !!r.split, https, redirects: r.url && r.url !== target, kind: r.kind, finite: r.finite } });
      }

      if (out.kind === 'hls' && out.split) out.splitUrl = this.proxy.sign(out.url, { split: true });

      // A raw MPEG-TS channel the browser isn't allowed to read: see if the provider also serves it as HLS.
      if (out.kind === 'ts' && !out.mse) {
        const alt = xtreamHls(out.url);
        const declared = formats.map((f) => String(f).toLowerCase()).includes('m3u8');
        if (alt && (declared || limit === 1)) {
          // The account says which formats it serves; don't open a test connection to find out.
          if (declared) out.alt = { kind: 'hls', url: alt, mse: false, split: false, splitUrl: '' };
        } else if (alt) {
          const akey = `${origin}|${host}|xt`;
          const ah = this.hosts.get(akey);
          if (ah && Date.now() - ah.t < 6 * HOUR) {
            if (ah.facts) out.alt = { kind: 'hls', url: alt, mse: ah.facts.mse, split: ah.facts.split, splitUrl: ah.facts.split ? this.proxy.sign(alt, { split: true }) : '' };
          } else {
            try {
              const r = await this.probe(alt, browserish, origin, ac.signal);
              const facts = r.kind === 'hls' ? { mse: r.mse && r.url === alt, split: !!r.split } : null;
              this.hosts.set(akey, { t: Date.now(), facts });
              if (facts) out.alt = { kind: 'hls', url: alt, mse: facts.mse, split: facts.split, splitUrl: facts.split ? this.proxy.sign(alt, { split: true }) : '' };
            } catch { this.hosts.set(akey, { t: Date.now(), facts: null }); }
          }
        }
      }
      return out;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `Could not reach the stream: ${err.name === 'AbortError' ? 'timed out' : ((err.cause && err.cause.message) || err.message)}`);
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
  }

  /** The page found that a route the server recommended didn't work: forget what we knew about that host. */
  forget(url, origin) {
    let host = '';
    try { const uu = new URL(url); host = uu.host + '/' + (uu.pathname.split('/')[1] || ''); } catch { return; }
    for (const k of this.hosts.keys()) if (k.startsWith(`${origin}|${host}|`)) this.hosts.delete(k);
    this.urls.delete(url);
  }
}

module.exports = { Reach, classify, kindOfUrl, xtreamHls, httpsCopy };
