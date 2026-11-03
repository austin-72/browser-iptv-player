/* Catch-up (archive) playback: builds the address of a past programme for channels that support it.
   Supports the common schemes: default/append (catchup-source templates), shift/timeshift, flussonic, xc (Xtream Codes). */
'use strict';

V.catchup = function () {
  var pad = function pad(n, l) {
    if (l === void 0) {
      l = 2;
    }
    return String(n).padStart(l, '0');
  };

  /** Date parts in UTC, or in a named time zone (Xtream servers use their own local time). */
  function parts(ms, tz) {
    if (tz) {
      try {
        var f = new Intl.DateTimeFormat('en-GB', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23'
        });
        var o;
        if (f.formatToParts) {
          o = Object.fromEntries(f.formatToParts(new Date(ms)).map(function (p) {
            return [p.type, p.value];
          }));
        } else {
          // Older TV browsers: no formatToParts, so read the numbers out of "dd/mm/yyyy, hh:mm:ss".
          var n = f.format(new Date(ms)).match(/\d+/g) || [];
          o = { day: n[0], month: n[1], year: n[2], hour: n[3], minute: n[4], second: n[5] };
        }
        if (o.year && o.hour) return {
          Y: o.year,
          m: pad(+o.month),
          d: pad(+o.day),
          H: pad(+o.hour % 24), // (some browsers ignore hourCycle and say "24" at midnight)
          M: pad(+o.minute),
          S: pad(+o.second || 0)
        };
      } catch (_unused) {}
    }
    var d = new Date(ms);
    return {
      Y: String(d.getUTCFullYear()),
      m: pad(d.getUTCMonth() + 1),
      d: pad(d.getUTCDate()),
      H: pad(d.getUTCHours()),
      M: pad(d.getUTCMinutes()),
      S: pad(d.getUTCSeconds())
    };
  }
  // "Y-m-d H:M:S" style (letters) and "yyyy-MM-dd HH:mm:ss" style (Java/Kodi).
  var fmtLetters = function fmtLetters(ms, f, tz) {
    var p = parts(ms, tz);
    return f.replace(/[YmdHMS]/g, function (c) {
      return p[c];
    });
  };
  var fmtJava = function fmtJava(ms, f, tz) {
    var p = parts(ms, tz);
    return f.replace(/yyyy|MM|dd|HH|mm|ss/g, function (c) {
      return {
        yyyy: p.Y,
        MM: p.m,
        dd: p.d,
        HH: p.H,
        mm: p.M,
        ss: p.S
      }[c];
    });
  };
  function fillTemplate(tpl, start, end, tz) {
    var now = Date.now();
    var s = Math.floor(start / 1000),
      e = Math.floor(end / 1000),
      n = Math.floor(now / 1000);
    var dur = Math.max(60, e - s);
    return tpl.replace(/\{(utc|utcend|lutc|start|end|now):([^}]+)\}/g, function (m, k, f) {
      return fmtLetters({
        utc: start,
        start: start,
        utcend: end,
        end: end,
        lutc: now,
        now: now
      }[k], f, tz);
    }).replace(/\$\{\((b|e|n)\)([^}]+)\}/g, function (m, k, f) {
      return fmtJava({
        b: start,
        e: end,
        n: now
      }[k], f, tz);
    }).replace(/\{duration:(\d+)\}/g, function (m, d) {
      return String(Math.floor(dur / +d));
    }).replace(/\{offset:(\d+)\}/g, function (m, d) {
      return String(Math.floor((n - s) / +d));
    }).replace(/\{utc\}|\$\{start\}|\{start\}/g, String(s)).replace(/\{utcend\}|\$\{end\}|\{end\}/g, String(e)).replace(/\{lutc\}|\$\{now\}|\$\{timestamp\}|\{now\}|\{timestamp\}/g, String(n)).replace(/\{duration\}|\$\{duration\}/g, String(dur)).replace(/\$\{offset\}|\{offset\}/g, String(n - s)).replace(/\{([YmdHMS])\}/g, function (m, c) {
      return parts(start, tz)[c];
    });
  }
  function build(e, start, end) {
    var c = e.cu;
    if (!c) return null;
    var url = e.u;
    var type = c.type;
    var s = Math.floor(start / 1000),
      dur = Math.max(60, Math.floor((end - start) / 1000));
    if (type === 'xc' || type === 'xtream') {
      // http://host[/prefix]/live/user/pass/123.ts, or the short form http://host/user/pass/123
      var m = url.match(/^(https?:\/\/.+?)\/live\/([^/]+)\/([^/]+)\/(\d+)(?:\.(\w+))?(\?.*)?$/) || url.match(/^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)\/(\d+)(?:\.(\w+))?(\?.*)?$/);
      if (!m) return null;
      var p = parts(start, c.tz);
      return m[1] + "/timeshift/" + m[2] + "/" + m[3] + "/" + Math.ceil(dur / 60) + "/" + p.Y + "-" + p.m + "-" + p.d + ":" + p.H + "-" + p.M + "/" + m[4] + ".ts";
    }
    if (type === 'flussonic' || type === 'flussonic-hls' || type === 'flussonic-ts' || type === 'fs') {
      try {
        var u = new URL(url);
        var segs = u.pathname.split('/');
        var last = segs[segs.length - 1];
        if (/\.m3u8$/i.test(last)) segs[segs.length - 1] = last.replace(/\.m3u8$/i, "-" + s + "-" + dur + ".m3u8");else if (last === 'mpegts') segs[segs.length - 1] = "timeshift_abs-" + s + ".ts";else segs.push("timeshift_abs-" + s + ".ts");
        u.pathname = segs.join('/');
        return u.href;
      } catch (_unused2) {
        return null;
      }
    }
    if (type === 'shift' || type === 'timeshift') {
      var sep = url.includes('?') ? '&' : '?';
      return "" + url + sep + "utc=" + s + "&lutc=" + Math.floor(Date.now() / 1000);
    }
    // default / append: a template from catchup-source
    if (!c.source) {
      var _sep = url.includes('?') ? '&' : '?';
      return "" + url + _sep + "utc=" + s + "&lutc=" + Math.floor(Date.now() / 1000);
    }
    var filled = fillTemplate(c.source, start, end, c.tz);
    if (type === 'append' || !/^[a-z][a-z0-9+.-]*:\/\//i.test(filled)) return url + filled;
    return filled;
  }
  var days = function days(e) {
    return e.cu && e.cu.days || 7;
  };

  /**
   * "Start over" (or an earlier part) of a programme still on air: its archive copy stops where "now" was when it
   * started. When it gets there, carry on: the rest of it from the archive, or the channel live once it's caught up.
   * True when it did something (otherwise the usual end of a video).
   */
  function carryOn(pl) {
    var it = pl && pl.it;
    if (!it || it.t !== 'catchup' || !it.cutAt || !it.prog || V._sleepAt === -1) return false; // (the sleep timer's "end of this video" stops it)
    var c = V.entry(it.catchupOf);
    if (!c) return false;
    var prog = it.prog,
      now = Date.now(),
      at = it.cutAt; // (where the archive copy ended)
    if (at >= prog.e - 5e3) return false; // (the whole programme has been played)
    if (prog.e > now && now - at < 90e3) {
      V.play(c); // (less than a minute and a half behind: live)
      return true;
    }
    var ce = V.catchup.entryFor(c, prog, Math.floor((at - prog.s) / 1000));
    if (!ce) {
      if (prog.e <= now) return false;
      V.play(c);
      return true;
    }
    V.play(ce, {
      startAt: 0
    });
    return true;
  }
  // (The player's end-of-video handler, from watch.js, does nothing for catch-up: ours goes first.)
  V.on('player-started', function (pl) {
    if (!pl.onEnded || pl.onEnded._catchup) return;
    var prev = pl.onEnded;
    pl.onEnded = function (self) {
      if (carryOn(self || pl)) return;
      return prev.apply(this, arguments);
    };
    pl.onEnded._catchup = true;
  });
  return {
    available: function available(e) {
      return !!(e && e.cu && e.t === 'live' && build(e, Date.now() - 3600e3, Date.now() - 1800e3));
    },
    /** Can this programme be played from the archive? (started, and not older than the archive) */canPlay: function canPlay(e, p, now) {
      if (now === void 0) {
        now = Date.now();
      }
      if (!this.available(e) || !p) return false;
      return p.s < now - 30e3 && p.s > now - days(e) * 86400e3;
    },
    url: build,
    /** A playable stand-in entry for a past programme. offset = seconds into the programme. */entryFor: function entryFor(e, p, offset) {
      if (offset === void 0) {
        offset = 0;
      }
      var start = p.s + offset * 1000;
      var end = Math.max(p.e, start + 60e3);
      // Still on air: the archive only goes up to now (cutAt: see carryOn below).
      var cut = p.e > Date.now() ? Date.now() : 0;
      var url = build(e, start, Math.min(end, cut || end));
      if (!url) return null;
      return Object.assign({}, e, {
        k: e.k,
        u: url,
        h: e.h,
        t: 'catchup',
        catchupOf: e.k,
        prog: p,
        startOffset: offset,
        cutAt: cut || undefined,
        n: "" + p.t,
        channelName: e.n,
        d: Math.max(0, (p.e - p.s) / 1000),
        a: null
      });
    },
    fillTemplate: fillTemplate
  };
}();