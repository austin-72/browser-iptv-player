'use strict';
/**
 * Tidying of the names providers give things:
 *   films/series  "EN - Apollo 13 (1995) TOM HANKS"            → "Apollo 13", 1995
 *                 "My Rainy Days (2009) (JAPANESE ENG-SUB)"     → "My Rainy Days", 2009, note "English subtitles"
 *                 "A.Very.Long.Engagement.2004 .BRRiP .AAC…"    → "A Very Long Engagement", 2004
 *                 "DAHMER - MONSTER: THE JEFFREY DAHMER STORY"  → "Dahmer - Monster: The Jeffrey Dahmer Story"
 *   PPV channels  "End | Chelsea vs. Man Utd | all | 31-10-2026 | 00:00 (GMT) | 8K EXCLUSIVE | US: SOCCER PPV 1"
 *                 → channel "SOCCER PPV 1" (US), event "Chelsea vs. Man Utd", ended
 *   categories    "|NA| USA ESPN+", "VOD - NETFLIX", "TV ᴿᴬᵂ ⁶⁰ᶠᵖˢ"  → "ESPN+", "Netflix", "TV"
 * plus a few language fixes for channels whose tags mislead (US Spanish-language networks, Indian channels…).
 */

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'vs', 'vs.', 'via', 'with', 'de', 'la', 'le', 'du', 'des', 'et']);
// Words that stay in capitals when an all-caps name is put in title case.
const ACRONYMS = new Set(('TV HD UHD 4K 8K FHD SD PPV VIP USA US UK GB EU NA CA AU NZ IE ESPN ESPN+ ESPNU ESPN2 NBA NFL NHL MLB MLS MILB NCAA NCAAB NCAAF ' +
  'UFC WWE AEW NXT PBS CBS NBC ABC CW MY FX FXX HBO AMC TNT TBS BBC ITV ITVX CNN MSNBC CNBC HGTV TLC BET TMC IFC ' +
  'DAZN TSN TUBI CBC CTV CHCH APTN TVO RTE TG4 STV BT EPL UEFA FIFA F1 MOTOGP WRC NASCAR PGA LPGA ATP WTA NRL AFL GAA ' +
  'BBCI OTT VOD DVD UFO CIA FBI NYPD CSI NCIS SWAT USS II III IV VI VII VIII IX XI XII DMZ TMNT DC MCU ' +
  'PH MY SG IN UAE AHL OHL WHL QMJHL CHL LOI PSF SN SN1 SN360 BTN B1G ACC SEC NESN MSG YES SNY NBCSN ' +
  'RAW HEVC HDR SDR AI RV LA NY DJ MTV VH1 CMT GAC FLO DSTV SKY TUDN TVE TF1 RTL ORF ARD ZDF RAI ATN ZEE GMA ABS CBN TV5').split(' '));
const LANG_WORDS = 'ENGLISH|ENGL|ENG|EN|FRENCH|FR|FRA|GERMAN|DE|GER|SPANISH|SP|SPA|ESP|ES|ITALIAN|IT|ITA|DUTCH|NL|PORTUGUESE|PT|POR|BRAZILIAN|' +
  'RUSSIAN|RU|POLISH|PL|TURKISH|TR|GREEK|GR|SWEDISH|SE|SWE|NORWEGIAN|NO|NOR|DANISH|DK|DAN|FINNISH|FI|JAPANESE|JP|JAP|KOREAN|KR|KOR|CHINESE|CN|' +
  'MANDARIN|CANTONESE|HINDI|TAMIL|TELUGU|ARABIC|AR|HEBREW|PERSIAN|THAI|VIETNAMESE|INDONESIAN|TAGALOG|FILIPINO|ROMANIAN|HUNGARIAN|CZECH|ICELANDIC|' +
  'SERBIAN|CROATIAN|BOSNIAN|ALBANIAN|UKRAINIAN|BULGARIAN|MULTI|MULTISUB|ORIGINAL|ORIG';
