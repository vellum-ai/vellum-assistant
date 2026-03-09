import { beforeEach, describe, expect, mock, test } from "bun:test";

// --- Mocks (must be declared before importing the module under test) ---

let mockOauthPostResult: {
  tweetId: string;
  text: string;
  url?: string;
} | null = null;
let mockOauthPostError: Error | null = null;
let mockManagedPostResult: { data: unknown; status: number } | null = null;
let mockManagedPostError: Error | null = null;

// Mock the OAuth client
mock.module("../oauth-client.js", () => ({
  oauthIsAvailable: (token?: string) => token != null && token.length > 0,
  oauthPostTweet: async (
    _text: string,
    _opts: { inReplyToTweetId?: string; oauthToken: string },
  ) => {
    if (mockOauthPostError) throw mockOauthPostError;
    if (mockOauthPostResult) return mockOauthPostResult;
    throw new Error("OAuth mock not configured");
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

// Mock the browser client — no longer used by router
mock.module("../client.js", () => ({}));

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
  mockManagedPostResult = null;
  mockManagedPostError = null;
});

describe("Twitter mode router", () => {
  describe("explicit oauth mode", () => {
    test("fails with helpful error when OAuth is not configured", async () => {
      try {
        await routedPostTweet("hello", { mode: "oauth" });
        expect(true).toBe(false); // should not reach
      } catch (err) {
        const e = err as Error & {
          pathUsed: string;
        };
        expect(e.message).toContain("OAuth is not configured");
        expect(e.message).toContain(
          "Connect your X developer credentials to set up OAuth",
        );
        expect(e.pathUsed).toBe("oauth");
      }
    });

    test("uses OAuth when available", async () => {
      mockOauthPostResult = { tweetId: "555", text: "oauth post" };

      const { result, pathUsed } = await routedPostTweet("oauth post", {
        mode: "oauth",
        oauthToken: "test-token",
      });

      expect(pathUsed).toBe("oauth");
      expect(result.tweetId).toBe("555");
    });

    test("constructs URL from tweetId when OAuth result has no url", async () => {
      mockOauthPostResult = { tweetId: "444", text: "no url" };

      const { result, pathUsed } = await routedPostTweet("no url", {
        mode: "oauth",
        oauthToken: "test-token",
      });

      expect(pathUsed).toBe("oauth");
      expect(result.url).toBe("https://x.com/i/status/444");
    });
  });

  describe("managed mode", () => {
    test("routes post through platform proxy", async () => {
      mockManagedPostResult = {
        data: { data: { id: "managed-1" } },
        status: 200,
      };

      const { result, pathUsed } = await routedPostTweet("managed post", {
        mode: "managed",
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
        mode: "managed",
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
        await routedPostTweet("will fail", { mode: "managed" });
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
        await routedPostTweet("will fail", { mode: "managed" });
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
        await routedPostTweet("will fail", { mode: "managed" });
        expect(true).toBe(false);
      } catch (err) {
        expect((err as Error).message).toBe("Network failure");
        expect((err as Record<string, unknown>).pathUsed).toBeUndefined();
      }
    });
  });

  describe("reply routing", () => {
    test("oauth mode routes reply through OAuth when available", async () => {
      mockOauthPostResult = {
        tweetId: "777",
        text: "reply text",
        url: "https://x.com/u/status/777",
      };

      const { result, pathUsed } = await routedPostTweet("reply text", {
        inReplyToTweetId: "100",
        mode: "oauth",
        oauthToken: "test-token",
      });

      expect(pathUsed).toBe("oauth");
      expect(result.tweetId).toBe("777");
    });

    test("managed mode routes reply through platform proxy", async () => {
      mockManagedPostResult = {
        data: { data: { id: "888" } },
        status: 200,
      };

      const { result, pathUsed } = await routedPostTweet("reply text", {
        inReplyToTweetId: "200",
        mode: "managed",
      });

      expect(pathUsed).toBe("managed");
      expect(result.tweetId).toBe("888");
    });
  });
});
