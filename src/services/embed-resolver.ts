import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { classifyStreamUrl } from '../utils/stream-url-classifier';
import { isLunaAvailable } from './luna';
import { fetchManifestViaService, type ServiceManifestResult } from './manifest-service';

const MAX_PAGE_BYTES = 512 * 1024;
const PAGE_TIMEOUT_MS = 10 * 1000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ARRAY_ENTRIES = 20 * 1000;
const BRIDGE_PATH = '/__embed';
const HLS_PROXY_PATH = '/__hls';

const log = createLogger('Embed');

// The page carries its player state as HTML-escaped JSON in this attribute.
const DATA_OPTIONS = /\bdata-options="([^"]*)"/;
const ENTITY = /&(?:quot|amp|#x27|#39|lt|gt|nbsp);/gi;
const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&amp;': '&',
  '&#x27;': "'",
  '&#39;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
};

// An absolute media URL in markup, JSON, or inline script. The path is the
// only part checked for the extension, so a query string cannot fake it.
const ABSOLUTE_MEDIA = /https?:\/\/[^\s"'<>()\\]+\.(?:m3u8|mp4)(?:\?[^\s"'<>()\\]*)?/gi;

// `file:`, `src:`, and `url:` values in inline script, quoted or as JSON keys.
const RELATIVE_MEDIA =
  /(?:^|[^\w$])(?:"(?:file|src|url)"|file|src|url)\s*:\s*(['"])([^'"]+?\.(?:m3u8|mp4)(?:\?[^'"]*)?)\1/gi;

type MediaKind = 'hls' | 'file';
type MediaCandidate = { url: string; kind: MediaKind };

type EmbedVariant = { name?: unknown; url?: unknown };

type EmbedMetadata = {
  hlsManifestUrl?: unknown;
  videos?: unknown;
};

interface EmbedOptions {
  flashvars?: { metadata?: unknown };
}

interface BridgePayload {
  ok?: unknown;
  status?: unknown;
  url?: unknown;
  text?: unknown;
  reason?: unknown;
}

export type EmbedResolveFailureReason =
  | 'unavailable'
  | 'unsupported_host'
  | 'fetch_failed'
  | 'no_metadata'
  | 'aborted'
  | 'invalid'
  | `http_${number}`;

export type EmbedResolveResult =
  | {
      ok: true;
      url: string;
      kind: MediaKind;
      headers: Record<string, string>;
      expiresAt: number;
    }
  | { ok: false; reason: EmbedResolveFailureReason };

export interface EmbedResolveOptions {
  signal?: AbortSignal;
}

type ResolvedStream = Extract<EmbedResolveResult, { ok: true }>;

interface CacheEntry {
  result: ResolvedStream;
  cacheUntil: number;
}

const cache = new Map<string, CacheEntry>();

// The service sends no User-Agent of its own, and some hosts refuse a request
// without one, so send the TV's unless the station declared its own.
function defaultUserAgent(): string {
  return typeof navigator !== 'undefined' ? navigator.userAgent : '';
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** True when the page URL belongs to a host this resolver knows how to read. */
export function isResolvableEmbedHost(
  pageUrl: string,
  hosts: readonly string[] = CONFIG.W3U.RESOLVABLE_EMBED_HOSTS,
): boolean {
  const host = hostOf(pageUrl);
  if (!host) return false;
  return hosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

function decodeEntities(value: string): string {
  return value.replace(ENTITY, (entity) => ENTITIES[entity.toLowerCase()] ?? entity);
}

function absoluteHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname
      ? trimmed
      : null;
  } catch {
    return null;
  }
}

function kindOf(url: string): MediaKind | null {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith('.m3u8')) return 'hls';
    if (path.endsWith('.mp4')) return 'file';
  } catch {
    // Not a usable URL.
  }
  return null;
}

function metadataOf(text: string): EmbedMetadata | null {
  const match = DATA_OPTIONS.exec(text);
  if (!match) return null;
  let parsed: EmbedOptions;
  try {
    parsed = JSON.parse(decodeEntities(match[1])) as EmbedOptions;
  } catch {
    return null;
  }
  const flashvars = parsed?.flashvars;
  const metadata: unknown = flashvars?.metadata;
  return metadata && typeof metadata === 'object' ? metadata as EmbedMetadata : null;
}

function lastVideoUrl(metadata: EmbedMetadata): string | null {
  const videos = metadata.videos;
  if (!Array.isArray(videos) || !videos.length) return null;
  const last = videos[videos.length - 1] as EmbedVariant;
  return absoluteHttpUrl(last?.url);
}

// The host-specific `data-options` payload is only trusted on its own host.
function structuredCandidate(pageUrl: string, text: string): MediaCandidate | null {
  if (!isResolvableEmbedHost(pageUrl)) return null;
  const metadata = metadataOf(text);
  if (!metadata) return null;
  const hls = absoluteHttpUrl(metadata.hlsManifestUrl);
  if (hls) return { url: hls, kind: 'hls' };
  const file = lastVideoUrl(metadata);
  return file ? { url: file, kind: 'file' } : null;
}

