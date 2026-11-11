import { CONFIG } from '../config';
import type { HostCapability, HostCapabilityReason, HostCapabilityState } from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('HostCapability');

const STORAGE_KEY = CONFIG.STORAGE_PREFIX + 'host_capability';
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export interface CapabilityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface HostCapabilityOptions {
  storage?: CapabilityStorage | null;
  now?: () => number;
  frameBlockedHosts?: readonly string[];
  playableTtlMs?: number;
  framableTtlMs?: number;
  maxHosts?: number;
}

export interface ResolveOutcome {
  ok: boolean;
  reason?: string;
}

interface StoredFact {
  value: boolean;
  checkedAt: number;
}

interface StoredHost {
  playable?: StoredFact;
  framable?: StoredFact;
}

type FactKind = 'playable' | 'framable';

function defaultStorage(): CapabilityStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

// Only a hostname is kept: a station URL may carry a token or a password.
export function capabilityHost(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return HOST_RE.test(host) ? host : '';
  } catch {
    return '';
  }
}

function matchesHost(host: string, hosts: readonly string[]): boolean {
  return !!host && hosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

function validFact(value: unknown): StoredFact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fact = value as { value?: unknown; checkedAt?: unknown };
  if (typeof fact.value !== 'boolean') return null;
  if (typeof fact.checkedAt !== 'number' || !Number.isFinite(fact.checkedAt) || fact.checkedAt < 0) return null;
  return { value: fact.value, checkedAt: fact.checkedAt };
}

function validHost(value: unknown): StoredHost | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const host = value as { playable?: unknown; framable?: unknown };
  const playable = validFact(host.playable);
  const framable = validFact(host.framable);
  if (!playable && !framable) return null;
  return {
    ...(playable ? { playable } : {}),
    ...(framable ? { framable } : {}),
  };
}

// A page never delivered its own verdict, so the host has not been proven
// unplayable. The next Play tries it again instead of hiding it for a week.
export function isHardResolveFailure(reason: string): boolean {
  return reason === 'no_metadata'
    || reason === 'unsupported_host'
    || /^http_4\d\d$/.test(reason);
}

export class HostCapabilityStore {
  private readonly storage: CapabilityStorage | null;
  private readonly now: () => number;
  private readonly frameBlockedHosts: readonly string[];
  private readonly playableTtlMs: number;
  private readonly framableTtlMs: number;
  private readonly maxHosts: number;
  private hosts: Record<string, StoredHost> = {};
  private loaded = false;
  private revisionValue = 0;

