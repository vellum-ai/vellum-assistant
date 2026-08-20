import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { FeedItem } from "../../home/feed-types.js";
import type { NotificationDeliveryRow } from "../deliveries-store.js";

// ── Module mocks ───────────────────────────────────────────────────────
//
// The home-feed writer is deliberately NOT mocked: these tests exercise
// the real on-disk patch semantics through a temp workspace so the
// "an empty title never clears the field" guarantee is covered end to
// end. Only the sqlite-backed stores, the broadcaster, and the SSE hub
// are intercepted.

mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async () => {},
    subscribe: () => () => {},
  },
  broadcastMessage: () => {},
}));

let decisionRow: { id: string } | null = null;
let deliveryRows: NotificationDeliveryRow[] = [];
const renderedCopyPatches: Array<{
  id: string;
  patch: { renderedTitle?: string; renderedBody?: string };
}> = [];

mock.module("../decisions-store.js", () => ({
  findLatestDecisionByEventId: () => decisionRow,
}));

mock.module("../deliveries-store.js", () => ({
  findDeliveriesByDecisionId: () => deliveryRows,
  updateDeliveryRenderedCopy: (
    id: string,
    patch: { renderedTitle?: string; renderedBody?: string },
  ) => {
    renderedCopyPatches.push({ id, patch });
    return true;
  },
}));

const adapterUpdates: Array<{ title?: string; body?: string }> = [];
let adapterSupportsUpdate = true;

const messageRewrites: Array<{ messageId: string; content: string }> = [];

/** messageId -> the conversation it belongs to, for the scoped lookup. */
const messageOwners = new Map<string, string>();

let messageLookupShouldThrow = false;

mock.module("../../persistence/conversation-crud.js", () => ({
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
    messageRewrites.push({ messageId, content });
  },
  // Pulled in by `home-feed-side-effect`, which this module imports for the
  // owned-message rewrite. The write paths never run under an edit.
  addMessage: async () => ({ id: "msg-unused" }),
  getConversation: () => null,
}));

mock.module("../emit-signal.js", () => ({
  getBroadcaster: () => ({
    getAdapter: () =>
      adapterSupportsUpdate
        ? {
            update: async (
              target: { messageId?: string | null },
              patch: { title?: string; body?: string },
            ) => {
              adapterUpdates.push(patch);
              return {
                success: true,
                messageId: target.messageId ?? undefined,
              };
            },
          }
        : {},
  }),
}));

const { appendFeedItem, readHomeFeed } =
  await import("../../home/feed-writer.js");
const { editNotification, normalizeFeedItemId, feedItemIdToSignalId } =
  await import("../edit-notification.js");

// ── Fixtures ───────────────────────────────────────────────────────────

const SIGNAL_ID = "sig-1";
const FEED_ITEM_ID = `notif:${SIGNAL_ID}`;

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: FEED_ITEM_ID,
    type: "notification",
    priority: 50,
    title: "Backup complete",
    summary: "Nightly backup finished",
    timestamp: "2026-04-14T12:00:00.000Z",
    status: "new",
    createdAt: "2026-04-14T12:00:00.000Z",
    ...overrides,
  } as FeedItem;
}

function makeDelivery(
  overrides: Partial<NotificationDeliveryRow> = {},
): NotificationDeliveryRow {
  return {
    id: "del-1",
    notificationDecisionId: "dec-1",
    channel: "slack",
    destination: "C123",
    status: "sent",
    attempt: 1,
    renderedTitle: "Backup complete",
    renderedBody: "Nightly backup finished",
    errorCode: null,
    errorMessage: null,
    sentAt: 1700000000000,
    conversationId: null,
    messageId: "1700000000.0001",
    conversationStrategy: null,
    conversationAction: null,
    conversationTargetId: null,
    conversationFallbackUsed: null,
    clientDeliveryStatus: null,
    clientDeliveryError: null,
    clientDeliveryAt: null,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

function readItem(id = FEED_ITEM_ID): FeedItem | undefined {
  return readHomeFeed().items.find((item) => item.id === id);
}

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-edit-notif-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  decisionRow = null;
  deliveryRows = [];
  renderedCopyPatches.length = 0;
  adapterUpdates.length = 0;
  messageRewrites.length = 0;
  messageOwners.clear();
  messageOwners.set("msg-9", "conv-source-1");
  messageLookupShouldThrow = false;
  adapterSupportsUpdate = true;
});

