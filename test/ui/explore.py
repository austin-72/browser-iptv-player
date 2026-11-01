"""Exploratory UI pass: sign in, pick profile with PIN, visit every page, screenshot, collect console errors."""
import sys, json
from playwright.sync_api import sync_playwright
B = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8090'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/tmp/shots'
W = int(sys.argv[3]) if len(sys.argv) > 3 else 1440
H = int(sys.argv[4]) if len(sys.argv) > 4 else 900
import os; os.makedirs(OUT, exist_ok=True)
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': W, 'height': H}, has_touch=W < 800, is_mobile=W < 800)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(f'PAGEERROR {e}'))
    pg.on('console', lambda m: errors.append(f'{m.type}: {m.text[:300]}') if m.type in ('error',) and 'Failed to load resource' not in m.text else None)
    pg.goto(B); pg.wait_for_timeout(500)
    pg.screenshot(path=f'{OUT}/00-login.png')
    pg.fill('#pw', 'changeme'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1500)
    pg.screenshot(path=f'{OUT}/01-profiles.png')
    pg.click('.pf[data-id]'); pg.wait_for_timeout(600)
    pg.screenshot(path=f'{OUT}/02-pin.png')
    for d in '1234': pg.keyboard.type(d)
    pg.keyboard.press('Enter'); pg.wait_for_timeout(2500)
    pg.screenshot(path=f'{OUT}/03-home.png')
    for i, h in enumerate(['#/live', '#/guide', '#/movies', '#/series', '#/search?q=pattern', '#/mine', '#/messages', '#/settings', '#/admin', '#/admin/lists', '#/admin/profiles', '#/admin/content', '#/admin/playback', '#/downloads']):
        pg.evaluate("(h) => { location.hash = h; }", h); pg.wait_for_timeout(1500)
        pg.screenshot(path=f'{OUT}/1{i:02d}-{h.strip("#/").replace("/", "_").replace("?", "_")}.png')
    print('\n'.join(errors) or 'no errors')
    b.close()
