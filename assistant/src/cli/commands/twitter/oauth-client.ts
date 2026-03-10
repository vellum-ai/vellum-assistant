/**
 * OAuth-backed Twitter API client.
 *
 * Accepts an OAuth2 Bearer token as a parameter and uses it to execute
 * Twitter API v2 operations directly (post and reply).
 */

const TWITTER_API_BASE = "https://api.x.com/2";

export interface OAuthPostResult {
  tweetId: string;
  text: string;
  url?: string;
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
