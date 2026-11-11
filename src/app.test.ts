// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from './app';
import { PlaylistService } from './services/playlist-service';
import { StorageService } from './services/storage-service';
import { EpgService } from './services/epg-service';
import { ChannelHealthService } from './services/channel-health';
import * as embedResolver from './services/embed-resolver';
import * as browserLaunch from './services/browser-launch';
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

  it('hands a generic embed page whose resolve fails to the TV browser', async () => {
    vi.spyOn(PlaylistService, 'indexOf').mockReturnValue(-1);
    const resolve = vi.spyOn(embedResolver, 'resolveEmbedStream')
      .mockResolvedValue({ ok: false, reason: 'no_metadata' });
    const open = vi.spyOn(browserLaunch, 'openInBrowser').mockResolvedValue(true);
    const title = channel({ url: 'http://host/embed/1' });

    expect(w3uModel.classifyStation(title)).toBe('resolvable');
    await app.playW3uChannel(title);

    expect(resolve).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith('http://host/embed/1');
    expect(app.player.playChannel).not.toHaveBeenCalled();
    expect(app.player.play).not.toHaveBeenCalled();
    expect(app.w3uReturn).toBe(false);
  });

  it('does not open the browser when the viewer backs out of a resolve', async () => {
    vi.spyOn(PlaylistService, 'indexOf').mockReturnValue(-1);
    let settle!: (result: embedResolver.EmbedResolveResult) => void;
    vi.spyOn(embedResolver, 'resolveEmbedStream').mockImplementation(
      () => new Promise((resolve) => { settle = resolve; }),
    );
    const open = vi.spyOn(browserLaunch, 'openInBrowser').mockResolvedValue(true);

    const playing = app.playW3uChannel(channel({ url: 'http://host/embed/1' }));
    app.w3uResolve!.abort();
    // The resolver answers after the abort; the attempt is abandoned anyway.
    settle({ ok: false, reason: 'no_metadata' });
    await playing;

    expect(open).not.toHaveBeenCalled();
    expect(app.player.playChannel).not.toHaveBeenCalled();
    expect(app.player.play).not.toHaveBeenCalled();
  });

  it('returns to the Library from a detached title', () => {
    vi.spyOn(PlaylistService, 'indexOf').mockReturnValue(-1);
    app.playW3uChannel(channel());

    app.onPlayerBack();

    expect(app.showView).toHaveBeenCalledWith('w3u');
    expect(app.w3u.resumeFocus).toHaveBeenCalledOnce();
  });
});

type GuideApp = {
  tabBar: { setSections: ReturnType<typeof vi.fn>; setAccounts: ReturnType<typeof vi.fn>; setActive: ReturnType<typeof vi.fn> };
  channelList: { render: ReturnType<typeof vi.fn>; isEditing: boolean };
  player: { stop: ReturnType<typeof vi.fn>; getCurrentIndex: ReturnType<typeof vi.fn>; syncCurrentIndex: ReturnType<typeof vi.fn> };
  movies: { deactivate: ReturnType<typeof vi.fn> };
  series: { deactivate: ReturnType<typeof vi.fn> };
  search: { deactivate: ReturnType<typeof vi.fn> };
  epgGrid: { focusChannel: ReturnType<typeof vi.fn>; render: ReturnType<typeof vi.fn>; resetDay: ReturnType<typeof vi.fn> };
  settings: { render: ReturnType<typeof vi.fn> };
  views: { loading: HTMLElement };
  epgRefreshTimer: ReturnType<typeof setTimeout> | null;
  showView: ReturnType<typeof vi.fn>;
  openEpg: ReturnType<typeof vi.fn>;
  refreshEpgDependentViews: ReturnType<typeof vi.fn>;
  scheduleEpgRefresh: (force?: boolean) => void;
  scheduleEpgReload(): void;
  switchSection(section: string): void;
  handleKey(action: string): void;
  applyGuideSetting(): void;
  loadData(): Promise<void>;
  refreshPlaylistInBackground(): Promise<void>;
  epgSources(): unknown[];
};

