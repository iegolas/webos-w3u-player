import type { Action, Channel, PlaylistGroupLink } from '../types';
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
import { CHEVRON_RIGHT_ICON, GLOBE_ICON, PLAY_ICON } from './icons';
import {
  buildW3uLibrary,
  canonicalUrl,
  classifyLinkFailure,
  cutOf,
  linkRows,
  stationCount,
  W3uLinkLoader,
  W3U_LINK_LIMITS,
  type LinkedList,
  type LinkFailure,
  type W3uCut,
  type W3uGroup,
  type W3uStation,
} from './w3u-model';

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
  // A station the app plays itself. A resolvable embed takes a moment to
  // start: the host returns a promise that settles once it has started the
  // player, fallen back to the browser, or been canceled.
  onPlay: (channel: Channel) => Promise<unknown> | void;
  // Back out of a title that is still starting: the host drops the attempt.
  onCancelPlay: () => void;
  // A station that only plays on its own web page: the host opens the TV browser.
  onOpenInBrowser: (station: W3uStation) => void;
}

interface Level {
  label: string;
  // The address of the playlist this level lists; null for the Library root.
  url: string | null;
  groups: W3uGroup[];
  groupIndex: number;
  gridFocus: number;
  groupScroll: number;
  gridScroll: number;
  cut: W3uCut | null;
}

function newLevel(label: string, url: string | null, groups: W3uGroup[], cut: W3uCut | null = null): Level {
  return { label, url, groups, groupIndex: 0, gridFocus: 0, groupScroll: 0, gridScroll: 0, cut };
}

// The W3U Library: a group list beside a poster grid of that group's titles,
// and a detail screen with a Play / Open in TV browser action. Play on a
// resolvable embed shows "Starting…" on the button until the host settles. One focus scope
// holds the focused group row, poster, or button; keys are plain indexes
// (`g:2`, `t:15`, `d:action`) because only the active group's grid exists.
// A group row can link to another playlist: choosing it fetches that list
// then (never before) and shows its titles in the same grid. A list that
// has several groups or links of its own becomes one more level, whose rail
// replaces the current one. Back walks detail -> grid -> group list -> the
// level above -> Live. Both layers stay in the DOM (the hidden one only
// invisible), so Back finds the grid exactly as it was.
export class W3uView {
  readonly focusScope: FocusScope;
  private levels: Level[] = [newLevel('', null, [])];
  private source: readonly Channel[] | null = null;
  private linksKey = '';
  // The addresses of the root playlists, open from the start.
  private rootPath = new Set<string>();
  private mode: Mode = 'library';
  private detail: W3uStation | null = null;
  private detailReturn = 0;
  // The linked playlist being fetched, and why earlier fetches failed.
  private pending: { url: string; group: W3uGroup } | null = null;
  private readonly failures = new Map<string, LinkFailure>();
  private readonly loader = new W3uLinkLoader();
  // The station whose Play is still starting, and the attempt it belongs to.
  private starting: W3uStation | null = null;
  private startAttempt = 0;
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

