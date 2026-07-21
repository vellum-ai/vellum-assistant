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

import { createMockLoggerModule } from "../../../../__tests__/helpers/mock-logger.js";

mock.module("../../../../util/logger.js", () => createMockLoggerModule());

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

const { getMemoryDb } =
  await import("../../../../persistence/db-connection.js");
const { initializeDb } = await import("../../../../persistence/db-init.js");
const { resetTestTables } =
  await import("../../../../persistence/raw-query.js");
const { memoryJobs } = await import("../../../../persistence/schema/index.js");
const { applyNestedDefaults } = await import("../../../../config/loader.js");
const { getMemoryCheckpoint, setMemoryCheckpoint, deleteMemoryCheckpoint } =
  await import("../../../../persistence/checkpoints.js");
const { maybeEnqueueGraphMaintenanceJobs, consolidationFailureBackoffMs } =
  await import("../jobs-worker.js");
const { CONSOLIDATION_FAILURE_CHECKPOINT_KEY } =
  await import("../v2/consolidation-job.js");
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
  return getMemoryDb()!
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, type))
    .all().length;
}

function consolidationJobPayloads(): Record<string, unknown>[] {
  return getMemoryDb()!
    .select({ payload: memoryJobs.payload })
    .from(memoryJobs)
    .where(eq(memoryJobs.type, "memory_v2_consolidate"))
    .all()
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

// Initialize the DB once for the file; clear per-test tables in beforeEach
// rather than tearing down the singleton, which is slow because it re-runs
// every migration on the next access.
await initializeDb();

// Open the memory connection now, while VELLUM_WORKSPACE_DIR still points at the
// migrated per-process workspace. beforeAll swaps it to a fresh dir; without
// pinning here, the first getMemoryDb() below would lazily open
// assistant-memory.db in the swapped (empty) workspace and fail with
// "no such table: memory_jobs".
getMemoryDb();

beforeEach(() => {
  // Clear job + checkpoint state so each test starts from zero rows. Other
  // tables stay intact — the worker only inspects these two. memory_jobs lives
  // in the dedicated memory connection; memory_checkpoints in main.
  getMemoryDb()!.run("DELETE FROM memory_jobs");
  resetTestTables("memory_checkpoints");
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

describe("maybeEnqueueGraphMaintenanceJobs — consolidation failure backoff", () => {
  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;

  function seedFailureState(
    consecutiveFailures: number,
    lastFailureAt: number,
    kind: "billing" | "transient" = "transient",
  ): void {
    setMemoryCheckpoint(
      CONSOLIDATION_FAILURE_CHECKPOINT_KEY,
      JSON.stringify({ consecutiveFailures, lastFailureAt, kind }),
    );
  }

  test("interval trigger is skipped inside the backoff window and the checkpoint does not advance", () => {
    const config = buildConfig({ v2Enabled: true, intervalHours: 1 });
    const now = Date.now();
    const staleCheckpoint = String(now - 2 * HOUR_MS);
    setMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY, staleCheckpoint);
    writeBuffer(15);
    // One failure a minute ago → 5min backoff, 4min remaining.
    seedFailureState(1, now - MINUTE_MS);

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);
    expect(getMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY)).toBe(
      staleCheckpoint,
    );
  });

  test("size trigger is skipped inside the backoff window and the checkpoint does not advance", () => {
    const config = buildConfig({
      v2Enabled: true,
      intervalHours: 1,
      maxBufferLines: 5,
    });
    const now = Date.now();
    const recentCheckpoint = String(now - MINUTE_MS);
    setMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY, recentCheckpoint);
    writeBuffer(10);
    seedFailureState(1, now - MINUTE_MS);

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);
    expect(getMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY)).toBe(
      recentCheckpoint,
    );
  });

  test("enqueue resumes on the first tick after the backoff elapses", () => {
    const config = buildConfig({
      v2Enabled: true,
      intervalHours: 1,
      maxBufferLines: 5,
    });
    const now = Date.now();
    setMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY, String(now - MINUTE_MS));
    writeBuffer(10);
    seedFailureState(1, now - MINUTE_MS);

    // Inside the 5min window: skipped.
    maybeEnqueueGraphMaintenanceJobs(config, now);
    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);

    // Past the window: the size trigger fires.
    maybeEnqueueGraphMaintenanceJobs(config, now + 6 * MINUTE_MS);
    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
  });

  test("interval trigger resumes after the backoff elapses without waiting a full interval", () => {
    const config = buildConfig({ v2Enabled: true, intervalHours: 1 });
    const now = Date.now();
    setMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY, String(now - 2 * HOUR_MS));
    writeBuffer(15);
    // 5min backoff already elapsed.
    seedFailureState(1, now - 6 * MINUTE_MS);

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
  });

  test("transient backoff grows with the failure count", () => {
    const config = buildConfig({
      v2Enabled: true,
      intervalHours: 1,
      maxBufferLines: 5,
    });
    const now = Date.now();
    setMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY, String(now - MINUTE_MS));
    writeBuffer(10);
    // Three transient failures → 20min backoff; 6min elapsed (past the
    // single-failure 5min window) must still skip.
    seedFailureState(3, now - 6 * MINUTE_MS);

    maybeEnqueueGraphMaintenanceJobs(config, now);
    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);

    // 21min elapsed → the 20min window is over.
    seedFailureState(3, now - 21 * MINUTE_MS);
    maybeEnqueueGraphMaintenanceJobs(config, now);
    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
  });

  test("transient backoff never delays more than 30 minutes", () => {
    const config = buildConfig({
      v2Enabled: true,
      intervalHours: 1,
      maxBufferLines: 5,
    });
    const now = Date.now();
    setMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY, String(now - MINUTE_MS));
    writeBuffer(10);
    // Ten transient failures — uncapped doubling would be days, the 30min
    // cap keeps 31min elapsed enough to resume.
    seedFailureState(10, now - 31 * MINUTE_MS);

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
  });

  test("a single billing failure already waits the 1-hour base", () => {
    const config = buildConfig({
      v2Enabled: true,
      intervalHours: 1,
      maxBufferLines: 5,
    });
    const now = Date.now();
    setMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY, String(now - MINUTE_MS));
    writeBuffer(10);
    // 30min elapsed — a transient failure would have resumed at 5min, but a
    // billing failure holds for the full hour.
    seedFailureState(1, now - 30 * MINUTE_MS, "billing");

    maybeEnqueueGraphMaintenanceJobs(config, now);
    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);

    // 61min elapsed → the 1h window is over.
    seedFailureState(1, now - 61 * MINUTE_MS, "billing");
    maybeEnqueueGraphMaintenanceJobs(config, now);
    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
  });

  test("a corrupt failure-state payload does not gate enqueues", () => {
    const config = buildConfig({ v2Enabled: true, intervalHours: 1 });
    const now = Date.now();
    setMemoryCheckpoint(CONSOLIDATE_CHECKPOINT_KEY, String(now - 2 * HOUR_MS));
    writeBuffer(15);
    setMemoryCheckpoint(CONSOLIDATION_FAILURE_CHECKPOINT_KEY, "not-json");

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
  });
});

