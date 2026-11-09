/* Downloads for watching offline. On https (or the server's own computer) videos are kept inside the app;
   otherwise they're saved as an MP4 file. In the original quality they come straight from the provider when it lets
   web pages read its files: as they are when the browser plays them, or turned into an MP4 in the browser (MKV,
   MPEG-TS, Dolby sound). Otherwise — or for a smaller copy — the server fetches and converts them. */
'use strict';
V.downloads = (function () {
  var queue = [];
  var active = null;
  var items = new Map(); // k -> record
  var canStore = function () { return window.isSecureContext && navigator.storage && navigator.storage.getDirectory && window.FileSystemFileHandle && 'createWritable' in FileSystemFileHandle.prototype; };
  var fileName = function (k) { return 'dl-' + k.replace(/[^\w-]/g, '_'); };
  /** The provider's own address for a download straight from it ('' when it can't be: special headers, http on https…). */
  var directUrl = function (it) {
    var u = it.u || '';
    if (!/^https?:/i.test(u) || (it.h && Object.keys(it.h).length) || S.settings.routing === 'server') return '';
    if (V.relayOn && V.relayOn()) return ''; // (streams go through the stream relay: downloads come through the server instead)
    if (location.protocol === 'https:' && /^http:/i.test(u) && !(V._mixedHosts && V._mixedHosts[(/^http:\/\/([^/?#]+)/i.exec(u) || [])[1]])) return '';
    var g = V.guessKind(u, it);
    return g === 'native' || (V.mbSupported() && (g === 'ffmpeg' || g === 'ts' || g === 'unknown')) ? u : '';
  };

  /**
   * Copies a film or episode from the provider into `w` (a file being written): as it is when it's a file browsers
   * play, else converted to MP4 in this browser. r gets bytes/size (or a 0–1000 progress) as it goes.
   */
  function directTo(url, w, r, ac) {
    var g = V.guessKind(url, {});
    if (g === 'native') {
      return fetch(url, { signal: ac.signal, credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var ct = res.headers.get('Content-Type') || '';
        if (/text\/|json|mpegurl/i.test(ct)) throw new Error('not a video file');
        r.size = Number(res.headers.get('Content-Length')) || 0;
        r.type = /^(video|audio)\//.test(ct) ? ct : 'video/mp4';
        var reader = res.body.getReader(), last = 0;
        var copy = function () {
          return reader.read().then(function (chunk) {
            if (chunk.done) return;
            return w.write(chunk.value).then(function () {
              r.bytes += chunk.value.length;
              if (Date.now() - last > 700) { last = Date.now(); save(r); }
              return copy();
            });
          });
        };
        return copy();
      });
    }
    return V.mbLoad().then(function (M) {
      var input = new M.Input({ source: new M.UrlSource(url, { getRetryDelay: function (n, err) { return n < 2 && !(err instanceof TypeError) ? 2 : null; } }), formats: M.ALL_FORMATS });
      return input.getPrimaryAudioTrack().then(function (at) {
        return Promise.all([at ? at.getCodecParameterString() : null, M.getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: 48000 })]);
      }).then(function (c) {
        var ap = c[0], enc = c[1];
        var keep = ap && /^(mp4a|opus|mp3|flac|fLaC)/.test(ap);
        var out = new WritableStream({ write: function (chunk) { return w.write({ type: 'write', position: chunk.position, data: chunk.data }); } });
        var output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: false }), target: new M.StreamTarget(out, { chunked: true }) });
        return M.Conversion.init({ input: input, output: output, tracks: 'primary', audio: keep || !enc ? {} : { codec: enc, numberOfChannels: 2 }, showWarnings: false });
      }).then(function (conv) {
        if (!conv.isValid || (conv.discardedTracks || []).some(function (d) { return d.track && d.track.type === 'audio'; })) throw new Error('can’t be converted in the browser');
        r.type = 'video/mp4'; r.size = 0; r.progress = 0;
        var last = 0;
        conv.onProgress = function (p) { r.progress = p; if (Date.now() - last > 700) { last = Date.now(); save(r); } };
        ac.signal.addEventListener('abort', function () { conv.cancel().catch(function () {}); });
        return conv.execute();
      }).then(function () { if (input.dispose) input.dispose(); }, function (e) { if (input.dispose) input.dispose(); throw e; });
    });
  }

  /** The device has no room left (not something the provider or the server did). */
  var full = function (e) { return !!e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || '')); };
  var FULL_MSG = 'There’s no room left on this device. Delete some downloads and try again.';

  function load() {
    return V.idb.all('dl').then(function (list) {
      items.clear();
      // An interrupted download starts over; waiting ones go back in the queue (they'd otherwise wait forever).
      // (It runs again on a profile switch: the one downloading now keeps going, and nothing is queued twice.)
      (list || []).forEach(function (r) {
        if (active && active.r.k === r.k) { items.set(r.k, active.r); return; }
        if (r.status === 'downloading') r.status = 'failed';
        items.set(r.k, r);
        if (r.status === 'queued') {
          var i = queue.map(function (x) { return x.k; }).indexOf(r.k);
          if (i >= 0) queue[i] = r; else queue.push(r);
        }
      });
      V.emit('downloads');
      if (queue.length && S.profile && S.profile.id) pump();
    });
  }
  function save(r) { items.set(r.k, r); V.idb.set(r.k, r, 'dl'); V.emit('downloads'); }

  function start(it, opts) {
    opts = opts || {};
    if (!S.settings.allowDownloads && !S.profile.admin) return V.toast('Downloads are turned off on this server.', { error: true });
    if (it.t === 'live' || it.t === 'show') return V.toast('Only movies, episodes and audio can be downloaded.', { error: true });
    if (opts.quality === undefined) return chooser(it);
    var url = '/api/download/' + encodeURIComponent(it.k) + (opts.quality ? '?height=' + opts.quality : '');
    var du = opts.quality ? '' : directUrl(it);
    // Saving it as a file, in the original quality, in Chrome/Edge: straight from the provider into the file.
    if ((!canStore() || opts.asFile) && du && window.showSaveFilePicker && !opts.quiet) {
      var name = String(it.n || 'video').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120) + '.mp4';
      var rr = { k: it.k, n: it.n, bytes: 0, size: 0 }, ac0 = new AbortController();
      window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Video', accept: { 'video/mp4': ['.mp4'] } }] }).then(function (fh) {
        return fh.createWritable().then(function (w) {
          V.toast('Downloading straight from the provider…');
          return directTo(du, w, rr, ac0).then(function () { return w.close(); }, function (e) { return w.abort().catch(function () {}).then(function () { throw e; }); });
        });
      }).then(function () { V.toast('Saved: ' + it.n); }, function (e) {
        if (e && e.name === 'AbortError') return; // (the viewer closed the save window)
        V.toast('The provider doesn’t allow that from a web page — the server will fetch it instead.');
        var a0 = document.createElement('a'); a0.href = url; a0.download = ''; document.body.appendChild(a0); a0.click(); a0.remove();
      });
      return;
    }
    if (!canStore() || opts.asFile) {
      var a = document.createElement('a');
      a.href = url; a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
      if (!opts.quiet) V.toast('Download started — the server converts it to MP4 if needed.');
      return;
    }
    var show = V.showOf(it);
    var r = { k: it.k, n: it.n, t: it.t, i: it.i || (show || {}).i || '', sk: it.sk || '', show: show ? show.n : '', s: it.s, e: it.e, et: it.et, d: it.d || 0, pid: S.profile.id, status: 'queued', bytes: 0, size: 0, at: Date.now(), quality: opts.quality || 0, u: du };
    save(r);
    queue.push(r);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    if (!opts.quiet) V.toast('Added to Downloads', { action: { label: 'View', fn: function () { V.router.go('#/downloads'); } } });
    pump();
  }

  /**
   * Several episodes at once — a season, the whole series, the ones not watched yet — with one choice of quality.
   * Ones already downloaded (or on their way) are left out. Kept in the app, they download one after another in
   * Downloads; as files, the browser saves them one by one (it may ask once whether this site may save several).
   */
  function startMany(eps, opts) {
    var have = function (k) { var r = items.get(k); return r && r.status !== 'failed' && r.status !== 'cancelled'; };
    var todo = eps.filter(function (e) { return e && e.k && !have(e.k); });
    if (!todo.length) return V.toast('Those are all downloaded already.');
    if (opts.asFile) {
      V.toast('Saving ' + V.plural(todo.length, 'episode') + ' as files. Your browser may ask whether this site may save several.', { ms: 6000 });
      todo.forEach(function (e, i) { setTimeout(function () { start(e, { quality: opts.quality, asFile: true, quiet: true }); }, i * 1500); });
      return;
    }
    todo.forEach(function (e) { start(e, { quality: opts.quality, quiet: true }); });
    V.toast(V.plural(todo.length, 'episode') + ' added to Downloads' + (eps.length > todo.length ? ' (' + (eps.length - todo.length) + ' downloaded already)' : ''), { action: { label: 'View', fn: function () { V.router.go('#/downloads'); } } });
  }

  /** A series' Download: which episodes (this season, the whole series, the ones not watched yet), and the quality. */
  function chooseSeries(show, season) {
    if (!S.settings.allowDownloads && !S.profile.admin) return V.toast('Downloads are turned off on this server.', { error: true });
    var stored = canStore();
    V.loadEpisodes(show).then(function (eps) {
      eps = (eps || []).filter(function (e) { return e && e.t === 'episode'; });
      if (!eps.length) return V.toast('No episodes to download.', { error: true });
      var seasons = [];
      eps.forEach(function (e) { if (seasons.indexOf(e.s) < 0) seasons.push(e.s); });
      var unwatched = eps.filter(function (e) { var pr = V.progressOf(e.k); return !(pr && pr.w); });
      var cur = season !== undefined && seasons.indexOf(season) >= 0 ? season : seasons[0];
      var opt = function (v, label, n, sel) { return '<option value="' + v + '"' + (sel ? ' selected' : '') + '>' + V.esc(label) + ' (' + V.plural(n, 'episode') + ')</option>'; };
      V.dialog({
        title: 'Download “' + show.n + '”',
        body: '<label class="field"><span>Episodes</span><select class="input" data-which>' +
            seasons.map(function (s) { return opt('s' + s, s ? 'Season ' + s : 'Specials', eps.filter(function (e) { return e.s === s; }).length, s === cur); }).join('') +
            (unwatched.length && unwatched.length < eps.length ? opt('new', 'Not watched yet', unwatched.length) : '') +
            (seasons.length > 1 ? opt('all', 'The whole series', eps.length) : '') + '</select></label>' +
          '<label class="field"><span>Quality</span><select class="input" data-q><option value="0">Original</option><option value="1080">1080p</option><option value="720" selected>720p (smaller)</option><option value="480">480p (smallest)</option></select></label>' +
          (stored ? '<label class="check"><input type="checkbox" data-file><span>Save as files on this device instead of inside the app</span></label>' : '<p class="dim small">This address isn’t secure (https), so each episode is saved as an MP4 file. On https they can be kept inside the app for offline watching.</p>') +
          '<p class="dim small">They download one at a time. You can keep watching meanwhile; Downloads shows how far along they are.</p>',
        actions: [{ label: 'Cancel' }, { label: 'Download', primary: true, fn: function (d) {
          var w = V.$('[data-which]', d).value, q = +V.$('[data-q]', d).value, f = V.$('[data-file]', d);
          var pick = w === 'all' ? eps : w === 'new' ? unwatched : eps.filter(function (e) { return 's' + e.s === w; });
          startMany(pick.slice().sort(function (a, b) { return (a.s - b.s) || (a.e - b.e); }), { quality: q, asFile: !stored || (f && f.checked) });
        } }],
      });
    }, function (e) { V.toast('Couldn’t get the episodes: ' + e.message, { error: true }); });
  }

  function chooser(it) {
    var stored = canStore();
    V.dialog({
      title: 'Download “' + it.n + '”',
      body: '<label class="field"><span>Quality</span><select class="input" data-q><option value="0">Original</option><option value="1080">1080p</option><option value="720" selected>720p (smaller)</option><option value="480">480p (smallest)</option></select></label>' +
        (stored ? '<label class="check"><input type="checkbox" data-file><span>Save as a file on this device instead of inside the app</span></label>' : '<p class="dim small">This address isn’t secure (https), so the video is saved as an MP4 file you open with any player. On https it can be kept inside the app for offline watching.</p>') +
        '<p class="dim small">In the original quality it comes straight from the provider when it allows that (converted to MP4 in this browser if needed); otherwise, and for the smaller sizes, the server fetches and converts it.</p>',
      actions: [{ label: 'Cancel' }, { label: 'Download', primary: true, fn: function (d) { var q = +V.$('[data-q]', d).value; var f = V.$('[data-file]', d); start(it, { quality: q, asFile: !stored || (f && f.checked) }); } }],
    });
  }

  function pump() {
    if (active || !queue.length) return;
    var r = queue.shift();
    active = { r: r, ac: new AbortController() };
    r.status = 'downloading'; save(r);
    if (r.u && !r.viaServer) {
      var ac = active.ac, wd = null, cur0 = active;
      r.direct = true;
      navigator.storage.getDirectory().then(function (dir) { return dir.getFileHandle(fileName(r.k), { create: true }); })
        .then(function (fh) { return fh.createWritable(); })
        .then(function (w) { wd = w; return directTo(r.u, w, r, ac); })
        .then(function () { return wd.close(); })
        .then(function () {
          r.status = 'done'; r.doneAt = Date.now();
          return navigator.storage.getDirectory().then(function (dir) { return dir.getFileHandle(fileName(r.k)); }).then(function (fh) { return fh.getFile(); }).then(function (f) { r.size = r.bytes = f.size; });
        })
        .then(function () { save(r); V.toast('Downloaded: ' + r.n); active = null; if (cur0.done) cur0.done(); pump(); }, function (e) {
          var stop = function () { if (active === cur0) active = null; if (cur0.done) cur0.done(); };
          (wd ? wd.abort().catch(function () {}) : Promise.resolve()).then(function () {
            if (e && e.name === 'AbortError' || ac.signal.aborted) { r.status = 'cancelled'; stop(); if (!cur0.removing) remove(r.k, true); pump(); return; }
            // No room left: fetching it again through the server wouldn't help.
            if (full(e)) {
              r.status = 'failed'; r.error = FULL_MSG; stop(); save(r);
              V.toast('Download failed: ' + FULL_MSG, { error: true });
              navigator.storage.getDirectory().then(function (dir) { return dir.removeEntry(fileName(r.k)); }).catch(function () {}).then(pump);
              return;
            }
            // The provider doesn't let web pages read it (or the file is something else): the server does it.
            r.viaServer = true; r.direct = false; r.bytes = 0; r.progress = 0; stop();
            queue.unshift(r); pump();
          });
        });
      return;
    }
    var res, w, reader, last = 0, cur = active;
    // Copy the download into the app's private storage piece by piece.
    var copy = function () {
      return reader.read().then(function (chunk) {
        if (chunk.done) return;
        return w.write(chunk.value).then(function () {
          r.bytes += chunk.value.length;
          if (Date.now() - last > 700) { last = Date.now(); save(r); }
          return copy();
        });
      });
    };
    fetch('/api/download/' + encodeURIComponent(r.k) + (r.quality ? '?height=' + r.quality : ''), { signal: active.ac.signal, credentials: 'same-origin' }).then(function (x) {
      res = x;
      if (!res.ok) return res.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || 'HTTP ' + res.status); });
      r.size = Number(res.headers.get('Content-Length')) || 0;
      r.dur = Number(res.headers.get('X-Duration')) || r.d || 0;
      r.type = res.headers.get('Content-Type') || 'video/mp4';
      return navigator.storage.getDirectory();
    }).then(function (dir) { return dir.getFileHandle(fileName(r.k), { create: true }); })
      .then(function (fh) { return fh.createWritable(); })
      .then(function (writable) { w = writable; reader = res.body.getReader(); return copy(); })
      .then(function () { return w.close(); })
      .then(function () {
        r.status = 'done'; r.size = r.bytes; r.doneAt = Date.now();
        save(r);
        V.toast('Downloaded: ' + r.n);
      }, function (e) {
        // Close the half-written file first (an open one can't be deleted, and its part would stay and use space).
        if (reader) reader.cancel().catch(function () {});
        return (w ? w.abort().catch(function () {}) : Promise.resolve()).then(function () {
          if (e && e.name === 'AbortError' || cur.ac.signal.aborted) { r.status = 'cancelled'; if (active === cur) active = null; if (!cur.removing) return remove(r.k, true); return; }
          r.status = 'failed'; r.error = full(e) ? FULL_MSG : (e && e.message) || 'unknown error'; save(r);
          V.toast('Download failed: ' + r.error, { error: true });
          return navigator.storage.getDirectory().then(function (dir) { return dir.removeEntry(fileName(r.k)); }).catch(function () {});
        });
      }).then(function () { if (active === cur) active = null; if (cur.done) cur.done(); pump(); });
  }

  function remove(k, quiet) {
    queue = queue.filter(function (x) { return x.k !== k; });
    // Downloading now: stop it, and wait until its file is closed before deleting it.
    var stopped = Promise.resolve();
    if (active && active.r.k === k) {
      var a = active;
      a.removing = true;
      stopped = new Promise(function (res) { a.done = res; setTimeout(res, 5000); }); // (not forever, whatever happens)
      a.ac.abort();
    }
    var gone = stopped.then(function () {
      return navigator.storage && navigator.storage.getDirectory ? navigator.storage.getDirectory().then(function (dir) { return dir.removeEntry(fileName(k)); }).catch(function () {}) : null;
    });
    return gone.then(function () {
      items.delete(k);
      return V.idb.del(k, 'dl');
    }).then(function () {
      V.emit('downloads');
      if (!quiet) V.toast('Removed from this device');
    });
  }

  function play(k) {
    var r = items.get(k);
    if (!r) return Promise.resolve();
    return navigator.storage.getDirectory().then(function (dir) { return dir.getFileHandle(fileName(k)); })
      .then(function (fh) { return fh.getFile(); })
      .then(function (file) {
        var url = URL.createObjectURL(file);
        // Let the file go once the player has moved on (checked just after a teardown: a retry or "Watch again" loads
        // this same file again; closing the player or playing something else doesn't).
        var off = V.on('player-teardown', function (p) {
          setTimeout(function () { if (!p.it || p.it.offlineUrl !== url) { off(); URL.revokeObjectURL(url); } }, 0);
        });
        var base = V.entry(k) || { k: r.k, n: r.n, t: r.t, i: r.i, sk: r.sk, s: r.s, e: r.e, et: r.et, d: r.dur || r.d };
        V.play(Object.assign({}, base, { offlineUrl: url, d: r.dur || base.d }));
      }).catch(function () { V.toast('That download is missing. Download it again.', { error: true }); });
  }

  // Remove downloads you've finished watching (if the profile wants that).
  V.on('progress', function (k) {
    if (!V.pref('autoDeleteWatched')) return;
    var p = V.progressOf(k), r = items.get(k);
    if (p && p.w && r && r.status === 'done') remove(k, true);
  });

  return { start: start, startMany: startMany, chooseSeries: chooseSeries, remove: remove, play: play, load: load, list: function () { return Array.from(items.values()).sort(function (a, b) { return b.at - a.at; }); }, canStore: canStore, retry: function (k) { var r = items.get(k); if (r) { r.status = 'queued'; r.bytes = 0; r.viaServer = false; save(r); queue.push(r); pump(); } } };
})();

