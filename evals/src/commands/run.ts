/** `evals run` — Cartesian profile × test runner. */
import type { Command } from "commander";

import { runEvalOnce } from "../lib/runner/run-once";
import {
  createConsoleReporter,
  noopEvalProgressReporter,
} from "../lib/runner/progress";
import { loadProfile } from "../lib/profile";
import { loadTestDef } from "../lib/test-def";

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
      "Suppress per-step progress output (only emit the final JSON result)",
    )
    .action(
      async (opts: {
        profiles: string;
        tests: string;
        label?: string;
        maxTurns?: number;
        quiet?: boolean;
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

        const progress = opts.quiet
          ? noopEvalProgressReporter
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
              const result = await runEvalOnce({
                profile,
                test,
                runId: id,
                sessionId: session,
                sessionLabel,
                maxTurns: opts.maxTurns,
                progress,
              });
              console.log(JSON.stringify(result));
            } catch (err) {
              // Per-test isolation: a crash in one combination (e.g. the
              // user simulator returning unparseable content) shouldn't
              // take down the rest of the suite. The run-once layer has
              // already written status:"failed" + error to the run's
              // metadata; emit a matching JSON line here and keep going.
              anyFailed = true;
              const message = err instanceof Error ? err.message : String(err);
              console.log(
                JSON.stringify({
                  runId: id,
                  sessionId: session,
                  sessionLabel,
                  profileId: profile.id,
                  testId: test.id,
                  status: "failed",
                  error: message,
                }),
              );
            }
          }
        }

        if (anyFailed) {
          process.exitCode = 1;
        }
      },
    );
}
