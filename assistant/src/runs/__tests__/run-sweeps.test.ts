/**
 * Tests for the activity digest sweep.
 *
 * The digest exists so a day of heartbeats and memory sweeps does not bury the
 * handful of rows that mean something. Everything asserted here is about what
 * it must NOT swallow: a failure, a notable success, and anything still
 * running are exactly the rows a reader came for.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { FeedItem, FeedItemRunState } from "../../api/responses/home.js";

let feedItems: FeedItem[] = [];

mock.module("../../home/feed-writer.js", () => ({
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
}));

mock.module("../run-store.js", () => ({
  reconcileOrphanedRuns: async () => 0,
}));

const { DIGEST_ITEM_ID, sweepRunDigest } = await import("../run-sweeps.js");

function runRow(
  id: string,
  state: FeedItemRunState,
  overrides: Partial<FeedItem> = {},
): FeedItem {
  const now = new Date().toISOString();
  return {
    id: `run:${id}`,
    type: "run",
    bucket: "activity",
    priority: 30,
    title: id,
    summary: "Finished.",
    timestamp: now,
    createdAt: now,
    status: "seen",
    run: { runId: id, kind: "heartbeat", state, startedAt: now, endedAt: now },
    ...overrides,
  };
}

function digest(): FeedItem | undefined {
  return feedItems.find((item) => item.id === DIGEST_ITEM_ID);
}

beforeEach(() => {
  feedItems = [];
});

describe("sweepRunDigest", () => {
  test("folds routine finished runs into one row and hides them", async () => {
    feedItems = [
      runRow("a", "succeeded"),
      runRow("b", "succeeded"),
      runRow("c", "succeeded"),
    ];

    await sweepRunDigest();

    expect(digest()!.type).toBe("digest");
    expect(digest()!.digest?.runCount).toBe(3);
    expect(digest()!.summary).toContain("all succeeded");
    // A summary of work nobody was waiting on never asks for attention.
    expect(digest()!.status).toBe("seen");
    expect(
      feedItems.filter(
        (item) => item.type === "run" && item.status !== "dismissed",
      ),
    ).toHaveLength(0);
  });

  test("does not draw below the minimum: two rows say more than a count of them", async () => {
    feedItems = [runRow("a", "succeeded"), runRow("b", "succeeded")];

    await sweepRunDigest();

    expect(digest()).toBeUndefined();
    expect(
      feedItems.every((item) => item.status !== "dismissed"),
    ).toBe(true);
  });

  test("never swallows a failure", async () => {
    const failure = runRow("bad", "failed", { bucket: "worth_knowing" });
    feedItems = [
      runRow("a", "succeeded"),
      runRow("b", "succeeded"),
      runRow("c", "succeeded"),
      failure,
    ];

    await sweepRunDigest();

    expect(
      feedItems.find((item) => item.id === failure.id)!.status,
    ).not.toBe("dismissed");
    expect(digest()!.digest?.runCount).toBe(3);
  });

  test("never swallows a notable success", async () => {
    const notable = runRow("skill", "succeeded", { bucket: "worth_knowing" });
    feedItems = [
      runRow("a", "succeeded"),
      runRow("b", "succeeded"),
      runRow("c", "succeeded"),
      notable,
    ];

    await sweepRunDigest();

    expect(feedItems.find((item) => item.id === notable.id)!.status).not.toBe(
      "dismissed",
    );
  });

  test("never swallows work that is still going", async () => {
    const live = runRow("live", "running");
    feedItems = [
      runRow("a", "succeeded"),
      runRow("b", "succeeded"),
      runRow("c", "succeeded"),
      live,
    ];

    await sweepRunDigest();

    expect(feedItems.find((item) => item.id === live.id)!.status).not.toBe(
      "dismissed",
    );
  });

  test("counts unfinished runs it did fold", async () => {
    feedItems = [
      runRow("a", "succeeded"),
      runRow("b", "succeeded"),
      runRow("c", "cancelled"),
    ];

    await sweepRunDigest();

    expect(digest()!.digest?.runCount).toBe(3);
    expect(digest()!.summary).toContain("all succeeded");
  });

  test("leaves ordinary notifications alone", async () => {
    const notification: FeedItem = {
      id: "notif:1",
      type: "notification",
      bucket: "activity",
      priority: 30,
      summary: "Something happened.",
      timestamp: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      status: "new",
    };
    feedItems = [
      runRow("a", "succeeded"),
      runRow("b", "succeeded"),
      runRow("c", "succeeded"),
      notification,
    ];

    await sweepRunDigest();

    expect(feedItems.find((item) => item.id === "notif:1")!.status).toBe("new");
  });

  test("ignores runs that finished outside the window", async () => {
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    feedItems = [
      runRow("a", "succeeded", {
        run: {
          runId: "a",
          kind: "heartbeat",
          state: "succeeded",
          startedAt: old,
          endedAt: old,
        },
      }),
      runRow("b", "succeeded"),
      runRow("c", "succeeded"),
    ];

    await sweepRunDigest();

    expect(digest()).toBeUndefined();
  });

  test("rewrites one digest row rather than stacking them", async () => {
    feedItems = [
      runRow("a", "succeeded"),
      runRow("b", "succeeded"),
      runRow("c", "succeeded"),
    ];
    await sweepRunDigest();

    feedItems.push(
      runRow("d", "succeeded"),
      runRow("e", "succeeded"),
      runRow("f", "succeeded"),
    );
    await sweepRunDigest();

    expect(feedItems.filter((item) => item.type === "digest")).toHaveLength(1);
    expect(digest()!.digest?.runCount).toBe(3);
  });
});
