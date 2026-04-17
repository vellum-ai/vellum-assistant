import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockPricingOverrides: Array<{
  provider: string;
  modelPattern: string;
  inputPer1M: number;
  outputPer1M: number;
}> = [];

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    llm: {
      pricingOverrides: mockPricingOverrides,
    },
  }),
}));

import {
  getDb,
  getSqlite,
  initializeDb,
  rawGet,
  rawRun,
} from "../memory/db.js";
import { migrateBackfillUsageCacheAccounting } from "../memory/migrations/140-backfill-usage-cache-accounting.js";
import type { PricingUsage } from "../usage/types.js";
import {
  resolvePricing,
  resolvePricingForUsageWithOverrides,
} from "../util/pricing.js";

initializeDb();

const CHECKPOINT_KEY = "migration_backfill_usage_cache_accounting_v1";

interface UsageEventRow {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  estimated_cost_usd: number | null;
  pricing_status: string;
}

function insertUsageEvent(args: {
  id: string;
  conversationId: string;
  createdAt: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  estimatedCostUsd: number | null;
  pricingStatus?: string;
}): void {
  rawRun(
    /*sql*/ `
    INSERT INTO llm_usage_events (
      id,
      created_at,
      conversation_id,
      run_id,
      request_id,
      actor,
      provider,
      model,
      input_tokens,
      output_tokens,
      cache_creation_input_tokens,
      cache_read_input_tokens,
      estimated_cost_usd,
      pricing_status,
      metadata_json
    ) VALUES (?, ?, ?, NULL, NULL, 'main_agent', 'anthropic', ?, ?, ?, ?, ?, ?, ?, NULL)
    `,
    args.id,
    args.createdAt,
    args.conversationId,
    args.model,
    args.inputTokens,
    args.outputTokens,
    args.cacheCreationInputTokens ?? null,
    args.cacheReadInputTokens ?? null,
    args.estimatedCostUsd,
    args.pricingStatus ?? "priced",
  );
}

function insertRequestLog(args: {
  id: string;
  conversationId: string;
  createdAt: number;
  responsePayload: string;
}): void {
  rawRun(
    /*sql*/ `
    INSERT INTO llm_request_logs (
      id,
      conversation_id,
      request_payload,
      response_payload,
      created_at
    ) VALUES (?, ?, '{}', ?, ?)
    `,
    args.id,
    args.conversationId,
    args.responsePayload,
    args.createdAt,
  );
}

function anthropicResponsePayload(args: {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  ephemeral5mInputTokens?: number;
  ephemeral1hInputTokens?: number;
}): string {
  return JSON.stringify({
    usage: {
      input_tokens: args.inputTokens,
      output_tokens: args.outputTokens,
      cache_read_input_tokens: args.cacheReadInputTokens ?? 0,
      cache_creation: {
        ephemeral_5m_input_tokens: args.ephemeral5mInputTokens ?? 0,
        ephemeral_1h_input_tokens: args.ephemeral1hInputTokens ?? 0,
      },
    },
  });
}

function foreignResponsePayload(): string {
  return JSON.stringify({
    usage: {
      prompt_tokens: 321,
      completion_tokens: 54,
    },
  });
}

