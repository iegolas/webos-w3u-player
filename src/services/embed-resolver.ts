import { CONFIG } from '../config';
import { fetchManifestViaService, type ServiceManifestResult } from './manifest-service';

const MAX_PAGE_BYTES = 512 * 1024;
const PAGE_TIMEOUT_MS = 10 * 1000;
const CACHE_TTL_MS = 10 * 60 * 1000;

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

type EmbedVariant = { name?: unknown; url?: unknown };

type EmbedMetadata = {
  hlsManifestUrl?: unknown;
  videos?: unknown;
};

interface EmbedOptions {
  flashvars?: { metadata?: unknown };
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
      kind: 'hls' | 'file';
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

/**
 * Reads an embed page through the bundled service and returns the direct
 * stream it advertises. Never rejects; unsupported hosts never reach the
 * service, and a resolved URL is cached only while it is still valid.
 */
export async function resolveEmbedStream(
  pageUrl: string,
  headers: Record<string, string>,
  options: EmbedResolveOptions = {},
): Promise<EmbedResolveResult> {
  const cached = cacheHit(pageUrl, Date.now());
  if (cached) return cached;
  if (!isResolvableEmbedHost(pageUrl)) return { ok: false, reason: 'unsupported_host' };
  const signal = options.signal;
  if (signal?.aborted) return { ok: false, reason: 'aborted' };

  const origin = originOf(pageUrl);
  let response: ServiceManifestResult;
  try {
    response = await fetchManifestViaService(pageUrl, {
      Referer: `${origin}/`,
      'User-Agent': defaultUserAgent(),
      ...headers,
    }, {
      maxBytes: MAX_PAGE_BYTES,
      timeoutMs: PAGE_TIMEOUT_MS,
      graceMs: CONFIG.PLAYER.MANIFEST_SERVICE_GRACE_MS,
      signal,
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (!response.ok) return { ok: false, reason: fetchFailureReason(response.reason) };
  if (signal?.aborted) return { ok: false, reason: 'aborted' };

  const metadata = metadataOf(response.text);
  if (!metadata) return { ok: false, reason: 'no_metadata' };
  const hls = absoluteHttpUrl(metadata.hlsManifestUrl);
  const url = hls ?? lastVideoUrl(metadata);
  if (!url) return { ok: false, reason: 'no_metadata' };

  const result: ResolvedStream = {
    ok: true,
    url,
    kind: hls ? 'hls' : 'file',
    headers: playbackHeaders(headers, origin),
    expiresAt: expiresAtFromUrl(url, Date.now()),
  };
  remember(pageUrl, result, Date.now());
  return result;
}
