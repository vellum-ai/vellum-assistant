/**
 * Unified secure key storage — tries OS keychain first, falls back to
 * encrypted-at-rest file storage.
 *
 * Provides the same get/set/delete/list interface used by both backends.
 * Backend selection is cached after the first call for the process lifetime.
 */

import { getLogger } from "../util/logger.js";
import { isMacOS } from "../util/platform.js";
import * as encryptedStore from "./encrypted-store.js";
import * as keychain from "./keychain.js";

const log = getLogger("secure-keys");

type Backend = "keychain" | "encrypted" | null;
let resolvedBackend: Backend | undefined;
/** True when backend was downgraded from keychain to encrypted at runtime. */
let downgradedFromKeychain = false;
/** Keys known to not exist in keychain — avoids repeated subprocess calls on misses. */
const keychainMissCache = new Set<string>();

function getBackend(): Backend {
  if (resolvedBackend !== undefined) return resolvedBackend;

  // On macOS, skip keychain probing and use encrypted file storage directly
  // to avoid repeated Keychain Access authorization prompts. Mark as
  // downgraded so getSecureKey/getSecureKeyAsync still check keychain as a
  // fallback for secrets stored before this switch.
  if (isMacOS()) {
    log.debug(
      "macOS detected, using encrypted file storage (skipping keychain)",
    );
    resolvedBackend = "encrypted";
    downgradedFromKeychain = true;
    return resolvedBackend;
  }

  if (keychain.isKeychainAvailable()) {
    log.debug("Using OS keychain for secure key storage");
    resolvedBackend = "keychain";
  } else {
    log.debug("OS keychain unavailable, using encrypted file storage");
    resolvedBackend = "encrypted";
  }
  return resolvedBackend;
}

