# Changes in detail

What was changed and fixed, in more detail than the README (which says what the app does). Newer first; versions
from 2.7 on are named. The release notes on GitHub list each version.

## 2.8.1

- **Genres tidied:** a provider's "Comedy." or "Talk-Show", "Mystère", "Krimi", "Familie", "Dokumentarfilm" and
  "Action &amp; Adventure" now count as Comedy, Talk, Mystery, Crime, Family, Documentary and Action + Adventure —
  they were genres of their own with one or two titles each. Catalogues saved before are tidied when the server starts.
- **One meaning of a genre:** with smarter categories on, the Genre filter on Movies and Series offers the same genre
  categories as the list down the side (with how many of the titles shown are in each), and a genre on a title's page
  opens that category.

## 2.8.0

- **Setting up a new install:** no shared `changeme` password any more. The first visit opens one screen to choose the
  site password and make the admin profile (with its PIN), from the home network only, then a setup guide: playlists,
  the TV guide, languages, a TMDB key, the time zone, everything or just watching, and opening it on other devices
  with a QR code. Installs made before keep their password.
- **Time zone without configuring:** taken from the browser at setup, changed in Admin → Security; TZ in the
  environment still wins.
- **The start-up message** no longer lists a container's own addresses (of no use outside it); outside Docker it
  prints this computer's addresses with a QR code.
- **Compose file** uses the ready-made image and only `./data`, with the hardware-transcoding examples (Intel, AMD,
  NVIDIA) written in.
- **Admin** says when the app is on plain http and what that leaves out.
- **Title pages** follow the theme's accent colour (the pressed buttons and the progress on Play were always red).

## 2.7.0

- Movies and Series list their categories down the side (For you: Continue watching, My List, Recommended, Not
  watched yet), with filter chips, sort and A–Z letters; a category sheet on phones.
- Title pages: Play and the actions with their names at the top, then tabs for Episodes (or Bookmarks), Details,
  Cast, Reviews and More like this, whose *More* finds what's like those.

## Earlier

