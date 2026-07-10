import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

mock.module("../../../../util/logger.js", () => ({
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
type MessageRow = {
  role: string;
  createdAt: number;
  metadata: string | null;
};

let mockConversations: ConvRow[] = [];
let mockJobs: JobRow[] = [];
let mockMessages: Record<string, MessageRow[]> = {};
let deletedIds: string[] = [];

const RETRO_SOURCES = ["memory-retrospective", "memory-retrospective-fork"];

function isRetroSource(source: string | null): boolean {
  return source !== null && RETRO_SOURCES.includes(source);
}

const makeFakeDb = () => ({
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
          // The "all retros" query (used to compute the preserved
          // dedup-baseline per source) requests id + source +
          // forkParentConversationId + createdAt with only the source +
          // isNotNull(forkParent) predicate.
          if (
            colKeys.includes("forkParentConversationId") &&
            colKeys.includes("createdAt")
          ) {
            return mockConversations
              .filter((c) => isRetroSource(c.source))
              .filter((c) => c.fork_parent_conversation_id !== null)
              .map((c) => ({
                id: c.id,
                source: c.source,
                forkParentConversationId: c.fork_parent_conversation_id,
                createdAt: c.created_at,
              }));
          }
          // Otherwise, this is the orphan-candidate query. The production
          // predicate compares `forkParentConversationId` (the source ID
          // encoded on the background conversation row) against the set
          // of source IDs extracted from active jobs.
          return mockConversations
            .filter((c) => isRetroSource(c.source))
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
});

mock.module("../../../../persistence/db-connection.js", () => ({
  getDb: makeFakeDb,
  getMemoryDb: makeFakeDb,
}));

let activeJobSourceConvIds = new Set<string>();
let injectedNowMinusOrphanAgeMs = 0;
let mockKeepSupersededRuns = false;

mock.module("../config.js", () => ({
  getMemoryConfig: () => ({
    retrospective: { keepSupersededRuns: mockKeepSupersededRuns },
  }),
}));

// The contract fns the code under test calls are stubbed per-test with spyOn
// (restored in afterEach) rather than mock.module — a module mock here would
// replace the plugin-api registry for every other test file sharing the
// process.
import * as pluginApi from "@vellumai/plugin-api";

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
    mockMessages = {};
    deletedIds = [];
    activeJobSourceConvIds = new Set();
    injectedNowMinusOrphanAgeMs = 0;
    mockKeepSupersededRuns = false;
    spyOn(pluginApi, "deleteConversation").mockImplementation(
      async (id: string) => {
        deletedIds.push(id);
        mockConversations = mockConversations.filter((c) => c.id !== id);
      },
    );
    spyOn(pluginApi, "getMessages").mockImplementation(
      async (conversationId: string) =>
        (mockMessages[conversationId] ?? []) as Awaited<
          ReturnType<typeof pluginApi.getMessages>
        >,
    );
  });

  afterEach(() => {
    mock.restore();
    mockConversations = [];
    mockJobs = [];
    mockMessages = {};
  });

  test("sweeps an old memory-retrospective orphan that has been superseded by a newer retro for the same source", async () => {
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

    const result = await sweepOrphanMemoryRetrospectiveConversations(now);

    expect(result.swept).toBe(1);
    expect(deletedIds).toEqual(["old-orphan"]);
  });

  test("does NOT sweep recent memory-retrospective conversations", async () => {
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

    const result = await sweepOrphanMemoryRetrospectiveConversations(now);

    expect(result.swept).toBe(0);
    expect(deletedIds).toEqual([]);
  });

  test("does NOT sweep conversations of OTHER sources, even when old", async () => {
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

    const result = await sweepOrphanMemoryRetrospectiveConversations(now);

    expect(result.swept).toBe(0);
  });

  // Regression test for the previously-broken active-job guard. Before the
  // fix, the predicate compared `conversations.id` (the BACKGROUND-conv id)
  // to source-conv ids extracted from job payloads — two different identifier
  // spaces — so the guard never matched and in-flight retros were swept.
  test("does NOT sweep a background conversation whose SOURCE has an active job (different identifier spaces)", async () => {
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

    const result = await sweepOrphanMemoryRetrospectiveConversations(now);

    expect(result.swept).toBe(0);
    expect(deletedIds).toEqual([]);
  });

  test("sweeps a superseded background conversation whose source has NO active job, even when another unrelated job is pending", async () => {
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

    const result = await sweepOrphanMemoryRetrospectiveConversations(now);

    expect(result.swept).toBe(1);
    expect(deletedIds).toEqual(["background-A"]);
  });

  // Regression test for Devin's concern on PR #30331: the sweep used to
  // delete every memory-retrospective conversation older than 1h, including
  // the most-recent successful one per source. That broke
  // `findMostRecentRetrospectiveFor` on the next run — the next retro had
  // no dedup context and could re-save facts the prior pass already captured.
  test("PRESERVES the most-recent retro per source even when older than the orphan cutoff", async () => {
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

    const result = await sweepOrphanMemoryRetrospectiveConversations(now);

    expect(result.swept).toBe(0);
    expect(deletedIds).toEqual([]);
  });

  test("running across an empty workspace returns swept=0 without errors", async () => {
    const result = await sweepOrphanMemoryRetrospectiveConversations();
    expect(result.swept).toBe(0);
    expect(deletedIds).toEqual([]);
  });

  test("keepSupersededRuns=true skips the sweep entirely — sweepable orphans are retained", async () => {
    mockKeepSupersededRuns = true;
    const now = Date.now();
    injectedNowMinusOrphanAgeMs = now - ORPHAN_AGE_MS;
    // Same shape as the first test's sweepable orphan — with the flag off
    // this would be swept (older retro superseded by a newer one for the
    // same source).
    mockConversations = [
      {
        id: "old-orphan",
        source: "memory-retrospective",
        last_message_at: now - 2 * ORPHAN_AGE_MS,
        fork_parent_conversation_id: "source-A",
        created_at: now - 3 * ORPHAN_AGE_MS,
      },
      {
        id: "newer-retro",
        source: "memory-retrospective",
        last_message_at: now - 90 * 60 * 1000,
        fork_parent_conversation_id: "source-A",
        created_at: now - 2 * ORPHAN_AGE_MS,
      },
    ];
    rebuildActiveJobSet();

    const result = await sweepOrphanMemoryRetrospectiveConversations(now);

    expect(result.swept).toBe(0);
    expect(deletedIds).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Dedup-baseline selection: prefer rows that actually produced output.
  // -------------------------------------------------------------------------

  /**
   * Build a fork-kind retrospective's message rows: a copied source prefix
   * (stamped with `forkSourceMessageId`, ending in an assistant turn AT the
   * boundary — exercising the strictly-greater check), the post-fork
   * user-role instruction, and optionally the retrospective's own assistant
   * output after the boundary.
   */
  function forkKindMessages(opts: {
    boundaryAt: number;
    withOutput: boolean;
  }): MessageRow[] {
    const rows: MessageRow[] = [
      {
        role: "user",
        createdAt: opts.boundaryAt - 1000,
        metadata: JSON.stringify({ forkSourceMessageId: "src-msg-1" }),
      },
      {
        role: "assistant",
        createdAt: opts.boundaryAt,
        metadata: JSON.stringify({ forkSourceMessageId: "src-msg-2" }),
      },
      {
        role: "user",
        createdAt: opts.boundaryAt + 500,
        metadata: JSON.stringify({ kind: "memory_retrospective_instruction" }),
      },
    ];
    if (opts.withOutput) {
      rows.push({
        role: "assistant",
        createdAt: opts.boundaryAt + 1000,
        metadata: null,
      });
    }
    return rows;
  }

  test("sweeps an orphan MOST-RECENT fork-kind row (no post-fork output) and preserves an older row WITH output as the dedup baseline", async () => {
    const now = Date.now();
    injectedNowMinusOrphanAgeMs = now - ORPHAN_AGE_MS;
    mockConversations = [
      {
        id: "fork-with-output",
        source: "memory-retrospective-fork",
        last_message_at: now - 3 * ORPHAN_AGE_MS,
        fork_parent_conversation_id: "source-A",
        created_at: now - 3 * ORPHAN_AGE_MS,
      },
      // Most recent for source-A, but a crash orphan: its only post-fork
      // message is the instruction — no assistant output after the boundary.
      // The copied prefix DOES contain an assistant turn (at the boundary),
      // which must not count.
      {
        id: "fork-orphan",
        source: "memory-retrospective-fork",
        last_message_at: now - 2 * ORPHAN_AGE_MS,
        fork_parent_conversation_id: "source-A",
        created_at: now - 2 * ORPHAN_AGE_MS,
      },
    ];
    mockMessages = {
      "fork-with-output": forkKindMessages({
        boundaryAt: now - 3 * ORPHAN_AGE_MS,
        withOutput: true,
      }),
      "fork-orphan": forkKindMessages({
        boundaryAt: now - 2 * ORPHAN_AGE_MS,
        withOutput: false,
      }),
    };
    rebuildActiveJobSet();

    const result = await sweepOrphanMemoryRetrospectiveConversations(now);

    expect(result.swept).toBe(1);
    expect(deletedIds).toEqual(["fork-orphan"]);
  });

  test("falls back to preserving the plain most-recent row when EVERY row is an orphan", async () => {
    const now = Date.now();
    injectedNowMinusOrphanAgeMs = now - ORPHAN_AGE_MS;
    mockConversations = [
      {
        id: "older-orphan",
        source: "memory-retrospective-fork",
        last_message_at: now - 3 * ORPHAN_AGE_MS,
        fork_parent_conversation_id: "source-A",
        created_at: now - 3 * ORPHAN_AGE_MS,
      },
      {
        id: "newest-orphan",
        source: "memory-retrospective-fork",
        last_message_at: now - 2 * ORPHAN_AGE_MS,
        fork_parent_conversation_id: "source-A",
        created_at: now - 2 * ORPHAN_AGE_MS,
      },
    ];
    mockMessages = {
      "older-orphan": forkKindMessages({
        boundaryAt: now - 3 * ORPHAN_AGE_MS,
        withOutput: false,
      }),
      "newest-orphan": forkKindMessages({
        boundaryAt: now - 2 * ORPHAN_AGE_MS,
        withOutput: false,
      }),
    };
    rebuildActiveJobSet();

    const result = await sweepOrphanMemoryRetrospectiveConversations(now);

    // Current behavior preserved: the most-recent row survives even though
    // it has no output; the older orphan is swept.
    expect(result.swept).toBe(1);
    expect(deletedIds).toEqual(["older-orphan"]);
  });

  test("legacy-kind selection: ANY assistant message counts as output (no fork boundary required)", async () => {
    const now = Date.now();
    injectedNowMinusOrphanAgeMs = now - ORPHAN_AGE_MS;
    mockConversations = [
      // Older legacy retro that produced output — preserved.
      {
        id: "legacy-with-output",
        source: "memory-retrospective",
        last_message_at: now - 3 * ORPHAN_AGE_MS,
        fork_parent_conversation_id: "source-A",
        created_at: now - 3 * ORPHAN_AGE_MS,
      },
      // Most-recent legacy retro with no assistant message — a wake that
      // never produced output. Swept.
      {
        id: "legacy-orphan",
        source: "memory-retrospective",
        last_message_at: now - 2 * ORPHAN_AGE_MS,
        fork_parent_conversation_id: "source-A",
        created_at: now - 2 * ORPHAN_AGE_MS,
      },
    ];
    mockMessages = {
      "legacy-with-output": [
        // Legacy rows carry no forkSourceMessageId stamps — any assistant
        // message qualifies.
        {
          role: "assistant",
          createdAt: now - 3 * ORPHAN_AGE_MS,
          metadata: null,
        },
      ],
      "legacy-orphan": [],
    };
    rebuildActiveJobSet();

    const result = await sweepOrphanMemoryRetrospectiveConversations(now);

    expect(result.swept).toBe(1);
    expect(deletedIds).toEqual(["legacy-orphan"]);
  });
});
