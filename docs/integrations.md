# Subtitles, Trakt, the viewing dashboard, speed test and automations

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

`SUBDL_BASE`, `SUBDL_DL_BASE`, `GESTDOWN_BASE`, `OPENSUBTITLES_BASE` and `TRAKT_BASE` point the integrations at stand-ins (see `test/mock/integrations.js`).
