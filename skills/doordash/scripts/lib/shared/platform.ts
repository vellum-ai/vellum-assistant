/**
 * Inlined platform utilities used by the DoorDash skill.
 * Subset of assistant/src/util/platform.ts — kept minimal.
 */

import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import { arch, homedir, hostname, userInfo } from "node:os";
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

// ---------------------------------------------------------------------------
// Credential store reader (inlined subset of assistant/src/security/encrypted-store.ts)
// ---------------------------------------------------------------------------

const CREDENTIAL_KEY = "credential/bootstrapped_actor/http_token";

function getMachineEntropy(): string {
  const parts: string[] = [];
  try {
    parts.push(hostname());
  } catch {
    parts.push("unknown-host");
  }
  try {
    parts.push(userInfo().username);
  } catch {
    parts.push("unknown-user");
  }
  parts.push(process.platform);
  parts.push(arch());
  try {
    parts.push(userInfo().homedir);
  } catch {
    parts.push("/tmp");
  }
  return parts.join(":");
}

/**
 * Read the bootstrapped actor HTTP token from the encrypted credential store.
 * Returns null if the store doesn't exist or the token isn't found.
 */
export function readCredentialToken(): string | null {
  try {
    const storePath = join(getRootDir(), "protected", "keys.enc");
    const raw = readFileSync(storePath, "utf-8");
    const store = JSON.parse(raw) as {
      version: number;
      salt: string;
      entries: Record<string, { iv: string; tag: string; data: string }>;
    };
    if (
      store.version !== 1 ||
      typeof store.salt !== "string" ||
      typeof store.entries !== "object"
    )
      return null;

    const entry = store.entries[CREDENTIAL_KEY];
    if (!entry) return null;

    const salt = Buffer.from(store.salt, "hex");
    const key = pbkdf2Sync(getMachineEntropy(), salt, 100_000, 32, "sha512");
    const iv = Buffer.from(entry.iv, "hex");
    const tag = Buffer.from(entry.tag, "hex");
    const data = Buffer.from(entry.data, "hex");
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: 16,
    });
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString("utf-8") || null;
  } catch {
    return null;
  }
}
