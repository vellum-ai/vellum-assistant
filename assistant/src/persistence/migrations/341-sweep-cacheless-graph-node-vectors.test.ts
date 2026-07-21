/**
 * Tests for migration 341: enqueuing the deferred sweep of cacheless
 * `graph_node` Qdrant points — points with no `memory_embeddings` cache row that
 * migration 340 cannot discover — plus the sweep function that the memory worker
 * runs once Qdrant is up.
 *
 * The migration runs against real workspace databases (`initializeDb()`) because
 * it enqueues a `sweep_orphaned_graph_node_points` job on the dedicated memory
 * DB. The sweep function is exercised directly with a fake Qdrant client so its
 * scroll → diff → delete logic is covered without a live Qdrant.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { getDb, getMemorySqlite, getSqliteFrom } =
  await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { migrateSweepCachelessGraphNodeVectors } =
  await import("./341-sweep-cacheless-graph-node-vectors.js");
const { sweepOrphanedGraphNodePoints } =
  await import("../embeddings/graph-node-orphan-sweep.js");
const { withQdrantBreaker, QdrantCircuitOpenError, _resetQdrantBreaker } =
  await import("../embeddings/qdrant-circuit-breaker.js");

await initializeDb();

/** Consecutive failures that open the breaker (mirrors its FAILURE_THRESHOLD). */
const BREAKER_FAILURE_THRESHOLD = 5;

const SWEEP_JOB_ID = "migration-341-sweep-cacheless-graph-node-vectors";

function mainRaw() {
  return getSqliteFrom(getDb());
}

/** Insert a memory_graph_nodes row (fidelity `gone` models a soft delete). */
function seedNode(id: string, fidelity = "vivid"): void {
  mainRaw()
    .query(
      `INSERT INTO memory_graph_nodes (
        id, content, type, created, last_accessed, last_consolidated,
        emotional_charge, fidelity, confidence, significance, stability,
        reinforcement_count, last_reinforced, source_conversations,
        source_type, scope_id
      ) VALUES (?, ?, 'semantic', 0, 0, 0,
        '{"kind":"neutral","intensity":0}', ?, 0.9, 0.8, 14, 0, 0, '[]',
        'inferred', 'default')`,
    )
    .run(id, `content ${id}`, fidelity);
}

/** Rows of the enqueued sweep job, id/type/status only, sorted by id. */
function sweepJobRows(): Array<{ id: string; type: string; status: string }> {
  return getMemorySqlite()!
    .query(
      `SELECT id, type, status FROM memory_jobs
       WHERE type = 'sweep_orphaned_graph_node_points' ORDER BY id`,
    )
    .all() as Array<{ id: string; type: string; status: string }>;
}

/**
 * Fake Qdrant client that reports `indexedTargetIds` as the indexed graph-node
 * points and records every `deleteByTarget` target id.
 */
function fakeQdrant(indexedTargetIds: string[]) {
  const deleted: string[] = [];
  return {
    deleted,
    client: {
      scrollByTargetType: async (targetType: string) => {
        expect(targetType).toBe("graph_node");
        return indexedTargetIds.map((targetId, i) => ({
          id: `point-${i}`,
          payload: { target_type: "graph_node", target_id: targetId },
        }));
      },
      deleteByTarget: async (targetType: string, targetId: string) => {
        expect(targetType).toBe("graph_node");
        deleted.push(targetId);
      },
    },
  };
}

beforeEach(() => {
  mainRaw().run("DELETE FROM memory_graph_nodes");
  getMemorySqlite()!.run("DELETE FROM memory_jobs");
  _resetQdrantBreaker();
});

// bun shares module state across a run, so a breaker left open by the
// QdrantCircuitOpenError case would leak into later test files — reset it here.
afterEach(() => {
  _resetQdrantBreaker();
});

describe("migration 341: enqueue cacheless graph-node vector sweep", () => {
  test("enqueues a single deterministic pending sweep job", () => {
    migrateSweepCachelessGraphNodeVectors(getDb());

    expect(sweepJobRows()).toEqual([
      {
        id: SWEEP_JOB_ID,
        type: "sweep_orphaned_graph_node_points",
        status: "pending",
      },
    ]);
  });

  test("is idempotent — a second run enqueues no duplicate", () => {
    migrateSweepCachelessGraphNodeVectors(getDb());
    migrateSweepCachelessGraphNodeVectors(getDb());

    expect(sweepJobRows()).toEqual([
      {
        id: SWEEP_JOB_ID,
        type: "sweep_orphaned_graph_node_points",
        status: "pending",
      },
    ]);
  });
});

describe("sweepOrphanedGraphNodePoints", () => {
  test("deletes points whose backing node row is gone, keeping live and soft-deleted", async () => {
    // Live node keeps its point; soft-deleted node keeps its row (fidelity
    // `gone`) so its point is retained too. `orphan-*` have no row at all.
    seedNode("live", "vivid");
    seedNode("soft", "gone");
    const { client, deleted } = fakeQdrant([
      "live",
      "soft",
      "orphan-a",
      "orphan-b",
    ]);

    const result = await sweepOrphanedGraphNodePoints(client);

    expect(deleted.sort()).toEqual(["orphan-a", "orphan-b"]);
    expect(result).toEqual({ scanned: 4, deleted: 2 });
  });

  test("no indexed graph-node points → no deletes", async () => {
    seedNode("live");
    const { client, deleted } = fakeQdrant([]);

    const result = await sweepOrphanedGraphNodePoints(client);

    expect(deleted).toEqual([]);
    expect(result).toEqual({ scanned: 0, deleted: 0 });
  });

  test("every indexed point backed by a live node → no deletes", async () => {
    seedNode("a");
    seedNode("b");
    const { client, deleted } = fakeQdrant(["a", "b"]);

    const result = await sweepOrphanedGraphNodePoints(client);

    expect(deleted).toEqual([]);
    expect(result).toEqual({ scanned: 2, deleted: 0 });
  });

  test("is idempotent — after the orphan point is gone, a re-run deletes nothing", async () => {
    seedNode("live");
    const first = fakeQdrant(["live", "orphan"]);
    await sweepOrphanedGraphNodePoints(first.client);
    expect(first.deleted).toEqual(["orphan"]);

    // The orphan point no longer scrolls back on the second pass.
    const second = fakeQdrant(["live"]);
    const result = await sweepOrphanedGraphNodePoints(second.client);

    expect(second.deleted).toEqual([]);
    expect(result).toEqual({ scanned: 1, deleted: 0 });
  });

  test("an already-open circuit fails the scroll fast with QdrantCircuitOpenError", async () => {
    // Trip the breaker open so the next Qdrant op fails fast.
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
      await withQdrantBreaker(async () => {
        throw new Error("qdrant unavailable");
      }).catch(() => {});
    }

    let scrollCalled = false;
    const client = {
      scrollByTargetType: async () => {
        scrollCalled = true;
        return [];
      },
      deleteByTarget: async () => {},
    };

    // The scroll is breaker-wrapped, so an open circuit surfaces as
    // QdrantCircuitOpenError before the scroll runs — the worker's
    // `handleJobError` maps this to a defer, not a bounded retry that would burn
    // the one-shot sweep.
    await expect(sweepOrphanedGraphNodePoints(client)).rejects.toBeInstanceOf(
      QdrantCircuitOpenError,
    );
    expect(scrollCalled).toBe(false);
  });
});
