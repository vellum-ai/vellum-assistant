#!/usr/bin/env bun
/**
 * create-hotfix-branch.ts — Create a patch release branch for cherry-picking hotfixes.
 *
 * Finds the most recent release tag (e.g. v0.4.55), increments the patch
 * version (v0.4.56), creates a `release/v0.4.56` branch from that tag's
 * commit, bumps all package versions to match, and pushes the branch.
 *
 * Usage:
 *   bun scripts/create-hotfix-branch.ts
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { encoding: "utf-8" }).trim();
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path: string, data: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// 1. Fetch all tags from remote so we have the latest
git("fetch origin --tags");

// 2. Find the latest release tag
const allTags = git("tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname");
const latestTag = allTags.split("\n").filter(Boolean)[0];

if (!latestTag) {
  console.error("ERROR: No release tags found matching v*.*.* pattern");
  process.exit(1);
}

console.log(`Latest release tag: ${latestTag}`);

// 3. Parse and increment the patch version
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

// 4. Create the branch from the latest tag's commit
const tagCommit = git(`rev-list -n 1 ${latestTag}`);
console.log(`Branching from commit: ${tagCommit.slice(0, 12)}`);

git(`checkout -b ${branchName} ${tagCommit}`);
console.log(`Created branch: ${branchName}`);

// 5. Bump package versions to match the new release version
const versionStr = `${major}.${minor}.${Number(patch) + 1}`;

const packages = ["assistant", "cli", "credential-executor", "gateway", "meta"];
for (const pkg of packages) {
  const pkgPath = `${pkg}/package.json`;
  const pkgJson = readJson(pkgPath);
  pkgJson.version = versionStr;
  writeJson(pkgPath, pkgJson);
  console.log(`  Bumped ${pkgPath} to ${versionStr}`);
}

// Bump meta-package dependency versions
const metaPkgPath = "meta/package.json";
const metaPkg = readJson(metaPkgPath);
const deps = metaPkg.dependencies as Record<string, string>;
deps["@vellumai/assistant"] = versionStr;
deps["@vellumai/cli"] = versionStr;
deps["@vellumai/credential-executor"] = versionStr;
deps["@vellumai/trust-broker"] = versionStr;
deps["@vellumai/vellum-gateway"] = versionStr;
writeJson(metaPkgPath, metaPkg);
console.log(`  Bumped meta dependencies to ${versionStr}`);

// Bump macOS app version in clients/Package.swift
const swiftPath = "clients/Package.swift";
const swiftContent = readFileSync(swiftPath, "utf-8");
const updatedSwift = swiftContent.replace(
  /^let appVersion = .*/m,
  `let appVersion = "${versionStr}"`
);
writeFileSync(swiftPath, updatedSwift);
console.log(`  Bumped ${swiftPath} to ${versionStr}`);

git("add -A");
git(`commit -m "Release v${versionStr} [skip ci]"`);
console.log(`Added version bump commit to ${branchName}`);

// 6. Push the branch
git(`push origin ${branchName}`);
console.log(`Pushed ${branchName} to origin`);

console.log(
  `\nDone! Branch ${branchName} is ready for cherry-picking hotfix commits.`
);
