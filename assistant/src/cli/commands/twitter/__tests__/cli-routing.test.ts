import { beforeEach, describe, expect, mock, test } from "bun:test";

// --- Mocks (must be declared before importing the module under test) ---

let mockOauthPostResult: {
  tweetId: string;
  text: string;
  url?: string;
} | null = null;
let mockOauthPostError: Error | null = null;
let mockBrowserPostResult: {
  tweetId: string;
  text: string;
  url: string;
} | null = null;
let mockBrowserPostError: Error | null = null;
let mockManagedPostResult: { data: unknown; status: number } | null = null;
let mockManagedPostError: Error | null = null;

// Mock the OAuth client
mock.module("../oauth-client.js", () => ({
  oauthIsAvailable: (token?: string) => token != null && token.length > 0,
  oauthSupportsOperation: (op: string) => op === "post" || op === "reply",
  oauthPostTweet: async (
    _text: string,
    _opts: { inReplyToTweetId?: string; oauthToken: string },
  ) => {
    if (mockOauthPostError) throw mockOauthPostError;
    if (mockOauthPostResult) return mockOauthPostResult;
    throw new Error("OAuth mock not configured");
  },
  UnsupportedOAuthOperationError: class UnsupportedOAuthOperationError extends Error {
    public readonly suggestFallback = true;
    public readonly fallbackPath = "browser" as const;
    public readonly operation: string;
    constructor(operation: string) {
      super(`The "${operation}" operation is not available via the OAuth API.`);
      this.name = "UnsupportedOAuthOperationError";
      this.operation = operation;
    }
  },
}));

// Mock TwitterProxyError for managed path tests
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

// Mock the platform proxy client
mock.module("../../../../twitter/platform-proxy-client.js", () => ({
  postTweet: async (_text: string, _opts?: { replyToId?: string }) => {
    if (mockManagedPostError) throw mockManagedPostError;
    if (mockManagedPostResult) return mockManagedPostResult;
    throw new Error("Managed mock not configured");
  },
  TwitterProxyError: MockTwitterProxyError,
}));

// Create a SessionExpiredError class that matches the real one
class MockSessionExpiredError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SessionExpiredError";
  }
}

// Mock the browser client
mock.module("../client.js", () => ({
  postTweet: async (_text: string, _opts?: { inReplyToTweetId?: string }) => {
    if (mockBrowserPostError) throw mockBrowserPostError;
    if (mockBrowserPostResult) return mockBrowserPostResult;
    throw new Error("Browser mock not configured");
  },
  SessionExpiredError: MockSessionExpiredError,
}));

// Mock the logger to silence output
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

import { routedPostTweet } from "../router.js";

beforeEach(() => {
  mockOauthPostResult = null;
  mockOauthPostError = null;
  mockBrowserPostResult = null;
  mockBrowserPostError = null;
  mockManagedPostResult = null;
  mockManagedPostError = null;
});

