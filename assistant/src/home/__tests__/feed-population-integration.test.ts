import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the in-process SSE hub so the writer's publish path is a
// no-op in these tests. Must be in place before the writer module is
// imported (directly or transitively) so the dynamic import below
// picks it up.
const publishSpy = mock<(event: unknown) => Promise<void>>(async () => {});

mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: publishSpy,
    subscribe: () => () => {},
  },
}));

const { emitFeedEvent } = await import("../emit-feed-event.js");
const { readHomeFeed, MAX_ACTIONS_PER_SOURCE } =
  await import("../feed-writer.js");

type FeedItemSource = "gmail" | "slack" | "calendar" | "assistant";

const ALL_SOURCES: FeedItemSource[] = [
  "gmail",
  "slack",
  "calendar",
  "assistant",
];

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-feed-integ-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  publishSpy.mockClear();
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

describe("feed population integration", () => {
  test("items from all 4 sources coexist and are sorted by priority", async () => {
    // Emit one item per source with distinct priorities.
    await emitFeedEvent({
      source: "gmail",
      title: "Gmail action",
      summary: "Replied to a thread.",
      priority: 30,
      dedupKey: "gmail-1",
    });
    await emitFeedEvent({
      source: "slack",
      title: "Slack action",
      summary: "Sent a message in #general.",
      priority: 70,
      dedupKey: "slack-1",
    });
    await emitFeedEvent({
      source: "calendar",
      title: "Calendar action",
      summary: "Meeting prep reminder.",
      priority: 50,
      dedupKey: "cal-1",
    });
    await emitFeedEvent({
      source: "assistant",
      title: "Assistant action",
      summary: "Ran weekly review.",
      priority: 90,
      dedupKey: "asst-1",
    });

    const feed = readHomeFeed();
    expect(feed.items).toHaveLength(4);

    // Verify all four sources are present.
    const sources = new Set(feed.items.map((i) => i.source));
    for (const s of ALL_SOURCES) {
      expect(sources.has(s)).toBe(true);
    }

    // Items should be sorted by priority DESC.
    const priorities = feed.items.map((i) => i.priority);
    for (let i = 1; i < priorities.length; i++) {
      expect(priorities[i - 1]!).toBeGreaterThanOrEqual(priorities[i]!);
    }

    // Spot-check the ordering: assistant (90) first, gmail (30) last.
    expect(feed.items[0]!.source).toBe("assistant");
    expect(feed.items[feed.items.length - 1]!.source).toBe("gmail");
  });

  test("per-source cap holds across mixed sources", async () => {
    // Emit MAX + 5 items for gmail and MAX + 5 for slack, plus a
    // handful from calendar and assistant. Only the capped sources
    // should be pruned.
    const overflow = MAX_ACTIONS_PER_SOURCE + 5;

    for (let i = 0; i < overflow; i++) {
      await emitFeedEvent({
        source: "gmail",
        title: `Gmail item ${i}`,
        summary: `Gmail summary ${i}`,
        priority: 50,
      });
    }

    for (let i = 0; i < overflow; i++) {
      await emitFeedEvent({
        source: "slack",
        title: `Slack item ${i}`,
        summary: `Slack summary ${i}`,
        priority: 50,
      });
    }

    // A few items from the other two sources — should be untouched.
    for (let i = 0; i < 3; i++) {
      await emitFeedEvent({
        source: "calendar",
        title: `Calendar item ${i}`,
        summary: `Calendar summary ${i}`,
        priority: 50,
      });
    }
    for (let i = 0; i < 2; i++) {
      await emitFeedEvent({
        source: "assistant",
        title: `Assistant item ${i}`,
        summary: `Assistant summary ${i}`,
        priority: 50,
      });
    }

    const feed = readHomeFeed();

    const gmailItems = feed.items.filter((i) => i.source === "gmail");
    const slackItems = feed.items.filter((i) => i.source === "slack");
    const calendarItems = feed.items.filter((i) => i.source === "calendar");
    const assistantItems = feed.items.filter((i) => i.source === "assistant");

    expect(gmailItems).toHaveLength(MAX_ACTIONS_PER_SOURCE);
    expect(slackItems).toHaveLength(MAX_ACTIONS_PER_SOURCE);
    expect(calendarItems).toHaveLength(3);
    expect(assistantItems).toHaveLength(2);
  });

  test("expired items are filtered out at read time", async () => {
    // One item that expired in the past, one that is still valid.
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();

    await emitFeedEvent({
      source: "gmail",
      title: "Expired item",
      summary: "Should not appear.",
      expiresAt: pastDate,
      dedupKey: "expired-1",
    });
    await emitFeedEvent({
      source: "slack",
      title: "Still valid",
      summary: "Should appear.",
      expiresAt: futureDate,
      dedupKey: "valid-1",
    });
    await emitFeedEvent({
      source: "calendar",
      title: "No expiry",
      summary: "Should also appear.",
      dedupKey: "no-expiry-1",
    });

    const feed = readHomeFeed();
    expect(feed.items).toHaveLength(2);

    const titles = feed.items.map((i) => i.title);
    expect(titles).toContain("Still valid");
    expect(titles).toContain("No expiry");
    expect(titles).not.toContain("Expired item");
  });

  test("dedup: two items with the same dedupKey produce only one entry", async () => {
    await emitFeedEvent({
      source: "gmail",
      title: "First version",
      summary: "Original summary.",
      dedupKey: "shared-key",
    });
    await emitFeedEvent({
      source: "gmail",
      title: "Second version",
      summary: "Updated summary.",
      dedupKey: "shared-key",
    });

    const feed = readHomeFeed();
    const matching = feed.items.filter((i) => i.id === "emit:gmail:shared-key");
    expect(matching).toHaveLength(1);
    expect(matching[0]!.title).toBe("Second version");
    expect(matching[0]!.summary).toBe("Updated summary.");
  });

  test("dedup works across reads — no phantom duplicates", async () => {
    await emitFeedEvent({
      source: "assistant",
      title: "Version 1",
      summary: "First emit.",
      dedupKey: "cross-read",
    });

    // Read once to confirm the item is there.
    const feed1 = readHomeFeed();
    expect(
      feed1.items.filter((i) => i.id === "emit:assistant:cross-read"),
    ).toHaveLength(1);

    // Emit again with the same dedupKey.
    await emitFeedEvent({
      source: "assistant",
      title: "Version 2",
      summary: "Second emit.",
      dedupKey: "cross-read",
    });

    const feed2 = readHomeFeed();
    const matching = feed2.items.filter(
      (i) => i.id === "emit:assistant:cross-read",
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]!.title).toBe("Version 2");
  });

  test("mixed priorities and urgencies sort correctly", async () => {
    const events: Array<{
      source: FeedItemSource;
      title: string;
      priority: number;
      dedupKey: string;
    }> = [
      {
        source: "gmail",
        title: "Low priority gmail",
        priority: 10,
        dedupKey: "g-low",
      },
      {
        source: "slack",
        title: "High priority slack",
        priority: 95,
        dedupKey: "s-high",
      },
      {
        source: "calendar",
        title: "Mid priority calendar",
        priority: 50,
        dedupKey: "c-mid",
      },
      {
        source: "assistant",
        title: "High priority assistant",
        priority: 95,
        dedupKey: "a-high",
      },
      {
        source: "gmail",
        title: "Mid priority gmail",
        priority: 50,
        dedupKey: "g-mid",
      },
      {
        source: "slack",
        title: "Low priority slack",
        priority: 20,
        dedupKey: "s-low",
      },
    ];

    for (const e of events) {
      await emitFeedEvent({
        source: e.source,
        title: e.title,
        summary: `Summary for ${e.title}`,
        priority: e.priority,
        dedupKey: e.dedupKey,
      });
    }

    const feed = readHomeFeed();
    expect(feed.items).toHaveLength(6);

    // Verify descending priority order.
    const priorities = feed.items.map((i) => i.priority);
    for (let i = 1; i < priorities.length; i++) {
      expect(priorities[i - 1]!).toBeGreaterThanOrEqual(priorities[i]!);
    }
  });
});
