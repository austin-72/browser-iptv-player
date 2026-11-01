# More kinds of lists, your own 24/7 channels, and using this with other apps

[← Back to the README](../README.md)

## More kinds of lists

**Admin → Lists → Add a list** now also takes:

- **MAC portal (Stalker / Ministra).** The portal address you'd type into a MAG box (often ending in `/c/`) and the MAC address the provider registered. Serial number, device ids and signature are optional — only some providers ask for them. You get the portal's channels in its own groups, its films and series (turn that off for very big portals, which take a few minutes to read), the account's expiry date, and the portal's own TV guide when it has one (added under TV guides as "From" plus the list's name). Portals hand out a fresh, short-lived address for every stream, so the server asks for it just before playback (`/api/proxy/stalker/…` redirects the player to it) and the video still comes straight from the provider.
- **Media server (Jellyfin, Emby or Plex).** Your films and series (with posters, plots, cast, ratings and episodes) join the catalogue next to your IPTV lists, and play straight from the media server as the original file — the browser plays it directly when it can, and the usual routes (conversion in the browser or on the server) take over when it can't.
  - Jellyfin / Emby: the server address and a username and password (or an API key). Tick *Also add its Live TV channels* to include them.
  - Plex: the server address and a Plex token (open any film → ⋯ → Get Info → View XML; the address ends in `X-Plex-Token=…`).
  - The addresses carry the login the way the media servers' own web players do, so use an account made for this rather than an administrator.

## My channels (your own 24/7 channels)

**Admin → My channels → Make a channel**: pick a category, a genre, a film series (a TMDB collection) or titles you choose, films, series or both, and the order (shuffled, in order, or oldest first). The channel appears in **Live TV** and the **TV guide** (channel numbers from 901 unless you give one) with a logo made from its posters.

There's nothing to stream or store: a channel is just its running order and a start time, so what's on at any moment is the same for everyone. Tuning in starts the current film or episode from the right point with the normal player, and the next one follows when it ends — no work for the server. The order is worked out again every night (new episodes, titles that left the provider); *Shuffle again* gives a new order.

24/7 channels are only played by this app: they aren't in the exported playlist, the Xtream login or the tuner (those would need the server to stitch programmes into one stream).

## Other apps: an Xtream Codes login and an HDHomeRun tuner

Both are in **Admin → Other apps** and are off until you turn them on.

### A login for IPTV apps (TiviMate, IPTV Smarters, OTT Navigator…)

Turn on *Xtream Codes logins*, then **Make a login** next to a profile. The app shows the username and password once (you can always make a new one or choose your own). Each login sees exactly what its profile sees here — languages, age limit, kids, blocked categories, hidden titles — with duplicates merged and names tidied. Films, series (with episodes), the TV guide (`xmltv.php`) and short guides all work. Streams are sent straight from your providers (a redirect) when the app can play them; ones that need special headers or your proxy go through this server.

In **TiviMate**: *Add playlist → Xtream Codes*, server `http://<this server's address>:8080` (the address shown in Admin → Other apps), then the username and password. In **IPTV Smarters**: *Login with Xtream Codes API* with the same three. Apps that only take an M3U link can use `http://<server>/get.php?username=…&password=…&type=m3u_plus` and the guide at `/xmltv.php?username=…&password=…`.

Passwords are stored hashed, and an address that keeps guessing wrong is shut out for 15 minutes. The usual host rules apply (with the default site password still set, only local addresses are answered).

### A TV tuner for Plex, Jellyfin and Emby (HDHomeRun)

Turn on *the tuner*, choose how many streams it may run at once and whose view of the channels it uses (a kids profile gives a kids-only tuner). It only answers devices on your home network (and Tailscale), and has no password — HDHomeRun tuners don't — so leave it off if you don't need it.

- **Plex:** Settings → Live TV & DVR → Set up Plex DVR → *Don't see your device? Enter its network address manually* → `<this server's address>:8080`. For the guide choose *XMLTV* and enter `http://<server>:8080/hdhr/epg.xml`.
- **Jellyfin:** Dashboard → Live TV → Tuner devices → + → *HDHomeRun*, address `http://<server>:8080`. Then TV guide data providers → + → *XMLTV* with `http://<server>:8080/hdhr/epg.xml`.
- **Emby:** Live TV → Add tuner device → *HD Homerun*, the same address; guide via XMLTV with the same guide address.

The tuner never uses more of a provider's connections than the account allows, counting everyone watching in this app too; Plex/Jellyfin are told "all tuners in use" instead. Streams are passed on as MPEG-TS as they are, or repackaged by ffmpeg (no re-encoding) when the provider sends HLS.

## Limits

- Portal catch-up (archive) isn't supported yet; live channels, films and series are.
- Some portals put series under films or use a different series layout; seasons and episodes are read the common Ministra way (`get_ordered_list&movie_id=…`).
- Jellyfin/Emby Live TV channels are added as their direct stream addresses; on some servers those only play through this server's conversion.
- Plex Live TV isn't imported (only films and series).
- Streams that apps are sent straight to (a redirect) can't be seen by this server, so they don't count as "in use" for the household's connection checks; tuner streams do.
