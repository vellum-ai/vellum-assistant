import { beforeEach, describe, expect, mock, test } from "bun:test";

// --- Mock state ---

let mockManagedGetUserByUsernameResult: {
  data: unknown;
  status: number;
} | null = null;
let mockManagedGetUserByUsernameError: Error | null = null;

let mockManagedGetUserTweetsResult: {
  data: unknown;
  status: number;
} | null = null;
let mockManagedGetUserTweetsError: Error | null = null;

let mockManagedGetTweetResult: { data: unknown; status: number } | null = null;
let mockManagedGetTweetError: Error | null = null;

let mockManagedSearchRecentTweetsResult: {
  data: unknown;
  status: number;
} | null = null;
let mockManagedSearchRecentTweetsError: Error | null = null;

// --- Mock TwitterProxyError ---

class MockTwitterProxyError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly statusCode: number;
  constructor(
    message: string,
    code: string,
    retryable: boolean,
    statusCode = 0,
  ) {
    super(message);
    this.name = "TwitterProxyError";
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

// --- Mocks ---

mock.module("../../../../twitter/platform-proxy-client.js", () => ({
  postTweet: async () => {
    throw new Error("Not used in read tests");
  },
  getUserByUsername: async () => {
    if (mockManagedGetUserByUsernameError)
      throw mockManagedGetUserByUsernameError;
    if (mockManagedGetUserByUsernameResult)
      return mockManagedGetUserByUsernameResult;
    throw new Error("Managed getUserByUsername mock not configured");
  },
  getUserTweets: async () => {
    if (mockManagedGetUserTweetsError) throw mockManagedGetUserTweetsError;
    if (mockManagedGetUserTweetsResult) return mockManagedGetUserTweetsResult;
    throw new Error("Managed getUserTweets mock not configured");
  },
  getTweet: async () => {
    if (mockManagedGetTweetError) throw mockManagedGetTweetError;
    if (mockManagedGetTweetResult) return mockManagedGetTweetResult;
    throw new Error("Managed getTweet mock not configured");
  },
  searchRecentTweets: async () => {
    if (mockManagedSearchRecentTweetsError)
      throw mockManagedSearchRecentTweetsError;
    if (mockManagedSearchRecentTweetsResult)
      return mockManagedSearchRecentTweetsResult;
    throw new Error("Managed searchRecentTweets mock not configured");
  },
  TwitterProxyError: MockTwitterProxyError,
}));

mock.module("../client.js", () => ({
  // No browser functions needed — router no longer imports them
}));

mock.module("../oauth-client.js", () => ({
  oauthIsAvailable: () => false,
  oauthPostTweet: async () => {
    throw new Error("Not used in read tests");
  },
}));

mock.module("../../../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

import {
  routedGetTweetDetail,
  routedGetUserByScreenName,
  routedGetUserTweets,
  routedSearchTweets,
} from "../router.js";

beforeEach(() => {
  mockManagedGetUserByUsernameResult = null;
  mockManagedGetUserByUsernameError = null;
  mockManagedGetUserTweetsResult = null;
  mockManagedGetUserTweetsError = null;
  mockManagedGetTweetResult = null;
  mockManagedGetTweetError = null;
  mockManagedSearchRecentTweetsResult = null;
  mockManagedSearchRecentTweetsError = null;
});

describe("Twitter read routing", () => {
  // =========================================================================
  // User lookup
  // =========================================================================
  describe("routedGetUserByScreenName", () => {
    test("managed mode routes through proxy", async () => {
      mockManagedGetUserByUsernameResult = {
        data: { data: { id: "123", username: "testuser", name: "Test User" } },
        status: 200,
      };

      const { result, pathUsed } = await routedGetUserByScreenName("testuser", {
        mode: "managed",
      });

      expect(pathUsed).toBe("managed");
      expect(result.userId).toBe("123");
      expect(result.screenName).toBe("testuser");
      expect(result.name).toBe("Test User");
    });

    test("oauth mode throws clear error for read operations", async () => {
      try {
        await routedGetUserByScreenName("testuser", { mode: "oauth" });
        expect(true).toBe(false);
      } catch (err) {
        const e = err as Error & { pathUsed: string };
        expect(e.message).toContain(
          "Read operations are not supported via OAuth",
        );
        expect(e.pathUsed).toBe("oauth");
      }
    });

    test("managed mode surfaces proxy errors with metadata", async () => {
      mockManagedGetUserByUsernameError = new MockTwitterProxyError(
        "Rate limit exceeded — retry later",
        "rate_limit",
        true,
        429,
      );

      try {
        await routedGetUserByScreenName("testuser", { mode: "managed" });
        expect(true).toBe(false);
      } catch (err) {
        const e = err as Error & {
          pathUsed: string;
          proxyErrorCode: string;
          retryable: boolean;
        };
        expect(e.message).toBe("Rate limit exceeded — retry later");
        expect(e.pathUsed).toBe("managed");
        expect(e.proxyErrorCode).toBe("rate_limit");
        expect(e.retryable).toBe(true);
      }
    });
  });

  // =========================================================================
  // User tweets
  // =========================================================================
  describe("routedGetUserTweets", () => {
    test("managed mode routes through proxy", async () => {
      mockManagedGetUserTweetsResult = {
        data: {
          data: [
            {
              id: "t1",
              text: "Hello world",
              created_at: "2025-01-01T00:00:00Z",
            },
            {
              id: "t2",
              text: "Second tweet",
              created_at: "2025-01-02T00:00:00Z",
            },
          ],
        },
        status: 200,
      };

      const { result, pathUsed } = await routedGetUserTweets("123", 20, {
        mode: "managed",
      });

      expect(pathUsed).toBe("managed");
      expect(result).toHaveLength(2);
      expect(result[0].tweetId).toBe("t1");
      expect(result[0].text).toBe("Hello world");
      expect(result[0].url).toBe("https://x.com/i/status/t1");
      expect(result[1].tweetId).toBe("t2");
    });

    test("oauth mode throws clear error for read operations", async () => {
      try {
        await routedGetUserTweets("456", 20, { mode: "oauth" });
        expect(true).toBe(false);
      } catch (err) {
        const e = err as Error & { pathUsed: string };
        expect(e.message).toContain(
          "Read operations are not supported via OAuth",
        );
        expect(e.pathUsed).toBe("oauth");
      }
    });
  });

  // =========================================================================
  // Tweet detail
  // =========================================================================
  describe("routedGetTweetDetail", () => {
    test("managed mode routes through proxy", async () => {
      mockManagedGetTweetResult = {
        data: {
          data: {
            id: "tweet-123",
            text: "A specific tweet",
            created_at: "2025-01-01T00:00:00Z",
          },
        },
        status: 200,
      };

      const { result, pathUsed } = await routedGetTweetDetail("tweet-123", {
        mode: "managed",
      });

      expect(pathUsed).toBe("managed");
      expect(result).toHaveLength(1);
      expect(result[0].tweetId).toBe("tweet-123");
      expect(result[0].text).toBe("A specific tweet");
    });

    test("oauth mode throws clear error for read operations", async () => {
      try {
        await routedGetTweetDetail("tweet-123", { mode: "oauth" });
        expect(true).toBe(false);
      } catch (err) {
        const e = err as Error & { pathUsed: string };
        expect(e.message).toContain(
          "Read operations are not supported via OAuth",
        );
        expect(e.pathUsed).toBe("oauth");
      }
    });

    test("managed mode surfaces proxy errors", async () => {
      mockManagedGetTweetError = new MockTwitterProxyError(
        "Forbidden: insufficient permissions",
        "forbidden",
        false,
        403,
      );

      try {
        await routedGetTweetDetail("tweet-123", { mode: "managed" });
        expect(true).toBe(false);
      } catch (err) {
        const e = err as Error & {
          pathUsed: string;
          proxyErrorCode: string;
        };
        expect(e.pathUsed).toBe("managed");
        expect(e.proxyErrorCode).toBe("forbidden");
      }
    });
  });

  // =========================================================================
  // Search
  // =========================================================================
  describe("routedSearchTweets", () => {
    test("managed mode routes through proxy", async () => {
      mockManagedSearchRecentTweetsResult = {
        data: {
          data: [
            {
              id: "s1",
              text: "Search result 1",
              created_at: "2025-01-01T00:00:00Z",
            },
          ],
        },
        status: 200,
      };

      const { result, pathUsed } = await routedSearchTweets(
        "AI agents",
        "Top",
        { mode: "managed" },
      );

      expect(pathUsed).toBe("managed");
      expect(result).toHaveLength(1);
      expect(result[0].tweetId).toBe("s1");
      expect(result[0].text).toBe("Search result 1");
    });

    test("oauth mode throws clear error for read operations", async () => {
      try {
        await routedSearchTweets("test query", "Latest", { mode: "oauth" });
        expect(true).toBe(false);
      } catch (err) {
        const e = err as Error & { pathUsed: string };
        expect(e.message).toContain(
          "Read operations are not supported via OAuth",
        );
        expect(e.pathUsed).toBe("oauth");
      }
    });

    test("managed mode re-throws non-proxy errors", async () => {
      mockManagedSearchRecentTweetsError = new Error("Network failure");

      try {
        await routedSearchTweets("test", "Top", { mode: "managed" });
        expect(true).toBe(false);
      } catch (err) {
        expect((err as Error).message).toBe("Network failure");
        expect((err as Record<string, unknown>).pathUsed).toBeUndefined();
      }
    });
  });
});
