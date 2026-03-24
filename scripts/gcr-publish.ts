#!/usr/bin/env bun
/**
 * gcr-publish.ts — Manually build and push Docker images to GCR.
 *
 * Builds multi-arch (linux/amd64, linux/arm64) images for the specified
 * services, then pushes them to Google Container Registry. For trust-broker,
 * re-tags the credential-executor image instead of building separately.
 *
 * Prerequisites:
 *   - Docker with buildx support (Docker Desktop or buildx plugin)
 *   - QEMU registered for multi-arch builds (the script sets this up)
 *   - Authenticated to GCR: `gcloud auth configure-docker <registry-host>`
 *
 * Required environment variables:
 *   GCP_REGISTRY_HOST              — e.g. us-docker.pkg.dev
 *   GCP_PROJECT_ID                 — e.g. my-gcp-project
 *   ASSISTANT_IMAGE_NAME           — e.g. assistant (required when publishing assistant)
 *   GATEWAY_IMAGE_NAME             — e.g. gateway (required when publishing gateway)
 *   CREDENTIAL_EXECUTOR_IMAGE_NAME — e.g. credential-executor (required when publishing credential-executor or trust-broker)
 *   TRUST_BROKER_IMAGE_NAME        — e.g. trust-broker (required when publishing trust-broker)
 *
 * Usage:
 *   bun scripts/gcr-publish.ts --version <semver>
 *   bun scripts/gcr-publish.ts --version <semver> --services trust-broker
 *   bun scripts/gcr-publish.ts --version <semver> --services assistant,gateway --skip-latest
 *   bun scripts/gcr-publish.ts --version <semver> --sha <commit-sha> --dry-run
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
    version: { type: "string" },
    services: { type: "string" },
    sha: { type: "string" },
    platforms: { type: "string", default: "linux/amd64,linux/arm64" },
    "skip-latest": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

const version = values.version;
const platforms = values.platforms ?? "linux/amd64,linux/arm64";
const skipLatest = values["skip-latest"] ?? false;
const dryRun = values["dry-run"] ?? false;

if (!version) {
  console.error("ERROR: --version is required");
  console.error(
    "Usage: bun scripts/gcr-publish.ts --version <semver> [--services assistant,gateway,credential-executor,trust-broker] [--sha <commit-sha>] [--platforms linux/amd64,linux/arm64] [--skip-latest] [--dry-run]"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Service configuration
// ---------------------------------------------------------------------------

type Service = "assistant" | "gateway" | "credential-executor" | "trust-broker";

const ALL_SERVICES: Service[] = [
  "assistant",
  "gateway",
  "credential-executor",
  "trust-broker",
];

interface ServiceConfig {
  imageEnvVar: string;
  context: string;
  dockerfile: string;
  featureFlagSync?: { src: string; dest: string };
  /** When set, re-tag this source service's image instead of building. */
  retagFrom?: Service;
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
  "trust-broker": {
    imageEnvVar: "TRUST_BROKER_IMAGE_NAME",
    context: ".",
    dockerfile: "credential-executor/Dockerfile",
    retagFrom: "credential-executor",
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

const GCP_REGISTRY_HOST = process.env.GCP_REGISTRY_HOST;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;

const missing: string[] = [];
if (!GCP_REGISTRY_HOST) missing.push("GCP_REGISTRY_HOST");
if (!GCP_PROJECT_ID) missing.push("GCP_PROJECT_ID");

for (const svc of selectedServices) {
  const config = SERVICE_CONFIG[svc];
  if (!process.env[config.imageEnvVar]) missing.push(config.imageEnvVar);
  if (config.retagFrom) {
    const sourceEnvVar = SERVICE_CONFIG[config.retagFrom].imageEnvVar;
    if (!process.env[sourceEnvVar]) missing.push(sourceEnvVar);
  }
}

if (missing.length > 0) {
  const unique = [...new Set(missing)];
  console.error(
    `ERROR: Missing required environment variables: ${unique.join(", ")}`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCRIPT_DIR = import.meta.dir;
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

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

console.log(`  Version:      v${version}`);
console.log(`  Services:     ${selectedServices.join(", ")}`);
console.log(`  Platforms:    ${platforms}`);
console.log(`  Commit SHA:   ${sha}`);
console.log(`  Skip latest:  ${skipLatest}`);
console.log(`  Dry run:      ${dryRun}`);
console.log("");

// ---------------------------------------------------------------------------
// Set up buildx builder
// ---------------------------------------------------------------------------

console.log("==> Setting up Docker Buildx");

const BUILDER_NAME = "vellum-gcr-multiarch";
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

  const tags = [`${image}:v${version}`, `${image}:${sha}`];
  if (!skipLatest) tags.push(`${image}:latest`);

  const tagArgs = tags.map((t) => `-t "${t}"`).join(" ");

  if (config.retagFrom) {
    // Re-tag mode: create a new manifest pointing to an existing image
    const sourceImage = imageRef(config.retagFrom);

    console.log(`==> Re-tagging ${config.retagFrom} as ${svc}`);
    console.log(`    Source: ${sourceImage}:v${version}`);
    console.log(`    Target: ${image}`);
    console.log(`    Tags:   ${tags.map((t) => t.split(":")[1]).join(", ")}`);
    console.log("");

    // Verify source image exists
    try {
      run(
        `docker buildx imagetools inspect "${sourceImage}:v${version}" --format "{{json .Manifest.Digest}}"`
      );
    } catch {
      console.error(
        `    ERROR: Source image not found at ${sourceImage}:v${version}`
      );
      failed.push(svc);
      continue;
    }

    const cmd = `docker buildx imagetools create ${tagArgs} "${sourceImage}:v${version}"`;

    if (dryRun) {
      console.log("    (dry run) Would execute:");
      console.log(`    ${cmd}\n`);
    } else {
      try {
        run(cmd);
        console.log(`    ${svc} re-tagged successfully\n`);
      } catch (err) {
        console.error(`    ${svc} FAILED: ${err}\n`);
        failed.push(svc);
      }
    }
  } else {
    // Build mode: build from Dockerfile and push
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
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("===========================================");
console.log("  GCR Publish Summary");
console.log("===========================================");
console.log(`  Version: v${version}`);
console.log("");

for (const svc of selectedServices) {
  const image = imageRef(svc);
  if (failed.includes(svc)) {
    console.log(`  [FAIL] ${image}:v${version}`);
  } else if (dryRun) {
    console.log(`  [DRY]  ${image}:v${version}  (not pushed)`);
  } else {
    console.log(`  [OK]   ${image}:v${version}`);
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
  console.log("All images published successfully.");
}
