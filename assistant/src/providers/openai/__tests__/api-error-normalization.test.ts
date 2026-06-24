import { describe, expect, test } from "bun:test";

import type OpenAI from "openai";

import {
  captureRawErrorBodyFetch,
  formatNormalizedOpenAIAPIError,
  normalizeOpenAIAPIError,
} from "../api-error-normalization.js";

/**
 * Stand-in for an `OpenAI.APIError`. The real SDK constructor stringifies the
 * body into `.message` and renders unparseable bodies as "(no body)" — exactly
 * the lossy behavior we work around by capturing the raw body separately — so
 * the tests pass the raw body explicitly the way the provider does.
 */
function apiError(
  status: number,
  opts: { message?: string; sdkBody?: unknown; headers?: Headers } = {},
): InstanceType<typeof OpenAI.APIError> {
  return {
    status,
    message: opts.message ?? `${status} status code (no body)`,
    headers: opts.headers ?? new Headers(),
    error: opts.sdkBody,
  } as unknown as InstanceType<typeof OpenAI.APIError>;
}

describe("normalizeOpenAIAPIError", () => {
  test("surfaces Django {detail} bodies the SDK would drop", () => {
    const n = normalizeOpenAIAPIError(
      apiError(400),
      JSON.stringify({
        detail: "Model 'MiniMax-M3' is not yet supported on Vellum.",
      }),
    );
    expect(n.message).toBe(
      "Model 'MiniMax-M3' is not yet supported on Vellum.",
    );
    expect(formatNormalizedOpenAIAPIError("Together AI", 400, n)).toBe(
      "Together AI API error (400): Model 'MiniMax-M3' is not yet supported on Vellum.",
    );
  });

  test("extracts OpenAI-shaped error metadata", () => {
    const n = normalizeOpenAIAPIError(
      apiError(401),
      JSON.stringify({
        error: {
          message: "Invalid API key provided",
          code: "invalid_api_key",
          type: "invalid_request_error",
          param: "api_key",
        },
      }),
    );
    expect(n).toMatchObject({
      message: "Invalid API key provided",
      apiErrorCode: "invalid_api_key",
      apiErrorType: "invalid_request_error",
      apiErrorParam: "api_key",
    });
    expect(formatNormalizedOpenAIAPIError("OpenAI", 401, n)).toContain(
      "code=invalid_api_key; type=invalid_request_error; param=api_key",
    );
  });

  test("promotes OpenRouter metadata.raw over the generic wrapper message", () => {
    const n = normalizeOpenAIAPIError(
      apiError(400, {
        sdkBody: {
          error: {
            code: 400,
            message: "Provider returned error",
            metadata: {
              raw: "messages.4: tool_use_id must reference a prior tool_use block",
              provider_name: "Anthropic",
            },
          },
        },
      }),
    );
    expect(n.message).toBe(
      "messages.4: tool_use_id must reference a prior tool_use block",
    );
    expect(n.detail).toBe("provider=Anthropic");
    expect(n.apiErrorCode).toBe("400");
  });

  test("prefers the captured raw body over the SDK's parsed error", () => {
    // SDK collapsed the body; raw body still has the real detail.
    const n = normalizeOpenAIAPIError(
      apiError(400, { sdkBody: {} }),
      JSON.stringify({ detail: "managed proxy rejected model" }),
    );
    expect(n.message).toBe("managed proxy rejected model");
  });

  test("uses a plain-text raw body when JSON parsing fails", () => {
    const n = normalizeOpenAIAPIError(apiError(502), "upstream timeout");
    expect(n.message).toBe("upstream timeout");
  });

  test("reads the upstream request id from headers", () => {
    const n = normalizeOpenAIAPIError(
      apiError(400, { headers: new Headers({ "x-request-id": "req_abc123" }) }),
      JSON.stringify({ detail: "bad request" }),
    );
    expect(n.requestId).toBe("req_abc123");
    expect(formatNormalizedOpenAIAPIError("OpenAI", 400, n)).toContain(
      "request_id=req_abc123",
    );
  });

  test("falls back to x-openrouter-request-id", () => {
    const n = normalizeOpenAIAPIError(
      apiError(400, {
        headers: new Headers({ "x-openrouter-request-id": "gen-or-xyz" }),
      }),
      JSON.stringify({ detail: "bad request" }),
    );
    expect(n.requestId).toBe("gen-or-xyz");
  });

  test("truncates very long details with an ellipsis", () => {
    const n = normalizeOpenAIAPIError(
      apiError(400),
      JSON.stringify({ detail: "X".repeat(5000) }),
    );
    expect(n.message.length).toBeLessThanOrEqual(2001);
    expect(n.message.endsWith("…")).toBe(true);
  });

  test("degrades to the status-stripped SDK message when there is no body", () => {
    const n = normalizeOpenAIAPIError(
      apiError(500, { message: "500 Internal Server Error" }),
    );
    expect(n.message).toBe("Internal Server Error");
  });

  test("falls back to 'Request failed' for the SDK '(no body)' sentinel", () => {
    const n = normalizeOpenAIAPIError(
      apiError(500, { message: "500 status code (no body)" }),
    );
    expect(n.message).toBe("Request failed");
  });

  test("keeps sibling code/type/param when the body is {error: <string>}", () => {
    const n = normalizeOpenAIAPIError(
      apiError(400),
      JSON.stringify({
        error: "bad request",
        code: "context_length_exceeded",
        type: "invalid_request_error",
      }),
    );
    expect(n.message).toBe("bad request");
    expect(n.apiErrorCode).toBe("context_length_exceeded");
    expect(n.apiErrorType).toBe("invalid_request_error");
  });
});

describe("captureRawErrorBodyFetch", () => {
  // The fetch wrapper smuggles the dropped body onto a response header so it
  // rides onto the thrown APIError.headers — request-correlated, no shared
  // state. normalize() reads it back with no explicit rawBody argument.
  function fakeFetch(body: string, status: number): typeof globalThis.fetch {
    return (async () =>
      new Response(body, { status })) as unknown as typeof globalThis.fetch;
  }

  test("round-trips a non-2xx body through headers into normalize()", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch(JSON.stringify({ detail: "model gone" }), 400);
    try {
      const res = await captureRawErrorBodyFetch("https://x/v1/chat", {});
      const err = {
        status: 400,
        message: "400 status code (no body)",
        headers: res.headers,
        error: undefined,
      } as unknown as InstanceType<typeof import("openai").APIError>;
      // No rawBody arg: normalize must recover the body from the header alone.
      expect(normalizeOpenAIAPIError(err).message).toBe("model gone");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("passes OK responses through untouched", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch("ok", 200);
    try {
      const res = await captureRawErrorBodyFetch("https://x/v1/chat", {});
      expect(res.headers.get("x-vellum-captured-error-body")).toBeNull();
      expect(await res.text()).toBe("ok");
    } finally {
      globalThis.fetch = original;
    }
  });
});
