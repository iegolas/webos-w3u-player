// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '../types';
import { Focus } from '../navigation/focus-scope';
import { HostCapabilityService } from '../services/host-capability';
import { FRAME_LOAD_TIMEOUT_MS, InAppBrowser, frameTarget, type InAppBrowserHandlers } from './in-app-browser';

const URL_A = 'https://host.test/embed/1';

let container: HTMLElement;
let handlers: { [K in keyof InAppBrowserHandlers]: ReturnType<typeof vi.fn> };
let view: InAppBrowser;

// A key as the app routes it: the view acts, then the focus scope reconciles.
function pressKey(action: Action): void {
  document.documentElement.classList.add('keyboard-nav');
  view.handleAction(action);
  Focus.input();
  Focus.flush();
}

function ringKeys(): string[] {
  return Array.from(container.querySelectorAll('.focused')).map((el) => el.getAttribute('data-key') ?? '');
}

const frame = (): HTMLIFrameElement | null => container.querySelector('iframe');
const buttons = (): string[] => Array.from(container.querySelectorAll('[data-focusable]'))
  .map((el) => el.getAttribute('data-key') ?? '');

function openPage(url = URL_A): void {
  expect(view.open(url)).toBe(true);
  view.show();
  Focus.flush();
}

beforeEach(() => {
  HostCapabilityService.reset();
  document.documentElement.classList.remove('keyboard-nav');
  Focus.uninstall();
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  handlers = { onRevealTabBar: vi.fn(), onClose: vi.fn(), onOpenExternal: vi.fn() };
  view = new InAppBrowser(container, handlers as unknown as InAppBrowserHandlers);
  Focus.setBase(() => view.focusScope);
});

afterEach(() => {
  view.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Focus.uninstall();
});

describe('frameTarget', () => {
  it('keeps an http(s) address and names only its host', () => {
    expect(frameTarget('https://host.test/embed/1?x=1')).toEqual({
      src: 'https://host.test/embed/1?x=1',
      host: 'host.test',
    });
    expect(frameTarget('http://host.test:8080/a')?.host).toBe('host.test:8080');
    expect(frameTarget('//host.test/a')?.src).toBe('https://host.test/a');
    expect(frameTarget('host.test/a')?.src).toBe('https://host.test/a');
  });

  it('drops credentials from the frame address and the host', () => {
    const target = frameTarget('https://user1:secret1@host.test/a');
    expect(target?.src).toBe('https://host.test/a');
    expect(target?.host).toBe('host.test');
  });

  it.each(['', '   ', 'javascript:alert(1)', 'mailto:a@host.test', 'ftp://host.test/a', 'file:///a', 'http://'])(
    'refuses %j',
    (input) => {
      expect(frameTarget(input)).toBeNull();
    },
  );
});

