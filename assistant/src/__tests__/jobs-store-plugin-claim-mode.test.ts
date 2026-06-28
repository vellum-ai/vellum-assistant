/**
 * Plugin-job claim routing for {@link claimMemoryJobs} and the worker lane.
 *
 * Plugin jobs (`plugin:<id>:`) are dispatched only by handlers that plugin init
 * registers, and plugin init runs only in the daemon — never in the standalone
 * worker process. So the standalone worker (`claimMode: "core"`) must NOT claim
 * a `plugin:` job (it has no handler and would fail it with "Unknown memory job
 * type"), while the daemon's plugin lane (`claimMode: "plugin"`) claims exactly
 * those jobs. `claimMode: "all"` (the daemon when it owns the whole queue)
 * claims both.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { AssistantConfig } from "../config/types.js";

const TEST_CONFIG: AssistantConfig = {
  ...DEFAULT_CONFIG,
  memory: { ...DEFAULT_CONFIG.memory, enabled: true },
};

mock.module("../config/loader.js", () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  invalidateConfigCache: () => {},
}));

// Keep the worker hermetic: stub the maintenance tail so `runMemoryJobsOnce`
// never reaches DB maintenance or graph-maintenance enqueues during the
// claim-mode assertions below.
mock.module("../persistence/db-maintenance.js", () => ({
  maybeRunDbMaintenance: () => {},
}));

import { eq } from "drizzle-orm";

import { getMemoryDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  claimMemoryJobs,
  enqueueMemoryJob,
  enqueuePluginJob,
  type MemoryJobType,
} from "../persistence/jobs-store.js";
import { runMemoryJobsOnce } from "../persistence/jobs-worker.js";
import { memoryJobs } from "../persistence/schema/index.js";

// A core-union-foreign plugin job type — the shape `enqueuePluginJob` writes.
const PLUGIN_JOB_TYPE = "plugin:reference-memory:consolidate" as MemoryJobType;

function statusOf(type: MemoryJobType): string | undefined {
  const db = getMemoryDb()!;
  return db.select().from(memoryJobs).where(eq(memoryJobs.type, type)).all()[0]
    ?.status;
}

describe("claimMemoryJobs — plugin/core claim modes", () => {
  beforeAll(async () => {
    await initializeDb();
  });

  beforeEach(() => {
    getMemoryDb()!.run("DELETE FROM memory_jobs");
  });

  test('"core" mode does not claim plugin-prefixed jobs', () => {
    enqueueMemoryJob("conversation_analyze", { conversationId: "conv-1" });
    enqueuePluginJob(PLUGIN_JOB_TYPE, { conversationId: "conv-1" });

    const claimed = claimMemoryJobs(
      { slowLlm: 10, fast: 10, embed: 10 },
      "core",
    );
    const types = claimed.map((j) => j.type);

    expect(types).toContain("conversation_analyze");
    expect(types).not.toContain(PLUGIN_JOB_TYPE);
    // The plugin job stays pending for the daemon's plugin lane to claim.
    expect(statusOf(PLUGIN_JOB_TYPE)).toBe("pending");
  });

  test('"plugin" mode claims only plugin-prefixed jobs', () => {
    enqueueMemoryJob("conversation_analyze", { conversationId: "conv-1" });
    enqueuePluginJob(PLUGIN_JOB_TYPE, { conversationId: "conv-1" });

    const claimed = claimMemoryJobs(
      { slowLlm: 10, fast: 10, embed: 10 },
      "plugin",
    );
    const types = claimed.map((j) => j.type);

    expect(types).toEqual([PLUGIN_JOB_TYPE]);
    // The core job is untouched.
    expect(statusOf("conversation_analyze")).toBe("pending");
  });

  test('"all" mode (default) claims both core and plugin jobs', () => {
    enqueueMemoryJob("conversation_analyze", { conversationId: "conv-1" });
    enqueuePluginJob(PLUGIN_JOB_TYPE, { conversationId: "conv-1" });

    const claimed = claimMemoryJobs({ slowLlm: 10, fast: 10, embed: 10 });
    const types = claimed.map((j) => j.type);

    expect(types).toContain("conversation_analyze");
    expect(types).toContain(PLUGIN_JOB_TYPE);
  });
});

describe("runMemoryJobsOnce — standalone worker (core mode) and a plugin job", () => {
  beforeAll(async () => {
    await initializeDb();
  });

  beforeEach(() => {
    getMemoryDb()!.run("DELETE FROM memory_jobs");
  });

  test("does not fail a plugin job (leaves it pending, no Unknown-type failure)", async () => {
    // The standalone worker registers no plugin handler. Before the claim-mode
    // fix it would claim this job, find no handler, and mark it `failed` with
    // "Unknown memory job type". With `claimMode: "core"` it must never claim
    // it — the job stays pending for the daemon's plugin lane.
    enqueuePluginJob(PLUGIN_JOB_TYPE, { conversationId: "conv-1" });

    const processed = await runMemoryJobsOnce({ claimMode: "core" });

    expect(processed).toBe(0);
    expect(statusOf(PLUGIN_JOB_TYPE)).toBe("pending");
  });
});
