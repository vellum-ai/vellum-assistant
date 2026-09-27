import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { GeminiEmbedError } from "./embedding-gemini.js";

// Capture delays passed to abortableSleep so tests can assert retry behavior
// without depending on real clock.
const sleepCalls: number[] = [];

mock.module("../../util/retry.js", () => ({
  abortableSleep: async (ms: number) => {
    sleepCalls.push(ms);
  },
  computeRetryDelay: (attempt: number, base: number) =>
    base * Math.pow(2, attempt),
  isRetryableNetworkError: () => false,
}));

const mockEmbedWithBackend = mock();
mock.module("./embedding-backend.js", () => ({
  embedWithBackend: mockEmbedWithBackend,
}));

import { EMBED_BASE_DELAY_MS, embedWithRetry } from "./embed.js";

const STUB_CONFIG = {} as Parameters<typeof embedWithRetry>[0];

describe("embedWithRetry: Retry-After header", () => {
  beforeEach(() => {
    sleepCalls.length = 0;
    mockEmbedWithBackend.mockClear();
  });

  afterEach(() => {
    mockEmbedWithBackend.mockRestore();
  });

  test("uses retryAfterMs from error as the sleep delay when present", async () => {
    const retryAfterMs = 5000;
    mockEmbedWithBackend
      .mockRejectedValueOnce(
        new GeminiEmbedError("rate limited", 429, retryAfterMs),
      )
      .mockResolvedValueOnce({
        provider: "gemini",
        model: "m",
        vectors: [[0.1, 0.2]],
      });

    await embedWithRetry(STUB_CONFIG, ["hello"]);

    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBe(retryAfterMs);
  });

  test("falls back to exponential backoff when retryAfterMs is absent", async () => {
    mockEmbedWithBackend
      .mockRejectedValueOnce(new GeminiEmbedError("rate limited", 429))
      .mockResolvedValueOnce({
        provider: "gemini",
        model: "m",
        vectors: [[0.1, 0.2]],
      });

    await embedWithRetry(STUB_CONFIG, ["hello"]);

    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBe(EMBED_BASE_DELAY_MS);
  });

  test("retries up to EMBED_MAX_RETRIES times before throwing", async () => {
    const error = new GeminiEmbedError("rate limited", 429, 1);
    mockEmbedWithBackend.mockRejectedValue(error);

    await expect(embedWithRetry(STUB_CONFIG, ["hello"])).rejects.toThrow(
      "rate limited",
    );
    expect(sleepCalls).toHaveLength(3);
  });

  test("returns result without retrying on success", async () => {
    mockEmbedWithBackend.mockResolvedValueOnce({
      provider: "gemini",
      model: "m",
      vectors: [[0.5, 0.6]],
    });

    const result = await embedWithRetry(STUB_CONFIG, ["hello"]);

    expect(result).toEqual({
      provider: "gemini",
      model: "m",
      vectors: [[0.5, 0.6]],
    });
    expect(sleepCalls).toHaveLength(0);
  });
});
