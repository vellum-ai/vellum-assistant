import { readFileSync } from "node:fs";
import { join } from "node:path";

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

function resolveVersion(): string {
  const envVersion = process.env.APP_VERSION;

  // Explicit non-dev value — trust it as-is (e.g. CI --define or env var).
  if (envVersion && envVersion !== "0.0.0-dev") return envVersion;

  // APP_VERSION is either unset (Docker, local dev) or the dev placeholder
  // (CI builds).  Try reading the version from package.json so containerised
  // assistants (minikube / Cloud Run) report a meaningful version instead of
  // "0.0.0-dev".
  return readPackageVersion() ?? "0.0.0-dev";
}

// Version is embedded at compile time via --define in CI.
// Falls back to package.json version when running in Docker / local dev,
// or "0.0.0-dev" if package.json is unavailable.
export const APP_VERSION: string = resolveVersion();

// Commit SHA is embedded at compile time via --define in CI.
// Falls back to "unknown" for local development.
function resolveCommitSha(): string {
  const sha = process.env.COMMIT_SHA;
  if (!sha || sha === "unknown") return "unknown";
  return sha;
}

export const COMMIT_SHA: string = resolveCommitSha();
