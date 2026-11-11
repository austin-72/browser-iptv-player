/* Admin → Statistics → Watching at once: how many streams each provider (list) served at the same time, its busiest
   moments, and how often the household ran into the account's connection limit. Data: /api/admin/stats/concurrency
   (lib/concurrency.js, one sample a minute). */
'use strict';
(function () {
  var cache = { days: 0, at: 0, data: null };
  var pick = V.ls.get('concPick', '') || '';
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var esc = function (s) { return V.esc(s); };
  var hm = function (t) { return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
  var when = function (t) { return new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  var hourName = function (h) { return new Date(2020, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' }); };
  // (No-break spaces keep "27 min" together when a narrow table wraps it.)
  var dur = function (m) { m = Math.round(m || 0); if (m < 60) return m + ' min'; var h = Math.floor(m / 60), r = m % 60; return h + ' h' + (r ? ' ' + r + ' min' : ''); };
  var avg = function (x) { return x >= 10 ? Math.round(x) : Math.round(x * 10) / 10; };

  V.statsConc = function (box, days) {
    if (!box) return;
    var fresh = cache.data && cache.days === days && Date.now() - cache.at < 60000;
    if (fresh) return draw(box, cache.data);
    box.innerHTML = '<section class="card-sec"><h2>Watching at once</h2><div class="center pad"><span class="spinner"></span></div></section>';
    V.api('/api/admin/stats/concurrency?days=' + days + '&tz=' + new Date().getTimezoneOffset()).then(function (d) {
      cache = { days: days, at: Date.now(), data: d };
      if (document.documentElement.contains(box)) draw(box, d);
    }).catch(function (e) {
      // (An older server without this: leave the section out.)
      box.innerHTML = e.status === 404 ? '' : '<section class="card-sec"><h2>Watching at once</h2><p class="err">' + esc(e.message) + '</p></section>';
    });
  };

  function draw(box, d) {
    var ps = d.providers.filter(function (p) { return p.mins || p.now || !p.gone; });
    if (!ps.length) { box.innerHTML = ''; return; }
    var cur = ps.filter(function (p) { return p.id === pick; })[0] || ps[0];
    var anyData = ps.some(function (p) { return p.mins; });
    var html = '<section class="card-sec cc"><div class="st-head"><h2>Watching at once</h2></div>' +
      '<p class="dim">Streams each provider served at the same time, counted every minute (each device and multiview tile, a watch party once, recordings too). Compare it with each account’s connection limit to see when you’re running out.</p>';
    if (!anyData) html += '<p class="dim">Counting started ' + esc(new Date(d.since).toLocaleString()) + ' — check back after people have watched for a while.</p>';
    // The table: every provider.
    html += '<div class="tbl-wrap" tabindex="0" role="group" aria-label="Table (scrolls sideways when it doesn’t fit)"><table class="st-table cc-table"><thead><tr><th>Provider</th><th class="r">Now</th><th class="r hide-sm">Limit</th><th class="r">Busiest</th><th class="r hide-sm">On average</th><th class="r">At the limit</th><th class="r">Turned away</th></tr></thead><tbody>' +
      ps.map(function (p) {
        var full = p.limit && p.fullMins;
        var pctFull = p.mins ? p.fullMins / p.mins : 0;
        var bar = p.limit ? '<span class="cc-bar" aria-hidden="true"><i style="width:' + Math.min(100, p.peak / p.limit * 100) + '%"' + (p.peak >= p.limit ? ' class="full"' : '') + '></i></span>' : '';
        return '<tr class="' + (p.id === cur.id ? 'on' : '') + '" data-p="' + esc(p.id) + '"><td class="truncate"><button class="linkish" data-p="' + esc(p.id) + '">' + esc(p.name) + '</button>' + (p.gone ? ' <small class="dim">(removed)</small>' : '') + '</td>' +
          '<td class="r num">' + p.now + '</td>' +
          '<td class="r num hide-sm">' + (p.limit || '<span class="dim" title="Not known: run the connection test on the list (Admin → Lists)">?</span>') + '</td>' +
          '<td class="r num">' + p.peak + (p.limit ? ' of ' + p.limit : '') + bar + (p.peakAt ? '<br><small class="dim">' + esc(when(p.peakAt).replace(/:\d\d/, '')) + '</small>' : '') + '</td>' +
          '<td class="r num hide-sm">' + avg(p.avg) + '</td>' +
          '<td class="r num' + (full ? ' warn' : '') + '">' + (p.limit ? (full ? dur(p.fullMins) + '<br><small class="dim">' + Math.max(1, Math.round(pctFull * 100)) + '% of the time</small>' : 'Never') : '–') + '</td>' +
          '<td class="r num' + (p.away ? ' warn' : '') + '">' + (p.away || 0) + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="dim small">“At the limit”: every connection the account allows was in use. “Turned away”: someone pressed play and every copy was busy. Pick a provider to see when.</p>';
    // The stream relay: the times it couldn't keep up with the films being watched (relay 5).
    if (d.strain && d.strain.length) {
      var mbit = function (b) { return b > 0 ? (Math.round(b * 8 / 1e5) / 10) + ' Mbit/s' : '?'; };
      html += '<h3>When the stream relay couldn’t keep up</h3><div class="tbl-wrap" tabindex="0" role="group" aria-label="Table (scrolls sideways when it doesn’t fit)"><table class="st-table cc-strain"><thead><tr><th>When</th><th>Provider</th><th class="r">Watching</th><th class="r">Connections</th><th class="r hide-sm">Least ready</th><th class="r hide-sm">Needed / got</th></tr></thead><tbody>' +
        d.strain.map(function (e) {
          return '<tr><td>' + esc(when(e.t)) + '</td><td class="truncate">' + esc(e.name) + '</td><td class="r num">' + e.viewers + (e.stalled ? '<br><small class="dim">' + e.stalled + ' waiting to start</small>' : '') + '</td>' +
            '<td class="r num">' + e.runs + (e.budget ? ' of ' + e.budget : '') + '</td><td class="r num hide-sm">' + (e.least >= 0 ? (e.least < 60 ? e.least + ' s' : Math.round(e.least / 60) + ' min') : '–') + '</td>' +
            '<td class="r num hide-sm">' + (e.need > 0 ? mbit(e.need) + ' / ' + mbit(e.rate) : '–') + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<p class="dim small">The relay shares each provider account’s connections between the films being watched, aiming to have 10 minutes ready for everyone. These are the times it couldn’t: more was being watched at once than the provider sends (“Needed / got”), or someone waited to start because every connection was busy. More connections on the account (or fewer films at once) helps.</p>';
    }
    // The chart and the week grid for one provider.
    html += '<div class="cc-one"><h3>' + esc(cur.name) + '</h3>' +
      '<div class="st-legend" aria-hidden="true"><span><i class="sw s1"></i>Most at once</span><span><i class="sw cc-full"></i>At the limit</span>' + (cur.limit ? '<span><i class="cc-lim-key"></i>Limit (' + cur.limit + ')</span>' : '') + '<span><i class="cc-avg-key"></i>On average</span></div>' +
      '<div class="cc-chart" role="img" aria-label="Streams at once from ' + esc(cur.name) + ' over the period: the most at once in each ' + (d.days > 14 ? 'day' : 'hour') + ', the average, and the limit."></div><div class="st-tip cc-tip" hidden></div>' +
      grid(cur) + '</div></section>';
    box.innerHTML = html;
    chart(V.$('.cc-chart', box), V.$('.cc-tip', box), cur, d);
    box.onclick = function (e) {
      var b = e.target.closest('[data-p]');
      if (!b) return;
      pick = b.getAttribute('data-p'); V.ls.set('concPick', pick);
      draw(box, d);
      // (Keep focus on the provider just picked: the redraw replaced its button.)
      var again = V.$$('button[data-p]', box).filter(function (x) { return x.getAttribute('data-p') === pick; })[0];
      if (again) try { again.focus({ preventScroll: true }); } catch (err) {}
    };
    if (!box._resize) {
      box._resize = true;
      var rt;
      var onResize = function () { if (!document.documentElement.contains(box)) { window.removeEventListener('resize', onResize); return; } clearTimeout(rt); rt = setTimeout(function () { if (cache.data) draw(box, cache.data); }, 150); };
      window.addEventListener('resize', onResize);
    }
  }

  /** The week: for each weekday and hour, the most streams at once (darker = closer to the limit). */
  function grid(p) {
    var top = p.limit || Math.max(1, p.peak);
    var cells = '';
    for (var dd = 1; dd <= 7; dd++) {
      var day = dd % 7; // (Monday first)
      cells += '<div class="cc-gd">' + DAYS[day] + '</div>';
      for (var h = 0; h < 24; h++) {
        var g = p.grid[day][h], peak = g[0], av = g[1], full = g[2];
        var a = peak ? 0.18 + 0.82 * Math.min(1, peak / top) : 0;
        var tip = DAYS[day] + ' ' + hourName(h) + ': ' + (peak ? 'up to ' + peak + ' at once, ' + avg(av) + ' on average' + (full ? ', at the limit for ' + dur(full) : '') : 'nobody');
        cells += '<div class="cc-c' + (full ? ' full' : '') + '" style="' + (peak ? '--a:' + a.toFixed(2) : '') + '" title="' + esc(tip) + '" role="img" aria-label="' + esc(tip) + '"></div>';
      }
    }
    var hours = '<div></div>';
    for (var hh = 0; hh < 24; hh++) hours += '<div class="cc-gh">' + (hh % 6 === 0 ? esc(hourName(hh)) : '') + '</div>';
    return '<h4 class="cc-sub">When it’s busiest <span class="dim">(your time; outlined: at the limit)</span></h4><div class="tbl-wrap" tabindex="0" role="group" aria-label="Table (scrolls sideways when it doesn’t fit)"><div class="cc-grid">' + hours + cells + '</div></div>';
  }

  /** Bars: the most at once per hour (or per day for long periods); a line for the average; the limit dashed. */
  function chart(el, tip, p, d) {
    if (!el) return;
    var HOUR = 3600e3, byDay = d.days > 14;
    var step = byDay ? 86400e3 : HOUR;
    // Slots across the whole period (empty ones too), local days for the daily view.
    var start;
    if (byDay) { var s0 = new Date(d.now - (d.days - 1) * 86400e3); s0.setHours(0, 0, 0, 0); start = s0.getTime(); }
    else start = Math.floor((d.now - d.days * 86400e3) / HOUR) * HOUR + HOUR;
    var slots = [], idx = {};
    for (var t = start; t <= d.now; t += step) { idx[t] = slots.length; slots.push({ t: t, peak: 0, sum: 0, n: 0, full: 0, away: 0 }); }
    p.hours.forEach(function (e) {
      var key = byDay ? (function () { var x = new Date(e.t); x.setHours(0, 0, 0, 0); return x.getTime(); })() : e.t;
      var s = slots[idx[key]];
      if (!s) return;
      s.peak = Math.max(s.peak, e.peak); s.sum += e.avg; s.n++; s.full += e.full; s.away += e.away;
    });
    slots.forEach(function (s) { s.avg = byDay ? s.sum / 24 : s.sum; });
    var W = Math.max(280, el.clientWidth), H = 190, padL = 30, padR = 8, padT = 12, padB = 24;
    var max = Math.max(p.limit || 0, Math.max.apply(null, slots.map(function (s) { return s.peak; }).concat([1])));
    var top = Math.max(1, Math.ceil(max));
    var n = slots.length, iw = W - padL - padR, ih = H - padT - padB;
    var slot = iw / n, gap = slot >= 6 ? 2 : slot >= 3 ? 1 : 0, bw = Math.max(1, slot - gap);
    var y = function (v) { return padT + ih - v / top * ih; };
    var svg = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">';
    var ticks = top <= 6 ? top : 4;
    for (var gi = 0; gi <= ticks; gi++) {
      var gv = Math.round(top * gi / ticks), gy = y(gv);
      svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + gy + '" y2="' + gy + '" class="st-grid' + (gi === 0 ? ' base' : '') + '"/><text x="' + (padL - 6) + '" y="' + (gy + 4) + '" text-anchor="end" class="st-ax">' + gv + '</text>';
    }
    slots.forEach(function (s, i) {
      if (!s.peak) return;
      var x = padL + i * slot + gap / 2, y1 = y(s.peak), hgt = Math.max(1, y(0) - y1), r = Math.min(4, bw / 2, hgt);
      var cls = p.limit && s.peak >= p.limit ? 'cc-full' : 's1';
      svg += r >= 1 ? '<path class="' + cls + '" d="M' + x + ',' + (y1 + hgt) + 'V' + (y1 + r) + 'Q' + x + ',' + y1 + ' ' + (x + r) + ',' + y1 + 'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + y1 + ' ' + (x + bw) + ',' + (y1 + r) + 'V' + (y1 + hgt) + 'Z"/>'
        : '<rect class="' + cls + '" x="' + x + '" y="' + y1 + '" width="' + bw + '" height="' + hgt + '"/>';
    });
    // Average line.
    var pts = slots.map(function (s, i) { return (padL + i * slot + slot / 2).toFixed(1) + ',' + y(s.avg).toFixed(1); });
    svg += '<polyline class="cc-avg" points="' + pts.join(' ') + '"/>';
    if (p.limit) svg += '<line class="cc-lim" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(p.limit) + '" y2="' + y(p.limit) + '"/><text class="cc-lim-t" x="' + (W - padR - 2) + '" y="' + (y(p.limit) - 4) + '" text-anchor="end">limit ' + p.limit + '</text>';
    // Labels: days.
    var lab = function (t) { return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
    var every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 70))));
    if (!byDay) every = Math.max(24, Math.ceil(every / 24) * 24);
    var mid = -1;
    slots.forEach(function (s, i) {
      var dt = new Date(s.t);
      if (!byDay) { if (dt.getHours() !== 0) return; mid++; if (mid % (every / 24)) return; } else if (i % every) return;
      var x = padL + i * slot + (byDay ? slot / 2 : 0);
      if (x > W - 40) return;
      svg += '<text x="' + x + '" y="' + (H - 6) + '" text-anchor="' + (byDay ? 'middle' : 'start') + '" class="st-ax">' + esc(lab(s.t)) + '</text>';
    });
    svg += '<rect class="st-hit" x="' + padL + '" y="' + padT + '" width="' + iw + '" height="' + ih + '"/><line class="st-cross" x1="0" x2="0" y1="' + padT + '" y2="' + (padT + ih) + '" visibility="hidden"/></svg>';
    el.innerHTML = svg;
    var cross = el.querySelector('.st-cross');
    var show = function (i) {
      var s = slots[i];
      if (!s) return;
      var label = byDay ? new Date(s.t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : when(s.t).replace(/:\d\d/, '') + '–' + hm(s.t + HOUR).replace(/:\d\d/, '');
      tip.innerHTML = '<b>' + esc(label) + '</b><div><span>Most at once</span><b class="num">' + s.peak + (p.limit ? ' of ' + p.limit : '') + '</b></div><div><span>On average</span><b class="num">' + avg(s.avg) + '</b></div>' +
        (s.full ? '<div><span>At the limit</span><b class="num">' + dur(s.full) + '</b></div>' : '') + (s.away ? '<div><span>Turned away</span><b class="num">' + s.away + '</b></div>' : '');
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
    var at = function (e) { var r = el.getBoundingClientRect(); return Math.floor((e.clientX - r.left - padL) / slot); };
    el.onmousemove = function (e) { var i = at(e); if (i >= 0 && i < n) show(i); else hide(); };
    el.onmouseleave = hide;
    el.onclick = function (e) { var i = at(e); if (i >= 0 && i < n) show(i); };
  }
})();
