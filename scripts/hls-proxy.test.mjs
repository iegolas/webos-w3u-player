import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { handleHlsRequest, proxyTarget, proxyUrl, rewritePlaylist } from './hls-proxy.mjs';

const MANIFEST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/a.m3u8"',
  '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframes.m3u8"',
  '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
  '#EXT-X-SESSION-DATA:DATA-ID="x",URI="skd://license"',
  '#EXT-X-MAP:URI="/init.mp4"',
  '#EXT-X-STREAM-INF:BANDWIDTH=1',
  'chunks/v1.m3u8',
  '#EXTINF:4,',
  'https://other.test/seg/1.ts?x=1',
  '#EXTINF:4,',
  'seg/2.ts',
  '#EXT-X-ENDLIST',
].join('\n');

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = {};
  res.chunks = [];
  res.writableEnded = false;
  res.destroyed = false;
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    res.headers = headers;
    res.headersSent = true;
    return res;
  };
  res.write = (chunk) => {
    res.chunks.push(Buffer.from(chunk));
    return true;
  };
  res.end = (chunk) => {
    if (chunk) res.chunks.push(Buffer.from(chunk));
    res.writableEnded = true;
  };
  res.destroy = () => {
    res.destroyed = true;
  };
  res.body = () => Buffer.concat(res.chunks);
  return res;
}

async function request(url, { method = 'GET', range, fetchImpl } = {}) {
  const res = fakeRes();
  const req = { method, headers: range ? { range } : {} };
  await handleHlsRequest(req, res, new URL(url, 'http://preview.test'), {
    fetch: fetchImpl,
  });
  return res;
}

describe('rewritePlaylist', () => {
  const referer = 'https://page.test';
  const base = 'https://cdn.test/live/master.m3u8';

  it('rewrites every URI against the playlist and leaves directives alone', () => {
    const out = rewritePlaylist(MANIFEST, base, referer);
    expect(out).toContain(`#EXTM3U`);
    expect(out).toContain('#EXT-X-VERSION:3');
    expect(out).toContain(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="${proxyUrl('https://cdn.test/live/audio/a.m3u8', referer)}"`,
    );
    expect(out).toContain(
      `#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="${proxyUrl('https://cdn.test/live/iframes.m3u8', referer)}"`,
    );
    expect(out).toContain(
      `#EXT-X-KEY:METHOD=AES-128,URI="${proxyUrl('https://cdn.test/live/key.bin', referer)}"`,
    );
    expect(out).toContain(
      `#EXT-X-MAP:URI="${proxyUrl('https://cdn.test/init.mp4', referer)}"`,
    );
    expect(out).toContain(proxyUrl('https://cdn.test/live/chunks/v1.m3u8', referer));
    expect(out).toContain(proxyUrl('https://other.test/seg/1.ts?x=1', referer));
    expect(out).toContain(proxyUrl('https://cdn.test/live/seg/2.ts', referer));
    expect(out).toContain('#EXTINF:4,');
    expect(out).toContain('#EXT-X-ENDLIST');
  });

  it('leaves non-http schemes and fragment references untouched', () => {
    const out = rewritePlaylist(
      ['#EXTM3U', '#EXT-X-SESSION-DATA:DATA-ID="x",URI="skd://license"',
        '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain,x"', '#fragment'].join('\n'),
      base,
      referer,
    );
    expect(out).toContain('URI="skd://license"');
    expect(out).toContain('URI="data:text/plain,x"');
    expect(out).toContain('#fragment');
  });

  it('keeps the referer on every rewritten URI', () => {
    const out = rewritePlaylist('#EXTM3U\nseg/1.ts', base, referer);
    const lines = out.split('\n');
    expect(lines[1]).toBe(proxyUrl('https://cdn.test/live/seg/1.ts', referer));
  });
});

describe('proxyTarget', () => {
  it('accepts http(s) hosts and refuses private or non-http targets', () => {
    expect(proxyTarget('https://cdn.test/a.m3u8')).not.toBeNull();
    expect(proxyTarget('http://127.0.0.1/a.m3u8')).toBeNull();
    expect(proxyTarget('http://[::1]/a.m3u8')).toBeNull();
    expect(proxyTarget('http://10.1.2.3/a.m3u8')).toBeNull();
    expect(proxyTarget('http://100.64.0.1/a.m3u8')).toBeNull();
    expect(proxyTarget('http://169.254.169.254/latest')).toBeNull();
    expect(proxyTarget('file:///etc/passwd')).toBeNull();
    expect(proxyTarget('https://localhost/a.m3u8')).toBeNull();
  });
});

