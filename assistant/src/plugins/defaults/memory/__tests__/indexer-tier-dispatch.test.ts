/**
 * Index-time trigger dispatch in `indexMessageNow`, one case per tier.
 *
 * The dispatch is three-way — memory off, v1 live, concept-page substrate —
 * and the two config reads it straddles are separate: callers pass a memory
 * slice they already hold while the dispatch re-loads the workspace config for
 * the tier decision. A long-running caller (the v1 `backfill` job hands its
 * `AssistantConfig` snapshot to every message in a 200-row batch) can therefore
 * still be indexing under an `enabled: true` slice after the user switched
 * Memory off, which is the memory-off case exercised here: the dispatch must
 * read the live config's tier, not treat "no concept-page consumer" as v1.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../../persistence/embeddings/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
    hybridSearch: async () => [],
    upsertPoints: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

import { setConfig } from "../../../../__tests__/helpers/set-config.js";
import { getConfig } from "../../../../config/loader.js";
import type { MemoryConfig } from "../../../../config/types.js";
import { getMemoryCheckpoint } from "../../../../persistence/checkpoints.js";
import { getMemorySqlite } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { indexMessageNow } from "../indexer.js";

await initializeDb();

/**
 * Short enough to fall under `MIN_SEGMENT_CHARS`, so no segment rows and no
 * embed jobs are written and the only enqueues left are the tier triggers.
 */
const MESSAGE_TEXT = "a short user message";

let conversationSeq = 0;

/** A fresh conversation id per case, so checkpoints never carry across. */
function nextConversationId(): string {
  conversationSeq += 1;
  return `conv-tier-dispatch-${conversationSeq}`;
}

function seedMemory(memory: Record<string, unknown>): MemoryConfig {
  setConfig("memory", memory);
  return getConfig().memory;
}

async function indexOneMessage(
  conversationId: string,
  slice: MemoryConfig,
): Promise<void> {
  await indexMessageNow(
    {
      messageId: `${conversationId}:m1`,
      conversationId,
      role: "user",
      content: MESSAGE_TEXT,
      createdAt: Date.now(),
    },
    slice,
  );
}

function enqueuedJobTypes(): string[] {
  const rows = getMemorySqlite()!
    .query("SELECT DISTINCT type FROM memory_jobs")
    .all() as { type: string }[];
  return rows.map((row) => row.type);
}

/** The v1 arm's per-conversation `graph_extract` debounce counter. */
function graphExtractPendingCount(conversationId: string): string | null {
  return getMemoryCheckpoint(`graph_extract:${conversationId}:pending_count`);
}

describe("indexMessageNow tier dispatch", () => {
  beforeEach(() => {
    getMemorySqlite()!.run("DELETE FROM memory_jobs");
  });

  test("memory off enqueues no tier triggers", async () => {
    const conversationId = nextConversationId();
    // The slice a caller captured while memory was still on.
    const staleSlice = seedMemory({ enabled: true, v2: { enabled: false } });
    seedMemory({ enabled: false, v2: { enabled: false } });

    await indexOneMessage(conversationId, staleSlice);

    expect(enqueuedJobTypes()).not.toContain("build_conversation_summary");
    expect(enqueuedJobTypes()).not.toContain("graph_extract");
    expect(enqueuedJobTypes()).not.toContain("memory_v2_sweep");
    // Not even the debounce counter: a switch back to v1 must not inherit a
    // batch's worth of counts accumulated while memory was off.
    expect(graphExtractPendingCount(conversationId)).toBeNull();
  });

  test("v1 live enqueues the v1 extraction and summary triggers", async () => {
    const conversationId = nextConversationId();
    const slice = seedMemory({ enabled: true, v2: { enabled: false } });

    await indexOneMessage(conversationId, slice);

    expect(enqueuedJobTypes()).toContain("build_conversation_summary");
    expect(graphExtractPendingCount(conversationId)).toBe("1");
  });

  test("a concept-page consumer enqueues the substrate sweep trigger", async () => {
    const conversationId = nextConversationId();
    const slice = seedMemory({
      enabled: true,
      v2: { enabled: true },
      substrate: { sweep_enabled: true },
    });

    await indexOneMessage(conversationId, slice);

    expect(enqueuedJobTypes()).toContain("memory_v2_sweep");
    expect(enqueuedJobTypes()).not.toContain("build_conversation_summary");
    expect(graphExtractPendingCount(conversationId)).toBeNull();
  });
});
