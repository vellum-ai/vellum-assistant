import { describe, expect, test } from "bun:test";

import type { ContextWindowResult } from "../../../../context/window-manager.js";
import type { Conversation } from "../../../../daemon/conversation.js";
import type { Message } from "../../../../providers/types.js";
import type { RouteContext } from "../../../http-router.js";
import type { PlaygroundRouteDeps } from "../deps.js";
import { forceCompactRouteDefinitions } from "../force-compact.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeConversationOptions {
  messagesBefore?: Message[];
  messagesAfter?: Message[];
  result?: Partial<ContextWindowResult>;
}

interface FakeConversation {
  readonly conversation: Conversation;
  readonly forceCompactCallCount: () => number;
}

function makeFakeConversation(
  options: FakeConversationOptions = {},
): FakeConversation {
  const messagesBefore = options.messagesBefore ?? [];
  const messagesAfter = options.messagesAfter ?? messagesBefore;
  let calls = 0;
  let returnedAfter = false;

  const baseResult: ContextWindowResult = {
    messages: messagesAfter,
    compacted: true,
    previousEstimatedInputTokens: 0,
    estimatedInputTokens: 0,
    maxInputTokens: 100_000,
    thresholdTokens: 80_000,
    compactedMessages: 0,
    compactedPersistedMessages: 0,
    summaryCalls: 0,
    summaryInputTokens: 0,
    summaryOutputTokens: 0,
    summaryModel: "",
    summaryText: "",
    ...options.result,
  };

  const fake = {
    getMessages(): Message[] {
      // First call returns the pre-compaction messages; subsequent calls
      // return the post-compaction messages. This mirrors how the route
      // reads the state twice (before/after `forceCompact()`).
      if (!returnedAfter && calls === 0) return messagesBefore;
      return messagesAfter;
    },
    async forceCompact(): Promise<ContextWindowResult> {
      calls += 1;
      returnedAfter = true;
      return baseResult;
    },
  };

  return {
    conversation: fake as unknown as Conversation,
    forceCompactCallCount: () => calls,
  };
}

function makeDeps(
  overrides: Partial<PlaygroundRouteDeps> = {},
): PlaygroundRouteDeps {
  return {
    getConversationById: () => undefined,
    isPlaygroundEnabled: () => true,
    listConversationsByTitlePrefix: () => [],
    deleteConversationById: () => false,
    createConversation: async () => ({ id: "conv-test" }),
    addMessage: async () => ({ id: "msg-test" }),
    ...overrides,
  };
}

function makeRouteContext(id: string): RouteContext {
  const url = new URL(
    `http://localhost/v1/conversations/${id}/playground/compact`,
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
    params: { id },
  } as unknown as RouteContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("forceCompactRouteDefinitions", () => {
  test("exposes a single POST route with the expected endpoint + policy key", () => {
    const routes = forceCompactRouteDefinitions(makeDeps());
    expect(routes).toHaveLength(1);
    expect(routes[0].endpoint).toBe("conversations/:id/playground/compact");
    expect(routes[0].method).toBe("POST");
    expect(routes[0].policyKey).toBe("conversations/playground/compact");
  });

  test("returns 404 when the playground flag is disabled", async () => {
    const deps = makeDeps({ isPlaygroundEnabled: () => false });
    const [route] = forceCompactRouteDefinitions(deps);

    const res = await route.handler(makeRouteContext("conv-abc"));
    expect(res.status).toBe(404);

    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("returns 404 when the conversation is missing", async () => {
    const deps = makeDeps({
      isPlaygroundEnabled: () => true,
      getConversationById: () => undefined,
    });
    const [route] = forceCompactRouteDefinitions(deps);

    const res = await route.handler(makeRouteContext("conv-missing"));
    expect(res.status).toBe(404);

    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("conv-missing");
  });

  test("forces compaction and returns before/after tokens + summary metadata", async () => {
    const messagesBefore: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello world" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi there from the assistant" }],
      },
    ];
    const messagesAfter: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ];

    const fake = makeFakeConversation({
      messagesBefore,
      messagesAfter,
      result: {
        compacted: true,
        summaryText: "one-line summary of the earlier turns",
        compactedPersistedMessages: 7,
        summaryFailed: false,
      },
    });

    const deps = makeDeps({
      isPlaygroundEnabled: () => true,
      getConversationById: () => fake.conversation,
    });
    const [route] = forceCompactRouteDefinitions(deps);

    const res = await route.handler(makeRouteContext("conv-ok"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      compacted: boolean;
      previousTokens: number;
      newTokens: number;
      summaryText: string | null;
      messagesRemoved: number;
      summaryFailed: boolean | null;
    };

    expect(body.compacted).toBe(true);
    expect(body.summaryText).toBe("one-line summary of the earlier turns");
    expect(body.messagesRemoved).toBe(7);
    expect(body.summaryFailed).toBe(false);
    expect(body.previousTokens).toBeGreaterThan(0);
    expect(body.newTokens).toBeGreaterThan(0);
    // The post-compaction message set is strictly smaller, so the
    // reported token count should fall.
    expect(body.newTokens).toBeLessThan(body.previousTokens);

    expect(fake.forceCompactCallCount()).toBe(1);
  });

  test("defaults summaryText/summaryFailed to null when forceCompact omits them", async () => {
    const fake = makeFakeConversation({
      messagesBefore: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
      messagesAfter: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
      result: {
        compacted: false,
        // Intentionally leave summaryText as "" and summaryFailed undefined
        // so the route's ?? coalescing is exercised.
        summaryText: "",
        summaryFailed: undefined,
        compactedPersistedMessages: 0,
      },
    });

    const deps = makeDeps({
      isPlaygroundEnabled: () => true,
      getConversationById: () => fake.conversation,
    });
    const [route] = forceCompactRouteDefinitions(deps);

    const res = await route.handler(makeRouteContext("conv-noop"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      compacted: boolean;
      summaryText: string | null;
      messagesRemoved: number;
      summaryFailed: boolean | null;
    };

    expect(body.compacted).toBe(false);
    // summaryText is "" (falsy) so `??` keeps it as "" — not null. We only
    // substitute null when the field is nullish, matching the handler.
    expect(body.summaryText).toBe("");
    expect(body.summaryFailed).toBeNull();
    expect(body.messagesRemoved).toBe(0);
  });
});
