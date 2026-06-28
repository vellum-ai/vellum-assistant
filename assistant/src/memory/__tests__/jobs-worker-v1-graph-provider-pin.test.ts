/**
 * Regression: a v1 Qdrant job (e.g. `rebuild_index`) must be RUN — not
 * short-circuited as stale — when the resolved memory provider is `"graph"`,
 * even while `memory.v2.enabled` sits at its schema default of `true`.
 *
 * `processJob` skips `V1_QDRANT_JOB_TYPES` only when the resolved provider is
 * not `"graph"`. Keying the gate on the raw `v2.enabled` flag (rather than
 * `resolveMemoryProviderId`) treated every v1 job as stale under an explicit
 * `memory.provider: "graph"` pin, so a pinned graph install could never
 * maintain its backing Qdrant data. The pin must run v1 jobs; `"v2"` (and the
 * default `"auto"` derived from `v2.enabled`) must still treat them as stale.
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

import { eq } from "drizzle-orm";

import { makeMockLogger } from "../../__tests__/helpers/mock-logger.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { AssistantConfig } from "../../config/types.js";

mock.module("../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// The active config is swapped per-test by mutating `activeConfig`, so the
// worker's `getConfig()` reads the provider/v2 combination under test.
let activeConfig: AssistantConfig = DEFAULT_CONFIG;

mock.module("../../config/loader.js", () => ({
  getConfig: () => activeConfig,
  loadConfig: () => activeConfig,
  invalidateConfigCache: () => {},
}));

let rebuildHandlerCalls = 0;

// `rebuild_index` ∈ V1_QDRANT_JOB_TYPES. Stub its handler so the test observes
// whether `processJob` dispatched it or short-circuited it as stale — without
// touching the real (uninitialized) v1 Qdrant client.
mock.module("../job-handlers/index-maintenance.js", () => ({
  rebuildIndexJob: async (): Promise<void> => {
    rebuildHandlerCalls += 1;
  },
  deleteQdrantVectorsJob: async (): Promise<void> => {},
}));

mock.module("../../persistence/db-maintenance.js", () => ({
  maybeRunDbMaintenance: () => {},
}));

const tmpWorkspace = mkdtempSync(
  join(tmpdir(), "jobs-worker-v1-graph-provider-pin-"),
);
const previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;

import { getMemoryDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { _resetQdrantBreaker } from "../../persistence/embeddings/qdrant-circuit-breaker.js";
import { enqueueMemoryJob } from "../../persistence/jobs-store.js";
import { runMemoryJobsOnce } from "../../persistence/jobs-worker.js";
import { memoryJobs } from "../../persistence/schema/index.js";
import { registerMemoryJobHandlers } from "../register-job-handlers.js";

function configWith(
  provider: AssistantConfig["memory"]["provider"],
): AssistantConfig {
  return {
    ...DEFAULT_CONFIG,
    memory: {
      ...DEFAULT_CONFIG.memory,
      enabled: true,
      provider,
      // Left at the schema default so the test pins behavior on `provider`,
      // not on a flipped legacy flag.
      v2: { ...DEFAULT_CONFIG.memory.v2, enabled: true },
    },
  };
}

describe("v1 Qdrant job dispatch under a graph provider pin", () => {
  beforeAll(async () => {
    registerMemoryJobHandlers();
    await initializeDb();
  });

  afterAll(() => {
    if (previousWorkspaceEnv === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
    }
    rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    getMemoryDb()!.run("DELETE FROM memory_jobs");
    rebuildHandlerCalls = 0;
    _resetQdrantBreaker();
  });

  test("runs the v1 job when provider is pinned to graph (v2.enabled default true)", async () => {
    activeConfig = configWith("graph");
    const jobId = enqueueMemoryJob("rebuild_index", {});

    await runMemoryJobsOnce();

    expect(rebuildHandlerCalls).toBe(1);

    const rows = getMemoryDb()!
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, jobId))
      .all();
    expect(rows[0]?.status).toBe("completed");
  });

  test("short-circuits the v1 job (handler not run) when provider is v2", async () => {
    activeConfig = configWith("v2");
    const jobId = enqueueMemoryJob("rebuild_index", {});

    await runMemoryJobsOnce();

    expect(rebuildHandlerCalls).toBe(0);

    const rows = getMemoryDb()!
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, jobId))
      .all();
    expect(rows[0]?.status).toBe("completed");
  });
});
