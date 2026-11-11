import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';
import { isLunaAvailable } from './luna';
import { fetchManifestViaService } from './manifest-service';
import { resolveEmbedStream } from './embed-resolver';

vi.mock('./manifest-service', () => ({ fetchManifestViaService: vi.fn() }));
vi.mock('./luna', () => ({ isLunaAvailable: vi.fn(() => true) }));

const service = vi.mocked(fetchManifestViaService);
const luna = vi.mocked(isLunaAvailable);
const HOSTS = CONFIG.W3U.RESOLVABLE_EMBED_HOSTS as string[];
const ORIGINAL_HOSTS = HOSTS.slice();

const OPTIONS = {
  maxBytes: 512 * 1024,
  timeoutMs: 10 * 1000,
  graceMs: CONFIG.PLAYER.MANIFEST_SERVICE_GRACE_MS,
};

let sequence = 0;
function newPage(host = 'page.test'): string {
  sequence++;
  return `http://${host}/videoembed/v${sequence}`;
}

function optionsPage(metadata: unknown): string {
  const json = JSON.stringify({ flashvars: { metadata } });
  const escaped = json
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
  return `<html><body><div class="player" data-options="${escaped}"></div></body></html>`;
}

function served(page: string, text: string, finalUrl = page): void {
  service.mockResolvedValue({ ok: true, status: 200, url: finalUrl, text });
}

// Mirrors the page's inverse: decode is ((code ^ xor) - shift + 256) % 256.
function obfuscate(source: string, xor = 86, shift = 134): string {
  const values = Array.from(source).map((char) => {
    const code = char.charCodeAt(0);
    return ((code + shift) % 256) ^ xor;
  });
  return `<script>_ls2=[${values.join(',')}];_qf7=${xor};_sj3=${shift};`
    + 'eval(String.fromCharCode(..._ls2));</script>';
}

function bridgePayload(text: string, url = newPage()): string {
  return JSON.stringify({ ok: true, status: 200, url, text });
}

beforeEach(() => {
  HOSTS.push('page.test');
  service.mockReset();
  luna.mockReturnValue(true);
});

