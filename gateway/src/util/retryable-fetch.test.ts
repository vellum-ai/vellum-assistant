import { describe, expect, test } from "bun:test";
import type pino from "pino";
import type { ConfigFileCache } from "../config-file-cache.js";
import {
  computeRetryDelayMs,
  isRetryableHttpStatus,
  retryableFetch,
} from "./retryable-fetch.js";

const MAX_DELAY_MS = 2_147_483_647;

const noopLog = {
  debug: () => {},
  warn: () => {},
} as unknown as pino.Logger;

function makeConfigFile(values: Record<string, number>): ConfigFileCache {
  return {
    getNumber: (_section: string, field: string) => values[field],
    getString: () => undefined,
    getBoolean: () => undefined,
    getRecord: () => undefined,
  } as unknown as ConfigFileCache;
}

/** Hooks that fail loudly for paths a given test does not expect to hit. */
function unusedHooks() {
  return {
    throwTerminal: async (): Promise<never> => {
      throw new Error("unexpected terminal response");
    },
    describeRetryable: async () => {
      throw new Error("unexpected retryable response");
    },
    parseSuccess: async (): Promise<never> => {
      throw new Error("unexpected success response");
    },
  };
}

describe("isRetryableHttpStatus", () => {
  test("429 and 5xx are retryable", () => {
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(599)).toBe(true);
  });

  test("2xx and other 4xx are not retryable", () => {
    expect(isRetryableHttpStatus(200)).toBe(false);
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(401)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
  });
});

describe("computeRetryDelayMs", () => {
  test("numeric Retry-After seconds wins over backoff", () => {
    expect(computeRetryDelayMs(1, 1000, "120")).toBe(120_000);
  });

  test("clamps numeric Retry-After to the setTimeout ceiling", () => {
    expect(computeRetryDelayMs(1, 1000, "99999999999")).toBe(MAX_DELAY_MS);
  });

  test("HTTP-date Retry-After yields the delta to the target time", () => {
    const target = new Date(Date.now() + 60_000).toUTCString();
    const delay = computeRetryDelayMs(1, 1000, target);
    expect(delay).toBeGreaterThan(50_000);
    expect(delay).toBeLessThanOrEqual(60_000);
  });

  test("clamps far-future HTTP-date to the setTimeout ceiling", () => {
    const delay = computeRetryDelayMs(1, 1000, "Fri, 31 Dec 2999 23:59:59 GMT");
    expect(delay).toBe(MAX_DELAY_MS);
  });

  test("past HTTP-date falls back to exponential backoff", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    const delay = computeRetryDelayMs(1, 1000, past);
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(1500);
  });

  test("unparseable header falls back to exponential backoff", () => {
    const delay = computeRetryDelayMs(1, 1000, "soon");
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(1500);
  });

  test("zero and negative Retry-After fall back to exponential backoff", () => {
    for (const header of ["0", "-5"]) {
      const delay = computeRetryDelayMs(1, 1000, header);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1500);
    }
  });

  test("no header doubles per attempt with 0-50% additive jitter", () => {
    const first = computeRetryDelayMs(1, 1000, null);
    expect(first).toBeGreaterThanOrEqual(1000);
    expect(first).toBeLessThanOrEqual(1500);

    const third = computeRetryDelayMs(3, 1000, null);
    expect(third).toBeGreaterThanOrEqual(4000);
    expect(third).toBeLessThanOrEqual(6000);
  });
});

