/** `evals run` — Cartesian profile × test runner. */
import { randomBytes } from "crypto";

import type { Command } from "commander";

import {
  createConsoleReporter,
  createSummaryOnlyReporter,
} from "../lib/runner/progress";
import {
  abandonAllRunningRunsSync,
  scavengeAbandonedRuns,
} from "../lib/metrics";
import { reapAbandonedEvalContainers } from "../lib/adapters/docker-reaper";
import { loadBenchmark } from "../lib/benchmark";
import { DEFAULT_BENCHMARK_ID } from "../lib/catalog";
import { loadProfile } from "../lib/profile";
import { openInBrowser, startReportServer } from "./server";

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
 * Session-id suffix used to disambiguate concurrent evals invocations.
 *
 * Format: `YYYYMMDDhhmmssSSS-XXXX` (17-digit ms-precision timestamp + 4
 * hex chars of randomness). The per-(profile, unit) run id stamping
 * happens inside each benchmark's `run()` module — we only need the
 * session-level suffix here so every execution in this invocation
 * clusters under the same session in the report server.
 */
function sessionTimestampSuffix(): string {
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

        // Container-side companion to the scavenger. `hatchDocker`
        // dynamically allocates the *gateway* host port via
        // `findOpenPort`, but the **assistant** container in
        // `statefulset.ts` binds the daemon's fixed host port (7821)
        // directly. A run that died via SIGKILL/OOM/host-reboot before
        // reaching `agent.shutdown` leaves its assistant container
        // alive on 7821, which then fails every subsequent hatch with
        // "Bind for 0.0.0.0:7821 failed: port is already allocated".
        // The reaper sweeps any `eval-*` container whose owning run is
        // terminal, missing, or `running` with a stale heartbeat.
        // Concurrent runs against the same `.runs/` directory stay
        // safe (live heartbeats preserve their containers).
        const reapResult = await reapAbandonedEvalContainers();
        if (reapResult.reaped.length > 0) {
          console.log(
            `[reaper] removed ${reapResult.reaped.length} abandoned eval container(s): ${reapResult.reaped.join(", ")}`,
          );
        }
        if (reapResult.unparseable.length > 0) {
          console.warn(
            `[reaper] saw ${reapResult.unparseable.length} eval-prefixed container(s) with unrecognized name shape: ${reapResult.unparseable.join(", ")}`,
          );
        }

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
        const sessionTimestamp = sessionTimestampSuffix();
        const session = sessionId(opts.label, sessionTimestamp);
        const sessionLabel = opts.label;

        // Snapshot argv at the top of the action handler — Commander
        // doesn't mutate `process.argv` but a downstream library or a
        // signal handler conceivably could, and we want every run in
        // the session to record the same canonical command. `slice()`
        // detaches us from any later in-place edits.
        const cliArgv = process.argv.slice();

        // Polymorphic dispatch — each benchmark's `src/run.ts` owns
        // its own execution shape (Cartesian profile × `TestDef`,
        // ingest→ask over `BenchmarkItem`, …). The CLI just hands
        // it the shared input shape; no `if (id === …)` ladder, no
        // manifest "driver" enum.
        const { anyFailed } = await benchmark.run({
          profiles,
          filterIds,
          filterFlag: filter,
          session,
          sessionLabel,
          cliArgv,
          progress,
          maxTurns: opts.maxTurns,
        });

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
