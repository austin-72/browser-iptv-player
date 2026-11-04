#!/usr/bin/env node
'use strict';
// Enough memory, and something on screen while restarting. Node stops a program at about 4 GB unless told otherwise;
// a few hundred thousand catalogue entries plus large TV guides, while a provider's list is being refreshed, can need
// more. So a small "front" process (lib/front.js) holds the web port and runs this server as a child process with a
// higher limit (60% of the machine's memory, between 4 and 12 GB; MAX_MEMORY_MB sets it). While the server starts or
// restarts, the front shows visitors "Back in a moment"; when it stops by itself (an update), the front starts it
// again. NO_RESPAWN=1 (or NO_FRONT=1) turns this off and runs the server directly.
// (A one-off command — --set-password — runs on its own, not as a server the front would start again and again.)
if (!process.env.IPTV_CHILD && !process.env.NO_RESPAWN && !process.env.NO_FRONT && !process.argv.includes('--set-password')) {
  const v8 = require('v8');
  const want = Number(process.env.MAX_MEMORY_MB) || Math.max(4096, Math.min(12288, Math.floor(require('os').totalmem() / 1048576 * 0.6)));
  const have = v8.getHeapStatistics().heap_size_limit / 1048576;
  const fcfg = require('./lib/config');
  const tlsF = fcfg.httpsCert && fcfg.httpsKey ? { cert: require('fs').readFileSync(fcfg.httpsCert), key: require('fs').readFileSync(fcfg.httpsKey) } : null;
  require('./lib/front').startFront({
    script: __filename, args: process.argv.slice(2), execArgv: [...process.execArgv, ...(have < want * 0.9 ? [`--max-old-space-size=${want}`] : [])],
    port: fcfg.port, host: fcfg.host, tls: tlsF, dataDir: fcfg.dataDir,
  });
  return; // (the rest of this file runs in the child)
}
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable } = require('stream');

const cfg = require('./lib/config');
const { JsonFile } = require('./lib/store');
const { Epg } = require('./lib/epg');
const { Overrides } = require('./lib/overrides');
const { Media } = require('./lib/media');
const { Proxy } = require('./lib/proxy');
const { Reach, kindOfUrl, xtreamHls } = require('./lib/reach');
const { zipFolder, unzip } = require('./lib/zip');
const { Stats } = require('./lib/stats');
const { Concurrency } = require('./lib/concurrency');
const { fetchAny, setProxyResolver, testProxy, proxyFor } = require('./lib/net');
const { Lists } = require('./lib/lists');
const { Catalog, genresOf, norm: catalogNorm } = require('./lib/catalog');
const catsnap = require('./lib/catsnap');
const Titles = require('./lib/titles');
const { cssFallbacks } = require('./lib/cssfallbacks');
const { Accounts } = require('./lib/accounts');
const { UserData } = require('./lib/userdata');
const { Hub, Social } = require('./lib/social');
const { Tmdb } = require('./lib/tmdb');
const { Recs } = require('./lib/recs');
const { Markers } = require('./lib/markers');
const { ConnTest } = require('./lib/conntest');
const { listUsage: usageOf } = require('./lib/usage');
const P = require('./lib/parse');
const { xmlEsc, fmtTime } = require('./lib/xmltv');
const { HttpError, sendJSON, sendText, readBody, readJSON, isUrl, clampInt, log } = require('./lib/util');
const { ErrorReports } = require('./lib/errors');
const { makeRelay, testRelay, testRelayProxy, newSecret, relayDownloads, updateRelay, bundledRelay, playId, acctId } = require('./lib/streamrelay');
const frontLink = require('./lib/front'); // (telling the front when this server is about to stop)

let L = { names: {}, list: () => [] };
try { L = require('./lib/langs'); } catch {}

// ---------------------------------------------------------------- storage & settings
const D = cfg.dataDir;
// Problems on viewers' devices and server errors, kept for fixing (Admin → Error reports; lib/errors.js).
const reports = new ErrorReports({ dataDir: D, log, version: cfg.version, root: cfg.root });
fs.mkdirSync(D, { recursive: true });
const preset = cfg.presets || {};
const DEFAULT_SETTINGS = {
  brand: { name: (preset.brand && preset.brand.name) || 'IPTV Player', logo: (preset.brand && preset.brand.logo) || '', accent: (preset.brand && preset.brand.accent) || '' },
  userAgent: 'VLC/3.0.21 LibVLC/3.0.21',
  routing: 'direct-first', // 'direct-first' | 'server' | 'direct-only'
  defaultLangs: Array.isArray(preset.defaultLangs) ? preset.defaultLangs : [],
  showUnknownLang: true,
  hiddenGroups: [], hiddenKeys: [],
  epgDays: 7, epgPastDays: 7, epgRefreshHours: 12,
  transcodePreset: 'veryfast', transcodeCrf: 22, transcodeMaxHeight: 1080, maxTranscodes: 3, maxSessions: 10, remuxReadrate: 0, hwaccel: '',
  tmdbKey: '', introDetection: true,
  adminOnlyProfiles: false, allowDownloads: true, allowParties: true,
  exportKey: crypto.randomBytes(12).toString('hex'),
  allowedHosts: [],
  // Outgoing proxies (Admin → Network): [{ id, name, url, video }]; `proxy` is the default for everything.
  proxies: [], proxy: '',
  // The stream relay on an internet machine (relay/relay.js) for viewers' direct streams: { url, secret, all }.
  relay: { url: '', secret: '', all: true },
  // A plain-http address of this server (e.g. http://192.168.1.20:8080) that https pages switch to so streams from
  // http-only providers can play straight from the provider instead of through the server.
  directAddress: '', directSwitch: 'ask', // 'ask' | 'auto' | 'off'
  // Category clean-up: tidy names, plus the admin's rules [{ match, to, hide, types }].
  tidyGroups: true, groupRules: [],
  backupDays: 7, // nightly backups kept
};
const settingsStore = new JsonFile(path.join(D, 'settings.json'), DEFAULT_SETTINGS);
const settings = () => settingsStore.data;
const defaultPassword = process.env.SITE_PASSWORD || preset.sitePassword || 'changeme';

const media = new Media(cfg, D, settings);
const proxy = new Proxy(settings);
const reach = new Reach(proxy);
const stats = new Stats(D);
proxy.onBytes = (split, n) => stats.bytes(split ? 'split' : 'relay', n);
/** Count what a response sends (for Admin → Statistics). */
function countBytes(res, kind) {
  let n = 0;
  const w = res.write, e = res.end;
  res.write = function (c, ...a) { if (c && typeof c !== 'function') n += c.length || 0; return w.call(this, c, ...a); };
  res.end = function (c, ...a) { if (c && typeof c !== 'function') n += c.length || 0; return e.call(this, c, ...a); };
  res.once('close', () => stats.bytes(kind, n));
}
const accounts = new Accounts(D, { defaultPassword });
const userdata = new UserData(path.join(D, 'users'));
const hub = new Hub();
const social = new Social(D, { hub, accounts });
// The admin's channel edits, guide offsets and parental locks (Admin → Channels).
const overrides = new Overrides(D);
// (The saved guides are read in the background: a big set is gigabytes, and the server answers meanwhile.)
const epg = new Epg(path.join(D, 'epg'), { offsets: overrides.d.guideOffsets, background: true });
let catalog;
let rebuildTimer = null;
const scheduleRebuild = (ms = 1500) => { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(rebuildCatalog, ms); };
const lists = new Lists({
  dir: path.join(D, 'lists'), media, getSettings: settings,
  onChange: () => scheduleRebuild(),
  onGuides: (what, id, data) => {
    if (what === 'data') epg.setSource(id, data, { soon: true });
    else if (what === 'removed') epg.removeSource(id);
    epg.setOrder(lists.guides().filter((g) => g.enabled).map((g) => g.id));
    for (const sid of epg.sources.keys()) if (!lists.guides().some((g) => g.id === sid && g.enabled)) epg.removeSource(sid);
  },
});
catalog = new Catalog({ lists, epg, getSettings: settings });
catalog.overrides = overrides;
catalog.decorate = (it) => applyMeta(it, tmdb.meta.data.m[it.k]); // (applyMeta and tmdb: further down, used once built)
// The TMDB entry each title was matched to (by its key in the last build): titles that are one entry are merged.
// (Only a sure match: picked by hand, or TMDB's title is clearly this title — a match found by searching a name is
// sometimes another film, and merging on it would hide one of them.)
catalog.tmdbOf = (k, it) => {
  try {
    const m = tmdb.map.data.m[k];
    if (!m || !m.id) return null;
    if (m.manual) return m;
    const d = tmdb.meta.data.m[k];
    return d && d.title && String(d.tmdb) === String(m.id) && it && Titles.sameTitle(it.n, it.y, d.title, d.y) ? m : null;
  } catch { return null; }
};
// The languages anyone in the household can see (each profile's own, or the server default): titles in others are
// left out of the catalogue. null = someone sees every language, keep all.
catalog.keepLangs = () => {
  const S = settings();
  const langs = new Set();
  let unknown = false;
  for (const p of accounts.profiles) {
    const l = Array.isArray(p.langs) ? p.langs : (S.defaultLangs || []);
    if (!l.length) return null;
    for (const x of l) langs.add(x);
    if (typeof p.unknownLang === 'boolean' ? p.unknownLang : S.showUnknownLang !== false) unknown = true;
  }
  return langs.size ? { langs, unknown } : null;
};
// Someone's languages changed (Settings → Languages, Admin → Languages, a new profile): rebuild once the household's
// combined choice differs from the one the catalogue was built with.
const keepSig = (k = catalog.keepLangs()) => (k ? JSON.stringify([[...k.langs].sort(), k.unknown]) : 'all');
let builtKeep = null;
setInterval(() => { if (builtKeep !== null && keepSig() !== builtKeep && !rebuilding) { log('Languages changed: rebuilding the catalogue'); builtKeep = keepSig(); scheduleRebuild(3000); } }, 15e3).unref(); // (builtKeep: set after each build)

// ---- outgoing proxies: a list's own choice, else the default (Admin → Network)
function proxyById(id) { return (settings().proxies || []).find((x) => x.id === id) || null; }
/** The proxy for a list ('' = none). */
function listProxy(listId) {
  const l = listId && lists.all().find((x) => x.id === listId);
  const choice = l ? l.proxy || '' : '';
  if (choice === 'none') return null;
  return proxyById(choice) || proxyById(settings().proxy) || null;
}
setProxyResolver((url) => {
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/i.test(url)) return '';
  const owner = lists.ownerOf(url);
  const p = owner ? listProxy(owner) : proxyById(settings().proxy);
  return p ? p.url : '';
});
/** Viewers' direct streams through the stream relay (lib/streamrelay.js): which lists, and their signed addresses. */
// The relay reaches providers straight, through each list's own proxy (the same one this server uses), or through
// one chosen proxy (Admin → Network & proxies → Stream relay).
const relayProxyMode = () => (settings().relay || {}).proxy || '';
const relayProxyOf = (url) => {
  const m = relayProxyMode();
  if (!m) return '';
  if (m === 'list') return proxyFor(url);
  const px = proxyById(m);
  return px ? px.url : '';
};
const relayOf = makeRelay({ getSettings: settings, listOf: (id) => lists.all().find((x) => x.id === id), proxyOf: relayProxyOf });
/** Does video from this list have to go through the server (its proxy is set to carry video)? */
const videoViaProxy = (listId) => { const p = listProxy(listId); return !!(p && p.video); };
const tmdbT0 = Date.now();
const tmdb = new Tmdb({ dataDir: D, getKey: () => settings().tmdbKey, base: cfg.tmdbBase, getLang: () => settings().tmdbLang || '' });
const tmdbLoadS = (Date.now() - tmdbT0) / 1000; // (shown in the start-up line: the saved TMDB details are read here)
const recs = new Recs({ dir: path.join(D, 'users'), catalog, userdata, accounts, tmdb });

function applyMeta(it, m) {
  if (!m) return;
  // Someone in the household picked this match by hand: its details win over the provider's.
  const force = !!m.manual;
  // TMDB's genres are the consistent ones (the provider's vary from category to category).
  if (m.gn && m.gn.length) it.gn = genresOf(m.gn);
  for (const k of ['plot', 'cast', 'dir', 'bd', 'c', 'tmdb']) if ((force || !it[k]) && m[k] && (!Array.isArray(m[k]) || m[k].length)) it[k] = m[k];
  if ((force || !it.y) && m.y) it.y = m.y;
  if ((force || !it.r) && m.r) it.r = m.r;
  if ((force || !it.d) && m.d) it.d = m.d;
  if (m.col) it.col = m.col.id; else if (force) delete it.col;
  // TMDB's title, the same for every copy ("Spider Man Into The Spiderverse" → "Spider-Man: Into the Spider-Verse") —
  // when the match is sure: picked by hand, or a name that's clearly the same title
  // (a match found by searching the name could be another film of a similar name: then the provider's name stays).
  if (m.title && it.n !== m.title && settings().tmdbTitles !== false && (force || sameTitle(it, m))) it.n = m.title;
  if (!it.logo && m.poster) it.logo = m.poster;
  if (m.poster) it.poster = m.poster;
}
/** Is TMDB's entry clearly this title? (lib/titles.js) */
const sameTitle = (it, m) => Titles.sameTitle(it.n, it.y, m.title, m.y);
let rebuilding = null, rebuildAgain = false, catalogReady = null;
/** Rebuild the catalogue: at start-up in one go, afterwards in slices so nobody's stream stalls while it runs. */
function rebuildCatalog(now) {
  if (now === true) { const sig = catalogInputs(); catalog.build(); builtSig = sig; return afterRebuild(); }
  if (rebuilding) { rebuildAgain = true; return rebuilding; }
  // (What it's made from, as it is now: saved with the catalogue, so the next start can tell whether it's still right.)
  const sig = catalogInputs();
  // (A failure is logged and the next change tries again: one bad build mustn't stop all later ones.)
  const done = catalog.buildAsync().then(() => { builtSig = sig; return afterRebuild(); }).catch((e) => log('Catalogue rebuild failed:', e && e.stack || e));
  rebuilding = done;
  done.then(() => {
    rebuilding = null;
    if (rebuildAgain) { rebuildAgain = false; rebuildCatalog(); }
  });
  return done; // (resolves when this build is in place, not after any queued after it)
}
function afterRebuild() {
  builtKeep = keepSig(catalog._keep || null); // (what this build used)
  // Titles renamed by the tidy-up or merged: move history, lists, favourites… and TMDB matches to the new keys.
  if (catalog.renamed && catalog.renamed.size) {
    let moved = 0;
    for (const pr of accounts.profiles) { const n = userdata.migrateKeys(pr.id, catalog.renamed); if (n) { moved += n; recs.touch(pr.id, 5000); } }
    moved += tmdb.migrateKeys(catalog.renamed);
    if (moved) log(`Moved ${moved} saved things to renamed titles`);
  }
  // (TMDB's details went on each title while it was built: catalog.decorate.)
  catalog.cache.clear();
  if (!catalog.sameAsBefore) hub.toAll('catalog', { version: catalog.version });
  afterCatalog();
}
/** After a new catalogue (built, or the saved one at start-up): the jobs that go through it, a little later. */
function afterCatalog() {
  setTimeout(() => checkNewEpisodes().catch((e) => log('New episodes:', e.message)), 20e3);
  // Ready before anyone searches for an actor (made in the background, in slices).
  setTimeout(() => peopleIndex().catch(() => {}), 30e3);
  // New titles: look them up on TMDB in the background (a minute later, so start-up stays quick).
  clearTimeout(rebuildCatalog.enrichTimer);
  rebuildCatalog.enrichTimer = setTimeout(() => { try { startEnrich(true); } catch (e) { log('TMDB:', e.message); } }, 60e3);
}
epg.onChange = () => { if (catalog && catalog.epgChanged()) hub.toAll('catalog', { version: catalog.version }); };

// ---- the finished catalogue, saved for a quick start next time (lib/catsnap.js)
// Putting a catalogue of millions of entries together takes minutes (reading every list, sorting out duplicates and
// languages). The result is saved a minute after it last changed; a restart puts it back in seconds, and builds it
// again — in the background, with the saved one in use meanwhile — only when something it's made from has changed.
const SNAP_FILE = path.join(D, 'catalog.snapshot');
// (The code that decides what the catalogue holds: an update to it means building again.)
const CODE_SIG = crypto.createHash('sha1').update(['catalog.js', 'titles.js', 'lists.js', 'parse.js', 'langs.js', 'events.js', 'overrides.js', 'stalker.js', 'mediaserver.js', 'library.js', 'shared/m3u.js']
  .map((f) => { try { return fs.readFileSync(path.join(__dirname, 'lib', f), 'utf8'); } catch { return ''; } }).join('\u0000')).digest('hex');
let builtSig = ''; // what the catalogue in use was made from (catalogInputs at the start of its build)
/** Everything the catalogue is made from, as one fingerprint. */
function catalogInputs() {
  const h = crypto.createHash('sha1').update(CODE_SIG);
  const S = settings();
  h.update(JSON.stringify([S.tidyGroups, S.groupRules, S.hiddenGroups, S.hiddenKeys, S.defaultLangs, S.showUnknownLang, keepSig(), overrides.d]));
  for (const l of lists.all().concat(lists.extras || [])) {
    const { status, account, ...conf } = l; // (how its last refresh went doesn't change what's in it)
    h.update(JSON.stringify(conf));
    if (l.type === 'folder' || (lists.extras || []).includes(l)) {
      // (The household's own folders and "My channels": their entries, which are in memory and small.)
      const p = lists.parsed.get(l.id);
      for (const it of (p && p.items) || []) h.update(`${it.url}|${it.name}|${it.group || ''};`);
      continue;
    }
    try { const st = fs.statSync(lists.rawFile(l)); h.update(`|${st.size}|${st.mtimeMs}`); } catch { h.update('|none'); }
  }
  return h.digest('hex');
}
// (SNAPSHOT_QUIET_MS: how long it must stay the same before it's saved — shorter in tests.)
const SNAP_QUIET = Number(process.env.SNAPSHOT_QUIET_MS) || 60e3;
let snapVersion = '', snapSig = '', snapAt = 0, snapSaving = false, lastSeenVersion = '', versionSince = Date.now();
async function saveSnapshot() {
  if (snapSaving || JsonFile.frozen || !builtSig || !catalog.items.length) return;
  snapSaving = true;
  const v = catalog.version, sig = builtSig, t = Date.now();
  try {
    const bytes = await catsnap.save(SNAP_FILE, { v: 1, sig, at: Date.now(), ...catalog.snapshotHead(), lists: lists.snapshotMeta() }, catalog.items, catalog.snapshotHistory());
    if (JsonFile.frozen) { try { fs.unlinkSync(SNAP_FILE); } catch {} } // (a backup was restored meanwhile)
    else log(`Catalogue saved for a quick start (${(bytes / 1048576).toFixed(0)} MB in ${((Date.now() - t) / 1000).toFixed(1)} s)`);
  } catch (e) { log('Couldn’t save the catalogue for a quick start:', e.message); }
  snapVersion = v; snapSig = sig; snapAt = Date.now(); // (also after a failure: tried again on the next change, not every few seconds)
  snapSaving = false;
}
setInterval(() => {
  if (catalog.version !== lastSeenVersion) { lastSeenVersion = catalog.version; versionSince = Date.now(); return; }
  // (Once it has stayed the same a minute: not in the middle of a burst of changes.)
  // (Or built again from changed lists with the same result: saved with what it's made from now.)
  // (Details filled in from TMDB change it every few minutes while that runs: then at most every 5 minutes.)
  if (rebuilding || catalogReady || Date.now() - versionSince < SNAP_QUIET) return;
  if (builtSig !== snapSig || (catalog.version !== snapVersion && Date.now() - snapAt > 5 * SNAP_QUIET)) saveSnapshot();
}, Math.min(15e3, SNAP_QUIET / 4)).unref();

// ---- new episodes of shows people follow (in My List, or watched in the last 4 months)
const showsSeen = new JsonFile(path.join(D, 'shows-seen.json'), { m: {} }); // show key → { ad, eps: [keys], at }
let followsOf = () => []; // series followed with the bell on their page (lib/routes-p10.js)
let checkingEps = false;
async function checkNewEpisodes() {
  if (checkingEps) return;
  checkingEps = true;
  try {
    const followers = new Map(); // show key → [profile ids]
    const since = Date.now() - 120 * 86400e3;
    for (const pr of accounts.profiles) {
      if (userdata.prefs(pr.id).newEpisodeAlerts === false) continue;
      const d = userdata.of(pr.id).data;
      const add = (k) => { if (!k) return; const it = catalog.get(k); if (!it || it.t !== 'show') return; const l = followers.get(k) || []; if (!l.includes(pr.id)) l.push(pr.id); followers.set(k, l); };
      for (const k of d.list) add(k);
      for (const k of followsOf(pr.id)) add(k);
      for (const h of d.history) if (h.at > since && h.sk) add(h.sk);
      for (const p of Object.values(d.progress)) if (p.at > since && p.sk) add(p.sk);
    }
    const seen = showsSeen.data.m;
    for (const [sk, pids] of followers) {
      const show = catalog.get(sk);
      if (!show) continue;
      const prev = seen[sk];
      let eps;
      if (show.xt && show.xt.kind === 'series') {
        // Xtream: the series list says when a series last changed; only then ask for its episodes (fresh).
        if (prev && prev.ad && show.ad && show.ad <= prev.ad) continue;
        try { eps = await catalog.episodes(sk, prev ? 0 : 12 * 3600e3); } catch { continue; }
        await new Promise((ok) => setTimeout(ok, 800));
      } else eps = (catalog.shows.get(sk) || []).map((k) => catalog.get(k)).filter(Boolean);
      const keys = eps.map((e) => e.k);
      if (!prev) { seen[sk] = { ad: show.ad || 0, eps: keys, at: Date.now() }; continue; }
      const known = new Set(prev.eps || []);
      const fresh = eps.filter((e) => !known.has(e.k));
      seen[sk] = { ad: show.ad || 0, eps: keys, at: Date.now() };
      if (!fresh.length || fresh.length > 40) continue; // a whole show re-listed isn't "new episodes"
      for (const pid of pids) {
        if (!userdata.addNewEpisodes(pid, sk, fresh.map((e) => e.k))) continue;
        hub.toProfile(pid, 'data', { field: 'newEps' });
        const e = fresh[fresh.length - 1];
        hub.toProfile(pid, 'notify', { kind: 'episode', title: fresh.length > 1 ? `${fresh.length} new episodes of ${show.n}` : `New episode of ${show.n}`, body: e.et || `Season ${e.s}, episode ${e.e}`, k: sk, i: show.logo || '' });
      }
    }
    for (const k of Object.keys(seen)) if (!followers.has(k) && Date.now() - (seen[k].at || 0) > 200 * 86400e3) delete seen[k];
    showsSeen.save();
  } finally { checkingEps = false; }
}

/** What ffmpeg should open for an item: a local file or the stream address with its headers. */
/**
 * Where this server reads a copy of a title from. raw: the provider's own address, never the stream relay's (to tell
 * which provider it is, or how a browser would reach it).
 */
