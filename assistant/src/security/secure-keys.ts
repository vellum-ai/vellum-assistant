/**
 * Unified secure key storage — single-backend routing through CredentialBackend
 * adapters.
 *
 * Backend selection (`resolveBackendAsync`) is the single async decision point:
 *   1. CES RPC (primary) — injected via `setCesClient()`: delegates credential
 *      operations to the CES process over stdio RPC. This is the default path
 *      for local modes and the managed bootstrap handshake path.
 *   2. CES HTTP — containerized mode (IS_CONTAINERIZED + CES_CREDENTIAL_URL):
 *      delegates to the CES sidecar over HTTP. Used in Docker/managed mode,
 *      including failover when the bootstrap RPC transport dies later.
 *   3. Encrypted file store (fallback) — used when CES is unavailable.
 *
 * All operations (reads, writes, lists, deletes) go to exactly one backend.
 * There are no cross-store fallbacks or merges. The only transport failover is
 * CES RPC → CES HTTP in managed mode; both backends target the same CES
 * sidecar and credential data.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type {
  SecureKeyBackend,
  SecureKeyDeleteResult,
} from "@vellumai/credential-storage";

import { getIsContainerized } from "../config/env-registry.js";
import type { CesClient } from "../credential-execution/client.js";
import { getAnyProviderEnvVar } from "../providers/provider-env-vars.js";
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

/** Optional listener invoked whenever setCesClient() updates the client. */
let _cesClientListener: ((client: CesClient | undefined) => void) | undefined;

/** Epoch ms of the last reconnection attempt. Used for cooldown. */
let _lastReconnectAttempt = 0;

/** In-flight reconnection promise — concurrent callers share the same attempt. */
let _reconnectInFlight: Promise<boolean> | undefined;

/**
 * Per-async-context flag set while we are running the user-registered
 * `_cesReconnect` callback. Reentrant credential reads from within the
 * callback (on the same async call chain) must not `await`
 * `_reconnectInFlight` — that would await the caller's own reconnect and
 * deadlock until `CREDENTIAL_OP_TIMEOUT_MS` (45s) fires. Using
 * AsyncLocalStorage (rather than a module-level boolean) scopes the guard
 * to the actual reentrant stack, so unrelated concurrent callers keep
 * sharing the in-flight reconnect promise normally.
 */
const _reconnectContext = new AsyncLocalStorage<true>();

/**
 * Set to true when a ces-http operation returns an unreachable result.
 * Triggers CES RPC reconnection on the next resolveBackendAsync() call so
 * we don't keep routing to a dead HTTP endpoint. Cleared on reconnection or
 * backend reset.
 */
let _cesHttpUnreachable = false;

/** Minimum interval between CES reconnection attempts. */
const RECONNECT_COOLDOWN_MS = 3_000;

/**
 * Hard timeout for each public credential operation (resolve + backend call).
 * Prevents indefinite blocking when CES reconnection or backend operations hang.
 *
 * Set to 45s to comfortably cover the CES HTTP set worst case (~34s:
 * 3 fetch attempts × 10s REQUEST_TIMEOUT_MS + 2 × 2s SET_RETRY_DELAY_MS).
 */
const CREDENTIAL_OP_TIMEOUT_MS = 45_000;

/** Inject a CES RPC client for credential routing. Resets the resolved backend. */
export function setCesClient(client: CesClient | undefined): void {
  _cesClient = client;
  // Reset resolved backend so next call picks up CES
  _resolvedBackend = undefined;
  _resolvePromise = undefined;
  _cesHttpUnreachable = false;
  _cesClientListener?.(client);
}

/**
 * Register a listener that is called whenever setCesClient() updates the
 * CES client reference. Used by lifecycle.ts to keep DaemonServer in sync
 * after a successful reconnection.
 */
