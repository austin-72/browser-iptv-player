"""Channel editor, guide matching and offsets, placeholders, your channel lists, guide colours, On later and parental locks,
on desktop, phone (360 px) and TV. Needs live channels, at least one with no guide data, and an admin profile.
Usage: python3 test/ui/p3.py http://localhost:8090 [site password] [admin profile] [admin profile PIN]
It sets things up through the app and puts them back at the end (the parental PIN is cleared)."""
import sys, base64
from playwright.sync_api import sync_playwright
B = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8090'
PW = sys.argv[2] if len(sys.argv) > 2 else 'changeme'
ADMIN = sys.argv[3] if len(sys.argv) > 3 else ''
APIN = sys.argv[4] if len(sys.argv) > 4 else '1234'
UA_TV = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/7.0 TV Safari/537.36 Chrome/94.0'
UA_PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
PIN = '2468'
errors, fails = [], []
def check(name, ok, extra=''):
    print(('ok   ' if ok else 'FAIL ') + name + (' — ' + str(extra) if extra != '' else ''))
    if not ok: fails.append(name)

def open_app(b, tag, profile=ADMIN, pin=APIN, **ctx):
    c = b.new_context(**ctx); pg = c.new_page()
    pg.on('pageerror', lambda e: errors.append(tag + ': ' + str(e)))
    pg.goto(B); pg.wait_for_timeout(1000)
    for t in ('#usepw', 'text=Use the password instead'):
        if pg.locator(t).first.is_visible(): pg.locator(t).first.click(); pg.wait_for_timeout(500)
    if pg.is_visible('#pw'): pg.fill('#pw', PW); pg.keyboard.press('Enter'); pg.wait_for_timeout(1500)
    pg.wait_for_selector('.pf[data-id]', timeout=20000)
    (pg.locator('.pf[data-id]', has_text=profile) if profile else pg.locator('.pf[data-id]')).first.click(); pg.wait_for_timeout(600)
    try: pg.wait_for_selector('.pin-input', timeout=3000)
    except Exception: pass
    if pg.is_visible('.pin-input'):
        for d in pin: pg.keyboard.type(d)
        pg.keyboard.press('Enter')
    pg.wait_for_function("window.S && S.items && S.live && document.body.dataset.page === 'home'", timeout=60000); pg.wait_for_timeout(1200)
    return pg
def api(pg, path, body=None, method=None):
    return pg.evaluate("([p, b, m]) => V.api(p, b || m ? {body: b || undefined, method: m || undefined} : undefined).catch(e => ({error: e.message, status: e.status}))", [path, body, method])
def go(pg, h, w=2500): pg.evaluate("(h) => location.hash = h", h); pg.wait_for_timeout(w)
def no_overflow(pg): return pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
def reset_all(pg):
    ch = api(pg, '/api/admin/channels?show=changed&n=5000')
    if ch.get('items'): api(pg, '/api/admin/channels/bulk', {'keys': [x['k'] for x in ch['items']], 'action': 'reset'})
    lk = api(pg, '/api/admin/locks')
    for g in lk.get('groups', []): api(pg, '/api/admin/locks/toggle', {'kind': 'group', 'value': g, 'on': False})
    if lk.get('keys'): api(pg, '/api/admin/channels/bulk', {'keys': [x['k'] for x in lk['keys']], 'action': 'unlock'})
    for gid, off in (api(pg, '/api/admin/guide-offsets').get('offsets') or {}).items(): api(pg, '/api/admin/guides/' + gid + '/offset', {'hours': 0}, 'PUT')
    api(pg, '/api/admin/epg-placeholders', {'on': True}, 'PUT')