function inputOf(it, alt = -1, overrideUrl = '', { raw = false } = {}) {
  if (it.loc) {
    const li = lists.libraryItem(it.loc.list, it.loc.id);
    return li ? { input: li.path, headers: {}, local: li } : null;
  }
  const a = alt >= 0 && it.alts && it.alts[alt] ? it.alts[alt] : { u: it.u, h: it.h };
  const u = overrideUrl || a.u;
  // A Stalker portal's entry: this server's own address, which asks the portal for the stream just then.
  if (/^\/api\/proxy\/stalker\//.test(u)) return { input: loopback(u), headers: {} };
  // Playlist entries can name files on the server itself (file:// or a plain path).
  if (/^file:/i.test(u)) {
    let file = null;
    try { file = require('url').fileURLToPath(u); } catch {}
    if (!file || !LOCAL_MEDIA.test(file) || !fs.existsSync(file)) return null;
    return { input: file, headers: {}, local: { path: file } };
  }
  // A list that uses the stream relay: this server's own reading of its streams — conversions, downloads, recordings,
  // other apps, a look inside — goes through the relay too, so the provider only ever sees the relay (and its proxy).
  // The relay sends the headers the provider needs. (The same address each time for a while: what was found out
  // about a stream is kept by its address.)
  if (!raw && /^https?:\/\//i.test(u || '') && relayOf.uses(lists.ownerOf(u) || (alt >= 0 && it.alts && it.alts[alt] ? it.alts[alt].l : it.src))) {
    const h = { ...(settings().userAgent ? { 'User-Agent': settings().userAgent } : {}), ...(a.h || {}) };
    return { input: relayWrapped(u, h), headers: {}, viaRelay: true, raw: u };
  }
  // Behind a proxy: ffmpeg reads it through the server's own relay, which goes through the proxy.
  if (isUrl(u) && listProxy(lists.ownerOf(u) || (alt >= 0 && it.alts && it.alts[alt] ? it.alts[alt].l : it.src))) {
    return { input: loopback(proxy.sign(u, { h: a.h || {} })), headers: {}, viaProxy: true };
  }
  return { input: u, headers: a.h || {} };
}
/** The stream relay's address for one provider address, for this server's own use (kept for a day; good for a week). */
const relayMemo = new Map();
function relayWrapped(u, h) {
  const key = u + '\n' + JSON.stringify(h) + '\n' + ((settings().relay || {}).url || '');
  const m = relayMemo.get(key);
  if (m && Date.now() - m.at < 86400e3) return m.url;
  const url = relayOf.wrap(u, h, { ttl: 7 * 86400 });
  if (relayMemo.size > 20000) relayMemo.clear();
  relayMemo.set(key, { url, at: Date.now() });
  return url;
}
/** An address for the server's own relay that ffmpeg (on this machine) can open without signing in. */
function loopback(pathq) { return `${tls ? 'https' : 'http'}://127.0.0.1:${cfg.port}${castSign(pathq, 48)}`; }
/**
 * How many connections the provider account behind an item allows at once (0 = unknown / no limit).
 * Accounts that allow only one must never get a second connection from this server while someone watches —
 * the provider would refuse it or, worse, cut the viewer off.
 */
function connLimit(it, alt = -1) {
  const id = alt >= 0 && it.alts && it.alts[alt] ? it.alts[alt].l : it.src;
  const l = id && lists.store.data.lists.find((x) => x.id === id);
  // What the admin's connection test measured for this kind beats what the provider claims.
  const m = measuredLimit(l, it.t);
  if (m !== null) return m;
  const n = parseInt(l && l.account && l.account.maxConnections, 10);
  return n > 0 ? n : 0;
}
/** The tested number of streams at once for a kind of item (0 = no limit found; null = not tested). */
function measuredLimit(l, t) {
  const r = l && l.connTest && l.connTest[t === 'movie' ? 'movie' : t === 'episode' || t === 'show' ? 'show' : 'live'];
  if (!r || !(r.max >= 1)) return null;
  return r.limited ? r.max + (l.connTest.already || 0) : 0;
}
const oneConnection = (it, alt = -1) => connLimit(it, alt) === 1;
function listFormats(it, alt = -1) {
  const id = alt >= 0 && it.alts && it.alts[alt] ? it.alts[alt].l : it.src;
  const l = id && lists.store.data.lists.find((x) => x.id === id);
  return (l && l.account && l.account.formats) || [];
}
const markers = new Markers({ dataDir: D, catalog, media, inputOf: (e) => inputOf(e), allowed: (e) => { const n = connLimit(e); return n === 0 || n >= 3; } }); // it reads 2 episodes at once
markers.enabled = () => settings().introDetection !== false;

// node server.js --set-password 'new password'
const pwArg = process.argv.indexOf('--set-password');
if (pwArg > 0) {
  try { accounts.setSitePassword(process.argv[pwArg + 1]); JsonFile.flushAll(); accounts.store.flush(); console.log('Site password changed. Every device has been signed out.'); process.exit(0); } catch (e) { console.error(e.message); process.exit(1); }
}

// ---------------------------------------------------------------- helpers
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.ts': 'video/mp2t', '.m3u8': 'application/vnd.apple.mpegurl',
};