export function onCesClientChanged(
  fn: ((client: CesClient | undefined) => void) | undefined,
): void {
  _cesClientListener = fn;
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
 * In managed mode, if the CES bootstrap RPC transport dies, we first fail
 * over from CES RPC to the CES HTTP credential API exposed by the same
 * sidecar. This avoids pinning credential reads to a dead bootstrap socket
 * when the in-pod HTTP interface is still healthy.
 *
 * If HTTP failover is unavailable, we attempt CES RPC reconnection. When
 * reconnection succeeds the cache is refreshed with the new client.
 *
 * If neither recovery path succeeds, the existing unavailable backend is
 * returned — its methods short-circuit via `isAvailable()` guards and return
 * `unreachable` results so callers can degrade gracefully.
 *
 * Additionally, if CES failed on initial startup (so the encrypted file
 * store became the resolved backend) but the reconnection callback is
 * registered, we periodically attempt to upgrade to CES — ensuring managed
 * cloud deployments don't stay on the (potentially stale) file store.
 *
 * Call `_resetBackend()` in tests to clear the cached resolution.
 */
async function resolveBackendAsync(): Promise<CredentialBackend> {
  if (_resolvedBackend) {
    if (!_resolvedBackend.isAvailable()) {
      const cesHttpFallback = tryFailoverToCesHttpBackend(_resolvedBackend);
      if (cesHttpFallback) {
        return cesHttpFallback;
      }

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
    } else if (
      _cesReconnect &&
      (_resolvedBackend.name === "encrypted-store" ||
        (_resolvedBackend.name === "ces-http" && _cesHttpUnreachable))
    ) {
      // CES RPC is the preferred backend. Attempt to reconnect when:
      // - We fell back to the encrypted store (CES startup failed), or
      // - We're on ces-http but an operation returned unreachable (HTTP
      //   endpoint is actually down even though isAvailable() returned true,
      //   since it only checks env vars, not actual connectivity).
      const reconnected = await attemptCesReconnection();
      if (reconnected) {
        // setCesClient() cleared the cache — fall through to re-resolve.
      } else {
        // Reconnection failed or on cooldown — continue with current backend.
        return _resolvedBackend;
      }
    } else {
      return _resolvedBackend;
    }
  }
  if (!_resolvePromise) {
    _resolvePromise = doResolveBackend();
  }
  return _resolvePromise;
}

function tryFailoverToCesHttpBackend(
  backend: CredentialBackend,
): CredentialBackend | undefined {
  if (backend.name !== "ces-rpc") return undefined;
  if (!getIsContainerized() || !process.env.CES_CREDENTIAL_URL) {
    return undefined;
  }

  const cesHttp = createCesCredentialBackend();
  if (!cesHttp.isAvailable()) return undefined;

  _resolvedBackend = cesHttp;
  _resolvePromise = undefined;
  log.warn(
    "CES RPC credential backend became unavailable — failing over to CES HTTP backend",
  );
  return cesHttp;
}

/**
 * Try to re-establish a CES connection when the current transport has died.
 * Returns true if reconnection succeeded (setCesClient was called with a
 * new client), false otherwise.
 *
 * Concurrent callers share the same in-flight reconnection attempt to avoid
 * racing on the same process manager. A timestamp cooldown prevents rapid
 * back-to-back attempts after completion.
 */
async function attemptCesReconnection(): Promise<boolean> {
  if (!_cesReconnect) return false;

  // Reentrancy guard. A nested credential read from inside the reconnect
  // callback must not `await` our own in-flight promise — that would
  // deadlock on the 45-second credential-op timeout. Report the reconnect
  // as failed so the caller sees "unreachable" and falls back (env vars,
  // dead-backend response) without blocking. Concurrent callers on other
  // async chains don't see the ALS store, so they still share the
  // in-flight promise normally.
  if (_reconnectContext.getStore()) return false;

  // If a reconnection is already in flight, share it.
  if (_reconnectInFlight) return _reconnectInFlight;

  // Cooldown — don't retry immediately after a completed attempt.
  if (Date.now() - _lastReconnectAttempt < RECONNECT_COOLDOWN_MS) return false;

  _lastReconnectAttempt = Date.now();
  log.warn("Credential backend unavailable — attempting CES reconnection");

  _reconnectInFlight = _reconnectContext.run(true, async () => {
    try {
      const newClient = await _cesReconnect!();
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
  });

  try {
    return await _reconnectInFlight;
  } finally {
    _reconnectInFlight = undefined;
  }
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
 * Update the ces-http reachability latch after any get/list operation.
 * Sets `_cesHttpUnreachable = true` on failure so the next
 * resolveBackendAsync() call triggers a CES RPC reconnection attempt.
 * Clears it on success so a transient blip doesn't cause endless churn.
 */
function updateCesHttpReachability(
  backend: CredentialBackend,
  unreachable: boolean,
): void {
  if (backend.name === "ces-http") {
    _cesHttpUnreachable = unreachable;
  }
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

const CREDENTIAL_TIMEOUT_MSG = "Credential operation timed out";

/**
 * Race a credential operation against a hard deadline. If the operation
 * does not settle within `CREDENTIAL_OP_TIMEOUT_MS`, return the supplied
 * fallback value so callers degrade gracefully instead of hanging.
 *
 * Non-timeout errors from `op()` are propagated to callers rather than
 * silently swallowed — only genuine timeouts return the fallback.
 */
async function withCredentialTimeout<T>(
  op: () => Promise<T>,
  fallback: T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      log.warn(CREDENTIAL_TIMEOUT_MSG + " — returning fallback");
      resolve(fallback);
    }, CREDENTIAL_OP_TIMEOUT_MS);

    op().then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * List all account names from the resolved backend (async).
 *
 * Queries exactly one backend — no cross-store merge.
 */
export async function listSecureKeysAsync(): Promise<CredentialListResult> {
  return withCredentialTimeout(
    async () => {
      const backend = await resolveBackendAsync();
      const result = await backend.list();
      updateCesHttpReachability(backend, result.unreachable);
      return result;
    },
    { accounts: [], unreachable: true },
  );
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
  return withCredentialTimeout(
    async () => {
      const backend = await resolveBackendAsync();
      const result = await backend.get(account);
      updateCesHttpReachability(backend, result.unreachable);
      if (result.value != null) {
        return { value: result.value, unreachable: false };
      }
      return { value: undefined, unreachable: result.unreachable };
    },
    { value: undefined, unreachable: true },
  );
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
  return withCredentialTimeout(async () => {
    const backend = await resolveBackendAsync();
    const ok = await backend.set(account, value);
    if (!ok) {
      log.warn(
        { account, backend: backend.name },
        "Credential backend set failed",
      );
    }
    updateCesHttpReachability(backend, !ok);
    return ok;
  }, false);
}

/**
 * Delete a secret from secure storage.
 *
 * Deletes from exactly one backend — no cross-store cleanup.
 */
export async function deleteSecureKeyAsync(
  account: string,
): Promise<DeleteResult> {
  return withCredentialTimeout(async () => {
    const backend = await resolveBackendAsync();
    const result = await backend.delete(account);
    updateCesHttpReachability(backend, result === "error");
    return result;
  }, "error");
}

/**
 * Bulk-set multiple credentials in a single operation.
 *
 * Uses the backend's native `bulkSet` when available (CES RPC / HTTP),
 * otherwise falls back to individual `set` calls.
 */
export async function bulkSetSecureKeysAsync(
  credentials: Array<{ account: string; value: string }>,
): Promise<Array<{ account: string; ok: boolean }>> {
  return withCredentialTimeout(
    async () => {
      const backend = await resolveBackendAsync();
      if (backend.bulkSet) {
        const results = await backend.bulkSet(credentials);
        const anyFailed = results.some((r) => !r.ok);
        updateCesHttpReachability(backend, anyFailed);
        return results;
      }
      // Fallback: loop individual sets
      const results = [];
      let anyFailed = false;
      for (const { account, value } of credentials) {
        const ok = await backend.set(account, value);
        if (!ok) anyFailed = true;
        results.push({ account, ok });
      }
      updateCesHttpReachability(backend, anyFailed);
      return results;
    },
    credentials.map((c) => ({ account: c.account, ok: false })),
  );
}

// ---------------------------------------------------------------------------
// Provider API key lookup — secure store + env var fallback
// ---------------------------------------------------------------------------

/**
 * Retrieve a provider API key, checking secure storage first and falling
 * back to the corresponding `<PROVIDER>_API_KEY` environment variable.
 *
 * Env var names are resolved via `getAnyProviderEnvVar`, which covers both
 * LLM providers (sourced from `PROVIDER_CATALOG`) and search providers
 * (sourced from `SEARCH_PROVIDER_ENV_VAR_NAMES`). Keyless providers (e.g.
 * Ollama) return `undefined` and fall through to a stored-only lookup.
 *
 * Use this instead of raw `getSecureKeyAsync` when looking up provider
 * API keys so that env-var-only setups continue to work.
 */
export async function getProviderKeyAsync(
  provider: string,
): Promise<string | undefined> {
  const stored = await getSecureKeyAsync(provider);
  if (stored) return stored;
  const envVar = getAnyProviderEnvVar(provider);
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
  _cesClientListener = undefined;
  _lastReconnectAttempt = 0;
  _reconnectInFlight = undefined;
  _cesHttpUnreachable = false;
}
