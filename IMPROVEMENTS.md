# The top 100

This is the list of improvements planned for version 2, and what became of each.
✅ done · ◐ partly done (see note) · ✗ decided against (see note)

## Playback that just works
1. ✅ Direct-first playback. The browser connects straight to the provider, and the server only steps in when it has to.
2. ✅ Getting around CORS while staying direct:
   - the server checks each provider the way the browser would;
   - then it picks the built-in player, the provider's HLS copy, or "playlist via the server, video direct";
   - a full relay is only the last resort;
   - an optional desktop browser helper makes every stream direct.
3. ✅ On-the-fly conversion with ffmpeg:
   - repackage when only the container is wrong (fast);
   - transcode when the codec is wrong.
4. ✅ Codec detection before playing. AC-3/E-AC-3/DTS audio, HEVC, MPEG-2 and interlaced video go straight to conversion instead of failing.
5. ✅ A video that plays sound but no picture counts as a failure, so the next method is tried.
6. ✅ Every source type:
   - streaming formats: HLS, DASH, MPEG-TS;
   - files: MP4, MKV, AVI, WebM;
   - protocols: RTMP, RTSP, UDP/RTP, SRT;
   - audio streams;
   - `file://` paths and server folders.
7. ✅ Adaptive bitrate: hls.js/Shaka switch levels, and server transcodes offer a quality ladder.
8. ✅ Backup sources. When the same title appears in several lists, any copy takes over if the first one fails.
9. ✅ Remember per source which playback method worked.
10. ✅ Clear error messages that name the real cause, such as "provider said 403" or "codec not supported".
11. ✅ Hardware transcoding (VAAPI, QSV, NVENC, VideoToolbox) with a software fallback.
12. ✅ A limit on simultaneous transcodes; the admin can see and stop running conversions.
13. ✅ DRM: ClearKey, plus Widevine/PlayReady where the browser supports it.
14. ✅ Catch-up / timeshift for channels that support it (all common URL formats).
15. ✅ Automatic reconnect when a live stream stalls or the network comes back.

## Profiles & accounts
16. ✅ Netflix-style "Who's watching?" screen.
17. ✅ 142 original profile pictures in 7 categories.
18. ✅ Unlimited profiles.
19. ✅ The first profile is the only admin and must have a PIN; admin can be handed over.
20. ✅ The admin can manage, restrict or delete profiles and reset PINs.
21. ✅ The admin can choose who may add profiles.
22. ✅ Optional PIN per profile, remembered for 30 min per device, with a lockout after wrong guesses.
23. ✅ A site password before anything else. The default can be changed by the admin.
24. ✅ Nothing is revealed before sign-in: no brand, no profiles, no lists, no app code.
25. ✅ Sign-in rate limiting and hashed secrets (scrypt).
26. ✅ CSRF protection, plus a host allowlist while the default password is still in use.
27. ✅ The admin sees every signed-in device and can sign any of them out.

## Lists & library
28. ✅ The admin configures every list; users never type URLs.
29. ✅ M3U/M3U8 links and uploads, gzip, and any text encoding.
30. ✅ Xtream Codes accounts (API, with an M3U fallback).
31. ✅ Folders of the server's own video files.
32. ✅ Every list is merged and deduplicated server-side.
33. ✅ Scheduled list refresh, plus manual refresh and reorder.
34. ✅ Series detection: episodes are grouped into shows and seasons.
35. ✅ Series episodes from Xtream load lazily (fast start with huge lists).
36. ✅ Compact, cached catalogue sent per profile (gzip + ETag + IndexedDB).
37. ✅ Export the merged list and guide to other apps with a secret link.

## Languages & content
38. ✅ The admin sets default languages; everything else is hidden.
39. ✅ Each profile can choose any combination of languages.
40. ✅ Language detection from tags, groups, country codes and name prefixes, for 100+ languages.
41. ✅ Option to show or hide titles whose language is unknown.
42. ✅ Hidden categories site-wide and per profile.

## Parental controls
43. ✅ Kids profiles get a kids-only catalogue.
44. ✅ Age limit per profile, mapped from US, UK and EU ratings.
45. ✅ Adult content is hidden unless explicitly allowed.
46. ✅ Per-profile limits by type (live / movies / series / radio) and category.
47. ✅ A PIN protects grown-up profiles from kids.

## TV guide
48. ✅ XMLTV guides (auto-discovered from lists, or added by hand), gzip supported.
49. ✅ Guide matched by ID and by name.
50. ✅ A fast, virtualised grid guide for thousands of channels.
51. ✅ Now/next on channel cards and in the player.
52. ✅ Reminders for upcoming programmes.
53. ✅ Guide search.

