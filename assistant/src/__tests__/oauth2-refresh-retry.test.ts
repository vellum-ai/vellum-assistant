import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

// Sequenceable fetch mock — each call pops the next response from the queue.
let fetchResponses: Array<
  | {
      type: "response";
      ok: boolean;
      status: number;
      body: Record<string, unknown>;
    }
  | { type: "error"; error: Error }
> = [];
let fetchCallCount = 0;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (url.includes("token")) {
    fetchCallCount++;
    const next = fetchResponses.shift();
    if (!next) {
      return new Response(
        JSON.stringify({
          access_token: "ok",
          refresh_token: "rt",
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (next.type === "error") throw next.error;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  return originalFetch(input, _init);
}) as unknown as typeof fetch;

// Suppress real timers for speed — override setTimeout to fire immediately.
const origSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: (...args: unknown[]) => void) =>
  origSetTimeout(fn, 0)) as unknown as typeof setTimeout;

import { refreshOAuth2Token } from "../security/oauth2.js";

beforeEach(() => {
  fetchResponses = [];
  fetchCallCount = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("refreshOAuth2Token retry behavior", () => {
  test("succeeds on first attempt with no retries", async () => {
    fetchResponses = [
      {
        type: "response",
        ok: true,
        status: 200,
        body: { access_token: "at", refresh_token: "rt", expires_in: 3600 },
      },
    ];

    const result = await refreshOAuth2Token(
      "https://example.com/token",
      "client-id",
      "refresh-token",
    );

    expect(result.accessToken).toBe("at");
    expect(fetchCallCount).toBe(1);
  });

  test("retries on network error and succeeds", async () => {
    fetchResponses = [
      { type: "error", error: new Error("ECONNREFUSED") },
      {
        type: "response",
        ok: true,
        status: 200,
        body: { access_token: "at2", refresh_token: "rt", expires_in: 3600 },
      },
    ];

    const result = await refreshOAuth2Token(
      "https://example.com/token",
      "client-id",
      "refresh-token",
    );

    expect(result.accessToken).toBe("at2");
    expect(fetchCallCount).toBe(2);
  });

  test("retries on 500 and succeeds", async () => {
    fetchResponses = [
      {
        type: "response",
        ok: false,
        status: 500,
        body: { error: "server_error" },
      },
      {
        type: "response",
        ok: true,
        status: 200,
        body: { access_token: "at3", refresh_token: "rt", expires_in: 3600 },
      },
    ];

    const result = await refreshOAuth2Token(
      "https://example.com/token",
      "client-id",
      "refresh-token",
    );

    expect(result.accessToken).toBe("at3");
    expect(fetchCallCount).toBe(2);
  });

  test("retries on 429 and succeeds", async () => {
    fetchResponses = [
      {
        type: "response",
        ok: false,
        status: 429,
        body: { error: "rate_limited" },
      },
      {
        type: "response",
        ok: true,
        status: 200,
        body: { access_token: "at4", refresh_token: "rt", expires_in: 3600 },
      },
    ];

    const result = await refreshOAuth2Token(
      "https://example.com/token",
      "client-id",
      "refresh-token",
    );

    expect(result.accessToken).toBe("at4");
    expect(fetchCallCount).toBe(2);
  });

  test("does NOT retry on 400 invalid_grant (credential error)", async () => {
    fetchResponses = [
      {
        type: "response",
        ok: false,
        status: 400,
        body: { error: "invalid_grant" },
      },
    ];

    await expect(
      refreshOAuth2Token(
        "https://example.com/token",
        "client-id",
        "refresh-token",
      ),
    ).rejects.toThrow("OAuth2 token refresh failed (HTTP 400: invalid_grant)");

    expect(fetchCallCount).toBe(1);
  });

  test("does NOT retry on 401", async () => {
    fetchResponses = [
      {
        type: "response",
        ok: false,
        status: 401,
        body: { error: "unauthorized" },
      },
    ];

    await expect(
      refreshOAuth2Token(
        "https://example.com/token",
        "client-id",
        "refresh-token",
      ),
    ).rejects.toThrow("OAuth2 token refresh failed");

    expect(fetchCallCount).toBe(1);
  });

  test("exhausts retries on persistent network errors", async () => {
    fetchResponses = [
      { type: "error", error: new Error("ECONNREFUSED") },
      { type: "error", error: new Error("ETIMEDOUT") },
      { type: "error", error: new Error("DNS_FAIL") },
      { type: "error", error: new Error("ECONNRESET") },
    ];

    await expect(
      refreshOAuth2Token(
        "https://example.com/token",
        "client-id",
        "refresh-token",
      ),
    ).rejects.toThrow("ECONNRESET");

    // 1 initial + 3 retries = 4 total attempts
    expect(fetchCallCount).toBe(4);
  });

  test("exhausts retries on persistent 500s", async () => {
    fetchResponses = [
      {
        type: "response",
        ok: false,
        status: 500,
        body: { error: "server_error" },
      },
      {
        type: "response",
        ok: false,
        status: 502,
        body: { error: "bad_gateway" },
      },
      {
        type: "response",
        ok: false,
        status: 503,
        body: { error: "unavailable" },
      },
      {
        type: "response",
        ok: false,
        status: 500,
        body: { error: "server_error" },
      },
    ];

    await expect(
      refreshOAuth2Token(
        "https://example.com/token",
        "client-id",
        "refresh-token",
      ),
    ).rejects.toThrow("OAuth2 token refresh failed");

    expect(fetchCallCount).toBe(4);
  });
});
