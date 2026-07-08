import { describe, expect, test } from "bun:test";

import type OpenAI from "openai";

import type { NormalizedOpenAIAPIError } from "../api-error-normalization.js";
import {
  captureRawErrorBodyFetch,
  deriveReason,
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

  test("falls back to the SDK-parsed error when the captured JSON was truncated", () => {
    // encodeCapturedBody slices oversized bodies, which can leave an invalid
    // JSON prefix. Rather than render that fragment (and lose metadata), fall
    // back to the body the SDK already parsed from the full response.
    const truncated =
      '{"error":{"message":"too long","code":"context_length_exceeded","type":"invalid_request_error","param":"messag';
    const n = normalizeOpenAIAPIError(
      apiError(400, {
        sdkBody: {
          error: {
            message: "too long",
            code: "context_length_exceeded",
            type: "invalid_request_error",
            param: "messages",
          },
        },
      }),
      truncated,
    );
    expect(n.message).toBe("too long");
    expect(n.apiErrorCode).toBe("context_length_exceeded");
    expect(n.apiErrorType).toBe("invalid_request_error");
    expect(n.apiErrorParam).toBe("messages");
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

  test("surfaces the verbatim captured body as rawBody for downstream persistence", () => {
    const raw = JSON.stringify({ detail: "model gone", extra: "kept" });
    const n = normalizeOpenAIAPIError(apiError(400), raw);
    // Extracted message is the clean detail...
    expect(n.message).toBe("model gone");
    // ...but the raw body is carried verbatim so the Raw tab can show it all.
    expect(n.rawBody).toBe(raw);
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
  // The fetch wrapper stashes the dropped body in a WeakMap keyed by the
  // response's headers object — which the SDK passes through to
  // APIError.headers — so normalize() recovers it with no explicit rawBody
  // argument and nothing is written to a (loggable) header.
  function fakeFetch(body: string, status: number): typeof globalThis.fetch {
    return (async () =>
      new Response(body, { status })) as unknown as typeof globalThis.fetch;
  }

  function errFor(res: Response, status: number) {
    return {
      status,
      message: `${status} status code (no body)`,
      headers: res.headers,
      error: undefined,
    } as unknown as InstanceType<typeof import("openai").APIError>;
  }

  test("recovers a non-2xx body into normalize() via the headers WeakMap", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch(JSON.stringify({ detail: "model gone" }), 400);
    try {
      const res = await captureRawErrorBodyFetch("https://x/v1/chat", {});
      // No rawBody arg: normalize recovers the body keyed by res.headers alone.
      expect(normalizeOpenAIAPIError(errFor(res, 400)).message).toBe(
        "model gone",
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test("never writes the captured body to a header", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch(JSON.stringify({ detail: "secret" }), 400);
    try {
      const res = await captureRawErrorBodyFetch("https://x/v1/chat", {});
      const headerNames = [...res.headers.keys()];
      expect(headerNames.some((h) => h.includes("vellum"))).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("passes OK responses through untouched", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch("ok", 200);
    try {
      const res = await captureRawErrorBodyFetch("https://x/v1/chat", {});
      expect(await res.text()).toBe("ok");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("recovers (truncated) detail for oversized terminal errors", async () => {
    const big = "y".repeat(40_000);
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch(JSON.stringify({ detail: big }), 400);
    try {
      const res = await captureRawErrorBodyFetch("https://x/v1/chat", {});
      const n = normalizeOpenAIAPIError(errFor(res, 400));
      // The captured body is bounded (16 KB) and the message re-truncated to
      // MAX_DETAIL_CHARS, so an oversized error can't balloon either.
      expect(n.message).toContain("yyyy");
      expect(n.message.length).toBeLessThanOrEqual(2001);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("does not drain SDK-retryable bodies (408/409/429/5xx)", async () => {
    const original = globalThis.fetch;
    // Mirror the full SDK retry predicate, not just 429/5xx.
    for (const status of [408, 409, 429, 500, 503]) {
      globalThis.fetch = fakeFetch(
        JSON.stringify({ detail: "retry me" }),
        status,
      );
      try {
        const res = await captureRawErrorBodyFetch("https://x/v1/chat", {});
        // Pass-through: nothing captured, and the body is still readable by the
        // SDK (we never consumed it).
        expect(normalizeOpenAIAPIError(errFor(res, status)).message).not.toBe(
          "retry me",
        );
        expect(res.status).toBe(status);
        expect(await res.text()).toContain("retry me");
      } finally {
        globalThis.fetch = original;
      }
    }
  });

  test("honors the x-should-retry header override", async () => {
    const original = globalThis.fetch;
    const withHeader = (
      status: number,
      value: string,
    ): typeof globalThis.fetch =>
      (async () =>
        new Response(JSON.stringify({ detail: "header says so" }), {
          status,
          headers: { "x-should-retry": value },
        })) as unknown as typeof globalThis.fetch;
    try {
      // x-should-retry:true on an otherwise-terminal 400 → SDK retries → skip.
      globalThis.fetch = withHeader(400, "true");
      let res = await captureRawErrorBodyFetch("https://x/v1/chat", {});
      expect(normalizeOpenAIAPIError(errFor(res, 400)).message).not.toBe(
        "header says so",
      );

      // x-should-retry:false on a 500 → SDK won't retry → capture it.
      globalThis.fetch = withHeader(500, "false");
      res = await captureRawErrorBodyFetch("https://x/v1/chat", {});
      expect(normalizeOpenAIAPIError(errFor(res, 500)).message).toBe(
        "header says so",
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

function n(over: Partial<NormalizedOpenAIAPIError> = {}): NormalizedOpenAIAPIError {
  return { message: "boom", ...over };
}

describe("deriveReason", () => {
  test("gateway 403 + no_providers_available → model_restricted", () => {
    expect(
      deriveReason(n({ apiErrorType: "no_providers_available" }), 403),
    ).toBe("model_restricted");
  });

  test("403 + RestrictedModelsError param → model_restricted", () => {
    expect(
      deriveReason(n({ apiErrorParam: "RestrictedModelsError" }), 403),
    ).toBe("model_restricted");
  });

  test("403 + RestrictedModelsError in body → model_restricted", () => {
    expect(
      deriveReason(
        n({ message: "boom", rawBody: "RestrictedModelsError: nope" }),
        403,
      ),
    ).toBe("model_restricted");
  });

  test("403 + 'does not have access to this model' prose → model_restricted", () => {
    expect(
      deriveReason(n({ message: "You do not have access to this model" }), 403),
    ).toBe("model_restricted");
  });

  test("model-not-found prose → model_not_found", () => {
    expect(
      deriveReason(n({ message: "The model gpt-9 does not exist" }), 404),
    ).toBe("model_not_found");
  });

  test("vision-not-supported prose → vision_unsupported", () => {
    expect(
      deriveReason(
        n({ message: "This model does not support image input" }),
        400,
      ),
    ).toBe("vision_unsupported");
  });

  test("402 → insufficient_credits", () => {
    expect(deriveReason(n(), 402)).toBe("insufficient_credits");
  });

  test("billing prose → insufficient_credits", () => {
    expect(
      deriveReason(n({ message: "Your credit balance is too low" }), 400),
    ).toBe("insufficient_credits");
  });

  test("401 → invalid_credentials", () => {
    expect(deriveReason(n(), 401)).toBe("invalid_credentials");
  });

  test("plain 403 (no restriction signal) → invalid_credentials", () => {
    expect(deriveReason(n({ message: "Forbidden" }), 403)).toBe(
      "invalid_credentials",
    );
  });

  test("429 → rate_limited", () => {
    expect(deriveReason(n(), 429)).toBe("rate_limited");
  });

  test("529 → overloaded", () => {
    expect(deriveReason(n(), 529)).toBe("overloaded");
  });

  test("overloaded prose (no status) → overloaded", () => {
    expect(
      deriveReason(n({ message: "Overloaded, try again" }), undefined),
    ).toBe("overloaded");
  });

  test("500 → server_error", () => {
    expect(deriveReason(n(), 500)).toBe("server_error");
  });

  test("generic 400 → bad_request", () => {
    expect(deriveReason(n({ message: "invalid field" }), 400)).toBe(
      "bad_request",
    );
  });

  test("no status, no signal → unknown", () => {
    expect(deriveReason(n({ message: "who knows" }), undefined)).toBe("unknown");
  });
});