with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg = open_app(b, 'desktop', viewport={'width': 1366, 'height': 860})
    reset_all(pg); api(pg, '/api/admin/parental-pin', {'pin': ''}, 'PUT'); pg.wait_for_timeout(4500)
    clean_lists = "V.setPref('chanLists', V.myLists().filter(function (l) { return l.name !== 'P3 test list'; })); V.setPref('liveStart', '__last'); V.setPref('guideStart', '__last')"
    pg.evaluate(clean_lists); pg.evaluate("V.setPref('guideStart', '')"); pg.wait_for_timeout(1000)
    live = pg.evaluate("S.live.map(function (c) { return { k: c.k, n: c.n, g: c.g, E: !!c.E }; })")
    groups = {}
    for c in live: groups.setdefault(c['g'], []).append(c)
    multi = [g for g in groups if len(groups[g]) >= 2]
    check('test data: live channels in a category with two or more', bool(multi))
    G = multi[0]; LOCKG = multi[-1] if len(multi) > 1 else multi[0]

    # ---- 7. Admin → Channels
    go(pg, '#/admin/channels', 3000)
    check('channel editor lists channels', pg.locator('.ce-row').count() > 0)
    pg.locator('.ce-pin summary').click(); pg.wait_for_timeout(300)
    pg.locator('[data-pin]').click(); pg.wait_for_timeout(500); pg.keyboard.type(PIN); pg.keyboard.press('Enter'); pg.wait_for_timeout(1500)
    check('parental PIN set', pg.evaluate("!!S.settings.parentalPin"))
    pg.fill('[data-f=q]', groups[G][0]['n'][:6]); pg.wait_for_timeout(1200)
    check('search finds the channel', pg.locator('.ce-row', has_text=groups[G][0]['n']).count() >= 1)
    pg.fill('[data-f=q]', ''); pg.wait_for_timeout(1200); pg.select_option('[data-f=g]', G); pg.wait_for_timeout(1500)
    names = lambda: pg.evaluate("[].map.call(document.querySelectorAll('.ce-row b'), function (x) { return x.textContent; })")
    before = names()
    check('category filter', len(before) == len(groups[G]), (G, before))
    pg.locator('.ce-row').nth(0).locator('[data-mv="1"]').click(); pg.wait_for_timeout(2000)
    after = names()
    check('move down in a category', after[:2] == [before[1], before[0]], after[:2])
    # shift-click selects a range
    pg.locator('.ce-row [data-pick]').nth(0).click(); pg.locator('.ce-row [data-pick]').nth(1).click(modifiers=['Shift']); pg.wait_for_timeout(400)
    check('shift-click selection', pg.locator('.ce-row.sel').count() == 2)
    pg.locator('[data-bulk=renumber]').click(); pg.wait_for_timeout(500); pg.fill('.dlg [data-v]', '500'); pg.keyboard.press('Enter'); pg.wait_for_timeout(2000)
    nums = sorted(x.get('num') for x in api(pg, '/api/admin/channels?g=' + G)['items'] if x.get('num') in (500, 501))
    check('bulk renumber from 500', nums == [500, 501], nums)
    # edit dialog: rename, guide pick, offset, logo upload
    target = groups[G][0]
    pg.locator('.ce-row', has_text=target['n']).first.locator('[data-edit]').click(); pg.wait_for_timeout(1000)
    pg.fill('[data-v=n]', target['n'] + ' (edited)')
    pg.locator('[data-gpick]').click(); pg.wait_for_timeout(1500)
    gi = pg.locator('.ce-gi')
    picked = gi.count() > 0
    if picked: gi.first.click(); pg.wait_for_timeout(600)
    pg.select_option('[data-v=off]', '1'); pg.wait_for_timeout(600)
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoAACQKAQOoFWrbAAAAAElFTkSuQmCC')
    pg.set_input_files('[data-upload]', files=[{'name': 'logo.png', 'mimeType': 'image/png', 'buffer': png}]); pg.wait_for_timeout(1500)
    pg.locator('.dlg-f .btn.primary').click(); pg.wait_for_timeout(2500)
    e = [x for x in api(pg, '/api/admin/channels?q=' + target['n'][:8])['items'] if x['k'] == target['k']]
    e = e[0] if e else {}
    check('edit: rename', e.get('n') == target['n'] + ' (edited)', e.get('n'))
    check('edit: uploaded logo', '/api/channel-logo/' in (e.get('logo') or ''), e.get('logo'))
    check('edit: time offset', e.get('off') == 1, e.get('off'))
    check('edit: hand-picked guide', not picked or bool(e.get('eo')), e.get('eo'))
    pg.wait_for_timeout(5000)
    check('edits reach the player catalogue', pg.evaluate("(k) => { var c = V.entry(k); return !!c && / \\(edited\\)$/.test(c.n); }", target['k']))
    # hide, then undo it from the "hidden" view
    pg.select_option('[data-f=g]', ''); pg.fill('[data-f=q]', groups[G][1]['n']); pg.wait_for_timeout(1200)
    pg.locator('.ce-row [data-pick]').first.click(); pg.locator('[data-bulk=hide]').click(); pg.wait_for_timeout(2500)
    hidden = [x['k'] for x in api(pg, '/api/admin/channels?show=hidden')['items']]
    check('bulk hide', groups[G][1]['k'] in hidden)
    pg.fill('[data-f=q]', ''); pg.select_option('[data-f=show]', 'hidden'); pg.wait_for_timeout(1500)
    pg.locator('.ce-row [data-pick]').first.click(); pg.locator('[data-bulk=unhide]').click(); pg.wait_for_timeout(5000)
    check('show again', groups[G][1]['k'] not in [x['k'] for x in api(pg, '/api/admin/channels?show=hidden')['items']])
    pg.select_option('[data-f=show]', ''); pg.wait_for_timeout(800)
    # lock a category
    pg.select_option('[data-f=g]', LOCKG); pg.wait_for_timeout(1500)
    pg.locator('.ce-gbar .switch').click(); pg.wait_for_timeout(2000)
    check('lock a category', LOCKG in api(pg, '/api/admin/locks').get('groups', []))
    check('channel editor fits', no_overflow(pg))

    # ---- 8, 9. TV guides: offsets per guide, placeholders switch
    go(pg, '#/admin/guides', 3000)
    sw = pg.locator('[data-ph]')
    check('placeholder switch on by default', sw.count() == 1 and sw.is_checked())
    pg.locator('[data-ph]').locator('xpath=..').click(); pg.wait_for_timeout(1500)
    check('placeholders off', pg.evaluate("S.settings.epgPlaceholders === false"))
    pg.locator('[data-ph]').locator('xpath=..').click(); pg.wait_for_timeout(1500)
    check('placeholders on again', pg.evaluate("S.settings.epgPlaceholders !== false"))
    go_ = pg.locator('[data-goff]')
    if go_.count():
        gid = go_.first.evaluate("(e) => e.closest('[data-id]').dataset.id")
        go_.first.select_option('0.5'); pg.wait_for_timeout(2500)
        check('guide offset +0.5 h', (api(pg, '/api/admin/guide-offsets').get('offsets') or {}).get(gid) == 0.5)
        api(pg, '/api/admin/guides/' + gid + '/offset', {'hours': 0}, 'PUT')

    # ---- 11. guide colours, 9. placeholders in the guide, locked rows
    pg.evaluate("V.ls.set('guideOnlyEpg', false)"); go(pg, '#/guide', 3500)
    check('guide legend', pg.locator('.g-legend .lg-i').count() >= 6)
    check('colour-coded programmes', pg.locator('.gp[class*=" k-"]').count() > 0)
    pg.locator('[data-colours]').locator('xpath=..').click(); pg.wait_for_timeout(1500)
    check('colours off', pg.locator('.gp[class*=" k-"]').count() == 0)
    pg.locator('[data-colours]').locator('xpath=..').click(); pg.wait_for_timeout(1500)
    for _ in range(15):
        if pg.locator('.gp.ph').count(): break
        pg.evaluate("[].forEach.call(document.querySelectorAll('#view *'), function (e) { if (e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop += 500; }); window.scrollBy(0, 500)"); pg.wait_for_timeout(400)
    noguide = [c for c in live if not c['E'] and c['g'] != LOCKG]
    check('placeholder blocks for channels without listings', not noguide or pg.locator('.gp.ph').count() > 0)
    pg.evaluate("V.ls.set('guideOnlyEpg', true)")

    # ---- 10. your channel lists
    go(pg, '#/mychannels')
    pg.locator('[data-new]').click(); pg.wait_for_timeout(500); pg.fill('.dlg [data-v]', 'P3 test list'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1000)
    for c in [x for x in live if x['g'] != LOCKG][:3]:
        pg.fill('[data-q]', c['n']); pg.wait_for_timeout(600)
        pg.locator('.mych-hit').first.click(); pg.wait_for_timeout(600)
    ks = lambda: pg.evaluate("[].map.call(document.querySelectorAll('[data-ol] [data-k]'), function (x) { return x.dataset.k; })")
    k0 = ks()
    check('add channels to your list', len(k0) == 3, len(k0))
    pg.locator('[data-ol] [data-k]').first.locator('[data-down]').click(); pg.wait_for_timeout(600)
    check('reorder your list', ks()[:2] == [k0[1], k0[0]])
    lid = pg.evaluate("V.myLists().filter(function (l) { return l.name === 'P3 test list'; })[0].id")
    pg.select_option('[data-start=liveStart]', '__my:' + lid); pg.select_option('[data-start=guideStart]', '__my:' + lid); pg.wait_for_timeout(1500)
    go(pg, '#/live')
    check('Live TV opens on your list', pg.locator('#view .ch-row, #view .chr').count() == 3, pg.locator('#view .chr').count())
    go(pg, '#/guide')
    check('guide opens on your list', pg.evaluate("[].some.call(document.querySelectorAll('#view select option'), function (o) { return o.selected && o.textContent === 'P3 test list'; })"))
    pg.evaluate("(k) => V.play(V.entry(k))", k0[0]); pg.wait_for_timeout(3500)
    pg.evaluate("V.openSide('channels')"); pg.wait_for_timeout(800)
    check('your list in the player channel list', pg.evaluate("[].some.call(document.querySelectorAll('.side-grp option'), function (o) { return o.textContent === 'P3 test list'; })"))
    pg.evaluate("V.closePlayer()"); pg.wait_for_timeout(800)
    # (A pretend screen to control, so the remote page stays open.)
    fake = lambda r: r.fulfill(status=200, content_type='application/json', body='[{"conn":"test","name":"Test screen"}]')
    pg.route('**/api/devices', fake); pg.route('**/api/devices/test/**', lambda r: r.fulfill(status=200, content_type='application/json', body='{}'))
    go(pg, '#/remote/test', 1500)
    check('your list on the phone remote', pg.locator('.rm-grps', has_text='P3 test list').count() == 1)
    pg.locator('.rm-grps button', has_text='P3 test list').click(); pg.wait_for_timeout(500)
    check('remote shows your list', pg.locator('.rm-chl [data-k]').count() == 3)
    go(pg, '#/home', 1500); pg.unroute('**/api/devices'); pg.unroute('**/api/devices/test/**')

    # ---- 12. On later
    go(pg, '#/onlater', 3000)
    rows = pg.locator('.ol-i').count()
    check('On later lists films and sport', rows > 0, rows)
    if rows:
        bell = pg.locator('.ol-i [data-rem]').first
        bell.click(); pg.wait_for_timeout(600)
        check('one-tap reminder', bell.get_attribute('aria-pressed') == 'true')
        bell.click(); pg.wait_for_timeout(600)
    pg.locator('[data-kind=news]').click(); pg.wait_for_timeout(2500)
    check('news can be added', 'news' in pg.evaluate("location.hash"))
    pg.locator('[data-kind=news]').click(); pg.wait_for_timeout(1500)
    go(pg, '#/live'); check('On later linked from Live TV', pg.locator('#view a[href="#/onlater"]').count() >= 1)
    go(pg, '#/guide'); check('On later linked from the guide', pg.locator('#view a[href="#/onlater"]').count() >= 1)

    # ---- 27. locks on the viewer side
    lockk = groups[LOCKG][0]['k']
    pg.evaluate("V.parental.lock()"); pg.wait_for_timeout(500)
    check('locked channel has no address', pg.evaluate("(k) => { var c = V.entry(k); return !!(c && c.lk && !c.u); }", lockk))
    r = api(pg, '/api/play/sources', {'k': lockk})
    check('server refuses a locked channel', r.get('status') == 423 or 'locked' in str(r.get('error', '')).lower(), r)
    pg.evaluate("(k) => V.play(V.entry(k))", lockk); pg.wait_for_timeout(1000)
    check('PIN asked before playing', pg.is_visible('.dlg [data-pin]'))
    pg.fill('.dlg [data-pin]', '0000'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1000)
    check('wrong PIN refused', pg.is_visible('.dlg [data-err]'))
    pg.fill('.dlg [data-pin]', PIN); pg.keyboard.press('Enter'); pg.wait_for_timeout(4000)
    check('right PIN unlocks and plays', pg.evaluate("!!(V.watch.it && V.watch.it.u)"))
    pg.evaluate("V.closePlayer()"); pg.wait_for_timeout(500)
    pg.evaluate("V.parental.lock()"); pg.wait_for_timeout(500)

    # ---- phone and TV
    for tag, ctx in (('phone', dict(viewport={'width': 360, 'height': 780}, device_scale_factor=2, is_mobile=True, has_touch=True, user_agent=UA_PHONE)),
                     ('tv', dict(viewport={'width': 1920, 'height': 1080}, user_agent=UA_TV))):
        q = open_app(b, tag, **ctx)
        if tag == 'tv': check('tv: TV mode', q.evaluate("document.documentElement.classList.contains('tv')"))
        for h in ('#/admin/channels', '#/admin/guides', '#/mychannels', '#/onlater', '#/guide', '#/live', '#/home'):
            go(q, h, 2500); check(tag + ': ' + h + ' fits the screen', no_overflow(q))
        go(q, '#/admin/channels', 2500)
        q.locator('.ce-row [data-edit]').first.click(); q.wait_for_timeout(1000)
        check(tag + ': edit dialog opens', q.is_visible('.dlg [data-v=n]'))
        q.keyboard.press('Escape'); q.wait_for_timeout(500)
        go(q, '#/mychannels'); q.locator('[data-sel^="__my:"]').first.click(); q.wait_for_timeout(500)
        k1 = q.evaluate("[].map.call(document.querySelectorAll('[data-ol] [data-k]'), function (x) { return x.dataset.k; })")
        q.locator('[data-ol] [data-k]').nth(1).locator('[data-up]').click(); q.wait_for_timeout(500)
        k2 = q.evaluate("[].map.call(document.querySelectorAll('[data-ol] [data-k]'), function (x) { return x.dataset.k; })")
        check(tag + ': reorder with the arrows', len(k1) > 1 and k2[0] == k1[1])
        if tag == 'tv':
            go(q, '#/admin/channels', 2500)
            q.locator('[data-f=q]').focus(); f = []
            for _ in range(8): q.keyboard.press('ArrowDown'); q.wait_for_timeout(120); f.append(q.evaluate("document.activeElement && (document.activeElement.dataset.edit !== undefined || document.activeElement.closest('.ce-row')) ? 1 : 0"))
            check('tv: arrow keys reach the channel rows', any(f))
        q.context.close()

    # ---- kids can't unlock
    kid = pg.evaluate("((S.boot && S.boot.profiles) || []).filter(function (x) { return x.kids; }).map(function (x) { return x.name; })[0] || ''")
    if kid:
        k = open_app(b, 'kids', profile=kid, pin='')
        r = api(k, '/api/parental/unlock', {'pin': PIN})
        check('kids profile cannot unlock', r.get('status') == 403 or 'error' in r, r)
        k.context.close()

    # ---- put everything back
    reset_all(pg)
    api(pg, '/api/admin/parental-pin', {'pin': ''}, 'PUT')
    pg.evaluate(clean_lists)
    pg.wait_for_timeout(1500)
    b.close()
print('page errors:', errors or 'none')
print('failed:', fails or 'none')
sys.exit(1 if errors or fails else 0)
