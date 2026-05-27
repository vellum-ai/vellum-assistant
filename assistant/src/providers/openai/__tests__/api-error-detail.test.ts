import { describe, expect, test } from "bun:test";

import OpenAI from "openai";

import { extractApiErrorDetail } from "../chat-completions-provider.js";

/**
 * Construct a real `OpenAI.APIError` so production code paths that use
 * `instanceof OpenAI.APIError` and SDK-defined getters keep matching.
 */
function buildApiError(
  status: number,
  body: unknown,
  headers?: Headers,
): InstanceType<typeof OpenAI.APIError> {
  return new OpenAI.APIError(
    status,
    body as Record<string, unknown>,
    undefined,
    headers ?? new Headers(),
  );
}

describe("extractApiErrorDetail", () => {
  test("serializes a structured body so logs show the upstream error", () => {
    // This is the canonical OpenRouter shape that motivated the helper:
    // the SDK's `error.message` collapses to "400 Provider returned error"
    // and the real detail lives nested under `error.metadata.raw`.
    const err = buildApiError(400, {
      error: {
        code: 400,
        message: "Provider returned error",
        metadata: {
          raw: "messages.4: tool_use_id must reference a prior tool_use block",
          provider_name: "Anthropic",
        },
      },
    });
    const { detail, requestId } = extractApiErrorDetail(err);
    expect(detail).toContain("Provider returned error");
    expect(detail).toContain("tool_use_id must reference a prior tool_use");
    expect(detail).toContain("Anthropic");
    expect(requestId).toBeUndefined();
  });

  test("surfaces the upstream request id when present in headers", () => {
    const headers = new Headers({ "x-request-id": "req_abc123" });
    const err = buildApiError(
      400,
      { error: { message: "Provider returned error" } },
      headers,
    );
    const { requestId } = extractApiErrorDetail(err);
    expect(requestId).toBe("req_abc123");
  });

  test("falls back to x-openrouter-request-id when x-request-id is absent", () => {
    const headers = new Headers({
      "x-openrouter-request-id": "gen-or-xyz",
    });
    const err = buildApiError(
      400,
      { error: { message: "Provider returned error" } },
      headers,
    );
    const { requestId } = extractApiErrorDetail(err);
    expect(requestId).toBe("gen-or-xyz");
  });

  test("returns empty detail when the body is missing", () => {
    // The SDK constructs an APIError even when the upstream response had
    // no JSON body (e.g. network-layer 5xx). The helper must degrade
    // gracefully rather than emit `undefined` or `null` strings.
    const err = buildApiError(500, undefined);
    const { detail, requestId } = extractApiErrorDetail(err);
    expect(detail).toBe("");
    expect(requestId).toBeUndefined();
  });

  test("returns empty detail when the body serializes to an empty object", () => {
    // `{}` carries zero signal and just adds noise to log lines.
    const err = buildApiError(429, {});
    const { detail } = extractApiErrorDetail(err);
    expect(detail).toBe("");
  });

  test("truncates very long bodies with an ellipsis", () => {
    const huge = "X".repeat(5000);
    const err = buildApiError(400, { error: { message: huge } });
    const { detail } = extractApiErrorDetail(err);
    // Cap is 2000 chars; the helper appends a single-char ellipsis when truncating.
    expect(detail.length).toBeLessThanOrEqual(2001);
    expect(detail.endsWith("…")).toBe(true);
  });

  test("preserves string bodies verbatim (no double-encoding)", () => {
    // Some providers return a non-JSON body (HTML error page, plain text).
    // The SDK stores it on `error.error` as a string in that case.
    const err = buildApiError(502, "upstream timeout");
    const { detail } = extractApiErrorDetail(err);
    expect(detail).toBe("upstream timeout");
  });

  test("returns empty detail when JSON.stringify throws (cyclic body)", () => {
    // Pathological body — should not propagate the TypeError to callers.
    // OpenAI's `APIError` constructor itself JSON.stringifies the body to
    // build its own `.message`, so we can't get to this branch via the SDK
    // constructor; build a structural stand-in instead.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const stub = {
      status: 400,
      message: "synthetic",
      headers: new Headers(),
      error: cyclic,
    } as unknown as InstanceType<typeof OpenAI.APIError>;
    const { detail } = extractApiErrorDetail(stub);
    expect(detail).toBe("");
  });
});
