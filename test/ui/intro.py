import sys
from playwright.sync_api import sync_playwright
B = sys.argv[1]; OUT = sys.argv[2]
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required']); pg = b.new_page(viewport={'width': 1280, 'height': 720})
    pg.goto(B); pg.wait_for_timeout(400)
    if pg.is_visible('#pw'): pg.fill('#pw', 'changeme'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1200)
    pg.click('.pf:has-text("Dad")'); pg.wait_for_timeout(500)
    for d in '1234': pg.keyboard.type(d)
    pg.keyboard.press('Enter'); pg.wait_for_timeout(2500)
    lid = pg.evaluate("V.api('/api/admin').then(a => a.lists.find(l => l.type === 'folder').id)")
    print(pg.evaluate("(id) => V.api('/api/admin/lists/' + id + '/refresh', {method: 'POST'}).then(l => l.status.count)", lid))
    pg.wait_for_timeout(2500); pg.evaluate("V.loadCatalog()"); pg.wait_for_timeout(1500)
    show = pg.evaluate("S.items.find(i => i.t === 'show' && i.n === 'Intro Show')")
    print('show:', show and show['n'], show and show.get('ne'))
    pg.evaluate("location.hash = '#/title/' + encodeURIComponent(S.items.find(i => i.n === 'Intro Show').k)"); pg.wait_for_timeout(2000)
    pg.screenshot(path=f'{OUT}/i1-show.png')
    pg.evaluate("V.play(S.epsByShow.get(S.items.find(i => i.n === 'Intro Show').k)[1])"); pg.wait_for_timeout(25000)
    pg.evaluate("V.player._accountWatched()")  # sends /api/played -> triggers detection
    for i in range(20):
        pg.wait_for_timeout(3000)
        m = pg.evaluate("V.api('/api/markers/' + encodeURIComponent(V.player.it.k))")
        if m.get('intro'): break
    print('markers:', m)
    pg.evaluate("V.player.markers = null; V.player._loadExtras()"); pg.wait_for_timeout(1000)
    pg.evaluate("V.player.seek(V.player.markers.intro.start + 1)"); pg.wait_for_timeout(2500)
    print('skip button:', pg.is_visible('.vp-skip'), pg.evaluate("document.querySelector('.vp-skip').innerText"))
    pg.mouse.move(640, 300); pg.screenshot(path=f'{OUT}/i2-skip.png')
    pg.click('.vp-skip'); pg.wait_for_timeout(1500)
    print('after skip pos:', round(pg.evaluate("V.player.position"), 1))
    b.close()