  constructor(options: HostCapabilityOptions = {}) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.now = options.now ?? Date.now;
    this.frameBlockedHosts = options.frameBlockedHosts ?? CONFIG.W3U.FRAME_BLOCKED_HOSTS;
    this.playableTtlMs = options.playableTtlMs ?? CONFIG.W3U.CAPABILITY_PLAYABLE_TTL_MS;
    this.framableTtlMs = options.framableTtlMs ?? CONFIG.W3U.CAPABILITY_FRAMABLE_TTL_MS;
    this.maxHosts = options.maxHosts ?? CONFIG.W3U.CAPABILITY_MAX_HOSTS;
  }

  /** Changes whenever a learned fact changes; the UI re-reads after it moves. */
  get revision(): number {
    this.ensureLoaded();
    return this.revisionValue;
  }

  getPlayable(url: string): HostCapabilityState {
    return this.stateOf(capabilityHost(url), 'playable');
  }

  getFramable(url: string): HostCapabilityState {
    return this.framableOf(capabilityHost(url));
  }

  capabilityOf(url: string): HostCapability {
    const host = capabilityHost(url);
    return {
      host,
      playableInApp: this.stateOf(host, 'playable'),
      framable: this.framableOf(host),
    };
  }

  // Why Play cannot work here: the page refuses framing, its stream cannot be
  // read, or nothing has been learned yet.
  reasonFor(url: string): HostCapabilityReason {
    const host = capabilityHost(url);
    if (this.framableOf(host) === false) return 'frame_blocked';
    if (this.stateOf(host, 'playable') === false) return 'not_resolvable';
    return 'unknown';
  }

  setPlayable(url: string, value: HostCapabilityState): void {
    this.write(capabilityHost(url), 'playable', value);
  }

  setFramable(url: string, value: HostCapabilityState): void {
    this.write(capabilityHost(url), 'framable', value);
  }

  recordResolve(url: string, outcome: ResolveOutcome): void {
    if (outcome.ok) {
      this.setPlayable(url, true);
      return;
    }
    if (isHardResolveFailure(outcome.reason ?? '')) this.setPlayable(url, false);
  }

  reset(): void {
    this.hosts = {};
    this.loaded = true;
    this.revisionValue = 0;
    try {
      this.storage?.removeItem(STORAGE_KEY);
    } catch {
      // A read-only storage loses persistence, not the session.
    }
  }

  private stateOf(host: string, kind: FactKind): HostCapabilityState {
    this.ensureLoaded();
    if (!host) return 'unknown';
    const ttl = kind === 'playable' ? this.playableTtlMs : this.framableTtlMs;
    return this.fresh(this.hosts[host]?.[kind], ttl) ?? 'unknown';
  }

  private framableOf(host: string): HostCapabilityState {
    if (matchesHost(host, this.frameBlockedHosts)) return false;
    return this.stateOf(host, 'framable');
  }

  private fresh(fact: StoredFact | undefined, ttl: number): boolean | null {
    if (!fact) return null;
    const age = this.now() - fact.checkedAt;
    if (age < 0 || age >= ttl) return null;
    return fact.value;
  }

  private write(host: string, kind: FactKind, value: HostCapabilityState): void {
    this.ensureLoaded();
    if (!host) return;
    const entry = this.hosts[host];
    const ttl = kind === 'playable' ? this.playableTtlMs : this.framableTtlMs;
    const current = this.fresh(entry?.[kind], ttl);
    if (current === value) {
      // A repeated observation extends the fact, but nothing the UI shows moved.
      const fact = entry?.[kind];
      if (fact) {
        fact.checkedAt = this.now();
        this.persist();
      }
      return;
    }
    if (value === 'unknown') {
      if (!entry?.[kind]) return;
      delete entry[kind];
      if (!entry.playable && !entry.framable) delete this.hosts[host];
    } else {
      this.hosts[host] = { ...entry, [kind]: { value, checkedAt: this.now() } };
    }
    this.pruneHosts();
    this.revisionValue++;
    this.persist();
  }

  private pruneHosts(): void {
    const hosts = Object.keys(this.hosts);
    if (hosts.length <= this.maxHosts) return;
    const oldest = (host: string): number => {
      const entry = this.hosts[host];
      return Math.min(
        entry.playable?.checkedAt ?? Infinity,
        entry.framable?.checkedAt ?? Infinity,
      );
    };
    hosts
      .sort((a, b) => oldest(a) - oldest(b))
      .slice(0, hosts.length - this.maxHosts)
      .forEach((host) => delete this.hosts[host]);
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify({
        version: CONFIG.W3U.CAPABILITY_STORAGE_VERSION,
        revision: this.revisionValue,
        hosts: this.hosts,
      }));
    } catch {
      log.warn(
        'Host capability write failed',
        'event=capability.write.failed',
        'operation=write',
      );
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.storage) return;
    let raw: string | null;
    try {
      raw = this.storage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    if (raw === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const record = parsed as { version?: unknown; revision?: unknown; hosts?: unknown };
    if (record.version !== CONFIG.W3U.CAPABILITY_STORAGE_VERSION) return;
    if (!record.hosts || typeof record.hosts !== 'object' || Array.isArray(record.hosts)) return;
    const hosts: Record<string, StoredHost> = {};
    const stored = record.hosts as Record<string, unknown>;
    for (const key of Object.keys(stored)) {
      const host = capabilityHost(`http://${key}/`);
      const entry = validHost(stored[key]);
      // One damaged entry makes the whole record doubtful; start clean.
      if (!host || !entry) return;
      hosts[host] = entry;
    }
    if (typeof record.revision === 'number' && Number.isFinite(record.revision) && record.revision >= 0) {
      this.revisionValue = Math.floor(record.revision);
    }
    this.hosts = hosts;
  }
}

export const HostCapabilityService = new HostCapabilityStore();
