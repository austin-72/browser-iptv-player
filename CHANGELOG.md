# Changes in detail

What was changed and fixed, in more detail than the README (which says what the app does). Newer first; versions
from 2.7 on are named. The release notes on GitHub list each version.

## 2.8.12

- **Copies that play something else can be hidden for everyone.** Some providers put the wrong file under a title —
  Blippi under "Clifford the Big Red Dog" S1:E2, a 58-minute video under "The Cat in the Hat (2026)" (added three months
  before the film was out, under its name, cast and TMDB number). Nothing in the provider's details gives these away,
  so the admin can now hide such a copy: from **Plays something else — hide this copy** on a viewer's report in
  Admin → Error reports, or **Plays something else** in the player's menu while watching. Another provider's copy of
  the title plays instead; a film with no other copy leaves the catalogue, and an episode its series. What's hidden is
  listed in Admin → Languages & content, under **Copies that play something else**, with **Show again** for when the
  provider fixes it. (A copy is known by its provider and the provider's own number for the file — never the address,
  which holds the account's login.)
- **Report a problem** has a **Plays something else** choice (until now only "Wrong title or picture", which is about
  the details shown, not the video).
- **A film far longer or shorter than it should be is spotted while it plays:** under 60% or over 175% of TMDB's
  running time (films of 40 minutes or more, with TMDB's details). Another copy plays instead when there is one (from
  where it started, within the first two minutes); either way the admin gets a report — "Doesn't look like the right
  film" — with the hide button. Once per film and copy on each device.
- Error reports: a Samsung TV's own browser opening a page on the TV itself (127.0.0.1) is no longer reported as a
  problem with the app.

## 2.8.11

- **The admin can remove someone who's watching, and keep them off for as long as they choose.** Admin → Overview →
  Providers and watching now: each viewer has a **Remove** button. Choose how long (10 minutes up to 30 days, any
  other length in minutes, hours, days or weeks, or until you let them back in), a reason they'll see if you like, and
  whether to sign the device out too. What they're watching stops at once (and anything the server was converting for
  them), and their address is turned away — every page, the app, signing in — showing "You've been removed", when
  they can come back, and the reason. Every device at that address goes with it: the dialog shows the address and who
  else is there right now, warns when it's a home-network or Docker address several devices may share, and won't
  remove a device at your own address. Who's removed is listed under the providers, with when they're back and a
  **Let back in** button. (The address is the one the server sees: behind a reverse proxy or tunnel that needs
  TRUST_PROXY, which this server already has.)
- **Signing in no longer sometimes needs a refresh to reach "Who's watching?".** With a page already in the address
  (/#/home — what the app leaves there, so after signing out, a session running out, or opening a saved address), the
  right password sent the browser to that same address, which it only scrolls to rather than loading: the sign-in page
  stayed (its button greyed out) until a refresh. It now loads the app, at the page that was asked for. The same for
  signing in with a phone's code.
- **Tests: a server started for a test gets 30 s to say it's ready, not 10.** The first server a test run starts, on
  a machine that hasn't run it before (like GitHub's), could take longer than 10 s to load, and the sign-in test
  ("sessions, PINs and live connections") failed before it had begun. Nothing changes in the app. Sign-in checked
  again: the site password (a wrong one turned away), a profile's PIN (a wrong one turned away), staying signed in
  after a reload, and signing out, on a computer and a phone.
- The test of TMDB's request line (2.8.10) allows a slower machine more leeway.

## 2.8.10

- **People's pages open in a second or two, not half a minute.** Everything the server asks TMDB goes through one line,
  about 7 requests a second — and the background jobs (matching titles, filling in details, episode pictures) kept
  that line full, so a page someone had open waited its turn behind them, then sat out any pause TMDB had asked for.
  Now what a page is waiting for goes to the front of the line, waits out at most 3 s of a pause, and gives up on TMDB
  after 8 s rather than 15 (showing the saved answer when there is one). Background jobs carry on behind it as before.
- **Title pages are quicker:** TMDB's part of the page (cast with faces, tagline, logo, reviews) is asked for at the
  same time as the title's own details instead of after them, and a slow provider is waited for at most 1.2 s for a
  film's details when TMDB's are already here (what it sends is kept for next time).
- **Pages fetched a moment ahead:** resting the pointer on a poster or a person's name (a finger touching it on a phone,
  or a TV remote's focus staying on it) fetches what their page needs, so it opens with everything already there.
  Not with a data saver on.
- **Nothing jumping about as a page fills in:** a title's page and Home's banner show what it is and the buttons once
  the story, credits, tagline and lettering are in, with a short fade (at most 1.5 s and 0.7 s of waiting), instead of
  drawing them bit by bit with the title and Play button moving up as each arrived. A logo that arrives later takes no
  more room than the words did. On a phone the banner keeps room for its lettering and story, so the rows under it
  stay put. A person's page shows grey shapes where their picture, details and titles will be, instead of a spinner.
- **Small touches:** big pictures (behind a title or Home, faces, episode pictures) fade in as they arrive rather than
  appearing a line at a time; dialogs and a title's tabs come in with a short fade; buttons, pills, chips and posters
  give a little when pressed. All of it is opacity and size changes only — none on TVs and consoles, or with Reduce
  motion on.
- **Lighter animations:** subtitles move up out of the way of the player's controls by sliding (they used to be laid
  out again on every frame); a poster's hover shadow no longer animates (redrawn every frame); and the moving
  background's three glows are drawn at half size and shown twice as big — the same soft look, a quarter of the
  graphics memory.

## 2.8.9

