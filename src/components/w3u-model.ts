import type { Channel, ParsedPlaylist, W3uGroupLink } from '../types';
import { UNCATEGORIZED_GROUP } from '../types';
import { CONFIG } from '../config';
import { truncate } from '../utils/text';
import { classifyStreamUrl } from '../utils/stream-url-classifier';
import { isResolvableEmbedHost } from '../services/embed-resolver';
import { fetchAndParseM3U } from '../parsers/m3u-loader';

// Display-only data for the W3U Library. Everything here derives from the
// parsed channels; nothing is written back, so stored names stay as delivered.

// 'direct': a media URL the player can load now. 'resolvable': an HTML player
// page on a host the resolver can read, so it plays after a short wait.
// 'browser': any other player page; the app hands it to the TV browser.
export type StationKind = 'direct' | 'resolvable' | 'browser';

export interface W3uStation {
  channel: Channel;
  name: string;
  poster: string;
  kind: StationKind;
  genres: string[];
  synopsis: string;
}

// Why a linked row cannot be opened: 'limit' is the depth cap, 'open' is a
// playlist already on the way here.
export type LinkBlock = 'limit' | 'open';

// How much of a list is shown: `shown` of the `found` titles it holds.
export interface W3uCut {
  shown: number;
  found: number;
}

// A group row that opens another playlist. `stations` stays empty until the
// view fetches the list; `ready` then says the stations are in place.
export interface W3uLink {
  url: string;
  image: string;
  ready: boolean;
  cut: W3uCut | null;
  blocked?: LinkBlock;
}

export interface W3uGroup {
  id: string;
  label: string;
  uncategorized: boolean;
  stations: W3uStation[];
  link?: W3uLink;
}

export interface W3uLibrary {
  groups: W3uGroup[];
  total: number;
}

// Bounds for linked playlists. MAX_DEPTH counts lists opened from the root
// (root -> list -> list -> list is 3); a list at that depth still shows its
// links, marked as closed. MAX_STATIONS caps one list and MAX_TOTAL_STATIONS
// caps the lists held at once: those on the way here plus the cached ones.
// The total must leave room for every list on the way, or a deep one would
// have nothing to show.
export const W3U_LINK_LIMITS = {
  TIMEOUT_MS: 20000,
  MAX_STATIONS: 1000,
  MAX_TOTAL_STATIONS: 2500,
  MAX_DEPTH: 3,
  CACHE_ENTRIES: 8,
} as const;

// Wiseplay list authors style text with Mathematical Alphanumeric letters and
// Letterlike capitals; the TV font draws those as blank boxes.
const STYLED_LETTER_RE =
  /[\u{1D400}-\u{1D7FF}\u2102\u210A-\u2113\u2115\u2119-\u211D\u2124\u2128\u212C\u212D\u212F-\u2131\u2133\u2134]/gu;
const PLAIN_ALNUM_RE = /^[A-Za-z0-9]+$/;
// Emoji and pictographs are decoration the TV font cannot draw. Keycap marks,
// variation selectors, joiners, and zero-width characters go with them.
const PICTOGRAPH_RE =
  /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u2300-\u23FF\u2600-\u27BF\u2B00-\u2BFF\uFE00-\uFE0F\u20E3\u200B-\u200F\u2060\uFEFF\u{E0020}-\u{E007F}]/gu;
const CATEGORY_MARKER = '\u{1F4DA}';
const LABEL_MARKER = '\u{1F4AC}';
// A short heading ahead of the text ("Synopsis: ..."), or a bare "Synopsis" line.
const LABEL_RE = /^(?:[^\s:]{1,24}\s*:\s*|(?:sinopsis|synopsis|sinopse)\s*$)/i;

function foldStyledLetters(text: string): string {
  return text.replace(STYLED_LETTER_RE, (char) => {
    const plain = char.normalize('NFKC');
    return PLAIN_ALNUM_RE.test(plain) ? plain : char;
  });
}

