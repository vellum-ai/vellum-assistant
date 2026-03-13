import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getBaseDataDir } from "./config/env-registry.js";

function resolveVersion(): string {
  const envVersion = process.env.APP_VERSION;

  // When APP_VERSION is not set, we're in local development. Try the
  // version file written by the daemon before falling back to the dev sentinel.
  if (!envVersion) return readVersionFile() ?? "0.0.0-dev";

  // CI sets APP_VERSION to the dev placeholder during builds; resolve it to
  // the package.json release version so Sentry gets a meaningful release tag.
  if (envVersion === "0.0.0-dev") {
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
    return readVersionFile() ?? "0.0.0-dev";
  }

  return envVersion;
}

/**
 * Read the version file written by the daemon at ~/.vellum/version.
 * Returns null if the file doesn't exist or can't be read.
 */
function readVersionFile(): string | null {
  try {
    const rootDir = join(getBaseDataDir() || homedir(), ".vellum");
    const version = readFileSync(join(rootDir, "version"), "utf-8").trim();
    if (version && version !== "0.0.0-dev") return version;
  } catch {
    // Version file missing or unreadable
  }
  return null;
}

// Version is embedded at compile time via --define in CI.
// Falls back to the daemon's version file, then to "0.0.0-dev" for local
// development.
export const APP_VERSION: string = resolveVersion();

// Commit SHA is embedded at compile time via --define in CI.
// Falls back to "unknown" for local development.
function resolveCommitSha(): string {
  const sha = process.env.COMMIT_SHA;
  if (!sha || sha === "unknown") return "unknown";
  return sha;
}

export const COMMIT_SHA: string = resolveCommitSha();
