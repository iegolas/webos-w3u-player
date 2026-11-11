import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';
import { fetchManifestViaService } from './manifest-service';
import { resolveEmbedStream } from './embed-resolver';

vi.mock('./manifest-service', () => ({ fetchManifestViaService: vi.fn() }));

const service = vi.mocked(fetchManifestViaService);
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

function served(page: string, text: string): void {
  service.mockResolvedValue({ ok: true, status: 200, url: page, text });
}

beforeEach(() => {
  HOSTS.push('page.test');
  service.mockReset();
});

afterEach(() => {
  HOSTS.length = 0;
  ORIGINAL_HOSTS.forEach((host) => HOSTS.push(host));
  vi.useRealTimers();
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

  it('never calls the service for a host outside the resolver list', async () => {
    await expect(resolveEmbedStream('http://elsewhere.test/videoembed/x', {}))
      .resolves.toEqual({ ok: false, reason: 'unsupported_host' });
    expect(service).not.toHaveBeenCalled();
  });

  it('matches subdomains of a resolver host', async () => {
    const page = newPage('www.page.test');
    served(page, optionsPage({ hlsManifestUrl: 'http://cdn.test/master.m3u8' }));
    await expect(resolveEmbedStream(page, {})).resolves.toMatchObject({ ok: true });
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
});
