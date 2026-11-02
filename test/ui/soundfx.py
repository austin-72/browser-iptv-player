# Clear dialogue and night mode (web/js/soundfx.js), checked with test tones in the browser:
#   - clear dialogue lifts 1-4 kHz and lowers the bass and the top;
#   - night mode makes loud sound quieter and quiet sound louder;
#   - switching either on or off mid-sound makes no jump between samples (no click).
# Usage: python3 test/ui/soundfx.py http://localhost:8080 <site password> <profile name> [PIN]
import sys
from playwright.sync_api import sync_playwright
B, PW, NAME = sys.argv[1], sys.argv[2], sys.argv[3]
PIN = sys.argv[4] if len(sys.argv) > 4 else ''

TONES = r"""
async () => {
  const SR = 48000, D = V.soundFx.DIALOGUE;
  const level = async (freq, dbIn, d, n) => {
    const ac = new OfflineAudioContext(1, SR * 2, SR);
    const osc = ac.createOscillator(); osc.frequency.value = freq;
    const g = ac.createGain(); g.gain.value = Math.pow(10, dbIn / 20);
    const fx = V.soundFx.build(ac, ac.destination);
    // (switched on before any sound: no ramp to wait for)
    fx.input.gain.value = d ? D.trim : 1; fx.low.gain.value = d ? D.low : 0; fx.mid.gain.value = d ? D.mid : 0; fx.high.gain.value = d ? D.high : 0;
    fx.dry.gain.value = n ? 0 : 1; fx.wet.gain.value = n ? V.soundFx.NIGHT.wet : 0;
    osc.connect(g); g.connect(fx.input); osc.start();
    const x = (await ac.startRendering()).getChannelData(0).slice(SR);
    let s = 0; for (const v of x) s += v * v;
    return Math.round((10 * Math.log10(s / x.length) + 3.0103) * 10) / 10; // peak level of a sine, dB
  };
  const out = { dialogue: {}, night: {} };
  for (const f of [100, 1000, 2000, 4000, 10000]) out.dialogue[f] = +(await level(f, -12, true, false) + 12).toFixed(1);
  for (const db of [-3, -20, -45]) out.night[db] = await level(1000, db, false, true);
  return out;
}"""
CLICKS = r"""
async () => {
  const SR = 48000;
  const ac = new OfflineAudioContext(1, SR * 4, SR);
  const osc = ac.createOscillator(); osc.frequency.value = 440;
  const g = ac.createGain(); g.gain.value = 0.5;
  const fx = V.soundFx.build(ac, ac.destination);
  osc.connect(g); g.connect(fx.input); osc.start();
  const steps = [[0.8, 1, 0], [1.6, 1, 1], [2.4, 0, 1], [3.2, 0, 0]];
  steps.forEach(([t, d, n]) => ac.suspend(t).then(() => { V.soundFx.set(fx, d, n); ac.resume(); }));
  const x = (await ac.startRendering()).getChannelData(0);
  const jump = (a, b) => { let m = 0; for (let i = Math.max(1, a); i < b; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1])); return m; };
  return { steady: jump(SR * 0.2, SR * 0.7), around: steps.map(([t]) => jump(SR * t - 200, SR * t + SR * 0.3)) };
}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(B); pg.wait_for_timeout(800)
    if pg.is_visible('#pw'): pg.fill('#pw', PW); pg.keyboard.press('Enter'); pg.wait_for_timeout(1200)
    pg.locator('.pf[data-id]', has_text=NAME).first.click(); pg.wait_for_timeout(500)
    if PIN and pg.is_visible('.pin-input'):
        for d in PIN: pg.keyboard.type(d)
        pg.keyboard.press('Enter')
    pg.wait_for_function("window.V && V.soundFx && document.body.dataset.page === 'home'", timeout=60000)
    t = pg.evaluate(TONES)
    print('clear dialogue, change in dB by frequency:', t['dialogue'])
    print('night mode, level out for level in (dB):', t['night'])
    dl = t['dialogue']
    assert dl['2000'] > 2 and dl['100'] < -4 and dl['10000'] < -2, 'speech lifted, the rest lowered'
    assert dl['1000'] > dl['100'] + 4 and dl['4000'] > dl['10000'] + 3
    n = t['night']
    assert n['-3'] < -9, 'loud gets quieter'
    assert n['-45'] > -40, 'quiet gets louder'
    c = pg.evaluate(CLICKS)
    print('largest step between samples: steady %.4f, around each switch %s' % (c['steady'], ['%.4f' % x for x in c['around']]))
    assert all(x <= c['steady'] * 1.05 for x in c['around']), 'no click when switching'
    assert not errs, errs
    print('ok')
    b.close()
