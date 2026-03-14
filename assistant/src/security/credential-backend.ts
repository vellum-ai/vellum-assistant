/**
 * CredentialBackend interface and adapters — abstracts credential storage
 * behind a unified async API so callers don't need to know which backend
 * (macOS Keychain, encrypted file store, etc.) is in use.
 */

import * as encryptedStore from "./encrypted-store.js";
import type { KeychainBrokerClient } from "./keychain-broker-client.js";
import { createBrokerClient } from "./keychain-broker-client.js";
import type { DeleteResult } from "./secure-keys.js";

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
      if (result == null || !result.found) return undefined;
      return result.value;
    } catch {
      return undefined;
    }
  }

  async set(account: string, value: string): Promise<boolean> {
    try {
      const result = await this.client.set(account, value);
      return result.status === "ok";
    } catch {
      return false;
    }
  }

  async delete(account: string): Promise<DeleteResult> {
    try {
      const ok = await this.client.del(account);
      return ok ? "deleted" : "error";
    } catch {
      return "error";
    }
  }

  async list(): Promise<string[]> {
    try {
      return await this.client.list();
    } catch {
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
    return encryptedStore.getKey(account);
  }

  async set(account: string, value: string): Promise<boolean> {
    return encryptedStore.setKey(account, value);
  }

  async delete(account: string): Promise<DeleteResult> {
    return encryptedStore.deleteKey(account);
  }

  async list(): Promise<string[]> {
    return encryptedStore.listKeys();
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