function stripPictographs(text: string): string {
  return text.replace(PICTOGRAPH_RE, '');
}

// One-line display text: plain letters, no emoji, whitespace (raw newlines
// included) collapsed. Falls back to the collapsed original when nothing
// readable is left, so an emoji-only name still shows something.
export function cleanDisplayText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const cleaned = stripPictographs(foldStyledLetters(collapsed)).replace(/\s+/g, ' ').trim();
  return cleaned || collapsed;
}

export function isW3uChannel(channel: Channel): boolean {
  const attributes = channel.sourceAttributes;
  if (!attributes) return false;
  for (const key in attributes) {
    if (key.indexOf('w3u-') === 0) return true;
  }
  return false;
}

export function hasW3uLibrary(
  channels: readonly Channel[],
  links: readonly W3uGroupLink[] = [],
): boolean {
  if (links.length > 0) return true;
  for (let index = 0; index < channels.length; index++) {
    if (isW3uChannel(channels[index])) return true;
  }
  return false;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isEmbedPage(channel: Channel, embedHosts: readonly string[]): boolean {
  const attributes = channel.sourceAttributes ?? {};
  const embed = attributes['w3u-embed'];
  if (embed && embed !== 'false') return true;
  const kind = classifyStreamUrl(channel.url);
  if (kind === 'media') return false;
  if (kind === 'embed') return true;
  if (attributes['w3u-isHost'] === 'true') return true;
  const host = hostOf(channel.url);
  return !!host && embedHosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

// W3U adds its own signals to the shared URL classifier: an explicit embed
// flag, Wiseplay's "host page" flag, and the hosts known to serve player
// pages. A URL nobody recognizes is tried as media; the player reports a
// failure if it is not. A player page is 'resolvable' when the resolver
// reads its host, whichever host that is.
export function classifyStation(
  channel: Channel,
  embedHosts: readonly string[] = CONFIG.W3U.EMBED_HOSTS,
  resolvableHosts: readonly string[] = CONFIG.W3U.RESOLVABLE_EMBED_HOSTS,
): StationKind {
  if (!isEmbedPage(channel, embedHosts)) return 'direct';
  return isResolvableEmbedHost(channel.url, resolvableHosts) ? 'resolvable' : 'browser';
}

export interface StationInfo {
  genres: string[];
  synopsis: string;
}

// A Wiseplay `info` field is free text. List authors commonly lead with one
// category line marked by a books emoji ("Drama/Family"), then a synopsis
// under a speech-bubble heading such as "Synopsis:". Only the marked category
// line becomes genres; every other line stays synopsis text, minus emoji and
// that heading.
export function parseStationInfo(info: string): StationInfo {
  const genres: string[] = [];
  const body: string[] = [];
  const lines = foldStyledLetters(info.replace(/\r/g, '')).split('\n');
  let gapped = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) {
      gapped = body.length > 0;
      continue;
    }
    if (!genres.length && line.indexOf(CATEGORY_MARKER) === 0) {
      for (const part of stripPictographs(line).split('/')) {
        const genre = part.replace(/\s+/g, ' ').trim();
        const known = genres.some((entry) => entry.toLowerCase() === genre.toLowerCase());
        if (genre && !known && genres.length < CONFIG.W3U.GENRES_MAX) genres.push(truncate(genre, 28));
      }
      continue;
    }
    let text = stripPictographs(line).replace(/\s+/g, ' ').trim();
    if (line.indexOf(LABEL_MARKER) === 0) text = text.replace(LABEL_RE, '').trim();
    if (!text) continue;
    if (gapped) body.push('');
    gapped = false;
    body.push(text);
  }
  return { genres, synopsis: truncate(body.join('\n'), CONFIG.W3U.SYNOPSIS_MAX_CHARS) };
}

