import sys
from playwright.sync_api import sync_playwright
B = sys.argv[1]; names = sys.argv[2].split('|'); wait = int(sys.argv[3]) if len(sys.argv) > 3 else 12000
ST = """() => { const p = V.player; const v = p.video; const m = document.querySelector('.vp-msg'); return {w: v.videoWidth, t: +v.currentTime.toFixed(1), msg: m.hidden ? '' : m.innerText.replace(/\\s+/g,' ').slice(0,160), via: p.attempt && (p.attempt.via + ':' + (p.attempt.kind || p.attempt.mode)), it: p.it && p.it.n} }"""
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required']); pg = b.new_page(viewport={'width': 1280, 'height': 800})
    errs = []
    pg.on("console", lambda m: print("  [console]", m.text[:160]) if "[player]" in m.text else None)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(B); pg.wait_for_timeout(400)
    if pg.is_visible('#pw'): pg.fill('#pw', 'changeme'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1200)
    pg.click('.pf[data-id]'); pg.wait_for_timeout(500)
    if pg.is_visible('.pin-input'):
        for d in '1234': pg.keyboard.type(d)
        pg.keyboard.press('Enter')
    pg.wait_for_timeout(2500)
    for n in names:
        pg.evaluate("(n) => V.play(S.items.find(i => i.n === n))", n); pg.wait_for_timeout(wait)
        print(n, pg.evaluate(ST))
    print(errs or 'no page errors')
    b.close()
