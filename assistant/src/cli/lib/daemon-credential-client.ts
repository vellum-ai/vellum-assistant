/**
 * CLI helper for credential operations that routes through the daemon HTTP API
 * when the daemon is running, falling back to direct secure-keys.ts reads
 * when it is not.
 *
 * Follows the daemon HTTP fetch pattern established in conversations.ts
 * (health check, JWT minting, HTTP call).
 */

import providerEnvVarsRegistry from "../../../../meta/provider-env-vars.json" with { type: "json" };
import { getRuntimeHttpHost, getRuntimeHttpPort } from "../../config/env.js";
import {
  healthCheckHost,
  isHttpHealthy,
} from "../../daemon/daemon-control.js";
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
  listSecureKeysAsync,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("daemon-credential-client");

const PROVIDER_ENV_VARS: Record<string, string> =
  providerEnvVarsRegistry.providers;

// ---------------------------------------------------------------------------
// Private daemon fetch helper
// ---------------------------------------------------------------------------

/**
 * Attempt an authenticated HTTP request to the running daemon.
 *
 * Returns the Response on success, or `null` if the daemon is not reachable
 * or the request fails for any reason. Callers fall back to direct
 * secure-keys.ts when this returns `null`.
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
    });

    if (!res.ok) {
      log.warn(
        { path, status: res.status },
        "Daemon credential request failed — falling back to direct access",
      );
      return null;
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

/**
 * Derive the canonical credential storage key from a "service:field" name.
 * Mirrors the parsing in secret-routes.ts handleAddSecret / handleDeleteSecret.
 */
function deriveCredentialStorageKey(name: string): string {
  const colonIdx = name.indexOf(":");
  if (colonIdx < 1 || colonIdx === name.length - 1) {
    // Malformed — return raw name so the caller stores *something*.
    // The daemon would reject this with a 400, so this only fires in
    // the offline fallback path with bad input.
    return name;
  }
  const service = name.slice(0, colonIdx);
  const field = name.slice(colonIdx + 1);
  return credentialKey(service, field);
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
  const res = await daemonFetch("/v1/secrets/read", {
    method: "POST",
    body: JSON.stringify({ type: "api_key", name: account, reveal: true }),
  });

  if (res) {
    const json = (await res.json()) as { found: boolean; value?: string };
    return json.found ? json.value : undefined;
  }

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
  const res = await daemonFetch("/v1/secrets/read", {
    method: "POST",
    body: JSON.stringify({ type: "api_key", name: account, reveal: true }),
  });

  if (res) {
    const json = (await res.json()) as { found: boolean; value?: string };
    if (json.found && json.value != null) {
      return { value: json.value, unreachable: false };
    }
    return { value: undefined, unreachable: false };
  }

  return getSecureKeyResultAsync(account);
}

/**
 * Retrieve a masked version of a secret value. Uses the daemon
 * POST /v1/secrets/read endpoint (without reveal), falling back to
 * a direct read + local masking.
 */
export async function getMaskedKeyViaDaemon(
  account: string,
): Promise<string | null> {
  const res = await daemonFetch("/v1/secrets/read", {
    method: "POST",
    body: JSON.stringify({ type: "api_key", name: account }),
  });

  if (res) {
    const json = (await res.json()) as {
      found: boolean;
      masked?: string;
    };
    return json.found && json.masked ? json.masked : null;
  }

  // Fallback: direct read + local masking (same logic as daemon)
  const key = await getSecureKeyAsync(account);
  if (!key || key.length === 0) return null;
  const minHidden = 3;
  const maxVisible = Math.max(1, key.length - minHidden);
  const prefixLen = Math.min(10, maxVisible);
  const suffixLen = Math.min(4, Math.max(0, maxVisible - prefixLen));
  return `${key.slice(0, prefixLen)}...${suffixLen > 0 ? key.slice(-suffixLen) : ""}`;
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

  if (res) {
    const json = (await res.json()) as { success: boolean };
    return json.success;
  }

  // For credentials, derive the canonical storage key (credential/service/field)
  // to match the daemon path which uses credentialKey().
  const storageKey = type === "credential" ? deriveCredentialStorageKey(name) : name;
  return setSecureKeyAsync(storageKey, value);
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

  if (res) {
    const json = (await res.json()) as { success: boolean };
    return json.success ? "deleted" : "error";
  }

  // For credentials, derive the canonical storage key (credential/service/field)
  // to match the daemon path which uses credentialKey().
  const storageKey = type === "credential" ? deriveCredentialStorageKey(name) : name;
  return deleteSecureKeyAsync(storageKey);
}

/**
 * List all credential accounts via the daemon GET /v1/secrets endpoint.
 * Falls back to direct `listSecureKeysAsync()` when the daemon is not running.
 */
export async function listSecureKeysViaDaemon(): Promise<string[]> {
  const res = await daemonFetch("/v1/secrets", {
    method: "GET",
  });

  if (res) {
    const json = (await res.json()) as { accounts: string[] };
    return json.accounts;
  }

  return listSecureKeysAsync();
}

/**
 * Retrieve a provider API key via the daemon, with env var fallback.
 *
 * Mirrors the behavior of `getProviderKeyAsync()` from secure-keys.ts:
 * first checks the secure store (via daemon), then falls back to the
 * corresponding `<PROVIDER>_API_KEY` environment variable.
 */
export async function getProviderKeyViaDaemon(
  provider: string,
): Promise<string | undefined> {
  const stored = await getSecureKeyViaDaemon(provider);
  if (stored) return stored;
  const envVar = PROVIDER_ENV_VARS[provider];
  return envVar ? process.env[envVar] : undefined;
}
