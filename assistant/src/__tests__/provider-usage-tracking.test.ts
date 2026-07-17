import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { listUsageEvents } from "../persistence/llm-usage-store.js";
import { CallSiteConfiguredProvider } from "../providers/provider-send-message.js";
import type { Provider, ProviderResponse } from "../providers/types.js";
import { UsageTrackingProvider } from "../providers/usage-tracking.js";
import { setConfig } from "./helpers/set-config.js";

await initializeDb();

// Seed `llm` into the real workspace config; the loader schema-merges the
// raw partial over defaults exactly as `LLMSchema.parse` did for the mock.
function setLlmConfig(raw: unknown): void {
  setConfig("llm", raw);
}

function makeProvider(response: ProviderResponse): Provider {
  return {
    name: "openai",
    async sendMessage() {
      return response;
    },
  };
}

describe("UsageTrackingProvider", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
    setLlmConfig({
      profiles: {
        // User-owned shadow of the default profile name: carries its own
        // provider+model so it is a usable single-winner selection.
        balanced: {
          provider: "openai",
          model: "gpt-5.4-mini",
        },
      },
      activeProfile: "balanced",
      // Pin the non-main-agent call site to the same profile — activeProfile
      // only applies to mainAgent under single-winner selection.
      callSites: {
        conversationTitle: { profile: "balanced" },
      },
      pricingOverrides: [],
    });
  });

  test("auto-records attributed non-conversation provider usage", async () => {
    const provider = new UsageTrackingProvider(
      makeProvider({
        content: [{ type: "text", text: "Title" }],
        model: "gpt-5.4-mini",
        usage: {
          inputTokens: 1_000,
          outputTokens: 2_000,
        },
        stopReason: "end_turn",
      }),
    );

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Summarize" }] }],
      {
        config: {
          callSite: "conversationTitle",
        },
      },
    );

    const events = listUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "llm_call_site",
      conversationId: null,
      runId: null,
      requestId: null,
      provider: "openai",
      model: "gpt-5.4-mini",
      inputTokens: 1_000,
      outputTokens: 2_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      callSite: "conversationTitle",
      inferenceProfile: "balanced",
      inferenceProfileSource: "call_site",
      pricingStatus: "priced",
    });
    expect(events[0].estimatedCostUsd ?? 0).toBeCloseTo(0.00975, 10);
  });

  test("uses the transport provider when resolved attribution points elsewhere", async () => {
    setLlmConfig({
      callSites: {
        conversationTitle: {
          provider: "fireworks",
          model: "accounts/fireworks/models/deepseek-v3",
        },
      },
      pricingOverrides: [],
    });

    const provider = new UsageTrackingProvider(
      makeProvider({
        content: [{ type: "text", text: "Title" }],
        model: "gpt-5.4-mini",
        usage: {
          inputTokens: 1_000,
          outputTokens: 2_000,
        },
        stopReason: "end_turn",
      }),
    );

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Summarize" }] }],
      {
        config: {
          callSite: "conversationTitle",
        },
      },
    );

    const events = listUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
      callSite: "conversationTitle",
      pricingStatus: "priced",
    });
  });

  test("does not record calls without a call site", async () => {
    const provider = new UsageTrackingProvider(
      makeProvider({
        content: [{ type: "text", text: "ok" }],
        model: "gpt-5.4-mini",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
        },
        stopReason: "end_turn",
      }),
    );

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);

    expect(listUsageEvents()).toHaveLength(0);
  });

  test("records calls from providers resolved for a call site even when send options omit it", async () => {
    const provider = new CallSiteConfiguredProvider(
      new UsageTrackingProvider(
        makeProvider({
          content: [{ type: "text", text: "ok" }],
          model: "gpt-5.4-mini",
          usage: {
            inputTokens: 100,
            outputTokens: 50,
          },
          stopReason: "end_turn",
        }),
      ),
      "mainAgent",
    );

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      {
        config: {
          model: "gpt-5.4-mini",
        },
      },
    );

    const events = listUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      callSite: "mainAgent",
      provider: "openai",
      model: "gpt-5.4-mini",
    });
  });
});

describe("native web-search capability survives the wrapper chain", () => {
  function leaf(supports: boolean | undefined): Provider {
    return {
      name: "anthropic",
      ...(supports === undefined ? {} : { supportsNativeWebSearch: supports }),
      async sendMessage(): Promise<ProviderResponse> {
        return {
          content: [{ type: "text", text: "" }],
          model: "m",
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "end_turn",
        };
      },
    };
  }

  test("UsageTrackingProvider forwards supportsNativeWebSearch", () => {
    expect(new UsageTrackingProvider(leaf(true)).supportsNativeWebSearch).toBe(
      true,
    );
    expect(new UsageTrackingProvider(leaf(false)).supportsNativeWebSearch).toBe(
      false,
    );
    expect(
      new UsageTrackingProvider(leaf(undefined)).supportsNativeWebSearch,
    ).toBeUndefined();
  });

  test("CallSiteConfiguredProvider forwards it through a nested wrapper", () => {
    // The exact chain getConfiguredProvider returns: CallSiteConfigured →
    // UsageTracking → leaf. The advisor consult reads the flag off the top.
    const wrapped = new CallSiteConfiguredProvider(
      new UsageTrackingProvider(leaf(true)),
      "subagentSpawn",
    );
    expect(wrapped.supportsNativeWebSearch).toBe(true);
  });
});
