# Subtitles, rows from lists, the wishlist, your viewing, the viewing dashboard, speed test, error reports and automations

[← Back to the README](../README.md)

## Subtitles found online

When a film or episode has no subtitles in your language, the player can find some online: **subtitles button → Find subtitles…**. Every source is searched at once and the results are listed together, best fit for the video first. Pick one and it shows straight away.

| Source | Cost | Covers | Setup |
| --- | --- | --- | --- |
| **SubDL** (main) | Free: 2,000 searches a day, downloads not counted | Films and series | A free API key from subdl.com (your account → API key) |
| **Addic7ed** (through Gestdown) | Free | TV episodes only; often first after an episode airs | Nothing — on by default |
| **OpenSubtitles.com** (backup) | 5 downloads a day on a free key, shared by everyone here; more only with VIP | The biggest library | A free API key (your profile → API consumers) |

Each subtitle is downloaded once, converted to WebVTT and kept on the server (up to 3,000 files / 300 MB; the least recently used go first), so watching it again — or someone else picking it — costs nothing. It also works when the server converts a stream part-way through.

### What each result says

The sites list subtitles under the name of the copy they were timed for (`Show.S02E05.720p.BluRay.x264-GRP`), with a free-text comment and a few tick-boxes that are often wrong. The list here says what that means, in words:

| It says | Meaning |
| --- | --- |
| **Everything spoken** | Every line of speech. |
| **With sounds described (SDH)** | Every line of speech, plus sounds and who is talking ("[door slams]"). Sites call these SDH, HI or CC. |
| **Foreign-language parts only** | Only the lines in a language other than the film's own, and signs on screen ("forced" subtitles). A handful of lines in the whole film. Never fetched automatically. |
| Blu-ray · Streaming · TV broadcast · DVD · Cinema recording | The kind of copy the timing was made for. |
| 23.976 fps · 25 fps | That copy's speed. A 25 fps file on a 23.976 video drifts further out the longer it plays. |
| Extended cut, Director's cut, Unrated … | A different edit of the film. |
| Same length as this video / *Made for a copy 4 min longer* | The length the uploader gives for their copy, against the video's. |
| Official text · Read by machine from a disc · Retimed | Copied from the disc or service; read from a disc's picture subtitles by a program (the odd typo); someone else's text moved to fit a copy. |
| *Probably not for this video* | Its name is another show's (a spin-off filed under the parent), it is one disc of two, or someone here marked it wrong. Listed last, never fetched automatically. |

Words win over tick-boxes: a file ticked "hearing impaired" whose comment says "removed HI" is listed as *Everything spoken*. Advertising, web addresses and "please rate" are taken out of the comments. The chips above the list show one kind only.

### Wrong episode, wrong timing

Three checks, cheapest first:

1. **The name.** A result named for another episode or season is left out, as is one OpenSubtitles files under another episode, and a film's result that names another film and year. From a whole-season zip, the episode's own file is picked by its name (`S02E05`, `2x05`, `Episode 5`, `05 Title.srt`, or the episode's title); a zip in which no file can be told to be the episode is refused rather than guessed at.
2. **The length.** A fetched file whose lines run on after the video has ended, stop before half of it, or number only a few, isn't used automatically. Picked by hand it is shown, with a note saying so.
3. **The sound.** The server reads three minutes of the title's sound in two places (sound only, at telephone quality; nothing is converted and playback doesn't change), marks where it sounds like talking, and slides the file's lines along until they fit. That gives one of:
   - *in time*, or *off by a fixed amount* (a recap, a different opening): the file is moved;
   - *another speed* (made for a 25 fps copy, or 24 against 23.976): the file is re-timed;
   - *fits nowhere*: automatic fetching tries the next result. If every result fits nowhere, the first is used after all and said to be unsure;
   - *can't tell* (loud music all through, hardly any talk): nothing is changed.

   The correction is kept for that title, for every profile and device, and the file itself stays as it came. It claims an answer only when both places agree and the fit stands well clear of every other; it has been tried on made-up sound with known answers, not on a library of real films, so treat it as a helper.

**When the server listens** — Admin → Integrations → *Checking them against the sound*:

| Setting | Listens |
| --- | --- |
| *When it costs no provider connection, or one is known to be free* (as it comes) | For files in your own folders and films the stream relay already holds; from a provider only when its connection limit is known and one is spare. An account that allows one connection is never read while someone watches. |
| *Whenever the provider isn't known to be full* | Also when the limit isn't known. |
| *Never* | Not at all. |

While it reads from a provider it shows among that provider's connections as *Checking subtitles*, for about a minute.

**In the player**, while fetched subtitles are showing: **Wrong subtitles? → Try others** marks that file wrong for the title (nobody here is given it again unless they pick it by hand) and fetches the next best; **Subtitle timing → Fix by listening** asks for the check by hand; and the manual steps now go up to 5 s.

- **Fetch automatically:** Settings → *Subtitles found online* → *Fetch subtitles automatically*. When you'd want subtitles and there are none in your language, the free sources are tried about 15 seconds in. OpenSubtitles is only tried if they have nothing **and** you've watched for 3 minutes (so channel-surfing doesn't use up its downloads), and never when it would leave fewer than 2 of today's downloads for choosing by hand.
- In **Find subtitles**, OpenSubtitles results say they use one of today's downloads, and how many are left.
- **Setup (admin):** Admin → **Integrations** → *Subtitles found online*: the SubDL key, the Addic7ed switch, and *Test all sources*. OpenSubtitles is the section below it; an account there only helps with a VIP subscription.
- When OpenSubtitles' downloads are used up, the message says so; the other sources keep working.

## Subtitles made from the sound

When nothing is found online, the server can listen to a film or episode and write subtitles in the language spoken: **Find subtitles → Make subtitles from the sound**. A note arrives when they're ready, and from then on they're in that title's Subtitles menu for everyone (marked *made here*).

It is optional and off unless the server has a speech-to-text program. Nothing is bundled and no npm package is used:

| | |
|---|---|
| `WHISPER_BIN` | The program. Default: `whisper-cli` (whisper.cpp), then `whisper` (OpenAI's, or `whisper-ctranslate2`), looked for on the `PATH`. |
| `WHISPER_MODEL` | whisper.cpp: the path of a model file such as `ggml-base.bin` (required). The Python command line: a model name (`base` unless set). |

Admin → **Integrations** → *Subtitles made from the sound* shows what was found (or why not) and who may ask: everyone, only the admin, or nobody.

- **It never changes how anything plays.** It is a background job of its own: ffmpeg reads the title once and keeps only its sound, the program writes a WebVTT file into `gen-subs` in the data folder, and the sound file is deleted.
- While the sound is read from a provider, the job uses one of that provider's connections. It is listed with the people watching as *Making subtitles*, waits for a free connection instead of taking one, and reads the whole file once.
- One title at a time; up to five wait in a queue. It runs at low priority, and it is slow work: expect a good part of the running time on a small server, depending on the model.
- Machine-made: names and fast speech come out wrong, and the timing is by the sentence.
- **Docker:** the image doesn't include a speech-to-text program. Add one in an image of your own on top of it (the base is Alpine, so whisper.cpp has to be built for Alpine), put a model file in the data folder, and set the two variables. This path hasn't been tried on a real install; the feature was tested with a stand-in for the program that takes whisper.cpp's options.

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
