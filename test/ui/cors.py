"""Plays providers with every kind of CORS setup and reports the route used and where the video bytes came from.
Usage: python3 test/ui/cors.py http://127.0.0.1:8091 PIN [extension_dir]
With an extension folder, the direct-streams helper is loaded into Chromium too."""
import sys, json, tempfile
from playwright.sync_api import sync_playwright

B = sys.argv[1]; PIN = sys.argv[2]; EXT = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != 'nonative' else None
NONATIVE = 'nonative' in sys.argv  # act like Firefox / older Chrome: no built-in HLS player
NAMES = ['Open HLS', 'Blocked HLS', 'Split HLS', 'Redirect HLS', 'Xtream TS', 'Blocked TS', 'Open TS', 'Blocked Movie', 'UA Optional']
errors = []
with sync_playwright() as p:
    args = ['--autoplay-policy=no-user-gesture-required']
    if EXT:
        ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(), headless=True, channel='chromium', args=args + [f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
    else:
        b = p.chromium.launch(args=args); pg = b.new_page()
    pg.set_viewport_size({'width': 1280, 'height': 760})
    pg.on('pageerror', lambda e: errors.append(str(e)))
    reqs = []
    pg.on('request', lambda r: reqs.append(r.url))
    pg.on('console', lambda m: print('   console:', m.text[:160]) if 'attempt failed' in m.text else None)
    pg.goto(B); pg.wait_for_timeout(600)
    if pg.is_visible('#pw'): pg.fill('#pw', 'changeme'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1200)
    pg.click('.pf'); pg.wait_for_timeout(500)
    for d in PIN: pg.keyboard.type(d)
    pg.keyboard.press('Enter'); pg.wait_for_timeout(2500)
    if NONATIVE: pg.evaluate("V.nativePlays = function () { return false; }")
    print('native HLS:', pg.evaluate("V.nativePlays('hls')"), ' native TS:', pg.evaluate("V.nativePlays('ts')"), ' helper:', pg.evaluate("V.directHelper()"))
    for n in NAMES:
        reqs.clear()
        r = pg.evaluate("(n) => { const it = S.items.find(i => i.n === n); if (!it) return 'missing'; V.play(it); return 'ok'; }", n)
        if r != 'ok': print(f'{n:15} MISSING'); continue
        st = None
        for _ in range(60):
            pg.wait_for_timeout(500)
            st = pg.evaluate("({ok: V.player.started, a: V.player.attempt, w: V.player.video.videoWidth, t: +V.player.video.currentTime.toFixed(1), msg: (document.querySelector('.vp-msg:not([hidden])') || {}).innerText || ''})")
            if st['ok'] and st['t'] > 2: break
            if 'Can’t play' in st['msg']: break
        provider = [u for u in reqs if ':9100/' in u]
        proxied = [u for u in reqs if '/api/proxy' in u]
        segs_direct = len([u for u in provider if u.split('?')[0].endswith('.ts') or '/ts/' in u or u.endswith('.mp4') or '/live/' in u])
        a = st['a'] or {}
        route = (a.get('via') or '?') + (' native' if a.get('native') else '') + (' helper' if a.get('helper') else '') + ':' + str(a.get('kind') or a.get('mode'))
        print(f"{n:15} {'PLAYING' if st['ok'] else 'FAILED '} {route:22} {st['w']}px t={st['t']:<5} browser→provider {len(provider):3} req   via server {len(proxied):3} req   {st['msg'][:60] if not st['ok'] else ''}")
        pg.evaluate("V.closePlayer()"); pg.wait_for_timeout(600)
    pg.evaluate("location.hash = '#/settings'"); pg.wait_for_timeout(1200)
    sec = pg.locator('h2:has-text(\"Direct streaming\")')
    if sec.count(): sec.scroll_into_view_if_needed(); pg.wait_for_timeout(300)
    pg.screenshot(path='/tmp/claude-0/-home-claude/ab5c43bb-b9fe-5fa3-b440-76c90e2bd465/scratchpad/cors-settings' + ('-ext' if EXT else '') + '.png')
print('page errors:', errors or 'none')