  // Shows the Library for these channels and linked playlists, keeping the
  // viewer's place when they are the ones already shown. Nothing is fetched
  // here; a linked playlist loads when the viewer chooses it.
  open(
    channels: readonly Channel[],
    links: readonly PlaylistGroupLink[] = [],
    rootUrls: readonly string[] = [],
  ): void {
    const linksKey = links.map((link) => link.url).join('\n') + '\n' + rootUrls.join('\n');
    if (channels !== this.source || linksKey !== this.linksKey) {
      this.source = channels;
      this.linksKey = linksKey;
      this.dropPending();
      this.failures.clear();
      this.rootPath = new Set(rootUrls.map(canonicalUrl));
      this.levels = [newLevel('', null, buildW3uLibrary(channels, links, rootUrls).groups)];
      this.mode = 'library';
      this.detail = null;
      this.cancelStart();
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

  // Leaving the Library (or a different list replacing it) drops a fetch in
  // flight: its result is ignored and the pane no longer says it is loading.
  abortLoad(): void {
    const had = this.pending !== null;
    this.dropPending();
    if (had && this.mode === 'library') this.renderLibrary();
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
      if (action === 'back') this.backFromRail();
      else if (isFocusMove(action) || action === 'select') this.request(this.defaultKey(), 'key');
      return;
    }
    if (focused.region === 'group') this.groupAction(action, focused.index);
    else this.tileAction(action, focused.index);
  }

  // --- model ---

  private get level(): Level {
    return this.levels[this.levels.length - 1];
  }

  private get groups(): W3uGroup[] {
    return this.level.groups;
  }

  private get groupIndex(): number {
    return this.level.groupIndex;
  }

  private get gridFocus(): number {
    return this.level.gridFocus;
  }

  private get group(): W3uGroup | null {
    return this.groups[this.groupIndex] ?? null;
  }

  private get stations(): W3uStation[] {
    return this.group?.stations ?? [];
  }

  // A row with no usable name is numbered; its address is never shown.
  private groupLabel(group: W3uGroup, index = this.groups.indexOf(group)): string {
    if (group.uncategorized) return t('channel.uncategorized');
    return group.label || t('settings.playlistDefault', { number: index + 1 });
  }

  // Where the pane's titles sit: the Library, each playlist opened on the way
  // here, and the open playlist itself when it fills the pane.
  private crumbs(active: W3uGroup | null): string[] {
    const trail = this.levels.slice(1).map((level) => level.label);
    if (active?.link?.ready) trail.push(this.groupLabel(active));
    return trail.length ? [t('nav.w3u')].concat(trail) : [];
  }

  private dropPending(): void {
    this.loader.abort();
    this.pending = null;
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
    return parsed.index < (parsed.region === 'group' ? this.groups.length : this.stations.length);
  }

  private defaultKey(): string | null {
    if (this.mode === 'detail') return DETAIL_KEY;
    if (this.stations.length) return `t:${Math.min(this.gridFocus, this.stations.length - 1)}`;
    return this.groups.length ? `g:${this.groupIndex}` : null;
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
    if (parsed?.region === 'tile') this.level.gridFocus = parsed.index;
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
        if (index < this.groups.length - 1) this.request(`g:${index + 1}`, 'key');
        return;
      case 'right':
      case 'select':
        this.chooseGroup(index);
        return;
      case 'back':
        this.backFromRail();
        return;
      default:
        return;
    }
  }

  // Back from a group list goes up one playlist level, and out of the Library
  // from the root.
  private backFromRail(): void {
    if (this.levels.length > 1) this.popLevel();
    else this.handlers.onBack();
  }

  // Selecting a group shows its grid and hands the keys to the first poster.
  // A linked playlist is fetched first, and shows its state while it loads.
  private chooseGroup(index: number): void {
    const group = this.groups[index];
    if (!group) return;
    if (this.pending && this.pending.group !== group) this.dropPending();
    if (index !== this.groupIndex) {
      this.level.groupIndex = index;
      this.level.gridFocus = 0;
      this.gridVirtualizer.setScrollOffset(0);
      this.renderLibrary();
    }
    if (group.link && !group.link.ready) {
      if (!group.link.blocked) this.openLink(group);
      return;
    }
    if (this.stations.length) this.request('t:0', 'key');
  }

  // --- linked playlists ---

  private openLink(group: W3uGroup): void {
    const link = group.link;
    if (!link || link.blocked || this.pending?.group === group) return;
    const key = canonicalUrl(link.url);
    this.failures.delete(key);
    this.releaseOtherLists(group);
    const cached = this.loader.get(link.url);
    if (cached) {
      this.dropPending();
      this.applyList(group, cached);
      return;
    }
    this.pending = { url: key, group };
    this.renderLibrary();
    // Room left for titles once the lists on the way here are counted.
    const room = W3U_LINK_LIMITS.MAX_TOTAL_STATIONS - this.levels.reduce(
      (sum, level) => sum + stationCount(level.groups),
      0,
    );
    this.loader.load(link.url, room).then(
      (list) => {
        if (!list || this.pending?.group !== group) return;
        this.pending = null;
        this.applyList(group, list);
      },
      (error: unknown) => {
        if (this.pending?.group !== group) return;
        this.pending = null;
        this.failures.set(key, classifyLinkFailure(error));
        this.renderLibrary();
      },
    );
  }

