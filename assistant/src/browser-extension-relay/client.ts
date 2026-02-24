/**
 * Higher-level API over ExtensionRelayServer.
 *
 * Provides convenience wrappers for common operations:
 *   - relayEval    — evaluate JS in a tab (drop-in for cdpEval)
 *   - relayCookies — fetch cookies for a domain
 *   - waitForExtension — poll until the extension connects
 */

import { extensionRelayServer } from './server.js';
import type { CookieSpec } from './protocol.js';

const WAIT_POLL_INTERVAL_MS = 250;

/**
 * Evaluate a JavaScript expression in a tab matching the given URL pattern.
 *
 * @param urlPattern   Glob or substring matched against open tab URLs.
 * @param script       JS source string to evaluate in the tab's MAIN world.
 * @param timeoutMs    Per-command timeout (default: server default).
 * @returns            The return value of the script, as returned by the extension.
 */
export async function relayEval(
  urlPattern: string,
  script: string,
  timeoutMs?: number,
): Promise<unknown> {
  // Find the tab first
  const findResp = await extensionRelayServer.sendCommand(
    { action: 'find_tab', url: urlPattern },
    timeoutMs,
  );
  if (!findResp.success) {
    throw new Error(`relayEval: find_tab failed — ${findResp.error ?? 'unknown error'}`);
  }
  const tabId = findResp.tabId;
  if (tabId === undefined) {
    throw new Error(`relayEval: no tab found matching "${urlPattern}"`);
  }

  const evalResp = await extensionRelayServer.sendCommand(
    { action: 'evaluate', tabId, code: script },
    timeoutMs,
  );
  if (!evalResp.success) {
    throw new Error(`relayEval: evaluate failed — ${evalResp.error ?? 'unknown error'}`);
  }
  return evalResp.result;
}

/**
 * Retrieve cookies for a domain.
 *
 * @param domain  e.g. "amazon.com"
 * @returns       Array of cookie objects returned by the extension.
 */
export async function relayCookies(domain: string): Promise<unknown[]> {
  const resp = await extensionRelayServer.sendCommand({ action: 'get_cookies', domain });
  if (!resp.success) {
    throw new Error(`relayCookies: failed — ${resp.error ?? 'unknown error'}`);
  }
  return Array.isArray(resp.result) ? resp.result : [];
}

/**
 * Set a cookie via the extension.
 */
export async function relaySetCookie(cookie: CookieSpec): Promise<void> {
  const resp = await extensionRelayServer.sendCommand({ action: 'set_cookie', cookie });
  if (!resp.success) {
    throw new Error(`relaySetCookie: failed — ${resp.error ?? 'unknown error'}`);
  }
}

/**
 * Navigate a tab (or open a new one) to a URL.
 */
export async function relayNavigate(url: string, tabId?: number): Promise<number> {
  const resp = await extensionRelayServer.sendCommand({ action: 'navigate', url, tabId });
  if (!resp.success) {
    throw new Error(`relayNavigate: failed — ${resp.error ?? 'unknown error'}`);
  }
  return resp.tabId!;
}

/**
 * Open a new tab and navigate to a URL.
 */
export async function relayNewTab(url: string): Promise<number> {
  const resp = await extensionRelayServer.sendCommand({ action: 'new_tab', url });
  if (!resp.success) {
    throw new Error(`relayNewTab: failed — ${resp.error ?? 'unknown error'}`);
  }
  return resp.tabId!;
}

/**
 * Take a screenshot of the currently visible tab.
 *
 * @param tabId  Optional tab ID; if omitted, captures the active tab in the focused window.
 * @returns      Base64-encoded PNG data URL.
 */
export async function relayScreenshot(tabId?: number): Promise<string> {
  const resp = await extensionRelayServer.sendCommand({ action: 'screenshot', tabId });
  if (!resp.success) {
    throw new Error(`relayScreenshot: failed — ${resp.error ?? 'unknown error'}`);
  }
  return resp.result as string;
}

/**
 * Poll until the Chrome extension connects or the timeout expires.
 *
 * @param timeoutMs  Total wait time in ms (default: 10 000).
 * @throws           Error if the extension does not connect within the timeout.
 */
export async function waitForExtension(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (extensionRelayServer.getStatus().connected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
  }
  throw new Error(`waitForExtension: Chrome extension did not connect within ${timeoutMs}ms`);
}
