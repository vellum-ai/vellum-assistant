/**
 * Trigger the Playwright agent tests in CI and optionally follow the run.
 *
 * Usage:
 *   bun run scripts/agent-ci.ts                    # trigger + poll until done
 *   bun run scripts/agent-ci.ts -d                 # trigger + print URL, then exit
 *   bun run scripts/agent-ci.ts -b my-branch       # trigger on a specific branch
 *   bun run scripts/agent-ci.ts -v 1.2.3           # test against released version 1.2.3
 *   bun run scripts/agent-ci.ts --version 1.2.3 -d # test release + detach
 *   bun run scripts/agent-ci.ts --experimental     # include experimental tests
 *   bun run scripts/agent-ci.ts --xcode             # use agent-xcode runner instead of Playwright
 *   bun run scripts/agent-ci.ts -t hello-world      # run a single test case by name
 */

import { spawnSync } from "child_process";
import { rmSync } from "fs";

const REPO = "vellum-ai/vellum-assistant";
const WORKFLOW = "playwright.yaml";
const POLL_INTERVAL_MS = 5000;

const detach = process.argv.includes("-d");

function parseFlagValue(short: string, long: string): string | undefined {
  const idx = process.argv.findIndex((a) => a === short || a === long);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

const releaseVersion = parseFlagValue("-v", "--version");
const branch = parseFlagValue("-b", "--branch");
const experimental = process.argv.includes("--experimental");
const useXcode = process.argv.includes("--xcode");
const testCase = parseFlagValue("-t", "--test");

function gh(args: string[]): { stdout: string; status: number } {
  const result = spawnSync("gh", args, { encoding: "utf-8", stdio: ["inherit", "pipe", "inherit"] });
  return { stdout: (result.stdout ?? "").trim(), status: result.status ?? 1 };
}

function ghPassthrough(args: string[]): number {
  const result = spawnSync("gh", args, { encoding: "utf-8", stdio: "inherit" });
  return result.status ?? 1;
}

interface StepInfo {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  startedAt: string | null;
  completedAt: string | null;
}

interface JobInfo {
  name: string;
  status: string;
  conclusion: string | null;
  steps: StepInfo[];
  startedAt: string;
}

function formatElapsed(startTime: Date): string {
  const elapsed = Math.floor((Date.now() - startTime.getTime()) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function stepIcon(step: StepInfo): string {
  if (step.conclusion === "success") return "✓";
  if (step.conclusion === "failure") return "✗";
  if (step.conclusion === "skipped") return "⊘";
  if (step.status === "in_progress") return "●";
  return "○";
}

function formatStepDuration(step: StepInfo): string {
  if (step.startedAt && step.completedAt) {
    const start = new Date(step.startedAt);
    const end = new Date(step.completedAt);
    const secs = Math.floor((end.getTime() - start.getTime()) / 1000);
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    if (mins === 0) return `${remSecs}s`;
    return `${mins}m ${remSecs}s`;
  }
  if (step.startedAt && step.status === "in_progress") {
    const secs = Math.floor((Date.now() - new Date(step.startedAt).getTime()) / 1000);
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    if (mins === 0) return `${remSecs}s`;
    return `${mins}m ${remSecs}s`;
  }
  return "";
}

interface TestLine {
  name: string;
  passed: boolean;
  duration: string;
}

/** Parse test result lines from the "Run Playwright tests" step logs. */
function parseTestLines(logText: string): TestLine[] {
  const tests: TestLine[] = [];
  // Match runner output: "  ✓ test-name (12.3s)" or "  ✗ test-name (12.3s)"
  const regex = /^\s*[✓✗]\s+(.+?)\s+\(([^)]+)\)/gm;
  let match;
  while ((match = regex.exec(logText)) !== null) {
    tests.push({
      name: match[1],
      passed: logText[match.index + logText.slice(match.index).search(/[✓✗]/)] === "✓",
      duration: match[2],
    });
  }
  return tests;
}

let cachedTestLines: TestLine[] = [];

function renderStatus(runUrl: string, startTime: Date, jobs: JobInfo[]): void {
  const lines: string[] = [];

  lines.push(`\x1b[2J\x1b[H`); // clear screen
  lines.push(`Playwright Tests · ${runUrl}`);
  lines.push(`Elapsed: ${formatElapsed(startTime)}`);
  lines.push("");

  // Find the "Playwright Tests" job (the only one we care about)
  const job = jobs.find((j) => j.name === "Playwright Tests") ?? jobs[0];
  if (!job) {
    lines.push("  Waiting for job to start...");
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }

  for (const step of job.steps) {
    const icon = stepIcon(step);
    const duration = formatStepDuration(step);
    const durationSuffix = duration ? ` \x1b[90m(${duration})\x1b[0m` : "";
    const color = step.conclusion === "failure" ? "\x1b[31m" : step.conclusion === "success" ? "\x1b[32m" : step.status === "in_progress" ? "\x1b[33m" : "\x1b[90m";
    lines.push(`  ${color}${icon}\x1b[0m ${step.name}${durationSuffix}`);

    // Show test sub-bullets under "Run Playwright tests"
    if (step.name === "Run Playwright tests" && cachedTestLines.length > 0) {
      for (const t of cachedTestLines) {
        const tIcon = t.passed ? "✓" : "✗";
        const tColor = t.passed ? "\x1b[32m" : "\x1b[31m";
        lines.push(`    ${tColor}${tIcon}\x1b[0m ${t.name} \x1b[90m(${t.duration})\x1b[0m`);
      }
    }
  }

  process.stdout.write(lines.join("\n") + "\n");
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
const triggerArgs = ["workflow", "run", WORKFLOW, "-R", REPO];
if (branch) {
  triggerArgs.push("--ref", branch);
}
if (releaseVersion) {
  triggerArgs.push("-f", `release_version=${releaseVersion}`);
}
if (experimental) {
  triggerArgs.push("-f", "test_filter=experimental");
}
if (useXcode) {
  triggerArgs.push("-f", "use_xcode=true");
}
if (testCase) {
  triggerArgs.push("-f", `test_case=${testCase}`);
}

const details = [
  branch ? `branch=${branch}` : null,
  releaseVersion ? `release_version=${releaseVersion}` : null,
  experimental ? "test_filter=experimental" : null,
  useXcode ? "use_xcode=true" : null,
  testCase ? `test_case=${testCase}` : null,
].filter(Boolean);
console.log(`Triggering ${WORKFLOW}${details.length ? ` with ${details.join(", ")}` : ""}...`);
const trigger = ghPassthrough(triggerArgs);
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

// Poll until complete with custom status display
const startTime = new Date();
let conclusion = "";

while (true) {
  const { stdout: json } = gh([
    "run", "view", runId, "-R", REPO,
    "--json", "status,conclusion,jobs",
  ]);

  try {
    const run = JSON.parse(json) as {
      status: string;
      conclusion: string | null;
      jobs: JobInfo[];
    };

    // Fetch test sub-bullets from job logs when the test step has finished
    const playwrightJob = run.jobs.find((j) => j.name === "Playwright Tests");
    const testStep = playwrightJob?.steps.find((s) => s.name === "Run Playwright tests");
    if (testStep?.completedAt && cachedTestLines.length === 0 && playwrightJob) {
      try {
        const { stdout: jobsJson } = gh([
          "run", "view", runId, "-R", REPO, "--json", "jobs", "--jq",
          `.jobs[] | select(.name == "Playwright Tests") | .databaseId`,
        ]);
        if (jobsJson) {
          const { stdout: logText } = gh([
            "api", `repos/${REPO}/actions/jobs/${jobsJson}/logs`,
          ]);
          cachedTestLines = parseTestLines(logText);
        }
      } catch {
        // Log fetching may fail; continue without sub-bullets
      }
    }

    renderStatus(runUrl, startTime, run.jobs);

    if (run.status === "completed") {
      conclusion = run.conclusion ?? "failure";
      break;
    }
  } catch {
    // API may return empty during initial queueing
  }

  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

// Final summary
const icon = conclusion === "success" ? "✓" : "✗";
const color = conclusion === "success" ? "\x1b[32m" : "\x1b[31m";
console.log(`\n${color}${icon}\x1b[0m Playwright Tests ${conclusion} in ${formatElapsed(startTime)}`);
console.log(`  ${runUrl}`);

// Show individual test results
if (cachedTestLines.length > 0) {
  console.log("\n  Tests:");
  for (const t of cachedTestLines) {
    const tIcon = t.passed ? "✓" : "✗";
    const tColor = t.passed ? "\x1b[32m" : "\x1b[31m";
    console.log(`    ${tColor}${tIcon}\x1b[0m ${t.name} \x1b[90m(${t.duration})\x1b[0m`);
  }
}

// Fetch specific artifact URL
const { stdout: artifactJson } = gh([
  "api", `repos/${REPO}/actions/runs/${runId}/artifacts`,
  "--jq", ".artifacts[0] // empty | {id, name}",
]);

if (artifactJson) {
  try {
    const artifact = JSON.parse(artifactJson) as { id: number; name: string };
    const artifactUrl = `https://github.com/${REPO}/actions/runs/${runId}/artifacts/${artifact.id}`;
    console.log(`  ${artifactUrl}`);

    const qaBaseUrl = process.env.QA_APP_URL || "https://qa.vellum.ai";
    const qaUrl = `${qaBaseUrl}/runs/${runId}`;
    console.log(`  ${qaUrl}`);

    console.log("\nDownloading artifacts...");
    rmSync("test-results/ci-artifacts", { recursive: true, force: true });
    ghPassthrough(["run", "download", runId, "-R", REPO, "-D", "test-results/ci-artifacts"]);
    console.log("Saved to test-results/ci-artifacts/");
  } catch {
    // artifact JSON parse failed, skip download
  }
}

process.exit(conclusion === "success" ? 0 : 1);
