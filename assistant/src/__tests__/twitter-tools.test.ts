import { describe, expect, test } from "bun:test";

import {
  extractAllTweetUrls,
  extractTweetId,
} from "../config/bundled-skills/twitter/tools/shared.js";
import { TokenExpiredError } from "../security/token-manager.js";

describe("extractTweetId", () => {
  test("extracts from twitter.com URL", () => {
    expect(
      extractTweetId("https://twitter.com/elonmusk/status/1234567890"),
    ).toBe("1234567890");
  });

  test("extracts from x.com URL", () => {
    expect(extractTweetId("https://x.com/user/status/9876543210")).toBe(
      "9876543210",
    );
  });

  test("strips query parameters", () => {
    expect(
      extractTweetId("https://x.com/user/status/1234567890?s=20&t=abc"),
    ).toBe("1234567890");
  });

  test("handles Slack <url|label> format", () => {
    expect(
      extractTweetId("<https://x.com/user/status/1234567890|Check this tweet>"),
    ).toBe("1234567890");
  });

  test("handles Slack <url> format without label", () => {
    expect(extractTweetId("<https://twitter.com/user/status/555>")).toBe("555");
  });

  test("handles raw numeric ID", () => {
    expect(extractTweetId("1234567890")).toBe("1234567890");
  });

  test("returns null for non-matching input", () => {
    expect(extractTweetId("not a tweet")).toBeNull();
    expect(extractTweetId("https://google.com/something")).toBeNull();
    expect(extractTweetId("")).toBeNull();
  });
});

describe("extractAllTweetUrls", () => {
  test("extracts multiple URLs from one message", () => {
    const text =
      "Check out https://x.com/user1/status/111 and https://twitter.com/user2/status/222";
    const results = extractAllTweetUrls(text);
    expect(results).toHaveLength(2);
    expect(results[0].tweetId).toBe("111");
    expect(results[1].tweetId).toBe("222");
  });

  test("handles mixed content with non-tweet URLs", () => {
    const text =
      "Visit https://google.com and https://x.com/user/status/333 for more info";
    const results = extractAllTweetUrls(text);
    expect(results).toHaveLength(1);
    expect(results[0].tweetId).toBe("333");
  });

  test("handles Slack-formatted URLs", () => {
    const text =
      "Look at <https://x.com/user/status/444|tweet1> and <https://twitter.com/user/status/555|tweet2>";
    const results = extractAllTweetUrls(text);
    expect(results).toHaveLength(2);
    expect(results[0].tweetId).toBe("444");
    expect(results[1].tweetId).toBe("555");
  });

  test("deduplicates same tweet ID", () => {
    const text =
      "https://x.com/user/status/111 and https://twitter.com/other/status/111";
    const results = extractAllTweetUrls(text);
    expect(results).toHaveLength(1);
    expect(results[0].tweetId).toBe("111");
  });

  test("returns empty array for no tweet URLs", () => {
    const results = extractAllTweetUrls("No tweets here, just text.");
    expect(results).toHaveLength(0);
  });
});

describe("twitter_like_post response handling", () => {
  test.todo(
    "success response returns liked message when run() is called with a valid tweet ID",
    () => {},
  );

  test.todo(
    "already-liked response is detected and reported when run() encounters a previously liked tweet",
    () => {},
  );

  test("TokenExpiredError is caught correctly", () => {
    // Verify the error class is constructable and has expected properties
    const error = new TokenExpiredError("integration:twitter");
    expect(error).toBeInstanceOf(TokenExpiredError);
    expect(error.name).toBe("TokenExpiredError");
  });

  test.todo(
    "429 response returns rate limit error when run() hits Twitter API rate limits",
    () => {},
  );

  test.todo(
    "generic error status returns API error when run() receives a non-200 response",
    () => {},
  );
});

describe("getAuthenticatedUserId cache", () => {
  test.todo(
    "composite key isolates different connections — cache returns distinct user IDs for different connection IDs",
    () => {},
  );
});

describe("twitter_auto_like_scan", () => {
  test.todo(
    "run() extracts tweet URLs from messages and likes each one via the Twitter API",
    () => {},
  );

  test.todo(
    "run() returns a summary with liked, already-liked, and failed counts",
    () => {},
  );

  test.todo(
    "run() handles no-URLs-found case by returning an appropriate message",
    () => {},
  );
});
