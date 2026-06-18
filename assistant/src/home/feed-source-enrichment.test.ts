import { describe, expect, it } from "bun:test";

import { type FeedItem } from "../api/responses/home.js";
import {
  classifyConversationSource,
  enrichFeedItemsWithSource,
  type FeedSourceEnrichmentDeps,
} from "./feed-source-enrichment.js";

function makeItem(partial: Partial<FeedItem> & Pick<FeedItem, "id">): FeedItem {
  return {
    type: "notification",
    priority: 50,
    summary: "summary",
    timestamp: "2026-06-18T00:00:00.000Z",
    createdAt: "2026-06-18T00:00:00.000Z",
    status: "new",
    ...partial,
  };
}

describe("classifyConversationSource", () => {
  it("maps each known producer source to its coarse type", () => {
    expect(classifyConversationSource("heartbeat")).toBe("heartbeat");
    expect(classifyConversationSource("memory-retrospective")).toBe(
      "memory_consolidation",
    );
    expect(classifyConversationSource("memory-retrospective-fork")).toBe(
      "memory_consolidation",
    );
    expect(classifyConversationSource("schedule")).toBe("schedule");
    expect(classifyConversationSource("auto-analysis")).toBe("auto_analysis");
    expect(classifyConversationSource("user")).toBe("user");
    expect(classifyConversationSource("home-feed")).toBe("user");
  });

  it("falls through to 'other' for unknown / paired-delivery / empty sources", () => {
    expect(classifyConversationSource("notification")).toBe("other");
    expect(classifyConversationSource("something-else")).toBe("other");
    expect(classifyConversationSource(null)).toBe("other");
    expect(classifyConversationSource(undefined)).toBe("other");
  });
});

describe("enrichFeedItemsWithSource", () => {
  const deps = (
    conv: Record<string, { source: string; scheduleJobId: string | null }>,
    schedules: Record<string, string> = {},
  ): FeedSourceEnrichmentDeps => ({
    getConversationRow: (id) => conv[id] ?? null,
    getScheduleName: (id) => schedules[id] ?? null,
  });

  it("classifies a heartbeat item with a static label", () => {
    const [item] = enrichFeedItemsWithSource(
      [makeItem({ id: "n1", conversationId: "c1" })],
      deps({ c1: { source: "heartbeat", scheduleJobId: null } }),
    );
    expect(item.sourceType).toBe("heartbeat");
    expect(item.sourceKey).toBe("heartbeat");
    expect(item.sourceLabel).toBe("Heartbeat");
  });

  it("classifies a memory-consolidation item", () => {
    const [item] = enrichFeedItemsWithSource(
      [makeItem({ id: "n2", conversationId: "c2" })],
      deps({ c2: { source: "memory-retrospective", scheduleJobId: null } }),
    );
    expect(item.sourceType).toBe("memory_consolidation");
    expect(item.sourceKey).toBe("memory_consolidation");
    expect(item.sourceLabel).toBe("Memory consolidation");
  });

  it("gives distinct keys and names to two different schedules", () => {
    const [a, b] = enrichFeedItemsWithSource(
      [
        makeItem({ id: "n3", conversationId: "cA" }),
        makeItem({ id: "n4", conversationId: "cB" }),
      ],
      deps(
        {
          cA: { source: "schedule", scheduleJobId: "sched-A" },
          cB: { source: "schedule", scheduleJobId: "sched-B" },
        },
        { "sched-A": "Morning digest", "sched-B": "Evening recap" },
      ),
    );
    expect(a.sourceType).toBe("schedule");
    expect(a.sourceKey).toBe("schedule:sched-A");
    expect(a.sourceLabel).toBe("Morning digest");
    // scheduleId recovered from the conversation row is surfaced in metadata.
    expect(a.metadata?.scheduleId).toBe("sched-A");

    expect(b.sourceKey).toBe("schedule:sched-B");
    expect(b.sourceLabel).toBe("Evening recap");
  });

  it("prefers an explicit metadata.scheduleId over the conversation row", () => {
    const [item] = enrichFeedItemsWithSource(
      [
        makeItem({
          id: "n5",
          conversationId: "cX",
          metadata: { scheduleId: "from-payload" },
        }),
      ],
      deps(
        { cX: { source: "schedule", scheduleJobId: "from-row" } },
        { "from-payload": "Payload schedule" },
      ),
    );
    expect(item.sourceKey).toBe("schedule:from-payload");
    expect(item.sourceLabel).toBe("Payload schedule");
  });

  it("labels a schedule with no resolvable name as 'Scheduled'", () => {
    const [item] = enrichFeedItemsWithSource(
      [makeItem({ id: "n6", conversationId: "cY" })],
      deps({ cY: { source: "schedule", scheduleJobId: "gone" } }),
    );
    expect(item.sourceKey).toBe("schedule:gone");
    expect(item.sourceLabel).toBe("Scheduled");
  });

  it("classifies items with no source conversation as 'other'", () => {
    const [item] = enrichFeedItemsWithSource(
      [makeItem({ id: "n7" })],
      deps({}),
    );
    expect(item.sourceType).toBe("other");
    expect(item.sourceKey).toBe("other");
    expect(item.sourceLabel).toBe("Other");
  });

  it("resolves each distinct conversation at most once", () => {
    const calls: string[] = [];
    enrichFeedItemsWithSource(
      [
        makeItem({ id: "n8", conversationId: "dup" }),
        makeItem({ id: "n9", conversationId: "dup" }),
      ],
      {
        getConversationRow: (id) => {
          calls.push(id);
          return { source: "heartbeat", scheduleJobId: null };
        },
      },
    );
    expect(calls).toEqual(["dup"]);
  });
});
