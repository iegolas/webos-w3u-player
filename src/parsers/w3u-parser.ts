import type {
  Channel,
  ParsedPlaylist,
  PlaylistFormatDetection,
  PlaylistParseIssue,
  W3uGroupLink,
} from '../types';
import { UNCATEGORIZED_GROUP } from '../types';

/**
 * W3U is a JSON playlist format (Wiseplay): a list of groups, each holding
 * `stations`, plus optional top-level `stations`. Stations are either live
 * streams or VOD entries and may carry playback headers (`referer`,
 * `userAgent`) and presentation metadata (`info`, `image`, `imageScale`).
 *
 * Files in the wild are frequently *not* strict JSON, so a parse falls back
 * to a repair pass instead of rejecting the whole list.
 */

const MAX_ISSUES = 200;
const MAX_ENTRIES = 20000;
const MAX_DEPTH = 4;
const SNIFF_SIZE = 16384;
const UNSAFE_HEADER_VALUE = /[\r\n\0]/;

export interface W3UParseOptions {
  maxChannels?: number;
  maxIssues?: number;
}

interface HeaderKeys {
  referer: string[];
  userAgent: string[];
}

const HEADER_KEYS: HeaderKeys = {
  referer: ['referer', 'referrer', 'http-referrer'],
  userAgent: ['userAgent', 'user-agent', 'http-user-agent'],
};

interface ParseContext {
  channels: Channel[];
  groups: Set<string>;
  groupLinks: W3uGroupLink[];
  issues: PlaylistParseIssue[];
  maxIssues: number;
  maxEntries: number;
  truncated: boolean;
}

/** Cheap sniff so a W3U document is not mistaken for an API payload. The key
 *  must hold an array: `{"groups":[{"id":1}]}` is claimed, plain `"groups": 0`
 *  is not. */
export function isW3UDocument(input: string): boolean {
  const trimmed = stripBom(input).replace(/^\s+/, '');
  const first = trimmed.charCodeAt(0);
  if (first !== 123 && first !== 91) return false;
  const sample = trimmed.slice(0, SNIFF_SIZE);
  if (/"user_info"\s*:/.test(sample)) return false;
  return /"(?:groups|stations)"\s*:\s*\[/.test(sample);
}

export function detectW3UFormat(input: string): PlaylistFormatDetection | null {
  if (!isW3UDocument(input)) return null;
  return {
    format: 'w3u',
    confidence: 0.9,
    reason: 'W3U JSON list document',
    hadBom: input.charCodeAt(0) === 0xfeff,
  };
}

/** Escapes control characters inside strings and drops trailing commas, in a
 *  single pass that copies unchanged slices rather than one char at a time. */
export function repairW3UJson(input: string): string {
  const source = stripBom(input);
  const out: string[] = [];
  let sliceStart = 0;
  let inString = false;
  let escaped = false;
  let removed = false;

  const cut = (index: number, replacement: string): void => {
    out.push(source.slice(sliceStart, index), replacement);
    sliceStart = index + 1;
    removed = true;
  };

  for (let index = 0; index < source.length; index++) {
    const char = source.charAt(index);
    const code = source.charCodeAt(index);
    if (inString) {
      if (escaped) {
        escaped = false;
        // A backslash before a raw control character is a hand-edited line
        // continuation; keep it a valid escape instead of failing the list.
        if (code < 0x20) {
          if (char === '\r') cut(index, 'r');
          else if (char === '\n') cut(index, 'n');
          else if (char === '\t') cut(index, 't');
          else cut(index, 'u' + code.toString(16).padStart(4, '0'));
        }
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
        continue;
      }
      if (code < 0x20) {
        if (char === '\r') cut(index, '');
        else if (char === '\n') cut(index, '\\n');
        else if (char === '\t') cut(index, '\\t');
        else cut(index, ' ');
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === ',') {
      let look = index + 1;
      while (look < source.length && isJsonSpace(source.charCodeAt(look))) look++;
      const next = source.charAt(look);
      if (next === '}' || next === ']') cut(index, '');
    }
  }

  if (!removed) return source;
  out.push(source.slice(sliceStart));
  return out.join('');
}

function isJsonSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

type DocumentParse =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/** Accepts JSON that is valid, repairable, or followed by stray bytes: some
 *  authors leave a duplicated closing brace after the list. */
function parseDocument(input: string): DocumentParse {
  const attempts = [stripBom(input), repairW3UJson(input)];
  let lastError = 'parse failed';
  for (const attempt of attempts) {
    try {
      return { ok: true, value: JSON.parse(attempt) };
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
    }
    const end = endOfFirstJsonValue(attempt);
    if (end > 0) {
      try {
        return { ok: true, value: JSON.parse(attempt.slice(0, end)) };
      } catch (error) {
        lastError = error instanceof Error ? error.message : lastError;
      }
    }
  }
  return { ok: false, message: `W3U document is not valid JSON: ${lastError}` };
}

/** Index just past the first complete top-level value, or 0 when unbalanced. */
function endOfFirstJsonValue(text: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      started = true;
      continue;
    }
    if (char === '{' || char === '[') {
      depth++;
      started = true;
      continue;
    }
    if (char === '}' || char === ']') {
      depth--;
      if (started && depth === 0) return index + 1;
    }
  }
  return 0;
}

