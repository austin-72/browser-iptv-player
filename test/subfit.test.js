'use strict';
// Subtitles found online that are for the wrong episode, or timed for another copy (lib/subcheck.js, lib/subnames.js,
// lib/subsources.js, lib/subtitles.js, lib/routes-p5.js). The names, comments and zip layouts are the shapes the
// sites really give (SubDL and OpenSubtitles, November 2026).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const cfg = require('../lib/config');
const { zip } = require('../lib/zip');
const C = require('../lib/subcheck');
const N = require('../lib/subnames');
const { pickFromDownload } = require('../lib/subsources');
const { Subtitles } = require('../lib/subtitles');
const F = require('./subfit-fixture');

const SRT = (t) => `1\n00:00:01,000 --> 00:00:02,000\n${t}\n`;
const big = (t) => Array.from({ length: 80 }, (x, i) => `${i + 1}\n00:${String(i).padStart(2, '0')}:01,000 --> 00:${String(i).padStart(2, '0')}:03,000\n${t} ${i}\n`).join('\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(150); } return false; };
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => ok(n)); }); });

test('what a release name says about the episode', () => {
  const e = C.episodeOfName;
  assert.deepStrictEqual(e('Breaking.Bad.S02E05.720p.HDTV.x264-CTU'), { season: 2, episode: 5 });
  assert.deepStrictEqual(e('Breaking Bad - 2x05 - Breakage'), { season: 2, episode: 5 });
  assert.deepStrictEqual(e('Breaking.Bad.2008.S2.Ep.05.720p.BluRay'), { season: 2, episode: 5 });
  assert.deepStrictEqual(e('Breaking Bad Season 2 Episode 05 - Breakage'), { season: 2, episode: 5 });
  assert.deepStrictEqual(e('breaking.bad.s02e01-13.dvdrip.xvid-nodlabs'), { season: 2, episode: 1, to: 13 });
  assert.deepStrictEqual(e('Breaking Bad, SEASON 2 1080p x265 [23.976 FPS]'), { season: 2, pack: true });
  assert.strictEqual(e('bb205-clue'), null);
  assert.strictEqual(e('Inception.2010.1920x1080.x264'), null, 'a picture size is not 19x10');
  const other = (n) => C.namesOtherEpisode(n, 2, 5);
  assert.ok(other('Narcos.S02E06.WEBRip') && other('Show.S03E05') && other('Show.S02E06-E07'));
  assert.ok(!other('Show.S02E05') && !other('Show.S02E04-E06') && !other('Show.S02.Complete') && !other('Episode 5 - Breakage') && !other('bb205-clue'));
});

test('a season’s zip: the episode’s own file, however the files are named — and never just the biggest', () => {
  const pack = (names) => zip(names.map((n, i) => ({ name: n, data: /^00 /.test(n) ? 'Subtitles by someone' : big(n) + (i === 7 ? big('longest') : '') })));
  const pick = (names, ep, title) => pickFromDownload(pack(names), { season: 2, episode: ep, title }).toString().split('\n')[2];
  // "05 Breakage.en.srt": numbered through, no season in sight (the biggest file — episode 8 — used to be given for every episode).
  const numbered = ['00 Breaking Bad, SEASON 2 1080p x265 [23.976 FPS].srt', '01 Seven Thirty-Seven.en.srt', '02 Grilled.en.srt', '03 Bit by a Dead Bee.en.srt', '04 Down.en.srt', '05 Breakage.en.srt', '06 Peekaboo.en.srt', '07 Negro y Azul.en.srt', '08 Better Call Saul.en.srt', '09 4 Days Out.en.srt', '10 Over.en.srt', '11 Mandala.en.srt', '12 Phoenix.en.srt', '13 ABQ.en.srt'];
  assert.match(pick(numbered, 5), /^05 Breakage/);
  assert.match(pick(numbered, 9), /^09 4 Days Out/);
  assert.match(pick(numbered, 13), /^13 ABQ/);
  assert.throws(() => pick(numbered, 14), (e) => e.noEpisode && /no file for episode 14/.test(e.message));
  assert.throws(() => pick(numbered.slice(0, 8), 9), /no file for episode 9/, 'a pack that stops at episode 7');
  // Mixed naming in one zip, a title in the name, "Show - 05 [720p]".
  assert.match(pick(['aaf-breaking.bad.s02e04.down.EN.srt', 'aaf-breaking.bad.s02e05.breakage.EN.srt', 'breaking.bad.s02e08.dvdrip.xvid-nodlabs.EN.srt'], 5), /s02e05/);
  assert.match(pick(['Show - 04 [720p].srt', 'Show - 05 [720p].srt', 'Show - 06 [720p].srt', 'Show - 10 [720p].srt'], 5), /Show - 05/);
  assert.match(pick(['Seven Thirty-Seven.srt', 'Grilled.srt', 'Breakage.srt'], 5, 'Breakage'), /^Breakage/);
  assert.throws(() => pick(['Seven Thirty-Seven.srt', 'Grilled.srt', 'Breakage.srt'], 5, 'Peekaboo'), /no file for episode 5/, 'nothing says which is which: none, not a guess');
  // A "season pack" that turns out to hold one other episode (only episode 7 has foreign speech in it).
  assert.throws(() => pick(['Breaking.Bad.S02E07.1080p.BluRay.x265-RARBG (NON ENGLISH ONLY).srt'], 5), (e) => e.noEpisode);
  assert.match(pick(['whatever.srt'], 5), /^whatever/, 'one file that names no episode: it is what there is');
  // The full file rather than the foreign-parts-only one beside it.
  assert.match(pickFromDownload(zip([{ name: 'Show.S02E05.forced.srt', data: big('forced') + big('x') + big('y') }, { name: 'Show.S02E05.srt', data: big('full') }]), { season: 2, episode: 5 }).toString().split('\n')[2], /^full/);
  // A film: not one disc of two.
  assert.match(pickFromDownload(zip([{ name: 'film-cd1.srt', data: big('one') + big('more') }, { name: 'film.srt', data: big('whole') }]), {}).toString().split('\n')[2], /^whole/);
  assert.throws(() => pickFromDownload(zip([{ name: 'film-cd1.srt', data: big('one') }, { name: 'film-cd2.srt', data: big('two') }]), {}), /split in parts/);
});