- **Quicker to start:** when the provider has said what a film or episode is (or for a live channel), a server conversion starts straight away, with the look inside the stream running at the same time instead of first — a few seconds sooner. This briefly uses two connections, so it only happens when the account has room for two; if the look finds something else is needed (converting the picture, another audio language), the conversion starts again that way. Admin → Playback → *Start conversions quickly* turns it off. Live conversions come in 2-second pieces instead of 4, and a TV's or phone's own player waits for about three before it starts. On a PlayStation, copies the server already knows can only play through it aren't each checked first, and the signed address comes in the same answer.
- **Fewer steps before the video:** the copy order and how this device reaches the copy that goes first come in one answer. The separate check before an episode is gone too, since the server reads a series again itself when it needs to. On a TV or PlayStation (light catalogue), the stream addresses of a film whose page is open, and of everything in Continue watching, are fetched ahead, and the player comes up at once while an address is fetched.
- **Continue watching opens the page:** a film or episode in *Continue watching* opens its page, whose main button says *Resume* (for a series, *Resume S1:E3*, or the next episode), instead of starting at once.
- **Tighter security, from an outside review of the code:** every page now carries a Content-Security-Policy and frame protection (see [Security](#security)) — for that, the two small scripts written into the pages moved into files of their own and the handful of handlers written into HTML became listeners. The bundled libraries' versions and checksums are written down ([VENDOR.md](VENDOR.md)) and checked by the tests — all four match their official releases. A test takes a backup, empties the server and restores it; another checks that no page or script writes script into HTML. `package.json` now says Node 20 or later, as this page does. There's a [SECURITY.md](SECURITY.md).
- **More formats on more devices:** worked out by measuring — 65 sample files (the common containers, picture and sound formats, and the awkward cases) put through the server's own conversion for a device that only decodes H.264 and for one that decodes everything, checking what came out. What that found, and now does:
  - *Each device says what it decodes*, and only what it can't is converted: which formats it takes, whether its HEVC is 8-bit only, and the tallest picture it decodes (asked of the browser once). A film taller than a phone's or stick's decoder goes is brought down for it instead of failing first.
  - *AV1 and VP9 are passed on as they are* to a device that decodes them (in MP4 pieces: MPEG-TS can't carry them) — before, they were always re-encoded. HEVC goes out in MP4 pieces for Apple's own player (older iPhones, AirPlay to an Apple TV), which shows nothing otherwise.
  - *AVI files with H.264* (no picture timestamps) are copied; the copy used to stop with "first pts and dts value must be set".
  - *HDR films converted for a screen without HEVC* (a PlayStation, older browsers) are brought down to ordinary colours, where they came out grey and washed-out; Admin → Playback says whether your ffmpeg can (it needs the *zscale* filter). If that step ever stops ffmpeg, the film is converted without it.
  - *Interlaced pictures* (broadcast TV, DVD rips) are deinterlaced when converted — no more combing.
  - *Sound the server can't decode* (AC-4 on some broadcast channels): another audio track is used, else the picture plays without sound and says so, instead of the channel failing. A picture format ffmpeg can't decode says that plainly.
  - *A film from the server's copy starts where it was asked to.* The player took the copy's still-growing playlist for a live stream and started near its end — a few seconds into the film, more on a fast provider, minutes for a file on the server's own disk — and the same after a seek.
  - *The position after a seek or a resume in a copy is right.* A copy's picture can only begin at a key frame, up to ten seconds before the point asked for in many films, while its sound begins at the point: the player counted from the point, so the time shown, where it resumed, and separately fetched subtitles were out by that much, with a silent lead-in. The server now reads where the picture really starts and says so, and the player moves up to the point. (For hls.js and Apple's player; a TV's or console's own player gets its copies exactly as before.) With a provider that can't start part-way at all, the copy began at the film's start while the player showed the point asked for — now it knows.
  - A Chromecast gets a conversion of its own (H.264) when what's playing is a copy made for this device's formats.
- **The whole project, read again (seven reviews of the older code):**
  - *Keeps your data:* a data file that can't be read for a moment (a shared Windows folder saying "busy") is tried
    again and never replaced by an empty one; a restart that catches a list or guide mid-refresh no longer puts it on
    hold for 6–48 hours; restoring a backup always restarts (it could carry on and never save again) and checks the
    file whole first; a wrong file uploaded over a playlist no longer replaces it.
  - *Can't be held up or got round:* a crafted error report, a broken guide file or a gzip bomb can't freeze the
    server; the parental PIN and profile PINs lock for longer each time and count guesses across devices and
    profiles; an unlock is for the profile that entered the PIN; a kids profile can't delete itself (who may add
    profiles is the admin's choice: Admin → Profiles → *Only the admin can add profiles*); "don't remember my PIN" now ends 30 minutes after the profile was
    last used; a message between profiles can't carry code; a provider's ids can't name files outside the cache.
  - *Player:* a film that stops well before its end is picked up where it stopped instead of being marked watched and
    followed by the next episode; a browser-side conversion that was given up on is really stopped (it could later
    take over the video and kept its connections); a live channel frozen without saying so reconnects after 20
    seconds; "started muted" by the browser isn't remembered as your choice; an audio-only station isn't converted
    for having no picture; the screen may sleep when paused or finished; trailers stop when the film starts; the
    next-episode countdown waits while the page is hidden; speed keys only on films and episodes.
  - *TVs and older browsers:* arrow keys work on "Who's watching?" and the PIN pad; focused rows no longer snap under
    the top bar on Tizen/webOS up to 4; adding a profile, broad searches, menus closing on an outside press,
    reminders and pause/resume no longer fail on browsers missing newer features; reminders fire once.
  - *Relay and proxy (relay version 7 — Admin → Network → Update the relay):* the provider's connection is closed when
    the server stops reading through the relay; playlists asked for the way ffmpeg asks are rewritten; a ".m3u8"
    that is really the video isn't read as a playlist; addresses written as IPv4-inside-IPv6 are treated as the
    private addresses they are; HEAD on a proxied stream answers instead of downloading it.
  - *Admin:* a failed refresh says so (it said "Refreshed"); renaming a list doesn't download it again; a proxy's host
    can be changed with its password left masked; the User-Agent is checked; removing a guide, deleting a report and
    making a new app password ask first; Statistics shows where a converted start's time goes.
  - *Lighter on big catalogues:* recommendations aren't worked out again after every guide refresh; Home's list rows
    no longer count every matched title per row; episodes of a removed list are dropped from memory.
- **Access, tightened:** a signed stream link opens exactly what it was made for (one conversion session, one proxy
  address, one portal item — it used to cover everything under `/api/proxy`) and only reads; no link is made for a bare
  prefix; a portal (Stalker) item or a media-folder file asked for by a browser needs a profile that may watch it; a
  channel's address can't be swapped for a file on the server's disk; stopping a conversion is its owner's or the
  admin's; a remote allowed for one profile isn't allowed for another on the same phone; locked channels aren't named
  in “watching now”.
- **Starting a video, steadier:** a copy that's given up on can no longer fail a second time a moment later (which
  skipped a copy untried); checking the other copies never opens a second connection on the account being started;
  a copy's own time to start is what's remembered, not the wait for the copy before it; a conversion that's ready
  doesn't wait up to 15 seconds for the look inside; closing the player stops a conversion got ready on the side.
  An episode's copies keep their order between reads of a series (a slow provider left out of one answer used to
  renumber them, so a player's “backup 2” became another copy).
- **Second review, fixed:** a season saved as files goes one episode at a time (it took a connection and a
  conversion per episode, all at once); a head start never overlaps another or takes an account's last connection,
  and what plays next gets one in the last 90 seconds; a subtitle source that failed is asked again after a minute,
  not six hours; two fetched subtitles with the same name no longer show on top of each other; SubDL downloads are
  https-only with every redirect checked; a guide row with no listings can be left with the arrow keys; *Why?* gives
  provider details to the admin only and nothing for a locked channel.
- **Why no listings:** an empty guide row, or a channel's page with no guide information, has a *Why?* that answers
  in plain words — no guide added, the guide failed to download, no guide carries this channel, its listings ran out
  — and what to do, with the channel still a tap away.
- **A head start for Play:** opening a film's or series' page has the server look inside the file its Play button
  would start (when the account has a connection to spare), so the conversion doesn't wait 1–3 seconds for that when
  Play is pressed. Admin → Playback → *Get ready when a title’s page opens* turns it off.
- **Second look at this week's changes:** the remote follows a reloaded screen instead of dropping to the list; two
  windows of one browser are two screens again; Home keeps ordering itself when a list row is added, doesn't count
  hidden rows towards its eight, and counts each row once per visit; the live timeline holds still while dragged.
- **Buffering, explained:** when a video has waited 5 seconds, or stops for the third time in three minutes, the player
  checks the connection between the device and the server and says where the hold-up is — this device's connection, or
  the provider sending slowly — with *Try another copy* when there is one, so nobody restarts things that were fine.
  And the big banner on Home can be switched off (Customise), and so can its *Right now* panel.
- **Timeline, easier and finer:** a taller place to press and a knob that's always there on touch screens; while
  dragging, moving away from the bar (up or down) slows it to a half, a quarter, then a tenth, for landing within a
  few seconds; the time shows how far you're jumping; the mouse wheel over the bar steps 5 seconds (1 with Shift); the
  controls no longer fade out mid-drag, and a cancelled touch doesn't jump.
- **Error reports, gone through again:** an episode whose series has left the catalogue no longer breaks the player's
  Episodes panel; an answer from the proxy in front of the server (502, 520, 524 — the server restarting, a blip) is
  shown but no longer filed as a bug, and a read it answered for is asked once more first; a script that didn't arrive
  is fetched once more before saying so.
- **Home, smarter:** what you're in the middle of leads the page (*Continue watching*, how much is left, one Resume
  button; the film picked for you shows when there's nothing to resume). Rows order themselves — live TV up at the times
  of day it's watched on that device, rows you pick from up, rows never used down, new episodes at the top when there
  are some — until you move a row in Customise, after which your order stays. Recommendations share one *For you* row
  with a chip for each kind, favourite and recent channels one *Your channels* row, and the page shows eight rows with
  the rest behind *More rows*.
- **Remote, steadier:** the picture of what's playing on the remote no longer flashes (it was put in again with every
  update from the screen), a screen that reconnected shows once in the list of screens instead of once per old
  connection, and an open remote follows its screen to the new connection.
