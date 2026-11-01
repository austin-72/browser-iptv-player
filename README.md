# Browser IPTV Player

A self-hosted IPTV and media server with a Netflix-style web app. The household signs in, picks a profile, and watches live TV, movies and series from the playlists the admin has set up. It works on computers, phones, tablets and TV browsers.

- **One sign-in, many profiles.** There are 142 profile pictures, PINs are optional and every profile keeps its own history.
- **The admin sets up the playlists once.** That can be M3U links or files, Xtream Codes accounts, or folders of your own videos. They are merged and deduplicated, then filtered per profile by language and age rating.
- **It plays almost anything.** Streams go straight from the provider to the browser when they can. When a browser can't play a stream (blocked by CORS, needs special headers, wrong codec, wrong container), the server relays or converts it automatically.
- **Recommendations, watch parties, messaging, offline downloads, casting**, and themes with a TV-remote mode.

No npm dependencies. You need Node.js 20 or later (22 recommended), plus ffmpeg for the conversion features.

---

## Quick start

### With Docker

```bash
docker compose up -d
```

Open `http://<this computer's IP>:8080`. Everything the app saves is kept in `./data`.

Without Compose:

```bash
docker build -t browser-iptv-player .
docker run -d --name iptv -p 8080:8080 -v "$PWD/data:/data" --restart unless-stopped browser-iptv-player
```

The image includes ffmpeg. It runs as an unprivileged user and fixes the owner of `/data` on start-up. Set `PUID`/`PGID` to run as a specific host user instead.

### Without Docker

```bash
# install Node.js 22 and ffmpeg (e.g. `sudo apt install ffmpeg`, `brew install ffmpeg`, `winget install ffmpeg`)
node server.js            # or: npm start
```

Options can go on the command line (`--port 9000 --data /srv/iptv`) or in environment variables (see below).

### First run

1. Sign in with the default site password: **`changeme`**, or whatever you put in `SITE_PASSWORD`.
2. Create the first profile. **It becomes the only admin** and must have a PIN.
3. Open **Admin**:
   - **Security**: change the site password.
   - **Lists**: add your playlists.
   - **TV guides**: add an XMLTV guide if your lists don't name one.
   - **Languages & content**: choose the default languages, e.g. English only.
4. Everyone else signs in with the site password and adds their own profile. You can also set **Admin → Profiles → Only the admin can add profiles**.

Nothing is shown to someone who hasn't signed in: not the brand, the channels or the profiles. All they get is a plain sign-in page.

---

## Configuration

Almost everything is set in the **Admin** screen and saved in `data/`. These are the start-up options:

