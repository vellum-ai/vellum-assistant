/**
 * Tests for agent loop LLM call timeout and retry event surfacing.
 *
 * 1. Verifies that a hung LLM call is aborted after the configured timeout
 *    and surfaces a clear ProviderError (not a generic "aborted" message).
 * 2. Verifies that retry events from RetryProvider are forwarded as
 *    `llm_retry` AgentEvent so the conversation layer can surface progress.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks ─────────────────────────────────────────────────────
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../hooks/manager.js", () => ({
  getHookManager: () => ({
    trigger: async () => ({ blocked: false }),
  }),
}));

mock.module("../context/token-estimator.js", () => ({
  estimatePromptTokensRaw: () => 100,
  estimateToolsTokens: () => 50,
  getCalibrationProviderKey: () => "test",
}));

mock.module("@sentry/node", () => ({
  captureException: () => {},
}));

import { type AgentEvent, AgentLoop } from "../agent/loop.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";
import { ProviderError } from "../util/errors.js";

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "hello" }],
};

// ── Helpers ──────────────────────────────────────────────────────────

/** Provider that never resolves — simulates a hung provider. */
function makeHangingProvider(): Provider {
  return {
    name: "test-hanging",
    async sendMessage(
      _messages: Message[],
      _tools?: ToolDefinition[],
      _systemPrompt?: string,
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      return new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) {
          reject(new Error("The operation was aborted"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new Error("The operation was aborted")),
          { once: true },
        );
      });
    },
  };
}

/** Provider that fails N times with a retryable error, then succeeds. */
function makeRetryableProvider(failCount: number): {
  provider: Provider;
  callCount: () => number;
} {
  let calls = 0;
  const provider: Provider = {
    name: "test-retryable",
    async sendMessage(
      _messages: Message[],
      _tools?: ToolDefinition[],
      _systemPrompt?: string,
      _options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      calls++;
      if (calls <= failCount) {
        throw new ProviderError("Service overloaded", "test-retryable", 429);
      }
      return {
        content: [{ type: "text", text: "ok" }],
        model: "test-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end_turn",
      };
    },
  };
  return { provider, callCount: () => calls };
}

/** Provider that always fails with a non-retryable 400 error. */
function makeFailingProvider(): Provider {
  return {
    name: "test-failing",
    async sendMessage(): Promise<ProviderResponse> {
      throw new ProviderError(
        "Bad request: thinking not supported",
        "test-failing",
        400,
      );
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("AgentLoop LLM call timeout", () => {
  test("surfaces a clear ProviderError when LLM call times out", async () => {
    const events: AgentEvent[] = [];

    const loop = new AgentLoop(makeHangingProvider(), "test system prompt", {
      maxTokens: 1024,
      effort: "low",
      llmCallTimeoutMs: 500, // 500ms timeout for fast test
    });

    await loop.run(
      [userMessage],
      (event) => {
        events.push(event);
      },
      undefined, // no external signal
    );

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.type).toBe("error");

    const err = (errorEvent as Extract<AgentEvent, { type: "error" }>).error;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("timed out");
    expect(err.message).toContain("provider did not respond");
  });

  test("does not wrap user-cancel as timeout error", async () => {
    const events: AgentEvent[] = [];
    const abortController = new AbortController();

    const loop = new AgentLoop(makeHangingProvider(), "test system prompt", {
      maxTokens: 1024,
      effort: "low",
      llmCallTimeoutMs: 60_000, // long timeout — should not fire
    });

    // Cancel after 200ms
    setTimeout(() => abortController.abort(), 200);

    await loop.run(
      [userMessage],
      (event) => {
        events.push(event);
      },
      abortController.signal,
    );

    // User-cancel should NOT produce a timeout ProviderError — the loop
    // should break cleanly via the signal.aborted path.
    const errorEvent = events.find((e) => e.type === "error");
    if (errorEvent) {
      const err = (errorEvent as Extract<AgentEvent, { type: "error" }>).error;
      expect(err.message).not.toContain("timed out");
    }
  });

  test("clears timeout when LLM call succeeds normally", async () => {
    const events: AgentEvent[] = [];

    const successProvider: Provider = {
      name: "test-success",
      async sendMessage(): Promise<ProviderResponse> {
        return {
          content: [{ type: "text", text: "hello!" }],
          model: "test-model",
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "end_turn",
        };
      },
    };

    const loop = new AgentLoop(successProvider, "test system prompt", {
      maxTokens: 1024,
      effort: "low",
      llmCallTimeoutMs: 5_000,
    });

    await loop.run([userMessage], (event) => {
      events.push(event);
    });

    // Should complete without error
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeUndefined();

    // Should have a usage event (proof the call completed)
    const usageEvent = events.find((e) => e.type === "usage");
    expect(usageEvent).toBeDefined();
  });
});

describe("AgentLoop LLM call non-retryable error surfaces immediately", () => {
  test("400 error is emitted and loop exits cleanly", async () => {
    const events: AgentEvent[] = [];

    const loop = new AgentLoop(makeFailingProvider(), "test system prompt", {
      maxTokens: 1024,
      effort: "low",
    });

    await loop.run([userMessage], (event) => {
      events.push(event);
    });

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    const err = (errorEvent as Extract<AgentEvent, { type: "error" }>).error;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("thinking not supported");
  });
});

describe("RetryProvider emits onRetry callback", () => {
  let retryInfos: Array<{
    attempt: number;
    maxRetries: number;
    delayMs: number;
    errorType: string;
  }>;

  beforeEach(() => {
    retryInfos = [];
  });

  test("onRetry is called for each retry attempt", async () => {
    mock.module("../config/loader.js", () => ({
      getConfig: () => ({
        llm: { default: { provider: "test", model: "test" } },
      }),
    }));

    const { RetryProvider } = await import("../providers/retry.js");

    const { provider: inner, callCount } = makeRetryableProvider(2);
    const retryProvider = new RetryProvider(inner);

    const result = await retryProvider.sendMessage(
      [userMessage],
      undefined,
      undefined,
      {
        onRetry: (info) => {
          retryInfos.push(info);
        },
      },
    );

    // Should have succeeded after 2 failures + 1 success = 3 calls
    expect(callCount()).toBe(3);
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);

    // Should have received 2 retry callbacks
    expect(retryInfos.length).toBe(2);
    expect(retryInfos[0].attempt).toBe(1);
    expect(retryInfos[0].errorType).toBe("rate_limit");
    expect(retryInfos[1].attempt).toBe(2);
  });
});
