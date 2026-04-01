#!/usr/bin/env bun
/**
 * staging-docker-upload.ts — Build and push Docker images from a staging
 * release branch to the dev-assistant GCR environment with a prerelease tag.
 *
 * Staging runs on release branches validate code (lint, typecheck, test) but
 * skip Docker image pushes. This script fills that gap: it builds the images
 * from the release branch HEAD (or a specified commit) and pushes them to the
 * **dev** GCR environment tagged with a prerelease semver.
 *
 * The prerelease tag is derived automatically from the release branch version
 * plus a suffix you provide (e.g. `rc.1`, `staging.3`). For example, on
 * branch `release/v0.5.17` with `--pre rc.1`, images are tagged `v0.5.17-rc.1`.
 *
 * Prerequisites:
 *   - Docker with buildx support
 *   - Authenticated to GCR: `gcloud auth configure-docker <registry-host>`
 *   - Required environment variables (from scripts/.env or environment):
 *       GCP_REGISTRY_HOST, GCP_PROJECT_ID,
 *       ASSISTANT_IMAGE_NAME, GATEWAY_IMAGE_NAME, CREDENTIAL_EXECUTOR_IMAGE_NAME
 *
 * Usage:
 *   bun scripts/staging-docker-upload.ts --pre rc.1
 *   bun scripts/staging-docker-upload.ts --pre staging.2 --services assistant,gateway
 *   bun scripts/staging-docker-upload.ts --pre rc.1 --sha abc123 --dry-run
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    pre: { type: "string" },
    services: { type: "string" },
    sha: { type: "string" },
    platforms: { type: "string", default: "linux/amd64,linux/arm64" },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

const prerelease = values.pre;
const platforms = values.platforms ?? "linux/amd64,linux/arm64";
const dryRun = values["dry-run"] ?? false;

if (!prerelease) {
  console.error("ERROR: --pre is required (e.g. --pre rc.1, --pre staging.2)");
  console.error(
    "Usage: bun scripts/staging-docker-upload.ts --pre <suffix> [--services assistant,gateway,credential-executor] [--sha <commit>] [--platforms linux/amd64,linux/arm64] [--dry-run]"
  );
  process.exit(1);
}

// Validate prerelease format (semver prerelease: alphanumeric and dots)
if (!/^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*$/.test(prerelease)) {
  console.error(
    `ERROR: Invalid prerelease suffix '${prerelease}'. Use semver format, e.g. rc.1, staging.2, beta.3`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Service configuration
// ---------------------------------------------------------------------------

type Service = "assistant" | "gateway" | "credential-executor";

const ALL_SERVICES: Service[] = [
  "assistant",
  "gateway",
  "credential-executor",
];

interface ServiceConfig {
  imageEnvVar: string;
  context: string;
  dockerfile: string;
  featureFlagSync?: { src: string; dest: string };
}

const SERVICE_CONFIG: Record<Service, ServiceConfig> = {
  assistant: {
    imageEnvVar: "ASSISTANT_IMAGE_NAME",
    context: ".",
    dockerfile: "assistant/Dockerfile",
    featureFlagSync: {
      src: "meta/feature-flags/feature-flag-registry.json",
      dest: "assistant/src/config/feature-flag-registry.json",
    },
  },
  gateway: {
    imageEnvVar: "GATEWAY_IMAGE_NAME",
    context: "gateway",
    dockerfile: "gateway/Dockerfile",
    featureFlagSync: {
      src: "meta/feature-flags/feature-flag-registry.json",
      dest: "gateway/src/feature-flag-registry.json",
    },
  },
  "credential-executor": {
    imageEnvVar: "CREDENTIAL_EXECUTOR_IMAGE_NAME",
    context: ".",
    dockerfile: "credential-executor/Dockerfile",
  },
};

// ---------------------------------------------------------------------------
// Resolve selected services
// ---------------------------------------------------------------------------

let selectedServices: Service[];

if (values.services) {
  selectedServices = values.services.split(",").map((s) => s.trim()) as Service[];
  for (const svc of selectedServices) {
    if (!ALL_SERVICES.includes(svc)) {
      console.error(
        `ERROR: Unknown service '${svc}'. Valid services: ${ALL_SERVICES.join(", ")}`
      );
      process.exit(1);
    }
  }
} else {
  selectedServices = [...ALL_SERVICES];
}

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

const SCRIPT_DIR = import.meta.dir;
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

// Source scripts/.env if it exists (for local runs)
const envFile = resolve(SCRIPT_DIR, ".env");
if (existsSync(envFile)) {
  const lines = (await Bun.file(envFile).text()).split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

const GCP_REGISTRY_HOST = process.env.GCP_REGISTRY_HOST;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;

const missing: string[] = [];
if (!GCP_REGISTRY_HOST) missing.push("GCP_REGISTRY_HOST");
if (!GCP_PROJECT_ID) missing.push("GCP_PROJECT_ID");

for (const svc of selectedServices) {
  const config = SERVICE_CONFIG[svc];
  if (!process.env[config.imageEnvVar]) missing.push(config.imageEnvVar);
}

if (missing.length > 0) {
  const unique = [...new Set(missing)];
  console.error(
    `ERROR: Missing required environment variables: ${unique.join(", ")}`
  );
  console.error(
    "Set them in scripts/.env or export them before running this script."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, opts?: { cwd?: string }): string {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, {
    encoding: "utf-8",
    stdio: "pipe",
    cwd: opts?.cwd ?? REPO_ROOT,
  }).trim();
}

function git(cmd: string): string {
  return execSync(`git ${cmd}`, {
    encoding: "utf-8",
    cwd: REPO_ROOT,
  }).trim();
}

function imageRef(svc: Service): string {
  const envVar = SERVICE_CONFIG[svc].imageEnvVar;
  return `${GCP_REGISTRY_HOST}/${GCP_PROJECT_ID}/${process.env[envVar]}`;
}

// ---------------------------------------------------------------------------
// Resolve version from the current branch
// ---------------------------------------------------------------------------

const branch = git("rev-parse --abbrev-ref HEAD");
const branchMatch = branch.match(/^release\/v(.+)$/);

if (!branchMatch) {
  console.error(
    `ERROR: This script must be run from a release branch (release/v*). Current branch: ${branch}`
  );
  process.exit(1);
}

const baseVersion = branchMatch[1];
const prereleaseVersion = `${baseVersion}-${prerelease}`;

// ---------------------------------------------------------------------------
// Resolve SHA
// ---------------------------------------------------------------------------

const sha = values.sha ?? git("rev-parse HEAD");

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

console.log("==> Pre-flight checks");

try {
  run("docker buildx version");
} catch {
  console.error(
    "ERROR: docker buildx is not available. Install Docker with buildx support."
  );
  process.exit(1);
}

console.log(`  Branch:       ${branch}`);
console.log(`  Base version: v${baseVersion}`);
console.log(`  Prerelease:   v${prereleaseVersion}`);
console.log(`  Services:     ${selectedServices.join(", ")}`);
console.log(`  Platforms:    ${platforms}`);
console.log(`  Commit SHA:   ${sha}`);
console.log(`  Dry run:      ${dryRun}`);
console.log("");

// ---------------------------------------------------------------------------
// Set up buildx builder
// ---------------------------------------------------------------------------

console.log("==> Setting up Docker Buildx");

const BUILDER_NAME = "vellum-staging-multiarch";
try {
  run(`docker buildx inspect ${BUILDER_NAME}`);
  console.log(`  Using existing buildx builder: ${BUILDER_NAME}`);
  run(`docker buildx use ${BUILDER_NAME}`);
} catch {
  console.log(`  Creating buildx builder: ${BUILDER_NAME}`);
  run(
    `docker buildx create --name ${BUILDER_NAME} --driver docker-container --use`
  );
}

try {
  run(
    "docker run --rm --privileged multiarch/qemu-user-static --reset -p yes"
  );
} catch {
  // QEMU registration is best-effort
}
console.log("");

// ---------------------------------------------------------------------------
// Sync feature flags
// ---------------------------------------------------------------------------

const needsFeatureFlagSync = selectedServices.some(
  (svc) => SERVICE_CONFIG[svc].featureFlagSync
);

if (needsFeatureFlagSync) {
  console.log("==> Syncing feature flag registry");
  for (const svc of selectedServices) {
    const sync = SERVICE_CONFIG[svc].featureFlagSync;
    if (sync) {
      const src = resolve(REPO_ROOT, sync.src);
      const dest = resolve(REPO_ROOT, sync.dest);
      if (existsSync(src)) {
        execSync(`cp "${src}" "${dest}"`);
        console.log(`  ${sync.src} -> ${sync.dest}`);
      } else {
        console.warn(`  WARNING: Feature flag source not found: ${sync.src}`);
      }
    }
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Build and push each service
// ---------------------------------------------------------------------------

const failed: Service[] = [];

for (const svc of selectedServices) {
  const config = SERVICE_CONFIG[svc];
  const image = imageRef(svc);

  // Tag with prerelease version and SHA only — never :latest for prerelease
  const tags = [`${image}:v${prereleaseVersion}`, `${image}:${sha}`];
  const tagArgs = tags.map((t) => `-t "${t}"`).join(" ");

  const context = resolve(REPO_ROOT, config.context);
  const dockerfile = resolve(REPO_ROOT, config.dockerfile);

  console.log(`==> Building and pushing: ${svc}`);
  console.log(`    Image:      ${image}`);
  console.log(`    Dockerfile: ${config.dockerfile}`);
  console.log(`    Context:    ${config.context}`);
  console.log(`    Platforms:  ${platforms}`);
  console.log(`    Tags:       ${tags.map((t) => t.split(":")[1]).join(", ")}`);
  console.log("");

  const pushFlag = dryRun ? "" : "--push";
  if (dryRun) console.log("    (dry run — skipping push)");

  const cmd = `docker buildx build --platform "${platforms}" -f "${dockerfile}" ${tagArgs} ${pushFlag} "${context}"`;

  try {
    run(cmd);
    console.log(`    ${svc} published successfully\n`);
  } catch (err) {
    console.error(`    ${svc} FAILED: ${err}\n`);
    failed.push(svc);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("===========================================");
console.log("  Staging Docker Upload Summary");
console.log("===========================================");
console.log(`  Version: v${prereleaseVersion}`);
console.log(`  Target:  dev (GCR)`);
console.log("");

for (const svc of selectedServices) {
  const image = imageRef(svc);
  if (failed.includes(svc)) {
    console.log(`  [FAIL] ${image}:v${prereleaseVersion}`);
  } else if (dryRun) {
    console.log(`  [DRY]  ${image}:v${prereleaseVersion}  (not pushed)`);
  } else {
    console.log(`  [OK]   ${image}:v${prereleaseVersion}`);
  }
}
console.log("");

if (failed.length > 0) {
  console.error(
    `ERROR: ${failed.length} service(s) failed: ${failed.join(", ")}`
  );
  process.exit(1);
}

if (dryRun) {
  console.log("Dry run complete — no images were pushed.");
} else {
  console.log("All images published to dev GCR with prerelease tag.");
  console.log(
    `\nTo register this prerelease with the platform, run:\n` +
    `  curl -X POST "$NONPROD_PLATFORM_API_URL/v1/internal/assistant-image-releases/" \\\n` +
    `    -H "Content-Type: application/json" \\\n` +
    `    -H "X-Internal-Service-Api-Key: $NONPROD_PLATFORM_INTERNAL_SERVICE_API_KEY" \\\n` +
    `    -d '{"version": "${prereleaseVersion}", "is_stable": false, ...}'`
  );
}
