import { cliIpcCall } from "../../ipc/cli-client.js";
import type { DeleteResult } from "../../security/credential-backend.js";
import { credentialKey } from "../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  getActiveBackendName,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("daemon-credential-client");

const DAEMON_UNREACHABLE =
  "Could not connect to assistant daemon. Is it running?";

function isDaemonUnreachable(error: string): boolean {
  return error === DAEMON_UNREACHABLE;
}

// ---------------------------------------------------------------------------
// Result types — include error context so the CLI can surface it
// ---------------------------------------------------------------------------

export interface SetSecureKeyResult {
  ok: boolean;
  /** Human-readable error reason when ok=false. */
  error?: string;
}

export interface DeleteSecureKeyResult {
  result: DeleteResult;
  /** Human-readable error reason when result="error". */
  error?: string;
  /** Daemon error code when result="error" (e.g. `CREDENTIAL_IN_USE`). */
  code?: string;
}

// ---------------------------------------------------------------------------
// Set
// ---------------------------------------------------------------------------

/**
 * Store a secret via the daemon IPC socket (so daemon-side singletons
 * stay in sync). Falls back to direct `setSecureKeyAsync()` when the
 * daemon is not running.
 */
export async function setSecureKeyViaDaemon(
  type: string,
  name: string,
  value: string,
): Promise<SetSecureKeyResult> {
  const ipc = await cliIpcCall<{ success: boolean; error?: string }>(
    "secrets_add",
    { body: { type, name, value } },
  );

  if (ipc.ok && ipc.result?.success) {
    return { ok: true };
  }

  // Daemon returned an IPC-level error (thrown InternalError, etc.)
  if (ipc.error && !isDaemonUnreachable(ipc.error)) {
    log.warn({ type, name, error: ipc.error }, "Daemon secret write failed");
    return { ok: false, error: ipc.error };
  }

  // Daemon returned success=false (e.g. validation error, backend failure)
  if (ipc.ok && ipc.result && !ipc.result.success) {
    return {
      ok: false,
      error: ipc.result.error || "Credential write rejected by assistant",
    };
  }

  // Daemon unreachable — fall back to direct write.
  let account: string;
  if (type === "api_key") {
    account = credentialKey(name, "api_key");
  } else if (type === "credential" && !name.startsWith("credential/")) {
    const colonIdx = name.lastIndexOf(":");
    if (colonIdx > 0 && colonIdx < name.length - 1) {
      const service = name.slice(0, colonIdx);
      const field = name.slice(colonIdx + 1);
      account = credentialKey(service, field);
    } else {
      account = name;
    }
  } else {
    account = name;
  }

  const ok = await setSecureKeyAsync(account, value);
  if (!ok) {
    return {
      ok: false,
      error: `Failed to store credential (backend: ${getActiveBackendName()})`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a secret via the daemon IPC socket. Falls back to direct
 * `deleteSecureKeyAsync()` when the daemon is not running.
 *
 * `force` carries the caller's confirmation past the daemon's in-use guard,
 * which refuses a delete while an LLM provider connection resolves its auth
 * through the credential.
 */
export async function deleteSecureKeyViaDaemon(
  type: string,
  name: string,
  force = false,
): Promise<DeleteSecureKeyResult> {
  const ipc = await cliIpcCall<{ success: boolean }>("secrets_delete", {
    body: force ? { type, name, force } : { type, name },
  });

  if (ipc.ok && ipc.result?.success) {
    return { result: "deleted" };
  }

  // Daemon returned an IPC-level error
  if (ipc.error && !isDaemonUnreachable(ipc.error)) {
    if (ipc.error.includes("not found") || ipc.error.includes("404")) {
      return { result: "not-found" };
    }
    return ipc.errorCode !== undefined
      ? { result: "error", error: ipc.error, code: ipc.errorCode }
      : { result: "error", error: ipc.error };
  }

  // Daemon returned success=false
  if (ipc.ok && ipc.result && !ipc.result.success) {
    return {
      result: "error",
      error: "Credential delete rejected by assistant",
    };
  }

  // Daemon unreachable. The in-use guard runs daemon-side, next to the
  // provider connection records it reads, so a direct delete here would
  // remove a credential an LLM connection depends on with no check at all.
  // The delete is refused until the caller either starts the assistant or
  // states the intent explicitly.
  if (!force) {
    return {
      result: "error",
      code: "IN_USE_CHECK_UNAVAILABLE",
      error:
        "Cannot check whether LLM provider connections depend on this credential while the assistant is not running. Start the assistant, or re-run with --force to delete without the check.",
    };
  }

  if (type === "api_key") {
    // Delete from both locations; during migration overlap both may exist.
    const credResult = await deleteSecureKeyAsync(
      credentialKey(name, "api_key"),
    );
    if (credResult === "error") {
      return {
        result: "error",
        error: `Failed to delete credential (backend: ${getActiveBackendName()})`,
      };
    }
    const bareResult = await deleteSecureKeyAsync(name);
    if (bareResult === "error") {
      return {
        result: "error",
        error: `Failed to delete credential (backend: ${getActiveBackendName()})`,
      };
    }
    return {
      result:
        credResult === "deleted" || bareResult === "deleted"
          ? "deleted"
          : "not-found",
    };
  }

  let account: string;
  if (type === "credential" && !name.startsWith("credential/")) {
    const colonIdx = name.lastIndexOf(":");
    if (colonIdx > 0 && colonIdx < name.length - 1) {
      const service = name.slice(0, colonIdx);
      const field = name.slice(colonIdx + 1);
      account = credentialKey(service, field);
    } else {
      account = name;
    }
  } else {
    account = name;
  }

  const result = await deleteSecureKeyAsync(account);
  if (result === "error") {
    return {
      result: "error",
      error: `Failed to delete credential (backend: ${getActiveBackendName()})`,
    };
  }
  return { result };
}
