import { describe, expect, it } from 'vitest';
import {
  createW3UStreamSink,
  isW3UDocument,
  parseW3U,
  repairW3UJson,
} from './w3u-parser';
import { M3UStreamParser, detectPlaylistFormat, parseM3U } from './m3u-parser';

const LIST = JSON.stringify({
  name: 'Example list',
  author: 'Example author',
  info: 'Sample',
  groups: [
    {
      name: 'Movies',
      image: 'https://example.test/movies.png',
      stations: [
        { name: 'Movie One', image: 'https://example.test/one.jpg', url: 'https://cdn.test/one.mp4' },
        { name: 'Movie Two', url: 'https://cdn.test/two.mp4' },
      ],
    },
    {
      name: 'Live',
      stations: [
        { name: 'Channel One', url: 'https://cdn.test/one/index.m3u8' },
      ],
    },
  ],
  stations: [
    { name: 'Loose Station', url: 'https://cdn.test/loose.mp4' },
  ],
});

describe('isW3UDocument', () => {
  it('accepts a list document', () => {
    expect(isW3UDocument(LIST)).toBe(true);
  });

  it('rejects an Xtream player_api payload', () => {
    expect(isW3UDocument('{"user_info":{"username":"u"},"server_info":{}}')).toBe(false);
  });

  it('rejects m3u text', () => {
    expect(isW3UDocument('#EXTM3U\n#EXTINF:-1,A\nhttp://a.test/a.m3u8')).toBe(false);
  });
});

describe('repairW3UJson', () => {
  it('escapes raw newlines inside strings and drops trailing commas', () => {
    const broken = '{"name": "line one\nline two", "groups": [ { "name": "G", "stations": [ {"name": "S", "url": "https://cdn.test/a.mp4"}, ], }, ]}';
    const repaired = JSON.parse(repairW3UJson(broken));
    expect(repaired.name).toBe('line one\nline two');
    expect(repaired.groups[0].stations[0].url).toBe('https://cdn.test/a.mp4');
  });
});

describe('parseW3U', () => {
  it('maps groups and stations onto channels', () => {
    const result = parseW3U(LIST, 'https://example.test/list.w3u');

    expect(result.format).toBe('w3u');
    expect(result.name).toBe('Example list');
    expect(result.groups).toEqual(['Movies', 'Live']);
    expect(result.channels).toHaveLength(4);
    expect(result.headerAttributes['w3u-author']).toBe('Example author');
    expect(result.headerAttributes['w3u-source']).toBe('https://example.test/list.w3u');

    const first = result.channels[0];
    expect(first.name).toBe('Movie One');
    expect(first.logo).toBe('https://example.test/one.jpg');
    expect(first.group).toBe('Movies');
    expect(first.url).toBe('https://cdn.test/one.mp4');
    expect(first.sourceAttributes?.['w3u-image']).toBe('https://example.test/one.jpg');
  });

  it('puts top-level stations in the uncategorized group', () => {
    const result = parseW3U(LIST);
    const loose = result.channels[result.channels.length - 1];
    expect(loose.name).toBe('Loose Station');
    expect(loose.group).toBe('builtin:uncategorized');
  });

  it('turns referer and userAgent into playback headers', () => {
    const stationUrl = 'https://cdn.test/page/embed/1?autoplay=1';
    const doc = JSON.stringify({
      name: 'Headers',
      groups: [
        {
          name: 'Embeds',
          stations: [
            {
              name: 'Embed',
              url: stationUrl,
              referer: 'https://cdn.test/',
              userAgent: 'ExampleAgent/1.0',
              info: 'Synopsis text',
              isHost: true,
            },
          ],
        },
      ],
    });

    const channel = parseW3U(doc).channels[0];
    expect(channel.httpHeaders).toEqual({
      Referer: 'https://cdn.test/',
      'User-Agent': 'ExampleAgent/1.0',
    });
    expect(channel.extras).toEqual({
      'http-referrer': 'https://cdn.test/',
      'http-user-agent': 'ExampleAgent/1.0',
    });
    expect(channel.sourceAttributes?.['w3u-info']).toBe('Synopsis text');
    expect(channel.sourceAttributes?.['w3u-isHost']).toBe('true');
  });

  it('ignores the placeholder userAgent value used by some lists', () => {
    const doc = JSON.stringify({
      stations: [{ name: 'Live', url: 'http://host/a.m3u8', userAgent: 'navigator' }],
    });
    const channel = parseW3U(doc).channels[0];
    expect(channel.httpHeaders).toBeUndefined();
    expect(channel.extras).toBeNull();
  });

  it('accepts a list wrapped in an array', () => {
    const result = parseW3U(`[${LIST},${LIST}]`);
    expect(result.channels.filter(c => c.group === 'Live')).toHaveLength(2);
  });

  it('reports an unparseable document instead of throwing', () => {
    const result = parseW3U('{"groups": [ {"name": "G", "stations": [');
    expect(result.channels).toHaveLength(0);
    expect(result.issues[0].code).toBe('w3u-invalid-json');
  });

  it('skips stations without a url and names them in the issue', () => {
    const result = parseW3U('{"groups":[{"name":"G","stations":[{"name":"Nameless"}]}]}');
    expect(result.channels).toHaveLength(0);
    const issue = result.issues.find(i => i.code === 'w3u-station-without-url');
    expect(issue?.message).toContain('Nameless');
  });

  it('falls back to the url tail when a station has no name', () => {
    const result = parseW3U('{"stations":[{"url":"https://cdn.test/path/My_Movie.mp4"}]}');
    expect(result.channels[0].name).toBe('My_Movie.mp4');
  });
});

