/**
 * Plugin job-handler teardown ({@link unregisterJobHandlersForOwner}).
 *
 * A plugin's background-job handler is registered into the process-global
 * handler map under its `plugin:<id>:` namespace — the same namespaced key the
 * jobs facet stamps (facet namespacing itself is covered by
 * `daemon/__tests__/jobs-facet.test.ts`). When the plugin is disabled or removed
 * at runtime, those handlers must be torn down so a pending `plugin:<id>:` job
 * can no longer dispatch into the gone plugin's code. Proven end-to-end through
 * the real worker (`runMemoryJobsOnce`):
 *
 * 1. After teardown, a claimed `plugin:<id>:` job finds no handler and is NOT
 *    executed — it fails via the "Unknown memory job type" path rather than
 *    running the disabled plugin's code.
 * 2. Owner-scoped teardown is surgical: a sibling plugin's handler and a core
 *    (non-`plugin:`-prefixed) handler stay registered and still run.
 * 3. The standalone-worker claim-mode contract is preserved: `claimMode: "core"`
 *    still never claims a `plugin:` job (it stays pending for the daemon lane).
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { AssistantConfig } from "../../config/types.js";

const TEST_CONFIG: AssistantConfig = {
  ...DEFAULT_CONFIG,
  memory: { ...DEFAULT_CONFIG.memory, enabled: true },
};

mock.module("../../config/loader.js", () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  getNestedValue: () => undefined,
  invalidateConfigCache: () => {},
}));

// Keep the worker hermetic: stub the maintenance tail so `runMemoryJobsOnce`
// never reaches DB maintenance or graph-maintenance enqueues.
mock.module("../db-maintenance.js", () => ({
  maybeRunDbMaintenance: () => {},
}));

import { eq } from "drizzle-orm";

import { getMemoryDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import {
  claimMemoryJobs,
  enqueueMemoryJob,
  enqueuePluginJob,
  type MemoryJobType,
} from "../jobs-store.js";
import {
  registerJobHandler,
  runMemoryJobsOnce,
  unregisterJobHandlersForOwner,
} from "../jobs-worker.js";
import { memoryJobs } from "../schema/index.js";

const PLUGIN_A_JOB = "plugin:plugin-a:consolidate" as MemoryJobType;
const PLUGIN_B_JOB = "plugin:plugin-b:consolidate" as MemoryJobType;
const CORE_JOB = "conversation_analyze" as MemoryJobType;

function statusOf(type: MemoryJobType): string | undefined {
  const db = getMemoryDb()!;
  return db.select().from(memoryJobs).where(eq(memoryJobs.type, type)).all()[0]
    ?.status;
}

describe("plugin job-handler teardown on deactivation", () => {
  beforeAll(async () => {
    await initializeDb();
  });

  beforeEach(() => {
    getMemoryDb()!.run("DELETE FROM memory_jobs");
  });

  test("a deactivated plugin's job is not executed; sibling + core handlers survive", async () => {
    let pluginARan = false;
    let pluginBRan = false;
    let coreRan = false;

    // A core handler — registered directly, NOT under a plugin namespace.
    registerJobHandler(CORE_JOB, () => {
      coreRan = true;
    });
    // Two plugins' handlers, registered under the `plugin:<id>:` namespace the
    // jobs facet stamps.
    registerJobHandler(PLUGIN_A_JOB, () => {
      pluginARan = true;
    });
    registerJobHandler(PLUGIN_B_JOB, () => {
      pluginBRan = true;
    });

    // Tear down plugin-a (disabled/removed at runtime), leaving plugin-b.
    unregisterJobHandlersForOwner("plugin-a");

    enqueuePluginJob(PLUGIN_A_JOB, { conversationId: "conv-1" });
    enqueuePluginJob(PLUGIN_B_JOB, { conversationId: "conv-1" });
    enqueueMemoryJob(CORE_JOB, { conversationId: "conv-1" });

    // Drain the whole queue (daemon owns both lanes).
    await runMemoryJobsOnce({ claimMode: "all" });

    // plugin-a's code never ran — its job hit the no-handler path and failed.
    expect(pluginARan).toBe(false);
    expect(statusOf(PLUGIN_A_JOB)).toBe("failed");

    // The owner-scoped teardown is surgical: plugin-b and the core handler are
    // untouched and ran to success.
    expect(pluginBRan).toBe(true);
    expect(statusOf(PLUGIN_B_JOB)).toBe("completed");
    expect(coreRan).toBe(true);
    expect(statusOf(CORE_JOB)).toBe("completed");
  });

  test('standalone worker ("core" mode) still never claims a plugin job', async () => {
    registerJobHandler(PLUGIN_A_JOB, () => {});
    enqueuePluginJob(PLUGIN_A_JOB, { conversationId: "conv-1" });

    // `claimMode: "core"` is the standalone worker's slice — it must leave
    // `plugin:` jobs for the daemon lane regardless of handler-teardown state.
    const claimed = claimMemoryJobs(
      { slowLlm: 10, fast: 10, embed: 10 },
      "core",
    );
    expect(claimed.map((j) => j.type)).not.toContain(PLUGIN_A_JOB);

    const processed = await runMemoryJobsOnce({ claimMode: "core" });
    expect(processed).toBe(0);
    expect(statusOf(PLUGIN_A_JOB)).toBe("pending");
  });
});
