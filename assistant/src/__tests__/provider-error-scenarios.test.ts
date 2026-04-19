import { describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Only mock sleep so retries complete instantly; keep real retry logic.
// NOTE: We must NOT use `await import()` inside mock.module — it deadlocks
// bun's module resolver. Instead, inline the real exports and only replace sleep.
const sleepSpy = mock((_ms: number) => Promise.resolve());

mock.module("../util/retry.js", () => {
  const DEFAULT_MAX_RETRIES = 3;
  const DEFAULT_BASE_DELAY_MS = 1000;

  function computeRetryDelay(
    attempt: number,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
  ): number {
    const cap = baseDelayMs * Math.pow(2, attempt);
    const half = cap / 2;
    return half + Math.random() * half;
  }

  function parseRetryAfterMs(value: string): number | undefined {
    const seconds = Number(value);
    if (!isNaN(seconds)) return seconds * 1000;
    const dateMs = Date.parse(value);
    if (!isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
    return undefined;
  }

  function getHttpRetryDelay(
    response: Response,
    attempt: number,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
  ): number {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const parsed = parseRetryAfterMs(retryAfter);
      if (parsed !== undefined) return parsed;
    }
    const effectiveBase = attempt === 0 ? baseDelayMs * 2 : baseDelayMs;
    return Math.max(baseDelayMs, computeRetryDelay(attempt, effectiveBase));
  }

  function isRetryableStatus(status: number): boolean {
    return status === 429 || status >= 500;
  }

  const RETRYABLE_NETWORK_MESSAGE_PATTERNS = [
    /socket.*closed unexpectedly/i,
    /socket hang up/i,
    /request was aborted/i,
  ];

  function isRetryableNetworkError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const retryableCodes = new Set([
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EPIPE",
    ]);
    const code = (error as NodeJS.ErrnoException).code;
    if (code && retryableCodes.has(code)) return true;
    if (error.cause instanceof Error) {
      const causeCode = (error.cause as NodeJS.ErrnoException).code;
      if (causeCode && retryableCodes.has(causeCode)) return true;
    }
    if (RETRYABLE_NETWORK_MESSAGE_PATTERNS.some((p) => p.test(error.message))) {
      return true;
    }
    const cause = error.cause;
    if (
      cause instanceof Error &&
      RETRYABLE_NETWORK_MESSAGE_PATTERNS.some((p) => p.test(cause.message))
    ) {
      return true;
    }
    return false;
  }

  function extractRetryAfterMs(headers: unknown): number | undefined {
    if (!headers) return undefined;
    let raw: string | null | undefined;
    if (typeof (headers as { get?: unknown }).get === "function") {
      raw = (headers as { get(k: string): string | null }).get("retry-after");
    } else if (typeof headers === "object") {
      raw = (headers as Record<string, string>)["retry-after"];
    }
    if (typeof raw === "string") return parseRetryAfterMs(raw);
    return undefined;
  }

  return {
    DEFAULT_MAX_RETRIES,
    DEFAULT_BASE_DELAY_MS,
    computeRetryDelay,
    parseRetryAfterMs,
    getHttpRetryDelay,
    isRetryableStatus,
    isRetryableNetworkError,
    extractRetryAfterMs,
    sleep: sleepSpy,
    abortableSleep: () => Promise.resolve(),
  };
});

import { RetryProvider } from "../providers/retry.js";
import { createStreamTimeout } from "../providers/stream-timeout.js";
import type {
  Message,
  Provider,
  ProviderEvent,
  ProviderResponse,
} from "../providers/types.js";
import { ProviderError } from "../util/errors.js";
import { DEFAULT_MAX_RETRIES } from "../util/retry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MESSAGES: Message[] = [
  { role: "user", content: [{ type: "text", text: "Hello" }] },
];

function successResponse(
  overrides?: Partial<ProviderResponse>,
): ProviderResponse {
  return {
    content: [{ type: "text", text: "ok" }],
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
    ...overrides,
  };
}

/** Provider that fails N times then succeeds. */
function makeFlaky(
  failCount: number,
  error: Error,
  name = "flaky",
): Provider & { calls: number } {
  const p = {
    name,
    calls: 0,
    async sendMessage(): Promise<ProviderResponse> {
      p.calls++;
      if (p.calls <= failCount) throw error;
      return successResponse();
    },
  };
  return p;
}

/** Provider that always fails. */
function makeFailing(
  error: Error,
  name = "failing",
): Provider & { calls: number } {
  const p = {
    name,
    calls: 0,
    async sendMessage(): Promise<ProviderResponse> {
      p.calls++;
      throw error;
    },
  };
  return p;
}

