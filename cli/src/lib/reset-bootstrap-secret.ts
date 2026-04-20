import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Name of the file in the gateway security directory that holds the
 * loopback-caller-bound proof used to authenticate
 * `POST /v1/guardian/reset-bootstrap` requests.
 *
 * The value is 32 random bytes hex-encoded. Only processes running as the
 * same Unix user that owns the gateway security directory can read it
 * (mode 0600), which is what gives the reset-bootstrap endpoint its
 * caller-bound-proof property in addition to its loopback-origin check.
 */
export const RESET_BOOTSTRAP_AUTH_FILENAME = "reset-bootstrap-secret";
export const RESET_BOOTSTRAP_AUTH_HEADER = "x-reset-bootstrap-secret";

export function getResetBootstrapAuthPath(gatewaySecurityDir: string): string {
  return join(gatewaySecurityDir, RESET_BOOTSTRAP_AUTH_FILENAME);
}

/**
 * Read the reset-bootstrap secret from disk. Returns null if the file does
 * not exist or cannot be read.
 */
export function loadResetBootstrapSecret(
  gatewaySecurityDir: string,
): string | null {
  const path = getResetBootstrapAuthPath(gatewaySecurityDir);
  try {
    const raw = readFileSync(path, "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Generate a fresh 32-byte hex secret and persist it under the gateway
 * security directory with 0600 permissions.
 */
export function generateAndStoreResetBootstrapSecret(
  gatewaySecurityDir: string,
): string {
  if (!existsSync(gatewaySecurityDir)) {
    mkdirSync(gatewaySecurityDir, { recursive: true, mode: 0o700 });
  }
  const value = randomBytes(32).toString("hex");
  const path = getResetBootstrapAuthPath(gatewaySecurityDir);
  writeFileSync(path, value + "\n", { mode: 0o600 });
  // writeFileSync's mode is ignored when the file already exists, so chmod
  // explicitly to tighten permissions on overwrite.
  chmodSync(path, 0o600);
  return value;
}

/**
 * Read the secret if present, otherwise generate and store a fresh one.
 * Used by bare-metal hatch (to seed the secret) and `vellum wake`
 * recovery (to regenerate if the file was lost).
 */
export function ensureResetBootstrapSecret(gatewaySecurityDir: string): string {
  const existing = loadResetBootstrapSecret(gatewaySecurityDir);
  if (existing) return existing;
  return generateAndStoreResetBootstrapSecret(gatewaySecurityDir);
}