V.route('downloads', function (view) {
  var draw = function () {
    var list = V.downloads.list().filter(function (r) { return !S.profile || !S.profile.id || r.pid === S.profile.id || !r.pid; });
    view.innerHTML = V.pageHead('Downloads', '<div class="page-tools"><span class="dim" data-usage></span></div>') +
      (V.downloads.canStore() ? '' : '<p class="note">' + V.icon('info') + ' This address isn’t secure (https), so downloads are saved as MP4 files instead of inside the app. See the README to turn on https.</p>') +
      (list.length ? '<ul class="dl-list">' + list.map(function (r) {
        var pct = r.size ? r.bytes / r.size : 0;
        return '<li data-k="' + V.esc(r.k) + '">' + V.art(r.i, r.n, 'art dl-art') + '<div class="dl-b"><b>' + V.esc(r.show ? r.show + ' · S' + r.s + ':E' + r.e : r.n) + '</b>' +
          '<span class="dim">' + (r.status === 'done' ? V.fmtSize(r.size) + (r.quality ? ' · ' + r.quality + 'p' : '') : r.status === 'downloading' ? (r.progress !== undefined && r.direct && !r.size ? 'Converting in this browser · ' + Math.round(r.progress * 100) + '%' : V.fmtSize(r.bytes) + (r.size ? ' of ' + V.fmtSize(r.size) : r.direct ? ' (straight from the provider)' : ' (converting on the server)')) : r.status === 'failed' ? 'Failed: ' + V.esc(r.error || '') : 'Waiting…') + '</span>' +
          (r.status === 'downloading' ? (r.progress !== undefined && r.direct && !r.size ? '<span class="bar"><i style="width:' + Math.round(r.progress * 100) + '%"></i></span>' : '<span class="bar"><i style="width:' + (r.size ? pct * 100 : 30) + '%"' + (r.size ? '' : ' class="indet"') + '></i></span>') : '') + '</div>' +
          (r.status === 'done' ? '<button class="btn sm primary" data-d="play">' + V.icon('play') + ' Play</button>' : r.status === 'failed' ? '<button class="btn sm" data-d="retry">Retry</button>' : '') +
          '<button class="icon-btn" data-d="del" aria-label="Delete download">' + V.icon('trash') + '</button></li>';
      }).join('') + '</ul>' : V.empty('No downloads', 'Use ' + V.icon('download', 'tiny') + ' on a film, an episode or a series (a season, or all of it) to watch it without a connection.')) +
      '<label class="check"><input type="checkbox" data-auto' + (V.pref('autoDeleteWatched') ? ' checked' : '') + '><span>Delete downloads automatically once watched</span></label>';
    if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(function (e) { var u = V.$('[data-usage]', view); if (u) u.textContent = V.fmtSize(e.usage || 0) + ' used of ' + V.fmtSize(e.quota || 0) + ' available'; });
    var auto = V.$('[data-auto]', view);
    if (auto) auto.onchange = function (e) { V.setPref('autoDeleteWatched', e.target.checked); };
  };
  draw();
  view.addEventListener('click', function (e) {
    var b = e.target.closest('[data-d]'); if (!b) return;
    var k = b.closest('[data-k]').dataset.k;
    if (b.dataset.d === 'play') V.downloads.play(k);
    else if (b.dataset.d === 'retry') V.downloads.retry(k);
    else V.confirm('Delete this download from this device?', { ok: 'Delete', danger: true }).then(function (ok) { if (ok) V.downloads.remove(k); });
  });
  var off = V.on('downloads', V.throttle(draw, 500));
  V.pageCleanup = off;
});
