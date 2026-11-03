/* "Open in another app": hand a channel, film or episode to VLC, MX Player, Just Player, Infuse, Outplayer… — for a
   format this browser struggles with, or simply a favourite player. The address is the provider's own when the app
   can open it as it is, otherwise a 12-hour link to this server (see lib/routes-p1.js). */
'use strict';
(function () {
  var ua = navigator.userAgent;
  var platform = function () {
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod|AppleTV|tvOS/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'apple';
    return 'desktop';
  };
  var intent = function (url, pkg, title) {
    var m = /^(https?):\/\/(.*)$/i.exec(url);
    if (!m) return '';
    return 'intent://' + m[2] + '#Intent;scheme=' + m[1].toLowerCase() + ';type=video/*;' + (pkg ? 'package=' + pkg + ';' : '') + 'S.title=' + encodeURIComponent(title || '') + ';end';
  };
  /** The apps to offer on this kind of device: { name, href, hint }. Exported for tests. */
  V.extApps = function (url, title, plat) {
    var e = encodeURIComponent(url);
    plat = plat || platform();
    if (plat === 'android') return [
      { name: 'VLC', href: intent(url, 'org.videolan.vlc', title) },
      { name: 'MX Player', href: intent(url, 'com.mxtech.videoplayer.ad', title) },
      { name: 'MX Player Pro', href: intent(url, 'com.mxtech.videoplayer.pro', title) },
      { name: 'Just Player', href: intent(url, 'com.brouken.player', title) },
      { name: 'Another app…', href: intent(url, '', title), hint: 'Android asks which app' },
    ];
    if (plat === 'apple') return [
      { name: 'Infuse', href: 'infuse://x-callback-url/play?url=' + e },
      { name: 'VLC', href: 'vlc-x-callback://x-callback-url/stream?url=' + e },
      { name: 'Outplayer', href: 'outplayer://' + url },
      { name: 'nPlayer', href: 'nplayer-' + url },
    ];
    return [{ name: 'VLC', href: 'vlc://' + url, hint: 'If nothing happens, use the playlist file below — VLC opens it' }];
  };
  /** A one-entry playlist file most players open. */
  var m3u = function (url, title) { return '#EXTM3U\n#EXTINF:-1,' + String(title || '').replace(/[\r\n]/g, ' ') + '\n' + url + '\n'; };

  var asking = false; // (a second press while the address is fetched would open the box twice)
  V.openInApp = function (it, opts) {
    opts = opts || {};
    if (!it || asking) return;
    asking = true;
    var title = it.t === 'episode' ? ((V.showOf(it) || {}).n || '') + ' ' + V.epLabel(it) : it.n;
    return V.api('/api/play/external', { body: { k: it.t === 'catchup' ? it.catchupOf : it.k, alt: Number.isInteger(opts.alt) ? opts.alt : -1 } }).then(function (r) {
      asking = false;
      var apps = V.extApps(r.url, title);
      var blob = URL.createObjectURL(new Blob([m3u(r.url, title)], { type: 'audio/x-mpegurl' }));
      var file = (title || 'stream').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'stream';
      V.dialog({
        title: 'Open in another app',
        cls: 'extapp-dlg',
        body: '<p class="dim">' + V.esc(title) + '</p><div class="ext-apps">' +
          apps.map(function (a, i) { return '<a class="btn block" data-app="' + i + '"' + (i ? '' : ' autofocus') + ' href="' + V.esc(a.href) + '">' + V.icon('openapp') + ' ' + V.esc(a.name) + (a.hint ? '<small class="dim">' + V.esc(a.hint) + '</small>' : '') + '</a>'; }).join('') +
          '<a class="btn block" data-m3u href="' + blob + '" download="' + V.esc(file) + '.m3u">' + V.icon('download') + ' Download playlist (.m3u)</a>' +
          '<button class="btn block" data-copy>' + V.icon('copy') + ' Copy the address</button></div>' +
          '<p class="dim small">' + (r.how === 'direct' ? 'The app plays it straight from the provider.' : 'The app plays it through this server. The link works for ' + (r.hours || 12) + ' hours.') + ' It uses one of the provider’s connections, like watching here.</p>',
        actions: [{ label: 'Close' }],
        onOpen: function (d) {
          d.addEventListener('click', function (e) {
            var a = e.target.closest('[data-app]');
            if (a) {
              // The other app takes over: stop here so the provider's connection is free for it.
              setTimeout(function () { if (V.watch && V.watch.it) V.closePlayer(); }, 400);
              V.toast('Opening ' + apps[+a.dataset.app].name + '…');
            }
            if (e.target.closest('[data-copy]')) {
              var done = function () { V.toast('Address copied'); };
              if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(r.url).then(done, function () { window.prompt('Copy this address', r.url); });
              else window.prompt('Copy this address', r.url);
            }
          });
        },
      }).then(function () { setTimeout(function () { URL.revokeObjectURL(blob); }, 60000); });
    }).catch(function (e) { asking = false; V.fail(e); });
  };

  // In the player's settings menu, and the options menus of channels, films and episodes.
  V.extPlayerMenu = function (p, main) {
    if (!p.it || p.it.t === 'catchup') return;
    main.push({ label: 'Open in another app', value: '', fn: function () { V.openInApp(p.it, { alt: p.alt }); } });
  };
})();
