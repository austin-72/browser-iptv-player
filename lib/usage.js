'use strict';
/**
 * Which provider connections the household is using right now, per list: { listId: [viewer, …] }.
 * A viewer is a live connection (a browser tab) with what it's playing; each multiview tile counts as a viewer of its
 * own (same shape, `tile: true`), and a watch party sharing one connection (lib/fanout.js) counts once.
 * listOf(k, alt) → list id of that copy, or ''; sharedPartyOf(conn) → party id when it watches its party's shared stream.
 */
function listUsage(conns, { listOf, sharedPartyOf }) {
  const use = new Map();
  const shared = new Set();
  const add = (c, pl, tile) => {
    if (!pl || !pl.k) return;
    const l = listOf(pl.k, Number.isInteger(pl.alt) ? pl.alt : -1);
    if (!l) return;
    if (!tile && sharedPartyOf) {
      const party = sharedPartyOf(c);
      if (party) { if (shared.has(l + '|' + party)) return; shared.add(l + '|' + party); }
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
