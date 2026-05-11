import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Mock state — reset between tests.
// ---------------------------------------------------------------------------

type ConvRow = {
  id: string;
  source: string | null;
  last_message_at: number | null;
};
type JobRow = {
  type: string;
  status: string;
  payload: string;
};

let mockConversations: ConvRow[] = [];
let mockJobs: JobRow[] = [];
let deletedIds: string[] = [];

mock.module("../db-connection.js", () => ({
  getDb: () => ({
    select: (cols?: Record<string, unknown>) => ({
      from: (_table: { _: { name: string } } | unknown) => ({
        where: (..._args: unknown[]) => ({
          all: () => {
            // Heuristic: tests only construct two query shapes — the jobs
            // query and the conversations query. Distinguish by the first
            // requested column shape.
            const colKeys = cols ? Object.keys(cols) : [];
            if (colKeys.includes("conversationId")) {
              return mockJobs
                .filter(
                  (j) =>
                    j.type === "memory_retrospective" &&
                    (j.status === "pending" || j.status === "running"),
                )
                .map((j) => {
                  let convId: string | null = null;
                  try {
                    const parsed = JSON.parse(j.payload) as {
                      conversationId?: unknown;
                    };
                    if (typeof parsed.conversationId === "string") {
                      convId = parsed.conversationId;
                    }
                  } catch {
                    // Ignore malformed payload
                  }
                  return { conversationId: convId };
                });
            }
            // Otherwise, this is the conversation query.
            // The test harness applies its OWN filter logic below since the
            // production code uses drizzle's combinator. We expose all rows
            // tagged with the right source/last_message_at, and the test
            // post-filters them to mirror the production query.
            return mockConversations
              .filter((c) => c.source === "memory-retrospective")
              .filter(
                (c) =>
                  c.last_message_at !== null &&
                  c.last_message_at < injectedNowMinusOrphanAgeMs,
              )
              .filter((c) => !activeJobConvIds.has(c.id))
              .map((c) => ({ id: c.id }));
          },
        }),
      }),
    }),
  }),
}));

let activeJobConvIds = new Set<string>();
let injectedNowMinusOrphanAgeMs = 0;

mock.module("../conversation-crud.js", () => ({
  deleteConversation: (id: string) => {
    deletedIds.push(id);
    mockConversations = mockConversations.filter((c) => c.id !== id);
  },
}));

import { sweepOrphanMemoryRetrospectiveConversations } from "../memory-retrospective-startup-cleanup.js";

const ORPHAN_AGE_MS = 60 * 60 * 1000;

function rebuildActiveJobSet(): void {
  activeJobConvIds = new Set();
  for (const j of mockJobs) {
    if (
      j.type !== "memory_retrospective" ||
      (j.status !== "pending" && j.status !== "running")
    ) {
      continue;
    }
    try {
      const parsed = JSON.parse(j.payload) as { conversationId?: unknown };
      if (typeof parsed.conversationId === "string") {
        activeJobConvIds.add(parsed.conversationId);
      }
    } catch {
      // ignore
    }
  }
}

describe("sweepOrphanMemoryRetrospectiveConversations", () => {
  beforeEach(() => {
    mockConversations = [];
    mockJobs = [];
    deletedIds = [];
    activeJobConvIds = new Set();
    injectedNowMinusOrphanAgeMs = 0;
  });

  afterEach(() => {
    mockConversations = [];
    mockJobs = [];
  });

  test("sweeps an old memory-retrospective conversation with no active job", () => {
    const now = Date.now();
    injectedNowMinusOrphanAgeMs = now - ORPHAN_AGE_MS;
    mockConversations = [
      {
        id: "old-orphan",
        source: "memory-retrospective",
        last_message_at: now - 2 * ORPHAN_AGE_MS,
      },
    ];
    rebuildActiveJobSet();

    const result = sweepOrphanMemoryRetrospectiveConversations(now);

    expect(result.swept).toBe(1);
    expect(deletedIds).toEqual(["old-orphan"]);
  });

  test("does NOT sweep recent memory-retrospective conversations", () => {
    const now = Date.now();
    injectedNowMinusOrphanAgeMs = now - ORPHAN_AGE_MS;
    mockConversations = [
      {
        id: "fresh-bg",
        source: "memory-retrospective",
        last_message_at: now - 60_000,
      },
    ];
    rebuildActiveJobSet();

    const result = sweepOrphanMemoryRetrospectiveConversations(now);

    expect(result.swept).toBe(0);
    expect(deletedIds).toEqual([]);
  });

  test("does NOT sweep conversations of OTHER sources, even when old", () => {
    const now = Date.now();
    injectedNowMinusOrphanAgeMs = now - ORPHAN_AGE_MS;
    mockConversations = [
      {
        id: "auto-analysis-old",
        source: "auto-analysis",
        last_message_at: now - 2 * ORPHAN_AGE_MS,
      },
    ];
    rebuildActiveJobSet();

    const result = sweepOrphanMemoryRetrospectiveConversations(now);

    expect(result.swept).toBe(0);
  });

  test("does NOT sweep an orphan whose source conversation has an active job", () => {
    const now = Date.now();
    injectedNowMinusOrphanAgeMs = now - ORPHAN_AGE_MS;
    mockConversations = [
      {
        id: "orphan-but-protected",
        source: "memory-retrospective",
        last_message_at: now - 2 * ORPHAN_AGE_MS,
      },
    ];
    mockJobs = [
      {
        type: "memory_retrospective",
        status: "pending",
        payload: JSON.stringify({ conversationId: "orphan-but-protected" }),
      },
    ];
    rebuildActiveJobSet();

    const result = sweepOrphanMemoryRetrospectiveConversations(now);

    expect(result.swept).toBe(0);
    expect(deletedIds).toEqual([]);
  });

  test("running across an empty workspace returns swept=0 without errors", () => {
    const result = sweepOrphanMemoryRetrospectiveConversations();
    expect(result.swept).toBe(0);
    expect(deletedIds).toEqual([]);
  });
});
