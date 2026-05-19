import { describe, expect, test } from "bun:test";

import { isExpectedBackgroundStreamEnd } from "@/domains/chat/lib/background-stream-error.js";

describe("isExpectedBackgroundStreamEnd", () => {
  test.each([
    "Stream ended unexpectedly",
    "Stream connection failed",
  ])("recognizes %s as an expected stream-end", (message) => {
    expect(isExpectedBackgroundStreamEnd(new Error(message))).toBe(true);
  });

  test.each([
    "Stream disconnected",
    "Network error",
    "HTTP 500",
    "stream ended unexpectedly",
    "Stream ended unexpectedly ",
    "",
  ])("does not recognize %s as expected", (message) => {
    expect(isExpectedBackgroundStreamEnd(new Error(message))).toBe(false);
  });

  test("matches exactly on Error.message, ignoring subclass", () => {
    class CustomError extends Error {}
    expect(
      isExpectedBackgroundStreamEnd(new CustomError("Stream ended unexpectedly")),
    ).toBe(true);
  });
});