describe("Twitter strategy router", () => {
  describe("auto strategy", () => {
    test("uses OAuth when available and supported", async () => {
      mockOauthPostResult = {
        tweetId: "111",
        text: "hello",
        url: "https://x.com/u/status/111",
      };

      const { result, pathUsed } = await routedPostTweet("hello", {
        strategy: "auto",
        oauthToken: "test-token",
      });

      expect(pathUsed).toBe("oauth");
      expect(result.tweetId).toBe("111");
      expect(result.text).toBe("hello");
      expect(result.url).toBe("https://x.com/u/status/111");
    });

    test("falls back to browser when OAuth is unavailable", async () => {
      mockBrowserPostResult = {
        tweetId: "222",
        text: "hello",
        url: "https://x.com/u/status/222",
      };

      const { result, pathUsed } = await routedPostTweet("hello", {
        strategy: "auto",
      });

      expect(pathUsed).toBe("browser");
      expect(result.tweetId).toBe("222");
    });

    test("falls back to browser when OAuth fails", async () => {
      mockOauthPostError = new Error("OAuth token expired");
      mockBrowserPostResult = {
        tweetId: "333",
        text: "hello",
        url: "https://x.com/u/status/333",
      };

      const { result, pathUsed } = await routedPostTweet("hello", {
        strategy: "auto",
        oauthToken: "test-token",
      });

      expect(pathUsed).toBe("browser");
      expect(result.tweetId).toBe("333");
    });

    test("constructs URL from tweetId when OAuth result has no url", async () => {
      mockOauthPostResult = { tweetId: "444", text: "no url" };

      const { result, pathUsed } = await routedPostTweet("no url", {
        strategy: "auto",
        oauthToken: "test-token",
      });

      expect(pathUsed).toBe("oauth");
      expect(result.url).toBe("https://x.com/i/status/444");
    });

    test("throws combined error when both OAuth and browser fail with SessionExpiredError", async () => {
      mockOauthPostError = new Error("OAuth failed");
      mockBrowserPostError = new MockSessionExpiredError(
        "Browser session expired",
      );

      try {
        await routedPostTweet("will fail", {
          strategy: "auto",
          oauthToken: "test-token",
        });
        expect(true).toBe(false); // should not reach
      } catch (err) {
        const e = err as Error & { pathUsed: string; oauthError?: string };
        expect(e).toBeInstanceOf(MockSessionExpiredError);
        expect(e.message).toBe("Browser session expired");
        expect(e.pathUsed).toBe("auto");
        expect(e.oauthError).toBe("OAuth failed");
      }
    });
  });

  describe("explicit oauth strategy", () => {
    test("fails with helpful error when OAuth is not configured", async () => {
      try {
        await routedPostTweet("hello", { strategy: "oauth" });
        expect(true).toBe(false); // should not reach
      } catch (err) {
        const e = err as Error & {
          pathUsed: string;
          suggestAlternative: string;
        };
        expect(e.message).toContain("OAuth is not configured");
        expect(e.message).toContain(
          "assistant config set twitter.operationStrategy browser",
        );
        expect(e.pathUsed).toBe("oauth");
        expect(e.suggestAlternative).toBe("browser");
      }
    });

    test("uses OAuth when available", async () => {
      mockOauthPostResult = { tweetId: "555", text: "oauth post" };

      const { result, pathUsed } = await routedPostTweet("oauth post", {
        strategy: "oauth",
        oauthToken: "test-token",
      });

      expect(pathUsed).toBe("oauth");
      expect(result.tweetId).toBe("555");
    });
  });

  describe("explicit browser strategy", () => {
    test("uses browser directly, ignoring OAuth availability", async () => {
      mockBrowserPostResult = {
        tweetId: "666",
        text: "browser post",
        url: "https://x.com/u/status/666",
      };

      const { result, pathUsed } = await routedPostTweet("browser post", {
        strategy: "browser",
        oauthToken: "test-token", // available but should be ignored
      });

      expect(pathUsed).toBe("browser");
      expect(result.tweetId).toBe("666");
    });

    test("preserves SessionExpiredError type with router metadata", async () => {
      mockBrowserPostError = new MockSessionExpiredError("Session expired");

      try {
        await routedPostTweet("will fail", { strategy: "browser" });
        expect(true).toBe(false); // should not reach
      } catch (err) {
        const e = err as Error & {
          pathUsed: string;
          suggestAlternative: string;
        };
        expect(e).toBeInstanceOf(MockSessionExpiredError);
        expect(e.message).toBe("Session expired");
        expect(e.pathUsed).toBe("browser");
        expect(e.suggestAlternative).toBe("oauth");
      }
    });

    test("re-throws non-session errors without wrapping", async () => {
      mockBrowserPostError = new Error("Network failure");

      try {
        await routedPostTweet("will fail", { strategy: "browser" });
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect((err as Error).message).toBe("Network failure");
      }
    });
  });

  describe("managed strategy", () => {
    test("routes post through platform proxy", async () => {
      mockManagedPostResult = {
        data: { data: { id: "managed-1" } },
        status: 200,
      };

      const { result, pathUsed } = await routedPostTweet("managed post", {
        strategy: "managed",
      });

      expect(pathUsed).toBe("managed");
      expect(result.tweetId).toBe("managed-1");
      expect(result.url).toBe("https://x.com/i/status/managed-1");
    });

    test("routes reply through platform proxy", async () => {
      mockManagedPostResult = {
        data: { data: { id: "managed-reply-1" } },
        status: 200,
      };

      const { result, pathUsed } = await routedPostTweet("reply text", {
        strategy: "managed",
        inReplyToTweetId: "original-tweet-123",
      });

      expect(pathUsed).toBe("managed");
      expect(result.tweetId).toBe("managed-reply-1");
    });

    test("surfaces proxy errors with actionable metadata", async () => {
      mockManagedPostError = new MockTwitterProxyError(
        "Connect Twitter in Settings as the assistant owner",
        "owner_credential_required",
        false,
        403,
      );

      try {
        await routedPostTweet("will fail", { strategy: "managed" });
        expect(true).toBe(false); // should not reach
      } catch (err) {
        const e = err as Error & {
          pathUsed: string;
          proxyErrorCode: string;
          retryable: boolean;
        };
        expect(e.message).toBe(
          "Connect Twitter in Settings as the assistant owner",
        );
        expect(e.pathUsed).toBe("managed");
        expect(e.proxyErrorCode).toBe("owner_credential_required");
        expect(e.retryable).toBe(false);
      }
    });

    test("surfaces retryable proxy errors", async () => {
      mockManagedPostError = new MockTwitterProxyError(
        "Reconnect Twitter or retry",
        "auth_failure",
        true,
        401,
      );

      try {
        await routedPostTweet("will fail", { strategy: "managed" });
        expect(true).toBe(false);
      } catch (err) {
        const e = err as Error & {
          pathUsed: string;
          proxyErrorCode: string;
          retryable: boolean;
        };
        expect(e.pathUsed).toBe("managed");
        expect(e.proxyErrorCode).toBe("auth_failure");
        expect(e.retryable).toBe(true);
      }
    });

    test("re-throws non-proxy errors without wrapping", async () => {
      mockManagedPostError = new Error("Network failure");

      try {
        await routedPostTweet("will fail", { strategy: "managed" });
        expect(true).toBe(false);
      } catch (err) {
        expect((err as Error).message).toBe("Network failure");
        expect((err as Record<string, unknown>).pathUsed).toBeUndefined();
      }
    });
  });

  describe("reply routing", () => {
    test("auto strategy routes reply through OAuth when available", async () => {
      mockOauthPostResult = {
        tweetId: "777",
        text: "reply text",
        url: "https://x.com/u/status/777",
      };

      const { result, pathUsed } = await routedPostTweet("reply text", {
        inReplyToTweetId: "100",
        strategy: "auto",
        oauthToken: "test-token",
      });

      expect(pathUsed).toBe("oauth");
      expect(result.tweetId).toBe("777");
    });

    test("browser strategy routes reply through browser", async () => {
      mockBrowserPostResult = {
        tweetId: "888",
        text: "reply text",
        url: "https://x.com/u/status/888",
      };

      const { result, pathUsed } = await routedPostTweet("reply text", {
        inReplyToTweetId: "200",
        strategy: "browser",
      });

      expect(pathUsed).toBe("browser");
      expect(result.tweetId).toBe("888");
    });
  });
});
