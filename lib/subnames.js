'use strict';
/**
 * What a subtitle found online is, read from the mess it is listed under.
 *
 * The sites list subtitles by the name of the pirated copy they were timed for ("Show.S02E05.720p.BluRay.x264-GRP"),
 * with a free-text comment from whoever uploaded it and a few tick-boxes that are often wrong. What a viewer needs to
 * know is in there, but in code:
 *
 *   kind     full      every spoken line
 *            sdh       every spoken line, plus sounds and who is speaking ("[door slams]", "MAN:") — written for the
 *                      deaf and hard of hearing. Sites call it SDH, HI, "hearing impaired" or CC.
 *            foreign   only the lines spoken in ANOTHER language than the film's own (and signs on screen) — "forced"
 *                      or "foreign parts only". For a film in English with some Spanish in it, these translate just
 *                      the Spanish. A handful of lines in the whole film: right if that is all you want, and it looks
 *                      like broken subtitles if you wanted everything.
 *   src      the kind of copy it was timed for: Blu-ray, streaming, TV broadcast, DVD, a recording made in a cinema.
 *            Copies of one kind are nearly always timed alike; a TV broadcast and a Blu-ray of the same episode often
 *            differ (a "previously on" recap, breaks cut out).
 *   fps      frames a second of that copy. 25 means a European TV/DVD copy, which plays 4 % faster than a film copy
 *            (23.976): on the wrong one the subtitles drift further out the longer it plays.
 *   cut      Extended, Director's cut, Unrated …: a different edit of the film, with scenes added or removed.
 *   runtime  how long the uploader says their copy is, when they say.
 *   part     one disc of a film split over two ("CD2"): starts at 0 again halfway through.
 *   notes    retail (copied from the official disc or stream), OCR (read from the disc's picture subtitles by a
 *            program: small typos, l for I), resynced (someone else's text retimed), machine translated.
 *
 * Tick-boxes lose to words: SubDL's "hearing impaired" box is set on files whose comment says "removed HI", and
 * OpenSubtitles' "foreign parts only" on files that say "Full subs only. Not forced."
 */
const { episodeOfName, namesOtherEpisode } = require('./subcheck');

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const decodeEntities = (s) => String(s || '').replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, '\'');

