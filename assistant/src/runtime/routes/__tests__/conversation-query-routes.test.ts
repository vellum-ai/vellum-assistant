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
  db.delete(messages).run();
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
