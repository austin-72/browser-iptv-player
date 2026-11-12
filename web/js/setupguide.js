/* The setup guide (#/setup): after the setup page (web/setup.html) has made the admin, the rest of getting going, a
   step at a time — the playlists, the TV guide, languages, TMDB, the time zone, how much of the app, and opening it
   on the household's other devices. Every step can be skipped; Admin's overview offers it again until it's finished. */
'use strict';
(function () {
  var STEPS = [
    { id: 'lists', t: 'Your playlists' },
    { id: 'guide', t: 'TV guide' },
    { id: 'langs', t: 'Languages' },
    { id: 'tmdb', t: 'Posters and details' },
    { id: 'tz', t: 'Time zone' },
    { id: 'extras', t: 'How much of the app' },
    { id: 'devices', t: 'Your other devices' },
  ];
  var browserTz = V.browserTz = function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } };
  /** Is a step done? (Steps with nothing to do count as done.) */
  var done = function (id, A) {
    var c = (A.status.catalog && A.status.catalog.counts) || {};
    if (id === 'lists') return A.lists.length > 0;
    if (id === 'guide') return !c.live || !!(A.status.epg && A.status.epg.channels);
    if (id === 'langs') return !!(A.settings.defaultLangs && A.settings.defaultLangs.length);
    if (id === 'tmdb') return !!A.status.tmdb.enabled;
    return true;
  };
  V.setupProgress = function (A) { return STEPS.filter(function (s) { return done(s.id, A); }).length + ' of ' + STEPS.length; };

  V.route('setup', function (view, r) {
    if (!S.profile || !S.profile.admin) { V.router.go('#/home', true); return; }
    var cur = r.q.get('s') || '';
    view.innerHTML = '<div class="sg"><div class="spinner"></div></div>';
    V.api('/api/admin').then(function (A) {
      S.admin = A;
      if (!document.documentElement.contains(view)) return;
      var i = Math.max(0, STEPS.map(function (s) { return s.id; }).indexOf(cur));
      if (!cur) { var firstOpen = STEPS.filter(function (s) { return !done(s.id, A); })[0]; i = firstOpen ? STEPS.indexOf(firstOpen) : 0; }
      draw(view, A, i);
    }).catch(function (e) { view.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
  });

  function go(i) { V.router.go('#/setup?s=' + STEPS[i].id, true); }

  function draw(view, A, i) {
    var step = STEPS[i], last = i === STEPS.length - 1;
    view.innerHTML = '<div class="sg">' + V.pageHead('Set up') +
      '<p class="dim sg-lead">A few minutes, a step at a time. Skip anything and come back to it from Admin.</p>' +
      '<div class="sg-wrap"><ol class="sg-steps">' + STEPS.map(function (s, j) {
        var ok = done(s.id, A);
        return '<li><a href="#/setup?s=' + s.id + '"' + (j === i ? ' aria-current="step"' : '') + ' class="' + (j === i ? 'on' : '') + '"><span class="sg-n' + (ok ? ' ok' : '') + '">' + (ok ? V.icon('check') : j + 1) + '</span><span>' + V.esc(s.t) + '</span>' + (ok && j !== i ? '<span class="sr-only"> (done)</span>' : '') + '</a></li>';
      }).join('') + '</ol>' +
      '<section class="card-sec sg-body" aria-labelledby="sg-h"><h2 id="sg-h">' + V.esc(step.t) + '</h2><div class="sg-step"></div>' +
      '<div class="btn-row sg-nav">' + (i ? '<button class="btn" data-sg-back>' + V.icon('back') + ' Back</button>' : '') + '<span class="sp"></span>' +
      (last ? '<button class="btn primary" data-sg-finish>Finish</button>' : '<button class="btn' + (done(step.id, A) ? ' primary' : '') + '" data-sg-next>' + (done(step.id, A) ? 'Next' : 'Skip for now') + ' ' + V.icon('next') + '</button>') + '</div></section></div></div>';
    var body = V.$('.sg-step', view);
    var redraw = function () { return V.api('/api/admin').then(function (A2) { S.admin = A2; if (document.documentElement.contains(body)) draw(view, A2, i); }); };
    (RENDER[step.id] || function () {})(body, A, redraw);
    V.$('.sg-nav', view).onclick = function (e) {
      if (e.target.closest('[data-sg-back]')) go(i - 1);
      else if (e.target.closest('[data-sg-next]')) go(i + 1);
      else if (e.target.closest('[data-sg-finish]')) V.adminSave({ setupDone: true }, 'All set — enjoy!').then(function () { V.router.go('#/home'); });
    };
  }

  var RENDER = {
    lists: function (body, A, redraw) {
      body.innerHTML = '<p>Add what your provider gave you: a <b>playlist address</b> (an M3U link) or an <b>Xtream Codes</b> login (a server, a username and a password). It’s read straight away, and everyone in the household sees it.</p>' +
        (A.lists.length ? '<ul class="sg-lists">' + A.lists.map(function (l) {
          var st = l.status || {};
          return '<li>' + V.icon(st.error ? 'info' : 'check', st.error ? '' : 'ok') + ' <b>' + V.esc(l.name) + '</b> <span class="dim">' + (st.error ? '<span class="err">' + V.esc(st.error) + '</span>' : V.plural(st.count || 0, 'item')) + '</span></li>';
        }).join('') + '</ul>' : '') +
        '<div class="btn-row"><button class="btn ' + (A.lists.length ? '' : 'primary') + '" data-add>' + V.icon('plus') + ' ' + (A.lists.length ? 'Add another' : 'Add a list') + '</button>' + (A.lists.length ? '<a class="btn" href="#/admin/lists">All the lists</a>' : '') + '</div>' +
        '<p class="dim small">Also possible: a MAC portal, your own video folders, Jellyfin, Plex or Emby (in the same window).</p>';
      V.$('[data-add]', body).onclick = function () { V.addListDialog().then(function (ok) { if (ok) redraw(); }); };
    },
    guide: function (body, A) {
      var c = A.status.catalog.counts || {}, ep = A.status.epg || {};
      if (!c.live) { body.innerHTML = '<p>No live channels in your lists' + (A.lists.length ? '' : ' yet') + ', so there’s no TV guide to add.</p>'; return; }
      body.innerHTML = ep.channels ? '<p>' + V.icon('check', 'ok') + ' The TV guide is in: listings for ' + V.plural(ep.channels, 'channel') + '.</p><p class="dim">Channels still without listings can be matched to a guide in Admin → TV guides.</p>' :
        '<p>Most Xtream Codes accounts bring their own guide; after adding one it can take a few minutes to arrive. Otherwise, add an XMLTV guide address from your provider, or let the app look for free ones that match your channels.</p>';
      body.innerHTML += '<div class="btn-row"><a class="btn" href="#/admin/guides">' + V.icon('clock') + ' TV guides</a><a class="btn" href="#/admin/findguides">' + V.icon('search') + ' Find guides for my channels</a></div>';
    },
    langs: function (body, A, redraw) {
      body.innerHTML = '<p>Which languages should everyone see? Lists often carry channels and films in many; ticking yours hides the rest. Each profile can choose its own later. Leave them all unticked to show everything.</p><div class="lang-pick">' + V.langChecks(A.settings.defaultLangs) + '</div>' +
        '<label class="check"><input type="checkbox" data-unknown' + (A.settings.showUnknownLang ? ' checked' : '') + '><span>Also show things whose language can’t be worked out</span></label>' +
        '<div class="btn-row"><button class="btn primary" data-save>Save languages</button></div>';
      V.$('[data-save]', body).onclick = function () {
        V.adminSave({ defaultLangs: V.$$('.lang-pick input:checked', body).map(function (x) { return x.value; }), showUnknownLang: V.$('[data-unknown]', body).checked }, 'Saved').then(redraw);
      };
    },
    tmdb: function (body, A, redraw) {
      var on = A.status.tmdb.enabled;
      body.innerHTML = '<p>A free key from The Movie Database (TMDB) adds posters, descriptions, cast and ratings, better recommendations, which streaming service a title is on, and age ratings for parental limits. Optional, and well worth the two minutes.</p>' +
        (on ? '<p>' + V.icon('check', 'ok') + ' TMDB is on.</p>' : '<ol class="small"><li>Make a free account at <a href="https://www.themoviedb.org/signup" target="_blank" rel="noopener noreferrer">themoviedb.org</a>.</li><li>In its Settings → API, ask for an API key (“Developer”, any app name).</li><li>Paste the “API Key” or the “API Read Access Token” here.</li></ol>') +
        '<label class="field"><span>TMDB key</span><div class="inline"><input class="input" data-key value="' + V.esc(A.settings.tmdbKey || '') + '" placeholder="Paste the key" autocomplete="off"><button class="btn primary" data-save>Save and test</button></div></label>' +
        '<p class="dim small">Data and images from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.</p>';
      V.$('[data-save]', body).onclick = function () {
        V.adminSave({ tmdbKey: V.$('[data-key]', body).value }, 'Saved').then(function () { return V.api('/api/admin/tmdb/test', { method: 'POST' }); }).then(function (j) { V.toast(j.ok ? 'TMDB works' : 'TMDB: ' + j.error, { error: !j.ok }); redraw(); }).catch(V.fail);
      };
    },
    tz: function (body, A, redraw) {
      var tz = A.status.tz || {}, mine = browserTz();
      body.innerHTML = '<p>The TV guide’s days, recordings and screen-time limits follow the server’s time zone.</p><p>It’s <b>' + V.esc(tz.now || 'not known') + '</b>' + (tz.env ? ' (set by TZ where the server is started)' : '') + '.</p>' +
        (mine && mine !== tz.now ? (tz.env ? '<p class="note warn">' + V.icon('info') + ' <span>This device is on ' + V.esc(mine) + '. To change the server’s, change TZ in its docker-compose.yml (or remove it) and restart it.</span></p>' :
          '<p class="note warn">' + V.icon('info') + ' <span>This device is on ' + V.esc(mine) + '.</span></p><div class="btn-row"><button class="btn primary" data-use>Use ' + V.esc(mine) + '</button></div>') : '<p>' + V.icon('check', 'ok') + ' The same as this device.</p>');
      var u = V.$('[data-use]', body);
      if (u) u.onclick = function () { V.adminSave({ timeZone: mine }, 'Time zone saved').then(redraw); };
    },
    extras: function (body, A, redraw) {
      var off = A.settings.off || {}, simple = Object.keys(off).length > 0;
      body.innerHTML = '<p>Everything is on to start with. If your household just wants to watch, the extras can go from every menu (messages, watch parties, multiview, trailers, the play queue, statistics and more). Switch any of them back on in Admin → Playback whenever you like.</p>' +
        '<div class="sg-choices"><button class="sg-choice" data-areas="all" aria-pressed="' + !simple + '"><b>Everything</b><span>All of it, for households that like to explore.</span></button><button class="sg-choice" data-areas="simple" aria-pressed="' + simple + '"><b>Simple: just watching</b><span>Live TV, films, series, the guide and recordings.</span></button></div>';
      body.onclick = function (e) {
        var b = e.target.closest('[data-areas]');
        if (!b) return;
        var simpleNow = b.dataset.areas === 'simple';
        // (The same as Admin → Playback's two buttons: admin.js AREA_SW, the parts that aren't settings of their own.)
        var off2 = {};
        if (simpleNow) ['messages', 'multiview', 'trailers', 'moods', 'queue', 'wishlist', 'follow', 'viewing', 'themes', 'rightnow'].forEach(function (k) { off2[k] = true; });
        V.adminSave({ off: off2, allowDownloads: !simpleNow, allowParties: !simpleNow }, simpleNow ? 'Simple: the extras are off' : 'Everything is on').then(function () { if (V.applyAreas) V.applyAreas(); redraw(); });
      };
    },
    devices: function (body, A) {
      var local = /^(localhost|127\.|\[?::1\]?$)/.test(location.hostname);
      var urls = local ? (A.status.lanUrls || []) : [location.origin];
      var https = location.protocol === 'https:';
      body.innerHTML = '<p>Everyone else opens the same address in their browser — on a phone, a tablet, a computer or a smart TV — types the site password once, and makes their own profile.</p>' +
        (urls.length ? '<div class="sg-addr"><div class="sg-qr" aria-hidden="true"></div><div><p class="dim small">The address</p><p class="sg-url">' + urls.map(function (u) { return '<a href="' + V.esc(u) + '">' + V.esc(u) + '</a>'; }).join('<br>') + '</p><p class="dim small">Scan it with a phone’s camera.</p></div></div>' :
          '<p class="note">' + V.icon('info') + ' <span>On other devices, open <b>' + V.esc(location.protocol + '//') + '<i>this computer’s address</i>:' + V.esc(location.port || (https ? '443' : '80')) + '</b>. The address is the one your router gave this computer: on Windows <code>ipconfig</code> shows it (“IPv4 Address”), on a Mac System Settings → Network, on Linux <code>hostname -I</code>. It usually starts with 192.168. or 10.</span></p>') +
        '<ul class="sg-tips"><li><b>A smart TV:</b> open the address in its web browser. It shows a code: scan it with a phone that’s signed in, and the TV is in, no typing.</li>' +
        '<li><b>A phone:</b> the browser can add it to the home screen, like an app (that needs https).</li>' +
        '<li><b>Away from home</b>, installing it as an app, casting to a Chromecast, copy-protected channels and saving downloads all need a secure (https) address. The simplest way is <a href="https://github.com/austin-72/superstation-iptv#away-from-home" target="_blank" rel="noopener noreferrer">Tailscale</a>' + (https ? ' — and this address already is https.' : ': free, and five minutes.') + '</li></ul>';
      var qr = V.$('.sg-qr', body);
      if (qr && urls[0]) V.api('/api/admin/qr?text=' + encodeURIComponent(urls[0])).then(function (j) { qr.innerHTML = j.svg; }).catch(function () { qr.remove(); });
    },
  };
})();
