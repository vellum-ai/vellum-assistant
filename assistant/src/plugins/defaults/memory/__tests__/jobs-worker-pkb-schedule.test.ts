/**
 * Tests for the PKB filing/compaction entries in
 * `maybeEnqueueGraphMaintenanceJobs`.
 *
 * The PKB jobs are v1-only (under memory v2 the consolidation job owns
 * periodic background memory processing) and follow the same durable-checkpoint
 * pattern as the graph entries, with four PKB-specific gates:
 *   - no checkpoint yet (fresh workspace / first tick after an upgrade) →
 *     seed it to now WITHOUT enqueuing, so the first run lands a full
 *     interval later instead of an LLM job firing at boot;
 *   - outside the configured active-hours window → skip AND advance the
 *     checkpoint (next attempt a full interval later);
 *   - filing with an empty `pkb/buffer.md` → skip and advance (no LLM run);
 *   - either PKB job already pending/running → skip WITHOUT advancing, so the
 *     next worker tick retries (filing and compaction both rewrite the PKB
 *     tree, so at most one is ever queued).
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
  tmpWorkspace = mkdtempSync(join(tmpdir(), "pkb-schedule-test-"));
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
const { getMemoryCheckpoint, setMemoryCheckpoint } =
  await import("../../../../persistence/checkpoints.js");
const { enqueueMemoryJob } =
  await import("../../../../persistence/jobs-store.js");
const { GRAPH_MAINTENANCE_CHECKPOINTS, maybeEnqueueGraphMaintenanceJobs } =
  await import("../../../../persistence/jobs-worker.js");
const { registerMemoryPersistenceHooks } =
  await import("../persistence-lifecycle-seam.js");
const { memoryPersistenceHooks } = await import("../persistence-hooks.js");

// The scheduler reads the PKB buffer state through the persistence seam;
// register the real memory implementation so `hasPkbBufferContent` reflects
// the buffer files these tests write.
registerMemoryPersistenceHooks(memoryPersistenceHooks);

const FILING_KEY = GRAPH_MAINTENANCE_CHECKPOINTS.pkbFiling;
const COMPACTION_KEY = GRAPH_MAINTENANCE_CHECKPOINTS.pkbCompaction;

/** A checkpoint value far older than any PKB interval, so the job is due. */
function staleCheckpoint(nowMs: number): string {
  return String(nowMs - 1000 * 60 * 60 * 1000);
}

function buildConfig(overrides: {
  v2Enabled?: boolean;
  filingEnabled?: boolean;
  compactionEnabled?: boolean;
  activeHoursStart?: number | null;
  activeHoursEnd?: number | null;
}) {
  const partial = applyNestedDefaults({});
  if (overrides.v2Enabled !== undefined) {
    partial.memory.v2.enabled = overrides.v2Enabled;
  }
  if (overrides.filingEnabled !== undefined) {
    partial.filing.enabled = overrides.filingEnabled;
  }
  if (overrides.compactionEnabled !== undefined) {
    partial.filing.compactionEnabled = overrides.compactionEnabled;
  }
  if (overrides.activeHoursStart !== undefined) {
    partial.filing.activeHoursStart = overrides.activeHoursStart;
  }
  if (overrides.activeHoursEnd !== undefined) {
    partial.filing.activeHoursEnd = overrides.activeHoursEnd;
  }
  return partial;
}

function writePkbBuffer(content: string): void {
  const pkbDir = join(tmpWorkspace, "pkb");
  mkdirSync(pkbDir, { recursive: true });
  writeFileSync(join(pkbDir, "buffer.md"), content);
}

function removePkbBuffer(): void {
  rmSync(join(tmpWorkspace, "pkb", "buffer.md"), { force: true });
}

function countPendingJobs(type: string): number {
  return getMemoryDb()!
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, type))
    .all().length;
}

// Initialize the DB once for the file; clear per-test tables in beforeEach
// rather than tearing down the singleton, which is slow because it re-runs
// every migration on the next access.
await initializeDb();

beforeEach(() => {
  getMemoryDb()!.run("DELETE FROM memory_jobs");
  resetTestTables("memory_checkpoints");
  removePkbBuffer();
});

// ---------------------------------------------------------------------------

