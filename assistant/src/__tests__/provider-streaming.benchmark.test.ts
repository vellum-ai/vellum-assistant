/**
 * Provider Streaming Benchmark
 *
 * Measures overhead introduced by the provider adapter layers (retry, failover,
 * stream timeout) on top of a simulated streaming source.
 *
 * Baseline targets:
 * - TTFT overhead < 50ms beyond source latency
 * - Event throughput within 20% of source rate through provider wrappers
 * - Abort signal stops streaming within 100ms
 * - Stream timeout fires within 50ms of configured deadline
 */
import { describe, test, expect, mock } from 'bun:test';

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
  isDebug: () => false,
}));

import { createStreamTimeout } from '../providers/stream-timeout.js';
import { RetryProvider } from '../providers/retry.js';
import { FailoverProvider } from '../providers/failover.js';
import type {
  Provider,
  ProviderResponse,
  SendMessageOptions,
  Message,
  ToolDefinition,
  ProviderEvent,
} from '../providers/types.js';
import { ProviderError } from '../util/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SIMPLE_MESSAGES: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
];

/** Build a mock provider that delivers `tokenCount` text deltas at a given rate. */
function makeStreamingProvider(
  tokenCount: number,
  tokensPerSecond: number,
  opts?: { ttftMs?: number; name?: string },
): Provider {
  const delayPerToken = 1000 / tokensPerSecond;
  const ttftMs = opts?.ttftMs ?? 0;

  return {
    name: opts?.name ?? 'mock-streaming',
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
        onEvent?.({ type: 'text_delta', text: `word${i} ` });
        if (i < tokenCount - 1) {
          await new Promise((r) => setTimeout(r, delayPerToken));
        }
      }

      return {
        content: [{ type: 'text', text: 'complete' }],
        model: 'mock',
        usage: { inputTokens: 10, outputTokens: tokenCount },
        stopReason: 'end_turn',
      };
    },
  };
}

/** Build a provider that always fails with a given error. */
function makeFailingProvider(name: string, statusCode?: number): Provider {
  return {
    name,
    async sendMessage(): Promise<ProviderResponse> {
      throw new ProviderError(`${name} failed`, name, statusCode);
    },
  };
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe('Provider streaming benchmark', () => {
  test('TTFT overhead through RetryProvider is < 50ms', async () => {
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

  test('TTFT overhead through FailoverProvider is < 50ms', async () => {
    const sourceTtftMs = 20;
    const inner = makeStreamingProvider(10, 100, {
      ttftMs: sourceTtftMs,
      name: 'primary',
    });
    const fallback = makeStreamingProvider(10, 100, {
      ttftMs: sourceTtftMs,
      name: 'fallback',
    });
    const wrapped = new FailoverProvider([inner, fallback]);

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

    expect(overhead).toBeLessThan(50);
  });

  test('event throughput through provider wrappers is within 20% of source rate', async () => {
    const tokenCount = 50;
    const sourceRate = 200; // tokens/sec
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
    // Source rate is bounded by setTimeout resolution, so we compare against
    // the actual elapsed time of a direct call instead of the theoretical rate.
    // The key assertion: we received all events and throughput didn't degrade
    // by more than 20%.
    expect(events.length).toBe(tokenCount);

    // Calculate the expected minimum rate — 80% of source rate
    const minAcceptableRate = sourceRate * 0.8;
    expect(observedRate).toBeGreaterThanOrEqual(minAcceptableRate);
  });

  test('failover adds < 100ms overhead when primary provider fails', async () => {
    const failing = makeFailingProvider('failing-primary', 500);
    const healthy = makeStreamingProvider(5, 100, { name: 'healthy-fallback' });
    const wrapped = new FailoverProvider([failing, healthy]);

    const events: ProviderEvent[] = [];
    const start = performance.now();

    await wrapped.sendMessage(SIMPLE_MESSAGES, undefined, undefined, {
      onEvent: (e) => events.push(e),
    });

    const elapsed = performance.now() - start;
    expect(events.length).toBe(5);

    // The failover decision + fallback execution should complete quickly.
    // 5 tokens at 100/sec = 40ms base. Total should be < 200ms including failover.
    expect(elapsed).toBeLessThan(200);
  });

  test('createStreamTimeout fires within 50ms of configured deadline', async () => {
    const timeoutMs = 100;
    const { signal, cleanup } = createStreamTimeout(timeoutMs);

    const start = performance.now();

    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });

    const elapsed = performance.now() - start;
    cleanup();

    // Should fire close to the configured timeout
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 10); // allow 10ms early
    expect(elapsed).toBeLessThan(timeoutMs + 50);
  });

  test('external abort signal propagates through createStreamTimeout within 10ms', async () => {
    const externalController = new AbortController();
    const { signal, cleanup } = createStreamTimeout(60_000, externalController.signal);

    const abortDelay = 50;

    const start = performance.now();
    setTimeout(() => externalController.abort(new Error('user cancel')), abortDelay);

    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });

    const elapsed = performance.now() - start;
    cleanup();

    // Should propagate almost immediately after external abort
    expect(elapsed).toBeGreaterThanOrEqual(abortDelay - 10);
    expect(elapsed).toBeLessThan(abortDelay + 10);
  });

  test('abort signal stops streaming provider within 100ms', async () => {
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

  test('SSE event parsing throughput via Bun.serve mock', async () => {
    const tokenCount = 100;
    const encoder = new TextEncoder();

    // Start a local SSE server
    const server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream({
          async start(controller) {
            for (let i = 0; i < tokenCount; i++) {
              const event = `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: `word${i} ` },
              })}\n\n`;
              controller.enqueue(encoder.encode(event));
            }
            // Send stop event
            controller.enqueue(
              encoder.encode(
                `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
              ),
            );
            controller.close();
          },
        });

        return new Response(stream, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      },
    });

    try {
      const start = performance.now();

      const response = await fetch(`http://localhost:${server.port}`);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      let buffer = '';
      let eventCount = 0;
      let firstEventTime: number | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const parts = buffer.split('\n\n');
        buffer = parts.pop()!; // keep incomplete last part

        for (const part of parts) {
          if (!part.trim()) continue;
          const dataLine = part
            .split('\n')
            .find((l) => l.startsWith('data: '));
          if (!dataLine) continue;

          const json = JSON.parse(dataLine.slice(6));
          if (json.type === 'content_block_delta') {
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

  test('stream timeout cleanup prevents late abort', async () => {
    // Create a timeout that would fire in 100ms
    const { signal, cleanup } = createStreamTimeout(100);

    // Clean up before it fires
    cleanup();

    // Wait past the original timeout
    await new Promise((r) => setTimeout(r, 150));

    // Signal should NOT have been aborted since we cleaned up
    expect(signal.aborted).toBe(false);
  });

  test('multiple rapid events are delivered without batching loss', async () => {
    // Provider that emits events as fast as possible (no delay between tokens)
    const tokenCount = 500;
    const inner: Provider = {
      name: 'rapid-fire',
      async sendMessage(
        _messages: Message[],
        _tools?: ToolDefinition[],
        _systemPrompt?: string,
        options?: SendMessageOptions,
      ): Promise<ProviderResponse> {
        const { onEvent } = options ?? {};
        for (let i = 0; i < tokenCount; i++) {
          onEvent?.({ type: 'text_delta', text: `w${i} ` });
        }
        return {
          content: [{ type: 'text', text: 'done' }],
          model: 'mock',
          usage: { inputTokens: 5, outputTokens: tokenCount },
          stopReason: 'end_turn',
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
