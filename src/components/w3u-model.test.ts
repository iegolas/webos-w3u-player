import { afterEach, describe, it, expect, vi } from 'vitest';
import { CONFIG } from '../config';
import type { Channel, ParsedPlaylist, W3uGroupLink } from '../types';
import { UNCATEGORIZED_GROUP } from '../types';
import type { PinnedLinkReason } from '../services/playlist-service';
import {
  buildLinkedList,
  canonicalUrl,
  cutOf,
  buildW3uLibrary,
  classifyLinkFailure,
  classifyStation,
  cleanDisplayText,
  hasW3uLibrary,
  isW3uChannel,
  linkRows,
  LinkFailureError,
  parseStationInfo,
  pinFailureCopy,
  pinKeyOf,
  pinNoticeCopy,
  pinRequestFor,
  W3U_LINK_LIMITS,
  W3uLinkLoader,
} from './w3u-model';

const BROWSER_ONLY = CONFIG.W3U.BROWSER_ONLY_HOSTS as string[];
const ORIGINAL_BROWSER_ONLY = BROWSER_ONLY.slice();

function channel(name: string, patch: Partial<Channel> = {}): Channel {
  return {
    id: '', name, logo: '', group: 'Group A', url: 'http://host/a.m3u8', extras: null,
    playlistIds: ['p1'], catchup: '', catchupSource: '', catchupDays: 0, ...patch,
  };
}

function w3u(name: string, attributes: Record<string, string>, patch: Partial<Channel> = {}): Channel {
  return channel(name, { sourceAttributes: attributes, ...patch });
}

describe('cleanDisplayText', () => {
  it('collapses raw newlines and repeated spaces', () => {
    expect(cleanDisplayText('Short\n  Films \t Two')).toBe('Short Films Two');
  });

  it('folds styled letters back to plain ones', () => {
    expect(cleanDisplayText('𝐒𝐡𝐨𝐫𝐭𝐬 ℙ𝕒𝕣𝕥 𝟚')).toBe('Shorts Part 2');
  });

  it('drops emoji, variation selectors, and zero-width characters', () => {
    expect(cleanDisplayText('\u{1F4FD}\uFE0F Films\u200B')).toBe('Films');
    expect(cleanDisplayText('\u260E Help')).toBe('Help');
  });

  it('keeps accents and trademark signs', () => {
    expect(cleanDisplayText('Café™ Año')).toBe('Café™ Año');
  });

  it('falls back to the collapsed original when only decoration is left', () => {
    expect(cleanDisplayText('\u{1F4DC}')).toBe('\u{1F4DC}');
  });
});

describe('parseStationInfo', () => {
  const info = '\u{1F4DA} Drama/Family/ Drama /Youth/Extra\n\t\n\u{1F4AC} 𝓢𝔶𝓷𝓸𝓹𝓼𝓲𝓼:\n  First line.\nSecond line.';

  it('reads the marked category line as genres, without repeats, capped', () => {
    expect(parseStationInfo(info).genres).toEqual(['Drama', 'Family', 'Youth', 'Extra']);
  });

  it('drops the heading and emoji and keeps the synopsis lines', () => {
    expect(parseStationInfo(info).synopsis).toBe('First line.\nSecond line.');
  });

  it('keeps a heading and text on one line', () => {
    expect(parseStationInfo('\u{1F4AC} Synopsis: Plain words.').synopsis).toBe('Plain words.');
  });

  it('keeps text that merely starts with a word after the speech marker', () => {
    expect(parseStationInfo('\u{1F4AC} A woman gets up.').synopsis).toBe('A woman gets up.');
  });

  it('leaves text without markers as the synopsis', () => {
    expect(parseStationInfo('Drama/Family\nOnly words.')).toEqual({
      genres: [],
      synopsis: 'Drama/Family\nOnly words.',
    });
  });

  it('keeps a blank line between paragraphs', () => {
    expect(parseStationInfo('One.\n\nTwo.').synopsis).toBe('One.\n\nTwo.');
  });

  it('copes with empty info', () => {
    expect(parseStationInfo('')).toEqual({ genres: [], synopsis: '' });
  });
});