// ---------------------------------------------------------------- tidying what is shown
const URLISH = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]{3,}\.(?:com|net|org|info|cc|vn|ro|ru|to|tv|me|io|ly|mx|ag|se|nl|pl|co)(?:\/\S*)?(?![a-z0-9.])/gi;
// (Release names are full of dots — "x264.NonHI.cc.en" — so only the plainest addresses are taken out of those.)
const URL_IN_NAME = /\b(?:https?:\/\/|www\.)\S+|\(?\b[a-z0-9-]{4,}\.(?:com|net|org)\b\)?/gi;
/** A release name, without the site's own prefix, web addresses, file endings and decoration. '' when nothing is left. */
function cleanRelease(name) {
  let s = decodeEntities(name).replace(/^\s*SUBDL(?:\.com)?::/i, '').replace(/^https?www\S*$/i, '');
  s = s.replace(URL_IN_NAME, ' ').replace(/\.(zip|rar|srt|vtt|ass|ssa|sub|mkv|mp4|avi)\b/gi, ' ');
  // (Decoration: "-={SPARROW}=-", "© P@rM!NdeR ™", hearts.)
  s = s.replace(/[^\p{L}\p{N} .,_\-+()[\]'&:!/]/gu, ' ').replace(/[-=]{2,}/g, ' ').replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s.,_\-:]+|[\s.,_\-:]+$/g, '');
  if (!/[\p{L}]{2}/u.test(s)) return '';
  return s.length > 90 ? s.slice(0, 88).trimEnd() + '…' : s;
}
const BEGGING = [/imported from\s*\S*/i, /don.?t forget to (rate|comment)[^.!]*[.!]*/i, /\b(plz|pls|please)[^.!]*\b(rate|comment|vote)\b[^.!]*[.!]*/i, /your rate will be great/i, /uploaded (via|by) script/i, /userload autoupload/i,
  /\bread my bio\b/i, /\benjoy\b\s*[.!]*/i, /\bvisit\b[^.!\n]*/i, /uploaded by [^.!\n]* for [^.!\n]*/i, /\brate\s*(\/|and|&)\s*comment\b/i, /\(?my files\)?/i, /thank(s| you)[^.!\n]*[.!]*/i, /subscribe[^.!\n]*/i];
/** An uploader's comment without the advertising, the begging for votes and the decoration. */
function cleanNote(comment, release) {
  let s = decodeEntities(comment);
  for (const re of BEGGING) s = s.replace(re, ' ');
  s = s.replace(/\S+@\S+/g, ' ').replace(URLISH, ' ');
  s = s.replace(/[^\p{L}\p{N} .,_\-+()[\]'&:;!?/%>]/gu, ' ').replace(/\s*\n+\s*/g, ' ').replace(/[-=*>]{2,}/g, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s.,_\-:;!>]+|[\s,_\-:;>]+$/g, '');
  s = s.replace(/\s+([.,;:!?])/g, '$1').replace(/([.!?])[.,;:!?]+/g, '$1').trim();
  if (s.length < 4 || !/[\p{L}]{3}/u.test(s)) return '';
  if (release && norm(s) === norm(release)) return '';
  return s.length > 170 ? s.slice(0, 168).trimEnd() + '…' : s;
}

// ---------------------------------------------------------------- reading names and comments
const tok = (words) => new RegExp(`(^|[^A-Za-z0-9])(${words})(?![A-Za-z0-9])`);
const NOT_FOREIGN = /\bnot?[ ._-]forced\b|\bfull subs?\b|\ball lines\b|\bincludes?(s|d|ing)?\b[^.]{0,24}\b(foreign|non[ ._-]?english|french|german|spanish|italian|japanese|russian)\b|\bcombo\b|\bcomplete subtitles?\b|\b(foreign|non[ ._-]?english)[^.]{0,20}\bnot included\b|\ball but the non/i;
const FORCED = /(^|[^a-z])forced(?![a-z])/i;
const FOREIGN_ONLY = /(foreign|non[ ._-]?english)[ ._-]?(speaking[ ._-]?|language[ ._-]?)?(parts?|lines?|dialogu?e?s?|bits?|scenes?)?[ ._-]*only\b|\bonly (for )?(the )?(foreign|non[ ._-]?english)|\b(just|only) for (the )?(foreign|non[ ._-]?english)|^\W*non[ ._-]?english (speaking )?parts?\W*$/i;
const NOT_HI = /non[ ._-]?(hi|sdh)\b|\bno[ ._-]?(hi|sdh)\b|\b(hi|sdh)([ ._/-]+(hi|sdh))?[ ._-]*(removed|stripped|free)\b|\b(removed?|stripped( of)?|without|minus)[ ._-]+(the[ ._-]+)?(hi|sdh)\b/i;
const HI_NAME = /(^|[^A-Za-z0-9])(SDH|sdh|HI|hi|H\.I\.|enh)(?![A-Za-z0-9])|hearing[ ._-]?impaired|hard[ ._-]of[ ._-]hearing/;
const HI_NOTE = /\bSDH\b|\bsdh\b|hearing[ ._-]?impaired|\bH\.?I\.?\b|hard of hearing/;
const SRC = [
  ['cam', tok('CAM|Cam|CAMRip|HDCAM|TS|HDTS|TELESYNC|TeleSync|TC|TELECINE|PPV|SCREENER|SCR|DVDSCR|DVDScr')],
  ['web', /web[ ._-]?(dl|rip)|(^|[^a-z0-9])(web|nf|amzn|dsnp|hmax|atvp|pcok|hulu|itunes|netflix|amazon)(?![a-z0-9])/i],
  ['bluray', /blu[ ._-]?ray|b[dr][ ._-]?rip|bd[ ._-]?remux|(^|[^a-z0-9])(remux|bd|hddvd)(?![a-z0-9])/i],
  ['tv', /(hd|pd|sd)tv|(^|[^a-z0-9])(dsr|dvb|tvrip)(?![a-z0-9])|dvb[ ._-]?rip/i],
  ['dvd', /dvd|(^|[^a-z0-9])(ntsc|pal|r5)(?![a-z0-9])/i],
];
const SRC_LABEL = { bluray: 'Blu-ray', web: 'Streaming', tv: 'TV broadcast', dvd: 'DVD', cam: 'Cinema recording' };
const CUTS = [
  [/extended/i, 'Extended cut'], [/director.?s?[ ._-]?cut|(^|[^A-Za-z0-9])DC(?![A-Za-z0-9])/, 'Director’s cut'], [/unrated/i, 'Unrated cut'], [/(^|[^a-z])uncut(?![a-z])/i, 'Uncut'],
  [/theatrical/i, 'Theatrical cut'], [/final[ ._-]cut/i, 'Final cut'], [/(^|[^a-z])redux(?![a-z])/i, 'Redux'], [/ultimate[ ._-](cut|edition)/i, 'Ultimate cut'], [/special[ ._-]edition/i, 'Special edition'],
  [/(german|international|european|japanese|korean|french|uk|us)[ ._-](cut|retail version|version)(?![a-z])/i, null], [/alternat(e|ive)[ ._-](cut|version|ending)/i, 'Alternate cut'],
];
const fpsOf = (v) => {
  const n = Number(String(v).replace(',', '.'));
  if (!(n > 0)) return 0;
  for (const f of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]) if (Math.abs(n - f) < 0.03) return f;
  return n === 23 ? 23.976 : 0;
};
/** Which real-time speed a frame rate belongs to: 23.976 / 29.97 / 59.94 are one family, 25 / 50 another, 24 / 30 / 60 a third. */
const fpsFamily = (f) => (!f ? '' : f === 25 || f === 50 ? 'pal' : f === 24 || f === 30 || f === 60 ? 'even' : 'film');
/** "2h32m52s", "2h 32mn", "Runtime: 2:32:52", "02:28:07", "(152 min)" → { secs, exact } or null. */
function runtimeOf(text) {
  const s = String(text || '');
  let m = /(?:^|[^0-9])(\d)[ ._]?h(?:r|rs|ours?)?[ ._]{0,2}(\d{1,2})[ ._]?m(?:in|n)?s?(?:[ ._]{0,2}(\d{1,2})[ ._]?s(?:ec)?s?)?(?![a-z0-9])/i.exec(s);
  if (m) return { secs: +m[1] * 3600 + +m[2] * 60 + (+m[3] || 0), exact: m[3] !== undefined };
  m = /(?:^|[^0-9:.])(0?\d):([0-5]\d):([0-5]\d)(?![0-9:])/.exec(s);
  if (m && (+m[1] > 0 || +m[2] >= 15)) return { secs: +m[1] * 3600 + +m[2] * 60 + +m[3], exact: true };
  m = /(?:^|[^0-9.,])(\d{2,3})[ ]?min(?:ute)?s?(?![a-z])/i.exec(s);
  if (m && +m[1] >= 15 && +m[1] <= 400 && !/longer|shorter|more|less|extra/i.test(s.slice(m.index, m.index + 30))) return { secs: +m[1] * 60, exact: false };
  return null;
}

/**
 * raw: { name, names: [other release names], file, comment, hi, foreign, fps, machine, ai, files, votes, rating, trusted }
 * → { kind, hi, src, srcLabel, fps, cut, runtime, part, retail, ocr, resynced, machine, release, note, ep }
 */
function describe(raw) {
  const name = decodeEntities(raw.name || ''), file = decodeEntities(raw.file || '');
  const names = [name, file, ...(raw.names || []).map(decodeEntities)].filter(Boolean);
  const titleText = names.join(' | ');
  const note = decodeEntities(raw.comment || '');
  const all = titleText + ' | ' + note;

  const notForeign = NOT_FOREIGN.test(all);
  const foreign = !notForeign && (!!raw.foreign || names.some((n) => FORCED.test(n)) || FOREIGN_ONLY.test(titleText) || note.split(/[.!\n]+/).some((s) => FOREIGN_ONLY.test(s.trim())) || /non[ ._-]?english[ ._-]?(parts?[ ._-]?)?only/i.test(all.replace(/[()]/g, ' ')));
  const notHi = NOT_HI.test(all);
  const hi = !notHi && (HI_NAME.test(titleText) || HI_NOTE.test(note) || !!raw.hi);

  let src = '';
  for (const [k, re] of SRC) if (re.test(titleText)) { src = k; break; }
  let fps = fpsOf(raw.fps);
  if (!fps) { const m = /(\d{2}(?:[.,]\d{1,3})?)[ ._-]?fps/i.exec(all); if (m) fps = fpsOf(m[1]); }
  let cut = '';
  for (const [re, label] of CUTS) { const m = re.exec(titleText) || re.exec(note); if (m) { cut = label || (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase().replace(/^Uk$/, 'UK').replace(/^Us$/, 'US') + ' cut'); break; } }
  const rt = runtimeOf(titleText) || runtimeOf(note);
  // One disc of several: "CD2", "cd1.en" — but not "2CD" joined into one ("join 2CD", "1CDRip").
  let part = 0;
  { const m = /(^|[^a-z0-9])(?:cd|dis[ck]|part)[ ._-]?([1-4])(?![0-9a-z])/i.exec(name) || /(^|[^a-z0-9])(?:cd|dis[ck])[ ._-]?([1-4])(?![0-9a-z])/i.exec(file); if (m && !/\b(join|joined|merged|1 ?file|one file)\b/i.test(all)) part = +m[2]; }
  const parts = Number(raw.files) > 1 ? Number(raw.files) : 0;

  const release = cleanRelease(name) || cleanRelease(file);
  return {
    kind: foreign ? 'foreign' : hi ? 'sdh' : 'full', hi, foreign,
    src, srcLabel: SRC_LABEL[src] || '', fps, cut, runtime: rt ? rt.secs : 0, runtimeExact: !!(rt && rt.exact),
    part: parts ? 1 : part, parts,
    retail: /\bretail\b|\bofficial\b|extracted from|ripped from|pgs extracted|\bfrom (the )?(netflix|amazon|disney|blu-?ray|dvd|uhd)|\b(netflix|disney\+?|amazon|hulu|max)\b[^.]{0,30}\b(subtitle|sdh|forced|rip)/i.test(all),
    ocr: /\bocr/i.test(all),
    resynced: /re-?sync|\bsync(h|ed|hed|hronized|hronised)?\b[^.]{0,12}\b(to|for|and corrected|fixed)\b|\bshifted\b|\bsynchroni[sz]ed\b/i.test(all),
    machine: !!(raw.machine || raw.ai) || /machine[ -]translat|google[ -]translat|auto[ -]?translat|\bai[ -]translat|translated (by|with|using) (google|ai|deepl|chatgpt)/i.test(all),
    release, note: cleanNote(note, release), ep: episodeOfName(name) || episodeOfName(file) || null,
  };
}

// ---------------------------------------------------------------- is it even for this title?
const FILLER = new Set(['the', 'a', 'an', 'and', 'of', 'us', 'uk', 'au', 'ca', 'nz', 'complete', 'season', 'series', 'tv', 'show', 'part', 'proper', 'repack', 'internal', 'multi', 'dual', 'en', 'eng', 'english']);
/**
 * A reason this listing belongs to something else than what was asked for, or ''.
 *   drop: plainly another episode, season or film — never offered.
 *   doubt: might be (a spin-off filed under the parent show: "Narcos.Mexico.S01E01" among Narcos S01E01) — offered
 *          last, with the reason, and never picked automatically.
 * q: { query (title), year, season, episode }
 */
function otherTitle(d, raw, q) {
  const name = String(raw.name || ''), file = String(raw.file || '');
  if (q.season && q.episode) {
    // (A name that gives no episode — "bb205-clue" — leaves it to the file's own name.)
    if (namesOtherEpisode(name, q.season, q.episode) || (!episodeOfName(name) && file && namesOtherEpisode(file, q.season, q.episode))) return { drop: true, why: 'for another episode' };
    // What stands before "S01E01": the show's name, perhaps a year or country — or another show's name.
    const m = /^(.*?)(?:[ ._-]+|\b)(?:s\d{1,2}[ ._-]?e\d{1,3}|\d{1,2}x\d{2,3})(?![0-9])/i.exec(name);
    const title = norm(q.query);
    if (m && title) {
      const before = norm(m[1]).replace(/\b(19|20)\d\d\b/g, ' ').replace(/\s+/g, ' ').trim();
      const t0 = title.replace(/^the /, ''), b0 = before.replace(/^the /, '');
      const said = m[1].replace(/[._]+/g, ' ').trim();
      const words = (x) => x.split(' ').filter((w) => w.length > 2 && !FILLER.has(w) && !/^\d+$/.test(w));
      // "Narcos Mexico" among Narcos': the show's name and more — a spin-off.
      if (b0.startsWith(t0 + ' ') && words(b0.slice(t0.length).trim()).length) return { doubt: true, why: `its name says “${said}”`, alias: b0 };
      // Another name altogether ("El Camino" among Breaking Bad's) — unless it is the show's initials ("bb").
      const tw = new Set(words(t0)), bw = words(b0);
      const initials = t0.split(' ').map((w) => w[0]).join('');
      if (bw.length && tw.size && !bw.some((w) => tw.has(w)) && b0.replace(/ /g, '') !== initials && !t0.includes(b0)) return { doubt: true, why: `its name says “${said}”`, alias: b0 };
    }
    return null;
  }
  if (!q.season) {
    // A film: a name with another year in it and without the title is another film ("…10.things.i.hate.about.you.1999…"
    // among Inception's).
    const title = norm(q.query).replace(/^the /, '');
    const n = norm(name + ' ' + (raw.names || []).join(' '));
    if (title && q.year && !n.includes(title)) {
      const years = (name.match(/(?:^|[^0-9])((?:19|20)\d\d)(?![0-9])/g) || []).map((y) => +y.replace(/\D/g, ''));
      if (years.length && years.every((y) => Math.abs(y - q.year) > 1)) return { drop: true, why: 'for another film' };
    }
    if (d.ep && d.ep.episode && !/\b(19|20)\d\d\b/.test(String(q.query))) {
      // "S01E03" in a film's subtitle list: an episode of something filed under the film.
      if (/s\d{1,2}[ ._-]?e\d{1,3}/i.test(name) && title && !n.replace(/s\d+ ?e\d+.*/, '').includes(title)) return { drop: true, why: 'for an episode of something else' };
    }
  }
  return null;
}

// ---------------------------------------------------------------- how well does it fit?
const fmtDur = (s) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`; };
/**
 * Scores a listing for this video and says, in words, what it is and what might be wrong with it.
 * q: { query, year, season, episode, hi (wants SDH), dur (the video's length, seconds; 0 unknown), fps (the video's) }
 * x: the listing — { pack, cached, costly, downloads, votes, rating, fromTrusted, source }
 * → { score, tags: [...], warn: [...], bad: '' | reason }
 */
function judge(d, x, q) {
  const tags = [], warn = [];
  let score = 50, bad = '';
  if (d.srcLabel) tags.push(d.srcLabel);
  if (d.fps) tags.push(`${d.fps} fps`);
  if (d.cut) tags.push(d.cut);
  if (d.runtime) tags.push(fmtDur(d.runtime));
  if (d.retail) { tags.push('Official text'); score += 6; }
  if (d.ocr) { tags.push('Read by machine from a disc'); score -= 2; }
  if (d.resynced) tags.push('Retimed');
  if (d.machine) { tags.push('Machine translated'); score -= 30; warn.push('Translated by a program: expect odd wording.'); }
  if (x.pack) score -= 3;
  if (!d.release) score -= 8; // (listed under no name at all, or a web address: nothing to go on)

  if (d.part) { bad = d.parts ? `comes in ${d.parts} parts, for a copy split over ${d.parts} discs` : `is part ${d.part} of a copy split over several discs`; }
  if (d.src === 'cam') { score -= 18; warn.push('Timed for a recording made in a cinema: often a little off on other copies.'); }

  // The length the uploader gives for their copy against this video's.
  const dur = Number(q.dur) || 0;
  if (dur > 0 && d.runtime) {
    const diff = d.runtime - dur, tol = d.runtimeExact ? 6 : 75;
    if (Math.abs(diff) <= tol) { score += d.runtimeExact ? 30 : 10; tags[tags.indexOf(fmtDur(d.runtime))] = d.runtimeExact ? 'Same length as this video' : fmtDur(d.runtime); }
    else if (Math.abs(diff) > Math.max(tol, 20)) { score -= 35; warn.push(`Made for a copy ${fmtDur(Math.abs(diff)) === '0 min' ? Math.round(Math.abs(diff)) + ' s' : fmtDur(Math.abs(diff))} ${diff > 0 ? 'longer' : 'shorter'} than this video.`); }
  }
  // A different edit: only a guess without lengths to compare, so a mild one.
  if (d.cut && !new RegExp(d.cut.split(/[ ’']/)[0], 'i').test(String(q.name || q.query || ''))) { if (!(dur > 0 && d.runtime)) { score -= 8; warn.push(`Made for the ${d.cut} of this: scenes may be added or missing.`); } } else if (d.cut) score += 8;
  // Frame rate: against the video's when known; otherwise 25 is the unusual one.
  const vf = fpsFamily(Number(q.fps) || 0), sf = fpsFamily(d.fps);
  if (sf && vf) { if (sf === vf) score += 6; else { score -= 20; warn.push(`Timed for a ${d.fps} fps copy; this video isn’t one, so it may drift.`); } } else if (sf === 'pal') { score -= 5; warn.push('Timed for a 25 fps (European TV/DVD) copy: on other copies it drifts.'); }

  // What people made of it.
  if (x.fromTrusted) score += 5;
  if (x.votes >= 2) score += Math.max(-12, Math.min(8, (x.rating - 6) * 2.5));
  else if (x.votes === 1 && x.rating && x.rating <= 3) score -= 4;
  if (x.downloads > 0) score += Math.min(8, Math.log10(x.downloads + 1) * 1.6);
  // Hearing-impaired or not, as asked (a preference, not a fault).
  if (d.kind !== 'foreign' && !!q.hi !== (d.kind === 'sdh')) score -= 7;
  return { score: Math.round(score * 10) / 10, tags, warn, bad };
}

const KIND_LABEL = { full: 'Everything spoken', sdh: 'With sounds described (SDH)', foreign: 'Foreign-language parts only' };

module.exports = { describe, otherTitle, judge, cleanRelease, cleanNote, runtimeOf, fpsOf, fpsFamily, norm, KIND_LABEL, SRC_LABEL };
