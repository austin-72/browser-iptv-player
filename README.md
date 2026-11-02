# Browser IPTV Player

**Your IPTV playlists, turned into a Netflix-style app for the whole household. It runs in any web browser: computer, phone, tablet or smart TV.**

You run one small server at home and add your playlists or provider accounts once. Everyone in the house opens the site, picks their profile and watches live TV, films and series. Nothing needs installing on any device.

![The home screen: a big "picked for you" title, mood buttons and a Continue watching row](docs/screenshots/home.jpg)

<p align="center">
  <a href="#why-this-one">Why this one?</a> ·
  <a href="#a-quick-tour">Tour</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#how-playback-works">How playback works</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#security">Security</a> ·
  <a href="#faq">FAQ</a>
</p>

> **Bring your own content.** This is a player. It doesn't come with any channels, films or accounts; you add playlists or provider logins that you're entitled to use. Every title, channel, poster and person in these screenshots is made up (the demo artwork was generated for this page).

---

## Why this one?

Most IPTV players are an app you install and set up again on every device. Media servers such as Jellyfin and Plex are built around your own files, with IPTV added on the side. This project is built for a household sharing one or more IPTV subscriptions:

- **Nothing to install on any device.** Any modern browser works, including smart-TV browsers (2015 TVs onward) and phones. You can install it as an app from the browser if you like, and sign a TV in by scanning a code with your phone.
- **Set it up once for everyone.** The admin adds the playlists (M3U links or files, Xtream Codes accounts, MAC portals, Jellyfin/Emby/Plex libraries, folders of your own videos) and the TV guides. Each person just picks their profile.
- **Films and series that look like a streaming service.** Posters, plots, cast, seasons and episodes, Continue watching, My List, recommendations and "Because you watched…". The full Xtream Codes film and series catalogue is browsable, not just live channels.
- **Several providers merged into one tidy catalogue.** Duplicates are combined, and the extra copies become automatic backups. Provider junk like `|EN| ★ Title (2023) [MULTI-SUB] 4K` is cleaned up to "Title (2023)", and a series spread across two providers gets every season from both.
- **Video goes straight from the provider to the viewer whenever possible.** Your server doesn't carry the stream, so a small box can serve a whole house. When a browser can't play a stream as it is, the server (or the browser itself) converts it automatically.
- **It knows your provider's connection limit.** It shows who's using each connection, picks a copy on a provider with a free one, lets you take a connection over, and gives **priority profiles** first claim when there aren't enough to go round.
- **Made for households.** Profiles with optional PINs and age limits, Kids profiles, parental locks, messages between profiles, watch parties that share one provider connection, multiview, and a phone that works as a remote for the TV.
- **Works with the apps you already have.** Each profile can get an Xtream Codes login for TiviMate or IPTV Smarters, and Plex, Jellyfin and Emby can add it as a TV tuner, all using the same cleaned-up, merged catalogue.
- **Free and open source** (MIT). It needs no npm packages; you only need Node.js, plus ffmpeg for the conversion features.

### How it compares

|  | **Browser IPTV Player** | IPTV apps (e.g. TiviMate, IPTV Smarters) | Media servers (e.g. Jellyfin, Plex) |
|---|---|---|---|
| Install on each device | No, any browser | Yes, one app per device (TiviMate is Android-only) | Server plus apps (Jellyfin and Plex also have web players) |
| Add playlists once for the whole household | ✅ | ❌ (set up per device) | ✅ |
| Xtream films and series as a browsable library | ✅ | ✅ | Jellyfin: via plugins · Plex: no M3U/Xtream support built in |
| Several providers merged, duplicates removed, backups | ✅ | Separate playlists | Live channels only |
| Video straight from provider to viewer | ✅ when possible | ✅ | ❌ (usually through the server) |
| Knows provider connection limits, takeover, priority | ✅ | ❌ | ❌ |
| Profiles, PINs, kids limits | ✅ | Varies | ✅ |
| Multiview (several channels at once) | ✅ up to 9 | TiviMate Premium | ❌ |
| Watch parties, messages, phone remote | ✅ | ❌ | Jellyfin: SyncPlay watch parties |
| Use it from other apps (Xtream login, HDHomeRun tuner) | ✅ | — | — |
| Recording (DVR) | ❌ not yet | TiviMate Premium, IPTV Smarters | ✅ |
| Price | Free, open source | TiviMate: paid Premium for multiple playlists, catch-up and recording | Jellyfin free · Plex: free tier and paid Plex Pass; its Live TV is built around antenna tuners |

