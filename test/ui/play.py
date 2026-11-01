"""Playback through the real app: direct, relay (CORS/headers), conversion, DASH/DRM, backups, catch-up, series, local files."""
import sys, json, time
from playwright.sync_api import sync_playwright
B = sys.argv[1]; OUT = sys.argv[2]
errors = []
ST = """() => { const p = V.player; const v = p.video; const m = document.querySelector('.vp-msg');
  return {w: v.videoWidth, t: +v.currentTime.toFixed(1), msg: m.hidden ? '' : m.innerText.replace(/\\s+/g,' ').slice(0,160),
    via: p.attempt && (p.attempt.via + ':' + (p.attempt.kind || p.attempt.mode)), it: p.it && p.it.n, alt: p.alt} }"""
def login(pg):
    pg.goto(B); pg.wait_for_timeout(400)
    if pg.is_visible('#pw'):
        pg.fill('#pw', 'changeme'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1200)
    pg.click('.pf[data-id]'); pg.wait_for_timeout(500)
    if pg.is_visible('.pin-input'):
        for d in '1234': pg.keyboard.type(d)
        pg.keyboard.press('Enter')
    pg.wait_for_timeout(2500)
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(viewport={'width': 1440, 'height': 900})
    pg.on('pageerror', lambda e: errors.append(f'PAGEERROR {e}'))
    pg.on('console', lambda m: errors.append(f'{m.type}: {m.text[:200]}') if m.type == 'error' and 'Failed to load resource' not in m.text and 'CORS' not in m.text else None)
    login(pg)
    api = lambda path, body=None, method=None: pg.evaluate("([p, b, m]) => V.api(p, {body: b === null ? undefined : b, method: m || undefined}).catch(e => ({error: e.message}))", [path, body, method])
    lists = pg.evaluate("V.api('/api/admin').then(a => a.lists.map(l => l.name))")
    if 'NoCors' not in lists:
        print('add nocors:', str(api('/api/admin/lists', {'type': 'url', 'url': 'http://127.0.0.1:9100/nocors/vod.m3u', 'name': 'NoCors'}))[:120])
        print('add folder:', str(api('/api/admin/lists', {'type': 'folder', 'folders': ['/tmp/claude-0/-home-claude/ab5c43bb-b9fe-5fa3-b440-76c90e2bd465/scratchpad/media'], 'name': 'My Media'}))[:160])
        pg.wait_for_timeout(2500)
        pg.evaluate("V.loadCatalog()"); pg.wait_for_timeout(1500)
    print('items:', pg.evaluate("S.items.length"), pg.evaluate("S.items.filter(i => i.t !== 'episode').map(i => i.t[0] + ':' + i.n).join(' | ')")[:1500])
    def play(name, wait=8000, js=None):
        r = pg.evaluate("(n) => { const it = S.items.find(i => i.n === n); if (!it) return 'missing'; V.play(it); return 'ok'; }", name) if not js else pg.evaluate(js)
        if r == 'missing': print(f'  {name:28} MISSING'); return
        pg.wait_for_timeout(wait)
        s = pg.evaluate(ST); print(f'  {name:28} -> {s}'); return s
    print('== live')
    play('XT Pattern'); play('Cookie Channel'); play('Referer Channel'); play('Kodi Header Channel')
    play('Blocked Without Lumen', 9000)
    play('DASH Live', 9000); play('DASH ClearKey SB', 9000)
    play('UDP Multicast', 16000); play('Backup Test', 14000)
    pg.screenshot(path=f'{OUT}/p1-live.png')
    play('Radio Attribute Station', 6000)
    print('== catch-up')
    r = pg.evaluate("""() => { const c = S.items.find(i => i.n === 'Shift Catchup'); const nn = V.epg.nowNext(c); V.playCatchup(c, nn.now, 0); return nn.now && nn.now.t; }""")
    pg.wait_for_timeout(7000); print('  catch-up', r, pg.evaluate(ST))
    print('== vod')
    play('XT Movie', 6000)
    pg.mouse.move(700, 450); pg.wait_for_timeout(300); pg.screenshot(path=f'{OUT}/p2-movie.png')
    pg.evaluate("V.player.seek(20)"); pg.wait_for_timeout(1500); pg.evaluate("V.player._saveProgress()")
    print('  progress saved:', pg.evaluate("V.flushProgress(); JSON.stringify(V.progressOf(S.items.find(i => i.n === 'XT Movie').k))"))
    play('Surround AC3', 14000)
    play('Test Pattern', 6000); play('Fractal Journey', 15000); play('Upper E', 5000)
    print('== series (Xtream, loads episodes)')
    r = pg.evaluate("() => { const s = S.items.find(i => i.n === 'XT Show'); V.play(s); return !!s; }")
    pg.wait_for_timeout(7000); print('  show ->', pg.evaluate(ST))
    print('  next ep:', pg.evaluate("(V.nextEpisode(V.player.it) || {}).n"))
    pg.evaluate("V.player.seek(V.player.duration - 20)"); pg.wait_for_timeout(4000)
    print('  upnext visible:', pg.is_visible('.vp-upnext'))
    pg.screenshot(path=f'{OUT}/p3-upnext.png')
    pg.wait_for_timeout(22000)
    print('  after end ->', pg.evaluate(ST))
    print('== mini player')
    pg.evaluate("V.setMini(true); location.hash = '#/home'"); pg.wait_for_timeout(1500)
    pg.screenshot(path=f'{OUT}/p4-mini.png')
    print('  mini visible:', pg.is_visible('#player-layer.mini'), 'playing:', pg.evaluate("!V.player.video.paused"))
    pg.evaluate("V.closePlayer()")
    print('\n'.join(errors[:30]) or 'no page errors')
    b.close()
