import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// --- Mocks (must be declared before importing the module under test) ---

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
  oauthIsAvailable,
  oauthPostTweet,
  oauthSupportsOperation,
  UnsupportedOAuthOperationError,
} from "../oauth-client.js";

// --- Global fetch mock ---

const originalFetch = globalThis.fetch;
let _fetchMock: ReturnType<typeof mock> | null = null;

beforeEach(() => {
  _fetchMock = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(response: {
  ok: boolean;
  status: number;
  json?: unknown;
  text?: string;
}) {
  const fn = mock(() =>
    Promise.resolve({
      ok: response.ok,
      status: response.status,
      json: () => Promise.resolve(response.json),
      text: () => Promise.resolve(response.text ?? ""),
    }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  _fetchMock = fn;
  return fn;
}

describe("Twitter OAuth client", () => {
  describe("oauthPostTweet", () => {
    test("successfully posts and returns tweet ID", async () => {
      const fn = mockFetch({
        ok: true,
        status: 200,
        json: { data: { id: "12345", text: "Hello world" } },
      });

      const result = await oauthPostTweet("Hello world", {
        oauthToken: "fake-oauth-token",
      });

      expect(result.tweetId).toBe("12345");
      expect(result.text).toBe("Hello world");

      // Verify the request was made correctly
      expect(fn).toHaveBeenCalledTimes(1);
      const [url, opts] = fn.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.x.com/2/tweets");
      expect(opts.method).toBe("POST");
      expect((opts.headers as Record<string, string>)["Authorization"]).toBe(
        "Bearer fake-oauth-token",
      );
      expect((opts.headers as Record<string, string>)["Content-Type"]).toBe(
        "application/json",
      );

      const body = JSON.parse(opts.body as string);
      expect(body.text).toBe("Hello world");
      expect(body.reply).toBeUndefined();
    });

    test("with reply returns correct result", async () => {
      const fn = mockFetch({
        ok: true,
        status: 200,
        json: { data: { id: "67890", text: "My reply" } },
      });

      const result = await oauthPostTweet("My reply", {
        inReplyToTweetId: "11111",
        oauthToken: "fake-oauth-token",
      });

      expect(result.tweetId).toBe("67890");
      expect(result.text).toBe("My reply");

      const [, opts] = fn.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.text).toBe("My reply");
      expect(body.reply).toEqual({ in_reply_to_tweet_id: "11111" });
    });

    test("throws on API error", async () => {
      mockFetch({
        ok: false,
        status: 429,
        text: "Rate limit exceeded",
      });

      await expect(
        oauthPostTweet("will fail", { oauthToken: "fake-oauth-token" }),
      ).rejects.toThrow(/Twitter API error \(429\)/);
    });

    test("throws with status in error message on 401", async () => {
      mockFetch({
        ok: false,
        status: 401,
        text: "Unauthorized",
      });

      try {
        await oauthPostTweet("will fail", { oauthToken: "fake-oauth-token" });
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect((err as Error).message).toContain("401");
      }
    });
  });

  describe("oauthIsAvailable", () => {
    test("returns true when token is provided", () => {
      expect(oauthIsAvailable("some-token")).toBe(true);
    });

    test("returns false when token is undefined", () => {
      expect(oauthIsAvailable(undefined)).toBe(false);
    });

    test("returns false when token is empty string", () => {
      expect(oauthIsAvailable("")).toBe(false);
    });
  });

  describe("oauthSupportsOperation", () => {
    test("returns true for post", () => {
      expect(oauthSupportsOperation("post")).toBe(true);
    });

    test("returns true for reply", () => {
      expect(oauthSupportsOperation("reply")).toBe(true);
    });

    test("returns false for unsupported operations", () => {
      const unsupported = [
        "timeline",
        "search",
        "bookmarks",
        "home",
        "notifications",
        "likes",
        "followers",
        "following",
        "media",
        "tweet",
      ];
      for (const op of unsupported) {
        expect(oauthSupportsOperation(op)).toBe(false);
      }
    });
  });

  describe("UnsupportedOAuthOperationError", () => {
    test("has correct properties", () => {
      const err = new UnsupportedOAuthOperationError("search");
      expect(err.name).toBe("UnsupportedOAuthOperationError");
      expect(err.operation).toBe("search");
      expect(err.message).toContain("search");
      expect(err.message).toContain("not available via the OAuth API");
      expect(err.message).toContain("managed mode");
      expect(err).toBeInstanceOf(Error);
    });
  });
});
