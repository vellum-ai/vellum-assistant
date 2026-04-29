import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { FeedItem } from "../../home/feed-types.js";
import type { NotificationSignal } from "../signal.js";
import type {
  NotificationDecision,
  NotificationDeliveryResult,
} from "../types.js";

// ── Module mocks ───────────────────────────────────────────────────────
//
// `mock.module` is hoisted, so these intercepts apply before the module
// under test resolves its imports. Closures over the module-scoped
// arrays/flag below let each test reset state via `beforeEach` and
// inspect captured calls afterwards.

const appendCalls: FeedItem[] = [];
const conversationLookups: string[] = [];
let conversationRow: { conversationType: string } | null = null;
let conversationLookupShouldThrow = false;

mock.module("../../home/feed-writer.js", () => ({
  appendFeedItem: async (item: FeedItem) => {
    appendCalls.push(item);
  },
}));

mock.module("../../memory/conversation-crud.js", () => ({
  getConversation: (id: string) => {
    conversationLookups.push(id);
    if (conversationLookupShouldThrow) {
      throw new Error("simulated conversation lookup failure");
    }
    return conversationRow;
  },
}));

const { writeHomeFeedItemForSignal } =
  await import("../home-feed-side-effect.js");

// ── Test fixtures ──────────────────────────────────────────────────────

function makeSignal(
  overrides: Partial<NotificationSignal> = {},
): NotificationSignal {
  return {
    signalId: "sig-test-1",
    createdAt: 1700000000000,
    sourceChannel: "scheduler",
    sourceContextId: "conv-source-1",
    sourceEventName: "schedule.notify",
    contextPayload: {},
    attentionHints: {
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    ...overrides,
  };
}

function makeDecision(
  overrides: Partial<NotificationDecision> = {},
): NotificationDecision {
  return {
    shouldNotify: true,
    selectedChannels: [],
    reasoningSummary: "test",
    renderedCopy: {},
    dedupeKey: "dk-1",
    confidence: 1,
    fallbackUsed: false,
    ...overrides,
  };
}

beforeEach(() => {
  appendCalls.length = 0;
  conversationLookups.length = 0;
  conversationRow = null;
  conversationLookupShouldThrow = false;
});

describe("writeHomeFeedItemForSignal", () => {
  test("background conversation signal writes a feed item with rendered copy", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal();
    const decision = makeDecision({
      renderedCopy: {
        vellum: {
          title: "Background job done",
          body: "Summary of what happened.",
        },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision, []);

    expect(conversationLookups).toEqual(["conv-source-1"]);
    expect(item).not.toBeNull();
    expect(appendCalls).toHaveLength(1);
    const appended = appendCalls[0]!;
    expect(appended.id).toBe("notif:sig-test-1");
    expect(appended.type).toBe("action");
    expect(appended.source).toBe("assistant");
    expect(appended.author).toBe("assistant");
    expect(appended.priority).toBe(50);
    expect(appended.status).toBe("new");
    expect(appended.title).toBe("Background job done");
    expect(appended.summary).toBe("Summary of what happened.");
    expect(appended.urgency).toBe("medium");
    expect(typeof appended.timestamp).toBe("string");
    expect(appended.createdAt).toBe(appended.timestamp);
  });

  test("non-background conversation with no async hint returns null and does not write", async () => {
    conversationRow = { conversationType: "standard" };
    const signal = makeSignal({
      attentionHints: {
        requiresAction: false,
        urgency: "low",
        isAsyncBackground: false,
        visibleInSourceNow: true,
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision(), []);

    expect(item).toBeNull();
    expect(appendCalls).toHaveLength(0);
  });

  test("isAsyncBackground hint writes even when sourceContextId does not resolve", async () => {
    // No conversation row matches; the conversation lookup is bypassed
    // entirely because the hint short-circuits the filter.
    conversationLookupShouldThrow = true;
    const signal = makeSignal({
      sourceContextId: "not-a-conversation-id",
      attentionHints: {
        requiresAction: false,
        urgency: "high",
        isAsyncBackground: true,
        visibleInSourceNow: false,
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision(), []);

    expect(item).not.toBeNull();
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.urgency).toBe("high");
    // The async-background short-circuit must not consult the conversation store.
    expect(conversationLookups).toHaveLength(0);
  });

  test("vellum delivery result conversationId propagates onto the feed item", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal();
    const deliveryResults: NotificationDeliveryResult[] = [
      {
        channel: "telegram",
        destination: "chat-1",
        status: "sent",
        conversationId: "conv-telegram-1",
      },
      {
        channel: "vellum",
        destination: "vellum-client",
        status: "sent",
        conversationId: "conv-vellum-1",
      },
    ];

    const item = await writeHomeFeedItemForSignal(
      signal,
      makeDecision(),
      deliveryResults,
    );

    expect(item?.conversationId).toBe("conv-vellum-1");
    expect(appendCalls[0]!.conversationId).toBe("conv-vellum-1");
  });

  test("falls back to sourceEventName when no rendered copy or payload title is present", async () => {
    conversationRow = { conversationType: "scheduled" };
    const signal = makeSignal({
      sourceEventName: "watcher.notification",
      contextPayload: {},
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision(), []);

    expect(item?.title).toBe("watcher.notification");
    expect(item?.summary).toBe("watcher.notification");
  });
});
