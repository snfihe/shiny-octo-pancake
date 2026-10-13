# What this build changes

A personal build of [lolPing](https://github.com/darrenprx/lolPing), based on upstream `main` as of 2026-10-12 (v0.5.1
plus one commit). It keeps upstream's version string, `0.5.1`, so nothing about it looks newer than the release it came
from.

Two features were added, and automatic update checks were turned off so an official release cannot install over them.

## 1. The wheel's slice count is configurable

Upstream draws both wheels with exactly 8 slices. Here a wheel's slice count is the length of its array, so the
geometry, the hit test, the overlay and the settings editor all follow whatever that length is.

- The settings window gets a **Wheel slots** row above each wheel editor: 4, 6, 8 or 10 for the ping wheel (the ping
  pool holds 11), and every even count from 4 to 24 for the emote wheel (44 bundled emotes, plus up to 24 imported).
- Only even counts are offered: the pale petals beyond the ring sit on every other slice, which only reads as compass
  points at an even count.
- Growing the wheel fills the new slices with the first items that are not on it yet; shrinking drops the last slices.
  **Reset to default** goes back to League's 8.
- Icons shrink as slices crowd the ring (`iconSizeFor`), so 24 slices do not overlap: 48 px at 8 slices, 46 at 16, 31
  at 24.
- The compass names (N, NE, E, …) only read correctly at 8 slices, so any other count numbers its slices instead.

## 2. Friends' imported emotes travel through a room

Upstream sends only a custom emote's content hash and never the image, so every imported emote showed as a "?" to the
rest of the room. This implements the *M2: custom stills travel* milestone from upstream's own design document
(`docs/superpowers/specs/2026-10-06-emotes-design.md` §8.2), which was specified for v0.5.1 but never written.

- A presence now announces the hashes it can serve: every custom emote on the wheel and in the centre, up to 25.
- A member that lacks an announced image asks for it (`want`), and its owner serves it in 750-byte `chunk` messages.
  Seventeen chunks cover the 12,288-byte still cap; the chunk size is what fits in a sealed packet's remaining room
  once base64 is applied.
- Received chunks are assembled out of order, duplicates ignored, and a still is only written to the cache after the
  bytes hash to the id the room announced, start with `RIFF….WEBP`, are not animated, and are at most 160 px.
  `lolping://emotes/<hash>.webp` then serves it, so the overlay needs no changes.
- Chunks are only accepted from the member that announced that hash, so nobody can hand out an image under someone
  else's id.
- Stills travel; animations never do. A friend's emote always shows as a still.
- Cache: `%APPDATA%\lolPing\emote-cache`, at most 200 files and 4 MB, evicted by least recent use.
- **Show friends' custom emotes** (Room section, on by default) turns all of it off: no request goes out, chunks are
  ignored, and friends' custom emotes are shown as nothing at all — not even the placeholder.
- Rate limits, because public relays start dropping events past a few per second: 20 chunks/s per requester on the LAN,
  and on relays a chunk only goes out while at least 5 of the 10-token burst would remain, so pings are never queued
  behind an image. An idle sender streams roughly one image every 6 seconds over relays.
- `tools/room-peer --emote <file.webp>` announces and serves an image, which is how this was verified on one computer.

## 3. Automatic updates are off

`normalizeSettings` pins `autoUpdateCheck` to false, so no official release can replace this build and take the two
features above with it. Checking by hand from the About section still works, and the switch in the settings window shows
as off. Set `autoUpdateCheck: true` in the settings file to let official updates through again.

## Verification

- `npm test`: 762 tests pass (44 new: protocol validation, chunk transfer, cache eviction, and an in-process room
  round trip).
- `npm run typecheck`: clean.
- End to end on the LAN with two peers: a 160×120 WebP announced by `tools/room-peer` landed in `emote-cache` under its
  own hash, byte for byte identical to the file that was served.

## Known limits

- A relay sender streams about one image every 6 seconds while pings keep flowing; the first seconds of a large emote
  can arrive after the emote itself has been shown.
- The cache holds 200 images; beyond that the least recently used ones are dropped and re-fetched on demand.
- The 25-hash announcement budget is what fits in one 1200-byte presence packet. A wheel larger than 24 slices would
  need a different fetch mechanism, not a larger number.

## Rebuilding

Requires Node 20+, and Visual Studio 2022 or later with the "Desktop development with C++" workload for the native
input helper.

```
npm ci
npm run build:helper
npx electron-vite build
npx electron-builder --win --publish never
```

Two notes for a Chinese Windows (code page 936):

- `npm run dist` stops in `build:helper`'s test target: `cl /WX` turns the C4819 warning in `macinput.cpp` into an
  error. `hook-helper.exe` itself is built by then, so run the two commands above instead of `npm run dist`.
- `npm run build` must run after any source change and before packaging: `electron-builder` packages `out/`, so
  packaging without rebuilding ships the previous code.

Behind a slow or filtered connection to GitHub, electron's binary and electron-builder's NSIS binaries need mirrors:

```
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

npm 12 blocks install scripts, so `node_modules/electron/dist` may be missing after `npm ci`; `node
node_modules/electron/install.js` fetches it.

## Licence

MIT, as upstream. `LICENSE` is unchanged. lolPing is by darrenprx; this build is a modification of it.