// Escaped slashes (`https:\/\/`) and HTML entities are common in inline JSON.
function normalizedText(text: string): string {
  return decodeEntities(text).replace(/\\\//g, '/');
}

function findAbsoluteMedia(text: string): MediaCandidate | null {
  let firstFile: string | null = null;
  ABSOLUTE_MEDIA.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ABSOLUTE_MEDIA.exec(text))) {
    const url = absoluteHttpUrl(match[0].replace(/[,;]+$/, ''));
    const kind = url ? kindOf(url) : null;
    if (!url || !kind) continue;
    if (kind === 'hls') return { url, kind };
    if (!firstFile) firstFile = url;
  }
  return firstFile ? { url: firstFile, kind: 'file' } : null;
}

// Decodes `_ls2` with `_qf7` and `_sj3`; the script's own `eval` is never run.
function decodeObfuscated(text: string): string | null {
  const array = /_ls2\s*=\s*\[([^[\]]*)\]/.exec(text);
  const xor = /_qf7\s*=\s*(-?\d{1,9})\b/.exec(text);
  const shift = /_sj3\s*=\s*(-?\d{1,9})\b/.exec(text);
  if (!array || !xor || !shift) return null;

  const parts = array[1].split(',');
  if (!parts.length || parts.length > MAX_ARRAY_ENTRIES) return null;
  const values: number[] = [];
  for (const part of parts) {
    const value = part.trim();
    if (!/^-?\d{1,4}$/.test(value)) return null;
    values.push(Number(value));
  }

  const key = Number(xor[1]);
  const offset = Number(shift[1]);
  let decoded = '';
  for (const value of values) {
    decoded += String.fromCharCode((((value ^ key) - offset) % 256 + 256) % 256);
  }
  return decoded || null;
}

function resolveMediaUrl(value: string, base: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const direct = absoluteHttpUrl(trimmed);
  if (direct) return direct;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  try {
    return absoluteHttpUrl(new URL(trimmed, base).href);
  } catch {
    return null;
  }
}

function findRelativeMedia(text: string, base: string): MediaCandidate | null {
  let firstFile: MediaCandidate | null = null;
  RELATIVE_MEDIA.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RELATIVE_MEDIA.exec(text))) {
    const url = resolveMediaUrl(match[2], base);
    const kind = url ? kindOf(url) : null;
    if (!url || !kind) continue;
    if (kind === 'hls') return { url, kind };
    if (!firstFile) firstFile = { url, kind };
  }
  return firstFile;
}

function genericCandidate(text: string, base: string): MediaCandidate | null {
  const normalized = normalizedText(text);
  const absolute = findAbsoluteMedia(normalized);
  if (absolute) return absolute;
  const decoded = decodeObfuscated(text);
  if (decoded) {
    const obfuscated = findAbsoluteMedia(normalizedText(decoded));
    if (obfuscated) return obfuscated;
  }
  return findRelativeMedia(normalized, base);
}

// A CDN that signs its URLs says when they stop working; otherwise a short
// cache keeps a repeated Play from refetching the page.
function expiresAtFromUrl(url: string, now: number): number {
  try {
    const raw = new URL(url).searchParams.get('expires');
    const parsed = raw === null ? NaN : Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch {
    // Fall through to the default.
  }
  return now + CACHE_TTL_MS;
}

function fetchFailureReason(reason: string): EmbedResolveFailureReason {
  if (reason === 'aborted' || reason === 'unavailable' || reason === 'invalid') return reason;
  return /^http_\d+$/.test(reason) ? reason as EmbedResolveFailureReason : 'fetch_failed';
}

function bridgeFailureReason(reason: unknown): EmbedResolveFailureReason {
  if (typeof reason === 'string' && /^http_\d+$/.test(reason)) {
    return reason as EmbedResolveFailureReason;
  }
  return reason === 'aborted' ? 'aborted' : 'unavailable';
}

function cacheHit(pageUrl: string, now: number): EmbedResolveResult | null {
  const entry = cache.get(pageUrl);
  if (!entry) return null;
  if (entry.cacheUntil <= now) {
    cache.delete(pageUrl);
    return null;
  }
  return { ...entry.result, headers: { ...entry.result.headers } };
}

function remember(pageUrl: string, result: ResolvedStream, now: number): void {
  const cacheUntil = Math.min(result.expiresAt, now + CACHE_TTL_MS);
  if (cacheUntil <= now) return;
  cache.set(pageUrl, { result, cacheUntil });
}

// The CDN needs only the embed origin as Referer; the station's own headers
// (a User-Agent, a Cookie) stay as the playlist declared them.
function playbackHeaders(headers: Record<string, string>, origin: string): Record<string, string> {
  const out: Record<string, string> = { Referer: `${origin}/` };
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'referer' || lower === 'referrer') continue;
    out[name] = headers[name];
  }
  return out;
}

