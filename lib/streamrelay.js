// The stream relay (relay/relay.js, run on a small internet machine): viewers' devices fetch "direct" streams through
// it instead of straight from the provider, so the provider only sees the relay's address and this server carries
// none of the video. This side signs the addresses the relay will accept (Admin → Network & proxies → Stream relay).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TTL = 12 * 3600; // seconds an address stays valid (a device asks again when it reconnects)

const sigOf = (secret, token) => crypto.createHmac('sha256', secret).update(token).digest('base64url').slice(0, 32);
const newSecret = () => crypto.randomBytes(24).toString('base64url');
const keyOf = (secret) => crypto.createHash('sha256').update('relay-key:' + secret).digest();

/**
 * A relay address for a provider address (and the headers the provider needs). The provider's address, headers and
 * an expiry are encrypted and sealed (AES-256-GCM) with a key made from the secret, so devices can't read the
 * provider's address or login, and only the relay can open it.
 */
function relayUrl(base, secret, url, headers = {}, ttl = TTL, extra = null) {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) if (/^[A-Za-z0-9-]+$/.test(k) && v != null && !/[^\t\x20-\x7e\x80-\xff]/.test(String(v))) h[k] = String(v); // (only what a request can carry)
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([c.update(JSON.stringify({ u: url, h, e: Math.floor(Date.now() / 1000) + ttl, ...(extra || {}) }), 'utf8'), c.final()]);
  const token = Buffer.concat([iv, body, c.getAuthTag()]).toString('base64url');
  let name = 'stream';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'stream'); } catch {}
  name = name.replace(/[^\w.-]/g, '_').slice(-80) || 'stream';
  return `${String(base).replace(/\/+$/, '')}/e/${token}/${name}`;
}

/** Asks the relay whether it's there and has the same secret: { ok, version, ms } or { ok: false, error }. */
async function testRelay(base, secret, fetch) {
  const t = String(Math.floor(Date.now() / 1000));
  const u = `${String(base).replace(/\/+$/, '')}/check?t=${t}&s=${sigOf(secret, 'check:' + t)}`;
  const t0 = Date.now();
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => null);
    if (r.status === 403) return { ok: false, error: 'The relay is there, but its secret is different. Copy the secret from here into the relay’s RELAY_SECRET and restart it.' };
    if (!r.ok || !j || !j.ok) return { ok: false, error: `The relay answered HTTP ${r.status}. Is that the relay’s address?` };
    return { ok: true, version: j.version, streams: j.streams, films: j.films || 0, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: `Couldn’t reach ${u.split('/check')[0]} (${(e.cause && e.cause.code) || e.message}). Check the address, that the relay is running, and that its port is open.` };
  }
}

/**
 * Which films the relay has fully on its disk ({ ids, done, here, size, downloading }[]); null when unreachable.
 * opts.budget { account: n } tells it how many provider connections each account's films may share (relay 5);
 * opts.since: also the times it couldn't keep up after that number. opts.full → the whole answer
 * ({ films, accounts, strain, seq, version }).
 */
