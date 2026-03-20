/**
 * Unified secure key storage — single-writer routing through CredentialBackend
 * adapters.
 *
 * Backend selection (`resolveBackend`) is the single decision point:
 *   - Containerized (IS_CONTAINERIZED + CES_CREDENTIAL_URL set): CES HTTP client.
 *   - Production (VELLUM_DEV unset or "0"): keychain backend when available.
 *   - Dev mode (VELLUM_DEV=1): encrypted file store always.
 *
 * Writes go to exactly one backend (no dual-writing). Reads in keychain mode
 * fall back to the encrypted store for keys that haven't been migrated yet.
 * Deletes clean up both stores regardless of mode.
 */

import type {
  SecureKeyBackend,
  SecureKeyDeleteResult,
} from "@vellumai/credential-storage";

import providerEnvVarsRegistry from "../../../meta/provider-env-vars.json" with { type: "json" };
import { getIsContainerized } from "../config/env-registry.js";
import { getLogger } from "../util/logger.js";
import { createCesCredentialBackend } from "./ces-credential-client.js";
import type { CredentialBackend, DeleteResult } from "./credential-backend.js";
import {
  createEncryptedStoreBackend,
  createKeychainBackend,
} from "./credential-backend.js";

export type { DeleteResult } from "./credential-backend.js";

/**
 * Re-export shared-package secure-key abstractions so downstream consumers
 * can import from this module without a direct @vellumai/credential-storage
 * dependency.
 */
export type { SecureKeyBackend, SecureKeyDeleteResult };

const log = getLogger("secure-keys");

let _keychain: CredentialBackend | undefined;
let _encryptedStore: CredentialBackend | undefined;
let _resolvedBackend: CredentialBackend | undefined;

function getKeychainBackend(): CredentialBackend {
  if (!_keychain) _keychain = createKeychainBackend();
  return _keychain;
}

function getEncryptedStoreBackend(): CredentialBackend {
  if (!_encryptedStore) _encryptedStore = createEncryptedStoreBackend();
  return _encryptedStore;
}

/**
 * Resolve the primary credential backend for this process.
 *
 * Priority:
 *   1. Containerized + CES_CREDENTIAL_URL → CES HTTP client (skip keychain
 *      and encrypted store entirely — the sidecar owns credential storage).
 *   2. Production (VELLUM_DEV unset or "0") → keychain when available.
 *   3. Dev mode (VELLUM_DEV=1) → encrypted file store always.
 *
 * Once resolved, the backend does not change during the process lifetime.
 * Call `_resetBackend()` in tests to clear the cached resolution.
 */
function resolveBackend(): CredentialBackend {
  if (!_resolvedBackend) {
    if (getIsContainerized() && process.env.CES_CREDENTIAL_URL) {
      const ces = createCesCredentialBackend();
      if (ces.isAvailable()) {
        _resolvedBackend = ces;
      } else {
        log.warn(
          "CES_CREDENTIAL_URL is set but CES backend is not available — " +
            "falling back to local credential store",
        );
      }
    }

    if (!_resolvedBackend) {
      if (
        process.env.VELLUM_DEV !== "1" &&
        getKeychainBackend().isAvailable()
      ) {
        _resolvedBackend = getKeychainBackend();
      } else {
        _resolvedBackend = getEncryptedStoreBackend();
      }
    }
  }
  return _resolvedBackend;
}

/**
 * List all account names across both backends (async).
 *
 * In CES mode, only the CES backend is queried — there are no local stores.
 *
 * When the primary backend is the keychain, this merges keys from the keychain
 * and the encrypted store (for legacy keys that haven't been migrated). The
 * result is deduplicated. When the primary backend is already the encrypted
 * store, only that store is queried.
 */
export async function listSecureKeysAsync(): Promise<string[]> {
  const backend = resolveBackend();
  const primaryKeys = await backend.list();

  // CES mode — the sidecar is the single source of truth, no local merge.
  if (backend.name === "ces-http") return primaryKeys;

  // If primary backend is NOT the encrypted store, also check
  // the encrypted store for legacy keys that haven't been migrated.
  if (backend !== getEncryptedStoreBackend()) {
    const encKeys = await getEncryptedStoreBackend().list();
    const merged = new Set([...primaryKeys, ...encKeys]);
    return Array.from(merged);
  }

  return primaryKeys;
}

// ---------------------------------------------------------------------------
// Async CRUD — single-writer routing
// ---------------------------------------------------------------------------

/**
 * Retrieve a secret from secure storage. Reads from the primary backend
 * first. In CES mode, the sidecar is the single source of truth — no
 * local fallback. In local mode, if the primary backend is the keychain,
 * falls back to the encrypted store for legacy keys that haven't been
 * migrated.
 */
export async function getSecureKeyAsync(
  account: string,
): Promise<string | undefined> {
  const backend = resolveBackend();
  const result = await backend.get(account);
  if (result != null) return result;

  // CES mode — no local fallback.
  if (backend.name === "ces-http") return undefined;

  // Legacy fallback: if primary backend is NOT the encrypted store,
  // check the encrypted store for keys that haven't been migrated.
  if (backend !== getEncryptedStoreBackend()) {
    return await getEncryptedStoreBackend().get(account);
  }

  return undefined;
}

/**
 * Store a secret in secure storage. Writes to exactly one backend —
 * no dual-writing.
 */
export async function setSecureKeyAsync(
  account: string,
  value: string,
): Promise<boolean> {
  const backend = resolveBackend();
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
 * In containerized mode with CES, deletion is routed exclusively through the
 * CES backend — there are no local stores to clean up.
 *
 * In local mode, always attempts deletion on both the keychain backend (if
 * available) and the encrypted store backend, regardless of routing mode.
 * This cleans up legacy data from both stores.
 */
export async function deleteSecureKeyAsync(
  account: string,
): Promise<DeleteResult> {
  const backend = resolveBackend();

  // In CES mode, the sidecar is the only store — no local cleanup needed.
  if (backend.name === "ces-http") {
    return backend.delete(account);
  }

  const keychain = getKeychainBackend();
  const enc = getEncryptedStoreBackend();

  let keychainResult: DeleteResult = "not-found";
  if (keychain.isAvailable()) {
    keychainResult = await keychain.delete(account);
  }

  const encResult = await enc.delete(account);

  // Return "error" if either errored
  if (keychainResult === "error" || encResult === "error") return "error";
  // Return "deleted" if either deleted
  if (keychainResult === "deleted" || encResult === "deleted") return "deleted";
  return "not-found";
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

/** @internal Test-only: reset the cached backends so they're re-created. */
export function _resetBackend(): void {
  _keychain = undefined;
  _encryptedStore = undefined;
  _resolvedBackend = undefined;
}
