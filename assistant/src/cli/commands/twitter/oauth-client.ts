/**
 * OAuth-backed Twitter API client.
 *
 * Accepts an OAuth2 Bearer token as a parameter and uses it to execute
 * Twitter API v2 operations directly. Currently supports post and reply;
 * all other operations require managed mode.
 */

const TWITTER_API_BASE = "https://api.x.com/2";

/** Operations that the OAuth client can handle natively. */
const SUPPORTED_OPERATIONS = new Set(["post", "reply"]);

export interface OAuthPostResult {
  tweetId: string;
  text: string;
  url?: string;
}

export interface OAuthOperationError {
  message: string;
  operation: string;
}

export class UnsupportedOAuthOperationError extends Error {
  public readonly operation: string;
  constructor(operation: string) {
    super(
      `The "${operation}" operation is not available via the OAuth API. Use managed mode instead.`,
    );
    this.name = "UnsupportedOAuthOperationError";
    this.operation = operation;
  }
}

/**
 * Post a tweet (or reply) using OAuth2 Bearer token authentication.
 *
 * The caller is responsible for providing a valid token (e.g. via
 * `assistant oauth token twitter`).
 */
export async function oauthPostTweet(
  text: string,
  opts: { inReplyToTweetId?: string; oauthToken: string },
): Promise<OAuthPostResult> {
  const body: Record<string, unknown> = { text };
  if (opts.inReplyToTweetId) {
    body.reply = { in_reply_to_tweet_id: opts.inReplyToTweetId };
  }

  const res = await fetch(`${TWITTER_API_BASE}/tweets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.oauthToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(
      `Twitter API error (${res.status}): ${errorBody.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as { data: { id: string; text: string } };
  return {
    tweetId: json.data.id,
    text: json.data.text,
  };
}

/**
 * Check whether an OAuth token is available.
 * When the caller provides a token string, OAuth is available.
 */
export function oauthIsAvailable(oauthToken: string | undefined): boolean {
  return oauthToken != null && oauthToken.length > 0;
}

/**
 * Check whether a given operation is supported via the OAuth API path.
 * Only `post` and `reply` are currently supported; everything else
 * (timeline, search, bookmarks, etc.) requires managed mode.
 */
export function oauthSupportsOperation(operation: string): boolean {
  return SUPPORTED_OPERATIONS.has(operation);
}
