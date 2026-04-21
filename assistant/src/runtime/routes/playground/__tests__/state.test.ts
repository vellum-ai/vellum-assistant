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

// estimatePromptTokens has no external dependencies beyond its `messages`
// argument, but we mock it so the assertions here do not depend on the
// estimator's internal tuning.
mock.module("../../../../context/token-estimator.js", () => ({
  estimatePromptTokens: (messages: unknown[]): number => messages.length * 10,
}));

import type { Conversation } from "../../../../daemon/conversation.js";
import type { PlaygroundRouteDeps } from "../deps.js";
import { playgroundRouteDefinitions } from "../index.js";
import { buildCompactionStateResponse } from "../state.js";

function makeDeps(
  overrides: Partial<PlaygroundRouteDeps> = {},
): PlaygroundRouteDeps {
  return {
    getConversationById: () => undefined,
    isPlaygroundEnabled: () => true,
    ...overrides,
  };
}

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

function findStateRoute() {
  const routes = playgroundRouteDefinitions(makeDeps());
  const route = routes.find(
    (r) =>
      r.endpoint === "conversations/:id/playground/compaction-state" &&
      r.method === "GET",
  );
  if (!route) throw new Error("compaction-state route not registered");
  return route;
}

async function invokeRoute(
  deps: PlaygroundRouteDeps,
  id = "conv-abc",
): Promise<Response> {
  const routes = playgroundRouteDefinitions(deps);
  const route = routes.find(
    (r) =>
      r.endpoint === "conversations/:id/playground/compaction-state" &&
      r.method === "GET",
  );
  if (!route) throw new Error("compaction-state route not registered");
  // The handler only reads `params` from RouteContext — cast a minimal stub.
  return Promise.resolve(
    route.handler({
      params: { id },
    } as unknown as Parameters<typeof route.handler>[0]),
  );
}

describe("GET conversations/:id/playground/compaction-state", () => {
  test("registers the expected route definition", () => {
    const route = findStateRoute();
    expect(route.policyKey).toBe("conversations/playground/state");
    expect(route.tags).toEqual(["playground"]);
  });

  test("returns 404 when the playground flag is disabled", async () => {
    const deps = makeDeps({ isPlaygroundEnabled: () => false });
    const res = await invokeRoute(deps);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("returns 404 when the conversation does not exist", async () => {
    const deps = makeDeps({
      getConversationById: () => undefined,
    });
    const res = await invokeRoute(deps, "missing-id");
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("missing-id");
  });

  test("fresh conversation with no messages returns a baseline payload", async () => {
    const conversation = makeFakeConversation();
    const deps = makeDeps({
      getConversationById: () => conversation,
    });
    const res = await invokeRoute(deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<
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
    const conversation = makeFakeConversation({
      compactionCircuitOpenUntil: future,
      consecutiveCompactionFailures: 3,
    });
    const deps = makeDeps({
      getConversationById: () => conversation,
    });
    const res = await invokeRoute(deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<
      typeof buildCompactionStateResponse
    >;
    expect(body.compactionCircuitOpenUntil).toBe(future);
    expect(body.consecutiveCompactionFailures).toBe(3);
    expect(body.isCircuitOpen).toBe(true);
  });

  test("elapsed circuit-breaker deadline leaves isCircuitOpen: false", async () => {
    const past = Date.now() - 1_000;
    const conversation = makeFakeConversation({
      compactionCircuitOpenUntil: past,
    });
    const deps = makeDeps({
      getConversationById: () => conversation,
    });
    const res = await invokeRoute(deps);
    const body = (await res.json()) as ReturnType<
      typeof buildCompactionStateResponse
    >;
    expect(body.compactionCircuitOpenUntil).toBe(past);
    expect(body.isCircuitOpen).toBe(false);
  });

  test("full response shape matches the canonical CompactionStateResponse keys", async () => {
    const conversation = makeFakeConversation({
      messages: [{ role: "user" }, { role: "assistant" }],
      contextCompactedMessageCount: 2,
      contextCompactedAt: 1_700_000_000_000,
      consecutiveCompactionFailures: 1,
      compactionCircuitOpenUntil: null,
    });
    const deps = makeDeps({
      getConversationById: () => conversation,
    });
    const res = await invokeRoute(deps);
    const body = (await res.json()) as Record<string, unknown>;
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
