/**
 * Unified secure key storage — routes through the keychain broker when
 * available (macOS app embedded), with transparent fallback to the
 * encrypted-at-rest file store.
 *
 * Async variants try the broker first; sync variants always use the
 * encrypted store (startup code paths cannot do async I/O).
 */

import { getLogger } from "../util/logger.js";
import * as encryptedStore from "./encrypted-store.js";
import type { KeychainBrokerClient } from "./keychain-broker-client.js";
import { createBrokerClient } from "./keychain-broker-client.js";

const log = getLogger("secure-keys");

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

/** Result of a delete operation — distinguishes success, not-found, and error. */
export type DeleteResult = "deleted" | "not-found" | "error";

/**
 * Delete a secret from secure storage (sync — encrypted store only).
 * Returns `"deleted"` on success, `"not-found"` if key doesn't exist,
 * or `"error"` on failure.
 */
export function deleteSecureKey(account: string): DeleteResult {
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
 * Async version of `getSecureKey`. Checks the encrypted store first
 * (instant) since `setSecureKeyAsync` always writes to both stores.
 * Falls back to the broker for keys that may exist only in the macOS
 * Keychain. Returns `undefined` if the key is not found in either store.
 */
export async function getSecureKeyAsync(
  account: string,
): Promise<string | undefined> {
  // Check encrypted store first (sync, instant). Since setSecureKeyAsync
  // always writes to both broker and encrypted store, a hit here is
  // authoritative and avoids the broker IPC round-trip.
  const encResult = encryptedStore.getKey(account);
  if (encResult != null && encResult.length > 0) return encResult;

  // Not in encrypted store — try broker as fallback for keys that may
  // exist only in the macOS Keychain (e.g. written by the app directly).
  const broker = getBroker();
  if (broker.isAvailable()) {
    const result = await broker.get(account);
    if (result?.found) return result.value;
  }

  return undefined;
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
    const result = await broker.set(account, value);
    if (result.status !== "ok") {
      log.warn(
        {
          account,
          brokerStatus: result.status,
          ...(result.status === "rejected"
            ? { brokerCode: result.code, brokerMessage: result.message }
            : {}),
        },
        "Broker set failed for secure key",
      );
      return false;
    }
    // Broker succeeded — also persist to encrypted store for sync callers.
    const encOk = encryptedStore.setKey(account, value);
    if (!encOk) {
      log.warn({ account }, "Encrypted store set failed after broker success");
    }
    return encOk;
  }
  const encOk = encryptedStore.setKey(account, value);
  if (!encOk) {
    log.warn({ account }, "Encrypted store set failed (broker unavailable)");
  }
  return encOk;
}

/**
 * Async version of `deleteSecureKey`. When the broker is available the
 * key is deleted there **and** from the encrypted store so that sync
 * callers have a consistent view.
 *
 * Returns `"deleted"` when the key was removed, `"not-found"` when it
 * didn't exist (idempotent), or `"error"` on a real backend failure.
 *
 * If the broker is available but `broker.del()` fails we return `"error"`
 * immediately — falling through to an encrypted-store-only delete would
 * leave the broker with the key, and async readers would still see it.
 */
export async function deleteSecureKeyAsync(
  account: string,
): Promise<DeleteResult> {
  const broker = getBroker();
  if (broker.isAvailable()) {
    const brokerOk = await broker.del(account);
    if (!brokerOk) return "error";
    // Broker succeeded — also remove from encrypted store for sync callers.
    const encResult = encryptedStore.deleteKey(account);
    // Broker deletion succeeded; encrypted-store "not-found" is fine
    // (key may only exist in the broker).
    if (encResult === "error") return "error";
    return "deleted";
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
