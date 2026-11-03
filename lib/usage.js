'use strict';
/**
 * Which provider connections the household is using right now, per list: { listId: [viewer, …] }.
 * A viewer is a live connection (a browser tab) with what it's playing; each multiview tile counts as a viewer of its
 * own (same shape, `tile: true`), and a watch party sharing one connection (lib/fanout.js) counts once.
 * listOf(k, alt) → list id of that copy, or ''; sharedPartyOf(conn) → party id when it watches its party's shared stream;
 * freed(playing) → true when that play no longer holds a provider connection (the stream relay has the whole film).
 * pooled(playing) → true when that play is a film the stream relay fetches whole: the relay shares the account's
 * connections between all of those (it's told how many it may use), so together they count once — as one entry with
 * `relayShared: true` and the devices in `viewers`.
 */
function listUsage(conns, { listOf, sharedPartyOf, freed, pooled }) {
  const use = new Map();
  const shared = new Set();
  const pools = new Map();
  const add = (c, pl, tile) => {
    if (!pl || !pl.k) return;
    if (freed && freed(pl)) return;
    const l = listOf(pl.k, Number.isInteger(pl.alt) ? pl.alt : -1);
    if (!l) return;
    if (!tile && sharedPartyOf) {
      const party = sharedPartyOf(c);
      if (party) { if (shared.has(l + '|' + party)) return; shared.add(l + '|' + party); }
    }
    if (pooled && pooled(pl)) {
      const p = pools.get(l);
      if (p) { p.viewers.push(c.id); return; }
      const e = { id: c.id, pid: c.pid, deviceName: c.deviceName, playing: pl, tile: !!tile, relayShared: true, viewers: [c.id] };
      pools.set(l, e);
      (use.get(l) || use.set(l, []).get(l)).push(e);
      return;
    }
    (use.get(l) || use.set(l, []).get(l)).push(tile ? { id: c.id, pid: c.pid, deviceName: c.deviceName, playing: pl, tile: true } : c);
  };
  for (const c of conns) {
    add(c, c.playing, false);
    for (const t of c.multi || []) add(c, t, true);
  }
  return use;
}
module.exports = { listUsage };
