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

function runId(profileId: string, testId: string): string {
  const suffix = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  return `eval-${profileId}-${testId}-${suffix}`;
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

        for (const profile of profiles) {
          for (const test of tests) {
            const result = await runEvalOnce({
              profile,
              test,
              runId: runId(profile.id, test.id),
              maxTurns: opts.maxTurns,
              progress,
            });
            console.log(JSON.stringify(result));
          }
        }
      },
    );
}
