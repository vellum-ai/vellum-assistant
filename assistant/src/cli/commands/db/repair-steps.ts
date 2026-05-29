/**
 * Step framework for `assistant db repair`.
 *
 * `repair` runs a sequence of discrete remediation passes. Each step is a
 * `RepairStep` with a `name`, a one-line `description`, and a `run(ctx)`
 * that returns a `StepResult`.
 *
 * The runner:
 *   - executes steps sequentially in the order supplied
 *   - continues past non-halting failures (a corrupt DB doesn't preclude
 *     re-deriving conversations from disk)
 *   - stops only when a step returns `halt: true`
 *   - never throws — uncaught errors from a step body are captured as a
 *     synthetic `error` result so a bug in one step can't crash the run
 *
 * `RepairContext` holds the per-run state every step shares — currently
 * just the DB path. Steps open their own bun:sqlite connections (read-only
 * or read-write as needed) rather than sharing a handle through the context.
 */

import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepairContext {
  /** Absolute path to the assistant SQLite database file. */
  dbPath: string;
}

export type StepResult =
  | {
      status: "ok";
      /** One-line human summary, e.g. "no corruption detected". */
      summary: string;
      /** Optional structured payload surfaced in --json mode. */
      data?: Record<string, unknown>;
      /** Optional secondary lines printed under the summary in human mode. */
      detailLines?: string[];
      /** Wall-clock duration of the step, set by the runner. */
      durationMs?: number;
    }
  | {
      status: "error";
      /** One-line human summary, e.g. "database disk image is malformed". */
      summary: string;
      data?: Record<string, unknown>;
      detailLines?: string[];
      durationMs?: number;
      /** When true, the runner stops the remaining sequence. */
      halt?: boolean;
    };

export interface RepairStep {
  /** Short identifier; appears in logs as `[i/N] <name>`. */
  name: string;
  /** Human one-liner explaining what the step does. */
  description: string;
  run: (ctx: RepairContext) => Promise<StepResult>;
}

export interface StepRun {
  name: string;
  description: string;
  result: StepResult;
}

export interface RepairReport {
  dbPath: string;
  steps: StepRun[];
  /** Convenience counters for renderers; derived from `steps`. */
  okCount: number;
  errorCount: number;
  /** True when the sequence was cut short by a `halt: true` failure. */
  halted: boolean;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunnerHooks {
  /** Called when a step is about to start. */
  onStart?: (idx: number, total: number, step: RepairStep) => void;
  /** Called when a step finishes (whether ok or error). */
  onFinish?: (
    idx: number,
    total: number,
    step: RepairStep,
    result: StepResult,
  ) => void;
}

/**
 * Run a sequence of repair steps. Never throws — all step failures land in
 * the returned `RepairReport`. Errors thrown from a step's `run` are
 * captured as a synthetic `status: "error"` result so a bug in one step
 * can't take down the whole repair.
 */
export async function runRepairSteps(
  ctx: RepairContext,
  steps: RepairStep[],
  hooks: RunnerHooks = {},
): Promise<RepairReport> {
  const runs: StepRun[] = [];
  let halted = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    hooks.onStart?.(i + 1, steps.length, step);

    const startedAt = performance.now();
    let result: StepResult;
    try {
      result = await step.run(ctx);
    } catch (err) {
      result = {
        status: "error",
        summary: err instanceof Error ? err.message : String(err),
        detailLines: ["step threw an unexpected error — this is a bug"],
      };
    }
    result.durationMs = performance.now() - startedAt;

    hooks.onFinish?.(i + 1, steps.length, step, result);
    runs.push({ name: step.name, description: step.description, result });

    if (result.status === "error" && result.halt) {
      halted = true;
      break;
    }
  }

  const okCount = runs.filter((r) => r.result.status === "ok").length;
  const errorCount = runs.filter((r) => r.result.status === "error").length;
  return { dbPath: ctx.dbPath, steps: runs, okCount, errorCount, halted };
}

// ---------------------------------------------------------------------------
// Helpers used by step implementations
// ---------------------------------------------------------------------------

/** Convenience: format a duration as `12.3s` or `450ms`. */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Open a connection inside a step, ensuring the handle is closed even when
 * the step's body throws. The callback may return any `StepResult`.
 */
export async function withDb<T>(
  open: () => Database,
  fn: (db: Database) => Promise<T> | T,
): Promise<T> {
  const db = open();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}
