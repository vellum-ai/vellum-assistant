/** `evals run` — Cartesian profile × test runner. */
import { randomBytes } from "crypto";

import type { Command } from "commander";

import { runEvalOnce } from "../lib/runner/run-once";
import {
  createConsoleReporter,
  createSummaryOnlyReporter,
} from "../lib/runner/progress";
import {
  abandonAllRunningRunsSync,
  scavengeAbandonedRuns,
} from "../lib/metrics";
import { loadProfile } from "../lib/profile";
import { loadTestDef } from "../lib/test-def";
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
    .description("Run profile × test combinations")
    .requiredOption(
      "--profiles <ids>",
      "Comma-separated profile ids (each maps to profiles/<id>/manifest.json)",
    )
    .requiredOption(
      "--tests <ids>",
      "Comma-separated test ids (each maps to tests/<id>/SPEC.md)",
    )
    .option(
      "--label <label>",
      "Human-readable tag stamped onto every (profile, test) execution in this run, so they cluster together in the report server",
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
        tests: string;
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

        const profiles = await Promise.all(
          splitCsv(opts.profiles).map((id) => loadProfile(id)),
        );
        const tests = await Promise.all(
          splitCsv(opts.tests).map((id) => loadTestDef(id)),
        );

        if (profiles.length === 0)
          throw new Error("--profiles is empty after splitting on commas");
        if (tests.length === 0)
          throw new Error("--tests is empty after splitting on commas");

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
                maxTurns: opts.maxTurns,
                progress,
              });
              // No stdout dump: the runner has already emitted the
              // `result` progress event with per-metric scores in the
              // same timestamped/labeled format as every other step.
            } catch {
              // Per-test isolation: a crash in one combination (e.g. the
              // user simulator returning unparseable content) shouldn't
              // take down the rest of the suite. The run-once layer has
              // already written status:"failed" + error to the run's
              // metadata and emitted a red `status: "error"` progress
              // event with diagnostic details, so we just flip the
              // exit-code flag and move on.
              anyFailed = true;
            }
          }
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