describe("consolidationFailureBackoffMs", () => {
  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;

  test("transient: doubles from a 5-minute base per consecutive failure", () => {
    expect(consolidationFailureBackoffMs("transient", 1, HOUR_MS)).toBe(
      5 * MINUTE_MS,
    );
    expect(consolidationFailureBackoffMs("transient", 2, HOUR_MS)).toBe(
      10 * MINUTE_MS,
    );
    expect(consolidationFailureBackoffMs("transient", 3, HOUR_MS)).toBe(
      20 * MINUTE_MS,
    );
  });

  test("transient: caps at 30 minutes regardless of the configured interval", () => {
    expect(consolidationFailureBackoffMs("transient", 4, HOUR_MS)).toBe(
      30 * MINUTE_MS,
    );
    expect(consolidationFailureBackoffMs("transient", 1000, 12 * HOUR_MS)).toBe(
      30 * MINUTE_MS,
    );
  });

  test("billing: doubles from a 1-hour base per consecutive failure", () => {
    expect(consolidationFailureBackoffMs("billing", 1, HOUR_MS)).toBe(HOUR_MS);
    expect(consolidationFailureBackoffMs("billing", 2, HOUR_MS)).toBe(
      2 * HOUR_MS,
    );
    expect(consolidationFailureBackoffMs("billing", 3, HOUR_MS)).toBe(
      4 * HOUR_MS,
    );
  });

  test("billing: caps at 6 hours for a shorter configured interval", () => {
    expect(consolidationFailureBackoffMs("billing", 4, HOUR_MS)).toBe(
      6 * HOUR_MS,
    );
    expect(consolidationFailureBackoffMs("billing", 1000, HOUR_MS)).toBe(
      6 * HOUR_MS,
    );
  });

  test("billing: cap rises to the configured interval when it exceeds 6 hours", () => {
    expect(consolidationFailureBackoffMs("billing", 10, 12 * HOUR_MS)).toBe(
      12 * HOUR_MS,
    );
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
