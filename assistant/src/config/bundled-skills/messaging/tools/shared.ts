/**
 * Shared utilities for messaging skill tools.
 */

import type { MessagingProvider } from "../../../../messaging/provider.js";
import {
  getConnectedProviders,
  getMessagingProvider,
  isPlatformEnabled,
} from "../../../../messaging/registry.js";
import { withValidToken } from "../../../../security/token-manager.js";
import type { ToolExecutionResult } from "../../../../tools/types.js";

export function ok(content: string): ToolExecutionResult {
  return { content, isError: false };
}

export function err(message: string): ToolExecutionResult {
  return { content: message, isError: true };
}

/**
 * Resolve the messaging provider from user input.
 * If platform is specified, look it up directly.
 * If only one provider is connected, auto-select it.
 * Otherwise, throw asking the user to specify.
 */
export function resolveProvider(platformInput?: string): MessagingProvider {
  if (platformInput) return getMessagingProvider(platformInput);

  const connected = getConnectedProviders().filter((p) =>
    isPlatformEnabled(p.id),
  );
  if (connected.length === 1) return connected[0];
  if (connected.length === 0) {
    throw new Error(
      "No messaging platforms are connected. Use messaging_auth_test to check connection status, then set up a platform.",
    );
  }

  const names = connected.map((p) => `"${p.id}"`).join(", ");
  throw new Error(
    `Multiple platforms connected (${names}). Specify platform parameter.`,
  );
}

/**
 * Execute a callback with a valid OAuth token for the given provider.
 * Providers that manage their own auth (e.g. Telegram with a bot token)
 * expose isConnected() and don't need an OAuth access_token lookup.
 */
export async function withProviderToken<T>(
  provider: MessagingProvider,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  if (provider.isConnected?.()) {
    return fn("");
  }
  return withValidToken(provider.credentialService, fn);
}
