"""TV remote check: from each page's first control, press every arrow key from every control it can reach, and list
anything on the page the arrow keys can never get to. Usage: python3 test/ui/tvreach.py http://localhost:8090 [#/route ...]"""
import json, sys
from playwright.sync_api import sync_playwright
B = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8090'
ROUTES = sys.argv[2:] or ['#/home', '#/live', '#/guide', '#/movies', '#/series', '#/radio', '#/mine', '#/search?q=a', '#/settings', '#/admin/overview', '#/admin/lists', '#/admin/profiles', '#/admin/security']
UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/7.0 TV Safari/537.36 Chrome/94.0'
GRAPH_JS = r"""
(async (opts) => {
  opts = opts || {};
  document.documentElement.classList.add('reduce-motion');
  const SEL = 'a[href], button:not([disabled]), [tabindex="0"], input:not([type=hidden]):not([disabled]), select, textarea, summary';
  const desc = (el) => { if (!el || el === document.body) return 'BODY'; const t = (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().replace(/\s+/g,' ').slice(0, 30); return el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '') + ' "' + t + '"'; };
  let ids = new Map(), list = [];
  const id = (el) => { if (!ids.has(el)) { ids.set(el, list.length); list.push(el); } return ids.get(el); };
  const keys = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'];
  const start = opts.start ? document.querySelector(opts.start) : document.activeElement;
  const q = [start]; id(start);
  const edges = {};
  let steps = 0;
  while (q.length && steps < (opts.max || 600)) {
    const el = q.shift(); steps++;
    const e = {};
    for (const k of keys) {
      el.focus(); el.scrollIntoView({block: 'nearest', inline: 'nearest'});
      if (document.activeElement !== el) { e[k] = 'NOFOCUS'; continue; }
      const ev = new KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true});
      el.dispatchEvent(ev);
      if (opts.wait) await new Promise(r => setTimeout(r, opts.wait));
      const to = document.activeElement;
      // (Where there's nothing close by, the page scrolls instead: press again to go on from there.)
      let to2 = to;
      for (let n = 0; n < 4 && to2 === el && (k === 'ArrowDown' || k === 'ArrowUp'); n++) { el.dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true})); to2 = document.activeElement; }
      if (to2 !== to) { const n2 = ids.has(to2); const i2 = id(to2); e[k] = i2; if (!n2) q.push(to2); continue; }
      if (to === el || !to || to === document.body) { e[k] = null; continue; }
      const n = ids.has(to); const i = id(to); e[k] = i; if (!n) q.push(to);
    }
    edges[ids.get(el)] = e;
  }
  // everything focusable in scope
  const scopeEl = opts.scope ? document.querySelector(opts.scope) : document.body;
  const all = Array.from(scopeEl.querySelectorAll(SEL)).filter(el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return (r.width > 2 && r.height > 2 || (el.tagName==='INPUT' && el.closest('label'))) && !el.closest('[hidden], .row-btn, .skip-link, details:not([open]) > :not(summary)') && cs.visibility !== 'hidden' && (el.offsetParent !== null || cs.position === 'fixed'); });
  const unreached = all.filter(el => !ids.has(el)).map(desc);
  return { reached: list.length, total: all.length, unreached: unreached, steps: steps, nodes: list.map(desc), edges: edges };
})
"""

with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(viewport={'width': 1920, 'height': 1080}, user_agent=UA)
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    # (No real sign-in codes are used up by the TV sign-in screen.)
    pg.route('**/api/pair/start', lambda r: r.fulfill(status=429, content_type='application/json', body='{"error":"not in this test"}'))
    pg.goto(B); pg.wait_for_timeout(500)
    if pg.is_visible('#usepw'): pg.click('#usepw')
    if pg.is_visible('#pw'): pg.fill('#pw', 'changeme'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1200)
    pg.wait_for_selector('.pf[data-id]', timeout=10000); pg.click('.pf[data-id]'); pg.wait_for_timeout(500)
    if pg.is_visible('.pin-input'): pg.type('.pin-input', '1234'); pg.keyboard.press('Enter')
    pg.wait_for_function("document.body.dataset.page === 'home'", timeout=30000); pg.wait_for_timeout(1500)
    clear = "document.querySelectorAll('#toasts .toast').forEach(t => t.remove())"
    bad = 0
    for rt in ROUTES:
        pg.evaluate("h => { location.hash = h; }", rt); pg.wait_for_timeout(2000); pg.evaluate(clear); pg.evaluate("window.scrollTo(0, 0)")
        r = pg.evaluate(GRAPH_JS + "(%s)" % json.dumps({'start': '#view button, #view a, #view input, #view select', 'max': 800}))
        print('%-22s reached %d of %d' % (rt, r['reached'], r['total']))
        for u in r['unreached'][:15]: print('    can\'t reach', u)
        bad += len(r['unreached'])
    print('errors:', errs or 'none')
    b.close()
    sys.exit(1 if bad or errs else 0)
