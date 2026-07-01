/**
 * Read-path cutover tests for {@link searchConversations} under the
 * `messages-search-backend` = `qdrant` feature flag.
 *
 * These assert that with the flag forced to `qdrant`, message-content
 * candidates are sourced from the Qdrant lexical index (mocked here) instead of
 * `messages_fts`, while the visibility/archived SQL filtering, the title `LIKE`
 * merge, and the result shape stay identical to the FTS path. A Qdrant lookup
 * failure degrades to the `messages.content LIKE` scan, and the default `fts5`
 * backend is verified to still ignore the lexical index entirely.
 *
 * The lexical index is mocked at the `conversation-search-lexical` seam so no
 * real Qdrant is required; a real SQLite DB backs the visibility/archived SQL.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { MessageLexicalSearchResult } from "../embeddings/messages-lexical-index.js";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// The lexical candidate source is the single seam this cutover swaps in. Mock
// it directly (returning caller-controlled candidate ids/scores) and, per test,
// override it to throw to exercise the Qdrant-error degrade path. Spreading the
// real module keeps its other exports intact for any test sharing the process.
const searchMessageIdsLexicalMock = mock(
  async (
    _query: string,
    _limit: number,
    _opts?: { conversationId?: string },
  ): Promise<MessageLexicalSearchResult[]> => [],
);
const actualLexical = await import("../conversation-search-lexical.js");
mock.module("../conversation-search-lexical.js", () => ({
  ...actualLexical,
  searchMessageIdsLexical: searchMessageIdsLexicalMock,
}));

// `searchConversations` falls back to the fts5 path when memory is disabled
// (the lexical index is only written while memory is enabled). Control
// `isMemoryEnabled` so the qdrant tests below run with it `true`, and one test
// flips it `false` to assert the fallback. Spread the real module to preserve
// its other exports (many modules import from `jobs-store`).
let memoryEnabled = true;
const actualJobsStore = await import("../jobs-store.js");
mock.module("../jobs-store.js", () => ({
  ...actualJobsStore,
  isMemoryEnabled: () => memoryEnabled,
}));

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import {
  deleteMemoryCheckpoint,
  LEXICAL_BACKFILL_COMPLETE_KEY,
  setMemoryCheckpoint,
} from "../checkpoints.js";
import { createConversation } from "../conversation-crud.js";
import { searchConversations } from "../conversation-queries.js";
import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import { rawRun } from "../raw-query.js";

await initializeDb();

/**
 * Mark the messages lexical-index backfill complete. The qdrant read path is
 * gated on this: an upgraded instance whose backfill has not finished stays on
 * fts5 so it never reads from a partially-populated `messages_lexical`. The
 * qdrant-path tests below index candidates as if the backfill has drained, so
 * they set this marker; the gate itself is covered by its own test.
 */
function markBackfillComplete(): void {
  setMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY, "1");
}

function resetTables(): void {
  const db = getDb();
  db.run(`DELETE FROM messages`);
  db.run(`DELETE FROM conversations`);
}

/**
 * Insert a message row directly. `id` is caller-supplied so tests can wire the
 * exact ids the mocked lexical index returns as candidates.
 */
function insertMessage(
  id: string,
  conversationId: string,
  content: string,
  createdAt = 1000,
): void {
  rawRun(
    "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    id,
    conversationId,
    "user",
    content,
    createdAt,
  );
}

function setConversationType(conversationId: string, type: string): void {
  rawRun(
    "UPDATE conversations SET conversation_type = ? WHERE id = ?",
    type,
    conversationId,
  );
}

function archive(conversationId: string): void {
  rawRun(
    "UPDATE conversations SET archived_at = ? WHERE id = ?",
    Date.now(),
    conversationId,
  );
}

/** Make the mocked lexical index return exactly these ids as candidates. */
function lexicalReturns(ids: string[]): void {
  searchMessageIdsLexicalMock.mockImplementation(async () =>
    ids.map((messageId, i) => ({ messageId, score: 1 - i * 0.01 })),
  );
}

afterAll(() => {
  mock.restore();
});