// ---------------------------------------------------------------------------
// RetryProvider — rate limit backoff
// ---------------------------------------------------------------------------

describe("RetryProvider — rate limit backoff", () => {
  test("retries on 429 and succeeds after transient rate limit", async () => {
    const inner = makeFlaky(2, new ProviderError("rate limited", "test", 429));
    const provider = new RetryProvider(inner);

    const result = await provider.sendMessage(MESSAGES);

    expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
    // 2 failures + 1 success = 3 calls
    expect(inner.calls).toBe(3);
  });

  test("throws after exhausting all retries on persistent 429", async () => {
    const inner = makeFailing(new ProviderError("rate limited", "test", 429));
    const provider = new RetryProvider(inner);

    await expect(provider.sendMessage(MESSAGES)).rejects.toThrow(
      "rate limited",
    );
    // 1 initial + DEFAULT_MAX_RETRIES retries
    expect(inner.calls).toBe(DEFAULT_MAX_RETRIES + 1);
  });

  test("preserves ProviderError properties through retry exhaustion", async () => {
    const inner = makeFailing(
      new ProviderError("quota exceeded", "anthropic", 429),
    );
    const provider = new RetryProvider(inner);

    try {
      await provider.sendMessage(MESSAGES);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const pe = err as ProviderError;
      expect(pe.provider).toBe("anthropic");
      expect(pe.statusCode).toBe(429);
      expect(pe.message).toBe("quota exceeded");
    }
  });

  test("uses retryAfterMs from ProviderError when present", async () => {
    const error = new ProviderError("rate limited", "anthropic", 429, {
      retryAfterMs: 30_000,
    });
    const inner = makeFlaky(1, error);
    const provider = new RetryProvider(inner);

    const result = await provider.sendMessage(MESSAGES);
    expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
    expect(inner.calls).toBe(2);
  });

  test("preserves retryAfterMs on ProviderError through retry exhaustion", async () => {
    const error = new ProviderError("rate limited", "anthropic", 429, {
      retryAfterMs: 60_000,
    });
    const inner = makeFailing(error);
    const provider = new RetryProvider(inner);

    try {
      await provider.sendMessage(MESSAGES);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const pe = err as ProviderError;
      expect(pe.retryAfterMs).toBe(60_000);
      expect(pe.statusCode).toBe(429);
    }
  });

  test("falls back to exponential backoff when retryAfterMs is absent", async () => {
    const error = new ProviderError("rate limited", "test", 429);
    expect(error.retryAfterMs).toBeUndefined();
    const inner = makeFlaky(1, error);
    const provider = new RetryProvider(inner);

    const result = await provider.sendMessage(MESSAGES);
    expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
    expect(inner.calls).toBe(2);
  });

  test("caps retryAfterMs at MAX_RETRY_DELAY_MS", async () => {
    sleepSpy.mockClear();
    const error = new ProviderError("rate limited", "anthropic", 429, {
      retryAfterMs: 3_600_000, // 1 hour - way too long
    });
    const inner = makeFlaky(1, error);
    const provider = new RetryProvider(inner);

    const result = await provider.sendMessage(MESSAGES);
    expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
    expect(inner.calls).toBe(2);

    // Verify sleep was called with the capped delay, not the original 3,600,000ms
    const sleepCalls = sleepSpy.mock.calls;
    const lastDelay = sleepCalls[sleepCalls.length - 1][0];
    expect(lastDelay).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// RetryProvider — server error retries
// ---------------------------------------------------------------------------

describe("RetryProvider — server error retries", () => {
  test("retries on 500 Internal Server Error", async () => {
    const inner = makeFlaky(
      1,
      new ProviderError("internal error", "test", 500),
    );
    const provider = new RetryProvider(inner);

    const result = await provider.sendMessage(MESSAGES);
    expect(result.stopReason).toBe("end_turn");
    expect(inner.calls).toBe(2);
  });

  test("retries on 502 Bad Gateway", async () => {
    const inner = makeFlaky(1, new ProviderError("bad gateway", "test", 502));
    const provider = new RetryProvider(inner);

    const result = await provider.sendMessage(MESSAGES);
    expect(inner.calls).toBe(2);
    expect(result.model).toBe("test-model");
  });

  test("retries on 503 Service Unavailable", async () => {
    const inner = makeFlaky(1, new ProviderError("unavailable", "test", 503));
    const provider = new RetryProvider(inner);

    const result = await provider.sendMessage(MESSAGES);
    expect(inner.calls).toBe(2);
    expect(result.content).toHaveLength(1);
  });

  test("does not retry on 400 Bad Request", async () => {
    const inner = makeFailing(new ProviderError("bad request", "test", 400));
    const provider = new RetryProvider(inner);

    await expect(provider.sendMessage(MESSAGES)).rejects.toThrow("bad request");
    expect(inner.calls).toBe(1);
  });

  test("does not retry on 401 Unauthorized", async () => {
    const inner = makeFailing(new ProviderError("unauthorized", "test", 401));
    const provider = new RetryProvider(inner);

    await expect(provider.sendMessage(MESSAGES)).rejects.toThrow(
      "unauthorized",
    );
    expect(inner.calls).toBe(1);
  });

  test("does not retry on 403 Forbidden", async () => {
    const inner = makeFailing(new ProviderError("forbidden", "test", 403));
    const provider = new RetryProvider(inner);

    await expect(provider.sendMessage(MESSAGES)).rejects.toThrow("forbidden");
    expect(inner.calls).toBe(1);
  });

  test("does not retry on 422 Unprocessable Entity", async () => {
    const inner = makeFailing(new ProviderError("invalid input", "test", 422));
    const provider = new RetryProvider(inner);

    await expect(provider.sendMessage(MESSAGES)).rejects.toThrow(
      "invalid input",
    );
    expect(inner.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RetryProvider — network error retries
// ---------------------------------------------------------------------------

describe("RetryProvider — network error retries", () => {
  test("retries on ECONNRESET", async () => {
    const err = new Error("connection reset");
    (err as NodeJS.ErrnoException).code = "ECONNRESET";
    const inner = makeFlaky(1, err);
    const provider = new RetryProvider(inner);

    const result = await provider.sendMessage(MESSAGES);
    expect(inner.calls).toBe(2);
    expect(result.stopReason).toBe("end_turn");
  });

  test("retries on ECONNREFUSED", async () => {
    const err = new Error("connection refused");
    (err as NodeJS.ErrnoException).code = "ECONNREFUSED";
    const inner = makeFlaky(1, err);
    const provider = new RetryProvider(inner);

    const result = await provider.sendMessage(MESSAGES);
    expect(inner.calls).toBe(2);
    expect(result.model).toBe("test-model");
  });

  test("retries on ETIMEDOUT", async () => {
    const err = new Error("timed out");
    (err as NodeJS.ErrnoException).code = "ETIMEDOUT";
    const inner = makeFlaky(1, err);
    const provider = new RetryProvider(inner);

    const _result = await provider.sendMessage(MESSAGES);
    expect(inner.calls).toBe(2);
  });

  test("retries on ECONNRESET in error cause chain", async () => {
    const cause = new Error("socket hangup");
    (cause as NodeJS.ErrnoException).code = "ECONNRESET";
    const outer = new Error("fetch failed", { cause });
    const inner = makeFlaky(1, outer);
    const provider = new RetryProvider(inner);

    const result = await provider.sendMessage(MESSAGES);
    expect(inner.calls).toBe(2);
    expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
  });

  test("retries on Bun 'socket connection was closed unexpectedly' (ProviderError wrapping)", async () => {
    const inner = makeFlaky(
      1,
      new ProviderError(
        "Anthropic request failed: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
        "anthropic",
      ),
    );
    const provider = new RetryProvider(inner);

    const result = await provider.sendMessage(MESSAGES);
    expect(inner.calls).toBe(2);
    expect(result.stopReason).toBe("end_turn");
  });

  test("retries on 'socket connection was closed unexpectedly' in error cause", async () => {
    const cause = new Error(
      "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
    );
    const outer = new Error("fetch failed", { cause });
    const inner = makeFlaky(1, outer);
    const provider = new RetryProvider(inner);

    const result = await provider.sendMessage(MESSAGES);
    expect(inner.calls).toBe(2);
    expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
  });

  test("does not retry on non-retryable errors", async () => {
    const inner = makeFailing(new Error("unexpected error"));
    const provider = new RetryProvider(inner);

    await expect(provider.sendMessage(MESSAGES)).rejects.toThrow(
      "unexpected error",
    );
    expect(inner.calls).toBe(1);
  });

  test("does not retry on ProviderError without status code (non-network)", async () => {
    // ProviderError without a statusCode and without a retryable network code
    const err = new ProviderError("model not found", "test");
    const inner = makeFailing(err);
    const provider = new RetryProvider(inner);

    await expect(provider.sendMessage(MESSAGES)).rejects.toThrow(
      "model not found",
    );
    expect(inner.calls).toBe(1);
  });

  test("retries on 'Request was aborted' (transport-level abort, no abortReason)", async () => {
    // Exactly the wire-format the Anthropic SDK emits when its underlying
    // fetch AbortSignal fires without a daemon-tagged reason (bun fetch
    // deadline, edge LB, NAT idle).
    const inner = makeFlaky(
      1,
      new ProviderError(
        "Anthropic API error (undefined): Request was aborted.",
        "anthropic",
      ),
    );
    const provider = new RetryProvider(inner);

    const result = await provider.sendMessage(MESSAGES);
    expect(inner.calls).toBe(2);
    expect(result.stopReason).toBe("end_turn");
  });

  test("does NOT retry 'Request was aborted' when abortReason is set (caller/daemon cancel)", async () => {
    const inner = makeFailing(
      new ProviderError(
        "Anthropic API error (undefined): Request was aborted.",
        "anthropic",
        undefined,
        { abortReason: { kind: "user_cancel", source: "test" } },
      ),
    );
    const provider = new RetryProvider(inner);

    await expect(provider.sendMessage(MESSAGES)).rejects.toThrow(
      "Request was aborted",
    );
    // Only the initial call — no retries.
    expect(inner.calls).toBe(1);
  });

  test("does NOT retry 'Anthropic stream timed out' (inner streamTimeoutMs fired)", async () => {
    const inner = makeFailing(
      new ProviderError(
        "Anthropic API error (undefined): Anthropic stream timed out after 1800s (inner streamTimeoutMs)",
        "anthropic",
      ),
    );
    const provider = new RetryProvider(inner);

    await expect(provider.sendMessage(MESSAGES)).rejects.toThrow(
      "stream timed out",
    );
    expect(inner.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RetryProvider — streaming corruption retries
// ---------------------------------------------------------------------------

describe("RetryProvider — streaming corruption retries", () => {
  test("retries on 'Unexpected event order' (message_start before message_stop)", async () => {
    const inner = makeFlaky(
      1,
      new ProviderError(
        'Anthropic request failed: Unexpected event order, got message_start before receiving "message_stop"',
        "anthropic",
      ),
    );
    const provider = new RetryProvider(inner);

    const result = await provider.sendMessage(MESSAGES);
    expect(result.stopReason).toBe("end_turn");
    expect(inner.calls).toBe(2);
  });

  test("retries on 'Unexpected event order' (event before message_start)", async () => {
    const inner = makeFlaky(
      1,
      new ProviderError(
        'Anthropic request failed: Unexpected event order, got content_block_start before "message_start"',
        "anthropic",
      ),
    );
    const provider = new RetryProvider(inner);

    const result = await provider.sendMessage(MESSAGES);
    expect(inner.calls).toBe(2);
    expect(result.model).toBe("test-model");
  });

  test("retries on 'stream ended without producing'", async () => {
    const inner = makeFlaky(
      1,
      new ProviderError(
        "Anthropic request failed: stream ended without producing a Message with role=assistant",
        "anthropic",
      ),
    );
    const provider = new RetryProvider(inner);

    const result = await provider.sendMessage(MESSAGES);
    expect(inner.calls).toBe(2);
    expect(result.content).toHaveLength(1);
  });

  test("retries on 'request ended without sending any chunks'", async () => {
    const inner = makeFlaky(
      1,
      new ProviderError(
        "Anthropic request failed: request ended without sending any chunks",
        "anthropic",
      ),
    );
    const provider = new RetryProvider(inner);

    await provider.sendMessage(MESSAGES);
    expect(inner.calls).toBe(2);
  });

  test("throws after exhausting retries on persistent stream corruption", async () => {
    const inner = makeFailing(
      new ProviderError(
        'Anthropic request failed: Unexpected event order, got message_start before receiving "message_stop"',
        "anthropic",
      ),
    );
    const provider = new RetryProvider(inner);

    await expect(provider.sendMessage(MESSAGES)).rejects.toThrow(
      "Unexpected event order",
    );
    expect(inner.calls).toBe(DEFAULT_MAX_RETRIES + 1);
  });

  test("does not retry non-stream ProviderError without status code", async () => {
    const inner = makeFailing(
      new ProviderError("model not found", "anthropic"),
    );
    const provider = new RetryProvider(inner);

    await expect(provider.sendMessage(MESSAGES)).rejects.toThrow(
      "model not found",
    );
    expect(inner.calls).toBe(1);
  });

  test("does not treat stream pattern as retryable when ProviderError has a status code", async () => {
    // A 400 error that happens to contain "Unexpected event order" should NOT be retried
    const inner = makeFailing(
      new ProviderError(
        "Unexpected event order in request payload",
        "anthropic",
        400,
      ),
    );
    const provider = new RetryProvider(inner);

    await expect(provider.sendMessage(MESSAGES)).rejects.toThrow(
      "Unexpected event order",
    );
    expect(inner.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RetryProvider — streaming + options passthrough
// ---------------------------------------------------------------------------

describe("RetryProvider — streaming response handling", () => {
  test("passes onEvent callback through to inner provider", async () => {
    const events: ProviderEvent[] = [];
    const inner: Provider = {
      name: "streaming-mock",
      async sendMessage(_m, _t, _s, options) {
        options?.onEvent?.({ type: "text_delta", text: "hello " });
        options?.onEvent?.({ type: "text_delta", text: "world" });
        return successResponse();
      },
    };
    const provider = new RetryProvider(inner);

    await provider.sendMessage(MESSAGES, undefined, undefined, {
      onEvent: (e) => events.push(e),
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "text_delta", text: "hello " });
    expect(events[1]).toMatchObject({ type: "text_delta", text: "world" });
  });

  test("passes signal through to inner provider", async () => {
    let receivedSignal: AbortSignal | undefined;
    const inner: Provider = {
      name: "signal-mock",
      async sendMessage(_m, _t, _s, options) {
        receivedSignal = options?.signal;
        return successResponse();
      },
    };
    const provider = new RetryProvider(inner);
    const controller = new AbortController();

    await provider.sendMessage(MESSAGES, undefined, undefined, {
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  test("retries overloaded_error with undefined statusCode (mid-stream SSE)", async () => {
    let callCount = 0;
    const inner: Provider = {
      name: "retry-overloaded-undefined",
      async sendMessage() {
        callCount++;
        if (callCount <= 1) {
          throw new ProviderError(
            'Anthropic API error (undefined): {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
            "anthropic",
            undefined,
          );
        }
        return successResponse();
      },
    };
    const provider = new RetryProvider(inner);
    await provider.sendMessage(MESSAGES);
    expect(callCount).toBe(2);
  });

  test("events accumulate across retries (each attempt delivers events independently)", async () => {
    let callCount = 0;
    const inner: Provider = {
      name: "retry-stream",
      async sendMessage(_m, _t, _s, options) {
        callCount++;
        options?.onEvent?.({
          type: "text_delta",
          text: `attempt${callCount} `,
        });
        if (callCount <= 1) {
          throw new ProviderError("overloaded", "test", 529);
        }
        return successResponse();
      },
    };
    const provider = new RetryProvider(inner);
    const events: ProviderEvent[] = [];

    await provider.sendMessage(MESSAGES, undefined, undefined, {
      onEvent: (e) => events.push(e),
    });

    // Events from both attempts are delivered
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "text_delta", text: "attempt1 " });
    expect(events[1]).toMatchObject({ type: "text_delta", text: "attempt2 " });
  });
});

// ---------------------------------------------------------------------------
// createStreamTimeout — edge cases
// ---------------------------------------------------------------------------

describe("createStreamTimeout — edge cases", () => {
  test("propagates already-aborted external signal immediately", () => {
    const external = new AbortController();
    external.abort(new Error("already cancelled"));

    const { signal, cleanup } = createStreamTimeout(60_000, external.signal);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(Error);
    expect((signal.reason as Error).message).toBe("already cancelled");
    cleanup();
  });

  test("cleanup prevents timeout from firing", async () => {
    const { signal, cleanup } = createStreamTimeout(50);
    cleanup();

    await new Promise((r) => setTimeout(r, 100));
    expect(signal.aborted).toBe(false);
  });

  test("cleanup removes external signal listener", () => {
    const external = new AbortController();
    const { signal, cleanup } = createStreamTimeout(60_000, external.signal);

    cleanup();

    // Aborting external after cleanup should NOT propagate
    external.abort(new Error("late abort"));
    expect(signal.aborted).toBe(false);
  });

  test("timeout error message includes duration", async () => {
    const { signal, cleanup } = createStreamTimeout(100);

    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });

    expect(signal.reason).toBeInstanceOf(Error);
    expect((signal.reason as Error).message).toContain("0.1s");
    cleanup();
  });
});