export function parseW3U(
  input: string,
  sourceUrl = '',
  options: W3UParseOptions = {},
): ParsedPlaylist {
  const context: ParseContext = {
    channels: [],
    groups: new Set(),
    groupLinks: [],
    issues: [],
    maxIssues: options.maxIssues ?? MAX_ISSUES,
    maxEntries: options.maxChannels && options.maxChannels > 0
      ? options.maxChannels
      : MAX_ENTRIES,
    truncated: false,
  };

  let document: unknown;
  const parsed = parseDocument(input);
  if (!parsed.ok) {
    addIssue(context, 'error', 'w3u-invalid-json', parsed.message);
    return finish(undefined, {}, context, sourceUrl);
  }
  document = parsed.value;

  const lists = Array.isArray(document) ? document : [document];
  let name = '';
  let headerAttributes: Record<string, string> = {};

  for (const list of lists) {
    if (!isRecord(list)) {
      addIssue(context, 'warning', 'w3u-entry-not-object', 'Skipped a W3U list entry that is not an object');
      continue;
    }
    if (!name) name = readString(list, 'name');
    if (!Object.keys(headerAttributes).length) headerAttributes = listMetadata(list, sourceUrl);

    const groups = Array.isArray(list.groups) ? list.groups : [];
    for (const group of groups) {
      if (context.truncated) break;
      walkGroup(context, group, UNCATEGORIZED_GROUP, 0);
    }
    if (!context.truncated) {
      appendStations(context, list.stations, UNCATEGORIZED_GROUP, 0);
    }
  }

  if (!context.channels.length && !context.groupLinks.length && !context.truncated) {
    addIssue(context, 'error', 'w3u-empty', 'W3U playlist contains no playable stations');
  }

  return finish(name, headerAttributes, context, sourceUrl);
}

function walkGroup(
  context: ParseContext,
  raw: unknown,
  parentGroup: string,
  depth: number,
): void {
  if (context.truncated) return;
  if (!isRecord(raw)) {
    addIssue(context, 'warning', 'w3u-group-not-object', 'Skipped a W3U group that is not an object');
    return;
  }
  const name = readString(raw, 'name').trim() || parentGroup;

  // A group that carries `groups` is a folder of sub-lists (series seasons,
  // collections); its children are lists, not stations.
  if (Array.isArray(raw.groups) && depth < MAX_DEPTH) {
    for (const child of raw.groups) {
      if (context.truncated) return;
      walkGroup(context, child, name, depth + 1);
    }
  } else if (Array.isArray(raw.groups)) {
    addIssue(context, 'warning', 'w3u-nesting-too-deep', `Ignored groups nested deeper than ${MAX_DEPTH}`);
  }

  const before = context.channels.length;
  appendStations(context, raw.stations, name, depth);
  if (context.channels.length > before) context.groups.add(name);
  // A linked list is ordinary data now; only a usable absolute http(s) URL
  // can be opened later. Parsing never fetches it, so a link back to an
  // ancestor (or to this same document) is recorded, not followed.
  collectGroupLink(context, raw, name, parentGroup);
}

