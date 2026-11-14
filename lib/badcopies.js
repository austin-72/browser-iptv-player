'use strict';
// Copies that play something else: a provider's file under a title that isn't that title (Blippi under "Clifford the
// Big Red Dog", an older film under a new one's name). The admin hides such a copy for everyone (from a viewer's
// report, the player's menu or the error reports); another provider's copy of the title takes its place, and a title
// with no other copy goes from the catalogue (an episode, from its series). Undone in Admin → Languages & content.
const path = require('path');
const crypto = require('crypto');
const { JsonFile } = require('./store');

/**
 * Which copy this is — the provider list and the provider's own number for the file (never the address itself: it
 * holds the account's login), or, for an address without one, a fingerprint of it.
 */
function copyId(listId, type, url) {
  const p = String(url || '').split(/[?#]/)[0];
  const last = p.slice(p.lastIndexOf('/') + 1).replace(/\.\w{1,5}$/, '');
  const t = type === 'episode' ? 'e' : type === 'movie' ? 'm' : String(type || 'x').slice(0, 8);
  if (/^\d{2,}$/.test(last)) return `${listId || ''}:${t}:${last}`;
  return `${listId || ''}:${t}:h${crypto.createHash('sha1').update(p).digest('hex').slice(0, 16)}`;
}

class BadCopies {
  constructor(dataDir) {
    this.store = new JsonFile(path.join(dataDir, 'bad-copies.json'), { list: [] });
    if (!Array.isArray(this.store.data.list)) this.store.data.list = [];
    this._set = null;
  }
  get list() { return this.store.data.list; }
  _ids() { return this._set || (this._set = new Set(this.list.map((x) => x.id))); }
  /** Is this copy hidden? */
  has(listId, type, url) { return this.list.length > 0 && this._ids().has(copyId(listId, type, url)); }
  /** For the catalogue's fingerprint: a change means building it again. */
  sig() { return this.list.map((x) => x.id).sort().join(','); }
  add(entry) {
    const id = copyId(entry.list, entry.t, entry.url);
    const { url, ...rest } = entry; // (the address isn't kept)
    this.store.data.list = this.list.filter((x) => x.id !== id).concat([{ ...rest, id, at: Date.now() }]);
    this._set = null;
    this.store.save();
    return id;
  }
  /** Shows a copy again. → what it was, or null. */
  remove(id) {
    const was = this.list.find((x) => x.id === id);
    if (!was) return null;
    this.store.data.list = this.list.filter((x) => x.id !== id);
    this._set = null;
    this.store.save();
    return was;
  }
}

module.exports = { BadCopies, copyId };
