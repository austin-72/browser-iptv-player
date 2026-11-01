'use strict';
const path = require('path');
const { JsonFile } = require('./store');
const { HttpError, uid } = require('./util');

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🍿', '👀'];

/** Server-sent events: messages, watch-party sync, presence and "play on this device" all go through here. */
class Hub {
  constructor() { this.conns = new Set(); }

  open(req, res, info) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const c = { id: uid(), res, ...info, playing: null, at: Date.now() };
    this.conns.add(c);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 25000);
    const done = () => { clearInterval(ka); this.conns.delete(c); if (this.onClose) this.onClose(c); };
    req.on('close', done);
    res.on('error', done);
    this.send(c, 'hello', { conn: c.id });
    return c;
  }

  send(c, event, data) { try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} }
  toProfile(pid, event, data, except) { for (const c of this.conns) if (c.pid === pid && c.id !== except) this.send(c, event, data); }
  toProfiles(pids, event, data) { const set = new Set(pids); for (const c of this.conns) if (set.has(c.pid)) this.send(c, event, data); }
  toAll(event, data) { for (const c of this.conns) this.send(c, event, data); }
  conn(id) { for (const c of this.conns) if (c.id === id) return c; return null; }
  devices(pid) { return [...this.conns].filter((c) => c.pid === pid).map((c) => ({ conn: c.id, name: c.deviceName, deviceId: c.deviceId, playing: c.playing, at: c.at })); }
  online() { return [...new Set([...this.conns].map((c) => c.pid))]; }
}

/** Messages between profiles, shared watchlists and watch parties. */
class Social {
  constructor(dataDir, { hub, accounts }) {
    this.store = new JsonFile(path.join(dataDir, 'social.json'), { messages: [], lists: [] });
    this.hub = hub;
    this.accounts = accounts;
    this.parties = new Map();
    setInterval(() => this._reapParties(), 60e3).unref();
  }

  get msgs() { return this.store.data.messages; }

  // ------------------------------------------------------------ messages
  /** to: a profile id, or 'all' for the household chat. item: a shared title/channel/episode {k, n, t, i, pos}. */
  send(from, { to, text, item, party }) {
    text = String(text || '').trim().slice(0, 2000);
    if (!text && !item && !party) throw new HttpError(400, 'Write a message first.');
    if (to !== 'all' && !this.accounts.profile(to)) throw new HttpError(404, 'That profile doesn’t exist any more.');
    if (to === from) throw new HttpError(400, 'Pick someone else to send it to.');
    const m = { id: uid(), from, to, text, at: Date.now(), read: [from], reacts: {} };
    if (item && item.k) m.item = { k: String(item.k), n: String(item.n || '').slice(0, 200), t: String(item.t || ''), i: String(item.i || '').slice(0, 1000), pos: Number(item.pos) || 0 };
    if (party) m.party = String(party);
    this.msgs.push(m);
    if (this.msgs.length > 20000) this.msgs.splice(0, this.msgs.length - 20000);
    this.store.save();
    const recipients = to === 'all' ? this.accounts.profiles.map((p) => p.id) : [to, from];
    this.hub.toProfiles(recipients, 'message', m);
    return m;
  }

  conv(m, me) { return m.to === 'all' ? 'all' : m.from === me ? m.to : m.from; }
  visible(m, me) { return m.to === 'all' || m.to === me || m.from === me; }

  /** Conversations for a profile, newest first, with unread counts and the last message. */
  conversations(me) {
    const out = new Map();
    for (const m of this.msgs) {
      if (!this.visible(m, me)) continue;
      const c = this.conv(m, me);
      const e = out.get(c) || { id: c, last: null, unread: 0, count: 0 };
      e.last = m;
      e.count++;
      if (!m.read.includes(me)) e.unread++;
      out.set(c, e);
    }
    return [...out.values()].sort((a, b) => b.last.at - a.last.at);
  }

  thread(me, conv, before = Infinity, limit = 80) {
    const list = this.msgs.filter((m) => this.visible(m, me) && this.conv(m, me) === conv && m.at < before);
    return list.slice(-limit);
  }

