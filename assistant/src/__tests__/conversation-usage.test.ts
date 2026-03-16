import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "session-usage-test-"));

const updateConversationUsageCalls: Array<{
  conversationId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}> = [];

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    pricingOverrides: [],
  }),
}));

mock.module("../memory/conversation-crud.js", () => ({
  updateConversationUsage: (
    conversationId: string,
    inputTokens: number,
    outputTokens: number,
    estimatedCost: number,
  ) => {
    updateConversationUsageCalls.push({
      conversationId,
      inputTokens,
      outputTokens,
      estimatedCost,
    });
  },
}));

import { recordUsage } from "../daemon/conversation-usage.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { listUsageEvents } from "../memory/llm-usage-store.js";
import type { PricingUsage } from "../usage/types.js";
import { resolvePricingForUsageWithOverrides } from "../util/pricing.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

describe("recordUsage", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
    updateConversationUsageCalls.length = 0;
  });

  test("stores direct input separately from Anthropic cache usage while keeping live totals combined", () => {
    const usageStats = {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
    };
    const onEventMessages: unknown[] = [];

    const rawResponses = [
      {
        usage: {
          cache_creation: {
            ephemeral_5m_input_tokens: 173_619,
          },
        },
      },
      {
        usage: {
          cache_creation: {
            ephemeral_1h_input_tokens: 200_000,
          },
        },
      },
    ];

    recordUsage(
      {
        conversationId: "conv-usage-1",
        providerName: "anthropic",
        usageStats,
      },
      3_420_218,
      11_768,
      "claude-opus-4-6",
      (msg) => onEventMessages.push(msg),
      "main_agent",
      "req-usage-1",
      373_619,
      3_046_461,
      rawResponses,
    );

    const events = listUsageEvents();
    expect(events).toHaveLength(1);

    const expectedUsage: PricingUsage = {
      directInputTokens: 138,
      outputTokens: 11_768,
      cacheCreationInputTokens: 373_619,
      cacheReadInputTokens: 3_046_461,
      anthropicCacheCreation: {
        ephemeral_5m_input_tokens: 173_619,
        ephemeral_1h_input_tokens: 200_000,
      },
    };
    const expectedPricing = resolvePricingForUsageWithOverrides(
      "anthropic",
      "claude-opus-4-6",
      expectedUsage,
      [],
    );

    expect(events[0].conversationId).toBe("conv-usage-1");
    expect(events[0].requestId).toBe("req-usage-1");
    expect(events[0].inputTokens).toBe(138);
    expect(events[0].outputTokens).toBe(11_768);
    expect(events[0].cacheCreationInputTokens).toBe(373_619);
    expect(events[0].cacheReadInputTokens).toBe(3_046_461);
    expect(events[0].pricingStatus).toBe("priced");
    expect(events[0].estimatedCostUsd).toBe(
      expectedPricing.estimatedCostUsd ?? null,
    );

    expect(usageStats.inputTokens).toBe(3_420_218);
    expect(usageStats.outputTokens).toBe(11_768);
    expect(usageStats.estimatedCost).toBe(
      expectedPricing.estimatedCostUsd ?? 0,
    );

    expect(updateConversationUsageCalls).toEqual([
      {
        conversationId: "conv-usage-1",
        inputTokens: 3_420_218,
        outputTokens: 11_768,
        estimatedCost: expectedPricing.estimatedCostUsd ?? 0,
      },
    ]);

    expect(onEventMessages).toEqual([
      {
        type: "usage_update",
        inputTokens: 3_420_218,
        outputTokens: 11_768,
        totalInputTokens: 3_420_218,
        totalOutputTokens: 11_768,
        estimatedCost: expectedPricing.estimatedCostUsd ?? 0,
        model: "claude-opus-4-6",
      },
    ]);
  });
});
