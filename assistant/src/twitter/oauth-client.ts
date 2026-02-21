/**
 * OAuth-backed Twitter API client.
 *
 * Uses stored OAuth2 Bearer tokens (via the token manager) to execute
 * Twitter API v2 operations directly, without requiring a browser session.
 * Currently supports post and reply; all other operations fall back to the
 * browser-based CDP client.
 */

import { withValidToken } from '../security/token-manager.js';
import { getSecureKey } from '../security/secure-keys.js';

const TWITTER_API_BASE = 'https://api.x.com/2';
const SERVICE = 'integration:twitter';

/** Operations that the OAuth client can handle natively. */
const SUPPORTED_OPERATIONS = new Set(['post', 'reply']);

export interface OAuthPostResult {
  tweetId: string;
  text: string;
  url?: string;
}

export interface OAuthOperationError {
  message: string;
  suggestFallback: boolean;
  fallbackPath: 'browser';
  operation: string;
}

export class UnsupportedOAuthOperationError extends Error {
  public readonly suggestFallback = true;
  public readonly fallbackPath = 'browser' as const;
  public readonly operation: string;
  constructor(operation: string) {
    super(`The "${operation}" operation is not available via the OAuth API. Use the browser path instead.`);
    this.name = 'UnsupportedOAuthOperationError';
    this.operation = operation;
  }
}

/**
 * Post a tweet (or reply) using OAuth2 Bearer token authentication.
 *
 * The token manager handles refresh transparently — if the stored token
 * is expired it will be refreshed before (or after a 401) calling the API.
 */
export async function oauthPostTweet(
  text: string,
  opts?: { inReplyToTweetId?: string },
): Promise<OAuthPostResult> {
  return withValidToken(SERVICE, async (token) => {
    const body: Record<string, unknown> = { text };
    if (opts?.inReplyToTweetId) {
      body.reply = { in_reply_to_tweet_id: opts.inReplyToTweetId };
    }

    const res = await fetch(`${TWITTER_API_BASE}/tweets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      const err = new Error(
        `Twitter API error (${res.status}): ${errorBody.slice(0, 500)}`,
      );
      // Attach status so the token manager's 401-retry logic can detect it.
      (err as Error & { status: number }).status = res.status;
      throw err;
    }

    const json = (await res.json()) as { data: { id: string; text: string } };
    return {
      tweetId: json.data.id,
      text: json.data.text,
    };
  });
}

/**
 * Check whether OAuth credentials are available for the Twitter integration.
 * Returns true if an access token has been stored (the token manager will
 * handle refresh if it's expired).
 */
export function oauthIsAvailable(): boolean {
  return getSecureKey('credential:integration:twitter:access_token') !== undefined;
}

/**
 * Check whether a given operation is supported via the OAuth API path.
 * Only `post` and `reply` are currently supported; everything else
 * (timeline, search, bookmarks, etc.) requires the browser path.
 */
export function oauthSupportsOperation(operation: string): boolean {
  return SUPPORTED_OPERATIONS.has(operation);
}
