import type { Action, Channel } from '../types';
import { Focus, type FocusScope, type Via } from '../navigation/focus-scope';
import { FocusRing, ringShown } from '../navigation/focus-ring';
import { InputMode } from '../navigation/input-mode';
import { isFocusMove } from '../navigation/spatial-nav';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { VirtualGrid } from '../utils/virtual-grid';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard } from '../utils/virtual-scroll';
import { CONFIG } from '../config';
import { t, tp } from '../i18n';
import { GLOBE_ICON, PLAY_ICON } from './icons';
import { buildW3uLibrary, type W3uGroup, type W3uLibrary, type W3uStation } from './w3u-model';

// Geometry mirrors css/w3u-view.css: .catalog-grid-cell is 220x371 and a grid
// row is 395px; a .w3u-group row is 76px plus its 8px gap.
const GRID_COLUMN_STRIDE = 244;
const GRID_ROW_STRIDE = 395;
const GRID_OVERSCAN_ROWS = 2;
const GRID_VIEWPORT_WIDTH = 1312;
const GRID_VIEWPORT_HEIGHT = 840;
const GROUP_ROW_STRIDE = 84;
const GROUP_OVERSCAN = 6;
const GROUP_VIEWPORT_HEIGHT = 840;

type Mode = 'library' | 'detail';
type Region = 'group' | 'tile' | 'detail';

interface ParsedKey {
  region: Region;
  index: number;
}

const DETAIL_KEY = 'd:action';

function parseKey(key: string | null): ParsedKey | null {
  if (key === null) return null;
  if (key === DETAIL_KEY) return { region: 'detail', index: 0 };
  const match = /^([gt]):(\d+)$/.exec(key);
  if (!match) return null;
  return { region: match[1] === 'g' ? 'group' : 'tile', index: Number(match[2]) };
}

export interface W3uHandlers {
  onRevealTabBar: () => void;
  // Back from the group list leaves the Library.
  onBack: () => void;
  // A station whose URL is media: the host plays it.
  onPlay: (channel: Channel) => void;
  // A station that only plays on its own web page: the host opens the TV browser.
  onOpenInBrowser: (station: W3uStation) => void;
}

// The W3U Library: a group list beside a poster grid of that group's titles,
// and a detail screen with a Play / Open in TV browser action. One focus scope
// holds the focused group row, poster, or button; keys are plain indexes
// (`g:2`, `t:15`, `d:action`) because only the active group's grid exists.
// Back walks detail -> grid -> group list -> Live. Both layers stay in the DOM
// (the hidden one only invisible), so Back finds the grid exactly as it was.
export class W3uView {
  readonly focusScope: FocusScope;
  private library: W3uLibrary = { groups: [], total: 0 };
  private source: readonly Channel[] | null = null;
  private mode: Mode = 'library';
  private groupIndex = 0;
  private gridFocus = 0;
  private detail: W3uStation | null = null;
  private detailReturn = 0;
  private readonly layers: Record<Mode, HTMLElement>;
  private readonly gridVirtualizer = new VirtualGrid({
    columnStride: GRID_COLUMN_STRIDE,
    rowStride: GRID_ROW_STRIDE,
    overscanRows: GRID_OVERSCAN_ROWS,
    fallbackViewportWidth: GRID_VIEWPORT_WIDTH,
    fallbackViewportHeight: GRID_VIEWPORT_HEIGHT,
  });
  private readonly groupVirtualizer = new VirtualList({
    itemSize: GROUP_ROW_STRIDE,
    overscan: GROUP_OVERSCAN,
    fallbackViewportSize: GROUP_VIEWPORT_HEIGHT,
  });
  private readonly scrollGuard = new VirtualScrollGuard();
  private gridScrollFrame: number | null = null;
  private groupScrollFrame: number | null = null;
  private lastRevealKey: string | null = null;
  private lastRevealAt = 0;
  private lastRevealInstant = false;