function stationFor(channel: Channel): W3uStation {
  const attributes = channel.sourceAttributes ?? {};
  const info = parseStationInfo(attributes['w3u-info'] ?? '');
  return {
    channel,
    name: cleanDisplayText(channel.name) || channel.name,
    poster: channel.logo || attributes['w3u-image'] || '',
    kind: classifyStation(channel),
    genres: info.genres,
    synopsis: info.synopsis,
  };
}

function groupChannels(channels: Iterable<Channel>): { groups: W3uGroup[]; total: number } {
  const groups: W3uGroup[] = [];
  const byId = new Map<string, W3uGroup>();
  let total = 0;
  for (const channel of channels) {
    let group = byId.get(channel.group);
    if (!group) {
      group = {
        id: channel.group,
        label: cleanDisplayText(channel.group),
        uncategorized: channel.group === UNCATEGORIZED_GROUP,
        stations: [],
      };
      byId.set(channel.group, group);
      groups.push(group);
    }
    group.stations.push(stationFor(channel));
    total++;
  }
  return { groups, total };
}

// Only a web address can be fetched; a link to anything else is dropped.
function isFetchableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

// The form two addresses are compared in, and the cache key: scheme and host
// in lower case, no fragment. The path and query stay as written, because a
// query can carry the credentials that tell two lists apart. Never shown.
export function canonicalUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return trimmed
      .replace(/#.*$/, '')
      .replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/i, (_all, scheme: string, authority: string) => {
        const at = authority.lastIndexOf('@');
        return scheme.toLowerCase() + authority.slice(0, at + 1) + authority.slice(at + 1).toLowerCase();
      });
  }
}

// A link name is shown as written, except one that is itself an address: that
// can carry a username and password, so only its host is shown.
function linkLabel(name: string, url: string): string {
  const cleaned = cleanDisplayText(name);
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) ? hostOf(cleaned) : cleaned || hostOf(url);
}

// Rows for the playlists a list links to, one per address. `path` holds the
// addresses already open on the way here: a row for one of them stays but is
// marked 'open'. `atLimit` marks every row 'limit'. Neither kind is fetched.
export function linkRows(
  links: readonly W3uGroupLink[],
  path: ReadonlySet<string> = new Set(),
  atLimit = false,
): W3uGroup[] {
  const rows: W3uGroup[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const url = link.url.trim();
    if (!url || !isFetchableUrl(url)) continue;
    const key = canonicalUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const blocked: LinkBlock | undefined = path.has(key) ? 'open' : atLimit ? 'limit' : undefined;
    rows.push({
      id: `link:${key}`,
      label: linkLabel(link.name, url),
      uncategorized: false,
      stations: [],
      link: { url, image: link.image, ready: false, cut: null, ...(blocked ? { blocked } : {}) },
    });
  }
  return rows;
}

// Groups the stations of every W3U playlist in source order, then adds a row
// for each linked playlist. A W3U station that carries no metadata at all has
// no w3u-* mark, so a channel also counts when it shares a playlist with a
// marked one.
export function buildW3uLibrary(
  channels: readonly Channel[],
  links: readonly W3uGroupLink[] = [],
  rootUrls: readonly string[] = [],
): W3uLibrary {
  const playlistIds = new Set<string>();
  for (const channel of channels) {
    if (isW3uChannel(channel)) channel.playlistIds.forEach((id) => playlistIds.add(id));
  }
  const { groups, total } = groupChannels(
    channels.filter((channel) => isW3uChannel(channel) || channel.playlistIds.some((id) => playlistIds.has(id))),
  );
  return { groups: groups.concat(linkRows(links, new Set(rootUrls.map(canonicalUrl)))), total };
}

export type LinkFailure = 'network' | 'parse';

export class LinkFailureError extends Error {
  constructor(readonly reason: LinkFailure) {
    super(`linked playlist ${reason} failure`);
    this.name = 'LinkFailureError';
  }
}

