import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { FeedItem } from "../../home/feed-types.js";
import type { NotificationSignal } from "../signal.js";
import type { NotificationDecision } from "../types.js";

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
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
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
  test("background conversation signal writes a feed item with payload title + rendered body", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      contextPayload: { title: "Background job done" },
    });
    const decision = makeDecision({
      renderedCopy: {
        vellum: {
          title: "Background job done",
          body: "Summary of what happened.",
        },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision);

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
    // The button in the home detail panel navigates to the source
    // conversation that emitted the notification, not the conversation the
    // notification pipeline spawned to handle it.
    expect(appended.conversationId).toBe("conv-source-1");
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

    const item = await writeHomeFeedItemForSignal(signal, makeDecision());

    expect(item).toBeNull();
    expect(appendCalls).toHaveLength(0);
  });

  test("isAsyncBackground hint writes even when sourceContextId does not resolve", async () => {
    // Source lookup throws — treated as non-navigable, so the item lands
    // without a `conversationId` and the "Go to Thread" button hides on the
    // client. The async-background hint still forces the mirror.
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

    const item = await writeHomeFeedItemForSignal(signal, decision);

    expect(item).not.toBeNull();
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.urgency).toBe("high");
    expect(appendCalls[0]!.conversationId).toBeUndefined();
    expect(conversationLookups).toEqual(["not-a-conversation-id"]);
  });

  test("assistant_tool source mirrors to the home feed even without a background conversation or async hint", async () => {
    // Regression: the `notifications send` CLI/skill emits with
    // `sourceChannel: "assistant_tool"`, a synthetic `cli-<ts>` source
    // context id that does not resolve to a conversation, and
    // `isAsyncBackground: false`. The assistant_tool channel forces the
    // mirror; the source-id lookup misses so the item lands without a
    // `conversationId` and the "Go to Thread" button hides on the client.
    conversationRow = null;
    const signal = makeSignal({
      sourceChannel: "assistant_tool",
      sourceEventName: "assistant.share",
      sourceContextId: "cli-12345",
      contextPayload: { title: "Shared from CLI" },
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

    const item = await writeHomeFeedItemForSignal(signal, decision);

    expect(item).not.toBeNull();
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.title).toBe("Shared from CLI");
    expect(appendCalls[0]!.noteworthy).toBe(true);
    expect(appendCalls[0]!.conversationId).toBeUndefined();
    expect(conversationLookups).toEqual(["cli-12345"]);
  });

  test("source conversation id does not propagate when the lookup misses", async () => {
    // When `sourceContextId` does not resolve to a real conversation row
    // (e.g. scheduler job id, watcher event id), the item is still mirrored
    // via the `isAsyncBackground` hint but `conversationId` stays undefined
    // so the client hides the "Go to Thread" affordance.
    conversationRow = null;
    const signal = makeSignal({
      sourceContextId: "scheduler-job-42",
      attentionHints: {
        requiresAction: false,
        urgency: "medium",
        isAsyncBackground: true,
        visibleInSourceNow: false,
      },
    });
    const decision = makeDecision({
      renderedCopy: {
        vellum: { title: "Routed title", body: "Routed body" },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision);

    expect(item?.conversationId).toBeUndefined();
    expect(appendCalls[0]!.conversationId).toBeUndefined();
    expect(conversationLookups).toEqual(["scheduler-job-42"]);
  });

  test("falls back to the paired delivery conversation when sourceContextId does not resolve", async () => {
    // Regression: producers whose `sourceContextId` is a sentinel string
    // (heartbeat startup `"heartbeat"`, credential health `connectionId`,
    // watcher `watcher-<ts>`, scheduler retries-exhausted `jobId`, sweep
    // job id) never resolve via `getConversation`. The notification
    // broadcaster pairs each vellum delivery with a real conversation
    // before the home-feed write runs, so the caller threads that paired
    // id through as the fallback — the "Go to Convo" button now points at
    // the conversation the notification was actually delivered into.
    conversationRow = null;
    const signal = makeSignal({
      sourceChannel: "assistant_tool",
      sourceEventName: "assistant.share",
      sourceContextId: "watcher-1700000000",
      contextPayload: { title: "Watcher alert" },
      attentionHints: {
        requiresAction: false,
        urgency: "medium",
        isAsyncBackground: true,
        visibleInSourceNow: false,
      },
    });
    const decision = makeDecision({
      renderedCopy: {
        vellum: { title: "Watcher alert", body: "Watcher body" },
      },
    });

    const item = await writeHomeFeedItemForSignal(
      signal,
      decision,
      "paired-delivery-conv-id",
    );

    expect(item).not.toBeNull();
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.conversationId).toBe("paired-delivery-conv-id");
  });

  test("source conversation id wins over the paired delivery fallback when both are available", async () => {
    // When the producer's `sourceContextId` already points at a real
    // conversation (the canonical "where the work happened"), prefer it
    // over the paired delivery — the fallback is only meant to fill the
    // gap for sentinel-id producers.
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      contextPayload: { title: "Background job done" },
    });
    const decision = makeDecision({
      renderedCopy: {
        vellum: { title: "Background job done", body: "Summary." },
      },
    });

    const item = await writeHomeFeedItemForSignal(
      signal,
      decision,
      "paired-delivery-conv-id",
    );

    expect(item).not.toBeNull();
    expect(appendCalls[0]!.conversationId).toBe("conv-source-1");
  });

  test("returns null and does not write when no rendered copy or payload title/body is present", async () => {
    conversationRow = { conversationType: "scheduled" };
    const signal = makeSignal({
      sourceEventName: "watcher.notification",
      contextPayload: {},
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision());

    expect(item).toBeNull();
    expect(appendCalls).toHaveLength(0);
  });

  test("returns null when only the title is available but the summary would fall back to event name", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceEventName: "example.event",
      contextPayload: { title: "Real title" },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision());

    expect(item).toBeNull();
    expect(appendCalls).toHaveLength(0);
  });

  test("writes a feed item with undefined title when only the body is available", async () => {
    // Regression: when `notifications send` is called without `--title`, the
    // notification pipeline must not manufacture a title (the LLM's rendered
    // copy echoes the body into `renderedCopy.title`). Leave `title`
    // undefined so renderers fall back to `summary` instead of stuttering.
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceEventName: "example.event",
      contextPayload: { body: "Real body" },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision());

    expect(item).not.toBeNull();
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.title).toBeUndefined();
    expect(appendCalls[0]!.summary).toBe("Real body");
  });

  test("ignores LLM-rendered title when no payload title was supplied", async () => {
    // The LLM often echoes the body verbatim into `renderedCopy.title` when
    // the source didn't pass one. The home-feed writer must NOT promote that
    // echo into the feed item — only an explicit source title is honored.
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceEventName: "example.event",
      contextPayload: { body: "Real body" },
    });
    const decision = makeDecision({
      renderedCopy: {
        vellum: {
          title: "Real body",
          body: "Real body",
        },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision);

    expect(item).not.toBeNull();
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.title).toBeUndefined();
    expect(appendCalls[0]!.summary).toBe("Real body");
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

    const item = await writeHomeFeedItemForSignal(signal, decision);

    expect(item).toBeNull();
    expect(appendCalls).toHaveLength(0);
  });

  test("falls back to a non-vellum channel's rendered copy when vellum copy is absent", async () => {
    // Regression: when `preferredChannels` narrows an assistant_tool signal
    // to a non-vellum channel (e.g. telegram), the broadcaster ships real
    // copy on that channel but `renderedCopy.vellum` is undefined. The
    // guard must still write to the home feed using the first available
    // rendered copy entry rather than skipping silently.
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceChannel: "assistant_tool",
      sourceEventName: "assistant.share",
      sourceContextId: "cli-12345",
      contextPayload: { title: "Telegram title" },
    });
    const decision = makeDecision({
      selectedChannels: ["telegram"],
      renderedCopy: {
        telegram: { title: "Telegram title", body: "Telegram body" },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision);

    expect(item).not.toBeNull();
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.title).toBe("Telegram title");
    expect(appendCalls[0]!.summary).toBe("Telegram body");
  });

  test("ignores rendered copy for channels not in selectedChannels", async () => {
    // Regression: routing-intent enforcement can prune selectedChannels
    // without pruning renderedCopy, leaving copy entries for channels that
    // were never delivered. The fallback must only consider channels that
    // actually shipped — otherwise an unselected channel's copy can land in
    // Home in place of the selected channel's copy.
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceChannel: "assistant_tool",
      sourceEventName: "assistant.share",
      sourceContextId: "cli-12345",
      contextPayload: { title: "Telegram title" },
    });
    const decision = makeDecision({
      selectedChannels: ["telegram"],
      renderedCopy: {
        slack: {
          title: "Slack title (unselected)",
          body: "Slack body (unselected)",
        },
        telegram: { title: "Telegram title", body: "Telegram body" },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision);

    expect(item).not.toBeNull();
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.title).toBe("Telegram title");
    expect(appendCalls[0]!.summary).toBe("Telegram body");
  });

  test("skips fallback when only unselected channels have rendered copy", async () => {
    // Regression: if every renderedCopy entry is for a channel that was
    // pruned from selectedChannels, treat it as no copy at all rather than
    // surfacing the stale entry.
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceChannel: "assistant_tool",
      sourceEventName: "assistant.share",
      sourceContextId: "cli-12345",
    });
    const decision = makeDecision({
      selectedChannels: ["telegram"],
      renderedCopy: {
        slack: {
          title: "Slack title (unselected)",
          body: "Slack body (unselected)",
        },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision);

    expect(item).toBeNull();
    expect(appendCalls).toHaveLength(0);
  });

  test("falls back to requestedTitle/requestedMessage payload keys", async () => {
    // Regression: the `notifications send` CLI surface stores the
    // user-supplied copy on the signal payload under `requestedTitle` and
    // `requestedMessage`. If the decision strips renderedCopy.vellum (e.g.
    // routed only to a non-vellum channel that also lacks renderedCopy),
    // the home-feed guard must still recover the copy from the payload.
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceChannel: "assistant_tool",
      sourceEventName: "assistant.share",
      sourceContextId: "cli-12345",
      contextPayload: {
        requestedTitle: "Requested title",
        requestedMessage: "Requested message body",
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision());

    expect(item).not.toBeNull();
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.title).toBe("Requested title");
    expect(appendCalls[0]!.summary).toBe("Requested message body");
  });

  test("uses payload title/body when rendered copy is absent", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceEventName: "watcher.notification",
      contextPayload: { title: "Payload title", body: "Payload body" },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision());

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

    const item = await writeHomeFeedItemForSignal(signal, makeDecision());

    expect(item?.noteworthy).toBe(true);
    expect(appendCalls[0]!.noteworthy).toBe(true);
  });

  test("assistant_tool source sets fromAssistant=true", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceChannel: "assistant_tool",
      sourceEventName: "user.send_notification",
      contextPayload: { title: "Tool share", body: "Body" },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision());

    expect(item?.fromAssistant).toBe(true);
    expect(appendCalls[0]!.fromAssistant).toBe(true);
  });

  test("non-assistant_tool source sets fromAssistant=false", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceChannel: "scheduler",
      sourceEventName: "schedule.notify",
      contextPayload: { title: "Reminder", body: "Time to do thing" },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision());

    expect(item?.fromAssistant).toBe(false);
    expect(appendCalls[0]!.fromAssistant).toBe(false);
  });

  test("scheduler source with schedule.notify is not noteworthy", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceChannel: "scheduler",
      sourceEventName: "schedule.notify",
      contextPayload: { title: "Reminder", body: "Time to do thing" },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision());

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

    const item = await writeHomeFeedItemForSignal(signal, makeDecision());

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

    const item = await writeHomeFeedItemForSignal(signal, makeDecision());

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

    const item = await writeHomeFeedItemForSignal(signal, makeDecision());

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

    const item = await writeHomeFeedItemForSignal(signal, makeDecision());

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

    const item = await writeHomeFeedItemForSignal(signal, makeDecision());

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

    const item = await writeHomeFeedItemForSignal(signal, makeDecision());

    expect(item?.noteworthy).toBe(true);
    expect(appendCalls[0]!.noteworthy).toBe(true);
  });
});
