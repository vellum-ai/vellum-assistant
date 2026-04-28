import { describe, expect, mock, test } from "bun:test";

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => ({
    llm: {
      default: {
        contextWindow: {
          enabled: true,
          maxInputTokens: 200_000,
          compactThreshold: 0.8,
        },
      },
    },
  }),
}));

mock.module("../../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

mock.module("../../../../context/token-estimator.js", () => ({
  estimatePromptTokens: (messages: unknown[]): number => messages.length * 10,
}));

let _mockConversation: unknown = undefined;

mock.module("../helpers.js", () => ({
  getConversationById: async () => _mockConversation,
  listConversationsByTitlePrefix: () => [],
  deleteConversationById: () => false,
  createPlaygroundConversation: () => ({ id: "conv-test" }),
  addPlaygroundMessage: async () => ({ id: "msg-test" }),
}));

import type { Conversation } from "../../../../daemon/conversation.js";
import { RouteError } from "../../errors.js";
import { ROUTES } from "../index.js";
import { buildCompactionStateResponse } from "../state.js";

interface FakeConversationOverrides {
  messages?: unknown[];
  contextCompactedMessageCount?: number;
  contextCompactedAt?: number | null;
  consecutiveCompactionFailures?: number;
  compactionCircuitOpenUntil?: number | null;
}

function makeFakeConversation(
  overrides: FakeConversationOverrides = {},
): Conversation {
  const messages = overrides.messages ?? [];
  return {
    getMessages: () => messages,
    contextCompactedMessageCount: overrides.contextCompactedMessageCount ?? 0,
    contextCompactedAt: overrides.contextCompactedAt ?? null,
    consecutiveCompactionFailures: overrides.consecutiveCompactionFailures ?? 0,
    compactionCircuitOpenUntil: overrides.compactionCircuitOpenUntil ?? null,
  } as unknown as Conversation;
}

function findRoute() {
  const route = ROUTES.find(
    (r) => r.operationId === "playgroundGetCompactionState",
  );
  if (!route) throw new Error("compaction-state route not registered");
  return route;
}

async function invokeRoute(id = "conv-abc") {
  const route = findRoute();
  return route.handler({ pathParams: { id } });
}

describe("GET conversations/:id/playground/compaction-state", () => {
  test("registers the expected route definition", () => {
    const route = findRoute();
    expect(route.policyKey).toBe("conversations/playground/state");
    expect(route.tags).toEqual(["playground"]);
  });

  test("throws RouteError with conversation_not_found code when the conversation does not exist", async () => {
    _mockConversation = undefined;
    try {
      await invokeRoute("missing-id");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).code).toBe("conversation_not_found");
      expect((err as RouteError).message).toContain("missing-id");
    }
  });

  test("fresh conversation with no messages returns a baseline payload", async () => {
    _mockConversation = makeFakeConversation();
    const body = (await invokeRoute()) as ReturnType<
      typeof buildCompactionStateResponse
    >;
    expect(body.messageCount).toBe(0);
    expect(body.estimatedInputTokens).toBe(0);
    expect(body.maxInputTokens).toBe(200_000);
    expect(body.compactThresholdRatio).toBe(0.8);
    expect(body.thresholdTokens).toBe(160_000);
    expect(body.contextCompactedMessageCount).toBe(0);
    expect(body.contextCompactedAt).toBeNull();
    expect(body.consecutiveCompactionFailures).toBe(0);
    expect(body.compactionCircuitOpenUntil).toBeNull();
    expect(body.isCircuitOpen).toBe(false);
    expect(body.isCompactionEnabled).toBe(true);
  });

  test("open circuit breaker sets isCircuitOpen: true", async () => {
    const future = Date.now() + 5_000;
    _mockConversation = makeFakeConversation({
      compactionCircuitOpenUntil: future,
      consecutiveCompactionFailures: 3,
    });
    const body = (await invokeRoute()) as ReturnType<
      typeof buildCompactionStateResponse
    >;
    expect(body.compactionCircuitOpenUntil).toBe(future);
    expect(body.consecutiveCompactionFailures).toBe(3);
    expect(body.isCircuitOpen).toBe(true);
  });

  test("elapsed circuit-breaker deadline leaves isCircuitOpen: false", async () => {
    const past = Date.now() - 1_000;
    _mockConversation = makeFakeConversation({
      compactionCircuitOpenUntil: past,
    });
    const body = (await invokeRoute()) as ReturnType<
      typeof buildCompactionStateResponse
    >;
    expect(body.compactionCircuitOpenUntil).toBe(past);
    expect(body.isCircuitOpen).toBe(false);
  });

  test("full response shape matches the canonical CompactionStateResponse keys", async () => {
    _mockConversation = makeFakeConversation({
      messages: [{ role: "user" }, { role: "assistant" }],
      contextCompactedMessageCount: 2,
      contextCompactedAt: 1_700_000_000_000,
      consecutiveCompactionFailures: 1,
      compactionCircuitOpenUntil: null,
    });
    const body = (await invokeRoute()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        "estimatedInputTokens",
        "maxInputTokens",
        "compactThresholdRatio",
        "thresholdTokens",
        "messageCount",
        "contextCompactedMessageCount",
        "contextCompactedAt",
        "consecutiveCompactionFailures",
        "compactionCircuitOpenUntil",
        "isCircuitOpen",
        "isCompactionEnabled",
      ].sort(),
    );
    expect(body.messageCount).toBe(2);
    expect(body.estimatedInputTokens).toBe(20);
    expect(body.contextCompactedAt).toBe(1_700_000_000_000);
    expect(body.contextCompactedMessageCount).toBe(2);
  });
});

describe("buildCompactionStateResponse", () => {
  test("is exported for reuse by PR 7 / PR 8 consolidations", () => {
    const conversation = makeFakeConversation();
    const snapshot = buildCompactionStateResponse(conversation);
    expect(typeof snapshot.estimatedInputTokens).toBe("number");
    expect(typeof snapshot.isCircuitOpen).toBe("boolean");
  });
});
