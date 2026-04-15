import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEV_VERSION_SENTINEL = "0.0.0-dev";

function readPackageVersion(): string | undefined {
  try {
    const pkgPath = join(
      import.meta.dirname ?? __dirname,
      "..",
      "package.json",
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (pkg.version && typeof pkg.version === "string") return pkg.version;
  } catch {
    // package.json missing or unreadable
  }
  return undefined;
}

/**
 * Generate a `-local.YYYYMMDDHHMMSS.shortsha` suffix for local dev builds,
 * mirroring the macOS client's `build.sh` convention. This ensures the
 * service-group version displayed in the About window matches the client's
 * version format.
 */
function localDevSuffix(): string {
  const now = new Date();
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");

  let sha = "unknown";
  try {
    sha = execSync("git rev-parse --short HEAD", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // git not available or not in a repo
  }

  return `-local.${ts}.${sha}`;
}

function resolveVersion(): string {
  const envVersion = process.env.APP_VERSION;

  if (envVersion && envVersion !== DEV_VERSION_SENTINEL) return envVersion;

  const pkgVersion = readPackageVersion();
  if (!pkgVersion) return DEV_VERSION_SENTINEL;

  // In local dev mode (no explicit APP_VERSION), append a -local suffix
  // so the service-group version matches the macOS client's convention.
  // Skip the suffix inside containers (IS_CONTAINERIZED) where package.json
  // is the canonical version source and no git repo is present.
  if (!process.env.IS_CONTAINERIZED) {
    return pkgVersion + localDevSuffix();
  }

  return pkgVersion;
}

export const APP_VERSION: string = resolveVersion();

// Commit SHA is embedded at compile time via --define in CI.
// Falls back to "unknown" for local development.
function resolveCommitSha(): string {
  const sha = process.env.COMMIT_SHA;
  if (!sha || sha === "unknown") return "unknown";
  return sha;
}

export const COMMIT_SHA: string = resolveCommitSha();
