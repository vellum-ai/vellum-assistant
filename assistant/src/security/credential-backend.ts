/**
 * CredentialBackend interface and adapters — abstracts credential storage
 * behind a unified async API so callers don't need to know which backend
 * is in use.
 */

import { deleteKey, getKey, listKeys, setKey } from "./encrypted-store.js";

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
    return true;
  }

  async get(account: string): Promise<CredentialGetResult> {
    try {
      return { value: getKey(account), unreachable: false };
    } catch {
      return { value: undefined, unreachable: false };
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
// Factory functions
// ---------------------------------------------------------------------------

export function createEncryptedStoreBackend(): EncryptedStoreBackend {
  return new EncryptedStoreBackend();
}
