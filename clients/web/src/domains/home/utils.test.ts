/**
 * Tests for the home feed's shared derivations in `utils`.
 */

import { describe, expect, test } from "bun:test";

import type { FeedItem } from "@vellumai/assistant-api";

import {
  getFeedItemScheduleId,
  getFeedItemSkillId,
  resolveFeedItemTitle,
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
