import { describe, test, expect, mock } from 'bun:test';

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

import { RateLimitProvider } from '../providers/ratelimit.js';
import { RateLimitError } from '../util/errors.js';
import type { Provider, ProviderResponse, Message } from '../providers/types.js';
import type { RateLimitConfig } from '../config/types.js';

function makeProvider(response?: Partial<ProviderResponse>): Provider {
  return {
    name: 'mock',
    sendMessage: async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      model: 'test-model',
      usage: { inputTokens: 100, outputTokens: 50 },
      stopReason: 'end_turn',
      ...response,
    }),
  };
}

const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];

describe('RateLimitProvider', () => {
  describe('request rate limiting', () => {
    test('allows requests under the limit', async () => {
      const config: RateLimitConfig = { maxRequestsPerMinute: 5, maxTokensPerSession: 0 };
      const provider = new RateLimitProvider(makeProvider(), config);

      for (let i = 0; i < 5; i++) {
        await provider.sendMessage(messages);
      }
    });

    test('throws RateLimitError when exceeding request limit', async () => {
      const config: RateLimitConfig = { maxRequestsPerMinute: 2, maxTokensPerSession: 0 };
      const provider = new RateLimitProvider(makeProvider(), config);

      await provider.sendMessage(messages);
      await provider.sendMessage(messages);

      expect(provider.sendMessage(messages)).rejects.toThrow(RateLimitError);
    });

    test('unlimited when maxRequestsPerMinute is 0', async () => {
      const config: RateLimitConfig = { maxRequestsPerMinute: 0, maxTokensPerSession: 0 };
      const provider = new RateLimitProvider(makeProvider(), config);

      for (let i = 0; i < 100; i++) {
        await provider.sendMessage(messages);
      }
    });
  });

  describe('session token limiting', () => {
    test('allows requests under the token budget', async () => {
      const config: RateLimitConfig = { maxRequestsPerMinute: 0, maxTokensPerSession: 1000 };
      const provider = new RateLimitProvider(makeProvider(), config);

      // Each call uses 150 tokens (100 input + 50 output)
      for (let i = 0; i < 6; i++) {
        await provider.sendMessage(messages);
      }
      // 6 * 150 = 900, still under 1000
    });

    test('throws RateLimitError when token budget exhausted', async () => {
      const config: RateLimitConfig = { maxRequestsPerMinute: 0, maxTokensPerSession: 300 };
      const provider = new RateLimitProvider(makeProvider(), config);

      // 150 tokens per call
      await provider.sendMessage(messages); // 150
      await provider.sendMessage(messages); // 300

      expect(provider.sendMessage(messages)).rejects.toThrow(RateLimitError);
    });

    test('unlimited when maxTokensPerSession is 0', async () => {
      const config: RateLimitConfig = { maxRequestsPerMinute: 0, maxTokensPerSession: 0 };
      const provider = new RateLimitProvider(
        makeProvider({ usage: { inputTokens: 10000, outputTokens: 10000 } }),
        config,
      );

      for (let i = 0; i < 10; i++) {
        await provider.sendMessage(messages);
      }
    });
  });

  describe('passthrough behavior', () => {
    test('delegates to inner provider', async () => {
      const config: RateLimitConfig = { maxRequestsPerMinute: 0, maxTokensPerSession: 0 };
      const inner = makeProvider({ model: 'custom-model' });
      const provider = new RateLimitProvider(inner, config);

      const response = await provider.sendMessage(messages);
      expect(response.model).toBe('custom-model');
    });

    test('preserves provider name', () => {
      const config: RateLimitConfig = { maxRequestsPerMinute: 0, maxTokensPerSession: 0 };
      const provider = new RateLimitProvider(makeProvider(), config);
      expect(provider.name).toBe('mock');
    });

    test('passes through all arguments to inner provider', async () => {
      const config: RateLimitConfig = { maxRequestsPerMinute: 0, maxTokensPerSession: 0 };
      let receivedArgs: unknown[] = [];
      const inner: Provider = {
        name: 'spy',
        sendMessage: async (...args) => {
          receivedArgs = args;
          return {
            content: [{ type: 'text' as const, text: '' }],
            model: 'test',
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: 'end_turn',
          };
        },
      };
      const provider = new RateLimitProvider(inner, config);

      const tools = [{ name: 'test', description: 'test', input_schema: {} }];
      const systemPrompt = 'hello';
      const options = { config: { max_tokens: 100 } };

      await provider.sendMessage(messages, tools, systemPrompt, options);

      expect(receivedArgs[0]).toBe(messages);
      expect(receivedArgs[1]).toBe(tools);
      expect(receivedArgs[2]).toBe(systemPrompt);
      expect(receivedArgs[3]).toBe(options);
    });
  });

  describe('combined limits', () => {
    test('enforces both limits simultaneously', async () => {
      const config: RateLimitConfig = { maxRequestsPerMinute: 10, maxTokensPerSession: 300 };
      const provider = new RateLimitProvider(makeProvider(), config);

      // Token limit should hit first (2 * 150 = 300)
      await provider.sendMessage(messages);
      await provider.sendMessage(messages);

      expect(provider.sendMessage(messages)).rejects.toThrow(RateLimitError);
    });
  });

  describe('race condition prevention', () => {
    test('concurrent calls are rate-limited because timestamp is recorded before await', async () => {
      const config: RateLimitConfig = { maxRequestsPerMinute: 1, maxTokensPerSession: 0 };
      // Slow provider that yields to the event loop
      const inner: Provider = {
        name: 'slow',
        sendMessage: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return {
            content: [{ type: 'text' as const, text: '' }],
            model: 'test',
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: 'end_turn',
          };
        },
      };
      const provider = new RateLimitProvider(inner, config);

      // Fire two concurrent requests — second should fail
      const results = await Promise.allSettled([
        provider.sendMessage(messages),
        provider.sendMessage(messages),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
    });

    test('failed inner calls still count toward request rate', async () => {
      const config: RateLimitConfig = { maxRequestsPerMinute: 1, maxTokensPerSession: 0 };
      const inner: Provider = {
        name: 'failing',
        sendMessage: async () => { throw new Error('provider error'); },
      };
      const provider = new RateLimitProvider(inner, config);

      // First call fails at the provider level
      await expect(provider.sendMessage(messages)).rejects.toThrow('provider error');

      // Second call should be rate-limited (timestamp was recorded before the failed await)
      await expect(provider.sendMessage(messages)).rejects.toThrow(RateLimitError);
    });
  });
});
