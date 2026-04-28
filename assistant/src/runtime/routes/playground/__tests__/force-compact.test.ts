import { describe, expect, mock, test } from "bun:test";

let _mockConversation: unknown = undefined;

mock.module("../../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => ({}),
}));

mock.module("../helpers.js", () => ({
  getConversationById: async () => _mockConversation,
  listConversationsByTitlePrefix: () => [],
  deleteConversationById: () => false,
  createPlaygroundConversation: () => ({ id: "conv-test" }),
  addPlaygroundMessage: async () => ({ id: "msg-test" }),
}));

import type { ContextWindowResult } from "../../../../context/window-manager.js";
import type { Conversation } from "../../../../daemon/conversation.js";
import type { Message } from "../../../../providers/types.js";
import { RouteError } from "../../errors.js";
import { ROUTES } from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeConversationOptions {
  messagesBefore?: Message[];
  messagesAfter?: Message[];
  result?: Partial<ContextWindowResult>;
  processing?: boolean;
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
    processing: options.processing ?? false,
    getMessages(): Message[] {
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

function findRoute() {
  const route = ROUTES.find(
    (r) => r.operationId === "playgroundForceCompact",
  );
  if (!route) throw new Error("force-compact route not registered");
  return route;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("playgroundForceCompact", () => {
  test("exposes a single POST route with the expected endpoint + policy key", () => {
    const route = findRoute();
    expect(route.endpoint).toBe("conversations/:id/playground/compact");
    expect(route.method).toBe("POST");
    expect(route.policyKey).toBe("conversations/playground/compact");
  });

  test("throws RouteError with conversation_not_found code when the conversation is missing", async () => {
    _mockConversation = undefined;
    try {
      await findRoute().handler({ pathParams: { id: "conv-missing" } });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).code).toBe("conversation_not_found");
      expect((err as RouteError).message).toContain("conv-missing");
    }
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

    _mockConversation = fake.conversation;

    const body = (await findRoute().handler({
      pathParams: { id: "conv-ok" },
    })) as {
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
    expect(body.newTokens).toBeLessThan(body.previousTokens);

    expect(fake.forceCompactCallCount()).toBe(1);
  });

  test("throws ConflictError when conversation is already processing", async () => {
    const fake = makeFakeConversation({
      messagesBefore: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
      processing: true,
    });

    _mockConversation = fake.conversation;

    try {
      await findRoute().handler({ pathParams: { id: "conv-busy" } });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(409);
      expect((err as RouteError).code).toBe("CONFLICT");
      expect((err as RouteError).message).toContain("already in progress");
    }

    expect(fake.forceCompactCallCount()).toBe(0);
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
        summaryText: "",
        summaryFailed: undefined,
        compactedPersistedMessages: 0,
      },
    });

    _mockConversation = fake.conversation;

    const body = (await findRoute().handler({
      pathParams: { id: "conv-noop" },
    })) as {
      compacted: boolean;
      summaryText: string | null;
      messagesRemoved: number;
      summaryFailed: boolean | null;
    };

    expect(body.compacted).toBe(false);
    expect(body.summaryText).toBe("");
    expect(body.summaryFailed).toBeNull();
    expect(body.messagesRemoved).toBe(0);
  });
});
