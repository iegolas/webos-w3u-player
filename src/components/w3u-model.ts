import type { Channel } from '../types';
import { UNCATEGORIZED_GROUP } from '../types';
import { CONFIG } from '../config';
import { truncate } from '../utils/text';
import { classifyStreamUrl } from '../utils/stream-url-classifier';
import { isResolvableEmbedHost } from '../services/embed-resolver';

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

export interface W3uGroup {
  id: string;
  label: string;
  uncategorized: boolean;
  stations: W3uStation[];
}

export interface W3uLibrary {
  groups: W3uGroup[];
  total: number;
}

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

export function hasW3uLibrary(channels: readonly Channel[]): boolean {
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

// Groups the stations of every W3U playlist in source order. A W3U station
// that carries no metadata at all has no w3u-* mark, so a channel also
// counts when it shares a playlist with a marked one.
export function buildW3uLibrary(channels: readonly Channel[]): W3uLibrary {
  const playlistIds = new Set<string>();
  for (const channel of channels) {
    if (isW3uChannel(channel)) channel.playlistIds.forEach((id) => playlistIds.add(id));
  }
  const groups: W3uGroup[] = [];
  const byId = new Map<string, W3uGroup>();
  let total = 0;
  for (const channel of channels) {
    if (!isW3uChannel(channel) && !channel.playlistIds.some((id) => playlistIds.has(id))) continue;
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
