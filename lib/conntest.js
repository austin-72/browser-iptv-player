'use strict';
const { fetchAny } = require('./net');
const { HttpError } = require('./util');

/**
 * "How many streams can this list play at once?" — measured, not taken from what the provider claims.
 *
 * For each kind (live TV, TV shows, movies) the server opens one stream, then a second while the first keeps playing,
 * then a third… up to 6. Each one has to start sending video, and every earlier one has to keep going. It stops at
 * the first stream the provider refuses (403, 509, closes it, sends nothing) or the first time opening a new one cuts
 * an older one off (some providers let the newest in and drop the oldest).
 *
 * A stream that won't start could just be a dead channel, so a refused stream is tried again with one that's known
 * to work (the first one) before it counts as the limit. The kinds run one after another with a pause between, so
 * the provider has let go of the last kind's connections. Requests go through the list's proxy like playback does.
 */

const MAX = 6;
const OPEN_MS = 15000; // a stream must start within this
const READY_BYTES = 64 * 1024; // …and send this much
const VOD_RATE = 300; // bytes per ms (~300 KB/s) a movie is read at after its first 1.5 MB, so the test doesn't download whole films
const KINDS = [['live', 'Live TV'], ['show', 'TV shows'], ['movie', 'Movies']];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deferred() { let resolve; const p = new Promise((r) => { resolve = r; }); p.resolve = resolve; return p; }

