/**
 * The v1-entry backfill for ORDINARY graph nodes — the ones the memory-item
 * routes and the `memory_edit` tool write on every tier, not the capability
 * nodes `capability-seed.ts` owns.
 *
 * The sequence this file pins down, end to end:
 *
 *  1. Under the concept-page substrate a user creates a memory item. The route
 *     writes a `memory_graph_nodes` row (all-tier) and enqueues
 *     `embed_graph_node` (all-tier too — the route has no tier gate).
 *  2. The worker claims that row and `processJob` drops it: `embed_graph_node`
 *     is in `V1_QDRANT_JOB_TYPES`, so off v1 it completes as a no-op. The node
 *     now exists with no embedding and no pending job — nothing on disk records
 *     that an embed is owed.
 *  3. The assistant later returns to v1. The capability seeders reconcile their
 *     own nodes and the graph bootstrap self-skips (the graph is not empty), so
 *     before this fix the user's node stayed out of v1 semantic retrieval
 *     permanently. `reconcileAllGraphNodeEmbeddings` is what closes that.
 *
 * The reconcile shares its predicate with capability seeding (see
 * `capability-seed-embed-gate.test.ts`): a node counts as embedded only when a
 * `memory_embeddings` row matches its id, the backend's (provider, model)
 * identity, and the content hash of the text the embed job would send. The
 * no-duplicate-work cases below assert the other half of that — a node whose
 * embedding is current is left alone.
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
import type { NewNode } from "../graph/types.js";

const tmpWorkspace = mkdtempSync(
  join(tmpdir(), "v1-entry-node-embed-reconcile-"),
);
const previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;

/** Identity the stubbed embedding backend reports for every lookup. */
const TEST_PROVIDER = "local";
const TEST_MODEL = "test-model";

// The reconcile keys its lookup on the backend's (provider, model) identity, so
// the backend is stubbed to a fixed one; the rest of the module stays real.
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
  selectedBackendSupportsMultimodal: async () => false,
}));

// The worker tick calls into DB maintenance on every drain; neither matters
// here and both touch the sqlite file directly.
mock.module("../../../../persistence/db-maintenance.js", () => ({
  maybeRunDbMaintenance: () => {},
  maybeRunPassiveWalCheckpoint: () => {},
}));

const { setConfig } =
  await import("../../../../__tests__/helpers/set-config.js");
const { getDb, getMemoryDb } =
  await import("../../../../persistence/db-connection.js");
const { initializeDb } = await import("../../../../persistence/db-init.js");
const { embeddingInputContentHash } =
  await import("../../../../persistence/embeddings/embedding-types.js");
const { enqueueMemoryJob } =
  await import("../../../../persistence/jobs-store.js");
const { memoryEmbeddings, memoryJobs } =
  await import("../../../../persistence/schema/index.js");
const { formatNodeForEmbedding } = await import("../graph/graph-search.js");
const { reconcileAllGraphNodeEmbeddings } =
  await import("../graph/node-embedding-reconcile.js");
const { createNode, getNode, updateNode } = await import("../graph/store.js");
const { runMemoryJobsOnce } = await import("../jobs-worker.js");

/** Concept-page substrate live — the tier that drops the embed job. */
function useSubstrateTier(): void {
  setConfig("memory", { v3: { live: true } });
}

/** v1 is the live tier. */
function useV1Tier(): void {
  setConfig("memory", { v2: { enabled: false }, v3: { live: false } });
}

function userNode(content: string): NewNode {
  const now = Date.now();
  return {
    content,
    type: "semantic",
    created: now,
    lastAccessed: now,
    lastConsolidated: now,
    eventDate: null,
    emotionalCharge: {
      valence: 0,
      intensity: 0.1,
      decayCurve: "linear",
      decayRate: 0.05,
      originalIntensity: 0.1,
    },
    fidelity: "vivid",
    confidence: 0.95,
    significance: 0.8,
    stability: 14,
    reinforcementCount: 0,
    lastReinforced: now,
    sourceConversations: [],
    sourceType: "direct",
    narrativeRole: null,
    partOfStory: null,
    imageRefs: null,
  };
}

function embedJobsFor(nodeId: string): Array<typeof memoryJobs.$inferSelect> {
  return getMemoryDb()!
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, "embed_graph_node"))
    .all()
    .filter(
      (row) =>
        (JSON.parse(row.payload) as { nodeId?: string }).nodeId === nodeId,
    );
}

function embeddingRowCount(nodeId: string): number {
  return getDb()
    .select()
    .from(memoryEmbeddings)
    .where(
      and(
        eq(memoryEmbeddings.targetType, "graph_node"),
        eq(memoryEmbeddings.targetId, nodeId),
      ),
    )
    .all().length;
}

/**
 * Write the `memory_embeddings` row a successful embed job would have left for
 * `nodeId`. Defaults match the stub backend's identity and the hash of the text
 * `embedGraphNodeDirect` sends, so overriding one facet isolates it.
 */
