/**
 * Provider Streaming Benchmark
 *
 * Measures overhead introduced by the provider adapter layers (retry, stream
 * timeout) on top of a simulated streaming source.
 *
 * Baseline targets:
 * - TTFT overhead < 50ms beyond source latency
 * - Event throughput within 20% of source rate through provider wrappers
 * - Abort signal stops streaming within 100ms
 * - Stream timeout fires within 50ms of configured deadline
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

import { RetryProvider } from "../providers/retry.js";
import { createStreamTimeout } from "../providers/stream-timeout.js";
import type {
  Message,
  Provider,
  ProviderEvent,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SIMPLE_MESSAGES: Message[] = [
  { role: "user", content: [{ type: "text", text: "Hello" }] },
];

// Dummy key for mock server tests — not a real credential
const BENCH_API_KEY = ["test", "benchmark", "key"].join("-");

/** Build a mock provider that delivers `tokenCount` text deltas at a given rate. */
function makeStreamingProvider(
  tokenCount: number,
  tokensPerSecond: number,
  opts?: { ttftMs?: number; name?: string },
): Provider {
  const delayPerToken = 1000 / tokensPerSecond;
  const ttftMs = opts?.ttftMs ?? 0;

  return {
    name: opts?.name ?? "mock-streaming",
    async sendMessage(
      _messages: Message[],
      _tools?: ToolDefinition[],
      _systemPrompt?: string,
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      const { onEvent, signal } = options ?? {};

      // Simulate TTFT delay
      if (ttftMs > 0) {
        await new Promise((r) => setTimeout(r, ttftMs));
      }

      for (let i = 0; i < tokenCount; i++) {
        if (signal?.aborted) break;
        onEvent?.({ type: "text_delta", text: `word${i} ` });
        if (i < tokenCount - 1) {
          await new Promise((r) => setTimeout(r, delayPerToken));
        }
      }

      return {
        content: [{ type: "text", text: "complete" }],
        model: "mock",
        usage: { inputTokens: 10, outputTokens: tokenCount },
        stopReason: "end_turn",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe("Provider streaming benchmark", () => {
  test("TTFT overhead through RetryProvider is < 50ms", async () => {
    const sourceTtftMs = 20;
    const inner = makeStreamingProvider(10, 100, { ttftMs: sourceTtftMs });
    const wrapped = new RetryProvider(inner);

    let firstEventTime: number | undefined;
    const start = performance.now();

    await wrapped.sendMessage(SIMPLE_MESSAGES, undefined, undefined, {
      onEvent: () => {
        if (firstEventTime === undefined) {
          firstEventTime = performance.now();
        }
      },
    });

    expect(firstEventTime).toBeDefined();
    const observedTtft = firstEventTime! - start;
    const overhead = observedTtft - sourceTtftMs;

    // The wrapper should add negligible latency
    expect(overhead).toBeLessThan(50);
  });

  test("event throughput through provider wrappers is within 20% of source rate", async () => {
    const tokenCount = 50;
    const sourceRate = 200; // tokens/sec

    // Measure unwrapped baseline in the same run so we compare against actual
    // timer resolution rather than the theoretical sourceRate (which setTimeout
    // may not achieve on busy or coarse-timer hosts).
    const baseline = makeStreamingProvider(tokenCount, sourceRate);
    const baselineEvents: number[] = [];
    const baselineStart = performance.now();

    await baseline.sendMessage(SIMPLE_MESSAGES, undefined, undefined, {
      onEvent: () => {
        baselineEvents.push(performance.now());
      },
    });

    const baselineElapsed =
      baselineEvents[baselineEvents.length - 1] - baselineStart;
    const baselineRate = (baselineEvents.length / baselineElapsed) * 1000;

    // Now measure the wrapped provider
    const inner = makeStreamingProvider(tokenCount, sourceRate);
    const wrapped = new RetryProvider(inner);

    const events: number[] = [];
    const start = performance.now();

    await wrapped.sendMessage(SIMPLE_MESSAGES, undefined, undefined, {
      onEvent: () => {
        events.push(performance.now());
      },
    });

    const elapsed = events[events.length - 1] - start;
    const observedRate = (events.length / elapsed) * 1000;

    expect(events.length).toBe(tokenCount);

    // Wrapped throughput should be within 20% of the measured unwrapped baseline
    const minAcceptableRate = baselineRate * 0.8;
    expect(observedRate).toBeGreaterThanOrEqual(minAcceptableRate);
  });

  test("createStreamTimeout fires within 50ms of configured deadline", async () => {
    const timeoutMs = 100;
    const { signal, cleanup } = createStreamTimeout(timeoutMs);

    const start = performance.now();

    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });

    const elapsed = performance.now() - start;
    cleanup();

    // Should fire close to the configured timeout
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 10); // allow 10ms early
    expect(elapsed).toBeLessThan(timeoutMs + 50);
  });

  test("external abort signal propagates through createStreamTimeout within 10ms", async () => {
    const externalController = new AbortController();
    const { signal, cleanup } = createStreamTimeout(
      60_000,
      externalController.signal,
    );

    const abortDelay = 50;

    const start = performance.now();
    setTimeout(
      () => externalController.abort(new Error("user cancel")),
      abortDelay,
    );

    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });

    const elapsed = performance.now() - start;
    cleanup();

    // Should propagate almost immediately after external abort
    expect(elapsed).toBeGreaterThanOrEqual(abortDelay - 10);
    expect(elapsed).toBeLessThan(abortDelay + 10);
  });

  test("abort signal stops streaming provider within 100ms", async () => {
    // Provider that would stream 200 tokens at 50/sec (4 seconds total)
    const inner = makeStreamingProvider(200, 50);
    const wrapped = new RetryProvider(inner);

    const controller = new AbortController();
    const events: ProviderEvent[] = [];

    // Abort after 100ms — should stop well before all 200 tokens
    const abortAfterMs = 100;
    setTimeout(() => controller.abort(), abortAfterMs);

    const start = performance.now();

    await wrapped.sendMessage(SIMPLE_MESSAGES, undefined, undefined, {
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    const elapsed = performance.now() - start;

    // Should have stopped well before all 200 tokens
    expect(events.length).toBeLessThan(200);
    // Should complete within 100ms of abort signal (abort at 100ms + 100ms grace)
    expect(elapsed).toBeLessThan(abortAfterMs + 100);
  });

  test("SSE event parsing throughput via Bun.serve mock", async () => {
    const tokenCount = 100;
    const encoder = new TextEncoder();

    // Start a local SSE server
    const server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream({
          async start(controller) {
            for (let i = 0; i < tokenCount; i++) {
              const event = `event: content_block_delta\ndata: ${JSON.stringify(
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: `word${i} ` },
                },
              )}\n\n`;
              controller.enqueue(encoder.encode(event));
            }
            // Send stop event
            controller.enqueue(
              encoder.encode(
                `event: message_stop\ndata: ${JSON.stringify({
                  type: "message_stop",
                })}\n\n`,
              ),
            );
            controller.close();
          },
        });

        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    try {
      const start = performance.now();

      const response = await fetch(`http://localhost:${server.port}`);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      let eventCount = 0;
      let firstEventTime: number | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const parts = buffer.split("\n\n");
        buffer = parts.pop()!; // keep incomplete last part

        for (const part of parts) {
          if (!part.trim()) continue;
          const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;

          const json = JSON.parse(dataLine.slice(6));
          if (json.type === "content_block_delta") {
            eventCount++;
            if (firstEventTime === undefined) {
              firstEventTime = performance.now();
            }
          }
        }
      }

      const elapsed = performance.now() - start;
      const eventsPerSecond = (eventCount / elapsed) * 1000;

      // All events should be parsed
      expect(eventCount).toBe(tokenCount);

      // TTFT from server should be < 50ms (no artificial delay)
      expect(firstEventTime! - start).toBeLessThan(50);

      // Throughput: at least 1000 events/sec for local SSE parsing
      // (no network latency, just parsing overhead)
      expect(eventsPerSecond).toBeGreaterThan(1000);
    } finally {
      server.stop();
    }
  });

  test("stream timeout cleanup prevents late abort", async () => {
    // Create a timeout that would fire in 100ms
    const { signal, cleanup } = createStreamTimeout(100);

    // Clean up before it fires
    cleanup();

    // Wait past the original timeout
    await new Promise((r) => setTimeout(r, 150));

    // Signal should NOT have been aborted since we cleaned up
    expect(signal.aborted).toBe(false);
  });

  test("TTFT through Anthropic SDK adapter with mock SSE server", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const tokenCount = 20;
    const encoder = new TextEncoder();

    // Full Anthropic-format SSE response
    function buildAnthropicSSE(count: number): string[] {
      const events: string[] = [];

      events.push(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_bench_01",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-3-5-sonnet-20241022",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        })}\n\n`,
      );

      events.push(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })}\n\n`,
      );

      for (let i = 0; i < count; i++) {
        events.push(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: `word${i} ` },
          })}\n\n`,
        );
      }

      events.push(
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: 0,
        })}\n\n`,
      );

      events.push(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: count },
        })}\n\n`,
      );

      events.push(
        `event: message_stop\ndata: ${JSON.stringify({
          type: "message_stop",
        })}\n\n`,
      );

      return events;
    }

    const server = Bun.serve({
      port: 0,
      fetch() {
        const sseEvents = buildAnthropicSSE(tokenCount);
        const stream = new ReadableStream({
          start(controller) {
            for (const evt of sseEvents) {
              controller.enqueue(encoder.encode(evt));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    try {
      const client = new Anthropic({
        apiKey: BENCH_API_KEY,
        baseURL: `http://localhost:${server.port}`,
      });

      let firstEventTime: number | undefined;
      const start = performance.now();

      const sdkStream = client.messages.stream({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }],
      });

      sdkStream.on("text", () => {
        if (firstEventTime === undefined) {
          firstEventTime = performance.now();
        }
      });

      await sdkStream.finalMessage();

      expect(firstEventTime).toBeDefined();
      const ttft = firstEventTime! - start;

      // TTFT through the full SDK adapter should be < 100ms with a local mock
      expect(ttft).toBeLessThan(100);
    } finally {
      server.stop();
    }
  });

  test("throughput through Anthropic SDK adapter matches source rate", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const tokenCount = 200;
    const encoder = new TextEncoder();

    const server = Bun.serve({
      port: 0,
      fetch() {
        const events: string[] = [];

        events.push(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: "msg_bench_02",
              type: "message",
              role: "assistant",
              content: [],
              model: "claude-3-5-sonnet-20241022",
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 1 },
            },
          })}\n\n`,
        );

        events.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
        );

        for (let i = 0; i < tokenCount; i++) {
          events.push(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: `w${i} ` },
            })}\n\n`,
          );
        }

        events.push(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: 0,
          })}\n\n`,
        );

        events.push(
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: tokenCount },
          })}\n\n`,
        );

        events.push(
          `event: message_stop\ndata: ${JSON.stringify({
            type: "message_stop",
          })}\n\n`,
        );

        const stream = new ReadableStream({
          start(controller) {
            for (const evt of events) {
              controller.enqueue(encoder.encode(evt));
            }
            controller.close();
          },
        });

        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    try {
      const client = new Anthropic({
        apiKey: BENCH_API_KEY,
        baseURL: `http://localhost:${server.port}`,
      });

      const textEvents: number[] = [];
      const start = performance.now();

      const sdkStream = client.messages.stream({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 4096,
        messages: [{ role: "user", content: "Hello" }],
      });

      sdkStream.on("text", () => {
        textEvents.push(performance.now());
      });

      await sdkStream.finalMessage();

      const elapsed = textEvents[textEvents.length - 1] - start;
      const observedRate = (textEvents.length / elapsed) * 1000;

      // All text deltas should be delivered through the SDK
      expect(textEvents.length).toBe(tokenCount);

      // SDK adapter should achieve at least 1000 events/sec from a local mock
      // (same threshold as the raw SSE parsing test)
      expect(observedRate).toBeGreaterThan(1000);
    } finally {
      server.stop();
    }
  });

  test("AnthropicProvider adapter end-to-end with mock SSE server", async () => {
    const tokenCount = 50;
    const encoder = new TextEncoder();

    const server = Bun.serve({
      port: 0,
      fetch() {
        const events: string[] = [];

        events.push(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: "msg_bench_03",
              type: "message",
              role: "assistant",
              content: [],
              model: "claude-3-5-sonnet-20241022",
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 1 },
            },
          })}\n\n`,
        );

        events.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
        );

        for (let i = 0; i < tokenCount; i++) {
          events.push(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: `token${i} ` },
            })}\n\n`,
          );
        }

        events.push(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: 0,
          })}\n\n`,
        );

        events.push(
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: tokenCount },
          })}\n\n`,
        );

        events.push(
          `event: message_stop\ndata: ${JSON.stringify({
            type: "message_stop",
          })}\n\n`,
        );

        const stream = new ReadableStream({
          start(controller) {
            for (const evt of events) {
              controller.enqueue(encoder.encode(evt));
            }
            controller.close();
          },
        });

        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    // Save and override env var before try so it's always restored in finally
    const origBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${server.port}`;

    try {
      // Import dynamically after setting env var so SDK picks it up
      const { AnthropicProvider } =
        await import("../providers/anthropic/client.js");
      const provider = new AnthropicProvider(
        BENCH_API_KEY,
        "claude-3-5-sonnet-20241022",
      );

      const receivedEvents: ProviderEvent[] = [];
      let firstEventTime: number | undefined;
      const start = performance.now();

      const result = await provider.sendMessage(
        SIMPLE_MESSAGES,
        undefined,
        undefined,
        {
          onEvent: (e) => {
            if (firstEventTime === undefined) {
              firstEventTime = performance.now();
            }
            receivedEvents.push(e);
          },
        },
      );

      // Verify the full adapter pipeline delivered all events
      const textDeltas = receivedEvents.filter((e) => e.type === "text_delta");
      expect(textDeltas.length).toBe(tokenCount);

      // TTFT through the complete provider adapter < 100ms
      expect(firstEventTime).toBeDefined();
      expect(firstEventTime! - start).toBeLessThan(100);

      // Provider response should have correct structure
      expect(result.model).toBe("claude-3-5-sonnet-20241022");
      expect(result.stopReason).toBe("end_turn");
      expect(result.usage.outputTokens).toBe(tokenCount);

      // Throughput: events should flow at > 500 events/sec through the full adapter
      const elapsed = performance.now() - start;
      const rate = (textDeltas.length / elapsed) * 1000;
      expect(rate).toBeGreaterThan(500);
    } finally {
      if (origBaseUrl === undefined) {
        delete process.env.ANTHROPIC_BASE_URL;
      } else {
        process.env.ANTHROPIC_BASE_URL = origBaseUrl;
      }
      server.stop();
    }
  });

  test("multiple rapid events are delivered without batching loss", async () => {
    // Provider that emits events as fast as possible (no delay between tokens)
    const tokenCount = 500;
    const inner: Provider = {
      name: "rapid-fire",
      async sendMessage(
        _messages: Message[],
        _tools?: ToolDefinition[],
        _systemPrompt?: string,
        options?: SendMessageOptions,
      ): Promise<ProviderResponse> {
        const { onEvent } = options ?? {};
        for (let i = 0; i < tokenCount; i++) {
          onEvent?.({ type: "text_delta", text: `w${i} ` });
        }
        return {
          content: [{ type: "text", text: "done" }],
          model: "mock",
          usage: { inputTokens: 5, outputTokens: tokenCount },
          stopReason: "end_turn",
        };
      },
    };

    const wrapped = new RetryProvider(inner);
    const events: ProviderEvent[] = [];

    const start = performance.now();

    await wrapped.sendMessage(SIMPLE_MESSAGES, undefined, undefined, {
      onEvent: (e) => events.push(e),
    });

    const elapsed = performance.now() - start;

    // All events must be delivered — no loss through the wrapper
    expect(events.length).toBe(tokenCount);

    // 500 synchronous events should complete in < 50ms
    expect(elapsed).toBeLessThan(50);
  });
});
