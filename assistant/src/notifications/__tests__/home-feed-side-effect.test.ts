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
const messageAppends: Array<{
  conversationId: string;
  role: string;
  content: string;
  options?: { skipIndexing?: boolean };
}> = [];
const messageRewrites: Array<{ messageId: string; content: string }> = [];
/** messageId -> the conversation it belongs to, for the scoped lookup. */
const messageOwners = new Map<string, string>();
let conversationRow: { conversationType: string } | null = null;
let conversationLookupShouldThrow = false;
let messageAppendShouldThrow = false;
let messageRewriteShouldThrow = false;
let messageLookupShouldThrow = false;

let feedItemSchemaShouldReject = false;
const messagesInvalidated: string[] = [];

mock.module("../../runtime/sync/resource-sync-events.js", () => ({
  publishConversationMessagesChanged: (conversationId: string) => {
    messagesInvalidated.push(conversationId);
  },
}));

mock.module("../../home/feed-types.js", () => ({
  feedItemSchema: {
    parse: (item: unknown) => {
      if (feedItemSchemaShouldReject) {
        throw new Error("simulated schema rejection");
      }
      return item;
    },
  },
}));

mock.module("../../home/feed-writer.js", () => ({
  appendFeedItem: async (item: FeedItem) => {
    appendCalls.push(item);
  },
}));

