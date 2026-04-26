/**
 * In-memory registry for async migration jobs (export/import).
 *
 * Each job has a UUID, a type, a lifecycle (`pending` -> `running` ->
 * `complete`/`failed`), and optional result/error payloads. Runners are
 * scheduled with `queueMicrotask` so `startJob` returns synchronously and
 * callers can immediately poll the job record.
 *
 * At most one job of each `MigrationJobType` may be in-flight at a time;
 * attempting to start a second one while another is pending or running
 * rejects with `JobAlreadyInProgressError`.
 *
 * Completed/failed jobs are kept for `completedJobTtlMs` (default 10
 * minutes) so clients can still fetch the final status after the runner
 * finishes, then evicted by `sweep()` which is wired to a periodic
 * `setInterval` on the singleton. The interval is `unref()`'d so it does
 * not block process shutdown.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MigrationJobType = "export" | "import";

export type MigrationJobStatus = "pending" | "running" | "complete" | "failed";

export interface MigrationJobError {
  code: string;
  message: string;
  upstreamStatus?: number;
}

export interface MigrationJob {
  id: string;
  type: MigrationJobType;
  status: MigrationJobStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: MigrationJobError;
  result?: unknown;
}

/**
 * Thrown by `MigrationJobRegistry.startJob` when a job of the same type
 * is already pending or running.
 */
export class JobAlreadyInProgressError extends Error {
  public readonly existingJobId: string;

  constructor(type: MigrationJobType, existingJobId: string) {
    super(
      `A ${type} migration job is already in progress (id=${existingJobId}).`,
    );
    this.name = "JobAlreadyInProgressError";
    this.existingJobId = existingJobId;
  }
}

// ---------------------------------------------------------------------------
// kFetchBodyError — preserve the tag convention used by the URL-body import
// path in `routes/migration-routes.ts`. An error object carrying this symbol
// was thrown from a failed upstream fetch body; we translate it into
// `error.code = "fetch_failed"` for clients.
// ---------------------------------------------------------------------------

const kFetchBodyError = Symbol.for("vellum.migrationImport.fetchBodyError");

function isFetchBodyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as unknown as Record<symbol, boolean>)[kFetchBodyError] === true;
}

function extractUpstreamStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const status = (err as { upstreamStatus?: unknown }).upstreamStatus;
  return typeof status === "number" ? status : undefined;
}

