import type { Action } from '../types';
import { Focus, type FocusScope, type Via } from '../navigation/focus-scope';
import { FocusRing, ringShown } from '../navigation/focus-ring';
import { InputMode } from '../navigation/input-mode';
import { isFocusMove } from '../navigation/spatial-nav';
import { focusWithoutScroll, html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { createLogger } from '../utils/logger';
import { t } from '../i18n';
import { HostCapabilityService } from '../services/host-capability';

const log = createLogger('InAppBrowser');

// A page that has not fired `load` by now gets the failure panel. `load` waits
// for every ad and tracker, so a working page can take a while: the panel is a
// card over the frame, not a cover, and goes away if the load arrives.
export const FRAME_LOAD_TIMEOUT_MS = 25000;

const CLOSE_KEY = 'close';
const RELOAD_KEY = 'reload';
const TV_KEY = 'tv';
const FAILED_TV_KEY = 'failed-tv';
const LIBRARY_KEY = 'library';
const BAR_KEYS = [CLOSE_KEY, RELOAD_KEY, TV_KEY];

const HTTP_SCHEME = /^https?:\/\//i;
// A leading scheme with a non-port name: `mailto:`, `javascript:`, `ftp:`.
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:(?![0-9])/i;

// Inline SVGs, as the TV font has no glyphs for symbols like arrows or crosses.
const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
const RELOAD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/></svg>';
const EXTERNAL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
const LIBRARY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4v16M10 4v16M15.5 5.5l4 14"/></svg>';

type Phase = 'empty' | 'loading' | 'loaded' | 'failed';
type FailReason = 'timeout' | 'offline';

export interface FrameTarget {
  // What the frame loads: the address without any credentials.
  src: string;
  // What the chrome shows: the host (and a non-default port), nothing else.
  host: string;
}

// The address to frame, or null when it cannot be a web page. Credentials in
// the address are dropped, so they are never shown, put on the frame, or
// handed to the site.
export function frameTarget(input: string): FrameTarget | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (OTHER_SCHEME.test(trimmed) && !HTTP_SCHEME.test(trimmed)) return null;
  const candidate = HTTP_SCHEME.test(trimmed)
    ? trimmed
    : trimmed.startsWith('//')
      ? `https:${trimmed}`
      : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return null;
    parsed.username = '';
    parsed.password = '';
    return { src: parsed.toString(), host: parsed.host };
  } catch {
    return null;
  }
}

export interface InAppBrowserHandlers {
  onRevealTabBar: () => void;
  // Close, or Back: the host returns to where the page was opened from.
  onClose: () => void;
  // The page cannot be framed: the host opens the same address in the TV browser.
  onOpenExternal: (url: string) => void;
}

// The Browser section: one web page in a full-width frame, under a slim bar
// with Close, Reload and Open in TV browser. The frame is a cross-origin
// page, so once it holds focus the app receives no key at all, not even
// Back. The app therefore never focuses the frame itself: only a pointer
// click in it does, and the first pointer move the app sees (the frame swallows
// the moves over it) takes the keys back.
// Close and the tab bar stay outside the frame and reachable by pointer.
// A session lasts while the view is shown; leaving the view ends it, so a page
// can never keep playing sound behind another screen.
export class InAppBrowser {
  readonly focusScope: FocusScope;
  private phase: Phase = 'empty';
  private target: FrameTarget | null = null;
  // The address as the playlist gave it, for the TV browser.
  private original = '';
  private frame: HTMLIFrameElement | null = null;
  private failReason: FailReason | null = null;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  // The page holds the keyboard focus: the app hears nothing until it lets go.
  private pageActive = false;
  private readonly root: HTMLElement;

