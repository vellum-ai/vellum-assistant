/**
 * Inlined platform utilities used by the DoorDash skill.
 * Subset of assistant/src/util/platform.ts — kept minimal.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function getRootDir(): string {
  const base = process.env.BASE_DATA_DIR?.trim();
  return join(base || homedir(), ".vellum");
}

export function getDataDir(): string {
  return join(getRootDir(), "workspace", "data");
}

/** Default daemon HTTP port — matches cli/src/lib/constants.ts. */
const DEFAULT_DAEMON_PORT = 7821;

/**
 * Resolve the daemon HTTP port from RUNTIME_HTTP_PORT env var or default.
 */
export function getHttpPort(): number {
  const envPort = process.env.RUNTIME_HTTP_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return DEFAULT_DAEMON_PORT;
}

/**
 * Build the base URL for the daemon HTTP server.
 */
export function buildDaemonUrl(port?: number): string {
  return `http://127.0.0.1:${port ?? getHttpPort()}`;
}

/**
 * Read the HTTP bearer token from `<rootDir>/http-token`.
 * Returns null if the token file doesn't exist or is empty.
 */
export function readHttpToken(): string | null {
  try {
    const token = readFileSync(
      join(getRootDir(), "http-token"),
      "utf-8",
    ).trim();
    return token || null;
  } catch {
    return null;
  }
}
