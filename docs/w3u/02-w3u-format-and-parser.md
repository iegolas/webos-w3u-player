# W3U format and the parser

## What the format is

W3U is a JSON playlist format used by a third-party player. One document is
a list:

```json
{
  "name": "List name",
  "author": "author",
  "image": "https://…/logo.png",
  "url": "…self reference…",
  "info": "free text",
  "groups": [
    {
      "name": "Group",
      "image": "…",
      "stations": [
        {
          "name": "Station",
          "image": "…",
          "url": "…stream or embed page…",
          "info": "synopsis / categories",
          "referer": "…",
          "userAgent": "…",
          "online": "true",
          "isHost": true,
          "embed": true,
          "subtitle": "…",
          "imageScale": "centerCrop"
        }
      ]
    },
    { "name": "Linked list", "image": "…", "url": "…another playlist…" }
  ],
  "stations": [ { "name": "Loose station", "url": "…" } ]
}
```

Key points that matter to us:

- A station is either a **media URL** (`.m3u8`, `.mp4`, …) or a **page URL**
  (an embed player). Nothing in the format says which.
- A group may hold `stations`, **or** only a `url` — a pointer to another
  playlist. Those pointers are how “hubs” are built, and they nest.
- `groups` may nest inside a group.
- `referer` / `userAgent` are per-station playback headers.

## Reality of the files in the wild

Measured on real lists during development:

| Defect | Frequency seen | Handling |
| --- | --- | --- |
| Raw newlines / tabs inside strings | very common | escaped by the repair pass |
| Trailing comma before `}` or `]` | common | dropped |
| Bytes after the closing brace (duplicated `}`) | occasional | first complete JSON value is used |
| Backslash before a raw newline | occasional | turned into a valid escape |
| `{}` and `{"text-align": "center"}` as layout spacers | common in big lists | skipped silently, not reported |
| `userAgent: "navigator"` meaning “player's own” | seen | treated as undeclared, never sent as a header |
| Extension lies (`list.w3u#.m3u`, `.db` serving JSON) | seen | detection is content-based, never by extension |
| Header values containing CR/LF | theoretically | dropped, same rule as the M3U path |

## Parser contract

`src/parsers/w3u-parser.ts` exports:

```ts
isW3UDocument(input): boolean          // cheap structural sniff, requires "groups"/"stations": [
detectW3UFormat(input): PlaylistFormatDetection | null
parseW3U(input, sourceUrl?, options?): ParsedPlaylist
repairW3UJson(input): string           // pure, exposed for tests
createW3UStreamSink(passThrough, sourceUrl, options): { write(text), finish() }
```

`ParsedPlaylist` is the upstream shape, so nothing downstream varies by
format: `channels`, `groups`, `headerAttributes`, `issues`, `format: 'w3u'`,
plus our optional `groupLinks`.

### Mapping

| W3U | `Channel` |
| --- | --- |
| `name` | `name` (falls back to the URL tail) |
| `image` | `logo` |
| group `name` | `group` (uncategorised when absent) |
| `url` | `url` |
| `referer` / `referrer` / `http-referrer` | `httpHeaders.Referer` + `extras['http-referrer']` |
| `userAgent` / `user-agent` / `http-user-agent` | `httpHeaders['User-Agent']` + `extras['http-user-agent']` |
| `info`, `online`, `isHost`, `embed`, `subtitle`, `imageScale`, `image` | `sourceAttributes['w3u-*']` |
| list `name`/`author` / `image` / `contact` / `info` / `url` | `headerAttributes['w3u-*']` |
| group with `url` and no usable stations | `groupLinks[]` (`W3uGroupLink`) |

Why headers go to both `httpHeaders` and `extras`: the playback pipeline
reads parsed headers first and falls back to the legacy VLC-style extras.
Writing both keeps every path (Luna, proxy, legacy) consistent.

### Limits and safety

- `MAX_ENTRIES` 20,000 per document, `MAX_ISSUES` 200, `MAX_DEPTH` 4 for
  nested `groups`; truncation is reported once.
- `maxChannels: 0` matches the M3U semantics (0 = unlimited), because the
  loader passes the option through unchanged.
- Header values are validated (`/[\r\n\0]/` rejected); a header that cannot
  be sent is dropped rather than injected.
- Every failure is an issue, never an exception: an unparseable document
  yields an empty playlist plus `w3u-invalid-json` at `error` level.

## Where W3U plugs into upstream code

Two integration points, both in upstream files:

1. `src/parsers/m3u-parser.ts`
   - `detectPlaylistFormat()` returns `'w3u'` before the generic JSON branch;
   - `parseM3U()` diverts to `parseW3U()` when `isW3UDocument(input)`;
   - `isWrongDocumentFormat()` includes `'w3u'` as defence: if any caller
     bypasses the dispatch, the stream parser fails cleanly instead of
     emitting JSON lines as channel URLs.

2. `src/parsers/m3u-loader.ts`
   - the streaming branch (the normal path on a TV) feeds `M3UStreamParser`
     directly, so it wraps the sink: `createW3UStreamSink(passThrough, url)`
     holds the first chunk until the shape is known, then buffers the whole
     document for `parseW3U` or passes M3U text through untouched.

If upstream restructures loading, port these two points first; the rest of
the parser is self-contained.

## Tests

`src/parsers/w3u-parser.test.ts` (36 tests) covers mapping, headers,
placeholder values, groups/links, cycles, trailing bytes, layout entries,
limits, detection and the streaming sink. Upstream's own
`m3u-parser.test.ts` / `m3u-loader.test.ts` remain unchanged and must keep
passing — they are the regression guard for the dispatch.
