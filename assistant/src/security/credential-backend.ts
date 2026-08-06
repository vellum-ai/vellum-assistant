/**
 * CredentialBackend interface and adapters — abstracts credential storage
 * behind a unified async API so callers don't need to know which backend
 * is in use.
 */

import { getIsContainerized } from "../config/env-registry.js";
import { deleteKey, listKeys, readKey, setKey } from "./encrypted-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a delete operation — distinguishes success, not-found, and error. */
export type DeleteResult = "deleted" | "not-found" | "error";

/** Result of a get operation — distinguishes unreachable from not-found. */
export interface CredentialGetResult {
  value: string | undefined;
  unreachable: boolean;
}

/** Result of a list operation — distinguishes unreachable from empty. */
export interface CredentialListResult {
  accounts: string[];
  unreachable: boolean;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface CredentialBackend {
  /** Human-readable name for logging (e.g. "encrypted-store"). */
  readonly name: string;

  /** Whether this backend is currently reachable. Sync and cheap. */
  isAvailable(): boolean;

  /** Retrieve a secret. Returns a result distinguishing unreachable from not-found. */
  get(account: string): Promise<CredentialGetResult>;

  /** Store a secret. Returns true on success. */
  set(account: string, value: string): Promise<boolean>;

  /** Delete a secret. */
  delete(account: string): Promise<DeleteResult>;

  /** List all account names. */
  list(): Promise<CredentialListResult>;

  /** Bulk-set multiple credentials. Optional — backends without native bulk support omit this. */
  bulkSet?(
    credentials: Array<{ account: string; value: string }>,
  ): Promise<Array<{ account: string; ok: boolean }>>;
}

// ---------------------------------------------------------------------------
// EncryptedStoreBackend
// ---------------------------------------------------------------------------

class EncryptedStoreBackend implements CredentialBackend {
  readonly name = "encrypted-store";

  isAvailable(): boolean {
    // The local encrypted store is the legitimate backend only outside
    // containers. On a pod `keys.enc` does not exist and CES owns credentials,
    // so reporting available here would pin reads to a store that can never
    // hold the key. Returning false lets the resolver recover to CES.
    return !getIsContainerized();
  }

  async get(account: string): Promise<CredentialGetResult> {
    try {
      return { value: readKey(account), unreachable: false };
    } catch {
      // A thrown error means the store exists but could not be read or
      // decrypted, so it is unavailable, not absent. A genuinely-missing store
      // or key returns undefined from readKey without throwing.
      return { value: undefined, unreachable: true };
    }
  }

  async set(account: string, value: string): Promise<boolean> {
    try {
      return setKey(account, value);
    } catch {
      return false;
    }
  }

  async delete(account: string): Promise<DeleteResult> {
    try {
      return deleteKey(account);
    } catch {
      return "error";
    }
  }

  async list(): Promise<CredentialListResult> {
    try {
      return { accounts: listKeys(), unreachable: false };
    } catch {
      return { accounts: [], unreachable: true };
    }
  }
}

// ---------------------------------------------------------------------------
// UnavailableBackend
// ---------------------------------------------------------------------------

/**
 * A backend whose every operation reports the store as unreachable. Used on
 * containerized pods when no CES path is ready: resolving to the (nonexistent)
 * local encrypted store would report provisioned credentials as absent, but
 * the correct state is "temporarily unreachable" (presence indeterminate),
 * which callers retry rather than treating as a missing key.
 */
class UnavailableBackend implements CredentialBackend {
  readonly name = "unavailable";

  isAvailable(): boolean {
    return false;
  }

  async get(): Promise<CredentialGetResult> {
    return { value: undefined, unreachable: true };
  }

  async set(): Promise<boolean> {
    return false;
  }

  async delete(): Promise<DeleteResult> {
    return "error";
  }

  async list(): Promise<CredentialListResult> {
    return { accounts: [], unreachable: true };
  }
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

export function createEncryptedStoreBackend(): EncryptedStoreBackend {
  return new EncryptedStoreBackend();
}

export function createUnavailableBackend(): UnavailableBackend {
  return new UnavailableBackend();
}