function previewOrigin(): string | null {
  try {
    return typeof location !== 'undefined' && location.origin ? location.origin : null;
  } catch {
    return null;
  }
}

// Preview-only: page JS cannot set Referer, so the dev server's /__hls proxy
// fetches the stream with the embed page's origin. TV playback stays direct.
function previewStreamUrl(streamUrl: string, pageUrl: string): string {
  const query = `u=${encodeURIComponent(streamUrl)}`;
  const referer = originOf(pageUrl);
  return referer
    ? `${HLS_PROXY_PATH}?${query}&r=${encodeURIComponent(referer)}`
    : `${HLS_PROXY_PATH}?${query}`;
}

// The preview has no Luna service, so its dev server fetches the page and
// returns the same shape the service does. It cannot carry channel headers.
async function fetchPageViaBridge(
  pageUrl: string,
  options: EmbedResolveOptions,
): Promise<ServiceManifestResult> {
  const signal = options.signal;
  const origin = previewOrigin();
  if (!origin || typeof fetch !== 'function') return { ok: false, reason: 'unavailable' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const target = `${origin}${BRIDGE_PATH}?url=${encodeURIComponent(pageUrl)}`;
    const response = await fetch(target, { method: 'GET', signal: controller.signal });
    const body = await response.text();
    let payload: BridgePayload;
    try {
      payload = JSON.parse(body) as BridgePayload;
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (payload.ok === true && typeof payload.status === 'number'
        && typeof payload.url === 'string' && payload.url
        && typeof payload.text === 'string') {
      if (payload.text.length > MAX_PAGE_BYTES) return { ok: false, reason: 'unavailable' };
      return { ok: true, status: payload.status, url: payload.url, text: payload.text };
    }
    if (signal?.aborted) return { ok: false, reason: 'aborted' };
    return { ok: false, reason: bridgeFailureReason(payload.reason) };
  } catch {
    return { ok: false, reason: signal?.aborted ? 'aborted' : 'unavailable' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function fetchPage(
  pageUrl: string,
  headers: Record<string, string>,
  options: EmbedResolveOptions,
  viaBridge: boolean,
): Promise<ServiceManifestResult> {
  if (viaBridge) return fetchPageViaBridge(pageUrl, options);
  try {
    return await fetchManifestViaService(pageUrl, {
      Referer: `${originOf(pageUrl)}/`,
      'User-Agent': defaultUserAgent(),
      ...headers,
    }, {
      maxBytes: MAX_PAGE_BYTES,
      timeoutMs: PAGE_TIMEOUT_MS,
      graceMs: CONFIG.PLAYER.MANIFEST_SERVICE_GRACE_MS,
      signal: options.signal,
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

function failed(pageUrl: string, reason: EmbedResolveFailureReason): EmbedResolveResult {
  log.warn(
    'Embed resolve failed',
    'event=embed.resolve.failed',
    `reason=${reason}`,
    `host=${hostOf(pageUrl) || 'unknown'}`,
  );
  return { ok: false, reason };
}

/**
 * Reads an embed page through the bundled service (TV) or the preview's dev
 * bridge and returns the stream it advertises: the direct URL on TV, or a
 * preview-only /__hls proxy URL when there is no Luna service. Never rejects;
 * a page that is not an embed never reaches the network, and a resolved URL is
 * cached only while it is still valid.
 */
export async function resolveEmbedStream(
  pageUrl: string,
  headers: Record<string, string>,
  options: EmbedResolveOptions = {},
): Promise<EmbedResolveResult> {
  const cached = cacheHit(pageUrl, Date.now());
  if (cached) return cached;
  if (!isResolvableEmbedHost(pageUrl) && classifyStreamUrl(pageUrl) !== 'embed') {
    return failed(pageUrl, 'unsupported_host');
  }
  const signal = options.signal;
  if (signal?.aborted) return failed(pageUrl, 'aborted');

  const origin = originOf(pageUrl);
  const bridge = !isLunaAvailable();
  const response = await fetchPage(pageUrl, headers, options, bridge);
  if (!response.ok) return failed(pageUrl, fetchFailureReason(response.reason));
  if (signal?.aborted) return failed(pageUrl, 'aborted');

  const base = absoluteHttpUrl(response.url) ?? pageUrl;
  const candidate = structuredCandidate(pageUrl, response.text)
    ?? genericCandidate(response.text, base);
  if (!candidate) return failed(pageUrl, 'no_metadata');

  const result: ResolvedStream = {
    ok: true,
    url: bridge ? previewStreamUrl(candidate.url, pageUrl) : candidate.url,
    kind: candidate.kind,
    headers: bridge ? {} : playbackHeaders(headers, origin),
    expiresAt: expiresAtFromUrl(candidate.url, Date.now()),
  };
  remember(pageUrl, result, Date.now());
  log.info(
    'Embed resolved',
    'event=embed.resolved',
    `kind=${candidate.kind}`,
    `host=${hostOf(pageUrl)}`,
  );
  return result;
}
