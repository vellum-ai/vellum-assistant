/**
 * Regression: `graph_trigger_embed` must NOT be short-circuited when
 * `memory.v2.enabled` is true. The handler `embedGraphTriggerJob` writes
 * `conditionEmbedding` to SQLite and never touches the v1 Qdrant client, so
 * including it in `V1_QDRANT_JOB_TYPES` would leave semantic triggers
 * permanently unembedded under v2 and break `evaluateSemanticTriggers`
 * recall.
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

import { makeMockLogger } from "../../../../__tests__/helpers/mock-logger.js";
import { DEFAULT_CONFIG } from "../../../../config/defaults.js";
import type { AssistantConfig } from "../../../../config/types.js";

mock.module("../../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

const TEST_CONFIG: AssistantConfig = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    enabled: true,
    v2: { ...DEFAULT_CONFIG.memory.v2, enabled: true },
  },
};

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => TEST_CONFIG,
  loadConfig: () => TEST_CONFIG,
  invalidateConfigCache: () => {},
}));

let triggerHandlerCalls = 0;

mock.module("../graph/graph-search.js", () => ({
  searchGraphNodes: async () => [],
  embedGraphNodeDirect: async () => {},
  embedGraphNodeJob: async (): Promise<void> => {},
  enqueueGraphNodeEmbed: () => {},
  embedGraphTriggerJob: async (): Promise<void> => {
    triggerHandlerCalls += 1;
  },
  enqueueGraphTriggerEmbed: () => {},
}));

mock.module("../../../../persistence/db-maintenance.js", () => ({
  maybeRunDbMaintenance: () => {},
}));

const tmpWorkspace = mkdtempSync(
  join(tmpdir(), "jobs-worker-v2-graph-trigger-embed-"),
);
const previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;

import { getMemoryDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { _resetQdrantBreaker } from "../../../../persistence/embeddings/qdrant-circuit-breaker.js";
import { enqueueMemoryJob } from "../../../../persistence/jobs-store.js";
import { memoryJobs } from "../../../../persistence/schema/index.js";
import { registerMemoryPluginJobHandlers } from "../job-handler-registration.js";
import { runMemoryJobsOnce } from "../jobs-worker.js";

describe("graph_trigger_embed under memory v2", () => {
  beforeAll(async () => {
    registerMemoryPluginJobHandlers();
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
    triggerHandlerCalls = 0;
    _resetQdrantBreaker();
  });

  test("handler runs (is not short-circuited) when v2 is enabled", async () => {
    const jobId = enqueueMemoryJob("graph_trigger_embed", {
      triggerId: "trigger-123",
    });

    await runMemoryJobsOnce();

    expect(triggerHandlerCalls).toBe(1);

    const rows = getMemoryDb()!
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, jobId))
      .all();
    expect(rows[0]?.status).toBe("completed");
  });
});
