/**
 * Mode router for Twitter operations.
 * Selects managed proxy or OAuth path based on the caller-provided integration mode.
 */

import {
  getTweet as managedGetTweet,
  getUserByUsername as managedGetUserByUsername,
  getUserTweets as managedGetUserTweets,
  postTweet as managedPostTweet,
  searchRecentTweets as managedSearchRecentTweets,
  TwitterProxyError,
} from "../../../twitter/platform-proxy-client.js";
import { oauthIsAvailable, oauthPostTweet } from "./oauth-client.js";
import type { PostTweetResult, TweetEntry, UserInfo } from "./types.js";

export type TwitterMode = "oauth" | "managed";

export interface RoutedResult<T> {
  result: T;
  pathUsed: TwitterMode;
}

export async function routedPostTweet(
  text: string,
  opts: {
    inReplyToTweetId?: string;
    mode: TwitterMode;
    oauthToken?: string;
  },
): Promise<RoutedResult<PostTweetResult>> {
  const mode = opts.mode;

  if (mode === "managed") {
    // Route through platform proxy — the platform holds the OAuth credentials
    try {
      const response = await managedPostTweet(text, {
        replyToId: opts.inReplyToTweetId,
      });
      const data = response.data as Record<string, unknown>;
      const tweetData = (data?.data ?? data) as Record<string, unknown>;
      const tweetId = String(tweetData.id ?? "");
      if (!tweetId) {
        throw Object.assign(
          new Error(
            "Managed post succeeded but the proxy response did not include a tweet ID",
          ),
          {
            pathUsed: "managed" as const,
          },
        );
      }
      return {
        result: {
          tweetId,
          text,
          url: `https://x.com/i/status/${tweetId}`,
        },
        pathUsed: "managed",
      };
    } catch (err) {
      if (err instanceof TwitterProxyError) {
        // Surface actionable error messages from the proxy
        throw Object.assign(new Error(err.message), {
          pathUsed: "managed" as const,
          proxyErrorCode: err.code,
          retryable: err.retryable,
        });
      }
      throw err;
    }
  }

  if (mode === "oauth") {
    // User explicitly wants OAuth
    if (!oauthIsAvailable(opts.oauthToken)) {
      throw Object.assign(
        new Error(
          "OAuth is not configured. Connect your X developer credentials to set up OAuth.",
        ),
        {
          pathUsed: "oauth" as const,
        },
      );
    }
    const result = await oauthPostTweet(text, {
      inReplyToTweetId: opts.inReplyToTweetId,
      oauthToken: opts.oauthToken!,
    });
    return {
      result: {
        tweetId: result.tweetId,
        text: result.text,
        url: result.url ?? `https://x.com/i/status/${result.tweetId}`,
      },
      pathUsed: "oauth",
    };
  }

  // Exhaustive check — should never reach here
  const _exhaustive: never = mode;
  throw new Error(`Unknown mode: ${_exhaustive}`);
}

// ---------------------------------------------------------------------------
// Routed read operations
// ---------------------------------------------------------------------------

/**
 * Look up a user by screen name.
 * Managed mode uses GET /2/users/by/username/:username.
 */
export async function routedGetUserByScreenName(
  screenName: string,
  opts: { mode: TwitterMode },
): Promise<RoutedResult<UserInfo>> {
  if (opts.mode === "managed") {
    try {
      const response = await managedGetUserByUsername(screenName, {
        "user.fields": "id,name,username",
      });
      const data = response.data as Record<string, unknown>;
      const userData = (data?.data ?? data) as Record<string, unknown>;
      if (!userData.id) {
        throw Object.assign(new Error(`User not found: @${screenName}`), {
          pathUsed: "managed" as const,
        });
      }
      return {
        result: {
          userId: String(userData.id),
          screenName: String(
            userData.username ?? userData.screen_name ?? screenName,
          ),
          name: String(userData.name ?? screenName),
        },
        pathUsed: "managed",
      };
    } catch (err) {
      if (err instanceof TwitterProxyError) {
        throw Object.assign(new Error(err.message), {
          pathUsed: "managed" as const,
          proxyErrorCode: err.code,
          retryable: err.retryable,
        });
      }
      throw err;
    }
  }

  if (opts.mode === "oauth") {
    throw Object.assign(
      new Error(
        "Read operations are not supported via OAuth. Use managed mode for read access.",
      ),
      { pathUsed: "oauth" as const },
    );
  }

  const _exhaustive: never = opts.mode;
  throw new Error(`Unknown mode: ${_exhaustive}`);
}

/**
 * Fetch a user's recent tweets.
 * Managed mode uses GET /2/users/:id/tweets.
 */
