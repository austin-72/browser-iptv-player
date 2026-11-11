# TV apps

Three small apps that put the player on a TV's home screen. Each one does a single thing: it asks once for your
server's address, remembers it, and opens it full screen. Everything you see after that is the server's own pages,
the same as in the TV's browser, so there is nothing else to keep up to date here.

What you gain over the TV's browser: an icon on the home screen, no address bar, the remote's Back button handled by
the app (Back at Home, twice, leaves), and on Samsung the coloured, number and media buttons.

> **Not tried on real TVs.** These were written from each platform's documentation and checked as far as that goes
> without the hardware: the page that asks for the address was run in a desktop browser, and nothing here was
> installed on a television. Expect to fix small things. Reports are welcome.

| Folder | For | You need |
|---|---|---|
| `android/` | Android TV, Google TV, Fire TV (also phones and tablets) | Android Studio, or the *Android TV app* workflow on GitHub |
| `tizen/` | Samsung TVs (2016 and later) | Tizen Studio and the TV in developer mode |
| `webos/` | LG TVs (webOS 3 and later) | LG's webOS CLI and the Developer Mode app on the TV |

There is no Roku app. Roku doesn't run web pages: an app there has to be written again from nothing in Roku's own
language, which is a second player to maintain, not a wrapper. Apple TV is the same story.

## Changing the server's address

- **Samsung and LG:** when the app starts it says *Opening …* for three seconds. Press **Up** then.
- **Android TV and Fire TV:** press **Menu** on the remote, or hold **Back**.

## Android TV, Google TV, Fire TV

A plain Android project with one screen and no libraries.

**With GitHub (no tools on your computer):** on your copy of this repository, open *Actions* → *Android TV app* →
*Run workflow*. When it finishes, download `iptv-player-tv` from the run's page and unzip it: that is the APK.

**With Android Studio:** open the `android` folder, let it sync, then *Build → Build APK(s)*.

Put it on the TV:

- Fire TV: Settings → My Fire TV → Developer options → turn on *Apps from Unknown Sources* (or *Install unknown
  apps* for the app you'll install with), then send the APK over with the *Downloader* app or `adb install`.
- Android TV / Google TV: turn on developer options (Settings → System → About → press *Build* seven times), allow
  installing unknown apps for your file manager, and open the APK, or use `adb install`.

The APK is signed with a debug key. One built on GitHub is signed with a different key each time, so to install a
newer build over an older one, remove the old one first (the address is all it remembers).

## Samsung (Tizen)

1. Install [Tizen Studio](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html)
   with the TV extensions, and create a Samsung certificate in its Certificate Manager.
2. On the TV: Apps → press 1 2 3 4 5 on the remote → Developer mode **On**, with your computer's IP address. Restart the TV.
3. In Tizen Studio: *File → New → Tizen Project → Template → TV → Web Application → Basic Project*. Then replace the
   files it made (`index.html`, `config.xml`, the `css` and `js` folders, the icon) with the ones in `tizen/`.
   Keep the package id Tizen Studio put in its own `config.xml`: copy it into the two `AbCdEfGhIj` places.
4. Connect to the TV in *Device Manager* (Remote Device Manager → the TV's IP), then right-click the project →
   *Run As → Tizen Web Application*.

An app installed this way stays on the TV; Samsung's developer certificates are tied to the TVs you registered.

## LG (webOS)

1. Install the [webOS CLI](https://webostv.developer.lge.com/develop/tools/cli-installation) (`npm install -g @webos-tools/cli`).
2. On the TV: install the **Developer Mode** app from the LG Content Store, sign in with an LG developer account,
   turn Dev Mode on and restart. Turn on *Key Server* in that app.
3. On your computer, from this folder:

   ```
   ares-setup-device            (add: a name such as tv, the TV's IP address, port 9922, user prisoner)
   ares-novacom --device tv --getkey      (asks for the passphrase shown in the Developer Mode app)
   ares-package webos
   ares-install --device tv org.iptvplayer.tv_1.0.0_all.ipk
   ```

LG's developer mode lasts a limited time. The Developer Mode app shows how long is left and has an *Extend* button;
when the time runs out, apps installed this way are removed. That is LG's rule for apps that aren't in its store.

## What's in them

`tizen/` and `webos/` share the same three files (`index.html`, `app.css`, `app.js`: the page that asks for the
address) plus each platform's own description file and icons. `android/` is `MainActivity.java`, a manifest, the
icons and three Gradle files.

The server's pages already know these TVs (`web/js/tv.js`, `web/js/keymap.js`, `web/js/compat.js`): arrow-key
navigation, the Back key, Samsung's remote buttons. Back at Home, pressed twice, leaves the app (`V.leaveApp` in
`web/js/tv.js`).