async function getBackendAsync(): Promise<Backend> {
  if (resolvedBackend !== undefined) return resolvedBackend;

  // On macOS, skip keychain probing and use encrypted file storage directly
  // to avoid repeated Keychain Access authorization prompts. Mark as
  // downgraded so getSecureKey/getSecureKeyAsync still check keychain as a
  // fallback for secrets stored before this switch.
  if (isMacOS()) {
    log.debug(
      "macOS detected, using encrypted file storage (skipping keychain)",
    );
    resolvedBackend = "encrypted";
    downgradedFromKeychain = true;
    return resolvedBackend;
  }

  if (await keychain.isKeychainAvailableAsync()) {
    log.debug("Using OS keychain for secure key storage");
    resolvedBackend = "keychain";
  } else {
    log.debug("OS keychain unavailable, using encrypted file storage");
    resolvedBackend = "encrypted";
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
  if (backend === "encrypted") return encryptedFn();
  if (backend !== "keychain") return fallbackValue;

  const result = keychainFn();
  // keychain.setKey/deleteKey return false on failure.
  // We downgrade on failures (false) to switch to encrypted backend.
  if (result === false) {
    log.warn(
      "Keychain operation failed at runtime, falling back to encrypted file storage",
    );
    resolvedBackend = "encrypted";
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
  if (backend === "keychain") {
    try {
      return keychain.getKey(account) ?? undefined;
    } catch {
      // Keychain runtime error on read — downgrade to encrypted store
      log.warn(
        "Keychain read failed at runtime, falling back to encrypted file storage",
      );
      resolvedBackend = "encrypted";
      downgradedFromKeychain = true;
      return encryptedStore.getKey(account);
    }
  }
  if (backend === "encrypted") {
    const value = encryptedStore.getKey(account);
    // After a runtime downgrade, keys may still exist in the keychain.
    // Try keychain read as fallback so pre-downgrade keys remain accessible.
    if (
      value === undefined &&
      downgradedFromKeychain &&
      !keychainMissCache.has(account)
    ) {
      try {
        const keychainValue = keychain.getKey(account) ?? undefined;
        if (keychainValue === undefined) {
          keychainMissCache.add(account);
        }
        return keychainValue;
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
  const result = withKeychainFallback(
    () => keychain.setKey(account, value),
    () => encryptedStore.setKey(account, value),
    false,
  );
  // When writing to the encrypted store after a keychain downgrade, clean up
  // any stale keychain entry so the gateway's credential-reader (which tries
  // keychain first) does not read an outdated value.
  if (result && downgradedFromKeychain && getBackend() === "encrypted") {
    keychainMissCache.delete(account);
    try {
      // Only attempt deletion if the key actually exists in keychain to
      // avoid spawning a subprocess on every write.
      if (keychain.getKey(account) != null) {
        keychain.deleteKey(account);
      }
    } catch {
      /* best-effort */
    }
  }
  return result;
}

/**
 * Delete a secret from secure storage.
 * Returns `true` on success, `false` if not found or on error.
 */
export function deleteSecureKey(account: string): boolean {
  const backend = getBackend();
  if (backend === "encrypted") {
    const result = encryptedStore.deleteKey(account);
    // After a runtime downgrade, keys may still exist in the keychain.
    // Attempt cleanup and return true if either backend had the key.
    if (downgradedFromKeychain) {
      keychainMissCache.delete(account);
      const keychainResult = keychain.deleteKey(account);
      return result || keychainResult;
    }
    return result;
  }
  if (backend !== "keychain") return false;

  // keychain.deleteKey returns false for both "not found" and "runtime error".
  // Check existence first so a missing key doesn't spuriously downgrade the
  // backend — saveConfig routinely deletes keys for unset providers.
  // getKey now returns null for "not found" and throws on runtime errors.
  try {
    if (keychain.getKey(account) == null) {
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
 * Throws if the store file exists but cannot be read (encrypted backend).
 */
export function listSecureKeys(): string[] {
  const backend = getBackend();
  if (backend === "encrypted") return encryptedStore.listKeys();
  // OS keychains don't provide a list API scoped to our service
  return [];
}

/**
 * Return the currently resolved backend type.
 * Useful for feature-gating behaviour that only works on certain backends.
 */
export function getBackendType(): "keychain" | "encrypted" | null {
  return getBackend();
}

/**
 * Whether the backend was downgraded from keychain to encrypted at runtime.
 * When true, credentials may still be readable from keychain via fallback
 * even though the active backend is encrypted.
 */
export function isDowngradedFromKeychain(): boolean {
  return downgradedFromKeychain;
}

// ---------------------------------------------------------------------------
// Async variants — non-blocking alternatives that avoid blocking the event
// loop during keychain operations. Preferred for non-startup code paths.
// ---------------------------------------------------------------------------

/**
 * Async version of `getSecureKey` — retrieve a secret without blocking.
 */
export async function getSecureKeyAsync(
  account: string,
): Promise<string | undefined> {
  const backend = await getBackendAsync();
  if (backend === "keychain") {
    try {
      return (await keychain.getKeyAsync(account)) ?? undefined;
    } catch {
      log.warn(
        "Keychain read failed at runtime, falling back to encrypted file storage",
      );
      resolvedBackend = "encrypted";
      downgradedFromKeychain = true;
      return encryptedStore.getKey(account);
    }
  }
  if (backend === "encrypted") {
    const value = encryptedStore.getKey(account);
    if (
      value === undefined &&
      downgradedFromKeychain &&
      !keychainMissCache.has(account)
    ) {
      try {
        const keychainValue =
          (await keychain.getKeyAsync(account)) ?? undefined;
        if (keychainValue === undefined) {
          keychainMissCache.add(account);
        }
        return keychainValue;
      } catch {
        return undefined;
      }
    }
    return value;
  }
  return undefined;
}

/**
 * Async version of `setSecureKey` — store a secret without blocking.
 */
export async function setSecureKeyAsync(
  account: string,
  value: string,
): Promise<boolean> {
  const backend = await getBackendAsync();
  if (backend === "encrypted") {
    const result = encryptedStore.setKey(account, value);
    // Clean up stale keychain entry (mirrors setSecureKey logic).
    if (result && downgradedFromKeychain) {
      keychainMissCache.delete(account);
      try {
        // Only attempt deletion if the key actually exists in keychain to
        // avoid spawning a subprocess on every write.
        const exists = await keychain.getKeyAsync(account);
        if (exists != null) {
          await keychain.deleteKeyAsync(account);
        }
      } catch {
        /* best-effort */
      }
    }
    return result;
  }
  if (backend !== "keychain") return false;

  const result = await keychain.setKeyAsync(account, value);
  if (result === false) {
    log.warn(
      "Keychain operation failed at runtime, falling back to encrypted file storage",
    );
    resolvedBackend = "encrypted";
    downgradedFromKeychain = true;
    const fallbackResult = encryptedStore.setKey(account, value);
    // Clean up stale keychain entry after runtime downgrade
    if (fallbackResult) {
      keychainMissCache.delete(account);
      try {
        const exists = await keychain.getKeyAsync(account);
        if (exists != null) {
          await keychain.deleteKeyAsync(account);
        }
      } catch {
        /* best-effort */
      }
    }
    return fallbackResult;
  }
  return result;
}

/**
 * Async version of `deleteSecureKey` — delete a secret without blocking.
 */
export async function deleteSecureKeyAsync(account: string): Promise<boolean> {
  const backend = await getBackendAsync();
  if (backend === "encrypted") {
    const result = encryptedStore.deleteKey(account);
    if (downgradedFromKeychain) {
      keychainMissCache.delete(account);
      const keychainResult = await keychain.deleteKeyAsync(account);
      return result || keychainResult;
    }
    return result;
  }
  if (backend !== "keychain") return false;

  try {
    if ((await keychain.getKeyAsync(account)) == null) {
      return false;
    }
  } catch {
    // fall through
  }

  const result = await keychain.deleteKeyAsync(account);
  if (result === false) {
    log.warn(
      "Keychain operation failed at runtime, falling back to encrypted file storage",
    );
    resolvedBackend = "encrypted";
    downgradedFromKeychain = true;
    return encryptedStore.deleteKey(account);
  }
  return result;
}

/** @internal Test-only: reset the cached backend so it's re-evaluated. */
export function _resetBackend(): void {
  resolvedBackend = undefined;
  downgradedFromKeychain = false;
  keychainMissCache.clear();
}

/** @internal Test-only: force a specific backend. Pass `undefined` to reset. */
export function _setBackend(backend: Backend | undefined): void {
  resolvedBackend = backend;
  downgradedFromKeychain = false;
  keychainMissCache.clear();
}
