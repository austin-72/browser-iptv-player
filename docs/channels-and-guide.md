# Channels, the TV guide, your lists and parental locks

[← Back to the README](../README.md)

Everything here is stored on the server in `data/channels.json` (admin changes) and in each profile's settings (your lists), so it survives restarts, list refreshes and updates.

## Admin → Channels

Search by name or number, and filter by list, category, type (TV or radio) and "Changed", "Hidden", "Locked" or "No guide".

- **Edit** a channel to rename it, give it a number, move it to another category, set its logo (a web address, or upload a picture; it's shrunk to 256 px and kept on the server), choose its TV guide channel, move its guide times, lock it or hide it. **Undo all changes** puts it back to the provider's version.
- **Reorder** within a category with the arrow buttons, or by dragging the rows on a computer.
- **Select several** with the tick boxes (hold Shift to tick a whole run) to hide or show them, move them to another category, number them from a starting number, lock or unlock them, or undo their changes.
- Changes are keyed to the channel, so they stay put when the provider's list refreshes. If a provider renames a channel's address, the change follows it. They show on every device straight away, and appear in the playlist and guide exports (names, numbers, categories, logos and guide times).

## TV guide matching and time offsets

- Each channel's guide is matched automatically. To choose one yourself, open **Edit → Pick a guide channel**, search across all your guides and see what's on now and next before you pick. **Match automatically** goes back to the automatic match.
- **Time offset**: move a channel's guide times in half-hour steps (in the channel's Edit window), or a whole guide's times (Admin → TV guides, next to each guide). The two add up.
- Only the channels you actually use are kept in memory, as before; offsets are applied as each guide is read, so they cost nothing extra.

## Find guides and logos

For channels with no guide or no logo, **Admin → TV guides → Find guides and logos** suggests matches from two free public databases:

