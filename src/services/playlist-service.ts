import {
  UNCATEGORIZED_GROUP,
  type Channel,
  type ChannelGroupId,
  type EpgSource,
  type LastChannel,
  type ParsedPlaylist,
  type PinnedLiveGroup,
  type PinnedSelection,
  type PlaylistGroupLink,
  type PlaylistTab,
} from '../types';
import { fetchAndParseM3U } from '../parsers/m3u-loader';
import type { M3ULoadProgress } from '../parsers/m3u-loader';
import {
  xtreamPlaylistUrl,
  xtreamEpgUrl,
  xtreamCatchupSource,
  xtreamLiveUrl,
  resolveXtreamLiveOutput,
  type XtreamCredentials,
  type XtreamLiveOutput,
} from '../utils/xtream-url';
import {
  channelKey,
  channelExactStreamIdentity,
  channelExactStreamKey,
  channelStreamIdentity,
  channelStreamKey,
  legacyChannelKey,
} from '../utils/channel';
import { createXtreamLiveStreamIdResolver } from '../utils/xtream-live-match';
import {
  prepareSearchItem,
  rankPreparedTopK,
  type PreparedSearchItem,
  type RankedSearchResult,
} from '../utils/channel-search';
import { createLogger } from '../utils/logger';
import { StorageService, PINNED_SELECTIONS_MAX } from './storage-service';
import { ChannelCustomizationService, groupKeyOf } from './channel-customization';
import {
  createXtreamClient,
  type XtreamLiveCategory,
  type XtreamLiveStream,
} from './xtream-client';
import {
  cacheRecordRef,
  getCachedPlaylist,
  playlistCacheToken,
  scheduleCachedPlaylist,
  type CacheRecordRef,
} from './idb-cache';
import { isSourceEnabled } from '../utils/playlist';
import {
  filterLiveStreams,
  liveCategoryCounts,
  liveCategoryGroupFilter,
  newLiveCategoryIds,
  normalizeLiveCategoryFilter,
  type XtreamGroupNameFilter,
} from '../utils/xtream-category-filter';
import { liveParentalRequest, ParentalControlService } from './parental-control';
import { CONFIG } from '../config';
import { canonicalUrl } from '../utils/url';
import { W3U_LINK_LIMITS } from '../components/w3u-model';

const log = createLogger('Playlist');

export interface PlaylistLoadProgress {
  sourceNumber: number;
  sourceCount: number;
  inputBytes: number;
  channelsProcessed: number;
  channelsKept: number;
}

export interface LiveCategoryNotice {
  playlistId: string;
  accountName: string;
  count: number;
}

interface PlaylistRefreshOptions {
  preserveOnFailure?: boolean;
}

function usableDirectSource(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : '';
  } catch {
    return '';
  }
}

function enabledGroupLinks(
  links: readonly PlaylistGroupLink[],
  enabledIds: Set<string>,
): PlaylistGroupLink[] {
  const kept: PlaylistGroupLink[] = [];
  for (const link of links) {
    const playlistIds = link.playlistIds.filter(id => enabledIds.has(id));
    if (!playlistIds.length) continue;
    kept.push({ ...link, playlistIds, playlistId: playlistIds[0] });
  }
  return kept;
}

function xtreamLivePlaylist(
  credentials: XtreamCredentials,
  output: XtreamLiveOutput,
  categories: XtreamLiveCategory[],
  streams: XtreamLiveStream[],
): ParsedPlaylist {
  const categoryNames = new Map(categories.map(category => [category.id, category.name]));
  const channels: Channel[] = streams.map(stream => ({
    id: stream.epgChannelId || stream.streamId,
    name: stream.name || stream.streamId,
    logo: stream.icon,
    group: categoryNames.get(stream.categoryId) || UNCATEGORIZED_GROUP,
    url: usableDirectSource(stream.directSource)
      || xtreamLiveUrl(credentials, stream.streamId, output),
    extras: null,
    playlistIds: [],
    catchup: '',
    catchupSource: '',
    catchupDays: 0,
    catchupStreamId: stream.streamId,
  }));
  const groups = Array.from(new Set(channels.map(channel => channel.group)));
  return {
    channels,
    groups,
    epgUrl: '',
    epgUrls: [],
    headerAttributes: {},
    format: 'unknown',
    issues: [],
  };
}

export interface ChannelCacheSource {
  record: CacheRecordRef;
  length: number;
  selection: Uint32Array;
}

/** Why a pinned linked-list selection was refused or dropped. */
export type PinnedLinkReason =
  | 'invalid'
  | 'depth'
  | 'budget'
  | 'limit'
  | 'fetch_failed'
  | 'group_missing'
  | 'canceled'
  | 'storage';

export interface PinnedLinkNotice {
  url: string;
  group: string;
  name: string;
  reason: PinnedLinkReason;
}

export type GroupPinResult =
  | { ok: true; channels: number }
  | { ok: false; reason: PinnedLinkReason };

/** `depth` is the list's level below the W3U Library root: a list opened
 *  directly from it is 1, its own linked lists are 2, and so on. */
export interface GroupPinRequest {
  url: string;
  group: string;
  name: string;
  depth: number;
}

export interface PinnedLinkEntry {
  selection: PinnedSelection;
  channels: Channel[];
}

function pinSelectionKey(url: string, group: string): string {
  return `${canonicalUrl(url)}|${group}`;
}

// A synthetic tab id so overlay channels never look like they belong to a
// configured playlist.
function linkPlaylistId(url: string): string {
  let hash = 2166136261;
  const key = canonicalUrl(url);
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `link:${(hash >>> 0).toString(36)}`;
}

