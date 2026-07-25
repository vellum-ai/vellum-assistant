/**
 * Capability-node seeding across memory tiers: the graph-node upserts run on
 * every tier (the `list_memory` surface reads capability nodes regardless of
 * tier), but `embed_graph_node` rows target the v1 Qdrant collection and
 * dispatch discards them while concept-page memory is active — so the seeder
 * writes those rows only when v1 is the active tier. On the v1 path the
 * seeder also reconciles unchanged nodes that lack a stored embedding, so a
 * capability seeded while a higher tier was active still gets its v1 point.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { eq } from "drizzle-orm";

import { assertNotLiveDb } from "../../../../__tests__/assert-not-live-db.js";

const tmpWorkspace = mkdtempSync(join(tmpdir(), "capability-seed-embed-gate-"));
const previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;

const { setConfig } =
  await import("../../../../__tests__/helpers/set-config.js");
const { getDb, getMemoryDb } =
  await import("../../../../persistence/db-connection.js");
const { initializeDb } = await import("../../../../persistence/db-init.js");
const { memoryEmbeddings, memoryGraphNodes, memoryJobs } =
  await import("../../../../persistence/schema/index.js");
const { seedCliGraphNodes } = await import("../graph/capability-seed.js");

function countEmbedGraphNodeJobs(): number {
  return getMemoryDb()!
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, "embed_graph_node"))
    .all().length;
}

function countCapabilityNodes(): number {
  return getMemoryDb()!
    .select()
    .from(memoryGraphNodes)
    .where(eq(memoryGraphNodes.type, "procedural"))
    .all().length;
}

/**
 * Insert a `memory_embeddings` row for every capability node, simulating
 * completed `embed_graph_node` jobs. The reconcile path only checks row
 * presence on the `(target_type, target_id)` prefix, so provider/model/vector
 * values are arbitrary.
 */
function insertEmbeddingRowsForAllCapabilityNodes(): void {
  const nodes = getMemoryDb()!
    .select({ id: memoryGraphNodes.id })
    .from(memoryGraphNodes)
    .where(eq(memoryGraphNodes.type, "procedural"))
    .all();
  const now = Date.now();
  for (const node of nodes) {
    getDb()
      .insert(memoryEmbeddings)
      .values({
        id: randomUUID(),
        targetType: "graph_node",
        targetId: node.id,
        provider: "test-provider",
        model: "test-model",
        dimensions: 4,
        vectorJson: JSON.stringify([0, 0, 0, 0]),
        vectorBlob: null,
        contentHash: "test-hash",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

describe("capability seeding embed_graph_node gate", () => {
  beforeAll(async () => {
    await initializeDb();
  }, 30_000);

  afterAll(() => {
    if (previousWorkspaceEnv === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
    }
    assertNotLiveDb(tmpWorkspace);
    rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    getMemoryDb()!.run("DELETE FROM memory_jobs");
    getMemoryDb()!.run("DELETE FROM memory_graph_nodes");
    getDb().delete(memoryEmbeddings).run();
  });

  test("v3-live config: nodes are upserted but no embed_graph_node rows are enqueued", async () => {
    setConfig("memory", { v3: { live: true } });

    await seedCliGraphNodes();

    expect(countCapabilityNodes()).toBeGreaterThan(0);
    expect(countEmbedGraphNodeJobs()).toBe(0);
  });

  test("v1 config: newly created capability nodes enqueue embed_graph_node rows", async () => {
    setConfig("memory", { v2: { enabled: false }, v3: { live: false } });

    await seedCliGraphNodes();

    const nodes = countCapabilityNodes();
    expect(nodes).toBeGreaterThan(0);
    expect(countEmbedGraphNodeJobs()).toBe(nodes);
  });

  test("v1 after v3-live seeding: unchanged nodes with no embedding row re-enqueue embed_graph_node", async () => {
    setConfig("memory", { v3: { live: true } });
    await seedCliGraphNodes();
    expect(countEmbedGraphNodeJobs()).toBe(0);

    setConfig("memory", { v2: { enabled: false }, v3: { live: false } });
    await seedCliGraphNodes();

    const nodes = countCapabilityNodes();
    expect(nodes).toBeGreaterThan(0);
    expect(countEmbedGraphNodeJobs()).toBe(nodes);
  });

  test("v1 with embedding rows present: unchanged nodes do not enqueue duplicates", async () => {
    setConfig("memory", { v2: { enabled: false }, v3: { live: false } });
    await seedCliGraphNodes();
    expect(countCapabilityNodes()).toBeGreaterThan(0);

    insertEmbeddingRowsForAllCapabilityNodes();
    getMemoryDb()!.run("DELETE FROM memory_jobs");

    await seedCliGraphNodes();

    expect(countEmbedGraphNodeJobs()).toBe(0);
  });
});