describe('classifyStation', () => {
  const hosts = ['embed.test'];
  const browserOnly = ['solo.test'];

  it('plays a media file directly', () => {
    expect(classifyStation(channel('c', { url: 'http://host/a.mp4' }), hosts)).toBe('direct');
    expect(classifyStation(channel('c', { url: 'http://host/a.mkv?x=1' }), hosts)).toBe('direct');
    expect(classifyStation(channel('c', { url: 'http://host/live/a.m3u8' }), hosts)).toBe('direct');
  });

  it('treats a host page flag as a resolvable page unless the URL is a media file', () => {
    const page = w3u('c', { 'w3u-isHost': 'true' }, { url: 'http://host/page' });
    expect(classifyStation(page, hosts, browserOnly)).toBe('resolvable');
    const media = w3u('c', { 'w3u-isHost': 'true' }, { url: 'http://host/a.mp4' });
    expect(classifyStation(media, hosts, browserOnly)).toBe('direct');
  });

  it('honors an explicit embed flag over a media-looking URL', () => {
    const flagged = w3u('c', { 'w3u-embed': 'true' }, { url: 'http://host/a.mp4' });
    expect(classifyStation(flagged, hosts, browserOnly)).toBe('resolvable');
    const off = w3u('c', { 'w3u-embed': 'false' }, { url: 'http://host/a.mp4' });
    expect(classifyStation(off, hosts, browserOnly)).toBe('direct');
  });

  it('tries embed hosts and their subdomains, and leaves other hosts media', () => {
    expect(classifyStation(channel('c', { url: 'http://embed.test/x' }), hosts, browserOnly)).toBe('resolvable');
    expect(classifyStation(channel('c', { url: 'http://cdn.embed.test/x' }), hosts, browserOnly)).toBe('resolvable');
    expect(classifyStation(channel('c', { url: 'http://notembed.test/x' }), hosts, browserOnly)).toBe('direct');
  });

  it('recognizes embed page paths on a generic host', () => {
    expect(classifyStation(channel('c', { url: 'http://host/videoembed/123' }), hosts, browserOnly))
      .toBe('resolvable');
  });

  it('tries an unknown URL as media', () => {
    expect(classifyStation(channel('c', { url: 'http://host/stream/17' }), hosts, browserOnly)).toBe('direct');
  });

  describe('browser-only hosts', () => {
    it('sends an embed page on a browser-only host to the TV browser, subdomains included', () => {
      expect(classifyStation(channel('c', { url: 'http://solo.test/watch/1' }), hosts, browserOnly))
        .toBe('browser');
      expect(classifyStation(channel('c', { url: 'http://cdn.solo.test/watch/1' }), hosts, browserOnly))
        .toBe('browser');
    });

    it('takes the browser-only list it is given, not a fixed name', () => {
      const page = channel('c', { url: 'http://solo.test/watch/1' });
      expect(classifyStation(page, hosts, [])).toBe('resolvable');
      expect(classifyStation(page, hosts, ['other.test'])).toBe('resolvable');
    });

    it('counts a flagged or listed page on a browser-only host', () => {
      const flagged = w3u('c', { 'w3u-embed': 'true' }, { url: 'http://solo.test/x' });
      expect(classifyStation(flagged, hosts, browserOnly)).toBe('browser');
      const hostPage = w3u('c', { 'w3u-isHost': 'true' }, { url: 'http://solo.test/x' });
      expect(classifyStation(hostPage, hosts, browserOnly)).toBe('browser');
      expect(classifyStation(channel('c', { url: 'http://solo.test/x' }), ['solo.test'], browserOnly))
        .toBe('browser');
    });

    it('leaves a media file on a browser-only host direct', () => {
      expect(classifyStation(channel('c', { url: 'http://solo.test/a.mp4' }), hosts, browserOnly))
        .toBe('direct');
      expect(classifyStation(channel('c', { url: 'http://solo.test/stream/17' }), hosts, browserOnly))
        .toBe('direct');
    });
  });
});