function nextFreeGroupName(name: string, used: Set<string>): string {
  const base = name || UNCATEGORIZED_GROUP;
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base} ${suffix}`)) suffix++;
  return `${base} ${suffix}`;
}

async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next++];
        await task(item);
      }
    },
  );
  await Promise.all(workers);
}

class PlaylistServiceImpl {
  /** Every parsed channel, hidden ones included. Edit mode reads this. */
  allChannels: Channel[] = [];
  /** Visible channels in effective (customized) order. Everything else reads this. */
  channels: Channel[] = [];
  // Customized channels before parental concealment; the EPG keeps covering
  // concealed channels so an unlock does not force a guide refetch.
  private unconcealedChannels: Channel[] = [];
  // Each `channels` entry's index in `allChannels`.
  private channelSourceIndices = new Uint32Array(0);
  groups: string[] = [];
  groupsRevision = 0;
  /** Linked W3U sub-lists from enabled playlists, de-duplicated by url. */
  groupLinks: PlaylistGroupLink[] = [];
  groupLinksRevision = 0;
  /** Session-only selected linked groups, keyed by canonical url + group. */
  pinnedRevision = 0;
  private readonly pinnedLinks = new Map<string, PinnedLinkEntry>();
  private pinnedOverlay: Channel[] = [];
  private pinnedLiveGroupMap: PinnedLiveGroup[] = [];
  private readonly pinnedListCache = new Map<string, Map<string, Channel[]>>();
  private readonly pinFetchTokens = new Map<string, number>();
  private pinFetchSeq = 0;
  private pinnedNotices: PinnedLinkNotice[] = [];
  playlistTabs: PlaylistTab[] = [];
  epgSources: EpgSource[] = [];
  private indexMap = new Map<Channel, number>(); // channel -> global index, O(1) indexOf
  private channelsByGroup = new Map<string, Channel[]>();
  private channelsByPlaylist = new Map<string, Channel[]>();
  private channelsByPlaylistGroup = new Map<string, Map<string, Channel[]>>();
  private groupsByPlaylist = new Map<string, string[]>();
  private groupKeyByDisplay = new Map<string, string>();
  // Channels sharing a key (one URL with other headers or DRM), in order.
  private channelsByKey = new Map<string, Channel[]>();
  private channelByLegacyKey = new Map<string, Channel | null>();
  private channelSearchIndex: PreparedSearchItem<Channel>[] = [];
  private channelSearchByPlaylist = new Map<string, PreparedSearchItem<Channel>[]>();
  private indexedChannels: Channel[] | null = null;
  private indexedChannelCount = -1;
  private searchIndexedChannels: Channel[] | null = null;
  private searchIndexedChannelCount = -1;
  private includeHidden = false;
  private failedSourceIds = new Set<string>();
  private liveCategoryNotices: LiveCategoryNotice[] = [];
  private refreshTimestamp: number | null = null;

  hasLiveCategoryNotices(): boolean {
    return this.currentLiveCategoryNotices().length > 0;
  }

  /** New-category notices from the latest load, each returned once. */
  takeLiveCategoryNotices(): LiveCategoryNotice[] {
    const notices = this.currentLiveCategoryNotices();
    this.liveCategoryNotices = [];
    return notices;
  }

  // A queued notice goes stale once its account is removed, disabled,
  // re-pointed, no longer hides new categories, or has been reviewed.
  private currentLiveCategoryNotices(): LiveCategoryNotice[] {
    if (!this.liveCategoryNotices.length) return [];
    const playlists = StorageService.getPlaylists();
    this.liveCategoryNotices = this.liveCategoryNotices.filter((notice) => {
      const pl = playlists.find(entry => entry.id === notice.playlistId);
      if (!pl || pl.source !== 'xtream' || !isSourceEnabled(pl)) return false;
      if (normalizeLiveCategoryFilter(pl.xtream?.liveCategories)?.mode !== 'include') return false;
      const snapshot = StorageService.getLiveCategorySnapshot(pl.id);
      return !!snapshot && snapshot.announcedIds.length > 0;
    });
    return this.liveCategoryNotices;
  }

  private recordLiveCategories(
    pl: { id: string; name: string; url: string },
    filter: ReturnType<typeof normalizeLiveCategoryFilter>,
    currentIds: readonly string[],
    nextCounts?: Record<string, number>,
  ): void {
    const previous = StorageService.getLiveCategorySnapshot(pl.id);
    // The name-match fallback knows the categories but not their channels.
    const counts = nextCounts ?? previous?.counts ?? {};
    // A missing snapshot (first load, or lost data) treats today's catalog as
    // known, so only categories added after this point are announced.
    const knownIds = previous ? previous.knownIds : currentIds.slice();
    const baseline = { knownIds, announcedIds: previous?.announcedIds ?? [], counts };
    const newIds = newLiveCategoryIds(filter, baseline, currentIds);
    const announced = new Set(baseline.announcedIds);
    const unannounced = newIds.filter(id => !announced.has(id));
    const next = {
      knownIds,
      announcedIds: baseline.announcedIds.concat(unannounced),
      counts,
    };
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      StorageService.setLiveCategorySnapshot(pl.id, next);
    }
    if (unannounced.length) {
      log.info(
        'Xtream Live categories added',
        'event=xtream.category_filter.new',
        `count=${String(unannounced.length)}`,
      );
      this.liveCategoryNotices.push({
        playlistId: pl.id,
        accountName: pl.name || pl.url,
        count: unannounced.length,
      });
    }
  }

  hasFailedSource(playlistIds: readonly string[]): boolean {
    return playlistIds.some(id => this.failedSourceIds.has(id));
  }

  get allSourcesDisabled(): boolean {
    const sources = StorageService.getPlaylists();
    return sources.length > 0 && !sources.some(isSourceEnabled);
  }

  getNextRefreshDelayMs(intervalMs: number): number {
    if (this.refreshTimestamp === null) return 0;
    return Math.max(0, this.refreshTimestamp + intervalMs - Date.now());
  }

  /**
   * Clear all in-memory state. Called when the user removes every configured
   * playlist so stale channels do not survive navigation back to the channel
   * list view.
   */
  reset(): void {
    this.failedSourceIds.clear();
    this.refreshTimestamp = null;
    this.allChannels = [];
    this.channels = [];
    this.unconcealedChannels = [];
    this.channelSourceIndices = new Uint32Array(0);
    this.groups = [];
    this.groupsRevision++;
    this.groupLinks = [];
    this.groupLinksRevision++;
    this.clearPinnedState();
    this.playlistTabs = [];
    this.epgSources = [];
    this.indexMap = new Map();
    this.channelsByGroup = new Map();
    this.channelsByPlaylist = new Map();
    this.channelsByPlaylistGroup = new Map();
    this.groupsByPlaylist = new Map();
    this.groupKeyByDisplay = new Map();
    this.channelsByKey = new Map();
    this.channelByLegacyKey = new Map();
    this.channelSearchIndex = [];
    this.channelSearchByPlaylist = new Map();
    this.indexedChannels = null;
    this.indexedChannelCount = -1;
    this.searchIndexedChannels = null;
    this.searchIndexedChannelCount = -1;
  }

  async load(onProgress?: (progress: PlaylistLoadProgress) => void): Promise<Channel[]> {
    const enabledSources = StorageService.getPlaylists().filter(isSourceEnabled);
    const enabledIds = new Set(enabledSources.map(source => source.id));
    if (!enabledIds.size) {
      this.reset();
      this.logLoadCompleted('none', 0, 0);
      return [];
    }
    // Boot from an expired cache too; App schedules the overdue refresh in the
    // background instead of blocking startup on a full download.
    const cached = await getCachedPlaylist(null);
    if (cached) {
      this.failedSourceIds.clear();
      this.refreshTimestamp = cached.timestamp;
      const channelsNeedFiltering = cached.channels
        .some(channel => channel.playlistIds.some(id => !enabledIds.has(id)));
      this.allChannels = channelsNeedFiltering
        ? cached.channels
            .map(channel => ({
              ...channel,
              playlistIds: channel.playlistIds.filter(id => enabledIds.has(id)),
            }))
            .filter(channel => channel.playlistIds.length > 0)
        : cached.channels;
      const epgSourcesNeedFiltering = cached.epgSources
        .some(source => source.playlistIds.some(id => !enabledIds.has(id)));
      this.epgSources = epgSourcesNeedFiltering
        ? cached.epgSources
            .map(source => ({
              ...source,
              playlistIds: source.playlistIds.filter(id => enabledIds.has(id)),
            }))
            .filter(source => source.playlistIds.length > 0)
        : cached.epgSources;
      this.setGroupLinks(enabledGroupLinks(cached.groupLinks ?? [], enabledIds));
      log.info('Cache hit:', this.allChannels.length, 'channels,', this.epgSources.length, 'epg sources');
      this.applyCustomization();
      this.buildPlaylistTabs();
      StorageService.migrateFavoriteKeys(this.channels);
      this.logLoadCompleted('cache', enabledIds.size, 0);
      return this.channels;
    }
    log.info('Cache miss — refreshing from network');
    return this.refresh(onProgress);
  }

  async refresh(
    onProgress?: (progress: PlaylistLoadProgress) => void,
    options: PlaylistRefreshOptions = {},
  ): Promise<Channel[]> {
    const done = log.time('refresh');
    const cacheToken = playlistCacheToken();
    const playlists = StorageService.getPlaylists().filter(isSourceEnabled);
    if (!playlists.length) {
      log.info('No playlist sources enabled');
      this.reset();
      this.logLoadCompleted('none', 0, 0);
      done();
      return [];
    }

    const allChannels: Channel[] = [];
    const byUrl = new Map<string, Channel>();
    const groupLinks: PlaylistGroupLink[] = [];
    const groupLinkByUrl = new Map<string, PlaylistGroupLink>();
    const epgSources: EpgSource[] = [];
    let failedPlaylists = 0;
    const failedSourceIds = new Set<string>();
    let completedProcessed = 0;
    let completedKept = 0;
    const addEpgSource = (url: string, playlistId: string, kind: EpgSource['kind']): void => {
      const existing = epgSources.find((source) => source.url === url);
      if (existing) {
        if (!existing.playlistIds.includes(playlistId)) existing.playlistIds.push(playlistId);
        return;
      }
      epgSources.push({ url, playlistIds: [playlistId], kind });
    };

    for (let playlistIndex = 0; playlistIndex < playlists.length; playlistIndex++) {
      const pl = playlists[playlistIndex];
      const load = playlistIndex + 1;
      const source = pl.source === 'xtream' ? 'xtream' : 'm3u';
      const sourceStarted = Date.now();
      const sourceEpgStart = epgSources.length;
      let sourceProcessed = 0;
      let sourceKept = 0;
      log.info(
        'Playlist source load started',
        'event=playlist.source.load.started',
        `load=${String(load)}`,
        `source=${source}`,
      );
      // Tag channels by the playlist's stable id, not its name or position, so
      // two playlists sharing a name/URL stay distinct and deleting/reordering
      // one never re-points another's channels.
      const plKey = pl.id;
      // Use the Player API catalog to identify Live entries, but keep get.php as
      // the channel source so provider ordering, headers, URLs, and metadata survive.
      let fetchUrl = pl.url;
      let xtreamCredentials: XtreamCredentials | null = null;
      let xtreamOutput: XtreamLiveOutput = 'ts';
      let xtreamStreams: XtreamLiveStream[] | undefined;
      let xtreamReferences: XtreamLiveStream[] | undefined;
      let xtreamCatalogAvailable = false;
      let xtreamGroupFilter: XtreamGroupNameFilter | undefined;
      const categoryFilter = pl.source === 'xtream'
        ? normalizeLiveCategoryFilter(pl.xtream?.liveCategories)
        : undefined;
      if (pl.source === 'xtream' && pl.xtream) {
        const credentials = { baseUrl: pl.url, ...pl.xtream };
        xtreamCredentials = credentials;
        const client = createXtreamClient(credentials);
        let allowedOutputFormats: string[] = [];
        if (pl.xtream.liveOutput === 'auto') {
          allowedOutputFormats =
            (await client.getAccountInfo())?.allowedOutputFormats ?? [];
        }
        xtreamOutput = resolveXtreamLiveOutput(pl.xtream.liveOutput, allowedOutputFormats);
        const catalogStarted = Date.now();
        log.info(
          'Xtream Live catalog load started',
          'event=xtream.live_catalog.started',
          `load=${String(load)}`,
          'endpoint=get_live_streams',
        );
        const liveCatalog = await client.getLiveStreamsResult();
        xtreamCatalogAvailable = liveCatalog.available;
        xtreamStreams = liveCatalog.streams;
        log[liveCatalog.available ? 'info' : 'warn'](
          'Xtream Live catalog load completed',
          'event=xtream.live_catalog.completed',
          `load=${String(load)}`,
          `available=${liveCatalog.available ? '1' : '0'}`,
          `items=${String(liveCatalog.streams.length)}`,
          `elapsedMs=${String(Date.now() - catalogStarted)}`,
        );
        xtreamReferences = filterLiveStreams(categoryFilter, xtreamStreams);
        if (categoryFilter && liveCatalog.available) {
          log.info(
            'Xtream Live category filter applied',
            'event=xtream.category_filter.applied',
            `load=${String(load)}`,
            `mode=${categoryFilter.mode}`,
            `categories=${String(categoryFilter.ids.length)}`,
            `kept=${String(xtreamReferences.length)}`,
            `total=${String(xtreamStreams.length)}`,
          );
        } else if (categoryFilter) {
          const categories = await client.getLiveCategories();
          xtreamGroupFilter = liveCategoryGroupFilter(categoryFilter, categories) ?? undefined;
          log.warn(
            xtreamGroupFilter
              ? 'Xtream Live catalog unavailable; filtering by category name'
              : 'Xtream Live categories unavailable; loading unfiltered',
            xtreamGroupFilter
              ? 'event=xtream.category_filter.name_match'
              : 'event=xtream.category_filter.unavailable',
            `load=${String(load)}`,
          );
          if (xtreamGroupFilter) {
            this.recordLiveCategories(pl, categoryFilter, categories.map(category => category.id));
          }
        }
        if (liveCatalog.available) {
          const counts = liveCategoryCounts(xtreamStreams);
          this.recordLiveCategories(pl, categoryFilter, Object.keys(counts), counts);
        }
        fetchUrl = xtreamPlaylistUrl(
          credentials,
          xtreamOutput,
        );
      }
      const plDone = log.time(`fetch '${pl.name || pl.url}'`);
      try {
        let parsed: ParsedPlaylist | null = null;
        let playlistError: unknown;
        try {
          const loaded = await fetchAndParseM3U(
            fetchUrl,
            60000,
            xtreamCatalogAvailable ? xtreamReferences : undefined,
            xtreamCredentials?.baseUrl,
            (progress: M3ULoadProgress) => {
              sourceProcessed = Math.max(sourceProcessed, progress.channelsProcessed);
              sourceKept = Math.max(sourceKept, progress.channelsKept);
              onProgress?.({
                sourceNumber: load,
                sourceCount: playlists.length,
                inputBytes: progress.inputBytes,
                channelsProcessed: completedProcessed + sourceProcessed,
                channelsKept: completedKept + sourceKept,
              });
            },
            xtreamGroupFilter,
          );
          parsed = loaded.data;
        } catch (err) {
          playlistError = err;
          if (!xtreamCredentials) throw err;
          log.warn(
            'Xtream playlist failed; trying the Player API live catalog',
            'event=xtream.live_fallback.used',
            `load=${String(load)}`,
            'reason=request_failed',
          );
        }

        let fallbackStreams: XtreamLiveStream[] | undefined;
        if (xtreamCredentials && (!parsed || !parsed.channels.length)) {
          if (parsed) {
            log.warn(
              'Xtream playlist contained no channels; trying the Player API live catalog',
              'event=xtream.live_fallback.used',
              `load=${String(load)}`,
              'reason=no_channels',
            );
          }
          const client = createXtreamClient(xtreamCredentials);
          const categories = await client.getLiveCategories();
          const allStreams = xtreamCatalogAvailable
            ? xtreamStreams ?? []
            : await client.getLiveStreams();
          fallbackStreams = allStreams;
          const streams = filterLiveStreams(categoryFilter, allStreams);
          log.info(
            'Xtream Player API live catalog completed',
            'event=xtream.live_api.completed',
            `load=${String(load)}`,
            `categories=${String(categories.length)}`,
            `streams=${String(streams.length)}`,
          );
          if (streams.length) {
            parsed = xtreamLivePlaylist(
              xtreamCredentials,
              xtreamOutput,
              categories,
              streams,
            );
          } else if (!parsed && playlistError) {
            throw playlistError;
          }
        }
        if (!parsed) throw new Error('Xtream source returned no playlist or live catalog');

        if (xtreamCredentials) {
          await this.applyXtreamCatchup(
            parsed.channels,
            xtreamCredentials,
            plKey,
            xtreamOutput,
            fallbackStreams ?? xtreamStreams,
          );
        }
        if (parsed.issues.length) {
          log.warn('Playlist diagnostics:',
            parsed.issues.slice(0, 5).map(issue => `${issue.code}@${issue.line}`).join(', '));
        }
        log.info('Parsed', parsed.channels.length, 'channels,', parsed.groups.length, 'groups',
          parsed.epgUrl ? `| epg: ${parsed.epgUrl}` : '');
        let added = 0, dupes = 0;
        // Merging de-duplicates by stream: the same location sent with other
        // headers or options is another channel. channelKey stays URL-only,
        // so a plain channel keeps its favorites and history. The location is
        // compared exactly: entries differing only by a token may come from
        // different accounts, and each must keep its own working token.
        for (const ch of parsed.channels) {
          const identity = channelExactStreamIdentity(ch);
          const existing = byUrl.get(identity);
          if (existing) {
            // Same stream in an earlier playlist: keep the one channel object
            // (so "All" stays de-duplicated), but record this playlist too so
            // its own tab still appears and shows the channel.
            if (!existing.playlistIds.includes(plKey)) existing.playlistIds.push(plKey);
            dupes++;
          } else {
            ch.playlistIds = [plKey];
            byUrl.set(identity, ch);
            allChannels.push(ch);
            added++;
          }
        }
        log.debug(`Added ${added} channels (${dupes} duplicates skipped)`);
        // Linked sub-lists merge like channels: one entry per url across the
        // enabled sources, owned by the first playlist that declared it.
        for (const link of parsed.groupLinks ?? []) {
          const existing = groupLinkByUrl.get(link.url);
          if (existing) {
            if (!existing.playlistIds.includes(plKey)) existing.playlistIds.push(plKey);
            continue;
          }
          const entry: PlaylistGroupLink = {
            name: link.name,
            image: link.image,
            url: link.url,
            playlistIds: [plKey],
            playlistId: plKey,
          };
          if (link.parentGroup) entry.parentGroup = link.parentGroup;
          groupLinkByUrl.set(link.url, entry);
          groupLinks.push(entry);
        }
        if (pl.source === 'xtream' && pl.xtream) {
          // The panel's own XMLTV endpoint; the get.php url-tvg (if any) is added below too.
          const epg = xtreamEpgUrl({ baseUrl: pl.url, ...pl.xtream });
          addEpgSource(epg, plKey, 'xtream');
        }
        for (const parsedEpgUrl of parsed.epgUrls) {
          // Resolve localhost/127.0.0.1 in embedded EPG URL to the playlist's host
          let epg = parsedEpgUrl;
          try {
            const epgParsed = new URL(epg);
            if (epgParsed.hostname === 'localhost' || epgParsed.hostname === '127.0.0.1') {
              const plParsed = new URL(pl.url);
              epgParsed.hostname = plParsed.hostname;
              epg = epgParsed.toString();
              log.info('Rewrote loopback EPG host to', epgParsed.hostname);
            }
          } catch (e) { log.warn('Could not parse EPG URL:', epg, e); }
          addEpgSource(epg, plKey, 'm3u');
        }
        log.info(
          'Playlist source load completed',
          'event=playlist.source.load.completed',
          `load=${String(load)}`,
          `source=${source}`,
          `channels=${String(parsed.channels.length)}`,
          `added=${String(added)}`,
          `duplicates=${String(dupes)}`,
          `epg=${String(epgSources.length - sourceEpgStart)}`,
          `elapsedMs=${String(Date.now() - sourceStarted)}`,
        );
      } catch (err) {
        failedPlaylists++;
        failedSourceIds.add(plKey);
        log.error(
          'Playlist source load failed',
          'event=playlist.source.load.failed',
          `load=${String(load)}`,
          `source=${source}`,
          'reason=request_failed',
          `elapsedMs=${String(Date.now() - sourceStarted)}`,
          err,
        );
        if (pl.source === 'xtream') {
          log.error(
            `Failed to load Xtream playlist '${pl.name || pl.url}'`,
            'event=xtream.playlist.load.failed',
            `load=${String(load)}`,
            err,
          );
        } else {
          log.error(`Failed to load playlist '${pl.name || pl.url}':`, err);
        }
      }
      completedProcessed += sourceProcessed;
      completedKept += sourceKept;
      plDone();
    }

    this.failedSourceIds = failedSourceIds;
    if (failedPlaylists && options.preserveOnFailure) {
      log.warn(
        'Keeping the current channel list because an automatic refresh was incomplete',
        'event=playlist.refresh.preserved',
        `failed=${String(failedPlaylists)}`,
      );
      this.logLoadCompleted('network', playlists.length, failedPlaylists);
      done();
      return this.channels;
    }
    const refreshTimestamp = Date.now();
    this.allChannels = allChannels;
    this.epgSources = epgSources;
    this.setGroupLinks(groupLinks);
    // Customization preserves source names/groups on each channel, so cached
    // channels can be re-customized after an edit without another network load.
    if (!failedPlaylists) {
      this.refreshTimestamp = refreshTimestamp;
      scheduleCachedPlaylist(
        allChannels,
        epgSources,
        refreshTimestamp,
        StorageService.getPlaylistRefreshIntervalMs(),
        cacheToken,
        groupLinks,
      );
    } else {
      this.refreshTimestamp = null;
      log.warn('Skipping cache write because one or more playlists failed');
    }
    this.applyCustomization();
    this.buildPlaylistTabs();
    StorageService.migrateFavoriteKeys(this.channels);
    log.info('Refresh complete:', allChannels.length, 'total channels,', epgSources.length, 'epg sources');
    this.logLoadCompleted('network', playlists.length, failedPlaylists);
    done();
    return this.channels;
  }

  /**
   * One structured line per load so a diagnostics report can tie an empty
   * channel list to the sources that produced it — the rendered list is
   * virtualized, so its DOM row count says nothing about the catalog.
   */
  private logLoadCompleted(
    source: 'cache' | 'network' | 'none',
    sources: number,
    failed: number,
  ): void {
    const level = failed || (sources && !this.channels.length) ? 'warn' : 'info';
    log[level](
      'Playlist load completed',
      'event=playlist.load.completed',
      `source=${source}`,
      `channels=${this.channels.length}`,
      `all=${this.allChannels.length}`,
      `groups=${this.groups.length}`,
      `epg=${this.epgSources.length}`,
      `sources=${sources}`,
      `failed=${failed}`,
    );
  }

  private async applyXtreamCatchup(
    channels: Channel[],
    credentials: XtreamCredentials,
    accountId: string,
    output: XtreamLiveOutput,
    knownStreams?: XtreamLiveStream[],
  ): Promise<void> {
    const client = createXtreamClient(credentials);
    const streams = knownStreams ?? await client.getLiveStreams();
    const archived = new Map(streams
      .filter(stream => stream.archive)
      .map(stream => [stream.streamId, stream]));
    if (!archived.size) return;

    const clock = await client.getServerClock();
    const knownIds = new Set(streams.map(stream => stream.streamId));
    const resolveLiveStreamId = createXtreamLiveStreamIdResolver(
      streams,
      credentials.baseUrl,
    );
    let enabled = 0;
    let unmatched = 0;
    for (const channel of channels) {
      const streamId = channel.catchupStreamId && knownIds.has(channel.catchupStreamId)
        ? channel.catchupStreamId
        : resolveLiveStreamId(channel.url);
      const stream = archived.get(streamId);
      if (!stream) {
        if (!streamId) unmatched++;
        continue;
      }
      channel.catchupStreamId = streamId;
      channel.catchupAccountId = accountId;
      if (!channel.catchupSource) {
        channel.catchup = 'xtream';
        channel.catchupSource = xtreamCatchupSource(credentials, streamId, output);
        channel.catchupDays = stream.archiveDurationDays;
        enabled++;
      }
      if (clock?.timeZone) channel.catchupTimeZone = clock.timeZone;
      if (clock?.offsetMinutes != null) channel.catchupTimeOffsetMinutes = clock.offsetMinutes;
    }
    log.info(
      'Xtream catch-up matching completed',
      'event=xtream.catchup.matched',
      `streams=${streams.length}`,
      `archived=${archived.size}`,
      `enabled=${enabled}`,
      `unmatched=${unmatched}`,
    );
    if (unmatched) {
      log.warn(
        'Xtream catch-up streams could not be matched',
        'event=xtream.catchup.unmatched',
        `channels=${unmatched}`,
      );
    }
  }

  /**
   * Rebuild `channels` from `allChannels` through the user's customization:
   * hidden channels drop out, the rest take the custom order, and renames and
   * group assignments are applied to the channel objects. Cheap enough to re-run
   * after every edit — no network, no re-parse.
   */
  applyCustomization(): void {
    const includeHidden = this.includeHidden || StorageService.getShowHiddenChannels();
    const sourceIndices = new Uint32Array(this.allChannels.length);
    this.unconcealedChannels = ChannelCustomizationService.applyTo(
      this.allChannels,
      includeHidden,
      sourceIndices,
    );
    if (ParentalControlService.concealing) {
      const visible: Channel[] = [];
      for (let i = 0; i < this.unconcealedChannels.length; i++) {
        const channel = this.unconcealedChannels[i];
        if (ParentalControlService.isConcealed(liveParentalRequest(channel))) continue;
        // Compacts in place: the write index never passes the read index.
        sourceIndices[visible.length] = sourceIndices[i];
        visible.push(channel);
      }
      this.channels = visible;
    } else {
      this.channels = this.unconcealedChannels;
    }
    this.channelSourceIndices = sourceIndices.subarray(0, this.channels.length);
    const base = this.channels;
    this.channels = this.mergePinnedOverlay(base);
    this.buildDerivedIndexes();
  }

  // Pinned linked channels sit after the customized main list, so every main
  // index stays put when a pin is added or removed.
  private mergePinnedOverlay(base: Channel[]): Channel[] {
    const used = new Set<string>();
    const seen = new Set<string>();
    for (const channel of base) {
      if (channel.group) used.add(channel.group);
      seen.add(channelKey(channel));
    }
    const overlay: Channel[] = [];
    const mapped: PinnedLiveGroup[] = [];
    this.pinnedLinks.forEach((entry) => {
      const wholeList = !entry.selection.group;
      const labels = new Map<string, string>();
      let fixedLabel = '';
      if (!wholeList) {
        fixedLabel = nextFreeGroupName(entry.selection.name || entry.selection.group, used);
        used.add(fixedLabel);
      }
      const playlistId = linkPlaylistId(entry.selection.url);
      let added = false;
      for (const channel of entry.channels) {
        const key = channelKey(channel);
        if (seen.has(key)) continue;
        seen.add(key);
        let label = fixedLabel;
        if (wholeList) {
          const sourceLabel = channel.group || entry.selection.name;
          label = labels.get(sourceLabel) ?? '';
          if (!label) {
            label = nextFreeGroupName(sourceLabel, used);
            labels.set(sourceLabel, label);
            used.add(label);
          }
        }
        added = true;
        overlay.push({
          ...channel,
          group: label,
          groupKey: label,
          playlistIds: [playlistId],
        });
      }
      const selection = entry.selection;
      if (wholeList) {
        labels.forEach((label) => {
          mapped.push({ group: label, url: selection.url, groupKey: '', name: selection.name });
        });
      } else if (added) {
        mapped.push({
          group: fixedLabel,
          url: selection.url,
          groupKey: selection.group,
          name: selection.name,
        });
      }
    });
    const changed = this.pinnedStateChanged(mapped, overlay);
    this.pinnedOverlay = overlay;
    this.pinnedLiveGroupMap = mapped;
    if (changed) this.pinnedRevision++;
    return overlay.length ? base.concat(overlay) : base;
  }

  private pinnedStateChanged(mapped: readonly PinnedLiveGroup[], overlay: readonly Channel[]): boolean {
    if (mapped.length !== this.pinnedLiveGroupMap.length
        || overlay.length !== this.pinnedOverlay.length) return true;
    for (let i = 0; i < mapped.length; i++) {
      const next = mapped[i];
      const prev = this.pinnedLiveGroupMap[i];
      if (next.group !== prev.group || next.url !== prev.url
          || next.groupKey !== prev.groupKey || next.name !== prev.name) return true;
    }
    for (let i = 0; i < overlay.length; i++) {
      if (channelKey(overlay[i]) !== channelKey(this.pinnedOverlay[i])) return true;
    }
    return false;
  }

  /**
   * The playlist-cache record `allChannels` came from, with each visible
   * channel's index in it — or null when memory no longer matches a record.
   */
  getChannelCacheSource(): ChannelCacheSource | null {
    const record = cacheRecordRef(this.allChannels);
    if (!record || this.channelSourceIndices.length !== this.channels.length) return null;
    return {
      record,
      length: this.allChannels.length,
      selection: this.channelSourceIndices,
    };
  }

  /**
   * The channels the EPG is fetched and retained for. Edit mode and the
   * "show hidden" setting both widen `channels`, and a widened selection
   * forces an EPG refetch — so the guide follows the visible selection alone
   * and stays stable across those two toggles.
   */
  getEpgEligibleChannels(): Channel[] {
    if (!this.includeHidden && !StorageService.getShowHiddenChannels()) {
      return this.unconcealedChannels;
    }
    return ChannelCustomizationService.applyTo(this.allChannels, false);
  }

  // Parental "hide" mode drops locked channels from `channels`; stored data
  // keyed to them (reminders, custom order) must still resolve.
  getUnconcealedChannels(): Channel[] {
    return this.unconcealedChannels;
  }

  /** Edit mode reveals hidden channels so they can be un-hidden again. */
  setIncludeHidden(include: boolean): void {
    if (this.includeHidden === include) return;
    this.includeHidden = include;
    this.applyCustomization();
  }

  private buildDerivedIndexes(): void {
    const groupSet = new Set<string>();
    const groupSetsByPlaylist = new Map<string, Set<string>>();
    this.indexMap = new Map();
    this.channelsByGroup = new Map();
    this.channelsByPlaylist = new Map();
    this.channelsByPlaylistGroup = new Map();
    this.groupKeyByDisplay = new Map();
    this.channelsByKey = new Map();
    this.channelByLegacyKey = new Map();
    this.channelSearchIndex = [];
    this.channelSearchByPlaylist = new Map();
    this.searchIndexedChannels = null;
    this.searchIndexedChannelCount = -1;

    for (const key of ChannelCustomizationService.customGroups) {
      this.groupKeyByDisplay.set(ChannelCustomizationService.groupLabel(key), key);
    }

    for (let i = 0; i < this.channels.length; i++) {
      const ch = this.channels[i];
      this.indexMap.set(ch, i);
      const key = channelKey(ch);
      this.appendIndexed(this.channelsByKey, key, ch);
      // A legacy key is ambiguous only across different streams, not across
      // entries that share one channelKey.
      const legacyKey = legacyChannelKey(ch);
      const legacy = this.channelByLegacyKey.get(legacyKey);
      if (legacy === undefined) this.channelByLegacyKey.set(legacyKey, ch);
      else if (legacy && channelKey(legacy) !== key) this.channelByLegacyKey.set(legacyKey, null);
      if (ch.group) {
        groupSet.add(ch.group);
        if (!this.groupKeyByDisplay.has(ch.group)) {
          this.groupKeyByDisplay.set(ch.group, groupKeyOf(ch));
        }
        this.appendIndexed(this.channelsByGroup, ch.group, ch);
      }
      for (const playlistId of ch.playlistIds) {
        this.appendIndexed(this.channelsByPlaylist, playlistId, ch);
        if (!ch.group) continue;
        let byGroup = this.channelsByPlaylistGroup.get(playlistId);
        if (!byGroup) {
          byGroup = new Map();
          this.channelsByPlaylistGroup.set(playlistId, byGroup);
        }
        this.appendIndexed(byGroup, ch.group, ch);
        let playlistGroups = groupSetsByPlaylist.get(playlistId);
        if (!playlistGroups) {
          playlistGroups = new Set();
          groupSetsByPlaylist.set(playlistId, playlistGroups);
        }
        playlistGroups.add(ch.group);
      }
    }
    for (const key of ChannelCustomizationService.customGroups) {
      const label = ChannelCustomizationService.groupLabel(key);
      groupSet.add(label);
      this.groupKeyByDisplay.set(label, key);
    }
    this.groups = this.orderGroups(Array.from(groupSet));
    this.groupsByPlaylist = new Map();
    groupSetsByPlaylist.forEach((playlistGroups, playlistId) => {
      this.groupsByPlaylist.set(playlistId, this.orderGroups(Array.from(playlistGroups)));
    });
    this.indexedChannels = this.channels;
    this.indexedChannelCount = this.channels.length;
    this.groupsRevision++;
  }

  private appendIndexed<T>(map: Map<string, T[]>, key: string, channel: T): void {
    const existing = map.get(key);
    if (existing) existing.push(channel);
    else map.set(key, [channel]);
  }

  private ensureDerivedIndexes(): void {
    if (this.indexedChannels !== this.channels || this.indexedChannelCount !== this.channels.length) {
      this.buildDerivedIndexes();
    }
  }

  private ensureLocalSearchIndexes(): void {
    this.ensureDerivedIndexes();
    if (this.searchIndexedChannels === this.channels
        && this.searchIndexedChannelCount === this.channels.length) return;
    this.channelSearchIndex = [];
    this.channelSearchByPlaylist = new Map();
    for (const channel of this.channels) {
      const searchItem = prepareSearchItem(
        channel,
        item => [item.name, item.group, item.sourceName ?? ''],
      );
      this.channelSearchIndex.push(searchItem);
      for (const playlistId of channel.playlistIds) {
        this.appendIndexed(this.channelSearchByPlaylist, playlistId, searchItem);
      }
    }
    this.searchIndexedChannels = this.channels;
    this.searchIndexedChannelCount = this.channels.length;
  }

  /** Sort display group names into the custom group order (keyed by group key). */
  private orderGroups(displayNames: string[]): string[] {
    return displayNames
      .map((name, index) => ({
        name,
        rank: ChannelCustomizationService.groupRank(
          this.groupKeyByDisplay.get(name) ?? name,
          index,
        ),
        index,
      }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.name);
  }

  private buildPlaylistTabs(): void {
    // One tab per configured playlist, in config order, keyed by its stable id —
    // including a playlist that loaded zero channels (empty/unreachable feed), so
    // it stays visible. Derived from the registry, not the cached channels, so a
    // stale/desynced channel cache can never blank out the tab bar.
    const configured = StorageService.getPlaylists().filter(isSourceEnabled);
    this.playlistTabs = configured.map(pl => ({ id: pl.id, name: pl.name || pl.url }));
  }

  private setGroupLinks(links: PlaylistGroupLink[]): void {
    this.groupLinks = links;
    this.groupLinksRevision++;
  }

  /** Linked W3U sub-lists across the enabled sources, de-duplicated by url.
   *  `playlist` scopes the result to one playlist tab. */
  getGroupLinks(playlist?: string): PlaylistGroupLink[] {
    if (!playlist) return this.groupLinks.slice();
    return this.groupLinks.filter(link => link.playlistIds.includes(playlist));
  }

  // --- pinned linked groups ---

  hasPinnedLinkNotices(): boolean {
    return this.pinnedNotices.length > 0;
  }

  /** Pins that failed or vanished since the last call, each returned once. */
  takePinnedLinkNotices(): PinnedLinkNotice[] {
    const notices = this.pinnedNotices;
    this.pinnedNotices = [];
    return notices;
  }

  pinnedSelections(): PinnedSelection[] {
    return StorageService.getPinnedSelections();
  }

  isGroupPinned(url: string, group: string): boolean {
    const key = pinSelectionKey(url, group);
    return this.pinnedLinks.has(key)
      || StorageService.getPinnedSelections().some(selection =>
        pinSelectionKey(selection.url, selection.group) === key);
  }

  /** Each Live group produced by a pin, with the selection behind it. A group
   *  name carries its collision suffix; a whole-list pin maps every group it adds. */
  pinnedLiveGroups(): PinnedLiveGroup[] {
    return this.pinnedLiveGroupMap.slice();
  }

  /** Unpins the selection behind a displayed Live group. A whole-list pin owns
   *  several Live groups, so any one of them unpins the whole selection. */
  async unpinLiveGroup(group: string): Promise<boolean> {
    const mapped = this.pinnedLiveGroupMap.find(entry => entry.group === group);
    if (!mapped) return false;
    this.unpinSelection(pinSelectionKey(mapped.url, mapped.groupKey));
    return true;
  }

  // Session-only: the live list falls back to the main playlist, but saved
  // selections stay for the next explicit pin. `reset()` clears the overlay too.
  clearPinnedChannels(): void {
    this.clearPinnedState();
    this.applyCustomization();
  }

  /** Applies an already-fetched entry; null removes one. Storage is untouched. */
  setPinnedChannels(selectionKey: string, entry: PinnedLinkEntry | null): void {
    if (entry) this.pinnedLinks.set(selectionKey, entry);
    else this.pinnedLinks.delete(selectionKey);
    this.applyCustomization();
    this.pinnedRevision++;
  }

  /** Fetches each distinct pinned list once, two at a time, then adds only
   *  the pins that still exist. Called once at startup. */
  async loadPinnedSelections(): Promise<void> {
    const selections = StorageService.getPinnedSelections();
    if (!selections.length) return;
    // Rebuild from storage: a second call replaces the session overlay instead
    // of treating its own channels as duplicates.
    this.pinnedLinks.clear();
    this.pinnedOverlay = [];
    this.pinnedNotices = [];
    this.applyCustomization();
    this.pinnedRevision++;
    const byUrl = new Map<string, PinnedSelection[]>();
    for (const selection of selections) {
      const url = canonicalUrl(selection.url);
      const list = byUrl.get(url) ?? [];
      list.push(selection);
      byUrl.set(url, list);
    }
    const outcomes = new Map<string, Map<string, Channel[]> | null>();
    await forEachConcurrent(Array.from(byUrl.keys()), 2, async (url) => {
      try {
        outcomes.set(url, await this.fetchPinnedList(url));
      } catch {
        outcomes.set(url, null);
      }
    });
    byUrl.forEach((listSelections, url) => {
      const groups = outcomes.get(url) ?? null;
      if (!groups) {
        for (const selection of listSelections) this.reportPinnedNotice(selection, 'fetch_failed');
        return;
      }
      for (const selection of listSelections) {
        const key = pinSelectionKey(selection.url, selection.group);
        if (selection.group && !groups.has(selection.group)) {
          this.removePinnedSelection(selection);
          this.reportPinnedNotice(selection, 'group_missing');
          continue;
        }
        const raw = this.pinnedChannelsFor(groups, selection);
        if (!raw.length) {
          this.removePinnedSelection(selection);
          this.reportPinnedNotice(selection, 'group_missing');
          continue;
        }
        const channels = this.uniquePinnedChannels(raw);
        if (this.pinnedOverlay.length + channels.length > CONFIG.W3U.LIVE_LINK_TITLES) {
          this.reportPinnedNotice(selection, 'budget');
          continue;
        }
        this.setPinnedChannels(key, { selection, channels });
      }
    });
  }

  async setGroupPinned(
    request: GroupPinRequest,
    pinned: boolean,
  ): Promise<GroupPinResult> {
    const url = request.url.trim();
    const group = typeof request.group === 'string' ? request.group : '';
    const name = (request.name || '').trim() || group;
    if (!url || !name) return { ok: false, reason: 'invalid' };
    const key = pinSelectionKey(url, group);
    if (!pinned) {
      this.unpinSelection(key);
      return { ok: true, channels: 0 };
    }
    if (!Number.isInteger(request.depth)
        || request.depth < 1
        || request.depth > W3U_LINK_LIMITS.MAX_DEPTH) {
      return { ok: false, reason: 'depth' };
    }
    const existing = this.pinnedLinks.get(key);
    if (existing) return { ok: true, channels: existing.channels.length };
    const token = this.beginPinFetch(key);
    let groups: Map<string, Channel[]>;
    try {
      groups = await this.fetchPinnedList(url);
    } catch {
      if (this.pinFetchTokens.get(key) === token) this.pinFetchTokens.delete(key);
      return { ok: false, reason: 'fetch_failed' };
    }
    if (this.pinFetchTokens.get(key) !== token) return { ok: false, reason: 'canceled' };
    this.pinFetchTokens.delete(key);
    if (group && !groups.has(group)) return { ok: false, reason: 'group_missing' };
    const raw = this.pinnedChannelsFor(groups, { group });
    if (!raw.length) return { ok: false, reason: 'group_missing' };
    const channels = this.uniquePinnedChannels(raw);
    if (this.pinnedOverlay.length + channels.length > CONFIG.W3U.LIVE_LINK_TITLES) {
      return { ok: false, reason: 'budget' };
    }
    const selection: PinnedSelection = {
      url: canonicalUrl(url),
      group,
      name,
      pinnedAt: Date.now(),
    };
    const selections = StorageService.getPinnedSelections().filter(entry =>
      pinSelectionKey(entry.url, entry.group) !== key);
    if (selections.length >= PINNED_SELECTIONS_MAX) return { ok: false, reason: 'limit' };
    if (!StorageService.setPinnedSelections(selections.concat(selection))) {
      return { ok: false, reason: 'storage' };
    }
    this.setPinnedChannels(key, { selection, channels });
    return { ok: true, channels: channels.length };
  }

  private unpinSelection(key: string): void {
    this.pinFetchTokens.delete(key);
    const selections = StorageService.getPinnedSelections();
    const next = selections.filter(selection =>
      pinSelectionKey(selection.url, selection.group) !== key);
    if (next.length !== selections.length) StorageService.setPinnedSelections(next);
    if (this.pinnedLinks.has(key)) this.setPinnedChannels(key, null);
    else if (next.length !== selections.length) this.pinnedRevision++;
  }

  private beginPinFetch(key: string): number {
    const token = ++this.pinFetchSeq;
    this.pinFetchTokens.set(key, token);
    return token;
  }

  private async fetchPinnedList(url: string): Promise<Map<string, Channel[]>> {
    const cacheKey = canonicalUrl(url);
    const cached = this.pinnedListCache.get(cacheKey);
    if (cached) return cached;
    const parsed = (await fetchAndParseM3U(url.trim(), W3U_LINK_LIMITS.TIMEOUT_MS)).data;
    const groups = new Map<string, Channel[]>();
    const limit = Math.min(parsed.channels.length, W3U_LINK_LIMITS.MAX_STATIONS);
    for (let i = 0; i < limit; i++) {
      const channel = parsed.channels[i];
      const list = groups.get(channel.group);
      if (list) list.push(channel);
      else groups.set(channel.group, [channel]);
    }
    this.pinnedListCache.set(cacheKey, groups);
    return groups;
  }

  private pinnedChannelsFor(
    groups: Map<string, Channel[]>,
    selection: Pick<PinnedSelection, 'group'>,
  ): Channel[] {
    if (selection.group) return groups.get(selection.group) ?? [];
    const all: Channel[] = [];
    groups.forEach(list => all.push(...list));
    return all;
  }

  private uniquePinnedChannels(channels: readonly Channel[]): Channel[] {
    const seen = new Set<string>();
    for (const channel of this.channels) seen.add(channelKey(channel));
    for (const channel of this.pinnedOverlay) seen.add(channelKey(channel));
    const unique: Channel[] = [];
    for (const channel of channels) {
      const key = channelKey(channel);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(channel);
    }
    return unique;
  }

  private removePinnedSelection(selection: PinnedSelection): void {
    const key = pinSelectionKey(selection.url, selection.group);
    const selections = StorageService.getPinnedSelections();
    const next = selections.filter(entry =>
      pinSelectionKey(entry.url, entry.group) !== key);
    if (next.length !== selections.length) StorageService.setPinnedSelections(next);
    if (this.pinnedLinks.has(key)) this.setPinnedChannels(key, null);
    else this.pinnedRevision++;
  }

  private reportPinnedNotice(selection: PinnedSelection, reason: PinnedLinkReason): void {
    if (this.pinnedNotices.some(notice =>
      notice.url === selection.url && notice.group === selection.group
      && notice.reason === reason)) return;
    this.pinnedNotices.push({
      url: selection.url,
      group: selection.group,
      name: selection.name,
      reason,
    });
  }

  private clearPinnedState(): void {
    this.pinnedLinks.clear();
    this.pinnedOverlay = [];
    this.pinnedLiveGroupMap = [];
    this.pinnedListCache.clear();
    this.pinFetchTokens.clear();
    this.pinnedNotices = [];
    this.pinnedRevision++;
  }

  getByGroup(group: ChannelGroupId, playlist?: string): Channel[] {
    this.ensureDerivedIndexes();
    const all = playlist ? this.channelsByPlaylist.get(playlist) ?? [] : this.channels;
    if (group === 'builtin:all' || group === 'builtin:recently-watched') return all;
    if (group === 'builtin:favorites') {
      const favorites = StorageService.getFavorites()
        .map(key => this.channelsByKey.get(key)
          ?.find(channel => !playlist || channel.playlistIds.includes(playlist)))
        .filter((channel): channel is Channel => !!channel);
      favorites.sort((a, b) => this.indexOf(a) - this.indexOf(b));
      return favorites;
    }
    const sourceGroup = group.slice('source:'.length);
    return playlist
      ? this.channelsByPlaylistGroup.get(playlist)?.get(sourceGroup) ?? []
      : this.channelsByGroup.get(sourceGroup) ?? [];
  }

  getGroupCount(group: ChannelGroupId, playlist?: string): number {
    this.ensureDerivedIndexes();
    if (group === 'builtin:all' || group === 'builtin:recently-watched') {
      return playlist ? this.channelsByPlaylist.get(playlist)?.length ?? 0 : this.channels.length;
    }
    if (group === 'builtin:favorites') return this.getByGroup(group, playlist).length;
    const sourceGroup = group.slice('source:'.length);
    return playlist
      ? this.channelsByPlaylistGroup.get(playlist)?.get(sourceGroup)?.length ?? 0
      : this.channelsByGroup.get(sourceGroup)?.length ?? 0;
  }

  searchLocalRanked(
    query: string,
    limit: number,
    playlist?: string,
  ): RankedSearchResult<Channel> {
    if (!query.trim()) return { items: [], hasMore: false };
    this.ensureLocalSearchIndexes();
    const index = playlist
      ? this.channelSearchByPlaylist.get(playlist) ?? []
      : this.channelSearchIndex;
    return rankPreparedTopK(index, query, limit);
  }

  getPlaylistIdsForGroup(group: ChannelGroupId): string[] {
    this.ensureDerivedIndexes();
    const sourceGroup = group.slice('source:'.length);
    const ids: string[] = [];
    this.channelsByPlaylistGroup.forEach((groups, playlistId) => {
      if (groups.has(sourceGroup)) ids.push(playlistId);
    });
    return ids;
  }

  getGroupsForPlaylist(playlist?: string): string[] {
    this.ensureDerivedIndexes();
    return (playlist ? this.groupsByPlaylist.get(playlist) ?? [] : this.groups).slice();
  }

  getGroupKeyForDisplay(display: string): string {
    this.ensureDerivedIndexes();
    return this.groupKeyByDisplay.get(display) ?? display;
  }

  getByIndex(index: number): Channel | null {
    return this.channels[index] ?? null;
  }

  indexOf(channel: Channel): number {
    return this.indexMap.get(channel) ?? -1;
  }

  /** `exactStream` (a channelExactStreamIdentity) picks the entry among
   *  copies that differ only by a token, such as one channel on two accounts;
   *  `stream` (a channelStreamIdentity) picks the entry among channels
   *  sharing the key, such as one URL with and without headers; otherwise the
   *  first entry `prefer` accepts, else the first entry. */
  resolveChannelKey(
    key: string,
    stream?: string,
    prefer?: (channel: Channel) => boolean,
    exactStream?: string,
  ): { channel: Channel; channelIndex: number } | null {
    this.ensureDerivedIndexes();
    const shared = this.channelsByKey.get(key) ?? [];
    const same = stream
      ? shared.filter(channel => channelStreamIdentity(channel) === stream)
      : [];
    const exact = exactStream
      ? same.filter(channel => channelExactStreamIdentity(channel) === exactStream)
      : [];
    const pick = (list: Channel[]) => (prefer && list.find(prefer)) || list[0];
    const channel = pick(exact) ?? pick(same) ?? pick(shared)
      ?? this.channelByLegacyKey.get(key);
    if (!channel) return null;
    const channelIndex = this.indexOf(channel);
    return channelIndex < 0 ? null : { channel, channelIndex };
  }

  /** Index of the channel carrying this per-stream key, or -1. Used to re-resolve
   *  the playing channel after a customization changes the ordering. */
  indexOfKey(key: string): number {
    if (!key) return -1;
    for (let i = 0; i < this.channels.length; i++) {
      if (channelKey(this.channels[i]) === key) return i;
    }
    return -1;
  }

  /** The saved stream (a channelStreamKey) picks its entry among channels
   *  sharing the key, and the saved exact stream (a channelExactStreamKey),
   *  else the saved index, picks among copies that differ only by a token;
   *  without a stream the first entry plays. A legacy key shared by
   *  different streams stays ambiguous. */
  resolveLastChannelIndex(last: LastChannel | null): number {
    const legacyIndex = last ? last.index : 0;
    const stableKey = last?.key ?? '';
    const streamKey = last?.stream ?? '';
    const exactKey = last?.exact ?? '';
    if (!stableKey) return legacyIndex;
    const matches = (channel: Channel | undefined) => !!channel
      && channelKey(channel) === stableKey
      && (!streamKey || channelStreamKey(channel) === streamKey);
    let first = -1;
    let stream = -1;
    let legacy = -1;
    let legacyKey = '';
    let legacyAmbiguous = false;
    for (let i = 0; i < this.channels.length; i++) {
      const channel = this.channels[i];
      const key = channelKey(channel);
      if (key === stableKey) {
        if (matches(channel)) {
          if (exactKey && channelExactStreamKey(channel) === exactKey) return i;
          if (stream < 0) stream = i;
        }
        if (first < 0) first = i;
      } else if (legacyChannelKey(channel) === stableKey) {
        if (legacy < 0) {
          legacy = i;
          legacyKey = key;
        } else if (key !== legacyKey) {
          legacyAmbiguous = true;
        }
      }
    }
    if (stream >= 0) {
      // Token rotated on every copy: the saved index still tells them apart.
      return streamKey && matches(this.channels[legacyIndex]) ? legacyIndex : stream;
    }
    if (first >= 0) return first;
    return legacyAmbiguous ? -1 : legacy;
  }
}

export const PlaylistService = new PlaylistServiceImpl();