describe('handleHlsRequest', () => {
  it('returns a rewritten manifest with a playlist content type', async () => {
    const fetches = [];
    const fetchImpl = (target, init) => {
      fetches.push([target, init]);
      return Promise.resolve(new Response(MANIFEST, {
        status: 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      }));
    };
    const res = await request(
      '/__hls?u=' + encodeURIComponent('https://cdn.test/live/master.m3u8')
        + '&r=' + encodeURIComponent('https://page.test'),
      { fetchImpl },
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/vnd.apple.mpegurl');
    const text = res.body().toString('utf8');
    expect(text).toContain(proxyUrl('https://cdn.test/live/seg/2.ts', 'https://page.test/'));
    expect(text).not.toContain('https://cdn.test/live/seg/2.ts\n');
    expect(String(fetches[0][0])).toBe('https://cdn.test/live/master.m3u8');
  });

  it('sniffs a playlist when the upstream content type is wrong', async () => {
    const fetchImpl = () => Promise.resolve(new Response(MANIFEST, {
      headers: { 'content-type': 'text/plain' },
    }));
    const res = await request('/__hls?u=' + encodeURIComponent('https://cdn.test/a.m3u8'), { fetchImpl });

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/vnd.apple.mpegurl');
    expect(res.body().toString('utf8')).toContain('/__hls?u=');
  });

  it('streams a segment through with its type and Range response', async () => {
    const fetches = [];
    const fetchImpl = (target, init) => {
      fetches.push([target, init]);
      return Promise.resolve(new Response(Buffer.from('0123456789'), {
        status: 206,
        headers: {
          'content-type': 'video/mp2t',
          'content-range': 'bytes 0-9/100',
          'accept-ranges': 'bytes',
          'content-length': '10',
        },
      }));
    };
    const res = await request(
      '/__hls?u=' + encodeURIComponent('https://cdn.test/seg/1.ts'),
      { range: 'bytes=0-9', fetchImpl },
    );

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-type']).toBe('video/mp2t');
    expect(res.headers['content-range']).toBe('bytes 0-9/100');
    expect(res.headers['content-length']).toBe('10');
    expect(res.body().toString('utf8')).toBe('0123456789');
    expect(fetches[0][1].headers.range).toBe('bytes=0-9');
  });

  it('sends the page referer and its origin upstream', async () => {
    const fetches = [];
    const fetchImpl = (target, init) => {
      fetches.push([target, init]);
      return Promise.resolve(new Response('x', { status: 200, headers: { 'content-type': 'video/mp2t' } }));
    };
    await request(
      '/__hls?u=' + encodeURIComponent('https://cdn.test/a.ts')
        + '&r=' + encodeURIComponent('https://page.test/embed/v1'),
      { fetchImpl },
    );

    expect(fetches[0][1].headers.referer).toBe('https://page.test/embed/v1');
    expect(fetches[0][1].headers.origin).toBe('https://page.test');
  });

  it('defaults the referer to the upstream origin', async () => {
    const fetches = [];
    const fetchImpl = (target, init) => {
      fetches.push([target, init]);
      return Promise.resolve(new Response('x', { status: 200, headers: { 'content-type': 'video/mp2t' } }));
    };
    await request('/__hls?u=' + encodeURIComponent('https://cdn.test/a.ts'), { fetchImpl });

    expect(fetches[0][1].headers.referer).toBe('https://cdn.test/');
    expect(fetches[0][1].headers.origin).toBe('https://cdn.test');
  });

  it('refuses private and loopback targets without fetching', async () => {
    const fetches = [];
    const fetchImpl = (target) => {
      fetches.push(target);
      return Promise.resolve(new Response('x'));
    };
    const res = await request('/__hls?u=' + encodeURIComponent('http://127.0.0.1:8080/a.m3u8'), { fetchImpl });

    expect(res.statusCode).toBe(403);
    expect(res.body().toString('utf8')).toBe('blocked');
    expect(fetches).toHaveLength(0);
  });

  it('re-validates every redirect hop', async () => {
    const fetches = [];
    const fetchImpl = (target) => {
      fetches.push(target);
      return Promise.resolve(new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest' },
      }));
    };
    const res = await request('/__hls?u=' + encodeURIComponent('https://cdn.test/a.m3u8'), { fetchImpl });

    expect(res.statusCode).toBe(403);
    expect(String(fetches[0])).toBe('https://cdn.test/a.m3u8');
    expect(fetches).toHaveLength(1);
  });

  it('resolves relative URIs against the redirect target', async () => {
    const fetches = [];
    const fetchImpl = (target) => {
      fetches.push(target);
      if (fetches.length === 1) {
        return Promise.resolve(new Response(null, {
          status: 302,
          headers: { location: 'https://cdn2.test/live/master.m3u8' },
        }));
      }
      return Promise.resolve(new Response('#EXTM3U\nseg/1.ts', {
        headers: { 'content-type': 'application/x-mpegurl' },
      }));
    };
    const res = await request('/__hls?u=' + encodeURIComponent('https://cdn.test/a.m3u8'), { fetchImpl });

    expect(fetches).toHaveLength(2);
    expect(String(fetches[1])).toBe('https://cdn2.test/live/master.m3u8');
    expect(res.body().toString('utf8'))
      .toContain(proxyUrl('https://cdn2.test/live/seg/1.ts', 'https://cdn.test/'));
  });

  it('rejects a playlist by its declared size', async () => {
    const fetchImpl = () => Promise.resolve(new Response('#EXTM3U', {
      headers: {
        'content-type': 'application/x-mpegurl',
        'content-length': String(3 * 1024 * 1024),
      },
    }));
    const res = await request('/__hls?u=' + encodeURIComponent('https://cdn.test/a.m3u8'), { fetchImpl });
    expect(res.statusCode).toBe(413);
    expect(res.body().toString('utf8')).toBe('playlist_too_large');
  });

  it('rejects a playlist whose body exceeds the cap', async () => {
    const body = '#EXTM3U\n' + 'x'.repeat(2 * 1024 * 1024);
    const fetchImpl = () => Promise.resolve(new Response(body, {
      headers: { 'content-type': 'application/x-mpegurl' },
    }));
    const res = await request('/__hls?u=' + encodeURIComponent('https://cdn.test/a.m3u8'), { fetchImpl });
    expect(res.statusCode).toBe(413);
  });

  it('rejects a non-GET request', async () => {
    const res = await request('/__hls?u=' + encodeURIComponent('https://cdn.test/a.m3u8'), { method: 'POST' });
    expect(res.statusCode).toBe(405);
  });
});