function insertEmbeddingRow(
  nodeId: string,
  overrides: { provider?: string; model?: string; contentHash?: string } = {},
): void {
  const node = getNode(nodeId);
  if (!node) {
    throw new Error(`No graph node ${nodeId}`);
  }
  const now = Date.now();
  getDb()
    .insert(memoryEmbeddings)
    .values({
      id: randomUUID(),
      targetType: "graph_node",
      targetId: nodeId,
      provider: overrides.provider ?? TEST_PROVIDER,
      model: overrides.model ?? TEST_MODEL,
      dimensions: 4,
      vectorJson: JSON.stringify([0, 0, 0, 0]),
      vectorBlob: null,
      contentHash:
        overrides.contentHash ??
        embeddingInputContentHash(formatNodeForEmbedding(node)),
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/**
 * Step 1 + 2 of the sequence: create a node and let the worker drop its embed
 * job while the substrate is live. Returns the node id, which by construction
 * has no embedding row and no pending embed job.
 */
async function createNodeWithDroppedEmbed(content: string): Promise<string> {
  useSubstrateTier();
  const node = createNode(userNode(content));
  const jobId = enqueueMemoryJob("embed_graph_node", { nodeId: node.id });

  await runMemoryJobsOnce();

  const row = getMemoryDb()!
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.id, jobId))
    .get();
  // The drop this whole file exists for: completed, with nothing embedded.
  expect(row?.status).toBe("completed");
  expect(embeddingRowCount(node.id)).toBe(0);
  return node.id;
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

describe("v1-entry graph-node embedding reconcile", () => {
  beforeEach(() => {
    getMemoryDb()!.run("DELETE FROM memory_jobs");
    getMemoryDb()!.run("DELETE FROM memory_graph_nodes");
    getDb().delete(memoryEmbeddings).run();
  });

  test("a user node whose embed was dropped under the substrate is re-enqueued on v1 entry", async () => {
    const nodeId = await createNodeWithDroppedEmbed(
      "Pragun's standup is at 9:30am",
    );

    useV1Tier();
    getMemoryDb()!.run("DELETE FROM memory_jobs");
    await reconcileAllGraphNodeEmbeddings();

    const jobs = embedJobsFor(nodeId);
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.status).toBe("pending");
  });

  test("a node edited under the substrate re-enqueues even though a stale embedding row exists", async () => {
    const nodeId = await createNodeWithDroppedEmbed("The office wifi is Guest");
    // The embed that landed while the node still had its original content.
    insertEmbeddingRow(nodeId);

    // A `memory_edit` under the substrate rewrites the node and drops its embed.
    updateNode(nodeId, { content: "The office wifi is Guest-5G" });
    getMemoryDb()!.run("DELETE FROM memory_jobs");

    useV1Tier();
    await reconcileAllGraphNodeEmbeddings();

    expect(embedJobsFor(nodeId).length).toBe(1);
  });

  test("a node already embedded under the current backend is not re-enqueued", async () => {
    const nodeId = await createNodeWithDroppedEmbed("I prefer aisle seats");
    insertEmbeddingRow(nodeId);
    getMemoryDb()!.run("DELETE FROM memory_jobs");

    useV1Tier();
    await reconcileAllGraphNodeEmbeddings();

    expect(embedJobsFor(nodeId)).toEqual([]);
  });

  test("a second reconcile pass queues no duplicate work", async () => {
    const nodeId = await createNodeWithDroppedEmbed("I run on Tuesdays");
    getMemoryDb()!.run("DELETE FROM memory_jobs");

    useV1Tier();
    await reconcileAllGraphNodeEmbeddings();
    await reconcileAllGraphNodeEmbeddings();

    // The enqueue coalesces with the pending row from the first pass.
    expect(embedJobsFor(nodeId).length).toBe(1);
  });

  test("an embedding row from another backend does not count as embedded", async () => {
    const nodeId = await createNodeWithDroppedEmbed("My dentist is Dr. Okafor");
    insertEmbeddingRow(nodeId, { provider: "other-provider" });
    insertEmbeddingRow(nodeId, { model: "other-model" });
    getMemoryDb()!.run("DELETE FROM memory_jobs");

    useV1Tier();
    await reconcileAllGraphNodeEmbeddings();

    expect(embedJobsFor(nodeId).length).toBe(1);
  });

  test("gone nodes are skipped — their embed job would be a no-op", async () => {
    const nodeId = await createNodeWithDroppedEmbed("An obsolete fact");
    updateNode(nodeId, { fidelity: "gone" });
    getMemoryDb()!.run("DELETE FROM memory_jobs");

    useV1Tier();
    await reconcileAllGraphNodeEmbeddings();

    expect(embedJobsFor(nodeId)).toEqual([]);
  });

  test("the scan self-gates off v1, so a substrate tick enqueues nothing", async () => {
    const nodeId = await createNodeWithDroppedEmbed("Still on the substrate");
    getMemoryDb()!.run("DELETE FROM memory_jobs");

    // Substrate still live: re-enqueuing here would just be dropped again.
    await reconcileAllGraphNodeEmbeddings();

    expect(embedJobsFor(nodeId)).toEqual([]);
  });

  test("a large graph is walked past a single batch", async () => {
    // 250 nodes crosses the 200-row scan batch, so a pass that stopped after
    // its first keyset page would miss the tail.
    useSubstrateTier();
    const ids: string[] = [];
    for (let i = 0; i < 250; i++) {
      ids.push(createNode(userNode(`Bulk fact number ${i}`)).id);
    }

    useV1Tier();
    await reconcileAllGraphNodeEmbeddings();

    const enqueued = new Set(
      getMemoryDb()!
        .select()
        .from(memoryJobs)
        .where(eq(memoryJobs.type, "embed_graph_node"))
        .all()
        .map((row) => (JSON.parse(row.payload) as { nodeId: string }).nodeId),
    );
    for (const id of ids) {
      expect(enqueued.has(id)).toBe(true);
    }
  });
});
