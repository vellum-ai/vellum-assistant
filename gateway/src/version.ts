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

function resolveVersion(): string {
  const envVersion = process.env.APP_VERSION;
  if (envVersion && envVersion !== DEV_VERSION_SENTINEL) return envVersion;
  return readPackageVersion() ?? DEV_VERSION_SENTINEL;
}

function resolveCommitSha(): string {
  const sha = process.env.COMMIT_SHA;
  if (!sha || sha === "unknown") return "unknown";
  return sha;
}

export const APP_VERSION: string = resolveVersion();
export const COMMIT_SHA: string = resolveCommitSha();

/**
 * Header name for the assistant version returned in every gateway response.
 * Allows the platform to trace which build handled a request.
 */
export const VERSION_HEADER_NAME = "X-Vellum-Assistant-Version";

/**
 * Build the version header value: "version (sha)" or just "version".
 */
export const VERSION_HEADER_VALUE: string =
  COMMIT_SHA !== "unknown"
    ? `${APP_VERSION} (${COMMIT_SHA.slice(0, 8)})`
    : APP_VERSION;
