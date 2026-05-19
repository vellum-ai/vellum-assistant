/**
 * Unit tests for `postSttTranscribe`.
 *
 * Pinned behaviour:
 *
 * 1. **HTTP categorisation** — daemon failures are mapped from HTTP status to
 *    a structured `SttFailureReason` so the UI can render category-specific
 *    messaging instead of a single opaque "transcription failed" toast.
 *    Mirrors the daemon's `normalizeSttError` (assistant/src/stt/
 *    daemon-batch-transcriber.ts) → route-error mapping
 *    (assistant/src/runtime/routes/stt-routes.ts).
 *
 * 2. **Transport-failure handling** — the HeyAPI client with
 *    `throwOnError: false` resolves with `{ error, response: undefined }` on
 *    transport failures (AbortError, network drop, CORS). The function must
 *    inspect `result.response` and `result.error` directly; reading
 *    `response.ok` unguarded throws a `TypeError` and bypasses the new
 *    `aborted`/`network` categorisation. This test pins the contract.
 *
 * Mocks `globalThis.fetch` rather than the heyapi client module so the test
 * exercises the real client integration AND avoids leaking module mocks
 * across test files (Bun's `mock.module` is process-global).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { postSttTranscribe } from "@/lib/voice/stt-api.js";

// ---------------------------------------------------------------------------
// `globalThis.fetch` mock — controlled per-test via `nextResponseSpec` /
// `nextError`. Restored in `afterEach`.
//
// Each fetch call MUST return a fresh `Response` because heyapi's response
// parser consumes the body. We also pre-set the CSRF cookie so the
// vellum-api request interceptor's `ensureCsrfCookie()` short-circuits and
// doesn't fire its own fetch (which would otherwise hit our mock and
// re-consume the same Response).
// ---------------------------------------------------------------------------

interface ResponseSpec {
  status: number;
  body: unknown;
}

let nextResponseSpec: ResponseSpec | null = null;
let nextError: unknown = null;
let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  nextResponseSpec = null;
  nextError = null;
  originalFetch = globalThis.fetch;
  document.cookie = "csrftoken=test-csrf; path=/";
  globalThis.fetch = (async () => {
    if (nextError) throw nextError;
    if (nextResponseSpec) {
      return new Response(JSON.stringify(nextResponseSpec.body), {
        status: nextResponseSpec.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error("test did not configure nextResponseSpec / nextError");
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeBlob(): Blob {
  return new Blob([new Uint8Array([0, 1, 2, 3])], { type: "audio/mp4" });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("postSttTranscribe success", () => {
  test("returns ok with transcript text when daemon responds 200", async () => {
    nextResponseSpec = {
      status: 200,
      body: {
        text: "hello",
        providerId: "whisper-1",
        boundaryId: "abc",
      },
    };
    const result = await postSttTranscribe(fakeBlob(), "asst_1");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.text).toBe("hello");
      expect(result.providerId).toBe("whisper-1");
      expect(result.boundaryId).toBe("abc");
    }
  });
});

// ---------------------------------------------------------------------------
// Daemon-categorised HTTP failures — mirrors `normalizeSttError` →
// `RouteError` mapping in the daemon. Pins the inverse mapping here so the
// UI can render category-specific messaging.
// ---------------------------------------------------------------------------

describe("postSttTranscribe HTTP failure categorisation", () => {
  const cases: Array<{
    status: number;
    message?: string;
    reason: string;
  }> = [
    { status: 400, reason: "audio-rejected" },
    { status: 401, reason: "auth-failed" },
    { status: 403, reason: "auth-failed" },
    { status: 429, reason: "rate-limited" },
    { status: 502, reason: "provider-error" },
    {
      status: 503,
      message: "No speech-to-text provider is configured",
      reason: "config-missing",
    },
    {
      status: 503,
      message: "STT provider is not available",
      reason: "unavailable",
    },
    { status: 504, reason: "timeout" },
    { status: 500, reason: "unknown" },
  ];

  for (const { status, message, reason } of cases) {
    // Test with { detail: message } format (Django DRF proxy errors)
    test(`HTTP ${status}${message ? ` ("${message}")` : ""} → reason="${reason}" (detail envelope)`, async () => {
      nextResponseSpec = {
        status,
        body: message ? { detail: message } : { detail: "" },
      };
      const result = await postSttTranscribe(fakeBlob(), "asst_1");
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.reason as string).toBe(reason);
        expect(result.httpStatus).toBe(status);
        if (message) expect(result.message).toBe(message);
      }
    });

    // Test with { error: { code, message } } format (daemon httpError() envelope)
    if (message) {
      test(`HTTP ${status} ("${message}") → reason="${reason}" (error envelope)`, async () => {
        nextResponseSpec = {
          status,
          body: {
            error: { code: "SERVICE_UNAVAILABLE", message },
          },
        };
        const result = await postSttTranscribe(fakeBlob(), "asst_1");
        expect(result.status).toBe("error");
        if (result.status === "error") {
          expect(result.reason as string).toBe(reason);
          expect(result.httpStatus).toBe(status);
          expect(result.message).toBe(message);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Transport failures — `throwOnError: false` makes the HeyAPI client resolve
// with `response: undefined` on AbortError / network errors. These tests pin
// the guard so a regression that drops the `!response` branch fails loudly
// instead of crashing on `response.ok`.
// ---------------------------------------------------------------------------

describe("postSttTranscribe transport failures", () => {
  test("AbortError (DOMException form) → reason='aborted'", async () => {
    nextError = new DOMException("aborted", "AbortError");
    const result = await postSttTranscribe(fakeBlob(), "asst_1");
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.reason).toBe("aborted");
  });

  test("AbortError (plain-object form) → reason='aborted'", async () => {
    nextError = { name: "AbortError", message: "aborted" };
    const result = await postSttTranscribe(fakeBlob(), "asst_1");
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.reason).toBe("aborted");
  });

  test("non-abort transport error → reason='network'", async () => {
    nextError = new TypeError("Failed to fetch");
    const result = await postSttTranscribe(fakeBlob(), "asst_1");
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.reason).toBe("network");
  });
});