<sub>Based on each project's own documentation as of late 2026. Other apps change, so check theirs if a feature matters to you.</sub>

---

## A quick tour

<table>
<tr>
<td width="50%"><img src="docs/screenshots/profiles.jpg" alt="Who's watching? Five profiles with cartoon pictures"><br><b>Who's watching?</b> One sign-in for the house, a profile each. PINs are optional.</td>
<td width="50%"><img src="docs/screenshots/title.jpg" alt="A film page with backdrop, rating, cast and similar titles"><br><b>Every title has a proper page,</b> with plot, cast, rating, trailer and "More like this".</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/series.jpg" alt="A series page with episode list and seasons"><br><b>Series</b> have seasons and episodes, with progress and "Also watched by".</td>
<td width="50%"><img src="docs/screenshots/movies.jpg" alt="The Movies page with category, year, rating and length filters"><br><b>Browse and filter</b> by category, genre, decade, rating and length.</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/guide.jpg" alt="A colour-coded TV guide grid with channels and programmes"><br><b>TV guide:</b> a colour-coded grid with now and next, catch-up, reminders and guide search.</td>
<td width="50%"><img src="docs/screenshots/player-live.jpg" alt="A live channel playing with the channel list open beside it"><br><b>Live TV:</b> zap with arrow keys or the channel list, with what's on now.</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/search.jpg" alt="Search results for harbor across titles, episodes and TV"><br><b>One search</b> across titles, episodes, channels and the guide. It's typo-tolerant and also understands people, genres and decades.</td>
<td width="50%"><img src="docs/screenshots/messages.jpg" alt="Messages between profiles with a shared film card"><br><b>Messages</b> between profiles: share a title, react, or start a watch party.</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/multiview.jpg" alt="Four live channels playing at once in a 2 by 2 grid"><br><b>Multiview:</b> up to 9 live channels at once; sound from the one you pick.</td>
<td width="50%"><img src="docs/screenshots/onlater.jpg" alt="On later: upcoming sport grouped by competition, with reminder bells"><br><b>On later:</b> the films and sport coming up in the next two days, with one-tap reminders.</td>
</tr>
</table>

**Phones.** The full app works on a phone. The tab bar has Home, Live TV, Movies, Series and My List, with search and messages at the top. Any phone can also be a **remote** for the TV:

![Four phone screens: home, a series page, the TV remote, and the TV guide](docs/screenshots/phones.jpg)

**TVs.** On a smart-TV browser it switches to a **TV mode** (big focus rings, arrow keys and remote buttons). To sign in, scan a code with your phone; there's no password typing with a remote.

![TV mode home screen and the "Sign in with your phone" code screen](docs/screenshots/tv.jpg)

---

## Quick start

### With Docker (recommended)

```bash
git clone https://github.com/austin-72/browser-iptv-player.git
cd browser-iptv-player
docker compose up -d
```

Open `http://<this computer's IP>:8080`. Everything the app saves is kept in `./data`.

<details>
<summary>Without Compose</summary>

```bash
docker build -t browser-iptv-player .
docker run -d --name iptv -p 8080:8080 -v "$PWD/data:/data" --restart unless-stopped browser-iptv-player
```

The image includes ffmpeg. It runs as an unprivileged user and fixes the owner of `/data` on start-up. Set `PUID`/`PGID` to run as a specific host user instead.
</details>

### Without Docker

```bash
# install Node.js 22 (20 or later works) and ffmpeg, e.g. `sudo apt install ffmpeg`, `brew install ffmpeg`, `winget install ffmpeg`
node server.js            # or: npm start
```

