import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

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
  estimatePromptTokens: () => 1234,
}));

let _mockConversation: FakeConversation | undefined;

mock.module("../helpers.js", () => ({
  getConversationById: async () =>
    _mockConversation ? _mockConversation.conversation : undefined,
  listConversationsByTitlePrefix: () => [],
  deleteConversationById: () => false,
  createPlaygroundConversation: () => ({ id: "conv-test" }),
  addPlaygroundMessage: async () => ({ id: "msg-test" }),
}));

import type { Conversation } from "../../../../daemon/conversation.js";
import type { ServerMessage } from "../../../../daemon/message-protocol.js";
import { RouteError } from "../../errors.js";
import { ROUTES } from "../index.js";

interface FakeConversationState {
  consecutiveCompactionFailures: number;
  compactionCircuitOpenUntil: number | null;
  contextCompactedMessageCount: number;
  contextCompactedAt: number | null;
}

interface FakeConversation {
  conversation: Conversation;
  sent: ServerMessage[];
  state: FakeConversationState;
}

function makeFakeConversation(
  overrides: Partial<FakeConversationState> = {},
): FakeConversation {
  const state: FakeConversationState = {
    consecutiveCompactionFailures: 0,
    compactionCircuitOpenUntil: null,
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,
    ...overrides,
  };
  const sent: ServerMessage[] = [];
  const fake = {
    conversationId: "conv-abc",
    get consecutiveCompactionFailures(): number {
      return state.consecutiveCompactionFailures;
    },
    set consecutiveCompactionFailures(value: number) {
      state.consecutiveCompactionFailures = value;
    },
    get compactionCircuitOpenUntil(): number | null {
      return state.compactionCircuitOpenUntil;
    },
    set compactionCircuitOpenUntil(value: number | null) {
      state.compactionCircuitOpenUntil = value;
    },
    get contextCompactedMessageCount(): number {
      return state.contextCompactedMessageCount;
    },
    get contextCompactedAt(): number | null {
      return state.contextCompactedAt;
    },
    getMessages: () => [],
    sendToClient: (msg: ServerMessage) => {
      sent.push(msg);
    },
  } as unknown as Conversation;

  return { conversation: fake, sent, state };
}

function findRoute() {
  const route = ROUTES.find(
    (r) => r.operationId === "playgroundResetCompactionCircuit",
  );
  if (!route) throw new Error("reset-circuit route not registered");
  return route;
}

describe("reset-circuit route — metadata", () => {
  test("registers POST at conversations/:id/playground/reset-compaction-circuit", () => {
    const route = findRoute();
    expect(route.endpoint).toBe(
      "conversations/:id/playground/reset-compaction-circuit",
    );
    expect(route.method).toBe("POST");
    expect(route.policyKey).toBe("conversations/playground/reset-circuit");
    expect(route.tags).toContain("playground");
  });
});

describe("reset-circuit route — gating", () => {
  let fake: FakeConversation;

  beforeEach(() => {
    fake = makeFakeConversation();
    _mockConversation = fake;
  });

  test("throws RouteError with conversation_not_found code when the conversation is missing", async () => {
    _mockConversation = undefined;
    try {
      await findRoute().handler({ pathParams: { id: "missing-id" } });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).code).toBe("conversation_not_found");
      expect((err as RouteError).message).toContain("missing-id");
    }
  });
});

describe("reset-circuit route — behavior", () => {
  test("clears an open circuit and emits compaction_circuit_closed exactly once", async () => {
    const future = Date.now() + 60 * 60 * 1000;
    const fake = makeFakeConversation({
      consecutiveCompactionFailures: 2,
      compactionCircuitOpenUntil: future,
    });
    _mockConversation = fake;

    const body = (await findRoute().handler({
      pathParams: { id: "conv-abc" },
    })) as Record<string, unknown>;

    expect(fake.state.consecutiveCompactionFailures).toBe(0);
    expect(fake.state.compactionCircuitOpenUntil).toBeNull();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toEqual({
      type: "compaction_circuit_closed",
      conversationId: "conv-abc",
    });

    expect(body.consecutiveCompactionFailures).toBe(0);
    expect(body.compactionCircuitOpenUntil).toBeNull();
    expect(body.isCircuitOpen).toBe(false);
    expect(body.estimatedInputTokens).toBe(1234);
    expect(body.maxInputTokens).toBe(200_000);
    expect(body.compactThresholdRatio).toBe(0.8);
    expect(body.thresholdTokens).toBe(160_000);
    expect(body.messageCount).toBe(0);
    expect(body.contextCompactedMessageCount).toBe(0);
    expect(body.contextCompactedAt).toBeNull();
    expect(body.isCompactionEnabled).toBe(true);
  });

  test("with the circuit already closed, zeroes the counter without emitting an event", async () => {
    const fake = makeFakeConversation({
      consecutiveCompactionFailures: 2,
      compactionCircuitOpenUntil: null,
    });
    _mockConversation = fake;

    const body = (await findRoute().handler({
      pathParams: { id: "conv-abc" },
    })) as Record<string, unknown>;

    expect(fake.state.consecutiveCompactionFailures).toBe(0);
    expect(fake.state.compactionCircuitOpenUntil).toBeNull();
    expect(fake.sent).toHaveLength(0);

    expect(body.consecutiveCompactionFailures).toBe(0);
    expect(body.compactionCircuitOpenUntil).toBeNull();
    expect(body.isCircuitOpen).toBe(false);
  });
});