mock.module("../../persistence/conversation-crud.js", () => ({
  getConversation: (id: string) => {
    conversationLookups.push(id);
    if (conversationLookupShouldThrow) {
      throw new Error("simulated conversation lookup failure");
    }
    return conversationRow;
  },
  addMessage: async (
    conversationId: string,
    role: string,
    content: string,
    options?: { skipIndexing?: boolean },
  ) => {
    if (messageAppendShouldThrow) {
      throw new Error("simulated message write failure");
    }
    messageAppends.push({ conversationId, role, content, options });
    return { id: `msg-${messageAppends.length}` };
  },
  getMessageById: (messageId: string, conversationId?: string) => {
    if (messageLookupShouldThrow) {
      throw new Error("simulated message lookup failure");
    }
    const owner = messageOwners.get(messageId);
    if (!owner || (conversationId && owner !== conversationId)) {
      return null;
    }
    return { id: messageId, conversationId: owner };
  },
  updateMessageContent: (messageId: string, content: string) => {
    if (messageRewriteShouldThrow) {
      throw new Error("simulated message rewrite failure");
    }
    messageRewrites.push({ messageId, content });
  },
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

const { updateFeedItemConversationMessage, writeHomeFeedItemForSignal } =
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

function makeVellumDelivery(
  overrides: Partial<NotificationDeliveryResult> = {},
): NotificationDeliveryResult {
  return {
    channel: "vellum",
    destination: "vellum",
    status: "sent",
    conversationId: "conv-source-1",
    messageId: "msg-paired",
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
  messageAppends.length = 0;
  messageRewrites.length = 0;
  messageOwners.clear();
  conversationRow = null;
  conversationLookupShouldThrow = false;
  messageAppendShouldThrow = false;
  messageRewriteShouldThrow = false;
  messageLookupShouldThrow = false;
  feedItemSchemaShouldReject = false;
  messagesInvalidated.length = 0;
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
      makeVellumDelivery({ conversationId: "paired-delivery-conv-id" }),
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
      makeVellumDelivery({ conversationId: "paired-delivery-conv-id" }),
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

  test("derives a title from the summary when only the body is available", async () => {
    // With no authored candidate at all, the title is derived from the
    // summary rather than left off: every row carries a headline.
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceEventName: "example.event",
      contextPayload: { body: "Real body" },
    });

    const item = await writeHomeFeedItemForSignal(signal, makeDecision());

    expect(item).not.toBeNull();
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.title).toBe("Real body");
    expect(appendCalls[0]!.summary).toBe("Real body");
  });

  test("uses the LLM-rendered title when no payload title was supplied", async () => {
    // The model authors `renderedCopy.title` as a topic headline, and the
    // decision engine validates it before it gets here, so it is the second
    // candidate after the payload title.
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceEventName: "example.event",
      contextPayload: { body: "Real body" },
    });
    const decision = makeDecision({
      renderedCopy: {
        vellum: {
          title: "Nightly sync finished",
          body: "Real body",
        },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision);

    expect(item).not.toBeNull();
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.title).toBe("Nightly sync finished");
    expect(appendCalls[0]!.summary).toBe("Real body");
  });

  test("payload title wins over the rendered title when it is clean", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceEventName: "example.event",
      contextPayload: { title: "Payload headline" },
    });
    const decision = makeDecision({
      renderedCopy: {
        vellum: {
          title: "Model headline",
          body: "A description of what the run did.",
        },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision);

    expect(item?.title).toBe("Payload headline");
    expect(appendCalls[0]!.title).toBe("Payload headline");
  });

  test("keeps a payload title that opens the summary", async () => {
    // A correct topic headline is usually the opening noun phrase of the body,
    // so an authored title that overlaps the summary still wins.
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceEventName: "example.event",
      contextPayload: { title: "Nightly Backup Failure" },
    });
    const decision = makeDecision({
      renderedCopy: {
        vellum: {
          title: "Reminder plumbing check",
          body: "Nightly backup failure on db-primary at 02:14. Retry scheduled.",
        },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision);

    expect(item?.title).toBe("Nightly Backup Failure");
    expect(appendCalls[0]!.summary).toBe(
      "Nightly backup failure on db-primary at 02:14. Retry scheduled.",
    );
  });

  test("keeps a payload title that matches the summary's first sentence", async () => {
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceEventName: "example.event",
      contextPayload: { title: "Test notifications reminder." },
    });
    const decision = makeDecision({
      renderedCopy: {
        vellum: {
          title: "Model headline",
          body: "Test notifications reminder. It fired on schedule.",
        },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision);

    expect(item?.title).toBe("Test notifications reminder.");
    expect(appendCalls[0]!.summary).toBe(
      "Test notifications reminder. It fired on schedule.",
    );
  });

  test("always writes a non-empty title even when the copy is unusable", async () => {
    // `normalizeTitle` rejects prose-shaped candidates, so both authored
    // titles drop out and the derivation carries the row.
    conversationRow = { conversationType: "background" };
    const signal = makeSignal({
      sourceEventName: "example.event",
      contextPayload: { title: "I need to name this notification somehow" },
    });
    const decision = makeDecision({
      renderedCopy: {
        vellum: {
          title: "Let me summarize what happened",
          body: "Disk usage crossed 90 percent. Cleanup ran.",
        },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision);

    expect(item?.title).toBe("Disk usage crossed 90 percent.");
    expect(appendCalls[0]!.title).toBeTruthy();
  });

  test("derives a single-line plain title from a markdown-headed conversation seed", async () => {
    // The summary prefers `conversationSeedMessage`, which carries structured
    // markdown and hard line breaks. The derived title must not.
    conversationRow = { conversationType: "background" };
    const seed =
      "## Nightly Backup Report\n\nThe backup job on db-primary failed at 02:14.";
    const signal = makeSignal({ sourceEventName: "example.event" });
    const decision = makeDecision({
      renderedCopy: {
        vellum: {
          title: "",
          body: "The backup job failed.",
          conversationSeedMessage: seed,
        },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision);

    expect(item?.title).toBe(
      "Nightly Backup Report The backup job on db-primary failed at…",
    );
    expect(item?.summary).toBe(seed);
  });

  test("strips tilde fences and indented headings, matching migration 138", async () => {
    // Workspace migration 138 backfills titles with its own self-contained copy
    // of these rules. A backfilled title and a freshly written one must match
    // for the same summary, so both accept CommonMark's 3-space indent and both
    // fence styles.
    conversationRow = { conversationType: "background" };
    const seed = "   ## Indented heading\n\n~~~\ntilde fence\n~~~\nBody text.";
    const signal = makeSignal({ sourceEventName: "example.event" });
    const decision = makeDecision({
      renderedCopy: {
        vellum: {
          title: "",
          body: "Body text.",
          conversationSeedMessage: seed,
        },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision);

    expect(item?.title).toBe("Indented heading tilde fence Body text.");
  });

  test("derives a single-line plain title from a markdown-list conversation seed", async () => {
    conversationRow = { conversationType: "background" };
    const seed = "- Ran 12 checks\n- 3 failed\n\nSee the log for details.";
    const signal = makeSignal({ sourceEventName: "example.event" });
    const decision = makeDecision({
      renderedCopy: {
        vellum: {
          title: "",
          body: "Check run finished.",
          conversationSeedMessage: seed,
        },
      },
    });

    const item = await writeHomeFeedItemForSignal(signal, decision);

    expect(item?.title).toBe("Ran 12 checks 3 failed See the log for details.");
    expect(item?.summary).toBe(seed);
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

  describe("body append into the feed item's conversation", () => {
    test("appends the card summary when no vellum conversation was paired", async () => {
      // The Slack/Telegram-only routing case: nothing paired a vellum
      // conversation, so this seam is the only writer that can put the body
      // where the card's button points.
      conversationRow = { conversationType: "background" };
      const signal = makeSignal({
        contextPayload: { title: "Nightly briefing" },
      });
      const decision = makeDecision({
        selectedChannels: ["telegram"],
        renderedCopy: {
          telegram: { title: "Nightly briefing", body: "Three things today." },
        },
      });

      const item = await writeHomeFeedItemForSignal(signal, decision);

      expect(item?.conversationId).toBe("conv-source-1");
      expect(messageAppends).toHaveLength(1);
      expect(messageAppends[0]).toMatchObject({
        conversationId: "conv-source-1",
        role: "assistant",
        content: "Three things today.",
        options: { skipIndexing: true },
      });
      expect(item?.metadata?.notificationConversationMessageId).toBe("msg-1");
      // A client with the conversation open refetches only on the messages
      // tag; `addMessage` publishes the metadata tag alone.
      expect(messagesInvalidated).toEqual(["conv-source-1"]);
    });

    test("writes exactly the summary the card renders", async () => {
      // The button's promise is that the conversation holds what the card
      // shows, so the two read from the same resolved text.
      conversationRow = { conversationType: "background" };
      const signal = makeSignal();
      const decision = makeDecision({
        selectedChannels: ["slack"],
        renderedCopy: {
          slack: {
            title: "Digest",
            body: "Short popup line.",
            conversationSeedMessage:
              "**Digest**\n\n- First item\n- Second item",
          },
        },
      });

      const item = await writeHomeFeedItemForSignal(signal, decision);

      expect(messageAppends[0]!.content).toBe(item!.summary);
      expect(messageAppends[0]!.content).toBe(
        "**Digest**\n\n- First item\n- Second item",
      );
    });

    test("records the paired row when vellum already wrote the body", async () => {
      // `pairDeliveryWithConversation` wrote the body, so nothing is written
      // again here, but the card still records the row so an edit can reach it
      // when the delivery walk does not.
      conversationRow = { conversationType: "background" };
      const signal = makeSignal();
      const decision = makeDecision({
        selectedChannels: ["vellum"],
        renderedCopy: {
          vellum: { title: "Nightly briefing", body: "Three things today." },
        },
      });

      const item = await writeHomeFeedItemForSignal(
        signal,
        decision,
        makeVellumDelivery(),
      );

      expect(item?.conversationId).toBe("conv-source-1");
      expect(messageAppends).toHaveLength(0);
      expect(item?.metadata?.notificationConversationMessageId).toBe(
        "msg-paired",
      );
    });

    test("skips the append when a sentinel source context leaves no target", async () => {
      // No resolvable conversation means the client hides the button, so
      // there is nothing to keep honest.
      conversationRow = null;
      const signal = makeSignal({
        sourceContextId: "job-1700000000",
        attentionHints: {
          requiresAction: false,
          urgency: "medium",
          isAsyncBackground: true,
          visibleInSourceNow: false,
        },
      });
      const decision = makeDecision({
        selectedChannels: ["telegram"],
        renderedCopy: {
          telegram: { title: "Retries exhausted", body: "Gave up after 3." },
        },
      });

      const item = await writeHomeFeedItemForSignal(signal, decision);

      expect(item).not.toBeNull();
      expect(item?.conversationId).toBeUndefined();
      expect(messageAppends).toHaveLength(0);
    });

    test("writes no message when the card is rejected", async () => {
      // The body only belongs in a conversation because a card sends the user
      // there, so a rejected card must not leave one behind.
      conversationRow = { conversationType: "background" };
      feedItemSchemaShouldReject = true;
      const signal = makeSignal();
      const decision = makeDecision({
        selectedChannels: ["telegram"],
        renderedCopy: {
          telegram: { title: "Nightly briefing", body: "Three things today." },
        },
      });

      const item = await writeHomeFeedItemForSignal(signal, decision);

      expect(item).toBeNull();
      expect(appendCalls).toHaveLength(0);
      expect(messageAppends).toHaveLength(0);
      expect(messagesInvalidated).toHaveLength(0);
    });

    test("a failed message write leaves the persisted feed item intact", async () => {
      conversationRow = { conversationType: "background" };
      messageAppendShouldThrow = true;
      const signal = makeSignal();
      const decision = makeDecision({
        selectedChannels: ["telegram"],
        renderedCopy: {
          telegram: { title: "Nightly briefing", body: "Three things today." },
        },
      });

      const item = await writeHomeFeedItemForSignal(signal, decision);

      expect(item).not.toBeNull();
      expect(appendCalls).toHaveLength(1);
      expect(messageAppends).toHaveLength(0);
      expect(item?.metadata?.notificationConversationMessageId).toBeUndefined();
    });

    test("records the paired row when the vellum delivery failed", async () => {
      // The row exists whatever the delivery reported, and a failed delivery
      // is exactly the case the edit path's delivery walk skips.
      conversationRow = { conversationType: "background" };
      const signal = makeSignal();
      const decision = makeDecision({
        selectedChannels: ["vellum"],
        renderedCopy: {
          vellum: { title: "Nightly briefing", body: "Three things today." },
        },
      });

      const item = await writeHomeFeedItemForSignal(
        signal,
        decision,
        makeVellumDelivery({ status: "failed", messageId: "msg-paired" }),
      );

      expect(item?.metadata?.notificationConversationMessageId).toBe(
        "msg-paired",
      );
      // The row already exists, so nothing is written a second time.
      expect(messageAppends).toHaveLength(0);
    });

    test("records nothing when the paired row sits outside the card's conversation", async () => {
      // Guardian producers pair a fresh conversation rather than the one the
      // card opens, so its row is not the card's to rewrite.
      conversationRow = { conversationType: "background" };
      const signal = makeSignal();
      const decision = makeDecision({
        selectedChannels: ["vellum"],
        renderedCopy: {
          vellum: { title: "Approval needed", body: "Allow this?" },
        },
      });

      const item = await writeHomeFeedItemForSignal(
        signal,
        decision,
        makeVellumDelivery({
          conversationId: "conv-guardian-request",
          messageId: "msg-guardian",
        }),
      );

      expect(item?.conversationId).toBe("conv-source-1");
      expect(item?.metadata?.notificationConversationMessageId).toBeUndefined();
      expect(messageAppends).toHaveLength(0);
    });

    test("records the paired row when it backs a sentinel card", async () => {
      // A sentinel `sourceContextId` puts the paired conversation behind the
      // button, so its row is the one the card carries.
      conversationRow = null;
      const signal = makeSignal({
        sourceContextId: "job-1700000000",
        attentionHints: {
          requiresAction: false,
          urgency: "medium",
          isAsyncBackground: true,
          visibleInSourceNow: false,
        },
      });
      const decision = makeDecision({
        selectedChannels: ["vellum"],
        renderedCopy: {
          vellum: { title: "Retries exhausted", body: "Gave up after 3." },
        },
      });

      const item = await writeHomeFeedItemForSignal(
        signal,
        decision,
        makeVellumDelivery({ conversationId: "conv-paired", messageId: "m-p" }),
      );

      expect(item?.conversationId).toBe("conv-paired");
      expect(item?.metadata?.notificationConversationMessageId).toBe("m-p");
    });

    test("strips a producer-supplied handle from the card metadata", async () => {
      // `contextPayload` reaches the card verbatim, and this key addresses a
      // row for rewriting, so a producer must not be able to set it.
      conversationRow = { conversationType: "background" };
      const signal = makeSignal({
        contextPayload: {
          title: "Nightly briefing",
          notificationConversationMessageId: "msg-somebody-elses",
        },
      });
      const decision = makeDecision({
        selectedChannels: ["vellum"],
        renderedCopy: {
          vellum: { title: "Nightly briefing", body: "Three things today." },
        },
      });

      const item = await writeHomeFeedItemForSignal(
        signal,
        decision,
        makeVellumDelivery(),
      );

      expect(item?.metadata?.notificationConversationMessageId).toBe(
        "msg-paired",
      );
    });

    test("drops a producer-supplied handle when the card records none", async () => {
      conversationRow = { conversationType: "background" };
      const signal = makeSignal({
        contextPayload: {
          title: "Approval needed",
          notificationConversationMessageId: "msg-somebody-elses",
        },
      });
      const decision = makeDecision({
        selectedChannels: ["vellum"],
        renderedCopy: {
          vellum: { title: "Approval needed", body: "Allow this?" },
        },
      });

      const item = await writeHomeFeedItemForSignal(
        signal,
        decision,
        makeVellumDelivery({ conversationId: "conv-guardian-request" }),
      );

      expect(item?.metadata?.notificationConversationMessageId).toBeUndefined();
    });

    test("a producer-supplied handle never displaces the real one", async () => {
      conversationRow = { conversationType: "background" };
      const signal = makeSignal({
        contextPayload: {
          title: "Nightly briefing",
          notificationConversationMessageId: "msg-somebody-elses",
        },
      });
      const decision = makeDecision({
        selectedChannels: ["telegram"],
        renderedCopy: {
          telegram: { title: "Nightly briefing", body: "Three things today." },
        },
      });

      const item = await writeHomeFeedItemForSignal(signal, decision);

      expect(item?.metadata?.notificationConversationMessageId).toBe("msg-1");
    });

    test("preserves producer metadata alongside the message handle", async () => {
      conversationRow = { conversationType: "background" };
      const signal = makeSignal({
        contextPayload: { title: "Nightly briefing", scheduleId: "sched-7" },
      });
      const decision = makeDecision({
        selectedChannels: ["telegram"],
        renderedCopy: {
          telegram: { title: "Nightly briefing", body: "Three things today." },
        },
      });

      const item = await writeHomeFeedItemForSignal(signal, decision);

      expect(item?.metadata).toMatchObject({
        title: "Nightly briefing",
        scheduleId: "sched-7",
        notificationConversationMessageId: "msg-1",
      });
    });
  });

  describe("updateFeedItemConversationMessage", () => {
    function makeItem(metadata?: Record<string, unknown>): FeedItem {
      return {
        id: "notif:sig-test-1",
        type: "notification",
        priority: 50,
        title: "Nightly briefing",
        summary: "Three things today.",
        timestamp: "2026-08-19T00:00:00.000Z",
        createdAt: "2026-08-19T00:00:00.000Z",
        status: "new",
        category: "scheduling",
        noteworthy: false,
        fromAssistant: false,
        conversationId: "conv-source-1",
        ...(metadata ? { metadata } : {}),
      };
    }

    test("rewrites the message the card owns", () => {
      messageOwners.set("msg-9", "conv-source-1");

      const rewritten = updateFeedItemConversationMessage(
        makeItem({ notificationConversationMessageId: "msg-9" }),
        "Four things now.",
      );

      expect(rewritten).toBe(true);
      expect(messageRewrites).toEqual([
        { messageId: "msg-9", content: "Four things now." },
      ]);
      expect(messagesInvalidated).toEqual(["conv-source-1"]);
    });

    test("reports no rewrite when the card owns no message", () => {
      // The vellum-delivered case: the delivery row carries the handle and
      // the adapter rewrites it, so there is nothing to do here.
      const rewritten = updateFeedItemConversationMessage(
        makeItem({ scheduleId: "sched-7" }),
        "Four things now.",
      );

      expect(rewritten).toBe(false);
      expect(messageRewrites).toHaveLength(0);
    });

    test("refuses a handle addressing a row outside the card's conversation", () => {
      // Nothing should be able to point the rewrite at an unrelated message.
      messageOwners.set("msg-9", "conv-somebody-elses");

      const rewritten = updateFeedItemConversationMessage(
        makeItem({ notificationConversationMessageId: "msg-9" }),
        "Four things now.",
      );

      expect(rewritten).toBe(false);
      expect(messageRewrites).toHaveLength(0);
    });

    test("refuses a handle whose row no longer exists", () => {
      const rewritten = updateFeedItemConversationMessage(
        makeItem({ notificationConversationMessageId: "msg-9" }),
        "Four things now.",
      );

      expect(rewritten).toBe(false);
      expect(messageRewrites).toHaveLength(0);
    });

    test("stands down when the delivery walk already rewrote the row", () => {
      messageOwners.set("msg-9", "conv-source-1");

      const rewritten = updateFeedItemConversationMessage(
        makeItem({ notificationConversationMessageId: "msg-9" }),
        "Four things now.",
        new Set(["msg-9"]),
      );

      expect(rewritten).toBe(false);
      expect(messageRewrites).toHaveLength(0);
    });

    test("rewrites when the walk touched some other row", () => {
      messageOwners.set("msg-9", "conv-source-1");

      const rewritten = updateFeedItemConversationMessage(
        makeItem({ notificationConversationMessageId: "msg-9" }),
        "Four things now.",
        new Set(["1700000000.0001"]),
      );

      expect(rewritten).toBe(true);
      expect(messageRewrites).toHaveLength(1);
    });

    test("reports no rewrite when the ownership lookup throws", () => {
      // The edit has already patched the feed and run the channel updates by
      // the time this runs, so a store that cannot answer must not abort it.
      messageOwners.set("msg-9", "conv-source-1");
      messageLookupShouldThrow = true;

      const rewritten = updateFeedItemConversationMessage(
        makeItem({ notificationConversationMessageId: "msg-9" }),
        "Four things now.",
      );

      expect(rewritten).toBe(false);
      expect(messageRewrites).toHaveLength(0);
    });

    test("reports no rewrite when the store write throws", () => {
      messageOwners.set("msg-9", "conv-source-1");
      messageRewriteShouldThrow = true;

      const rewritten = updateFeedItemConversationMessage(
        makeItem({ notificationConversationMessageId: "msg-9" }),
        "Four things now.",
      );

      expect(rewritten).toBe(false);
    });
  });
});