describe("retryableFetch", () => {
  const fastConfig = makeConfigFile({ maxRetries: 3, initialBackoffMs: 1 });

  function options(doFetch: () => Promise<Response>) {
    return {
      provider: "Example",
      operation: "sendThing",
      log: noopLog,
      configFile: fastConfig,
      configSection: "example",
      doFetch,
    };
  }

  test("returns parseSuccess result on first success", async () => {
    let calls = 0;
    const result = await retryableFetch<string>(
      options(async () => {
        calls++;
        return new Response('"ok"', { status: 200 });
      }),
      {
        ...unusedHooks(),
        parseSuccess: async (response) => (await response.json()) as string,
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries network errors and succeeds", async () => {
    let calls = 0;
    const result = await retryableFetch<string>(
      options(async () => {
        calls++;
        if (calls < 3) {
          throw new Error("connection refused");
        }
        return new Response("", { status: 200 });
      }),
      {
        ...unusedHooks(),
        parseSuccess: async () => "recovered",
      },
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  test("throws the last network error once retries are exhausted", async () => {
    let calls = 0;
    await expect(
      retryableFetch<never>(
        options(async () => {
          calls++;
          throw new Error("connection refused");
        }),
        unusedHooks(),
      ),
    ).rejects.toThrow("Example sendThing request failed: connection refused");
    expect(calls).toBe(4);
  });

  test("uses summarizeFetchError to shape network error messages", async () => {
    await expect(
      retryableFetch<never>(
        {
          ...options(async () => {
            throw new Error("secret-token-123");
          }),
          configFile: makeConfigFile({ maxRetries: 0, initialBackoffMs: 1 }),
        },
        {
          ...unusedHooks(),
          summarizeFetchError: () => "[REDACTED]",
        },
      ),
    ).rejects.toThrow("Example sendThing request failed: [REDACTED]");
  });

  test("retries retryable statuses and records describeRetryable error", async () => {
    let calls = 0;
    const seenRetryAfters: Array<string | null> = [];
    await expect(
      retryableFetch<never>(
        options(async () => {
          calls++;
          return new Response("busy", { status: 503 });
        }),
        {
          ...unusedHooks(),
          describeRetryable: async (response) => {
            seenRetryAfters.push(response.headers.get("retry-after"));
            return {
              retryAfter: null,
              error: new Error(`busy attempt ${calls}`),
            };
          },
        },
      ),
    ).rejects.toThrow("busy attempt 4");
    expect(calls).toBe(4);
    expect(seenRetryAfters).toHaveLength(4);
  });

  test("honors maxRetries 0 as a single attempt", async () => {
    let calls = 0;
    await expect(
      retryableFetch<never>(
        {
          ...options(async () => {
            calls++;
            return new Response("", { status: 500 });
          }),
          configFile: makeConfigFile({ maxRetries: 0, initialBackoffMs: 1 }),
        },
        {
          ...unusedHooks(),
          describeRetryable: async () => ({
            retryAfter: null,
            error: new Error("server error"),
          }),
        },
      ),
    ).rejects.toThrow("server error");
    expect(calls).toBe(1);
  });

  test("throws throwTerminal error for non-retryable failures without retrying", async () => {
    class TerminalError extends Error {}
    let calls = 0;
    await expect(
      retryableFetch<never>(
        options(async () => {
          calls++;
          return new Response("bad request", { status: 400 });
        }),
        {
          ...unusedHooks(),
          throwTerminal: async (response) => {
            throw new TerminalError(`terminal ${response.status}`);
          },
        },
      ),
    ).rejects.toThrow(TerminalError);
    expect(calls).toBe(1);
  });

  test("waits per the retryAfter hint from describeRetryable", async () => {
    let calls = 0;
    const start = Date.now();
    await retryableFetch<string>(
      options(async () => {
        calls++;
        if (calls === 1) {
          return new Response("", { status: 429 });
        }
        return new Response("", { status: 200 });
      }),
      {
        ...unusedHooks(),
        // "1" second is the smallest whole-second hint; keeps the test fast
        // while still proving the hint (not the 1ms backoff) drove the wait.
        describeRetryable: async () => ({
          retryAfter: "1",
          error: new Error("rate limited"),
        }),
        parseSuccess: async () => "done",
      },
    );
    expect(calls).toBe(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(950);
  });
});
