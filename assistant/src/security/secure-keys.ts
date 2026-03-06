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
 * queried first. A `null` return from the broker means error (fall back
 * to encrypted store). A `{ found: false }` means the key definitively
 * does not exist in the keychain — no fall-through needed.
 */
export async function getSecureKeyAsync(
  account: string,
): Promise<string | undefined> {
  const broker = getBroker();
  if (broker.isAvailable()) {
    const result = await broker.get(account);
    // null = broker error, fall back to encrypted store
    if (result === null) return encryptedStore.getKey(account);
    // Broker responded — trust its answer
    return result.found ? result.value : undefined;
  }
  return encryptedStore.getKey(account);
}

/**
 * Async version of `setSecureKey`. When the broker is available the key
 * is written there **and** to the encrypted store so that sync callers
 * have a consistent view. Returns `true` only when both stores succeed.
 *
 * If the broker is available but `broker.set()` fails we return `false`
 * immediately — falling through to an encrypted-store-only write would
 * leave the broker with stale data that async readers would still see.
 */
export async function setSecureKeyAsync(
  account: string,
  value: string,
): Promise<boolean> {
  const broker = getBroker();
  if (broker.isAvailable()) {
    const brokerOk = await broker.set(account, value);
    if (!brokerOk) return false;
    // Broker succeeded — also persist to encrypted store for sync callers.
    const encOk = encryptedStore.setKey(account, value);
    return encOk;
  }
  return encryptedStore.setKey(account, value);
}

/**
 * Async version of `deleteSecureKey`. When the broker is available the
 * key is deleted there **and** from the encrypted store so that sync
 * callers have a consistent view. Returns `true` only when both stores
 * succeed.
 *
 * If the broker is available but `broker.del()` fails we return `false`
 * immediately — falling through to an encrypted-store-only delete would
 * leave the broker with the key, and async readers would still see it.
 */
export async function deleteSecureKeyAsync(account: string): Promise<boolean> {
  const broker = getBroker();
  if (broker.isAvailable()) {
    const brokerOk = await broker.del(account);
    if (!brokerOk) return false;
    // Broker succeeded — also remove from encrypted store for sync callers.
    const encOk = encryptedStore.deleteKey(account);
    return encOk;
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
