'use strict';
// More formats on more devices: what's passed on as it is and what's converted for a device, by what the device says
// it decodes; MP4 pieces for AV1 and VP9; files without picture timestamps (AVI); HDR brought down to ordinary
// colours; a copy started part-way says where its picture really starts; sound that can't be decoded is left out.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Media } = require('../lib/media');

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), n + '-'));
const S = { maxSessions: 4, transcodePreset: 'ultrafast' };
const newMedia = () => new Media({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', hwaccel: '' }, tmp('fmt'), () => S);
const enc = spawnSync('ffmpeg', ['-hide_banner', '-encoders']);
const has = (e) => enc.status === 0 && new RegExp('\\s' + e + '\\s').test(String(enc.stdout));
const hasFfmpeg = enc.status === 0 && has('libx264') && spawnSync('ffprobe', ['-version']).status === 0;
const gen = (dir, name, args) => {
  const out = path.join(dir, name);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6', ...args, out]);
  return r.status === 0 ? out : null;
};
const look = (file) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', '-count_packets', file], { maxBuffer: 16 << 20 });
  const j = JSON.parse(String(r.stdout) || '{}');
  const v = (j.streams || []).find((x) => x.codec_type === 'video'), a = (j.streams || []).find((x) => x.codec_type === 'audio');
  return { v, a, dur: j.format ? +j.format.duration : 0 };
};
const done = async (s) => { for (let i = 0; i < 400 && !s.exited; i++) await new Promise((r) => setTimeout(r, 50)); return s; };

test('what a device is sent as it is, and what is converted for it', () => {
  const m = newMedia();
  const f = (vcodec, pixfmt, extra) => ({ vcodec, pixfmt: pixfmt || 'yuv420p', width: 1920, height: 1080, ...extra });
  // H.264 everywhere; not 10-bit or 4:2:2 / 4:4:4.
  assert.strictEqual(m.needsVideoTranscode(f('h264'), ['h264']), false);
  assert.strictEqual(m.needsVideoTranscode(f('h264', 'yuv420p10le'), ['h264', 'hevc']), true);
  assert.strictEqual(m.needsVideoTranscode(f('h264', 'yuv422p'), ['h264']), true);
  assert.strictEqual(m.needsVideoTranscode(f('hevc', 'yuv444p10le'), ['h264', 'hevc']), true, 'no browser decodes 4:4:4');
  // HEVC where the device has it; 10-bit only where its HEVC isn't 8-bit only.
  assert.strictEqual(m.needsVideoTranscode(f('hevc'), ['h264']), true);
  assert.strictEqual(m.needsVideoTranscode(f('hevc'), ['h264', 'hevc']), false);
  assert.strictEqual(m.needsVideoTranscode(f('hevc', 'yuv420p10le'), ['h264', 'hevc']), false, 'as before when the device says nothing');
  assert.strictEqual(m.needsVideoTranscode(f('hevc', 'yuv420p10le'), ['h264', 'hevc'], { hevc10: false }), true);
  assert.strictEqual(m.needsVideoTranscode(f('hevc', 'yuv420p'), ['h264', 'hevc'], { hevc10: false }), false, '8-bit HEVC is still passed on');
  // AV1 and VP9: only for a device that takes them in MP4 pieces.
  assert.strictEqual(m.needsVideoTranscode(f('av1'), ['h264', 'av1']), true, 'saying "av1" alone isn\'t enough: MPEG-TS can\'t carry it');
  assert.strictEqual(m.needsVideoTranscode(f('av1'), ['h264', 'av1'], { fmp4: ['av1', 'vp9'] }), false);
  assert.strictEqual(m.needsVideoTranscode(f('vp9'), ['h264', 'vp9'], { fmp4: ['av1'] }), true);
  assert.strictEqual(m.needsVideoTranscode(f('vp9'), ['h264', 'vp9'], { fmp4: ['vp9'] }), false);
  assert.strictEqual(m.needsVideoTranscode(f('av1'), ['h264'], { fmp4: ['av1'] }), true, 'not without the codec itself');
  // Everything else is converted.
  for (const c of ['mpeg2video', 'mpeg4', 'vc1', 'wmv3', 'vp8', 'theora', 'mjpeg']) assert.strictEqual(m.needsVideoTranscode(f(c), ['h264', 'hevc', 'av1', 'vp9'], { fmp4: ['av1', 'vp9'] }), true, c);
  // Taller than the device decodes.
  const k4 = (c) => f(c, 'yuv420p', { width: 3840, height: 2160 });
  assert.strictEqual(m.needsVideoTranscode(k4('h264'), ['h264'], { maxH: { h264: 1080 } }), true);
  assert.strictEqual(m.needsVideoTranscode(k4('hevc'), ['h264', 'hevc'], { maxH: { hevc: 1080 } }), true);
  assert.strictEqual(m.needsVideoTranscode(k4('hevc'), ['h264', 'hevc'], { maxH: { h264: 1080 } }), false, 'a limit is per format');
  assert.strictEqual(m.needsVideoTranscode(f('h264'), ['h264'], { maxH: { h264: 1080 } }), false);
  assert.strictEqual(m.needsVideoTranscode(f('h264', 'yuv420p', { width: 1920, height: 1088 }), ['h264'], { maxH: { h264: 1080 } }), false, 'a few lines over is the same picture');
  assert.strictEqual(m.needsVideoTranscode(f('h264', 'yuv420p', { width: 1080, height: 1920 }), ['h264'], { maxH: { h264: 1080 } }), false, 'a phone video on its side');
  // No look inside: nothing to go on, as before.
  assert.strictEqual(m.needsVideoTranscode(null, ['h264']), false);

  // The pieces a copy goes out in.
  assert.strictEqual(m.segmentsFor(f('h264'), { fmp4: ['av1'], hevcMp4: true }), 'ts');
  assert.strictEqual(m.segmentsFor(f('av1'), { fmp4: ['av1'] }), 'fmp4');
  assert.strictEqual(m.segmentsFor(f('vp9'), null), 'fmp4');
  assert.strictEqual(m.segmentsFor(f('hevc'), null), 'ts');
  assert.strictEqual(m.segmentsFor(f('hevc'), { hevcMp4: true }), 'fmp4', 'Apple\'s own player');
  // HDR, and what this ffmpeg can't decode.
  assert.strictEqual(m.hdrKind({ transfer: 'smpte2084' }), 'smpte2084');
  assert.strictEqual(m.hdrKind({ transfer: 'arib-std-b67' }), 'arib-std-b67');
  assert.strictEqual(m.hdrKind({ transfer: 'bt709' }), '');
  assert.strictEqual(m.canTonemap, false, 'not before the server has looked at its ffmpeg');
  m.noDecode.add('ac4');
  assert.strictEqual(m.canDecode('ac4'), false);
  assert.strictEqual(m.canDecode('aac'), true);
  assert.strictEqual(m.canDecode('some_new_codec'), true, 'an unknown name is tried');
  assert.strictEqual(m.canDecode(''), false);
});

test('conversions: AVI copies, MP4 pieces for AV1, where a copy really starts, HDR, no sound', { skip: !hasFfmpeg && 'no ffmpeg with libx264', timeout: 120000 }, async (t) => {
  const dir = tmp('fmtsrc');
  const m = newMedia();
  await m.detect();
  assert.ok(!m.noDecode.has('aac') && !m.noDecode.has('h264'));

  await t.test('an AVI whose H.264 has B-frames (no picture timestamps) is copied', async () => {
    const src = gen(dir, 'b.avi', ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '50', '-bf', '2', '-c:a', 'ac3']);
    assert.ok(src);
    const pr = await m.probe(src, {});
    assert.strictEqual(m.needsVideoTranscode(pr, ['h264']), false);
    const s = await done(await m.startSession({ input: src, live: false, video: 'copy', label: 'avi' }));
    assert.strictEqual(s.code, 0, s.stderr);
    const o = look(path.join(s.dir, 'index.m3u8'));
    assert.strictEqual(o.v.codec_name, 'h264');
    assert.strictEqual(+o.v.nb_read_packets, 150);
    assert.strictEqual(o.a.codec_name, 'aac');
    m.stopSession(s.id);
  });

  await t.test('a copy started part-way says where its picture starts', async () => {
    const src = gen(dir, 'k.mkv', ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-c:a', 'aac']);
    assert.ok(src);
    // Key frames every 2 s: asked for 3 s, the picture starts at 2 s and the sound at 3 s.
    const s = await done(await m.startSession({ input: src, live: false, seek: 3, video: 'copy', keyed: true, label: 'seek' }));
    assert.strictEqual(s.code, 0, s.stderr);
    assert.ok(Math.abs(s.offset - 2) < 0.06, 'counted from the key frame before: ' + s.offset);
    const o = look(path.join(s.dir, 'index.m3u8'));
    assert.strictEqual(+o.v.nb_read_packets, 100, 'the picture from 2 s to the end');
    // The same while the playlist is still growing (no end mark yet), as it is when a real film's copy has just begun.
    const pl = path.join(s.dir, 'index.m3u8');
    fs.writeFileSync(pl, fs.readFileSync(pl, 'utf8').replace(/#EXT-X-ENDLIST\s*/, ''));
    assert.ok(Math.abs((await m._keyTime(s, false)) - 2) < 0.06, 'read from the first piece');
    m.stopSession(s.id);
    // In MP4 pieces too (they carry the times as they are, MPEG-TS 1.4 s late).
    const s4 = await done(await m.startSession({ input: src, live: false, seek: 3, video: 'copy', fmp4: true, vcodec: 'h264', keyed: true, label: 'seek-mp4' }));
    assert.strictEqual(s4.seg, 'fmp4');
    assert.ok(Math.abs(s4.offset - 2) < 0.06, 'MP4 pieces: ' + s4.offset);
    m.stopSession(s4.id);
    // Asked for a key frame itself: nothing to correct.
    const s5 = await done(await m.startSession({ input: src, live: false, seek: 4.03, video: 'copy', keyed: true, label: 'seek-key' }));
    assert.ok(Math.abs(s5.offset - 4.03) < 0.06, 'on a key frame: ' + s5.offset);
    m.stopSession(s5.id);
    // A TV's or console's own player (it doesn't ask): the copy exactly as before, counted from the point asked for.
    const s6 = await done(await m.startSession({ input: src, live: false, seek: 3, video: 'copy', label: 'seek-tv' }));
    assert.strictEqual(s6.offset, 3);
    assert.ok(+look(path.join(s6.dir, 'index.m3u8')).v.start_time < 2, 'its clock starts at zero');
    m.stopSession(s6.id);
    // Re-encoded: cut exactly, so the point asked for stands.
    const s2 = await done(await m.startSession({ input: src, live: false, seek: 3, video: 'h264', label: 'seek2' }));
    assert.strictEqual(s2.offset, 3);
    m.stopSession(s2.id);
  });

  await t.test('AV1 is passed on in MP4 pieces', { skip: !has('libsvtav1') && 'no AV1 encoder here' }, async () => {
    const src = gen(dir, 'a.mkv', ['-c:v', 'libsvtav1', '-preset', '12', '-g', '50', '-svtav1-params', 'log=0', '-c:a', 'libopus']);
    assert.ok(src);
    const pr = await m.probe(src, {});
    const caps = { fmp4: ['av1'] };
    assert.strictEqual(m.needsVideoTranscode(pr, ['h264', 'av1'], caps), false);
    const s = await done(await m.startSession({ input: src, live: false, video: 'copy', fmp4: m.segmentsFor(pr, caps) === 'fmp4', vcodec: pr.vcodec, label: 'av1' }));
    assert.strictEqual(s.code, 0, s.stderr);
    assert.strictEqual(s.seg, 'fmp4');
    const files = fs.readdirSync(s.dir);
    assert.ok(files.includes('init.mp4') && files.some((x) => /^seg\d+\.m4s$/.test(x)) && !files.some((x) => /\.ts$/.test(x)), files.join(' '));
    assert.match(fs.readFileSync(path.join(s.dir, 'index.m3u8'), 'utf8'), /#EXT-X-MAP:URI="init\.mp4"/);
    const o = look(path.join(s.dir, 'index.m3u8'));
    assert.strictEqual(o.v.codec_name, 'av1');
    assert.strictEqual(o.a.codec_name, 'aac');
    m.stopSession(s.id);
    // For a device without it: converted to H.264 in MPEG-TS, as ever.
    const s2 = await done(await m.startSession({ input: src, live: false, video: 'h264', fmp4: true, vcodec: pr.vcodec, label: 'av1-conv' }));
    assert.strictEqual(s2.seg, 'ts', 'a conversion never goes out in MP4 pieces');
    assert.strictEqual(look(path.join(s2.dir, 'index.m3u8')).v.codec_name, 'h264');
    m.stopSession(s2.id);
  });

  await t.test('HDR is brought down to ordinary colours when converted', { skip: (!has('libx265') || !m.canTonemap) && 'no HEVC encoder or no zscale here' }, async () => {
    // (Marked HDR10 — and only partly, as some files are: the colours are stated to the filter, or it stops.)
    const src = gen(dir, 'h.mkv', ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error:keyint=50:transfer=smpte2084', '-color_trc', 'smpte2084', '-c:a', 'aac']);
    assert.ok(src);
    const pr = await m.probe(src, {});
    assert.strictEqual(m.hdrKind(pr), 'smpte2084');
    const s = await done(await m.startSession({ input: src, live: false, video: 'h264', hdr: m.hdrKind(pr), label: 'hdr' }));
    assert.strictEqual(s.code, 0, s.stderr);
    assert.strictEqual(s.tone, true);
    const o = look(path.join(s.dir, 'index.m3u8'));
    assert.strictEqual(o.v.codec_name, 'h264');
    assert.strictEqual(o.v.pix_fmt, 'yuv420p');
    assert.strictEqual(o.v.color_transfer, 'bt709', 'no longer marked HDR');
    m.stopSession(s.id);
    // The step stopping ffmpeg must not cost the film: without it, the colours as before.
    const real = m.filters;
    m.filters = new Set([...real, 'zscale', 'tonemap', 'setparams']);
    const orig = m._start.bind(m);
    let calls = 0;
    m._start = async (o2) => { calls++; if (o2.hdr) { const e = new Error('filter'); e.stderr = '[Parsed_zscale_1 @ 0x1] code 3074: no path between colorspaces'; throw e; } return orig(o2); };
    const s3 = await done(await m.startSession({ input: src, live: false, video: 'h264', hdr: 'smpte2084', label: 'hdr-fallback' }));
    assert.strictEqual(calls, 2);
    assert.strictEqual(s3.tone, false);
    assert.strictEqual(s3.code, 0, s3.stderr);
    m.stopSession(s3.id);
    m._start = orig;
  });

  await t.test('sound left out, interlaced pictures deinterlaced', async () => {
    const src = gen(dir, 'i.ts', ['-vf', 'interlace,fieldorder=tff', '-r', '25', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-flags', '+ilme+ildct', '-x264opts', 'tff=1', '-g', '25', '-c:a', 'mp2']);
    assert.ok(src);
    const pr = await m.probe(src, {});
    assert.ok(pr.field, 'the look inside says it is interlaced: ' + JSON.stringify(pr.field));
    const s = await done(await m.startSession({ input: src, live: false, video: 'h264', interlaced: !!pr.field, noAudio: true, label: 'int' }));
    assert.strictEqual(s.code, 0, s.stderr);
    assert.strictEqual(s.noAudio, true);
    const o = look(path.join(s.dir, 'index.m3u8'));
    assert.strictEqual(o.a, undefined, 'no sound track');
    assert.ok(!o.v.field_order || o.v.field_order === 'progressive', 'progressive now: ' + o.v.field_order);
    m.stopSession(s.id);
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

// (The pieces above keep timers of their own: nothing to wait for here.)
test.after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });
