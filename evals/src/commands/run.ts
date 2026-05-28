/** `evals run` — Cartesian profile × test runner. */
import { randomBytes } from "crypto";
import { join } from "node:path";

import type { Command } from "commander";

import {
  runEvalOnce,
  wasErrorReportedToProgress,
} from "../lib/runner/run-once";
import {
  createConsoleReporter,
  createSummaryOnlyReporter,
  type EvalProgressReporter,
} from "../lib/runner/progress";
import {
  abandonAllRunningRunsSync,
  scavengeAbandonedRuns,
} from "../lib/metrics";
import {
  loadLongMemEvalV2,
  type Tier,
  TIERS,
} from "../../benchmarks/longmemeval-v2/src/loader";
import { loadTrajectories } from "../../benchmarks/longmemeval-v2/src/trajectories";
import { runLongMemEvalV2Unit } from "../../benchmarks/longmemeval-v2/src/runner";
import { type Benchmark, loadBenchmark } from "../lib/benchmark";
import {
  DEFAULT_BENCHMARK_ID,
  getBenchmarksDir,
  listBenchmarkUnitIds,
} from "../lib/catalog";
import { loadProfile, type Profile } from "../lib/profile";
import { loadTestDef } from "../lib/test-def";
import { openInBrowser, startReportServer } from "./server";

/**
 * The LongMemEval-V2 benchmark id. Hard-coded here because `run.ts`
 * dispatches per-benchmark by id — not by a manifest field — to keep
 * each benchmark's execution shape owned by the benchmark module
 * itself. Adding a third benchmark means: import its runner, add a
 * branch below, update the assertion below.
 */
const LONGMEMEVAL_V2_BENCHMARK_ID = "longmemeval-v2";

/**
 * Exit codes for the signals we handle. POSIX convention: 128 + signal
 * number (SIGINT=2 → 130, SIGTERM=15 → 143) so wrapping shells can
 * distinguish a signal-killed `evals run` from a normal failure exit.
 */
const SIGNAL_EXIT_CODES: Record<"SIGINT" | "SIGTERM", number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Run ID suffix used to disambiguate concurrent evals invocations.
 *
 * Format: `YYYYMMDDhhmmssSSS-XXXX` (17-digit ms-precision timestamp + 4
 * hex chars of randomness). The ms precision + ~65k random variants
 * give effectively-zero collisions across parallel `evals run`
 * invocations, which is what lets the Vellum adapter's catch-path
 * teardown safely operate only on its own docker resources.
 */
function timestampSuffix(): string {
  const ms = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 17);
  const rand = randomBytes(2).toString("hex");
  return `${ms}-${rand}`;
}

function slugifyLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length > 0 ? slug : "";
}

function sessionId(label: string | undefined, timestamp: string): string {
  const slug = label ? slugifyLabel(label) : "";
  return slug ? `session-${timestamp}-${slug}` : `session-${timestamp}`;
}

function runId(profileId: string, testId: string, timestamp: string): string {
  return `eval-${profileId}-${testId}-${timestamp}`;
}

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Run profile × benchmark-unit combinations")
    .requiredOption(
      "--profiles <ids>",
      "Comma-separated profile ids (each maps to profiles/<id>/manifest.json)",
    )
    .option(
      "--benchmark <id>",
      `Benchmark id under benchmarks/ (defaults to ${DEFAULT_BENCHMARK_ID})`,
      DEFAULT_BENCHMARK_ID,
    )
    .option(
      "--filter <ids>",
      "Comma-separated unit ids to run within the benchmark. Omit to run every unit.",
    )
    .option(
      "--tests <ids>",
      "[DEPRECATED] Alias for --filter. Use --benchmark <id> --filter <ids> instead.",
    )
    .option(
      "--label <label>",
      "Human-readable tag stamped onto every (profile, unit) execution in this run, so they cluster together in the report server",
    )
    .option("--max-turns <n>", "Maximum simulator turns per run", (value) =>
      Number(value),
    )
    .option(
      "--quiet",
      "Suppress per-step progress (still surfaces the final result and any errors)",
    )
    .option(
      "--serve",
      "After the run finishes, start the local report server and open this run's session in the default browser. The server blocks until ctrl-C.",
    )
    .action(
      async (opts: {
        profiles: string;
        benchmark: string;
        filter?: string;
        tests?: string;
        label?: string;
        maxTurns?: number;
        quiet?: boolean;
        serve?: boolean;
      }) => {
        // Register signal handlers ONCE per `evals run` invocation (not
        // once per (profile, test) iteration — that would leak listeners
        // and trigger MaxListenersExceededWarning past ~10 runs). On
        // SIGINT/SIGTERM, synchronously flip every `running` run on disk
        // to `abandoned` so they don't dangle, then exit with the POSIX
        // 128+signal convention so wrapping shells see a real exit code.
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
          process.once(signal, () => {
            abandonAllRunningRunsSync({ signal });
            process.exit(SIGNAL_EXIT_CODES[signal]);
          });
        }

        // Before starting a new run, clean up any stale runs that crashed
        // or were killed without properly finalizing their status. This is
        // the async variant — uses the 60s heartbeat threshold, so it only
        // flips genuinely dead runs (not in-flight ones from a parallel
        // `evals run` against the same .runs/ directory).
        await scavengeAbandonedRuns();

        // Note: we no longer pre-sweep docker resources from prior eval
        // runs. The previous orphan-cleanup pass existed to free up the
        // gateway's host port (e.g. 20100) when an earlier hatch crashed
        // mid-flight. That's now obsolete because `hatchDocker` discovers
        // an open port at hatch time via `findOpenPort()` (see
        // `cli/src/lib/port-allocator.ts`), so a stuck previous container
        // can no longer wedge the next hatch. Dead docker resources from
        // crashed runs are now garbage to be reaped on demand (e.g. via
        // `docker container prune` / `docker volume prune`) rather than
        // a prerequisite for forward progress.

        // `--tests` is the legacy spelling of `--filter`. Treat it as an
        // alias against the benchmark's units, but reject the ambiguous
        // case where both are supplied with different values — we don't
        // want to silently pick one.
        let filter = opts.filter;
        if (opts.tests !== undefined) {
          console.warn(
            "[evals] --tests is deprecated; use --benchmark <id> --filter <ids>.",
          );
          if (filter !== undefined && filter !== opts.tests) {
            throw new Error(
              "Pass either --filter or the deprecated --tests, not both.",
            );
          }
          filter = filter ?? opts.tests;
        }

        const profiles = await Promise.all(
          splitCsv(opts.profiles).map((id) => loadProfile(id)),
        );
        if (profiles.length === 0)
          throw new Error("--profiles is empty after splitting on commas");

        const benchmark = await loadBenchmark(opts.benchmark);
        const filterIds = filter !== undefined ? splitCsv(filter) : [];

        // `--quiet` still lets the per-run `result` summary and any
        // `status: "error"` events through so operators get one line per
        // run telling them what happened. Without the filter, a silent
        // failure could hide behind `--quiet` with no signal on stdout
        // or stderr.
        const progress = opts.quiet
          ? createSummaryOnlyReporter()
          : createConsoleReporter();

        // Stamp every execution in this invocation with the same session id
        // so the report server can render them as a single grouped run.
        const sessionTimestamp = timestampSuffix();
        const session = sessionId(opts.label, sessionTimestamp);
        const sessionLabel = opts.label;

        // Dispatch by `benchmark.id` (not by a manifest "driver" enum) so
        // each benchmark module owns its own execution shape. PI runs a
        // simulator-driven Cartesian over `TestDef`s; V2 runs the
        // ingest→ask two-conversation flow over `BenchmarkItem`s with
        // pre-staged trajectory files. Adding a benchmark means: import
        // its loader + runner here and add a branch.
        let anyFailed: boolean;
        if (benchmark.id === LONGMEMEVAL_V2_BENCHMARK_ID) {
          anyFailed = await runLongMemEvalV2Benchmark({
            benchmark,
            profiles,
            filterIds,
            filterFlag: filter,
            session,
            sessionLabel,
            progress,
          });
        } else {
          anyFailed = await runPersonalIntelligenceBenchmark({
            benchmark,
            profiles,
            filterIds,
            filterFlag: filter,
            session,
            sessionLabel,
            progress,
            maxTurns: opts.maxTurns,
          });
        }

        if (anyFailed) {
          process.exitCode = 1;
        }

        if (opts.serve) {
          // Boot the same report server as `evals server` (using its
          // default host/port) and aim the browser at THIS run's
          // session page. The server then blocks on Bun.serve until
          // ctrl-C — we want failures to be reviewable inline, so the
          // exitCode=1 above only takes effect once the user kills
          // the server.
          const { url } = startReportServer();
          const sessionUrl = `${url}/sessions/${encodeURIComponent(session)}`;
          console.log(`Evals report server listening on ${url}`);
          console.log(`Opening ${sessionUrl}`);
          openInBrowser(sessionUrl);
        }
      },
    );
}