  markRead(me, conv) {
    let n = 0;
    for (const m of this.msgs) if (this.visible(m, me) && this.conv(m, me) === conv && !m.read.includes(me)) { m.read.push(me); n++; }
    if (n) { this.store.save(); this.hub.toProfile(me, 'read', { conv }); }
    return n;
  }

  unread(me) { let n = 0; for (const m of this.msgs) if (this.visible(m, me) && !m.read.includes(me)) n++; return n; }

  react(me, id, emoji) {
    const m = this.msgs.find((x) => x.id === id);
    if (!m || !this.visible(m, me)) throw new HttpError(404, 'Message not found');
    if (!REACTIONS.includes(emoji)) throw new HttpError(400, 'Unknown reaction');
    const list = m.reacts[emoji] || [];
    m.reacts[emoji] = list.includes(me) ? list.filter((x) => x !== me) : [...list, me];
    if (!m.reacts[emoji].length) delete m.reacts[emoji];
    this.store.save();
    const recipients = m.to === 'all' ? this.accounts.profiles.map((p) => p.id) : [m.to, m.from];
    this.hub.toProfiles(recipients, 'react', { id, reacts: m.reacts });
    return m;
  }

  removeMessage(me, id, isAdmin) {
    const m = this.msgs.find((x) => x.id === id);
    if (!m) throw new HttpError(404, 'Message not found');
    if (m.from !== me && !isAdmin) throw new HttpError(403, 'You can only delete your own messages.');
    this.store.data.messages = this.msgs.filter((x) => x.id !== id);
    this.store.save();
    const recipients = m.to === 'all' ? this.accounts.profiles.map((p) => p.id) : [m.to, m.from];
    this.hub.toProfiles(recipients, 'unsend', { id });
  }

  forgetProfile(pid) {
    this.store.data.messages = this.msgs.filter((m) => m.from !== pid && m.to !== pid);
    for (const l of this.store.data.lists) { l.items = l.items.filter((i) => i.by !== pid); }
    this.store.data.lists = this.store.data.lists.filter((l) => l.owner !== pid);
    this.store.save();
  }

  // ------------------------------------------------------------ shared watchlists
  lists() { return this.store.data.lists; }
  createList(me, name) {
    name = String(name || '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Name the list.');
    const l = { id: uid(), name, owner: me, items: [], at: Date.now() };
    this.lists().push(l);
    this.store.save();
    this.hub.toAll('lists', {});
    return l;
  }
  editList(me, id, { name, add, remove }, isAdmin) {
    const l = this.lists().find((x) => x.id === id);
    if (!l) throw new HttpError(404, 'List not found');
    if (name !== undefined) {
      if (l.owner !== me && !isAdmin) throw new HttpError(403, 'Only the person who made the list can rename it.');
      l.name = String(name).trim().slice(0, 60) || l.name;
    }
    if (add && add.k && !l.items.some((i) => i.k === add.k)) l.items.unshift({ k: String(add.k), by: me, at: Date.now() });
    if (remove) l.items = l.items.filter((i) => i.k !== remove);
    l.at = Date.now();
    this.store.save();
    this.hub.toAll('lists', {});
    return l;
  }
  removeList(me, id, isAdmin) {
    const l = this.lists().find((x) => x.id === id);
    if (!l) throw new HttpError(404, 'List not found');
    if (l.owner !== me && !isAdmin) throw new HttpError(403, 'Only the person who made the list can delete it.');
    this.store.data.lists = this.lists().filter((x) => x.id !== id);
    this.store.save();
    this.hub.toAll('lists', {});
  }

