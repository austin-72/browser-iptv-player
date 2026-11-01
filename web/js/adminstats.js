/* Admin → Statistics: how streams reached viewers — straight from the provider or through this server. */
'use strict';
(function () {
  // Three groups for the chart (fixed order = fixed colour), seven routes for the table.
  var GROUPS = [
    { id: 'direct', name: 'Straight from the provider', routes: ['direct', 'native', 'helper'] },
    { id: 'split', name: 'Video direct, playlist via server', routes: ['split'] },
    { id: 'server', name: 'Through this server', routes: ['relay', 'convert', 'local'] },
  ];
  var ROUTES = [
    ['direct', 'Direct', 'The browser played it straight from the provider', 'direct'],
    ['native', 'Direct · built-in player', 'The browser’s own player, straight from the provider (no permission needed)', 'direct'],
    ['helper', 'Direct · browser helper', 'Straight from the provider thanks to the direct-streams helper', 'direct'],
    ['split', 'Video direct · playlist via server', 'Only the small playlist text came through this server', 'split'],
    ['relay', 'Relayed through the server', 'The whole stream passed through this server', 'server'],
    ['convert', 'Converted on the server', 'ffmpeg repackaged or transcoded it', 'server'],
    ['local', 'Your own files', 'Videos from the server’s media folders', 'server'],
  ];
  var REASONS = {
    headers: 'The channel needs special headers (User-Agent, Referer, cookies) that browsers can’t send',
    https: 'A plain-http stream opened from an https address (browsers block that)',
    blocked: 'The provider blocks web players completely',
    'direct-failed': 'A direct route was tried but didn’t load',
    setting: 'Admin setting: always through this server',
    format: 'A format the browser can’t play, so it was converted',
    chosen: 'The viewer chose conversion or a lower quality',
    library: 'Your own files (always served by this server)',
    unknown: 'The server couldn’t check the provider',
  };
  var BYTES = [['relay', 'Relayed streams'], ['convert', 'Converted streams'], ['download', 'Downloads'], ['local', 'Your own files'], ['split', 'Playlists for “video direct”']];
  var GROUP_OF = {}; ROUTES.forEach(function (r) { GROUP_OF[r[0]] = r[3]; });

  var sum = function (o, keys) { return keys.reduce(function (a, k) { return a + ((o && o[k]) || 0); }, 0); };
  var pct = function (a, b) { return b ? Math.round(a / b * 100) + '%' : '–'; };
  var dur = function (s) {
    s = Math.round(s || 0);
    if (s < 60) return s ? s + ' s' : '0';
    var h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? h + ' h' + (m ? ' ' + m + ' min' : '') : m + ' min';
  };
  var hours = function (s) { var h = s / 3600; return h >= 10 ? Math.round(h) + ' h' : h >= 1 ? h.toFixed(1) + ' h' : Math.round(s / 60) + ' min'; };
  var size = function (b) {
    if (!b) return '0';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)) + ' ' + u[i];
  };
  var dayName = function (k, long) {
    var p = k.split('-'), d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.toLocaleDateString(undefined, long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
  };

  V.adminTabs.stats = function (body) {
    var days = +(V.ls.get('statsDays', 30)) || 30;
    var data = null, showTable = false;
    var draw = function () {
      var d = data;
      var secs = d.secs, plays = d.plays;
      var allSecs = sum(secs, Object.keys(secs)), allPlays = sum(plays, Object.keys(plays));
      var gSecs = GROUPS.map(function (g) { return sum(secs, g.routes); });
      var gPlays = GROUPS.map(function (g) { return sum(plays, g.routes); });
      var directShare = allSecs ? (gSecs[0] + gSecs[1]) / allSecs : allPlays ? (gPlays[0] + gPlays[1]) / allPlays : 0;
      var served = sum(d.bytes, Object.keys(d.bytes));
      var empty = !allPlays && !d.fails;

      var html = '<section class="card-sec"><div class="st-head"><h2>How streams reached viewers</h2><div class="chips" role="group" aria-label="Period">' +
        [[7, '7 days'], [30, '30 days'], [90, '90 days']].map(function (o) { return '<button class="chip' + (o[0] === days ? ' on' : '') + '" aria-pressed="' + (o[0] === days) + '" data-days="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div></div>';
      if (empty) {
        html += '<p class="dim">Nothing has been watched in this period yet. Statistics start counting from the moment this version is running' + (d.since ? ' (' + V.esc(new Date(d.since).toLocaleDateString()) + ')' : '') + '.</p></section>';
        body.innerHTML = html; return;
      }
      html += '<div class="stats st-tiles">' +
        '<div class="stat st-hero"><b class="num">' + Math.round(directShare * 100) + '%</b><span>watched straight from the provider</span></div>' +
        '<div class="stat"><b class="num">' + hours(allSecs) + '</b><span>watched, ' + hours(gSecs[2]) + ' through this server</span></div>' +
        '<div class="stat"><b class="num">' + size(served) + '</b><span>sent by this server</span></div>' +
        '<div class="stat"><b class="num">' + allPlays.toLocaleString() + '</b><span>plays' + (d.fails ? ', ' + d.fails + ' couldn’t play' : '') + '</span></div></div>';
      html += '<div class="st-legend" aria-hidden="true">' + GROUPS.map(function (g, i) { return '<span><i class="sw s' + (i + 1) + '"></i>' + V.esc(g.name) + '</span>'; }).join('') + '</div>' +
        '<div class="st-chart" role="img" aria-label="Hours watched per day, by how the stream reached the viewer. The same numbers are in the table view."></div>' +
        '<div class="st-tip" hidden></div>' +
        '<button class="btn sm st-tbl-btn" aria-expanded="' + showTable + '">' + (showTable ? 'Hide' : 'Show') + ' the numbers per day</button>' +
        (showTable ? dayTable(d) : '') + '</section>';

      // Routes
      html += '<section class="card-sec"><h2>Routes</h2><div class="tbl-wrap"><table class="st-table"><thead><tr><th>Route</th><th class="r">Plays</th><th class="r">Watch time</th><th class="r">Share</th></tr></thead><tbody>' +
        ROUTES.filter(function (r) { return plays[r[0]] || secs[r[0]]; }).map(function (r) {
          var gi = GROUPS.map(function (g) { return g.id; }).indexOf(r[3]) + 1;
          return '<tr><td><i class="sw s' + gi + '"></i><b>' + V.esc(r[1]) + '</b><br><small class="dim">' + V.esc(r[2]) + '</small></td><td class="r num">' + (plays[r[0]] || 0).toLocaleString() + '</td><td class="r num">' + dur(secs[r[0]]) + '</td><td class="r num">' + pct(secs[r[0]] || 0, allSecs) + '</td></tr>';
        }).join('') + '</tbody></table></div></section>';

      // Why through the server
      var reasons = Object.keys(d.reasons).sort(function (a, b) { return d.reasons[b] - d.reasons[a]; });
      if (reasons.length) {
        html += '<section class="card-sec"><h2>Why streams went through this server</h2><div class="tbl-wrap"><table class="st-table"><thead><tr><th>Reason</th><th class="r">Plays</th></tr></thead><tbody>' +
          reasons.map(function (k) { return '<tr><td>' + V.esc(REASONS[k] || k) + '</td><td class="r num">' + d.reasons[k].toLocaleString() + '</td></tr>'; }).join('') + '</tbody></table></div>' +
          (d.reasons.blocked || d.reasons['direct-failed'] ? '<p class="dim small">Viewers on a computer can make these direct with the direct-streams helper (Settings → Direct streaming).</p>' : '') +
          (d.reasons.https ? '<p class="dim small">Opening the site by its home address (<code>http://</code> + this computer’s IP) at home lets these go direct.</p>' : '') + '</section>';
      }

      // Data
      html += '<section class="card-sec"><h2>Data sent by this server</h2><div class="tbl-wrap"><table class="st-table"><thead><tr><th>What</th><th class="r">Data</th><th class="r">Share</th></tr></thead><tbody>' +
        BYTES.filter(function (b) { return d.bytes[b[0]]; }).map(function (b) { return '<tr><td>' + V.esc(b[1]) + '</td><td class="r num">' + size(d.bytes[b[0]]) + '</td><td class="r num">' + pct(d.bytes[b[0]], served) + '</td></tr>'; }).join('') +
        '<tr class="tot"><td>Total</td><td class="r num">' + size(served) + '</td><td></td></tr></tbody></table></div><p class="dim small">Video that went straight from the provider never touches this server, so it isn’t counted here.</p></section>';

      // Breakdowns
      var breakdown = function (title, rows, first, note) {
        if (!rows.length) return '';
        return '<section class="card-sec"><h2>' + title + '</h2><div class="tbl-wrap"><table class="st-table"><thead><tr><th>' + first + '</th><th class="r hide-sm">Plays</th><th class="r">Watch time</th><th class="r">Direct</th></tr></thead><tbody>' +
          rows.map(function (r) {
            var share = r.secs ? r.dsecs / r.secs : r.plays ? r.direct / r.plays : 0;
            return '<tr><td class="truncate">' + V.esc(r.name) + '</td><td class="r num hide-sm">' + r.plays.toLocaleString() + '</td><td class="r num">' + dur(r.secs) + '</td><td class="r num"><span class="st-bar" aria-hidden="true"><i style="width:' + Math.round(share * 100) + '%"></i></span>' + Math.round(share * 100) + '%</td></tr>';
          }).join('') + '</tbody></table></div>' + (note ? '<p class="dim small">' + note + '</p>' : '') + '</section>';
      };
      html += breakdown('By address people used', d.places, 'Address', '“Direct” counts “video direct” too. People using an https address can’t get plain-http streams directly.');
      html += breakdown('By provider', d.hosts, 'Provider');
      html += breakdown('By profile', d.profiles, 'Profile');
      html += '<section class="card-sec"><h2>Reset</h2><p class="dim">Counting since ' + V.esc(new Date(d.since).toLocaleString()) + '. Statistics are kept for 120 days.</p><button class="btn danger" data-reset>Reset statistics</button></section>';
      body.innerHTML = html;
      chart(V.$('.st-chart', body), V.$('.st-tip', body), d.series);
    };

    var dayTable = function (d) {
      return '<div class="tbl-wrap st-days"><table class="st-table"><thead><tr><th>Day</th>' + GROUPS.map(function (g) { return '<th class="r">' + V.esc(g.name) + '</th>'; }).join('') + '<th class="r">Plays</th><th class="r">Server data</th></tr></thead><tbody>' +
        d.series.slice().reverse().map(function (s) {
          return '<tr><td>' + V.esc(dayName(s.day, true)) + '</td>' + GROUPS.map(function (g) { return '<td class="r num">' + dur(sum(s.secs, g.routes)) + '</td>'; }).join('') + '<td class="r num">' + sum(s.plays, Object.keys(s.plays)) + '</td><td class="r num">' + size(s.bytes) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    };

    var load = function () {
      body.innerHTML = '<div class="center pad"><span class="spinner"></span></div>';
      V.api('/api/admin/stats?days=' + days).then(function (d) { data = d; draw(); }).catch(function (e) { body.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
    };

    body.onclick = function (e) {
      var b = e.target.closest('[data-days]');
      if (b) { days = +b.dataset.days; V.ls.set('statsDays', days); load(); return; }
      if (e.target.closest('.st-tbl-btn')) { showTable = !showTable; draw(); return; }
      if (e.target.closest('[data-reset]')) {
        V.confirm('Reset all playback statistics? This can’t be undone.', { ok: 'Reset', danger: true }).then(function (ok) {
          if (ok) V.del('/api/admin/stats').then(function () { V.toast('Statistics reset'); load(); }).catch(V.fail);
        });
      }
    };
    var rt;
    var onResize = function () { if (!body.isConnected) { window.removeEventListener('resize', onResize); return; } clearTimeout(rt); rt = setTimeout(function () { if (data) chart(V.$('.st-chart', body), V.$('.st-tip', body), data.series); }, 150); };
    window.addEventListener('resize', onResize);
    load();
  };

  /** Stacked bars: hours per day in the three groups. Hover (or tap) a day for its numbers. */
  function chart(el, tip, series) {
    if (!el) return;
    var W = Math.max(280, el.clientWidth), H = 200, padL = 36, padR = 8, padT = 10, padB = 24;
    var vals = series.map(function (s) { return GROUPS.map(function (g) { return sum(s.secs, g.routes) / 3600; }); });
    var max = Math.max.apply(null, vals.map(function (v) { return v[0] + v[1] + v[2]; }).concat([0]));
    // A tidy top for the axis: 1, 2, 5 × 10^n.
    var top = 1;
    if (max > 0) { var p = Math.pow(10, Math.floor(Math.log10(max))); top = [1, 2, 2.5, 5, 10].map(function (m) { return m * p; }).filter(function (v) { return v >= max; })[0]; }
    if (max < 1) top = max > 0.5 ? 1 : max > 0.25 ? 0.5 : 0.25;
    var n = series.length, iw = W - padL - padR, ih = H - padT - padB;
    var slot = iw / n, gap = Math.min(4, Math.max(1, slot * 0.25)), bw = Math.max(1, slot - gap);
    var y = function (v) { return padT + ih - v / top * ih; };
    var svg = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">';
    // Gridlines and y labels (hours)
    for (var gi = 0; gi <= 4; gi++) {
      var gv = top * gi / 4, gy = y(gv);
      svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + gy + '" y2="' + gy + '" class="st-grid' + (gi === 0 ? ' base' : '') + '"/>';
      svg += '<text x="' + (padL - 6) + '" y="' + (gy + 4) + '" text-anchor="end" class="st-ax">' + (gv === 0 ? '0' : (gv < 1 ? Math.round(gv * 60) + 'm' : (Math.round(gv * 10) / 10) + 'h')) + '</text>';
    }
    // Bars: segments bottom→top in group order, 2px surface gap between segments, rounded top end.
    vals.forEach(function (v, i) {
      var x = padL + i * slot + gap / 2, base = 0, segs = [];
      v.forEach(function (h, k) { if (h > 0) segs.push({ k: k, a: base, b: base + h }); base += h; });
      segs.forEach(function (s, j) {
        var y1 = y(s.b), y0 = y(s.a), hgt = y0 - y1 - (j > 0 ? (bw >= 6 ? 2 : 1) : 0);
        if (hgt <= 0.3) hgt = 0.6;
        var last = j === segs.length - 1, r = last ? Math.min(4, bw / 2, hgt) : 0;
        if (r > 0) svg += '<path class="s' + (s.k + 1) + '" d="M' + x + ',' + (y1 + hgt) + 'V' + (y1 + r) + 'Q' + x + ',' + y1 + ' ' + (x + r) + ',' + y1 + 'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + y1 + ' ' + (x + bw) + ',' + (y1 + r) + 'V' + (y1 + hgt) + 'Z"/>';
        else svg += '<rect class="s' + (s.k + 1) + '" x="' + x + '" y="' + y1 + '" width="' + bw + '" height="' + hgt + '"/>';
      });
      svg += '<rect class="st-hit" data-i="' + i + '" x="' + (padL + i * slot) + '" y="' + padT + '" width="' + slot + '" height="' + ih + '"/>';
    });
    // A few date labels.
    var every = Math.ceil(n / Math.max(2, Math.floor(iw / 70)));
    series.forEach(function (s, i) {
      if (i % every && i !== n - 1) return;
      if (i !== n - 1 && n - 1 - i < every * 0.8) return;
      var lastOne = i === n - 1, firstOne = i === 0;
      svg += '<text x="' + (lastOne ? W - padR : firstOne ? padL : padL + i * slot + slot / 2) + '" y="' + (H - 6) + '" text-anchor="' + (lastOne ? 'end' : firstOne ? 'start' : 'middle') + '" class="st-ax">' + V.esc(dayName(s.day)) + '</text>';
    });
    svg += '<line class="st-cross" x1="0" x2="0" y1="' + padT + '" y2="' + (padT + ih) + '" visibility="hidden"/></svg>';
    el.innerHTML = svg;
    var cross = el.querySelector('.st-cross');
    var show = function (i, evX) {
      var s = series[i], v = vals[i];
      var tot = v[0] + v[1] + v[2];
      tip.innerHTML = '<b>' + V.esc(dayName(s.day, true)) + '</b>' + GROUPS.map(function (g, k) { return '<div><i class="sw s' + (k + 1) + '"></i><span>' + V.esc(g.name) + '</span><b class="num">' + dur(v[k] * 3600) + '</b></div>'; }).join('') +
        '<div class="tot"><span>Total</span><b class="num">' + dur(tot * 3600) + '</b></div>' + (s.bytes ? '<div class="tot"><span>Sent by this server</span><b class="num">' + size(s.bytes) + '</b></div>' : '');
      tip.hidden = false;
      var cx = padL + i * slot + slot / 2;
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      var box = el.getBoundingClientRect(), host = el.parentNode.getBoundingClientRect();
      var tw = tip.offsetWidth, left = box.left - host.left + cx + 12;
      if (left + tw > host.width - 4) left = box.left - host.left + cx - tw - 12;
      tip.style.left = Math.max(4, left) + 'px';
      tip.style.top = (box.top - host.top + 8) + 'px';
    };
    var hide = function () { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
    el.onmousemove = function (e) { var t = e.target.closest('.st-hit'); if (t) show(+t.dataset.i); else hide(); };
    el.onmouseleave = hide;
    el.onclick = function (e) { var t = e.target.closest('.st-hit'); if (t) show(+t.dataset.i); };
  }
})();
