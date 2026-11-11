// @vitest-environment jsdom
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { CONFIG } from '../config';
import type { Action, Channel, PlaylistGroupLink, W3uGroupLink } from '../types';
import { Focus } from '../navigation/focus-scope';
import { fetchAndParseM3U } from '../parsers/m3u-loader';
import { W3U_LINK_LIMITS } from './w3u-model';
import { W3uView, type W3uHandlers } from './w3u-view';

vi.mock('../parsers/m3u-loader', () => ({ fetchAndParseM3U: vi.fn() }));
const fetchMock = vi.mocked(fetchAndParseM3U);

function station(name: string, group: string, patch: Partial<Channel> = {}): Channel {
  return {
    id: '', name, logo: '', group, url: 'http://host/a.mp4', extras: null,
    sourceAttributes: { 'w3u-online': 'true' }, playlistIds: ['p1'],
    catchup: '', catchupSource: '', catchupDays: 0, ...patch,
  };
}

const HOSTS = CONFIG.W3U.RESOLVABLE_EMBED_HOSTS as string[];
const ORIGINAL_HOSTS = HOSTS.slice();

const resolvableStation = (name: string, group: string): Channel => station(name, group, {
  url: 'http://page.test/videoembed/1',
  sourceAttributes: { 'w3u-online': 'true' },
});

const embedStation = (name: string, group: string): Channel => station(name, group, {
  url: 'http://host/page',
  sourceAttributes: { 'w3u-isHost': 'true' },
});

let container: HTMLElement;
let handlers: { [K in keyof W3uHandlers]: ReturnType<typeof vi.fn> };

// A key as the app routes it: the view acts, then the focus scope reconciles.
function pressKey(view: W3uView, action: Action): void {
  document.documentElement.classList.add('keyboard-nav');
  view.handleAction(action);
  Focus.input();
  Focus.flush();
}

function focusedKeys(): string[] {
  return Array.from(container.querySelectorAll('.focused')).map((el) => el.getAttribute('data-key') ?? '');
}

function open(channels: Channel[], links: PlaylistGroupLink[] = [], rootUrls: string[] = []): W3uView {
  const view = new W3uView(container, handlers as unknown as W3uHandlers);
  Focus.setBase(() => view.focusScope);
  view.open(channels, links, rootUrls);
  Focus.flush();
  return view;
}

beforeEach(() => {
  fetchMock.mockReset();
  document.documentElement.classList.remove('keyboard-nav');
  Focus.uninstall();
  Element.prototype.scrollIntoView = vi.fn();
  HOSTS.push('page.test');
  handlers = {
    onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlay: vi.fn(), onCancelPlay: vi.fn(), onOpenInBrowser: vi.fn(),
  };
  container = document.createElement('div');
  document.body.innerHTML = '';
  document.body.appendChild(container);
});

afterEach(() => {
  HOSTS.length = 0;
  ORIGINAL_HOSTS.forEach((host) => HOSTS.push(host));
});

