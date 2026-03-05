/**
 * Unified secure key storage — routes through the keychain broker when
 * available (macOS app embedded), with transparent fallback to the
 * encrypted-at-rest file store.
 *
 * Async variants try the broker first; sync variants always use the
 * encrypted store (startup code paths cannot do async I/O).
 */

import * as encryptedStore from "./encrypted-store.js";
import type { KeychainBrokerClient } from "./keychain-broker-client.js";
import { createBrokerClient } from "./keychain-broker-client.js";

let _broker: KeychainBrokerClient | undefined;

function getBroker(): KeychainBrokerClient {
  if (!_broker) _broker = createBrokerClient();
  return _broker;
}

// ---------------------------------------------------------------------------
// Sync variants — encrypted store only (startup / sync call sites)
// ---------------------------------------------------------------------------

/**
 * Retrieve a secret from secure storage (sync — encrypted store only).
 * Returns `undefined` if the key doesn't exist or on error.
 */
export function getSecureKey(account: string): string | undefined {
  return encryptedStore.getKey(account);
}

/**
 * Store a secret in secure storage (sync — encrypted store only).
 * Returns `true` on success, `false` on failure.
 */
export function setSecureKey(account: string, value: string): boolean {
  return encryptedStore.setKey(account, value);
}

/**
 * Delete a secret from secure storage (sync — encrypted store only).
 * Returns `true` on success, `false` if not found or on error.
 */
export function deleteSecureKey(account: string): boolean {
  return encryptedStore.deleteKey(account);
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
 * Returns `"broker"` when the keychain broker is reachable, `"encrypted"` otherwise.
 */
export function getBackendType(): "broker" | "encrypted" | null {
  return getBroker().isAvailable() ? "broker" : "encrypted";
}

/**
 * Whether the backend was downgraded from keychain to encrypted at runtime.
 * Always returns false now that keychain CLI is removed.
 */
export function isDowngradedFromKeychain(): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// Async variants — try broker first, fall back to encrypted store
// ---------------------------------------------------------------------------

/**
 * Async version of `getSecureKey`. When the broker is available it is
 * queried first; if it returns `undefined` (not found *or* error) the
 * encrypted store is consulted as a fallback.
 */
export async function getSecureKeyAsync(
  account: string,
): Promise<string | undefined> {
  const broker = getBroker();
  if (broker.isAvailable()) {
    const value = await broker.get(account);
    if (value !== undefined) return value;
  }
  return encryptedStore.getKey(account);
}

/**
 * Async version of `setSecureKey`. When the broker is available the key
 * is written there first; the encrypted store is always updated as well
 * so that sync callers have a consistent view.
 */
export async function setSecureKeyAsync(
  account: string,
  value: string,
): Promise<boolean> {
  const broker = getBroker();
  if (broker.isAvailable()) {
    const ok = await broker.set(account, value);
    if (ok) {
      // Also persist to encrypted store so sync callers stay consistent.
      encryptedStore.setKey(account, value);
      return true;
    }
  }
  return encryptedStore.setKey(account, value);
}

/**
 * Async version of `deleteSecureKey`. When the broker is available the
 * key is deleted there first; the encrypted store entry is always removed
 * as well so that sync callers have a consistent view.
 */
export async function deleteSecureKeyAsync(account: string): Promise<boolean> {
  const broker = getBroker();
  if (broker.isAvailable()) {
    const ok = await broker.del(account);
    if (ok) {
      // Also remove from encrypted store so sync callers stay consistent.
      encryptedStore.deleteKey(account);
      return true;
    }
  }
  return encryptedStore.deleteKey(account);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** @internal Test-only: reset the cached broker so it's re-created. */
export function _resetBackend(): void {
  _broker = undefined;
}

/** @internal Test-only: force a specific backend. Pass `undefined` to reset. */
export function _setBackend(
  _backend: "keychain" | "encrypted" | "broker" | null | undefined,
): void {
  // No-op — kept for test compatibility.
}
