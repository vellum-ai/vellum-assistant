/**
 * Unit tests for the home-feed reflection producer.
 *
 * All dependencies are injected via `ReflectionProducerDeps` spies so
 * the tests never touch `mock.module`, which leaks across files in
 * Bun's test runner. The production caller passes `undefined` and the
 * producer falls through to the real config loader, relationship-state
 * reader, and provider registry.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ContentBlock,
  Provider,
  ProviderResponse,
} from "../../providers/types.js";
import type { WriteAssistantFeedItemParams } from "../assistant-feed-authoring.js";
import { runReflectionProducer } from "../reflection-producer.js";

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

beforeEach(() => {
  writeItem.mockClear();
});

describe("runReflectionProducer", () => {
  test("writes each item returned in the write_feed_items tool call", async () => {
    const provider = scriptedProvider([
      toolUseContent({
        items: [
          {
            type: "nudge",
            source: "assistant",
            title: "Follow up on Figma",
            summary: "Noa shared a file Thursday. No reply yet.",
            priority: 70,
            minTimeAway: 3600,
          },
          {
            type: "thread",
            source: "assistant",
            title: "Hiring loop",
            summary: "2 of 6 interviewed; pipeline is stalling.",
            priority: 55,
          },
        ],
      }),
    ]);

    const result = await runReflectionProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      resolveProvider: () => provider,
    });

    expect(result.skippedReason).toBeNull();
    expect(result.wroteCount).toBe(2);
    expect(writeItem).toHaveBeenCalledTimes(2);
    const firstCall = writeItem.mock.calls[0]![0];
    expect(firstCall.type).toBe("nudge");
    expect(firstCall.title).toBe("Follow up on Figma");
    expect(firstCall.priority).toBe(70);
    expect(firstCall.minTimeAway).toBe(3600);
  });

  test("returns empty_items when the model emits an empty array", async () => {
    const provider = scriptedProvider([toolUseContent({ items: [] })]);

    const result = await runReflectionProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      resolveProvider: () => provider,
    });

    expect(result.skippedReason).toBe("empty_items");
    expect(result.wroteCount).toBe(0);
    expect(writeItem).not.toHaveBeenCalled();
  });

  test("caps the batch at MAX_ITEMS_PER_REFLECTION (3)", async () => {
    const provider = scriptedProvider([
      toolUseContent({
        items: [
          { type: "nudge", title: "One", summary: "One summary" },
          { type: "nudge", title: "Two", summary: "Two summary" },
          { type: "nudge", title: "Three", summary: "Three summary" },
          {
            type: "nudge",
            title: "Four",
            summary: "Four summary — should be dropped.",
          },
        ],
      }),
    ]);

    const result = await runReflectionProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      resolveProvider: () => provider,
    });

    expect(result.wroteCount).toBe(3);
    expect(writeItem).toHaveBeenCalledTimes(3);
  });

  test("reports malformed_output when every item in a non-empty batch fails coercion", async () => {
    const provider = scriptedProvider([
      toolUseContent({
        items: [
          { type: "nudge", title: "", summary: "empty title, rejected" },
          { type: "bogus", title: "bad type", summary: "also rejected" },
          { type: "nudge", title: "valid title" }, // missing summary
        ],
      }),
    ]);

    const result = await runReflectionProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      resolveProvider: () => provider,
    });

    expect(result.skippedReason).toBe("malformed_output");
    expect(result.wroteCount).toBe(0);
    expect(writeItem).not.toHaveBeenCalled();
  });

  test("rejects malformed items but keeps valid ones in the same batch", async () => {
    const provider = scriptedProvider([
      toolUseContent({
        items: [
          {
            type: "nudge",
            title: "", // empty title — rejected
            summary: "Valid summary",
          },
          {
            type: "bogus-type", // invalid type — rejected
            title: "Valid title",
            summary: "Valid summary",
          },
          {
            type: "thread",
            title: "Good item",
            summary: "This one should land.",
          },
        ],
      }),
    ]);

    const result = await runReflectionProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      resolveProvider: () => provider,
    });

    expect(result.wroteCount).toBe(1);
    expect(writeItem).toHaveBeenCalledTimes(1);
    expect(writeItem.mock.calls[0]![0].title).toBe("Good item");
  });

  test("returns no_provider when the resolver returns null", async () => {
    const result = await runReflectionProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      resolveProvider: () => null,
    });

    expect(result.skippedReason).toBe("no_provider");
    expect(result.wroteCount).toBe(0);
    expect(writeItem).not.toHaveBeenCalled();
  });

  test("returns provider_error when sendMessage throws", async () => {
    const provider = throwingProvider(new Error("network down"));

    const result = await runReflectionProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      resolveProvider: () => provider,
    });

    expect(result.skippedReason).toBe("provider_error");
    expect(result.wroteCount).toBe(0);
  });

  test("returns malformed_output when the response has no matching tool_use block", async () => {
    const provider = scriptedProvider([{ type: "text", text: "just prose" }]);

    const result = await runReflectionProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      resolveProvider: () => provider,
    });

    expect(result.skippedReason).toBe("malformed_output");
    expect(result.wroteCount).toBe(0);
  });

  test("clamps priority to the valid [0, 100] window", async () => {
    const provider = scriptedProvider([
      toolUseContent({
        items: [
          {
            type: "nudge",
            title: "High priority",
            summary: "Model returned 150",
            priority: 150,
          },
          {
            type: "nudge",
            title: "Low priority",
            summary: "Model returned -5",
            priority: -5,
          },
        ],
      }),
    ]);

    await runReflectionProducer(new Date(), {
      writeItem,
      loadRelationshipState: stubRelationshipState,
      resolveProvider: () => provider,
    });

    expect(writeItem).toHaveBeenCalledTimes(2);
    expect(writeItem.mock.calls[0]![0].priority).toBe(100);
    expect(writeItem.mock.calls[1]![0].priority).toBe(0);
  });
});
