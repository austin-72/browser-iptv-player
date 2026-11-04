# Subtitles, rows from lists, the wishlist, your viewing, the viewing dashboard, speed test, error reports and automations

[← Back to the README](../README.md)

## Subtitles found online

When a film or episode has no subtitles in your language, the player can find some online: **subtitles button → Find subtitles…**. Every source is searched at once and the results are listed together, best first: your first language; then subtitles already saved here and the free sources; real translations before machine ones; single episodes before whole-season packs; then the most downloaded. Each result says where it's from. Pick one and it shows straight away.

| Source | Cost | Covers | Setup |
| --- | --- | --- | --- |
| **SubDL** (main) | Free: 2,000 searches a day, downloads not counted | Films and series | A free API key from subdl.com (your account → API key) |
| **Addic7ed** (through Gestdown) | Free | TV episodes only; often first after an episode airs | Nothing — on by default |
| **OpenSubtitles.com** (backup) | 5 downloads a day on a free key, shared by everyone here; more only with VIP | The biggest library | A free API key (your profile → API consumers) |

Each subtitle is downloaded once, converted to WebVTT and kept on the server (up to 3,000 files / 300 MB; the least recently used go first), so watching it again — or someone else picking it — costs nothing. Season packs are opened and the right episode picked out. It also works when the server converts a stream part-way through.

