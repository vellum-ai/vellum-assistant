/**
 * Shared utilities for slack skill tools.
 */

import { getMessagingProvider } from "../../../../messaging/registry.js";
import { withValidToken } from "../../../../security/token-manager.js";
import type { ToolExecutionResult } from "../../../../tools/types.js";

export function ok(content: string): ToolExecutionResult {
  return { content, isError: false };
}

export function err(message: string): ToolExecutionResult {
  return { content: message, isError: true };
}

/**
 * Execute a callback with a valid Slack OAuth token.
 */
export async function withSlackToken<T>(
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const provider = getMessagingProvider("slack");
  return withValidToken(provider.credentialService, fn);
}
