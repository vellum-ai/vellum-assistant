/**
 * Tests for the memory-v2 API wrappers.
 *
 * Mocks `globalThis.fetch` rather than the HeyAPI client module so these tests
 * exercise the real client integration AND do not leak mock.module state into
 * other test files (Bun's mock.module is process-global). This matches the
 * pattern used by `web/src/lib/voice/stt-api.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { listConceptPages, readConceptPage, ApiError } from "@/lib/memory-v2/api.js";

// ---------------------------------------------------------------------------
// globalThis.fetch mock — controlled per-test via nextResponseSpec / nextError.
// Restored in afterEach. Pre-set the CSRF cookie so the vellum-api request
// interceptor's ensureCsrfCookie() short-circuits without firing its own fetch.
// ---------------------------------------------------------------------------

interface ResponseSpec {
  status: number;
  body: unknown;
}

let nextResponseSpec: ResponseSpec | null = null;
let nextError: unknown = null;
let originalFetch: typeof globalThis.fetch | undefined;

const ASSISTANT_ID = "asst_01H0000000000000000000";

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
// listConceptPages
// ---------------------------------------------------------------------------

describe("listConceptPages", () => {
  test("200 with pages", async () => {
    const pages = [{ slug: "foo", bodyBytes: 512, edgeCount: 2, updatedAtMs: 1234 }];
    nextResponseSpec = { status: 200, body: { pages } };

    const result = await listConceptPages(ASSISTANT_ID);
    expect(result).toEqual({ kind: "success", pages });
  });

  test("200 empty array", async () => {
    nextResponseSpec = { status: 200, body: { pages: [] } };

    const result = await listConceptPages(ASSISTANT_ID);
    expect(result).toEqual({ kind: "success", pages: [] });
  });

  test("409 MEMORY_V2_DISABLED", async () => {
    nextResponseSpec = {
      status: 409,
      body: { error: { code: "MEMORY_V2_DISABLED", message: "Memory v2 is disabled." } },
    };

    const result = await listConceptPages(ASSISTANT_ID);
    expect(result).toEqual({ kind: "disabled" });
  });

  test("409 other code throws ApiError", async () => {
    nextResponseSpec = {
      status: 409,
      body: { error: { code: "OTHER_ERROR", message: "Some other 409." } },
    };

    await expect(listConceptPages(ASSISTANT_ID)).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  test("500 throws ApiError", async () => {
    nextResponseSpec = { status: 500, body: { detail: "Internal server error" } };

    await expect(listConceptPages(ASSISTANT_ID)).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  test("network error propagates", async () => {
    nextError = new TypeError("fetch failed");

    // Transport failures bubble up as the original error so React Query's
    // `query.isError` fires (Codex P2 on PR #6091 — sentinel error payloads
    // get cached as success).
    await expect(listConceptPages(ASSISTANT_ID)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// readConceptPage
// ---------------------------------------------------------------------------

describe("readConceptPage", () => {
  test("200 returns rendered string", async () => {
    nextResponseSpec = {
      status: 200,
      body: { slug: "foo-bar", rendered: "# Foo Bar\n\nContent." },
    };

    const result = await readConceptPage(ASSISTANT_ID, "foo-bar");
    expect(result).toBe("# Foo Bar\n\nContent.");
  });

  test("404 returns null", async () => {
    nextResponseSpec = { status: 404, body: { detail: "Not found" } };

    const result = await readConceptPage(ASSISTANT_ID, "missing");
    expect(result).toBeNull();
  });

  test("500 throws ApiError", async () => {
    nextResponseSpec = { status: 500, body: { detail: "Internal server error" } };

    await expect(readConceptPage(ASSISTANT_ID, "foo")).rejects.toBeInstanceOf(ApiError);

    nextResponseSpec = { status: 500, body: { detail: "Internal server error" } };
    try {
      await readConceptPage(ASSISTANT_ID, "foo");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(500);
    }
  });
});