test('what a listing is, read from its name and comment (the tick-boxes lose to the words)', () => {
  const d = (raw) => N.describe(raw);
  // Foreign parts only ("forced").
  assert.strictEqual(d({ name: 'Inglourious.Basterds.2009.1080p.BluRay.x265-RARBG.en-forced' }).kind, 'foreign');
  assert.strictEqual(d({ name: 'Inglourious Basterds 2009 full bluray rip', comment: 'Just for non-English speaking parts', hi: true }).kind, 'foreign');
  assert.strictEqual(d({ name: 'CompleteSeason2(AllBluRayRips)(NONENGLISHONLY)', comment: 'NON ENGLISH PARTS ONLY!! This should work for all BluRay Rips.' }).kind, 'foreign');
  assert.strictEqual(d({ name: 'Narcos - S01E01 - Descenso.English.Forced', foreign: true }).kind, 'foreign');
  assert.strictEqual(d({ name: 'BluRay.1080p.DTS.x264.dxva-EuReKA', comment: 'Full subs only. Not forced.', foreign: true }).kind, 'full', 'ticked "foreign parts only", says otherwise');
  assert.strictEqual(d({ name: 'Film (2160p BluRay x265 Tigole)', comment: 'SDH. Foreign parts NOT included as they are already hardcoded into the video.', hi: true }).kind, 'sdh');
  assert.strictEqual(d({ name: 'Film.2009.UHD.BluRay', comment: 'Includes all French & German parts. Properly synced.' }).kind, 'full');
  // For the hard of hearing — or not.
  assert.strictEqual(d({ name: 'Narcos.S01E01.1080p.NF.WEBRip.DD5.1.x264-NTb.mkv', file: 'Narcos.S01E01.1080p.NF.WEBRip.DD5.1.x264-NTb.en.hi' }).kind, 'sdh');
  assert.strictEqual(d({ name: 'Inglourious.Basterds.2009.720p.BrRip.x264.YIFY', comment: '♥❤️😊 SDH Perfect Sync ♥ Blu Ray 720p, 1080p ♥' }).kind, 'sdh');
  assert.strictEqual(d({ name: 'InglouriousBasterds(2009)UHDBluRay2h.32m.53s', comment: 'OCR&#39;d from UHD BluRay, removed HI / SDH, manually added italics', hi: true }).kind, 'full', 'SubDL ticks "hearing impaired" on these');
  assert.strictEqual(d({ name: 'Breaking Bad S02E05 Breakage.DVDRip.NonHI.cc.en.SNY', hi: true }).kind, 'full');
  assert.strictEqual(d({ name: 'Breaking.Bad.S02.720p.BluRay.x264-CLUE', comment: 'Retail. Removed HI.' }).kind, 'full');
  // What copy it was timed for.
  assert.deepStrictEqual(['Show.S01E01.1080p.NF.WEBRip.x264', 'Film.2010.720p.BluRay.x264-GRP', 'Show.S02E05.720p.HDTV.x264-CTU', 'Film[2010]DvDrip[Eng]-FXG', 'Film.Cam.XviD-FLAWL3SS', 'Film.2009.English Subs.TS.AC3.H264-LTT', 'Film.2009.DTS.x264', 'Breaking.Bad.S02.2160p.WEB-DL.TrollUHD-ULTRAHDCLUB']
    .map((n) => d({ name: n }).src), ['web', 'bluray', 'tv', 'dvd', 'cam', 'cam', '', 'web']);
  assert.strictEqual(d({ name: 'Film', fps: 25 }).fps, 25);
  assert.strictEqual(d({ name: 'Breaking Bad, SEASON 2 1080p x265 [23.976 FPS]' }).fps, 23.976);
  assert.strictEqual(d({ name: 'Crash.2004.DC.1080p.BluRay.x265-YAWNTiC_eng' }).cut, 'Director’s cut');
  assert.strictEqual(d({ name: 'Film.2009.Extended.1080p.BluRay.DTS.x264' }).cut, 'Extended cut');
  assert.strictEqual(d({ name: 'Film.2009.German.DL.1080p.BluRay.x264-QRC', comment: 'This subtitle is for the German retail version (1.5min longer than the US version!)' }).cut, 'German cut');
  assert.strictEqual(d({ name: 'Film.2009.1080p.DTS.x264' }).cut, '', 'DTS is not a director’s cut');
  // How long the uploader's copy is.
  assert.strictEqual(d({ name: 'InglouriousBasterds(2009)UHDBluRay2h.32m.53s' }).runtime, 9173);
  assert.strictEqual(d({ name: 'x', comment: 'SDH. Runtime 2:32:52' }).runtime, 9172);
  assert.strictEqual(d({ name: 'x', comment: '.Srt File | 949 MB (995921920 bytes) | 02:28:07 | 640 x 256' }).runtime, 8887);
  assert.strictEqual(d({ name: 'x', comment: 'Rip from NETFLIX. Runtime: 2h 32m (152 min)' }).runtime, 9120);
  assert.strictEqual(d({ name: 'x', comment: 'the German version is 1.5min longer' }).runtime, 0);
  // One disc of two.
  assert.strictEqual(d({ name: 'Inglourious Basterds (2009).CD2' }).part, 2);
  assert.strictEqual(d({ name: 'Inception.RERiP.DVDRiP.XviD-ARROW', file: 'arrow-inception-rr-cd1.en', files: 2 }).parts, 2);
  assert.strictEqual(d({ name: 'Inception.DVDRiP.XviD-ARROW', comment: 'join 2CD' }).part, 0);
  // Shown without the advertising.
  assert.strictEqual(N.cleanRelease('SUBDL.com::breaking.bad.second.season309204.zip'), 'breaking.bad.second.season309204');
  assert.strictEqual(N.cleanRelease('Breaking.Bad.2x05.Rotura.(Spa-Eng).DVB-Rip.by.Keane.(tusseries.com)'), 'Breaking.Bad.2x05.Rotura.(Spa-Eng).DVB-Rip.by.Keane');
  assert.strictEqual(N.cleanRelease('Breaking Bad S02E05 Breakage.DVDRip.NonHI.cc.en.SNY'), 'Breaking Bad S02E05 Breakage.DVDRip.NonHI.cc.en.SNY', 'dots in a release name are not web addresses');
  assert.strictEqual(N.cleanRelease('httpwww.wisevid.comerror.phptypevideo-missing'), '');
  assert.strictEqual(N.cleanNote('All subtitles for Season 2 PFT Release.\n\nVisit us at www.pencurimovie.cc'), 'All subtitles for Season 2 PFT Release.');
  assert.strictEqual(N.cleanNote('Plz comment and rate the Subtitle.'), '');
  assert.strictEqual(N.cleanNote('OCR&#39;d Blu-ray subs to text. Don&#39;t forget to rate/comment, enjoy!'), 'OCR\'d Blu-ray subs to text.');
  assert.strictEqual(N.cleanNote('Rip from NETFLIX. Runtime: 2h 32m (152 min) Imported from subscene.com/subtitles/x/english/12'), 'Rip from NETFLIX. Runtime: 2h 32m (152 min)');
});