afterEach(() => {
  if (origWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  }
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("normalizeFeedItemId", () => {
  test("adds the notif: prefix to a bare uuid and leaves prefixed ids alone", () => {
    expect(normalizeFeedItemId(SIGNAL_ID)).toBe(FEED_ITEM_ID);
    expect(normalizeFeedItemId(` ${FEED_ITEM_ID} `)).toBe(FEED_ITEM_ID);
    expect(feedItemIdToSignalId(FEED_ITEM_ID)).toBe(SIGNAL_ID);
  });
});

describe("editNotification", () => {
  test("applies a title edit to the feed item", async () => {
    await appendFeedItem(makeItem());

    const result = await editNotification({
      id: FEED_ITEM_ID,
      title: "Backup finished early",
    });

    expect(result).not.toBeNull();
    expect(result!.feedItem.title).toBe("Backup finished early");
    expect(readItem()!.title).toBe("Backup finished early");
    expect(readItem()!.summary).toBe("Nightly backup finished");
  });

  test("accepts a bare signal uuid as the id", async () => {
    await appendFeedItem(makeItem());

    const result = await editNotification({
      id: SIGNAL_ID,
      title: "Renamed via bare id",
    });

    expect(result!.feedItem.id).toBe(FEED_ITEM_ID);
    expect(readItem()!.title).toBe("Renamed via bare id");
  });

  test("an empty title edit leaves the previous title intact", async () => {
    await appendFeedItem(makeItem());

    const result = await editNotification({ id: FEED_ITEM_ID, title: "" });

    expect(result).not.toBeNull();
    expect(result!.feedItem.title).toBe("Backup complete");
    expect(readItem()!.title).toBe("Backup complete");
  });

  test("a whitespace-only title edit leaves the previous title intact", async () => {
    await appendFeedItem(makeItem());

    const result = await editNotification({ id: FEED_ITEM_ID, title: "   \t" });

    expect(result!.feedItem.title).toBe("Backup complete");
    expect(readItem()!.title).toBe("Backup complete");
  });

  test("an empty title edit does not push a channel update", async () => {
    await appendFeedItem(makeItem());
    decisionRow = { id: "dec-1" };
    deliveryRows = [makeDelivery()];

    const result = await editNotification({ id: FEED_ITEM_ID, title: "" });

    expect(result!.channels).toEqual([]);
    expect(adapterUpdates).toHaveLength(0);
    expect(renderedCopyPatches).toHaveLength(0);
  });

  test("a body-only edit does not disturb the title", async () => {
    await appendFeedItem(makeItem());

    const result = await editNotification({
      id: FEED_ITEM_ID,
      body: "Nightly backup finished in 4 minutes",
    });

    expect(result!.feedItem.title).toBe("Backup complete");
    expect(result!.feedItem.summary).toBe(
      "Nightly backup finished in 4 minutes",
    );
    expect(readItem()!.title).toBe("Backup complete");
  });

  test("a feed-only edit skips channel updates entirely", async () => {
    await appendFeedItem(makeItem());
    decisionRow = { id: "dec-1" };
    deliveryRows = [makeDelivery()];

    const result = await editNotification({
      id: FEED_ITEM_ID,
      status: "dismissed",
    });

    expect(result!.feedItem.status).toBe("dismissed");
    expect(result!.channels).toEqual([]);
    expect(adapterUpdates).toHaveLength(0);
  });

  test("returns null for an unknown id", async () => {
    await appendFeedItem(makeItem());

    const result = await editNotification({
      id: "notif:does-not-exist",
      title: "Nope",
    });

    expect(result).toBeNull();
  });

  test("pushes the new copy to update-capable channel deliveries", async () => {
    await appendFeedItem(makeItem());
    decisionRow = { id: "dec-1" };
    deliveryRows = [makeDelivery()];

    const result = await editNotification({
      id: FEED_ITEM_ID,
      title: "Backup finished early",
      body: "Done in 4 minutes",
    });

    expect(adapterUpdates).toEqual([
      { title: "Backup finished early", body: "Done in 4 minutes" },
    ]);
    expect(renderedCopyPatches).toEqual([
      {
        id: "del-1",
        patch: {
          renderedTitle: "Backup finished early",
          renderedBody: "Done in 4 minutes",
        },
      },
    ]);
    expect(result!.channels).toEqual([
      { channel: "slack", deliveryId: "del-1", outcome: "updated" },
    ]);
  });

  test("reports channels whose adapter cannot edit in place as unsupported", async () => {
    await appendFeedItem(makeItem());
    decisionRow = { id: "dec-1" };
    deliveryRows = [makeDelivery()];
    adapterSupportsUpdate = false;

    const result = await editNotification({
      id: FEED_ITEM_ID,
      title: "Backup finished early",
    });

    expect(result!.channels[0]!.outcome).toBe("unsupported");
    expect(renderedCopyPatches).toHaveLength(0);
  });

  test("skips deliveries that never reached sent", async () => {
    await appendFeedItem(makeItem());
    decisionRow = { id: "dec-1" };
    deliveryRows = [makeDelivery({ status: "failed" })];

    const result = await editNotification({
      id: FEED_ITEM_ID,
      title: "Backup finished early",
    });

    expect(result!.channels[0]!.outcome).toBe("skipped");
    expect(adapterUpdates).toHaveLength(0);
  });

  test("skips channel updates when the feed item has no persisted decision", async () => {
    await appendFeedItem(makeItem());
    decisionRow = null;

    const result = await editNotification({
      id: FEED_ITEM_ID,
      title: "Backup finished early",
    });

    expect(result!.channels).toEqual([]);
    expect(adapterUpdates).toHaveLength(0);
  });

  describe("a card that owns its conversation message", () => {
    // Signals no channel delivered a body for carry the message id on the
    // feed item, so the rewrite hangs off the card rather than a delivery row.
    const OWNED = {
      conversationId: "conv-source-1",
      metadata: { notificationConversationMessageId: "msg-9" },
    };

    test("a body edit rewrites the owned message", async () => {
      await appendFeedItem(makeItem(OWNED));

      const result = await editNotification({
        id: FEED_ITEM_ID,
        body: "Backup finished, 3 volumes",
      });

      expect(result).not.toBeNull();
      expect(messageRewrites).toEqual([
        { messageId: "msg-9", content: "Backup finished, 3 volumes" },
      ]);
    });

    test("the rewrite runs even when the signal recorded no deliveries", async () => {
      await appendFeedItem(makeItem(OWNED));
      decisionRow = null;

      await editNotification({
        id: FEED_ITEM_ID,
        body: "Backup finished, 3 volumes",
      });

      expect(messageRewrites).toHaveLength(1);
    });

    test("a title-only edit leaves the owned message alone", async () => {
      // The feed keeps its summary on a title-only patch, and the message
      // holds the body, so rewriting it would put the two out of step.
      await appendFeedItem(makeItem(OWNED));

      const result = await editNotification({
        id: FEED_ITEM_ID,
        title: "Backup finished early",
      });

      expect(result!.feedItem.summary).toBe("Nightly backup finished");
      expect(messageRewrites).toHaveLength(0);
    });

    test("stands down when the adapter already rewrote that row", async () => {
      // The ordinary vellum case: the delivery walk rewrites the paired row,
      // so the card must not write it a second time.
      await appendFeedItem(makeItem(OWNED));
      decisionRow = { id: "dec-1" };
      deliveryRows = [makeDelivery({ channel: "vellum", messageId: "msg-9" })];

      await editNotification({ id: FEED_ITEM_ID, body: "New body" });

      expect(adapterUpdates).toHaveLength(1);
      expect(messageRewrites).toHaveLength(0);
    });

    test("rewrites when a sent delivery's status write was lost", async () => {
      // `sendAndRecord` swallows a failed status write after a successful
      // send, leaving a row that reads pending, which the walk skips.
      await appendFeedItem(makeItem(OWNED));
      decisionRow = { id: "dec-1" };
      deliveryRows = [
        makeDelivery({
          channel: "vellum",
          messageId: "msg-9",
          status: "pending",
        }),
      ];

      await editNotification({ id: FEED_ITEM_ID, body: "New body" });

      expect(adapterUpdates).toHaveLength(0);
      expect(messageRewrites).toEqual([
        { messageId: "msg-9", content: "New body" },
      ]);
    });

    test("rewrites when the adapter update failed", async () => {
      await appendFeedItem(makeItem(OWNED));
      decisionRow = { id: "dec-1" };
      deliveryRows = [makeDelivery({ channel: "vellum", messageId: "msg-9" })];
      adapterSupportsUpdate = false;

      await editNotification({ id: FEED_ITEM_ID, body: "New body" });

      expect(messageRewrites).toHaveLength(1);
    });

    test("a title-only edit leaves the row alone even with deliveries", async () => {
      await appendFeedItem(makeItem(OWNED));
      decisionRow = { id: "dec-1" };
      deliveryRows = [makeDelivery({ channel: "vellum", messageId: "msg-9" })];

      await editNotification({ id: FEED_ITEM_ID, title: "Renamed" });

      expect(messageRewrites).toHaveLength(0);
    });

    test("a handle addressing another conversation is refused", async () => {
      await appendFeedItem(makeItem(OWNED));
      messageOwners.set("msg-9", "conv-somebody-elses");

      await editNotification({ id: FEED_ITEM_ID, body: "New body" });

      expect(messageRewrites).toHaveLength(0);
    });

    test("an ownership lookup failure does not abort the edit", async () => {
      // The feed patch and any channel updates have already landed at this
      // point, so the edit must still report them rather than throwing.
      await appendFeedItem(makeItem(OWNED));
      messageLookupShouldThrow = true;

      const result = await editNotification({
        id: FEED_ITEM_ID,
        body: "Backup finished, 3 volumes",
      });

      expect(result).not.toBeNull();
      expect(result!.feedItem.summary).toBe("Backup finished, 3 volumes");
      expect(readItem()!.summary).toBe("Backup finished, 3 volumes");
      expect(messageRewrites).toHaveLength(0);
    });

    test("a card owning no message is untouched by a body edit", async () => {
      await appendFeedItem(makeItem());

      await editNotification({ id: FEED_ITEM_ID, body: "New body" });

      expect(messageRewrites).toHaveLength(0);
    });
  });
});
