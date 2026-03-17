import { describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { RateLimitConfig } from "../config/types.js";
import { RateLimitProvider } from "../providers/ratelimit.js";
import type {
  Message,
  Provider,
  ProviderResponse,
} from "../providers/types.js";
import { RateLimitError } from "../util/errors.js";

function makeProvider(response?: Partial<ProviderResponse>): Provider {
  return {
    name: "mock",
    sendMessage: async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      model: "test-model",
      usage: { inputTokens: 100, outputTokens: 50 },
      stopReason: "end_turn",
      ...response,
    }),
  };
}

const messages: Message[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
];

describe("RateLimitProvider", () => {
  describe("request rate limiting", () => {
    test("allows requests under the limit", async () => {
      const config: RateLimitConfig = {
        maxRequestsPerMinute: 5,
      };
      const provider = new RateLimitProvider(makeProvider(), config);

      for (let i = 0; i < 5; i++) {
        await provider.sendMessage(messages);
      }
    });

    test("throws RateLimitError when exceeding request limit", async () => {
      const config: RateLimitConfig = {
        maxRequestsPerMinute: 2,
      };
      const provider = new RateLimitProvider(makeProvider(), config);

      await provider.sendMessage(messages);
      await provider.sendMessage(messages);

      expect(provider.sendMessage(messages)).rejects.toThrow(RateLimitError);
    });

    test("unlimited when maxRequestsPerMinute is 0", async () => {
      const config: RateLimitConfig = {
        maxRequestsPerMinute: 0,
      };
      const provider = new RateLimitProvider(makeProvider(), config);

      for (let i = 0; i < 100; i++) {
        await provider.sendMessage(messages);
      }
    });
  });

  describe("passthrough behavior", () => {
    test("delegates to inner provider", async () => {
      const config: RateLimitConfig = {
        maxRequestsPerMinute: 0,
      };
      const inner = makeProvider({ model: "custom-model" });
      const provider = new RateLimitProvider(inner, config);

      const response = await provider.sendMessage(messages);
      expect(response.model).toBe("custom-model");
    });

    test("preserves provider name", () => {
      const config: RateLimitConfig = {
        maxRequestsPerMinute: 0,
      };
      const provider = new RateLimitProvider(makeProvider(), config);
      expect(provider.name).toBe("mock");
    });

    test("passes through all arguments to inner provider", async () => {
      const config: RateLimitConfig = {
        maxRequestsPerMinute: 0,
      };
      let receivedArgs: unknown[] = [];
      const inner: Provider = {
        name: "spy",
        sendMessage: async (...args) => {
          receivedArgs = args;
          return {
            content: [{ type: "text" as const, text: "" }],
            model: "test",
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "end_turn",
          };
        },
      };
      const provider = new RateLimitProvider(inner, config);

      const tools = [{ name: "test", description: "test", input_schema: {} }];
      const systemPrompt = "hello";
      const options = { config: { max_tokens: 100 } };

      await provider.sendMessage(messages, tools, systemPrompt, options);

      expect(receivedArgs[0]).toBe(messages);
      expect(receivedArgs[1]).toBe(tools);
      expect(receivedArgs[2]).toBe(systemPrompt);
      expect(receivedArgs[3]).toBe(options);
    });
  });

  describe("shared request timestamps", () => {
    test("multiple providers sharing timestamps enforce a global rate limit", async () => {
      const config: RateLimitConfig = {
        maxRequestsPerMinute: 2,
      };
      const shared: number[] = [];
      const provider1 = new RateLimitProvider(makeProvider(), config, shared);
      const provider2 = new RateLimitProvider(makeProvider(), config, shared);

      // Each provider sends one request — together they hit the limit of 2
      await provider1.sendMessage(messages);
      await provider2.sendMessage(messages);

      // A third request from either provider should be rate-limited
      await expect(provider1.sendMessage(messages)).rejects.toThrow(
        RateLimitError,
      );
      await expect(provider2.sendMessage(messages)).rejects.toThrow(
        RateLimitError,
      );
    });

    test("out-of-order timestamps are pruned correctly (clock skew)", async () => {
      const config: RateLimitConfig = {
        maxRequestsPerMinute: 3,
      };
      const shared: number[] = [];
      const provider = new RateLimitProvider(makeProvider(), config, shared);

      // Simulate clock skew: insert an old timestamp between newer ones
      const now = Date.now();
      shared.push(now); // current
      shared.push(now - 120_000); // 2 minutes ago (expired)
      shared.push(now); // current

      // enforceRequestRate should prune the expired entry regardless of position
      await provider.sendMessage(messages);

      // 2 fresh timestamps from before + 1 from the new call = 3 (the expired one was removed)
      expect(shared.length).toBe(3);
    });

    test("waitSec uses actual oldest timestamp under clock skew", async () => {
      const config: RateLimitConfig = {
        maxRequestsPerMinute: 2,
      };
      const shared: number[] = [];
      const provider = new RateLimitProvider(makeProvider(), config, shared);

      // Simulate out-of-order timestamps: newer one first, older one second
      const now = Date.now();
      shared.push(now); // newest
      shared.push(now - 30_000); // 30s ago (oldest in window)

      // Next request should be rate-limited with ~30s wait (not 60s)
      try {
        await provider.sendMessage(messages);
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        const msg = (err as RateLimitError).message;
        // Wait time should be ~30s, not 60s
        const waitMatch = msg.match(/(\d+)s/);
        expect(waitMatch).toBeTruthy();
        const waitSec = parseInt(waitMatch![1], 10);
        expect(waitSec).toBeLessThanOrEqual(31);
        expect(waitSec).toBeGreaterThanOrEqual(29);
      }
    });

    test("handles large timestamp arrays without stack overflow", async () => {
      const highLimit = 200_000;
      const config: RateLimitConfig = {
        maxRequestsPerMinute: highLimit,
      };
      const shared: number[] = [];
      const provider = new RateLimitProvider(makeProvider(), config, shared);

      // Fill with timestamps that are all within the window
      const now = Date.now();
      for (let i = 0; i < highLimit; i++) {
        shared.push(now - Math.floor(Math.random() * 59_000));
      }

      // This should throw RateLimitError, not RangeError
      await expect(provider.sendMessage(messages)).rejects.toThrow(
        RateLimitError,
      );
    });

    test("shared array reference survives pruning", async () => {
      const config: RateLimitConfig = {
        maxRequestsPerMinute: 100,
      };
      const shared: number[] = [];
      const provider1 = new RateLimitProvider(makeProvider(), config, shared);
      const provider2 = new RateLimitProvider(makeProvider(), config, shared);

      // Provider 1 sends a request, adding a timestamp to the shared array
      await provider1.sendMessage(messages);
      expect(shared.length).toBe(1);

      // Provider 2 sends a request — enforceRequestRate prunes expired
      // entries, but the shared reference must still be the same array
      await provider2.sendMessage(messages);
      expect(shared.length).toBe(2);

      // Both providers still share the same underlying array
      await provider1.sendMessage(messages);
      expect(shared.length).toBe(3);
    });
  });

  describe("race condition prevention", () => {
    test("concurrent calls are rate-limited because timestamp is recorded before await", async () => {
      const config: RateLimitConfig = {
        maxRequestsPerMinute: 1,
      };
      // Slow provider that yields to the event loop
      const inner: Provider = {
        name: "slow",
        sendMessage: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return {
            content: [{ type: "text" as const, text: "" }],
            model: "test",
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "end_turn",
          };
        },
      };
      const provider = new RateLimitProvider(inner, config);

      // Fire two concurrent requests — second should fail
      const results = await Promise.allSettled([
        provider.sendMessage(messages),
        provider.sendMessage(messages),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
    });

    test("failed inner calls still count toward request rate", async () => {
      const config: RateLimitConfig = {
        maxRequestsPerMinute: 1,
      };
      const inner: Provider = {
        name: "failing",
        sendMessage: async () => {
          throw new Error("provider error");
        },
      };
      const provider = new RateLimitProvider(inner, config);

      // First call fails at the provider level
      await expect(provider.sendMessage(messages)).rejects.toThrow(
        "provider error",
      );

      // Second call should be rate-limited (timestamp was recorded before the failed await)
      await expect(provider.sendMessage(messages)).rejects.toThrow(
        RateLimitError,
      );
    });
  });
});
