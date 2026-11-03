'use strict';
/**
 * Picture subtitles (PGS, VobSub, DVB) that the player draws itself: the index of a track and its packets.
 * Registered from server.js with one line ([routes:p6]). See lib/picsubs.js.
 */
const fs = require('fs');
const path = require('path');
const { PicSubs, TsSubs } = require('./picsubs');
const { HttpError, clampInt, sendText } = require('./util');
const L = require('./langs');
const { srtToVtt, decodeText } = require('./subtitles');

/**
 * A subtitle file next to a video ("Film.en.srt", "Film.French.forced.srt", "Film.eng.sdh.srt"):
 * { lang, label } from what follows the video's name.
 */
function sidecarInfo(file, video) {
  const base = path.basename(video, path.extname(video));
  const ext = path.extname(file).slice(1).toLowerCase();
  const mid = path.basename(file).slice(base.length).replace(/\.(srt|vtt|ass|ssa)$/i, '');
  const words = mid.split(/[.\s_()[\]-]+/).filter(Boolean);
  let lang = '';
  const flags = [];
  for (const w of words) {
    const lw = w.toLowerCase();
    if (lw === 'forced') { flags.push('forced'); continue; }
    if (lw === 'sdh' || lw === 'cc' || (lw === 'hi' && words.length > 1)) { flags.push('SDH'); continue; }
    if (!lang && /^[a-z]{2,3}(-[a-z]{2})?$|^[a-zà-ÿ]{4,}$/i.test(w)) { const c = L.code(w); if (c && c !== 'mul') lang = c; }
  }
  const name = lang ? (L.names[lang] || lang.toUpperCase()) : (words.join(' ') || 'Subtitles');
  return { lang, forced: flags.includes('forced'), label: `${name}${flags.filter((f) => f !== 'forced').map((f) => ` (${f})`).join('')} · .${ext}` };
}

/** ASS/SSA → WebVTT (the dialogue lines; styling and positions left out). */
function assToVtt(text) {
  const t = (x) => { const m = /^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(x.trim()); if (!m) return null; const ms = String(m[4]).padEnd(3, '0'); return `${String(m[1]).padStart(2, '0')}:${m[2].padStart(2, '0')}:${m[3].padStart(2, '0')}.${ms}`; };
  let fields = null;
  const cues = [];
  for (const line of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^Format:/i.test(line) && !fields) fields = line.slice(7).split(',').map((f) => f.trim().toLowerCase());
    const m = /^Dialogue:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const f = fields || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const parts = m[1].split(',');
    const rec = {};
    f.forEach((k, i) => { rec[k] = i === f.length - 1 ? parts.slice(i).join(',') : parts[i]; });
    const a = t(rec.start || ''), b = t(rec.end || '');
    const body = String(rec.text || '').replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ').replace(/</g, '&lt;').trim();
    if (a && b && body) cues.push({ a, b, body });
  }
  cues.sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : 0));
  return 'WEBVTT\n\n' + cues.map((c) => `${c.a} --> ${c.b}\n${c.body}`).join('\n\n') + '\n';
}
/** Moves every cue of a WebVTT text by -off seconds (the server converting from part-way through). */
function shiftBack(vtt, off) {
  const shift = (h, m, sec) => {
    const ms = Math.max(0, Math.round(((+h) * 3600 + (+m) * 60 + parseFloat(sec) - off) * 1000));
    const z = (n, l = 2) => String(n).padStart(l, '0');
    return `${z(Math.floor(ms / 3600000))}:${z(Math.floor(ms / 60000) % 60)}:${z(Math.floor(ms / 1000) % 60)}.${z(ms % 1000, 3)}`;
  };
  return vtt.replace(/(?:(\d+):)?(\d{2}):(\d{2}[.,]\d{3})/g, (x, h, m, sec) => shift(h || 0, m, sec.replace(',', '.')));
}

