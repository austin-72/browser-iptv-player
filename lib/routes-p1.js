'use strict';
/**
 * "Open in another app" (VLC, MX Player, Infuse…): an address that app can play without signing in.
 * The provider's own address when it needs nothing special; otherwise a signed link to this server's relay (or to
 * the file, for your own media) that works for 12 hours.
 */
module.exports = function registerP1({ route, requireProfile, readJSON, HttpError, item, inputOf, isUrl, proxy, castSign, siteOrigin, relayOf, srcList, settings }) {
  route('POST', '/api/play/external', async (req, res, p, q, ctx) => {
    requireProfile(ctx);
    const b = await readJSON(req);
    const it = item(ctx, String(b.k || ''));
    if (it.t === 'show') throw new HttpError(400, 'Pick an episode');
    const alt = Number.isInteger(b.alt) ? b.alt : -1;
    const hours = 12;
    const abs = (pathq) => siteOrigin(req) + pathq;
    if (it.loc) return { url: abs(castSign(`/api/local/${it.loc.list}/${it.loc.id}`, hours)), how: 'server', hours };
    const src = inputOf(it, alt);
    if (!src) throw new HttpError(404, 'File not found');
    if (src.local) throw new HttpError(400, 'This file can’t be opened in another app.');
    const a = alt >= 0 && it.alts && it.alts[alt] ? it.alts[alt] : { u: it.u, h: it.h };
    if (!isUrl(a.u || '')) throw new HttpError(400, 'Other apps can’t open this kind of address.');
    const headers = a.h && Object.keys(a.h).length ? a.h : null;
    // Lists whose streams go through the stream relay: the app goes there too (it sends the headers itself).
    // Films and episodes: the relay fetches them whole and plays them from its disk (as for the app's own player).
    if (relayOf && relayOf.uses(srcList(it, alt))) {
      const whole = (it.t === 'movie' || it.t === 'episode') && !/\.m3u8?(\?|$)/i.test(a.u) ? { whole: true, k: it.k, alt, list: srcList(it, alt), len: it.d || 0 } : null;
      return { url: relayOf.wrap(a.u, { ...(settings().userAgent ? { 'User-Agent': settings().userAgent } : {}), ...(headers || {}) }, whole), how: 'relay', hours };
    }
    // Plain web address, no special headers, no proxy: the app can go straight to the provider.
    if (!headers && !src.viaProxy) return { url: a.u, how: 'direct', hours: 0 };
    return { url: abs(castSign(proxy.sign(a.u, { h: headers || {} }), hours)), how: 'server', hours };
  });
};
