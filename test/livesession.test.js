// Live conversions on the server (lib/media.js): they start, and copying subtitles aside can never stop the picture.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Media } = require('../lib/media');
const cfg = require('../lib/config');

const hasFfmpeg = spawnSync(cfg.ffmpeg, ['-version']).status === 0;

test('live conversions start, and a failing subtitle copy is dropped instead of the picture', { skip: !hasFfmpeg && 'no ffmpeg', timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  const input = path.join(dir, 'in.ts');
  const r = spawnSync(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-f', 'mpegts', input]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  const media = new Media(cfg, dir, () => ({}));
  await media.detect();
  assert.ok(media.available);
  const ok = (s) => fs.readFileSync(path.join(s.dir, 'index.m3u8'), 'utf8').includes('#EXTINF');
  try {
    // A plain live conversion (no extra outputs), and one with "Convert on the server" (transcode).
    let s = await media.startSession({ input, headers: {}, live: true, label: 'plain' });
    assert.ok(ok(s));
    media.stopSession(s.id);
    s = await media.startSession({ input, headers: {}, live: true, video: 'transcode', label: 'transcode' });
    assert.ok(ok(s));
    media.stopSession(s.id);
    // An extra output that makes ffmpeg fail (a subtitle stream the input doesn't have): started again without it.
    let asked = 0;
    media.sessionOutputs = async ({ dir: d }) => { asked++; return ['-map', '0:s:7', '-c:s', 'copy', '-f', 'mpegts', path.join(d, 'subs.ts')]; };
    s = await media.startSession({ input, headers: {}, live: true, label: 'bad side output' });
    assert.ok(ok(s), 'the picture still plays');
    assert.strictEqual(asked, 1, 'asked once, then left out');
    media.stopSession(s.id);
    // A working extra output is kept.
    media.sessionOutputs = async ({ dir: d }) => ['-map', '0:a:0', '-c:a', 'copy', '-f', 'mpegts', path.join(d, 'side.ts')];
    // (another stream: the one above is now remembered as one whose subtitles are left out)
    const input2 = path.join(dir, 'in2.ts');
    fs.copyFileSync(input, input2);
    s = await media.startSession({ input: input2, headers: {}, live: true, label: 'good side output' });
    assert.ok(ok(s));
    for (let i = 0; i < 20 && !fs.existsSync(path.join(s.dir, 'side.ts')); i++) await new Promise((res) => setTimeout(res, 200));
    assert.ok(fs.existsSync(path.join(s.dir, 'side.ts')));
    media.stopSession(s.id);
  } finally {
    media.stopAll();
  }
});
