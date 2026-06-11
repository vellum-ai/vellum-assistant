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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { getMemoryCheckpoint, setMemoryCheckpoint, deleteMemoryCheckpoint } =
  await import("../checkpoints.js");
const { maybeEnqueueGraphMaintenanceJobs } = await import("../jobs-worker.js");

const CONSOLIDATE_CHECKPOINT_KEY = "memory_v2_consolidate_last_run";

function buildConfig(overrides: {
  memoryEnabled?: boolean;
  v2Enabled?: boolean;
  intervalHours?: number;
  maxBufferLines?: number | null;
}) {
  const partial = applyNestedDefaults({});
  if (overrides.memoryEnabled !== undefined) {
    partial.memory.enabled = overrides.memoryEnabled;
  }
  if (overrides.v2Enabled !== undefined) {
    partial.memory.v2.enabled = overrides.v2Enabled;
  }
  if (overrides.intervalHours !== undefined) {
    partial.memory.v2.consolidation_interval_hours = overrides.intervalHours;
  }
  if (overrides.maxBufferLines !== undefined) {
    partial.memory.v2.consolidation_max_buffer_lines = overrides.maxBufferLines;
  }
  return partial;
}

function writeBuffer(lineCount: number): void {
  const memoryDir = join(tmpWorkspace, "memory");
  mkdirSync(memoryDir, { recursive: true });
  const entries = Array.from(
    { length: lineCount },
    (_, i) => `- [Jan 15, 2:${String(i).padStart(2, "0")} PM] note ${i}`,
  );
  writeFileSync(join(memoryDir, "buffer.md"), entries.join("\n") + "\n");
}

function removeBuffer(): void {
  rmSync(join(tmpWorkspace, "memory", "buffer.md"), { force: true });
}

function countPendingJobs(type: string): number {
  return getDb()
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, type))
    .all().length;
}

function consolidationJobPayloads(): Record<string, unknown>[] {
  return getDb()
    .select({ payload: memoryJobs.payload })
    .from(memoryJobs)
    .where(eq(memoryJobs.type, "memory_v2_consolidate"))
    .all()
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
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
    writeBuffer(15);

    maybeEnqueueGraphMaintenanceJobs(config, Date.now());

    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
    expect(consolidationJobPayloads()).toEqual([{ trigger: "automatic" }]);
    // v1 entries are suppressed when v2 is active.
    expect(countPendingJobs("graph_decay")).toBe(0);
    expect(countPendingJobs("graph_consolidate")).toBe(0);
    expect(countPendingJobs("graph_pattern_scan")).toBe(0);
    expect(countPendingJobs("graph_narrative_refine")).toBe(0);
  });

  test("does not enqueue consolidate when global memory is disabled", () => {
    const config = buildConfig({
      memoryEnabled: false,
      v2Enabled: true,
      intervalHours: 1,
    });
    writeBuffer(15);

    maybeEnqueueGraphMaintenanceJobs(config, Date.now());

    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);
    expect(countPendingJobs("graph_consolidate")).toBe(0);
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
    writeBuffer(15);

    const now = Date.now();
    // Stamp checkpoint to >1h ago.
    setMemoryCheckpoint(
      CONSOLIDATE_CHECKPOINT_KEY,
      String(now - 2 * 60 * 60 * 1000),
    );

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
    expect(consolidationJobPayloads()).toEqual([{ trigger: "automatic" }]);
  });

  test("respects a custom consolidation_interval_hours value", () => {
    const config = buildConfig({ v2Enabled: true, intervalHours: 6 });
    writeBuffer(15);

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
    writeBuffer(15);

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

describe("maybeEnqueueGraphMaintenanceJobs — buffer-size trigger", () => {
  test("default threshold (100 lines) fires once the buffer reaches it", () => {
    const config = buildConfig({ v2Enabled: true, intervalHours: 1 });

    const now = Date.now();
    // Recent checkpoint so the time-based trigger does not fire.
    setMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY, String(now - 60_000));
    writeBuffer(100);

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
  });

  test("explicit null disables the size trigger", () => {
    const config = buildConfig({
      v2Enabled: true,
      intervalHours: 1,
      maxBufferLines: null,
    });

    const now = Date.now();
    setMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY, String(now - 60_000));
    writeBuffer(500);

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);
  });

  test("enqueues when buffer reaches the threshold even if interval not elapsed", () => {
    const config = buildConfig({
      v2Enabled: true,
      intervalHours: 1,
      maxBufferLines: 5,
    });

    const now = Date.now();
    setMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY, String(now - 60_000));
    writeBuffer(10);

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
    // Checkpoint refreshed so the time-based branch doesn't re-fire.
    expect(getMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY)).toBe(String(now));
  });

  test("does not re-fire on every tick while buffer stays over threshold", () => {
    const config = buildConfig({
      v2Enabled: true,
      intervalHours: 1,
      maxBufferLines: 5,
    });

    const now = Date.now();
    // Recent checkpoint so the time-based branch never fires across ticks —
    // the only thing that could re-enqueue is the size branch.
    setMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY, String(now - 60_000));
    writeBuffer(10);

    // Simulate several worker ticks with the buffer still over threshold and
    // the first-tick job still pending (nothing has drained it yet).
    maybeEnqueueGraphMaintenanceJobs(config, now);
    maybeEnqueueGraphMaintenanceJobs(config, now + 1_000);
    maybeEnqueueGraphMaintenanceJobs(config, now + 2_000);

    // A pending consolidate job dedupes the later ticks — only one enqueue.
    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
  });

  test("does not enqueue when buffer is under the threshold", () => {
    const config = buildConfig({
      v2Enabled: true,
      intervalHours: 1,
      maxBufferLines: 5,
    });

    const now = Date.now();
    setMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY, String(now - 60_000));
    writeBuffer(3);

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);
  });

  test("treats missing buffer file as zero lines", () => {
    const config = buildConfig({
      v2Enabled: true,
      intervalHours: 1,
      maxBufferLines: 1,
    });

    const now = Date.now();
    setMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY, String(now - 60_000));
    removeBuffer();

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);
  });

  test("does not double-enqueue when both triggers would fire", () => {
    const config = buildConfig({
      v2Enabled: true,
      intervalHours: 1,
      maxBufferLines: 5,
    });

    const now = Date.now();
    // Stale checkpoint so time-based fires, AND buffer over threshold.
    setMemoryCheckpoint(
      CONSOLIDATE_CHECKPOINT_KEY,
      String(now - 2 * 60 * 60 * 1000),
    );
    writeBuffer(10);

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
  });

  test("size trigger inert when v2 is disabled", () => {
    const config = buildConfig({
      v2Enabled: false,
      intervalHours: 1,
      maxBufferLines: 1,
    });

    writeBuffer(100);

    maybeEnqueueGraphMaintenanceJobs(config, Date.now());

    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);
  });

  test("size trigger inert when global memory is disabled", () => {
    const config = buildConfig({
      memoryEnabled: false,
      v2Enabled: true,
      intervalHours: 1,
      maxBufferLines: 1,
    });

    writeBuffer(100);

    maybeEnqueueGraphMaintenanceJobs(config, Date.now());

    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);
  });
});

