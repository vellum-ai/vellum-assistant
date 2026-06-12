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
} from "../../../memory/__tests__/fixtures/memory-v2-activation-fixtures.js";

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

mock.module("../../../memory/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {
    clearEmbeddingBackendCacheCalls += 1;
  },
}));

import type { ConversationCreateType } from "../../../memory/conversation-crud.js";
import { getDb } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import {
  backfillMemoryV2ActivationMessageId,
  type MemoryV2ConceptRowRecord,
  type MemoryV2ConfigSnapshot,
  recordMemoryV2ActivationLog,
} from "../../../memory/memory-v2-activation-log-store.js";
import {
  conversationKeys,
  conversations,
  llmRequestLogs,
  memoryV2ActivationLogs,
  messages,
} from "../../../memory/schema.js";
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

initializeDb();

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
  db.delete(llmRequestLogs).run();
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
      ...(options.agentLoopExitReason != null
        ? { agentLoopExitReason: options.agentLoopExitReason }
        : {}),
    })
    .run();
}

function seedRequestLogWithSections(messageId: string, id: string): void {
  getDb()
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
    getDb()
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
    getDb()
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
    getDb()
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
    expect(savedProfile.maxTokens).toBeUndefined();
    expect(savedProfile.contextWindow).toEqual({
      targetBudgetRatio: 0.3,
      summaryBudgetRatio: 0.08,
      overflowRecovery: {
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

    expect(savedProfile.contextWindow).toEqual({
      maxInputTokens: 150000,
      targetBudgetRatio: 0.3,
      summaryBudgetRatio: 0.08,
      overflowRecovery: {
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

    // The canonical "openai-managed" connection exists in the test DB;
    // the route auto-derives it when the UI omits provider_connection.
    expect(savedProfile.provider_connection).toBe("openai-managed");
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
      // Seed a managed profile alongside the existing custom one.
      (rawConfigFixture.llm as { profiles: Record<string, unknown> }).profiles[
        "balanced"
      ] = {
        source: "managed",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        label: "Balanced",
        status: "active",
      };
    });

    test("allows label edit on managed profile, preserving seed fields", async () => {
      const result = await replaceProfileRoute.handler({
        pathParams: { name: "balanced" },
        body: { label: "My Balanced" },
      });

      expect(result).toEqual({ ok: true });
      const savedProfile = (
        savedRawConfig?.llm as {
          profiles: Record<string, Record<string, unknown>>;
        }
      ).profiles.balanced;

      expect(savedProfile.label).toBe("My Balanced");
      // Seed fields preserved.
      expect(savedProfile.provider).toBe("anthropic");
      expect(savedProfile.model).toBe("claude-sonnet-4-6");
      expect(savedProfile.source).toBe("managed");
    });

    test("allows status edit on managed profile", async () => {
      const result = await replaceProfileRoute.handler({
        pathParams: { name: "balanced" },
        body: { status: "disabled" },
      });

      expect(result).toEqual({ ok: true });
      const savedProfile = (
        savedRawConfig?.llm as {
          profiles: Record<string, Record<string, unknown>>;
        }
      ).profiles.balanced;

      expect(savedProfile.status).toBe("disabled");
      expect(savedProfile.provider).toBe("anthropic");
    });

    test("allows label+status edit together", async () => {
      const result = await replaceProfileRoute.handler({
        pathParams: { name: "balanced" },
        body: { label: "Renamed", status: "disabled" },
      });

      expect(result).toEqual({ ok: true });
      const savedProfile = (
        savedRawConfig?.llm as {
          profiles: Record<string, Record<string, unknown>>;
        }
      ).profiles.balanced;

      expect(savedProfile.label).toBe("Renamed");
      expect(savedProfile.status).toBe("disabled");
    });

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

    test("rejects mixed allowed+disallowed fields", async () => {
      // label is allowed but maxTokens is not — must reject without partially
      // applying label, so saver should never be invoked.
      await expect(
        replaceProfileRoute.handler({
          pathParams: { name: "balanced" },
          body: { label: "Try", maxTokens: 999 },
        }),
      ).rejects.toThrow(
        /Cannot edit managed profile "balanced" fields \[maxTokens\]/,
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
    test("status flip on managed profile triggers provider reinit + cache invalidation", async () => {
      // Seed a managed profile that the user will disable. commitConfigWrite
      // must reinit the provider registry so the status change is reflected
      // in the running daemon immediately, not at the next watcher tick.
      (rawConfigFixture.llm as { profiles: Record<string, unknown> }).profiles[
        "balanced"
      ] = {
        source: "managed",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        label: "Balanced",
        status: "active",
      };

      const result = await replaceProfileRoute.handler({
        pathParams: { name: "balanced" },
        body: { status: "disabled" },
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
