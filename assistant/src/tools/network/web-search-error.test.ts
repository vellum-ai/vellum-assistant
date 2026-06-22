import { describe, expect, test } from "bun:test";

import { createAbortReason } from "../../util/abort-reasons.js";
import {
  classifyWebSearchFailure,
  logWebSearchBackendFailure,
  WEB_SEARCH_BACKEND_FAILURE_MESSAGE,
} from "./web-search-error.js";

describe("classifyWebSearchFailure", () => {
  test("Anthropic 'unavailable' code is a backend failure with friendly copy", () => {
    const result = classifyWebSearchFailure({
      isError: true,
      errorCode: "unavailable",
    });
    expect(result.category).toBe("backend_unavailable");
    expect(result.isBackendFailure).toBe(true);
    expect(result.userMessage).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
    expect(result.rawDetail).toContain("unavailable");
  });

  test.each(["internal_error", "overloaded_error"])(
    "Anthropic '%s' code is a backend failure",
    (errorCode) => {
      const result = classifyWebSearchFailure({ isError: true, errorCode });
      expect(result.category).toBe("backend_unavailable");
      expect(result.isBackendFailure).toBe(true);
    },
  );

  test("HTTP 503 is a backend failure", () => {
    const result = classifyWebSearchFailure({ isError: true, statusCode: 503 });
    expect(result.category).toBe("backend_unavailable");
    expect(result.userMessage).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
  });

  test("thrown TypeError('fetch failed') is a backend failure", () => {
    const result = classifyWebSearchFailure({
      isError: true,
      error: new TypeError("fetch failed"),
    });
    expect(result.category).toBe("backend_unavailable");
    expect(result.isBackendFailure).toBe(true);
  });

  test("AbortError-shaped timeout is a backend failure", () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "AbortError";
    const result = classifyWebSearchFailure({ isError: true, error: err });
    expect(result.category).toBe("backend_unavailable");
    expect(result.isBackendFailure).toBe(true);
  });

  test("user-initiated abort is not a backend failure", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    Object.assign(err, {
      reason: createAbortReason("user_cancel", "cancelGeneration"),
    });
    const result = classifyWebSearchFailure({ isError: true, error: err });
    expect(result.isBackendFailure).toBe(false);
    expect(result.userMessage).not.toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
  });

  test("wrapped ProviderError carrying abortReason is not a backend failure", () => {
    // A provider wrapper erases the AbortError name and re-words the message,
    // but carries the tagged reason on `abortReason` (ProviderError shape).
    const err = Object.assign(new Error("Request was aborted"), {
      name: "ProviderError",
      abortReason: createAbortReason("user_cancel", "cancelGeneration"),
    });
    const result = classifyWebSearchFailure({ isError: true, error: err });
    expect(result.category).not.toBe("backend_unavailable");
    expect(result.isBackendFailure).toBe(false);
    expect(result.userMessage).not.toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
  });

  test("tagged abort with a transport-shaped cause is not a backend failure", () => {
    // A user cancellation wrapped as a ProviderError that ALSO carries a
    // transport-shaped `cause` (ECONNRESET). The tagged abort guard must win
    // over transport-retryability so this is not mislabeled a backend outage.
    const err = Object.assign(new Error("Request was aborted"), {
      name: "ProviderError",
      cause: { code: "ECONNRESET" },
      abortReason: createAbortReason("user_cancel", "cancelGeneration"),
    });
    const result = classifyWebSearchFailure({ isError: true, error: err });
    expect(result.category).not.toBe("backend_unavailable");
    expect(result.isBackendFailure).toBe(false);
    expect(result.userMessage).not.toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
  });

  test("explicit statusCode wins over a misleading error-body keyword", () => {
    // The provider response body contains "aborted" (a keyword the error-body
    // heuristic would sniff as a non-failure), but the authoritative HTTP 503
    // must classify this as a backend failure.
    const result = classifyWebSearchFailure({
      isError: true,
      statusCode: 503,
      error: new Error("the upstream request was aborted unexpectedly"),
    });
    expect(result.category).toBe("backend_unavailable");
    expect(result.isBackendFailure).toBe(true);
    expect(result.userMessage).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
  });

  test("ECONNRESET network error is a backend failure", () => {
    const err = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const result = classifyWebSearchFailure({ isError: true, error: err });
    expect(result.category).toBe("backend_unavailable");
  });

  test("Anthropic 'too_many_requests' code is rate-limited with backend copy", () => {
    const result = classifyWebSearchFailure({
      isError: true,
      errorCode: "too_many_requests",
    });
    expect(result.category).toBe("rate_limited");
    expect(result.isBackendFailure).toBe(true);
    expect(result.userMessage).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
  });

  test("HTTP 429 is rate-limited with backend copy", () => {
    const result = classifyWebSearchFailure({ isError: true, statusCode: 429 });
    expect(result.category).toBe("rate_limited");
    expect(result.userMessage).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
  });

  test("'query_too_long' has a distinct, non-backend message", () => {
    const result = classifyWebSearchFailure({
      isError: true,
      errorCode: "query_too_long",
    });
    expect(result.category).toBe("query_too_long");
    expect(result.isBackendFailure).toBe(false);
    expect(result.userMessage).not.toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
    expect(result.userMessage.length).toBeGreaterThan(0);
  });

  test("'max_uses_exceeded' has a distinct, non-backend message", () => {
    const result = classifyWebSearchFailure({
      isError: true,
      errorCode: "max_uses_exceeded",
    });
    expect(result.category).toBe("max_uses_exceeded");
    expect(result.isBackendFailure).toBe(false);
    expect(result.userMessage).not.toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
    expect(result.userMessage.length).toBeGreaterThan(0);
  });

  test("'invalid_input' is unknown and not a backend failure", () => {
    const result = classifyWebSearchFailure({
      isError: true,
      errorCode: "invalid_input",
    });
    expect(result.category).toBe("unknown");
    expect(result.isBackendFailure).toBe(false);
  });

  test("HTTP 401 is a config failure, not the backend copy", () => {
    const result = classifyWebSearchFailure({ isError: true, statusCode: 401 });
    expect(result.category).toBe("config");
    expect(result.isBackendFailure).toBe(false);
    expect(result.userMessage).not.toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
  });

  test("HTTP 403 is a config failure", () => {
    const result = classifyWebSearchFailure({ isError: true, statusCode: 403 });
    expect(result.category).toBe("config");
    expect(result.isBackendFailure).toBe(false);
  });

  test("successful-but-empty result is no_results, not a failure", () => {
    const result = classifyWebSearchFailure({
      isError: false,
      hasResults: false,
    });
    expect(result.category).toBe("no_results");
    expect(result.isBackendFailure).toBe(false);
    expect(result.userMessage).not.toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
  });

  test("rawDetail is truncated to 500 chars", () => {
    const result = classifyWebSearchFailure({
      isError: true,
      error: new Error("x".repeat(1000)),
    });
    expect(result.rawDetail.length).toBeLessThanOrEqual(500 + 40);
    expect(result.rawDetail).toContain("truncated");
  });
});

