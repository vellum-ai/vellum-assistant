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
 * Retrieve a secret from secure storage.
 * Returns `undefined` if the key doesn't exist or on error.
 */
export function getSecureKey(account: string): string | undefined {
  const backend = getBackend();
  if (backend === 'keychain') return keychain.getKey(account);
  if (backend === 'encrypted') return encryptedStore.getKey(account);
  return undefined;
}

/**
 * Store a secret in secure storage.
 * Returns `true` on success, `false` on failure.
 */
export function setSecureKey(account: string, value: string): boolean {
  const backend = getBackend();
  if (backend === 'keychain') return keychain.setKey(account, value);
  if (backend === 'encrypted') return encryptedStore.setKey(account, value);
  return false;
}

/**
 * Delete a secret from secure storage.
 * Returns `true` on success, `false` if not found or on error.
 */
export function deleteSecureKey(account: string): boolean {
  const backend = getBackend();
  if (backend === 'keychain') return keychain.deleteKey(account);
  if (backend === 'encrypted') return encryptedStore.deleteKey(account);
  return false;
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

/** @internal Test-only: reset the cached backend so it's re-evaluated. */
export function _resetBackend(): void {
  resolvedBackend = undefined;
}

/** @internal Test-only: force a specific backend. Pass `undefined` to reset. */
export function _setBackend(backend: Backend | undefined): void {
  resolvedBackend = backend;
}