- **iptv-org** ([github.com/iptv-org/api](https://github.com/iptv-org/api)): tens of thousands of channels with their other names, country, logos, and the channel ids many XMLTV guides use (`BBCOne.uk`).
- **epg.pw**: ready-made XMLTV guides for about 20 countries.

Press **Look for matches**. The server downloads the public lists (several tens of MB the first time; they're kept in `data/cache/publicdb` and refreshed once a week). It reads them a piece at a time and keeps only names, countries and logos, and from epg.pw only the channel list at the start of each country's file. Then it matches your channels by name, other names and country. The country comes from the playlist's guide id (`….uk`), from category names like "UK | Sports" (as the provider wrote them), or from the language.

Each suggestion says how sure it is: **Sure** (same name and country, or the same guide id), **Likely**, or **Maybe** (the same name exists in several countries). Untick anything you don't want, then **Accept** a row, **Accept ticked**, or **Accept all sure matches**.

- An accepted **logo** is saved the way a logo you set in Admin → Channels is, so it survives list refreshes.
- An accepted **guide** links the channel to that guide's channel (like *Pick a guide channel*). When a guide you already have uses the iptv-org id, that's all it does. For an epg.pw match it also adds that country's epg.pw guide (only the countries you accept), which is then refreshed like any other guide.
- If you run the iptv-org EPG grabber yourself, enter its guide address under *Your own iptv-org guide* to use it for channels iptv-org has listings for.

Nothing is downloaded unless you press the button, and nothing changes until you accept a match. `IPTVORG_API_BASE` and `EPGPW_BASE` point it at other addresses (the tests use a local stand-in, `test/mock/publicdb.js`).

## Channel health

**Admin → Channel health** shows which channels play and which don't.

- **What it counts:** every time someone plays a channel, their device already tells the server whether it worked: which copy (main or backup, so which provider), which route, or what the player said when it failed (the message and HTTP status). Nothing extra is opened. Failures that aren't the channel's fault don't count against it: a browser that can't decode the format, or a provider saying the account's connections are all in use. A channel that played and then stopped isn't counted as dead either.
- **Providers:** up, down or having problems, the share of attempts that worked over the last 7 days (with a bar per day), how many channels are failing now, and the last success and failure. A provider is only marked **Down** when, since it last worked, channels failed on several different channels (three, or every one tried if it never worked); one dead channel tried again and again is that channel's problem, not the provider's. **Problems** likewise needs failures on more than one channel.
- **Failing now:** each channel with a copy that's failing: the last error, how many times in a row and since when, whether it was a viewer or a check that saw it, and which backups work. Filter by provider, "No copy works" or "A backup works", or search. **Use the backup first** makes a working backup play first (until you choose *Back to the usual order*); **Hide channel** hides it for everyone (show it again in Admin → Channels → Hidden ones); **Forget** clears its record.
- **"May be down":** when every copy of a channel failed several times in a row in the last 2 days (3 plays, or 2 checks) with no success since, Live TV, the guide's channel column and the channel's page show a small amber **May be down** badge, so nobody keeps trying it. A backup nobody has tried yet counts as possibly working, so the mark isn't shown. You can turn the mark off.
- **Skip copies that keep failing** (optional): copies that failed their last 2, 3 or 5 tries are tried last, not first, when a channel plays. They're never removed.

### Background checks (optional, off by default)

Turn on **Check live channels in the background** and choose the hours (02:00–06:00 to start with), or press **Check now** on a provider. A check asks for a moment of the stream (an HLS playlist and the headers of its newest segment, or the first 4 KB of an MPEG-TS stream) and hangs up.

It is careful with your connections:

- one channel at a time across all providers, a few seconds apart (5–60 s, you choose);
- never while anyone is watching from that provider, or stopped watching in the last 3 minutes, during a connection test, while another app (the Xtream login or the tuner) plays from it, or while the server is converting a stream;
- on a provider that allows one stream at a time, or whose limit isn't known yet, only when nobody else has the app open, since anyone could be about to press Play;
- it stops the moment someone starts playing a channel from that provider, or (on a one-stream provider) opens the app.

Some providers count every stream request as a sign-in. Tick **Check gently** for those: one check every 45 seconds and at most 120 a night. Each provider shows how long a full check takes at these settings (and over how many nights). Channels a viewer had trouble with are checked first; each channel is checked at most once a day.

The data stays small: per copy of a channel only a few rolling counters (failures in a row, the last error, the last success, the last 7 days' totals) and per provider the last 7 days, in `data/health.json`. Records of channels that are gone are dropped.

## Placeholder listings

Channels with no guide data show hour-long blocks named after the channel (for event channels, the event name), drawn in a lighter dashed style so they're clearly not real listings. They're made on the fly in the browser and never stored. Turn them off in **Admin → TV guides → Placeholder listings**.

## Event and pay-per-view channels

Many providers have channels that carry one event at a time and put it in the channel's name, with no guide:

| Channel name | Channel | Event | Starts |
| --- | --- | --- | --- |
| `USA \| PPV 03: UFC 310: Pantoja vs Asakura (Sat 7 Dec 22:00 ET)` | PPV 03 | UFC 310: Pantoja vs Asakura | 7 Dec, 22:00 New York time |
| `NFL 05 \| Bills vs Chiefs @ 8:20 PM ET` | NFL 05 | Bills vs Chiefs | the next 20:20 New York time |
| `EVENT 12 - 2026-11-02 19:45 Arsenal v Chelsea` | EVENT 12 | Arsenal v Chelsea | 2 Nov 2026, 19:45 (the list's time zone) |
| `ESPN+ 14: NCAAF \| Texas vs Michigan 11/02 3:30PM EST` | ESPN+ 14 | Texas vs Michigan (NCAAF) | 2 Nov, 15:30 New York time |
| `DAZN 4 - NO EVENT STREAMING` | DAZN 4 | No event right now | |

- The channel is shown by its short name (PPV 03), with the event underneath, and it gets **guide listings made from its name**: 3 hours long, or until the next event on that channel. So events show in the guide, in search, in On later, in Events (below) and can have reminders like any programme.
- Dates and times are read in many forms: `2026-11-02`, `02/11/2026`, `11/02`, `7 Dec`, `Dec 7th`, `Sat`, `Tomorrow`, `19:45`, `8:20 PM`, `20h45`. With only a weekday or a time, it's the next one (something that started less than 3 hours ago counts as on now). `11/02` is month first with a US time zone and day first otherwise.
- Time zones: `ET`/`EST`/`EDT`, `CT`, `MT`, `PT` (US clocks, whichever the name says), `UK` (London), `CET`/`CEST` (Paris clocks), `GMT`, `UTC`, `BST` (UTC+1) and offsets (`GMT+2`, `+01:00`). With none, the list's own time zone is used: set it in **Admin → Lists → Edit → Time zone of event channels' times** (Xtream Codes lists use the provider's own by default), otherwise the server's.
- Names change every day, so they're read again whenever the list refreshes, and every 15 minutes.
- Channels whose name says nothing is on ("No event streaming", "Off air", or just "PPV 05") say **No event right now**. **Admin → TV guides → Event channels** shows what was found and has **Hide event channels with nothing on from Live TV** (on by default; each viewer can still tick *Show event channels with nothing on*). Turn it off to always list them.
- An event channel keeps its place (number, favourites, your lists, the admin's edits) as its event changes, and two providers' "PPV 3" stay separate channels.

## Following teams and competitions

Each profile can follow teams ("Arsenal", "Kansas City Chiefs", "Lakers") and competitions ("Premier League", "NFL", "Champions League", "UFC", "Formula 1"):

- **Where:** Settings → Teams and competitions (`#/follow`), or **Follow…** on any sports programme or event (in the guide's programme window, and the star in On later). Suggestions come from what's in the guide and on event channels, as you type; short forms and small typos are understood ("Man Utd" is Manchester United, "Arsnal" is Arsenal, "Chiefs" is Kansas City Chiefs). The short forms are a small list in `lib/sports-names.json`. The quick launcher finds them too ("Follow Arsenal", or "Arsenal: their games" once you follow them).
- **Events** on Home (a row you can hide or move with *Customise this page*) and at the top of **On later**: games involving what you follow, live ones first with **Watch**, then the next three days with the time and channel. A game shown on several channels appears once, on the best one you can watch: a channel your profile is allowed, HD first, then your favourites.
- **Automatic reminders** for your teams' games in the next two days (on by default; switch it off on the same page), using the normal reminders. **Switch channel automatically** makes those reminders change channel when the game starts, after a 10-second countdown you can cancel. A reminder you remove isn't added again; unfollowing a team takes its automatic reminders away.
- The guide is indexed once each time it (or a list) changes, not on every request, so this costs nothing while browsing.
- Stored in `data/follow.json`.

## Your channel lists

Under **Live TV → Your lists** (or `#/mychannels`) each profile can:

- put their favourites in their own order;
- make their own lists ("Kids' channels", "Football"…), add channels by name or number, reorder (arrows or drag), rename and delete them;
- choose which list **Live TV** and **the TV guide** open on (or "where I was last time").

The lists appear in Live TV, the guide's channel picker, the channel list in the player and on the phone remote. Any channel page also has **Add to one of your lists**.

## Guide colours

Programmes are coloured by type: sport, film, news, kids, documentary, music and other, with a legend above the guide. The colour is an edge plus a light tint, readable in dark, light and high-contrast themes (high contrast uses the edge only). Untick **Colours** above the guide to turn them off for your profile.

## On later

**On later** (from Live TV, the guide and the home page row "On later today") lists the films and sport in the next 48 hours, by day and type, with sport grouped by league or competition. Tick News or Kids to add those. Tap the bell to set a reminder. A programme shown on several channels appears once, on a favourite channel when there is one.

## Parental locks

- In **Admin → Channels → Parental lock**, set a 4–8 digit PIN. Then lock single channels (Edit → Locked, or select several and **Lock**) or whole categories (choose the category and switch on **Lock this category**).
- Locked channels show a lock and "Locked" in place of what's on. Playing one asks for the PIN; it then unlocks locked channels on that device for 30 minutes. After 5 wrong PINs, the device has to wait 5 minutes.
- Kids profiles can't unlock.
- The server enforces it: locked items are sent without their stream addresses or listings, and playing one without unlocking is refused.
- Locked channels stay in the admin's playlist and guide exports.

## Screen time and bedtime

Any profile except the admin can have screen time limits; they're most useful on Kids profiles.

- In **Admin → Profiles**, open **Screen time** on a profile and switch on **Limit screen time**. Choose rules for *every day the same*, *school days and weekends* (Monday–Friday / Saturday and Sunday) or *each day of the week*. For each: a **daily limit** (or none), the time watching is **allowed from**, and a **bedtime**. Bedtime lasts until the "allowed from" time, or 06:00 if that's empty; a bedtime after midnight (00:30) works too.
- Days and times are in the **server's time zone**. A profile can have its own (for example `Europe/London`), chosen from the **Time zone** list in the same place. **Save limits** saves the screen time together with the profile's other limits.
- **The server counts and enforces it.** Time is counted a minute at a time from what the devices already tell the server while they play (what's playing, the playback reports sent while the picture moves, and conversions on the server). A paused player stops counting after a minute or so. Two devices, a watch party or multiview all count once per minute. When time is up the server refuses to start anything new for that profile, stops its conversions, and tells its devices to stop.
- **Viewers** see how much is left on Home, and in the player when less than 15 minutes are left. They get a warning 5 minutes and 1 minute before the end, then a friendly *That's all for today* (or *Time for bed*) screen.
- **Ask for more time:** on that screen, or on Home near the end, a viewer can ask for 15, 30 or 60 more minutes. The admin gets one pop-up with *Give* / *Not today* on every device they have open (or when they next open the app), and the request also waits in Admin → Profiles. The viewer's screen says the answer.
- **Extra time:** Admin → Profiles → Screen time → *+15 min*, *+30 min* or *+1 hour* for today. If it's bedtime (or nearly), it also lets them watch that much past bedtime. *Back to normal* removes today's extra time.
- The last days' viewing is shown under **Today**.

## Limits

- A channel whose listings come from several guides with different offsets uses the first guide's offset.
- The editor covers TV and radio channels. The server also honours locks on films and series (episodes follow their series), but there's no screen to set those yet; a locked film's page asks for the PIN when you press Play.
- Screen time can't see playback that never asks the server: downloads watched offline, or another app using the profile's Xtream login (Admin → Other apps). Don't give a limited profile an Xtream login.
- Placeholder blocks are named after the channel; the provider's event name is used only when the playlist gives one.
- Channel health checks only playlist and Xtream Codes lists (not MAC portals or media servers), and only live TV channels; radio and portal channels still count from plays. Catch-up plays don't count.
- iptv-org doesn't host guides of its own; its ids are used to link guides you already have (or your own iptv-org grabber). epg.pw has guides for about 20 countries.
- Event channels whose name gives no time get no listings (only the event name). A name with two events lists only the first.
- Following matches names loosely, so a short name shared by two teams ("Spurs") can bring in the other one's games. Games are found in the next three days of listings.
