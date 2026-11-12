# Where things are

A one-page map for finding your way around the code. Node.js and ffmpeg, no npm packages, no build step.

```
server.js          the server: settings, routes, start-up            lib/     what the server is made of
web/               the app in the browser (plain JS and CSS)         relay/   the optional stream relay (runs elsewhere)
public/            icons and the bundled players (see VENDOR.md)     test/    npm test
extension/         the optional direct-streams browser helper        docs/    the longer guides
```

## How a request travels

1. **`lib/front.js`** holds the web port and starts `server.js` as a child, so a restart doesn't drop viewers.
2. **`server.js`** checks the host name, the site-password session (`lib/accounts.js`), then the profile, and finds the
   route. Routes are registered with `route(method, path, handler, level)`; the sections of `server.js` are marked
   `// ---- sign in`, `// ---- profiles`, `// ---- playback`, `// ---- admin` and so on. Newer features register
   theirs from `lib/routes-*.js` (listed under `// ---- feature modules` near the end).
3. The browser gets one page (`web/index.html`), one script (`/app.js`: the files of `web/js` joined in the order
   of `web/order.json`) and one stylesheet (`/app.css`, the same way). Everything in the browser hangs off one
   object, `V`, with its state in `S`. **`web/js` is written in ES5** so old TV browsers run it: no arrow functions,
   `let`/`const`, template strings, optional chaining or `??`.

## Who may do what

Three tables in `server.js` decide, at the one place requests are matched to routes:

- `GUEST_DENY`: what a guest can't ask for.
- `AREAS` / `AREA_API`: the parts of the app the admin can switch off, and the requests refused while one is off. The browser's side of the same list is `V.AREAS` in `web/js/core.js` (pages, links and menu items go).
- `MANAGER_API`: the admin requests a manager may make too. `requireAdmin()` lets a manager through only for these; anything not listed is the admin's alone, so a new admin route is closed to managers until someone adds it here.

## The server (`lib/`)

| Area | Files |
|---|---|
| **Sign-in, profiles, PINs, guests** | `accounts.js` · per-profile data (history, My List, settings): `userdata.js` · screen time: `screentime.js` · parental locks and channel edits: `overrides.js` |
| **Lists from providers** | `lists.js` (M3U, Xtream, files; fetching, caching, refreshing) · parsing: `parse.js`, `listworker.js` · Stalker portals: `stalker.js` · Jellyfin/Emby/Plex: `mediaserver.js` · media folders: `library.js` |
| **The catalogue** (every list merged into films, series, channels) | `catalog.js` · saved for a quick start: `catsnap.js` · tidy names: `titles.js` · languages: `langs.js` · categories: `smartcats.js` |
| **TV guide** | `epg.js` · reading XMLTV: `xmltv.js` · a Schedules Direct lineup as a guide: `schedulesdirect.js` · saved guide files: `guidefile.js` · suggestions for missing guides and logos: `publicdb.js` · event channels: `events.js` · followed teams: `follow.js` |
| **Film and series details** | `tmdb.js` · recommendations: `recs.js` · Home rows from TMDB lists: `homelists.js` · Wishlist: `wishlist.js` · a Letterboxd or IMDb watchlist file into it: `watchlist-import.js` |
| **Playing** | how a browser can reach a stream itself: `reach.js` · passing a stream through: `proxy.js` · converting with ffmpeg (HLS sessions, probing, thumbnails): `media.js` · one connection shared by a watch party: `fanout.js` · the stream relay's side here: `streamrelay.js` · outgoing connections and proxies: `net.js` |
| **Subtitles** | found online: `subtitles.js`, `subsources.js` · picture subtitles (PGS, VobSub, DVB): `picsubs.js` · made from a film's sound by an optional whisper on the server: `subgen.js` |
| **Skip intro / credits** | `intro.js`, `markers.js` |
| **Recording** | `dvr.js` |
| **Channels the admin makes, and other apps** | 24/7 "My channels": `mychannels.js` · playlists, guide and an HDHomeRun tuner for other apps: `outputs.js` |
| **Provider connections** | who's using which now: `usage.js` · over time: `concurrency.js` · measuring a list's real limit: `conntest.js` · which channels are dead: `health.js` |
| **Household** | messages and watch parties: `social.js` · play queue: `playqueue.js` · "Your viewing": `viewing.js` |
| **For the admin** | playback statistics: `stats.js` · error reports from devices: `errors.js` · API keys: `apikeys.js` · webhooks: `webhooks.js` |
| **Plumbing** | JSON files written safely: `store.js` · start-up options: `config.js` · small helpers: `util.js` · zip, QR codes: `zip.js`, `qr.js`, `qrcode.js` · CSS for old TV browsers: `cssfallbacks.js` |

