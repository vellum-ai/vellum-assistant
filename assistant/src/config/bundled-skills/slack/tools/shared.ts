/**
 * Shared utilities for slack skill tools.
 */

import { credentialKey } from "../../../../security/credential-key.js";
import { getSecureKeyAsync } from "../../../../security/secure-keys.js";
import type { ToolExecutionResult } from "../../../../tools/types.js";

export function ok(content: string): ToolExecutionResult {
  return { content, isError: false };
}

export function err(message: string): ToolExecutionResult {
  return { content: message, isError: true };
}

/**
 * Resolve the Slack bot token from credential storage.
 *
 * Slack uses direct bot/app tokens (Socket Mode), not OAuth connections.
 * The client functions accept `OAuthConnection | string`, so we return the
 * raw token string.
 */
export async function getSlackConnection(): Promise<string> {
  const token = await getSecureKeyAsync(
    credentialKey("slack_channel", "bot_token"),
  );
  if (!token) {
    throw new Error(
      "No Slack bot token found. Configure Slack with: assistant credentials set --service slack_channel --field bot_token",
    );
  }
  return token;
}
