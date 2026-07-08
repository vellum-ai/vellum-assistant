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
} from "../../../plugins/defaults/memory/__tests__/fixtures/memory-v2-activation-fixtures.js";

let rawConfigFixture: Record<string, unknown> = {};
let savedRawConfig: Record<string, unknown> | null = null;
// Counters / spies so tests can assert that `commitConfigWrite` ran its
// post-write side effects. Each `replaceProfileRoute.handler` call that
// hits `commitConfigWrite` should bump these once.
let invalidateConfigCacheCalls = 0;
let initializeProvidersCalls = 0;
let clearEmbeddingBackendCacheCalls = 0;

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
  // `commitConfigWrite` (used by `handleReplaceInferenceProfile`) pulls
  // in `getConfig` for the provider reinit's config arg and
  // `invalidateConfigCache` so the next caller sees the fresh write.
  // Stub both: getConfig returns whatever was last saved (or the fixture
  // if nothing has been saved yet) and the cache-invalidation function
  // is a counter so we can assert it fired.
  getConfig: () => structuredClone(savedRawConfig ?? rawConfigFixture),
  invalidateConfigCache: () => {
    invalidateConfigCacheCalls += 1;
  },
}));

mock.module("../../../providers/registry.js", () => ({
  initializeProviders: async () => {
    initializeProvidersCalls += 1;
  },
}));

mock.module("../../../persistence/embeddings/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {
    clearEmbeddingBackendCacheCalls += 1;
  },
}));

import { LLMConfigBase } from "../../../config/schemas/llm.js";
import type { ConversationCreateType } from "../../../persistence/conversation-types.js";
import { getDb, getLogsDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import {
  conversationKeys,
  conversations,
  llmRequestLogs,
  memoryV2ActivationLogs,
  messages,
  providerConnections,
} from "../../../persistence/schema/index.js";
import {
  backfillMemoryV2ActivationMessageId,
  type MemoryV2ConceptRowRecord,
  type MemoryV2ConfigSnapshot,
  recordMemoryV2ActivationLog,
} from "../../../plugins/defaults/memory/memory-v2-activation-log-store.js";
import {
  createConnection,
  getConnection,
} from "../../../providers/inference/connections.js";
import { ROUTES } from "../conversation-query-routes.js";

// Local subset: this test only exercises a single concept row.
const sampleConcepts: MemoryV2ConceptRowRecord[] = sharedSampleConcepts.slice(
  0,
  1,
);

await initializeDb();

const llmContextRoute = ROUTES.find(
  (r) => r.method === "GET" && r.endpoint === "messages/:id/llm-context",
)!;

const conversationLlmContextRoute = ROUTES.find(
  (r) => r.method === "GET" && r.endpoint === "conversations/llm-context",
)!;

const replaceProfileRoute = ROUTES.find(
  (r) => r.operationId === "config_llm_profiles_replace",
)!;

function dispatchLlmContext(messageId: string) {
  return llmContextRoute.handler({ pathParams: { id: messageId } });
}

function dispatchConversationLlmContext(queryParams: Record<string, string>) {
  return conversationLlmContextRoute.handler({ queryParams });
}

function clearTables(): void {
  const db = getDb();
  getLogsDb()!.delete(llmRequestLogs).run();
  db.delete(memoryV2ActivationLogs).run();
  db.delete(messages).run();
  db.delete(conversationKeys).run();
  db.delete(conversations).run();
}

function seedConversationAndMessage(args: {
  conversationId: string;
  messageId: string;
  source: string;
  conversationType: ConversationCreateType;
  totalEstimatedCost?: number;
}): void {
  const now = Date.now();
  getDb()
    .insert(conversations)
    .values({
      id: args.conversationId,
      title: null,
      createdAt: now,
      updatedAt: now,
      source: args.source,
      conversationType: args.conversationType,
      memoryScopeId: "default",
      ...(args.totalEstimatedCost != null
        ? { totalEstimatedCost: args.totalEstimatedCost }
        : {}),
    })
    .run();
  getDb()
    .insert(messages)
    .values({
      id: args.messageId,
      conversationId: args.conversationId,
      role: "assistant",
      content: "",
      createdAt: now,
      metadata: null,
    })
    .run();
}

function seedRequestLog(
  messageId: string,
  id: string,
  options: { agentLoopExitReason?: string | null } = {},
): void {
  getLogsDb()!
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
      ...(options.agentLoopExitReason != null
        ? { agentLoopExitReason: options.agentLoopExitReason }
        : {}),
    })
    .run();
}

function seedRequestLogWithSections(messageId: string, id: string): void {
  getLogsDb()!
    .insert(llmRequestLogs)
    .values({
      id,
      conversationId: "conv-1",
      messageId,
      provider: "openai",
      requestPayload: JSON.stringify({
        model: "gpt-4.1",
        messages: [{ role: "user", content: "hello" }],
      }),
      responsePayload: JSON.stringify({
        choices: [{ message: { content: "hi" } }],
      }),
      createdAt: 1_700_000_000_000,
    })
    .run();
}