  // Titles of a playlist the viewer left stay in the cache, not on the screen.
  private releaseOtherLists(keep: W3uGroup): void {
    for (const other of this.groups) {
      if (other === keep || !other.link?.ready) continue;
      other.stations = [];
      other.link.ready = false;
      other.link.cut = null;
    }
  }

  // A list with one group and no links of its own fills the row's own grid.
  // Anything more becomes the next level. A link to a playlist already open
  // on the way here stays as an 'open' row, and the links of a list at the
  // depth limit as 'limit' rows; neither is fetched.
  private applyList(group: W3uGroup, list: LinkedList): void {
    const link = group.link;
    if (!link) return;
    const path = new Set<string>(this.rootPath);
    path.add(canonicalUrl(link.url));
    this.levels.forEach((level) => { if (level.url) path.add(canonicalUrl(level.url)); });
    const nested = linkRows(list.links, path, this.levels.length >= W3U_LINK_LIMITS.MAX_DEPTH);
    if (list.groups.length <= 1 && nested.length === 0) {
      const stations = list.groups[0]?.stations ?? [];
      if (!stations.length) {
        this.failures.set(canonicalUrl(link.url), 'parse');
        this.renderLibrary();
        return;
      }
      group.stations = stations;
      link.ready = true;
      link.cut = cutOf(list);
      const row = this.groups.indexOf(group);
      const onRow = this.focusScope.focusKey === `g:${row}`;
      this.renderLibrary();
      if (onRow) this.request('t:0', this.placementVia() ?? 'key');
      return;
    }
    this.level.groupScroll = this.groupVirtualizer.scrollOffset;
    this.level.gridScroll = this.gridVirtualizer.scrollOffset;
    this.levels.push(newLevel(this.groupLabel(group, this.groups.indexOf(group)), link.url, list.groups.concat(nested), cutOf(list)));
    this.groupVirtualizer.setScrollOffset(0);
    this.gridVirtualizer.setScrollOffset(0);
    this.renderLibrary();
    this.request('g:0', this.placementVia());
  }

  private popLevel(): void {
    if (this.levels.length < 2) return;
    this.dropPending();
    this.levels.pop();
    const parent = this.level;
    this.groupVirtualizer.setScrollOffset(parent.groupScroll);
    this.gridVirtualizer.setScrollOffset(parent.gridScroll);
    this.renderLibrary();
    this.request(`g:${parent.groupIndex}`, 'back');
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
    this.cancelStart();
    this.detail = null;
    this.showLayer('library');
    morph(this.layers.detail, html``);
    this.request(`t:${this.detailReturn}`, this.placementVia());
  }

  private activate(): void {
    const station = this.detail;
    if (!station || this.starting) return;
    if (station.kind === 'browser') {
      this.handlers.onOpenInBrowser(station);
      return;
    }
    const started = this.handlers.onPlay(station.channel);
    if (station.kind !== 'resolvable' || !started) return;
    const attempt = ++this.startAttempt;
    this.starting = station;
    this.renderDetail();
    const settled = (): void => {
      if (attempt !== this.startAttempt || this.starting !== station) return;
      this.starting = null;
      if (this.mode === 'detail') this.renderDetail();
    };
    started.then(settled, settled);
  }

