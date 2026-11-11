# Bundled libraries

The players and the in-browser converter in `public/vendor` are other projects' released files, kept here so the app
needs nothing fetched at run time. This page says exactly which release each one is, so it's known when one needs
updating — check it against the project's releases and security advisories now and then.

| File | Library | Version | Licence | Taken from |
|---|---|---|---|---|
| `hls.min.js` | hls.js | 1.6.19 | Apache-2.0 | `dist/hls.min.js`, unchanged — https://registry.npmjs.org/hls.js/-/hls.js-1.6.19.tgz |
| `mpegts.js` | mpegts.js | 1.8.2 | Apache-2.0 | `dist/mpegts.js`, unchanged — https://registry.npmjs.org/mpegts.js/-/mpegts.js-1.8.2.tgz |
| `shaka-player.compiled.js` | shaka-player | 4.16.54 | Apache-2.0 | `dist/shaka-player.compiled.js`, unchanged — https://registry.npmjs.org/shaka-player/-/shaka-player-4.16.54.tgz |
| `mediabunny.module.js` | mediabunny | 1.61.6 | MPL-2.0 | `dist/bundles/mediabunny.min.mjs`, unchanged (renamed) — https://registry.npmjs.org/mediabunny/-/mediabunny-1.61.6.tgz |
| `mediabunny-ac3.module.js` | @mediabunny/ac3 | 1.61.6 | MPL-2.0 | `dist/bundles/mediabunny-ac3.min.mjs` with one change: its three `from"mediabunny"` imports point at `./mediabunny.module.js` — https://registry.npmjs.org/@mediabunny/ac3/-/ac3-1.61.6.tgz |
| `mediabunny-loader.module.js` | (this project) | – | MIT | five lines that load the two files above |

## Checksums (SHA-256)

`npm test` checks the files against these (`test/vendor.test.js`), so a file that changes without this page changing
is caught.

```
72b87a6e58db623feca73ab370970c1126ec06eb3dcd0a67fd14b47b6340b820  hls.min.js
bda31748736a69cb610c2edf4623e633f1f4f47b5bda83668c8d287e51b0c3a8  mpegts.js
f54522fb5adc1cf9a945609a75c89b93a82b240452455577012a6f67e6c395a7  shaka-player.compiled.js
cc6f1f3d5e09758eafc15f7c2712439be3f2e25c301d096b11405a2f78a96e8f  mediabunny.module.js
e584a7f574922185945207a344ca1081e21955cf7994dcf3909bcdcc66c210ca  mediabunny-ac3.module.js
0819ad5f1f18d355d6b28cbe66b7ea3ea1ebee8a191d783ca8a0a72b7018d3e3  mediabunny-loader.module.js
```

## Updating one

1. Get the new release from npm (`npm pack hls.js@<version>`, say) and copy the file named above over the one here —
   for the AC-3 decoder, make the one change again.
2. Put the new version and checksum (`sha256sum public/vendor/<file>`) on this page.
3. Play something each way that library is used (Admin → Statistics shows which ways are in use) before releasing.

Each library's licence text is next to it in `public/vendor`.
