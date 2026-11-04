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

## Films and episodes: fetched whole

When someone plays a film or an episode through the relay, the relay fetches **the whole file** from the provider as fast as the provider sends it, onto the relay machine's disk, and plays it from there:

- **Seeking is instant** for every part that's already on the relay. Jumping ahead of the download makes the relay fetch from there first, then fill in the rest.
- **The provider connection is free again** as soon as the whole file is on the relay. This server checks with the relay every 10 seconds, and a finished film stops counting towards the list's connection limit, so someone else can watch live TV on it.
- **Films share the account's connections** (relay 5). An account that allows, say, one connection can still have several people watching films through the relay: this server tells the relay how many connections each account's films may use (the account's limit, less what everyone else is watching from it — live TV, recordings — and always at least one), and the relay switches the connection between the films so that **everyone has at least 10 minutes ready** on the relay. A film that has more than that gives its connection to one that has less; spare connections keep fetching ahead. On this server, the films of one account then count as one connection, so another film from the same account isn't "busy". (The limit comes from the list's connection test, or what the provider says: run the test in Admin → Lists for the best result. With no limit known, every film gets its own connection, as before.)
- **When it can't keep up** — more being watched at once than the provider sends, or someone waiting to start because every connection is busy — the relay says so, and it shows in **Admin → Statistics → Watching at once**, with the time, how many were watching and how many connections they had. That's when the account is too small for what the household watches.
- **The part already watched is deleted** as people watch: the relay keeps at most 10 minutes behind the furthest-back viewer (plus the very start and end of the file, where players read the film's index). Seeking back further simply fetches that part again.
- The relay stops downloading a film when nobody is playing it any more. Live channels and HLS streams are relayed as they come, as before.

The films are kept in `RELAY_CACHE_DIR` (with Docker, a volume called `cache`) and use at most `RELAY_CACHE_GB`, or all the free disk space but 5 GB. A film is kept for **at most twice its length** once nobody is watching it (and never more than 6 hours unused); films nobody is watching are also deleted when room is needed. If a film is bigger than the free space, it's simply relayed as it comes.

## Updating the relay

Admin → Network & proxies → Stream relay → **Test** says when the relay runs an older version than the one that comes with this server, with an **Update the relay** button. This server then sends its `relay.js` to the relay, which swaps it in and restarts within a few seconds. With Docker the relay's folder must be mounted writable (as in `docker-compose.yml`: `./:/relay`). Without Docker, run it under something that restarts it when it exits (systemd, pm2).

A relay set up before version 2 can't update itself: copy the new `relay.js` and `docker-compose.yml` onto it once by hand and run `docker compose up -d`.

## The relay through a proxy (optional)

The relay can reach providers through a proxy instead of connecting itself. Providers then see the proxy's address, not the relay's. This helps when a provider only accepts one address (the same one this server's proxy uses), or blocks data-centre addresses like a VPS's.

Admin → Network & proxies → Stream relay → **How the relay connects to providers**:
- **Directly**: the relay connects itself (the default).
- **Through each list's proxy**: the same proxy this server uses for that list (its own choice in Admin → Lists, or the default). Lists without a proxy are fetched directly.
- **Through** one of your proxies: everything the relay fetches goes through that one.

HTTP, HTTPS and SOCKS5 proxies work, with a username and password. The proxy travels inside the sealed stream address, so devices never see it, and the proxy's address must be on the public internet. Press **Test** after saving: it shows the address providers see from the relay itself and through each proxy. If a proxy shows the relay's own address, the relay is older than version 4 and needs updating (**Update the relay**).

All the video then goes through the proxy too (films fetched whole as well), so check the proxy's data allowance. Residential proxies are often paid per GB.

## The relay through a VPN (optional)

The relay can also send everything it fetches through a VPN, so providers see the VPN's address instead of the relay
machine's. Use this when you'd rather not show the VPS's own address, when a provider blocks data-centre addresses, or
when you want the relay to appear in another country. Viewers still reach the relay at its usual https address, so
nothing changes on this server or on any device.

It uses [gluetun](https://github.com/qdm12/gluetun), a small container that connects to most VPN services (Mullvad,
ProtonVPN, NordVPN, Surfshark, Private Internet Access, Windscribe, AirVPN, IVPN, and any service that gives you a
WireGuard file). The relay runs inside gluetun's network, so **every** connection it makes goes through the VPN: streams,
films fetched whole, and its proxy for this server's own traffic (`PROXY_PORT`) too. If the VPN drops, gluetun blocks
everything until it's back, so the relay never connects to a provider without it.

1. On the relay machine, fill in the VPN part of `.env` (see `.env.example`). With WireGuard, that's your VPN service's
   name, the private key and address from its WireGuard configuration, and which country or city to use. The exact names
   for each service are in [gluetun's wiki](https://github.com/qdm12/gluetun-wiki/tree/main/setup/providers).
2. Start the relay with the VPN version of the compose file (it replaces the plain one):
   ```sh
   docker compose down
   docker compose -f docker-compose.vpn.yml up -d
   ```
   Use `-f docker-compose.vpn.yml` with every later `docker compose` command on that machine too
   (`logs`, `pull`, `up -d`). `docker compose -f docker-compose.vpn.yml logs gluetun` shows the VPN connecting.
3. Here: Admin → Network & proxies → Stream relay → **Test**. It shows **the address providers see**, which should now be
   the VPN's, not the relay machine's.

Things to know:
- **Speed:** all the video goes through the VPN, so pick a fast service and a server close to the relay. WireGuard is
  quicker than OpenVPN. Check the VPN's terms allow this much traffic.
- **Some IPTV providers block VPN addresses**, or count a changing address as account sharing. If a provider stops
  working through the VPN, a VPN address that stays the same (many services sell a "dedicated IP") usually solves it.
  Otherwise turn the VPN off for the relay, or use a proxy for that list instead.
- **Updating:** *Update the relay* in the app still works (it only replaces `relay.js`). New compose files are copied
  by hand, as before.
- **Already have a VPN that offers a SOCKS5 or HTTP proxy?** You don't need any of this: add it in Admin → Network &
  proxies → Proxies and choose it in **How the relay connects to providers** (above). The relay then goes through it
  the same way, without changing anything on the relay machine.

## Your server's own traffic through the same machine (optional)

Every stream of a list that uses the relay goes through it — also what this server reads itself: conversions,
downloads, recordings, other apps (the Xtream login, the HDHomeRun tuner, the M3U link), channel checks and connection
tests. Streams a browser can't play as they are (MKV films with AC-3 sound, for example) are converted in the browser
when it can (Chrome, Edge, Firefox, Safari), reading from the relay; otherwise this server converts them, reading from
the relay too.

Some things still go from this server to the provider directly:
- list refreshes, account checks and TV guides
- TMDB, subtitles and the other services

To hide your home address from those too, let the relay be this server's proxy:

1. In the relay's `.env`, set `PROXY_PORT=8888`, `PROXY_USER=…` and `PROXY_PASS=…` (a long password), then `docker compose up -d` again. Open port 8888 on the machine.
2. Here: Admin → Network & proxies → **Proxies** → *Add a proxy* → `http://USER:PASSWORD@myrelay.duckdns.org:8888`. Choose it as **Default for everything**, then **Test** and **Save**.

## What goes where

| | Without the relay | With the relay |
| --- | --- | --- |
| Streams a browser can play as they are (most live channels) | Device ↔ provider | Device ↔ relay ↔ provider |
| Films and episodes the browser can play as they are | Device ↔ provider | Device ↔ relay (from its disk) ↔ provider, the whole file at once |
| Streams that need converting (some MKV/AC-3 films, MPEG-2) | Converted in the browser: device ↔ provider; else device ↔ this server ↔ provider | In the browser: device ↔ relay ↔ provider; else device ↔ this server ↔ relay ↔ provider |
| "Open in another app" (VLC, Infuse…) | Device ↔ provider | Device ↔ relay ↔ provider |
| Downloads, recordings, other apps, channel checks | This server ↔ provider (through its proxy, if set) | This server ↔ relay ↔ provider |
| Lists, guides, account checks, TMDB, subtitles | This server ↔ provider (through its proxy, if set) | the same |
| Posters and channel logos | Device ↔ provider / TMDB | the same |

## Good to know

- **Your server restarting doesn't interrupt anyone watching through the relay.** The video goes from the relay to the device, not through your server. If the stream hiccups while the server is away, the player reconnects straight to the relay (its addresses stay valid for 12 hours) instead of asking the server; once the server is back, every device tells it again what it's watching, and for the first minute the relay keeps the connection shares it had, so nobody's connection is handed to someone else.
- **Connection limits:** a stream through the relay is still one connection to the provider, and busy-provider and priority rules work as before. A film that's fully on the relay no longer uses one.
- **The relay only fetches public internet addresses.** It refuses its own network, so it can't be used to reach anything else on the VPS's network. Set `RELAY_ALLOW_PRIVATE=1` only if a provider is on the same private network as the relay.
- **Make a new secret** (Admin → Network & proxies) if you think it has leaked, then put the new one in the relay's `.env` and restart it.
- **Checking the relay:** `docker compose logs relay` on the relay machine shows it starting. Admin → Network & proxies → Test shows how many streams are playing through it.
