/* Converting a file in the browser instead of on the server, with Mediabunny (https://mediabunny.dev).
   MKV/MPEG-TS files with sound the browser can't play (AC-3, E-AC-3, FLAC…) are read straight from the provider,
   the picture is copied as it is (or re-encoded when the browser can't take it), the sound is decoded (AC-3/E-AC-3
   with a small WebAssembly decoder) and encoded again as AAC/Opus, and the result is fed to the video element
   (Media Source Extensions). Nothing goes through the server. It needs the provider to let web pages read its files
   (CORS) and a browser with WebCodecs (Chrome, Edge, Safari 16.4+, Firefox 130+); otherwise the server converts. */
'use strict';
(function () {
  var MB = null, loading = null;

  /** Can this browser convert files itself? */
  V.mbSupported = function () {
    try {
      return !!(window.MediaSource && window.AudioDecoder && window.VideoDecoder && window.WritableStream && window.fetch &&
        'noModule' in document.createElement('script') && !V.pref('noBrowserConvert'));
    } catch (e) { return false; }
  };

  function load() {
    if (MB) return Promise.resolve(MB);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var done = function () { if (window.Mediabunny) { MB = window.Mediabunny; resolve(MB); } };
      window.addEventListener('mediabunny-ready', done, { once: true });
      var s = document.createElement('script');
      s.type = 'module';
      s.src = '/vendor/mediabunny-loader.module.js';
      s.onerror = function () { loading = null; reject(new Error('Couldn’t load the in-browser converter.')); };
      document.head.appendChild(s);
      setTimeout(function () { if (!MB) { loading = null; reject(new Error('The in-browser converter didn’t load in time.')); } }, 30000);
    });
    return loading;
  }
  V.mbLoad = load;

  var mse = function (t) { try { return MediaSource.isTypeSupported(t); } catch (e) { return false; } };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /**
   * Starts converting `url` from `startAt` seconds into `video`. Resolves to a controller once the first video is in
   * the buffer: { duration, offset, stop(), done (a promise), info }. Rejects when this file can't be done here
   * (sound that can't be decoded in a browser, like DTS; a codec the browser can't decode at all…).
   * opts: { parallel (requests at once), onError(err) for problems after the start }.
   */
  V.mbStart = function (video, url, startAt, opts) {
    opts = opts || {};
    var stopped = false, input = null, conv = null, ms = null, sb = null, output = null, objUrl = '';
    var info = {};
    var ctl = {
      offset: startAt || 0, duration: 0, info: info,
      stop: function () {
        stopped = true;
        if (conv) conv.cancel().catch(function () {});
        if (input && input.dispose) { try { input.dispose(); } catch (e) {} }
        if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch (e) {} }
      },
    };
    return load().then(function (M) {
      input = new M.Input({ source: new M.UrlSource(url, { parallelism: opts.parallel || 2, getRetryDelay: function (n, err) { return n < 2 && !(err instanceof TypeError) ? 1 + n : null; } }), formats: M.ALL_FORMATS });
      return Promise.all([input.computeDuration(), input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack(), input.getAudioTracks()]).then(function (r) {
        var dur = r[0], vt = r[1], at = r[2], all = r[3] || [];
        if (stopped) throw new Error('stopped');
        ctl.duration = dur || 0;
        // Which sound track: the one asked for, else the viewer's language, else the file's main one.
        ctl.audioTracks = all.map(function (t, i) { return { i: i, lang: t.languageCode && t.languageCode !== 'und' ? t.languageCode : '', title: t.name || '', codec: t.codec || '', channels: t.numberOfChannels || 0 }; });
        if (opts.audioTrack >= 0 && all[opts.audioTrack]) at = all[opts.audioTrack];
        else if (opts.lang && all.length > 1) { var want = String(opts.lang).slice(0, 2).toLowerCase(); for (var ti = 0; ti < all.length; ti++) if (String(all[ti].languageCode || '').slice(0, 2).toLowerCase() === want) { at = all[ti]; break; } }
        ctl.audioTrack = at ? all.indexOf(at) : -1;
        return Promise.all([
          vt ? vt.getCodecParameterString() : null, at ? at.getCodecParameterString() : null,
          vt ? vt.canDecode() : false, at ? at.canDecode() : false,
          M.getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: 48000 }),
          M.canEncodeVideo ? M.canEncodeVideo('avc') : false,
        ]).then(function (c) {
          var vp = c[0], ap = c[1], vDec = c[2], aDec = c[3], aEnc = c[4], avcEnc = c[5];
          info.video = vt ? vt.codec : ''; info.audio = at ? at.codec : '';
          var videoOpt = {}, audioOpt = {};
          if (vt) {
            if (vp && mse('video/mp4; codecs="' + vp + '"')) info.videoWay = 'copy';
            else if (vDec && avcEnc) { videoOpt = { codec: 'avc' }; info.videoWay = 'convert'; }
            else throw new Error('This browser can’t play this video format (' + vt.codec + ').');
          }
          if (at) {
            if (ap && mse('audio/mp4; codecs="' + ap + '"')) info.audioWay = 'copy';
            else if (aDec && aEnc) { audioOpt = { codec: aEnc, numberOfChannels: 2 }; info.audioWay = 'convert'; }
            else throw new Error('This file’s sound (' + at.codec + ') can’t be decoded in a browser.');
          }
          var v = video;
          ms = new MediaSource();
          objUrl = URL.createObjectURL(ms);
          v.src = objUrl;
          return new Promise(function (res) { ms.addEventListener('sourceopen', res, { once: true }); }).then(function () {
            var firstData = null;
            var gotFirst = new Promise(function (res) { firstData = res; });
            var idle = function () { return new Promise(function (res) { if (!sb.updating) return res(); sb.addEventListener('updateend', function () { res(); }, { once: true }); }); };
            var ahead = function () { var b = v.buffered; return b.length ? b.end(b.length - 1) - v.currentTime : 0; };
            // Keep about a minute ready; drop what's well behind (the browser limits how much it holds).
            var trim = function () {
              var b = v.buffered;
              if (!b.length || sb.updating || v.currentTime - b.start(0) < 60) return Promise.resolve();
              sb.remove(b.start(0), v.currentTime - 30);
              return idle();
            };
            var append = function (data) {
              return idle().then(function () {
                if (stopped) throw new Error('stopped');
                sb.appendBuffer(data);
                return idle();
              }).catch(function (e) {
                if (e && e.name === 'QuotaExceededError') return trim().then(function () { return sleep(500); }).then(function () { return append(data); });
                throw e;
              });
            };
            var writable = new WritableStream({
              write: function (chunk) {
                if (stopped) return Promise.reject(new Error('stopped'));
                var ready = sb ? Promise.resolve() : output.getMimeType().then(function (mime) {
                  info.mime = mime;
                  sb = ms.addSourceBuffer(mime);
                  if (ctl.duration) { try { ms.duration = Math.max(1, ctl.duration - ctl.offset); } catch (e) {} }
                });
                var wait = function () { return ahead() > (V.tune ? V.tune.mbAhead() : 60) && !stopped ? sleep(400).then(wait) : trim(); };
                return ready.then(wait).then(function () { return append(chunk.data); }).then(function () {
                  if (firstData && v.buffered.length && v.buffered.end(v.buffered.length - 1) > 2) { firstData(); firstData = null; }
                });
              },
            });
            output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'fragmented' }), target: new M.StreamTarget(writable, { chunked: true }) });
            var copt = {
              input: input, output: output, tracks: 'all', showWarnings: false,
              video: function (t) { return t === vt ? videoOpt : { discard: true }; },
              audio: function (t) { return t === at ? audioOpt : { discard: true }; },
            };
            if (ctl.offset > 0.5 && ctl.offset < ctl.duration - 1) copt.trim = { start: ctl.offset }; else ctl.offset = 0;
            return M.Conversion.init(copt).then(function (cv) {
              conv = cv;
              var lostSound = (cv.discardedTracks || []).some(function (d) { return d.track === at && d.reason !== 'discarded_by_user'; });
              if (!cv.isValid || lostSound) throw new Error('This file can’t be converted in the browser.');
              ctl.done = cv.execute().then(function () {
                if (stopped) return;
                return idle().then(function () { if (ms.readyState === 'open') ms.endOfStream(); });
              }, function (e) {
                if (stopped) return;
                if (firstData) { firstData = null; failStart(e); return; }
                if (opts.onError) opts.onError(e);
              });
              var failStart = null;
              return new Promise(function (res, rej) {
                failStart = rej;
                gotFirst.then(function () { res(ctl); });
              });
            });
          });
        });
      });
    }).catch(function (e) { ctl.stop(); throw e; });
  };
})();
