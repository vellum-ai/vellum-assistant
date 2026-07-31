/**
 * Daemon startup owns the v1-entry reconcile for a v1 boot: it runs the
 * capability seeding and the graph bootstrap check itself, so it claims the
 * one-shot `v1_entry_reconcile_done` marker BEFORE spawning the out-of-process
 * memory worker. That ordering is what keeps the worker's first tick from
 * running the same four steps against the same `memory_graph_nodes` rows
 * concurrently — the worker process does not exist yet when the marker lands,
 * so its reconcile can only ever see the claim.
 *
 * Qdrant is mocked as unavailable so the startup path reaches the claim without
 * a vector store: the claim, the worker spawn, and the seeding tail all sit
 * outside the Qdrant block, so the ordering under test is identical either way.
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

import { assertNotLiveDb } from "../../../../__tests__/assert-not-live-db.js";
import type { AssistantConfig } from "../../../../config/types.js";

/**
 * Persisted checkpoint key, spelled out rather than imported: the mocks below
 * have to be installed before `jobs-worker.js` is loaded. A test asserts it
 * still matches the exported constant.
 */
const V1_ENTRY_RECONCILE_KEY = "v1_entry_reconcile_done";

const tmpWorkspace = mkdtempSync(
  join(tmpdir(), "memory-startup-v1-entry-claim-"),
);
const previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;

const { setConfig } =
  await import("../../../../__tests__/helpers/set-config.js");
setConfig("memory", {});

const { applyNestedDefaults } = await import("../../../../config/loader.js");
const { initializeDb } = await import("../../../../persistence/db-init.js");
const { deleteMemoryCheckpoint, getMemoryCheckpoint } =
  await import("../../../../persistence/checkpoints.js");

/** Marker value observed at the instant the worker spawn was requested. */
let checkpointAtSpawn: string | null = null;
let spawnCalls = 0;
/** Startup steps that run after the spawn, in call order. */
const stepsAfterSpawn: string[] = [];

mock.module("../../../../persistence/embeddings/qdrant-manager.js", () => ({
  createQdrantManager: () => ({
    start: async () => {
      throw new Error("Qdrant is unavailable in this test");
    },
  }),
  stopQdrantManager: async () => {},
}));

mock.module("../worker-control.js", () => ({
  spawnMemoryWorkerProcess: async () => {
    spawnCalls += 1;
    checkpointAtSpawn = getMemoryCheckpoint(V1_ENTRY_RECONCILE_KEY);
    return { pid: 4242, alreadyRunning: false };
  },
  probeMemoryWorker: () => ({ running: false }),
  stopMemoryWorkerProcess: () => ({ running: false }),
}));

mock.module("../../../../daemon/skill-memory-refresh.js", () => ({
  refreshSkillCapabilityMemories: () => {
    stepsAfterSpawn.push("refreshSkillCapabilityMemories");
  },
}));

mock.module("../graph/capability-seed.js", () => ({
  deleteSkillCapabilityNode: () => {},
  seedSkillGraphNodes: () => {},
  seedCliGraphNodes: async () => {
    stepsAfterSpawn.push("seedCliGraphNodes");
  },
  seedUninstalledCatalogSkillMemories: async () => {},
}));

mock.module("../graph/node-embedding-reconcile.js", () => ({
  reconcileGraphNodeEmbeddings: async () => {},
  reconcileAllGraphNodeEmbeddings: async () => {
    stepsAfterSpawn.push("reconcileAllGraphNodeEmbeddings");
  },
}));

mock.module("../v1/graph/bootstrap.js", () => ({
  bootstrapFromHistory: async () => ({}),
  bootstrapFromJournal: async () => ({ extracted: 0, errors: 0 }),
  maybeEnqueueGraphBootstrap: () => {
    stepsAfterSpawn.push("maybeEnqueueGraphBootstrap");
  },
  resetBootstrapCheckpoint: () => {},
  migrateToolCreatedItems: () => {},
  cleanupStaleItemVectors: async () => {},
}));

const { GRAPH_MAINTENANCE_CHECKPOINTS } = await import("../jobs-worker.js");
const { runMemoryStartup } = await import("../startup.js");

/** Bun.sleep is patched out so the Qdrant start retries do not idle 15s. */
const realBunSleep = Bun.sleep;

function v1Config(): AssistantConfig {
  const config = applyNestedDefaults({});
  config.memory.v2.enabled = false;
  return config;
}

function substrateConfig(): AssistantConfig {
  return applyNestedDefaults({});
}

function memoryDisabledConfig(): AssistantConfig {
  const config = applyNestedDefaults({});
  config.memory.enabled = false;
  return config;
}

describe("v1-entry reconcile claim at daemon startup", () => {
  beforeAll(async () => {
    (Bun as { sleep: typeof Bun.sleep }).sleep = (async () =>
      undefined) as typeof Bun.sleep;
    await initializeDb();
  }, 30_000);

  afterAll(() => {
    (Bun as { sleep: typeof Bun.sleep }).sleep = realBunSleep;
    if (previousWorkspaceEnv === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
    }
    assertNotLiveDb(tmpWorkspace);
    rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    deleteMemoryCheckpoint(V1_ENTRY_RECONCILE_KEY);
    checkpointAtSpawn = null;
    spawnCalls = 0;
    stepsAfterSpawn.length = 0;
  });

  test("the checkpoint key matches the worker's exported constant", () => {
    expect(GRAPH_MAINTENANCE_CHECKPOINTS.v1EntryReconcile).toBe(
      V1_ENTRY_RECONCILE_KEY,
    );
  });

  test("a v1 boot claims the reconcile before the worker is spawned", async () => {
    await runMemoryStartup(v1Config());

    expect(spawnCalls).toBe(1);
    expect(checkpointAtSpawn).not.toBeNull();
    expect(getMemoryCheckpoint(V1_ENTRY_RECONCILE_KEY)).not.toBeNull();
    // The claim covers exactly the four steps the worker's reconcile runs —
    // including the graph-node embedding backfill, which is the only one that
    // covers ordinary user-created nodes.
    expect(stepsAfterSpawn).toEqual([
      "refreshSkillCapabilityMemories",
      "seedCliGraphNodes",
      "maybeEnqueueGraphBootstrap",
      "reconcileAllGraphNodeEmbeddings",
    ]);
  });

  test("a substrate boot leaves the reconcile unclaimed", async () => {
    await runMemoryStartup(substrateConfig());

    expect(spawnCalls).toBe(1);
    expect(checkpointAtSpawn).toBeNull();
    expect(getMemoryCheckpoint(V1_ENTRY_RECONCILE_KEY)).toBeNull();
  });

  test("a memory-disabled boot leaves the reconcile unclaimed", async () => {
    await runMemoryStartup(memoryDisabledConfig());

    expect(spawnCalls).toBe(1);
    expect(checkpointAtSpawn).toBeNull();
    expect(getMemoryCheckpoint(V1_ENTRY_RECONCILE_KEY)).toBeNull();
  });
});
