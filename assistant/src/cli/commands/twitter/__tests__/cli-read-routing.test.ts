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

let mockBrowserGetUserByScreenNameResult: {
  userId: string;
  screenName: string;
  name: string;
} | null = null;
let mockBrowserGetUserByScreenNameError: Error | null = null;

let mockBrowserGetUserTweetsResult: Array<{
  tweetId: string;
  text: string;
  url: string;
  createdAt: string;
}> | null = null;
let mockBrowserGetUserTweetsError: Error | null = null;

let mockBrowserGetTweetDetailResult: Array<{
  tweetId: string;
  text: string;
  url: string;
  createdAt: string;
}> | null = null;
let mockBrowserGetTweetDetailError: Error | null = null;

let mockBrowserSearchTweetsResult: Array<{
  tweetId: string;
  text: string;
  url: string;
  createdAt: string;
}> | null = null;
let mockBrowserSearchTweetsError: Error | null = null;

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

class MockSessionExpiredError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SessionExpiredError";
  }
}

mock.module("../client.js", () => ({
  postTweet: async () => {
    throw new Error("Not used in read tests");
  },
  getUserByScreenName: async () => {
    if (mockBrowserGetUserByScreenNameError)
      throw mockBrowserGetUserByScreenNameError;
    if (mockBrowserGetUserByScreenNameResult)
      return mockBrowserGetUserByScreenNameResult;
    throw new Error("Browser getUserByScreenName mock not configured");
  },
  getUserTweets: async () => {
    if (mockBrowserGetUserTweetsError) throw mockBrowserGetUserTweetsError;
    if (mockBrowserGetUserTweetsResult) return mockBrowserGetUserTweetsResult;
    throw new Error("Browser getUserTweets mock not configured");
  },
  getTweetDetail: async () => {
    if (mockBrowserGetTweetDetailError) throw mockBrowserGetTweetDetailError;
    if (mockBrowserGetTweetDetailResult) return mockBrowserGetTweetDetailResult;
    throw new Error("Browser getTweetDetail mock not configured");
  },
  searchTweets: async () => {
    if (mockBrowserSearchTweetsError) throw mockBrowserSearchTweetsError;
    if (mockBrowserSearchTweetsResult) return mockBrowserSearchTweetsResult;
    throw new Error("Browser searchTweets mock not configured");
  },
  SessionExpiredError: MockSessionExpiredError,
}));

