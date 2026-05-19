import { describe, expect, test } from "bun:test";

import {
  excludeHighUrgency,
  filterByCategory,
  getPresentCategories,
  groupByTime,
  sortFeedItems,
} from "@/lib/home/feed-utils.js";
import type { FeedItem } from "@/lib/home/types.js";

function makeFeedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "item-1",
    type: "notification",
    priority: 0,
    title: "Test item",
    summary: "A test feed item",
    timestamp: "2025-01-15T10:00:00Z",
    status: "new",
    createdAt: "2025-01-15T10:00:00Z",
    ...overrides,
  };
}

// MARK: - sortFeedItems

describe("sortFeedItems", () => {
  test("sorts by priority descending", () => {
    const items = [
      makeFeedItem({ id: "low", priority: 1 }),
      makeFeedItem({ id: "high", priority: 10 }),
      makeFeedItem({ id: "mid", priority: 5 }),
    ];

    const sorted = sortFeedItems(items);

    expect(sorted.map((i) => i.id)).toEqual(["high", "mid", "low"]);
  });

  test("sorts by createdAt descending when priorities are equal", () => {
    const items = [
      makeFeedItem({
        id: "older",
        priority: 5,
        createdAt: "2025-01-10T10:00:00Z",
      }),
      makeFeedItem({
        id: "newer",
        priority: 5,
        createdAt: "2025-01-15T10:00:00Z",
      }),
    ];

    const sorted = sortFeedItems(items);

    expect(sorted.map((i) => i.id)).toEqual(["newer", "older"]);
  });

  test("sorts by priority first, then createdAt", () => {
    const items = [
      makeFeedItem({
        id: "low-newer",
        priority: 1,
        createdAt: "2025-01-20T10:00:00Z",
      }),
      makeFeedItem({
        id: "high-older",
        priority: 10,
        createdAt: "2025-01-01T10:00:00Z",
      }),
      makeFeedItem({
        id: "high-newer",
        priority: 10,
        createdAt: "2025-01-15T10:00:00Z",
      }),
    ];

    const sorted = sortFeedItems(items);

    expect(sorted.map((i) => i.id)).toEqual([
      "high-newer",
      "high-older",
      "low-newer",
    ]);
  });

  test("does not mutate the original array", () => {
    const items = [
      makeFeedItem({ id: "a", priority: 1 }),
      makeFeedItem({ id: "b", priority: 10 }),
    ];

    sortFeedItems(items);

    expect(items[0]!.id).toBe("a");
    expect(items[1]!.id).toBe("b");
  });

  test("returns empty array for empty input", () => {
    expect(sortFeedItems([])).toEqual([]);
  });
});

// MARK: - groupByTime

describe("groupByTime", () => {
  test("buckets items into today, yesterday, and older", () => {
    const now = new Date();
    const todayISO = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      12,
    ).toISOString();
    const yesterdayISO = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      12,
    ).toISOString();
    const olderISO = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 5,
      12,
    ).toISOString();

    const items = [
      makeFeedItem({ id: "today", createdAt: todayISO }),
      makeFeedItem({ id: "yesterday", createdAt: yesterdayISO }),
      makeFeedItem({ id: "older", createdAt: olderISO }),
    ];

    const groups = groupByTime(items);

    expect(groups.get("today")?.map((i) => i.id)).toEqual(["today"]);
    expect(groups.get("yesterday")?.map((i) => i.id)).toEqual(["yesterday"]);
    expect(groups.get("older")?.map((i) => i.id)).toEqual(["older"]);
  });

  test("omits empty groups", () => {
    const now = new Date();
    const todayISO = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      12,
    ).toISOString();

    const items = [makeFeedItem({ id: "today", createdAt: todayISO })];

    const groups = groupByTime(items);

    expect(groups.has("today")).toBe(true);
    expect(groups.has("yesterday")).toBe(false);
    expect(groups.has("older")).toBe(false);
  });

  test("preserves insertion order: today -> yesterday -> older", () => {
    const now = new Date();
    const todayISO = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      12,
    ).toISOString();
    const yesterdayISO = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      12,
    ).toISOString();
    const olderISO = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 5,
      12,
    ).toISOString();

    const items = [
      makeFeedItem({ id: "older", createdAt: olderISO }),
      makeFeedItem({ id: "today", createdAt: todayISO }),
      makeFeedItem({ id: "yesterday", createdAt: yesterdayISO }),
    ];

    const groups = groupByTime(items);
    const keys = [...groups.keys()];

    expect(keys).toEqual(["today", "yesterday", "older"]);
  });

  test("returns empty map for empty input", () => {
    const groups = groupByTime([]);

    expect(groups.size).toBe(0);
  });

  test("items at start of today are bucketed as today", () => {
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0,
      0,
      0,
    ).toISOString();

    const items = [makeFeedItem({ id: "start-of-day", createdAt: startOfToday })];
    const groups = groupByTime(items);

    expect(groups.get("today")?.map((i) => i.id)).toEqual(["start-of-day"]);
  });
});