function serveFile(req, res, file, { type, download, cache, headers: extra } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { throw new HttpError(404, 'File not found'); }
  if (!st.isFile()) throw new HttpError(404, 'File not found');
  const headers = {
    'Content-Type': type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Cache-Control': cache || 'no-cache', 'Last-Modified': st.mtime.toUTCString(), ...(extra || {}),
  };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(typeof download === 'string' ? download : path.basename(file))}`;
  const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
  if (range && st.size) {
    let start = range[1] === '' ? st.size - parseInt(range[2], 10) : parseInt(range[1], 10);
    let end = range[1] !== '' && range[2] !== '' ? parseInt(range[2], 10) : st.size - 1;
    start = Math.max(0, start); end = Math.min(end, st.size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function sendGz(req, res, raw, gz, type, etag) {
  if (etag && req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
  const h = { 'Content-Type': type, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
  if (etag) h.ETag = etag;
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(200, { ...h, 'Content-Encoding': 'gzip', 'Content-Length': gz.length }); return res.end(gz); }
  if (typeof raw === 'function') raw = raw(); // (unpacked only for the rare client that can't take gzip)
  res.writeHead(200, { ...h, 'Content-Length': raw.length });
  res.end(raw);
}
function sendJsonGz(req, res, obj) {
  const raw = Buffer.from(JSON.stringify(obj));
  if (raw.length < 2048) return sendJSON(res, 200, obj);
  sendGz(req, res, raw, zlib.gzipSync(raw, { level: 5 }), 'application/json; charset=utf-8');
}

const LOCAL_MEDIA = /\.(mp4|m4v|mkv|avi|mov|webm|wmv|flv|mpg|mpeg|ts|m2ts|mts|vob|3gp|ogv|divx|mp3|m4a|aac|flac|ogg|oga|opus|wav|wma|asf|rm|rmvb)$/i;
const NATIVE_EXT = /\.(mp4|m4v|webm|mp3|m4a|aac|flac|ogg|oga|opus|wav)$/i;
const secureReq = (req) => !!req.socket.encrypted || (cfg.trustProxy && /^https/i.test(req.headers['x-forwarded-proto'] || ''));
// Behind a proxy, the address it added is the last one in X-Forwarded-For; anything before it came from the visitor
// and could be made up (say, a local-network address to reach the tuner, or a new one per guess to dodge sign-in
// limits). So: reading from the end, the first address that isn't a proxy of ours — not a local one, and not
// Cloudflare's (in front of a local nginx/Caddy/Traefik it's a hop too) — or the first if they're all local (a
// visitor on the home network).
const CLOUDFLARE = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22']
  .map((c) => { const [a, n] = c.split('/'); return [a.split('.').reduce((x, o) => x * 256 + Number(o), 0), 2 ** (32 - Number(n))]; });
const CLOUDFLARE6 = /^(2400:cb00|2606:4700|2803:f800|2405:b500|2405:8100|2a06:98c[0-7]|2c0f:f248):/i;
function cloudflareIp(ip) {
  const v = String(ip || '').replace(/^::ffff:/, '');
  if (CLOUDFLARE6.test(v)) return true;
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const n = ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4];
  return CLOUDFLARE.some(([a, size]) => n >= a && n < a + size);
}
const clientIp = (req) => {
  const peer = req.socket.remoteAddress || '';
  if (!cfg.trustProxy) return peer;
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!hops.length) return peer;
  const { privateIp } = require('./lib/outputs');
  for (let i = hops.length - 1; i >= 0; i--) if (!privateIp(hops[i]) && !cloudflareIp(hops[i])) return hops[i];
  return hops[0];
};

/** A JSON body that must be an object (`null`, a number or a string become {} instead of a crash further on). */
async function readObj(req) {
  const b = await readJSON(req);
  return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
}
function requireProfile(ctx) {
  if (!ctx.profile) throw new HttpError(403, 'Choose a profile first.');
  return ctx.profile;
}
function requireAdmin(ctx) {
  const p = requireProfile(ctx);
  if (!p.admin) throw new HttpError(403, 'Only the admin can do that.');
  return p;
}
function item(ctx, k) {
  const p = requireProfile(ctx);
  // A recording (lib/routes-p12.js): "rec:<id>".
  if (k.startsWith('rec:') && dvrHooks.dvrItem) return dvrHooks.dvrItem(p, k);
  const it = catalog.visible(p, k);
  if (!it) throw new HttpError(404, 'That isn’t available.');
  // Behind the parental PIN (Admin → Channels): not until this device has entered it.
  if (overrides.hasLocks && overrides.isLocked(it, (x) => catalog.get(x)) && !overrides.allowed(ctx)) throw new HttpError(423, p.kids ? 'This is locked.' : 'This is locked. Enter the parental PIN to watch it.');
  return it;
}
// (Integrations add their own flags: subtitles, Trakt — see lib/routes-p5.js.)
let p5Public = () => ({});
let p8Public = () => ({}); // (event channels: lib/routes-p8.js)
function publicSettings() {
  const s = settings();
  return {
    ...p5Public(), ...p8Public(),
    brand: s.brand, routing: s.routing, allowDownloads: s.allowDownloads !== false, allowParties: s.allowParties !== false,
    ffmpeg: media.available, tmdb: !!s.tmdbKey, version: cfg.version, defaultLangs: s.defaultLangs, showUnknownLang: s.showUnknownLang !== false,
    langNames: L.names || {}, introDetection: s.introDetection !== false && !!markers.detector,
    directAddress: s.directAddress || '', directSwitch: s.directSwitch || 'ask',
    features: ['browserRoute', 'copyCodecs'],
    epgPlaceholders: overrides.placeholders, parentalPin: overrides.hasPin,
    // Lists whose direct streams go through the stream relay (so devices never go straight to those providers).
    relayLists: relayOf.conf() ? lists.all().filter((l) => relayOf.uses(l.id)).map((l) => l.id) : [],
  };
}

// ---------------------------------------------------------------- routes
const routes = [];
const route = (method, pattern, handler, level = 'profile') => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, level });
};

// ---- sign in (site password)
route('POST', '/api/login', async (req, res) => {
  const { password } = await readObj(req);
  const token = accounts.login(password, clientIp(req), req.headers['user-agent']);
  res.setHeader('Set-Cookie', accounts.cookie(token, secureReq(req)));
  return { ok: true };
}, 'public');
route('POST', '/api/logout', (req, res) => {
  accounts.logout(req);
  dropStaleConns(); // (this device's live connection too: it stops getting the profile's messages and commands)
  res.setHeader('Set-Cookie', accounts.clearCookie());
  return { ok: true };
}, 'site');

// ---- profiles
route('GET', '/api/boot', (req, res, p, q, ctx) => ({
  ...publicSettings(),
  profiles: accounts.profiles.map((x) => accounts.summary(x)),
  // Open straight into this device's profile when nothing has to be asked (no PIN, or it's remembered here).
  current: (accounts.resumable(ctx.sess) || {}).id || null,
  last: ctx.sess.profileId || null,
  device: ctx.sess.name,
  firstRun: accounts.profiles.length === 0,
  defaultPassword: accounts.d.site.isDefault,
  languages: L.list ? L.list() : [],
}), 'site');
route('POST', '/api/profiles', async (req, res, p, q, ctx) => {
  const b = await readObj(req);
  const prof = accounts.create(b, ctx.sess, settings());
  if (accounts.profiles.length === 1) { accounts.select(ctx.sess, prof.id, String(b.pin || '')); }
  hub.toAll('profiles', {});
  return accounts.summary(prof);
}, 'site');
route('POST', '/api/profiles/:id/select', async (req, res, p, q, ctx) => {
  const { pin, remember } = await readObj(req);
  const prof = accounts.select(ctx.sess, p.id, pin === undefined ? undefined : String(pin), remember !== false);
  p5.onSignIn(prof, ctx.sess);
  return { ok: true, profile: accounts.view(prof) };
}, 'site');
route('POST', '/api/profiles/leave', async (req, res, p, q, ctx) => {
  const b = await readJSON(req).catch(() => ({}));
  if (b && b.lock) accounts.lock(ctx.sess); else { ctx.sess.profileId = null; accounts.store.save(); }
  return { ok: true };
}, 'site');

// ---- me
route('GET', '/api/me', (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  sendJsonGz(req, res, { profile: accounts.view(prof), data: userdata.snapshot(prof.id), settings: publicSettings(), unread: social.unread(prof.id), catalogVersion: catalog.version, alerts: prof.admin ? accountAlerts() : [] });
});
route('PUT', '/api/me', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readObj(req);
  const allowed = ['name', 'avatar', 'langs', 'unknownLang', 'interests', 'pin', 'currentPin'];
  const patch = Object.fromEntries(Object.entries(b).filter(([k]) => allowed.includes(k)));
  if (prof.kids && ('langs' in patch || 'unknownLang' in patch) && !prof.admin) { /* kids may still choose languages */ }
  accounts.update(prof.id, patch, { self: true, sess: ctx.sess });
  if ('pin' in patch) dropStaleConns(); // (other devices that knew the old PIN)
  if ('langs' in patch || 'unknownLang' in patch || 'interests' in patch) recs.touch(prof.id, 2000);
  hub.toAll('profiles', {});
  return accounts.view(prof);
});
// Profile photos: stored as data/avatars/<profile id>.jpg (sent already shrunk to a square JPEG by the app).
const AVATARS = path.join(D, 'avatars');
route('PUT', '/api/me/avatar', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const { image } = await readJSON(req);
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
  if (!m) throw new HttpError(400, 'Send a JPG, PNG or WebP picture.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 400e3) throw new HttpError(413, 'That picture is too big.');
  const ok = (m[1] === 'jpeg' && buf[0] === 0xff && buf[1] === 0xd8) || (m[1] === 'png' && buf[1] === 0x50) || (m[1] === 'webp' && buf.slice(8, 12).toString() === 'WEBP');
  if (!ok) throw new HttpError(400, 'That isn’t a picture.');
  fs.mkdirSync(AVATARS, { recursive: true });
  fs.writeFileSync(path.join(AVATARS, prof.id + '.img'), buf);
  accounts.setAvatar(prof.id, `img:${prof.id}:${Date.now().toString(36)}`);
  hub.toAll('profiles', {});
  return accounts.view(accounts.profile(prof.id));
});
route('GET', '/api/avatar/:pid', (req, res, p) => {
  const file = path.join(AVATARS, String(p.pid).replace(/[^a-z0-9]/gi, '') + '.img');
  if (!fs.existsSync(file)) throw new HttpError(404, 'No picture');
  const buf = fs.readFileSync(file);
  const type = buf[0] === 0x89 ? 'image/png' : buf.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/jpeg';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.end(buf);
}, 'site');
route('PUT', '/api/me/prefs', async (req, res, p, q, ctx) => { const prof = requireProfile(ctx); const r = userdata.setPrefs(prof.id, await readJSON(req)); changed(ctx, prof, 'prefs'); return r; });
route('DELETE', '/api/me', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const { pin } = await readObj(req);
  if (prof.admin) throw new HttpError(400, 'The admin profile can’t be removed. Make someone else the admin first.');
  if (!accounts.checkPin(prof.id, pin, ctx.sess)) throw new HttpError(403, 'Wrong PIN.');
  accounts.remove(prof.id); userdata.remove(prof.id); social.forgetProfile(prof.id);
  dropStaleConns(); // (its other devices' live connections)
  hub.toAll('profiles', {});
  return { ok: true };
});

// ---- catalogue & details
route('GET', '/api/catalog', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  // The device has this version already (after a restart too: the saved catalogue keeps its version): nothing to
  // make or send.
  const current = catalog.etagFor(prof);
  if (!q.get('page') && (req.headers['if-none-match'] === current || q.get('since') === current)) { res.writeHead(304, { ETag: current }); return res.end(); }
  // (Made in slices: a big catalogue takes a second or so to put together, and nobody else should wait for it.)
  // A huge catalogue can take a while to put together (and other profiles' copies are made one at a time): rather
  // than keep the device waiting past what a proxy allows (Cloudflare: 100 s), say "not yet" and let it ask again.
  const making = catalog.payloadAsync(prof);
  const out = await Promise.race([making, new Promise((r) => setTimeout(r, 50e3, null).unref())]);
  if (!out) { res.setHeader('Retry-After', '5'); throw new HttpError(503, 'The catalogue is still being put together.'); }
  // In pages (see Catalog._payloadSteps): page 0 says how many there are, and the device fetches the rest with
  // ?page=N&v=<the ETag of page 0>. A later page of a version that has since been replaced: 409, start again.
  const page = Math.max(0, parseInt(q.get('page'), 10) || 0);
  if (page) {
    const v = q.get('v');
    if (v && v !== out.etag) throw new HttpError(409, 'The catalogue changed while it was loading.');
    if (page >= out.pages.length) throw new HttpError(404, 'That part of the catalogue isn’t there.');
    return sendGz({ headers: { ...req.headers, 'if-none-match': '' } }, res, () => out.raw(page), out.pages[page], 'application/json; charset=utf-8', out.etag);
  }
  // A device that has an older copy asks for just the changes.
  const since = q.get('since');
  if (since && req.headers['if-none-match'] !== out.etag) {
    const d = await catalog.deltaAsync(prof, since);
    if (d && d.same) { res.writeHead(304, { ETag: d.etag }); return res.end(); }
    if (d) return sendGz(req, res, d.raw, d.gz, 'application/json; charset=utf-8', d.etag);
  }
  sendGz(req, res, () => out.raw(0), out.pages[0], 'application/json; charset=utf-8', out.etag);
});
route('GET', '/api/item/:k', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  let it = item(ctx, p.k);
  it = await catalog.details(it.k) || it;
  const have = tmdb.meta.data.m[it.k];
  if (tmdb.enabled() && (it.t === 'movie' || it.t === 'show') && !(have && have.at && have.v === 2)) {
    try { const m = await tmdb.details(it); applyMeta(it, m); } catch {}
  }
  const mt = tmdb.map.data.m[it.k];
  const out = { ...Catalog.compact(it), plot: it.plot || '', cast: it.cast || '', dir: it.dir || '', tr: it.tr || '', poster: it.poster || '', markers: it.t === 'episode' || it.t === 'movie' ? markers.get(it.k) : null, col: it.col || 0, fixed: !!(mt && mt.manual) };
  if (it.t === 'show') {
    const eps = await catalog.episodes(it.k).catch((e) => { out.epsError = 'The provider didn’t send the episodes just now.'; log(`Episodes of “${it.n}”: ${e.message}`); return []; });
    // Each episode's own details from TMDB (titles, plots, pictures, air dates): fetched now when they aren't here
    // yet (a few seconds at most; otherwise they're there next time).
    if (eps.length && tmdb.enabled() && settings().tmdbEpisodes !== 'off') {
      const seasons = [...new Set(eps.map((e) => e.s).filter((n) => Number.isInteger(n)))];
      await Promise.race([tmdb.episodes(it, { seasons }).catch(() => null), new Promise((r) => setTimeout(r, 4000))]);
    }
    out.episodes = withEpisodeMeta(it, eps.map((e) => ({ ...Catalog.compact(e), plot: (e.plot || '').slice(0, 400) })));
  }
  if (it.sk) { const show = catalog.get(it.sk); if (show) out.show = { k: show.k, n: show.n, i: show.logo || '' }; }
  // Others in the household who watched it.
  out.watchedBy = accounts.profiles.filter((x) => x.id !== prof.id && userdata.of(x.id).data.history.some((h) => h.k === it.k || h.sk === it.k)).map((x) => x.id);
  return out;
});
route('GET', '/api/show/:k/episodes', async (req, res, p, q, ctx) => {
  const it = item(ctx, p.k);
  let eps;
  try { eps = await catalog.episodes(it.k); } catch (e) {
    // The provider didn't answer: say so plainly (the page offers to try again).
    throw new HttpError(502, `The provider didn’t send this series’ episodes (${String(e.message || e).replace(/^Couldn’t download it: /, '')}). Try again in a moment.`);
  }
  return withEpisodeMeta(it, eps.map((e) => ({ ...Catalog.compact(e), plot: (e.plot || '').slice(0, 400) })));
});
/** A name that says nothing ("Episode 3", "S01E03", the series' own name): TMDB's episode title is better. */
const plainEpTitle = (t, show) => !t || /^(?:(?:episode|ep\.?|e|folge|cap[ií]tulo|[ée]pisode)\s*\d+|s\d+\s*[ex]\s*\d+|\d+)$/i.test(String(t).trim()) || catalogNorm(t) === catalogNorm(show.n);
/** Episodes (as sent to devices) with TMDB's details of each filled in where the provider's are missing or plain. */
function withEpisodeMeta(show, list) {
  const m = tmdb.eps.data.m[show.k]; // (also with automatic fetching off: what was fetched here)
  if (!m || !m.s) return list;
  return list.map((o) => {
    const x = m.s[o.s] && m.s[o.s][o.e];
    if (!x) return o;
    const [t, plot, still, air, mins, r] = x;
    const out = { ...o, tm: 1 };
    if (t && plainEpTitle(o.et, show)) out.et = t;
    if (plot && !o.plot) out.plot = plot.slice(0, 400);
    if (still && (!o.i || o.i === show.logo || o.i === show.poster)) out.i = still;
    if (air) out.air = air;
    if (mins && !o.d) out.d = mins * 60;
    if (r && !o.r) out.r = r;
    return out;
  });
}
route('GET', '/api/recs', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const r = await recs.fresh(prof.id, q.get('force') ? 0 : 6 * 3600e3);
  return r || { top: [], rows: [], household: [] };
});

// ---- people: search by actor or director
let peopleIdx = null; // { version, people: Map(norm name → { name, words, cast: Set, dir: Set }), byPre: Map(3 letters → [entries]) }
let peopleBuilding = null;
/** Cast and directors → their titles, built in slices (a big catalogue has a few hundred thousand names). */
function peopleIndex() {
  if (peopleIdx && peopleIdx.version === catalog.version) return Promise.resolve(peopleIdx);
  if (!peopleBuilding || peopleBuilding.version !== catalog.version) {
    const version = catalog.version;
    const steps = function* () {
      const people = new Map();
      const byPre = new Map();
      const add = (name, k, role) => {
        const n = String(name || '').trim();
        if (n.length < 3) return;
        const key = n.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        let e = people.get(key);
        if (!e) {
          people.set(key, (e = { key, name: n, words: key.split(/[\s.-]+/).filter(Boolean), cast: new Set(), dir: new Set() }));
          for (const w of new Set(e.words.map((x) => x.slice(0, 3)))) { const l = byPre.get(w); if (l) l.push(e); else byPre.set(w, [e]); }
        }
        e[role].add(k);
      };
      const items = catalog.items;
      for (let i = 0; i < items.length; i++) {
        if ((i & 8191) === 0) yield;
        const it = items[i];
        if (it.t !== 'movie' && it.t !== 'show') continue;
        if (it.cast) for (const c of String(it.cast).split(',').slice(0, 8)) add(c, it.k, 'cast');
        if (it.dir) for (const d of String(it.dir).split(',').slice(0, 3)) add(d, it.k, 'dir');
      }
      return { version, people, byPre };
    };
    const job = { version };
    job.promise = Catalog.runSliced(steps()).then((idx) => { peopleIdx = idx; return idx; }).finally(() => { if (peopleBuilding === job) peopleBuilding = null; });
    peopleBuilding = job;
  }
  // While a new one is made (the catalogue changes every few minutes while TMDB fills in details), the last one does.
  return peopleIdx ? Promise.resolve(peopleIdx) : peopleBuilding.promise;
}
route('GET', '/api/search/people', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const raw = String(q.get('q') || '').trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const toks = raw.split(/[\s.-]+/).filter(Boolean);
  if (!toks.length || raw.length < 3) return [];
  const idx = await peopleIndex();
  const f = catalog.filterFor(prof);
  const hits = [];
  // Only names with a word starting like the longest word typed need checking.
  const longest = toks.slice().sort((a, b) => b.length - a.length)[0];
  const cands = longest.length >= 3 ? idx.byPre.get(longest.slice(0, 3)) || [] : idx.people.values();
  for (const e of cands) {
    const words = e.words;
    // Every word typed starts a word of the name ("tom han", "nolan", "j lawrence").
    if (!toks.every((t) => words.some((w) => w.startsWith(t)))) continue;
    if (toks.length === 1 && toks[0].length < 4 && !words.includes(toks[0])) continue;
    const keys = (role) => [...e[role]].map((k) => catalog.get(k)).filter((it) => it && f.test(it)).sort((a, b) => (b.y || 0) - (a.y || 0)).map((it) => it.k);
    const cast = keys('cast'), dir = keys('dir');
    if (!cast.length && !dir.length) continue;
    const exact = e.key === raw ? 50 : 0;
    hits.push({ name: e.name, role: dir.length > cast.length ? 'dir' : 'cast', cast: cast.slice(0, 60), dir: dir.slice(0, 60), score: exact + cast.length + dir.length * 1.5 });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, 4);
});

// ---- film series (TMDB collections)
route('GET', '/api/collection/:k', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const it = item(ctx, p.k);
  if (!tmdb.enabled() || !it.col) return null;
  const col = await tmdb.collection(it.col).catch(() => null);
  if (!col) return null;
  const f = catalog.filterFor(prof);
  const byTmdb = new Map();
  for (const x of catalog.items) if (x.t === 'movie' && x.tmdb && f.test(x)) { const l = byTmdb.get(String(x.tmdb)) || []; l.push(x); byTmdb.set(String(x.tmdb), l); }
  const allowed = new Set(f.langs || []);
  const best = (l) => l.slice().sort((a, b) => (((b.lg || []).some((x) => allowed.has(x)) ? 1 : 0) - ((a.lg || []).some((x) => allowed.has(x)) ? 1 : 0)))[0];
  for (const part of col.parts) {
    let match = byTmdb.get(String(part.id));
    if (!match) match = catalog.findTitle(part.title, part.year).map((k) => catalog.get(k)).filter((x) => x && x.t === 'movie' && f.test(x) && (!x.y || !part.year || Math.abs(x.y - part.year) <= 1));
    if (match && match.length) part.k = best(match).k;
  }
  return { ...col, have: col.parts.filter((x) => x.k).length };
});

// ---- "wrong details?": pick the right TMDB entry for a title (for everyone)
route('GET', '/api/item/:k/matches', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  if (prof.kids) throw new HttpError(403, 'Ask a grown-up to fix this one.');
  const it = item(ctx, p.k);
  if (!tmdb.enabled()) throw new HttpError(400, 'The admin hasn’t added a TMDB key, so details can’t be looked up.');
  return { current: tmdb.map.data.m[it.k] || null, options: await tmdb.candidates(it, String(q.get('q') || '').slice(0, 100)) };
});
route('POST', '/api/item/:k/match', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  if (prof.kids) throw new HttpError(403, 'Ask a grown-up to fix this one.');
  const it = item(ctx, p.k);
  const b = await readJSON(req);
  if (!b.none && !(Number(b.id) > 0)) throw new HttpError(400, 'Pick one of the suggestions.');
  const m = await tmdb.setMatch(it, b.none ? { none: true } : { id: b.id, type: b.type });
  if (m) applyMeta(it, m);
  else { for (const k of ['plot', 'cast', 'dir', 'bd', 'tmdb', 'poster', 'col']) delete it[k]; }
  log(`${prof.name} corrected the details of “${it.n}”${m ? ` → ${m.title} (${m.y})` : ' (no match)'}`);
  catalog.metaChanged();
  hub.toAll('catalog', { version: catalog.version });
  for (const pr of accounts.profiles) recs.touch(pr.id, 10000);
  return { ok: true, item: Catalog.compact(it) };
});

// ---- something for several of you
route('GET', '/api/recs/group', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const ids = [...new Set([prof.id, ...String(q.get('ids') || '').split(',')])].filter((id) => accounts.profile(id)).slice(0, 8);
  if (ids.length < 2) throw new HttpError(400, 'Pick at least one other person.');
  const f = catalog.filterFor(prof);
  const each = await Promise.all(ids.map((id) => recs.fresh(id, 6 * 3600e3).catch(() => null)));
  const score = new Map(); // key → [score per profile]
  each.forEach((r, i) => {
    if (!r) return;
    const ranked = [...(r.top || [])];
    for (const row of r.rows || []) for (const k of row.keys || []) if (!ranked.includes(k)) ranked.push(k);
    ranked.slice(0, 400).forEach((k, pos) => { const a = score.get(k) || new Array(ids.length).fill(0); a[i] = Math.max(a[i], 1 - pos / 400); score.set(k, a); });
  });
  const seen = new Set();
  const disliked = new Set();
  for (const id of ids) {
    const d = userdata.of(id).data;
    for (const h of d.history) { seen.add(h.k); if (h.sk) seen.add(h.sk); }
    for (const [k, v] of Object.entries(d.ratings)) if (v < 0) disliked.add(k);
    for (const k of d.hidden) disliked.add(k);
  }
  const out = [];
  for (const [k, a] of score) {
    if (seen.has(k) || disliked.has(k)) continue;
    const it = catalog.get(k);
    if (!it || !f.test(it) || (it.t !== 'movie' && it.t !== 'show')) continue;
    // Everyone should like it: the least keen person counts most.
    const min = Math.min(...a), mean = a.reduce((x, y) => x + y, 0) / a.length;
    if (min <= 0) continue;
    out.push([k, min * 0.7 + mean * 0.3]);
  }
  // Nothing in common yet: the best of each person's picks, taking turns.
  if (out.length < 12) {
    for (let pos = 0; pos < 30; pos++) for (const r of each) { const k = r && r.top && r.top[pos]; if (k && !seen.has(k) && !disliked.has(k) && !out.some((x) => x[0] === k)) { const it = catalog.get(k); if (it && f.test(it)) out.push([k, -pos]); } }
  }
  out.sort((x, y) => y[1] - x[1]);
  return { ids, keys: out.slice(0, 40).map((x) => x[0]), common: out.filter((x) => x[1] > 0).length };
});

// ---- a new profile says what it likes (so recommendations are good from the start)
route('GET', '/api/onboard', (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const f = catalog.filterFor(prof);
  const pop = new Map();
  for (const pr of accounts.profiles) for (const h of userdata.of(pr.id).data.history.slice(0, 300)) { const k = h.sk || h.k; pop.set(k, (pop.get(k) || 0) + 1); }
  const year = new Date().getFullYear();
  const cands = [];
  for (const it of catalog.items) {
    if ((it.t !== 'movie' && it.t !== 'show') || !f.test(it) || !(it.poster || it.logo) || !it.gn || !it.gn.length) continue;
    const r = it.r || 0;
    if (r < 6.3 && !pop.has(it.k)) continue;
    const recent = it.y ? Math.max(0, 1 - (year - it.y) / 30) : 0.3;
    cands.push([it, r / 10 + recent * 0.6 + Math.min(1, (pop.get(it.k) || 0) / 3) + (it.tmdb ? 0.2 : 0)]);
  }
  cands.sort((a, b) => b[1] - a[1]);
  // A spread across genres, films and series.
  const per = new Map();
  const out = [];
  for (const [it] of cands) {
    const g = it.gn[0] + it.t;
    if ((per.get(g) || 0) >= 4) continue;
    per.set(g, (per.get(g) || 0) + 1);
    out.push(it.k);
    if (out.length >= 48) break;
  }
  return { keys: out };
});
route('POST', '/api/onboard', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readJSON(req);
  for (const k of (Array.isArray(b.keys) ? b.keys : []).slice(0, 30)) if (catalog.get(String(k))) userdata.rate(prof.id, String(k), 1);
  userdata.setPrefs(prof.id, { onboarded: true });
  recs.touch(prof.id, 500);
  changed(ctx, prof, 'ratings');
  return { ok: true };
});
route('GET', '/api/me/week', (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const days = userdata.week(prof.id, 14);
  const d = userdata.of(prof.id).data;
  const since = Date.now() - 7 * 86400e3;
  const top = new Map();
  for (const h of d.history) { if (h.at < since) break; const k = h.sk || h.k; top.set(k, (top.get(k) || 0) + (h.s || 0)); }
  return { days, top: [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, s]) => ({ k, s, n: (catalog.get(k) || {}).n || '' })) };
});
route('DELETE', '/api/new-episodes/:sk', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); if (userdata.clearNewEpisodes(prof.id, p.sk)) changed(ctx, prof, 'newEps'); return { ok: true }; });

// ---- guide
const nowCache = new Map();
function epgVisible(prof) {
  const f = catalog.filterFor(prof);
  const locked = overrides.hasLocks ? (it) => overrides.isLocked(it) : () => false;
  return catalog.items.filter((it) => it.epg && (it.t === 'live' || it.t === 'radio') && f.test(it) && !locked(it));
}
/** A channel's own guide shift in ms (tvg-shift plus the admin's offset): the device applies it to /api/epg data. */
const chanShift = (it) => ((it.sh || 0) + (it.eoff || 0)) * 3600e3;
const progOut = (x) => { const o = { s: x.s, e: x.e, t: x.t }; if (x.st) o.st = x.st; if (x.d) o.d = x.d.length > 320 ? x.d.slice(0, 320) + '…' : x.d; if (x.c) o.c = x.c; if (x.ep) o.ep = x.ep; if (x.ic) o.ic = x.ic; if (x.n) o.n = 1; if (x.r) o.r = x.r; return o; };
route('GET', '/api/epg/now', (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const ck = catalog.version + catalog.filterFor(prof).sig;
  const hit = nowCache.get(ck);
  if (hit && Date.now() - hit.t < 60e3) return sendGz(req, res, hit.raw, hit.gz, 'application/json; charset=utf-8');
  const now = Date.now();
  const out = {};
  for (const it of epgVisible(prof)) {
    // (In the guide's own times: a channel shown some hours shifted needs its window moved by as much.)
    const sh = chanShift(it);
    const list = epg.range(it.epg, now - 3 * 3600e3 - sh, now + 8 * 3600e3 - sh);
    if (list.length) out[it.k] = list.map(progOut);
  }
  const raw = Buffer.from(JSON.stringify({ at: now, p: out }));
  const entry = { t: Date.now(), raw, gz: zlib.gzipSync(raw, { level: 5 }) };
  nowCache.set(ck, entry);
  if (nowCache.size > 20) nowCache.delete(nowCache.keys().next().value);
  sendGz(req, res, entry.raw, entry.gz, 'application/json; charset=utf-8');
});
route('GET', '/api/epg/range', (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const from = Number(q.get('from')) || Date.now() - 3600e3;
  const keys = String(q.get('keys') || '').split(',').slice(0, 400);
  // At most 3 days at a time for many channels (the guide); a channel's own page asks for its catch-up week too (it
  // used to get only the oldest 3 days of that, so it said "No guide information").
  const to = Math.min(Number(q.get('to')) || from + 6 * 3600e3, from + (keys.length <= 4 ? 12 : 3) * 86400e3);
  const out = {};
  for (const k of keys) {
    const it = catalog.visible(prof, k);
    if (it && it.epg && !(overrides.hasLocks && overrides.isLocked(it) && !overrides.allowed(ctx))) out[k] = epg.range(it.epg, from, to).map(progOut);
  }
  sendJsonGz(req, res, out);
});
route('GET', '/api/epg/search', (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const needle = String(q.get('q') || '').trim().toLowerCase();
  if (needle.length < 2) return [];
  const now = Date.now();
  const hits = [];
  for (const it of epgVisible(prof)) {
    const sh = chanShift(it);
    for (const x of epg.range(it.epg, now - 7 * 86400e3 - sh, now + 8 * 86400e3 - sh)) {
      if (String(x.t).toLowerCase().includes(needle) || (x.st && x.st.toLowerCase().includes(needle))) { const o = progOut(x); o.s += sh; o.e += sh; hits.push({ k: it.k, ...o }); }
    }
    if (hits.length > 600) break;
  }
  hits.sort((a, b) => Math.abs(a.s - now) - Math.abs(b.s - now));
  return hits.slice(0, 150);
});

// ---- your data
route('POST', '/api/progress', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readJSON(req);
  const rec = userdata.progress(prof.id, b);
  hub.toProfile(prof.id, 'progress', { k: b.k, rec }, ctx.conn);
  return rec || {};
});
route('POST', '/api/played', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readObj(req);
  userdata.played(prof.id, b);
  recs.touch(prof.id);
  changed(ctx, prof, 'history');
  if (b.k) markers.want(b.k);
  return { ok: true };
});
route('POST', '/api/toggle', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const { field, k, on } = await readJSON(req);
  if (!['list', 'favs', 'hidden'].includes(field)) throw new HttpError(400, 'Unknown list');
  const v = userdata.toggle(prof.id, field, String(k), on);
  if (field !== 'favs') recs.touch(prof.id, 5000);
  hub.toProfile(prof.id, 'data', { field }, ctx.conn);
  return { on: v };
});
// Tell this profile's other devices that something changed, so they show it without a reload.
const changed = (ctx, prof, field) => hub.toProfile(prof.id, 'data', { field }, ctx.conn);
route('POST', '/api/rate', async (req, res, p, q, ctx) => { const prof = requireProfile(ctx); const { k, v } = await readJSON(req); userdata.rate(prof.id, String(k), Number(v) || 0); recs.touch(prof.id, 3000); changed(ctx, prof, 'ratings'); return { ok: true }; });
route('POST', '/api/bookmarks', async (req, res, p, q, ctx) => { const prof = requireProfile(ctx); const r = userdata.addBookmark(prof.id, await readJSON(req)); changed(ctx, prof, 'bookmarks'); return r; });
route('PUT', '/api/bookmarks/:id', async (req, res, p, q, ctx) => { const prof = requireProfile(ctx); const r = userdata.editBookmark(prof.id, p.id, (await readJSON(req)).note); changed(ctx, prof, 'bookmarks'); return r; });
route('DELETE', '/api/bookmarks/:id', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); userdata.removeBookmark(prof.id, p.id); changed(ctx, prof, 'bookmarks'); return { ok: true }; });
route('POST', '/api/reminders', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readJSON(req);
  const list = b.add || b.remove ? userdata.reminder(prof.id, b) : (userdata.setReminders(prof.id, b.list), null);
  changed(ctx, prof, 'reminders');
  return { ok: true, list };
});
route('POST', '/api/searches', async (req, res, p, q, ctx) => { userdata.addSearch(requireProfile(ctx).id, (await readJSON(req)).q); return { ok: true }; });
route('DELETE', '/api/searches', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); userdata.removeSearch(prof.id, q.get('q') || ''); changed(ctx, prof, 'searches'); return { ok: true }; });
route('POST', '/api/impressions', async (req, res, p, q, ctx) => { userdata.impressions(requireProfile(ctx).id, (await readJSON(req)).keys); return { ok: true }; });
route('PUT', '/api/home', async (req, res, p, q, ctx) => { const prof = requireProfile(ctx); const r = userdata.setHome(prof.id, await readJSON(req)); changed(ctx, prof, 'home'); return r; });
route('DELETE', '/api/history', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); userdata.clearHistory(prof.id, q.get('k') || '', q.get('progress') === '1'); recs.touch(prof.id, 3000); changed(ctx, prof, 'history'); return { ok: true }; });

// ---- playback
function relayable(it, url) {
  if (!url) return true;
  if (p4.relayable(it, url)) return true;
  const hosts = new Set();
  const add = (u) => { try { hosts.add(new URL(u).host); } catch {} };
  add(it.u);
  for (const a of it.alts || []) add(a.u);
  if (it.cu && it.cu.source) add(it.cu.source);
  let h;
  try { h = new URL(url).host; } catch { return false; }
  return hosts.has(h);
}
route('POST', '/api/play/relay', async (req, res, p, q, ctx) => {
  const b = await readJSON(req);
  const it = item(ctx, String(b.k || ''));
  const src = inputOf(it, Number.isInteger(b.alt) ? b.alt : -1, b.url || '');
  if (!src || src.local) throw new HttpError(400, 'Nothing to relay');
  if (b.url && !relayable(it, b.url)) throw new HttpError(403, 'That address doesn’t belong to this channel');
  if (!isUrl(src.input)) throw new HttpError(400, 'Only web addresses can be relayed');
  const hdr = { h: src.headers };
  const out = { url: proxy.sign(src.input, hdr) };
  if (b.check) await proxy.check(src.input, hdr);
  if (b.sniff) Object.assign(out, await proxy.sniff(src.input, hdr));
  return out;
});
// How can this viewer's browser get the stream straight from the provider? (see lib/reach.js)
route('POST', '/api/play/reach', async (req, res, p, q, ctx) => {
  const b = await readJSON(req);
  const it = item(ctx, String(b.k || ''));
  if (b.url && !relayable(it, b.url)) throw new HttpError(403, 'That address doesn’t belong to this channel');
  const src = inputOf(it, Number.isInteger(b.alt) ? b.alt : -1, b.url || '', { raw: true });
  if (!src || src.local || !isUrl(src.input)) throw new HttpError(400, 'Not a web address');
  const origin = typeof b.origin === 'string' && /^https?:\/\/[^/]+$/.test(b.origin) ? b.origin : `${req.secure ? 'https' : 'http'}://${req.headers.host}`;
  if (b.forget) { reach.forget(src.input, origin); return { ok: true }; }
  const alt = Number.isInteger(b.alt) ? b.alt : -1;
  // Through the stream relay: the device fetches from the relay, which sends the headers the provider needs and lets
  // web pages read the answer — so it plays "directly" without this server or the provider's permission.
  if (relayOf.uses(srcList(it, alt))) {
    const a = alt >= 0 && it.alts && it.alts[alt] ? it.alts[alt] : { u: it.u, h: it.h };
    const raw = b.url || a.u;
    const headers = { ...(settings().userAgent ? { 'User-Agent': settings().userAgent } : {}), ...(a.h || {}) };
    let kind = kindOfUrl(raw) || (it.t === 'live' && xtreamHls(raw) ? 'ts' : '');
    // No telling from the name: ask (through this server's proxy) what it is.
    let info = null;
    if (!kind) { info = await reach.check(raw, { h: a.h || {} }, origin, '', { limit: connLimit(it, alt), formats: listFormats(it, alt), mixedOk: true }).catch(() => null); kind = (info && info.kind) || 'ts'; }
    const finite = it.t === 'movie' || it.t === 'episode' || it.t === 'catchup' || !!(info && info.finite);
    // Films and episodes (one file, not HLS): the relay fetches them whole onto its disk and plays them from there, so
    // seeking is instant and the provider connection is free again once it's all there (see relayFinished below).
    const whole = (it.t === 'movie' || it.t === 'episode') && kind !== 'hls' ? { whole: true, k: it.k, alt, list: srcList(it, alt), len: it.d || 0 } : null;
    const out = { kind, finite, mse: true, url: relayOf.wrap(raw, headers, whole), blocked: '', split: false, splitUrl: '', relay: true, alt: null };
    // Xtream live channels in MPEG-TS are also served as HLS (better on phones and TVs): that through the relay too.
    const xh = it.t === 'live' && kind === 'ts' ? xtreamHls(raw) : '';
    if (xh) out.alt = { url: relayOf.wrap(xh, headers), mse: true, split: false };
    if (kind === 'ffmpeg' || kind === 'native') { const cx = (await copyCodecs(it, alt).catch(() => null)) || (kind === 'ffmpeg' && (it.t === 'movie' || it.t === 'episode') ? await sniffCodecs(it, alt) : null); if (cx) out.codecs = cx; }
    return out;
  }
  if (videoViaProxy(srcList(it, alt))) return { kind: '', url: src.input, blocked: 'proxy' };
  const out = await reach.check(src.input, { h: src.headers }, origin, typeof b.ua === 'string' ? b.ua.slice(0, 300) : '', { limit: connLimit(it, alt), formats: listFormats(it, alt), mixedOk: !!b.mixedOk });
  // Films and episodes: Chrome and Edge play many MKV files themselves when the codecs suit — the provider says which.
  if (out.kind === 'ffmpeg' || out.kind === 'native') {
    const cx = (await copyCodecs(it, alt).catch(() => null)) || (out.kind === 'ffmpeg' && (it.t === 'movie' || it.t === 'episode') && !out.blocked ? await sniffCodecs(it, alt) : null);
    if (cx) out.codecs = cx;
  }
  return out;
});
/** Which list a copy of an item comes from. */
function srcList(it, alt = -1) { return alt >= 0 && it.alts && it.alts[alt] ? it.alts[alt].l : it.src; }
/**
 * Admin → Lists: for each list, its live channels, series and films once duplicates are combined, and how many of
 * those no other list has ([count, only here] each). Worked out in slices after a catalogue change; the last counts
 * are shown meanwhile.
 */
let listCounts = { version: null, by: null, pending: null };
function listCountsNow() {
  if (catalog && listCounts.version !== catalog.version && !listCounts.pending) {
    const items = catalog.items, v = catalog.version;
    listCounts.pending = (async () => {
      const by = {};
      const kind = { live: 'live', radio: 'live', movie: 'movie', show: 'show' };
      for (let i = 0; i < items.length; i++) {
        if ((i & 8191) === 0) await new Promise((r) => setImmediate(r));
        const it = items[i], t = kind[it.t];
        if (!t) continue;
        const ids = new Set();
        if (it.src) ids.add(it.src);
        for (const a of it.alts || []) if (a.l) ids.add(a.l);
        for (const x of it.xts || []) if (x && x.l) ids.add(x.l);
        for (const id of ids) {
          const c = by[id] || (by[id] = { live: [0, 0], show: [0, 0], movie: [0, 0] });
          c[t][0]++;
          if (ids.size === 1) c[t][1]++;
        }
      }
      if (items === catalog.items) listCounts.version = v;
      listCounts.by = by;
    })().catch((e) => log('List counts:', e.message)).finally(() => { listCounts.pending = null; });
  }
  return listCounts.by;
}
/** Streams the household is watching right now from each list (direct or through the server). */
/** Filled in by lib/routes-p12.js (the DVR): recordings running now, and "rec:<id>" items. */
const dvrHooks = { dvrConns: null, dvrItem: null, dvrOwnerOk: null };
// Live TV that other apps (Plex, Jellyfin… through the HDHomeRun tuner) are watching right now: set once the
// outputs exist (lib/routes-p4.js).
let otherAppConns = () => [];
function listUsage() {
  // (Recordings running now, and other apps' tuner streams, hold a provider connection too.)
  const conns = [...hub.conns, ...(dvrHooks.dvrConns ? dvrHooks.dvrConns() : []), ...otherAppConns()];
  return usageOf(conns, { listOf: (k, alt) => { const it = catalog.get(k); return it ? srcList(it, alt) : ''; }, sharedPartyOf: p2Hooks.sharedPartyOf, freed: relayFinished.freed, pooled: relayFinished.pooled });
}
// Connections in use per provider, every minute (Admin → Statistics → Watching at once).
const concurrency = new Concurrency(D, {
  usage: () => listUsage(),
  lists: () => lists.all().filter((l) => l.type !== 'folder').map((l) => ({ id: l.id, name: l.name })),
  limitOf: (id) => { const l = lists.store.data.lists.find((x) => x.id === id); const m = measuredLimit(l, 'live'); if (m !== null) return m; const n = parseInt(l && l.account && l.account.maxConnections, 10); return n > 0 ? n : 0; },
  extra: (id) => relayFinished.extra(id),
});
/**
 * Films and episodes through the stream relay. Every 10 s (5 s while any play) the server asks the relay which it has
 * whole on its disk — their viewers no longer use a provider connection, so those don't count towards the list's limit
 * — and tells it what's still being played, so it stops fetching films nobody watches.
 *
 * A relay 5 also shares each provider account's connections between the films of that account: the server tells it
 * how many it may use (the account's limit, less what everyone else is watching from it — at least one), and the relay
 * switches between the films so that every viewer has 10 minutes ready. Together those films then count as one
 * connection here (lib/usage.js), so another film of the same account can start instead of being "busy". The times the
 * relay couldn't keep up are kept for Admin → Statistics.
 */
