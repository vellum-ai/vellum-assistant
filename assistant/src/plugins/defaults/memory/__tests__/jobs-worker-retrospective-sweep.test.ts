/**
 * Tests for `maybeEnqueueRetrospectiveSweepJob` — the scheduler entry that
 * enqueues the timer-driven `memory_retrospective_sweep` backstop on a durable
 * checkpoint cadence.
 *
 * The first-run seed (missing checkpoint → seed to now WITHOUT enqueuing) is the
 * critical invariant: a `?? "0"` fallback would treat the sweep as overdue on
 * the first worker tick and enqueue retrospective LLM work the moment the daemon
 * starts. The seed defers the first sweep by one full interval instead.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

import { createMockLoggerModule } from "../../../../__tests__/helpers/mock-logger.js";

mock.module("../../../../util/logger.js", () => createMockLoggerModule());

import { applyNestedDefaults } from "../../../../config/loader.js";
import type { AssistantConfig } from "../../../../config/types.js";
import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../../../../persistence/checkpoints.js";
import { getMemoryDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { enqueueMemoryJob } from "../../../../persistence/jobs-store.js";
import { resetTestTables } from "../../../../persistence/raw-query.js";
import { memoryJobs } from "../../../../persistence/schema/index.js";
import {
  maybeEnqueueRetrospectiveSweepJob,
  RETROSPECTIVE_SWEEP_CHECKPOINT,
} from "../jobs-worker.js";

await initializeDb();
// Pin the memory connection now that the per-process workspace is migrated.
getMemoryDb();

const SWEEP_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8h default

function buildConfig(
  overrides: { memoryEnabled?: boolean } = {},
): AssistantConfig {
  const config = applyNestedDefaults({}) as unknown as AssistantConfig;
  if (overrides.memoryEnabled !== undefined) {
    config.memory.enabled = overrides.memoryEnabled;
  }
  return config;
}

function countSweepJobs(): number {
  return getMemoryDb()!
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, "memory_retrospective_sweep"))
    .all().length;
}

/** A checkpoint value older than the sweep interval, so the sweep is due. */
function staleCheckpoint(nowMs: number): string {
  return String(nowMs - SWEEP_INTERVAL_MS - 60_000);
}

beforeEach(() => {
  getMemoryDb()!.run("DELETE FROM memory_jobs");
  resetTestTables("memory_checkpoints");
});

describe("maybeEnqueueRetrospectiveSweepJob", () => {
  test("first tick with no checkpoint: seeds to now WITHOUT enqueuing", () => {
    const now = Date.now();

    const enqueued = maybeEnqueueRetrospectiveSweepJob(buildConfig(), now);

    expect(enqueued).toBe(false);
    expect(countSweepJobs()).toBe(0);
    expect(getMemoryCheckpoint(RETROSPECTIVE_SWEEP_CHECKPOINT)).toBe(
      String(now),
    );
  });

  test("enqueues once the interval has elapsed and advances the checkpoint", () => {
    const now = Date.now();
    setMemoryCheckpoint(RETROSPECTIVE_SWEEP_CHECKPOINT, staleCheckpoint(now));

    const enqueued = maybeEnqueueRetrospectiveSweepJob(buildConfig(), now);

    expect(enqueued).toBe(true);
    expect(countSweepJobs()).toBe(1);
    expect(getMemoryCheckpoint(RETROSPECTIVE_SWEEP_CHECKPOINT)).toBe(
      String(now),
    );
  });

  test("does not enqueue before the interval has elapsed", () => {
    const now = Date.now();
    setMemoryCheckpoint(
      RETROSPECTIVE_SWEEP_CHECKPOINT,
      String(now - SWEEP_INTERVAL_MS / 2),
    );

    const enqueued = maybeEnqueueRetrospectiveSweepJob(buildConfig(), now);

    expect(enqueued).toBe(false);
    expect(countSweepJobs()).toBe(0);
  });

  test("does not enqueue when memory is disabled", () => {
    const now = Date.now();
    setMemoryCheckpoint(RETROSPECTIVE_SWEEP_CHECKPOINT, staleCheckpoint(now));

    const enqueued = maybeEnqueueRetrospectiveSweepJob(
      buildConfig({ memoryEnabled: false }),
      now,
    );

    expect(enqueued).toBe(false);
    expect(countSweepJobs()).toBe(0);
  });

  test("does not stack a second sweep while one is still in flight, but advances the checkpoint", () => {
    const now = Date.now();
    // A prior sweep is already pending.
    enqueueMemoryJob("memory_retrospective_sweep", {});
    setMemoryCheckpoint(RETROSPECTIVE_SWEEP_CHECKPOINT, staleCheckpoint(now));

    const enqueued = maybeEnqueueRetrospectiveSweepJob(buildConfig(), now);

    expect(enqueued).toBe(false);
    expect(countSweepJobs()).toBe(1); // no second copy
    expect(getMemoryCheckpoint(RETROSPECTIVE_SWEEP_CHECKPOINT)).toBe(
      String(now),
    );
  });
});
