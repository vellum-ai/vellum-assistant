/**
 * CLI helper for credential operations that routes through the daemon HTTP API
 * when the daemon is running, falling back to direct secure-keys.ts reads
 * when it is not.
 *
 * Follows the daemon HTTP fetch pattern established in conversations.ts
 * (health check, JWT minting, HTTP call).
 */

import { getRuntimeHttpHost, getRuntimeHttpPort } from "../../config/env.js";
import { API_KEY_PROVIDERS } from "../../config/loader.js";
import { healthCheckHost, isHttpHealthy } from "../../daemon/daemon-control.js";
import {
  initAuthSigningKey,
  loadOrCreateSigningKey,
  mintDaemonDeliveryToken,
} from "../../runtime/auth/token-service.js";
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
const CREDENTIAL_KEY_PREFIX = "credential/";

/** Hard timeout for daemon HTTP requests to prevent CLI commands from hanging. */
const DAEMON_FETCH_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Private daemon fetch helper
// ---------------------------------------------------------------------------

/**
 * Attempt an authenticated HTTP request to the running daemon.
 *
 * Returns the Response for ANY HTTP response (including non-ok status codes)
 * so callers can distinguish "daemon rejected the request" from "daemon
 * unreachable". Returns `null` only when the daemon is genuinely unreachable
 * (health check fails or network error). Callers fall back to direct
 * secure-keys.ts only when this returns `null`.
 */
async function daemonFetch(
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  try {
    if (!(await isHttpHealthy())) return null;

    const port = getRuntimeHttpPort();
    const host = healthCheckHost(getRuntimeHttpHost());
    initAuthSigningKey(loadOrCreateSigningKey());
    const token = mintDaemonDeliveryToken();

    const res = await fetch(`http://${host}:${port}${path}`, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(DAEMON_FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      log.warn(
        { path, status: res.status },
        "Daemon credential request returned non-ok status",
      );
    }

    return res;
  } catch (err) {
    log.warn(
      { path, error: err instanceof Error ? err.message : String(err) },
      "Daemon credential request error — falling back to direct access",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function deriveReadSecretRequest(account: string): {
  type: "api_key" | "credential";
  name: string;
} {
  if (account.startsWith(CREDENTIAL_KEY_PREFIX)) {
    const rest = account.slice(CREDENTIAL_KEY_PREFIX.length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx > 0 && slashIdx < rest.length - 1) {
      return {
        type: "credential",
        name: `${rest.slice(0, slashIdx)}:${rest.slice(slashIdx + 1)}`,
      };
    }
  }

  if (
    account.includes(":") &&
    !API_KEY_PROVIDERS.includes(account as (typeof API_KEY_PROVIDERS)[number])
  ) {
    return { type: "credential", name: account };
  }

  return { type: "api_key", name: account };
}

// ---------------------------------------------------------------------------
// Exported wrapper functions
// ---------------------------------------------------------------------------

/**
 * Retrieve a secret value from the daemon (via POST /v1/secrets/read with
 * reveal: true). Falls back to direct `getSecureKeyAsync()` when the daemon
 * is not running.
 */
export async function getSecureKeyViaDaemon(
  account: string,
): Promise<string | undefined> {
  const request = deriveReadSecretRequest(account);
  const res = await daemonFetch("/v1/secrets/read", {
    method: "POST",
    body: JSON.stringify({ ...request, reveal: true }),
  });

  if (res?.ok) {
    const json = (await res.json()) as { found: boolean; value?: string };
    return json.found ? json.value : undefined;
  }

  // Fall back to direct read when daemon is unreachable (null) OR returned
  // a non-ok response — reads are safe to retry via direct access.
  return getSecureKeyAsync(account);
}

/**
 * Retrieve a secret value with richer result metadata. Uses the daemon
 * POST /v1/secrets/read endpoint (reveal: true), falling back to
 * `getSecureKeyResultAsync()`.
 */
export async function getSecureKeyResultViaDaemon(
  account: string,
): Promise<SecureKeyResult> {
  const request = deriveReadSecretRequest(account);
  const res = await daemonFetch("/v1/secrets/read", {
    method: "POST",
    body: JSON.stringify({ ...request, reveal: true }),
  });

  if (res?.ok) {
    const json = (await res.json()) as {
      found: boolean;
      value?: string;
      unreachable?: boolean;
    };
    if (json.found && json.value != null) {
      return { value: json.value, unreachable: false };
    }
    return { value: undefined, unreachable: json.unreachable ?? false };
  }

  // Fall back to direct read when daemon is unreachable (null) OR returned
  // a non-ok response — reads are safe to retry via direct access.
  return getSecureKeyResultAsync(account);
}

/**
 * Store a secret via the daemon POST /v1/secrets endpoint. Falls back to
 * direct `setSecureKeyAsync()` when the daemon is not running.
 */
export async function setSecureKeyViaDaemon(
  type: string,
  name: string,
  value: string,
): Promise<boolean> {
  const res = await daemonFetch("/v1/secrets", {
    method: "POST",
    body: JSON.stringify({ type, name, value }),
  });

  if (res?.ok) {
    const json = (await res.json()) as { success: boolean };
    return json.success;
  }

  if (res) {
    // Daemon is running but deliberately rejected the write (e.g. 422
    // validation failure, 400 bad input). Do NOT fall back — the daemon's
    // rejection is authoritative and bypassing it would skip validation.
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
 * Delete a secret via the daemon DELETE /v1/secrets endpoint. Falls back to
 * direct `deleteSecureKeyAsync()` when the daemon is not running.
 */
export async function deleteSecureKeyViaDaemon(
  type: string,
  name: string,
): Promise<DeleteResult> {
  const res = await daemonFetch("/v1/secrets", {
    method: "DELETE",
    body: JSON.stringify({ type, name }),
  });

  if (res?.ok) {
    const json = (await res.json()) as { success: boolean };
    return json.success ? "deleted" : "error";
  }

  if (res) {
    // Daemon is running but rejected the delete. Map common status codes
    // to appropriate results without falling back to direct access.
    if (res.status === 404) return "not-found";
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
