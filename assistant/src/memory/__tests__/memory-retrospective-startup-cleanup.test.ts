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
  fork_parent_conversation_id: string | null;
  created_at: number;
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
            // The "all retros" query (used to compute most-recent-per-source
            // preservation) requests id + forkParentConversationId + createdAt
            // with only the source + isNotNull(forkParent) predicate.
            if (
              colKeys.includes("forkParentConversationId") &&
              colKeys.includes("createdAt")
            ) {
              return mockConversations
                .filter((c) => c.source === "memory-retrospective")
                .filter((c) => c.fork_parent_conversation_id !== null)
                .map((c) => ({
                  id: c.id,
                  forkParentConversationId: c.fork_parent_conversation_id,
                  createdAt: c.created_at,
                }));
            }
            // Otherwise, this is the orphan-candidate query. The production
            // predicate compares `forkParentConversationId` (the source ID
            // encoded on the background conversation row) against the set
            // of source IDs extracted from active jobs.
            return mockConversations
              .filter((c) => c.source === "memory-retrospective")
              .filter(
                (c) =>
                  c.last_message_at !== null &&
                  c.last_message_at < injectedNowMinusOrphanAgeMs,
              )
              .filter(
                (c) =>
                  c.fork_parent_conversation_id === null ||
                  !activeJobSourceConvIds.has(c.fork_parent_conversation_id),
              )
              .map((c) => ({ id: c.id }));
          },
        }),
      }),
    }),
  }),
}));

let activeJobSourceConvIds = new Set<string>();
let injectedNowMinusOrphanAgeMs = 0;

mock.module("../conversation-crud.js", () => ({
  deleteConversation: (id: string) => {
    deletedIds.push(id);
    mockConversations = mockConversations.filter((c) => c.id !== id);
  },
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

import { sweepOrphanMemoryRetrospectiveConversations } from "../memory-retrospective-startup-cleanup.js";

const ORPHAN_AGE_MS = 60 * 60 * 1000;

function rebuildActiveJobSet(): void {
  activeJobSourceConvIds = new Set();
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
        activeJobSourceConvIds.add(parsed.conversationId);
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
    activeJobSourceConvIds = new Set();
    injectedNowMinusOrphanAgeMs = 0;
  });

  afterEach(() => {
    mockConversations = [];
    mockJobs = [];
  });

  test("sweeps an old memory-retrospective orphan that has been superseded by a newer retro for the same source", () => {
    const now = Date.now();
    injectedNowMinusOrphanAgeMs = now - ORPHAN_AGE_MS;
    mockConversations = [
      {
        id: "old-orphan",
        source: "memory-retrospective",
        last_message_at: now - 2 * ORPHAN_AGE_MS,
        fork_parent_conversation_id: "source-A",
        created_at: now - 3 * ORPHAN_AGE_MS,
      },
      // Newer successful retro for the same source — this one is preserved.
      {
        id: "newer-retro",
        source: "memory-retrospective",
        last_message_at: now - 90 * 60 * 1000,
        fork_parent_conversation_id: "source-A",
        created_at: now - 2 * ORPHAN_AGE_MS,
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
        fork_parent_conversation_id: "source-A",
        created_at: now - 60_000,
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
        fork_parent_conversation_id: "source-A",
        created_at: now - 2 * ORPHAN_AGE_MS,
      },
    ];
    rebuildActiveJobSet();

    const result = sweepOrphanMemoryRetrospectiveConversations(now);

    expect(result.swept).toBe(0);
  });

  // Regression test for the previously-broken active-job guard. Before the
  // fix, the predicate compared `conversations.id` (the BACKGROUND-conv id)
  // to source-conv ids extracted from job payloads — two different identifier
  // spaces — so the guard never matched and in-flight retros were swept.
  test("does NOT sweep a background conversation whose SOURCE has an active job (different identifier spaces)", () => {
    const now = Date.now();
    injectedNowMinusOrphanAgeMs = now - ORPHAN_AGE_MS;
    // The background conv has its own id, distinct from the source it forks
    // from. The active job's payload references the SOURCE, not the
    // background.
    mockConversations = [
      {
        id: "background-conv-id",
        source: "memory-retrospective",
        last_message_at: now - 2 * ORPHAN_AGE_MS,
        fork_parent_conversation_id: "source-conv-id",
        created_at: now - 2 * ORPHAN_AGE_MS,
      },
    ];
    mockJobs = [
      {
        type: "memory_retrospective",
        status: "pending",
        payload: JSON.stringify({ conversationId: "source-conv-id" }),
      },
    ];
    rebuildActiveJobSet();

    const result = sweepOrphanMemoryRetrospectiveConversations(now);

    expect(result.swept).toBe(0);
    expect(deletedIds).toEqual([]);
  });

  test("sweeps a superseded background conversation whose source has NO active job, even when another unrelated job is pending", () => {
    const now = Date.now();
    injectedNowMinusOrphanAgeMs = now - ORPHAN_AGE_MS;
    mockConversations = [
      {
        id: "background-A",
        source: "memory-retrospective",
        last_message_at: now - 2 * ORPHAN_AGE_MS,
        fork_parent_conversation_id: "source-A",
        created_at: now - 3 * ORPHAN_AGE_MS,
      },
      {
        id: "newer-A",
        source: "memory-retrospective",
        last_message_at: now - 90 * 60 * 1000,
        fork_parent_conversation_id: "source-A",
        created_at: now - 2 * ORPHAN_AGE_MS,
      },
    ];
    // Active job references a DIFFERENT source — neither retro above is
    // protected by the active-job guard.
    mockJobs = [
      {
        type: "memory_retrospective",
        status: "pending",
        payload: JSON.stringify({ conversationId: "source-B" }),
      },
    ];
    rebuildActiveJobSet();

    const result = sweepOrphanMemoryRetrospectiveConversations(now);

    expect(result.swept).toBe(1);
    expect(deletedIds).toEqual(["background-A"]);
  });

  // Regression test for Devin's concern on PR #30331: the sweep used to
  // delete every memory-retrospective conversation older than 1h, including
  // the most-recent successful one per source. That broke
  // `findMostRecentRetrospectiveFor` on the next run — the next retro had
  // no dedup context and could re-save facts the prior pass already captured.
  test("PRESERVES the most-recent retro per source even when older than the orphan cutoff", () => {
    const now = Date.now();
    injectedNowMinusOrphanAgeMs = now - ORPHAN_AGE_MS;
    mockConversations = [
      {
        id: "successful-retro",
        source: "memory-retrospective",
        last_message_at: now - 2 * ORPHAN_AGE_MS,
        fork_parent_conversation_id: "source-A",
        created_at: now - 2 * ORPHAN_AGE_MS,
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
