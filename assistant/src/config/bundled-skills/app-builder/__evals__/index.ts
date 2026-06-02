/**
 * Standalone CLI entry for the app-builder eval harness.
 *
 *   bun run assistant/src/config/bundled-skills/app-builder/__evals__/index.ts
 *
 * Runs the golden prompt set through the registered build drivers and prints an
 * A/B scorecard. This is intentionally NOT wired into the default test/CI gate.
 *
 * Today both columns use the stub driver + stub judge (see build-driver.ts /
 * rubric.ts), so the numbers are placeholders that prove the pipeline works.
 * Swap in a live single-model driver and the planner/worker driver to get real
 * A/B signal once PR 7 (telemetry) and the v2 flow land.
 */

import { StubBuildDriver } from "./build-driver.js";
import { GOLDEN_PROMPTS } from "./prompts.js";
import { runEvals } from "./runner.js";
import type { Scorecard } from "./types.js";

function fmt(n: number | undefined): string {
  return n === undefined ? "—" : n.toFixed(2);
}

export function formatScorecard(card: Scorecard): string {
  const lines: string[] = [];
  lines.push(`app-builder eval scorecard — ${card.generatedAt}`);
  lines.push(`prompts: ${card.promptSetSize}`);
  lines.push("");
  lines.push(
    [
      "variant".padEnd(16),
      "compile",
      "tokens",
      "files",
      "design",
      "lat(ms)",
      "cost($)",
    ].join("  "),
  );
  for (const col of card.columns) {
    lines.push(
      [
        col.variant.padEnd(16),
        fmt(col.compileRate).padStart(7),
        fmt(col.meanTokenCoverage).padStart(6),
        fmt(col.meanFileCoverage).padStart(5),
        fmt(col.meanDesignScore).padStart(6),
        fmt(col.meanLatencyMs).padStart(7),
        fmt(col.meanCostUsd).padStart(7),
      ].join("  "),
    );
  }
  return lines.join("\n");
}

export async function main(): Promise<void> {
  const card = await runEvals({
    prompts: GOLDEN_PROMPTS,
    // Two columns wired for A/B; both stubbed until the live flows land.
    drivers: [
      new StubBuildDriver("single-model"),
      new StubBuildDriver("planner-worker"),
    ],
  });
  // eslint-disable-next-line no-console -- standalone CLI output
  console.log(formatScorecard(card));
}

if (import.meta.main) {
  await main();
}