  constructor(container: HTMLElement, private readonly handlers: InAppBrowserHandlers) {
    this.root = document.createElement('div');
    this.root.className = 'ab';
    // The app takes the focus back here; never reachable by Tab.
    this.root.tabIndex = -1;
    this.root.setAttribute('data-self-activate', '');
    container.appendChild(this.root);

    this.focusScope = Focus.register({
      id: 'browser.view',
      root: container,
      leaveFor: { up: 'tabbar' },
      defaultKey: () => this.defaultKey(),
      has: (key) => this.hasKey(key),
      concealOnLeave: true,
    });

    container.addEventListener('nav:hover', (e: Event) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      if (!target || !this.root.contains(target)) return;
      this.request(target.getAttribute('data-key'), 'pointer');
    });
    container.addEventListener('nav:unhover', () => this.focusScope.conceal());
    this.root.addEventListener('click', (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      if (target) this.activate(target.getAttribute('data-key'));
    });
    // Focus moving into the frame blurs the window; letting go of it comes back.
    window.addEventListener('blur', () => {
      if (!this.frame || document.activeElement !== this.frame) return;
      this.setPageActive(true);
    });
    window.addEventListener('focus', () => this.setPageActive(false));
    // The frame swallows every pointer move over it, so a move the app does
    // see while the frame holds the focus is the pointer off the frame.
    Focus.onPointer((x, y) => this.onPointerMoved(x, y));
  }

  get active(): boolean {
    return this.target !== null;
  }

  get host(): string {
    return this.target?.host ?? '';
  }

  // Starts a page. False when the address cannot be framed; nothing changes then.
  open(url: string): boolean {
    const target = frameTarget(url);
    if (!target) return false;
    this.endSession();
    this.target = target;
    this.original = url;
    this.phase = 'loading';
    this.failReason = null;
    return true;
  }

  // The view is shown: draw the bar and the frame, and put the ring on the
  // bar. The frame is not focused, so keys stay with the app.
  show(): void {
    this.render();
    this.mountFrame();
    this.request(this.defaultKey(), this.placementVia());
  }

  // Ends the page and drops the frame, which stops its sound at once.
  close(): void {
    if (!this.target && !this.frame) return;
    this.endSession();
    this.render();
  }

  reload(): void {
    if (!this.target || !this.frame) return;
    this.startLoading();
    this.frame.setAttribute('src', this.target.src);
    this.render();
  }

  resumeFocus(): void {
    this.focusScope.focus(this.focusScope.focusKey, 'resume');
  }

  handleAction(action: Action): void {
    if (isFocusMove(action) && this.ringHidden()) {
      this.request(this.focusScope.focusKey, 'key');
      return;
    }
    const key = this.focusScope.focusKey ?? this.defaultKey();
    switch (action) {
      case 'back':
        this.handlers.onClose();
        return;
      case 'select':
        this.activate(key);
        return;
      case 'up':
        if (key === FAILED_TV_KEY) this.request(TV_KEY, 'key');
        else this.handlers.onRevealTabBar();
        return;
      case 'down':
        if (BAR_KEYS.indexOf(key) >= 0 && this.phase === 'failed') this.request(FAILED_TV_KEY, 'key');
        return;
      case 'left':
      case 'right': {
        const at = BAR_KEYS.indexOf(key);
        if (at < 0 || !this.target) return;
        const next = BAR_KEYS[at + (action === 'right' ? 1 : -1)];
        if (next) this.request(next, 'key');
        return;
      }
      default:
        return;
    }
  }

  // --- session ---

  private endSession(): void {
    this.clearTimer();
    if (this.frame) {
      // Blank first, so a page that ignores removal still stops.
      this.frame.setAttribute('src', 'about:blank');
      this.frame.remove();
      this.frame = null;
    }
    this.target = null;
    this.original = '';
    this.phase = 'empty';
    this.failReason = null;
    this.pageActive = false;
  }

  private mountFrame(): void {
    const stage = this.root.querySelector<HTMLElement>('.ab-stage');
    if (!stage || !this.target || this.frame) return;
    const frame = document.createElement('iframe');
    frame.className = 'ab-frame';
    frame.setAttribute('title', this.target.host);
    // Chromium 53 ignores `allow`; the two flags are the only fullscreen gate.
    frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
    frame.setAttribute('allowfullscreen', '');
    frame.setAttribute('webkitallowfullscreen', '');
    // No top navigation, popups or downloads from a framed page; scripts and
    // its own origin stay so site players keep working (verified with the
    // embed host's player).
    frame.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-presentation',
    );
    frame.addEventListener('load', () => this.onFrameLoad());
    // Set before attaching, so only the real address fires a load.
    frame.setAttribute('src', this.target.src);
    stage.appendChild(frame);
    this.frame = frame;
    this.startLoading();
    this.render();
  }

  private startLoading(): void {
    this.clearTimer();
    this.phase = 'loading';
    this.failReason = null;
    this.loadTimer = setTimeout(() => this.fail('timeout'), FRAME_LOAD_TIMEOUT_MS);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) this.fail('offline');
  }

  private clearTimer(): void {
    if (this.loadTimer !== null) clearTimeout(this.loadTimer);
    this.loadTimer = null;
  }

  // `load` fires for the page, and in some engines for the error page of a
  // refused or unreachable frame too; the app cannot read a cross-origin
  // frame, so it cannot tell them apart. Only a missing `load` is a failure
  // it can see.
  private onFrameLoad(): void {
    if (!this.target) return;
    this.clearTimer();
    this.phase = 'loaded';
    this.failReason = null;
    this.render();
  }

  private fail(reason: FailReason): void {
    if (!this.target || this.phase === 'loaded') return;
    this.phase = 'failed';
    this.failReason = reason;
    log.warn('Page did not load', 'event=browser.frame.failed', `reason=${reason}`);
    // A timeout says the site did not show; being offline says nothing about it.
    if (reason === 'timeout') HostCapabilityService.setFramable(this.target.src, false);
    this.render();
  }

  // --- focus ---

  private setPageActive(active: boolean): void {
    if (this.pageActive === active) return;
    this.pageActive = active;
    this.render();
  }

  private onPointerMoved(x: number, y: number): void {
    if (!this.frame || document.activeElement !== this.frame) return;
    const rect = this.frame.getBoundingClientRect();
    if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) return;
    focusWithoutScroll(this.root);
    this.setPageActive(false);
  }

  private keys(): string[] {
    if (!this.target) return [LIBRARY_KEY];
    return this.phase === 'failed' ? BAR_KEYS.concat(FAILED_TV_KEY) : BAR_KEYS;
  }

  private hasKey(key: string): boolean {
    return this.keys().indexOf(key) >= 0;
  }

  // Not Close: an OK held down from the Library button would close the page
  // the moment it opened. Back and Close stay one press away.
  private defaultKey(): string {
    return this.target ? RELOAD_KEY : LIBRARY_KEY;
  }

  private placementVia(): Via | null {
    if (Focus.owner() !== this.focusScope) return null;
    return InputMode.current === 'keys' ? 'key' : 'pointer';
  }

  private request(key: string | null, via: Via | null): void {
    if (via === 'pointer' && Focus.owner() !== this.focusScope) {
      this.focusScope.focus(key, via);
      return;
    }
    if (via === null || Focus.owner() !== this.focusScope) {
      this.focusScope.track(key);
      return;
    }
    this.focusScope.focus(key, via);
    Focus.flush();
  }

  private ringHidden(): boolean {
    const key = this.focusScope.focusKey;
    const el = key === null ? null : this.root.querySelector<HTMLElement>(`[data-key="${key}"]`);
    return !!el && Focus.owner() === this.focusScope && !FocusRing.deferred && !ringShown(el);
  }

  private activate(key: string | null): void {
    if (key === CLOSE_KEY || key === LIBRARY_KEY) this.handlers.onClose();
    else if (key === RELOAD_KEY) this.reload();
    else if ((key === TV_KEY || key === FAILED_TV_KEY) && this.original) this.handlers.onOpenExternal(this.original);
  }

  // --- rendering ---

  private button(key: string, icon: string, label: string, primary = false): Safe {
    return html`
      <button class="ab-btn${primary ? ' ab-btn-primary' : ''}" type="button" data-focusable data-key="${key}">
        <span class="ab-btn-icon">${raw(icon)}</span><span>${label}</span>
      </button>`;
  }

  private render(): void {
    if (!this.target) {
      morph(this.root, html`
        <div class="ab-empty" data-key="ab-empty">
          <h1 class="ab-empty-title">${t('browser.emptyTitle')}</h1>
          <p class="ab-empty-hint">${t('browser.emptyHint', { action: t('w3u.openInApp') })}</p>
          ${this.button(LIBRARY_KEY, LIBRARY_ICON, t('browser.openLibrary'))}
        </div>
      `);
    } else {
      const phase = this.phase;
      morph(this.root, html`
        <div class="ab-session" data-key="ab-session" data-phase="${phase}">
          <div class="ab-bar" data-nav-container>
            ${this.button(CLOSE_KEY, CLOSE_ICON, t('browser.close'))}
            ${this.button(RELOAD_KEY, RELOAD_ICON, t('browser.reload'))}
            ${this.button(TV_KEY, EXTERNAL_ICON, t('w3u.openInBrowser'))}
            <span class="ab-host">${this.target.host}</span>
          </div>
          <div class="ab-body">
            <div class="ab-stage" data-key="stage" data-morph-preserve></div>
            ${phase === 'loading' ? html`
              <div class="ab-overlay" role="status">
                <div class="ab-card ab-card-loading"><span class="ab-spinner"></span>${t('common.loading')}</div>
              </div>` : ''}
            ${phase === 'failed' ? html`
              <div class="ab-overlay">
                <div class="ab-card" role="alert" data-reason="${this.failReason ?? 'timeout'}">
                  <h2 class="ab-card-title">${t('browser.failedTitle')}</h2>
                  <p class="ab-card-hint">${this.failReason === 'timeout'
                    ? t('browser.failedBlocked', { tv: t('w3u.openInBrowser') })
                    : t('browser.failedHint')}</p>
                  ${this.button(FAILED_TV_KEY, EXTERNAL_ICON, t('w3u.openInBrowser'), true)}
                </div>
              </div>` : ''}
          </div>
          <div class="ab-foot${this.pageActive ? ' ab-foot-active' : ''}">
            ${this.pageActive ? t('browser.pageActive') : html`${t('browser.hint')} <span class="ab-foot-note">${t('browser.hintBlank')}</span>`}
          </div>
        </div>
      `);
    }
    const key = this.focusScope.focusKey;
    if (key === null || !this.hasKey(key)) this.focusScope.track(this.defaultKey());
  }
}
