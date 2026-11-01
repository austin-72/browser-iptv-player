/* Catch-up (archive) playback: builds the address of a past programme for channels that support it.
   Supports the common schemes: default/append (catchup-source templates), shift/timeshift, flussonic, xc (Xtream Codes). */
'use strict';

V.catchup = (() => {
  const pad = (n, l = 2) => String(n).padStart(l, '0');

  /** Date parts in UTC, or in a named time zone (Xtream servers use their own local time). */
  function parts(ms, tz) {
    if (tz) {
      try {
        const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
        const o = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
        return { Y: o.year, m: o.month, d: o.day, H: o.hour, M: o.minute, S: o.second };
      } catch {}
    }
    const d = new Date(ms);
    return { Y: String(d.getUTCFullYear()), m: pad(d.getUTCMonth() + 1), d: pad(d.getUTCDate()), H: pad(d.getUTCHours()), M: pad(d.getUTCMinutes()), S: pad(d.getUTCSeconds()) };
  }
  // "Y-m-d H:M:S" style (letters) and "yyyy-MM-dd HH:mm:ss" style (Java/Kodi).
  const fmtLetters = (ms, f, tz) => { const p = parts(ms, tz); return f.replace(/[YmdHMS]/g, (c) => p[c]); };
  const fmtJava = (ms, f, tz) => { const p = parts(ms, tz); return f.replace(/yyyy|MM|dd|HH|mm|ss/g, (c) => ({ yyyy: p.Y, MM: p.m, dd: p.d, HH: p.H, mm: p.M, ss: p.S })[c]); };

  function fillTemplate(tpl, start, end, tz) {
    const now = Date.now();
    const s = Math.floor(start / 1000), e = Math.floor(end / 1000), n = Math.floor(now / 1000);
    const dur = Math.max(60, e - s);
    return tpl
      .replace(/\{(utc|utcend|lutc|start|end|now):([^}]+)\}/g, (m, k, f) => fmtLetters({ utc: start, start, utcend: end, end, lutc: now, now }[k], f, tz))
      .replace(/\$\{\((b|e|n)\)([^}]+)\}/g, (m, k, f) => fmtJava({ b: start, e: end, n: now }[k], f, tz))
      .replace(/\{duration:(\d+)\}/g, (m, d) => String(Math.floor(dur / +d)))
      .replace(/\{offset:(\d+)\}/g, (m, d) => String(Math.floor((n - s) / +d)))
      .replace(/\{utc\}|\$\{start\}|\{start\}/g, String(s))
      .replace(/\{utcend\}|\$\{end\}|\{end\}/g, String(e))
      .replace(/\{lutc\}|\$\{now\}|\$\{timestamp\}|\{now\}|\{timestamp\}/g, String(n))
      .replace(/\{duration\}|\$\{duration\}/g, String(dur))
      .replace(/\$\{offset\}|\{offset\}/g, String(n - s))
      .replace(/\{([YmdHMS])\}/g, (m, c) => parts(start, tz)[c]);
  }

  function build(e, start, end) {
    const c = e.cu;
    if (!c) return null;
    const url = e.u;
    const type = c.type;
    const s = Math.floor(start / 1000), dur = Math.max(60, Math.floor((end - start) / 1000));
    if (type === 'xc' || type === 'xtream') {
      // http://host[/prefix]/live/user/pass/123.ts, or the short form http://host/user/pass/123
      const m = url.match(/^(https?:\/\/.+?)\/live\/([^/]+)\/([^/]+)\/(\d+)(?:\.(\w+))?(\?.*)?$/) || url.match(/^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)\/(\d+)(?:\.(\w+))?(\?.*)?$/);
      if (!m) return null;
      const p = parts(start, c.tz);
      return `${m[1]}/timeshift/${m[2]}/${m[3]}/${Math.ceil(dur / 60)}/${p.Y}-${p.m}-${p.d}:${p.H}-${p.M}/${m[4]}.ts`;
    }
    if (type === 'flussonic' || type === 'flussonic-hls' || type === 'flussonic-ts' || type === 'fs') {
      try {
        const u = new URL(url);
        const segs = u.pathname.split('/');
        const last = segs[segs.length - 1];
        if (/\.m3u8$/i.test(last)) segs[segs.length - 1] = last.replace(/\.m3u8$/i, `-${s}-${dur}.m3u8`);
        else if (last === 'mpegts') segs[segs.length - 1] = `timeshift_abs-${s}.ts`;
        else segs.push(`timeshift_abs-${s}.ts`);
        u.pathname = segs.join('/');
        return u.href;
      } catch { return null; }
    }
    if (type === 'shift' || type === 'timeshift') {
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}utc=${s}&lutc=${Math.floor(Date.now() / 1000)}`;
    }
    // default / append: a template from catchup-source
    if (!c.source) {
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}utc=${s}&lutc=${Math.floor(Date.now() / 1000)}`;
    }
    const filled = fillTemplate(c.source, start, end, c.tz);
    if (type === 'append' || !/^[a-z][a-z0-9+.-]*:\/\//i.test(filled)) return url + filled;
    return filled;
  }

  const days = (e) => (e.cu && e.cu.days) || 7;

  return {
    available: (e) => !!(e && e.cu && e.t === 'live' && build(e, Date.now() - 3600e3, Date.now() - 1800e3)),
    /** Can this programme be played from the archive? (started, and not older than the archive) */
    canPlay(e, p, now = Date.now()) {
      if (!this.available(e) || !p) return false;
      return p.s < now - 30e3 && p.s > now - days(e) * 86400e3;
    },
    url: build,
    /** A playable stand-in entry for a past programme. offset = seconds into the programme. */
    entryFor(e, p, offset = 0) {
      const start = p.s + offset * 1000;
      const end = Math.max(p.e, start + 60e3);
      const url = build(e, start, Math.min(end, p.e > Date.now() ? Date.now() : end));
      if (!url) return null;
      return {
        ...e, k: e.k, u: url, h: e.h, t: 'catchup', catchupOf: e.k, prog: p, startOffset: offset,
        n: `${p.t}`, channelName: e.n, d: Math.max(0, (p.e - p.s) / 1000), a: null,
      };
    },
    fillTemplate,
  };
})();
