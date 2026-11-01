import sys
from playwright.sync_api import sync_playwright
B = sys.argv[1]; OUT = sys.argv[2]
UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/7.0 TV Safari/537.36 Chrome/94.0'
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(viewport={'width': 1920, 'height': 1080}, user_agent=UA)
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(B); pg.wait_for_timeout(400)
    if pg.is_visible('#pw'): pg.fill('#pw', 'changeme'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1200)
    f = lambda: pg.evaluate("(() => { const a = document.activeElement; return a ? (a.className || a.tagName) + ' ' + (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 40) : null; })()")
    print('focus on picker:', f())
    pg.keyboard.press('ArrowRight'); print('right:', f())
    pg.keyboard.press('ArrowLeft'); print('left:', f())
    pg.keyboard.press('Enter'); pg.wait_for_timeout(600)
    for d in '1234': pg.keyboard.press(d)
    pg.keyboard.press('Enter'); pg.wait_for_timeout(2500)
    print('tv class:', pg.evaluate("document.documentElement.classList.contains('tv')"))
    for k in ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowDown']:
        pg.keyboard.press(k); pg.wait_for_timeout(250); print(k, '->', f())
    pg.screenshot(path=f'{OUT}/t1-tv-home.png')
    pg.keyboard.press('Enter'); pg.wait_for_timeout(2500)
    print('after enter: hash', pg.evaluate("location.hash"), 'player open:', pg.evaluate("!document.getElementById('player-layer').hidden"))
    pg.keyboard.press('Escape'); pg.wait_for_timeout(800)
    print('after back: mini', pg.evaluate("document.getElementById('player-layer').classList.contains('mini')"))
    print(errs or 'no page errors')
    b.close()
