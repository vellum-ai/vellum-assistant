/**
 * Unified secure key storage — single-writer routing through CredentialBackend
 * adapters.
 *
 * Backend selection (`resolveBackend`) is the single decision point:
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

import { getLogger } from "../util/logger.js";
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
 * Production (VELLUM_DEV unset or "0") uses keychain when available.
 * Dev mode (VELLUM_DEV=1) always uses the encrypted file store.
 *
 * Once resolved, the backend does not change during the process lifetime.
 * Call `_resetBackend()` in tests to clear the cached resolution.
 */
function resolveBackend(): CredentialBackend {
  if (!_resolvedBackend) {
    if (process.env.VELLUM_DEV !== "1" && getKeychainBackend().isAvailable()) {
      _resolvedBackend = getKeychainBackend();
    } else {
      _resolvedBackend = getEncryptedStoreBackend();
    }
  }
  return _resolvedBackend;
}

/**
 * List all account names across both backends (async).
 *
 * When the primary backend is the keychain, this merges keys from the keychain
 * and the encrypted store (for legacy keys that haven't been migrated). The
 * result is deduplicated. When the primary backend is already the encrypted
 * store, only that store is queried.
 */
export async function listSecureKeysAsync(): Promise<string[]> {
  const backend = resolveBackend();
  const primaryKeys = await backend.list();

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
 * first. If the primary backend is the keychain, falls back to the encrypted
 * store for legacy keys that haven't been migrated.
 */
export async function getSecureKeyAsync(
  account: string,
): Promise<string | undefined> {
  const backend = resolveBackend();
  const result = await backend.get(account);
  if (result != null) return result;

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
 * Delete a secret from secure storage. Always attempts deletion on both
 * the keychain backend (if available) and the encrypted store backend,
 * regardless of routing mode. This cleans up legacy data from both stores.
 */
export async function deleteSecureKeyAsync(
  account: string,
): Promise<DeleteResult> {
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
// Test helpers
// ---------------------------------------------------------------------------

/** @internal Test-only: reset the cached backends so they're re-created. */
export function _resetBackend(): void {
  _keychain = undefined;
  _encryptedStore = undefined;
  _resolvedBackend = undefined;
}
