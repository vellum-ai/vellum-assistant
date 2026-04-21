#!/usr/bin/env node

/**
 * Trigger CI workflows via workflow_dispatch for the current branch.
 *
 * GitHub App installation tokens cannot trigger `push` or `pull_request` events,
 * so when credence-the-bot (or any GitHub App) pushes a commit, CI doesn't run.
 * This script works around that by:
 *   1. Detecting which files changed on the current branch vs origin/main
 *   2. Matching changed files against each PR workflow's path patterns
 *   3. Firing workflow_dispatch for the relevant workflows
 *
 * Usage:
 *   node scripts/trigger-ci.mjs                    # auto-detect changed files
 *   node scripts/trigger-ci.mjs --workflows pr-assistant,pr-gateway  # explicit list
 *   node scripts/trigger-ci.mjs --all              # trigger all PR workflows
 *   node scripts/trigger-ci.mjs --dry-run          # show what would be triggered
 *
 * Requires GITHUB_TOKEN env var with actions:write permission.
 */

import { execSync } from "child_process";

const OWNER = "vellum-ai";
const REPO = "vellum-assistant";

// Map of workflow file -> path patterns (mirroring the `paths` triggers in each workflow)
const WORKFLOW_PATH_PATTERNS = {
  "pr-assistant.yaml": [
    "assistant/**",
    "credential-executor/**",
    "packages/**",
    "skills/meet-join/contracts/**",
    "scripts/skills/**",
    "meta/feature-flags/**",
    ".github/workflows/pr-assistant.yaml",
  ],
  "pr-gateway.yaml": [
    "gateway/**",
    "meta/feature-flags/**",
    ".github/workflows/pr-gateway.yaml",
  ],
  "pr-skills.yaml": [
    "skills/**",
    "scripts/skills/**",
    ".github/workflows/pr-skills.yaml",
  ],
  "pr-cli.yaml": ["cli/**", ".github/workflows/pr-cli.yaml"],
  "pr-chrome-extension.yaml": [
    "clients/chrome-extension/**",
    ".github/workflows/pr-chrome-extension.yaml",
  ],
  "pr-macos.yaml": [
    "clients/macos/**",
    "clients/shared/**",
    "clients/Package.swift",
    "clients/.periphery.yml",
    "clients/.periphery_baseline.json",
    "clients/scripts/periphery-scan.sh",
    "assistant/**",
    "gateway/**",
    "credential-executor/**",
    "packages/**",
    ".github/workflows/pr-macos.yaml",
  ],
  "pr-credential-executor.yaml": [
    "credential-executor/**",
    "packages/ces-contracts/**",
    "packages/credential-storage/**",
    "packages/egress-proxy/**",
    ".github/workflows/pr-credential-executor.yaml",
  ],
  "pr-ios.yaml": [
    "clients/ios/**",
    "clients/shared/**",
    "clients/Package.swift",
    ".github/workflows/pr-ios.yaml",
  ],
};

function globToRegex(pattern) {
  // Convert a simple glob pattern to a regex
  // Supports ** (any path) and * (single segment)
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function fileMatchesPatterns(file, patterns) {
  return patterns.some((pattern) => globToRegex(pattern).test(file));
}

function getChangedFiles() {
  try {
    // Ensure we have origin/main to diff against
    execSync("git fetch origin main --quiet 2>/dev/null", { stdio: "pipe" });
  } catch {
    // Already fetched or offline — proceed with what we have
  }

  const diff = execSync("git diff --name-only origin/main...HEAD", {
    encoding: "utf-8",
  }).trim();

  if (!diff) return [];
  return diff.split("\n").filter(Boolean);
}

function getCurrentBranch() {
  return execSync("git rev-parse --abbrev-ref HEAD", {
    encoding: "utf-8",
  }).trim();
}

async function triggerWorkflow(workflowFile, ref, token, dryRun) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${workflowFile}/dispatches`;

  if (dryRun) {
    console.log(`  [dry-run] Would dispatch ${workflowFile} on ref ${ref}`);
    return true;
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ ref }),
  });

  if (resp.status === 204) {
    console.log(`  ✅ Dispatched ${workflowFile}`);
    return true;
  } else {
    const body = await resp.text();
    console.error(`  ❌ Failed to dispatch ${workflowFile}: ${resp.status} ${body}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");

  const explicitIdx = args.indexOf("--workflows");
  const explicitWorkflows =
    explicitIdx !== -1
      ? args[explicitIdx + 1]?.split(",").map((w) => (w.endsWith(".yaml") ? w : `${w}.yaml`))
      : null;

  const token = process.env.GITHUB_TOKEN;
  if (!token && !dryRun) {
    console.error(
      "Error: GITHUB_TOKEN env var required (needs actions:write permission)"
    );
    process.exit(1);
  }

  const branch = getCurrentBranch();
  if (branch === "main") {
    console.error("Error: This script is for feature branches, not main");
    process.exit(1);
  }

  console.log(`Branch: ${branch}`);

  let workflowsToTrigger;

  if (all) {
    workflowsToTrigger = Object.keys(WORKFLOW_PATH_PATTERNS);
    console.log("Triggering all PR workflows");
  } else if (explicitWorkflows) {
    workflowsToTrigger = explicitWorkflows;
    console.log(`Triggering explicit workflows: ${workflowsToTrigger.join(", ")}`);
  } else {
    // Auto-detect based on changed files
    const changedFiles = getChangedFiles();
    if (changedFiles.length === 0) {
      console.log("No changed files detected vs origin/main");
      process.exit(0);
    }

    console.log(`Changed files: ${changedFiles.length}`);

    workflowsToTrigger = Object.entries(WORKFLOW_PATH_PATTERNS)
      .filter(([_, patterns]) =>
        changedFiles.some((file) => fileMatchesPatterns(file, patterns))
      )
      .map(([workflow]) => workflow);

    if (workflowsToTrigger.length === 0) {
      console.log("No PR workflows match the changed files");
      process.exit(0);
    }
  }

  console.log(`\nDispatching ${workflowsToTrigger.length} workflow(s):`);

  let allOk = true;
  for (const workflow of workflowsToTrigger) {
    const ok = await triggerWorkflow(workflow, branch, token, dryRun);
    if (!ok) allOk = false;
  }

  if (!allOk) {
    process.exit(1);
  }

  console.log("\nDone! Workflows will appear in the Actions tab shortly.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
