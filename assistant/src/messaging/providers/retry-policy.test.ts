import { describe, expect, test } from "bun:test";

import type { RetryableCall } from "./retry-policy.js";
import {
  computeRetryDelayMs,
  isRetryableStatus,
  MAX_TIMER_DELAY_MS,
  retryableCall,
} from "./retry-policy.js";

describe("isRetryableStatus", () => {
  test("retries rate limits and server faults", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });

  test("does not retry a request the server rejected on its merits", () => {
    // A retry reproduces these exactly, so repeating them only burns quota.
    for (const status of [400, 401, 403, 404, 413, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  test("does not retry success", () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(204)).toBe(false);
  });
});

describe("computeRetryDelayMs", () => {
  test("honours a Retry-After given in seconds", () => {
    expect(computeRetryDelayMs(1, 1000, "3")).toBe(3000);
    // Discord sends fractional seconds.
    expect(computeRetryDelayMs(1, 1000, "0.75")).toBe(750);
  });

  test("honours a Retry-After given as an HTTP date", () => {
    const target = new Date(Date.now() + 5000).toUTCString();
    const delay = computeRetryDelayMs(1, 1000, target);
    // Whole-second date resolution, so allow the truncation either way.
    expect(delay).toBeGreaterThan(3000);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  test("caps a server-advertised wait at the caller's bound", () => {
    // A caller holding a lock across the wait passes a small bound so a long
    // rate-limit window fails the call instead of stalling behind it.
    expect(computeRetryDelayMs(1, 1000, "3600", 60_000)).toBe(60_000);
  });

  test("caps at the timer ceiling by default, so the wait is real", () => {
    // Past this setTimeout fires immediately, turning a long wait into none.
    expect(computeRetryDelayMs(1, 1000, "999999999")).toBe(MAX_TIMER_DELAY_MS);
  });

  test("backs off exponentially when the server gives no hint", () => {
    for (const [attempt, base] of [
      [1, 1000],
      [2, 2000],
      [3, 4000],
    ] as const) {
      const delay = computeRetryDelayMs(attempt, 1000, null);
      expect(delay).toBeGreaterThanOrEqual(base);
      // Jitter is additive and bounded at half the exponential term.
      expect(delay).toBeLessThanOrEqual(base * 1.5);
    }
  });

  test("jitters, so callers that failed together do not resume together", () => {
    const delays = new Set(
      Array.from({ length: 20 }, () => computeRetryDelayMs(3, 1000, null)),
    );
    expect(delays.size).toBeGreaterThan(1);
  });

  test("falls back to backoff for unusable Retry-After values", () => {
    for (const value of ["", "soon", "-5", "0"]) {
      const delay = computeRetryDelayMs(1, 1000, value);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1500);
    }
  });

  test("ignores an already-elapsed Retry-After date", () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    const delay = computeRetryDelayMs(1, 1000, past);
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(1500);
  });
});

describe("retryableCall", () => {
  const silent = { debug() {}, warn() {} };

  function spec<T>(overrides: Partial<RetryableCall<T>>): RetryableCall<T> {
    return {
      provider: "Test",
      operation: "doThing",
      maxRetries: 2,
      initialBackoffMs: 1,
      log: silent,
      doFetch: async () => new Response("{}", { status: 200 }),
      nonRetryableError: ({ message }) => new Error(message),
      decode: (body) => JSON.parse(body) as T,
      ...overrides,
    } as RetryableCall<T>;
  }

  test("returns the decoded body without retrying on success", async () => {
    let calls = 0;
    const result = await retryableCall<{ v: number }>(
      spec({
        doFetch: async () => {
          calls++;
          return new Response(JSON.stringify({ v: 7 }), { status: 200 });
        },
      }),
    );
    expect(result).toEqual({ v: 7 });
    expect(calls).toBe(1);
  });

  test("repeats a rate limit and returns the eventual success", async () => {
    let calls = 0;
    const result = await retryableCall<{ ok: boolean }>(
      spec({
        doFetch: async () => {
          calls++;
          return calls === 1
            ? new Response("{}", { status: 429 })
            : new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      }),
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  test("throws immediately on a status a retry would reproduce", async () => {
    let calls = 0;
    await expect(
      retryableCall(
        spec({
          doFetch: async () => {
            calls++;
            return new Response('{"m":"nope"}', { status: 403 });
          },
          nonRetryableError: ({ status, message }) =>
            new Error(`terminal ${status}: ${message}`),
        }),
      ),
    ).rejects.toThrow(/terminal 403/);
    // The point of the distinction: a 403 is not retried.
    expect(calls).toBe(1);
  });

  test("surfaces the last failure, not a generic one, after exhausting retries", async () => {
    await expect(
      retryableCall(
        spec({
          maxRetries: 1,
          doFetch: async () =>
            new Response('{"detail":"upstream on fire"}', { status: 503 }),
          detailFrom: (body) =>
            (JSON.parse(body) as { detail?: string }).detail,
        }),
      ),
    ).rejects.toThrow(/upstream on fire/);
  });

  test("retries a transport error and reports it if it never recovers", async () => {
    let calls = 0;
    await expect(
      retryableCall(
        spec({
          maxRetries: 1,
          doFetch: async () => {
            calls++;
            throw new Error("socket hang up");
          },
        }),
      ),
    ).rejects.toThrow(/socket hang up/);
    expect(calls).toBe(2);
  });

  test("redacts before text reaches a message", async () => {
    // Providers whose errors echo a credential rely on this.
    await expect(
      retryableCall(
        spec({
          maxRetries: 0,
          doFetch: async () => new Response("token=SECRET", { status: 500 }),
          redact: (v) => v.replace("SECRET", "[REDACTED]"),
        }),
      ),
    ).rejects.toThrow(/\[REDACTED\]/);
    await expect(
      retryableCall(
        spec({
          maxRetries: 0,
          doFetch: async () => new Response("token=SECRET", { status: 500 }),
          redact: (v) => v.replace("SECRET", "[REDACTED]"),
        }),
      ),
    ).rejects.not.toThrow(/SECRET(?!\])/);
  });

  test("prefers a body-carried Retry-After over the header", async () => {
    const seen: (string | null)[] = [];
    let calls = 0;
    await retryableCall(
      spec({
        doFetch: async () => {
          calls++;
          return calls === 1
            ? new Response('{"retry_after":0.001}', {
                status: 429,
                headers: { "retry-after": "999" },
              })
            : new Response("{}", { status: 200 });
        },
        retryAfterFrom: (_r, body) => {
          const v = (JSON.parse(body) as { retry_after?: number }).retry_after;
          const picked = v != null ? String(v) : null;
          seen.push(picked);
          return picked;
        },
      }),
    );
    // The header said 999 seconds; the body's value is the one used.
    expect(seen).toEqual(["0.001"]);
  });

  test("passes an empty body to decode rather than assuming JSON", async () => {
    // A 204 has nothing to parse, and only the caller knows what that means.
    const result = await retryableCall<string>(
      spec({
        doFetch: async () => new Response(null, { status: 204 }),
        decode: (body) => (body === "" ? "empty" : "unexpected"),
      }),
    );
    expect(result).toBe("empty");
  });
});
