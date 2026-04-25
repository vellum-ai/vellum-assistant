/**
 * CLI helper for credential operations.
 *
 * Reads go directly to `secure-keys.ts` — no daemon needed.
 *
 * Writes and deletes route through the daemon's CLI IPC socket when the
 * daemon is running so that daemon-side singletons (provider registry,
 * CES client, in-memory identity fields) stay in sync. Falls back to
 * direct `secure-keys.ts` when the daemon is not reachable.
 */

import { cliIpcCall } from "../../ipc/cli-client.js";
import type { DeleteResult } from "../../security/credential-backend.js";
import { credentialKey } from "../../security/credential-key.js";
import type { SecureKeyResult } from "../../security/secure-keys.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
  getSecureKeyResultAsync,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("daemon-credential-client");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Exported wrapper functions
// ---------------------------------------------------------------------------

/**
 * Retrieve a secret value. Reads go directly to `secure-keys.ts` —
 * the daemon is not needed for reads.
 */
export async function getSecureKeyViaDaemon(
  account: string,
): Promise<string | undefined> {
  return getSecureKeyAsync(account);
}

/**
 * Retrieve a secret value with richer result metadata.
 * Reads go directly to `secure-keys.ts`.
 */
export async function getSecureKeyResultViaDaemon(
  account: string,
): Promise<SecureKeyResult> {
  return getSecureKeyResultAsync(account);
}

/**
 * Store a secret via the daemon IPC socket (so daemon-side singletons
 * stay in sync). Falls back to direct `setSecureKeyAsync()` when the
 * daemon is not running.
 */
export async function setSecureKeyViaDaemon(
  type: string,
  name: string,
  value: string,
): Promise<boolean> {
  const ipc = await cliIpcCall<{ success: boolean }>("secrets/write", {
    type,
    name,
    value,
  });

  if (ipc.ok && ipc.result) {
    return ipc.result.success;
  }

  if (ipc.error && !ipc.error.includes("Could not connect")) {
    // Daemon is running but deliberately rejected the write (e.g.
    // validation failure). Do NOT fall back — the daemon's rejection
    // is authoritative and bypassing it would skip validation.
    log.warn({ type, name, error: ipc.error }, "Daemon secret write failed");
    return false;
  }

  // Daemon unreachable — fall back to direct write.
  // For credentials, convert "service:field" to the canonical
  // "credential/service/field" storage key using credentialKey().
  if (type === "credential" && !name.startsWith("credential/")) {
    const colonIdx = name.lastIndexOf(":");
    if (colonIdx > 0 && colonIdx < name.length - 1) {
      const service = name.slice(0, colonIdx);
      const field = name.slice(colonIdx + 1);
      return setSecureKeyAsync(credentialKey(service, field), value);
    }
  }
  return setSecureKeyAsync(name, value);
}

/**
 * Delete a secret via the daemon IPC socket. Falls back to direct
 * `deleteSecureKeyAsync()` when the daemon is not running.
 */
export async function deleteSecureKeyViaDaemon(
  type: string,
  name: string,
): Promise<DeleteResult> {
  const ipc = await cliIpcCall<{ success: boolean }>("secrets/delete", {
    type,
    name,
  });

  if (ipc.ok && ipc.result) {
    return ipc.result.success ? "deleted" : "error";
  }

  if (ipc.error && !ipc.error.includes("Could not connect")) {
    // Daemon is running but rejected the delete.
    if (ipc.error.includes("not found") || ipc.error.includes("404")) {
      return "not-found";
    }
    return "error";
  }

  // Daemon unreachable — fall back to direct delete.
  // For credentials, convert "service:field" to the canonical
  // "credential/service/field" storage key using credentialKey().
  if (type === "credential" && !name.startsWith("credential/")) {
    const colonIdx = name.lastIndexOf(":");
    if (colonIdx > 0 && colonIdx < name.length - 1) {
      const service = name.slice(0, colonIdx);
      const field = name.slice(colonIdx + 1);
      return deleteSecureKeyAsync(credentialKey(service, field));
    }
  }
  return deleteSecureKeyAsync(name);
}
