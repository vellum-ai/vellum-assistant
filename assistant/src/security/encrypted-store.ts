/**
 * Encrypted-at-rest key storage — fallback for systems without OS keychain.
 *
 * Uses AES-256-GCM with a key derived from machine-specific entropy:
 *   - hostname, username, platform, arch, homedir
 *   - PBKDF2 with 100k iterations + a persisted random salt
 *
 * Secrets are stored in `~/.vellum/keys.enc` as a JSON blob encrypted
 * with the derived key. Each entry has its own IV for authenticated encryption.
 *
 * Provides the same get/set/delete interface as `keychain.ts`.
 */

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
const SALT_LENGTH = 32; // bytes

/** On-disk format for the encrypted store. */
interface StoreFile {
  /** Version for future format changes. */
  version: 1;
  /** Hex-encoded salt for PBKDF2 key derivation. */
  salt: string;
  /** Individual encrypted entries keyed by account name. */
  entries: Record<string, EncryptedEntry>;
}

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
// Machine entropy for key derivation
// ---------------------------------------------------------------------------

export function getMachineEntropy(): string {
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

function deriveKey(salt: Buffer): Buffer {
  const entropy = getMachineEntropy();
  return pbkdf2Sync(entropy, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha512");
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
    if (
      parsed.version !== 1 ||
      typeof parsed.salt !== "string" ||
      typeof parsed.entries !== "object"
    ) {
      throw new Error("Encrypted store has invalid format");
    }
    // Use null-prototype object for entries to prevent prototype pollution
    const safeEntries: Record<string, EncryptedEntry> = Object.create(null);
    Object.assign(safeEntries, parsed.entries);
    parsed.entries = safeEntries;
    return parsed as StoreFile;
  } catch (err) {
    // Corrupted or invalid store file — back it up and start fresh so the
    // daemon doesn't crash on every credential access.
    const backupPath = `${path}.corrupt.${Date.now()}`;
    log.error(
      { err, backupPath },
      "Encrypted store is corrupt — backing up and resetting",
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
 * Well-known filename for the persisted machine entropy.
 * Written alongside `keys.enc` so the CES sidecar (which mounts the
 * assistant data volume read-only) can derive the same AES key.
 */
const ENTROPY_FILENAME = "entropy.key";

/**
 * Persist the current machine entropy next to the key store so the managed
 * CES sidecar can read it and derive the same decryption key.
 *
 * Only writes in containerized (managed) mode — in local mode, CES runs on
 * the same machine and derives the same entropy natively, so the file is
 * unnecessary and would weaken offline security by persisting entropy to disk.
 */
function persistEntropy(protectedDir: string): void {
  if (!getIsContainerized()) return;
  try {
    const entropyPath = join(protectedDir, ENTROPY_FILENAME);
    const tmpPath = entropyPath + `.tmp.${process.pid}`;
    writeFileSync(tmpPath, getMachineEntropy(), { mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, entropyPath);
  } catch {
    // Best-effort — managed mode will log a clear error if it's missing.
  }
}

/**
 * Backfill `entropy.key` for existing encrypted stores that predate the
 * entropy persistence feature. If the store file exists but `entropy.key`
 * does not, write it now so the managed CES sidecar can derive the key.
 */
function backfillEntropyIfMissing(): void {
  if (!getIsContainerized()) return;
  try {
    const protectedDir = dirname(getStorePath());
    const entropyPath = join(protectedDir, ENTROPY_FILENAME);
    if (!pathExists(entropyPath)) {
      persistEntropy(protectedDir);
    }
  } catch {
    // Best-effort — don't break reads if backfill fails.
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

  // Keep entropy.key in sync so the managed CES sidecar can decrypt.
  persistEntropy(protectedDir);
}

function getOrCreateStore(): StoreFile {
  const existing = readStore();
  if (existing) return existing;

  const salt = randomBytes(SALT_LENGTH);
  const entries: Record<string, EncryptedEntry> = Object.create(null);
  const store: StoreFile = {
    version: 1,
    salt: salt.toString("hex"),
    entries,
  };
  writeStore(store);
  return store;
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
// Public API — matches keychain.ts interface
// ---------------------------------------------------------------------------

/**
 * Retrieve a secret from the encrypted store.
 * Returns `undefined` if the key doesn't exist or decryption fails.
 */
export function getKey(account: string): string | undefined {
  try {
    const store = readStore();
    if (!store) return undefined;

    // Backfill entropy.key for existing stores that were created before
    // entropy persistence was added. Only needed in managed mode.
    backfillEntropyIfMissing();

    const entry = store.entries[account];
    if (!entry) return undefined;

    const salt = Buffer.from(store.salt, "hex");
    const key = deriveKey(salt);
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
    const salt = Buffer.from(store.salt, "hex");
    const key = deriveKey(salt);
    store.entries[account] = encrypt(value, key);
    writeStore(store);
    return true;
  } catch (err) {
    log.warn({ err, account }, "Failed to write to encrypted store");
    return false;
  }
}

/** Result of a delete operation — distinguishes success, not-found, and error. */
export type DeleteKeyResult = "deleted" | "not-found" | "error";

/**
 * Delete a secret from the encrypted store.
 * Returns `"deleted"` on success, `"not-found"` if the key doesn't exist,
 * or `"error"` on failure.
 */
export function deleteKey(account: string): DeleteKeyResult {
  try {
    const store = readStore();
    if (!store || !Object.prototype.hasOwnProperty.call(store.entries, account))
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