`lib/routes-p1.js` … `routes-p13.js` hold the routes of features added later; each begins with a comment saying which
(open in another app, watch-party streaming, channel editing, Stalker and outputs, integrations, picture subtitles,
play queue, following and events, channel health, Home lists and the Wishlist, screen time, the DVR, subtitles made from the sound).

## The app in the browser (`web/js/`)

| Area | Files |
|---|---|
| **Start-up and shell** | `main.js` (who's watching → load → show) · `core.js` (helpers, `V.api`, dialogs, menus) · `ui.js` (navigation, router, cards and rows) · `motion.js` · `store.js` (the profile's data and the catalogue, kept in step with the server) · `realtime.js` (the live connection) · `compat.js` (fill-ins for old TV browsers) · `errors.js` (error reports) |
| **The player** | `player.js` (picks hls.js, mpegts.js, Shaka or the browser's own player, and falls back from one way of playing to the next) · `watch.js` (the full-screen layer, mini player, up next, zapping, keys) · `inbrowser.js` (converting in the browser) · `tune.js`, `playprefs.js`, `avsync.js`, `soundfx.js`, `audioonly.js` · subtitles: `captions.js`, `picsubs.js`, `picsubdec.js`, `subtiming.js` · `endcard.js`, `trailers.js`, `extplayer.js`, `catchup.js`, `multiview.js`, `problem.js` (report a problem) |
| **Finding something** | `home.js`, `rightnow.js` · `browse.js` (Movies, Series, Live TV, Radio) · `guide.js`, `epg.js`, `onlater.js` · `search.js`, `searchpage.js`, `palette.js` · `title.js` · `mine.js`, `chanlists.js`, `playqueue.js`, `homelists.js`, `follow.js`, `viewing.js` |
| **Profiles and the household** | `profiles.js`, `guest.js`, `settings.js`, `parental.js`, `screentime.js`, `social.js`, `avatars.js`, `themes.js` |
| **Other screens and devices** | `tv.js` (arrow-key navigation) · `keymap.js` · `remote.js`, `easy.js` (phone as a remote, TV sign-in) · `downloads.js` · `dvr.js` |
| **Admin** | `admin.js` (most tabs) · `adminsources.js`, `adminstats.js`, `adminconc.js`, `adminerrors.js`, `channeleditor.js`, `smartcats.js`, `mychannels.js`, `health.js`, `findguides.js`, `integrations.js` |

CSS is in `web/css/`, joined the same way; new rules go in the last file listed in `web/order.json`.

## Where the data lives (`data/`)

Everything the server keeps is a JSON file written through `lib/store.js` (written to a temporary file, then renamed,
with a `.bak` of the last good one): `accounts.json`, `settings.json`, `lists.json` and each list's saved copy in
`lists/`, one file per profile in `users/`, guides in `epg/`, TMDB details in `meta/`, and caches that can always be
thrown away (`cache/`, `tmp/`, `catalog.snapshot`). A backup (Admin → Backups) is all of it except what can be
downloaded again.

## TV apps (`tv-apps/`)

Three thin wrappers — Android TV / Fire TV, Samsung (Tizen), LG (webOS) — that remember the server's address and open it full screen. None holds any of the app: they load the pages above. Their one link to this code is the way out: `V.leaveApp` in `web/js/tv.js` calls whichever wrapper it is in. See `tv-apps/README.md`.

## Working on it

```bash
DEV=1 node server.js     # rebuilds /app.js and /app.css on every request
npm test                 # every test/*.test.js with Node's own test runner (ffmpeg needed for some)
```

- A change to `web/js` must stay ES5 (see above). A change to a page's HTML can't put script in it — no
  `onclick="…"`: the Content-Security-Policy doesn't run it (`test/backup.test.js` checks both pages and every script).
- New settings: a default in `DEFAULT_SETTINGS` (`server.js`), accepted in `PUT /api/admin/settings`, shown in
  `web/js/admin.js`.
- Nothing provider-supplied goes into HTML without `V.esc()`.
