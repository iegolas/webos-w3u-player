// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from './app';
import { PlaylistService } from './services/playlist-service';
import * as embedResolver from './services/embed-resolver';
import * as w3uModel from './components/w3u-model';
import type { Channel } from './types';

type AppInternals = {
  player: { play: ReturnType<typeof vi.fn>; playChannel: ReturnType<typeof vi.fn> };
  w3u: { resumeFocus(): void };
  channelList: { render(): void };
  w3uReturn: boolean;
  w3uResolve: AbortController | null;
  playW3uChannel(channel: Channel): Promise<void> | void;
  onPlayerBack(): void;
  showView(name: string): void;
};

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'w1', name: 'Linked One', logo: '', group: '', url: 'http://host/a.mp4',
    extras: null, playlistIds: [], catchupDays: 0, ...overrides,
  };
}

function makeApp(): AppInternals {
  const app = new App() as unknown as AppInternals;
  app.player = { play: vi.fn(), playChannel: vi.fn() };
  app.w3u = { resumeFocus: vi.fn() };
  app.channelList = { render: vi.fn() };
  app.w3uReturn = false;
  app.w3uResolve = null;
  app.showView = vi.fn();
  return app;
}

describe('App W3U playback routing', () => {
  let app: AppInternals;

  beforeEach(() => {
    app = makeApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('plays a detached direct title without a playlist index', () => {
    vi.spyOn(PlaylistService, 'indexOf').mockReturnValue(-1);
    const title = channel();

    app.playW3uChannel(title);

    expect(app.player.playChannel).toHaveBeenCalledWith(title);
    expect(app.player.play).not.toHaveBeenCalled();
    expect(app.w3uReturn).toBe(true);
  });

  it('keeps an indexed title on the playlist path', () => {
    vi.spyOn(PlaylistService, 'indexOf').mockReturnValue(3);

    app.playW3uChannel(channel());

    expect(app.player.play).toHaveBeenCalledWith(3, undefined, null, false);
    expect(app.player.playChannel).not.toHaveBeenCalled();
    expect(app.w3uReturn).toBe(true);
  });

  it('plays a resolved embed from a linked list without an index', async () => {
    vi.spyOn(PlaylistService, 'indexOf').mockReturnValue(-1);
    vi.spyOn(w3uModel, 'classifyStation').mockReturnValue('resolvable');
    vi.spyOn(embedResolver, 'resolveEmbedStream').mockResolvedValue({
      ok: true,
      url: 'http://host/embed.m3u8',
      kind: 'hls',
      headers: { Referer: 'http://host/page' },
      expiresAt: 0,
    });
    const title = channel({ url: 'http://host/page' });

    await app.playW3uChannel(title);

    expect(app.player.playChannel).toHaveBeenCalledWith(title, undefined, {
      url: 'http://host/embed.m3u8',
      headers: { Referer: 'http://host/page' },
    });
    expect(app.w3uReturn).toBe(true);
  });

  it('returns to the Library from a detached title', () => {
    vi.spyOn(PlaylistService, 'indexOf').mockReturnValue(-1);
    app.playW3uChannel(channel());

    app.onPlayerBack();

    expect(app.showView).toHaveBeenCalledWith('w3u');
    expect(app.w3u.resumeFocus).toHaveBeenCalledOnce();
  });
});