describe('W3U host policy', () => {
  it('lists every browser-only host as an embed host, so a page is recognized first', () => {
    CONFIG.W3U.BROWSER_ONLY_HOSTS.forEach((host) => {
      expect(CONFIG.W3U.EMBED_HOSTS).toContain(host);
    });
  });

  it('does not mark a host whose own payload is trusted as browser-only', () => {
    CONFIG.W3U.RESOLVABLE_EMBED_HOSTS.forEach((host) => {
      expect(CONFIG.W3U.BROWSER_ONLY_HOSTS).not.toContain(host);
    });
  });
});

describe('buildW3uLibrary', () => {
  afterEach(() => {
    BROWSER_ONLY.length = 0;
    ORIGINAL_BROWSER_ONLY.forEach((host) => BROWSER_ONLY.push(host));
  });

  it('sorts stations into direct, resolvable, and browser-only kinds', () => {
    BROWSER_ONLY.push('solo.test');
    const library = buildW3uLibrary([
      channel('One', { url: 'http://host/a.mp4' }),
      channel('Two', { url: 'http://page.test/videoembed/1' }),
      w3u('Three', { 'w3u-isHost': 'true' }, { url: 'http://solo.test/watch/1' }),
    ]);
    expect(library.groups[0].stations.map((s) => s.kind)).toEqual(['direct', 'resolvable', 'browser']);
  });

  it('groups stations in source order and keeps stored names untouched', () => {
    const channels = [
      w3u('One', { 'w3u-online': 'true' }, { group: 'Short\n  Films' }),
      w3u('Two', { 'w3u-online': 'true' }, { group: 'Other' }),
      w3u('Three', { 'w3u-online': 'true' }, { group: 'Short\n  Films' }),
    ];
    const library = buildW3uLibrary(channels);
    expect(library.total).toBe(3);
    expect(library.groups.map((g) => g.label)).toEqual(['Short Films', 'Other']);
    expect(library.groups[0].stations.map((s) => s.name)).toEqual(['One', 'Three']);
    expect(channels[0].group).toBe('Short\n  Films');
  });

  it('flags the ungrouped bucket for the host to label', () => {
    const library = buildW3uLibrary([w3u('One', { 'w3u-info': 'x' }, { group: UNCATEGORIZED_GROUP })]);
    expect(library.groups[0].uncategorized).toBe(true);
  });

  it('uses the poster image attribute when the logo is empty', () => {
    const library = buildW3uLibrary([w3u('One', { 'w3u-image': 'http://host/p.jpg' })]);
    expect(library.groups[0].stations[0].poster).toBe('http://host/p.jpg');
  });

  it('carries genres, synopsis, and kind onto each station', () => {
    const library = buildW3uLibrary([
      w3u('One', { 'w3u-info': '\u{1F4DA} Drama\nWords.' }, { url: 'http://host/a.mp4' }),
      w3u('Two', { 'w3u-isHost': 'true' }, { url: 'http://host/page' }),
    ]);
    const [one, two] = library.groups[0].stations;
    expect(one).toMatchObject({ genres: ['Drama'], synopsis: 'Words.', kind: 'direct' });
    expect(two.kind).toBe('resolvable');
  });

  it('keeps unmarked stations of a W3U playlist and leaves other playlists out', () => {
    const channels = [
      w3u('Marked', { 'w3u-info': 'x' }, { playlistIds: ['w'] }),
      channel('Bare', { playlistIds: ['w'] }),
      channel('Plain', { playlistIds: ['m'] }),
    ];
    expect(buildW3uLibrary(channels).groups[0].stations.map((s) => s.name)).toEqual(['Marked', 'Bare']);
  });

  it('is empty without W3U stations', () => {
    expect(buildW3uLibrary([channel('Plain')])).toEqual({ groups: [], total: 0 });
  });
});

