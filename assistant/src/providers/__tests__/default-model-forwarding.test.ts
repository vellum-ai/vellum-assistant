/**
 * The production conversation provider is wrapped (CallSiteConfigured →
 * CallSiteRouting → RateLimit → Retry → UsageTracking → adapter), and the
 * local token estimator reads `Provider.defaultModel` off the outermost
 * wrapper for model-keyed rules such as the Claude vision tier. The field is
 * optional, so each wrapper must forward it or every estimate silently falls
 * back to the model-agnostic rules. These tests pin the forwarding.
 */
import { describe, expect, test } from "bun:test";

import { AnthropicProvider } from "../anthropic/client.js";
import { CallSiteRoutingProvider } from "../call-site-routing.js";
import { CallSiteConfiguredProvider } from "../provider-send-message.js";
import { RateLimitProvider } from "../ratelimit.js";
import { RetryProvider } from "../retry.js";
import type { Provider } from "../types.js";
import { UsageTrackingProvider } from "../usage-tracking.js";

function adapter(defaultModel: string | undefined): Provider {
  return {
    name: "inner",
    ...(defaultModel === undefined ? {} : { defaultModel }),
    sendMessage: async () => ({
      content: [],
      model: "m",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "end_turn",
    }),
  };
}

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
  [
    "CallSiteConfiguredProvider",
    (inner) => new CallSiteConfiguredProvider(inner, "mainAgent"),
  ],
];

describe("defaultModel forwarding through provider wrappers", () => {
  for (const [name, wrap] of wrappers) {
    test(`${name} forwards the inner provider's default model`, () => {
      expect(wrap(adapter("claude-opus-4-8")).defaultModel).toBe(
        "claude-opus-4-8",
      );
      expect(wrap(adapter(undefined)).defaultModel).toBeUndefined();
    });
  }

  test("the model survives the full nested wrapper chain", () => {
    const chain = new CallSiteConfiguredProvider(
      new CallSiteRoutingProvider(
        new RateLimitProvider(
          new RetryProvider(
            new UsageTrackingProvider(adapter("claude-opus-4-8")),
          ),
          { maxRequestsPerMinute: 0 },
        ),
        async () => null,
      ),
      "mainAgent",
    );
    expect(chain.defaultModel).toBe("claude-opus-4-8");
  });

  test("the Anthropic adapter exposes its configured model", () => {
    expect(
      new AnthropicProvider("test-key", "claude-opus-4-8").defaultModel,
    ).toBe("claude-opus-4-8");
  });
});
