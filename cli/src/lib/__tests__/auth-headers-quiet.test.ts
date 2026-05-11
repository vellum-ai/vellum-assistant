import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { authHeaders } from "../platform-client.js";

const SESSION_TOKEN = "session_abc123";

let originalFetch: typeof globalThis.fetch;
let originalConsoleError: typeof console.error;
let stderrCapture: string[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalConsoleError = console.error;
  stderrCapture = [];
  console.error = ((...args: unknown[]) => {
    stderrCapture.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.error;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

describe("authHeaders does not write to stderr on failure", () => {
  // Regression: previously `authHeaders` called `console.error(...)` on the
  // failure path AND re-threw, which caused `vellum ps` to leak a noisy
  // "Failed to fetch organization: ..." line on top of its own
  // "Platform: not logged in" line. The function should now wrap the error
  // and throw — callers handle logging.

  test("connection failures: throws a Failed-to-fetch Error, no stderr write", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error(
        "Unable to connect. Is the computer able to access the url?",
      );
    }) as unknown as typeof globalThis.fetch;

    let thrown: Error | null = null;
    try {
      await authHeaders(SESSION_TOKEN, "http://offline.invalid");
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("Failed to fetch organization");
    expect(thrown!.message).toContain("Unable to connect");
    expect(stderrCapture).toEqual([]);
  });

  test("401 from org endpoint: throws Authentication-failed Error, no stderr write", async () => {
    globalThis.fetch = mock(
      async () => new Response("unauthorized", { status: 401 }),
    ) as unknown as typeof globalThis.fetch;

    let thrown: Error | null = null;
    try {
      await authHeaders(SESSION_TOKEN, "http://platform.test");
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("Authentication failed");
    expect(thrown!.message).toContain("vellum login");
    expect(stderrCapture).toEqual([]);
  });

  test("vak_ tokens skip the org fetch entirely (no stderr write even when network is dead)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("Unable to connect");
    }) as unknown as typeof globalThis.fetch;

    const headers = await authHeaders("vak_test_key", "http://offline.invalid");
    expect(headers["Authorization"] ?? headers["X-Api-Key"]).toBeDefined();
    expect(stderrCapture).toEqual([]);
  });
});
