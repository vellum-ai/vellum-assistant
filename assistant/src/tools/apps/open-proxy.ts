/**
 * Centralized helper for resolving and executing the `app_open` proxy tool.
 *
 * This encapsulates the proxyToolResolver('app_open', ...) pattern so that
 * callers (app_create auto-open, document-tool, future skill scripts) share
 * a single implementation with consistent success/failure messaging.
 */

import type { ProxyResolver, ExecutorResult } from './executors.js';

/**
 * Open an app on the connected client via the proxy tool resolver.
 *
 * @param appId - The ID of the app to open.
 * @param proxyToolResolver - Optional proxy resolver from the tool context.
 *   When undefined (e.g. no macOS client connected), returns an informational
 *   message rather than throwing.
 * @param extraInput - Optional additional fields to pass alongside app_id
 *   (e.g. preview metadata).
 * @returns A stable result string describing the outcome.
 */
export async function openAppViaSurface(
  appId: string,
  proxyToolResolver: ProxyResolver | undefined,
  extraInput?: Record<string, unknown>,
): Promise<string> {
  if (!proxyToolResolver) {
    return 'App created but could not be opened (no connected client). Use app_open to open it manually.';
  }

  try {
    const result: ExecutorResult = await proxyToolResolver('app_open', {
      app_id: appId,
      ...extraInput,
    });
    if (result.isError) {
      return 'Failed to auto-open app. Use app_open to open it manually.';
    }
    return result.content;
  } catch {
    return 'Failed to auto-open app. Use app_open to open it manually.';
  }
}