| Environment variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port to listen on (or `"port"` in `defaults.json`, or `--port`) |
| `HOST` | `0.0.0.0` | Address to listen on |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where accounts, lists, caches and history are stored |
| `SITE_PASSWORD` | `changeme` | The site password used the very first time. After that, change it in Admin → Security |
| `ALLOWED_HOSTS` | — | Extra host names to answer to while the default password is still in use (see Security) |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy, so the real client IP and https are used |
| `HTTPS_CERT`, `HTTPS_KEY` | — | Paths to a certificate and key, so the server speaks https itself |
| `HWACCEL` | — | `vaapi`, `qsv`, `nvenc` or `videotoolbox` for hardware transcoding. Falls back to software if it fails |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | Render device for VAAPI |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` | Where ffmpeg is installed if it isn't on the PATH |
| `TMDB_BASE` | TMDB's API | Only for testing |

### Branding

**Admin → Brand** sets the site name, logo and accent colour. To ship a build that is already branded, put a `defaults.json` next to `server.js` (see `defaults.example.json`):

```json
{ "brand": { "name": "Our TV", "accent": "#e50914" }, "sitePassword": "something-better" }
```

`defaults.json` only sets starting values. Anything changed in Admin takes priority.

---

## How playback works (and getting around CORS)

When a page's JavaScript reads video from another site, the browser asks that site for permission (CORS), and many IPTV providers don't give it. That is why web IPTV players so often fail on live channels. But the check only applies to JavaScript reading the bytes. The browser's own player doesn't need permission, and providers often block their playlists while allowing their video segments. So before playing, the server asks the provider exactly what the browser would be told: same Origin header, every redirect hop checked, playlist and segments checked separately. It remembers the answer per provider, so zapping doesn't open extra connections. Then the player uses the most direct route that will work:

1. **Direct, full controls.** The provider allows web players. hls.js, mpegts.js or Shaka read the stream straight from the provider. If a redirect is what blocks it, the browser is given the final address instead.
2. **Direct, built-in player.** No permission needed:
   - MP4/WebM films play in every browser;
   - HLS plays on Safari, iPhone/iPad, Android, most smart TVs and current Chrome/Edge.
3. **Direct, HLS copy.** A raw MPEG-TS channel from an Xtream Codes panel is also served as HLS (`/live/user/pass/123.m3u8`), which routes 1, 2 or 4 can use.
4. **Direct video, playlist via the server.** When only the playlists are blocked, the server passes on the playlist text (a few KB every few seconds) and the browser fetches all the video straight from the provider.
5. **Through the server (relay).** This is the last resort, for streams that are blocked completely, need special headers, or are http on an https page. It still uses one provider connection per viewer, as direct would.
6. **Convert.** When the browser can't decode the format (AC-3 audio, HEVC on some browsers, MKV/AVI, UDP/RTMP), ffmpeg repackages or transcodes it.
7. **Backup sources.** When the same channel appears in several lists, any copy can take over.

**The direct-streams helper.** On desktop Chrome, Edge, Brave or Opera, a small browser extension makes *every* stream direct. Settings → Direct streaming has a download button and three steps. It only adds the permission header to responses for requests made by this site's pages; nothing else is touched. The source is in `extension/`. Firefox can load it too, but only until the next restart.

**Provider accounts that allow one connection.** The server never opens a second connection while someone might be watching. Preview pictures, reading tracks or subtitles out of the file, and intro detection are switched off for those titles. Intro detection needs 3 or more connections. Conversion and the direct-playback check wait a moment, so the provider has freed the slot before the stream starts.

Notes:
- The player's stream info (the gear menu → Stream info) shows which route is in use.
- **Admin → Playback** chooses the routing: *direct first* (default), *always through the server*, or *direct only*.
- Errors say what actually went wrong (e.g. "the provider said 403 Forbidden").

---

## Features

**Profiles & accounts**
- Netflix-style "Who's watching?" screen.
- Unlimited profiles and 142 original profile pictures.
- Each device opens straight into the profile last used on it; nobody has to sign in or pick a profile again.
- Optional PINs:
  - "Remember on this device" keeps the PIN for 6 months; untick it to keep it for only 30 minutes;
  - **Lock profile** in the profile menu asks for it again next time;
  - a lockout after wrong guesses.
- Settings has a switch to show "Who's watching?" every time instead.
- The first profile is the admin. The admin can edit or delete profiles, reset PINs, set limits and hand over admin.
- Kids profiles and per-profile age limits: five levels, read from US, UK and EU ratings. Profiles can also be limited to certain types and categories. Adult content is hidden unless allowed.
- Each profile keeps its own:
  - progress, history, My List, favourites, ratings, bookmarks and notes;
  - hidden titles, hidden or pinned categories, reminders and recent searches;
  - home-screen layout, theme, subtitle style and language choices.

**Library**
- Lists:
  - M3U/M3U8 links or uploads (gzip, any text encoding);
  - Xtream Codes (live, films and series via the API, with an M3U fallback);
  - folders of video files on the server.
- Lists are merged and deduplicated across sources. Duplicates become backup sources.
- Automatic refresh.
- Episodes are grouped into shows and seasons by name patterns, tags or folder structure.
- Languages are detected from tags, group names, country codes and name prefixes such as `EN|`, `[FR]` or `(DE)`. The admin sets the defaults; each profile can choose any combination.
- XMLTV guides (gzip supported), matched by ID and name.
- Grid guide, now/next, catch-up/timeshift, reminders, and guide search.
- Optional TMDB key (free, from themoviedb.org) for:
  - posters, plots, cast, genres and certificates;
  - similar-title recommendations.

**Discovery**
- Home screen with continue watching, picks for you, "Because you watched …", genre rows, trending in the household, new arrivals and mood chips.
- Every row can be hidden, pinned or reordered.
- Recommendations:
  - blend everything the profile has watched or rated, plus TMDB's related titles and what the household watches;
  - mixed for variety, and titles the profile keeps scrolling past are pushed down;
  - saved per profile on disk and refreshed in the background.
- Fast, typo-tolerant search across titles, channels, categories and the TV guide. Voice search where the browser supports it.

**Playback**
- Resume anywhere; progress syncs between devices in real time.
- Speed 0.25–3×, frame step, 10 s / 60 s skips, seek-bar thumbnails, picture-in-picture and fullscreen.
- Subtitles: built into the stream, or read from the file and converted to WebVTT. Size, colour, background and position can be changed.
- Audio track selection (switches tracks during conversion if needed).
- Quality choice and automatic bitrate adaptation.
- **Skip intro / skip credits:**
  - found automatically by comparing the audio of episodes in the same season;
  - also uses chapter names;
  - can be marked by hand, for one episode or the whole season.
- Autoplay next episode with a countdown.
- Bookmarks with notes, and a mini player while browsing.
- Live TV:
  - channel numbers, zapping with ↑/↓ or channel buttons;
  - previous channel, a channel list side panel and an info card.
- Media keys and lock-screen controls (Media Session). The screen stays on while playing.

**Social**
- Messages between profiles, with titles, reactions and an unread badge.
- Notifications appear immediately (server-sent events).
- Share a title, or recommend it to several people at once.
- Shared watchlists that several profiles can edit.
- **Watch parties:**
  - play, pause and seek stay in sync, and drift is corrected;
  - chat, emoji reactions, invites, and host hand-over.
- "Watching now" presence.

**Devices**
- Responsive layouts for phone, tablet and desktop.
- **TV mode** for smart-TV browsers: big focus rings, arrow-key navigation and remote Back/media keys. It turns on automatically and can be toggled.
- **Play on another device:** send what you're watching to any signed-in screen, or take it over from one.
- **Casting:** Chromecast (Chrome), AirPlay (Safari) and the Remote Playback API.
- Installable as an app (PWA).
- **Offline downloads** in the browser (converted to MP4 when needed), with a queue, storage use and auto-delete when watched. There is also a plain "Save file" download.
- Accessibility:
  - keyboard everywhere, labelled controls and visible focus;
  - reduced motion and high-contrast themes;
  - adjustable text size and subtitle styling.

**Look**
- 25 themes with previews, including OLED black, high contrast and light themes.
- Accent colour, text size and reduced motion.

**Admin**
- Admin tabs:
  - overview (counts, who's watching, running conversions, server status);
  - lists, guides and profiles;
  - languages & content (defaults, hidden categories, ratings);
  - playback (routing, transcoding, hardware acceleration);
  - recommendations/TMDB, brand and security.
- Export the merged list and guide for other apps such as VLC, TiviMate or Kodi, using a secret link.
- One-click backup and restore of all settings and profiles.

### Player keys

| Key | Action |
|---|---|
| Space / K | Play / pause |
| ← / → | Back / forward 10 s (Shift: 60 s) |
| J / L | Back / forward 10 s |
| ↑ / ↓ | Volume (live TV: change channel) |
| , / . | Frame step |
| < / > | Speed |
| F, M, P | Fullscreen, mute, picture-in-picture |
| C / A | Subtitles / next audio track |
| S | Skip intro or credits |
| N | Next episode |
| B | Bookmark here |
| I | Stats (live TV: what's on) |
| X / G | Previous channel / guide (live TV) |
| / | Search (outside the player) |
| Esc / Back | Close |

---

## Security

- The site password and PINs are hashed (scrypt). Sessions are http-only cookies, and sign-in attempts are rate-limited.
- Every API request needs a custom header, so other websites can't act on your behalf (CSRF).
- **Until you change the default password**, the server only answers on localhost, private IP addresses and `.local` names, plus any names in `ALLOWED_HOSTS`. Once you change it, any host name works.
- Streams are relayed through signed, expiring links only.
- **For use outside your home network**, put it behind https. Casting, installing as an app and in-browser downloads also need https (or localhost):
  - **Tailscale**: easiest; private, no open ports. `tailscale serve --bg 8080` gives you an https name.
  - **Caddy**: `tv.example.com { reverse_proxy 127.0.0.1:8080 }`, then set `TRUST_PROXY=1`.
  - **Built in**: set `HTTPS_CERT` and `HTTPS_KEY`.

## Data

Everything lives in `DATA_DIR`:
- `accounts.json`
- `settings.json`
- `lists/`
- `epg/`
- `users/<profile>.json`, with saved recommendations in `users/<profile>.recs.json`
- `markers.json`
- `cache/`

Files are written atomically, with a `.bak` copy. Back up the folder, or use Admin → Other apps & backup.

## Limits

- Conversion uses CPU. A small machine can handle a few transcodes at once; repackaging costs very little. **Admin → Playback** sets the maximum number of transcodes.
- DRM: ClearKey works, and so does Widevine/PlayReady where the browser supports it and the playlist provides a licence URL. Nothing is decrypted on the server.
- Casting to Chromecast sends the stream through your server, so the server must be reachable from the Chromecast.
- Intro detection needs at least two episodes of a season and reads their first and last minutes in the background.

## Development

```bash
DEV=1 node server.js        # rebuilds the front-end bundle on every request
node test/langs.test.js     # language detection tests
node test/reach.test.js     # direct-playback (CORS) checks
node test/intro.test.js     # intro detection tests (needs ffmpeg)
```

The front end is plain JavaScript and CSS in `web/` (no build step), joined in the order given by `web/order.json`. It is written without optional chaining (`?.`) or `??` so that older TV browsers can run it.

## Licence

MIT. Bundled players: hls.js (Apache-2.0), mpegts.js (Apache-2.0) and Shaka Player (Apache-2.0); see `public/vendor/`.
