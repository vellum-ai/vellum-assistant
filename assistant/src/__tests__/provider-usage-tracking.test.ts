import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

let mockLlmConfig: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    llm: mockLlmConfig,
  }),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import { LLMSchema } from "../config/schemas/llm.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { listUsageEvents } from "../memory/llm-usage-store.js";
import type { Provider, ProviderResponse } from "../providers/types.js";
import { UsageTrackingProvider } from "../providers/usage-tracking.js";

initializeDb();

function setLlmConfig(raw: unknown): void {
  mockLlmConfig = LLMSchema.parse(raw) as Record<string, unknown>;
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
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
      },
      profiles: {
        balanced: {
          provider: "openai",
          model: "gpt-5.4-mini",
        },
      },
      activeProfile: "balanced",
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
      undefined,
      undefined,
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
      inferenceProfileSource: "active",
      pricingStatus: "priced",
    });
    expect(events[0].estimatedCostUsd ?? 0).toBeCloseTo(0.0065, 10);
  });

  test("uses the transport provider when resolved attribution points elsewhere", async () => {
    setLlmConfig({
      default: {
        provider: "openai",
        model: "gpt-5.4-mini",
      },
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
      undefined,
      undefined,
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
});
