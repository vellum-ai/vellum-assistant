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

export const APP_VERSION: string = resolveVersion();

/**
 * Header name for the assistant version returned in every gateway response.
 * Allows the platform to trace which build handled a request.
 */
export const VERSION_HEADER_NAME = "X-Vellum-Assistant-Version";

export const VERSION_HEADER_VALUE: string = APP_VERSION;