function seedConversationKey(
  conversationKey: string,
  conversationId: string,
): void {
  getDb()
    .insert(conversationKeys)
    .values({
      id: `key-${conversationKey}`,
      conversationKey,
      conversationId,
      createdAt: Date.now(),
    })
    .run();
}

describe("GET /v1/conversations/llm-context", () => {
  beforeEach(() => {
    clearTables();
  });

  test("returns all LLM calls for a resolved conversation key", async () => {
    seedConversationAndMessage({
      conversationId: "conv-1",
      messageId: "msg-1",
      source: "user",
      conversationType: "standard",
      totalEstimatedCost: 0.42,
    });
    getDb()
      .insert(messages)
      .values({
        id: "msg-2",
        conversationId: "conv-1",
        role: "assistant",
        content: "",
        createdAt: Date.now() + 1,
        metadata: null,
      })
      .run();
    seedConversationAndMessage({
      conversationId: "conv-other",
      messageId: "msg-other",
      source: "user",
      conversationType: "standard",
    });
    seedConversationKey("conv-key", "conv-1");
    seedRequestLog("msg-2", "log-b");
    seedRequestLog("msg-1", "log-a");
    getLogsDb()!
      .insert(llmRequestLogs)
      .values({
        id: "log-other",
        conversationId: "conv-other",
        messageId: "msg-other",
        provider: "openai",
        requestPayload: JSON.stringify({ model: "gpt-4.1", messages: [] }),
        responsePayload: JSON.stringify({
          choices: [{ message: { content: "other" } }],
        }),
        createdAt: 1_700_000_000_001,
      })
      .run();

    const body = (await dispatchConversationLlmContext({
      conversationKey: "conv-key",
    })) as {
      conversationId: string;
      conversationKey: string;
      conversationKind: string;
      conversationTotalEstimatedCostUsd: number | null;
      logs: Array<{ id: string }>;
      memoryRecall: null;
      memoryV2Activation: null;
    };

    expect(body.conversationId).toBe("conv-1");
    expect(body.conversationKey).toBe("conv-key");
    expect(body.conversationKind).toBe("user");
    expect(body.conversationTotalEstimatedCostUsd).toBe(0.42);
    expect(body.logs.map((log) => log.id)).toEqual(["log-a", "log-b"]);
    expect(body.memoryRecall).toBeNull();
    expect(body.memoryV2Activation).toBeNull();
  });

  test("returns an empty inspector response for an unresolved conversation key", async () => {
    const body = (await dispatchConversationLlmContext({
      conversationKey: "missing-key",
    })) as {
      conversationId: string | null;
      conversationKey: string;
      logs: unknown[];
    };

    expect(body.conversationId).toBeNull();
    expect(body.conversationKey).toBe("missing-key");
    expect(body.logs).toEqual([]);
  });
});

describe("llm-context view=summary", () => {
  beforeEach(() => {
    clearTables();
  });

  function seedConversationWithLog(): void {
    seedConversationAndMessage({
      conversationId: "conv-1",
      messageId: "msg-1",
      source: "user",
      conversationType: "standard",
    });
    seedConversationKey("conv-key", "conv-1");
    seedRequestLogWithSections("msg-1", "log-a");
  }

  test("conversation endpoint omits sections in summary view but keeps summary fields", async () => {
    seedConversationWithLog();

    const body = (await dispatchConversationLlmContext({
      conversationKey: "conv-key",
      view: "summary",
    })) as {
      logs: Array<Record<string, unknown>>;
    };

    expect(body.logs).toHaveLength(1);
    const log = body.logs[0]!;
    expect(log.requestSections).toBeUndefined();
    expect(log.responseSections).toBeUndefined();
    expect(log.id).toBe("log-a");
    expect(log.summary).toBeDefined();
  });

  test("conversation endpoint includes sections by default", async () => {
    seedConversationWithLog();

    const body = (await dispatchConversationLlmContext({
      conversationKey: "conv-key",
    })) as {
      logs: Array<Record<string, unknown>>;
    };

    expect(Array.isArray(body.logs[0]!.requestSections)).toBe(true);
    expect(Array.isArray(body.logs[0]!.responseSections)).toBe(true);
  });

  test("message endpoint omits sections in summary view", async () => {
    seedConversationWithLog();

    const body = (await llmContextRoute.handler({
      pathParams: { id: "msg-1" },
      queryParams: { view: "summary" },
    })) as {
      logs: Array<Record<string, unknown>>;
    };

    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]!.requestSections).toBeUndefined();
    expect(body.logs[0]!.responseSections).toBeUndefined();
    expect(body.logs[0]!.summary).toBeDefined();
  });

  test("rejects unknown view values", async () => {
    seedConversationWithLog();

    expect(
      dispatchConversationLlmContext({
        conversationKey: "conv-key",
        view: "compact",
      }),
    ).rejects.toThrow("Invalid view parameter");
  });
});

