import { cliIpcCall } from "../../ipc/cli-client.js";
import type { DeleteResult } from "../../security/credential-backend.js";
import { credentialKey } from "../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("daemon-credential-client");

const DAEMON_UNREACHABLE =
  "Could not connect to assistant daemon. Is it running?";

function isDaemonUnreachable(error: string): boolean {
  return error === DAEMON_UNREACHABLE;
}

/**
 * Resolve the secure-key account for a credential write.
 *
 * Translates the CLI-facing `type` + `name` into the canonical
 * `credential/{service}/{field}` key used in the encrypted store.
 */
function resolveWriteAccount(type: string, name: string): string {
  if (type === "api_key") {
    return credentialKey(name, "api_key");
  }
  if (type === "credential" && !name.startsWith("credential/")) {
    const colonIdx = name.lastIndexOf(":");
    if (colonIdx > 0 && colonIdx < name.length - 1) {
      const service = name.slice(0, colonIdx);
      const field = name.slice(colonIdx + 1);
      return credentialKey(service, field);
    }
  }
  return name;
}

/**
 * Store a secret via the daemon IPC socket (so daemon-side singletons
 * stay in sync). Falls back to direct `setSecureKeyAsync()` when the
 * daemon is not running or the daemon-side write fails.
 *
 * The daemon-side write can fail when its CES RPC backend is dead and
 * failover doesn't recover it. In that case the CLI process constructs
 * its own backend (which may resolve to CES HTTP or the encrypted
 * store) and retries the write directly.
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

  if (ipc.ok && ipc.result?.success) {
    return true;
  }

  // Log the daemon-side failure (if it was a genuine error, not just
  // unreachable) so we have a trail, but don't bail — try direct write.
  if (ipc.ok && ipc.result && !ipc.result.success) {
    log.warn(
      { type, name },
      "Daemon secret write returned success=false — retrying via direct backend",
    );
  } else if (ipc.error && !isDaemonUnreachable(ipc.error)) {
    log.warn(
      { type, name, error: ipc.error },
      "Daemon secret write failed — retrying via direct backend",
    );
  }

  // Direct write — either daemon is unreachable or its write failed.
  return setSecureKeyAsync(resolveWriteAccount(type, name), value);
}

/**
 * Resolve the secure-key account(s) for a credential delete.
 *
 * For api_key type, returns both the canonical and bare key because
 * during migration overlap both locations may exist.
 */
function resolveDeleteAccounts(type: string, name: string): string[] {
  if (type === "api_key") {
    return [credentialKey(name, "api_key"), name];
  }
  if (type === "credential" && !name.startsWith("credential/")) {
    const colonIdx = name.lastIndexOf(":");
    if (colonIdx > 0 && colonIdx < name.length - 1) {
      const service = name.slice(0, colonIdx);
      const field = name.slice(colonIdx + 1);
      return [credentialKey(service, field)];
    }
  }
  return [name];
}

/**
 * Delete a secret via the daemon IPC socket. Falls back to direct
 * `deleteSecureKeyAsync()` when the daemon is not running or the
 * daemon-side delete fails.
 */
export async function deleteSecureKeyViaDaemon(
  type: string,
  name: string,
): Promise<DeleteResult> {
  const ipc = await cliIpcCall<{ success: boolean }>("secrets/delete", {
    type,
    name,
  });

  if (ipc.ok && ipc.result?.success) {
    return "deleted";
  }

  // Daemon returned not-found — trust it, no fallback needed.
  if (ipc.error && !isDaemonUnreachable(ipc.error)) {
    if (ipc.error.includes("not found") || ipc.error.includes("404")) {
      return "not-found";
    }
  }

  // Log daemon-side failure for diagnostics, then try direct delete.
  if (ipc.ok && ipc.result && !ipc.result.success) {
    log.warn(
      { type, name },
      "Daemon secret delete returned success=false — retrying via direct backend",
    );
  } else if (ipc.error && !isDaemonUnreachable(ipc.error)) {
    log.warn(
      { type, name, error: ipc.error },
      "Daemon secret delete failed — retrying via direct backend",
    );
  }

  // Direct delete — either daemon is unreachable or its delete failed.
  const accounts = resolveDeleteAccounts(type, name);
  let anyDeleted = false;
  for (const account of accounts) {
    const result = await deleteSecureKeyAsync(account);
    if (result === "error") return "error";
    if (result === "deleted") anyDeleted = true;
  }
  return anyDeleted ? "deleted" : "not-found";
}
