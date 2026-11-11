import { isWebOS } from '../utils/platform';
import { createLogger } from '../utils/logger';
import { lunaRequest } from './luna';

const log = createLogger('BrowserLaunch');

const HTTP_SCHEME = /^https?:\/\//i;
// A leading scheme with a non-port name: `mailto:`, `javascript:`, `ftp:`.
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:(?![0-9])/i;

// Returns an absolute http(s) URL, or null when the input cannot be a web page.
function absoluteHttpUrl(input: string): string | null {
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
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function logFailure(reason: string, code: string): void {
  // Cap and flatten the reason so a provider message can never spill a URL.
  const safeReason = reason.replace(/\s+/g, ' ').slice(0, 64) || 'luna';
  log.warn(
    'Browser launch failed',
    'event=browser.launch.failed',
    `reason=${safeReason}`,
    `code=${code}`,
  );
}

// Chromium 53 has no navigation-result promise, so a returned window is the
// only signal that the tab was allowed.
function openInTab(target: string): Promise<boolean> {
  try {
    // `noopener` makes window.open return null in current browsers, which is
    // indistinguishable from a blocked popup; null the opener instead.
    const opened = window.open(target, '_blank');
    if (!opened) {
      logFailure('popup-blocked', 'none');
      return Promise.resolve(false);
    }
    try {
      opened.opener = null;
    } catch {
      // A cross-origin handle may refuse; the tab is already open.
    }
    return Promise.resolve(true);
  } catch {
    logFailure('exception', 'unknown');
    return Promise.resolve(false);
  }
}

// Fire-and-forget: the app may be suspended while the browser is foregrounded,
// so only the launch request outcome is reported.
export function openInBrowser(url: string): Promise<boolean> {
  const target = absoluteHttpUrl(url);
  if (!target) {
    logFailure('invalid-url', 'none');
    return Promise.resolve(false);
  }

  // The desktop preview has no TV browser to launch: use a real tab.
  if (!isWebOS()) return openInTab(target);

  return new Promise((resolve) => {
    try {
      lunaRequest('luna://com.webos.applicationManager', {
        method: 'launch',
        parameters: {
          id: 'com.webos.app.browser',
          params: { target },
        },
        onSuccess: () => resolve(true),
        onFailure: (response) => {
          logFailure(
            typeof response.errorText === 'string' ? response.errorText : '',
            typeof response.errorCode === 'number' ? String(response.errorCode) : 'none',
          );
          resolve(false);
        },
      });
    } catch {
      logFailure('exception', 'unknown');
      resolve(false);
    }
  });
}
