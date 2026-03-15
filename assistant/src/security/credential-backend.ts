/**
 * CredentialBackend interface and adapters — abstracts credential storage
 * behind a unified async API so callers don't need to know which backend
 * (macOS Keychain, encrypted file store, etc.) is in use.
 */

import { getLogger } from "../util/logger.js";
import * as encryptedStore from "./encrypted-store.js";
import type { KeychainBrokerClient } from "./keychain-broker-client.js";
import { createBrokerClient } from "./keychain-broker-client.js";

const log = getLogger("credential-backend");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a delete operation — distinguishes success, not-found, and error. */
export type DeleteResult = "deleted" | "not-found" | "error";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface CredentialBackend {
  /** Human-readable name for logging (e.g. "keychain", "encrypted-store"). */
  readonly name: string;

  /** Whether this backend is currently reachable. Sync and cheap. */
  isAvailable(): boolean;

  /** Retrieve a secret. Returns undefined if not found or on error. */
  get(account: string): Promise<string | undefined>;

  /** Store a secret. Returns true on success. */
  set(account: string, value: string): Promise<boolean>;

  /** Delete a secret. */
  delete(account: string): Promise<DeleteResult>;

  /** List all account names. */
  list(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// KeychainBackend
// ---------------------------------------------------------------------------

export class KeychainBackend implements CredentialBackend {
  readonly name = "keychain";

  constructor(private readonly client: KeychainBrokerClient) {}

  isAvailable(): boolean {
    return this.client.isAvailable();
  }

  async get(account: string): Promise<string | undefined> {
    try {
      const result = await this.client.get(account);
      if (result == null) {
        log.warn(
          { account },
          "Keychain broker unreachable during get — falling back",
        );
        return undefined;
      }
      if (!result.found) return undefined;
      return result.value;
    } catch (err) {
      log.warn({ err, account }, "Keychain get threw unexpectedly");
      return undefined;
    }
  }

  async set(account: string, value: string): Promise<boolean> {
    try {
      const result = await this.client.set(account, value);
      if (result.status === "ok") return true;
      log.warn(
        {
          account,
          status: result.status,
          ...(result.status === "rejected"
            ? { code: result.code, message: result.message }
            : {}),
        },
        "Keychain broker set failed",
      );
      return false;
    } catch (err) {
      log.warn({ err, account }, "Keychain set threw unexpectedly");
      return false;
    }
  }

  async delete(account: string): Promise<DeleteResult> {
    try {
      const ok = await this.client.del(account);
      // The keychain broker returns a boolean — it does not distinguish
      // "not found" from a genuine error, so we map false → "error".
      return ok ? "deleted" : "error";
    } catch {
      return "error";
    }
  }

  async list(): Promise<string[]> {
    try {
      return await this.client.list();
    } catch (err) {
      log.warn({ err }, "Keychain list threw unexpectedly");
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// EncryptedStoreBackend
// ---------------------------------------------------------------------------

export class EncryptedStoreBackend implements CredentialBackend {
  readonly name = "encrypted-store";

  isAvailable(): boolean {
    return true;
  }

  async get(account: string): Promise<string | undefined> {
    try {
      return encryptedStore.getKey(account);
    } catch {
      return undefined;
    }
  }

  async set(account: string, value: string): Promise<boolean> {
    try {
      return encryptedStore.setKey(account, value);
    } catch {
      return false;
    }
  }

  async delete(account: string): Promise<DeleteResult> {
    try {
      return encryptedStore.deleteKey(account);
    } catch {
      return "error";
    }
  }

  async list(): Promise<string[]> {
    try {
      return encryptedStore.listKeys();
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

export function createKeychainBackend(): KeychainBackend {
  return new KeychainBackend(createBrokerClient());
}

export function createEncryptedStoreBackend(): EncryptedStoreBackend {
  return new EncryptedStoreBackend();
}
