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

mock.module("../emit-signal.js", () => ({
  getBroadcaster: () => ({
    getAdapter: () =>
      adapterSupportsUpdate
        ? {
            update: async (
              _target: unknown,
              patch: { title?: string; body?: string },
            ) => {
              adapterUpdates.push(patch);
              return { success: true };
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
});
