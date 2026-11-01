"""History, Continue watching and staying signed in, across reloads (with lazily loaded Xtream episodes)."""
import sys, tempfile
from playwright.sync_api import sync_playwright
B = sys.argv[1]; PIN = sys.argv[2] if len(sys.argv) > 2 else '1234'
errors = []
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(), headless=True, args=['--autoplay-policy=no-user-gesture-required'], viewport={'width': 1280, 'height': 800})
    pg = ctx.pages[0] if ctx.pages else ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(B); pg.wait_for_timeout(600)
    if pg.is_visible('#pw'): pg.fill('#pw', 'changeme'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1200)
    pg.click('.pf[data-id]'); pg.wait_for_timeout(500)
    if pg.is_visible('.pin-input'):
        print('remember box on PIN pad:', pg.is_visible('.pin-remember'), pg.is_checked('[data-remember]'))
        for d in PIN: pg.keyboard.type(d)
        pg.keyboard.press('Enter')
    pg.wait_for_timeout(2500)
    pg.evaluate("V.api('/api/history', {method: 'DELETE'}).then(() => { S.data.history = []; S.data.progress = {}; })"); pg.wait_for_timeout(500)
    eps = pg.evaluate("V.loadEpisodes(S.items.find(i => i.n === 'XT Show')).then(e => e.map(x => x.k))")
    print('episodes:', len(eps))
    pg.evaluate("(k) => V.play(V.entry(k))", eps[0]); pg.wait_for_timeout(26000)
    pg.evaluate("(k) => V.play(V.entry(k))", eps[1]); pg.wait_for_timeout(24000)   # like autoplay moving on
    pg.evaluate("V.closePlayer()"); pg.wait_for_timeout(1500)
    srv = pg.evaluate("V.api('/api/me').then(m => m.data ? m.data.history : m.history)")
    print('server history:', [(h.get('n'), h.get('s')) for h in (srv or [])])
    # Reload: should open straight into the profile (no picker, no PIN), and show the episodes.
    pg.reload(); pg.wait_for_timeout(4000)
    print('after reload → profile screen shown:', pg.is_visible('#profiles'), ' in app as:', pg.evaluate("S.profile && S.profile.name"))
    pg.wait_for_timeout(2000)
    print('continue watching:', pg.evaluate("V.continueWatching().map(c => c.it.n)"))
    pg.evaluate("location.hash = '#/mine/history'"); pg.wait_for_timeout(2500)
    print('history page:', pg.evaluate("[...document.querySelectorAll('.hist b')].map(b => b.textContent)"))
    ctx.close()
print('errors:', errors or 'none')
