/**
 * Tests for `badRequestMessage` — the rule deciding when a failed daemon call
 * should be reported in the server's own words rather than the call site's
 * fallback copy.
 */

import { describe, expect, test } from "bun:test";

import { ApiError, badRequestMessage } from "@/utils/api-errors";

describe("badRequestMessage", () => {
  test("returns the server's message for a 400", () => {
    expect(
      badRequestMessage(
        new ApiError(400, 'Profile "fast" has no API key for "gemini".'),
      ),
    ).toBe('Profile "fast" has no API key for "gemini".');
  });

  test("ignores every other status, so internal detail can't leak", () => {
    expect(badRequestMessage(new ApiError(500, "boom: db offline"))).toBeUndefined();
    expect(badRequestMessage(new ApiError(404, "no such profile"))).toBeUndefined();
  });

  test("ignores the synthesized status fallback — it reads as noise to a user", () => {
    // `toApiError` falls back to `HTTP <status>` when the body carried no
    // message; that is the absence of a message, not a message.
    expect(badRequestMessage(new ApiError(400, "HTTP 400"))).toBeUndefined();
    expect(badRequestMessage(new ApiError(400, "   "))).toBeUndefined();
  });

  test("ignores errors that never reached an HTTP status", () => {
    expect(badRequestMessage(new Error("network"))).toBeUndefined();
    expect(badRequestMessage("nope")).toBeUndefined();
    expect(badRequestMessage(undefined)).toBeUndefined();
  });
});