describe('W3U detection', () => {
  it('spots a station by any w3u attribute', () => {
    expect(isW3uChannel(w3u('One', { 'w3u-image': 'x' }))).toBe(true);
    expect(isW3uChannel(channel('One', { sourceAttributes: { 'tvg-id': 'x' } }))).toBe(false);
    expect(isW3uChannel(channel('One'))).toBe(false);
  });

  it('reports whether any channel is W3U', () => {
    expect(hasW3uLibrary([channel('Plain')])).toBe(false);
    expect(hasW3uLibrary([channel('Plain'), w3u('One', { 'w3u-info': 'x' })])).toBe(true);
  });
});

const linkTo = (name: string, url: string, image = ''): W3uGroupLink => ({ name, image, url });

function playlist(channels: Channel[], groupLinks: W3uGroupLink[] = []): ParsedPlaylist {
  return {
    channels, groups: [], epgUrl: '', epgUrls: [], headerAttributes: {}, format: 'm3u', issues: [], groupLinks,
  } as unknown as ParsedPlaylist;
}

describe('linked playlists in the library', () => {
  it('adds a row per link after the groups, and opens a library of links alone', () => {
    const links = [linkTo('Hub One', 'http://host/one'), linkTo('Hub Two', 'http://host/two', 'http://host/p.png')];
    const mixed = buildW3uLibrary([w3u('One', { 'w3u-online': 'true' })], links);
    expect(mixed.groups.map((g) => g.label)).toEqual(['Group A', 'Hub One', 'Hub Two']);
    expect(mixed.groups[1].link).toEqual({ url: 'http://host/one', image: '', ready: false, cut: null });
    expect(mixed.groups[2].link?.image).toBe('http://host/p.png');
    expect(mixed.total).toBe(1);
    expect(buildW3uLibrary([], links).groups).toHaveLength(2);
  });

  it('shows the Library for links alone', () => {
    expect(hasW3uLibrary([], [linkTo('Hub', 'http://host/one')])).toBe(true);
    expect(hasW3uLibrary([channel('Plain')], [])).toBe(false);
  });

  it('keeps one row per canonical address and drops addresses that are not web links', () => {
    const rows = linkRows([
      linkTo('One', 'http://host/one'),
      linkTo('One again', ' HTTP://HOST/one#part '),
      linkTo('Script', 'javascript:void(0)'),
      linkTo('File', 'file:///x'),
      linkTo('Other query', 'http://host/one?token=2'),
      linkTo('Styled\n  Name', 'https://host/styled'),
    ]);
    expect(rows.map((row) => row.label)).toEqual(['One', 'Other query', 'Styled Name']);
    expect(rows.map((row) => row.link?.blocked)).toEqual([undefined, undefined, undefined]);
  });

  it('marks a link to a playlist already on the way as open, and keeps its row', () => {
    const rows = linkRows(
      [linkTo('Up', 'http://HOST/open#x'), linkTo('Fresh', 'http://host/fresh')],
      new Set([canonicalUrl('http://host/open')]),
    );
    expect(rows.map((row) => row.link?.blocked)).toEqual(['open', undefined]);
  });

  it('marks every link of a list at the depth limit, and prefers open over limit', () => {
    const rows = linkRows(
      [linkTo('Up', 'http://host/open'), linkTo('Deeper', 'http://host/deeper')],
      new Set([canonicalUrl('http://host/open')]),
      true,
    );
    expect(rows.map((row) => row.link?.blocked)).toEqual(['open', 'limit']);
  });

  it('marks a link to the root document as open', () => {
    const library = buildW3uLibrary([], [linkTo('Home', 'http://host/root.w3u?k=1'), linkTo('Hub', 'http://host/one')], [
      'HTTP://host/root.w3u?k=1#top',
    ]);
    expect(library.groups.map((group) => group.link?.blocked)).toEqual(['open', undefined]);
  });

  it('never uses an address as a row name', () => {
    const rows = linkRows([
      linkTo('', 'http://host:8080/get.php?username=u1&password=p1&type=m3u'),
      linkTo('http://other/get.php?username=u2&password=p2', 'http://other/x'),
      linkTo('Plain', 'http://host/plain'),
    ]);
    expect(rows.map((row) => row.label)).toEqual(['host', 'other', 'Plain']);
    expect(JSON.stringify(rows.map((row) => row.label))).not.toMatch(/password|username|p1|p2/);
  });
});

