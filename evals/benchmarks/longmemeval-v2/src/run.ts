/**
 * LongMemEval-V2 benchmark — top-level execution.
 *
 * The dataset itself is never downloaded from source code — operators
 * run the benchmark's own `data/download.ts` first, and the loader +
 * trajectories module throw helpful "missing file" errors pointing at
 * that script if the data isn't on disk yet.
 *
 * Operator surface (env vars):
 *
 *   EVALS_LONGMEMEVAL_DATA_ROOT — defaults to
 *     `benchmarks/longmemeval-v2/data` under the evals package, which
 *     is where `data/download.ts` writes by convention.
 *   EVALS_LONGMEMEVAL_TIER      — "small" (default) or "medium".
 *
 * Composed pieces:
 *   - `loadLongMemEvalV2`      — `BenchmarkItem`s with `eval_function`
 *   - `openTrajectories`       — indexed positional reader over
 *                                `trajectories.jsonl`, opened once per
 *                                run and closed in a `finally`
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
import { openTrajectories } from "./trajectory-reader";

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
  const {
    profiles,
    filterIds,
    filterFlag,
    session,
    sessionLabel,
    cliArgv,
    progress,
  } = input;

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
        "Confirm `bun run data/download.ts` has run and the haystack mapping is non-empty.",
    );
  }

  // Open an indexed/positional handle over `trajectories.jsonl`
  // ONCE per `evals run` invocation. First open after a fresh
  // `data/download.ts` builds a sibling `trajectories.index.json`;
  // subsequent invocations reuse it as long as the file's size +
  // mtime are unchanged. See `trajectory-reader.ts` for the full
  // index format + invalidation rules.
  const trajectoryReader = await openTrajectories(dataRoot);

  let anyFailed = false;
  try {
    for (const profile of profiles) {
      for (const item of selected) {
        const id = runId(profile.id, item.questionId, timestampSuffix());
        try {
          await runLongMemEvalV2Unit({
            profile,
            item,
            trajectoryReader,
            runId: id,
            sessionId: session,
            sessionLabel,
            cliArgv,
            progress,
          });
        } catch (err) {
          reportRunFailure(progress, err);
          anyFailed = true;
        }
      }
    }
  } finally {
    // Always release the underlying file handle, even if the loop
    // bailed early on an unexpected throw. `close` is idempotent.
    await trajectoryReader.close();
  }
  return { anyFailed };
}
