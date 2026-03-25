/**
 * Unified secure key storage — single-backend routing through CredentialBackend
 * adapters.
 *
 * Backend selection (`resolveBackendAsync`) is the single async decision point:
 *   1. CES RPC (primary) — injected via `setCesClient()`: delegates credential
 *      operations to the CES process over stdio RPC. This is the default path
 *      for all local modes (desktop app, dev, CLI).
 *   2. CES HTTP — containerized mode (IS_CONTAINERIZED + CES_CREDENTIAL_URL):
 *      delegates to the CES sidecar over HTTP. Used in Docker/managed mode.
 *   3. Encrypted file store (fallback) — used when CES is unavailable.
 *
 * All operations (reads, writes, lists, deletes) go to exactly one backend.
 * There are no cross-backend fallbacks or merges.
 */

import type {
  SecureKeyBackend,
  SecureKeyDeleteResult,
} from "@vellumai/credential-storage";

import providerEnvVarsRegistry from "../../../meta/provider-env-vars.json" with { type: "json" };
import { getIsContainerized } from "../config/env-registry.js";
import type { CesClient } from "../credential-execution/client.js";
import { getLogger } from "../util/logger.js";
import { createCesCredentialBackend } from "./ces-credential-client.js";
import { CesRpcCredentialBackend } from "./ces-rpc-credential-backend.js";
import type {
  CredentialBackend,
  CredentialListResult,
  DeleteResult,
} from "./credential-backend.js";
import { createEncryptedStoreBackend } from "./credential-backend.js";

export type {
  CredentialListResult,
  DeleteResult,
} from "./credential-backend.js";

/**
 * Re-export shared-package secure-key abstractions so downstream consumers
 * can import from this module without a direct @vellumai/credential-storage
 * dependency.
 */
export type { SecureKeyBackend, SecureKeyDeleteResult };

export interface SecureKeyResult {
  value: string | undefined;
  unreachable: boolean;
}

const log = getLogger("secure-keys");

let _cesClient: CesClient | undefined;
let _encryptedStore: CredentialBackend | undefined;
let _resolvedBackend: CredentialBackend | undefined;
let _resolvePromise: Promise<CredentialBackend> | undefined;

/**
 * Optional callback that attempts to re-establish a CES connection when
 * the current transport dies. Set by lifecycle.ts after initial CES startup.
 * Returns a new CesClient on success, or undefined if reconnection failed.
 */
let _cesReconnect: (() => Promise<CesClient | undefined>) | undefined;

/** Epoch ms of the last reconnection attempt. Used for cooldown. */
let _lastReconnectAttempt = 0;

/** Minimum interval between CES reconnection attempts. */
const RECONNECT_COOLDOWN_MS = 10_000;

/** Inject a CES RPC client for credential routing. Resets the resolved backend. */
export function setCesClient(client: CesClient | undefined): void {
  _cesClient = client;
  // Reset resolved backend so next call picks up CES
  _resolvedBackend = undefined;
  _resolvePromise = undefined;
}

/** Register a callback for reconnecting to CES when the transport dies. */
export function setCesReconnect(
  fn: (() => Promise<CesClient | undefined>) | undefined,
): void {
  _cesReconnect = fn;
}

function getEncryptedStoreBackend(): CredentialBackend {
  if (!_encryptedStore) _encryptedStore = createEncryptedStoreBackend();
  return _encryptedStore;
}

/**
 * Resolve the primary credential backend for this process (async).
 *
 * Priority:
 *   1. CES RPC client → primary path for all local modes.
 *   2. Containerized + CES_CREDENTIAL_URL → CES HTTP client (Docker/managed).
 *   3. Encrypted file store → fallback when CES is unavailable.
 *
 * Once resolved, the backend is cached. If it becomes unavailable (e.g. the
 * CES transport dies), we attempt to reconnect via `_cesReconnect` rather
 * than falling back to a different backend. In managed cloud mode CES is the
 * primary credential source — falling back to the encrypted file store would
 * silently serve stale or empty data.
 *
 * If reconnection succeeds the cache is refreshed with the new client.
 * If reconnection fails (or is on cooldown) the existing unavailable backend
 * is returned — its methods short-circuit via `isAvailable()` guards and
 * return `unreachable` results so callers can degrade gracefully.
 *
 * Call `_resetBackend()` in tests to clear the cached resolution.
 */