async function relayDownloads(base, secret, playing, fetch, opts = {}) {
  const t = String(Math.floor(Date.now() / 1000));
  const p = playing.join(',');
  let extra = '';
  if (opts.budget) {
    const b = Object.entries(opts.budget).map(([a, n]) => `${a}:${Math.max(0, Math.floor(n) || 0)}`).join(',');
    extra += `&budget=${encodeURIComponent(b)}&bs=${sigOf(secret, 'budget:' + b + ':' + t)}`;
  }
  if (opts.since !== undefined) extra += `&since=${Math.max(0, Number(opts.since) || 0)}`;
  try {
    const r = await fetch(`${String(base).replace(/\/+$/, '')}/downloads?playing=${encodeURIComponent(p)}&t=${t}&s=${sigOf(secret, 'downloads:' + p + ':' + t)}${extra}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null; // an older relay (no whole films) answers 404
    const j = await r.json();
    if (!j || !Array.isArray(j.films)) return null;
    return opts.full ? { films: j.films, accounts: j.accounts || {}, strain: Array.isArray(j.strain) ? j.strain : [], seq: Number(j.seq) || 0, version: j.version || '' } : j.films;
  } catch { return null; }
}

/** The version of relay.js that comes with this server ('' when it isn't there). */
const RELAY_FILE = path.join(__dirname, '..', 'relay', 'relay.js');
function bundledRelay() {
  try { const code = fs.readFileSync(RELAY_FILE); const v = /const VERSION = '([^']+)'/.exec(code.toString('utf8')); return v ? { version: v[1], code } : null; } catch { return null; }
}
/** Sends this server's relay.js to the relay, which replaces its own and restarts: { ok, from, to } or { ok: false, error }. */
async function updateRelay(base, secret, fetch) {
  const b = bundledRelay();
  if (!b) return { ok: false, error: 'This server doesn’t have relay/relay.js.' };
  const t = String(Math.floor(Date.now() / 1000));
  const sig = sigOf(secret, 'update:' + t + ':' + crypto.createHash('sha256').update(b.code).digest('hex'));
  try {
    const r = await fetch(`${String(base).replace(/\/+$/, '')}/update`, { method: 'POST', body: b.code, headers: { 'Content-Type': 'application/javascript', 'X-Relay-Time': t, 'X-Relay-Sig': sig }, signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => null);
    if (r.status === 404) return { ok: false, error: 'This relay is too old to update itself: it has to be replaced once by hand (see the guide).' };
    if (!j) return { ok: false, error: `The relay answered HTTP ${r.status}.` };
    return j;
  } catch (e) { return { ok: false, error: `Couldn’t reach the relay (${(e.cause && e.cause.code) || e.message}).` }; }
}

/** A short, stable id for one copy of a title being played (the relay reports finished films by it). */
const playId = (k, alt) => crypto.createHash('sha256').update(`${k}|${Number.isInteger(alt) ? alt : -1}`).digest('hex').slice(0, 16);
/** A short id for a provider account (a list), as the relay knows it: its films share that account's connections. */
const acctId = (listId) => crypto.createHash('sha256').update(`acct|${listId}`).digest('hex').slice(0, 12);

/**
 * The rules. getSettings() → { relay: { url, secret, all, proxy } }; listOf(id) → the list ({ relay: ''|'on'|'off' }).
 * A list uses the relay when it's set up and the list says "on", or says nothing and "every list" is on.
 * proxyOf(url) → the proxy the relay should reach that address through ('' = straight from the relay), from the
 * relay's proxy setting: '' none, 'list' each list's own proxy (as this server uses), or one proxy's id. It travels
 * inside the sealed address, so devices never see it.
 */
function makeRelay({ getSettings, listOf, proxyOf = () => '' }) {
  const conf = () => { const r = getSettings().relay || {}; return r.url && r.secret ? r : null; };
  const uses = (listId) => {
    const r = conf();
    if (!r || !listId) return false;
    const l = listOf(listId);
    const mode = (l && l.relay) || '';
    return mode === 'on' || (mode !== 'off' && !!r.all);
  };
  /**
   * opts.whole: a film or episode the relay should fetch whole (opts.k / opts.alt say which, for /downloads; opts.list
   * its list, whose connections its films share; opts.len its length in seconds, for how much is "10 minutes").
   */
  const wrap = (url, headers, opts) => {
    const r = conf();
    if (!r) return url;
    const extra = opts && opts.whole ? { w: 1, i: playId(opts.k, opts.alt) } : {};
    if (opts && opts.whole && opts.list) extra.a = acctId(opts.list);
    if (opts && opts.whole && opts.len > 0) extra.d = Math.round(opts.len);
    let px = '';
    try { px = proxyOf(url) || ''; } catch {}
    if (px) extra.p = px;
    // (opts.ttl: seconds the address stays good — longer for this server's own reading: a recording, a conversion.)
    return relayUrl(r.url, r.secret, url, headers, (opts && opts.ttl) || TTL, Object.keys(extra).length ? extra : null);
  };
  return { conf, uses, wrap };
}

/** Through the relay (and its proxy) to a page that says which address it sees: { ok, ip, ms } or { ok: false, error }. */
async function testRelayProxy(base, secret, proxy, fetch, target = 'https://www.cloudflare.com/cdn-cgi/trace') {
  const t0 = Date.now();
  try {
    const r = await fetch(relayUrl(base, secret, target, {}, 120, proxy ? { p: proxy } : null), { signal: AbortSignal.timeout(25000) });
    const text = await r.text();
    if (!r.ok) return { ok: false, error: r.status === 403 ? 'The relay won’t use that proxy (its address must be on the public internet).' : `Through the relay: ${text.slice(0, 200) || 'HTTP ' + r.status}` };
    const ip = (/^ip=(.+)$/m.exec(text) || [])[1] || '';
    return { ok: true, ip: ip.trim(), ms: Date.now() - t0 };
  } catch (e) { return { ok: false, error: `Couldn’t reach the relay (${(e.cause && e.cause.code) || e.message}).` }; }
}

module.exports = { testRelayProxy, relayUrl, testRelay, relayDownloads, updateRelay, bundledRelay, playId, acctId, makeRelay, newSecret, TTL };
