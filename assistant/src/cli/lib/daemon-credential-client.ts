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

  if (ipc.error && !isDaemonUnreachable(ipc.error)) {
    log.warn({ type, name, error: ipc.error }, "Daemon secret write failed");
    return false;
  }

  // Daemon unreachable — fall back to direct write.
  if (type === "api_key") {
    return setSecureKeyAsync(credentialKey(name, "api_key"), value);
  }
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

  if (ipc.error && !isDaemonUnreachable(ipc.error)) {
    if (ipc.error.includes("not found") || ipc.error.includes("404")) {
      return "not-found";
    }
    return "error";
  }

  // Daemon unreachable — fall back to direct delete.
  if (type === "api_key") {
    // Delete from both locations; during migration overlap both may exist.
    // Ignore "not-found" on each — one location may already be empty.
    const credResult = await deleteSecureKeyAsync(credentialKey(name, "api_key"));
    if (credResult === "error") return "error";
    const bareResult = await deleteSecureKeyAsync(name);
    if (bareResult === "error") return "error";
    return credResult === "deleted" || bareResult === "deleted"
      ? "deleted"
      : "not-found";
  }
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