async function resolveBackendAsync(): Promise<CredentialBackend> {
  if (_resolvedBackend) {
    if (_resolvedBackend.isAvailable()) return _resolvedBackend;

    // Backend is no longer reachable — attempt CES reconnection.
    const reconnected = await attemptCesReconnection();
    if (reconnected) {
      // setCesClient() cleared the cache — fall through to re-resolve
      // with the fresh client.
    } else {
      // Reconnection failed or on cooldown — return the existing (dead)
      // backend. Its methods short-circuit via isAvailable() guards and
      // return unreachable results. Callers like getProviderKeyAsync fall
      // back to env vars, and embedding backend selection uses cached
      // backends.
      return _resolvedBackend;
    }
  }
  if (!_resolvePromise) {
    _resolvePromise = doResolveBackend();
  }
  return _resolvePromise;
}

/**
 * Try to re-establish a CES connection when the current transport has died.
 * Returns true if reconnection succeeded (setCesClient was called with a
 * new client), false otherwise.
 *
 * Debounced by RECONNECT_COOLDOWN_MS to avoid reconnection storms when
 * many credential lookups hit a dead transport concurrently.
 */
async function attemptCesReconnection(): Promise<boolean> {
  if (!_cesReconnect) return false;
  if (Date.now() - _lastReconnectAttempt < RECONNECT_COOLDOWN_MS) return false;

  _lastReconnectAttempt = Date.now();
  log.warn("Credential backend unavailable — attempting CES reconnection");

  try {
    const newClient = await _cesReconnect();
    if (newClient) {
      setCesClient(newClient);
      log.info("CES reconnection successful — credential backend restored");
      return true;
    }
    log.warn("CES reconnection returned no client");
  } catch (err) {
    log.warn({ err }, "CES reconnection failed");
  }
  return false;
}

async function doResolveBackend(): Promise<CredentialBackend> {
  // 1. CES RPC — primary credential backend for all local modes
  if (_cesClient) {
    const cesRpc = new CesRpcCredentialBackend(_cesClient);
    if (cesRpc.isAvailable()) {
      _resolvedBackend = cesRpc;
      return cesRpc;
    }
    log.warn(
      "CES RPC client is set but not ready — falling back to local credential store",
    );
  }

  // 2. CES HTTP — containerized / Docker / managed mode
  if (getIsContainerized() && process.env.CES_CREDENTIAL_URL) {
    const ces = createCesCredentialBackend();
    if (ces.isAvailable()) {
      _resolvedBackend = ces;
      return ces;
    }
    log.warn(
      "CES_CREDENTIAL_URL is set but CES backend is not available — " +
        "falling back to local credential store",
    );
  }

  // 3. Encrypted file store — fallback when CES is unavailable
  _resolvedBackend = getEncryptedStoreBackend();
  return _resolvedBackend;
}

/**
 * List all account names from the resolved backend (async).
 *
 * Queries exactly one backend — no cross-store merge.
 */
export async function listSecureKeysAsync(): Promise<CredentialListResult> {
  const backend = await resolveBackendAsync();
  return backend.list();
}

// ---------------------------------------------------------------------------
// Async CRUD — single-backend routing
// ---------------------------------------------------------------------------

/**
 * Retrieve a secret from secure storage with richer result metadata.
 *
 * Returns both the value (if found) and whether the backend was
 * unreachable. Callers that need to distinguish "not found" from
 * "backend down" should use this instead of `getSecureKeyAsync`.
 *
 * Reads from exactly one backend — no cross-store fallback.
 */