describe("maybeEnqueueGraphMaintenanceJobs — PKB filing/compaction", () => {
  test("first tick with no checkpoints: seeds both without enqueuing", () => {
    const config = buildConfig({ v2Enabled: false });
    writePkbBuffer("- a filable fact\n");

    const now = Date.now();
    maybeEnqueueGraphMaintenanceJobs(config, now);

    // Nothing runs at boot — the first run lands a full interval after the
    // schedule's first sighting of the job.
    expect(countPendingJobs("pkb_filing")).toBe(0);
    expect(countPendingJobs("pkb_compaction")).toBe(0);
    expect(getMemoryCheckpoint(FILING_KEY)).toBe(String(now));
    expect(getMemoryCheckpoint(COMPACTION_KEY)).toBe(String(now));
  });

  test("enqueues filing and compaction on stale checkpoints when v1 is active", () => {
    const config = buildConfig({ v2Enabled: false });
    writePkbBuffer("- a filable fact\n");

    const now = Date.now();
    setMemoryCheckpoint(FILING_KEY, staleCheckpoint(now));
    setMemoryCheckpoint(COMPACTION_KEY, staleCheckpoint(now));
    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("pkb_filing")).toBe(1);
    // Compaction is skipped this tick — filing was just enqueued and both
    // jobs rewrite the PKB tree, so the exclusion gate defers it. Its
    // checkpoint is untouched, so the next tick picks it up.
    expect(countPendingJobs("pkb_compaction")).toBe(0);
    expect(getMemoryCheckpoint(FILING_KEY)).toBe(String(now));
    expect(getMemoryCheckpoint(COMPACTION_KEY)).toBe(staleCheckpoint(now));
  });

  test("does not enqueue PKB jobs when memory v2 is active", () => {
    const config = buildConfig({ v2Enabled: true });
    writePkbBuffer("- a filable fact\n");

    const now = Date.now();
    setMemoryCheckpoint(FILING_KEY, staleCheckpoint(now));
    setMemoryCheckpoint(COMPACTION_KEY, staleCheckpoint(now));
    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("pkb_filing")).toBe(0);
    expect(countPendingJobs("pkb_compaction")).toBe(0);
  });

  test("does not enqueue before the interval has elapsed", () => {
    const config = buildConfig({ v2Enabled: false });
    writePkbBuffer("- a filable fact\n");

    const now = Date.now();
    // Default filing interval is 4h; stamp the checkpoint one minute ago.
    setMemoryCheckpoint(FILING_KEY, String(now - 60_000));
    setMemoryCheckpoint(COMPACTION_KEY, String(now - 60_000));

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("pkb_filing")).toBe(0);
    expect(countPendingJobs("pkb_compaction")).toBe(0);
  });

  test("respects the enabled flags independently", () => {
    const config = buildConfig({
      v2Enabled: false,
      filingEnabled: false,
      compactionEnabled: true,
    });
    writePkbBuffer("- a filable fact\n");

    const now = Date.now();
    setMemoryCheckpoint(FILING_KEY, staleCheckpoint(now));
    setMemoryCheckpoint(COMPACTION_KEY, staleCheckpoint(now));
    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("pkb_filing")).toBe(0);
    expect(countPendingJobs("pkb_compaction")).toBe(1);
    expect(getMemoryCheckpoint(COMPACTION_KEY)).toBe(String(now));
  });

  test("outside active hours: skips but advances the checkpoint", () => {
    const now = Date.now();
    const hour = new Date(now).getHours();
    const config = buildConfig({
      v2Enabled: false,
      // A two-hour window that does not include the current hour.
      activeHoursStart: (hour + 2) % 24,
      activeHoursEnd: (hour + 4) % 24,
    });
    writePkbBuffer("- a filable fact\n");

    setMemoryCheckpoint(FILING_KEY, staleCheckpoint(now));
    setMemoryCheckpoint(COMPACTION_KEY, staleCheckpoint(now));
    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("pkb_filing")).toBe(0);
    expect(countPendingJobs("pkb_compaction")).toBe(0);
    // Checkpoints advance so the next attempt lands a full interval later —
    // the interval cadence, not a busy-retry against a closed window.
    expect(getMemoryCheckpoint(FILING_KEY)).toBe(String(now));
    expect(getMemoryCheckpoint(COMPACTION_KEY)).toBe(String(now));
  });

  test("filing with an empty buffer: skips but advances the checkpoint", () => {
    const config = buildConfig({ v2Enabled: false, compactionEnabled: false });
    // Comment-only buffer counts as empty (`_`-prefixed lines are the
    // comment convention stripCommentLines removes).
    writePkbBuffer("_ nothing filable here\n\n");

    const now = Date.now();
    setMemoryCheckpoint(FILING_KEY, staleCheckpoint(now));
    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("pkb_filing")).toBe(0);
    expect(getMemoryCheckpoint(FILING_KEY)).toBe(String(now));
  });

  test("an active PKB job defers both types without advancing checkpoints", () => {
    const config = buildConfig({ v2Enabled: false });
    writePkbBuffer("- a filable fact\n");
    enqueueMemoryJob("pkb_compaction", {});

    const now = Date.now();
    setMemoryCheckpoint(FILING_KEY, staleCheckpoint(now));
    setMemoryCheckpoint(COMPACTION_KEY, staleCheckpoint(now));
    maybeEnqueueGraphMaintenanceJobs(config, now);

    // Nothing new enqueued while the pending compaction holds the PKB tree.
    expect(countPendingJobs("pkb_filing")).toBe(0);
    expect(countPendingJobs("pkb_compaction")).toBe(1);
    // Checkpoints untouched — the next worker tick retries.
    expect(getMemoryCheckpoint(FILING_KEY)).toBe(staleCheckpoint(now));
    expect(getMemoryCheckpoint(COMPACTION_KEY)).toBe(staleCheckpoint(now));
  });
});
