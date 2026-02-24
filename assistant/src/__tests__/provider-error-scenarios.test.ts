import { describe, test, expect, mock, beforeEach } from 'bun:test';

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
  isDebug: () => false,
}));

// Stub model-intents to avoid pulling in the full config
mock.module('../providers/model-intents.js', () => ({
  isModelIntent: () => false,
  resolveModelIntent: (_p: string, _i: string) => 'mock-model',
}));

import { RetryProvider } from '../providers/retry.js';
import { FailoverProvider } from '../providers/failover.js';
import { ProviderError } from '../util/errors.js';
import { computeRetryDelay, DEFAULT_MAX_RETRIES } from '../util/retry.js';
import type {
  Provider,
  ProviderResponse,
  Message,
  ProviderEvent,
} from '../providers/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MESSAGES: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
];

function okResponse(overrides?: Partial<ProviderResponse>): ProviderResponse {
  return {
    content: [{ type: 'text', text: 'ok' }],
    model: 'test-model',
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'end_turn',
    ...overrides,
  };
}

function makeProvider(
  name: string,
  impl: () => Promise<ProviderResponse>,
): Provider {
  return { name, sendMessage: impl };
}

/** Provider that fails N times then succeeds. */
function makeFlaky(
  name: string,
  failCount: number,
  error: Error,
): { provider: Provider; calls: number[] } {
  const state = { callCount: 0 };
  const calls: number[] = [];
  const provider: Provider = {
    name,
    async sendMessage() {
      calls.push(Date.now());
      state.callCount++;
      if (state.callCount <= failCount) throw error;
      return okResponse();
    },
  };
  return { provider, calls };
}

// ---------------------------------------------------------------------------
// RetryProvider — rate limit backoff
// ---------------------------------------------------------------------------