describe('W3uView library', () => {
  const channels = [
    station('Alpha', 'Short\n  Films'),
    station('Bravo', 'Short\n  Films'),
    embedStation('Charlie', 'Other'),
  ];

  it('lists the groups with cleaned names and counts, and the first group as selected', () => {
    open(channels);
    const rows = Array.from(container.querySelectorAll('.w3u-group'));
    expect(rows.map((row) => row.querySelector('.w3u-group-label')?.textContent)).toEqual(['Short Films', 'Other']);
    expect(rows.map((row) => row.querySelector('.w3u-group-count')?.textContent)).toEqual(['2', '1']);
    expect(rows[0].classList.contains('active')).toBe(true);
    expect(container.querySelector('.w3u-pane-title')?.textContent).toContain('Short Films');
  });

  it('shows the first group as a poster grid and puts focus on its first title', () => {
    open(channels);
    expect(Array.from(container.querySelectorAll('.catalog-tile-name')).map((el) => el.textContent))
      .toEqual(['Alpha', 'Bravo']);
    expect(focusedKeys()).toEqual(['t:0']);
  });

  it('marks only browser-only titles for the TV browser', () => {
    const view = open(channels);
    expect(container.querySelector('.w3u-badge')).toBeNull();
    pressKey(view, 'left');
    pressKey(view, 'down');
    pressKey(view, 'select');
    expect(container.querySelector('.w3u-tile-embed .w3u-badge')?.textContent).toContain('Browser');
  });

  it('shows no badge on a title that plays after a short lookup', () => {
    open([resolvableStation('Delta', 'Group A'), embedStation('Charlie', 'Group A')]);
    const tiles = Array.from(container.querySelectorAll('.w3u-tile'));
    expect(tiles[0].querySelector('.w3u-badge')).toBeNull();
    expect(tiles[0].classList.contains('w3u-tile-embed')).toBe(false);
    expect(tiles[1].querySelector('.w3u-badge')).not.toBeNull();
  });

  it('moves between titles, to the group list, and out through the tab bar', () => {
    const view = open(channels);
    pressKey(view, 'right');
    expect(focusedKeys()).toEqual(['t:1']);
    pressKey(view, 'left');
    pressKey(view, 'left');
    expect(focusedKeys()).toEqual(['g:0']);
    pressKey(view, 'up');
    expect(handlers.onRevealTabBar).toHaveBeenCalledTimes(1);
    pressKey(view, 'down');
    expect(focusedKeys()).toEqual(['g:1']);
  });

  it('opens a group from the list and lands on its first title', () => {
    const view = open(channels);
    pressKey(view, 'left');
    pressKey(view, 'down');
    pressKey(view, 'right');
    expect(container.querySelector('.w3u-group.active')?.getAttribute('data-key')).toBe('g:1');
    expect(Array.from(container.querySelectorAll('.catalog-tile-name')).map((el) => el.textContent))
      .toEqual(['Charlie']);
    expect(focusedKeys()).toEqual(['t:0']);
  });

  it('steps Back from a title to its group, then out of the Library', () => {
    const view = open(channels);
    pressKey(view, 'back');
    expect(focusedKeys()).toEqual(['g:0']);
    expect(handlers.onBack).not.toHaveBeenCalled();
    pressKey(view, 'back');
    expect(handlers.onBack).toHaveBeenCalledTimes(1);
  });

  it('keeps stored group names as delivered', () => {
    open(channels);
    expect(channels[0].group).toBe('Short\n  Films');
  });

  it('escapes untrusted names', () => {
    open([station('<img src="x-probe">', 'Group A')]);
    expect(container.querySelector('img[src="x-probe"]')).toBeNull();
    expect(container.querySelector('.catalog-tile-name')?.textContent).toBe('<img src="x-probe">');
  });

  it('keeps one ring on a virtualized grid while moving past its window', () => {
    const many = Array.from({ length: 300 }, (_, i) => station(`Title ${i}`, 'Group A'));
    const view = open(many);
    expect(container.querySelectorAll('.catalog-grid-cell').length).toBeLessThan(300);
    for (let step = 0; step < 40; step++) pressKey(view, 'down');
    expect(focusedKeys()).toEqual(['t:200']);
    pressKey(view, 'up');
    expect(focusedKeys()).toEqual(['t:195']);
  });
});

