'use strict';
const { Fanout } = require('./fanout');
const { HttpError } = require('./util');

/**
 * Watch-party streaming (one provider connection shared by the party) and the multiview/party parts of
 * "who is using which connection". Registered from server.js.
 */
module.exports = function p2Routes(d) {
  const { route, requireProfile, readJSON, social, item, inputOf, isUrl, proxy, srcList, connLimit, fetchAny, hooks, stats } = d;
  const fan = new Fanout({
    fetch: fetchAny,
    headers: (t) => proxy.headers({ h: t.h, ua: t.ua, ref: t.ref }),
    onBytes: stats ? (n) => { try { stats.bytes && stats.bytes('relay', n); } catch {} } : null,
  });

  /** Is this connection watching its party's shared stream? (then the party counts as one connection) */
  hooks.sharedPartyOf = (c) => {
    if (!c || !c.playing || !c.playing.k) return null;
    for (const p of social.parties.values()) {
      if (p.share && p.members.has(c.pid) && p.k === c.playing.k && fan.active(p.id)) return p.id;
    }
    return null;
  };
  /** Whether a new party should share one connection: on when the provider's connections are limited. */
  hooks.partyShareDefault = (it) => connLimit(it, -1) > 0;

  // The party's stream, through the server: the first member to ask opens it, everyone else gets the same one.
  route('POST', '/api/party/:id/stream', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const party = social.party(p.id);
    if (!party.members.has(prof.id)) throw new HttpError(403, 'Join the party first.');
    if (!party.share) throw new HttpError(409, 'This party isn’t sharing a connection.');
    const b = (await readJSON(req)) || {}; // (a body of `null` counts as empty)
    const it = item(ctx, String(b.k || party.k));
    const have = fan.streamFor(party.id, it.k);
    if (have) return { url: have.url, kind: have.kind };
    const alt = Number.isInteger(b.alt) ? b.alt : -1;
    const src = inputOf(it, alt);
    if (!src || src.local || !isUrl(src.input)) throw new HttpError(409, 'This can’t be shared — everyone plays it themselves.');
    const s = await proxy.sniff(src.input, { h: src.headers });
    const mode = s.kind === 'hls' ? 'pl' : s.kind === 'ts' && !s.finite ? 'ts' : s.kind === 'native' && s.finite ? 'file' : '';
    if (!mode) throw new HttpError(409, 'This format can’t be shared — everyone plays it themselves.');
    const url = fan.sign({ p: party.id, k: it.k, u: src.input, h: src.headers && Object.keys(src.headers).length ? src.headers : undefined, m: mode });
    const kind = mode === 'pl' ? 'hls' : mode === 'ts' ? 'ts' : 'native';
    fan.register(party.id, { k: it.k, url, kind, list: srcList(it, alt) });
    return { url, kind };
  });
  route('GET', '/api/fan', (req, res, p, q) => fan.handle(req, res, q), 'site');

  return { fan };
};
