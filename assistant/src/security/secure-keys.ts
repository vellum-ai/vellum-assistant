/**
 * Unified secure key storage — routes through the keychain broker when
 * available (macOS app embedded), with transparent fallback to the
 * encrypted-at-rest file store.
 *
 * Use `getSecureKeyAsync`, `setSecureKeyAsync`, and `deleteSecureKeyAsync`
 * for all credential access.
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

/** Result of a delete operation — distinguishes success, not-found, and error. */
export type DeleteResult = "deleted" | "not-found" | "error";

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

// ---------------------------------------------------------------------------
// Primary API — try encrypted store first, fall back to broker
// ---------------------------------------------------------------------------

/**
 * Retrieve a secret from secure storage. Checks the encrypted store first
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
 * Store a secret in secure storage. When the broker is available the key
 * is written there **and** to the encrypted store. Returns `true` only
 * when all writes succeed.
 *
 * If the broker is available but `broker.set()` fails we return `false`
 * immediately — falling through to an encrypted-store-only write would
 * leave the two stores out of sync.
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
    // Broker succeeded — also persist to encrypted store.
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
 * Delete a secret from secure storage. When the broker is available the
 * key is deleted there **and** from the encrypted store.
 *
 * Returns `"deleted"` when the key was removed, `"not-found"` when it
 * didn't exist (idempotent), or `"error"` on a real backend failure.
 *
 * If the broker is available but `broker.del()` fails we return `"error"`
 * immediately — falling through to an encrypted-store-only delete would
 * leave the broker with the key, causing stale reads on broker fallback.
 */
export async function deleteSecureKeyAsync(
  account: string,
): Promise<DeleteResult> {
  const broker = getBroker();
  if (broker.isAvailable()) {
    const brokerOk = await broker.del(account);
    if (!brokerOk) return "error";
    // Broker succeeded — also remove from encrypted store.
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