const NOTE_WORD = new RegExp(`^(?:${LANG_WORDS}|SUBS?|SUBT|SUBTITLES?|SUBBED|SUB-?ENG|ENG-?SUBS?|SUBT-?ENGL?|DUB|DUBBED|ENG-?DUB|ONLY|NO|AUDIO|VO|VOST|VOSTFR|VF|VFF|VFQ|[A-Z]{2})$`, 'i');
const RELEASE_JUNK = /^(?:brrip|bdrip|bluray|blu-ray|webrip|web-?dl|web|hdtv|hdrip|dvdrip|dvdscr|xvid|divx|x264|x265|h264|h265|hevc|aac|aac2|ac3|dd5|ddp5|dts|mkv|mp4|avi|proper|repack|internal|extended|unrated|remastered|1080p|720p|2160p|480p|4k|uhd|hdr|10bit|yify|yts|rarbg|ppv)$/i;
// "SC - ", "QFR - ", "WC - ", "DE-BLURAY-DV - " in front of titles: provider shelf codes. Sports leagues stay.
const PREFIX_CODE = /^([A-Z0-9][A-Z0-9+]{1,4}(?:-[A-Z0-9]+){0,3})\s+-\s+(?=\S)/;
const KEEP_PREFIX = new Set('UFC WWE AEW NXT NBA NFL NHL MLB MLS F1 PGA ONE BKFC PFL RAW TNA ROH UEFA FIFA NCAA BBC ITV CNN HBO'.split(' '));
// "VIP| ", "TV| ", "CAR| ", "PPV| ", "SOCCER| " in front of a name: the provider's shelf, not part of the name.
const SHELF_PIPE = /^([A-Z](?:[A-Z0-9+&.]|-(?=[A-Z])){0,7})\s*\|\s*(?=\S)/;
// Channels only: "NA - FLINT FIREBIRDS", "SP - …", "CAFR - …", "KIDS - …".
const SHELF_DASH = /^([A-Z][A-Z0-9+&]{1,4})\s+-\s+(?=\S)/;
// Notes about the stream at the end of a channel's name: "[Geo-blocked]", "[Not 24/7]", "[EVENT ONLY]".
const STREAM_NOTE = /\s*[[(](?:geo-?blocked|not 24\/7|events?[- ]only|live[- ]events?)[\])]\s*$/i;
// Edition words in brackets: "Top Gun: Maverick - 2022 (IMAX)" → note "IMAX" (the same film otherwise).
const EDITION = /^(?:imax(?: enhanced)?|extended(?: cut| edition)?|director'?s cut|remastered|uncut|theatrical(?: cut)?|ai generated)$/i;
// A country in brackets ("The Office (US)", "Alien: Earth (2025) (US)"): taken off the name, but kept to tell
// "The Office (US)" from "The Office (UK)" (see Catalog._sameTitleSteps).
const COUNTRY_NOTE = /^(?:US|USA|UK|GB|CA|AU|NZ|IE|JP|KR|IN|FR|DE|ES|IT|MX|BR|SE|NO|DK|FI|NL|BE|TR|CN|TW|HK|ZA|PH|TH|AR)$/;

// Tags providers stick on the end of a title: a language ("Preacher-eng", "Parish_eng", "Grafted - 2024 sub") or a
// cinema recording ("Evil Dead Burn - 2026 CAM", "The Critic hdts", "Regretting You -CAM", "(HDAM)").
const TAIL_LANG = /^(?:eng|english|en|multi|multisub|multi-?subs?|subs?|subbed|eng-?subs?|sub-?eng|msub|esub)$/i;
// Other languages' tags the same way ("The Act_fr", "Star Trek-esp", "Kaamelott_qb"): only with "_" or "-" before them.
const TAIL_OTHER = /^(?:fr|fre|fra|de|ger|deu|es|esp|spa|it|ita|pt|por|tr|tur|ar|ara|nl|pl|ru|hi|qb|vf|vo|vost|vostfr|dl)$/i;
const REL_STRONG = /^(?:hdcam|camrip|hdts|hdtc|telesync|telecine|screener|dvdscr|hdscr|hdam)$/i;
const REL_WEAK = /^(?:cam|ts|tc|scr)$/i;
/** Peels such tags off the end: { s, y, cam }. */
function peelTail(s, yearHint) {
  let y = 0, cam = false;
  for (let i = 0; i < 4; i++) {
    const m = s.match(/^(.*\S)([\s_-]+)([a-z]+)$/i);
    if (m && m[1].length >= 2) {
      const before = m[1], sep = m[2], tag = m[3];
      const marked = /[_-]/.test(sep) || /[-–_]$/.test(before) || /(?:^|\s)(?:19|20)\d{2}$/.test(before); // "-eng", "_eng", "2024 sub"
      if (TAIL_LANG.test(tag) && marked) { s = before; continue; }
      if (TAIL_OTHER.test(tag) && /[_-]/.test(sep)) { s = before; continue; }
      if (REL_STRONG.test(tag) || (REL_WEAK.test(tag) && (marked || (tag === tag.toUpperCase() && /[a-z]/.test(before))))) { s = before; cam = true; continue; }
    }
    // "Project Power-2020", "The Bob's Burgers Movie - 2022"
    const ym = s.match(/^(.*\S)\s*[-_]\s*((?:19|20)\d{2})$/);
    // (Not when the list dates it otherwise — "Act-1978" from 2020 — or it's a span: "Ataturk 1881-1919".)
    const yy = ym ? parseInt(ym[2], 10) : 0;
    if (ym && !y && yy <= THIS_YEAR + 1 && (!yearHint || yearHint === yy) && !/^\d+$/.test(ym[1]) && !/\d{4}\s*$/.test(ym[1])) { y = yy; s = ym[1]; continue; }
    break;
  }
  return { s: s.replace(/[\s,;:–—_-]+$/, ''), y, cam };
}

const THIS_YEAR = new Date().getFullYear();
const isAllCaps = (s) => /[A-Z]{2}/.test(s) && !/[a-z]/.test(s);

/** "THE LORD OF THE RINGS" → "The Lord of the Rings" (acronyms and roman numerals stay). */
function titleCase(s) {
  let first = true;
  return s.replace(/[^\s/]+/g, (w) => {
    const bare = w.replace(/^[^A-Z0-9]+|[^A-Z0-9+]+$/gi, '');
    let out;
    if (!bare) out = w;
    else if (ACRONYMS.has(bare.toUpperCase()) || /\d/.test(bare) && bare.length <= 5 || /^([A-Z]\.){2,}[A-Z]?\.?$/i.test(bare)) out = w;
    else if (!first && SMALL.has(bare.toLowerCase())) out = w.toLowerCase();
    else out = w.toLowerCase().replace(/(^|[-'’(.:&·]|\bmc)([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase());
    first = /[:–—-]$/.test(w);
    return out;
  });
}

/** A name written as a file name: "Boxing.2020.11.28.Mike.Tyson.Vs.Roy.Jones." → "Boxing 2020-11-28 Mike Tyson Vs Roy Jones". */
function unscene(s) {
  if (/\s/.test(s.trim().replace(/\s+\.[a-z0-9]+/gi, '')) || (s.match(/\./g) || []).length < 3 || !/[a-z]{2,}\.[a-z]{2,}/i.test(s)) return s;
  const parts = s.split(/[.\s]+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (RELEASE_JUNK.test(p) || /^aac\(|^\(?\d\.\d\)?/i.test(p) || /-[a-z_]+$/i.test(p) && RELEASE_JUNK.test(p.split('-')[0])) break;
    out.push(p);
  }
  let t = out.join(' ');
  t = t.replace(/\b((?:19|20)\d{2}) (\d{2}) (\d{2})\b/, '$1-$2-$3');
  const y = t.match(/^(.*\S)\s+((?:19|20)\d{2})$/);
  if (y) t = `${y[1]} (${y[2]})`;
  return t || s;
}

/** Notes in brackets: "(FRENCH ENG-SUB)" → "English subtitles", "(ENG DUB)" → "Dubbed". */
function noteOf(content) {
  const u = content.toUpperCase();
  if (/SUB/.test(u) && /\bENG|ENGL|ENGLISH/.test(u)) return 'English subtitles';
  if (/\bNO SUB/.test(u)) return 'No subtitles';
  if (/DUB/.test(u)) return 'Dubbed';
  if (/SUB/.test(u)) return 'Subtitles';
  return '';
}

/**
 * Film / series name → { n, y, note }. `y` is the year found in the name (0 if none).
 */
/** (`legacy`: as names were tidied before the end tags were peeled off — to find the keys saved things used.) */
function tidyVod(raw, yearHint, legacy) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return { n: '', y: 0, note: '' };
  // (Not a title but a paragraph: left as it is. Some of the patterns below take seconds on very long names.)
  if (s.length > 500) return { n: s, y: 0, note: '', cam: false };
  s = unscene(s);
  for (let i = 0; i < 3; i++) {
    const m = PREFIX_CODE.exec(s);
    if (!m || KEEP_PREFIX.has(m[1].toUpperCase()) || s.length - m[0].length < 2) break;
    s = s.slice(m[0].length);
  }
  let note = '', cam = false, co = '';
  // Bracketed notes (and an unclosed one at the very end).
  s = s.replace(/\s*[([]([^()[\]]{1,40})(?:[)\]]|$)/g, (m, inner) => {
    if (COUNTRY_NOTE.test(inner.trim())) { co = co || ({ USA: 'US', GB: 'UK' })[inner.trim()] || inner.trim(); return ' '; }
    const words = inner.trim().split(/[\s,/&+-]+/).filter(Boolean);
    if (words.length && words.every((w) => REL_STRONG.test(w) || REL_WEAK.test(w))) { cam = true; return ' '; }
    if (words.length && words.every((w) => NOTE_WORD.test(w))) { note = note || noteOf(inner); return ' '; }
    if (!legacy && EDITION.test(inner.trim())) { const e = inner.trim().toLowerCase(); note = note || (/^imax/.test(e) ? e.toUpperCase().replace('ENHANCED', 'Enhanced') : /^ai /.test(e) ? 'AI generated' : e[0].toUpperCase() + e.slice(1)); return ' '; }
    return m;
  });
  if (!legacy) s = s.replace(/\s+$/, '');
  let pt = legacy ? { s, y: 0, cam: false } : peelTail(s, yearHint);
  s = pt.s; cam = cam || pt.cam;
  // The year: "(1995)", "(2021-2023)", "(2024-)"; anything after it is actors/notes ("(1995) TOM HANKS").
  let y = pt.y;
  const ym = legacy ? s.match(/^(.*?\S)\s*[([]((?:19|20)\d{2})(?:\s*[-–]\s*(?:(?:19|20)\d{2})?)?[)\]](.*)$/)
    : s.match(/^(.*?\S)\s*[([]\s*((?:19|20)\d{2})(?:\s*[-–]\s*(?:(?:19|20)\d{2})?)?\s*[)\]](.*)$/);
  if (ym) {
    y = parseInt(ym[2], 10);
    s = ym[1];
  } else {
    // A bare year at the end ("Title 2019") — but not "Blade Runner 2049" or "Wonder Woman 1984" when the list
    // says the film is from another year.
    const ye = s.match(/^(.*\S)\s+((?:19|20)\d{2})$/);
    const yy = ye ? parseInt(ye[2], 10) : 0;
    if (ye && yy <= THIS_YEAR + 1 && (!yearHint || yearHint === yy) && !/\b(?:vs|v|part|chapter|season)\.?$/i.test(ye[1]) && !/^\d+$/.test(ye[1])) { y = yy; s = ye[1]; }
  }
  // Tags after the year ("Insidious - 2026 cam" → "Insidious - 2026" → year) or before it.
  pt = legacy ? { s } : peelTail(s, yearHint);
  if (pt.s !== s) { s = pt.s; cam = cam || pt.cam; if (!y && pt.y) y = pt.y; }
  s = s.replace(/\s+-\s*$/, '').replace(/[\s,;:–—-]+$/, '').replace(/^[\s,;:–—-]+/, '').replace(/\s{2,}/g, ' ').trim();
  if (isAllCaps(s) && (s.length > 4 || s.split(' ').length > 1)) s = titleCase(s);
  return co ? { n: s || String(raw).trim(), y, note, cam, co } : { n: s || String(raw).trim(), y, note, cam };
}

/**
 * Pay-per-view event channels that carry the event in their name. Returns null for ordinary channels.
 *   { n: 'SOCCER PPV 1', tag: 'US', ev: 'Chelsea vs. Manchester United', evs: 'ended' | 'none' | '' }
 */
function liveEvent(raw) {
  const s = String(raw || '');
  // "US (ESPN+ 310) | Pacific vs. Denver Oct 31 5:00PM ET (2026-10-31 17:00:10)", "(FLSP 260) | hockey: A vs B (Home)
  // (2026-10-31 13:30:25)", "NBA LIVE 24 [Clippers vs Raptors (Clippers In_Arena) (2026-11-02 22:00:00)]": a numbered
  // channel and what's on it.
  const pm = s.match(/^\s*(?:[A-Z]{2,3}\s*)?\(\s*([A-Za-z][^()|]{0,30}?\s\d{1,4})\s*\)\s*\|\s*(.+)$/)
    || s.match(/^\s*([A-Za-z][^()|]{0,30}?\s\d{1,4})\s*\[(.+\(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?\))\]\s*$/);
  if (pm) {
    let x = pm[2].trim();
    x = x.replace(/\s*\(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?\)\s*$/, '');
    x = x.replace(/\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\s+\d{1,2}:\d{2}\s*[ap]m\s*[a-z]{1,4}\s*$/i, '');
    x = x.replace(/\s*\((?:home|away|neutral|vipr|[^()]*\bin_arena)\)\s*$/i, '').replace(/\s_\s/g, ' · ').replace(/_\s/g, ': ').trim();
    // (own: numbered per provider — two providers' "ESPN+ 310" needn't show the same game, so they stay apart.)
    if (/^(?:no event|tba|off ?air)\b/i.test(x)) return { n: pm[1].replace(/\s+/g, ' ').trim(), tag: '', ev: '', evs: 'none', own: true };
    return { n: pm[1].replace(/\s+/g, ' ').trim(), tag: '', ev: x.slice(0, 200), evs: '', own: true };
  }
  if (s.split('|').length < 3 || !/PPV|EVENT|EXCLUSIVE|\(GMT\)|\d{2}-\d{2}-\d{4}/i.test(s)) return null;
  const segs = s.split('|').map((x) => x.trim()).filter(Boolean);
  let ci = -1;
  for (let i = segs.length - 1; i >= 0; i--) if (/^[A-Z]{2,3}:\s*\S/.test(segs[i]) || /PPV|EVENTS?\s*\d/i.test(segs[i]) && /\d+\s*$/.test(segs[i])) { ci = i; break; }
  let chan = ci >= 0 ? segs[ci] : '';
  let lead = '';
  if (ci < 0) {
    // "D+ (UK) Events 88: Cricket | West Indies v South Africa | …": the channel is the start of the first part.
    const m = segs[0].match(/^(.*?\bEvents?\s*\d+)\s*:\s*(.*)$/i);
    if (!m) return null;
    chan = m[1]; lead = m[2]; ci = 0;
  }
  let tag = '';
  const tm = chan.match(/^([A-Z]{2,3}):\s*(.+)$/);
  if (tm) { tag = tm[1]; chan = tm[2]; }
  let evs = '';
  const ev = lead ? [lead] : [];
  for (let i = 0; i < segs.length; i++) {
    let x = segs[i];
    if (i === ci) continue;
    x = x.replace(/^[\s-]+|[\s-]+$/g, '');
    if (/^end(ed)?$/i.test(x)) { evs = 'ended'; continue; }
    if (/no event/i.test(x)) { evs = 'none'; continue; }
    if (/^live$/i.test(x)) { evs = evs || 'live'; continue; }
    if (/^(next|soon|upcoming)$/i.test(x)) { evs = evs || 'next'; continue; }
    if (/^(all|\d+k exclusive|exclusive|hd|fhd|uhd|4k|8k)$/i.test(x)) continue;
    if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(x) || /^\d{1,2}:\d{2}(\s*\(?[A-Z]{2,4}\)?)?$/.test(x)) continue;
    if (/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s+\d{1,2}\s+[a-z]{3,}/i.test(x)) continue;
    if (x) ev.push(isAllCaps(x) ? titleCase(x) : x.replace(/\s_\s/g, ' v '));
  }
  return { n: chan.trim(), tag, ev: ev.join(' · ').slice(0, 200), evs };
}

// Spanish-language networks (often listed under US/NA categories, which would make them "English").
const SPANISH = /\b(telemundo|univision|unimas|galavision|tudn|vix\+?|estrella tv|azteca|cnn en espa[nñ]ol|espn deportes|fox deportes|bein (sports )?(en )?espa[nñ]ol|nbc universo|universo|discovery en espa[nñ]ol|hbo latino|cine latino|cinelatino|wapa|telefe|televisa|las estrellas|canal de las estrellas|telenovelas?|noticias|deportes)\b/i;
const INDIAN = [['te', /\b(telugu|telegu)\b/i], ['ta', /\btamil\b/i], ['ml', /\bmalayalam\b/i], ['kn', /\bkannada\b/i], ['mr', /\bmarathi\b/i], ['bn', /\b(bangla|bengali)\b/i], ['pa', /\b(punjabi|panjabi)\b/i], ['gu', /\bgujarati\b/i], ['or', /\b(odia|oriya)\b/i], ['hi', /\b(hindi|bollywood)\b/i]];

// Big national channels, for when nothing else says the language.
const BRANDS = [
  ['fr', /^\W*(TF1|TMC|M6|W9|6TER|CANAL\+|FRANCE ?[2-5]|FRANCE INFO|BFM ?TV|LCI|ARTE|C8|CSTAR|GULLI|RMC)\b/i],
  ['de', /^\W*(ARD|ZDF|DAS ERSTE|PRO ?7|SAT\.? ?1|KABEL ?1|VOX|RTL ?(2|ZWEI|NITRO|SUPER)?|SIXX|NTV|WELT|SPORT1|SKY DE)\b/i],
  ['it', /^\W*(RAI ?\d|RAI |CANALE 5|ITALIA ?[12]|RETE ?4|LA7|TV8)\b/i],
  ['nl', /^\W*(NPO ?\d|RTL ?[4578]|SBS ?[69]|VEED)\b/i],
];

/** Corrections to detected languages that tags get wrong. Returns a new list or null (keep). */
function refineLangs(type, name, group, langs, evTag, fromCountry) {
  const both = `${name} ${group}`;
  const only = (l) => !langs.length || (langs.length === 1 && langs[0] === l);
  // "AUS|" means Austria in an AUSTRIA category (it's usually Australia); "SA|" is South Africa in African ones.
  if (/^\W*AUS\s*[|:-]/i.test(name) && /austria|österreich/i.test(group)) return ['de'];
  if (/^\W*SA\s*[|:-]/i.test(name) && /\bAFR|africa|dstv/i.test(group)) return ['en'];
  // Nordic shelves ("|SCA| NORDIC", "SC - Title").
  if (/^\W*SCA?\W|\|SCA\||\bNORDIC\b/i.test(group) && !langs.length) return ['sv', 'no', 'da'];
  if (type === 'live' || type === 'radio') {
    if (evTag && fromCountry) { const l = fromCountry(evTag); if (l) return Array.isArray(l) ? l : [l]; }
    if (SPANISH.test(name) && (only('en') || only('ar'))) return ['es'];
    for (const [l, re] of INDIAN) if (re.test(name) && !langs.includes(l)) return [l];
    if (/^\W*YP\s*\|/i.test(name) && only('en')) return ['hi'];
    if (/^\W*BEE\s*\|/i.test(name) && !langs.length) return ['ar'];
    if (!langs.length) for (const [l, re] of BRANDS) if (re.test(name)) return [l];
    if (/^\W*IN-PREM\s*\|/i.test(name) && !langs.length) { for (const [l, re] of INDIAN) if (re.test(both)) return [l]; return ['hi']; }
  }
  return null;
}

/** Category names: "|NA| USA ESPN+" → "ESPN+", "VOD - NETFLIX" → "Netflix", "TV ᴿᴬᵂ ⁶⁰ᶠᵖˢ" → "TV". */
function tidyGroup(raw) {
  let s = String(raw || '').normalize('NFC');
  // Superscript/small-caps decorations.
  s = s.replace(/[ᴀ-ᶿ⁰-₟²³¹ʰ-˿]+/g, ' ');
  s = s.replace(/^\s*(?:VOD|SRS|SERIES|MOVIES?)\s*-\s+/i, '');
  // Leading region/language tags: "|NA| ", "NA| ", "|EU| ", "BEE| ", "CRB| ", "|SPT| ".
  for (let i = 0; i < 2; i++) s = s.replace(/^\s*\|?\s*[A-Z]{2,4}\s*\|\s*(?=\S)/, '');
  s = s.replace(/^USA\s+(?=\S)(?!NETWORK$)/i, '');
  s = s.replace(/\s+VIP$/i, '').replace(/\s{2,}/g, ' ').trim();
  if (!s) return String(raw || '').trim();
  return isAllCaps(s) ? titleCase(s) : s;
}

/** "Netflix *" style admin patterns → RegExp. */
function patternRe(p) {
  const esc = String(p || '').trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`, 'i');
}

/**
 * A provider's shelf tags in front of a name: "VIP| BOX OFFICE 74" → "BOX OFFICE 74", "24/7-EN - AGENT OF SHIELD" →
 * "24/7 AGENT OF SHIELD". Sports leagues stay ("NBA| …"), and so does a name that would be left too short.
 */
function stripShelf(name, live) {
  let s = String(name || '');
  for (let i = 0; i < 2; i++) {
    const m = SHELF_PIPE.exec(s) || (live && SHELF_DASH.exec(s));
    if (!m || KEEP_PREFIX.has(m[1].replace(/\./g, '').toUpperCase()) || s.length - m[0].length < 2) break;
    s = s.slice(m[0].length);
  }
  if (live) { const t = s.replace(STREAM_NOTE, ''); if (t.length >= 2) s = t; }
  s = s.replace(/^24\/7\s*[-:]?\s*[A-Z]{2}\s*[-:|]\s+(?=\S)/, '24/7 ');
  return s;
}

/**
 * Is TMDB's title clearly this title? Mostly the same words, the same numbers ("Chapter 1" isn't "Chapter 2", "House
 * Party" isn't "House Party 3"), and a year that fits. (A match found by searching a name is sometimes another film:
 * "The Force" → "Star Wars: The Force Awakens", "Cow" → "Funny Cow".)
 */
// (Not "i", "v" and "x" alone: "Malcolm X", "V for Vendetta".)
const ROMAN = { ii: '2', iii: '3', iv: '4', vi: '6', vii: '7', viii: '8', ix: '9' };
function sameTitle(name, year, title, titleYear) {
  if (year && titleYear && Math.abs(year - titleYear) > 1) return false;
  const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w && !/^(the|a|an|and|of)$/.test(w)).map((w) => ROMAN[w] || w);
  const a = words(name), b = words(title);
  if (!a.length || !b.length) return false;
  const nums = (ws) => ws.filter((w) => /^\d+$/.test(w) && !(+w >= 1900 && +w <= 2100)).map(Number).sort().join(',');
  if (nums(a) !== nums(b)) return false;
  const A = a.join(''), B = b.join('');
  if (A === B) return true;
  // Mostly the same words: the shorter name is most of the longer ("Lord of the Rings Fellowship"), not a part of it
  // ("Big Time" / "Big Time Adolescence", "Fire With Fire" / "Playing with Fire").
  const left = new Map();
  for (const w of b) left.set(w, (left.get(w) || 0) + 1);
  let both = 0;
  for (const w of a) if (left.get(w)) { both++; left.set(w, left.get(w) - 1); }
  return both / Math.max(a.length, b.length) >= 0.75;
}

module.exports = { tidyVod, tidyGroup, liveEvent, refineLangs, titleCase, unscene, patternRe, stripShelf, sameTitle };
