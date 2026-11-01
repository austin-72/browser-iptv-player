import sys
from playwright.sync_api import sync_playwright
B = sys.argv[1]; OUT = sys.argv[2]
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required']); ctx = b.new_context(viewport={'width': 1280, 'height': 800}); pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(B); pg.wait_for_timeout(400)
    if pg.is_visible('#pw'): pg.fill('#pw', 'changeme'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1200)
    pg.click('.pf:has-text("Dad")'); pg.wait_for_timeout(500)
    for d in '1234': pg.keyboard.type(d)
    pg.keyboard.press('Enter'); pg.wait_for_timeout(2500)
    print('can store in app:', pg.evaluate("V.downloads.canStore()"))
    # An MKV (needs converting to MP4 on the server) and an MP4
    pg.evaluate("V.downloads.start(S.items.find(i => i.n === 'Fractal Journey'), {quality: 0})")
    pg.evaluate("V.downloads.start(S.items.find(i => i.n === 'XT Movie'), {quality: 0})")
    pg.evaluate("location.hash = '#/downloads'")
    for i in range(30):
        pg.wait_for_timeout(1500)
        st = pg.evaluate("V.downloads.list().map(r => r.n + ':' + r.status + ':' + r.bytes)")
        if all(':done:' in s for s in st): break
    print('downloads:', st)
    pg.screenshot(path=f'{OUT}/d1-downloads.png')
    pg.evaluate("V.downloads.play(V.downloads.list().find(r => r.n === 'Fractal Journey').k)"); pg.wait_for_timeout(4000)
    print('offline play:', pg.evaluate("({w: V.player.video.videoWidth, t: V.player.video.currentTime, via: V.player.attempt && V.player.attempt.via, d: V.player.duration})"))
    pg.evaluate("V.closePlayer()")
    # Go offline: block the server; the service worker serves the app; downloads still play.
    ctx.set_offline(True)
    pg.reload(); pg.wait_for_timeout(3000)
    print('offline mode:', pg.evaluate("document.body.classList.contains('offline')"), pg.evaluate("location.hash"), pg.evaluate("document.querySelectorAll('.dl-list li').length"))
    pg.screenshot(path=f'{OUT}/d2-offline.png')
    pg.click('[data-d=play]'); pg.wait_for_timeout(3500)
    print('offline playback:', pg.evaluate("({w: V.player.video.videoWidth, t: V.player.video.currentTime})"))
    print(errs or 'no page errors')
    b.close()