const relayFinished = (() => {
  let done = new Set(), busy = false, downloading = false, v5 = false, seq = 0, runs = new Map(), timer = null;
  let serving = new Set(); // films the relay is actually fetching or serving for someone (only those share its connections)
  // Just started (a restart): not every device has said what it's watching yet, so for a minute the relay keeps the
  // shares it had — it mustn't take a connection a live viewer is still using.
  const bootAt = Date.now();
  const isFilm = (pl) => {
    if (!pl || !pl.k) return null;
    const it = catalog.get(pl.k);
    const alt = Number.isInteger(pl.alt) ? pl.alt : -1;
    return it && (it.t === 'movie' || it.t === 'episode') && relayOf.uses(srcList(it, alt)) ? { it, alt } : null;
  };
  const playingIds = () => {
    const ids = new Set();
    const add = (pl) => { const f = isFilm(pl); if (f) ids.add(playId(pl.k, f.alt)); };
    for (const c of hub.conns) { add(c.playing); for (const t of c.multi || []) add(t); }
    return ids;
  };
  /** The connections each list's films may share: its limit less everyone else watching from it (at least 1). */
  const budgets = () => {
    const out = {};
    let use = null;
    for (const l of lists.all()) {
      if (l.type === 'folder' || !relayOf.uses(l.id)) continue;
      const ms = [measuredLimit(l, 'movie'), measuredLimit(l, 'episode')].filter((x) => x !== null);
      const lim = ms.length ? (ms.includes(0) ? Math.max(...ms) : Math.min(...ms)) : (parseInt(l.account && l.account.maxConnections, 10) || 0);
      if (!(lim > 0)) continue;
      if (!use) use = listUsage();
      const others = (use.get(l.id) || []).filter((c) => !c.relayShared).length;
      out[acctId(l.id)] = Math.max(1, lim - others);
    }
    return out;
  };
  const poll = async () => {
    const r = relayOf.conf();
    if (busy || !r) { if (!r) { done = new Set(); runs = new Map(); } return; }
    const ids = playingIds();
    if (!ids.size && !downloading) { done = new Set(); runs = new Map(); return; }
    busy = true;
    try {
      const j = await relayDownloads(r.url, r.secret, [...ids], fetch, { budget: Date.now() - bootAt > 60000 ? budgets() : null, since: seq, full: true });
      if (!j) return;
      const next = new Set();
      for (const f of j.films) if (f.done) for (const i of f.ids || []) next.add(i);
      done = next;
      downloading = j.films.some((f) => f.downloading);
      v5 = Number(j.version) >= 5;
      const sv = new Set();
      for (const f of j.films) if (f.readers > 0 || f.downloading) for (const i of f.ids || []) sv.add(i);
      serving = sv;
      if ((Number(j.seq) || 0) < seq) seq = 0; // (the relay started again: its numbering too)
      // Which list each account id is (the relay only knows the ids).
      const byAcct = new Map(lists.all().map((l) => [acctId(l.id), l.id]));
      runs = new Map();
      for (const [a, x] of Object.entries(j.accounts || {})) if (byAcct.has(a)) runs.set(byAcct.get(a), Number(x.runs) || 0);
      for (const e of j.strain) {
        if (e.seq <= seq) continue;
        const lid = byAcct.get(e.a) || '';
        concurrency.relayStrain(lid, e);
        log(`The stream relay couldn’t keep up${lid ? ' with ' + ((lists.all().find((l) => l.id === lid) || {}).name || 'a list') : ''}: ${e.viewers} watching, ${e.runs}${e.budget ? ' of ' + e.budget : ''} connections.`);
      }
      seq = Math.max(seq, j.seq || 0);
    } finally { busy = false; }
  };
  const tick = () => { timer = setTimeout(() => { poll().catch(() => {}).finally(tick); }, playingIds().size ? 5000 : 10000); timer.unref(); };
  tick();
  let poked = null;
  return {
    freed: (pl) => {
      if (!done.size || !pl || !pl.k) return false;
      return done.has(playId(pl.k, Number.isInteger(pl.alt) ? pl.alt : -1));
    },
    /**
     * A film the relay 5 fetches whole for this play (it shares the account's connections with the others) — going by
     * what the relay itself reports, so a film that plays some other way (HLS, through this server, a watch party)
     * still counts as a connection of its own.
     */
    pooled: (pl) => { if (!v5 || !isFilm(pl)) return false; return serving.has(playId(pl.k, Number.isInteger(pl.alt) ? pl.alt : -1)); },
    /** Whether a new film from this list would join the relay's shared connections (not an HLS one: those aren't whole). */
    joins: (it, alt) => {
      if (!v5 || !(it.t === 'movie' || it.t === 'episode') || !relayOf.uses(srcList(it, alt))) return false;
      const u = alt >= 0 && it.alts && it.alts[alt] ? it.alts[alt].u : it.u;
      return kindOfUrl(u) !== 'hls';
    },
    /** Connections the relay uses for a list beyond the one its films count as. */
    extra: (listId) => Math.max(0, (runs.get(listId) || 0) - 1),
    /** Something started or stopped: tell the relay soon (a live channel on the same account takes a connection). */
    poke: (now) => {
      if (!relayOf.conf()) return;
      if (now) { clearTimeout(poked); poked = null; poll().catch(() => {}); return; } // (someone is about to start: tell the relay at once)
      if (poked) return;
      poked = setTimeout(() => { poked = null; poll().catch(() => {}); }, 3000); poked.unref();
    },
  };
})();
/** Filled in by feature modules (lib/routes-p2.js): watch-party connection sharing. */
const p2Hooks = { sharedPartyOf: null, partyShareDefault: null };
/** Filled in by lib/routes-p9.js (channel health): each play's outcome, and which copy of a channel to try first. */
const p9Hooks = { played: null, rank: null };
/**
 * What's inside one copy of a film or episode — { v: 'h264', a: 'ac3', pix } — as its Xtream provider describes it
 * (episodes carry it from the series details; films ask get_vod_info once, cached for a week). null when unknown.
 */
const codecMemo = new Map();
// Matroska's names for what's inside (the track list is near the start of the file).
const MKV_V = [['V_MPEGH/ISO/HEVC', 'hevc'], ['V_MPEG4/ISO/AVC', 'h264'], ['V_AV1', 'av1'], ['V_VP9', 'vp9'], ['V_VP8', 'vp8'], ['V_MPEG2', 'mpeg2video'], ['V_MPEG4/ISO/', 'mpeg4']];
const MKV_A = [['A_EAC3', 'eac3'], ['A_AC3', 'ac3'], ['A_DTS', 'dts'], ['A_TRUEHD', 'truehd'], ['A_AAC', 'aac'], ['A_OPUS', 'opus'], ['A_VORBIS', 'vorbis'], ['A_FLAC', 'flac'], ['A_MPEG/L3', 'mp3'], ['A_MPEG/L2', 'mp2'], ['A_PCM', 'pcm']];
/** An MKV's picture and (first) sound codec from its first bytes: { v, a, pix: '' }, or null when they aren't there. */
function mkvCodecs(buf) {
  const s = buf.toString('latin1');
  const first = (list) => { let best = null; for (const [id, name] of list) { const i = s.indexOf(id); if (i >= 0 && (!best || i < best.i)) best = { i, name }; } return best ? best.name : ''; };
  const v = first(MKV_V);
  return v ? { v, a: first(MKV_A), pix: '' } : null;
}
/**
 * An MKV whose provider doesn't say what's inside (a playlist's episodes, most films): its first 256 KB are read —
 * through the stream relay when the list uses it — to see. Then a browser that plays such files itself (Chrome, Edge)
 * can play it straight from the relay instead of having it converted on this server. Remembered per address.
 */
