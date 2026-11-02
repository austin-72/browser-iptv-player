// The stream relay (relay/relay.js, run on a small internet machine): viewers' devices fetch "direct" streams through
// it instead of straight from the provider, so the provider only sees the relay's address and this server carries
// none of the video. This side signs the addresses the relay will accept (Admin → Network & proxies → Stream relay).
const crypto = require('crypto');

const TTL = 12 * 3600; // seconds an address stays valid (a device asks again when it reconnects)

const sigOf = (secret, token) => crypto.createHmac('sha256', secret).update(token).digest('base64url').slice(0, 32);
const newSecret = () => crypto.randomBytes(24).toString('base64url');
const keyOf = (secret) => crypto.createHash('sha256').update('relay-key:' + secret).digest();

/**
 * A relay address for a provider address (and the headers the provider needs). The provider's address, headers and
 * an expiry are encrypted and sealed (AES-256-GCM) with a key made from the secret, so devices can't read the
 * provider's address or login, and only the relay can open it.
 */
function relayUrl(base, secret, url, headers = {}, ttl = TTL) {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) if (/^[A-Za-z0-9-]+$/.test(k) && v != null && !/[\r\n]/.test(String(v))) h[k] = String(v);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([c.update(JSON.stringify({ u: url, h, e: Math.floor(Date.now() / 1000) + ttl }), 'utf8'), c.final()]);
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
    return { ok: true, version: j.version, streams: j.streams, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: `Couldn’t reach ${u.split('/check')[0]} (${(e.cause && e.cause.code) || e.message}). Check the address, that the relay is running, and that its port is open.` };
  }
}

/**
 * The rules. getSettings() → { relay: { url, secret, all } }; listOf(id) → the list ({ relay: ''|'on'|'off' }).
 * A list uses the relay when it's set up and the list says "on", or says nothing and "every list" is on.
 */
function makeRelay({ getSettings, listOf }) {
  const conf = () => { const r = getSettings().relay || {}; return r.url && r.secret ? r : null; };
  const uses = (listId) => {
    const r = conf();
    if (!r || !listId) return false;
    const l = listOf(listId);
    const mode = (l && l.relay) || '';
    return mode === 'on' || (mode !== 'off' && !!r.all);
  };
  const wrap = (url, headers) => { const r = conf(); return r ? relayUrl(r.url, r.secret, url, headers) : url; };
  return { conf, uses, wrap };
}

module.exports = { relayUrl, testRelay, makeRelay, newSecret, TTL };
