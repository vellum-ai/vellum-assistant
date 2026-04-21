import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports of the modules under test.
// ---------------------------------------------------------------------------

mock.module("../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
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

// ---------------------------------------------------------------------------
// Imports under test — after mocks.
// ---------------------------------------------------------------------------

import type { Conversation } from "../../../../daemon/conversation.js";
import type { ServerMessage } from "../../../../daemon/message-protocol.js";
import type { RouteContext, RouteDefinition } from "../../../http-router.js";
import type { PlaygroundRouteDeps } from "../deps.js";
import { resetCircuitRouteDefinitions } from "../reset-circuit.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

function makeDeps(
  overrides: Partial<PlaygroundRouteDeps> = {},
): PlaygroundRouteDeps {
  return {
    getConversationById: () => undefined,
    isPlaygroundEnabled: () => true,
    ...overrides,
  };
}

function makeRouteContext(conversationId: string): RouteContext {
  const url = new URL(
    `http://localhost/v1/conversations/${conversationId}/playground/reset-compaction-circuit`,
  );
  return {
    req: new Request(url, { method: "POST" }),
    url,
    server: {} as RouteContext["server"],
    authContext: {
      subject: "test-user",
      principalType: "local",
      assistantId: "self",
      scopeProfile: "local_v1",
      scopes: new Set(["local.all" as const]),
      policyEpoch: 0,
    },
    params: { id: conversationId },
  } as unknown as RouteContext;
}

function getHandler(deps: PlaygroundRouteDeps): RouteDefinition["handler"] {
  const routes = resetCircuitRouteDefinitions(deps);
  expect(routes).toHaveLength(1);
  return routes[0].handler;
}

async function readJsonBody(response: Response): Promise<unknown> {
  return response.json();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reset-circuit route — metadata", () => {
  test("registers POST at conversations/:id/playground/reset-compaction-circuit", () => {
    const routes = resetCircuitRouteDefinitions(makeDeps());
    expect(routes).toHaveLength(1);
    const route = routes[0];
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
  });

  test("returns 404 when the playground flag is disabled", async () => {
    const deps = makeDeps({
      isPlaygroundEnabled: () => false,
      getConversationById: () => fake.conversation,
    });
    const handler = getHandler(deps);

    const response = (await handler(makeRouteContext("conv-abc"))) as Response;

    expect(response.status).toBe(404);
    const body = (await readJsonBody(response)) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("NOT_FOUND");
    // State must not be mutated and no event emitted on the disabled path.
    expect(fake.state.consecutiveCompactionFailures).toBe(0);
    expect(fake.state.compactionCircuitOpenUntil).toBeNull();
    expect(fake.sent).toHaveLength(0);
  });

  test("returns 404 when the conversation is missing", async () => {
    const deps = makeDeps({
      getConversationById: () => undefined,
    });
    const handler = getHandler(deps);

    const response = (await handler(
      makeRouteContext("missing-id"),
    )) as Response;

    expect(response.status).toBe(404);
    const body = (await readJsonBody(response)) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("missing-id");
  });
});

describe("reset-circuit route — behavior", () => {
  test("clears an open circuit and emits compaction_circuit_closed exactly once", async () => {
    const future = Date.now() + 60 * 60 * 1000;
    const fake = makeFakeConversation({
      consecutiveCompactionFailures: 2,
      compactionCircuitOpenUntil: future,
    });
    const deps = makeDeps({
      getConversationById: () => fake.conversation,
    });
    const handler = getHandler(deps);

    const response = (await handler(makeRouteContext("conv-abc"))) as Response;

    expect(response.status).toBe(200);
    expect(fake.state.consecutiveCompactionFailures).toBe(0);
    expect(fake.state.compactionCircuitOpenUntil).toBeNull();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toEqual({
      type: "compaction_circuit_closed",
      conversationId: "conv-abc",
    });

    const body = (await readJsonBody(response)) as Record<string, unknown>;
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
    const deps = makeDeps({
      getConversationById: () => fake.conversation,
    });
    const handler = getHandler(deps);

    const response = (await handler(makeRouteContext("conv-abc"))) as Response;

    expect(response.status).toBe(200);
    expect(fake.state.consecutiveCompactionFailures).toBe(0);
    expect(fake.state.compactionCircuitOpenUntil).toBeNull();
    // Do not emit compaction_circuit_closed when the breaker was already
    // closed — the event is reserved for the open→closed transition so the
    // Swift banner doesn't receive redundant "paused" dismissals.
    expect(fake.sent).toHaveLength(0);

    const body = (await readJsonBody(response)) as Record<string, unknown>;
    expect(body.consecutiveCompactionFailures).toBe(0);
    expect(body.compactionCircuitOpenUntil).toBeNull();
    expect(body.isCircuitOpen).toBe(false);
  });
});