async function sniffCodecs(it, alt = -1) {
  const src = inputOf(it, alt, '', { raw: true });
  if (!src || src.local || !isUrl(src.input) || !/\.(mkv|webm)(?:[?#]|$)/i.test(src.input)) return null;
  const key = 'sniff:' + src.input;
  if (codecMemo.has(key)) return codecMemo.get(key);
  const viaRelay = relayOf.uses(srcList(it, alt));
  const url = viaRelay ? relayOf.wrap(src.input, src.headers || {}) : src.input;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  let cx = null, read = false;
  try {
    const r = await fetchAny(url, { headers: { ...(viaRelay ? {} : src.headers || {}), Range: 'bytes=0-262143' }, signal: ac.signal });
    if (r.ok && r.body) {
      const parts = [];
      let n = 0;
      for await (const c of r.body) { parts.push(Buffer.from(c)); n += c.length; if (n >= 262144) break; }
      cx = mkvCodecs(Buffer.concat(parts));
      read = n >= 65536;
    }
  } catch {} finally { clearTimeout(timer); ac.abort(); }
  // (Not remembered when it couldn't be read — the account busy, say: asked again next time.)
  if (codecMemo.size > 5000) codecMemo.clear();
  if (cx || read) codecMemo.set(key, cx);
  // (A one-connection account: give the provider a moment to free that connection before the device opens its own.)
  if (cx && oneConnection(it, alt)) await new Promise((ok) => setTimeout(ok, 1200));
  return cx;
}
async function copyCodecs(it, alt = -1) {
  const a = alt >= 0 && it.alts && it.alts[alt] ? it.alts[alt] : null;
  if (it.t === 'episode') return (a ? a.cx : it.cx) || null;
  if (it.t !== 'movie') return null;
  const url = a ? a.u : it.u;
  const m = /\/movie\/[^/]+\/[^/]+\/(\d+)\.\w+(?:\?|$)/.exec(url || '');
  const lid = a ? a.l : (it.xt && it.xt.l) || it.src;
  const id = a ? m && m[1] : (it.xt && it.xt.id) || (m && m[1]);
  const l = lid && lists.all().find((x) => x.id === lid);
  if (!id || !l || l.type !== 'xtream') return null;
  const key = `${lid}:${id}`;
  if (codecMemo.has(key)) return codecMemo.get(key);
  const info = await lists.xtVod(lid, id);
  const v = (info && info.video) || {}, au = (info && info.audio) || {};
  const cx = v.codec_name ? { v: String(v.codec_name).toLowerCase(), a: String(au.codec_name || '').toLowerCase(), pix: String(v.pix_fmt || '') } : null;
  if (codecMemo.size > 5000) codecMemo.clear();
  codecMemo.set(key, cx);
  return cx;
}
/**
 * How well this browser can play one copy straight from the provider: 0 as it is, 1 probably as it is (an MKV
 * Chrome/Edge plays, MPEG-TS), 2 by converting it in the browser, 3 only by converting on the server.
 * caps: what the browser said it can do { mkv, hevc, vp9, av1, ac3, eac3, mb }.
 */
function playScore(url, cx, caps) {
  const ext = (((url || '').split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1] || '').toLowerCase();
  const vOk = !cx || (cx.v === 'h264' && !/10|12|422|444/.test(cx.pix || '')) || (cx.v === 'hevc' && caps.hevc) || (cx.v === 'vp9' && caps.vp9) || (cx.v === 'av1' && caps.av1);
  const aOk = !cx || !cx.a || ['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(cx.a) || (cx.a === 'ac3' && caps.ac3) || (cx.a === 'eac3' && caps.eac3);
  const mbAudio = cx && ['ac3', 'eac3', 'flac', 'aac', 'mp3', 'opus', 'vorbis'].includes(cx.a); // what the browser can convert
  if (/^(mp4|m4v|mov|webm|m3u8)$/.test(ext)) return vOk && aOk ? 0 : vOk && caps.mb && mbAudio ? 2 : 3;
  if (ext === 'mkv') {
    if (!cx) return caps.mkv ? 1 : caps.mb ? 2 : 3;
    if (vOk && aOk && caps.mkv) return 1;
    return vOk && caps.mb && mbAudio ? 2 : 3;
  }
  if (ext === 'ts' || !ext) return cx && !aOk ? (caps.mb && mbAudio ? 2 : 3) : 1;
  return 3; // AVI, WMV…
}

/**
 * Which copy of a title to play first: copies whose provider has a free connection, and that this page can play
 * straight from the provider (an https page can't play http streams directly). When every copy's provider is busy
 * with someone in the household, say who — so the viewer can take over or wait.
 */
route('POST', '/api/play/sources', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readJSON(req);
  const it = item(ctx, String(b.k || ''));
  const https = /^https:/i.test(String(b.origin || ''));
  const use = listUsage();
  const out = [];
  const copies = [-1, ...(it.alts || []).map((x, i) => i)];
  // Films and episodes: also what each copy's file is like, so the one this browser plays as it is goes first
  // (the same episode is often an MP4 on one provider and an MKV with Dolby sound on another).
  const caps = b.caps && typeof b.caps === 'object' ? b.caps : null;
  const vodItem = it.t === 'movie' || it.t === 'episode';
  const cxs = caps && vodItem && copies.length > 1
    ? await Promise.race([Promise.all(copies.map((alt) => copyCodecs(it, alt).catch(() => null))), new Promise((r) => setTimeout(() => r(copies.map(() => null)), 2500))])
    : copies.map(() => null);
  // Priority profiles: when a provider has no free connection, a priority viewer takes one from someone on a standard
  // profile (their player stops and says who needed it). Standard viewers can't take one from a priority viewer.
  const mePri = !!prof.priority;
  // (The films the stream relay shares connections for count as one entry: its plays are in `viewers`.)
  const members = (c) => (c.relayShared ? c.viewers : [c]);
  const isPri = (c) => members(c).some((v) => !!(accounts.profile(v.pid) || {}).priority);
  const mineOnly = (c) => members(c).every((v) => v.id === ctx.conn && !v.tile);
  for (const alt of copies) {
    const lid = srcList(it, alt);
    const l = lid && lists.all().find((x) => x.id === lid);
    const url = alt >= 0 ? it.alts[alt].u : it.u;
    const limit = connLimit(it, alt);
    const joins = relayFinished.joins(it, alt); // (a film the relay shares connections for: the others don't hold it up)
    const users = (use.get(lid) || []).filter((c) => !mineOnly(c) && !(joins && c.relayShared)); // (this device's multiview tiles do count)
    let busy = limit > 0 && users.length >= limit;
    const who = (c) => ({ conn: c.id, pid: c.pid, name: (accounts.profile(c.pid) || {}).name || '', device: c.deviceName, n: c.playing.n, k: c.playing.k, tile: !!c.tile, mine: c.pid === prof.id, priority: isPri(c) });
    // (Taking the relay's shared connection back means stopping every film on it.)
    const whoAll = (c) => members(c).map((v) => who({ ...c, id: v.id, pid: v.pid, tile: v.tile, relayShared: false }));
    let bump = [], locked = false;
    if (busy) {
      const need = users.length - limit + 1;
      // Your own other devices first, then whoever started watching most recently.
      // (A recording is never bumped.)
      const ownAll = (c) => members(c).every((v) => v.pid === prof.id);
      const standard = users.filter((c) => !c.rec && !isPri(c) && !ownAll(c));
      const own = users.filter((c) => !c.rec && ownAll(c));
      if (mePri && own.length + standard.length >= need) {
        bump = [].concat(...[...own, ...standard.slice().sort((p1, p2) => (p2.playing.at || 0) - (p1.playing.at || 0))].slice(0, need).map(whoAll));
        busy = false;
      } else if (!mePri) {
        // Taking over is only possible from standard viewers (or yourself).
        locked = users.filter((c) => !c.rec && (!isPri(c) || ownAll(c))).length < need;
      }
    }
    const mixed = https && /^http:/i.test(url || '') && !b.mixedOk;
    out.push({
      alt, list: lid || '', name: (l && l.name) || '', limit, busy, mixed, proxy: videoViaProxy(lid),
      fmt: caps && vodItem ? playScore(url, cxs[copies.indexOf(alt)], caps) : 0,
      by: busy || bump.length ? users.map(who) : [],
      bump, locked,
    });
  }
  // Free first (a copy that needs someone bumped after a truly free one); then the admin's preferred backup and copies
  // that work (channel health); then ones this page can play directly; then the list order.
  const hr = p9Hooks.rank ? p9Hooks.rank(it) : null;
  const order = out.slice().sort((x, y) => (x.busy - y.busy) || (!!x.bump.length - !!y.bump.length) || (hr ? hr(x.alt) - hr(y.alt) : 0) || (x.mixed - y.mixed) || (x.proxy - y.proxy) || (x.fmt - y.fmt) || (copies.indexOf(x.alt) - copies.indexOf(y.alt)));
  const allBusy = out.every((x) => x.busy);
  // About to start on an account whose films the relay shares: it hears about the new viewer now, not in a few seconds.
  if (!allBusy && out.some((x) => !x.busy && (use.get(x.list) || []).some((c) => c.relayShared))) relayFinished.poke(true);
  if (allBusy && out.length) concurrency.turnedAway(ctx.sess.id + '|' + it.k, out.map((x) => x.list)); // (Statistics: turned away)
  return { sources: order, allBusy, directAddress: settings().directAddress || '' };
});
// Playback statistics: the player says which route it used and for how long (Admin → Statistics).
route('POST', '/api/stats/play', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readJSON(req);
  let provider = '', type = '', it = null;
  try {
    it = item(ctx, String(b.k || ''));
    type = it.t;
    const src = inputOf(it, Number.isInteger(b.alt) ? b.alt : -1, '', { raw: true });
    if (src && !src.local && isUrl(src.input)) provider = new URL(src.input).host;
  } catch {}
  if (it && p9Hooks.played) { try { p9Hooks.played(it, Number.isInteger(b.alt) ? b.alt : -1, b); } catch (e) { log(`Channel health: ${e.message}`); } }
  if (b.failed) { if (!b.backup) stats.fail(); return { ok: true }; }
  return { id: stats.play({ route: String(b.route || ''), reason: String(b.reason || ''), provider, host: String(b.host || req.headers.host || ''), profile: prof.id, type }) };
});
route('POST', '/api/stats/watch', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readJSON(req);
  stats.watch(String(b.id || ''), b.sec, prof.id);
  return { ok: true };
});
route('GET', '/api/admin/stats', (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const names = {};
  for (const pr of accounts.d.profiles) names[pr.id] = pr.name;
  return stats.summary(clampInt(q.get('days'), 1, 120, 30), names);
});
route('DELETE', '/api/admin/stats', (req, res, p, q, ctx) => { requireAdmin(ctx); stats.reset(); concurrency.reset(); return { ok: true }; });
// How many streams each provider served at once, and how close to its limit (Admin → Statistics).
route('GET', '/api/admin/stats/concurrency', (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  return concurrency.report(clampInt(q.get('days'), 1, 120, 7), clampInt(q.get('tz'), -840, 840, 0));
});
// The optional browser helper for desktop Chrome/Edge (extension/), named after this site.
route('GET', '/api/direct-helper.zip', (req, res) => {
  const name = `${settings().brand.name || 'IPTV Player'} – Direct Streams`.slice(0, 75);
  const buf = zipFolder(path.join(cfg.root, 'extension'), 'direct-streams-helper', (file, data) => {
    if (file !== 'manifest.json') return data;
    const m = JSON.parse(data.toString('utf8'));
    m.name = name;
    return Buffer.from(JSON.stringify(m, null, 2));
  });
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="direct-streams-helper.zip"', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}, 'site');
route('POST', '/api/play/session', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readJSON(req);
  const it = item(ctx, String(b.k || ''));
  if (b.url && !relayable(it, b.url)) throw new HttpError(403, 'That address doesn’t belong to this channel');
  const src = inputOf(it, Number.isInteger(b.alt) ? b.alt : -1, b.url || '');
  if (!src) throw new HttpError(404, 'File not found');
  const isProto = /^(rtmpt?e?s?|rtsps?|udp|rtp|srt|mmsh?|mmst):\/\//i.test(src.input);
  if (!src.local && !isUrl(src.input) && !isProto) throw new HttpError(400, 'This kind of address can’t be played');
  const wasCached = media.probeCached(src.input, src.headers);
  const pr = await media.probe(src.input, { headers: src.headers, timeout: isProto ? 20000 : 15000 });
  if (!pr && (isProto || src.local)) throw new HttpError(502, 'The server couldn’t open that stream.');
  // One-connection accounts: let the provider free the slot the look-inside used before the real connection.
  if (!wasCached && !src.local && oneConnection(it, Number.isInteger(b.alt) ? b.alt : -1)) await new Promise((ok) => setTimeout(ok, 1500));
  // (A film or episode is finite even when the look inside timed out: then its listed length stands in.)
  const film = it.t === 'movie' || it.t === 'episode' || b.live === false;
  const finite = (film || !!(pr && pr.duration > 0)) && b.live !== true;
  const duration = finite ? (pr && pr.duration > 0 ? pr.duration : Number(it.d) || 0) : 0;
  const live = !finite;
  const codecs = Array.isArray(b.codecs) ? b.codecs.map(String) : ['h264'];
  const height = clampInt(b.height, 0, 2160, 0);
  const transcode = b.mode === 'transcode' || media.needsVideoTranscode(pr, codecs) || !!(height && pr && pr.height && pr.height > height);
  // (b.audioOnly: the viewer chose "sound only" for a live channel — the player's listening mode.)
  const audioOnly = !!(pr && !pr.vcodec && pr.acodec) || it.t === 'radio' || b.audioOnly === true;
  const seek = finite ? Math.max(0, Number(b.seek) || 0) : 0;
  // The viewer's preferred audio language picks the track, unless they chose one.
  let audioTrack = clampInt(b.audio, 0, 64, 0);
  if (b.audio === undefined && b.audioLang && pr && pr.audio && pr.audio.length > 1) {
    const want = String(b.audioLang).slice(0, 2).toLowerCase();
    const hit = pr.audio.find((a) => String(a.lang || '').toLowerCase().startsWith(want) || (L.code && L.code(a.lang) === want));
    if (hit) audioTrack = hit.i;
  }
  const s = await media.startSession({ input: src.input, headers: src.headers, live, seek, video: transcode ? 'h264' : 'copy', audioOnly, audioTrack, height, label: it.n, owner: prof.id, priority: (pid) => !!(accounts.profile(pid) || {}).priority });
  return {
    url: `/api/session/${s.id}/index.m3u8`, sessionId: s.id, offset: s.offset, audioTrack, duration, mode: transcode ? 'transcode' : 'remux',
    audio: pr ? pr.audio : [], subs: pr ? pr.subs.filter((x) => x.text || x.pic) : [], chapters: pr ? pr.chapters : [], height: pr ? pr.height : 0, vcodec: pr ? pr.vcodec : '',
  };
});
// DASH through the server: Shaka asks for every manifest/segment here (only addresses on the item's own hosts).
route('GET', '/api/dash', async (req, res, p, q, ctx) => {
  if (req.headers['x-app'] !== '1') throw new HttpError(403, 'Missing X-App header');
  const it = item(ctx, String(q.get('k') || ''));
  const url = String(q.get('u') || '');
  if (!isUrl(url) || !relayable(it, url)) throw new HttpError(403, 'That address doesn’t belong to this channel');
  const alt = clampInt(q.get('alt'), -1, 99, -1);
  const src = inputOf(it, alt, '', { raw: true });
  const headers = proxy.headers({ h: (src && src.headers) || {} });
  // (A list that uses the stream relay: from there, which sends the headers.)
  const viaRelay = relayOf.uses(lists.ownerOf(url) || srcList(it, alt));
  const upUrl = viaRelay ? relayWrapped(url, headers) : url;
  const sendH = viaRelay ? {} : headers;
  if (req.headers.range) sendH.Range = req.headers.range;
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  let up;
  try { up = await fetchAny(upUrl, { headers: sendH, signal: ac.signal, redirect: 'follow' }); } catch (e) { if (ac.signal.aborted) return; throw new HttpError(502, `Upstream error: ${(e.cause && e.cause.message) || e.message}`); }
  const out = { 'Cache-Control': 'no-cache' };
  const enc = !!up.headers.get('content-encoding');
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) { if (enc && k === 'content-length') continue; const v = up.headers.get(k); if (v) out[k] = v; }
  res.writeHead(up.status, out);
  if (!up.body) return res.end();
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
});
route('GET', '/api/session/:sid/:file', async (req, res, p) => {
  if (!/^(index\.m3u8|seg\d+\.ts)$/.test(p.file)) throw new HttpError(400, 'Bad file');
  const s = media.touch(p.sid);
  if (!s) throw new HttpError(410, 'Playback session ended');
  const file = path.join(s.dir, p.file);
  countBytes(res, 'convert');
  if (p.file === 'index.m3u8') {
    // The playlist may not be written yet (ffmpeg just restarted after a seek or a dropped connection): wait a few
    // seconds for it rather than failing; players ask again after a "not ready yet".
    let text = null;
    for (let i = 0; i < 40 && text === null; i++) {
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        if (!media.touch(p.sid)) throw new HttpError(410, 'Playback session ended');
        await new Promise((ok) => setTimeout(ok, 250));
      }
    }
    if (text === null) { res.writeHead(503, { 'Retry-After': '2', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end('The conversion hasn’t started yet'); }
    return sendText(res, 200, text, 'application/vnd.apple.mpegurl', req.cast ? { 'Access-Control-Allow-Origin': '*' } : {});
  }
  serveFile(req, res, file, { type: 'video/mp2t', cache: 'max-age=3600', headers: req.cast ? { 'Access-Control-Allow-Origin': '*' } : {} });
}, 'site');
route('POST', '/api/session/:sid/ping', (req, res, p) => ({ alive: !!media.touch(p.sid) }), 'site');
route('DELETE', '/api/session/:sid', (req, res, p) => { media.stopSession(p.sid); return { ok: true }; }, 'site');
route('GET', '/api/proxy', (req, res, p, q) => proxy.handle(req, res, q, req.cast), 'site');
route('GET', '/api/local/:list/:id', (req, res, p, q, ctx) => {
  // (Recordings belong to the profile that made them; a Chromecast's signed address is allowed through.)
  if (p.list === 'dvr' && !req.cast && dvrHooks.dvrOwnerOk && !dvrHooks.dvrOwnerOk(ctx && ctx.profile, p.id)) throw new HttpError(404, 'File not found');
  countBytes(res, 'local');
  const li = lists.libraryItem(p.list, p.id);
  if (!li) throw new HttpError(404, 'File not found');
  serveFile(req, res, li.path, { headers: req.cast ? { 'Access-Control-Allow-Origin': '*' } : {} });
}, 'site');
route('GET', '/api/file/:k', (req, res, p, q, ctx) => {
  countBytes(res, 'local');
  const it = item(ctx, p.k);
  const src = inputOf(it, clampInt(q.get('alt'), -1, 99, -1));
  if (!src || !src.local) throw new HttpError(404, 'Not a file on this server');
  serveFile(req, res, src.input);
});
route('GET', '/api/art/:list/:id', async (req, res, p) => {
  const lib = lists.libraries.get(p.list);
  const li = lib && lib.get(p.id);
  if (!li) throw new HttpError(404, 'Not found');
  let file;
  try { file = await lib.thumb(li); } catch { throw new HttpError(404, 'No artwork'); }
  serveFile(req, res, file, { cache: 'private, max-age=86400' });
}, 'site');
route('GET', '/api/probe/:k', async (req, res, p, q, ctx) => {
  const it = item(ctx, p.k);
  if (oneConnection(it, clampInt(q.get('alt'), -1, 99, -1))) throw new HttpError(409, 'The provider allows only one connection at a time, so the server can’t look inside while you watch.');
  const src = inputOf(it, clampInt(q.get('alt'), -1, 99, -1));
  if (!src) throw new HttpError(404, 'Not found');
  const pr = await media.probe(src.input, { headers: src.headers });
  if (!pr) throw new HttpError(502, 'Couldn’t read the stream');
  return { duration: pr.duration, vcodec: pr.vcodec, acodec: pr.acodec, height: pr.height, audio: pr.audio, subs: pr.subs, chapters: pr.chapters };
});
route('GET', '/api/subs/:k/:track', async (req, res, p, q, ctx) => {
  const it = item(ctx, p.k);
  if (oneConnection(it, clampInt(q.get('alt'), -1, 99, -1))) throw new HttpError(409, 'The provider allows only one connection at a time, so subtitles inside the file can’t be read while you watch.');
  const src = inputOf(it, clampInt(q.get('alt'), -1, 99, -1));
  if (!src) throw new HttpError(404, 'Not found');
  let vtt = await media.subtitles(src.input, clampInt(p.track, 0, 99, 0), { headers: src.headers });
  const off = Number(q.get('offset')) || 0;
  if (off) {
    const shift = (t) => {
      const [h, m, s] = t.split(':');
      const ms = Math.max(0, Math.round(((+h) * 3600 + (+m) * 60 + parseFloat(s) - off) * 1000));
      const z = (n, l = 2) => String(n).padStart(l, '0');
      return `${z(Math.floor(ms / 3600000))}:${z(Math.floor(ms / 60000) % 60)}:${z(Math.floor(ms / 1000) % 60)}.${z(ms % 1000, 3)}`;
    };
    vtt = vtt.replace(/(\d+:\d{2}:\d{2}\.\d{3})/g, (m) => shift(m)).replace(/^(\d{2}:\d{2}\.\d{3})/gm, (m) => shift('00:' + m));
  }
  sendText(res, 200, vtt, 'text/vtt; charset=utf-8');
});
route('GET', '/api/frame/:k', async (req, res, p, q, ctx) => {
  const it = item(ctx, p.k);
  if (it.t === 'live') throw new HttpError(400, 'Not for live channels');
  if (oneConnection(it)) throw new HttpError(409, 'The provider allows only one connection at a time.');
  const src = inputOf(it);
  if (!src) throw new HttpError(404, 'Not found');
  const t = Math.round((Number(q.get('t')) || 0) / 10) * 10;
  const file = await media.frame(src.input, t, { headers: src.headers, width: clampInt(q.get('w'), 120, 640, 240) });
  serveFile(req, res, file, { cache: 'private, max-age=604800' });
});
route('GET', '/api/download/:k', async (req, res, p, q, ctx) => {
  countBytes(res, 'download');
  const prof = requireProfile(ctx);
  if (settings().allowDownloads === false && !prof.admin) throw new HttpError(403, 'Downloads are turned off.');
  const it = item(ctx, p.k);
  if (it.t === 'live' || it.t === 'show') throw new HttpError(400, 'Only movies, episodes and audio can be downloaded.');
  const src = inputOf(it, clampInt(q.get('alt'), -1, 99, -1));
  if (!src) throw new HttpError(404, 'Not found');
  const safe = it.n.replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 120) || 'video';
  const height = clampInt(q.get('height'), 0, 2160, 0);
  const pr = await media.probe(src.input, { headers: src.headers });
  if (!pr) throw new HttpError(502, 'Couldn’t read the video.');
  const okVideo = !pr.vcodec || (pr.vcodec === 'h264' && !/10le|12le|422|444/.test(pr.pixfmt || ''));
  const okAudio = !pr.acodec || ['aac', 'mp3'].includes(pr.acodec);
  const isMp4 = /mp4|mov/.test(pr.format) || NATIVE_EXT.test(src.input.split('?')[0]);
  const ext = !pr.vcodec && pr.acodec ? (pr.acodec === 'mp3' ? '.mp3' : pr.acodec === 'flac' ? '.flac' : '.m4a') : '.mp4';
  res.setHeader('X-Duration', String(Math.round(pr.duration || 0)));
  if (isMp4 && okVideo && okAudio && !height) {
    if (src.local) return serveFile(req, res, src.input, { download: safe + path.extname(src.input) });
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const up = await fetchAny(src.input, { headers: proxy.headers({ h: src.headers }), signal: ac.signal, redirect: 'follow' });
    if (!up.ok) throw new HttpError(502, `The stream server answered HTTP ${up.status}`);
    const h = { 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safe + '.mp4')}`, 'Cache-Control': 'no-store' };
    if (up.headers.get('content-length') && !up.headers.get('content-encoding')) h['Content-Length'] = up.headers.get('content-length');
    res.writeHead(200, h);
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
    return;
  }
  if (!pr.vcodec && pr.acodec) {
    // Audio: hand over as-is if the browser can play it, else convert to AAC.
    if (src.local && NATIVE_EXT.test(src.input)) return serveFile(req, res, src.input, { download: safe + path.extname(src.input) });
  }
  media.mp4(src.input, { headers: src.headers, transcode: !okVideo || !!(height && pr.height > height), height, audioTrack: clampInt(q.get('audio'), 0, 64, 0) }, req, res, safe + ext);
});
route('GET', '/api/markers/:k', (req, res, p, q, ctx) => { const it = item(ctx, p.k); markers.want(it.k); return markers.get(it.k); });
route('POST', '/api/markers/:k', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const it = item(ctx, p.k);
  const b = await readJSON(req);
  return markers.set(it.k, b.kind, b.start === null ? null : b.start, b.end, { season: !!b.season, by: prof.id });
});

// ---- social
route('GET', '/api/social', (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const presence = [];
  for (const c of hub.conns) {
    if (c.pid === prof.id || !c.playing || c.playing.hidden) continue;
    const pr = userdata.prefs(c.pid);
    if (pr.presence === false) continue;
    const it = catalog.visible(prof, c.playing.k);
    if (it) presence.push({ pid: c.pid, k: c.playing.k, n: it.n, i: it.logo || '', at: c.playing.at });
  }
  return {
    profiles: accounts.profiles.map((x) => ({ ...accounts.summary(x), online: hub.online().includes(x.id) })),
    conversations: social.conversations(prof.id), unread: social.unread(prof.id), lists: social.lists(), parties: social.partiesFor(prof.id), presence,
  };
});
route('GET', '/api/messages/:conv', (req, res, p, q, ctx) => social.thread(requireProfile(ctx).id, p.conv, Number(q.get('before')) || Infinity));
route('POST', '/api/messages', async (req, res, p, q, ctx) => social.send(requireProfile(ctx).id, await readJSON(req)));
route('POST', '/api/messages/:conv/read', (req, res, p, q, ctx) => ({ n: social.markRead(requireProfile(ctx).id, p.conv) }));
route('POST', '/api/messages-react', async (req, res, p, q, ctx) => { const b = await readJSON(req); return social.react(requireProfile(ctx).id, b.id, b.emoji); });
route('DELETE', '/api/messages/:id', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); social.removeMessage(prof.id, p.id, prof.admin); return { ok: true }; });
route('POST', '/api/lists', async (req, res, p, q, ctx) => social.createList(requireProfile(ctx).id, (await readJSON(req)).name));
route('PUT', '/api/lists/:id', async (req, res, p, q, ctx) => { const prof = requireProfile(ctx); return social.editList(prof.id, p.id, await readJSON(req), prof.admin); });
route('DELETE', '/api/lists/:id', (req, res, p, q, ctx) => { const prof = requireProfile(ctx); social.removeList(prof.id, p.id, prof.admin); return { ok: true }; });
route('POST', '/api/party', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  if (settings().allowParties === false) throw new HttpError(403, 'Watch parties are turned off.');
  const b = await readJSON(req);
  const pit = item(ctx, String(b.k || ''));
  // Share one provider connection (through the server) when the provider's connections are limited.
  if (typeof b.share !== 'boolean') b.share = !!(p2Hooks.partyShareDefault && p2Hooks.partyShareDefault(pit));
  return social.createParty(prof.id, b);
});
route('GET', '/api/party/:id', (req, res, p, q, ctx) => { requireProfile(ctx); return social.partyView(social.party(p.id)); });
route('POST', '/api/party/:id/join', (req, res, p, q, ctx) => social.joinParty(requireProfile(ctx).id, p.id));
route('POST', '/api/party/:id/leave', (req, res, p, q, ctx) => { social.leaveParty(requireProfile(ctx).id, p.id); return { ok: true }; });
route('POST', '/api/party/:id/state', async (req, res, p, q, ctx) => social.partyState(requireProfile(ctx).id, p.id, await readJSON(req)));
route('POST', '/api/party/:id/chat', async (req, res, p, q, ctx) => social.partyChat(requireProfile(ctx).id, p.id, await readJSON(req)) || { ok: true });
route('POST', '/api/party/:id/settings', async (req, res, p, q, ctx) => { social.partySettings(requireProfile(ctx).id, p.id, await readJSON(req)); return { ok: true }; });

// ---- live connection, presence, devices
route('GET', '/api/events', (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  hub.open(req, res, { pid: prof.id, sess: ctx.sess.id, deviceId: String(q.get('device') || '').slice(0, 40), deviceName: String(q.get('name') || ctx.sess.name).slice(0, 60) });
});
// A device's live connection ended: what it was playing stops counting (webhooks "stopped", the viewing dashboard,
// the stream relay's share). (Can be called twice — on the request closing and on a write error.)
hub.onClose = (c) => {
  if (c.closed) return;
  c.closed = true;
  const was = c.playing || (c.multi && c.multi.length);
  try { p5.onClose(c); } catch (e) { log(`Presence clean-up: ${e.message}`); }
  if (was) relayFinished.poke();
};
/**
 * Ends live connections whose device was signed out (sign out, Admin → Devices, a new site password), whose profile
 * was removed, or whose profile's PIN was changed since this device entered it. Their page reconnects and is asked
 * to sign in or choose a profile again.
 */
function dropStaleConns() {
  for (const c of [...hub.conns]) {
    const s = accounts.sessionById(c.sess);
    const prof = accounts.profile(c.pid);
    if (s && s.expires >= Date.now() && prof && accounts.pinCurrent(s, prof)) continue;
    try { c.res.end(); } catch {}
  }
}
route('POST', '/api/presence', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readObj(req);
  const c = hub.conn(String(b.conn || ''));
  if (c && c.pid === prof.id) {
    const was = c.playing;
    c.playing = b.playing && b.playing.k ? { k: String(b.playing.k), pos: Number(b.playing.pos) || 0, at: was && was.k === String(b.playing.k) ? was.at : Date.now(), n: String(b.playing.n || '').slice(0, 200), alt: Number.isInteger(b.playing.alt) ? b.playing.alt : -1, hidden: !!b.playing.hidden } : null;
    if ((was && was.k) !== (c.playing && c.playing.k) || (was && was.alt) !== (c.playing && c.playing.alt) || 'multi' in b) relayFinished.poke(); // (what plays changed: the relay's share of the account may too)
    // Multiview: every tile uses a provider connection of its own.
    if ('multi' in b) {
      const old = new Map((c.multi || []).map((t) => [t.k, t.at]));
      c.multi = Array.isArray(b.multi) ? b.multi.filter((t) => t && t.k).slice(0, 9).map((t) => ({ k: String(t.k), n: String(t.n || '').slice(0, 200), alt: Number.isInteger(t.alt) ? t.alt : -1, hidden: !!t.hidden, at: old.get(String(t.k)) || Date.now(), tile: true })) : null;
    }
    p5.onPresence(c); // (webhooks: playback started / stopped)
  }
  return { ok: true };
});
route('GET', '/api/devices', (req, res, p, q, ctx) => {
  requireProfile(ctx);
  // Someone else's private viewing shows as just "playing", without what it is.
  const shown = (c) => (c.playing && c.playing.hidden && c.pid !== ctx.profile.id ? { k: '', n: 'something', hidden: true, at: c.playing.at, pos: 0, alt: -1 } : c.playing);
  return [...hub.conns].filter((c) => canControl(ctx, c)).map((c) => ({ conn: c.id, name: c.deviceName, deviceId: c.deviceId, playing: shown(c), at: c.at, profile: c.pid !== ctx.profile.id ? (accounts.profile(c.pid) || {}).name || '' : '', tv: /\bTV\b|Tizen|webOS|BRAVIA|Android TV|GoogleTV|AFT/i.test(c.deviceName || '') }));
});
const COMMANDS = ['play', 'pause', 'resume', 'stop', 'seek', 'toggle', 'skip', 'volume', 'mute', 'subs', 'audio', 'next', 'prev', 'zap', 'channel', 'sleep', 'watch', 'unwatch', 'restart', 'live', 'takeover', 'key', 'nav'];
const REMOTE_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'GoBack', 'ContextMenu'];
const REMOTE_PAGES = ['home', 'live', 'guide', 'movies', 'series', 'mine', 'search', 'recordings', 'onlater'];
route('POST', '/api/devices/:conn/command', async (req, res, p, q, ctx) => {
  requireProfile(ctx);
  const c = hub.conn(p.conn);
  const b = await readObj(req);
  // Taking over a provider connection someone else in the household is using: any profile may ask them to stop.
  // A priority viewer's connection can only be taken by another priority viewer (or by themselves on another device).
  if (b.cmd === 'takeover' && c) {
    const them = accounts.profile(c.pid) || {};
    if (them.priority && !ctx.profile.priority && c.pid !== ctx.profile.id) throw new HttpError(403, `${them.name || 'That viewer'} has priority, so their connection can’t be taken over.`);
    hub.send(c, 'command', { cmd: 'takeover', from: ctx.profile.name, device: ctx.sess.name, priority: !!ctx.profile.priority && !them.priority, k: b.k ? String(b.k) : undefined });
    return { ok: true };
  }
  if (!canControl(ctx, c)) throw new HttpError(404, 'That device isn’t connected any more.');
  if (!COMMANDS.includes(b.cmd)) throw new HttpError(400, 'Unknown command');
  const out = { cmd: b.cmd, from: ctx.sess.name, conn: ctx.conn || '' };
  if (b.k) out.k = String(b.k);
  for (const k of ['pos', 'd', 'v', 'i', 'n', 'dir', 'min']) if (b[k] !== undefined) out[k] = Number(b[k]) || 0;
  if (typeof b.on === 'boolean') out.on = b.on;
  // The phone as the TV's remote control: its arrow keys, OK and Back, and going to a page (with a search).
  if (b.cmd === 'key') { if (!REMOTE_KEYS.includes(b.key)) throw new HttpError(400, 'Unknown key'); out.key = b.key; }
  if (b.cmd === 'nav') { if (!REMOTE_PAGES.includes(b.to)) throw new HttpError(400, 'Unknown page'); out.to = b.to; if (typeof b.q === 'string') out.q = b.q.slice(0, 100); }
  hub.send(c, 'command', out);
  return { ok: true };
});

// ---- signing in a TV with a phone: the TV shows a code (and QR code), a signed-in phone approves it
const pairs = new Map(); // id → { code, secret, created, ip, ua, approved }
const PAIR_TTL = 10 * 60e3;
const pairCode = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c = ''; for (const b of crypto.randomBytes(6)) c += A[b % A.length]; return c; };
const sweepPairs = () => { for (const [id, x] of pairs) if (Date.now() - x.created > PAIR_TTL) pairs.delete(id); };
function siteOrigin(req) {
  const host = (cfg.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || `localhost:${cfg.port}`;
  return `${secureReq(req) ? 'https' : 'http'}://${host}`;
}
route('POST', '/api/pair/start', async (req, res) => {
  sweepPairs();
  const ip = clientIp(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  // The same sign-in page asking again (reloaded, or its code ran out): its old code is replaced rather than counted.
  const body = await readJSON(req).catch(() => ({}));
  const prev = body && typeof body.prev === 'string' ? pairs.get(body.prev) : null;
  if (prev && prev.ip === ip && !prev.approved) pairs.delete(body.prev);
  if ([...pairs.values()].filter((x) => x.ip === ip).length >= 8 || pairs.size > 200) throw new HttpError(429, 'Too many sign-in codes. Wait a few minutes.');
  const id = crypto.randomBytes(12).toString('base64url');
  let code;
  do code = pairCode(); while ([...pairs.values()].some((x) => x.code === code));
  const secret = crypto.randomBytes(18).toString('base64url');
  pairs.set(id, { code, secret, created: Date.now(), ip, ua, approved: null });
  const link = `${siteOrigin(req)}/#/pair?c=${code}`;
  return { id, secret, code: code.slice(0, 3) + '-' + code.slice(3), link, qr: qrSvg(link, { size: 240 }), expires: Date.now() + PAIR_TTL };
}, 'public');
route('GET', '/api/pair/:id', (req, res, p, q) => {
  const x = pairs.get(p.id);
  if (!x || x.secret !== q.get('s')) throw new HttpError(404, 'That code has expired.');
  if (Date.now() - x.created > PAIR_TTL) { pairs.delete(p.id); throw new HttpError(410, 'That code has expired.'); }
  if (!x.approved) return { waiting: true };
  pairs.delete(p.id);
  const by = accounts.sessionById(x.approved.sess);
  const extra = { pairedBy: x.approved.sess, name: deviceNameOf(x.ua) };
  if (x.approved.profileId) {
    extra.profileId = x.approved.profileId;
    // Opened as the approver's own profile: they proved it on their phone, so no PIN needed on the TV.
    const ok = by && by.pinOk && by.pinOk[x.approved.profileId];
    extra.pinOk = { [x.approved.profileId]: { at: Date.now(), until: Date.now() + 180 * 86400e3, via: 'pair', ...(ok ? {} : {}) } };
  }
  const token = accounts.newSession(clientIp(req), x.ua, extra);
  res.setHeader('Set-Cookie', accounts.cookie(token, secureReq(req)));
  log(`Signed in ${extra.name} with a code approved on ${(by && by.name) || 'another device'}`);
  return { ok: true };
}, 'public');
route('POST', '/api/pair/approve', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const b = await readObj(req);
  sweepPairs();
  const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const x = [...pairs.values()].find((y) => y.code === code);
  if (!x) throw new HttpError(404, 'That code isn’t right, or it has expired. Check the TV for the current code.');
  x.approved = { sess: ctx.sess.id, profileId: b.as === 'me' ? prof.id : null, by: prof.id };
  return { ok: true, device: deviceNameOf(x.ua) };
});
const { deviceName: deviceNameOf } = require('./lib/accounts');
const { qrSvg } = require('./lib/qr');
// A QR code (SVG) for an address of this app, e.g. the TV's "Control from your phone" (opens its remote on the phone).
route('GET', '/api/qr', (req, res, p, q, ctx) => {
  requireProfile(ctx);
  const text = String(q.get('text') || '').slice(0, 400);
  if (!/^https?:\/\/[^\s]+$/i.test(text)) throw new HttpError(400, 'A web address is needed');
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=3600' });
  res.end(qrSvg(text, { size: 240 }));
});

// ---- the plain-http "direct address": an https page hands this device over so http-only providers play directly
const handoffs = new Map(); // token → { sess, to, exp }
route('POST', '/api/handoff', async (req, res, p, q, ctx) => {
  requireProfile(ctx);
  const base = String(settings().directAddress || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new HttpError(400, 'The admin hasn’t set a direct address.');
  const b = await readJSON(req).catch(() => ({}));
  const to = typeof b.to === 'string' && /^#\/[\w/?=&%.,:+-]*$/.test(b.to) ? b.to : '#/home';
  for (const [k, v] of handoffs) if (v.exp < Date.now()) handoffs.delete(k);
  const token = crypto.randomBytes(24).toString('base64url');
  handoffs.set(token, { sess: ctx.sess.id, to, exp: Date.now() + 90e3 });
  return { url: `${base}/h/${token}` };
});
function handoffLanding(req, res, token) {
  const h = handoffs.get(token);
  handoffs.delete(token);
  const from = h && h.exp > Date.now() && accounts.sessionById(h.sess);
  if (!from) { res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' }); return res.end(); }
  const extra = { profileId: from.profileId, pinOk: from.pinOk || {}, pairedBy: from.id, name: from.name };
  const tok = accounts.newSession(clientIp(req), req.headers['user-agent'], extra);
  res.writeHead(302, { Location: '/' + h.to, 'Set-Cookie': accounts.cookie(tok, secureReq(req)), 'Cache-Control': 'no-store' });
  res.end();
}

// ---- remote control: a phone (same profile, or the one that signed the TV in) drives a TV
/**
 * May this phone (its profile) control that screen? Its own profile's screens; screens it signed in with a code; the
 * admin any screen in the household; and anyone but a Kids profile a Kids profile's screens (a parent working the
 * kids' TV — it used to need the phone switched to the Kids profile first).
 */
function mayControl(prof, sessId, c) {
  if (!c || !prof) return false;
  if (c.pid === prof.id || prof.admin) return true;
  const target = c.pid ? accounts.profile(c.pid) : null;
  if (target && target.kids && !prof.kids) return true;
  const s = accounts.sessionById(c.sess);
  return !!(s && s.pairedBy && s.pairedBy === sessId);
}
function canControl(ctx, c) { return mayControl(ctx.profile, ctx.sess && ctx.sess.id, c); }
route('POST', '/api/devices/state', async (req, res, p, q, ctx) => {
  requireProfile(ctx);
  const b = await readObj(req);
  const me = hub.conn(String(b.conn || ''));
  if (!me || me.sess !== ctx.sess.id) return { ok: false };
  for (const id of (Array.isArray(b.to) ? b.to : []).slice(0, 10)) {
    const c = hub.conn(String(id));
    // The receiving phone must be allowed to control this device.
    if (c && mayControl(accounts.profile(c.pid), c.sess, me)) hub.send(c, 'devstate', { from: me.id, state: b.state || null });
  }
  return { ok: true };
});

// ---- casting: short-lived links a Chromecast/AirPlay receiver can open without signing in
const castSecret = crypto.randomBytes(32);
const castSign = (pathq, hours = 8) => {
  const exp = Math.floor(Date.now() / 1000) + hours * 3600;
  // (What the link opens: a conversion session's files, a signed proxy address, or one file of a media folder —
  // not every file in that folder.)
  const parts = pathq.split('?')[0].split('/');
  const data = Buffer.from(JSON.stringify({ p: parts.slice(0, parts[2] === 'local' ? 5 : 4).join('/'), e: exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', castSecret).update(data).digest('base64url').slice(0, 24);
  return `/c/${data}.${sig}${pathq}`;
};
route('POST', '/api/cast/link', async (req, res, p, q, ctx) => {
  const prof = requireProfile(ctx);
  const { path: pq } = await readObj(req);
  if (!/^\/api\/(session|proxy|local)\b/.test(String(pq || ''))) throw new HttpError(400, 'Only stream addresses can be cast');
  // A media-folder file or a recording: only one this profile may watch.
  const lm = String(pq).split('?')[0].match(/^\/api\/local\/([^/]+)\/([^/]+)$/);
  if (/^\/api\/local\b/.test(String(pq)) && !lm) throw new HttpError(400, 'Only stream addresses can be cast');
  if (lm && lm[1] === 'dvr') { if (dvrHooks.dvrOwnerOk && !dvrHooks.dvrOwnerOk(prof, lm[2])) throw new HttpError(404, 'File not found'); }
  else if (lm) {
    const u = `/api/local/${lm[1]}/${lm[2]}`;
    const it = catalog.items.find((x) => (x.loc && x.loc.list === lm[1] && x.loc.id === lm[2]) || x.u === u || (x.alts || []).some((a) => a.u === u));
    if (!it) throw new HttpError(404, 'File not found');
    item(ctx, it.k); // (hidden or locked for this profile: refused)
  }
  return { url: castSign(String(pq)) };
});

// ---- admin
route('GET', '/api/admin', (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const s = settings();
  const counts = {};
  for (const it of catalog.items) counts[it.t] = (counts[it.t] || 0) + 1;
  const use = listUsage();
  return {
    settings: adminSettingsView(),
    lists: lists.all().map((l) => ({ ...lists.view(l), uniq: (listCountsNow() || {})[l.id] || null, testing: !!(connTest.status(l.id) || {}).running, inUse: (use.get(l.id) || []).map((c) => ({ name: (accounts.profile(c.pid) || {}).name || '', device: c.deviceName, n: c.playing.n })) })), guides: lists.guides(),
    profiles: accounts.profiles.map((x) => ({ ...accounts.view(x), online: hub.online().includes(x.id) })),
    devices: accounts.sessionsList(),
    me: ctx.sess ? ctx.sess.id : null,
    status: {
      version: cfg.version, ffmpeg: media.available, ffmpegVersion: media.version, hw: media.hw, encoders: [...media.encoders].filter((e) => /h264_/.test(e)),
      sessions: [...media.sessions.values()].map((x) => ({ id: x.id, label: x.label, owner: x.owner, transcode: x.transcode, hw: x.hw, height: x.height, startedAt: x.startedAt })),
      catalog: { version: catalog.version, total: catalog.items.length, counts, shows: catalog.shows.size },
      epg: epg.stats(), tmdb: { enabled: tmdb.enabled(), error: tmdb.lastError, matched: Object.keys(tmdb.meta.data.m).length }, intro: !!markers.detector,
      dataDir: D, listen: `${cfg.host}:${cfg.port}`, platform: `${process.platform} ${os.release()}`, node: process.version, uptime: Math.round(process.uptime()), mem: process.memoryUsage().rss, items: catalog.items.length,
      defaultPassword: accounts.d.site.isDefault, needsRestart: !!update.needsRestart, exportBase: `/k/${s.exportKey}`, alerts: accountAlerts(), errors: reports.summary(),
    },
    watching: [...hub.conns].filter((c) => c.playing).map((c) => ({ pid: c.pid, device: c.deviceName, k: c.playing.k, n: c.playing.n, at: c.playing.at })),
  };
});
route('PUT', '/api/admin/settings', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const b = await readJSON(req);
  const s = settings();
  const num = (k, min, max) => { if (k in b) s[k] = clampInt(b[k], min, max, s[k]); };
  if (typeof b.userAgent === 'string') s.userAgent = b.userAgent.trim() || DEFAULT_SETTINGS.userAgent;
  if (['direct-first', 'server', 'direct-only'].includes(b.routing)) s.routing = b.routing;
  if (Array.isArray(b.defaultLangs)) s.defaultLangs = b.defaultLangs.map(String);
  for (const k of ['showUnknownLang', 'adminOnlyProfiles', 'allowDownloads', 'allowParties', 'introDetection', 'tmdbAuto', 'tmdbTitles']) if (k in b) s[k] = !!b[k];
  // TMDB: each episode's details when a series is opened ('open') or only when fetched here ('off'); its language.
  if (['open', 'off'].includes(b.tmdbEpisodes)) s.tmdbEpisodes = b.tmdbEpisodes;
  if (typeof b.tmdbLang === 'string' && /^([a-z]{2}(-[A-Z]{2})?)?$/.test(b.tmdbLang)) s.tmdbLang = b.tmdbLang;
  if (Array.isArray(b.hiddenGroups)) s.hiddenGroups = b.hiddenGroups.map(String);
  if (Array.isArray(b.hiddenKeys)) s.hiddenKeys = b.hiddenKeys.map(String);
  if (typeof b.transcodePreset === 'string' && /^(ultrafast|superfast|veryfast|faster|fast|medium)$/.test(b.transcodePreset)) s.transcodePreset = b.transcodePreset;
  if ('hwaccel' in b && ['', 'vaapi', 'nvenc', 'qsv', 'videotoolbox'].includes(b.hwaccel)) { s.hwaccel = b.hwaccel; media.hwFailed = false; }
  if (typeof b.tmdbKey === 'string' && !/^•/.test(b.tmdbKey)) s.tmdbKey = b.tmdbKey.trim();
  num('epgDays', 1, 21); num('epgPastDays', 0, 14); num('epgRefreshHours', 1, 168); num('transcodeCrf', 16, 35); num('transcodeMaxHeight', 240, 2160);
  num('maxTranscodes', 0, 32); num('maxSessions', 1, 64); num('remuxReadrate', 0, 10);
  if (Array.isArray(b.allowedHosts)) s.allowedHosts = b.allowedHosts.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (b.brand && typeof b.brand === 'object') {
    s.brand = {
      name: String(b.brand.name || '').trim().slice(0, 60) || s.brand.name,
      logo: typeof b.brand.logo === 'string' && b.brand.logo.length < 600000 ? b.brand.logo : s.brand.logo,
      accent: /^#[0-9a-f]{6}$/i.test(b.brand.accent || '') ? b.brand.accent : '',
    };
  }
  if (b.newExportKey) s.exportKey = crypto.randomBytes(12).toString('hex');
  if (Array.isArray(b.proxies)) {
    s.proxies = b.proxies.slice(0, 20).map((x) => {
      const old = (s.proxies || []).find((y) => y.id === x.id);
      let url = String(x.url || '').trim();
      // The form shows passwords masked: keep the saved one.
      if (old && /:•+@/.test(url)) url = old.url;
      if (url && !/^(https?|socks5h?|socks):\/\/[^\s]+$/i.test(url)) throw new HttpError(400, `“${url}” isn’t a proxy address (http://host:port or socks5://user:password@host:port).`);
      return { id: String(x.id || crypto.randomBytes(4).toString('hex')).slice(0, 20), name: String(x.name || '').trim().slice(0, 40) || 'Proxy', url, video: !!x.video };
    }).filter((x) => x.url);
  }
  if (typeof b.proxy === 'string') s.proxy = (s.proxies || []).some((x) => x.id === b.proxy) ? b.proxy : '';
  if (b.relay && typeof b.relay === 'object') {
    const r = { ...(s.relay || {}) };
    if (typeof b.relay.url === 'string') {
      const u = b.relay.url.trim().replace(/\/+$/, '');
      if (u && !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(u)) throw new HttpError(400, 'The relay’s address looks like https://relay.example.com (or http://its-ip:8090).');
      r.url = u;
    }
    if (b.relay.newSecret || (r.url && !r.secret)) r.secret = newSecret();
    if ('all' in b.relay) r.all = !!b.relay.all;
    if ('proxy' in b.relay) { const v = String(b.relay.proxy || ''); r.proxy = v === 'list' || (s.proxies || []).some((x) => x.id === v) ? v : ''; }
    s.relay = r;
  }
  if (typeof b.directAddress === 'string') {
    const d = b.directAddress.trim().replace(/\/+$/, '');
    if (d && !/^http:\/\/[^\s/]+$/i.test(d)) throw new HttpError(400, 'The direct address is a plain http address of this server, like http://192.168.1.20:8080');
    s.directAddress = d;
  }
  if (['ask', 'auto', 'off'].includes(b.directSwitch)) s.directSwitch = b.directSwitch;
  if ('tidyGroups' in b) s.tidyGroups = !!b.tidyGroups;
  if (Array.isArray(b.groupRules)) s.groupRules = b.groupRules.slice(0, 300).map((r) => ({ match: String(r.match || '').trim().slice(0, 120), to: String(r.to || '').trim().slice(0, 60), hide: !!r.hide, types: Array.isArray(r.types) ? r.types.filter((t) => ['live', 'movie', 'show', 'radio'].includes(t)) : [] })).filter((r) => r.match);
  num('backupDays', 0, 60);
  settingsStore.save();
  if ('hiddenGroups' in b || 'hiddenKeys' in b || 'defaultLangs' in b || 'showUnknownLang' in b || 'groupRules' in b || 'tidyGroups' in b || 'tmdbTitles' in b) scheduleRebuild(100);
  hub.toAll('settings', publicSettings());
  return adminSettingsView();
});
route('POST', '/api/admin/accounts/check', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const out = [];
  // (Every list with an account: Xtream, a playlist link from an Xtream panel, a portal — at the same time.)
  await Promise.all(lists.all().filter((x) => x.enabled && (lists.xtAccountOf(x) || x.type === 'stalker')).map(async (l) => out.push({ id: l.id, account: await lists.accountStatus(l.id, 0).catch(() => null) })));
  return out;
});
/** Provider accounts that run out soon (shown to the admin). */
function accountAlerts() {
  const out = [];
  for (const l of lists.all()) {
    const a = l.account;
    if (!l.enabled || !a) continue;
    if (a.expires) { const days = Math.floor((a.expires - Date.now()) / 86400e3); if (days <= 14) out.push({ kind: 'expiry', list: l.name, id: l.id, days }); }
    if (a.status && !/^active$/i.test(a.status)) out.push({ kind: 'status', list: l.name, id: l.id, status: a.status });
  }
  return out;
}
// Account details once a day (expiry, connections), without waiting for the next list refresh.
// (Each list's account a few times a day; a new list's within a few minutes.)
const checkAccounts = () => { for (const l of lists.all()) if (l.enabled && (lists.xtAccountOf(l) || l.type === 'stalker') && (!l.account || !l.account.checkedAt || Date.now() - l.account.checkedAt > 20 * 3600e3) && !(l.account && l.account.errorAt && Date.now() - l.account.errorAt < 3600e3)) lists.accountStatus(l.id, 0).catch(() => {}); };
setInterval(checkAccounts, 5 * 60e3).unref();
// The stream relay: its secret (to copy onto the relay machine) and a test that it's there with the same secret.
route('GET', '/api/admin/relay/secret', (req, res, p, q, ctx) => { requireAdmin(ctx); return { secret: (settings().relay || {}).secret || '' }; });
route('POST', '/api/admin/relay/test', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const r = settings().relay || {};
  if (!r.url || !r.secret) return { ok: false, error: 'Save the relay’s address first.' };
  const out = await testRelay(r.url, r.secret, fetch);
  // Is the relay running the relay.js that comes with this server? (Older ones can't fetch films whole.)
  const mine = bundledRelay();
  if (out.ok && mine) { out.latest = mine.version; out.outdated = String(out.version) !== mine.version; }
  // Its proxies: what address the internet sees from the relay itself, and through each proxy it would use.
  if (out.ok && relayProxyMode()) {
    const used = new Map();
    if (relayProxyMode() === 'list') {
      for (const l of lists.all()) { if (!relayOf.uses(l.id)) continue; const px = listProxy(l.id); if (px) used.set(px.url, px.name || 'Proxy'); }
    } else { const px = proxyById(relayProxyMode()); if (px) used.set(px.url, px.name || 'Proxy'); }
    const own = await testRelayProxy(r.url, r.secret, '', fetch);
    out.ownIp = own.ok ? own.ip : '';
    out.proxies = [];
    for (const [url, name] of [...used].slice(0, 5)) {
      const t = await testRelayProxy(r.url, r.secret, url, fetch);
      // (A relay older than version 4 ignores proxies: the address seen is its own.)
      if (t.ok && own.ok && t.ip && t.ip === own.ip) { t.ok = false; t.error = 'The relay isn’t using the proxy — update the relay (version 4 or later uses proxies).'; }
      out.proxies.push({ name, ...t });
    }
    if (!used.size) out.proxyNote = relayProxyMode() === 'list' ? 'None of the lists that use the relay has a proxy, so it connects to providers itself.' : 'That proxy isn’t there any more.';
  }
  return out;
});
// Sends this server's relay.js to the relay, which swaps it in and restarts (a few seconds without the relay).
route('POST', '/api/admin/relay/update', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const r = settings().relay || {};
  if (!r.url || !r.secret) return { ok: false, error: 'Save the relay’s address first.' };
  return updateRelay(r.url, r.secret, fetch);
});
route('POST', '/api/admin/proxy/test', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const b = await readJSON(req);
  let url = String(b.url || '').trim();
  const saved = (settings().proxies || []).find((x) => x.id === b.id);
  if (saved && /:•+@/.test(url)) url = saved.url;
  try { return await testProxy(url); } catch (e) { return { ok: false, error: (e.cause && e.cause.message) || e.message }; }
});
/** Settings as the admin page sees them (secrets masked). */
function adminSettingsView() {
  const s = settings();
  return { ...s, tmdbKey: s.tmdbKey ? '••••' + s.tmdbKey.slice(-4) : '', proxies: (s.proxies || []).map((x) => ({ ...x, url: x.url.replace(/:([^:@/]+)@/, ':••••@') })), relay: { url: (s.relay || {}).url || '', all: (s.relay || {}).all !== false, hasSecret: !!(s.relay || {}).secret, proxy: (s.relay || {}).proxy || '' } };
}
route('POST', '/api/admin/password', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const { next } = await readObj(req);
  accounts.setSitePassword(next, ctx.sess._key);
  dropStaleConns(); // (every other device was signed out)
  return { ok: true };
});
route('POST', '/api/admin/lists', async (req, res, p, q, ctx) => { requireAdmin(ctx); return lists.add(await readJSON(req)); });
route('POST', '/api/admin/lists/upload', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const buf = await readBody(req, 400 * 1024 * 1024);
  return lists.add({ type: 'file', name: q.get('name') || '', fileName: q.get('fileName') || '', lang: q.get('lang') || '' }, buf);
});
route('PUT', '/api/admin/lists/:id', async (req, res, p, q, ctx) => { requireAdmin(ctx); return lists.update(p.id, await readJSON(req)); });
route('PUT', '/api/admin/lists/:id/file', async (req, res, p, q, ctx) => { requireAdmin(ctx); return lists.replaceFile(p.id, await readBody(req, 400 * 1024 * 1024)); });
route('DELETE', '/api/admin/lists/:id', (req, res, p, q, ctx) => { requireAdmin(ctx); lists.remove(p.id); return { ok: true }; });
// Connection test: how many streams of each kind the list plays at once (Admin → Lists).
/** A provider address (and the headers it needs) as this server should fetch it: through the stream relay when the list uses it. */
const viaRelay = (url, headers, listId) => (/^https?:\/\//i.test(url || '') && relayOf.uses(lists.ownerOf(url) || listId) ? { url: relayWrapped(url, headers || {}), headers: {} } : null);
const connTest = new ConnTest({ lists, catalog, headers: (h) => proxy.headers({ h }), usage: (id) => listUsage().get(id) || [], log, via: viaRelay });
route('POST', '/api/admin/lists/:id/conntest', async (req, res, p, q, ctx) => { requireAdmin(ctx); const b = await readJSON(req).catch(() => ({})); return connTest.start(p.id, { kinds: Array.isArray(b.kinds) ? b.kinds : null }); });
route('GET', '/api/admin/lists/:id/conntest', (req, res, p, q, ctx) => { requireAdmin(ctx); lists.get(p.id); return { job: connTest.status(p.id), saved: lists.get(p.id).connTest || null }; });
route('DELETE', '/api/admin/lists/:id/conntest', (req, res, p, q, ctx) => { requireAdmin(ctx); return connTest.stop(p.id); });
// A big list can take minutes (download, read, rebuild the catalogue): wait up to 45 s, then answer "still going"
// (a page behind Cloudflare gives up after 100 s with "Server error 524"). The list's row shows when it's done.
route('POST', '/api/admin/lists/:id/refresh', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const job = lists.refresh(p.id);
  const late = new Promise((ok) => setTimeout(() => ok({ running: true }), 45000).unref());
  return Promise.race([job, late]);
});
route('POST', '/api/admin/guides/:id/refresh', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const late = new Promise((ok) => setTimeout(() => ok({ running: true }), 45000).unref());
  return Promise.race([lists.refreshGuide(p.id), late]);
});
route('POST', '/api/admin/lists-order', async (req, res, p, q, ctx) => { requireAdmin(ctx); lists.reorder((await readJSON(req)).ids || []); return { ok: true }; });
route('POST', '/api/admin/guides', async (req, res, p, q, ctx) => { requireAdmin(ctx); return lists.addGuide(await readJSON(req)); });
route('PUT', '/api/admin/guides/:id', async (req, res, p, q, ctx) => { requireAdmin(ctx); return lists.updateGuide(p.id, await readJSON(req)); });
route('DELETE', '/api/admin/guides/:id', (req, res, p, q, ctx) => { requireAdmin(ctx); lists.removeGuide(p.id); return { ok: true }; });
route('PUT', '/api/admin/profiles/:id', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const b = await readObj(req);
  // (The admin's own PIN changed here: this device keeps it; every other device needs the new one.)
  const prof = accounts.update(p.id, b, { byAdmin: true, sess: p.id === ctx.profile.id ? ctx.sess : null });
  recs.touch(prof.id, 2000);
  hub.toAll('profiles', {});
  hub.toProfile(prof.id, 'profile', {});
  if ('pin' in b) dropStaleConns();
  return accounts.view(prof);
});
route('DELETE', '/api/admin/profiles/:id', (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  accounts.remove(p.id); userdata.remove(p.id); social.forgetProfile(p.id);
  hub.toProfile(p.id, 'removed', {});
  dropStaleConns();
  hub.toAll('profiles', {});
  return { ok: true };
});
route('POST', '/api/admin/profiles/:id/make-admin', (req, res, p, q, ctx) => { const a = requireAdmin(ctx); accounts.transferAdmin(a.id, p.id); hub.toAll('profiles', {}); return { ok: true }; });
route('POST', '/api/admin/devices/prune', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const body = await readJSON(req).catch(() => ({}));
  const days = Math.max(1, Math.min(365, +body.days || 30));
  const removed = accounts.endIdleSessions(days, ctx.sess && ctx.sess.id);
  dropStaleConns();
  return { ok: true, removed };
});
// (Signing a device out also ends its live connection, which would otherwise keep getting messages and commands.)
route('DELETE', '/api/admin/devices/:id', (req, res, p, q, ctx) => { requireAdmin(ctx); accounts.endSession(p.id); dropStaleConns(); return { ok: true }; });
route('GET', '/api/admin/groups', (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const groups = new Map();
  const langs = {};
  const add = (it) => {
    const key = it.g;
    const e = groups.get(key) || { name: key, count: 0, types: {}, langs: {} };
    e.count++; e.types[it.t] = (e.types[it.t] || 0) + 1;
    for (const l of it.lg.length ? it.lg : ['?']) { e.langs[l] = (e.langs[l] || 0) + 1; langs[l] = (langs[l] || 0) + 1; }
    groups.set(key, e);
  };
  for (const l of lists.all()) { const parsed = lists.parsed.get(l.id); if (!parsed) continue; }
  for (const it of catalog.items) if (it.t !== 'episode') add(it);
  for (const g of settings().hiddenGroups) if (!groups.has(g)) groups.set(g, { name: g, count: 0, types: {}, langs: {}, hidden: true });
  return { groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)), langs };
});
route('POST', '/api/admin/tmdb/test', async (req, res, p, q, ctx) => { requireAdmin(ctx); try { return { ok: await tmdb.test() }; } catch (e) { return { ok: false, error: e.message }; } });
let enrichJob = null;
let enrichCounts = null; // (Admin → Recommendations: the counts, kept for a moment)
/**
 * Fill in posters, plots, genres, cast and directors from TMDB — started by the admin, and automatically in the
 * background whenever the catalogue changes. Devices get the new details every few minutes (and at the end).
 *   mode 'visible'  titles the household can see that have no details yet (the automatic one)
 *        'missing'  every title without details, whatever its language
 *        'all'      every title again (refreshes details already fetched)
 *        'groups'   titles in the chosen categories (`groups`: ["movie|Action", "show|Netflix Series"]), refetching
 *   types: ['movie','show'] to limit it; also skips titles TMDB had no match for unless `retry`.
 */
