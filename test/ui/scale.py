"""Big-list timings in the browser (CPU slowed to phone-like speed): sign-in → home, pages, search, guide."""
import sys, time
from playwright.sync_api import sync_playwright
B = sys.argv[1]; PIN = sys.argv[2]; SLOW = float(sys.argv[3]) if len(sys.argv) > 3 else 4; OUT = sys.argv[4] if len(sys.argv) > 4 else None
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    pg.on('pageerror', lambda e: errors.append(str(e)))
    cdp = pg.context.new_cdp_session(pg); cdp.send('Emulation.setCPUThrottlingRate', {'rate': SLOW})
    pg.goto(B); pg.wait_for_timeout(500)
    if pg.is_visible('#pw'): pg.fill('#pw', 'changeme'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1500)
    if pg.is_visible('.pf[data-id]'):
        pg.click('.pf[data-id]'); pg.wait_for_timeout(400)
        if pg.is_visible('.pin-input'):
            for d in PIN: pg.keyboard.type(d)
            t0 = time.time(); pg.keyboard.press('Enter')
    else: t0 = time.time()
    pg.wait_for_function("document.body.dataset.page === 'home' && document.querySelector('#view .row')", timeout=120000)
    print(f'PIN → home rows visible: {time.time() - t0:.1f}s   items: {pg.evaluate("S.items.length")}   JS heap: {pg.evaluate("performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : 0")} MB')
    def nav(h, sel, label):
        t = time.time(); pg.evaluate(f"location.hash = '{h}'")
        pg.wait_for_function(f"document.querySelector('{sel}')", timeout=60000); pg.wait_for_timeout(50)
        print(f'{label:24} {time.time() - t:5.2f}s   DOM nodes: {pg.evaluate("document.getElementsByTagName(\'*\').length")}')
    nav('#/movies', '#view .card, #view .grid', 'Movies page')
    nav('#/series', '#view .card, #view .grid', 'Series page')
    nav('#/live', '#view .ch-list > *', 'Live TV page')
    nav('#/guide', '#view canvas, #view .g-canvas, #view .g-ch', 'Guide page')
    nav('#/home', '#view .row', 'Home again')
    t = time.time(); r = pg.evaluate("(() => { const t = performance.now(); const x = V.search.find('secret river', {limit: 60}); const t2 = performance.now() - t; const t3 = performance.now(); V.search.find('midnite harbr', {limit: 60}); return [t2, x.length, performance.now() - t3]; })()")
    print(f"search (first, builds index) {r[0]/1000:5.2f}s ({r[1]} results); typo search {r[2]/1000:5.2f}s")
    t = time.time(); pg.evaluate("location.hash = '#/search'"); pg.wait_for_timeout(800)
    inp = pg.locator('#view input[type=search], #view input').first; inp.fill('midnight harbor'); t = time.time()
    pg.wait_for_function("document.querySelectorAll('#view .card').length > 0", timeout=30000)
    print(f'search page typing→cards {time.time() - t:5.2f}s')
    # Long task check: scroll movies grid
    pg.evaluate("location.hash = '#/movies'"); pg.wait_for_timeout(1500)
    t = time.time()
    for i in range(10): pg.mouse.wheel(0, 2000); pg.wait_for_timeout(100)
    print(f'scroll movies 10 steps  {time.time() - t:5.2f}s   DOM nodes: {pg.evaluate("document.getElementsByTagName(\'*\').length")}')
    if OUT: pg.screenshot(path=OUT)
    # reload: should open straight in, from the IndexedDB cache
    t = time.time(); pg.reload(); pg.wait_for_function("document.body.dataset.page && document.querySelector('#view .card')", timeout=120000)
    print(f'reload → app (cached)   {time.time() - t:5.2f}s   profile screen: {pg.is_visible("#profiles")}')
    b.close()
print('errors:', errors or 'none')
