"""Search by people/genre/decade, collections, fixing details, filters, Surprise me, together, remote control, TV sign-in
with a code, admin network/categories/TMDB panels. Usage: features2.py URL OUTDIR [PIN]"""
import sys, json
from playwright.sync_api import sync_playwright
B, OUT = sys.argv[1], sys.argv[2]
PIN = sys.argv[3] if len(sys.argv) > 3 else '1234'
errors = []


def enter(pg, who=0, pin=PIN):
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(B); pg.wait_for_timeout(600)
    if pg.is_visible('#pw'): pg.fill('#pw', 'changeme'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1500)
    if pg.is_visible('.pf[data-id]'):
        pg.locator('.pf[data-id]').nth(who).click(); pg.wait_for_timeout(500)
        if pg.is_visible('.pin-input'):
            for d in pin: pg.keyboard.type(d)
            pg.keyboard.press('Enter')
    pg.wait_for_function("document.body.dataset.page === 'home'", timeout=60000); pg.wait_for_timeout(1500)
    # A new-profile "what do you like?" dialog may be up: skip it.
    if pg.is_visible('.onboard-dlg'): pg.click('.onboard-dlg .dlg-f .btn:not(.primary)'); pg.wait_for_timeout(300)


with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 860})
    pg = ctx.new_page()
    enter(pg)
    api = lambda path, body=None, method=None: pg.evaluate("([p, b, m]) => V.api(p, {body: b === null ? undefined : b, method: m || undefined}).catch(e => ({error: e.message}))", [path, body, method])

    # ---- search: people, genre + decade
    pg.evaluate("location.hash = '#/search'"); pg.wait_for_timeout(500)
    inp = pg.locator('#view input').first
    inp.fill('actor one'); pg.wait_for_timeout(1500)
    print('people rows:', pg.evaluate("[...document.querySelectorAll('.sr-people .row h2, .sr-people .row-h h2')].map(h => h.textContent)"))
    inp.fill('science fiction 90s'); pg.wait_for_timeout(900)
    print('genre+decade row:', pg.evaluate("[...document.querySelectorAll('.sr-rows .row-h h2')].map(h => h.textContent).slice(0, 2)"),
          pg.evaluate("[...document.querySelectorAll('.sr-rows .row')][0] ? [...document.querySelectorAll('.sr-rows .row')][0].querySelectorAll('.card').length : 0"), 'cards')

    # ---- a film in a series: The Matrix
    mk = pg.evaluate("(S.movies.find(m => /^the matrix$/i.test(m.n)) || {}).k")
    print('matrix key:', mk)
    if mk:
        pg.evaluate(f"location.hash = '#/title/{mk}'"); pg.wait_for_timeout(2500)
        print('collection:', pg.evaluate("(() => { const c = document.querySelector('.tp-col'); return c && !c.hidden ? c.querySelector('h2').textContent + ' | ' + c.querySelector('.col-h .dim').textContent + ' | parts: ' + [...c.querySelectorAll('.col-parts li')].map(li => li.className + ':' + li.querySelector('.cp-t').textContent).join(', ') : 'none'; })()"))
        print('cast links:', pg.evaluate("[...document.querySelectorAll('.tp-credits a[href^=\"#/search\"]')].map(a => a.textContent)"))
        pg.screenshot(path=OUT + '/f2-title.png')
        # Wrong details? → pick another → back
        pg.click('[data-fix]'); pg.wait_for_timeout(1500)
        opts = pg.evaluate("[...document.querySelectorAll('.fix-opt')].map(o => o.querySelector('b').textContent + (o.classList.contains('cur') ? ' (current)' : ''))")
        print('fix options:', opts)
        pg.screenshot(path=OUT + '/f2-fix.png')
        pg.fill('.fix-q input', 'Blade Runner'); pg.click('.fix-q .btn'); pg.wait_for_timeout(1200)
        pg.locator('.fix-opt').first.click(); pg.wait_for_timeout(2500)
        print('after fix, plot:', pg.evaluate("document.querySelector('.tp-plot').textContent"), '| fixed note:', pg.evaluate("(document.querySelector('[data-fix]') || {}).textContent"))
        r = api(f'/api/item/{mk}/match', {'id': 1, 'type': 'movie'})
        print('set back to The Matrix:', r.get('ok'), r.get('item', {}).get('n'))

    # ---- filters on Movies
    pg.evaluate("location.hash = '#/movies?dec=1990'"); pg.wait_for_timeout(1200)
    print('1990s films:', pg.evaluate("document.querySelector('.count').textContent"), pg.evaluate("[...document.querySelectorAll('.card .card-t')].map(x => x.textContent).slice(0, 6)"))
    pg.evaluate("location.hash = '#/movies?rmin=8'"); pg.wait_for_timeout(800)
    print('rated 8+:', pg.evaluate("document.querySelector('.count').textContent"))

    # ---- Surprise me, together
    pg.evaluate("location.hash = '#/home'"); pg.wait_for_timeout(1500)
    if pg.is_visible('[data-home=surprise]'):
        pg.click('[data-home=surprise]'); pg.wait_for_timeout(800)
        print('surprise:', pg.evaluate("(document.querySelector('.surprise h3') || {}).textContent"))
        pg.locator('.surprise-dlg .dlg-f .btn').first.click(); pg.wait_for_timeout(500)
        print('another:', pg.evaluate("(document.querySelector('.surprise h3') || {}).textContent"))
        pg.screenshot(path=OUT + '/f2-surprise.png')
        pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    mom = pg.evaluate("S.boot.profiles.find(p => p.name === 'Mom').id")
    pg.evaluate(f"location.hash = '#/together?with={mom}'"); pg.wait_for_timeout(2500)
    print('together picks:', pg.evaluate("document.querySelectorAll('#view .card').length"), pg.evaluate("[...document.querySelectorAll('#view .card .card-t')].map(x => x.textContent).slice(0, 5)"))
    pg.screenshot(path=OUT + '/f2-together.png')
    print('home rows:', pg.evaluate("location.hash = '#/home'") or '', end='')
    pg.wait_for_timeout(1500)
    print(pg.evaluate("[...document.querySelectorAll('.row-h h2')].map(h => h.textContent)"))

    # ---- remote: this page is the "TV", a second page is the phone (same profile)
    phone = ctx.new_page()
    enter(phone)
    tv_conn = pg.evaluate("S.conn")
    phone.evaluate(f"location.hash = '#/remote'"); phone.wait_for_timeout(1500)
    print('remote lists:', phone.evaluate("[...document.querySelectorAll('.remote-dev b')].map(b => b.textContent)"))
    phone.evaluate(f"location.hash = '#/remote/{tv_conn}'"); phone.wait_for_timeout(1000)
    tp = pg.evaluate("(S.movies.find(m => /test pattern/i.test(m.n)) || S.movies[0]).k")
    phone.evaluate(f"V.api('/api/devices/{tv_conn}/command', {{body: {{cmd: 'play', k: '{tp}'}}}})"); pg.wait_for_timeout(5000)
    print('TV playing:', pg.evaluate("V.watch.it && V.watch.it.n"), '| phone shows:', phone.evaluate("document.querySelector('.rm-t').textContent"))
    phone.click('[data-c=toggle]'); pg.wait_for_timeout(1200)
    print('after pause on phone, TV paused:', pg.evaluate("V.player.video.paused"), '| phone button:', phone.evaluate("document.querySelector('[data-c=toggle] use').getAttribute('href')"))
    phone.screenshot(path=OUT + '/f2-remote.png')
    # Play things there from the phone
    phone.click('[data-target]'); phone.wait_for_timeout(300)
    other = pg.evaluate("(S.movies.find(m => m.k !== '%s' && m.u) || {}).k" % tp)
    phone.evaluate(f"V.play(V.entry('{other}'))"); pg.wait_for_timeout(3000)
    print('phone pressed Play → TV now:', pg.evaluate("V.watch.it && V.watch.it.n"), '| phone itself playing:', phone.evaluate("!!(V.watch.it)"), '| bar:', phone.is_visible('#remote-bar'))
    phone.click('#remote-bar [data-off]'); phone.wait_for_timeout(200)
    pg.evaluate("V.closePlayer()")

    # ---- a TV signs in with a code
    tvctx = b.new_context(viewport={'width': 1280, 'height': 720}, user_agent='Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0 TV Safari/537.36')
    tv = tvctx.new_page()
    tv.on('pageerror', lambda e: errors.append('TV: ' + str(e)))
    tv.goto(B); tv.wait_for_timeout(1500)
    code = tv.evaluate("document.getElementById('code').textContent")
    print('TV shows code:', code, '| QR:', tv.evaluate("!!document.querySelector('#qr svg')"), '| password form hidden:', tv.evaluate("document.getElementById('f').classList.contains('hide')"))
    tv.screenshot(path=OUT + '/f2-tvcode.png')
    phone.evaluate("location.hash = '#/settings'"); phone.wait_for_timeout(800)
    phone.click('[data-a=pair]'); phone.wait_for_timeout(300)
    phone.fill('[data-code]', code); phone.click('.dlg-f .primary'); phone.wait_for_timeout(3500)
    print('TV after approval:', tv.evaluate("location.pathname"), tv.evaluate("document.body.dataset.page"), '| as:', tv.evaluate("S.profile && S.profile.name"))
    tv.wait_for_timeout(1500)
    print('phone can see the TV:', phone.evaluate("V.api('/api/devices').then(d => d.map(x => x.name))"))
    tvctx.close()

    # ---- admin
    pg.evaluate("location.hash = '#/admin/recs'"); pg.wait_for_timeout(2000)
    print('tmdb panel:', pg.evaluate("[...document.querySelectorAll('.tmdb-fetch .stat')].map(s => s.innerText.replace(/\\n/g, ' '))"), '| categories listed:', pg.evaluate("document.querySelectorAll('.tf-glist label').length"))
    pg.click('[data-tf=all]'); pg.wait_for_timeout(400)
    if pg.is_visible('dialog .dlg-f .primary'): pg.click('dialog .dlg-f .primary')
    pg.wait_for_timeout(1500)
    print('job:', pg.evaluate("(document.querySelector('.tf-job') || {}).innerText"))
    pg.wait_for_timeout(3000)
    pg.screenshot(path=OUT + '/f2-tmdb.png')
    print('after:', pg.evaluate("(document.querySelector('.tmdb-fetch') || {}).innerText.slice(0, 200)"))
    pg.evaluate("location.hash = '#/admin/network'"); pg.wait_for_timeout(1200)
    pg.click('#view [data-add]'); pg.fill('.proxies [data-k=url]', 'socks5://nobody:pw@127.0.0.1:1'); pg.click('.proxies [data-test]'); pg.wait_for_timeout(2500)
    print('proxy test:', pg.evaluate("document.querySelector('[data-res]').textContent"))
    pg.fill('[data-direct]', 'http://192.168.1.20:8080'); pg.click('[data-save-d]'); pg.wait_for_timeout(800)
    print('direct address saved:', api('/api/admin')['settings']['directAddress'])
    api('/api/admin/settings', {'directAddress': ''}, 'PUT')
    pg.screenshot(path=OUT + '/f2-network.png')
    pg.evaluate("location.hash = '#/admin/categories'"); pg.wait_for_timeout(1500)
    print('categories now:', pg.evaluate("[...document.querySelectorAll('.cat-now .chip')].map(c => c.childNodes[0].textContent.trim()).slice(0, 12)"))
    pg.screenshot(path=OUT + '/f2-cats.png')
    pg.evaluate("location.hash = '#/admin/apps'"); pg.wait_for_timeout(1500)
    print('updates:', pg.evaluate("document.querySelector('.upd').innerText.slice(0, 120)"))
    pg.evaluate("location.hash = '#/mine/week'"); pg.wait_for_timeout(1200)
    print('week:', pg.evaluate("document.querySelector('.week h2').textContent"))
    pg.screenshot(path=OUT + '/f2-week.png')
    b.close()
print('errors:', errors or 'none')
