/**
 * Regression: the in-handler gates for `graph_extract` and
 * `build_conversation_summary` must key off the resolved memory provider, not
 * the raw `memory.v2.enabled` flag.
 *
 * Both job types write/feed the v1 graph system: `graph_extract` populates the
 * v1 graph, and `build_conversation_summary` produces `memorySummaries` rows
 * read only by the v1 read path (`fetchRecentSummaries`, v1 semantic search).
 * Neither is consumed by the v2/v3 readers. So both must RUN only when the
 * resolved provider is `"graph"` and be short-circuited under `"v2"`/`"v3"`.
 *
 * Keying these gates on `v2.enabled` (rather than `resolveMemoryProviderId`)
 * wrongly skipped both jobs under an explicit `memory.provider: "graph"` pin
 * left at the schema-default `v2.enabled: true`, so a pinned graph install
 * could never extract or summarize. Under the default `provider: "auto"` the
 * resolution derives from `v2.enabled`, so migrated setups are unaffected — the
 * pin is the only behavior that changes.
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

let graphExtractCalls = 0;
let buildSummaryCalls = 0;

// Stub the underlying handlers so the test observes whether the registered
// arrow dispatched them or short-circuited on the provider gate — without
// touching the real (uninitialized) v1 backends.
mock.module("../graph/extraction-job.js", () => ({
  graphExtractJob: async (): Promise<void> => {
    graphExtractCalls += 1;
  },
}));

mock.module("../job-handlers/summarization.js", () => ({
  buildConversationSummaryJob: async (): Promise<void> => {
    buildSummaryCalls += 1;
  },
}));

mock.module("../../persistence/db-maintenance.js", () => ({
  maybeRunDbMaintenance: () => {},
}));

const tmpWorkspace = mkdtempSync(
  join(tmpdir(), "register-job-handlers-provider-pin-"),
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

async function statusOf(jobId: string): Promise<string | undefined> {
  const rows = getMemoryDb()!
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.id, jobId))
    .all();
  return rows[0]?.status;
}

describe("graph_extract / build_conversation_summary gates under a provider pin", () => {
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
    graphExtractCalls = 0;
    buildSummaryCalls = 0;
    _resetQdrantBreaker();
  });

  test("graph_extract RUNS when provider is pinned to graph (v2.enabled default true)", async () => {
    activeConfig = configWith("graph");
    const jobId = enqueueMemoryJob("graph_extract", {
      conversationId: "conv-1",
    });

    await runMemoryJobsOnce();

    expect(graphExtractCalls).toBe(1);
    expect(await statusOf(jobId)).toBe("completed");
  });

  test("graph_extract is short-circuited (handler not run) when provider is v2", async () => {
    activeConfig = configWith("v2");
    const jobId = enqueueMemoryJob("graph_extract", {
      conversationId: "conv-1",
    });

    await runMemoryJobsOnce();

    expect(graphExtractCalls).toBe(0);
    expect(await statusOf(jobId)).toBe("completed");
  });

  test("graph_extract is short-circuited when provider is v3", async () => {
    activeConfig = configWith("v3");
    const jobId = enqueueMemoryJob("graph_extract", {
      conversationId: "conv-1",
    });

    await runMemoryJobsOnce();

    expect(graphExtractCalls).toBe(0);
    expect(await statusOf(jobId)).toBe("completed");
  });

  test("build_conversation_summary RUNS when provider is graph", async () => {
    activeConfig = configWith("graph");
    const jobId = enqueueMemoryJob("build_conversation_summary", {
      conversationId: "conv-1",
    });

    await runMemoryJobsOnce();

    expect(buildSummaryCalls).toBe(1);
    expect(await statusOf(jobId)).toBe("completed");
  });

  test("build_conversation_summary is short-circuited when provider is v2", async () => {
    activeConfig = configWith("v2");
    const jobId = enqueueMemoryJob("build_conversation_summary", {
      conversationId: "conv-1",
    });

    await runMemoryJobsOnce();

    expect(buildSummaryCalls).toBe(0);
    expect(await statusOf(jobId)).toBe("completed");
  });

  test("build_conversation_summary is short-circuited when provider is v3", async () => {
    activeConfig = configWith("v3");
    const jobId = enqueueMemoryJob("build_conversation_summary", {
      conversationId: "conv-1",
    });

    await runMemoryJobsOnce();

    expect(buildSummaryCalls).toBe(0);
    expect(await statusOf(jobId)).toBe("completed");
  });
});