- **Voice and keyboard buttons on the top bar's search box**, on every page: each opens Search with that one going.
  TVs now get the box too, the two buttons beside it (a remote's Left and Right step out of a text box at its ends);
  where the bar's narrow, the two buttons sit next to the Search button.

## 2.8.8

- **Better matches:** "dark knight" finds The Dark Knight, "fast and furious" Fast & Furious, "rocky 2" Rocky II,
  "spiderman" Spider-Man; a year typed with a name puts that one first ("dune 1984"); of titles that match as well,
  the more popular comes first; a title of exactly the name typed comes before a channel of that number. Typos are
  forgiven on the whole name ("the last huose", "how to train your dargon"), with every word typed still in it — not
  everything that shares one word. A year on its own ("2012") gives that year's films and series. Tried on a real
  catalogue of 107,000 titles: the exact name first 350 times out of 350, near misses found 1,027 times out of 1,039.
- **Other names and what titles are about:** a title's original name and what it's called elsewhere find it ("La casa
  de papel"), and TMDB's keywords give an "About" row ("heist", "time travel").
- **People:** actors, directors and creators from TMDB's details as well as the provider's. "with Tom Hanks",
  "starring …", "directed by Nolan", "created by …" put people first (titles called that still show); "Tom Hanks
  comedy" or "Nolan 2000s" narrows their titles by genre or years; a surname typed whole ranks those with it first.
- **Chips under the search box:** All, People, Films, Series, Channels, Episodes and Radio, with how many of each (Films
  or Series alone show them all as a grid); the categories the results fall into, most first — one narrows every
  row to it, with a link to everything in it; and the decades they're from. A channel shows once in the top results.
- **No suggestions dropping down under the search boxes any more:** the results follow what's typed instead. Typing in
  the top bar's box goes straight to the Search page, every letter carried over.
- **An on-screen keyboard** beside the search box, for a TV remote with no keys to type with (and anyone with a mouse
  who'd rather): letters, numbers, Space, Delete, Clear and Search, moved through with the arrows. On a TV it's open
  when the Search page opens with nothing typed; Back closes it. Not on phones and tablets, which have their own.

## 2.8.7

- **A new player layout, from the household's own choice in the layout sampler:** Settings moves up to the top bar
  (Small player, Watch together, Cast, Settings); on phones Play — with Back 10 and Forward 30 on films and episodes —
  sits big in the middle of the picture; Hide the controls and Sound only leave the bar (Sound only is still in
  Settings); the small player has Stop in its top-left corner, and Mute and Back to full screen in its top-right.
- **Admin → Player layout:** the admin arranges the player for every way it's shown — computer, phone upright (video
  on top of its page, or full screen), sideways and the small player, each for films and episodes or live TV — by
  dragging controls between the top bar, the middle of the picture, either side of the seek bar and the control bar,
  or leaving them out. Changes reach every screen at once; "Back to the built-in layout" undoes them. Catch-up uses the
  live layout plus the film controls it leaves out. Back, Play and Settings can't be left out.
- **Only the pause button pauses:** a tap on the picture shows the controls, or hides them when they're showing; a
  click shows them. The small player works as before. Admin → Player layout has a switch to make the picture pause again.

## 2.8.6

- **Phones held upright play as on YouTube:** a film, episode or channel plays in a strip across the top of a phone or
  tablet held upright, with its page scrolling below — the film's or series' page (episodes, details, cast, reviews,
  more like this) or the channel's schedule. The player's settings and side panels open as a sheet below the video.
  Turned sideways, or with Full screen, it fills the screen; held upright again, it's back on top. Back, or going to
  another page, makes it the small floating player; tapping that brings it back on top of its page. Computers and TVs
  are unchanged. On for everyone unless the admin turns it off (Admin → Playback); each profile can change it in
  Settings → Playback.

## 2.8.5

- **Error reports, gone through again:** Google's Cast script is loaded only on an https address — casting needs one,
  and a Chromecast can't reach "localhost"; on http://localhost (which browsers count as secure) it only failed to find
  its other half, and each place it looked was filed as a report. Its looking about (browser extensions most people
  don't have, Google's site) is no longer reported anywhere, while a script of the app's own that doesn't load still is.
  The cast menu says casting needs the https address when there's nothing else to offer.

## 2.8.4

- **More reviews on a title's page:** the Reviews tab counts all of a title's reviews on TMDB, and "More reviews"
  under them loads the rest, 20 at a time, until there are no more (GET /api/title/:k/reviews?page=N; not on kids
  profiles, nor with reviews switched off in Admin).
- **Sorting reviews:** as on TMDB, newest or oldest first, highest or lowest rated first (those with no rating last),
  or longest first. The choice is remembered on the device for every title.

## 2.8.3

- **Category headings in the accent colour everywhere:** Admin's sections (Status, Lists & channels, Viewing…) and its
  profile settings, the category lists of Live TV and Radio, the phone's category button and the player's menu — a
  little towards the text colour, so they stay readable in every theme.
- **The setup guide's card in Admin** is for new installs only: an install from before the setup page doesn't get it.

## 2.8.2

- **Genres that were nearly empty for series:** TMDB's list of series genres has no Horror, Thriller, Romance,
  History, Music, Sport or Faith, so a series could only be in them through a provider's category name (two horror
  series out of 21,000). TMDB's keywords for each title now count too ("supernatural horror", "psychological
  thriller", "love triangle", "period drama", "stand-up comedy", "cooking"…), and for a series with none, a clear
  phrase in its description ("a horror anthology", "a romantic comedy"). Films gain from the keywords as well.
- **Movies and Series:** the headings in the list of categories are in the theme's accent colour.

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
