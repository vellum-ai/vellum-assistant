/**
 * Unit tests for the home-feed rollup producer.
 *
 * All dependencies are injected via `RollupProducerDeps` spies so the
 * tests never touch `mock.module`, which leaks across files in Bun's
 * test runner. The production caller passes `undefined` and the
 * producer falls through to the real config loader, feed reader,
 * relationship-state reader, and provider registry.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ContentBlock,
  Provider,
  ProviderResponse,
} from "../../providers/types.js";
import type { WriteAssistantFeedItemParams } from "../assistant-feed-authoring.js";
import type { FeedItem } from "../feed-types.js";
import { runRollupProducer } from "../rollup-producer.js";

const writeItem = mock<
  (params: WriteAssistantFeedItemParams) => Promise<unknown>
>(async () => ({}));

const stubRelationshipState = async () =>
  ({
    version: 1,
    assistantId: "self",
    tier: 2,
    progressPercent: 42,
    facts: [
      { category: "voice", text: "Ships fast, explains the why." },
      { category: "priorities", text: "JARVIS is the current focus." },
    ],
    capabilities: [],
    conversationCount: 17,
    hatchedDate: "2026-03-01T00:00:00.000Z",
    assistantName: "Vellum",
    userName: "Alex",
    updatedAt: "2026-04-14T12:00:00.000Z",
    // biome-ignore lint/suspicious/noExplicitAny: the real shape is
    // internal-only and we only need the subset the producer reads.
  }) as any;

function makeAction(overrides: Partial<FeedItem> & { id: string }): FeedItem {
  return {
    id: overrides.id,
    type: "action",
    priority: 50,
    title: overrides.title ?? "Action title",
    summary: overrides.summary ?? "Action summary.",
    timestamp: overrides.timestamp ?? "2026-04-14T12:00:00.000Z",
    status: overrides.status ?? "new",
    author: overrides.author ?? "assistant",
    createdAt: overrides.createdAt ?? "2026-04-14T12:00:00.000Z",
    source: overrides.source,
    expiresAt: overrides.expiresAt,
    minTimeAway: overrides.minTimeAway,
    actions: overrides.actions,
  };
}

const stubLoadRecentActions = (items: FeedItem[]) => () => items;

function makeProvider(
  handler: (
    messages: Parameters<Provider["sendMessage"]>[0],
    tools: Parameters<Provider["sendMessage"]>[1],
    systemPrompt: Parameters<Provider["sendMessage"]>[2],
    options: Parameters<Provider["sendMessage"]>[3],
  ) => Promise<ProviderResponse>,
): Provider {
  return {
    name: "mock",
    sendMessage: handler,
  };
}

function scriptedProvider(content: ContentBlock[]): Provider {
  return makeProvider(async () => ({
    content,
    model: "mock-model",
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "tool_use",
  }));
}

function throwingProvider(error: Error): Provider {
  return makeProvider(async () => {
    throw error;
  });
}

function toolUseContent(input: unknown): ContentBlock {
  return {
    type: "tool_use",
    id: "tu_1",
    name: "write_feed_items",
    input: input as Record<string, unknown>,
  };
}

const oneAction: FeedItem[] = [
  makeAction({
    id: "a1",
    source: "gmail",
    title: "Replied to Alice",
    summary: "Sent a reply to alice@example.com.",
    createdAt: "2026-04-14T11:30:00.000Z",
  }),
];

beforeEach(() => {
  writeItem.mockClear();
});

describe("runRollupProducer", () => {
  test("writes each digest/thread returned in the tool call", async () => {
    const provider = scriptedProvider([
      toolUseContent({
        items: [
          {
            type: "digest",
            source: "gmail",
            title: "3 replies sent this morning",
            summary: "Replied to Alice, Bob, and Carol over the past hour.",
            priority: 70,
          },
          {
            type: "thread",
            source: "assistant",
            title: "Outreach sequence 'Q2 renewals'",
            summary: "Step 1 sent to 2 of 5 contacts; awaiting replies.",
            priority: 55,
          },
        ],
      }),
    ]);

    const result = await runRollupProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      loadRecentActions: stubLoadRecentActions(oneAction),
      resolveProvider: () => provider,
    });

    expect(result.skippedReason).toBeNull();
    expect(result.wroteCount).toBe(2);
    expect(writeItem).toHaveBeenCalledTimes(2);
    const firstCall = writeItem.mock.calls[0]![0];
    expect(firstCall.type).toBe("digest");
    expect(firstCall.title).toBe("3 replies sent this morning");
    expect(firstCall.priority).toBe(70);
  });

  test("returns no_actions when the activity log is empty", async () => {
    // When there's nothing to roll up, we don't even hit the provider.
    // The scheduler uses this to avoid advancing the cooldown gate.
    const provider = scriptedProvider([toolUseContent({ items: [] })]);
    const providerSpy = mock(provider.sendMessage);
    provider.sendMessage = providerSpy;

    const result = await runRollupProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      loadRecentActions: stubLoadRecentActions([]),
      resolveProvider: () => provider,
    });

    expect(result.skippedReason).toBe("no_actions");
    expect(result.wroteCount).toBe(0);
    expect(providerSpy).not.toHaveBeenCalled();
    expect(writeItem).not.toHaveBeenCalled();
  });

  test("serializes recent actions into the user prompt", async () => {
    let capturedPrompt = "";
    const provider = makeProvider(async (messages) => {
      capturedPrompt = messages
        .flatMap((m) => m.content)
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return {
        content: [toolUseContent({ items: [] })],
        model: "mock-model",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "tool_use",
      };
    });

    const actions: FeedItem[] = [
      makeAction({
        id: "a1",
        source: "gmail",
        title: "Replied to Alice",
        summary: "Sent a reply to alice@example.com.",
        createdAt: "2026-04-14T11:30:00.000Z",
      }),
      makeAction({
        id: "a2",
        source: "slack",
        title: "Posted in #general",
        summary: "Answered a question about the deploy.",
        createdAt: "2026-04-14T11:45:00.000Z",
      }),
    ];

    await runRollupProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      loadRecentActions: stubLoadRecentActions(actions),
      resolveProvider: () => provider,
    });

    expect(capturedPrompt).toContain("Replied to Alice");
    expect(capturedPrompt).toContain("alice@example.com");
    expect(capturedPrompt).toContain("Posted in #general");
    expect(capturedPrompt).toContain("[gmail]");
    expect(capturedPrompt).toContain("[slack]");
  });

  test("returns empty_items when the model emits an empty items array", async () => {
    const provider = scriptedProvider([toolUseContent({ items: [] })]);

    const result = await runRollupProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      loadRecentActions: stubLoadRecentActions(oneAction),
      resolveProvider: () => provider,
    });

    expect(result.skippedReason).toBe("empty_items");
    expect(result.wroteCount).toBe(0);
    expect(writeItem).not.toHaveBeenCalled();
  });

  test("caps the batch at MAX_ITEMS_PER_ROLLUP (3)", async () => {
    const provider = scriptedProvider([
      toolUseContent({
        items: [
          { type: "digest", title: "One", summary: "One summary" },
          { type: "digest", title: "Two", summary: "Two summary" },
          { type: "thread", title: "Three", summary: "Three summary" },
          {
            type: "digest",
            title: "Four",
            summary: "Four summary — should be dropped.",
          },
        ],
      }),
    ]);

    const result = await runRollupProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      loadRecentActions: stubLoadRecentActions(oneAction),
      resolveProvider: () => provider,
    });

    expect(result.wroteCount).toBe(3);
    expect(writeItem).toHaveBeenCalledTimes(3);
  });

  test("rejects nudge and action types at coercion time", async () => {
    // The tool schema narrows `type` to digest/thread, but the runtime
    // coercion enforces it too so a drifted model can't sneak through.
    const provider = scriptedProvider([
      toolUseContent({
        items: [
          {
            type: "nudge",
            title: "Should be rejected",
            summary: "Rollup must never emit nudges.",
          },
          {
            type: "action",
            title: "Also rejected",
            summary: "Rollup must never emit actions.",
          },
          {
            type: "digest",
            title: "Valid digest",
            summary: "This one should land.",
          },
        ],
      }),
    ]);

    const result = await runRollupProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      loadRecentActions: stubLoadRecentActions(oneAction),
      resolveProvider: () => provider,
    });

    expect(result.wroteCount).toBe(1);
    expect(writeItem).toHaveBeenCalledTimes(1);
    expect(writeItem.mock.calls[0]![0].title).toBe("Valid digest");
  });

  test("reports malformed_output when every item in a non-empty batch fails coercion", async () => {
    const provider = scriptedProvider([
      toolUseContent({
        items: [
          { type: "digest", title: "", summary: "empty title, rejected" },
          { type: "bogus", title: "bad type", summary: "also rejected" },
          { type: "digest", title: "valid title" }, // missing summary
        ],
      }),
    ]);

    const result = await runRollupProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      loadRecentActions: stubLoadRecentActions(oneAction),
      resolveProvider: () => provider,
    });

    expect(result.skippedReason).toBe("malformed_output");
    expect(result.wroteCount).toBe(0);
    expect(writeItem).not.toHaveBeenCalled();
  });

  test("returns no_provider when the resolver returns null", async () => {
    const result = await runRollupProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      loadRecentActions: stubLoadRecentActions(oneAction),
      resolveProvider: () => null,
    });

    expect(result.skippedReason).toBe("no_provider");
    expect(result.wroteCount).toBe(0);
    expect(writeItem).not.toHaveBeenCalled();
  });

  test("returns provider_error when sendMessage throws", async () => {
    const provider = throwingProvider(new Error("network down"));

    const result = await runRollupProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      loadRecentActions: stubLoadRecentActions(oneAction),
      resolveProvider: () => provider,
    });

    expect(result.skippedReason).toBe("provider_error");
    expect(result.wroteCount).toBe(0);
  });

  test("returns malformed_output when the response has no matching tool_use block", async () => {
    const provider = scriptedProvider([{ type: "text", text: "just prose" }]);

    const result = await runRollupProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      loadRecentActions: stubLoadRecentActions(oneAction),
      resolveProvider: () => provider,
    });

    expect(result.skippedReason).toBe("malformed_output");
    expect(result.wroteCount).toBe(0);
  });

  test("concurrent calls short-circuit the second with in_flight", async () => {
    // Gate the provider behind a manually-controlled deferred so we
    // can observe state while the first call is still inside the
    // producer body. Without this we'd race the runtime's microtask
    // scheduler to check in-flightness.
    let release: ((value: ContentBlock[]) => void) | null = null;
    const gated = new Promise<ContentBlock[]>((resolve) => {
      release = resolve;
    });
    const provider = makeProvider(async () => {
      const content = await gated;
      return {
        content,
        model: "mock-model",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "tool_use",
      };
    });

    const first = runRollupProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      loadRecentActions: stubLoadRecentActions(oneAction),
      resolveProvider: () => provider,
    });

    // Second call lands while `first` is blocked awaiting the gated
    // provider response — the in-flight guard must short-circuit it.
    const second = await runRollupProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      loadRecentActions: stubLoadRecentActions(oneAction),
      resolveProvider: () => provider,
    });

    expect(second.skippedReason).toBe("in_flight");
    expect(second.wroteCount).toBe(0);

    // Release the first call and let it finish.
    release!([toolUseContent({ items: [] })]);
    const firstResult = await first;
    expect(firstResult.skippedReason).toBe("empty_items");
  });

  test("clamps priority to the valid [0, 100] window", async () => {
    const provider = scriptedProvider([
      toolUseContent({
        items: [
          {
            type: "digest",
            title: "High priority",
            summary: "Model returned 150",
            priority: 150,
          },
          {
            type: "thread",
            title: "Low priority",
            summary: "Model returned -5",
            priority: -5,
          },
        ],
      }),
    ]);

    await runRollupProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      loadRecentActions: stubLoadRecentActions(oneAction),
      resolveProvider: () => provider,
    });

    expect(writeItem).toHaveBeenCalledTimes(2);
    expect(writeItem.mock.calls[0]![0].priority).toBe(100);
    expect(writeItem.mock.calls[1]![0].priority).toBe(0);
  });
});