test('listings for something else are left out, or put last with the reason', () => {
  const o = (raw, q) => N.otherTitle(N.describe(raw), raw, q);
  const ep = { query: 'Narcos', season: 1, episode: 1 };
  assert.deepStrictEqual(o({ name: 'Narcos.S01E02.WEBRip' }, ep), { drop: true, why: 'for another episode' });
  assert.ok(o({ name: 'bb101-clue', file: 'show.s01e03.srt' }, ep).drop);
  assert.ok(o({ name: 'El.Camino.S01E01.WEB' }, { query: 'Breaking Bad', season: 1, episode: 1 }).doubt, 'another name altogether');
  assert.strictEqual(o({ name: 'bb.S01E01.clue' }, { query: 'Breaking Bad', season: 1, episode: 1 }), null, 'its initials');
  assert.strictEqual(o({ name: 'Season 01 (dvdrip.xvid-nodlabs)', file: 'narcos.s01e01.dvdrip' }, ep), null);
  const spin = o({ name: 'Narcos.Mexico.S01E01.720p.WEBRip.x264-STRiFE' }, ep);
  assert.ok(spin.doubt && /Narcos Mexico/.test(spin.why), 'a spin-off filed under the show it came from');
  for (const n of ['Narcos.S01E01.Descenso.1080p.NF.WEBRip', 'Narcos S01E01 1080p x264 DD5.1 nl subs', 'Narcos.2015.S01E01.WEB', 'The.Office.US.S01E01.x']) assert.strictEqual(o({ name: n }, { ...ep, query: /Office/.test(n) ? 'The Office' : 'Narcos' }), null, n);
  const film = { query: 'Inception', year: 2010 };
  assert.ok(o({ name: 'ils.10.things.i.hate.about.you.1999.internal.dvdrip.xvid' }, film).drop, 'another film among this one’s');
  assert.strictEqual(o({ name: 'Nachalo.2010.DUAL.BDRip.XviD.AC3-HQCLUB' }, film), null, 'the same film under its name abroad');
  assert.strictEqual(o({ name: 'Inception[2010]DvDrip[Eng]-FXG' }, film), null);
});