- **Slow copies remembered:** a copy the player gave up on because it hadn't started after 9 seconds (while another
  answered quickly) puts its list's copies after the others' for six hours, or until one of its videos starts in under
  8 seconds — so the next episode doesn't begin on the same slow copy. And a device whose own conversion didn't start
  in time has the server's conversion go first for six hours, instead of waiting 8 seconds on it every time.
- **Hardware encoder, checked:** the server tries the chosen hardware encoder on a half-second test picture when it
  starts and whenever the choice changes, and Admin → Playback says whether it works and, if not, why — for example no
  graphics device inside the container, which is always the case for Intel or AMD under Docker Desktop on Windows or Mac.
  One that can't work is never tried on a viewer's video.
- **Subtitles, fixed:** their size now follows the picture on screen, 4.5% of its height at *Subtitle style → 100%*, so they're the same size against the picture in a window, full screen, on a phone held either way or on a TV. They used to be "3.2em", which each browser read differently. Lines sit just above the bottom of the picture, not the bottom of the video's box, which on a phone held upright is in the black below it. A film resumed through the server's conversion no longer shows a screen full of subtitle lines at once: ffmpeg writes times under an hour as *mm:ss*, and the ends of those weren't moved back. Subtitles fetched online (SubDL, Addic7ed, OpenSubtitles) stay on through a reload, such as a jump in a converted film or a new quality, with their times moved to match.
- **SubDL:** a title SubDL doesn't have under its TMDB number is searched again by name (and year, for a film), and a subtitle without a language field counts as the language asked for. A SubDL subtitle whose file SubDL gives as a whole address, or with spaces or brackets in its name, downloads; these were refused as "Bad subtitle" (only addresses on SubDL's own sites are fetched). A download holding only styled .ass/.ssa subtitles is shown as plain ones. When SubDL (or another source) can't search — a bad key, today's searches used up, the site down — *Find subtitles* says so under the results, and the server log says so once an hour, instead of the source being left out silently.
- **Conversions from the relay's copy:** with the stream relay on, the server converts films and episodes from the relay's own copy of the whole film — the same one devices play from — instead of reading the stream through it as it comes. A film is fetched from the provider once, at full speed; the conversion starts on what's already there and jumps within it at once; and the provider connection is free again once the film is all in. (Live channels are converted as before. The relay itself doesn't convert anything.)
- **A slow copy doesn't hold things up:** when a title has several copies and the one starting hasn't begun after 2 seconds, the server checks the others at once and answers 1.5 seconds after the first one responds (a copy still silent counts as slow). If the current copy's provider isn't answering, or answers more than three times slower than another, the player switches to the quick one, usually around 5 seconds in, instead of sitting out timeouts of 12 seconds to a minute. The server also remembers providers that have been very slow (over 8 seconds) or silent in the last ten minutes, and tries their copies last; failed plays stay Channel health's to rank, as set in Admin.
- **Aiming for under 10 seconds:** each way of playing gets a short time before the next is tried: 8 seconds playing straight from the provider (12 on a TV), 8 for converting in this browser (it was 45, and on iPhones it could hang that long), 12 through the server, 30 for the server's conversion. When the way being tried hasn't started after 4 seconds and a server conversion comes next, the server starts getting it ready at the same time, so it's there if needed; it's ended at once if not. (Only when the provider allows a second connection, or the film comes from the stream relay's own copy.) On iPhones and iPads the server converts first, and the browser's own conversion comes after.
- **What it's doing while it starts:** the loading screen says each step — connecting to which provider, which copy (*Copy 2 of 5*), whether the server is repackaging or converting it, why it moved on from the last way or copy — with a running count of seconds, and when it's slow, what's being done about it.
- **Time to start, measured:** each play reports how long it took from pressing Play to the picture. Admin → Statistics → *Time to start* shows the average, how many started within 5 seconds, and the slowest providers. A start over 15 seconds also files a *Slow to start* error report with what each step took.
- **Next episode straight away:** a series' episodes are asked for the moment an episode is chosen, and asked for once. The Next button is there from the start; pressed before the list has arrived, it goes as soon as it has. A series on several lists no longer waits for the slowest provider: once one copy has answered, the others get 2.5 seconds, and a copy left out is in the next answer.
- **The player's settings, all checked:** choosing a backup in *Source* works again (it did nothing while quick switching was on). *Sleep timer → End of this video* says so instead of "1 min left". *Screenshot* of a stream played straight from the provider is taken by the server, full size. *Volume boost* on such a stream switches it through the server's relay, as Clear dialogue and Night mode do. At the end of a film, the *You might like* pictures are fetched in its last two minutes, and one that won't load shows the title instead of an empty box.
- **Smoother on big catalogues:** Home's *Something different* row picks its titles directly instead of shuffling the whole catalogue (a quarter of a second of every visit, on a slow device). Only the posters on screen swing as a row scrolls, each with its own small animation run by the graphics chip. A gap of over 2 minutes is no longer reported as a frozen page: an iPhone's home-screen app goes on saying it's on screen while it's asleep.
- **Through a restart:** a player that was going when the server restarted (an update being applied) waits for it to come back and carries on, instead of trying every copy and giving up. An episode it was playing is read again from its series. Episodes are only read from the provider when a series is opened, so before this a restarted server answered *That isn't available* for it. An episode or film that really isn't there any more is said so straight away.
