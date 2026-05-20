/** `evals run` — Cartesian profile × test runner. */
import type { Command } from "commander";

import { runEvalOnce } from "../lib/runner/run-once";
import {
  createConsoleReporter,
  createSummaryOnlyReporter,
} from "../lib/runner/progress";
import { loadProfile } from "../lib/profile";
import { loadTestDef } from "../lib/test-def";
import { openInBrowser, startReportServer } from "./server";

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function timestampSuffix(): string {
  return new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
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