describe("GET /v1/llm-request-logs/:id/context", () => {
  const logContextRoute = ROUTES.find(
    (r) => r.operationId === "llm_request_logs_context_get",
  )!;

  beforeEach(() => {
    clearTables();
  });

  test("returns the normalized entry with sections for a single log", async () => {
    seedConversationAndMessage({
      conversationId: "conv-1",
      messageId: "msg-1",
      source: "user",
      conversationType: "standard",
    });
    seedRequestLogWithSections("msg-1", "log-detail");

    const body = (await logContextRoute.handler({
      pathParams: { id: "log-detail" },
    })) as Record<string, unknown>;

    expect(body.id).toBe("log-detail");
    expect(body.requestPayload).toBeNull();
    expect(body.responsePayload).toBeNull();
    expect(body.summary).toBeDefined();
    expect(Array.isArray(body.requestSections)).toBe(true);
    expect(Array.isArray(body.responseSections)).toBe(true);
  });

  test("throws NotFound for a missing log id", async () => {
    expect(
      logContextRoute.handler({ pathParams: { id: "log-missing" } }),
    ).rejects.toThrow("log not found");
  });
});

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
      config: sampleConfig,
    });
    backfillMemoryV2ActivationMessageId(conversationId, messageId);

    const body = (await dispatchLlmContext(messageId)) as {
      memoryV2Activation: {
        turn: number;
        mode: "context-load" | "per-turn";
        concepts: MemoryV2ConceptRowRecord[];
        config: MemoryV2ConfigSnapshot;
      } | null;
      memoryRecall: unknown;
    };

    expect(body.memoryV2Activation).not.toBeNull();
    expect(body.memoryV2Activation!.turn).toBe(4);
    expect(body.memoryV2Activation!.mode).toBe("per-turn");
    expect(body.memoryV2Activation!.concepts).toEqual(sampleConcepts);
    expect(body.memoryV2Activation!.config).toEqual(sampleConfig);
    // Backwards-compat: memoryRecall field still present.
    expect(body).toHaveProperty("memoryRecall");
  });
});

describe("GET /v1/messages/:id/llm-context — conversationKind", () => {
  beforeEach(() => {
    clearTables();
  });

  test("returns 'background_memory_consolidation' for memory_v2_consolidation source", async () => {
    seedConversationAndMessage({
      conversationId: "conv-mem-consol",
      messageId: "msg-mem-consol",
      source: "memory_v2_consolidation",
      conversationType: "background",
    });

    const body = (await dispatchLlmContext("msg-mem-consol")) as {
      conversationKind: string;
      logs: unknown[];
    };

    expect(body.conversationKind).toBe("background_memory_consolidation");
    expect(body.logs).toEqual([]);
  });

  test("returns 'background' for non-consolidation background conversations", async () => {
    seedConversationAndMessage({
      conversationId: "conv-bg",
      messageId: "msg-bg",
      source: "memory_consolidation",
      conversationType: "background",
    });

    const body = (await dispatchLlmContext("msg-bg")) as {
      conversationKind: string;
    };

    expect(body.conversationKind).toBe("background");
  });

  test("returns 'user' for standard conversations", async () => {
    seedConversationAndMessage({
      conversationId: "conv-user",
      messageId: "msg-user",
      source: "user",
      conversationType: "standard",
    });

    const body = (await dispatchLlmContext("msg-user")) as {
      conversationKind: string;
    };

    expect(body.conversationKind).toBe("user");
  });

  test("falls back to 'user' when the message can't be resolved", async () => {
    const body = (await dispatchLlmContext("msg-missing")) as {
      conversationKind: string;
    };

    expect(body.conversationKind).toBe("user");
  });
});

describe("GET /v1/messages/:id/llm-context — conversationTotalEstimatedCostUsd", () => {
  beforeEach(() => {
    clearTables();
  });

  test("returns the conversation's running cost total when present", async () => {
    seedConversationAndMessage({
      conversationId: "conv-with-cost",
      messageId: "msg-with-cost",
      source: "user",
      conversationType: "standard",
      totalEstimatedCost: 1.234,
    });

    const body = (await dispatchLlmContext("msg-with-cost")) as {
      conversationTotalEstimatedCostUsd: number | null;
    };

    expect(body.conversationTotalEstimatedCostUsd).toBeCloseTo(1.234, 5);
  });

  test("returns 0 when the conversation hasn't accrued any cost yet", async () => {
    seedConversationAndMessage({
      conversationId: "conv-no-cost",
      messageId: "msg-no-cost",
      source: "user",
      conversationType: "standard",
    });

    const body = (await dispatchLlmContext("msg-no-cost")) as {
      conversationTotalEstimatedCostUsd: number | null;
    };

    expect(body.conversationTotalEstimatedCostUsd).toBe(0);
  });

  test("returns null when the message can't be resolved to a conversation", async () => {
    const body = (await dispatchLlmContext("msg-missing-cost")) as {
      conversationTotalEstimatedCostUsd: number | null;
    };

    expect(body.conversationTotalEstimatedCostUsd).toBeNull();
  });
});