describe("maybeEnqueueGraphMaintenanceJobs — min buffer lines noop", () => {
  test("skips scheduled consolidation when buffer is under 10 lines", () => {
    // GIVEN v2 consolidation is enabled and the interval has elapsed
    const config = buildConfig({ v2Enabled: true, intervalHours: 1 });
    const now = Date.now();
    setMemoryCheckpoint(
      CONSOLIDATE_CHECKPOINT_KEY,
      String(now - 2 * 60 * 60 * 1000),
    );
    // AND the buffer has fewer than 10 lines
    writeBuffer(5);

    // WHEN the schedule runs
    maybeEnqueueGraphMaintenanceJobs(config, now);

    // THEN no consolidation job is enqueued
    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);
    // AND the checkpoint advances so the skip doesn't re-fire next tick
    expect(getMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY)).toBe(String(now));
  });

  test("allows scheduled consolidation when buffer has exactly 10 lines", () => {
    // GIVEN v2 consolidation is enabled and the interval has elapsed
    const config = buildConfig({ v2Enabled: true, intervalHours: 1 });
    const now = Date.now();
    setMemoryCheckpoint(
      CONSOLIDATE_CHECKPOINT_KEY,
      String(now - 2 * 60 * 60 * 1000),
    );
    // AND the buffer has exactly 10 lines
    writeBuffer(10);

    // WHEN the schedule runs
    maybeEnqueueGraphMaintenanceJobs(config, now);

    // THEN consolidation is enqueued
    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
  });

  test("skips scheduled consolidation when buffer file is missing", () => {
    // GIVEN v2 consolidation is enabled and the interval has elapsed
    const config = buildConfig({ v2Enabled: true, intervalHours: 1 });
    const now = Date.now();
    setMemoryCheckpoint(
      CONSOLIDATE_CHECKPOINT_KEY,
      String(now - 2 * 60 * 60 * 1000),
    );
    // AND no buffer file exists (0 lines)
    removeBuffer();

    // WHEN the schedule runs
    maybeEnqueueGraphMaintenanceJobs(config, now);

    // THEN no consolidation job is enqueued
    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);
    // AND the checkpoint advances
    expect(getMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY)).toBe(String(now));
  });

  test("size-based trigger is independent of the min-lines noop", () => {
    // GIVEN the time-based interval has elapsed but the buffer has fewer
    // than 10 lines, while exceeding the configured maxBufferLines threshold
    const config = buildConfig({
      v2Enabled: true,
      intervalHours: 1,
      maxBufferLines: 5,
    });
    const now = Date.now();
    setMemoryCheckpoint(
      CONSOLIDATE_CHECKPOINT_KEY,
      String(now - 2 * 60 * 60 * 1000),
    );
    writeBuffer(8);

    // WHEN the schedule runs
    maybeEnqueueGraphMaintenanceJobs(config, now);

    // THEN consolidation is enqueued via the size trigger despite the
    // time-based schedule being nooped (8 < 10 min lines, but 8 >= 5 max)
    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
  });
});