describe('W3uView detail', () => {
  const info = '\u{1F4DA} Drama/Family\n\n\u{1F4AC} Synopsis:\nA short story.';
  const withInfo = station('Alpha', 'Group A', {
    sourceAttributes: { 'w3u-info': info },
  });

  it('opens a title with its genres and synopsis and a Play action', () => {
    const view = open([withInfo]);
    pressKey(view, 'select');
    const detail = container.querySelector('.w3u-layer-detail')!;
    expect(detail.querySelector('.detail-title')?.textContent).toBe('Alpha');
    expect(detail.querySelector('.detail-meta')?.textContent).toContain('Drama');
    expect(detail.querySelector('.detail-plot')?.textContent).toBe('A short story.');
    expect(detail.querySelector('.detail-btn')?.textContent).toContain('Play');
    expect(detail.querySelector('.w3u-note')).toBeNull();
    expect(focusedKeys()).toEqual(['d:action']);
  });

  it('plays a direct title', () => {
    const view = open([withInfo]);
    pressKey(view, 'select');
    pressKey(view, 'select');
    expect(handlers.onPlay).toHaveBeenCalledWith(withInfo);
    expect(handlers.onOpenInBrowser).not.toHaveBeenCalled();
  });

  it('explains an embed-only title and offers the TV browser instead of Play', () => {
    const embed = embedStation('Charlie', 'Group A');
    const view = open([embed]);
    pressKey(view, 'select');
    const detail = container.querySelector('.w3u-layer-detail')!;
    expect(detail.querySelector('.w3u-note')?.textContent).toContain('TV browser');
    expect(detail.querySelector('.detail-btn')?.textContent).toContain('Open in TV browser');
    pressKey(view, 'select');
    expect(handlers.onOpenInBrowser).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenInBrowser.mock.calls[0][0]).toMatchObject({ name: 'Charlie', kind: 'browser' });
    expect(handlers.onPlay).not.toHaveBeenCalled();
  });

  it('plays a resolvable title with the same Play action and no browser note', () => {
    const resolvable = resolvableStation('Delta', 'Group A');
    const view = open([resolvable]);
    pressKey(view, 'select');
    const detail = container.querySelector('.w3u-layer-detail')!;
    expect(detail.querySelector('.detail-btn')?.textContent).toContain('Play');
    expect(detail.querySelector('.detail-btn')?.textContent).not.toContain('browser');
    expect(detail.querySelector('.w3u-note')).toBeNull();
    pressKey(view, 'select');
    expect(handlers.onPlay).toHaveBeenCalledWith(resolvable);
    expect(handlers.onOpenInBrowser).not.toHaveBeenCalled();
  });

  describe('while a resolvable title starts', () => {
    let finish: () => void;

    function startResolving(): W3uView {
      handlers.onPlay.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
      const view = open([resolvableStation('Delta', 'Group A')]);
      pressKey(view, 'select');
      pressKey(view, 'select');
      return view;
    }

    const button = (): HTMLElement => container.querySelector<HTMLElement>('.w3u-layer-detail .detail-btn')!;

    it('keeps the title and ring and shows Starting on the action', () => {
      startResolving();
      expect(button().textContent).toContain('Starting');
      expect(button().textContent).not.toContain('Play');
      expect(button().getAttribute('aria-busy')).toBe('true');
      expect(button().classList.contains('w3u-busy')).toBe(true);
      expect(container.querySelector('.w3u-layer-detail .detail-title')?.textContent).toBe('Delta');
      expect(focusedKeys()).toEqual(['d:action']);
    });

    it('ignores another OK while starting', () => {
      const view = startResolving();
      pressKey(view, 'select');
      expect(handlers.onPlay).toHaveBeenCalledTimes(1);
    });

    it('returns to Play once the host settles', async () => {
      startResolving();
      finish();
      await Promise.resolve();
      await Promise.resolve();
      expect(button().textContent).toContain('Play');
      expect(button().getAttribute('aria-busy')).toBe('false');
      expect(focusedKeys()).toEqual(['d:action']);
    });

    it('cancels the start on Back and returns to the grid', async () => {
      const view = startResolving();
      pressKey(view, 'back');
      expect(handlers.onCancelPlay).toHaveBeenCalledTimes(1);
      expect(container.querySelector('.w3u-layer-detail')?.classList.contains('catalog-layer-hidden')).toBe(true);
      expect(focusedKeys()).toEqual(['t:0']);
      expect(handlers.onBack).not.toHaveBeenCalled();
      finish();
      await Promise.resolve();
      await Promise.resolve();
      expect(container.querySelector('.w3u-layer-detail')?.textContent?.trim()).toBe('');
    });

    it('does not let a canceled start clear a newer one', async () => {
      const resolvers: Array<() => void> = [];
      handlers.onPlay.mockImplementation(() => new Promise<void>((resolve) => { resolvers.push(resolve); }));
      const view = open([resolvableStation('Delta', 'Group A')]);
      pressKey(view, 'select');
      pressKey(view, 'select');
      pressKey(view, 'back');
      pressKey(view, 'select');
      pressKey(view, 'select');
      expect(resolvers).toHaveLength(2);
      resolvers[0]();
      await Promise.resolve();
      await Promise.resolve();
      expect(button().textContent).toContain('Starting');
    });

    it('does not cancel when nothing is starting', () => {
      const view = open([station('Alpha', 'Group A')]);
      pressKey(view, 'select');
      pressKey(view, 'select');
      pressKey(view, 'back');
      expect(handlers.onCancelPlay).not.toHaveBeenCalled();
    });
  });

  it('does not show Starting for a direct title', () => {
    const view = open([station('Alpha', 'Group A')]);
    handlers.onPlay.mockReturnValue(Promise.resolve());
    pressKey(view, 'select');
    pressKey(view, 'select');
    expect(container.querySelector('.w3u-layer-detail .detail-btn')?.textContent).toContain('Play');
    expect(container.querySelector('.w3u-busy')).toBeNull();
  });

  it('closes on Back and returns the ring to the title it came from', () => {
    const view = open([station('Alpha', 'Group A'), station('Bravo', 'Group A')]);
    pressKey(view, 'right');
    pressKey(view, 'select');
    expect(container.querySelector('.w3u-layer-detail')?.classList.contains('catalog-layer-hidden')).toBe(false);
    pressKey(view, 'back');
    expect(container.querySelector('.w3u-layer-detail')?.classList.contains('catalog-layer-hidden')).toBe(true);
    expect(container.querySelector('.w3u-layer-detail')?.textContent?.trim()).toBe('');
    expect(focusedKeys()).toEqual(['t:1']);
    expect(handlers.onBack).not.toHaveBeenCalled();
  });

  it('hands Up in the detail to the tab bar', () => {
    const view = open([withInfo]);
    pressKey(view, 'select');
    pressKey(view, 'up');
    expect(handlers.onRevealTabBar).toHaveBeenCalledTimes(1);
  });
});

describe('W3uView reopen', () => {
  it('keeps the viewer\u2019s place for the same channel list', () => {
    const channels = [station('Alpha', 'Group A'), station('Bravo', 'Group A')];
    const view = open(channels);
    pressKey(view, 'right');
    view.open(channels);
    Focus.flush();
    expect(focusedKeys()).toEqual(['t:1']);
  });

  it('starts over for a different channel list', () => {
    const view = open([station('Alpha', 'Group A'), station('Bravo', 'Group A')]);
    pressKey(view, 'right');
    view.open([station('Alpha', 'Group A')]);
    Focus.flush();
    expect(focusedKeys()).toEqual(['t:0']);
  });
});

function link(name: string, url: string, image = ''): PlaylistGroupLink {
  return { name, image, url, playlistIds: ['p1'], playlistId: 'p1' };
}

