// Error reports: problems that happen on viewers' devices (and server errors) are sent here automatically, grouped
// into issues and kept so they can be looked at and fixed (Admin → Error reports, or data/error-reports.txt).
//
// Each report says what went wrong (message, stack — mapped from the bundled /app.js back to web/js/<file>:<line>, with
// the line of code), where (page, device, browser, screen, profile), what was playing (route, position, the player's
// state) and the last things that happened before it (pages, clicks, keys, server calls, player events).
// Secrets never get in: stream addresses lose their user names, passwords and tokens, on the device and again here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JsonFile } = require('./store');

const MAX_ISSUES = 300;
const MAX_SAMPLES = 5;
const KINDS = { error: 'Error', rejection: 'Unhandled promise error', console: 'Logged error', shown: 'Error shown to the viewer', playback: 'Playback failed', resource: 'File didn’t load', startup: 'App didn’t start', freeze: 'Page froze', server: 'Server error', user: 'Reported by a viewer' };
// A viewer's own "Report a problem": never grouped with others or dropped as a repeat, but limited per device.
const USER_PER_HOUR = 12;

/** Removes passwords, user names and tokens from text that may hold stream addresses or keys. */
function scrub(s) {
  if (s == null) return s;
  return String(s)
    .replace(/(\/\/)[^/@\s:]+:[^/@\s]+@/g, '$1…:…@') // http://user:pass@host
    .replace(/(\/(?:live|movie|movies|series|timeshift|timeshifts|play|hls|stream)\/)[^/\s?#]+\/[^/\s?#]+\//gi, '$1…/…/') // Xtream /live/user/pass/
    .replace(/([?&;](?:username|user|password|pass|pwd|token|access_token|auth|key|api_key|apikey|api-key|sig|signature|mac|sn|serial|e|hash|session|sid)=)[^&#\s"']+/gi, '$1…')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 …')
    .replace(/\biptv_[A-Za-z0-9_-]{16,}/g, 'iptv_…')
    .replace(/([A-Za-z0-9_-]{48,})/g, (m) => m.slice(0, 6) + '…');
}
/**
 * Likely secrets in a viewer's own words ("my PIN is 4321", "password: hunter2"): the number after PIN, code or
 * passcode, and whatever follows "password", are replaced with "…". (The same is done on the device: problem.js.)
 */
const NOTE_WORDS = /^(are|and|or|but|not|doesn'?t|does|did|didn'?t|won'?t|isn'?t|wrong|again|for|the|a|an|it|in|on|box|field|screen|prompt|page|keeps|asked|needed|needs|required|works?|changed?)[.,;:!?]*$/i;
function scrubNote(s) {
  return String(s == null ? '' : s).replace(/\b(pin ?codes?|pass ?codes?|pins?|codes?|passwords?|passwd|pwd|pw)\b((?:\s+(?:is|was|=|of|to|it'?s|its))*\s*[:=#-]?\s*)(\S+)/gi, (m, w, mid, tok) => {
    if (NOTE_WORDS.test(tok)) return m;
    if (/^p(ass ?w|w)/i.test(w) && !/^pass ?codes?$/i.test(w)) return w + mid + '…';
    if (/^codes?$/i.test(w) ? /\d{4,}/.test(tok) : /\d/.test(tok)) return w + mid + '…';
    return m;
  });
}
const clip = (s, n) => { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n) + '…' : s; };
/** Deep copy with every string scrubbed and clipped, depth/size limited. */
function clean(v, depth = 0, n = 400) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return clip(scrub(v), n);
  if (depth > 4) return undefined;
  if (Array.isArray(v)) return v.slice(0, 60).map((x) => clean(x, depth + 1, n));
  if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v).slice(0, 60)) o[clip(k, 40)] = clean(v[k], depth + 1, n); return o; }
  return undefined;
}

/** Groups messages that differ only by numbers, quoted names or addresses. */
function normMsg(m) {
  return String(m || '').toLowerCase()
    .replace(/https?:\/\/\S+/g, 'URL').replace(/“[^”]*”|"[^"]*"|'[^']*'|‘[^’]*’/g, '…')
    .replace(/\b[0-9a-f]{8,}\b/g, 'ID').replace(/\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 200);
}

class ErrorReports {
  /** opts: { dataDir, log, version, root } — root: the app folder (for server stack frames and code lines). */
  constructor({ dataDir, log = () => {}, version = '', root = '' }) {
    this.log = log;
    this.version = version;
    this.root = root;
    this.store = new JsonFile(path.join(dataDir, 'error-reports.json'), { on: true, issues: [] }, { delay: 2000 });
    if (!Array.isArray(this.store.data.issues)) this.store.data.issues = [];
    this.txtFile = path.join(dataDir, 'error-reports.txt');
    this.bundles = new Map(); // bundle version → { files: [{ file, start, end }], src: Map(file → lines) }
    this.rate = new Map(); // ip → { at, n }
    this.hour = { at: 0, n: 0 };
    this.lineCache = new Map();
    this.userRate = new Map(); // ip|profile → [times] (viewers' own reports)
  }
  get on() { return this.store.data.on !== false; }
  set on(v) { this.store.data.on = !!v; this.store.save(); }

  // ------------------------------------------------------------ mapping /app.js back to web/js files
  /**
   * Called when the web bundle is built: which lines of /app.js came from which file. The bundle is each file as
   * "/* name *\/\n" + its text, joined with "\n;\n" (see buildBundle in server.js).
   */
  setBundle(v, parts) {
    const files = [];
    const src = new Map();
    let line = 1; // the "/* name */" line
    for (const p of parts) {
      const lines = p.text.split('\n');
      files.push({ file: p.file, start: line + 1, end: line + lines.length });
      src.set(p.file, lines);
      line += lines.length + 2;
    }
    this.bundles.set(v, { files, src });
    while (this.bundles.size > 3) this.bundles.delete(this.bundles.keys().next().value);
    this.current = v;
  }
  /** "…/app.js?v=x:1234:56" → { file: 'web/js/player.js', line, col, code }. */
  _mapApp(line, col, v) {
    const b = this.bundles.get(v) || (v ? null : this.bundles.get(this.current));
    if (!b) return null;
    const f = b.files.find((x) => line >= x.start && line <= x.end);
    if (!f) return null;
    const l = line - f.start + 1;
    const lines = b.src.get(f.file) || [];
    return { file: `web/js/${f.file}`, line: l, col, code: clip((lines[l - 1] || '').trim(), 220) };
  }
  _codeLine(rel, line) {
    if (!this.root || !/^(server\.js|lib\/[\w.-]+\.js)$/.test(rel)) return '';
    let lines = this.lineCache.get(rel);
    if (!lines) { try { lines = fs.readFileSync(path.join(this.root, rel), 'utf8').split('\n'); } catch { lines = []; } this.lineCache.set(rel, lines); if (this.lineCache.size > 40) this.lineCache.delete(this.lineCache.keys().next().value); }
    return clip((lines[line - 1] || '').trim(), 220);
  }
  /**
   * Rewrites a stack so each frame names the source file and line (and adds that line of code). Returns
   * { stack, frames: [{ fn, file, line, col, code }] }. Works for Chrome/Edge/Node ("at fn (url:l:c)") and
   * Safari/Firefox ("fn@url:l:c").
   */
  mapStack(stack, v) {
    const out = [], frames = [];
    for (const raw of String(stack || '').split('\n').slice(0, 40)) {
      const m = /^\s*(?:at\s+(?:(.*?)\s+\()?|(.*?)@)?(.*?):(\d+):(\d+)\)?\s*$/.exec(raw);
      if (!m || !m[3]) { out.push(scrub(raw)); continue; }
      const fn = (m[1] || m[2] || '').trim() || '(anonymous)';
      const url = m[3], line = +m[4], col = +m[5];
      let fr = null;
      if (/\/app\.js(\?|$)/.test(url)) {
        const vm = /[?&]v=([\w-]+)/.exec(url);
        fr = this._mapApp(line, col, vm ? vm[1] : v);
      } else if (this.root && url.startsWith(this.root)) {
        const rel = path.relative(this.root, url).split(path.sep).join('/');
        fr = { file: rel, line, col, code: this._codeLine(rel, line) };
      } else if (/^(node:|internal\/)/.test(url)) {
        fr = { file: url, line, col, code: '' };
      } else if (/\/vendor\//.test(url)) {
        fr = { file: url.replace(/^.*\/vendor\//, 'public/vendor/').replace(/\?.*$/, ''), line, col, code: '' };
      }
      if (fr) { frames.push({ fn, ...fr }); out.push(`    at ${fn} (${fr.file}:${fr.line}:${fr.col})${fr.code ? '\n        > ' + fr.code : ''}`); }
      else out.push(scrub(raw));
    }
    return { stack: out.join('\n'), frames };
  }

  // ------------------------------------------------------------ receiving
  /** Too many reports from one place: drop the rest for a while. */
  allowed(ip) {
    const now = Date.now();
    if (now - this.hour.at > 3600e3) this.hour = { at: now, n: 0 };
    if (++this.hour.n > 2000) return false;
    let r = this.rate.get(ip);
    if (!r || now - r.at > 60e3) { r = { at: now, n: 0 }; this.rate.set(ip, r); }
    if (this.rate.size > 500) this.rate.delete(this.rate.keys().next().value);
    return ++r.n <= 40;
  }

  /** A viewer's own reports: at most USER_PER_HOUR an hour from one device and profile. */
  userAllowed(key) {
    const now = Date.now();
    const list = (this.userRate.get(key) || []).filter((t) => now - t < 3600e3);
    if (list.length >= USER_PER_HOUR) { this.userRate.set(key, list); return false; }
    list.push(now);
    this.userRate.delete(key);
    this.userRate.set(key, list);
    if (this.userRate.size > 500) this.userRate.delete(this.userRate.keys().next().value);
    return true;
  }

  /**
   * One report from a device. meta: { device, profile, ip }. Returns the issue (or null when off or not usable).
   * Reports a viewer sent themselves (kind "user") are kept even when automatic collection is off.
   */
  add(rep, meta = {}) {
    if (!rep || typeof rep !== 'object') return null;
    const kind = KINDS[rep.kind] ? rep.kind : 'error';
    if (!this.on && kind !== 'user') return null;
    if (kind === 'user' && !this.userAllowed(`${meta.ip || ''}|${meta.profile || ''}`)) return null;
    const v = clip(String(rep.v || ''), 20);
    const message = clip(scrub(rep.message || rep.name || 'Unknown error'), 1000);
    const mapped = this.mapStack(clip(String(rep.stack || ''), 12000), v);
    // A source position without a stack (old browsers, "error" events): map that too.
    let where = mapped.frames.find((f) => !/^(public\/vendor|node:|internal)/.test(f.file)) || null;
    if (!where && rep.source && rep.source.line) {
      const s = rep.source;
      where = /\/app\.js/.test(s.file || '') ? this._mapApp(+s.line, +s.col || 0, v) : { file: clip(scrub(s.file || ''), 200), line: +s.line, col: +s.col || 0, code: '' };
      if (where) where.fn = '';
    }
    const extra = clean(rep.extra, 0, 600) || {};
    if (kind === 'user' && extra.note) extra.note = scrubNote(extra.note);
    let fp;
    // Each viewer's report is its own issue, so no note is lost among others.
    if (kind === 'user') fp = ['user', Date.now(), crypto.randomBytes(6).toString('hex')].join('|');
    else if (kind === 'playback') fp = ['playback', normMsg(message), (extra.attempts || []).map((a) => a && a.via).join('>')].join('|');
    else if (kind === 'resource') fp = ['resource', normMsg(message)].join('|');
    else fp = [kind === 'rejection' || kind === 'console' ? 'error' : kind, normMsg(message), where ? `${where.file}:${where.fn || where.line}` : ''].join('|');
    const sample = {
      at: Date.now(), clientAt: Number(rep.at) || 0, v, server: this.version, kind,
      device: clip(meta.device || '', 80), profile: clip(meta.profile || '', 60),
      message, name: clip(scrub(rep.name || ''), 80), stack: clip(mapped.stack, 9000), where,
      page: clip(scrub(rep.page || ''), 200), count: Math.max(1, Math.min(10000, Number(rep.count) || 1)),
      ctx: clean(rep.ctx, 0, 300) || {}, extra, crumbs: (Array.isArray(rep.crumbs) ? rep.crumbs.slice(-60) : []).map((c) => clean(c, 1, 300)),
    };
    return this._record(fp, kind, message, where, sample, meta);
  }

  /** A server error (a request that failed with a 500, or an exception nothing caught). meta: { method, path, profile, device, where } */
  addServer(err, meta = {}) {
    if (!this.on) return null;
    try {
      const message = clip(scrub((err && err.message) || String(err)), 1000);
      const mapped = this.mapStack(String((err && err.stack) || ''), '');
      const where = mapped.frames.find((f) => !/^(node:|internal)/.test(f.file)) || null;
      const fp = ['server', normMsg(message), where ? `${where.file}:${where.fn || where.line}` : ''].join('|');
      const sample = {
        at: Date.now(), v: this.current || '', server: this.version, kind: 'server', device: clip(meta.device || '', 80), profile: clip(meta.profile || '', 60),
        message, name: clip((err && err.name) || '', 80), stack: clip(mapped.stack, 9000), where, page: clip(scrub(meta.path ? `${meta.method || ''} ${meta.path}` : meta.where || ''), 200), count: 1,
        ctx: { node: process.version, platform: process.platform, uptime: Math.round(process.uptime()), rss: process.memoryUsage().rss }, extra: {}, crumbs: [],
      };
      return this._record(fp, 'server', message, where, sample, meta);
    } catch { return null; }
  }

  _record(fp, kind, message, where, sample, meta) {
    const issues = this.store.data.issues;
    const id = crypto.createHash('sha1').update(fp).digest('hex').slice(0, 10);
    let is = issues.find((x) => x.id === id);
    const fresh = !is;
    if (!is) {
      is = { id, kind, title: message, where: where ? `${where.file}:${where.line}${where.fn ? ' in ' + where.fn : ''}` : '', first: sample.at, last: sample.at, count: 0, devices: {}, versions: [], items: {}, status: 'open', samples: [] };
      issues.push(is);
    }
    // What the viewer said, kept on the issue so the list can show it.
    if (kind === 'user') { const ex = sample.extra || {}; is.choice = clip(ex.choiceLabel || ex.choice || '', 80); is.note = clip(ex.note || '', 600); }
    // Marked fixed, but it happened again on a newer version of the app: open again.
    let back = false;
    if (is.status === 'fixed' && (!is.fixedV || sample.v !== is.fixedV || kind === 'server')) { is.status = 'open'; is.reopened = (is.reopened || 0) + 1; back = true; }
    is.last = sample.at;
    is.count += sample.count;
    is.title = message;
    if (where) is.where = `${where.file}:${where.line}${where.fn ? ' in ' + where.fn : ''}`;
    const dev = sample.device || 'unknown device';
    if (is.devices[dev] !== undefined || Object.keys(is.devices).length < 20) is.devices[dev] = (is.devices[dev] || 0) + sample.count;
    if (sample.v && !is.versions.includes(sample.v)) { is.versions.push(sample.v); if (is.versions.length > 6) is.versions.shift(); }
    const item = sample.extra && sample.extra.item && sample.extra.item.n;
    if (item && (is.items[item] !== undefined || Object.keys(is.items).length < 30)) is.items[item] = (is.items[item] || 0) + 1;
    is.samples.unshift(sample);
    if (is.samples.length > MAX_SAMPLES) is.samples.length = MAX_SAMPLES;
    if (issues.length > MAX_ISSUES) {
      issues.sort((a, b) => (a.status === 'fixed') - (b.status === 'fixed') || b.last - a.last);
      issues.length = MAX_ISSUES;
    }
    this.store.save();
    this._writeText();
    if (fresh || back) this.log(`Error report (${fresh ? 'new' : 'back again'}): ${KINDS[kind] || kind} — ${clip(message, 160)}${is.where ? ` — at ${is.where}` : ''} (${dev}). Details: Admin → Error reports, or data/error-reports.txt`);
    return is;
  }

  // ------------------------------------------------------------ looking at them
  summary() { const open = this.store.data.issues.filter((x) => x.status === 'open'); return { on: this.on, open: open.length, last: open.reduce((m, x) => Math.max(m, x.last), 0) }; }
  list() {
    return this.store.data.issues.slice().sort((a, b) => b.last - a.last).map((x) => ({ ...x, samples: undefined, sample: x.samples[0], label: KINDS[x.kind] || x.kind }));
  }
  get(id) { return this.store.data.issues.find((x) => x.id === id) || null; }
  setStatus(id, status) {
    const is = this.get(id);
    if (!is) return null;
    is.status = status === 'fixed' ? 'fixed' : 'open';
    is.fixedAt = is.status === 'fixed' ? Date.now() : undefined;
    is.fixedV = is.status === 'fixed' ? this.current || '' : undefined;
    this.store.save(); this._writeText();
    return is;
  }
  remove(id) { const a = this.store.data.issues; const i = a.findIndex((x) => x.id === id); if (i >= 0) a.splice(i, 1); this.store.save(); this._writeText(); return i >= 0; }
  clear(which = 'all') { this.store.data.issues = which === 'fixed' ? this.store.data.issues.filter((x) => x.status !== 'fixed') : []; this.store.save(); this._writeText(); }

  /** Plain text of the issues (newest first) — for pasting into a bug report or a chat. */
  text(issues, { samples = 2 } = {}) {
    issues = issues || this.list().filter((x) => x.status === 'open');
    const when = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '');
    const lines = [`Error reports — ${issues.length} issue${issues.length === 1 ? '' : 's'} · server ${this.version} · app ${this.current || '?'} · written ${when(Date.now())}`, ''];
    for (const x of issues) {
      const is = x.samples ? x : this.get(x.id) || x;
      lines.push('='.repeat(100));
      lines.push(`[${is.id}] ${KINDS[is.kind] || is.kind}: ${is.title}`);
      if (is.kind === 'user') { lines.push(`Viewer chose: ${is.choice || '?'}`); lines.push(`Viewer’s note: ${is.note ? is.note.replace(/\s*\n\s*/g, ' / ') : '(none)'}`); }
      lines.push(`Status: ${is.status}${is.reopened ? ` (came back ${is.reopened}×)` : ''} · ${is.count}× · first ${when(is.first)} · last ${when(is.last)}`);
      if (is.where) lines.push(`Where: ${is.where}`);
      lines.push(`Devices: ${Object.entries(is.devices || {}).map(([d, n]) => `${d} (${n})`).join(', ')}`);
      lines.push(`App versions: ${(is.versions || []).join(', ')}`);
      if (Object.keys(is.items || {}).length) lines.push(`Titles: ${Object.entries(is.items).map(([n, c]) => `${n} (${c})`).join(', ')}`);
      for (const s of (is.samples || []).slice(0, samples)) {
        lines.push('-'.repeat(100));
        lines.push(`${when(s.at)} · ${s.device}${s.profile ? ' · profile ' + s.profile : ''} · app ${s.v || '?'} · server ${s.server}${s.count > 1 ? ` · ${s.count}× on this page` : ''}`);
        if (s.page) lines.push(`Page: ${s.page}`);
        lines.push(`Message: ${s.name && !s.message.startsWith(s.name) ? s.name + ': ' : ''}${s.message}`);
        if (s.stack) lines.push('Stack:', s.stack);
        else if (s.where) lines.push(`At: ${s.where.file}:${s.where.line}:${s.where.col}${s.where.code ? '\n        > ' + s.where.code : ''}`);
        if (s.extra && Object.keys(s.extra).length) lines.push('Details: ' + JSON.stringify(s.extra, null, 1).replace(/\n\s*/g, ' '));
        if (s.ctx && s.ctx.player) lines.push('Player: ' + JSON.stringify(s.ctx.player).replace(/\n\s*/g, ' '));
        if (s.ctx) { const c = { ...s.ctx }; delete c.player; lines.push('Device: ' + JSON.stringify(c)); }
        if (s.crumbs && s.crumbs.length) { lines.push('Before it (oldest first; seconds before the error):'); for (const c of s.crumbs) lines.push(`  -${((c && c.t) / 1000 || 0).toFixed(1)}s ${c && c.k}: ${c && c.m}`); }
      }
      lines.push('');
    }
    return lines.join('\n');
  }
  _writeText() {
    clearTimeout(this._tt);
    this._tt = setTimeout(() => {
      try { const tmp = this.txtFile + '.tmp'; fs.writeFileSync(tmp, this.text(null, { samples: 3 })); fs.renameSync(tmp, this.txtFile); } catch {}
    }, 3000);
    if (this._tt.unref) this._tt.unref();
  }

  /** The routes: POST /api/client-errors (any signed-in device) and the admin's. */
  install({ route, requireAdmin, readBody, HttpError, clientIp }) {
    route('POST', '/api/client-errors', async (req, res, p, q, ctx) => {
      const buf = await readBody(req, 256 * 1024);
      let b;
      try { b = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON body'); }
      let reps = Array.isArray(b.reports) ? b.reports.slice(0, 20) : [];
      // Off: only what a viewer reported themselves.
      if (!this.on) { reps = reps.filter((r) => r && r.kind === 'user'); if (!reps.length) return { ok: true, off: true }; }
      if (!this.allowed(clientIp(req))) return { ok: false, slow: true };
      const meta = { device: (ctx.sess && ctx.sess.name) || '', profile: (ctx.profile && ctx.profile.name) || '', ip: clientIp(req) };
      let n = 0;
      for (const r of reps) if (this.add(r, meta)) n++;
      return { ok: true, n };
    }, 'site');
    route('GET', '/api/admin/errors', (req, res, p, q, ctx) => { requireAdmin(ctx); return { on: this.on, issues: this.list(), kinds: KINDS, current: this.current || '' }; });
    route('GET', '/api/admin/errors/:id', (req, res, p, q, ctx) => { requireAdmin(ctx); const is = this.get(p.id); if (!is) throw new HttpError(404, 'Not found'); return { ...is, label: KINDS[is.kind] || is.kind, text: this.text([is], { samples: MAX_SAMPLES }) }; });
    route('GET', '/api/admin/errors-report.txt', (req, res, p, q, ctx) => {
      requireAdmin(ctx);
      const all = this.list();
      const pick = q.get('all') === '1' ? all : all.filter((x) => x.status === 'open');
      const body = Buffer.from(this.text(pick, { samples: 3 }));
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Content-Disposition': `attachment; filename="error-reports-${new Date().toISOString().slice(0, 10)}.txt"`, 'Cache-Control': 'no-store' });
      res.end(body);
    });
    route('PUT', '/api/admin/errors/:id', async (req, res, p, q, ctx) => {
      requireAdmin(ctx);
      const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}');
      const is = this.setStatus(p.id, b.status);
      if (!is) throw new HttpError(404, 'Not found');
      return { ok: true, status: is.status };
    });
    route('DELETE', '/api/admin/errors/:id', (req, res, p, q, ctx) => { requireAdmin(ctx); if (p.id === 'all' || p.id === 'fixed') this.clear(p.id); else this.remove(p.id); return { ok: true }; });
    route('PUT', '/api/admin/errors-settings', async (req, res, p, q, ctx) => {
      requireAdmin(ctx);
      const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}');
      if ('on' in b) this.on = !!b.on;
      return { on: this.on };
    });
  }
}

module.exports = { ErrorReports, scrub, scrubNote, normMsg, KINDS };
