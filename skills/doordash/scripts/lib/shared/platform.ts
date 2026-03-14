/**
 * Inlined platform utilities used by the DoorDash skill.
 * Subset of assistant/src/util/platform.ts — kept minimal.
 */

import { createHmac, randomBytes } from "node:crypto";
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

/** Must stay in sync with assistant/src/runtime/auth/policy.ts. */
const CURRENT_POLICY_EPOCH = 1;

function base64urlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return buf.toString("base64url");
}

const JWT_HEADER = base64urlEncode(
  JSON.stringify({ alg: "HS256", typ: "JWT" }),
);

/**
 * Mint a short-lived JWT bearer token from the signing key on disk.
 * Returns null if the signing key doesn't exist.
 */
export function readHttpToken(): string | null {
  try {
    const keyPath = join(getRootDir(), "protected", "actor-token-signing-key");
    const key = readFileSync(keyPath);
    if (key.length !== 32) return null;

    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "vellum-auth",
      aud: "vellum-gateway",
      sub: "local:cli:cli",
      scope_profile: "actor_client_v1",
      exp: now + 300,
      policy_epoch: CURRENT_POLICY_EPOCH,
      iat: now,
      jti: randomBytes(16).toString("hex"),
    };

    const payload = base64urlEncode(JSON.stringify(claims));
    const sigInput = JWT_HEADER + "." + payload;
    const sig = createHmac("sha256", key).update(sigInput).digest();
    return sigInput + "." + base64urlEncode(sig);
  } catch {
    return null;
  }
}
