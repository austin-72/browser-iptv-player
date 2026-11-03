'use strict';
/**
 * Jellyfin, Emby and Plex libraries as lists: their films and series (and, for Jellyfin/Emby, Live TV channels)
 * join the catalogue, and play straight from the media server with its "static" stream addresses — the file as
 * it is, so the browser plays it directly when it can, and the usual routes take over when it can't.
 *
 * The addresses carry the access token, as the media servers' own web players do: use an account made for this
 * (not an administrator) so the token only reaches what that account may see.
 */
const crypto = require('crypto');
const { fetchAny } = require('./net');
const { HttpError } = require('./util');

const PAGE = 1000;
const CLIENT = 'IPTV Player';

function normBase(s) {
  let v = String(s || '').trim();
  if (!v) throw new HttpError(400, 'Enter the media server’s address.');
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
  let u;
  try { u = new URL(v); } catch { throw new HttpError(400, 'That address isn’t valid.'); }
  // (People paste the web player's address: …/web/index.html#!/home.html)
  return u.origin + u.pathname.replace(/\/web(\/.*)?$/i, '').replace(/\/+$/, '');
}

const ticksToSec = (t) => Math.round((Number(t) || 0) / 1e7);
const tmdbOf = (ids) => (ids && (ids.Tmdb || ids.tmdb)) || '';

class MediaServer {
  /** Validates what the admin typed; returns the list fields to keep. */
  spec(input) {
    const kind = String(input.kind || '').toLowerCase();
    if (!['jellyfin', 'emby', 'plex'].includes(kind)) throw new HttpError(400, 'Choose Jellyfin, Emby or Plex.');
    const out = { kind, server: normBase(input.server || input.url), includeLive: !!input.includeLive };
    if (kind === 'plex') {
      out.token = String(input.token || input.password || '').trim();
      if (!out.token) throw new HttpError(400, 'Enter the Plex token (X-Plex-Token).');
    } else {
      out.token = String(input.token || '').trim(); // an API key, or empty with a username/password
      out.username = String(input.username || '').trim();
      out.password = String(input.password || '');
      if (!out.token && !out.username) throw new HttpError(400, 'Enter an API key, or the username and password of an account for this.');
    }
    return out;
  }

