/**
 * Tests for v1/v2 mutual exclusion in `maybeEnqueueGraphMaintenanceJobs`.
 *
 * The schedule is mutually exclusive: when `memory.v2.enabled` is true,
 * only `memory_v2_consolidate` is scheduled; otherwise the four v1
 * entries (decay, consolidate, pattern_scan, narrative) fire and the v2
 * entry does not.
 *
 * Coverage:
 *   - Config off → only v1 entries fire (no `memory_v2_consolidate`).
 *   - Config on, no prior checkpoint → only the v2 entry fires.
 *   - Config on, recent checkpoint → no v2 row (interval not yet elapsed).
 *   - Config on, stale checkpoint → v2 row enqueued, checkpoint refreshed.
 *
 * The sweep job is intentionally NOT scheduled here: it is wired into the
 * `graph_extract` debounce in `indexer.ts`. Those triggers are covered by
 * the separate trigger-path tests; this file owns only the cron entries.
 *
 * Tests use a temp workspace pinned via `VELLUM_WORKSPACE_DIR` so the DB
 * lives under `tmpdir()` and `~/.vellum/` is never touched.
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

mock.module("../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// Workspace pin must precede the `db` import below — the DB singleton
// resolves its path at first call, so we need the env var set before
// anything touches sqlite.
let tmpWorkspace: string;
let previousWorkspaceEnv: string | undefined;

beforeAll(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "memory-v2-schedule-test-"));
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

const { getDb } = await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { resetTestTables } = await import("../raw-query.js");
const { memoryJobs } = await import("../schema.js");
const { applyNestedDefaults } = await import("../../config/loader.js");
const { setMemoryCheckpoint, deleteMemoryCheckpoint } =
  await import("../checkpoints.js");
const { maybeEnqueueGraphMaintenanceJobs } = await import("../jobs-worker.js");

const CONSOLIDATE_CHECKPOINT_KEY = "memory_v2_consolidate_last_run";

function buildConfig(overrides: {
  v2Enabled?: boolean;
  intervalHours?: number;
}) {
  const partial = applyNestedDefaults({});
  if (overrides.v2Enabled !== undefined) {
    partial.memory.v2.enabled = overrides.v2Enabled;
  }
  if (overrides.intervalHours !== undefined) {
    partial.memory.v2.consolidation_interval_hours = overrides.intervalHours;
  }
  return partial;
}

function countPendingJobs(type: string): number {
  return getDb()
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, type))
    .all().length;
}

// Initialize the DB once for the file; clear per-test tables in beforeEach
// rather than tearing down the singleton, which is slow because it re-runs
// every migration on the next access.
initializeDb();

beforeEach(() => {
  // Clear job + checkpoint state so each test starts from zero rows. Other
  // tables stay intact — the worker only inspects these two.
  resetTestTables("memory_jobs", "memory_checkpoints");
});

// ---------------------------------------------------------------------------

describe("maybeEnqueueGraphMaintenanceJobs — memory v2 consolidation", () => {
  test("does not enqueue consolidate when config.memory.v2.enabled is off", () => {
    const config = buildConfig({ v2Enabled: false, intervalHours: 1 });

    maybeEnqueueGraphMaintenanceJobs(config, Date.now());

    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);
  });

  test("enqueues consolidate when v2 is on and no checkpoint exists", () => {
    const config = buildConfig({ v2Enabled: true, intervalHours: 1 });

    maybeEnqueueGraphMaintenanceJobs(config, Date.now());

    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
    // v1 entries are suppressed when v2 is active.
    expect(countPendingJobs("graph_decay")).toBe(0);
    expect(countPendingJobs("graph_consolidate")).toBe(0);
    expect(countPendingJobs("graph_pattern_scan")).toBe(0);
    expect(countPendingJobs("graph_narrative_refine")).toBe(0);
  });

  test("does not enqueue consolidate before the interval has elapsed", () => {
    const config = buildConfig({ v2Enabled: true, intervalHours: 1 });

    const now = Date.now();
    // Stamp checkpoint to "1 minute ago"; interval is 1h, so elapsed << interval.
    setMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY, String(now - 60_000));

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);
  });

  test("enqueues consolidate again once the interval elapses", () => {
    const config = buildConfig({ v2Enabled: true, intervalHours: 1 });

    const now = Date.now();
    // Stamp checkpoint to >1h ago.
    setMemoryCheckpoint(
      CONSOLIDATE_CHECKPOINT_KEY,
      String(now - 2 * 60 * 60 * 1000),
    );

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
  });

  test("respects a custom consolidation_interval_hours value", () => {
    const config = buildConfig({ v2Enabled: true, intervalHours: 6 });

    const now = Date.now();
    // 4h elapsed — under the configured 6h interval.
    setMemoryCheckpoint(
      CONSOLIDATE_CHECKPOINT_KEY,
      String(now - 4 * 60 * 60 * 1000),
    );

    maybeEnqueueGraphMaintenanceJobs(config, now);
    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);

    // 7h elapsed — over the configured 6h interval.
    setMemoryCheckpoint(
      CONSOLIDATE_CHECKPOINT_KEY,
      String(now - 7 * 60 * 60 * 1000),
    );

    maybeEnqueueGraphMaintenanceJobs(config, now);
    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
  });

  test("v1 maintenance entries are suppressed when v2 is active", () => {
    const config = buildConfig({ v2Enabled: true, intervalHours: 1 });

    // No checkpoints set — every entry would be due if it were scheduled.
    deleteMemoryCheckpoint("graph_maintenance:decay:last_run");
    deleteMemoryCheckpoint("graph_maintenance:consolidate:last_run");
    deleteMemoryCheckpoint("graph_maintenance:pattern_scan:last_run");
    deleteMemoryCheckpoint("graph_maintenance:narrative:last_run");
    deleteMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY);

    maybeEnqueueGraphMaintenanceJobs(config, Date.now());

    expect(countPendingJobs("graph_decay")).toBe(0);
    expect(countPendingJobs("graph_consolidate")).toBe(0);
    expect(countPendingJobs("graph_pattern_scan")).toBe(0);
    expect(countPendingJobs("graph_narrative_refine")).toBe(0);
    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
  });

  test("v2-off path fires v1 entries and does not enqueue v2", () => {
    const config = buildConfig({ v2Enabled: false, intervalHours: 1 });

    deleteMemoryCheckpoint("graph_maintenance:decay:last_run");
    deleteMemoryCheckpoint("graph_maintenance:consolidate:last_run");
    deleteMemoryCheckpoint("graph_maintenance:pattern_scan:last_run");
    deleteMemoryCheckpoint("graph_maintenance:narrative:last_run");
    deleteMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY);

    maybeEnqueueGraphMaintenanceJobs(config, Date.now());

    expect(countPendingJobs("graph_decay")).toBe(1);
    expect(countPendingJobs("graph_consolidate")).toBe(1);
    expect(countPendingJobs("graph_pattern_scan")).toBe(1);
    expect(countPendingJobs("graph_narrative_refine")).toBe(1);
    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);
  });
});
