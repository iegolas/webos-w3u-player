# W3U Player for webOS — plan & status

## Goal

An LG webOS TV app that loads **W3U playlists** (Wiseplay's JSON playlist
format) as well as plain **M3U/M3U8**, lets the viewer browse the list by
group, and plays the streams.

## Base: fork of `lennylxx/webos-iptv-player`

Chosen over writing from scratch and over `ZUI-WebOS/ZUI-IPTV-Player` because
it already solves the parts that are expensive and webOS-specific:

| Already solved upstream | Why it matters for W3U |
| --- | --- |
| M3U/M3U8 parser, dedup, multi-source, per-source enable/disable | W3U lists coexist with M3U lists |
| HLS (`hls.js`) + native `com.webos.media` + DASH/Shaka pipelines, per-stream escalation chain | W3U mixes `.m3u8`, `.mp4`, `.mkv` |
| **HTTP header playback**: Referer / User-Agent / Cookie via Luna or the on-device proxy | W3U's `referer`/`userAgent` per station are exactly this problem |
| Search, recently watched, favourites, parental PIN, EPG/XMLTV, i18n, themes | Feature parity without rebuilding |
| Chromium 53 compatibility gate (webOS 4 floor), esbuild, IPK packaging, CI | Runs on old TVs, not just current ones |
| 500+ files and a real test suite (vitest + Playwright) | Regression safety while we add W3U |

Upstream is **Apache-2.0**: the fork keeps `LICENSE` + `THIRD_PARTY_NOTICES.txt`
and records changes. This tree now ships as **W3U Player**
(`com.pablo.w3uplayer`, vendor `Pablo`), so any redistribution must keep the
upstream Apache-2.0 `LICENSE` and `THIRD_PARTY_NOTICES.txt` and credit
`lennylxx/webos-iptv-player`.

## What W3U actually is (measured, not assumed)

- JSON, **not** M3U text. Groups → `stations`, plus optional top-level
  `stations`.
- Per station: `name`, `image`, `info`, `url`, `referer`, `userAgent`,
  `online`, `isHost`, `subtitle`, `imageScale`, `embed`.
- Files in the wild are often **invalid JSON**: raw newlines inside strings and
  trailing commas. Rejecting them would drop most real lists.
- Extension lies: the sample is served as `list.w3u#.m3u` while containing JSON, so
  detection must be content-based.
- Two structures the sample exposed after the first pass:
  - **Nested folders.** A group may carry `groups` instead of `stations`, where
    each child is a *reference* to another playlist (`url` + `import` flag).
    Today those children are not loaded: the folder appears with no stations.
    Supporting it means lazy-loading a sub-list on open (Phase 3+).
  - **Placeholder headers.** `userAgent: "navigator"` means "use the player's
    own agent", not a literal header value. The parser ignores it.

## Implemented in this fork

- `src/parsers/w3u-parser.ts` — tolerant repair (`repairW3UJson`) + parse into
  the app's existing `ParsedPlaylist`/`Channel` model:
  - groups and top-level stations → channels, `group` = W3U group name;
  - `image` → `logo`, `info`/`isHost`/`online`/`embed`/`subtitle` →
    `sourceAttributes['w3u-*']`;
  - `referer` / `userAgent` → `httpHeaders` **and** legacy `extras`
    (`http-referrer`, `http-user-agent`) so both playback paths see them;
  - list `name`/`author`/`contact`/`info` → `headerAttributes['w3u-*']`;
  - array-of-lists documents merged; unusable stations reported as issues.
- `src/types.ts` — `PlaylistFormat` gains `'w3u'`.
- `src/parsers/m3u-parser.ts` — content sniff (`isW3UDocument`) dispatches W3U
  before the M3U stream parser; `detectPlaylistFormat` reports `w3u`; W3U is
  not treated as a "wrong document", so URL sources and the worker path load it.
- `src/parsers/w3u-parser.test.ts` — 14 tests (headers mapping, groups,
  top-level stations, array form, repair, invalid JSON, missing URL, dispatch).

### Evidence

```
npx vitest run src/parsers/w3u-parser.test.ts   → 14 passed
npm run typecheck                               → clean
npm run lint (stylelint + eslint Chrome53 gate)  → clean
```

A real 3,417-line / 150 KB playlist sampled during development:

```
detected: w3u, parse 18 ms, 11 groups, 310 channels, 0 issues
149 channels carry a `Referer`/`User-Agent` header (8 more declared only the
`navigator` placeholder and are dropped)
```
(upstream requires Node ≥ 22 for vitest 5; this machine needed Node 22.22.3)

## Known gap that decides the scope

Most entries in the sample list are **hosted HTML embed pages**, not media:
URLs whose path is a player page (`/videoembed/…`, `/embed-….html`, `/e/…`)
instead of a manifest or file. The base app can send the `Referer`, but it
cannot turn an HTML embed page into a playable manifest. Direct-media entries
(`.m3u8`, `.mp4`, `.mkv`, including public-archive and broadcaster URLs) play
today.

So: Phase 1 is a genuinely working player for direct streams; embed-host
resolution is a separate, brittle, per-host workstream (and a ToS question).

