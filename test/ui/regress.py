"""Regressions found in review: stacked click handlers, quick setting changes, guide refresh reloads."""
import sys
from playwright.sync_api import sync_playwright
B = sys.argv[1]
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required']); pg = b.new_page(viewport={'width': 1280, 'height': 800})
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(B); pg.wait_for_timeout(500)
    if pg.is_visible('#pw'): pg.fill('#pw', 'changeme'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1200)
    if pg.is_visible('.pf[data-id]'):
        pg.click('.pf[data-id]'); pg.wait_for_timeout(500)
        if pg.is_visible('.pin-input'):
            for d in '1234': pg.keyboard.type(d)
            pg.keyboard.press('Enter')
    pg.wait_for_timeout(2500)
    ch = pg.evaluate("S.live[0].k"); ch2 = pg.evaluate("S.live[1].k")
    mv = pg.evaluate("S.items.find(i => i.n === 'Test Pattern').k")
    fav0 = pg.evaluate("S.data.favs.slice()")
    # Visit two channel pages and then a movie page, three times over.
    for _ in range(3):
        pg.evaluate("(k) => location.hash = '#/channel/' + encodeURIComponent(k)", ch); pg.wait_for_timeout(500)
        pg.evaluate("(k) => location.hash = '#/channel/' + encodeURIComponent(k)", ch2); pg.wait_for_timeout(500)
    pg.evaluate("(k) => location.hash = '#/title/' + encodeURIComponent(k)", mv); pg.wait_for_timeout(1000)
    calls = []
    pg.on('request', lambda r: calls.append(r.url) if '/api/play/reach' in r.url or '/api/stats/play' in r.url else None)
    btn = pg.locator('#view [data-a=play], #view .tp-acts .btn.primary').first
    btn.click(); pg.wait_for_timeout(5000)
    print('pressed Play on the movie page → playing:', pg.evaluate("V.watch.it && V.watch.it.n"), '| play checks sent:', len([c for c in calls if 'reach' in c]))
    pg.evaluate("V.closePlayer()"); pg.wait_for_timeout(500)
    # Heart on the second channel page toggles only that channel.
    pg.evaluate("(k) => location.hash = '#/channel/' + encodeURIComponent(k)", ch2); pg.wait_for_timeout(800)
    heart = pg.locator('#view [data-a=fav], #view [data-fav]').first
    if heart.count():
        heart.click(); pg.wait_for_timeout(800)
        fav1 = pg.evaluate("S.data.favs.slice()")
        print('favourites changed by one heart press:', sorted(set(fav1) ^ set(fav0)) == sorted([ch2]) or len(set(fav1) ^ set(fav0)), '(changed:', len(set(fav1) ^ set(fav0)), ')')
        heart.click(); pg.wait_for_timeout(600)
    else: print('no heart button found on channel page')
    # Two settings within a moment of each other both stick.
    pg.evaluate("V.setPref('autoplayNext', false); V.setPref('autoSkipIntro', true)"); pg.wait_for_timeout(1500)
    print('quick prefs saved on server:', pg.evaluate("V.api('/api/me').then(m => [m.data.prefs.autoplayNext, m.data.prefs.autoSkipIntro])"))
    pg.evaluate("V.setPref('autoplayNext', true); V.setPref('autoSkipIntro', false)"); pg.wait_for_timeout(1500)
    # A guide refresh with identical data must not make devices reload the catalogue.
    v0 = pg.evaluate("S.catalogVersion"); loads = []
    pg.on('request', lambda r: loads.append(1) if r.url.endswith('/api/catalog') else None)
    pg.evaluate("V.api('/api/admin').then(a => Promise.all(a.guides.map(g => V.api('/api/admin/guides/' + g.id + '/refresh', {method: 'POST'}))))"); pg.wait_for_timeout(9000)
    print('guide refresh → catalogue re-downloaded:', len(loads), 'times; version unchanged:', v0 == pg.evaluate("S.catalogVersion"))
    b.close()
print('errors:', errors or 'none')
