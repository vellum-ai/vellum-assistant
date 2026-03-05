/**
 * Unified secure key storage — encrypted-at-rest file storage.
 *
 * Provides get/set/delete/list interface backed by the encrypted store.
 */

import * as encryptedStore from "./encrypted-store.js";

/**
 * Retrieve a secret from secure storage.
 * Returns `undefined` if the key doesn't exist or on error.
 */
export function getSecureKey(account: string): string | undefined {
  return encryptedStore.getKey(account);
}

/**
 * Store a secret in secure storage.
 * Returns `true` on success, `false` on failure.
 */
export function setSecureKey(account: string, value: string): boolean {
  return encryptedStore.setKey(account, value);
}

/**
 * Delete a secret from secure storage.
 * Returns `true` on success, `false` if not found or on error.
 */
export function deleteSecureKey(account: string): boolean {
  return encryptedStore.deleteKey(account);
}

/**
 * List all account names in secure storage.
 * Throws if the store file exists but cannot be read (encrypted backend).
 */
export function listSecureKeys(): string[] {
  return encryptedStore.listKeys();
}

/**
 * Return the currently resolved backend type.
 * Always returns "encrypted" now that keychain CLI is removed.
 */
export function getBackendType(): "keychain" | "encrypted" | null {
  return "encrypted";
}

/**
 * Whether the backend was downgraded from keychain to encrypted at runtime.
 * Always returns false now that keychain CLI is removed.
 */
export function isDowngradedFromKeychain(): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// Async variants — thin wrappers around sync calls since the encrypted
// store uses synchronous file I/O.
// ---------------------------------------------------------------------------

/**
 * Async version of `getSecureKey` — retrieve a secret without blocking.
 */
export async function getSecureKeyAsync(
  account: string,
): Promise<string | undefined> {
  return getSecureKey(account);
}

/**
 * Async version of `setSecureKey` — store a secret without blocking.
 */
export async function setSecureKeyAsync(
  account: string,
  value: string,
): Promise<boolean> {
  return setSecureKey(account, value);
}

/**
 * Async version of `deleteSecureKey` — delete a secret without blocking.
 */
export async function deleteSecureKeyAsync(account: string): Promise<boolean> {
  return deleteSecureKey(account);
}

/** @internal Test-only: reset the cached backend so it's re-evaluated. */
export function _resetBackend(): void {
  // No-op — encrypted store is always the backend.
}

/** @internal Test-only: force a specific backend. Pass `undefined` to reset. */
export function _setBackend(
  _backend: "keychain" | "encrypted" | null | undefined,
): void {
  // No-op — kept for test compatibility.
}