describe('RetryProvider', () => {
  describe('rate limit (429) retry', () => {
    test('retries on 429 and eventually succeeds', async () => {
      const { provider } = makeFlaky(
        'rate-limited',
        2,
        new ProviderError('rate limited', 'test', 429),
      );
      const retry = new RetryProvider(provider);

      const result = await retry.sendMessage(MESSAGES);
      expect(result.model).toBe('test-model');
    }, 30_000);

    test('exhausts retries and throws the last 429 error', async () => {
      const err = new ProviderError('rate limited', 'test', 429);
      const { provider } = makeFlaky('always-limited', DEFAULT_MAX_RETRIES + 1, err);
      const retry = new RetryProvider(provider);

      await expect(retry.sendMessage(MESSAGES)).rejects.toThrow('rate limited');
    }, 30_000);

    test('does not retry on 400 (non-retryable client error)', async () => {
      let callCount = 0;
      const inner = makeProvider('bad-request', async () => {
        callCount++;
        throw new ProviderError('bad request', 'test', 400);
      });
      const retry = new RetryProvider(inner);

      await expect(retry.sendMessage(MESSAGES)).rejects.toThrow('bad request');
      expect(callCount).toBe(1);
    });

    test('does not retry on 401 (auth error)', async () => {
      let callCount = 0;
      const inner = makeProvider('auth-fail', async () => {
        callCount++;
        throw new ProviderError('unauthorized', 'test', 401);
      });
      const retry = new RetryProvider(inner);

      await expect(retry.sendMessage(MESSAGES)).rejects.toThrow('unauthorized');
      expect(callCount).toBe(1);
    });
  });

  describe('server error (5xx) retry', () => {
    test('retries on 500 and succeeds after transient failure', async () => {
      const { provider } = makeFlaky(
        'server-err',
        1,
        new ProviderError('internal error', 'test', 500),
      );
      const retry = new RetryProvider(provider);

      const result = await retry.sendMessage(MESSAGES);
      expect(result.model).toBe('test-model');
    }, 30_000);

    test('retries on 503 service unavailable', async () => {
      const { provider } = makeFlaky(
        'unavailable',
        1,
        new ProviderError('service unavailable', 'test', 503),
      );
      const retry = new RetryProvider(provider);

      const result = await retry.sendMessage(MESSAGES);
      expect(result.model).toBe('test-model');
    }, 30_000);

    test('retries on 502 bad gateway', async () => {
      const { provider } = makeFlaky(
        'bad-gw',
        2,
        new ProviderError('bad gateway', 'test', 502),
      );
      const retry = new RetryProvider(provider);

      const result = await retry.sendMessage(MESSAGES);
      expect(result.model).toBe('test-model');
    }, 30_000);
  });

  describe('network error retry', () => {
    test('retries on ECONNRESET', async () => {
      const connError = new Error('connection reset');
      (connError as NodeJS.ErrnoException).code = 'ECONNRESET';
      const { provider } = makeFlaky('net-err', 1, connError);
      const retry = new RetryProvider(provider);

      const result = await retry.sendMessage(MESSAGES);
      expect(result.model).toBe('test-model');
    }, 30_000);

    test('retries on ECONNREFUSED', async () => {
      const connError = new Error('connection refused');
      (connError as NodeJS.ErrnoException).code = 'ECONNREFUSED';
      const { provider } = makeFlaky('refused', 1, connError);
      const retry = new RetryProvider(provider);

      const result = await retry.sendMessage(MESSAGES);
      expect(result.model).toBe('test-model');
    }, 30_000);

    test('retries on ETIMEDOUT', async () => {
      const connError = new Error('timed out');
      (connError as NodeJS.ErrnoException).code = 'ETIMEDOUT';
      const { provider } = makeFlaky('timeout', 1, connError);
      const retry = new RetryProvider(provider);

      const result = await retry.sendMessage(MESSAGES);
      expect(result.model).toBe('test-model');
    }, 30_000);

    test('retries when error cause has retryable code', async () => {
      const innerCause = new Error('inner');
      (innerCause as NodeJS.ErrnoException).code = 'EPIPE';
      const outerError = new Error('fetch failed', { cause: innerCause });
      const { provider } = makeFlaky('pipe', 1, outerError);
      const retry = new RetryProvider(provider);

      const result = await retry.sendMessage(MESSAGES);
      expect(result.model).toBe('test-model');
    }, 30_000);
  });

  describe('non-retryable errors', () => {
    test('does not retry generic Error', async () => {
      let callCount = 0;
      const inner = makeProvider('generic', async () => {
        callCount++;
        throw new Error('something unexpected');
      });
      const retry = new RetryProvider(inner);

      await expect(retry.sendMessage(MESSAGES)).rejects.toThrow('something unexpected');
      expect(callCount).toBe(1);
    });

    test('does not retry ProviderError with no status code and no network code', async () => {
      let callCount = 0;
      const inner = makeProvider('no-status', async () => {
        callCount++;
        // ProviderError without statusCode but not a network error — not retryable
        // since isRetryableNetworkError only checks for specific error codes
        throw new ProviderError('unknown provider issue', 'test');
      });
      const retry = new RetryProvider(inner);

      await expect(retry.sendMessage(MESSAGES)).rejects.toThrow('unknown provider issue');
      // ProviderError without statusCode is not retryable by the retry layer
      // (isRetryableError checks for 429/5xx status codes or network error codes)
      expect(callCount).toBe(1);
    });
  });

  describe('passthrough', () => {
    test('preserves provider name', () => {
      const inner = makeProvider('my-provider', async () => okResponse());
      const retry = new RetryProvider(inner);
      expect(retry.name).toBe('my-provider');
    });

    test('forwards options to inner provider', async () => {
      let receivedOptions: unknown;
      const inner: Provider = {
        name: 'spy',
        async sendMessage(_msgs, _tools, _sys, opts) {
          receivedOptions = opts;
          return okResponse();
        },
      };
      const retry = new RetryProvider(inner);
      const options = { config: { temperature: 0.5 } };

      await retry.sendMessage(MESSAGES, undefined, undefined, options);
      expect(receivedOptions).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// FailoverProvider — streaming error handling & model unavailability
// ---------------------------------------------------------------------------

describe('FailoverProvider', () => {
  describe('basic failover', () => {
    test('uses primary when healthy', async () => {
      const primary = makeProvider('primary', async () =>
        okResponse({ model: 'primary-model' }),
      );
      const fallback = makeProvider('fallback', async () =>
        okResponse({ model: 'fallback-model' }),
      );
      const failover = new FailoverProvider([primary, fallback]);

      const result = await failover.sendMessage(MESSAGES);
      expect(result.model).toBe('primary-model');
    });

    test('falls back to secondary on 500 error', async () => {
      const primary = makeProvider('primary', async () => {
        throw new ProviderError('server error', 'primary', 500);
      });
      const fallback = makeProvider('fallback', async () =>
        okResponse({ model: 'fallback-model' }),
      );
      const failover = new FailoverProvider([primary, fallback]);

      const result = await failover.sendMessage(MESSAGES);
      expect(result.model).toBe('fallback-model');
    });

    test('falls back on 429 rate limit', async () => {
      const primary = makeProvider('primary', async () => {
        throw new ProviderError('rate limited', 'primary', 429);
      });
      const fallback = makeProvider('fallback', async () =>
        okResponse({ model: 'fallback-model' }),
      );
      const failover = new FailoverProvider([primary, fallback]);

      const result = await failover.sendMessage(MESSAGES);
      expect(result.model).toBe('fallback-model');
    });

    test('does NOT fall back on 400 client error', async () => {
      const primary = makeProvider('primary', async () => {
        throw new ProviderError('bad request', 'primary', 400);
      });
      const fallback = makeProvider('fallback', async () =>
        okResponse({ model: 'fallback-model' }),
      );
      const failover = new FailoverProvider([primary, fallback]);

      await expect(failover.sendMessage(MESSAGES)).rejects.toThrow('bad request');
    });

    test('does NOT fall back on 403 forbidden', async () => {
      const primary = makeProvider('primary', async () => {
        throw new ProviderError('forbidden', 'primary', 403);
      });
      const fallback = makeProvider('fallback', async () =>
        okResponse({ model: 'fallback-model' }),
      );
      const failover = new FailoverProvider([primary, fallback]);

      await expect(failover.sendMessage(MESSAGES)).rejects.toThrow('forbidden');
    });
  });

  describe('network error failover', () => {
    test('fails over on ECONNRESET', async () => {
      const connErr = new Error('connection reset');
      (connErr as NodeJS.ErrnoException).code = 'ECONNRESET';
      const primary = makeProvider('primary', async () => { throw connErr; });
      const fallback = makeProvider('fallback', async () =>
        okResponse({ model: 'fallback-model' }),
      );
      const failover = new FailoverProvider([primary, fallback]);

      const result = await failover.sendMessage(MESSAGES);
      expect(result.model).toBe('fallback-model');
    });

    test('fails over on ECONNREFUSED', async () => {
      const connErr = new Error('refused');
      (connErr as NodeJS.ErrnoException).code = 'ECONNREFUSED';
      const primary = makeProvider('primary', async () => { throw connErr; });
      const fallback = makeProvider('fallback', async () =>
        okResponse({ model: 'fallback-model' }),
      );
      const failover = new FailoverProvider([primary, fallback]);

      const result = await failover.sendMessage(MESSAGES);
      expect(result.model).toBe('fallback-model');
    });

    test('fails over on ETIMEDOUT', async () => {
      const connErr = new Error('timed out');
      (connErr as NodeJS.ErrnoException).code = 'ETIMEDOUT';
      const primary = makeProvider('primary', async () => { throw connErr; });
      const fallback = makeProvider('fallback', async () =>
        okResponse({ model: 'fallback-model' }),
      );
      const failover = new FailoverProvider([primary, fallback]);

      const result = await failover.sendMessage(MESSAGES);
      expect(result.model).toBe('fallback-model');
    });

    test('fails over when error cause has network code', async () => {
      const inner = new Error('inner');
      (inner as NodeJS.ErrnoException).code = 'EPIPE';
      const outer = new Error('fetch failed', { cause: inner });
      const primary = makeProvider('primary', async () => { throw outer; });
      const fallback = makeProvider('fallback', async () =>
        okResponse({ model: 'fallback-model' }),
      );
      const failover = new FailoverProvider([primary, fallback]);

      const result = await failover.sendMessage(MESSAGES);
      expect(result.model).toBe('fallback-model');
    });

    test('fails over on ProviderError without status code (connection failure)', async () => {
      const primary = makeProvider('primary', async () => {
        throw new ProviderError('connection failed', 'primary');
      });
      const fallback = makeProvider('fallback', async () =>
        okResponse({ model: 'fallback-model' }),
      );
      const failover = new FailoverProvider([primary, fallback]);

      const result = await failover.sendMessage(MESSAGES);
      expect(result.model).toBe('fallback-model');
    });
  });

  describe('all providers unavailable', () => {
    test('throws last error when all providers fail with 500', async () => {
      const p1 = makeProvider('p1', async () => {
        throw new ProviderError('p1 down', 'p1', 500);
      });
      const p2 = makeProvider('p2', async () => {
        throw new ProviderError('p2 down', 'p2', 500);
      });
      const p3 = makeProvider('p3', async () => {
        throw new ProviderError('p3 down', 'p3', 500);
      });
      const failover = new FailoverProvider([p1, p2, p3]);

      await expect(failover.sendMessage(MESSAGES)).rejects.toThrow('p3 down');
    });

    test('throws generic error when all providers are in cooldown', async () => {
      let p1Calls = 0;
      let p2Calls = 0;
      const p1 = makeProvider('p1', async () => {
        p1Calls++;
        throw new ProviderError('p1 down', 'p1', 500);
      });
      const p2 = makeProvider('p2', async () => {
        p2Calls++;
        throw new ProviderError('p2 down', 'p2', 500);
      });
      const failover = new FailoverProvider([p1, p2], 60_000);

      // First call fails both providers, marking them unhealthy
      await expect(failover.sendMessage(MESSAGES)).rejects.toThrow('p2 down');
      expect(p1Calls).toBe(1);
      expect(p2Calls).toBe(1);

      // Second call — both in cooldown, neither is attempted
      await expect(failover.sendMessage(MESSAGES)).rejects.toThrow();
      // Neither should have been called again
      expect(p1Calls).toBe(1);
      expect(p2Calls).toBe(1);
    });
  });

  describe('cooldown and recovery', () => {
    test('marks provider unhealthy on failure and healthy on recovery', async () => {
      let callCount = 0;
      const primary = makeProvider('primary', async () => {
        callCount++;
        if (callCount === 1) throw new ProviderError('down', 'primary', 500);
        return okResponse({ model: 'primary-model' });
      });
      const fallback = makeProvider('fallback', async () =>
        okResponse({ model: 'fallback-model' }),
      );
      // Use very short cooldown so the test doesn't hang
      const failover = new FailoverProvider([primary, fallback], 1);

      // First call: primary fails, fallback succeeds
      const r1 = await failover.sendMessage(MESSAGES);
      expect(r1.model).toBe('fallback-model');

      // Wait for cooldown to expire
      await new Promise((r) => setTimeout(r, 10));

      // Second call: primary should be retried and succeed
      const r2 = await failover.sendMessage(MESSAGES);
      expect(r2.model).toBe('primary-model');
    });

    test('skips provider during cooldown period', async () => {
      let primaryCalls = 0;
      const primary = makeProvider('primary', async () => {
        primaryCalls++;
        throw new ProviderError('down', 'primary', 500);
      });
      const fallback = makeProvider('fallback', async () =>
        okResponse({ model: 'fallback-model' }),
      );
      // Long cooldown
      const failover = new FailoverProvider([primary, fallback], 60_000);

      // First call: primary fails
      await failover.sendMessage(MESSAGES);
      expect(primaryCalls).toBe(1);

      // Second call: primary should be skipped (in cooldown)
      await failover.sendMessage(MESSAGES);
      expect(primaryCalls).toBe(1); // not called again
    });
  });

  describe('streaming event passthrough', () => {
    test('delivers streaming events from fallback when primary fails', async () => {
      const primary = makeProvider('primary', async () => {
        throw new ProviderError('primary down', 'primary', 500);
      });
      const fallback: Provider = {
        name: 'fallback',
        async sendMessage(_msgs, _tools, _sys, opts) {
          opts?.onEvent?.({ type: 'text_delta', text: 'hello ' });
          opts?.onEvent?.({ type: 'text_delta', text: 'world' });
          return okResponse({ model: 'fallback-model' });
        },
      };
      const failover = new FailoverProvider([primary, fallback]);

      const events: ProviderEvent[] = [];
      const result = await failover.sendMessage(
        MESSAGES,
        undefined,
        undefined,
        { onEvent: (e) => events.push(e) },
      );

      expect(result.model).toBe('fallback-model');
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'text_delta', text: 'hello ' });
      expect(events[1]).toEqual({ type: 'text_delta', text: 'world' });
    });

    test('passes abort signal through to fallback provider', async () => {
      const controller = new AbortController();
      const primary = makeProvider('primary', async () => {
        throw new ProviderError('down', 'primary', 500);
      });
      let receivedSignal: AbortSignal | undefined;
      const fallback: Provider = {
        name: 'fallback',
        async sendMessage(_msgs, _tools, _sys, opts) {
          receivedSignal = opts?.signal;
          return okResponse();
        },
      };
      const failover = new FailoverProvider([primary, fallback]);

      await failover.sendMessage(MESSAGES, undefined, undefined, {
        signal: controller.signal,
      });

      expect(receivedSignal).toBe(controller.signal);
    });
  });

  describe('three-provider chain', () => {
    test('cascades through multiple failures to third provider', async () => {
      const p1 = makeProvider('p1', async () => {
        throw new ProviderError('p1 error', 'p1', 500);
      });
      const p2 = makeProvider('p2', async () => {
        throw new ProviderError('p2 error', 'p2', 429);
      });
      const p3 = makeProvider('p3', async () =>
        okResponse({ model: 'p3-model' }),
      );
      const failover = new FailoverProvider([p1, p2, p3]);

      const result = await failover.sendMessage(MESSAGES);
      expect(result.model).toBe('p3-model');
    });

    test('mixed network and server errors cascade correctly', async () => {
      const connErr = new Error('refused');
      (connErr as NodeJS.ErrnoException).code = 'ECONNREFUSED';
      const p1 = makeProvider('p1', async () => { throw connErr; });
      const p2 = makeProvider('p2', async () => {
        throw new ProviderError('overloaded', 'p2', 503);
      });
      const p3 = makeProvider('p3', async () =>
        okResponse({ model: 'p3-model' }),
      );
      const failover = new FailoverProvider([p1, p2, p3]);

      const result = await failover.sendMessage(MESSAGES);
      expect(result.model).toBe('p3-model');
    });
  });

  describe('constructor', () => {
    test('throws when created with no providers', () => {
      expect(() => new FailoverProvider([])).toThrow(
        'FailoverProvider requires at least one provider',
      );
    });

    test('uses first provider name as its own name', () => {
      const p1 = makeProvider('first', async () => okResponse());
      const p2 = makeProvider('second', async () => okResponse());
      const failover = new FailoverProvider([p1, p2]);
      expect(failover.name).toBe('first');
    });
  });
});

// ---------------------------------------------------------------------------
// computeRetryDelay
// ---------------------------------------------------------------------------

describe('computeRetryDelay', () => {
  test('returns value between cap/2 and cap for attempt 0', () => {
    const base = 1000;
    for (let i = 0; i < 50; i++) {
      const delay = computeRetryDelay(0, base);
      // cap = 1000 * 2^0 = 1000, half = 500
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThan(1000);
    }
  });

  test('returns value between cap/2 and cap for attempt 2', () => {
    const base = 1000;
    for (let i = 0; i < 50; i++) {
      const delay = computeRetryDelay(2, base);
      // cap = 1000 * 2^2 = 4000, half = 2000
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThan(4000);
    }
  });

  test('delays grow exponentially', () => {
    const base = 100;
    // Use 50 samples to reduce flakiness from jitter
    const avg = (attempt: number) => {
      let sum = 0;
      const n = 50;
      for (let i = 0; i < n; i++) sum += computeRetryDelay(attempt, base);
      return sum / n;
    };
    const avg0 = avg(0);
    const avg1 = avg(1);
    const avg2 = avg(2);
    // Each attempt should roughly double
    expect(avg1).toBeGreaterThan(avg0 * 1.5);
    expect(avg2).toBeGreaterThan(avg1 * 1.5);
  });
});

// ---------------------------------------------------------------------------
// RetryProvider + FailoverProvider composition
// ---------------------------------------------------------------------------

describe('RetryProvider + FailoverProvider composition', () => {
  test('retry wraps individual providers inside failover', async () => {
    // Simulate the real initialization pattern: each provider wrapped in retry,
    // then composed in failover
    let p1Calls = 0;
    const p1Inner: Provider = {
      name: 'p1',
      async sendMessage() {
        p1Calls++;
        throw new ProviderError('p1 always fails', 'p1', 500);
      },
    };
    const p1Retry = new RetryProvider(p1Inner);

    const p2Inner: Provider = {
      name: 'p2',
      async sendMessage() {
        return okResponse({ model: 'p2-model' });
      },
    };
    const p2Retry = new RetryProvider(p2Inner);

    const failover = new FailoverProvider([p1Retry, p2Retry]);

    const result = await failover.sendMessage(MESSAGES);
    expect(result.model).toBe('p2-model');
    // p1 should have been retried DEFAULT_MAX_RETRIES + 1 times before failover
    expect(p1Calls).toBe(DEFAULT_MAX_RETRIES + 1);
  }, 30_000);
});
