// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openInBrowser } from './browser-launch';

const ORIGINAL_UA = navigator.userAgent;

interface BridgeCall {
  uri: string;
  payload: string;
}

function installBridge(): {
  calls: BridgeCall[];
  callbacks: Array<(message: string) => void>;
} {
  const calls: BridgeCall[] = [];
  const callbacks: Array<(message: string) => void> = [];

  class FakePalmServiceBridge {
    onservicecallback: ((message: string) => void) | null = null;

    call(uri: string, payload: string): void {
      calls.push({ uri, payload });
      if (this.onservicecallback) callbacks.push(this.onservicecallback);
    }

    cancel(): void {}
  }

  Object.defineProperty(window, 'PalmServiceBridge', {
    configurable: true,
    value: FakePalmServiceBridge,
  });
  return { calls, callbacks };
}

function useWebOS(): void {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (webOS)',
  });
}

function warnText(warn: ReturnType<typeof vi.spyOn>): string {
  return warn.mock.calls.map((call) => (call as unknown[]).join(' ')).join(' ');
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  Reflect.deleteProperty(window, 'PalmServiceBridge');
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: ORIGINAL_UA,
  });
  warn.mockRestore();
});

describe('openInBrowser', () => {
  it('launches the browser on webOS with an absolute target', async () => {
    useWebOS();
    const bridge = installBridge();

    const result = openInBrowser('host/a');
    bridge.callbacks[0]('{"returnValue":true}');

    await expect(result).resolves.toBe(true);
    expect(bridge.calls[0].uri).toBe(
      'luna://com.webos.applicationManager/launch',
    );
    expect(JSON.parse(bridge.calls[0].payload)).toEqual({
      id: 'com.webos.app.browser',
      params: { target: 'https://host/a' },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('trims the input and keeps an explicit http(s) scheme', async () => {
    useWebOS();
    const bridge = installBridge();

    const result = openInBrowser('  http://host/a?x=1  ');
    bridge.callbacks[0]('{"returnValue":true}');
    await expect(result).resolves.toBe(true);

    expect(JSON.parse(bridge.calls[0].payload).params.target).toBe(
      'http://host/a?x=1',
    );
  });

  it('treats a host:port without a scheme as missing one', async () => {
    useWebOS();
    const bridge = installBridge();

    const result = openInBrowser('host:8080/a');
    bridge.callbacks[0]('{"returnValue":true}');
    await expect(result).resolves.toBe(true);

    expect(JSON.parse(bridge.calls[0].payload).params.target).toBe(
      'https://host:8080/a',
    );
  });

  it('resolves false and logs once without a URL when Luna fails', async () => {
    useWebOS();
    const bridge = installBridge();

    const result = openInBrowser('http://host/a');
    bridge.callbacks[0](JSON.stringify({
      returnValue: false,
      errorCode: -1,
      errorText: 'no-such-app',
    }));

    await expect(result).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const text = warnText(warn);
    expect(text).toContain('event=browser.launch.failed');
    expect(text).toContain('reason=no-such-app');
    expect(text).toContain('code=-1');
    expect(text).not.toContain('http://host/a');
  });

  it('resolves false when the Luna bridge is unavailable', async () => {
    useWebOS();

    await expect(openInBrowser('http://host/a')).resolves.toBe(false);

    const text = warnText(warn);
    expect(text).toContain('event=browser.launch.failed');
    expect(text).toContain('reason=PalmServiceBridge unavailable');
    expect(text).toContain('code=-1');
  });

  it('rejects empty and non-http(s) input without calling Luna', async () => {
    useWebOS();
    const bridge = installBridge();

    await expect(openInBrowser('ftp://host/a')).resolves.toBe(false);
    await expect(openInBrowser('   ')).resolves.toBe(false);

    expect(bridge.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warnText(warn)).toContain('reason=invalid-url');
  });

  it('returns false off webOS without calling Luna', async () => {
    const bridge = installBridge();

    await expect(openInBrowser('http://host/a')).resolves.toBe(false);

    expect(bridge.calls).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