describe("migrateBackfillUsageCacheAccounting", () => {
  beforeEach(() => {
    getSqlite().run(`DELETE FROM llm_request_logs`);
    getSqlite().run(`DELETE FROM llm_usage_events`);
    rawRun(`DELETE FROM memory_checkpoints WHERE key = ?`, CHECKPOINT_KEY);
    mockPricingOverrides = [];
  });

  test("rewrites historical Anthropic rows from request logs, ignores foreign logs, and leaves missing-log rows unchanged", () => {
    const model = "claude-opus-4-6";

    insertUsageEvent({
      id: "usage-prev",
      conversationId: "conv-usage-1",
      createdAt: 1_000,
      model,
      inputTokens: 700,
      outputTokens: 70,
      estimatedCostUsd:
        resolvePricing("anthropic", model, 700, 70).estimatedCostUsd ?? 0,
    });
    insertRequestLog({
      id: "log-prev",
      conversationId: "conv-usage-1",
      createdAt: 900,
      responsePayload: anthropicResponsePayload({
        inputTokens: 500,
        outputTokens: 70,
        cacheReadInputTokens: 100,
        ephemeral5mInputTokens: 100,
      }),
    });

    const flattenedHistoricalCost =
      resolvePricing("anthropic", model, 3_420_218, 11_768).estimatedCostUsd ??
      0;
    insertUsageEvent({
      id: "usage-target",
      conversationId: "conv-usage-1",
      createdAt: 3_000,
      model,
      inputTokens: 3_420_218,
      outputTokens: 11_768,
      estimatedCostUsd: flattenedHistoricalCost,
    });
    insertRequestLog({
      id: "log-target-1",
      conversationId: "conv-usage-1",
      createdAt: 1_500,
      responsePayload: anthropicResponsePayload({
        inputTokens: 100,
        outputTokens: 6_000,
        cacheReadInputTokens: 1_523_230,
        ephemeral5mInputTokens: 173_619,
      }),
    });
    insertRequestLog({
      id: "log-target-foreign",
      conversationId: "conv-usage-1",
      createdAt: 2_000,
      responsePayload: foreignResponsePayload(),
    });
    insertRequestLog({
      id: "log-target-2",
      conversationId: "conv-usage-1",
      createdAt: 2_500,
      responsePayload: anthropicResponsePayload({
        inputTokens: 38,
        outputTokens: 5_768,
        cacheReadInputTokens: 1_523_231,
        ephemeral1hInputTokens: 200_000,
      }),
    });

    const noLogCost =
      resolvePricing("anthropic", model, 1_234, 56).estimatedCostUsd ?? 0;
    insertUsageEvent({
      id: "usage-no-logs",
      conversationId: "conv-usage-2",
      createdAt: 4_000,
      model,
      inputTokens: 1_234,
      outputTokens: 56,
      estimatedCostUsd: noLogCost,
    });

    migrateBackfillUsageCacheAccounting(getDb());

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
      model,
      expectedUsage,
      mockPricingOverrides,
    );

    const targetRow = rawGet<UsageEventRow>(
      `SELECT
         input_tokens,
         output_tokens,
         cache_creation_input_tokens,
         cache_read_input_tokens,
         estimated_cost_usd,
         pricing_status
       FROM llm_usage_events
       WHERE id = ?`,
      "usage-target",
    );
    expect(targetRow).not.toBeNull();
    expect(targetRow?.input_tokens).toBe(138);
    expect(targetRow?.output_tokens).toBe(11_768);
    expect(targetRow?.cache_creation_input_tokens).toBe(373_619);
    expect(targetRow?.cache_read_input_tokens).toBe(3_046_461);
    expect(targetRow?.pricing_status).toBe("priced");
    expect(targetRow?.estimated_cost_usd).toBeCloseTo(
      expectedPricing.estimatedCostUsd ?? 0,
      12,
    );
    expect(targetRow?.estimated_cost_usd).not.toBe(flattenedHistoricalCost);

    const untouchedRow = rawGet<UsageEventRow>(
      `SELECT
         input_tokens,
         output_tokens,
         cache_creation_input_tokens,
         cache_read_input_tokens,
         estimated_cost_usd,
         pricing_status
       FROM llm_usage_events
       WHERE id = ?`,
      "usage-no-logs",
    );
    expect(untouchedRow).not.toBeNull();
    expect(untouchedRow).toEqual({
      input_tokens: 1_234,
      output_tokens: 56,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      estimated_cost_usd: noLogCost,
      pricing_status: "priced",
    });

    const checkpoint = rawGet<{ value: string }>(
      `SELECT value FROM memory_checkpoints WHERE key = ?`,
      CHECKPOINT_KEY,
    );
    expect(checkpoint?.value).toBe("1");
  });

  test("uses pricing overrides when backfilling Anthropic cache-aware usage rows", () => {
    const model = "claude-opus-4-6";
    mockPricingOverrides = [
      {
        provider: "anthropic",
        modelPattern: "claude-opus-4-6",
        inputPer1M: 1.5,
        outputPer1M: 7.25,
      },
    ];

    insertUsageEvent({
      id: "usage-target",
      conversationId: "conv-usage-override",
      createdAt: 2_000,
      model,
      inputTokens: 1_200,
      outputTokens: 80,
      estimatedCostUsd:
        resolvePricing("anthropic", model, 1_200, 80).estimatedCostUsd ?? 0,
    });
    insertRequestLog({
      id: "log-target",
      conversationId: "conv-usage-override",
      createdAt: 1_500,
      responsePayload: anthropicResponsePayload({
        inputTokens: 200,
        outputTokens: 80,
        cacheReadInputTokens: 700,
        ephemeral5mInputTokens: 300,
      }),
    });

    migrateBackfillUsageCacheAccounting(getDb());

    const expectedUsage: PricingUsage = {
      directInputTokens: 200,
      outputTokens: 80,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 700,
      anthropicCacheCreation: {
        ephemeral_5m_input_tokens: 300,
        ephemeral_1h_input_tokens: 0,
      },
    };
    const expectedPricing = resolvePricingForUsageWithOverrides(
      "anthropic",
      model,
      expectedUsage,
      mockPricingOverrides,
    );

    const targetRow = rawGet<UsageEventRow>(
      `SELECT
         input_tokens,
         output_tokens,
         cache_creation_input_tokens,
         cache_read_input_tokens,
         estimated_cost_usd,
         pricing_status
       FROM llm_usage_events
       WHERE id = ?`,
      "usage-target",
    );
    expect(targetRow).not.toBeNull();
    expect(targetRow?.input_tokens).toBe(200);
    expect(targetRow?.output_tokens).toBe(80);
    expect(targetRow?.cache_creation_input_tokens).toBe(300);
    expect(targetRow?.cache_read_input_tokens).toBe(700);
    expect(targetRow?.pricing_status).toBe("priced");
    expect(targetRow?.estimated_cost_usd).toBeCloseTo(
      expectedPricing.estimatedCostUsd ?? 0,
      12,
    );
  });
});
