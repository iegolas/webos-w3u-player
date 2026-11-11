# Live overlay, pins, and the All-list prefix

## Model

Live is fed exclusively by `PlaylistService.channels`, which is index
addressed (`getByIndex`, `indexOf`) and drives playback, favourites,
recently-watched and search. Pinned linked-list channels are therefore
merged **into that array**, not shown by a parallel list.

Rules:

- Overlay channels append **after** the customized main list, so main
  channel indexes never move when a list arrives, is replaced or removed.
- Overlay channels carry synthetic `playlistIds` of the form `link:<hash>`;
  they are session-only and never written to the playlist cache.
- Dedupe is by `channelKey`, first against main channels, then against
  earlier overlay entries.
- Group naming: the pinned group's cleaned name. If that collides with a
  real or custom group, the service appends ` 2`, ` 3`, … instead of
  merging two different lists under one heading.
- `reset()` clears the overlay and the mapping.

## Nothing loads unless pinned

There is no background loading of unpinned links. With no pins, Live shows
only the playlist's own channels (5 for the measured hub). This was an
explicit product decision after an earlier auto-loading attempt was
rejected.

## Pins: persistence and policy

| Item | Value |
| --- | --- |
| Storage key | `iptv_pinned_linked_groups` |
| Shape | `{ url, group, name, pinnedAt }[]`, `group: ''` = whole list |
| URL form | canonicalised (lowercase scheme+host, fragment dropped) |
| Cap | 50 selections, newest kept |
| Titles | **never stored** — re-fetched on startup so expiring stream URLs are not reused |

## Service API

```ts
PlaylistService.isGroupPinned(url, group): boolean
PlaylistService.setGroupPinned({ url, group, name, depth }, pinned)
  → Promise<{ ok: true; channels: number } | { ok: false; reason: PinnedLinkReason }>
PlaylistService.pinnedSelections(): PinnedSelection[]
PlaylistService.pinnedLiveGroups(): PinnedLiveGroup[]   // { group, url, groupKey, name }
PlaylistService.unpinLiveGroup(group): Promise<boolean>
PlaylistService.pinnedRevision: number
PlaylistService.takePinnedLinkNotices()
```

`depth` is the list's level below the Library root (1–3). Rejection reasons:
`invalid`, `depth`, `budget`, `limit`, `fetch_failed`, `group_missing`,
`canceled`, `storage`.

`pinnedLiveGroups()` exists because Live group names are not selection
names: collisions are suffixed, and a whole-list pin expands into one entry
per source group. It is rebuilt from the channels actually rendered, so it
cannot drift from Live.

## Lifecycle

- Pin → fetch the list if not loaded (concurrency ≤ 2 on startup), then add
  only the pinned group (or every group for a whole-list pin).
- Unpin → remove the overlay entry and invalidate an in-flight fetch.
- A pinned group that vanished from its list → notice + selection removed.
- Budget: `CONFIG.W3U.LIVE_LINK_TITLES` (3,000) across pins; the pin is
  rejected rather than partially loaded.
- Whole-list pin: unpinning any of its groups removes the whole selection,
  and the UI says so afterwards.

## Library and Live controls

Both are icon-only (outline pin = not added, filled pin = added, spinner =
working). No visible text; `aria-label`, `aria-pressed`, `aria-busy` carry
the meaning. Library: the chip sits under the row name. Live: a filled pin
marks a pinned group, and Right on the row reaches the unpin chip
(`data-key` `gp:source:<group>`); OK unpins, Left/Back returns.

Pins changed in the Library are reflected in Live because the group list
re-reads `pinnedRevision` on render.

## All-list prefix

In the Live **All** category only, rows render `<group> - <channel name>`
when that group holds 2 or more channels (single-channel groups stay bare).
Group sizes come from `PlaylistService.getByGroup(...).length`, cached per
render. It is a display concern:

- the player OSD, logo placeholder, favourites, search, group views and
  edit/favourites-management modes keep the raw name;
- `data-key`, row order and list positions are unchanged;
- `aria-label` on prefixed rows reads the composed label;
- uncategorised channels keep the bare name.

## Tests

`playlist-service.test.ts` (overlay, dedupe, collisions, stable indexes,
index playback, pins, budget/depth, mapping, unpin), `channel-list.test.ts`
(prefix, pin marker, unpin chip, revision refresh), `w3u-view.test.ts`
(Library chip), `storage-service.test.ts` (persistence, malformed data,
cap), `app.test.ts` (startup loading, Library callback).
