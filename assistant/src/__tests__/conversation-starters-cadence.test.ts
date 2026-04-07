import { beforeEach, describe, expect, mock, test } from "bun:test";

import { v4 as uuid } from "uuid";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { maybeEnqueueConversationStartersJob } from "../memory/conversation-starters-cadence.js";
import { getSqlite, initializeDb } from "../memory/db.js";

initializeDb();

function clearTables() {
  getSqlite().run("DELETE FROM memory_graph_nodes");
  getSqlite().run("DELETE FROM memory_jobs");
  getSqlite().run("DELETE FROM memory_checkpoints");
}

function insertMemoryNode(scopeId = "default") {
  const now = Date.now();
  getSqlite().run(
    `INSERT INTO memory_graph_nodes (
      id, content, type, created, last_accessed, last_consolidated,
      emotional_charge, fidelity, confidence, significance,
      stability, reinforcement_count, last_reinforced,
      source_conversations, source_type, scope_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'vivid', 0.8, 0.5, 14, 0, ?, '[]', 'inferred', ?)`,
    [
      uuid(),
      "test statement",
      "semantic",
      now,
      now,
      now,
      '{"valence":0,"intensity":0.1,"decayCurve":"linear","decayRate":0.05,"originalIntensity":0.1}',
      now,
      scopeId,
    ],
  );
}

function setCheckpoint(key: string, value: string) {
  getSqlite().run(
    `INSERT OR REPLACE INTO memory_checkpoints (key, value, updated_at) VALUES (?, ?, ?)`,
    [key, value, Date.now()],
  );
}

function getPendingJobs(): Array<{ type: string }> {
  return getSqlite()
    .prepare(
      `SELECT type FROM memory_jobs WHERE type = 'generate_conversation_starters' AND status = 'pending'`,
    )
    .all() as Array<{ type: string }>;
}

beforeEach(() => {
  clearTables();
});

describe("maybeEnqueueConversationStartersJob", () => {
  test("no-op when zero memory nodes", () => {
    maybeEnqueueConversationStartersJob("default");
    expect(getPendingJobs()).toHaveLength(0);
  });

  test("enqueues when threshold exceeded (<=10 nodes, threshold=1)", () => {
    insertMemoryNode();
    insertMemoryNode();

    maybeEnqueueConversationStartersJob("default");
    expect(getPendingJobs()).toHaveLength(1);
  });

  test("no-op when delta below threshold", () => {
    for (let i = 0; i < 5; i++) insertMemoryNode();

    // Set checkpoint to current count — no new items since last gen
    setCheckpoint("conversation_starters:item_count_at_last_gen:default", "5");

    maybeEnqueueConversationStartersJob("default");
    expect(getPendingJobs()).toHaveLength(0);
  });

  test("uses higher threshold for larger memory counts (>50 nodes, threshold=10)", () => {
    for (let i = 0; i < 55; i++) insertMemoryNode();

    // Set checkpoint so delta is only 4 (below threshold of 10)
    setCheckpoint(
      "conversation_starters:item_count_at_last_gen:default",
      "51",
    );

    maybeEnqueueConversationStartersJob("default");
    expect(getPendingJobs()).toHaveLength(0);

    // Add more to exceed threshold
    for (let i = 0; i < 6; i++) insertMemoryNode();

    maybeEnqueueConversationStartersJob("default");
    expect(getPendingJobs()).toHaveLength(1);
  });

  test("dedup prevents double-enqueue", () => {
    insertMemoryNode();
    insertMemoryNode();

    maybeEnqueueConversationStartersJob("default");
    expect(getPendingJobs()).toHaveLength(1);

    // Call again — should not create a second job
    maybeEnqueueConversationStartersJob("default");
    expect(getPendingJobs()).toHaveLength(1);
  });

  test("enqueues after pruning reduces totalActive below lastCount", () => {
    // Start with 5 nodes and set checkpoint to 5
    for (let i = 0; i < 5; i++) insertMemoryNode();
    setCheckpoint("conversation_starters:item_count_at_last_gen:default", "5");

    // Simulate pruning: mark 3 nodes as gone (reducing totalActive to 2)
    const ids = (
      getSqlite()
        .prepare(`SELECT id FROM memory_graph_nodes LIMIT 3`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
    for (const id of ids) {
      getSqlite().run(
        `UPDATE memory_graph_nodes SET fidelity = 'gone' WHERE id = ?`,
        [id],
      );
    }

    // totalActive=2, lastCount=5 → delta would be -3 without clamp
    // With clamp, delta=0 which is below threshold=1, so no job yet
    maybeEnqueueConversationStartersJob("default");
    expect(getPendingJobs()).toHaveLength(0);

    // Add a new node → totalActive=3, lastCount=5, clamped delta=0, still no job
    insertMemoryNode();
    maybeEnqueueConversationStartersJob("default");
    expect(getPendingJobs()).toHaveLength(0);

    // Add 3 more nodes → totalActive=6, lastCount=5, delta=1 >= threshold=1
    for (let i = 0; i < 3; i++) insertMemoryNode();
    maybeEnqueueConversationStartersJob("default");
    expect(getPendingJobs()).toHaveLength(1);
  });

  test("scopes are independent", () => {
    insertMemoryNode("scope-a");
    insertMemoryNode("scope-b");

    maybeEnqueueConversationStartersJob("scope-a");
    maybeEnqueueConversationStartersJob("scope-b");

    const jobs = getSqlite()
      .prepare(
        `SELECT payload FROM memory_jobs WHERE type = 'generate_conversation_starters' AND status = 'pending'`,
      )
      .all() as Array<{ payload: string }>;

    expect(jobs).toHaveLength(2);
    const payloads = jobs.map((j) => JSON.parse(j.payload).scopeId).sort();
    expect(payloads).toEqual(["scope-a", "scope-b"]);
  });
});
