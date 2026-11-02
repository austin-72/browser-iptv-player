'use strict';
/**
 * The play queue: films, series and episodes a profile has lined up to play one after another. Kept with the rest of
 * the profile's data (userdata.js, field `queue`, next first) so every device of the profile sees the same queue.
 *
 * Changes are sent as small operations (add, play next, remove, move, clear) rather than the whole list, so two
 * devices changing it at the same time don't undo each other.
 */
const { HttpError } = require('./util');

const MAX = 200;
const TYPES = ['movie', 'show', 'episode'];
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

/** A queue entry from what a device sent: { k, t, n, sk }. */
function entry(x) {
  if (!x || typeof x !== 'object' || !x.k) throw new HttpError(400, 'Nothing to add');
  const t = TYPES.includes(x.t) ? x.t : 'movie';
  const e = { k: str(x.k, 300), t, n: str(x.n, 200), at: Date.now() };
  if (t === 'episode' && x.sk) e.sk = str(x.sk, 300);
  return e;
}

/**
 * Applies one change to a queue (returns the new list; the old one isn't changed).
 * op: { op: 'add', item } (to the end) | { op: 'next', item } (to the front) | { op: 'remove', k } |
 *     { op: 'played', k, sk } (it started playing: take it out) | { op: 'move', k, to } (index) or { op: 'move', k, by } (±n) |
 *     { op: 'clear' }
 */
function apply(list, op) {
  let q = Array.isArray(list) ? list.filter((x) => x && x.k) : [];
  const o = op || {};
  switch (o.op) {
    case 'add':
    case 'next': {
      const e = entry(o.item);
      const had = q.find((x) => x.k === e.k);
      q = q.filter((x) => x.k !== e.k);
      if (had) e.at = had.at;
      if (o.op === 'next') q.unshift(e); else q.push(e);
      if (q.length > MAX) throw new HttpError(400, `The queue is full (${MAX}). Remove something first.`);
      return q;
    }
    case 'remove': return q.filter((x) => x.k !== String(o.k));
    case 'played': return q.filter((x) => x.k !== String(o.k) && !(o.sk && x.t === 'show' && x.k === String(o.sk)));
    case 'move': {
      const i = q.findIndex((x) => x.k === String(o.k));
      if (i < 0) return q;
      let to = o.to !== undefined ? Number(o.to) : i + (Number(o.by) || 0);
      if (!Number.isFinite(to)) return q;
      to = Math.max(0, Math.min(q.length - 1, Math.round(to)));
      const [x] = q.splice(i, 1);
      q.splice(to, 0, x);
      return q;
    }
    case 'clear': return [];
    default: throw new HttpError(400, 'Unknown queue change');
  }
}

module.exports = { apply, entry, MAX };
