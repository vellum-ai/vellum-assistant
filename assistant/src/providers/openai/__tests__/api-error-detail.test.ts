import { describe, expect, test } from "bun:test";

import type OpenAI from "openai";

import {
  extractApiErrorDetail,
  formatNormalizedOpenAIAPIError,
  normalizeOpenAIAPIError,
} from "../api-error-normalization.js";

/**
 * Construct a real `OpenAI.APIError` so production code paths that use
 * `instanceof OpenAI.APIError` and SDK-defined getters keep matching.
 */
function buildApiError(
  status: number,
  body: unknown,
  headers?: Headers,
  message?: string,
): InstanceType<typeof OpenAI.APIError> {
  return {
    status,
    message:
      message ??
      (body === undefined
        ? `${status} status code (no body)`
        : `${status} ${JSON.stringify(body)}`),
    headers: headers ?? new Headers(),
    error: body,
  } as unknown as InstanceType<typeof OpenAI.APIError>;
}

describe("normalizeOpenAIAPIError", () => {
  test("surfaces Django detail bodies captured before the SDK drops them", () => {
    const err = buildApiError(400, undefined);
    const normalized = normalizeOpenAIAPIError(
      err,
      JSON.stringify({
        detail:
          "Model 'MiniMaxAI/MiniMax-M3' is not yet supported on the Vellum hosted service.",
      }),
    );

    expect(normalized.message).toBe(
      "Model 'MiniMaxAI/MiniMax-M3' is not yet supported on the Vellum hosted service.",
    );
    expect(formatNormalizedOpenAIAPIError("Together AI", 400, normalized)).toBe(
      "Together AI API error (400): Model 'MiniMaxAI/MiniMax-M3' is not yet supported on the Vellum hosted service.",
    );
  });

  test("normalizes OpenAI-shaped errors with provider metadata", () => {
    const err = buildApiError(401, undefined);
    const normalized = normalizeOpenAIAPIError(
      err,
      JSON.stringify({
        error: {
          message: "Invalid API key provided",
          code: "invalid_api_key",
          type: "invalid_request_error",
          param: "api_key",
        },
      }),
    );

    expect(normalized).toMatchObject({
      message: "Invalid API key provided",
      apiErrorCode: "invalid_api_key",
      apiErrorType: "invalid_request_error",
      apiErrorParam: "api_key",
    });
    expect(formatNormalizedOpenAIAPIError("OpenAI", 401, normalized)).toContain(
      "code=invalid_api_key; type=invalid_request_error; param=api_key",
    );
  });

  test("promotes OpenRouter downstream raw metadata over the wrapper message", () => {
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
    const normalized = normalizeOpenAIAPIError(err);

    expect(normalized.message).toBe(
      "messages.4: tool_use_id must reference a prior tool_use block",
    );
    expect(normalized.detail).toBe("provider=Anthropic");
    expect(normalized.apiErrorCode).toBe("400");
  });

  test("uses a plain-text raw body when JSON parsing fails", () => {
    const err = buildApiError(502, undefined);
    const normalized = normalizeOpenAIAPIError(err, "upstream timeout");
    expect(normalized.message).toBe("upstream timeout");
  });

  test("surfaces the upstream request id when present in headers", () => {
    const headers = new Headers({ "x-request-id": "req_abc123" });
    const err = buildApiError(400, undefined, headers);
    const normalized = normalizeOpenAIAPIError(
      err,
      JSON.stringify({ detail: "bad request" }),
    );
    expect(normalized.requestId).toBe("req_abc123");
    expect(formatNormalizedOpenAIAPIError("OpenAI", 400, normalized)).toContain(
      "request_id=req_abc123",
    );
  });
});

describe("extractApiErrorDetail", () => {
  test("returns empty detail when the body is missing", () => {
    const err = buildApiError(500, undefined);
    const { detail, requestId } = extractApiErrorDetail(err);
    expect(detail).toBe("");
    expect(requestId).toBeUndefined();
  });

  test("returns distinct normalized detail for legacy callers", () => {
    const err = buildApiError(400, undefined);
    const { detail } = extractApiErrorDetail(
      err,
      JSON.stringify({ detail: "managed proxy rejected model" }),
    );
    expect(detail).toBe("managed proxy rejected model");
  });

  test("truncates very long normalized details with an ellipsis", () => {
    const huge = "X".repeat(5000);
    const err = buildApiError(400, undefined);
    const { detail } = extractApiErrorDetail(
      err,
      JSON.stringify({ detail: huge }),
    );
    expect(detail.length).toBeLessThanOrEqual(2001);
    expect(detail.endsWith("…")).toBe(true);
  });
});
