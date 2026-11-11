# Baseline, commits and what each one carries

## Upstream baseline

```
upstream repo   https://github.com/lennylxx/webos-iptv-player
base commit     d27beca  "Gather HTTP header playback into one doc"
upstream tag    1.17.0
license         Apache-2.0 (LICENSE + THIRD_PARTY_NOTICES.txt kept)
clone shape     shallow (--depth 1); run `git fetch --unshallow` before any rebase
```

The fork's `origin` still points at upstream. Pushing this work requires
adding a fork remote; nothing has been pushed.

## Our commits, oldest first

| # | SHA | Subject | Size | Feature area |
| --- | --- | --- | --- | --- |
| 1 | `ce6c63a` | Add W3U playlist support and ok.ru embed playback | 54 files, +3492/−68 | W3U parser, Library view, embed resolve/hand-off, app identity, packaging, first entry-focus fix |
| 2 | `df3a1a2` | Label W3U embed playback and release 1.17.1 | 19 files, +287/−50 | direct/resolvable/browser station kinds, busy state, 1.17.1 |
| 3 | `e3b7475` | Follow linked W3U playlists and play their titles | 29 files, +2289/−92 | group links in parser/cache/service, Library link levels, depth/caps/cycles, detached playback, 1.17.2 |
| 4 | `d6104bb` | Add Live pins, Guide toggle and empty-stream errors | 45 files, +3135/−64 | pins (Library + Live), Live overlay, All-list prefixes, empty-manifest state, Guide toggle, 1.17.3→1.17.5 |

Notes on numbering: the version bumps for 1.17.3, 1.17.4 and 1.17.5 all
landed inside commit 4, because the intermediate bumps were deliberately
left uncommitted while the features were still being tested.

## Commit 1 — W3U arrives (ce6c63a)

- `src/parsers/w3u-parser.ts` + test: tolerant JSON, station mapping,
  group links (recorded later in commit 3), header extraction.
- Dispatch: `detectPlaylistFormat` recognises `w3u`; `parseM3U` and the
  loader's streaming path divert to it (`createW3UStreamSink`).
- `src/components/w3u-model.ts`, `w3u-view.ts`, `css/w3u-view.css`,
  `index.html`, `tab-bar.ts`, `config.ts`: the Library tab, group rail,
  poster grid, detail panel.
- `src/utils/stream-url-classifier.ts`, `src/services/browser-launch.ts`:
  embed-vs-media classification and the TV browser hand-off.
- `src/components/settings.ts` (+ test): fix for the playlist-entry focus
  bug found while testing (URL went into the name field, source silently
  dropped).
- Identity: `appinfo.json`, `bundled-service/src/services.json`,
  `build.sh`, `scripts/tv-*.mjs`, `benchmarks/tv-runner.mjs`,
  `e2e/*.spec.ts` renamed to `com.pablo.w3uplayer[.service]`;
  `homebrew-repository.json` deleted (it advertised upstream's id).
- Docs: `PLAN.md`, `docs/DEVICE.md`.

## Commit 2 — station kinds and labels (df3a1a2)

- `classifyStation` → `direct` / `resolvable` / `browser`; only
  browser-only embeds keep the “Browser” pill and the explanatory note.
- Busy state while a resolvable embed starts; Back cancels it.
- `w3u.starting` and related copy in 11 locales; 1.17.1.

## Commit 3 — linked lists (e3b7475)

- `W3uGroupLink` / `PlaylistGroupLink` in `src/types.ts`.
- Parser records link groups instead of warning them away.
- `idb-cache` persists links with the playlist payload (optional field, no
  schema bump; old entries read as “no links” until the next refresh).
- `PlaylistService.getGroupLinks()` + `groupLinksRevision`.
- `w3u-model.ts` `W3uLinkLoader` and `W3U_LINK_LIMITS`; `w3u-view.ts`
  link levels, breadcrumb, closed-row tags, truncation hint.
- `player.ts` gains a detached-channel entry point; `app.ts` routes titles
  that are not in `PlaylistService.channels`.
- Parser hardening: trailing bytes after the JSON document, empty layout
  entries, continuation backslashes.
- 1.17.2.

## Commit 4 — pins, Live overlay, prefixes, Guide (d6104bb)

- Pins: `PinnedSelection` + storage key `iptv_pinned_linked_groups`
  (canonical URLs, max 50); `PlaylistService.setGroupPinned`,
  `isGroupPinned`, `pinnedSelections`, `pinnedRevision`,
  `unpinLiveGroup`, `pinnedLiveGroups`; session-only overlay of linked
  channels appended after the main list.
- Library: icon-only pin chip (outline/filled), no visible label.
- Live: pin marker and unpin chip on pinned group rows.
- Live All list: `<group> - <name>` prefix when the group has 2+ channels.
- Playback: empty/unusable manifest becomes a terminal state
  (`player.streamOffline`, no reconnect); hls.js, native/Luna, Shaka and
  direct-HLS-VOD detection.
- Guide: `iptv_show_guide_tab`, tab removal, navigation guards, EPG
  download skipped while off, `player-menu` Guide row hidden.
- 1.17.3 → 1.17.5.

## Reproducing the delta

```bash
git log --oneline d27beca..HEAD
git diff --stat d27beca..HEAD
git show --stat <sha>            # per commit
git diff d27beca..HEAD -- src/   # code only
```
