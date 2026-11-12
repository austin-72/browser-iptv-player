# Watching: player extras, multiview and watch parties

[← Back to the README](../README.md)

## Player extras

**Rewind and pause live TV.** Live channels keep what this device has already played (Settings → Player → *Rewind live TV*: off, 5, 15 or 30 minutes; 15 by default), so you can go back with the skip buttons, arrow keys, double-tap or the seek bar, and pause: the channel keeps loading while paused and carries on from where you stopped. The bar shows how far behind live you are; **Go live** jumps back. Nothing is stored on the server — it's this device's memory (browsers cap it too: Chrome keeps about 150 MB per stream).

**Audio sync.** Player menu → *Audio sync*, in 50 ms steps up to a second either way, remembered per channel (or film/series) on this device, with *Use … for everything* for a default.
- Sound too early: the sound is held back (Web Audio delay).
- Sound too late: the picture is held back — the video keeps playing underneath and a canvas shows each frame a little later (subtitles are drawn on top, in step with the sound).
- Streams the browser plays straight from the provider with its own player can't be adjusted by a web page (the browser won't let it read them), so while an offset is set those play through the server's relay. At 0 nothing extra runs.

**Clear dialogue and night mode.** Player menu, just below *Volume boost*; each is on or off and remembered for the profile (on all its devices).
- *Clear dialogue* lifts the speech frequencies (around 1–4 kHz, by about 3–4 dB) and lowers the bass and the very top a little, so voices stand out from music and effects.
- *Night mode* evens out the sound: loud scenes come down (an explosion about 15 dB quieter), quiet speech comes up, and normal talking stays about where it was. Handy late at night or in a noisy room.
- Both can be on together, and with volume boost and audio sync. Switching them fades over a fraction of a second, so there's no click.
- Like audio sync, they need a stream the page may read. For one the browser plays straight from the provider with its own player, the menu says *Not for this stream*; choosing it anyway plays that stream through the server's relay (unless the admin set playback to *direct only*). The iPhone's own HLS player doesn't allow it at all (*Not with this player*), and browsers without Web Audio (some old TVs) don't show the options.

**Sound only.** The headphones button on live channels: listen with the picture off and far less data. It uses the channel's own sound-only HLS rendition when there is one (straight from the provider), otherwise the server sends just the sound (like radio). A card shows the channel and what's on; it stays on as you change channels until you turn it off.

**Open in another app.** Player menu, or a channel's/title's options: VLC, MX Player or Just Player on Android; Infuse, VLC, Outplayer or nPlayer on iPhone, iPad and Apple TV; VLC on computers — plus *Download playlist (.m3u)* and *Copy the address*. The app gets the provider's own address when it needs nothing special, otherwise a link through this server that works for 12 hours. Playing here stops when you hand it over, so the provider's connection is free for the other app.

**Skip lengths.** Settings → Player: skip back and forward 5, 10, 15, 30 or 60 seconds (10/10 by default; Shift + arrow is always 60 s). Used by the buttons (which show the number), arrow keys, J/L, double-tap, media keys and the phone remote.

