/**
 * Tests for `badRequestMessage` and `rejectionMessage`, the rules deciding
 * when a failed daemon call should be reported in the server's own words
 * rather than the call site's fallback copy.
 */

import { describe, expect, test } from "bun:test";

import {
  ApiError,
  badRequestMessage,
  rejectionMessage,
} from "@/utils/api-errors";

describe("badRequestMessage", () => {
  test("returns the server's message for a 400", () => {
    expect(
      badRequestMessage(
        new ApiError(400, 'Profile "fast" has no API key for "gemini".'),
      ),
    ).toBe('Profile "fast" has no API key for "gemini".');
  });

  test("ignores every other status, so internal detail can't leak", () => {
    expect(
      badRequestMessage(new ApiError(500, "boom: db offline")),
    ).toBeUndefined();
    expect(
      badRequestMessage(new ApiError(404, "no such profile")),
    ).toBeUndefined();
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

describe("rejectionMessage", () => {
  test("returns the server's message for a 400 and for a 409", () => {
    expect(rejectionMessage(new ApiError(400, "Unknown model: gpt-5."))).toBe(
      "Unknown model: gpt-5.",
    );
    expect(
      rejectionMessage(new ApiError(409, "This session has no model option.")),
    ).toBe("This session has no model option.");
  });

  test("ignores every other status, so internal detail can't leak", () => {
    expect(
      rejectionMessage(new ApiError(500, "boom: db offline")),
    ).toBeUndefined();
    expect(rejectionMessage(new ApiError(404, "no such run"))).toBeUndefined();
  });

  test("ignores the synthesized status fallback and non-HTTP failures", () => {
    expect(rejectionMessage(new ApiError(409, "HTTP 409"))).toBeUndefined();
    expect(rejectionMessage(new Error("network"))).toBeUndefined();
  });
});