// A fetch that never produced bytes (offline, a host that blocks this app's
// origin, a bad status, a timeout) is a network failure; bytes that did not
// make a playlist are a parse failure.
export function classifyLinkFailure(error: unknown): LinkFailure {
  if (error instanceof LinkFailureError) return error.reason;
  const details = (error as { details?: { stage?: unknown; reason?: unknown } } | null)?.details;
  if (details && typeof details === 'object') {
    if (details.reason === 'http' || details.reason === 'timeout') return 'network';
    if (details.stage === 'fetch' || details.stage === 'read') return 'network';
    return 'parse';
  }
  const message = error instanceof Error ? error.message : String(error);
  return /fetch|network|HTTP \d|timeout|timed out|abort|load failed/i.test(message) ? 'network' : 'parse';
}

export interface LinkedList {
  groups: W3uGroup[];
  links: W3uGroupLink[];
  // Titles kept, and titles the list holds.
  total: number;
  found: number;
}

export function stationCount(groups: readonly W3uGroup[]): number {
  return groups.reduce((sum, group) => sum + group.stations.length, 0);
}

export function cutOf(list: LinkedList): W3uCut | null {
  return list.found > list.total ? { shown: list.total, found: list.found } : null;
}

export function buildLinkedList(
  parsed: ParsedPlaylist,
  limit: number = W3U_LINK_LIMITS.MAX_STATIONS,
): LinkedList {
  const found = parsed.channels.length;
  const kept = Math.max(0, Math.min(limit, W3U_LINK_LIMITS.MAX_STATIONS));
  const { groups, total } = groupChannels(found > kept ? parsed.channels.slice(0, kept) : parsed.channels);
  return { groups, links: parsed.groupLinks ?? [], total, found };
}

type LinkFetcher = (url: string, timeout: number) => Promise<{ data: ParsedPlaylist }>;

// Fetches linked playlists one at a time. Starting a load or calling `abort`
// retires the one in flight: its result is dropped (`load` resolves to null),
// so a late answer never reaches a screen the viewer has left. The loader
// takes no abort signal, so the timeout is what ends a retired request.
// Lists are cached per session by canonical address, so the same list reached
// by another path is not fetched again. The cache keeps at most
// CACHE_ENTRIES lists and MAX_TOTAL_STATIONS titles, dropping the least
// recently used first.
export class W3uLinkLoader {
  private readonly cache = new Map<string, LinkedList>();
  private generation = 0;

  constructor(private readonly fetcher: LinkFetcher = fetchAndParseM3U) {}

  get(url: string): LinkedList | undefined {
    const key = canonicalUrl(url);
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit;
  }

  abort(): void {
    this.generation++;
  }

  // `limit`: the titles the caller has room for.
  async load(url: string, limit: number = W3U_LINK_LIMITS.MAX_STATIONS): Promise<LinkedList | null> {
    const generation = ++this.generation;
    const cached = this.get(url);
    if (cached) return cached;
    let parsed: ParsedPlaylist;
    try {
      parsed = (await this.fetcher(url.trim(), W3U_LINK_LIMITS.TIMEOUT_MS)).data;
    } catch (error) {
      if (generation !== this.generation) return null;
      throw new LinkFailureError(classifyLinkFailure(error));
    }
    if (generation !== this.generation) return null;
    const list = buildLinkedList(parsed, limit);
    if (!list.groups.length && !list.links.length) throw new LinkFailureError('parse');
    const key = canonicalUrl(url);
    this.cache.set(key, list);
    let held = 0;
    this.cache.forEach((entry) => { held += entry.total; });
    for (const oldest of Array.from(this.cache.keys())) {
      if (this.cache.size <= 1) break;
      if (this.cache.size <= W3U_LINK_LIMITS.CACHE_ENTRIES && held <= W3U_LINK_LIMITS.MAX_TOTAL_STATIONS) break;
      held -= this.cache.get(oldest)?.total ?? 0;
      this.cache.delete(oldest);
    }
    return list;
  }
}