describe('playlist dispatch', () => {
  it('detects a w3u document', () => {
    expect(detectPlaylistFormat(LIST).format).toBe('w3u');
  });

  it('parses a w3u document through parseM3U', () => {
    const result = parseM3U(LIST, 'https://example.test/list.w3u');
    expect(result.format).toBe('w3u');
    expect(result.channels).toHaveLength(4);
  });

  it('still rejects unrelated JSON', () => {
    const result = parseM3U('{"foo":1}');
    expect(result.channels).toHaveLength(0);
    expect(result.issues.some(i => i.code === 'wrong-format')).toBe(true);
  });
});

describe('createW3UStreamSink', () => {
  it('diverts a W3U document that arrives in chunks', () => {
    const seen: string[] = [];
    const sink = createW3UStreamSink(text => seen.push(text), 'http://host/list.w3u');
    const half = Math.floor(LIST.length / 2);
    sink.write(LIST.slice(0, half));
    sink.write(LIST.slice(half));
    const result = sink.finish();
    expect(result?.format).toBe('w3u');
    expect(result?.channels).toHaveLength(4);
    expect(seen).toEqual([]);
  });

  it('passes an m3u document straight through', () => {
    const seen: string[] = [];
    const sink = createW3UStreamSink(text => seen.push(text), 'http://host/list.m3u');
    sink.write('#EXTM3U\n#EXTINF:-1,A\nhttp://host/a.m3u8');
    expect(sink.finish()).toBeNull();
    expect(seen.join('')).toContain('#EXTM3U');
  });

  it('passes a non-w3u JSON document through to the m3u parser', () => {
    const seen: string[] = [];
    const sink = createW3UStreamSink(text => seen.push(text), 'source');
    sink.write('{"streams":[]}');
    expect(sink.finish()).toBeNull();
    expect(seen.join('')).toBe('{"streams":[]}');
  });
});

