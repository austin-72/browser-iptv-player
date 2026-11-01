"""History with in-progress titles, profile picture (pick + upload), recent searches, genre menu, guide languages,
thumbnail fallbacks, new home rows. Usage: features.py URL PIN photo.jpg OUTDIR"""
import sys
from playwright.sync_api import sync_playwright
B, PIN, PHOTO, OUT = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1280, 'height': 860})
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(B); pg.wait_for_timeout(500)
    if pg.is_visible('#pw'): pg.fill('#pw', 'changeme'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1500)
    if pg.is_visible('.pf[data-id]'):
        pg.click('.pf[data-id]'); pg.wait_for_timeout(500)
        if pg.is_visible('.pin-input'):
            for d in PIN: pg.keyboard.type(d)
            pg.keyboard.press('Enter')
    pg.wait_for_function("document.body.dataset.page === 'home'", timeout=60000); pg.wait_for_timeout(2500)
    api = lambda path, body=None, method=None: pg.evaluate("([p, b, m]) => V.api(p, {body: b === null ? undefined : b, method: m || undefined}).catch(e => ({error: e.message}))", [path, body, method])
    # --- History: an in-progress film (no history entry yet) + a finished one + something played
    mv = pg.evaluate("S.movies.slice(0, 3).map(x => ({k: x.k, n: x.n}))")
    api('/api/progress', {'k': mv[0]['k'], 'p': 1500, 'd': 6000, 'n': mv[0]['n'], 't': 'movie'})
    api('/api/progress', {'k': mv[1]['k'], 'p': 5990, 'd': 6000, 'n': mv[1]['n'], 't': 'movie'})
    api('/api/played', {'k': mv[2]['k'], 's': 300, 't': 'movie', 'n': mv[2]['n']})
    pg.evaluate("V.refreshMe()"); pg.wait_for_timeout(800)
    pg.evaluate("location.hash = '#/mine/history'"); pg.wait_for_timeout(1500)
    rows = pg.evaluate("[...document.querySelectorAll('.hist li')].map(li => li.querySelector('b').textContent + ' — ' + li.querySelector('.dim').textContent + (li.querySelector('.bar') ? ' [bar]' : ''))")
    print('HISTORY:'); [print('   ', r) for r in rows[:4]]
    pg.screenshot(path=OUT + '/f-history.png')
    # --- Profile picture: pick one, then upload a photo
    pg.evaluate("location.hash = '#/settings'"); pg.wait_for_timeout(1000)
    a0 = pg.evaluate("S.profile.avatar")
    pg.click('[data-a=avatar]'); pg.wait_for_timeout(600)
    print('picker opens:', pg.is_visible('.av-dlg'), '| has photo option:', pg.is_visible('.av-upload'))
    pg.locator('.av-pick').nth(5).click(); pg.wait_for_timeout(1200)
    a1 = pg.evaluate("S.profile.avatar"); print('picked avatar:', a0, '→', a1)
    pg.click('[data-a=avatar]'); pg.wait_for_timeout(600)
    pg.set_input_files('[data-photo]', PHOTO); pg.wait_for_timeout(2000)
    a2 = pg.evaluate("S.profile.avatar"); print('uploaded photo → avatar:', a2, '| shown as image in top bar:', pg.evaluate("!!document.querySelector('#me-btn .avatar.photo img, .avatar.photo img')"))
    img_ok = pg.evaluate("(() => { const i = document.querySelector('.avatar.photo img'); return i ? i.complete && i.naturalWidth : 0; })()"); print('photo loads, width:', img_ok)
    pg.screenshot(path=OUT + '/f-settings.png')
    # --- Other buttons in Settings work again (name)
    pg.fill('[data-name]', 'Austin T'); pg.click('[data-a=name]'); pg.wait_for_timeout(800); print('rename works:', pg.evaluate("S.profile.name"))
    pg.fill('[data-name]', 'Austin'); pg.click('[data-a=name]'); pg.wait_for_timeout(500)
    # --- Recent searches: typing doesn't save, Enter does, 10 max, remove one, clear all
    pg.evaluate("location.hash = '#/search'"); pg.wait_for_timeout(800)
    inp = pg.locator('#view input').first
    inp.fill('sabri'); pg.wait_for_timeout(3000)
    print('typing alone saved a search:', 'sabri' in pg.evaluate("S.data.searches"))
    for q in ['batman', 'sabri', 'sabrina', 'friends', 'office', 'matrix', 'lost', 'alien', 'heat', 'jaws', 'up', 'cars']:
        inp.fill(q); inp.press('Enter'); pg.wait_for_timeout(150)
    pg.wait_for_timeout(800)
    srv = pg.evaluate("V.api('/api/me').then(m => m.data.searches)")
    print('saved searches:', len(srv), srv[:4], '| "sabri" replaced by "sabrina":', 'sabri' not in srv and 'sabrina' in srv)
    inp.fill(''); pg.evaluate("document.querySelector('#view input').dispatchEvent(new Event('input'))"); pg.wait_for_timeout(600)
    pg.locator('[data-del-s="cars"]').click(); pg.wait_for_timeout(600)
    print('after removing "cars":', pg.evaluate("V.api('/api/me').then(m => m.data.searches)"))
    pg.screenshot(path=OUT + '/f-search.png')
    pg.click('[data-clear-s]'); pg.wait_for_timeout(600); print('after clear all:', pg.evaluate("V.api('/api/me').then(m => m.data.searches)"))
    # --- Movies: genre menu + genre sort
    pg.evaluate("location.hash = '#/movies'"); pg.wait_for_timeout(1500)
    opts = pg.evaluate("[...document.querySelectorAll('[data-f=genre] option')].map(o => o.textContent)")
    print('genre menu:', len(opts), 'options', opts[:6])
    pg.select_option('[data-f=genre]', index=3); pg.wait_for_timeout(1200)
    print('filtered:', pg.evaluate("location.hash"), pg.evaluate("document.querySelector('.count').textContent"))
    pg.select_option('[data-f=sort]', 'genre'); pg.wait_for_timeout(1200)
    pg.screenshot(path=OUT + '/f-movies.png')
    print('broken pictures fell back to title tiles:', pg.evaluate("document.querySelectorAll('.card .card-tt').length"), '| still-broken <img>:', pg.evaluate("[...document.querySelectorAll('.card img')].filter(i => i.complete && !i.naturalWidth).length"))
    # --- Guide: only channels in the profile's languages
    pg.evaluate("location.hash = '#/guide'"); pg.wait_for_timeout(2000)
    gk = pg.evaluate("[...document.querySelectorAll('#view [data-k]')].map(e => e.dataset.k)")
    langs = pg.evaluate("(ks) => ks.map(k => (V.entry(k) || {}).lg || []).map(l => l.join('+') || '?')", gk[:400])
    from collections import Counter
    print('guide channels:', len(gk), 'languages:', Counter(langs).most_common(5))
    pg.screenshot(path=OUT + '/f-guide.png')
    # --- Home rows
    pg.evaluate("location.hash = '#/home'"); pg.wait_for_timeout(2500)
    print('home rows:', pg.evaluate("[...document.querySelectorAll('.row h2, .row .row-t, .row-h h2')].map(h => h.textContent).slice(0, 14)"))
    b.close()
print('errors:', errors or 'none')