describe('App Guide tab setting', () => {
  let app: GuideApp;
  let guide: boolean;

  beforeEach(() => {
    guide = true;
    vi.spyOn(StorageService, 'getShowGuideTab').mockImplementation(() => guide);
    vi.spyOn(StorageService, 'getPlaylists').mockReturnValue([
      { id: 'p1', name: 'P1', url: 'http://host/a.m3u', source: 'm3u' },
    ] as never);
    vi.spyOn(StorageService, 'getManualEpgSources')
      .mockReturnValue([{ url: 'http://host/epg.xml' }] as never);
    vi.spyOn(StorageService, 'getEpgOffsets').mockReturnValue({});
    vi.spyOn(StorageService, 'getEpgRefreshIntervalMs').mockReturnValue(3600000);
    app = new App() as unknown as GuideApp;
    app.tabBar = { setSections: vi.fn(), setAccounts: vi.fn(), setActive: vi.fn() };
    app.channelList = { render: vi.fn(), isEditing: false, handleAction: vi.fn(() => false) } as never;
    Object.assign(app, {
      sidebar: { hide: vi.fn(), visible: false },
      menu: { hide: vi.fn(), visible: false },
      livePreview: { handleAction: vi.fn(() => false), refresh: vi.fn() },
    });
    app.player = { stop: vi.fn(), getCurrentIndex: vi.fn(() => 0), syncCurrentIndex: vi.fn() };
    app.movies = { deactivate: vi.fn() };
    app.series = { deactivate: vi.fn() };
    app.search = { deactivate: vi.fn() };
    app.epgGrid = { focusChannel: vi.fn(), render: vi.fn(), resetDay: vi.fn() };
    app.settings = { render: vi.fn() };
    app.views = { loading: document.createElement('div') };
    app.showView = vi.fn();
    app.refreshEpgDependentViews = vi.fn();
  });

  afterEach(() => {
    if (app.epgRefreshTimer) clearTimeout(app.epgRefreshTimer);
    vi.restoreAllMocks();
  });

  it('boots without a Guide tab when the setting is off', async () => {
    guide = false;
    vi.spyOn(StorageService, 'getPlaylists').mockReturnValue([]);

    await app.loadData();

    expect(app.tabBar.setSections).toHaveBeenCalledWith(false, false, false);
  });

  it('passes the setting on when a background refresh rebuilds the tabs', async () => {
    guide = false;
    vi.spyOn(PlaylistService, 'refresh').mockResolvedValue(undefined as never);
    vi.spyOn(ChannelHealthService, 'initialize').mockResolvedValue(undefined as never);
    Object.assign(app, { sidebar: { refresh: vi.fn(), hide: vi.fn() } });
    vi.spyOn(app as never as { showLiveCategoryNotices(): void }, 'showLiveCategoryNotices').mockImplementation(() => {});

    await app.refreshPlaylistInBackground();

    expect(app.tabBar.setSections).toHaveBeenCalledWith(false, false, false);
  });

  it('sends a Guide switch to Live while the setting is off', () => {
    guide = false;
    const refresh = vi.spyOn(EpgService, 'refresh').mockResolvedValue(true);

    app.switchSection('epg');

    expect(app.showView).toHaveBeenCalledWith('channels');
    expect(app.showView).not.toHaveBeenCalledWith('epg');
    expect(app.tabBar.setActive).toHaveBeenCalledWith('live');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('opens the Guide and refreshes it while the setting is on', () => {
    vi.spyOn(EpgService, 'refresh').mockResolvedValue(true);

    app.switchSection('epg');

    expect(app.showView).toHaveBeenCalledWith('epg');
    expect(EpgService.refresh).toHaveBeenCalledOnce();
  });

  it('ignores the red Guide shortcut while the setting is off', () => {
    guide = false;
    app.openEpg = vi.fn();

    app.handleKey('red');

    expect(app.openEpg).not.toHaveBeenCalled();
    expect(app.player.stop).not.toHaveBeenCalled();
  });

  it('opens the Guide from the red shortcut while the setting is on', () => {
    app.openEpg = vi.fn();

    app.handleKey('red');

    expect(app.openEpg).toHaveBeenCalledOnce();
  });

  it('has no guide sources, reloads, or refresh timer while off', () => {
    vi.useFakeTimers();
    const load = vi.spyOn(EpgService, 'load').mockResolvedValue(undefined);
    guide = false;

    expect(app.epgSources()).toEqual([]);
    app.scheduleEpgRefresh(true);
    expect(app.epgRefreshTimer).toBeNull();
    app.scheduleEpgReload();
    vi.runOnlyPendingTimers();
    expect(load).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('resumes sources, reloads, and the refresh timer once on again', () => {
    vi.useFakeTimers();
    const load = vi.spyOn(EpgService, 'load').mockResolvedValue(undefined);

    expect(app.epgSources()).toHaveLength(1);
    app.scheduleEpgRefresh(true);
    expect(app.epgRefreshTimer).not.toBeNull();
    app.scheduleEpgReload();
    vi.runOnlyPendingTimers();
    expect(load).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('drops the tab and the guide data when turned off, and brings both back when turned on', async () => {
    const reset = vi.spyOn(EpgService, 'reset');
    const load = vi.spyOn(EpgService, 'load').mockResolvedValue(undefined);
    const refresh = vi.spyOn(EpgService, 'refresh').mockResolvedValue(true);
    const schedule = vi.fn();
    app.scheduleEpgRefresh = schedule;

    guide = false;
    app.applyGuideSetting();
    expect(app.tabBar.setSections).toHaveBeenLastCalledWith(false, false, false);
    expect(reset).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();

    guide = true;
    app.applyGuideSetting();
    expect(app.tabBar.setSections).toHaveBeenLastCalledWith(false, false, true);
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledWith(true));
    expect(load).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('leaves the guide data alone when the setting did not change', () => {
    const reset = vi.spyOn(EpgService, 'reset');
    const load = vi.spyOn(EpgService, 'load').mockResolvedValue(undefined);

    app.applyGuideSetting();

    expect(app.tabBar.setSections).toHaveBeenCalledWith(false, false, true);
    expect(reset).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});