test('best fit first: the video’s length, what people made of it, and what it is', () => {
  const j = (raw, x, q) => N.judge(N.describe(raw), { downloads: 500, ...x }, { query: 'Inglourious Basterds', dur: 9172, ...q });
  const same = j({ name: 'Film (2160p BluRay)', comment: 'Runtime 2:32:52' });
  const longer = j({ name: 'Film.German.DL.BluRay', comment: 'Runtime: 2:34:25' });
  const plain = j({ name: 'Film.2009.1080p.BluRay.x264' });
  assert.ok(same.score > plain.score && plain.score > longer.score);
  assert.ok(same.tags.includes('Same length as this video'));
  assert.match(longer.warn.join(' '), /Made for a copy 2 min longer than this video/);
  assert.match(j({ name: 'Film.2009.Extended.BluRay' }).warn.join(' '), /Extended cut/);
  assert.strictEqual(j({ name: 'Film.2009.Extended.BluRay' }, {}, { query: 'Film (Extended Edition)' }).warn.length, 0, 'the video is the extended cut too');
  assert.match(j({ name: 'Film', fps: 25 }).warn.join(' '), /25 fps/);
  assert.strictEqual(j({ name: 'Film', fps: 25 }, {}, { fps: 25 }).warn.length, 0);
  assert.match(j({ name: 'Film (2009).CD2' }).bad, /part 2/);
  assert.ok(j({ name: 'Film.Cam.XviD' }).score < plain.score);
  assert.ok(j({ name: 'Film' }, { votes: 3, rating: 2 }).score < j({ name: 'Film' }, { votes: 3, rating: 9.5 }).score);
  assert.ok(j({ name: 'Film.SDH' }, {}, { hi: true }).score > j({ name: 'Film' }, {}, { hi: true }).score, 'sounds described, when that is wanted');
});

test('a file against the video’s length; moving a file’s times', () => {
  const cues = (n, every, from = 10) => Array.from({ length: n }, (x, i) => ({ s: from + i * every, e: from + i * every + 2, text: 'x' }));
  assert.strictEqual(C.fit(cues(600, 5), 3100).ok, true);
  assert.deepStrictEqual((({ ok, why }) => ({ ok, why }))(C.fit(cues(600, 5), 2500)), { ok: false, why: 'long' }, 'lines after the video has ended');
  assert.strictEqual(C.fit(cues(600, 5), 3005).ok, true, 'a line a few seconds past the end is nothing');
  assert.strictEqual(C.fit(cues(300, 5), 5400).why, 'short', 'half a film: one disc of two, or an episode’s for a film');
  assert.strictEqual(C.fit(cues(14, 300), 5400).why, 'sparse', 'a few lines in a whole film: foreign parts only');
  assert.strictEqual(C.fit([], 5400).why, 'empty');
  assert.strictEqual(C.fit(cues(600, 5), 0).ok, true, 'length not known: only "hardly any lines" can be said');
  assert.strictEqual(C.fit(cues(14, 300), 0).why, 'sparse');
  const vtt = 'WEBVTT\n\n1\n00:00:10.000 --> 00:00:12.500\nOne\n\n00:01:00.000 --> 00:01:02.000 line:0\nTwo\n';
  assert.deepStrictEqual(C.cuesOf(vtt).map((c) => [c.s, c.e, c.text]), [[10, 12.5, 'One'], [60, 62, 'Two']]);
  assert.match(C.retimeVtt(vtt, 1, -11), /^WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.500\nOne\n\n00:00:49.000 --> 00:00:51.000 line:0\nTwo/);
  assert.ok(!/One/.test(C.retimeVtt(vtt, 1, -13)) && /Two/.test(C.retimeVtt(vtt, 1, -13)), 'a line that ends before 0 is dropped');
  assert.match(C.retimeVtt(vtt, 25 / 23.976, 0), /00:01:02.563 --> 00:01:04.648/);
  assert.strictEqual(C.retimeVtt(vtt, 1, 0), vtt);
  assert.ok(C.notSpeech('[music]') && C.notSpeech('♪ la la ♪') && C.notSpeech('(door slams)') && !C.notSpeech('Where were you?'));
});

test('listening: how far off a file is, another speed, the wrong episode — and "can’t tell" rather than a guess', async () => {
  const A = F.film(11, 1500), B = F.film(22, 1500);
  const go = (film, vtt, dur) => C.syncByEar({ cues: C.cuesOf(vtt), dur, read: F.reader(film.pcm) });
  const near = (x, y, tol) => Math.abs(x - y) <= tol;
  let r = await go(A, A.vtt, 1500);
  assert.ok(r.state === 'ok' && r.a === 1 && near(r.b, 0, 0.4), JSON.stringify(r));
  r = await go(A, C.retimeVtt(A.vtt, 1, 6), 1500); // the file's lines come 6 s late
  assert.ok(r.state === 'ok' && r.a === 1 && near(r.b, -6, 0.4), JSON.stringify(r));
  r = await go(A, C.retimeVtt(A.vtt, 1, -41.5), 1500); // …41.5 s early: a recap this copy has and the file's didn't
  assert.ok(r.state === 'ok' && near(r.b, 41.5, 0.4), JSON.stringify(r));
  // Its lines moved back into place are the original's.
  const fixed = C.cuesOf(C.retimeVtt(C.retimeVtt(A.vtt, 1, -41.5), r.a, r.b));
  assert.ok(near(fixed[fixed.length - 1].s, A.cues[A.cues.length - 1].s, 0.4));
  r = await go(A, C.retimeVtt(A.vtt, 23.976 / 25, 0), 1500); // timed for a 25 fps copy of this 23.976 video
  assert.ok(r.state === 'ok' && near(r.a, 25 / 23.976, 1e-6) && near(r.b, 0, 0.5), JSON.stringify(r));
  r = await go(A, C.retimeVtt(A.vtt, 24 / 23.976, 1), 1500); // a tenth of a percent out, and a second
  assert.ok(r.state === 'ok' && near(r.a, 23.976 / 24, 1e-6), JSON.stringify(r));
  assert.ok(near(C.cuesOf(C.retimeVtt(C.retimeVtt(A.vtt, 24 / 23.976, 1), r.a, r.b))[200].s, A.cues[200].s, 0.5));
  // Another episode's subtitles: nowhere.
  assert.strictEqual((await go(A, B.vtt, 1500)).state, 'mismatch');
  assert.strictEqual((await go(B, A.vtt, 1500)).state, 'mismatch');
  // Nothing to go on: no answer, not a wrong one.
  const quiet = { pcm: new Int16Array(1500 * F.RATE) };
  assert.strictEqual((await go(quiet, A.vtt, 1500)).state, 'unknown', 'silence');
  assert.strictEqual((await C.syncByEar({ cues: C.cuesOf(A.vtt), dur: 1500, read: async () => { throw new Error('no connection'); } })).state, 'unknown');
  assert.strictEqual((await go(A, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx\n', 1500)).state, 'unknown', 'a file with hardly a line');
  const clip = F.film(44, 200);
  assert.notStrictEqual((await go(clip, A.vtt, 200)).state, 'ok', 'a short clip with the wrong file');
});

// ---------------------------------------------------------------- the sources, with stand-ins
function sites(handler) {
  const asked = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    asked.push(u.pathname + u.search);
    const out = handler(u, req);
    if (!out) { res.writeHead(404); return res.end(); }
    if (Buffer.isBuffer(out)) { res.writeHead(200, { 'Content-Type': 'application/zip' }); return res.end(out); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ base: `http://127.0.0.1:${srv.address().port}`, asked, close: () => { srv.close(); srv.closeAllConnections(); } })));
}
const withEnv = async (env, fn) => { const old = {}; for (const k of Object.keys(env)) { old[k] = process.env[k]; process.env[k] = env[k]; } try { return await fn(); } finally { for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } } };

