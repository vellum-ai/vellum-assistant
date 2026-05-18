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
    expect(appended.type).toBe("notification");
    // v2 dropped source/author — the side effect must construct items
    // without those fields.
    expect((appended as { source?: unknown }).source).toBeUndefined();
    expect((appended as { author?: unknown }).author).toBeUndefined();
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
    const decision = makeDecision({
      renderedCopy: {
        vellum: { title: "Async title", body: "Async body" },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision, []);

    expect(item).not.toBeNull();
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.urgency).toBe("high");
    // The async-background short-circuit must not consult the conversation store.
    expect(conversationLookups).toHaveLength(0);
  });

  test("assistant_tool source mirrors to the home feed even without a background conversation or async hint", async () => {
    // Regression: the `notifications send` CLI/skill emits with
    // `sourceChannel: "assistant_tool"`, a synthetic `cli-<ts>` source
    // context id that does not resolve to a conversation, and
    // `isAsyncBackground: false`. Before the fix, `shouldMirrorToHomeFeed`
    // returned `false` for this shape and the Inbox stayed empty.
    conversationRow = null;
    const signal = makeSignal({
      sourceChannel: "assistant_tool",
      sourceEventName: "assistant.share",
      sourceContextId: "cli-12345",
      attentionHints: {
        requiresAction: false,
        urgency: "low",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
    });
    const decision = makeDecision({
      renderedCopy: {
        vellum: { title: "Shared from CLI", body: "Body from CLI share" },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision, []);

    expect(item).not.toBeNull();
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.title).toBe("Shared from CLI");
    expect(appendCalls[0]!.noteworthy).toBe(true);
    // The assistant_tool short-circuit must not consult the conversation store.
    expect(conversationLookups).toHaveLength(0);
  });

  test("vellum delivery result conversationId propagates onto the feed item", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal();
    const decision = makeDecision({
      renderedCopy: {
        vellum: { title: "Routed title", body: "Routed body" },
      },
    });
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
      decision,
      deliveryResults,
    );

    expect(item?.conversationId).toBe("conv-vellum-1");
    expect(appendCalls[0]!.conversationId).toBe("conv-vellum-1");
  });

  test("returns null and does not write when no rendered copy or payload title/body is present", async () => {
    conversationRow = { conversationType: "scheduled" };
    const signal = makeSignal({
      sourceEventName: "watcher.notification",
      contextPayload: {},
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision(), []);

    expect(item).toBeNull();
    expect(appendCalls).toHaveLength(0);
  });

  test("returns null when only the title is available but the summary would fall back to event name", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceEventName: "example.event",
      contextPayload: { title: "Real title" },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision(), []);

    expect(item).toBeNull();
    expect(appendCalls).toHaveLength(0);
  });

  test("returns null when only the summary is available but the title would fall back to event name", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceEventName: "example.event",
      contextPayload: { body: "Real body" },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision(), []);

    expect(item).toBeNull();
    expect(appendCalls).toHaveLength(0);
  });

  test("treats whitespace-only rendered copy and payload values as missing and returns null", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceEventName: "example.event",
      contextPayload: { title: "   ", body: "\t\n" },
    });
    const decision = makeDecision({
      renderedCopy: {
        vellum: { title: "   ", body: "   " },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision, []);

    expect(item).toBeNull();
    expect(appendCalls).toHaveLength(0);
  });

  test("uses payload title/body when rendered copy is absent", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceEventName: "watcher.notification",
      contextPayload: { title: "Payload title", body: "Payload body" },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision(), []);

    expect(item).not.toBeNull();
    expect(item?.title).toBe("Payload title");
    expect(item?.summary).toBe("Payload body");
    expect(appendCalls).toHaveLength(1);
  });

  // ── noteworthy derivation ────────────────────────────────────────────

  test("assistant_tool source marks the feed item noteworthy", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceChannel: "assistant_tool",
      sourceEventName: "user.send_notification",
      contextPayload: { title: "Tool share", body: "Body" },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision(), []);

    expect(item?.noteworthy).toBe(true);
    expect(appendCalls[0]!.noteworthy).toBe(true);
  });

  test("scheduler source with schedule.notify is not noteworthy", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceChannel: "scheduler",
      sourceEventName: "schedule.notify",
      contextPayload: { title: "Reminder", body: "Time to do thing" },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision(), []);

    expect(item?.noteworthy).toBe(false);
    expect(appendCalls[0]!.noteworthy).toBe(false);
  });

  test("assistant_tool source with guardian.question event still wins (noteworthy true)", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceChannel: "assistant_tool",
      sourceEventName: "guardian.question",
      contextPayload: { title: "Question", body: "Approve?" },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision(), []);

    expect(item?.noteworthy).toBe(true);
    expect(appendCalls[0]!.noteworthy).toBe(true);
  });

  test("activity.failed with critical urgency is noteworthy (scheduler source)", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceChannel: "scheduler",
      sourceEventName: "activity.failed",
      contextPayload: { title: "Job failed", body: "Critical failure" },
      attentionHints: {
        requiresAction: false,
        urgency: "critical",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision(), []);

    expect(item?.noteworthy).toBe(true);
    expect(appendCalls[0]!.noteworthy).toBe(true);
  });

  test("activity.failed with low urgency is not noteworthy (scheduler source)", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceChannel: "scheduler",
      sourceEventName: "activity.failed",
      contextPayload: { title: "Job failed", body: "Routine failure" },
      attentionHints: {
        requiresAction: false,
        urgency: "low",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision(), []);

    expect(item?.noteworthy).toBe(false);
    expect(appendCalls[0]!.noteworthy).toBe(false);
  });

  test("activity.failed from background-job-runner shape (assistant_tool + medium) is NOT noteworthy", async () => {
    // Regression: `runtime/background-job-runner.ts` emits activity.failed
    // with `sourceChannel: "assistant_tool"` and `urgency: "medium"`. Before
    // the fix, the assistant_tool short-circuit short-circuited noteworthy
    // to true, so every routine watcher/heartbeat failure landed in the
    // Inbox. The activity.failed rule must run first and require critical
    // urgency.
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceChannel: "assistant_tool",
      sourceEventName: "activity.failed",
      contextPayload: { title: "Job failed", body: "Routine failure" },
      attentionHints: {
        requiresAction: false,
        urgency: "medium",
        isAsyncBackground: true,
        visibleInSourceNow: false,
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision(), []);

    expect(item?.noteworthy).toBe(false);
    expect(appendCalls[0]!.noteworthy).toBe(false);
  });

  test("activity.failed from assistant_tool with critical urgency IS noteworthy", async () => {
    // Companion to the regression test above: a background-job-runner
    // shape that opts up to critical urgency should still reach the Inbox.
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceChannel: "assistant_tool",
      sourceEventName: "activity.failed",
      contextPayload: { title: "Job failed", body: "Critical failure" },
      attentionHints: {
        requiresAction: false,
        urgency: "critical",
        isAsyncBackground: true,
        visibleInSourceNow: false,
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision(), []);

    expect(item?.noteworthy).toBe(true);
    expect(appendCalls[0]!.noteworthy).toBe(true);
  });

  test("credential.health_alert is noteworthy regardless of source channel", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceChannel: "watcher",
      sourceEventName: "credential.health_alert",
      contextPayload: { title: "Credential expired", body: "Reconnect" },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision(), []);

    expect(item?.noteworthy).toBe(true);
    expect(appendCalls[0]!.noteworthy).toBe(true);
  });
});