describe("GET /v1/messages/:id/llm-context — agentLoopExitReason", () => {
  beforeEach(() => {
    clearTables();
  });

  test("surfaces the stamped agent_loop_exit_reason on the terminal log", async () => {
    const messageId = "msg-with-exit";
    seedConversationAndMessage({
      conversationId: "conv-1",
      messageId,
      source: "user",
      conversationType: "standard",
    });
    // Two logs in the same turn — only the terminal one is stamped.
    seedRequestLog(messageId, "log-non-terminal");
    seedRequestLog(messageId, "log-terminal", {
      agentLoopExitReason: "no_tool_calls",
    });

    const body = (await dispatchLlmContext(messageId)) as {
      logs: Array<{ id: string; agentLoopExitReason: string | null }>;
    };

    const byId = new Map(body.logs.map((l) => [l.id, l.agentLoopExitReason]));
    expect(byId.get("log-non-terminal")).toBeNull();
    expect(byId.get("log-terminal")).toBe("no_tool_calls");
  });

  test("returns null when no log in the turn has been stamped", async () => {
    const messageId = "msg-no-exit";
    seedConversationAndMessage({
      conversationId: "conv-1",
      messageId,
      source: "user",
      conversationType: "standard",
    });
    seedRequestLog(messageId, "log-unstamped");

    const body = (await dispatchLlmContext(messageId)) as {
      logs: Array<{ id: string; agentLoopExitReason: string | null }>;
    };

    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]!.agentLoopExitReason).toBeNull();
  });
});

describe("GET /v1/messages/:id/llm-context — synthetic call_site projection", () => {
  beforeEach(() => {
    clearTables();
  });

  test("projects callSite='syntheticAgentErrorMessage' and the stamped exit reason for a synthetic row", async () => {
    const messageId = "msg-yield";
    seedConversationAndMessage({
      conversationId: "conv-1",
      messageId,
      source: "user",
      conversationType: "standard",
    });
    // Mirror what `recordSyntheticAgentErrorMessageLog` writes: synthetic
    // envelope in BOTH payload columns (request = prepared LLM body the
    // loop was about to send; response = the notice text the user saw),
    // `call_site = "syntheticAgentErrorMessage"`, exit reason stamped at
    // insert time.
    getLogsDb()!
      .insert(llmRequestLogs)
      .values({
        id: "log-yield",
        conversationId: "conv-1",
        messageId,
        provider: null,
        requestPayload: JSON.stringify({
          syntheticAgentErrorMessage: {
            exitReason: "budget_yield_unrecovered",
            preparedRequest: { messages: [], maxInputTokensBudget: 200000 },
          },
        }),
        responsePayload: JSON.stringify({
          syntheticAgentErrorMessage: {
            exitReason: "budget_yield_unrecovered",
            noticeText:
              "I tried to compact this but couldn't fit the next step.",
          },
        }),
        createdAt: 1_700_000_000_000,
        agentLoopExitReason: "budget_yield_unrecovered",
        callSite: "syntheticAgentErrorMessage",
      })
      .run();

    const body = (await dispatchLlmContext(messageId)) as {
      logs: Array<{
        id: string;
        callSite: string | null;
        agentLoopExitReason: string | null;
      }>;
    };

    expect(body.logs).toHaveLength(1);
    const row = body.logs[0]!;
    expect(row.callSite).toBe("syntheticAgentErrorMessage");
    expect(row.agentLoopExitReason).toBe("budget_yield_unrecovered");
    // Frontend branches on `callSite` alone — no separate syntheticEvent
    // field needs to be projected.
    expect(row).not.toHaveProperty("syntheticEvent");
  });

  test("projects callSite='mainAgent' for regular LLM-call rows", async () => {
    const messageId = "msg-regular";
    seedConversationAndMessage({
      conversationId: "conv-1",
      messageId,
      source: "user",
      conversationType: "standard",
    });
    getLogsDb()!
      .insert(llmRequestLogs)
      .values({
        id: "log-regular",
        conversationId: "conv-1",
        messageId,
        provider: "openai",
        requestPayload: JSON.stringify({ model: "gpt-4.1", messages: [] }),
        responsePayload: JSON.stringify({
          choices: [{ message: { content: "hi" } }],
        }),
        createdAt: 1_700_000_000_000,
        callSite: "mainAgent",
      })
      .run();

    const body = (await dispatchLlmContext(messageId)) as {
      logs: Array<{
        id: string;
        callSite: string | null;
      }>;
    };

    expect(body.logs[0]!.callSite).toBe("mainAgent");
    // No leftover syntheticEvent projection field on regular rows either.
    expect(body.logs[0]!).not.toHaveProperty("syntheticEvent");
  });
});

