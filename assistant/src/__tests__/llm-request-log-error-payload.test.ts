/**
 * Unit tests for `buildProviderErrorResponsePayload` — the shared serializer
 * used by `handleProviderError` (daemon) and the wake-path `onEvent` to
 * record provider-rejected LLM calls in `llm_request_logs`.
 *
 * The serializer's job: take an arbitrary thrown `Error`, return a
 * structured `{ error: {...} }` object whose fields are queryable in the
 * LLM inspector and that round-trips cleanly through `JSON.stringify`.
 * The `error` key wrap is load-bearing — it mirrors a successful row's
 * `usage.rawResponse` shape so an inspector consumer can branch on
 * `responsePayload.error` vs the success shape without re-parsing.
 *
 * Coverage:
 *  - `ProviderError` with full metadata (provider, statusCode, retryAfterMs).
 *  - `ProviderError` without optional metadata.
 *  - Non-provider `AssistantError` (carries `code` but not provider fields).
 *  - Plain `Error` (degrades to `{name, message}`).
 *  - Custom `Error` subclass with overridden `name` is preserved.
 *
 * Each test stringifies and re-parses the payload so the on-disk shape
 * (what eventually lands in the `responsePayload` column) is what we
 * assert on, not the JS object identity.
 */

import { describe, expect, test } from "bun:test";

import { buildProviderErrorResponsePayload } from "../memory/llm-request-log-store.js";
import {
  AssistantError,
  ErrorCode,
  ProviderError,
} from "../util/errors.js";

function persisted(err: Error): { error: Record<string, unknown> } {
  // Round-trip through JSON to assert on the actual stored shape, not the
  // in-memory object reference.
  return JSON.parse(
    JSON.stringify(buildProviderErrorResponsePayload(err)),
  );
}

describe("buildProviderErrorResponsePayload", () => {
  test("ProviderError with statusCode + retryAfterMs serializes every queryable field", () => {
    const err = new ProviderError(
      "Anthropic API error (429): rate limited",
      "anthropic",
      429,
      { retryAfterMs: 1500 },
    );
    const got = persisted(err);
    expect(got).toEqual({
      error: {
        name: "ProviderError",
        message: "Anthropic API error (429): rate limited",
        code: ErrorCode.PROVIDER_ERROR,
        provider: "anthropic",
        statusCode: 429,
        retryAfterMs: 1500,
      },
    });
  });

  test("ProviderError without optional metadata omits statusCode + retryAfterMs", () => {
    const err = new ProviderError(
      "Gemini API error: surprise internal state",
      "gemini",
    );
    const got = persisted(err);
    expect(got).toEqual({
      error: {
        name: "ProviderError",
        message: "Gemini API error: surprise internal state",
        code: ErrorCode.PROVIDER_ERROR,
        provider: "gemini",
      },
    });
    // Explicit assertion: omitted fields aren't present as `null` either —
    // the inspector should be able to test `'statusCode' in error` reliably.
    expect("statusCode" in got.error).toBe(false);
    expect("retryAfterMs" in got.error).toBe(false);
  });

  test("non-provider AssistantError carries the ErrorCode but no provider fields", () => {
    // Tool errors / permission denials are technically also AssistantErrors;
    // we just want to confirm the generic AssistantError branch produces a
    // sensible row rather than silently degrading to a plain Error shape.
    const err = new AssistantError(
      "internal state corrupted",
      ErrorCode.INTERNAL_ERROR,
    );
    const got = persisted(err);
    expect(got).toEqual({
      error: {
        name: "AssistantError",
        message: "internal state corrupted",
        code: ErrorCode.INTERNAL_ERROR,
      },
    });
    expect("provider" in got.error).toBe(false);
  });

  test("plain Error degrades to {name, message} with no code/provider noise", () => {
    const err = new Error("connection reset");
    const got = persisted(err);
    expect(got).toEqual({
      error: {
        name: "Error",
        message: "connection reset",
      },
    });
    expect("code" in got.error).toBe(false);
  });

  test("custom Error subclass with overridden name is preserved", () => {
    class TimeoutError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "TimeoutError";
      }
    }
    const got = persisted(new TimeoutError("provider timed out after 60s"));
    expect(got).toEqual({
      error: {
        name: "TimeoutError",
        message: "provider timed out after 60s",
      },
    });
  });

  test("ProviderError with statusCode 0 is still recorded (not coerced to undefined)", () => {
    // Defensive: `if (err.statusCode !== undefined)` correctly admits 0.
    // A raw `if (err.statusCode)` would drop it, so the test guards against
    // a regression to truthy-checking.
    const err = new ProviderError("weird provider", "fake", 0);
    const got = persisted(err);
    expect(got.error.statusCode).toBe(0);
  });
});
