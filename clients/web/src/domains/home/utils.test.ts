/**
 * Tests for the home feed's shared derivations in `utils`.
 */

import { describe, expect, test } from "bun:test";

import type { FeedItem } from "@vellumai/assistant-api";

import {
  clearAllArgs,
  getFeedItemScheduleId,
  getFeedItemSkillId,
  getVisibleFeedItems,
  guardianLabelKey,
  markAllReadArgs,
  resolveFeedItemTitle,
  sortFeedItems,
} from "./utils";

function feedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  const timestamp = new Date("2024-01-01T00:00:00.000Z").toISOString();
  return {
    id: "item-1",
    type: "notification",
    priority: 50,
    summary: "Something happened",
    timestamp,
    createdAt: timestamp,
    status: "new",
    ...overrides,
  };
}

describe("getFeedItemScheduleId", () => {
  test("returns the schedule id a scheduled-run notification carries", () => {
    const item = feedItem({ metadata: { scheduleId: "schedule-1" } });
    expect(getFeedItemScheduleId(item)).toBe("schedule-1");
  });

  test("returns null when the item has no metadata", () => {
    expect(getFeedItemScheduleId(feedItem())).toBeNull();
  });

  test("returns null when the metadata carries no schedule id", () => {
    const item = feedItem({ metadata: { conversationId: "conv-1" } });
    expect(getFeedItemScheduleId(item)).toBeNull();
  });

  test("returns null for an empty schedule id", () => {
    const item = feedItem({ metadata: { scheduleId: "" } });
    expect(getFeedItemScheduleId(item)).toBeNull();
  });

  test("returns null when the schedule id is not a string", () => {
    const item = feedItem({ metadata: { scheduleId: 42 } });
    expect(getFeedItemScheduleId(item)).toBeNull();
  });

  test("returns null when there is no item", () => {
    expect(getFeedItemScheduleId(null)).toBeNull();
  });
});

describe("getFeedItemSkillId", () => {
  test("returns the skill id a background skill update carries", () => {
    const item = feedItem({ metadata: { skillId: "weekly-export" } });
    expect(getFeedItemSkillId(item)).toBe("weekly-export");
  });

  test("returns null when the item has no metadata", () => {
    expect(getFeedItemSkillId(feedItem())).toBeNull();
  });

  test("returns null when the metadata carries no skill id", () => {
    const item = feedItem({ metadata: { scheduleId: "schedule-1" } });
    expect(getFeedItemSkillId(item)).toBeNull();
  });

  test("returns null for an empty skill id", () => {
    const item = feedItem({ metadata: { skillId: "" } });
    expect(getFeedItemSkillId(item)).toBeNull();
  });

  test("returns null when the skill id is not a string", () => {
    const item = feedItem({ metadata: { skillId: 42 } });
    expect(getFeedItemSkillId(item)).toBeNull();
  });

  test("returns null when there is no item", () => {
    expect(getFeedItemSkillId(null)).toBeNull();
  });

  test("reads the two entity ids independently on one item", () => {
    const item = feedItem({
      metadata: { scheduleId: "schedule-1", skillId: "weekly-export" },
    });
    expect(getFeedItemScheduleId(item)).toBe("schedule-1");
    expect(getFeedItemSkillId(item)).toBe("weekly-export");
  });
});

describe("resolveFeedItemTitle", () => {
  test("returns the item's own title", () => {
    const item = feedItem({ title: "Deploy finished", summary: "**Details**" });
    expect(resolveFeedItemTitle(item)).toBe("Deploy finished");
  });

  test("falls back to the summary as plain text when there is no title", () => {
    const item = feedItem({ summary: "**Deploy** finished" });
    expect(resolveFeedItemTitle(item)).toBe("Deploy finished");
  });

  test("falls back to a fixed name when the summary flattens to nothing", () => {
    const item = feedItem({ summary: "```\nnpm run build\n```" });
    expect(resolveFeedItemTitle(item)).toBe("Notification");
  });
});

function guardianItem(
  status: NonNullable<FeedItem["guardianRequest"]>["status"],
  overrides: Partial<FeedItem> = {},
): FeedItem {
  return feedItem({
    id: `guardian:req-${status}`,
    urgency: "high",
    guardianRequest: {
      requestId: `req-${status}`,
      kind: "tool_approval",
      intent: "approval",
      status,
    },
    ...overrides,
  });
}

describe("guardian feed item derivations", () => {
  test("a pending guardian item stays visible despite high urgency", () => {
    const pending = guardianItem("pending");
    const plainHighUrgency = feedItem({ id: "urgent", urgency: "high" });
    const visible = getVisibleFeedItems([pending, plainHighUrgency]);
    expect(visible.map((i) => i.id)).toEqual([pending.id]);
  });

  test("a pending guardian item sorts ahead of higher-priority items", () => {
    const pending = guardianItem("pending");
    const louder = feedItem({ id: "louder", priority: 90 });
    expect(sortFeedItems([louder, pending]).map((i) => i.id)).toEqual([
      pending.id,
      louder.id,
    ]);
  });

  test("bulk payloads exclude pending guardian ids and include receipts", () => {
    const pending = guardianItem("pending");
    const receipt = guardianItem("approved", {
      id: "guardian:req-approved",
      urgency: "medium",
    });
    const routine = feedItem({ id: "routine" });
    const visible = [pending, receipt, routine];

    expect(clearAllArgs(visible).ids.sort()).toEqual(
      [receipt.id, routine.id].sort(),
    );
    expect(markAllReadArgs(visible).ids.sort()).toEqual(
      [receipt.id, routine.id].sort(),
    );
  });

  test("a guardian item is named for what its state asks of the user", () => {
    expect(guardianLabelKey(guardianItem("pending"))).toBe(
      "category.guardianAction",
    );
    // Settled: nothing is needed of anyone, so it is named for what it was.
    expect(guardianLabelKey(guardianItem("approved"))).toBe(
      "category.guardianRequest",
    );
    const question = feedItem({
      guardianRequest: {
        requestId: "req-q",
        kind: "pending_question",
        intent: "question",
        status: "pending",
      },
    });
    expect(guardianLabelKey(question)).toBe("category.guardianQuestion");
    expect(guardianLabelKey(feedItem())).toBeNull();
  });
});
