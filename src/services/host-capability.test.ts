// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  HostCapabilityStore,
  isHardResolveFailure,
  type HostCapabilityOptions,
} from './host-capability';

const DAY = 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'iptv_host_capability';

let now = 1_000_000;

function makeStore(overrides: HostCapabilityOptions = {}): HostCapabilityStore {
  return new HostCapabilityStore({
    storage: localStorage,
    now: () => now,
    frameBlockedHosts: ['frame.example'],
    playableTtlMs: 7 * DAY,
    framableTtlMs: 30 * DAY,
    maxHosts: 10,
    ...overrides,
  });
}

describe('HostCapabilityStore', () => {
  beforeEach(() => {
    localStorage.clear();
    now = 1_000_000;
  });

  it('learns a successful resolve and persists it across instances', () => {
    const store = makeStore();
    store.recordResolve('https://media.example/watch/1', { ok: true });

    expect(store.getPlayable('https://media.example/watch/1')).toBe(true);
    expect(makeStore().getPlayable('https://media.example/other')).toBe(true);
  });

  it('marks a hard resolve failure unplayable and persists it', () => {
    const store = makeStore();
    store.recordResolve('https://media.example/watch/1', { ok: false, reason: 'no_metadata' });

    expect(store.getPlayable('https://media.example/watch/1')).toBe(false);
    expect(makeStore().getPlayable('https://media.example/watch/1')).toBe(false);
  });

  it('keeps a network timeout unknown', () => {
    const store = makeStore();
    store.recordResolve('https://slow.example/watch', { ok: false, reason: 'unavailable' });

    expect(store.getPlayable('https://slow.example/watch')).toBe('unknown');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('classifies only a page verdict as a hard failure', () => {
    expect(isHardResolveFailure('no_metadata')).toBe(true);
    expect(isHardResolveFailure('unsupported_host')).toBe(true);
    expect(isHardResolveFailure('http_404')).toBe(true);
    expect(isHardResolveFailure('http_403')).toBe(true);
    expect(isHardResolveFailure('unavailable')).toBe(false);
    expect(isHardResolveFailure('fetch_failed')).toBe(false);
    expect(isHardResolveFailure('http_503')).toBe(false);
    expect(isHardResolveFailure('aborted')).toBe(false);
  });

  it('expires a learned playable fact after a week', () => {
    const store = makeStore();
    store.setPlayable('https://media.example/a', true);

    now += 7 * DAY - 1;
    expect(store.getPlayable('https://media.example/a')).toBe(true);

    now += 1;
    expect(store.getPlayable('https://media.example/a')).toBe('unknown');
  });

  it('expires a learned framable fact after thirty days', () => {
    const store = makeStore();
    store.setFramable('https://media.example/a', false);

    now += 30 * DAY - 1;
    expect(store.getFramable('https://media.example/a')).toBe(false);

    now += 1;
    expect(store.getFramable('https://media.example/a')).toBe('unknown');
  });

  it('treats the static deny list and its subdomains as unframable', () => {
    const store = makeStore();

    expect(store.getFramable('https://frame.example/watch')).toBe(false);
    expect(store.getFramable('https://cdn.frame.example/watch')).toBe(false);
    expect(store.getFramable('https://open.example/watch')).toBe('unknown');
  });

  it('keeps the static deny list over a learned fact', () => {
    const store = makeStore();
    store.setFramable('https://frame.example/watch', true);

    expect(store.getFramable('https://frame.example/watch')).toBe(false);
  });

  it('learns a frame that never loads and persists it', () => {
    const store = makeStore();
    store.setFramable('https://open.example/watch', false);

    expect(makeStore().getFramable('https://open.example/watch')).toBe(false);
  });

  it('reports the reason Play cannot work', () => {
    const store = makeStore();

    expect(store.reasonFor('https://frame.example/a')).toBe('frame_blocked');
    store.setFramable('https://slow.example/a', false);
    expect(store.reasonFor('https://slow.example/a')).toBe('frame_blocked');
    store.setFramable('https://slow.example/a', 'unknown');
    store.setPlayable('https://slow.example/a', false);
    expect(store.reasonFor('https://slow.example/a')).toBe('not_resolvable');
    expect(store.reasonFor('https://fresh.example/a')).toBe('unknown');
  });

  it('bumps the revision only when a fact changes', () => {
    const store = makeStore();
    expect(store.revision).toBe(0);

    store.setPlayable('https://media.example/a', true);
    expect(store.revision).toBe(1);

    store.setPlayable('https://media.example/a', true);
    expect(store.revision).toBe(1);

    store.setFramable('https://media.example/a', false);
    expect(store.revision).toBe(2);

    store.reset();
    expect(store.revision).toBe(0);
  });

  it('reads malformed stored data as empty', () => {
    const malformed = [
      '{',
      'null',
      '[]',
      JSON.stringify({ version: 99, revision: 5, hosts: { 'a.example': { playable: { value: true, at: 1 } } } }),
      JSON.stringify({ version: 1, revision: 5, hosts: [] }),
      JSON.stringify({ version: 1, revision: 5, hosts: { 'a.example': { playable: { value: 'yes', at: 1 } } } }),
      JSON.stringify({ version: 1, revision: 5, hosts: { 'a.example': { framable: { value: false } } } }),
    ];

    for (const raw of malformed) {
      localStorage.setItem(STORAGE_KEY, raw);
      const store = makeStore();
      expect(store.revision).toBe(0);
      expect(store.getPlayable('https://a.example/a')).toBe('unknown');
      expect(store.getFramable('https://a.example/a')).toBe('unknown');
    }
  });

  it('stores only hostnames, never a station URL', () => {
    const store = makeStore();
    store.recordResolve('https://user:pass@media.example/watch/1?token=secret', { ok: true });

    const raw = localStorage.getItem(STORAGE_KEY) ?? '';
    expect(raw).toContain('media.example');
    expect(raw).not.toContain('token');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('/watch');
    expect(raw).not.toContain('user');
  });

  it('caps learned hosts, dropping the oldest first', () => {
    const store = makeStore({ maxHosts: 2 });
    store.setPlayable('https://one.example/a', true);
    now += 1;
    store.setPlayable('https://two.example/a', true);
    now += 1;
    store.setPlayable('https://three.example/a', true);

    expect(store.getPlayable('https://one.example/a')).toBe('unknown');
    expect(store.getPlayable('https://two.example/a')).toBe(true);
    expect(store.getPlayable('https://three.example/a')).toBe(true);
  });
});