afterEach(() => {
  HOSTS.length = 0;
  ORIGINAL_HOSTS.forEach((host) => HOSTS.push(host));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resolveEmbedStream', () => {
  it('prefers the HLS manifest and asks the service for the page with a Referer', async () => {
    const page = newPage();
    served(page, optionsPage({
      hlsManifestUrl: 'http://cdn.test/master.m3u8',
      videos: [{ name: 'low', url: 'http://cdn.test/low.mp4' }],
    }));

    const result = await resolveEmbedStream(page, { 'User-Agent': 'Agent/1' });

    expect(result).toMatchObject({
      ok: true,
      url: 'http://cdn.test/master.m3u8',
      kind: 'hls',
      headers: { Referer: 'http://page.test/', 'User-Agent': 'Agent/1' },
    });
    expect(service).toHaveBeenCalledExactlyOnceWith(page, {
      Referer: 'http://page.test/',
      'User-Agent': 'Agent/1',
    }, { ...OPTIONS, signal: undefined });
  });

  it('falls back to the last MP4 variant', async () => {
    const page = newPage();
    served(page, optionsPage({
      videos: [
        { name: 'mobile', url: 'http://cdn.test/mobile.mp4' },
        { name: 'hd', url: 'http://cdn.test/hd.mp4' },
      ],
    }));

    await expect(resolveEmbedStream(page, {})).resolves.toMatchObject({
      ok: true,
      url: 'http://cdn.test/hd.mp4',
      kind: 'file',
    });
  });

  it('decodes the HTML entities around and inside the JSON', async () => {
    const page = newPage();
    served(page, '<div data-options="{&quot;flashvars&quot;:&nbsp;{&quot;metadata&quot;:'
      + '{&quot;hlsManifestUrl&quot;:&quot;http://cdn.test/a.m3u8?x=1&amp;y=a&#x27;b'
      + '&amp;q=&lt;b&gt;&quot;}}}"></div>');

    await expect(resolveEmbedStream(page, {})).resolves.toMatchObject({
      ok: true,
      url: "http://cdn.test/a.m3u8?x=1&y=a'b&q=<b>",
    });
  });

  it('never fetches a non-embed URL', async () => {
    await expect(resolveEmbedStream('http://elsewhere.test/live/stream', {}))
      .resolves.toEqual({ ok: false, reason: 'unsupported_host' });
    expect(service).not.toHaveBeenCalled();
  });

  it('matches subdomains of a resolver host', async () => {
    const page = newPage('www.page.test');
    served(page, optionsPage({ hlsManifestUrl: 'http://cdn.test/master.m3u8' }));
    await expect(resolveEmbedStream(page, {})).resolves.toMatchObject({ ok: true });
    expect(service).toHaveBeenCalledOnce();
  });

  it('extracts a literal HLS URL from a generic embed page', async () => {
    const page = newPage();
    served(page, '<script>var player = {file: "http://cdn.test/live/a.m3u8?token=x"};</script>');

    await expect(resolveEmbedStream(page, {})).resolves.toMatchObject({
      ok: true,
      url: 'http://cdn.test/live/a.m3u8?token=x',
      kind: 'hls',
    });
  });

  it('falls back to a literal MP4 URL', async () => {
    const page = newPage();
    served(page, '<video src="http://cdn.test/movie.mp4"></video>');

    await expect(resolveEmbedStream(page, {})).resolves.toMatchObject({
      ok: true,
      url: 'http://cdn.test/movie.mp4',
      kind: 'file',
    });
  });

  it('prefers HLS over MP4 when both appear', async () => {
    const page = newPage();
    served(page, '<script>var a = "http://cdn.test/movie.mp4";'
      + 'var b = "http://cdn.test/live.m3u8";</script>');

    await expect(resolveEmbedStream(page, {})).resolves.toMatchObject({
      ok: true,
      url: 'http://cdn.test/live.m3u8',
      kind: 'hls',
    });
  });

  it('decodes the char-array payload with the page formula', async () => {
    const page = newPage();
    const signed = 'http://cdn.test/hls/x.m3u8';
    served(page, obfuscate(
      `var SIGNED_URL = "${signed}";jwplayer.setup({file: SIGNED_URL, type: "hls"});`,
    ));

    await expect(resolveEmbedStream(page, {})).resolves.toMatchObject({
      ok: true,
      url: signed,
      kind: 'hls',
    });
  });

  it('rejects an absurd or malformed char array', async () => {
    const huge = `_ls2=[${new Array(20 * 1000 + 1).fill('1').join(',')}];_qf7=1;_sj3=1;`;
    const oversized = newPage();
    served(oversized, huge);
    await expect(resolveEmbedStream(oversized, {})).resolves.toEqual({
      ok: false,
      reason: 'no_metadata',
    });

    const malformed = newPage();
    served(malformed, '_ls2=[1,nope];_qf7=1;_sj3=1;');
    await expect(resolveEmbedStream(malformed, {})).resolves.toEqual({
      ok: false,
      reason: 'no_metadata',
    });

    const missingKeys = newPage();
    served(missingKeys, '_ls2=[1,2,3];');
    await expect(resolveEmbedStream(missingKeys, {})).resolves.toEqual({
      ok: false,
      reason: 'no_metadata',
    });
  });

  it('resolves a relative media URL against the final page URL', async () => {
    const page = newPage();
    served(page, '<script>jwplayer.setup({file: "/media/live/a.m3u8", type: "hls"});</script>');

    await expect(resolveEmbedStream(page, {})).resolves.toMatchObject({
      ok: true,
      url: 'http://page.test/media/live/a.m3u8',
      kind: 'hls',
    });
  });

  it('uses the redirected URL as the base for a relative media URL', async () => {
    const page = newPage();
    served(page, '<script>src: "ch/a.m3u8";</script>', 'http://redirect.test/play/token');

    await expect(resolveEmbedStream(page, {})).resolves.toMatchObject({
      ok: true,
      url: 'http://redirect.test/play/ch/a.m3u8',
    });
  });

  it('scans a non-listed embed host generically', async () => {
    const page = 'http://embed.test/embed/abc';
    served(page, '<script>const url = "http://cdn.test/stream.m3u8";</script>');

    await expect(resolveEmbedStream(page, {})).resolves.toMatchObject({
      ok: true,
      url: 'http://cdn.test/stream.m3u8',
    });
    expect(service).toHaveBeenCalledOnce();
  });

  it('reports a failed page fetch, keeping an HTTP status code', async () => {
    service.mockResolvedValue({ ok: false, reason: 'http_403' });
    await expect(resolveEmbedStream(newPage(), {})).resolves.toEqual({ ok: false, reason: 'http_403' });

    service.mockResolvedValue({ ok: false, reason: 'network' });
    await expect(resolveEmbedStream(newPage(), {})).resolves.toEqual({ ok: false, reason: 'fetch_failed' });

    service.mockResolvedValue({ ok: false, reason: 'unavailable' });
    await expect(resolveEmbedStream(newPage(), {})).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('reports no_metadata when the page carries no usable stream', async () => {
    const page = newPage();
    served(page, '<html><body>nothing here</body></html>');
    await expect(resolveEmbedStream(page, {})).resolves.toEqual({ ok: false, reason: 'no_metadata' });

    const relative = newPage();
    served(relative, optionsPage({ hlsManifestUrl: '/relative/master.m3u8', videos: [] }));
    await expect(resolveEmbedStream(relative, {})).resolves.toEqual({ ok: false, reason: 'no_metadata' });

    const broken = newPage();
    served(broken, '<div data-options="{not json"></div>');
    await expect(resolveEmbedStream(broken, {})).resolves.toEqual({ ok: false, reason: 'no_metadata' });
  });

  it('caches a resolved stream within its TTL and refetches once it expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const page = newPage();
    served(page, optionsPage({ hlsManifestUrl: 'http://cdn.test/master.m3u8' }));

    const first = await resolveEmbedStream(page, {});
    const second = await resolveEmbedStream(page, {});
    expect(second).toEqual(first);
    expect(service).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    await resolveEmbedStream(page, {});
    expect(service).toHaveBeenCalledTimes(2);
  });

  it('honors an expires parameter and never caches past it', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-01-01T00:00:00Z').getTime();
    vi.setSystemTime(now);
    const page = newPage();
    served(page, optionsPage({ hlsManifestUrl: `http://cdn.test/master.m3u8?expires=${now + 1000}` }));

    await expect(resolveEmbedStream(page, {})).resolves.toMatchObject({ expiresAt: now + 1000 });
    vi.advanceTimersByTime(1001);
    await resolveEmbedStream(page, {});
    expect(service).toHaveBeenCalledTimes(2);
  });

  it('caps the cache at ten minutes even when the URL expires later', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-01-01T00:00:00Z').getTime();
    vi.setSystemTime(now);
    const page = newPage();
    served(page, optionsPage({ hlsManifestUrl: `http://cdn.test/master.m3u8?expires=${now + 60 * 60 * 1000}` }));

    await resolveEmbedStream(page, {});
    vi.advanceTimersByTime(10 * 60 * 1000 - 1);
    await resolveEmbedStream(page, {});
    expect(service).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(2);
    await resolveEmbedStream(page, {});
    expect(service).toHaveBeenCalledTimes(2);
  });

  it('settles as aborted before reaching the service', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(resolveEmbedStream(newPage(), {}, { signal: controller.signal }))
      .resolves.toEqual({ ok: false, reason: 'aborted' });
    expect(service).not.toHaveBeenCalled();
  });

  it('passes the abort signal through and reports an aborted fetch', async () => {
    const controller = new AbortController();
    service.mockImplementation((_url, _headers, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      return Promise.resolve({ ok: false, reason: 'aborted' });
    });
    await expect(resolveEmbedStream(newPage(), {}, { signal: controller.signal }))
      .resolves.toEqual({ ok: false, reason: 'aborted' });
  });

  it('uses the preview bridge when Luna is unavailable', async () => {
    luna.mockReturnValue(false);
    const origin = 'http://preview.test';
    vi.stubGlobal('location', { origin });
    const text = '<script>file: "http://cdn.test/bridge.m3u8"</script>';
    const page = newPage();
    const fetchMock = vi.fn(() => Promise.resolve({
      text: () => Promise.resolve(bridgePayload(text, page)),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveEmbedStream(page, {})).resolves.toMatchObject({
      ok: true,
      url: `/__hls?u=${encodeURIComponent('http://cdn.test/bridge.m3u8')}&r=${encodeURIComponent('http://page.test')}`,
      headers: {},
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${origin}/__embed?url=${encodeURIComponent(page)}`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(service).not.toHaveBeenCalled();
  });

  it('returns the direct URL and playback headers when Luna is available', async () => {
    luna.mockReturnValue(true);
    const page = newPage();
    served(page, optionsPage({ hlsManifestUrl: 'http://cdn.test/direct.m3u8' }));

    await expect(resolveEmbedStream(page, {})).resolves.toMatchObject({
      ok: true,
      url: 'http://cdn.test/direct.m3u8',
      headers: { Referer: 'http://page.test/' },
    });
  });

  it('wraps the resolved stream in the preview HLS proxy off-TV', async () => {
    luna.mockReturnValue(false);
    vi.stubGlobal('location', { origin: 'http://preview.test' });
    const page = newPage();
    const fetchMock = vi.fn(() => Promise.resolve({
      text: () => Promise.resolve(bridgePayload(
        '<script>file: "http://cdn.test/live/a.m3u8?token=x"</script>',
        page,
      )),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveEmbedStream(page, {})).resolves.toEqual({
      ok: true,
      url: `/__hls?u=${encodeURIComponent('http://cdn.test/live/a.m3u8?token=x')}`
        + `&r=${encodeURIComponent('http://page.test')}`,
      kind: 'hls',
      headers: {},
      expiresAt: expect.any(Number),
    });
  });

  it('reports unavailable when the preview bridge fails', async () => {
    luna.mockReturnValue(false);
    vi.stubGlobal('location', { origin: 'http://preview.test' });
    const failing = vi.fn(() => Promise.reject(new Error('bridge down')));
    vi.stubGlobal('fetch', failing);
    await expect(resolveEmbedStream(newPage(), {})).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });

    const malformed = vi.fn(() => Promise.resolve({
      text: () => Promise.resolve('not json'),
    }));
    vi.stubGlobal('fetch', malformed);
    await expect(resolveEmbedStream(newPage(), {})).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('keeps the bridge bounded by timeout and response size', async () => {
    luna.mockReturnValue(false);
    vi.stubGlobal('location', { origin: 'http://preview.test' });
    vi.useFakeTimers();
    const hanging = vi.fn((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }));
    vi.stubGlobal('fetch', hanging);

    const attempt = resolveEmbedStream(newPage(), {});
    await vi.advanceTimersByTimeAsync(10 * 1000 + 1);
    await expect(attempt).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(hanging).toHaveBeenCalledOnce();

    const huge = vi.fn(() => Promise.resolve({
      text: () => Promise.resolve(JSON.stringify({
        ok: true,
        status: 200,
        url: 'http://page.test/videoembed/big',
        text: 'x'.repeat(512 * 1024 + 1),
      })),
    }));
    vi.stubGlobal('fetch', huge);
    await expect(resolveEmbedStream(newPage(), {})).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('logs one outcome event with the host and never the full URL', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const page = newPage();
    served(page, '<script>file: "http://cdn.test/secret.m3u8"</script>');

    await resolveEmbedStream(page, {});
    expect(info).toHaveBeenCalledOnce();
    const success = info.mock.calls[0].join(' ');
    expect(success).toContain('event=embed.resolved');
    expect(success).toContain('kind=hls');
    expect(success).toContain('host=page.test');
    expect(success).not.toContain('cdn.test');
    expect(success).not.toContain(page);

    const broken = newPage();
    served(broken, '<html><body>nothing</body></html>');
    await resolveEmbedStream(broken, {});
    expect(warn).toHaveBeenCalledOnce();
    const failure = warn.mock.calls[0].join(' ');
    expect(failure).toContain('event=embed.resolve.failed');
    expect(failure).toContain('reason=no_metadata');
    expect(failure).toContain('host=page.test');
    expect(failure).not.toContain(broken);
  });
});