function collectGroupLink(
  context: ParseContext,
  raw: Record<string, unknown>,
  name: string,
  parentGroup: string,
): void {
  const url = readString(raw, 'url').trim();
  if (!url) return;
  if (!isUsablePlaylistUrl(url)) {
    addIssue(
      context,
      'warning',
      'w3u-group-link-unsupported',
      `Group "${name}" links to an unusable playlist url`,
    );
    return;
  }
  const link: W3uGroupLink = { name, image: readString(raw, 'image').trim(), url };
  if (parentGroup && parentGroup !== name && parentGroup !== UNCATEGORIZED_GROUP) {
    link.parentGroup = parentGroup;
  }
  context.groupLinks.push(link);
}

function isUsablePlaylistUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function appendStations(
  context: ParseContext,
  raw: unknown,
  groupName: string,
  depth: number,
): void {
  if (!Array.isArray(raw)) return;
  for (const station of raw) {
    if (context.channels.length >= context.maxEntries) {
      if (!context.truncated) {
        context.truncated = true;
        addIssue(context, 'warning', 'w3u-truncated', `Stopped after ${context.maxEntries} entries`);
      }
      return;
    }
    if (!isRecord(station)) {
      addIssue(context, 'warning', 'w3u-station-not-object', 'Skipped a W3U station that is not an object');
      continue;
    }
    // Empty objects and text-only spacers are layout, not entries.
    if (!readString(station, 'name').trim()
      && !readString(station, 'url').trim()
      && !Array.isArray(station.stations)) {
      continue;
    }
    // A station that points at another list is a folder too, at any depth.
    if (Array.isArray(station.stations) && depth < MAX_DEPTH) {
      walkGroup(context, station, groupName, depth + 1);
      continue;
    }
    const channel = stationToChannel(station, groupName);
    if (!channel) {
      addIssue(
        context,
        'warning',
        'w3u-station-without-url',
        `Skipped station "${readString(station, 'name') || '(unnamed)'}" without a playable url`,
      );
      continue;
    }
    context.channels.push(channel);
  }
}

function stationToChannel(station: Record<string, unknown>, groupName: string): Channel | null {
  const url = readString(station, 'url').trim();
  if (!url) return null;

  const name = readString(station, 'name').trim() || nameFromUrl(url);
  const referer = readHeader(station, HEADER_KEYS.referer);
  const userAgent = readHeader(station, HEADER_KEYS.userAgent);

  const channel: Channel = {
    id: '',
    name,
    logo: readString(station, 'image').trim(),
    group: groupName,
    url,
    extras: null,
    playlistIds: [],
    catchup: '',
    catchupSource: '',
    catchupDays: 0,
  };

  if (referer || userAgent) {
    const headers: Record<string, string> = {};
    const extras: Record<string, string> = {};
    if (referer) {
      headers.Referer = referer;
      extras['http-referrer'] = referer;
    }
    if (userAgent) {
      headers['User-Agent'] = userAgent;
      extras['http-user-agent'] = userAgent;
    }
    channel.httpHeaders = headers;
    channel.extras = extras;
  }

  const attributes = stationAttributes(station);
  // Mark every W3U station, even a bare one: the Library tab keys off the
  // presence of a w3u-* attribute, so a list without metadata would hide it.
  attributes['w3u-station'] = '1';
  channel.sourceAttributes = attributes;
  return channel;
}

/** W3U-specific metadata kept for the detail surfaces without widening
 *  `Channel` for every provider. */
function stationAttributes(station: Record<string, unknown>): Record<string, string> {
  const attributes: Record<string, string> = {};
  const keys = ['info', 'online', 'isHost', 'embed', 'subtitle', 'imageScale', 'image'];
  for (const key of keys) {
    const value = station[key];
    if (typeof value === 'string' && value.trim()) attributes['w3u-' + key] = value.trim();
    else if (value === true) attributes['w3u-' + key] = 'true';
    else if (value === false) attributes['w3u-' + key] = 'false';
  }
  return attributes;
}