describe('canonicalUrl', () => {
  it('lowercases scheme and host and drops the fragment', () => {
    expect(canonicalUrl('HTTP://Host/Path#frag')).toBe(canonicalUrl('http://host/Path'));
  });

  it('keeps path case and the whole query, which can tell two lists apart', () => {
    expect(canonicalUrl('http://host/Path')).not.toBe(canonicalUrl('http://host/path'));
    expect(canonicalUrl('http://host/get.php?username=a&password=b')).not.toBe(
      canonicalUrl('http://host/get.php?username=a&password=c'),
    );
    expect(canonicalUrl('http://host/a?x=1#y')).toContain('?x=1');
  });

  it('compares an address the URL parser rejects by its lower-cased host', () => {
    expect(canonicalUrl('http://user:Pw@HOST:bad/a#f')).toBe('http://user:Pw@host:bad/a');
  });
});

describe('classifyLinkFailure', () => {
  it('calls a fetch that never produced bytes a network failure', () => {
    expect(classifyLinkFailure(new TypeError('Failed to fetch'))).toBe('network');
    expect(classifyLinkFailure(new Error('HTTP 404: Not Found'))).toBe('network');
    expect(classifyLinkFailure(Object.assign(new Error('x'), { details: { stage: 'fetch', reason: 'exception' } }))).toBe('network');
    expect(classifyLinkFailure(Object.assign(new Error('x'), { details: { stage: 'read', reason: 'exception' } }))).toBe('network');
    expect(classifyLinkFailure(Object.assign(new Error('x'), { details: { stage: 'finish', reason: 'timeout' } }))).toBe('network');
    expect(classifyLinkFailure(Object.assign(new Error('x'), { details: { stage: 'finish', reason: 'http' } }))).toBe('network');
  });

  it('calls bytes that did not make a playlist a parse failure', () => {
    expect(classifyLinkFailure(Object.assign(new Error('x'), { details: { stage: 'decode_parse', reason: 'exception' } }))).toBe('parse');
    expect(classifyLinkFailure(new SyntaxError('Unexpected token'))).toBe('parse');
    expect(classifyLinkFailure(new LinkFailureError('parse'))).toBe('parse');
  });
});

describe('buildLinkedList', () => {
  it('groups the stations and carries the links', () => {
    const list = buildLinkedList(playlist(
      [channel('One', { group: 'A' }), channel('Two', { group: 'B' }), channel('Three', { group: 'A' })],
      [linkTo('Hub', 'http://host/one')],
    ));
    expect(list.groups.map((g) => g.stations.length)).toEqual([2, 1]);
    expect(list.links).toHaveLength(1);
    expect(list.total).toBe(3);
    expect(list.found).toBe(3);
    expect(cutOf(list)).toBeNull();
  });

  it('keeps no more than the station limit and says it cut', () => {
    const many = Array.from({ length: W3U_LINK_LIMITS.MAX_STATIONS + 3 }, (_, i) => channel(`Title ${i}`));
    const list = buildLinkedList(playlist(many));
    expect(list.total).toBe(W3U_LINK_LIMITS.MAX_STATIONS);
    expect(list.groups[0].stations).toHaveLength(W3U_LINK_LIMITS.MAX_STATIONS);
    expect(cutOf(list)).toEqual({ shown: W3U_LINK_LIMITS.MAX_STATIONS, found: W3U_LINK_LIMITS.MAX_STATIONS + 3 });
  });

  it('keeps no more than the room it is given', () => {
    const list = buildLinkedList(playlist(Array.from({ length: 50 }, (_, i) => channel(`Title ${i}`))), 20);
    expect(list.total).toBe(20);
    expect(cutOf(list)).toEqual({ shown: 20, found: 50 });
  });

  it('leaves room for a title in every list on the way down', () => {
    const room = W3U_LINK_LIMITS.MAX_TOTAL_STATIONS - (W3U_LINK_LIMITS.MAX_DEPTH - 1) * W3U_LINK_LIMITS.MAX_STATIONS;
    expect(room).toBeGreaterThan(0);
  });
});

