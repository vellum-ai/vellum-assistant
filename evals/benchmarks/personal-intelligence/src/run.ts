/**
 * Personal-Intelligence benchmark — top-level execution.
 *
 * Drives a Cartesian profile × `TestDef` loop through the
 * simulator-backed `runEvalOnce` runner. This is the in-house benchmark
 * the harness was originally built around; the V2 benchmark added a
 * parallel execution shape and the polymorphic `benchmark.run()` contract
 * (see `src/lib/benchmark.ts`) is what lets the CLI dispatch to either
 * without an `if (id === …)` ladder.
 */
import { randomBytes } from "node:crypto";

import type {
  Benchmark,
  BenchmarkRunInput,
  BenchmarkRunResult,
} from "../../../src/lib/benchmark";
import { listBenchmarkUnitIds } from "../../../src/lib/catalog";
import {
  runEvalOnce,
  wasErrorReportedToProgress,
} from "../../../src/lib/runner/run-once";
import type { EvalProgressReporter } from "../../../src/lib/runner/progress";
import { loadTestDef } from "../../../src/lib/test-def";

/**
 * Run ID suffix used to disambiguate concurrent evals invocations.
 *
 * Same shape and rationale as the CLI helper that wraps this module:
 * `YYYYMMDDhhmmssSSS-XXXX` (17-digit ms-precision timestamp + 4 hex
 * chars of randomness). Lives here too because the per-(profile, test)
 * id is allocated inside this loop — the alternative is to thread a
 * factory through `BenchmarkRunInput`, which is more wiring for the
 * same outcome.
 */
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

/**
 * Emit a structured progress error event for a thrown error unless the
 * underlying runner already did so. Mirrors the V2 runner's catch-path
 * helper — the two implementations should stay in sync.
 */
function reportRunFailure(progress: EvalProgressReporter, err: unknown): void {
  if (wasErrorReportedToProgress(err)) return;
  progress({
    step: "shutdown",
    status: "error",
    message: err instanceof Error ? err.message : String(err),
  });
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

  const unitIds =
    filterIds.length > 0
      ? filterIds
      : await listBenchmarkUnitIds(benchmark.unitsDir);
  if (unitIds.length === 0) {
    throw new Error(
      filterFlag !== undefined
        ? "--filter is empty after splitting on commas"
        : `Benchmark "${benchmark.id}" has no ${benchmark.manifest.unitNoun} units at ${benchmark.unitsDir}`,
    );
  }

  const loadedTests = await Promise.all(
    unitIds.map((id) => loadTestDef(id, benchmark.unitsDir)),
  );
  // Experimental units (declared via `status: experimental` in SPEC.md
  // frontmatter) are pending QA and often depend on stubbed fixtures, so
  // default unfiltered runs skip them. An explicit --filter opts in.
  const tests =
    filterIds.length > 0
      ? loadedTests
      : loadedTests.filter((test) => test.status !== "experimental");
  if (tests.length === 0) {
    throw new Error(
      `Benchmark "${benchmark.id}" has no non-experimental ${benchmark.manifest.unitNoun} units — pass --filter to run experimental units explicitly`,
    );
  }

  let anyFailed = false;
  for (const profile of profiles) {
    for (const test of tests) {
      const id = runId(profile.id, test.id, timestampSuffix());
      try {
        await runEvalOnce({
          profile,
          test,
          runId: id,
          sessionId: session,
          sessionLabel,
          cliArgv,
          maxTurns: input.maxTurns,
          progress,
        });
      } catch (err) {
        // Per-test isolation: a crash in one combination (e.g. the
        // user simulator returning unparseable content) shouldn't take
        // down the rest of the suite.
        //
        // The run-once layer normally already writes status:"failed" +
        // error to the run's metadata and emits a red status:"error"
        // progress event with diagnostic details before re-throwing —
        // at which point we just flip the exit-code flag and move on.
        // `wasErrorReportedToProgress` (checked inside
        // `reportRunFailure`) is the explicit signal that path
        // completed. The fallback path exists for "throw bypassed
        // run-once's inner catch" cases (e.g. a future regression
        // moves construction outside the try); emit one line through
        // the same reporter so the operator gets SOMETHING — silent
        // exit with exit-code 1 was the actual diagnostic gap that
        // motivated this guard.
        reportRunFailure(progress, err);
        anyFailed = true;
      }
    }
  }
  return { anyFailed };
}
