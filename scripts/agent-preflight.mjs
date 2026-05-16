#!/usr/bin/env node

import { accessSync, constants, existsSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredClaudeHelpers = [
  "worktree",
  "ship",
  "review-runtime",
  "gh-review",
  "wait-ci",
];

const failures = [];
const warnings = [];
const ok = [];
const info = [];

function commandPath(command) {
  for (const pathEntry of (process.env.PATH ?? "").split(":")) {
    if (!pathEntry) {
      continue;
    }

    const candidate = join(pathEntry, command);
    if (existsSync(candidate) && isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

function commandVersion(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    return null;
  }

  return (result.stdout || result.stderr).trim().split("\n")[0] || null;
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function checkBun() {
  const bun = commandPath("bun");
  if (!bun) {
    failures.push("Bun is not on PATH. Run: export PATH=\"$HOME/.bun/bin:$PATH\"");
    return;
  }

  const version = commandVersion("bun", ["--version"]);
  ok.push(`Bun available at ${bun}${version ? ` (${version})` : ""}`);

  const expectedPath = join(process.env.HOME ?? "", ".bun", "bin");
  const pathEntries = (process.env.PATH ?? "").split(":");
  if (expectedPath && !pathEntries.includes(expectedPath)) {
    warnings.push(`$HOME/.bun/bin is not on PATH; Bun is resolving from ${bun}`);
  }
}

function checkGitHubCli() {
  const gh = commandPath("gh");
  if (!gh) {
    failures.push("GitHub CLI is not on PATH.");
    return;
  }

  const auth = spawnSync("gh", ["auth", "status", "--hostname", "github.com"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
  });

  if (auth.status !== 0) {
    failures.push("GitHub CLI is installed but not authenticated for github.com. Run: gh auth login");
    return;
  }

  ok.push(`GitHub CLI authenticated at ${gh}`);
}

function checkPython() {
  const python3 = commandPath("python3");
  if (python3) {
    ok.push(`python3 available at ${python3}`);
    return;
  }

  const python = commandPath("python");
  if (python) {
    warnings.push(`python3 is not on PATH; only python was found at ${python}`);
    return;
  }

  warnings.push("No Python executable found on PATH; install python3 before running Python-based helpers.");
}

function checkClaudeHelpers() {
  const claudeDir = join(repoRoot, ".claude");
  if (!existsSync(claudeDir)) {
    failures.push(".claude directory is missing; this looks like a bare worktree without helper scripts.");
    warnings.push(
      "Bootstrap guidance: restore .claude from the repo checkout and ensure the shared claude-skills scripts are present.",
    );
    return;
  }

  const missing = [];
  const notExecutable = [];
  const brokenSymlinks = [];

  for (const helper of requiredClaudeHelpers) {
    const helperPath = join(claudeDir, helper);
    if (!existsSync(helperPath)) {
      missing.push(`.claude/${helper}`);

      try {
        const stat = lstatSync(helperPath);
        if (stat.isSymbolicLink()) {
          brokenSymlinks.push(`.claude/${helper} -> ${readlinkSync(helperPath)}`);
        }
      } catch {
        // Missing path; the concise failure above is enough.
      }

      continue;
    }

    if (!isExecutable(helperPath)) {
      notExecutable.push(`.claude/${helper}`);
    }
  }

  if (missing.length > 0) {
    failures.push(`Missing .claude helpers: ${missing.join(", ")}`);
  }

  if (notExecutable.length > 0) {
    failures.push(`.claude helpers are present but not executable: ${notExecutable.join(", ")}`);
  }

  if (brokenSymlinks.length > 0) {
    warnings.push(`Broken .claude helper symlinks: ${brokenSymlinks.join(", ")}`);
  }

  if (missing.length > 0 || brokenSymlinks.length > 0) {
    warnings.push(
      "Bootstrap guidance: restore .claude helper symlinks and make sure ../claude-skills exists before using worktree/ship/review helpers.",
    );
  }

  if (missing.length === 0 && notExecutable.length === 0) {
    const helperList = requiredClaudeHelpers
      .map((helper) => `.claude/${helper}`)
      .join(", ");
    ok.push(`.claude helpers available: ${helperList}`);
  }
}

function checkOptionalFiles() {
  const projectConfig = join(repoRoot, ".private", "project-config.env");
  if (existsSync(projectConfig)) {
    ok.push(".private/project-config.env present");
  } else {
    warnings.push(".private/project-config.env is absent; project-board automation may need explicit flags.");
  }

  const platformRepo = resolve(repoRoot, "..", "vellum-assistant-platform");
  if (existsSync(platformRepo)) {
    ok.push("../vellum-assistant-platform present");
  } else {
    info.push("../vellum-assistant-platform not found; only needed for cross-repo platform tasks.");
  }
}

function printSection(label, items) {
  if (items.length === 0) {
    return;
  }

  console.log(`\n${label}`);
  for (const item of items) {
    console.log(`- ${item}`);
  }
}

checkBun();
checkGitHubCli();
checkPython();
checkClaudeHelpers();
checkOptionalFiles();

console.log("Agent preflight");
console.log(`Repo: ${repoRoot}`);
printSection("OK", ok);
printSection("Warnings", warnings);
printSection("Failures", failures);
printSection("Info", info);

if (failures.length > 0) {
  console.log("\nResult: failed");
  process.exit(1);
}

console.log("\nResult: passed");