**Shuffle.** A *Shuffle* button on series pages (and *Shuffle play* in a series' options): random episodes, ones you haven't watched first, until you play something else.

**Buffer.** Settings → Player → *Buffer* (per device): Normal, Large or Extra large, for patchy connections or unreliable providers. More buffer means fewer pauses and a few seconds more behind live.

**When the app opens** (per device): Home, the last channel you watched, or a channel you choose.

**When a reminder starts:** show a note (as before), or switch to the channel after a 10-second countdown you can cancel.

## Play queue

Line up films, series and episodes to watch one after another.

- **Play next** puts something at the front of the queue, **Add to queue** at the end: on a title page (under *More*, next to *My List*), in the … menu of any poster (long press on a phone, Menu/Info on a remote) and in an episode's … menu.
- When a film or episode ends, the first thing in the queue starts with the usual *Up next* countdown (*Play now* / *Not now*); the Next button and the N key go to it too. The queue comes before the next episode of a series. A queued series plays from where you are in it. With *Autoplay next episode* off, the *Finished* screen offers it instead.
- Something leaves the queue when it starts playing, however you started it.
- See and change it in **My stuff → Queue** (on phones: My List → Queue), or from the player's menu → *Your queue*, which opens beside the video: play, move up or down, remove, *Play the queue*, *Clear*. Everything works with arrow keys and OK on a remote.
- It belongs to the profile and is kept on the server, so it's the same on every device of that profile, and changes show up on the others straight away.

## Subtitles

**Subtitle timing.** Subtitles menu (the CC button) → *Subtitle timing*: *Earlier* / *Later* by 0.1 s, *Much earlier* / *Much later* by 0.5 s, and *Reset*. The menu and a note on screen show where you are (e.g. "+1.5 s" means the subtitles come 1.5 seconds later). It moves every kind of subtitle the player shows: tracks inside HLS streams, text tracks read from files, subtitles found online, closed captions, and picture, DVB and teletext subtitles. Keys: **G** earlier, **H** later (on live TV G opens the guide, so it's **Shift+G** there). Remembered per film, episode or channel in your profile (the last 300), and used again next time on every device. On a TV remote: OK on *Later* again and again — the highlight stays where it is.

**Subtitle files next to a video.** In a media folder, `.srt`, `.vtt`, `.ass` and `.ssa` files named after the video are listed in the Subtitles menu with its own tracks, e.g. *English · .srt*. The language comes from the name: `Film.en.srt`, `Film.eng.srt`, `Film.French.srt`, `Film.de.forced.srt`, `Film.English.SDH.srt`. They're sent to the player as WebVTT (old Windows-encoded files are read too; ASS keeps the text, not its styling), picked by your subtitle language like any other track, and move with *Subtitle timing* and when the server converts from part-way through.

**Picture subtitles (Blu-ray, DVD, DVB).** Films ripped from discs often have subtitles stored as pictures: PGS (Blu-ray), VobSub (DVD) and DVB. They're listed in the Subtitles menu with the file's other tracks and picked by your subtitle language like them. The server never draws them into the video or converts them: ffmpeg copies the subtitle streams out of the file (all of a file's picture tracks in one read; kept in the cache like text subtitles), and the player draws them itself on a layer over the video:
- where the picture is (fit, fill, zoom, black bars, full screen), at the size set in *Subtitle style*, and above the controls while they show;
- only what's needed: it fetches the packets for the next minute or so and decodes just the subtitle on screen, so seeking, pausing and long films are fine on a TV;
- with the server converting part-way through a film, or converting in this browser, the times still line up.
They need ffmpeg on the server (without it they stay hidden as before), and like other subtitles inside files, they aren't read while you watch on a provider account that allows only one connection. The first subtitles show as soon as the copy reaches them; for a film coming from a provider that means reading the file once.

**Captions and subtitles on live TV.**
- *Closed captions* (CEA-608) carried inside the video of HLS channels and films: listed as "… (captions)" next to the stream's own subtitle tracks. Turned on by themselves when your profile wants subtitles in that language. They're laid out for a narrow 32-column grid, so they're shown a little smaller than other subtitles (70%, still following *Subtitle style*).
- *DVB subtitles* (pictures) and *teletext subtitles* (text, e.g. page 888) on MPEG-TS channels that play in the browser: the channel's own list of them appears in the menu (language, teletext page). Teletext is shown in your subtitle style.
- When the server converts a live channel anyway (an MPEG-2 channel, say), it copies the channel's DVB and teletext subtitle streams aside in the same conversion — a copy, not extra work, and no extra connection — and the player shows them the same way. A conversion is never started just for subtitles.
- If the stream reconnects, the subtitles you picked come back on.

What a browser can't do: captions inside a raw MPEG-TS channel played in the browser (the MPEG-TS player doesn't pass them on — they do show when that channel goes through the server's conversion as HLS); CEA-708-only captions (the HLS player reads the CEA-608 part, which nearly every broadcast also carries); DVB or teletext subtitles inside an HLS channel (the HLS player ignores them). Picture subtitles don't appear in picture-in-picture windows (neither do text ones) or when casting.

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

## Remote and keyboard buttons

**Settings → Remote and keyboard** chooses what these do on the device you're using:

- the **coloured buttons** (red, green, yellow, blue), **Menu** and **Info**, the **media keys** (play/pause, stop,
  rewind, fast forward, next and previous track), the **number keys** and, on a computer, the spare keys F2, F4, F8, F9;
- each can open the TV guide, Live TV, Home, Search, My List or your favourite channels, go to the last channel, turn
  subtitles on or off or pick the next ones, change the audio track, step through the sleep timer (15, 30, 60 min, off),
  open multiview, picture-in-picture, sound only, stream info or the quick launcher, play/pause, your queue, the
  wishlist, teams you follow, your viewing, the year in review, report a problem, move subtitles earlier or later,
  turn clear dialogue or night mode on or off, or play **a channel** you pick.
- Buttons left on *Usual* do what they always did (shown under each one). In the player on a TV, Menu opens the
  settings menu and Info shows what's on, unless you give them another job here. While live TV is playing, the number keys still go to a channel number.
- **Press a button to see what it's called** shows the name and code of any button, because TV remotes send different
  ones (Samsung Tizen, LG webOS, Android TV and Fire TV, HbbTV). On Samsung TVs the app registers the coloured, number
  and media keys so they reach it.
- Each device keeps its own choice (stored in that browser). *Make this my default on all my devices* saves it to your
  profile, and devices without their own use it.

## Quick launcher

Press <kbd>Ctrl</kbd>+<kbd>K</kbd> (<kbd>⌘</kbd>+<kbd>K</kbd> on a Mac) anywhere, hold OK on the Search button with a
remote (or hold your finger on it on a phone), use **Quick launcher** in the profile menu or on the Search page, or give
it a remote button. Then type:

- a page or an admin tab ("guide", "admin profiles"), or a single setting ("subtitle style", "theme", "text size");
- a profile ("switch to Sam"), a channel ("BBC One", "ch 101", or just "101"), a film or a series;
- an action: "sleep timer 30 min", "turn on sound only", "night mode", "clear dialogue", "subtitles later", "subtitles",
  "last channel", "stream info", "report a problem"
  (a note to the admin in Admin → Error reports), "ask for more time".

The arrow keys and Enter pick, recent picks come first, and small typos are forgiven. On a TV the results come first;
press Up to type, or just press the number keys.
