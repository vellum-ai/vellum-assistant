/**
 * Shared utilities for twitter skill tools.
 */

import type { OAuthConnection } from "../../../../oauth/connection.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type { ToolExecutionResult } from "../../../../tools/types.js";

export function ok(content: string): ToolExecutionResult {
  return { content, isError: false };
}

export function err(message: string): ToolExecutionResult {
  return { content: message, isError: true };
}

/**
 * Resolve the Twitter OAuth connection.
 */
export async function getTwitterConnection(): Promise<OAuthConnection> {
  return resolveOAuthConnection("integration:twitter");
}

/**
 * Cache for authenticated user IDs, keyed by `${connectionId}:${accountInfo}`.
 */
const userIdCache = new Map<string, string>();

/**
 * Get the authenticated Twitter user ID for a connection.
 * Results are cached per connection+account to avoid redundant API calls.
 */
export async function getAuthenticatedUserId(
  conn: OAuthConnection,
): Promise<string> {
  const cacheKey = `${conn.id}:${conn.accountInfo ?? "default"}`;
  const cached = userIdCache.get(cacheKey);
  if (cached) return cached;

  const resp = await conn.request({
    method: "GET",
    path: "/2/users/me",
  });

  const body = resp.body as { data?: { id?: string } };
  const userId = body?.data?.id;
  if (!userId) {
    throw new Error(
      "Failed to resolve authenticated Twitter user ID. Check your connection.",
    );
  }

  userIdCache.set(cacheKey, userId);
  return userId;
}

/**
 * Extract a tweet ID from a URL or raw numeric string.
 *
 * Handles:
 * - https://twitter.com/user/status/123
 * - https://x.com/user/status/123
 * - URLs with query parameters
 * - Slack `<url|label>` format
 * - Raw numeric strings
 */
export function extractTweetId(input: string): string | null {
  if (!input) return null;

  let url = input.trim();

  // Handle Slack <url|label> format: extract URL before pipe, strip angle brackets
  if (url.startsWith("<") && url.includes("|")) {
    url = url.slice(1, url.indexOf("|"));
  } else if (url.startsWith("<") && url.endsWith(">")) {
    url = url.slice(1, -1);
  }

  // Try to parse as a tweet URL
  const urlMatch = url.match(
    /(?:https?:\/\/)?(?:(?:twitter|x)\.com)\/[^/]+\/status\/(\d+)/,
  );
  if (urlMatch) return urlMatch[1];

  // Try raw numeric ID
  if (/^\d+$/.test(url)) return url;

  return null;
}

/**
 * Extract all tweet URLs from a block of text.
 *
 * Scans for twitter.com and x.com status URLs, including Slack-formatted links.
 * Returns an array of `{ url, tweetId }` objects.
 */
export function extractAllTweetUrls(
  text: string,
): Array<{ url: string; tweetId: string }> {
  const results: Array<{ url: string; tweetId: string }> = [];
  const seen = new Set<string>();

  // Match Slack-formatted URLs: <https://x.com/user/status/123|label>
  const slackPattern =
    /<(https?:\/\/(?:twitter|x)\.com\/[^/]+\/status\/(\d+))[^>]*>/g;
  let match: RegExpExecArray | undefined;
  while ((match = slackPattern.exec(text) ?? undefined) !== undefined) {
    const tweetId = match[2];
    if (!seen.has(tweetId)) {
      seen.add(tweetId);
      results.push({ url: match[1], tweetId });
    }
  }

  // Match plain URLs: https://x.com/user/status/123
  const plainPattern = /https?:\/\/(?:twitter|x)\.com\/[^/]+\/status\/(\d+)/g;
  while ((match = plainPattern.exec(text) ?? undefined) !== undefined) {
    const tweetId = match[1];
    if (!seen.has(tweetId)) {
      seen.add(tweetId);
      results.push({ url: match[0], tweetId });
    }
  }

  return results;
}

/** Reset the user ID cache (for testing). */
export function _resetUserIdCache(): void {
  userIdCache.clear();
}
