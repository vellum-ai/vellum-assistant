/**
 * Tests for the toast publisher.
 *
 * The rule the toast lives or dies by is "terminal transitions only". A toast
 * on every progress update would put the interruption stream back on a
 * different surface, so that is what most of this asserts.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { FeedItem } from "../../api/responses/home.js";

const broadcasts: Array<Record<string, unknown>> = [];
mock.module("../../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: Record<string, unknown>) => {
    broadcasts.push(msg);
  },
}));

const { publishFeedToast } = await import("../publish-feed-toast.js");

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  const now = new Date().toISOString();
  return {
    id: "notif:1",
    type: "notification",
    bucket: "worth_knowing",
    priority: 60,
    title: "Competitor research done",
    summary: "Found three competitors worth a look.",
    timestamp: now,
    createdAt: now,
    status: "new",
    ...overrides,
  };
}

beforeEach(() => {
  broadcasts.length = 0;
});

describe("publishFeedToast", () => {
  test("publishes for a worth-knowing notification", () => {
    expect(publishFeedToast(item())).toBe(true);

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      type: "feed_toast",
      feedItemId: "notif:1",
      bucket: "worth_knowing",
      title: "Competitor research done",
    });
  });

  test("routine activity never toasts", () => {
    expect(publishFeedToast(item({ bucket: "activity" }))).toBe(false);
    expect(broadcasts).toHaveLength(0);
  });

  test("a row with no bucket never toasts", () => {
    expect(publishFeedToast(item({ bucket: undefined }))).toBe(false);
  });

  test("a dismissed row never toasts", () => {
    expect(publishFeedToast(item({ status: "dismissed" }))).toBe(false);
  });

  test.each(["queued", "running"] as const)(
    "a run that is only %s never toasts",
    (state) => {
      const row = item({
        type: "run",
        bucket: "worth_knowing",
        run: {
          runId: "r1",
          kind: "subagent",
          state,
          startedAt: new Date().toISOString(),
        },
      });

      expect(publishFeedToast(row)).toBe(false);
    },
  );

  test("a run blocked on the user toasts even though it has not finished", () => {
    const row = item({
      type: "run",
      bucket: "needs_you",
      run: {
        runId: "r1",
        kind: "subagent",
        state: "needs_input",
        startedAt: new Date().toISOString(),
      },
    });

    expect(publishFeedToast(row)).toBe(true);
    expect(broadcasts[0]!.bucket).toBe("needs_you");
  });

  test("a terminal run toasts", () => {
    const row = item({
      type: "run",
      bucket: "worth_knowing",
      run: {
        runId: "r1",
        kind: "subagent",
        state: "succeeded",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      },
    });

    expect(publishFeedToast(row)).toBe(true);
  });

  test("a system-health counter never toasts", () => {
    // It counts, it does not push. Even hypothetically bucketed up, the row
    // kind alone disqualifies it.
    const row = item({
      type: "system_health",
      bucket: "worth_knowing",
      systemHealth: {
        subsystem: "heartbeat",
        failureCount: 17,
        firstFailureAt: new Date().toISOString(),
        lastFailureAt: new Date().toISOString(),
      },
    });

    expect(publishFeedToast(row)).toBe(false);
  });

  test("names the durable row behind it, so a missed toast costs nothing", () => {
    publishFeedToast(item({ id: "notif:abc" }));

    expect(broadcasts[0]!.feedItemId).toBe("notif:abc");
  });

  test("offers an inline action when the row carries one", () => {
    publishFeedToast(
      item({
        bucket: "needs_you",
        actions: [{ id: "approve", label: "Approve", prompt: "Approve it" }],
      }),
    );

    expect(broadcasts[0]!.actionLabel).toBe("Approve");
    expect(String(broadcasts[0]!.actionPath)).toContain("feedItemId=notif");
  });

  test("offers no action when there is nowhere for it to go", () => {
    publishFeedToast(item({ bucket: "needs_you" }));

    expect(broadcasts[0]!.actionLabel).toBeUndefined();
  });
});
