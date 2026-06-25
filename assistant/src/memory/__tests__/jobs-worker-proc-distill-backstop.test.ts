/**
 * Tests for the `memory_proc_distill` backstop in
 * `maybeEnqueueGraphMaintenanceJobs` (jobs-worker.ts).
 *
 * The primary trigger for distillation is the post-consolidation follow-up
 * (consolidation-job.ts), but that only fires when consolidation actually ran —
 * and scheduled consolidation no-ops while the buffer is under the minimum line
 * threshold. A cluster left `ready` by a transient/skipped/failed distill (or
 * one never retried because no new memory arrived) would otherwise sit forever.
 * This backstop re-enqueues `memory_proc_distill` on its own interval so a
 * stranded `ready` cluster always gets another pass.
 *
 * Coverage:
 *   - feature active + interval elapsed (no checkpoint) → enqueues once;
 *   - feature active but recent checkpoint → no enqueue (interval not elapsed);
 *   - feature inactive (flag off / v3 not live) → never enqueues;
 *   - global memory disabled → never enqueues;
 *   - the checkpoint advances after an enqueue so it doesn't re-fire next tick.
 *
 * The gate is mocked so the test drives `isProcToSkillsActive` directly instead
 * of standing up feature-flag overrides + workspace `memory.v3.live` state.
 * Tests use a temp workspace pinned via `VELLUM_WORKSPACE_DIR` so the DB lives
 * under `tmpdir()` and `~/.vellum/` is never touched.
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

import { createMockLoggerModule } from "../../__tests__/helpers/mock-logger.js";

mock.module("../../util/logger.js", () => createMockLoggerModule());

// Drive the proc-to-skills gate directly. `isMemoryV3Live` is consulted by the
// v3-maintain backstop too; default it on so that backstop's presence doesn't
// interfere (these tests assert only on `memory_proc_distill` counts).
let procToSkillsActiveSlot = true;
mock.module("../../config/memory-v3-gate.js", () => ({
  isProcToSkillsActive: () => procToSkillsActiveSlot,
  isProcToSkillsEnabled: () => procToSkillsActiveSlot,
  isMemoryV3Live: () => true,
}));

// Workspace pin must precede the `db` import below — the DB singleton resolves
// its path at first call, so the env var must be set before anything touches
// sqlite.
let tmpWorkspace: string;
let previousWorkspaceEnv: string | undefined;

beforeAll(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "proc-distill-backstop-test-"));
  previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;
});

afterAll(() => {
  if (previousWorkspaceEnv === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
  }
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

const { getMemoryDb } = await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { resetTestTables } = await import("../raw-query.js");
const { memoryJobs } = await import("../schema.js");
const { applyNestedDefaults } = await import("../../config/loader.js");
const { getMemoryCheckpoint, setMemoryCheckpoint } =
  await import("../checkpoints.js");
const { maybeEnqueueGraphMaintenanceJobs, GRAPH_MAINTENANCE_CHECKPOINTS } =
  await import("../jobs-worker.js");

const PROC_DISTILL_CHECKPOINT_KEY =
  GRAPH_MAINTENANCE_CHECKPOINTS.memoryProcDistill;

function buildConfig(overrides: { memoryEnabled?: boolean } = {}) {
  const partial = applyNestedDefaults({});
  if (overrides.memoryEnabled !== undefined) {
    partial.memory.enabled = overrides.memoryEnabled;
  }
  // v2 on so the schedule takes the single-consolidator branch; the proc-distill
  // backstop is orthogonal to that split.
  partial.memory.v2.enabled = true;
  return partial;
}

function countPendingJobs(type: string): number {
  return getMemoryDb()!
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, type))
    .all().length;
}

await initializeDb();

beforeEach(() => {
  getMemoryDb()!.run("DELETE FROM memory_jobs");
  resetTestTables("memory_checkpoints");
  procToSkillsActiveSlot = true;
});

describe("maybeEnqueueGraphMaintenanceJobs — proc-distill backstop", () => {
  test("enqueues when active and the interval has elapsed (no checkpoint)", () => {
    const config = buildConfig();

    maybeEnqueueGraphMaintenanceJobs(config, Date.now());

    expect(countPendingJobs("memory_proc_distill")).toBe(1);
  });

  test("advances the checkpoint after enqueuing so it doesn't re-fire", () => {
    const config = buildConfig();
    const now = Date.now();

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_proc_distill")).toBe(1);
    expect(getMemoryCheckpoint(PROC_DISTILL_CHECKPOINT_KEY)).toBe(String(now));

    // A second tick with the checkpoint just stamped does not re-enqueue.
    maybeEnqueueGraphMaintenanceJobs(config, now + 1_000);
    expect(countPendingJobs("memory_proc_distill")).toBe(1);
  });

  test("does not enqueue before the interval has elapsed", () => {
    const config = buildConfig();
    const now = Date.now();
    // Stamp the checkpoint to "1 minute ago"; the interval is 6h.
    setMemoryCheckpoint(PROC_DISTILL_CHECKPOINT_KEY, String(now - 60_000));

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_proc_distill")).toBe(0);
  });

  test("enqueues again once the interval elapses", () => {
    const config = buildConfig();
    const now = Date.now();
    // Stamp the checkpoint to >6h ago.
    setMemoryCheckpoint(
      PROC_DISTILL_CHECKPOINT_KEY,
      String(now - 7 * 60 * 60 * 1000),
    );

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_proc_distill")).toBe(1);
  });

  test("does not enqueue when the feature is inactive (flag off / v3 not live)", () => {
    procToSkillsActiveSlot = false;
    const config = buildConfig();

    // No checkpoint → the interval is trivially elapsed; only the gate suppresses.
    maybeEnqueueGraphMaintenanceJobs(config, Date.now());

    expect(countPendingJobs("memory_proc_distill")).toBe(0);
  });

  test("does not enqueue when global memory is disabled", () => {
    const config = buildConfig({ memoryEnabled: false });

    maybeEnqueueGraphMaintenanceJobs(config, Date.now());

    expect(countPendingJobs("memory_proc_distill")).toBe(0);
  });
});