mock.module("../oauth-client.js", () => ({
  oauthIsAvailable: () => false,
  oauthSupportsOperation: () => false,
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
  mockBrowserGetUserByScreenNameResult = null;
  mockBrowserGetUserByScreenNameError = null;
  mockBrowserGetUserTweetsResult = null;
  mockBrowserGetUserTweetsError = null;
  mockBrowserGetTweetDetailResult = null;
  mockBrowserGetTweetDetailError = null;
  mockBrowserSearchTweetsResult = null;
  mockBrowserSearchTweetsError = null;
});

describe("Twitter read routing", () => {
  // =========================================================================
  // User lookup
  // =========================================================================
  describe("routedGetUserByScreenName", () => {
    test("managed strategy routes through proxy", async () => {
      mockManagedGetUserByUsernameResult = {
        data: { data: { id: "123", username: "testuser", name: "Test User" } },
        status: 200,
      };

      const { result, pathUsed } = await routedGetUserByScreenName("testuser", {
        strategy: "managed",
      });

      expect(pathUsed).toBe("managed");
      expect(result.userId).toBe("123");
      expect(result.screenName).toBe("testuser");
      expect(result.name).toBe("Test User");
    });

    test("browser strategy uses browser path", async () => {
      mockBrowserGetUserByScreenNameResult = {
        userId: "456",
        screenName: "browseruser",
        name: "Browser User",
      };

      const { result, pathUsed } = await routedGetUserByScreenName(
        "browseruser",
        { strategy: "browser" },
      );

      expect(pathUsed).toBe("browser");
      expect(result.userId).toBe("456");
      expect(result.screenName).toBe("browseruser");
    });

    test("auto strategy falls through to browser", async () => {
      mockBrowserGetUserByScreenNameResult = {
        userId: "789",
        screenName: "autouser",
        name: "Auto User",
      };

      const { result, pathUsed } = await routedGetUserByScreenName("autouser", {
        strategy: "auto",
      });

      expect(pathUsed).toBe("browser");
      expect(result.userId).toBe("789");
    });

    test("managed strategy surfaces proxy errors with metadata", async () => {
      mockManagedGetUserByUsernameError = new MockTwitterProxyError(
        "Rate limit exceeded — retry later",
        "rate_limit",
        true,
        429,
      );

      try {
        await routedGetUserByScreenName("testuser", { strategy: "managed" });
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
    test("managed strategy routes through proxy", async () => {
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
        strategy: "managed",
      });

      expect(pathUsed).toBe("managed");
      expect(result).toHaveLength(2);
      expect(result[0].tweetId).toBe("t1");
      expect(result[0].text).toBe("Hello world");
      expect(result[0].url).toBe("https://x.com/i/status/t1");
      expect(result[1].tweetId).toBe("t2");
    });

    test("browser strategy uses browser path", async () => {
      mockBrowserGetUserTweetsResult = [
        {
          tweetId: "bt1",
          text: "Browser tweet",
          url: "https://x.com/user/status/bt1",
          createdAt: "2025-01-01",
        },
      ];

      const { result, pathUsed } = await routedGetUserTweets("456", 20, {
        strategy: "browser",
      });

      expect(pathUsed).toBe("browser");
      expect(result).toHaveLength(1);
      expect(result[0].tweetId).toBe("bt1");
    });
  });

  // =========================================================================
  // Tweet detail
  // =========================================================================
  describe("routedGetTweetDetail", () => {
    test("managed strategy routes through proxy", async () => {
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
        strategy: "managed",
      });

      expect(pathUsed).toBe("managed");
      expect(result).toHaveLength(1);
      expect(result[0].tweetId).toBe("tweet-123");
      expect(result[0].text).toBe("A specific tweet");
    });

    test("browser strategy uses browser path", async () => {
      mockBrowserGetTweetDetailResult = [
        {
          tweetId: "detail-1",
          text: "Thread tweet 1",
          url: "https://x.com/user/status/detail-1",
          createdAt: "2025-01-01",
        },
        {
          tweetId: "detail-2",
          text: "Reply tweet",
          url: "https://x.com/user/status/detail-2",
          createdAt: "2025-01-01",
        },
      ];

      const { result, pathUsed } = await routedGetTweetDetail("detail-1", {
        strategy: "browser",
      });

      expect(pathUsed).toBe("browser");
      expect(result).toHaveLength(2);
    });

    test("managed strategy surfaces proxy errors", async () => {
      mockManagedGetTweetError = new MockTwitterProxyError(
        "Forbidden: insufficient permissions",
        "forbidden",
        false,
        403,
      );

      try {
        await routedGetTweetDetail("tweet-123", { strategy: "managed" });
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
    test("managed strategy routes through proxy", async () => {
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
        { strategy: "managed" },
      );

      expect(pathUsed).toBe("managed");
      expect(result).toHaveLength(1);
      expect(result[0].tweetId).toBe("s1");
      expect(result[0].text).toBe("Search result 1");
    });

    test("browser strategy uses browser path", async () => {
      mockBrowserSearchTweetsResult = [
        {
          tweetId: "bs1",
          text: "Browser search result",
          url: "https://x.com/user/status/bs1",
          createdAt: "2025-01-01",
        },
      ];

      const { result, pathUsed } = await routedSearchTweets(
        "test query",
        "Latest",
        { strategy: "browser" },
      );

      expect(pathUsed).toBe("browser");
      expect(result).toHaveLength(1);
      expect(result[0].tweetId).toBe("bs1");
    });

    test("auto strategy falls through to browser for search", async () => {
      mockBrowserSearchTweetsResult = [
        {
          tweetId: "auto-s1",
          text: "Auto search result",
          url: "https://x.com/user/status/auto-s1",
          createdAt: "2025-01-01",
        },
      ];

      const { result, pathUsed } = await routedSearchTweets("test", "Top", {
        strategy: "auto",
      });

      expect(pathUsed).toBe("browser");
      expect(result[0].tweetId).toBe("auto-s1");
    });

    test("managed strategy re-throws non-proxy errors", async () => {
      mockManagedSearchRecentTweetsError = new Error("Network failure");

      try {
        await routedSearchTweets("test", "Top", { strategy: "managed" });
        expect(true).toBe(false);
      } catch (err) {
        expect((err as Error).message).toBe("Network failure");
        expect((err as Record<string, unknown>).pathUsed).toBeUndefined();
      }
    });
  });
});