  // Drops a start still in flight, so a late result cannot touch the next one.
  private cancelStart(): void {
    if (!this.starting) return;
    this.starting = null;
    this.startAttempt++;
    this.handlers.onCancelPlay();
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
    const groups = this.groups;
    const active = this.group;
    const stations = this.stations;
    const crumbs = this.crumbs(active);
    const cut = stations.length ? active?.link?.cut ?? this.level.cut : null;
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
          <div class="w3u-kicker">${this.levels.length > 1 ? this.level.label : t('nav.w3u')}</div>
          <div class="w3u-group-list">
            <div class="w3u-group-spacer" style="height:${this.groupVirtualizer.getTotalSize(groups.length)}px">${rows}</div>
          </div>
        </nav>
        <section class="w3u-pane">
          ${crumbs.length ? html`<nav class="w3u-crumbs">${crumbs.map((crumb, index) => html`${index ? html`<span class="w3u-glyph w3u-crumb-sep">${raw(CHEVRON_RIGHT_ICON)}</span>` : ''}<span class="w3u-crumb${index === crumbs.length - 1 ? ' w3u-crumb-current' : ''}">${crumb}</span>`)}</nav>` : ''}
          <h1 class="w3u-pane-title">${active ? this.groupLabel(active) : t('nav.w3u')}
            ${stations.length || !active?.link ? html`<span class="w3u-pane-count">${tp('w3u.titleCount', stations.length)}</span>` : ''}</h1>
          ${cut ? html`<p class="w3u-pane-note">${t('w3u.listTruncated', { shown: cut.shown, found: cut.found })}</p>` : ''}
          ${stations.length === 0 ? this.paneState(active) : html`
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

  // What the pane says when the open row has no titles to show: a linked
  // playlist that is loading, failed, or not chosen yet. A plain group stays blank.
  private paneState(group: W3uGroup | null): Safe | string {
    const link = group?.link;
    if (!group || !link) return '';
    if (link.blocked) {
      return html`
        <div class="w3u-state">
          <p class="w3u-state-hint">${link.blocked === 'limit'
            ? t('w3u.linkLimitHint', { count: W3U_LINK_LIMITS.MAX_DEPTH })
            : t('w3u.linkOpenHint')}</p>
        </div>`;
    }
    if (this.pending?.group === group) {
      return html`
        <div class="w3u-state" role="status">
          <div class="w3u-state-spinner"></div>
          <p class="w3u-state-title">${t('common.loading')}</p>
        </div>`;
    }
    const failure = this.failures.get(canonicalUrl(link.url));
    if (failure) {
      return html`
        <div class="w3u-state" role="status">
          <p class="w3u-state-title">${t('w3u.linkFailed')}</p>
          <p class="w3u-state-hint">${t(failure === 'parse' ? 'w3u.linkFailedParse' : 'w3u.linkFailedNetwork')}</p>
        </div>`;
    }
    return html`
      <div class="w3u-state">
        <p class="w3u-state-hint">${t('w3u.linkIdle')}</p>
      </div>`;
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
    const link = group.link;
    if (link) {
      const label = this.groupLabel(group, index);
      const art = html`<span class="w3u-link-art">${label.charAt(0)}${link.image ? html`<img src="${link.image}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}</span>`;
      if (link.blocked) {
        return html`
          <div class="w3u-group w3u-group-link w3u-group-blocked${active ? ' active' : ''}" data-focusable data-key="g:${index}"
               style="top:${index * GROUP_ROW_STRIDE}px">
            ${art}
            <span class="w3u-group-text">
              <span class="w3u-group-label">${label}</span>
              <span class="w3u-link-tag">${t(link.blocked === 'limit' ? 'w3u.linkLimit' : 'w3u.linkOpen')}</span>
            </span>
          </div>
        `;
      }
      return html`
        <div class="w3u-group w3u-group-link${active ? ' active' : ''}" data-focusable data-key="g:${index}"
             style="top:${index * GROUP_ROW_STRIDE}px">
          ${art}
          <span class="w3u-group-label">${label}</span>
          <span class="w3u-group-more w3u-glyph">${raw(CHEVRON_RIGHT_ICON)}</span>
        </div>
      `;
    }
    return html`
      <div class="w3u-group${active ? ' active' : ''}" data-focusable data-key="g:${index}"
           style="top:${index * GROUP_ROW_STRIDE}px">
        <span class="w3u-group-label">${this.groupLabel(group, index)}</span>
        <span class="w3u-group-count">${group.stations.length}</span>
      </div>
    `;
  }

  private tile(station: W3uStation, index: number): Safe {
    const embed = station.kind === 'browser';
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
    const embed = station.kind === 'browser';
    const busy = this.starting === station;
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
            <button class="detail-btn detail-btn-primary${busy ? ' w3u-busy' : ''}" type="button"
                    data-focusable data-key="${DETAIL_KEY}" aria-busy="${busy ? 'true' : 'false'}">
              <span class="detail-btn-icon${embed ? ' w3u-glyph' : ''}">${busy ? '' : raw(embed ? GLOBE_ICON : PLAY_ICON)}</span>
              <span>${t(busy ? 'w3u.starting' : embed ? 'w3u.openInBrowser' : 'catalog.play')}</span>
            </button>
          </div>
        </div>
      </div>
    `);
  }
}
