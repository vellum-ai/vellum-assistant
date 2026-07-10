/**
 * The production conversation provider is wrapped (CallSiteRouting → RateLimit
 * → Retry → UsageTracking → adapter). `Provider.countInputTokens` is optional,
 * so each wrapper must forward it or the capability is lost partway up the
 * chain and `/compact` silently falls back to the local estimate. These tests
 * pin the forwarding.
 */
import { describe, expect, test } from "bun:test";

import { CallSiteRoutingProvider } from "../call-site-routing.js";
import { RateLimitProvider } from "../ratelimit.js";
import { RetryProvider } from "../retry.js";
import type { Message, Provider } from "../types.js";
import { UsageTrackingProvider } from "../usage-tracking.js";

function providerWithCount(): Provider {
  return {
    name: "inner",
    sendMessage: async () => ({
      content: [],
      model: "m",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "end_turn",
    }),
    countInputTokens: async () => 4242,
  };
}

function providerWithoutCount(): Provider {
  const p = providerWithCount();
  delete p.countInputTokens;
  return p;
}

const msgs: Message[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
];

const wrappers: Array<[string, (inner: Provider) => Provider]> = [
  ["RetryProvider", (inner) => new RetryProvider(inner)],
  ["UsageTrackingProvider", (inner) => new UsageTrackingProvider(inner)],
  [
    "RateLimitProvider",
    (inner) => new RateLimitProvider(inner, { maxRequestsPerMinute: 0 }),
  ],
  [
    "CallSiteRoutingProvider",
    (inner) => new CallSiteRoutingProvider(inner, async () => null),
  ],
];

describe("countInputTokens forwarding through provider wrappers", () => {
  for (const [name, wrap] of wrappers) {
    test(`${name} forwards the count when the inner provider supports it`, async () => {
      const wrapped = wrap(providerWithCount());
      expect(typeof wrapped.countInputTokens).toBe("function");
      expect(await wrapped.countInputTokens!(msgs, "sys", undefined)).toBe(
        4242,
      );
    });

    test(`${name} omits the count when the inner provider lacks it`, () => {
      const wrapped = wrap(providerWithoutCount());
      expect(wrapped.countInputTokens).toBeUndefined();
    });
  }

  test("capability survives the full nested wrapper chain", () => {
    const chain = new CallSiteRoutingProvider(
      new RateLimitProvider(
        new RetryProvider(new UsageTrackingProvider(providerWithCount())),
        { maxRequestsPerMinute: 0 },
      ),
      async () => null,
    );
    expect(typeof chain.countInputTokens).toBe("function");
  });
});
