# File inventory (what changed, and why)

Everything relative to upstream `d27beca`. Use this to port the work file by
file onto a newer main.

## New files (16)

| File | Purpose |
| --- | --- |
| `src/parsers/w3u-parser.ts` | W3U parsing, repair, detection, streaming sink; marks every station `w3u-station` so the Library tab cannot be hidden by a metadata-free list |
| `src/parsers/w3u-parser.test.ts` | 36 tests for the above |
| `src/components/w3u-model.ts` | Library model, station kinds, link loader, limits |
| `src/components/w3u-view.ts` | Library view: rail, poster grid, detail, pins |
| `src/components/w3u-model.test.ts`, `w3u-view.test.ts` | model + view tests |
| `css/w3u-view.css` | Library styles, pin chip |
| `src/utils/stream-url-classifier.ts` (+ test) | media / embed / unknown |
| `src/services/browser-launch.ts` (+ test) | open a URL in the TV browser |
| `src/services/embed-resolver.ts` (+ test) | embed page → stream via the service (TV) or the preview bridge; generic extraction + XOR payload decoder |
| `src/app.test.ts` | app-level routing tests (detached play, overlay, Guide) |
| `docs/DEVICE.md` | Developer Mode install for this fork's app id |
| `scripts/hls-proxy.mjs` (+ test) | preview-only HLS relay (`/__hls`): URI rewrite, Referer/Origin, Range |
| `PLAN.md` | early design notes and measured findings (historical) |

## Deleted (1)

| File | Why |
| --- | --- |
| `homebrew-repository.json` | advertised upstream's app id and release URL; a fork must publish its own |

## Modified, by area

### Playlist pipeline (port first)

| File | Change |
| --- | --- |
| `src/parsers/m3u-parser.ts` | `'w3u'` in `PlaylistFormat`; content detection; dispatch in `parseM3U`; `'w3u'` treated as a wrong document by the stream parser |
| `src/parsers/m3u-loader.ts` | streaming branch wrapped in `createW3UStreamSink` |
| `src/types.ts` | `W3uGroupLink`, `PlaylistGroupLink`, `PinnedSelection`, `PinnedLiveGroup`, `ParsedPlaylist.groupLinks` |
| `src/services/idb-cache.ts` (+ test) | playlist payload carries `groupLinks` (optional field) |
| `src/services/playlist-service.ts` (+ test) | group-link aggregation, overlay, pin API, `pinnedLiveGroups`, `unpinLiveGroup`, revisions |
| `src/services/storage-service.ts` (+ test) | `iptv_pinned_linked_groups`, `iptv_show_guide_tab` accessors |
| `src/config.ts` | `CONFIG.W3U.*`: embed hosts, resolver hosts, synopsis limits, `LIVE_LINK_TITLES` budget (the startup loader calls `forEachConcurrent(..., 2, ...)` in `playlist-service.ts`) |
| `src/utils/url.ts` (+ shared `canonicalUrl`) | canonical comparison used by links and pins |

### UI

| File | Change |
| --- | --- |
| `src/app.ts` | W3U section wiring, detached playback, embed resolution **also for indexed/Live playback** (`playChannel`), pin callbacks, overlay load, Guide guards, `epgSources()` |
| `src/components/channel-list.ts` (+ test) | All-list group prefix, Live pin marker + unpin chip, display-text cleaning for group/channel labels |
| `src/components/channel-list-editor.test.ts` | expectations for prefixed rows in edit/favourites modes |
| `src/components/tab-bar.ts` (+ test) | optional Guide section (`setSections(..., showGuide)`) |
| `src/components/settings.ts` (+ test) | playlist-entry focus fix, Show Guide tab row |
| `src/components/player-menu.ts` (+ test) | Guide row hidden while the toggle is off |
| `src/components/icons.ts` | `pinIcon(active)` |
| `index.html`, `css/channel-list.css`, `css/tab-bar.css` | view host, prefix/pin layout, tab sizing |
| `src/i18n/*.ts` (11 locales) | W3U/library/pin/guide/player strings; `w3u.playUnavailable` removed |

### Playback

| File | Change |
| --- | --- |
| `src/components/player.ts` (+ test) | detached `playChannel`, `streamOffline` terminal handling |
| `src/components/player-pipeline.ts` (+ tests) | empty-manifest detection per path, offline token guards |
| `src/components/player-pipeline-webos.test.ts` | harness callback |
| `src/utils/fetch-helper.ts` | reports `empty` for a zero-byte body |
| `src/utils/url.ts` | `canonicalUrl` (also used by the Library) |

### Identity, tooling, packaging

| File | Change |
| --- | --- |
| `appinfo.json` | id `com.w3uplayer`, vendor/title/description |
| `package.json` | version, version lifecycle unchanged |
| `bundled-service/src/services.json` | service id `com.w3uplayer.service` |
| `build.sh` | launch/close by the id declared in `appinfo.json` |
| `scripts/tv-*.mjs` (+ 2 tests), `benchmarks/tv-runner.mjs` | default app id and service log path |
| `e2e/drm-playback.spec.ts`, `luna-playback.spec.ts`, `startup.spec.ts` | renamed ids |
| `docs/storage-and-data.md` | new storage keys documented |

## Integration seams with upstream code

If upstream changes shape, these are the places where our work attaches;
everything else is additive.

1. `parseM3U` / `detectPlaylistFormat` — W3U dispatch.
2. `fetchAndParseM3UInWorker` streaming branch — W3U sink.
3. `PlaylistService.channels` — overlay append + pin API.
4. `Player.play` — extracted path reused by `playChannel`.
5. `TabBar.setSections` — Guide flag.
6. `app.ts` — sections, EPG sources, W3U handlers (largest conflict surface).
