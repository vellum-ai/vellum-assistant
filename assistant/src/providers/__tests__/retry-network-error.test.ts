import { describe, expect, mock, test } from "bun:test";

import * as retryUtil from "../../util/retry.js";

// Instant sleep so backoff delays don't slow the suite; everything else is
// the real module.
mock.module("../../util/retry.js", () => ({
  ...retryUtil,
  sleep: async () => {},
}));

const { RetryProvider } = await import("../retry.js");
const { ProviderError } = await import("../../util/errors.js");

import type { Message, Provider, ProviderResponse } from "../types.js";

const OK_RESPONSE = {
  content: [{ type: "text", text: "ok" }],
  model: "test-model",
  usage: { inputTokens: 1, outputTokens: 1 },
} as unknown as ProviderResponse;

const MESSAGES: Message[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
];

/** Inner provider that throws the queued errors in order, then succeeds. */
function flakyProvider(errors: unknown[]): {
  provider: Provider;
  calls: () => number;
} {
  let calls = 0;
  const queue = [...errors];
  const provider: Provider = {
    name: "openai-compatible",
    sendMessage: async () => {
      calls += 1;
      const next = queue.shift();
      if (next !== undefined) {
        throw next;
      }
      return OK_RESPONSE;
    },
  };
  return { provider, calls: () => calls };
}

describe("RetryProvider network_error handling", () => {
  test("retries a transport failure stamped with reason network_error", async () => {
    const { provider, calls } = flakyProvider([
      new ProviderError(
        "OpenAI-compatible API error (unknown status): Connection error.",
        "openai-compatible",
        undefined,
        { reason: "network_error" },
      ),
    ]);
    const result = await new RetryProvider(provider).sendMessage(MESSAGES);
    expect(result).toBe(OK_RESPONSE);
    expect(calls()).toBe(2);
  });

  test("still does not retry a statusless reason-less abort-shaped error", async () => {
    // OpenAI catch-sites do not distinguish inner stream deadlines from
    // transport aborts, so their "Request was aborted." must stay
    // non-retryable (see RETRYABLE_TRANSPORT_ABORT_PATTERNS).
    const abortShaped = () =>
      new ProviderError(
        "OpenAI API error (unknown status): Request was aborted.",
        "openai",
        undefined,
      );
    const { provider, calls } = flakyProvider([
      abortShaped(),
      abortShaped(),
      abortShaped(),
      abortShaped(),
    ]);
    await expect(
      new RetryProvider(provider).sendMessage(MESSAGES),
    ).rejects.toThrow("Request was aborted");
    expect(calls()).toBe(1);
  });
});