describe("PUT /v1/config/llm/profiles/:name", () => {
  beforeEach(() => {
    savedRawConfig = null;
    invalidateConfigCacheCalls = 0;
    initializeProvidersCalls = 0;
    clearEmbeddingBackendCacheCalls = 0;
    rawConfigFixture = {
      llm: {
        profiles: {
          custom: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            maxTokens: 32000,
            contextWindow: {
              maxInputTokens: 900000,
              targetBudgetRatio: 0.3,
              summaryBudgetRatio: 0.08,
              overflowRecovery: {
                enabled: true,
                maxAttempts: 4,
              },
            },
            openrouter: {
              only: ["anthropic"],
            },
          },
        },
      },
    };
  });

  test("owns contextWindow maxInputTokens while preserving non-UI profile leaves", async () => {
    const result = await replaceProfileRoute.handler({
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
    // Write normalization completes the entry against llm.default (schema
    // defaults here — the fixture has none), so UI-cleared fields land as
    // explicit values instead of inherit-by-absence.
    const schemaDefault = LLMConfigBase.parse({});
    expect(savedProfile.maxTokens).toBe(schemaDefault.maxTokens);
    expect(savedProfile.contextWindow).toEqual({
      ...schemaDefault.contextWindow,
      targetBudgetRatio: 0.3,
      summaryBudgetRatio: 0.08,
      overflowRecovery: {
        ...schemaDefault.contextWindow.overflowRecovery,
        enabled: true,
        maxAttempts: 4,
      },
    });
    expect(savedProfile.openrouter).toEqual({ only: ["anthropic"] });
  });

  test("writes only the replacement contextWindow maxInputTokens override", async () => {
    const result = await replaceProfileRoute.handler({
      pathParams: { name: "custom" },
      body: {
        provider: "openai",
        model: "gpt-5.5",
        contextWindow: {
          maxInputTokens: 150000,
          summaryBudgetRatio: 0.2,
        },
      },
    });

    expect(result).toEqual({ ok: true });
    const savedProfile = (
      savedRawConfig?.llm as {
        profiles: Record<string, Record<string, unknown>>;
      }
    ).profiles.custom;

    const schemaDefault = LLMConfigBase.parse({});
    expect(savedProfile.contextWindow).toEqual({
      ...schemaDefault.contextWindow,
      maxInputTokens: 150000,
      targetBudgetRatio: 0.3,
      summaryBudgetRatio: 0.08,
      overflowRecovery: {
        ...schemaDefault.contextWindow.overflowRecovery,
        enabled: true,
        maxAttempts: 4,
      },
    });
    expect(savedProfile.openrouter).toEqual({ only: ["anthropic"] });
  });

  test("writes provider_connection when present in body", async () => {
    const result = await replaceProfileRoute.handler({
      pathParams: { name: "custom" },
      body: {
        provider: "openai",
        provider_connection: "personal-openai",
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
    expect(savedProfile.provider_connection).toBe("personal-openai");
  });

  test("auto-derives provider_connection when omitted from body (Any active)", async () => {
    // Start from a clean connection slate — provider_connections persists
    // across tests in this file, so a leaked openai-personal would otherwise
    // win the derivation.
    getDb().delete(providerConnections).run();
    // The single Vellum-managed connection serves managed-routable providers.
    createConnection(getDb(), {
      name: "vellum",
      provider: "vellum",
      auth: { type: "platform" },
    });
    // Seed an existing binding so the test starts from a non-empty state.
    (
      rawConfigFixture.llm as {
        profiles: { custom: Record<string, unknown> };
      }
    ).profiles.custom.provider_connection = "stale-openai";

    const result = await replaceProfileRoute.handler({
      pathParams: { name: "custom" },
      body: {
        provider: "openai",
        model: "gpt-5.5",
        // provider_connection deliberately omitted — the UI cleared the
        // picker back to "Any active". The route auto-derives an active
        // connection for the provider to prevent stale inheritance during
        // config deep-merge.
      },
    });

    expect(result).toEqual({ ok: true });
    const savedProfile = (
      savedRawConfig?.llm as {
        profiles: Record<string, Record<string, unknown>>;
      }
    ).profiles.custom;

    // No personal openai connection exists, so the route auto-derives the
    // single Vellum-managed connection for this managed-routable provider.
    expect(savedProfile.provider_connection).toBe("vellum");
  });

  test("Any active derivation skips orphaned legacy *-managed rows", async () => {
    getDb().delete(providerConnections).run();
    // Upgraded workspaces may still carry a legacy openai-managed row (hidden
    // from the list route, deleted by a follow-up migration). It must not be
    // auto-picked — the derivation should bind to `vellum` instead.
    createConnection(getDb(), {
      name: "openai-managed",
      provider: "openai",
      auth: { type: "platform" },
    });
    createConnection(getDb(), {
      name: "vellum",
      provider: "vellum",
      auth: { type: "platform" },
    });

    await replaceProfileRoute.handler({
      pathParams: { name: "custom" },
      body: { provider: "openai", model: "gpt-5.5" },
    });

    const savedProfile = (
      savedRawConfig?.llm as {
        profiles: Record<string, Record<string, unknown>>;
      }
    ).profiles.custom;
    expect(savedProfile.provider_connection).toBe("vellum");
  });

  test("auto-derives provider_connection for BYOK provider (Any active)", async () => {
    // Seed a fireworks connection in the DB.
    createConnection(getDb(), {
      name: "fireworks",
      provider: "fireworks",
      auth: { type: "api_key", credential: "fireworks:api_key" },
    });

    const result = await replaceProfileRoute.handler({
      pathParams: { name: "custom" },
      body: {
        provider: "fireworks",
        model: "accounts/fireworks/models/llama-v3p1-8b-instruct",
      },
    });

    expect(result).toEqual({ ok: true });
    const savedProfile = (
      savedRawConfig?.llm as {
        profiles: Record<string, Record<string, unknown>>;
      }
    ).profiles.custom;

    expect(savedProfile.provider).toBe("fireworks");
    expect(savedProfile.provider_connection).toBe("fireworks");
  });

  test("auto-creates provider_connection when no connection exists for provider", async () => {
    const result = await replaceProfileRoute.handler({
      pathParams: { name: "custom" },
      body: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4-6",
      },
    });

    expect(result).toEqual({ ok: true });
    const savedProfile = (
      savedRawConfig?.llm as {
        profiles: Record<string, Record<string, unknown>>;
      }
    ).profiles.custom;

    expect(savedProfile.provider).toBe("openrouter");
    expect(savedProfile.provider_connection).toBe("openrouter-personal");

    const conn = getConnection(getDb(), "openrouter-personal");
    expect(conn).not.toBeNull();
    expect(conn!.provider).toBe("openrouter");
    expect(conn!.auth).toEqual({
      type: "api_key",
      credential: "credential/openrouter/api_key",
    });
  });

  test("saves a profile using the minimax provider (regression #32404)", async () => {
    // minimax is exposed as a first-class provider in the catalog, so saving
    // a profile bound to it must pass ProfileEntry validation rather than 400.
    const result = await replaceProfileRoute.handler({
      pathParams: { name: "custom" },
      body: {
        provider: "minimax",
        model: "MiniMax-M2.7",
      },
    });

    expect(result).toEqual({ ok: true });
    const savedProfile = (
      savedRawConfig?.llm as {
        profiles: Record<string, Record<string, unknown>>;
      }
    ).profiles.custom;

    expect(savedProfile.provider).toBe("minimax");
    expect(savedProfile.model).toBe("MiniMax-M2.7");
    expect(savedProfile.provider_connection).toBe("minimax-personal");

    const conn = getConnection(getDb(), "minimax-personal");
    expect(conn).not.toBeNull();
    expect(conn!.provider).toBe("minimax");
  });

  describe("managed profile guard", () => {
    beforeEach(() => {
      // Seed two managed-source profiles alongside the existing custom one.
      // Every managed profile name (including the flag-gated os-beta) is
      // invariant while its entry is managed-source: fully read-only except
      // the disabled → active status transition.
      const profiles = (
        rawConfigFixture.llm as { profiles: Record<string, unknown> }
      ).profiles;
      profiles["balanced"] = {
        source: "managed",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        label: "Balanced",
        status: "active",
      };
      profiles["os-beta"] = {
        source: "managed",
        provider: "together",
        model: "zai-org/GLM-5.2",
        label: "OS Beta",
        status: "active",
      };
    });

    test("rejects label edit on managed os-beta profile (invariant)", async () => {
      await expect(
        replaceProfileRoute.handler({
          pathParams: { name: "os-beta" },
          body: { label: "My OS Beta" },
        }),
      ).rejects.toThrow(
        /Cannot edit managed profile "os-beta" fields \[label\]/,
      );
      expect(savedRawConfig).toBeNull();
    });

    test("rejects disable on managed os-beta profile (invariant)", async () => {
      await expect(
        replaceProfileRoute.handler({
          pathParams: { name: "os-beta" },
          body: { status: "disabled" },
        }),
      ).rejects.toThrow(
        'Cannot edit managed profile "os-beta". Managed profiles are read-only',
      );
      expect(savedRawConfig).toBeNull();
    });

    test("re-enables a disabled managed os-beta profile, preserving seed fields", async () => {
      (
        rawConfigFixture.llm as {
          profiles: Record<string, Record<string, unknown>>;
        }
      ).profiles["os-beta"]!.status = "disabled";

      const result = await replaceProfileRoute.handler({
        pathParams: { name: "os-beta" },
        body: { status: "active" },
      });

      expect(result).toEqual({ ok: true });
      const savedProfile = (
        savedRawConfig?.llm as {
          profiles: Record<string, Record<string, unknown>>;
        }
      ).profiles["os-beta"]!;

      expect(savedProfile.status).toBe("active");
      // Seed fields preserved.
      expect(savedProfile.provider).toBe("together");
      expect(savedProfile.model).toBe("zai-org/GLM-5.2");
      expect(savedProfile.source).toBe("managed");
    });

    // The full commit-time rejection matrix for invariant managed profiles
    // lives in src/__tests__/managed-profile-guard.test.ts.

    test("rejects provider edit on managed profile with disallowed-keys error", async () => {
      // The handler is `async`, so synchronous BadRequest throws still
      // surface as a rejected promise; assert via `.rejects.toThrow`.
      await expect(
        replaceProfileRoute.handler({
          pathParams: { name: "balanced" },
          body: { provider: "openai", model: "gpt-5" },
        }),
      ).rejects.toThrow(
        /Cannot edit managed profile "balanced" fields \[provider, model\]/,
      );
    });

    test("rejects mixed-field bodies without partially applying anything", async () => {
      // Neither label nor maxTokens is writable on a managed profile — the
      // reject must fire before any write, so the saver is never invoked.
      await expect(
        replaceProfileRoute.handler({
          pathParams: { name: "balanced" },
          body: { label: "Try", maxTokens: 999 },
        }),
      ).rejects.toThrow(
        /Cannot edit managed profile "balanced" fields \[maxTokens, label\]/,
      );
      expect(savedRawConfig).toBeNull();
      // Reject path skips commitConfigWrite entirely — no provider reinit
      // or cache invalidation should fire on a guard rejection.
      expect(initializeProvidersCalls).toBe(0);
      expect(invalidateConfigCacheCalls).toBe(0);
      expect(clearEmbeddingBackendCacheCalls).toBe(0);
    });
  });

  describe("commitConfigWrite side effects", () => {
    test("re-enabling a disabled default profile triggers provider reinit + cache invalidation", async () => {
      // Seed a hatch-disabled default profile that the user re-enables — the
      // only status transition the invariant guard permits on a default
      // profile. commitConfigWrite must reinit the provider registry so the
      // status change is reflected in the running daemon immediately, not at
      // the next watcher tick.
      (rawConfigFixture.llm as { profiles: Record<string, unknown> }).profiles[
        "balanced"
      ] = {
        source: "managed",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        label: "Balanced",
        status: "disabled",
      };

      const result = await replaceProfileRoute.handler({
        pathParams: { name: "balanced" },
        body: { status: "active" },
      });

      expect(result).toEqual({ ok: true });
      expect(initializeProvidersCalls).toBe(1);
      expect(invalidateConfigCacheCalls).toBe(1);
      expect(clearEmbeddingBackendCacheCalls).toBe(1);
    });

    test("custom profile provider swap triggers provider reinit + cache invalidation", async () => {
      // Custom profile path: provider/model swap on a user-owned profile.
      // Same side-effect contract — registry must reinit so the new
      // provider is wired into the running daemon without restart.
      const result = await replaceProfileRoute.handler({
        pathParams: { name: "custom" },
        body: {
          provider: "openai",
          model: "gpt-5.5",
        },
      });

      expect(result).toEqual({ ok: true });
      expect(initializeProvidersCalls).toBe(1);
      expect(invalidateConfigCacheCalls).toBe(1);
      expect(clearEmbeddingBackendCacheCalls).toBe(1);
    });
  });
});

describe("custom profile write normalization (complete overrides)", () => {
  const configPatchRoute = ROUTES.find(
    (r) => r.operationId === "config_patch",
  )!;
  const configSetRoute = ROUTES.find((r) => r.operationId === "config_set")!;

  const distinctiveDefault = {
    provider: "anthropic",
    model: "claude-opus-4-8",
    maxTokens: 12345,
    temperature: 0.7,
    logitBias: "suppress-cjk",
  };

  beforeEach(() => {
    savedRawConfig = null;
    rawConfigFixture = {
      llm: {
        default: structuredClone(distinctiveDefault),
        profiles: {
          partial: { source: "user", model: "claude-haiku-4-5-20251001" },
        },
      },
    };
  });

  const savedProfiles = () =>
    (
      savedRawConfig?.llm as {
        profiles: Record<string, Record<string, unknown>>;
      }
    ).profiles;

  test("PUT of a partial body stores a complete profile", async () => {
    await replaceProfileRoute.handler({
      pathParams: { name: "mine" },
      body: { model: "claude-haiku-4-5-20251001" },
    });
    const saved = savedProfiles().mine;
    expect(saved.model).toBe("claude-haiku-4-5-20251001");
    expect(saved.provider).toBe("anthropic");
    expect(saved.maxTokens).toBe(12345);
    // Non-null default sampling is baked in; logitBias never is.
    expect(saved.temperature).toBe(0.7);
    expect(saved.logitBias).toBeUndefined();
    expect(saved.thinking).toBeDefined();
    expect(saved.contextWindow).toBeDefined();
  });

  test("PATCH creating a partial profile stores it complete", async () => {
    await configPatchRoute.handler({
      body: {
        llm: {
          default: structuredClone(distinctiveDefault),
          profiles: {
            mine: { source: "user", model: "claude-haiku-4-5-20251001" },
          },
        },
      },
    });
    const saved = savedProfiles().mine;
    expect(saved.provider).toBe("anthropic");
    expect(saved.maxTokens).toBe(12345);
    expect(saved.temperature).toBe(0.7);
    expect(saved.logitBias).toBeUndefined();
  });

  test("SET on a profile leaf completes the whole entry", async () => {
    await configSetRoute.handler({
      body: { path: "llm.profiles.partial.maxTokens", value: 999 },
    });
    const saved = savedProfiles().partial;
    expect(saved.maxTokens).toBe(999);
    expect(saved.provider).toBe("anthropic");
    expect(saved.temperature).toBe(0.7);
    expect(saved.model).toBe("claude-haiku-4-5-20251001");
  });

  test("an unrelated write leaves untouched partial profiles byte-identical", async () => {
    await configSetRoute.handler({
      body: { path: "heartbeat.activeHoursStart", value: 9 },
    });
    expect(savedProfiles().partial).toEqual({
      source: "user",
      model: "claude-haiku-4-5-20251001",
    });
  });

  test("unknown profile keys survive completion of a touched entry", async () => {
    (
      rawConfigFixture.llm as { profiles: Record<string, unknown> }
    ).profiles.partial = {
      source: "user",
      model: "claude-haiku-4-5-20251001",
      futureField: "keep-me",
    };
    await configSetRoute.handler({
      body: { path: "llm.profiles.partial.maxTokens", value: 999 },
    });
    const saved = savedProfiles().partial;
    expect(saved.futureField).toBe("keep-me");
    expect(saved.maxTokens).toBe(999);
    expect(saved.provider).toBe("anthropic");
  });

  test("a managed status re-enable stays a thin stub", async () => {
    (
      rawConfigFixture.llm as { profiles: Record<string, unknown> }
    ).profiles.balanced = { source: "managed", status: "disabled" };
    await replaceProfileRoute.handler({
      pathParams: { name: "balanced" },
      body: { status: null },
    });
    expect(savedProfiles().balanced).toEqual({ source: "managed" });
  });

  test("a mix profile write is not completed", async () => {
    await replaceProfileRoute.handler({
      pathParams: { name: "ab" },
      body: {
        label: "A/B",
        mix: [
          { profile: "balanced", weight: 1 },
          { profile: "cost-optimized", weight: 1 },
        ],
      },
    });
    const saved = savedProfiles().ab;
    expect(saved.mix).toBeDefined();
    expect(saved.provider).toBeUndefined();
    expect(saved.model).toBeUndefined();
    expect(saved.maxTokens).toBeUndefined();
  });

  test("re-writing a completed profile is idempotent", async () => {
    // Deterministic connection state: the PUT handler derives a connection
    // for provider-carrying bodies, so both writes must see the same rows.
    getDb().delete(providerConnections).run();
    await replaceProfileRoute.handler({
      pathParams: { name: "mine" },
      body: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    });
    const first = structuredClone(savedProfiles().mine);
    rawConfigFixture = structuredClone(savedRawConfig!);
    await replaceProfileRoute.handler({
      pathParams: { name: "mine" },
      body: first as Record<string, unknown>,
    });
    expect(savedProfiles().mine).toEqual(first);
  });
});

describe("config invariant flag enrichment", () => {
  const configGetRoute = ROUTES.find((r) => r.operationId === "config_get")!;
  const configPatchRoute = ROUTES.find(
    (r) => r.operationId === "config_patch",
  )!;

  type WireProfiles = Record<string, Record<string, unknown>>;

  function wireProfiles(body: unknown): WireProfiles {
    return (body as { llm: { profiles: WireProfiles } }).llm.profiles;
  }

  beforeEach(() => {
    savedRawConfig = null;
    rawConfigFixture = {
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "fireworks",
            model: "accounts/fireworks/models/glm-5p2",
            label: "Balanced",
            status: "active",
          },
          "os-beta": {
            source: "managed",
            provider: "together",
            model: "zai-org/GLM-5.2",
            label: "OS Beta",
            status: "active",
          },
          // A user-owned profile sharing a managed name: no invariant flag —
          // the stamp is gated on `source: "managed"` to match the guard.
          "cost-optimized": {
            source: "user",
            provider: "anthropic",
            model: "claude-haiku-4-5",
          },
          custom: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        },
      },
    };
  });

  test("GET /v1/config marks managed-source profiles invariant (incl. os-beta), not user-owned ones", async () => {
    const body = await configGetRoute.handler({});
    const profiles = wireProfiles(body);

    expect(profiles.balanced!.invariant).toBe(true);
    expect(profiles["os-beta"]!.invariant).toBe(true);
    expect(profiles["cost-optimized"]!).not.toHaveProperty("invariant");
    expect(profiles.custom!).not.toHaveProperty("invariant");
  });

  test("PATCH /v1/config stamps the flag on the response but never persists it", async () => {
    const body = await configPatchRoute.handler({
      body: { memory: { enabled: true } },
    });
    const profiles = wireProfiles(body);
    expect(profiles.balanced!.invariant).toBe(true);

    const savedProfiles = (
      savedRawConfig?.llm as { profiles: WireProfiles } | undefined
    )?.profiles;
    expect(savedProfiles).toBeDefined();
    for (const profile of Object.values(savedProfiles!)) {
      expect(profile).not.toHaveProperty("invariant");
    }
  });
});
