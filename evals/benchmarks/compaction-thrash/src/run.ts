/**
 * Compaction-thrash benchmark — top-level execution.
 *
 * Drives a Cartesian profile × scenario loop through the custom
 * tick-based runner that simulates a long-running cron conversation
 * hitting repeated compaction. Each scenario defines the tick pattern
 * and success criteria; the runner observes compaction behavior,
 * cache utilization, and cost.
 *
 * Operator surface (env vars):
 *
 *   EVALS_COMPACTION_SEED_TICKS    — number of seed ticks to send
 *                                    before observation (default: 20)
 *   EVALS_COMPACTION_OBSERVE_TICKS — number of post-threshold ticks
 *                                    to observe (default: 10)
 */
import { randomBytes } from "node:crypto";

import type {
  Benchmark,
  BenchmarkRunInput,
  BenchmarkRunResult,
} from "../../../src/lib/benchmark.js";
import { listBenchmarkUnitIds } from "../../../src/lib/catalog.js";
import type { EvalProgressReporter } from "../../../src/lib/runner/progress.js";
import { wasErrorReportedToProgress } from "../../../src/lib/runner/run-once.js";

import { runCompactionThrashScenario } from "./runner.js";

function timestampSuffix(): string {
  const ms = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 17);
  const rand = randomBytes(2).toString("hex");
  return `${ms}-${rand}`;
}

function runId(
  profileId: string,
  scenarioId: string,
  timestamp: string,
): string {
  return `eval-${profileId}-${scenarioId}-${timestamp}`;
}

function reportRunFailure(progress: EvalProgressReporter, err: unknown): void {
  if (wasErrorReportedToProgress(err)) return;
  progress({
    step: "shutdown",
    status: "error",
    message: err instanceof Error ? err.message : String(err),
  });
}

function resolveTickCount(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${envVar}="${raw}" is not a valid positive integer.`);
  }
  return parsed;
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

  const scenarioIds =
    filterIds.length > 0
      ? filterIds
      : await listBenchmarkUnitIds(benchmark.unitsDir);
  if (scenarioIds.length === 0) {
    throw new Error(
      filterFlag !== undefined
        ? "--filter is empty after splitting on commas"
        : `Benchmark "${benchmark.id}" has no ${benchmark.manifest.unitNoun} units at ${benchmark.unitsDir}`,
    );
  }

  const seedTicks = resolveTickCount("EVALS_COMPACTION_SEED_TICKS", 20);
  const observeTicks = resolveTickCount("EVALS_COMPACTION_OBSERVE_TICKS", 10);

  let anyFailed = false;
  for (const profile of profiles) {
    for (const scenarioId of scenarioIds) {
      const id = runId(profile.id, scenarioId, timestampSuffix());
      try {
        await runCompactionThrashScenario({
          profile,
          scenarioId,
          runId: id,
          sessionId: session,
          sessionLabel,
          cliArgv,
          progress,
          seedTicks,
          observeTicks,
        });
      } catch (err) {
        reportRunFailure(progress, err);
        anyFailed = true;
      }
    }
  }
  return { anyFailed };
}