describe('w3u hardening', () => {
  it('drops header values that could inject a second header', () => {
    const doc = JSON.stringify({
      stations: [{ name: 'S', url: 'http://host/a.m3u8', referer: 'http://host/\nX-Injected: 1' }],
    });
    const channel = parseW3U(doc).channels[0];
    expect(channel.httpHeaders).toBeUndefined();
  });

  it('flattens nested groups into their own groups', () => {
    const doc = JSON.stringify({
      groups: [{
        name: 'Folder',
        groups: [{ name: 'Season 1', stations: [{ name: 'Ep 1', url: 'http://host/e1.mp4' }] }],
      }],
    });
    const result = parseW3U(doc);
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0].group).toBe('Season 1');
    expect(result.groups).toEqual(['Season 1']);
  });

  it('collects a group that links to another playlist', () => {
    const doc = JSON.stringify({
      groups: [{ name: 'Linked', image: 'http://host/link.png', url: 'http://host/other.w3u' }],
    });
    const result = parseW3U(doc);
    expect(result.groupLinks).toEqual([
      { name: 'Linked', image: 'http://host/link.png', url: 'http://host/other.w3u' },
    ]);
    expect(result.channels).toHaveLength(0);
    expect(result.issues.some(i => i.code === 'w3u-group-link-unsupported')).toBe(false);
    expect(result.issues.some(i => i.code === 'w3u-empty')).toBe(false);
  });

  it('keeps the children of a linked group that also nests lists', () => {
    const doc = JSON.stringify({
      groups: [{
        name: 'Linked folder',
        url: 'http://host/folder.w3u',
        groups: [{ name: 'Season 1', stations: [{ name: 'Ep 1', url: 'http://host/e1.mp4' }] }],
      }],
    });
    const result = parseW3U(doc);
    expect(result.channels.map(channel => channel.name)).toEqual(['Ep 1']);
    expect(result.channels[0].group).toBe('Season 1');
    expect(result.groupLinks).toEqual([
      { name: 'Linked folder', image: '', url: 'http://host/folder.w3u' },
    ]);
  });

  it('does not follow a link that repeats its parent url', () => {
    const doc = JSON.stringify({
      groups: [{
        name: 'Root',
        url: 'http://host/same.w3u',
        groups: [{ name: 'Child', url: 'http://host/same.w3u' }],
      }],
    });
    const result = parseW3U(doc);
    expect(result.groupLinks).toHaveLength(2);
    expect(result.channels).toHaveLength(0);
  });

  it('keeps the stations and the link of a group that has both', () => {
    const doc = JSON.stringify({
      groups: [{
        name: 'Mixed',
        url: 'http://host/mixed.w3u',
        stations: [{ name: 'One', url: 'http://host/one.mp4' }],
      }],
    });
    const result = parseW3U(doc);
    expect(result.channels.map(channel => channel.name)).toEqual(['One']);
    expect(result.groupLinks).toEqual([
      { name: 'Mixed', image: '', url: 'http://host/mixed.w3u' },
    ]);
  });

  it('records a nested group link with its parent folder', () => {
    const doc = JSON.stringify({
      groups: [{
        name: 'Folder',
        groups: [{ name: 'Season 1', url: 'http://host/season.w3u' }],
      }],
    });
    const result = parseW3U(doc);
    expect(result.groupLinks).toEqual([
      { name: 'Season 1', image: '', url: 'http://host/season.w3u', parentGroup: 'Folder' },
    ]);
  });

  it('parses two groups pointing at each other without recursing', () => {
    const doc = JSON.stringify({
      groups: [
        { name: 'Alpha', url: 'http://host/bravo.w3u' },
        { name: 'Bravo', url: 'http://host/alpha.w3u' },
      ],
    });
    const result = parseW3U(doc);
    expect(result.channels).toHaveLength(0);
    expect(result.groupLinks?.map(link => link.url)).toEqual([
      'http://host/bravo.w3u',
      'http://host/alpha.w3u',
    ]);
  });

  it('still reports a link with an unusable scheme', () => {
    const doc = JSON.stringify({ groups: [{ name: 'Bad', url: 'ftp://host/x.w3u' }] });
    const result = parseW3U(doc);
    expect(result.groupLinks).toBeUndefined();
    expect(result.issues.some(i => i.code === 'w3u-group-link-unsupported')).toBe(true);
  });

  it('does not list a group with no playable stations', () => {
    const result = parseW3U('{"groups":[{"name":"Empty","stations":[]}]}');
    expect(result.groups).toEqual([]);
  });

  it('treats maxChannels 0 as unlimited, like the m3u path', () => {
    const result = parseW3U(LIST, '', { maxChannels: 0 });
    expect(result.channels).toHaveLength(4);
  });

  it('reports truncation once when the cap is reached', () => {
    const result = parseW3U(LIST, '', { maxChannels: 1 });
    expect(result.channels).toHaveLength(1);
    expect(result.issues.filter(i => i.code === 'w3u-truncated')).toHaveLength(1);
  });

  it('marks an empty w3u list as an error, not a warning', () => {
    const issue = parseW3U('{"groups":[]}').issues.find(i => i.code === 'w3u-empty');
    expect(issue?.level).toBe('error');
  });

  it('leaves valid JSON byte-identical', () => {
    expect(repairW3UJson(LIST)).toBe(LIST);
  });

  it('repairs a backslash before a raw control character', () => {
    const result = parseW3U('{"stations":[{"name":"a\\\nb","url":"http://host/a.mp4"}]}');
    expect(result.channels[0]?.name).toBe('a\nb');
  });

  it('fails cleanly when a w3u document reaches the m3u stream parser', () => {
    const parser = new M3UStreamParser('http://host/list.w3u');
    parser.writeComplete(LIST);
    const result = parser.finish();
    expect(result.channels).toHaveLength(0);
    expect(result.issues.some(i => i.code === 'wrong-format')).toBe(true);
  });
});

describe('real-world tolerance', () => {
  it('ignores bytes after the first complete document', () => {
    const doc = '{"stations":[{"name":"S","url":"http://host/a.mp4"}]} }';
    const result = parseW3U(doc);
    expect(result.channels).toHaveLength(1);
    expect(result.issues.some(i => i.code === 'w3u-invalid-json')).toBe(false);
  });

  it('skips empty layout entries without reporting them', () => {
    const doc = '{"stations":[{},{"text-align":"center"},{"name":"S","url":"http://host/a.mp4"}]}';
    const result = parseW3U(doc);
    expect(result.channels).toHaveLength(1);
    expect(result.issues).toHaveLength(0);
  });
});
