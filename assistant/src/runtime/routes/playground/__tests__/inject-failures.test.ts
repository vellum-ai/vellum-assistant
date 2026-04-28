/**
 * Tests for the inject-compaction-failures playground endpoint.
 */
import { describe, expect, mock, test } from "bun:test";

import type { Conversation } from "../../../../daemon/conversation.js";
import type { ServerMessage } from "../../../../daemon/message-protocol.js";

let _mockConversation: MockConversation | undefined;

mock.module("../../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

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

mock.module("../../../../context/token-estimator.js", () => ({
  estimatePromptTokens: (messages: unknown[]): number => messages.length * 10,
}));

mock.module("../helpers.js", () => ({
  getConversationById: async (id: string) => {
    if (!_mockConversation) return undefined;
    if (_mockConversation.conversationId !== id) return undefined;
    return _mockConversation as unknown as Conversation;
  },
  listConversationsByTitlePrefix: () => [],
  deleteConversationById: () => false,
  createPlaygroundConversation: () => ({ id: "conv-test" }),
  addPlaygroundMessage: async () => ({ id: "msg-test" }),
}));

import { RouteError } from "../../errors.js";
import { ROUTES } from "../index.js";

interface MockConversation {
  readonly conversationId: string;
  consecutiveCompactionFailures: number;
  compactionCircuitOpenUntil: number | null;
  contextCompactedMessageCount: number;
  contextCompactedAt: number | null;
  sentMessages: ServerMessage[];
  sendToClient: (msg: ServerMessage) => void;
  getMessages: () => unknown[];
}

function makeConversation(id = "conv-playground-test"): MockConversation {
  const sentMessages: ServerMessage[] = [];
  return {
    conversationId: id,
    consecutiveCompactionFailures: 0,
    compactionCircuitOpenUntil: null,
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,
    sentMessages,
    sendToClient: (msg) => sentMessages.push(msg),
    getMessages: () => [],
  };
}

function findRoute() {
  const route = ROUTES.find(
    (r) => r.operationId === "playgroundInjectCompactionFailures",
  );
  if (!route) throw new Error("inject-failures route not registered");
  return route;
}

async function invoke(conversationId: string, body: unknown) {
  return findRoute().handler({
    pathParams: { id: conversationId },
    body: body as Record<string, unknown>,
  });
}

describe("POST /v1/conversations/:id/playground/inject-compaction-failures", () => {
  test("throws RouteError with conversation_not_found code when the conversation is missing", async () => {
    _mockConversation = undefined;
    try {
      await invoke("missing-conv-id", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).code).toBe("conversation_not_found");
      expect((err as RouteError).message).toContain("missing-conv-id");
    }
  });

  test("mutates both fields and emits compaction_circuit_open when both provided", async () => {
    const conversation = makeConversation("conv-open");
    _mockConversation = conversation;

    const beforeNow = Date.now();
    const body = (await invoke(conversation.conversationId, {
      consecutiveFailures: 3,
      circuitOpenForMs: 60_000,
    })) as Record<string, unknown>;
    const afterNow = Date.now();

    expect(conversation.consecutiveCompactionFailures).toBe(3);
    expect(conversation.compactionCircuitOpenUntil).not.toBeNull();
    const openUntil = conversation.compactionCircuitOpenUntil!;
    expect(openUntil).toBeGreaterThanOrEqual(beforeNow + 60_000);
    expect(openUntil).toBeLessThanOrEqual(afterNow + 60_000);

    expect(conversation.sentMessages).toHaveLength(1);
    expect(conversation.sentMessages[0]).toEqual({
      type: "compaction_circuit_open",
      conversationId: conversation.conversationId,
      reason: "3_consecutive_failures",
      openUntil,
    });

    expect(body.consecutiveCompactionFailures).toBe(3);
  });

  test("clears the circuit and emits compaction_circuit_closed on circuitOpenForMs: 0", async () => {
    const conversation = makeConversation("conv-close");
    conversation.compactionCircuitOpenUntil = Date.now() + 10_000;
    conversation.consecutiveCompactionFailures = 3;
    _mockConversation = conversation;

    await invoke(conversation.conversationId, {
      circuitOpenForMs: 0,
    });

    expect(conversation.compactionCircuitOpenUntil).toBeNull();
    expect(conversation.consecutiveCompactionFailures).toBe(3);

    expect(conversation.sentMessages).toHaveLength(1);
    expect(conversation.sentMessages[0]).toEqual({
      type: "compaction_circuit_closed",
      conversationId: conversation.conversationId,
    });
  });

  test("is a no-op on the event channel when circuitOpenForMs: 0 but the breaker is already closed", async () => {
    const conversation = makeConversation("conv-already-closed");
    expect(conversation.compactionCircuitOpenUntil).toBeNull();
    _mockConversation = conversation;

    const body = (await invoke(conversation.conversationId, {
      circuitOpenForMs: 0,
    })) as Record<string, unknown>;

    expect(conversation.compactionCircuitOpenUntil).toBeNull();
    expect(conversation.sentMessages).toHaveLength(0);
    expect(body.compactionCircuitOpenUntil).toBeNull();
    expect(body.isCircuitOpen).toBe(false);
  });

  test("throws BadRequestError for out-of-range consecutiveFailures", async () => {
    const conversation = makeConversation();
    _mockConversation = conversation;

    try {
      await invoke(conversation.conversationId, {
        consecutiveFailures: 99,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(400);
    }

    expect(conversation.consecutiveCompactionFailures).toBe(0);
    expect(conversation.sentMessages).toHaveLength(0);
  });

  test("throws BadRequestError for out-of-range circuitOpenForMs", async () => {
    const conversation = makeConversation();
    _mockConversation = conversation;

    try {
      await invoke(conversation.conversationId, {
        circuitOpenForMs: 25 * 60 * 60 * 1000,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(400);
    }

    expect(conversation.compactionCircuitOpenUntil).toBeNull();
    expect(conversation.sentMessages).toHaveLength(0);
  });

  test("throws BadRequestError for negative consecutiveFailures", async () => {
    const conversation = makeConversation();
    _mockConversation = conversation;

    try {
      await invoke(conversation.conversationId, {
        consecutiveFailures: -1,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(400);
    }
    expect(conversation.consecutiveCompactionFailures).toBe(0);
  });

  test("response body includes the full CompactionStateResponse shape", async () => {
    const conversation = makeConversation("conv-shape");
    _mockConversation = conversation;

    const body = (await invoke(conversation.conversationId, {
      consecutiveFailures: 2,
    })) as Record<string, unknown>;

    const requiredKeys = [
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
    ];
    for (const key of requiredKeys) {
      expect(body).toHaveProperty(key);
    }
    expect(body.consecutiveCompactionFailures).toBe(2);
    expect(body.isCircuitOpen).toBe(false);
    expect(body.compactionCircuitOpenUntil).toBeNull();
    expect(typeof body.estimatedInputTokens).toBe("number");
    expect(typeof body.maxInputTokens).toBe("number");
    expect(typeof body.compactThresholdRatio).toBe("number");
    expect(typeof body.thresholdTokens).toBe("number");
    expect(typeof body.messageCount).toBe("number");
    expect(typeof body.isCompactionEnabled).toBe("boolean");
  });
});