Options can go on the command line (`--port 9000 --data /srv/iptv`) or in environment variables (see [Configuration](#configuration)).

### First run (about 5 minutes)

1. **Sign in** with the default site password **`changeme`** (or whatever you set in `SITE_PASSWORD`).
2. **Create the first profile.** It becomes the admin and must have a PIN.
3. **Open Admin** (the shield icon):
   - **Security:** change the site password.
   - **Lists:** add your playlists or Xtream Codes accounts.
   - **TV guides:** add an XMLTV guide if your lists don't name one.
   - **Languages & content:** pick the default languages, for example English only.
4. **Share the address.** Everyone else signs in with the site password and adds their own profile. You can also set **Admin → Profiles → Only the admin can add profiles**.

Nothing is shown to someone who hasn't signed in: not the brand, the channels or the profiles. They only see a plain sign-in page.

---

## Features

### Watching

![The player showing stream info: playback Direct, 1280×720, straight from the provider](docs/screenshots/stream-info.jpg)

- **Plays almost anything:** HLS, MPEG-TS, MP4, MKV, DASH, ClearKey DRM, and AC-3/E-AC-3 sound, from M3U, Xtream Codes or your own folders. It chooses the most direct way to play each stream (see [How playback works](#how-playback-works)). The *Stream info* panel shows which route is in use.
- **Resume anywhere.** Progress syncs live between devices, and the next episode autoplays with a countdown.
- **Play queue:** *Play next* or *Add to queue* on any film, series or episode; they play one after another with the same countdown. Reorder it in My stuff → Queue or from the player; it's the same on all your devices.
- **Clear dialogue and night mode** in the player's menu: speech lifted above the music and effects, and loud scenes quieter with quiet speech louder. Remembered per profile.
- **Skip intro and skip credits.** Found automatically by comparing episodes, read from chapter names, or marked by hand.
- **Subtitles and audio tracks:** built-in, from the file or from subtitle files next to it (`Film.en.srt`, `.vtt`, `.ass`), with adjustable style. Subtitles can be set to "only when the audio isn't in my language".
- **Picture subtitles** from Blu-ray (PGS), DVD (VobSub) and DVB rips, drawn by the player itself over the picture: the server only copies them out of the file, nothing is burnt in or converted.
- **Subtitle timing:** move any subtitles earlier or later (0.1 s / 0.5 s steps, G / H keys), remembered per title.
- **Captions on live TV:** closed captions inside HLS channels and films, and DVB and teletext subtitles on MPEG-TS channels (played in the browser, or when the server converts them anyway).
- Speed 0.25–3×, frame step, seek-bar thumbnails, picture-in-picture, a mini player while browsing, bookmarks with notes, a sleep timer and *Are you still watching?*.
- **Live TV:** channel numbers, zapping with arrow keys or channel buttons, previous channel, a channel list, catch-up and timeshift.
- **Rewind and pause live TV** from what your device has already loaded (up to 30 minutes, nothing stored on the server), with *Go live* to jump back.
- **Multiview:** up to 9 live channels at once (2 on a phone) in a grid or "one big" layout, with sound from the one you pick. Each tile counts as a provider connection, so busy-provider and priority rules still apply.
- **Audio sync** in either direction: when the sound is early it's held back; when it's late the *picture* is held back. Remembered per channel.
- **Sound only** for live channels (radio-style, far less data), **Open in another app** (VLC, MX Player, Infuse, Outplayer and others, or a .m3u file), **Shuffle** for series, your own **skip lengths** (5–60 s), a bigger **buffer** for unreliable providers, opening on your **last channel**, and reminders that can **switch channel** by themselves.
- **Subtitles found online** when a film or episode has none in your language (on demand or automatically): SubDL and Addic7ed for free, with OpenSubtitles as the backup.
- **Downloads** for offline viewing in the browser (converted to MP4 when needed), or a plain "Save file". **Casting** to Chromecast, AirPlay and the Remote Playback API.

### Finding something to watch

- A home page with Continue watching, Top picks, "Because you watched…", New episodes, trending in the household, On TV now, genre rows and mood buttons ("Something funny", "Edge of my seat"…). Every row can be hidden, pinned or reordered.
- **Recommendations** blend what the profile watches and rates, what's related (from TMDB) and what the household likes. **Surprise me** picks one title, and **Pick for several of us** finds something everyone should like and nobody has seen.
- **Search** is instant and typo-tolerant, with voice search where the browser supports it. It also understands people ("tom hanks"), genres and decades ("90s comedy").
- **On later:** films and sport (by competition) coming up in the next two days, with one-tap reminders, plus an "On later today" row on the home page.
- **Follow teams and competitions** ("Arsenal", "Chiefs", "Premier League", "Formula 1"), picked from what's actually in the guide, with short forms and typos understood ("Man Utd", "Arsnal"). Their games appear in an **Events** row on Home and at the top of On later: live ones first with *Watch*, then what's next, on the best channel you can watch (HD first). Your teams' games get **reminders by themselves**, which can also switch channel. Use *Follow* on any match, or Settings → Teams and competitions.
- **Event and pay-per-view channels** (`PPV 03: UFC 310 (Sat 7 Dec 22:00 ET)`, `EVENT 12 - 2026-11-02 19:45 Arsenal v Chelsea`) get guide listings from their names, so their events show in the guide, search, On later, Events and reminders. Channels with nothing on say "No event right now" and can be hidden from Live TV.
- **Filters** by category, genre, decade, rating and length. A film page also shows its whole collection ("2 of 4 here") with *Watch in order*.
- An optional free [TMDB](https://www.themoviedb.org/) key adds posters, plots, cast, certificates and similar titles. Without one it uses what your provider sends.
- **Rows from lists:** add any public Trakt list (IMDb Top 250 copies, Oscar winners…), your own Trakt lists, Trakt's trending, popular and anticipated, or a TMDB list, collection or keyword as a home row. It shows only what your providers have ("12 of 250 here"), and *See the whole list* shows what's missing.
- **Wishlist:** search for any film or series (with a TMDB key), even ones that aren't here, and get an alert when it arrives.

### Profiles and the household

![Admin → Profiles with a Priority viewer switch on each profile](docs/screenshots/admin-profiles.jpg)

- Unlimited profiles with 142 original profile pictures, or upload a photo. Each device remembers its profile.
- **Optional PINs,** remembered on a device for 6 months or for 30 minutes, with a lockout after wrong guesses.
- **Kids profiles and age limits** (five levels, read from US, UK and EU ratings). Profiles can also be limited by type (live, films, series, radio) and category. Adult content is hidden unless allowed.
- Each profile keeps its own history, My List, favourites, ratings, hidden titles, home layout, theme, subtitle style and languages.
- **Busy providers:** if someone is already using the provider's connection, it says who's watching what and offers *Take over*. Titles on several providers play from the one with a free connection.
- **Priority viewers:** mark profiles as *Priority* in Admin → Profiles. When a provider has no free connection, a priority viewer automatically takes one from someone on a standard profile, and that person's screen says who needed it. Standard profiles can't take a connection from a priority viewer.
- **Together:** messages with titles and reactions, shared watchlists, and **watch parties** that keep play, pause and seek in sync, with chat and emoji reactions. A party **shares one provider connection**: the server fetches the stream once for everyone in it.
- **Your channel lists:** each profile can put its favourites in its own order, make its own lists ("Football", "Kids' channels"), and choose which list Live TV and the guide open on.
- **Parental locks:** lock channels or whole categories behind a PIN. The server enforces it, and Kids profiles can't unlock.
- **Screen time and bedtime:** a daily limit (the same every day, school days and weekends, or each day), the hours watching is allowed and a bedtime, set in Admin → Profiles. The server counts and enforces it (all devices, parties and multiview together); viewers see what's left, get a 5- and 1-minute warning and a friendly *That's all for today* screen. They can *Ask for more time*: the admin gets one pop-up with *Give* / *Not today* on whatever device they're using (or the next time they open the app), and can also give extra time in Admin → Profiles.
- **Trakt:** each profile can connect its Trakt account to log what it watches and keep its watchlist and ratings in step.
- **Alerts** for new episodes of series you watch (or follow with the bell on the series page) and for wishlist arrivals: one per title, grouped when several arrive at once. They wait in Messages → *New for you* when no device is open. Each kind can be turned off.
- **Your viewing:** time watched by week, month and year, by type, top series, films, channels and genres, streaks and when you watch, compared with the period before, plus a **Year in review**. The admin sees household totals.
- **Play on another device:** send what you're watching to any signed-in screen, or use your phone as a remote. The remote has play/pause, seek, volume, subtitles, audio, channels and a sleep timer. You can also choose *Pick things to play here* on a phone so its Play buttons start on the TV.

### Phones, tablets and TVs

- Phone, tablet and desktop layouts. On phones the full app is there: Home, Live TV (with the guide and radio), Movies, Series, My List, search, messages, admin and every filter.
- **TV mode** turns on by itself on smart-TV browsers. Everything works with arrow keys and the remote's OK, Back, Menu/Info and media keys. The app is plain ES5 with fallbacks, so it also runs on older TV browsers.
- **Sign in a TV with your phone:** the TV shows a code and a QR code, and you approve it on a phone that's already signed in.
- **Your remote, your buttons:** Settings → *Remote and keyboard* sets what the coloured buttons, number keys, Menu/Info, media keys and a few spare keyboard keys do (guide, Live TV, last channel, subtitles, sleep timer, multiview, a favourite channel…). A *Press a button* tester shows what any button is called. Each device keeps its own; your profile's default follows you.
- **Quick launcher:** <kbd>Ctrl</kbd>+<kbd>K</kbd> (<kbd>⌘</kbd>+<kbd>K</kbd> on a Mac), a held OK on Search, a remote button, the profile menu or the button on the Search page. Type to jump to any page, admin tab or setting, switch profile, play a channel ("ch 101"), open a title, or do something ("sleep timer 30 min"). Typos are forgiven and recent picks come first.
- Installable as an app (PWA). Media keys and lock-screen controls work, and the screen stays on while playing.

### Look and accessibility

<img src="docs/screenshots/themes.jpg" alt="The Look settings: 25 themes, including dark, OLED black, high contrast and light themes" width="560">

- 25 themes (dark, OLED black, high contrast, light and more), or match the device.
- Keyboard access everywhere, labelled controls and visible focus, reduced motion, adjustable text size and subtitle styling.

### For the admin

![Admin → Channels: the channel editor with search, filters, and an Edit button on each channel](docs/screenshots/admin-channels.jpg)

- **Lists:** M3U/M3U8 links or uploads (gzip, any text encoding), Xtream Codes (live, films and series, with an M3U fallback), and folders of video files on the server. Lists are merged in the order you choose and refresh automatically.
- **Provider accounts:** expiry, connections allowed and in use, with a warning two weeks before an account runs out.
- **How many streams at once?** The pulse button on a list tests the provider's real limit for live TV, series and films (up to 6 each). It finds where the provider refuses another connection or cuts an older one off, and uses that result from then on.
- **More kinds of lists:** MAC portals (Stalker/Ministra), and Jellyfin, Emby or Plex libraries, whose films and series play straight from the media server.
- **Channel editor** (Admin → Channels): rename, renumber, re-logo, recategorise, reorder, hide and lock channels, singly or in bulk; pick a channel's guide by hand and shift guide times; channels with no listings get placeholder blocks. Changes survive list refreshes.
- **Channel health** (Admin → Channel health): every play counts toward each channel's and provider's record (what worked, by which route, and the error when it didn't), so you can see providers' 7-day success rates, the channels failing now and which backups work. Hide a dead channel or play its backup first in one click. An optional night-time checker tests channels one at a time, only when that provider is free, and stops the moment someone presses Play. Channels that keep failing get a small "may be down" mark in Live TV and the guide.
- **Find guides and logos** (Admin → TV guides): suggests guides and logos for channels that have none, from the free iptv-org and epg.pw databases, with how sure each match is. Nothing changes until you accept a match.
- **Your own 24/7 channels** (Admin → My channels) made from a category, genre, collection or titles you pick, with a guide. They play with the normal player, so there's no extra work for the server.
- **Clean-up rules:** category rename, merge and hide rules, language detection from tags and prefixes (`EN|`, `[FR]`, `(DE)`), and fixes for wrong posters ("Wrong poster or details?" on any title fixes it for everyone).
- **Overview and statistics:** a live *Watching now* dashboard (what each device plays, how, bitrate, buffering and dropped frames, connections in use per provider), server conversions, playback routes used, and time watched. **Test my connection** checks each device's speed to the server and the provider.
- **Playback settings:** routing (*direct first*, *always through the server*, *direct only*), transcoding limits, hardware acceleration (VAAPI, QSV, NVENC, VideoToolbox), and HTTP/SOCKS5 proxies per list.
- **Other apps:** an **Xtream Codes login per profile** for TiviMate, IPTV Smarters and other apps, an **HDHomeRun tuner** for Plex, Jellyfin and Emby, and the merged list and guide as M3U/XMLTV links.
- **API & automations:** API keys with scopes, and signed webhooks, for Home Assistant and scripts (what's playing, play on a device, pause, change channel…).
- **Error reports:** when something goes wrong on any device (a bug, a title that won't play, a frozen page, an app that won't start on an old TV), the device tells the server automatically. Each report has the error with the file and line of code, the device and browser, what was playing and how each way of playing it failed, and the last clicks, keys, pages and server calls before it. Admin → **Error reports** groups them, shows how often and on which devices, and has *Copy report* and *Mark fixed*. Viewers can also send their own with **Report a problem** in the player ("Won't play", "No sound"… plus a note), shown with their note on top. Passwords, PINs and stream logins are never included.
- **Backups:** nightly backups (kept in `data/backups`), plus one-click backup and restore of all settings and profiles.
- **Updates without restarts:** with the app folder mounted (see `docker-compose.yml`), new web-app files are picked up and open pages reload. New server files wait until *you* restart; the server never restarts on its own unless you set `SELF_RESTART=1`.

**More detail:** [Watching: player extras, multiview and watch parties](docs/watching.md) · [Channels, the guide, your lists and parental locks](docs/channels-and-guide.md) · [More lists, 24/7 channels and other apps (Xtream login, HDHomeRun)](docs/sources-and-other-apps.md) · [Subtitles, Trakt, rows from lists, wishlist and alerts, your viewing, dashboard, speed test, error reports and automations (Home Assistant)](docs/integrations.md)

---

## How playback works

Web IPTV players often fail because the browser blocks video from another site unless that site allows it (CORS), and many providers don't. This player checks what the browser would be allowed to do, provider by provider, and then uses the most direct route that works:

| Route | When it's used | Server load |
|---|---|---|
| **Direct** | The provider allows web players, or the browser's own player can play it (MP4, and HLS on Safari, Android, TVs and current Chrome/Edge) | None |
| **Direct video, playlist via server** | Only the playlists are blocked; the video still comes straight from the provider | A few KB |
| **Another copy, direct** | This copy can't play directly but another provider's copy of the same title can | None |
| **Converted in the browser** | MKV/TS files, or sound browsers can't play (AC-3, E-AC-3, FLAC), converted inside the page with [Mediabunny](https://mediabunny.dev) | None |
| **Relayed by the server** | Streams that are blocked completely, need special headers, or are http on an https page | Bandwidth only |
| **Converted on the server** | What's left: DTS sound, UDP/RTMP, or a quality you picked. ffmpeg repackages or transcodes it | CPU |

<details>
<summary>The details, for the curious</summary>

Before playing, the server asks the provider exactly what the browser would be told: the same Origin header, every redirect hop, and the playlist and segments checked separately. It remembers the answer per provider, so zapping doesn't open extra connections.

1. **Direct, full controls.** The provider allows web players. hls.js, mpegts.js or Shaka read the stream straight from the provider. If a redirect is what blocks it, the browser is given the final address instead.
2. **Direct, built-in player.** No permission needed: MP4/WebM films play in every browser, and HLS plays on Safari, iPhone/iPad, Android, most smart TVs and current Chrome/Edge.
3. **Direct, HLS copy.** A raw MPEG-TS channel from an Xtream Codes panel is also offered as HLS (`/live/user/pass/123.m3u8`), which the browser's own HLS player tries even when the account doesn't list HLS.
4. **Direct video, playlist via the server.** When only the playlists are blocked, the server passes on the playlist text and the browser fetches the video itself.
5. **Another copy, direct.** The player checks up to three other copies (other providers) for a direct route first, skipping any whose connection someone in the household is using.
6. **Converted in the browser.** MKV and MPEG-TS films and episodes, and files with AC-3, E-AC-3 or FLAC sound, are read straight from the provider and remuxed in the page. The picture is copied (or re-encoded when the browser can't take it) and the sound becomes AAC or Opus. This needs WebCodecs (Chrome, Edge, Safari 16.4+, Firefox 130+) and a provider that lets web pages read its files. Turn it off for a profile with the `noBrowserConvert` preference.
7. **Through the server (relay).** The last resort for streams that are blocked completely, need special headers, or are http on an https page. It still uses one provider connection per viewer, as direct would.
8. **Convert on the server.** For DTS sound, live channels with AC-3 sound, UDP/RTMP, a quality you picked, or a provider that doesn't let web pages read its files.
9. **Backup sources.** When the same channel or title is in several lists, any copy can take over.

**Which copy plays first.** For films and episodes the browser says what it can play by itself (MKV, HEVC, Dolby sound, in-browser conversion), and the server ranks each copy using the codecs the provider reports.

**http streams on an https site.** Browsers refuse plain-http video on an https page unless the viewer allows *insecure content* for the site (Chrome/Edge: the icon left of the address → Site settings → Insecure content → Allow). The player checks for this and then plays such streams directly. *Settings → http streams* shows the state and the steps. You can also set a plain-http *direct address* in Admin → Network & proxies, which devices switch to for http-only providers.

**Direct streams helper.** On desktop Chrome, Edge, Brave or Opera, an optional small browser extension (in `extension/`, download it from Settings → Direct streaming) makes every stream direct. It only adds the permission header to responses for requests made by this site's pages.

**Downloads, casting and audio tracks.** Downloads come straight from the provider when it allows it, either as they are or converted to MP4 in the browser. Casting gives the Chromecast the provider's own address when it can play it. Sound tracks are switched by the browser itself, or by the in-browser conversion.

**Provider accounts that allow one connection.** The server never opens a second connection while someone might be watching. Preview pictures, track reading and intro detection are switched off for those titles; intro detection needs 3 or more connections.

Still needing the server: streams that need headers browsers can't send, an admin's proxy for video, RTMP/RTSP/UDP, DTS sound, subtitles stored inside a file (picture ones are only copied out; the browser draws them), your own media folders, and background work such as preview pictures and intro detection.
</details>

---

## Configuration

Almost everything is set in the **Admin** screen and saved in `data/`. These are the start-up options:

| Environment variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port to listen on (or `"port"` in `defaults.json`, or `--port`) |
| `HOST` | `0.0.0.0` | Address to listen on |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where accounts, lists, caches and history are stored |
| `SITE_PASSWORD` | `changeme` | The site password used the very first time. After that, change it in Admin → Security |
| `ALLOWED_HOSTS` | — | Extra host names to answer to while the default password is still in use (see [Security](#security)) |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy, so the real client IP and https are used |
| `HTTPS_CERT`, `HTTPS_KEY` | — | Paths to a certificate and key, so the server speaks https itself |
| `HWACCEL` | — | `vaapi`, `qsv`, `nvenc` or `videotoolbox` for hardware transcoding. Falls back to software if it fails |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | Render device for VAAPI |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` | Where ffmpeg is installed if it isn't on the PATH |
| `MAX_MEMORY_MB` | 60% of RAM (4–12 GB) | Memory limit for the server; big catalogues and guides need room |
| `SELF_RESTART` | off | Set to `1` to let the server restart itself after an update |

### Branding

**Admin → Brand** sets the site name, logo and accent colour. To ship a build that's already branded, put a `defaults.json` next to `server.js` (see `defaults.example.json`):

```json
{ "brand": { "name": "Our TV", "accent": "#e50914" }, "sitePassword": "something-better" }
```

`defaults.json` only sets starting values. Anything changed in Admin takes priority.

---

## Security

- The site password and PINs are hashed (scrypt). Sessions are http-only cookies, and sign-in attempts are rate-limited.
- Every API request needs a custom header, so other websites can't act on your behalf (CSRF).
- **Until you change the default password,** the server only answers on localhost, private IP addresses and `.local` names, plus any names in `ALLOWED_HOSTS`. Once you change it, any host name works.
- Streams are relayed through signed, expiring links only.
- **To use it outside your home network,** put it behind https. Casting, installing as an app and in-browser downloads also need https (or localhost):
  - **Tailscale:** the easiest, private with no open ports. `tailscale serve --bg 8080` gives you an https name.
  - **Caddy:** `tv.example.com { reverse_proxy 127.0.0.1:8080 }`, then set `TRUST_PROXY=1`.
  - **Built in:** set `HTTPS_CERT` and `HTTPS_KEY`.

## Data

Everything lives in `DATA_DIR`: `accounts.json`, `settings.json`, `lists/`, `epg/`, `users/<profile>.json` (with saved recommendations in `users/<profile>.recs.json`), `markers.json`, `social.json`, `channels.json` (channel edits and locks), `mychannels.json` (24/7 channels), `outputs.json` (Xtream logins and tuner), `integrations.json`, `trakt.json`, `apikeys.json`, `webhooks.json`, `error-reports.json` (with a readable copy, `error-reports.txt`), `screentime.json` (screen time rules, today's minutes and requests for more time), `homelists.json` (home rows from lists), `wishlist.json` (wishlists, followed series and alerts), `viewing/<profile>.json` (daily viewing totals), `follow.json` (teams and competitions each profile follows, and the event-channel setting), `health.json` (channel health counters and settings), `guidefinder.json` and `cache/` (including `cache/homelists/` and `cache/publicdb/`, the public guide and logo lists, refreshed weekly). Secrets in these are stored hashed where they only need checking (passwords, API keys). Files are written atomically, with a `.bak` copy. Back up the folder, or use Admin → Other apps & backup.

## Limits

- Converting on the server uses CPU. A small machine can handle a few transcodes at once; repackaging costs very little. **Admin → Playback** sets the maximum.
- DRM: ClearKey works, and so does Widevine/PlayReady where the browser supports it and the playlist provides a licence URL. Nothing is decrypted on the server.
- Casting to Chromecast falls back to the server's address when the Chromecast can't play the provider's, so the server must be reachable from the Chromecast.
- Intro detection needs at least two episodes of a season.

---

## FAQ

**Does it come with channels?**
No. You add your own M3U playlists, Xtream Codes accounts or video folders.

**What does the server need?**
Very little bandwidth or CPU when streams play directly: any machine that runs Node.js 20 or later or Docker, such as a mini PC or a NAS. Memory depends on the size of your lists: a few GB for very large provider catalogues and TV guides. Server-side conversion needs ffmpeg and some CPU, or a GPU with hardware acceleration.

**Will it use up my provider's connections?**
It's careful with them. It never opens a second connection while someone might be watching, shows who is using each one, and lets you test the real limit (Admin → Lists → pulse button). Priority profiles get first claim.

**Which browsers work?**
Current Chrome, Edge, Firefox and Safari on computers and phones, and smart-TV browsers (Samsung Tizen, LG webOS, Android TV, Fire TV) back to about 2015.

**Can I use it with VLC, Kodi or TiviMate too?**
Yes. Turn on the Xtream Codes login in Admin → Other apps and sign TiviMate or IPTV Smarters in with a profile's login, or add it to Plex, Jellyfin or Emby as an HDHomeRun tuner. There are also plain M3U and XMLTV links for VLC and Kodi. See [using this with other apps](docs/sources-and-other-apps.md).

**Can it record?**
Not yet. You can rewind live TV on your device, use your provider's catch-up, or add it as a tuner to Plex, Jellyfin or Emby and record there.

---

## Keyboard shortcuts

<details>
<summary>Player keys (press <kbd>?</kbd> anywhere to see them in the app)</summary>

| Key | Action |
|---|---|
| Space / K | Play / pause |
| ← / → | Back / forward by your skip length (10 s unless you change it; Shift: 60 s) |
| J / L | Back / forward by your skip length |
| ↑ / ↓ | Volume (live TV: change channel) |
| , / . | Frame step |
| < / > | Speed |
| F, M, P | Fullscreen, mute, picture-in-picture |
| C / A | Subtitles / next audio track |
| G / H | Subtitles 0.1 s earlier / later (live TV: Shift+G, as G opens the guide) |
| S | Skip intro or credits |
| N | Next episode (or the next thing in your queue) |
| B | Bookmark here |
| I | Stats (live TV: what's on) |
| X / G | Previous channel / guide (live TV) |
| / | Search (outside the player) |
| Ctrl+K / ⌘K | Quick launcher: pages, settings, channels, titles and actions |
| ? | Show these keys |
| Menu / Info (remote) | Options for the highlighted poster or channel (My List, hide, download…) |
| Esc / Back | Close |

On a TV remote, hold OK on Search for the quick launcher. The coloured buttons, number keys (outside live TV), Menu/Info and media keys can be given other jobs in Settings → Remote and keyboard.

On phones, double-tap the left or right side of the video to skip back or forward, and swipe up or down on live TV to change channel.
</details>

## Development

```bash
DEV=1 node server.js        # rebuilds the front-end bundle on every request
npm test                    # unit tests (language detection, playback checks, duplicates, guides, connection test…)
python3 test/ui/tvreach.py http://localhost:8080   # checks everything can be reached with a TV remote
```

The front end is plain JavaScript and CSS in `web/`, with no build step. Files are joined in the order given by `web/order.json`, and the code avoids optional chaining (`?.`) and `??` so older TV browsers can run it.

## Licence

MIT. Bundled players: hls.js (Apache-2.0), mpegts.js (Apache-2.0) and Shaka Player (Apache-2.0). In-browser conversion uses Mediabunny and its AC-3 decoder (MPL-2.0). All of them are in `public/vendor/`.
