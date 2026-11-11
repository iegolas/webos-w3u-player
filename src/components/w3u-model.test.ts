import { describe, it, expect } from 'vitest';
import type { Channel } from '../types';
import { UNCATEGORIZED_GROUP } from '../types';
import {
  buildW3uLibrary,
  classifyStation,
  cleanDisplayText,
  hasW3uLibrary,
  isW3uChannel,
  parseStationInfo,
} from './w3u-model';

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

  it('plays a media file directly', () => {
    expect(classifyStation(channel('c', { url: 'http://host/a.mp4' }), hosts)).toBe('direct');
    expect(classifyStation(channel('c', { url: 'http://host/a.mkv?x=1' }), hosts)).toBe('direct');
    expect(classifyStation(channel('c', { url: 'http://host/live/a.m3u8' }), hosts)).toBe('direct');
  });

  it('treats a host page flag as embed unless the URL is a media file', () => {
    const page = w3u('c', { 'w3u-isHost': 'true' }, { url: 'http://host/page' });
    expect(classifyStation(page, hosts)).toBe('embed');
    const media = w3u('c', { 'w3u-isHost': 'true' }, { url: 'http://host/a.mp4' });
    expect(classifyStation(media, hosts)).toBe('direct');
  });

  it('honors an explicit embed flag over a media-looking URL', () => {
    const flagged = w3u('c', { 'w3u-embed': 'true' }, { url: 'http://host/a.mp4' });
    expect(classifyStation(flagged, hosts)).toBe('embed');
    const off = w3u('c', { 'w3u-embed': 'false' }, { url: 'http://host/a.mp4' });
    expect(classifyStation(off, hosts)).toBe('direct');
  });

  it('knows embed hosts and their subdomains', () => {
    expect(classifyStation(channel('c', { url: 'http://embed.test/x' }), hosts)).toBe('embed');
    expect(classifyStation(channel('c', { url: 'http://cdn.embed.test/x' }), hosts)).toBe('embed');
    expect(classifyStation(channel('c', { url: 'http://notembed.test/x' }), hosts)).toBe('direct');
  });

  it('recognizes embed page paths', () => {
    expect(classifyStation(channel('c', { url: 'http://host/videoembed/123' }), hosts)).toBe('embed');
  });

  it('tries an unknown URL as media', () => {
    expect(classifyStation(channel('c', { url: 'http://host/stream/17' }), hosts)).toBe('direct');
  });
});

describe('buildW3uLibrary', () => {
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
    expect(two.kind).toBe('embed');
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
