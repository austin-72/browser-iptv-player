# The stream relay: direct streams without showing your address

[← Back to the README](../README.md)

Normally, when a stream can play straight from the provider, each viewer's device fetches it from the provider itself. That keeps the load off your server, but the provider sees every viewer's internet address.

The **stream relay** is a small program you run on an internet machine of your own, such as a cheap VPS. Viewers' devices fetch their streams from the relay, and the relay fetches them from the provider:

```
viewer's device  ──►  stream relay (your VPS)  ──►  provider
       ▲
       └── this server only hands out the addresses; no video passes through it
```

- **The provider only sees the relay's address**, never your home's or your viewers'.
- **Your home server still carries no video**, and your home upload isn't used.
- **It works in every browser, phone and TV**, with nothing to set up on them.
- **Streams that need special headers** (User-Agent, Referer, cookies), which browsers can't send, play directly through the relay, because the relay sends the headers itself.
- **Providers that block web players** are no problem, because the relay gives browsers permission to read the stream (CORS).
- **Plain-http streams play on an https page**, as long as the relay has an https address.
- **Devices never see the provider's address or your login.** The addresses the relay accepts are encrypted with a secret that only this server and the relay know, and they expire after 12 hours.

## What you need

1. **A small Linux machine on the internet** with Docker, from any provider. The cheapest plan is enough for the relay's CPU and memory. **Bandwidth** is what matters: everything your household watches directly passes through it, at about 1–3 GB per hour of HD and 7+ GB per hour of 4K. Pick a plan with plenty of included traffic.
2. **A name for it**, so it can have https: your own domain pointing at the machine, or a free name from [duckdns.org](https://www.duckdns.org) such as `myrelay.duckdns.org`.
3. **Ports 80 and 443 open** on the machine (for https), plus 8888 if you want it as your server's proxy too (see below).

> Free "serverless" services such as Cloudflare Workers aren't a good fit: their terms don't allow relaying video at this scale.

## Setting it up (about 10 minutes)

1. **On this server:** Admin → Network & proxies → **Stream relay**. Enter the relay's future address, for example `https://myrelay.duckdns.org`, and press **Save**. A secret is made. Press **Copy the secret**.
2. **On the relay machine:** copy the `relay` folder from this project there (`relay.js`, `docker-compose.yml`, `Caddyfile`, `.env.example`). Then:
   ```sh
   cd relay
   cp .env.example .env
   nano .env          # RELAY_DOMAIN=myrelay.duckdns.org  and  RELAY_SECRET=<the secret you copied>
   docker compose up -d
   ```
   Caddy gets an https certificate for the name by itself within a minute.
3. **Back on this server:** press **Test**. It should say *The relay works*.

Every list now sends its direct streams through the relay. To choose per list, untick **Use it for every list**, then set **Viewers' direct streams** in each list's settings (Admin → Lists → Edit). You can also set the other way round: on for every list except some.

Without Docker, it's one file and needs Node.js 18 or later:

```sh
RELAY_SECRET=<the secret> PORT=8090 node relay.js
```

You then need to put https in front of it yourself (Caddy, nginx, a tunnel). A plain-http relay only works while the app is opened on a plain-http address.

## Your server's own traffic through the same machine (optional)

Some things still go from this server to the provider:
- list refreshes, account checks and TV guides
- streams a browser can't play as they are (MKV films with AC-3 sound, for example), which this server converts
- TMDB, subtitles and the other services

To hide your home address from those too, let the relay be this server's proxy:

1. In the relay's `.env`, set `PROXY_PORT=8888`, `PROXY_USER=…` and `PROXY_PASS=…` (a long password), then `docker compose up -d` again. Open port 8888 on the machine.
2. Here: Admin → Network & proxies → **Proxies** → *Add a proxy* → `http://USER:PASSWORD@myrelay.duckdns.org:8888`. Choose it as **Default for everything**, then **Test** and **Save**.

## What goes where

| | Without the relay | With the relay |
| --- | --- | --- |
| Streams a browser can play as they are (most live channels, MP4 films) | Device ↔ provider | Device ↔ relay ↔ provider |
| Streams that need converting (some MKV/AC-3 films, MPEG-2) | Device ↔ this server ↔ provider (through this server's proxy, if set) | the same |
| "Open in another app" (VLC, Infuse…) | Device ↔ provider | Device ↔ relay ↔ provider |
| Downloads | Device ↔ provider, or through this server | Through this server (and its proxy) |
| Lists, guides, account checks, TMDB, subtitles | This server ↔ provider (through its proxy, if set) | the same |
| Posters and channel logos | Device ↔ provider / TMDB | the same |

## Good to know

- **Connection limits are unchanged.** A stream through the relay is still one connection to the provider, and busy-provider and priority rules work as before.
- **The relay only fetches public internet addresses.** It refuses its own network, so it can't be used to reach anything else on the VPS's network. Set `RELAY_ALLOW_PRIVATE=1` only if a provider is on the same private network as the relay.
- **Make a new secret** (Admin → Network & proxies) if you think it has leaked, then put the new one in the relay's `.env` and restart it.
- **Checking the relay:** `docker compose logs relay` on the relay machine shows it starting. Admin → Network & proxies → Test shows how many streams are playing through it.
