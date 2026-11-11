# Playback: embeds, detached channels, empty streams, Guide toggle

## What upstream already gave us (do not re-solve)

Header-gated streams (Referer / User-Agent / Cookie) are handled upstream by
an escalation chain: `<video>` → Luna media service → on-device proxy, with
`docs/http-header-playback.md` describing it. W3U feeds that chain by mapping
`referer` / `userAgent` onto `httpHeaders`; nothing new was needed there.

## Embed vs media classification

`src/utils/stream-url-classifier.ts` — pure, host-agnostic:

1. non-http(s) or unparseable → `unknown`;
2. known media extension on the path, or `?output=m3u8|ts|mp4` → `media`;
3. player-shaped paths (`/videoembed/`, `/embed/`, `/embed-<t>.html`,
   `/iframe/`, `/player/`, `/watch/`, `/e/<id>`, `/v/<id>`, `.html/.htm/.php`)
   → `embed`;
4. otherwise `unknown` (the caller decides; no guessing).

`classifyStation()` combines this with the configured host list to produce
`direct` / `resolvable` / `browser`.

## Embed resolution

Only hosts in `CONFIG.W3U.RESOLVABLE_EMBED_HOSTS` (currently the ok.ru video
host) are attempted; everything else is `unsupported_host` and never fetched.

```
page URL → fetchManifestViaService(pageUrl, { Referer: origin, User-Agent: TV UA })
         → HTML → first data-options attribute → HTML-entity decode → JSON.parse
         → flashvars.metadata.hlsManifestUrl   (preferred)
           or last entry of flashvars.metadata.videos[]  (MP4 fallback)
         → play that URL with the origin as Referer
```

Why through the service: the embed page sends no CORS header, so the app's
own `fetch` is blocked; the bundled webOS service does a bounded plain GET
(512 KiB, 10 s, `rejectUnauthorized = false`) and returns text. On webOS 4
(Node 0.12.2) that reaches the host — verified — so this is not a webOS 5+
feature. On desktop there is no Luna service and the resolver returns
`unavailable`; the UI falls back to the TV browser hand-off.

Cache: in-memory per page URL, capped at 10 minutes and never beyond the
signed URL's `expires`. Nothing persisted.

## Browser hand-off

`src/services/browser-launch.ts` normalises the URL and calls
`luna://com.webos.applicationManager`/`launch` with
`{ id: 'com.webos.app.browser', params: { target } }`. Fire-and-forget: no
retries, no navigation-result claims; off-TV it resolves `false` and the UI
shows “Could not open the TV browser.” Failure reasons are logged without
the URL.

## Detached channels

Titles from a linked playlist are not in `PlaylistService.channels`, so
`Player` gained a channel-object entry point beside the indexed one:

```ts
Player.play(channelIndex, catchup?, scope?, preview?, source?) // unchanged
Player.playChannel(channel, catchup?, source?)                 // detached
```

Detached playback uses index `-1`, keeps the resolved source for retries and
reconnects, and makes channel up/down a no-op — there is no list to step
through. Back returns to the Library. Indexed playback keeps its old path.

## Empty and unusable streams

An empty HLS manifest (HTTP 200, `content-length: 0`) used to look like any
other failure: generic error, reconnect, advance. It is now terminal.

| Path | Signal used |
| --- | --- |
| hls.js | `levelEmptyError`, `levelParsingError`, `manifestParsingError`, or `MANIFEST_PARSED` with zero levels → `stopLoad()` |
| native `<video>` / Luna | the per-load manifest read already done for track names reports an empty body / no `#EXTINF` and no `#EXT-X-STREAM-INF` |
| Shaka (DASH) | `UNABLE_TO_GUESS_MANIFEST_TYPE`, `DASH_INVALID_XML`, `DASH_NO_SEGMENT_INFO`, `DASH_EMPTY_ADAPTATION_SET`, `DASH_EMPTY_PERIOD` |
| Direct HLS VOD | one bounded `fetchLimitedText` probe per tune (not per channel) |

Behaviour: `Player.streamOffline` marks the tune terminal; the pipeline
blocks `escalate()`, `advance()` and the Luna fallback; the OSD shows
**“This stream is offline (empty playlist).”**, then the channel advances
after the normal short delay. VOD uses the existing failure flow.

## Guide tab toggle

| Item | Value |
| --- | --- |
| Setting | `iptv_show_guide_tab`, default on; `getShowGuideTab` / `setShowGuideTab` |
| UI | Settings → Appearance → “Show Guide tab” |
| Off | tab removed (not hidden by CSS), active section falls back to Live, `showView('epg')` / `switchSection('epg')` / `openEpg()` redirect, red-button shortcut inert, player-menu Guide row hidden |
| EPG data | downloads skipped, in-memory guide reset, refresh timer stopped; IndexedDB cache kept |
| On | tab restored, guide reloaded from cache and refreshed, timer restarted — no restart |

Consequence, accepted deliberately: while the toggle is off there is no
now-playing text in the channel list, no programme results in Search, and no
programme titles in the OSD, because those all read EPG data. The hint says
so. If that changes, `epgSources()` in `app.ts` is the single place to
decouple “hide the tab” from “stop downloading”.

## Tests

`stream-url-classifier.test.ts`, `browser-launch.test.ts`,
`embed-resolver.test.ts`, `player.test.ts`, `player-pipeline.test.ts`,
`player-pipeline-webos.test.ts`, `player-menu.test.ts`
plus the Guide-toggle cases in `tab-bar.test.ts`, `settings.test.ts`,
`storage-service.test.ts`, `app.test.ts`.
