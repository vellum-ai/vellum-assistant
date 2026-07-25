/**
 * Capability-node seeding across memory tiers: the graph-node upserts run on
 * every tier (the `list_memory` surface reads capability nodes regardless of
 * tier), but `embed_graph_node` rows target the v1 Qdrant collection and
 * dispatch discards them while concept-page memory is active — so the seeder
 * writes those rows only when v1 is the active tier. On the v1 path the
 * seeder also reconciles unchanged nodes whose current content has no
 * embedding under the current backend, so a capability seeded (or edited)
 * while a higher tier was active still gets its v1 point. A node counts as
 * embedded only when a `memory_embeddings` row matches its id, the backend's
 * (provider, model) identity, and the content hash of the text the embed job
 * would send — anything else re-enqueues. Enqueues coalesce with a pending
 * `embed_graph_node` row for the same node, so back-to-back seed passes queue
 * at most one job per node.
 *
 * The second block covers the invariant that reconcile leans on:
 * `embedAndUpsert` writes its `memory_embeddings` row only once the Qdrant
 * upsert has succeeded, so a cache row never claims a point that is not
 * there. It lives here because `embedAndUpsert` has no dedicated test file
 * and the capability reconcile is what the honesty of that row protects.
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
  mock,
  test,
} from "bun:test";

import { and, eq } from "drizzle-orm";

import { assertNotLiveDb } from "../../../../__tests__/assert-not-live-db.js";

const tmpWorkspace = mkdtempSync(join(tmpdir(), "capability-seed-embed-gate-"));
const previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;

/** Identity the stubbed embedding backend reports for every lookup. */
const TEST_PROVIDER = "local";
const TEST_MODEL = "test-model";

// ── Embedding backend stub ─────────────────────────────────────────
// The reconcile lookup keys on the backend's (provider, model) identity, and
// `embedAndUpsert` embeds through the same module. Both are stubbed so the
// tests run without a backend; the remaining exports stay real so unrelated
// importers keep working.
const realEmbeddingBackend =
  await import("../../../../persistence/embeddings/embedding-backend.js");
mock.module("../../../../persistence/embeddings/embedding-backend.js", () => ({
  ...realEmbeddingBackend,
  getMemoryBackendStatus: async () => ({
    enabled: true,
    degraded: false,
    provider: TEST_PROVIDER,
    model: TEST_MODEL,
    reason: null,
  }),
  embedWithBackend: async (_config: unknown, inputs: unknown[]) => ({
    provider: TEST_PROVIDER,
    model: TEST_MODEL,
    vectors: inputs.map(() => [0.1, 0.2, 0.3, 0.4]),
  }),
  generateSparseEmbedding: () => ({ indices: [1], values: [1] }),
  selectedBackendSupportsMultimodal: async () => false,
}));

// ── Qdrant client stub ─────────────────────────────────────────────
// `upsertShouldFail` drives the failed-upsert case; upserted target ids are
// recorded so a success can be told apart from a no-op.
let upsertShouldFail = false;
const upsertedTargetIds: string[] = [];
const realQdrantClient =
  await import("../../../../persistence/embeddings/qdrant-client.js");
mock.module("../../../../persistence/embeddings/qdrant-client.js", () => ({
  ...realQdrantClient,
  getQdrantClient: () => ({
    upsert: async (_targetType: string, targetId: string) => {
      if (upsertShouldFail) {
        throw new Error("qdrant upsert failed");
      }
      upsertedTargetIds.push(targetId);
    },
  }),
}));

const { setConfig } =
  await import("../../../../__tests__/helpers/set-config.js");
const { getConfig } = await import("../../../../config/loader.js");
const { getDb, getMemoryDb } =
  await import("../../../../persistence/db-connection.js");
const { initializeDb } = await import("../../../../persistence/db-init.js");
const { embeddingInputContentHash } =
  await import("../../../../persistence/embeddings/embedding-types.js");
const { _resetQdrantBreaker: resetQdrantBreaker } =
  await import("../../../../persistence/embeddings/qdrant-circuit-breaker.js");
const { embedAndUpsert } = await import("../../../../persistence/job-utils.js");
const { memoryEmbeddings, memoryGraphNodes, memoryJobs } =
  await import("../../../../persistence/schema/index.js");
const { seedCliGraphNodes } = await import("../graph/capability-seed.js");
const { formatNodeForEmbedding } = await import("../graph/graph-search.js");
const { rowToNode } = await import("../graph/store.js");

function countEmbedGraphNodeJobs(): number {
  return getMemoryDb()!
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, "embed_graph_node"))
    .all().length;
}

function capabilityNodeRows(): Array<typeof memoryGraphNodes.$inferSelect> {
  return getMemoryDb()!
    .select()
    .from(memoryGraphNodes)
    .where(eq(memoryGraphNodes.type, "procedural"))
    .all();
}

function countCapabilityNodes(): number {
  return capabilityNodeRows().length;
}