function startEnrich(auto = false, opts = {}) {
  if (enrichJob || !tmdb.enabled()) return enrichJob ? enrichJob.status : null;
  if (auto && settings().tmdbAuto === false) return null; // (Admin → Recommendations: new titles only when asked)
  const mode = auto ? 'visible' : opts.mode || 'visible';
  const types = new Set(Array.isArray(opts.types) && opts.types.length ? opts.types : ['movie', 'show']);
  const groups = new Set((opts.groups || []).map(String));
  const meta = tmdb.meta.data.m, map = tmdb.map.data.m;
  const noMatch = (it) => map[it.k] && map[it.k].none && !(opts.retry && !map[it.k].manual);
  const filters = accounts.profiles.map((pr) => catalog.filterFor(pr));
  const visible = (it) => filters.some((f) => f.test(it));
  let todo = catalog.items.filter((it) => {
    if (!types.has(it.t)) return false;
    if (mode === 'groups') return groups.has(`${it.t}|${it.g}`) && !(map[it.k] && map[it.k].none && map[it.k].manual);
    if (mode === 'all') return !(map[it.k] && map[it.k].manual) && !noMatch(it);
    if (meta[it.k] || noMatch(it)) return false;
    return mode === 'missing' || visible(it);
  });
  if (!todo.length) return { running: false, total: 0, done: 0, mode, nothing: true };
  // What the household watches comes first, then what it can see; titles in languages nobody uses last.
  const mine = new Set();
  for (const pr of accounts.profiles) { const d = userdata.of(pr.id).data; for (const h of d.history) mine.add(h.sk || h.k); for (const k of d.list) mine.add(k); }
  const rank = (it) => (mine.has(it.k) ? 0 : visible(it) ? 1 : 2);
  todo = todo.map((it, i) => ({ it, r: rank(it), i })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.it);
  const refresh = mode === 'all' || mode === 'groups';
  if (refresh) for (const it of todo) { if (map[it.k] && !map[it.k].manual) { if (map[it.k].none) delete map[it.k]; } if (meta[it.k]) meta[it.k].at = 0; }
  if (opts.retry) for (const it of todo) if (map[it.k] && map[it.k].none && !map[it.k].manual) delete map[it.k];
  log(`TMDB: ${auto ? 'filling in' : `fetching (${mode})`} details for ${todo.length} titles`);
  let lastPush = Date.now();
  const push = () => { catalog.metaChanged(); hub.toAll('catalog', { version: catalog.version }); lastPush = Date.now(); };
  const label = mode === 'groups' ? [...groups].map((g) => g.split('|').slice(1).join('|')).slice(0, 3).join(', ') + (groups.size > 3 ? ` +${groups.size - 3}` : '') : '';
  enrichJob = { status: { running: true, total: todo.length, done: 0, found: 0, missed: 0, current: '', started: Date.now(), auto, mode, label } };
  enrichCounts = null;
  const job = enrichJob;
  tmdb.enrich(todo, {
    onStart: (it) => { job.status.current = it.n; },
    onItem: (it, m) => { applyMeta(it, m); job.status.found++; if (Date.now() - lastPush > 5 * 60e3) push(); },
    onDone: (it, m) => { job.status.done++; if (!m) job.status.missed++; },
    stop: () => enrichJob !== job,
    fresh: refresh,
  }).catch((e) => { job.status.error = e.message; }).finally(() => {
    push();
    job.status.running = false; job.status.finished = Date.now(); job.status.current = '';
    lastEnrich = job.status;
    if (enrichJob === job) enrichJob = null;
  });
  return job.status;
}
let lastEnrich = null;
route('POST', '/api/admin/tmdb/enrich', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  if (!tmdb.enabled()) throw new HttpError(400, 'Add a TMDB key first.');
  const b = await readJSON(req).catch(() => ({}));
  if (b.mode === 'groups' && !(b.groups || []).length) throw new HttpError(400, 'Choose at least one category.');
  return startEnrich(false, { mode: ['visible', 'missing', 'all', 'groups'].includes(b.mode) ? b.mode : 'visible', groups: b.groups, types: b.types, retry: !!b.retry }) || { running: false };
});
// Progress, and what's left to fetch (overall and per category).
// (The counts go through every title: worked out at most every 15 s, as the page asks every 2 s while a job runs.)
route('GET', '/api/admin/tmdb/enrich', (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  if (enrichCounts && Date.now() - enrichCounts.at < 15000 && enrichCounts.v === catalog.version) return { job: enrichJob ? enrichJob.status : null, last: lastEnrich, counts: enrichCounts.counts, groups: enrichCounts.groups };
  const meta = tmdb.meta.data.m, map = tmdb.map.data.m;
  const counts = { titles: 0, fetched: 0, noMatch: 0, missing: 0 };
  const groups = new Map();
  for (const it of catalog.items) {
    if (it.t !== 'movie' && it.t !== 'show') continue;
    counts.titles++;
    const key = `${it.t}|${it.g}`;
    const g = groups.get(key) || groups.set(key, { id: key, t: it.t, name: it.g, total: 0, fetched: 0 }).get(key);
    g.total++;
    if (meta[it.k]) { counts.fetched++; g.fetched++; } else if (map[it.k] && map[it.k].none) counts.noMatch++; else counts.missing++;
  }
  const sorted = [...groups.values()].sort((a, b) => a.t.localeCompare(b.t) || a.name.localeCompare(b.name));
  enrichCounts = { at: Date.now(), v: catalog.version, counts, groups: sorted };
  return { job: enrichJob ? enrichJob.status : null, last: lastEnrich, counts, groups: sorted };
});
route('DELETE', '/api/admin/tmdb/enrich', (req, res, p, q, ctx) => { requireAdmin(ctx); if (enrichJob) { enrichJob.status.stopped = true; lastEnrich = enrichJob.status; } enrichJob = null; return { ok: true }; });