  // ------------------------------------------------------------ watch parties
  /** Everyone in a party watches the same thing in sync; anyone can play/pause/seek (unless the host locks it). */
  createParty(me, { k, n, t, i, pos, invite, share }) {
    if (!k) throw new HttpError(400, 'Pick something to watch.');
    const p = {
      id: uid(), host: me, k: String(k), n: String(n || '').slice(0, 200), t: String(t || ''), i: String(i || ''), members: new Set([me]),
      state: { playing: false, pos: Number(pos) || 0, rate: 1, at: Date.now(), by: me }, chat: [], hostOnly: false, created: Date.now(), touched: Date.now(),
      // share: the server fetches the stream once and every member gets it from there (one provider connection).
      share: !!share,
    };
    this.parties.set(p.id, p);
    for (const to of (invite || []).filter((x) => x !== me && this.accounts.profile(x))) {
      this.send(me, { to, text: `Join my watch party: ${p.n}`, party: p.id, item: { k: p.k, n: p.n, t: p.t, i: p.i } });
    }
    return this.partyView(p);
  }
  party(id) { const p = this.parties.get(id); if (!p) throw new HttpError(404, 'That watch party has ended.'); return p; }
  partyView(p) {
    return { id: p.id, host: p.host, k: p.k, n: p.n, t: p.t, i: p.i, members: [...p.members], state: p.state, chat: p.chat.slice(-100), hostOnly: p.hostOnly, share: !!p.share, now: Date.now() };
  }
  joinParty(me, id) {
    const p = this.party(id);
    p.members.add(me);
    p.touched = Date.now();
    this._partyEvent(p, 'join', { who: me });
    return this.partyView(p);
  }
  leaveParty(me, id) {
    const p = this.parties.get(id);
    if (!p) return;
    p.members.delete(me);
    if (p.host === me && p.members.size) p.host = [...p.members][0];
    if (!p.members.size) { this.parties.delete(id); return; }
    this._partyEvent(p, 'leave', { who: me, host: p.host });
  }
  partyState(me, id, st) {
    const p = this.party(id);
    if (!p.members.has(me)) throw new HttpError(403, 'Join the party first.');
    if (p.hostOnly && p.host !== me) throw new HttpError(403, 'Only the host can control playback in this party.');
    p.state = { playing: !!st.playing, pos: Math.max(0, Number(st.pos) || 0), rate: Number(st.rate) || 1, at: Date.now(), by: me };
    if (st.k && st.k !== p.k) { p.k = String(st.k); p.n = String(st.n || p.n); p.t = String(st.t || p.t); p.i = String(st.i || p.i); }
    p.touched = Date.now();
    this._partyEvent(p, 'state', { state: p.state, k: p.k, n: p.n, t: p.t, i: p.i });
    return p.state;
  }
  partyChat(me, id, { text, emoji }) {
    const p = this.party(id);
    if (!p.members.has(me)) throw new HttpError(403, 'Join the party first.');
    p.touched = Date.now();
    if (emoji) {
      if (!REACTIONS.includes(emoji)) throw new HttpError(400, 'Unknown reaction');
      this._partyEvent(p, 'emoji', { who: me, emoji });
      return null;
    }
    text = String(text || '').trim().slice(0, 500);
    if (!text) return null;
    const m = { id: uid(), who: me, text, at: Date.now() };
    p.chat.push(m);
    if (p.chat.length > 300) p.chat.shift();
    this._partyEvent(p, 'chat', m);
    return m;
  }
  partySettings(me, id, { hostOnly, share }) {
    const p = this.party(id);
    if (p.host !== me) throw new HttpError(403, 'Only the host can change that.');
    if (typeof hostOnly === 'boolean') p.hostOnly = hostOnly;
    if (typeof share === 'boolean') p.share = share;
    this._partyEvent(p, 'settings', { hostOnly: p.hostOnly, share: !!p.share });
  }
  _partyEvent(p, kind, data) { this.hub.toProfiles([...p.members], 'party', { ...data, kind, party: p.id }); }
  _reapParties() {
    const now = Date.now();
    const online = new Set(this.hub.online());
    for (const p of this.parties.values()) {
      for (const m of [...p.members]) if (!online.has(m) && now - p.touched > 5 * 60e3) p.members.delete(m);
      if (!p.members.size || now - p.touched > 6 * 3600e3) this.parties.delete(p.id);
    }
  }
  partiesFor(me) { return [...this.parties.values()].filter((p) => p.members.has(me) || this.msgs.some((m) => m.party === p.id && (m.to === me || m.to === 'all'))).map((p) => this.partyView(p)); }
}

module.exports = { Hub, Social, REACTIONS };
