'use strict';
/**
 * Webhooks: when something happens (playback started, a reminder is due, a provider account is about to run out…)
 * the server POSTs a small JSON message to each URL that asked for that event. Each message is signed:
 *   X-Signature: sha256=<HMAC-SHA256 of the body with the webhook's secret>
 * Failed deliveries are retried (after 30 s, 2 min, 10 min); the last deliveries are kept for Admin to see.
 */
const path = require('path');
const crypto = require('crypto');
const { JsonFile } = require('./store');
const { HttpError, uid, isUrl, log } = require('./util');

const EVENTS = {
  'playback.started': 'Playback started',
  'playback.stopped': 'Playback stopped',
  'profile.signed_in': 'Profile chosen on a device',
  'reminder.due': 'A reminder is due',
  'account.expiring': 'A provider account runs out soon',
  'list.failed': 'A list couldn’t be refreshed',
};
const RETRIES = [30e3, 120e3, 600e3];
const MAX_WAITING = 200; // failed deliveries waiting to be tried again, at most

const sign = (secret, body) => 'sha256=' + crypto.createHmac('sha256', String(secret)).update(body).digest('hex');

class Webhooks {
  /** fetch: the app's fetch; retries: delays between attempts (tests make them short). */
  constructor(dataDir, { fetch, retries = RETRIES } = {}) {
    this.store = new JsonFile(path.join(dataDir, 'webhooks.json'), { hooks: [] });
    this.fetch = fetch;
    this.retries = retries;
    this.log = []; // newest first: { id, hook, event, at, status, ok, attempt, error }
    this.timers = new Set();
  }

  list() { return this.store.data.hooks.map((h) => ({ id: h.id, name: h.name, url: h.url, events: h.events, enabled: h.enabled !== false, secretHint: h.secret ? h.secret.slice(0, 4) + '…' : '', created: h.created })); }

  save(spec, id) {
    if (!spec || typeof spec !== 'object') spec = {};
    const url = String(spec.url || '').trim().slice(0, 2000);
    let host = '';
    try { host = new URL(url).hostname; } catch {} // ("http://" alone passes the first check)
    if (!isUrl(url) || !host) throw new HttpError(400, 'Enter a web address starting with http:// or https://');
    const events = [...new Set((Array.isArray(spec.events) ? spec.events : []).filter((e) => typeof e === 'string' && Object.hasOwn(EVENTS, e)))];
    if (!events.length) throw new HttpError(400, 'Pick at least one event.');
    let h = id && this.store.data.hooks.find((x) => x.id === id);
    if (id && !h) throw new HttpError(404, 'No such webhook');
    if (!h) { h = { id: uid(), secret: crypto.randomBytes(18).toString('base64url'), created: Date.now() }; this.store.data.hooks.push(h); }
    h.name = String(spec.name || '').trim().slice(0, 60) || host;
    h.url = url;
    h.events = events;
    h.enabled = spec.enabled !== false;
    this.store.save();
    return { ...this.list().find((x) => x.id === h.id), secret: id ? undefined : h.secret };
  }

  remove(id) { this.store.data.hooks = this.store.data.hooks.filter((h) => h.id !== id); this.store.save(); }
  secret(id) { const h = this.store.data.hooks.find((x) => x.id === id); if (!h) throw new HttpError(404, 'No such webhook'); return h.secret; }

  /** Sends an event to every webhook that wants it (in the background). */
  emit(event, data) {
    if (!EVENTS[event]) return 0;
    const hooks = this.store.data.hooks.filter((h) => h.enabled !== false && h.events.includes(event));
    const msg = { event, at: new Date().toISOString(), data: data || {} };
    for (const h of hooks) this._deliver(h, msg, 0);
    return hooks.length;
  }

  test(id) {
    const h = this.store.data.hooks.find((x) => x.id === id);
    if (!h) throw new HttpError(404, 'No such webhook');
    return this._deliver(h, { event: 'test', at: new Date().toISOString(), data: { message: 'A test from your IPTV player' } }, 0, true);
  }

  async _deliver(h, msg, attempt, once) {
    const body = JSON.stringify(msg);
    const entry = { id: uid(), hook: h.id, name: h.name, event: msg.event, at: Date.now(), attempt: attempt + 1, status: 0, ok: false, error: '' };
    try {
      const r = await this.fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'BrowserIPTVPlayer-Webhook/1', 'X-Event': msg.event, 'X-Signature': sign(h.secret, body), 'X-Delivery': entry.id }, body, signal: AbortSignal.timeout(10000) });
      entry.status = r.status;
      entry.ok = r.status >= 200 && r.status < 300;
      try { await r.arrayBuffer(); } catch {}
    } catch (e) { entry.error = (e.cause && e.cause.message) || e.message; }
    this.log.unshift(entry);
    if (this.log.length > 60) this.log.length = 60;
    // (Retries wait in timers; while a webhook is down, a busy evening of events could pile up thousands of them.)
    if (!entry.ok && !once && attempt < this.retries.length && this.timers.size < MAX_WAITING) {
      const t = setTimeout(() => { this.timers.delete(t); const cur = this.store.data.hooks.find((x) => x.id === h.id); if (cur && cur.enabled !== false) this._deliver(cur, msg, attempt + 1); }, this.retries[attempt]);
      if (t.unref) t.unref();
      this.timers.add(t);
    } else if (!entry.ok && !once) log(`Webhook “${h.name}” failed for ${msg.event}: ${entry.error || entry.status}`);
    return entry;
  }

  stop() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }
}

module.exports = { Webhooks, EVENTS, sign };
