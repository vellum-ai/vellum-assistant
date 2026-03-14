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

import { getLogger } from "../util/logger.js";
import type { CredentialBackend, DeleteResult } from "./credential-backend.js";
import {
  createEncryptedStoreBackend,
  createKeychainBackend,
} from "./credential-backend.js";
import * as encryptedStore from "./encrypted-store.js";

export type { DeleteResult } from "./credential-backend.js";

const log = getLogger("secure-keys");

let _keychain: CredentialBackend | undefined;
let _encryptedStore: CredentialBackend | undefined;

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
 */
function resolveBackend(): CredentialBackend {
  if (process.env.VELLUM_DEV !== "1" && getKeychainBackend().isAvailable()) {
    return getKeychainBackend();
  }
  return getEncryptedStoreBackend();
}

/**
 * List all account names in secure storage (sync — encrypted store only).
 * Throws if the store file exists but cannot be read.
 */
export function listSecureKeys(): string[] {
  return encryptedStore.listKeys();
}

// ---------------------------------------------------------------------------
// Backend introspection
// ---------------------------------------------------------------------------

/**
 * Return the currently resolved backend type.
 * Returns `"broker"` when VELLUM_DEV !== "1" and keychain backend is available,
 * `"encrypted"` otherwise.
 */
export function getBackendType(): "broker" | "encrypted" | null {
  const backend = resolveBackend();
  return backend.name === "keychain" ? "broker" : "encrypted";
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
}
