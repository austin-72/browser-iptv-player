# Subtitles, Trakt, the viewing dashboard, speed test and automations

[← Back to the README](../README.md)

## Subtitles from OpenSubtitles

When a film or episode has no subtitles in your language, the player can find some on OpenSubtitles.com: **subtitles button → Find subtitles…**. Results are in your languages, best first: your first language, real translations before machine ones, then the most downloaded. Pick one and it shows straight away.

Each subtitle is downloaded once, converted to WebVTT and kept on the server (the oldest are dropped past 60 MB). It also works when the server converts a stream part-way through.

- **Fetch automatically:** Settings → *Subtitles from OpenSubtitles* → *Fetch subtitles automatically*. When you'd want subtitles and there are none in your language, the best match is fetched after a few seconds.
- **Setup (admin):** Admin → **Integrations**. Enter a free API key from opensubtitles.com (your profile → API consumers). An OpenSubtitles account is optional and gives more downloads a day.
- When the day's downloads are used up, the message says so and when more become available.

## Trakt

Each profile can connect its own [Trakt](https://trakt.tv) account in **Settings → Trakt**. The screen shows a short code to type at trakt.tv/activate, so it works on a TV too. Once connected:

- **Log what I watch:** films and episodes go into your Trakt history as you watch them (start, pause, stop and how far you got). They're matched by TMDB id when known, otherwise by a Trakt search on title and year.
- **Watchlist ↔ My List:** kept the same both ways every few hours, or with *Sync now*. Something removed on one side since the last sync is removed on the other.
- **Thumbs ↔ ratings:** thumbs up is 8/10 and thumbs down is 3/10. A Trakt rating of 7 or more is a thumbs up here, and 4 or less is a thumbs down.
- **Copy Trakt history here** marks what you've watched elsewhere as watched. **Copy my history to Trakt** sends the other way.

Tokens stay on the server and are refreshed before they run out. **Setup (admin):** create an app at trakt.tv → Settings → Your API Apps with the redirect URI `urn:ietf:wg:oauth:2.0:oob`, then paste its Client ID and Secret into Admin → **Integrations**.

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

`OPENSUBTITLES_BASE` and `TRAKT_BASE` point the integrations at stand-ins (see `test/mock/integrations.js`).
