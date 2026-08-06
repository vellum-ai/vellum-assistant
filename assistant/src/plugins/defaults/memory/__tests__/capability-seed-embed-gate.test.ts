/**
 * Capability-node seeding across memory tiers: the graph-node upserts run on
 * every tier (the `list_memory` surface reads capability nodes regardless of
 * tier), but `embed_graph_node` rows target the v1 Qdrant collection and
 * dispatch discards them while concept-page memory is active — so the seeder
 * writes those rows only when v1 is the active tier.
 *
 * The second block covers a general embedding invariant: `embedAndUpsert`
 * writes its `memory_embeddings` row only once the Qdrant upsert has
 * succeeded, so a cache row never claims a point that is not there. It lives
 * here because `embedAndUpsert` has no dedicated test file.
 */
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
// `embedAndUpsert` embeds through this module, so it is stubbed to run the
// tests without a backend; the remaining exports stay real so unrelated
// importers keep working.
const realEmbeddingBackend =
  await import("../../../../persistence/embeddings/embedding-backend.js");
mock.module("../../../../persistence/embeddings/embedding-backend.js", () => ({
  ...realEmbeddingBackend,
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
const { getMemoryDb } =
  await import("../../../../persistence/db-connection.js");
const { initializeDb } = await import("../../../../persistence/db-init.js");
const { _resetQdrantBreaker: resetQdrantBreaker } =
  await import("../../../../persistence/embeddings/qdrant-circuit-breaker.js");
const { embedAndUpsert } = await import("../../../../persistence/job-utils.js");
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

function countEmbeddingRows(targetId: string): number {
  return getMemoryDb()!
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
    getMemoryDb()!.delete(memoryEmbeddings).run();
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
});

describe("embedAndUpsert embedding-cache row", () => {
  beforeEach(() => {
    upsertShouldFail = false;
    upsertedTargetIds.length = 0;
    getMemoryDb()!.delete(memoryEmbeddings).run();
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