function nested(name: string, url: string): W3uGroupLink {
  return { name, image: '', url };
}

// A station as an M3U sub-list delivers it: no w3u-* marks, no playlist ids.
function listed(name: string, group: string, patch: Partial<Channel> = {}): Channel {
  return station(name, group, { sourceAttributes: {}, playlistIds: [], ...patch });
}

function parsedList(channels: Channel[], groupLinks: W3uGroupLink[] = []): Awaited<ReturnType<typeof fetchAndParseM3U>> {
  return {
    data: {
      channels, groups: [], epgUrl: '', epgUrls: [], headerAttributes: {}, format: 'm3u', issues: [], groupLinks,
    },
  } as unknown as Awaited<ReturnType<typeof fetchAndParseM3U>>;
}

function deferred(): {
  promise: Promise<Awaited<ReturnType<typeof fetchAndParseM3U>>>;
  resolve: (value: Awaited<ReturnType<typeof fetchAndParseM3U>>) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: Awaited<ReturnType<typeof fetchAndParseM3U>>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Awaited<ReturnType<typeof fetchAndParseM3U>>>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const railLabels = (): (string | null)[] =>
  Array.from(container.querySelectorAll('.w3u-group-label')).map((el) => el.textContent);
const tileNames = (): (string | null)[] =>
  Array.from(container.querySelectorAll('.catalog-tile-name')).map((el) => el.textContent);
const stateTitle = (): string | undefined => container.querySelector('.w3u-state-title')?.textContent ?? undefined;
const tags = (): (string | null)[] =>
  Array.from(container.querySelectorAll('.w3u-link-tag')).map((el) => el.textContent);
const crumbTexts = (): (string | null)[] =>
  Array.from(container.querySelectorAll('.w3u-crumb')).map((el) => el.textContent);
const stateHint = (): string | undefined => container.querySelector('.w3u-state-hint')?.textContent ?? undefined;

// From the first title, to the group row `row`.
function goToRow(view: W3uView, row: number): void {
  pressKey(view, 'left');
  for (let step = 0; step < row; step++) pressKey(view, 'down');
}

describe('W3uView linked playlists', () => {
  const ONE = 'http://host/one.m3u';
  const ONE_SECRET = 'http://host/list.m3u?token=secretpass';
  const TWO = 'http://host/two.m3u';
  const root = (): Channel[] => [station('Alpha', 'Group A')];
  const links = (): PlaylistGroupLink[] => [link('Hub One', ONE), link('Hub Two', TWO, 'http://host/two.png')];

  it('lists linked playlists after the groups, with a cover and a chevron, and fetches nothing', () => {
    open(root(), links());
    expect(railLabels()).toEqual(['Group A', 'Hub One', 'Hub Two']);
    const rows = Array.from(container.querySelectorAll('.w3u-group'));
    expect(rows.map((row) => row.classList.contains('w3u-group-link'))).toEqual([false, true, true]);
    expect(rows[1].querySelector('.w3u-group-more svg')).not.toBeNull();
    expect(rows[1].querySelector('.w3u-group-count')).toBeNull();
    expect(rows[1].querySelector('.w3u-link-art')?.textContent).toBe('H');
    expect(rows[1].querySelector('.w3u-link-art img')).toBeNull();
    expect(rows[2].querySelector('.w3u-link-art img')?.getAttribute('src')).toBe('http://host/two.png');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('escapes the name of a linked playlist', () => {
    open(root(), [link('<img src="x-probe">', ONE)]);
    expect(container.querySelector('img[src="x-probe"]')).toBeNull();
    expect(railLabels()).toContain('<img src="x-probe">');
  });

  it('fetches a chosen playlist once and shows its titles with the usual labels', async () => {
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    const view = open(root(), links());
    goToRow(view, 1);
    pressKey(view, 'select');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(ONE, W3U_LINK_LIMITS.TIMEOUT_MS);
    expect(container.querySelector('.w3u-state-spinner')).not.toBeNull();
    expect(stateTitle()).toBe('Loading…');
    expect(container.querySelector('.w3u-group.active')?.getAttribute('data-key')).toBe('g:1');
    expect(container.querySelector('.w3u-grid')).toBeNull();

    pending.resolve(parsedList([listed('Delta', 'Films'), embedStation('Charlie', 'Films')]));
    await settle();

    expect(container.querySelector('.w3u-state')).toBeNull();
    expect(tileNames()).toEqual(['Delta', 'Charlie']);
    expect(container.querySelector('.w3u-pane-title')?.textContent).toContain('Hub One');
    expect(container.querySelector('.w3u-pane-count')?.textContent).toBe('2 titles');
    const tiles = Array.from(container.querySelectorAll('.w3u-tile'));
    expect(tiles[0].querySelector('.w3u-badge')).toBeNull();
    expect(tiles[1].querySelector('.w3u-badge')?.textContent).toContain('Browser');
    expect(focusedKeys()).toEqual(['t:0']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the ring on the row when the viewer moved on before the list arrived', async () => {
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    const view = open(root(), links());
    goToRow(view, 1);
    pressKey(view, 'select');
    pressKey(view, 'down');
    pending.resolve(parsedList([listed('Delta', 'Films')]));
    await settle();
    expect(tileNames()).toEqual(['Delta']);
    expect(focusedKeys()).toEqual(['g:2']);
  });

  it('uses what it already has when a loaded playlist is chosen again', async () => {
    fetchMock.mockResolvedValueOnce(parsedList([listed('Delta', 'Films')]));
    const view = open(root(), links());
    goToRow(view, 1);
    pressKey(view, 'select');
    await settle();
    pressKey(view, 'left');
    expect(focusedKeys()).toEqual(['g:1']);
    pressKey(view, 'select');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(focusedKeys()).toEqual(['t:0']);
  });

  it('steps Back one level at a time: detail, titles, group list, then out', async () => {
    fetchMock.mockResolvedValueOnce(parsedList([listed('Delta', 'Films')]));
    const view = open(root(), links());
    goToRow(view, 1);
    pressKey(view, 'select');
    await settle();
    pressKey(view, 'select');
    expect(container.querySelector('.w3u-detail .detail-title')?.textContent).toBe('Delta');
    pressKey(view, 'back');
    expect(focusedKeys()).toEqual(['t:0']);
    pressKey(view, 'back');
    expect(focusedKeys()).toEqual(['g:1']);
    expect(handlers.onBack).not.toHaveBeenCalled();
    pressKey(view, 'back');
    expect(handlers.onBack).toHaveBeenCalledTimes(1);
  });

  it('hands a linked title to Play like any other', async () => {
    const delta = listed('Delta', 'Films');
    fetchMock.mockResolvedValueOnce(parsedList([delta]));
    const view = open(root(), links());
    goToRow(view, 1);
    pressKey(view, 'select');
    await settle();
    pressKey(view, 'select');
    pressKey(view, 'select');
    expect(handlers.onPlay).toHaveBeenCalledWith(delta);
  });

  describe('a playlist with several groups or links of its own', () => {
    const films = (): Channel[] => [listed('Delta', 'Films'), listed('Echo', 'Series')];

    it('becomes one more level that Back unwinds before leaving the Library', async () => {
      fetchMock.mockResolvedValueOnce(parsedList(films()));
      const view = open(root(), links());
      goToRow(view, 1);
      pressKey(view, 'select');
      await settle();

      expect(railLabels()).toEqual(['Films', 'Series']);
      expect(container.querySelector('.w3u-kicker')?.textContent).toBe('Hub One');
      expect(tileNames()).toEqual(['Delta']);
      expect(focusedKeys()).toEqual(['g:0']);

      pressKey(view, 'select');
      expect(focusedKeys()).toEqual(['t:0']);
      pressKey(view, 'back');
      expect(focusedKeys()).toEqual(['g:0']);
      pressKey(view, 'back');
      expect(railLabels()).toEqual(['Group A', 'Hub One', 'Hub Two']);
      expect(container.querySelector('.w3u-kicker')?.textContent).toBe('Library');
      expect(focusedKeys()).toEqual(['g:1']);
      expect(handlers.onBack).not.toHaveBeenCalled();
      pressKey(view, 'back');
      expect(handlers.onBack).toHaveBeenCalledTimes(1);
    });

    it('opens again from the cache without a second fetch', async () => {
      fetchMock.mockResolvedValueOnce(parsedList(films()));
      const view = open(root(), links());
      goToRow(view, 1);
      pressKey(view, 'select');
      await settle();
      pressKey(view, 'back');
      pressKey(view, 'select');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(railLabels()).toEqual(['Films', 'Series']);
    });

    it('follows links three hops deep, then shows the next links as closed', async () => {
      fetchMock
        .mockResolvedValueOnce(parsedList(films(), [
          nested('Home', 'HTTP://host/root.w3u#top'),
          nested('Self', ONE),
          nested('Sub Two', 'http://host/sub2.m3u'),
          nested('Sub Two again', 'http://host/sub2.m3u'),
          nested('Elsewhere', 'ftp://host/x'),
        ]))
        .mockResolvedValueOnce(parsedList(
          [listed('Foxtrot', 'Docs'), listed('Golf', 'Kids')],
          [nested('Sub Three', 'http://host/sub3.m3u')],
        ))
        .mockResolvedValueOnce(parsedList(
          [listed('Hotel', 'Anime'), listed('India', 'Music')],
          [nested('Sub Four', 'http://host/sub4.m3u'), nested('Sub Two', 'http://host/sub2.m3u')],
        ));
      const view = open(root(), links(), ['http://host/root.w3u']);
      goToRow(view, 1);
      pressKey(view, 'select');
      await settle();
      expect(railLabels()).toEqual(['Films', 'Series', 'Home', 'Self', 'Sub Two']);
      expect(tags()).toEqual(['Already open', 'Already open']);

      pressKey(view, 'down');
      pressKey(view, 'down');
      pressKey(view, 'down');
      pressKey(view, 'down');
      pressKey(view, 'select');
      await settle();
      expect(fetchMock).toHaveBeenLastCalledWith('http://host/sub2.m3u', W3U_LINK_LIMITS.TIMEOUT_MS);
      expect(railLabels()).toEqual(['Docs', 'Kids', 'Sub Three']);
      expect(tags()).toEqual([]);

      pressKey(view, 'down');
      pressKey(view, 'down');
      pressKey(view, 'select');
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(railLabels()).toEqual(['Anime', 'Music', 'Sub Four', 'Sub Two']);
      expect(tags()).toEqual(['Limit reached', 'Already open']);
      expect(container.querySelector('.w3u-kicker')?.textContent).toBe('Sub Three');

      // A closed row names why instead of fetching.
      pressKey(view, 'down');
      pressKey(view, 'down');
      pressKey(view, 'select');
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(container.querySelector('.w3u-state-spinner')).toBeNull();
      expect(stateHint()).toBe('Playlists open up to 3 levels deep, so this one stays closed.');
      expect(focusedKeys()).toEqual(['g:2']);
      pressKey(view, 'down');
      pressKey(view, 'select');
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(stateHint()).toContain('already open');

      pressKey(view, 'back');
      expect(railLabels()).toEqual(['Docs', 'Kids', 'Sub Three']);
      expect(focusedKeys()).toEqual(['g:2']);
      pressKey(view, 'back');
      expect(railLabels()).toEqual(['Films', 'Series', 'Home', 'Self', 'Sub Two']);
      pressKey(view, 'back');
      expect(container.querySelector('.w3u-kicker')?.textContent).toBe('Library');
      expect(handlers.onBack).not.toHaveBeenCalled();
    });

    it('does not fetch a link to the root document or to a list already open', async () => {
      fetchMock.mockResolvedValueOnce(parsedList(films(), [nested('Home', 'http://host/root.w3u')]));
      const view = open(root(), [...links(), link('Root again', 'http://host/root.w3u?k=1')], ['http://host/root.w3u']);
      expect(tags()).toEqual([]);
      goToRow(view, 1);
      pressKey(view, 'select');
      await settle();
      pressKey(view, 'down');
      pressKey(view, 'down');
      pressKey(view, 'select');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(tags()).toEqual(['Already open']);
    });

    it('reuses a list reached by a different path from the session cache', async () => {
      const shared = nested('Shared', 'http://host/shared.m3u');
      fetchMock
        .mockResolvedValueOnce(parsedList(films(), [shared]))
        .mockResolvedValueOnce(parsedList([listed('Delta', 'Films')]))
        .mockResolvedValueOnce(parsedList(films(), [{ ...shared, url: 'HTTP://HOST/shared.m3u#other' }]));
      const view = open(root(), links());
      goToRow(view, 1);
      pressKey(view, 'select');
      await settle();
      pressKey(view, 'down');
      pressKey(view, 'down');
      pressKey(view, 'select');
      await settle();
      expect(tileNames()).toEqual(['Delta']);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      pressKey(view, 'back');
      pressKey(view, 'back');
      pressKey(view, 'down');
      pressKey(view, 'select');
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      pressKey(view, 'down');
      pressKey(view, 'down');
      pressKey(view, 'select');
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(tileNames()).toEqual(['Delta']);
    });

    it('shares the total title cap down the path and says how much is shown', async () => {
      const big = (names: string[]): Channel[] => names.flatMap((group) =>
        Array.from({ length: 600 }, (_, i) => listed(`${group} ${i}`, group)));
      fetchMock
        .mockResolvedValueOnce(parsedList(big(['A1', 'A2']), [nested('Next', 'http://host/n2.m3u')]))
        .mockResolvedValueOnce(parsedList(big(['B1', 'B2']), [nested('Next', 'http://host/n3.m3u')]))
        .mockResolvedValueOnce(parsedList(big(['C1', 'C2'])));
      const view = open([], links());
      pressKey(view, 'select');
      await settle();
      expect(container.querySelector('.w3u-pane-note')?.textContent).toBe('Showing 1000 of 1200 titles.');
      pressKey(view, 'down');
      pressKey(view, 'down');
      pressKey(view, 'select');
      await settle();
      pressKey(view, 'down');
      pressKey(view, 'down');
      pressKey(view, 'select');
      await settle();
      // Only 500 titles fit, all from the first group, so it opens as one grid.
      expect(container.querySelector('.w3u-pane-count')?.textContent).toBe('500 titles');
      expect(container.querySelector('.w3u-pane-note')?.textContent).toBe('Showing 500 of 1200 titles.');
    });

    it('opens a playlist that holds only links as a level of link rows', async () => {
      fetchMock.mockResolvedValueOnce(parsedList([], [nested('Sub Two', 'http://host/sub2.m3u')]));
      const view = open(root(), links());
      goToRow(view, 1);
      pressKey(view, 'select');
      await settle();
      expect(railLabels()).toEqual(['Sub Two']);
      expect(container.querySelector('.w3u-group-link')).not.toBeNull();
      expect(focusedKeys()).toEqual(['g:0']);
    });
  });

  describe('leaving and switching', () => {
    it('drops a fetch in flight when the Library is left', async () => {
      const pending = deferred();
      fetchMock.mockReturnValueOnce(pending.promise);
      const view = open(root(), links());
      goToRow(view, 1);
      pressKey(view, 'select');
      view.abortLoad();
      expect(container.querySelector('.w3u-state-spinner')).toBeNull();
      expect(stateHint()).toBe('Select this playlist to see its titles.');

      pending.resolve(parsedList([listed('Delta', 'Films')]));
      await settle();
      expect(tileNames()).toEqual([]);
      expect(container.querySelector('.w3u-grid')).toBeNull();

      fetchMock.mockResolvedValueOnce(parsedList([listed('Delta', 'Films')]));
      pressKey(view, 'select');
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(tileNames()).toEqual(['Delta']);
    });

    it('shows a playlist that was left mid-load as not yet chosen when the Library reopens', () => {
      const channels = root();
      const linked = links();
      fetchMock.mockReturnValueOnce(deferred().promise);
      const view = open(channels, linked);
      goToRow(view, 1);
      pressKey(view, 'select');
      view.abortLoad();
      view.open(channels, linked);
      Focus.flush();
      expect(container.querySelector('.w3u-state-spinner')).toBeNull();
      expect(stateHint()).toBe('Select this playlist to see its titles.');
    });

    it('ignores a late answer once another playlist is opened', async () => {
      const first = deferred();
      const second = deferred();
      fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const view = open(root(), links());
      goToRow(view, 1);
      pressKey(view, 'select');
      pressKey(view, 'down');
      pressKey(view, 'select');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      first.resolve(parsedList([listed('Stale', 'Films')]));
      second.resolve(parsedList([listed('Fresh', 'Films')]));
      await settle();
      expect(tileNames()).toEqual(['Fresh']);
      expect(container.querySelector('.w3u-group.active')?.getAttribute('data-key')).toBe('g:2');
    });

    it('drops the fetch when an ordinary group is opened instead', async () => {
      const pending = deferred();
      fetchMock.mockReturnValueOnce(pending.promise);
      const view = open(root(), links());
      goToRow(view, 1);
      pressKey(view, 'select');
      pressKey(view, 'up');
      pressKey(view, 'select');
      pending.resolve(parsedList([listed('Delta', 'Films')]));
      await settle();
      expect(tileNames()).toEqual(['Alpha']);
      expect(container.querySelector('.w3u-group.active')?.getAttribute('data-key')).toBe('g:0');
    });
  });

  describe('where the viewer is', () => {
    it('shows no trail at the root, and the playlists opened on the way once inside', async () => {
      fetchMock
        .mockResolvedValueOnce(parsedList([listed('Delta', 'Films'), listed('Echo', 'Series')], [nested('Sub Two', 'http://host/sub2.m3u')]))
        .mockResolvedValueOnce(parsedList([listed('Foxtrot', 'Docs')]));
      const view = open(root(), links());
      expect(container.querySelector('.w3u-crumbs')).toBeNull();
      goToRow(view, 1);
      pressKey(view, 'select');
      await settle();
      expect(crumbTexts()).toEqual(['Library', 'Hub One']);
      expect(container.querySelector('.w3u-crumb-current')?.textContent).toBe('Hub One');

      pressKey(view, 'down');
      pressKey(view, 'down');
      pressKey(view, 'select');
      await settle();
      expect(crumbTexts()).toEqual(['Library', 'Hub One', 'Sub Two']);

      pressKey(view, 'back');
      expect(crumbTexts()).toEqual(['Library', 'Hub One', 'Sub Two']);
      pressKey(view, 'back');
      expect(container.querySelector('.w3u-crumbs')).toBeNull();
      expect(container.querySelector('.w3u-kicker')?.textContent).toBe('Library');
    });

    it('shows the playlist in the trail while its titles fill the pane', async () => {
      fetchMock.mockResolvedValueOnce(parsedList([listed('Delta', 'Films')]));
      const view = open(root(), links());
      goToRow(view, 1);
      pressKey(view, 'select');
      expect(container.querySelector('.w3u-crumbs')).toBeNull();
      await settle();
      expect(crumbTexts()).toEqual(['Library', 'Hub One']);
    });
  });

  describe('addresses stay out of sight', () => {
    const SECRET = 'http://host:8080/get.php?username=secretuser&password=secretpass&type=m3u';

    it('names an unnamed link, or one named by its address, by host only, and never prints the address', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const view = open([], [link('', SECRET), link(SECRET, 'http://other/x')]);
      expect(railLabels()).toEqual(['host', 'host']);
      pressKey(view, 'select');
      await settle();
      expect(fetchMock).toHaveBeenCalledWith(SECRET, W3U_LINK_LIMITS.TIMEOUT_MS);
      expect(stateTitle()).toBe('Couldn\'t load this playlist.');
      expect(container.innerHTML).not.toMatch(/secretuser|secretpass|get\.php/);
    });

    it('numbers a link that has neither a name nor a host', () => {
      open([], [link('', 'http://%/x'), link('', 'http://%/y')]);
      expect(railLabels()).toEqual(['Playlist 1', 'Playlist 2']);
    });

    it('does not print the address of a loaded or closed row either', async () => {
      fetchMock.mockResolvedValueOnce(parsedList([listed('Delta', 'Films'), listed('Echo', 'Series')], [nested('', SECRET)]));
      const view = open([], [link('Hub', ONE_SECRET)]);
      pressKey(view, 'select');
      await settle();
      expect(railLabels()).toEqual(['Films', 'Series', 'host']);
      expect(container.innerHTML).not.toMatch(/secretuser|secretpass|get\.php/);
    });
  });

  it('brings a playlist back from the cache after another one replaced it on screen', async () => {
    fetchMock
      .mockResolvedValueOnce(parsedList([listed('Delta', 'Films')]))
      .mockResolvedValueOnce(parsedList([listed('Echo', 'Films')]));
    const view = open(root(), links());
    goToRow(view, 1);
    pressKey(view, 'select');
    await settle();
    pressKey(view, 'left');
    pressKey(view, 'down');
    pressKey(view, 'select');
    await settle();
    expect(tileNames()).toEqual(['Echo']);
    pressKey(view, 'left');
    pressKey(view, 'up');
    pressKey(view, 'select');
    expect(tileNames()).toEqual(['Delta']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe('when the playlist cannot be loaded', () => {
    it('says the server could not be reached, and retries on the next choice', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const view = open(root(), links());
      goToRow(view, 1);
      pressKey(view, 'select');
      await settle();
      expect(container.querySelector('.w3u-state-spinner')).toBeNull();
      expect(container.querySelector('.w3u-grid')).toBeNull();
      expect(stateTitle()).toBe('Couldn\'t load this playlist.');
      expect(stateHint()).toContain('did not respond or blocked');
      expect(focusedKeys()).toEqual(['g:1']);

      fetchMock.mockResolvedValueOnce(parsedList([listed('Delta', 'Films')]));
      pressKey(view, 'select');
      expect(stateTitle()).toBe('Loading…');
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(tileNames()).toEqual(['Delta']);
    });

    it('says the list cannot be read when the answer is not a playlist', async () => {
      fetchMock.mockRejectedValueOnce(Object.assign(new Error('bad'), {
        details: { stage: 'decode_parse', reason: 'exception' },
      }));
      const view = open(root(), links());
      goToRow(view, 1);
      pressKey(view, 'select');
      await settle();
      expect(stateTitle()).toBe('Couldn\'t load this playlist.');
      expect(stateHint()).toContain('cannot read');
    });

    it('treats an answer with no titles and no links as unreadable', async () => {
      fetchMock.mockResolvedValueOnce(parsedList([]));
      const view = open(root(), links());
      goToRow(view, 1);
      pressKey(view, 'select');
      await settle();
      expect(stateHint()).toContain('cannot read');
    });

    it('does not cache a failure', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const view = open(root(), links());
      goToRow(view, 1);
      pressKey(view, 'select');
      await settle();
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      pressKey(view, 'select');
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it('bounds a long playlist and says so', async () => {
    const many = Array.from({ length: W3U_LINK_LIMITS.MAX_STATIONS + 5 }, (_, i) => listed(`Title ${i}`, 'Films'));
    fetchMock.mockResolvedValueOnce(parsedList(many));
    const view = open(root(), links());
    goToRow(view, 1);
    pressKey(view, 'select');
    await settle();
    expect(container.querySelector('.w3u-pane-count')?.textContent).toMatch(/^1,?000 titles$/);
    expect(container.querySelector('.w3u-pane-note')?.textContent).toBe('Showing 1000 of 1005 titles.');
  });

  describe('a library of links only', () => {
    it('opens with the first row focused and an invitation, and fetches nothing', () => {
      open([], links());
      expect(railLabels()).toEqual(['Hub One', 'Hub Two']);
      expect(focusedKeys()).toEqual(['g:0']);
      expect(stateHint()).toBe('Select this playlist to see its titles.');
      expect(container.querySelector('.w3u-pane-count')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('moves between rows, reaches the tab bar, loads a row, and leaves on Back', async () => {
      fetchMock.mockResolvedValueOnce(parsedList([listed('Delta', 'Films')]));
      const view = open([], links());
      pressKey(view, 'up');
      expect(handlers.onRevealTabBar).toHaveBeenCalledTimes(1);
      pressKey(view, 'down');
      expect(focusedKeys()).toEqual(['g:1']);
      pressKey(view, 'select');
      await settle();
      expect(fetchMock).toHaveBeenCalledWith(TWO, W3U_LINK_LIMITS.TIMEOUT_MS);
      expect(tileNames()).toEqual(['Delta']);
      pressKey(view, 'back');
      expect(focusedKeys()).toEqual(['g:1']);
      pressKey(view, 'back');
      expect(handlers.onBack).toHaveBeenCalledTimes(1);
    });
  });
});
