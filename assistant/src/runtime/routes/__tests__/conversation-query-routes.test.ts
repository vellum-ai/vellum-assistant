import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  sampleConcepts as sharedSampleConcepts,
  sampleConfig,
  sampleSkills,
} from "../../../memory/__tests__/fixtures/memory-v2-activation-fixtures.js";

let rawConfigFixture: Record<string, unknown> = {};
let savedRawConfig: Record<string, unknown> | null = null;

mock.module("../../../config/loader.js", () => ({
  loadRawConfig: () => structuredClone(rawConfigFixture),
  saveRawConfig: (raw: Record<string, unknown>) => {
    savedRawConfig = raw;
  },
  deepMergeOverwrite: (
    target: Record<string, unknown>,
    overrides: Record<string, unknown>,
  ) => {
    Object.assign(target, overrides);
  },
}));

import { getDb } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import {
  backfillMemoryV2ActivationMessageId,
  type MemoryV2ConceptRowRecord,
  type MemoryV2ConfigSnapshot,
  type MemoryV2SkillRowRecord,
  recordMemoryV2ActivationLog,
} from "../../../memory/memory-v2-activation-log-store.js";
import {
  llmRequestLogs,
  memoryV2ActivationLogs,
} from "../../../memory/schema.js";
import { ROUTES } from "../conversation-query-routes.js";

// Local subset: this test only exercises a single concept row.
const sampleConcepts: MemoryV2ConceptRowRecord[] = sharedSampleConcepts.slice(
  0,
  1,
);

initializeDb();

const llmContextRoute = ROUTES.find(
  (r) => r.method === "GET" && r.endpoint === "messages/:id/llm-context",
)!;

const replaceProfileRoute = ROUTES.find(
  (r) => r.operationId === "config_llm_profiles_replace",
)!;

function dispatchLlmContext(messageId: string) {
  return llmContextRoute.handler({ pathParams: { id: messageId } });
}

function clearTables(): void {
  const db = getDb();
  db.delete(llmRequestLogs).run();
  db.delete(memoryV2ActivationLogs).run();
}

function seedRequestLog(messageId: string, id: string): void {
  getDb()
    .insert(llmRequestLogs)
    .values({
      id,
      conversationId: "conv-1",
      messageId,
      provider: "openai",
      requestPayload: JSON.stringify({ model: "gpt-4.1", messages: [] }),
      responsePayload: JSON.stringify({
        choices: [{ message: { content: "hi" } }],
      }),
      createdAt: 1_700_000_000_000,
    })
    .run();
}

describe("GET /v1/messages/:id/llm-context — memoryV2Activation", () => {
  beforeEach(() => {
    clearTables();
  });

  test("returns null memoryV2Activation when no v2 log exists for the turn", async () => {
    const messageId = "msg-no-v2";
    seedRequestLog(messageId, "log-no-v2");

    const body = (await dispatchLlmContext(messageId)) as {
      memoryV2Activation: unknown;
      memoryRecall: unknown;
    };

    expect(body.memoryV2Activation).toBeNull();
    // Backwards-compat: memoryRecall remains.
    expect(body).toHaveProperty("memoryRecall");
  });

  test("returns the recorded v2 activation log on the response", async () => {
    const conversationId = "conv-v2";
    const messageId = "msg-v2-present";

    seedRequestLog(messageId, "log-v2-present");
    recordMemoryV2ActivationLog({
      conversationId,
      turn: 4,
      mode: "per-turn",
      concepts: sampleConcepts,
      skills: sampleSkills,
      config: sampleConfig,
    });
    backfillMemoryV2ActivationMessageId(conversationId, messageId);

    const body = (await dispatchLlmContext(messageId)) as {
      memoryV2Activation: {
        turn: number;
        mode: "context-load" | "per-turn";
        concepts: MemoryV2ConceptRowRecord[];
        skills: MemoryV2SkillRowRecord[];
        config: MemoryV2ConfigSnapshot;
      } | null;
      memoryRecall: unknown;
    };

    expect(body.memoryV2Activation).not.toBeNull();
    expect(body.memoryV2Activation!.turn).toBe(4);
    expect(body.memoryV2Activation!.mode).toBe("per-turn");
    expect(body.memoryV2Activation!.concepts).toEqual(sampleConcepts);
    expect(body.memoryV2Activation!.skills).toEqual(sampleSkills);
    expect(body.memoryV2Activation!.config).toEqual(sampleConfig);
    // Backwards-compat: memoryRecall field still present.
    expect(body).toHaveProperty("memoryRecall");
  });
});

describe("PUT /v1/config/llm/profiles/:name", () => {
  beforeEach(() => {
    savedRawConfig = null;
    rawConfigFixture = {
      llm: {
        profiles: {
          custom: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            maxTokens: 32000,
            contextWindow: {
              maxInputTokens: 900000,
              summaryBudgetRatio: 0.08,
            },
            openrouter: {
              only: ["anthropic"],
            },
          },
        },
      },
    };
  });

  test("owns contextWindow while preserving non-UI profile leaves", () => {
    const result = replaceProfileRoute.handler({
      pathParams: { name: "custom" },
      body: {
        provider: "openai",
        model: "gpt-5.5",
      },
    });

    expect(result).toEqual({ ok: true });
    const savedProfile = (
      savedRawConfig?.llm as {
        profiles: Record<string, Record<string, unknown>>;
      }
    ).profiles.custom;

    expect(savedProfile.provider).toBe("openai");
    expect(savedProfile.model).toBe("gpt-5.5");
    expect(savedProfile.maxTokens).toBeUndefined();
    expect(savedProfile.contextWindow).toBeUndefined();
    expect(savedProfile.openrouter).toEqual({ only: ["anthropic"] });
  });

  test("writes a replacement contextWindow override", () => {
    const result = replaceProfileRoute.handler({
      pathParams: { name: "custom" },
      body: {
        provider: "openai",
        model: "gpt-5.5",
        contextWindow: {
          maxInputTokens: 150000,
        },
      },
    });

    expect(result).toEqual({ ok: true });
    const savedProfile = (
      savedRawConfig?.llm as {
        profiles: Record<string, Record<string, unknown>>;
      }
    ).profiles.custom;

    expect(savedProfile.contextWindow).toEqual({ maxInputTokens: 150000 });
    expect(savedProfile.openrouter).toEqual({ only: ["anthropic"] });
  });
});