  constructor(container: HTMLElement, private readonly handlers: W3uHandlers) {
    const layer = (mode: Mode): HTMLElement => {
      const el = document.createElement('div');
      el.className = `catalog-layer w3u-layer w3u-layer-${mode}`;
      if (mode !== 'library') el.classList.add('catalog-layer-hidden');
      container.appendChild(el);
      return el;
    };
    this.layers = { library: layer('library'), detail: layer('detail') };
    this.focusScope = Focus.register({
      id: 'w3u.library',
      root: container,
      leaveFor: { up: 'tabbar' },
      defaultKey: () => this.defaultKey(),
      resolve: (key) => this.resolveKey(key),
      has: (key) => this.hasKey(key),
      reveal: (key) => this.revealKey(key),
      concealOnLeave: true,
    });
    // The pointer lights a poster or button where it rests, without scrolling.
    container.addEventListener('nav:hover', (e: Event) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      if (!target || !this.layers[this.mode].contains(target)) return;
      this.request(target.getAttribute('data-key'), 'pointer');
    });
    // A ring the pointer left stays off; the next key only shows it again.
    container.addEventListener('nav:unhover', (e: Event) => {
      if (e.target === this.current()) this.focusScope.conceal();
    });
    container.addEventListener('scroll', (e: Event) => this.onScroll(e.target as HTMLElement), true);
  }

  // Shows the Library for these channels, keeping the viewer's place when the
  // channel list is the one already shown.
  open(channels: readonly Channel[]): void {
    if (channels !== this.source) {
      this.source = channels;
      this.library = buildW3uLibrary(channels);
      this.mode = 'library';
      this.groupIndex = 0;
      this.gridFocus = 0;
      this.detail = null;
      this.gridVirtualizer.setScrollOffset(0);
      this.groupVirtualizer.setScrollOffset(0);
      morph(this.layers.detail, html``);
      this.focusScope.track(null);
    }
    this.showLayer(this.mode);
    if (this.mode === 'library') this.renderLibrary();
    else this.renderDetail();
    const key = this.focusScope.focusKey;
    this.request(key !== null && this.hasKey(key) ? key : this.defaultKey(), this.placementVia());
  }

  // Back into the section from the tab bar, or from the player: the focus
  // the viewer left, in view.
  resumeFocus(): void {
    this.focusScope.focus(this.focusScope.focusKey, 'resume');
  }

  handleAction(action: Action): void {
    if (isFocusMove(action) && this.ringHidden()) {
      this.request(this.focusScope.focusKey, 'key');
      return;
    }
    if (this.mode === 'detail') {
      this.detailAction(action);
      return;
    }
    const focused = parseKey(this.focusScope.focusKey);
    if (!focused || focused.region === 'detail') {
      if (action === 'back') this.handlers.onBack();
      else if (isFocusMove(action) || action === 'select') this.request(this.defaultKey(), 'key');
      return;
    }
    if (focused.region === 'group') this.groupAction(action, focused.index);
    else this.tileAction(action, focused.index);
  }

  // --- model ---

  private get group(): W3uGroup | null {
    return this.library.groups[this.groupIndex] ?? null;
  }

  private get stations(): W3uStation[] {
    return this.group?.stations ?? [];
  }

  private groupLabel(group: W3uGroup): string {
    return group.uncategorized ? t('channel.uncategorized') : group.label;
  }

  // --- focus ---

  private current(): HTMLElement | null {
    const key = this.focusScope.focusKey;
    return key === null ? null : this.resolveKey(key);
  }

  private resolveKey(key: string): HTMLElement | null {
    if (!parseKey(key)) return null;
    return this.layers[this.mode].querySelector<HTMLElement>(`[data-focusable][data-key="${key}"]`);
  }

  private hasKey(key: string): boolean {
    const parsed = parseKey(key);
    if (!parsed) return false;
    if (parsed.region === 'detail') return this.mode === 'detail';
    if (this.mode !== 'library') return false;
    return parsed.index < (parsed.region === 'group' ? this.library.groups.length : this.stations.length);
  }

  private defaultKey(): string | null {
    if (this.mode === 'detail') return DETAIL_KEY;
    if (this.stations.length) return `t:${Math.min(this.gridFocus, this.stations.length - 1)}`;
    return this.library.groups.length ? `g:${this.groupIndex}` : null;
  }

  // A render that settles focus on its own: with the keys it may bring it into
  // view, otherwise it only lights it. Under another owner it just follows.
  private placementVia(): Via | null {
    if (Focus.owner() !== this.focusScope) return null;
    return InputMode.current === 'keys' ? 'key' : 'pointer';
  }

  // A focus request reaches the scope only while it owns the keys; otherwise
  // the scope just follows it, so no reveal waits for later.
  private request(key: string | null, via: Via | null): void {
    const parsed = parseKey(key);
    if (parsed?.region === 'tile') this.gridFocus = parsed.index;
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

  // After the pointer left, the first key only shows where focus is.
  private ringHidden(): boolean {
    const el = this.current();
    return !!el && Focus.owner() === this.focusScope && !FocusRing.deferred && !ringShown(el);
  }

  // Keeps the focus in view; the virtualized grid and group list scroll their
  // windows first. A held key steps instantly, so focus never outruns scroll.
  private revealKey(key: string): boolean | null {
    const parsed = parseKey(key);
    if (!parsed || parsed.region === 'detail' || this.mode !== 'library' || !this.hasKey(key)) return null;
    const now = Date.now();
    if (key !== this.lastRevealKey) {
      this.lastRevealInstant = this.lastRevealAt !== 0
        && now - this.lastRevealAt <= CONFIG.NAVIGATION.FOCUS_REPEAT_WINDOW_MS;
      this.lastRevealKey = key;
      this.lastRevealAt = now;
    } else if (now - this.lastRevealAt > CONFIG.NAVIGATION.FOCUS_REPEAT_WINDOW_MS) {
      this.lastRevealInstant = false;
    }
    const grid = this.gridElements();
    const list = this.listElements();
    const moved = parsed.region === 'tile'
      ? this.gridVirtualizer.ensureVisible(
        parsed.index,
        grid.track?.clientWidth || GRID_VIEWPORT_WIDTH,
        grid.view?.clientHeight || GRID_VIEWPORT_HEIGHT,
      )
      : this.groupVirtualizer.ensureVisible(parsed.index, list.view?.clientHeight || GROUP_VIEWPORT_HEIGHT);
    if (!moved) return null;
    this.renderLibrary(this.lastRevealInstant);
    return true;
  }

  // --- keys ---

  private groupAction(action: Action, index: number): void {
    switch (action) {
      case 'up':
        if (index > 0) this.request(`g:${index - 1}`, 'key');
        else this.handlers.onRevealTabBar();
        return;
      case 'down':
        if (index < this.library.groups.length - 1) this.request(`g:${index + 1}`, 'key');
        return;
      case 'right':
      case 'select':
        this.chooseGroup(index);
        return;
      case 'back':
        this.handlers.onBack();
        return;
      default:
        return;
    }
  }

  // Selecting a group shows its grid and hands the keys to the first poster.
  private chooseGroup(index: number): void {
    if (index !== this.groupIndex) {
      this.groupIndex = index;
      this.gridFocus = 0;
      this.gridVirtualizer.setScrollOffset(0);
      this.renderLibrary();
    }
    if (this.stations.length) this.request('t:0', 'key');
  }

  private tileAction(action: Action, index: number): void {
    const count = this.stations.length;
    const grid = this.gridElements();
    const width = grid.track?.clientWidth || GRID_VIEWPORT_WIDTH;
    switch (action) {
      case 'select':
        this.openDetail(index);
        return;
      case 'back':
        this.request(`g:${this.groupIndex}`, 'back');
        return;
      case 'left':
      case 'right':
      case 'up':
      case 'down': {
        const next = this.gridVirtualizer.getAdjacentIndex(index, action, count, width);
        if (next !== index) {
          this.request(`t:${next}`, 'key');
        } else if (action === 'left') {
          this.request(`g:${this.groupIndex}`, 'key');
        } else if (action === 'up') {
          this.handlers.onRevealTabBar();
        }
        return;
      }
      default:
        return;
    }
  }

  private detailAction(action: Action): void {
    if (action === 'back') this.closeDetail();
    else if (action === 'up') this.handlers.onRevealTabBar();
    else if (action === 'select') this.activate();
  }

  // --- detail ---

  private openDetail(index: number): void {
    const station = this.stations[index];
    if (!station) return;
    this.detail = station;
    this.detailReturn = index;
    this.showLayer('detail');
    this.renderDetail();
    this.focusScope.track(null);
    this.request(DETAIL_KEY, this.placementVia());
  }

  private closeDetail(): void {
    this.detail = null;
    this.showLayer('library');
    morph(this.layers.detail, html``);
    this.request(`t:${this.detailReturn}`, this.placementVia());
  }

  private activate(): void {
    const station = this.detail;
    if (!station) return;
    if (station.kind === 'embed') this.handlers.onOpenInBrowser(station);
    else this.handlers.onPlay(station.channel);
  }

  // --- rendering ---

  private showLayer(mode: Mode): void {
    this.mode = mode;
    (Object.keys(this.layers) as Mode[]).forEach((key) => {
      this.layers[key].classList.toggle('catalog-layer-hidden', key !== mode);
    });
  }

  private gridElements(): { view: HTMLElement | null; track: HTMLElement | null } {
    return {
      view: this.layers.library.querySelector<HTMLElement>('.w3u-grid'),
      track: this.layers.library.querySelector<HTMLElement>('.catalog-grid-track'),
    };
  }

  private listElements(): { view: HTMLElement | null; track: HTMLElement | null } {
    return {
      view: this.layers.library.querySelector<HTMLElement>('.w3u-group-list'),
      track: this.layers.library.querySelector<HTMLElement>('.w3u-group-spacer'),
    };
  }

  // Where the virtualized track starts inside its scroller (the scroller's
  // padding), so the window's offset and scrollTop line up.
  private trackStart(view: HTMLElement | null, track: HTMLElement | null): number {
    if (!view || !track) return 0;
    return Math.max(0, track.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop);
  }

  private onScroll(target: HTMLElement): void {
    if (this.mode !== 'library') return;
    if (target.classList.contains('w3u-grid')) {
      const top = this.scrollGuard.readUserOffset(target, 'vertical');
      if (top === null) return;
      this.gridVirtualizer.setScrollOffset(
        Math.max(0, top - this.trackStart(target, this.gridElements().track)),
      );
      if (this.gridScrollFrame !== null) return;
      this.gridScrollFrame = requestAnimationFrame(() => {
        this.gridScrollFrame = null;
        if (this.mode === 'library') this.renderLibrary(false, true);
      });
    } else if (target.classList.contains('w3u-group-list')) {
      const top = this.scrollGuard.readUserOffset(target, 'vertical');
      if (top === null) return;
      this.groupVirtualizer.setScrollOffset(
        Math.max(0, top - this.trackStart(target, this.listElements().track)),
      );
      if (this.groupScrollFrame !== null) return;
      this.groupScrollFrame = requestAnimationFrame(() => {
        this.groupScrollFrame = null;
        if (this.mode === 'library') this.renderLibrary(false, true);
      });
    }
  }

  // `followView`: the windows follow a scroll the viewer made, so the
  // scrollers keep their own offsets.
  private renderLibrary(instant = false, followView = false): void {
    const groups = this.library.groups;
    const active = this.group;
    const stations = this.stations;
    const grid = this.gridElements();
    const list = this.listElements();

    const viewportWidth = grid.track?.clientWidth || GRID_VIEWPORT_WIDTH;
    const viewportHeight = grid.view?.clientHeight || GRID_VIEWPORT_HEIGHT;
    const gridRange = this.gridVirtualizer.getRange(stations.length, viewportWidth, viewportHeight);
    const listRange = this.groupVirtualizer.getRange(
      groups.length,
      list.view?.clientHeight || GROUP_VIEWPORT_HEIGHT,
    );

    const cells: Safe[] = [];
    for (let index = gridRange.start; index < gridRange.end; index++) {
      const position = this.gridVirtualizer.getItemPosition(index, gridRange.columns);
      cells.push(html`
        <div class="catalog-grid-cell" data-key="cell:${index}" data-grid-index="${index}"
             style="left:${position.left}px;top:${position.top}px">${this.tile(stations[index], index)}</div>
      `);
    }
    const rows: Safe[] = [];
    for (let index = listRange.start; index < listRange.end; index++) {
      rows.push(this.groupRow(groups[index], index, index === this.groupIndex));
    }

    morph(this.layers.library, html`
      <div class="w3u-library" data-nav-container>
        <nav class="w3u-rail">
          <div class="w3u-kicker">${t('nav.w3u')}</div>
          <div class="w3u-group-list">
            <div class="w3u-group-spacer" style="height:${this.groupVirtualizer.getTotalSize(groups.length)}px">${rows}</div>
          </div>
        </nav>
        <section class="w3u-pane">
          <h1 class="w3u-pane-title">${active ? this.groupLabel(active) : t('nav.w3u')}
            <span class="w3u-pane-count">${tp('w3u.titleCount', stations.length)}</span></h1>
          ${stations.length === 0 ? '' : html`
            <div class="w3u-grid">
              <div class="catalog-grid-track"
                   style="height:${this.gridVirtualizer.getTotalSize(stations.length, viewportWidth)}px">${cells}</div>
            </div>`}
        </section>
      </div>
    `);

    if (followView) return;
    const after = { grid: this.gridElements(), list: this.listElements() };
    this.syncScroll(after.grid.view, after.grid.track, this.gridVirtualizer.scrollOffset, instant);
    this.syncScroll(after.list.view, after.list.track, this.groupVirtualizer.scrollOffset, instant);
  }

  private syncScroll(view: HTMLElement | null, track: HTMLElement | null, offset: number, instant: boolean): void {
    if (!view) return;
    this.scrollGuard.syncOffset(view, 'vertical', offset === 0 ? 0 : offset + this.trackStart(view, track), instant);
  }

  private posterCell(name: string, poster: string): Safe {
    return poster
      ? html`<img class="catalog-poster" src="${poster}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : html`<div class="catalog-poster catalog-poster-empty">${name.charAt(0)}</div>`;
  }

  private groupRow(group: W3uGroup, index: number, active: boolean): Safe {
    return html`
      <div class="w3u-group${active ? ' active' : ''}" data-focusable data-key="g:${index}"
           style="top:${index * GROUP_ROW_STRIDE}px">
        <span class="w3u-group-label">${this.groupLabel(group)}</span>
        <span class="w3u-group-count">${group.stations.length}</span>
      </div>
    `;
  }

  private tile(station: W3uStation, index: number): Safe {
    const embed = station.kind === 'embed';
    return html`
      <div class="catalog-tile w3u-tile${embed ? ' w3u-tile-embed' : ''}" data-focusable data-key="t:${index}">
        <div class="catalog-poster-wrap">${this.posterCell(station.name, station.poster)}${embed ? html`
          <span class="w3u-badge"><span class="w3u-glyph">${raw(GLOBE_ICON)}</span>${t('w3u.browserBadge')}</span>
        ` : ''}</div>
        <div class="catalog-tile-name">${station.name}</div>
      </div>
    `;
  }

  private renderDetail(): void {
    const station = this.detail;
    if (!station) return;
    const embed = station.kind === 'embed';
    morph(this.layers.detail, html`
      <div class="catalog-view movies-detail w3u-detail" data-nav-container>
        <div class="detail-poster-wrap">${this.posterCell(station.name, station.poster)}</div>
        <div class="detail-body">
          <h1 class="detail-title">${station.name}</h1>
          ${station.genres.length ? html`<div class="detail-meta">${station.genres.join('  ·  ')}</div>` : ''}
          ${station.synopsis ? html`<p class="detail-plot w3u-synopsis">${station.synopsis}</p>` : ''}
          ${embed ? html`
            <div class="w3u-note"><span class="w3u-glyph">${raw(GLOBE_ICON)}</span><span>${t('w3u.browserNote')}</span></div>
          ` : ''}
          <div class="detail-actions">
            <button class="detail-btn detail-btn-primary" type="button" data-focusable data-key="${DETAIL_KEY}">
              <span class="detail-btn-icon${embed ? ' w3u-glyph' : ''}">${raw(embed ? GLOBE_ICON : PLAY_ICON)}</span>
              <span>${t(embed ? 'w3u.openInBrowser' : 'catalog.play')}</span>
            </button>
          </div>
        </div>
      </div>
    `);
  }
}
