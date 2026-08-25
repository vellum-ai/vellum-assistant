/**
 * Tests for the System health counter.
 *
 * The behaviour that matters is the one the noise audit turns on: one durable
 * row per failing subsystem, counting, that clears itself after a run of
 * successes. A second row, or a count that resets, would put the per-failure
 * stream straight back.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { FeedItem, FeedItemStatus } from "../../api/responses/home.js";

let feedItems: FeedItem[] = [];

mock.module("../feed-writer.js", () => ({
  appendFeedItem: async (item: FeedItem) => {
    const idx = feedItems.findIndex((existing) => existing.id === item.id);
    if (idx === -1) {
      feedItems.push(item);
    } else {
      feedItems[idx] = item;
    }
  },
  readHomeFeed: () => ({
    version: 2 as const,
    items: feedItems,
    updatedAt: new Date().toISOString(),
  }),
  bulkSetFeedItemStatus: async (
    from: readonly FeedItemStatus[],
    to: FeedItemStatus,
    ids?: readonly string[],
  ) => {
    let count = 0;
    for (let i = 0; i < feedItems.length; i++) {
      const item = feedItems[i]!;
      if (ids && !ids.includes(item.id)) {
        continue;
      }
      if (!from.includes(item.status)) {
        continue;
      }
      feedItems[i] = { ...item, status: to };
      count += 1;
    }
    return count;
  },
}));

const {
  recordSubsystemFailure,
  recordSubsystemSuccess,
  resetSystemHealthStreaksForTests,
  systemHealthItemId,
} = await import("../system-health.js");

const HEARTBEAT_ROW = systemHealthItemId("heartbeat");

function row(): FeedItem | undefined {
  return feedItems.find((item) => item.id === HEARTBEAT_ROW);
}

beforeEach(() => {
  feedItems = [];
  resetSystemHealthStreaksForTests();
});

describe("recordSubsystemFailure", () => {
  test("writes one row and counts on it, however many times it fires", async () => {
    for (let i = 0; i < 17; i++) {
      await recordSubsystemFailure({
        subsystem: "heartbeat",
        label: "Heartbeat",
        errorSummary: "The model provider did not answer.",
      });
    }

    expect(feedItems).toHaveLength(1);
    expect(row()!.type).toBe("system_health");
    expect(row()!.systemHealth?.failureCount).toBe(17);
    expect(row()!.summary).toContain("17 times");
  });

  test("holds the first failure time, so the row says how long this has gone on", async () => {
    await recordSubsystemFailure({ subsystem: "heartbeat", label: "Heartbeat" });
    const firstAt = row()!.systemHealth!.firstFailureAt;

    await recordSubsystemFailure({ subsystem: "heartbeat", label: "Heartbeat" });

    expect(row()!.systemHealth!.firstFailureAt).toBe(firstAt);
    expect(row()!.systemHealth!.lastFailureAt).not.toBe("");
  });

  test("never re-flags a row the reader has already seen", async () => {
    // The count keeps climbing without lighting the bell again. That is the
    // whole point of collapsing repeats into a counter.
    await recordSubsystemFailure({ subsystem: "heartbeat", label: "Heartbeat" });
    feedItems[0] = { ...feedItems[0]!, status: "seen" };

    await recordSubsystemFailure({ subsystem: "heartbeat", label: "Heartbeat" });

    expect(row()!.status).toBe("seen");
    expect(row()!.systemHealth!.failureCount).toBe(2);
  });

  test("a dismissed row stays dismissed", async () => {
    await recordSubsystemFailure({ subsystem: "heartbeat", label: "Heartbeat" });
    feedItems[0] = { ...feedItems[0]!, status: "dismissed" };

    await recordSubsystemFailure({ subsystem: "heartbeat", label: "Heartbeat" });

    expect(row()!.status).toBe("dismissed");
  });

  test("strips raw error constants out of the summary", async () => {
    await recordSubsystemFailure({
      subsystem: "heartbeat",
      label: "Heartbeat",
      errorSummary: "model_provider: Agent turn failed (PROVIDER_API_TIMEOUT)",
    });

    expect(row()!.systemHealth!.lastErrorSummary).not.toContain(
      "PROVIDER_API_TIMEOUT",
    );
    expect(row()!.systemHealth!.lastErrorSummary).toContain("Agent turn failed");
  });

  test("carries a repair affordance when one exists", async () => {
    await recordSubsystemFailure({
      subsystem: "telegram_webhook",
      label: "Telegram",
      remedy: { path: "/settings/channels", label: "Reconnect" },
    });

    const health = feedItems[0]!.systemHealth!;
    expect(health.remedyPath).toBe("/settings/channels");
    expect(health.remedyLabel).toBe("Reconnect");
  });

  test("stays in Activity and never asks to be pushed", async () => {
    await recordSubsystemFailure({ subsystem: "heartbeat", label: "Heartbeat" });

    expect(row()!.bucket).toBe("activity");
    expect(row()!.noteworthy).toBe(false);
  });

  test("keeps subsystems apart", async () => {
    await recordSubsystemFailure({ subsystem: "heartbeat", label: "Heartbeat" });
    await recordSubsystemFailure({ subsystem: "filing", label: "Filing" });

    expect(feedItems).toHaveLength(2);
  });
});

describe("recordSubsystemSuccess", () => {
  test("clears the row only after a run of successes", async () => {
    await recordSubsystemFailure({ subsystem: "heartbeat", label: "Heartbeat" });

    await recordSubsystemSuccess("heartbeat");
    await recordSubsystemSuccess("heartbeat");
    expect(row()!.status).not.toBe("dismissed");

    await recordSubsystemSuccess("heartbeat");
    expect(row()!.status).toBe("dismissed");
  });

  test("a failure inside the run restarts the count", async () => {
    // One lucky tick during an ongoing outage must not erase the record of it.
    await recordSubsystemFailure({ subsystem: "heartbeat", label: "Heartbeat" });
    await recordSubsystemSuccess("heartbeat");
    await recordSubsystemSuccess("heartbeat");

    await recordSubsystemFailure({ subsystem: "heartbeat", label: "Heartbeat" });
    await recordSubsystemSuccess("heartbeat");
    await recordSubsystemSuccess("heartbeat");

    expect(row()!.status).not.toBe("dismissed");
  });

  test("costs nothing when the subsystem has no row", async () => {
    for (let i = 0; i < 5; i++) {
      await recordSubsystemSuccess("heartbeat");
    }

    expect(feedItems).toHaveLength(0);
  });
});