function mapError(err: unknown): MigrationJobError {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "object" &&
          err !== null &&
          "message" in err &&
          typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : String(err);

  if (isFetchBodyError(err)) {
    const mapped: MigrationJobError = {
      code: "fetch_failed",
      message,
    };
    const upstreamStatus = extractUpstreamStatus(err);
    if (upstreamStatus !== undefined) {
      mapped.upstreamStatus = upstreamStatus;
    }
    return mapped;
  }

  // Runner-provided override: `err.code` wins over the `"unknown"` default
  // so callers that throw typed errors get their codes preserved.
  const overrideCode =
    typeof err === "object" &&
    err !== null &&
    typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : undefined;

  const mapped: MigrationJobError = {
    code: overrideCode ?? "unknown",
    message,
  };
  const upstreamStatus = extractUpstreamStatus(err);
  if (upstreamStatus !== undefined) {
    mapped.upstreamStatus = upstreamStatus;
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Default TTL for completed/failed jobs before `sweep()` evicts them.
 * Exposed as a class field so tests can override the singleton's value.
 */
const DEFAULT_COMPLETED_JOB_TTL_MS = 10 * 60 * 1000;

/**
 * Return a shallow clone of a `MigrationJob` that is decoupled from the
 * internal registry record. The optional `error` object is spread so
 * callers cannot mutate the stored error either. `result` is `unknown` by
 * design — callers that pass mutable values in and then mutate them
 * externally are already outside the registry's invariants.
 */
function cloneJob(job: MigrationJob): MigrationJob {
  const snapshot: MigrationJob = {
    id: job.id,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
  };
  if (job.startedAt !== undefined) snapshot.startedAt = job.startedAt;
  if (job.completedAt !== undefined) snapshot.completedAt = job.completedAt;
  if (job.error !== undefined) snapshot.error = { ...job.error };
  if (job.result !== undefined) snapshot.result = job.result;
  return snapshot;
}

export class MigrationJobRegistry {
  private readonly jobs = new Map<string, MigrationJob>();
  /** Tracks the single in-flight (pending or running) job id per type. */
  private readonly inFlight = new Map<MigrationJobType, string>();

  /** TTL for completed/failed jobs; mutable so tests can tighten it. */
  public completedJobTtlMs: number = DEFAULT_COMPLETED_JOB_TTL_MS;

  /**
   * Start a new migration job. Returns a snapshot of the `MigrationJob`
   * record synchronously (status `"pending"`); the runner is scheduled via
   * `queueMicrotask` so the caller can poll via `getJob(id)` immediately.
   *
   * The returned object is a shallow clone decoupled from the internal
   * record so that external mutation cannot violate the single-in-flight
   * invariant (e.g. flipping a running job's status to `"complete"` must
   * not unblock a same-type `startJob` while the runner is still active).
   *
   * Throws `JobAlreadyInProgressError` if another job of the same type is
   * already pending or running.
   */
  public startJob<T>(
    type: MigrationJobType,
    runner: (job: MigrationJob) => Promise<T>,
  ): MigrationJob {
    const existingId = this.inFlight.get(type);
    if (existingId !== undefined) {
      const existing = this.jobs.get(existingId);
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        throw new JobAlreadyInProgressError(type, existingId);
      }
      // Stale entry (e.g. sweep raced with a new start) — clear it.
      this.inFlight.delete(type);
    }

    const job: MigrationJob = {
      id: randomUUID(),
      type,
      status: "pending",
      createdAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.inFlight.set(type, job.id);

    queueMicrotask(() => {
      job.status = "running";
      job.startedAt = Date.now();
      Promise.resolve()
        .then(() => runner(job))
        .then(
          (result) => {
            job.status = "complete";
            job.completedAt = Date.now();
            job.result = result;
            if (this.inFlight.get(type) === job.id) {
              this.inFlight.delete(type);
            }
          },
          (err: unknown) => {
            job.status = "failed";
            job.completedAt = Date.now();
            job.error = mapError(err);
            if (this.inFlight.get(type) === job.id) {
              this.inFlight.delete(type);
            }
          },
        );
    });

    return cloneJob(job);
  }

  public getJob(id: string): MigrationJob | null {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : null;
  }

  public listJobs(): MigrationJob[] {
    return Array.from(this.jobs.values(), cloneJob);
  }

  /**
   * Drop completed/failed jobs whose `completedAt` is older than
   * `completedJobTtlMs`. Pending/running jobs are always retained.
   */
  public sweep(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.status !== "complete" && job.status !== "failed") continue;
      const completedAt = job.completedAt;
      if (completedAt === undefined) continue;
      if (now - completedAt >= this.completedJobTtlMs) {
        this.jobs.delete(id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton + sweep interval
// ---------------------------------------------------------------------------

/** Process-wide registry used by migration routes. */
export const migrationJobs = new MigrationJobRegistry();

/**
 * How often the sweep runs. The singleton wires this via `setInterval`;
 * the interval is `unref()`'d so it does not keep the event loop alive
 * during shutdown. Tests that need to stop the interval can call
 * `clearInterval(sweepIntervalId)`.
 */
const SWEEP_INTERVAL_MS = 60 * 1000;

const sweepIntervalId: NodeJS.Timeout = setInterval(() => {
  migrationJobs.sweep();
}, SWEEP_INTERVAL_MS);

// `.unref()` exists on Node/Bun Timeout objects. Guard defensively in case
// an alternative runtime returns a plain number.
if (typeof (sweepIntervalId as { unref?: () => void }).unref === "function") {
  (sweepIntervalId as { unref: () => void }).unref();
}