describe("WEB_SEARCH_BACKEND_FAILURE_MESSAGE copy safety", () => {
  test("offers retry / continue-without / paste", () => {
    expect(WEB_SEARCH_BACKEND_FAILURE_MESSAGE).toContain("try again");
    expect(WEB_SEARCH_BACKEND_FAILURE_MESSAGE).toContain("continue without");
    expect(WEB_SEARCH_BACKEND_FAILURE_MESSAGE).toContain("paste");
  });

  test("contains no raw provider details, JSON, or exception names", () => {
    for (const banned of [
      "{",
      "error_code",
      "Anthropic",
      "web_search_tool_result_error",
      "TypeError",
      "stack",
    ]) {
      expect(WEB_SEARCH_BACKEND_FAILURE_MESSAGE).not.toContain(banned);
    }
  });
});

describe("logWebSearchBackendFailure", () => {
  test("captures the event and rawDetail without raw query text", () => {
    const calls: unknown[][] = [];
    const fakeLogger = {
      warn: (...args: unknown[]) => {
        calls.push(args);
      },
    } as unknown as Parameters<typeof logWebSearchBackendFailure>[0];

    const secretQuery = "super secret user query text";
    logWebSearchBackendFailure(fakeLogger, {
      provider: "anthropic",
      requestId: "req-1",
      errorCategory: "backend_unavailable",
      rawDetail: "errorCode=unavailable",
      fallbackShown: true,
      queryLength: secretQuery.length,
    });

    expect(calls).toHaveLength(1);
    const [payload, msg] = calls[0] as [Record<string, unknown>, string];
    expect(payload.event).toBe("web_search_backend_failure");
    expect(payload.tool).toBe("web_search");
    expect(payload.provider).toBe("anthropic");
    expect(payload.rawDetail).toBe("errorCode=unavailable");
    expect(payload.queryLength).toBe(secretQuery.length);
    expect(msg).toBe("web_search backend failure");

    // The raw query text must never appear anywhere in the logged payload.
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain(secretQuery);
  });
});
