# Watching: player extras, multiview and watch parties

[← Back to the README](../README.md)

## Player extras

**Rewind and pause live TV.** Live channels keep what this device has already played (Settings → Player → *Rewind live TV*: off, 5, 15 or 30 minutes; 15 by default), so you can go back with the skip buttons, arrow keys, double-tap or the seek bar, and pause: the channel keeps loading while paused and carries on from where you stopped. The bar shows how far behind live you are; **Go live** jumps back. Nothing is stored on the server — it's this device's memory (browsers cap it too: Chrome keeps about 150 MB per stream).

**Audio sync.** Player menu → *Audio sync*, in 50 ms steps up to a second either way, remembered per channel (or film/series) on this device, with *Use … for everything* for a default.
- Sound too early: the sound is held back (Web Audio delay).
- Sound too late: the picture is held back — the video keeps playing underneath and a canvas shows each frame a little later (subtitles are drawn on top, in step with the sound).
- Streams the browser plays straight from the provider with its own player can't be adjusted by a web page (the browser won't let it read them), so while an offset is set those play through the server's relay. At 0 nothing extra runs.

**Sound only.** The headphones button on live channels: listen with the picture off and far less data. It uses the channel's own sound-only HLS rendition when there is one (straight from the provider), otherwise the server sends just the sound (like radio). A card shows the channel and what's on; it stays on as you change channels until you turn it off.

**Open in another app.** Player menu, or a channel's/title's options: VLC, MX Player or Just Player on Android; Infuse, VLC, Outplayer or nPlayer on iPhone, iPad and Apple TV; VLC on computers — plus *Download playlist (.m3u)* and *Copy the address*. The app gets the provider's own address when it needs nothing special, otherwise a link through this server that works for 12 hours. Playing here stops when you hand it over, so the provider's connection is free for the other app.

**Skip lengths.** Settings → Player: skip back and forward 5, 10, 15, 30 or 60 seconds (10/10 by default; Shift + arrow is always 60 s). Used by the buttons (which show the number), arrow keys, J/L, double-tap, media keys and the phone remote.

**Shuffle.** A *Shuffle* button on series pages (and *Shuffle play* in a series' options): random episodes, ones you haven't watched first, until you play something else.

**Buffer.** Settings → Player → *Buffer* (per device): Normal, Large or Extra large, for patchy connections or unreliable providers. More buffer means fewer pauses and a few seconds more behind live.

**When the app opens** (per device): Home, the last channel you watched, or a channel you choose.

**When a reminder starts:** show a note (as before), or switch to the channel after a 10-second countdown you can cancel.

## Multiview

Watch several live channels at once: Live TV → **Multiview**, **Add to multiview** in a channel's menu, or the player's
menu on a live channel.

- Up to 9 channels on a computer or TV (2 on a phone, one above the other). Layouts change with the number of channels:
  side by side, **one big** with the others beside it, or an **equal** grid (2×2, 3×3).
- Sound comes from one channel at a time: click it, or press OK on a remote. **Menu/Info** (or a long press on a phone)
  opens a channel's options: sound, change channel, full screen, remove. Back from full screen returns to the multiview.
- Every tile is a connection to the provider, and counts as one everywhere: *Busy providers*, *Take over* and priority
  viewers all apply to tiles. When a provider has no free connection, it says who's using it and offers to take over or
  to replace one of your own tiles. Someone taking over a tile removes just that tile and says who needed it.
- Tiles play straight from the provider the same ways the player does (hls.js, mpegts.js, the browser's own HLS), with a
  small buffer, and fall back to the server's relay. A tile that stops reconnects by itself.

## Watch parties share one connection

In a watch party the members watch the same thing at the same moment, so the server can fetch it **once** and give it to
everyone: the party uses one provider connection however many people are in it.

- On by default when the provider limits connections (the *Share one connection* box when starting a party); the host can
  switch it in the party panel at any time and everyone's player follows.
- HLS channels and films: playlists and segments are fetched once and shared (a short-lived cache keyed by address).
  Raw MPEG-TS channels: one connection to the provider, sent to every member — someone joining late starts at the next
  packet with the stream's tables first, and a member whose connection can't keep up is dropped (their player
  reconnects) rather than slowing everyone down. MP4 films and episodes: fetched in 2 MB pieces, one at a time, shared.
- It's only used inside parties; everyday viewing stays direct from the provider. The party counts as one connection in
  *Busy providers*, Admin → Overview and the connection checks.