describe("searchConversations · qdrant backend", () => {
  beforeEach(() => {
    resetTables();
    memoryEnabled = true;
    // These tests exercise the populated-index (post-backfill) qdrant path.
    markBackfillComplete();
    searchMessageIdsLexicalMock.mockClear();
    searchMessageIdsLexicalMock.mockImplementation(async () => []);
    setOverridesForTesting({ "messages-search-backend": "qdrant" });
  });

  afterAll(() => {
    setOverridesForTesting({});
  });

  test("sources candidates from the lexical index, not messages_fts", async () => {
    const conv = createConversation("Notes");
    insertMessage("m-1", conv.id, "the flux capacitor needs recalibration");
    // A message that FTS would match but the lexical index does NOT return:
    // if the query still finds it, candidates are coming from FTS not Qdrant.
    insertMessage("m-2", conv.id, "flux capacitor decoy", 2000);

    lexicalReturns(["m-1"]);

    const results = await searchConversations("flux capacitor");

    expect(searchMessageIdsLexicalMock).toHaveBeenCalledTimes(1);
    // The query text is passed through; the limit is the wide candidate
    // over-fetch (asserted precisely in its own test below).
    expect(searchMessageIdsLexicalMock.mock.calls[0]![0]).toBe(
      "flux capacitor",
    );

    expect(results.map((r) => r.conversationId)).toEqual([conv.id]);
    // Only the candidate the lexical index returned is surfaced as a match.
    expect(results[0]!.matchingMessages.map((m) => m.messageId)).toEqual([
      "m-1",
    ]);
  });

  test("does not issue a second lexical round-trip for per-conversation messages", async () => {
    const convA = createConversation("A");
    const convB = createConversation("B");
    insertMessage("a-1", convA.id, "shared token alpha", 1000);
    insertMessage("b-1", convB.id, "shared token beta", 1000);

    lexicalReturns(["a-1", "b-1"]);

    const results = await searchConversations("shared token");

    // Exactly one lexical call total — the per-conversation message rows are
    // selected from the already-fetched candidate set, not a fresh query.
    expect(searchMessageIdsLexicalMock).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.conversationId).sort()).toEqual(
      [convA.id, convB.id].sort(),
    );
    for (const r of results) {
      expect(r.matchingMessages).toHaveLength(1);
    }
  });

  test("over-fetches a wide message-candidate pool (cap on distinct conversations, not messages)", async () => {
    const conv = createConversation("Notes");
    insertMessage("m-1", conv.id, "flux capacitor");
    lexicalReturns(["m-1"]);

    await searchConversations("flux capacitor");

    // The candidate limit must be far larger than the caller's result `limit`
    // (default 20) so the effective cap lands on distinct visible
    // conversations after dedup, not raw messages. A single chatty
    // conversation must not be able to consume the whole candidate budget.
    const requestedLimit = searchMessageIdsLexicalMock.mock.calls[0]![1];
    expect(requestedLimit).toBeGreaterThanOrEqual(5000);
  });

  test("a chatty conversation does not starve other distinct visible conversations", async () => {
    // `chatty` has many matching messages; `other` has a single one. If the
    // cap were on messages (and chatty's messages ranked first), `other` could
    // be crowded out. The distinct-conversation cap must surface both.
    const chatty = createConversation("Chatty");
    const other = createConversation("Other");

    const chattyIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = `chatty-${i}`;
      insertMessage(id, chatty.id, `flux capacitor mention ${i}`, 1000 + i);
      chattyIds.push(id);
    }
    insertMessage("other-1", other.id, "flux capacitor once", 999);

    // Rank ALL of chatty's messages ahead of other's single message — the
    // worst case for a message-level cap.
    lexicalReturns([...chattyIds, "other-1"]);

    const results = await searchConversations("flux capacitor");

    expect(searchMessageIdsLexicalMock).toHaveBeenCalledTimes(1);
    // Both distinct visible conversations surface despite chatty dominating
    // the candidate ranking.
    expect(results.map((r) => r.conversationId).sort()).toEqual(
      [chatty.id, other.id].sort(),
    );
    // Per-conversation message rows are still capped (default 3) and sourced
    // from the single round-trip.
    const chattyResult = results.find((r) => r.conversationId === chatty.id)!;
    expect(chattyResult.matchingMessages.length).toBeLessThanOrEqual(3);
    const otherResult = results.find((r) => r.conversationId === other.id)!;
    expect(otherResult.matchingMessages.map((m) => m.messageId)).toEqual([
      "other-1",
    ]);
  });

  test("applies the same visibility filtering (excludes non-surfaced background)", async () => {
    const background = createConversation({
      title: "bg-run",
      conversationType: "background",
    });
    insertMessage("bg-1", background.id, "flux capacitor in the background");

    lexicalReturns(["bg-1"]);

    // Candidate exists in the index, but the conversation is a non-surfaced
    // background row — the visibility SQL must filter it out.
    expect(await searchConversations("flux capacitor")).toEqual([]);
  });

  test("applies the same archived filtering (excludes archived conversations)", async () => {
    const conv = createConversation("Archived notes");
    insertMessage("arch-1", conv.id, "flux capacitor archived");
    archive(conv.id);

    lexicalReturns(["arch-1"]);

    expect(await searchConversations("flux capacitor")).toEqual([]);
  });

  test("excludes private conversations even when the index returns their messages", async () => {
    const priv = createConversation("Private notes");
    setConversationType(priv.id, "private");
    insertMessage("p-1", priv.id, "flux capacitor secret");

    lexicalReturns(["p-1"]);

    expect(await searchConversations("flux capacitor")).toEqual([]);
  });

  test("title-only matches still work without any lexical candidates", async () => {
    const conv = createConversation("Quarterly metrics rollup");

    // Index returns nothing for the content query; the title LIKE arm still
    // finds the conversation.
    lexicalReturns([]);

    const results = await searchConversations("Quarterly metrics");

    expect(results.map((r) => r.conversationId)).toEqual([conv.id]);
    // No content candidates → no matching messages, just the title hit.
    expect(results[0]!.matchingMessages).toEqual([]);
  });

  test("degrades to a LIKE content scan when the lexical lookup throws", async () => {
    const conv = createConversation("Degrade notes");
    insertMessage("d-1", conv.id, "flux capacitor via like fallback");

    searchMessageIdsLexicalMock.mockImplementation(async () => {
      throw new Error("qdrant unreachable");
    });

    const results = await searchConversations("flux capacitor");

    expect(searchMessageIdsLexicalMock).toHaveBeenCalledTimes(1);
    // Even though Qdrant failed, the LIKE scan over messages.content recovers
    // the match — the conversation and its message are still returned.
    expect(results.map((r) => r.conversationId)).toEqual([conv.id]);
    expect(results[0]!.matchingMessages.map((m) => m.messageId)).toEqual([
      "d-1",
    ]);
  });

  test("uses the fts5 path (not qdrant) when memory is disabled, even with the flag on", async () => {
    // The lexical index is only written while memory is enabled, so with memory
    // off it is empty and a qdrant lookup would silently return no content
    // matches. `searchConversations` must fall back to the always-populated
    // fts5 path and never query the (empty) lexical index.
    memoryEnabled = false;
    const conv = createConversation("Notes");
    insertMessage("m-1", conv.id, "the flux capacitor needs recalibration");
    // Even if the index somehow returned a candidate, it must not be consulted.
    lexicalReturns(["m-1"]);

    const results = await searchConversations("flux capacitor");

    expect(searchMessageIdsLexicalMock).not.toHaveBeenCalled();
    // The fts5 content match still finds the conversation and its message.
    expect(results.map((r) => r.conversationId)).toEqual([conv.id]);
    expect(results[0]!.matchingMessages.map((m) => m.messageId)).toEqual([
      "m-1",
    ]);
  });

  test("uses the fts5 path (not qdrant) until the backfill completion checkpoint is set", async () => {
    // On an upgraded instance the historical messages are indexed by a
    // background backfill. Until it drains, the lexical collection is only
    // partially populated, so a qdrant read would silently miss older content.
    // With the flag on but the completion checkpoint UNSET, the read must stay
    // on the always-populated fts5 path and never query the lexical index.
    deleteMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY);
    const conv = createConversation("Notes");
    insertMessage("m-1", conv.id, "the flux capacitor needs recalibration");
    lexicalReturns(["m-1"]);

    const results = await searchConversations("flux capacitor");

    expect(searchMessageIdsLexicalMock).not.toHaveBeenCalled();
    // The fts5 content match still finds the conversation and its message.
    expect(results.map((r) => r.conversationId)).toEqual([conv.id]);
    expect(results[0]!.matchingMessages.map((m) => m.messageId)).toEqual([
      "m-1",
    ]);
  });

  test("non-tokenizable queries use the LIKE fallback without hitting the index", async () => {
    // Single-char / non-ASCII queries produce no tokens, so neither FTS nor the
    // sparse encoder yields terms — both backends use the LIKE content scan.
    const conv = createConversation("Symbols");
    insertMessage("s-1", conv.id, "review the C§ draft");

    const results = await searchConversations("C§");

    expect(searchMessageIdsLexicalMock).not.toHaveBeenCalled();
    expect(results.map((r) => r.conversationId)).toEqual([conv.id]);
  });

  test("returns [] when the index yields no candidates and nothing matches by title", async () => {
    const conv = createConversation("Unrelated");
    insertMessage("u-1", conv.id, "totally different content");

    lexicalReturns([]);

    expect(await searchConversations("flux capacitor")).toEqual([]);
  });
});

describe("searchConversations · fts5 backend ignores the lexical index", () => {
  beforeEach(() => {
    resetTables();
    // Backfill completion is irrelevant on the fts5 backend, but clear it so
    // this suite does not depend on the qdrant suite's marker leaking across.
    deleteMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY);
    searchMessageIdsLexicalMock.mockClear();
    lexicalReturns(["should-not-be-used"]);
    // Force fts5 explicitly: the registry default is qdrant, so an unset flag
    // would resolve to qdrant. An explicit `false` override pins the fts5 path.
    setOverridesForTesting({ "messages-search-backend": false });
  });

  afterAll(() => {
    setOverridesForTesting({});
  });

  test("content search uses messages_fts and never calls the lexical index", async () => {
    const conv = createConversation("Notes");
    insertMessage("m-1", conv.id, "the flux capacitor needs recalibration");

    const results = await searchConversations("flux capacitor");

    // The lexical index must not be consulted on the fts5 path.
    expect(searchMessageIdsLexicalMock).not.toHaveBeenCalled();
    expect(results.map((r) => r.conversationId)).toEqual([conv.id]);
    expect(results[0]!.matchingMessages).toHaveLength(1);
  });
});