## Phases

1. **Load & browse (mostly done)** — W3U import by URL/file, groups as
   categories, posters as logos, existing player. Remaining: UI copy that says
   "M3U" where it now means "playlist", and group-name whitespace cleanup.
2. **W3U-native detail view** — poster grid per group, `w3u-info` synopsis,
   `imageScale`, station flags. UI/UX work.
3. **Playability** — per-station probe result (playable / embed / dead),
   media-probe badge, "open in browser" fallback where possible.
4. **Optional** — embed resolvers (most common host first), EPG, favourites/filters.

## Constraints to keep in mind

- webOS 4 (Chromium 53) is the floor: no modern APIs in new code; the lint gate
  enforces it.
- `Referer`/`User-Agent` playback needs Settings → Advanced → HTTP headers
  (Media service default, Local proxy for the rest). Document it for users.
- LG TV deployment needs Developer Mode (`ares` CLI, `@webos-tools/cli`) or
  store partnership; nothing is installed here yet.
- Embedded subtitle tracks in MKV remain unsupported by the platform.

## Validation

```bash
npm run typecheck && npm run lint
npx vitest run src/parsers/w3u-parser.test.ts
npm run build && ./build.sh --install <device>   # needs a TV in dev mode
```

## Deployment

The fork builds as its own app: `npm run build` bundles into `dist/`, and
`npm run package` (= `bash build.sh`) lints, type-checks, builds the bundled
service, and runs `ares-package` to produce
`com.pablo.w3uplayer_<version>_all.ipk` plus its manifest in the repo root.
The version comes only from `package.json`; `esbuild.config.mjs` copies it
into `appinfo.json` at build time, so it is never hand-edited.

Installing needs an LG TV in Developer Mode (free LG developer account, Dev
Mode Status ON, TV and Mac on the same network) and the `ares-*` tools from
`@webos-tools/cli`. Register the TV with `ares-setup-device` and approve it
with `ares-novacom --getkey`; `docs/DEVICE.md` has the exact commands, the
Developer Mode session-expiry procedure, and the `ares-install` /
`ares-inspect` debugging steps. After every install, close and relaunch the
app — `build.sh --install` does that cold restart — because webOS otherwise
resumes the old suspended bundle. Redistribution keeps the Apache-2.0
`LICENSE` / `THIRD_PARTY_NOTICES.txt` and upstream attribution. The upstream
Homebrew Channel listing (`homebrew-repository.json`) was removed: it only
advertised upstream's id and releases, so re-add a fork-owned listing once
this repo has its own release URL.


## Status snapshot

Working today, verified in a real browser at 1920x1080 against a live W3U list:

- W3U loaded by URL through the normal playlist pipeline (streaming sniff,
  tolerant JSON repair), 309 channels after the app's URL dedupe (the list has
  one duplicate entry), 10 groups.
- New **Library** section: group rail, poster grid, detail screen with cleaned
  title, genres from the category line, synopsis, and Play vs "Open in TV
  browser", with the matching pill on embed-only posters.
- `openInBrowser` hands embed entries to `com.webos.app.browser`; a failed or
  off-TV launch shows a toast instead of claiming success.
- Gates: `tsc`, `eslint` + stylelint compat gate, 4009 unit tests, esbuild
  Chromium-53 gate, IPK packaging (`com.pablo.w3uplayer_1.17.0_all.ipk`, 788 KB).

Still open:

1. **Device install** on the TV (Developer Mode pairing) - `docs/DEVICE.md`.
2. **Translations** for the 7 new strings were written per-locale without the
   `ui-copy` glossary/native review; treat them as draft.
3. **E2E** (`npm run test:e2e`) was not run: the local Playwright browser build
   does not match the version the suite pins.
4. Group-name cleanup is Library-only; the Live list still shows raw names.
5. Nested W3U folders (group entries that link to another list) are reported as
   `w3u-group-link-unsupported` and need lazy sub-list loading.

## Embed resolution (ok.ru)

Measured in the sample list: 158 of 310 stations are ok.ru embeds, 24 are direct
media, the rest are other embed hosts.

- The embed page cannot be fetched by the app (no CORS header), but the bundled
  service can: `fetchManifestViaService` is a bounded plain GET whose response
  text is not content-type restricted.
- The page carries a `data-options` attribute holding HTML-escaped JSON; after
  decoding, `flashvars.metadata.hlsManifestUrl` is a ready HLS master playlist
  and `flashvars.metadata.videos[]` holds MP4 variants (first lowest, last
  highest).
- Those media URLs play without extra headers (verified `200 application/x-mpegURL`
  and `206 video/mp4`), so only the *page fetch* needs the header/proxy path.
- webOS 4 (Node 0.12.2) can reach the page: its CA store predates the current
  chain, but the service fetch already sets `rejectUnauthorized = false`, and a
  0.12.2 client returned `200 text/html` with the metadata present.
- Desktop preview cannot resolve embeds: no Luna service, and the page is
  CORS-blocked. The handoff to the TV browser remains the desktop behaviour.