describe('W3uLinkLoader', () => {
  const fetcher = (result: ParsedPlaylist = playlist([channel('One')])) =>
    vi.fn(() => Promise.resolve({ data: result }));

  it('fetches with the timeout and serves a repeat from the session cache', async () => {
    const fetch = fetcher();
    const loader = new W3uLinkLoader(fetch);
    const first = await loader.load('http://host/one');
    expect(fetch).toHaveBeenCalledWith('http://host/one', W3U_LINK_LIMITS.TIMEOUT_MS);
    expect(await loader.load('http://host/one')).toBe(first);
    expect(loader.get('http://host/one')).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shares one cache entry between spellings of the same address', async () => {
    const fetch = fetcher();
    const loader = new W3uLinkLoader(fetch);
    const first = await loader.load('http://host/one?k=1');
    expect(await loader.load('HTTP://HOST/one?k=1#elsewhere')).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    await loader.load('http://host/one?k=2');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps no more titles than the total cap, dropping the least recently used', async () => {
    const big = playlist(Array.from({ length: W3U_LINK_LIMITS.MAX_STATIONS }, (_, i) => channel(`Title ${i}`)));
    const loader = new W3uLinkLoader(fetcher(big));
    await loader.load('http://host/a');
    await loader.load('http://host/b');
    await loader.load('http://host/c');
    expect(loader.get('http://host/a')).toBeUndefined();
    expect(loader.get('http://host/b')).toBeDefined();
    expect(loader.get('http://host/c')).toBeDefined();
  });

  it('keeps a bounded number of lists, dropping the least recently used', async () => {
    const fetch = fetcher();
    const loader = new W3uLinkLoader(fetch);
    for (let i = 0; i < W3U_LINK_LIMITS.CACHE_ENTRIES; i++) await loader.load(`http://host/${i}`);
    loader.get('http://host/0');
    await loader.load('http://host/new');
    expect(loader.get('http://host/0')).toBeDefined();
    expect(loader.get('http://host/1')).toBeUndefined();
    expect(loader.get('http://host/new')).toBeDefined();
  });

  it('retires a load in flight when another starts or abort is called', async () => {
    const answers: Array<(value: { data: ParsedPlaylist }) => void> = [];
    const loader = new W3uLinkLoader(() => new Promise((resolve) => { answers.push(resolve); }));
    const first = loader.load('http://host/one');
    const second = loader.load('http://host/two');
    answers[0]({ data: playlist([channel('Old')]) });
    answers[1]({ data: playlist([channel('New')]) });
    expect(await first).toBeNull();
    expect((await second)?.groups[0].stations[0].name).toBe('New');
    expect(loader.get('http://host/one')).toBeUndefined();

    const third = loader.load('http://host/three');
    loader.abort();
    answers[2]({ data: playlist([channel('Late')]) });
    expect(await third).toBeNull();
    expect(loader.get('http://host/three')).toBeUndefined();
  });

  it('rejects with the failure class, and not for a retired load', async () => {
    const loader = new W3uLinkLoader(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(loader.load('http://host/one')).rejects.toMatchObject({ reason: 'network' });
    let fail!: (error: unknown) => void;
    const slow = new W3uLinkLoader(() => new Promise((_, reject) => { fail = reject; }));
    const retired = slow.load('http://host/one');
    slow.abort();
    fail(new TypeError('Failed to fetch'));
    expect(await retired).toBeNull();
  });

  it('rejects an answer with no stations and no links as a parse failure, and does not keep it', async () => {
    const fetch = fetcher(playlist([]));
    const loader = new W3uLinkLoader(fetch);
    await expect(loader.load('http://host/one')).rejects.toMatchObject({ reason: 'parse' });
    expect(loader.get('http://host/one')).toBeUndefined();
    const linksOnly = new W3uLinkLoader(fetcher(playlist([], [linkTo('Hub', 'http://host/two')])));
    expect((await linksOnly.load('http://host/one'))?.links).toHaveLength(1);
  });
});

describe('showing a group in Live', () => {
  const rows = (links: W3uGroupLink[], path: string[] = [], atLimit = false) => linkRows(links, new Set(path), atLimit);
  const hub: W3uGroupLink = { name: 'Hub', image: '', url: 'http://host/hub.m3u' };

  it('adds a linked list whole, one level below the list it sits in', () => {
    const [row] = rows([hub]);
    expect(pinRequestFor(row, 'Hub', null, 0)).toEqual({ url: 'http://host/hub.m3u', group: '', name: 'Hub', depth: 1 });
    expect(pinRequestFor(row, 'Hub', 'http://host/a.m3u', 2)).toEqual({
      url: 'http://host/hub.m3u', group: '', name: 'Hub', depth: 3,
    });
  });

  it('adds a station group of an opened list by that list\u2019s address', () => {
    const { groups } = buildW3uLibrary([w3u('Alpha', { 'w3u-online': 'true' }, { group: 'MLB \u26BE' })]);
    expect(pinRequestFor(groups[0], 'MLB', 'http://host/a.m3u', 1)).toEqual({
      url: 'http://host/a.m3u', group: 'MLB \u26BE', name: 'MLB', depth: 1,
    });
  });

  it('offers nothing for the root\u2019s own groups or a closed link', () => {
    const { groups } = buildW3uLibrary([w3u('Alpha', { 'w3u-online': 'true' })]);
    expect(pinRequestFor(groups[0], 'Group A', null, 0)).toBeNull();
    expect(pinRequestFor(rows([hub], ['http://host/hub.m3u'])[0], 'Hub', null, 0)).toBeNull();
    expect(pinRequestFor(rows([hub], [], true)[0], 'Hub', 'http://host/a.m3u', 3)).toBeNull();
  });

  it('keys a pin by canonical address and group', () => {
    expect(pinKeyOf({ url: 'HTTP://Host/a.m3u#top', group: 'G' })).toBe(pinKeyOf({ url: 'http://host/a.m3u', group: 'G' }));
    expect(pinKeyOf({ url: 'http://host/a.m3u', group: '' })).not.toBe(pinKeyOf({ url: 'http://host/a.m3u', group: 'G' }));
  });

  it('words every refusal for a viewer, never as a code', () => {
    const reasons: PinnedLinkReason[] = [
      'invalid', 'depth', 'budget', 'limit', 'fetch_failed', 'group_missing', 'canceled', 'storage',
    ];
    const copy = reasons.map((reason) => pinFailureCopy(reason));
    expect(new Set(copy).size).toBe(reasons.length);
    copy.forEach((text) => {
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/[a-z]+_[a-z]+/);
    });
  });

  it('names the group in a notice, and falls back to the refusal wording', () => {
    const base = { url: 'http://host/a.m3u', group: 'MLB \u26BE', name: 'MLB \u26BE' };
    expect(pinNoticeCopy({ ...base, reason: 'group_missing' })).toBe('MLB is no longer in its playlist and was removed from Live.');
    expect(pinNoticeCopy({ ...base, reason: 'fetch_failed' })).toBe("Couldn't load MLB for Live.");
    expect(pinNoticeCopy({ ...base, reason: 'budget' })).toBe("MLB didn't fit in Live and was skipped.");
    expect(pinNoticeCopy({ ...base, reason: 'limit' })).toBe(pinFailureCopy('limit'));
  });
});