interface DispatchContext {
  benchmark: Benchmark;
  profiles: Profile[];
  /** Parsed --filter ids, empty when --filter not supplied. */
  filterIds: string[];
  /** Original --filter string, for "you set --filter to an empty value" messaging. */
  filterFlag: string | undefined;
  session: string;
  sessionLabel: string | undefined;
  progress: EvalProgressReporter;
}

interface PersonalIntelligenceDispatchContext extends DispatchContext {
  maxTurns: number | undefined;
}

/**
 * Emit a structured progress error event for a thrown error unless the
 * underlying runner already did so. Shared by both per-benchmark
 * dispatch helpers so each benchmark's catch path looks identical to
 * what the CLI promised before the dispatch refactor.
 */
function reportRunFailure(progress: EvalProgressReporter, err: unknown): void {
  if (wasErrorReportedToProgress(err)) return;
  progress({
    step: "shutdown",
    status: "error",
    message: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Personal-Intelligence dispatch: directory-per-unit `TestDef`s →
 * simulator-driven `runEvalOnce`. This is the pre-existing harness shape;
 * extracting it into a helper keeps the dispatch logic next to its V2
 * sibling.
 */
async function runPersonalIntelligenceBenchmark(
  ctx: PersonalIntelligenceDispatchContext,
): Promise<boolean> {
  const { benchmark, profiles, filterIds, filterFlag, session, sessionLabel } =
    ctx;
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
  const tests = await Promise.all(
    unitIds.map((id) => loadTestDef(id, benchmark.unitsDir)),
  );

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
          maxTurns: ctx.maxTurns,
          progress: ctx.progress,
        });
      } catch (err) {
        // Per-test isolation: a crash in one combination (e.g. the user
        // simulator returning unparseable content) shouldn't take down
        // the rest of the suite.
        //
        // The run-once layer normally already writes status:"failed" +
        // error to the run's metadata and emits a red status:"error"
        // progress event with diagnostic details before re-throwing —
        // at which point we just flip the exit-code flag and move on.
        // `wasErrorReportedToProgress` (checked inside reportRunFailure)
        // is the explicit signal that path completed. The fallback path
        // exists for "throw bypassed run-once's inner catch" cases (e.g.
        // a future regression moves construction outside the try); emit
        // one line through the same reporter so the operator gets
        // SOMETHING — silent exit with exit-code 1 was the actual
        // diagnostic gap that motivated this guard.
        reportRunFailure(ctx.progress, err);
        anyFailed = true;
      }
    }
  }
  return anyFailed;
}

/**
 * Parse the LongMemEval-V2 tier from `EVALS_LONGMEMEVAL_TIER` (falling
 * back to `"small"`). The small tier is the publishable target; medium
 * is the long-horizon, memory-only variant. Rejected values surface
 * with the same "valid options" message as Zod-validated CLI flags
 * elsewhere so misconfiguration is loud rather than silent.
 */
function resolveLongMemEvalTier(): Tier {
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

/**
 * LongMemEval-V2 dispatch: `BenchmarkItem`s + a once-loaded trajectory
 * map → two-conversation `runLongMemEvalV2Unit`. The dataset itself is
 * never downloaded from source code — operators run the benchmark's
 * own `data/download.sh` first, and the loader+trajectories module
 * throws helpful "missing file" errors pointing at that script if the
 * data isn't on disk yet.
 *
 * Operator surface:
 *
 *   EVALS_LONGMEMEVAL_DATA_ROOT  — defaults to
 *     `benchmarks/longmemeval-v2/data` under the evals package, which
 *     is where `data/download.sh` writes by convention.
 *   EVALS_LONGMEMEVAL_TIER       — "small" (default) or "medium".
 */
async function runLongMemEvalV2Benchmark(
  ctx: DispatchContext,
): Promise<boolean> {
  const { benchmark, profiles, filterIds, filterFlag, session, sessionLabel } =
    ctx;
  const dataRoot =
    process.env["EVALS_LONGMEMEVAL_DATA_ROOT"] ??
    join(getBenchmarksDir(), benchmark.id, "data");
  const tier = resolveLongMemEvalTier();

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
          progress: ctx.progress,
        });
      } catch (err) {
        reportRunFailure(ctx.progress, err);
        anyFailed = true;
      }
    }
  }
  return anyFailed;
}