describe('InAppBrowser', () => {
  describe('with a page', () => {
    it('renders one frame with the page address and the flags a player needs', () => {
      openPage();
      const el = frame()!;
      expect(container.querySelectorAll('iframe')).toHaveLength(1);
      expect(el.getAttribute('src')).toBe(URL_A);
      expect(el.getAttribute('allow')).toBe('autoplay; fullscreen; encrypted-media');
      expect(el.hasAttribute('allowfullscreen')).toBe(true);
      expect(el.hasAttribute('webkitallowfullscreen')).toBe(true);
      expect(view.active).toBe(true);
    });

    it('shows the host only, never the address or its credentials', () => {
      openPage('https://user1:secret1@host.test/embed/1?token=abc');
      expect(container.querySelector('.ab-host')?.textContent).toBe('host.test');
      expect(frame()!.getAttribute('src')).toBe('https://host.test/embed/1?token=abc');
      expect(container.innerHTML).not.toContain('secret1');
      expect(container.innerHTML).not.toContain('user1');
      expect(container.textContent).not.toContain('/embed/1');
    });

    it('does not focus the frame on open, so the app keeps the keys', () => {
      openPage();
      expect(document.activeElement).not.toBe(frame());
      expect(ringKeys()).toEqual(['reload']);
    });

    it('refuses an address that cannot be framed and keeps what it had', () => {
      openPage();
      expect(view.open('mailto:a@host.test')).toBe(false);
      expect(frame()!.getAttribute('src')).toBe(URL_A);
      expect(view.host).toBe('host.test');
    });

    it('draws the bar and the hint in the expected copy', () => {
      openPage();
      expect(Array.from(container.querySelectorAll('.ab-btn')).map((el) => el.textContent?.trim()))
        .toEqual(['Close', 'Reload', 'Open in TV browser']);
      expect(container.querySelector('.ab-foot')?.textContent).toContain('Point and press OK to use the page. Back closes it.');
      expect(container.querySelector('.ab-foot')?.textContent).toContain('Blank page? Try Open in TV browser.');
      container.querySelectorAll('.ab-btn-icon svg').forEach((svg) => expect(svg).not.toBeNull());
      expect(container.querySelectorAll('.ab-btn-icon svg')).toHaveLength(3);
    });
  });

  describe('without a page', () => {
    it('explains how to open one, with no frame', () => {
      view.show();
      Focus.flush();
      expect(frame()).toBeNull();
      expect(view.active).toBe(false);
      expect(container.querySelector('.ab-empty-title')?.textContent).toBe('Nothing open yet');
      expect(container.querySelector('.ab-empty-hint')?.textContent)
        .toBe('Open a title in the Library, then choose Open in app browser.');
      expect(buttons()).toEqual(['library']);
      expect(ringKeys()).toEqual(['library']);
    });

    it('goes back to the Library on OK, and hands Up to the tab bar', () => {
      view.show();
      Focus.flush();
      pressKey('up');
      expect(handlers.onRevealTabBar).toHaveBeenCalledTimes(1);
      pressKey('select');
      expect(handlers.onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Close', () => {
    it('returns on OK from Close, and on Back from anywhere on the bar', () => {
      openPage();
      pressKey('left');
      expect(ringKeys()).toEqual(['close']);
      pressKey('select');
      expect(handlers.onClose).toHaveBeenCalledTimes(1);
      pressKey('right');
      pressKey('right');
      expect(ringKeys()).toEqual(['tv']);
      pressKey('back');
      expect(handlers.onClose).toHaveBeenCalledTimes(2);
    });

    it('returns on a pointer click', () => {
      openPage();
      container.querySelector<HTMLElement>('[data-key="close"]')!.click();
      expect(handlers.onClose).toHaveBeenCalledTimes(1);
    });

    it('ends the page: the frame is blanked and removed, and the empty state returns', () => {
      openPage();
      const el = frame()!;
      view.close();
      expect(el.getAttribute('src')).toBe('about:blank');
      expect(el.isConnected).toBe(false);
      expect(frame()).toBeNull();
      expect(view.active).toBe(false);
      expect(container.querySelector('.ab-empty')).not.toBeNull();
    });

    it('lets a second page replace the first with a fresh frame', () => {
      openPage();
      const first = frame()!;
      openPage('https://other.test/b');
      expect(first.isConnected).toBe(false);
      expect(container.querySelectorAll('iframe')).toHaveLength(1);
      expect(frame()!.getAttribute('src')).toBe('https://other.test/b');
      expect(container.querySelector('.ab-host')?.textContent).toBe('other.test');
    });
  });

  describe('Reload', () => {
    it('sets the frame address again and shows the loading card until the load', () => {
      openPage();
      frame()!.dispatchEvent(new Event('load'));
      expect(container.querySelector('.ab-overlay')).toBeNull();
      const setAttribute = vi.spyOn(frame()!, 'setAttribute');
      pressKey('select');
      expect(setAttribute).toHaveBeenCalledWith('src', URL_A);
      expect(container.querySelector('.ab-card-loading')).not.toBeNull();
      expect(ringKeys()).toEqual(['reload']);
    });

    it('keeps the same frame, so a page that only reloads keeps its place in the DOM', () => {
      openPage();
      const el = frame()!;
      view.reload();
      expect(frame()).toBe(el);
    });
  });

  describe('Open in TV browser', () => {
    it('hands the address to the host and leaves the page open', () => {
      openPage();
      pressKey('right');
      expect(ringKeys()).toEqual(['tv']);
      pressKey('select');
      expect(handlers.onOpenExternal).toHaveBeenCalledWith(URL_A);
      expect(handlers.onClose).not.toHaveBeenCalled();
      expect(view.active).toBe(true);
    });
  });

  describe('focus', () => {
    it('moves across Close, Reload and Open in TV browser with one ring, stopping at the ends', () => {
      openPage();
      expect(ringKeys()).toEqual(['reload']);
      pressKey('left');
      expect(ringKeys()).toEqual(['close']);
      pressKey('left');
      expect(ringKeys()).toEqual(['close']);
      pressKey('right');
      pressKey('right');
      expect(ringKeys()).toEqual(['tv']);
      pressKey('right');
      expect(ringKeys()).toEqual(['tv']);
      expect(container.querySelectorAll('.focused')).toHaveLength(1);
    });

    it('hands Up from any button to the tab bar', () => {
      openPage();
      pressKey('up');
      pressKey('left');
      pressKey('up');
      expect(handlers.onRevealTabBar).toHaveBeenCalledTimes(2);
    });

    it('keeps the ring when the page re-renders', () => {
      openPage();
      pressKey('right');
      frame()!.dispatchEvent(new Event('load'));
      expect(ringKeys()).toEqual(['tv']);
      expect(container.querySelectorAll('.focused')).toHaveLength(1);
    });

    it('takes the keys back when the pointer moves off a frame that holds the focus', () => {
      openPage();
      const el = frame()!;
      el.focus();
      expect(document.activeElement).toBe(el);
      window.dispatchEvent(new Event('blur'));
      expect(container.querySelector('.ab-foot-active')?.textContent)
        .toContain('The page is using the remote.');
      Focus.pointer(10, 10);
      expect(document.activeElement).not.toBe(el);
      expect(container.querySelector('.ab-foot-active')).toBeNull();
      expect(container.querySelector('.ab-foot')?.textContent).toContain('Back closes it.');
      pressKey('back');
      expect(handlers.onClose).toHaveBeenCalledTimes(1);
    });

    it('keeps the focus in the frame while the pointer is still over it', () => {
      openPage();
      const el = frame()!;
      el.getBoundingClientRect = () =>
        ({ left: 0, top: 100, right: 1920, bottom: 900, width: 1920, height: 800, x: 0, y: 100, toJSON() {} }) as DOMRect;
      el.focus();
      Focus.pointer(500, 400);
      expect(document.activeElement).toBe(el);
      Focus.pointer(500, 50);
      expect(document.activeElement).not.toBe(el);
    });

    it('leaves the focus alone when the pointer moves and the frame does not hold it', () => {
      openPage();
      const root = container.querySelector<HTMLElement>('.ab')!;
      const focus = vi.spyOn(root, 'focus');
      Focus.pointer(10, 10);
      expect(focus).not.toHaveBeenCalled();
    });

    it('does not claim the page has the remote when the window blurs for another reason', () => {
      openPage();
      window.dispatchEvent(new Event('blur'));
      expect(container.querySelector('.ab-foot-active')).toBeNull();
    });
  });

  describe('loading and failure', () => {
    it('shows a loading card until the frame reports load', () => {
      openPage();
      expect(container.querySelector('.ab-card-loading')?.textContent).toContain('Loading…');
      expect(container.querySelector('.ab-session')?.getAttribute('data-phase')).toBe('loading');
      frame()!.dispatchEvent(new Event('load'));
      expect(container.querySelector('.ab-overlay')).toBeNull();
      expect(container.querySelector('.ab-session')?.getAttribute('data-phase')).toBe('loaded');
    });

    it('never fails a page that loaded', () => {
      vi.useFakeTimers();
      openPage();
      frame()!.dispatchEvent(new Event('load'));
      vi.advanceTimersByTime(FRAME_LOAD_TIMEOUT_MS * 2);
      expect(container.querySelector('.ab-card[role="alert"]')).toBeNull();
    });

    it('offers Open in TV browser when no load comes, and logs the reason without the address', () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      openPage('https://user1:secret1@host.test/embed/1');
      vi.advanceTimersByTime(FRAME_LOAD_TIMEOUT_MS - 1);
      expect(container.querySelector('.ab-card[role="alert"]')).toBeNull();
      vi.advanceTimersByTime(1);
      const card = container.querySelector('.ab-card[role="alert"]')!;
      expect(card.querySelector('.ab-card-title')?.textContent).toBe("Couldn't load this page.");
      expect(card.querySelector('.ab-btn')?.textContent?.trim()).toBe('Open in TV browser');
      expect(container.querySelector('.ab-card-loading')).toBeNull();
      const logged = warn.mock.calls.filter((call) => call.includes('event=browser.frame.failed'));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('reason=timeout');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('host.test');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret1');
    });

    it('records the site as unframable and makes Open in TV browser the lead action', () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      openPage('https://user1:secret1@host.test/embed/1');
      expect(HostCapabilityService.getFramable('https://host.test/other')).toBe('unknown');
      vi.advanceTimersByTime(FRAME_LOAD_TIMEOUT_MS);
      expect(HostCapabilityService.getFramable('https://host.test/other')).toBe(false);
      const card = container.querySelector('.ab-card[role="alert"]')!;
      expect(card.querySelector('.ab-card-hint')?.textContent).toBe("This page can't be shown inside the app. Use Open in TV browser.");
      const action = card.querySelector('.ab-btn')!;
      expect(action.classList.contains('ab-btn-primary')).toBe(true);
      expect(action.textContent?.trim()).toBe('Open in TV browser');
      pressKey('down');
      pressKey('select');
      expect(handlers.onOpenExternal).toHaveBeenCalledWith('https://user1:secret1@host.test/embed/1');
    });

    it('does not blame the site when the TV is offline', () => {
      const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      openPage();
      expect(container.querySelector('.ab-card[role="alert"]')).not.toBeNull();
      expect(HostCapabilityService.getFramable(URL_A)).toBe('unknown');
      expect(container.querySelector('.ab-card-hint')?.textContent).not.toContain("can't be shown inside the app");
      online.mockRestore();
    });

    it('never records a page that loaded', () => {
      vi.useFakeTimers();
      openPage();
      frame()!.dispatchEvent(new Event('load'));
      vi.advanceTimersByTime(FRAME_LOAD_TIMEOUT_MS * 2);
      expect(HostCapabilityService.getFramable(URL_A)).toBe('unknown');
    });

    it('reaches the failure button with Down, runs it with OK, and returns with Up', () => {
      vi.useFakeTimers();
      openPage();
      vi.advanceTimersByTime(FRAME_LOAD_TIMEOUT_MS);
      pressKey('down');
      expect(ringKeys()).toEqual(['failed-tv']);
      pressKey('select');
      expect(handlers.onOpenExternal).toHaveBeenCalledWith(URL_A);
      pressKey('up');
      expect(ringKeys()).toEqual(['tv']);
      expect(handlers.onRevealTabBar).not.toHaveBeenCalled();
    });

    it('has no failure button to reach while the page loads', () => {
      openPage();
      pressKey('down');
      expect(ringKeys()).toEqual(['reload']);
    });

    it('recovers when a slow load finally arrives, moving the ring off the vanished button', () => {
      vi.useFakeTimers();
      openPage();
      vi.advanceTimersByTime(FRAME_LOAD_TIMEOUT_MS);
      pressKey('down');
      expect(ringKeys()).toEqual(['failed-tv']);
      frame()!.dispatchEvent(new Event('load'));
      Focus.flush();
      expect(container.querySelector('.ab-card[role="alert"]')).toBeNull();
      expect(ringKeys()).toEqual(['reload']);
    });

    it('restarts the wait on Reload', () => {
      vi.useFakeTimers();
      openPage();
      vi.advanceTimersByTime(FRAME_LOAD_TIMEOUT_MS);
      expect(container.querySelector('.ab-card[role="alert"]')).not.toBeNull();
      pressKey('select');
      expect(container.querySelector('.ab-card[role="alert"]')).toBeNull();
      expect(container.querySelector('.ab-card-loading')).not.toBeNull();
      vi.advanceTimersByTime(FRAME_LOAD_TIMEOUT_MS);
      expect(container.querySelector('.ab-card[role="alert"]')).not.toBeNull();
    });

    it('fails at once when the TV reports it is offline', () => {
      const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      openPage();
      expect(container.querySelector('.ab-card[role="alert"]')?.getAttribute('data-reason')).toBe('offline');
      expect(warn.mock.calls.some((call) => call.includes('reason=offline'))).toBe(true);
      online.mockRestore();
    });

    it('stops waiting once the page is closed', () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      openPage();
      view.close();
      vi.advanceTimersByTime(FRAME_LOAD_TIMEOUT_MS * 2);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