export async function routedGetUserTweets(
  userId: string,
  count: number,
  opts: { mode: TwitterMode },
): Promise<RoutedResult<TweetEntry[]>> {
  if (opts.mode === "managed") {
    try {
      const response = await managedGetUserTweets(userId, {
        max_results: String(Math.min(count, 100)),
        "tweet.fields": "id,text,created_at,author_id",
      });
      const data = response.data as Record<string, unknown>;
      const tweetsArray = (data?.data ?? []) as Array<Record<string, unknown>>;
      const tweets: TweetEntry[] = tweetsArray.map((t) => ({
        tweetId: String(t.id ?? ""),
        text: String(t.text ?? ""),
        url: `https://x.com/i/status/${t.id}`,
        createdAt: String(t.created_at ?? ""),
      }));
      return { result: tweets, pathUsed: "managed" };
    } catch (err) {
      if (err instanceof TwitterProxyError) {
        throw Object.assign(new Error(err.message), {
          pathUsed: "managed" as const,
          proxyErrorCode: err.code,
          retryable: err.retryable,
        });
      }
      throw err;
    }
  }

  if (opts.mode === "oauth") {
    throw Object.assign(
      new Error(
        "Read operations are not supported via OAuth. Use managed mode for read access.",
      ),
      { pathUsed: "oauth" as const },
    );
  }

  const _exhaustive: never = opts.mode;
  throw new Error(`Unknown mode: ${_exhaustive}`);
}

/**
 * Fetch a single tweet by ID.
 * Managed mode uses GET /2/tweets/:id.
 */
export async function routedGetTweetDetail(
  tweetId: string,
  opts: { mode: TwitterMode },
): Promise<RoutedResult<TweetEntry[]>> {
  if (opts.mode === "managed") {
    try {
      const response = await managedGetTweet(tweetId, {
        "tweet.fields": "id,text,created_at,author_id,conversation_id",
      });
      const data = response.data as Record<string, unknown>;
      const tweetData = (data?.data ?? data) as Record<string, unknown>;
      const primaryTweet: TweetEntry = {
        tweetId: String(tweetData.id ?? ""),
        text: String(tweetData.text ?? ""),
        url: `https://x.com/i/status/${tweetData.id}`,
        createdAt: String(tweetData.created_at ?? ""),
      };

      // If the tweet has a conversation_id, fetch the thread via search
      const conversationId = tweetData.conversation_id as string | undefined;
      if (conversationId) {
        try {
          const threadResponse = await managedSearchRecentTweets(
            `conversation_id:${conversationId}`,
            {
              "tweet.fields": "id,text,created_at,author_id",
              max_results: "100",
            },
          );
          const threadData = threadResponse.data as Record<string, unknown>;
          const threadArray = (threadData?.data ?? []) as Array<
            Record<string, unknown>
          >;
          const threadTweets: TweetEntry[] = threadArray.map((t) => ({
            tweetId: String(t.id ?? ""),
            text: String(t.text ?? ""),
            url: `https://x.com/i/status/${t.id}`,
            createdAt: String(t.created_at ?? ""),
          }));
          // Deduplicate: the primary tweet may already be in the search results
          const seen = new Set(threadTweets.map((t) => t.tweetId));
          if (!seen.has(primaryTweet.tweetId)) {
            threadTweets.unshift(primaryTweet);
          }
          return { result: threadTweets, pathUsed: "managed" };
        } catch {
          // If thread search fails, fall back to returning just the single tweet
        }
      }

      return { result: [primaryTweet], pathUsed: "managed" };
    } catch (err) {
      if (err instanceof TwitterProxyError) {
        throw Object.assign(new Error(err.message), {
          pathUsed: "managed" as const,
          proxyErrorCode: err.code,
          retryable: err.retryable,
        });
      }
      throw err;
    }
  }

  if (opts.mode === "oauth") {
    throw Object.assign(
      new Error(
        "Read operations are not supported via OAuth. Use managed mode for read access.",
      ),
      { pathUsed: "oauth" as const },
    );
  }

  const _exhaustive: never = opts.mode;
  throw new Error(`Unknown mode: ${_exhaustive}`);
}

/**
 * Search tweets.
 * Managed mode uses GET /2/tweets/search/recent.
 */
export async function routedSearchTweets(
  query: string,
  product: "Top" | "Latest" | "People" | "Media",
  opts: { mode: TwitterMode },
): Promise<RoutedResult<TweetEntry[]>> {
  if (opts.mode === "managed") {
    if (product === "People" || product === "Media") {
      throw Object.assign(
        new Error(
          `Product type "${product}" is not supported in managed mode. Only "Top" and "Latest" are supported.`,
        ),
        { pathUsed: "managed" as const },
      );
    }
    try {
      const queryParams: Record<string, string> = {
        "tweet.fields": "id,text,created_at,author_id",
      };
      if (product === "Latest") {
        queryParams.sort_order = "recency";
      }
      const response = await managedSearchRecentTweets(query, queryParams);
      const data = response.data as Record<string, unknown>;
      const tweetsArray = (data?.data ?? []) as Array<Record<string, unknown>>;
      const tweets: TweetEntry[] = tweetsArray.map((t) => ({
        tweetId: String(t.id ?? ""),
        text: String(t.text ?? ""),
        url: `https://x.com/i/status/${t.id}`,
        createdAt: String(t.created_at ?? ""),
      }));
      return { result: tweets, pathUsed: "managed" };
    } catch (err) {
      if (err instanceof TwitterProxyError) {
        throw Object.assign(new Error(err.message), {
          pathUsed: "managed" as const,
          proxyErrorCode: err.code,
          retryable: err.retryable,
        });
      }
      throw err;
    }
  }

  if (opts.mode === "oauth") {
    throw Object.assign(
      new Error(
        "Read operations are not supported via OAuth. Use managed mode for read access.",
      ),
      { pathUsed: "oauth" as const },
    );
  }

  const _exhaustive: never = opts.mode;
  throw new Error(`Unknown mode: ${_exhaustive}`);
}
