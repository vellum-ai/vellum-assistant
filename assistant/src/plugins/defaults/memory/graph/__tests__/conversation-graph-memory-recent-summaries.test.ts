/**
 * Tests for `ConversationGraphMemory.fetchRecentSummaries` — the cross-DB-ready
 * two-step that replaced the `memory_summaries × conversations` JOIN. It reads
 * candidate summaries, resolves each conversation's type separately, and
 * partitions in JS: up to 3 user summaries (most recent first), then at most 1
 * background/scheduled to fill, excluding the current conversation and any
 * summary whose conversation row is gone (the old innerJoin's drop).
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../../persistence/db-init.js";
import {
  conversations,
  memorySummaries,
} from "../../../../../persistence/schema/index.js";
import { ConversationGraphMemory } from "../conversation-graph-memory.js";

await initializeDb();

const CURRENT = "conv-current";

function seedConversation(id: string, type: string): void {
  getDb()
    .insert(conversations)
    .values({ id, conversationType: type, createdAt: 0, updatedAt: 0 })
    .run();
}

function seedSummary(
  scopeKey: string,
  summary: string,
  updatedAt: number,
): void {
  getDb()
    .insert(memorySummaries)
    .values({
      id: `sum-${scopeKey}`,
      scope: "conversation",
      scopeKey,
      summary,
      tokenEstimate: 10,
      version: 1,
      startAt: 0,
      endAt: updatedAt,
      createdAt: updatedAt,
      updatedAt,
    })
    .run();
}

function recentSummaries(): string[] {
  const cgm = new ConversationGraphMemory(CURRENT);
  return (
    cgm as unknown as { fetchRecentSummaries: () => string[] }
  ).fetchRecentSummaries();
}

beforeEach(() => {
  getDb().delete(memorySummaries).run();
  getDb().delete(conversations).run();
});

describe("fetchRecentSummaries", () => {
  test("returns the 3 most-recent user summaries and no background when 3+ users exist", () => {
    ["u1", "u2", "u3", "u4"].forEach((id, i) => {
      seedConversation(id, "standard");
      seedSummary(id, `user ${id}`, 100 + i); // u4 is newest at 103
    });
    // A background summary that is newer than every user summary must still be
    // dropped once 3 user summaries are available.
    seedConversation("b1", "background");
    seedSummary("b1", "bg b1", 1000);

    expect(recentSummaries()).toEqual(["user u4", "user u3", "user u2"]);
  });

  test("fills the remaining slot with the single most-recent background when fewer than 3 users", () => {
    seedConversation("u1", "standard");
    seedSummary("u1", "user u1", 200);
    seedConversation("u2", "standard");
    seedSummary("u2", "user u2", 100);
    seedConversation("b1", "background");
    seedSummary("b1", "bg b1", 300); // newest overall
    seedConversation("b2", "scheduled");
    seedSummary("b2", "bg b2", 250);

    expect(recentSummaries()).toEqual(["user u1", "user u2", "bg b1"]);
  });

  test("returns a single background summary when there are no user summaries", () => {
    seedConversation("b1", "background");
    seedSummary("b1", "bg b1", 100);
    seedConversation("b2", "scheduled");
    seedSummary("b2", "bg b2", 200); // newest

    expect(recentSummaries()).toEqual(["bg b2"]);
  });

  test("excludes the current conversation and orphan summaries", () => {
    seedSummary(CURRENT, "self summary", 500); // excluded: current conversation
    seedSummary("orphan", "orphan summary", 400); // excluded: no conversation row
    seedConversation("u1", "standard");
    seedSummary("u1", "user u1", 100);

    expect(recentSummaries()).toEqual(["user u1"]);
  });

  test("orders results most-recent first by updatedAt", () => {
    seedConversation("a", "standard");
    seedSummary("a", "older", 100);
    seedConversation("b", "standard");
    seedSummary("b", "newer", 200);

    expect(recentSummaries()).toEqual(["newer", "older"]);
  });

  test("returns an empty list when there are no summaries", () => {
    expect(recentSummaries()).toEqual([]);
  });

  test("finds user summaries even behind 100+ newer background summaries", () => {
    // 3 (older) user summaries, then many newer background summaries. A
    // fixed-window scan would cut the user rows off; the full scan must still
    // return them.
    seedConversation("u1", "standard");
    seedSummary("u1", "user u1", 1);
    seedConversation("u2", "standard");
    seedSummary("u2", "user u2", 2);
    seedConversation("u3", "standard");
    seedSummary("u3", "user u3", 3);
    for (let i = 0; i < 110; i++) {
      seedConversation(`bg${i}`, "background");
      seedSummary(`bg${i}`, `bg ${i}`, 100 + i); // all newer than the users
    }
    expect(recentSummaries()).toEqual(["user u3", "user u2", "user u1"]);
  });
});