// ---- each episode's details from TMDB, for many series at once (Admin → Recommendations)
let epsJob = null, lastEps = null;
/** The series a choice means: the household's (watched, in My List, followed), every series with TMDB details, or chosen categories. */
function seriesFor(mode, groups) {
  const shows = catalog.items.filter((it) => it.t === 'show');
  if (mode === 'groups') { const g = new Set((groups || []).map(String)); return shows.filter((it) => g.has(`show|${it.g}`)); }
  if (mode === 'all') return shows.filter((it) => tmdb.meta.data.m[it.k]);
  const mine = new Set();
  for (const pr of accounts.profiles) {
    const d = userdata.of(pr.id).data;
    for (const h of d.history) mine.add(h.sk || h.k);
    for (const k of d.list) mine.add(k);
    for (const k of followsOf(pr.id)) mine.add(k);
  }
  return shows.filter((it) => mine.has(it.k));
}
function epsCounts() {
  const m = tmdb.eps.data.m;
  let shows = 0, withEps = 0, episodes = 0;
  for (const it of catalog.items) {
    if (it.t !== 'show' || !tmdb.meta.data.m[it.k]) continue;
    shows++;
    const e = m[it.k];
    if (e && e.s) { withEps++; for (const n in e.s) episodes += Object.keys(e.s[n]).length; }
  }
  return { shows, withEps, episodes, household: seriesFor('mine').length };
}
route('GET', '/api/admin/tmdb/episodes', (req, res, p, q, ctx) => { requireAdmin(ctx); return { job: epsJob ? epsJob.status : null, last: lastEps, counts: epsCounts() }; });
route('POST', '/api/admin/tmdb/episodes', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  if (!tmdb.enabled()) throw new HttpError(400, 'Add a TMDB key first.');
  if (epsJob) return epsJob.status;
  const b = await readJSON(req).catch(() => ({}));
  const mode = ['mine', 'all', 'groups'].includes(b.mode) ? b.mode : 'mine';
  const fresh = !!b.fresh;
  const todo = seriesFor(mode, b.groups).filter((it) => fresh || !tmdb.eps.data.m[it.k] || Date.now() - (tmdb.eps.data.m[it.k].at || 0) > 14 * 86400e3);
  if (!todo.length) return { running: false, nothing: true };
  const job = epsJob = { status: { running: true, mode, total: todo.length, done: 0, found: 0, episodes: 0, current: '', started: Date.now() } };
  log(`TMDB: fetching episode details for ${todo.length} series`);
  (async () => {
    for (const it of todo) {
      if (epsJob !== job) break;
      job.status.current = it.n;
      try { const r = await tmdb.episodes(it, { fresh }); if (r && r.s) { job.status.found++; for (const n in r.s) job.status.episodes += Object.keys(r.s[n]).length; } } catch (e) { if (/key/i.test(e.message)) { job.status.error = e.message; break; } }
      job.status.done++;
    }
  })().finally(() => {
    job.status.running = false; job.status.finished = Date.now(); job.status.current = '';
    lastEps = job.status;
    if (epsJob === job) epsJob = null;
  });
  return job.status;
});
route('DELETE', '/api/admin/tmdb/episodes', (req, res, p, q, ctx) => { requireAdmin(ctx); if (epsJob) { epsJob.status.stopped = true; lastEps = epsJob.status; } epsJob = null; return { ok: true }; });
route('DELETE', '/api/admin/sessions/:id', (req, res, p, q, ctx) => { requireAdmin(ctx); media.stopSession(p.id); return { ok: true }; });
route('GET', '/api/admin/fs', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  let dir = q.get('path');
  if (!dir) {
    const roots = [{ name: 'Home', path: os.homedir() }];
    if (process.platform === 'win32') { for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${l}:\\`)) roots.push({ name: `${l}:`, path: `${l}:\\` }); } else {
      roots.push({ name: '/', path: '/' });
      for (const m of ['/media', '/mnt', '/Volumes', '/data', '/srv']) if (fs.existsSync(m)) roots.push({ name: m, path: m });
    }
    return { path: '', parent: null, dirs: roots };
  }
  dir = path.resolve(dir);
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { throw new HttpError(400, `Can’t open ${dir}: ${e.code}`); }
  const dirs = [];
  let files = 0;
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = fs.statSync(path.join(dir, e.name)).isDirectory(); } catch {} }
    if (isDir) dirs.push({ name: e.name, path: path.join(dir, e.name) }); else files++;
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? '' : parent, dirs, files };
});
/**
 * Everything worth keeping in the data folder, as one gzipped file. Provider downloads (Xtream/M3U copies) are left
 * out — they're fetched again after a restore — except uploaded playlist files, which can't be.
 */
function makeBackup() {
  JsonFile.flushAll();
  const files = {};
  const redownload = new Set(lists.all().filter((l) => l.type === 'xtream' || l.type === 'url').map((l) => lists.rawFile(l)));
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['tmp', 'cache', 'epg', 'thumbs', 'xt', 'backups', 'meta', 'recordings'].includes(e.name)) walk(full, r); } else if (!/\.(bak|tmp|tmp-bg)$/.test(e.name) && !/^corrupt/.test(e.name) && !redownload.has(full) && full !== SNAP_FILE) files[r] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(D, '');
  return zlib.gzipSync(Buffer.from(JSON.stringify({ app: 'browser-iptv-player', version: cfg.version, createdAt: new Date().toISOString(), files })));
}
route('GET', '/api/admin/backup', (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const body = makeBackup();
  res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': body.length, 'Content-Disposition': `attachment; filename="iptv-backup-${new Date().toISOString().slice(0, 10)}.json.gz"` });
  res.end(body);
});
// Nightly backups in data/backups (kept for `backupDays` days).
const BACKUPS = path.join(D, 'backups');
const backupName = (d = new Date()) => `backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json.gz`;
function backupList() {
  try { return fs.readdirSync(BACKUPS).filter((f) => /^backup-[\w-]+\.json\.gz$/.test(f)).sort().reverse().map((f) => ({ name: f, size: fs.statSync(path.join(BACKUPS, f)).size, at: fs.statSync(path.join(BACKUPS, f)).mtimeMs })); } catch { return []; }
}
function writeBackup(name = backupName()) {
  fs.mkdirSync(BACKUPS, { recursive: true });
  const tmp = path.join(BACKUPS, name + '.tmp');
  fs.writeFileSync(tmp, makeBackup());
  fs.renameSync(tmp, path.join(BACKUPS, name));
  const keep = Math.max(1, settings().backupDays || 7);
  for (const b of backupList().filter((x) => !/-manual/.test(x.name)).slice(keep)) { try { fs.unlinkSync(path.join(BACKUPS, b.name)); } catch {} }
  return name;
}
setInterval(() => {
  if (!settings().backupDays) return;
  const now = new Date();
  if (now.getHours() < 3 || fs.existsSync(path.join(BACKUPS, backupName(now)))) return;
  try { log(`Nightly backup: ${writeBackup()}`); } catch (e) { log('Nightly backup failed:', e.message); }
}, 15 * 60e3).unref();
route('GET', '/api/admin/backups', (req, res, p, q, ctx) => { requireAdmin(ctx); return { list: backupList(), days: settings().backupDays }; });
route('POST', '/api/admin/backups', (req, res, p, q, ctx) => { requireAdmin(ctx); const now = new Date(); return { name: writeBackup(backupName(now).replace('.json.gz', `-manual-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}.json.gz`)) }; });
route('GET', '/api/admin/backups/:name', (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  if (!/^backup-[\w-]+\.json\.gz$/.test(p.name)) throw new HttpError(400, 'Bad name');
  serveFile(req, res, path.join(BACKUPS, p.name), { download: p.name.replace(/^backup/, 'iptv-backup') });
});
route('DELETE', '/api/admin/backups/:name', (req, res, p, q, ctx) => { requireAdmin(ctx); if (!/^backup-[\w-]+\.json\.gz$/.test(p.name)) throw new HttpError(400, 'Bad name'); try { fs.unlinkSync(path.join(BACKUPS, p.name)); } catch {} return { ok: true }; });
route('POST', '/api/admin/backups/:name/restore', (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  if (!/^backup-[\w-]+\.json\.gz$/.test(p.name)) throw new HttpError(400, 'Bad name');
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(BACKUPS, p.name))).toString('utf8'));
  restoreFiles(data);
  res.on('finish', () => { log(`Restored ${p.name} — restarting.`); frontLink.tellFrontStopping(); media.stopAll(); setTimeout(() => process.exit(0), 500); });
  return { ok: true, restart: true };
});
function restoreFiles(data) {
  if (!data || data.app !== 'browser-iptv-player' || !data.files) throw new HttpError(400, 'That isn’t a backup file from this app.');
  // (The saved catalogue was made from what's being replaced: built again from the restored lists and settings.)
  try { fs.unlinkSync(SNAP_FILE); } catch {}
  for (const [rel, b64] of Object.entries(data.files)) {
    if (rel.includes('..') || path.isAbsolute(rel)) continue;
    const f = path.join(D, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
  }
  // Don't let the in-memory copies overwrite what was just restored.
  JsonFile.discardAll && JsonFile.discardAll();
}

// ---- updates: new code dropped into the app folder (or uploaded here as a .zip) takes effect without a rebuild
const CODE_FILES = /^(server\.js|package\.json|Dockerfile|docker-entrypoint\.sh|README\.md|IMPROVEMENTS\.md|LICENSE|defaults\.example\.json|\.dockerignore|(lib|web|public|extension|test)\/.+)$/;
const inDocker = fs.existsSync('/.dockerenv');
function codeSignature() {
  const h = crypto.createHash('sha1');
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/^(node_modules|data|test|\.git|github)$/.test(e.name)) walk(f); } else if (/\.(js|css|html|json)$/.test(e.name)) { try { const st = fs.statSync(f); h.update(f + st.size + st.mtimeMs); } catch {} }
    }
  };
  walk(path.join(cfg.root, 'lib'));
  walk(path.join(cfg.root, 'web'));
  for (const f of ['server.js', 'package.json']) { try { const st = fs.statSync(path.join(cfg.root, f)); h.update(f + st.size + st.mtimeMs); } catch {} }
  return h.digest('hex');
}
const update = { started: Date.now(), sig: codeSignature(), webSig: '', pending: null, version: cfg.version };
function webSignature() { try { return buildBundle().v; } catch { return ''; } }
/** Restart when nobody is watching through the server (or after 30 minutes regardless). */
function restartWhenIdle(reason) {
  if (update.pending) return;
  update.pending = { reason, since: Date.now() };
  log(`Update: ${reason} — restarting when nobody is watching through the server.`);
  const tick = setInterval(() => {
    const busy = media.sessions.size > 0 || !!(dvrHooks.dvrConns && dvrHooks.dvrConns().length); // (recordings too)
    if (busy && Date.now() - update.pending.since < 30 * 60e3) return;
    clearInterval(tick);
    hub.toAll('restarting', {});
    frontLink.tellFrontStopping(); // (new visitors get "Back in a moment" from now on, not a server about to go)
    JsonFile.flushAll();
    setTimeout(() => process.exit(0), 800);
  }, 5000);
}
setInterval(() => {
  const sig = codeSignature();
  if (sig === update.sig) return;
  // Wait until the files stop changing (a copy in progress).
  setTimeout(() => {
    if (codeSignature() !== sig) return;
    update.sig = sig;
    let pkg = cfg.version;
    try { pkg = JSON.parse(fs.readFileSync(path.join(cfg.root, 'package.json'), 'utf8')).version; } catch {}
    update.version = pkg;
    // Only the web app changed: rebuild it and ask open pages to reload. Server code: a restart.
    const old = bundle && bundle.v;
    let serverChanged = true;
    try { serverChanged = update.serverSig !== serverSignature(); } catch {}
    if (!serverChanged) { const v = webSignature(); if (v && v !== old) { log('Update: the web app changed — devices will reload.'); hub.toAll('app-updated', { v }); } return; }
    // The admin restarts the server when it suits them (it's never restarted for them, unless SELF_RESTART=1).
    if (process.env.SELF_RESTART === '1') restartWhenIdle('new server code');
    else { update.needsRestart = true; log('Update: new server code is on disk — it takes effect when you restart the server.'); }
  }, 10e3);
}, 60e3).unref();
function serverSignature() {
  const h = crypto.createHash('sha1');
  for (const f of ['server.js', 'package.json', ...fs.readdirSync(path.join(cfg.root, 'lib')).map((x) => 'lib/' + x)]) { try { const st = fs.statSync(path.join(cfg.root, f)); h.update(f + st.size + st.mtimeMs); } catch {} }
  return h.digest('hex');
}
update.serverSig = serverSignature();
route('GET', '/api/admin/update', (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  return { version: cfg.version, onDisk: update.version, needsRestart: !!update.needsRestart, pending: update.pending, docker: inDocker, autoRestart: process.env.SELF_RESTART === '1', started: update.started, writable: (() => { try { fs.accessSync(cfg.root, fs.constants.W_OK); return true; } catch { return false; } })() };
});
route('POST', '/api/admin/update', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  const buf = await readBody(req, 100 * 1024 * 1024);
  let files;
  try { files = unzip(buf); } catch (e) { throw new HttpError(400, e.message); }
  // A zip of the folder ("browser-iptv-player/server.js") or of its contents ("server.js").
  const prefix = files.some((f) => f.name === 'server.js') ? '' : ((files.find((f) => /(^|\/)server\.js$/.test(f.name)) || {}).name || '').replace(/server\.js$/, '');
  const picked = files.map((f) => ({ ...f, rel: f.name.startsWith(prefix) ? f.name.slice(prefix.length) : '' })).filter((f) => f.rel && CODE_FILES.test(f.rel) && !f.rel.includes('..'));
  if (!picked.some((f) => f.rel === 'server.js') || !picked.some((f) => f.rel === 'package.json')) throw new HttpError(400, 'That zip doesn’t contain this app (no server.js / package.json).');
  let version = '';
  try { version = JSON.parse(picked.find((f) => f.rel === 'package.json').data.toString('utf8')).version; } catch {}
  for (const f of picked) {
    const dest = path.join(cfg.root, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest + '.new', f.data);
    fs.renameSync(dest + '.new', dest);
  }
  log(`Update: ${picked.length} files from an uploaded zip (version ${version || '?'}) — your settings and data were left alone.`);
  update.sig = codeSignature();
  update.version = version || update.version;
  const auto = process.env.SELF_RESTART === '1';
  if (auto) restartWhenIdle('update uploaded'); else update.needsRestart = true;
  return { ok: true, files: picked.length, version, restart: auto };
});
route('POST', '/api/admin/restore', async (req, res, p, q, ctx) => {
  requireAdmin(ctx);
  let data;
  try { let buf = await readBody(req, 2 * 1024 * 1024 * 1024); if (buf[0] === 0x1f) buf = zlib.gunzipSync(buf); data = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'That isn’t a backup file from this app.'); }
  restoreFiles(data);
  res.on('finish', () => { log('Backup restored — restarting.'); frontLink.tellFrontStopping(); media.stopAll(); setTimeout(() => process.exit(0), 500); });
  return { ok: true, restart: true };
});

// ---- feature modules: each registers its routes here (one line each, kept apart so parallel work merges cleanly)
// [routes:p1]
require('./lib/routes-p1')({ route, requireProfile, readJSON, HttpError, item, inputOf, isUrl, proxy, castSign, siteOrigin, relayOf, srcList: (it, alt) => srcList(it, alt), settings });

// [routes:p2]
require('./lib/routes-p2')({ route, requireProfile, readJSON, social, item, inputOf, isUrl, proxy, srcList, connLimit, fetchAny, hooks: p2Hooks, stats });

// [routes:p3]
require('./lib/routes-p3')({ route, requireProfile, requireAdmin, readJSON, HttpError, serveFile, catalog: () => catalog, epg, lists, overrides, hub, settings, progOut, chanShift, scheduleRebuild, nowCache });

// [routes:p4]
const p4 = require('./lib/routes-p4')({
  route, requireProfile, requireAdmin, readJSON, HttpError, catalog, lists, accounts, epg, settings, tmdb, media, proxy, castSign, inputOf, videoViaProxy,
  connLimit, listUsage, serveFile, clientIp, userdata, Catalog, dataDir: D, ready: () => catalogReady,
  relayExtra: (id) => relayFinished.extra(id),
  loopbackBase: () => `${tls ? 'https' : 'http'}://127.0.0.1:${cfg.port}`, // (other apps' tuner streams fetch the relay through this server)
});
// (Counted like recordings: nobody can take the connection over from an app this server can't tell to stop.)
otherAppConns = () => [...p4.outputs.active].filter(([, a]) => a.kind === 'hdhr' && a.live)
  .map(([id, a]) => ({ id, pid: a.pid, deviceName: 'HDHomeRun tuner', playing: { k: a.k, n: a.n, at: a.since, alt: -1 }, rec: true }));

