// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Action, Channel } from '../types';
import { Focus } from '../navigation/focus-scope';
import { W3uView, type W3uHandlers } from './w3u-view';

function station(name: string, group: string, patch: Partial<Channel> = {}): Channel {
  return {
    id: '', name, logo: '', group, url: 'http://host/a.mp4', extras: null,
    sourceAttributes: { 'w3u-online': 'true' }, playlistIds: ['p1'],
    catchup: '', catchupSource: '', catchupDays: 0, ...patch,
  };
}

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

function open(channels: Channel[]): W3uView {
  const view = new W3uView(container, handlers as unknown as W3uHandlers);
  Focus.setBase(() => view.focusScope);
  view.open(channels);
  Focus.flush();
  return view;
}

beforeEach(() => {
  document.documentElement.classList.remove('keyboard-nav');
  Focus.uninstall();
  Element.prototype.scrollIntoView = vi.fn();
  handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlay: vi.fn(), onOpenInBrowser: vi.fn() };
  container = document.createElement('div');
  document.body.innerHTML = '';
  document.body.appendChild(container);
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

  it('marks only embed-only titles for the TV browser', () => {
    const view = open(channels);
    expect(container.querySelector('.w3u-badge')).toBeNull();
    pressKey(view, 'left');
    pressKey(view, 'down');
    pressKey(view, 'select');
    expect(container.querySelector('.w3u-tile-embed .w3u-badge')?.textContent).toContain('Browser');
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
    expect(handlers.onOpenInBrowser.mock.calls[0][0]).toMatchObject({ name: 'Charlie', kind: 'embed' });
    expect(handlers.onPlay).not.toHaveBeenCalled();
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
