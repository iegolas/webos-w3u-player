# Library and linked-list loading

## Why this exists

A real W3U list is often a **hub**: it holds a handful of stations and dozens
of groups whose only content is a `url` pointing at another playlist. One
measured list: 26 groups, 4 with stations (5–6 titles), 20 usable links.
Following those links to depth 3 reaches 760 lists and about 74,800 titles.

Loading that eagerly is impossible on a TV, so the Library loads on demand.

## Data path

```
W3U document
  └─ parseW3U                     → channels + groupLinks[]
       └─ PlaylistService.load    → channels indexed; links cached with the payload
            ├─ getGroupLinks()    → PlaylistGroupLink[] (deduped by URL, owner playlist ids)
            └─ groupLinksRevision → UI change signal
```

`PlaylistGroupLink` = `{ name, image, url, parentGroup?, playlistIds, playlistId }`.
Links live in the IndexedDB playlist cache as an **optional** field: entries
written before this feature read as “no links” and are refreshed on the next
cycle (no schema bump, no data loss).

## Library model

`src/components/w3u-model.ts` holds the presentation model:

- `buildW3uLibrary(channels, links, rootUrls)` → root level of groups and
  links.
- `classifyStation()` → `direct` | `resolvable` | `browser` (see 05).
- `W3uLinkLoader` — fetches one link at a time, caches results,
  `abort()` invalidates in-flight work through a generation counter.
- `W3U_LINK_LIMITS`:

```ts
TIMEOUT_MS 20000   MAX_STATIONS 1000   MAX_TOTAL_STATIONS 2500
MAX_DEPTH 3        CACHE_ENTRIES 8
```

`MAX_DEPTH` counts **fetched lists**: root → 1 → 2 → 3. A list at depth 3
still loads; its own links render as closed rows tagged “Limit reached”.

## Rules the view enforces

| Rule | Behaviour |
| --- | --- |
| Lazy | Nothing is fetched when the Library opens; only a selection loads |
| One fetch | A generation counter cancels the previous request on Back or on another selection |
| Cache | 8 lists, LRU, session-only |
| Canonical URLs | Comparison uses lowercase scheme+host, fragment dropped, **path and query kept** (query can carry credentials) |
| Path cycle | A URL already on the current navigation path is tagged “Already open” and never fetched |
| Depth | At the limit, links are shown but labelled instead of dead buttons |
| Truncation | “Showing N of M titles.” above the grid when a cap applies |
| Credentials | `get.php?username=…` style links are never rendered or logged; only the host can appear as a row name |
| Failure | Network/CORS and parse failures each get their own panel, never an empty grid |

Navigation unwinds one level per Back: detail → titles → rail → previous
list → Live.

## Measured behaviour of the caps

Simulation over the real hub graph (caps on, real paths):

| Metric | Value |
| --- | --- |
| Lists reachable within 3 hops | 760 (683 loaded, 77 failed) |
| Lists cut by the 1,000/list cap | 10 (aggregators of 1,600–12,300 titles) |
| Lists cut by the 2,500/path cap | 0 |
| Depth-3 lists fully shown | 573 / 573 |

So the per-list cap is the only one that bites in practice; the path budget
almost never does, because most ancestors are link-only lists with few
channels. Raising the per-list cap mainly helps the handful of aggregator
lists, at a real memory cost on a TV.

The 77 failures are upstream conditions — HTTP 403/429 from portal
playlists, timeouts, or hosts without CORS headers — not a cap problem.

## Tests

`src/components/w3u-model.test.ts`, `src/components/w3u-view.test.ts`,
`src/services/playlist-service.test.ts`, `src/services/idb-cache.test.ts`.
They cover link parsing/persistence, dedupe, enable/disable lifecycle,
depth, cycles, abort, cache reuse, caps, and the failure panels.
