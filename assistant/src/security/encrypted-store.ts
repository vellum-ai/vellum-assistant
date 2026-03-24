/**
 * Encrypted-at-rest key storage.
 *
 * v2 stores use a cryptographically random 32-byte `store.key` file as the
 * AES-256-GCM key directly (no key derivation). The key file lives alongside
 * `keys.enc` in `~/.vellum/protected/`.
 *
 * v1 stores (legacy) derived the AES key from machine-specific entropy via
 * PBKDF2. Existing v1 stores are automatically migrated to v2 on first access.
 *
 * Provides the standard get/set/delete credential storage interface.
 */

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import { ensureDir, pathExists } from "../util/fs.js";
import { getLogger } from "../util/logger.js";
import { getPlatformName, getRootDir } from "../util/platform.js";

const log = getLogger("encrypted-store");

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // bytes (256 bits)
const IV_LENGTH = 16; // bytes (128 bits)
const AUTH_TAG_LENGTH = 16; // bytes
const PBKDF2_ITERATIONS =
  // In tests, PBKDF2 key derivation dominates runtime (~1-2s per file).
  // 1 iteration is sufficient for correctness; 100k is for brute-force resistance.
  process.env.BUN_TEST === "1" ? 1 : 100_000;

// ---------------------------------------------------------------------------
// On-disk formats
// ---------------------------------------------------------------------------

/** v1 on-disk format (legacy): PBKDF2-derived key from machine entropy. */
interface StoreFileV1 {
  version: 1;
  /** Hex-encoded salt for PBKDF2 key derivation. */
  salt: string;
  entries: Record<string, EncryptedEntry>;
}

/** v2 on-disk format: random store.key used directly as AES key. */
interface StoreFileV2 {
  version: 2;
  entries: Record<string, EncryptedEntry>;
}

type StoreFile = StoreFileV1 | StoreFileV2;