/** deps: { route, item, inputOf, connLimit, media, lists } */
module.exports = function p6(deps) {
  const { route, item, inputOf, connLimit, media, lists } = deps;
  const pics = new PicSubs(media, path.join(media.cacheDir, 'subs'));
  // Shutting down or restarting stops the server's ffmpeg jobs: the subtitle extractions too (they'd keep running,
  // and keep their provider connection, after the server is gone).
  const stopAll = media.stopAll && media.stopAll.bind(media);
  if (stopAll) media.stopAll = (...a) => { try { pics.stopAll(); } catch {} return stopAll(...a); };

  const source = (ctx, k, q) => {
    const it = item(ctx, k);
    const alt = clampInt(q.get('alt'), -1, 99, -1);
    const src = inputOf(it, alt);
    if (!src) throw new HttpError(404, 'Not found');
    return { it, alt, src };
  };

  // The index: when each subtitle shows and where its packet is. Starts copying the tracks out of the file if needed;
  // the player asks again (from=how many it has) until done.
  route('GET', '/api/picsubs/:k/:track', async (req, res, p, q, ctx) => {
    const { it, alt, src } = source(ctx, p.k, q);
    const track = clampInt(p.track, 0, 99, 0);
    let tracks = null;
    if (!pics.known(src.input)) {
      if (!media.available) throw new HttpError(501, 'Picture subtitles need ffmpeg on the server.');
      // Reading the file is a second connection to the provider: never on accounts that allow only one.
      if (connLimit(it, alt) === 1) throw new HttpError(409, 'The provider allows only one connection at a time, so subtitles inside the file can’t be read while you watch.');
      const pr = await media.probe(src.input, { headers: src.headers });
      if (!pr) throw new HttpError(502, 'Couldn’t read the stream');
      tracks = pr.subs.filter((s) => s.pic).map((s) => ({ i: s.i, codec: s.codec }));
      if (!tracks.some((s) => s.i === track)) throw new HttpError(404, 'That isn’t a picture subtitle track.');
    }
    const out = pics.index(src.input, src.headers, tracks, track, clampInt(q.get('from'), 0, 1e7, 0));
    if (!out) throw new HttpError(404, 'That isn’t a picture subtitle track.');
    return out;
  });

  // Packet bytes: o = offset, n = length (as the index lists them; several neighbours can be asked for at once).
  route('GET', '/api/picsubs/:k/:track/data', (req, res, p, q, ctx) => {
    const { src } = source(ctx, p.k, q);
    const buf = pics.read(src.input, clampInt(p.track, 0, 99, 0), clampInt(q.get('o'), 0, 2 ** 40, 0), clampInt(q.get('n'), 0, 16 << 20, 0));
    if (!buf) throw new HttpError(404, 'Not ready');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=3600' });
    res.end(buf);
  });

  // Live conversions: DVB and teletext subtitle streams are copied (not converted) by the same ffmpeg into one more
  // file next to the video; only from what the server already knows about the stream (no new connection).
  const LIVE_SUBS = new Set(['dvb_subtitle', 'dvb_teletext']);
  const aside = new Map(); // session folder → TsSubs
  media.sessionOutputs = async ({ input, headers, dir }) => {
    if (!media.probeCached(input, headers || {})) return [];
    const pr = await media.probe(input, { headers: headers || {} });
    const subs = (pr && pr.subs || []).filter((s) => LIVE_SUBS.has(s.codec));
    if (!subs.length) return [];
    const file = path.join(dir, 'subs.ts');
    aside.set(dir, new TsSubs(file));
    return [...subs.flatMap((s) => ['-map', `0:s:${s.i}`]), '-c:s', 'copy', '-flush_packets', '1', '-f', 'mpegts', file]; // (written out as they come, not in 32 KB blocks)
  };
  const sweep = setInterval(() => { for (const dir of aside.keys()) if (!fs.existsSync(dir)) aside.delete(dir); }, 60e3);
  sweep.unref();
  route('GET', '/api/sessionsubs/:sid', (req, res, p, q) => {
    const s = media.touch(p.sid);
    if (!s) throw new HttpError(410, 'Playback session ended');
    const ts = aside.get(s.dir);
    if (!ts) return { none: true };
    return ts.since(clampInt(q.get('from'), 0, 1e9, 0));
  });

  // Subtitle files next to a video in a media folder ("Film.en.srt"…): listed for the player, served as WebVTT.
  const sidecars = (ctx, k) => {
    const it = item(ctx, k);
    const li = it.loc && lists && lists.libraryItem(it.loc.list, it.loc.id);
    return li ? (li.subs || []).filter((s) => s && s.path && fs.existsSync(s.path)).map((s, n) => ({ n, path: s.path, ...sidecarInfo(s.path, li.path) })) : [];
  };
  route('GET', '/api/sidesubs/:k', (req, res, p, q, ctx) => sidecars(ctx, p.k).map((s) => ({ n: s.n, lang: s.lang, label: s.label, forced: s.forced })));
  route('GET', '/api/sidesubs/:k/:n', (req, res, p, q, ctx) => {
    const s = sidecars(ctx, p.k)[clampInt(p.n, 0, 999, 0)];
    if (!s) throw new HttpError(404, 'Not found');
    const st = fs.statSync(s.path);
    if (st.size > 20 << 20) throw new HttpError(413, 'That subtitle file is too big.');
    const text = decodeText(fs.readFileSync(s.path));
    let vtt = /\.(ass|ssa)$/i.test(s.path) ? assToVtt(text) : srtToVtt(text);
    const off = Number(q.get('offset')) || 0;
    if (off > 0) vtt = vtt.split('\n').map((l) => (/-->/.test(l) ? shiftBack(l, off) : l)).join('\n');
    sendText(res, 200, vtt, 'text/vtt; charset=utf-8');
  });

  return { pics };
};
module.exports.sidecarInfo = sidecarInfo;
module.exports.assToVtt = assToVtt;