test('SubDL and OpenSubtitles: other episodes dropped, the key kept out of what browsers get, the right file fetched or none', async () => {
  const lines = (n, every) => Array.from({ length: n }, (x, i) => { const t = 5 + i * every, f = (v) => `${String(Math.floor(v / 3600)).padStart(2, '0')}:${String(Math.floor(v % 3600 / 60)).padStart(2, '0')}:${String(Math.floor(v % 60)).padStart(2, '0')},000`; return `${i + 1}\n${f(t)} --> ${f(t + 2)}\nLine ${i}\n`; }).join('\n');
  const m = await sites((u) => {
    if (u.pathname === '/sd/subtitles') {
      if (u.searchParams.get('film_name') === 'The Office') return { status: true, results: [{ name: 'The Office', year: 2005, tmdb_id: 2316 }], subtitles: [{ release_name: 'The.Office.US.S03E04', language: 'EN', url: '/subtitle/us.zip', season: 3, episode: 4 }] };
      if (u.searchParams.get('tmdb_id') === '2996') return { status: false, error: "Can't find movie or tv" };
      return { status: true, results: [{ name: 'Breaking Bad', tmdb_id: 1396 }], subtitles: [
        { release_name: 'Breaking Bad, SEASON 2 1080p x265 [23.976 FPS]', name: '00 Breaking Bad, SEASON 2.zip', language: 'EN', url: '/subtitle/numbered.zip?api_key=sdkey', season: 2, episode: null, full_season: true, fps: '23.976', hi: false, comment: '', releases: ['Breaking Bad, SEASON 2 1080p x265 [23.976 FPS]'] },
        { release_name: 'CompleteSeason2(AllBluRayRips)(NONENGLISHONLY)', language: 'EN', url: '/subtitle/e7only.zip?api_key=sdkey', season: 2, episode: null, full_season: true, comment: 'NON ENGLISH PARTS ONLY!!' },
        { release_name: 'breaking.bad.s02e01-04.dvdrip.xvid', language: 'EN', url: '/subtitle/early.zip?api_key=sdkey', season: 2, episode: 1, episode_from: 1, episode_end: 4 },
        { release_name: 'Breaking.Bad.S02E06.720p.HDTV', language: 'EN', url: '/subtitle/six.zip?api_key=sdkey', season: 2, episode: 6 },
        { release_name: 'Breaking.Bad.S03E05.720p.HDTV', language: 'EN', url: '/subtitle/s3.zip?api_key=sdkey', season: 3, episode: 5 },
        { release_name: 'Breaking.Bad.S02E05.Breakage.BluRay.Remux.1080p', language: 'EN', url: '/subtitle/remux.zip?api_key=sdkey', season: 2, episode: 5, episode_from: 5, episode_end: 5, comment: 'Retail subs. Spellchecked.' },
        { release_name: 'Breaking.Bad.S02E05.480p.BRRip.x264-BoB', language: 'EN', url: '/subtitle/short.zip?api_key=sdkey', season: 2, episode: 5, hi: true },
      ] };
    }
    if (u.pathname === '/dl/subtitle/numbered.zip') return zip(['01 Seven Thirty-Seven', '05 Breakage', '08 Better Call Saul'].map((n) => ({ name: n + '.en.srt', data: lines(n[1] === '8' ? 500 : 400, 6).replace(/Line/g, n) })));
    if (u.pathname === '/dl/subtitle/remux.zip') return zip([{ name: 'Breaking.Bad.S02E05.srt', data: lines(700, 6) }]); // (70 minutes of lines: for something longer than the video)
    if (u.pathname === '/dl/subtitle/short.zip') return zip([{ name: 'Breaking.Bad.S02E05.srt', data: lines(12, 200) }]);
    if (u.pathname === '/os/subtitles') {
      const mk = (id, release, s, e, extra = {}) => ({ id: String(id), attributes: { language: 'en', new_download_count: 100, release, files: [{ file_id: id, file_name: release }], feature_details: { season_number: s, episode_number: e }, ...extra } });
      return { data: [mk(1, 'Breaking.Bad.S02E05.720p.BluRay.x264-EbP', 2, 5, { fps: 25 }), mk(2, 'Breaking Bad - season 2', 2, 6), mk(3, 'Breaking.Bad.RERiP.DVDRiP', 2, 5, { files: [{ file_id: 3, file_name: 'bb-cd1' }, { file_id: 33, file_name: 'bb-cd2' }] }),
        mk(4, 'El.Camino.S02E05.WEB', 2, 5), mk(5, 'Breaking Bad S02E05 forced', 2, 5, { foreign_parts_only: true }), mk(6, 'Breaking.Bad.S02E05.WEB.x264', 2, 5, { machine_translated: true })] };
    }
    return null;
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subfit-'));
  try {
    await withEnv({ SUBDL_BASE: m.base + '/sd', SUBDL_DL_BASE: m.base + '/dl' }, async () => {
      const conf = { subdl: { apiKey: 'sdkey' }, sources: { gestdown: false }, opensubtitles: { apiKey: 'oskey' } };
      const subs = new Subtitles({ dataDir: dir, getConf: () => conf, fetch, osBase: m.base + '/os' });
      const q = { parentTmdb: 1396, query: 'Breaking Bad', season: 2, episode: 5, epTitle: 'Breakage', langs: ['en'], dur: 2820 };
      const list = await subs.search(q);
      // What SubDL was asked: every release name and the comments, and not "only the hearing-impaired ones".
      const ask = new URLSearchParams(m.asked.find((a) => a.startsWith('/sd/subtitles')).split('?')[1]);
      assert.deepStrictEqual([ask.get('releases'), ask.get('comment'), ask.get('hi')], ['1', '1', null]);
      // Other episodes, another season and a range that doesn't hold this one: gone. So are OpenSubtitles' filed under episode 6.
      const names = list.map((x) => x.name);
      assert.ok(!names.some((n) => /S02E06|S03E05|s02e01-04|season 2$/.test(n)), names.join(' | '));
      assert.ok(!JSON.stringify(list).includes('sdkey'), 'the SubDL key SubDL puts on each address never reaches a browser');
      const by = (re) => list.find((x) => re.test(x.name));
      assert.strictEqual(by(/NONENGLISHONLY/).kind, 'foreign');
      assert.strictEqual(by(/forced/).kind, 'foreign');
      assert.match(by(/RERiP/).bad, /2 parts/);
      assert.match(by(/El.Camino/).bad, /El Camino/);
      assert.ok(by(/x264-EbP/).warn.some((w) => /25 fps/.test(w)));
      assert.ok(by(/Remux/).tags.includes('Official text') && by(/Remux/).tags.includes('Blu-ray'));
      assert.strictEqual(by(/SEASON 2/).pack, true);
      // Whole subtitles that pass for this episode come first; foreign-only ones after; the doubtful last.
      const kinds = list.map((x) => (x.bad ? 'bad' : x.kind === 'foreign' ? 'foreign' : x.machine ? 'machine' : 'ok'));
      assert.deepStrictEqual(kinds, [...kinds].sort((a, b) => ['ok', 'machine', 'foreign', 'bad'].indexOf(a) - ['ok', 'machine', 'foreign', 'bad'].indexOf(b)));
      assert.strictEqual(list.filter((x) => x.best).length, 1);

      // Fetching automatically, for a 47-minute video: the "retail" one is for something 70 minutes long — passed
      // over; the season pack's own episode 5 (not its biggest file) is given. (The BRRip's has a dozen lines.)
      const got = await subs.auto(q, 'en', {});
      assert.match(got.name, /SEASON 2/);
      assert.match(fs.readFileSync(subs.file(got.token), 'utf8'), /05 Breakage 3/);
      assert.ok(got.passed.some((p) => /Remux.*long/.test(p)), got.passed.join(' | '));
      assert.strictEqual(subs.fitOf(await subs.get(list.find((x) => /BoB/.test(x.name)).id), q.dur).why, 'sparse');
      // A viewer says that one is wrong: not given again; nothing else fits, so nothing — not the foreign-parts file, not a guess.
      const skip = (tok) => (tok === got.token ? 'viewer' : '');
      assert.strictEqual(await subs.auto({ ...q, skip }, 'en', {}), null);
      assert.match((await subs.search({ ...q, skip })).find((x) => /SEASON 2/.test(x.name)).bad, /marked it as wrong/);
      // One that didn't line up with the sound: still there, after the others, and given when nothing else fits.
      const soft = (tok) => (tok === got.token ? 'sound' : '');
      const again = await subs.auto({ ...q, skip: soft }, 'en', {});
      assert.ok(again && again.unsure && again.token === got.token);
      // Episode 9 isn't in that pack: an error that says so (and automatic fetching moves on).
      await assert.rejects(subs.get(list.find((x) => /SEASON 2/.test(x.name)).id.replace(':5:', ':9:')), /no file for episode 9/);
      // Only the foreign-language parts, when that is what is asked for.
      assert.strictEqual((await subs.search({ ...q, kind: 'foreign' }))[0].kind, 'foreign');

      // Asked by name, SubDL answers with the first title of that name: another show (other number) isn't used.
      subs.clear();
      assert.strictEqual((await subs.search({ parentTmdb: 2996, query: 'The Office', season: 3, episode: 4, langs: ['en'] })).filter((x) => x.source === 'subdl').length, 0, 'the UK show isn’t given the US one’s');
    });
  } finally { m.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fetching automatically: a file a little past the video’s end is a last resort, one far past it is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subfit-near-'));
  try {
    const subs = new Subtitles({ dataDir: dir, getConf: () => ({}), fetch });
    subs.search = async () => [{ id: 'sd:0:0:/a', lang: 'en', name: 'A', kind: 'full' }, { id: 'sd:0:0:/b', lang: 'en', name: 'B', kind: 'full' }, { id: 'sd:0:0:/c', lang: 'en', name: 'C', kind: 'full' }];
    subs.get = async (id) => id.slice(-1);
    // (A: an episode 15 minutes longer. B: 45 seconds over — the same episode with its credits cut, perhaps.)
    subs.fitOf = (tok) => (tok === 'a' ? { ok: false, why: 'long', over: 900 } : tok === 'b' ? { ok: false, why: 'long', over: 45 } : { ok: false, why: 'sparse' });
    const got = await subs.auto({ dur: 2800 }, 'en', {});
    assert.ok(got.loose && got.token === 'b' && got.passed.length === 3, JSON.stringify(got));
    subs.fitOf = (tok) => (tok === 'c' ? { ok: true, why: '' } : { ok: false, why: 'long', over: 45 });
    assert.deepStrictEqual((({ token, loose }) => ({ token, loose }))(await subs.auto({ dur: 2800 }, 'en', {})), { token: 'c', loose: undefined }, 'one that fits is preferred');
    subs.fitOf = () => ({ ok: false, why: 'sparse' });
    assert.strictEqual(await subs.auto({ dur: 2800 }, 'en', {}), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- through the real server
const hasFfmpeg = spawnSync(cfg.ffmpeg, ['-version']).status === 0;
test('through the server: fetched subtitles are checked against the film’s sound, moved into time, and wrong ones passed over', { skip: !hasFfmpeg && 'needs ffmpeg' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subfit-srv-'));
  const mine = F.film(55, 600), other = F.film(66, 600);
  fs.writeFileSync(path.join(dir, 'a.wav'), F.wav(mine.pcm));
  const film = path.join(dir, 'film.mp4');
  const enc = spawnSync(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1', '-i', path.join(dir, 'a.wav'), '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart', '-y', film]);
  assert.strictEqual(enc.status, 0, String(enc.stderr));
  let hits = 0;
  const pv = http.createServer((req, res) => {
    if (!/\/movie\//.test(req.url)) { res.writeHead(404); return res.end(); }
    hits++;
    const size = fs.statSync(film).size, m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) { const a = +m[1], b = m[2] ? +m[2] : size - 1; res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' }); return fs.createReadStream(film, { start: a, end: b }).pipe(res); }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes' }); fs.createReadStream(film).pipe(res);
  });
  await new Promise((ok) => pv.listen(0, '127.0.0.1', ok));
  const late = mine.cues.map((c) => ({ s: c.s + 6, e: c.e + 6, text: c.text }));
  const m = await sites((u) => {
    if (u.pathname === '/sd/subtitles') return { status: true, results: [{ name: 'Quiet Words', year: 2021 }], subtitles: [
      { release_name: 'Quiet.Words.2021.1080p.BluRay.x264-GRP', language: 'EN', url: '/subtitle/other.zip?api_key=sdkey', comment: 'Retail subs' },
      { release_name: 'Quiet.Words.2021.WEBRip.x264-ABC', language: 'EN', url: '/subtitle/late.zip?api_key=sdkey', comment: '' },
      { release_name: 'Quiet.Words.2021.BluRay.x264-GRP.forced', language: 'EN', url: '/subtitle/forced.zip?api_key=sdkey' },
    ] };
    if (u.pathname === '/dl/subtitle/other.zip') return zip([{ name: 'other.srt', data: F.toSrt(other.cues) }]);
    if (u.pathname === '/dl/subtitle/late.zip') return zip([{ name: 'late.srt', data: F.toSrt(late) }]);
    if (u.pathname === '/dl/subtitle/forced.zip') return zip([{ name: 'forced.srt', data: F.toSrt(mine.cues.slice(0, 3)) }]);
    return null;
  });
  const port = await freePort();
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(dir, 'data'), NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test', SUBDL_BASE: m.base + '/sd', SUBDL_DL_BASE: m.base + '/dl' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const a = { cookie: '' };
  a.raw = (method, p, body, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-App': '1', ...(a.cookie ? { Cookie: a.cookie } : {}), ...headers }, body });
  a.req = async (method, p, body) => {
    const r = await a.raw(method, p, body !== undefined ? JSON.stringify(body) : undefined, body !== undefined ? { 'Content-Type': 'application/json' } : {});
    const sc = r.headers.get('set-cookie');
    if (sc) a.cookie = sc.split(';')[0];
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, text: t };
  };
  try {
    for (let i = 0; i < 150 && !/Ready/.test(out); i++) await wait(100);
    assert.match(out, /Ready/, out.slice(-500));
    assert.strictEqual((await a.req('POST', '/api/login', { password: 'pw-test' })).status, 200);
    assert.strictEqual((await a.req('POST', '/api/profiles', { name: 'Alex', pin: '4821' })).status, 200);
    const M3U = `#EXTM3U\n#EXTINF:-1 group-title="Films",Quiet Words (2021)\nhttp://127.0.0.1:${pv.address().port}/movie/u/p/1.mp4\n`;
    assert.strictEqual((await a.raw('POST', '/api/admin/lists/upload?name=L&fileName=l.m3u', Buffer.from(M3U))).status, 200);
    let it = null;
    for (let i = 0; i < 60 && !it; i++) { const cat = (await a.req('GET', '/api/catalog')).json; it = cat && cat.items && cat.items.find((x) => /Quiet Words/.test(x.n)); if (!it) await wait(200); }
    assert.ok(it);
    assert.strictEqual((await a.req('PUT', '/api/admin/integrations', { subdl: { apiKey: 'sdkey' }, sources: { gestdown: false } })).status, 200);
    const admin = (await a.req('GET', '/api/admin/integrations')).json;
    assert.deepStrictEqual([admin.subListen, admin.canListen], ['spare', true]);
    assert.strictEqual((await a.req('GET', '/api/boot')).json.subListen, true);
    const k = encodeURIComponent(it.k);
    const search = async () => (await a.req('GET', `/api/opensubs/search?k=${k}&dur=600`)).json.list;
    const auto = async () => (await a.req('POST', '/api/opensubs/auto', { k: it.k, lang: 'en', dur: 600 })).json;

    // What a device is shown: what each is, in words; nothing with the SubDL key in it.
    const list = await search();
    assert.deepStrictEqual(list.map((x) => [x.what, x.best]), [['Everything spoken', true], ['Everything spoken', false], ['Foreign-language parts only', false]]);
    assert.ok(list[0].tags.includes('Blu-ray') && list[0].tags.includes('Official text') && list[1].tags.includes('Streaming'));
    assert.ok(!JSON.stringify(list).includes('sdkey'));

    // As it comes: listening only when it is known to cost the viewer nothing. This provider's limit isn't known — not a byte is read.
    const first = await auto();
    assert.match(first.name, /BluRay.x264-GRP$/);
    assert.strictEqual(first.checking, false);
    assert.match(first.url, new RegExp(`^/api/opensubs/file/${first.id}\\?k=`));
    await wait(300);
    assert.strictEqual(hits, 0);
    assert.strictEqual((await a.req('POST', '/api/opensubs/check', { k: it.k, id: 'zz' })).status, 400);

    // The admin lets it listen whenever the provider isn't known to be full.
    assert.strictEqual((await a.req('PUT', '/api/admin/integrations', { subListen: 'always' })).json.subListen, 'always');
    assert.strictEqual((await auto()).checking, true);
    // The "retail" ones are another film's: they line up with this one's sound nowhere, and drop behind the others.
    let now = null;
    assert.ok(await until(async () => { now = await search(); return now.some((x) => (x.warn || []).some((w) => /line up with this video’s sound/.test(w))); }), out.slice(-800));
    assert.match(now[now.length - 2].name, /BluRay.x264-GRP$/, 'after the one not yet doubted, before nothing but the foreign-parts one');
    assert.ok(hits > 0);
    // The next best: right words, 6 seconds late. Given at once; moved once the server has listened.
    const second = await auto();
    assert.match(second.name, /WEBRip/);
    assert.strictEqual(second.checking, true);
    let third = null;
    assert.ok(await until(async () => { third = await auto(); return !!third.moved; }), out.slice(-800));
    assert.ok(Math.abs(third.moved.secs + 6) <= 0.5 && !third.moved.speed, JSON.stringify(third.moved));
    assert.notStrictEqual(third.url, second.url, 'a new address, so no device keeps the old timing');
    const fixed = C.cuesOf((await a.req('GET', third.url)).text), raw = C.cuesOf((await a.req('GET', `/api/opensubs/file/${third.id}`)).text);
    assert.ok(Math.abs(fixed[20].s - mine.cues[20].s) <= 0.5, `${fixed[20].s} against ${mine.cues[20].s}`);
    assert.ok(Math.abs(raw[20].s - mine.cues[20].s - 6) < 0.01, 'the file itself is kept as it came: the timing belongs to this title');
    assert.match(out, /Subtitles: listened to “Quiet Words[^\n]*moved -6/);
    // Remembered: asking again doesn't read the film again.
    const before = hits;
    assert.ok((await auto()).moved);
    await wait(300);
    assert.strictEqual(hits, before);

    // "Wrong subtitles?": not given again for this title; what is left is the pair that didn't line up — said to be unsure.
    assert.strictEqual((await a.req('POST', '/api/opensubs/bad', { k: it.k, id: third.id })).status, 200);
    const fourth = await auto();
    assert.ok(/BluRay.x264-GRP$/.test(fourth.name) && fourth.unsure && !fourth.checking);
    assert.match((await search()).find((x) => /WEBRip/.test(x.name)).bad, /marked it as wrong/);
    // Picked by hand all the same: allowed, and its lines' length against the video's said.
    const picked = (await a.req('POST', '/api/opensubs/get', { id: list[2].id, k: it.k, dur: 600 })).json;
    assert.match(picked.warn, /only 3 lines/);
    // Turned off: no listening, not even when asked.
    await a.req('PUT', '/api/admin/integrations', { subListen: 'never' });
    assert.strictEqual((await a.req('GET', '/api/boot')).json.subListen, false);
    const refused = await a.req('POST', '/api/opensubs/check', { k: it.k, id: fourth.id, dur: 600 });
    assert.strictEqual(refused.status, 409);
    assert.match(refused.json.error, /turned off/);
  } finally {
    const gone = new Promise((ok) => app.once('exit', ok));
    app.kill();
    await Promise.race([gone, wait(3000)]); // (it is still writing its files as it goes)
    m.close();
    pv.close(); pv.closeAllConnections();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
});
