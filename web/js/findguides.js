/* Admin → TV guides → Find guides and logos: suggestions from public databases (iptv-org, epg.pw) for channels with
   no guide or no logo. Nothing is downloaded until the admin asks, and nothing changes until they accept a match.
   See lib/publicdb.js. */
'use strict';
(function () {
  var esc = V.esc;
  var SURE = 0.85, LIKELY = 0.6;
  var confOf = function (s) { return Math.max(s.logo ? s.logo.conf : 0, s.guide ? s.guide.conf : 0); };
  var confChip = function (c) { return c >= SURE ? '<span class="chip sm ok">Sure</span>' : c >= LIKELY ? '<span class="chip sm">Likely</span>' : '<span class="chip sm warn">Maybe</span>'; };
  var mem = { show: 'all', picked: {}, n: 100 };

  // A button on Admin → TV guides.
  var guidesTab = V.adminTabs.guides;
  V.adminTabs.guides = function (body, A) {
    guidesTab(body, A);
    var tools = V.$('.page-tools', body);
    if (tools) tools.insertAdjacentHTML('beforeend', '<a class="btn" href="#/admin/findguides">' + V.icon('search') + ' Find guides and logos</a>');
  };

  V.adminTabs.findguides = function (body) {
    var R = null, timer = null;
    var load = function () {
      return V.api('/api/admin/findguides').then(function (r) {
        if (!body.isConnected) return;
        var was = R && R.result && R.result.at;
        R = r;
        if (r.result && r.result.at !== was) { mem.picked = {}; mem.n = 100; r.result.items.forEach(function (s) { mem.picked[s.k] = { logo: !!(s.logo && s.logo.conf >= SURE), guide: !!(s.guide && s.guide.conf >= SURE) }; }); }
        draw();
        clearTimeout(timer);
        if (r.job && r.job.running) timer = setTimeout(load, 1500);
      }).catch(function (e) { body.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; });
    };
    var shown = function () {
      var items = (R.result && R.result.items) || [];
      return items.filter(function (s) { var c = confOf(s); return mem.show === 'all' || (mem.show === 'sure' ? c >= SURE : mem.show === 'maybe' ? c < SURE : mem.show === 'logo' ? !!s.logo : !!s.guide); });
    };
    var rowHtml = function (s) {
      var pk = mem.picked[s.k] || {}, done = s.done || {};
      var m = s.match;
      return '<li class="gf-row' + (done.logo || done.guide ? ' done' : '') + '" data-k="' + esc(s.k) + '">' +
        '<div class="gf-ch">' + V.art(s.logo0, s.n, 'art sm') + '<span class="gf-main"><b class="truncate">' + esc(s.n) + '</b><small class="dim truncate">' + (s.num ? s.num + ' · ' : '') + esc(s.g) + (s.country ? ' · ' + esc(s.country) : '') + '</small></span>' + confChip(confOf(s)) + '</div>' +
        '<div class="gf-sug">' +
        (s.logo ? '<label class="check gf-opt"><input type="checkbox" data-pick="logo"' + (pk.logo || done.logo ? ' checked' : '') + (done.logo ? ' disabled' : '') + '>' + V.art(s.logo.url, s.n, 'art sm gf-logo') + '<span>' + (done.logo ? '<b>Logo added</b>' : 'Logo') + ' <small class="dim">from ' + esc(s.logo.from) + '</small></span></label>' : '') +
        (s.guide ? '<label class="check gf-opt"><input type="checkbox" data-pick="guide"' + (pk.guide || done.guide ? ' checked' : '') + (done.guide ? ' disabled' : '') + '><span>' + (done.guide ? '<b>Guide linked:</b> ' : 'Guide: ') + esc(s.guide.label) + (s.guide.kind === 'epgpw' && !done.guide ? ' <small class="dim">(adds this guide)</small>' : '') + '</span></label>' : '') +
        (m ? '<small class="dim gf-why">Matched to “' + esc(m.name) + '” (' + esc(m.id) + ') · ' + esc(m.why) + '</small>' : '<small class="dim gf-why">Matched by name in the guide’s channel list</small>') +
        '</div>' + (done.logo || done.guide ? '' : '<button class="btn sm" data-accept>Accept</button>') + '</li>';
    };
    var draw = function () {
      var j = R.job, res = R.result, need = R.need;
      var running = j && j.running;
      var items = res ? res.items : [];
      var sure = items.filter(function (s) { return !(s.done && (s.done.logo || s.done.guide)) && confOf(s) >= SURE; });
      var list = res ? shown() : [];
      var ticked = items.filter(function (s) { var p = mem.picked[s.k]; var d = s.done || {}; return p && ((p.logo && !d.logo) || (p.guide && !d.guide)); }).length;
      var a = document.activeElement, keep = a && body.contains(a) ? (a.closest('[data-k]') ? '[data-k="' + a.closest('[data-k]').dataset.k + '"] ' : '') + (a.hasAttribute('data-pick') ? '[data-pick="' + a.dataset.pick + '"]' : a.hasAttribute('data-show') ? '[data-show="' + a.dataset.show + '"]' : a.hasAttribute('data-accept') ? '[data-accept]' : '') : '';
      var cache = R.cache.iptvorg ? 'The public lists were downloaded ' + V.fmtAgo(R.cache.iptvorg) + ' and are kept for a week.' : 'The first search downloads the public channel, logo and guide lists (several tens of MB); they’re kept for a week.';
      body.innerHTML =
        '<div class="page-tools"><a class="btn" href="#/admin/guides">' + V.icon('back') + ' TV guides</a></div>' +
        '<section class="card-sec"><h2><span class="dim">TV guides ›</span> Find guides and logos</h2>' +
        '<p class="dim">For channels with no TV guide or no logo, this looks in two free public databases and suggests matches: <b>iptv-org</b> (channel names, logos, and the channel ids many guides use) and <b>epg.pw</b> (ready-made guides per country). Nothing changes until you accept a match. Accepted logos are saved like ones you set in Admin → Channels; accepted guides add only the guides needed and link the channel to them.</p>' +
        '<p>' + V.plural(need.guide, 'channel has', 'channels have') + ' no guide, and ' + V.plural(need.logo, 'channel has', 'channels have') + ' no logo.</p>' +
        '<p class="small dim">' + cache + '</p>' +
        '<div class="btn-row">' + (running ? '<button class="btn" data-stopscan>' + V.icon('x') + ' Stop</button>' : '<button class="btn primary" data-scan>' + V.icon('search') + ' ' + (res ? 'Look again' : 'Look for matches') + '</button>' + (R.cache.iptvorg ? '<button class="btn" data-refresh>' + V.icon('refresh') + ' Download fresh lists and look</button>' : '')) + '</div>' +
        (running ? '<p class="gf-step"><span class="spinner sm"></span> ' + esc(j.step || 'Working…') + '</p>' : j && j.error ? '<div class="note warn">' + V.icon('info') + ' <span>' + esc(j.error) + '</span></div>' : '') +
        '<details class="gf-own"><summary>Your own iptv-org guide (optional)</summary><p class="small dim">If you run the iptv-org EPG grabber yourself, give its guide address: channels iptv-org has listings for can then use it.</p><div class="gf-own-r"><input class="input" type="url" data-own value="' + esc(R.iptvGuide) + '" placeholder="http://…/guide.xml" aria-label="Your iptv-org guide address"><button class="btn sm" data-saveown>Save</button></div></details></section>' +
        (res ? '<section class="card-sec"><h2>Suggestions</h2>' + (res.warnings || []).map(function (w) { return '<div class="note warn">' + V.icon('info') + ' <span>' + esc(w) + '</span></div>'; }).join('') +
          (items.length ? '<p class="dim">' + V.plural(items.length, 'channel') + ' with a suggestion, of ' + res.checked + ' looked at' + (res.countries && res.countries.length ? ' · epg.pw countries read: ' + esc(res.countries.join(', ')) : '') + '.</p>' +
            '<div class="btn-row">' + (sure.length ? '<button class="btn primary" data-sure>' + V.icon('check') + ' Accept all sure matches (' + sure.length + ')</button>' : '') + (ticked ? '<button class="btn" data-ticked>Accept ticked (' + ticked + ')</button>' : '') + '</div>' +
            '<div class="chips" role="group" aria-label="Show">' + [['all', 'All'], ['sure', 'Sure'], ['maybe', 'Not sure'], ['guide', 'Guides'], ['logo', 'Logos']].map(function (c) { return '<button class="chip' + (mem.show === c[0] ? ' on' : '') + '" data-show="' + c[0] + '" aria-pressed="' + (mem.show === c[0]) + '">' + c[1] + '</button>'; }).join('') + '</div>' +
            (list.length ? '<ul class="gf-list">' + list.slice(0, mem.n).map(rowHtml).join('') + '</ul>' + (list.length > mem.n ? '<div class="btn-row"><button class="btn" data-more>Show more</button></div>' : '') : '<p class="dim">Nothing here.</p>')
            : '<p class="dim">No matches found' + (res.checked ? ' for the ' + V.plural(res.checked, 'channel') + ' without a guide or logo' : ': every channel has a guide and a logo') + '.</p>') + '</section>' : '');
      if (keep) { var el = null; try { el = V.$(keep, body); } catch (e) {} if (el) el.focus(); }
    };
    var apply = function (items) {
      if (!items.length) return;
      V.api('/api/admin/findguides/apply', { body: { items: items } }).then(function (r) {
        V.toast('Added ' + V.plural(r.logos, 'logo') + ' and linked ' + V.plural(r.guides, 'guide') + (r.added.length ? '. Adding the guide' + (r.added.length > 1 ? 's ' : ' ') + r.added.join(' and ') + ' — listings appear once ' + (r.added.length > 1 ? 'they’ve' : 'it’s') + ' downloaded.' : '.'), { ms: 7000 });
        load();
      }).catch(V.fail);
    };
    body.onclick = function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-scan') || b.hasAttribute('data-refresh')) V.api('/api/admin/findguides/scan', { body: { refresh: b.hasAttribute('data-refresh') } }).then(load).catch(V.fail);
      else if (b.hasAttribute('data-stopscan')) V.del('/api/admin/findguides/scan').then(load).catch(V.fail);
      else if (b.hasAttribute('data-saveown')) V.put('/api/admin/findguides/settings', { iptvGuide: V.$('[data-own]', body).value.trim() }).then(function () { V.toast('Saved — look again to use it'); load(); }).catch(V.fail);
      else if (b.hasAttribute('data-show')) { mem.show = b.dataset.show; mem.n = 100; draw(); }
      else if (b.hasAttribute('data-more')) { mem.n += 100; draw(); }
      else if (b.hasAttribute('data-sure')) apply(R.result.items.filter(function (s) { return confOf(s) >= SURE; }).map(function (s) { return { k: s.k, logo: !!(s.logo && s.logo.conf >= SURE), guide: !!(s.guide && s.guide.conf >= SURE) }; }));
      else if (b.hasAttribute('data-ticked')) apply(R.result.items.filter(function (s) { var p = mem.picked[s.k]; return p && (p.logo || p.guide); }).map(function (s) { var p = mem.picked[s.k]; return { k: s.k, logo: !!p.logo, guide: !!p.guide }; }));
      else if (b.hasAttribute('data-accept')) {
        var k = b.closest('[data-k]').dataset.k, p = mem.picked[k] || {};
        var s = R.result.items.filter(function (x) { return x.k === k; })[0];
        // Nothing ticked on this row: "Accept" means everything suggested for it.
        if (!p.logo && !p.guide) p = { logo: !!(s && s.logo), guide: !!(s && s.guide) };
        apply([{ k: k, logo: !!p.logo, guide: !!p.guide }]);
      }
    };
    body.onchange = function (e) {
      var t = e.target;
      if (!t.hasAttribute('data-pick')) return;
      var k = t.closest('[data-k]').dataset.k;
      var p = mem.picked[k] || (mem.picked[k] = {});
      p[t.dataset.pick] = t.checked;
      draw();
    };
    V.pageCleanup = function () { clearTimeout(timer); };
    body.innerHTML = '<div class="spinner"></div>';
    // Reached from Admin → TV guides: that tab stays highlighted.
    V.$$('.admin-tabs .tab').forEach(function (t) { var on = t.getAttribute('href') === '#/admin/guides'; t.classList.toggle('on', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); if (on && t.parentNode.scrollWidth > t.parentNode.clientWidth) t.parentNode.scrollLeft = Math.max(0, t.offsetLeft - 16); });
    load();
  };
})();
