/**
 * Trigger the Playwright agent tests in CI and optionally follow the run.
 *
 * Usage:
 *   bun run scripts/agent-ci.ts        # trigger + poll until done
 *   bun run scripts/agent-ci.ts -d     # trigger + print URL, then exit
 */

import { spawnSync } from "child_process";

const REPO = "vellum-ai/vellum-assistant";
const WORKFLOW = "playwright.yaml";

const detach = process.argv.includes("-d");

function gh(args: string[]): { stdout: string; status: number } {
  const result = spawnSync("gh", args, { encoding: "utf-8", stdio: ["inherit", "pipe", "inherit"] });
  return { stdout: (result.stdout ?? "").trim(), status: result.status ?? 1 };
}

function ghPassthrough(args: string[]): number {
  const result = spawnSync("gh", args, { encoding: "utf-8", stdio: "inherit" });
  return result.status ?? 1;
}

// Trigger the workflow
console.log(`Triggering ${WORKFLOW} with agent=true...`);
const trigger = ghPassthrough(["workflow", "run", WORKFLOW, "-R", REPO, "-f", "agent=true"]);
if (trigger !== 0) {
  process.exit(trigger);
}

// Give GitHub a moment to register the run
await new Promise((resolve) => setTimeout(resolve, 3000));

// Find the run we just created
const { stdout: runId } = gh([
  "run", "list", "-R", REPO, "-w", WORKFLOW,
  "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId",
]);

if (!runId) {
  console.error("Error: could not find the triggered run");
  process.exit(1);
}

const runUrl = `https://github.com/${REPO}/actions/runs/${runId}`;

if (detach) {
  console.log(`\nRun triggered: ${runUrl}`);
  console.log(`\nTo follow progress:\n  gh run watch ${runId} -R ${REPO}`);
  process.exit(0);
}

console.log(`Run: ${runUrl}\n`);

// Poll until complete
const watchStatus = ghPassthrough(["run", "watch", runId, "-R", REPO, "--exit-status"]);

// Print summary
const { stdout: summary } = gh([
  "run", "view", runId, "-R", REPO,
  "--json", "conclusion,displayTitle,updatedAt",
  "--jq", `"Result: \\(.conclusion)  (\\(.displayTitle))\\nFinished: \\(.updatedAt)"`,
]);

console.log("\n─────────────────────────────────────────");
console.log(summary);
console.log(`URL: ${runUrl}`);
console.log("─────────────────────────────────────────");

// Download artifacts if any
const { stdout: artifactCount } = gh([
  "run", "view", runId, "-R", REPO,
  "--json", "artifacts", "--jq", ".artifacts | length",
]);

if (parseInt(artifactCount, 10) > 0) {
  console.log("\nDownloading artifacts...");
  ghPassthrough(["run", "download", runId, "-R", REPO, "-D", "test-results/ci-artifacts"]);
  console.log("Saved to test-results/ci-artifacts/");
}

process.exit(watchStatus);