export async function getSecureKeyResultAsync(
  account: string,
): Promise<SecureKeyResult> {
  const backend = await resolveBackendAsync();
  const result = await backend.get(account);
  if (result.value != null) {
    return { value: result.value, unreachable: false };
  }
  return { value: undefined, unreachable: result.unreachable };
}

/**
 * Retrieve a secret from secure storage. Convenience wrapper over
 * `getSecureKeyResultAsync` that returns only the value.
 */
export async function getSecureKeyAsync(
  account: string,
): Promise<string | undefined> {
  const result = await getSecureKeyResultAsync(account);
  return result.value;
}

/**
 * Store a secret in secure storage. Writes to exactly one backend —
 * no dual-writing.
 */
export async function setSecureKeyAsync(
  account: string,
  value: string,
): Promise<boolean> {
  const backend = await resolveBackendAsync();
  const ok = await backend.set(account, value);
  if (!ok) {
    log.warn(
      { account, backend: backend.name },
      "Credential backend set failed",
    );
  }
  return ok;
}

/**
 * Delete a secret from secure storage.
 *
 * Deletes from exactly one backend — no cross-store cleanup.
 */
export async function deleteSecureKeyAsync(
  account: string,
): Promise<DeleteResult> {
  const backend = await resolveBackendAsync();
  return backend.delete(account);
}

// ---------------------------------------------------------------------------
// Provider API key lookup — secure store + env var fallback
// ---------------------------------------------------------------------------

/**
 * Env var names keyed by provider. Loaded from the shared registry at
 * `meta/provider-env-vars.json` — the single source of truth also consumed
 * by the CLI and the macOS client.
 * Ollama is intentionally omitted from the registry — it doesn't require
 * an API key.
 */
const PROVIDER_ENV_VARS: Record<string, string> =
  providerEnvVarsRegistry.providers;

/**
 * Retrieve a provider API key, checking secure storage first and falling
 * back to the corresponding `<PROVIDER>_API_KEY` environment variable.
 *
 * Use this instead of raw `getSecureKeyAsync` when looking up provider
 * API keys so that env-var-only setups continue to work.
 */
export async function getProviderKeyAsync(
  provider: string,
): Promise<string | undefined> {
  const stored = await getSecureKeyAsync(provider);
  if (stored) return stored;
  const envVar = PROVIDER_ENV_VARS[provider];
  return envVar ? process.env[envVar] : undefined;
}

// ---------------------------------------------------------------------------
// Masked provider key — for safe display in client UIs
// ---------------------------------------------------------------------------

/**
 * Retrieve a provider API key and return a masked version suitable for
 * display. Shows the first 10 characters and last 4, with `...` in between,
 * always hiding at least 3 characters. Returns `null` if no key is stored.
 */
export async function getMaskedProviderKey(
  provider: string,
): Promise<string | null> {
  const key = await getProviderKeyAsync(provider);
  if (!key || key.length === 0) return null;
  const minHidden = 3;
  const maxVisible = Math.max(1, key.length - minHidden);
  const prefixLen = Math.min(10, maxVisible);
  const suffixLen = Math.min(4, Math.max(0, maxVisible - prefixLen));
  return `${key.slice(0, prefixLen)}...${suffixLen > 0 ? key.slice(-suffixLen) : ""}`;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Return the name of the currently resolved credential backend.
 * Useful for diagnostic messages when credential operations fail.
 */
export function getActiveBackendName(): string {
  return _resolvedBackend?.name ?? "none";
}

/** @internal Test-only: reset the cached backends so they're re-created. */
export function _resetBackend(): void {
  _cesClient = undefined;
  _encryptedStore = undefined;
  _resolvedBackend = undefined;
  _resolvePromise = undefined;
  _cesReconnect = undefined;
  _lastReconnectAttempt = 0;
}