/** A plain description of why a stream didn't start. */
function whyCode(code) {
  if (code === 401 || code === 403) return `refused (HTTP ${code})`;
  if (code === 404) return 'not found (HTTP 404) — maybe a dead link';
  if (code === 429) return 'refused: too many requests (HTTP 429)';
  if (code === 456 || code === 458 || code === 509) return `refused: connection limit (HTTP ${code})`;
  return `HTTP ${code}`;
}
function whyErr(e) {
  if (e && e.name === 'AbortError') return 'nothing arrived in time';
  const m = String((e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || e);
  if (/ECONNRESET|socket hang up|terminated|other side closed/i.test(m)) return 'the provider closed the connection';
  if (/ECONNREFUSED/.test(m)) return 'the provider refused to connect';
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'the provider’s address couldn’t be found';
  if (/timed? ?out|ETIMEDOUT/i.test(m)) return 'timed out';
  return m.slice(0, 120);
}

const MAX_LIST = 2 * 1024 * 1024; // a playlist bigger than this isn't one (a provider sending without end)
const MAX_SEG = 32 * 1024 * 1024;

/**
 * A response's body, at most `max` bytes: past that the rest is cancelled and it fails, so a provider that never stops
 * sending can't fill the memory (r.text() and r.arrayBuffer() read without limit).
 */
async function readCapped(r, max = MAX_LIST) {
  if (!r.body) return Buffer.alloc(0);
  const reader = r.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { reader.cancel().catch(() => {}); throw new Error('The provider sent far more than expected'); }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

/** Address list of an HLS playlist: { variants: [{url, bw}], segs: [url], seq, target, end }. */
function parseHls(text, base) {
  const lines = String(text).split(/\r?\n/).map((s) => s.trim());
  const out = { variants: [], segs: [], seq: 0, target: 6, end: false };
  let bw = null;
  for (const ln of lines) {
    if (!ln) continue;
    if (ln.startsWith('#EXT-X-STREAM-INF')) { const m = /BANDWIDTH=(\d+)/.exec(ln); bw = m ? +m[1] : 0; continue; }
    if (ln.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { out.seq = parseInt(ln.slice(22), 10) || 0; continue; }
    if (ln.startsWith('#EXT-X-TARGETDURATION:')) { out.target = Math.max(1, parseFloat(ln.slice(22)) || 6); continue; }
    if (ln.startsWith('#EXT-X-ENDLIST')) { out.end = true; continue; }
    if (ln.startsWith('#')) continue;
    let u;
    try { u = new URL(ln, base).href; } catch { continue; }
    if (bw !== null) { out.variants.push({ url: u, bw }); bw = null; } else out.segs.push(u);
  }
  return out;
}

/**
 * One test connection. `ready` resolves to { ok, why, code } once the stream has really started (or failed to);
 * after that `alive()` says whether it's still going.
 */
function openConn(url, headers, live) {
  const ac = new AbortController();
  const ready = deferred();
  const c = { url, bytes: 0, last: 0, stall: 9000, ended: false, complete: false, err: '', closed: false };
  /**
   * Reads whatever is waiting, fast. A movie is read slowly, so an end the provider sent (cutting it off) sits behind
   * megabytes of video still to read; this catches up so the check sees it. Resolves when caught up (or after `ms`).
   */
  c.drain = async (ms = 3000) => {
    if (live || c.complete) return;
    const until = Date.now() + ms;
    c.fastUntil = until;
    c.drainLeft = 16e6; // (at most this much: on a very fast line it never quite "catches up")
    while (c.fastUntil && Date.now() < until && !c.closed && !c.err && !c.ended) await sleep(50);
    c.fastUntil = 0;
  };
  c.close = () => { c.closed = true; ready.resolve({ ok: false, why: 'stopped' }); try { ac.abort(); } catch {} };
  c.alive = () => !c.closed && !c.err && (c.complete || (!c.ended && Date.now() - c.last < c.stall));
  c.why = () => c.err || (c.ended ? 'the provider closed the connection' : 'stopped sending video');
  const fail = (why, code) => { if (!c.closed && !c.err) c.err = why; ready.resolve({ ok: false, why, code }); };
  const got = (n) => { c.bytes += n; c.last = Date.now(); if (c.bytes >= READY_BYTES) ready.resolve({ ok: true }); };
  const timer = setTimeout(() => { if (c.bytes < READY_BYTES && !c.complete) { fail(c.bytes ? 'started, then stopped sending video' : 'nothing arrived within 15 seconds'); ac.abort(); } }, OPEN_MS);
  ready.then(() => clearTimeout(timer));

  const get = (u) => fetchAny(u, { headers, signal: ac.signal, redirect: 'follow' });

  // A single long download (MPEG-TS channels, movie files).
  const progressive = async (res, reader, first) => {
    const len = parseInt(res.headers.get('content-length'), 10) || 0;
    const t0 = Date.now();
    got(first.length);
    for (;;) {
      const r0 = Date.now();
      const { done, value } = await reader.read();
      // Catching up (see drain): a read that had to wait means everything already sent has been read.
      if (c.fastUntil && (Date.now() - r0 >= 25 || (c.drainLeft -= (value ? value.length : 0)) <= 0)) c.fastUntil = 0;
      if (done) {
        // A (small) file that came to its end isn't a cut-off connection.
        if (!live && (!len || c.bytes >= len) && c.bytes >= READY_BYTES) { c.complete = true; ready.resolve({ ok: true }); } else { c.ended = true; fail('the provider closed the connection'); }
        return;
      }
      got(value.length);
      if (!live && !(c.fastUntil > Date.now())) { c.fastUntil = 0; const allowed = 1.5e6 + (Date.now() - t0) * VOD_RATE; if (c.bytes > allowed) await sleep(Math.min(1500, (c.bytes - allowed) / VOD_RATE)); }
    }
  };

  // HLS: keeps fetching the playlist and its newest segment, like a player would.
  const hls = async (text, base) => {
    let pl = parseHls(text, base);
    if (pl.variants.length) {
      const v = pl.variants.slice().sort((a, b) => a.bw - b.bw)[0]; // the smallest copy
      const r = await get(v.url);
      if (!r.ok) { try { r.body && r.body.cancel().catch(() => {}); } catch {} return fail(whyCode(r.status), r.status); }
      base = r.url || v.url;
      pl = parseHls((await readCapped(r)).toString('utf8'), base);
    }
    c.stall = Math.max(12000, pl.target * 2500);
    let next = pl.end ? pl.seq : pl.seq + Math.max(0, pl.segs.length - 2); // movies from the start, live near the edge
    let lastList = Date.now();
    while (!c.closed) {
      const i = next - pl.seq;
      if (i >= 0 && i < pl.segs.length) {
        const r = await get(pl.segs[i]);
        if (!r.ok) { try { r.body && r.body.cancel().catch(() => {}); } catch {} return fail(whyCode(r.status), r.status); }
        const b = await readCapped(r, MAX_SEG);
        got(b.length);
        ready.resolve({ ok: true }); // one whole segment = it plays
        next++;
        if (pl.end && next - pl.seq >= pl.segs.length) { c.complete = true; return; }
        await sleep(pl.end ? pl.target * 1000 : 300);
        continue;
      }
      if (pl.end) { c.complete = true; return; }
      if (i < 0) next = pl.seq + Math.max(0, pl.segs.length - 2); // fell behind the live window
      // Live: read the playlist again for new segments.
      await sleep(Math.max(0, Math.min(pl.target * 1000, 4000) - (Date.now() - lastList)));
      const r = await get(base);
      lastList = Date.now();
      if (!r.ok) { try { r.body && r.body.cancel().catch(() => {}); } catch {} return fail(whyCode(r.status), r.status); }
      pl = parseHls((await readCapped(r)).toString('utf8'), base);
    }
  };

  (async () => {
    try {
      const res = await get(url);
      if (!res.ok) { try { res.body && res.body.cancel().catch(() => {}); } catch {} return fail(whyCode(res.status), res.status); }
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const reader = res.body.getReader();
      const first = await reader.read();
      if (first.done || !first.value || !first.value.length) { c.ended = true; return fail('the provider sent nothing and closed the connection'); }
      const head = Buffer.from(first.value);
      if (ct.includes('mpegurl') || head.slice(0, 64).toString('latin1').replace(/^﻿|^ï»¿/, '').trimStart().startsWith('#EXTM3U')) {
        const parts = [head];
        for (;;) { const r = await reader.read(); if (r.done) break; parts.push(Buffer.from(r.value)); if (parts.length > 400) break; }
        return await hls(Buffer.concat(parts).toString('utf8'), res.url || url);
      }
      // A short text answer instead of video ("Max connections reached", a JSON error…).
      if (/^(text\/(html|plain)|application\/json)/.test(ct) && head.length < 4096) {
        const r = await reader.read().catch(() => ({ done: true }));
        if (r.done) { c.ended = true; return fail('the provider answered with a message instead of video: “' + head.toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) + '”'); }
        got(head.length);
        return await progressive(res, reader, Buffer.from(r.value));
      }
      await progressive(res, reader, head);
    } catch (e) {
      if (!c.closed) fail(whyErr(e));
    }
  })();
  c.ready = ready;
  return c;
}

class ConnTest {
  /**
   * lists, catalog: the server's. headers(h): request headers for a stream (User-Agent etc.).
   * usage(listId): streams the household is playing from that list right now.
   */
  constructor({ lists, catalog, headers, usage, log, timing, via }) {
    Object.assign(this, { lists, catalog, headers, usage, via, log: log || (() => {}) });
    // How long each new stream runs before checking the others (and the pause between kinds). Tests shorten them.
    this.timing = { live: 5000, vod: 3500, pause: 6000, ...(timing || {}) };
    this.jobs = new Map(); // listId -> job
  }

  status(listId) {
    const j = this.jobs.get(listId);
    if (!j) return null;
    const { conns, ...out } = j;
    return out;
  }
  running() { for (const j of this.jobs.values()) if (j.running) return j; return null; }

  start(listId, opts = {}) {
    const l = this.lists.get(listId);
    if (l.type === 'folder') throw new HttpError(400, 'Folders on the server have no connection limit.');
    const busy = this.running();
    if (busy) throw new HttpError(409, busy.list === listId ? 'That test is already running.' : `Another test is running (“${busy.name}”). Try again when it’s done.`);
    const kinds = KINDS.filter(([k]) => !opts.kinds || opts.kinds.includes(k));
    const job = {
      list: listId, name: l.name, running: true, startedAt: Date.now(), endedAt: 0, already: (this.usage(listId) || []).length, max: MAX,
      kinds: kinds.map(([k, label]) => ({ k, label, state: 'waiting', steps: [], max: null, limited: false, how: '', why: '', note: '' })),
      log: [], conns: [],
    };
    this.jobs.set(listId, job);
    this._run(job, l).catch((e) => { job.error = e.message; }).finally(() => {
      job.running = false; job.endedAt = Date.now();
      for (const c of job.conns) c.close();
      job.conns = [];
    });
    return this.status(listId);
  }

  stop(listId) {
    const j = this.jobs.get(listId);
    if (j && j.running) { j.cancelled = true; for (const c of j.conns) c.close(); }
    return this.status(listId);
  }

  _say(job, text) { job.log.push({ at: Date.now(), text }); if (job.log.length > 200) job.log.shift(); }

  /** A few things of one kind to test with, from this list (its own entries, or backup copies it supplies). */
  async _pick(l, kind) {
    const out = [], groups = new Map();
    const ok = (u) => /^https?:\/\//i.test(u || '');
    const add = (it, a) => {
      if (!a || !ok(a.u) || out.some((x) => x.url === a.u)) return;
      const g = it.g || '';
      if ((groups.get(g) || 0) >= 2) return; // spread over a few groups (one group of dead channels doesn't decide it)
      groups.set(g, (groups.get(g) || 0) + 1);
      out.push({ name: it.n, url: a.u, h: a.h || {} });
    };
    const mine = (it) => (it.src === l.id ? { u: it.u, h: it.h } : (it.alts || []).find((x) => x.l === l.id) || null);
    const items = this.catalog.items || [];
    const want = kind === 'live' ? 'live' : kind === 'movie' ? 'movie' : 'episode';
    for (let i = 0; i < items.length && out.length < 8; i++) { const it = items[i]; if (it.t === want) add(it, mine(it)); }
    // Xtream shows list their episodes only when asked: ask for a few shows' episodes.
    if (kind === 'show' && out.length < 3) {
      const shows = [];
      for (let i = 0; i < items.length && shows.length < 5; i++) { const it = items[i]; if (it.t === 'show' && (it.src === l.id || (it.xt && it.xt.l === l.id))) shows.push(it); }
      for (const s of shows) {
        if (out.length >= 6) break;
        try {
          const eps = await this.catalog.episodes(s.k);
          const e = eps.find((x) => x.src === l.id && ok(x.u)) || eps.find((x) => (x.alts || []).some((a) => a.l === l.id));
          if (e) add(e, mine(e));
        } catch (err) { this.log(`Connection test: episodes of “${s.n}”: ${err.message}`); }
      }
    }
    // An Xtream account whose shows are all also in an earlier list (the catalogue keeps that list's episodes):
    // ask the provider for a few of its own.
    if (kind === 'show' && out.length < 2 && l.type === 'xtream') {
      const arr = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []);
      try {
        const cats = arr(await this.lists._xtApi(l, 'get_series_categories')).slice(0, 3);
        for (const cat of cats.length ? cats : [{}]) {
          if (out.length >= 4) break;
          const series = arr(await this.lists._xtApi(l, 'get_series', cat.category_id ? { category_id: cat.category_id } : {})).slice(0, 2);
          for (const sr of series) {
            const data = await this.lists.xtSeries(l.id, sr.series_id);
            const ep = data.episodes[0];
            if (ep) add({ n: `${sr.name || 'Series'} S${ep.season}E${ep.episode}`, g: cat.category_name || '' }, { u: ep.url });
          }
        }
      } catch (err) { this.log(`Connection test: shows of “${l.name}”: ${err.message}`); }
    }
    return out;
  }

  async _provider(l) {
    if (l.type !== 'xtream') return null;
    try {
      const a = await Promise.race([this.lists.accountStatus(l.id, 0), sleep(5000).then(() => null)]);
      return a && a.activeConnections !== '' && a.activeConnections !== undefined ? parseInt(a.activeConnections, 10) : null;
    } catch { return null; }
  }

  async _run(job, l) {
    this._say(job, job.already ? `${job.already} stream${job.already > 1 ? 's' : ''} from this list ${job.already > 1 ? 'are' : 'is'} already playing in the household — they count too.` : 'Nobody in the household is playing anything from this list.');
    for (let ki = 0; ki < job.kinds.length; ki++) {
      if (job.cancelled) break;
      const K = job.kinds[ki];
      if (ki > 0 && job.kinds.slice(0, ki).some((x) => x.steps.length)) {
        // Give the provider time to notice the last kind's streams have closed.
        K.state = 'pausing';
        const until = Date.now() + 20000;
        await sleep(this.timing.pause);
        while (l.type === 'xtream' && Date.now() < until && !job.cancelled) {
          const n = await this._provider(l);
          if (n === null || n <= job.already) break;
          await sleep(2500);
        }
      }
      if (job.cancelled) break;
      await this._kind(job, l, K);
    }
    if (job.cancelled) { this._say(job, 'Stopped.'); for (const K of job.kinds) if (K.state !== 'done' && K.state !== 'skipped' && K.state !== 'error') K.state = 'stopped'; }
    // Keep what was learnt: the "someone else is using it" check uses it.
    const res = { at: Date.now(), already: job.already };
    for (const K of job.kinds) if (K.state === 'done') res[K.k] = { max: K.max, limited: K.limited, how: K.how, why: K.why };
    if (Object.keys(res).length > 2) {
      l.connTest = { ...(l.connTest || {}), ...res };
      this.lists.store.save();
    }
  }

  async _kind(job, l, K) {
    K.state = 'finding';
    const cands = await this._pick(l, K.k);
    if (!cands.length) { K.state = 'skipped'; K.note = `No ${{ live: 'live channels', show: 'TV show episodes', movie: 'movies' }[K.k]} in this list.`; return; }
    K.state = 'running';
    const open = [];
    let known = null;
    const tried = new Set();
    const close = () => { for (const c of open) c.close(); open.length = 0; };
    const tryOne = async (cand, n) => {
      const t0 = Date.now();
      const h = this.headers(cand.h);
      // (Through the stream relay when the list uses it: the provider counts the relay's connections the same way.)
      const via = this.via ? this.via(cand.url, h, l.id) : null;
      const c = openConn(via ? via.url : cand.url, via ? via.headers : h, K.k === 'live');
      job.conns.push(c);
      const r = await c.ready;
      const step = { n, name: cand.name, ok: r.ok, why: r.ok ? '' : r.why, code: r.code || 0, ms: Date.now() - t0 };
      K.steps.push(step);
      if (!r.ok) c.close(); else if (job.cancelled) c.close();
      return r.ok ? c : null;
    };
    try {
      for (let n = 1; n <= MAX; n++) {
        if (job.cancelled) return;
        let c = null, used = null;
        // The first stream: try a few until one plays (some channels are just dead).
        // Later ones: something not tried yet (more like a household watching different things), then the one that worked.
        const fresh = cands.find((x) => !tried.has(x));
        const tries = n === 1 ? cands.slice(0, 4) : [fresh, known].filter(Boolean);
        for (let i = 0; i < tries.length && !c && !job.cancelled; i++) {
          if (i && n > 1) this._say(job, `${K.label}: stream ${n} (${tries[i - 1].name}) didn’t start — ${K.steps[K.steps.length - 1].why}. Trying again with one that’s known to work…`);
          tried.add(tries[i]);
          c = await tryOne(tries[i], n);
          if (c) used = tries[i];
        }
        if (job.cancelled) return;
        if (!c) {
          const last = K.steps[K.steps.length - 1];
          if (n === 1) {
            K.state = 'error';
            K.why = `None of the ${tries.length} tried played: ${last.why}.` + (job.already ? ' (Streams already playing in the household may be using every connection.)' : '');
            this._say(job, `${K.label}: ${K.why}`);
            return;
          }
          K.max = n - 1; K.limited = true; K.how = 'refused'; K.why = `Stream ${n} was ${/^refused/.test(last.why) ? '' : 'refused: '}${last.why}.`;
          this._say(job, `${K.label}: ${K.max} at once. ${K.why}`);
          break;
        }
        if (!known) known = used;
        open.push(c);
        this._say(job, `${K.label}: stream ${n} is playing (${K.steps[K.steps.length - 1].name}).`);
        // Let it run a few seconds: a provider that lets the newest in may now drop an older one.
        const [prov] = await Promise.all([this._provider(l), sleep(K.k === 'live' ? this.timing.live : this.timing.vod)]);
        await Promise.all(open.map((x) => x.drain()));
        if (prov !== null) K.steps[K.steps.length - 1].provider = prov;
        if (job.cancelled) return;
        const dead = open.map((x, i) => (x.alive() ? -1 : i)).filter((i) => i >= 0);
        if (dead.length) {
          const step = K.steps[K.steps.length - 1];
          step.ok = false;
          const newest = dead.length === 1 && dead[0] === open.length - 1;
          step.why = newest ? `started, then ${open[dead[0]].why()}` : `cut off stream ${dead.map((i) => i + 1).join(' and ')}`;
          K.max = n - 1; K.limited = true; K.how = newest ? 'dropped' : 'kicks';
          K.why = newest ? `Stream ${n} started, then ${open[dead[0]].why()}.` : `Opening stream ${n} cut off stream ${dead.map((i) => i + 1).join(' and ')} — this provider lets the newest one in and drops an older one.`;
          this._say(job, `${K.label}: ${K.max} at once. ${K.why}`);
          break;
        }
        K.max = n;
      }
      if (!K.limited) this._say(job, `${K.label}: all ${MAX} played at once.`);
      K.state = 'done';
    } finally { close(); }
  }
}
module.exports = { ConnTest, parseHls, readCapped, openConn, KINDS, MAX };
