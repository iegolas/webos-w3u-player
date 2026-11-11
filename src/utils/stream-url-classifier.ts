export type StreamUrlKind = 'media' | 'embed' | 'unknown';

const MEDIA_EXTENSIONS = new Set([
  'm3u8', 'm3u', 'mpd', 'mp4', 'm4v', 'mkv', 'webm', 'ts', 'mov',
  'mp3', 'aac', 'm4a', 'flac', 'ogg', 'avi', 'flv',
]);

// IPTV panels sometimes report the stream type in the query instead of the path.
const MEDIA_OUTPUT = /^(?:m3u8|ts|mp4)$/i;

// Player pages that host a stream rather than serving the media file itself.
const EMBED_MARKERS = ['/videoembed/', '/embed/', '/iframe/', '/player/', '/watch/'];

// `/embed-<token>.html` and the short `/e/<token>`, `/v/<token>` routes.
const EMBED_TOKEN_PATH = /\/embed-[^/]+\.html$|\/[ev]\/[^/]+(?:\/|$)/;

const PAGE_EXTENSIONS = ['.html', '.htm', '.php'];

export function classifyStreamUrl(url: string): StreamUrlKind {
  let parsed: URL;
  let scheme: string;
  try {
    parsed = new URL(url);
    scheme = parsed.protocol.toLowerCase();
  } catch {
    return 'unknown';
  }

  // (a) Only absolute http(s) URLs can be played or opened.
  if (scheme !== 'http:' && scheme !== 'https:') return 'unknown';

  const path = parsed.pathname.toLowerCase();

  // (b) A known media extension beats any player-shaped path around it.
  const extension = /\.([a-z0-9]+)$/.exec(path)?.[1] ?? '';
  if (MEDIA_EXTENSIONS.has(extension)) return 'media';

  // (b) Some panels put the format in the query, e.g. `?output=m3u8`.
  const output = parsed.searchParams.get('output');
  if (output !== null && MEDIA_OUTPUT.test(output)) return 'media';

  // (c) Known embed/player path shapes, then any bare page route.
  if (EMBED_MARKERS.some((marker) => path.indexOf(marker) !== -1)) return 'embed';
  if (EMBED_TOKEN_PATH.test(path)) return 'embed';
  if (PAGE_EXTENSIONS.some((ext) => path.endsWith(ext))) return 'embed';

  // (d) Leave the decision to the caller; do not guess media.
  return 'unknown';
}