/** A single encrypted value. */
interface EncryptedEntry {
  /** Hex-encoded IV. */
  iv: string;
  /** Hex-encoded auth tag. */
  tag: string;
  /** Hex-encoded ciphertext. */
  data: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

let storePathOverride: string | null = null;

function getStorePath(): string {
  return storePathOverride ?? join(getRootDir(), "protected", "keys.enc");
}

/** @internal Test-only: override the store file path. Pass `null` to reset. */
export function _setStorePath(path: string | null): void {
  storePathOverride = path;
}

// ---------------------------------------------------------------------------
// Store key file (v2)
// ---------------------------------------------------------------------------

const STORE_KEY_FILENAME = "store.key";
const STORE_KEY_LENGTH = 32; // bytes

let storeKeyPathOverride: string | null = null;

/** @internal Test-only: override the store key file path. Pass `null` to reset. */
export function _setStoreKeyPath(path: string | null): void {
  storeKeyPathOverride = path;
}

function getStoreKeyPath(): string {
  return (
    storeKeyPathOverride ?? join(dirname(getStorePath()), STORE_KEY_FILENAME)
  );
}

/**
 * Read the store.key file. Returns the raw 32-byte key buffer, or null
 * if the file is missing, wrong size, or unreadable.
 */
function readStoreKey(): Buffer | null {
  const keyPath = getStoreKeyPath();
  if (!pathExists(keyPath)) return null;
  try {
    const buf = readFileSync(keyPath);
    if (buf.length !== STORE_KEY_LENGTH) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Generate a cryptographically random store key and write it atomically
 * to `<dir>/store.key` with 0o600 permissions. Returns the key buffer.
 */
function generateAndWriteStoreKey(dir: string): Buffer {
  ensureDir(dir);
  const key = randomBytes(STORE_KEY_LENGTH);
  const keyPath = join(dir, STORE_KEY_FILENAME);
  const tmpPath = keyPath + `.tmp.${process.pid}`;
  writeFileSync(tmpPath, key, { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, keyPath);
  return key;
}

/**
 * Read the existing store key, or generate and write a new one if missing.
 */
function getOrReadStoreKey(dir: string): Buffer {
  const existing = readStoreKey();
  if (existing) return existing;
  return generateAndWriteStoreKey(dir);
}

// ---------------------------------------------------------------------------
// Machine entropy for key derivation (legacy v1 only)
// ---------------------------------------------------------------------------

/**
 * @deprecated @internal Kept only for v1->v2 migration path.
 * Derives entropy from publicly-knowable machine properties.
 */
function getMachineEntropy(): string {
  const parts: string[] = [];
  try {
    parts.push(hostname());
  } catch {
    parts.push("unknown-host");
  }
  try {
    parts.push(userInfo().username);
  } catch {
    parts.push("unknown-user");
  }
  parts.push(getPlatformName());
  parts.push(process.arch);
  try {
    parts.push(userInfo().homedir);
  } catch {
    parts.push("/tmp");
  }
  return parts.join(":");
}

/**
 * @deprecated @internal Kept only for v1->v2 migration path.
 * Derives an AES key from machine entropy via PBKDF2.
 */
function deriveKey(salt: Buffer): Buffer {
  const entropy = getMachineEntropy();
  return pbkdf2Sync(entropy, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha512");
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the AES key for a given store format.
 * - v2: reads store.key file (returns null if missing)
 * - v1: derives key from machine entropy via PBKDF2
 */
function getKeyForStore(store: StoreFile): Buffer | null {
  if (store.version === 2) {
    return readStoreKey();
  }
  return deriveKey(Buffer.from(store.salt, "hex"));
}

// ---------------------------------------------------------------------------
// v1 -> v2 migration
// ---------------------------------------------------------------------------

/**
 * Migrate a v1 store to v2 format:
 * 1. Get or generate a random store.key
 * 2. Decrypt each entry with the legacy PBKDF2-derived key
 * 3. Re-encrypt each entry with the random store key
 *
 * Entries that fail to decrypt (corrupt/tampered) are logged and skipped.
 * Returns null if a fatal error occurs (e.g. can't write store.key).
 */
function migrateV1ToV2(store: StoreFileV1): StoreFileV2 | null {
  const protectedDir = dirname(getStorePath());

  let storeKey: Buffer;
  try {
    storeKey = getOrReadStoreKey(protectedDir);
  } catch (err) {
    log.error({ err }, "Failed to create store.key during v1->v2 migration");
    return null;
  }

  // Derive the legacy key for decryption
  const legacyKey = deriveKey(Buffer.from(store.salt, "hex"));

  const newEntries: Record<string, EncryptedEntry> = Object.create(null);

  for (const [account, entry] of Object.entries(store.entries)) {
    try {
      const plaintext = decrypt(entry, legacyKey);
      newEntries[account] = encrypt(plaintext, storeKey);
    } catch (err) {
      log.warn(
        { err, account },
        "Skipping corrupt entry during v1->v2 migration",
      );
    }
  }

  return { version: 2, entries: newEntries };
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

/**
 * Read result: distinguishes "file missing" from "file corrupt/unreadable".
 * - `null`: file does not exist or was corrupt (backed up and removed)
 * - `StoreFile`: successfully parsed
 * - throws: transient I/O error from readFileSync (EACCES, EMFILE, EIO, etc.)
 */
function readStore(): StoreFile | null {
  const path = getStorePath();
  if (!pathExists(path)) return null;

  // Read outside the parse try/catch so transient filesystem errors (EACCES,
  // EMFILE, EIO) propagate to callers instead of triggering corruption recovery.
  const raw = readFileSync(path, "utf-8");

  try {
    const parsed = JSON.parse(raw);

    if (typeof parsed.entries !== "object") {
      throw new Error("Encrypted store has invalid format");
    }

    // Accept v2 (no salt required) or v1 (salt required)
    if (parsed.version === 2) {
      const safeEntries: Record<string, EncryptedEntry> = Object.create(null);
      Object.assign(safeEntries, parsed.entries);
      parsed.entries = safeEntries;
      return parsed as StoreFileV2;
    }

    if (parsed.version === 1 && typeof parsed.salt === "string") {
      const safeEntries: Record<string, EncryptedEntry> = Object.create(null);
      Object.assign(safeEntries, parsed.entries);
      parsed.entries = safeEntries;
      return parsed as StoreFileV1;
    }

    throw new Error("Encrypted store has invalid format");
  } catch (err) {
    // Corrupted or invalid store file -- back it up and start fresh so the
    // daemon doesn't crash on every credential access.
    const backupPath = `${path}.corrupt.${Date.now()}`;
    log.error(
      { err, backupPath },
      "Encrypted store is corrupt -- backing up and resetting",
    );
    try {
      renameSync(path, backupPath);
    } catch (renameErr) {
      log.warn({ err: renameErr }, "Failed to back up corrupt store file");
    }
    return null;
  }
}

/**
 * Well-known filename for the persisted machine entropy (legacy).
 * Written alongside `keys.enc` so the CES sidecar could derive the same AES key.
 * Superseded by `store.key` in v2 format.
 */
const ENTROPY_FILENAME = "entropy.key";

/**
 * Ensure the `store.key` file exists and is accessible on the shared mount
 * (containerized/managed mode). Best-effort delete the old `entropy.key` file
 * since v2 stores no longer need it.
 */
function persistStoreKey(protectedDir: string): void {
  if (!getIsContainerized()) return;
  try {
    const storeKeyPath = join(protectedDir, STORE_KEY_FILENAME);
    if (!pathExists(storeKeyPath)) {
      // store.key should already exist from normal creation, but ensure it
      getOrReadStoreKey(protectedDir);
    }
  } catch {
    // Best-effort
  }

  // Best-effort cleanup of legacy entropy.key
  try {
    const entropyPath = join(protectedDir, ENTROPY_FILENAME);
    if (pathExists(entropyPath)) {
      unlinkSync(entropyPath);
    }
  } catch {
    // Best-effort -- don't fail if cleanup of old file doesn't work.
  }
}

function writeStore(store: StoreFile): void {
  const path = getStorePath();
  const protectedDir = dirname(path);
  ensureDir(protectedDir);
  // Atomic write: write to temp file then rename to avoid partial/corrupt writes.
  // Use pid suffix to prevent cross-process collisions while ensuring same-process
  // retries overwrite the stale temp file (avoids orphaned temp files on failure).
  const tmpPath = path + `.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);

  // Keep store.key in sync so the managed CES sidecar can decrypt.
  persistStoreKey(protectedDir);
}

function getOrCreateStore(): StoreFileV2 {
  const existing = readStore();

  if (!existing) {
    // Fresh store: generate store.key and create v2 format
    const protectedDir = dirname(getStorePath());
    getOrReadStoreKey(protectedDir);
    const entries: Record<string, EncryptedEntry> = Object.create(null);
    const store: StoreFileV2 = { version: 2, entries };
    writeStore(store);
    return store;
  }

  if (existing.version === 1) {
    // Migrate v1 -> v2
    const migrated = migrateV1ToV2(existing);
    if (migrated) {
      writeStore(migrated);
      return migrated;
    }
    // Migration failed fatally -- fall through and use v1 as-is won't work
    // because we can't get the key. Throw so callers handle the error.
    throw new Error("Failed to migrate encrypted store from v1 to v2");
  }

  return existing;
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt
// ---------------------------------------------------------------------------

function encrypt(plaintext: string, key: Buffer): EncryptedEntry {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex"),
  };
}

function decrypt(entry: EncryptedEntry, key: Buffer): string {
  const iv = Buffer.from(entry.iv, "hex");
  const tag = Buffer.from(entry.tag, "hex");
  const data = Buffer.from(entry.data, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf-8");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve a secret from the encrypted store.
 * Returns `undefined` if the key doesn't exist or decryption fails.
 */
export function getKey(account: string): string | undefined {
  try {
    const store = readStore();
    if (!store) return undefined;

    // If v1, trigger migration
    if (store.version === 1) {
      const migrated = migrateV1ToV2(store);
      if (migrated) {
        writeStore(migrated);
        const entry = migrated.entries[account];
        if (!entry) return undefined;
        const key = getKeyForStore(migrated);
        if (!key) return undefined;
        return decrypt(entry, key);
      }
      // Migration failed -- try reading with legacy key
      const entry = store.entries[account];
      if (!entry) return undefined;
      const key = getKeyForStore(store);
      if (!key) return undefined;
      return decrypt(entry, key);
    }

    const entry = store.entries[account];
    if (!entry) return undefined;

    const key = getKeyForStore(store);
    if (!key) return undefined;
    return decrypt(entry, key);
  } catch (err) {
    log.debug({ err, account }, "Failed to read from encrypted store");
    return undefined;
  }
}

/**
 * Store a secret in the encrypted store.
 * Returns true on success, false on failure.
 */
export function setKey(account: string, value: string): boolean {
  try {
    const store = getOrCreateStore();
    const key = getKeyForStore(store);
    if (!key) return false;
    store.entries[account] = encrypt(value, key);
    writeStore(store);
    return true;
  } catch (err) {
    log.warn({ err, account }, "Failed to write to encrypted store");
    return false;
  }
}

/** Result of a delete operation -- distinguishes success, not-found, and error. */
export type DeleteKeyResult = "deleted" | "not-found" | "error";

/**
 * Delete a secret from the encrypted store.
 * Returns `"deleted"` on success, `"not-found"` if the key doesn't exist,
 * or `"error"` on failure.
 */
export function deleteKey(account: string): DeleteKeyResult {
  try {
    const existing = readStore();
    if (!existing) return "not-found";

    // Ensure v1→v2 migration happens when a store exists
    let store: StoreFileV2;
    if (existing.version === 1) {
      const migrated = migrateV1ToV2(existing);
      if (!migrated) {
        throw new Error("Failed to migrate encrypted store from v1 to v2");
      }
      writeStore(migrated);
      store = migrated;
    } else {
      store = existing;
    }

    if (!Object.prototype.hasOwnProperty.call(store.entries, account))
      return "not-found";

    delete store.entries[account];
    writeStore(store);
    return "deleted";
  } catch (err) {
    log.debug({ err, account }, "Failed to delete from encrypted store");
    return "error";
  }
}

/**
 * List all account names in the encrypted store.
 * Throws if the store file exists but cannot be read/parsed.
 */
export function listKeys(): string[] {
  const store = readStore();
  if (!store) return [];
  return Object.keys(store.entries);
}
