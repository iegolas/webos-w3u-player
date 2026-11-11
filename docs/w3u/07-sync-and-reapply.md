# Syncing with upstream, and re-applying this work

The goal: keep following `main` upstream without losing the W3U work, and be
able to port individual features if a straight rebase is not worth it.

## Keep the clone usable

```bash
git remote -v                       # origin still points at upstream
git rev-parse --is-shallow-repository   # this clone is shallow
git fetch --unshallow               # do this once before any rebase
git fetch origin main
```

Recommended tracking model:

- keep `main` = upstream, untouched (`git branch -u origin/main main`);
- keep this work on a branch (currently `w3u-xuper`) with our four commits;
- optionally tag the released state (`git tag w3u-1.17.5`) so an artifact can
  always be traced back.

## Option A — rebase our commits (default)

```bash
git fetch origin main
git rebase origin/main            # from the w3u branch
```

Expect conflicts, in this order of likelihood:

| File | Why it conflicts |
| --- | --- |
| `src/app.ts` | largest surface: sections, EPG, W3U handlers, player routing |
| `src/i18n/*.ts` | 11 files, all appending keys at the end |
| `src/services/playlist-service.ts` | overlay + pin API inserted into load/refresh paths |
| `src/components/channel-list.ts` | group prefix and pin chips in the row renderer |
| `src/components/player.ts` / `player-pipeline.ts` | extracted play path, offline guards |
| `src/parsers/m3u-parser.ts` / `m3u-loader.ts` | dispatch points |
| `appinfo.json`, `build.sh`, `bundled-service/src/services.json`, `scripts/tv-*` | identity rename |
| `src/types.ts`, `src/config.ts` | additive, small hunks |

Conflict policy that has worked here:

- **Take upstream's logic, then re-add ours as a call**: in `app.ts` and
  `playlist-service.ts`, prefer upstream's control flow and re-attach the
  W3U branch at the same seam listed in `06-file-inventory.md`.
- **i18n**: keep upstream's block intact and append our keys; then run the
  i18n tests to prove key parity across locales.
- **Identity**: never accept upstream's `com.lennylxx.*` ids back; re-check
  with `grep -rn "com.lennylxx" --include='*.ts' --include='*.mjs'
  --include='*.json' . | grep -v node_modules`.

## Option B — cherry-pick feature by feature

Our commits are already feature-shaped:

```bash
git cherry-pick ce6c63a   # W3U parser + Library + embeds + identity
git cherry-pick df3a1a2   # station kinds + labels
git cherry-pick e3b7475   # linked lists + detached playback
git cherry-pick d6104bb   # pins, Live overlay, prefixes, Guide, empty stream
```

If a commit is too large for the new base, split by the seams:

1. parser + detection (`02-w3u-format-and-parser.md`)
2. Library + link loading (`03-library-link-loading.md`)
3. overlay + pins (`04-live-overlay-and-pins.md`)
4. playback diagnostics + Guide toggle (`05-playback-and-guide.md`)
5. identity/packaging (only when the fork is re-published)

## Option C — start from the new main and re-apply manually

Use `06-file-inventory.md` as the checklist: create the 16 new files, then
apply the modified-file hunks area by area. This is the safest route when
upstream has refactored `app.ts` or the playlist service.

## Verification after any port

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"   # vitest 5 needs Node 22
npm run typecheck
npm run lint                 # stylelint + eslint Chromium-53 gate
npm test                     # full unit suite
npm run build                # esbuild compat gate for app/worker/Shaka
npm run package              # IPK + Homebrew manifest
```

Behavioural spot checks that unit tests cannot cover:

1. Load a W3U hub: Library shows link rows, self-link tagged “Already open”.
2. Open a linked list, go to depth 3: “Limit reached” rows, Back unwinds one
   level per press.
3. Pin one group: Live gains exactly that group; unpin from Live removes it.
4. Play a title from a linked list: OSD shows the channel, Back returns to
   the Library.
5. An empty-manifest URL shows “This stream is offline (empty playlist).”
   and advances without reconnecting.
6. Guide toggle off: tab gone, no guide downloads, re-enable restores it.

## Known debt to pick up when convenient

- `groupLinks` is an optional field in the playlist cache; an entry written
  before this feature reads as “no links” until the next refresh. Consider a
  cache-format token so upgrades invalidate it explicitly.
- `W3U_LINK_LIMITS` lives in `w3u-model.ts` while the overlay budget lives in
  `CONFIG.W3U`; consolidating both in `CONFIG` would make tuning one place.
- The generated Homebrew manifest still points `sourceUrl` / `iconUri` at
  upstream; fix before publishing under this fork's name.
- Translations for the new strings are drafts (11 locales), written without
  the glossary/native review step.
- `npm run test:e2e` has not been run in this environment (Playwright browser
  version mismatch), and nothing has been exercised on a TV except manual
  desktop preview runs.
