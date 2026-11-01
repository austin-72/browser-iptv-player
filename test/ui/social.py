"""Two people, two browsers: profiles, messages with a shared title, watch party sync, handoff between devices."""
import sys
from playwright.sync_api import sync_playwright
B = sys.argv[1]; OUT = sys.argv[2]
errors = []
def browser(p, w=1280, h=800):
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(viewport={'width': w, 'height': h})
    pg.on('pageerror', lambda e: errors.append(f'PAGEERROR {e}'))
    return b, pg
def signin(pg, name, pin=None):
    pg.goto(B); pg.wait_for_timeout(400)
    if pg.is_visible('#pw'): pg.fill('#pw', 'changeme'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1200)
    pg.click(f'.pf:has-text("{name}")'); pg.wait_for_timeout(500)
    if pin:
        for d in pin: pg.keyboard.type(d)
        pg.keyboard.press('Enter')
    pg.wait_for_timeout(2500)
api = lambda pg, path, body=None, method=None: pg.evaluate("([p, b, m]) => V.api(p, {body: b === null ? undefined : b, method: m || undefined}).catch(e => ({error: e.message}))", [path, body, method])
with sync_playwright() as p:
    ba, A = browser(p); signin(A, 'Dad', '1234')
    for prof in [{'name': 'Mom', 'avatar': 40, 'pin': '5555'}, {'name': 'Kiddo', 'avatar': 60, 'kids': True}]:
        r = api(A, '/api/profiles', prof); print('create', prof['name'], str(r)[:100])
    bb, Bp = browser(p); signin(Bp, 'Mom', '5555')
    api(Bp, '/api/me', {'langs': None}, 'PUT'); Bp.evaluate("V.loadCatalog(true)"); Bp.wait_for_timeout(1500)
    print('Mom profile:', Bp.evaluate("S.profile.name"), 'items:', Bp.evaluate("S.items.length"))
    bk, K = browser(p, 390, 844); signin(K, 'Kiddo')
    print('Kiddo items:', K.evaluate("S.items.length"), K.evaluate("S.items.map(i => i.n).slice(0, 10)"))
    K.screenshot(path=f'{OUT}/s0-kids.png')
    mom = Bp.evaluate("S.profile.id"); dad = A.evaluate("S.profile.id")
    # Message with a shared title
    A.evaluate("location.hash = '#/home'"); Bp.evaluate("location.hash = '#/home'"); A.wait_for_timeout(800)
    it = A.evaluate("(() => { const x = S.items.find(i => i.n === 'XT Movie'); return {k: x.k, n: x.n, t: x.t, i: x.i || ''}; })()")
    print('send:', str(api(A, '/api/messages', {'to': mom, 'text': 'You have to watch this!', 'item': it}))[:80])
    Bp.wait_for_timeout(1500)
    print('Mom toast:', Bp.evaluate("[...document.querySelectorAll('.toast')].map(t => t.innerText).join(' | ')"), 'unread badge:', Bp.evaluate("document.querySelector('.unread-badge').textContent"))
    Bp.evaluate(f"location.hash = '#/messages/{dad}'"); Bp.wait_for_timeout(1500)
    Bp.screenshot(path=f'{OUT}/s1-messages.png')
    Bp.fill('.composer textarea', 'Watching it tonight 🍿'); Bp.keyboard.press('Enter'); Bp.wait_for_timeout(1000)
    A.evaluate(f"location.hash = '#/messages/{mom}'"); A.wait_for_timeout(1500)
    print('Dad sees:', A.evaluate("[...document.querySelectorAll('.msg .txt')].map(x => x.innerText)"))
    A.screenshot(path=f'{OUT}/s2-messages-dad.png')
    # Watch party
    party = api(A, '/api/party', {'k': it['k'], 'n': it['n'], 't': it['t'], 'i': it['i'], 'pos': 0, 'invite': [mom]})
    print('party:', party.get('id'), party.get('members'))
    A.evaluate("(p) => V.party.join(p)", party['id']); A.wait_for_timeout(1500)
    Bp.wait_for_timeout(500)
    Bp.evaluate("(p) => V.party.join(p)", party['id']); Bp.wait_for_timeout(6000)
    st = lambda pg: pg.evaluate("({pos: +V.player.position.toFixed(1), paused: V.player.video.paused, it: V.player.it && V.player.it.n, members: V.party.current && V.party.current.members.length})")
    print('after join  A:', st(A), ' B:', st(Bp))
    A.evaluate("V.player.togglePlay()"); A.wait_for_timeout(1500)
    print('Dad paused  A:', st(A), ' B:', st(Bp))
    A.evaluate("V.player.seek(25)"); A.wait_for_timeout(500); A.evaluate("V.player.togglePlay()"); A.wait_for_timeout(2500)
    print('Dad seek+play A:', st(A), ' B:', st(Bp))
    api(Bp, f"/api/party/{party['id']}/chat", {'text': 'Best scene!'}); api(Bp, f"/api/party/{party['id']}/chat", {'emoji': '🔥'}); A.wait_for_timeout(700)
    A.mouse.move(600, 400); A.screenshot(path=f'{OUT}/s3-party.png')
    print('party chat on A:', A.evaluate("document.querySelector('.party-chat') && document.querySelector('.party-chat').innerText"))
    # Handoff: Dad on a second device tells the first to play something
    bc, C = browser(p); signin(C, 'Dad', '1234')
    devs = api(C, '/api/devices'); print('Dad devices:', [d['name'] for d in devs])
    A.evaluate("V.party.leave(); V.closePlayer()"); Bp.evaluate("V.closePlayer()")
    other = [d for d in devs if d['conn'] != C.evaluate("S.conn")][0]
    xs = C.evaluate("S.items.find(i => i.n === 'Pattern One').k")
    print('command:', api(C, f"/api/devices/{other['conn']}/command", {'cmd': 'play', 'k': xs, 'pos': 0})); A.wait_for_timeout(5000)
    print('Dad device 1 now playing:', A.evaluate("V.player.it && V.player.it.n"), A.evaluate("V.player.video.videoWidth"))
    # Presence: Mom sees Dad watching
    soc = api(Bp, '/api/social'); print('Mom sees presence:', [(x['n']) for x in soc['presence']])
    print('\n'.join(errors[:20]) or 'no page errors')
    for x in (ba, bb, bk, bc): x.close()
