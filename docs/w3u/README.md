# W3U work on top of upstream `webos-iptv-player`

Everything this fork adds to the upstream player, written so that a future
main-branch update can be rebased onto without re-discovering it.

**Baseline:** upstream `lennllxx/webos-iptv-player`, commit `d27beca`,
version `1.17.0` (Apache-2.0).
**This tree:** `w3u-xuper`, version `1.17.5`, app id `com.w3uplayer`.
**Delta:** 4 commits, 76 files, ~9,000 added lines.

| Document | Read it when |
| --- | --- |
| [01-baseline-and-commits.md](01-baseline-and-commits.md) | You need the commit map, or to cherry-pick a single feature |
| [02-w3u-format-and-parser.md](02-w3u-format-and-parser.md) | You touch `src/parsers/**`, or a real list fails to load |
| [03-library-link-loading.md](03-library-link-loading.md) | You change the Library, linked lists, depth or caps |
| [04-live-overlay-and-pins.md](04-live-overlay-and-pins.md) | You change the Live tab, pins or the overlay |
| [05-playback-and-guide.md](05-playback-and-guide.md) | You touch playback, embeds, or the Guide toggle |
| [06-file-inventory.md](06-file-inventory.md) | You are porting the work file by file |
| [07-sync-and-reapply.md](07-sync-and-reapply.md) | You rebase onto a newer upstream and need conflict guidance |

## The four features in one paragraph each

1. **W3U playlists.** Upstream reads M3U/M3U8, Xtream and XMLTV. W3U is a
   third-party JSON playlist format: groups of stations, each with artwork,
   synopsis and its own playback headers. The parser repairs the malformed
   JSON found in the wild and maps stations onto the existing `Channel`
   model, so nothing downstream needed a new player.

2. **Linked lists.** Real W3U lists are *hubs*: most groups carry only a
   `url` pointing at another playlist (W3U, M3U or plain text). Those
   pointers are now first-class data, are loaded lazily from the Library,
   capped by depth, and protected against cycles.

3. **Live overlay and pins.** A viewer can pin a group (or a whole linked
   list) from the Library so its channels also appear in Live as their own
   group, and unpin from either tab. The selection persists; the channels
   never do.

4. **Playback diagnostics and Guide toggle.** Embed pages on a configured
   host are resolved to a direct HLS/MP4 stream through the bundled webOS
   service; other embeds hand off to the TV browser. An empty or unusable
   manifest is reported as its own state instead of being retried. A
   Settings toggle hides the Guide tab and stops guide downloads.

## Ground rules this fork inherits (from upstream `AGENTS.md`)

- Chromium 53 is the floor (webOS 4). `npm run lint` and the build's compat
  gate are hard gates; never raise the esbuild target casually.
- Render through `morph()` + the `html` template; interpolate untrusted
  playlist text only through `html`.
- Tests and docs use synthetic identifiers (`http://host/a`, `ch1`), never
  real channels, hosts or brands. Production host lists live only in
  `src/config.ts`.
- Version comes from `package.json`; `appinfo.json` is synced by the build.
- Commit only on request, with the message approved first.

## Quick verification of the whole delta

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"   # vitest 5 needs Node 22
git fetch origin --unshallow        # this clone is shallow
git diff --stat origin/main..HEAD
npm run typecheck && npm run lint && npm test
npm run build && npm run package
```