function countEmbeddingRows(targetId: string): number {
  return getDb()
    .select()
    .from(memoryEmbeddings)
    .where(
      and(
        eq(memoryEmbeddings.targetType, "graph_node"),
        eq(memoryEmbeddings.targetId, targetId),
      ),
    )
    .all().length;
}

/**
 * Insert a `memory_embeddings` row for every capability node, simulating
 * completed `embed_graph_node` jobs. Defaults match what the embed job would
 * write — the stub backend's identity and the hash of the text
 * `embedGraphNodeDirect` embeds — so overriding one facet isolates it.
 */
function insertEmbeddingRowsForAllCapabilityNodes(
  overrides: {
    provider?: string;
    model?: string;
    contentHash?: string;
  } = {},
): void {
  const now = Date.now();
  for (const row of capabilityNodeRows()) {
    getDb()
      .insert(memoryEmbeddings)
      .values({
        id: randomUUID(),
        targetType: "graph_node",
        targetId: row.id,
        provider: overrides.provider ?? TEST_PROVIDER,
        model: overrides.model ?? TEST_MODEL,
        dimensions: 4,
        vectorJson: JSON.stringify([0, 0, 0, 0]),
        vectorBlob: null,
        contentHash:
          overrides.contentHash ??
          embeddingInputContentHash(formatNodeForEmbedding(rowToNode(row))),
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

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

describe("capability seeding embed_graph_node gate", () => {
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

  test("v1 double-seed with no embedding rows: exactly one pending embed job per node", async () => {
    setConfig("memory", { v2: { enabled: false }, v3: { live: false } });

    await seedCliGraphNodes();
    await seedCliGraphNodes();

    const nodes = countCapabilityNodes();
    expect(nodes).toBeGreaterThan(0);
    expect(countEmbedGraphNodeJobs()).toBe(nodes);
  });

  test("v1 with current embedding rows present: unchanged nodes do not enqueue duplicates", async () => {
    setConfig("memory", { v2: { enabled: false }, v3: { live: false } });
    await seedCliGraphNodes();
    expect(countCapabilityNodes()).toBeGreaterThan(0);

    insertEmbeddingRowsForAllCapabilityNodes();
    getMemoryDb()!.run("DELETE FROM memory_jobs");

    await seedCliGraphNodes();

    expect(countEmbedGraphNodeJobs()).toBe(0);
  });

  test("v1 with a stale content hash: unchanged nodes re-enqueue embed_graph_node", async () => {
    setConfig("memory", { v2: { enabled: false }, v3: { live: false } });
    await seedCliGraphNodes();

    // The hash a capability's previous description would have left behind.
    insertEmbeddingRowsForAllCapabilityNodes({
      contentHash: "hash-of-the-previous-description",
    });
    getMemoryDb()!.run("DELETE FROM memory_jobs");

    await seedCliGraphNodes();

    const nodes = countCapabilityNodes();
    expect(nodes).toBeGreaterThan(0);
    expect(countEmbedGraphNodeJobs()).toBe(nodes);
  });

  test("v1 with rows from another embedding provider: unchanged nodes re-enqueue", async () => {
    setConfig("memory", { v2: { enabled: false }, v3: { live: false } });
    await seedCliGraphNodes();

    insertEmbeddingRowsForAllCapabilityNodes({ provider: "other-provider" });
    getMemoryDb()!.run("DELETE FROM memory_jobs");

    await seedCliGraphNodes();

    const nodes = countCapabilityNodes();
    expect(nodes).toBeGreaterThan(0);
    expect(countEmbedGraphNodeJobs()).toBe(nodes);
  });

  test("v1 with rows from another embedding model: unchanged nodes re-enqueue", async () => {
    setConfig("memory", { v2: { enabled: false }, v3: { live: false } });
    await seedCliGraphNodes();

    insertEmbeddingRowsForAllCapabilityNodes({ model: "other-model" });
    getMemoryDb()!.run("DELETE FROM memory_jobs");

    await seedCliGraphNodes();

    const nodes = countCapabilityNodes();
    expect(nodes).toBeGreaterThan(0);
    expect(countEmbedGraphNodeJobs()).toBe(nodes);
  });
});

describe("embedAndUpsert embedding-cache row", () => {
  beforeEach(() => {
    upsertShouldFail = false;
    upsertedTargetIds.length = 0;
    getDb().delete(memoryEmbeddings).run();
    resetQdrantBreaker();
  });

  test("a failed Qdrant upsert leaves no cache row", async () => {
    upsertShouldFail = true;

    await expect(
      embedAndUpsert(getConfig(), "graph_node", "node-upsert-fails", "text"),
    ).rejects.toThrow("qdrant upsert failed");

    expect(countEmbeddingRows("node-upsert-fails")).toBe(0);
  });

  test("a successful Qdrant upsert writes the cache row", async () => {
    await embedAndUpsert(
      getConfig(),
      "graph_node",
      "node-upsert-succeeds",
      "text",
    );

    expect(upsertedTargetIds).toEqual(["node-upsert-succeeds"]);
    expect(countEmbeddingRows("node-upsert-succeeds")).toBe(1);
  });
});