// [routes:p5]
// Subtitles (OpenSubtitles), Trakt, the live viewing dashboard, the speed test, API keys and webhooks.
const p5 = require('./lib/routes-p5')({
  route, requireProfile, requireAdmin, readJSON, D, lists, accounts, userdata, hub, tmdb, item, clientIp, listUsage, srcList, connLimit, accountAlerts, COMMANDS,
  catalog: () => catalog, fetch: fetchAny, defaultLangs: () => settings().defaultLangs, proxyHeaders: (it) => proxy.headers({ h: it.h }),
});
p5Public = p5.publicFlags;

// [routes:errors] Error reports from devices (and the admin's view of them).
reports.install({ route, requireAdmin, readBody, HttpError, clientIp });

// [routes:p11] Screen time and bedtime for profiles (enforced on the server), the profile's default remote buttons.
require('./lib/routes-p11')({ route, routes, requireProfile, requireAdmin, readJSON, HttpError, D, accounts, hub, media, social });
require('./lib/routes-p12')({ route, requireProfile, requireAdmin, readJSON, D, catalog: () => catalog, epg, chanShift, inputOf, srcList, connLimit, listUsage, accounts, hub, media, lists, item, hooks: dvrHooks, relayExtra: (id) => relayFinished.extra(id) });
// [routes:p10] Home rows from Trakt / TMDB lists, the Wishlist and new-arrival alerts, and "Your viewing".
const p10 = require('./lib/routes-p10')({ route, requireProfile, requireAdmin, readJSON, D, userdata, accounts, hub, tmdb, trakt: p5.trakt, catalog: () => catalog });
followsOf = p10.followsOf;
{ const prev = p5Public; p5Public = () => ({ ...prev(), ...p10.publicFlags() }); }
// [routes:p7] The play queue (per profile, synced between its devices).
require('./lib/routes-p7')({ route, requireProfile, readJSON, HttpError, userdata, hub, catalog: () => catalog });
// [routes:p9] Channel health (dead channels, uptime, background checks) and finding guides and logos in public databases.
require('./lib/routes-p9')({
  route, requireProfile, requireAdmin, readJSON, HttpError, D, catalog: () => catalog, lists, hub, epg, overrides, nowCache, listUsage, log,
  fetch: fetchAny, headers: (h) => proxy.headers({ h }), via: viaRelay, connTest, media, p4, hooks: p9Hooks,
});
// [routes:p8] Following teams and competitions (Events, automatic reminders); event / PPV channels' listings from their names.
const p8 = require('./lib/routes-p8')({ route, requireProfile, requireAdmin, readJSON, HttpError, D, catalog: () => catalog, epg, lists, userdata, accounts, hub, overrides, chanShift, nowCache });
p8Public = p8.publicFlags;
// [routes:p6] Picture subtitles (PGS, VobSub, DVB) for the player to draw itself.
require('./lib/routes-p6')({ route, item, inputOf, connLimit, media, lists });

// ---- exports for other apps (VLC, Kodi, Plex…): /k/<exportKey>/playlist.m3u and /k/<exportKey>/epg.xml
function exportM3U(req, res, key) {
  const b = `${req.headers['x-forwarded-proto'] && cfg.trustProxy ? req.headers['x-forwarded-proto'] : secureReq(req) ? 'https' : 'http'}://${req.headers.host}/k/${key}`;
  const items = catalog.items.filter((it) => it.u && it.t !== 'show' && !it.adult && p4.exportable(it)).map((it) => ({
    // (A list that uses the stream relay: other apps go through it too.)
    name: it.n, url: it.loc ? `${b}/file/${it.loc.list}/${it.loc.id}` : ((viaRelay(it.u, { ...(settings().userAgent ? { 'User-Agent': settings().userAgent } : {}), ...(it.h || {}) }, it.src) || {}).url || it.u), tvgId: it.epg ? it.k : '', tvgName: it.n, logo: it.logo && it.logo.startsWith('/api/channel-logo/') ? `${b}/logo/${it.logo.slice(18)}` : it.logo, group: it.g, chno: it.num || '', headers: it.h || {}, type: it.t === 'episode' ? 'series' : it.t,
  }));
  sendText(res, 200, P.generate(items, `${b}/epg.xml`), 'audio/x-mpegurl; charset=utf-8', { 'Content-Disposition': 'inline; filename="playlist.m3u"' });
}
function exportXmltv(req, res) {
  const now = Date.now();
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="browser-iptv-player">'];
  const live = catalog.items.filter((it) => it.epg && !it.adult && p4.exportable(it));
  for (const it of live) out.push(`<channel id="${xmlEsc(it.k)}"><display-name>${xmlEsc(it.n)}</display-name>${it.logo ? `<icon src="${xmlEsc(it.logo)}"/>` : ''}</channel>`);
  for (const it of live) {
    const sh = chanShift(it);
    for (const x of epg.range(it.epg, now - 2 * 3600e3 - sh, now + settings().epgDays * 86400e3 - sh)) {
      let s = `<programme start="${fmtTime(x.s + sh)}" stop="${fmtTime(x.e + sh)}" channel="${xmlEsc(it.k)}"><title>${xmlEsc(x.t)}</title>`;
      if (x.st) s += `<sub-title>${xmlEsc(x.st)}</sub-title>`;
      if (x.d) s += `<desc>${xmlEsc(x.d)}</desc>`;
      out.push(s + '</programme>');
    }
  }
  out.push('</tv>');
  const raw = Buffer.from(out.join('\n'));
  sendGz(req, res, raw, zlib.gzipSync(raw), 'application/xml; charset=utf-8');
}

// ---------------------------------------------------------------- web app (built from web/ on start)
const WEB = path.join(cfg.root, 'web');
const PUBLIC = path.join(cfg.root, 'public');
let bundle = null;
function buildBundle() {
  const order = JSON.parse(fs.readFileSync(path.join(WEB, 'order.json'), 'utf8'));
  const parts = order.js.map((f) => ({ file: f, text: fs.readFileSync(path.join(WEB, 'js', f), 'utf8') }));
  const js = parts.map((p) => `/* ${p.file} */\n` + p.text).join('\n;\n');
  const css = cssFallbacks(order.css.map((f) => fs.readFileSync(path.join(WEB, 'css', f), 'utf8')).join('\n'));
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const v = crypto.createHash('sha1').update(js + css + html).digest('hex').slice(0, 10);
  const mk = (s) => { const raw = Buffer.from(s); return { raw, gz: zlib.gzipSync(raw, { level: 9 }), etag: `"${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16)}"` }; };
  bundle = { v, js: mk(js), css: mk(css), html, sw: mk(fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8').replace('__VERSION__', v)) };
  reports.setBundle(v, parts); // (so error reports can name the file and line in web/js)
  return bundle;
}
const getBundle = () => (process.env.DEV ? buildBundle() : bundle || buildBundle());
function appHtml() {
  const b = getBundle();
  const s = settings();
  const brand = s.brand || {};
  const esc = (x) => String(x || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return b.html.replace(/__V__/g, b.v).replace(/__BRAND__/g, esc(brand.name)).replace('__ACCENT__', /^#[0-9a-f]{6}$/i.test(brand.accent || '') ? `<style>:root{--brand:${brand.accent}}</style>` : '');
}
const LOGIN_HTML = () => fs.readFileSync(path.join(WEB, 'login.html'), 'utf8');

// ---------------------------------------------------------------- server
const HOSTNAME = os.hostname().toLowerCase();
function hostAllowed(hostHeader) {
  if (!hostHeader) return true;
  const h = hostHeader.toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return true;
  if (h === HOSTNAME || h === `${HOSTNAME}.local` || h === HOSTNAME.split('.')[0] || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa') || h.endsWith('.ts.net')) return true;
  if (cfg.allowedHosts.includes('*') || cfg.allowedHosts.includes(h) || (settings().allowedHosts || []).includes(h)) return true;
  try { if (settings().directAddress && new URL(settings().directAddress).hostname.toLowerCase() === h) return true; } catch {}
  // Once the site password isn't the default one, any address is fine (a stranger's page can't sign in).
  return !accounts.d.site.isDefault;
}

async function handle(req, res) {
  let u;
  // (An address like "//" or "//a:b" isn't a path at all: answer it rather than leave the request hanging.)
  try { u = new URL(req.url, 'http://x'); } catch { return sendJSON(res, 400, { error: 'Bad request' }); }
  let pathname;
  try { pathname = decodeURIComponent(u.pathname); } catch { pathname = u.pathname; }
  const ctx = { sess: null, profile: null, conn: req.headers['x-conn'] || '' };
  try {
    if (!hostAllowed(cfg.trustProxy && req.headers['x-forwarded-host'] ? req.headers['x-forwarded-host'] : req.headers.host)) {
      throw new HttpError(403, `This server doesn’t answer to “${req.headers.host}”. Add it with the ALLOWED_HOSTS setting (see README), or change the site password first.`);
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Just started: the page loads straight away; what needs the catalogue waits for it to be ready.
    // (At most 40 s — with the catalogue's own wait, under 100 s in all: a huge catalogue can take longer after a restart than a proxy waits — Cloudflare gives up after
    // 100 s and the page gets its error page. "Starting up" instead, and the page asks again by itself.)
    if (catalogReady && /^\/(api|c|k|h)\//.test(pathname) && !/^\/api\/(login|boot|pair\/|events|profiles\/[^/]+\/select$|profiles\/leave$)/.test(pathname)) {
      const ready = await Promise.race([catalogReady.then(() => true, () => true), new Promise((r) => setTimeout(r, 40e3, false).unref())]);
      if (!ready) { res.setHeader('Retry-After', '5'); return sendJSON(res, 503, { error: 'The server is starting up — the catalogue is nearly ready.', starting: true }); }
    }

    // Cast links: /c/<token>/api/session/... etc. — no cookie needed, CORS open, valid for a few hours.
    const cm = pathname.match(/^\/c\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)(\/api\/(?:session|proxy|local)\/?.*)$/);
    if (cm) {
      const sig = crypto.createHmac('sha256', castSecret).update(cm[1]).digest('base64url').slice(0, 24);
      let tok;
      try { tok = JSON.parse(Buffer.from(cm[1], 'base64url').toString('utf8')); } catch {}
      if (sig !== cm[2] || !tok || tok.e < Date.now() / 1000 || !(cm[3] === tok.p || cm[3].startsWith(tok.p + '/'))) throw new HttpError(403, 'This cast link has expired.');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Allow-Methods': 'GET, HEAD' }); return res.end(); }
      req.cast = `/c/${cm[1]}.${cm[2]}`;
      pathname = cm[3];
      ctx.sess = { id: 'cast' };
      for (const r of routes) {
        if (r.level !== 'site' || (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD'))) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
        const out = await r.handler(req, res, params, u.searchParams, ctx);
        if (!res.headersSent && out !== undefined) sendJSON(res, 200, out);
        return;
      }
      throw new HttpError(404, 'Not found');
    }

    // Exports with the access key.
    const km = pathname.match(/^\/k\/([a-f0-9]+)\/(playlist\.m3u|epg\.xml|file\/([^/]+)\/([^/]+)|logo\/([a-f0-9]{20}\.(?:png|jpg|webp)))$/);
    if (km) {
      if (!crypto.timingSafeEqual(Buffer.from(km[1].padEnd(24).slice(0, 24)), Buffer.from(String(settings().exportKey).padEnd(24).slice(0, 24))) || km[1] !== settings().exportKey) throw new HttpError(401, 'Wrong access key');
      if (km[2] === 'playlist.m3u') return exportM3U(req, res, km[1]);
      if (km[2] === 'epg.xml') return exportXmltv(req, res);
      if (km[5]) { const lf = overrides.logoPath(km[5]); if (!lf) throw new HttpError(404, 'Not found'); return serveFile(req, res, lf, { cache: 'max-age=86400' }); }
      const li = lists.libraryItem(km[3], km[4]);
      if (!li) throw new HttpError(404, 'Not found');
      return serveFile(req, res, li.path);
    }

    // Other apps: Xtream Codes logins and the HDHomeRun tuner (off unless the admin turned them on).
    if (await p4.handle(req, res, pathname, u.searchParams)) return;

    const hm = pathname.match(/^\/h\/([A-Za-z0-9_-]{20,})$/);
    if (hm && req.method === 'GET') return handoffLanding(req, res, hm[1]);

    // The automation API (Home Assistant, scripts): API keys instead of cookies, so no CSRF header is needed.
    if (pathname.startsWith('/api/v1/')) { await p5.handleApi(req, res, pathname, u.searchParams); return; }

    ctx.sess = accounts.session(req);
    if (ctx.sess && ctx.sess.profileId) ctx.profile = accounts.profile(ctx.sess.profileId);
    // The profile's PIN was changed since this device entered it: choose the profile again (with the new PIN).
    if (ctx.profile && !accounts.pinCurrent(ctx.sess, ctx.profile)) ctx.profile = null;
    // Keep the browser's cookie as fresh as the session: renewed once a day when the app is opened, so a device in
    // regular use never has to sign in again.
    if (ctx.sess && (pathname === '/' || pathname === '/api/boot') && Date.now() - (ctx.sess.cookieAt || ctx.sess.created) > 86400e3) {
      ctx.sess.cookieAt = Date.now();
      accounts.store.save();
      res.setHeader('Set-Cookie', accounts.cookie(accounts.token(req), secureReq(req)));
    }

    // CSRF: changes must come from our own pages (a custom header can't be sent cross-site without CORS approval).
    if (pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method) && req.headers['x-app'] !== '1') throw new HttpError(403, 'Missing X-App header');

    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        if (r.level !== 'public' && !ctx.sess) throw new HttpError(401, 'Sign in required');
        if (r.level === 'profile' && !ctx.profile) throw new HttpError(403, 'Choose a profile first.');
        const params = {};
        r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
        const out = await r.handler(req, res, params, u.searchParams, ctx);
        if (!res.headersSent && out !== undefined) sendJSON(res, 200, out);
        return;
      }
      throw new HttpError(ctx.sess ? 404 : 401, ctx.sess ? 'Not found' : 'Sign in required');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');

    // Signed out: the sign-in page and a neutral icon are all there is.
    if (!ctx.sess) {
      if (pathname === '/favicon.ico' || pathname === '/icon.svg') return serveFile(req, res, path.join(PUBLIC, 'icon.svg'), { cache: 'max-age=86400' });
      if (pathname !== '/') { res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' }); return res.end(); }
      return sendText(res, 200, LOGIN_HTML(), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
    }
    const b = getBundle();
    if (pathname === '/app.js') return sendGz(req, res, b.js.raw, b.js.gz, 'text/javascript; charset=utf-8', b.js.etag);
    if (pathname === '/app.css') return sendGz(req, res, b.css.raw, b.css.gz, 'text/css; charset=utf-8', b.css.etag);
    if (pathname === '/sw.js') return sendGz(req, res, b.sw.raw, b.sw.gz, 'text/javascript; charset=utf-8', b.sw.etag);
    if (pathname === '/manifest.webmanifest') {
      const s = settings();
      return sendText(res, 200, JSON.stringify({
        name: s.brand.name, short_name: s.brand.name.slice(0, 14), start_url: '/', display: 'standalone', background_color: '#0b0d12', theme_color: '#0b0d12',
        icons: [{ src: '/brand-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }, { src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
      }), 'application/manifest+json');
    }
    if (pathname === '/brand-icon.svg') {
      const s = settings();
      const logo = s.brand.logo || '';
      if (/^data:image\//.test(logo)) {
        const m = logo.match(/^data:(image\/[a-z+.-]+);base64,(.*)$/i);
        if (m) { const buf = Buffer.from(m[2], 'base64'); res.writeHead(200, { 'Content-Type': m[1], 'Content-Length': buf.length, 'Cache-Control': 'no-cache' }); return res.end(buf); }
      }
      return serveFile(req, res, path.join(PUBLIC, 'icon.svg'));
    }
    if (pathname === '/' || !path.extname(pathname)) return sendText(res, 200, appHtml(), 'text/html; charset=utf-8', { 'Cache-Control': 'no-cache', 'X-Page': 'app' });
    const file = path.join(PUBLIC, path.normalize(pathname.slice(1)));
    if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(403, 'Forbidden');
    return serveFile(req, res, file, { cache: pathname.startsWith('/vendor/') ? 'public, max-age=2592000, immutable' : 'no-cache' });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500 && ![501, 502, 503, 504].includes(status)) {
      console.error(err);
      if (!err.status) reports.addServer(err, { method: req.method, path: pathname, profile: ctx.profile && ctx.profile.name, device: ctx.sess && ctx.sess.name });
    }
    if (!res.headersSent) sendJSON(res, status, { error: err.message || 'Server error' });
    else res.destroy();
  }
}

const tls = cfg.httpsCert && cfg.httpsKey ? { cert: fs.readFileSync(cfg.httpsCert), key: fs.readFileSync(cfg.httpsKey) } : null;
const server = tls ? https.createServer(tls, handle) : http.createServer(handle);
server.keepAliveTimeout = 65000;
server.requestTimeout = 0;
server.headersTimeout = 70000;

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Shutting down…');
  frontLink.tellFrontStopping();
  media.stopAll();
  JsonFile.flushAll();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// The server being stuck (one job hogging it, so pages and streams wait): say so in the log, with how long, so slow
// spells can be matched up with what was going on at the time.
{
  let last = Date.now(), worst = 0, since = 0;
  setInterval(() => {
    const now = Date.now(), lag = now - last - 1000;
    last = now;
    if (lag > 3000) { worst = Math.max(worst, lag); if (!since) since = now; }
    if (since && (lag <= 3000 || now - since > 60e3)) {
      const mem = process.memoryUsage();
      log(`The server was busy for ${(worst / 1000).toFixed(1)} s and didn’t answer in that time (memory ${Math.round(mem.rss / 1048576)} MB)`);
      worst = 0; since = 0;
    }
  }, 1000).unref();
}
// A home server should keep running: log unexpected errors instead of dropping everyone's streams.
process.on('uncaughtException', (e) => { console.error('Unexpected error (the server keeps running):', e && e.stack || e); reports.addServer(e, { where: 'uncaught exception' }); });
process.on('unhandledRejection', (e) => { console.error('Unhandled promise rejection (the server keeps running):', e && e.stack || e); reports.addServer(e instanceof Error ? e : new Error(String(e)), { where: 'unhandled promise rejection' }); });

(async () => {
  const T = { modules: process.uptime() - tmdbLoadS, 'TMDB details': tmdbLoadS };
  let t = Date.now();
  const ff = await media.detect();
  T.ffmpeg = (Date.now() - t) / 1000; t = Date.now();
  for (const g of lists.guides()) if (!g.enabled) epg.removeSource(g.id);
  epg.setOrder(lists.guides().filter((g) => g.enabled).map((g) => g.id));
  buildBundle();
  T.bundle = (Date.now() - t) / 1000; t = Date.now();
  // Answer straight away ("getting ready…"); the catalogue is put in place in the background, and anything that needs
  // it waits for it. Quickest: the one saved last time (see saveSnapshot). Otherwise the saved lists are read and it's
  // built from them (with the guides in, so channels get their listings).
  const timing = () => Object.entries(T).map(([k, v]) => `${k} ${v.toFixed(1)} s`).join(', ');
  let stale = false;
  catalogReady = (async () => {
    let snap = null;
    try { snap = await catsnap.load(SNAP_FILE); } catch (e) { log(`The saved catalogue can’t be used (${e.message}): building it from the lists`); }
    if (snap && snap.head && snap.head.v === 1 && snap.items.length) {
      lists.fromSnapshot(snap.head.lists || {});
      catalog.restore(snap.items, snap.head, snap.extras);
      // (Details found on TMDB since it was saved.)
      const meta = tmdb.meta.data.m;
      for (const it of catalog.items) applyMeta(it, meta[it.k]);
      builtSig = snap.head.sig || '';
      builtKeep = keepSig(catalog._keep || null);
      snapVersion = catalog.version; snapSig = builtSig; snapAt = Date.now();
      stale = builtSig !== catalogInputs();
      T.catalog = (Date.now() - t) / 1000;
      log(`Ready ${process.uptime().toFixed(1)} s after starting, with the saved catalogue: ${catalog.items.length.toLocaleString('en-US')} items${stale ? ' — something it’s made from changed (lists, settings or an update), so it’s built again in the background meanwhile' : ''} (${timing()}, ${(snap.bytes / 1048576).toFixed(0)} MB)`);
      afterCatalog();
      epg.load(); // (the guides after it: they don't hold up the catalogue)
      return;
    }
    epg.load(); // (alongside the lists)
    await lists.loadSavedAsync();
    T.lists = (Date.now() - t) / 1000; t = Date.now();
    await epg.ready;
    T.guides = (Date.now() - t) / 1000; t = Date.now();
    await rebuildCatalog();
    T.catalog = (Date.now() - t) / 1000;
    log(`Ready ${process.uptime().toFixed(1)} s after starting (${timing()})`);
  })()
    .catch((e) => log('Start-up:', e && e.stack || e))
    .then(() => {
      catalogReady = null;
      epg.load();
      lists.startScheduler();
      // The saved catalogue was out of date: the lists it doesn't know are read, then it's built again (once the
      // guides are in, so channels keep their listings). Everything works with the saved one meanwhile.
      if (stale) lists.loadSavedAsync({ missingOnly: true }).then(() => epg.ready).then(() => rebuildCatalog()).catch((e) => log('Start-up:', e && e.stack || e));
    });
  // Under the front (lib/front.js), which holds the port and hands over each connection; otherwise on the port itself.
  const front = require('./lib/front');
  const announce = () => {
    log(`Answering ${process.uptime().toFixed(1)} s after starting (memory limit ${(require('v8').getHeapStatistics().heap_size_limit / 1073741824).toFixed(1)} GB)`);
    const shown = ['0.0.0.0', '::'].includes(cfg.host) ? 'localhost' : cfg.host;
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log('');
    console.log(`  ${settings().brand.name} ${cfg.version} is running`);
    console.log(`  ➜ Open      ${tls ? 'https' : 'http'}://${shown}:${cfg.port}`);
    for (const ip of ['0.0.0.0', '::'].includes(cfg.host) ? ips : []) console.log(`  ➜ Network   ${tls ? 'https' : 'http'}://${ip}:${cfg.port}`);
    console.log(`  ➜ Data      ${D}`);
    console.log(`  ➜ ffmpeg    ${ff.ffmpeg ? `found (${ff.version})` : 'NOT FOUND – conversion of MKV/AVI/HEVC/RTMP etc. is off'}`);
    if (accounts.presetApplied) console.log(`  ➜ Password  changed to the new one in ${process.env.SITE_PASSWORD ? "SITE_PASSWORD" : "defaults.json"} — everyone has been signed out`);
    else if (accounts.d.site.isDefault) console.log(`  ➜ Password  the site password is still the default (${defaultPassword}) — change it in Admin`);
    console.log('');
  };
  if (front.attachToFront(server)) { announce(); front.tellFrontReady(); } else server.listen(cfg.port, cfg.host, announce);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${cfg.port} is already in use. Start with --port 8081 (or set PORT).`);
    else console.error(e);
    process.exit(1);
  });
})();