  async _json(url, headers = {}, { method = 'GET', body, timeout = 120000 } = {}) {
    let res;
    try {
      res = await fetchAny(url, { method, headers: { Accept: 'application/json', ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    } catch (e) { throw new Error(`The media server didn’t answer (${e.name === 'TimeoutError' ? 'timed out' : (e.cause && e.cause.message) || e.message})`); }
    // (An answer that isn't read is let go of, so its connection isn't kept open.)
    if (!res.ok) { try { res.body && res.body.cancel().catch(() => {}); } catch {} }
    if (res.status === 401 || res.status === 403) throw new Error('The media server refused the login or key.');
    if (!res.ok) throw new Error(`The media server answered HTTP ${res.status}`);
    const t = await res.text();
    try { return t ? JSON.parse(t) : null; } catch { throw new Error('That doesn’t look like a ' + (headers['X-Plex-Token'] ? 'Plex' : 'Jellyfin/Emby') + ' server.'); }
  }

  // ------------------------------------------------------------ Jellyfin / Emby
  _embyAuthHeader(l, token) {
    const dev = crypto.createHash('sha1').update('iptv' + l.id).digest('hex').slice(0, 16);
    return `MediaBrowser Client="${CLIENT}", Device="Server", DeviceId="${dev}", Version="2.1.0"${token ? `, Token="${token}"` : ''}`;
  }
  _embyHeaders(l, token) { return { 'X-Emby-Authorization': this._embyAuthHeader(l, token), 'X-Emby-Token': token, Authorization: this._embyAuthHeader(l, token) }; }

  /** A token and user id to read the library as. */
  async _embyLogin(l) {
    if (l.token) {
      const users = (await this._json(`${l.server}/Users?api_key=${encodeURIComponent(l.token)}`, this._embyHeaders(l, l.token))) || [];
      const pick = (l.username && users.find((u) => String(u.Name).toLowerCase() === l.username.toLowerCase())) || users.find((u) => u.Policy && !u.Policy.IsAdministrator) || users[0];
      if (!pick) throw new Error('The media server has no users to read the library as.');
      return { token: l.token, user: pick.Id };
    }
    const r = await this._json(`${l.server}/Users/AuthenticateByName`, { 'X-Emby-Authorization': this._embyAuthHeader(l, ''), Authorization: this._embyAuthHeader(l, '') }, { method: 'POST', body: { Username: l.username, Pw: l.password } });
    if (!r || !r.AccessToken) throw new Error('The media server refused that username or password.');
    return { token: r.AccessToken, user: (r.User && r.User.Id) || r.SessionInfo && r.SessionInfo.UserId };
  }

  async _embyLoad(l) {
    const { token, user } = await this._embyLogin(l);
    const h = this._embyHeaders(l, token);
    const q = (extra) => new URLSearchParams({ api_key: token, ...extra }).toString();
    const fields = 'Overview,Genres,ProductionYear,CommunityRating,OfficialRating,ProviderIds,People,DateCreated,Path';
    const all = [];
    for (let start = 0; ; start += PAGE) {
      const r = await this._json(`${l.server}/Users/${user}/Items?${q({ Recursive: 'true', IncludeItemTypes: 'Movie,Series', Fields: fields, StartIndex: String(start), Limit: String(PAGE), EnableImageTypes: 'Primary,Backdrop', ImageTypeLimit: '1', SortBy: 'SortName' })}`, h);
      const items = (r && r.Items) || [];
      all.push(...items);
      if (items.length < PAGE || all.length >= ((r && r.TotalRecordCount) || 0)) break;
    }
    const keep = (x) => ({
      id: x.Id, type: x.Type === 'Series' ? 'show' : 'movie', name: x.Name, year: x.ProductionYear || 0, plot: x.Overview || '', rating: x.CommunityRating || 0,
      cert: x.OfficialRating || '', genre: (x.Genres || []).join(', '), runtime: ticksToSec(x.RunTimeTicks), tmdb: tmdbOf(x.ProviderIds), container: x.Container || '',
      cast: (x.People || []).filter((p) => p.Type === 'Actor').slice(0, 6).map((p) => p.Name).join(', '), director: (x.People || []).filter((p) => p.Type === 'Director').map((p) => p.Name).join(', '),
      img: x.ImageTags && x.ImageTags.Primary ? x.ImageTags.Primary : '', bd: (x.BackdropImageTags || [])[0] || '', added: Date.parse(x.DateCreated || '') || 0,
    });
    const data = { kind: l.kind, user, token: l.token ? '' : token, items: all.map(keep), live: [], fetchedAt: Date.now() };
    if (l.includeLive) {
      const r = await this._json(`${l.server}/LiveTv/Channels?${q({ UserId: user, EnableImageTypes: 'Primary', ImageTypeLimit: '1' })}`, h).catch(() => null);
      data.live = ((r && r.Items) || []).map((c) => ({ id: c.Id, name: c.Name, number: c.ChannelNumber || c.Number || '', img: c.ImageTags && c.ImageTags.Primary ? c.ImageTags.Primary : '', radio: c.ChannelType === 'Radio' }));
    }
    return data;
  }

  // ------------------------------------------------------------ Plex
  _plexHeaders(l) { return { 'X-Plex-Token': l.token, 'X-Plex-Client-Identifier': crypto.createHash('sha1').update('iptv' + l.id).digest('hex').slice(0, 16), 'X-Plex-Product': CLIENT }; }

  async _plexLoad(l) {
    const h = this._plexHeaders(l);
    const secs = await this._json(`${l.server}/library/sections`, h);
    const dirs = ((secs && secs.MediaContainer && secs.MediaContainer.Directory) || []).filter((d) => d.type === 'movie' || d.type === 'show');
    const items = [];
    for (const d of dirs) {
      for (let start = 0; ; start += PAGE) {
        const r = await this._json(`${l.server}/library/sections/${d.key}/all?X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE}&includeGuids=1`, h);
        const mc = (r && r.MediaContainer) || {};
        const md = mc.Metadata || [];
        for (const x of md) {
          const part = x.Media && x.Media[0] && x.Media[0].Part && x.Media[0].Part[0];
          const guid = (x.Guid || []).map((g) => g.id).find((g) => /^tmdb:\/\//.test(g)) || '';
          items.push({
            id: String(x.ratingKey), type: d.type === 'show' ? 'show' : 'movie', name: x.title, year: x.year || 0, plot: x.summary || '', rating: x.audienceRating || x.rating || 0,
            cert: x.contentRating || '', genre: (x.Genre || []).map((g) => g.tag).join(', '), runtime: Math.round((x.duration || 0) / 1000), tmdb: guid.replace('tmdb://', ''),
            cast: (x.Role || []).slice(0, 6).map((g) => g.tag).join(', '), director: (x.Director || []).map((g) => g.tag).join(', '),
            img: x.thumb || '', bd: x.art || '', part: part ? part.key : '', container: (part && part.container) || '', added: (x.addedAt || 0) * 1000, section: d.title,
          });
        }
        if (md.length < PAGE || start + md.length >= (mc.totalSize || 0)) break;
      }
    }
    return { kind: 'plex', items, live: [], fetchedAt: Date.now() };
  }

  async load(l) {
    const data = l.kind === 'plex' ? await this._plexLoad(l) : await this._embyLoad(l);
    if (!data.items.length && !data.live.length) throw new Error('The account works, but the library is empty (or this account can’t see it).');
    return data;
  }

  _token(l, data) { return l.token || (data && data.token) || ''; }
  _img(l, data, id, tag, kind = 'Primary', h = 600) {
    if (!tag) return '';
    if (l.kind === 'plex') return `${l.server}${tag}${tag.includes('?') ? '&' : '?'}X-Plex-Token=${encodeURIComponent(l.token)}`;
    return `${l.server}/Items/${id}/Images/${kind}${kind === 'Backdrop' ? '/0' : ''}?${kind === 'Backdrop' ? 'maxWidth=1280' : `maxHeight=${h}`}&quality=90&tag=${encodeURIComponent(tag)}`;
  }
  _stream(l, data, x) {
    if (l.kind === 'plex') return x.part ? `${l.server}${x.part}?X-Plex-Token=${encodeURIComponent(l.token)}` : '';
    const ext = /^[a-z0-9]{2,5}$/i.test(x.container || '') ? x.container.split(',')[0].toLowerCase() : 'mkv';
    return `${l.server}/Videos/${x.id}/stream.${ext}?static=true&api_key=${encodeURIComponent(this._token(l, data))}`;
  }

  items(l, data) {
    const out = [];
    for (const x of data.items || []) {
      const base = {
        name: x.name, logo: this._img(l, data, x.id, x.img), backdrop: this._img(l, data, x.id, x.bd, 'Backdrop'), year: x.year, plot: x.plot, rating: x.rating,
        cert: x.cert, genre: x.genre, cast: x.cast, director: x.director, tmdb: x.tmdb, added: x.added, headers: {},
      };
      if (x.type === 'show') out.push({ ...base, type: 'show', url: '', group: x.section || 'Series', xt: { kind: 'series', id: x.id } });
      else {
        const url = this._stream(l, data, x);
        if (url) out.push({ ...base, type: 'movie', url, group: x.section || 'Movies', duration: x.runtime, xt: { kind: 'vod', id: x.id } });
      }
    }
    for (const c of data.live || []) {
      out.push({
        name: c.name, type: c.radio ? 'radio' : 'live', url: `${l.server}/Videos/${c.id}/stream?static=true&api_key=${encodeURIComponent(this._token(l, data))}`,
        logo: this._img(l, data, c.id, c.img, 'Primary', 300), group: `${l.kind === 'emby' ? 'Emby' : 'Jellyfin'} Live TV`, chno: c.number ? String(c.number) : '', headers: {},
      });
    }
    return { items: out, epgUrls: [], format: l.kind === 'plex' ? 'Plex library' : l.kind === 'emby' ? 'Emby library' : 'Jellyfin library', name: '' };
  }

  /** A series' episodes, in the shape lists.xtSeries returns. */
  async episodes(l, data, id) {
    const eps = [];
    if (l.kind === 'plex') {
      const r = await this._json(`${l.server}/library/metadata/${encodeURIComponent(id)}/allLeaves`, this._plexHeaders(l));
      for (const x of ((r && r.MediaContainer && r.MediaContainer.Metadata) || [])) {
        const part = x.Media && x.Media[0] && x.Media[0].Part && x.Media[0].Part[0];
        if (!part) continue;
        eps.push({ id: String(x.ratingKey), season: x.parentIndex || 0, episode: x.index || 0, title: x.title || '', url: this._stream(l, data, { part: part.key }), duration: Math.round((x.duration || 0) / 1000), cx: null, plot: x.summary || '', img: this._img(l, data, x.ratingKey, x.thumb), rating: x.audienceRating || x.rating || 0, aired: x.originallyAvailableAt || '' });
      }
    } else {
      const token = this._token(l, data);
      const r = await this._json(`${l.server}/Shows/${encodeURIComponent(id)}/Episodes?${new URLSearchParams({ api_key: token, UserId: data.user || '', Fields: 'Overview' })}`, this._embyHeaders(l, token));
      for (const x of ((r && r.Items) || [])) {
        eps.push({ id: x.Id, season: x.ParentIndexNumber || 0, episode: x.IndexNumber || 0, title: x.Name || '', url: this._stream(l, data, { id: x.Id, container: x.Container }), duration: ticksToSec(x.RunTimeTicks), cx: null, plot: x.Overview || '', img: this._img(l, data, x.Id, x.ImageTags && x.ImageTags.Primary, 'Primary', 360), rating: x.CommunityRating || 0, aired: x.PremiereDate || '' });
      }
    }
    return { info: {}, episodes: eps };
  }
}

module.exports = { MediaServer, normBase };