function listMetadata(list: Record<string, unknown>, sourceUrl: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  const keys = ['name', 'author', 'image', 'contact', 'info', 'url'];
  for (const key of keys) {
    const value = readString(list, key).trim();
    if (value) metadata['w3u-' + key] = value;
  }
  if (sourceUrl) metadata['w3u-source'] = sourceUrl;
  return metadata;
}

function finish(
  name: string | undefined,
  headerAttributes: Record<string, string>,
  context: ParseContext,
  sourceUrl: string,
): ParsedPlaylist {
  if (!headerAttributes['w3u-source'] && sourceUrl && Object.keys(headerAttributes).length) {
    headerAttributes['w3u-source'] = sourceUrl;
  }
  const playlist: ParsedPlaylist = {
    channels: context.channels,
    groups: Array.from(context.groups),
    epgUrl: '',
    epgUrls: [],
    headerAttributes,
    format: 'w3u',
    issues: context.issues,
  };
  if (name) playlist.name = name;
  if (context.groupLinks.length) playlist.groupLinks = context.groupLinks;
  return playlist;
}

function addIssue(
  context: ParseContext,
  level: PlaylistParseIssue['level'],
  code: string,
  message: string,
): void {
  if (context.issues.length >= context.maxIssues) return;
  context.issues.push({ level, code, message, line: 0 });
}

function nameFromUrl(url: string): string {
  const withoutQuery = url.split('#')[0].split('?')[0];
  const segment = withoutQuery.substring(withoutQuery.lastIndexOf('/') + 1);
  return decodeURIComponentSafe(segment) || url;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/** Playback headers end up in an HTTP request, so a value carrying CR, LF, or
 *  NUL is dropped rather than injected (the M3U path enforces the same). */
function readHeader(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = readString(record, key).trim();
    if (!value || UNSAFE_HEADER_VALUE.test(value)) continue;
    if (isPlaceholderHeaderValue(value)) continue;
    return value;
  }
  return '';
}

/** Authors write `userAgent: "navigator"` to mean "use the player's own
 *  agent"; sending that literal string would break the stream. */
function isPlaceholderHeaderValue(value: string): boolean {
  return value.toLowerCase() === 'navigator';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

/** Streaming loader adapter: M3U parsing is incremental, but a W3U document
 *  must be read whole. Hold the first chunk(s) until the shape is known, then
 *  either buffer the rest as W3U or hand everything to the M3U parser. */
export interface W3UStreamSink {
  write(text: string): void;
  /** Non-null only when the stream turned out to be a W3U document. */
  finish(): ParsedPlaylist | null;
}

export function createW3UStreamSink(
  passThrough: (text: string) => void,
  sourceUrl: string,
  options: W3UParseOptions = {},
): W3UStreamSink {
  let buffered = '';
  let mode: 'sniff' | 'm3u' | 'w3u' = 'sniff';

  const flushToM3U = (): void => {
    mode = 'm3u';
    const pending = buffered;
    buffered = '';
    if (pending) passThrough(pending);
  };

  return {
    write(text: string): void {
      if (mode === 'm3u') {
        passThrough(text);
        return;
      }
      buffered += text;
      if (mode === 'w3u') return;
      const trimmed = buffered.replace(/^\s+/, '');
      if (trimmed && trimmed.charCodeAt(0) !== 123 && trimmed.charCodeAt(0) !== 91) {
        flushToM3U();
        return;
      }
      if (buffered.length >= SNIFF_SIZE) {
        if (isW3UDocument(buffered)) mode = 'w3u';
        else flushToM3U();
      }
    },
    finish(): ParsedPlaylist | null {
      if (mode === 'm3u') return null;
      if (mode === 'w3u') return parseW3U(buffered, sourceUrl, options);
      if (!isW3UDocument(buffered)) {
        flushToM3U();
        return null;
      }
      return parseW3U(buffered, sourceUrl, options);
    },
  };
}