- **Fetch automatically:** Settings → *Subtitles found online* → *Fetch subtitles automatically*. When you'd want subtitles and there are none in your language, the free sources are tried about 15 seconds in. OpenSubtitles is only tried if they have nothing **and** you've watched for 3 minutes (so channel-surfing doesn't use up its downloads), and never when it would leave fewer than 2 of today's downloads for choosing by hand.
- In **Find subtitles**, OpenSubtitles results say they use one of today's downloads, and how many are left.
- **Setup (admin):** Admin → **Integrations** → *Subtitles found online*: the SubDL key, the Addic7ed switch, and *Test all sources*. OpenSubtitles is the section below it; an account there only helps with a VIP subscription.
- When OpenSubtitles' downloads are used up, the message says so; the other sources keep working.

## Home rows from TMDB lists

**Home → Add a row from a list** (at the bottom of Home, and in *Customise this page*) puts a list on your home page. Paste a link to:

- a **TMDB list** (`themoviedb.org/list/…`): lists people share, such as Oscar winners or a director's films;
- a **collection** (`themoviedb.org/collection/…`): every film of a series, in order;
- a **keyword** (`themoviedb.org/keyword/…`, films, or `/tv` for series): "christmas", "time travel"…

What's trending and popular worldwide is in Movies and Series (and a Home row) with smarter categories on: Admin → Categories.

A row shows only the titles your providers have, matched by TMDB (or IMDb) id first, then by title and year, and says how many: *12 of 250 here*. **See the whole list** (the row's title, or its ⋯ menu) shows every entry in the list's order, with *Here* / *Not here* filters; anything that isn't here can go on your wishlist with one click. The ⋯ menu also has *Move to the top*, *Rename*, *Hide this row* and *Remove this row*, and the rows appear in *Customise this page* with the others.

Each list is fetched once for the whole household, kept on the server and checked again about once a day (or with *Check again*). No stream is ever opened for this.

**Setup (admin):** these need a TMDB key (Admin → Recommendations); without one the dialog says they aren't available. (Trakt lists aren't supported any more: rows made from them before are no longer shown.)

## Wishlist and alerts

**Wishlist** (profile menu): search TMDB for any film or series — including ones your providers don't have — and add it. Titles can also be added from a list row's *See the whole list*. If it's already here you're taken to it instead.

You get an **alert** when:

- something on your wishlist arrives (checked whenever the lists refresh, and when TMDB has matched more titles);
- a new episode arrives for a series you're watching (in progress or watched in the last four months), that's in My List, or that you follow with the **bell** on its page. The bell can also turn alerts off for one series.

Alerts show as a message on screen (and a system notification when allowed and the app is in the background). If no device is open they wait: Messages → **New for you** keeps them, the messages button counts them, and the next time the app opens it says what came. There's one alert per title: several new episodes of one series become "3 new episodes of X", and several wishlist titles arriving together become one notification. Arrivals are found by comparing sets of ids, not copies of the catalogue. **Settings → Notifications** turns new-episode alerts and wishlist alerts off separately.

## Your viewing and the year in review

**Your viewing** (profile menu, or Settings → Privacy) shows a week, month or year at a time, with arrows for earlier ones:

- time watched, films finished, days you watched and your longest streak, compared with the period before;
- time each day (or month), and the split between live TV, films and series;
- top series, films, channels and genres;
- when you watch: the day of the week and hour you watch most.

**Your year in review** opens in December for the current year, and any time for earlier years: a few big cards with your hours, series and films of the year, your channel, genres and rhythm (busiest month, favourite day and time, longest streak).

It's counted from what each profile plays here — paused history isn't counted — and kept small: per profile and day, seconds by type and the day's top titles (the detail is dropped after 45 days, the totals kept for about two years). The first time a profile opens it, its existing watch history fills in what came before. The admin can switch to **Household** to see each profile's totals (time and type only, not titles).

## Watching now (Admin → Overview)

The *Watching now* box updates by itself every few seconds. For each device that's playing it shows:

- who is watching what, on which device and from which list;
- how it plays: direct, converted in the browser, through the server, converted on the server, or your own file;
- the picture size, the stream's bitrate and the connection's measured speed;
- how much is buffered ahead;
- pauses to load and dropped frames over the last few minutes;
- an overall *Smooth* / *Some trouble* / *Struggling*.

Below that it shows how many provider connections each list is using out of how many it allows. Devices report every 10 seconds while playing, and the server keeps only the last five minutes in memory.

## Test my connection

**Settings → Connection → Test my connection** (also in Admin → Overview) measures this device's delay, download and upload speed to the server, then the speed from your provider. It reads straight from the provider when the provider lets web pages do that; otherwise the server measures it and says so. A provider whose connections are all in use isn't tested, so nobody gets cut off.

The result is in plain words, for example *Good for HD (1080p); may struggle with 4K*, and it says which part is slow: your network, the distance to the server, or the provider.

## Error reports (Admin → Error reports)

Problems are reported to the server automatically, from every device, so they can be fixed without anyone having to describe them:

| Kind | When |
| --- | --- |
| Error / unhandled promise error / logged error | A bug in the app's code |
| Error shown to the viewer | A failure the viewer saw as a red message (not the server just saying no, and not being offline) |
| Playback failed | Every way of playing a title failed (direct, through the server, converted, backups) |
| Page froze | Nothing ran for over 8 seconds while the page was on screen |
| File didn't load | A script or style sheet didn't load |
| App didn't start | The app hadn't started 30 seconds after opening, e.g. a TV browser too old to read it |
| Server error | A server request failed unexpectedly, or an exception nothing caught |
| Reported by a viewer | Someone used **Report a problem** (below) |

Each report has:

- **The error:** the message and stack, mapped from the bundled `/app.js` back to `web/js/<file>:<line>`, with that line of code. Server errors point at `server.js` / `lib/…`.
- **The device:** name, browser, screen and window size, TV or touch, network, memory, how long the page had been open, and the profile.
- **The player:** what was playing, the way it was playing, position, buffer, picture size and the player's state. For *Playback failed*, every way it tried, how long each took and what each one said (HLS/MPEG-TS/media error codes and HTTP statuses).
- **What happened before:** the last 50 pages, clicks, remote/arrow keys, server calls (path, status, time), player events, messages shown and console warnings.

Reports are grouped: the same problem from many devices is one issue with a count, a device list and, for playback, the titles affected. The newest 5 full reports of each are kept, and at most 300 issues. A new issue is also written to the server log. **Copy report** gives the whole issue as text; *Download* gives all open ones. The same text is kept in `error-reports.txt` in the data folder. **Mark fixed** hides an issue until it happens again on a newer version of the app.

**Report a problem.** Viewers can report something themselves: player menu → *Report a problem*, or the button on the *Can't play this right now* message. They pick what's wrong (*Won't play*, *Stutters or buffers*, *No sound*, *Sound out of sync*, *Wrong subtitles*, *Wrong title or picture*, *Other*), can add a note, and get a thank-you. Anything in the note that looks like a PIN, code or password ("my PIN is 4321", "password: …") is replaced with "…" on the device and again on the server. The report has the same device, player and *what happened before* details as the automatic ones, every way it tried to play when the title failed, and for sound or subtitle problems the sound settings (volume, boost, audio sync, clear dialogue, night mode) or subtitle choice. Each one is its own issue with the viewer's choice and note shown at the top, in the list and in the text report (`Viewer chose:` / `Viewer’s note:`). They're never dropped as a repeat of something reported a moment ago, and are kept even with automatic collecting switched off; to stop floods, a device sends at most 5 in 10 minutes and the server takes at most 12 an hour from one device and profile.

**Never included:** passwords, PINs (not even which digits were pressed), what's typed into fields (except a *Report a problem* note, with anything like a PIN or password in it taken out), or the logins and tokens in stream addresses. Those are removed on the device and again on the server. Turn reporting off with the switch at the top of the page.

## API and automations (Home Assistant)

**Admin → API & automations.**

**API keys.** Make a key, named and limited to one of three scopes:

- **read:** what's playing, devices, search, channels;
- **control:** also play, pause, stop, channel up/down, volume;
- **admin:** also list refreshes.

A key can also be limited to one profile's devices and titles. It's shown once and stored only as a hash. Send it as `Authorization: Bearer <key>` to `http://<server>/api/v1`:

| | |
|---|---|
| `GET /api/v1/now` | What each device is playing |
| `GET /api/v1/devices` | Signed-in devices (their `id` is used below) |
| `POST /api/v1/devices/{id}/play` | `{"k": "…"}`, `{"channel": 101}` or `{"title": "…"}` |
| `POST /api/v1/devices/{id}/command` | `{"cmd": "pause"}` · `"resume"` · `"toggle"` · `"stop"` · `"zap"` + `"dir": 1/-1` · `"channel"` + `"n"` · `"volume"` + `"v": 0–1` · `"mute"` · `"seek"` + `"pos"` · `"sleep"` + `"min"` |
| `GET /api/v1/search?q=…` | Titles and channels |
| `GET /api/v1/channels` | Every channel with its number |
| `GET /api/v1/items/{k}` | One title |
| `GET /api/v1/status` | Lists and provider accounts (admin keys) |
| `POST /api/v1/lists/{id}/refresh` | Refresh a list (admin keys) |

**Webhooks.** The server POSTs a JSON message `{ "event", "at", "data" }` to your address when:

- playback starts or stops;
- a profile is chosen on a device;
- a reminder is due;
- a provider account runs out soon;
- a list couldn't be refreshed.

Every message carries `X-Signature: sha256=<HMAC-SHA256 of the body with the webhook's secret>`. Failed deliveries are retried after 30 seconds, 2 minutes and 10 minutes. Recent deliveries and *Send a test* are on the same page. A viewer who has turned off "let others see what I'm watching" is sent as `"hidden": true`, with no title.

### Home Assistant example

`configuration.yaml`:

```yaml
rest_command:
  tv_pause:
    url: "http://iptv.local:8080/api/v1/devices/{{ device }}/command"
    method: post
    headers:
      Authorization: !secret iptv_api_key   # "Bearer iptv_…"
    content_type: application/json
    payload: '{"cmd": "pause"}'
  tv_news:
    url: "http://iptv.local:8080/api/v1/devices/{{ device }}/play"
    method: post
    headers:
      Authorization: !secret iptv_api_key
    content_type: application/json
    payload: '{"channel": 1}'

sensor:
  - platform: rest
    name: Living room TV
    resource: http://iptv.local:8080/api/v1/now
    headers:
      Authorization: !secret iptv_api_key
    value_template: "{{ value_json[0].playing.title if value_json else 'Nothing' }}"
    scan_interval: 30
```

To dim the lights when a film starts, add a webhook in Admin with the address `http://homeassistant.local:8123/api/webhook/iptv_playback` and the event *Playback started*, then use this automation:

```yaml
automation:
  - alias: Dim the lights for a film
    trigger:
      - platform: webhook
        webhook_id: iptv_playback
        local_only: true
    condition:
      - "{{ trigger.json.event == 'playback.started' and trigger.json.data.type == 'movie' }}"
    action:
      - service: light.turn_on
        target: { entity_id: light.living_room }
        data: { brightness_pct: 15 }
```

### Environment variables (testing only)

`SUBDL_BASE`, `SUBDL_DL_BASE`, `GESTDOWN_BASE` and `OPENSUBTITLES_BASE` point the integrations at stand-ins (see `test/mock/integrations.js`), and `TMDB_BASE` points TMDB at one (`test/mock/tmdb.js`).
