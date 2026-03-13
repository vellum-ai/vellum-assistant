import { readFileSync } from "node:fs";
import { join } from "node:path";

function resolveVersion(): string {
  const envVersion = process.env.APP_VERSION;

  // When APP_VERSION is not set, we're in local development — return the dev
  // sentinel so Sentry (and similar) classify the session as "development".
  if (!envVersion) return "0.0.0-dev";

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
    return "0.0.0-dev";
  }

  return envVersion;
}

// Version is embedded at compile time via --define in CI.
// Falls back to "0.0.0-dev" for local development, or resolves the dev
// placeholder to package.json version when explicitly set in CI.
export const APP_VERSION: string = resolveVersion();

// Commit SHA is embedded at compile time via --define in CI.
// Falls back to "unknown" for local development.
function resolveCommitSha(): string {
  const sha = process.env.COMMIT_SHA;
  if (!sha || sha === "unknown") return "unknown";
  return sha;
}

export const COMMIT_SHA: string = resolveCommitSha();
