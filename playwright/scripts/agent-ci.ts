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

// Capture the current user and most recent run ID before triggering,
// so we can detect the *new* run by comparing against the previous one.
const { stdout: ghUser } = gh(["api", "user", "--jq", ".login"]);
const runListArgs = [
  "run", "list", "-R", REPO, "-w", WORKFLOW,
  "-u", ghUser, "-e", "workflow_dispatch",
  "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId",
];
const { stdout: previousRunId } = gh(runListArgs);

// Trigger the workflow
console.log(`Triggering ${WORKFLOW} with agent=true...`);
const trigger = ghPassthrough(["workflow", "run", WORKFLOW, "-R", REPO, "-f", "agent=true"]);
if (trigger !== 0) {
  process.exit(trigger);
}

// Poll until a new run appears (different ID from the previous one)
let runId = "";
for (let attempt = 0; attempt < 15; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const { stdout: id } = gh(runListArgs);
  if (id && id !== previousRunId) {
    runId = id;
    break;
  }
}

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
  "api", `repos/${REPO}/actions/runs/${runId}/artifacts`,
  "--jq", ".total_count",
]);

if (parseInt(artifactCount, 10) > 0) {
  console.log("\nDownloading artifacts...");
  ghPassthrough(["run", "download", runId, "-R", REPO, "-D", "test-results/ci-artifacts"]);
  console.log("Saved to test-results/ci-artifacts/");
}

process.exit(watchStatus);