## Discovery & recommendations
54. ✅ Continue-watching row with progress bars; finished titles drop off.
55. ✅ Next-episode logic, so a series continues where you are.
56. ✅ Recommendations that blend everything the profile has ever watched and rated.
57. ✅ Similar titles from an online movie database:
   - TMDB, used instead of IMDb because IMDb has no public API;
   - fetched per title and blended into the recommendations.
58. ✅ Recommendations saved on disk per profile and refreshed in the background.
59. ✅ "Because you watched …" rows and genre rows.
60. ✅ Variety in the results, and titles you keep skipping are pushed down.
61. ✅ "Popular in your household" row.
62. ✅ Mood chips ("Something funny", "Edge of my seat" …).
63. ✅ Posters, plots, cast, genres and ratings filled in from TMDB.
64. ✅ Instant, typo-tolerant search, recent searches and voice search.
65. ✅ Thumbs up/down and "Not interested".

## Player
66. ✅ Speed 0.25–3×, frame step, 10 s / 60 s skips.
67. ✅ Seek-bar preview thumbnails.
68. ✅ Subtitles: in the stream or in the file (converted on the server), with an adjustable style.
69. ✅ Choice of audio track, including switching tracks during conversion.
70. ✅ Skip intro and skip credits:
   - detected by comparing the audio of episodes in a season;
   - also uses chapters;
   - can be marked manually for one episode or a whole season.
71. ✅ Autoplay next episode with a countdown.
72. ✅ Bookmarks with notes.
73. ✅ Mini player while browsing.
74. ✅ Picture-in-picture, fullscreen, media keys and lock-screen controls.
75. ✅ Live: channel numbers, zap up/down, previous channel, channel list and info card.
76. ✅ Gestures on phones: double-tap the sides to skip, and swipe to change channel on live TV. Brightness and colour can be adjusted in the menu.
77. ✅ Stream info overlay (playback method used, resolution, codecs, bitrate, bandwidth, dropped frames).

## Social
78. ✅ Messaging between profiles, updated in real time.
79. ✅ Send a show, film or channel in a message (optionally at a timestamp).
80. ✅ Reactions and an unread badge.
81. ✅ Watch parties: play, pause and seek in sync, with drift correction, chat, emoji reactions and invites.
82. ✅ Shared watchlists edited by several profiles.
83. ✅ Recommend a title to several people (or everyone) at once.
84. ✅ "Watching now" presence.

## Devices & continuity
85. ✅ Phone, tablet and desktop layouts.
86. ✅ TV mode: remote-friendly focus, arrow navigation and the Back key.
87. ✅ Progress syncs instantly between devices.
88. ✅ Handoff:
   - send what you're watching to another signed-in screen;
   - or pick it up there.
89. ✅ Casting: Chromecast, AirPlay and the Remote Playback API (needs https).
90. ✅ Installable as an app (PWA) with offline mode.
91. ✅ Offline downloads:
   - inside the app, converted to MP4 when needed;
   - with a queue and auto-delete when watched;
   - a plain "Save file" download is also available.
92. ✅ Works on older smart-TV browsers (no modern-only JavaScript).

## Personalisation & look
93. ✅ 25 themes with live previews, including OLED, high contrast and light themes.
94. ✅ Home screen rows can be hidden, pinned and reordered per profile.
95. ✅ Accent colour, text size and reduced motion.
96. ✅ The admin can change the brand name, logo and accent, so the release is unbranded.

## Running it
97. ✅ Docker image and Compose file (ffmpeg included, non-root, health check).
98. ✅ https built in, or behind Caddy / Tailscale / nginx (`TRUST_PROXY`).
99. ✅ One-click backup and restore of everything.
100. ✅ Admin overview: counts, who's watching, running conversions and server health.

## Decided against
- ✗ **Scraping IMDb.** Their terms forbid it and there is no free API; TMDB does the same job.
- ✗ **Decrypting DRM on the server.** That is not legal for most streams; the browser's own DRM is used instead.
- ✗ **Downloading live TV for offline viewing.** Recording would need a DVR scheduler; downloads are for films and episodes.
- ✗ **Native apps for Roku/tvOS.** The web app works in TV browsers, and Chromecast/AirPlay cover the rest.
- ◐ **Uploading your own subtitle files.** Subtitles in the stream or file work. Separate .srt uploads are a good next step.
