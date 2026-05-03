import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  loadConfig: () => ({}),
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
}));

import { eq } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  claimMemoryJobs,
  enqueueMemoryJob,
  type MemoryJobType,
} from "../memory/jobs-store.js";
import {
  _resetQdrantBreaker,
  withQdrantBreaker,
} from "../memory/qdrant-circuit-breaker.js";
import { memoryJobs } from "../memory/schema.js";

describe("claimMemoryJobs with Qdrant circuit breaker", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM memory_jobs");
    _resetQdrantBreaker();
  });

  test("claims embed jobs when circuit breaker is closed (healthy)", () => {
    enqueueMemoryJob("embed_segment", { segmentId: "seg-1" });
    enqueueMemoryJob("embed_graph_node", { nodeId: "node-1" });
    enqueueMemoryJob("graph_extract", { conversationId: "conv-1" });

    const claimed = claimMemoryJobs(10);
    const types = claimed.map((j) => j.type);

    expect(types).toContain("embed_segment");
    expect(types).toContain("embed_graph_node");
    expect(types).toContain("graph_extract");
    expect(claimed).toHaveLength(3);
  });

  test("skips embed jobs when circuit breaker is open", async () => {
    // Trip the circuit breaker by recording 5 consecutive failures
    for (let i = 0; i < 5; i++) {
      try {
        await withQdrantBreaker(async () => {
          throw new Error("simulated qdrant failure");
        });
      } catch {
        // expected
      }
    }

    enqueueMemoryJob("embed_segment", { segmentId: "seg-1" });
    enqueueMemoryJob("embed_graph_node", { nodeId: "node-1" });
    enqueueMemoryJob("embed_summary", { summaryId: "sum-1" });
    enqueueMemoryJob("graph_extract", { conversationId: "conv-1" });
    enqueueMemoryJob("build_conversation_summary", {
      conversationId: "conv-1",
    });

    const claimed = claimMemoryJobs(10);
    const types = claimed.map((j) => j.type);

    // Only non-embed jobs should be claimed
    expect(types).toContain("graph_extract");
    expect(types).toContain("build_conversation_summary");
    expect(types).not.toContain("embed_segment");
    expect(types).not.toContain("embed_graph_node");
    expect(types).not.toContain("embed_summary");
    expect(claimed).toHaveLength(2);
  });

  test("resumes claiming embed jobs after circuit breaker closes", async () => {
    // Trip the circuit breaker
    for (let i = 0; i < 5; i++) {
      try {
        await withQdrantBreaker(async () => {
          throw new Error("simulated qdrant failure");
        });
      } catch {
        // expected
      }
    }

    // Verify embed jobs are skipped while open
    enqueueMemoryJob("embed_segment", { segmentId: "seg-1" });
    enqueueMemoryJob("graph_extract", { conversationId: "conv-1" });

    const claimedWhileOpen = claimMemoryJobs(10);
    expect(claimedWhileOpen.map((j) => j.type)).not.toContain("embed_segment");

    // Reset breaker (simulates successful probe closing the circuit)
    _resetQdrantBreaker();

    // Re-enqueue an embed job (the previous one is now "running")
    enqueueMemoryJob("embed_graph_node", { nodeId: "node-2" });

    const claimedAfterClose = claimMemoryJobs(10);
    const types = claimedAfterClose.map((j) => j.type);

    expect(types).toContain("embed_graph_node");
  });

  test("lane budgets are honored when called with explicit budgets", () => {
    // 5 slow-lane jobs
    for (let i = 0; i < 5; i++) {
      enqueueMemoryJob("graph_extract", { conversationId: `slow-${i}` });
    }
    // 5 fast-lane jobs (rebuild_index is neither slow-LLM nor embed)
    for (let i = 0; i < 5; i++) {
      enqueueMemoryJob("rebuild_index", { id: `fast-${i}` });
    }
    // 5 embed-lane jobs
    for (let i = 0; i < 5; i++) {
      enqueueMemoryJob("embed_segment", { segmentId: `embed-${i}` });
    }

    const claimed = claimMemoryJobs({ slowLlm: 1, fast: 2, embed: 2 });
    const slowClaimed = claimed.filter((j) => j.type === "graph_extract");
    const fastClaimed = claimed.filter((j) => j.type === "rebuild_index");
    const embedClaimed = claimed.filter((j) => j.type === "embed_segment");

    expect(claimed).toHaveLength(5);
    expect(slowClaimed).toHaveLength(1);
    expect(fastClaimed).toHaveLength(2);
    expect(embedClaimed).toHaveLength(2);

    // Remaining 10 jobs should still be pending.
    const db = getDb();
    const pendingRows = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.status, "pending"))
      .all();
    expect(pendingRows).toHaveLength(10);
  });

  test("Qdrant breaker gates only the embed lane in lane-aware mode", async () => {
    // 5 slow + 5 fast + 5 embed pending jobs
    for (let i = 0; i < 5; i++) {
      enqueueMemoryJob("graph_extract", { conversationId: `slow-${i}` });
    }
    for (let i = 0; i < 5; i++) {
      enqueueMemoryJob("rebuild_index", { id: `fast-${i}` });
    }
    for (let i = 0; i < 5; i++) {
      enqueueMemoryJob("embed_segment", { segmentId: `embed-${i}` });
    }

    // Trip the breaker
    for (let i = 0; i < 5; i++) {
      try {
        await withQdrantBreaker(async () => {
          throw new Error("simulated qdrant failure");
        });
      } catch {
        // expected
      }
    }

    const claimed = claimMemoryJobs({ slowLlm: 1, fast: 2, embed: 2 });
    const slowClaimed = claimed.filter((j) => j.type === "graph_extract");
    const fastClaimed = claimed.filter((j) => j.type === "rebuild_index");
    const embedClaimed = claimed.filter((j) => j.type === "embed_segment");

    expect(slowClaimed).toHaveLength(1);
    expect(fastClaimed).toHaveLength(2);
    // Breaker is open and probe window has not elapsed → no embed jobs claimed.
    expect(embedClaimed).toHaveLength(0);
  });

  test("FIFO order within a lane is preserved by runAfter ascending", () => {
    const t0 = Date.now() - 30_000;
    enqueueMemoryJob("graph_extract", { conversationId: "third" }, t0 + 200);
    enqueueMemoryJob("graph_extract", { conversationId: "first" }, t0);
    enqueueMemoryJob("graph_extract", { conversationId: "second" }, t0 + 100);

    const claimed = claimMemoryJobs({ slowLlm: 3, fast: 0, embed: 0 });
    const order = claimed.map((j) => j.payload.conversationId);
    expect(order).toEqual(["first", "second", "third"]);
  });

  test("all embed job types are skipped when breaker is open", async () => {
    const embedTypes: MemoryJobType[] = [
      "embed_segment",
      "embed_summary",
      "embed_media",
      "embed_attachment",
      "embed_graph_node",
      "graph_trigger_embed",
    ];

    // Trip the circuit breaker
    for (let i = 0; i < 5; i++) {
      try {
        await withQdrantBreaker(async () => {
          throw new Error("simulated qdrant failure");
        });
      } catch {
        // expected
      }
    }

    // Enqueue one of each embed type
    for (const type of embedTypes) {
      enqueueMemoryJob(type, { id: `test-${type}` });
    }
    // Also enqueue a non-embed job
    enqueueMemoryJob("graph_consolidate", { conversationId: "conv-1" });

    const claimed = claimMemoryJobs(20);
    const types = claimed.map((j) => j.type);

    // Only the non-embed job should be claimed
    expect(claimed).toHaveLength(1);
    expect(types).toEqual(["graph_consolidate"]);
  });
});
