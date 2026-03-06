/**
 * Strategy router for Twitter operations.
 * Selects OAuth or browser path based on persisted preference and capability.
 */

import { loadRawConfig } from "../config/loader.js";
import type { PostTweetResult } from "./client.js";
import {
  postTweet as browserPostTweet,
  SessionExpiredError,
} from "./client.js";
import {
  oauthIsAvailable,
  oauthPostTweet,
  oauthSupportsOperation,
} from "./oauth-client.js";

export type TwitterStrategy = "oauth" | "browser" | "auto";

export interface RoutedResult<T> {
  result: T;
  pathUsed: TwitterStrategy;
}

export interface RoutedError {
  message: string;
  pathUsed: TwitterStrategy;
  suggestAlternative?: TwitterStrategy;
  alternativeSetupHint?: string;
}

function getPreferredStrategy(): TwitterStrategy {
  try {
    const raw = loadRawConfig();
    const strategy = raw.twitterOperationStrategy as string | undefined;
    if (strategy === "oauth" || strategy === "browser") return strategy;
  } catch {
    /* fall through */
  }
  return "auto";
}

export async function routedPostTweet(
  text: string,
  opts?: { inReplyToTweetId?: string },
): Promise<RoutedResult<PostTweetResult>> {
  const strategy = getPreferredStrategy();
  const operation = opts?.inReplyToTweetId ? "reply" : "post";

  if (strategy === "oauth") {
    // User explicitly wants OAuth
    if (!oauthIsAvailable()) {
      throw Object.assign(
        new Error(
          "OAuth is not configured. Provide your X developer credentials here in the chat to set up OAuth, or switch to browser strategy.",
        ),
        {
          pathUsed: "oauth" as const,
          suggestAlternative: "browser" as const,
        },
      );
    }
    const result = await oauthPostTweet(text, opts);
    return {
      result: {
        tweetId: result.tweetId,
        text: result.text,
        url: result.url ?? `https://x.com/i/status/${result.tweetId}`,
      },
      pathUsed: "oauth",
    };
  }

  if (strategy === "browser") {
    // User explicitly wants browser
    try {
      const result = await browserPostTweet(text, opts);
      return { result, pathUsed: "browser" };
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        throw Object.assign(err, {
          pathUsed: "browser" as const,
          suggestAlternative: "oauth" as const,
        });
      }
      throw err;
    }
  }

  // auto strategy: try OAuth first if available and supported, fallback to browser
  let oauthError: Error | undefined;
  if (oauthIsAvailable() && oauthSupportsOperation(operation)) {
    try {
      const result = await oauthPostTweet(text, opts);
      return {
        result: {
          tweetId: result.tweetId,
          text: result.text,
          url: result.url ?? `https://x.com/i/status/${result.tweetId}`,
        },
        pathUsed: "oauth",
      };
    } catch (err) {
      oauthError = err instanceof Error ? err : new Error(String(err));
      // Fall through to browser
    }
  }

  // Fallback to browser
  try {
    const result = await browserPostTweet(text, opts);
    return { result, pathUsed: "browser" };
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      throw Object.assign(err, {
        pathUsed: "auto" as const,
        oauthError: oauthError?.message,
      });
    }
    if (oauthError) {
      const browserError = err instanceof Error ? err : new Error(String(err));
      throw Object.assign(browserError, {
        pathUsed: "auto" as const,
        oauthError: oauthError.message,
      });
    }
    throw err;
  }
}
