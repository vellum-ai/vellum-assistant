#!/usr/bin/env bun
/**
 * gcs-trust-broker-publish.ts — Manually publish the trust-broker image to GCR.
 *
 * Re-tags the credential-executor image that already exists in GCR under the
 * trust-broker image name. This is the same operation that the release workflow
 * performs in the `push-credential-executor-manifest` job.
 *
 * Prerequisites:
 *   - Docker with buildx support
 *   - Authenticated to GCR: `gcloud auth configure-docker <registry-host>`
 *   - The credential-executor image must already exist in GCR for the given version
 *
 * Required environment variables (or pass via CLI flags):
 *   GCP_REGISTRY_HOST       — e.g. us-docker.pkg.dev
 *   GCP_PROJECT_ID          — e.g. my-gcp-project
 *   CREDENTIAL_EXECUTOR_IMAGE_NAME — e.g. credential-executor
 *   TRUST_BROKER_IMAGE_NAME        — e.g. trust-broker
 *
 * Usage:
 *   bun scripts/gcs-trust-broker-publish.ts --version <semver>
 *   bun scripts/gcs-trust-broker-publish.ts --version <semver> --environment production
 *   bun scripts/gcs-trust-broker-publish.ts --version <semver> --skip-latest
 *   bun scripts/gcs-trust-broker-publish.ts --version <semver> --dry-run
 */

import { execSync } from "node:child_process";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    version: { type: "string" },
    environment: { type: "string", default: "production" },
    "skip-latest": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

const version = values.version;
const environment = values.environment ?? "production";
const skipLatest = values["skip-latest"] ?? false;
const dryRun = values["dry-run"] ?? false;

if (!version) {
  console.error("ERROR: --version is required");
  console.error(
    "Usage: bun scripts/gcs-trust-broker-publish.ts --version <semver> [--environment production] [--skip-latest] [--dry-run]"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const GCP_REGISTRY_HOST = process.env.GCP_REGISTRY_HOST;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const CREDENTIAL_EXECUTOR_IMAGE_NAME =
  process.env.CREDENTIAL_EXECUTOR_IMAGE_NAME;
const TRUST_BROKER_IMAGE_NAME = process.env.TRUST_BROKER_IMAGE_NAME;

const missing: string[] = [];
if (!GCP_REGISTRY_HOST) missing.push("GCP_REGISTRY_HOST");
if (!GCP_PROJECT_ID) missing.push("GCP_PROJECT_ID");
if (!CREDENTIAL_EXECUTOR_IMAGE_NAME)
  missing.push("CREDENTIAL_EXECUTOR_IMAGE_NAME");
if (!TRUST_BROKER_IMAGE_NAME) missing.push("TRUST_BROKER_IMAGE_NAME");

if (missing.length > 0) {
  console.error(
    `ERROR: Missing required environment variables: ${missing.join(", ")}`
  );
  console.error(
    "Set them in your shell or in scripts/.env before running this script."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string): string {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
}

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { encoding: "utf-8" }).trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ceImage = `${GCP_REGISTRY_HOST}/${GCP_PROJECT_ID}/${CREDENTIAL_EXECUTOR_IMAGE_NAME}`;
const tbImage = `${GCP_REGISTRY_HOST}/${GCP_PROJECT_ID}/${TRUST_BROKER_IMAGE_NAME}`;
const sha = git("rev-parse HEAD");

console.log("==> Trust Broker GCR Publish");
console.log(`    Version:      v${version}`);
console.log(`    Environment:  ${environment}`);
console.log(`    CE image:     ${ceImage}`);
console.log(`    TB image:     ${tbImage}`);
console.log(`    Commit SHA:   ${sha}`);
console.log(`    Skip latest:  ${skipLatest}`);
console.log(`    Dry run:      ${dryRun}`);
console.log("");

// ---------------------------------------------------------------------------
// 1. Verify the credential-executor source image exists
// ---------------------------------------------------------------------------

console.log(
  `==> Verifying credential-executor image exists at ${ceImage}:v${version}`
);
try {
  run(
    `docker buildx imagetools inspect "${ceImage}:v${version}" --format "{{json .Manifest.Digest}}"`
  );
  console.log("    Source image verified.\n");
} catch {
  console.error(
    `ERROR: Could not find credential-executor image at ${ceImage}:v${version}`
  );
  console.error(
    "Make sure the credential-executor image has been built and pushed for this version."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Build the tag list for the trust-broker image
// ---------------------------------------------------------------------------

const tags: string[] = [`${tbImage}:v${version}`, `${tbImage}:${sha}`];

if (!skipLatest) {
  tags.push(`${tbImage}:latest`);
}

console.log("==> Tags to create:");
for (const tag of tags) {
  console.log(`    - ${tag}`);
}
console.log("");

// ---------------------------------------------------------------------------
// 3. Re-tag the credential-executor image as trust-broker
// ---------------------------------------------------------------------------

const tagArgs = tags.map((t) => `-t "${t}"`).join(" ");
const cmd = `docker buildx imagetools create ${tagArgs} "${ceImage}:v${version}"`;

if (dryRun) {
  console.log("==> Dry run — would execute:");
  console.log(`    ${cmd}`);
  console.log("\n    Skipping actual push.");
} else {
  console.log("==> Creating trust-broker manifest and pushing to GCR");
  run(cmd);
  console.log("    Manifest created and pushed.\n");

  // -------------------------------------------------------------------------
  // 4. Verify the pushed manifest
  // -------------------------------------------------------------------------

  console.log("==> Verifying trust-broker manifest");
  const digestOutput = run(
    `docker buildx imagetools inspect "${tbImage}:v${version}" --format "{{json .Manifest.Digest}}"`
  );
  const digest = digestOutput.replace(/"/g, "");
  console.log(`    Trust-broker manifest digest: ${digest}\n`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("===========================================");
console.log("  Trust Broker GCR Publish Summary");
console.log("===========================================");
console.log(`  Version:     v${version}`);
console.log(`  Environment: ${environment}`);
console.log(`  Source:      ${ceImage}:v${version}`);

if (dryRun) {
  console.log("  Status:      DRY RUN (no changes made)");
} else {
  console.log("  Status:      Published");
  for (const tag of tags) {
    console.log(`  Tag:         ${tag}`);
  }
}
console.log("");
