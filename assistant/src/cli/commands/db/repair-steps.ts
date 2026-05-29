/**
 * Step framework for `assistant db repair`.
 *
 * `repair` is conceptually a sequence of discrete remediation passes:
 *
 *   1. integrity check       (this PR)
 *   2. conversation backfill (next PR — replay /workspace/conversations
 *      into SQLite)
 *   3. … more to come (memory consolidation, lost-and-found triage, etc.)
 *
 * Each step is a small unit that:
 *   - logs a "starting" line when it begins
 *   - produces a `StepResult` describing what happened
 *   - logs a single "success" or "error" summary line with details
 *
 * The runner is intentionally not clever:
 *   - steps run sequentially (later steps may depend on earlier ones; in
 *     particular, a step that mutates the DB needs preceding integrity-check
 *     results to be visible)
 *   - a failed step does NOT halt the sequence by default. Repair is a
 *     best-effort surface — a corrupted DB doesn't mean we should skip
 *     re-deriving conversations from disk. Steps that genuinely cannot
 *     continue on failure mark themselves `halt: true`.
 *   - the runner never throws; every error is captured into a `StepResult`
 *     so callers can render a coherent summary
 *
 * `RepairContext` holds the per-run state every step shares — the DB path
 * and any opened handles. Steps may open their own bun:sqlite connections
 * (e.g. integrity check opens read-only) rather than holding one open at
 * the context level; future write-side steps will need to open RW
 * themselves anyway.
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
