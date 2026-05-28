/**
 * LongMemEval-V2 benchmark — top-level execution.
 *
 * The dataset itself is never downloaded from source code — operators
 * run the benchmark's own `data/download.sh` first, and the loader +
 * trajectories module throw helpful "missing file" errors pointing at
 * that script if the data isn't on disk yet.
 *
 * Operator surface (env vars):
 *
 *   EVALS_LONGMEMEVAL_DATA_ROOT — defaults to
 *     `benchmarks/longmemeval-v2/data` under the evals package, which
 *     is where `data/download.sh` writes by convention.
 *   EVALS_LONGMEMEVAL_TIER      — "small" (default) or "medium".
 *
 * Composed pieces:
 *   - `loadLongMemEvalV2`      — `BenchmarkItem`s with `eval_function`
 *   - `loadTrajectories`       — id → record map, loaded once per run
 *   - `runLongMemEvalV2Unit`   — per-question two-conversation runner
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type {
  Benchmark,
  BenchmarkRunInput,
  BenchmarkRunResult,
} from "../../../src/lib/benchmark";
import { getBenchmarksDir } from "../../../src/lib/catalog";
import type { EvalProgressReporter } from "../../../src/lib/runner/progress";
import { wasErrorReportedToProgress } from "../../../src/lib/runner/run-once";

import { loadLongMemEvalV2, type Tier, TIERS } from "./loader";
import { runLongMemEvalV2Unit } from "./runner";
import { loadTrajectories } from "./trajectories";

function timestampSuffix(): string {
  const ms = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 17);
  const rand = randomBytes(2).toString("hex");
  return `${ms}-${rand}`;
}

function runId(profileId: string, testId: string, timestamp: string): string {
  return `eval-${profileId}-${testId}-${timestamp}`;
}

function reportRunFailure(progress: EvalProgressReporter, err: unknown): void {
  if (wasErrorReportedToProgress(err)) return;
  progress({
    step: "shutdown",
    status: "error",
    message: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Parse the LongMemEval-V2 tier from `EVALS_LONGMEMEVAL_TIER` (falling
 * back to `"small"`). The small tier is the publishable target;
 * medium is the long-horizon, memory-only variant. Rejected values
 * surface with the same "valid options" message as Zod-validated CLI
 * flags elsewhere so misconfiguration is loud rather than silent.
 */
function resolveTier(): Tier {
  const raw = process.env["EVALS_LONGMEMEVAL_TIER"];
  if (raw === undefined || raw === "") return "small";
  if (!(TIERS as readonly string[]).includes(raw)) {
    throw new Error(
      `EVALS_LONGMEMEVAL_TIER="${raw}" is not a valid tier. ` +
        `Pick one of: ${TIERS.join(", ")}.`,
    );
  }
  return raw as Tier;
}

export async function run(
  benchmark: Benchmark,
  input: BenchmarkRunInput,
): Promise<BenchmarkRunResult> {
  const { profiles, filterIds, filterFlag, session, sessionLabel, progress } =
    input;

  const dataRoot =
    process.env["EVALS_LONGMEMEVAL_DATA_ROOT"] ??
    join(getBenchmarksDir(), benchmark.id, "data");
  const tier = resolveTier();

  const items = await loadLongMemEvalV2({ dataRoot, tier });
  const selected =
    filterIds.length > 0
      ? items.filter((item) => filterIds.includes(item.questionId))
      : items;
  if (selected.length === 0) {
    if (filterFlag !== undefined) {
      throw new Error(
        `--filter selected zero LongMemEval-V2 items. Got ${filterIds.length} id(s); ` +
          `none matched ${items.length} loaded item(s) in tier "${tier}".`,
      );
    }
    throw new Error(
      `LongMemEval-V2 loaded zero items from ${dataRoot} at tier "${tier}". ` +
        "Confirm `bash data/download.sh` has run and the haystack mapping is non-empty.",
    );
  }

  // Load the trajectories file ONCE per `evals run` invocation rather
  // than per item. The file is ~1 GB at the small tier and re-reading
  // it per question would dominate wall-clock for any non-trivial
  // selection. Phase 2's full-451-Q run will want an indexed/streaming
  // variant (tracked in the cache PR).
  const trajectories = await loadTrajectories(dataRoot);

  let anyFailed = false;
  for (const profile of profiles) {
    for (const item of selected) {
      const id = runId(profile.id, item.questionId, timestampSuffix());
      try {
        await runLongMemEvalV2Unit({
          profile,
          item,
          trajectories,
          runId: id,
          sessionId: session,
          sessionLabel,
          progress,
        });
      } catch (err) {
        reportRunFailure(progress, err);
        anyFailed = true;
      }
    }
  }
  return { anyFailed };
}