// MARK: - filterByCategory

describe("filterByCategory", () => {
  test("returns items matching the given category", () => {
    const items = [
      makeFeedItem({ id: "sec", category: "security" }),
      makeFeedItem({ id: "email", category: "email" }),
      makeFeedItem({ id: "sec2", category: "security" }),
    ];

    const filtered = filterByCategory(items, "security");

    expect(filtered.map((i) => i.id)).toEqual(["sec", "sec2"]);
  });

  test("returns empty array when no items match", () => {
    const items = [
      makeFeedItem({ id: "email", category: "email" }),
      makeFeedItem({ id: "bg", category: "background" }),
    ];

    const filtered = filterByCategory(items, "security");

    expect(filtered).toEqual([]);
  });

  test("returns all items when category is null", () => {
    const items = [
      makeFeedItem({ id: "sec", category: "security" }),
      makeFeedItem({ id: "email", category: "email" }),
    ];

    const filtered = filterByCategory(items, null);

    expect(filtered).toHaveLength(2);
    expect(filtered.map((i) => i.id)).toEqual(["sec", "email"]);
  });

  test("treats items without a category as system when filtering", () => {
    const items = [
      makeFeedItem({ id: "has-cat", category: "email" }),
      makeFeedItem({ id: "no-cat" }),
    ];

    expect(filterByCategory(items, "email").map((i) => i.id)).toEqual(["has-cat"]);
    expect(filterByCategory(items, "system").map((i) => i.id)).toEqual(["no-cat"]);
  });
});

// MARK: - excludeHighUrgency

describe("excludeHighUrgency", () => {
  test("excludes items with urgency 'high'", () => {
    const items = [
      makeFeedItem({ id: "low", urgency: "low" }),
      makeFeedItem({ id: "high", urgency: "high" }),
    ];

    const result = excludeHighUrgency(items);

    expect(result.map((i) => i.id)).toEqual(["low"]);
  });

  test("excludes items with urgency 'critical'", () => {
    const items = [
      makeFeedItem({ id: "med", urgency: "medium" }),
      makeFeedItem({ id: "crit", urgency: "critical" }),
    ];

    const result = excludeHighUrgency(items);

    expect(result.map((i) => i.id)).toEqual(["med"]);
  });

  test("keeps items with no urgency set", () => {
    const items = [
      makeFeedItem({ id: "no-urgency" }),
      makeFeedItem({ id: "low", urgency: "low" }),
    ];

    const result = excludeHighUrgency(items);

    expect(result).toHaveLength(2);
  });

  test("keeps items with low or medium urgency", () => {
    const items = [
      makeFeedItem({ id: "low", urgency: "low" }),
      makeFeedItem({ id: "med", urgency: "medium" }),
      makeFeedItem({ id: "high", urgency: "high" }),
      makeFeedItem({ id: "crit", urgency: "critical" }),
    ];

    const result = excludeHighUrgency(items);

    expect(result.map((i) => i.id)).toEqual(["low", "med"]);
  });

  test("returns empty array when all items are high urgency", () => {
    const items = [
      makeFeedItem({ id: "high", urgency: "high" }),
      makeFeedItem({ id: "crit", urgency: "critical" }),
    ];

    const result = excludeHighUrgency(items);

    expect(result).toEqual([]);
  });
});

// MARK: - getPresentCategories

describe("getPresentCategories", () => {
  test("returns deduplicated categories", () => {
    const items = [
      makeFeedItem({ category: "security" }),
      makeFeedItem({ category: "email" }),
      makeFeedItem({ category: "security" }),
      makeFeedItem({ category: "background" }),
    ];

    const categories = getPresentCategories(items);

    expect(categories).toHaveLength(3);
    expect(new Set(categories)).toEqual(
      new Set(["security", "email", "background"]),
    );
  });

  test("treats items without a category as system", () => {
    const items = [
      makeFeedItem({ category: "email" }),
      makeFeedItem({}),
      makeFeedItem({ category: "system" }),
    ];

    const categories = getPresentCategories(items);

    expect(categories).toHaveLength(2);
    expect(new Set(categories)).toEqual(new Set(["email", "system"]));
  });

  test("returns system for items without explicit categories", () => {
    const items = [makeFeedItem({}), makeFeedItem({})];

    const categories = getPresentCategories(items);

    expect(categories).toEqual(["system"]);
  });

  test("returns empty array for empty input", () => {
    expect(getPresentCategories([])).toEqual([]);
  });
});
