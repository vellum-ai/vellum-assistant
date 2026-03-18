#!/usr/bin/env bun
/**
 * create-hotfix-branch.ts — Create a patch release branch for cherry-picking hotfixes.
 *
 * Finds the most recent release tag (e.g. v0.4.55), increments the patch
 * version (v0.4.56), creates a `release/v0.4.56` branch from that tag's
 * commit, adds a no-op [skip ci] commit, and pushes the branch.
 *
 * Usage:
 *   bun scripts/create-hotfix-branch.ts
 */

import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { encoding: "utf-8" }).trim();
}

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8" }).trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// 1. Find the latest release tag
const allTags = git("tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname");
const latestTag = allTags.split("\n").filter(Boolean)[0];

if (!latestTag) {
  console.error("ERROR: No release tags found matching v*.*.* pattern");
  process.exit(1);
}

console.log(`Latest release tag: ${latestTag}`);

// 2. Parse and increment the patch version
const match = latestTag.match(/^v(\d+)\.(\d+)\.(\d+)$/);
if (!match) {
  console.error(`ERROR: Could not parse version from tag: ${latestTag}`);
  process.exit(1);
}

const [, major, minor, patch] = match;
const newVersion = `v${major}.${minor}.${Number(patch) + 1}`;
const branchName = `release/${newVersion}`;

console.log(`New patch version: ${newVersion}`);
console.log(`Branch name: ${branchName}`);

// 3. Create the branch from the latest tag's commit
const tagCommit = git(`rev-list -n 1 ${latestTag}`);
console.log(`Branching from commit: ${tagCommit.slice(0, 12)}`);

git(`checkout -b ${branchName} ${tagCommit}`);
console.log(`Created branch: ${branchName}`);

// 4. Add a no-op [skip ci] commit
const readmePath = "README.md";
const timestamp = new Date().toISOString();
run(`echo "" >> ${readmePath}`);
run(
  `echo "<!-- Hotfix branch ${newVersion} initialized at ${timestamp} -->" >> ${readmePath}`
);

git(`add ${readmePath}`);
git(`commit -m "chore: initialize hotfix branch ${newVersion} [skip ci]"`);
console.log(`Added [skip ci] commit to ${branchName}`);

// 5. Push the branch
git(`push origin ${branchName}`);
console.log(`Pushed ${branchName} to origin`);

console.log(
  `\nDone! Branch ${branchName} is ready for cherry-picking hotfix commits.`
);
