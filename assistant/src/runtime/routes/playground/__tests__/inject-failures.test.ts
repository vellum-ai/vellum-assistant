/**
 * Tests for the inject-compaction-failures playground endpoint.
 *
 * This endpoint is dev-only (gated by the `compaction-playground` feature
 * flag) and directly mutates `consecutiveCompactionFailures` and/or
 * `compactionCircuitOpenUntil` on a live `Conversation`. It is used by the
 * macOS playground UI and integration tests to drive the circuit breaker
 * into interesting states without having to wait for three real summary
 * LLM failures.
 */
import { describe, expect, test } from "bun:test";

import type { Conversation } from "../../../../daemon/conversation.js";
import type { ServerMessage } from "../../../../daemon/message-protocol.js";
import type { RouteContext } from "../../../http-router.js";
import type { PlaygroundRouteDeps } from "../deps.js";
import { injectFailuresRouteDefinitions } from "../inject-failures.js";

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

function makeDeps(
  opts: {
    enabled?: boolean;
    conversation?: MockConversation | undefined;
  } = {},
): PlaygroundRouteDeps {
  const enabled = opts.enabled ?? true;
  const conversation = opts.conversation;
  return {
    isPlaygroundEnabled: () => enabled,
    getConversationById: (id) => {
      if (!conversation) return undefined;
      if (conversation.conversationId !== id) return undefined;
      return conversation as unknown as Conversation;
    },
    listConversationsByTitlePrefix: () => [],
    deleteConversationById: () => false,
    createConversation: async () => ({ id: "conv-test" }),
    addMessage: async () => ({ id: "msg-test" }),
  };
}

function getInjectRoute(deps: PlaygroundRouteDeps) {
  const routes = injectFailuresRouteDefinitions(deps);
  const route = routes.find(
    (r) =>
      r.endpoint ===
        "conversations/:id/playground/inject-compaction-failures" &&
      r.method === "POST",
  );
  if (!route) {
    throw new Error("inject-failures route not registered");
  }
  return route;
}

async function invoke(
  route: ReturnType<typeof getInjectRoute>,
  conversationId: string,
  body: unknown,
): Promise<Response> {
  const url = `http://localhost/v1/conversations/${conversationId}/playground/inject-compaction-failures`;
  const req = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return Promise.resolve(
    route.handler({
      req,
      url: new URL(url),
      params: { id: conversationId },
    } as unknown as RouteContext),
  );
}

describe("POST /v1/conversations/:id/playground/inject-compaction-failures", () => {
  test("returns 404 when the compaction-playground flag is disabled", async () => {
    const conversation = makeConversation();
    const deps = makeDeps({ enabled: false, conversation });
    const route = getInjectRoute(deps);

    const res = await invoke(route, conversation.conversationId, {});
    expect(res.status).toBe(404);

    // Flag-gated — the handler must not mutate conversation state or emit
    // events when the playground is disabled.
    expect(conversation.sentMessages).toHaveLength(0);
  });

  test("returns 404 when the conversation is missing", async () => {
    const deps = makeDeps({ enabled: true, conversation: undefined });
    const route = getInjectRoute(deps);

    const res = await invoke(route, "missing-conv-id", {});
    expect(res.status).toBe(404);

    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("mutates both fields and emits compaction_circuit_open when both provided", async () => {
    const conversation = makeConversation("conv-open");
    const deps = makeDeps({ enabled: true, conversation });
    const route = getInjectRoute(deps);

    const beforeNow = Date.now();
    const res = await invoke(route, conversation.conversationId, {
      consecutiveFailures: 3,
      circuitOpenForMs: 60_000,
    });
    const afterNow = Date.now();
    expect(res.status).toBe(200);

    expect(conversation.consecutiveCompactionFailures).toBe(3);
    expect(conversation.compactionCircuitOpenUntil).not.toBeNull();
    const openUntil = conversation.compactionCircuitOpenUntil!;
    expect(openUntil).toBeGreaterThanOrEqual(beforeNow + 60_000);
    expect(openUntil).toBeLessThanOrEqual(afterNow + 60_000);

    // Exactly one event emitted with the expected shape.
    expect(conversation.sentMessages).toHaveLength(1);
    expect(conversation.sentMessages[0]).toEqual({
      type: "compaction_circuit_open",
      conversationId: conversation.conversationId,
      reason: "3_consecutive_failures",
      openUntil,
    });
  });

  test("clears the circuit and emits compaction_circuit_closed on circuitOpenForMs: 0", async () => {
    const conversation = makeConversation("conv-close");
    // Start with an open breaker so the endpoint can clear it.
    conversation.compactionCircuitOpenUntil = Date.now() + 10_000;
    conversation.consecutiveCompactionFailures = 3;

    const deps = makeDeps({ enabled: true, conversation });
    const route = getInjectRoute(deps);

    const res = await invoke(route, conversation.conversationId, {
      circuitOpenForMs: 0,
    });
    expect(res.status).toBe(200);

    expect(conversation.compactionCircuitOpenUntil).toBeNull();
    // consecutiveFailures was not specified in the body, so it must be
    // unchanged (the endpoint only mutates fields that are explicitly set).
    expect(conversation.consecutiveCompactionFailures).toBe(3);

    expect(conversation.sentMessages).toHaveLength(1);
    expect(conversation.sentMessages[0]).toEqual({
      type: "compaction_circuit_closed",
      conversationId: conversation.conversationId,
    });
  });

  test("rejects out-of-range consecutiveFailures with 400", async () => {
    const conversation = makeConversation();
    const deps = makeDeps({ enabled: true, conversation });
    const route = getInjectRoute(deps);

    const res = await invoke(route, conversation.conversationId, {
      consecutiveFailures: 99, // above max (10)
    });
    expect(res.status).toBe(400);

    // No mutation, no event.
    expect(conversation.consecutiveCompactionFailures).toBe(0);
    expect(conversation.sentMessages).toHaveLength(0);
  });

  test("rejects out-of-range circuitOpenForMs with 400", async () => {
    const conversation = makeConversation();
    const deps = makeDeps({ enabled: true, conversation });
    const route = getInjectRoute(deps);

    const res = await invoke(route, conversation.conversationId, {
      circuitOpenForMs: 25 * 60 * 60 * 1000, // 25h, above the 24h cap
    });
    expect(res.status).toBe(400);

    expect(conversation.compactionCircuitOpenUntil).toBeNull();
    expect(conversation.sentMessages).toHaveLength(0);
  });

  test("rejects negative consecutiveFailures with 400", async () => {
    const conversation = makeConversation();
    const deps = makeDeps({ enabled: true, conversation });
    const route = getInjectRoute(deps);

    const res = await invoke(route, conversation.conversationId, {
      consecutiveFailures: -1,
    });
    expect(res.status).toBe(400);
    expect(conversation.consecutiveCompactionFailures).toBe(0);
  });

  test("response body includes the full CompactionStateResponse shape", async () => {
    const conversation = makeConversation("conv-shape");
    const deps = makeDeps({ enabled: true, conversation });
    const route = getInjectRoute(deps);

    const res = await invoke(route, conversation.conversationId, {
      consecutiveFailures: 2,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
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
