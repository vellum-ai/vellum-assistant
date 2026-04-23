/**
 * Tests for the in-memory migration job registry.
 *
 * Covered:
 * - Happy path: start -> poll pending -> poll running -> poll complete with result.
 * - Failure path: runner throws -> job ends in `failed` with mapped error.
 * - `kFetchBodyError` path: tagged thrown object maps to `fetch_failed` with
 *   optional `upstreamStatus` preserved.
 * - Concurrent limit: second export while one is pending/running rejects with
 *   `JobAlreadyInProgressError`; a job of the other type is allowed alongside.
 * - TTL sweep: completed job older than the TTL is evicted; job that is not
 *   yet past TTL is retained.
 */

import { describe, expect, test } from "bun:test";

import {
  JobAlreadyInProgressError,
  type MigrationJob,
  MigrationJobRegistry,
} from "../job-registry.js";

const kFetchBodyError = Symbol.for("vellum.migrationImport.fetchBodyError");

/** Spin the microtask queue N times so `queueMicrotask`-scheduled work runs. */
async function flushMicrotasks(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

describe("MigrationJobRegistry", () => {
  test("happy path: pending -> running -> complete with result", async () => {
    const registry = new MigrationJobRegistry();

    let release: (value: string) => void = () => {};
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });

    const job = registry.startJob("export", async (): Promise<string> => {
      return await gate;
    });

    // Returned synchronously in pending state.
    expect(job.status).toBe("pending");
    expect(job.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(job.type).toBe("export");
    expect(job.createdAt).toBeGreaterThan(0);
    expect(job.startedAt).toBeUndefined();
    expect(job.completedAt).toBeUndefined();

    // Let the microtask run -> status flips to running with `startedAt` set.
    await flushMicrotasks();
    const running = registry.getJob(job.id);
    expect(running).not.toBeNull();
    expect(running!.status).toBe("running");
    expect(running!.startedAt).toBeGreaterThanOrEqual(running!.createdAt);

    // Resolve the runner and let it settle.
    release("the-result");
    await flushMicrotasks();

    const done = registry.getJob(job.id);
    expect(done).not.toBeNull();
    expect(done!.status).toBe("complete");
    expect(done!.result).toBe("the-result");
    expect(done!.completedAt).toBeGreaterThanOrEqual(done!.startedAt ?? 0);
    expect(done!.error).toBeUndefined();

    // `listJobs` sees it too.
    expect(registry.listJobs().map((j) => j.id)).toContain(job.id);
  });

  test("failure path: runner throws -> failed with mapped error", async () => {
    const registry = new MigrationJobRegistry();
    const job = registry.startJob("export", async () => {
      throw new Error("boom");
    });

    await flushMicrotasks();

    const done = registry.getJob(job.id);
    expect(done).not.toBeNull();
    expect(done!.status).toBe("failed");
    expect(done!.error).toEqual({ code: "unknown", message: "boom" });
    expect(done!.result).toBeUndefined();
    expect(done!.completedAt).toBeGreaterThanOrEqual(done!.startedAt ?? 0);
  });

  test("runner-provided `code` overrides the default `unknown`", async () => {
    const registry = new MigrationJobRegistry();
    const job = registry.startJob("import", async () => {
      const err = new Error("invalid manifest") as Error & { code: string };
      err.code = "invalid_manifest";
      throw err;
    });

    await flushMicrotasks();

    const done = registry.getJob(job.id);
    expect(done!.status).toBe("failed");
    expect(done!.error).toEqual({
      code: "invalid_manifest",
      message: "invalid manifest",
    });
  });

  test("kFetchBodyError path: tagged error maps to `fetch_failed`", async () => {
    const registry = new MigrationJobRegistry();
    const job = registry.startJob("import", async () => {
      const err = new Error("upstream hung up") as Error & {
        upstreamStatus?: number;
      };
      (err as unknown as Record<symbol, boolean>)[kFetchBodyError] = true;
      err.upstreamStatus = 502;
      throw err;
    });

    await flushMicrotasks();

    const done = registry.getJob(job.id);
    expect(done).not.toBeNull();
    expect(done!.status).toBe("failed");
    expect(done!.error).toEqual({
      code: "fetch_failed",
      message: "upstream hung up",
      upstreamStatus: 502,
    });
  });

  test("kFetchBodyError without upstreamStatus omits the field", async () => {
    const registry = new MigrationJobRegistry();
    const job = registry.startJob("import", async () => {
      const err = new Error("aborted") as Error;
      (err as unknown as Record<symbol, boolean>)[kFetchBodyError] = true;
      throw err;
    });

    await flushMicrotasks();

    const done = registry.getJob(job.id)!;
    expect(done.status).toBe("failed");
    expect(done.error).toEqual({
      code: "fetch_failed",
      message: "aborted",
    });
    expect(done.error?.upstreamStatus).toBeUndefined();
  });

  test("concurrent limit: second same-type job rejects; other type is allowed", async () => {
    const registry = new MigrationJobRegistry();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // First export is pending (microtask hasn't run yet) — second export
    // immediately rejects on the still-pending first job.
    const first = registry.startJob("export", async () => {
      await gate;
    });
    expect(first.status).toBe("pending");

    expect(() => registry.startJob("export", async () => {})).toThrow(
      JobAlreadyInProgressError,
    );

    // Advance to running — a same-type attempt still rejects.
    await flushMicrotasks();
    expect(registry.getJob(first.id)!.status).toBe("running");

    let caught: unknown = null;
    try {
      registry.startJob("export", async () => {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JobAlreadyInProgressError);
    expect((caught as JobAlreadyInProgressError).existingJobId).toBe(first.id);

    // A job of the *other* type is allowed in parallel.
    const importJob = registry.startJob("import", async () => "ok");
    expect(importJob.type).toBe("import");
    expect(importJob.id).not.toBe(first.id);

    // Settle both before leaving the test so no promises leak.
    release();
    await flushMicrotasks();
    expect(registry.getJob(first.id)!.status).toBe("complete");
    expect(registry.getJob(importJob.id)!.status).toBe("complete");

    // And now a new export is allowed since nothing is in flight.
    const third = registry.startJob("export", async () => "again");
    expect(third.status).toBe("pending");
    await flushMicrotasks();
    expect(registry.getJob(third.id)!.status).toBe("complete");
  });

  test("returned job snapshots are decoupled from internal registry state", async () => {
    const registry = new MigrationJobRegistry();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = registry.startJob("export", async () => {
      await gate;
    });

    // The synchronous return of startJob must be a snapshot, not the
    // internal record. Mutating it (e.g. to simulate a caller stomping on
    // `status`) must not unblock the single-in-flight invariant while the
    // runner is still active.
    first.status = "complete";
    first.completedAt = Date.now();

    await flushMicrotasks();
    // Internal state is still running — the snapshot mutation did not leak.
    expect(registry.getJob(first.id)!.status).toBe("running");

    // Attempting a second same-type job must still reject.
    expect(() => registry.startJob("export", async () => {})).toThrow(
      JobAlreadyInProgressError,
    );

    // getJob snapshots are also decoupled: mutating the return value of
    // getJob does not leak into listJobs or subsequent getJob calls.
    const polled = registry.getJob(first.id)!;
    polled.status = "failed";
    expect(registry.getJob(first.id)!.status).toBe("running");
    expect(registry.listJobs().find((j) => j.id === first.id)!.status).toBe(
      "running",
    );

    // Settle.
    release();
    await flushMicrotasks();
    expect(registry.getJob(first.id)!.status).toBe("complete");
  });

  test("TTL sweep: completed jobs older than TTL are evicted", async () => {
    const registry = new MigrationJobRegistry();
    registry.completedJobTtlMs = 1_000; // 1s for test purposes

    const job = registry.startJob("export", async () => "done");
    await flushMicrotasks();
    const completed = registry.getJob(job.id)!;
    expect(completed.status).toBe("complete");

    // Before TTL: sweep is a no-op.
    const originalNow = Date.now;
    try {
      Date.now = () => (completed.completedAt ?? 0) + 500;
      registry.sweep();
      expect(registry.getJob(job.id)).not.toBeNull();
      expect(registry.listJobs().map((j) => j.id)).toContain(job.id);

      // Past TTL: sweep evicts the completed job.
      Date.now = () => (completed.completedAt ?? 0) + 2_000;
      registry.sweep();
      expect(registry.getJob(job.id)).toBeNull();
      expect(registry.listJobs().map((j) => j.id)).not.toContain(job.id);
    } finally {
      Date.now = originalNow;
    }
  });

  test("TTL sweep: failed jobs are also evicted past TTL", async () => {
    const registry = new MigrationJobRegistry();
    registry.completedJobTtlMs = 500;

    const job = registry.startJob("import", async () => {
      throw new Error("nope");
    });
    await flushMicrotasks();
    const failed = registry.getJob(job.id)!;
    expect(failed.status).toBe("failed");

    const originalNow = Date.now;
    try {
      Date.now = () => (failed.completedAt ?? 0) + 10_000;
      registry.sweep();
      expect(registry.getJob(job.id)).toBeNull();
    } finally {
      Date.now = originalNow;
    }
  });

  test("TTL sweep: running jobs are never evicted", async () => {
    const registry = new MigrationJobRegistry();
    registry.completedJobTtlMs = 1;

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = registry.startJob("export", async () => {
      await gate;
    });
    await flushMicrotasks();
    expect(registry.getJob(job.id)!.status).toBe("running");

    const originalNow = Date.now;
    try {
      Date.now = () => Number.MAX_SAFE_INTEGER;
      registry.sweep();
      expect(registry.getJob(job.id)).not.toBeNull();
    } finally {
      Date.now = originalNow;
    }

    // Cleanup: let the runner resolve.
    release();
    await flushMicrotasks();
  });

  test("getJob returns null for unknown ids", () => {
    const registry = new MigrationJobRegistry();
    expect(registry.getJob("nope")).toBeNull();
  });

  test("JobAlreadyInProgressError carries the existing job id", () => {
    const err = new JobAlreadyInProgressError("export", "abc-123");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("JobAlreadyInProgressError");
    expect(err.existingJobId).toBe("abc-123");
    expect(err.message).toContain("export");
    expect(err.message).toContain("abc-123");
  });

  test("MigrationJob interface shape is preserved on success", async () => {
    const registry = new MigrationJobRegistry();
    const job = registry.startJob("export", async () => ({ bytes: 42 }));
    await flushMicrotasks();
    const done: MigrationJob = registry.getJob(job.id)!;
    expect(done.id).toBe(job.id);
    expect(done.type).toBe("export");
    expect(done.status).toBe("complete");
    expect(done.result).toEqual({ bytes: 42 });
  });
});
