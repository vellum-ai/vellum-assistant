/**
 * Tests for the home feed's shared derivations in `utils`.
 */

import { describe, expect, test } from "bun:test";

import type { FeedItem } from "@vellumai/assistant-api";

import { getFeedItemScheduleId } from "./utils";

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
