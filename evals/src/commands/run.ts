/**
 * `evals run` — Cartesian profile × test runner.
 *
 * Loads each profile and test definition, then steps through each (profile,
 * test) pair. The execution path lands as the agent adapter, simulator, and
 * scorers come online.
 */
import type { Command } from "commander";

import { loadProfile } from "../lib/profile";
import { loadTestDef } from "../lib/test-def";

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
    .action(async (opts: { profiles: string; tests: string }) => {
      const profileIds = splitCsv(opts.profiles);
      const testIds = splitCsv(opts.tests);

      if (profileIds.length === 0) {
        console.error("Error: --profiles is empty after splitting on commas");
        process.exit(1);
      }
      if (testIds.length === 0) {
        console.error("Error: --tests is empty after splitting on commas");
        process.exit(1);
      }

      for (const id of profileIds) await loadProfile(id);
      for (const id of testIds) await loadTestDef(id);
    });
}
