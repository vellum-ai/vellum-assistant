/**
 * Unified secure key storage — tries OS keychain first, falls back to
 * encrypted-at-rest file storage.
 *
 * Provides the same get/set/delete/list interface used by both backends.
 * Backend selection is cached after the first call for the process lifetime.
 */

import * as keychain from './keychain.js';
import * as encryptedStore from './encrypted-store.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('secure-keys');

type Backend = 'keychain' | 'encrypted' | null;
let resolvedBackend: Backend | undefined;
/** True when backend was downgraded from keychain to encrypted at runtime. */
let downgradedFromKeychain = false;

function getBackend(): Backend {
  if (resolvedBackend !== undefined) return resolvedBackend;

  if (keychain.isKeychainAvailable()) {
    log.debug('Using OS keychain for secure key storage');
    resolvedBackend = 'keychain';
  } else {
    log.debug('OS keychain unavailable, using encrypted file storage');
    resolvedBackend = 'encrypted';
  }
  return resolvedBackend;
}

/**
 * Try a keychain operation; on failure, permanently downgrade to encrypted
 * backend and retry. This handles systems where the keychain CLI exists
 * but is unusable at runtime (headless/locked sessions).
 */
function withKeychainFallback<T>(
  keychainFn: () => T,
  encryptedFn: () => T,
  fallbackValue: T,
): T {
  const backend = getBackend();
  if (backend === 'encrypted') return encryptedFn();
  if (backend !== 'keychain') return fallbackValue;

  const result = keychainFn();
  // keychain.setKey/deleteKey return false on failure.
  // We downgrade on failures (false) to switch to encrypted backend.
  if (result === false) {
    log.warn('Keychain operation failed at runtime, falling back to encrypted file storage');
    resolvedBackend = 'encrypted';
    downgradedFromKeychain = true;
    return encryptedFn();
  }
  return result;
}

/**
 * Retrieve a secret from secure storage.
 * Returns `undefined` if the key doesn't exist or on error.
 */
export function getSecureKey(account: string): string | undefined {
  const backend = getBackend();
  if (backend === 'keychain') {
    try {
      return keychain.getKey(account) ?? undefined;
    } catch {
      // Keychain runtime error on read — downgrade to encrypted store
      log.warn('Keychain read failed at runtime, falling back to encrypted file storage');
      resolvedBackend = 'encrypted';
      downgradedFromKeychain = true;
      return encryptedStore.getKey(account);
    }
  }
  if (backend === 'encrypted') {
    const value = encryptedStore.getKey(account);
    // After a runtime downgrade, keys may still exist in the keychain.
    // Try keychain read as fallback so pre-downgrade keys remain accessible.
    if (value === undefined && downgradedFromKeychain) {
      try {
        return keychain.getKey(account) ?? undefined;
      } catch {
        return undefined;
      }
    }
    return value;
  }
  return undefined;
}

/**
 * Store a secret in secure storage.
 * Returns `true` on success, `false` on failure.
 */
export function setSecureKey(account: string, value: string): boolean {
  return withKeychainFallback(
    () => keychain.setKey(account, value),
    () => encryptedStore.setKey(account, value),
    false,
  );
}

/**
 * Delete a secret from secure storage.
 * Returns `true` on success, `false` if not found or on error.
 */
export function deleteSecureKey(account: string): boolean {
  const backend = getBackend();
  if (backend === 'encrypted') {
    const result = encryptedStore.deleteKey(account);
    // After a runtime downgrade, keys may still exist in the keychain.
    // Attempt best-effort cleanup so stale credentials don't linger.
    if (downgradedFromKeychain) {
      keychain.deleteKey(account); // best-effort, ignore result
    }
    return result;
  }
  if (backend !== 'keychain') return false;

  // keychain.deleteKey returns false for both "not found" and "runtime error".
  // Check existence first so a missing key doesn't spuriously downgrade the
  // backend — saveConfig routinely deletes keys for unset providers.
  // getKey now returns null for "not found" and throws on runtime errors.
  try {
    if (keychain.getKey(account) === null) {
      return false;
    }
  } catch {
    // Keychain runtime error — fall through to withKeychainFallback which
    // will handle the downgrade when deleteKey also fails.
  }

  return withKeychainFallback(
    () => keychain.deleteKey(account),
    () => encryptedStore.deleteKey(account),
    false,
  );
}

/**
 * List all account names in secure storage.
 * Only supported by the encrypted backend; keychain returns empty array.
 */
export function listSecureKeys(): string[] {
  const backend = getBackend();
  if (backend === 'encrypted') return encryptedStore.listKeys();
  // OS keychains don't provide a list API scoped to our service
  return [];
}

/**
 * Return the currently resolved backend type.
 * Useful for feature-gating behaviour that only works on certain backends.
 */
export function getBackendType(): 'keychain' | 'encrypted' | null {
  return getBackend();
}

/** @internal Test-only: reset the cached backend so it's re-evaluated. */
export function _resetBackend(): void {
  resolvedBackend = undefined;
  downgradedFromKeychain = false;
}

/** @internal Test-only: force a specific backend. Pass `undefined` to reset. */
export function _setBackend(backend: Backend | undefined): void {
  resolvedBackend = backend;
  downgradedFromKeychain = false;
}
